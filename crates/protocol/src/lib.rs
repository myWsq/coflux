//! coflux 线协议（Rust 侧）。
//!
//! 真相源是 `proto/`（Buf 管理，三端 codegen）；本 crate 是 Rust（daemon）侧的消费者：
//! - [wire]：Daemon ↔ Server WS 线协议（`buf generate` 产出的 prost 类型，见 [gen]）。
//!   WS 上只有 binary message，每条 = 一个 [wire::DaemonToServer] / [wire::ServerToDaemon]
//!   编码信封；控制面与数据面（pty/proxy）统一走 oneof payload，不再区分 JSON 文本帧与
//!   自定义二进制帧。
//! - [ipc]：本地字节流共用的长度前缀分帧 + shell 命令状态。
//! - [launcher]：coflux-launcher ↔ coflux-runtime 私有通道（nonce / 会话接管 / 切换请求）。
//! - [release]：发布版本身份（严格 SemVer、版本即路径、发布 target）。
//! - [ptyd]：runtime ↔ coflux-ptyd（PTY 托管进程）本地协议，能力握手式长期兼容契约。
//! - [logline]：daemon 日志行的统一时间戳前缀（[`logln!`]）。
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

pub mod ipc;
pub mod launcher;
pub mod logline;
pub mod ptyd;
pub mod release;
pub mod settings;

/// Daemon ↔ Server WS 线协议（prost 生成类型）。真相源：`proto/coflux/v1/{common,daemon}.proto`。
pub mod wire {
    pub use crate::gen::coflux::v1::*;
}

pub use settings::Settings;

pub use ipc::{
    write_record, CommandStateInfo, RecordParseError, RecordParser, RecordWriteError,
    MAX_IPC_RECORD_BYTES,
};
pub use wire::{DaemonToServer, FsEntry, FsEntryKind, ServerToDaemon, SessionPorts, SessionRef};

/// Channel / session ids carried in one byte on local frames; every id entering such a field
/// obeys this bound (the TS `MAX_FRAME_ID_BYTES` is the same value).
pub const MAX_FRAME_ID_BYTES: usize = u8::MAX as usize;

/// 编码 transport-neutral Device envelope，供不直接依赖 prost 的 sessiond 使用。
pub fn encode_device_envelope(message: &wire::DeviceEnvelope) -> Vec<u8> {
    prost::Message::encode_to_vec(message)
}

/// 解码 Device envelope；畸形 bytes 返回 None，由 transport 记录并丢弃。
pub fn decode_device_envelope(bytes: &[u8]) -> Option<wire::DeviceEnvelope> {
    prost::Message::decode(bytes).ok()
}

/// Browser/worker/sessiond 共用的 DeviceEnvelope 语义版本。
pub const DEVICE_PROTOCOL_VERSION: u32 = 1;
pub const CONTROL_PROTOCOL_VERSION: u32 = 2;
/// 本机 gateway 的生产固定端口；dev/test 可经 worker 配置覆盖。
pub const LOCAL_GATEWAY_PORT: u16 = 8788;
/// The runtime's canvas listener (plan 20261112-agent-canvas): a fixed loopback port of its own, so
/// a canvas keeps one origin across restarts (annotations are matched by it) and never shares one
/// with the gateway. `COFLUX_CANVAS_PORT` overrides it; 0 asks the OS for a port.
pub const CANVAS_PORT: u16 = 8795;
/// PTY 创建/resize 的共享尺寸边界；TS `clampDim` 使用同值。
pub const MIN_TERMINAL_DIMENSION: u16 = 1;
pub const MAX_TERMINAL_DIMENSION: u16 = 1000;
/// Native and local Device frame limit; preserves 30 MiB file writes.
pub const MAX_DEVICE_FRAME_BYTES: usize = 30 * 1024 * 1024;
/// 中心 checkpoint 的 ANSI snapshot 上限。
pub const MAX_SESSION_CHECKPOINT_BYTES: usize = 512 * 1024;
/// Remote screen (plan 20260929-remote-desktop): the capability name a device advertises when its
/// worker reached the `coflux-screen` helper. Same spelling as the TS `SCREEN_CAPABILITY`.
pub const SCREEN_CAPABILITY: &str = "screen_v1";
/// Version of the worker ⟷ coflux-screen hello (`ScreenHelperHello.protocol_version`).
pub const SCREEN_HELPER_PROTOCOL_VERSION: u32 = 1;
/// Largest `ScreenVideoFrame.data` in one message; larger frames are chunked.
pub const SCREEN_VIDEO_CHUNK_BYTES: usize = 256 * 1024;
/// Records of one screen channel the worker keeps queued to the transport helper: a quarter of
/// the helper's shared 256-record queue, the loopback tunnel's budget.
pub const SCREEN_CHANNEL_RECORD_BUDGET: usize = 64;

#[cfg(test)]
mod wire_tests;
