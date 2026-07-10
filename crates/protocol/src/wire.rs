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

/// ports.update 里单个会话上报的监听端口列表
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPorts {
    pub session_id: String,
    pub ports: Vec<u16>,
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
    /// 未登记且无 enrollmentKey 时：申请一次性授权链接（Tailscale 式，见 docs/auth-design.md）
    #[serde(rename = "daemon.enrollRequest")]
    DaemonEnrollRequest { name: String, host: String, platform: String },
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
    /// 全量幂等上报每个（存活）会话监听的端口；仅含有监听端口的 session，daemon 重连/漏报自愈
    #[serde(rename = "ports.update")]
    PortsUpdate { sessions: Vec<SessionPorts> },
    /// server→daemon proxy.open 的回应：隧道连接建立结果
    #[serde(rename = "proxy.opened")]
    ProxyOpened {
        conn_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// 隧道连接（daemon 侧到本地端口的 TCP 连接）关闭，控制面消息，不走数据面帧
    #[serde(rename = "proxy.closed")]
    ProxyClosed { conn_id: String },
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
    /// enrollRequest 的回应：一次性授权链接 + 过期时间（ms epoch）。daemon 落盘展示，连接断开即作废
    #[serde(rename = "daemon.authorizePending")]
    DaemonAuthorizePending { url: String, expires_at: f64 },
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
    WorkerUpgrade {
        version: String,
        // 带 url 走"下载 + 验签"；不带则在 supervisor 自有注册表里按版本切换（本地已知版本）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
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
    /// 打开一条隧道连接：daemon 向本地 port 发起 TCP 连接，字节经 proxy.data 帧（kind=4）双向透传
    #[serde(rename = "proxy.open")]
    ProxyOpen { conn_id: String, port: u16 },
    /// 关闭一条隧道连接（server 侧发起，例如浏览器断开）
    #[serde(rename = "proxy.close")]
    ProxyClose { conn_id: String },
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

    #[test]
    fn enroll_request_round_trips() {
        let m = DaemonToServer::DaemonEnrollRequest {
            name: "dev".into(),
            host: "h".into(),
            platform: "darwin".into(),
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"daemon.enrollRequest""#));
        let back: DaemonToServer = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, DaemonToServer::DaemonEnrollRequest { .. }));
    }

    #[test]
    fn proxy_conn_id_serializes_camel_case() {
        // landmine: rename_all_fields = camelCase 把 conn_id 转成 connId；TS 侧字段名必须一致
        let m = ServerToDaemon::ProxyOpen { conn_id: "c1".into(), port: 3000 };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"proxy.open""#));
        assert!(s.contains(r#""connId":"c1""#));
        assert!(!s.contains("conn_id"));
        let back: ServerToDaemon = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, ServerToDaemon::ProxyOpen { port: 3000, .. }));

        let opened = DaemonToServer::ProxyOpened { conn_id: "c2".into(), ok: true, error: None };
        let s2 = serde_json::to_string(&opened).unwrap();
        assert!(s2.contains(r#""connId":"c2""#));
        assert!(!s2.contains("error")); // omitted when None
        let back2: DaemonToServer = serde_json::from_str(&s2).unwrap();
        assert!(matches!(back2, DaemonToServer::ProxyOpened { ok: true, .. }));
    }

    #[test]
    fn ports_update_round_trips() {
        let m = DaemonToServer::PortsUpdate { sessions: vec![SessionPorts { session_id: "s1".into(), ports: vec![3000, 8080] }] };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"ports.update""#));
        assert!(s.contains(r#""sessionId":"s1""#));
        let back: DaemonToServer = serde_json::from_str(&s).unwrap();
        match back {
            DaemonToServer::PortsUpdate { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].ports, vec![3000, 8080]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn authorize_pending_round_trips() {
        let m = ServerToDaemon::DaemonAuthorizePending { url: "https://example/authorize/tok".into(), expires_at: 12345.0 };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""type":"daemon.authorizePending""#));
        assert!(s.contains(r#""expiresAt":12345.0"#));
        let back: ServerToDaemon = serde_json::from_str(&s).unwrap();
        match back {
            ServerToDaemon::DaemonAuthorizePending { url, expires_at } => {
                assert_eq!(url, "https://example/authorize/tok");
                assert_eq!(expires_at, 12345.0);
            }
            _ => panic!("wrong variant"),
        }
    }
}
