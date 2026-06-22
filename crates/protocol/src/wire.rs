//! Daemon ↔ Server 线协议（控制面，JSON）。
//!
//! 与 TS `packages/protocol/src/index.ts` 的 DaemonToServer / ServerToDaemon 一致：
//! JSON 内部标签 `type` 区分；字段 camelCase。数据面（pty.output/input/replay）走二进制
//! 帧（见 [crate::frame]），不在此列。Client↔Server 仍由 TS server/web 持有，不在 Rust 侧。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// resync 上报的存活会话引用
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub session_id: String,
    pub task_id: String,
}

/// fs.list 返回的目录项
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    /// "file" | "dir" | "symlink" | "other"
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
}

/// Daemon → Server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum DaemonToServer {
    #[serde(rename = "daemon.enroll")]
    DaemonEnroll { enrollment_key: String, name: String, host: String, platform: String },
    #[serde(rename = "daemon.auth")]
    DaemonAuth { device_token: String },
    #[serde(rename = "daemon.resync")]
    DaemonResync { sessions: Vec<SessionRef> },
    #[serde(rename = "project.validated")]
    ProjectValidated {
        request_id: String,
        ok: bool,
        repo_path: String,
        branch: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "worktree.added")]
    WorktreeAdded {
        request_id: String,
        ok: bool,
        path: String,
        branch: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "session.started")]
    SessionStarted { session_id: String, task_id: String, pid: i32 },
    #[serde(rename = "session.exit")]
    SessionExit { session_id: String, exit_code: i32 },
    #[serde(rename = "exec.result")]
    ExecResult {
        request_id: String,
        ok: bool,
        exit_code: i32,
        stdout: String,
        stderr: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "fs.listed")]
    FsListed {
        request_id: String,
        ok: bool,
        entries: Vec<FsEntry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "fs.read.result")]
    FsReadResult {
        request_id: String,
        ok: bool,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// Server → Daemon
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ServerToDaemon {
    #[serde(rename = "daemon.enrolled")]
    DaemonEnrolled { daemon_id: String, device_token: String },
    #[serde(rename = "daemon.authed")]
    DaemonAuthed { daemon_id: String },
    #[serde(rename = "daemon.authError")]
    DaemonAuthError { message: String, need_enroll: bool },
    #[serde(rename = "project.validate")]
    ProjectValidate { request_id: String, path: String },
    #[serde(rename = "worktree.add")]
    WorktreeAdd {
        request_id: String,
        repo_path: String,
        workspace_id: String,
        name: String,
        branch: String,
        create_new: bool,
    },
    #[serde(rename = "worktree.remove")]
    WorktreeRemove { repo_path: String, worktree_path: String },
    #[serde(rename = "worker.upgrade")]
    WorkerUpgrade { version: String },
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
    #[serde(rename = "exec.run")]
    ExecRun {
        request_id: String,
        cwd: String,
        command: String,
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    #[serde(rename = "fs.list")]
    FsList { request_id: String, root: String, path: String },
    #[serde(rename = "fs.read")]
    FsRead { request_id: String, root: String, path: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enroll_serializes_camel_case_tagged() {
        let m = DaemonToServer::DaemonEnroll {
            enrollment_key: "k".into(),
            name: "dev".into(),
            host: "h".into(),
            platform: "darwin".into(),
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"daemon.enroll""#));
        assert!(s.contains(r#""enrollmentKey":"k""#));
    }

    #[test]
    fn session_create_deserializes_from_ts_wire() {
        // 模拟 TS server 下发的 JSON（含可选 shell 省略、camelCase）
        let json = r#"{"type":"session.create","sessionId":"s1","taskId":"t1","cwd":"/tmp","cols":80,"rows":24}"#;
        let m: ServerToDaemon = serde_json::from_str(json).unwrap();
        match m {
            ServerToDaemon::SessionCreate { session_id, task_id, cwd, shell, cols, rows } => {
                assert_eq!(session_id, "s1");
                assert_eq!(task_id, "t1");
                assert_eq!(cwd, "/tmp");
                assert_eq!(shell, None);
                assert_eq!((cols, rows), (80, 24));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn auth_error_round_trips() {
        let m = ServerToDaemon::DaemonAuthError { message: "bad".into(), need_enroll: true };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""needEnroll":true"#));
        let back: ServerToDaemon = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, ServerToDaemon::DaemonAuthError { need_enroll: true, .. }));
    }

    #[test]
    fn optional_error_omitted_when_none() {
        let m = DaemonToServer::FsReadResult { request_id: "r".into(), ok: true, content: "hi".into(), error: None };
        let s = serde_json::to_string(&m).unwrap();
        assert!(!s.contains("error"));
    }
}
