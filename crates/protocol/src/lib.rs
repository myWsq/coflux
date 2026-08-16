//! coflux 线协议（Rust 侧）。
//!
//! 真相源是 `proto/`（Buf 管理，三端 codegen）；本 crate 是 Rust（daemon）侧的消费者：
//! - [frame]：worker ⟷ supervisor UDS 内部二进制帧（dirty/proxy/device；旧 input/replay
//!   编号保留但拒绝解码），与
//!   WS wire 无关，进程内部协议，不随本次 wire 迁移变化。
//! - [wire]：Daemon ↔ Server WS 线协议（`buf generate` 产出的 prost 类型，见 [gen]）。
//!   WS 上只有 binary message，每条 = 一个 [wire::DaemonToServer] / [wire::ServerToDaemon]
//!   编码信封；控制面与数据面（pty/proxy）统一走 oneof payload，不再区分 JSON 文本帧与
//!   自定义二进制帧。
//! - [ipc]：worker ↔ supervisor 本地 UDS 消息 + 长度前缀分帧。
//!
//! Client ↔ Server control 协议仍由 TS server/web 持有；端到端 DeviceEnvelope 则由
//! browser/worker/sessiond 共用。生成代码里未被某端引用的 message/oneof 变体属于正常的
//! 「同一份生成文件、各端各取所需」。

#[allow(clippy::all)]
mod gen {
    pub mod coflux {
        pub mod v1 {
            include!("gen/coflux/v1/coflux.v1.rs");
        }
    }
}

pub mod frame;
pub mod ipc;
pub mod settings;

/// Daemon ↔ Server WS 线协议（prost 生成类型）。真相源：`proto/coflux/v1/{common,daemon}.proto`。
pub mod wire {
    pub use crate::gen::coflux::v1::*;
}

pub use settings::Settings;

pub use frame::{decode_frame, encode_frame, DataFrame, FRAME_DEVICE, FRAME_INPUT, FRAME_OUTPUT, FRAME_PROXY_DATA, FRAME_REPLAY};
pub use ipc::{
    is_frame, write_record, RecordParser, SessionInfo, SupervisorToWorker, WorkerToSupervisor, SUPERVISOR_SOCK_ENV, SUPERVISOR_VERSION_ENV,
    WORKER_VERSION_ENV,
};
pub use wire::{DaemonToServer, FsEntry, FsEntryKind, ServerToDaemon, SessionPorts, SessionRef};

/// 编码 transport-neutral Device envelope，供不直接依赖 prost 的 supervisor 使用。
pub fn encode_device_envelope(message: &wire::DeviceEnvelope) -> Vec<u8> {
    prost::Message::encode_to_vec(message)
}

/// 解码 Device envelope；畸形 bytes 返回 None，由 transport 记录并丢弃。
pub fn decode_device_envelope(bytes: &[u8]) -> Option<wire::DeviceEnvelope> {
    prost::Message::decode(bytes).ok()
}

/// Browser/worker/sessiond 共用的 DeviceEnvelope 语义版本。
pub const DEVICE_PROTOCOL_VERSION: u32 = 1;
/// 本机 gateway 的生产固定端口；dev/test 可经 worker 配置覆盖。
pub const LOCAL_GATEWAY_PORT: u16 = 8788;
/// PTY 创建/resize 的共享尺寸边界；TS `clampDim` 使用同值。
pub const MIN_TERMINAL_DIMENSION: u16 = 1;
pub const MAX_TERMINAL_DIMENSION: u16 = 1000;
/// relay/local Device frame 上限；保留现有 30MiB 文件写入能力。
pub const MAX_DEVICE_FRAME_BYTES: usize = 30 * 1024 * 1024;
/// 中心 checkpoint 的 ANSI snapshot 上限。
pub const MAX_SESSION_CHECKPOINT_BYTES: usize = 512 * 1024;
/// P2P DataChannel 分片流格式（plan 076，线上契约——改动需带版本协商）：
/// 每个 DeviceEnvelope 帧封为 [u32 BE 帧长][帧字节]，整体按 ≤ P2P_CHUNK_BYTES 切成
/// DataChannel messages；SCTP reliable+ordered 下等价字节流，接收端按前缀重组。
/// 16KiB 取双端接收上限的交集：webrtc-rs 0.20 的 poll OnMessage 上限 16384，
/// Chrome 宣告 256KiB——两者都是接收侧硬限，不可协商放大。
pub const P2P_CHUNK_BYTES: usize = 16 * 1024;

#[cfg(test)]
mod wire_tests;
