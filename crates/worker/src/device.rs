//! direct/relay 共用的 Device channel runtime。
//!
//! 本模块负责 channel principal、scope 门控、sessiond IPC multiplex 与每 channel 有界投递。
//! git/fs/exec 与 prepared operation handler 在同一 runtime 上继续扩展，transport 不解释业务。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use coflux_protocol::wire::{
    self, daemon_to_server, device_envelope, DeviceEnvelope, DeviceError, DeviceExitAck,
    DeviceP2pChannelGrant, DevicePtyGap, DevicePtyInput, DeviceRelayDial, DeviceScope,
    DeviceSessionAttach, DeviceSessionCatalog, DeviceSessionCatalogRequest,
    DeviceSessionSnapshotRequest, PreparedDeviceOperation, PreparedDeviceOperationInstalled,
    SessionCheckpoint,
};
use coflux_protocol::{
    decode_device_envelope, encode_device_envelope, encode_frame, write_record, DataFrame,
    DEVICE_PROTOCOL_VERSION, MAX_DEVICE_FRAME_BYTES, MAX_FRAME_ID_BYTES,
    MAX_SESSION_CHECKPOINT_BYTES,
};
use prost::Message as _;
use rand_core::{OsRng, RngCore};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::local_auth::{AuthenticatedLocal, LocalAuth, LocalPrincipal};
use crate::{Config, WorkerState, WsOut};

const CHANNEL_QUEUE_RECORDS: usize = 256;
const CHANNEL_QUEUE_BYTES: usize = MAX_DEVICE_FRAME_BYTES + 2 * 1024 * 1024;
// 普通数据面全局最多保留四个满载 channel 的字节；既能容纳至少一条 30 MiB 最大帧，
// 又把 256 个 channel 的理论聚合峰值从约 8 GiB 收敛到 128 MiB。
const GLOBAL_CHANNEL_QUEUE_BYTES: usize = 4 * CHANNEL_QUEUE_BYTES;
const DEVICE_CHANNEL_LIMIT: usize = 256;
const DEVICE_CHANNEL_LIMIT_ERROR: &str = "Device channel 总数已达上限";
// gap 是 worker/sessiond 生成的控制元数据，合法 ID 下远小于 4 KiB。每 channel 独立留一槽，
// 并使用与普通数据分离的全局预算，保证 data 预算耗尽后仍能报告缺口。
const CHANNEL_GAP_FRAME_BYTES: usize = 4 * 1024;
const INTERNAL_CHANNEL_ID: &str = "__coflux-worker";
// agent 写 PTY（plan 088）用的合成 channel 前缀；仍走 sessiond 的
// attach/holder/input_seq 正门，不新增任何输入语义。
const AGENT_CHANNEL_PREFIX: &str = "__coflux-agent-";
// 中心触发 prepared 执行（plan 091）用的合成 channel 前缀：`__coflux-server-<operation_id>`。
// 不注册进 channels 表，往它回的应答按既有逻辑丢弃；只有 OperationAck/Error 经 report 回中心。
// 与 `__coflux-worker` / `__coflux-agent-` 互不重叠，`validate_relay_dial` 对 `__coflux-` 前缀的保留照旧覆盖。
const SERVER_CHANNEL_PREFIX: &str = "__coflux-server-";
// 本 runtime 内已触发执行过的 operation_id 上限；满了整表清空——丢失只意味着重复 Execute 会再问
// 一次 sessiond/worker 账本（它们各自去重），不会二次执行。
const EXECUTED_OPERATION_LIMIT: usize = 4096;
// 中心发起的按需快照读取（ServerTerminalRead 的 snapshot 降级）在飞上限。
const PENDING_SNAPSHOT_READ_LIMIT: usize = 64;
const AGENT_IO_TIMEOUT: Duration = Duration::from_secs(5);
const PENDING_AGENT_IO_LIMIT: usize = 64;
const AGENT_IO_SESSION_LIMIT: usize = 256;
const AGENT_IDENTITY_LIMIT_PER_SESSION: usize = 16;
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(2);
const CALL_LEDGER_LIMIT: usize = 1024;
const CALL_LEDGER_BYTES: usize = 64 * 1024 * 1024;
// pending call 预留一个小型确定错误的缓存空间。这样真实结果装不下时仍能把该次执行
// 收敛成可缓存的终态，不能因账本满而遗忘已经执行过的 operation。
const CALL_LEDGER_RESULT_RESERVE_BYTES: usize = 512;
const PREPARED_LIMIT: usize = 1024;
const PREPARED_BYTES: usize = 32 * 1024 * 1024;
const MAX_PREPARED_FRAME_BYTES: usize = 1024 * 1024;
const OPERATION_REPORT_BYTES: usize = 64 * 1024 * 1024;
const CATALOG_PAGE_BYTES: u32 = 512 * 1024;
const CATALOG_SESSION_LIMIT: usize = 128;
const CATALOG_EXIT_LIMIT: usize = 4096;
const CATALOG_ASSEMBLY_BYTES: usize = 12 * 1024 * 1024;
// client requestId 与单次中心连接同生命周期；总量和聚合 retained bytes 都必须有硬上限。
// 内部对账独占一个固定 key 和独立预算，不能被外部 catalog 请求挤掉。
const CATALOG_EXTERNAL_QUERY_LIMIT: usize = 64;
const CATALOG_EXTERNAL_ASSEMBLY_BYTES: usize = 12 * 1024 * 1024;
// 完整 catalog 的 envelope/repeated-field tag 会略大于组装阶段 retained bytes；32 MiB
// 可同时容纳至少两份最大组装结果，同时把原先 1024 × 12 MiB 的理论峰值压到硬上限内。
const CATALOG_OUTBOX_BYTES: usize = 32 * 1024 * 1024;
const INTERNAL_CATALOG_REQUEST_ID: &str = "__coflux-worker-reconcile";
const CATALOG_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const CATALOG_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);
const EXIT_OUTBOX_LIMIT: usize = CATALOG_EXIT_LIMIT;

struct OutboxEntry {
    revision: u64,
    claimed_by: Option<u64>,
    bytes: WsOut,
}

#[derive(Default)]
struct OutboxState {
    next_revision: u64,
    pending: BTreeMap<String, OutboxEntry>,
    pending_bytes: usize,
}

/// checkpoint/catalog 不进入普通 server control queue：按稳定 key 合并，发送成功前不摘除。
/// claim 绑定物理 WS epoch，旧连接迟到的 ACK 既删不掉新值，也挡不住新连接重放。
pub struct CoalescingOutbox {
    state: Mutex<OutboxState>,
    notify: Notify,
    record_limit: usize,
    byte_limit: usize,
}

#[derive(Clone)]
pub struct OutboxDelivery {
    key: String,
    revision: u64,
    connection_epoch: u64,
    pub bytes: WsOut,
}

impl CoalescingOutbox {
    fn with_limits(record_limit: usize, byte_limit: usize) -> Self {
        Self {
            state: Mutex::new(OutboxState::default()),
            notify: Notify::new(),
            record_limit: record_limit.max(1),
            byte_limit,
        }
    }

    fn publish(&self, key: String, bytes: WsOut) -> bool {
        if bytes.len() > self.byte_limit {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        if let Some(previous) = state.pending.remove(&key) {
            state.pending_bytes = state.pending_bytes.saturating_sub(previous.bytes.len());
        }
        while state.pending.len() >= self.record_limit
            || bytes.len() > self.byte_limit.saturating_sub(state.pending_bytes)
        {
            let Some(oldest_key) = state
                .pending
                .iter()
                .min_by_key(|(_, entry)| entry.revision)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            let removed = state.pending.remove(&oldest_key).unwrap();
            state.pending_bytes = state.pending_bytes.saturating_sub(removed.bytes.len());
        }
        state.next_revision = state.next_revision.saturating_add(1).max(1);
        let revision = state.next_revision;
        state.pending_bytes = state.pending_bytes.saturating_add(bytes.len());
        state.pending.insert(
            key,
            OutboxEntry {
                revision,
                claimed_by: None,
                bytes,
            },
        );
        drop(state);
        self.notify.notify_one();
        true
    }

    fn remove(&self, key: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(removed) = state.pending.remove(key) else {
            return false;
        };
        state.pending_bytes = state.pending_bytes.saturating_sub(removed.bytes.len());
        true
    }

    fn clear(&self) {
        let mut state = self.state.lock().unwrap();
        state.pending.clear();
        state.pending_bytes = 0;
    }

    pub async fn claim(&self, connection_epoch: u64) -> OutboxDelivery {
        loop {
            let notified = self.notify.notified();
            let delivery = {
                let mut state = self.state.lock().unwrap();
                state.pending.iter_mut().find_map(|(key, entry)| {
                    if entry.claimed_by == Some(connection_epoch) {
                        return None;
                    }
                    entry.claimed_by = Some(connection_epoch);
                    Some(OutboxDelivery {
                        key: key.clone(),
                        revision: entry.revision,
                        connection_epoch,
                        bytes: entry.bytes.clone(),
                    })
                })
            };
            if let Some(delivery) = delivery {
                return delivery;
            }
            notified.await;
        }
    }

    pub fn acknowledge(&self, delivery: &OutboxDelivery) -> bool {
        let mut state = self.state.lock().unwrap();
        let matches = state.pending.get(&delivery.key).is_some_and(|entry| {
            entry.revision == delivery.revision
                && entry.claimed_by == Some(delivery.connection_epoch)
        });
        if matches {
            let removed = state.pending.remove(&delivery.key).unwrap();
            state.pending_bytes = state.pending_bytes.saturating_sub(removed.bytes.len());
        }
        matches
    }
}

impl Default for CoalescingOutbox {
    fn default() -> Self {
        Self::with_limits(CALL_LEDGER_LIMIT, usize::MAX)
    }
}

pub type CheckpointOutbox = CoalescingOutbox;

/// 只承载中心显式请求的完整 catalog；内部 reconciliation 不进入该 outbox。
pub struct CatalogOutbox(CoalescingOutbox);

impl Default for CatalogOutbox {
    fn default() -> Self {
        Self(CoalescingOutbox::with_limits(
            CATALOG_EXTERNAL_QUERY_LIMIT,
            CATALOG_OUTBOX_BYTES,
        ))
    }
}

impl CatalogOutbox {
    pub async fn claim(&self, connection_epoch: u64) -> OutboxDelivery {
        self.0.claim(connection_epoch).await
    }

    pub fn acknowledge(&self, delivery: &OutboxDelivery) -> bool {
        self.0.acknowledge(delivery)
    }

    fn publish(&self, request_id: String, bytes: WsOut) -> bool {
        self.0.publish(request_id, bytes)
    }

    fn clear(&self) {
        self.0.clear();
    }
}

/// session.exit 与普通 control queue 分离；同 sessionId 合并，跨 WS 代际重放。
/// 4096 项与 sessiond tombstone 上限对齐；极端离线洪峰即使发生淘汰，下一轮权威
/// catalog 仍会重新发布尚在 tombstone 窗口内的退出。
pub struct ExitOutbox(CoalescingOutbox);

impl Default for ExitOutbox {
    fn default() -> Self {
        Self(CoalescingOutbox::with_limits(EXIT_OUTBOX_LIMIT, usize::MAX))
    }
}

impl ExitOutbox {
    pub async fn claim(&self, connection_epoch: u64) -> OutboxDelivery {
        self.0.claim(connection_epoch).await
    }

    pub fn acknowledge(&self, delivery: &OutboxDelivery) -> bool {
        self.0.acknowledge(delivery)
    }

    fn publish(&self, session_id: String, bytes: WsOut) {
        let _ = self.0.publish(session_id, bytes);
    }

    fn remove(&self, session_id: &str) -> bool {
        self.0.remove(session_id)
    }
}

struct ProductionServices {
    checkpoints: Arc<CheckpointOutbox>,
    catalogs: Arc<CatalogOutbox>,
    exits: Arc<ExitOutbox>,
    state: Arc<Mutex<WorkerState>>,
    cfg: Arc<Config>,
}

#[derive(Default)]
struct CatalogQuery {
    /// sessiond 线上的短生命周期关联 ID；map key 是稳定 logical requestId。
    wire_request_id: String,
    /// 归属的 server WS 认证代际。完整页移出 pending 后仍要带着该 token
    /// 进入提交门，防止旧连接 continuation 跨代修改本地权威状态。
    server_generation: u64,
    snapshot_owner_id: String,
    snapshot_epoch: u64,
    next_session_offset: u32,
    next_exit_offset: u32,
    sessions: Vec<wire::DeviceSessionInfo>,
    exits: Vec<wire::DeviceSessionExitTombstone>,
    retained_bytes: usize,
    sent_at: Option<Instant>,
    rerun: bool,
}

impl CatalogQuery {
    fn new(wire_request_id: String, server_generation: u64) -> Self {
        Self {
            wire_request_id,
            server_generation,
            ..Self::default()
        }
    }
}

#[derive(Default)]
struct CatalogState {
    /// server WS 认证代际；在 catalog_commit_gate 内读写才能作为提交 token。
    server_generation: u64,
    queries: HashMap<String, CatalogQuery>,
    internal_retained_bytes: usize,
    external_retained_bytes: usize,
}

impl CatalogState {
    fn retained_bytes(&self, request_id: &str) -> usize {
        if request_id == INTERNAL_CATALOG_REQUEST_ID {
            self.internal_retained_bytes
        } else {
            self.external_retained_bytes
        }
    }

    fn retained_limit(request_id: &str) -> usize {
        if request_id == INTERNAL_CATALOG_REQUEST_ID {
            CATALOG_ASSEMBLY_BYTES
        } else {
            CATALOG_EXTERNAL_ASSEMBLY_BYTES
        }
    }

    fn remove(&mut self, request_id: &str) -> Option<CatalogQuery> {
        let query = self.queries.remove(request_id)?;
        self.release(request_id, query.retained_bytes);
        Some(query)
    }

    fn insert(&mut self, request_id: String, query: CatalogQuery) {
        if let Some(previous) = self.queries.remove(&request_id) {
            self.release(&request_id, previous.retained_bytes);
        }
        if request_id == INTERNAL_CATALOG_REQUEST_ID {
            self.internal_retained_bytes = self
                .internal_retained_bytes
                .saturating_add(query.retained_bytes);
        } else {
            self.external_retained_bytes = self
                .external_retained_bytes
                .saturating_add(query.retained_bytes);
        }
        self.queries.insert(request_id, query);
    }

    fn release(&mut self, request_id: &str, bytes: usize) {
        if request_id == INTERNAL_CATALOG_REQUEST_ID {
            self.internal_retained_bytes = self.internal_retained_bytes.saturating_sub(bytes);
        } else {
            self.external_retained_bytes = self.external_retained_bytes.saturating_sub(bytes);
        }
    }

    fn clear(&mut self) {
        self.queries.clear();
        self.internal_retained_bytes = 0;
        self.external_retained_bytes = 0;
    }

    fn advance_server_generation(&mut self) -> u64 {
        self.server_generation = self.server_generation.wrapping_add(1).max(1);
        self.server_generation
    }
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum CatalogCompletionHookPhase {
    AfterExtract,
    AfterCommitGate,
}

#[cfg(test)]
#[derive(Clone)]
struct CatalogCompletionTestHook {
    phase: CatalogCompletionHookPhase,
    reached: Arc<std::sync::Barrier>,
    resume: Arc<std::sync::Barrier>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingSnapshot {
    session_id: String,
    task_id: String,
    pid: i32,
}

#[derive(Clone)]
struct PreparedRecord {
    daemon_id: String,
    frame: Vec<u8>,
    expires_at: f64,
}

#[derive(Clone)]
struct ResponseWaiter {
    channel_id: String,
    request_id: String,
}

struct PendingAgentIo {
    session_id: String,
    sender: mpsc::Sender<device_envelope::Payload>,
}

struct PendingSnapshotRead {
    session_id: String,
    sender: oneshot::Sender<Result<Vec<u8>, String>>,
}

struct CallRecord {
    fingerprint: Vec<u8>,
    result: Option<device_envelope::Payload>,
    waiters: Vec<ResponseWaiter>,
}

struct AgentIoState {
    client_instance_id: String,
    transport_generation: u64,
    next_input_seq: u64,
    in_flight: bool,
    identity_count: usize,
    blocked: bool,
}

#[derive(Clone)]
struct AgentIoAttempt {
    client_instance_id: String,
    channel_id: String,
    transport_generation: u64,
    input_seq: u64,
}

enum AgentIoDisposition {
    Applied,
    KnownFailure,
    Unknown,
}

struct AgentIoExchangeError {
    message: String,
    disposition: AgentIoDisposition,
}

impl AgentIoExchangeError {
    fn known(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disposition: AgentIoDisposition::KnownFailure,
        }
    }

    fn unknown(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disposition: AgentIoDisposition::Unknown,
        }
    }
}

#[derive(Default)]
struct CallLedger {
    entries: HashMap<String, CallRecord>,
    bytes: usize,
}

enum CallStart {
    Execute,
    Pending,
    Cached(device_envelope::Payload),
}

enum CallStartError {
    Collision,
    Full,
}

#[derive(Clone)]
enum Principal {
    Local(LocalPrincipal),
    Relay {
        account_id: String,
        client_instance_id: String,
        transport_generation: u64,
        scopes: Vec<i32>,
    },
    /// 中心经控制 WS 触发已安装 prepared 操作时的身份（plan 091）。只对**已安装的 prepared
    /// 模板**有效（authorize_prepared 按安装模板放行），不持有任何非 prepared 的 Device RPC 权限；
    /// 没有 client identity，也永远不会出现在 channels 表里。
    Server,
}

impl Principal {
    fn account_id(&self) -> &str {
        match self {
            Self::Local(value) => &value.account_id,
            Self::Relay { account_id, .. } => account_id,
            Self::Server => "",
        }
    }

    fn client_instance_id(&self) -> &str {
        match self {
            Self::Local(value) => &value.client_instance_id,
            Self::Relay {
                client_instance_id, ..
            } => client_instance_id,
            Self::Server => "",
        }
    }

    fn transport_generation(&self) -> u64 {
        match self {
            Self::Local(value) => value.transport_generation,
            Self::Relay {
                transport_generation,
                ..
            } => *transport_generation,
            Self::Server => 0,
        }
    }

    fn request_key(&self, request_id: &str) -> String {
        format!(
            "{}\0{}\0{request_id}",
            self.account_id(),
            self.client_instance_id()
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportKind {
    Local,
    Relay,
    // P2P DataChannel（plan 076）。授权与生命周期语义与 Relay 相同（中心逐 channel 授
    // scopes、中心断开即全关），只是帧由 p2p 泵送往 DataChannel 而非 relay WS。
    P2p,
}

#[derive(Default)]
struct StreamCursor {
    next_seq: Option<u64>,
    gapped: bool,
}

struct ChannelEntry {
    transport: TransportKind,
    principal: Principal,
    sink: ChannelSink,
    streams: HashMap<String, StreamCursor>,
}

#[derive(Clone)]
struct AggregateQueueBudget {
    regular_pending: Arc<AtomicUsize>,
    regular_limit: usize,
    gap_pending: Arc<AtomicUsize>,
    gap_limit: usize,
}

impl AggregateQueueBudget {
    fn new(regular_limit: usize, gap_limit: usize) -> Self {
        Self {
            regular_pending: Arc::new(AtomicUsize::new(0)),
            regular_limit,
            gap_pending: Arc::new(AtomicUsize::new(0)),
            gap_limit,
        }
    }
}

#[derive(Clone)]
struct ChannelSink {
    regular: mpsc::Sender<Vec<u8>>,
    priority: mpsc::Sender<Vec<u8>>,
    pending_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    byte_limit: usize,
    aggregate: AggregateQueueBudget,
}

impl ChannelSink {
    fn pair(
        record_limit: usize,
        byte_limit: usize,
        aggregate: AggregateQueueBudget,
    ) -> (Self, ChannelReceiver) {
        let (regular_tx, regular_rx) = mpsc::channel(record_limit);
        // 每 channel 最多只挂一个合并后的 gap；与普通大帧分槽，保证 data queue 满时仍能报缺口。
        let (priority_tx, priority_rx) = mpsc::channel(1);
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        (
            Self {
                regular: regular_tx,
                priority: priority_tx,
                pending_bytes: pending_bytes.clone(),
                closed: closed.clone(),
                byte_limit,
                aggregate: aggregate.clone(),
            },
            ChannelReceiver {
                regular: regular_rx,
                priority: priority_rx,
                pending_bytes,
                closed,
                aggregate,
            },
        )
    }

    fn try_send(&self, bytes: Vec<u8>) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        let length = bytes.len();
        if !reserve_bytes(&self.pending_bytes, length, self.byte_limit) {
            return false;
        }
        if !reserve_bytes(
            &self.aggregate.regular_pending,
            length,
            self.aggregate.regular_limit,
        ) {
            self.pending_bytes.fetch_sub(length, Ordering::AcqRel);
            return false;
        }
        match self.regular.try_send(bytes) {
            Ok(()) => true,
            Err(_) => {
                self.pending_bytes.fetch_sub(length, Ordering::AcqRel);
                self.aggregate
                    .regular_pending
                    .fetch_sub(length, Ordering::AcqRel);
                false
            }
        }
    }

    fn try_send_gap(&self, bytes: Vec<u8>) -> bool {
        if self.closed.load(Ordering::Acquire) || bytes.len() > CHANNEL_GAP_FRAME_BYTES {
            return false;
        }
        let length = bytes.len();
        if !reserve_bytes(
            &self.aggregate.gap_pending,
            length,
            self.aggregate.gap_limit,
        ) {
            return false;
        }
        if self.priority.try_send(bytes).is_ok() {
            true
        } else {
            self.aggregate
                .gap_pending
                .fetch_sub(length, Ordering::AcqRel);
            false
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }
}

pub struct ChannelReceiver {
    regular: mpsc::Receiver<Vec<u8>>,
    priority: mpsc::Receiver<Vec<u8>>,
    pending_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    aggregate: AggregateQueueBudget,
}

impl ChannelReceiver {
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        // 先发送已经排队的连续普通帧，再发 gap；这样 gap 不会越过它之前仍有效的 delta。
        let bytes = tokio::select! {
            biased;
            value = self.regular.recv() => {
                let value = value?;
                self.pending_bytes.fetch_sub(value.len(), Ordering::AcqRel);
                self.aggregate.regular_pending.fetch_sub(value.len(), Ordering::AcqRel);
                value
            }
            value = self.priority.recv() => {
                let value = value?;
                self.aggregate.gap_pending.fetch_sub(value.len(), Ordering::AcqRel);
                value
            },
        };
        (!self.closed.load(Ordering::Acquire)).then_some(bytes)
    }

    /// 非阻塞读；语义与 [`Self::recv`] 一致（普通帧优先于 gap）。仅测试断言用。
    #[cfg(test)]
    pub fn try_recv(&mut self) -> Option<Vec<u8>> {
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        let bytes = match self.regular.try_recv() {
            Ok(value) => {
                self.pending_bytes.fetch_sub(value.len(), Ordering::AcqRel);
                self.aggregate
                    .regular_pending
                    .fetch_sub(value.len(), Ordering::AcqRel);
                value
            }
            Err(_) => {
                let value = self.priority.try_recv().ok()?;
                self.aggregate
                    .gap_pending
                    .fetch_sub(value.len(), Ordering::AcqRel);
                value
            }
        };
        (!self.closed.load(Ordering::Acquire)).then_some(bytes)
    }
}

impl Drop for ChannelReceiver {
    fn drop(&mut self) {
        // close 先阻止新的成功入队，再把仍在 mpsc 内的 Vec 全部摘出并归还聚合预算。
        // 否则 runtime.close_channel 后 recv 会因 closed 直接返回，遗留字节将永久占住全局额度。
        self.regular.close();
        self.priority.close();
        while let Ok(value) = self.regular.try_recv() {
            self.pending_bytes.fetch_sub(value.len(), Ordering::AcqRel);
            self.aggregate
                .regular_pending
                .fetch_sub(value.len(), Ordering::AcqRel);
        }
        while let Ok(value) = self.priority.try_recv() {
            self.aggregate
                .gap_pending
                .fetch_sub(value.len(), Ordering::AcqRel);
        }
    }
}

pub struct DeviceRuntime {
    auth: Option<Arc<LocalAuth>>,
    to_supervisor: mpsc::Sender<Vec<u8>>,
    to_server: mpsc::Sender<WsOut>,
    services: Option<ProductionServices>,
    channels: Mutex<HashMap<String, ChannelEntry>>,
    dirty_sessions: Mutex<HashSet<String>>,
    pending_snapshots: Mutex<HashMap<String, PendingSnapshot>>,
    pending_catalogs: Mutex<CatalogState>,
    /// server 认证换代与完整 catalog 提交共用的线性化门。锁顺序固定为
    /// catalog_commit_gate → pending_catalogs/state/派生状态/outbox。
    catalog_commit_gate: Mutex<()>,
    #[cfg(test)]
    catalog_completion_test_hook: Mutex<Option<CatalogCompletionTestHook>>,
    #[cfg(test)]
    catalog_auth_test_hook: Mutex<Option<Arc<std::sync::Barrier>>>,
    /// session_id → 最近一次成功 attach 的 channel_id（sessiond 裁决的影子，plan 088）。
    /// 所有 attach 都经本 runtime 中转，SessionAttached/SessionDetached 回流时在此登记，
    /// 用于「用户是否正在接管」判定：holder 存在且仍是存活 client channel = 人在场。
    holders: Mutex<HashMap<String, String>>,
    /// 在飞的 agent 写入（合成 channel_id → 回执等待者）。
    pending_agent_ios: Mutex<HashMap<String, PendingAgentIo>>,
    /// 每 session 的 agent logical identity/input cursor。成功调用复用 identity 并推进
    /// generation/seq；只有结果未知时才换 identity，避免 sessiond cursor 随每次 send 增长。
    agent_io_states: Mutex<HashMap<String, AgentIoState>>,
    prepared: Mutex<HashMap<String, PreparedRecord>>,
    /// 中心已触发执行过的 operation_id（plan 091）：Execute 重发只重放上次 report 或忽略在飞，绝不二次分派。
    executed_operations: Mutex<HashSet<String>>,
    /// 中心按需读快照的在飞等待者：内部 request_id → (session_id, 回执)。
    pending_snapshot_reads: Mutex<HashMap<String, PendingSnapshotRead>>,
    requests: Mutex<CallLedger>,
    operations: Mutex<CallLedger>,
    operation_reports: Mutex<BTreeMap<String, WsOut>>,
    supervisor_online: AtomicBool,
    internal_sequence: AtomicUsize,
    record_limit: usize,
    byte_limit: usize,
    channel_limit: usize,
    aggregate_queue: AggregateQueueBudget,
}

impl DeviceRuntime {
    #[cfg(test)]
    pub fn new(
        auth: Option<Arc<LocalAuth>>,
        to_supervisor: mpsc::Sender<Vec<u8>>,
        to_server: mpsc::Sender<WsOut>,
    ) -> Arc<Self> {
        Self::with_limits(
            auth,
            to_supervisor,
            to_server,
            None,
            CHANNEL_QUEUE_RECORDS,
            CHANNEL_QUEUE_BYTES,
            GLOBAL_CHANNEL_QUEUE_BYTES,
            DEVICE_CHANNEL_LIMIT,
        )
    }

    pub fn production(
        auth: Option<Arc<LocalAuth>>,
        to_supervisor: mpsc::Sender<Vec<u8>>,
        to_server: mpsc::Sender<WsOut>,
        checkpoints: Arc<CheckpointOutbox>,
        catalogs: Arc<CatalogOutbox>,
        exits: Arc<ExitOutbox>,
        state: Arc<Mutex<WorkerState>>,
        cfg: Arc<Config>,
    ) -> Arc<Self> {
        Self::with_limits(
            auth,
            to_supervisor,
            to_server,
            Some(ProductionServices {
                checkpoints,
                catalogs,
                exits,
                state,
                cfg,
            }),
            CHANNEL_QUEUE_RECORDS,
            CHANNEL_QUEUE_BYTES,
            GLOBAL_CHANNEL_QUEUE_BYTES,
            DEVICE_CHANNEL_LIMIT,
        )
    }

    fn with_limits(
        auth: Option<Arc<LocalAuth>>,
        to_supervisor: mpsc::Sender<Vec<u8>>,
        to_server: mpsc::Sender<WsOut>,
        services: Option<ProductionServices>,
        record_limit: usize,
        byte_limit: usize,
        aggregate_byte_limit: usize,
        channel_limit: usize,
    ) -> Arc<Self> {
        let aggregate_queue = AggregateQueueBudget::new(
            aggregate_byte_limit,
            channel_limit.saturating_mul(CHANNEL_GAP_FRAME_BYTES),
        );
        Arc::new(Self {
            auth,
            to_supervisor,
            to_server,
            services,
            channels: Mutex::new(HashMap::new()),
            dirty_sessions: Mutex::new(HashSet::new()),
            pending_snapshots: Mutex::new(HashMap::new()),
            pending_catalogs: Mutex::new(CatalogState::default()),
            catalog_commit_gate: Mutex::new(()),
            #[cfg(test)]
            catalog_completion_test_hook: Mutex::new(None),
            #[cfg(test)]
            catalog_auth_test_hook: Mutex::new(None),
            holders: Mutex::new(HashMap::new()),
            pending_agent_ios: Mutex::new(HashMap::new()),
            agent_io_states: Mutex::new(HashMap::new()),
            prepared: Mutex::new(HashMap::new()),
            executed_operations: Mutex::new(HashSet::new()),
            pending_snapshot_reads: Mutex::new(HashMap::new()),
            requests: Mutex::new(CallLedger::default()),
            operations: Mutex::new(CallLedger::default()),
            operation_reports: Mutex::new(BTreeMap::new()),
            supervisor_online: AtomicBool::new(false),
            internal_sequence: AtomicUsize::new(0),
            record_limit,
            byte_limit,
            channel_limit,
            aggregate_queue,
        })
    }

    pub fn open_local(
        &self,
        authenticated: AuthenticatedLocal,
    ) -> Result<(String, ChannelReceiver), String> {
        let mut channels = self.channels.lock().unwrap();
        if channels.len() >= self.channel_limit {
            return Err(DEVICE_CHANNEL_LIMIT_ERROR.into());
        }
        let channel_id = loop {
            let mut random = [0u8; 16];
            OsRng.fill_bytes(&mut random);
            let candidate = format!("local-{}", hex::encode(random));
            if !channels.contains_key(&candidate) {
                break candidate;
            }
        };
        let (sink, receiver) = ChannelSink::pair(
            self.record_limit,
            self.byte_limit,
            self.aggregate_queue.clone(),
        );
        channels.insert(
            channel_id.clone(),
            ChannelEntry {
                transport: TransportKind::Local,
                principal: Principal::Local(authenticated.principal),
                sink,
                streams: HashMap::new(),
            },
        );
        Ok((channel_id, receiver))
    }

    /// 注册一条 relay channel 并返回其出向帧接收端（plan 043：帧不再回中心控制 WS，
    /// 由调用方——relay 拨号任务——泵到该 channel 专属的 relay WS）。
    pub fn open_relay(self: &Arc<Self>, dial: &DeviceRelayDial) -> Result<ChannelReceiver, String> {
        validate_relay_dial(dial)?;
        self.open_remote(
            TransportKind::Relay,
            &dial.channel_id,
            &dial.account_id,
            &dial.client_instance_id,
            dial.transport_generation,
            &dial.scopes,
        )
    }

    /// 注册一条 P2P channel（plan 076）。授权语义与 relay 相同：中心逐 channel 授 scopes、
    /// daemon 信任控制面；帧由调用方——p2p channel 泵——送往该 channel 的 DataChannel。
    pub fn open_p2p(
        self: &Arc<Self>,
        grant: &DeviceP2pChannelGrant,
    ) -> Result<ChannelReceiver, String> {
        validate_p2p_channel_grant(grant)?;
        self.open_remote(
            TransportKind::P2p,
            &grant.channel_id,
            &grant.account_id,
            &grant.client_instance_id,
            grant.transport_generation,
            &grant.scopes,
        )
    }

    fn open_remote(
        &self,
        transport: TransportKind,
        channel_id: &str,
        account_id: &str,
        client_instance_id: &str,
        transport_generation: u64,
        scopes: &[i32],
    ) -> Result<ChannelReceiver, String> {
        let scopes = normalized_scopes(scopes.to_vec())?;
        let mut channels = self.channels.lock().unwrap();
        if channels.contains_key(channel_id) {
            return Err("channelId 已存在".into());
        }
        if channels.len() >= self.channel_limit {
            return Err(DEVICE_CHANNEL_LIMIT_ERROR.into());
        }
        let (sink, receiver) = ChannelSink::pair(
            self.record_limit,
            self.byte_limit,
            self.aggregate_queue.clone(),
        );
        channels.insert(
            channel_id.to_string(),
            ChannelEntry {
                transport,
                principal: Principal::Relay {
                    account_id: account_id.to_string(),
                    client_instance_id: client_instance_id.to_string(),
                    transport_generation,
                    scopes,
                },
                sink,
                streams: HashMap::new(),
            },
        );
        Ok(receiver)
    }

    pub fn close_channel(&self, channel_id: &str) {
        if let Some(entry) = self.channels.lock().unwrap().remove(channel_id) {
            entry.sink.close();
        }
    }

    pub fn close_relay(&self, channel_id: &str) {
        self.close_remote(TransportKind::Relay, channel_id);
    }

    pub fn close_p2p(&self, channel_id: &str) {
        self.close_remote(TransportKind::P2p, channel_id);
    }

    fn close_remote(&self, kind: TransportKind, channel_id: &str) {
        let removed = {
            let mut channels = self.channels.lock().unwrap();
            if channels
                .get(channel_id)
                .is_some_and(|entry| entry.transport == kind)
            {
                channels.remove(channel_id)
            } else {
                None
            }
        };
        if let Some(entry) = removed {
            entry.sink.close();
        }
    }

    pub fn close_relays(&self) {
        self.close_remote_all(TransportKind::Relay);
    }

    pub fn close_p2ps(&self) {
        self.close_remote_all(TransportKind::P2p);
    }

    fn close_remote_all(&self, kind: TransportKind) {
        let removed: Vec<ChannelSink> = {
            let mut channels = self.channels.lock().unwrap();
            let ids: Vec<String> = channels
                .iter()
                .filter(|(_, entry)| entry.transport == kind)
                .map(|(channel_id, _)| channel_id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink))
                .collect()
        };
        for sink in removed {
            sink.close();
        }
    }

    pub fn revoke_local_grant(&self, grant_id: &str) {
        let removed: Vec<ChannelSink> = {
            let mut channels = self.channels.lock().unwrap();
            let ids: Vec<String> = channels
                .iter()
                .filter(|(_, entry)| matches!(&entry.principal, Principal::Local(principal) if principal.grant_id == grant_id))
                .map(|(channel_id, _)| channel_id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink))
                .collect()
        };
        for sink in removed {
            sink.close();
        }
    }

    pub fn close_local_channels(&self) {
        let removed: Vec<ChannelSink> = {
            let mut channels = self.channels.lock().unwrap();
            let ids: Vec<String> = channels
                .iter()
                .filter(|(_, entry)| entry.transport == TransportKind::Local)
                .map(|(channel_id, _)| channel_id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink))
                .collect()
        };
        for sink in removed {
            sink.close();
        }
    }

    pub fn revalidate_local_origins(&self) {
        let Some(auth) = &self.auth else { return };
        let removed: Vec<ChannelSink> = {
            let mut channels = self.channels.lock().unwrap();
            let ids: Vec<String> = channels
                .iter()
                .filter(|(_, entry)| matches!(&entry.principal, Principal::Local(principal) if !auth.origin_allowed(&principal.origin)))
                .map(|(channel_id, _)| channel_id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink))
                .collect()
        };
        for sink in removed {
            sink.close();
        }
    }

    pub fn supervisor_connected(&self) {
        self.supervisor_online.store(true, Ordering::Release);
        // supervisor 接管新 worker 连接时会清掉旧 subscription。现存 logical channel 保留，
        // 但必须显式标 gap，要求 client reattach，而不是让它误以为输出仍连续。
        let mut channels = self.channels.lock().unwrap();
        for (channel_id, entry) in channels.iter_mut() {
            for (session_id, cursor) in &mut entry.streams {
                let expected_seq = cursor.next_seq.unwrap_or(1);
                cursor.gapped = true;
                let gap = DeviceEnvelope {
                    protocol_version: DEVICE_PROTOCOL_VERSION,
                    channel_id: channel_id.clone(),
                    payload: Some(device_envelope::Payload::PtyGap(DevicePtyGap {
                        session_id: session_id.clone(),
                        expected_seq,
                        available_seq: expected_seq,
                    })),
                };
                entry.sink.try_send_gap(encode_device_envelope(&gap));
            }
        }
        drop(channels);
        let request_ids = self.rotate_catalog_rounds();
        for request_id in request_ids {
            self.send_catalog_page(&request_id);
        }
    }

    pub fn supervisor_disconnected(&self) {
        self.supervisor_online.store(false, Ordering::Release);
        let pending: Vec<String> = self
            .pending_snapshots
            .lock()
            .unwrap()
            .drain()
            .map(|(_, pending)| pending.session_id)
            .collect();
        self.dirty_sessions.lock().unwrap().extend(pending);
        self.rotate_catalog_rounds();
    }

    pub fn mark_session_dirty(&self, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        if let Some(services) = &self.services {
            let state = services.state.lock().unwrap();
            if !state.alive.contains_key(session_id) {
                return;
            }
            // 与 session_exited 共享 state→dirty 锁序：迟到 Output 要么先登记并被退出
            // 清掉，要么在退出移除 alive 后被拒，不能在 cleanup 后复活 dirty。
            self.dirty_sessions
                .lock()
                .unwrap()
                .insert(session_id.to_string());
            return;
        }
        self.dirty_sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string());
    }

    /// session 退出是长期派生状态的最终边界。`WorkerState.alive` 的 incarnation 裁决由
    /// control exit 或完整 catalog 负责；这里只幂等清派生状态，避免迟到的旧
    /// DeviceSessionExited 按裸 sessionId 删除新 incarnation。
    pub fn session_exited(&self, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        for entry in self.channels.lock().unwrap().values_mut() {
            entry.streams.remove(session_id);
        }
        self.holders.lock().unwrap().remove(session_id);
        self.pending_agent_ios
            .lock()
            .unwrap()
            .retain(|_, pending| pending.session_id != session_id);
        self.agent_io_states.lock().unwrap().remove(session_id);
        self.dirty_sessions.lock().unwrap().remove(session_id);
        self.pending_snapshots
            .lock()
            .unwrap()
            .retain(|_, pending| pending.session_id != session_id);
        // 按需读快照的等待者随 session 退出即刻收到明确失败，不必等 5 秒超时；sender drop 即失败。
        self.pending_snapshot_reads
            .lock()
            .unwrap()
            .retain(|_, pending| pending.session_id != session_id);
    }

    /// 精确 control exit 和 catalog tombstone 共用的可靠上报入口。
    pub fn report_session_exit(&self, session_id: &str, exit_code: i32) {
        if session_id.is_empty() {
            return;
        }
        let Some(services) = &self.services else {
            return;
        };
        let bytes = coflux_protocol::wire::DaemonToServer {
            payload: Some(daemon_to_server::Payload::SessionExit(wire::SessionExit {
                session_id: session_id.to_string(),
                exit_code,
            })),
        }
        .encode_to_vec();
        services.exits.publish(session_id.to_string(), bytes);
    }

    /// sessionId 可复用；新存活 incarnation 已建立后，不能让离线期间残留的旧 exit
    /// 在 resync/session.started 之后再次杀掉它。
    pub fn cancel_session_exit(&self, session_id: &str) {
        if let Some(services) = &self.services {
            services.exits.remove(session_id);
        }
    }

    pub async fn run_checkpoint_loop(self: Arc<Self>) {
        let mut interval = tokio::time::interval(CHECKPOINT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Some(services) = &self.services else {
                continue;
            };
            if !self.supervisor_online.load(Ordering::Acquire) {
                continue;
            }
            let dirty = std::mem::take(&mut *self.dirty_sessions.lock().unwrap());
            for session_id in dirty {
                let state = services.state.lock().unwrap();
                let Some((task_id, pid)) = state.alive.get(&session_id).cloned() else {
                    continue;
                };
                if self
                    .pending_snapshots
                    .lock()
                    .unwrap()
                    .values()
                    .any(|pending| pending.session_id == session_id)
                {
                    drop(state);
                    self.mark_session_dirty(&session_id);
                    continue;
                }
                let request_id = self.next_internal_id("checkpoint");
                self.pending_snapshots.lock().unwrap().insert(
                    request_id.clone(),
                    PendingSnapshot {
                        session_id: session_id.clone(),
                        task_id,
                        pid,
                    },
                );
                drop(state);
                let sent = self.send_internal(device_envelope::Payload::SessionSnapshotRequest(
                    DeviceSessionSnapshotRequest {
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                    },
                ));
                if !sent {
                    self.pending_snapshots.lock().unwrap().remove(&request_id);
                    self.mark_session_dirty(&session_id);
                }
            }
        }
    }

    /// catalog 请求走 bounded supervisor queue，首发、续页和响应本身都可能在背压时丢失。
    /// pending intent 不摘除；未发送或超时的同一 offset 会在这里单飞重投。
    pub async fn run_catalog_retry_loop(self: Arc<Self>) {
        let mut interval = tokio::time::interval(CATALOG_RETRY_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            self.retry_catalog_queries();
        }
    }

    fn retry_catalog_queries(&self) {
        if !self.supervisor_online.load(Ordering::Acquire) {
            return;
        }
        let now = Instant::now();
        let request_ids = self
            .pending_catalogs
            .lock()
            .unwrap()
            .queries
            .iter()
            .filter_map(|(request_id, query)| {
                query
                    .sent_at
                    .is_none_or(|sent_at| {
                        now.saturating_duration_since(sent_at) >= CATALOG_RESPONSE_TIMEOUT
                    })
                    .then_some(request_id.clone())
            })
            .collect::<Vec<_>>();
        for request_id in request_ids {
            self.send_catalog_page(&request_id);
        }
    }

    pub fn request_reconciliation_catalog(&self) {
        if self.services.is_none() {
            return;
        }
        self.request_catalog(INTERNAL_CATALOG_REQUEST_ID.to_string(), true);
    }

    pub fn request_server_catalog(&self, request: DeviceSessionCatalogRequest) {
        if request.request_id == INTERNAL_CATALOG_REQUEST_ID {
            return;
        }
        self.request_catalog(request.request_id, false);
    }

    pub fn acknowledge_exits(&self, request: DeviceExitAck) {
        self.send_internal(device_envelope::Payload::ExitAck(request));
    }

    pub fn install_prepared_operation(
        &self,
        operation: PreparedDeviceOperation,
    ) -> PreparedDeviceOperationInstalled {
        let operation_id = operation.operation_id.clone();
        let result = self.validate_and_install_prepared(operation);
        PreparedDeviceOperationInstalled {
            operation_id,
            ok: result.is_ok(),
            error: result.err(),
        }
    }

    fn validate_and_install_prepared(
        &self,
        operation: PreparedDeviceOperation,
    ) -> Result<(), String> {
        if !valid_id(&operation.operation_id) || !valid_id(&operation.daemon_id) {
            return Err("prepared operation identity 不能为空".into());
        }
        if !operation.expires_at.is_finite() || operation.expires_at <= epoch_ms() {
            return Err("prepared operation 已过期".into());
        }
        let Some(services) = &self.services else {
            return Err("Device router 未启用".into());
        };
        if services.state.lock().unwrap().daemon_id.as_deref() != Some(operation.daemon_id.as_str())
        {
            return Err("prepared operation daemonId 与本机不匹配".into());
        }
        if operation.frame.len() > MAX_PREPARED_FRAME_BYTES {
            return Err("prepared operation frame 超过上限".into());
        }
        let envelope = decode_device_envelope(&operation.frame)
            .ok_or_else(|| "prepared operation frame 畸形".to_string())?;
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION || !envelope.channel_id.is_empty() {
            return Err("prepared operation version/channel 无效".into());
        }
        let payload = envelope
            .payload
            .as_ref()
            .ok_or_else(|| "prepared operation payload 为空".to_string())?;
        if prepared_operation_id(payload) != Some(operation.operation_id.as_str()) {
            return Err("prepared operationId 与 frame 不一致或类型不可 prepare".into());
        }
        let canonical_frame = encode_device_envelope(&envelope);
        let record = PreparedRecord {
            daemon_id: operation.daemon_id,
            frame: canonical_frame,
            expires_at: operation.expires_at,
        };
        let mut prepared = self.prepared.lock().unwrap();
        prepared.retain(|_, record| record.expires_at > epoch_ms());
        if let Some(existing) = prepared.get(&operation.operation_id) {
            if existing.daemon_id != record.daemon_id || existing.frame != record.frame {
                return Err("相同 operationId 已安装不同模板".into());
            }
        }
        if !prepared.contains_key(&operation.operation_id) && prepared.len() >= PREPARED_LIMIT {
            return Err("prepared operation 队列已满".into());
        }
        let existing_bytes = prepared
            .iter()
            .filter(|(operation_id, _)| operation_id.as_str() != operation.operation_id.as_str())
            .map(|(_, record)| record.frame.len())
            .sum::<usize>();
        if record.frame.len() > PREPARED_BYTES.saturating_sub(existing_bytes) {
            return Err("prepared operation 字节预算已满".into());
        }
        prepared.insert(operation.operation_id, record);
        Ok(())
    }

    fn request_catalog(&self, request_id: String, internal: bool) {
        if !valid_id(&request_id) {
            return;
        }
        {
            let mut pending = self.pending_catalogs.lock().unwrap();
            if let Some(query) = pending.queries.get_mut(&request_id) {
                if internal
                    && (query.sent_at.is_some()
                        || query.next_session_offset != 0
                        || query.next_exit_offset != 0)
                {
                    query.rerun = true;
                }
                return;
            }
            if !internal
                && pending
                    .queries
                    .keys()
                    .filter(|key| key.as_str() != INTERNAL_CATALOG_REQUEST_ID)
                    .count()
                    >= CATALOG_EXTERNAL_QUERY_LIMIT
            {
                return;
            }
            let server_generation = pending.server_generation;
            pending.insert(
                request_id.clone(),
                self.new_catalog_query(server_generation),
            );
        }
        if self.supervisor_online.load(Ordering::Acquire) {
            self.send_catalog_page(&request_id);
        }
    }

    fn send_catalog_page(&self, request_id: &str) -> bool {
        if !self.supervisor_online.load(Ordering::Acquire) {
            return false;
        }
        let (request, sent_at) = {
            let mut pending = self.pending_catalogs.lock().unwrap();
            let Some(query) = pending.queries.get_mut(request_id) else {
                return false;
            };
            let sent_at = Instant::now();
            query.sent_at = Some(sent_at);
            (
                DeviceSessionCatalogRequest {
                    request_id: query.wire_request_id.clone(),
                    snapshot_owner_id: query.snapshot_owner_id.clone(),
                    snapshot_epoch: query.snapshot_epoch,
                    session_offset: query.next_session_offset,
                    exit_offset: query.next_exit_offset,
                    max_page_bytes: CATALOG_PAGE_BYTES,
                },
                sent_at,
            )
        };
        let sent = self.send_internal(device_envelope::Payload::SessionCatalogRequest(request));
        if !sent {
            let mut pending = self.pending_catalogs.lock().unwrap();
            if pending
                .queries
                .get(request_id)
                .is_some_and(|query| query.sent_at == Some(sent_at))
            {
                pending.queries.get_mut(request_id).unwrap().sent_at = None;
            }
        }
        sent
    }

    fn new_catalog_query(&self, server_generation: u64) -> CatalogQuery {
        CatalogQuery::new(self.next_internal_id("catalog-wire"), server_generation)
    }

    #[cfg(test)]
    fn pause_catalog_completion(&self, phase: CatalogCompletionHookPhase) {
        let hook = {
            let mut current = self.catalog_completion_test_hook.lock().unwrap();
            current
                .as_ref()
                .is_some_and(|hook| hook.phase == phase)
                .then(|| current.take().unwrap())
        };
        if let Some(hook) = hook {
            hook.reached.wait();
            hook.resume.wait();
        }
    }

    #[cfg(test)]
    fn reach_server_auth_catalog_gate(&self) {
        let hook = self.catalog_auth_test_hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook.wait();
        }
    }

    /// supervisor 连接代际切换时保留 logical intent，但每一轮换新的 wire id；旧 UDS
    /// 缓冲区里迟到的响应因此找不到当前 query。分页与 timeout 重投不走这里。
    fn rotate_catalog_rounds(&self) -> Vec<String> {
        let mut pending = self.pending_catalogs.lock().unwrap();
        let request_ids = pending.queries.keys().cloned().collect::<Vec<_>>();
        pending.clear();
        let server_generation = pending.server_generation;
        for request_id in &request_ids {
            pending.insert(
                request_id.clone(),
                self.new_catalog_query(server_generation),
            );
        }
        request_ids
    }

    fn next_internal_id(&self, kind: &str) -> String {
        let sequence = self
            .internal_sequence
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        format!("worker-{kind}-{}-{sequence}", std::process::id())
    }

    fn send_internal(&self, payload: device_envelope::Payload) -> bool {
        self.send_on_channel(INTERNAL_CHANNEL_ID, payload)
    }

    fn send_on_channel(&self, channel_id: &str, payload: device_envelope::Payload) -> bool {
        let envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.to_string(),
            payload: Some(payload),
        };
        let Ok(frame) = encode_frame(&DataFrame::Device {
            channel_id: channel_id.to_string(),
            data: encode_device_envelope(&envelope),
        }) else {
            return false;
        };
        write_record(&frame).is_ok_and(|record| self.to_supervisor.try_send(record).is_ok())
    }

    /// 「用户是否正在接管该 session」：sessiond 裁决的当前 holder（影子表）仍是存活 client
    /// channel 才算人在场——holder 是 agent 合成 transport、或其 channel 已断开时，都不算。
    pub fn human_holder_present(&self, session_id: &str) -> bool {
        let holder = self.holders.lock().unwrap().get(session_id).cloned();
        holder.is_some_and(|channel_id| self.channels.lock().unwrap().contains_key(&channel_id))
    }

    /// agent 经正门写 PTY（plan 088）：同一 worker/session 复用 logical identity，每次 attach
    /// 递增 transport generation，每次确证写入后递增 input seq。只有超时等「结果未知」才换
    /// 新 identity 并从 seq=1 开始，既不让 sessiond 每次 send 都新增 cursor，也不拿不同 payload
    /// 猜测性复用一个可能已经提交的旧 seq。人类随后 attach 会把 agent 顶掉——人永远赢。
    ///
    /// 「检查人类 holder → attach」之间存在毫秒级竞态窗口（sessiond 无条件 attach 语义，
    /// 消除它需要改 supervisor，plan 088 判为不值）；真撞上时用户会被顶下线一次，重新点开
    /// 即夺回，agent 的后续输入随 holder 失效被拒。
    pub async fn agent_send_input(
        self: &Arc<Self>,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<(), String> {
        if self.human_holder_present(session_id) {
            return Err("用户正在接管这个终端：把交互留给用户；要沟通用 notify_user".into());
        }
        let attempt = self.begin_agent_io(session_id)?;
        let (tx, mut rx) = mpsc::channel::<device_envelope::Payload>(8);
        let registered = {
            let mut pending = self.pending_agent_ios.lock().unwrap();
            if pending.len() >= PENDING_AGENT_IO_LIMIT {
                false
            } else {
                pending.insert(
                    attempt.channel_id.clone(),
                    PendingAgentIo {
                        session_id: session_id.to_string(),
                        sender: tx,
                    },
                );
                true
            }
        };
        if !registered {
            self.finish_agent_io(session_id, &attempt, AgentIoDisposition::KnownFailure);
            return Err("agent PTY 写入并发已达上限，请稍后重试".into());
        }
        let outcome = self
            .agent_io_exchange(&attempt, session_id, data, &mut rx)
            .await;
        self.pending_agent_ios
            .lock()
            .unwrap()
            .remove(&attempt.channel_id);
        match outcome {
            Ok(()) => {
                self.finish_agent_io(session_id, &attempt, AgentIoDisposition::Applied);
                Ok(())
            }
            Err(error) => {
                self.finish_agent_io(session_id, &attempt, error.disposition);
                Err(error.message)
            }
        }
    }

    /// 中心按需读某会话的当前快照（plan 091 `read_terminal` 的 snapshot 降级）：与 checkpoint
    /// 循环同一条只读 SessionSnapshotRequest，不注册 subscriber、不读也不改 holder。
    pub async fn read_session_snapshot(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<Vec<u8>, String> {
        if !valid_id(session_id) {
            return Err("sessionId 无效".into());
        }
        if !self.supervisor_online.load(Ordering::Acquire) {
            return Err("sessiond 未连接".into());
        }
        let request_id = self.next_internal_id("read");
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending_snapshot_reads.lock().unwrap();
            if pending.len() >= PENDING_SNAPSHOT_READ_LIMIT {
                return Err("按需读快照并发已达上限，请稍后重试".into());
            }
            pending.insert(
                request_id.clone(),
                PendingSnapshotRead {
                    session_id: session_id.to_string(),
                    sender,
                },
            );
        }
        let sent = self.send_internal(device_envelope::Payload::SessionSnapshotRequest(
            DeviceSessionSnapshotRequest {
                request_id: request_id.clone(),
                session_id: session_id.to_string(),
            },
        ));
        if !sent {
            self.pending_snapshot_reads
                .lock()
                .unwrap()
                .remove(&request_id);
            return Err("sessiond 请求队列已满，请重试".into());
        }
        match tokio::time::timeout(AGENT_IO_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("会话已退出，没有本地快照".into()),
            Err(_) => {
                self.pending_snapshot_reads
                    .lock()
                    .unwrap()
                    .remove(&request_id);
                Err("等待 sessiond 快照超时".into())
            }
        }
    }

    fn begin_agent_io(&self, session_id: &str) -> Result<AgentIoAttempt, String> {
        let mut states = self.agent_io_states.lock().unwrap();
        if !states.contains_key(session_id) {
            if states.len() >= AGENT_IO_SESSION_LIMIT {
                return Err("agent PTY identity 表已达上限，请稍后重试".into());
            }
            states.insert(session_id.to_string(), new_agent_io_state());
        }
        let state = states.get_mut(session_id).unwrap();
        if state.blocked {
            return Err("该终端的 agent PTY identity 已耗尽；请重启 worker 后再试".into());
        }
        if state.in_flight {
            return Err("同一终端已有 agent PTY 写入在等待回执，请稍后重试".into());
        }
        if state.transport_generation == u64::MAX && !rotate_agent_identity(state) {
            return Err("该终端的 agent PTY identity 已耗尽；请重启 worker 后再试".into());
        }
        state.transport_generation += 1;
        state.in_flight = true;
        Ok(AgentIoAttempt {
            client_instance_id: state.client_instance_id.clone(),
            channel_id: format!(
                "{}-g{}",
                state.client_instance_id, state.transport_generation
            ),
            transport_generation: state.transport_generation,
            input_seq: state.next_input_seq,
        })
    }

    fn finish_agent_io(
        &self,
        session_id: &str,
        attempt: &AgentIoAttempt,
        disposition: AgentIoDisposition,
    ) {
        let mut states = self.agent_io_states.lock().unwrap();
        let Some(state) = states.get_mut(session_id) else {
            return;
        };
        if !state.in_flight
            || state.client_instance_id != attempt.client_instance_id
            || state.transport_generation != attempt.transport_generation
            || state.next_input_seq != attempt.input_seq
        {
            return;
        }
        state.in_flight = false;
        match disposition {
            AgentIoDisposition::Applied => {
                if let Some(next) = state.next_input_seq.checked_add(1) {
                    state.next_input_seq = next;
                } else {
                    rotate_agent_identity(state);
                }
            }
            AgentIoDisposition::KnownFailure => {}
            AgentIoDisposition::Unknown => {
                rotate_agent_identity(state);
            }
        }
    }

    async fn agent_io_exchange(
        self: &Arc<Self>,
        attempt: &AgentIoAttempt,
        session_id: &str,
        data: Vec<u8>,
        rx: &mut mpsc::Receiver<device_envelope::Payload>,
    ) -> Result<(), AgentIoExchangeError> {
        let attach = device_envelope::Payload::SessionAttach(DeviceSessionAttach {
            request_id: format!("{}-attach", attempt.channel_id),
            session_id: session_id.to_string(),
            client_instance_id: attempt.client_instance_id.clone(),
            transport_generation: attempt.transport_generation,
            // 0 = 保持现有行列（sessiond clamp_dim 语义），不产生副作用 resize。
            cols: 0,
            rows: 0,
            resume_from_seq: None,
        });
        if !self.send_on_channel(&attempt.channel_id, attach) {
            return Err(AgentIoExchangeError::known("sessiond 请求队列已满，请重试"));
        }
        let holder_epoch = loop {
            match tokio::time::timeout(AGENT_IO_TIMEOUT, rx.recv()).await {
                Ok(Some(device_envelope::Payload::SessionAttached(attached)))
                    if attached.session_id == session_id =>
                {
                    break attached.holder_epoch;
                }
                Ok(Some(device_envelope::Payload::Error(error))) => {
                    return Err(AgentIoExchangeError::known(format!(
                        "写入前 attach 被拒（{}）：{}",
                        error.code, error.message
                    )));
                }
                // attach 回执前不会有别的定向帧；snapshot/replay（PtyOutput）直接略过。
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => {
                    return Err(AgentIoExchangeError::unknown(
                        "等待 sessiond attach 回执超时；后续不会复用本次 identity",
                    ))
                }
            }
        };
        let input = device_envelope::Payload::PtyInput(DevicePtyInput {
            request_id: format!("{}-input", attempt.channel_id),
            session_id: session_id.to_string(),
            holder_epoch,
            input_seq: attempt.input_seq,
            data,
        });
        if !self.send_on_channel(&attempt.channel_id, input) {
            return Err(AgentIoExchangeError::known("sessiond 请求队列已满，请重试"));
        }
        loop {
            match tokio::time::timeout(AGENT_IO_TIMEOUT, rx.recv()).await {
                Ok(Some(device_envelope::Payload::PtyInputAck(ack)))
                    if ack.session_id == session_id
                        && ack.applied_through_seq >= attempt.input_seq =>
                {
                    return Ok(());
                }
                Ok(Some(device_envelope::Payload::Error(error))) => {
                    return Err(AgentIoExchangeError::known(format!(
                        "写入被拒（{}）：{}",
                        error.code, error.message
                    )));
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => {
                    return Err(AgentIoExchangeError::unknown(
                        "等待 sessiond 写入回执超时，写入结果未知；后续不会复用本次 identity",
                    ))
                }
            }
        }
    }

    pub fn handle_client_frame(self: &Arc<Self>, channel_id: &str, bytes: &[u8]) {
        if bytes.len() > MAX_DEVICE_FRAME_BYTES {
            self.send_error(channel_id, None, "frame_too_large", "Device frame 超过上限");
            return;
        }
        let Some(envelope) = decode_device_envelope(bytes) else {
            self.send_error(
                channel_id,
                None,
                "malformed_envelope",
                "DeviceEnvelope 解码失败",
            );
            return;
        };
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION {
            self.send_error(
                channel_id,
                None,
                "version_mismatch",
                "Device protocol version 不兼容",
            );
            return;
        }
        if envelope.channel_id != channel_id {
            self.send_error(
                channel_id,
                None,
                "channel_mismatch",
                "inner/transport channelId 不一致",
            );
            return;
        }
        let Some(payload) = envelope.payload.as_ref() else {
            self.send_error(
                channel_id,
                None,
                "empty_payload",
                "DeviceEnvelope payload 为空",
            );
            return;
        };

        let principal = {
            let channels = self.channels.lock().unwrap();
            let Some(entry) = channels.get(channel_id) else {
                return;
            };
            entry.principal.clone()
        };
        let scopes = self.effective_scopes(&principal);
        if scopes.is_empty() {
            self.close_channel(channel_id);
            return;
        }
        if let Some(required) = required_scope(payload) {
            if !scopes.contains(&(required as i32)) {
                self.send_error(
                    channel_id,
                    request_id(payload),
                    "scope_denied",
                    "当前 grant/lease 不允许该 Device RPC",
                );
                return;
            }
        } else {
            self.send_error(
                channel_id,
                request_id(payload),
                "unsupported_payload",
                "该 Device payload 不能由 client 发起",
            );
            return;
        }
        if let device_envelope::Payload::SessionAttach(attach) = payload {
            if attach.client_instance_id != principal.client_instance_id()
                || attach.transport_generation != principal.transport_generation()
            {
                self.send_error(
                    channel_id,
                    Some(attach.request_id.clone()),
                    "principal_mismatch",
                    "attach identity 与认证 channel 不匹配",
                );
                return;
            }
        }
        if matches!(payload, device_envelope::Payload::SessionStop(stop) if !valid_id(&stop.operation_id))
        {
            self.send_error(
                channel_id,
                request_id(payload),
                "invalid_operation_id",
                "operationId 无效或过长",
            );
            return;
        }
        let request_id = request_id(payload);
        if request_id
            .as_deref()
            .is_some_and(|request_id| !valid_id(request_id))
        {
            self.send_error(
                channel_id,
                request_id,
                "invalid_request_id",
                "requestId 无效或过长",
            );
            return;
        }

        if prepared_operation_id(payload).is_some() {
            if let Err(error) = self.authorize_prepared(&envelope) {
                self.send_error(channel_id, request_id, "prepared_operation_denied", &error);
                return;
            }
        }

        if routed_to_sessiond(payload) {
            let Ok(frame) = encode_frame(&DataFrame::Device {
                channel_id: channel_id.to_string(),
                data: encode_device_envelope(&envelope),
            }) else {
                self.send_error(
                    channel_id,
                    request_id,
                    "invalid_channel_id",
                    "channelId 超过内部 frame 上限",
                );
                return;
            };
            let queued = write_record(&frame)
                .is_ok_and(|record| self.to_supervisor.try_send(record).is_ok());
            if !queued {
                self.send_error(
                    channel_id,
                    request_id,
                    "supervisor_busy",
                    "sessiond 请求队列已满，请重试",
                );
            }
        } else {
            self.dispatch_worker_request(channel_id.to_string(), principal, envelope);
        }
    }

    pub fn handle_relay_frame(self: &Arc<Self>, channel_id: &str, bytes: &[u8]) -> bool {
        self.handle_remote_frame(TransportKind::Relay, channel_id, bytes)
    }

    pub fn handle_p2p_frame(self: &Arc<Self>, channel_id: &str, bytes: &[u8]) -> bool {
        self.handle_remote_frame(TransportKind::P2p, channel_id, bytes)
    }

    fn handle_remote_frame(
        self: &Arc<Self>,
        kind: TransportKind,
        channel_id: &str,
        bytes: &[u8],
    ) -> bool {
        let known = self
            .channels
            .lock()
            .unwrap()
            .get(channel_id)
            .is_some_and(|entry| entry.transport == kind);
        if known {
            self.handle_client_frame(channel_id, bytes);
        }
        known
    }

    /// 中心触发已安装 prepared 操作的执行（plan 091）。取本地已安装的模板，以合成 channel
    /// `__coflux-server-<operation_id>` 与 [`Principal::Server`] 走与 browser **完全相同**的分派
    /// （authorize_prepared → sessiond 路由或 dispatch_worker_request），结果沿既有
    /// DeviceOperationReport 回中心，中心用同一个收敛事务落库/广播。
    ///
    /// 幂等：同一 operation_id 的重复 Execute（中心 restore 后重发）只重发上次 report、在飞时
    /// 忽略，绝不二次 `git worktree add` / 二次建会话。模板缺失/过期或无法入队时回一条 Error
    /// report，让中心的完成原语立刻拿到可读错误而不是白等。
    pub fn execute_prepared_operation(self: &Arc<Self>, operation_id: &str) {
        if !valid_id(operation_id) {
            return;
        }
        if let Some(report) = self
            .operation_reports
            .lock()
            .unwrap()
            .get(operation_id)
            .cloned()
        {
            let _ = self.to_server.try_send(report);
            return;
        }
        {
            let mut executed = self.executed_operations.lock().unwrap();
            if executed.contains(operation_id) {
                return;
            }
            if executed.len() >= EXECUTED_OPERATION_LIMIT {
                executed.clear();
            }
            executed.insert(operation_id.to_string());
        }
        let fail = |code: &str, message: &str| {
            self.executed_operations.lock().unwrap().remove(operation_id);
            self.report_operation(operation_id, &device_error(None, code, message));
        };
        let channel_id = format!("{SERVER_CHANNEL_PREFIX}{operation_id}");
        if channel_id.len() > MAX_FRAME_ID_BYTES {
            fail("invalid_operation_id", "operationId 过长，无法派生合成 channel");
            return;
        }
        let template = {
            let now = epoch_ms();
            let mut prepared = self.prepared.lock().unwrap();
            prepared.retain(|_, record| record.expires_at > now);
            prepared.get(operation_id).map(|record| record.frame.clone())
        };
        let Some(template) = template else {
            fail("prepared_operation_denied", "operation 未由中心 prepare 或已过期");
            return;
        };
        let Some(mut envelope) = decode_device_envelope(&template) else {
            fail("prepared_operation_denied", "已安装的 prepared 模板畸形");
            return;
        };
        envelope.channel_id = channel_id.clone();
        if let Err(error) = self.authorize_prepared(&envelope) {
            fail("prepared_operation_denied", &error);
            return;
        }
        let Some(payload) = envelope.payload.clone() else {
            fail("prepared_operation_denied", "prepared 模板 payload 为空");
            return;
        };
        // 命令终端：authorize 通过后、交给 sessiond 前，本地写包装脚本并把 shell 填成脚本路径。
        // 路径由 operation_id 确定性派生——sessiond 账本的 canonical 请求含 shell，重放时路径若变
        // 会被判成 operation_collision。日志路径按 task 记住，供中心经 ServerTerminalRead 读。
        if let Some(device_envelope::Payload::SessionCreate(create)) = envelope.payload.as_mut() {
            if !create.command.is_empty() {
                match crate::ops::write_operation_command_script(operation_id, &create.command) {
                    Ok((shell, log_path)) => {
                        create.shell = Some(shell);
                        if let Some(services) = &self.services {
                            crate::agent_ctl::remember_log(
                                &services.state,
                                create.task_id.clone(),
                                log_path,
                            );
                        }
                    }
                    Err(error) => {
                        fail("command_script_failed", &format!("写命令脚本失败：{error}"));
                        return;
                    }
                }
            }
        }
        if routed_to_sessiond(&payload) {
            let Ok(frame) = encode_frame(&DataFrame::Device {
                channel_id,
                data: encode_device_envelope(&envelope),
            }) else {
                fail("invalid_channel_id", "channelId 超过内部 frame 上限");
                return;
            };
            let queued = write_record(&frame)
                .is_ok_and(|record| self.to_supervisor.try_send(record).is_ok());
            if !queued {
                fail("supervisor_busy", "sessiond 请求队列已满，请重试");
            }
        } else {
            self.dispatch_worker_request(channel_id, Principal::Server, envelope);
        }
    }

    fn authorize_prepared(&self, envelope: &DeviceEnvelope) -> Result<(), String> {
        let payload = envelope
            .payload
            .as_ref()
            .ok_or_else(|| "Device payload 为空".to_string())?;
        let operation_id = prepared_operation_id(payload)
            .ok_or_else(|| "该操作不支持 prepared template".to_string())?;
        if operation_id.is_empty() {
            return Err("operationId 不能为空".into());
        }
        let mut canonical = envelope.clone();
        canonical.channel_id.clear();
        let canonical = encode_device_envelope(&canonical);
        let now = epoch_ms();
        let daemon_id = self
            .services
            .as_ref()
            .and_then(|services| services.state.lock().unwrap().daemon_id.clone());
        let mut prepared = self.prepared.lock().unwrap();
        prepared.retain(|_, record| record.expires_at > now);
        let Some(record) = prepared.get(operation_id) else {
            return Err("operation 未由中心 prepare 或已过期".into());
        };
        if daemon_id.as_deref() != Some(record.daemon_id.as_str()) || record.frame != canonical {
            return Err("operation payload 与中心安装模板不一致".into());
        }
        Ok(())
    }

    fn effective_scopes(&self, principal: &Principal) -> Vec<i32> {
        match principal {
            Principal::Local(principal) => {
                let daemon_matches = self.services.as_ref().is_none_or(|services| {
                    services.state.lock().unwrap().daemon_id.as_deref()
                        == Some(principal.daemon_id.as_str())
                });
                if daemon_matches {
                    self.auth
                        .as_ref()
                        .map_or_else(Vec::new, |auth| auth.effective_scopes(principal))
                } else {
                    Vec::new()
                }
            }
            Principal::Relay { scopes, .. } => scopes.clone(),
            // 只放行 prepared 类载荷；execute_prepared_operation 已按安装模板校验过，这里的 scope
            // 只用于 send_payload/response 分派的对称检查（合成 channel 本就不在 channels 表里）。
            Principal::Server => vec![DeviceScope::Lifecycle as i32],
        }
    }

    fn response_scope(&self, payload: &device_envelope::Payload) -> Option<DeviceScope> {
        if let device_envelope::Payload::OperationAck(ack) = payload {
            return if self
                .prepared
                .lock()
                .unwrap()
                .contains_key(&ack.operation_id)
            {
                Some(DeviceScope::Lifecycle)
            } else {
                Some(DeviceScope::SessionControl)
            };
        }
        response_required_scope(payload)
    }

    fn dispatch_worker_request(
        self: &Arc<Self>,
        channel_id: String,
        principal: Principal,
        envelope: DeviceEnvelope,
    ) {
        let Some(payload) = envelope.payload.clone() else {
            return;
        };
        let operation_id = worker_operation_id(&payload).map(str::to_string);
        if operation_id
            .as_deref()
            .is_some_and(|operation_id| !valid_id(operation_id))
        {
            self.send_error(
                &channel_id,
                request_id(&payload),
                "invalid_operation_id",
                "operationId 无效或过长",
            );
            return;
        }
        let response_request_id = request_id(&payload)
            .or_else(|| operation_id.clone())
            .unwrap_or_default();
        if response_request_id.is_empty() {
            self.send_error(
                &channel_id,
                None,
                "invalid_request_id",
                "requestId 无效或过长",
            );
            return;
        }
        let (key, operation) = match &operation_id {
            Some(operation_id) => (operation_id.clone(), true),
            None => (principal.request_key(&response_request_id), false),
        };
        let fingerprint = call_fingerprint(&envelope, operation);
        let waiter = ResponseWaiter {
            channel_id: channel_id.clone(),
            request_id: response_request_id.clone(),
        };
        let start = {
            let ledger = if operation {
                &self.operations
            } else {
                &self.requests
            };
            start_call(ledger, key.clone(), fingerprint, waiter)
        };
        match start {
            Ok(CallStart::Pending) => return,
            Ok(CallStart::Cached(mut result)) => {
                set_response_request_id(&mut result, &response_request_id);
                self.send_payload(&channel_id, result);
                return;
            }
            Err(CallStartError::Collision) => {
                let code = if operation {
                    "operation_collision"
                } else {
                    "request_collision"
                };
                self.send_error(
                    &channel_id,
                    Some(response_request_id),
                    code,
                    "相同 ID 携带了不同 payload",
                );
                return;
            }
            Err(CallStartError::Full) => {
                self.send_error(
                    &channel_id,
                    Some(response_request_id),
                    "router_busy",
                    "Device 去重队列已满，请稍后重试",
                );
                return;
            }
            Ok(CallStart::Execute) => {}
        }

        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            let result = runtime.execute_worker_payload(payload).await;
            runtime.finish_call(key, operation, operation_id, result);
        });
    }

    async fn execute_worker_payload(
        &self,
        payload: device_envelope::Payload,
    ) -> device_envelope::Payload {
        let Some(services) = &self.services else {
            return device_error(
                request_id(&payload),
                "router_unavailable",
                "Device RPC router 未启用",
            );
        };
        match payload {
            device_envelope::Payload::ProjectValidate(request) => {
                let result = crate::git::validate_repo(&request.path).await;
                device_envelope::Payload::ProjectValidated(wire::DeviceProjectValidated {
                    request_id: request.request_id,
                    ok: result.ok,
                    repo_path: result.repo_path,
                    branch: result.branch,
                    error: result.error,
                    suggested_name: result.suggested_name,
                    operation_id: request.operation_id,
                    default_branch: result.default_branch,
                })
            }
            device_envelope::Payload::WorktreeAdd(request) => {
                let result = crate::git::add_worktree(
                    &services.cfg.worktrees_dir,
                    &request.repo_path,
                    &request.workspace_id,
                    &request.branch,
                    request.create_new,
                )
                .await;
                device_envelope::Payload::WorktreeAdded(wire::DeviceWorktreeAdded {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    ok: result.ok,
                    path: result.path,
                    branch: result.branch,
                    error: result.error,
                })
            }
            device_envelope::Payload::WorktreeRemove(request) => {
                let result =
                    crate::git::remove_worktree(&request.repo_path, &request.worktree_path).await;
                device_envelope::Payload::OperationAck(wire::DeviceOperationAck {
                    request_id: request.operation_id.clone(),
                    operation_id: request.operation_id,
                    ok: result.is_ok(),
                    error: result.err(),
                    session_id: None,
                    pid: None,
                })
            }
            device_envelope::Payload::ExecRun(request) => {
                let Some(cwd) = workspace_root(&services.state, &request.workspace_id) else {
                    return device_error(
                        Some(request.request_id),
                        "workspace_unknown",
                        "workspaceId 不属于本 daemon 当前清单",
                    );
                };
                let result = crate::ops::run_command(
                    &cwd,
                    &request.command,
                    &request.args,
                    &request.env,
                    request.timeout_ms.map(u64::from),
                )
                .await;
                device_envelope::Payload::ExecResult(wire::ExecResult {
                    request_id: request.request_id,
                    ok: result.ok,
                    exit_code: result.exit_code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    error: result.error,
                })
            }
            device_envelope::Payload::FsList(request) => {
                let root = if request.browse_home {
                    if !request.workspace_id.is_empty() {
                        return device_error(
                            Some(request.request_id),
                            "invalid_workspace",
                            "browseHome 请求的 workspaceId 必须为空",
                        );
                    }
                    match std::env::var("HOME") {
                        Ok(home) if !home.is_empty() => home,
                        _ => {
                            return device_error(
                                Some(request.request_id),
                                "home_unavailable",
                                "daemon 用户 HOME 不可用",
                            )
                        }
                    }
                } else {
                    let Some(root) = workspace_root(&services.state, &request.workspace_id) else {
                        return device_error(
                            Some(request.request_id),
                            "workspace_unknown",
                            "workspaceId 不属于本 daemon 当前清单",
                        );
                    };
                    root
                };
                let (ok, entries, error, path) = crate::ops::list_dir(&root, &request.path).await;
                device_envelope::Payload::FsListed(wire::FsListed {
                    request_id: request.request_id,
                    ok,
                    entries,
                    error,
                    path,
                })
            }
            device_envelope::Payload::FsRead(request) => {
                let Some(root) = workspace_root(&services.state, &request.workspace_id) else {
                    return device_error(
                        Some(request.request_id),
                        "workspace_unknown",
                        "workspaceId 不属于本 daemon 当前清单",
                    );
                };
                let (ok, content, error) = crate::ops::read_file_text(&root, &request.path).await;
                device_envelope::Payload::FsReadResult(wire::FsReadResult {
                    request_id: request.request_id,
                    ok,
                    content,
                    error,
                })
            }
            device_envelope::Payload::FsWrite(request) => {
                let Some(root) = workspace_root(&services.state, &request.workspace_id) else {
                    return device_error(
                        Some(request.request_id),
                        "workspace_unknown",
                        "workspaceId 不属于本 daemon 当前清单",
                    );
                };
                let (ok, path, error) =
                    crate::ops::write_file(&root, &request.path, &request.data, request.temp).await;
                device_envelope::Payload::FsWriteResult(wire::FsWriteResult {
                    request_id: request.request_id,
                    ok,
                    path,
                    error,
                })
            }
            device_envelope::Payload::PortsRequest(request) => {
                let alive = services.state.lock().unwrap().alive.clone();
                let sessions =
                    tokio::task::spawn_blocking(move || crate::observed::scan_ports(&alive))
                        .await
                        .unwrap_or_default();
                device_envelope::Payload::PortsResult(wire::DevicePortsResult {
                    request_id: request.request_id,
                    sessions,
                })
            }
            // 心跳：纯 echo，不读任何状态、不做任何副作用——往返时间才近似纯链路延迟。
            device_envelope::Payload::Ping(request) => {
                device_envelope::Payload::Pong(wire::DevicePong {
                    request_id: request.request_id,
                })
            }
            other => device_error(
                request_id(&other),
                "unsupported_payload",
                "该 Device payload 不属于 worker RPC router",
            ),
        }
    }

    fn finish_call(
        &self,
        key: String,
        operation: bool,
        operation_id: Option<String>,
        mut result: device_envelope::Payload,
    ) {
        let probe = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: String::new(),
            payload: Some(result.clone()),
        };
        if encode_device_envelope(&probe).len() > MAX_DEVICE_FRAME_BYTES {
            result = device_error(
                request_id(&result),
                "response_too_large",
                "Device response 超过上限",
            );
        }
        let completed = {
            let ledger = if operation {
                &self.operations
            } else {
                &self.requests
            };
            let mut ledger = ledger.lock().unwrap();
            let Some(completed) =
                finish_call_in_ledger(&mut ledger, &key, &result, CALL_LEDGER_BYTES)
            else {
                return;
            };
            completed
        };
        let (waiters, cached_result) = completed;
        for waiter in waiters {
            let mut response = cached_result.clone();
            set_response_request_id(&mut response, &waiter.request_id);
            self.send_payload(&waiter.channel_id, response);
        }
        if let Some(operation_id) = operation_id {
            // 即使 client 侧因账本容量只能收到「结果无法保留」，prepared operation report 仍
            // 必须描述真实执行结果，不能把本地缓存压力伪装成业务执行失败。
            self.report_operation(&operation_id, &result);
        }
    }

    fn send_payload(&self, channel_id: &str, payload: device_envelope::Payload) {
        let principal = self
            .channels
            .lock()
            .unwrap()
            .get(channel_id)
            .map(|entry| entry.principal.clone());
        let Some(principal) = principal else { return };
        let scopes = self.effective_scopes(&principal);
        let required = self.response_scope(&payload);
        if scopes.is_empty() {
            self.close_channel(channel_id);
            return;
        }
        if required.is_some_and(|scope| !scopes.contains(&(scope as i32))) {
            return;
        }
        let envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.to_string(),
            payload: Some(payload),
        };
        let bytes = encode_device_envelope(&envelope);
        if bytes.len() > MAX_DEVICE_FRAME_BYTES {
            self.send_error(
                channel_id,
                request_id(envelope.payload.as_ref().unwrap()),
                "response_too_large",
                "Device response 超过上限",
            );
            return;
        }
        let mut channels = self.channels.lock().unwrap();
        let delivered = channels
            .get(channel_id)
            .is_some_and(|entry| entry.sink.try_send(bytes));
        if !delivered {
            if let Some(entry) = channels.remove(channel_id) {
                entry.sink.close();
            }
        }
    }

    fn report_operation(&self, operation_id: &str, result: &device_envelope::Payload) {
        let Some(services) = &self.services else {
            return;
        };
        let Some(daemon_id) = services.state.lock().unwrap().daemon_id.clone() else {
            return;
        };
        let mut result_envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: String::new(),
            payload: Some(result.clone()),
        };
        if let Some(payload) = result_envelope.payload.as_mut() {
            set_response_request_id(payload, "");
        }
        let (ok, error, session_id, pid) = operation_result_summary(result);
        let report = wire::DeviceOperationReport {
            operation_id: operation_id.to_string(),
            daemon_id,
            ok,
            task_id: prepared_task_id(&self.prepared.lock().unwrap(), operation_id),
            session_id,
            pid,
            exit_code: None,
            error,
            result_frame: Some(encode_device_envelope(&result_envelope)),
        };
        let bytes = wire::DaemonToServer {
            payload: Some(daemon_to_server::Payload::DeviceOperationReport(report)),
        }
        .encode_to_vec();
        let mut reports = self.operation_reports.lock().unwrap();
        reports.remove(operation_id);
        let mut pending_bytes = reports.values().map(Vec::len).sum::<usize>();
        while reports.len() >= CALL_LEDGER_LIMIT
            || bytes.len() > OPERATION_REPORT_BYTES.saturating_sub(pending_bytes)
        {
            let Some((_operation_id, removed)) = reports.pop_first() else {
                break;
            };
            pending_bytes = pending_bytes.saturating_sub(removed.len());
        }
        if bytes.len() > OPERATION_REPORT_BYTES.saturating_sub(pending_bytes) {
            // 单条 report 理论上受 MAX_DEVICE_FRAME_BYTES 约束；若未来协议放宽，仍不允许
            // durable resend cache 无界增长。本次实时发送照常尝试。
            let _ = self.to_server.try_send(bytes);
            return;
        }
        if reports.len() >= CALL_LEDGER_LIMIT {
            reports.pop_first();
        }
        reports.insert(operation_id.to_string(), bytes.clone());
        let _ = self.to_server.try_send(bytes);
    }

    pub fn server_authenticated(&self) {
        for report in self.operation_reports.lock().unwrap().values() {
            let _ = self.to_server.try_send(report.clone());
        }
        #[cfg(test)]
        self.reach_server_auth_catalog_gate();
        let request_reconciliation = {
            // 换代必须在同一个提交临界区内推进 token、清 pending/外部
            // outbox 并建立新轮；这样已摘出的旧 continuation 要么先整体
            // 提交，要么在门后被 token 拒绝。
            let _catalog_commit = self.catalog_commit_gate.lock().unwrap();
            let mut pending = self.pending_catalogs.lock().unwrap();
            pending.advance_server_generation();
            // requestId 只在一条 server WS 内有意义；旧连接的半 catalog
            // 不能在新连接继续拼接。
            pending.clear();
            let Some(services) = &self.services else {
                return;
            };
            let server_generation = pending.server_generation;
            pending.insert(
                INTERNAL_CATALOG_REQUEST_ID.into(),
                self.new_catalog_query(server_generation),
            );
            drop(pending);
            // 已完成但尚未发送的外部 response 同样属于旧 server 连接；
            // clear 与 completion publish 共用上述提交门，因此不会跨连接重放。
            services.catalogs.clear();
            let sessions: Vec<String> = services
                .state
                .lock()
                .unwrap()
                .alive
                .keys()
                .cloned()
                .collect();
            self.dirty_sessions.lock().unwrap().extend(sessions);
            true
        };
        if request_reconciliation && self.supervisor_online.load(Ordering::Acquire) {
            self.send_catalog_page(INTERNAL_CATALOG_REQUEST_ID);
        }
    }

    pub fn deliver_from_sessiond(&self, channel_id: &str, bytes: &[u8]) {
        let Some(envelope) = decode_device_envelope(bytes) else {
            return;
        };
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION || envelope.channel_id != channel_id
        {
            return;
        }
        let Some(payload) = envelope.payload.as_ref() else {
            return;
        };
        // 裸事件没有 taskId/pid，不能据此删除可复用 sessionId；但它是一次权威状态可能
        // 变化的提示。即使 control exit 随后丢失，订阅者路径也会促成完整 catalog 对账。
        if matches!(payload, device_envelope::Payload::SessionExited(_)) {
            self.request_reconciliation_catalog();
        }
        // holder 影子表（plan 088）：所有 attach 决议都经这里回流，无论目的 channel 是 client、
        // internal 还是 agent 合成身份，先登记再分派。Detached 只在「被顶掉的正是登记者」时清除。
        match payload {
            device_envelope::Payload::SessionAttached(attached) => {
                self.holders
                    .lock()
                    .unwrap()
                    .insert(attached.session_id.clone(), channel_id.to_string());
            }
            device_envelope::Payload::SessionDetached(detached) => {
                let mut holders = self.holders.lock().unwrap();
                if holders
                    .get(&detached.session_id)
                    .is_some_and(|holder| holder == channel_id)
                {
                    holders.remove(&detached.session_id);
                }
            }
            _ => {}
        }
        if channel_id == INTERNAL_CHANNEL_ID {
            self.handle_internal_response(payload);
            return;
        }
        if channel_id.starts_with(AGENT_CHANNEL_PREFIX) {
            // 只把 Attached/InputAck/Error 三类回执转给等待者：attach 附带的 snapshot/replay
            // （PtyOutput）对写入流程是噪音，clone 又贵，还可能挤满等待者的有界队列；
            // 迟到帧（等待者已撤）同样直接丢弃。
            if matches!(
                payload,
                device_envelope::Payload::SessionAttached(_)
                    | device_envelope::Payload::PtyInputAck(_)
                    | device_envelope::Payload::Error(_)
            ) {
                if let Some(waiter) = self.pending_agent_ios.lock().unwrap().get(channel_id) {
                    let _ = waiter.sender.try_send(payload.clone());
                }
            }
            return;
        }
        if let Some(operation_id) = channel_id.strip_prefix(SERVER_CHANNEL_PREFIX) {
            // 中心触发的 prepared 执行（plan 091）：合成 channel 没有 client，只把执行结果沿控制 WS
            // report 回中心。sessiond 的协议级拒绝（Error，如 operation_collision）同样是终态，
            // 必须 report，否则中心的完成原语只能等到 TTL。
            match payload {
                device_envelope::Payload::OperationAck(ack) if !ack.operation_id.is_empty() => {
                    self.report_operation(&ack.operation_id, payload);
                }
                device_envelope::Payload::Error(_) => {
                    self.report_operation(operation_id, payload);
                }
                _ => {}
            }
            return;
        }
        if let device_envelope::Payload::OperationAck(ack) = payload {
            if !ack.operation_id.is_empty() {
                self.report_operation(&ack.operation_id, payload);
            }
        }
        let principal = self
            .channels
            .lock()
            .unwrap()
            .get(channel_id)
            .map(|entry| entry.principal.clone());
        let Some(principal) = principal else { return };
        let scopes = self.effective_scopes(&principal);
        let required = self.response_scope(payload);
        if scopes.is_empty() {
            self.close_channel(channel_id);
            return;
        }
        if required.is_some_and(|scope| !scopes.contains(&(scope as i32))) {
            return;
        }
        let mut channels = self.channels.lock().unwrap();
        let Some(entry) = channels.get_mut(channel_id) else {
            return;
        };

        match payload {
            device_envelope::Payload::SessionAttached(attached) => {
                if entry.sink.try_send(bytes.to_vec()) {
                    entry.streams.insert(
                        attached.session_id.clone(),
                        StreamCursor {
                            next_seq: Some(attached.snapshot_seq.saturating_add(1)),
                            gapped: false,
                        },
                    );
                } else {
                    entry.sink.close();
                    channels.remove(channel_id);
                }
            }
            device_envelope::Payload::SessionDetached(detached) => {
                // sessiond 在 detach 时已经移除该 channel 的 subscription；同步摘 cursor，
                // 无需等下一轮 catalog 才释放历史 session ID。
                entry.streams.remove(&detached.session_id);
                if !entry.sink.try_send(bytes.to_vec()) {
                    entry.sink.close();
                    channels.remove(channel_id);
                }
            }
            device_envelope::Payload::PtyOutput(output) => {
                let cursor = entry.streams.entry(output.session_id.clone()).or_default();
                if cursor.gapped {
                    return;
                }
                let contiguous = !output.data.is_empty()
                    && output.from_seq > 0
                    && cursor.next_seq.is_none_or(|next| next == output.from_seq)
                    && output.to_seq
                        == output
                            .from_seq
                            .saturating_add(output.data.len().saturating_sub(1) as u64);
                if contiguous && entry.sink.try_send(bytes.to_vec()) {
                    cursor.next_seq = Some(output.to_seq.saturating_add(1));
                    return;
                }
                cursor.gapped = true;
                let expected_seq = cursor.next_seq.unwrap_or(output.from_seq);
                let gap = DeviceEnvelope {
                    protocol_version: DEVICE_PROTOCOL_VERSION,
                    channel_id: channel_id.to_string(),
                    payload: Some(device_envelope::Payload::PtyGap(DevicePtyGap {
                        session_id: output.session_id.clone(),
                        expected_seq,
                        // worker 不猜 sessiond retransmit 下界；fromSeq 是本次首次未投递位置，
                        // client 收到 gap 后仍必须 reattach，sessiond 会自行决定 replay/snapshot。
                        available_seq: output.from_seq,
                    })),
                };
                entry.sink.try_send_gap(encode_device_envelope(&gap));
            }
            device_envelope::Payload::PtyGap(gap) => {
                entry
                    .streams
                    .entry(gap.session_id.clone())
                    .or_default()
                    .gapped = true;
                entry.sink.try_send_gap(bytes.to_vec());
            }
            _ => {
                if !entry.sink.try_send(bytes.to_vec()) {
                    entry.sink.close();
                    channels.remove(channel_id);
                }
            }
        }
    }

    fn handle_internal_response(&self, payload: &device_envelope::Payload) {
        match payload {
            device_envelope::Payload::SessionCatalog(catalog) => {
                self.handle_catalog_page(catalog);
            }
            device_envelope::Payload::SessionSnapshot(snapshot) => {
                let read = self
                    .pending_snapshot_reads
                    .lock()
                    .unwrap()
                    .remove(&snapshot.request_id);
                if let Some(read) = read {
                    // 中心按需读（plan 091）：原样交给等待者，不进 checkpoint outbox。
                    let _ = read.sender.send(Ok(snapshot.ansi_snapshot.clone()));
                    return;
                }
                let Some(expected) = self
                    .pending_snapshots
                    .lock()
                    .unwrap()
                    .remove(&snapshot.request_id)
                else {
                    return;
                };
                if snapshot.session_id != expected.session_id
                    || snapshot.ansi_snapshot.len() > MAX_SESSION_CHECKPOINT_BYTES
                {
                    return;
                }
                let Some(services) = &self.services else {
                    return;
                };
                let current_matches = services
                    .state
                    .lock()
                    .unwrap()
                    .alive
                    .get(&snapshot.session_id)
                    .is_some_and(|(task_id, pid)| {
                        task_id == &expected.task_id && *pid == expected.pid
                    });
                if !current_matches {
                    return;
                }
                let checkpoint = SessionCheckpoint {
                    session_id: snapshot.session_id.clone(),
                    task_id: expected.task_id,
                    snapshot_seq: snapshot.snapshot_seq,
                    ansi_snapshot: snapshot.ansi_snapshot.clone(),
                    cols: snapshot.cols,
                    rows: snapshot.rows,
                    captured_at: epoch_ms(),
                    title: snapshot.title.clone(),
                };
                let payload = daemon_to_server::Payload::SessionCheckpoint(checkpoint);
                services.checkpoints.publish(
                    snapshot.session_id.clone(),
                    coflux_protocol::wire::DaemonToServer {
                        payload: Some(payload),
                    }
                    .encode_to_vec(),
                );
            }
            device_envelope::Payload::Error(error) => {
                if let Some(request_id) = &error.request_id {
                    let read = self
                        .pending_snapshot_reads
                        .lock()
                        .unwrap()
                        .remove(request_id);
                    if let Some(read) = read {
                        let _ = read
                            .sender
                            .send(Err(format!("{}: {}", error.code, error.message)));
                    }
                    self.pending_snapshots.lock().unwrap().remove(request_id);
                    let mut pending = self.pending_catalogs.lock().unwrap();
                    let logical_request_id = pending
                        .queries
                        .iter()
                        .find(|(_, query)| query.wire_request_id == *request_id)
                        .map(|(logical_request_id, _)| logical_request_id.clone());
                    if let Some(logical_request_id) = logical_request_id {
                        let query = pending.remove(&logical_request_id).unwrap();
                        let rerun = query.rerun;
                        let mut restarted = self.new_catalog_query(pending.server_generation);
                        restarted.rerun = rerun;
                        pending.insert(logical_request_id, restarted);
                    }
                }
            }
            _ => {}
        }
    }

    fn handle_catalog_page(&self, catalog: &DeviceSessionCatalog) {
        let legacy = catalog.snapshot_owner_id.is_empty()
            && catalog.snapshot_epoch == 0
            && catalog.session_offset == 0
            && catalog.exit_offset == 0
            && catalog.next_session_offset == 0
            && catalog.next_exit_offset == 0
            && !catalog.complete
            && !catalog.reset;
        let mut complete_query = None;
        let mut request_next = false;
        let mut request_rerun = false;
        let logical_request_id;
        {
            let mut pending = self.pending_catalogs.lock().unwrap();
            let Some(found_logical_request_id) = pending
                .queries
                .iter()
                .find(|(_, query)| query.wire_request_id == catalog.request_id)
                .map(|(logical_request_id, _)| logical_request_id.clone())
            else {
                return;
            };
            logical_request_id = found_logical_request_id;
            let mut query = pending.remove(&logical_request_id).unwrap();
            if catalog.reset {
                let rerun = query.rerun;
                let mut restarted = self.new_catalog_query(pending.server_generation);
                restarted.rerun = rerun;
                pending.insert(logical_request_id.clone(), restarted);
                request_next = true;
            } else {
                let epoch_matches = legacy
                    || query.snapshot_owner_id.is_empty()
                    || (query.snapshot_owner_id == catalog.snapshot_owner_id
                        && query.snapshot_epoch == catalog.snapshot_epoch);
                // timeout 重投同一 offset 后，两份响应都可能抵达。已完全落在当前累计范围内
                // 的旧页是无害重复，不能把它当乱序页重置整份快照。
                let stale_page = !legacy
                    && epoch_matches
                    && catalog.session_offset <= query.next_session_offset
                    && catalog.exit_offset <= query.next_exit_offset
                    && catalog.next_session_offset <= query.next_session_offset
                    && catalog.next_exit_offset <= query.next_exit_offset
                    && (catalog.session_offset != query.next_session_offset
                        || catalog.exit_offset != query.next_exit_offset);
                if stale_page {
                    pending.insert(logical_request_id.clone(), query);
                    return;
                }
                query.sent_at = None;
                let offsets_match = legacy
                    || (catalog.session_offset == query.next_session_offset
                        && catalog.exit_offset == query.next_exit_offset
                        && catalog.next_session_offset >= catalog.session_offset
                        && catalog.next_exit_offset >= catalog.exit_offset
                        && catalog.next_session_offset - catalog.session_offset
                            == catalog.sessions.len() as u32
                        && catalog.next_exit_offset - catalog.exit_offset
                            == catalog.exits.len() as u32);
                let page_progressed = legacy
                    || catalog.complete
                    || catalog.next_session_offset > catalog.session_offset
                    || catalog.next_exit_offset > catalog.exit_offset;
                let added_bytes = catalog
                    .sessions
                    .iter()
                    .map(|entry| entry.encoded_len())
                    .sum::<usize>()
                    + catalog
                        .exits
                        .iter()
                        .map(|entry| entry.encoded_len())
                        .sum::<usize>();
                let aggregate_with_page = pending
                    .retained_bytes(&logical_request_id)
                    .saturating_add(query.retained_bytes)
                    .saturating_add(added_bytes);
                let within_bounds = query.sessions.len() + catalog.sessions.len()
                    <= CATALOG_SESSION_LIMIT
                    && query.exits.len() + catalog.exits.len() <= CATALOG_EXIT_LIMIT
                    && added_bytes <= CATALOG_ASSEMBLY_BYTES.saturating_sub(query.retained_bytes)
                    && aggregate_with_page <= CatalogState::retained_limit(&logical_request_id);
                if !epoch_matches || !offsets_match || !page_progressed || !within_bounds {
                    // 半快照绝不外发；同 requestId 从权威 owner 的新首页重新开始。
                    let rerun = query.rerun;
                    let mut restarted = self.new_catalog_query(pending.server_generation);
                    restarted.rerun = rerun;
                    pending.insert(logical_request_id.clone(), restarted);
                    request_next = true;
                } else {
                    if !legacy && query.snapshot_owner_id.is_empty() {
                        query.snapshot_owner_id = catalog.snapshot_owner_id.clone();
                        query.snapshot_epoch = catalog.snapshot_epoch;
                    }
                    query.next_session_offset = if legacy {
                        catalog.sessions.len() as u32
                    } else {
                        catalog.next_session_offset
                    };
                    query.next_exit_offset = if legacy {
                        catalog.exits.len() as u32
                    } else {
                        catalog.next_exit_offset
                    };
                    query.retained_bytes += added_bytes;
                    query.sessions.extend(catalog.sessions.iter().cloned());
                    query.exits.extend(catalog.exits.iter().cloned());
                    if legacy || catalog.complete {
                        let rerun =
                            query.rerun && logical_request_id == INTERNAL_CATALOG_REQUEST_ID;
                        query.rerun = false;
                        complete_query = Some(query);
                        if rerun {
                            let server_generation = pending.server_generation;
                            pending.insert(
                                logical_request_id.clone(),
                                self.new_catalog_query(server_generation),
                            );
                            request_rerun = true;
                        }
                    } else {
                        pending.insert(logical_request_id.clone(), query);
                        request_next = true;
                    }
                }
            }
        }
        if request_next {
            self.send_catalog_page(&logical_request_id);
        }
        let Some(query) = complete_query else { return };
        #[cfg(test)]
        self.pause_catalog_completion(CatalogCompletionHookPhase::AfterExtract);
        let Some(services) = &self.services else {
            if request_rerun {
                self.send_catalog_page(&logical_request_id);
            }
            return;
        };
        // final 页已经从 pending 摘出，所以必须带着 query 的 server generation
        // 重新进入提交门。锁覆盖下方全部 effects 和 external publish；
        // 不能改成裸 atomic compare，否则 check 后认证换代仍可以插入。
        let catalog_commit = self.catalog_commit_gate.lock().unwrap();
        let current_generation = self.pending_catalogs.lock().unwrap().server_generation;
        if query.server_generation != current_generation {
            return;
        }
        #[cfg(test)]
        self.pause_catalog_completion(CatalogCompletionHookPhase::AfterCommitGate);
        let live = query
            .sessions
            .iter()
            .map(|session| session.session_id.clone())
            .collect::<HashSet<_>>();
        let new_alive = query
            .sessions
            .iter()
            .map(|session| {
                (
                    session.session_id.clone(),
                    (session.task_id.clone(), session.pid),
                )
            })
            .collect::<HashMap<_, _>>();
        // 完整 catalog 是 incarnation 的权威提交点；同 sessionId 只要 taskId 或 pid
        // 变化，就必须先清旧 cursor/holder/agent/snapshot，再把新 incarnation 标 dirty。
        let changed_or_removed = {
            let mut state = services.state.lock().unwrap();
            let changed = state
                .alive
                .iter()
                .filter(|(session_id, identity)| new_alive.get(*session_id) != Some(*identity))
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            state.alive = new_alive;
            changed
        };
        let mut stale_derived = changed_or_removed.into_iter().collect::<HashSet<_>>();
        for entry in self.channels.lock().unwrap().values() {
            stale_derived.extend(
                entry
                    .streams
                    .keys()
                    .filter(|session_id| !live.contains(*session_id))
                    .cloned(),
            );
        }
        stale_derived.extend(
            self.holders
                .lock()
                .unwrap()
                .keys()
                .filter(|session_id| !live.contains(*session_id))
                .cloned(),
        );
        stale_derived.extend(
            self.agent_io_states
                .lock()
                .unwrap()
                .keys()
                .filter(|session_id| !live.contains(*session_id))
                .cloned(),
        );
        stale_derived.extend(
            self.pending_snapshots
                .lock()
                .unwrap()
                .values()
                .filter(|pending| !live.contains(&pending.session_id))
                .map(|pending| pending.session_id.clone()),
        );
        stale_derived.extend(
            self.pending_agent_ios
                .lock()
                .unwrap()
                .values()
                .filter(|pending| !live.contains(&pending.session_id))
                .map(|pending| pending.session_id.clone()),
        );
        for session_id in stale_derived {
            self.session_exited(&session_id);
        }
        for session_id in &live {
            self.cancel_session_exit(session_id);
            self.mark_session_dirty(session_id);
        }
        // tombstone 只在同一份完整快照中没有同 ID live session 时转成可靠 exit；否则它
        // 可能属于已被复用 ID 的旧 incarnation，裸 SessionExit 会误杀新 task。
        // exit 是 daemon/sessiond 权威事件，不是 server requestId 的响应：它在同一
        // 提交门内产生，若 completion 先线性化则可跨 WS 可靠重放；若换代先
        // 线性化，旧 generation 在上方被拒绝，不会产生 exit。
        for exit in &query.exits {
            if !live.contains(&exit.session_id) {
                self.report_session_exit(&exit.session_id, exit.exit_code);
            }
        }
        if logical_request_id != INTERNAL_CATALOG_REQUEST_ID {
            let session_count = query.sessions.len() as u32;
            let exit_count = query.exits.len() as u32;
            let payload = daemon_to_server::Payload::SessionCatalog(DeviceSessionCatalog {
                request_id: logical_request_id.clone(),
                sessions: query.sessions,
                exits: query.exits,
                snapshot_owner_id: query.snapshot_owner_id,
                snapshot_epoch: query.snapshot_epoch,
                session_offset: 0,
                exit_offset: 0,
                next_session_offset: session_count,
                next_exit_offset: exit_count,
                complete: true,
                reset: false,
            });
            let bytes = coflux_protocol::wire::DaemonToServer {
                payload: Some(payload),
            }
            .encode_to_vec();
            if !services.catalogs.publish(logical_request_id.clone(), bytes) {
                eprintln!("[worker] 完整 catalog 超过 outbox 硬上限 request={logical_request_id}");
            }
        }
        drop(catalog_commit);
        if request_rerun {
            self.send_catalog_page(&logical_request_id);
        }
    }

    fn send_error(&self, channel_id: &str, request_id: Option<String>, code: &str, message: &str) {
        let envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.to_string(),
            payload: Some(device_envelope::Payload::Error(DeviceError {
                request_id,
                code: code.to_string(),
                message: message.to_string(),
            })),
        };
        if let Some(entry) = self.channels.lock().unwrap().get(channel_id) {
            entry.sink.try_send(encode_device_envelope(&envelope));
        }
    }
}

fn start_call(
    ledger: &Mutex<CallLedger>,
    key: String,
    fingerprint: Vec<u8>,
    waiter: ResponseWaiter,
) -> Result<CallStart, CallStartError> {
    let mut ledger = ledger.lock().unwrap();
    start_call_with_limits(
        &mut ledger,
        key,
        fingerprint,
        waiter,
        CALL_LEDGER_LIMIT,
        CALL_LEDGER_BYTES,
    )
}

fn start_call_with_limits(
    ledger: &mut CallLedger,
    key: String,
    fingerprint: Vec<u8>,
    waiter: ResponseWaiter,
    record_limit: usize,
    byte_limit: usize,
) -> Result<CallStart, CallStartError> {
    if let Some(record) = ledger.entries.get(&key) {
        if record.fingerprint != fingerprint {
            return Err(CallStartError::Collision);
        }
        if let Some(result) = &record.result {
            return Ok(CallStart::Cached(result.clone()));
        }
        if !record.waiters.iter().any(|existing| {
            existing.channel_id == waiter.channel_id && existing.request_id == waiter.request_id
        }) {
            let waiter_bytes = response_waiter_bytes(&waiter);
            while waiter_bytes > byte_limit.saturating_sub(ledger.bytes) {
                if !evict_one_completed(ledger, Some(&key)) {
                    break;
                }
            }
            if waiter_bytes > byte_limit.saturating_sub(ledger.bytes) {
                return Err(CallStartError::Full);
            }
            ledger.entries.get_mut(&key).unwrap().waiters.push(waiter);
            ledger.bytes = ledger.bytes.saturating_add(waiter_bytes);
        }
        return Ok(CallStart::Pending);
    }
    let record = CallRecord {
        fingerprint,
        result: None,
        waiters: vec![waiter],
    };
    let record_bytes = call_record_bytes(&key, &record);
    while ledger.entries.len() >= record_limit
        || record_bytes > byte_limit.saturating_sub(ledger.bytes)
    {
        if !evict_one_completed(ledger, None) {
            break;
        }
    }
    if ledger.entries.len() >= record_limit
        || record_bytes > byte_limit.saturating_sub(ledger.bytes)
    {
        return Err(CallStartError::Full);
    }
    ledger.bytes = ledger.bytes.saturating_add(record_bytes);
    ledger.entries.insert(key, record);
    Ok(CallStart::Execute)
}

fn new_agent_io_state() -> AgentIoState {
    AgentIoState {
        client_instance_id: fresh_agent_client_instance_id(),
        transport_generation: 0,
        next_input_seq: 1,
        in_flight: false,
        identity_count: 1,
        blocked: false,
    }
}

fn fresh_agent_client_instance_id() -> String {
    let mut random = [0u8; 16];
    OsRng.fill_bytes(&mut random);
    format!("{AGENT_CHANNEL_PREFIX}client-{}", hex::encode(random))
}

/// 结果未知后绝不能拿不同 data 复用旧 seq。identity 总数也必须有界；耗尽后封住该
/// session 的 agent 输入，等待 worker/session 生命周期自然清空状态。
fn rotate_agent_identity(state: &mut AgentIoState) -> bool {
    state.in_flight = false;
    if state.identity_count >= AGENT_IDENTITY_LIMIT_PER_SESSION {
        state.blocked = true;
        return false;
    }
    state.client_instance_id = fresh_agent_client_instance_id();
    state.transport_generation = 0;
    state.next_input_seq = 1;
    state.identity_count += 1;
    true
}

fn call_record_bytes(key: &str, record: &CallRecord) -> usize {
    call_record_base_bytes(key, record.fingerprint.len())
        .saturating_add(
            record
                .result
                .as_ref()
                .map_or(CALL_LEDGER_RESULT_RESERVE_BYTES, call_result_bytes),
        )
        .saturating_add(
            record
                .waiters
                .iter()
                .map(response_waiter_bytes)
                .sum::<usize>(),
        )
}

fn call_record_base_bytes(key: &str, fingerprint_bytes: usize) -> usize {
    std::mem::size_of::<String>()
        .saturating_add(std::mem::size_of::<CallRecord>())
        .saturating_add(key.len())
        .saturating_add(fingerprint_bytes)
}

fn response_waiter_bytes(waiter: &ResponseWaiter) -> usize {
    std::mem::size_of::<ResponseWaiter>()
        .saturating_add(waiter.channel_id.len())
        .saturating_add(waiter.request_id.len())
}

fn call_result_bytes(payload: &device_envelope::Payload) -> usize {
    encode_device_envelope(&DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: String::new(),
        payload: Some(payload.clone()),
    })
    .len()
}

fn evict_one_completed(ledger: &mut CallLedger, excluded_key: Option<&str>) -> bool {
    let completed = ledger
        .entries
        .iter()
        .find(|(entry_key, record)| {
            excluded_key.is_none_or(|excluded| entry_key.as_str() != excluded)
                && record.result.is_some()
        })
        .map(|(entry_key, record)| (entry_key.clone(), call_record_bytes(entry_key, record)));
    let Some((completed, bytes)) = completed else {
        return false;
    };
    ledger.entries.remove(&completed);
    ledger.bytes = ledger.bytes.saturating_sub(bytes);
    true
}

fn finish_call_in_ledger(
    ledger: &mut CallLedger,
    key: &str,
    result: &device_envelope::Payload,
    byte_limit: usize,
) -> Option<(Vec<ResponseWaiter>, device_envelope::Payload)> {
    let record = ledger.entries.get(key)?;
    let current_bytes = call_record_bytes(key, record);
    let base_bytes = call_record_base_bytes(key, record.fingerprint.len());
    let result_bytes = call_result_bytes(result);
    let completed_bytes = base_bytes.saturating_add(result_bytes);

    while completed_bytes > byte_limit.saturating_sub(ledger.bytes.saturating_sub(current_bytes)) {
        if !evict_one_completed(ledger, Some(key)) {
            break;
        }
    }

    let available = byte_limit.saturating_sub(ledger.bytes.saturating_sub(current_bytes));
    let cached_result = if completed_bytes <= available {
        result.clone()
    } else {
        let fallback = device_error(
            None,
            "result_capacity_exceeded",
            "请求已经执行，但结果无法保留；本 worker 不会自动重试",
        );
        debug_assert!(call_result_bytes(&fallback) <= CALL_LEDGER_RESULT_RESERVE_BYTES);
        fallback
    };
    let replacement_bytes = base_bytes.saturating_add(call_result_bytes(&cached_result));
    // pending record 已预留 fallback 空间；即便没有任何 completed entry 可淘汰，替换后也
    // 必须仍在硬上限内。若未来改大错误文案却忘了同步 reserve，宁可摘掉记录并把确定错误
    // 投递给现有 waiter，也不能静默越过硬上限或让 waiter 永久悬挂。
    if replacement_bytes > byte_limit.saturating_sub(ledger.bytes.saturating_sub(current_bytes)) {
        let record = ledger.entries.remove(key)?;
        ledger.bytes = ledger.bytes.saturating_sub(current_bytes);
        return Some((record.waiters, cached_result));
    }
    let record = ledger.entries.get_mut(key)?;
    let waiters = std::mem::take(&mut record.waiters);
    record.result = Some(cached_result.clone());
    ledger.bytes = ledger
        .bytes
        .saturating_sub(current_bytes)
        .saturating_add(replacement_bytes);
    debug_assert!(ledger.bytes <= byte_limit);
    Some((waiters, cached_result))
}

fn workspace_root(state: &Arc<Mutex<WorkerState>>, workspace_id: &str) -> Option<String> {
    if workspace_id.is_empty() {
        return None;
    }
    state
        .lock()
        .unwrap()
        .workspaces
        .get(workspace_id)
        .map(|(path, _default_branch)| path.clone())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FRAME_ID_BYTES
        && !value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
}

fn device_error(request_id: Option<String>, code: &str, message: &str) -> device_envelope::Payload {
    device_envelope::Payload::Error(DeviceError {
        request_id,
        code: code.to_string(),
        message: message.to_string(),
    })
}

fn routed_to_sessiond(payload: &device_envelope::Payload) -> bool {
    matches!(
        payload,
        device_envelope::Payload::SessionCatalogRequest(_)
            | device_envelope::Payload::SessionAttach(_)
            | device_envelope::Payload::SessionSnapshotRequest(_)
            | device_envelope::Payload::PtyInput(_)
            | device_envelope::Payload::PtyResize(_)
            | device_envelope::Payload::SessionStop(_)
            | device_envelope::Payload::SessionCreate(_)
            | device_envelope::Payload::ExitAck(_)
    )
}

fn worker_operation_id(payload: &device_envelope::Payload) -> Option<&str> {
    match payload {
        device_envelope::Payload::ProjectValidate(value) => Some(&value.operation_id),
        device_envelope::Payload::WorktreeAdd(value) => Some(&value.operation_id),
        device_envelope::Payload::WorktreeRemove(value) => Some(&value.operation_id),
        device_envelope::Payload::ExecRun(value) => value.operation_id.as_deref(),
        device_envelope::Payload::FsWrite(value) => Some(&value.operation_id),
        _ => None,
    }
}

fn call_fingerprint(envelope: &DeviceEnvelope, operation: bool) -> Vec<u8> {
    let mut canonical = envelope.clone();
    canonical.channel_id.clear();
    if operation {
        if let Some(payload) = canonical.payload.as_mut() {
            clear_request_id(payload);
        }
    }
    encode_device_envelope(&canonical)
}

fn clear_request_id(payload: &mut device_envelope::Payload) {
    match payload {
        device_envelope::Payload::SessionCatalogRequest(value) => value.request_id.clear(),
        device_envelope::Payload::SessionAttach(value) => value.request_id.clear(),
        device_envelope::Payload::SessionSnapshotRequest(value) => value.request_id.clear(),
        device_envelope::Payload::PtyInput(value) => value.request_id.clear(),
        device_envelope::Payload::PtyResize(value) => value.request_id.clear(),
        device_envelope::Payload::SessionStop(value) => value.request_id.clear(),
        device_envelope::Payload::SessionCreate(value) => value.request_id.clear(),
        device_envelope::Payload::ProjectValidate(value) => value.request_id.clear(),
        device_envelope::Payload::WorktreeAdd(value) => value.request_id.clear(),
        device_envelope::Payload::ExecRun(value) => value.request_id.clear(),
        device_envelope::Payload::FsList(value) => value.request_id.clear(),
        device_envelope::Payload::FsRead(value) => value.request_id.clear(),
        device_envelope::Payload::FsWrite(value) => value.request_id.clear(),
        device_envelope::Payload::PortsRequest(value) => value.request_id.clear(),
        _ => {}
    }
}

fn set_response_request_id(payload: &mut device_envelope::Payload, request_id: &str) {
    match payload {
        device_envelope::Payload::SessionCatalog(value) => {
            value.request_id = request_id.to_string()
        }
        device_envelope::Payload::SessionAttached(value) => {
            value.request_id = request_id.to_string()
        }
        device_envelope::Payload::SessionSnapshot(value) => {
            value.request_id = request_id.to_string()
        }
        device_envelope::Payload::OperationAck(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::ProjectValidated(value) => {
            value.request_id = request_id.to_string()
        }
        device_envelope::Payload::WorktreeAdded(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::ExecResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::FsListed(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::FsReadResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::FsWriteResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::PortsResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::Pong(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::Error(value) => {
            value.request_id = (!request_id.is_empty()).then(|| request_id.to_string())
        }
        _ => {}
    }
}

fn operation_result_summary(
    payload: &device_envelope::Payload,
) -> (bool, Option<String>, Option<String>, Option<i32>) {
    match payload {
        device_envelope::Payload::ProjectValidated(value) => {
            (value.ok, value.error.clone(), None, None)
        }
        device_envelope::Payload::WorktreeAdded(value) => {
            (value.ok, value.error.clone(), None, None)
        }
        device_envelope::Payload::OperationAck(value) => (
            value.ok,
            value.error.clone(),
            value.session_id.clone(),
            value.pid,
        ),
        device_envelope::Payload::ExecResult(value) => (value.ok, value.error.clone(), None, None),
        device_envelope::Payload::FsWriteResult(value) => {
            (value.ok, value.error.clone(), None, None)
        }
        device_envelope::Payload::Error(value) => (false, Some(value.message.clone()), None, None),
        _ => (true, None, None, None),
    }
}

fn prepared_task_id(
    prepared: &HashMap<String, PreparedRecord>,
    operation_id: &str,
) -> Option<String> {
    let record = prepared.get(operation_id)?;
    let envelope = decode_device_envelope(&record.frame)?;
    match envelope.payload? {
        device_envelope::Payload::SessionCreate(request) => Some(request.task_id),
        _ => None,
    }
}

fn validate_relay_dial(dial: &DeviceRelayDial) -> Result<(), String> {
    if dial.protocol_version != DEVICE_PROTOCOL_VERSION {
        return Err("relay Device protocol version 不兼容".into());
    }
    if !valid_id(&dial.channel_id)
        || dial.channel_id.starts_with("__coflux-")
        || !valid_id(&dial.account_id)
        || !valid_id(&dial.client_instance_id)
        || dial.transport_generation == 0
    {
        return Err("relay principal/channel/generation 无效".into());
    }
    if !dial.relay_url.starts_with("ws://") && !dial.relay_url.starts_with("wss://") {
        return Err("relay URL scheme 无效".into());
    }
    normalized_scopes(dial.scopes.clone()).map(|_| ())
}

fn validate_p2p_channel_grant(grant: &DeviceP2pChannelGrant) -> Result<(), String> {
    if grant.protocol_version != DEVICE_PROTOCOL_VERSION {
        return Err("p2p Device protocol version 不兼容".into());
    }
    if !valid_id(&grant.channel_id)
        || grant.channel_id.starts_with("__coflux-")
        || !valid_id(&grant.account_id)
        || !valid_id(&grant.client_instance_id)
        || grant.transport_generation == 0
    {
        return Err("p2p principal/channel/generation 无效".into());
    }
    normalized_scopes(grant.scopes.clone()).map(|_| ())
}

fn normalized_scopes(mut scopes: Vec<i32>) -> Result<Vec<i32>, String> {
    if scopes.is_empty()
        || scopes.len() > 4
        || scopes.iter().any(|scope| {
            !matches!(
                DeviceScope::try_from(*scope),
                Ok(DeviceScope::SessionRead
                    | DeviceScope::SessionControl
                    | DeviceScope::Rpc
                    | DeviceScope::Lifecycle)
            )
        })
    {
        return Err("relay scope 无效".into());
    }
    scopes.sort_unstable();
    scopes.dedup();
    Ok(scopes)
}

fn required_scope(payload: &device_envelope::Payload) -> Option<DeviceScope> {
    match payload {
        device_envelope::Payload::SessionCatalogRequest(_)
        | device_envelope::Payload::SessionAttach(_)
        | device_envelope::Payload::SessionSnapshotRequest(_)
        | device_envelope::Payload::ExitAck(_) => Some(DeviceScope::SessionRead),
        device_envelope::Payload::PtyInput(_)
        | device_envelope::Payload::PtyResize(_)
        | device_envelope::Payload::SessionStop(_) => Some(DeviceScope::SessionControl),
        device_envelope::Payload::ExecRun(_)
        | device_envelope::Payload::FsList(_)
        | device_envelope::Payload::FsRead(_)
        | device_envelope::Payload::FsWrite(_)
        | device_envelope::Payload::PortsRequest(_) => Some(DeviceScope::Rpc),
        // 心跳取最低权限：它是纯 echo，不读任何状态，要 RPC scope 只会把它挡在
        // 没有 lease 的通道外——而恰恰是那种通道最需要被探活。
        device_envelope::Payload::Ping(_) => Some(DeviceScope::SessionRead),
        device_envelope::Payload::SessionCreate(_)
        | device_envelope::Payload::ProjectValidate(_)
        | device_envelope::Payload::WorktreeAdd(_)
        | device_envelope::Payload::WorktreeRemove(_) => Some(DeviceScope::Lifecycle),
        _ => None,
    }
}

fn response_required_scope(payload: &device_envelope::Payload) -> Option<DeviceScope> {
    match payload {
        device_envelope::Payload::SessionCatalog(_)
        | device_envelope::Payload::SessionAttached(_)
        | device_envelope::Payload::SessionSnapshot(_)
        | device_envelope::Payload::PtyOutput(_)
        | device_envelope::Payload::PtyGap(_)
        | device_envelope::Payload::SessionDetached(_)
        | device_envelope::Payload::SessionExited(_) => Some(DeviceScope::SessionRead),
        device_envelope::Payload::PtyInputAck(_) => Some(DeviceScope::SessionControl),
        device_envelope::Payload::ExecResult(_)
        | device_envelope::Payload::FsListed(_)
        | device_envelope::Payload::FsReadResult(_)
        | device_envelope::Payload::FsWriteResult(_)
        | device_envelope::Payload::PortsResult(_) => Some(DeviceScope::Rpc),
        device_envelope::Payload::ProjectValidated(_)
        | device_envelope::Payload::WorktreeAdded(_) => Some(DeviceScope::Lifecycle),
        _ => None,
    }
}

fn prepared_operation_id(payload: &device_envelope::Payload) -> Option<&str> {
    match payload {
        device_envelope::Payload::SessionCreate(value) => Some(&value.operation_id),
        device_envelope::Payload::ProjectValidate(value) => Some(&value.operation_id),
        device_envelope::Payload::WorktreeAdd(value) => Some(&value.operation_id),
        device_envelope::Payload::WorktreeRemove(value) => Some(&value.operation_id),
        _ => None,
    }
}

fn request_id(payload: &device_envelope::Payload) -> Option<String> {
    match payload {
        device_envelope::Payload::SessionCatalogRequest(value) => Some(value.request_id.clone()),
        device_envelope::Payload::SessionAttach(value) => Some(value.request_id.clone()),
        device_envelope::Payload::SessionSnapshotRequest(value) => Some(value.request_id.clone()),
        device_envelope::Payload::PtyInput(value) => Some(value.request_id.clone()),
        device_envelope::Payload::PtyResize(value) => Some(value.request_id.clone()),
        device_envelope::Payload::SessionStop(value) => Some(value.request_id.clone()),
        device_envelope::Payload::SessionCreate(value) => Some(value.request_id.clone()),
        device_envelope::Payload::ProjectValidate(value) => Some(value.request_id.clone()),
        device_envelope::Payload::WorktreeAdd(value) => Some(value.request_id.clone()),
        device_envelope::Payload::ExecRun(value) => Some(value.request_id.clone()),
        device_envelope::Payload::FsList(value) => Some(value.request_id.clone()),
        device_envelope::Payload::FsRead(value) => Some(value.request_id.clone()),
        device_envelope::Payload::FsWrite(value) => Some(value.request_id.clone()),
        device_envelope::Payload::PortsRequest(value) => Some(value.request_id.clone()),
        device_envelope::Payload::Ping(value) => Some(value.request_id.clone()),
        _ => None,
    }
}

fn reserve_bytes(pending: &AtomicUsize, length: usize, limit: usize) -> bool {
    let mut current = pending.load(Ordering::Acquire);
    loop {
        if length > limit.saturating_sub(current) {
            return false;
        }
        match pending.compare_exchange_weak(
            current,
            current + length,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use coflux_protocol::wire::{
        DeviceExecRun, DevicePortsRequest, DevicePtyInputAck, DevicePtyOutput,
        DeviceSessionAttached, DeviceSessionCatalogRequest, DeviceSessionCreate,
        DeviceSessionExited, LocalBrowserGrant, OnlineDeviceLease,
    };
    use p256::ecdsa::SigningKey;

    struct TestRuntime {
        home: String,
        auth: Arc<LocalAuth>,
        runtime: Arc<DeviceRuntime>,
        state: Arc<Mutex<WorkerState>>,
        checkpoints: Arc<CheckpointOutbox>,
        catalogs: Arc<CatalogOutbox>,
        exits: Arc<ExitOutbox>,
        local_id: String,
        local_rx: ChannelReceiver,
        relay_id: String,
        relay_rx: ChannelReceiver,
        from_supervisor: mpsc::Receiver<Vec<u8>>,
    }

    fn test_runtime() -> TestRuntime {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let home_path = std::env::temp_dir().join(format!(
            "coflux-device-router-{}-{}",
            std::process::id(),
            hex::encode(random)
        ));
        std::fs::create_dir_all(&home_path).unwrap();
        let home = home_path.to_string_lossy().into_owned();
        let auth = Arc::new(LocalAuth::load_or_create(&home).unwrap());
        auth.configure_origins(vec!["https://p.coflux.dev".into()])
            .unwrap();
        let browser_key = SigningKey::random(&mut OsRng);
        let browser_public_key = browser_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        auth.install_grant(
            LocalBrowserGrant {
                grant_id: "grant-1".into(),
                account_id: "account-1".into(),
                daemon_id: "daemon-1".into(),
                origin: "https://p.coflux.dev".into(),
                public_key_sec1: browser_public_key.clone(),
                offline_scopes: vec![
                    DeviceScope::SessionRead as i32,
                    DeviceScope::SessionControl as i32,
                ],
                created_at: epoch_ms(),
            },
            "daemon-1",
        )
        .unwrap();
        auth.set_server_online(true);
        auth.install_lease(
            OnlineDeviceLease {
                lease_id: "lease-1".into(),
                grant_id: "grant-1".into(),
                account_id: "account-1".into(),
                daemon_id: "daemon-1".into(),
                scopes: vec![DeviceScope::Rpc as i32, DeviceScope::Lifecycle as i32],
                expires_at: epoch_ms() + 60_000.0,
            },
            "daemon-1",
        )
        .unwrap();

        let cfg = Arc::new(Config {
            server_url: "ws://127.0.0.1:1/daemon".into(),
            device_name: "test".into(),
            host: "localhost".into(),
            platform: std::env::consts::OS.into(),
            worker_version: "test".into(),
            supervisor_version: "test".into(),
            arch: std::env::consts::ARCH.into(),
            home: home.clone(),
            cred_path: format!("{home}/credentials.json"),
            worktrees_dir: format!("{home}/worktrees"),
            sock_path: format!("{home}/supervisor.sock"),
            reconnect_base_ms: 1,
            reconnect_cap_ms: 1,
            idle_ping_ms: 1_000,
            idle_grace_ms: 1_000,
            connect_timeout_ms: 1_000,
            local_gateway_port: 0,
        });
        let mut workspaces = HashMap::new();
        workspaces.insert("workspace-1".into(), (home.clone(), "main".into()));
        let state = Arc::new(Mutex::new(WorkerState {
            agent_logs: HashMap::new(),
            authed: true,
            sup_synced: true,
            snapshot_owner_id: "owner-1".into(),
            snapshot_epoch: 1,
            sup_resync_nonce: None,
            daemon_id: Some("daemon-1".into()),
            gateway_port: Some(8788),
            alive: HashMap::new(),
            credentials: None,
            pending_auth_expires_at: None,
            workspaces,
            last_branches: HashMap::new(),
            last_diffs: HashMap::new(),
            conn_state: crate::conn_state::ConnState::new(&home),
        }));
        let (to_supervisor, from_supervisor) = mpsc::channel(32);
        let (to_server, _from_server) = mpsc::channel(32);
        let checkpoints = Arc::new(CheckpointOutbox::default());
        let catalogs = Arc::new(CatalogOutbox::default());
        let exits = Arc::new(ExitOutbox::default());
        let runtime = DeviceRuntime::production(
            Some(auth.clone()),
            to_supervisor,
            to_server,
            checkpoints.clone(),
            catalogs.clone(),
            exits.clone(),
            state.clone(),
            cfg,
        );
        runtime.supervisor_online.store(true, Ordering::Release);
        let (local_id, local_rx) = runtime
            .open_local(AuthenticatedLocal {
                principal: LocalPrincipal {
                    grant_id: "grant-1".into(),
                    account_id: "account-1".into(),
                    daemon_id: "daemon-1".into(),
                    origin: "https://p.coflux.dev".into(),
                    browser_public_key_sec1: browser_public_key,
                    client_instance_id: "client-1".into(),
                    transport_generation: 1,
                    lease_id: Some("lease-1".into()),
                },
                scopes: vec![
                    DeviceScope::SessionRead as i32,
                    DeviceScope::SessionControl as i32,
                    DeviceScope::Rpc as i32,
                    DeviceScope::Lifecycle as i32,
                ],
            })
            .unwrap();
        let relay_id = "relay-1".to_string();
        let relay_rx = runtime
            .open_relay(&DeviceRelayDial {
                channel_id: relay_id.clone(),
                relay_url: "ws://127.0.0.1:1/v1/pipe?token=test.test".into(),
                account_id: "account-1".into(),
                client_instance_id: "client-1".into(),
                transport_generation: 2,
                scopes: vec![
                    DeviceScope::SessionRead as i32,
                    DeviceScope::SessionControl as i32,
                    DeviceScope::Rpc as i32,
                ],
                protocol_version: DEVICE_PROTOCOL_VERSION,
            })
            .unwrap();
        TestRuntime {
            home,
            auth,
            runtime,
            state,
            checkpoints,
            catalogs,
            exits,
            local_id,
            local_rx,
            relay_id,
            relay_rx,
            from_supervisor,
        }
    }

    fn request_envelope(channel_id: &str, payload: device_envelope::Payload) -> Vec<u8> {
        encode_device_envelope(&DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.to_string(),
            payload: Some(payload),
        })
    }

    fn authenticated_local(client_instance_id: &str) -> AuthenticatedLocal {
        AuthenticatedLocal {
            principal: LocalPrincipal {
                grant_id: "grant-test".into(),
                account_id: "account-test".into(),
                daemon_id: "daemon-test".into(),
                origin: "https://p.coflux.dev".into(),
                browser_public_key_sec1: Vec::new(),
                client_instance_id: client_instance_id.into(),
                transport_generation: 1,
                lease_id: None,
            },
            scopes: vec![DeviceScope::SessionRead as i32],
        }
    }

    fn catalog_session(session_id: &str, task_id: &str, pid: i32) -> wire::DeviceSessionInfo {
        wire::DeviceSessionInfo {
            session_id: session_id.into(),
            task_id: task_id.into(),
            pid,
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
            output_seq: 0,
            started_at: 1.0,
        }
    }

    fn pending_snapshot(session_id: &str, task_id: &str, pid: i32) -> PendingSnapshot {
        PendingSnapshot {
            session_id: session_id.into(),
            task_id: task_id.into(),
            pid,
        }
    }

    fn catalog_query(wire_request_id: &str) -> CatalogQuery {
        CatalogQuery::new(wire_request_id.into(), 0)
    }

    fn pause_next_catalog_completion(
        runtime: &DeviceRuntime,
        phase: CatalogCompletionHookPhase,
    ) -> (Arc<std::sync::Barrier>, Arc<std::sync::Barrier>) {
        let reached = Arc::new(std::sync::Barrier::new(2));
        let resume = Arc::new(std::sync::Barrier::new(2));
        *runtime.catalog_completion_test_hook.lock().unwrap() = Some(CatalogCompletionTestHook {
            phase,
            reached: reached.clone(),
            resume: resume.clone(),
        });
        (reached, resume)
    }

    fn deliver_catalog(runtime: &DeviceRuntime, catalog: DeviceSessionCatalog) {
        let envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: INTERNAL_CHANNEL_ID.into(),
            payload: Some(device_envelope::Payload::SessionCatalog(catalog)),
        };
        runtime.deliver_from_sessiond(INTERNAL_CHANNEL_ID, &encode_device_envelope(&envelope));
    }

    async fn receive_catalog_request(
        receiver: &mut mpsc::Receiver<Vec<u8>>,
    ) -> DeviceSessionCatalogRequest {
        let record = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .expect("worker 应请求下一页 catalog")
            .expect("sessiond channel 不应关闭");
        let mut parser = coflux_protocol::RecordParser::new();
        let mut records = Vec::new();
        parser
            .push(&record, |payload| records.push(payload.to_vec()))
            .unwrap();
        assert_eq!(records.len(), 1);
        let Some(DataFrame::Device { channel_id, data }) =
            coflux_protocol::decode_frame(&records[0])
        else {
            panic!("catalog 请求应使用 Device frame");
        };
        assert_eq!(channel_id, INTERNAL_CHANNEL_ID);
        let envelope = decode_device_envelope(&data).expect("catalog 请求 envelope 应可解码");
        let Some(device_envelope::Payload::SessionCatalogRequest(request)) = envelope.payload
        else {
            panic!("应收到 session catalog request");
        };
        request
    }

    async fn receive_sessiond_envelope(receiver: &mut mpsc::Receiver<Vec<u8>>) -> DeviceEnvelope {
        let record = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .expect("worker 应向 sessiond 发请求")
            .expect("sessiond channel 不应关闭");
        let mut parser = coflux_protocol::RecordParser::new();
        let mut records = Vec::new();
        parser
            .push(&record, |payload| records.push(payload.to_vec()))
            .unwrap();
        assert_eq!(records.len(), 1);
        let Some(DataFrame::Device { channel_id, data }) =
            coflux_protocol::decode_frame(&records[0])
        else {
            panic!("agent 请求应使用 Device frame");
        };
        let envelope = decode_device_envelope(&data).expect("agent envelope 应可解码");
        assert_eq!(envelope.channel_id, channel_id);
        envelope
    }

    #[test]
    fn internal_frame_ids_stop_at_255_bytes() {
        assert!(valid_id(&"a".repeat(MAX_FRAME_ID_BYTES)));
        assert!(!valid_id(&"a".repeat(MAX_FRAME_ID_BYTES + 1)));
    }

    #[test]
    fn device_channels_share_one_hard_limit_across_all_transports() {
        let (to_supervisor, _from_supervisor) = mpsc::channel(1);
        let (to_server, _from_server) = mpsc::channel(1);
        let runtime =
            DeviceRuntime::with_limits(None, to_supervisor, to_server, None, 1, 1024, 2048, 2);
        let (local_a, _rx_a) = runtime.open_local(authenticated_local("local-a")).unwrap();
        let (_local_b, _rx_b) = runtime.open_local(authenticated_local("local-b")).unwrap();
        assert_eq!(
            runtime
                .open_local(authenticated_local("local-overflow"))
                .err()
                .unwrap(),
            "Device channel 总数已达上限"
        );

        let relay = DeviceRelayDial {
            channel_id: "relay-limit".into(),
            relay_url: "ws://127.0.0.1:1/pipe".into(),
            account_id: "account-test".into(),
            client_instance_id: "relay-client".into(),
            transport_generation: 1,
            scopes: vec![DeviceScope::SessionRead as i32],
            protocol_version: DEVICE_PROTOCOL_VERSION,
        };
        assert_eq!(
            runtime.open_relay(&relay).err().unwrap(),
            "Device channel 总数已达上限"
        );
        let p2p = DeviceP2pChannelGrant {
            connection_id: "connection-test".into(),
            channel_id: "p2p-limit".into(),
            account_id: "account-test".into(),
            client_instance_id: "p2p-client".into(),
            transport_generation: 1,
            scopes: vec![DeviceScope::SessionRead as i32],
            protocol_version: DEVICE_PROTOCOL_VERSION,
        };
        assert_eq!(
            runtime.open_p2p(&p2p).err().unwrap(),
            "Device channel 总数已达上限"
        );

        runtime.close_channel(&local_a);
        let _relay_rx = runtime.open_relay(&relay).unwrap();
        assert_eq!(
            runtime.open_p2p(&p2p).err().unwrap(),
            "Device channel 总数已达上限"
        );
        runtime.close_relay(&relay.channel_id);
        let _p2p_rx = runtime.open_p2p(&p2p).unwrap();
    }

    #[test]
    fn call_ledger_counts_waiter_strings_and_fixed_overhead() {
        let mut ledger = CallLedger::default();
        let key = "operation-accounted".to_string();
        let fingerprint = b"same-payload".to_vec();
        let first = ResponseWaiter {
            channel_id: "channel-a".into(),
            request_id: "request-a".into(),
        };
        assert!(matches!(
            start_call_with_limits(
                &mut ledger,
                key.clone(),
                fingerprint.clone(),
                first,
                8,
                4096,
            ),
            Ok(CallStart::Execute)
        ));
        let initial_bytes = ledger.bytes;
        assert_eq!(
            initial_bytes,
            call_record_bytes(&key, ledger.entries.get(&key).unwrap())
        );

        let second = ResponseWaiter {
            channel_id: "channel-b".into(),
            request_id: "request-b".into(),
        };
        let second_bytes = response_waiter_bytes(&second);
        assert!(matches!(
            start_call_with_limits(
                &mut ledger,
                key.clone(),
                fingerprint.clone(),
                second.clone(),
                8,
                4096,
            ),
            Ok(CallStart::Pending)
        ));
        assert_eq!(ledger.bytes, initial_bytes + second_bytes);
        assert!(matches!(
            start_call_with_limits(&mut ledger, key, fingerprint, second, 8, 4096),
            Ok(CallStart::Pending)
        ));
        assert_eq!(ledger.bytes, initial_bytes + second_bytes);
    }

    #[test]
    fn call_ledger_finishes_with_cached_error_instead_of_crossing_byte_limit() {
        let current_key = "current".to_string();
        let current_fingerprint = b"current-fingerprint".to_vec();
        let current = CallRecord {
            fingerprint: current_fingerprint.clone(),
            result: None,
            waiters: vec![ResponseWaiter {
                channel_id: "channel-current".into(),
                request_id: "request-current".into(),
            }],
        };
        let blocker_key = "blocker".to_string();
        let blocker = CallRecord {
            fingerprint: vec![7; 512],
            result: None,
            waiters: vec![ResponseWaiter {
                channel_id: "channel-blocker".into(),
                request_id: "request-blocker".into(),
            }],
        };
        let mut ledger = CallLedger::default();
        ledger.bytes =
            call_record_bytes(&current_key, &current) + call_record_bytes(&blocker_key, &blocker);
        ledger.entries.insert(current_key.clone(), current);
        ledger.entries.insert(blocker_key.clone(), blocker);
        let byte_limit = ledger.bytes + 32;
        let large_result = device_envelope::Payload::FsReadResult(wire::FsReadResult {
            request_id: "request-current".into(),
            ok: true,
            content: "x".repeat(4096),
            error: None,
        });

        let (waiters, cached) =
            finish_call_in_ledger(&mut ledger, &current_key, &large_result, byte_limit).unwrap();
        assert_eq!(waiters.len(), 1);
        assert!(matches!(
            cached,
            device_envelope::Payload::Error(DeviceError { ref code, .. })
                if code == "result_capacity_exceeded"
        ));
        assert!(ledger.bytes <= byte_limit);
        assert_eq!(
            ledger.bytes,
            ledger
                .entries
                .iter()
                .map(|(key, record)| call_record_bytes(key, record))
                .sum::<usize>()
        );
        assert!(matches!(
            start_call_with_limits(
                &mut ledger,
                current_key,
                current_fingerprint,
                ResponseWaiter {
                    channel_id: "retry-channel".into(),
                    request_id: "retry-request".into(),
                },
                8,
                byte_limit,
            ),
            Ok(CallStart::Cached(device_envelope::Payload::Error(DeviceError { ref code, .. })))
                if code == "result_capacity_exceeded"
        ));
    }

    #[test]
    fn agent_io_reuses_identity_and_rotates_only_after_unknown_result() {
        let (to_supervisor, _from_supervisor) = mpsc::channel(1);
        let (to_server, _from_server) = mpsc::channel(1);
        let runtime = DeviceRuntime::new(None, to_supervisor, to_server);

        let first = runtime.begin_agent_io("session-a").unwrap();
        assert_eq!(first.transport_generation, 1);
        assert_eq!(first.input_seq, 1);
        assert!(runtime.begin_agent_io("session-a").is_err());
        runtime.finish_agent_io("session-a", &first, AgentIoDisposition::Applied);

        let second = runtime.begin_agent_io("session-a").unwrap();
        assert_eq!(second.client_instance_id, first.client_instance_id);
        assert_eq!(second.transport_generation, 2);
        assert_eq!(second.input_seq, 2);
        runtime.finish_agent_io("session-a", &second, AgentIoDisposition::Unknown);

        let third = runtime.begin_agent_io("session-a").unwrap();
        assert_ne!(third.client_instance_id, second.client_instance_id);
        assert_eq!(third.transport_generation, 1);
        assert_eq!(third.input_seq, 1);
        runtime.finish_agent_io("session-a", &third, AgentIoDisposition::KnownFailure);
    }

    #[tokio::test]
    async fn agent_io_frames_use_stable_identity_and_monotonic_generation_and_seq() {
        let (to_supervisor, mut from_supervisor) = mpsc::channel(8);
        let (to_server, _from_server) = mpsc::channel(1);
        let runtime = DeviceRuntime::new(None, to_supervisor, to_server);

        let first_runtime = runtime.clone();
        let first = tokio::spawn(async move {
            first_runtime
                .agent_send_input("session-stable", b"first".to_vec())
                .await
        });
        let attach = receive_sessiond_envelope(&mut from_supervisor).await;
        let channel_one = attach.channel_id.clone();
        let Some(device_envelope::Payload::SessionAttach(attach_one)) = attach.payload else {
            panic!("第一帧应为 attach");
        };
        assert_eq!(attach_one.transport_generation, 1);
        let identity = attach_one.client_instance_id.clone();
        let attached = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_one.clone(),
            payload: Some(device_envelope::Payload::SessionAttached(
                DeviceSessionAttached {
                    request_id: attach_one.request_id,
                    session_id: "session-stable".into(),
                    holder_epoch: 7,
                    ..Default::default()
                },
            )),
        };
        runtime.deliver_from_sessiond(&channel_one, &encode_device_envelope(&attached));
        let input = receive_sessiond_envelope(&mut from_supervisor).await;
        let Some(device_envelope::Payload::PtyInput(input_one)) = input.payload else {
            panic!("attach 后应为 input");
        };
        assert_eq!(input_one.input_seq, 1);
        let ack = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_one.clone(),
            payload: Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                session_id: "session-stable".into(),
                applied_through_seq: 1,
            })),
        };
        runtime.deliver_from_sessiond(&channel_one, &encode_device_envelope(&ack));
        assert_eq!(first.await.unwrap(), Ok(()));

        let second_runtime = runtime.clone();
        let second = tokio::spawn(async move {
            second_runtime
                .agent_send_input("session-stable", b"second".to_vec())
                .await
        });
        let attach = receive_sessiond_envelope(&mut from_supervisor).await;
        let channel_two = attach.channel_id.clone();
        let Some(device_envelope::Payload::SessionAttach(attach_two)) = attach.payload else {
            panic!("第二次第一帧应为 attach");
        };
        assert_eq!(attach_two.client_instance_id, identity);
        assert_eq!(attach_two.transport_generation, 2);
        assert_ne!(channel_two, channel_one);
        let attached = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_two.clone(),
            payload: Some(device_envelope::Payload::SessionAttached(
                DeviceSessionAttached {
                    request_id: attach_two.request_id,
                    session_id: "session-stable".into(),
                    holder_epoch: 7,
                    ..Default::default()
                },
            )),
        };
        runtime.deliver_from_sessiond(&channel_two, &encode_device_envelope(&attached));
        let input = receive_sessiond_envelope(&mut from_supervisor).await;
        let Some(device_envelope::Payload::PtyInput(input_two)) = input.payload else {
            panic!("第二次 attach 后应为 input");
        };
        assert_eq!(input_two.input_seq, 2);
        let ack = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_two.clone(),
            payload: Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                session_id: "session-stable".into(),
                applied_through_seq: 2,
            })),
        };
        runtime.deliver_from_sessiond(&channel_two, &encode_device_envelope(&ack));
        assert_eq!(second.await.unwrap(), Ok(()));
    }

    #[tokio::test]
    async fn pending_agent_io_stops_at_hard_limit() {
        let (to_supervisor, _from_supervisor) = mpsc::channel(1);
        let (to_server, _from_server) = mpsc::channel(1);
        let runtime = DeviceRuntime::new(None, to_supervisor, to_server);
        {
            let mut pending = runtime.pending_agent_ios.lock().unwrap();
            for index in 0..PENDING_AGENT_IO_LIMIT {
                let (tx, _rx) = mpsc::channel(1);
                pending.insert(
                    format!("occupied-{index}"),
                    PendingAgentIo {
                        session_id: format!("occupied-session-{index}"),
                        sender: tx,
                    },
                );
            }
        }
        assert_eq!(
            runtime
                .agent_send_input("session-limit", b"x".to_vec())
                .await
                .unwrap_err(),
            "agent PTY 写入并发已达上限，请稍后重试"
        );
        assert_eq!(
            runtime.pending_agent_ios.lock().unwrap().len(),
            PENDING_AGENT_IO_LIMIT
        );
        assert!(
            !runtime
                .agent_io_states
                .lock()
                .unwrap()
                .get("session-limit")
                .unwrap()
                .in_flight
        );
    }

    #[tokio::test]
    async fn session退出由control确认identity后清理所有长期派生状态并关闭_agent_waiter() {
        let (to_supervisor, _from_supervisor) = mpsc::channel(1);
        let (to_server, _from_server) = mpsc::channel(1);
        let runtime = DeviceRuntime::new(None, to_supervisor, to_server);
        let channel_id = "cleanup-relay".to_string();
        let mut channel_rx = runtime
            .open_relay(&DeviceRelayDial {
                channel_id: channel_id.clone(),
                relay_url: "ws://127.0.0.1:1/pipe".into(),
                account_id: "cleanup-account".into(),
                client_instance_id: "cleanup-client".into(),
                transport_generation: 1,
                scopes: vec![DeviceScope::SessionRead as i32],
                protocol_version: DEVICE_PROTOCOL_VERSION,
            })
            .unwrap();
        {
            let mut channels = runtime.channels.lock().unwrap();
            let streams = &mut channels.get_mut(&channel_id).unwrap().streams;
            streams.insert("session-exited".into(), StreamCursor::default());
            streams.insert("session-live".into(), StreamCursor::default());
        }
        runtime
            .holders
            .lock()
            .unwrap()
            .insert("session-exited".into(), channel_id.clone());
        runtime
            .holders
            .lock()
            .unwrap()
            .insert("session-live".into(), channel_id.clone());
        runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .extend(["session-exited".into(), "session-live".into()]);
        runtime.pending_snapshots.lock().unwrap().extend([
            (
                "snapshot-exited".into(),
                pending_snapshot("session-exited", "task-exited", 1),
            ),
            (
                "snapshot-live".into(),
                pending_snapshot("session-live", "task-live", 2),
            ),
        ]);
        runtime.agent_io_states.lock().unwrap().extend([
            ("session-exited".into(), new_agent_io_state()),
            ("session-live".into(), new_agent_io_state()),
        ]);
        let (exited_tx, mut exited_rx) = mpsc::channel(1);
        let (live_tx, _live_rx) = mpsc::channel(1);
        runtime.pending_agent_ios.lock().unwrap().extend([
            (
                "agent-exited".into(),
                PendingAgentIo {
                    session_id: "session-exited".into(),
                    sender: exited_tx,
                },
            ),
            (
                "agent-live".into(),
                PendingAgentIo {
                    session_id: "session-live".into(),
                    sender: live_tx,
                },
            ),
        ]);

        let exited = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.clone(),
            payload: Some(device_envelope::Payload::SessionExited(
                DeviceSessionExited {
                    session_id: "session-exited".into(),
                    exit_code: 0,
                    final_output_seq: 9,
                },
            )),
        };
        runtime.deliver_from_sessiond(&channel_id, &encode_device_envelope(&exited));

        assert!(
            runtime
                .channels
                .lock()
                .unwrap()
                .get(&channel_id)
                .unwrap()
                .streams
                .contains_key("session-exited"),
            "裸 DeviceSessionExited 先交付给 client，但不能按可复用 sessionId 清新 incarnation"
        );
        runtime.session_exited("session-exited");

        let channels = runtime.channels.lock().unwrap();
        let streams = &channels.get(&channel_id).unwrap().streams;
        assert!(!streams.contains_key("session-exited"));
        assert!(streams.contains_key("session-live"));
        drop(channels);
        assert!(!runtime
            .holders
            .lock()
            .unwrap()
            .contains_key("session-exited"));
        assert!(runtime.holders.lock().unwrap().contains_key("session-live"));
        assert!(!runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .contains("session-exited"));
        assert!(runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .contains("session-live"));
        assert!(!runtime
            .pending_snapshots
            .lock()
            .unwrap()
            .values()
            .any(|pending| pending.session_id == "session-exited"));
        assert!(runtime
            .pending_snapshots
            .lock()
            .unwrap()
            .values()
            .any(|pending| pending.session_id == "session-live"));
        assert!(!runtime
            .agent_io_states
            .lock()
            .unwrap()
            .contains_key("session-exited"));
        assert!(runtime
            .agent_io_states
            .lock()
            .unwrap()
            .contains_key("session-live"));
        assert!(!runtime
            .pending_agent_ios
            .lock()
            .unwrap()
            .values()
            .any(|pending| pending.session_id == "session-exited"));
        assert!(runtime
            .pending_agent_ios
            .lock()
            .unwrap()
            .values()
            .any(|pending| pending.session_id == "session-live"));
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(50), exited_rx.recv())
                .await
                .expect("session 退出后 waiter 应立即关闭"),
            None
        );
        let delivered = tokio::time::timeout(Duration::from_millis(50), channel_rx.recv())
            .await
            .expect("退出帧应继续投递给 client")
            .expect("client channel 不应关闭");
        assert!(matches!(
            decode_device_envelope(&delivered).unwrap().payload,
            Some(device_envelope::Payload::SessionExited(DeviceSessionExited {
                ref session_id,
                exit_code: 0,
                final_output_seq: 9,
            })) if session_id == "session-exited"
        ));
    }

    #[test]
    fn session退出后迟到_output_不能重新登记_checkpoint_dirty() {
        let fixture = test_runtime();
        fixture.state.lock().unwrap().alive.insert(
            "session-exited".into(),
            ("task-exited".into(), std::process::id() as i32),
        );
        fixture.runtime.mark_session_dirty("session-exited");
        assert!(fixture
            .runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .contains("session-exited"));

        // control exit 先按 task/pid incarnation 从 alive 提交删除，再清理派生状态。
        fixture.state.lock().unwrap().alive.remove("session-exited");
        fixture.runtime.session_exited("session-exited");
        fixture.runtime.mark_session_dirty("session-exited");
        assert!(!fixture
            .state
            .lock()
            .unwrap()
            .alive
            .contains_key("session-exited"));
        assert!(!fixture
            .runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .contains("session-exited"));

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    /// plan 043：relay channel 出向帧就是 ChannelReceiver 里的原始 DeviceEnvelope bytes
    /// （由拨号任务直接泵进该 channel 的 relay WS），不再有 DaemonToServer wrap。
    async fn relay_envelope(receiver: &mut ChannelReceiver) -> DeviceEnvelope {
        let bytes = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        decode_device_envelope(&bytes).unwrap()
    }

    #[test]
    fn device_router_scope_matrix_keeps_offline_lifecycle_and_rpc_closed() {
        assert_eq!(
            required_scope(&device_envelope::Payload::SessionCatalogRequest(
                Default::default()
            )),
            Some(DeviceScope::SessionRead)
        );
        assert_eq!(
            required_scope(&device_envelope::Payload::PtyInput(Default::default())),
            Some(DeviceScope::SessionControl)
        );
        assert_eq!(
            required_scope(&device_envelope::Payload::ExecRun(Default::default())),
            Some(DeviceScope::Rpc)
        );
        assert_eq!(
            required_scope(&device_envelope::Payload::SessionCreate(Default::default())),
            Some(DeviceScope::Lifecycle)
        );
        assert_eq!(
            required_scope(&device_envelope::Payload::PtyOutput(Default::default())),
            None
        );
        assert_eq!(
            response_required_scope(&device_envelope::Payload::PtyInputAck(Default::default())),
            Some(DeviceScope::SessionControl)
        );
    }

    #[tokio::test]
    async fn device_router_input_ack_returns_only_to_its_bound_local_or_relay_channel() {
        let mut fixture = test_runtime();
        let local_ack = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: fixture.local_id.clone(),
            payload: Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                session_id: "session-local".into(),
                applied_through_seq: 7,
            })),
        };
        fixture
            .runtime
            .deliver_from_sessiond(&fixture.local_id, &encode_device_envelope(&local_ack));
        let local = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            decode_device_envelope(&local).unwrap().payload,
            Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                ref session_id,
                applied_through_seq: 7,
            })) if session_id == "session-local"
        ));
        assert!(
            fixture.relay_rx.try_recv().is_none(),
            "local ACK must not leak to relay channels"
        );

        let relay_ack = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: fixture.relay_id.clone(),
            payload: Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                session_id: "session-relay".into(),
                applied_through_seq: 9,
            })),
        };
        fixture
            .runtime
            .deliver_from_sessiond(&fixture.relay_id, &encode_device_envelope(&relay_ack));
        let relay = relay_envelope(&mut fixture.relay_rx).await;
        assert!(matches!(
            relay.payload,
            Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                ref session_id,
                applied_through_seq: 9,
            })) if session_id == "session-relay"
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), fixture.local_rx.recv())
                .await
                .is_err()
        );

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn device_router_local_and_relay_share_request_dedup_and_response_correlation() {
        let mut fixture = test_runtime();
        let request = device_envelope::Payload::PortsRequest(DevicePortsRequest {
            request_id: "ports-shared".into(),
        });
        fixture.runtime.handle_client_frame(
            &fixture.local_id,
            &request_envelope(&fixture.local_id, request.clone()),
        );
        fixture.runtime.handle_client_frame(
            &fixture.relay_id,
            &request_envelope(&fixture.relay_id, request),
        );

        let local = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let local = decode_device_envelope(&local).unwrap();
        let relay = relay_envelope(&mut fixture.relay_rx).await;
        assert!(matches!(
            local.payload,
            Some(device_envelope::Payload::PortsResult(wire::DevicePortsResult { ref request_id, .. })) if request_id == "ports-shared"
        ));
        assert!(matches!(
            relay.payload,
            Some(device_envelope::Payload::PortsResult(wire::DevicePortsResult { ref request_id, .. })) if request_id == "ports-shared"
        ));

        // 同一 logical client/requestId 换 transport 却改 payload 必须拒绝，不能覆盖缓存。
        let collision = device_envelope::Payload::FsList(wire::DeviceFsList {
            request_id: "ports-shared".into(),
            workspace_id: "workspace-1".into(),
            path: String::new(),
            browse_home: false,
        });
        fixture.runtime.handle_client_frame(
            &fixture.relay_id,
            &request_envelope(&fixture.relay_id, collision),
        );
        let collision = relay_envelope(&mut fixture.relay_rx).await;
        assert!(matches!(
            collision.payload,
            Some(device_envelope::Payload::Error(DeviceError { ref code, .. })) if code == "request_collision"
        ));

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn device_router_operation_id_is_exactly_once_across_local_and_relay() {
        let mut fixture = test_runtime();
        let operation = |channel_id: &str, request_id: &str, script: &str| {
            request_envelope(
                channel_id,
                device_envelope::Payload::ExecRun(DeviceExecRun {
                    request_id: request_id.into(),
                    workspace_id: "workspace-1".into(),
                    command: "/bin/sh".into(),
                    args: vec!["-c".into(), script.into()],
                    env: HashMap::new(),
                    timeout_ms: Some(5_000),
                    operation_id: Some("operation-once".into()),
                }),
            )
        };
        fixture.runtime.handle_client_frame(
            &fixture.local_id,
            &operation(&fixture.local_id, "exec-local", "printf x >> marker"),
        );
        fixture.runtime.handle_client_frame(
            &fixture.relay_id,
            &operation(&fixture.relay_id, "exec-relay", "printf x >> marker"),
        );
        let local = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let local = decode_device_envelope(&local).unwrap();
        let relay = relay_envelope(&mut fixture.relay_rx).await;
        assert!(matches!(
            local.payload,
            Some(device_envelope::Payload::ExecResult(wire::ExecResult { ref request_id, ok: true, .. })) if request_id == "exec-local"
        ));
        assert!(matches!(
            relay.payload,
            Some(device_envelope::Payload::ExecResult(wire::ExecResult { ref request_id, ok: true, .. })) if request_id == "exec-relay"
        ));
        assert_eq!(
            std::fs::read_to_string(format!("{}/marker", fixture.home)).unwrap(),
            "x"
        );

        // 完成后的不同 requestId 重投命中缓存；不同 payload 则 collision，均不得再次执行。
        fixture.runtime.handle_client_frame(
            &fixture.relay_id,
            &operation(&fixture.relay_id, "exec-retry", "printf x >> marker"),
        );
        let retry = relay_envelope(&mut fixture.relay_rx).await;
        assert!(matches!(
            retry.payload,
            Some(device_envelope::Payload::ExecResult(wire::ExecResult { ref request_id, ok: true, .. })) if request_id == "exec-retry"
        ));
        fixture.runtime.handle_client_frame(
            &fixture.relay_id,
            &operation(&fixture.relay_id, "exec-collision", "printf y >> marker"),
        );
        let collision = relay_envelope(&mut fixture.relay_rx).await;
        assert!(matches!(
            collision.payload,
            Some(device_envelope::Payload::Error(DeviceError { ref code, .. })) if code == "operation_collision"
        ));
        assert_eq!(
            std::fs::read_to_string(format!("{}/marker", fixture.home)).unwrap(),
            "x"
        );

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn device_router_offline_local_downgrades_but_session_scope_stays_available() {
        let mut fixture = test_runtime();
        fixture.auth.set_server_online(false);
        fixture.runtime.close_relays();
        let ports = device_envelope::Payload::PortsRequest(DevicePortsRequest {
            request_id: "ports-offline".into(),
        });
        fixture.runtime.handle_client_frame(
            &fixture.local_id,
            &request_envelope(&fixture.local_id, ports),
        );
        let denied = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let denied = decode_device_envelope(&denied).unwrap();
        assert!(matches!(
            denied.payload,
            Some(device_envelope::Payload::Error(DeviceError { ref code, .. })) if code == "scope_denied"
        ));

        let catalog =
            device_envelope::Payload::SessionCatalogRequest(DeviceSessionCatalogRequest {
                request_id: "catalog-offline".into(),
                ..Default::default()
            });
        fixture.runtime.handle_client_frame(
            &fixture.local_id,
            &request_envelope(&fixture.local_id, catalog),
        );
        let record = tokio::time::timeout(Duration::from_secs(2), fixture.from_supervisor.recv())
            .await
            .unwrap()
            .unwrap();
        let mut parser = coflux_protocol::RecordParser::new();
        let mut records = Vec::new();
        parser
            .push(&record, |record| records.push(record.to_vec()))
            .unwrap();
        assert!(matches!(
            coflux_protocol::decode_frame(&records[0]),
            Some(DataFrame::Device { ref channel_id, .. }) if channel_id == &fixture.local_id
        ));

        fixture.runtime.close_channel(&fixture.local_id);
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn device_router_grant_revoke_closes_an_existing_local_stream() {
        let mut fixture = test_runtime();
        let local_id = fixture.local_id.clone();
        let catalog = |request_id: &str| DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: local_id.clone(),
            payload: Some(device_envelope::Payload::SessionCatalog(
                DeviceSessionCatalog {
                    request_id: request_id.into(),
                    sessions: Vec::new(),
                    exits: Vec::new(),
                    ..Default::default()
                },
            )),
        };
        fixture.runtime.deliver_from_sessiond(
            &fixture.local_id,
            &encode_device_envelope(&catalog("before-revoke")),
        );
        assert!(fixture.local_rx.recv().await.is_some());
        fixture.runtime.deliver_from_sessiond(
            &fixture.local_id,
            &encode_device_envelope(&catalog("queued-before-revoke")),
        );
        fixture.auth.revoke_grant("grant-1").unwrap();
        fixture.runtime.revoke_local_grant("grant-1");
        assert_eq!(fixture.local_rx.recv().await, None);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn device_router_prepared_template_rejects_tamper_expiry_and_wrong_daemon() {
        let fixture = test_runtime();
        let template = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: String::new(),
            payload: Some(device_envelope::Payload::SessionCreate(
                DeviceSessionCreate {
                    request_id: "create-1".into(),
                    operation_id: "prepared-1".into(),
                    session_id: "session-1".into(),
                    task_id: "task-1".into(),
                    cwd: fixture.home.clone(),
                    shell: None,
                    cols: 80,
                    rows: 24,
                    command: String::new(),
                    workspace_id: String::new(),
                    project_id: String::new(),
                    daemon_id: String::new(),
                    mcp_url: String::new(),
                },
            )),
        };
        let installed = fixture
            .runtime
            .install_prepared_operation(PreparedDeviceOperation {
                operation_id: "prepared-1".into(),
                daemon_id: "daemon-1".into(),
                frame: encode_device_envelope(&template),
                expires_at: epoch_ms() + 60_000.0,
            });
        assert!(installed.ok);
        let mut bound = template.clone();
        bound.channel_id = fixture.local_id.clone();
        assert!(fixture.runtime.authorize_prepared(&bound).is_ok());
        if let Some(device_envelope::Payload::SessionCreate(request)) = bound.payload.as_mut() {
            request.cwd.push_str("-tampered");
        }
        assert!(fixture.runtime.authorize_prepared(&bound).is_err());
        assert!(
            !fixture
                .runtime
                .install_prepared_operation(PreparedDeviceOperation {
                    operation_id: "expired".into(),
                    daemon_id: "daemon-1".into(),
                    frame: encode_device_envelope(&template),
                    expires_at: epoch_ms() - 1.0,
                })
                .ok
        );
        assert!(
            !fixture
                .runtime
                .install_prepared_operation(PreparedDeviceOperation {
                    operation_id: "wrong-daemon".into(),
                    daemon_id: "daemon-other".into(),
                    frame: encode_device_envelope(&template),
                    expires_at: epoch_ms() + 60_000.0,
                })
                .ok
        );
        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn transport_backpressure_channel_queue_marks_gap_without_blocking_other_channels() {
        let aggregate = AggregateQueueBudget::new(2048, 2 * CHANNEL_GAP_FRAME_BYTES);
        let (sink_a, mut receiver_a) = ChannelSink::pair(1, 1024, aggregate.clone());
        let (sink_b, mut receiver_b) = ChannelSink::pair(1, 1024, aggregate);
        assert!(sink_a.try_send(vec![1]));
        assert!(!sink_a.try_send(vec![2]));
        assert!(sink_a.try_send_gap(vec![9]));
        assert!(sink_b.try_send(vec![3]));

        assert_eq!(receiver_a.recv().await, Some(vec![1]));
        assert_eq!(receiver_a.recv().await, Some(vec![9]));
        assert_eq!(receiver_b.recv().await, Some(vec![3]));
    }

    #[tokio::test]
    async fn transport_backpressure_global_bytes_are_shared_and_drop_releases_them() {
        let aggregate = AggregateQueueBudget::new(8, 2 * CHANNEL_GAP_FRAME_BYTES);
        let (sink_a, mut receiver_a) = ChannelSink::pair(2, 8, aggregate.clone());
        let (sink_b, mut receiver_b) = ChannelSink::pair(2, 8, aggregate.clone());

        assert!(sink_a.try_send(vec![1; 8]));
        assert_eq!(aggregate.regular_pending.load(Ordering::Acquire), 8);
        assert!(
            !sink_b.try_send(vec![2]),
            "单 channel 尚有空间时也必须服从聚合预算"
        );
        assert_eq!(sink_b.pending_bytes.load(Ordering::Acquire), 0);

        let gap = vec![9; CHANNEL_GAP_FRAME_BYTES];
        assert!(sink_b.try_send_gap(gap.clone()));
        assert_eq!(
            aggregate.gap_pending.load(Ordering::Acquire),
            CHANNEL_GAP_FRAME_BYTES,
            "普通预算打满后，独立 priority 额度仍可报告 gap"
        );
        assert!(!sink_a.try_send_gap(vec![0; CHANNEL_GAP_FRAME_BYTES + 1]));
        assert_eq!(receiver_b.recv().await, Some(gap));
        assert_eq!(aggregate.gap_pending.load(Ordering::Acquire), 0);

        assert_eq!(receiver_a.recv().await, Some(vec![1; 8]));
        assert_eq!(aggregate.regular_pending.load(Ordering::Acquire), 0);
        assert!(sink_b.try_send(vec![3; 8]));
        assert_eq!(aggregate.regular_pending.load(Ordering::Acquire), 8);
        sink_b.close();
        drop(receiver_b);
        assert_eq!(
            aggregate.regular_pending.load(Ordering::Acquire),
            0,
            "关闭后 receiver 未消费的帧也必须归还聚合预算"
        );
    }

    #[tokio::test]
    async fn transport_backpressure_checkpoint_outbox_coalesces_latest_per_session() {
        let outbox = CheckpointOutbox::default();
        outbox.publish("session-1".into(), vec![1]);
        outbox.publish("session-1".into(), vec![2]);
        outbox.publish("session-2".into(), vec![3]);
        let old = outbox.claim(1).await;
        assert_eq!(old.bytes, vec![2]);
        outbox.publish("session-1".into(), vec![4]);
        assert!(
            !outbox.acknowledge(&old),
            "旧 WS 的 ACK 不能删除同 key 新值"
        );
        let replay = outbox.claim(2).await;
        assert_eq!(replay.bytes, vec![4]);
        assert!(outbox.acknowledge(&replay));
        let second = outbox.claim(2).await;
        assert_eq!(second.bytes, vec![3]);
        assert!(outbox.acknowledge(&second));
    }

    #[tokio::test]
    async fn session_exit_outbox重放最新值且旧连接不能确认新revision() {
        let fixture = test_runtime();
        fixture.runtime.report_session_exit("session-1", 7);
        let old = fixture.exits.claim(11).await;
        let old_message = wire::DaemonToServer::decode(old.bytes.as_slice()).unwrap();
        assert!(matches!(
            old_message.payload,
            Some(daemon_to_server::Payload::SessionExit(wire::SessionExit {
                ref session_id,
                exit_code: 7,
            })) if session_id == "session-1"
        ));

        fixture.runtime.report_session_exit("session-1", 9);
        assert!(
            !fixture.exits.acknowledge(&old),
            "旧连接的 ACK 不能删除同 sessionId 的新退出值"
        );
        let current = fixture.exits.claim(12).await;
        let current_message = wire::DaemonToServer::decode(current.bytes.as_slice()).unwrap();
        assert!(matches!(
            current_message.payload,
            Some(daemon_to_server::Payload::SessionExit(wire::SessionExit {
                ref session_id,
                exit_code: 9,
            })) if session_id == "session-1"
        ));
        assert!(fixture.exits.acknowledge(&current));

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[test]
    fn catalog_outbox总字节受硬上限且内部对账不进入server队列() {
        let fixture = test_runtime();
        let response_bytes = 1024 * 1024;
        for index in 0..(CATALOG_OUTBOX_BYTES / response_bytes + 16) {
            assert!(fixture.catalogs.publish(
                format!("external-response-{index}"),
                vec![index as u8; response_bytes],
            ));
            let state = fixture.catalogs.0.state.lock().unwrap();
            assert!(state.pending.len() <= CATALOG_EXTERNAL_QUERY_LIMIT);
            assert!(state.pending_bytes <= CATALOG_OUTBOX_BYTES);
        }
        let before = {
            let state = fixture.catalogs.0.state.lock().unwrap();
            assert_eq!(state.pending_bytes, CATALOG_OUTBOX_BYTES);
            (
                state.pending.keys().cloned().collect::<Vec<_>>(),
                state.pending_bytes,
            )
        };
        assert!(
            !fixture
                .catalogs
                .publish("oversized".into(), vec![0; CATALOG_OUTBOX_BYTES + 1],),
            "单条超限响应必须拒绝且不能扰动已保留结果"
        );

        fixture.runtime.pending_catalogs.lock().unwrap().insert(
            INTERNAL_CATALOG_REQUEST_ID.into(),
            catalog_query("wire-internal-full-outbox"),
        );
        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: "wire-internal-full-outbox".into(),
                sessions: vec![catalog_session("session-internal", "task-internal", 7)],
                snapshot_owner_id: "owner-internal".into(),
                snapshot_epoch: 1,
                next_session_offset: 1,
                complete: true,
                ..Default::default()
            },
        );
        assert_eq!(
            fixture.state.lock().unwrap().alive.get("session-internal"),
            Some(&("task-internal".into(), 7)),
            "外部 response outbox 满载不能阻塞内部本地对账"
        );
        let state = fixture.catalogs.0.state.lock().unwrap();
        assert_eq!(state.pending.keys().cloned().collect::<Vec<_>>(), before.0);
        assert_eq!(state.pending_bytes, before.1);
        drop(state);

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn catalog_logical_key跨生命周期稳定而旧wire响应被忽略() {
        let mut fixture = test_runtime();
        fixture
            .state
            .lock()
            .unwrap()
            .alive
            .insert("session-baseline".into(), ("task-baseline".into(), 1));
        fixture
            .runtime
            .request_server_catalog(DeviceSessionCatalogRequest {
                request_id: "logical-reused".into(),
                ..Default::default()
            });
        let first_round = receive_catalog_request(&mut fixture.from_supervisor).await;

        fixture.runtime.supervisor_disconnected();
        fixture.runtime.supervisor_connected();
        let supervisor_round = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_ne!(supervisor_round.request_id, first_round.request_id);
        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: first_round.request_id,
                sessions: vec![catalog_session("session-stale-a", "task-stale-a", 2)],
                snapshot_owner_id: "owner-stale-a".into(),
                snapshot_epoch: 1,
                next_session_offset: 1,
                complete: true,
                ..Default::default()
            },
        );
        assert!(fixture
            .state
            .lock()
            .unwrap()
            .alive
            .contains_key("session-baseline"));

        // server 认证换代会丢弃旧 logical queries/outbox；同 logical requestId 的新请求
        // 必须再生成一轮 wire id。先取走自动发起的内部 reconciliation 请求。
        fixture.runtime.server_authenticated();
        let internal_round = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_ne!(internal_round.request_id, supervisor_round.request_id);
        fixture
            .runtime
            .request_server_catalog(DeviceSessionCatalogRequest {
                request_id: "logical-reused".into(),
                ..Default::default()
            });
        let server_round = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_ne!(server_round.request_id, supervisor_round.request_id);

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: supervisor_round.request_id,
                sessions: vec![catalog_session("session-stale-b", "task-stale-b", 3)],
                snapshot_owner_id: "owner-stale-b".into(),
                snapshot_epoch: 2,
                next_session_offset: 1,
                complete: true,
                ..Default::default()
            },
        );
        assert!(fixture
            .state
            .lock()
            .unwrap()
            .alive
            .contains_key("session-baseline"));

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: server_round.request_id,
                sessions: vec![catalog_session("session-current", "task-current", 4)],
                snapshot_owner_id: "owner-current".into(),
                snapshot_epoch: 3,
                next_session_offset: 1,
                complete: true,
                ..Default::default()
            },
        );
        assert_eq!(
            fixture.state.lock().unwrap().alive,
            HashMap::from([("session-current".into(), ("task-current".into(), 4))])
        );
        let delivery = fixture.catalogs.claim(1).await;
        let reported = wire::DaemonToServer::decode(delivery.bytes.as_slice()).unwrap();
        let Some(daemon_to_server::Payload::SessionCatalog(reported)) = reported.payload else {
            panic!("当前 round 应发布外部 catalog response");
        };
        assert_eq!(reported.request_id, "logical-reused");
        assert_eq!(reported.sessions[0].session_id, "session-current");

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[test]
    fn catalog_complete摘出后认证换代先赢则旧continuation无任何效果() {
        let fixture = test_runtime();
        fixture
            .state
            .lock()
            .unwrap()
            .alive
            .insert("session-current".into(), ("task-current".into(), 10));
        fixture
            .runtime
            .request_server_catalog(DeviceSessionCatalogRequest {
                request_id: "logical-stale".into(),
                ..Default::default()
            });
        let old_wire_id = fixture
            .runtime
            .pending_catalogs
            .lock()
            .unwrap()
            .queries
            .get("logical-stale")
            .unwrap()
            .wire_request_id
            .clone();
        let (extracted, resume) = pause_next_catalog_completion(
            &fixture.runtime,
            CatalogCompletionHookPhase::AfterExtract,
        );
        let runtime = fixture.runtime.clone();
        let completion = std::thread::spawn(move || {
            deliver_catalog(
                &runtime,
                DeviceSessionCatalog {
                    request_id: old_wire_id,
                    sessions: vec![catalog_session("session-stale", "task-stale", 20)],
                    exits: vec![wire::DeviceSessionExitTombstone {
                        event_id: "exit-stale".into(),
                        session_id: "session-dead".into(),
                        task_id: "task-dead".into(),
                        exit_code: 7,
                        final_output_seq: 0,
                        exited_at: 1.0,
                    }],
                    snapshot_owner_id: "owner-stale".into(),
                    snapshot_epoch: 1,
                    next_session_offset: 1,
                    next_exit_offset: 1,
                    complete: true,
                    ..Default::default()
                },
            );
        });
        extracted.wait();

        // final 已移出 pending，但尚未进入提交门；认证换代在此时先线性化。
        fixture.runtime.server_authenticated();
        let current_generation = {
            let pending = fixture.runtime.pending_catalogs.lock().unwrap();
            assert_eq!(pending.queries.len(), 1);
            let reconciliation = pending.queries.get(INTERNAL_CATALOG_REQUEST_ID).unwrap();
            assert_eq!(reconciliation.server_generation, pending.server_generation);
            pending.server_generation
        };
        assert_ne!(current_generation, 0);

        // 在新代际建立派生状态；若旧 continuation 越过 gate，会把它们全部清掉。
        for entry in fixture.runtime.channels.lock().unwrap().values_mut() {
            entry
                .streams
                .insert("session-current".into(), StreamCursor::default());
        }
        fixture
            .runtime
            .holders
            .lock()
            .unwrap()
            .insert("session-current".into(), fixture.local_id.clone());
        fixture
            .runtime
            .agent_io_states
            .lock()
            .unwrap()
            .insert("session-current".into(), new_agent_io_state());
        fixture.runtime.pending_snapshots.lock().unwrap().insert(
            "snapshot-current".into(),
            pending_snapshot("session-current", "task-current", 10),
        );
        let (agent_tx, _agent_rx) = mpsc::channel(1);
        fixture.runtime.pending_agent_ios.lock().unwrap().insert(
            "agent-current".into(),
            PendingAgentIo {
                session_id: "session-current".into(),
                sender: agent_tx,
            },
        );

        resume.wait();
        completion.join().unwrap();

        assert_eq!(
            fixture.state.lock().unwrap().alive,
            HashMap::from([("session-current".into(), ("task-current".into(), 10))])
        );
        assert!(fixture
            .runtime
            .channels
            .lock()
            .unwrap()
            .values()
            .all(|entry| entry.streams.contains_key("session-current")));
        assert!(fixture
            .runtime
            .holders
            .lock()
            .unwrap()
            .contains_key("session-current"));
        assert!(fixture
            .runtime
            .agent_io_states
            .lock()
            .unwrap()
            .contains_key("session-current"));
        assert!(fixture
            .runtime
            .pending_snapshots
            .lock()
            .unwrap()
            .contains_key("snapshot-current"));
        assert!(fixture
            .runtime
            .pending_agent_ios
            .lock()
            .unwrap()
            .contains_key("agent-current"));
        assert!(fixture
            .runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .contains("session-current"));
        assert!(fixture.catalogs.0.state.lock().unwrap().pending.is_empty());
        assert!(fixture.exits.0.state.lock().unwrap().pending.is_empty());
        let pending = fixture.runtime.pending_catalogs.lock().unwrap();
        assert_eq!(pending.queries.len(), 1);
        assert!(pending.queries.contains_key(INTERNAL_CATALOG_REQUEST_ID));
        drop(pending);

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[test]
    fn catalog_complete先赢则认证换代在完整提交后清旧外部响应() {
        let fixture = test_runtime();
        fixture
            .runtime
            .request_server_catalog(DeviceSessionCatalogRequest {
                request_id: "logical-before-auth".into(),
                ..Default::default()
            });
        let old_wire_id = fixture
            .runtime
            .pending_catalogs
            .lock()
            .unwrap()
            .queries
            .get("logical-before-auth")
            .unwrap()
            .wire_request_id
            .clone();
        let (commit_entered, resume_commit) = pause_next_catalog_completion(
            &fixture.runtime,
            CatalogCompletionHookPhase::AfterCommitGate,
        );
        let runtime = fixture.runtime.clone();
        let completion = std::thread::spawn(move || {
            deliver_catalog(
                &runtime,
                DeviceSessionCatalog {
                    request_id: old_wire_id,
                    sessions: vec![catalog_session("session-committed", "task-committed", 30)],
                    exits: vec![wire::DeviceSessionExitTombstone {
                        event_id: "exit-committed".into(),
                        session_id: "session-dead".into(),
                        task_id: "task-dead".into(),
                        exit_code: 9,
                        final_output_seq: 0,
                        exited_at: 2.0,
                    }],
                    snapshot_owner_id: "owner-committed".into(),
                    snapshot_epoch: 2,
                    next_session_offset: 1,
                    next_exit_offset: 1,
                    complete: true,
                    ..Default::default()
                },
            );
        });
        commit_entered.wait();

        // completion 已持有提交门。确认认证线程已到门口后再放行
        // completion，从而确定地覆盖“完整提交先赢”的线性化顺序。
        let auth_reached = Arc::new(std::sync::Barrier::new(2));
        *fixture.runtime.catalog_auth_test_hook.lock().unwrap() = Some(auth_reached.clone());
        let runtime = fixture.runtime.clone();
        let authentication = std::thread::spawn(move || runtime.server_authenticated());
        auth_reached.wait();
        resume_commit.wait();
        completion.join().unwrap();
        authentication.join().unwrap();

        assert_eq!(
            fixture.state.lock().unwrap().alive,
            HashMap::from([("session-committed".into(), ("task-committed".into(), 30))])
        );
        let catalog_outbox = fixture.catalogs.0.state.lock().unwrap();
        assert_eq!(
            catalog_outbox.next_revision, 1,
            "completion 应先发布一份旧连接 response"
        );
        assert!(
            catalog_outbox.pending.is_empty(),
            "随后的认证换代必须清理旧 external response"
        );
        drop(catalog_outbox);
        assert!(
            fixture
                .exits
                .0
                .state
                .lock()
                .unwrap()
                .pending
                .contains_key("session-dead"),
            "先线性化的 daemon 权威 exit 应跨 server WS 可靠保留"
        );
        assert!(fixture
            .runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .contains("session-committed"));
        let pending = fixture.runtime.pending_catalogs.lock().unwrap();
        assert_eq!(pending.queries.len(), 1);
        let reconciliation = pending.queries.get(INTERNAL_CATALOG_REQUEST_ID).unwrap();
        assert_eq!(reconciliation.server_generation, pending.server_generation);
        assert_ne!(pending.server_generation, 0);
        drop(pending);

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn reconciliation_catalog固定单飞key并在背压后重试与补跑() {
        let mut fixture = test_runtime();
        for _ in 0..32 {
            fixture.runtime.to_supervisor.try_send(vec![0]).unwrap();
        }

        fixture.runtime.request_reconciliation_catalog();
        {
            let pending = fixture.runtime.pending_catalogs.lock().unwrap();
            assert_eq!(pending.queries.len(), 1);
            let query = pending.queries.get(INTERNAL_CATALOG_REQUEST_ID).unwrap();
            assert!(query.sent_at.is_none(), "首发背压后必须保留未发送 intent");
        }
        while fixture.from_supervisor.try_recv().is_ok() {}
        fixture.runtime.retry_catalog_queries();
        let first = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_ne!(first.request_id, INTERNAL_CATALOG_REQUEST_ID);
        assert_eq!(
            fixture
                .runtime
                .pending_catalogs
                .lock()
                .unwrap()
                .queries
                .get(INTERNAL_CATALOG_REQUEST_ID)
                .unwrap()
                .wire_request_id,
            first.request_id
        );

        fixture.runtime.request_reconciliation_catalog();
        fixture.runtime.request_reconciliation_catalog();
        {
            let pending = fixture.runtime.pending_catalogs.lock().unwrap();
            assert_eq!(pending.queries.len(), 1, "重复触发不能堆积唯一 requestId");
            assert!(
                pending
                    .queries
                    .get(INTERNAL_CATALOG_REQUEST_ID)
                    .unwrap()
                    .rerun
            );
        }

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: first.request_id.clone(),
                snapshot_owner_id: "owner-rerun".into(),
                snapshot_epoch: 1,
                complete: true,
                ..Default::default()
            },
        );
        let rerun = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_ne!(
            rerun.request_id, first.request_id,
            "补跑必须进入新的 wire round"
        );
        assert_eq!(rerun.session_offset, 0);
        assert_eq!(rerun.exit_offset, 0);
        assert!(
            fixture.catalogs.0.state.lock().unwrap().pending.is_empty(),
            "内部 reconciliation 完成后不应向 server 发布 catalog"
        );

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn catalog响应超时与分页续发背压都重试同一offset() {
        let mut fixture = test_runtime();
        fixture
            .runtime
            .request_server_catalog(DeviceSessionCatalogRequest {
                request_id: "catalog-retry".into(),
                ..Default::default()
            });
        let first = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_eq!(first.session_offset, 0);

        fixture
            .runtime
            .pending_catalogs
            .lock()
            .unwrap()
            .queries
            .get_mut("catalog-retry")
            .unwrap()
            .sent_at = Some(Instant::now() - CATALOG_RESPONSE_TIMEOUT);
        fixture.runtime.retry_catalog_queries();
        let timeout_retry = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_eq!(timeout_retry.request_id, first.request_id);
        assert_eq!(timeout_retry.session_offset, 0);
        assert_eq!(timeout_retry.exit_offset, 0);

        for _ in 0..32 {
            fixture.runtime.to_supervisor.try_send(vec![0]).unwrap();
        }
        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: first.request_id.clone(),
                sessions: vec![catalog_session("session-a", "task-a", 1)],
                snapshot_owner_id: "owner-retry".into(),
                snapshot_epoch: 3,
                session_offset: 0,
                exit_offset: 0,
                next_session_offset: 1,
                next_exit_offset: 0,
                complete: false,
                ..Default::default()
            },
        );
        {
            let pending = fixture.runtime.pending_catalogs.lock().unwrap();
            let query = pending.queries.get("catalog-retry").unwrap();
            assert_eq!(query.next_session_offset, 1);
            assert!(query.sent_at.is_none(), "续页入队失败后必须等待重试");
        }
        while fixture.from_supervisor.try_recv().is_ok() {}
        fixture.runtime.retry_catalog_queries();
        let continuation = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_eq!(continuation.request_id, first.request_id);
        assert_eq!(continuation.snapshot_owner_id, "owner-retry");
        assert_eq!(continuation.snapshot_epoch, 3);
        assert_eq!(continuation.session_offset, 1);

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[test]
    fn catalog外部query和聚合字节有硬上限且内部对账保留独立槽位() {
        let fixture = test_runtime();
        fixture
            .runtime
            .supervisor_online
            .store(false, Ordering::Release);
        for index in 0..CATALOG_EXTERNAL_QUERY_LIMIT + 8 {
            fixture
                .runtime
                .request_server_catalog(DeviceSessionCatalogRequest {
                    request_id: format!("external-{index}"),
                    ..Default::default()
                });
        }
        fixture.runtime.request_reconciliation_catalog();
        {
            let pending = fixture.runtime.pending_catalogs.lock().unwrap();
            assert_eq!(
                pending
                    .queries
                    .keys()
                    .filter(|key| key.as_str() != INTERNAL_CATALOG_REQUEST_ID)
                    .count(),
                CATALOG_EXTERNAL_QUERY_LIMIT
            );
            assert!(pending.queries.contains_key(INTERNAL_CATALOG_REQUEST_ID));
        }

        {
            let mut pending = fixture.runtime.pending_catalogs.lock().unwrap();
            pending.clear();
            pending.insert(
                "external-full".into(),
                CatalogQuery {
                    wire_request_id: "wire-external-full".into(),
                    retained_bytes: CATALOG_EXTERNAL_ASSEMBLY_BYTES,
                    ..Default::default()
                },
            );
            pending.insert("external-page".into(), catalog_query("external-page"));
        }
        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: "external-page".into(),
                sessions: vec![catalog_session("session-budget", "task-budget", 1)],
                snapshot_owner_id: "owner-budget".into(),
                snapshot_epoch: 1,
                next_session_offset: 1,
                complete: false,
                ..Default::default()
            },
        );
        let pending = fixture.runtime.pending_catalogs.lock().unwrap();
        assert_eq!(
            pending.external_retained_bytes,
            CATALOG_EXTERNAL_ASSEMBLY_BYTES
        );
        assert_eq!(
            pending.queries.get("external-page").unwrap().retained_bytes,
            0,
            "外部聚合预算已满时新页必须重置，不能越界保留"
        );
        drop(pending);

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn sessiond_catalog_pages_commit_alive_and_server_report_atomically() {
        let fixture = test_runtime();
        fixture
            .state
            .lock()
            .unwrap()
            .alive
            .insert("session-existing".into(), ("task-existing".into(), 1));
        {
            let mut channels = fixture.runtime.channels.lock().unwrap();
            for entry in channels.values_mut() {
                entry
                    .streams
                    .insert("session-old".into(), StreamCursor::default());
                entry
                    .streams
                    .insert("session-a".into(), StreamCursor::default());
                entry
                    .streams
                    .insert("session-b".into(), StreamCursor::default());
            }
        }
        fixture
            .runtime
            .pending_catalogs
            .lock()
            .unwrap()
            .insert("catalog-pages".into(), catalog_query("catalog-pages"));

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: "catalog-pages".into(),
                sessions: vec![catalog_session("session-a", "task-a", 11)],
                snapshot_owner_id: "owner-pages".into(),
                snapshot_epoch: 7,
                session_offset: 0,
                exit_offset: 0,
                next_session_offset: 1,
                next_exit_offset: 0,
                complete: false,
                reset: false,
                ..Default::default()
            },
        );
        let alive_after_first = fixture.state.lock().unwrap().alive.clone();
        assert_eq!(alive_after_first.len(), 1);
        assert!(alive_after_first.contains_key("session-existing"));
        assert!(fixture.catalogs.0.state.lock().unwrap().pending.is_empty());
        assert_eq!(
            fixture
                .runtime
                .pending_catalogs
                .lock()
                .unwrap()
                .queries
                .get("catalog-pages")
                .map(|query| query.sessions.len()),
            Some(1)
        );
        assert!(fixture
            .runtime
            .channels
            .lock()
            .unwrap()
            .values()
            .all(|entry| entry.streams.contains_key("session-old")));

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: "catalog-pages".into(),
                sessions: vec![catalog_session("session-b", "task-b", 22)],
                snapshot_owner_id: "owner-pages".into(),
                snapshot_epoch: 7,
                session_offset: 1,
                exit_offset: 0,
                next_session_offset: 2,
                next_exit_offset: 0,
                complete: true,
                reset: false,
                ..Default::default()
            },
        );
        let alive = fixture.state.lock().unwrap().alive.clone();
        assert_eq!(alive.len(), 2);
        assert_eq!(alive.get("session-a"), Some(&("task-a".into(), 11)));
        assert_eq!(alive.get("session-b"), Some(&("task-b".into(), 22)));
        assert!(fixture
            .runtime
            .channels
            .lock()
            .unwrap()
            .values()
            .all(|entry| {
                entry.streams.len() == 2
                    && entry.streams.contains_key("session-a")
                    && entry.streams.contains_key("session-b")
            }));
        assert!(!alive.contains_key("session-existing"));

        let delivery = tokio::time::timeout(Duration::from_secs(2), fixture.catalogs.claim(1))
            .await
            .expect("完整 catalog 应进入可靠 outbox");
        let reported = wire::DaemonToServer::decode(delivery.bytes.as_slice()).unwrap();
        let Some(daemon_to_server::Payload::SessionCatalog(reported)) = reported.payload else {
            panic!("outbox 应上报完整 catalog");
        };
        assert!(reported.complete);
        assert_eq!(reported.snapshot_owner_id, "owner-pages");
        assert_eq!(reported.snapshot_epoch, 7);
        assert_eq!(
            reported
                .sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-a", "session-b"]
        );
        assert!(fixture.catalogs.acknowledge(&delivery));

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn catalog同session_id新incarnation清旧派生状态并拒绝迟到snapshot() {
        let fixture = test_runtime();
        fixture
            .state
            .lock()
            .unwrap()
            .alive
            .insert("session-reused".into(), ("task-old".into(), 10));
        for entry in fixture.runtime.channels.lock().unwrap().values_mut() {
            entry
                .streams
                .insert("session-reused".into(), StreamCursor::default());
        }
        fixture
            .runtime
            .holders
            .lock()
            .unwrap()
            .insert("session-reused".into(), fixture.local_id.clone());
        fixture
            .runtime
            .agent_io_states
            .lock()
            .unwrap()
            .insert("session-reused".into(), new_agent_io_state());
        fixture.runtime.pending_snapshots.lock().unwrap().insert(
            "snapshot-old".into(),
            pending_snapshot("session-reused", "task-old", 10),
        );
        let (agent_tx, mut agent_rx) = mpsc::channel(1);
        fixture.runtime.pending_agent_ios.lock().unwrap().insert(
            "agent-old".into(),
            PendingAgentIo {
                session_id: "session-reused".into(),
                sender: agent_tx,
            },
        );
        fixture.runtime.pending_catalogs.lock().unwrap().insert(
            "catalog-incarnation".into(),
            catalog_query("catalog-incarnation"),
        );

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: "catalog-incarnation".into(),
                sessions: vec![catalog_session("session-reused", "task-new", 20)],
                snapshot_owner_id: "owner-incarnation".into(),
                snapshot_epoch: 2,
                next_session_offset: 1,
                complete: true,
                ..Default::default()
            },
        );

        assert_eq!(
            fixture.state.lock().unwrap().alive.get("session-reused"),
            Some(&("task-new".into(), 20))
        );
        assert!(fixture
            .runtime
            .channels
            .lock()
            .unwrap()
            .values()
            .all(|entry| { !entry.streams.contains_key("session-reused") }));
        assert!(!fixture
            .runtime
            .holders
            .lock()
            .unwrap()
            .contains_key("session-reused"));
        assert!(!fixture
            .runtime
            .agent_io_states
            .lock()
            .unwrap()
            .contains_key("session-reused"));
        assert!(!fixture
            .runtime
            .pending_snapshots
            .lock()
            .unwrap()
            .contains_key("snapshot-old"));
        assert!(!fixture
            .runtime
            .pending_agent_ios
            .lock()
            .unwrap()
            .contains_key("agent-old"));
        assert!(matches!(
            agent_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
        ));
        assert!(fixture
            .runtime
            .dirty_sessions
            .lock()
            .unwrap()
            .contains("session-reused"));

        // 另造一个旧 incarnation 的在飞 snapshot；即使 sessionId 相同，也不能读取新 taskId
        // 后把旧终端内容写成新 task 的 checkpoint。
        fixture.runtime.pending_snapshots.lock().unwrap().insert(
            "snapshot-late".into(),
            pending_snapshot("session-reused", "task-old", 10),
        );
        let snapshot = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: INTERNAL_CHANNEL_ID.into(),
            payload: Some(device_envelope::Payload::SessionSnapshot(
                wire::DeviceSessionSnapshot {
                    request_id: "snapshot-late".into(),
                    session_id: "session-reused".into(),
                    snapshot_seq: 9,
                    ansi_snapshot: b"old incarnation".to_vec(),
                    cols: 80,
                    rows: 24,
                    title: String::new(),
                },
            )),
        };
        fixture
            .runtime
            .deliver_from_sessiond(INTERNAL_CHANNEL_ID, &encode_device_envelope(&snapshot));
        assert!(fixture.checkpoints.state.lock().unwrap().pending.is_empty());

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn catalog_tombstone仅为无同id存活会话发布可靠exit() {
        let fixture = test_runtime();
        fixture
            .runtime
            .pending_catalogs
            .lock()
            .unwrap()
            .insert("catalog-exits".into(), catalog_query("catalog-exits"));
        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: "catalog-exits".into(),
                sessions: vec![catalog_session("session-reused", "task-new", 20)],
                exits: vec![
                    wire::DeviceSessionExitTombstone {
                        event_id: "exit-dead".into(),
                        session_id: "session-dead".into(),
                        task_id: "task-dead".into(),
                        exit_code: 4,
                        final_output_seq: 0,
                        exited_at: 1.0,
                    },
                    wire::DeviceSessionExitTombstone {
                        event_id: "exit-old-incarnation".into(),
                        session_id: "session-reused".into(),
                        task_id: "task-old".into(),
                        exit_code: 5,
                        final_output_seq: 0,
                        exited_at: 2.0,
                    },
                ],
                snapshot_owner_id: "owner-exits".into(),
                snapshot_epoch: 1,
                next_session_offset: 1,
                next_exit_offset: 2,
                complete: true,
                ..Default::default()
            },
        );
        let exit = fixture.exits.claim(1).await;
        let message = wire::DaemonToServer::decode(exit.bytes.as_slice()).unwrap();
        assert!(matches!(
            message.payload,
            Some(daemon_to_server::Payload::SessionExit(wire::SessionExit {
                ref session_id,
                exit_code: 4,
            })) if session_id == "session-dead"
        ));
        assert_eq!(fixture.exits.0.state.lock().unwrap().pending.len(), 1);

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn sessiond_catalog_reset_discards_partial_snapshot_and_restarts_at_page_zero() {
        let mut fixture = test_runtime();
        fixture
            .state
            .lock()
            .unwrap()
            .alive
            .insert("session-existing".into(), ("task-existing".into(), 1));
        fixture
            .runtime
            .pending_catalogs
            .lock()
            .unwrap()
            .insert("catalog-reset".into(), catalog_query("catalog-reset"));

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: "catalog-reset".into(),
                sessions: vec![catalog_session("session-old", "task-old", 10)],
                snapshot_owner_id: "owner-old".into(),
                snapshot_epoch: 4,
                session_offset: 0,
                exit_offset: 0,
                next_session_offset: 1,
                next_exit_offset: 0,
                complete: false,
                reset: false,
                ..Default::default()
            },
        );
        let continuation = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_eq!(continuation.snapshot_owner_id, "owner-old");
        assert_eq!(continuation.snapshot_epoch, 4);
        assert_eq!(continuation.session_offset, 1);

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: continuation.request_id.clone(),
                snapshot_owner_id: "owner-new".into(),
                snapshot_epoch: 1,
                session_offset: 1,
                exit_offset: 0,
                complete: false,
                reset: true,
                ..Default::default()
            },
        );
        let restarted = receive_catalog_request(&mut fixture.from_supervisor).await;
        assert_ne!(restarted.request_id, continuation.request_id);
        assert!(restarted.snapshot_owner_id.is_empty());
        assert_eq!(restarted.snapshot_epoch, 0);
        assert_eq!(restarted.session_offset, 0);
        assert_eq!(restarted.exit_offset, 0);
        assert!(fixture
            .state
            .lock()
            .unwrap()
            .alive
            .contains_key("session-existing"));
        assert!(fixture.catalogs.0.state.lock().unwrap().pending.is_empty());
        assert_eq!(
            fixture
                .runtime
                .pending_catalogs
                .lock()
                .unwrap()
                .queries
                .get("catalog-reset")
                .map(|query| query.sessions.len()),
            Some(0)
        );

        deliver_catalog(
            &fixture.runtime,
            DeviceSessionCatalog {
                request_id: restarted.request_id.clone(),
                sessions: vec![catalog_session("session-new", "task-new", 20)],
                snapshot_owner_id: "owner-new".into(),
                snapshot_epoch: 1,
                session_offset: 0,
                exit_offset: 0,
                next_session_offset: 1,
                next_exit_offset: 0,
                complete: true,
                reset: false,
                ..Default::default()
            },
        );
        let alive = fixture.state.lock().unwrap().alive.clone();
        assert_eq!(
            alive,
            HashMap::from([("session-new".into(), ("task-new".into(), 20))])
        );
        let delivery = fixture.catalogs.claim(2).await;
        let reported = wire::DaemonToServer::decode(delivery.bytes.as_slice()).unwrap();
        let Some(daemon_to_server::Payload::SessionCatalog(reported)) = reported.payload else {
            panic!("outbox 应上报 reset 后的新快照");
        };
        assert_eq!(reported.sessions.len(), 1);
        assert_eq!(reported.sessions[0].session_id, "session-new");
        assert_eq!(reported.snapshot_owner_id, "owner-new");
        assert!(!reported
            .sessions
            .iter()
            .any(|session| session.session_id == "session-old"));
        assert!(fixture.catalogs.acknowledge(&delivery));

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn transport_backpressure_sessiond_catalog_and_checkpoint_reconcile_through_side_channels(
    ) {
        let fixture = test_runtime();
        fixture.runtime.pending_catalogs.lock().unwrap().insert(
            "catalog-reconcile".into(),
            catalog_query("catalog-reconcile"),
        );
        let catalog = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: INTERNAL_CHANNEL_ID.into(),
            payload: Some(device_envelope::Payload::SessionCatalog(
                DeviceSessionCatalog {
                    request_id: "catalog-reconcile".into(),
                    sessions: vec![wire::DeviceSessionInfo {
                        session_id: "session-1".into(),
                        task_id: "task-1".into(),
                        pid: 42,
                        cwd: fixture.home.clone(),
                        cols: 80,
                        rows: 24,
                        output_seq: 9,
                        started_at: 1.0,
                    }],
                    exits: Vec::new(),
                    ..Default::default()
                },
            )),
        };
        fixture
            .runtime
            .deliver_from_sessiond(INTERNAL_CHANNEL_ID, &encode_device_envelope(&catalog));
        assert_eq!(
            fixture
                .state
                .lock()
                .unwrap()
                .alive
                .get("session-1")
                .map(|(task_id, pid)| (task_id.as_str(), *pid)),
            Some(("task-1", 42))
        );
        let catalog_up = tokio::time::timeout(Duration::from_secs(2), fixture.catalogs.claim(1))
            .await
            .unwrap();
        assert!(matches!(
            wire::DaemonToServer::decode(catalog_up.bytes.as_slice()).unwrap().payload,
            Some(daemon_to_server::Payload::SessionCatalog(DeviceSessionCatalog { ref request_id, .. })) if request_id == "catalog-reconcile"
        ));

        fixture.runtime.pending_snapshots.lock().unwrap().insert(
            "snapshot-1".into(),
            pending_snapshot("session-1", "task-1", 42),
        );
        let snapshot = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: INTERNAL_CHANNEL_ID.into(),
            payload: Some(device_envelope::Payload::SessionSnapshot(
                wire::DeviceSessionSnapshot {
                    request_id: "snapshot-1".into(),
                    session_id: "session-1".into(),
                    snapshot_seq: 9,
                    ansi_snapshot: b"\x1bcursor".to_vec(),
                    cols: 80,
                    rows: 24,
                    title: "osc-title".into(),
                },
            )),
        };
        fixture
            .runtime
            .deliver_from_sessiond(INTERNAL_CHANNEL_ID, &encode_device_envelope(&snapshot));
        let checkpoint = fixture.checkpoints.claim(1).await.bytes;
        assert!(matches!(
            wire::DaemonToServer::decode(checkpoint.as_slice()).unwrap().payload,
            Some(daemon_to_server::Payload::SessionCheckpoint(SessionCheckpoint { snapshot_seq: 9, ref session_id, ref title, .. }))
                if session_id == "session-1" && title == "osc-title"
        ));

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[test]
    fn transport_backpressure_detects_output_sequence_gap() {
        let mut cursor = StreamCursor {
            next_seq: Some(4),
            gapped: false,
        };
        let output = DevicePtyOutput {
            session_id: "session-1".into(),
            from_seq: 5,
            to_seq: 6,
            data: b"xx".to_vec(),
        };
        let contiguous = cursor.next_seq.is_none_or(|next| next == output.from_seq)
            && output.to_seq
                == output
                    .from_seq
                    .saturating_add(output.data.len().saturating_sub(1) as u64);
        assert!(!contiguous);
        cursor.gapped = true;
        assert!(cursor.gapped);

        let attached = DeviceSessionAttached {
            snapshot_seq: 6,
            session_id: "session-1".into(),
            ..Default::default()
        };
        cursor = StreamCursor {
            next_seq: Some(attached.snapshot_seq + 1),
            gapped: false,
        };
        assert_eq!(cursor.next_seq, Some(7));
        assert!(!cursor.gapped);
    }
}
