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
    daemon_to_server, device_envelope, server_to_daemon, DaemonAuthError, DaemonEnrollRequest, DaemonToServer, DeviceEnvelope,
    DevicePtyOutput, DeviceRelayFrame, DeviceSessionAttached, DeviceSessionCreate, ExecRun, FsEntry, FsEntryKind, LocalClientHello,
    PreparedDeviceOperation, ProjectValidated, PtyOutput, ServerToDaemon, SessionCreate, SessionPorts,
};
use crate::{decode_device_envelope, encode_device_envelope, DEVICE_PROTOCOL_VERSION};

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

/// ProjectValidated 的 optional 字段缺省/有值都能原样往返。
#[test]
fn project_validated_optional_fields_round_trip() {
    let m = ProjectValidated {
        request_id: "r".into(),
        ok: true,
        repo_path: "/repo".into(),
        branch: "main".into(),
        error: None,
        suggested_name: None,
    };
    let bytes = m.encode_to_vec();
    let back = ProjectValidated::decode(bytes.as_slice()).unwrap();
    assert_eq!(back.error, None);
    assert_eq!(back.suggested_name, None);

    let with_values = ProjectValidated { error: Some("boom".into()), suggested_name: Some("group/project".into()), ..m };
    let back2 = ProjectValidated::decode(with_values.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back2.error, Some("boom".into()));
    assert_eq!(back2.suggested_name, Some("group/project".into()));
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

/// DeviceEnvelope 直接承载原始 PTY bytes；再套进 relay frame 后，中心只需 opaque 转发，
/// 内层 oneof、channel 与非法 UTF-8 数据都不能发生变化。
#[test]
fn device_envelope_survives_relay_wrapping() {
    let data = vec![0x1b, b'[', b'3', b'1', b'm', 0xff, 0x00];
    let inner = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: "channel-7".into(),
        payload: Some(device_envelope::Payload::PtyOutput(DevicePtyOutput {
            session_id: "session-9".into(),
            from_seq: 4_294_967_301,
            to_seq: 4_294_967_301 + data.len() as u64 - 1,
            data: data.clone(),
        })),
    };
    let relay = DaemonToServer {
        payload: Some(daemon_to_server::Payload::DeviceRelayFrame(DeviceRelayFrame {
            channel_id: "channel-7".into(),
            frame: inner.encode_to_vec(),
        })),
    };

    let decoded_relay = DaemonToServer::decode(relay.encode_to_vec().as_slice()).unwrap();
    let frame = match decoded_relay.payload {
        Some(daemon_to_server::Payload::DeviceRelayFrame(frame)) => frame,
        other => panic!("wrong relay variant: {other:?}"),
    };
    assert_eq!(frame.channel_id, "channel-7");

    let decoded_inner = DeviceEnvelope::decode(frame.frame.as_slice()).unwrap();
    assert_eq!(decoded_inner.protocol_version, DEVICE_PROTOCOL_VERSION);
    assert_eq!(decoded_inner.channel_id, "channel-7");
    match decoded_inner.payload {
        Some(device_envelope::Payload::PtyOutput(output)) => {
            assert_eq!(output.session_id, "session-9");
            assert_eq!(output.from_seq, 4_294_967_301);
            assert_eq!(output.to_seq, 4_294_967_301 + data.len() as u64 - 1);
            assert_eq!(output.data, data);
        }
        other => panic!("wrong device variant: {other:?}"),
    }
}

/// holder/snapshot sequence 是完整 uint64，而不是 JS-safe integer 或 32-bit 计数器；
/// protobuf 往返必须保留高位，才能支撑长寿命 session 与 transport 迁移。
#[test]
fn device_snapshot_uint64_fields_preserve_high_bits() {
    let attached = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: "channel-high-bits".into(),
        payload: Some(device_envelope::Payload::SessionAttached(DeviceSessionAttached {
            request_id: "request-1".into(),
            session_id: "session-1".into(),
            holder_epoch: u64::MAX - 1,
            snapshot_seq: u64::MAX - 1024,
            ansi_snapshot: Some(b"\x1b[2Jready".to_vec()),
            cols: 240,
            rows: 80,
        })),
    };

    let decoded = DeviceEnvelope::decode(attached.encode_to_vec().as_slice()).unwrap();
    match decoded.payload {
        Some(device_envelope::Payload::SessionAttached(value)) => {
            assert_eq!(value.holder_epoch, u64::MAX - 1);
            assert_eq!(value.snapshot_seq, u64::MAX - 1024);
            assert_eq!(value.ansi_snapshot, Some(b"\x1b[2Jready".to_vec()));
        }
        other => panic!("wrong device variant: {other:?}"),
    }
}

/// WebCrypto/Rust handshake 的 SEC1/P1363 bytes 与 transport generation 高位经 protobuf 原样保留。
#[test]
fn local_client_hello_round_trip_preserves_key_material_and_generation() {
    let public_key = [vec![0x04], vec![0x11; 64]].concat();
    let signature = vec![0x22; 64];
    let hello = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: String::new(),
        payload: Some(device_envelope::Payload::LocalClientHello(LocalClientHello {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            grant_id: "grant-1".into(),
            browser_public_key_sec1: public_key.clone(),
            client_instance_id: "client-1".into(),
            transport_generation: 9_007_199_254_740_999,
            lease_id: Some("lease-1".into()),
            gateway_nonce: vec![0x33; 32],
            signature_p1363: signature.clone(),
        })),
    };

    let decoded = DeviceEnvelope::decode(hello.encode_to_vec().as_slice()).unwrap();
    match decoded.payload {
        Some(device_envelope::Payload::LocalClientHello(value)) => {
            assert_eq!(value.browser_public_key_sec1, public_key);
            assert_eq!(value.signature_p1363, signature);
            assert_eq!(value.transport_generation, 9_007_199_254_740_999);
            assert_eq!(value.lease_id.as_deref(), Some("lease-1"));
        }
        other => panic!("wrong local-client-hello variant: {other:?}"),
    }
}

/// prepared operation 经 server→daemon envelope 安装时，内层 DeviceEnvelope 必须原样保留；
/// daemon 后续据此校验 direct/relay 请求除 channel_id 外没有被 browser 篡改。
#[test]
fn prepared_device_operation_template_round_trip() {
    let template = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: String::new(),
        payload: Some(device_envelope::Payload::SessionCreate(DeviceSessionCreate {
            request_id: "request-create".into(),
            operation_id: "operation-create".into(),
            session_id: "session-create".into(),
            task_id: "task-create".into(),
            cwd: "/repo/worktree".into(),
            shell: None,
            cols: 120,
            rows: 40,
        })),
    };
    let outer = ServerToDaemon {
        payload: Some(server_to_daemon::Payload::PreparedDeviceOperation(PreparedDeviceOperation {
            operation_id: "operation-create".into(),
            daemon_id: "daemon-1".into(),
            frame: template.encode_to_vec(),
            expires_at: 1_800_000_000_000.0,
        })),
    };

    let decoded = ServerToDaemon::decode(outer.encode_to_vec().as_slice()).unwrap();
    let prepared = match decoded.payload {
        Some(server_to_daemon::Payload::PreparedDeviceOperation(value)) => value,
        other => panic!("wrong prepared-operation variant: {other:?}"),
    };
    assert_eq!(prepared.operation_id, "operation-create");
    assert_eq!(prepared.daemon_id, "daemon-1");
    let decoded_template = DeviceEnvelope::decode(prepared.frame.as_slice()).unwrap();
    assert!(decoded_template.channel_id.is_empty());
    assert_eq!(decoded_template, template);
}

#[test]
fn rust_device_envelope_helpers_reject_malformed_bytes() {
    let envelope = DeviceEnvelope { protocol_version: DEVICE_PROTOCOL_VERSION, channel_id: "helper-channel".into(), payload: None };
    let encoded = encode_device_envelope(&envelope);
    assert_eq!(decode_device_envelope(&encoded), Some(envelope));
    assert_eq!(decode_device_envelope(&[0xff, 0xff, 0xff]), None);
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
        payload: Some(daemon_to_server::Payload::DaemonEnrollRequest(DaemonEnrollRequest {
            name: "dev".into(),
            host: "h".into(),
            platform: "darwin".into(),
            worker_version: "wv2".into(),
            supervisor_version: "sv2".into(),
            arch: "x86_64".into(),
        })),
    };
    let back2 = DaemonToServer::decode(req.encode_to_vec().as_slice()).unwrap();
    assert!(matches!(back2.payload, Some(daemon_to_server::Payload::DaemonEnrollRequest(_))));
}
