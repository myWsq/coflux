//! worker —— 承载除 PTY 外的全部：连服务器(WS) + 认证 + git + exec + fs + 编排。
//!
//! PTY 操作经 UDS 转给 supervisor。两级 resync：先拿到 supervisor 存活快照(supSynced)，
//! 再向 server resync（否则空列表 resync 会让 server 误标 exited，随后真 resync 反触发 session.close 杀 PTY）。
//! 全 Rust 化后整个 daemon 无 node 运行时依赖。

mod creds;
mod git;
mod ops;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::{
    is_frame, write_record, DaemonToServer, RecordParser, ServerToDaemon, SessionRef, SupervisorToWorker, WorkerToSupervisor, SUPERVISOR_SOCK_ENV,
};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};
use tokio::sync::mpsc::{Receiver, Sender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use creds::{CredStore, Credentials};

#[derive(Clone)]
struct Config {
    server_url: String,
    enroll_key: String,
    device_name: String,
    host: String,
    platform: String,
    home: String,
    cred_path: String,
    worktrees_dir: String,
    sock_path: String,
    reconnect_base_ms: u64,
    reconnect_cap_ms: u64,
}

struct WorkerState {
    authed: bool,
    sup_synced: bool,
    alive: HashMap<String, String>, // sessionId -> taskId
    credentials: Option<Credentials>,
}

/// 出站到 server 的消息（WS 区分文本/二进制）
enum WsOut {
    Text(String),
    Binary(Vec<u8>),
}
impl WsOut {
    fn into_message(self) -> Message {
        match self {
            WsOut::Text(s) => Message::text(s),
            WsOut::Binary(b) => Message::binary(b),
        }
    }
}

fn env_or(key: &str, default: String) -> String {
    std::env::var(key).unwrap_or(default)
}

fn alive_to_resync(alive: &HashMap<String, String>) -> Vec<SessionRef> {
    alive.iter().map(|(s, t)| SessionRef { session_id: s.clone(), task_id: t.clone() }).collect()
}

async fn send_text(tx: &Sender<WsOut>, msg: &DaemonToServer) {
    if let Ok(s) = serde_json::to_string(msg) {
        let _ = tx.send(WsOut::Text(s)).await;
    }
}
async fn sup_ctrl(tx: &Sender<Vec<u8>>, msg: &WorkerToSupervisor) {
    if let Ok(bytes) = serde_json::to_vec(msg) {
        let _ = tx.send(write_record(&bytes)).await;
    }
}

#[tokio::main]
async fn main() {
    let home = env_or("COFLUX_HOME", format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()));
    let cfg = Arc::new(Config {
        server_url: env_or("COFLUX_SERVER", "ws://localhost:8787/daemon".into()),
        enroll_key: env_or("COFLUX_ENROLL_KEY", "dev-enroll".into()),
        device_name: env_or("COFLUX_DEVICE_NAME", env_or("HOSTNAME", "coflux-daemon".into())),
        host: env_or("HOSTNAME", "localhost".into()),
        platform: std::env::consts::OS.to_string(),
        cred_path: format!("{home}/credentials.json"),
        worktrees_dir: format!("{home}/worktrees"),
        sock_path: std::env::var(SUPERVISOR_SOCK_ENV).unwrap_or_default(),
        home: home.clone(),
        reconnect_base_ms: 1_000,
        reconnect_cap_ms: 30_000,
    });
    if cfg.sock_path.is_empty() {
        eprintln!("[worker] 缺少 {SUPERVISOR_SOCK_ENV}");
        std::process::exit(1);
    }

    // 写 pid 文件（测试/运维定位 worker 进程）
    let _ = std::fs::write(format!("{home}/worker.pid"), std::process::id().to_string());

    let creds_store = Arc::new(CredStore::new(cfg.cred_path.clone(), cfg.home.clone()));
    let state = Arc::new(Mutex::new(WorkerState { authed: false, sup_synced: false, alive: HashMap::new(), credentials: creds_store.load() }));

    let (to_server_tx, to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(2048);
    let (to_sup_tx, to_sup_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(2048);

    // 背压：to_server 通道深度近满 → 让 supervisor 暂停 PTY，降下来再恢复
    {
        let to_server_tx = to_server_tx.clone();
        let to_sup_tx = to_sup_tx.clone();
        let max = 2048usize;
        tokio::spawn(async move {
            let mut paused = false;
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let used = max - to_server_tx.capacity();
                if !paused && used > max * 3 / 4 {
                    sup_ctrl(&to_sup_tx, &WorkerToSupervisor::PtyPause).await;
                    paused = true;
                } else if paused && used < max / 4 {
                    sup_ctrl(&to_sup_tx, &WorkerToSupervisor::PtyResume).await;
                    paused = false;
                }
            }
        });
    }

    // supervisor 连接循环
    {
        let cfg = cfg.clone();
        let state = state.clone();
        let to_server_tx = to_server_tx.clone();
        tokio::spawn(async move { supervisor_loop(cfg, state, to_server_tx, to_sup_rx).await });
    }

    // 优雅关闭
    {
        let home = home.clone();
        tokio::spawn(async move {
            if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                sig.recv().await;
                eprintln!("[worker] shutdown");
                let _ = std::fs::remove_file(format!("{home}/worker.pid"));
                std::process::exit(0);
            }
        });
    }

    // server 连接循环（主任务）
    server_loop(cfg, state, creds_store, to_server_tx, to_server_rx, to_sup_tx).await;
}

/* ----------------------------- supervisor ----------------------------- */

async fn supervisor_loop(cfg: Arc<Config>, state: Arc<Mutex<WorkerState>>, to_server_tx: Sender<WsOut>, mut to_sup_rx: Receiver<Vec<u8>>) {
    loop {
        match UnixStream::connect(&cfg.sock_path).await {
            Ok(stream) => {
                eprintln!("[worker] connected to supervisor");
                run_sup_connection(stream, &state, &to_server_tx, &mut to_sup_rx).await;
            }
            Err(_) => {}
        }
        state.lock().unwrap().sup_synced = false;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn run_sup_connection(stream: UnixStream, state: &Arc<Mutex<WorkerState>>, to_server_tx: &Sender<WsOut>, to_sup_rx: &mut Receiver<Vec<u8>>) {
    let (mut rd, mut wr) = stream.into_split();
    // 索要存活会话快照
    if let Ok(bytes) = serde_json::to_vec(&WorkerToSupervisor::ResyncRequest) {
        if wr.write_all(&write_record(&bytes)).await.is_err() {
            return;
        }
    }
    let mut parser = RecordParser::new();
    let mut buf = [0u8; 8192];
    loop {
        tokio::select! {
            rec = to_sup_rx.recv() => {
                match rec {
                    Some(r) => if wr.write_all(&r).await.is_err() { break; },
                    None => break,
                }
            }
            n = rd.read(&mut buf) => {
                match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut records: Vec<Vec<u8>> = Vec::new();
                        parser.push(&buf[..n], |r| records.push(r.to_vec()));
                        for rec in records {
                            handle_sup_record(rec, state, to_server_tx).await;
                        }
                    }
                }
            }
        }
    }
}

async fn handle_sup_record(rec: Vec<u8>, state: &Arc<Mutex<WorkerState>>, to_server_tx: &Sender<WsOut>) {
    if is_frame(&rec) {
        // pty.output / pty.replay → 原样作为二进制帧转发给 server
        let _ = to_server_tx.send(WsOut::Binary(rec)).await;
        return;
    }
    let msg: SupervisorToWorker = match serde_json::from_slice(&rec) {
        Ok(m) => m,
        Err(_) => return,
    };
    match msg {
        SupervisorToWorker::SessionStarted { session_id, task_id, pid } => {
            state.lock().unwrap().alive.insert(session_id.clone(), task_id.clone());
            send_text(to_server_tx, &DaemonToServer::SessionStarted { session_id, task_id, pid }).await;
        }
        SupervisorToWorker::SessionExit { session_id, exit_code } => {
            state.lock().unwrap().alive.remove(&session_id);
            send_text(to_server_tx, &DaemonToServer::SessionExit { session_id, exit_code }).await;
        }
        SupervisorToWorker::ResyncList { sessions } => {
            let authed = {
                let mut s = state.lock().unwrap();
                s.alive.clear();
                for r in &sessions {
                    s.alive.insert(r.session_id.clone(), r.task_id.clone());
                }
                s.sup_synced = true;
                s.authed
            };
            eprintln!("[worker] supervisor resync count={}", sessions.len());
            if authed {
                send_text(to_server_tx, &DaemonToServer::DaemonResync { sessions }).await;
            }
        }
    }
}

/* ------------------------------- server ------------------------------- */

fn backoff(attempts: u32, cfg: &Config) -> Duration {
    let base = cfg.reconnect_base_ms.saturating_mul(1u64 << attempts.min(20)).min(cfg.reconnect_cap_ms).max(1);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0);
    Duration::from_millis(base / 2 + (nanos % (base / 2 + 1))) // base*(0.5..1.0)
}

async fn server_loop(
    cfg: Arc<Config>,
    state: Arc<Mutex<WorkerState>>,
    creds_store: Arc<CredStore>,
    to_server_tx: Sender<WsOut>,
    mut to_server_rx: Receiver<WsOut>,
    to_sup_tx: Sender<Vec<u8>>,
) {
    let mut attempts: u32 = 0;
    loop {
        match connect_async(&cfg.server_url).await {
            Ok((ws, _)) => {
                eprintln!("[worker] connected to server");
                attempts = 0;
                run_server_connection(ws, &cfg, &state, &creds_store, &to_server_tx, &mut to_server_rx, &to_sup_tx).await;
            }
            Err(e) => eprintln!("[worker] server connect error: {e}"),
        }
        attempts += 1;
        tokio::time::sleep(backoff(attempts, &cfg)).await;
    }
}

async fn run_server_connection(
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    cfg: &Arc<Config>,
    state: &Arc<Mutex<WorkerState>>,
    creds_store: &Arc<CredStore>,
    to_server_tx: &Sender<WsOut>,
    to_server_rx: &mut Receiver<WsOut>,
    to_sup_tx: &Sender<Vec<u8>>,
) {
    let (mut sink, mut stream) = ws.split();
    state.lock().unwrap().authed = false;

    // 认证 / 登记
    let creds = state.lock().unwrap().credentials.clone();
    let init = match creds {
        Some(c) => DaemonToServer::DaemonAuth { device_token: c.device_token },
        None => DaemonToServer::DaemonEnroll {
            enrollment_key: cfg.enroll_key.clone(),
            name: cfg.device_name.clone(),
            host: cfg.host.clone(),
            platform: cfg.platform.clone(),
        },
    };
    if let Ok(s) = serde_json::to_string(&init) {
        if sink.send(Message::text(s)).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            out = to_server_rx.recv() => {
                match out {
                    Some(msg) => if sink.send(msg.into_message()).await.is_err() { break; },
                    None => break,
                }
            }
            inc = stream.next() => {
                match inc {
                    Some(Ok(Message::Text(t))) => on_server_text(t.as_str(), cfg, state, creds_store, to_server_tx, to_sup_tx).await,
                    Some(Ok(Message::Binary(b))) => {
                        // pty.input → 原样转给 supervisor（仅认证后）
                        if state.lock().unwrap().authed {
                            let _ = to_sup_tx.send(write_record(b.as_ref())).await;
                        }
                    }
                    Some(Ok(Message::Ping(p))) => { let _ = sink.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}

async fn on_server_text(text: &str, cfg: &Arc<Config>, state: &Arc<Mutex<WorkerState>>, creds_store: &Arc<CredStore>, to_server_tx: &Sender<WsOut>, to_sup_tx: &Sender<Vec<u8>>) {
    let msg: ServerToDaemon = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(_) => return,
    };
    match msg {
        ServerToDaemon::DaemonEnrolled { daemon_id, device_token } => {
            let c = Credentials { server_url: cfg.server_url.clone(), daemon_id: daemon_id.clone(), device_token };
            creds_store.save(&c);
            state.lock().unwrap().credentials = Some(c);
            eprintln!("[worker] enrolled {daemon_id}");
            on_authed(state, to_server_tx).await;
        }
        ServerToDaemon::DaemonAuthed { daemon_id } => {
            eprintln!("[worker] authenticated {daemon_id}");
            on_authed(state, to_server_tx).await;
        }
        ServerToDaemon::DaemonAuthError { message, need_enroll } => {
            eprintln!("[worker] auth error: {message}");
            if need_enroll {
                creds_store.clear();
                state.lock().unwrap().credentials = None;
            } else {
                eprintln!("[worker] enrollment key invalid; exiting");
                std::process::exit(1);
            }
        }
        other => {
            let authed = state.lock().unwrap().authed;
            if authed {
                route_authed(other, cfg, to_server_tx, to_sup_tx).await;
            }
        }
    }
}

async fn on_authed(state: &Arc<Mutex<WorkerState>>, to_server_tx: &Sender<WsOut>) {
    let resync = {
        let mut s = state.lock().unwrap();
        s.authed = true;
        if s.sup_synced {
            Some(alive_to_resync(&s.alive))
        } else {
            None
        }
    };
    // 两级 resync：拿到 supervisor 快照后才向 server resync；否则待 resync.list 到达时补发
    if let Some(sessions) = resync {
        send_text(to_server_tx, &DaemonToServer::DaemonResync { sessions }).await;
    }
}

async fn route_authed(msg: ServerToDaemon, cfg: &Arc<Config>, to_server_tx: &Sender<WsOut>, to_sup_tx: &Sender<Vec<u8>>) {
    match msg {
        // git（可能慢）→ 派生任务，结果回带
        ServerToDaemon::ProjectValidate { request_id, path } => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let r = git::validate_repo(&path).await;
                send_text(&to_server, &DaemonToServer::ProjectValidated { request_id, ok: r.ok, repo_path: r.repo_path, branch: r.branch, error: r.error }).await;
            });
        }
        ServerToDaemon::WorktreeAdd { request_id, repo_path, workspace_id, name, branch, create_new } => {
            let to_server = to_server_tx.clone();
            let worktrees_dir = cfg.worktrees_dir.clone();
            tokio::spawn(async move {
                let r = git::add_worktree(&worktrees_dir, &repo_path, &workspace_id, &name, &branch, create_new).await;
                send_text(&to_server, &DaemonToServer::WorktreeAdded { request_id, ok: r.ok, path: r.path, branch: r.branch, error: r.error }).await;
            });
        }
        ServerToDaemon::WorktreeRemove { repo_path, worktree_path } => {
            tokio::spawn(async move { git::remove_worktree(&repo_path, &worktree_path).await });
        }
        // PTY → 转给 supervisor
        ServerToDaemon::SessionCreate { session_id, task_id, cwd, shell, cols, rows } => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionCreate { session_id, task_id, cwd, shell, cols, rows }).await;
        }
        ServerToDaemon::SessionReplay { session_id, request_id } => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionReplay { session_id, request_id }).await;
        }
        ServerToDaemon::PtyResize { session_id, cols, rows } => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::PtyResize { session_id, cols, rows }).await;
        }
        ServerToDaemon::SessionClose { session_id } => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionClose { session_id }).await;
        }
        ServerToDaemon::WorkerUpgrade { version } => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::WorkerUpgrade { version }).await;
        }
        // exec / fs → 派生任务，结果回带
        ServerToDaemon::ExecRun { request_id, cwd, command, args, env, timeout_ms } => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let r = ops::run_command(&cwd, &command, &args, env.as_ref(), timeout_ms).await;
                send_text(&to_server, &DaemonToServer::ExecResult { request_id, ok: r.ok, exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr, error: r.error }).await;
            });
        }
        ServerToDaemon::FsList { request_id, root, path } => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let (ok, entries, error) = ops::list_dir(&root, &path).await;
                send_text(&to_server, &DaemonToServer::FsListed { request_id, ok, entries, error }).await;
            });
        }
        ServerToDaemon::FsRead { request_id, root, path } => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let (ok, content, error) = ops::read_file_text(&root, &path).await;
                send_text(&to_server, &DaemonToServer::FsReadResult { request_id, ok, content, error }).await;
            });
        }
        _ => {}
    }
}
