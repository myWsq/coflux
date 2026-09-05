/**
 * coflux wire protocol。
 *
 * 真相源是 `proto/`（Buf 管理的 protobuf 定义），本包只装载由 `buf generate` 产出的
 * TS 绑定（`src/gen/coflux/v1/*_pb.ts`，protobuf-es v2）并在其上加一层薄封装：
 *   - 信封编解码：每条 WS binary message = 一个 protobuf 编码的信封
 *     （`/daemon`：DaemonToServer / ServerToDaemon；`/client`：ClientToServer / ServerToClient）。
 *   - `create()`：从 @bufbuild/protobuf 直接再导出，供调用方构造消息（顶层消息需要
 *     `$typeName`，用 `create(XxxSchema, {...})`；嵌套字段可直接传纯 init 对象，无需逐层 create）。
 *
 * 三方两段链路：
 *   Daemon  <-- /daemon -->  Server  <-- /client -->  Client
 *
 * 模型（项目制）：
 *   Account
 *     Device(=Daemon, 一机一个)
 *       Project    一个导入的 git 仓库   { repoPath, defaultBranch }
 *         Workspace  一个工作树           主工作区=仓库本身；其它=git worktree（各自分支）
 *           Task     编排单位             PTY 的 cwd = workspace.path
 *             Session  PTY 运行时实例（活在 daemon；scrollback 也在 daemon）
 *
 * 认证（Tailscale 式，见 docs/auth-design.md）：daemon 发起浏览器授权请求，用户在 web 端确认后
 * 换取每设备 deviceToken；daemonId 服务器签发绑定不可冒充；client 用 ClientToken 登录账号，账号是隔离单元。
 *
 * 运行时校验：protobuf 解码即结构校验，畸形字节直接 fromBinary 抛错——本包的 decode* helpers
 * 统一 try/catch 兜底为 null，调用方按"丢弃 + 记日志"处理，不再需要手写的 isValid* 校验表。
 */
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";

export * from "./gen/coflux/v1/common_pb.js";
export * from "./gen/coflux/v1/client_pb.js";
export * from "./gen/coflux/v1/daemon_pb.js";
export * from "./gen/coflux/v1/device_pb.js";

export { create };

import { ClientToServerSchema, ServerToClientSchema, type ClientToServer, type ServerToClient } from "./gen/coflux/v1/client_pb.js";
import { DaemonToServerSchema, ServerToDaemonSchema, type DaemonToServer, type ServerToDaemon } from "./gen/coflux/v1/daemon_pb.js";
import { DeviceEnvelopeSchema, type DeviceEnvelope } from "./gen/coflux/v1/device_pb.js";

export const DEFAULT_PORT = 8787;
/** 本机 gateway 的生产固定端口；dev/test 可在各自 transport 配置里覆盖。 */
export const LOCAL_GATEWAY_PORT = 8788;
/** browser/worker/sessiond 共用的 DeviceEnvelope 语义版本。 */
export const DEVICE_PROTOCOL_VERSION = 1;
/** PTY 创建/resize 的共享尺寸边界；Rust sessiond 使用同值，避免 transport 间行为漂移。 */
export const MIN_TERMINAL_DIMENSION = 1;
export const MAX_TERMINAL_DIMENSION = 1000;
/** worker ↔ supervisor 内部 frame 的 idLen 只有一个字节；会进入该字段的 ID 共用此上限。 */
export const MAX_FRAME_ID_BYTES = 255;
/** relay/local Device frame 上限；保留现有 30MiB 文件写入能力。 */
export const MAX_DEVICE_FRAME_BYTES = 30 * 1024 * 1024;
/** 中心 checkpoint 只保存有界 terminal state，不承载完整 Device frame 上限。 */
export const MAX_SESSION_CHECKPOINT_BYTES = 512 * 1024;
/**
 * P2P DataChannel 分片流格式（plan 076，线上契约——改动需带版本协商）：
 * 每个 DeviceEnvelope 帧封为 [u32 BE 帧长][帧字节]，整体按 ≤ P2P_CHUNK_BYTES 切成
 * DataChannel messages；SCTP reliable+ordered 下等价字节流，接收端按前缀重组。
 * 16KiB 取双端接收上限的交集：webrtc-rs 0.20 的 poll OnMessage 上限 16384，
 * Chrome 宣告 256KiB——两者都是接收侧硬限，不可协商放大。
 */
export const P2P_CHUNK_BYTES = 16 * 1024;

/**
 * 信封 oneof 载荷的"构造态"类型（供发送方构造消息用）。
 *
 * `ServerToClient["payload"]` 等生成类型是 `create()` 之后的运行时形状——每个 oneof 分支的
 * `value` 都要求满足 `Message`（含 `$typeName`）。而调用方通常是先拼一个 `{case, value}` 字面量
 * 传给发送 helper（helper 内部再统一 `create(XxxSchema, { payload })`），此时 `value` 只需是
 * "构造态"（`MessageInitShape`，允许省略 `$typeName` 的纯对象，因为 `create()` 会递归补全）。
 * 用运行时类型去标注这类字面量参数会被 TS 误判为缺字段，故导出这组独立的 Init 类型。
 */
export type ServerToClientPayload = MessageInitShape<typeof ServerToClientSchema>["payload"];
export type ServerToDaemonPayload = MessageInitShape<typeof ServerToDaemonSchema>["payload"];
export type ClientToServerPayload = MessageInitShape<typeof ClientToServerSchema>["payload"];
export type DaemonToServerPayload = MessageInitShape<typeof DaemonToServerSchema>["payload"];
export type DeviceEnvelopePayload = MessageInitShape<typeof DeviceEnvelopeSchema>["payload"];

export type AccountId = string;
export type DaemonId = string;
export type ProjectId = string;
export type WorkspaceId = string;
export type TaskId = string;
export type SessionId = string;
export type RequestId = string;

/* ------------------------------------------------------------------ *
 * 信封编解码（/client 链路）
 * ------------------------------------------------------------------ */

/** encode 系列统一收敛为 `Uint8Array<ArrayBuffer>`：toBinary 运行时总是分配全新 ArrayBuffer，
 * 收窄后可直接喂 DOM `WebSocket.send`（其 BufferSource 不接受 SharedArrayBuffer 背衬）。 */
export function encodeClientToServer(msg: ClientToServer): Uint8Array<ArrayBuffer> {
  return toBinary(ClientToServerSchema, msg) as Uint8Array<ArrayBuffer>;
}

/** 解码失败（畸形字节/未知 wire）返回 null，调用方丢弃，不崩溃。 */
export function decodeClientToServer(buf: Uint8Array): ClientToServer | null {
  try {
    return fromBinary(ClientToServerSchema, buf);
  } catch {
    return null;
  }
}

export function encodeServerToClient(msg: ServerToClient): Uint8Array<ArrayBuffer> {
  return toBinary(ServerToClientSchema, msg) as Uint8Array<ArrayBuffer>;
}

export function decodeServerToClient(buf: Uint8Array): ServerToClient | null {
  try {
    return fromBinary(ServerToClientSchema, buf);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 信封编解码（/daemon 链路）
 * ------------------------------------------------------------------ */

export function encodeDaemonToServer(msg: DaemonToServer): Uint8Array<ArrayBuffer> {
  return toBinary(DaemonToServerSchema, msg) as Uint8Array<ArrayBuffer>;
}

export function decodeDaemonToServer(buf: Uint8Array): DaemonToServer | null {
  try {
    return fromBinary(DaemonToServerSchema, buf);
  } catch {
    return null;
  }
}

export function encodeServerToDaemon(msg: ServerToDaemon): Uint8Array<ArrayBuffer> {
  return toBinary(ServerToDaemonSchema, msg) as Uint8Array<ArrayBuffer>;
}

export function decodeServerToDaemon(buf: Uint8Array): ServerToDaemon | null {
  try {
    return fromBinary(ServerToDaemonSchema, buf);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Device 端到端协议（loopback 直连 / 中心 opaque relay 共用）
 * ------------------------------------------------------------------ */

export function encodeDeviceEnvelope(msg: DeviceEnvelope): Uint8Array<ArrayBuffer> {
  return toBinary(DeviceEnvelopeSchema, msg) as Uint8Array<ArrayBuffer>;
}

export function decodeDeviceEnvelope(buf: Uint8Array): DeviceEnvelope | null {
  try {
    return fromBinary(DeviceEnvelopeSchema, buf);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 把任意输入钳制为合法终端尺寸 */
export function clampDim(n: unknown, fallback: number): number {
  // 0 = proto3 缺省值（客户端未传尺寸），与非法输入一样回落 fallback，而非被夹成 1
  const v = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.max(MIN_TERMINAL_DIMENSION, Math.min(MAX_TERMINAL_DIMENSION, v));
}
