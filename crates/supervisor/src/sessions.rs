//! PTY 会话生命周期（活在 supervisor）。每个 session 用独立 mutex 串行化 PTY、VT、sequence
//! 与 attach；worker/中心只是可丢失并重建的 transport。

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use coflux_protocol::wire::{
    device_envelope, DeviceEnvelope, DeviceError, DeviceExitAck, DeviceOperationAck, DevicePtyGap, DevicePtyInput,
    DevicePtyInputAck, DevicePtyOutput, DevicePtyResize, DeviceSessionAttach, DeviceSessionAttached, DeviceSessionCatalog,
    DeviceSessionCatalogRequest, DeviceSessionCreate, DeviceSessionExitTombstone, DeviceSessionExited, DeviceSessionInfo,
    DeviceSessionSnapshot, DeviceSessionSnapshotRequest, DeviceSessionStop,
};
use coflux_protocol::{
    decode_device_envelope, encode_device_envelope, encode_frame, write_record, DataFrame, SessionInfo, SupervisorToWorker,
    DEVICE_PROTOCOL_VERSION, MAX_DEVICE_FRAME_BYTES, MAX_TERMINAL_DIMENSION, MIN_TERMINAL_DIMENSION,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::sessiond::{estimated_terminal_bytes, ControlError, SequencedDecision, SessionState};

const OPERATION_LEDGER_LIMIT: usize = 4096;
const WORKER_QUEUE_RECORDS: usize = 512;
const WORKER_QUEUE_BYTES: usize = MAX_DEVICE_FRAME_BYTES + 2 * 1024 * 1024;

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
        Arc::new(Self { current: Mutex::new(None), record_limit, byte_limit })
    }

    pub fn connect(self: &Arc<Self>, generation: u64, mut stream: UnixStream) {
        let (sender, receiver) = sync_channel(self.record_limit);
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        let shutdown = stream.try_clone().ok();
        self.replace(Some(ConnectionSink { generation, sender, pending_bytes: pending_bytes.clone(), shutdown }));
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
            if current.as_ref().is_some_and(|sink| sink.generation == generation) {
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
        self.current.lock().unwrap().as_ref().is_some_and(|sink| sink.generation == generation)
    }

    fn try_send(&self, record: Vec<u8>) -> bool {
        let mut current = self.current.lock().unwrap();
        let Some(sink) = current.as_ref() else { return false };
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
        match pending.compare_exchange_weak(current, current + length, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

struct MemoryBudget {
    limit: usize,
    used: usize,
}

impl MemoryBudget {
    fn reserve(&mut self, rows: u16, cols: u16, desired_history_lines: usize) -> Option<(usize, usize)> {
        let available = self.limit.saturating_sub(self.used);
        let viewport = estimated_terminal_bytes(rows, cols, 0);
        if viewport > available {
            return None;
        }
        let per_line = estimated_terminal_bytes(rows, cols, 1).saturating_sub(viewport).max(1);
        let history_lines = desired_history_lines.min((available - viewport) / per_line);
        let reserved = estimated_terminal_bytes(rows, cols, history_lines);
        self.used = self.used.saturating_add(reserved);
        Some((history_lines, reserved))
    }

    fn resize(&mut self, old: usize, new: usize) -> bool {
        if new > old && new - old > self.limit.saturating_sub(self.used) {
            return false;
        }
        self.used = self.used.saturating_sub(old).saturating_add(new);
        true
    }

    fn release(&mut self, bytes: usize) {
        self.used = self.used.saturating_sub(bytes);
    }
}

#[derive(Clone, PartialEq)]
enum OperationRequest {
    Create(DeviceSessionCreate),
    Stop(DeviceSessionStop),
}

fn canonical_stop_request(request: &DeviceSessionStop) -> DeviceSessionStop {
    let mut canonical = request.clone();
    canonical.request_id.clear();
    canonical
}

fn canonical_create_request(request: &DeviceSessionCreate) -> DeviceSessionCreate {
    let mut canonical = request.clone();
    canonical.request_id.clear();
    canonical
}

#[derive(Clone)]
struct StoredOperation {
    request: OperationRequest,
    ack: DeviceOperationAck,
}

#[derive(Default)]
struct OperationLedger {
    entries: HashMap<String, StoredOperation>,
    order: VecDeque<String>,
}

impl OperationLedger {
    fn cached(&self, operation_id: &str, request: &OperationRequest) -> Result<Option<DeviceOperationAck>, ()> {
        match self.entries.get(operation_id) {
            Some(stored) if &stored.request == request => Ok(Some(stored.ack.clone())),
            Some(_) => Err(()),
            None => Ok(None),
        }
    }

    fn remember(&mut self, operation_id: String, request: OperationRequest, ack: DeviceOperationAck) {
        if !self.entries.contains_key(&operation_id) {
            self.order.push_back(operation_id.clone());
        }
        self.entries.insert(operation_id, StoredOperation { request, ack });
        while self.entries.len() > OPERATION_LEDGER_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    task_id: String,
    cwd: String,
    pid: i32,
    started_at: f64,
    history_line_limit: usize,
    reserved_bytes: usize,
    state: SessionState,
}

fn apply_device_input(
    state: &mut SessionState,
    writer: &mut dyn Write,
    channel_id: &str,
    session_id: &str,
    holder_epoch: u64,
    input_seq: u64,
    data: Vec<u8>,
) -> Result<DevicePtyInputAck, ControlError> {
    match state.input_decision(channel_id, holder_epoch, input_seq, &data)? {
        SequencedDecision::Duplicate => Ok(DevicePtyInputAck {
            session_id: session_id.to_string(),
            applied_through_seq: state.input_applied_through(channel_id, holder_epoch)?,
        }),
        SequencedDecision::Apply => {
            writer.write_all(&data).map_err(|error| ControlError { code: "pty_write_failed", message: error.to_string() })?;
            // decision 与 commit 位于同一 session mutex 临界区；写入后 authority 不可能被并发改变。
            state.commit_input(channel_id, holder_epoch, input_seq, data)?;
            Ok(DevicePtyInputAck { session_id: session_id.to_string(), applied_through_seq: input_seq })
        }
    }
}

type SessionHandle = Arc<Mutex<Session>>;

pub struct Sessions {
    map: Mutex<HashMap<String, SessionHandle>>,
    outbound: Arc<Outbound>,
    shell: String,
    home: String,
    history_line_limit: usize,
    memory: Mutex<MemoryBudget>,
    tombstones: Mutex<Vec<DeviceSessionExitTombstone>>,
    next_event_id: AtomicU64,
    operations: Mutex<OperationLedger>,
}

impl Sessions {
    pub fn new(outbound: Arc<Outbound>, shell: String, home: String, history_line_limit: usize, memory_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            map: Mutex::new(HashMap::new()),
            outbound,
            shell,
            home,
            history_line_limit,
            memory: Mutex::new(MemoryBudget { limit: memory_limit, used: 0 }),
            tombstones: Mutex::new(Vec::new()),
            next_event_id: AtomicU64::new(0),
            operations: Mutex::new(OperationLedger::default()),
        })
    }

    fn send_record(&self, record: Vec<u8>) -> bool {
        self.outbound.try_send(record)
    }

    fn send_ctrl(&self, message: &SupervisorToWorker) -> bool {
        serde_json::to_vec(message).is_ok_and(|bytes| self.send_record(write_record(&bytes)))
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
        let frame = encode_frame(&DataFrame::Device { channel_id: channel_id.to_string(), data });
        self.send_record(write_record(&frame))
    }

    fn send_device_error(&self, channel_id: &str, request_id: Option<String>, code: &str, message: impl Into<String>) {
        self.send_device(
            channel_id,
            device_envelope::Payload::Error(DeviceError { request_id, code: code.to_string(), message: message.into() }),
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

    pub fn create(self: &Arc<Self>, session_id: String, task_id: String, cwd: String, shell: String, cols: u16, rows: u16) {
        if let Err(error) = self.create_session(session_id.clone(), task_id, cwd, shell, cols, rows) {
            self.fail(&session_id, &error);
        }
    }

    fn create_session(
        self: &Arc<Self>,
        session_id: String,
        task_id: String,
        cwd: String,
        shell: String,
        cols: u16,
        rows: u16,
    ) -> Result<i32, String> {
        if self.get(&session_id).is_some() {
            return Err("duplicate session id".into());
        }
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("openpty: {error}"))?;
        let shell = if shell.is_empty() { self.shell.clone() } else { shell };
        let cwd = if cwd.is_empty() { self.home.clone() } else { cwd };
        let mut command = CommandBuilder::new(&shell);
        command.cwd(&cwd);
        for (key, value) in std::env::vars() {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).map_err(|error| format!("spawn: {error}"))?;
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
        let pid = child.process_id().map_or(-1, |pid| pid as i32);
        let (history_line_limit, reserved_bytes) = match self.memory.lock().unwrap().reserve(rows, cols, self.history_line_limit) {
            Some(reservation) => reservation,
            None => {
                let _ = child.kill();
                return Err("terminal memory budget exhausted".into());
            }
        };
        let session = Arc::new(Mutex::new(Session {
            master: pair.master,
            writer,
            child,
            task_id: task_id.clone(),
            cwd,
            pid,
            started_at: now_ms(),
            history_line_limit,
            reserved_bytes,
            state: SessionState::new(rows, cols, history_line_limit),
        }));
        self.map.lock().unwrap().insert(session_id.clone(), session.clone());
        eprintln!("[supervisor] session started {session_id} pid={pid}");
        self.send_ctrl(&SupervisorToWorker::SessionStarted { session_id: session_id.clone(), task_id, pid });
        self.spawn_reader(session_id, session, reader);
        Ok(pid)
    }

    fn fail(&self, session_id: &str, why: &str) {
        eprintln!("[supervisor] session create failed {session_id}: {why}");
        self.send_ctrl(&SupervisorToWorker::SessionExit { session_id: session_id.to_string(), exit_code: -1 });
    }

    fn spawn_reader(self: &Arc<Self>, session_id: String, session: SessionHandle, mut reader: Box<dyn Read + Send>) {
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

                        // legacy adapter：旧 worker/server 仍收 raw live output；replay 已改为 VT snapshot。
                        let legacy = encode_frame(&DataFrame::Output { session_id: session_id.clone(), data: chunk.to_vec() });
                        this.send_record(write_record(&legacy));

                        for delivery in pending {
                            let output = DevicePtyOutput {
                                session_id: session_id.clone(),
                                from_seq: delivery.delta.from_seq,
                                to_seq: delivery.delta.to_seq,
                                data: delivery.delta.data,
                            };
                            let sent = this.send_device(&delivery.channel_id, device_envelope::Payload::PtyOutput(output));
                            locked.state.delivery_result(&delivery.channel_id, delivery.delta.to_seq, sent);
                        }
                        this.deliver_pending_gaps(&session_id, &mut locked.state);
                    }
                }
            }

            let mut locked = session.lock().unwrap();
            let code = locked.child.wait().map_or(-1, |status| status.exit_code() as i32);
            let final_output_seq = locked.state.output_seq();
            let task_id = locked.task_id.clone();
            let channels = locked.state.subscriber_channels();
            let reserved_bytes = locked.reserved_bytes;
            let event_number = this.next_event_id.fetch_add(1, Ordering::Relaxed) + 1;
            let tombstone = DeviceSessionExitTombstone {
                event_id: format!("exit-{}-{event_number}", std::process::id()),
                session_id: session_id.clone(),
                task_id,
                exit_code: code,
                final_output_seq,
                exited_at: now_ms(),
            };
            let transitioned = {
                let mut map = this.map.lock().unwrap();
                if map.get(&session_id).is_some_and(|current| Arc::ptr_eq(current, &session)) {
                    // 与 device_catalog 使用相同的 map → tombstones 锁顺序，使 live→exit 在
                    // catalog 视角中是一次原子切换。
                    let mut tombstones = this.tombstones.lock().unwrap();
                    map.remove(&session_id);
                    tombstones.push(tombstone);
                    true
                } else {
                    false
                }
            };
            drop(locked);

            if transitioned {
                this.memory.lock().unwrap().release(reserved_bytes);
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
                this.send_ctrl(&SupervisorToWorker::SessionExit { session_id, exit_code: code });
            }
        });
    }

    pub fn input(&self, session_id: &str, data: &[u8]) {
        if let Some(session) = self.get(session_id) {
            let _ = session.lock().unwrap().writer.write_all(data);
        }
    }

    fn resize_locked(&self, session: &mut Session, rows: u16, cols: u16) -> Result<(), String> {
        let new_reserved = estimated_terminal_bytes(rows, cols, session.history_line_limit);
        let old_reserved = session.reserved_bytes;
        // 保持 reservation 直到 PTY resize 成功或完整回滚；否则 shrink 释放出的额度可能被并发
        // session 占用，底层 resize 失败时便无法恢复旧 reservation。
        let mut memory = self.memory.lock().unwrap();
        if !memory.resize(old_reserved, new_reserved) {
            return Err("terminal memory budget exhausted".into());
        }
        if let Err(error) = session.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
            let restored = memory.resize(new_reserved, old_reserved);
            debug_assert!(restored, "reserved terminal memory rollback must succeed");
            return Err(error.to_string());
        }
        session.state.resize(rows, cols);
        session.reserved_bytes = new_reserved;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(session) = self.get(session_id) {
            let mut locked = session.lock().unwrap();
            let _ = self.resize_locked(&mut locked, rows, cols);
        }
    }

    pub fn close(&self, session_id: &str) {
        if let Some(session) = self.get(session_id) {
            let _ = session.lock().unwrap().child.kill();
        }
    }

    pub fn replay(&self, session_id: &str, request_id: String) {
        let snapshot = self.get(session_id).map_or_else(Vec::new, |session| session.lock().unwrap().state.snapshot());
        let frame = encode_frame(&DataFrame::Replay { session_id: session_id.to_string(), request_id, data: snapshot });
        self.send_record(write_record(&frame));
    }

    pub fn send_resync(&self) {
        let handles: Vec<(String, SessionHandle)> = self.map.lock().unwrap().iter().map(|(id, session)| (id.clone(), session.clone())).collect();
        let sessions = handles
            .into_iter()
            .map(|(session_id, session)| {
                let locked = session.lock().unwrap();
                SessionInfo { session_id, task_id: locked.task_id.clone(), pid: locked.pid }
            })
            .collect();
        self.send_ctrl(&SupervisorToWorker::ResyncList { sessions });
    }

    pub fn handle_device(self: &Arc<Self>, outer_channel_id: &str, bytes: &[u8]) {
        let Some(envelope) = decode_device_envelope(bytes) else {
            return self.send_device_error(outer_channel_id, None, "malformed_envelope", "DeviceEnvelope 解码失败");
        };
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION {
            return self.send_device_error(outer_channel_id, None, "version_mismatch", "Device protocol version 不兼容");
        }
        if envelope.channel_id != outer_channel_id {
            return self.send_device_error(outer_channel_id, None, "channel_mismatch", "inner/outer channelId 不一致");
        }
        let Some(payload) = envelope.payload else {
            return self.send_device_error(outer_channel_id, None, "empty_payload", "DeviceEnvelope payload 为空");
        };
        match payload {
            device_envelope::Payload::SessionCatalogRequest(request) => self.device_catalog(outer_channel_id, request),
            device_envelope::Payload::SessionAttach(request) => self.device_attach(outer_channel_id, request),
            device_envelope::Payload::SessionSnapshotRequest(request) => self.device_snapshot(outer_channel_id, request),
            device_envelope::Payload::PtyInput(request) => self.device_input(outer_channel_id, request),
            device_envelope::Payload::PtyResize(request) => self.device_resize(outer_channel_id, request),
            device_envelope::Payload::SessionStop(request) => self.device_stop(outer_channel_id, request),
            device_envelope::Payload::SessionCreate(request) => self.device_create(outer_channel_id, request),
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
        let (handles, exits): (Vec<(String, SessionHandle)>, Vec<DeviceSessionExitTombstone>) = {
            let map = self.map.lock().unwrap();
            let exits = self.tombstones.lock().unwrap().clone();
            let handles = map.iter().map(|(id, session)| (id.clone(), session.clone())).collect();
            (handles, exits)
        };
        let sessions = handles
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
        self.send_device(
            channel_id,
            device_envelope::Payload::SessionCatalog(DeviceSessionCatalog { request_id: request.request_id, sessions, exits }),
        );
    }

    fn device_exit_ack(&self, request: DeviceExitAck) {
        if request.event_ids.is_empty() {
            return;
        }
        let mut tombstones = self.tombstones.lock().unwrap();
        tombstones.retain(|event| !request.event_ids.contains(&event.event_id));
    }

    fn device_attach(&self, channel_id: &str, request: DeviceSessionAttach) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(channel_id, Some(request.request_id), "session_not_found", "session 不存在或已退出");
        };
        let mut locked = session.lock().unwrap();
        let cols = clamp_dim(request.cols, locked.state.cols());
        let rows = clamp_dim(request.rows, locked.state.rows());
        if let Err(error) = locked.state.validate_attach(channel_id, &request.client_instance_id, request.transport_generation) {
            return self.send_device_error(channel_id, Some(request.request_id), error.code, error.message);
        }
        if let Err(error) = self.resize_locked(&mut locked, rows, cols) {
            return self.send_device_error(channel_id, Some(request.request_id), "pty_resize_failed", error);
        }
        let outcome = match locked.state.attach(
            channel_id,
            &request.client_instance_id,
            request.transport_generation,
            request.resume_from_seq,
        ) {
            Ok(outcome) => outcome,
            Err(error) => return self.send_device_error(channel_id, Some(request.request_id), error.code, error.message),
        };

        if let Some(detached) = outcome.detached {
            self.send_device(
                &detached.channel_id,
                device_envelope::Payload::SessionDetached(coflux_protocol::wire::DeviceSessionDetached {
                    session_id: request.session_id.clone(),
                    holder_epoch: detached.holder_epoch,
                    reason: Some("holder_taken_over".into()),
                }),
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
            return self.send_device_error(channel_id, Some(request.request_id), "session_not_found", "session 不存在或已退出");
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
            }),
        );
    }

    fn device_input(&self, channel_id: &str, request: DevicePtyInput) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(channel_id, Some(request.request_id), "session_not_found", "session 不存在或已退出");
        };
        let request_id = request.request_id;
        let session_id = request.session_id;
        let mut locked = session.lock().unwrap();
        let result = {
            let Session { state, writer, .. } = &mut *locked;
            apply_device_input(state, writer.as_mut(), channel_id, &session_id, request.holder_epoch, request.input_seq, request.data)
        };
        drop(locked);
        match result {
            Ok(ack) => {
                self.send_device(channel_id, device_envelope::Payload::PtyInputAck(ack));
            }
            Err(error) => self.send_device_error(channel_id, Some(request_id), error.code, error.message),
        }
    }

    fn device_resize(&self, channel_id: &str, request: DevicePtyResize) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(channel_id, Some(request.request_id), "session_not_found", "session 不存在或已退出");
        };
        let mut locked = session.lock().unwrap();
        let cols = clamp_dim(request.cols, locked.state.cols());
        let rows = clamp_dim(request.rows, locked.state.rows());
        match locked.state.resize_decision(channel_id, request.holder_epoch, request.resize_seq, rows, cols) {
            Ok(SequencedDecision::Duplicate) => {}
            Ok(SequencedDecision::Apply) => {
                if let Err(error) = self.resize_locked(&mut locked, rows, cols) {
                    return self.send_device_error(channel_id, Some(request.request_id), "pty_resize_failed", error);
                }
                if let Err(error) = locked.state.commit_resize(channel_id, request.holder_epoch, request.resize_seq, rows, cols) {
                    self.send_device_error(channel_id, Some(request.request_id), error.code, error.message);
                }
            }
            Err(error) => self.send_device_error(channel_id, Some(request.request_id), error.code, error.message),
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
                match locked.state.authorize_holder(channel_id, request.holder_epoch) {
                    Err(error) => {
                        drop(ledger);
                        return self.send_device_error(channel_id, Some(request.request_id), error.code, error.message);
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
    value.clamp(u32::from(MIN_TERMINAL_DIMENSION), u32::from(MAX_TERMINAL_DIMENSION)) as u16
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
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

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("injected write failure"))
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
        let request = OperationRequest::Stop(canonical_stop_request(&stop_request("request-1", "session-1")));
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
        assert_eq!(ledger.cached("operation-stop", &request).unwrap(), Some(ack.clone()));

        let retry = OperationRequest::Stop(canonical_stop_request(&stop_request("request-2", "session-1")));
        assert_eq!(ledger.cached("operation-stop", &retry).unwrap(), Some(ack));

        let collision = OperationRequest::Stop(canonical_stop_request(&stop_request("request-2", "session-2")));
        assert!(ledger.cached("operation-stop", &collision).is_err());
    }

    #[test]
    fn sessiond_input_ack_advances_only_after_write_and_replays_cumulative_cursor() {
        let mut state = SessionState::new(3, 12, 4);
        let epoch = state.attach("channel-a", "client-a", 1, None).unwrap().holder_epoch;
        let mut writer = Vec::new();

        let first = apply_device_input(&mut state, &mut writer, "channel-a", "session-1", epoch, 1, b"one".to_vec()).unwrap();
        assert_eq!(first.session_id, "session-1");
        assert_eq!(first.applied_through_seq, 1);
        assert_eq!(writer, b"one");

        let duplicate = apply_device_input(&mut state, &mut writer, "channel-a", "session-1", epoch, 1, b"one".to_vec()).unwrap();
        assert_eq!(duplicate.applied_through_seq, 1);
        assert_eq!(writer, b"one", "duplicate input must not reach the PTY writer");

        let second = apply_device_input(&mut state, &mut writer, "channel-a", "session-1", epoch, 2, b"two".to_vec()).unwrap();
        assert_eq!(second.applied_through_seq, 2);
        assert_eq!(writer, b"onetwo");

        let stale = apply_device_input(&mut state, &mut writer, "channel-a", "session-1", epoch, 1, b"old retry".to_vec()).unwrap();
        assert_eq!(stale.applied_through_seq, 2);
        assert_eq!(writer, b"onetwo", "older retry must only return the cumulative ACK");

        let gap = apply_device_input(&mut state, &mut writer, "channel-a", "session-1", epoch, 4, b"gap".to_vec()).unwrap_err();
        assert_eq!(gap.code, "input_seq_gap");
        assert_eq!(state.input_applied_through("channel-a", epoch).unwrap(), 2);
        assert_eq!(writer, b"onetwo");

        let failed = apply_device_input(&mut state, &mut FailingWriter, "channel-a", "session-1", epoch, 3, b"three".to_vec()).unwrap_err();
        assert_eq!(failed.code, "pty_write_failed");
        assert_eq!(state.input_applied_through("channel-a", epoch).unwrap(), 2);

        let retry = apply_device_input(&mut state, &mut writer, "channel-a", "session-1", epoch, 3, b"three".to_vec()).unwrap();
        assert_eq!(retry.applied_through_seq, 3);
        assert_eq!(writer, b"onetwothree");
    }

    #[test]
    fn sessiond_backpressure_outbound_is_bounded_and_generation_safe() {
        let outbound = Outbound::with_limits(2, 2);
        let (first_sender, _first_receiver) = sync_channel(2);
        outbound.connect_sender(1, first_sender);
        assert!(outbound.try_send(vec![1, 2]));
        assert!(!outbound.try_send(vec![3]), "byte-full queue must reject instead of blocking the PTY reader");

        let (second_sender, second_receiver) = sync_channel(1);
        outbound.connect_sender(2, second_sender);
        outbound.disconnect(1);
        assert!(outbound.try_send(vec![3]), "old writer teardown must not clear the replacement connection");
        assert_eq!(second_receiver.try_recv().unwrap(), vec![3]);
    }

    #[test]
    fn sessiond_backpressure_memory_budget_never_exceeds_limit() {
        let viewport = estimated_terminal_bytes(24, 80, 0);
        let limit = estimated_terminal_bytes(24, 80, 10);
        let mut budget = MemoryBudget { limit, used: 0 };
        let (history_lines, reserved) = budget.reserve(24, 80, 100).unwrap();
        assert_eq!(history_lines, 10);
        assert_eq!(reserved, limit);
        assert_eq!(budget.used, limit);
        assert!(!budget.resize(reserved, limit + 1));
        assert_eq!(budget.used, limit);

        assert!(budget.resize(reserved, viewport));
        assert_eq!(budget.used, viewport);
        budget.release(viewport);
        assert_eq!(budget.used, 0);
    }

    #[test]
    fn sessiond_backpressure_exit_tombstones_survive_until_ack() {
        let sessions = Sessions::new(Outbound::new(), "/bin/sh".into(), "/tmp".into(), 0, 1024 * 1024);
        sessions.tombstones.lock().unwrap().extend([
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
        ]);

        sessions.device_exit_ack(DeviceExitAck { event_ids: Vec::new() });
        assert_eq!(sessions.tombstones.lock().unwrap().len(), 2);
        sessions.device_exit_ack(DeviceExitAck { event_ids: vec!["exit-1".into()] });
        let tombstones = sessions.tombstones.lock().unwrap();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].event_id, "exit-2");
    }
}
