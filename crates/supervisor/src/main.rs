//! supervisor —— daemon 的长生进程（热升级时不动）。
//!
//! 持有 PTY（portable-pty，唯一原生依赖留在此进程）；监听 UDS；起/管/重启 worker 子进程，
//! 支持版本切换 + 观察期回滚。worker 断开/重启都不影响 PTY，worker 重连后 resync 重挂会话。
//!
//! 渐进式 Rust 化：本进程是 Rust，但能对接现有已测的 TS worker（UDS 协议语言中立），
//! 故现有黑盒测试可直接验证。worker 走 COFLUX_WORKER_CMD/ARGS 指定（TS 阶段=node --import tsx worker.ts）。

mod manager;
mod sessions;

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use coflux_protocol::{decode_frame, is_frame, DataFrame, RecordParser, WorkerToSupervisor, SUPERVISOR_SOCK_ENV};

use manager::{Manager, WorkerSpec};
use sessions::{Pause, Sessions};

fn main() {
    let sock_path = std::env::var(SUPERVISOR_SOCK_ENV).unwrap_or_else(|_| format!("/tmp/coflux-sup-{}.sock", std::process::id()));
    let home = std::env::var("COFLUX_HOME").unwrap_or_else(|_| format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()));
    let shell = std::env::var("COFLUX_SHELL").ok().or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "/bin/bash".to_string());
    let scrollback_limit: usize = 200_000;
    let probation_ms: u64 = std::env::var("COFLUX_WORKER_PROBATION_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(8000);

    // 内置 worker 规格（TS 阶段由 harness/启动器经环境变量给出）
    let worker_cmd = std::env::var("COFLUX_WORKER_CMD").unwrap_or_default();
    if worker_cmd.is_empty() {
        eprintln!("[supervisor] COFLUX_WORKER_CMD 未设置，无 worker 可运行");
        std::process::exit(1);
    }
    let worker_args: Vec<String> = std::env::var("COFLUX_WORKER_ARGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let builtin = WorkerSpec { version: "builtin".to_string(), cmd: worker_cmd, args: worker_args };

    // 额外版本注册表（测试/运维预注册；将来由"下载+验签"填充）
    let mut known: HashMap<String, WorkerSpec> = HashMap::new();
    if let Ok(raw) = std::env::var("COFLUX_WORKER_SPECS") {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw) {
            for (version, v) in map {
                let cmd = v.get("cmd").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let args = v
                    .get("args")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                if !cmd.is_empty() {
                    known.insert(version.clone(), WorkerSpec { version, cmd, args });
                }
            }
        }
    }

    // 共享：outbound 通道（→ 当前 worker）+ 背压闸
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let pause: Pause = Arc::new((Mutex::new(false), Condvar::new()));
    let sessions = Sessions::new(tx, pause, shell, home.clone(), scrollback_limit);

    // 当前 worker 的写端（worker 重连即替换；断开置 None，输出被丢，scrollback 仍保留）
    let worker_w: Arc<Mutex<Option<UnixStream>>> = Arc::new(Mutex::new(None));
    {
        let worker_w = worker_w.clone();
        thread::spawn(move || {
            use std::io::Write;
            for rec in rx {
                let mut g = worker_w.lock().unwrap();
                if let Some(stream) = g.as_mut() {
                    if stream.write_all(&rec).is_err() {
                        *g = None;
                    }
                }
            }
        });
    }

    // worker 子进程管理
    let manager = Manager::new(builtin, known, sock_path.clone(), home, Duration::from_millis(probation_ms));
    manager.start();

    // 优雅关闭：SIGTERM/SIGINT → 杀 worker + 全部 PTY 后退出（systemd/launchd 会发 SIGTERM）
    {
        let manager = manager.clone();
        let sessions = sessions.clone();
        let sock_path = sock_path.clone();
        if let Ok(mut signals) = signal_hook::iterator::Signals::new([signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT]) {
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
    eprintln!("[supervisor] listening {sock_path}");

    let conn_counter = Arc::new(AtomicU64::new(0));
    let current_conn = Arc::new(AtomicU64::new(0));

    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(s) => s,
            Err(_) => continue,
        };
        let id = conn_counter.fetch_add(1, Ordering::SeqCst) + 1;
        current_conn.store(id, Ordering::SeqCst);
        match stream.try_clone() {
            Ok(wc) => *worker_w.lock().unwrap() = Some(wc),
            Err(e) => {
                eprintln!("[supervisor] try_clone: {e}");
                continue;
            }
        }
        eprintln!("[supervisor] worker connected");
        let sessions = sessions.clone();
        let manager = manager.clone();
        let worker_w = worker_w.clone();
        let current_conn = current_conn.clone();
        thread::spawn(move || {
            handle_worker(stream, &sessions, &manager);
            if current_conn.load(Ordering::SeqCst) == id {
                *worker_w.lock().unwrap() = None;
            }
            eprintln!("[supervisor] worker disconnected");
        });
    }
}

fn handle_worker(mut stream: UnixStream, sessions: &Arc<Sessions>, manager: &Arc<Manager>) {
    let mut parser = RecordParser::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                parser.push(&buf[..n], |rec| {
                    if is_frame(rec) {
                        if let Some(DataFrame::Input { session_id, data }) = decode_frame(rec) {
                            sessions.input(&session_id, &data);
                        }
                    } else if let Ok(msg) = serde_json::from_slice::<WorkerToSupervisor>(rec) {
                        dispatch(msg, sessions, manager);
                    }
                });
            }
        }
    }
}

fn dispatch(msg: WorkerToSupervisor, sessions: &Arc<Sessions>, manager: &Arc<Manager>) {
    use WorkerToSupervisor::*;
    match msg {
        SessionCreate { session_id, task_id, cwd, shell, cols, rows } => {
            sessions.create(session_id, task_id, cwd, shell.unwrap_or_default(), cols, rows)
        }
        SessionClose { session_id } => sessions.close(&session_id),
        SessionReplay { session_id, request_id } => sessions.replay(&session_id, request_id),
        PtyResize { session_id, cols, rows } => sessions.resize(&session_id, cols, rows),
        ResyncRequest => sessions.send_resync(),
        PtyPause => sessions.set_pause(true),
        PtyResume => sessions.set_pause(false),
        WorkerUpgrade { version } => manager.switch_worker(version),
    }
}
