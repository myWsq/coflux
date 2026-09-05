//! [crate::wire]（prost 生成类型）的编解码往返测试。
//!
//! 取代旧 `wire.rs` 里针对 serde JSON 内部标签格式的测试：这里验证的是新 wire
//! format——WS 上每条消息是一个 protobuf 编码的信封（[wire::DaemonToServer] /
//! [wire::ServerToDaemon]），覆盖三个关键点：
//! - 信封 oneof 分派：encode 一个具体 payload variant，decode 后 match 回同一 variant。
//! - optional 字段缺省：`None` 不下线、往返后仍是 `None`；`Some` 往返后原样保留。
//! - bytes payload 原样往返：DeviceEnvelope 内的 PTY 与外层 relay bytes 都不得被中心改写。

use prost::Message;

use crate::wire::{
    daemon_to_server, device_envelope, server_to_daemon, DaemonAuthError, DaemonEnrollRequest,
    DaemonToServer, DeviceEnvelope, DeviceExecRun, DevicePtyInputAck, DevicePtyOutput,
    DeviceRelayDial, DeviceScope, DeviceSessionAttached, DeviceSessionCreate, FsEntry, FsEntryKind,
    LocalClientHello, PreparedDeviceOperation, ProjectValidated, ServerToDaemon, SessionCreate,
    SessionPorts,
};
use crate::{decode_device_envelope, encode_device_envelope, DEVICE_PROTOCOL_VERSION};

#[derive(Clone, PartialEq, Message)]
struct LegacyDaemonResync {
    #[prost(message, repeated, tag = "1")]
    sessions: Vec<crate::wire::SessionRef>,
}

#[derive(Clone, PartialEq, Message)]
struct LegacyDeviceSessionCatalogRequest {
    #[prost(string, tag = "1")]
    request_id: String,
}

#[derive(Clone, PartialEq, Message)]
struct LegacyDeviceSessionCatalog {
    #[prost(string, tag = "1")]
    request_id: String,
    #[prost(message, repeated, tag = "2")]
    sessions: Vec<crate::wire::DeviceSessionInfo>,
    #[prost(message, repeated, tag = "3")]
    exits: Vec<crate::wire::DeviceSessionExitTombstone>,
}

#[derive(Clone, PartialEq, Message)]
struct LegacyDeviceExitAck {
    #[prost(string, repeated, tag = "1")]
    event_ids: Vec<String>,
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

    let with_values = ProjectValidated {
        error: Some("boom".into()),
        suggested_name: Some("group/project".into()),
        ..m
    };
    let back2 = ProjectValidated::decode(with_values.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back2.error, Some("boom".into()));
    assert_eq!(back2.suggested_name, Some("group/project".into()));
}

/// optional uint32（timeout_ms）同样：None/Some 都要原样往返，不能被悄悄转成 0。
#[test]
fn optional_uint32_round_trips() {
    let m = DeviceExecRun {
        request_id: "r".into(),
        workspace_id: "workspace-1".into(),
        command: "ls".into(),
        args: vec![],
        env: Default::default(),
        timeout_ms: None,
        operation_id: None,
    };
    let back = DeviceExecRun::decode(m.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back.timeout_ms, None);

    let m2 = DeviceExecRun {
        timeout_ms: Some(5_000),
        ..m
    };
    let back2 = DeviceExecRun::decode(m2.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back2.timeout_ms, Some(5_000));
}

#[test]
fn device_input_ack_round_trip_preserves_cumulative_u64_cursor() {
    let envelope = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: "channel-input".into(),
        payload: Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
            session_id: "session-input".into(),
            applied_through_seq: u64::from(u32::MAX) + 7,
        })),
    };
    let decoded = decode_device_envelope(&encode_device_envelope(&envelope)).unwrap();
    assert_eq!(decoded.channel_id, "channel-input");
    assert!(matches!(
        decoded.payload,
        Some(device_envelope::Payload::PtyInputAck(DevicePtyInputAck {
            ref session_id,
            applied_through_seq,
        })) if session_id == "session-input" && applied_through_seq == u64::from(u32::MAX) + 7
    ));
}

/// relay 数据面（plan 043）：DeviceEnvelope 以原始 protobuf bytes 直接走 relay WS，
/// 不再有外层 wrap。opaque 往返 = encode 后 decode，内层 oneof、channel 与非法 UTF-8
/// PTY 数据都不能发生变化——这是 relay 二进制"零解析转发"的 wire 前提。
#[test]
fn device_envelope_bytes_roundtrip_for_opaque_relay() {
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

    // relay 视角：拿到的只是 bytes，转发前后必须逐字节一致。
    let frame = inner.encode_to_vec();
    let forwarded = frame.clone();
    assert_eq!(forwarded, frame);

    let decoded_inner = DeviceEnvelope::decode(forwarded.as_slice()).unwrap();
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

/// rendezvous 拨号指令（plan 043）：ServerToDaemon 携带 DeviceRelayDial，scopes 枚举、
/// URL 与 generation 必须原样往返——daemon 信任控制面授予的 scopes，错一位就是权限错位。
#[test]
fn server_to_daemon_relay_dial_roundtrips() {
    let env = ServerToDaemon {
        payload: Some(server_to_daemon::Payload::DeviceRelayDial(
            DeviceRelayDial {
                channel_id: "relay-abc".into(),
                relay_url: "wss://relay.example/v1/pipe?token=p.s".into(),
                account_id: "acct-1".into(),
                client_instance_id: "client-1".into(),
                transport_generation: u64::from(u32::MAX) + 11,
                scopes: vec![
                    DeviceScope::SessionRead as i32,
                    DeviceScope::SessionControl as i32,
                    DeviceScope::Rpc as i32,
                    DeviceScope::Lifecycle as i32,
                ],
                protocol_version: DEVICE_PROTOCOL_VERSION,
            },
        )),
    };
    let decoded = ServerToDaemon::decode(env.encode_to_vec().as_slice()).unwrap();
    match decoded.payload {
        Some(server_to_daemon::Payload::DeviceRelayDial(dial)) => {
            assert_eq!(dial.channel_id, "relay-abc");
            assert_eq!(dial.relay_url, "wss://relay.example/v1/pipe?token=p.s");
            assert_eq!(dial.account_id, "acct-1");
            assert_eq!(dial.client_instance_id, "client-1");
            assert_eq!(dial.transport_generation, u64::from(u32::MAX) + 11);
            assert_eq!(dial.scopes.len(), 4);
            assert_eq!(dial.protocol_version, DEVICE_PROTOCOL_VERSION);
        }
        other => panic!("wrong variant: {other:?}"),
    }
}

/// holder/snapshot sequence 是完整 uint64，而不是 JS-safe integer 或 32-bit 计数器；
/// protobuf 往返必须保留高位，才能支撑长寿命 session 与 transport 迁移。
#[test]
fn device_snapshot_uint64_fields_preserve_high_bits() {
    let attached = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: "channel-high-bits".into(),
        payload: Some(device_envelope::Payload::SessionAttached(
            DeviceSessionAttached {
                request_id: "request-1".into(),
                session_id: "session-1".into(),
                holder_epoch: u64::MAX - 1,
                snapshot_seq: u64::MAX - 1024,
                ansi_snapshot: Some(b"\x1b[2Jready".to_vec()),
                cols: 240,
                rows: 80,
            },
        )),
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
        payload: Some(device_envelope::Payload::LocalClientHello(
            LocalClientHello {
                protocol_version: DEVICE_PROTOCOL_VERSION,
                grant_id: "grant-1".into(),
                browser_public_key_sec1: public_key.clone(),
                client_instance_id: "client-1".into(),
                transport_generation: 9_007_199_254_740_999,
                lease_id: Some("lease-1".into()),
                gateway_nonce: vec![0x33; 32],
                signature_p1363: signature.clone(),
            },
        )),
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
        payload: Some(device_envelope::Payload::SessionCreate(
            DeviceSessionCreate {
                request_id: "request-create".into(),
                operation_id: "operation-create".into(),
                session_id: "session-create".into(),
                task_id: "task-create".into(),
                cwd: "/repo/worktree".into(),
                shell: None,
                cols: 120,
                rows: 40,
                command: String::new(),
            },
        )),
    };
    let outer = ServerToDaemon {
        payload: Some(server_to_daemon::Payload::PreparedDeviceOperation(
            PreparedDeviceOperation {
                operation_id: "operation-create".into(),
                daemon_id: "daemon-1".into(),
                frame: template.encode_to_vec(),
                expires_at: 1_800_000_000_000.0,
            },
        )),
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
    let envelope = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: "helper-channel".into(),
        payload: None,
    };
    let encoded = encode_device_envelope(&envelope);
    assert_eq!(decode_device_envelope(&encoded), Some(envelope));
    assert_eq!(decode_device_envelope(&[0xff, 0xff, 0xff]), None);
}

/// repeated 消息字段（sessions/ports）+ enum 字段（FsEntryKind）往返正确。
#[test]
fn ports_update_and_fs_entry_kind_round_trip() {
    let sessions = vec![SessionPorts {
        session_id: "s1".into(),
        ports: vec![3000, 8080],
    }];
    let m = crate::wire::PortsUpdate {
        sessions: sessions.clone(),
    };
    let back = crate::wire::PortsUpdate::decode(m.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back.sessions, sessions);

    let entry = FsEntry {
        name: "src".into(),
        kind: FsEntryKind::Dir as i32,
        size: 4096.0,
    };
    let back_entry = FsEntry::decode(entry.encode_to_vec().as_slice()).unwrap();
    assert_eq!(
        FsEntryKind::try_from(back_entry.kind).unwrap(),
        FsEntryKind::Dir
    );
    assert_eq!(back_entry.size, 4096.0);
}

/// landmine 回归：旧 JSON 版本对 conn_id 有 camelCase 命名坑（connId），protobuf 版本
/// 字段名是 Rust snake_case 结构体字段，不存在这类坑，但仍保留一个显式往返断言防回归。
#[test]
fn proxy_opened_and_closed_round_trip() {
    let opened = DaemonToServer {
        payload: Some(daemon_to_server::Payload::ProxyOpened(
            crate::wire::ProxyOpened {
                conn_id: "c2".into(),
                ok: true,
                error: None,
            },
        )),
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

    let closed = ServerToDaemon {
        payload: Some(server_to_daemon::Payload::ProxyClose(
            crate::wire::ProxyClose {
                conn_id: "c3".into(),
            },
        )),
    };
    let back2 = ServerToDaemon::decode(closed.encode_to_vec().as_slice()).unwrap();
    assert!(
        matches!(back2.payload, Some(server_to_daemon::Payload::ProxyClose(m)) if m.conn_id == "c3")
    );
}

#[test]
fn resync_snapshot_metadata_keeps_legacy_protobuf_readable_both_ways() {
    let session = crate::wire::SessionRef {
        session_id: "session-1".into(),
        task_id: "task-1".into(),
    };
    let decoded = crate::wire::DaemonResync::decode(
        LegacyDaemonResync {
            sessions: vec![session.clone()],
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(decoded.sessions, vec![session.clone()]);
    assert!(decoded.snapshot_owner_id.is_empty());
    assert_eq!(decoded.snapshot_epoch, 0);

    let legacy = LegacyDaemonResync::decode(
        crate::wire::DaemonResync {
            sessions: vec![session.clone()],
            snapshot_owner_id: "owner-1".into(),
            snapshot_epoch: 7,
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(legacy.sessions, vec![session]);
}

#[test]
fn catalog_paging_and_bound_ack_fields_default_for_legacy_messages() {
    let request = crate::wire::DeviceSessionCatalogRequest::decode(
        LegacyDeviceSessionCatalogRequest {
            request_id: "catalog-1".into(),
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(request.request_id, "catalog-1");
    assert!(request.snapshot_owner_id.is_empty());
    assert_eq!(request.snapshot_epoch, 0);
    assert_eq!(request.session_offset, 0);
    assert_eq!(request.exit_offset, 0);
    assert_eq!(request.max_page_bytes, 0);

    let session = crate::wire::DeviceSessionInfo {
        session_id: "session-1".into(),
        task_id: "task-1".into(),
        pid: 42,
        ..Default::default()
    };
    let exit = crate::wire::DeviceSessionExitTombstone {
        event_id: "exit-1".into(),
        session_id: "session-1".into(),
        task_id: "task-1".into(),
        exit_code: 0,
        ..Default::default()
    };
    let catalog = crate::wire::DeviceSessionCatalog::decode(
        LegacyDeviceSessionCatalog {
            request_id: "catalog-1".into(),
            sessions: vec![session.clone()],
            exits: vec![exit.clone()],
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(catalog.sessions, vec![session.clone()]);
    assert_eq!(catalog.exits, vec![exit.clone()]);
    assert!(catalog.snapshot_owner_id.is_empty());
    assert_eq!(catalog.snapshot_epoch, 0);
    assert_eq!(catalog.session_offset, 0);
    assert_eq!(catalog.exit_offset, 0);
    assert_eq!(catalog.next_session_offset, 0);
    assert_eq!(catalog.next_exit_offset, 0);
    assert!(!catalog.complete);
    assert!(!catalog.reset);

    let legacy_catalog = LegacyDeviceSessionCatalog::decode(
        crate::wire::DeviceSessionCatalog {
            request_id: "catalog-2".into(),
            sessions: vec![session],
            exits: vec![exit],
            snapshot_owner_id: "owner-2".into(),
            snapshot_epoch: 9,
            session_offset: 1,
            exit_offset: 2,
            next_session_offset: 3,
            next_exit_offset: 4,
            complete: true,
            reset: false,
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(legacy_catalog.request_id, "catalog-2");
    assert_eq!(legacy_catalog.sessions.len(), 1);
    assert_eq!(legacy_catalog.exits.len(), 1);

    let ack = crate::wire::DeviceExitAck::decode(
        LegacyDeviceExitAck {
            event_ids: vec!["exit-1".into()],
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(ack.event_ids, vec!["exit-1"]);
    assert!(ack.request_id.is_empty());
    assert!(ack.snapshot_owner_id.is_empty());
    assert_eq!(ack.snapshot_epoch, 0);

    let legacy_ack = LegacyDeviceExitAck::decode(
        crate::wire::DeviceExitAck {
            event_ids: vec!["exit-2".into()],
            request_id: "catalog-2".into(),
            snapshot_owner_id: "owner-2".into(),
            snapshot_epoch: 9,
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(legacy_ack.event_ids, vec!["exit-2"]);
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
    let m = DaemonAuthError {
        message: "bad".into(),
        need_enroll: true,
    };
    let back = DaemonAuthError::decode(m.encode_to_vec().as_slice()).unwrap();
    assert!(back.need_enroll);
    assert_eq!(back.message, "bad");

    let req = DaemonToServer {
        payload: Some(daemon_to_server::Payload::DaemonEnrollRequest(
            DaemonEnrollRequest {
                name: "dev".into(),
                host: "h".into(),
                platform: "darwin".into(),
                worker_version: "wv2".into(),
                supervisor_version: "sv2".into(),
                arch: "x86_64".into(),
                capabilities: Vec::new(),
            },
        )),
    };
    let back2 = DaemonToServer::decode(req.encode_to_vec().as_slice()).unwrap();
    assert!(matches!(
        back2.payload,
        Some(daemon_to_server::Payload::DaemonEnrollRequest(_))
    ));
}
