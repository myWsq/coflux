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
 * 认证（Tailscale 式，见 docs/auth-design.md）：daemon 用 EnrollmentKey 登记换取每设备 deviceToken；
 * daemonId 服务器签发绑定不可冒充；client 用 ClientToken 登录账号，账号是隔离单元。
 *
 * 运行时校验：protobuf 解码即结构校验，畸形字节直接 fromBinary 抛错——本包的 decode* helpers
 * 统一 try/catch 兜底为 null，调用方按"丢弃 + 记日志"处理，不再需要手写的 isValid* 校验表。
 */
import { create, fromBinary, toBinary, toJson, type MessageInitShape } from "@bufbuild/protobuf";

export * from "./gen/coflux/v1/common_pb.js";
export * from "./gen/coflux/v1/client_pb.js";
export * from "./gen/coflux/v1/daemon_pb.js";

// toJson：protojson 规范映射（枚举出名字、bytes 出 base64），供 HTTP 只读接口把
// proto 真相源的消息投影成人类可读 JSON，避免另立第二套响应形状。
export { create, toJson };

import { ClientToServerSchema, ServerToClientSchema, type ClientToServer, type ServerToClient } from "./gen/coflux/v1/client_pb.js";
import { DaemonToServerSchema, ServerToDaemonSchema, type DaemonToServer, type ServerToDaemon } from "./gen/coflux/v1/daemon_pb.js";

export const DEFAULT_PORT = 8787;

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
 * 小工具
 * ------------------------------------------------------------------ */

/** 把任意输入钳制为合法终端尺寸 */
export function clampDim(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(1, Math.min(1000, v));
}
