//! coflux 线协议（Rust 侧）。
//!
//! 与 TS `packages/protocol` 字节级/JSON 级一致，作为 daemon（supervisor + worker）Rust 化的地基：
//! - [frame]：数据面二进制帧（pty.output/input/replay）
//! - [wire]：Daemon ↔ Server 控制消息（JSON）
//! - [ipc]：worker ↔ supervisor 本地 UDS 消息 + 长度前缀分帧
//!
//! Client ↔ Server 协议仍由 TS server/web 持有，不在 Rust 侧（Rust daemon 不说 client 协议）。
//! Web（浏览器）永远是 JS，后续可从本 crate codegen 出 TS 类型（typeshare/ts-rs），消除重复。

pub mod frame;
pub mod ipc;
pub mod settings;
pub mod wire;

pub use settings::Settings;

pub use frame::{decode_frame, encode_frame, DataFrame, FRAME_INPUT, FRAME_OUTPUT, FRAME_PROXY_DATA, FRAME_REPLAY};
pub use ipc::{is_frame, write_record, RecordParser, SessionInfo, SupervisorToWorker, WorkerToSupervisor, SUPERVISOR_SOCK_ENV};
pub use wire::{DaemonToServer, FsEntry, ServerToDaemon, SessionPorts, SessionRef};
