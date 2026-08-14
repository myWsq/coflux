//! direct/relay 共用的 Device channel runtime。
//!
//! 本模块负责 channel principal、scope 门控、sessiond IPC multiplex 与每 channel 有界投递。
//! git/fs/exec 与 prepared operation handler 在同一 runtime 上继续扩展，transport 不解释业务。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use coflux_protocol::wire::{self,
    daemon_to_server, device_envelope, DeviceEnvelope, DeviceError, DeviceExitAck, DevicePtyGap, DeviceRelayDial,
    DeviceScope, DeviceSessionCatalog, DeviceSessionCatalogRequest,
    DeviceSessionSnapshotRequest, PreparedDeviceOperation, PreparedDeviceOperationInstalled, SessionCheckpoint,
};
use coflux_protocol::{
    decode_device_envelope, encode_device_envelope, encode_frame, write_record, DataFrame, DEVICE_PROTOCOL_VERSION,
    MAX_DEVICE_FRAME_BYTES, MAX_SESSION_CHECKPOINT_BYTES,
};
use prost::Message as _;
use rand_core::{OsRng, RngCore};
use tokio::sync::{mpsc, Notify};

use crate::local_auth::{AuthenticatedLocal, LocalAuth, LocalPrincipal};
use crate::{Config, WorkerState, WsOut};

const CHANNEL_QUEUE_RECORDS: usize = 256;
const CHANNEL_QUEUE_BYTES: usize = MAX_DEVICE_FRAME_BYTES + 2 * 1024 * 1024;
const INTERNAL_CHANNEL_ID: &str = "__coflux-worker";
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(2);
const CALL_LEDGER_LIMIT: usize = 1024;
const CALL_LEDGER_BYTES: usize = 64 * 1024 * 1024;
const PREPARED_LIMIT: usize = 1024;
const PREPARED_BYTES: usize = 32 * 1024 * 1024;
const MAX_PREPARED_FRAME_BYTES: usize = 1024 * 1024;
const OPERATION_REPORT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ID_BYTES: usize = 256;

/// checkpoint 不进入普通 server/control 或 relay queue：同一 session 永远只保留最新值，断线
/// 期间不会累积历史，也不会反压 local terminal stream。
#[derive(Default)]
pub struct CheckpointOutbox {
    pending: Mutex<BTreeMap<String, WsOut>>,
    notify: Notify,
}

impl CheckpointOutbox {
    fn publish(&self, session_id: String, bytes: WsOut) {
        let mut pending = self.pending.lock().unwrap();
        if !pending.contains_key(&session_id) && pending.len() >= CALL_LEDGER_LIMIT {
            pending.pop_first();
        }
        pending.insert(session_id, bytes);
        drop(pending);
        self.notify.notify_one();
    }

    pub async fn recv(&self) -> WsOut {
        loop {
            if let Some((_session_id, bytes)) = self.pending.lock().unwrap().pop_first() {
                return bytes;
            }
            self.notify.notified().await;
        }
    }
}

struct ProductionServices {
    checkpoints: Arc<CheckpointOutbox>,
    state: Arc<Mutex<WorkerState>>,
    cfg: Arc<Config>,
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

struct CallRecord {
    fingerprint: Vec<u8>,
    result: Option<device_envelope::Payload>,
    waiters: Vec<ResponseWaiter>,
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
}

impl Principal {
    fn account_id(&self) -> &str {
        match self {
            Self::Local(value) => &value.account_id,
            Self::Relay { account_id, .. } => account_id,
        }
    }

    fn client_instance_id(&self) -> &str {
        match self {
            Self::Local(value) => &value.client_instance_id,
            Self::Relay { client_instance_id, .. } => client_instance_id,
        }
    }

    fn transport_generation(&self) -> u64 {
        match self {
            Self::Local(value) => value.transport_generation,
            Self::Relay { transport_generation, .. } => *transport_generation,
        }
    }

    fn request_key(&self, request_id: &str) -> String {
        format!("{}\0{}\0{request_id}", self.account_id(), self.client_instance_id())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportKind {
    Local,
    Relay,
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
struct ChannelSink {
    regular: mpsc::Sender<Vec<u8>>,
    priority: mpsc::Sender<Vec<u8>>,
    pending_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    byte_limit: usize,
}

impl ChannelSink {
    fn pair(record_limit: usize, byte_limit: usize) -> (Self, ChannelReceiver) {
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
            },
            ChannelReceiver { regular: regular_rx, priority: priority_rx, pending_bytes, closed },
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
        match self.regular.try_send(bytes) {
            Ok(()) => true,
            Err(_) => {
                self.pending_bytes.fetch_sub(length, Ordering::AcqRel);
                false
            }
        }
    }

    fn try_send_gap(&self, bytes: Vec<u8>) -> bool {
        !self.closed.load(Ordering::Acquire) && self.priority.try_send(bytes).is_ok()
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
                value
            }
            value = self.priority.recv() => value?,
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
                value
            }
            Err(_) => self.priority.try_recv().ok()?,
        };
        (!self.closed.load(Ordering::Acquire)).then_some(bytes)
    }
}

pub struct DeviceRuntime {
    auth: Option<Arc<LocalAuth>>,
    to_supervisor: mpsc::Sender<Vec<u8>>,
    to_server: mpsc::Sender<WsOut>,
    services: Option<ProductionServices>,
    channels: Mutex<HashMap<String, ChannelEntry>>,
    dirty_sessions: Mutex<HashSet<String>>,
    pending_snapshots: Mutex<HashMap<String, String>>,
    pending_catalogs: Mutex<HashSet<String>>,
    prepared: Mutex<HashMap<String, PreparedRecord>>,
    requests: Mutex<CallLedger>,
    operations: Mutex<CallLedger>,
    operation_reports: Mutex<BTreeMap<String, WsOut>>,
    supervisor_online: AtomicBool,
    internal_sequence: AtomicUsize,
    record_limit: usize,
    byte_limit: usize,
}

impl DeviceRuntime {
    #[cfg(test)]
    pub fn new(auth: Option<Arc<LocalAuth>>, to_supervisor: mpsc::Sender<Vec<u8>>, to_server: mpsc::Sender<WsOut>) -> Arc<Self> {
        Self::with_limits(auth, to_supervisor, to_server, None, CHANNEL_QUEUE_RECORDS, CHANNEL_QUEUE_BYTES)
    }

    pub fn production(
        auth: Option<Arc<LocalAuth>>,
        to_supervisor: mpsc::Sender<Vec<u8>>,
        to_server: mpsc::Sender<WsOut>,
        checkpoints: Arc<CheckpointOutbox>,
        state: Arc<Mutex<WorkerState>>,
        cfg: Arc<Config>,
    ) -> Arc<Self> {
        Self::with_limits(
            auth,
            to_supervisor,
            to_server,
            Some(ProductionServices { checkpoints, state, cfg }),
            CHANNEL_QUEUE_RECORDS,
            CHANNEL_QUEUE_BYTES,
        )
    }

    fn with_limits(
        auth: Option<Arc<LocalAuth>>,
        to_supervisor: mpsc::Sender<Vec<u8>>,
        to_server: mpsc::Sender<WsOut>,
        services: Option<ProductionServices>,
        record_limit: usize,
        byte_limit: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            auth,
            to_supervisor,
            to_server,
            services,
            channels: Mutex::new(HashMap::new()),
            dirty_sessions: Mutex::new(HashSet::new()),
            pending_snapshots: Mutex::new(HashMap::new()),
            pending_catalogs: Mutex::new(HashSet::new()),
            prepared: Mutex::new(HashMap::new()),
            requests: Mutex::new(CallLedger::default()),
            operations: Mutex::new(CallLedger::default()),
            operation_reports: Mutex::new(BTreeMap::new()),
            supervisor_online: AtomicBool::new(false),
            internal_sequence: AtomicUsize::new(0),
            record_limit,
            byte_limit,
        })
    }

    pub fn open_local(&self, authenticated: AuthenticatedLocal) -> (String, ChannelReceiver) {
        let mut channels = self.channels.lock().unwrap();
        let channel_id = loop {
            let mut random = [0u8; 16];
            OsRng.fill_bytes(&mut random);
            let candidate = format!("local-{}", hex::encode(random));
            if !channels.contains_key(&candidate) {
                break candidate;
            }
        };
        let (sink, receiver) = ChannelSink::pair(self.record_limit, self.byte_limit);
        channels.insert(
            channel_id.clone(),
            ChannelEntry {
                transport: TransportKind::Local,
                principal: Principal::Local(authenticated.principal),
                sink,
                streams: HashMap::new(),
            },
        );
        (channel_id, receiver)
    }

    /// 注册一条 relay channel 并返回其出向帧接收端（plan 043：帧不再回中心控制 WS，
    /// 由调用方——relay 拨号任务——泵到该 channel 专属的 relay WS）。
    pub fn open_relay(self: &Arc<Self>, dial: &DeviceRelayDial) -> Result<ChannelReceiver, String> {
        validate_relay_dial(dial)?;
        let (sink, receiver) = ChannelSink::pair(self.record_limit, self.byte_limit);
        let mut channels = self.channels.lock().unwrap();
        if channels.contains_key(&dial.channel_id) {
            return Err("relay channelId 已存在".into());
        }
        channels.insert(
            dial.channel_id.clone(),
            ChannelEntry {
                transport: TransportKind::Relay,
                principal: Principal::Relay {
                    account_id: dial.account_id.clone(),
                    client_instance_id: dial.client_instance_id.clone(),
                    transport_generation: dial.transport_generation,
                    scopes: normalized_scopes(dial.scopes.clone())?,
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
        let removed = {
            let mut channels = self.channels.lock().unwrap();
            if channels.get(channel_id).is_some_and(|entry| entry.transport == TransportKind::Relay) {
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
        let removed: Vec<ChannelSink> = {
            let mut channels = self.channels.lock().unwrap();
            let relay_ids: Vec<String> = channels
                .iter()
                .filter(|(_, entry)| entry.transport == TransportKind::Relay)
                .map(|(channel_id, _)| channel_id.clone())
                .collect();
            relay_ids.into_iter().filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink)).collect()
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
            ids.into_iter().filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink)).collect()
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
            ids.into_iter().filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink)).collect()
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
            ids.into_iter().filter_map(|channel_id| channels.remove(&channel_id).map(|entry| entry.sink)).collect()
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
    }

    pub fn supervisor_disconnected(&self) {
        self.supervisor_online.store(false, Ordering::Release);
        let pending: Vec<String> = self.pending_snapshots.lock().unwrap().drain().map(|(_, session_id)| session_id).collect();
        self.dirty_sessions.lock().unwrap().extend(pending);
        self.pending_catalogs.lock().unwrap().clear();
    }

    pub fn mark_session_dirty(&self, session_id: &str) {
        if !session_id.is_empty() {
            self.dirty_sessions.lock().unwrap().insert(session_id.to_string());
        }
    }

    pub async fn run_checkpoint_loop(self: Arc<Self>) {
        let mut interval = tokio::time::interval(CHECKPOINT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if self.services.is_none() || !self.supervisor_online.load(Ordering::Acquire) {
                continue;
            }
            let dirty = std::mem::take(&mut *self.dirty_sessions.lock().unwrap());
            for session_id in dirty {
                if self.pending_snapshots.lock().unwrap().values().any(|pending| pending == &session_id) {
                    self.dirty_sessions.lock().unwrap().insert(session_id);
                    continue;
                }
                let request_id = self.next_internal_id("checkpoint");
                self.pending_snapshots.lock().unwrap().insert(request_id.clone(), session_id.clone());
                let sent = self.send_internal(device_envelope::Payload::SessionSnapshotRequest(DeviceSessionSnapshotRequest {
                    request_id: request_id.clone(),
                    session_id: session_id.clone(),
                }));
                if !sent {
                    self.pending_snapshots.lock().unwrap().remove(&request_id);
                    self.dirty_sessions.lock().unwrap().insert(session_id);
                }
            }
        }
    }

    pub fn request_reconciliation_catalog(&self) {
        let request_id = self.next_internal_id("catalog");
        self.request_catalog(request_id);
    }

    pub fn request_server_catalog(&self, request: DeviceSessionCatalogRequest) {
        self.request_catalog(request.request_id);
    }

    pub fn acknowledge_exits(&self, request: DeviceExitAck) {
        self.send_internal(device_envelope::Payload::ExitAck(request));
    }

    pub fn install_prepared_operation(&self, operation: PreparedDeviceOperation) -> PreparedDeviceOperationInstalled {
        let operation_id = operation.operation_id.clone();
        let result = self.validate_and_install_prepared(operation);
        PreparedDeviceOperationInstalled { operation_id, ok: result.is_ok(), error: result.err() }
    }

    fn validate_and_install_prepared(&self, operation: PreparedDeviceOperation) -> Result<(), String> {
        if !valid_id(&operation.operation_id) || !valid_id(&operation.daemon_id) {
            return Err("prepared operation identity 不能为空".into());
        }
        if !operation.expires_at.is_finite() || operation.expires_at <= epoch_ms() {
            return Err("prepared operation 已过期".into());
        }
        let Some(services) = &self.services else { return Err("Device router 未启用".into()) };
        if services.state.lock().unwrap().daemon_id.as_deref() != Some(operation.daemon_id.as_str()) {
            return Err("prepared operation daemonId 与本机不匹配".into());
        }
        if operation.frame.len() > MAX_PREPARED_FRAME_BYTES {
            return Err("prepared operation frame 超过上限".into());
        }
        let envelope = decode_device_envelope(&operation.frame).ok_or_else(|| "prepared operation frame 畸形".to_string())?;
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION || !envelope.channel_id.is_empty() {
            return Err("prepared operation version/channel 无效".into());
        }
        let payload = envelope.payload.as_ref().ok_or_else(|| "prepared operation payload 为空".to_string())?;
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

    fn request_catalog(&self, request_id: String) {
        if !valid_id(&request_id) || !self.supervisor_online.load(Ordering::Acquire) {
            return;
        }
        {
            let mut pending = self.pending_catalogs.lock().unwrap();
            if !pending.contains(&request_id) && pending.len() >= CALL_LEDGER_LIMIT {
                return;
            }
            pending.insert(request_id.clone());
        }
        if !self.send_internal(device_envelope::Payload::SessionCatalogRequest(DeviceSessionCatalogRequest { request_id: request_id.clone() })) {
            self.pending_catalogs.lock().unwrap().remove(&request_id);
        }
    }

    fn next_internal_id(&self, kind: &str) -> String {
        let sequence = self.internal_sequence.fetch_add(1, Ordering::Relaxed).saturating_add(1);
        format!("worker-{kind}-{}-{sequence}", std::process::id())
    }

    fn send_internal(&self, payload: device_envelope::Payload) -> bool {
        let envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: INTERNAL_CHANNEL_ID.to_string(),
            payload: Some(payload),
        };
        let frame = encode_frame(&DataFrame::Device {
            channel_id: INTERNAL_CHANNEL_ID.to_string(),
            data: encode_device_envelope(&envelope),
        });
        self.to_supervisor.try_send(write_record(&frame)).is_ok()
    }

    pub fn handle_client_frame(self: &Arc<Self>, channel_id: &str, bytes: &[u8]) {
        if bytes.len() > MAX_DEVICE_FRAME_BYTES {
            self.send_error(channel_id, None, "frame_too_large", "Device frame 超过上限");
            return;
        }
        let Some(envelope) = decode_device_envelope(bytes) else {
            self.send_error(channel_id, None, "malformed_envelope", "DeviceEnvelope 解码失败");
            return;
        };
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION {
            self.send_error(channel_id, None, "version_mismatch", "Device protocol version 不兼容");
            return;
        }
        if envelope.channel_id != channel_id {
            self.send_error(channel_id, None, "channel_mismatch", "inner/transport channelId 不一致");
            return;
        }
        let Some(payload) = envelope.payload.as_ref() else {
            self.send_error(channel_id, None, "empty_payload", "DeviceEnvelope payload 为空");
            return;
        };

        let principal = {
            let channels = self.channels.lock().unwrap();
            let Some(entry) = channels.get(channel_id) else { return };
            entry.principal.clone()
        };
        let scopes = self.effective_scopes(&principal);
        if scopes.is_empty() {
            self.close_channel(channel_id);
            return;
        }
        if let Some(required) = required_scope(payload) {
            if !scopes.contains(&(required as i32)) {
                self.send_error(channel_id, request_id(payload), "scope_denied", "当前 grant/lease 不允许该 Device RPC");
                return;
            }
        } else {
            self.send_error(channel_id, request_id(payload), "unsupported_payload", "该 Device payload 不能由 client 发起");
            return;
        }
        if let device_envelope::Payload::SessionAttach(attach) = payload {
            if attach.client_instance_id != principal.client_instance_id() || attach.transport_generation != principal.transport_generation() {
                self.send_error(channel_id, Some(attach.request_id.clone()), "principal_mismatch", "attach identity 与认证 channel 不匹配");
                return;
            }
        }
        if matches!(payload, device_envelope::Payload::SessionStop(stop) if !valid_id(&stop.operation_id)) {
            self.send_error(channel_id, request_id(payload), "invalid_operation_id", "operationId 无效或过长");
            return;
        }
        let request_id = request_id(payload);
        if request_id.as_deref().is_some_and(|request_id| !valid_id(request_id)) {
            self.send_error(channel_id, request_id, "invalid_request_id", "requestId 无效或过长");
            return;
        }

        if prepared_operation_id(payload).is_some() {
            if let Err(error) = self.authorize_prepared(&envelope) {
                self.send_error(channel_id, request_id, "prepared_operation_denied", &error);
                return;
            }
        }

        if routed_to_sessiond(payload) {
            let frame = encode_frame(&DataFrame::Device { channel_id: channel_id.to_string(), data: encode_device_envelope(&envelope) });
            if self.to_supervisor.try_send(write_record(&frame)).is_err() {
                self.send_error(channel_id, request_id, "supervisor_busy", "sessiond 请求队列已满，请重试");
            }
        } else {
            self.dispatch_worker_request(channel_id.to_string(), principal, envelope);
        }
    }

    pub fn handle_relay_frame(self: &Arc<Self>, channel_id: &str, bytes: &[u8]) -> bool {
        let relay = self
            .channels
            .lock()
            .unwrap()
            .get(channel_id)
            .is_some_and(|entry| entry.transport == TransportKind::Relay);
        if relay {
            self.handle_client_frame(channel_id, bytes);
        }
        relay
    }

    fn authorize_prepared(&self, envelope: &DeviceEnvelope) -> Result<(), String> {
        let payload = envelope.payload.as_ref().ok_or_else(|| "Device payload 为空".to_string())?;
        let operation_id = prepared_operation_id(payload).ok_or_else(|| "该操作不支持 prepared template".to_string())?;
        if operation_id.is_empty() {
            return Err("operationId 不能为空".into());
        }
        let mut canonical = envelope.clone();
        canonical.channel_id.clear();
        let canonical = encode_device_envelope(&canonical);
        let now = epoch_ms();
        let daemon_id = self.services.as_ref().and_then(|services| services.state.lock().unwrap().daemon_id.clone());
        let mut prepared = self.prepared.lock().unwrap();
        prepared.retain(|_, record| record.expires_at > now);
        let Some(record) = prepared.get(operation_id) else { return Err("operation 未由中心 prepare 或已过期".into()) };
        if daemon_id.as_deref() != Some(record.daemon_id.as_str()) || record.frame != canonical {
            return Err("operation payload 与中心安装模板不一致".into());
        }
        Ok(())
    }

    fn effective_scopes(&self, principal: &Principal) -> Vec<i32> {
        match principal {
            Principal::Local(principal) => {
                let daemon_matches = self
                    .services
                    .as_ref()
                    .is_none_or(|services| services.state.lock().unwrap().daemon_id.as_deref() == Some(principal.daemon_id.as_str()));
                if daemon_matches {
                    self.auth.as_ref().map_or_else(Vec::new, |auth| auth.effective_scopes(principal))
                } else {
                    Vec::new()
                }
            }
            Principal::Relay { scopes, .. } => scopes.clone(),
        }
    }

    fn response_scope(&self, payload: &device_envelope::Payload) -> Option<DeviceScope> {
        if let device_envelope::Payload::OperationAck(ack) = payload {
            return if self.prepared.lock().unwrap().contains_key(&ack.operation_id) {
                Some(DeviceScope::Lifecycle)
            } else {
                Some(DeviceScope::SessionControl)
            };
        }
        response_required_scope(payload)
    }

    fn dispatch_worker_request(self: &Arc<Self>, channel_id: String, principal: Principal, envelope: DeviceEnvelope) {
        let Some(payload) = envelope.payload.clone() else { return };
        let operation_id = worker_operation_id(&payload).map(str::to_string);
        if operation_id.as_deref().is_some_and(|operation_id| !valid_id(operation_id)) {
            self.send_error(&channel_id, request_id(&payload), "invalid_operation_id", "operationId 无效或过长");
            return;
        }
        let response_request_id = request_id(&payload).or_else(|| operation_id.clone()).unwrap_or_default();
        if response_request_id.is_empty() {
            self.send_error(&channel_id, None, "invalid_request_id", "requestId 无效或过长");
            return;
        }
        let (key, operation) = match &operation_id {
            Some(operation_id) => (operation_id.clone(), true),
            None => (principal.request_key(&response_request_id), false),
        };
        let fingerprint = call_fingerprint(&envelope, operation);
        let waiter = ResponseWaiter { channel_id: channel_id.clone(), request_id: response_request_id.clone() };
        let start = {
            let ledger = if operation { &self.operations } else { &self.requests };
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
                let code = if operation { "operation_collision" } else { "request_collision" };
                self.send_error(&channel_id, Some(response_request_id), code, "相同 ID 携带了不同 payload");
                return;
            }
            Err(CallStartError::Full) => {
                self.send_error(&channel_id, Some(response_request_id), "router_busy", "Device 去重队列已满，请稍后重试");
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

    async fn execute_worker_payload(&self, payload: device_envelope::Payload) -> device_envelope::Payload {
        let Some(services) = &self.services else {
            return device_error(request_id(&payload), "router_unavailable", "Device RPC router 未启用");
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
                let result = crate::git::remove_worktree(&request.repo_path, &request.worktree_path).await;
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
                    return device_error(Some(request.request_id), "workspace_unknown", "workspaceId 不属于本 daemon 当前清单");
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
                        return device_error(Some(request.request_id), "invalid_workspace", "browseHome 请求的 workspaceId 必须为空");
                    }
                    match std::env::var("HOME") {
                        Ok(home) if !home.is_empty() => home,
                        _ => return device_error(Some(request.request_id), "home_unavailable", "daemon 用户 HOME 不可用"),
                    }
                } else {
                    let Some(root) = workspace_root(&services.state, &request.workspace_id) else {
                        return device_error(Some(request.request_id), "workspace_unknown", "workspaceId 不属于本 daemon 当前清单");
                    };
                    root
                };
                let (ok, entries, error, path) = crate::ops::list_dir(&root, &request.path).await;
                device_envelope::Payload::FsListed(wire::FsListed { request_id: request.request_id, ok, entries, error, path })
            }
            device_envelope::Payload::FsRead(request) => {
                let Some(root) = workspace_root(&services.state, &request.workspace_id) else {
                    return device_error(Some(request.request_id), "workspace_unknown", "workspaceId 不属于本 daemon 当前清单");
                };
                let (ok, content, error) = crate::ops::read_file_text(&root, &request.path).await;
                device_envelope::Payload::FsReadResult(wire::FsReadResult { request_id: request.request_id, ok, content, error })
            }
            device_envelope::Payload::FsWrite(request) => {
                let Some(root) = workspace_root(&services.state, &request.workspace_id) else {
                    return device_error(Some(request.request_id), "workspace_unknown", "workspaceId 不属于本 daemon 当前清单");
                };
                let (ok, path, error) = crate::ops::write_file(&root, &request.path, &request.data, request.temp).await;
                device_envelope::Payload::FsWriteResult(wire::FsWriteResult { request_id: request.request_id, ok, path, error })
            }
            device_envelope::Payload::PortsRequest(request) => {
                let alive = services.state.lock().unwrap().alive.clone();
                let sessions = tokio::task::spawn_blocking(move || crate::build_ports_update(&alive)).await.unwrap_or_default();
                device_envelope::Payload::PortsResult(wire::DevicePortsResult { request_id: request.request_id, sessions })
            }
            // 心跳：纯 echo，不读任何状态、不做任何副作用——往返时间才近似纯链路延迟。
            device_envelope::Payload::Ping(request) => {
                device_envelope::Payload::Pong(wire::DevicePong { request_id: request.request_id })
            }
            other => device_error(request_id(&other), "unsupported_payload", "该 Device payload 不属于 worker RPC router"),
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
            result = device_error(request_id(&result), "response_too_large", "Device response 超过上限");
        }
        let waiters = {
            let ledger = if operation { &self.operations } else { &self.requests };
            let mut ledger = ledger.lock().unwrap();
            let result_bytes = encode_device_envelope(&DeviceEnvelope {
                protocol_version: DEVICE_PROTOCOL_VERSION,
                channel_id: String::new(),
                payload: Some(result.clone()),
            })
            .len();
            while result_bytes > CALL_LEDGER_BYTES.saturating_sub(ledger.bytes) {
                let completed = ledger
                    .entries
                    .iter()
                    .find(|(entry_key, record)| entry_key.as_str() != key.as_str() && record.result.is_some())
                    .map(|(entry_key, record)| (entry_key.clone(), call_record_bytes(record)));
                let Some((completed, bytes)) = completed else { break };
                ledger.entries.remove(&completed);
                ledger.bytes = ledger.bytes.saturating_sub(bytes);
            }
            let Some(record) = ledger.entries.get_mut(&key) else { return };
            record.result = Some(result.clone());
            let waiters = std::mem::take(&mut record.waiters);
            ledger.bytes = ledger.bytes.saturating_add(result_bytes);
            waiters
        };
        for waiter in waiters {
            let mut response = result.clone();
            set_response_request_id(&mut response, &waiter.request_id);
            self.send_payload(&waiter.channel_id, response);
        }
        if let Some(operation_id) = operation_id {
            self.report_operation(&operation_id, &result);
        }
    }

    fn send_payload(&self, channel_id: &str, payload: device_envelope::Payload) {
        let principal = self.channels.lock().unwrap().get(channel_id).map(|entry| entry.principal.clone());
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
            self.send_error(channel_id, request_id(envelope.payload.as_ref().unwrap()), "response_too_large", "Device response 超过上限");
            return;
        }
        let mut channels = self.channels.lock().unwrap();
        let delivered = channels.get(channel_id).is_some_and(|entry| entry.sink.try_send(bytes));
        if !delivered {
            if let Some(entry) = channels.remove(channel_id) {
                entry.sink.close();
            }
        }
    }

    fn report_operation(&self, operation_id: &str, result: &device_envelope::Payload) {
        let Some(services) = &self.services else { return };
        let Some(daemon_id) = services.state.lock().unwrap().daemon_id.clone() else { return };
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
        while reports.len() >= CALL_LEDGER_LIMIT || bytes.len() > OPERATION_REPORT_BYTES.saturating_sub(pending_bytes) {
            let Some((_operation_id, removed)) = reports.pop_first() else { break };
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
        if let Some(services) = &self.services {
            let sessions: Vec<String> = services.state.lock().unwrap().alive.keys().cloned().collect();
            self.dirty_sessions.lock().unwrap().extend(sessions);
        }
        self.request_reconciliation_catalog();
    }

    pub fn deliver_from_sessiond(&self, channel_id: &str, bytes: &[u8]) {
        let Some(envelope) = decode_device_envelope(bytes) else { return };
        if envelope.protocol_version != DEVICE_PROTOCOL_VERSION || envelope.channel_id != channel_id {
            return;
        }
        let Some(payload) = envelope.payload.as_ref() else { return };
        if channel_id == INTERNAL_CHANNEL_ID {
            self.handle_internal_response(payload);
            return;
        }
        if let device_envelope::Payload::OperationAck(ack) = payload {
            if !ack.operation_id.is_empty() {
                self.report_operation(&ack.operation_id, payload);
            }
        }
        let principal = self.channels.lock().unwrap().get(channel_id).map(|entry| entry.principal.clone());
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
        let Some(entry) = channels.get_mut(channel_id) else { return };

        match payload {
            device_envelope::Payload::SessionAttached(attached) => {
                if entry.sink.try_send(bytes.to_vec()) {
                    entry.streams.insert(
                        attached.session_id.clone(),
                        StreamCursor { next_seq: Some(attached.snapshot_seq.saturating_add(1)), gapped: false },
                    );
                } else {
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
                    && output.to_seq == output.from_seq.saturating_add(output.data.len().saturating_sub(1) as u64);
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
                entry.streams.entry(gap.session_id.clone()).or_default().gapped = true;
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
                if !self.pending_catalogs.lock().unwrap().remove(&catalog.request_id) {
                    return;
                }
                if let Some(services) = &self.services {
                    self.dirty_sessions.lock().unwrap().extend(catalog.sessions.iter().map(|session| session.session_id.clone()));
                    services.state.lock().unwrap().alive = catalog
                        .sessions
                        .iter()
                        .map(|session| (session.session_id.clone(), (session.task_id.clone(), session.pid)))
                        .collect();
                    let payload = daemon_to_server::Payload::SessionCatalog(DeviceSessionCatalog {
                        request_id: catalog.request_id.clone(),
                        sessions: catalog.sessions.clone(),
                        exits: catalog.exits.clone(),
                    });
                    let bytes = coflux_protocol::wire::DaemonToServer { payload: Some(payload) }.encode_to_vec();
                    let _ = self.to_server.try_send(bytes);
                }
            }
            device_envelope::Payload::SessionSnapshot(snapshot) => {
                let Some(expected_session) = self.pending_snapshots.lock().unwrap().remove(&snapshot.request_id) else { return };
                if snapshot.session_id != expected_session || snapshot.ansi_snapshot.len() > MAX_SESSION_CHECKPOINT_BYTES {
                    return;
                }
                let Some(services) = &self.services else { return };
                let task_id = services
                    .state
                    .lock()
                    .unwrap()
                    .alive
                    .get(&snapshot.session_id)
                    .map(|(task_id, _pid)| task_id.clone());
                let Some(task_id) = task_id else { return };
                let checkpoint = SessionCheckpoint {
                    session_id: snapshot.session_id.clone(),
                    task_id,
                    snapshot_seq: snapshot.snapshot_seq,
                    ansi_snapshot: snapshot.ansi_snapshot.clone(),
                    cols: snapshot.cols,
                    rows: snapshot.rows,
                    captured_at: epoch_ms(),
                };
                let payload = daemon_to_server::Payload::SessionCheckpoint(checkpoint);
                services.checkpoints.publish(
                    snapshot.session_id.clone(),
                    coflux_protocol::wire::DaemonToServer { payload: Some(payload) }.encode_to_vec(),
                );
            }
            device_envelope::Payload::Error(error) => {
                if let Some(request_id) = &error.request_id {
                    self.pending_snapshots.lock().unwrap().remove(request_id);
                    self.pending_catalogs.lock().unwrap().remove(request_id);
                }
            }
            _ => {}
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
    if let Some(record) = ledger.entries.get_mut(&key) {
        if record.fingerprint != fingerprint {
            return Err(CallStartError::Collision);
        }
        if let Some(result) = &record.result {
            return Ok(CallStart::Cached(result.clone()));
        }
        if !record
            .waiters
            .iter()
            .any(|existing| existing.channel_id == waiter.channel_id && existing.request_id == waiter.request_id)
        {
            record.waiters.push(waiter);
        }
        return Ok(CallStart::Pending);
    }
    while ledger.entries.len() >= CALL_LEDGER_LIMIT || fingerprint.len() > CALL_LEDGER_BYTES.saturating_sub(ledger.bytes) {
        let completed = ledger
            .entries
            .iter()
            .find(|(_, record)| record.result.is_some())
            .map(|(key, record)| (key.clone(), call_record_bytes(record)));
        let Some((completed, bytes)) = completed else { break };
        ledger.entries.remove(&completed);
        ledger.bytes = ledger.bytes.saturating_sub(bytes);
    }
    if ledger.entries.len() >= CALL_LEDGER_LIMIT || fingerprint.len() > CALL_LEDGER_BYTES.saturating_sub(ledger.bytes) {
        return Err(CallStartError::Full);
    }
    ledger.bytes = ledger.bytes.saturating_add(fingerprint.len());
    ledger.entries.insert(key, CallRecord { fingerprint, result: None, waiters: vec![waiter] });
    Ok(CallStart::Execute)
}

fn call_record_bytes(record: &CallRecord) -> usize {
    record.fingerprint.len()
        + record.result.as_ref().map_or(0, |payload| {
            encode_device_envelope(&DeviceEnvelope {
                protocol_version: DEVICE_PROTOCOL_VERSION,
                channel_id: String::new(),
                payload: Some(payload.clone()),
            })
            .len()
        })
}

fn workspace_root(state: &Arc<Mutex<WorkerState>>, workspace_id: &str) -> Option<String> {
    if workspace_id.is_empty() {
        return None;
    }
    state.lock().unwrap().workspaces.get(workspace_id).map(|(path, _default_branch)| path.clone())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES && !value.bytes().any(|byte| byte == 0 || byte.is_ascii_control())
}

fn device_error(request_id: Option<String>, code: &str, message: &str) -> device_envelope::Payload {
    device_envelope::Payload::Error(DeviceError { request_id, code: code.to_string(), message: message.to_string() })
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
        device_envelope::Payload::SessionCatalog(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::SessionAttached(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::SessionSnapshot(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::OperationAck(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::ProjectValidated(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::WorktreeAdded(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::ExecResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::FsListed(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::FsReadResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::FsWriteResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::PortsResult(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::Pong(value) => value.request_id = request_id.to_string(),
        device_envelope::Payload::Error(value) => value.request_id = (!request_id.is_empty()).then(|| request_id.to_string()),
        _ => {}
    }
}

fn operation_result_summary(payload: &device_envelope::Payload) -> (bool, Option<String>, Option<String>, Option<i32>) {
    match payload {
        device_envelope::Payload::ProjectValidated(value) => (value.ok, value.error.clone(), None, None),
        device_envelope::Payload::WorktreeAdded(value) => (value.ok, value.error.clone(), None, None),
        device_envelope::Payload::OperationAck(value) => (value.ok, value.error.clone(), value.session_id.clone(), value.pid),
        device_envelope::Payload::ExecResult(value) => (value.ok, value.error.clone(), None, None),
        device_envelope::Payload::FsWriteResult(value) => (value.ok, value.error.clone(), None, None),
        device_envelope::Payload::Error(value) => (false, Some(value.message.clone()), None, None),
        _ => (true, None, None, None),
    }
}

fn prepared_task_id(prepared: &HashMap<String, PreparedRecord>, operation_id: &str) -> Option<String> {
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

fn normalized_scopes(mut scopes: Vec<i32>) -> Result<Vec<i32>, String> {
    if scopes.is_empty()
        || scopes.len() > 4
        || scopes
            .iter()
            .any(|scope| !matches!(DeviceScope::try_from(*scope), Ok(DeviceScope::SessionRead | DeviceScope::SessionControl | DeviceScope::Rpc | DeviceScope::Lifecycle)))
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
        device_envelope::Payload::ProjectValidated(_) | device_envelope::Payload::WorktreeAdded(_) => {
            Some(DeviceScope::Lifecycle)
        }
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
        match pending.compare_exchange_weak(current, current + length, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use coflux_protocol::wire::{
        DeviceExecRun, DevicePortsRequest, DevicePtyInputAck, DevicePtyOutput, DeviceSessionAttached,
        DeviceSessionCatalogRequest, DeviceSessionCreate, LocalBrowserGrant, OnlineDeviceLease,
    };
    use p256::ecdsa::SigningKey;

    struct TestRuntime {
        home: String,
        auth: Arc<LocalAuth>,
        runtime: Arc<DeviceRuntime>,
        state: Arc<Mutex<WorkerState>>,
        checkpoints: Arc<CheckpointOutbox>,
        local_id: String,
        local_rx: ChannelReceiver,
        relay_id: String,
        relay_rx: ChannelReceiver,
        from_server: mpsc::Receiver<WsOut>,
        from_supervisor: mpsc::Receiver<Vec<u8>>,
    }

    fn test_runtime() -> TestRuntime {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let home_path = std::env::temp_dir().join(format!("coflux-device-router-{}-{}", std::process::id(), hex::encode(random)));
        std::fs::create_dir_all(&home_path).unwrap();
        let home = home_path.to_string_lossy().into_owned();
        let auth = Arc::new(LocalAuth::load_or_create(&home).unwrap());
        auth.configure_origins(vec!["https://p.coflux.dev".into()]).unwrap();
        let browser_key = SigningKey::random(&mut OsRng);
        let browser_public_key = browser_key.verifying_key().to_encoded_point(false).as_bytes().to_vec();
        auth.install_grant(
            LocalBrowserGrant {
                grant_id: "grant-1".into(),
                account_id: "account-1".into(),
                daemon_id: "daemon-1".into(),
                origin: "https://p.coflux.dev".into(),
                public_key_sec1: browser_public_key.clone(),
                offline_scopes: vec![DeviceScope::SessionRead as i32, DeviceScope::SessionControl as i32],
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
            authed: true,
            sup_synced: true,
            daemon_id: Some("daemon-1".into()),
            gateway_port: Some(8788),
            alive: HashMap::new(),
            credentials: None,
            pending_auth_expires_at: None,
            last_reported_ports: Vec::new(),
            last_reported_agents: Vec::new(),
            hook_states: HashMap::new(),
            workspaces,
            last_branches: HashMap::new(),
            last_diffs: HashMap::new(),
            conn_state: crate::conn_state::ConnState::new(&home),
        }));
        let (to_supervisor, from_supervisor) = mpsc::channel(32);
        let (to_server, from_server) = mpsc::channel(32);
        let checkpoints = Arc::new(CheckpointOutbox::default());
        let runtime = DeviceRuntime::production(
            Some(auth.clone()),
            to_supervisor,
            to_server,
            checkpoints.clone(),
            state.clone(),
            cfg,
        );
        runtime.supervisor_online.store(true, Ordering::Release);
        let (local_id, local_rx) = runtime.open_local(AuthenticatedLocal {
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
        });
        let relay_id = "relay-1".to_string();
        let relay_rx = runtime
            .open_relay(&DeviceRelayDial {
                channel_id: relay_id.clone(),
                relay_url: "ws://127.0.0.1:1/v1/pipe?token=test.test".into(),
                account_id: "account-1".into(),
                client_instance_id: "client-1".into(),
                transport_generation: 2,
                scopes: vec![DeviceScope::SessionRead as i32, DeviceScope::SessionControl as i32, DeviceScope::Rpc as i32],
                protocol_version: DEVICE_PROTOCOL_VERSION,
            })
            .unwrap();
        TestRuntime {
            home,
            auth,
            runtime,
            state,
            checkpoints,
            local_id,
            local_rx,
            relay_id,
            relay_rx,
            from_server,
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

    /// plan 043：relay channel 出向帧就是 ChannelReceiver 里的原始 DeviceEnvelope bytes
    /// （由拨号任务直接泵进该 channel 的 relay WS），不再有 DaemonToServer wrap。
    async fn relay_envelope(receiver: &mut ChannelReceiver) -> DeviceEnvelope {
        let bytes = tokio::time::timeout(Duration::from_secs(2), receiver.recv()).await.unwrap().unwrap();
        decode_device_envelope(&bytes).unwrap()
    }

    #[test]
    fn device_router_scope_matrix_keeps_offline_lifecycle_and_rpc_closed() {
        assert_eq!(
            required_scope(&device_envelope::Payload::SessionCatalogRequest(Default::default())),
            Some(DeviceScope::SessionRead)
        );
        assert_eq!(required_scope(&device_envelope::Payload::PtyInput(Default::default())), Some(DeviceScope::SessionControl));
        assert_eq!(required_scope(&device_envelope::Payload::ExecRun(Default::default())), Some(DeviceScope::Rpc));
        assert_eq!(required_scope(&device_envelope::Payload::SessionCreate(Default::default())), Some(DeviceScope::Lifecycle));
        assert_eq!(required_scope(&device_envelope::Payload::PtyOutput(Default::default())), None);
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
        fixture.runtime.deliver_from_sessiond(&fixture.local_id, &encode_device_envelope(&local_ack));
        let local = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv()).await.unwrap().unwrap();
        assert!(matches!(
            decode_device_envelope(&local).unwrap().payload,
            Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                ref session_id,
                applied_through_seq: 7,
            })) if session_id == "session-local"
        ));
        assert!(fixture.relay_rx.try_recv().is_none(), "local ACK must not leak to relay channels");

        let relay_ack = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: fixture.relay_id.clone(),
            payload: Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                session_id: "session-relay".into(),
                applied_through_seq: 9,
            })),
        };
        fixture.runtime.deliver_from_sessiond(&fixture.relay_id, &encode_device_envelope(&relay_ack));
        let relay = relay_envelope(&mut fixture.relay_rx).await;
        assert!(matches!(
            relay.payload,
            Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
                ref session_id,
                applied_through_seq: 9,
            })) if session_id == "session-relay"
        ));
        assert!(tokio::time::timeout(Duration::from_millis(20), fixture.local_rx.recv()).await.is_err());

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn device_router_local_and_relay_share_request_dedup_and_response_correlation() {
        let mut fixture = test_runtime();
        let request = device_envelope::Payload::PortsRequest(DevicePortsRequest { request_id: "ports-shared".into() });
        fixture.runtime.handle_client_frame(&fixture.local_id, &request_envelope(&fixture.local_id, request.clone()));
        fixture.runtime.handle_client_frame(&fixture.relay_id, &request_envelope(&fixture.relay_id, request));

        let local = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv()).await.unwrap().unwrap();
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
        fixture.runtime.handle_client_frame(&fixture.relay_id, &request_envelope(&fixture.relay_id, collision));
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
        let local = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv()).await.unwrap().unwrap();
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
        assert_eq!(std::fs::read_to_string(format!("{}/marker", fixture.home)).unwrap(), "x");

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
        assert_eq!(std::fs::read_to_string(format!("{}/marker", fixture.home)).unwrap(), "x");

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn device_router_offline_local_downgrades_but_session_scope_stays_available() {
        let mut fixture = test_runtime();
        fixture.auth.set_server_online(false);
        fixture.runtime.close_relays();
        let ports = device_envelope::Payload::PortsRequest(DevicePortsRequest { request_id: "ports-offline".into() });
        fixture.runtime.handle_client_frame(&fixture.local_id, &request_envelope(&fixture.local_id, ports));
        let denied = tokio::time::timeout(Duration::from_secs(2), fixture.local_rx.recv()).await.unwrap().unwrap();
        let denied = decode_device_envelope(&denied).unwrap();
        assert!(matches!(
            denied.payload,
            Some(device_envelope::Payload::Error(DeviceError { ref code, .. })) if code == "scope_denied"
        ));

        let catalog = device_envelope::Payload::SessionCatalogRequest(DeviceSessionCatalogRequest { request_id: "catalog-offline".into() });
        fixture.runtime.handle_client_frame(&fixture.local_id, &request_envelope(&fixture.local_id, catalog));
        let record = tokio::time::timeout(Duration::from_secs(2), fixture.from_supervisor.recv()).await.unwrap().unwrap();
        let mut parser = coflux_protocol::RecordParser::new();
        let mut records = Vec::new();
        parser.push(&record, |record| records.push(record.to_vec()));
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
            payload: Some(device_envelope::Payload::SessionCatalog(DeviceSessionCatalog {
                request_id: request_id.into(),
                sessions: Vec::new(),
                exits: Vec::new(),
            })),
        };
        fixture.runtime.deliver_from_sessiond(&fixture.local_id, &encode_device_envelope(&catalog("before-revoke")));
        assert!(fixture.local_rx.recv().await.is_some());
        fixture.runtime.deliver_from_sessiond(&fixture.local_id, &encode_device_envelope(&catalog("queued-before-revoke")));
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
            payload: Some(device_envelope::Payload::SessionCreate(DeviceSessionCreate {
                request_id: "create-1".into(),
                operation_id: "prepared-1".into(),
                session_id: "session-1".into(),
                task_id: "task-1".into(),
                cwd: fixture.home.clone(),
                shell: None,
                cols: 80,
                rows: 24,
            })),
        };
        let installed = fixture.runtime.install_prepared_operation(PreparedDeviceOperation {
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
        assert!(!fixture
            .runtime
            .install_prepared_operation(PreparedDeviceOperation {
                operation_id: "expired".into(),
                daemon_id: "daemon-1".into(),
                frame: encode_device_envelope(&template),
                expires_at: epoch_ms() - 1.0,
            })
            .ok);
        assert!(!fixture
            .runtime
            .install_prepared_operation(PreparedDeviceOperation {
                operation_id: "wrong-daemon".into(),
                daemon_id: "daemon-other".into(),
                frame: encode_device_envelope(&template),
                expires_at: epoch_ms() + 60_000.0,
            })
            .ok);
        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[tokio::test]
    async fn transport_backpressure_channel_queue_marks_gap_without_blocking_other_channels() {
        let (sink_a, mut receiver_a) = ChannelSink::pair(1, 1024);
        let (sink_b, mut receiver_b) = ChannelSink::pair(1, 1024);
        assert!(sink_a.try_send(vec![1]));
        assert!(!sink_a.try_send(vec![2]));
        assert!(sink_a.try_send_gap(vec![9]));
        assert!(sink_b.try_send(vec![3]));

        assert_eq!(receiver_a.recv().await, Some(vec![1]));
        assert_eq!(receiver_a.recv().await, Some(vec![9]));
        assert_eq!(receiver_b.recv().await, Some(vec![3]));
    }

    #[tokio::test]
    async fn transport_backpressure_checkpoint_outbox_coalesces_latest_per_session() {
        let outbox = CheckpointOutbox::default();
        outbox.publish("session-1".into(), vec![1]);
        outbox.publish("session-1".into(), vec![2]);
        outbox.publish("session-2".into(), vec![3]);
        assert_eq!(outbox.recv().await, vec![2]);
        assert_eq!(outbox.recv().await, vec![3]);
    }

    #[tokio::test]
    async fn transport_backpressure_sessiond_catalog_and_checkpoint_reconcile_through_side_channels() {
        let mut fixture = test_runtime();
        fixture.runtime.pending_catalogs.lock().unwrap().insert("catalog-reconcile".into());
        let catalog = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: INTERNAL_CHANNEL_ID.into(),
            payload: Some(device_envelope::Payload::SessionCatalog(DeviceSessionCatalog {
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
            })),
        };
        fixture.runtime.deliver_from_sessiond(INTERNAL_CHANNEL_ID, &encode_device_envelope(&catalog));
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
        let catalog_up = tokio::time::timeout(Duration::from_secs(2), fixture.from_server.recv()).await.unwrap().unwrap();
        assert!(matches!(
            wire::DaemonToServer::decode(catalog_up.as_slice()).unwrap().payload,
            Some(daemon_to_server::Payload::SessionCatalog(DeviceSessionCatalog { ref request_id, .. })) if request_id == "catalog-reconcile"
        ));

        fixture.runtime.pending_snapshots.lock().unwrap().insert("snapshot-1".into(), "session-1".into());
        let snapshot = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: INTERNAL_CHANNEL_ID.into(),
            payload: Some(device_envelope::Payload::SessionSnapshot(wire::DeviceSessionSnapshot {
                request_id: "snapshot-1".into(),
                session_id: "session-1".into(),
                snapshot_seq: 9,
                ansi_snapshot: b"\x1bcursor".to_vec(),
                cols: 80,
                rows: 24,
            })),
        };
        fixture.runtime.deliver_from_sessiond(INTERNAL_CHANNEL_ID, &encode_device_envelope(&snapshot));
        let checkpoint = fixture.checkpoints.recv().await;
        assert!(matches!(
            wire::DaemonToServer::decode(checkpoint.as_slice()).unwrap().payload,
            Some(daemon_to_server::Payload::SessionCheckpoint(SessionCheckpoint { snapshot_seq: 9, ref session_id, .. }))
                if session_id == "session-1"
        ));

        fixture.runtime.close_channel(&fixture.local_id);
        fixture.runtime.close_relays();
        let _ = std::fs::remove_dir_all(&fixture.home);
    }

    #[test]
    fn transport_backpressure_detects_output_sequence_gap() {
        let mut cursor = StreamCursor { next_seq: Some(4), gapped: false };
        let output = DevicePtyOutput { session_id: "session-1".into(), from_seq: 5, to_seq: 6, data: b"xx".to_vec() };
        let contiguous = cursor.next_seq.is_none_or(|next| next == output.from_seq)
            && output.to_seq == output.from_seq.saturating_add(output.data.len().saturating_sub(1) as u64);
        assert!(!contiguous);
        cursor.gapped = true;
        assert!(cursor.gapped);

        let attached = DeviceSessionAttached { snapshot_seq: 6, session_id: "session-1".into(), ..Default::default() };
        cursor = StreamCursor { next_seq: Some(attached.snapshot_seq + 1), gapped: false };
        assert_eq!(cursor.next_seq, Some(7));
        assert!(!cursor.gapped);
    }
}
