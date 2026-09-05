//! relay 按需拨号（plan 043）。
//!
//! 中心经控制 WS 下发 [`DeviceRelayDial`] 后，worker 为该 channel 拨一条专属 relay WS：
//! 出向帧从 DeviceRuntime 的 ChannelReceiver 泵到 relay，入向帧交回
//! `DeviceRuntime::handle_relay_frame`。零驻留连接——WS 断开即整个 channel 结束，
//! client 需重新 rendezvous；channel 关闭语义与 direct 一致由 runtime 收敛。

use std::sync::Arc;
use std::time::Duration;

use coflux_protocol::logln;
use coflux_protocol::wire::DeviceRelayDial;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::device::{ChannelReceiver, DeviceRuntime};
use crate::relay_home::RelayHomeSelector;

/// 写超时与中心 WS 同理：黑洞网络下 send 可能永久挂起，必须有限时失败。
const WRITE_TIMEOUT: Duration = Duration::from_secs(20);

pub fn spawn(
    device: Arc<DeviceRuntime>,
    dial: DeviceRelayDial,
    connect_timeout_ms: u64,
    relay_home: RelayHomeSelector,
) {
    tokio::spawn(async move {
        let channel_id = dial.channel_id.clone();
        let receiver = match device.open_relay(&dial) {
            Ok(receiver) => receiver,
            Err(error) => {
                logln!("[worker] relay dial 被拒 channel={channel_id}: {error}");
                return;
            }
        };
        let ws = match connect(&dial.relay_url, connect_timeout_ms).await {
            Ok(ws) => ws,
            Err(error) => {
                logln!("[worker] relay channel {channel_id} 拨号失败: {error}");
                relay_home.probe_now();
                device.close_relay(&channel_id);
                return;
            }
        };
        if let Err(error) = run(&device, ws, &channel_id, receiver).await {
            logln!("[worker] relay channel {channel_id} 结束: {error}");
        }
        device.close_relay(&channel_id);
    });
}

async fn connect(
    relay_url: &str,
    connect_timeout_ms: u64,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let (ws, _) = tokio::time::timeout(
        Duration::from_millis(connect_timeout_ms),
        connect_async(relay_url),
    )
    .await
    .map_err(|_| format!("relay connect 超时（{connect_timeout_ms}ms）"))?
    .map_err(|error| format!("relay connect: {error}"))?;
    Ok(ws)
}

async fn run(
    device: &Arc<DeviceRuntime>,
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    channel_id: &str,
    mut receiver: ChannelReceiver,
) -> Result<(), String> {
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            out = receiver.recv() => match out {
                Some(bytes) => {
                    let sent = tokio::time::timeout(WRITE_TIMEOUT, sink.send(Message::binary(bytes))).await;
                    if !matches!(sent, Ok(Ok(()))) {
                        return Err("relay 写失败/超时".into());
                    }
                }
                // channel 已被 runtime 关闭（close_relay/close_relays）：礼貌关 WS 后结束。
                None => {
                    let _ = sink.close().await;
                    return Ok(());
                }
            },
            inc = stream.next() => match inc {
                Some(Ok(Message::Binary(bytes))) => {
                    if !device.handle_relay_frame(channel_id, &bytes) {
                        return Err("relay channel 已不存在".into());
                    }
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                // ping/pong 由协议层自动处理；text 属违规，直接结束 channel。
                Some(Ok(Message::Text(_))) => return Err("协议违规：relay 收到 text frame".into()),
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(format!("relay 读失败: {error}")),
            },
        }
    }
}
