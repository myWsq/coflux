//! worker 子进程生命周期：起/管/重启 + 版本切换 + 观察期回滚。
//! 监控用单线程 100ms 轮询 try_wait（避免把 Child 的所有权丢进 wait 线程，方便 kill）。

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use coflux_protocol::{SUPERVISOR_SOCK_ENV, SUPERVISOR_VERSION_ENV, WORKER_VERSION_ENV};
use rand_core::{OsRng, RngCore};

const MAX_PENDING_CRASHES: u32 = 2;

#[derive(Clone, Debug)]
struct RemoteUpgradeRequest {
    generation: u64,
    release_version: crate::upgrade::ReleaseVersion,
    version: String,
    url: String,
    sha256: String,
    signature: String,
    target: String,
    artifact_size: u64,
    release_signature: String,
}

#[derive(Default)]
struct RemoteUpgradeState {
    /// 每个有效的远程请求、以及每次成功解析的本地切换意图都会递增。下载完成时只有
    /// generation 仍匹配的请求可以正式安装，慢请求不能覆盖更新意图。
    generation: u64,
    /// 同一时刻至多一个下载执行器；后续请求只覆盖 latest，不再各自 spawn/占 128 MiB。
    executor_running: bool,
    latest: Option<RemoteUpgradeRequest>,
}

#[derive(Clone, Debug)]
pub struct WorkerSpec {
    pub version: String,
    pub cmd: String,
    pub args: Vec<String>,
}

struct State {
    known: HashMap<String, WorkerSpec>, // 已知版本注册表（内置 + 注入 + 下载验签后落库）
    active: WorkerSpec,                 // 当前认定为好的版本
    pending: Option<WorkerSpec>,        // 观察期试用的新版本
    /// 已通过 release statement 验签、正在 probation 的远程版本。只在
    /// probation commit 后才进入 committed_release_floor 并持久化。
    pending_release: Option<crate::upgrade::ReleaseVersion>,
    /// 已提交签名发布的本地单调高水位；严格 SemVer precedence 小于等于
    /// 它的远程请求均按降级/重放拒绝，本地显式注册表切换不受限。
    committed_release_floor: Option<crate::upgrade::ReleaseVersion>,
    /// false 表示启动时 floor marker 损坏，或从更高 active/builtin 推导出的
    /// floor 未能落盘。此时远程安装 fail closed，防止重启窗口丢失高水位。
    release_floor_durable: bool,
    /// 仅启动恢复时存在：持久化 active 重新观察失败应退到 builtin，而不是重试坏文件。
    pending_fallback: Option<WorkerSpec>,
    child: Option<Child>,
    running_version: String,
    restarts: u32,
    pending_crashes: u32,
    /// 当前这次 pending 进程已完成 UDS 接管，并实际应用 resync.list 后回 ACK。
    pending_healthy: bool,
    /// pending spawn 之后新接入、且当前仍占有 UDS 的连接 generation。旧 worker 在退出前
    /// 已接入的 socket 即使还有缓冲记录，也不能给新候选冒充健康信号。
    pending_connection_generation: Option<u64>,
    /// 本连接已经成功排队给 worker 的 resync challenge；blind ACK/旧 ACK 均不能命中。
    pending_resync_nonce: Option<String>,
    /// 超过观察期仍未完成 resync 时已发出 kill，避免监控循环重复发送。
    pending_termination_requested: bool,
    started_at: Instant,
    next_spawn_at: Instant,
    shutting_down: bool,
}

pub struct Manager {
    sock_path: String,
    home: String,
    probation: Duration,
    /// supervisor 自身版本（编译期注入，main.rs::SUPERVISOR_VERSION）；随 spawn env 传给 worker，
    /// worker 握手时原样上报，供 web 展示（见 plans/015）。
    supervisor_version: String,
    /// 远程下载的单执行器 + latest-only mailbox。下载会缓冲最多 128 MiB，因此不能
    /// 让控制面的每条 worker.upgrade 都各自 spawn；A 运行时连续到来的 B/C 只保留 C。
    remote_upgrade: Mutex<RemoteUpgradeState>,
    state: Mutex<State>,
}

impl Manager {
    pub fn new(
        builtin: WorkerSpec,
        mut known: HashMap<String, WorkerSpec>,
        sock_path: String,
        home: String,
        probation: Duration,
        supervisor_version: String,
    ) -> Arc<Self> {
        known.insert(builtin.version.clone(), builtin.clone());
        let recovered = Self::recover_active(&home, &builtin, &known);
        // `cofluxd update` 会原地替换 supervisor + bundled worker，但保留旧
        // worker.active。正式 bundled 版本更高时必须优先启动它，否则 floor 已由
        // bundled 推进、实际却永久恢复旧 worker，而同版本远程请求又会按 replay 拒绝。
        let recovered = match crate::upgrade::ReleaseVersion::parse(&builtin.version) {
            Ok(builtin_release) => recovered.filter(|spec| {
                // 只有正式 release 版本才能参与 precedence。非 SemVer active 来自本机
                // 管理员显式注册/切换，不属于远程 anti-rollback 的裁决范围，重启后仍应恢复。
                let keep = crate::upgrade::ReleaseVersion::parse(&spec.version)
                    .map(|active_release| active_release.is_newer_than(&builtin_release))
                    .unwrap_or(true);
                if !keep {
                    eprintln!(
                        "[supervisor] bundled worker version={} 不低于已持久 active={}，优先使用 bundled",
                        builtin.version, spec.version
                    );
                }
                keep
            }),
            Err(_) => recovered,
        };
        if let Some(spec) = &recovered {
            eprintln!(
                "[supervisor] 恢复已提交 worker version={}，重新观察健康后启用",
                spec.version
            );
            known.insert(spec.version.clone(), spec.clone());
        }
        let active = recovered.clone().unwrap_or_else(|| builtin.clone());
        let pending_fallback = recovered.as_ref().map(|_| builtin.clone());
        let (mut committed_release_floor, mut release_floor_durable) =
            match crate::upgrade::load_release_floor(&home) {
                Ok(floor) => (floor, true),
                Err(error) => {
                    eprintln!(
                        "[supervisor] 读取 worker release floor 失败，远程升级将 fail closed；尝试从安全 active/builtin 重建: {error}"
                    );
                    (None, false)
                }
            };
        // 内置 worker 与已安全恢复的 active 都是本地事实；新 supervisor 首次
        // 启动时即使尚无 floor marker，也不能被远端降级到它们之前。
        for version in [&builtin.version, &active.version] {
            if let Ok(candidate) = crate::upgrade::ReleaseVersion::parse(version) {
                committed_release_floor = Some(match committed_release_floor.take() {
                    Some(current) => current.max(candidate),
                    None => candidate,
                });
            }
        }
        if let Some(floor) = &committed_release_floor {
            match crate::upgrade::persist_release_floor(&home, floor) {
                Ok(()) => release_floor_durable = true,
                Err(error) => {
                    release_floor_durable = false;
                    eprintln!(
                        "[supervisor] 持久启动 release floor={} 失败，远程升级禁用: {error}",
                        floor.as_str()
                    );
                }
            }
        }
        let now = Instant::now();
        Arc::new(Self {
            sock_path,
            home,
            probation,
            supervisor_version,
            remote_upgrade: Mutex::new(RemoteUpgradeState::default()),
            state: Mutex::new(State {
                known,
                running_version: active.version.clone(),
                active,
                // 持久化 active 也先作为 pending 重跑一次健康观察；损坏、架构不兼容或只存活
                // 不接管 UDS 的文件会自动回退 builtin，而不是让 daemon 永久离线。
                pending: recovered,
                pending_release: None,
                committed_release_floor,
                release_floor_durable,
                pending_fallback,
                child: None,
                restarts: 0,
                pending_crashes: 0,
                pending_healthy: false,
                pending_connection_generation: None,
                pending_resync_nonce: None,
                pending_termination_requested: false,
                started_at: now,
                next_spawn_at: now,
                shutting_down: false,
            }),
        })
    }

    fn recover_active(
        home: &str,
        builtin: &WorkerSpec,
        known: &HashMap<String, WorkerSpec>,
    ) -> Option<WorkerSpec> {
        let marker = std::path::Path::new(home).join("worker.active");
        let metadata = match std::fs::symlink_metadata(&marker) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                eprintln!("[supervisor] 读取 worker.active 元数据失败，回退 builtin: {error}");
                return None;
            }
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            eprintln!("[supervisor] worker.active 不是安全的普通文件，回退 builtin");
            return None;
        }
        if metadata.len() > 256 {
            eprintln!("[supervisor] worker.active 过长，回退 builtin");
            return None;
        }
        let version = match std::fs::read_to_string(&marker) {
            Ok(value) => value.trim().to_string(),
            Err(error) => {
                eprintln!("[supervisor] 读取 worker.active 失败，回退 builtin: {error}");
                return None;
            }
        };
        if version == builtin.version {
            return None;
        }
        if let Some(spec) = known.get(&version) {
            return Some(spec.clone());
        }
        match crate::upgrade::installed_worker_spec(home, &version) {
            Ok(spec) => Some(spec),
            Err(error) => {
                eprintln!("[supervisor] worker.active={version} 不可恢复，回退 builtin: {error}");
                None
            }
        }
    }

    fn write_active_version(&self, version: &str) -> bool {
        match crate::upgrade::persist_active_version(&self.home, version) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("[supervisor] 持久化 worker.active={version} 失败: {error}");
                false
            }
        }
    }

    fn write_release_floor(&self, version: &crate::upgrade::ReleaseVersion) -> bool {
        match crate::upgrade::persist_release_floor(&self.home, version) {
            Ok(()) => true,
            Err(error) => {
                eprintln!(
                    "[supervisor] 持久 worker.release-floor={} 失败: {error}",
                    version.as_str()
                );
                false
            }
        }
    }

    fn ensure_release_is_newer(
        st: &State,
        candidate: &crate::upgrade::ReleaseVersion,
    ) -> Result<(), String> {
        if !st.release_floor_durable {
            return Err("worker release floor 未持久化，远程升级 fail closed".to_string());
        }
        if let Some(floor) = &st.committed_release_floor {
            if !candidate.is_newer_than(floor) {
                return Err(format!(
                    "拒绝降级/重放 release {}：已提交 floor={}",
                    candidate.as_str(),
                    floor.as_str()
                ));
            }
        }
        if let Some(pending) = &st.pending_release {
            if !candidate.is_newer_than(pending) {
                return Err(format!(
                    "拒绝降级/重放 release {}：正在观察 pending={}",
                    candidate.as_str(),
                    pending.as_str()
                ));
            }
        }
        Ok(())
    }

    fn current_spec(st: &State) -> WorkerSpec {
        st.pending.clone().unwrap_or_else(|| st.active.clone())
    }

    fn try_commit_pending(&self, st: &mut State) {
        if !st.pending_healthy {
            return;
        }
        let Some(pending) = st.pending.clone() else {
            return;
        };
        let pending_release = st.pending_release.clone();
        // 先持久 active，再持久 floor；若两者之间崩溃，下次启动会从
        // 已安全恢复的 active SemVer 重建 floor。floor 失败时留在 pending
        // 每 100ms 重试，不在持久 anti-rollback 前宣告 commit。
        let active_persisted = self.write_active_version(&pending.version);
        let floor_persisted = active_persisted
            && pending_release
                .as_ref()
                .is_none_or(|release| self.write_release_floor(release));
        if active_persisted && !floor_persisted {
            // rename 后目录 fsync 失败等情况无法证明新 floor 已持久；在本次
            // 进程内先禁用新的远程升级，直到本候选重试写成功并正式提交。
            st.release_floor_durable = false;
        }
        if !active_persisted || !floor_persisted {
            return;
        }

        st.pending = None;
        st.pending_release = None;
        st.pending_fallback = None;
        if let Some(release) = pending_release {
            st.committed_release_floor = Some(
                st.committed_release_floor
                    .take()
                    .map_or(release.clone(), |floor| floor.max(release)),
            );
            st.release_floor_durable = true;
        }
        eprintln!(
            "[supervisor] worker upgrade committed version={}",
            pending.version
        );
        st.active = pending;
        st.pending_crashes = 0;
        st.pending_healthy = false;
        st.pending_connection_generation = None;
        st.pending_resync_nonce = None;
        st.pending_termination_requested = false;
        st.restarts = 0;
    }

    fn rollback_pending(&self, st: &mut State, from: &str) {
        let fallback = st
            .pending_fallback
            .take()
            .unwrap_or_else(|| st.active.clone());
        eprintln!(
            "[supervisor] worker upgrade rollback from={from} to={}",
            fallback.version
        );
        st.pending = None;
        st.pending_release = None;
        st.active = fallback;
        st.pending_crashes = 0;
        st.pending_healthy = false;
        st.pending_connection_generation = None;
        st.pending_resync_nonce = None;
        st.pending_termination_requested = false;
        self.write_active_version(&st.active.version);
    }

    fn spawn(&self, st: &mut State) {
        let spec = Self::current_spec(st);
        let is_pending = matches!(&st.pending, Some(p) if p.version == spec.version);
        if is_pending {
            // 每个新进程必须亲自完成 resync；上一轮进程的健康信号不能沿用。
            st.pending_healthy = false;
            st.pending_connection_generation = None;
            st.pending_resync_nonce = None;
            st.pending_termination_requested = false;
        }
        let mut cmd = Command::new(&spec.cmd);
        cmd.args(&spec.args)
            .env(SUPERVISOR_SOCK_ENV, &self.sock_path)
            // worker 完全不知自身版本——这是 supervisor 侧概念，每次 spawn 都经 env 告知当前跑的
            // 版本 + supervisor 自身版本；worker 握手消息据此上报（见 plans/015）。
            .env(WORKER_VERSION_ENV, &spec.version)
            .env(SUPERVISOR_VERSION_ENV, &self.supervisor_version)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        match cmd.spawn() {
            Ok(child) => {
                st.running_version = spec.version.clone();
                st.started_at = Instant::now();
                st.child = Some(child);
                eprintln!("[supervisor] worker spawned version={}", spec.version);
            }
            Err(e) => {
                eprintln!("[supervisor] worker spawn error: {e}");
                // pending 版本连启动都失败（如坏架构/损坏产物）也计入崩溃预算，达阈值回滚到 active。
                // 否则 current_spec 恒为 pending，会每 500ms 无限重试同一坏版本、永不回滚 → daemon 砖化。
                if is_pending {
                    st.pending_crashes += 1;
                    if st.pending_crashes >= MAX_PENDING_CRASHES {
                        eprintln!(
                            "[supervisor] pending worker 无法启动 version={}",
                            spec.version
                        );
                        self.rollback_pending(st, &spec.version);
                    }
                }
                st.next_spawn_at = Instant::now() + Duration::from_millis(500);
            }
        }
    }

    /// 监控循环（独立线程）。
    pub fn start(self: &Arc<Self>) {
        let this = Arc::clone(self);
        thread::spawn(move || {
            {
                let mut st = this.state.lock().unwrap();
                // 恢复出的版本此时放在 pending；marker 仍应指向它，只有健康观察失败时
                // 才原子改回 builtin。新安装的普通 pending 不会在 start() 前出现。
                let v = Self::current_spec(&st).version;
                this.write_active_version(&v);
                this.spawn(&mut st);
            }
            loop {
                thread::sleep(Duration::from_millis(100));
                let mut st = this.state.lock().unwrap();
                if st.shutting_down {
                    break;
                }

                // 先观察退出，再判断提交。否则进程刚退出、try_wait 尚未执行时可能先被误提交。
                let exited = matches!(st.child.as_mut().map(|c| c.try_wait()), Some(Ok(Some(_))));
                if exited {
                    st.child = None;
                    let exited_version = st.running_version.clone();
                    let is_pending = matches!(&st.pending, Some(p) if p.version == exited_version);
                    if is_pending {
                        st.pending_crashes += 1;
                        let crashes = st.pending_crashes;
                        let pv = st
                            .pending
                            .as_ref()
                            .map(|p| p.version.clone())
                            .unwrap_or_default();
                        eprintln!(
                            "[supervisor] pending worker exited version={pv} crashes={crashes}"
                        );
                        if crashes >= MAX_PENDING_CRASHES {
                            eprintln!("[supervisor] pending worker crash-looping version={pv}");
                            this.rollback_pending(&mut st, &pv);
                        }
                        st.next_spawn_at = Instant::now() + Duration::from_millis(300);
                    } else {
                        if st.started_at.elapsed() > Duration::from_secs(10) {
                            st.restarts = 0;
                        }
                        st.restarts += 1;
                        let delay = std::cmp::min(5000, 200 * st.restarts as u64);
                        eprintln!(
                            "[supervisor] worker exited version={exited_version}, restarting in {delay}ms"
                        );
                        st.next_spawn_at = Instant::now() + Duration::from_millis(delay);
                    }
                }

                // 观察期不再只看“进程活着”：候选必须在期限内接管 UDS，并完成一次
                // resync.request → resync.list → resync.applied。只存活或只请求不应用
                // 快照的候选都会被终止、计入
                // pending 崩溃预算，达到阈值后回滚。
                let pending_alive = st.child.is_some()
                    && matches!(&st.pending, Some(p) if st.running_version == p.version);
                if pending_alive && st.started_at.elapsed() >= this.probation {
                    if st.pending_healthy {
                        this.try_commit_pending(&mut st);
                    } else if !st.pending_termination_requested {
                        let version = st
                            .pending
                            .as_ref()
                            .map(|worker| worker.version.as_str())
                            .unwrap_or("");
                        eprintln!(
                            "[supervisor] pending worker 未在观察期内完成 UDS/resync，终止 version={version}"
                        );
                        if let Some(child) = st.child.as_mut() {
                            let _ = child.kill();
                        }
                        st.pending_termination_requested = true;
                    }
                }

                // 需要时重起
                if st.child.is_none() && !st.shutting_down && Instant::now() >= st.next_spawn_at {
                    this.spawn(&mut st);
                }
            }
        });
    }

    /// 热升级：切到某个已知版本（本地注册表；重启 worker；观察期不过则自动回滚）。
    pub fn switch_worker(&self, version: String) {
        // 先解析已知版本再改远程 generation：未知本地版本不是有效切换意图，不能误取消
        // 正在进行的合法远程升级。known 只增不删，clone 后释放 state 锁是安全的。
        let spec = match self.state.lock().unwrap().known.get(&version) {
            Some(spec) => spec.clone(),
            None => {
                eprintln!("[supervisor] unknown worker version {version}; ignoring");
                return;
            }
        };

        // 与远程完成路径保持 remote_upgrade → state 的统一锁序。有效本地切换会让运行中的
        // 下载失效，并清掉尚未开始的远程 latest mailbox。
        let mut remote = self.remote_upgrade.lock().unwrap();
        remote.generation = remote.generation.wrapping_add(1);
        remote.latest = None;
        let mut st = self.state.lock().unwrap();
        self.begin_switch(&mut st, spec, None);
    }

    /// 在线性化门内登记远程意图。若执行器空闲，返回应立即执行的请求；否则只覆盖
    /// latest mailbox。这样 A 运行时到来的 B/C 不会并行下载，且 B 不会抢在 C 前安装。
    fn enqueue_remote_upgrade(
        &self,
        release_version: crate::upgrade::ReleaseVersion,
        version: String,
        url: String,
        sha256: String,
        signature: String,
        target: String,
        artifact_size: u64,
        release_signature: String,
    ) -> Option<RemoteUpgradeRequest> {
        let mut remote = self.remote_upgrade.lock().unwrap();
        {
            let st = self.state.lock().unwrap();
            if let Err(error) = Self::ensure_release_is_newer(&st, &release_version) {
                eprintln!("[supervisor] {error}");
                return None;
            }
        }
        remote.generation = remote.generation.wrapping_add(1);
        let request = RemoteUpgradeRequest {
            generation: remote.generation,
            release_version,
            version,
            url,
            sha256,
            signature,
            target,
            artifact_size,
            release_signature,
        };
        if remote.executor_running {
            if let Some(replaced) = remote.latest.replace(request) {
                eprintln!(
                    "[supervisor] 较新升级请求覆盖等待项 old={} new={}",
                    replaced.version,
                    remote.latest.as_ref().unwrap().version
                );
            }
            None
        } else {
            remote.executor_running = true;
            Some(request)
        }
    }

    /// 完成一次下载，并在同一线性化门内决定是否安装以及下一次只执行哪个 latest 请求。
    /// 持锁跨 install/fsync 是有意的：否则新请求可能已登记为最新，旧请求仍在其后晋升。
    fn finish_remote_upgrade(
        &self,
        request: RemoteUpgradeRequest,
        result: Result<crate::upgrade::StagedWorker, String>,
    ) -> Option<RemoteUpgradeRequest> {
        let mut remote = self.remote_upgrade.lock().unwrap();
        let is_latest = remote.generation == request.generation;
        match result {
            Ok(staged) if is_latest => {
                {
                    let st = self.state.lock().unwrap();
                    if let Err(error) = Self::ensure_release_is_newer(&st, &request.release_version)
                    {
                        eprintln!("[supervisor] 验签后升级已过期（保持当前版本）: {error}");
                        return Self::take_next_remote_upgrade(&mut remote);
                    }
                }
                let spec = match staged.install() {
                    Ok(spec) => spec,
                    Err(error) => {
                        eprintln!("[supervisor] 升级落盘被拒（保持当前版本）: {error}");
                        return Self::take_next_remote_upgrade(&mut remote);
                    }
                };
                let mut st = self.state.lock().unwrap();
                if st.shutting_down {
                    eprintln!(
                        "[supervisor] supervisor 正在关闭，已安装但不切换 version={}",
                        spec.version
                    );
                } else if let Err(error) =
                    Self::ensure_release_is_newer(&st, &request.release_version)
                {
                    eprintln!("[supervisor] 升级落盘后已过期（不切换）: {error}");
                } else {
                    eprintln!(
                        "[supervisor] release statement 与产物验签并原子落盘通过，切换到 {}",
                        request.release_version.as_str()
                    );
                    st.known.insert(spec.version.clone(), spec.clone());
                    self.begin_switch(&mut st, spec, Some(request.release_version.clone()));
                }
            }
            Ok(_staged) => {
                eprintln!(
                    "[supervisor] 丢弃过期升级下载 version={} generation={}",
                    request.version, request.generation
                );
            }
            Err(error) if is_latest => {
                eprintln!("[supervisor] 升级被拒（保持当前版本）: {error}");
            }
            Err(error) => {
                eprintln!(
                    "[supervisor] 过期升级下载失败 version={} generation={}: {error}",
                    request.version, request.generation
                );
            }
        }
        Self::take_next_remote_upgrade(&mut remote)
    }

    fn take_next_remote_upgrade(remote: &mut RemoteUpgradeState) -> Option<RemoteUpgradeRequest> {
        match remote.latest.take() {
            Some(next) => Some(next),
            None => {
                remote.executor_running = false;
                None
            }
        }
    }

    fn run_remote_upgrade_executor(self: Arc<Self>, mut request: RemoteUpgradeRequest) {
        loop {
            let result = crate::upgrade::download_verify_stage(
                &request.url,
                &request.sha256,
                &request.signature,
                &self.home,
                &request.version,
                &request.target,
                request.artifact_size,
                &request.release_signature,
            );
            match self.finish_remote_upgrade(request, result) {
                Some(next) => request = next,
                None => break,
            }
        }
    }

    /// 远程升级：固定形状先同步校验；下载执行器全局唯一，忙碌时只保留最后一个请求。
    pub fn install_from_url(
        self: &Arc<Self>,
        version: String,
        url: String,
        sha256: String,
        signature: String,
        target: String,
        artifact_size: u64,
        release_signature: String,
    ) {
        let release_version = match crate::upgrade::validate_upgrade_request(
            &version,
            &url,
            &sha256,
            &signature,
            &target,
            artifact_size,
            &release_signature,
        ) {
            Ok(release_version) => release_version,
            Err(error) => {
                eprintln!("[supervisor] 升级请求字段非法（未发起下载）: {error}");
                return;
            }
        };
        let Some(request) = self.enqueue_remote_upgrade(
            release_version,
            version,
            url,
            sha256,
            signature,
            target,
            artifact_size,
            release_signature,
        ) else {
            return;
        };
        let this = Arc::clone(self);
        thread::spawn(move || this.run_remote_upgrade_executor(request));
    }

    /// main 在 accept、启动该连接的 reader 前调用；只有 pending spawn 后接入的新连接
    /// 才有资格提供健康信号，排除旧 worker socket 的尾部缓冲记录。
    pub fn worker_connected(&self, connection_generation: u64) {
        let mut st = self.state.lock().unwrap();
        let pending_running = st.child.is_some()
            && matches!(&st.pending, Some(worker) if worker.version == st.running_version);
        if pending_running {
            st.pending_connection_generation = Some(connection_generation);
            st.pending_healthy = false;
            st.pending_resync_nonce = None;
        }
    }

    /// 在发送 resync.list 前登记不可预测 challenge；只有当前 pending 连接需要记账，
    /// active worker 的 nonce 仍照常返回给协议，但不参与 probation。
    pub fn issue_resync_challenge(&self, connection_generation: u64) -> String {
        let mut bytes = [0u8; 16];
        OsRng.fill_bytes(&mut bytes);
        let nonce = hex::encode(bytes);
        let mut st = self.state.lock().unwrap();
        let pending_running = st.child.is_some()
            && matches!(&st.pending, Some(worker) if worker.version == st.running_version)
            && st.pending_connection_generation == Some(connection_generation)
            && !st.pending_termination_requested;
        if pending_running {
            st.pending_resync_nonce = Some(nonce.clone());
            st.pending_healthy = false;
        }
        nonce
    }

    pub fn cancel_resync_challenge(&self, connection_generation: u64, nonce: &str) {
        let mut st = self.state.lock().unwrap();
        if st.pending_connection_generation == Some(connection_generation)
            && st.pending_resync_nonce.as_deref() == Some(nonce)
        {
            st.pending_resync_nonce = None;
        }
    }

    /// 当前候选连接已应用指定快照、连上中心并成功把 daemon resync 排入中心发送队列。
    pub fn worker_resynced(&self, connection_generation: u64, nonce: &str) {
        let mut st = self.state.lock().unwrap();
        let pending_running = st.child.is_some()
            && matches!(&st.pending, Some(worker) if worker.version == st.running_version)
            && st.pending_connection_generation == Some(connection_generation)
            && st.pending_resync_nonce.as_deref() == Some(nonce)
            && !st.pending_termination_requested;
        if pending_running && !st.pending_healthy {
            st.pending_healthy = true;
            st.pending_resync_nonce = None;
            eprintln!(
                "[supervisor] pending worker UDS/resync healthy version={} connection_generation={connection_generation}",
                st.running_version
            );
        }
    }

    /// 候选观察期内连接断开即撤销健康；worker 重连后必须用新 generation 再完成 resync。
    pub fn worker_disconnected(&self, connection_generation: u64) {
        let mut st = self.state.lock().unwrap();
        if st.pending_connection_generation == Some(connection_generation) {
            st.pending_connection_generation = None;
            st.pending_resync_nonce = None;
            st.pending_healthy = false;
        }
    }

    fn begin_switch(
        &self,
        st: &mut State,
        spec: WorkerSpec,
        release: Option<crate::upgrade::ReleaseVersion>,
    ) {
        if st.shutting_down {
            eprintln!(
                "[supervisor] supervisor 正在关闭，忽略切换到 {}",
                spec.version
            );
            return;
        }
        if spec.version == st.active.version && st.pending.is_none() {
            eprintln!("[supervisor] already on version {}", spec.version);
            return;
        }
        if st
            .pending
            .as_ref()
            .is_some_and(|pending| pending.version == spec.version)
        {
            eprintln!("[supervisor] already testing version {}", spec.version);
            return;
        }
        // 恢复出的 worker 在 probation 真正提交前，绝不能因为它转发了一条异步升级请求
        // 就晋升成新候选的 fallback。保留 pending_fallback=builtin；新候选失败仍回 builtin。
        eprintln!(
            "[supervisor] upgrading worker from={} to={}",
            st.active.version, spec.version
        );
        st.pending = Some(spec);
        st.pending_release = release;
        st.pending_crashes = 0;
        st.pending_healthy = false;
        st.pending_connection_generation = None;
        st.pending_resync_nonce = None;
        st.pending_termination_requested = false;
        if let Some(child) = st.child.as_mut() {
            let _ = child.kill(); // 监控循环看到退出后用 current_spec()（=pending）重起
        }
    }

    pub fn shutdown(&self) {
        let mut st = self.state.lock().unwrap();
        st.shutting_down = true;
        if let Some(child) = st.child.as_mut() {
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;

    fn test_home(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "coflux-manager-{name}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    fn builtin() -> WorkerSpec {
        WorkerSpec {
            version: "builtin".into(),
            cmd: "/bin/true".into(),
            args: vec![],
        }
    }

    fn enqueue_test_release(
        manager: &Manager,
        version: &str,
        url: &str,
    ) -> Option<RemoteUpgradeRequest> {
        manager.enqueue_remote_upgrade(
            crate::upgrade::ReleaseVersion::parse(version).unwrap(),
            version.into(),
            url.into(),
            "00".repeat(32),
            "11".repeat(64),
            crate::upgrade::current_release_target().into(),
            1,
            "22".repeat(64),
        )
    }

    #[test]
    fn restart_recovers_downloaded_active_as_observed_candidate() {
        let home = test_home("restore");
        let version_dir = home.join("workers/v3");
        std::fs::create_dir_all(&version_dir).unwrap();
        let worker = version_dir.join("coflux-worker");
        std::fs::write(&worker, b"worker").unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(home.join("worker.active"), b"v3").unwrap();

        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        let state = manager.state.lock().unwrap();
        assert_eq!(
            state.active.version, "v3",
            "持久化 active 仍是新候选失败时的首选回退"
        );
        assert_eq!(
            state
                .pending_fallback
                .as_ref()
                .map(|worker| worker.version.as_str()),
            Some("builtin"),
            "重启复检自身失败时才回退 builtin"
        );
        assert_eq!(
            state.pending.as_ref().map(|worker| worker.version.as_str()),
            Some("v3")
        );
        assert_eq!(
            state.pending.as_ref().map(|worker| worker.cmd.as_str()),
            Some(worker.to_str().unwrap())
        );
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn restart_rejects_unusable_persisted_worker_and_falls_back_builtin() {
        let home = test_home("fallback");
        let version_dir = home.join("workers/v-bad");
        std::fs::create_dir_all(&version_dir).unwrap();
        let worker = version_dir.join("coflux-worker");
        std::fs::write(&worker, b"worker").unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::write(home.join("worker.active"), b"v-bad").unwrap();

        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        let state = manager.state.lock().unwrap();
        assert_eq!(state.active.version, "builtin");
        assert!(state.pending.is_none());
        assert!(state.pending_fallback.is_none());
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn pending_health_only_accepts_current_post_spawn_connection_generation() {
        let home = test_home("health-generation");
        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        {
            let mut state = manager.state.lock().unwrap();
            state.pending = Some(WorkerSpec {
                version: "candidate".into(),
                cmd: "/bin/true".into(),
                args: vec![],
            });
            state.running_version = "candidate".into();
            state.child = Some(
                Command::new("/bin/sh")
                    .args(["-c", "sleep 5"])
                    .spawn()
                    .unwrap(),
            );
        }

        manager.worker_connected(12);
        let nonce = manager.issue_resync_challenge(12);
        manager.worker_resynced(11, &nonce);
        assert!(
            !manager.state.lock().unwrap().pending_healthy,
            "旧连接不能冒充新候选健康"
        );
        manager.worker_resynced(12, "blind-or-stale");
        assert!(
            !manager.state.lock().unwrap().pending_healthy,
            "当前连接的 blind/stale ACK 也不能命中 challenge"
        );
        manager.worker_resynced(12, &nonce);
        assert!(
            manager.state.lock().unwrap().pending_healthy,
            "当前连接完成 resync 后健康"
        );
        manager.worker_disconnected(12);
        assert!(
            !manager.state.lock().unwrap().pending_healthy,
            "观察期断连撤销健康"
        );

        let mut state = manager.state.lock().unwrap();
        let mut child = state.child.take().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn uncommitted_recovered_worker_never_becomes_new_candidate_fallback() {
        let home = test_home("recovered-fallback");
        let version_dir = home.join("workers/recovered");
        std::fs::create_dir_all(&version_dir).unwrap();
        let worker = version_dir.join("coflux-worker");
        std::fs::write(&worker, b"worker").unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(home.join("worker.active"), b"recovered").unwrap();

        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        let mut state = manager.state.lock().unwrap();
        manager.begin_switch(
            &mut state,
            WorkerSpec {
                version: "candidate".into(),
                cmd: "/bin/false".into(),
                args: vec![],
            },
            None,
        );
        assert_eq!(
            state.pending.as_ref().map(|worker| worker.version.as_str()),
            Some("candidate")
        );
        assert_eq!(
            state
                .pending_fallback
                .as_ref()
                .map(|worker| worker.version.as_str()),
            Some("builtin"),
            "恢复候选未通过 probation 前，新候选失败必须越过它回 builtin"
        );

        manager.rollback_pending(&mut state, "candidate");
        assert_eq!(state.active.version, "builtin");
        assert_eq!(
            std::fs::read_to_string(home.join("worker.active")).unwrap(),
            "builtin"
        );
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn remote_upgrade_uses_one_executor_and_only_runs_latest_mailbox_item() {
        let home = test_home("latest-only");
        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );

        let first = enqueue_test_release(&manager, "v1.0.0", "https://example.invalid/a")
            .expect("空闲时只有 A 获得执行器");
        assert!(
            enqueue_test_release(&manager, "v1.1.0", "https://example.invalid/b").is_none(),
            "A 运行时 B 只能进入 mailbox，不能并发启动"
        );
        assert!(
            enqueue_test_release(&manager, "v1.2.0", "https://example.invalid/c").is_none(),
            "C 应覆盖 B，不能创建第二个执行器"
        );
        {
            let remote = manager.remote_upgrade.lock().unwrap();
            assert!(remote.executor_running);
            assert_eq!(
                remote
                    .latest
                    .as_ref()
                    .map(|request| request.version.as_str()),
                Some("v1.2.0")
            );
        }

        let body_a = b"signed worker a";
        let digest_a: [u8; 32] = Sha256::digest(body_a).into();
        let staged_a =
            crate::upgrade::stage_verified_bytes(&home, "v1.0.0", body_a, digest_a).unwrap();
        let latest = manager
            .finish_remote_upgrade(first, Ok(staged_a))
            .expect("A 完成后应直接取得被 C 覆盖后的 latest");
        assert_eq!(latest.version, "v1.2.0");
        assert!(
            !home.join("workers/v1.0.0/coflux-worker").exists(),
            "过期 A 只能清理临时文件，不能晋升"
        );
        assert!(
            !home.join("workers/v1.1.0/coflux-worker").exists(),
            "被覆盖的 B 根本不应执行"
        );

        let body_c = b"signed worker c";
        let digest_c: [u8; 32] = Sha256::digest(body_c).into();
        let staged_c =
            crate::upgrade::stage_verified_bytes(&home, "v1.2.0", body_c, digest_c).unwrap();
        assert!(manager
            .finish_remote_upgrade(latest, Ok(staged_c))
            .is_none());
        {
            let remote = manager.remote_upgrade.lock().unwrap();
            assert!(!remote.executor_running);
            assert!(remote.latest.is_none());
        }
        let state = manager.state.lock().unwrap();
        assert_eq!(
            state.pending.as_ref().map(|worker| worker.version.as_str()),
            Some("v1.2.0"),
            "最终切换意图必须是 C"
        );
        assert!(state.known.contains_key("v1.2.0"));
        drop(state);
        assert_eq!(
            std::fs::read(home.join("workers/v1.2.0/coflux-worker")).unwrap(),
            body_c
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn unknown_local_version_does_not_cancel_remote_upgrade_intent() {
        let home = test_home("unknown-local-keeps-remote");
        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        let request =
            enqueue_test_release(&manager, "v2.0.0", "https://example.invalid/remote").unwrap();
        let generation = request.generation;

        manager.switch_worker("missing".into());
        {
            let remote = manager.remote_upgrade.lock().unwrap();
            assert_eq!(remote.generation, generation);
            assert!(remote.executor_running);
        }

        let body = b"signed remote worker";
        let digest: [u8; 32] = Sha256::digest(body).into();
        let staged = crate::upgrade::stage_verified_bytes(&home, "v2.0.0", body, digest).unwrap();
        assert!(manager.finish_remote_upgrade(request, Ok(staged)).is_none());
        assert_eq!(
            manager
                .state
                .lock()
                .unwrap()
                .pending
                .as_ref()
                .map(|worker| worker.version.as_str()),
            Some("v2.0.0")
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn builtin_semver_seeds_durable_floor_and_rejects_downgrade_or_replay() {
        let home = test_home("builtin-release-floor");
        let manager = Manager::new(
            WorkerSpec {
                version: "v3.0.0".into(),
                cmd: "/bin/true".into(),
                args: vec![],
            },
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "v3.0.0".into(),
        );
        assert_eq!(
            std::fs::read_to_string(home.join("worker.release-floor")).unwrap(),
            "v3.0.0"
        );
        assert!(
            enqueue_test_release(&manager, "v2.9.9", "https://example.invalid/downgrade").is_none()
        );
        assert!(
            enqueue_test_release(&manager, "v3.0.0", "https://example.invalid/replay").is_none()
        );
        assert!(
            enqueue_test_release(&manager, "v3.0.1", "https://example.invalid/upgrade").is_some()
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn newer_bundled_release_supersedes_older_persisted_active() {
        let home = test_home("bundled-supersedes-active");
        let version_dir = home.join("workers/v2.0.0");
        std::fs::create_dir_all(&version_dir).unwrap();
        let worker = version_dir.join("coflux-worker");
        std::fs::write(&worker, b"old worker").unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(home.join("worker.active"), b"v2.0.0").unwrap();

        let manager = Manager::new(
            WorkerSpec {
                version: "v3.0.0".into(),
                cmd: "/bin/true".into(),
                args: vec![],
            },
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "v3.0.0".into(),
        );
        let state = manager.state.lock().unwrap();
        assert_eq!(state.active.version, "v3.0.0");
        assert!(state.pending.is_none());
        assert_eq!(
            state
                .committed_release_floor
                .as_ref()
                .map(crate::upgrade::ReleaseVersion::as_str),
            Some("v3.0.0")
        );
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn semver_bundled_release_keeps_explicit_non_semver_active() {
        let home = test_home("bundled-keeps-local-active");
        std::fs::write(home.join("worker.active"), b"local-canary").unwrap();
        let local = WorkerSpec {
            version: "local-canary".into(),
            cmd: "/bin/true".into(),
            args: vec![],
        };
        let manager = Manager::new(
            WorkerSpec {
                version: "v3.0.0".into(),
                cmd: "/bin/true".into(),
                args: vec![],
            },
            HashMap::from([(local.version.clone(), local)]),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "v3.0.0".into(),
        );
        let state = manager.state.lock().unwrap();
        assert_eq!(state.active.version, "local-canary");
        assert_eq!(
            state.pending.as_ref().map(|worker| worker.version.as_str()),
            Some("local-canary")
        );
        assert_eq!(
            state
                .committed_release_floor
                .as_ref()
                .map(crate::upgrade::ReleaseVersion::as_str),
            Some("v3.0.0"),
            "本地版本可恢复，但远程 release floor 仍以 bundled 为下界"
        );
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn corrupt_floor_without_safe_semver_disables_remote_upgrade() {
        let home = test_home("corrupt-release-floor");
        std::fs::write(home.join("worker.release-floor"), b"corrupt").unwrap();
        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        assert!(!manager.state.lock().unwrap().release_floor_durable);
        assert!(
            enqueue_test_release(&manager, "v1.0.0", "https://example.invalid/upgrade").is_none()
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn verified_but_uncommitted_candidate_does_not_advance_durable_floor() {
        let home = test_home("pending-does-not-advance-floor");
        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        let request =
            enqueue_test_release(&manager, "v1.0.0", "https://example.invalid/candidate").unwrap();
        let body = b"verified candidate";
        let digest: [u8; 32] = Sha256::digest(body).into();
        let staged = crate::upgrade::stage_verified_bytes(&home, "v1.0.0", body, digest).unwrap();
        assert!(manager.finish_remote_upgrade(request, Ok(staged)).is_none());
        assert!(!home.join("worker.release-floor").exists());

        let mut state = manager.state.lock().unwrap();
        manager.rollback_pending(&mut state, "v1.0.0");
        drop(state);
        assert!(enqueue_test_release(
            &manager,
            "v1.0.0",
            "https://example.invalid/retry-after-rollback"
        )
        .is_some());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn runtime_floor_persist_failure_keeps_pending_and_disables_remote_upgrade() {
        let home = test_home("runtime-floor-persist-failure");
        let manager = Manager::new(
            builtin(),
            HashMap::new(),
            home.join("supervisor.sock").to_string_lossy().into_owned(),
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
        );
        let request =
            enqueue_test_release(&manager, "v1.0.0", "https://example.invalid/candidate").unwrap();
        let body = b"verified candidate";
        let digest: [u8; 32] = Sha256::digest(body).into();
        let staged = crate::upgrade::stage_verified_bytes(&home, "v1.0.0", body, digest).unwrap();
        assert!(manager.finish_remote_upgrade(request, Ok(staged)).is_none());

        // 同名目录令临时文件 rename 到 marker 必然失败，不依赖 chmod/root 语义；active
        // marker 仍可先成功持久，以覆盖两次原子写之间最危险的故障窗口。
        let floor_path = home.join("worker.release-floor");
        std::fs::create_dir(&floor_path).unwrap();
        {
            let mut state = manager.state.lock().unwrap();
            state.pending_healthy = true;
            assert!(state.release_floor_durable);
            manager.try_commit_pending(&mut state);

            assert!(
                !state.release_floor_durable,
                "运行态 floor I/O 失败后必须 fail closed"
            );
            assert_eq!(
                state.active.version, "builtin",
                "候选不得被当成已提交 active"
            );
            assert_eq!(
                state.pending.as_ref().map(|worker| worker.version.as_str()),
                Some("v1.0.0"),
                "候选须留在 pending 等待持久化重试"
            );
            assert_eq!(
                state
                    .pending_release
                    .as_ref()
                    .map(crate::upgrade::ReleaseVersion::as_str),
                Some("v1.0.0")
            );
            assert!(
                state.committed_release_floor.is_none(),
                "内存高水位也不得提前推进"
            );
        }
        assert_eq!(
            std::fs::read_to_string(home.join("worker.active")).unwrap(),
            "v1.0.0",
            "故障精确发生在 active 已持久、floor 尚未持久的窗口"
        );
        assert!(
            enqueue_test_release(&manager, "v2.0.0", "https://example.invalid/newer").is_none(),
            "floor 未持久期间即使更高版本也必须拒绝"
        );

        // 故障解除后同一 pending 可重试并正式提交，证明失败分支没有破坏状态机。
        std::fs::remove_dir(&floor_path).unwrap();
        {
            let mut state = manager.state.lock().unwrap();
            manager.try_commit_pending(&mut state);
            assert!(state.release_floor_durable);
            assert!(state.pending.is_none());
            assert_eq!(state.active.version, "v1.0.0");
            assert_eq!(
                state
                    .committed_release_floor
                    .as_ref()
                    .map(crate::upgrade::ReleaseVersion::as_str),
                Some("v1.0.0")
            );
        }
        assert_eq!(std::fs::read_to_string(&floor_path).unwrap(), "v1.0.0");
        std::fs::remove_dir_all(home).unwrap();
    }
}
