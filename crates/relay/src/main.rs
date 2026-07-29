//! coflux-relay：独立部署的 Device relay（plan 043）。
//!
//! 只做三件事：验中心签发的短时 token、按 channelId 把 client/daemon 两条 WS 配对、
//! 做 opaque 字节管道 + 限速限量。帧是端到端 DeviceEnvelope 的 protobuf bytes，本进程
//! 刻意不解码——业务权限、exactly-once 与 holder 语义全部在 worker/sessiond（与旧
//! server 内嵌 relay 的 opaque 原则一致，见 plans/043）。
//!
//! 部署：静态二进制 + systemd，TLS 由 Caddy 终结（本进程只听明文 ws）。
//! env：`COFLUX_RELAY_LISTEN`（默认 127.0.0.1:8790，端口 0 = 随机）、
//!      `COFLUX_RELAY_PUBKEY`（中心签名公钥，hex 裸 32B，必填——同
//!      `COFLUX_WORKER_PUBKEY` 的注入惯例）。
//! 就绪信号：bind 成功后向 stdout 打印一行 `coflux-relay listening on <addr>`，
//! 供 harness/运维解析实际端口。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use coflux_protocol::MAX_DEVICE_FRAME_BYTES;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{Response as HttpResponse, StatusCode};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async_with_config, WebSocketStream};

/// 与旧 apps/server/src/device-relay.ts 相同的限额语义；无账号概念，
/// per-client/per-daemon 维度退化为全局 channel 上限 + 每方向限速。
const MAX_CHANNELS_TOTAL: usize = 10_000;
const MAX_FRAMES_PER_SECOND: u32 = 2048;
const MAX_BYTES_PER_SECOND: usize = 128 * 1024 * 1024;
const MAX_ID_BYTES: usize = 256;
/// 单侧到达后等待对端的窗口；超时即关闭并留 tombstone。
const PAIR_TIMEOUT: Duration = Duration::from_secs(10);
/// channel 结束后拒绝同 channelId 重连的窗口：≥ token TTL 上限，使 token 重放必然失败。
const TOMBSTONE_TTL: Duration = Duration::from_secs(120);
/// token 签名的 domain separation 前缀（`域 + 0x00 + payload`，同 local gateway 签名惯例）。
const TOKEN_DOMAIN: &[u8] = b"coflux-relay-token-v1";
const TOKEN_VERSION: u32 = 1;
const HEALTHZ_REQUEST_PREFIX: &[u8] = b"GET /healthz ";
const MAX_HEALTHZ_REQUEST_BYTES: usize = 8 * 1024;
const HEALTHZ_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n";

type Ws = WebSocketStream<TcpStream>;

#[derive(serde::Deserialize)]
struct TokenClaims {
    v: u32,
    #[serde(rename = "channelId")]
    channel_id: String,
    role: String,
    /// Unix epoch ms（与 proto 各时间戳同单位）。
    exp: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Client,
    Daemon,
}

enum Slot {
    /// 先到的一侧在等对端；second 到达后把自己的 socket 从 oneshot 递过去。
    Waiting { role: Role, handoff: oneshot::Sender<Ws> },
    /// 双方已配对、管道进行中；期间拒绝任何同 channelId 连接。
    Active,
    /// channel 已结束；TOMBSTONE_TTL 内拒绝重连（挡 token 重放）。
    Closed { until: SystemTime },
}

struct Registry {
    channels: Mutex<HashMap<String, Slot>>,
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn valid_channel_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !value.starts_with("__coflux-")
        && !value.chars().any(|c| (c as u32) < 32 || c as u32 == 127)
}

/// 解析并验签 `payload_b64url.sig_b64url` 形式的 token。签名覆盖
/// `TOKEN_DOMAIN + 0x00 + payload_bytes`，payload 是中心生成的 JSON claims。
fn verify_token(pubkey: &VerifyingKey, token: &str) -> Result<TokenClaims, &'static str> {
    let (payload_b64, sig_b64) = token.split_once('.').ok_or("token 格式无效")?;
    let payload = URL_SAFE_NO_PAD.decode(payload_b64).map_err(|_| "token payload 解码失败")?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig_b64).map_err(|_| "token 签名解码失败")?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| "token 签名长度无效")?;
    let mut message = Vec::with_capacity(TOKEN_DOMAIN.len() + 1 + payload.len());
    message.extend_from_slice(TOKEN_DOMAIN);
    message.push(0);
    message.extend_from_slice(&payload);
    pubkey.verify(&message, &signature).map_err(|_| "token 验签失败")?;
    let claims: TokenClaims = serde_json::from_slice(&payload).map_err(|_| "token claims 畸形")?;
    if claims.v != TOKEN_VERSION {
        return Err("token 版本不支持");
    }
    if !valid_channel_id(&claims.channel_id) {
        return Err("token channelId 无效");
    }
    if claims.exp <= now_ms() {
        return Err("token 已过期");
    }
    Ok(claims)
}

fn parse_role(value: &str) -> Option<Role> {
    match value {
        "client" => Some(Role::Client),
        "daemon" => Some(Role::Daemon),
        _ => None,
    }
}

fn reject(status: StatusCode, message: &str) -> ErrorResponse {
    let mut response = HttpResponse::new(Some(message.to_string()));
    *response.status_mut() = status;
    response
}

#[tokio::main]
async fn main() {
    let listen = std::env::var("COFLUX_RELAY_LISTEN").unwrap_or_else(|_| "127.0.0.1:8790".to_string());
    let pubkey_hex = match std::env::var("COFLUX_RELAY_PUBKEY") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!("[relay] 缺少 COFLUX_RELAY_PUBKEY（中心签名公钥，hex 裸 32B），拒绝启动");
            std::process::exit(1);
        }
    };
    let pubkey = match hex::decode(pubkey_hex.trim()).ok().and_then(|bytes| {
        let arr: [u8; 32] = bytes.try_into().ok()?;
        VerifyingKey::from_bytes(&arr).ok()
    }) {
        Some(key) => Arc::new(key),
        None => {
            eprintln!("[relay] COFLUX_RELAY_PUBKEY 不是合法的 ed25519 公钥 hex，拒绝启动");
            std::process::exit(1);
        }
    };

    let listener = match TcpListener::bind(&listen).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[relay] bind {listen} 失败: {error}");
            std::process::exit(1);
        }
    };
    let addr = listener.local_addr().expect("local_addr");
    // 就绪行走 stdout（stderr 留给诊断日志），格式稳定供 harness/运维解析。
    println!("coflux-relay listening on {addr}");

    let registry = Arc::new(Registry { channels: Mutex::new(HashMap::new()) });

    // tombstone / 死等槽位的周期清扫；Waiting 槽由 PAIR_TIMEOUT 自行清理，这里只扫 Closed。
    {
        let registry = registry.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let now = SystemTime::now();
                registry
                    .channels
                    .lock()
                    .unwrap()
                    .retain(|_, slot| !matches!(slot, Slot::Closed { until } if *until <= now));
            }
        });
    }

    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let registry = registry.clone();
                let pubkey = pubkey.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, registry, pubkey).await {
                        eprintln!("[relay] connection closed: {error}");
                    }
                });
            }
            Err(error) => {
                eprintln!("[relay] accept error: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle_connection(mut stream: TcpStream, registry: Arc<Registry>, pubkey: Arc<VerifyingKey>) -> Result<(), String> {
    // 普通 HTTP 请求不会进入 tungstenite 的 Upgrade 回调；先以 peek 识别 healthz，
    // 仅确认 healthz 后才消费完整请求头，保证 /v1/pipe 的握手输入与原先完全相同。
    if is_healthz_request(&stream).await? {
        consume_healthz_request(&mut stream).await?;
        stream.write_all(HEALTHZ_RESPONSE).await.map_err(|error| format!("写 healthz 响应失败: {error}"))?;
        stream.shutdown().await.map_err(|error| format!("关闭 healthz 连接失败: {error}"))?;
        return Ok(());
    }

    // token 验证放在 upgrade 回调里：不合法的请求以 HTTP 状态码拒绝，根本不建 WS。
    let captured = Arc::new(Mutex::new(None::<(TokenClaims, Role)>));
    let callback_captured = captured.clone();
    let callback_pubkey = pubkey.clone();
    let callback = move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        if request.uri().path() != "/v1/pipe" {
            return Err(reject(StatusCode::NOT_FOUND, "relay path 不存在"));
        }
        let token = request
            .uri()
            .query()
            .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("token=")))
            .ok_or_else(|| reject(StatusCode::FORBIDDEN, "缺少 token"))?;
        let claims = verify_token(&callback_pubkey, token).map_err(|error| reject(StatusCode::FORBIDDEN, error))?;
        let role = parse_role(&claims.role).ok_or_else(|| reject(StatusCode::FORBIDDEN, "token role 无效"))?;
        *callback_captured.lock().unwrap() = Some((claims, role));
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
    let (claims, role) = captured.lock().unwrap().take().ok_or_else(|| "token capture 丢失".to_string())?;
    let channel_id = claims.channel_id;

    // 槽位登记：同 channel+role 二连拒后到者；Active/Closed 一律拒；全局上限封顶。
    // 锁内只做状态迁移并算出 action，锁外再做任何 await（MutexGuard 不能跨 await）。
    enum Action {
        WaitPeer(oneshot::Receiver<Ws>),
        HandoffTo(oneshot::Sender<Ws>),
        Reject(&'static str),
    }
    let action = {
        let mut channels = registry.channels.lock().unwrap();
        let occupied = channels.get(&channel_id).is_some();
        if !occupied {
            if channels.len() >= MAX_CHANNELS_TOTAL {
                Action::Reject("relay channel 数已达上限")
            } else {
                let (tx, rx) = oneshot::channel();
                channels.insert(channel_id.clone(), Slot::Waiting { role, handoff: tx });
                Action::WaitPeer(rx)
            }
        } else {
            match channels.get(&channel_id).unwrap() {
                Slot::Waiting { role: waiting_role, .. } if *waiting_role == role => Action::Reject("同 role 已在等待，拒绝后到者"),
                Slot::Waiting { .. } => {
                    let Some(Slot::Waiting { handoff, .. }) = channels.remove(&channel_id) else { unreachable!() };
                    channels.insert(channel_id.clone(), Slot::Active);
                    Action::HandoffTo(handoff)
                }
                Slot::Active => Action::Reject("channel 已配对，拒绝重连"),
                Slot::Closed { .. } => Action::Reject("channel 已关闭，token 不可重用"),
            }
        }
    };

    let handoff_rx = match action {
        Action::Reject(reason) => return close_with(&mut websocket, reason).await,
        Action::HandoffTo(handoff) => {
            // 把自己的 socket 递给先到方（pump 属主）；对端已超时消失则本连接也随之关闭。
            if handoff.send(websocket).is_err() {
                registry.close_channel(&channel_id);
            }
            return Ok(());
        }
        Action::WaitPeer(rx) => rx,
    };

    // 先到方：限时等待对端 socket，成为 pump 属主。
    let peer = match tokio::time::timeout(PAIR_TIMEOUT, handoff_rx).await {
        Ok(Ok(peer)) => peer,
        _ => {
            registry.close_channel(&channel_id);
            return close_with(&mut websocket, "等待对端配对超时").await;
        }
    };

    let result = pipe(websocket, peer).await;
    registry.close_channel(&channel_id);
    result.map_err(|reason| format!("channel {channel_id}: {reason}"))
}

async fn is_healthz_request(stream: &TcpStream) -> Result<bool, String> {
    let mut prefix = [0_u8; HEALTHZ_REQUEST_PREFIX.len()];
    loop {
        let read = stream.peek(&mut prefix).await.map_err(|error| format!("读取请求前缀失败: {error}"))?;
        if read == 0 {
            return Err("请求在发送首行前关闭".to_string());
        }
        if prefix[..read] != HEALTHZ_REQUEST_PREFIX[..read] {
            return Ok(false);
        }
        if read == HEALTHZ_REQUEST_PREFIX.len() {
            return Ok(true);
        }
        // peek 不消费已有的半截前缀，等待下一批字节，避免在同一可读状态上忙循环。
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

async fn consume_healthz_request(stream: &mut TcpStream) -> Result<(), String> {
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        if request.len() == MAX_HEALTHZ_REQUEST_BYTES {
            return Err(format!("healthz 请求头超过 {MAX_HEALTHZ_REQUEST_BYTES} 字节"));
        }
        let remaining = MAX_HEALTHZ_REQUEST_BYTES - request.len();
        let read_limit = remaining.min(chunk.len());
        let read = stream
            .read(&mut chunk[..read_limit])
            .await
            .map_err(|error| format!("读取 healthz 请求失败: {error}"))?;
        if read == 0 {
            return Err("healthz 请求在头部结束前关闭".to_string());
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(());
        }
    }
}

impl Registry {
    fn close_channel(&self, channel_id: &str) {
        self.channels
            .lock()
            .unwrap()
            .insert(channel_id.to_string(), Slot::Closed { until: SystemTime::now() + TOMBSTONE_TTL });
    }
}

async fn close_with(websocket: &mut Ws, reason: &str) -> Result<(), String> {
    let frame = CloseFrame { code: CloseCode::Policy, reason: reason.to_string().into() };
    let _ = websocket.close(Some(frame)).await;
    Err(reason.to_string())
}

struct RateWindow {
    started: tokio::time::Instant,
    frames: u32,
    bytes: usize,
}

impl RateWindow {
    fn new() -> Self {
        Self { started: tokio::time::Instant::now(), frames: 0, bytes: 0 }
    }

    fn allow(&mut self, bytes: usize) -> bool {
        let now = tokio::time::Instant::now();
        if now.duration_since(self.started) >= Duration::from_secs(1) {
            self.started = now;
            self.frames = 0;
            self.bytes = 0;
        }
        self.frames += 1;
        self.bytes += bytes;
        self.frames <= MAX_FRAMES_PER_SECOND && self.bytes <= MAX_BYTES_PER_SECOND
    }
}

/// 双向 opaque 管道：任一方向结束/违规即整体结束，返回后由调用方落 tombstone。
/// 背压天然传导：慢的一端让 `send().await` 变慢，PTY 保护由 worker 侧有界队列（丢帧
/// 报 gap → client 重新 attach）承担，这里不做缓冲。
async fn pipe(first: Ws, second: Ws) -> Result<(), String> {
    let (first_tx, first_rx) = first.split();
    let (second_tx, second_rx) = second.split();
    tokio::select! {
        reason = pump(first_rx, second_tx) => reason,
        reason = pump(second_rx, first_tx) => reason,
    }
}

async fn pump(mut from: SplitStream<Ws>, mut to: SplitSink<Ws, Message>) -> Result<(), String> {
    let mut rate = RateWindow::new();
    loop {
        match from.next().await {
            Some(Ok(Message::Binary(bytes))) => {
                if bytes.is_empty() || bytes.len() > MAX_DEVICE_FRAME_BYTES {
                    return Err("frame 大小超限".into());
                }
                if !rate.allow(bytes.len()) {
                    return Err("frame 速率超限".into());
                }
                to.send(Message::Binary(bytes)).await.map_err(|error| format!("转发失败: {error}"))?;
            }
            Some(Ok(Message::Text(_))) => return Err("协议违规：不接受 text frame".into()),
            Some(Ok(Message::Close(_))) | None => return Ok(()),
            // ping/pong 由 tungstenite 协议层自动应答，这里忽略。
            Some(Ok(_)) => {}
            Some(Err(error)) => return Err(format!("读取失败: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn test_keys() -> (SigningKey, Arc<VerifyingKey>) {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let verifying = Arc::new(signing.verifying_key());
        (signing, verifying)
    }

    fn signed_token(signing: &SigningKey, channel_id: &str, role: &str) -> String {
        let payload = serde_json::to_vec(&serde_json::json!({
            "v": TOKEN_VERSION,
            "channelId": channel_id,
            "role": role,
            "exp": now_ms() + 60_000.0,
        }))
        .unwrap();
        let mut message = Vec::from(TOKEN_DOMAIN);
        message.push(0);
        message.extend_from_slice(&payload);
        let signature = signing.sign(&message);
        format!("{}.{}", URL_SAFE_NO_PAD.encode(payload), URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    async fn test_listener(expected_connections: usize, verifying: Arc<VerifyingKey>) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let registry = Arc::new(Registry { channels: Mutex::new(HashMap::new()) });
        let task = tokio::spawn(async move {
            for _ in 0..expected_connections {
                let (stream, _) = listener.accept().await.unwrap();
                let registry = registry.clone();
                let verifying = verifying.clone();
                tokio::spawn(async move {
                    let _ = handle_connection(stream, registry, verifying).await;
                });
            }
        });
        (addr, task)
    }

    #[tokio::test]
    async fn healthz_returns_plain_http_200() {
        let (_, verifying) = test_keys();
        let (addr, listener) = test_listener(1, verifying).await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: relay\r\n\r\n").await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();

        assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with(b"\r\n\r\nok\n"));
        listener.await.unwrap();
    }

    #[tokio::test]
    async fn pipe_still_pairs_and_forwards_binary_frames() {
        let (signing, verifying) = test_keys();
        let (addr, listener) = test_listener(2, verifying).await;
        let channel_id = "healthz-pipe-regression";
        let client_token = signed_token(&signing, channel_id, "client");
        let daemon_token = signed_token(&signing, channel_id, "daemon");
        let (mut client, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/v1/pipe?token={client_token}"
        ))
        .await
        .unwrap();
        let (mut daemon, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/v1/pipe?token={daemon_token}"
        ))
        .await
        .unwrap();

        client.send(Message::Binary(vec![1, 2, 3].into())).await.unwrap();
        assert_eq!(daemon.next().await.unwrap().unwrap(), Message::Binary(vec![1, 2, 3].into()));
        listener.await.unwrap();
    }
}
