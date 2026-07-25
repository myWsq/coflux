//! PTY 会话生命周期（活在 supervisor）。每个 session 用独立 mutex 串行化 PTY、VT、sequence
//! 与 attach；worker/中心只是可丢失并重建的 transport。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use coflux_protocol::wire::{
    device_envelope, DeviceEnvelope, DeviceError, DevicePtyGap, DevicePtyOutput, DeviceSessionAttach, DeviceSessionAttached, DeviceSessionCatalog,
    DeviceSessionCatalogRequest, DeviceSessionExitTombstone, DeviceSessionInfo, DeviceSessionSnapshot, DeviceSessionSnapshotRequest,
};
use coflux_protocol::{
    decode_device_envelope, encode_device_envelope, encode_frame, write_record, DataFrame, SessionInfo, SupervisorToWorker,
    DEVICE_PROTOCOL_VERSION, MAX_TERMINAL_DIMENSION, MIN_TERMINAL_DIMENSION,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::sessiond::SessionState;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    task_id: String,
    cwd: String,
    pid: i32,
    started_at: f64,
    state: SessionState,
}

type SessionHandle = Arc<Mutex<Session>>;

/// 迁移期保留的 legacy 背压闸；milestone 4 会移除其对 PTY reader 的控制。
pub type Pause = Arc<(Mutex<bool>, Condvar)>;

pub struct Sessions {
    map: Mutex<HashMap<String, SessionHandle>>,
    outbound: Mutex<Sender<Vec<u8>>>,
    pause: Pause,
    shell: String,
    home: String,
    history_line_limit: usize,
    tombstones: Mutex<Vec<DeviceSessionExitTombstone>>,
}

impl Sessions {
    pub fn new(outbound: Sender<Vec<u8>>, pause: Pause, shell: String, home: String, history_line_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            map: Mutex::new(HashMap::new()),
            outbound: Mutex::new(outbound),
            pause,
            shell,
            home,
            history_line_limit,
            tombstones: Mutex::new(Vec::new()),
        })
    }

    fn send_record(&self, record: Vec<u8>) -> bool {
        self.outbound.lock().unwrap().send(record).is_ok()
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
        let frame = encode_frame(&DataFrame::Device { channel_id: channel_id.to_string(), data: encode_device_envelope(&envelope) });
        self.send_record(write_record(&frame))
    }

    fn send_device_error(&self, channel_id: &str, request_id: Option<String>, code: &str, message: impl Into<String>) {
        self.send_device(
            channel_id,
            device_envelope::Payload::Error(DeviceError { request_id, code: code.to_string(), message: message.into() }),
        );
    }

    fn get(&self, session_id: &str) -> Option<SessionHandle> {
        self.map.lock().unwrap().get(session_id).cloned()
    }

    pub fn create(self: &Arc<Self>, session_id: String, task_id: String, cwd: String, shell: String, cols: u16, rows: u16) {
        if self.get(&session_id).is_some() {
            return self.fail(&session_id, "duplicate session id");
        }
        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
            Ok(pair) => pair,
            Err(error) => return self.fail(&session_id, &format!("openpty: {error}")),
        };
        let shell = if shell.is_empty() { self.shell.clone() } else { shell };
        let cwd = if cwd.is_empty() { self.home.clone() } else { cwd };
        let mut command = CommandBuilder::new(&shell);
        command.cwd(&cwd);
        for (key, value) in std::env::vars() {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        let child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => return self.fail(&session_id, &format!("spawn: {error}")),
        };
        drop(pair.slave);
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => return self.fail(&session_id, &format!("clone_reader: {error}")),
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => return self.fail(&session_id, &format!("take_writer: {error}")),
        };
        let pid = child.process_id().map_or(-1, |pid| pid as i32);
        let session = Arc::new(Mutex::new(Session {
            master: pair.master,
            writer,
            child,
            task_id: task_id.clone(),
            cwd,
            pid,
            started_at: now_ms(),
            state: SessionState::new(rows, cols, self.history_line_limit),
        }));
        self.map.lock().unwrap().insert(session_id.clone(), session.clone());
        eprintln!("[supervisor] session started {session_id} pid={pid}");
        self.send_ctrl(&SupervisorToWorker::SessionStarted { session_id: session_id.clone(), task_id, pid });
        self.spawn_reader(session_id, session, reader);
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
                {
                    let (lock, cvar) = &*this.pause;
                    let mut paused = lock.lock().unwrap();
                    while *paused {
                        paused = cvar.wait(paused).unwrap();
                    }
                }
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
                        for gap in locked.state.pending_gaps() {
                            let sent = this.send_device(
                                &gap.channel_id,
                                device_envelope::Payload::PtyGap(DevicePtyGap {
                                    session_id: session_id.clone(),
                                    expected_seq: gap.expected_seq,
                                    available_seq: gap.available_seq,
                                }),
                            );
                            locked.state.gap_delivery_result(&gap.channel_id, sent);
                        }
                    }
                }
            }

            let removed = {
                let mut map = this.map.lock().unwrap();
                if map.get(&session_id).is_some_and(|current| Arc::ptr_eq(current, &session)) {
                    map.remove(&session_id)
                } else {
                    None
                }
            };
            if let Some(session) = removed {
                let mut locked = session.lock().unwrap();
                let code = locked.child.wait().map_or(-1, |status| status.exit_code() as i32);
                eprintln!("[supervisor] session exited {session_id} code={code}");
                this.send_ctrl(&SupervisorToWorker::SessionExit { session_id, exit_code: code });
            }
        });
    }

    pub fn input(&self, session_id: &str, data: &[u8]) {
        if let Some(session) = self.get(session_id) {
            let _ = session.lock().unwrap().writer.write_all(data);
        }
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(session) = self.get(session_id) {
            let mut locked = session.lock().unwrap();
            let _ = locked.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
            locked.state.resize(rows, cols);
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

    pub fn handle_device(&self, outer_channel_id: &str, bytes: &[u8]) {
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
            other => self.send_device_error(
                outer_channel_id,
                request_id_of(&other),
                "unsupported_by_sessiond",
                "该 Device payload 不属于当前 sessiond 路由",
            ),
        }
    }

    fn device_catalog(&self, channel_id: &str, request: DeviceSessionCatalogRequest) {
        let handles: Vec<(String, SessionHandle)> = self.map.lock().unwrap().iter().map(|(id, session)| (id.clone(), session.clone())).collect();
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
        let exits = self.tombstones.lock().unwrap().clone();
        self.send_device(
            channel_id,
            device_envelope::Payload::SessionCatalog(DeviceSessionCatalog { request_id: request.request_id, sessions, exits }),
        );
    }

    fn device_attach(&self, channel_id: &str, request: DeviceSessionAttach) {
        let Some(session) = self.get(&request.session_id) else {
            return self.send_device_error(channel_id, Some(request.request_id), "session_not_found", "session 不存在或已退出");
        };
        let mut locked = session.lock().unwrap();
        let cols = clamp_dim(request.cols, locked.state.cols());
        let rows = clamp_dim(request.rows, locked.state.rows());
        let _ = locked.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        locked.state.resize(rows, cols);
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
        self.send_device(
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
        }
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

    pub fn set_pause(&self, value: bool) {
        let (lock, cvar) = &*self.pause;
        let mut paused = lock.lock().unwrap();
        *paused = value;
        if !value {
            cvar.notify_all();
        }
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
