//! PTY 会话生命周期（活在 supervisor）。每个 session 用独立 mutex 串行化 authority、VT、
//! sequence 与 attach；可能阻塞的 PTY stdin 由独立有界 writer 执行，不进入该临界区。
//! worker/中心只是可丢失并重建的 transport。
//!
//! plan 20260918-ptyd-terminal-custody：PTY 本身归 `coflux-ptyd`。supervisor 手里没有任何 PTY
//! 文件描述符——它经 ptyd 协议 open/spawn，按输出字节偏移订阅输出，把输入交给 ptyd 写，resize
//! 交给 ptyd 做 TIOCSWINSZ，并且每产出半个 ring 的输出就把规范 snapshot + 未编码状态打成
//! checkpoint 交给 ptyd 存。supervisor 被替换时走 leave-sessions 退出（shell 不动），新
//! supervisor 启动时 [`Sessions::recover`] 从 ptyd 枚举 session、喂 blob、回放 ring、按偏移套
//! resize 日志，然后才起 worker。

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use coflux_protocol::logln;
use coflux_protocol::ptyd::{PtydResizeEntry, PtydSessionInfo, PTYD_BLOB_CAPACITY, PTYD_MAX_READ_BYTES, PTYD_RING_CAPACITY};
use coflux_protocol::wire::{
    device_envelope, DeviceEnvelope, DeviceError, DeviceExitAck, DeviceOperationAck, DevicePtyGap,
    DevicePtyInput, DevicePtyInputAck, DevicePtyOutput, DevicePtyResize, DeviceSessionAttach,
    DeviceSessionAttached, DeviceSessionCatalog, DeviceSessionCatalogRequest, DeviceSessionCreate,
    DeviceSessionExitTombstone, DeviceSessionExited, DeviceSessionInfo, DeviceSessionSnapshot,
    DeviceSessionSnapshotRequest, DeviceSessionStop, TerminalCommandState,
};
use coflux_protocol::{
    decode_device_envelope, encode_device_envelope, write_record, CommandStateInfo,
    DEVICE_PROTOCOL_VERSION, MAX_DEVICE_FRAME_BYTES, MAX_FRAME_ID_BYTES, MAX_TERMINAL_DIMENSION,
    MIN_TERMINAL_DIMENSION,
};
use coflux_ptyd::{InputChannel, PtydClient, PtydError, SubscriptionEvent};
use rand_core::{OsRng, RngCore};

use crate::sessiond::{Checkpoint, ControlError, InputAdmission, SequencedDecision, SessionState, TerminalState};
use crate::sessiond_ipc::{
    encode_frame, DataFrame, SessionInfo, SessiondEvent, FINAL_SNAPSHOT_REQUEST_ID, INTERNAL_CHANNEL_ID,
};
use crate::shell_integration;

/// 把 `segment` 放到 PATH 首段（plan 112）：原 PATH 为空/缺失时就只有这一段；其余段顺序不变；
/// 原本已含该段（不论在哪个位置）则去重后仍只出现一次、在首位。空段（`::`）照原样保留。
pub fn prepend_path_segment(segment: &str, current: Option<&str>) -> String {
    let mut parts = vec![segment];
    if let Some(rest) = current.filter(|path| !path.is_empty()) {
        parts.extend(rest.split(':').filter(|part| *part != segment));
    }
    parts.join(":")
}

/// supervisor 自身多由 launchd 拉起，环境里既没有 locale 也没有 `COLORTERM`；PTY 里的 shell 于是
/// 落在 `LC_CTYPE="C"`，宽字符/emoji 的列宽判定全错。补的是「空」，不是「错」。
///
/// `C.UTF-8` 而不是 `en_US.UTF-8`：我们要修的只是 charmap，不是 collation/messages/格式化。
/// `C.UTF-8` 把 `LC_COLLATE` 留在与今天逐字相同的字节序上（`en_US.UTF-8` 会改 `ls`/`sort` 的
/// 排序），且在 glibc ≥ 2.35 / musl / macOS 上都内建，不依赖发行版是否生成过某个 locale。
const DEFAULT_LOCALE: &str = "C.UTF-8";
/// locale 判定顺序与 POSIX `setlocale` 一致：`LC_ALL` > `LC_CTYPE` > `LANG`。三者**只要有一个非空**
/// 就整体不注入，父环境的 locale 原样透传——包括用户故意设的 `LANG=C`。「保留父 locale」优先于
/// 「保证 UTF-8」：这里修的是空 locale，不是错 locale。
const LOCALE_ENV_VARS: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];
/// truecolor 能力声明；父环境已有值（如 `24bit`）则透传。
const DEFAULT_COLORTERM: &str = "truecolor";
/// 宿主终端标识。与 `TERM` 同类：它描述的是「这个 tty 由谁提供」，在 coflux 会话里答案只能是
/// coflux，父环境继承下来的 `Apple_Terminal` / `vscode` 是错的，故无条件覆盖。
const TERM_PROGRAM_VALUE: &str = "coflux";

/// PTY 会话 shell 的 locale / 颜色环境（plan 20260916-terminal-cursor-parity M1）。
///
/// 返回的是**覆盖项**：调用方必须在拷贝 `std::env::vars()` **之后**逐条写入，否则被 supervisor
/// 自身环境盖回去（与 `PATH` / `COFLUX_*` 同一条约束）。`lookup` 读的是 supervisor 自身环境，
/// 单测可传入模拟的父环境，把结果当纯值断言。
fn terminal_env_overrides(lookup: impl Fn(&str) -> Option<String>) -> Vec<(&'static str, String)> {
    let non_empty = |key: &str| lookup(key).is_some_and(|value| !value.is_empty());
    let mut overrides = Vec::new();
    if !LOCALE_ENV_VARS.iter().any(|key| non_empty(key)) {
        overrides.push(("LANG", DEFAULT_LOCALE.to_string()));
    }
    if !non_empty("COLORTERM") {
        overrides.push(("COLORTERM", DEFAULT_COLORTERM.to_string()));
    }
    overrides.push(("TERM_PROGRAM", TERM_PROGRAM_VALUE.to_string()));
    overrides
}

/// 把 ptyd 订阅流转成分片队列 + 退出码（plan 20260916-terminal-cursor-parity M2 的读线程形状）。
///
/// 读侧必须独立成一条线程，合帧才可能有**时间**上界：`recv_timeout` 能在窗口耗尽时返回，
/// 阻塞的 socket 读不能。队列满了转发线程就停在 `send` 上，ptyd 那头随之停止读 PTY——与过去
/// 有界 chunk 队列的背压语义完全一致。
fn spawn_subscription_forwarder(
    session_id: String,
    events: Receiver<SubscriptionEvent>,
    expected_offset: u64,
) -> (Receiver<Vec<u8>>, Arc<Mutex<Option<i32>>>) {
    let (sender, receiver) = sync_channel::<Vec<u8>>(PTY_CHUNK_QUEUE_RECORDS);
    let exit: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
    let exit_slot = Arc::clone(&exit);
    thread::spawn(move || {
        let mut next = expected_offset;
        for event in events {
            match event {
                SubscriptionEvent::Output { from_offset, data } => {
                    if from_offset != next {
                        logln!(
                            "[sessiond] ptyd 输出偏移不连续 session={session_id} expected={next} got={from_offset}"
                        );
                    }
                    next = from_offset.saturating_add(data.len() as u64);
                    if sender.send(data).is_err() {
                        break;
                    }
                }
                SubscriptionEvent::Exited { exit_code, .. } => {
                    *exit_slot.lock().unwrap() = Some(exit_code);
                    break;
                }
            }
        }
    });
    (receiver, exit)
}

/// 把 PTY 的连续小读合并成一帧。返回 `None` 表示读侧已经结束（EOF / 读错误）且队列已排空，
/// 调用方转入 session 收尾。
///
/// 两条上界都是硬的：
/// - **时间**——首个分片到手即开始计时，窗口耗尽就交付，绝不为了多攒一点而等下一次读；
/// - **字节**——攒够 `max_bytes` 立刻交付，不等窗口走完。
///
/// 序号连续性由构造保证：每个 batch 原样、按序、一次性喂给 `SessionState::feed`，
/// 而 `feed` 按字节数推进 `output_seq`，于是相邻帧必然 `to_seq + 1 == from_seq`。
/// worker 正是在序号不连续时抬 gap——那恰是本函数要减少的事，不能反过来制造它。
fn coalesce_pty_output(
    chunks: &Receiver<Vec<u8>>,
    window: Duration,
    max_bytes: usize,
) -> Option<Vec<u8>> {
    let mut batch = chunks.recv().ok()?;
    if batch.len() >= max_bytes {
        return Some(batch);
    }
    let deadline = Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match chunks.recv_timeout(remaining) {
            Ok(chunk) => {
                batch.extend_from_slice(&chunk);
                if batch.len() >= max_bytes {
                    break;
                }
            }
            // Timeout = PTY 安静下来；Disconnected = 读侧结束。两者都立刻交付已攒的字节。
            Err(_) => break,
        }
    }
    Some(batch)
}

const OPERATION_LEDGER_LIMIT: usize = 4096;
/// create/stop ledger 除条数外还必须按实际持有的字符串容量计费；典型记录仅数百字节，4 MiB
/// 足以保留远多于正常重试窗口的结果，同时阻止大 cwd/error 等字段把 4096 条放大成无界内存。
const OPERATION_LEDGER_BYTES: usize = 4 * 1024 * 1024;
/// HashMap control bytes、装载率余量与 VecDeque spare capacity 无法由稳定 API 精确取得；除
/// `size_of` 可见的 key/value/String header 外，每条再收一段保守容器余量。
const OPERATION_LEDGER_CONTAINER_SLOP: usize = 64;
/// 每个 session 都持一个 PTY 子进程（在 ptyd 里）、两条 OS thread（订阅转发 + 合帧/投递）与终端历史；实际资源上限必须远低于
/// IPC 理论容量。128 个并发活终端已覆盖正常机群使用，同时把快照大小严格压在 record 上限内。
/// 与 ptyd 的 `PTYD_MAX_LIVE_SESSIONS` 同值。
const MAX_LIVE_SESSIONS: usize = 128;
const WORKER_QUEUE_RECORDS: usize = 512;
const WORKER_QUEUE_BYTES: usize = MAX_DEVICE_FRAME_BYTES + 2 * 1024 * 1024;
/// 与 client retained input 上限一致；两端都必须有界，不能把一个不读 stdin 的 PTY
/// 变成 supervisor 内存增长入口。
const PTY_INPUT_QUEUE_RECORDS: usize = 256;
const PTY_INPUT_QUEUE_BYTES: usize = 1024 * 1024;
/// PTY 输出合帧窗口（plan 20260916-terminal-cursor-parity M2）。高吞吐时 PTY 一次 8 KB 的读能
/// 每秒来几百次，每次读都要单独发一条 worker dirty record + 每订阅者一条 PtyOutput；
/// worker 的 per-channel 队列在**条数**（256）与字节数上各有一个独立上限，条数先打满就是一次
/// gap → snapshot → `terminal.reset()` 整屏重绘。合帧削的正是条数这一维。
/// 5 ms 与 Cursor 取同一量级：低于感知阈，却足以把一次 burst 里的十几次读并成一帧。
const OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(5);
/// 合帧的**字节**上界。没有它，一条持续 8 KB/次的 `yes` 会在窗口内无限累积，合出来的巨帧
/// 比它取代的那些小帧更糟（客户端一次性 apply、relay 一次性搬运）。8 次读封顶。
const OUTPUT_COALESCE_MAX_BYTES: usize = 64 * 1024;
/// 订阅转发线程与合帧线程之间的分片队列。满了就让转发线程阻塞在 send 上——这与合帧前
/// 「单线程正在处理、暂时不读」的背压语义完全一致，最多 512 KB 在途。
const PTY_CHUNK_QUEUE_RECORDS: usize = 64;
/// 每产出这么多字节就向 ptyd 写一次 checkpoint：半个 ring。ptyd 绝不覆盖偏移 ≥ 上次 checkpoint
/// 的字节，所以 ring 永远覆盖 `[X, now]`，回放从不落在环绕边界上；预算是半个 ring 的输出，
/// 期间 PTY 顶多被内核缓冲挡住（与今天的有界队列背压同一行为）。
const CHECKPOINT_INTERVAL_BYTES: u64 = PTYD_RING_CAPACITY / 2;
/// catalog 分页只在 request.max_page_bytes 非零时启用；旧 worker 仍拿单帧完整快照。
const CATALOG_PAGE_MIN_BYTES: usize = 64 * 1024;
const CATALOG_PAGE_MAX_BYTES: usize = 1024 * 1024;
const CATALOG_PAGE_MAX_ENTRIES: usize = 128;
const CATALOG_LEASE_LIMIT: usize = 1024;
/// 未 ACK exit fact 不能随中心断线无界增长。超过窗口时只丢最旧精确退出码；下一次完整
/// catalog 的“live 缺席”仍会把中心 task 收敛为 EXITED，因此不会留下永久僵尸。
/// 会话归属 id（plan 092）：中心随建会话请求带下来，supervisor 在 [`Sessions::create_session`] 里组装成
/// Environment variable through which the supervisor hands the per-session mark secret to the
/// shell. coflux's own rc copies it into a shell-scoped variable and unsets it before anything
/// else runs, so nested and remote shells never carry it (see `shell/*`).
pub const TERMINAL_SECRET_ENV: &str = "COFLUX_TERMINAL_SECRET";

/// `wire::TerminalCommandState` view of the sessiond command state.
pub(crate) fn wire_command_state(state: CommandStateInfo) -> TerminalCommandState {
    TerminalCommandState {
        integrated: state.integrated,
        busy: state.busy,
        command_seq: state.command_seq,
        finished_seq: state.finished_seq,
        exit_code: state.exit_code,
    }
}

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

/// supervisor 存在 ptyd `open` 标签里的 session 元数据：ptyd 不解释，新 supervisor 启动时原样拿回。
/// 与 checkpoint 一样由 supervisor 版本化；解析不了就退化成空 task id 的 session，不中止恢复。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct SessionLabel {
    v: u32,
    task_id: String,
    cwd: String,
    started_at: f64,
    #[serde(default)]
    mark_secret: String,
}

const SESSION_LABEL_VERSION: u32 = 1;

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
}

/// Every attachment of the runtime core owns its own bounded queue and forwarding thread; a
/// stalled old consumer can never hold up the new one or the PTYs. The records cross into the
/// tokio side over an in-process channel (plan 20261002-runtime-launcher-merge), no UDS.
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

    pub fn connect(self: &Arc<Self>, generation: u64, sink: tokio::sync::mpsc::Sender<Vec<u8>>) {
        let (sender, receiver) = sync_channel(self.record_limit);
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        self.replace(Some(ConnectionSink {
            generation,
            sender,
            pending_bytes: pending_bytes.clone(),
        }));
        let this = Arc::clone(self);
        thread::spawn(move || {
            for record in receiver {
                let length = record.len();
                if !this.is_current(generation) || sink.blocking_send(record).is_err() {
                    pending_bytes.fetch_sub(length, Ordering::AcqRel);
                    break;
                }
                pending_bytes.fetch_sub(length, Ordering::AcqRel);
            }
            this.disconnect(generation);
            // Dropping `sink` ends the consumer's receive loop, which re-attaches with a new
            // generation and resyncs; the old attachment can never change authority again.
        });
    }

    pub fn disconnect(&self, generation: u64) {
        let mut current = self.current.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|sink| sink.generation == generation)
        {
            current.take();
        }
    }

    fn clear(&self) {
        self.replace(None);
    }

    fn replace(&self, replacement: Option<ConnectionSink>) {
        // Dropping the previous sender ends its forwarding thread once it drains.
        drop(std::mem::replace(&mut *self.current.lock().unwrap(), replacement));
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
                current.take();
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
) -> SessiondEvent {
    match existing {
        Some((existing_task_id, pid)) if existing_task_id == task_id => {
            SessiondEvent::SessionStarted {
                session_id: session_id.to_string(),
                task_id: existing_task_id,
                pid,
            }
        }
        Some((existing_task_id, _)) => SessiondEvent::SessionCreateFailed {
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
            error: format!("{error}；session id 当前属于 task {existing_task_id}"),
        },
        None => SessiondEvent::SessionExit {
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

/// supervisor 手里的 session：没有任何 PTY 描述符——那些都在 ptyd。
struct Session {
    input: InputQueue,
    task_id: String,
    cwd: String,
    pid: i32,
    started_at: f64,
    state: SessionState,
    /// 上一次交给 ptyd 的 checkpoint 所描述的 output_seq。
    last_checkpoint_seq: u64,
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

/// 一次输入写入的失败：`written` 是已经进入 PTY 的前缀长度（ptyd 报告）。
#[derive(Debug)]
struct PtyWriteFailure {
    written: usize,
    error: std::io::Error,
    /// ptyd 按它自己的输入游标拒绝了这一条（`input_seq_gap` / `input_seq_collision` /
    /// `logical_client_limit`）：什么都没写进 PTY，只是这一条不被接受，session 照常。
    rejected: Option<String>,
}

/// 输入写入的目的地。生产上是 ptyd 的专用输入连接；单测注入失败模式。
/// 成功即代表 ptyd 已把整条 payload 写进 PTY 并推进了它那边的 `(session, client)` 游标。
trait InputSink: Send {
    fn write(
        &mut self,
        session_id: &str,
        client_instance_id: &str,
        input_seq: u64,
        data: &[u8],
    ) -> Result<(), PtyWriteFailure>;
}

struct PtydInputSink(InputChannel);

impl InputSink for PtydInputSink {
    fn write(
        &mut self,
        session_id: &str,
        client_instance_id: &str,
        input_seq: u64,
        data: &[u8],
    ) -> Result<(), PtyWriteFailure> {
        match self.0.write(session_id, client_instance_id, input_seq, data) {
            Ok(_) => Ok(()),
            // slave 端已经没了：与过去 master 上的 EIO 同义，是收尾窗口不是故障。errno 必须保留
            // （`is_teardown_write_failure` 靠它），ptyd 的说明文字进日志。
            Err(PtydError::Remote { code, message }) if code == "pty_closed" => {
                logln!("[sessiond] ptyd 报告 PTY 已关闭 session={session_id} seq={input_seq}: {message}");
                Err(PtyWriteFailure {
                    written: 0,
                    error: std::io::Error::from_raw_os_error(libc::EIO),
                    rejected: None,
                })
            }
            Err(PtydError::Remote { code, message }) if code == "pty_write_partial" => Err(PtyWriteFailure {
                // ptyd 只在前缀已进 PTY 时报 partial；具体字节数在 message 里，这里只需要"非零"。
                written: 1,
                error: std::io::Error::other(message),
                rejected: None,
            }),
            // ptyd 的游标是"什么真正写进了 PTY"的记录；它判 gap / collision / identity 上限时一个字节都没写，
            // 这条输入退回给 client，session 不封死也不 kill。
            Err(PtydError::Remote { code, message })
                if matches!(code.as_str(), "input_seq_gap" | "input_seq_collision" | "logical_client_limit") =>
            {
                Err(PtyWriteFailure {
                    written: 0,
                    error: std::io::Error::other(message),
                    rejected: Some(code),
                })
            }
            Err(error) => Err(PtyWriteFailure {
                written: 0,
                error: std::io::Error::other(error.to_string()),
                rejected: None,
            }),
        }
    }
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

/// PTY master 上的 `EIO` 只有一个含义：slave 端已经没有任何打开的 fd——shell 没了。关闭终端
/// 本来就要 kill child，此刻还在路上的字节（xterm.js 自动回答的 DA/focus 报告之类，不是用户
/// 击键）因此必然写失败。这是 session 生命周期的正常收尾，不是要弹给用户的错误。
///
/// 只认 `written == 0`：partial write 已经把前缀交给子进程，byte-stream 完整性不能再证明，
/// 不因为处在收尾窗口就放宽。Rust 没有稳定的 `ErrorKind` 对应 `EIO`（落在 unstable 的
/// `Uncategorized`），所以只能比较 raw errno。
fn is_teardown_write_failure(failure: &PtyWriteFailure) -> bool {
    failure.written == 0 && failure.error.raw_os_error() == Some(libc::EIO)
}

type SessionHandle = Arc<Mutex<Session>>;

pub struct Sessions {
    map: Mutex<HashMap<String, SessionHandle>>,
    outbound: Arc<Outbound>,
    ptyd: Arc<PtydClient>,
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
        ptyd: Arc<PtydClient>,
        shell: String,
        home: String,
        history_line_limit: usize,
    ) -> Arc<Self> {
        let mut owner = [0u8; 16];
        OsRng.fill_bytes(&mut owner);
        Arc::new(Self {
            map: Mutex::new(HashMap::new()),
            outbound,
            ptyd,
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
        // A compare-exchange loop rather than `fetch_update`, deprecated in favour of `try_update`,
        // which older stable toolchains lack.
        let mut epoch = self.snapshot_epoch.load(Ordering::Acquire);
        while let Err(current) = self.snapshot_epoch.compare_exchange_weak(
            epoch,
            epoch.saturating_add(1),
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            epoch = current;
        }
    }

    fn send_record(&self, record: Vec<u8>) -> bool {
        self.outbound.try_send(record)
    }

    fn send_ctrl(&self, message: &SessiondEvent) -> bool {
        serde_json::to_vec(message)
            .ok()
            .and_then(|bytes| write_record(&bytes).ok())
            .is_some_and(|record| self.send_record(record))
    }

    /// 生命周期 control 一旦因有界队列满而未入队，主动切断当前 UDS，迫使 worker
    /// 重连并通过 resync.list / session catalog 从 supervisor 权威状态收敛。
    fn send_ctrl_or_disconnect(&self, message: &SessiondEvent, context: &str) -> bool {
        if self.send_ctrl(message) {
            return true;
        }
        logln!("[sessiond] control 未入队，断开 worker 触发 resync: {context}");
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
            SessiondEvent::SessionStarted { pid, .. } => {
                logln!("[sessiond] duplicate session create 幂等重放 {session_id} pid={pid}");
            }
            SessiondEvent::SessionCreateFailed { error, .. } => {
                logln!("[sessiond] session create identity 冲突 {session_id}: {error}");
            }
            SessiondEvent::SessionExit { .. } => {
                logln!("[sessiond] session create failed {session_id}: {error}");
            }
            _ => unreachable!("legacy create 只生成 session 生命周期回执"),
        }
        self.send_ctrl_or_disconnect(&message, "legacy session.create 回执");
    }

    /// 把一个 ptyd 里已经存在（open 过、可能 spawn 过）但 supervisor 不打算保留的 session 收掉：
    /// kill 后等它退出再 remove。best effort，在独立线程里做，不阻塞调用方。
    fn discard_ptyd_session(&self, session_id: String) {
        let ptyd = Arc::clone(&self.ptyd);
        thread::spawn(move || {
            let _ = ptyd.kill(&session_id);
            for _ in 0..200 {
                match ptyd.remove(&session_id) {
                    Ok(()) => return,
                    Err(PtydError::Remote { code, .. }) if code == "session_running" => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => return,
                }
            }
        });
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
        // 环境是**覆盖语义**的 map：先拷贝 supervisor 自身的环境，再逐条写入覆盖项——写在拷贝之前
        // 的任何一项都会被 supervisor 自身的同名变量盖回去（PATH / COFLUX_* / locale 都是）。
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        env.insert("TERM".into(), "xterm-256color".into());
        // plan 20260916-terminal-cursor-parity M1：locale / COLORTERM / TERM_PROGRAM。
        for (key, value) in terminal_env_overrides(|key| std::env::var(key).ok()) {
            env.insert(key.to_string(), value);
        }
        env.insert("COFLUX_HOME".into(), self.home.clone());
        // plan 112：`<COFLUX_HOME>/bin` 前置进 PATH 首段——agent 与 Claude 插件 hook 在 coflux 终端里零安装
        // 命中 app 内置的 Rust 版 coflux（用户自己的终端不受影响，不改用户 shell 配置）。所有平台都做。
        env.insert(
            "PATH".into(),
            prepend_path_segment(
                &format!("{}/bin", self.home),
                std::env::var("PATH").ok().as_deref(),
            ),
        );
        // plan 092：会话归属 id 以 COFLUX_* 注入。六个变量总是存在：中心没下发的为空串，session/task id 本地必有。
        // 变量名是 agent 面向的契约（写进 SKILL.md），只能加不能改。
        env.insert("COFLUX_DEVICE_ID".into(), context.daemon_id.clone());
        env.insert("COFLUX_PROJECT_ID".into(), context.project_id.clone());
        env.insert("COFLUX_WORKSPACE_ID".into(), context.workspace_id.clone());
        env.insert("COFLUX_TASK_ID".into(), task_id.clone());
        env.insert("COFLUX_SESSION_ID".into(), session_id.clone());
        env.remove("COFLUX_MCP_URL");
        // plan 115：shell 集成——按 shell 的 basename 分派，给 shell 塞一段我们自己的 rc，由它在用户 rc
        // 全部跑完之后定义 claude 函数，把 COFLUX_CLAUDE_PLUGIN_DIR 翻译成 `claude --plugin-dir <dir>`。
        // 认不出的 shell（如 /bin/sh 或黑盒用例里的包装脚本）不注入，行为与今天逐字相同。
        // Shell-integration marks (interactive-only terminal model): only an instrumented shell gets
        // the per-session secret; sessiond accepts OSC 133 marks solely when they present it.
        let mut argv = vec![shell.clone()];
        let mut mark_secret = String::new();
        if let Some(injection) =
            shell_integration::plan(&shell, &self.home, |key| std::env::var(key).ok())
        {
            for (key, value) in injection.envs {
                env.insert(key, value);
            }
            argv.extend(injection.args);
            let mut raw = [0u8; 16];
            OsRng.fill_bytes(&mut raw);
            mark_secret = hex::encode(raw);
            env.insert(TERMINAL_SECRET_ENV.into(), mark_secret.clone());
        }
        let started_at = now_ms();
        let label = serde_json::to_string(&SessionLabel {
            v: SESSION_LABEL_VERSION,
            task_id: task_id.clone(),
            cwd: cwd.clone(),
            started_at,
            mark_secret: mark_secret.clone(),
        })
        .unwrap_or_default();
        // 先 open 拿到从属端设备路径，再 spawn：SSH_TTY 必须是这个 session 真实存在的设备。
        let tty = self
            .ptyd
            .open(&session_id, rows, cols, &label)
            .map_err(|error| format!("ptyd open: {error}"))?;
        // plan 20260916：coflux 终端随时可能正被另一台设备观看，所以对 PTY 里的程序而言"输出渲染
        // 在别的机器上"是无条件成立的事实。agent CLI（grok、Claude Code）正是靠 SSH 环境变量决定
        // 剪贴板走本机 pbcopy 还是 OSC 52。只注入 SSH_TTY 一个：它的值是本 session 真实存在的设备路径
        // （程序可能去 stat/open），取不到就不注入——宁可少一个变量，也不能给出一条 stat 不到的路径。
        if tty.is_empty() {
            logln!("[sessiond] 取不到 PTY 设备路径，{session_id} 不注入 SSH_TTY");
        } else {
            env.insert("SSH_TTY".into(), tty);
        }
        let env: Vec<(String, String)> = env.into_iter().collect();
        let pid = match self.ptyd.spawn(&session_id, argv, env, &cwd) {
            Ok(pid) => pid,
            Err(error) => {
                let _ = self.ptyd.remove(&session_id);
                return Err(format!("spawn: {error}"));
            }
        };
        let input_channel = match self.ptyd.input_channel() {
            Ok(channel) => channel,
            Err(error) => {
                self.discard_ptyd_session(session_id.clone());
                return Err(format!("ptyd input channel: {error}"));
            }
        };
        let (input, input_receiver) = InputQueue::new();
        let input_pending_records = input.pending_records.clone();
        let input_pending_bytes = input.pending_bytes.clone();
        let session = {
            // spawn 期间另一入口可能抢占 ID/最后名额；插入点再次检查，失败先收掉孤儿进程。
            let mut map = self.map.lock().unwrap();
            let duplicate = map.contains_key(&session_id);
            if map.len() >= MAX_LIVE_SESSIONS || duplicate {
                drop(map);
                self.discard_ptyd_session(session_id.clone());
                return Err(if duplicate {
                    "duplicate session id".into()
                } else {
                    format!("存活 session 已达上限 {MAX_LIVE_SESSIONS}")
                });
            }
            let session = Arc::new(Mutex::new(Session {
                input,
                task_id: task_id.clone(),
                cwd,
                pid,
                started_at,
                state: SessionState::new(rows, cols, self.history_line_limit)
                    .with_mark_secret(mark_secret),
                last_checkpoint_seq: 0,
            }));
            map.insert(session_id.clone(), session.clone());
            self.bump_snapshot_epoch();
            session
        };
        logln!("[sessiond] session started {session_id} pid={pid}");
        self.send_ctrl_or_disconnect(
            &SessiondEvent::SessionStarted {
                session_id: session_id.clone(),
                task_id,
                pid,
            },
            "session.started",
        );
        self.spawn_input_writer(
            session_id.clone(),
            Arc::downgrade(&session),
            Box::new(PtydInputSink(input_channel)),
            input_receiver,
            input_pending_records,
            input_pending_bytes,
        );
        self.spawn_reader(session_id, session, 0);
        Ok(pid)
    }

    fn spawn_input_writer(
        self: &Arc<Self>,
        session_id: String,
        session: Weak<Mutex<Session>>,
        mut sink: Box<dyn InputSink>,
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
                let result = sink.write(
                    &session_id,
                    &input.client_instance_id,
                    input.input_seq,
                    &input.data,
                );

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
                                logln!(
                                    "[sessiond] PTY input commit 失败 session={session_id} seq={}: {}",
                                    input.input_seq, error.message
                                );
                                let mut locked = session.lock().unwrap();
                                let _ = locked.state.fail_input(
                                    &input.client_instance_id,
                                    input.input_seq,
                                    "pty_input_state_failed",
                                    error.message,
                                );
                                drop(locked);
                                if let Some(sessions) = sessions.upgrade() {
                                    let _ = sessions.ptyd.kill(&session_id);
                                }
                                break;
                            }
                        }
                    }
                    // ptyd 拒绝了这一条（按它的游标判 gap / collision / identity 上限）：弹掉这条 reservation、
                    // 把错误码原样交回 client，继续处理后面的输入。这是退化恢复（拿不到 ptyd 游标的旧 ptyd）
                    // 下的正常路径，不是 session 故障。
                    Err(failure) if failure.rejected.is_some() => {
                        let code = failure.rejected.clone().unwrap_or_default();
                        logln!(
                            "[sessiond] ptyd 拒绝 input（{code}）session={session_id} seq={}: {}",
                            input.input_seq,
                            failure.error
                        );
                        let target = session
                            .lock()
                            .unwrap()
                            .state
                            .reject_pending_input(&input.client_instance_id, input.input_seq);
                        if let (Ok(target), Some(sessions)) = (target, sessions.upgrade()) {
                            sessions.send_device_error(
                                &target.channel_id,
                                Some(target.request_id),
                                &code,
                                failure.error.to_string(),
                            );
                        }
                        continue;
                    }
                    // 关闭终端的收尾窗口：child 被 kill 后 slave fd 全没了，仍在路上的字节
                    // 必然拿到 EIO。只写一行日志，不向 client 发 device error。
                    Err(failure) if is_teardown_write_failure(&failure) => {
                        logln!(
                            "[sessiond] PTY input 落在 session 收尾窗口（slave 端已关闭）session={session_id} seq={} bytes={length}: {}",
                            input.input_seq,
                            failure.error
                        );
                        // EIO 只证明 slave fd 没了，不证明进程已退出；照旧 kill，否则可能留下
                        // 一个活着却永远收不到输入的终端。
                        if let Some(sessions) = sessions.upgrade() {
                            let _ = sessions.ptyd.kill(&session_id);
                        }
                        // 不调用 fail_input：它会存下 input_failure，使该 session 之后的每一条
                        // input 都带回同一个错误码；也不回滚 reservation（cancel 只弹队尾，且会
                        // 把下一条 input 变成 input_seq_gap）。reservation 随 session 一起析构。
                        break;
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
                                "PTY input 未完整写入（{} 字节），session 已终止以防重放前缀：{}",
                                length, failure.error
                            )
                        };
                        logln!(
                            "[sessiond] {code} session={session_id} seq={} written={}/{}: {}",
                            input.input_seq,
                            failure.written,
                            length,
                            failure.error
                        );
                        let target = {
                            let mut locked = session.lock().unwrap();
                            locked.state.fail_input(
                                &input.client_instance_id,
                                input.input_seq,
                                code,
                                message.clone(),
                            )
                        };
                        // PTY byte stream 已不能证明完整性；kill 让 ptyd 的读线程走统一 exit/tombstone 路径。
                        if let Some(sessions) = sessions.upgrade() {
                            let _ = sessions.ptyd.kill(&session_id);
                            if let Ok(target) = target {
                                sessions.send_device_error(
                                    &target.channel_id,
                                    Some(target.request_id),
                                    code,
                                    message,
                                );
                            }
                        }
                        break;
                    }
                }
            }
        });
    }

    /// 测试专用：经进程内 ptyd 起一个真 PTY + 真子进程 + 真订阅的 session，但输入写入端由调用方注入。
    /// `sink` 为 `Some` 时按与生产完全一致的方式起 writer 线程（只是 sink 被注入）；为 `None` 时直接
    /// 丢掉 input 队列的 receiver，等价于 writer 线程已经停止。子进程只在显式 kill 时死去：这条路径上
    /// 没有任何会在 Drop 时替它按 Ctrl-D 的东西。
    #[cfg(test)]
    fn create_session_for_test(
        self: &Arc<Self>,
        session_id: &str,
        sink: Option<Box<dyn InputSink>>,
    ) -> SessionHandle {
        let label = serde_json::to_string(&SessionLabel {
            v: SESSION_LABEL_VERSION,
            task_id: format!("task-{session_id}"),
            cwd: self.home.clone(),
            started_at: now_ms(),
            mark_secret: String::new(),
        })
        .unwrap();
        self.ptyd.open(session_id, 24, 80, &label).expect("ptyd open 应成功");
        let env = vec![
            ("HOME".to_string(), self.home.clone()),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("TERM".to_string(), "xterm-256color".to_string()),
        ];
        let pid = self
            .ptyd
            .spawn(session_id, vec![self.shell.clone()], env, &self.home)
            .expect("ptyd spawn 应成功");
        let (input, input_receiver) = InputQueue::new();
        let pending_records = input.pending_records.clone();
        let pending_bytes = input.pending_bytes.clone();
        let session = Arc::new(Mutex::new(Session {
            input,
            task_id: format!("task-{session_id}"),
            cwd: self.home.clone(),
            pid,
            started_at: now_ms(),
            state: SessionState::new(24, 80, self.history_line_limit),
            last_checkpoint_seq: 0,
        }));
        self.map
            .lock()
            .unwrap()
            .insert(session_id.to_string(), Arc::clone(&session));
        self.bump_snapshot_epoch();
        match sink {
            Some(sink) => self.spawn_input_writer(
                session_id.to_string(),
                Arc::downgrade(&session),
                sink,
                input_receiver,
                pending_records,
                pending_bytes,
            ),
            None => drop(input_receiver),
        }
        self.spawn_reader(session_id.to_string(), Arc::clone(&session), 0);
        session
    }

    /// 从 `from_offset` 起订阅 ptyd 的输出并驱动 sessiond；session 退出后发 tombstone 并让 ptyd 释放它。
    fn spawn_reader(
        self: &Arc<Self>,
        session_id: String,
        session: SessionHandle,
        from_offset: u64,
    ) {
        let this = Arc::clone(self);
        thread::spawn(move || {
            let (chunks, exit) = match this.ptyd.subscribe(&session_id, from_offset) {
                Ok(events) => spawn_subscription_forwarder(session_id.clone(), events, from_offset),
                Err(error) => {
                    logln!("[sessiond] ptyd 订阅失败 session={session_id}: {error}");
                    // 订阅不上就没法当这个 session 的 authority：收掉它，走统一的退出路径。
                    this.discard_ptyd_session(session_id.clone());
                    let (_, receiver) = sync_channel::<Vec<u8>>(1);
                    (receiver, Arc::new(Mutex::new(None)))
                }
            };
            while let Some(batch) =
                coalesce_pty_output(&chunks, OUTPUT_COALESCE_WINDOW, OUTPUT_COALESCE_MAX_BYTES)
            {
                let mut locked = session.lock().unwrap();
                let pending = locked.state.feed(&batch);

                // A coflux mark moved the command state: push it so the worker's `wait`
                // and do-script wake immediately (snapshots carry the same state as a
                // fallback). Best effort — a dropped push is repaired by the next snapshot.
                if let Some(state) = locked.state.take_command_change() {
                    let _ = this.send_ctrl(&SessiondEvent::SessionCommand {
                        session_id: session_id.clone(),
                        state,
                    });
                }
                // Same for the OSC title (plan 20261010-terminal-checkpoint-energy): the runtime
                // reports it as metadata without rendering a snapshot. Best effort too — a dropped
                // event is repaired by the next content snapshot, which carries the title.
                if let Some(title) = locked.state.take_title_change() {
                    let _ = this.send_ctrl(&SessiondEvent::SessionTitle {
                        session_id: session_id.clone(),
                        title,
                    });
                }

                // 只通知 worker 该 session 的派生 checkpoint 已脏；PTY 原始字节不离开
                // supervisor/sessiond。保留旧 output frame 编号便于跨版本 worker 忽略 payload。
                let dirty = match encode_frame(&DataFrame::Output {
                    session_id: session_id.clone(),
                    data: Vec::new(),
                }) {
                    Ok(frame) => frame,
                    Err(error) => {
                        logln!(
                            "[sessiond] session dirty frame 编码失败 session={session_id}: {error}"
                        );
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
                    let sent = this
                        .send_device(&delivery.channel_id, device_envelope::Payload::PtyOutput(output));
                    locked
                        .state
                        .delivery_result(&delivery.channel_id, delivery.delta.to_seq, sent);
                }
                this.deliver_pending_gaps(&session_id, &mut locked.state);

                // 周期 checkpoint：半个 ring 一次，且只在 parser 可证明处于两条序列之间时。
                let checkpoint = this.take_checkpoint_if_due(&mut locked);
                drop(locked);
                if let Some(checkpoint) = checkpoint {
                    if let Err(error) = this.ptyd.checkpoint(&session_id, checkpoint.output_seq, &checkpoint.encode()) {
                        logln!("[sessiond] checkpoint 写入 ptyd 失败 session={session_id}: {error}");
                    }
                }
            }

            // 订阅流以 Exited 结束时带真实退出码；ptyd 本身断开则记 -1。
            let code = exit.lock().unwrap().take().unwrap_or(-1);
            let locked = session.lock().unwrap();
            let final_output_seq = locked.state.output_seq();
            let task_id = locked.task_id.clone();
            let pid = locked.pid;
            let channels = locked.state.subscriber_channels();
            // The terminal's final content (plan 20261010-terminal-checkpoint-energy): rendered now,
            // while sessiond still holds the screen — once the session leaves the map a snapshot
            // request can only answer session_not_found. The runtime decides whether it is owed.
            let final_snapshot = DeviceSessionSnapshot {
                request_id: FINAL_SNAPSHOT_REQUEST_ID.to_string(),
                session_id: session_id.clone(),
                snapshot_seq: final_output_seq,
                ansi_snapshot: locked.state.snapshot(),
                cols: u32::from(locked.state.cols()),
                rows: u32::from(locked.state.rows()),
                title: locked.state.title().to_string(),
                command: Some(wire_command_state(locked.state.command_state())),
            };
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
                logln!("[sessiond] session exited {session_id} code={code}");
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
                // Ahead of session.exit on the same ordered queue, so the runtime still knows the
                // session (and its secrets, for redaction) when the final content arrives. Best
                // effort: under backpressure the last periodic content stays the stored one.
                this.send_device(
                    INTERNAL_CHANNEL_ID,
                    device_envelope::Payload::SessionSnapshot(final_snapshot),
                );
                this.send_ctrl_or_disconnect(
                    &SessiondEvent::SessionExit {
                        session_id: session_id.clone(),
                        exit_code: code,
                        task_id: Some(task_id),
                        pid: Some(pid),
                    },
                    "自然退出 session.exit",
                );
            }
            // 退出事实已进 tombstone：让 ptyd 释放 ring 文件。失败只记日志（ptyd 可能已经不在）。
            if let Err(error) = this.ptyd.remove(&session_id) {
                logln!("[sessiond] ptyd remove 失败 session={session_id}: {error}");
            }
        });
    }

    /// 到了半个 ring 且 parser 处于安全点就打一份 checkpoint。ptyd 不提供 checkpoint 能力时
    /// 什么都不做——那台 ptyd 上 ring 就是普通环（覆盖最旧字节、永不停读），恢复只能从 ring 起点回放，
    /// 接受模态状态丢失；终端照常工作。
    fn take_checkpoint_if_due(&self, session: &mut Session) -> Option<Checkpoint> {
        let seq = session.state.output_seq();
        if seq.saturating_sub(session.last_checkpoint_seq) < CHECKPOINT_INTERVAL_BYTES {
            return None;
        }
        if !self.ptyd.supports("checkpoint") || !session.state.checkpoint_eligible() {
            return None;
        }
        let checkpoint = session.state.checkpoint(PTYD_BLOB_CAPACITY)?;
        session.last_checkpoint_seq = seq;
        Some(checkpoint)
    }

    /// 启动时从 ptyd 接回上一个 supervisor 留下的 session（plan 20260918-ptyd-terminal-custody）。
    /// 每个 session 独立恢复：blob 读不了就只回放 ring，ring 也读不了就以当前偏移的空屏接上
    /// （client 看到一次整屏重绘），已退出的直接进 tombstone；任何一个失败都不影响其它 session，
    /// 更不是 supervisor 退出的理由。必须在 worker 启动之前完成，否则 resync 会看到还在动的序号。
    pub fn recover(self: &Arc<Self>) {
        let infos = match self.ptyd.list() {
            Ok(infos) => infos,
            Err(error) => {
                logln!("[sessiond] 无法从 ptyd 枚举 session：{error}");
                return;
            }
        };
        let live = infos.iter().filter(|info| info.exit_code.is_none() && info.pid > 0).count();
        logln!("[sessiond] ptyd 上有 {} 个 session（{live} 个仍在运行），开始恢复", infos.len());
        for info in infos {
            let session_id = info.session_id.clone();
            match self.recover_one(info) {
                Ok(RecoveredSession::Live { degraded }) => {
                    logln!(
                        "[sessiond] session 已恢复 {session_id}{}",
                        if degraded { "（退化：无可用 checkpoint）" } else { "" }
                    );
                }
                Ok(RecoveredSession::Exited(code)) => {
                    logln!("[sessiond] session 在 supervisor 缺席期间已退出 {session_id} code={code}");
                }
                Err(error) => {
                    logln!("[sessiond] session 恢复失败 {session_id}：{error}");
                }
            }
        }
    }

    fn recover_one(self: &Arc<Self>, info: PtydSessionInfo) -> Result<RecoveredSession, String> {
        let session_id = info.session_id.clone();
        let label: SessionLabel = serde_json::from_str(&info.label).unwrap_or_default();
        if label.v != SESSION_LABEL_VERSION && !info.label.is_empty() {
            logln!("[sessiond] session 标签版本不认识 {session_id} v={}，按空元数据恢复", label.v);
        }
        let task_id = label.task_id;
        let cwd = if label.cwd.is_empty() { self.home.clone() } else { label.cwd };
        let started_at = if label.started_at > 0.0 { label.started_at } else { info.started_at_ms as f64 };

        // 没 spawn 成功过（上一个 supervisor 在 open 与 spawn 之间死了）或已退出：都是退出事实。
        if info.pid <= 0 || info.exit_code.is_some() {
            let code = info.exit_code.unwrap_or(-1);
            let event_number = self.next_event_id.fetch_add(1, Ordering::Relaxed) + 1;
            let tombstone = DeviceSessionExitTombstone {
                event_id: format!("exit-{}-{event_number}", std::process::id()),
                session_id: session_id.clone(),
                task_id,
                exit_code: code,
                final_output_seq: info.output_offset,
                exited_at: now_ms(),
            };
            self.tombstones.lock().unwrap().push(tombstone);
            self.bump_snapshot_epoch();
            if info.pid > 0 {
                let _ = self.ptyd.remove(&session_id);
            } else {
                self.discard_ptyd_session(session_id);
            }
            return Ok(RecoveredSession::Exited(code));
        }

        // 1) blob：有且能解析就从它起；否则从 ring 起点空屏起（退化）。
        let checkpoint = if self.ptyd.supports("blob") {
            match self.ptyd.blob(&session_id) {
                Ok(Some((offset, blob))) => match Checkpoint::decode(&blob) {
                    Some(checkpoint) if checkpoint.output_seq == offset && offset <= info.output_offset => Some(checkpoint),
                    Some(_) => {
                        logln!("[sessiond] checkpoint 偏移与 ptyd 不一致 {session_id}，只回放 ring");
                        None
                    }
                    None => {
                        logln!("[sessiond] checkpoint blob 无法解析 {session_id}，只回放 ring");
                        None
                    }
                },
                Ok(None) => None,
                Err(error) => {
                    logln!("[sessiond] 读 checkpoint blob 失败 {session_id}：{error}，只回放 ring");
                    None
                }
            }
        } else {
            None
        };
        let degraded = checkpoint.is_none();
        let (mut state, mut cursor) = match checkpoint {
            Some(checkpoint) => {
                let offset = checkpoint.output_seq;
                let terminal = TerminalState::restore(&checkpoint, self.history_line_limit, label.mark_secret.clone());
                (SessionState::restore(terminal), offset)
            }
            None => {
                let mut state = SessionState::new(info.rows, info.cols, self.history_line_limit)
                    .with_mark_secret(label.mark_secret.clone());
                state.set_output_seq(info.ring_start);
                (state, info.ring_start)
            }
        };
        let last_checkpoint_seq = cursor;

        // 2) resize 日志：偏移 ≥ 起点的条目在回放到该偏移时套用（等于起点的可能已含在 blob 里，
        //    resize 对相同尺寸是 no-op）。
        let mut resizes: VecDeque<PtydResizeEntry> = if self.ptyd.supports("resizes") {
            match self.ptyd.resizes(&session_id) {
                Ok(entries) => entries.into_iter().filter(|entry| entry.offset >= cursor).collect(),
                Err(error) => {
                    logln!("[sessiond] 读 resize 日志失败 {session_id}：{error}");
                    VecDeque::new()
                }
            }
        } else {
            VecDeque::new()
        };

        // 3) 回放 ring 到 list 时的末尾；之后的字节由订阅接上。
        let target = info.output_offset;
        let mut replay_ok = true;
        // Pipelined reads on a dedicated connection (plan 20261002-runtime-launcher-merge): the
        // degraded path replays up to a whole ring, and one round trip per chunk dominated it.
        // Any failure falls back to the sequential read below for the rest of the segment.
        let mut pipelined = crate::ptyd_reader::PipelinedReader::open(self.ptyd.socket_path());
        while cursor < target {
            while resizes.front().is_some_and(|entry| entry.offset <= cursor) {
                let entry = resizes.pop_front().unwrap();
                state.resize(entry.rows, entry.cols);
            }
            let stop = resizes.front().map_or(target, |entry| entry.offset.min(target));
            if let Some(reader) = pipelined.as_mut() {
                let mut advanced = 0u64;
                let outcome = reader.read_range(&session_id, cursor, stop, |chunk| {
                    state.feed(chunk);
                    advanced += chunk.len() as u64;
                });
                cursor += advanced;
                match outcome {
                    Ok(()) => continue,
                    Err(error) => {
                        logln!("[sessiond] pipelined ring replay fell back to sequential reads {session_id} offset={cursor}: {error}");
                        pipelined = None;
                        continue;
                    }
                }
            }
            let want = (stop - cursor).min(u64::from(PTYD_MAX_READ_BYTES)) as u32;
            match self.ptyd.read(&session_id, cursor, want) {
                Ok((at, data)) if at == cursor && !data.is_empty() => {
                    state.feed(&data);
                    cursor += data.len() as u64;
                }
                Ok(_) => {
                    replay_ok = false;
                    break;
                }
                Err(error) => {
                    logln!("[sessiond] 回放 ring 失败 {session_id} offset={cursor}：{error}");
                    replay_ok = false;
                    break;
                }
            }
        }
        while let Some(entry) = resizes.pop_front() {
            state.resize(entry.rows, entry.cols);
        }
        if !replay_ok {
            // ring 读不了：以当前尺寸、当前偏移的空屏接上——client 会看到一次整屏重绘。
            state = SessionState::new(info.rows, info.cols, self.history_line_limit)
                .with_mark_secret(label.mark_secret.clone());
            state.set_output_seq(target);
            cursor = target;
        } else if state.rows() != info.rows || state.cols() != info.cols {
            state.resize(info.rows, info.cols);
        }
        let _ = state.take_command_change();

        // 4) 输入游标：ptyd 那边才是"什么真正写进了 PTY"的记录。
        //    拿不到游标（旧 ptyd 没有 `cursors`、或读失败）就以 client 自报的 seq 为起点接纳，重复 / 跳号
        //    交给 ptyd 写入时裁决——否则回来的 client 一律被判 `input_seq_gap`，能力缺失就成了死 ack。
        let mut cursors_restored = false;
        if self.ptyd.supports("cursors") {
            match self.ptyd.cursors(&session_id) {
                Ok(cursors) => {
                    for cursor_info in cursors {
                        let data = hex::decode(&cursor_info.data_hex).unwrap_or_default();
                        state.restore_input_cursor(&cursor_info.client_instance_id, cursor_info.seq, data);
                    }
                    cursors_restored = true;
                }
                Err(error) => logln!("[sessiond] 读输入游标失败 {session_id}：{error}"),
            }
        }
        if !cursors_restored {
            state.set_cursorless_rebuild();
        }

        // 5) 挂上 writer 与订阅，登记为存活 session。
        let input_channel = self
            .ptyd
            .input_channel()
            .map_err(|error| format!("ptyd input channel: {error}"))?;
        let (input, input_receiver) = InputQueue::new();
        let pending_records = input.pending_records.clone();
        let pending_bytes = input.pending_bytes.clone();
        let session = Arc::new(Mutex::new(Session {
            input,
            task_id,
            cwd,
            pid: info.pid,
            started_at,
            state,
            last_checkpoint_seq,
        }));
        {
            let mut map = self.map.lock().unwrap();
            if map.contains_key(&session_id) {
                return Err("session id 已在恢复表中".into());
            }
            map.insert(session_id.clone(), Arc::clone(&session));
            self.bump_snapshot_epoch();
        }
        self.spawn_input_writer(
            session_id.clone(),
            Arc::downgrade(&session),
            Box::new(PtydInputSink(input_channel)),
            input_receiver,
            pending_records,
            pending_bytes,
        );
        self.spawn_reader(session_id, session, cursor);
        Ok(RecoveredSession::Live { degraded })
    }

    // 单 session 的内存天然由 COFLUX_HISTORY_LINES 封顶（history 行数 × 列宽），故不再做全局
    // 字节预算：那套 reservation 用保守估算（wrap ×4、cell 40B）虚高约一个数量级，结果是机器
    // 内存充裕却拒绝开新终端 / 拒绝 attach 更宽的客户端。
    fn resize_locked(&self, session_id: &str, session: &mut Session, rows: u16, cols: u16) -> Result<(), String> {
        if session.state.rows() == rows && session.state.cols() == cols {
            return Ok(());
        }
        self.ptyd
            .resize(session_id, rows, cols)
            .map_err(|error| error.to_string())?;
        session.state.resize(rows, cols);
        Ok(())
    }

    pub fn close(&self, session_id: &str) {
        if self.get(session_id).is_some() {
            let _ = self.ptyd.kill(session_id);
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
                    command: Some(locked.state.command_state()),
                    title: locked.state.title().to_string(),
                }
            })
            .collect();
        self.send_ctrl(&SessiondEvent::ResyncList {
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
        if let Err(error) = self.resize_locked(&request.session_id, &mut locked, rows, cols) {
            return self.send_device_error(
                channel_id,
                Some(request.request_id),
                "pty_resize_failed",
                error,
            );
        }
        // 本地重发缓冲之外、ring 之内的 resume 从 ptyd 取字节（seq 就是偏移 + 1）。
        let ptyd = Arc::clone(&self.ptyd);
        let session_id = request.session_id.clone();
        let mut ring = |from_seq: u64, to_seq: u64| -> Option<Vec<u8>> {
            let mut out = Vec::new();
            let mut offset = from_seq.checked_sub(1)?;
            let end = to_seq;
            while offset < end {
                let want = (end - offset).min(u64::from(PTYD_MAX_READ_BYTES)) as u32;
                let (at, data) = ptyd.read(&session_id, offset, want).ok()?;
                if at != offset || data.is_empty() {
                    return None;
                }
                offset += data.len() as u64;
                out.extend_from_slice(&data);
            }
            Some(out)
        };
        let outcome = match locked.state.attach_with_ring(
            channel_id,
            &request.client_instance_id,
            request.transport_generation,
            request.resume_from_seq,
            &mut ring,
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
                command: Some(wire_command_state(locked.state.command_state())),
            }),
        );
    }

    fn device_input(&self, channel_id: &str, request: DevicePtyInput) {
        let Some(session) = self.get(&request.session_id) else {
            // reader 的退出处理已经把 session 摘出 map：这条 input 撞上的是关闭终端的收尾窗口
            // （多半是终端自己发出的自动回复），不是用户该看到的错误。client 没有人在等 input
            // 应答，retained input 由 sessionExited 释放。只有 device_input 这一处静默，
            // attach/stop/snapshot/resize 的 session_not_found 仍回答调用方的真实提问。
            logln!(
                "[sessiond] PTY input 落在 session 收尾窗口（session 已退出）session={} seq={} bytes={}",
                request.session_id,
                request.input_seq,
                request.data.len()
            );
            return;
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
        let input_bytes = request.data.len();
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
                    // writer 线程只在 session 终止路径上退出，队列断开按构造就等于"这个 session
                    // 正在消失"。与 writer 侧收尾分支一样只记日志：reservation 原样留着，既不
                    // fail_input（会封死该 session 之后的每条 input），也不 cancel（只弹队尾，
                    // 而且会把下一条 input 变成 input_seq_gap，触发 client 重投整段 retained
                    // input）。留着的 reservation 是惰性的：后续 input 照常 admit 后再次静默，
                    // 同 seq 重投走 Pending，整个 SessionState 随 session 一起析构。
                    Err(InputQueueError::Disconnected) => {
                        logln!(
                            "[sessiond] PTY input 落在 session 收尾窗口（writer 已停止）session={session_id} seq={} bytes={input_bytes}",
                            request.input_seq
                        );
                        Ok(None)
                    }
                    Err(InputQueueError::Full) => {
                        if !locked
                            .state
                            .cancel_input_reservation(&client_instance_id, request.input_seq)
                        {
                            logln!(
                                "[sessiond] input reservation 回滚失败 session={session_id} seq={}",
                                request.input_seq
                            );
                        }
                        Err(ControlError {
                            code: "pty_input_backpressure",
                            message: format!(
                                "PTY input queue 已满（最多 {PTY_INPUT_QUEUE_RECORDS} 条/{PTY_INPUT_QUEUE_BYTES} 字节），请重试"
                            ),
                        })
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
                if let Err(error) = self.resize_locked(&request.session_id, &mut locked, rows, cols) {
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
                let locked = session.lock().unwrap();
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
                    Ok(()) => match self.ptyd.kill(&request.session_id) {
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

    pub fn worker_connected(self: &Arc<Self>, generation: u64, sink: tokio::sync::mpsc::Sender<Vec<u8>>) {
        self.outbound.clear();
        let sessions: Vec<SessionHandle> = self.map.lock().unwrap().values().cloned().collect();
        for session in sessions {
            session.lock().unwrap().state.clear_subscribers();
        }
        self.outbound.connect(generation, sink);
    }

    /// Live session ids sessiond currently serves (the set reported to the launcher).
    pub fn live_session_ids(&self) -> Vec<String> {
        self.map.lock().unwrap().keys().cloned().collect()
    }

    pub fn worker_disconnected(&self, generation: u64) {
        self.outbound.disconnect(generation);
    }

    /// Cut whatever attachment is current (a resync that could not be queued): the bridge then
    /// re-attaches with a fresh generation and asks again.
    pub fn worker_disconnected_current(&self) {
        self.outbound.clear();
    }

}

enum RecoveredSession {
    Live { degraded: bool },
    Exited(i32),
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
    use std::io::Write;

    #[test]
    fn prepend_path_segment_handles_empty_existing_and_multi_segment_paths() {
        // 空 / 缺失：只有这一段
        assert_eq!(
            prepend_path_segment("/h/.coflux/bin", None),
            "/h/.coflux/bin"
        );
        assert_eq!(
            prepend_path_segment("/h/.coflux/bin", Some("")),
            "/h/.coflux/bin"
        );
        // 多段：前置，其余顺序不变
        assert_eq!(
            prepend_path_segment("/h/.coflux/bin", Some("/usr/local/bin:/usr/bin:/bin")),
            "/h/.coflux/bin:/usr/local/bin:/usr/bin:/bin"
        );
        // 已含该段（中间 / 首位）：去重后仍只出现一次且在首位
        assert_eq!(
            prepend_path_segment("/h/.coflux/bin", Some("/usr/bin:/h/.coflux/bin:/bin")),
            "/h/.coflux/bin:/usr/bin:/bin"
        );
        assert_eq!(
            prepend_path_segment("/h/.coflux/bin", Some("/h/.coflux/bin:/usr/bin")),
            "/h/.coflux/bin:/usr/bin"
        );
        // 空段照原样保留（PATH 里的空段有"当前目录"语义，不替用户清理）
        assert_eq!(prepend_path_segment("/x", Some("/a::/b")), "/x:/a::/b");
    }

    /// 把「拷贝 std::env::vars() 再逐条覆盖」这一步建模成纯值：模拟的父环境 + 覆盖项 = 子进程
    /// 实际拿到的环境。不起真 shell 读 `locale`——本 crate 已有三条测试因为起真 shell 而在
    /// 装了 coflux agent 集成的开发机上必假红。
    fn spawn_env(parent: &[(&str, &str)]) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> = parent
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        let lookup = |key: &str| {
            parent
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value).to_string())
        };
        for (key, value) in terminal_env_overrides(lookup) {
            env.insert(key.to_string(), value);
        }
        env
    }

    #[test]
    fn spawn_env_injects_utf8_locale_only_when_the_parent_has_none() {
        // 父环境三个 locale 变量全空：注入 UTF-8 默认值，shell 于是拿到 UTF-8 的 LC_CTYPE。
        let injected = spawn_env(&[("PATH", "/usr/bin")]);
        assert_eq!(injected.get("LANG").map(String::as_str), Some("C.UTF-8"));
        assert!(
            injected["LANG"].to_ascii_uppercase().contains("UTF-8"),
            "注入的 locale 必须是 UTF-8"
        );
        assert_eq!(injected.get("LC_ALL"), None, "不新增 LC_ALL");
        assert_eq!(injected.get("LC_CTYPE"), None, "不新增 LC_CTYPE");

        // 空串等同于未设置：shell 里 `LANG=` 与没有 LANG 的 setlocale 行为一致。
        let empty = spawn_env(&[("LANG", ""), ("LC_ALL", ""), ("LC_CTYPE", "")]);
        assert_eq!(empty.get("LANG").map(String::as_str), Some("C.UTF-8"));
    }

    #[test]
    fn spawn_env_passes_the_parent_locale_through_verbatim_including_non_utf8() {
        // 三者任一非空 → 整体不注入。故意设的非 UTF-8 locale 也原样透传：
        // 「保留父 locale」优先于「保证 UTF-8」。
        let deliberate_c = spawn_env(&[("LANG", "C")]);
        assert_eq!(deliberate_c.get("LANG").map(String::as_str), Some("C"));
        assert_eq!(deliberate_c.get("LC_ALL"), None);
        assert_eq!(deliberate_c.get("LC_CTYPE"), None);

        // LC_ALL 单独存在时也不能给 LANG 补一个与之矛盾的默认值。
        let lc_all_only = spawn_env(&[("LC_ALL", "ja_JP.eucJP")]);
        assert_eq!(
            lc_all_only.get("LC_ALL").map(String::as_str),
            Some("ja_JP.eucJP")
        );
        assert_eq!(lc_all_only.get("LANG"), None, "LC_ALL 已定调，不再注入 LANG");

        // LC_CTYPE 同理——它正是宽字符判定真正读的那一个。
        let lc_ctype_only = spawn_env(&[("LC_CTYPE", "zh_CN.GB18030")]);
        assert_eq!(
            lc_ctype_only.get("LC_CTYPE").map(String::as_str),
            Some("zh_CN.GB18030")
        );
        assert_eq!(lc_ctype_only.get("LANG"), None);

        // 三者同时存在时优先级不影响结论：一个都不改。
        let all_three = spawn_env(&[
            ("LC_ALL", "de_DE.UTF-8"),
            ("LC_CTYPE", "de_DE.UTF-8"),
            ("LANG", "de_DE.UTF-8"),
        ]);
        assert_eq!(
            all_three.get("LANG").map(String::as_str),
            Some("de_DE.UTF-8")
        );
    }

    #[test]
    fn spawn_env_fills_colorterm_when_absent_and_always_names_coflux() {
        let injected = spawn_env(&[]);
        assert_eq!(
            injected.get("COLORTERM").map(String::as_str),
            Some("truecolor")
        );
        assert_eq!(
            injected.get("TERM_PROGRAM").map(String::as_str),
            Some("coflux")
        );

        // 父环境已声明颜色能力 → 透传，不替用户「升级」。
        let existing = spawn_env(&[("COLORTERM", "24bit")]);
        assert_eq!(existing.get("COLORTERM").map(String::as_str), Some("24bit"));

        // TERM_PROGRAM 与 TERM 同类：描述宿主终端，coflux 会话里继承来的值是错的。
        let inherited = spawn_env(&[("TERM_PROGRAM", "Apple_Terminal")]);
        assert_eq!(
            inherited.get("TERM_PROGRAM").map(String::as_str),
            Some("coflux")
        );
    }

    #[test]
    fn spawn_env_keeps_every_other_parent_variable_untouched() {
        let env = spawn_env(&[("PATH", "/usr/bin"), ("HOME", "/h"), ("EDITOR", "vi")]);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/h"));
        assert_eq!(env.get("EDITOR").map(String::as_str), Some("vi"));
    }

    /// 把一串已经就绪的 PTY 分片喂给合帧器，返回它实际交付的帧。所有分片预先入队后即关闭
    /// 发送端，于是不依赖任何时序：窗口从不真正等待，结果完全确定。
    fn coalesce_all(reads: &[Vec<u8>], window: Duration, max_bytes: usize) -> Vec<Vec<u8>> {
        let (sender, receiver) = sync_channel::<Vec<u8>>(reads.len().max(1));
        for read in reads {
            sender.send(read.clone()).expect("测试队列不应满");
        }
        drop(sender);
        let mut frames = Vec::new();
        while let Some(batch) = coalesce_pty_output(&receiver, window, max_bytes) {
            frames.push(batch);
        }
        frames
    }

    #[test]
    fn coalesce_pty_output_merges_a_burst_into_fewer_frames_than_reads() {
        // 高吞吐的形状：一次 burst 里几十次小读。worker 的 per-channel 队列先打满的是
        // **条数**那一维，合帧削的正是它。
        let reads: Vec<Vec<u8>> = (0..24u8)
            .map(|index| vec![b'a' + index % 26; 96])
            .collect();
        let frames = coalesce_all(&reads, Duration::from_millis(50), 64 * 1024);

        assert!(
            frames.len() < reads.len(),
            "合帧后帧数必须少于读次数：{} 帧 / {} 次读",
            frames.len(),
            reads.len()
        );
        assert_eq!(
            frames.concat(),
            reads.concat(),
            "合帧只许改分帧，不许丢字节或改顺序"
        );
    }

    #[test]
    fn coalesce_pty_output_is_bounded_by_the_window_not_by_the_next_read() {
        // 时间上界：窗口内没有新分片就必须交付已有的，绝不压到下一次读为止——安静的终端上
        // 「下一次读」可能是几分钟以后，那会把回显延迟变成挂起。
        let (sender, receiver) = sync_channel::<Vec<u8>>(4);
        sender.send(b"prompt$ ".to_vec()).expect("首个分片应入队");
        let late = thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            let _ = sender.send(b"late".to_vec());
        });

        let started = Instant::now();
        let first = coalesce_pty_output(&receiver, Duration::from_millis(5), 64 * 1024)
            .expect("读侧仍在，必有一帧");
        let elapsed = started.elapsed();
        assert_eq!(first, b"prompt$ ".to_vec());
        assert!(
            elapsed < Duration::from_millis(300),
            "必须在窗口内交付，而不是等下一次读：{elapsed:?}"
        );

        late.join().expect("迟到分片线程应正常结束");
        let next = coalesce_pty_output(&receiver, Duration::from_millis(5), 64 * 1024)
            .expect("迟到的分片进入下一帧");
        assert_eq!(next, b"late".to_vec(), "窗口外的字节一个都不能丢");
    }

    #[test]
    fn coalesce_pty_output_stops_at_the_byte_budget_instead_of_merging_unboundedly() {
        // 字节上界：没有它，一条持续刷屏的命令会在窗口内无限累积，合出的巨帧比它取代的
        // 那些小帧更糟。窗口给到 60 s 就是为了证明「先撞预算」——真等窗口这条用例会挂死。
        let budget = 64 * 1024;
        let reads: Vec<Vec<u8>> = (0..32).map(|_| vec![b'x'; 8 * 1024]).collect();
        let frames = coalesce_all(&reads, Duration::from_secs(60), budget);

        assert_eq!(frames.len(), 4, "256 KB / 64 KB 预算 = 4 帧");
        for frame in &frames {
            assert!(
                frame.len() <= budget,
                "单帧不得超过字节预算：{} > {budget}",
                frame.len()
            );
        }
        assert_eq!(frames.concat().len(), 32 * 8 * 1024);
    }

    #[test]
    fn coalesce_pty_output_delivers_an_oversized_read_without_waiting_for_the_window() {
        // 单次读本身就超预算时必须原样直出；否则这里会在窗口上干等 60 s。
        let single = vec![vec![b'y'; 128 * 1024]];
        let frames = coalesce_all(&single, Duration::from_secs(60), 64 * 1024);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), 128 * 1024);
    }

    #[test]
    fn coalesced_frames_stay_sequence_contiguous_through_sessiond() {
        // 合帧最危险的失败模式不是"合得不够"，而是把帧序号弄断：worker 一见序号不连续就抬
        // gap → snapshot → 整屏重绘，正好是本 milestone 要减少的那件事。
        let reads: Vec<Vec<u8>> = (0..12)
            .map(|index| format!("chunk-{index:02} ").into_bytes())
            .collect();
        let frames = coalesce_all(&reads, Duration::from_millis(50), 64 * 1024);
        assert!(frames.len() < reads.len(), "前提：确实发生了合帧");

        let mut state = SessionState::new(24, 80, 100);
        state
            .attach("channel-1", "client-1", 1, None)
            .expect("attach 应成功");

        let mut next_expected = 1u64;
        let mut delivered: Vec<u8> = Vec::new();
        for frame in &frames {
            let pending = state.feed(frame);
            assert_eq!(pending.len(), 1, "唯一订阅者应收到唯一一条 delta");
            let delta = &pending[0].delta;
            assert_eq!(
                delta.from_seq, next_expected,
                "帧必须与上一帧首尾相接，否则 worker 抬 gap"
            );
            assert_eq!(
                delta.to_seq,
                delta.from_seq + delta.data.len() as u64 - 1,
                "序号区间必须正好覆盖该帧字节数"
            );
            next_expected = delta.to_seq + 1;
            delivered.extend_from_slice(&delta.data);
            state.delivery_result("channel-1", delta.to_seq, true);
        }

        assert_eq!(delivered, reads.concat(), "字节流逐字不变");
        assert_eq!(state.output_seq(), reads.concat().len() as u64);
        assert!(state.pending_gaps().is_empty(), "序号连续 → 不抬 gap");
    }

    /// 进程内的真 ptyd：每个用例一个临时 COFLUX_HOME，Drop 时结束子进程并删目录。
    struct TestPtyd {
        ptyd: coflux_ptyd::Ptyd,
        home: std::path::PathBuf,
    }

    impl Drop for TestPtyd {
        fn drop(&mut self) {
            self.ptyd.terminate();
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    fn test_ptyd() -> (TestPtyd, Arc<coflux_ptyd::PtydClient>) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            % 1_000_000_000;
        let home = std::env::temp_dir().join(format!("cfs-{}-{nonce}", std::process::id() % 100_000));
        let ptyd = coflux_ptyd::Ptyd::start(coflux_ptyd::PtydConfig::for_home(&home)).expect("ptyd 应能启动");
        let client = coflux_ptyd::PtydClient::connect(ptyd.socket_path()).expect("应能连上 ptyd");
        (TestPtyd { ptyd, home }, client)
    }

    /// 与生产同构的 `Sessions`（真 ptyd、注入的 outbound），home 落在 ptyd 的临时目录里。
    fn test_sessions(outbound: Arc<Outbound>, shell: &str) -> (Arc<Sessions>, TestPtyd) {
        let (guard, client) = test_ptyd();
        let home = guard.home.to_string_lossy().into_owned();
        let sessions = Sessions::new(outbound, client, shell.into(), home, 0);
        (sessions, guard)
    }

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
            crate::sessiond_ipc::decode_frame(&record[4..]).expect("catalog 应使用 Device frame")
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

    fn receive_control(receiver: &Receiver<Vec<u8>>) -> SessiondEvent {
        let record = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("supervisor 应发送 lifecycle control");
        assert!(record.len() >= 4);
        let declared = u32::from_be_bytes(record[..4].try_into().unwrap()) as usize;
        assert_eq!(declared, record.len() - 4);
        serde_json::from_slice(&record[4..]).expect("lifecycle control 应是合法 JSON")
    }

    /// 每次写都以固定 errno 失败，且一个字节都没写出去（`written == 0`）——模拟 ptyd 报回的
    /// `pty_closed`（EIO）或真故障（EBADF）。
    struct AlwaysFailingWriter(i32);

    impl InputSink for AlwaysFailingWriter {
        fn write(&mut self, _: &str, _: &str, _: u64, _: &[u8]) -> Result<(), PtyWriteFailure> {
            Err(PtyWriteFailure {
                written: 0,
                error: std::io::Error::from_raw_os_error(self.0),
                rejected: None,
            })
        }
    }

    fn device_payload_of(record: &[u8]) -> Option<device_envelope::Payload> {
        let body = record.get(4..)?;
        let DataFrame::Device { data, .. } = crate::sessiond_ipc::decode_frame(body)? else {
            return None;
        };
        decode_device_envelope(&data)?.payload
    }

    fn error_codes(payloads: &[device_envelope::Payload]) -> Vec<&str> {
        payloads
            .iter()
            .filter_map(|payload| match payload {
                device_envelope::Payload::Error(error) => Some(error.code.as_str()),
                _ => None,
            })
            .collect()
    }

    fn receive_device_payload(receiver: &Receiver<Vec<u8>>) -> device_envelope::Payload {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("应在超时前收到 device frame");
            let record = receiver
                .recv_timeout(remaining)
                .expect("应收到 device frame");
            if let Some(payload) = device_payload_of(&record) {
                return payload;
            }
        }
    }

    fn drain_device_payloads(
        receiver: &Receiver<Vec<u8>>,
        window: Duration,
    ) -> Vec<device_envelope::Payload> {
        let deadline = Instant::now() + window;
        let mut payloads = Vec::new();
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(record) = receiver.recv_timeout(remaining) else {
                break;
            };
            if let Some(payload) = device_payload_of(&record) {
                payloads.push(payload);
            }
        }
        payloads
    }

    /// 一直读到该 session 的 SessionExit control，再多收一小段尾巴；沿途收集所有 device
    /// payload。写失败分支里的 device error 发生在 kill 之后、reader 确认退出之前，所以这段
    /// 窗口必然覆盖它——"没有 error"因此是真结论，不是抢跑。
    fn drain_through_session_exit(
        receiver: &Receiver<Vec<u8>>,
        session_id: &str,
    ) -> Vec<device_envelope::Payload> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut payloads = Vec::new();
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("session 应在超时前完成收尾");
            let record = receiver
                .recv_timeout(remaining)
                .expect("应收到 session 收尾记录");
            if let Some(payload) = device_payload_of(&record) {
                payloads.push(payload);
                continue;
            }
            if let Ok(SessiondEvent::SessionExit {
                session_id: exited, ..
            }) = serde_json::from_slice::<SessiondEvent>(&record[4..])
            {
                if exited == session_id {
                    break;
                }
            }
        }
        payloads.extend(drain_device_payloads(receiver, Duration::from_millis(200)));
        payloads
    }

    /// 起一个真 PTY session（`/bin/cat` 不主动产出任何输出，且只在被 kill 时退出——见
    /// `create_session_for_test`），并 attach 出 holder epoch。返回的 `TestPtyd` 必须活到用例结束。
    fn live_session_for_test(
        session_id: &str,
        sink: Option<Box<dyn InputSink>>,
    ) -> (Arc<Sessions>, Receiver<Vec<u8>>, SessionHandle, u64, TestPtyd) {
        let outbound = Outbound::with_limits(64, usize::MAX);
        let (sender, receiver) = sync_channel(64);
        outbound.connect_sender(1, sender);
        let (sessions, guard) = test_sessions(outbound, "/bin/cat");
        let handle = sessions.create_session_for_test(session_id, sink);
        sessions.device_attach(
            "channel-a",
            DeviceSessionAttach {
                request_id: format!("attach-{session_id}"),
                session_id: session_id.into(),
                client_instance_id: "client-a".into(),
                transport_generation: 1,
                cols: 80,
                rows: 24,
                resume_from_seq: None,
            },
        );
        let holder_epoch = loop {
            if let device_envelope::Payload::SessionAttached(attached) =
                receive_device_payload(&receiver)
            {
                break attached.holder_epoch;
            }
        };
        (sessions, receiver, handle, holder_epoch, guard)
    }

    fn input_request(
        request_id: &str,
        session_id: &str,
        holder_epoch: u64,
        input_seq: u64,
        data: &[u8],
    ) -> DevicePtyInput {
        DevicePtyInput {
            request_id: request_id.into(),
            session_id: session_id.into(),
            holder_epoch,
            input_seq,
            data: data.to_vec(),
        }
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
        coflux_ptyd::write_pty_input(&mut writer, b"one").unwrap();
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
        let failure = coflux_ptyd::write_pty_input(&mut writer, b"three").unwrap_err();
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
    fn teardown_eio_write_is_silent_and_leaves_session_input_admissible() {
        // 关闭终端＝child 被 kill、slave fd 全部关闭；此后任何 master write 都是 EIO。
        // 在路上的这几个字节是 xterm.js 自己的自动回复（focus-out `\x1b[O`），不是用户击键。
        let (sessions, receiver, handle, epoch, _ptyd) =
            live_session_for_test("teardown-eio", Some(Box::new(AlwaysFailingWriter(libc::EIO))));
        sessions.device_input(
            "channel-a",
            input_request("input-1", "teardown-eio", epoch, 1, b"\x1b[O"),
        );

        // 这条 session 只可能被收尾分支自己的 kill() 杀掉（harness 全程没有 master writer，
        // 不会替子进程按 Ctrl-D），所以"等到 SessionExit"本身就证明收尾分支跑过了。
        let payloads = drain_through_session_exit(&receiver, "teardown-eio");
        assert!(
            error_codes(&payloads).is_empty(),
            "收尾窗口的 EIO 写失败不得给 client 发任何 device error：{:?}",
            error_codes(&payloads)
        );
        assert!(
            payloads
                .iter()
                .any(|payload| matches!(payload, device_envelope::Payload::SessionExited(_))),
            "session 仍必须照常退出并通知 client"
        );
        // 没有存下 input_failure：同一 session 的后续 input 仍照常 admit。reservation 留在
        // deque 里，所以下一条期望的 seq 仍是 2，不会退化成 input_seq_gap。
        let admitted = handle
            .lock()
            .unwrap()
            .state
            .admit_input("channel-a", "input-2", epoch, 2, b"x".to_vec())
            .expect("收尾的 benign 写失败不得封死这个 session 的 input");
        assert!(matches!(admitted, InputAdmission::Enqueue { .. }));
    }

    #[test]
    fn non_eio_write_failure_still_reports_and_seals_session_input() {
        // 坏描述符不是收尾，是真故障：必须照旧上报，并封死这个 session 的 input。
        let (sessions, receiver, handle, epoch, _ptyd) = live_session_for_test(
            "write-fatal",
            Some(Box::new(AlwaysFailingWriter(libc::EBADF))),
        );
        sessions.device_input(
            "channel-a",
            input_request("input-1", "write-fatal", epoch, 1, b"ls\r"),
        );

        let payloads = drain_through_session_exit(&receiver, "write-fatal");
        assert_eq!(
            error_codes(&payloads),
            vec!["pty_write_failed"],
            "非 EIO 的写失败必须仍然报给 client"
        );
        let refused = handle
            .lock()
            .unwrap()
            .state
            .admit_input("channel-a", "input-2", epoch, 2, b"x".to_vec())
            .expect_err("真故障仍必须封死这个 session 的 input");
        assert_eq!(refused.code, "pty_write_failed");
    }

    #[test]
    fn input_after_writer_stopped_is_silent_and_keeps_admitting() {
        // writer 线程只在 session 终止路径上退出：队列断开按构造就是"这个 session 正在消失"。
        // 这里直接没有 writer 线程（input 队列的 receiver 已丢弃），子进程仍活着。
        let (sessions, receiver, handle, epoch, _ptyd) = live_session_for_test("writer-stopped", None);

        for (request_id, seq, data) in [
            ("input-1", 1, b"\x1b[O".as_slice()),
            // 后续 input 仍照常 admit（没有 input_failure、也没有因回滚 reservation 造成的
            // input_seq_gap），并同样静默。
            ("input-2", 2, b"\x1b[O".as_slice()),
            // 同一 seq 的重投走 Pending，一样不回任何东西。
            ("input-1-retry", 1, b"\x1b[O".as_slice()),
        ] {
            sessions.device_input(
                "channel-a",
                input_request(request_id, "writer-stopped", epoch, seq, data),
            );
            let payloads = drain_device_payloads(&receiver, Duration::from_millis(200));
            assert!(
                error_codes(&payloads).is_empty(),
                "writer 已停止时的 input 不得产生 device error：{:?}",
                error_codes(&payloads)
            );
            assert!(
                !payloads
                    .iter()
                    .any(|payload| matches!(payload, device_envelope::Payload::PtyInputAck(_))),
                "没有写进 PTY 的 input 也不得伪造 ACK"
            );
        }
        assert!(
            sessions.get("writer-stopped").is_some(),
            "静默丢弃 input 不得连带终止 session"
        );
        assert!(handle.lock().unwrap().pid > 0);
        let _ = sessions.ptyd.kill("writer-stopped");
    }

    #[test]
    fn input_for_already_exited_session_is_silent() {
        let (sessions, receiver, handle, epoch, _ptyd) = live_session_for_test("already-exited", None);
        assert!(handle.lock().unwrap().pid > 0);
        sessions.ptyd.kill("already-exited").expect("ptyd kill 应成功");
        drain_through_session_exit(&receiver, "already-exited");
        assert!(
            sessions.get("already-exited").is_none(),
            "reader 的退出处理应已把 session 摘出 map"
        );

        sessions.device_input(
            "channel-a",
            input_request("input-1", "already-exited", epoch, 1, b"\x1b[O"),
        );
        let payloads = drain_device_payloads(&receiver, Duration::from_millis(200));
        assert!(
            error_codes(&payloads).is_empty(),
            "session 退出后落下的 input 不得产生 device error：{:?}",
            error_codes(&payloads)
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
            SessiondEvent::SessionStarted {
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
            SessiondEvent::SessionCreateFailed {
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
            SessiondEvent::SessionExit {
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
        let (sessions, _ptyd) = test_sessions(Arc::clone(&outbound), "/bin/cat");

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
            SessiondEvent::SessionStarted { ref session_id, pid, .. }
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
            SessiondEvent::SessionStarted { ref session_id, pid, .. }
                if session_id == "duplicate-first" && pid == first_pid
        ));
        let (first_task, first_pid) = {
            let locked = first.lock().unwrap();
            let mut map = sessions.map.lock().unwrap();
            let removed = map.remove("duplicate-first").unwrap();
            assert!(Arc::ptr_eq(&removed, &first));
            let identity = (locked.task_id.clone(), locked.pid);
            let _ = sessions.ptyd.kill("duplicate-first");
            identity
        };
        assert!(sessions.send_ctrl_or_disconnect(
            &SessiondEvent::SessionExit {
                session_id: "duplicate-first".into(),
                exit_code: 0,
                task_id: Some(first_task),
                pid: Some(first_pid),
            },
            "test duplicate-first exit",
        ));
        assert!(matches!(
            receive_control(&receiver),
            SessiondEvent::SessionExit { ref session_id, pid: Some(pid), .. }
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
            SessiondEvent::SessionStarted { ref session_id, pid, .. }
                if session_id == "exit-first" && pid == second_pid
        ));
        let second = sessions.get("exit-first").unwrap();
        let locked = second.lock().unwrap();
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
        let _ = sessions.ptyd.kill("exit-first");
        assert!(sessions.send_ctrl_or_disconnect(
            &SessiondEvent::SessionExit {
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
            SessiondEvent::SessionExit { ref session_id, pid: Some(pid), .. }
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
        let (sessions, _ptyd) = test_sessions(Arc::clone(&outbound), "/bin/sh");

        assert!(!sessions.send_ctrl_or_disconnect(
            &SessiondEvent::SessionExit {
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
        let (sessions, _ptyd) = test_sessions(Outbound::new(), "/bin/sh");
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
        let (sessions, _ptyd) = test_sessions(outbound, "/bin/sh");
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
        let (sessions, _ptyd) = test_sessions(outbound, "/bin/sh");
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
        let (sessions, _ptyd) = test_sessions(outbound, "/bin/sh");
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
