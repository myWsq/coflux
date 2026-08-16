//! P2P WebRTC 直连（plan 076）。
//!
//! 中心经控制 WS 下发 [`DeviceP2pDial`] 后，worker 建 answer 侧 PeerConnection（vanilla
//! ICE：等 gathering 完成才回完整 answer SDP）。DataChannel 以 label == channel_id 到达，
//! 与中心随后下发的 [`DeviceP2pChannelGrant`] 齐备后（顺序无关）把 channel 泵进
//! `DeviceRuntime`——授权与生命周期语义与 relay 一致：中心逐 channel 授 scopes、中心
//! 控制连接断开时关闭全部 PeerConnection（P2P 无 loopback grant 那样的离线存活）。
//!
//! 帧格式（线上契约，见 protocol 包 `P2P_CHUNK_BYTES`）：每个 DeviceEnvelope 帧封为
//! [u32 BE 帧长][帧字节]，按 ≤ 16KiB 切成 DataChannel messages；SCTP reliable+ordered
//! 下等价字节流，接收端按前缀重组。16KiB 是 webrtc-rs 接收 message 的硬上限。
//!
//! 注意：浏览器在未授权场景可能把 host candidate 混淆为 mDNS `.local`；本端不解析
//! mDNS，同 LAN 连通依赖 daemon 侧真实 host candidate + 对端 connectivity check 形成
//! prflx，一个方向成功即可配对。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use bytes::BytesMut;
use coflux_protocol::wire::{daemon_to_server, DeviceP2pAnswerReport, DeviceP2pChannelGrant, DeviceP2pDial};
use coflux_protocol::{DEVICE_PROTOCOL_VERSION, MAX_DEVICE_FRAME_BYTES, P2P_CHUNK_BYTES};
use tokio::sync::mpsc::Sender;
use tokio::sync::Notify;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use rtc::peer_connection::transport::RTCDtlsRole;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceGatheringState,
    RTCIceServer, RTCPeerConnectionState, RTCSessionDescription, SettingEngine,
};

use crate::device::{ChannelReceiver, DeviceRuntime};
use crate::{try_send_d2s, WsOut};

/// ponytail: 单账号的并发 client 实例有限，超限直接拒——防信令滥用打爆 UDP socket。
const MAX_CONNECTIONS: usize = 32;
/// 每连接待配对（grant/label 单边先到）条目上限。
const MAX_PENDING: usize = 64;
/// 出向 SCTP 缓冲上限：send 内置阻塞背压（await 容量），不许灌整个 30MiB 帧。
const SEND_BUFFER_LIMIT: usize = 1024 * 1024;
/// 单 chunk 写超时：16KiB 在这个时长内挤不进 SCTP 缓冲 = 对端不 ack、链路已死
///（与 relay WRITE_TIMEOUT 同理，防黑洞网络永久挂起）。
const CHUNK_TIMEOUT: Duration = Duration::from_secs(20);
/// vanilla ICE gathering 总超时兜底：配了不可达 STUN 时 gathering 要等栈内超时；
/// 超过该时长直接取当前 local_description（host candidates 已在）。
const GATHER_TIMEOUT: Duration = Duration::from_secs(10);

pub struct P2pRuntime {
    device: Arc<DeviceRuntime>,
    to_server: Sender<WsOut>,
    connections: Mutex<HashMap<String, Arc<P2pConnection>>>,
}

struct P2pConnection {
    client_instance_id: String,
    pc: Arc<dyn PeerConnection>,
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    grants: HashMap<String, DeviceP2pChannelGrant>,
    channels: HashMap<String, Arc<dyn DataChannel>>,
}

/// PeerConnection 事件回调。持 Weak<P2pRuntime> 断开 runtime→pc→handler→runtime 的引用环。
struct ConnectionHandler {
    runtime: Weak<P2pRuntime>,
    connection_id: String,
    gathered: Arc<Notify>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for ConnectionHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            // notify_one 在无 waiter 时留存 permit，覆盖「Complete 先于 dial 侧 await」的时序。
            self.gathered.notify_one();
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        // Failed/Closed 摘除连接并关 pc；级联关所有 DataChannel，各 channel 泵经
        // OnClose/send 失败自行退出并 close_p2p。Disconnected 不摘——ICE 可自愈。
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
            if let Some(runtime) = self.runtime.upgrade() {
                runtime.remove_connection(&self.connection_id);
            }
        }
    }

    async fn on_data_channel(&self, data_channel: Arc<dyn DataChannel>) {
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.adopt_channel(&self.connection_id, data_channel).await;
        }
    }
}

impl P2pRuntime {
    pub fn new(device: Arc<DeviceRuntime>, to_server: Sender<WsOut>) -> Arc<Self> {
        Arc::new(Self { device, to_server, connections: Mutex::new(HashMap::new()) })
    }

    /// 处理中心下发的拨号指令：建 answer 侧 PeerConnection 并回 AnswerReport。
    /// 失败不重试——client 侧超时后回落 relay，重试由 client 重新 offer 驱动。
    pub fn handle_dial(self: &Arc<Self>, dial: DeviceP2pDial) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let connection_id = dial.connection_id.clone();
            match runtime.dial(dial).await {
                Ok(sdp) => runtime.report_answer(&connection_id, Some(sdp), None),
                Err(error) => {
                    eprintln!("[worker] p2p dial 失败 connection={connection_id}: {error}");
                    runtime.remove_connection(&connection_id);
                    runtime.report_answer(&connection_id, None, Some(error));
                }
            }
        });
    }

    async fn dial(self: &Arc<Self>, dial: DeviceP2pDial) -> Result<String, String> {
        if dial.protocol_version != DEVICE_PROTOCOL_VERSION {
            return Err("p2p Device protocol version 不兼容".into());
        }
        if !valid_wire_id(&dial.connection_id) || !valid_wire_id(&dial.account_id) || !valid_wire_id(&dial.client_instance_id) {
            return Err("p2p connection/principal 无效".into());
        }

        let ice_servers: Vec<RTCIceServer> = dial
            .ice_servers
            .iter()
            .filter(|url| url.starts_with("stun:") || url.starts_with("stuns:"))
            .map(|url| RTCIceServer { urls: vec![url.clone()], ..Default::default() })
            .collect();
        let config = RTCConfigurationBuilder::default().with_ice_servers(ice_servers).build();
        let gathered = Arc::new(Notify::new());
        let handler = Arc::new(ConnectionHandler {
            runtime: Arc::downgrade(self),
            connection_id: dial.connection_id.clone(),
            gathered: gathered.clone(),
        });
        // answer 侧选 DTLS passive（对端做 client）：浏览器/werift 作为 offerer 主动发起
        // DTLS 握手是双方实现最常走、互通性最好的路径。
        let mut setting_engine = SettingEngine::default();
        setting_engine
            .set_answering_dtls_role(RTCDtlsRole::Server)
            .map_err(|error| format!("dtls role: {error}"))?;
        let pc = PeerConnectionBuilder::new()
            .with_configuration(config)
            .with_setting_engine(setting_engine)
            .with_handler(handler)
            .with_udp_addrs(local_bind_addrs())
            .with_data_channel_send_buffer_limit(SEND_BUFFER_LIMIT)
            .build()
            .await
            .map_err(|error| format!("peer connection: {error}"))?;
        let pc: Arc<dyn PeerConnection> = Arc::new(pc);

        let connection = Arc::new(P2pConnection {
            client_instance_id: dial.client_instance_id.clone(),
            pc: pc.clone(),
            pending: Mutex::new(Pending::default()),
        });
        {
            let mut connections = self.connections.lock().unwrap();
            if connections.contains_key(&dial.connection_id) {
                drop(connections);
                tokio::spawn(async move {
                    let _ = pc.close().await;
                });
                return Err("p2p connectionId 已存在".into());
            }
            if connections.len() >= MAX_CONNECTIONS {
                drop(connections);
                tokio::spawn(async move {
                    let _ = pc.close().await;
                });
                return Err("p2p 连接数超限".into());
            }
            connections.insert(dial.connection_id.clone(), connection);
        }

        let offer = RTCSessionDescription::offer(dial.sdp).map_err(|error| format!("offer sdp: {error}"))?;
        pc.set_remote_description(offer).await.map_err(|error| format!("set remote: {error}"))?;
        let answer = pc.create_answer(None).await.map_err(|error| format!("create answer: {error}"))?;
        pc.set_local_description(answer).await.map_err(|error| format!("set local: {error}"))?;
        let _ = tokio::time::timeout(GATHER_TIMEOUT, gathered.notified()).await;
        let answer = pc.local_description().await.ok_or("answer 缺失")?;
        Ok(answer.sdp)
    }

    /// 中心逐 channel 授权。与 DataChannel（label == channel_id）到达顺序无关，两者齐备
    /// 即起泵；连接不存在/principal 不符则丢弃——client 靠 DataChannel open 超时回落 relay。
    pub fn handle_channel_grant(self: &Arc<Self>, grant: DeviceP2pChannelGrant) {
        let Some(connection) = self.connections.lock().unwrap().get(&grant.connection_id).cloned() else {
            eprintln!("[worker] p2p channel grant 无对应连接 connection={}", grant.connection_id);
            return;
        };
        if connection.client_instance_id != grant.client_instance_id {
            eprintln!("[worker] p2p channel grant principal 不符 channel={}", grant.channel_id);
            return;
        }
        let matched = {
            let mut pending = connection.pending.lock().unwrap();
            if let Some(dc) = pending.channels.remove(&grant.channel_id) {
                Some(dc)
            } else {
                if pending.grants.len() >= MAX_PENDING {
                    eprintln!("[worker] p2p pending grant 超限 connection={}", grant.connection_id);
                    return;
                }
                pending.grants.insert(grant.channel_id.clone(), grant.clone());
                None
            }
        };
        if let Some(dc) = matched {
            self.spawn_channel_pump(dc, grant);
        }
    }

    async fn adopt_channel(self: &Arc<Self>, connection_id: &str, dc: Arc<dyn DataChannel>) {
        let Some(connection) = self.connections.lock().unwrap().get(connection_id).cloned() else {
            let _ = dc.close().await;
            return;
        };
        let Ok(channel_id) = dc.label().await else {
            let _ = dc.close().await;
            return;
        };
        let matched = {
            let mut pending = connection.pending.lock().unwrap();
            if let Some(grant) = pending.grants.remove(&channel_id) {
                Some(grant)
            } else {
                if pending.channels.len() >= MAX_PENDING {
                    eprintln!("[worker] p2p pending channel 超限 connection={connection_id}");
                    None
                } else {
                    pending.channels.insert(channel_id, dc.clone());
                    return;
                }
            }
        };
        match matched {
            Some(grant) => self.spawn_channel_pump(dc, grant),
            None => {
                let _ = dc.close().await;
            }
        }
    }

    fn spawn_channel_pump(self: &Arc<Self>, dc: Arc<dyn DataChannel>, grant: DeviceP2pChannelGrant) {
        let receiver = match self.device.open_p2p(&grant) {
            Ok(receiver) => receiver,
            Err(error) => {
                eprintln!("[worker] p2p channel 注册被拒 channel={}: {error}", grant.channel_id);
                tokio::spawn(async move {
                    let _ = dc.close().await;
                });
                return;
            }
        };
        let channel_id = grant.channel_id;

        // 入向：poll 事件流按到达序（SCTP ordered）重组，完整帧交 runtime。
        // 畸形前缀/超限直接关 channel——字节流失步后无法再对齐。
        {
            let device = self.device.clone();
            let dc = dc.clone();
            let channel_id = channel_id.clone();
            tokio::spawn(async move {
                let mut assembler = FrameAssembler::default();
                'poll: loop {
                    match dc.poll().await {
                        Some(DataChannelEvent::OnMessage(message)) => match assembler.push(&message.data) {
                            Ok(frames) => {
                                for frame in frames {
                                    if !device.handle_p2p_frame(&channel_id, &frame) {
                                        break 'poll;
                                    }
                                }
                            }
                            Err(error) => {
                                eprintln!("[worker] p2p channel {channel_id} 帧流违规: {error}");
                                break;
                            }
                        },
                        Some(DataChannelEvent::OnClose) | None => break,
                        Some(_) => {}
                    }
                }
                device.close_p2p(&channel_id);
                let _ = dc.close().await;
            });
        }

        // 出向泵：runtime 帧 → 前缀 + 分片 → DataChannel。send 内置阻塞背压
        //（SEND_BUFFER_LIMIT），逐 chunk 超时防黑洞挂死。
        let device = self.device.clone();
        tokio::spawn(async move {
            if let Err(error) = pump_out(&dc, &mut { receiver }).await {
                eprintln!("[worker] p2p channel {channel_id} 结束: {error}");
            }
            device.close_p2p(&channel_id);
            let _ = dc.close().await;
        });
    }

    fn remove_connection(&self, connection_id: &str) {
        let removed = self.connections.lock().unwrap().remove(connection_id);
        if let Some(connection) = removed {
            tokio::spawn(async move {
                let _ = connection.pc.close().await;
            });
        }
    }

    /// 中心控制连接断开：关闭全部 PeerConnection 与其 runtime channel（与 relay 同语义）。
    pub fn close_all(&self) {
        let removed: Vec<Arc<P2pConnection>> = self.connections.lock().unwrap().drain().map(|(_, conn)| conn).collect();
        for connection in removed {
            tokio::spawn(async move {
                let _ = connection.pc.close().await;
            });
        }
        self.device.close_p2ps();
    }

    fn report_answer(&self, connection_id: &str, sdp: Option<String>, error: Option<String>) {
        try_send_d2s(
            &self.to_server,
            daemon_to_server::Payload::DeviceP2pAnswerReport(DeviceP2pAnswerReport {
                connection_id: connection_id.to_string(),
                ok: error.is_none(),
                sdp,
                error,
            }),
        );
    }
}

async fn pump_out(dc: &Arc<dyn DataChannel>, receiver: &mut ChannelReceiver) -> Result<(), String> {
    loop {
        let Some(frame) = receiver.recv().await else {
            // channel 已被 runtime 关闭（close_p2p/close_p2ps）：礼貌关 DataChannel 后结束。
            return Ok(());
        };
        let mut stream = Vec::with_capacity(4 + frame.len());
        stream.extend_from_slice(&(frame.len() as u32).to_be_bytes());
        stream.extend_from_slice(&frame);
        for chunk in stream.chunks(P2P_CHUNK_BYTES) {
            match tokio::time::timeout(CHUNK_TIMEOUT, dc.send(BytesMut::from(chunk))).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Err(format!("p2p 写失败: {error}")),
                Err(_) => return Err("p2p 写超时".into()),
            }
        }
    }
}

/// 与 device.rs `valid_id` 同口径的窄校验（那边是私有函数；这里只挡明显违规，
/// channel 级完整校验仍在 `open_p2p` 内做）。
fn valid_wire_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.starts_with("__coflux-")
}

/// webrtc-rs 不做接口枚举：bind 什么地址，host candidate 就是什么地址——wildcard 0.0.0.0
/// 会产生不可路由 candidate。这里枚举全部非 loopback 接口（LAN、Tailscale、公网 v4/v6
/// 都要进 candidates），每次 dial 现取（网络环境会变），并预试 bind 过滤不可用地址。
fn local_bind_addrs() -> Vec<String> {
    let mut addrs = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if interface.is_loopback() {
                continue;
            }
            let ip = interface.ip();
            // fe80:: 链路本地地址不带 scope id 无法作为 candidate 路由，跳过。
            if let std::net::IpAddr::V6(v6) = ip {
                if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                    continue;
                }
            }
            let addr = if ip.is_ipv6() { format!("[{ip}]:0") } else { format!("{ip}:0") };
            if std::net::UdpSocket::bind(&addr).is_ok() {
                addrs.push(addr);
            }
        }
    }
    if addrs.is_empty() {
        addrs.push("0.0.0.0:0".into());
    }
    addrs
}

/// 长度前缀分片流重组器。SCTP reliable+ordered 保证字节序，跨 message 累积，
/// 每帧 [u32 BE 帧长][帧字节]；帧长为 0 或超 MAX_DEVICE_FRAME_BYTES 即协议违规。
#[derive(Default)]
struct FrameAssembler {
    buf: Vec<u8>,
}

impl FrameAssembler {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.buf.extend_from_slice(bytes);
        let mut frames = Vec::new();
        loop {
            if self.buf.len() < 4 {
                return Ok(frames);
            }
            let declared = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if declared == 0 || declared > MAX_DEVICE_FRAME_BYTES {
                return Err(format!("帧长前缀违规: {declared}"));
            }
            if self.buf.len() < 4 + declared {
                return Ok(frames);
            }
            frames.push(self.buf[4..4 + declared].to_vec());
            self.buf.drain(..4 + declared);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(frame: &[u8]) -> Vec<u8> {
        let mut stream = Vec::new();
        stream.extend_from_slice(&(frame.len() as u32).to_be_bytes());
        stream.extend_from_slice(frame);
        stream
    }

    #[test]
    fn reassembles_frames_across_chunk_boundaries() {
        let big = vec![0xabu8; 300 * 1024]; // 超过 Chrome 单消息上限，必然跨多个 chunk
        let mut stream = encode(&big);
        stream.extend_from_slice(&encode(b"tail"));
        let mut assembler = FrameAssembler::default();
        let mut got = Vec::new();
        for chunk in stream.chunks(P2P_CHUNK_BYTES) {
            got.extend(assembler.push(chunk).expect("push"));
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], big);
        assert_eq!(got[1], b"tail");
        assert!(assembler.buf.is_empty());
    }

    #[test]
    fn coalesced_frames_in_one_message_all_pop() {
        let mut stream = encode(b"one");
        stream.extend_from_slice(&encode(b"two"));
        let mut assembler = FrameAssembler::default();
        let got = assembler.push(&stream).expect("push");
        assert_eq!(got, vec![b"one".to_vec(), b"two".to_vec()]);
    }

    #[test]
    fn rejects_zero_and_oversized_length_prefix() {
        let mut assembler = FrameAssembler::default();
        assert!(assembler.push(&0u32.to_be_bytes()).is_err());
        let mut assembler = FrameAssembler::default();
        let oversized = ((MAX_DEVICE_FRAME_BYTES + 1) as u32).to_be_bytes();
        assert!(assembler.push(&oversized).is_err());
    }
}
