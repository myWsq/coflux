//! [crate::wire]（prost 生成类型）的编解码往返测试。
//!
//! 取代旧 `wire.rs` 里针对 serde JSON 内部标签格式的测试：这里验证的是新 wire
//! format——WS 上每条消息是一个 protobuf 编码的信封（[wire::DaemonToServer] /
//! [wire::ServerToDaemon]），覆盖三个关键点：
//! - 信封 oneof 分派：encode 一个具体 payload variant，decode 后 match 回同一 variant。
//! - optional 字段缺省：`None` 不下线、往返后仍是 `None`；`Some` 往返后原样保留。
//! - bytes payload 原样往返：PTY/proxy 数据面 payload 是 `bytes`，任意（含非法 UTF-8）
//!   字节序列编解码后必须逐字节相同——这是本次迁移把 pty 数据从「已解码 string」改为
//!   「原始 bytes」的核心验收点。

use prost::Message;

use crate::wire::{
    daemon_to_server, server_to_daemon, DaemonAuthError, DaemonEnroll, DaemonEnrollRequest, DaemonToServer, ExecRun, FsEntry, FsEntryKind, ProjectValidated, PtyOutput, ServerToDaemon,
    SessionCreate, SessionPorts,
};

/// 信封 oneof 分派：DaemonToServer 编码 DaemonEnroll，解码后 match 回同一 variant、字段原样。
#[test]
fn daemon_to_server_envelope_dispatches_to_daemon_enroll() {
    let env = DaemonToServer {
        payload: Some(daemon_to_server::Payload::DaemonEnroll(DaemonEnroll {
            enrollment_key: "k".into(),
            name: "dev".into(),
            host: "h".into(),
            platform: "darwin".into(),
        })),
    };
    let bytes = env.encode_to_vec();
    let back = DaemonToServer::decode(bytes.as_slice()).unwrap();
    match back.payload {
        Some(daemon_to_server::Payload::DaemonEnroll(m)) => {
            assert_eq!(m.enrollment_key, "k");
            assert_eq!(m.name, "dev");
            assert_eq!(m.host, "h");
            assert_eq!(m.platform, "darwin");
        }
        other => panic!("wrong variant: {other:?}"),
    }
}

/// 反方向：ServerToDaemon 编码 SessionCreate，解码后分派正确、可选字段（shell 缺省）为 None。
#[test]
fn server_to_daemon_envelope_dispatches_to_session_create() {
    let env = ServerToDaemon {
        payload: Some(server_to_daemon::Payload::SessionCreate(SessionCreate {
            session_id: "s1".into(),
            task_id: "t1".into(),
            cwd: "/tmp".into(),
            shell: None,
            cols: 80,
            rows: 24,
        })),
    };
    let bytes = env.encode_to_vec();
    let back = ServerToDaemon::decode(bytes.as_slice()).unwrap();
    match back.payload {
        Some(server_to_daemon::Payload::SessionCreate(m)) => {
            assert_eq!(m.session_id, "s1");
            assert_eq!(m.task_id, "t1");
            assert_eq!(m.cwd, "/tmp");
            assert_eq!(m.shell, None);
            assert_eq!((m.cols, m.rows), (80, 24));
        }
        other => panic!("wrong variant: {other:?}"),
    }
}

/// optional 字段缺省：error=None 往返后仍是 None（且不占用编码字节——省了才叫 optional）。
#[test]
fn optional_error_field_round_trips_when_none() {
    let m = ProjectValidated { request_id: "r".into(), ok: true, repo_path: "/repo".into(), branch: "main".into(), error: None };
    let bytes = m.encode_to_vec();
    let back = ProjectValidated::decode(bytes.as_slice()).unwrap();
    assert_eq!(back.error, None);

    let with_err = ProjectValidated { error: Some("boom".into()), ..m };
    let back2 = ProjectValidated::decode(with_err.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back2.error, Some("boom".into()));
}

/// optional uint32（timeout_ms）同样：None/Some 都要原样往返，不能被悄悄转成 0。
#[test]
fn optional_uint32_round_trips() {
    let m = ExecRun { request_id: "r".into(), cwd: "/".into(), command: "ls".into(), args: vec![], env: Default::default(), timeout_ms: None };
    let back = ExecRun::decode(m.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back.timeout_ms, None);

    let m2 = ExecRun { timeout_ms: Some(5_000), ..m };
    let back2 = ExecRun::decode(m2.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back2.timeout_ms, Some(5_000));
}

/// bytes payload 原样往返：非法 UTF-8 字节（游离延续字节 + NUL）编解码后必须逐字节相同——
/// 这正是本次迁移放弃「pty 输出先按 UTF-8 解码再传」的验收点。
#[test]
fn pty_output_bytes_round_trip_preserves_invalid_utf8() {
    let data: Vec<u8> = vec![0x68, 0x69, 0xff, 0x00, 0x80, 0x81, b'\n'];
    let m = PtyOutput { session_id: "sess-1".into(), data: data.clone() };
    let back = PtyOutput::decode(m.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back.data, data);
    assert!(std::str::from_utf8(&back.data).is_err(), "测试数据本身要确实不是合法 UTF-8");

    // 套进信封走一遍完整分派，确认 oneof 场景下 bytes 依旧不被动过。
    let env = DaemonToServer { payload: Some(daemon_to_server::Payload::PtyOutput(m)) };
    let back_env = DaemonToServer::decode(env.encode_to_vec().as_slice()).unwrap();
    match back_env.payload {
        Some(daemon_to_server::Payload::PtyOutput(p)) => assert_eq!(p.data, data),
        other => panic!("wrong variant: {other:?}"),
    }
}

/// repeated 消息字段（sessions/ports）+ enum 字段（FsEntryKind）往返正确。
#[test]
fn ports_update_and_fs_entry_kind_round_trip() {
    let sessions = vec![SessionPorts { session_id: "s1".into(), ports: vec![3000, 8080] }];
    let m = crate::wire::PortsUpdate { sessions: sessions.clone() };
    let back = crate::wire::PortsUpdate::decode(m.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back.sessions, sessions);

    let entry = FsEntry { name: "src".into(), kind: FsEntryKind::Dir as i32, size: 4096.0 };
    let back_entry = FsEntry::decode(entry.encode_to_vec().as_slice()).unwrap();
    assert_eq!(FsEntryKind::try_from(back_entry.kind).unwrap(), FsEntryKind::Dir);
    assert_eq!(back_entry.size, 4096.0);
}

/// landmine 回归：旧 JSON 版本对 conn_id 有 camelCase 命名坑（connId），protobuf 版本
/// 字段名是 Rust snake_case 结构体字段，不存在这类坑，但仍保留一个显式往返断言防回归。
#[test]
fn proxy_opened_and_closed_round_trip() {
    let opened = DaemonToServer {
        payload: Some(daemon_to_server::Payload::ProxyOpened(crate::wire::ProxyOpened { conn_id: "c2".into(), ok: true, error: None })),
    };
    let back = DaemonToServer::decode(opened.encode_to_vec().as_slice()).unwrap();
    match back.payload {
        Some(daemon_to_server::Payload::ProxyOpened(m)) => {
            assert_eq!(m.conn_id, "c2");
            assert!(m.ok);
            assert_eq!(m.error, None);
        }
        other => panic!("wrong variant: {other:?}"),
    }

    let closed =
        ServerToDaemon { payload: Some(server_to_daemon::Payload::ProxyClose(crate::wire::ProxyClose { conn_id: "c3".into() })) };
    let back2 = ServerToDaemon::decode(closed.encode_to_vec().as_slice()).unwrap();
    assert!(matches!(back2.payload, Some(server_to_daemon::Payload::ProxyClose(m)) if m.conn_id == "c3"));
}

/// 空 payload（oneof 全无 variant）：decode 成功但 payload=None——调用方据此丢弃并记日志，
/// 不 panic（对应「未知 oneof case / 解码失败」的运行时防线）。
#[test]
fn envelope_with_absent_payload_decodes_to_none() {
    let env = DaemonToServer { payload: None };
    let back = DaemonToServer::decode(env.encode_to_vec().as_slice()).unwrap();
    assert!(back.payload.is_none());
}

/// 畸形字节：截断/垃圾数据要让 decode 返回 Err，而不是 panic 或篡改出一条假消息。
#[test]
fn decode_rejects_garbage_bytes() {
    let garbage = [0xffu8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    assert!(DaemonToServer::decode(garbage.as_slice()).is_err());
}

/// need_enroll 等 bool 字段 + DaemonAuthError/DaemonEnrollRequest 分派完整性。
#[test]
fn auth_error_and_enroll_request_round_trip() {
    let m = DaemonAuthError { message: "bad".into(), need_enroll: true };
    let back = DaemonAuthError::decode(m.encode_to_vec().as_slice()).unwrap();
    assert!(back.need_enroll);
    assert_eq!(back.message, "bad");

    let req = DaemonToServer {
        payload: Some(daemon_to_server::Payload::DaemonEnrollRequest(DaemonEnrollRequest { name: "dev".into(), host: "h".into(), platform: "darwin".into() })),
    };
    let back2 = DaemonToServer::decode(req.encode_to_vec().as_slice()).unwrap();
    assert!(matches!(back2.payload, Some(daemon_to_server::Payload::DaemonEnrollRequest(_))));
}
