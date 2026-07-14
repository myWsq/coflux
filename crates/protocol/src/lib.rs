//! coflux 线协议（Rust 侧）。
//!
//! 真相源是 `proto/`（Buf 管理，三端 codegen）；本 crate 是 Rust（daemon）侧的消费者：
//! - [frame]：worker ⟷ supervisor UDS 内部数据面二进制帧（pty.output/input/replay），与
//!   WS wire 无关，进程内部协议，不随本次 wire 迁移变化。
//! - [wire]：Daemon ↔ Server WS 线协议（`buf generate` 产出的 prost 类型，见 [gen]）。
//!   WS 上只有 binary message，每条 = 一个 [wire::DaemonToServer] / [wire::ServerToDaemon]
//!   编码信封；控制面与数据面（pty/proxy）统一走 oneof payload，不再区分 JSON 文本帧与
//!   自定义二进制帧。
//! - [ipc]：worker ↔ supervisor 本地 UDS 消息 + 长度前缀分帧。
//!
//! Client ↔ Server 协议仍由 TS server/web 持有，不在 Rust 侧（Rust daemon 不说 client 协议）；
//! 生成代码里与之相关的 message/oneof 变体在本 crate 未被引用，属于正常的「同一份生成文件、
//! 各端各取所需」。

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

pub use frame::{decode_frame, encode_frame, DataFrame, FRAME_INPUT, FRAME_OUTPUT, FRAME_PROXY_DATA, FRAME_REPLAY};
pub use ipc::{is_frame, write_record, RecordParser, SessionInfo, SupervisorToWorker, WorkerToSupervisor, SUPERVISOR_SOCK_ENV};
pub use wire::{DaemonToServer, FsEntry, FsEntryKind, ServerToDaemon, SessionPorts, SessionRef};

#[cfg(test)]
mod wire_tests;
