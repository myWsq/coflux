//! worker —— 承载除 PTY 外的全部：连服务器(WS) + 认证 + git + exec + fs + 编排。
//!
//! PTY 操作经 UDS 转给 supervisor。两级 resync：先拿到 supervisor 存活快照(supSynced)，
//! 再向 server resync（否则空列表 resync 会让 server 误标 exited，随后真 resync 反触发 session.close 杀 PTY）。
//! 全 Rust 化后整个 daemon 无 node 运行时依赖。

mod creds;
mod dec_modes;
mod git;
mod ops;
mod ports;
mod tunnel;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::{
    decode_frame, encode_frame, is_frame, wire, write_record, DataFrame, RecordParser, Settings, SessionInfo, SupervisorToWorker, WorkerToSupervisor, SUPERVISOR_SOCK_ENV,
};
use coflux_protocol::wire::{daemon_to_server, server_to_daemon};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};
use tokio::sync::mpsc::{Receiver, Sender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use creds::{CredStore, Credentials, PendingAuth};
use dec_modes::DecModeTracker;

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
    alive: HashMap<String, (String, i32)>, // sessionId -> (taskId, pid)
    credentials: Option<Credentials>,
    /// 等待授权中的链接过期时刻（server 侧 epoch ms）。到期且连接仍在、仍未登记时，
    /// 由 run_server_connection 的定时检查重发 daemon.enrollRequest 换新链接。
    pending_auth_expires_at: Option<f64>,
    /// 端口探测(005)上一次实际发出的全量快照:变化才发的比较基准，也是重连补发的缓存。
    last_reported_ports: Vec<wire::SessionPorts>,
    /// server 下发的本设备工作区清单：workspace_id -> worktree 路径（分支监视用）
    workspaces: HashMap<String, String>,
    /// 上次上报的分支：workspace_id -> branch。收到新清单时清空，下一轮全量比对上报（重连对账）
    last_branches: HashMap<String, String>,
    /// per-session DEC 私有模式追踪（见 dec_modes.rs）：supervisor scrollback 环把模式设置转义
    /// 挤出去后，replay 转发前用它补前缀，不让 attach/resync 丢失 bracketed-paste 等模式状态。
    dec_modes: HashMap<String, DecModeTracker>,
}

/// 出站到 server 的消息：WS 上只有 binary message，一条 = 一个已编码好的 protobuf 信封字节串
/// （[wire::DaemonToServer] 编码结果）。不再区分文本/二进制——旧 JSON 控制帧与自定义二进制
/// 数据帧统一收敛成这一种。
pub(crate) type WsOut = Vec<u8>;

fn env_or(key: &str, default: String) -> String {
    std::env::var(key).unwrap_or(default)
}

/// 取值优先级：同名 env（非空）> settings.json > 默认。env 覆盖便于测试/开发。
fn pick(env_key: &str, from_settings: Option<String>, default: &str) -> String {
    std::env::var(env_key)
        .ok()
        .filter(|s| !s.is_empty())
        .or(from_settings)
        .unwrap_or_else(|| default.to_string())
}

fn alive_to_resync(alive: &HashMap<String, (String, i32)>) -> Vec<wire::SessionRef> {
    alive.iter().map(|(s, (t, _pid))| wire::SessionRef { session_id: s.clone(), task_id: t.clone() }).collect()
}

/// 把一个 DaemonToServer payload 套上信封、prost 编码，送进 to_server 通道（WS binary message）。
pub(crate) async fn send_d2s(tx: &Sender<WsOut>, payload: daemon_to_server::Payload) {
    let env = wire::DaemonToServer { payload: Some(payload) };
    let _ = tx.send(env.encode_to_vec()).await;
}
async fn sup_ctrl(tx: &Sender<Vec<u8>>, msg: &WorkerToSupervisor) {
    if let Ok(bytes) = serde_json::to_vec(msg) {
        let _ = tx.send(write_record(&bytes)).await;
    }
}

/// clamp：wire 上 cols/rows/port 是 uint32，内部 PTY/隧道 API 用 u16——收窄时钳位而非截断环绕。
fn clamp_u16(v: u32) -> u16 {
    v.min(u16::MAX as u32) as u16
}

/// 全量计算当前每个存活会话(有监听端口的)的 ports.update payload；按 sessionId 排序，
/// 保证多次调用在会话/端口集合不变时输出完全一致（供「变化才发」的相等比较使用）。
fn build_ports_update(alive: &HashMap<String, (String, i32)>) -> Vec<wire::SessionPorts> {
    let mut sessions: Vec<wire::SessionPorts> = alive
        .iter()
        .filter_map(|(session_id, (_task_id, pid))| {
            let mut ports: Vec<u16> = ports::listening_ports(*pid).into_iter().collect();
            if ports.is_empty() {
                return None;
            }
            ports.sort_unstable();
            Some(wire::SessionPorts { session_id: session_id.clone(), ports: ports.into_iter().map(u32::from).collect() })
        })
        .collect();
    sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    sessions
}

/// 周期(2s)扫描每个存活会话的进程树监听端口；变化才发全量（会话退出/端口关闭在下一轮
/// 扫描中自然从集合里消失，无需特判）。扫描本身是同步阻塞 IO(/proc 读或 libproc 系统调
/// 用)，用 spawn_blocking 挪出 async 执行器，避免卡住 tokio 工作线程。
async fn report_ports_if_changed(state: &Arc<Mutex<WorkerState>>, to_server_tx: &Sender<WsOut>) {
    let alive = { state.lock().unwrap().alive.clone() }; // 取快照即释放锁，不跨扫描 await 持锁
    let sessions = match tokio::task::spawn_blocking(move || build_ports_update(&alive)).await {
        Ok(s) => s,
        Err(_) => return, // 扫描任务 panic：静默跳过这一轮，不影响主循环
    };
    let changed = {
        let mut s = state.lock().unwrap();
        if s.last_reported_ports == sessions {
            false
        } else {
            s.last_reported_ports = sessions.clone();
            true
        }
    };
    if changed {
        send_d2s(to_server_tx, daemon_to_server::Payload::PortsUpdate(wire::PortsUpdate { sessions })).await;
    }
}

/// 重连认证成功后无条件补发一次当前端口全量，防 server 重启丢状态（daemon 侧视角没有
/// 变化也要发，这与周期任务「变化才发」的逻辑是两回事，故不复用 report_ports_if_changed）。
async fn force_report_ports(state: &Arc<Mutex<WorkerState>>, to_server_tx: &Sender<WsOut>) {
    let alive = { state.lock().unwrap().alive.clone() };
    let sessions = match tokio::task::spawn_blocking(move || build_ports_update(&alive)).await {
        Ok(s) => s,
        Err(_) => return,
    };
    state.lock().unwrap().last_reported_ports = sessions.clone();
    send_d2s(to_server_tx, daemon_to_server::Payload::PortsUpdate(wire::PortsUpdate { sessions })).await;
}

#[tokio::main]
async fn main() {
    // rustls 0.23 要求在任何 TLS 握手前选定 process-level CryptoProvider，
    // 否则连 wss:// 时 panic（"Could not automatically determine the process-level CryptoProvider"）。
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("安装 rustls ring CryptoProvider 失败");
    let home = env_or("COFLUX_HOME", format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()));
    let s = Settings::load(&home); // 用户配置，env 同名变量可覆盖
    let cfg = Arc::new(Config {
        server_url: pick("COFLUX_SERVER", s.server_url, "ws://localhost:8787/daemon"),
        enroll_key: pick("COFLUX_ENROLL_KEY", s.enroll_key, "dev-enroll"),
        device_name: pick("COFLUX_DEVICE_NAME", s.device_name, &env_or("HOSTNAME", "coflux-daemon".into())),
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

    eprintln!("[worker] config server={} device={}", cfg.server_url, cfg.device_name);

    // 写 pid 文件（测试/运维定位 worker 进程）
    let _ = std::fs::write(format!("{home}/worker.pid"), std::process::id().to_string());

    let creds_store = Arc::new(CredStore::new(cfg.cred_path.clone(), cfg.home.clone()));
    let state = Arc::new(Mutex::new(WorkerState {
        authed: false,
        sup_synced: false,
        alive: HashMap::new(),
        credentials: creds_store.load(),
        pending_auth_expires_at: None,
        last_reported_ports: Vec::new(),
        workspaces: HashMap::new(),
        last_branches: HashMap::new(),
        dec_modes: HashMap::new(),
    }));

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

    // 分支监视：worktree HEAD 是分支的真相源，周期读取（纯文件读，无子进程），变化才上报。
    {
        let state = state.clone();
        let to_server_tx = to_server_tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let targets: Vec<(String, String)> = {
                    let s = state.lock().unwrap();
                    if !s.authed {
                        continue;
                    }
                    s.workspaces.iter().map(|(id, path)| (id.clone(), path.clone())).collect()
                };
                for (workspace_id, path) in targets {
                    let Some(branch) = git::current_branch(&path) else { continue };
                    let changed = {
                        let mut s = state.lock().unwrap();
                        if s.last_branches.get(&workspace_id) == Some(&branch) {
                            false
                        } else {
                            s.last_branches.insert(workspace_id.clone(), branch.clone());
                            true
                        }
                    };
                    if changed {
                        send_d2s(&to_server_tx, daemon_to_server::Payload::WorkspaceBranch(wire::WorkspaceBranch { workspace_id, branch })).await;
                    }
                }
            }
        });
    }

    // 端口探测（005）：周期扫描每个存活 PTY 会话进程树的监听端口，变化才发全量
    {
        let state = state.clone();
        let to_server_tx = to_server_tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                report_ports_if_changed(&state, &to_server_tx).await;
            }
        });
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
        // pty.output / pty.replay：UDS 内部帧格式（frame.rs，未变）解出原始字节，套成
        // protobuf 信封转发给 server —— WS 侧只认 protobuf binary，不再透传 UDS 自定义帧。
        match decode_frame(&rec) {
            Some(DataFrame::Output { session_id, data }) => {
                // 旁路喂给模式追踪器，转发字节本身不受影响（live 输出路径，见 dec_modes.rs）。
                state.lock().unwrap().dec_modes.entry(session_id.clone()).or_default().feed(&data);
                send_d2s(to_server_tx, daemon_to_server::Payload::PtyOutput(wire::PtyOutput { session_id, data })).await;
            }
            Some(DataFrame::Replay { session_id, request_id, data }) => {
                // 先取"当前已知激活模式"快照拼前缀，再把本次 replay 数据喂进追踪器——
                // 前缀代表被 supervisor scrollback 环挤掉的前缀净效果，顺序不能反（否则
                // replay 里自带的 h/l 会先污染"起点状态"）。
                let prefix = {
                    let mut s = state.lock().unwrap();
                    let tracker = s.dec_modes.entry(session_id.clone()).or_default();
                    let prefix = tracker.prefix();
                    tracker.feed(&data);
                    prefix
                };
                let data = if prefix.is_empty() {
                    data
                } else {
                    let mut buf = prefix;
                    buf.extend_from_slice(&data);
                    buf
                };
                send_d2s(to_server_tx, daemon_to_server::Payload::PtyReplay(wire::PtyReplay { session_id, request_id, data })).await;
            }
            // Input/ProxyData 不会从 supervisor→worker 方向出现；畸形帧同样丢弃，不 panic。
            Some(_) | None => eprintln!("[worker] 丢弃来自 supervisor 的未知/畸形数据帧"),
        }
        return;
    }
    let msg: SupervisorToWorker = match serde_json::from_slice(&rec) {
        Ok(m) => m,
        Err(_) => return,
    };
    match msg {
        SupervisorToWorker::SessionStarted { session_id, task_id, pid } => {
            state.lock().unwrap().alive.insert(session_id.clone(), (task_id.clone(), pid));
            send_d2s(to_server_tx, daemon_to_server::Payload::SessionStarted(wire::SessionStarted { session_id, task_id, pid })).await;
        }
        SupervisorToWorker::SessionExit { session_id, exit_code } => {
            let mut s = state.lock().unwrap();
            s.alive.remove(&session_id);
            s.dec_modes.remove(&session_id); // 会话退出：释放追踪状态，避免泄漏
            drop(s);
            send_d2s(to_server_tx, daemon_to_server::Payload::SessionExit(wire::SessionExit { session_id, exit_code })).await;
        }
        SupervisorToWorker::ResyncList { sessions } => {
            let authed = {
                let mut s = state.lock().unwrap();
                s.alive.clear();
                for r in &sessions {
                    s.alive.insert(r.session_id.clone(), (r.task_id.clone(), r.pid));
                }
                // 断线期间静默退出的会话不会单独收到 SessionExit：resync 快照是这批会话的
                // 权威在场证明，借机把已不在场的追踪状态一并回收。
                let alive_now = s.alive.clone();
                s.dec_modes.retain(|session_id, _| alive_now.contains_key(session_id));
                s.sup_synced = true;
                s.authed
            };
            eprintln!("[worker] supervisor resync count={}", sessions.len());
            if authed {
                // daemon→server 的 daemon.resync 形状已冻结（SessionRef，不含 pid），
                // pid 只在 UDS 快照(SessionInfo)里供本地端口探测（005）用
                let resync: Vec<wire::SessionRef> = sessions.into_iter().map(|s: SessionInfo| wire::SessionRef { session_id: s.session_id, task_id: s.task_id }).collect();
                send_d2s(to_server_tx, daemon_to_server::Payload::DaemonResync(wire::DaemonResync { sessions: resync })).await;
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
    {
        let mut s = state.lock().unwrap();
        s.authed = false;
        s.pending_auth_expires_at = None; // 授权链接与连接同生命周期，新连接从零开始
    }
    // 隧道状态绑定单次 server 连接生命周期：不跨重连恢复（浏览器侧 TCP 早已断，恢复无意义）
    let tunnels = tunnel::TunnelSet::new(to_server_tx.clone());

    // 认证 / 登记：三选一。credentials.json 存在 → daemon.auth 重连；否则看有没有配 enrollKey——
    // 非空走经典 daemon.enroll；空（cofluxd 默认 up 零参数写入的显式 ""，见 pick() 的 env-only
    // filter 语义）走 Tailscale 式 daemon.enrollRequest，等 web 端确认后 server 原地推 daemon.enrolled。
    let creds = state.lock().unwrap().credentials.clone();
    let init = match creds {
        Some(c) => daemon_to_server::Payload::DaemonAuth(wire::DaemonAuth { device_token: c.device_token }),
        None if cfg.enroll_key.is_empty() => daemon_to_server::Payload::DaemonEnrollRequest(wire::DaemonEnrollRequest {
            name: cfg.device_name.clone(),
            host: cfg.host.clone(),
            platform: cfg.platform.clone(),
        }),
        None => daemon_to_server::Payload::DaemonEnroll(wire::DaemonEnroll {
            enrollment_key: cfg.enroll_key.clone(),
            name: cfg.device_name.clone(),
            host: cfg.host.clone(),
            platform: cfg.platform.clone(),
        }),
    };
    let init_bytes = (wire::DaemonToServer { payload: Some(init) }).encode_to_vec();
    if sink.send(Message::binary(init_bytes)).await.is_err() {
        return;
    }

    // 授权链接续期：TTL 到点而用户还没确认时，server 只是默默摘除内存里的 pending token，
    // 既不通知也不断连——worker 必须自己重发 enrollRequest 换新链接，否则 cofluxd 展示的
    // 永远是死链。1s 粒度的检查对 10min 级 TTL 足够精细。
    let mut renew_tick = tokio::time::interval(Duration::from_secs(1));
    renew_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = renew_tick.tick() => {
                let expired = {
                    let mut s = state.lock().unwrap();
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as f64)
                        .unwrap_or(0.0);
                    // 仅在"仍未登记且确实在等授权"时续期；DaemonEnrolled 会清掉这个字段，
                    // 保证登记完成后绝不会再误发 enrollRequest。
                    match s.pending_auth_expires_at {
                        Some(t) if !s.authed && s.credentials.is_none() && now_ms >= t => {
                            s.pending_auth_expires_at = None; // 等新的 authorizePending 重新设置，防重复发
                            true
                        }
                        _ => false,
                    }
                };
                if expired {
                    eprintln!("[worker] authorization link expired; requesting a new one");
                    let req = daemon_to_server::Payload::DaemonEnrollRequest(wire::DaemonEnrollRequest {
                        name: cfg.device_name.clone(),
                        host: cfg.host.clone(),
                        platform: cfg.platform.clone(),
                    });
                    let bytes = (wire::DaemonToServer { payload: Some(req) }).encode_to_vec();
                    if sink.send(Message::binary(bytes)).await.is_err() { break; }
                }
            }
            out = to_server_rx.recv() => {
                match out {
                    Some(bytes) => if sink.send(Message::binary(bytes)).await.is_err() { break; },
                    None => break,
                }
            }
            inc = stream.next() => {
                match inc {
                    Some(Ok(Message::Binary(b))) => on_server_message(b.as_ref(), cfg, state, creds_store, to_server_tx, to_sup_tx, &tunnels).await,
                    // WS 上只有 binary message；收到 text/其它帧类型说明对端协议版本不对——
                    // 丢弃并记日志，不 panic（与解码失败的处理原则一致）。
                    Some(Ok(Message::Text(_))) => eprintln!("[worker] 忽略非 binary 的 WS 消息（协议已切换为 protobuf binary）"),
                    Some(Ok(Message::Ping(p))) => { let _ = sink.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
    // 断线即作废：无论是否已登记，本连接申请过的授权链接都不再有效——清掉落盘的 pending-auth.json，
    // 避免 cofluxd 一直展示一个已经失效的链接（server 侧的 pending token 由 handleDaemonClose 摘除）。
    creds_store.clear_pending_auth();
    // WS 断线：全部隧道连接关闭、状态清零（不跨重连恢复，见函数开头注释）
    tunnels.close_all();
}

async fn on_server_message(
    bytes: &[u8],
    cfg: &Arc<Config>,
    state: &Arc<Mutex<WorkerState>>,
    creds_store: &Arc<CredStore>,
    to_server_tx: &Sender<WsOut>,
    to_sup_tx: &Sender<Vec<u8>>,
    tunnels: &tunnel::TunnelSet,
) {
    let envelope = match wire::ServerToDaemon::decode(bytes) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[worker] 丢弃畸形 ServerToDaemon 信封: {e}");
            return;
        }
    };
    let Some(payload) = envelope.payload else {
        eprintln!("[worker] 丢弃空 payload 的 ServerToDaemon 信封");
        return;
    };
    match payload {
        server_to_daemon::Payload::DaemonEnrolled(wire::DaemonEnrolled { daemon_id, device_token }) => {
            let c = Credentials { server_url: cfg.server_url.clone(), daemon_id: daemon_id.clone(), device_token };
            creds_store.save(&c);
            creds_store.clear_pending_auth(); // 无论是经典 enroll 还是 authorize 兑现来的，都不再是 pending 了
            {
                let mut s = state.lock().unwrap();
                s.credentials = Some(c);
                s.pending_auth_expires_at = None; // 停掉续期检查：已登记后绝不能再发 enrollRequest
            }
            eprintln!("[worker] enrolled {daemon_id}");
            on_authed(state, to_server_tx).await;
        }
        server_to_daemon::Payload::DaemonAuthed(wire::DaemonAuthed { daemon_id }) => {
            eprintln!("[worker] authenticated {daemon_id}");
            on_authed(state, to_server_tx).await;
        }
        server_to_daemon::Payload::DaemonAuthorizePending(wire::DaemonAuthorizePending { url, expires_at }) => {
            // 等待用户在浏览器确认授权；连接保持打开，server 确认后会在同一连接上直接推 DaemonEnrolled
            // （见上），不会走 exit(1)——这是与 DaemonAuthError{needEnroll:false} 致命路径的关键区别。
            eprintln!("[worker] waiting for authorization: {url}");
            creds_store.save_pending_auth(&PendingAuth { url, expires_at });
            state.lock().unwrap().pending_auth_expires_at = Some(expires_at); // 供续期检查用；到期未确认则重发 enrollRequest
        }
        server_to_daemon::Payload::DaemonAuthError(wire::DaemonAuthError { message, need_enroll }) => {
            eprintln!("[worker] auth error: {message}");
            if need_enroll {
                creds_store.clear();
                state.lock().unwrap().credentials = None;
            } else {
                eprintln!("[worker] enrollment key invalid; exiting");
                std::process::exit(1);
            }
        }
        // 工作区清单：更新监视目标；清空分支缓存让下一轮全量比对上报（连接/增删后的对账）
        server_to_daemon::Payload::WorkspaceList(wire::WorkspaceList { workspaces }) => {
            let mut s = state.lock().unwrap();
            s.workspaces = workspaces.into_iter().map(|w| (w.workspace_id, w.path)).collect();
            s.last_branches.clear();
        }
        other => {
            let authed = state.lock().unwrap().authed;
            if authed {
                route_authed(other, cfg, to_server_tx, to_sup_tx, tunnels).await;
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
        send_d2s(to_server_tx, daemon_to_server::Payload::DaemonResync(wire::DaemonResync { sessions })).await;
        force_report_ports(state, to_server_tx).await; // 重连补发端口全量，防 server 重启丢状态
    }
}

async fn route_authed(msg: server_to_daemon::Payload, cfg: &Arc<Config>, to_server_tx: &Sender<WsOut>, to_sup_tx: &Sender<Vec<u8>>, tunnels: &tunnel::TunnelSet) {
    match msg {
        // git（可能慢）→ 派生任务，结果回带
        server_to_daemon::Payload::ProjectValidate(wire::ProjectValidate { request_id, path }) => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let r = git::validate_repo(&path).await;
                send_d2s(&to_server, daemon_to_server::Payload::ProjectValidated(wire::ProjectValidated { request_id, ok: r.ok, repo_path: r.repo_path, branch: r.branch, error: r.error })).await;
            });
        }
        server_to_daemon::Payload::WorktreeAdd(wire::WorktreeAdd { request_id, repo_path, workspace_id, name: _, branch, create_new }) => {
            let to_server = to_server_tx.clone();
            let worktrees_dir = cfg.worktrees_dir.clone();
            tokio::spawn(async move {
                let r = git::add_worktree(&worktrees_dir, &repo_path, &workspace_id, &branch, create_new).await;
                send_d2s(&to_server, daemon_to_server::Payload::WorktreeAdded(wire::WorktreeAdded { request_id, ok: r.ok, path: r.path, branch: r.branch, error: r.error })).await;
            });
        }
        server_to_daemon::Payload::WorktreeRemove(wire::WorktreeRemove { repo_path, worktree_path }) => {
            tokio::spawn(async move { git::remove_worktree(&repo_path, &worktree_path).await });
        }
        // PTY → 转给 supervisor；wire 上 cols/rows 是 uint32，UDS/portable-pty 侧是 u16，钳位收窄。
        server_to_daemon::Payload::SessionCreate(wire::SessionCreate { session_id, task_id, cwd, shell, cols, rows }) => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionCreate { session_id, task_id, cwd, shell, cols: clamp_u16(cols), rows: clamp_u16(rows) }).await;
        }
        server_to_daemon::Payload::SessionReplay(wire::SessionReplay { session_id, request_id }) => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionReplay { session_id, request_id }).await;
        }
        server_to_daemon::Payload::PtyResize(wire::PtyResize { session_id, cols, rows }) => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::PtyResize { session_id, cols: clamp_u16(cols), rows: clamp_u16(rows) }).await;
        }
        server_to_daemon::Payload::SessionClose(wire::SessionClose { session_id }) => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionClose { session_id }).await;
        }
        server_to_daemon::Payload::WorkerUpgrade(wire::WorkerUpgrade { version, url, sha256, signature }) => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::WorkerUpgrade { version, url, sha256, signature }).await;
        }
        // 隧道 → 连接本地端口 / 关闭，字节走 ProxyData payload（main.rs 的 WS 分派处理）
        server_to_daemon::Payload::ProxyOpen(wire::ProxyOpen { conn_id, port }) => {
            tunnels.open(conn_id, clamp_u16(port));
        }
        server_to_daemon::Payload::ProxyClose(wire::ProxyClose { conn_id }) => {
            tunnels.close(&conn_id);
        }
        // exec / fs → 派生任务，结果回带；timeout_ms 是 wire 上的 uint32，run_command 内部用 u64
        server_to_daemon::Payload::ExecRun(wire::ExecRun { request_id, cwd, command, args, env, timeout_ms }) => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let r = ops::run_command(&cwd, &command, &args, &env, timeout_ms.map(u64::from)).await;
                send_d2s(&to_server, daemon_to_server::Payload::ExecResult(wire::ExecResult { request_id, ok: r.ok, exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr, error: r.error })).await;
            });
        }
        server_to_daemon::Payload::FsList(wire::FsList { request_id, root, path }) => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let (ok, entries, error, listed_path) = ops::list_dir(&root, &path).await;
                send_d2s(&to_server, daemon_to_server::Payload::FsListed(wire::FsListed { request_id, ok, entries, error, path: listed_path })).await;
            });
        }
        server_to_daemon::Payload::FsRead(wire::FsRead { request_id, root, path }) => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let (ok, content, error) = ops::read_file_text(&root, &path).await;
                send_d2s(&to_server, daemon_to_server::Payload::FsReadResult(wire::FsReadResult { request_id, ok, content, error })).await;
            });
        }
        server_to_daemon::Payload::FsWrite(wire::FsWrite { request_id, root, path, data, temp }) => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let (ok, written_path, error) = ops::write_file(&root, &path, &data, temp).await;
                send_d2s(&to_server, daemon_to_server::Payload::FsWriteResult(wire::FsWriteResult { request_id, ok, path: written_path, error })).await;
            });
        }
        // 数据面（高频）：pty.input → 转给 supervisor（复用 UDS 内部帧格式，frame.rs 未变，
        // 这条链路本次不动）；proxy.data → 隧道模块按 connId 转发到对应 TCP 连接（不再经过
        // 任何"帧"编解码，protobuf 信封已经是唯一的 wire 表示）。
        server_to_daemon::Payload::PtyInput(wire::PtyInput { session_id, data }) => {
            let frame = encode_frame(&DataFrame::Input { session_id, data });
            let _ = to_sup_tx.send(write_record(&frame)).await;
        }
        server_to_daemon::Payload::ProxyData(wire::ProxyData { conn_id, data }) => {
            tunnels.feed(conn_id, data).await;
        }
        _ => {}
    }
}
