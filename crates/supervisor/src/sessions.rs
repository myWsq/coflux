//! PTY 会话生命周期（活在 supervisor）。每个 session 用独立 mutex 串行化 authority、VT、
//! sequence 与 attach；可能阻塞的 PTY stdin 由独立有界 writer 执行，不进入该临界区。
//! worker/中心只是可丢失并重建的 transport。

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use coflux_protocol::wire::{
    device_envelope, DeviceEnvelope, DeviceError, DeviceExitAck, DeviceOperationAck, DevicePtyGap,
    DevicePtyInput, DevicePtyInputAck, DevicePtyOutput, DevicePtyResize, DeviceSessionAttach,
    DeviceSessionAttached, DeviceSessionCatalog, DeviceSessionCatalogRequest, DeviceSessionCreate,
    DeviceSessionExitTombstone, DeviceSessionExited, DeviceSessionInfo, DeviceSessionSnapshot,
    DeviceSessionSnapshotRequest, DeviceSessionStop,
};
use coflux_protocol::{
    decode_device_envelope, encode_device_envelope, encode_frame, write_record, DataFrame,
    SessionInfo, SupervisorToWorker, DEVICE_PROTOCOL_VERSION, MAX_DEVICE_FRAME_BYTES,
    MAX_FRAME_ID_BYTES, MAX_TERMINAL_DIMENSION, MIN_TERMINAL_DIMENSION,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rand_core::{OsRng, RngCore};

use crate::sessiond::{ControlError, InputAdmission, SequencedDecision, SessionState};

const OPERATION_LEDGER_LIMIT: usize = 4096;
/// create/stop ledger 除条数外还必须按实际持有的字符串容量计费；典型记录仅数百字节，4 MiB
/// 足以保留远多于正常重试窗口的结果，同时阻止大 cwd/error 等字段把 4096 条放大成无界内存。
const OPERATION_LEDGER_BYTES: usize = 4 * 1024 * 1024;
/// HashMap control bytes、装载率余量与 VecDeque spare capacity 无法由稳定 API 精确取得；除
/// `size_of` 可见的 key/value/String header 外，每条再收一段保守容器余量。
const OPERATION_LEDGER_CONTAINER_SLOP: usize = 64;
/// 每个 session 都持一个 PTY 子进程、reader OS thread 与终端历史；实际资源上限必须远低于
/// IPC 理论容量。128 个并发活终端已覆盖正常机群使用，同时把快照大小严格压在 record 上限内。
const MAX_LIVE_SESSIONS: usize = 128;
const WORKER_QUEUE_RECORDS: usize = 512;
const WORKER_QUEUE_BYTES: usize = MAX_DEVICE_FRAME_BYTES + 2 * 1024 * 1024;
/// 与 client retained input 上限一致；两端都必须有界，不能把一个不读 stdin 的 PTY
/// 变成 supervisor 内存增长入口。
const PTY_INPUT_QUEUE_RECORDS: usize = 256;
const PTY_INPUT_QUEUE_BYTES: usize = 1024 * 1024;
/// catalog 分页只在 request.max_page_bytes 非零时启用；旧 worker 仍拿单帧完整快照。
const CATALOG_PAGE_MIN_BYTES: usize = 64 * 1024;
const CATALOG_PAGE_MAX_BYTES: usize = 1024 * 1024;
const CATALOG_PAGE_MAX_ENTRIES: usize = 128;
const CATALOG_LEASE_LIMIT: usize = 1024;
/// 未 ACK exit fact 不能随中心断线无界增长。超过窗口时只丢最旧精确退出码；下一次完整
/// catalog 的“live 缺席”仍会把中心 task 收敛为 EXITED，因此不会留下永久僵尸。
/// 会话归属 id（plan 092）：中心随建会话请求带下来，supervisor 在 [`Sessions::create_session`] 里组装成
/// `COFLUX_*` 环境变量注入 PTY，让跑在里面的 agent 读环境变量就知道自己在哪台设备/项目/工作区/终端。
/// 变量名与组装只在 supervisor 一处，中心与 worker 只下发 id，不下发任意 env map。
/// 缺失（旧中心 / 旧 worker）为空串：对应变量仍然存在、值为空；`session_id` / `task_id` supervisor 自己知道，
/// 所以 SKILL 的探测规则以 `COFLUX_WORKSPACE_ID` 非空作为「在 coflux 且已升级」的判据。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionContext {
    pub daemon_id: String,
    /// 无仓库的目录工作区为空串
    pub project_id: String,
    pub workspace_id: String,
    /// 中心 MCP 地址（`<COFLUX_PUBLIC_URL>/mcp`）
    pub mcp_url: String,
}

const EXIT_TOMBSTONE_LIMIT: usize = 4096;
const EXIT_TOMBSTONE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct TombstoneStore {
    entries: VecDeque<DeviceSessionExitTombstone>,
    bytes: usize,
}

impl TombstoneStore {
    fn weight(event: &DeviceSessionExitTombstone) -> usize {
        event.event_id.len() + event.session_id.len() + event.task_id.len() + 64
    }

    fn push(&mut self, event: DeviceSessionExitTombstone) {
        let weight = Self::weight(&event);
        while !self.entries.is_empty()
            && (self.entries.len() >= EXIT_TOMBSTONE_LIMIT
                || weight > EXIT_TOMBSTONE_BYTES.saturating_sub(self.bytes))
        {
            if let Some(removed) = self.entries.pop_front() {
                self.bytes = self.bytes.saturating_sub(Self::weight(&removed));
            }
        }
        if weight <= EXIT_TOMBSTONE_BYTES {
            self.bytes += weight;
            self.entries.push_back(event);
        }
    }

    fn acknowledge(&mut self, event_ids: &HashSet<&str>) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|event| !event_ids.contains(event.event_id.as_str()));
        if self.entries.len() != before {
            self.bytes = self.entries.iter().map(Self::weight).sum();
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
struct CatalogLease {
    snapshot_owner_id: String,
    snapshot_epoch: u64,
}

struct ConnectionSink {
    generation: u64,
    sender: SyncSender<Vec<u8>>,
    pending_bytes: Arc<AtomicUsize>,
    shutdown: Option<UnixStream>,
}

/// 每次 worker 连接拥有独立有界队列/写线程；旧写端即使永久阻塞，也不能卡住新 worker 或 PTY。
pub struct Outbound {
    current: Mutex<Option<ConnectionSink>>,
    record_limit: usize,
    byte_limit: usize,
}

impl Outbound {
    pub fn new() -> Arc<Self> {
        Self::with_limits(WORKER_QUEUE_RECORDS, WORKER_QUEUE_BYTES)
    }

    fn with_limits(record_limit: usize, byte_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            current: Mutex::new(None),
            record_limit,
            byte_limit,
        })
    }

    pub fn connect(self: &Arc<Self>, generation: u64, mut stream: UnixStream) {
        let (sender, receiver) = sync_channel(self.record_limit);
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        let shutdown = stream.try_clone().ok();
        self.replace(Some(ConnectionSink {
            generation,
            sender,
            pending_bytes: pending_bytes.clone(),
            shutdown,
        }));
        let this = Arc::clone(self);
        thread::spawn(move || {
            for record in receiver {
                let length = record.len();
                if !this.is_current(generation) || stream.write_all(&record).is_err() {
                    pending_bytes.fetch_sub(length, Ordering::AcqRel);
                    break;
                }
                pending_bytes.fetch_sub(length, Ordering::AcqRel);
            }
            this.disconnect(generation);
            // 同一 socket 的 read clone 可能仍阻塞；shutdown 使旧 handler 及时退出，不能继续变更 authority。
            let _ = stream.shutdown(Shutdown::Both);
        });
    }

    pub fn disconnect(&self, generation: u64) {
        let removed = {
            let mut current = self.current.lock().unwrap();
            if current
                .as_ref()
                .is_some_and(|sink| sink.generation == generation)
            {
                current.take()
            } else {
                None
            }
        };
        Self::shutdown(removed);
    }

    fn clear(&self) {
        self.replace(None);
    }

    fn replace(&self, replacement: Option<ConnectionSink>) {
        let previous = std::mem::replace(&mut *self.current.lock().unwrap(), replacement);
        Self::shutdown(previous);
    }

    fn shutdown(sink: Option<ConnectionSink>) {
        if let Some(stream) = sink.and_then(|sink| sink.shutdown) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|sink| sink.generation == generation)
    }

    fn try_send(&self, record: Vec<u8>) -> bool {
        let mut current = self.current.lock().unwrap();
        let Some(sink) = current.as_ref() else {
            return false;
        };
        let length = record.len();
        if !reserve_pending_bytes(&sink.pending_bytes, length, self.byte_limit) {
            return false;
        }
        match sink.sender.try_send(record) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                sink.pending_bytes.fetch_sub(length, Ordering::AcqRel);
                false
            }
            Err(TrySendError::Disconnected(_)) => {
                sink.pending_bytes.fetch_sub(length, Ordering::AcqRel);
                let removed = current.take();
                drop(current);
                Self::shutdown(removed);
                false
            }
        }
    }

    #[cfg(test)]
    fn connect_sender(&self, generation: u64, sender: SyncSender<Vec<u8>>) {
        self.replace(Some(ConnectionSink {
            generation,
            sender,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
            shutdown: None,
        }));
    }
}

fn reserve_pending_bytes(pending: &AtomicUsize, length: usize, limit: usize) -> bool {
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

#[derive(Clone, PartialEq)]
enum OperationRequest {
    Create(DeviceSessionCreate),
    Stop(DeviceSessionStop),
}

fn canonical_stop_request(request: &DeviceSessionStop) -> DeviceSessionStop {
    let mut canonical = request.clone();
    canonical.request_id = String::new();
    canonical
}

fn canonical_create_request(request: &DeviceSessionCreate) -> DeviceSessionCreate {
    let mut canonical = request.clone();
    canonical.request_id = String::new();
    canonical
}

/// legacy worker 没有 operationId，只能按当前 live identity 判定重复 create 的含义。
/// 同 task 是可安全重放的幂等请求；不同 task 必须使用旧 worker 不认识的新 variant，
/// 绝不能伪装成 session.exit 误删已经存活的会话。
fn legacy_create_response(
    session_id: &str,
    task_id: &str,
    existing: Option<(String, i32)>,
    error: &str,
) -> SupervisorToWorker {
    match existing {
        Some((existing_task_id, pid)) if existing_task_id == task_id => {
            SupervisorToWorker::SessionStarted {
                session_id: session_id.to_string(),
                task_id: existing_task_id,
                pid,
            }
        }
        Some((existing_task_id, _)) => SupervisorToWorker::SessionCreateFailed {
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
            error: format!("{error}；session id 当前属于 task {existing_task_id}"),
        },
        None => SupervisorToWorker::SessionExit {
            session_id: session_id.to_string(),
            exit_code: -1,
            task_id: Some(task_id.to_string()),
            pid: None,
        },
    }
}

#[derive(Clone)]
struct StoredOperation {
    request: OperationRequest,
    ack: DeviceOperationAck,
    weight: usize,
}

#[derive(Default)]
struct OperationLedger {
    entries: HashMap<String, StoredOperation>,
    order: VecDeque<String>,
    bytes: usize,
}

impl OperationLedger {
    fn request_bytes(request: &OperationRequest) -> usize {
        match request {
            OperationRequest::Stop(value) => {
                value.request_id.capacity()
                    + value.operation_id.capacity()
                    + value.session_id.capacity()
            }
            OperationRequest::Create(value) => {
                value.request_id.capacity()
                    + value.operation_id.capacity()
                    + value.session_id.capacity()
                    + value.task_id.capacity()
                    + value.cwd.capacity()
                    + value.shell.as_ref().map_or(0, String::capacity)
            }
        }
    }

    fn ack_bytes(ack: &DeviceOperationAck) -> usize {
        ack.request_id.capacity()
            + ack.operation_id.capacity()
            + ack.error.as_ref().map_or(0, String::capacity)
            + ack.session_id.as_ref().map_or(0, String::capacity)
    }

    fn weight(
        operation_id: &String,
        request: &OperationRequest,
        ack: &DeviceOperationAck,
    ) -> usize {
        std::mem::size_of::<StoredOperation>()
            // HashMap key 与 FIFO order 各有一个 String header；其字符 allocation 在下方计。
            .saturating_add(2 * std::mem::size_of::<String>())
            .saturating_add(OPERATION_LEDGER_CONTAINER_SLOP)
            // operation_id 同时由 HashMap key 与 FIFO order 持有；clone 的 capacity 至少为 len。
            .saturating_add(operation_id.capacity())
            .saturating_add(operation_id.len())
            .saturating_add(Self::request_bytes(request))
            .saturating_add(Self::ack_bytes(ack))
    }

    fn cached(
        &self,
        operation_id: &str,
        request: &OperationRequest,
    ) -> Result<Option<DeviceOperationAck>, ()> {
        match self.entries.get(operation_id) {
            Some(stored) if &stored.request == request => Ok(Some(stored.ack.clone())),
            Some(_) => Err(()),
            None => Ok(None),
        }
    }

    fn remember(
        &mut self,
        operation_id: String,
        request: OperationRequest,
        ack: DeviceOperationAck,
    ) {
        self.remember_with_limits(
            operation_id,
            request,
            ack,
            OPERATION_LEDGER_LIMIT,
            OPERATION_LEDGER_BYTES,
        );
    }

    fn remember_with_limits(
        &mut self,
        operation_id: String,
        request: OperationRequest,
        ack: DeviceOperationAck,
        entry_limit: usize,
        byte_limit: usize,
    ) {
        let weight = Self::weight(&operation_id, &request, &ack);
        if let Some(previous) = self.entries.remove(&operation_id) {
            self.bytes = self.bytes.saturating_sub(previous.weight);
        } else {
            self.order.push_back(operation_id.clone());
        }
        self.bytes = self.bytes.saturating_add(weight);
        self.entries.insert(
            operation_id,
            StoredOperation {
                request,
                ack,
                weight,
            },
        );
        while self.entries.len() > entry_limit || self.bytes > byte_limit {
            if let Some(oldest) = self.order.pop_front() {
                if let Some(removed) = self.entries.remove(&oldest) {
                    self.bytes = self.bytes.saturating_sub(removed.weight);
                }
            } else {
                // 防御内部索引漂移；正常路径下 order 与 entries 必然一一对应。
                self.entries.clear();
                self.bytes = 0;
                break;
            }
        }
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    input: InputQueue,
    child: Box<dyn Child + Send + Sync>,
    task_id: String,
    cwd: String,
    pid: i32,
    started_at: f64,
    state: SessionState,
}

struct QueuedInput {
    client_instance_id: String,
    input_seq: u64,
    data: Vec<u8>,
}

struct InputQueue {
    sender: SyncSender<QueuedInput>,
    pending_records: Arc<AtomicUsize>,
    pending_bytes: Arc<AtomicUsize>,
    record_limit: usize,
    byte_limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputQueueError {
    Full,
    Disconnected,
}

impl InputQueue {
    fn new() -> (Self, Receiver<QueuedInput>) {
        Self::with_limits(PTY_INPUT_QUEUE_RECORDS, PTY_INPUT_QUEUE_BYTES)
    }

    fn with_limits(record_limit: usize, byte_limit: usize) -> (Self, Receiver<QueuedInput>) {
        let (sender, receiver) = sync_channel(record_limit);
        (
            Self {
                sender,
                pending_records: Arc::new(AtomicUsize::new(0)),
                pending_bytes: Arc::new(AtomicUsize::new(0)),
                record_limit,
                byte_limit,
            },
            receiver,
        )
    }

    fn try_send(&self, input: QueuedInput) -> Result<(), InputQueueError> {
        let length = input.data.len();
        if !reserve_pending_bytes(&self.pending_records, 1, self.record_limit) {
            return Err(InputQueueError::Full);
        }
        if !reserve_pending_bytes(&self.pending_bytes, length, self.byte_limit) {
            self.pending_records.fetch_sub(1, Ordering::AcqRel);
            return Err(InputQueueError::Full);
        }
        match self.sender.try_send(input) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.pending_records.fetch_sub(1, Ordering::AcqRel);
                self.pending_bytes.fetch_sub(length, Ordering::AcqRel);
                Err(InputQueueError::Full)
            }
            Err(TrySendError::Disconnected(_)) => {
                self.pending_records.fetch_sub(1, Ordering::AcqRel);
                self.pending_bytes.fetch_sub(length, Ordering::AcqRel);
                Err(InputQueueError::Disconnected)
            }
        }
    }
}

#[derive(Debug)]
struct PtyWriteFailure {
    written: usize,
    error: std::io::Error,
}

struct InputBudgetGuard<'a> {
    pending_records: &'a AtomicUsize,
    pending_bytes: &'a AtomicUsize,
    length: usize,
}

impl Drop for InputBudgetGuard<'_> {
    fn drop(&mut self) {
        self.pending_records.fetch_sub(1, Ordering::AcqRel);
        self.pending_bytes.fetch_sub(self.length, Ordering::AcqRel);
    }
}

/// 不使用 `write_all`，因为错误里没有“已经写了多少”的信息。显式维护 offset 后，partial
/// failure 可以封死该 reservation 并终止 session，而不是让 client 从 byte 0 全量重投。
fn write_pty_input(writer: &mut dyn Write, data: &[u8]) -> Result<(), PtyWriteFailure> {
    let mut written = 0;
    while written < data.len() {
        match writer.write(&data[written..]) {
            Ok(0) => {
                return Err(PtyWriteFailure {
                    written,
                    error: std::io::Error::new(ErrorKind::WriteZero, "PTY writer 未推进"),
                });
            }
            Ok(length) if length <= data.len() - written => written += length,
            Ok(_) => {
                return Err(PtyWriteFailure {
                    written,
                    error: std::io::Error::new(ErrorKind::InvalidData, "PTY writer 返回越界长度"),
                });
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(PtyWriteFailure { written, error }),
        }
    }
    Ok(())
}

type SessionHandle = Arc<Mutex<Session>>;

pub struct Sessions {
    map: Mutex<HashMap<String, SessionHandle>>,
    outbound: Arc<Outbound>,
    shell: String,
    home: String,
    history_line_limit: usize,
    tombstones: Mutex<TombstoneStore>,
    next_event_id: AtomicU64,
    /// 同一 supervisor 启动实例内单调；owner 跨重启变化，明确切断旧 outbox 代际。
    snapshot_owner_id: String,
    snapshot_epoch: AtomicU64,
    /// 只有确实完整投递过 catalog 的 request/epoch 才能确认 tombstone。
    catalog_leases: Mutex<BTreeMap<String, CatalogLease>>,
    operations: Mutex<OperationLedger>,
}

impl Sessions {
    pub fn new(
        outbound: Arc<Outbound>,
        shell: String,
        home: String,
        history_line_limit: usize,
    ) -> Arc<Self> {
        let mut owner = [0u8; 16];
        OsRng.fill_bytes(&mut owner);
        Arc::new(Self {
            map: Mutex::new(HashMap::new()),
            outbound,
            shell,
            home,
            history_line_limit,
            tombstones: Mutex::new(TombstoneStore::default()),
            next_event_id: AtomicU64::new(0),
            snapshot_owner_id: hex::encode(owner),
            snapshot_epoch: AtomicU64::new(1),
            catalog_leases: Mutex::new(BTreeMap::new()),
            operations: Mutex::new(OperationLedger::default()),
        })
    }

    fn bump_snapshot_epoch(&self) {
        let _ = self
            .snapshot_epoch
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |epoch| {
                Some(epoch.saturating_add(1))
            });
    }

    fn send_record(&self, record: Vec<u8>) -> bool {
        self.outbound.try_send(record)
    }

    fn send_ctrl(&self, message: &SupervisorToWorker) -> bool {
        serde_json::to_vec(message)
            .ok()
            .and_then(|bytes| write_record(&bytes).ok())
            .is_some_and(|record| self.send_record(record))
    }

    /// 生命周期 control 一旦因有界队列满而未入队，主动切断当前 UDS，迫使 worker
    /// 重连并通过 resync.list / session catalog 从 supervisor 权威状态收敛。
    fn send_ctrl_or_disconnect(&self, message: &SupervisorToWorker, context: &str) -> bool {
        if self.send_ctrl(message) {
            return true;
        }
        eprintln!("[supervisor] control 未入队，断开 worker 触发 resync: {context}");
        self.outbound.clear();
        false
    }

    fn send_device(&self, channel_id: &str, payload: device_envelope::Payload) -> bool {
        let envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.to_string(),
            payload: Some(payload),
        };
        let data = encode_device_envelope(&envelope);
        if data.len() > MAX_DEVICE_FRAME_BYTES {
            return false;
        }
        let Ok(frame) = encode_frame(&DataFrame::Device {
            channel_id: channel_id.to_string(),
            data,
        }) else {
            return false;
        };
        write_record(&frame).is_ok_and(|record| self.send_record(record))
    }

    fn send_device_error(
        &self,
        channel_id: &str,
        request_id: Option<String>,
        code: &str,
        message: impl Into<String>,
    ) {
        self.send_device(
            channel_id,
            device_envelope::Payload::Error(DeviceError {
                request_id,
                code: code.to_string(),
                message: message.into(),
            }),
        );
    }

    fn deliver_pending_gaps(&self, session_id: &str, state: &mut SessionState) {
        for gap in state.pending_gaps() {
            let sent = self.send_device(
                &gap.channel_id,
                device_envelope::Payload::PtyGap(DevicePtyGap {
                    session_id: session_id.to_string(),
                    expected_seq: gap.expected_seq,
                    available_seq: gap.available_seq,
                }),
            );
            state.gap_delivery_result(&gap.channel_id, sent);
        }
    }

    fn get(&self, session_id: &str) -> Option<SessionHandle> {
        self.map.lock().unwrap().get(session_id).cloned()
    }

    /// duplicate create 的回执必须与自然退出形成全序：先锁候选 session，再确认它仍是
    /// map 当前 incarnation，并在两把锁都持有时把 Started/CreateFailed 入队。自然退出
    /// 使用相同 session → map 锁序；因此要么回执先入队、随后 Exit，要么 exit 先摘 map、
    /// 本函数返回 false，绝不会在 Exit 后发送 stale Started。
    fn respond_to_current_legacy_create_attempt(
        &self,
        session_id: &str,
        task_id: &str,
        candidate: &SessionHandle,
        error: &str,
    ) -> bool {
        let locked = candidate.lock().unwrap();
        let map = self.map.lock().unwrap();
        if !map
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, candidate))
        {
            return false;
        }
        let existing = (locked.task_id.clone(), locked.pid);
        self.respond_to_legacy_create_attempt(session_id, task_id, Some(existing), error);
        true
    }

    fn respond_to_live_legacy_create_attempt(
        &self,
        session_id: &str,
        task_id: &str,
        error: &str,
    ) -> bool {
        let Some(candidate) = self.get(session_id) else {
            return false;
        };
        self.respond_to_current_legacy_create_attempt(session_id, task_id, &candidate, error)
    }

    pub fn create(
        self: &Arc<Self>,
        session_id: String,
        task_id: String,
        cwd: String,
        shell: String,
        cols: u16,
        rows: u16,
        context: SessionContext,
    ) {
        if self.respond_to_live_legacy_create_attempt(&session_id, &task_id, "duplicate session id")
        {
            return;
        }
        if let Err(error) = self.create_session(
            session_id.clone(),
            task_id.clone(),
            cwd,
            shell,
            cols,
            rows,
            context,
        ) {
            // create_session 在 spawn 后会二次检查 ID；若并发请求抢先插入，这里必须按
            // 最终 live identity 分类，不能把竞争失败降级成 legacy session.exit。
            if !self.respond_to_live_legacy_create_attempt(&session_id, &task_id, &error) {
                self.respond_to_legacy_create_attempt(&session_id, &task_id, None, &error);
            }
        }
    }

    fn respond_to_legacy_create_attempt(
        &self,
        session_id: &str,
        task_id: &str,
        existing: Option<(String, i32)>,
        error: &str,
    ) {
        let message = legacy_create_response(session_id, task_id, existing, error);
        match &message {
            SupervisorToWorker::SessionStarted { pid, .. } => {
                eprintln!("[supervisor] duplicate session create 幂等重放 {session_id} pid={pid}");
            }
            SupervisorToWorker::SessionCreateFailed { error, .. } => {
                eprintln!("[supervisor] session create identity 冲突 {session_id}: {error}");
            }
            SupervisorToWorker::SessionExit { .. } => {
                eprintln!("[supervisor] session create failed {session_id}: {error}");
            }
            _ => unreachable!("legacy create 只生成 session 生命周期回执"),
        }
        self.send_ctrl_or_disconnect(&message, "legacy session.create 回执");
    }

    fn create_session(
        self: &Arc<Self>,
        session_id: String,
        task_id: String,
        cwd: String,
        shell: String,
        cols: u16,
        rows: u16,
        context: SessionContext,
    ) -> Result<i32, String> {
        if session_id.as_bytes().len() > MAX_FRAME_ID_BYTES {
            return Err(format!("session id 超过 {MAX_FRAME_ID_BYTES} 字节"));
        }
        if task_id.as_bytes().len() > MAX_FRAME_ID_BYTES {
            return Err(format!("task id 超过 {MAX_FRAME_ID_BYTES} 字节"));
        }
        {
            let map = self.map.lock().unwrap();
            if map.len() >= MAX_LIVE_SESSIONS {
                return Err(format!("存活 session 已达上限 {MAX_LIVE_SESSIONS}"));
            }
            if map.contains_key(&session_id) {
                return Err("duplicate session id".into());
            }
        }
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("openpty: {error}"))?;
        let shell = if shell.is_empty() {
            self.shell.clone()
        } else {
            shell
        };
        let cwd = if cwd.is_empty() {
            self.home.clone()
        } else {
            cwd
        };
        let mut command = CommandBuilder::new(&shell);
        command.cwd(&cwd);
        for (key, value) in std::env::vars() {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        // plan 092：会话归属 id 以 COFLUX_* 注入，必须写在拷贝 std::env 之后（覆盖语义，supervisor 自身
        // 环境里的同名变量不能盖掉它）。六个变量总是存在：中心没下发的为空串，session/task id 本地必有。
        // 变量名是 agent 面向的契约（写进 SKILL.md），只能加不能改。
        command.env("COFLUX_DEVICE_ID", &context.daemon_id);
        command.env("COFLUX_PROJECT_ID", &context.project_id);
        command.env("COFLUX_WORKSPACE_ID", &context.workspace_id);
        command.env("COFLUX_TASK_ID", &task_id);
        command.env("COFLUX_SESSION_ID", &session_id);
        command.env("COFLUX_MCP_URL", &context.mcp_url);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn: {error}"))?;
        drop(pair.slave);
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("clone_reader: {error}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("take_writer: {error}"));
            }
        };
        let (input, input_receiver) = InputQueue::new();
        let input_pending_records = input.pending_records.clone();
        let input_pending_bytes = input.pending_bytes.clone();
        let pid = child.process_id().map_or(-1, |pid| pid as i32);
        let session = {
            // spawn 期间另一入口可能抢占 ID/最后名额；插入点再次检查，失败先杀孤儿进程。
            let mut map = self.map.lock().unwrap();
            let duplicate = map.contains_key(&session_id);
            if map.len() >= MAX_LIVE_SESSIONS || duplicate {
                drop(map);
                let _ = child.kill();
                return Err(if duplicate {
                    "duplicate session id".into()
                } else {
                    format!("存活 session 已达上限 {MAX_LIVE_SESSIONS}")
                });
            }
            let session = Arc::new(Mutex::new(Session {
                master: pair.master,
                input,
                child,
                task_id: task_id.clone(),
                cwd,
                pid,
                started_at: now_ms(),
                state: SessionState::new(rows, cols, self.history_line_limit),
            }));
            map.insert(session_id.clone(), session.clone());
            self.bump_snapshot_epoch();
            session
        };
        eprintln!("[supervisor] session started {session_id} pid={pid}");
        self.send_ctrl_or_disconnect(
            &SupervisorToWorker::SessionStarted {
                session_id: session_id.clone(),
                task_id,
                pid,
            },
            "session.started",
        );
        self.spawn_input_writer(
            session_id.clone(),
            Arc::downgrade(&session),
            writer,
            input_receiver,
            input_pending_records,
            input_pending_bytes,
        );
        self.spawn_reader(session_id, session, reader);
        Ok(pid)
    }

    fn spawn_input_writer(
        self: &Arc<Self>,
        session_id: String,
        session: Weak<Mutex<Session>>,
        mut writer: Box<dyn Write + Send>,
        receiver: Receiver<QueuedInput>,
        pending_records: Arc<AtomicUsize>,
        pending_bytes: Arc<AtomicUsize>,
    ) {
        let sessions = Arc::downgrade(self);
        thread::spawn(move || {
            for input in receiver {
                let length = input.data.len();
                // 直到写入结果已经提交/封死，command 才真正离开 bounded budget；否则
                // writer 写完与 state commit 之间会短暂放进第 257 条 reservation。
                let _budget = InputBudgetGuard {
                    pending_records: &pending_records,
                    pending_bytes: &pending_bytes,
                    length,
                };
                let result = write_pty_input(writer.as_mut(), &input.data);

                let Some(session) = session.upgrade() else {
                    break;
                };
                match result {
                    Ok(()) => {
                        let completion = session
                            .lock()
                            .unwrap()
                            .state
                            .complete_input(&input.client_instance_id, input.input_seq);
                        match completion {
                            Ok(completion) => {
                                if let Some(sessions) = sessions.upgrade() {
                                    sessions.send_device(
                                        &completion.channel_id,
                                        device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                                            session_id: session_id.clone(),
                                            applied_through_seq: completion.applied_through_seq,
                                        }),
                                    );
                                }
                            }
                            Err(error) => {
                                eprintln!(
                                    "[supervisor] PTY input commit 失败 session={session_id} seq={}: {}",
                                    input.input_seq, error.message
                                );
                                let mut locked = session.lock().unwrap();
                                let _ = locked.state.fail_input(
                                    &input.client_instance_id,
                                    input.input_seq,
                                    "pty_input_state_failed",
                                    error.message,
                                );
                                let _ = locked.child.kill();
                                break;
                            }
                        }
                    }
                    Err(failure) => {
                        let code = if failure.written == 0 {
                            "pty_write_failed"
                        } else {
                            "pty_write_partial"
                        };
                        let message = if failure.written == 0 {
                            format!("PTY input 写入失败，session 已终止：{}", failure.error)
                        } else {
                            format!(
                                "PTY input 仅写入 {}/{} 字节，session 已终止以防重放前缀：{}",
                                failure.written, length, failure.error
                            )
                        };
                        eprintln!(
                            "[supervisor] {code} session={session_id} seq={} written={}/{}: {}",
                            input.input_seq, failure.written, length, failure.error
                        );
                        let target = {
                            let mut locked = session.lock().unwrap();
                            let target = locked.state.fail_input(
                                &input.client_instance_id,
                                input.input_seq,
                                code,
                                message.clone(),
                            );
                            // PTY byte stream 已不能证明完整性；kill 也会唤醒通常阻塞在
                            // master write 的 writer，并让 reader 走统一 exit/tombstone 路径。
                            let _ = locked.child.kill();
                            target
                        };
                        if let (Ok(target), Some(sessions)) = (target, sessions.upgrade()) {
                            sessions.send_device_error(
                                &target.channel_id,
                                Some(target.request_id),
                                code,
                                message,
                            );
                        }
                        break;
                    }
                }
            }
        });
    }

    fn spawn_reader(
        self: &Arc<Self>,
        session_id: String,
        session: SessionHandle,
        mut reader: Box<dyn Read + Send>,
    ) {
        let this = Arc::clone(self);
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        let chunk = &buffer[..length];
                        let mut locked = session.lock().unwrap();
                        let pending = locked.state.feed(chunk);

                        // 只通知 worker 该 session 的派生 checkpoint 已脏；PTY 原始字节不离开
                        // supervisor/sessiond。保留旧 output frame 编号便于跨版本 worker 忽略 payload。
                        let dirty = match encode_frame(&DataFrame::Output {
                            session_id: session_id.clone(),
                            data: Vec::new(),
                        }) {
                            Ok(frame) => frame,
                            Err(error) => {
                                eprintln!("[supervisor] session dirty frame 编码失败 session={session_id}: {error}");
                                return;
                            }
                        };
                        if let Ok(record) = write_record(&dirty) {
                            this.send_record(record);
                        }

                        for delivery in pending {
                            let output = DevicePtyOutput {
                                session_id: session_id.clone(),
                                from_seq: delivery.delta.from_seq,
                                to_seq: delivery.delta.to_seq,
                                data: delivery.delta.data,
                            };
                            let sent = this.send_device(
                                &delivery.channel_id,
                                device_envelope::Payload::PtyOutput(output),
                            );
                            locked.state.delivery_result(
                                &delivery.channel_id,
                                delivery.delta.to_seq,
                                sent,
                            );
                        }
                        this.deliver_pending_gaps(&session_id, &mut locked.state);
                    }
                }
            }

            // reader 可先见 EOF，而子进程仍存活；不能拿 session mutex 阻塞 wait，否则
            // close/shutdown/resync 都无法取得锁来终止或接管。
            let code = loop {
                match session.lock().unwrap().child.try_wait() {
                    Ok(Some(status)) => break status.exit_code() as i32,
                    Err(_) => break -1,
                    Ok(None) => thread::sleep(Duration::from_millis(20)),
                }
            };
            let locked = session.lock().unwrap();
            let final_output_seq = locked.state.output_seq();
            let task_id = locked.task_id.clone();
            let pid = locked.pid;
            let channels = locked.state.subscriber_channels();
            let event_number = this.next_event_id.fetch_add(1, Ordering::Relaxed) + 1;
            let tombstone = DeviceSessionExitTombstone {
                event_id: format!("exit-{}-{event_number}", std::process::id()),
                session_id: session_id.clone(),
                task_id: task_id.clone(),
                exit_code: code,
                final_output_seq,
                exited_at: now_ms(),
            };
            let transitioned = {
                let mut map = this.map.lock().unwrap();
                if map
                    .get(&session_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    // 与 device_catalog 使用相同的 map → tombstones 锁顺序，使 live→exit 在
                    // catalog 视角中是一次原子切换。
                    let mut tombstones = this.tombstones.lock().unwrap();
                    map.remove(&session_id);
                    tombstones.push(tombstone);
                    this.bump_snapshot_epoch();
                    true
                } else {
                    false
                }
            };
            drop(locked);

            if transitioned {
                eprintln!("[supervisor] session exited {session_id} code={code}");
                for channel_id in channels {
                    this.send_device(
                        &channel_id,
                        device_envelope::Payload::SessionExited(DeviceSessionExited {
                            session_id: session_id.clone(),
                            exit_code: code,
                            final_output_seq,
                        }),
                    );
                }
                this.send_ctrl_or_disconnect(
                    &SupervisorToWorker::SessionExit {
                        session_id,
                        exit_code: code,
                        task_id: Some(task_id),
                        pid: Some(pid),
                    },
                    "自然退出 session.exit",
                );
            }
        });
    }

    // 单 session 的内存天然由 COFLUX_HISTORY_LINES 封顶（history 行数 × 列宽），故不再做全局
    // 字节预算：那套 reservation 用保守估算（wrap ×4、cell 40B）虚高约一个数量级，结果是机器
    // 内存充裕却拒绝开新终端 / 拒绝 attach 更宽的客户端。
    fn resize_locked(&self, session: &mut Session, rows: u16, cols: u16) -> Result<(), String> {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        session.state.resize(rows, cols);
        Ok(())
    }

    pub fn close(&self, session_id: &str) {
        if let Some(session) = self.get(session_id) {
            let _ = session.lock().unwrap().child.kill();
        }
    }

    pub fn send_resync(&self, nonce: String) -> bool {
        let handles: Vec<(String, SessionHandle)> = self
            .map
            .lock()
            .unwrap()
            .iter()
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect();
        let sessions = handles
            .into_iter()
            .map(|(session_id, session)| {
                let locked = session.lock().unwrap();
                SessionInfo {
                    session_id,
                    task_id: locked.task_id.clone(),
                    pid: locked.pid,
                }
            })
            .collect();
        self.send_ctrl(&SupervisorToWorker::ResyncList {
            nonce,
            snapshot_owner_id: self.snapshot_owner_id.clone(),
            snapshot_epoch: self.snapshot_epoch.load(Ordering::Acquire),
            sessions,
        })
    }

    pub fn handle_device(self: &Arc<Self>, outer_channel_id: &str, bytes: &[u8]) {
        let Some(envelope) = decode_device_envelope(bytes) else {
            return self.send_device_error(
                outer_channel_id,
                None,
                "malformed_envelope",
                "DeviceEnvelope 解码失败",
            );
        };
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION {
            return self.send_device_error(
                outer_channel_id,
                None,
                "version_mismatch",
                "Device protocol version 不兼容",
            );
        }
        if envelope.channel_id != outer_channel_id {
            return self.send_device_error(
                outer_channel_id,
                None,
                "channel_mismatch",
                "inner/outer channelId 不一致",
            );
        }
        let Some(payload) = envelope.payload else {
            return self.send_device_error(
                outer_channel_id,
                None,
                "empty_payload",
                "DeviceEnvelope payload 为空",
            );
        };
        match payload {
            device_envelope::Payload::SessionCatalogRequest(request) => {
                self.device_catalog(outer_channel_id, request)
            }
            device_envelope::Payload::SessionAttach(request) => {
                self.device_attach(outer_channel_id, request)
            }
            device_envelope::Payload::SessionSnapshotRequest(request) => {
                self.device_snapshot(outer_channel_id, request)
            }
            device_envelope::Payload::PtyInput(request) => {
                self.device_input(outer_channel_id, request)
            }
            device_envelope::Payload::PtyResize(request) => {
                self.device_resize(outer_channel_id, request)
            }
            device_envelope::Payload::SessionStop(request) => {
                self.device_stop(outer_channel_id, request)
            }
            device_envelope::Payload::SessionCreate(request) => {
                self.device_create(outer_channel_id, request)
            }
            device_envelope::Payload::ExitAck(request) => self.device_exit_ack(request),
            other => self.send_device_error(
                outer_channel_id,
                request_id_of(&other),
                "unsupported_by_sessiond",
                "该 Device payload 不属于当前 sessiond 路由",
            ),
        }
    }

    fn device_catalog(&self, channel_id: &str, request: DeviceSessionCatalogRequest) {
        let (handles, exits, snapshot_epoch): (
            Vec<(String, SessionHandle)>,
            Vec<DeviceSessionExitTombstone>,
            u64,
        ) = {
            let map = self.map.lock().unwrap();
            let tombstones = self.tombstones.lock().unwrap();
            let mut handles: Vec<_> = map
                .iter()
                .map(|(id, session)| (id.clone(), session.clone()))
                .collect();
            handles.sort_by(|a, b| a.0.cmp(&b.0));
            (
                handles,
                tombstones.entries.iter().cloned().collect(),
                self.snapshot_epoch.load(Ordering::Acquire),
            )
        };
        let sessions: Vec<_> = handles
            .into_iter()
            .map(|(session_id, session)| {
                let locked = session.lock().unwrap();
                DeviceSessionInfo {
                    session_id,
                    task_id: locked.task_id.clone(),
                    pid: locked.pid,
                    cwd: locked.cwd.clone(),
                    cols: u32::from(locked.state.cols()),
                    rows: u32::from(locked.state.rows()),
                    output_seq: locked.state.output_seq(),
                    started_at: locked.started_at,
                }
            })
            .collect();

        let legacy = request.max_page_bytes == 0;
        let owner_matches = request.snapshot_owner_id.is_empty()
            || (request.snapshot_owner_id == self.snapshot_owner_id
                && request.snapshot_epoch == snapshot_epoch);
        let offsets_valid = (request.session_offset as usize) <= sessions.len()
            && (request.exit_offset as usize) <= exits.len();
        if !legacy && (!owner_matches || !offsets_valid) {
            self.send_device(
                channel_id,
                device_envelope::Payload::SessionCatalog(DeviceSessionCatalog {
                    request_id: request.request_id,
                    sessions: Vec::new(),
                    exits: Vec::new(),
                    snapshot_owner_id: self.snapshot_owner_id.clone(),
                    snapshot_epoch,
                    session_offset: request.session_offset,
                    exit_offset: request.exit_offset,
                    next_session_offset: 0,
                    next_exit_offset: 0,
                    complete: false,
                    reset: true,
                }),
            );
            return;
        }

        let mut response = DeviceSessionCatalog {
            request_id: request.request_id.clone(),
            sessions: Vec::new(),
            exits: Vec::new(),
            snapshot_owner_id: self.snapshot_owner_id.clone(),
            snapshot_epoch,
            session_offset: request.session_offset,
            exit_offset: request.exit_offset,
            next_session_offset: request.session_offset,
            next_exit_offset: request.exit_offset,
            complete: false,
            reset: false,
        };
        if legacy {
            response.sessions = sessions;
            response.exits = exits;
            response.next_session_offset = response.sessions.len() as u32;
            response.next_exit_offset = response.exits.len() as u32;
            response.complete = true;
        } else {
            let page_bytes = (request.max_page_bytes as usize)
                .clamp(CATALOG_PAGE_MIN_BYTES, CATALOG_PAGE_MAX_BYTES);
            let fits = |catalog: &DeviceSessionCatalog| {
                encode_device_envelope(&DeviceEnvelope {
                    protocol_version: DEVICE_PROTOCOL_VERSION,
                    channel_id: channel_id.to_string(),
                    payload: Some(device_envelope::Payload::SessionCatalog(catalog.clone())),
                })
                .len()
                    <= page_bytes
            };
            let mut entry_count = 0;
            let mut session_index = request.session_offset as usize;
            while session_index < sessions.len() && entry_count < CATALOG_PAGE_MAX_ENTRIES {
                response.sessions.push(sessions[session_index].clone());
                response.next_session_offset = (session_index + 1) as u32;
                if !fits(&response) {
                    response.sessions.pop();
                    response.next_session_offset = session_index as u32;
                    if entry_count == 0 {
                        self.send_device_error(
                            channel_id,
                            Some(request.request_id),
                            "catalog_entry_too_large",
                            "单条 session catalog 记录超过分页上限",
                        );
                        return;
                    }
                    break;
                }
                session_index += 1;
                entry_count += 1;
            }
            if session_index == sessions.len() {
                let mut exit_index = request.exit_offset as usize;
                while exit_index < exits.len() && entry_count < CATALOG_PAGE_MAX_ENTRIES {
                    response.exits.push(exits[exit_index].clone());
                    response.next_exit_offset = (exit_index + 1) as u32;
                    if !fits(&response) {
                        response.exits.pop();
                        response.next_exit_offset = exit_index as u32;
                        if entry_count == 0 {
                            self.send_device_error(
                                channel_id,
                                Some(request.request_id),
                                "catalog_entry_too_large",
                                "单条 exit tombstone 超过分页上限",
                            );
                            return;
                        }
                        break;
                    }
                    exit_index += 1;
                    entry_count += 1;
                }
            }
            response.complete = response.next_session_offset as usize == sessions.len()
                && response.next_exit_offset as usize == exits.len();
        }

        let complete = response.complete;
        let sent = self.send_device(
            channel_id,
            device_envelope::Payload::SessionCatalog(response),
        );
        if sent && complete {
            let mut leases = self.catalog_leases.lock().unwrap();
            if !leases.contains_key(&request.request_id) && leases.len() >= CATALOG_LEASE_LIMIT {
                leases.pop_first();
            }
            leases.insert(
                request.request_id,
                CatalogLease {
                    snapshot_owner_id: self.snapshot_owner_id.clone(),
                    snapshot_epoch,
                },
            );
        }
    }

    fn device_exit_ack(&self, request: DeviceExitAck) {
        if request.event_ids.is_empty() {
            return;
        }
        let bound = !request.request_id.is_empty()
            || !request.snapshot_owner_id.is_empty()
            || request.snapshot_epoch != 0;
        if bound {
            let mut leases = self.catalog_leases.lock().unwrap();
            let matches = leases.get(&request.request_id).is_some_and(|lease| {
                lease.snapshot_owner_id == request.snapshot_owner_id
                    && lease.snapshot_epoch == request.snapshot_epoch
            });
            if !matches {
                return;
            }
            leases.remove(&request.request_id);
        }
        let event_ids: HashSet<&str> = request.event_ids.iter().map(String::as_str).collect();
        let mut tombstones = self.tombstones.lock().unwrap();
        if tombstones.acknowledge(&event_ids) {
            self.bump_snapshot_epoch();
        }
    }

    fn device_attach(&self, channel_id: &str, request: DeviceSessionAttach) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                "session_not_found",
                "session 不存在或已退出",
            );
        };
        let mut locked = session.lock().unwrap();
        let cols = clamp_dim(request.cols, locked.state.cols());
        let rows = clamp_dim(request.rows, locked.state.rows());
        if let Err(error) = locked.state.validate_attach(
            channel_id,
            &request.client_instance_id,
            request.transport_generation,
        ) {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                error.code,
                error.message,
            );
        }
        if let Err(error) = self.resize_locked(&mut locked, rows, cols) {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                "pty_resize_failed",
                error,
            );
        }
        let outcome = match locked.state.attach(
            channel_id,
            &request.client_instance_id,
            request.transport_generation,
            request.resume_from_seq,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                return self.send_device_error(
                    channel_id,
                    Some(request.request_id),
                    error.code,
                    error.message,
                )
            }
        };

        if let Some(detached) = outcome.detached {
            self.send_device(
                &detached.channel_id,
                device_envelope::Payload::SessionDetached(
                    coflux_protocol::wire::DeviceSessionDetached {
                        session_id: request.session_id.clone(),
                        holder_epoch: detached.holder_epoch,
                        reason: Some("holder_taken_over".into()),
                    },
                ),
            );
        }
        let attached_sent = self.send_device(
            channel_id,
            device_envelope::Payload::SessionAttached(DeviceSessionAttached {
                request_id: request.request_id,
                session_id: request.session_id.clone(),
                holder_epoch: outcome.holder_epoch,
                snapshot_seq: outcome.snapshot_seq,
                ansi_snapshot: outcome.ansi_snapshot,
                cols: u32::from(cols),
                rows: u32::from(rows),
            }),
        );
        if !attached_sent {
            // 首帧未进入 bounded worker queue 时，client 尚不知道 snapshot/epoch；不允许后续
            // replay 越过它。保留 logical holder，移除 subscription，等待同一 attach 重试。
            locked.state.remove_subscriber(channel_id);
            return;
        }
        for delta in outcome.replay {
            let to_seq = delta.to_seq;
            let sent = self.send_device(
                channel_id,
                device_envelope::Payload::PtyOutput(DevicePtyOutput {
                    session_id: request.session_id.clone(),
                    from_seq: delta.from_seq,
                    to_seq,
                    data: delta.data,
                }),
            );
            locked.state.delivery_result(channel_id, to_seq, sent);
            if !sent {
                break;
            }
        }
        self.deliver_pending_gaps(&request.session_id, &mut locked.state);
    }

    fn device_snapshot(&self, channel_id: &str, request: DeviceSessionSnapshotRequest) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                "session_not_found",
                "session 不存在或已退出",
            );
        };
        let locked = session.lock().unwrap();
        self.send_device(
            channel_id,
            device_envelope::Payload::SessionSnapshot(DeviceSessionSnapshot {
                request_id: request.request_id,
                session_id: request.session_id,
                snapshot_seq: locked.state.output_seq(),
                ansi_snapshot: locked.state.snapshot(),
                cols: u32::from(locked.state.cols()),
                rows: u32::from(locked.state.rows()),
                title: locked.state.title().to_string(),
            }),
        );
    }

    fn device_input(&self, channel_id: &str, request: DevicePtyInput) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                "session_not_found",
                "session 不存在或已退出",
            );
        };
        if request.data.len() > PTY_INPUT_QUEUE_BYTES {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                "pty_input_backpressure",
                format!("单条 PTY input 超过队列字节上限 {PTY_INPUT_QUEUE_BYTES}"),
            );
        }
        let request_id = request.request_id;
        let session_id = request.session_id;
        let mut locked = session.lock().unwrap();
        let result = match locked.state.admit_input(
            channel_id,
            &request_id,
            request.holder_epoch,
            request.input_seq,
            request.data.clone(),
        ) {
            Ok(InputAdmission::Duplicate {
                applied_through_seq,
            }) => Ok(Some(DevicePtyInputAck {
                session_id: session_id.clone(),
                applied_through_seq,
            })),
            Ok(InputAdmission::Pending) => Ok(None),
            Ok(InputAdmission::Enqueue { client_instance_id }) => {
                let queued = QueuedInput {
                    client_instance_id: client_instance_id.clone(),
                    input_seq: request.input_seq,
                    data: request.data,
                };
                match locked.input.try_send(queued) {
                    Ok(()) => Ok(None),
                    Err(queue_error) => {
                        if !locked
                            .state
                            .cancel_input_reservation(&client_instance_id, request.input_seq)
                        {
                            eprintln!(
                                "[supervisor] input reservation 回滚失败 session={session_id} seq={}",
                                request.input_seq
                            );
                        }
                        let error = match queue_error {
                            InputQueueError::Full => ControlError {
                                code: "pty_input_backpressure",
                                message: format!(
                                    "PTY input queue 已满（最多 {PTY_INPUT_QUEUE_RECORDS} 条/{PTY_INPUT_QUEUE_BYTES} 字节），请重试"
                                ),
                            },
                            InputQueueError::Disconnected => ControlError {
                                code: "pty_input_unavailable",
                                message: "PTY input writer 已停止".into(),
                            },
                        };
                        Err(error)
                    }
                }
            }
            Err(error) => Err(error),
        };
        drop(locked);
        match result {
            Ok(Some(ack)) => {
                self.send_device(channel_id, device_envelope::Payload::PtyInputAck(ack));
            }
            Ok(None) => {}
            Err(error) => {
                self.send_device_error(channel_id, Some(request_id), error.code, error.message)
            }
        }
    }

    fn device_resize(&self, channel_id: &str, request: DevicePtyResize) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                "session_not_found",
                "session 不存在或已退出",
            );
        };
        let mut locked = session.lock().unwrap();
        let cols = clamp_dim(request.cols, locked.state.cols());
        let rows = clamp_dim(request.rows, locked.state.rows());
        match locked.state.resize_decision(
            channel_id,
            request.holder_epoch,
            request.resize_seq,
            rows,
            cols,
        ) {
            Ok(SequencedDecision::Duplicate) => {}
            Ok(SequencedDecision::Apply) => {
                if let Err(error) = self.resize_locked(&mut locked, rows, cols) {
                    return self.send_device_error(
                        channel_id,
                        Some(request.request_id),
                        "pty_resize_failed",
                        error,
                    );
                }
                if let Err(error) = locked.state.commit_resize(
                    channel_id,
                    request.holder_epoch,
                    request.resize_seq,
                    rows,
                    cols,
                ) {
                    self.send_device_error(
                        channel_id,
                        Some(request.request_id),
                        error.code,
                        error.message,
                    );
                }
            }
            Err(error) => self.send_device_error(
                channel_id,
                Some(request.request_id),
                error.code,
                error.message,
            ),
        }
    }

    fn device_stop(&self, channel_id: &str, request: DeviceSessionStop) {
        let operation = OperationRequest::Stop(canonical_stop_request(&request));
        let mut ledger = self.operations.lock().unwrap();
        match ledger.cached(&request.operation_id, &operation) {
            Ok(Some(mut ack)) => {
                ack.request_id = request.request_id.clone();
                self.send_device(channel_id, device_envelope::Payload::OperationAck(ack));
                return;
            }
            Err(()) => {
                return self.send_device_error(
                    channel_id,
                    Some(request.request_id),
                    "operation_collision",
                    "相同 operationId 携带了不同 stop payload",
                );
            }
            Ok(None) => {}
        }

        let ack = match self.get(&request.session_id) {
            None => DeviceOperationAck {
                request_id: request.request_id.clone(),
                operation_id: request.operation_id.clone(),
                ok: false,
                error: Some("session 不存在或已退出".into()),
                session_id: Some(request.session_id.clone()),
                pid: None,
            },
            Some(session) => {
                let mut locked = session.lock().unwrap();
                match locked
                    .state
                    .authorize_holder(channel_id, request.holder_epoch)
                {
                    Err(error) => {
                        drop(ledger);
                        return self.send_device_error(
                            channel_id,
                            Some(request.request_id),
                            error.code,
                            error.message,
                        );
                    }
                    Ok(()) => match locked.child.kill() {
                        Ok(()) => DeviceOperationAck {
                            request_id: request.request_id.clone(),
                            operation_id: request.operation_id.clone(),
                            ok: true,
                            error: None,
                            session_id: Some(request.session_id.clone()),
                            pid: Some(locked.pid),
                        },
                        Err(error) => DeviceOperationAck {
                            request_id: request.request_id.clone(),
                            operation_id: request.operation_id.clone(),
                            ok: false,
                            error: Some(error.to_string()),
                            session_id: Some(request.session_id.clone()),
                            pid: Some(locked.pid),
                        },
                    },
                }
            }
        };
        ledger.remember(request.operation_id.clone(), operation, ack.clone());
        self.send_device(channel_id, device_envelope::Payload::OperationAck(ack));
    }

    fn device_create(self: &Arc<Self>, channel_id: &str, request: DeviceSessionCreate) {
        let operation = OperationRequest::Create(canonical_create_request(&request));
        let mut ledger = self.operations.lock().unwrap();
        match ledger.cached(&request.operation_id, &operation) {
            Ok(Some(mut ack)) => {
                ack.request_id = request.request_id.clone();
                self.send_device(channel_id, device_envelope::Payload::OperationAck(ack));
                return;
            }
            Err(()) => {
                return self.send_device_error(
                    channel_id,
                    Some(request.request_id),
                    "operation_collision",
                    "相同 operationId 携带了不同 create payload",
                );
            }
            Ok(None) => {}
        }

        let cols = clamp_dim(request.cols, 80);
        let rows = clamp_dim(request.rows, 24);
        let created = self.create_session(
            request.session_id.clone(),
            request.task_id.clone(),
            request.cwd.clone(),
            request.shell.clone().unwrap_or_default(),
            cols,
            rows,
            SessionContext {
                daemon_id: request.daemon_id.clone(),
                project_id: request.project_id.clone(),
                workspace_id: request.workspace_id.clone(),
                mcp_url: request.mcp_url.clone(),
            },
        );
        let ack = match created {
            Ok(pid) => DeviceOperationAck {
                request_id: request.request_id.clone(),
                operation_id: request.operation_id.clone(),
                ok: true,
                error: None,
                session_id: Some(request.session_id.clone()),
                pid: Some(pid),
            },
            Err(error) => DeviceOperationAck {
                request_id: request.request_id.clone(),
                operation_id: request.operation_id.clone(),
                ok: false,
                error: Some(error),
                session_id: Some(request.session_id.clone()),
                pid: None,
            },
        };
        ledger.remember(request.operation_id.clone(), operation, ack.clone());
        self.send_device(channel_id, device_envelope::Payload::OperationAck(ack));
    }

    pub fn worker_connected(self: &Arc<Self>, generation: u64, stream: UnixStream) {
        self.outbound.clear();
        let sessions: Vec<SessionHandle> = self.map.lock().unwrap().values().cloned().collect();
        for session in sessions {
            session.lock().unwrap().state.clear_subscribers();
        }
        self.outbound.connect(generation, stream);
    }

    pub fn worker_disconnected(&self, generation: u64) {
        self.outbound.disconnect(generation);
    }

    pub fn shutdown(&self) {
        let sessions: Vec<SessionHandle> = self.map.lock().unwrap().values().cloned().collect();
        for session in sessions {
            let _ = session.lock().unwrap().child.kill();
        }
    }
}

fn clamp_dim(value: u32, fallback: u16) -> u16 {
    if value == 0 {
        return fallback;
    }
    value.clamp(
        u32::from(MIN_TERMINAL_DIMENSION),
        u32::from(MAX_TERMINAL_DIMENSION),
    ) as u16
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

fn request_id_of(payload: &device_envelope::Payload) -> Option<String> {
    match payload {
        device_envelope::Payload::PtyInput(value) => Some(value.request_id.clone()),
        device_envelope::Payload::PtyResize(value) => Some(value.request_id.clone()),
        device_envelope::Payload::SessionStop(value) => Some(value.request_id.clone()),
        device_envelope::Payload::SessionCreate(value) => Some(value.request_id.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit_tombstone(index: usize, padding: usize) -> DeviceSessionExitTombstone {
        DeviceSessionExitTombstone {
            event_id: format!("exit-{index:05}"),
            session_id: format!("session-{index:05}"),
            task_id: format!("task-{index:05}-{}", "x".repeat(padding)),
            exit_code: index as i32,
            final_output_seq: index as u64,
            exited_at: index as f64,
        }
    }

    fn receive_catalog(receiver: &Receiver<Vec<u8>>) -> (usize, DeviceSessionCatalog) {
        let record = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("sessiond 应发送 catalog 页");
        assert!(record.len() >= 4);
        let declared = u32::from_be_bytes(record[..4].try_into().unwrap()) as usize;
        assert_eq!(declared, record.len() - 4);
        let DataFrame::Device { channel_id, data } =
            coflux_protocol::decode_frame(&record[4..]).expect("catalog 应使用 Device frame")
        else {
            panic!("catalog 应使用 Device frame");
        };
        assert_eq!(channel_id, "__test-catalog");
        let encoded_bytes = data.len();
        let envelope = decode_device_envelope(&data).expect("catalog envelope 应可解码");
        let Some(device_envelope::Payload::SessionCatalog(catalog)) = envelope.payload else {
            panic!("应收到 session catalog payload");
        };
        (encoded_bytes, catalog)
    }

    fn receive_control(receiver: &Receiver<Vec<u8>>) -> SupervisorToWorker {
        let record = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("supervisor 应发送 lifecycle control");
        assert!(record.len() >= 4);
        let declared = u32::from_be_bytes(record[..4].try_into().unwrap()) as usize;
        assert_eq!(declared, record.len() - 4);
        serde_json::from_slice(&record[4..]).expect("lifecycle control 应是合法 JSON")
    }

    struct PartialThenFailWriter {
        bytes: Vec<u8>,
        calls: usize,
    }

    impl Write for PartialThenFailWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.calls += 1;
            if self.calls == 1 {
                let length = buf.len().min(2);
                self.bytes.extend_from_slice(&buf[..length]);
                Ok(length)
            } else {
                Err(std::io::Error::other(
                    "injected failure after partial write",
                ))
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn stop_request(request_id: &str, session_id: &str) -> DeviceSessionStop {
        DeviceSessionStop {
            request_id: request_id.into(),
            operation_id: "operation-stop".into(),
            session_id: session_id.into(),
            holder_epoch: 7,
        }
    }

    #[test]
    fn sessiond_holder_operation_ledger_replays_same_result_and_rejects_collision() {
        let request = OperationRequest::Stop(canonical_stop_request(&stop_request(
            "request-1",
            "session-1",
        )));
        let ack = DeviceOperationAck {
            request_id: "request-1".into(),
            operation_id: "operation-stop".into(),
            ok: true,
            error: None,
            session_id: Some("session-1".into()),
            pid: Some(42),
        };
        let mut ledger = OperationLedger::default();
        ledger.remember("operation-stop".into(), request.clone(), ack.clone());
        assert_eq!(
            ledger.cached("operation-stop", &request).unwrap(),
            Some(ack.clone())
        );

        let retry = OperationRequest::Stop(canonical_stop_request(&stop_request(
            "request-2",
            "session-1",
        )));
        assert_eq!(ledger.cached("operation-stop", &retry).unwrap(), Some(ack));

        let collision = OperationRequest::Stop(canonical_stop_request(&stop_request(
            "request-2",
            "session-2",
        )));
        assert!(ledger.cached("operation-stop", &collision).is_err());
    }

    #[test]
    fn sessiond_operation_ledger_enforces_entry_and_owned_byte_limits() {
        fn record(
            operation_id: &str,
            session_id: &str,
            error_padding: usize,
        ) -> (OperationRequest, DeviceOperationAck) {
            let mut request = stop_request("request", session_id);
            request.operation_id = operation_id.into();
            let request = OperationRequest::Stop(canonical_stop_request(&request));
            let ack = DeviceOperationAck {
                request_id: "request".into(),
                operation_id: operation_id.into(),
                ok: error_padding == 0,
                error: (error_padding > 0).then(|| "x".repeat(error_padding)),
                session_id: Some(session_id.into()),
                pid: Some(42),
            };
            (request, ack)
        }

        let (first_request, first_ack) = record("operation-first", "session-first", 64);
        let (second_request, second_ack) = record("operation-second", "session-second", 96);
        let first_weight =
            OperationLedger::weight(&"operation-first".to_string(), &first_request, &first_ack);
        let second_weight = OperationLedger::weight(
            &"operation-second".to_string(),
            &second_request,
            &second_ack,
        );

        let mut ledger = OperationLedger::default();
        ledger.remember_with_limits(
            "operation-first".into(),
            first_request.clone(),
            first_ack,
            8,
            first_weight + second_weight - 1,
        );
        ledger.remember_with_limits(
            "operation-second".into(),
            second_request.clone(),
            second_ack,
            8,
            first_weight + second_weight - 1,
        );
        assert!(ledger
            .cached("operation-first", &first_request)
            .unwrap()
            .is_none());
        assert!(ledger
            .cached("operation-second", &second_request)
            .unwrap()
            .is_some());
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.bytes, second_weight);

        let (third_request, third_ack) = record("operation-third", "session-third", 0);
        ledger.remember_with_limits(
            "operation-third".into(),
            third_request.clone(),
            third_ack,
            1,
            usize::MAX,
        );
        assert_eq!(ledger.entries.len(), 1, "条数上限仍需独立生效");
        assert!(ledger
            .cached("operation-second", &second_request)
            .unwrap()
            .is_none());
        assert!(ledger
            .cached("operation-third", &third_request)
            .unwrap()
            .is_some());
    }

    #[test]
    fn sessiond_operation_ledger_drops_single_record_over_byte_budget() {
        let mut request = stop_request("request", "session");
        request.operation_id = "operation-oversized".into();
        let request = OperationRequest::Stop(canonical_stop_request(&request));
        let ack = DeviceOperationAck {
            request_id: "request".into(),
            operation_id: "operation-oversized".into(),
            ok: false,
            error: Some("x".repeat(512)),
            session_id: Some("session".into()),
            pid: None,
        };
        let operation_id = "operation-oversized".to_string();
        let weight = OperationLedger::weight(&operation_id, &request, &ack);
        let mut ledger = OperationLedger::default();
        ledger.remember_with_limits(operation_id, request, ack, 8, weight - 1);
        assert!(ledger.entries.is_empty());
        assert!(ledger.order.is_empty());
        assert_eq!(ledger.bytes, 0);
    }

    #[test]
    fn sessiond_input_ack_advances_only_after_full_write() {
        let mut state = SessionState::new(3, 12, 4);
        let epoch = state
            .attach("channel-a", "client-a", 1, None)
            .unwrap()
            .holder_epoch;
        let mut writer = Vec::new();

        let admitted = state
            .admit_input("channel-a", "request-1", epoch, 1, b"one".to_vec())
            .unwrap();
        assert_eq!(
            admitted,
            InputAdmission::Enqueue {
                client_instance_id: "client-a".into()
            }
        );
        assert_eq!(
            state.input_applied_through("channel-a", epoch).unwrap(),
            0,
            "reservation 不能提前成为 ACK"
        );
        write_pty_input(&mut writer, b"one").unwrap();
        let first = state.complete_input("client-a", 1).unwrap();
        assert_eq!(first.applied_through_seq, 1);
        assert_eq!(writer, b"one");

        assert_eq!(
            state
                .admit_input("channel-a", "request-1-retry", epoch, 1, b"one".to_vec())
                .unwrap(),
            InputAdmission::Duplicate {
                applied_through_seq: 1
            }
        );
        assert_eq!(
            writer, b"one",
            "committed duplicate must not reach the PTY writer"
        );
    }

    #[test]
    fn sessiond_partial_write_is_fatal_and_never_replays_written_prefix() {
        let mut state = SessionState::new(3, 12, 4);
        let epoch = state
            .attach("channel-a", "client-a", 1, None)
            .unwrap()
            .holder_epoch;
        assert!(matches!(
            state
                .admit_input("channel-a", "request-1", epoch, 1, b"three".to_vec())
                .unwrap(),
            InputAdmission::Enqueue { .. }
        ));

        let mut writer = PartialThenFailWriter {
            bytes: Vec::new(),
            calls: 0,
        };
        let failure = write_pty_input(&mut writer, b"three").unwrap_err();
        assert_eq!(failure.written, 2);
        assert_eq!(writer.bytes, b"th");
        let target = state
            .fail_input(
                "client-a",
                1,
                "pty_write_partial",
                format!("partial: {}", failure.error),
            )
            .unwrap();
        assert_eq!(target.channel_id, "channel-a");
        assert_eq!(target.request_id, "request-1");
        assert_eq!(
            state.input_applied_through("channel-a", epoch).unwrap(),
            0,
            "partial write 不能伪造完整 ACK"
        );

        let retry = state
            .admit_input("channel-a", "request-1-retry", epoch, 1, b"three".to_vec())
            .unwrap_err();
        assert_eq!(retry.code, "pty_write_partial");
        assert_eq!(
            writer.bytes, b"th",
            "fatal reservation 不得从 byte 0 重投已经写过的前缀"
        );
    }

    #[test]
    fn sessiond_input_queue_is_record_and_byte_bounded() {
        let (queue, _receiver) = InputQueue::with_limits(2, 3);
        assert!(queue
            .try_send(QueuedInput {
                client_instance_id: "client".into(),
                input_seq: 1,
                data: vec![1, 2]
            })
            .is_ok());
        assert_eq!(
            queue.try_send(QueuedInput {
                client_instance_id: "client".into(),
                input_seq: 2,
                data: vec![3, 4]
            }),
            Err(InputQueueError::Full),
            "byte-full queue 必须非阻塞拒绝"
        );
        assert!(queue
            .try_send(QueuedInput {
                client_instance_id: "client".into(),
                input_seq: 2,
                data: vec![3]
            })
            .is_ok());
        assert_eq!(
            queue.try_send(QueuedInput {
                client_instance_id: "client".into(),
                input_seq: 3,
                data: Vec::new()
            }),
            Err(InputQueueError::Full),
            "record-full queue 即使零字节也必须非阻塞拒绝"
        );
    }

    #[test]
    fn legacy_duplicate_create_is_identity_aware() {
        match legacy_create_response(
            "session-1",
            "task-1",
            Some(("task-1".into(), 42)),
            "duplicate session id",
        ) {
            SupervisorToWorker::SessionStarted {
                session_id,
                task_id,
                pid,
            } => {
                assert_eq!(session_id, "session-1");
                assert_eq!(task_id, "task-1");
                assert_eq!(pid, 42);
            }
            _ => panic!("同 task 的重复 create 必须幂等重放 SessionStarted"),
        }

        match legacy_create_response(
            "session-1",
            "task-new",
            Some(("task-live".into(), 42)),
            "duplicate session id",
        ) {
            SupervisorToWorker::SessionCreateFailed {
                session_id,
                task_id,
                error,
            } => {
                assert_eq!(session_id, "session-1");
                assert_eq!(task_id, "task-new");
                assert!(error.contains("task-live"));
            }
            _ => panic!("不同 task 的 ID 冲突绝不能伪装成 SessionExit"),
        }

        match legacy_create_response("session-2", "task-2", None, "spawn failed") {
            SupervisorToWorker::SessionExit {
                session_id,
                exit_code,
                task_id,
                pid,
            } => {
                assert_eq!(session_id, "session-2");
                assert_eq!(exit_code, -1);
                assert_eq!(task_id.as_deref(), Some("task-2"));
                assert_eq!(pid, None);
            }
            _ => panic!("没有同 ID 活会话的普通失败应保留 legacy SessionExit"),
        }
    }

    #[test]
    fn duplicate_create回执与自然退出按session到map锁序线性化() {
        let outbound = Outbound::with_limits(32, usize::MAX);
        let (sender, receiver) = sync_channel(32);
        outbound.connect_sender(1, sender);
        let sessions = Sessions::new(Arc::clone(&outbound), "/bin/cat".into(), "/tmp".into(), 0);

        // duplicate 先赢：Started 在仍持有 session→map 两把锁时入队，exit 只能随后摘 map。
        let first_pid = sessions
            .create_session(
                "duplicate-first".into(),
                "task-first".into(),
                "/tmp".into(),
                String::new(),
                80,
                24,
                SessionContext::default(),
            )
            .unwrap();
        assert!(matches!(
            receive_control(&receiver),
            SupervisorToWorker::SessionStarted { ref session_id, pid, .. }
                if session_id == "duplicate-first" && pid == first_pid
        ));
        let first = sessions.get("duplicate-first").unwrap();
        assert!(sessions.respond_to_current_legacy_create_attempt(
            "duplicate-first",
            "task-first",
            &first,
            "duplicate session id",
        ));
        assert!(matches!(
            receive_control(&receiver),
            SupervisorToWorker::SessionStarted { ref session_id, pid, .. }
                if session_id == "duplicate-first" && pid == first_pid
        ));
        let (first_task, first_pid) = {
            let mut locked = first.lock().unwrap();
            let mut map = sessions.map.lock().unwrap();
            let removed = map.remove("duplicate-first").unwrap();
            assert!(Arc::ptr_eq(&removed, &first));
            let identity = (locked.task_id.clone(), locked.pid);
            let _ = locked.child.kill();
            identity
        };
        assert!(sessions.send_ctrl_or_disconnect(
            &SupervisorToWorker::SessionExit {
                session_id: "duplicate-first".into(),
                exit_code: 0,
                task_id: Some(first_task),
                pid: Some(first_pid),
            },
            "test duplicate-first exit",
        ));
        assert!(matches!(
            receive_control(&receiver),
            SupervisorToWorker::SessionExit { ref session_id, pid: Some(pid), .. }
                if session_id == "duplicate-first" && pid == first_pid
        ));

        // exit 先赢：主线程持有 session 锁，先从 map 摘 incarnation 并排入 Exit；
        // 被卡住的 duplicate 醒来后必须看到 candidate 已非 current，不能补发 stale Started。
        let second_pid = sessions
            .create_session(
                "exit-first".into(),
                "task-second".into(),
                "/tmp".into(),
                String::new(),
                80,
                24,
                SessionContext::default(),
            )
            .unwrap();
        assert!(matches!(
            receive_control(&receiver),
            SupervisorToWorker::SessionStarted { ref session_id, pid, .. }
                if session_id == "exit-first" && pid == second_pid
        ));
        let second = sessions.get("exit-first").unwrap();
        let mut locked = second.lock().unwrap();
        let responder_sessions = Arc::clone(&sessions);
        let responder_candidate = Arc::clone(&second);
        let responder = thread::spawn(move || {
            responder_sessions.respond_to_current_legacy_create_attempt(
                "exit-first",
                "task-second",
                &responder_candidate,
                "duplicate session id",
            )
        });
        {
            let mut map = sessions.map.lock().unwrap();
            let removed = map.remove("exit-first").unwrap();
            assert!(Arc::ptr_eq(&removed, &second));
        }
        let second_task = locked.task_id.clone();
        let _ = locked.child.kill();
        assert!(sessions.send_ctrl_or_disconnect(
            &SupervisorToWorker::SessionExit {
                session_id: "exit-first".into(),
                exit_code: 0,
                task_id: Some(second_task),
                pid: Some(second_pid),
            },
            "test exit-first exit",
        ));
        drop(locked);
        assert!(!responder.join().unwrap());
        assert!(matches!(
            receive_control(&receiver),
            SupervisorToWorker::SessionExit { ref session_id, pid: Some(pid), .. }
                if session_id == "exit-first" && pid == second_pid
        ));
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "Exit 之后不能出现 stale SessionStarted"
        );
    }

    #[test]
    fn lifecycle_control_backpressure_disconnects_worker_for_resync() {
        let outbound = Outbound::with_limits(1, usize::MAX);
        let (sender, _receiver) = sync_channel(1);
        outbound.connect_sender(1, sender);
        assert!(outbound.try_send(vec![1]), "先填满 control record 队列");
        let sessions = Sessions::new(Arc::clone(&outbound), "/bin/sh".into(), "/tmp".into(), 0);

        assert!(!sessions.send_ctrl_or_disconnect(
            &SupervisorToWorker::SessionExit {
                session_id: "session-1".into(),
                exit_code: 0,
                task_id: Some("task-1".into()),
                pid: Some(42),
            },
            "test session.exit",
        ));
        assert!(
            outbound.current.lock().unwrap().is_none(),
            "未入队的自然退出必须切断旧 worker，不能稳定连接下永久丢失"
        );

        let (replacement_sender, replacement_receiver) = sync_channel(1);
        outbound.connect_sender(2, replacement_sender);
        assert!(outbound.try_send(vec![2]));
        assert_eq!(replacement_receiver.try_recv().unwrap(), vec![2]);
    }

    #[test]
    fn sessiond_backpressure_outbound_is_bounded_and_generation_safe() {
        let outbound = Outbound::with_limits(2, 2);
        let (first_sender, _first_receiver) = sync_channel(2);
        outbound.connect_sender(1, first_sender);
        assert!(outbound.try_send(vec![1, 2]));
        assert!(
            !outbound.try_send(vec![3]),
            "byte-full queue must reject instead of blocking the PTY reader"
        );

        let (second_sender, second_receiver) = sync_channel(1);
        outbound.connect_sender(2, second_sender);
        outbound.disconnect(1);
        assert!(
            outbound.try_send(vec![3]),
            "old writer teardown must not clear the replacement connection"
        );
        assert_eq!(second_receiver.try_recv().unwrap(), vec![3]);
    }

    #[test]
    fn sessiond_backpressure_exit_tombstones_survive_until_ack() {
        let sessions = Sessions::new(Outbound::new(), "/bin/sh".into(), "/tmp".into(), 0);
        for tombstone in [
            DeviceSessionExitTombstone {
                event_id: "exit-1".into(),
                session_id: "session-1".into(),
                task_id: "task-1".into(),
                exit_code: 0,
                final_output_seq: 10,
                exited_at: 1.0,
            },
            DeviceSessionExitTombstone {
                event_id: "exit-2".into(),
                session_id: "session-2".into(),
                task_id: "task-2".into(),
                exit_code: 1,
                final_output_seq: 20,
                exited_at: 2.0,
            },
        ] {
            sessions.tombstones.lock().unwrap().push(tombstone);
        }

        sessions.device_exit_ack(DeviceExitAck {
            event_ids: Vec::new(),
            ..Default::default()
        });
        assert_eq!(sessions.tombstones.lock().unwrap().entries.len(), 2);
        sessions.device_exit_ack(DeviceExitAck {
            event_ids: vec!["exit-1".into()],
            ..Default::default()
        });
        let tombstones = sessions.tombstones.lock().unwrap();
        assert_eq!(tombstones.entries.len(), 1);
        assert_eq!(tombstones.entries[0].event_id, "exit-2");
    }

    #[test]
    fn sessiond_catalog_pages_stay_bounded_and_form_one_complete_snapshot() {
        let outbound = Outbound::new();
        let (sender, receiver) = sync_channel(8);
        outbound.connect_sender(1, sender);
        let sessions = Sessions::new(outbound, "/bin/sh".into(), "/tmp".into(), 0);
        let total = CATALOG_PAGE_MAX_ENTRIES * 2 + 7;
        for index in 0..total {
            sessions
                .tombstones
                .lock()
                .unwrap()
                .push(exit_tombstone(index, 0));
        }

        let mut request = DeviceSessionCatalogRequest {
            request_id: "catalog-pages".into(),
            max_page_bytes: CATALOG_PAGE_MIN_BYTES as u32,
            ..Default::default()
        };
        let mut event_ids = Vec::new();
        let mut page_count = 0;
        loop {
            sessions.device_catalog("__test-catalog", request.clone());
            let (encoded_bytes, page) = receive_catalog(&receiver);
            assert!(encoded_bytes <= request.max_page_bytes as usize);
            assert_eq!(page.request_id, request.request_id);
            assert_eq!(page.snapshot_owner_id, sessions.snapshot_owner_id);
            assert_eq!(page.snapshot_epoch, 1);
            assert_eq!(page.session_offset, request.session_offset);
            assert_eq!(page.exit_offset, request.exit_offset);
            assert!(!page.reset);
            event_ids.extend(page.exits.iter().map(|event| event.event_id.clone()));
            page_count += 1;
            if page.complete {
                assert_eq!(page.next_exit_offset as usize, total);
                break;
            }
            assert_eq!(page.exits.len(), CATALOG_PAGE_MAX_ENTRIES);
            request.snapshot_owner_id = page.snapshot_owner_id;
            request.snapshot_epoch = page.snapshot_epoch;
            request.session_offset = page.next_session_offset;
            request.exit_offset = page.next_exit_offset;
        }

        assert_eq!(page_count, 3);
        assert_eq!(event_ids.len(), total);
        assert_eq!(event_ids.first().map(String::as_str), Some("exit-00000"));
        assert_eq!(event_ids.last().map(String::as_str), Some("exit-00262"));
        assert!(sessions
            .catalog_leases
            .lock()
            .unwrap()
            .contains_key("catalog-pages"));
    }

    #[test]
    fn sessiond_catalog_epoch_change_resets_an_incomplete_page_walk() {
        let outbound = Outbound::new();
        let (sender, receiver) = sync_channel(4);
        outbound.connect_sender(1, sender);
        let sessions = Sessions::new(outbound, "/bin/sh".into(), "/tmp".into(), 0);
        for index in 0..(CATALOG_PAGE_MAX_ENTRIES + 1) {
            sessions
                .tombstones
                .lock()
                .unwrap()
                .push(exit_tombstone(index, 0));
        }

        sessions.device_catalog(
            "__test-catalog",
            DeviceSessionCatalogRequest {
                request_id: "catalog-reset".into(),
                max_page_bytes: CATALOG_PAGE_MIN_BYTES as u32,
                ..Default::default()
            },
        );
        let (_, first) = receive_catalog(&receiver);
        assert!(!first.complete);
        assert!(!first.reset);

        sessions
            .tombstones
            .lock()
            .unwrap()
            .push(exit_tombstone(CATALOG_PAGE_MAX_ENTRIES + 1, 0));
        sessions.bump_snapshot_epoch();
        sessions.device_catalog(
            "__test-catalog",
            DeviceSessionCatalogRequest {
                request_id: first.request_id.clone(),
                snapshot_owner_id: first.snapshot_owner_id.clone(),
                snapshot_epoch: first.snapshot_epoch,
                session_offset: first.next_session_offset,
                exit_offset: first.next_exit_offset,
                max_page_bytes: CATALOG_PAGE_MIN_BYTES as u32,
            },
        );
        let (_, reset) = receive_catalog(&receiver);
        assert!(reset.reset);
        assert!(!reset.complete);
        assert!(reset.sessions.is_empty());
        assert!(reset.exits.is_empty());
        assert_eq!(reset.snapshot_owner_id, first.snapshot_owner_id);
        assert_eq!(reset.snapshot_epoch, first.snapshot_epoch + 1);
        assert_eq!(reset.next_session_offset, 0);
        assert_eq!(reset.next_exit_offset, 0);
        assert!(!sessions
            .catalog_leases
            .lock()
            .unwrap()
            .contains_key("catalog-reset"));
    }

    #[test]
    fn sessiond_exit_ack_requires_the_completed_catalog_identity() {
        let outbound = Outbound::new();
        let (sender, receiver) = sync_channel(4);
        outbound.connect_sender(1, sender);
        let sessions = Sessions::new(outbound, "/bin/sh".into(), "/tmp".into(), 0);
        sessions
            .tombstones
            .lock()
            .unwrap()
            .push(exit_tombstone(1, 0));
        sessions
            .tombstones
            .lock()
            .unwrap()
            .push(exit_tombstone(2, 0));

        sessions.device_catalog(
            "__test-catalog",
            DeviceSessionCatalogRequest {
                request_id: "catalog-ack".into(),
                max_page_bytes: CATALOG_PAGE_MIN_BYTES as u32,
                ..Default::default()
            },
        );
        let (_, catalog) = receive_catalog(&receiver);
        assert!(catalog.complete);
        let event_ids = catalog
            .exits
            .iter()
            .map(|event| event.event_id.clone())
            .collect::<Vec<_>>();

        sessions.device_exit_ack(DeviceExitAck {
            event_ids: event_ids.clone(),
            request_id: "wrong-request".into(),
            snapshot_owner_id: catalog.snapshot_owner_id.clone(),
            snapshot_epoch: catalog.snapshot_epoch,
        });
        assert_eq!(sessions.tombstones.lock().unwrap().entries.len(), 2);
        sessions.device_exit_ack(DeviceExitAck {
            event_ids: event_ids.clone(),
            request_id: catalog.request_id.clone(),
            snapshot_owner_id: catalog.snapshot_owner_id.clone(),
            snapshot_epoch: catalog.snapshot_epoch + 1,
        });
        assert_eq!(sessions.tombstones.lock().unwrap().entries.len(), 2);
        assert!(sessions
            .catalog_leases
            .lock()
            .unwrap()
            .contains_key(&catalog.request_id));

        sessions.device_exit_ack(DeviceExitAck {
            event_ids,
            request_id: catalog.request_id.clone(),
            snapshot_owner_id: catalog.snapshot_owner_id,
            snapshot_epoch: catalog.snapshot_epoch,
        });
        assert!(sessions.tombstones.lock().unwrap().entries.is_empty());
        assert!(!sessions
            .catalog_leases
            .lock()
            .unwrap()
            .contains_key(&catalog.request_id));
        assert_eq!(sessions.snapshot_epoch.load(Ordering::Acquire), 2);
    }

    #[test]
    fn sessiond_exit_tombstones_remain_count_and_byte_bounded() {
        let mut count_bounded = TombstoneStore::default();
        for index in 0..(EXIT_TOMBSTONE_LIMIT + 17) {
            count_bounded.push(exit_tombstone(index, 0));
            assert!(count_bounded.entries.len() <= EXIT_TOMBSTONE_LIMIT);
            assert!(count_bounded.bytes <= EXIT_TOMBSTONE_BYTES);
        }
        assert_eq!(count_bounded.entries.len(), EXIT_TOMBSTONE_LIMIT);
        assert_eq!(
            count_bounded.entries.front().unwrap().event_id,
            "exit-00017"
        );

        let mut byte_bounded = TombstoneStore::default();
        for index in 0..256 {
            byte_bounded.push(exit_tombstone(index, 32 * 1024));
            assert!(byte_bounded.entries.len() <= EXIT_TOMBSTONE_LIMIT);
            assert!(byte_bounded.bytes <= EXIT_TOMBSTONE_BYTES);
            assert_eq!(
                byte_bounded.bytes,
                byte_bounded
                    .entries
                    .iter()
                    .map(TombstoneStore::weight)
                    .sum::<usize>()
            );
        }
        assert!(
            byte_bounded.entries.len() < 256,
            "字节上限应淘汰最旧 tombstone"
        );
        assert_eq!(byte_bounded.entries.back().unwrap().event_id, "exit-00255");
    }
}
