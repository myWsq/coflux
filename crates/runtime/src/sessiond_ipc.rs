//! The in-process bridge between sessiond (VT/history/holder/sequence authority) and the rest of
//! the runtime (centre connection, local gateway, device RPC).
//!
//! Until plan 20261002-runtime-launcher-merge this was the supervisor ↔ worker UDS contract; it is
//! now private to `coflux-runtime` and travels over two bounded in-process channels as
//! length-prefixed records (`coflux_protocol::ipc::write_record`), so sessiond keeps its own
//! bounded outbound queue and byte accounting. Data records are binary frames, control records
//! are JSON.
//!
//! Frame layout: `[kind:1][idLen:1][id:utf8][payload to end]`. Kind 1 is the session-dirty
//! notification; 2 (input) and 3 (replay) stay reserved and are never decoded; 4 is proxy data;
//! 5 is a Device envelope whose id is the logical channel id.

use serde::{Deserialize, Serialize};

use coflux_protocol::{CommandStateInfo, MAX_FRAME_ID_BYTES};

pub const FRAME_OUTPUT: u8 = 1;
pub const FRAME_INPUT: u8 = 2;
pub const FRAME_REPLAY: u8 = 3;
pub const FRAME_PROXY_DATA: u8 = 4;
pub const FRAME_DEVICE: u8 = 5;

/// A record payload is a binary frame when its first byte is a frame kind (1..=5); JSON control
/// records start with `{` (0x7b) and cannot collide.
pub fn is_frame(payload: &[u8]) -> bool {
    matches!(payload.first().copied(), Some(1..=5))
}

/// Live-session snapshot carried by `resync.list` (with pid: the runtime core needs the PTY
/// process tree root for port and agent probing).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub task_id: String,
    pub pid: i32,
    /// Shell-integration command state at resync time so the core learns busy/sequence/last
    /// exit without waiting for the next mark.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<CommandStateInfo>,
    /// OSC title at resync time, so the core can report metadata for adopted sessions without
    /// rendering a snapshot (plan 20261010-terminal-checkpoint-energy).
    #[serde(default)]
    pub title: String,
}

/// The runtime core's own logical Device channel toward sessiond (checkpoint snapshots, catalogs).
pub const INTERNAL_CHANNEL_ID: &str = "__coflux-worker";

/// Request id of the unsolicited `SessionSnapshot` sessiond sends on the runtime's internal Device
/// channel right before a session's `session.exit` (plan 20261010-terminal-checkpoint-energy): the
/// final content of the terminal, rendered while sessiond still holds its screen. The runtime
/// publishes it as the session's last checkpoint when content is still owed.
pub const FINAL_SNAPSHOT_REQUEST_ID: &str = "__coflux-final-snapshot";

/// runtime core → sessiond control records (JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum SessiondCommand {
    /// Create a session. The four ownership ids become `COFLUX_*` variables in the PTY
    /// environment (plan 092); empty values are omitted.
    #[serde(rename = "session.create")]
    SessionCreate {
        session_id: String,
        task_id: String,
        cwd: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
        cols: u16,
        rows: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        daemon_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mcp_url: Option<String>,
    },
    #[serde(rename = "session.close")]
    SessionClose { session_id: String },
    /// The core (re)attached to sessiond and asks for the live session list.
    #[serde(rename = "resync.request")]
    ResyncRequest,
}

/// sessiond → runtime core control records (JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum SessiondEvent {
    #[serde(rename = "session.started")]
    SessionStarted {
        session_id: String,
        task_id: String,
        pid: i32,
    },
    /// A session.create collided with an existing session's identity; distinct from an exit so
    /// the core only reconciles instead of forgetting a live session.
    #[serde(rename = "session.createFailed")]
    SessionCreateFailed {
        session_id: String,
        task_id: String,
        error: String,
    },
    #[serde(rename = "session.exit")]
    SessionExit {
        session_id: String,
        exit_code: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        /// Identity of the exited process; absent for a create attempt that never started.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<i32>,
    },
    /// Command state changed (a coflux mark arrived): pushed so `wait` wakes at once.
    #[serde(rename = "session.command")]
    SessionCommand {
        session_id: String,
        #[serde(flatten)]
        state: CommandStateInfo,
    },
    /// The OSC 0/2 title changed (plan 20261010-terminal-checkpoint-energy): pushed so the title
    /// reaches the center as metadata without the runtime rendering a snapshot.
    #[serde(rename = "session.title")]
    SessionTitle { session_id: String, title: String },
    #[serde(rename = "resync.list")]
    ResyncList {
        /// Unused since the launcher checks health itself; kept empty.
        #[serde(default)]
        nonce: String,
        #[serde(default)]
        snapshot_owner_id: String,
        #[serde(default)]
        snapshot_epoch: u64,
        sessions: Vec<SessionInfo>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataFrame {
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    ProxyData {
        conn_id: String,
        data: Vec<u8>,
    },
    /// Multiplexed DeviceEnvelope; id is the logical channel id.
    Device {
        channel_id: String,
        data: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameEncodeError {
    IdTooLong { len: usize, max: usize },
}

impl std::fmt::Display for FrameEncodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdTooLong { len, max } => write!(formatter, "frame ID 长度 {len} 超过上限 {max}"),
        }
    }
}

impl std::error::Error for FrameEncodeError {}

/// 编码为二进制帧。ID 最多 255 字节；拒绝超长值，不能在 release 构建静默截断。
pub fn encode_frame(frame: &DataFrame) -> Result<Vec<u8>, FrameEncodeError> {
    let (kind, sid, data): (u8, &str, &[u8]) = match frame {
        DataFrame::Output { session_id, data } => (FRAME_OUTPUT, session_id, data),
        DataFrame::ProxyData { conn_id, data } => (FRAME_PROXY_DATA, conn_id, data),
        DataFrame::Device { channel_id, data } => (FRAME_DEVICE, channel_id, data),
    };
    let sid = sid.as_bytes();
    let sid_len = u8::try_from(sid.len()).map_err(|_| FrameEncodeError::IdTooLong {
        len: sid.len(),
        max: MAX_FRAME_ID_BYTES,
    })?;
    let mut out = Vec::with_capacity(2 + sid.len() + data.len());
    out.push(kind);
    out.push(sid_len);
    out.extend_from_slice(sid);
    out.extend_from_slice(data);
    Ok(out)
}

/// 解码二进制帧；畸形返回 None（调用方丢弃，不 panic）。
pub fn decode_frame(buf: &[u8]) -> Option<DataFrame> {
    if buf.len() < 2 {
        return None;
    }
    let kind = buf[0];
    let sid_len = buf[1] as usize;
    if buf.len() < 2 + sid_len {
        return None;
    }
    let session_id = std::str::from_utf8(&buf[2..2 + sid_len]).ok()?.to_string();
    let off = 2 + sid_len;
    match kind {
        FRAME_OUTPUT => Some(DataFrame::Output {
            session_id,
            data: buf[off..].to_vec(),
        }),
        FRAME_INPUT | FRAME_REPLAY => None,
        FRAME_PROXY_DATA => Some(DataFrame::ProxyData {
            conn_id: session_id,
            data: buf[off..].to_vec(),
        }),
        FRAME_DEVICE => Some(DataFrame::Device {
            channel_id: session_id,
            data: buf[off..].to_vec(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_roundtrip() {
        let f = DataFrame::Output {
            session_id: "sess-1".into(),
            data: b"hello\x1b[0m\xff".to_vec(),
        };
        let enc = encode_frame(&f).unwrap();
        assert_eq!(enc[0], FRAME_OUTPUT);
        assert_eq!(enc[1] as usize, "sess-1".len());
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn legacy_input_and_replay_kinds_are_reserved() {
        assert_eq!(decode_frame(&[FRAME_INPUT, 1, b's', b'x']), None);
        assert_eq!(decode_frame(&[FRAME_REPLAY, 1, b's', b'x']), None);
    }

    #[test]
    fn rejects_short_and_truncated() {
        assert_eq!(decode_frame(&[FRAME_OUTPUT]), None);
        assert_eq!(decode_frame(&[FRAME_OUTPUT, 5, b'a']), None); // sidLen=5 但不足
        assert_eq!(decode_frame(&[FRAME_REPLAY, 1, b's']), None); // reserved kind
        assert_eq!(decode_frame(&[9, 0]), None); // 未知 kind
    }

    #[test]
    fn proxy_data_roundtrip() {
        let f = DataFrame::ProxyData {
            conn_id: "conn-42".into(),
            data: b"GET / HTTP/1.1\r\n\xff\x00binary".to_vec(),
        };
        let enc = encode_frame(&f).unwrap();
        assert_eq!(enc[0], FRAME_PROXY_DATA);
        assert_eq!(enc[1] as usize, "conn-42".len());
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn proxy_data_rejects_truncated() {
        assert_eq!(decode_frame(&[FRAME_PROXY_DATA]), None);
        assert_eq!(decode_frame(&[FRAME_PROXY_DATA, 5, b'a']), None); // idLen=5 但不足
    }

    #[test]
    fn device_envelope_roundtrip() {
        let f = DataFrame::Device {
            channel_id: "local-1".into(),
            data: vec![0, 1, 2, 0xff],
        };
        let enc = encode_frame(&f).unwrap();
        assert_eq!(enc[0], FRAME_DEVICE);
        assert_eq!(decode_frame(&enc), Some(f));
    }

    #[test]
    fn frame_id_accepts_255_bytes_and_rejects_256() {
        let accepted = DataFrame::Device {
            channel_id: "a".repeat(MAX_FRAME_ID_BYTES),
            data: vec![7],
        };
        let encoded = encode_frame(&accepted).unwrap();
        assert_eq!(encoded[1], u8::MAX);
        assert_eq!(decode_frame(&encoded), Some(accepted));

        let rejected = DataFrame::Device {
            channel_id: "b".repeat(MAX_FRAME_ID_BYTES + 1),
            data: vec![7],
        };
        assert_eq!(
            encode_frame(&rejected),
            Err(FrameEncodeError::IdTooLong {
                len: MAX_FRAME_ID_BYTES + 1,
                max: MAX_FRAME_ID_BYTES
            })
        );
    }

    #[test]
    fn frame_vs_json_discriminator() {
        assert!(is_frame(&[1, 0]));
        assert!(is_frame(&[5, 0]));
        assert!(!is_frame(b"{\"type\":\"x\"}"));
    }

    #[test]
    fn control_records_are_tagged_camel_case_json() {
        assert_eq!(
            serde_json::to_string(&SessiondCommand::ResyncRequest).unwrap(),
            r#"{"type":"resync.request"}"#
        );
        let exit = SessiondEvent::SessionExit {
            session_id: "s1".into(),
            exit_code: 17,
            task_id: Some("t1".into()),
            pid: Some(42),
        };
        assert_eq!(
            serde_json::to_string(&exit).unwrap(),
            r#"{"type":"session.exit","sessionId":"s1","exitCode":17,"taskId":"t1","pid":42}"#
        );
        let list = SessiondEvent::ResyncList {
            nonce: String::new(),
            snapshot_owner_id: "owner-1".into(),
            snapshot_epoch: 9,
            sessions: vec![SessionInfo { session_id: "s1".into(), task_id: "t1".into(), pid: 4242, command: None, title: "t".into() }],
        };
        let back: SessiondEvent = serde_json::from_str(&serde_json::to_string(&list).unwrap()).unwrap();
        match back {
            SessiondEvent::ResyncList { sessions, snapshot_epoch, .. } => {
                assert_eq!(snapshot_epoch, 9);
                assert_eq!(sessions[0].pid, 4242);
            }
            _ => panic!("wrong variant"),
        }
    }
}
