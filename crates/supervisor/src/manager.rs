//! worker 子进程生命周期：起/管/重启 + 版本切换 + 观察期回滚。
//! 监控用单线程 100ms 轮询 try_wait（避免把 Child 的所有权丢进 wait 线程，方便 kill）。

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use coflux_protocol::{SUPERVISOR_SOCK_ENV, SUPERVISOR_VERSION_ENV, WORKER_VERSION_ENV};

const MAX_PENDING_CRASHES: u32 = 2;

#[derive(Clone)]
pub struct WorkerSpec {
    pub version: String,
    pub cmd: String,
    pub args: Vec<String>,
}

struct State {
    known: HashMap<String, WorkerSpec>, // 已知版本注册表（内置 + 注入 + 下载验签后落库）
    active: WorkerSpec,                 // 当前认定为好的版本
    pending: Option<WorkerSpec>,        // 观察期试用的新版本
    child: Option<Child>,
    running_version: String,
    restarts: u32,
    pending_crashes: u32,
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
    state: Mutex<State>,
}

impl Manager {
    pub fn new(builtin: WorkerSpec, mut known: HashMap<String, WorkerSpec>, sock_path: String, home: String, probation: Duration, supervisor_version: String) -> Arc<Self> {
        known.insert(builtin.version.clone(), builtin.clone());
        let now = Instant::now();
        Arc::new(Self {
            sock_path,
            home,
            probation,
            supervisor_version,
            state: Mutex::new(State {
                known,
                running_version: builtin.version.clone(),
                active: builtin,
                pending: None,
                child: None,
                restarts: 0,
                pending_crashes: 0,
                started_at: now,
                next_spawn_at: now,
                shutting_down: false,
            }),
        })
    }

    fn write_active_version(&self, version: &str) {
        let _ = std::fs::write(format!("{}/worker.active", self.home), version);
    }

    fn current_spec(st: &State) -> WorkerSpec {
        st.pending.clone().unwrap_or_else(|| st.active.clone())
    }

    fn spawn(&self, st: &mut State) {
        let spec = Self::current_spec(st);
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
                let is_pending = matches!(&st.pending, Some(p) if p.version == spec.version);
                if is_pending {
                    st.pending_crashes += 1;
                    if st.pending_crashes >= MAX_PENDING_CRASHES {
                        eprintln!("[supervisor] pending worker 无法启动，回滚 from={} to={}", spec.version, st.active.version);
                        st.pending = None;
                        st.pending_crashes = 0;
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
                let v = st.active.version.clone();
                this.write_active_version(&v);
                this.spawn(&mut st);
            }
            loop {
                thread::sleep(Duration::from_millis(100));
                let mut st = this.state.lock().unwrap();
                if st.shutting_down {
                    break;
                }

                // 观察期通过 → 提交
                let commit = matches!(&st.pending, Some(p) if st.running_version == p.version && st.started_at.elapsed() >= this.probation);
                if commit {
                    let p = st.pending.take().unwrap();
                    eprintln!("[supervisor] worker upgrade committed version={}", p.version);
                    st.active = p;
                    st.pending_crashes = 0;
                    st.restarts = 0;
                    let v = st.active.version.clone();
                    this.write_active_version(&v);
                }

                // worker 退出？
                let exited = matches!(st.child.as_mut().map(|c| c.try_wait()), Some(Ok(Some(_))));
                if exited {
                    st.child = None;
                    let exited_version = st.running_version.clone();
                    let is_pending = matches!(&st.pending, Some(p) if p.version == exited_version);
                    if is_pending {
                        st.pending_crashes += 1;
                        let crashes = st.pending_crashes;
                        let pv = st.pending.as_ref().map(|p| p.version.clone()).unwrap_or_default();
                        eprintln!("[supervisor] pending worker exited version={pv} crashes={crashes}");
                        if crashes >= MAX_PENDING_CRASHES {
                            let av = st.active.version.clone();
                            eprintln!("[supervisor] crash-looping, rolling back from={pv} to={av}");
                            st.pending = None;
                            st.pending_crashes = 0;
                        }
                        st.next_spawn_at = Instant::now() + Duration::from_millis(300);
                    } else {
                        if st.started_at.elapsed() > Duration::from_secs(10) {
                            st.restarts = 0;
                        }
                        st.restarts += 1;
                        let delay = std::cmp::min(5000, 200 * st.restarts as u64);
                        eprintln!("[supervisor] worker exited version={exited_version}, restarting in {delay}ms");
                        st.next_spawn_at = Instant::now() + Duration::from_millis(delay);
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
        let mut st = self.state.lock().unwrap();
        let spec = match st.known.get(&version) {
            Some(s) => s.clone(),
            None => {
                eprintln!("[supervisor] unknown worker version {version}; ignoring");
                return;
            }
        };
        self.begin_switch(&mut st, spec);
    }

    /// 把已验签落盘的 spec 登记进注册表并切换过去。
    pub fn install_and_switch(&self, spec: WorkerSpec) {
        let mut st = self.state.lock().unwrap();
        st.known.insert(spec.version.clone(), spec.clone());
        self.begin_switch(&mut st, spec);
    }

    /// 远程升级：起线程下载 + 验签 + 落盘，成功才切换（验签不过则只打日志、保持当前版本）。
    pub fn install_from_url(self: &Arc<Self>, version: String, url: String, sha256: String, signature: String) {
        let this = Arc::clone(self);
        thread::spawn(move || match crate::upgrade::download_verify_install(&url, &sha256, &signature, &this.home, &version) {
            Ok(spec) => {
                eprintln!("[supervisor] 产物验签通过，切换到 {}", spec.version);
                this.install_and_switch(spec);
            }
            Err(e) => eprintln!("[supervisor] 升级被拒（保持当前版本）: {e}"),
        });
    }

    fn begin_switch(&self, st: &mut State, spec: WorkerSpec) {
        if spec.version == st.active.version && st.pending.is_none() {
            eprintln!("[supervisor] already on version {}", spec.version);
            return;
        }
        eprintln!("[supervisor] upgrading worker from={} to={}", st.active.version, spec.version);
        st.pending = Some(spec);
        st.pending_crashes = 0;
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
