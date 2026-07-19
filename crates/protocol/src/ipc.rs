//! worker ↔ supervisor 的本地 IPC（UDS 字节流）。
//!
//! 复用数据面二进制帧（[frame]）；控制消息走 JSON。UDS 无消息边界，故每条记录加
//! 4 字节大端长度前缀：`[u32 BE 长度][payload]`。
//! payload 首字节是 FrameKind(1/2/3) → pty 数据帧；否则按 UTF-8 JSON 解析
//! （JSON 控制消息以 '{'=0x7b 开头，与 1/2/3 不冲突）。与 TS `apps/daemon/src/ipc.ts` 等价。

use serde::{Deserialize, Serialize};

/// supervisor 把 UDS 路径经此环境变量传给 worker 子进程
pub const SUPERVISOR_SOCK_ENV: &str = "COFLUX_SUPERVISOR_SOCK";

/// 热更新编排（plan 015）：supervisor spawn worker 时经这两个环境变量传入"当前跑的 worker 版本"
/// 与"supervisor 自身版本"，worker 握手消息据此上报（worker 完全不知自身版本，纯 supervisor 侧概念）。
pub const WORKER_VERSION_ENV: &str = "COFLUX_WORKER_VERSION";
pub const SUPERVISOR_VERSION_ENV: &str = "COFLUX_SUPERVISOR_VERSION";

/// resync.list 携带的存活会话快照（含 pid）。与 wire::SessionRef（daemon→server resync，
/// 不含 pid）是两个独立类型：worker 重启后要靠 pid 找到 PTY 进程树根做端口探测，
/// 而 daemon→server 的 resync 形状已冻结、不需要 pid。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub task_id: String,
    pub pid: i32,
}

/// worker → supervisor 控制消息（JSON）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum WorkerToSupervisor {
    #[serde(rename = "session.create")]
    SessionCreate {
        session_id: String,
        task_id: String,
        cwd: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "session.close")]
    SessionClose { session_id: String },
    #[serde(rename = "session.replay")]
    SessionReplay { session_id: String, request_id: String },
    #[serde(rename = "pty.resize")]
    PtyResize { session_id: String, cols: u16, rows: u16 },
    /// worker（重）连后索要存活会话列表
    #[serde(rename = "resync.request")]
    ResyncRequest,
    /// 背压：worker 的 server WS 缓冲水位驱动 supervisor 暂停/恢复全部 PTY
    #[serde(rename = "pty.pause")]
    PtyPause,
    #[serde(rename = "pty.resume")]
    PtyResume,
    /// 热升级：把 server 下发的版本切换转给 supervisor（带 url 走下载+验签）
    #[serde(rename = "worker.upgrade")]
    WorkerUpgrade {
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
}

/// supervisor → worker 控制消息（JSON）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum SupervisorToWorker {
    #[serde(rename = "session.started")]
    SessionStarted { session_id: String, task_id: String, pid: i32 },
    #[serde(rename = "session.exit")]
    SessionExit { session_id: String, exit_code: i32 },
    #[serde(rename = "resync.list")]
    ResyncList { sessions: Vec<SessionInfo> },
}

/// 写一条带长度前缀的记录（header + payload 一起返回，调用方一次写出）
pub fn write_record(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// payload 是 pty 数据帧（首字节 1/2/3）还是 JSON 控制消息
pub fn is_frame(payload: &[u8]) -> bool {
    matches!(payload.first().copied(), Some(1..=3))
}

/// 累积式分帧解析器：喂入任意字节块，凑齐一条记录就回调（镜像 TS RecordParser）。
#[derive(Default)]
pub struct RecordParser {
    buf: Vec<u8>,
}

impl RecordParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 追加一段字节，对凑齐的每条记录调用 `on_record`。
    pub fn push(&mut self, chunk: &[u8], mut on_record: impl FnMut(&[u8])) {
        self.buf.extend_from_slice(chunk);
        let mut pos = 0usize;
        while self.buf.len() - pos >= 4 {
            let len = u32::from_be_bytes([self.buf[pos], self.buf[pos + 1], self.buf[pos + 2], self.buf[pos + 3]]) as usize;
            if self.buf.len() - pos < 4 + len {
                break;
            }
            on_record(&self.buf[pos + 4..pos + 4 + len]);
            pos += 4 + len;
        }
        if pos > 0 {
            self.buf.drain(0..pos);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_framing_across_chunk_boundaries() {
        let mut stream = Vec::new();
        stream.extend(write_record(b"hello"));
        stream.extend(write_record(b"world!!"));
        let mut parser = RecordParser::new();
        let mut got: Vec<Vec<u8>> = Vec::new();
        // 故意按奇怪的边界喂入
        parser.push(&stream[..3], |r| got.push(r.to_vec()));
        parser.push(&stream[3..9], |r| got.push(r.to_vec()));
        parser.push(&stream[9..], |r| got.push(r.to_vec()));
        assert_eq!(got, vec![b"hello".to_vec(), b"world!!".to_vec()]);
    }

    #[test]
    fn frame_vs_json_discriminator() {
        assert!(is_frame(&[1, 0]));
        assert!(is_frame(&[3, 0]));
        assert!(!is_frame(b"{\"type\":\"x\"}")); // '{' = 0x7b
    }

    #[test]
    fn uds_unit_variant_json() {
        assert_eq!(serde_json::to_string(&WorkerToSupervisor::ResyncRequest).unwrap(), r#"{"type":"resync.request"}"#);
        assert_eq!(serde_json::to_string(&WorkerToSupervisor::PtyPause).unwrap(), r#"{"type":"pty.pause"}"#);
    }

    #[test]
    fn uds_struct_variant_camel_case() {
        let m = SupervisorToWorker::SessionStarted { session_id: "s1".into(), task_id: "t1".into(), pid: 42 };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"session.started""#));
        assert!(s.contains(r#""sessionId":"s1""#));
        assert!(s.contains(r#""taskId":"t1""#));
    }

    #[test]
    fn resync_list_carries_pid() {
        let m = SupervisorToWorker::ResyncList { sessions: vec![SessionInfo { session_id: "s1".into(), task_id: "t1".into(), pid: 4242 }] };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"resync.list""#));
        assert!(s.contains(r#""pid":4242"#));
        let back: SupervisorToWorker = serde_json::from_str(&s).unwrap();
        match back {
            SupervisorToWorker::ResyncList { sessions } => {
                assert_eq!(sessions, vec![SessionInfo { session_id: "s1".into(), task_id: "t1".into(), pid: 4242 }]);
            }
            _ => panic!("wrong variant"),
        }
    }
}
