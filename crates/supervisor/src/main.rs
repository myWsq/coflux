//! supervisor —— daemon 的长生进程（热升级时不动）。
//!
//! 持有 PTY（portable-pty，唯一原生依赖留在此进程）；监听 UDS；起/管/重启 worker 子进程，
//! 支持版本切换 + 观察期回滚。worker 断开/重启都不影响 PTY，worker 重连后 resync 重挂会话。
//!
//! 渐进式 Rust 化：本进程是 Rust，但能对接现有已测的 TS worker（UDS 协议语言中立），
//! 故现有黑盒测试可直接验证。worker 走 COFLUX_WORKER_CMD/ARGS 指定（TS 阶段=node --import tsx worker.ts）。

mod fda;
mod manager;
mod sessiond;
mod sessions;
mod upgrade;

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;

use coflux_protocol::{
    decode_frame, is_frame, DataFrame, RecordParser, Settings, WorkerToSupervisor,
    SUPERVISOR_SOCK_ENV,
};

use manager::{Manager, WorkerSpec};
use sessions::{Outbound, Sessions};

/// supervisor 自身版本：编译期注入 release tag（`.github/workflows/release.yml` 传
/// `COFLUX_RELEASE_VERSION=${{ github.ref_name }}`）；本地构建未设该 env 时落 "dev"。
/// 注意这与 worker 版本是两回事——worker 版本纯是 supervisor 侧概念（见 manager.rs WorkerSpec），
/// 此处只是 supervisor 自己的版本，随握手消息一并上报供 web 展示（不参与自动升级判断）。
const SUPERVISOR_VERSION: &str = match option_env!("COFLUX_RELEASE_VERSION") {
    Some(v) => v,
    None => "dev",
};

const DEFAULT_HISTORY_LINE_LIMIT: usize = 2_000;
/// history 会按逻辑行上限再乘 wrap 余量建立 VT scrollback；环境变量不能把单 session
/// 的常驻内存放大到任意值，也不能用 0 意外关闭历史边界。
const MAX_HISTORY_LINE_LIMIT: usize = 10_000;

fn parse_history_line_limit(value: Option<&str>) -> usize {
    value
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(DEFAULT_HISTORY_LINE_LIMIT)
        .clamp(1, MAX_HISTORY_LINE_LIMIT)
}

/// 与 supervisor 二进制同目录的 coflux-worker 路径（cofluxd 把两个二进制装在一起）。
fn sibling_worker() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.parent()
                .map(|d| d.join("coflux-worker").to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

/// 启动清扫：删掉默认路径模式下进程已死的残留 socket。SIGTERM 路径有清理（见下方信号处理），
/// 但测试/崩溃/SIGKILL 不走那条路，残留只能靠下一次启动兜底。仅 ESRCH 才删：
/// PID 被复用或属他人（EPERM）时保留，宁可少删。
fn sweep_dead_sockets() {
    let Ok(entries) = std::fs::read_dir("/tmp") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_prefix("coflux-sup-"))
            .and_then(|n| n.strip_suffix(".sock"))
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        if pid != std::process::id() as i32
            && unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn main() {
    let sock_path = std::env::var(SUPERVISOR_SOCK_ENV)
        .unwrap_or_else(|_| format!("/tmp/coflux-sup-{}.sock", std::process::id()));
    sweep_dead_sockets();
    let home = std::env::var("COFLUX_HOME")
        .unwrap_or_else(|_| format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()));
    let settings = Settings::load(&home);
    fda::write_status(&home); // macOS: 探测完全磁盘访问权限并落盘,供 cofluxd status/fda 展示引导；非 macOS 空操作
    let shell = std::env::var("COFLUX_SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .or(settings.shell)
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/bash".to_string());
    let history_line_limit =
        parse_history_line_limit(std::env::var("COFLUX_HISTORY_LINES").ok().as_deref());
    // 健康门包含“连中心并排入 daemon resync”；默认必须覆盖 worker 的 15s connect timeout
    // 与正常认证往返，不能用旧的 8s 在黑洞/慢 TLS 下先把健康候选误杀。
    let probation_ms: u64 = std::env::var("COFLUX_WORKER_PROBATION_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30_000);

    // 内置 worker 规格：默认用与 supervisor 同目录的 coflux-worker；COFLUX_WORKER_CMD 可覆盖（测试用）。
    let worker_cmd = std::env::var("COFLUX_WORKER_CMD")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(sibling_worker);
    if worker_cmd.is_empty() {
        eprintln!(
            "[supervisor] 找不到 worker 二进制（同目录无 coflux-worker，且未设 COFLUX_WORKER_CMD）"
        );
        std::process::exit(1);
    }
    let worker_args: Vec<String> = std::env::var("COFLUX_WORKER_ARGS")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // 正式 release 中 supervisor 与内置 worker 同步构建，因此用编译期严格
    // SemVer 作为内置 worker 身份与 anti-rollback 安全起点。dev/test 的 "dev"
    // 仍保留旧 "builtin" 名称，不改变本地开发和黑盒测试预期。
    let builtin_version = if upgrade::ReleaseVersion::parse(SUPERVISOR_VERSION).is_ok() {
        SUPERVISOR_VERSION.to_string()
    } else {
        "builtin".to_string()
    };
    let builtin = WorkerSpec {
        version: builtin_version,
        cmd: worker_cmd,
        args: worker_args,
    };

    // 额外版本注册表（测试/运维预注册；将来由"下载+验签"填充）
    let mut known: HashMap<String, WorkerSpec> = HashMap::new();
    if let Ok(raw) = std::env::var("COFLUX_WORKER_SPECS") {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw)
        {
            for (version, v) in map {
                let cmd = v
                    .get("cmd")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = v
                    .get("args")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                if !cmd.is_empty() {
                    known.insert(version.clone(), WorkerSpec { version, cmd, args });
                }
            }
        }
    }

    // PTY/VT authority 永远不等待 worker；每次连接有独立的 bounded outbound writer。
    let outbound = Outbound::new();
    let sessions = Sessions::new(outbound, shell, home.clone(), history_line_limit);

    // worker 子进程管理
    let manager = Manager::new(
        builtin,
        known,
        sock_path.clone(),
        home,
        Duration::from_millis(probation_ms),
        SUPERVISOR_VERSION.to_string(),
    );
    manager.start();

    // 优雅关闭：SIGTERM/SIGINT → 杀 worker + 全部 PTY 后退出（systemd/launchd 会发 SIGTERM）
    {
        let manager = manager.clone();
        let sessions = sessions.clone();
        let sock_path = sock_path.clone();
        if let Ok(mut signals) = signal_hook::iterator::Signals::new([
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGINT,
        ]) {
            thread::spawn(move || {
                if signals.forever().next().is_some() {
                    eprintln!("[supervisor] shutdown");
                    manager.shutdown();
                    sessions.shutdown();
                    let _ = std::fs::remove_file(&sock_path);
                    std::process::exit(0);
                }
            });
        }
    }

    // UDS server
    let _ = std::fs::remove_file(&sock_path);
    let listener = match std::os::unix::net::UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[supervisor] bind {sock_path}: {e}");
            std::process::exit(1);
        }
    };
    if let Err(error) = std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600))
    {
        eprintln!("[supervisor] chmod {sock_path}: {error}");
        let _ = std::fs::remove_file(&sock_path);
        std::process::exit(1);
    }
    eprintln!("[supervisor] listening {sock_path}");

    let conn_counter = Arc::new(AtomicU64::new(0));
    // read guard 覆盖单条 worker record 的完整 dispatch，write guard 则定义新连接接管点。
    let current_conn = Arc::new(RwLock::new(0u64));

    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(s) => s,
            Err(_) => continue,
        };
        let id = conn_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let writer_stream = match stream.try_clone() {
            Ok(stream) => stream,
            Err(e) => {
                eprintln!("[supervisor] try_clone: {e}");
                continue;
            }
        };
        {
            let mut current = current_conn.write().unwrap();
            // 接管发布与 manager 健康状态重置属于同一个临界区，不能让监控线程在
            // current_conn 已换新、旧健康信号尚未清除的窗口提交候选。
            manager.worker_connected(id);
            sessions.worker_connected(id, writer_stream);
            *current = id;
        }
        eprintln!("[supervisor] worker connected generation={id}");
        let sessions = sessions.clone();
        let manager = manager.clone();
        let current_conn = current_conn.clone();
        thread::spawn(move || {
            handle_worker(stream, &sessions, &manager, id, &current_conn);
            let mut current = current_conn.write().unwrap();
            // 与接管路径使用同一锁序（current_conn → manager），避免新旧连接交叉死锁。
            sessions.worker_disconnected(id);
            manager.worker_disconnected(id);
            if *current == id {
                *current = 0;
            }
            eprintln!("[supervisor] worker disconnected generation={id}");
        });
    }
}

fn handle_worker(
    mut stream: UnixStream,
    sessions: &Arc<Sessions>,
    manager: &Arc<Manager>,
    generation: u64,
    current_conn: &RwLock<u64>,
) {
    let mut parser = RecordParser::new();
    let mut buf = [0u8; 8192];
    loop {
        if *current_conn.read().unwrap() != generation {
            break;
        }
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Err(error) = parser.push(&buf[..n], |rec| {
                    // 新连接一旦接管，旧 socket 已读入但尚未 dispatch 的记录也必须失效。
                    // device input 在这里只做 mutex 内的 authority reservation + 非阻塞
                    // try_send，真正可能永久阻塞的 PTY write 已移到独立线程，因此这把
                    // read guard 不再被 stdin syscall 占住，同时仍保留接管的线性化边界。
                    let current = current_conn.read().unwrap();
                    if *current != generation {
                        return;
                    }
                    if is_frame(rec) {
                        match decode_frame(rec) {
                            Some(DataFrame::Device { channel_id, data }) => {
                                sessions.handle_device(&channel_id, &data)
                            }
                            _ => {}
                        }
                    } else if let Ok(msg) = serde_json::from_slice::<WorkerToSupervisor>(rec) {
                        dispatch(msg, sessions, manager, generation);
                    }
                }) {
                    eprintln!(
                        "[supervisor] worker UDS record 违规 generation={generation}: {error}"
                    );
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod sweep_tests {
    use super::{
        parse_history_line_limit, sweep_dead_sockets, DEFAULT_HISTORY_LINE_LIMIT,
        MAX_HISTORY_LINE_LIMIT,
    };

    #[test]
    fn history_line_limit_defaults_and_clamps_to_nonzero_hard_limit() {
        assert_eq!(parse_history_line_limit(None), DEFAULT_HISTORY_LINE_LIMIT);
        assert_eq!(
            parse_history_line_limit(Some("not-a-number")),
            DEFAULT_HISTORY_LINE_LIMIT
        );
        assert_eq!(parse_history_line_limit(Some("0")), 1);
        assert_eq!(parse_history_line_limit(Some("1")), 1);
        assert_eq!(
            parse_history_line_limit(Some(&MAX_HISTORY_LINE_LIMIT.to_string())),
            MAX_HISTORY_LINE_LIMIT
        );
        assert_eq!(
            parse_history_line_limit(Some(&usize::MAX.to_string())),
            MAX_HISTORY_LINE_LIMIT
        );
    }

    #[test]
    fn removes_dead_keeps_alive() {
        // 999999 超出 macOS/Linux 默认 pid 上限，必死；自身 pid 必活。
        let dead = std::path::PathBuf::from("/tmp/coflux-sup-999999.sock");
        let alive =
            std::path::PathBuf::from(format!("/tmp/coflux-sup-{}.sock", std::process::id()));
        std::fs::write(&dead, b"").unwrap();
        std::fs::write(&alive, b"").unwrap();
        sweep_dead_sockets();
        assert!(!dead.exists(), "死 PID 的 socket 应被清掉");
        assert!(alive.exists(), "活 PID 的 socket 应保留");
        let _ = std::fs::remove_file(&alive);
    }
}

fn dispatch(
    msg: WorkerToSupervisor,
    sessions: &Arc<Sessions>,
    manager: &Arc<Manager>,
    connection_generation: u64,
) {
    use WorkerToSupervisor::*;
    match msg {
        SessionCreate {
            session_id,
            task_id,
            cwd,
            shell,
            cols,
            rows,
        } => sessions.create(
            session_id,
            task_id,
            cwd,
            shell.unwrap_or_default(),
            cols,
            rows,
        ),
        SessionClose { session_id } => sessions.close(&session_id),
        ResyncRequest => {
            let nonce = manager.issue_resync_challenge(connection_generation);
            if !sessions.send_resync(nonce.clone()) {
                manager.cancel_resync_challenge(connection_generation, &nonce);
                // 共享有界队列瞬时满时主动断开，让真实 worker 重连重试。
                sessions.worker_disconnected(connection_generation);
            }
        }
        ResyncApplied { nonce } => manager.worker_resynced(connection_generation, &nonce),
        WorkerUpgrade {
            version,
            url,
            sha256,
            signature,
            target,
            artifact_size,
            release_signature,
        } => match url {
            // 带 url：下载 + 验签（线程内），通过才切换
            Some(url) => manager.install_from_url(
                version,
                url,
                sha256.unwrap_or_default(),
                signature.unwrap_or_default(),
                target.unwrap_or_default(),
                artifact_size.unwrap_or_default(),
                release_signature.unwrap_or_default(),
            ),
            // 不带 url：本地已知版本切换
            None => manager.switch_worker(version),
        },
    }
}
