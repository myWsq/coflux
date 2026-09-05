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
mod log_sink;
mod observed;
mod ops;
mod p2p;
mod ports;
mod relay_dial;
mod relay_home;
mod tunnel;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use coflux_protocol::wire::{daemon_to_server, server_to_daemon};
use coflux_protocol::{
    decode_frame, is_frame, wire, write_record, DataFrame, RecordParser, Settings,
    SupervisorToWorker, WorkerToSupervisor, LOCAL_GATEWAY_PORT, SUPERVISOR_SOCK_ENV,
    SUPERVISOR_VERSION_ENV, WORKER_VERSION_ENV,
};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};
use tokio::sync::mpsc::{Receiver, Sender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use conn_state::ConnState;
use creds::{CredStore, Credentials, PendingAuth};
use observed::ObservedState;

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
    /// supervisor/sessiond 是 snapshot epoch 唯一生成者；worker 只缓存并原样转发。
    snapshot_owner_id: String,
    snapshot_epoch: u64,
    /// 最近一次 supervisor resync.list 的 challenge。只有对应快照已排入中心发送队列后，
    /// 才回 resync.applied；断开 supervisor 时作废，防旧连接的 ACK 误判新 worker 健康。
    sup_resync_nonce: Option<String>,
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
    /// 命令终端的日志（plan 074 引入，plan 091 起由中心 prepared 命令终端登记）：taskId -> 日志
    /// 当前段的绝对路径（上一段是 `<path>.1`，见 log_sink）。读终端时优先用它而不是中心
    /// checkpoint——checkpoint 是 2 秒周期的派生缓存，秒级命令的输出根本进不去，而日志是最近
    /// 1-2 MiB 的全量而非一屏。worker 重启（热升级）后此表丢失，read 自动降级回快照/checkpoint。
    agent_logs: HashMap<String, String>,
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

/// 本 worker 向中心宣告的控制面能力名（plan 091）。中心的 MCP 写 tools 在发送任何本片新增的
/// 控制消息前按它做门禁，不比较版本号（dev/测试上报 `builtin`，自动升级也不做 semver）。
/// 旧 worker 对未知 ServerToDaemon 载荷静默丢弃，没有门禁 agent 会白等到超时。
/// 能力名是协议契约的一部分：新增控制消息时同步加名字，并与 apps/server 的常量保持一致。
const CAPABILITY_PREPARED_EXECUTE: &str = "prepared_execute";
const CAPABILITY_TERMINAL_IO: &str = "terminal_io";
/// 认识 ServerAgentRequest 的 terminal_notify / terminal_progress 分支（plan 093）：中心的
/// `notify_user` / `report_progress` 只对宣告了它的 daemon 下发。
const CAPABILITY_AGENT_ANNOTATE: &str = "agent_annotate";

fn daemon_capabilities() -> Vec<String> {
    vec![
        CAPABILITY_PREPARED_EXECUTE.to_string(),
        CAPABILITY_TERMINAL_IO.to_string(),
        CAPABILITY_AGENT_ANNOTATE.to_string(),
    ]
}

#[derive(Clone)]
struct PendingResync {
    revision: u64,
    claimed_by: Option<u64>,
    snapshot_owner_id: String,
    snapshot_epoch: u64,
    sessions: Vec<wire::SessionRef>,
    nonce: Option<String>,
}

#[derive(Clone)]
struct ResyncDelivery {
    revision: u64,
    connection_epoch: u64,
    snapshot_owner_id: String,
    snapshot_epoch: u64,
    sessions: Vec<wire::SessionRef>,
    nonce: Option<String>,
}

#[derive(Default)]
struct ResyncOutbox {
    next_revision: AtomicU64,
    pending: Mutex<Option<PendingResync>>,
    notify: tokio::sync::Notify,
}

impl ResyncOutbox {
    /// 只能从 WorkerState mutex 内的 current supervisor 快照发布。调用方不能先 clone
    /// snapshot、释放锁再 publish，否则认证续体可能在较新的 ResyncList 之后写回旧值。
    fn publish_current(&self, state: &Arc<Mutex<WorkerState>>) -> bool {
        let state = state.lock().unwrap();
        let Some((owner_id, epoch, sessions, nonce)) = resync_after_auth(
            state.sup_synced,
            &state.snapshot_owner_id,
            state.snapshot_epoch,
            &state.alive,
            state.sup_resync_nonce.as_deref(),
        ) else {
            return false;
        };
        // state guard 刻意持有到 outbox 更新完成，使 ResyncList 的 state 更新与 publish、
        // 认证重放三者共享同一全序。
        self.publish(owner_id, epoch, sessions, nonce);
        true
    }

    fn publish(
        &self,
        snapshot_owner_id: String,
        snapshot_epoch: u64,
        sessions: Vec<wire::SessionRef>,
        nonce: Option<String>,
    ) {
        let revision = self
            .next_revision
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        *self.pending.lock().unwrap() = Some(PendingResync {
            revision,
            claimed_by: None,
            snapshot_owner_id,
            snapshot_epoch,
            sessions,
            nonce,
        });
        self.notify.notify_one();
    }

    async fn claim(&self, connection_epoch: u64) -> ResyncDelivery {
        loop {
            let notified = self.notify.notified();
            let delivery = {
                let mut pending = self.pending.lock().unwrap();
                pending.as_mut().and_then(|entry| {
                    if entry.claimed_by == Some(connection_epoch) {
                        return None;
                    }
                    entry.claimed_by = Some(connection_epoch);
                    Some(ResyncDelivery {
                        revision: entry.revision,
                        connection_epoch,
                        snapshot_owner_id: entry.snapshot_owner_id.clone(),
                        snapshot_epoch: entry.snapshot_epoch,
                        sessions: entry.sessions.clone(),
                        nonce: entry.nonce.clone(),
                    })
                })
            };
            if let Some(delivery) = delivery {
                return delivery;
            }
            notified.await;
        }
    }

    fn acknowledge(&self, delivery: &ResyncDelivery) -> bool {
        let mut pending = self.pending.lock().unwrap();
        let matches = pending.as_ref().is_some_and(|entry| {
            entry.revision == delivery.revision
                && entry.claimed_by == Some(delivery.connection_epoch)
        });
        if matches {
            pending.take();
        }
        matches
    }
}

fn env_or(key: &str, default: String) -> String {
    std::env::var(key).unwrap_or(default)
}

/// 毫秒阈值类配置的取值：env 覆盖（非法/缺失则用默认值）。目前只用于黑盒测试驱动
/// watchdog/connect-timeout 路径，故不进 settings.json（YAGNI，见 plan 033 决策）。
fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn env_u16(key: &str, default: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
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
    alive
        .iter()
        .map(|(s, (t, _pid))| wire::SessionRef {
            session_id: s.clone(),
            task_id: t.clone(),
        })
        .collect()
}

/// 中心每次认证成功都要用最近一次 supervisor 快照对账；challenge 只决定本次对账后是否
/// 额外向 supervisor 回健康 ACK，不能反过来成为 daemon.resync 的发送条件。
fn resync_after_auth(
    sup_synced: bool,
    snapshot_owner_id: &str,
    snapshot_epoch: u64,
    alive: &HashMap<String, (String, i32)>,
    pending_nonce: Option<&str>,
) -> Option<(String, u64, Vec<wire::SessionRef>, Option<String>)> {
    sup_synced.then(|| {
        (
            snapshot_owner_id.to_string(),
            snapshot_epoch,
            alive_to_resync(alive),
            pending_nonce.map(str::to_owned),
        )
    })
}

/// 把一个 DaemonToServer payload 套上信封、prost 编码，送进 to_server 通道（WS binary message）。
pub(crate) async fn send_d2s(tx: &Sender<WsOut>, payload: daemon_to_server::Payload) -> bool {
    let env = wire::DaemonToServer {
        payload: Some(payload),
    };
    tx.send(env.encode_to_vec()).await.is_ok()
}

/// UDS 热路径不得等待中心队列。慢/断中心时可以丢弃派生上行，sessiond PTY 与 local channel
/// 必须继续推进；catalog/checkpoint 会在恢复后重新对账。
pub(crate) fn try_send_d2s(tx: &Sender<WsOut>, payload: daemon_to_server::Payload) -> bool {
    let env = wire::DaemonToServer {
        payload: Some(payload),
    };
    tx.try_send(env.encode_to_vec()).is_ok()
}

fn announce_local_gateway(
    state: &Arc<Mutex<WorkerState>>,
    auth: Option<&Arc<local_auth::LocalAuth>>,
    to_server_tx: &Sender<WsOut>,
) {
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
            daemon_to_server::Payload::LocalGatewayAnnounce(wire::LocalGatewayAnnounce {
                gateway: Some(auth.descriptor(port)),
            }),
        );
    }
}
async fn sup_ctrl(tx: &Sender<Vec<u8>>, msg: &WorkerToSupervisor) -> bool {
    if let Ok(bytes) = serde_json::to_vec(msg) {
        if let Ok(record) = write_record(&bytes) {
            return tx.send(record).await.is_ok();
        }
    }
    false
}

/// clamp：wire 上 cols/rows/port 是 uint32，内部 PTY/隧道 API 用 u16——收窄时钳位而非截断环绕。
fn clamp_u16(v: u32) -> u16 {
    v.min(u16::MAX as u32) as u16
}

/// 周期(2s)扫描每个存活会话的进程树监听端口；变化才发全量（会话退出/端口关闭在下一轮
/// 扫描中自然从集合里消失，无需特判）。扫描本身是同步阻塞 IO(/proc 读或 libproc 系统调
/// 用)，用 spawn_blocking 挪出 async 执行器，避免卡住 tokio 工作线程。
async fn report_ports_if_changed(
    state: &Arc<Mutex<WorkerState>>,
    observed: &ObservedState,
    to_server_tx: &Sender<WsOut>,
) {
    if let Some(report) = observed
        .ports_if_changed(|| state.lock().unwrap().alive.clone())
        .await
    {
        // report 持有 ports lane 直到 enqueue 完成，保证旧快照不能晚于新快照入队。
        if send_d2s(
            to_server_tx,
            daemon_to_server::Payload::PortsUpdate(report.value().clone()),
        )
        .await
        {
            report.acknowledge();
        }
    }
}

/// 重连认证成功后无条件补发一次当前端口全量，防 server 重启丢状态（daemon 侧视角没有
/// 变化也要发，这与周期任务「变化才发」的逻辑是两回事，故不复用 report_ports_if_changed）。
async fn force_report_ports(
    state: &Arc<Mutex<WorkerState>>,
    observed: &ObservedState,
    to_server_tx: &Sender<WsOut>,
) {
    if let Some(report) = observed
        .force_ports(|| state.lock().unwrap().alive.clone())
        .await
    {
        if try_send_d2s(
            to_server_tx,
            daemon_to_server::Payload::PortsUpdate(report.value().clone()),
        ) {
            report.acknowledge();
        }
    }
}

/// 周期(2s)扫描每个存活会话进程树内的 agent CLI（plan 073）+ 合并 hook 回合状态；变化才发
/// 全量。扫描同端口探测一样是同步阻塞 IO（/proc 读或 libproc/sysctl 系统调用），
/// spawn_blocking 挪出执行器。hook 事件被接受后也会立即触发一次（不等下个周期）。
pub(crate) async fn report_agents_if_changed(
    state: &Arc<Mutex<WorkerState>>,
    observed: &ObservedState,
    to_server_tx: &Sender<WsOut>,
) {
    if let Some(report) = observed
        .agents_if_changed(|| state.lock().unwrap().alive.clone())
        .await
    {
        if try_send_d2s(
            to_server_tx,
            daemon_to_server::Payload::SessionAgents(report.value().clone()),
        ) {
            report.acknowledge();
        }
    }
}

/// 重连认证成功后无条件补发一次 agent presence 全量：server 侧是内存 presence，
/// 重启即丢，语义同 force_report_ports。
async fn force_report_agents(
    state: &Arc<Mutex<WorkerState>>,
    observed: &ObservedState,
    to_server_tx: &Sender<WsOut>,
) {
    if let Some(report) = observed
        .force_agents(|| state.lock().unwrap().alive.clone())
        .await
    {
        if try_send_d2s(
            to_server_tx,
            daemon_to_server::Payload::SessionAgents(report.value().clone()),
        ) {
            report.acknowledge();
        }
    }
}

/// hook 事件消费：pid（信使进程，仍存活——响应发出前它不退出）反查落在哪个存活会话的
/// 进程树内，命中则记录回合状态并立即触发一次 presence 上报。找不到 = coflux 之外启动的
/// agent，静默 404（信使侧本来就静默）。
async fn consume_hook_events(
    mut hook_rx: tokio::sync::mpsc::Receiver<hook::HookRequest>,
    state: Arc<Mutex<WorkerState>>,
    observed: Arc<ObservedState>,
    to_server_tx: Sender<WsOut>,
) {
    while let Some(request) = hook_rx.recv().await {
        let Some(hook_state) = hook::event_state(
            &request.event,
            &request.notification,
            request.background_tasks,
        ) else {
            let _ = request.respond.send(hook::HookOutcome::Ignored);
            continue;
        };
        let alive = { state.lock().unwrap().alive.clone() };
        let (pid, ppid) = (request.pid, request.ppid);
        let session_id =
            tokio::task::spawn_blocking(move || agents::session_of_pid(&alive, pid, ppid))
                .await
                .ok()
                .flatten();
        let Some(session_id) = session_id else {
            let _ = request.respond.send(hook::HookOutcome::SessionNotFound);
            continue;
        };
        eprintln!(
            "[worker] hook event agent={} event={} notification={} bg={} state={hook_state} session={session_id}",
            request.agent, request.event, request.notification, request.background_tasks
        );
        observed.apply_hook_state(session_id, hook_state);
        report_agents_if_changed(&state, &observed, &to_server_tx).await;
        let _ = request.respond.send(hook::HookOutcome::Accepted);
    }
}

fn main() {
    // 日志汇子命令（plan 093）：命令终端的包装脚本以 `coflux-worker --log-sink <log>` 复用本二进制，
    // 在建 tokio 运行时之前分流——它随命令活多久就活多久，不该为它起一整套调度线程。
    if let Some(code) = log_sink::run_if_requested() {
        std::process::exit(code);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("创建 tokio 运行时失败")
        .block_on(worker_main());
}

async fn worker_main() {
    // rustls 0.23 要求在任何 TLS 握手前选定 process-level CryptoProvider，
    // 否则连 wss:// 时 panic（"Could not automatically determine the process-level CryptoProvider"）。
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("安装 rustls ring CryptoProvider 失败");
    let home = env_or(
        "COFLUX_HOME",
        format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()),
    );
    let s = Settings::load(&home); // 用户配置，env 同名变量可覆盖
    let cfg = Arc::new(Config {
        server_url: pick("COFLUX_SERVER", s.server_url, "ws://localhost:8787/daemon"),
        device_name: pick(
            "COFLUX_DEVICE_NAME",
            s.device_name,
            &env_or("HOSTNAME", "coflux-daemon".into()),
        ),
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

    eprintln!(
        "[worker] config server={} device={}",
        cfg.server_url, cfg.device_name
    );

    // 写 pid 文件（测试/运维定位 worker 进程）
    let _ = std::fs::write(format!("{home}/worker.pid"), std::process::id().to_string());

    let creds_store = Arc::new(CredStore::new(cfg.cred_path.clone(), cfg.home.clone()));
    let mut conn_state = ConnState::new(&home);
    conn_state.connecting(); // 进程刚起，尚未连上任何东西
    let credentials = creds_store.load();
    let daemon_id = credentials
        .as_ref()
        .map(|credentials| credentials.daemon_id.clone());
    let state = Arc::new(Mutex::new(WorkerState {
        authed: false,
        sup_synced: false,
        snapshot_owner_id: String::new(),
        snapshot_epoch: 0,
        sup_resync_nonce: None,
        daemon_id,
        gateway_port: None,
        alive: HashMap::new(),
        credentials,
        pending_auth_expires_at: None,
        agent_logs: HashMap::new(),
        workspaces: HashMap::new(),
        last_branches: HashMap::new(),
        last_diffs: HashMap::new(),
        conn_state,
    }));
    let observed = Arc::new(ObservedState::new());

    let (to_server_tx, to_server_rx) = tokio::sync::mpsc::channel::<WsOut>(2048);
    let (to_sup_tx, to_sup_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(2048);
    let (to_sup_priority_tx, to_sup_priority_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
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
    let catalogs = Arc::new(device::CatalogOutbox::default());
    let exits = Arc::new(device::ExitOutbox::default());
    let resyncs = Arc::new(ResyncOutbox::default());
    let device = device::DeviceRuntime::production(
        local_auth.clone(),
        to_sup_tx.clone(),
        to_server_tx.clone(),
        checkpoints.clone(),
        catalogs.clone(),
        exits.clone(),
        state.clone(),
        cfg.clone(),
    );
    // P2P runtime 跨重连存活（plan 076）；每次中心断开 close_all 清空全部 PeerConnection。
    let p2p = p2p::P2pRuntime::new(device.clone(), to_server_tx.clone());

    // hook 事件通道：gateway 收 POST /hook 解析后经此转交，消费侧做 pid→session 反查与上报。
    // gateway 未起（无 local_auth）时 tx 直接掉落，消费任务随之退出。
    let (hook_tx, hook_rx) = tokio::sync::mpsc::channel::<hook::HookRequest>(64);
    tokio::spawn(consume_hook_events(
        hook_rx,
        state.clone(),
        observed.clone(),
        to_server_tx.clone(),
    ));

    let local_endpoints = Arc::new(hook::LocalEndpoints { hook_tx });

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
    {
        let device = device.clone();
        tokio::spawn(async move { device.run_catalog_retry_loop().await });
    }

    // supervisor 连接循环
    {
        let cfg = cfg.clone();
        let state = state.clone();
        let to_server_tx = to_server_tx.clone();
        let resyncs = resyncs.clone();
        let device = device.clone();
        tokio::spawn(async move {
            supervisor_loop(
                cfg,
                state,
                to_server_tx,
                to_sup_priority_rx,
                to_sup_rx,
                resyncs,
                device,
            )
            .await
        });
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
                        .map(|(id, (path, default_branch))| {
                            (id.clone(), path.clone(), default_branch.clone())
                        })
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
                            send_d2s(
                                &to_server_tx,
                                daemon_to_server::Payload::WorkspaceBranch(wire::WorkspaceBranch {
                                    workspace_id: workspace_id.clone(),
                                    branch,
                                }),
                            )
                            .await;
                        }
                    }

                    let stat = git::diff_stat(&path, &default_branch).await;
                    let changed = {
                        let mut s = state.lock().unwrap();
                        if s.last_diffs.get(&workspace_id)
                            == Some(&(stat.additions, stat.deletions))
                        {
                            false
                        } else {
                            s.last_diffs
                                .insert(workspace_id.clone(), (stat.additions, stat.deletions));
                            true
                        }
                    };
                    if changed {
                        send_d2s(
                            &to_server_tx,
                            daemon_to_server::Payload::WorkspaceDiff(wire::WorkspaceDiff {
                                workspace_id,
                                additions: stat.additions,
                                deletions: stat.deletions,
                            }),
                        )
                        .await;
                    }
                }
            }
        });
    }

    // 端口探测（005）：周期扫描每个存活 PTY 会话进程树的监听端口，变化才发全量
    {
        let state = state.clone();
        let observed = observed.clone();
        let to_server_tx = to_server_tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                report_ports_if_changed(&state, &observed, &to_server_tx).await;
                // agent 探测（plan 073）与端口探测同周期：都走一遍进程树，成本同量级
                report_agents_if_changed(&state, &observed, &to_server_tx).await;
            }
        });
    }

    // 优雅关闭
    {
        let home = home.clone();
        tokio::spawn(async move {
            if let Ok(mut sig) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
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
        observed,
        creds_store,
        to_server_tx,
        to_server_rx,
        checkpoints,
        catalogs,
        exits,
        resyncs,
        to_sup_tx,
        to_sup_priority_tx,
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
    mut to_sup_priority_rx: Receiver<Vec<u8>>,
    mut to_sup_rx: Receiver<Vec<u8>>,
    resyncs: Arc<ResyncOutbox>,
    device: Arc<device::DeviceRuntime>,
) {
    loop {
        match UnixStream::connect(&cfg.sock_path).await {
            Ok(stream) => {
                eprintln!("[worker] connected to supervisor");
                device.supervisor_connected();
                run_sup_connection(
                    stream,
                    &state,
                    &to_server_tx,
                    &mut to_sup_priority_rx,
                    &mut to_sup_rx,
                    &resyncs,
                    &device,
                )
                .await;
            }
            Err(_) => {}
        }
        {
            let mut state = state.lock().unwrap();
            state.sup_synced = false;
            state.sup_resync_nonce = None;
        }
        device.supervisor_disconnected();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn run_sup_connection(
    stream: UnixStream,
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &Sender<WsOut>,
    to_sup_priority_rx: &mut Receiver<Vec<u8>>,
    to_sup_rx: &mut Receiver<Vec<u8>>,
    resyncs: &Arc<ResyncOutbox>,
    device: &Arc<device::DeviceRuntime>,
) {
    let (mut rd, mut wr) = stream.into_split();
    let write_timeout = Duration::from_secs(5);
    // 索要存活会话快照
    if let Ok(bytes) = serde_json::to_vec(&WorkerToSupervisor::ResyncRequest) {
        let Ok(record) = write_record(&bytes) else {
            return;
        };
        if !matches!(
            tokio::time::timeout(write_timeout, wr.write_all(&record)).await,
            Ok(Ok(()))
        ) {
            return;
        }
    }

    // UDS 读写必须独立推进：reader 可能等待中心出站队列，server loop 又可能等待本地命令队列；
    // 若唯一的 UDS writer 也绑在 reader 上，两条有界队列同时满会形成环形等待。健康 ACK 走
    // 连接内优先 lane，普通命令仍走跨重连保留的 to_sup_rx。
    let writer = async {
        loop {
            let record = tokio::select! {
                biased;
                record = to_sup_priority_rx.recv() => match record {
                    Some(record) => record,
                    None => return,
                },
                record = to_sup_rx.recv() => match record {
                    Some(record) => record,
                    None => return,
                },
            };
            if !matches!(
                tokio::time::timeout(write_timeout, wr.write_all(&record)).await,
                Ok(Ok(()))
            ) {
                return;
            }
        }
    };
    let reader = async {
        let mut parser = RecordParser::new();
        let mut buf = [0u8; 8192];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    let mut records: Vec<Vec<u8>> = Vec::new();
                    if let Err(error) = parser.push(&buf[..n], |r| records.push(r.to_vec())) {
                        eprintln!("[worker] supervisor UDS record 违规: {error}");
                        return;
                    }
                    for rec in records {
                        handle_sup_record(rec, state, to_server_tx, resyncs, device).await;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = writer => {}
        _ = reader => {}
    }
}

/// 新 supervisor 的 exit 带 pid，可立即按 incarnation 裁决；旧 supervisor 的 pidless
/// exit 同时可能表示“创建失败”。若同 ID 仍在 alive，先保守保留并触发权威 catalog，
/// 防重复 create 的失败回执误删现有 session。
fn commit_supervisor_exit(
    state: &Arc<Mutex<WorkerState>>,
    session_id: &str,
    exited_task_id: Option<&str>,
    exited_pid: Option<i32>,
) -> bool {
    let mut state = state.lock().unwrap();
    if let Some((current_task_id, current_pid)) = state.alive.get(session_id) {
        if exited_task_id != Some(current_task_id.as_str()) || exited_pid != Some(*current_pid) {
            return false;
        }
    }
    state.alive.remove(session_id);
    true
}

async fn handle_sup_record(
    rec: Vec<u8>,
    state: &Arc<Mutex<WorkerState>>,
    to_server_tx: &Sender<WsOut>,
    resyncs: &Arc<ResyncOutbox>,
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
        SupervisorToWorker::SessionStarted {
            session_id,
            task_id,
            pid,
        } => {
            let changed_incarnation = {
                let mut state = state.lock().unwrap();
                let next = (task_id.clone(), pid);
                let changed = state
                    .alive
                    .get(&session_id)
                    .is_some_and(|current| current != &next);
                state.alive.insert(session_id.clone(), next);
                changed
            };
            if changed_incarnation {
                device.session_exited(&session_id);
            }
            device.cancel_session_exit(&session_id);
            device.mark_session_dirty(&session_id);
            try_send_d2s(
                to_server_tx,
                daemon_to_server::Payload::SessionStarted(wire::SessionStarted {
                    session_id,
                    task_id,
                    pid,
                }),
            );
        }
        SupervisorToWorker::SessionExit {
            session_id,
            exit_code,
            task_id,
            pid,
        } => {
            if !commit_supervisor_exit(state, &session_id, task_id.as_deref(), pid) {
                eprintln!(
                    "[worker] session exit identity 待 catalog 对账 session={session_id} task={task_id:?} pid={pid:?}"
                );
                device.request_reconciliation_catalog();
                return;
            }
            // control path 即使没有任何 Device subscriber 也必须释放 channel cursor、
            // checkpoint 与 agent IO 影子；完整 catalog 也会对丢失/legacy exit 兜底。
            device.session_exited(&session_id);
            device.report_session_exit(&session_id, exit_code);
            device.request_reconciliation_catalog();
        }
        SupervisorToWorker::SessionCreateFailed {
            session_id,
            task_id,
            error,
        } => {
            eprintln!(
                "[worker] session create failed without exit session={session_id} task={task_id}: {error}"
            );
            // 新 supervisor 用独立 variant 避免旧 worker 把 duplicate create failure 当退出；
            // 新 worker 同样只对账，不按裸 sessionId 改 alive 或上报 SessionExit。
            device.request_reconciliation_catalog();
        }
        SupervisorToWorker::ResyncList {
            nonce,
            snapshot_owner_id,
            snapshot_epoch,
            sessions,
        } => {
            let next_alive = sessions
                .iter()
                .map(|session| {
                    (
                        session.session_id.clone(),
                        (session.task_id.clone(), session.pid),
                    )
                })
                .collect::<HashMap<_, _>>();
            let changed_or_removed = {
                let mut s = state.lock().unwrap();
                let changed = s
                    .alive
                    .iter()
                    .filter(|(session_id, identity)| next_alive.get(*session_id) != Some(*identity))
                    .map(|(session_id, _)| session_id.clone())
                    .collect::<Vec<_>>();
                s.alive = next_alive;
                s.sup_synced = true;
                s.sup_resync_nonce = (!nonce.is_empty()).then_some(nonce);
                s.snapshot_owner_id = snapshot_owner_id.clone();
                s.snapshot_epoch = snapshot_epoch;
                changed
            };
            for session_id in changed_or_removed {
                device.session_exited(&session_id);
            }
            for session in &sessions {
                device.cancel_session_exit(&session.session_id);
                device.mark_session_dirty(&session.session_id);
            }
            eprintln!("[worker] supervisor resync count={}", sessions.len());
            resyncs.publish_current(state);
            device.request_reconciliation_catalog();
        }
    }
}

/* ------------------------------- server ------------------------------- */

fn backoff(attempts: u32, cfg: &Config) -> Duration {
    let base = cfg
        .reconnect_base_ms
        .saturating_mul(1u64 << attempts.min(20))
        .min(cfg.reconnect_cap_ms)
        .max(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(base / 2 + (nanos % (base / 2 + 1))) // base*(0.5..1.0)
}

async fn send_server_ws(
    sink: &mut futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>,
    message: Message,
    timeout: Duration,
) -> bool {
    matches!(
        tokio::time::timeout(timeout, sink.send(message)).await,
        Ok(Ok(()))
    )
}

async fn server_loop(
    cfg: Arc<Config>,
    state: Arc<Mutex<WorkerState>>,
    observed: Arc<ObservedState>,
    creds_store: Arc<CredStore>,
    to_server_tx: Sender<WsOut>,
    mut to_server_rx: Receiver<WsOut>,
    checkpoints: Arc<device::CheckpointOutbox>,
    catalogs: Arc<device::CatalogOutbox>,
    exits: Arc<device::ExitOutbox>,
    resyncs: Arc<ResyncOutbox>,
    to_sup_tx: Sender<Vec<u8>>,
    to_sup_priority_tx: Sender<Vec<u8>>,
    local_auth: Option<Arc<local_auth::LocalAuth>>,
    device: Arc<device::DeviceRuntime>,
    relay_home: relay_home::RelayHomeSelector,
    p2p: Arc<p2p::P2pRuntime>,
) {
    let mut attempts: u32 = 0;
    let mut connection_epoch = 0u64;
    loop {
        // home 是单条 control WS 的 presence；每次重连先清空，等新清单重新探测并上报。
        relay_home.clear();
        // 黑洞网络下 TCP/TLS/WS 握手可能永久挂起（无 RST/FIN、无错误返回）——connect_async
        // 本身也要包超时，否则这是第二个永久挂死路径（idle watchdog 只覆盖"连上之后"）。
        match tokio::time::timeout(
            Duration::from_millis(cfg.connect_timeout_ms),
            connect_async(&cfg.server_url),
        )
        .await
        {
            Ok(Ok((ws, _))) => {
                eprintln!("[worker] connected to server");
                attempts = 0;
                connection_epoch = connection_epoch.saturating_add(1).max(1);
                run_server_connection(
                    ws,
                    &cfg,
                    &state,
                    &observed,
                    &creds_store,
                    &to_server_tx,
                    &mut to_server_rx,
                    &checkpoints,
                    &catalogs,
                    &exits,
                    &resyncs,
                    connection_epoch,
                    &to_sup_tx,
                    &to_sup_priority_tx,
                    local_auth.as_ref(),
                    &device,
                    &relay_home,
                    &p2p,
                )
                .await;
            }
            Ok(Err(e)) => eprintln!("[worker] server connect error: {e}"),
            Err(_) => eprintln!(
                "[worker] server connect timeout ({}ms)",
                cfg.connect_timeout_ms
            ),
        }
        {
            let mut state = state.lock().unwrap();
            state.authed = false;
            state.conn_state.reconnecting();
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
    observed: &Arc<ObservedState>,
    creds_store: &Arc<CredStore>,
    to_server_tx: &Sender<WsOut>,
    to_server_rx: &mut Receiver<WsOut>,
    checkpoints: &Arc<device::CheckpointOutbox>,
    catalogs: &Arc<device::CatalogOutbox>,
    exits: &Arc<device::ExitOutbox>,
    resyncs: &Arc<ResyncOutbox>,
    connection_epoch: u64,
    to_sup_tx: &Sender<Vec<u8>>,
    to_sup_priority_tx: &Sender<Vec<u8>>,
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
            capabilities: daemon_capabilities(),
        }),
        None => daemon_to_server::Payload::DaemonEnrollRequest(wire::DaemonEnrollRequest {
            name: cfg.device_name.clone(),
            host: cfg.host.clone(),
            platform: cfg.platform.clone(),
            worker_version: cfg.worker_version.clone(),
            supervisor_version: cfg.supervisor_version.clone(),
            arch: cfg.arch.clone(),
            capabilities: daemon_capabilities(),
        }),
    };
    let init_bytes = (wire::DaemonToServer {
        payload: Some(init),
    })
    .encode_to_vec();
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
                        capabilities: daemon_capabilities(),
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
            delivery = resyncs.claim(connection_epoch), if connection_authed => {
                let payload = daemon_to_server::Payload::DaemonResync(wire::DaemonResync {
                    sessions: delivery.sessions.clone(),
                    snapshot_owner_id: delivery.snapshot_owner_id.clone(),
                    snapshot_epoch: delivery.snapshot_epoch,
                });
                let bytes = (wire::DaemonToServer { payload: Some(payload) }).encode_to_vec();
                if !send_server_ws(&mut sink, Message::binary(bytes), write_timeout).await {
                    break;
                }
                if resyncs.acknowledge(&delivery) {
                    if let Some(nonce) = delivery.nonce {
                        let current = {
                            let s = state.lock().unwrap();
                            s.snapshot_owner_id == delivery.snapshot_owner_id
                                && s.snapshot_epoch == delivery.snapshot_epoch
                                && s.sup_resync_nonce.as_deref() == Some(nonce.as_str())
                        };
                        if current {
                            if !sup_ctrl(to_sup_priority_tx, &WorkerToSupervisor::ResyncApplied { nonce: nonce.clone() }).await {
                                break;
                            }
                            let mut s = state.lock().unwrap();
                            if s.sup_resync_nonce.as_deref() == Some(&nonce) {
                                s.sup_resync_nonce = None;
                            }
                        }
                    }
                    // server 重启后 catalog/sessions 都是空的；派生观测若先发会因无法校验
                    // session 归属而被丢弃。只有当前连接成功发送并认领了这份 resync，才按
                    // wire 顺序补发 ports/agent 全量。旧连接代际或被新快照替代的 delivery
                    // acknowledge=false，不得拿旧 alive 触发 force。
                    force_report_ports(state, observed, to_server_tx).await;
                    force_report_agents(state, observed, to_server_tx).await;
                }
            }
            delivery = checkpoints.claim(connection_epoch), if connection_authed => {
                if !send_server_ws(&mut sink, Message::binary(delivery.bytes.clone()), write_timeout).await {
                    break;
                }
                checkpoints.acknowledge(&delivery);
            }
            delivery = catalogs.claim(connection_epoch), if connection_authed => {
                if !send_server_ws(&mut sink, Message::binary(delivery.bytes.clone()), write_timeout).await {
                    break;
                }
                catalogs.acknowledge(&delivery);
            }
            delivery = exits.claim(connection_epoch), if connection_authed => {
                if !send_server_ws(&mut sink, Message::binary(delivery.bytes.clone()), write_timeout).await {
                    break;
                }
                exits.acknowledge(&delivery);
            }
            inc = stream.next() => {
                // 任意入站帧（含 Ping/Pong/Close）都证明链路活着：无条件刷新 idle 计时、
                // 撤销待定的探活判死——哪怕最终这一帧是 Close，也不影响，反正下面立即 break。
                if let Some(Ok(_)) = &inc {
                    last_inbound = Instant::now();
                    ping_pending_since = None;
                }
                match inc {
                    Some(Ok(Message::Binary(b))) => {
                        on_server_message(
                            b.as_ref(),
                            cfg,
                            state,
                            observed,
                            creds_store,
                            to_server_tx,
                            to_sup_tx,
                            &tunnels,
                            local_auth,
                            device,
                            relay_home,
                            p2p,
                            resyncs,
                        ).await;
                    }
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
    observed: &Arc<ObservedState>,
    creds_store: &Arc<CredStore>,
    to_server_tx: &Sender<WsOut>,
    to_sup_tx: &Sender<Vec<u8>>,
    tunnels: &tunnel::TunnelSet,
    local_auth: Option<&Arc<local_auth::LocalAuth>>,
    device: &Arc<device::DeviceRuntime>,
    relay_home: &relay_home::RelayHomeSelector,
    p2p: &Arc<p2p::P2pRuntime>,
    resyncs: &Arc<ResyncOutbox>,
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
        server_to_daemon::Payload::DaemonEnrolled(wire::DaemonEnrolled {
            daemon_id,
            device_token,
        }) => {
            let c = Credentials {
                server_url: cfg.server_url.clone(),
                daemon_id: daemon_id.clone(),
                device_token,
            };
            creds_store.save(&c);
            creds_store.clear_pending_auth(); // 授权兑现后不再是 pending 了
            let daemon_changed = {
                let mut s = state.lock().unwrap();
                let changed = s
                    .daemon_id
                    .as_deref()
                    .is_some_and(|current| current != daemon_id);
                s.credentials = Some(c);
                s.daemon_id = Some(daemon_id.clone());
                s.pending_auth_expires_at = None; // 停掉续期检查：已登记后绝不能再发 enrollRequest
                changed
            };
            if daemon_changed {
                device.close_local_channels();
            }
            eprintln!("[worker] enrolled {daemon_id}");
            on_authed(state, to_server_tx, local_auth, device, resyncs).await;
        }
        server_to_daemon::Payload::DaemonAuthed(wire::DaemonAuthed { daemon_id }) => {
            eprintln!("[worker] authenticated {daemon_id}");
            let daemon_changed = {
                let mut state = state.lock().unwrap();
                let changed = state
                    .daemon_id
                    .as_deref()
                    .is_some_and(|current| current != daemon_id);
                state.daemon_id = Some(daemon_id);
                changed
            };
            if daemon_changed {
                device.close_local_channels();
            }
            on_authed(state, to_server_tx, local_auth, device, resyncs).await;
        }
        server_to_daemon::Payload::DaemonAuthorizePending(wire::DaemonAuthorizePending {
            url,
            expires_at,
        }) => {
            // 等待用户在浏览器确认授权；连接保持打开，server 确认后会在同一连接上直接推 DaemonEnrolled
            // （见上），不会走 exit(1)——这是与 DaemonAuthError{needEnroll:false} 致命路径的关键区别。
            eprintln!("[worker] waiting for authorization: {url}");
            creds_store.save_pending_auth(&PendingAuth { url, expires_at });
            state.lock().unwrap().pending_auth_expires_at = Some(expires_at); // 供续期检查用；到期未确认则重发 enrollRequest
        }
        server_to_daemon::Payload::DaemonAuthError(wire::DaemonAuthError {
            message,
            need_enroll,
        }) => {
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
                s.workspaces = workspaces
                    .into_iter()
                    .map(|w| (w.workspace_id, (w.path, w.default_branch)))
                    .collect();
                s.last_branches.clear();
                s.last_diffs.clear();
                // default_branch 为空 = 目录工作区（无 repo 终端），不参与探测（同 3s 轮询的过滤）
                s.workspaces
                    .iter()
                    .filter(|(_, (_, default_branch))| !default_branch.is_empty())
                    .map(|(id, (path, default_branch))| {
                        (id.clone(), path.clone(), default_branch.clone())
                    })
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
                                daemon_to_server::Payload::WorkspaceDefaultBranch(
                                    wire::WorkspaceDefaultBranch {
                                        workspace_id,
                                        default_branch: detected,
                                    },
                                ),
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
                    server_to_daemon::Payload::LocalGatewayConfigure(
                        wire::LocalGatewayConfigure { origins },
                    ) => {
                        if let Some(auth) = local_auth {
                            if let Err(error) = auth.configure_origins(origins) {
                                eprintln!("[worker] local gateway origin 配置被拒: {error}");
                            } else {
                                device.revalidate_local_origins();
                            }
                        }
                    }
                    server_to_daemon::Payload::LocalGrantInstall(wire::LocalGrantInstall {
                        request_id,
                        grant,
                    }) => {
                        let grant_id = grant
                            .as_ref()
                            .map_or_else(String::new, |grant| grant.grant_id.clone());
                        let daemon_id = state.lock().unwrap().daemon_id.clone();
                        let result = match (local_auth, grant, daemon_id) {
                            (Some(auth), Some(grant), Some(daemon_id)) => {
                                auth.install_grant(grant, &daemon_id)
                            }
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
                    server_to_daemon::Payload::LocalGrantRevoke(wire::LocalGrantRevoke {
                        request_id,
                        grant_id,
                    }) => {
                        let result = local_auth.map_or_else(
                            || Err("local gateway 已禁用".into()),
                            |auth| auth.revoke_grant(&grant_id),
                        );
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
                    server_to_daemon::Payload::LocalLeaseInstall(wire::LocalLeaseInstall {
                        lease,
                    }) => {
                        let daemon_id = state.lock().unwrap().daemon_id.clone();
                        let result = match (local_auth, lease, daemon_id) {
                            (Some(auth), Some(lease), Some(daemon_id)) => {
                                auth.install_lease(lease, &daemon_id)
                            }
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
                        relay_dial::spawn(
                            device.clone(),
                            dial,
                            cfg.connect_timeout_ms,
                            relay_home.clone(),
                        );
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
                    server_to_daemon::Payload::SessionCatalogRequest(request) => {
                        device.request_server_catalog(request)
                    }
                    server_to_daemon::Payload::ExitAck(request) => {
                        device.acknowledge_exits(request)
                    }
                    server_to_daemon::Payload::PreparedDeviceOperation(operation) => {
                        let installed = device.install_prepared_operation(operation);
                        try_send_d2s(
                            to_server_tx,
                            daemon_to_server::Payload::PreparedDeviceOperationInstalled(installed),
                        );
                    }
                    // 中心触发已安装 prepared 操作的执行（plan 091）：同一条 dispatch，结果经
                    // DeviceOperationReport 回中心；重复 Execute 幂等（见 execute_prepared_operation）。
                    server_to_daemon::Payload::PreparedDeviceOperationExecute(execute) => {
                        device.execute_prepared_operation(&execute.operation_id);
                    }
                    // 中心发起的终端读/写/标注（plan 091 + 093）：读日志/快照、经 agent_send_input 正门
                    // 写入、或给 presence 打 notify/progress 标注（含一次进程树探测），可能等 sessiond 回执
                    // （最长 5s），另开 task 以免阻塞消息循环；每条必回一条 result。
                    server_to_daemon::Payload::ServerAgentRequest(request) => {
                        let device = device.clone();
                        let state = state.clone();
                        let observed = observed.clone();
                        let to_server = to_server_tx.clone();
                        tokio::spawn(async move {
                            let result = agent_ctl::handle_server_request(
                                request,
                                &state,
                                &observed,
                                &device,
                                &to_server,
                            )
                            .await;
                            try_send_d2s(
                                &to_server,
                                daemon_to_server::Payload::ServerAgentResult(result),
                            );
                        });
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
    resyncs: &Arc<ResyncOutbox>,
) {
    {
        let mut s = state.lock().unwrap();
        s.authed = true;
        s.conn_state.connected();
    }
    if let Some(auth) = local_auth {
        auth.set_server_online(true);
    }
    announce_local_gateway(state, local_auth, to_server_tx);
    device.server_authenticated();
    // 两级 resync：拿到 supervisor 快照后才发布；派生观测要等它成功送达并被当前连接
    // acknowledge 后再 force，保证 server 已先恢复 session 归属。
    resyncs.publish_current(state);
}

async fn route_authed(
    msg: server_to_daemon::Payload,
    cfg: &Arc<Config>,
    to_server_tx: &Sender<WsOut>,
    to_sup_tx: &Sender<Vec<u8>>,
    tunnels: &tunnel::TunnelSet,
) {
    match msg {
        // git（可能慢）→ 派生任务，结果回带
        server_to_daemon::Payload::ProjectValidate(wire::ProjectValidate { request_id, path }) => {
            let to_server = to_server_tx.clone();
            tokio::spawn(async move {
                let r = git::validate_repo(&path).await;
                send_d2s(
                    &to_server,
                    daemon_to_server::Payload::ProjectValidated(wire::ProjectValidated {
                        request_id,
                        ok: r.ok,
                        repo_path: r.repo_path,
                        branch: r.branch,
                        error: r.error,
                        suggested_name: r.suggested_name,
                    }),
                )
                .await;
            });
        }
        server_to_daemon::Payload::WorktreeAdd(wire::WorktreeAdd {
            request_id,
            repo_path,
            workspace_id,
            name: _,
            branch,
            create_new,
        }) => {
            let to_server = to_server_tx.clone();
            let worktrees_dir = cfg.worktrees_dir.clone();
            tokio::spawn(async move {
                let r = git::add_worktree(
                    &worktrees_dir,
                    &repo_path,
                    &workspace_id,
                    &branch,
                    create_new,
                )
                .await;
                send_d2s(
                    &to_server,
                    daemon_to_server::Payload::WorktreeAdded(wire::WorktreeAdded {
                        request_id,
                        ok: r.ok,
                        path: r.path,
                        branch: r.branch,
                        error: r.error,
                    }),
                )
                .await;
            });
        }
        server_to_daemon::Payload::WorktreeRemove(wire::WorktreeRemove {
            repo_path,
            worktree_path,
        }) => {
            tokio::spawn(async move {
                let _ = git::remove_worktree(&repo_path, &worktree_path).await;
            });
        }
        // PTY → 转给 supervisor；wire 上 cols/rows 是 uint32，UDS/portable-pty 侧是 u16，钳位收窄。
        // 会话归属 id（plan 092）原样映射到 IPC：空串视为中心没下发，不序列化，旧 supervisor 零感知。
        server_to_daemon::Payload::SessionCreate(wire::SessionCreate {
            session_id,
            task_id,
            cwd,
            shell,
            cols,
            rows,
            workspace_id,
            project_id,
            daemon_id,
            mcp_url,
        }) => {
            let non_empty = |value: String| (!value.is_empty()).then_some(value);
            sup_ctrl(
                to_sup_tx,
                &WorkerToSupervisor::SessionCreate {
                    session_id,
                    task_id,
                    cwd,
                    shell,
                    cols: clamp_u16(cols),
                    rows: clamp_u16(rows),
                    workspace_id: non_empty(workspace_id),
                    project_id: non_empty(project_id),
                    daemon_id: non_empty(daemon_id),
                    mcp_url: non_empty(mcp_url),
                },
            )
            .await;
        }
        server_to_daemon::Payload::SessionClose(wire::SessionClose { session_id }) => {
            sup_ctrl(to_sup_tx, &WorkerToSupervisor::SessionClose { session_id }).await;
        }
        server_to_daemon::Payload::WorkerUpgrade(wire::WorkerUpgrade {
            version,
            url,
            sha256,
            signature,
            target,
            artifact_size,
            release_signature,
        }) => {
            sup_ctrl(
                to_sup_tx,
                &WorkerToSupervisor::WorkerUpgrade {
                    version,
                    url,
                    sha256,
                    signature,
                    target,
                    artifact_size,
                    release_signature,
                },
            )
            .await;
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
                            if let Ok(mut f) = std::fs::File::options()
                                .write(true)
                                .truncate(true)
                                .open(&settings_path)
                            {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn resync_test_state() -> Arc<Mutex<WorkerState>> {
        Arc::new(Mutex::new(WorkerState {
            authed: false,
            sup_synced: true,
            snapshot_owner_id: "owner-old".into(),
            snapshot_epoch: 1,
            sup_resync_nonce: Some("nonce-old".into()),
            daemon_id: None,
            gateway_port: None,
            alive: HashMap::from([("session-old".into(), ("task-old".into(), 11))]),
            credentials: None,
            pending_auth_expires_at: None,
            agent_logs: HashMap::new(),
            workspaces: HashMap::new(),
            last_branches: HashMap::new(),
            last_diffs: HashMap::new(),
            conn_state: ConnState::new("/tmp/coflux-resync-unit-test"),
        }))
    }

    #[test]
    fn session_exit只接受当前_task与_pid且旧协议歧义交给_catalog() {
        let state = resync_test_state();

        assert!(
            !commit_supervisor_exit(&state, "session-old", None, None),
            "旧 supervisor 的 pidless exit 可能是 duplicate create failure，不能误删"
        );
        assert!(state.lock().unwrap().alive.contains_key("session-old"));

        assert!(
            !commit_supervisor_exit(&state, "session-old", Some("task-new"), Some(11)),
            "PID 即使复用，task incarnation 不匹配也必须拒绝"
        );
        assert!(
            !commit_supervisor_exit(&state, "session-old", Some("task-old"), Some(22)),
            "同 task 的旧 PID 也必须拒绝"
        );
        assert!(state.lock().unwrap().alive.contains_key("session-old"));

        assert!(commit_supervisor_exit(
            &state,
            "session-old",
            Some("task-old"),
            Some(11),
        ));
        assert!(!state.lock().unwrap().alive.contains_key("session-old"));

        assert!(
            commit_supervisor_exit(&state, "never-started", None, None),
            "alive 中不存在的 pidless exit 可作为创建失败上报"
        );
    }

    #[test]
    fn 中心重连在健康_nonce_已消费后仍发送_resync() {
        let alive = HashMap::from([("session-1".to_string(), ("task-1".to_string(), 42))]);

        let first = resync_after_auth(true, "owner-1", 7, &alive, Some("challenge"))
            .expect("已有 supervisor 快照");
        assert_eq!(first.0, "owner-1");
        assert_eq!(first.1, 7);
        assert_eq!(
            first.3.as_deref(),
            Some("challenge"),
            "首次对账同时回候选健康 ACK"
        );

        let reconnect = resync_after_auth(true, "owner-1", 7, &alive, None)
            .expect("nonce 消费后中心重连仍须对账");
        assert!(reconnect.3.is_none(), "已消费的 challenge 不应重复 ACK");
        assert_eq!(reconnect.2.len(), 1);
        assert_eq!(reconnect.2[0].session_id, "session-1");
        assert_eq!(reconnect.2[0].task_id, "task-1");
    }

    #[test]
    fn 未取得_supervisor_快照时不向中心发送空_resync() {
        assert!(
            resync_after_auth(false, "owner-1", 7, &HashMap::new(), Some("challenge")).is_none()
        );
    }

    #[test]
    fn 延迟认证续体重新读取_current快照且不能覆盖较新_supervisor_resync() {
        let state = resync_test_state();
        let outbox = ResyncOutbox::default();
        let stale_auth_snapshot = {
            let state = state.lock().unwrap();
            resync_after_auth(
                state.sup_synced,
                &state.snapshot_owner_id,
                state.snapshot_epoch,
                &state.alive,
                state.sup_resync_nonce.as_deref(),
            )
            .unwrap()
        };
        assert_eq!(stale_auth_snapshot.0, "owner-old");

        {
            let mut state = state.lock().unwrap();
            state.snapshot_owner_id = "owner-new".into();
            state.snapshot_epoch = 2;
            state.sup_resync_nonce = Some("nonce-new".into());
            state.alive = HashMap::from([("session-new".into(), ("task-new".into(), 22))]);
        }
        assert!(outbox.publish_current(&state));
        // 模拟旧实现中在 supervisor 更新后才恢复的 auth continuation；它只能重新从
        // WorkerState mutex 内读取 current，不能拿先前复制的 stale_auth_snapshot 发布。
        assert!(outbox.publish_current(&state));

        let pending = outbox.pending.lock().unwrap();
        let pending = pending.as_ref().unwrap();
        assert_eq!(pending.snapshot_owner_id, "owner-new");
        assert_eq!(pending.snapshot_epoch, 2);
        assert_eq!(pending.nonce.as_deref(), Some("nonce-new"));
        assert_eq!(pending.sessions.len(), 1);
        assert_eq!(pending.sessions[0].session_id, "session-new");
    }

    #[tokio::test]
    async fn resync_outbox只重放最新authority且旧连接不能确认新值() {
        let outbox = ResyncOutbox::default();
        outbox.publish("owner-a".into(), 1, vec![], Some("nonce-a".into()));
        let old = outbox.claim(1).await;
        outbox.publish("owner-b".into(), 1, vec![], Some("nonce-b".into()));
        assert!(
            !outbox.acknowledge(&old),
            "被新 authority 替代的 delivery 不得越过 resync/force gate"
        );
        let current = outbox.claim(2).await;
        assert_eq!(current.snapshot_owner_id, "owner-b");
        assert_eq!(current.nonce.as_deref(), Some("nonce-b"));
        assert!(
            outbox.acknowledge(&current),
            "只有当前 authority 可以触发后续派生观测 force"
        );
    }

    #[tokio::test]
    async fn resync_outbox发送失败后由新连接代际重放同一快照() {
        let outbox = ResyncOutbox::default();
        outbox.publish(
            "owner-a".into(),
            9,
            vec![wire::SessionRef {
                session_id: "session-1".into(),
                task_id: "task-1".into(),
            }],
            Some("nonce-a".into()),
        );

        let failed_connection = outbox.claim(10).await;
        let replayed = outbox.claim(11).await;
        assert_eq!(replayed.revision, failed_connection.revision);
        assert_eq!(replayed.snapshot_owner_id, "owner-a");
        assert_eq!(replayed.snapshot_epoch, 9);
        assert_eq!(replayed.sessions, failed_connection.sessions);
        assert_eq!(replayed.nonce, failed_connection.nonce);
        assert!(
            !outbox.acknowledge(&failed_connection),
            "失败连接的 delivery 不得触发派生观测 force"
        );
        assert!(
            outbox.acknowledge(&replayed),
            "新连接成功重放后才允许触发派生观测 force"
        );
    }
}
