/**
 * coflux wire protocol.
 *
 * 一条 WebSocket 上多路复用，所有消息以 JSON 编码、用 `type` 区分。
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
 */

export const DEFAULT_PORT = 8787;

export type AccountId = string;
export type DaemonId = string;
export type ProjectId = string;
export type WorkspaceId = string;
export type TaskId = string;
export type SessionId = string;
export type RequestId = string;

export type TaskStatus = "idle" | "running" | "exited";

export interface DaemonInfo {
  daemonId: DaemonId;
  name: string;
  host: string;
  platform: string;
  online: boolean;
}

/** fs.list 返回的目录项 */
export interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
}

export interface Project {
  id: ProjectId;
  accountId: AccountId;
  daemonId: DaemonId;
  name: string;
  repoPath: string;
  defaultBranch: string;
  createdAt: number;
}

export interface Workspace {
  id: WorkspaceId;
  accountId: AccountId;
  daemonId: DaemonId;
  projectId: ProjectId;
  name: string;
  path: string;
  branch: string;
  isMain: boolean;
  createdAt: number;
}

export interface Task {
  id: TaskId;
  accountId: AccountId;
  daemonId: DaemonId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  title: string;
  status: TaskStatus;
  sessionId: SessionId | null;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

/* ================================================================== *
 * Daemon  <->  Server
 * ================================================================== */

/** exec/fs 结果 —— 同一形状在 daemon→server 和 server→client 两段复用（server 只换 requestId 转发） */
export type ExecResult = { type: "exec.result"; requestId: RequestId; ok: boolean; exitCode: number; stdout: string; stderr: string; error?: string };
export type FsListed = { type: "fs.listed"; requestId: RequestId; ok: boolean; entries: FsEntry[]; error?: string };
export type FsReadResult = { type: "fs.read.result"; requestId: RequestId; ok: boolean; content: string; error?: string };

export type DaemonToServer =
  | { type: "daemon.enroll"; enrollmentKey: string; name: string; host: string; platform: string }
  | { type: "daemon.auth"; deviceToken: string }
  | { type: "daemon.resync"; sessions: { sessionId: SessionId; taskId: TaskId }[] }
  /** 校验路径是否为（非裸）git 仓库，返回顶层目录与当前分支 */
  | { type: "project.validated"; requestId: RequestId; ok: boolean; repoPath: string; branch: string; error?: string }
  /** git worktree add 结果 */
  | { type: "worktree.added"; requestId: RequestId; ok: boolean; path: string; branch: string; error?: string }
  | { type: "session.started"; sessionId: SessionId; taskId: TaskId; pid: number }
  | { type: "session.exit"; sessionId: SessionId; exitCode: number }
  // pty.output / pty.replay 走二进制数据面（见 encodeFrame/decodeFrame），不在 JSON 联合体内
  | ExecResult
  | FsListed
  | FsReadResult;

export type ServerToDaemon =
  | { type: "daemon.enrolled"; daemonId: DaemonId; deviceToken: string }
  | { type: "daemon.authed"; daemonId: DaemonId }
  | { type: "daemon.authError"; message: string; needEnroll: boolean }
  | { type: "project.validate"; requestId: RequestId; path: string }
  | { type: "worktree.add"; requestId: RequestId; repoPath: string; workspaceId: WorkspaceId; name: string; branch: string; createNew: boolean }
  /** fire-and-forget：移除一个 worktree 目录 */
  | { type: "worktree.remove"; repoPath: string; worktreePath: string }
  /** 热升级：切到某个 worker 版本。带 url 走"下载+验签"；不带则按版本标签在 supervisor 自有注册表里切换。fire-and-forget */
  | { type: "worker.upgrade"; version: string; url?: string; sha256?: string; signature?: string }
  | { type: "session.create"; sessionId: SessionId; taskId: TaskId; cwd: string; shell?: string; cols: number; rows: number }
  | { type: "session.close"; sessionId: SessionId }
  | { type: "session.replay"; sessionId: SessionId; requestId: RequestId }
  // pty.input 走二进制数据面（见 encodeFrame/decodeFrame），不在 JSON 联合体内
  | { type: "pty.resize"; sessionId: SessionId; cols: number; rows: number }
  /** 通用原语：一次性命令 */
  | { type: "exec.run"; requestId: RequestId; cwd: string; command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }
  /** 通用原语：文件系统（root 为锚定根，path 为相对路径，daemon 校验不越界） */
  | { type: "fs.list"; requestId: RequestId; root: string; path: string }
  | { type: "fs.read"; requestId: RequestId; root: string; path: string };

/* ================================================================== *
 * Client  <->  Server
 * ================================================================== */

export type ClientToServer =
  | { type: "client.auth"; clientToken: string }
  | { type: "client.subscribe" }
  | { type: "client.removeDevice"; daemonId: DaemonId }
  /** 触发某设备的 worker 热升级到指定版本（管理操作；账号内校验归属）。带 url 走下载+验签 */
  | { type: "client.upgradeDaemon"; daemonId: DaemonId; version: string; url?: string; sha256?: string; signature?: string }
  /** 导入一个 git 仓库为 project（自动创建主工作区） */
  | { type: "project.import"; daemonId: DaemonId; path: string; name?: string }
  | { type: "project.remove"; projectId: ProjectId }
  /** 在 project 下用 git worktree 新建工作区 */
  | { type: "workspace.create"; projectId: ProjectId; name: string; branch: string; createNew: boolean }
  | { type: "workspace.remove"; workspaceId: WorkspaceId }
  | { type: "task.create"; workspaceId: WorkspaceId; title: string }
  | { type: "task.start"; taskId: TaskId; cols: number; rows: number }
  | { type: "task.attach"; taskId: TaskId }
  | { type: "task.stop"; taskId: TaskId }
  | { type: "task.remove"; taskId: TaskId }
  // pty.input 走二进制数据面（见 encodeFrame/decodeFrame），不在 JSON 联合体内
  | { type: "pty.resize"; sessionId: SessionId; cols: number; rows: number }
  /** 通用原语（IDE/工具用）：在某工作区里跑命令、读/列文件。requestId 由 client 自定，server 原样回带 */
  | { type: "client.exec"; requestId: RequestId; workspaceId: WorkspaceId; command: string; args: string[]; timeoutMs?: number }
  | { type: "client.fs.list"; requestId: RequestId; workspaceId: WorkspaceId; path: string }
  | { type: "client.fs.read"; requestId: RequestId; workspaceId: WorkspaceId; path: string };

export type ServerToClient =
  | { type: "auth.ok"; accountId: AccountId }
  | { type: "auth.error"; message: string }
  | { type: "state.snapshot"; daemons: DaemonInfo[]; projects: Project[]; workspaces: Workspace[]; tasks: Task[] }
  | { type: "daemon.updated"; daemon: DaemonInfo }
  | { type: "daemon.removed"; daemonId: DaemonId }
  | { type: "project.created"; project: Project }
  | { type: "project.removed"; projectId: ProjectId }
  | { type: "workspace.created"; workspace: Workspace }
  | { type: "workspace.removed"; workspaceId: WorkspaceId }
  | { type: "task.updated"; task: Task }
  | { type: "task.removed"; taskId: TaskId }
  /** 本 client 对该任务的控制权被另一个 client 接管（独占模型） */
  | { type: "task.detached"; taskId: TaskId }
  // pty.output 走二进制数据面（见 encodeFrame/decodeFrame），不在 JSON 联合体内
  | ExecResult
  | FsListed
  | FsReadResult
  | { type: "error"; message: string };

/* ================================================================== *
 * 小工具
 * ================================================================== */

export function encode(msg: unknown): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string | Buffer): T {
  return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as T;
}

/* ------------------------------------------------------------------ *
 * 数据面二进制帧（pty.output / pty.input / pty.replay）
 *
 * 控制面仍走 JSON 文本帧；高频数据面改长度前缀二进制帧，免 JSON 转义、降 CPU/带宽。
 * 帧体布局（不含外层长度前缀）：
 *   [kind:1][sidLen:1][sessionId:utf8(sidLen)][? ridLen:1][? requestId:utf8(ridLen)][payload:utf8 到帧尾]
 * - kind: 1=pty.output 2=pty.input 3=pty.replay（仅 replay 带 requestId）。
 * - 在 WS 上：每个二进制 message 即一帧（WS 自带分帧），payload 取到帧尾。
 * - 在字节流（UDS，热升级用）上：外层再包 4 字节大端长度前缀分帧，帧体格式不变。
 * 用 Uint8Array/TextEncoder 实现，Node 与浏览器通用。
 * ------------------------------------------------------------------ */

export const FrameKind = { Output: 1, Input: 2, Replay: 3 } as const;

export type DataFrame =
  | { type: "pty.output"; sessionId: SessionId; data: string }
  | { type: "pty.input"; sessionId: SessionId; data: string }
  | { type: "pty.replay"; sessionId: SessionId; requestId: RequestId; data: string };

const _te = new TextEncoder();
const _td = new TextDecoder();

/** 把数据面消息编码为二进制帧。sessionId/requestId 为服务器签发的短 id（< 256 字节）。 */
export function encodeFrame(msg: DataFrame): Uint8Array {
  const sid = _te.encode(msg.sessionId);
  if (sid.length > 255) throw new RangeError("sessionId too long for frame");
  const payload = _te.encode(msg.data);
  const rid = msg.type === "pty.replay" ? _te.encode(msg.requestId) : null;
  if (rid && rid.length > 255) throw new RangeError("requestId too long for frame");
  const head = 2 + sid.length + (rid ? 1 + rid.length : 0);
  const out = new Uint8Array(head + payload.length);
  out[0] = msg.type === "pty.output" ? FrameKind.Output : msg.type === "pty.input" ? FrameKind.Input : FrameKind.Replay;
  out[1] = sid.length;
  out.set(sid, 2);
  let off = 2 + sid.length;
  if (rid) {
    out[off++] = rid.length;
    out.set(rid, off);
    off += rid.length;
  }
  out.set(payload, off);
  return out;
}

/** 解码二进制帧；畸形返回 null（调用方丢弃，不崩溃）。 */
export function decodeFrame(buf: Uint8Array): DataFrame | null {
  if (buf.length < 2) return null;
  const kind = buf[0];
  const sidLen = buf[1];
  if (buf.length < 2 + sidLen) return null;
  const sessionId = _td.decode(buf.subarray(2, 2 + sidLen));
  let off = 2 + sidLen;
  if (kind === FrameKind.Output || kind === FrameKind.Input) {
    return { type: kind === FrameKind.Output ? "pty.output" : "pty.input", sessionId, data: _td.decode(buf.subarray(off)) };
  }
  if (kind === FrameKind.Replay) {
    if (buf.length < off + 1) return null;
    const ridLen = buf[off++];
    if (buf.length < off + ridLen) return null;
    const requestId = _td.decode(buf.subarray(off, off + ridLen));
    off += ridLen;
    return { type: "pty.replay", sessionId, requestId, data: _td.decode(buf.subarray(off)) };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 入站消息运行时校验（防畸形 wire 数据崩溃 / 类型混淆）
 * ------------------------------------------------------------------ */

type FieldSpec = "string" | "number" | "boolean" | "array";

const DAEMON_TO_SERVER_FIELDS: Record<string, Record<string, FieldSpec>> = {
  "daemon.enroll": { enrollmentKey: "string", name: "string", host: "string", platform: "string" },
  "daemon.auth": { deviceToken: "string" },
  "daemon.resync": { sessions: "array" },
  "project.validated": { requestId: "string", ok: "boolean", repoPath: "string", branch: "string" },
  "worktree.added": { requestId: "string", ok: "boolean", path: "string", branch: "string" },
  "session.started": { sessionId: "string", taskId: "string", pid: "number" },
  "session.exit": { sessionId: "string", exitCode: "number" },
  "exec.result": { requestId: "string", ok: "boolean", exitCode: "number", stdout: "string", stderr: "string" },
  "fs.listed": { requestId: "string", ok: "boolean", entries: "array" },
  "fs.read.result": { requestId: "string", ok: "boolean", content: "string" },
};

const CLIENT_TO_SERVER_FIELDS: Record<string, Record<string, FieldSpec>> = {
  "client.auth": { clientToken: "string" },
  "client.subscribe": {},
  "client.removeDevice": { daemonId: "string" },
  "client.upgradeDaemon": { daemonId: "string", version: "string" },
  "project.import": { daemonId: "string", path: "string" },
  "project.remove": { projectId: "string" },
  "workspace.create": { projectId: "string", name: "string", branch: "string", createNew: "boolean" },
  "workspace.remove": { workspaceId: "string" },
  "task.create": { workspaceId: "string", title: "string" },
  "task.start": { taskId: "string", cols: "number", rows: "number" },
  "task.attach": { taskId: "string" },
  "task.stop": { taskId: "string" },
  "task.remove": { taskId: "string" },
  "pty.resize": { sessionId: "string", cols: "number", rows: "number" },
  "client.exec": { requestId: "string", workspaceId: "string", command: "string", args: "array" },
  "client.fs.list": { requestId: "string", workspaceId: "string", path: "string" },
  "client.fs.read": { requestId: "string", workspaceId: "string", path: "string" },
};

function checkType(v: unknown, t: FieldSpec): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
  }
}

function validate(msg: unknown, specs: Record<string, Record<string, FieldSpec>>): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== "string") return false;
  const fields = specs[m.type];
  if (!fields) return false;
  for (const [k, t] of Object.entries(fields)) if (!checkType(m[k], t)) return false;
  return true;
}

export function isValidDaemonToServer(msg: unknown): msg is DaemonToServer {
  return validate(msg, DAEMON_TO_SERVER_FIELDS);
}

export function isValidClientToServer(msg: unknown): msg is ClientToServer {
  return validate(msg, CLIENT_TO_SERVER_FIELDS);
}

/** 把任意输入钳制为合法终端尺寸 */
export function clampDim(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(1, Math.min(1000, v));
}
