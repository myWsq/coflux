//! worker —— 承载除 PTY 外的全部：连服务器(WS) + 认证 + git + exec + fs + 编排。
//!
//! PTY 操作经 UDS 转给 supervisor。两级 resync：先拿到 supervisor 存活快照(supSynced)，
//! 再向 server resync（否则空列表 resync 会让 server 误标 exited，随后真 resync 反触发 session.close 杀 PTY）。
//! 全 Rust 化后整个 daemon 无 node 运行时依赖。

mod agent_ctl;
mod agents;
mod conn_state;
mod creds;
mod device;
mod gateway;
mod git;
mod hook;
mod local_auth;
mod ops;
mod p2p;
mod ports;
mod relay_dial;
mod relay_home;
mod tunnel;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use coflux_protocol::{
    decode_frame, is_frame, wire, write_record, DataFrame, RecordParser, Settings, SessionInfo, SupervisorToWorker, WorkerToSupervisor, SUPERVISOR_SOCK_ENV,
    LOCAL_GATEWAY_PORT, SUPERVISOR_VERSION_ENV, WORKER_VERSION_ENV,
};
use coflux_protocol::wire::{daemon_to_server, server_to_daemon};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};
use tokio::sync::mpsc::{Receiver, Sender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use conn_state::ConnState;
use creds::{CredStore, Credentials, PendingAuth};

#[derive(Clone)]
struct Config {
    server_url: String,
    device_name: String,
    host: String,
    platform: String,
    /// 热更新编排（plan 015）：worker 完全不知自身版本——纯 supervisor 侧概念，每次 spawn 经
    /// env 告知（见 crates/supervisor/src/manager.rs 的 WORKER_VERSION_ENV/SUPERVISOR_VERSION_ENV）。
    /// 握手消息原样携带，供 server 比对 + web 展示。
    worker_version: String,
    supervisor_version: String,
    arch: String,
    home: String,
    cred_path: String,
    worktrees_dir: String,
    sock_path: String,
    reconnect_base_ms: u64,
    reconnect_cap_ms: u64,
    /// 入站帧 idle 达此阈值 → 主动发 WS Ping 探活（半死连接自愈，plan 033）。
    idle_ping_ms: u64,
    /// 探活 Ping 发出后再等这么久仍无任何入站帧 → 判定连接已死，断开走 backoff 重连。
    idle_grace_ms: u64,
    /// connect_async 本身的超时——黑洞网络下 TCP/TLS/WS 握手可能永久挂起，必须有限时失败。
    connect_timeout_ms: u64,
    /// loopback gateway 固定端口；0 仅供 dev/test 申请临时端口。
    local_gateway_port: u16,
}

struct WorkerState {
    authed: bool,
    sup_synced: bool,
    /// 当前中心登记身份；本地 gateway challenge 与 operation report 都从可信凭证/认证消息取得，
    /// 不接受 browser 自报 daemonId。
    daemon_id: Option<String>,
    /// gateway 当前实际监听端口；bind 失败时为 None，但不影响中心 relay。
    gateway_port: Option<u16>,
    alive: HashMap<String, (String, i32)>, // sessionId -> (taskId, pid)
    credentials: Option<Credentials>,
    /// 等待授权中的链接过期时刻（server 侧 epoch ms）。到期且连接仍在、仍未登记时，
    /// 由 run_server_connection 的定时检查重发 daemon.enrollRequest 换新链接。
    pending_auth_expires_at: Option<f64>,
    /// 端口探测(005)上一次实际发出的全量快照:变化才发的比较基准，也是重连补发的缓存。
    last_reported_ports: Vec<wire::SessionPorts>,
    /// agent 探测(plan 073)上一次实际发出的全量快照：语义同 last_reported_ports。
    last_reported_agents: Vec<wire::SessionAgentRef>,
    /// hook 上报的回合状态：sessionId -> active/approval/question/done。进程树 presence 扫描是存活门——
    /// 合并上报时剪掉扫描已不见 agent 的条目（agent 退出/换新时不残留旧状态）。
    hook_states: HashMap<String, &'static str>,
    /// `cofluxd notify` 留给用户的一句话（plan 074）：sessionId -> 消息。与 hook_states 同
    /// 生命周期——任一 hook 事件到达即清掉该 session 的留言（那时 agent 已换了状态，旧留言
    /// 就过期了），presence 扫描不见的会话也一并剪掉。
    hook_messages: HashMap<String, String>,
    /// agent 自建终端的命令日志（plan 074）：taskId -> 日志绝对路径。读终端时优先用它而不是
    /// 中心 checkpoint——checkpoint 是 2 秒周期的派生缓存，秒级命令的输出根本进不去，而日志
    /// 还是全量而非一屏。worker 重启（热升级）后此表丢失，read 自动降级回 checkpoint。
    agent_logs: HashMap<String, String>,
    /// agent 控制请求的在飞关联表（plan 074）：requestId -> 中心回执的接收端。
    /// 断开中心连接时整表清空——发送端 drop 会让等待方立刻拿到「连接中断」而不是干等超时。
    agent_pending: HashMap<String, tokio::sync::oneshot::Sender<wire::AgentControlResult>>,
    /// server 下发的本设备工作区清单：workspace_id -> (worktree 路径, 所属 project 的 default_branch)
    /// （分支监视 + diff 统计基准用）
    workspaces: HashMap<String, (String, String)>,
    /// 上次上报的分支：workspace_id -> branch。收到新清单时清空，下一轮全量比对上报（重连对账）
    last_branches: HashMap<String, String>,
    /// 上次上报的 diff 统计：workspace_id -> (additions, deletions)。收到新清单时清空，同上
    last_diffs: HashMap<String, (i32, i32)>,
    /// 连接状态落盘快照（conn-state.json），供 cofluxd status 展示真实在线态（plan 033）。
    conn_state: ConnState,
}

/// 出站到 server 的消息：WS 上只有 binary message，一条 = 一个已编码好的 protobuf 信封字节串
/// （[wire::DaemonToServer] 编码结果）。不再区分文本/二进制——旧 JSON 控制帧与自定义二进制
/// 数据帧统一收敛成这一种。
pub(crate) type WsOut = Vec<u8>;

fn env_or(key: &str, default: String) -> String {
    std::env::var(key).unwrap_or(default)
}

/// 毫秒阈值类配置的取值：env 覆盖（非法/缺失则用默认值）。目前只用于黑盒测试驱动
/// watchdog/connect-timeout 路径，故不进 settings.json（YAGNI，见 plan 033 决策）。
fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

fn env_u16(key: &str, default: u16) -> u16 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
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

/// UDS 热路径不得等待中心队列。慢/断中心时可以丢弃派生上行，sessiond PTY 与 local channel
/// 必须继续推进；catalog/checkpoint 会在恢复后重新对账。
pub(crate) fn try_send_d2s(tx: &Sender<WsOut>, payload: daemon_to_server::Payload) {
    let env = wire::DaemonToServer { payload: Some(payload) };
    let _ = tx.try_send(env.encode_to_vec());
}

fn announce_local_gateway(state: &Arc<Mutex<WorkerState>>, auth: Option<&Arc<local_auth::LocalAuth>>, to_server_tx: &Sender<WsOut>) {
    let Some(auth) = auth else { return };
    let port = {
        let state = state.lock().unwrap();
        if !state.authed {
            return;
        }
        state.gateway_port
    };
    if let Some(port) = port {
        try_send_d2s(
            to_server_tx,
            daemon_to_server::Payload::LocalGatewayAnnounce(wire::LocalGatewayAnnounce { gateway: Some(auth.descriptor(port)) }),
        );
    }
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
    try_send_d2s(to_server_tx, daemon_to_server::Payload::PortsUpdate(wire::PortsUpdate { sessions }));
}

/// 扫描结果与 hook 回合状态合并（锁内调用）：presence 扫描是存活门，hook_states 里
/// 扫描已不见 agent 的会话被剪掉——agent 退出/换新后不残留旧状态；扫到的条目回填 state。
fn merge_hook_states(s: &mut WorkerState, mut sessions: Vec<wire::SessionAgentRef>) -> Vec<wire::SessionAgentRef> {
    s.hook_states.retain(|session_id, _| sessions.iter().any(|entry| entry.session_id == *session_id));
    s.hook_messages.retain(|session_id, _| sessions.iter().any(|entry| entry.session_id == *session_id));
    for entry in &mut sessions {
        if let Some(hook_state) = s.hook_states.get(&entry.session_id) {
            entry.state = (*hook_state).to_string();
        }
        if let Some(message) = s.hook_messages.get(&entry.session_id) {
            entry.message = message.clone();
        }
    }
    sessions
}

/// 周期(2s)扫描每个存活会话进程树内的 agent CLI（plan 073）+ 合并 hook 回合状态；变化才发
/// 全量。扫描同端口探测一样是同步阻塞 IO（/proc 读或 libproc/sysctl 系统调用），
/// spawn_blocking 挪出执行器。hook 事件被接受后也会立即触发一次（不等下个周期）。
pub(crate) async fn report_agents_if_changed(state: &Arc<Mutex<WorkerState>>, to_server_tx: &Sender<WsOut>) {
    let alive = { state.lock().unwrap().alive.clone() }; // 取快照即释放锁，不跨扫描 await 持锁
    let sessions = match tokio::task::spawn_blocking(move || agents::detect_session_agents(&alive)).await {
        Ok(s) => s,
        Err(_) => return, // 扫描任务 panic：静默跳过这一轮，不影响主循环
    };
    let changed = {
        let mut s = state.lock().unwrap();
        let sessions = merge_hook_states(&mut s, sessions);
        if s.last_reported_agents == sessions {
            None
        } else {
            s.last_reported_agents = sessions.clone();
            Some(sessions)
        }
    };
    if let Some(sessions) = changed {
        try_send_d2s(to_server_tx, daemon_to_server::Payload::SessionAgents(wire::SessionAgents { sessions }));
    }
}

/// 重连认证成功后无条件补发一次 agent presence 全量：server 侧是内存 presence，
/// 重启即丢，语义同 force_report_ports。
async fn force_report_agents(state: &Arc<Mutex<WorkerState>>, to_server_tx: &Sender<WsOut>) {
    let alive = { state.lock().unwrap().alive.clone() };
    let sessions = match tokio::task::spawn_blocking(move || agents::detect_session_agents(&alive)).await {
        Ok(s) => s,
        Err(_) => return,
    };
    let sessions = {
        let mut s = state.lock().unwrap();
        let sessions = merge_hook_states(&mut s, sessions);
        s.last_reported_agents = sessions.clone();
        sessions
    };
    try_send_d2s(to_server_tx, daemon_to_server::Payload::SessionAgents(wire::SessionAgents { sessions }));
}

/// hook 事件消费：pid（信使进程，仍存活——响应发出前它不退出）反查落在哪个存活会话的
/// 进程树内，命中则记录回合状态并立即触发一次 presence 上报。找不到 = coflux 之外启动的
/// agent，静默 404（信使侧本来就静默）。
async fn consume_hook_events(
    mut hook_rx: tokio::sync::mpsc::Receiver<hook::HookRequest>,
    state: Arc<Mutex<WorkerState>>,
    to_server_tx: Sender<WsOut>,
) {
    while let Some(request) = hook_rx.recv().await {
        let Some(hook_state) = hook::event_state(&request.event, &request.notification, request.background_tasks) else {
            let _ = request.respond.send(hook::HookOutcome::Ignored);
            continue;
        };
        let alive = { state.lock().unwrap().alive.clone() };
        let (pid, ppid) = (request.pid, request.ppid);
        let session_id = tokio::task::spawn_blocking(move || agents::session_of_pid(&alive, pid, ppid)).await.ok().flatten();
        let Some(session_id) = session_id else {
            let _ = request.respond.send(hook::HookOutcome::SessionNotFound);
            continue;
        };
        eprintln!(
            "[worker] hook event agent={} event={} notification={} bg={} state={hook_state} session={session_id}",
            request.agent, request.event, request.notification, request.background_tasks
        );
        {
            // hook 事件到达 = agent 已经换了状态，上一条 notify 留言就此过期（plan 074）。
            let mut s = state.lock().unwrap();
            s.hook_states.insert(session_id.clone(), hook_state);
            s.hook_messages.remove(&session_id);
        }
        report_agents_if_changed(&state, &to_server_tx).await;
        let _ = request.respond.send(hook::HookOutcome::Accepted);
    }
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
        device_name: pick("COFLUX_DEVICE_NAME", s.device_name, &env_or("HOSTNAME", "coflux-daemon".into())),
        host: env_or("HOSTNAME", "localhost".into()),
        platform: std::env::consts::OS.to_string(),
        worker_version: env_or(WORKER_VERSION_ENV, "builtin".into()),
        supervisor_version: env_or(SUPERVISOR_VERSION_ENV, "dev".into()),
        arch: std::env::consts::ARCH.to_string(),
        cred_path: format!("{home}/credentials.json"),
        worktrees_dir: format!("{home}/worktrees"),
        sock_path: std::env::var(SUPERVISOR_SOCK_ENV).unwrap_or_default(),
        home: home.clone(),
        reconnect_base_ms: 1_000,
        reconnect_cap_ms: 30_000,
        // 75s = 2.5 × server 心跳周期（COFLUX_HEARTBEAT_MS 默认 30_000，见 apps/server/src/config.ts）：
        // 正常连接每 ≤30s 必收到 server Ping，误伤概率可忽略。均可 env 覆盖，供黑盒测试秒级驱动。
        idle_ping_ms: env_u64("COFLUX_IDLE_PING_MS", 75_000),
        idle_grace_ms: env_u64("COFLUX_IDLE_GRACE_MS", 10_000),
        connect_timeout_ms: env_u64("COFLUX_CONNECT_TIMEOUT_MS", 15_000),
        local_gateway_port: env_u16("COFLUX_LOCAL_GATEWAY_PORT", LOCAL_GATEWAY_PORT),
    });
    if cfg.sock_path.is_empty() {
        eprintln!("[worker] 缺少 {SUPERVISOR_SOCK_ENV}");
        std::process::exit(1);
    }

    eprintln!("[worker] config server={} device={}", cfg.server_url, cfg.device_name);

    // 写 pid 文件（测试/运维定位 worker 进程）
    let _ = std::fs::write(format!("{home}/worker.pid"), std::process::id().to_string());

    let creds_store = Arc::new(CredStore::new(cfg.cred_path.clone(), cfg.home.clone()));
    let mut conn_state = ConnState::new(&home);
    conn_state.connecting(); // 进程刚起，尚未连上任何东西
    let credentials = creds_store.load();
    let daemon_id = credentials.as_ref().map(|credentials| credentials.daemon_id.clone());
    let state = Arc::new(Mutex::new(WorkerState {
        authed: false,
        sup_synced: false,
        daemon_id,
        gateway_port: None,
        alive: HashMap::new(),
        credentials,
        pending_auth_expires_at: None,
        last_reported_ports: Vec::new(),
        last_reported_agents: Vec::new(),
        hook_states: HashMap::new(),
        hook_messages: HashMap::new(),
        agent_logs: HashMap::new(),
        agent_pending: HashMap::new(),
        workspaces: HashMap::new(),
        last_branches: HashMap::new(),
        last_diffs: HashMap::new(),
        conn_state,
    }));

    let (to_server_tx, to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(2048);
    let (to_sup_tx, to_sup_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(2048);
    let relay_home = relay_home::RelayHomeSelector::spawn(
        to_server_tx.clone(),
        Duration::from_millis(env_u64("COFLUX_RELAY_PROBE_INTERVAL_MS", 60_000).max(50)),
        Duration::from_millis(env_u64("COFLUX_RELAY_PROBE_TIMEOUT_MS", 3_000).max(50)),
    );

    // gateway 身份损坏/不可写只关闭 direct；中心 relay 与既有 daemon 能力照常启动。
    let local_auth = match local_auth::LocalAuth::load_or_create(&home) {
        Ok(auth) => Some(Arc::new(auth)),
        Err(error) => {
            eprintln!("[worker] local gateway disabled: {error}");
            None
        }
    };
    let checkpoints = Arc::new(device::CheckpointOutbox::default());
    let device = device::DeviceRuntime::production(
        local_auth.clone(),
        to_sup_tx.clone(),
        to_server_tx.clone(),
        checkpoints.clone(),
        state.clone(),
        cfg.clone(),
    );
    // P2P runtime 跨重连存活（plan 076）；每次中心断开 close_all 清空全部 PeerConnection。
    let p2p = p2p::P2pRuntime::new(device.clone(), to_server_tx.clone());

    // hook 事件通道：gateway 收 POST /hook 解析后经此转交，消费侧做 pid→session 反查与上报。
    // gateway 未起（无 local_auth）时 tx 直接掉落，消费任务随之退出。
    let (hook_tx, hook_rx) = tokio::sync::mpsc::channel::<hook::HookRequest>(64);
    tokio::spawn(consume_hook_events(hook_rx, state.clone(), to_server_tx.clone()));

    // agent 控制通道（plan 074）：同为 gateway 的 loopback POST 路径，但走独立消费任务——
    // terminal.* 要等中心回执（最长 20s），不能和 hook 的短回合状态上报挤同一条队列。
    let (agent_tx, agent_rx) = tokio::sync::mpsc::channel::<agent_ctl::AgentRequest>(64);
    tokio::spawn(agent_ctl::consume_agent_requests(agent_rx, state.clone(), to_server_tx.clone(), device.clone()));
    let local_endpoints = Arc::new(hook::LocalEndpoints { hook_tx, agent_tx });

    // gateway 监听独立于中心 server_loop；热升级时旧 worker 短暂占端口会在后台重试。
    if let Some(auth) = local_auth.clone() {
        let daemon_state = state.clone();
        let status_state = state.clone();
        let status_auth = auth.clone();
        let status_server = to_server_tx.clone();
        let requested_port = cfg.local_gateway_port;
        let device_runtime = device.clone();
        tokio::spawn(gateway::run(
            requested_port,
            auth,
            device_runtime,
            Arc::new(move || daemon_state.lock().unwrap().daemon_id.clone()),
            Arc::new(move |port| {
                status_state.lock().unwrap().gateway_port = port;
                announce_local_gateway(&status_state, Some(&status_auth), &status_server);
            }),
            local_endpoints,
        ));
    }

    {
        let device = device.clone();
        tokio::spawn(async move { device.run_checkpoint_loop().await });
    }

    // supervisor 连接循环
    {
        let cfg = cfg.clone();
        let state = state.clone();
        let to_server_tx = to_server_tx.clone();
        let device = device.clone();
        tokio::spawn(async move { supervisor_loop(cfg, state, to_server_tx, to_sup_rx, device).await });
    }

    // 分支监视 + diff 统计（plan 024）：worktree HEAD 是分支的真相源（纯文件读，无子进程）；
    // diff 统计基准是 merge-base(default_branch, HEAD)（git 子进程 + untracked 文件读，见
    // git::diff_stat）。同一 3s 周期内一并处理，变化才上报，满足 ≤5s 轮询间隔的约束。
    {
        let state = state.clone();
        let to_server_tx = to_server_tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let targets: Vec<(String, String, String)> = {
                    let s = state.lock().unwrap();
                    if !s.authed {
                        continue;
                    }
                    s.workspaces
                        .iter()
                        // default_branch 为空 = 目录工作区（无 repo 终端），跳过 git 轮询：
                        // 即使目录恰好在某个 git 仓库内（如 dotfiles 管理的 HOME）也不该上报 branch/diff
                        .filter(|(_, (_, default_branch))| !default_branch.is_empty())
                        .map(|(id, (path, default_branch))| (id.clone(), path.clone(), default_branch.clone()))
                        .collect()
                };
                for (workspace_id, path, default_branch) in targets {
                    if let Some(branch) = git::current_branch(&path) {
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
                            send_d2s(&to_server_tx, daemon_to_server::Payload::WorkspaceBranch(wire::WorkspaceBranch { workspace_id: workspace_id.clone(), branch })).await;
                        }
                    }

                    let stat = git::diff_stat(&path, &default_branch).await;
                    let changed = {
                        let mut s = state.lock().unwrap();
                        if s.last_diffs.get(&workspace_id) == Some(&(stat.additions, stat.deletions)) {
                            false
                        } else {
                            s.last_diffs.insert(workspace_id.clone(), (stat.additions, stat.deletions));
                            true
                        }
                    };
                    if changed {
                        send_d2s(&to_server_tx, daemon_to_server::Payload::WorkspaceDiff(wire::WorkspaceDiff { workspace_id, additions: stat.additions, deletions: stat.deletions })).await;
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
                // agent 探测（plan 073）与端口探测同周期：都走一遍进程树，成本同量级
                report_agents_if_changed(&state, &to_server_tx).await;
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
    server_loop(
        cfg,
        state,
        creds_store,
        to_server_tx,
        to_server_rx,
        checkpoints,
        to_sup_tx,
        local_auth,
        device,
        relay_home,
        p2p,
    )
    .await;
}

/* ----------------------------- supervisor ----------------------------- */

async fn supervisor_loop(
    cfg: Arc<Config>,
    state: Arc<Mutex<WorkerState>>,
    to_server_tx: Sender<WsOut>,
    mut to_sup_rx: Receiver<Vec<u8>>,
    device: Arc<device::DeviceRuntime>,
) {
    loop {
        match UnixStream::connect(&cfg.sock_path).await {
            Ok(stream) => {
                eprintln!("[worker] connected to supervisor");
                device.supervisor_connected();
                run_sup_connection(stream, &state, &to_server_tx, &mut to_sup_rx, &device).await;
            }
            Err(_) => {}
        }
        state.lock().unwrap().sup_synced = false;
        device.supervisor_disconnected();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn run_sup_connection(
    stream: UnixStream,
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &Sender<WsOut>,
    to_sup_rx: &mut Receiver<Vec<u8>>,
    device: &Arc<device::DeviceRuntime>,
) {
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
                            handle_sup_record(rec, state, to_server_tx, device);
                        }
                    }
                }
            }
        }
    }
}

fn handle_sup_record(
    rec: Vec<u8>,
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &Sender<WsOut>,
    device: &Arc<device::DeviceRuntime>,
) {
    if is_frame(&rec) {
        // output 只是一条本地 dirty 通知；真实 terminal bytes 仅经 Device channel 交付，
        // 绝不再套 daemon protobuf 信封发往中心。
        match decode_frame(&rec) {
            Some(DataFrame::Output { session_id, .. }) => {
                device.mark_session_dirty(&session_id);
            }
            Some(DataFrame::Device { channel_id, data }) => {
                device.deliver_from_sessiond(&channel_id, &data);
            }
            // ProxyData 不会从 supervisor→worker 方向出现；畸形/已保留帧同样丢弃，不 panic。
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
            try_send_d2s(to_server_tx, daemon_to_server::Payload::SessionStarted(wire::SessionStarted { session_id, task_id, pid }));
        }
        SupervisorToWorker::SessionExit { session_id, exit_code } => {
            state.lock().unwrap().alive.remove(&session_id);
            try_send_d2s(to_server_tx, daemon_to_server::Payload::SessionExit(wire::SessionExit { session_id, exit_code }));
        }
        SupervisorToWorker::ResyncList { sessions } => {
            let authed = {
                let mut s = state.lock().unwrap();
                s.alive.clear();
                for r in &sessions {
                    s.alive.insert(r.session_id.clone(), (r.task_id.clone(), r.pid));
                }
                s.sup_synced = true;
                s.authed
            };
            eprintln!("[worker] supervisor resync count={}", sessions.len());
            if authed {
                // daemon→server 的 daemon.resync 形状已冻结（SessionRef，不含 pid），
                // pid 只在 UDS 快照(SessionInfo)里供本地端口探测（005）用
                let resync: Vec<wire::SessionRef> = sessions.into_iter().map(|s: SessionInfo| wire::SessionRef { session_id: s.session_id, task_id: s.task_id }).collect();
                try_send_d2s(to_server_tx, daemon_to_server::Payload::DaemonResync(wire::DaemonResync { sessions: resync }));
            }
            device.request_reconciliation_catalog();
        }
    }
}

/* ------------------------------- server ------------------------------- */

fn backoff(attempts: u32, cfg: &Config) -> Duration {
    let base = cfg.reconnect_base_ms.saturating_mul(1u64 << attempts.min(20)).min(cfg.reconnect_cap_ms).max(1);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0);
    Duration::from_millis(base / 2 + (nanos % (base / 2 + 1))) // base*(0.5..1.0)
}

async fn send_server_ws(
    sink: &mut futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>,
    message: Message,
    timeout: Duration,
) -> bool {
    matches!(tokio::time::timeout(timeout, sink.send(message)).await, Ok(Ok(())))
}

async fn server_loop(
    cfg: Arc<Config>,
    state: Arc<Mutex<WorkerState>>,
    creds_store: Arc<CredStore>,
    to_server_tx: Sender<WsOut>,
    mut to_server_rx: Receiver<WsOut>,
    checkpoints: Arc<device::CheckpointOutbox>,
    to_sup_tx: Sender<Vec<u8>>,
    local_auth: Option<Arc<local_auth::LocalAuth>>,
    device: Arc<device::DeviceRuntime>,
    relay_home: relay_home::RelayHomeSelector,
    p2p: Arc<p2p::P2pRuntime>,
) {
    let mut attempts: u32 = 0;
    loop {
        // home 是单条 control WS 的 presence；每次重连先清空，等新清单重新探测并上报。
        relay_home.clear();
        // 黑洞网络下 TCP/TLS/WS 握手可能永久挂起（无 RST/FIN、无错误返回）——connect_async
        // 本身也要包超时，否则这是第二个永久挂死路径（idle watchdog 只覆盖"连上之后"）。
        match tokio::time::timeout(Duration::from_millis(cfg.connect_timeout_ms), connect_async(&cfg.server_url)).await {
            Ok(Ok((ws, _))) => {
                eprintln!("[worker] connected to server");
                attempts = 0;
                run_server_connection(
                    ws,
                    &cfg,
                    &state,
                    &creds_store,
                    &to_server_tx,
                    &mut to_server_rx,
                    &checkpoints,
                    &to_sup_tx,
                    local_auth.as_ref(),
                    &device,
                    &relay_home,
                    &p2p,
                )
                .await;
            }
            Ok(Err(e)) => eprintln!("[worker] server connect error: {e}"),
            Err(_) => eprintln!("[worker] server connect timeout ({}ms)", cfg.connect_timeout_ms),
        }
        {
            let mut state = state.lock().unwrap();
            state.authed = false;
            state.conn_state.reconnecting();
            // 在飞的 agent 控制请求随连接一起作废：drop 发送端让等待方立刻拿到「连接中断」，
            // 而不是干等到 20s 超时（plan 074）。
            state.agent_pending.clear();
        }
        if let Some(auth) = &local_auth {
            auth.set_server_online(false);
        }
        device.close_relays();
        p2p.close_all();
        relay_home.clear();
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
    checkpoints: &Arc<device::CheckpointOutbox>,
    to_sup_tx: &Sender<Vec<u8>>,
    local_auth: Option<&Arc<local_auth::LocalAuth>>,
    device: &Arc<device::DeviceRuntime>,
    relay_home: &relay_home::RelayHomeSelector,
    p2p: &Arc<p2p::P2pRuntime>,
) {
    let (mut sink, mut stream) = ws.split();
    let write_timeout = Duration::from_millis(cfg.idle_grace_ms.max(1_000));
    {
        let mut s = state.lock().unwrap();
        s.authed = false;
        s.pending_auth_expires_at = None; // 授权链接与连接同生命周期，新连接从零开始
    }
    if let Some(auth) = local_auth {
        auth.set_server_online(false);
    }
    device.close_relays();
    p2p.close_all();
    // 隧道状态绑定单次 server 连接生命周期：不跨重连恢复（浏览器侧 TCP 早已断，恢复无意义）
    let tunnels = tunnel::TunnelSet::new(to_server_tx.clone());

    // 认证 / 登记：二选一。credentials.json 存在 → daemon.auth 重连；否则走 Tailscale 式
    // daemon.enrollRequest，等 web 端确认后 server 原地推 daemon.enrolled。
    let creds = state.lock().unwrap().credentials.clone();
    let init = match creds {
        Some(c) => daemon_to_server::Payload::DaemonAuth(wire::DaemonAuth {
            device_token: c.device_token,
            worker_version: cfg.worker_version.clone(),
            supervisor_version: cfg.supervisor_version.clone(),
            arch: cfg.arch.clone(),
        }),
        None => daemon_to_server::Payload::DaemonEnrollRequest(wire::DaemonEnrollRequest {
            name: cfg.device_name.clone(),
            host: cfg.host.clone(),
            platform: cfg.platform.clone(),
            worker_version: cfg.worker_version.clone(),
            supervisor_version: cfg.supervisor_version.clone(),
            arch: cfg.arch.clone(),
        }),
    };
    let init_bytes = (wire::DaemonToServer { payload: Some(init) }).encode_to_vec();
    if !send_server_ws(&mut sink, Message::binary(init_bytes), write_timeout).await {
        return;
    }

    // 授权链接续期：TTL 到点而用户还没确认时，server 只是默默摘除内存里的 pending token，
    // 既不通知也不断连——worker 必须自己重发 enrollRequest 换新链接，否则 cofluxd 展示的
    // 永远是死链。1s 粒度的检查对 10min 级 TTL 足够精细。
    let mut renew_tick = tokio::time::interval(Duration::from_secs(1));
    renew_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // idle watchdog（半死连接自愈，plan 033）：公司网络可能静默丢弃连接（无 RST/FIN），
    // server 侧 ping/pong sweep 会摘掉这条连接，但 worker 侧此前没有任何对等机制——
    // stream.next() 会永久 pending。这里记录"最后收到任意入站帧"的时刻：idle 超过阈值先
    // 主动发 WS Ping 探活；再过宽限期仍无任何入站帧（含 Pong）就判死，退出本连接走既有
    // backoff 重连（不是单独等 Pong——任何帧都证明链路活着，见 stream.next 分支）。
    let idle_ping = Duration::from_millis(cfg.idle_ping_ms.max(1));
    let idle_grace = Duration::from_millis(cfg.idle_grace_ms.max(1));
    let mut last_inbound = Instant::now();
    let mut ping_pending_since: Option<Instant> = None;
    // 检查粒度取阈值的 1/5（钳位 20ms~500ms）：足够细以不拖长判死时间，又不空转浪费 CPU。
    let watchdog_tick_ms = (cfg.idle_ping_ms.min(cfg.idle_grace_ms) / 5).clamp(20, 500);
    let mut watchdog_tick = tokio::time::interval(Duration::from_millis(watchdog_tick_ms));
    watchdog_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        // 应用数据只在本条 WS 已认证后发送；重连期间积下的 report/catalog/checkpoint 不能抢在
        // daemon.auth 前面进入 server。
        let connection_authed = state.lock().unwrap().authed;
        tokio::select! {
            _ = watchdog_tick.tick() => {
                if let Some(since) = ping_pending_since {
                    if since.elapsed() >= idle_grace {
                        eprintln!("[worker] 连接 idle 超时（探活 {}ms 内无任何入站帧），判定连接已死，断开重连", idle_grace.as_millis());
                        break;
                    }
                } else if last_inbound.elapsed() >= idle_ping {
                    eprintln!("[worker] 连接 idle {}ms，发送探活 ping", last_inbound.elapsed().as_millis());
                    if !send_server_ws(&mut sink, Message::Ping(Vec::new()), write_timeout).await {
                        break; // 发送本身就失败：连接已经死了，无需再等宽限期
                    }
                    ping_pending_since = Some(Instant::now());
                }
            }
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
                        worker_version: cfg.worker_version.clone(),
                        supervisor_version: cfg.supervisor_version.clone(),
                        arch: cfg.arch.clone(),
                    });
                    let bytes = (wire::DaemonToServer { payload: Some(req) }).encode_to_vec();
                    if !send_server_ws(&mut sink, Message::binary(bytes), write_timeout).await { break; }
                }
            }
            out = to_server_rx.recv(), if connection_authed => {
                match out {
                    Some(bytes) => if !send_server_ws(&mut sink, Message::binary(bytes), write_timeout).await { break; },
                    None => break,
                }
            }
            out = checkpoints.recv(), if connection_authed => {
                if !send_server_ws(&mut sink, Message::binary(out), write_timeout).await { break; }
            }
            inc = stream.next() => {
                // 任意入站帧（含 Ping/Pong/Close）都证明链路活着：无条件刷新 idle 计时、
                // 撤销待定的探活判死——哪怕最终这一帧是 Close，也不影响，反正下面立即 break。
                if let Some(Ok(_)) = &inc {
                    last_inbound = Instant::now();
                    ping_pending_since = None;
                }
                match inc {
                    Some(Ok(Message::Binary(b))) => on_server_message(
                        b.as_ref(),
                        cfg,
                        state,
                        creds_store,
                        to_server_tx,
                        to_sup_tx,
                        &tunnels,
                        local_auth,
                        device,
                        relay_home,
                        p2p,
                    ).await,
                    // WS 上只有 binary message；收到 text/其它帧类型说明对端协议版本不对——
                    // 丢弃并记日志，不 panic（与解码失败的处理原则一致）。
                    Some(Ok(Message::Text(_))) => eprintln!("[worker] 忽略非 binary 的 WS 消息（协议已切换为 protobuf binary）"),
                    Some(Ok(Message::Ping(p))) => {
                        if !send_server_ws(&mut sink, Message::Pong(p), write_timeout).await { break; }
                    }
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
    local_auth: Option<&Arc<local_auth::LocalAuth>>,
    device: &Arc<device::DeviceRuntime>,
    relay_home: &relay_home::RelayHomeSelector,
    p2p: &Arc<p2p::P2pRuntime>,
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
            creds_store.clear_pending_auth(); // 授权兑现后不再是 pending 了
            let daemon_changed = {
                let mut s = state.lock().unwrap();
                let changed = s.daemon_id.as_deref().is_some_and(|current| current != daemon_id);
                s.credentials = Some(c);
                s.daemon_id = Some(daemon_id.clone());
                s.pending_auth_expires_at = None; // 停掉续期检查：已登记后绝不能再发 enrollRequest
                changed
            };
            if daemon_changed {
                device.close_local_channels();
            }
            eprintln!("[worker] enrolled {daemon_id}");
            on_authed(state, to_server_tx, local_auth, device).await;
        }
        server_to_daemon::Payload::DaemonAuthed(wire::DaemonAuthed { daemon_id }) => {
            eprintln!("[worker] authenticated {daemon_id}");
            let daemon_changed = {
                let mut state = state.lock().unwrap();
                let changed = state.daemon_id.as_deref().is_some_and(|current| current != daemon_id);
                state.daemon_id = Some(daemon_id);
                changed
            };
            if daemon_changed {
                device.close_local_channels();
            }
            on_authed(state, to_server_tx, local_auth, device).await;
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
                let mut state = state.lock().unwrap();
                state.credentials = None;
                state.daemon_id = None;
                drop(state);
                device.close_local_channels();
            } else {
                eprintln!("[worker] 不可恢复的认证错误，退出");
                std::process::exit(1);
            }
        }
        // 工作区清单：更新监视目标；清空分支/diff 缓存让下一轮全量比对上报（连接/增删后的对账）
        server_to_daemon::Payload::WorkspaceList(wire::WorkspaceList { workspaces }) => {
            let targets: Vec<(String, String, String)> = {
                let mut s = state.lock().unwrap();
                s.workspaces = workspaces.into_iter().map(|w| (w.workspace_id, (w.path, w.default_branch))).collect();
                s.last_branches.clear();
                s.last_diffs.clear();
                // default_branch 为空 = 目录工作区（无 repo 终端），不参与探测（同 3s 轮询的过滤）
                s.workspaces
                    .iter()
                    .filter(|(_, (_, default_branch))| !default_branch.is_empty())
                    .map(|(id, (path, default_branch))| (id.clone(), path.clone(), default_branch.clone()))
                    .collect()
            };
            // 项目默认分支的真相是本地 origin/HEAD，清单里带的是 server 缓存：不符则上报纠正
            // （plan 072）。探测起 git 子进程，另开 task 以免阻塞消息循环；探测不到（无 remote /
            // 非 clone）不上报，保持现值——空 default_branch 在 worker 侧的语义是"跳过 git 轮询"，
            // 误清会把 diff 统计一起废掉。server 落库后会重推清单，届时值已相同，第二轮即收敛。
            let tx = to_server_tx.clone();
            tokio::spawn(async move {
                for (workspace_id, path, cached) in targets {
                    if let Some(detected) = git::detect_default_branch(&path).await {
                        if detected != cached {
                            send_d2s(
                                &tx,
                                daemon_to_server::Payload::WorkspaceDefaultBranch(wire::WorkspaceDefaultBranch { workspace_id, default_branch: detected }),
                            )
                            .await;
                        }
                    }
                }
            });
        }
        other => {
            let authed = state.lock().unwrap().authed;
            if authed {
                match other {
                    server_to_daemon::Payload::LocalGatewayConfigure(wire::LocalGatewayConfigure { origins }) => {
                        if let Some(auth) = local_auth {
                            if let Err(error) = auth.configure_origins(origins) {
                                eprintln!("[worker] local gateway origin 配置被拒: {error}");
                            } else {
                                device.revalidate_local_origins();
                            }
                        }
                    }
                    server_to_daemon::Payload::LocalGrantInstall(wire::LocalGrantInstall { request_id, grant }) => {
                        let grant_id = grant.as_ref().map_or_else(String::new, |grant| grant.grant_id.clone());
                        let daemon_id = state.lock().unwrap().daemon_id.clone();
                        let result = match (local_auth, grant, daemon_id) {
                            (Some(auth), Some(grant), Some(daemon_id)) => auth.install_grant(grant, &daemon_id),
                            (None, _, _) => Err("local gateway 已禁用".into()),
                            (_, None, _) => Err("grant payload 缺失".into()),
                            (_, _, None) => Err("daemon 尚未登记".into()),
                        };
                        if result.as_ref().is_ok_and(|changed| *changed) && !grant_id.is_empty() {
                            // 同 grantId 的 key/origin 轮换必须让旧 WebSocket 重新证明身份；幂等重装
                            // install_grant 会返回 false，不打断稳定 direct channel。
                            device.revoke_local_grant(&grant_id);
                        }
                        try_send_d2s(
                            to_server_tx,
                            daemon_to_server::Payload::LocalGrantAck(wire::LocalGrantAck {
                                request_id,
                                grant_id,
                                ok: result.is_ok(),
                                error: result.err(),
                            }),
                        );
                    }
                    server_to_daemon::Payload::LocalGrantRevoke(wire::LocalGrantRevoke { request_id, grant_id }) => {
                        let result = local_auth.map_or_else(|| Err("local gateway 已禁用".into()), |auth| auth.revoke_grant(&grant_id));
                        if result.is_ok() {
                            device.revoke_local_grant(&grant_id);
                        }
                        try_send_d2s(
                            to_server_tx,
                            daemon_to_server::Payload::LocalGrantAck(wire::LocalGrantAck {
                                request_id,
                                grant_id,
                                ok: result.is_ok(),
                                error: result.err(),
                            }),
                        );
                    }
                    server_to_daemon::Payload::LocalLeaseInstall(wire::LocalLeaseInstall { lease }) => {
                        let daemon_id = state.lock().unwrap().daemon_id.clone();
                        let result = match (local_auth, lease, daemon_id) {
                            (Some(auth), Some(lease), Some(daemon_id)) => auth.install_lease(lease, &daemon_id),
                            (None, _, _) => Err("local gateway 已禁用".into()),
                            (_, None, _) => Err("lease payload 缺失".into()),
                            (_, _, None) => Err("daemon 尚未登记".into()),
                        };
                        if let Err(error) = result {
                            eprintln!("[worker] local lease 安装被拒: {error}");
                        }
                    }
                    server_to_daemon::Payload::DeviceRelayDial(dial) => {
                        // 拨号失败不另回 channel 结果；立即唤醒 home 重探，client 重试 rendezvous
                        // 时中心就会按新上报的 home 指路。指令本身无效则只在本地拒绝。
                        relay_dial::spawn(device.clone(), dial, cfg.connect_timeout_ms, relay_home.clone());
                    }
                    server_to_daemon::Payload::RelayNodeList(wire::RelayNodeList { nodes }) => {
                        relay_home.set_nodes(nodes);
                    }
                    // P2P 信令（plan 076）：拨号失败经 AnswerReport 回拒因；grant 无对应
                    // 连接时静默丢弃，client 靠 DataChannel open 超时回落 relay。
                    server_to_daemon::Payload::DeviceP2pDial(dial) => {
                        p2p.handle_dial(dial);
                    }
                    server_to_daemon::Payload::DeviceP2pChannelGrant(grant) => {
                        p2p.handle_channel_grant(grant);
                    }
                    // agent 控制回执（plan 074）：按 request_id 找到等待中的 agent_ctl 任务。
                    // 找不到 = 已超时摘除或本就不是本进程发的，静默丢弃。
                    server_to_daemon::Payload::AgentControlResult(result) => {
                        let waiter = state.lock().unwrap().agent_pending.remove(&result.request_id);
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(result);
                        }
                    }
                    server_to_daemon::Payload::SessionCatalogRequest(request) => device.request_server_catalog(request),
                    server_to_daemon::Payload::ExitAck(request) => device.acknowledge_exits(request),
                    server_to_daemon::Payload::PreparedDeviceOperation(operation) => {
                        let installed = device.install_prepared_operation(operation);
                        try_send_d2s(
                            to_server_tx,
                            daemon_to_server::Payload::PreparedDeviceOperationInstalled(installed),
                        );
                    }
                    legacy => route_authed(legacy, cfg, to_server_tx, to_sup_tx, tunnels).await,
                }
            }
        }
    }
}

async fn on_authed(
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &Sender<WsOut>,
    local_auth: Option<&Arc<local_auth::LocalAuth>>,
    device: &Arc<device::DeviceRuntime>,
) {
    let resync = {
        let mut s = state.lock().unwrap();
        s.authed = true;
        s.conn_state.connected();
        if s.sup_synced {
            Some(alive_to_resync(&s.alive))
        } else {
            None
        }
    };
    if let Some(auth) = local_auth {
        auth.set_server_online(true);
    }
    announce_local_gateway(state, local_auth, to_server_tx);
    device.server_authenticated();
    // 两级 resync：拿到 supervisor 快照后才向 server resync；否则待 resync.list 到达时补发
    if let Some(sessions) = resync {
        try_send_d2s(to_server_tx, daemon_to_server::Payload::DaemonResync(wire::DaemonResync { sessions }));
        force_report_ports(state, to_server_tx).await; // 重连补发端口全量，防 server 重启丢状态
        force_report_agents(state, to_server_tx).await; // agent presence 同为 server 内存态，一并补发
    }
}

async fn route_authed(msg: server_to_daemon::Payload, cfg: &Arc<Config>, to_server_tx: &Sender<WsOut>, to_sup_tx: &Sender<Vec<u8>>, tunnels: &tunnel::TunnelSet) {
    match msg {
        // git（可能慢）→ 派生任务，结果回带
        server_to_daemon::Payload::ProjectValidate(wire::ProjectValidate { request_id, path }) => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let r = git::validate_repo(&path).await;
                send_d2s(&to_server, daemon_to_server::Payload::ProjectValidated(wire::ProjectValidated {
                    request_id,
                    ok: r.ok,
                    repo_path: r.repo_path,
                    branch: r.branch,
                    error: r.error,
                    suggested_name: r.suggested_name,
                })).await;
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
            tokio::spawn(async move {
                let _ = git::remove_worktree(&repo_path, &worktree_path).await;
            });
        }
        // PTY → 转给 supervisor；wire 上 cols/rows 是 uint32，UDS/portable-pty 侧是 u16，钳位收窄。
        server_to_daemon::Payload::SessionCreate(wire::SessionCreate { session_id, task_id, cwd, shell, cols, rows }) => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionCreate { session_id, task_id, cwd, shell, cols: clamp_u16(cols), rows: clamp_u16(rows) }).await;
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
        // 中心可见的数据面只剩 proxy.data；terminal 与普通设备 RPC 均走 opaque Device relay。
        server_to_daemon::Payload::ProxyData(wire::ProxyData { conn_id, data }) => {
            tunnels.feed(conn_id, data).await;
        }
        // 设备重命名：patch 本地 settings.json 的 deviceName 字段（plan 018）
        server_to_daemon::Payload::DaemonSetName(wire::DaemonSetName { name }) => {
            let home = cfg.home.clone();
            tokio::spawn(async move {
                let settings_path = format!("{home}/settings.json");
                // 尝试读取现有 settings.json；缺失则跳过（测试/容器环境常见，纯 env 驱动）
                if let Ok(content) = std::fs::read_to_string(&settings_path) {
                    if let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&content) {
                        // patch deviceName 字段（或创建）
                        if let Some(obj) = settings.as_object_mut() {
                            obj.insert("deviceName".to_string(), serde_json::Value::String(name));
                            // 写回文件（跟随现有直接 truncate 写风格）
                            use std::io::Write;
                            if let Ok(mut f) = std::fs::File::options().write(true).truncate(true).open(&settings_path) {
                                let _ = f.write_all(settings.to_string().as_bytes());
                            }
                        }
                    }
                }
            });
        }
        _ => {}
    }
}
