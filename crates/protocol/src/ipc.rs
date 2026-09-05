//! worker ↔ supervisor 的本地 IPC（UDS 字节流）。
//!
//! 复用数据面二进制帧（[frame]）；控制消息走 JSON。UDS 无消息边界，故每条记录加
//! 4 字节大端长度前缀：`[u32 BE 长度][payload]`。
//! payload 首字节是 FrameKind(1..=5) → pty/proxy/device 数据帧；否则按 UTF-8 JSON 解析
//! （JSON 控制消息以 '{'=0x7b 开头，与 frame kind 不冲突）。

use serde::{Deserialize, Serialize};

use crate::{MAX_DEVICE_FRAME_BYTES, MAX_FRAME_ID_BYTES};

/// 接收与发送共用的 UDS record payload 硬上限。
pub const MAX_IPC_RECORD_BYTES: usize = MAX_DEVICE_FRAME_BYTES + 2 + MAX_FRAME_ID_BYTES;

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
    /// 直发建会话。`workspace_id` 起四个字段是会话归属 id（plan 092），supervisor 据此组装
    /// COFLUX_* 环境变量注入 PTY。全部可缺省：supervisor 对控制消息用 `if let Ok(...)` 解码、
    /// 失败静默丢弃整条，任何必填新字段都会让旧 worker 的 session.create 被新 supervisor 整条吞掉；
    /// 反过来旧 supervisor 的 serde 也会忽略这些未知字段，会话照常起、只是没有变量。
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
        /// 无仓库的目录工作区为 None / 空串
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        daemon_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mcp_url: Option<String>,
    },
    #[serde(rename = "session.close")]
    SessionClose { session_id: String },
    /// worker（重）连后索要存活会话列表
    #[serde(rename = "resync.request")]
    ResyncRequest,
    /// worker 已应用指定 nonce 的 resync.list，并已连上中心完成 daemon resync 入队。
    #[serde(rename = "resync.applied")]
    ResyncApplied { nonce: String },
    /// 热升级：把 server 下发的版本切换转给 supervisor（带 url 走下载+验签）。
    /// `signature` 是旧 supervisor 仍能验证的 raw-binary 签名；其余三字段组成
    /// 新 supervisor 必验的 domain-separated release statement。serde 默认忽略
    /// enum variant 内的未知字段，因此新 worker 可以继续向旧 supervisor 滚动投递。
    #[serde(rename = "worker.upgrade")]
    WorkerUpgrade {
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_size: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        release_signature: Option<String>,
    },
}

/// supervisor → worker 控制消息（JSON）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum SupervisorToWorker {
    #[serde(rename = "session.started")]
    SessionStarted {
        session_id: String,
        task_id: String,
        pid: i32,
    },
    /// legacy session.create 与现存会话发生 identity 冲突。必须使用独立 variant：
    /// 旧 worker 会把未知控制消息安全丢弃，不能降级成 session.exit 误删现存会话。
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
        /// 新 supervisor 携带退出进程身份；缺失代表旧 supervisor 或一次尚未创建成功的
        /// legacy session.create，worker 必须先向 sessiond catalog 对账再决定是否清活状态。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<i32>,
    },
    #[serde(rename = "resync.list")]
    ResyncList {
        /// 缺失时为空串，保持新 worker 可连接尚未支持 challenge 的旧 supervisor。
        #[serde(default)]
        nonce: String,
        /// 缺失时是 legacy owner/epoch；新值只由 supervisor/sessiond 生成。
        #[serde(default)]
        snapshot_owner_id: String,
        #[serde(default)]
        snapshot_epoch: u64,
        sessions: Vec<SessionInfo>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordWriteError {
    RecordTooLarge { actual: usize, max: usize },
}

impl std::fmt::Display for RecordWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RecordTooLarge { actual, max } => {
                write!(formatter, "UDS record 长度 {actual} 超过上限 {max}")
            }
        }
    }
}

impl std::error::Error for RecordWriteError {}

/// 写一条带长度前缀的记录；发送侧不能制造解析侧必然拒绝的超长 record。
pub fn write_record(payload: &[u8]) -> Result<Vec<u8>, RecordWriteError> {
    if payload.len() > MAX_IPC_RECORD_BYTES {
        return Err(RecordWriteError::RecordTooLarge {
            actual: payload.len(),
            max: MAX_IPC_RECORD_BYTES,
        });
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// payload 是二进制数据帧（首字节 1..=5）还是 JSON 控制消息
pub fn is_frame(payload: &[u8]) -> bool {
    matches!(payload.first().copied(), Some(1..=5))
}

/// 累积式分帧解析器：喂入任意字节块，凑齐一条记录就回调（镜像 TS RecordParser）。
#[derive(Default)]
pub struct RecordParser {
    buf: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordParseError {
    RecordTooLarge { declared: usize, max: usize },
}

impl std::fmt::Display for RecordParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RecordTooLarge { declared, max } => {
                write!(formatter, "UDS record 声明长度 {declared} 超过上限 {max}")
            }
        }
    }
}

impl std::error::Error for RecordParseError {}

impl RecordParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 追加一段字节，对凑齐的每条记录调用 `on_record`。
    pub fn push(
        &mut self,
        chunk: &[u8],
        mut on_record: impl FnMut(&[u8]),
    ) -> Result<(), RecordParseError> {
        self.buf.extend_from_slice(chunk);
        let mut pos = 0usize;
        while self.buf.len() - pos >= 4 {
            let len = u32::from_be_bytes([
                self.buf[pos],
                self.buf[pos + 1],
                self.buf[pos + 2],
                self.buf[pos + 3],
            ]) as usize;
            if len > MAX_IPC_RECORD_BYTES {
                self.buf.clear();
                return Err(RecordParseError::RecordTooLarge {
                    declared: len,
                    max: MAX_IPC_RECORD_BYTES,
                });
            }
            if self.buf.len() - pos < 4 + len {
                break;
            }
            on_record(&self.buf[pos + 4..pos + 4 + len]);
            pos += 4 + len;
        }
        if pos > 0 {
            self.buf.drain(0..pos);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_framing_across_chunk_boundaries() {
        let mut stream = Vec::new();
        stream.extend(write_record(b"hello").unwrap());
        stream.extend(write_record(b"world!!").unwrap());
        let mut parser = RecordParser::new();
        let mut got: Vec<Vec<u8>> = Vec::new();
        // 故意按奇怪的边界喂入
        parser.push(&stream[..3], |r| got.push(r.to_vec())).unwrap();
        parser
            .push(&stream[3..9], |r| got.push(r.to_vec()))
            .unwrap();
        parser.push(&stream[9..], |r| got.push(r.to_vec())).unwrap();
        assert_eq!(got, vec![b"hello".to_vec(), b"world!!".to_vec()]);
    }

    #[test]
    fn oversized_record_is_rejected_and_parser_state_is_cleared() {
        let declared = MAX_IPC_RECORD_BYTES + 1;
        let mut parser = RecordParser::new();
        assert_eq!(
            parser.push(&(declared as u32).to_be_bytes(), |_| panic!(
                "超长 record 不应触发回调"
            )),
            Err(RecordParseError::RecordTooLarge {
                declared,
                max: MAX_IPC_RECORD_BYTES
            })
        );
        let mut got = Vec::new();
        parser
            .push(&write_record(b"ok").unwrap(), |record| {
                got.push(record.to_vec())
            })
            .unwrap();
        assert_eq!(got, vec![b"ok".to_vec()]);
    }

    #[test]
    fn writer_uses_the_same_record_limit_as_parser() {
        let exact = vec![0u8; MAX_IPC_RECORD_BYTES];
        assert_eq!(
            write_record(&exact).unwrap().len(),
            MAX_IPC_RECORD_BYTES + 4
        );
        let oversized = vec![0u8; MAX_IPC_RECORD_BYTES + 1];
        assert_eq!(
            write_record(&oversized),
            Err(RecordWriteError::RecordTooLarge {
                actual: MAX_IPC_RECORD_BYTES + 1,
                max: MAX_IPC_RECORD_BYTES
            })
        );
    }

    #[test]
    fn frame_vs_json_discriminator() {
        assert!(is_frame(&[1, 0]));
        assert!(is_frame(&[3, 0]));
        assert!(is_frame(&[5, 0]));
        assert!(!is_frame(b"{\"type\":\"x\"}")); // '{' = 0x7b
    }

    #[test]
    fn uds_unit_variant_json() {
        assert_eq!(
            serde_json::to_string(&WorkerToSupervisor::ResyncRequest).unwrap(),
            r#"{"type":"resync.request"}"#
        );
        assert_eq!(
            serde_json::to_string(&WorkerToSupervisor::ResyncApplied {
                nonce: "abc".into()
            })
            .unwrap(),
            r#"{"type":"resync.applied","nonce":"abc"}"#
        );
    }

    #[test]
    fn uds_struct_variant_camel_case() {
        let m = SupervisorToWorker::SessionStarted {
            session_id: "s1".into(),
            task_id: "t1".into(),
            pid: 42,
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"session.started""#));
        assert!(s.contains(r#""sessionId":"s1""#));
        assert!(s.contains(r#""taskId":"t1""#));
    }

    #[test]
    fn session_exit_remains_compatible_in_both_directions() {
        let current = SupervisorToWorker::SessionExit {
            session_id: "s1".into(),
            exit_code: 17,
            task_id: Some("t1".into()),
            pid: Some(42),
        };
        let current_json = serde_json::to_string(&current).unwrap();
        assert_eq!(
            current_json,
            r#"{"type":"session.exit","sessionId":"s1","exitCode":17,"taskId":"t1","pid":42}"#
        );
        match serde_json::from_str::<SupervisorToWorker>(&current_json).unwrap() {
            SupervisorToWorker::SessionExit {
                session_id,
                exit_code,
                task_id,
                pid,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(exit_code, 17);
                assert_eq!(task_id.as_deref(), Some("t1"));
                assert_eq!(pid, Some(42));
            }
            _ => panic!("应解码为新 session.exit"),
        }

        let legacy_json = r#"{"type":"session.exit","sessionId":"s2","exitCode":-1}"#;
        match serde_json::from_str::<SupervisorToWorker>(legacy_json).unwrap() {
            SupervisorToWorker::SessionExit {
                session_id,
                exit_code,
                task_id,
                pid,
            } => {
                assert_eq!(session_id, "s2");
                assert_eq!(exit_code, -1);
                assert_eq!(task_id, None);
                assert_eq!(pid, None);
            }
            _ => panic!("应解码为 legacy session.exit"),
        }

        // 模拟 v0.28 worker：variant 内新增字段由 serde 默认忽略。
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all_fields = "camelCase")]
        enum LegacySupervisorToWorker {
            #[serde(rename = "session.exit")]
            SessionExit { session_id: String, exit_code: i32 },
        }
        match serde_json::from_str::<LegacySupervisorToWorker>(&current_json).unwrap() {
            LegacySupervisorToWorker::SessionExit {
                session_id,
                exit_code,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(exit_code, 17);
            }
        }
    }

    #[test]
    fn legacy_worker_safely_drops_session_create_failed() {
        let message = SupervisorToWorker::SessionCreateFailed {
            session_id: "s1".into(),
            task_id: "new-task".into(),
            error: "session id 已由其他 task 占用".into(),
        };
        let json = serde_json::to_string(&message).unwrap();
        assert_eq!(
            json,
            r#"{"type":"session.createFailed","sessionId":"s1","taskId":"new-task","error":"session id 已由其他 task 占用"}"#
        );

        // v0.28 worker 对控制消息使用 `from_slice(...); Err(_) => return`；未知
        // variant 必须反序列化失败，绝不能被误认成 session.exit。
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all_fields = "camelCase")]
        enum LegacySupervisorToWorker {
            #[serde(rename = "session.exit")]
            SessionExit { session_id: String, exit_code: i32 },
        }
        match serde_json::from_str::<LegacySupervisorToWorker>(&json) {
            Err(_) => {}
            Ok(LegacySupervisorToWorker::SessionExit {
                session_id,
                exit_code,
            }) => panic!(
                "未知 create-failed 被错误识别为 session.exit: {session_id} code={exit_code}"
            ),
        }
    }

    #[test]
    fn worker_upgrade_release_fields_are_camel_case_and_legacy_parser_ignores_them() {
        let message = WorkerToSupervisor::WorkerUpgrade {
            version: "v1.2.3".into(),
            url: Some("https://example.invalid/worker".into()),
            sha256: Some("00".repeat(32)),
            signature: Some("11".repeat(64)),
            target: Some("aarch64-apple-darwin".into()),
            artifact_size: Some(42),
            release_signature: Some("22".repeat(64)),
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains(r#""artifactSize":42"#));
        assert!(json.contains(r#""releaseSignature":"#));

        // 模拟已部署旧 supervisor 的 serde 形状：保留 raw signature，忽略新字段。
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all_fields = "camelCase")]
        enum LegacyWorkerToSupervisor {
            #[serde(rename = "worker.upgrade")]
            WorkerUpgrade {
                version: String,
                url: Option<String>,
                sha256: Option<String>,
                signature: Option<String>,
            },
        }
        let legacy: LegacyWorkerToSupervisor = serde_json::from_str(&json).unwrap();
        match legacy {
            LegacyWorkerToSupervisor::WorkerUpgrade {
                version,
                url,
                sha256,
                signature,
            } => {
                assert_eq!(version, "v1.2.3");
                assert!(url.is_some());
                assert!(sha256.is_some());
                assert_eq!(signature.as_deref(), Some("11".repeat(64).as_str()));
            }
        }
    }

    #[test]
    fn session_create_context_fields_are_optional_and_legacy_parser_ignores_them() {
        // 新 worker → 旧 supervisor：四个归属 id 以 camelCase 出现，旧 serde 形状忽略它们、会话照常起。
        let message = WorkerToSupervisor::SessionCreate {
            session_id: "s1".into(),
            task_id: "t1".into(),
            cwd: "/repo".into(),
            shell: None,
            cols: 80,
            rows: 24,
            workspace_id: Some("ws-1".into()),
            project_id: Some("proj-1".into()),
            daemon_id: Some("daemon-1".into()),
            mcp_url: Some("https://api.example.invalid/mcp".into()),
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains(r#""workspaceId":"ws-1""#));
        assert!(json.contains(r#""projectId":"proj-1""#));
        assert!(json.contains(r#""daemonId":"daemon-1""#));
        assert!(json.contains(r#""mcpUrl":"https://api.example.invalid/mcp""#));

        // 模拟已部署旧 supervisor（plan 092 之前）的 serde 形状：没有这四个字段。
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all_fields = "camelCase")]
        enum LegacyWorkerToSupervisor {
            #[serde(rename = "session.create")]
            SessionCreate {
                session_id: String,
                task_id: String,
                cwd: String,
                #[serde(default)]
                shell: Option<String>,
                cols: u16,
                rows: u16,
            },
        }
        let legacy: LegacyWorkerToSupervisor = serde_json::from_str(&json).unwrap();
        match legacy {
            LegacyWorkerToSupervisor::SessionCreate {
                session_id,
                task_id,
                cwd,
                shell,
                cols,
                rows,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(task_id, "t1");
                assert_eq!(cwd, "/repo");
                assert_eq!(shell, None);
                assert_eq!((cols, rows), (80, 24));
            }
        }

        // 旧 worker → 新 supervisor：没有这四个字段的 JSON 必须解码成功（supervisor 解码失败是静默
        // 丢弃整条，缺省不了就等于吞掉建会话请求），且四个字段为 None、序列化时不出现。
        let legacy_json =
            r#"{"type":"session.create","sessionId":"s2","taskId":"t2","cwd":"/x","cols":100,"rows":30}"#;
        let back: WorkerToSupervisor = serde_json::from_str(legacy_json).unwrap();
        match &back {
            WorkerToSupervisor::SessionCreate {
                session_id,
                workspace_id,
                project_id,
                daemon_id,
                mcp_url,
                ..
            } => {
                assert_eq!(session_id, "s2");
                assert_eq!(workspace_id, &None);
                assert_eq!(project_id, &None);
                assert_eq!(daemon_id, &None);
                assert_eq!(mcp_url, &None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
        let reserialized = serde_json::to_string(&back).unwrap();
        assert!(!reserialized.contains("workspaceId"));
        assert!(!reserialized.contains("mcpUrl"));
    }

    #[test]
    fn resync_list_carries_pid() {
        let m = SupervisorToWorker::ResyncList {
            nonce: "nine".into(),
            snapshot_owner_id: "owner-1".into(),
            snapshot_epoch: 9,
            sessions: vec![SessionInfo {
                session_id: "s1".into(),
                task_id: "t1".into(),
                pid: 4242,
            }],
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"resync.list""#));
        assert!(s.contains(r#""pid":4242"#));
        let back: SupervisorToWorker = serde_json::from_str(&s).unwrap();
        match back {
            SupervisorToWorker::ResyncList {
                nonce,
                snapshot_owner_id,
                snapshot_epoch,
                sessions,
            } => {
                assert_eq!(nonce, "nine");
                assert_eq!(snapshot_owner_id, "owner-1");
                assert_eq!(snapshot_epoch, 9);
                assert_eq!(
                    sessions,
                    vec![SessionInfo {
                        session_id: "s1".into(),
                        task_id: "t1".into(),
                        pid: 4242
                    }]
                );
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn legacy_resync_list_without_nonce_remains_readable() {
        let back: SupervisorToWorker = serde_json::from_str(
            r#"{"type":"resync.list","sessions":[{"sessionId":"s1","taskId":"t1","pid":42}]}"#,
        )
        .unwrap();
        match back {
            SupervisorToWorker::ResyncList {
                nonce,
                snapshot_owner_id,
                snapshot_epoch,
                sessions,
            } => {
                assert!(nonce.is_empty());
                assert!(snapshot_owner_id.is_empty());
                assert_eq!(snapshot_epoch, 0);
                assert_eq!(sessions.len(), 1);
            }
            _ => panic!("wrong variant"),
        }
    }
}
