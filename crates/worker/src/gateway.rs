//! 固定 loopback WebSocket gateway。
//!
//! 监听生命周期独立于中心连接：bind 失败只降级 direct，并持续重试；每条连接先按真实 HTTP
//! Origin 完成 P-256 challenge，再把认证后的 DeviceEnvelope 交给统一 runtime。

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::wire::{device_envelope, DeviceEnvelope, LocalAuthResult};
use coflux_protocol::{
    decode_device_envelope, encode_device_envelope, DEVICE_PROTOCOL_VERSION, MAX_DEVICE_FRAME_BYTES,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{Response as HttpResponse, StatusCode};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async_with_config, WebSocketStream};

use crate::device::DeviceRuntime;
use crate::hook::{self, LocalEndpoints};
use crate::local_auth::{AuthFailure, LocalAuth};

const AUTH_TIMEOUT: Duration = Duration::from_secs(20);
const BIND_RETRY: Duration = Duration::from_millis(250);
/// 分流 peek 的等待上限：正常客户端连上即发请求首字节，超时按 WS 处理（由握手路径报错）。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub type DaemonIdProvider = Arc<dyn Fn() -> Option<String> + Send + Sync>;
pub type GatewayStatus = Arc<dyn Fn(Option<u16>) + Send + Sync>;

pub async fn run(
    requested_port: u16,
    auth: Arc<LocalAuth>,
    runtime: Arc<DeviceRuntime>,
    daemon_id: DaemonIdProvider,
    status: GatewayStatus,
    endpoints: Arc<LocalEndpoints>,
) {
    loop {
        let (port, listeners) = match bind_loopbacks(requested_port).await {
            Some(bound) => bound,
            None => {
                status(None);
                tokio::time::sleep(BIND_RETRY).await;
                continue;
            }
        };
        eprintln!("[worker] local gateway listening port={port}");
        status(Some(port));

        let mut loops: Vec<Pin<Box<dyn Future<Output = ()> + Send>>> = listeners
            .into_iter()
            .map(|listener| {
                let auth = auth.clone();
                let runtime = runtime.clone();
                let daemon_id = daemon_id.clone();
                let endpoints = endpoints.clone();
                Box::pin(accept_loop(listener, auth, runtime, daemon_id, endpoints))
                    as Pin<Box<dyn Future<Output = ()> + Send>>
            })
            .collect();
        if loops.len() == 1 {
            loops.pop().unwrap().await;
        } else {
            let _ = futures_util::future::select_all(loops).await;
        }
        status(None);
        tokio::time::sleep(BIND_RETRY).await;
    }
}

async fn bind_loopbacks(requested_port: u16) -> Option<(u16, Vec<TcpListener>)> {
    let mut listeners = Vec::new();
    let mut actual_port = requested_port;

    if let Ok(listener) = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, requested_port)).await {
        actual_port = listener.local_addr().ok()?.port();
        listeners.push(listener);
    }
    let ipv6_port = if requested_port == 0 {
        actual_port
    } else {
        requested_port
    };
    if let Ok(listener) = TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, ipv6_port)).await {
        if listeners.is_empty() {
            actual_port = listener.local_addr().ok()?.port();
        }
        listeners.push(listener);
    }
    (!listeners.is_empty()).then_some((actual_port, listeners))
}

async fn accept_loop(
    listener: TcpListener,
    auth: Arc<LocalAuth>,
    runtime: Arc<DeviceRuntime>,
    daemon_id: DaemonIdProvider,
    endpoints: Arc<LocalEndpoints>,
) {
    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let auth = auth.clone();
                let runtime = runtime.clone();
                let daemon_id = daemon_id.clone();
                let endpoints = endpoints.clone();
                tokio::spawn(async move {
                    if let Err(error) =
                        handle_connection(stream, auth, runtime, daemon_id, endpoints).await
                    {
                        eprintln!("[worker] local gateway connection closed: {error}");
                    }
                });
            }
            Err(error) => {
                eprintln!("[worker] local gateway accept error: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// peek 首 5 字节分流：`POST ` 开头是本地端点的纯 HTTP 请求（hook 上报与 agent 控制，
/// 见 [crate::hook]——唯二的非 WS 路径），其余（GET 升级请求）走原有 WebSocket 握手。
/// peek 不消费字节，两条路径都拿到完整请求。
async fn probe_is_post(stream: &TcpStream) -> bool {
    let probe = async {
        let mut buffer = [0u8; 5];
        loop {
            match stream.peek(&mut buffer).await {
                Ok(0) | Err(_) => return false,
                Ok(n) if n >= 5 => return &buffer[..5] == b"POST ",
                // 前缀是 "POST " 真前缀才值得等更多字节；否则（如 "GET /"）立即定案
                Ok(n) if &buffer[..n] != &b"POST "[..n] => return false,
                Ok(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
    };
    tokio::time::timeout(PROBE_TIMEOUT, probe)
        .await
        .unwrap_or(false)
}

async fn handle_connection(
    stream: TcpStream,
    auth: Arc<LocalAuth>,
    runtime: Arc<DeviceRuntime>,
    daemon_id: DaemonIdProvider,
    endpoints: Arc<LocalEndpoints>,
) -> Result<(), String> {
    if probe_is_post(&stream).await {
        return hook::serve(stream, endpoints).await;
    }
    let captured_origin = Arc::new(Mutex::new(None::<String>));
    let callback_origin = captured_origin.clone();
    let callback_auth = auth.clone();
    let callback =
        move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            if request.uri().path() != "/device" || request.uri().query().is_some() {
                return Err(reject(StatusCode::NOT_FOUND, "gateway path 不存在"));
            }
            let Some(origin) = request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
            else {
                return Err(reject(StatusCode::FORBIDDEN, "缺少 Origin"));
            };
            if !callback_auth.origin_allowed(origin) {
                return Err(reject(StatusCode::FORBIDDEN, "Origin denied"));
            }
            *callback_origin.lock().unwrap() = Some(origin.to_string());
            Ok(response)
        };
    let config = WebSocketConfig {
        max_write_buffer_size: MAX_DEVICE_FRAME_BYTES + 2 * 1024 * 1024,
        max_message_size: Some(MAX_DEVICE_FRAME_BYTES),
        max_frame_size: Some(MAX_DEVICE_FRAME_BYTES),
        ..WebSocketConfig::default()
    };
    let mut websocket = accept_hdr_async_with_config(stream, callback, Some(config))
        .await
        .map_err(|error| format!("WebSocket handshake: {error}"))?;
    let origin = captured_origin
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "Origin capture 丢失".to_string())?;
    let Some(daemon_id) = daemon_id() else {
        send_auth_failure(
            &mut websocket,
            AuthFailure {
                code: coflux_protocol::wire::LocalAuthErrorCode::GrantUnknown,
                message: "daemon 尚未登记",
            },
        )
        .await;
        return Ok(());
    };
    let mut challenge = match auth.begin_challenge(&daemon_id, &origin) {
        Ok(challenge) => challenge,
        Err(error) => {
            send_auth_failure(&mut websocket, error).await;
            return Ok(());
        }
    };
    let gateway_hello = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: String::new(),
        payload: Some(device_envelope::Payload::LocalGatewayHello(
            challenge.hello.clone(),
        )),
    };
    websocket
        .send(Message::binary(encode_device_envelope(&gateway_hello)))
        .await
        .map_err(|error| format!("发送 gateway hello: {error}"))?;

    let incoming = tokio::time::timeout(AUTH_TIMEOUT, websocket.next())
        .await
        .map_err(|_| "等待 LocalClientHello 超时".to_string())?;
    let client_hello = match incoming {
        Some(Ok(Message::Binary(bytes))) => {
            let envelope = decode_device_envelope(&bytes)
                .ok_or_else(|| "LocalClientHello envelope 畸形".to_string())?;
            if envelope.protocol_version != DEVICE_PROTOCOL_VERSION
                || !envelope.channel_id.is_empty()
            {
                send_auth_failure(
                    &mut websocket,
                    AuthFailure {
                        code: coflux_protocol::wire::LocalAuthErrorCode::VersionMismatch,
                        message: "握手 envelope version/channel 无效",
                    },
                )
                .await;
                return Ok(());
            }
            match envelope.payload {
                Some(device_envelope::Payload::LocalClientHello(hello)) => hello,
                _ => return Err("首个 payload 不是 LocalClientHello".into()),
            }
        }
        Some(Ok(_)) => return Err("LocalClientHello 必须是 binary frame".into()),
        Some(Err(error)) => return Err(format!("读取 LocalClientHello: {error}")),
        None => return Ok(()),
    };
    let authenticated = match auth.authenticate(&mut challenge, &client_hello) {
        Ok(authenticated) => authenticated,
        Err(error) => {
            send_auth_failure(&mut websocket, error).await;
            return Ok(());
        }
    };
    let scopes = authenticated.scopes.clone();
    let (channel_id, mut outbound) = match runtime.open_local(authenticated) {
        Ok(channel) => channel,
        Err(message) => {
            send_failure(
                &mut websocket,
                coflux_protocol::wire::LocalAuthErrorCode::Unspecified,
                &message,
            )
            .await;
            return Ok(());
        }
    };
    let auth_result = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: String::new(),
        payload: Some(device_envelope::Payload::LocalAuthResult(LocalAuthResult {
            ok: true,
            channel_id: Some(channel_id.clone()),
            scopes,
            error: None,
            error_code: coflux_protocol::wire::LocalAuthErrorCode::Unspecified as i32,
        })),
    };
    if websocket
        .send(Message::binary(encode_device_envelope(&auth_result)))
        .await
        .is_err()
    {
        runtime.close_channel(&channel_id);
        return Ok(());
    }

    loop {
        tokio::select! {
            outgoing = outbound.recv() => {
                let Some(bytes) = outgoing else { break };
                if websocket.send(Message::binary(bytes)).await.is_err() {
                    break;
                }
            }
            incoming = websocket.next() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => runtime.handle_client_frame(&channel_id, &bytes),
                    Some(Ok(Message::Ping(payload))) => {
                        if websocket.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
    runtime.close_channel(&channel_id);
    Ok(())
}

fn reject(status: StatusCode, message: &str) -> ErrorResponse {
    HttpResponse::builder()
        .status(status)
        .body(Some(message.to_string()))
        .expect("固定 gateway HTTP error response")
}

async fn send_auth_failure(websocket: &mut WebSocketStream<TcpStream>, error: AuthFailure) {
    send_failure(websocket, error.code, error.message).await;
}

async fn send_failure(
    websocket: &mut WebSocketStream<TcpStream>,
    code: coflux_protocol::wire::LocalAuthErrorCode,
    message: &str,
) {
    let envelope = DeviceEnvelope {
        protocol_version: DEVICE_PROTOCOL_VERSION,
        channel_id: String::new(),
        payload: Some(device_envelope::Payload::LocalAuthResult(LocalAuthResult {
            ok: false,
            channel_id: None,
            scopes: Vec::new(),
            error: Some(message.to_string()),
            error_code: code as i32,
        })),
    };
    let _ = websocket
        .send(Message::binary(encode_device_envelope(&envelope)))
        .await;
    let _ = websocket.close(None).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use coflux_protocol::wire::{
        DeviceScope, DeviceSessionCatalogRequest, LocalBrowserGrant, LocalClientHello,
    };
    use coflux_protocol::{decode_frame, is_frame, RecordParser};
    use p256::ecdsa::signature::{Signer, Verifier};
    use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
    use rand_core::{OsRng, RngCore};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    use crate::local_auth::{client_transcript, gateway_transcript};

    fn temp_home() -> String {
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let path = std::env::temp_dir().join(format!(
            "coflux-local-gateway-{}-{}",
            std::process::id(),
            hex::encode(random)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn local_gateway_authenticates_and_forwards_device_frame() {
        let home = temp_home();
        let auth = Arc::new(LocalAuth::load_or_create(&home).unwrap());
        auth.configure_origins(vec!["https://p.coflux.dev".into()])
            .unwrap();
        let browser_key = SigningKey::random(&mut OsRng);
        let browser_public_key = browser_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        auth.install_grant(
            LocalBrowserGrant {
                grant_id: "grant-1".into(),
                account_id: "account-1".into(),
                daemon_id: "daemon-1".into(),
                origin: "https://p.coflux.dev".into(),
                public_key_sec1: browser_public_key.clone(),
                offline_scopes: vec![
                    DeviceScope::SessionRead as i32,
                    DeviceScope::SessionControl as i32,
                ],
                created_at: 1.0,
            },
            "daemon-1",
        )
        .unwrap();
        let (to_supervisor, mut from_gateway) = tokio::sync::mpsc::channel(8);
        let (to_server, _from_runtime) = tokio::sync::mpsc::channel(8);
        let runtime = DeviceRuntime::new(Some(auth.clone()), to_supervisor, to_server);
        let (status_tx, mut status_rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(run(
            0,
            auth.clone(),
            runtime,
            Arc::new(|| Some("daemon-1".into())),
            Arc::new(move |status| {
                let _ = status_tx.send(status);
            }),
            Arc::new(crate::hook::LocalEndpoints {
                hook_tx: tokio::sync::mpsc::channel(4).0,
            }),
        ));
        let port = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(Some(port)) = status_rx.recv().await {
                    break port;
                }
            }
        })
        .await
        .unwrap();

        let mut request = format!("ws://127.0.0.1:{port}/device")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", "https://p.coflux.dev".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let gateway_envelope = match socket.next().await.unwrap().unwrap() {
            Message::Binary(bytes) => decode_device_envelope(&bytes).unwrap(),
            other => panic!("unexpected gateway message: {other:?}"),
        };
        let gateway_hello = match gateway_envelope.payload.unwrap() {
            device_envelope::Payload::LocalGatewayHello(hello) => hello,
            _ => panic!("expected gateway hello"),
        };
        let gateway_key =
            VerifyingKey::from_sec1_bytes(&gateway_hello.gateway_public_key_sec1).unwrap();
        let gateway_signature = Signature::from_slice(&gateway_hello.signature_p1363).unwrap();
        gateway_key
            .verify(
                &gateway_transcript(
                    gateway_hello.protocol_version,
                    &gateway_hello.daemon_id,
                    &gateway_hello.origin,
                    &gateway_hello.nonce,
                ),
                &gateway_signature,
            )
            .unwrap();

        let mut client_hello = LocalClientHello {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            grant_id: "grant-1".into(),
            browser_public_key_sec1: browser_public_key,
            client_instance_id: "client-1".into(),
            transport_generation: 1,
            lease_id: None,
            gateway_nonce: gateway_hello.nonce.clone(),
            signature_p1363: Vec::new(),
        };
        let signature: Signature = browser_key.sign(&client_transcript(
            client_hello.protocol_version,
            &gateway_hello.daemon_id,
            &gateway_hello.origin,
            &gateway_hello.nonce,
            &gateway_hello.gateway_public_key_sec1,
            &client_hello.grant_id,
            &client_hello.browser_public_key_sec1,
            &client_hello.client_instance_id,
            client_hello.transport_generation,
            None,
        ));
        client_hello.signature_p1363 = signature.to_bytes().to_vec();
        let hello_envelope = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: String::new(),
            payload: Some(device_envelope::Payload::LocalClientHello(client_hello)),
        };
        socket
            .send(Message::binary(encode_device_envelope(&hello_envelope)))
            .await
            .unwrap();
        let auth_envelope = match socket.next().await.unwrap().unwrap() {
            Message::Binary(bytes) => decode_device_envelope(&bytes).unwrap(),
            _ => panic!("expected auth result"),
        };
        let auth_result = match auth_envelope.payload.unwrap() {
            device_envelope::Payload::LocalAuthResult(result) => result,
            _ => panic!("expected auth result"),
        };
        assert!(auth_result.ok);
        let channel_id = auth_result.channel_id.unwrap();

        let request = DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.clone(),
            payload: Some(device_envelope::Payload::SessionCatalogRequest(
                DeviceSessionCatalogRequest {
                    request_id: "catalog-1".into(),
                    ..Default::default()
                },
            )),
        };
        socket
            .send(Message::binary(encode_device_envelope(&request)))
            .await
            .unwrap();
        let record = tokio::time::timeout(Duration::from_secs(1), from_gateway.recv())
            .await
            .unwrap()
            .unwrap();
        let mut parser = RecordParser::new();
        let mut parsed = Vec::new();
        parser
            .push(&record, |value| parsed.push(value.to_vec()))
            .unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(is_frame(&parsed[0]));
        match decode_frame(&parsed[0]).unwrap() {
            coflux_protocol::DataFrame::Device {
                channel_id: actual, ..
            } => assert_eq!(actual, channel_id),
            _ => panic!("expected Device IPC frame"),
        }

        let _ = socket.close(None).await;
        task.abort();
        let _ = task.await;
        std::fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn local_gateway_loopback_bind_uses_an_ephemeral_port() {
        let (port, listeners) = bind_loopbacks(0).await.unwrap();
        assert_ne!(port, 0);
        assert!(listeners
            .iter()
            .all(|listener| listener.local_addr().unwrap().ip().is_loopback()));
    }

    #[tokio::test]
    async fn local_gateway_rejects_unlisted_http_origin_before_websocket_auth() {
        let home = temp_home();
        let auth = Arc::new(LocalAuth::load_or_create(&home).unwrap());
        auth.configure_origins(vec!["https://p.coflux.dev".into()])
            .unwrap();
        let (to_supervisor, _from_gateway) = tokio::sync::mpsc::channel(8);
        let (to_server, _from_runtime) = tokio::sync::mpsc::channel(8);
        let runtime = DeviceRuntime::new(Some(auth.clone()), to_supervisor, to_server);
        let (status_tx, mut status_rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(run(
            0,
            auth,
            runtime,
            Arc::new(|| Some("daemon-1".into())),
            Arc::new(move |status| {
                let _ = status_tx.send(status);
            }),
            Arc::new(crate::hook::LocalEndpoints {
                hook_tx: tokio::sync::mpsc::channel(4).0,
            }),
        ));
        let port = loop {
            if let Some(Some(port)) = status_rx.recv().await {
                break port;
            }
        };
        let mut request = format!("ws://127.0.0.1:{port}/device")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", "https://evil.example".parse().unwrap());
        assert!(tokio_tungstenite::connect_async(request).await.is_err());
        task.abort();
        let _ = task.await;
        std::fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn local_gateway_rebinds_the_same_port_after_worker_restart() {
        let home = temp_home();
        let auth = Arc::new(LocalAuth::load_or_create(&home).unwrap());
        let (to_supervisor, _from_gateway) = tokio::sync::mpsc::channel(8);
        let (to_server, _from_runtime) = tokio::sync::mpsc::channel(8);
        let runtime = DeviceRuntime::new(Some(auth.clone()), to_supervisor, to_server);

        let (first_tx, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
        let first = tokio::spawn(run(
            0,
            auth.clone(),
            runtime.clone(),
            Arc::new(|| Some("daemon-1".into())),
            Arc::new(move |status| {
                let _ = first_tx.send(status);
            }),
            Arc::new(crate::hook::LocalEndpoints {
                hook_tx: tokio::sync::mpsc::channel(4).0,
            }),
        ));
        let port = loop {
            if let Some(Some(port)) = first_rx.recv().await {
                break port;
            }
        };
        first.abort();
        let _ = first.await;

        let (second_tx, mut second_rx) = tokio::sync::mpsc::unbounded_channel();
        let second = tokio::spawn(run(
            port,
            auth,
            runtime,
            Arc::new(|| Some("daemon-1".into())),
            Arc::new(move |status| {
                let _ = second_tx.send(status);
            }),
            Arc::new(crate::hook::LocalEndpoints {
                hook_tx: tokio::sync::mpsc::channel(4).0,
            }),
        ));
        let rebound = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(Some(port)) = second_rx.recv().await {
                    break port;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(rebound, port);
        second.abort();
        let _ = second.await;
        std::fs::remove_dir_all(home).unwrap();
    }
}
