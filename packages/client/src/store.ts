import { emptyNotificationInbox, applyNotificationPage, applyNotificationChange, type NotificationInbox } from "./notifications";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  TaskStatus,
  CONTROL_PROTOCOL_VERSION,
  SecretAnswerKind,
  SecretAnswerStatus,
  type AccountNotification,
  type Annotation,
  type AnnotationPut,
  type DeviceAnnotationsMutate,
  create,
  AnnotationClearResolvedSchema,
  AnnotationDeleteSchema,
  AnnotationReopenSchema,
  AnnotationRestoreSchema,
  type ClientToServerPayload,
  type DaemonInfo,
  type DeviceSessionCatalog,
  type FsEntry,
  type Project,
  type Task,
  type Workspace,
} from "@coflux/protocol";

/* ------------------------------------------------------------------ *
 * 工作区活动状态（plan 073；hook 化后不再做输出安静度推断）
 * ------------------------------------------------------------------ */

/** state 来自 agent hook 上报（daemon 侧合并进 presence）。空 = 无 hook 信号。 */
export type SessionAgentState = {
  daemonId: string;
  taskId: string;
  agent: string;
  state: string;
  /** `coflux notify` 的留言（plan 074），空 = agent 没留话 */
  message: string;
  /** `coflux progress` 的进度短评（plan 088）：跨 hook 事件存活，覆盖式，空 = 没播报过 */
  progress: string;
  /** agent 自己的会话标识（plan 20260919）：claude 的 session_id / codex 的 thread-id，
   * 客户端据此定位 transcript 文件。空 = 旧 worker、旧离线缓存或未上报——**按"没有 id"处理，
   * 别信这里的 string 类型**（离线缓存里恢复出来的旧条目根本没有这个字段）。 */
  agentSessionId: string;
};

/** A pending secret request (plan 20260926-agent-secret-input): an agent in the terminal
 * `sessionId` / `taskId` asked the user for `name`. Metadata only — the value never passes through
 * the client store. `reason` is the agent's own text and must be presented as such. Replaced per
 * device by `secretRequestsUpdated`; a request that leaves the set is settled or gone. */
export type SecretRequestState = {
  requestId: string;
  daemonId: string;
  sessionId: string;
  taskId: string;
  name: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
};

/** The worker's acknowledgement of a secret answer, or a local failure to deliver it (`failed`:
 * the device was unreachable or the request timed out — the card keeps its input for a retry). */
export type SecretAnswerResult =
  | { status: "accepted" | "already_answered" | "expired" | "unknown_request" | "invalid" }
  | { status: "failed"; error: string };

export type SecretAnswer = { kind: "provide"; value: string } | { kind: "decline" } | { kind: "cancel" };

/** One live executor run (plan 20260929-executor-pip), bound to the terminal (`sessionId` /
 * `taskId`) whose agent ran `coflux executor run`. Metadata only: the transcript arrives through
 * `subscribeExecutorTranscript`. `title` is the agent's text (or its prompt's first line) and must
 * be presented as such. Replaced per device by `executorRunsUpdated`. */
export type ExecutorRunState = {
  runId: string;
  daemonId: string;
  sessionId: string;
  taskId: string;
  title: string;
  write: boolean;
  phase: "queued" | "accepted" | "running";
  submittedAt: number;
  /** 0 until the host reported the run running. */
  startedAt: number;
  /** The host executing the run is not connected to the worker right now. */
  hostLost: boolean;
};

export type { ExecutorTranscriptEvent } from "./device-router";

function secretAnswerResult(status: SecretAnswerStatus): SecretAnswerResult {
  switch (status) {
    case SecretAnswerStatus.ACCEPTED:
      return { status: "accepted" };
    case SecretAnswerStatus.ALREADY_ANSWERED:
      return { status: "already_answered" };
    case SecretAnswerStatus.EXPIRED:
      return { status: "expired" };
    case SecretAnswerStatus.UNKNOWN_REQUEST:
      return { status: "unknown_request" };
    default:
      return { status: "invalid" };
  }
}

/** One workspace's browser annotation summary (plan 20260929-browser-annotations): the revision
 * and counts the center relays. Content is never here; it is fetched over the Device channel. */
export type AnnotationSummaryState = {
  daemonId: string;
  revision: number;
  pending: number;
  resolved: number;
};

/** Why an annotation call failed: `unsupported` = the device runs an older coflux (from its own
 * reply, never a timeout); `unreachable` = the device could not be reached or did not answer;
 * `refused` = the worker answered and refused (the message says why). */
export type AnnotationFailure = { ok: false; reason: "unsupported" | "unreachable" | "refused"; error: string };
/** `codeComments`: the device's worker stores code comments (annotations with a code anchor, plan
 * 20261001-changes-review-comments); an older worker lists only page annotations. */
export type AnnotationListResult = { ok: true; revision: number; annotations: Annotation[]; codeComments: boolean } | AnnotationFailure;
/** `removedIds`: for a delete or clear-resolved, exactly the ids it removed — what one 「撤销」
 * (`restore`) brings back within the worker's undo window (plan 20260929-annotation-polish). */
export type AnnotationMutateResult = { ok: true; revision: number; annotation?: Annotation; removedIds: string[] } | AnnotationFailure;
export type AnnotationImageResult = { ok: true; mimeType: string; data: Uint8Array } | AnnotationFailure;
/** `held`: someone else holds the terminal. */
export type AnnotationHandOffResult = { ok: true } | (AnnotationFailure & { held?: boolean });
export type AnnotationChange =
  | { kind: "put"; put: AnnotationPut }
  | { kind: "delete"; annotationIds: string[] }
  | { kind: "reopen"; annotationId: string; comment: string }
  | { kind: "clear-resolved" }
  | { kind: "restore"; annotationIds: string[] };

/** The pause between a handed-off instruction and its Enter: an agent's TUI treats one fast burst
 * ending in CR as a paste. The worker's path uses the same value. */
const HAND_OFF_ENTER_DELAY_MS = 150;

/** Upper bound on the image bytes one annotation save carries (plan 20260929-browser-annotations).
 * A save is one Device frame (MAX_DEVICE_FRAME_BYTES = 30 MiB); the rest is headroom for the comment,
 * element context, envelope and transport overhead. A frame that cannot be sent would otherwise
 * tear the whole session lane down, so an oversized save is refused before it is sent. */
export const MAX_ANNOTATION_UPLOAD_BYTES = 24 * 1024 * 1024;

/** The readable refusal for a save over the budget, shared with the desktop's attach check. */
export const ANNOTATION_UPLOAD_TOO_LARGE = "图片总大小超过 24 MB，删掉几张参考图后再保存";

function annotationFailure(error: unknown): AnnotationFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === ANNOTATION_FRAME_TOO_LARGE) return { ok: false, reason: "refused", error: ANNOTATION_UPLOAD_TOO_LARGE };
  return { ok: false, reason: code === ANNOTATIONS_UNSUPPORTED ? "unsupported" : "unreachable", error: message };
}

export type WorkspaceActivity =
  | { status: "idle" }
  | { status: "active"; agent?: string }
  /** `taskId`: the waiting terminal whose agent is named here — the first approval (else question) in `tasks` order. */
  | { status: "approval"; agent: string; taskId?: string }
  | { status: "question"; agent: string; message?: string; taskId?: string }
  | { status: "done"; agent: string };

/** 工作区活动聚合（对齐 Vibe Island）：纯粹转述 hook 上报，无阈值、无时钟推断。
 * 多 session 冲突时 approval > question > active > done。设备离线 / 无 hook 信号一律中性。
 * 旧 worker 的 "waiting" 按 done 收（避免把「刚说完」误标成要你动手）。 */
export function workspaceActivity(
  workspaceId: string,
  daemonOnline: boolean,
  tasks: readonly Task[],
  sessionAgents: Record<string, SessionAgentState>,
): WorkspaceActivity {
  if (!daemonOnline) return { status: "idle" };
  let approval: { agent: string; taskId: string } | null = null;
  let question: { entry: SessionAgentState; taskId: string } | null = null;
  let active: string | undefined;
  let done: string | null = null;
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || task.status !== TaskStatus.RUNNING || !task.sessionId) continue;
    const entry = sessionAgents[task.sessionId];
    if (entry === undefined) continue;
    if (entry.state === "approval") approval = approval ?? { agent: entry.agent, taskId: task.id };
    else if (entry.state === "question") question = question ?? { entry, taskId: task.id };
    else if (entry.state === "active") active = active ?? entry.agent;
    else if (entry.state === "done" || entry.state === "waiting") done = done ?? entry.agent;
  }
  if (approval !== null) return { status: "approval", agent: approval.agent, taskId: approval.taskId };
  if (question !== null) return { status: "question", agent: question.entry.agent, message: question.entry.message || undefined, taskId: question.taskId };
  if (active !== undefined) return { status: "active", agent: active };
  if (done !== null) return { status: "done", agent: done };
  return { status: "idle" };
}

/** 工作区进度短评（plan 088）：RUNNING 任务的 presence 里第一条非空 progress。
 * 与活动状态是两个维度——状态永远由 hooks 自动判定，短评永远由 agent 主动播报，
 * 互不覆盖；agent 进程退出时随 presence 条目一起消失。 */
export function workspaceProgress(
  workspaceId: string,
  tasks: readonly Task[],
  sessionAgents: Record<string, SessionAgentState>,
): string | undefined {
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || task.status !== TaskStatus.RUNNING || !task.sessionId) continue;
    const progress = sessionAgents[task.sessionId]?.progress;
    if (progress) return progress;
  }
  return undefined;
}

import { createConnection, type AuthCredential, type ClientKind, type ConnectionStatus, type ServerPayload } from "./connection";
import {
  ANNOTATION_FRAME_TOO_LARGE,
  ANNOTATIONS_UNSUPPORTED,
  createDeviceRouter,
  type DeviceInputState,
  type DeviceRouter,
  type DeviceTransportState,
  type ExecutorTranscriptEvent,
} from "./device-router";

export type { AuthCredential, ConnectionStatus } from "./connection";
// "outdated"：版本准入被拒（plan 033 / 105：桌面按控制面协议版本）——不是认证失败，
// UI 须走独立展示面，不与 auth-failed 的 loginError 混用（语义不同，混用会误导用户）。
export type AuthState = "need-login" | "authenticating" | "authed" | "auth-failed" | "outdated";
export type PortPreview = { port: number; url: string };
export type ClientError = { id: number; message: string };
export type FsListResult = { ok: boolean; entries: FsEntry[]; error: string; path?: string };
export type ExecResult = { ok: boolean; exitCode: number; stdout: string; stderr: string; error: string };
export type FsWriteResult = { ok: boolean; path?: string; error: string };

/* Workspace changes (plans 20260929-changes-file-tree, 20261001-changes-review-polish): the shapes
 * and the response mapping live in ./changes. */
import { changesFailure, toChangeFileResult, toChangesListResult, whitespaceWire, type ChangeFileResult, type ChangesListResult, type WhitespaceMode } from "./changes";
export type { ChangedFile, ChangedFileStatus, ChangesFailure, ChangesListResult, ChangeFileResult, ChangesOption, WhitespaceMode } from "./changes";
import {
  fileIndexFailure,
  fileReadFailure,
  fileStatFailure,
  toFileIndexResult,
  toFileReadResult,
  toFileStatResult,
  type FileIndexResult,
  type FileReadResult,
  type FileStatResult,
} from "./files";
export type { FileIndexEntry, FileIndexResult, FileReadResult, FileStat, FileStatResult } from "./files";
/** 设备授权兑现结果（plan 112；与桌面版 plan 113 的契约）：失败文案来自服务端 `deviceAuthorizeInfo{ ok:false }`
 * 或本地（未登录 / 连接未就绪 / 断连 / 超时）。 */
export type DeviceAuthorizeResult = { ok: true } | { ok: false; error: string };
const TASK_READ_TIMEOUT_MS = 15_000;
/** deviceAuthorize 的等待上限：服务端要把 DaemonEnrolled 送达 daemon 并等它上线才回 deviceAuthorized。 */
const DEVICE_AUTHORIZE_TIMEOUT_MS = 20_000;
/** A minted one-time device join key (plan 20260924-device-join-keys); `expiresAt` is ms epoch from the
 * server. Failures come from the server (`deviceJoinKeyCreated{ error }`) or are local (not signed in,
 * connection lost, timeout — also what an older server that ignores the request produces). */
export type DeviceJoinKeyResult = { ok: true; key: string; expiresAt: number } | { ok: false; error: string };
/** Answer to `ensureDirectoryWorkspace` (plan 20260929-remote-desktop). */
export type DirectoryWorkspaceResult = { ok: true; workspaceId: string } | { ok: false; error: string };
const DEVICE_JOIN_KEY_TIMEOUT_MS = 15_000;

/** One agent's launch setting as the account stores it (plan 20261002-account-agent-settings). The
 * center does not know the agent catalog; the desktop maps the ids it knows and ignores the rest. */
export type AccountAgentSetting = { enabled: boolean; command: string };
/** The account's agent launch settings: agent id → setting. An id that is absent is off. */
export type AccountAgentSettings = Readonly<Record<string, AccountAgentSetting>>;
/** Answer to `setAgentSetting`: the center accepted the write (its broadcast has already replaced
 * `agentSettings`), or it failed — refused by the center, or locally (not connected, the center does
 * not support it, the configuration of this connection has not arrived, disconnected, timed out). */
export type AgentSettingWriteResult = { ok: true } | { ok: false; error: string };
const AGENT_SETTING_WRITE_TIMEOUT_MS = 15_000;
const EMPTY_AGENT_SETTINGS: AccountAgentSettings = Object.freeze({});

/** 已退出终端的最后输出来源（plan 097）：snapshot / checkpoint = 规范化 ANSI 屏幕（分别来自 daemon 当前画面与
 * 中心缓存）；none = 没有任何可回放内容。 */
export type TaskReadSource = "snapshot" | "checkpoint" | "none";
export type TaskReadResult =
  | { ok: true; taskId: string; data: Uint8Array; source: TaskReadSource; capturedAt: number; status: TaskStatus; exitCode?: number }
  | { ok: false; error: string };
type SessionConsumer = (data: Uint8Array, replace: boolean) => void;
/** Receives a whole rendered screen that replaces what the pane shows (plan
 * 20261010-terminal-checkpoint-energy): the content of a terminal the pane is not live-attached to. */
export type SessionContentConsumer = (data: Uint8Array) => void;

/** A terminal's metadata (plan 20261010-terminal-checkpoint-energy): its OSC title. The entry's
 * identity changes only when a field changes, so selectors on it do not re-render on every report. */
export type SessionMetadataState = { sessionId: string; taskId: string; title: string };

/** Refresh period of a visible pane that shows a live terminal without being attached to it
 * (held by another device): the cadence the old checkpoint push had. */
const SESSION_CONTENT_REFRESH_MS = 2_000;
/** First fetch of a pane that just became visible: long enough for an ordinary attach to make the
 * session live first, so the common case fetches nothing. */
const SESSION_CONTENT_FIRST_FETCH_MS = 300;

export type LocalSessionState = {
  daemonId: string;
  sessionId: string;
  taskId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  status: "running" | "exited";
  exitCode?: number;
  exitedAt?: number;
};

export type DeviceTransportOptions = {
  nativeRemote?: import("./device-router").NativeRemoteTransport;
  /** 是否尝试 loopback direct；false 只使用中心 opaque relay。 */
  enableLocalTransport: boolean;
  identityDatabaseName: string;
  /** 自报 Origin（loopback grant 绑定的一部分）：client 不推导 location，由调用方给出。 */
  origin: string;
};

export type OfflineCatalogStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * 会话 token 的持久化（plan 106）：client 不知道 token 落在哪（桌面是主进程 safeStorage 加密文件），
 * 只经这三个同步方法读写。read 在创建 client 时调用一次——调用方须保证此时 token 已就绪；
 * write 在登录成功（authOk 带新 token）时调用，clear 在登出 / 认证失败时调用。
 */
export type TokenStorage = {
  /** 没有 token 返回空串 */
  read(): string;
  write(token: string): void;
  clear(): void;
};

/**
 * 离线目录缓存（plan 103）：中心离线也能冷启动看本机终端。开启后每次中心目录变化都把
 * 渲染工作台所需的目录（daemons / projects / workspaces / tasks / ports / sessionAgents）写进 storage；
 * 冷启动有 token 但首连拿不到 authOk（连不上、authOk 前断开、或超时）时装载缓存进 store 并置 authed，
 * 连接状态保持非 connected（重连横幅照常显示），RUNNING 终端经缓存的 loopback grant attach
 * （session read/control 是 offline grant scope，不需要中心签发的 lease）。中心随后连上并 authOk 时，
 * 真实 snapshot 照旧覆盖缓存。登出 / 认证失败 / 换账号时清掉。不传 = 不缓存、不装载。
 */
export type OfflineCatalogOptions = {
  storage: OfflineCatalogStorage;
  /** 按服务器地址区分，换中心不串目录 */
  key: string;
  /** 首连在此时限内没拿到 authOk 就装载缓存（默认 5000ms） */
  timeoutMs?: number;
};

export type CofluxClientOptions = {
  /** 只在真实认证成功后通知桌面层；缓存的离线状态不触发。 */
  onAuthenticated?: () => void;
  /** /client WS 端点地址（含协议与路径）。 */
  serverUrl: string;
  /** 会话 token 的存取；创建 client 时同步 read 一次。 */
  tokenStorage: TokenStorage;
  /** 构建版本（git short SHA；dev 固定 "dev"），随认证上报供 server 做版本准入（plan 033）。 */
  buildId: string;
  /** 客户端类型（plan 105）：desktop 由 server 按控制面协议版本准入（不看 build-id）；不传 = web（冻结的线上 web 仍在上报）。 */
  clientKind?: ClientKind;
  /** 所有客户端统一走 DeviceTransport；是否尝试 loopback direct 由 enableLocalTransport 决定。 */
  deviceTransport: DeviceTransportOptions;
  /** 离线目录缓存；不传 = 不缓存、不装载。 */
  offlineCatalog?: OfflineCatalogOptions;
};

const OFFLINE_CATALOG_VERSION = 1;
const OFFLINE_CATALOG_TIMEOUT_MS = 5000;

type OfflineCatalog = {
  version: number;
  savedAt: number;
  /** 登录身份显示串（plan 110）：离线冷启动也要认得出「我是谁」。旧缓存没有此字段，按空串兼容 */
  loginName: string;
  daemons: DaemonInfo[];
  projects: Project[];
  workspaces: Workspace[];
  tasks: Task[];
  ports: Record<string, PortPreview[]>;
  sessionAgents: Record<string, SessionAgentState>;
  /** The account's agent launch settings (plan 20261002-account-agent-settings) and the account they
   * belong to. Absent in a cache written before that plan: no agent configuration, all off. */
  agentSettings?: { accountId: string; agents: AccountAgentSettings };
};

/** The agent settings saved with the offline catalog; anything malformed reads as none. */
function restoreAgentSettings(value: unknown): { accountId: string; agents: AccountAgentSettings } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { accountId, agents } = value as { accountId?: unknown; agents?: unknown };
  if (typeof accountId !== "string" || !accountId || !agents || typeof agents !== "object" || Array.isArray(agents)) return undefined;
  const restored: Record<string, AccountAgentSetting> = {};
  for (const [agentId, entry] of Object.entries(agents as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { enabled, command } = entry as { enabled?: unknown; command?: unknown };
    restored[agentId] = { enabled: enabled === true, command: typeof command === "string" ? command : "" };
  }
  return { accountId, agents: restored };
}

/** 离线缓存里的 presence 条目（plan 20260919）：plan 之前写下的缓存没有 agentSessionId，
 * TS 类型却照旧声称有。恢复时统一补齐成空串，调用方才不必到处 `?? ""`。 */
function restoreSessionAgents(value: Record<string, SessionAgentState> | undefined): Record<string, SessionAgentState> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).map(([sessionId, entry]) => [
      sessionId,
      { ...entry, agentSessionId: typeof entry?.agentSessionId === "string" ? entry.agentSessionId : "" },
    ]),
  );
}

function parseOfflineCatalog(raw: string | null): OfflineCatalog | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const catalog = parsed as Partial<OfflineCatalog>;
    if (catalog.version !== OFFLINE_CATALOG_VERSION) return null;
    if (![catalog.daemons, catalog.projects, catalog.workspaces, catalog.tasks].every(Array.isArray)) return null;
    return {
      version: OFFLINE_CATALOG_VERSION,
      savedAt: typeof catalog.savedAt === "number" ? catalog.savedAt : 0,
      // 缺字段的旧缓存（plan 110 之前写的）只是没有身份，不该整份作废——版本号仍是 1。
      loginName: typeof catalog.loginName === "string" ? catalog.loginName : "",
      daemons: catalog.daemons as DaemonInfo[],
      projects: catalog.projects as Project[],
      workspaces: catalog.workspaces as Workspace[],
      tasks: catalog.tasks as Task[],
      ports: catalog.ports && typeof catalog.ports === "object" ? catalog.ports : {},
      sessionAgents: restoreSessionAgents(catalog.sessionAgents),
      // Same tolerance as loginName: a cache from before plan 20261002 just has no agent settings.
      agentSettings: restoreAgentSettings(catalog.agentSettings),
    };
  } catch {
    return null;
  }
}

export type CofluxState = {
  notificationInbox: NotificationInbox;
  status: ConnectionStatus;
  authState: AuthState;
  loginError: string;
  /** 当前连接的登录身份显示串（plan 110）：password 模式是 email、local 模式是用户名。
   * 由 authOk 下发（旧 server 不回 = 空串），随离线目录缓存落盘，登出 / 认证失败清空。
   * 展示用，别拿它当账号主键。 */
  loginName: string;
  daemons: DaemonInfo[];
  projects: Project[];
  workspaces: Workspace[];
  tasks: Task[];
  ports: Record<string, PortPreview[]>;
  detachedTaskIds: Set<string>;
  deviceTransports: Record<string, DeviceTransportState>;
  inputStates: Record<string, DeviceInputState>;
  localSessions: LocalSessionState[];
  /** Terminal metadata (plan 20261010-terminal-checkpoint-energy): sessionId → title. Content never
   * lives here — panes fetch it, or take it from a non-reactive cache, only while visible. */
  sessionMetadata: Record<string, SessionMetadataState>;
  /** agent presence + hook 回合状态（plan 073）：sessionId → agent/state。来自 sessionAgentsUpdated 按设备全量替换。 */
  sessionAgents: Record<string, SessionAgentState>;
  /** Pending secret requests (plan 20260926-agent-secret-input): requestId → request, replaced per
   * device by secretRequestsUpdated. Live-only: never written to the offline catalog. */
  secretRequests: Record<string, SecretRequestState>;
  /** Live executor runs (plan 20260929-executor-pip): runId → run, replaced per device by
   * executorRunsUpdated. Live-only, like secretRequests; a run that leaves the set has ended. */
  executorRuns: Record<string, ExecutorRunState>;
  /** Browser annotation summaries (plan 20260929-browser-annotations): workspaceId → revision and
   * counts, replaced per device by annotationsSummaryUpdated. Live-only, like secretRequests. */
  annotationSummaries: Record<string, AnnotationSummaryState>;
  /** The account's agent launch settings (plan 20261002-account-agent-settings), replaced whole by
   * every `agentSettingsUpdated`. Kept across disconnects and saved with the offline catalog, so the
   * last configuration this client received stays usable offline; reset only when the account
   * changes (or the center does not support it). Never zeroed at authOk: until the first push of a
   * connection arrives, it is the previous value — see `agentSettingsReceived`. */
  agentSettings: AccountAgentSettings;
  /** The center of the current connection serves agent settings (`AuthOk.agent_settings`). False
   * before the first authOk and against an older center: there is nothing to edit there. */
  agentSettingsSupported: boolean;
  /** The account's configuration has arrived on this connection. Until then `agentSettings` may be
   * stale, so it must not be edited: an edit based on it would be broadcast as the truth. */
  agentSettingsReceived: boolean;
  lastError: ClientError | null;
  snapshotRevision: number;
};

/** Replace or append `item`. An existing entry with the same own fields keeps the list's identity, so a
 * periodic refresh that changes nothing does not re-render its subscribers. */
function upsert<T extends object>(list: T[], item: T, match: (value: T) => boolean): T[] {
  const index = list.findIndex(match);
  if (index === -1) return [...list, item];
  if (shallowEqual(list[index]!, item)) return list;
  const next = list.slice();
  next[index] = item;
  return next;
}

function shallowEqual<T extends object>(left: T, right: T): boolean {
  const leftKeys = Object.keys(left) as (keyof T)[];
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** 目录工作区（无 repo 终端，plan 045）：projectId 为空即目录工作区。
 * 判定在客户端收敛于此一处，勿在 UI 层散落裸比较。 */
export function isDirWorkspace(workspace: Workspace): boolean {
  return !workspace.projectId;
}

/* Optimistic removal (plan 20261002-optimistic-removal): a pending removal leaves the visible
 * arrays at once and its last server copy is parked by id until the centre settles it or it rolls back. */
type RemovalKind = "task" | "workspace" | "project";
const REMOVAL_KINDS: readonly RemovalKind[] = ["task", "workspace", "project"];
/** Fallback when the centre never answers (it sends no acknowledgement): on the order of its
 * prepared-operation TTL, since `git worktree remove --force` on a large tree is legitimately slow. */
const REMOVAL_FALLBACK_TIMEOUT_MS = 5 * 60_000;
type PendingRemoval = {
  kind: RemovalKind;
  id: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The subscribe epoch the request was sent in; null = still queued (terminal close while offline). */
  sentEpoch: number | null;
};
/** Parked copies of hidden entities, with their position in the visible array when they were hidden
 * and the order they were hidden in (restoring in reverse undoes the hides exactly). */
type Parked<T> = Map<string, { item: T; index: number; seq: number }>;
let parkSequence = 0;

/** Moves now-hidden items from `visible` into `parked`, and parked items no longer hidden back to their old position. */
function partitionVisible<T extends { id: string }>(visible: T[], parked: Parked<T>, hidden: (item: T) => boolean): T[] {
  let next = visible;
  if (visible.some(hidden)) {
    next = [];
    for (const item of visible) {
      // As if hidden one at a time: its position among the items still visible at that moment.
      if (hidden(item)) parked.set(item.id, { item, index: next.length, seq: ++parkSequence });
      else next.push(item);
    }
  }
  const back = [...parked.values()].filter((entry) => !hidden(entry.item)).sort((left, right) => right.seq - left.seq);
  if (back.length > 0) {
    next = next.slice();
    for (const entry of back) {
      parked.delete(entry.item.id);
      if (next.some((item) => item.id === entry.item.id)) continue;
      next.splice(Math.min(entry.index, next.length), 0, entry.item);
    }
  }
  return next;
}

/** An incoming upsert that respects pending removals: a hidden entity only refreshes its parked copy. */
function upsertVisible<T extends { id: string }>(visible: T[], parked: Parked<T>, item: T, hidden: (item: T) => boolean): T[] {
  const entry = parked.get(item.id);
  if (hidden(item)) {
    if (entry) {
      parked.set(item.id, { ...entry, item });
      return visible;
    }
    return partitionVisible(upsert(visible, item, (value) => value.id === item.id), parked, hidden);
  }
  // Moved out of a hidden scope (e.g. a worktree follow out of a workspace being removed): visible again.
  if (entry) parked.delete(item.id);
  return upsert(visible, item, (value) => value.id === item.id);
}

function withoutSetValue(values: Set<string>, value: string): Set<string> {
  if (!values.has(value)) return values;
  const next = new Set(values);
  next.delete(value);
  return next;
}

/**
 * 主页面状态 store：zustand vanilla store 只承载控制面（实体集合 / 连接态 / 控制权态）。
 * PTY 数据流（ptyOutput）绝不进 store——经 consumer 注册表（普通 Map，非响应式）直达 terminal.write。
 *
 * 须在顶层页面组件内只创建一次（如 useState(() => createCofluxClient(options))[0]）：
 * 连接生命周期需要与调用方显式配对 disconnect()。
 */
export function createCofluxClient(options: CofluxClientOptions) {
  let token = options.tokenStorage.read();
  // 本地已有会话 token = 之前认证成功过，首条连接就该纳入自动重连。此前初值是 false，
  // 于是刷新后的第一条连接若在 authOk 到达前断掉（链路被静默掐、或 server 的 authDeadline
  // 关闭），reconnectCredential() 返回 null，连接永久停在断开态等用户再刷一次。
  // 清零点仍是 authError / clientOutdated / logout 三处。
  let shouldRetry = token !== "";
  let controlAuthenticated = false;
  let errorSequence = 0;
  let notificationAccount = "";
  let notificationSupported = false;
  let notificationInitialCutoff = Infinity;
  let notificationRequest = 0;
  const notificationRequestPrefix = crypto.randomUUID();
  let notificationPageRequestId = "initial";
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  const notificationListeners = new Set<(item: AccountNotification) => void>();
  const notificationReadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const notifiedIds = new Set<string>();
  function clearNotificationTimers() {
    clearTimeout(notificationTimer);
    notificationTimer = undefined;
    for (const timer of notificationReadTimers.values()) clearTimeout(timer);
    notificationReadTimers.clear();
  }
  function waitForNotificationPage() {
    clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
      store.setState((state) => ({ notificationInbox: { ...state.notificationInbox, loading: false, error: "通知同步超时，请重试" } }));
    }, 15000);
  }

  const sessionConsumers = new Map<string, Set<SessionConsumer>>();
  // plan 097：taskRead 的 pending 表，按 taskId 去重共享（回应不带 request id）。
  const pendingTaskReads = new Map<string, { promise: Promise<TaskReadResult>; resolve: (result: TaskReadResult) => void; timer: ReturnType<typeof setTimeout> }>();
  // 中心离线期间已在本机 stop、但还没能删除的 catalog task；重连认证后补投（见 removeTask）。
  const pendingTaskRemovals = new Set<string>();
  // Optimistic removal (plan 20261002-optimistic-removal). Hidden = pending itself or inside a pending
  // workspace/project (cascade mirrors the centre's workspaceRemoved/projectRemoved broadcasts).
  const removals: Record<RemovalKind, Map<string, PendingRemoval>> = { task: new Map(), workspace: new Map(), project: new Map() };
  const parkedProjects: Parked<Project> = new Map();
  const parkedWorkspaces: Parked<Workspace> = new Map();
  const parkedTasks: Parked<Task> = new Map();
  /** Terminals pending removal whose pane released the session while the stop may still be running:
   * releasing it then would reject closeTask's stop. taskId → session to release once settled or rolled back. */
  const deferredSessionReleases = new Map<string, { daemonId: string; sessionId: string }>();
  /** Bumped right before each clientSubscribe: a snapshot answers the subscribe of the current epoch. */
  let subscribeEpoch = 0;
  const projectHidden = (project: Project) => removals.project.has(project.id);
  const workspaceHidden = (workspace: Workspace) =>
    removals.workspace.has(workspace.id) || (!!workspace.projectId && removals.project.has(workspace.projectId));
  const taskHidden = (task: Task) =>
    removals.task.has(task.id) || removals.workspace.has(task.workspaceId) || (!!task.projectId && removals.project.has(task.projectId));
  // plan 112：在飞的 deviceAuthorize（回应不带 request id，一次只允许一个在飞）。
  let pendingDeviceAuthorize: { resolve: (result: DeviceAuthorizeResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  // Join key mints in flight, keyed by request id (the notificationList pattern): several may overlap,
  // e.g. 换一个 pressed while the first mint is still answering.
  let joinKeyRequest = 0;
  const pendingJoinKeys = new Map<string, { resolve: (result: DeviceJoinKeyResult) => void; timer: ReturnType<typeof setTimeout> }>();
  function settleJoinKey(requestId: string, result: DeviceJoinKeyResult): void {
    const pending = pendingJoinKeys.get(requestId);
    if (!pending) return;
    pendingJoinKeys.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
  function failJoinKeys(error: string): void {
    for (const requestId of [...pendingJoinKeys.keys()]) settleJoinKey(requestId, { ok: false, error });
    for (const requestId of [...pendingDirectoryWorkspaces.keys()]) settleDirectoryWorkspace(requestId, { ok: false, error });
  }

  // Agent-setting writes in flight (plan 20261002-account-agent-settings), keyed by request id. They
  // settle from the center's answer, or as failures on disconnect, logout and timeout — never hang.
  // Failures are returned to the caller only: they never touch lastError.
  let agentSettingRequest = 0;
  const pendingAgentSettingWrites = new Map<string, { resolve: (result: AgentSettingWriteResult) => void; timer: ReturnType<typeof setTimeout> }>();
  function settleAgentSettingWrite(requestId: string, result: AgentSettingWriteResult): void {
    const pending = pendingAgentSettingWrites.get(requestId);
    if (!pending) return;
    pendingAgentSettingWrites.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
  function failAgentSettingWrites(error: string): void {
    for (const requestId of [...pendingAgentSettingWrites.keys()]) settleAgentSettingWrite(requestId, { ok: false, error });
  }
  // The account `agentSettings` belongs to: a different account must never see, or launch, them.
  let agentSettingsAccount = "";

  // Directory-workspace ensures in flight (plan 20260929-remote-desktop), keyed by request id like the join keys.
  let directoryWorkspaceRequest = 0;
  const pendingDirectoryWorkspaces = new Map<string, { resolve: (result: DirectoryWorkspaceResult) => void; timer: ReturnType<typeof setTimeout> }>();
  function settleDirectoryWorkspace(requestId: string, result: DirectoryWorkspaceResult): void {
    const pending = pendingDirectoryWorkspaces.get(requestId);
    if (!pending) return;
    pendingDirectoryWorkspaces.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** 收口在飞的设备授权：成功 / 服务端拒绝 / 本地失败（断连、登出、超时）都走这里，只结算一次。 */
  function settleDeviceAuthorize(result: DeviceAuthorizeResult): void {
    const pending = pendingDeviceAuthorize;
    if (!pending) return;
    pendingDeviceAuthorize = null;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
  // 有本地会话 token 时首屏直接进入 authenticating，避免刷新先闪登录页。
  const store: StoreApi<CofluxState> = createStore<CofluxState>(() => ({
    status: token ? "connecting" : "disconnected",
    authState: token ? "authenticating" : "need-login",
    loginError: "",
    loginName: "",
    daemons: [],
    projects: [],
    workspaces: [],
    tasks: [],
    ports: {},
    detachedTaskIds: new Set<string>(),
    deviceTransports: {},
    inputStates: {},
    localSessions: [],
    sessionMetadata: {},
    sessionAgents: {},
    secretRequests: {},
    executorRuns: {},
    annotationSummaries: {},
    agentSettings: EMPTY_AGENT_SETTINGS,
    agentSettingsSupported: false,
    agentSettingsReceived: false,
    notificationInbox: emptyNotificationInbox(),
    lastError: null,
    snapshotRevision: 0,
  }));

  // 离线目录缓存（plan 103）：只在 controlAuthenticated 期间写（写的是中心确认过的目录）；
  // 装载只发生一次、且只在「有 token、还没拿到过任何 snapshot」的冷启动窗口里。
  const offlineCatalog = options.offlineCatalog;
  let offlineHydrated = false;
  let offlinePersistQueued = false;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;

  function persistOfflineCatalog(): void {
    if (!offlineCatalog || !controlAuthenticated || offlinePersistQueued) return;
    // 同一轮消息突发（snapshot + 各设备的 sessionAgentsUpdated）合并成一次写
    offlinePersistQueued = true;
    queueMicrotask(() => {
      offlinePersistQueued = false;
      if (!controlAuthenticated) return;
      const state = store.getState();
      const catalog: OfflineCatalog = {
        version: OFFLINE_CATALOG_VERSION,
        savedAt: Date.now(),
        loginName: state.loginName,
        daemons: state.daemons,
        projects: state.projects,
        workspaces: state.workspaces,
        tasks: state.tasks,
        ports: state.ports,
        sessionAgents: state.sessionAgents,
        agentSettings: agentSettingsAccount ? { accountId: agentSettingsAccount, agents: state.agentSettings } : undefined,
      };
      try {
        offlineCatalog.storage.setItem(offlineCatalog.key, JSON.stringify(catalog));
      } catch {
        /* storage 满或不可用：缓存只是离线兜底，不影响在线路径 */
      }
    });
  }

  function clearOfflineCatalog(): void {
    if (!offlineCatalog) return;
    try {
      offlineCatalog.storage.removeItem(offlineCatalog.key);
    } catch {
      /* ignore */
    }
  }

  function clearOfflineTimer(): void {
    if (offlineTimer === undefined) return;
    clearTimeout(offlineTimer);
    offlineTimer = undefined;
  }

  /** 首连失败 / 超时：把缓存目录装进 store 并置 authed；连接状态不动，重连照常。 */
  function hydrateOfflineCatalog(): void {
    clearOfflineTimer();
    if (!offlineCatalog || offlineHydrated || !token) return;
    const current = store.getState();
    if (current.authState !== "authenticating" || current.snapshotRevision > 0) return;
    let raw: string | null;
    try {
      raw = offlineCatalog.storage.getItem(offlineCatalog.key);
    } catch {
      return;
    }
    const catalog = parseOfflineCatalog(raw);
    if (!catalog) return;
    offlineHydrated = true;
    store.setState((state) => ({
      authState: "authed",
      loginName: catalog.loginName,
      daemons: catalog.daemons,
      ...visibleCatalog(catalog),
      ports: catalog.ports,
      sessionAgents: catalog.sessionAgents,
      snapshotRevision: state.snapshotRevision + 1,
    }));
  }

  // The last agent configuration this client received (plan 20261002-account-agent-settings) is
  // loaded up front, not only on an offline hydrate: it must survive a reconnect whose first push
  // has not arrived yet, because every authOk persists the catalog from memory. The cache belongs to
  // the stored token's account (it is cleared on logout, auth failure and explicit login), and authOk
  // resets it anyway if the account turns out to differ.
  if (offlineCatalog && token) {
    let raw: string | null = null;
    try {
      raw = offlineCatalog.storage.getItem(offlineCatalog.key);
    } catch {
      /* no cache: nothing configured */
    }
    const cached = parseOfflineCatalog(raw)?.agentSettings;
    if (cached) {
      agentSettingsAccount = cached.accountId;
      store.setState({ agentSettings: cached.agents });
    }
  }

  const liveSessionIds = new Set<string>();

  function deliverSession(sessionId: string, data: Uint8Array, replace: boolean): void {
    const consumers = sessionConsumers.get(sessionId);
    if (consumers) for (const consumer of consumers) consumer(data, replace);
  }

  // The device router refreshes every catalog every 3 s: an unchanged catalog must leave the state
  // (and so every subscriber, the sidebar first) untouched. Output sequences are deliberately not
  // stored — they change with every byte a terminal prints and nothing renders them.
  function updateLocalCatalog(daemonId: string, catalog: DeviceSessionCatalog): void {
    store.setState((state) => {
      let localSessions = state.localSessions;
      for (const session of catalog.sessions) {
        const next: LocalSessionState = {
          daemonId,
          sessionId: session.sessionId,
          taskId: session.taskId,
          pid: session.pid,
          cwd: session.cwd,
          cols: session.cols,
          rows: session.rows,
          startedAt: session.startedAt,
          status: "running",
        };
        localSessions = upsert(localSessions, next, (item) => item.daemonId === daemonId && item.sessionId === session.sessionId);
      }
      for (const exit of catalog.exits) {
        const existing = localSessions.find((item) => item.daemonId === daemonId && item.sessionId === exit.sessionId);
        const next: LocalSessionState = {
          daemonId,
          sessionId: exit.sessionId,
          taskId: exit.taskId,
          pid: existing?.pid ?? 0,
          cwd: existing?.cwd ?? "",
          cols: existing?.cols ?? 80,
          rows: existing?.rows ?? 24,
          startedAt: existing?.startedAt ?? 0,
          status: "exited",
          exitCode: exit.exitCode,
          exitedAt: exit.exitedAt,
        };
        localSessions = upsert(localSessions, next, (item) => item.daemonId === daemonId && item.sessionId === exit.sessionId);
      }
      return localSessions === state.localSessions ? state : { localSessions };
    });
    for (const exit of catalog.exits) markSessionExited(daemonId, exit.taskId, exit.sessionId, exit.exitCode);
  }

  /** `record` without the entries matching `drop`; the same object when none match. */
  function withoutEntries<T>(record: Record<string, T>, drop: (key: string, value: T) => boolean): Record<string, T> {
    if (!Object.entries(record).some(([key, value]) => drop(key, value))) return record;
    return Object.fromEntries(Object.entries(record).filter(([key, value]) => !drop(key, value)));
  }

  // Also replayed for every exit tombstone of every catalog refresh: a repeat must change nothing.
  function markSessionExited(daemonId: string, taskId: string, sessionId: string, exitCode: number): void {
    liveSessionIds.delete(sessionId);
    sessionContents.delete(sessionId);
    // A hidden (closing) terminal gets the same local fact, so a rollback never restores a dead session.
    const parked = parkedTasks.get(taskId);
    if (parked && parked.item.sessionId === sessionId) {
      parkedTasks.set(taskId, { ...parked, item: { ...parked.item, status: TaskStatus.EXITED, sessionId: undefined, exitCode } });
    }
    store.setState((state) => {
      const existing = state.localSessions.find((item) => item.daemonId === daemonId && item.sessionId === sessionId);
      const local: LocalSessionState = {
        daemonId,
        sessionId,
        taskId,
        pid: existing?.pid ?? 0,
        cwd: existing?.cwd ?? "",
        cols: existing?.cols ?? 80,
        rows: existing?.rows ?? 24,
        startedAt: existing?.startedAt ?? 0,
        status: "exited",
        exitCode,
        exitedAt: existing?.exitedAt ?? Date.now(),
      };
      const inputStates = withoutEntries(state.inputStates, (key) => key === sessionId);
      // session 已退出：agent presence 一并清理，防僵尸琥珀（plan 073）
      const sessionAgents = withoutEntries(state.sessionAgents, (key) => key === sessionId);
      // The worker ends a terminal's pending secret requests with it; close the cards right away.
      const secretRequests = withoutEntries(state.secretRequests, (_, request) => request.sessionId === sessionId);
      // A run's card lives on its caller's terminal; the center drops the run with the session.
      const executorRuns = withoutEntries(state.executorRuns, (_, run) => run.sessionId === sessionId);
      const localSessions = upsert(state.localSessions, local, (item) => item.daemonId === daemonId && item.sessionId === sessionId);
      const tasks = state.tasks.some((task) => task.id === taskId && task.sessionId === sessionId)
        ? state.tasks.map((task) => task.id === taskId && task.sessionId === sessionId
          ? { ...task, status: TaskStatus.EXITED, sessionId: undefined, exitCode }
          : task)
        : state.tasks;
      const detachedTaskIds = withoutSetValue(state.detachedTaskIds, taskId);
      if (
        secretRequests === state.secretRequests &&
        executorRuns === state.executorRuns &&
        localSessions === state.localSessions &&
        tasks === state.tasks &&
        detachedTaskIds === state.detachedTaskIds &&
        inputStates === state.inputStates &&
        sessionAgents === state.sessionAgents
      ) return state;
      return { secretRequests, executorRuns, localSessions, tasks, detachedTaskIds, inputStates, sessionAgents };
    });
  }

  /* ---------------- terminal metadata and content (plan 20261010-terminal-checkpoint-energy) ---------------- */

  /** The center of this connection serves SessionMetadata (AuthOk.session_metadata): content is
   * fetched through TaskRead. False against an older center, which keeps pushing checkpoints. */
  let sessionMetadataSupported = false;
  /** Content pushed by an older center, by session: kept out of the reactive store and handed to a
   * pane only while it is visible, so a hidden pane never parses it. */
  const sessionContents = new Map<string, Uint8Array>();
  type ContentWatch = {
    taskId: string;
    sessionId: string;
    consumer: SessionContentConsumer;
    timer: ReturnType<typeof setTimeout> | undefined;
    stopped: boolean;
    inFlight: boolean;
    fetched: boolean;
    lastDelivered: Uint8Array | undefined;
  };
  const contentWatches = new Map<string, Set<ContentWatch>>();

  function applySessionMetadata(sessionId: string, taskId: string, title: string): void {
    const current = store.getState().sessionMetadata[sessionId];
    if (current && current.taskId === taskId && current.title === title) return;
    store.setState((state) => ({ sessionMetadata: { ...state.sessionMetadata, [sessionId]: { sessionId, taskId, title } } }));
  }

  function deliverContent(watch: ContentWatch, data: Uint8Array): void {
    if (watch.stopped || liveSessionIds.has(watch.sessionId)) return;
    if (watch.lastDelivered && bytesEqual(watch.lastDelivered, data)) return;
    watch.lastDelivered = data;
    watch.consumer(data);
  }

  /** One refresh of a visible, non-live pane: the cached push of an older center, or a TaskRead —
   * the daemon's current screen while its device is online (about as often as the old push), the
   * center's stored content once while it is offline. */
  function refreshContent(watch: ContentWatch): void {
    if (watch.stopped) return;
    watch.timer = setTimeout(() => refreshContent(watch), SESSION_CONTENT_REFRESH_MS);
    if (liveSessionIds.has(watch.sessionId)) return;
    if (!sessionMetadataSupported) {
      const cached = sessionContents.get(watch.sessionId);
      if (cached) deliverContent(watch, cached);
      return;
    }
    const task = taskById(watch.taskId);
    if (!task || task.sessionId !== watch.sessionId || task.status !== TaskStatus.RUNNING) return;
    if (!controlAuthenticated || watch.inFlight) return;
    const online = store.getState().daemons.some((daemon) => daemon.daemonId === task.daemonId && daemon.online);
    if (watch.fetched && !online) return;
    watch.inFlight = true;
    void readTask(watch.taskId).then((result) => {
      watch.inFlight = false;
      if (!result.ok || result.source === "none") return;
      watch.fetched = true;
      if (taskById(watch.taskId)?.sessionId !== watch.sessionId) return;
      deliverContent(watch, result.data);
    });
  }

  /**
   * A visible pane asks for its terminal's content while it is not live-attached (another device
   * holds the session, the device is offline, the attach is still on its way). Nothing is delivered
   * while the session is live: the attach snapshot and live output own the screen. Hidden panes do
   * not watch, so they never fetch or parse anything. Returns the unwatch function.
   */
  function watchSessionContent(taskId: string, sessionId: string, consumer: SessionContentConsumer): () => void {
    const watch: ContentWatch = {
      taskId,
      sessionId,
      consumer,
      timer: undefined,
      stopped: false,
      inFlight: false,
      fetched: false,
      lastDelivered: undefined,
    };
    let watches = contentWatches.get(sessionId);
    if (!watches) {
      watches = new Set();
      contentWatches.set(sessionId, watches);
    }
    watches.add(watch);
    watch.timer = setTimeout(() => refreshContent(watch), SESSION_CONTENT_FIRST_FETCH_MS);
    return () => {
      watch.stopped = true;
      clearTimeout(watch.timer);
      const current = contentWatches.get(sessionId);
      if (!current) return;
      current.delete(watch);
      if (current.size === 0) contentWatches.delete(sessionId);
    };
  }

  let connection!: ReturnType<typeof createConnection>;
  /**
   * executor（plan 116）：至多一个订阅者（桌面主进程经渲染层接上）。
   * 其他 client 不订阅，daemon 也不会往它们推——收到也只是无害落空。
   */
  let executorListener: ((event: ExecutorClientEvent) => void) | undefined;
  const deviceRouter: DeviceRouter = createDeviceRouter({
    nativeRemote: options.deviceTransport.nativeRemote,
    enableLocalTransport: options.deviceTransport.enableLocalTransport,
    identityDatabaseName: options.deviceTransport.identityDatabaseName,
    origin: options.deviceTransport.origin,
    sendControl: (payload) => connection.send(payload),
    onTransportState: (daemonId, transport) => {
      store.setState((state) => ({ deviceTransports: { ...state.deviceTransports, [daemonId]: transport } }));
    },
    onSessionSnapshot: (_daemonId, _taskId, sessionId, data) => {
      liveSessionIds.add(sessionId);
      deliverSession(sessionId, data, true);
    },
    onSessionOutput: (_daemonId, _taskId, sessionId, data) => {
      liveSessionIds.add(sessionId);
      deliverSession(sessionId, data, false);
    },
    onSessionAttached: (_daemonId, taskId) => {
      store.setState((state) => ({ detachedTaskIds: withoutSetValue(state.detachedTaskIds, taskId) }));
    },
    onSessionDetached: (_daemonId, taskId, sessionId) => {
      // Another holder took the session: no live output arrives any more, so a visible pane goes
      // back to fetching its content (plan 20261010-terminal-checkpoint-energy).
      liveSessionIds.delete(sessionId);
      store.setState((state) => ({ detachedTaskIds: new Set(state.detachedTaskIds).add(taskId) }));
    },
    onSessionExited: markSessionExited,
    onCatalog: updateLocalCatalog,
    onPorts: () => {
      // 预览 URL 仍由中心的账号门禁路由签发；Device RPC 只负责确认本机原始监听事实。
    },
    // executor（plan 116）：四条推送原样交给订阅者（桌面主进程），store 自己不持有任何 run 状态——
    // 作业表的真相在主进程，这里多存一份只会漂移。
    onExecutorAssign: (daemonId, assign) =>
      executorListener?.({
        kind: "assign",
        runId: assign.runId,
        prompt: assign.prompt,
        write: assign.write,
        workspaceId: assign.workspaceId,
        workspaceRoot: assign.workspaceRoot,
        submittedAt: Number(assign.submittedAt ?? 0),
        daemonId,
      }),
    onExecutorCancel: (daemonId, runId) => executorListener?.({ kind: "cancel", runId, daemonId }),
    onExecutorHostRegistered: (daemonId, registered) =>
      executorListener?.({
        kind: "registered",
        ok: registered.ok,
        error: registered.error,
        reconcileRunIds: [...registered.reconcileRunIds],
        daemonId,
      }),
    onExecutorReportAck: (daemonId, runId) => executorListener?.({ kind: "ack", runId, daemonId }),
    onError: reportLocalError,
    onInputState: (_daemonId, _taskId, sessionId, inputState) => {
      const wasBlocked = store.getState().inputStates[sessionId]?.blocked ?? false;
      store.setState((state) => ({ inputStates: { ...state.inputStates, [sessionId]: inputState } }));
      if (inputState.blocked && !wasBlocked) reportLocalError("终端输入正在等待本机确认，缓冲区已满，请稍候");
    },
  });

  connection = createConnection({
    url: options.serverUrl,
    buildId: options.buildId,
    clientKind: options.clientKind,
    onStatus: (status) => {
      store.setState({ status });
      if (status !== "connected") {
        controlAuthenticated = false;
        const hadNotificationReads = notificationReadTimers.size > 0;
        clearNotificationTimers();
        store.setState((state) => ({ notificationInbox: { ...state.notificationInbox, loading: false,
          error: hadNotificationReads ? "标记已读未获确认，重连后请检查" : state.notificationInbox.error } }));
        // 回应不会再来了：在飞的设备授权立即失败而不是挂到超时（plan 112）
        settleDeviceAuthorize({ ok: false, error: "与服务器的连接已断开，请重试" });
        failJoinKeys("与服务器的连接已断开，请重试");
        // The configuration stays (the offline menu uses it); it just is no longer this connection's.
        store.setState({ agentSettingsReceived: false });
        failAgentSettingWrites("与服务器的连接已断开，修改没有保存");
        // TCP/WS transport 断开不等于账号授权已撤销，也不等于 worker 那条独立控制 WS 已断。
        // Router 会立即禁用新 rendezvous/高权限能力，但给既有 remote session lane 一个有界宽限。
        deviceRouter.setControlDisconnected();
        // 冷启动首连失败（连不上 / authOk 前被关）：离线目录缓存接管；已 authed 或没缓存时是空操作。
        if (status === "disconnected") hydrateOfflineCatalog();
      }
    },
    onMessage: handleServerMessage,
    reconnectCredential: () => (shouldRetry && token ? { token } : null),
  });

  function send(payload: ClientToServerPayload) {
    connection.send(payload);
  }

  function sendInput(sessionId: string, data: string) {
    const bytes = new TextEncoder().encode(data);
    const task = taskOfSession(sessionId);
    if (task) {
      deviceRouter.sendInput(task.daemonId, sessionId, bytes);
      return;
    }
    reportLocalError("会话不存在，无法发送终端输入");
  }

  function resizeSession(sessionId: string, cols: number, rows: number) {
    const task = taskOfSession(sessionId);
    if (task) {
      deviceRouter.resize(task.daemonId, sessionId, cols, rows);
      return;
    }
    reportLocalError("会话不存在，无法调整终端尺寸");
  }

  function registerSessionConsumer(sessionId: string, consumer: SessionConsumer) {
    const routedTask = taskOfSession(sessionId);
    let consumers = sessionConsumers.get(sessionId);
    if (!consumers) {
      consumers = new Set<SessionConsumer>();
      sessionConsumers.set(sessionId, consumers);
    }
    consumers.add(consumer);
    // A remounted pane (e.g. after a rollback) owns the session's life cycle again.
    if (routedTask && deferredSessionReleases.get(routedTask.id)?.sessionId === sessionId) deferredSessionReleases.delete(routedTask.id);
    // Live data only: a pane that is visible and not live asks for content with watchSessionContent
    // (plan 20261010-terminal-checkpoint-energy), so a hidden pane never parses a whole screen.
    return () => {
      const current = sessionConsumers.get(sessionId);
      if (!current) return;
      current.delete(consumer);
      if (current.size === 0) {
        sessionConsumers.delete(sessionId);
        liveSessionIds.delete(sessionId);
        if (!routedTask) return;
        // Hiding a closing terminal unmounts its pane; releasing the session here would reject
        // closeTask's stop (it waits for the holder), so the release waits for the removal to end.
        if (removals.task.has(routedTask.id)) deferredSessionReleases.set(routedTask.id, { daemonId: routedTask.daemonId, sessionId });
        else deviceRouter.suspendSession(routedTask.daemonId, sessionId);
      }
    };
  }

  /** The task routing a session, hidden ones included: a closing terminal still receives local facts. */
  function taskOfSession(sessionId: string): Task | undefined {
    const visible = store.getState().tasks.find((task) => task.sessionId === sessionId);
    if (visible) return visible;
    for (const entry of parkedTasks.values()) if (entry.item.sessionId === sessionId) return entry.item;
    return undefined;
  }

  function taskById(taskId: string): Task | undefined {
    return store.getState().tasks.find((task) => task.id === taskId) ?? parkedTasks.get(taskId)?.item;
  }

  /* ---------------- optimistic removal (plan 20261002-optimistic-removal) ---------------- */

  /** The visible arrays after the current pending-removal sets: hides newly hidden entities, restores rolled-back ones. */
  function visibleCatalog(catalog: Pick<CofluxState, "projects" | "workspaces" | "tasks">): Pick<CofluxState, "projects" | "workspaces" | "tasks"> {
    return {
      projects: partitionVisible(catalog.projects, parkedProjects, projectHidden),
      workspaces: partitionVisible(catalog.workspaces, parkedWorkspaces, workspaceHidden),
      tasks: partitionVisible(catalog.tasks, parkedTasks, taskHidden),
    };
  }

  function parkedOf(removal: PendingRemoval): { daemonId: string } | undefined {
    if (removal.kind === "task") return parkedTasks.get(removal.id)?.item;
    if (removal.kind === "workspace") return parkedWorkspaces.get(removal.id)?.item;
    return parkedProjects.get(removal.id)?.item;
  }

  /** Drops a pending removal's bookkeeping (settled or rolled back); the caller then repartitions. */
  function clearRemoval(removal: PendingRemoval): void {
    clearTimeout(removal.timer);
    removals[removal.kind].delete(removal.id);
    if (removal.kind === "task") pendingTaskRemovals.delete(removal.id);
  }

  /** Hides an entity now. Null when it is already pending removal. */
  function beginRemoval(kind: RemovalKind, id: string): PendingRemoval | null {
    if (removals[kind].has(id)) return null;
    const removal: PendingRemoval = { kind, id, timer: undefined, sentEpoch: null };
    removals[kind].set(id, removal);
    store.setState((state) => visibleCatalog(state));
    persistOfflineCatalog();
    return removal;
  }

  function markRemovalSent(removal: PendingRemoval): void {
    removal.sentEpoch = subscribeEpoch;
    clearTimeout(removal.timer);
    // The centre's silent returns leave nothing to report: the timeout restores without an error.
    removal.timer = setTimeout(() => {
      if (removals[removal.kind].get(removal.id) === removal) rollbackRemovals([removal]);
    }, REMOVAL_FALLBACK_TIMEOUT_MS);
  }

  function rollbackRemovals(list: readonly PendingRemoval[]): void {
    if (list.length === 0) return;
    for (const removal of list) clearRemoval(removal);
    store.setState((state) => visibleCatalog(state));
    persistOfflineCatalog();
    releaseDeferredSessions();
  }

  /** The centre reported a task gone (directly, by cascade, or by its absence from a snapshot). */
  function settleTask(taskId: string): void {
    const removal = removals.task.get(taskId);
    if (removal) clearRemoval(removal);
    parkedTasks.delete(taskId);
  }

  function settleWorkspace(workspaceId: string): void {
    const removal = removals.workspace.get(workspaceId);
    if (removal) clearRemoval(removal);
    parkedWorkspaces.delete(workspaceId);
    for (const [taskId, entry] of parkedTasks) if (entry.item.workspaceId === workspaceId) settleTask(taskId);
  }

  function settleProject(projectId: string): void {
    const removal = removals.project.get(projectId);
    if (removal) clearRemoval(removal);
    parkedProjects.delete(projectId);
    for (const [workspaceId, entry] of parkedWorkspaces) if (entry.item.projectId === projectId) settleWorkspace(workspaceId);
    for (const [taskId, entry] of parkedTasks) if (entry.item.projectId === projectId) settleTask(taskId);
  }

  /** Releases sessions deferred by a closing terminal once its removal ended, unless a remounted pane took it over. */
  function releaseDeferredSessions(): void {
    if (![...deferredSessionReleases.keys()].some((taskId) => !removals.task.has(taskId))) return;
    // After a tick: a rolled-back terminal's pane remounts first and takes the session over.
    setTimeout(() => {
      for (const [taskId, deferred] of deferredSessionReleases) {
        if (removals.task.has(taskId)) continue;
        deferredSessionReleases.delete(taskId);
        if (!sessionConsumers.has(deferred.sessionId)) deviceRouter.suspendSession(deferred.daemonId, deferred.sessionId);
      }
    }, 0);
  }

  function clearRemovals(): void {
    for (const kind of REMOVAL_KINDS) {
      for (const removal of removals[kind].values()) clearTimeout(removal.timer);
      removals[kind].clear();
    }
    parkedProjects.clear();
    parkedWorkspaces.clear();
    parkedTasks.clear();
    deferredSessionReleases.clear();
  }

  /**
   * Removes a workspace optimistically: it (and its terminals) leave the visible state now and come
   * back if the centre reports an error or never answers. Not optimistic while the control
   * connection is not authenticated — the request would be dropped — so it reports an error and
   * returns false; true when the removal was sent.
   */
  function removeWorkspace(workspaceId: string): boolean {
    if (!controlAuthenticated) {
      reportLocalError("与服务器的连接未就绪，暂时无法删除工作区");
      return false;
    }
    const removal = beginRemoval("workspace", workspaceId);
    if (!removal) return false;
    send({ case: "workspaceRemove", value: { workspaceId } });
    markRemovalSent(removal);
    return true;
  }

  /** Removes a project optimistically, with its workspaces and terminals; same contract as removeWorkspace. */
  function removeProject(projectId: string): boolean {
    if (!controlAuthenticated) {
      reportLocalError("与服务器的连接未就绪，暂时无法移除项目");
      return false;
    }
    const removal = beginRemoval("project", projectId);
    if (!removal) return false;
    send({ case: "projectRemove", value: { projectId } });
    markRemovalSent(removal);
    return true;
  }

  /** Ids of workspaces hidden by a pending removal: they may still come back (plan 078's create adoption must know them). */
  function hiddenWorkspaceIds(): string[] {
    return [...parkedWorkspaces.keys()];
  }

  // 快照/增量按到达顺序应用（server 保证 stateSnapshot 先于其后的广播），不做乱序缓冲。
  // 每条消息只调用一次 store.setState：天然原子提交，订阅者只看到一致的最终状态
  // （不依赖 React 批处理细节，比 Solid 版的 batch(...) 包裹更直接）。
  function handleServerMessage(payload: ServerPayload) {
    if (deviceRouter.handleControlPayload(payload)) return;
    switch (payload.case) {
      case "authOk": {
        const value = payload.value;
        if (value.controlProtocolVersion < CONTROL_PROTOCOL_VERSION) {
          controlAuthenticated = false;
          shouldRetry = false;
          deviceRouter.setControlOnline(false);
          connection.stop();
          store.setState({ authState: "outdated", loginError: "服务器版本需要升级" });
          return;
        }
        controlAuthenticated = true;
        clearNotificationTimers();
        if (notificationAccount !== value.accountId) {
          notificationAccount = value.accountId;
          notifiedIds.clear();
          store.setState({ notificationInbox: emptyNotificationInbox() });
        }
        notificationSupported = value.notificationInbox;
        notificationInitialCutoff = Infinity;
        notificationPageRequestId = "initial";
        store.setState((state) => ({ notificationInbox: { ...state.notificationInbox, loading: notificationSupported,
          error: notificationSupported ? "" : "服务器尚不支持通知中心，请升级服务器" } }));
        if (notificationSupported) waitForNotificationPage();
        // Agent settings: the configuration arrives after the subscribe snapshot. Until then the
        // previous value stays (not zeroed: this authOk persists the offline catalog), unless it
        // belongs to another account, or this center does not serve agent settings at all.
        if (agentSettingsAccount !== value.accountId || !value.agentSettings) {
          agentSettingsAccount = value.accountId;
          store.setState({ agentSettings: EMPTY_AGENT_SETTINGS });
        }
        store.setState({ agentSettingsSupported: value.agentSettings, agentSettingsReceived: false });
        // Terminal content: fetched through TaskRead when the center serves metadata, else taken
        // from the checkpoints it pushes (plan 20261010-terminal-checkpoint-energy).
        sessionMetadataSupported = value.sessionMetadata;
        if (sessionMetadataSupported) sessionContents.clear();
        deviceRouter.setControlOnline(true);
        store.setState({ authState: "authed", loginError: "", loginName: value.loginName ?? "" });
        shouldRetry = true;
        connection.resetBackoff();
        if (value.clientToken) {
          token = value.clientToken;
          options.tokenStorage.write(value.clientToken);
        }
        // A removal sent from here on is handled after the snapshot this subscribe asks for.
        subscribeEpoch += 1;
        send({ case: "clientSubscribe", value: {} });
        flushPendingTaskRemovals();
        options.onAuthenticated?.();
        break;
      }
      case "authError": {
        clearNotificationTimers();
        store.setState({ notificationInbox: emptyNotificationInbox() });
        controlAuthenticated = false;
        deviceRouter.setControlOnline(false);
        token = "";
        options.tokenStorage.clear();
        clearOfflineCatalog();
        agentSettingsAccount = "";
        failAgentSettingWrites("登录已失效，修改没有保存");
        store.setState({ agentSettings: EMPTY_AGENT_SETTINGS, agentSettingsSupported: false, agentSettingsReceived: false });
        // Show the server's own reason. This branch is reached by an expired session token, a
        // rate-limited address and an obsolete bundle just as much as by wrong credentials, and
        // a hard-coded "wrong username or password" misnamed every one of them — the desktop's
        // dev profile lands here on every start after its token expires.
        const reason = (payload.value.message ?? "").trim();
        store.setState({
          loginError: reason || "登录失败：请重新登录",
          loginName: "",
          authState: "auth-failed",
        });
        shouldRetry = false;
        break;
      }
      case "clientOutdated": {
        controlAuthenticated = false;
        deviceRouter.setControlOnline(false);
        // server 判定本连接版本过旧（plan 033 / 105）：token 不清（升级后无感续用），停止重连——版本拒绝
        // 不是可重试的断线；进入专用状态页（非认证失败，不设 loginError——auth-failed 展示面语义是
        // "账号/密码错了"，混用会误导用户），由 app 触发自动更新检查。
        shouldRetry = false;
        store.setState({ authState: "outdated" });
        break;
      }
      case "notificationPage": {
        const value = payload.value;
        if (value.requestId !== notificationPageRequestId) break;
        clearTimeout(notificationTimer);
        const firstPage = !Number.isFinite(notificationInitialCutoff) && !value.error;
        if (firstPage) notificationInitialCutoff = value.latestSequence;
        store.setState((state) => ({ notificationInbox: applyNotificationPage(state.notificationInbox,
          firstPage ? { ...value, requestId: "initial" } : value) }));
        break;
      }
      case "notificationChanged": {
        const value = payload.value;
        const timer = notificationReadTimers.get(value.requestId);
        if (timer) { clearTimeout(timer); notificationReadTimers.delete(value.requestId); }
        const previous = store.getState().notificationInbox;
        const item = value.notification;
        const next = applyNotificationChange(previous, value);
        store.setState({ notificationInbox: next });
        const mergedItem = item && next.items.find((entry) => entry.id === item.id);
        if (value.created && item && item.sequence > notificationInitialCutoff && !mergedItem?.readAt &&
            !notifiedIds.has(item.id) && !previous.items.some((entry) => entry.id === item.id)) {
          notifiedIds.add(item.id);
          for (const listener of notificationListeners) listener(item);
        }
        break;
      }
      case "stateSnapshot": {
        const value = payload.value;
        const nextPorts: Record<string, PortPreview[]> = {};
        for (const group of value.ports) {
          nextPorts[group.taskId] = group.ports.map((preview) => ({ port: preview.port, url: preview.url }));
        }
        const taskIds = new Set(value.tasks.map((task) => task.id));
        // Pending removals against the snapshot: one it lacks is settled. One it still contains rolls
        // back — the snapshot answers a reconnect, and a request sent before a silent disconnect is
        // lost — unless it was sent after this snapshot's subscribe (e.g. terminal closes queued
        // offline and flushed on this authOk), which the centre handles after building it.
        const present: Record<RemovalKind, Set<string>> = {
          task: taskIds,
          workspace: new Set(value.workspaces.map((workspace) => workspace.id)),
          project: new Set(value.projects.map((project) => project.id)),
        };
        for (const kind of REMOVAL_KINDS) {
          for (const removal of [...removals[kind].values()]) {
            const inFlight = removal.sentEpoch === null || removal.sentEpoch === subscribeEpoch;
            if (inFlight && present[kind].has(removal.id)) continue;
            clearRemoval(removal);
          }
        }
        // The snapshot is authoritative: parked copies are rebuilt from it for what is still pending.
        parkedProjects.clear();
        parkedWorkspaces.clear();
        parkedTasks.clear();
        store.setState((state) => {
          const tasks = value.tasks.map((task) => {
            const localExit = task.sessionId
              ? state.localSessions.find((session) => session.sessionId === task.sessionId && session.status === "exited")
              : undefined;
            return localExit
              ? { ...task, status: TaskStatus.EXITED, sessionId: undefined, exitCode: localExit.exitCode }
              : task;
          });
          return {
            daemons: value.daemons,
            ...visibleCatalog({ projects: value.projects, workspaces: value.workspaces, tasks }),
            ports: nextPorts,
            detachedTaskIds: new Set([...state.detachedTaskIds].filter((taskId) => taskIds.has(taskId))),
            // agent presence 清零重建：server 会紧随快照按设备补发当前全量（plan 073）。
            sessionAgents: {},
            // Same for pending secret requests: re-sent per device right after the snapshot.
            secretRequests: {},
            executorRuns: {},
            annotationSummaries: {},
            snapshotRevision: state.snapshotRevision + 1,
          };
        });
        break;
      }
      case "daemonUpdated": {
        const daemon = payload.value.daemon;
        if (!daemon) break; // 内嵌 message 字段在 protobuf-es 里始终是 T | undefined（显式 presence），服务端必填，这里按畸形消息丢弃
        store.setState((state) => ({ daemons: upsert(state.daemons, daemon, (item) => item.daemonId === daemon.daemonId) }));
        break;
      }
      case "daemonRemoved": {
        const value = payload.value;
        for (const kind of REMOVAL_KINDS) {
          for (const removal of [...removals[kind].values()]) if (parkedOf(removal)?.daemonId === value.daemonId) clearRemoval(removal);
        }
        for (const [id, entry] of parkedProjects) if (entry.item.daemonId === value.daemonId) parkedProjects.delete(id);
        for (const [id, entry] of parkedWorkspaces) if (entry.item.daemonId === value.daemonId) parkedWorkspaces.delete(id);
        for (const [id, entry] of parkedTasks) if (entry.item.daemonId === value.daemonId) parkedTasks.delete(id);
        store.setState((state) => ({
          daemons: state.daemons.filter((daemon) => daemon.daemonId !== value.daemonId),
          projects: state.projects.filter((project) => project.daemonId !== value.daemonId),
          workspaces: state.workspaces.filter((workspace) => workspace.daemonId !== value.daemonId),
          tasks: state.tasks.filter((task) => task.daemonId !== value.daemonId),
          sessionAgents: Object.fromEntries(Object.entries(state.sessionAgents).filter(([, entry]) => entry.daemonId !== value.daemonId)),
          secretRequests: Object.fromEntries(Object.entries(state.secretRequests).filter(([, entry]) => entry.daemonId !== value.daemonId)),
          executorRuns: Object.fromEntries(Object.entries(state.executorRuns).filter(([, entry]) => entry.daemonId !== value.daemonId)),
          annotationSummaries: Object.fromEntries(Object.entries(state.annotationSummaries).filter(([, entry]) => entry.daemonId !== value.daemonId)),
        }));
        break;
      }
      case "projectCreated": {
        const project = payload.value.project;
        if (!project) break;
        store.setState((state) => ({ projects: upsertVisible(state.projects, parkedProjects, project, projectHidden) }));
        break;
      }
      case "projectRemoved": {
        const value = payload.value;
        settleProject(value.projectId);
        store.setState((state) => ({
          projects: state.projects.filter((project) => project.id !== value.projectId),
          workspaces: state.workspaces.filter((workspace) => workspace.projectId !== value.projectId),
          tasks: state.tasks.filter((task) => task.projectId !== value.projectId),
        }));
        break;
      }
      case "workspaceCreated": {
        const workspace = payload.value.workspace;
        if (!workspace) break;
        store.setState((state) => ({ workspaces: upsertVisible(state.workspaces, parkedWorkspaces, workspace, workspaceHidden) }));
        break;
      }
      case "workspaceRemoved": {
        const value = payload.value;
        settleWorkspace(value.workspaceId);
        store.setState((state) => ({
          workspaces: state.workspaces.filter((workspace) => workspace.id !== value.workspaceId),
          tasks: state.tasks.filter((task) => task.workspaceId !== value.workspaceId),
        }));
        break;
      }
      case "taskUpdated": {
        const serverTask = payload.value.task;
        if (!serverTask) break;
        store.setState((state) => {
          const localExit = serverTask.sessionId
            ? state.localSessions.find((session) => session.sessionId === serverTask.sessionId && session.status === "exited")
            : undefined;
          const task = localExit
            ? { ...serverTask, status: TaskStatus.EXITED, sessionId: undefined, exitCode: localExit.exitCode }
            : serverTask;
          return {
            tasks: upsertVisible(state.tasks, parkedTasks, task, taskHidden),
            detachedTaskIds: task.status !== TaskStatus.RUNNING ? withoutSetValue(state.detachedTaskIds, task.id) : state.detachedTaskIds,
          };
        });
        break;
      }
      case "taskRemoved": {
        const value = payload.value;
        // A closing terminal is hidden: its sessionId and daemonId come from the parked copy.
        const removed = taskById(value.taskId);
        const deferred = deferredSessionReleases.get(value.taskId);
        deferredSessionReleases.delete(value.taskId);
        settleTask(value.taskId);
        const removedSessionId = removed?.sessionId ?? deferred?.sessionId ?? store.getState().localSessions.find((session) => session.taskId === value.taskId)?.sessionId;
        store.setState((state) => {
          let ports = state.ports;
          let inputStates = state.inputStates;
          if (value.taskId in ports) {
            ports = { ...ports };
            delete ports[value.taskId];
          }
          if (removedSessionId && removedSessionId in inputStates) {
            inputStates = { ...inputStates };
            delete inputStates[removedSessionId];
          }
          return {
            tasks: state.tasks.filter((task) => task.id !== value.taskId),
            ports,
            detachedTaskIds: withoutSetValue(state.detachedTaskIds, value.taskId),
            inputStates,
            sessionMetadata: removedSessionId
              ? withoutEntries(state.sessionMetadata, (sessionId) => sessionId === removedSessionId)
              : state.sessionMetadata,
            sessionAgents: removedSessionId
              ? Object.fromEntries(Object.entries(state.sessionAgents).filter(([sessionId]) => sessionId !== removedSessionId))
              : state.sessionAgents,
          };
        });
        if (removedSessionId) sessionContents.delete(removedSessionId);
        if (removed && removedSessionId) {
          liveSessionIds.delete(removedSessionId);
          deviceRouter.forgetSession(removed.daemonId, removedSessionId);
        }
        break;
      }
      case "portsUpdated": {
        const value = payload.value;
        store.setState((state) => ({
          ports: { ...state.ports, [value.taskId]: value.ports.map((preview) => ({ port: preview.port, url: preview.url })) },
        }));
        break;
      }
      case "sessionCheckpoint": {
        // Only an older center pushes these (plan 20261010-terminal-checkpoint-energy): its title is
        // metadata, its content waits in the non-reactive cache and reaches only the panes that
        // watch it — visible and not live.
        const checkpoint = payload.value;
        applySessionMetadata(checkpoint.sessionId, checkpoint.taskId, checkpoint.title);
        sessionContents.set(checkpoint.sessionId, checkpoint.ansiSnapshot);
        const watches = contentWatches.get(checkpoint.sessionId);
        if (watches) for (const watch of watches) deliverContent(watch, checkpoint.ansiSnapshot);
        break;
      }
      case "sessionMetadata": {
        const metadata = payload.value;
        applySessionMetadata(metadata.sessionId, metadata.taskId, metadata.title);
        break;
      }
      case "sessionAgentsUpdated": {
        const value = payload.value;
        store.setState((state) => {
          // 按设备全量替换：先清该 daemon 的旧条目再写入新清单（空清单 = 该设备全清）
          const sessionAgents: Record<string, SessionAgentState> = Object.fromEntries(
            Object.entries(state.sessionAgents).filter(([, entry]) => entry.daemonId !== value.daemonId),
          );
          for (const session of value.sessions) {
            sessionAgents[session.sessionId] = {
              daemonId: value.daemonId,
              taskId: session.taskId,
              agent: session.agent,
              state: session.state,
              message: session.message,
              progress: session.progress,
              agentSessionId: session.agentSessionId ?? "",
            };
          }
          return { sessionAgents };
        });
        break;
      }
      case "secretRequestsUpdated": {
        const value = payload.value;
        store.setState((state) => {
          // Full replacement per device (empty = none pending on it).
          const secretRequests: Record<string, SecretRequestState> = Object.fromEntries(
            Object.entries(state.secretRequests).filter(([, entry]) => entry.daemonId !== value.daemonId),
          );
          for (const request of value.requests) {
            secretRequests[request.requestId] = {
              requestId: request.requestId,
              daemonId: value.daemonId,
              sessionId: request.sessionId,
              taskId: request.taskId,
              name: request.name,
              reason: request.reason,
              createdAt: request.createdAt,
              expiresAt: request.expiresAt,
            };
          }
          return { secretRequests };
        });
        break;
      }
      case "executorRunsUpdated": {
        const value = payload.value;
        store.setState((state) => {
          // Full replacement per device (empty = none running on it).
          const executorRuns: Record<string, ExecutorRunState> = Object.fromEntries(
            Object.entries(state.executorRuns).filter(([, entry]) => entry.daemonId !== value.daemonId),
          );
          for (const run of value.runs) {
            const phase = run.phase === "accepted" || run.phase === "running" ? run.phase : "queued";
            executorRuns[run.runId] = {
              runId: run.runId,
              daemonId: value.daemonId,
              sessionId: run.sessionId,
              taskId: run.taskId,
              title: run.title,
              write: run.write,
              phase,
              submittedAt: run.submittedAt,
              startedAt: run.startedAt,
              hostLost: run.hostLost,
            };
          }
          return { executorRuns };
        });
        break;
      }
      case "annotationsSummaryUpdated": {
        const value = payload.value;
        store.setState((state) => {
          // Full replacement per device (empty = no annotations on it).
          const annotationSummaries: Record<string, AnnotationSummaryState> = Object.fromEntries(
            Object.entries(state.annotationSummaries).filter(([, entry]) => entry.daemonId !== value.daemonId),
          );
          for (const entry of value.workspaces) {
            annotationSummaries[entry.workspaceId] = {
              daemonId: value.daemonId,
              revision: entry.revision,
              pending: entry.pending,
              resolved: entry.resolved,
            };
          }
          return { annotationSummaries };
        });
        break;
      }
      case "taskReadResult": {
        const value = payload.value;
        const pending = pendingTaskReads.get(value.taskId);
        if (!pending) break;
        clearTimeout(pending.timer);
        pendingTaskReads.delete(value.taskId);
        if (value.error) {
          pending.resolve({ ok: false, error: value.error });
          break;
        }
        const source: TaskReadSource =
          value.source === "snapshot" || value.source === "checkpoint" ? value.source : "none";
        pending.resolve({
          ok: true,
          taskId: value.taskId,
          data: value.data,
          source,
          capturedAt: value.capturedAt,
          status: value.status,
          exitCode: value.exitCode,
        });
        break;
      }
      case "error": {
        errorSequence += 1;
        // The centre's failure reply carries no request id: any error rolls back every pending
        // workspace and project removal (a false positive only flashes the row back until its
        // removed broadcast). Terminals are not rolled back here — the usual answer to a failed
        // taskRemove is that the task is already gone.
        for (const kind of ["workspace", "project"] as const) {
          for (const removal of [...removals[kind].values()]) clearRemoval(removal);
        }
        store.setState((state) => ({ ...visibleCatalog(state), lastError: { id: errorSequence, message: payload.value.message } }));
        break;
      }
      // plan 112：设备授权兑现的两种回音。deviceAuthorized = 成功；deviceAuthorizeInfo{ ok:false } = 拒绝（无效/已用/
      // 已过期/限速，服务端不区分）。ok:true 的 info 只属于 deviceAuthorizeInfo 查询——本库不发它，到了也不结算。
      case "deviceAuthorized": {
        settleDeviceAuthorize({ ok: true });
        break;
      }
      case "deviceAuthorizeInfo": {
        if (!payload.value.ok) settleDeviceAuthorize({ ok: false, error: payload.value.error || "授权链接无效或已过期" });
        break;
      }
      case "deviceJoinKeyCreated": {
        const value = payload.value;
        settleJoinKey(value.requestId, value.error || !value.key
          ? { ok: false, error: value.error || "服务器没有返回密钥" }
          : { ok: true, key: value.key, expiresAt: value.expiresAt });
        break;
      }
      case "agentSettingsUpdated": {
        const value = payload.value;
        // A rejected write: answered to the writer only, and its empty list is not the configuration.
        if (value.error) {
          settleAgentSettingWrite(value.requestId, { ok: false, error: value.error });
          break;
        }
        const agents: Record<string, AccountAgentSetting> = {};
        for (const agent of value.agents) agents[agent.agentId] = { enabled: agent.enabled, command: agent.command };
        store.setState({ agentSettings: agents, agentSettingsReceived: true });
        // After the state: a writer awaiting its result sees the configuration it produced.
        if (value.requestId) settleAgentSettingWrite(value.requestId, { ok: true });
        break;
      }
      case "directoryWorkspaceEnsured": {
        const value = payload.value;
        settleDirectoryWorkspace(value.requestId, value.ok && value.workspaceId
          ? { ok: true, workspaceId: value.workspaceId }
          : { ok: false, error: value.error || "服务器没有返回工作区" });
        break;
      }
      default:
        break;
    }
    releaseDeferredSessions();
    persistOfflineCatalog();
  }

  /** 用桌面的登录态兑现 daemon 打印的一次性授权 token（plan 112）：把该 token 对应的设备绑到当前账号。
   * 可等待：成功 / 服务端拒绝（带原因）/ 未登录或连接未就绪（立即失败，不挂起）。一次只允许一个在飞。 */
  function authorizeDevice(token: string): Promise<DeviceAuthorizeResult> {
    if (!controlAuthenticated) return Promise.resolve({ ok: false, error: "尚未登录或与服务器的连接未就绪" });
    if (!token.trim()) return Promise.resolve({ ok: false, error: "授权 token 为空" });
    if (pendingDeviceAuthorize) return Promise.resolve({ ok: false, error: "上一次设备授权还在进行中" });
    return new Promise<DeviceAuthorizeResult>((resolve) => {
      const timer = setTimeout(() => settleDeviceAuthorize({ ok: false, error: "设备授权超时，请重试" }), DEVICE_AUTHORIZE_TIMEOUT_MS);
      pendingDeviceAuthorize = { resolve, timer };
      send({ case: "deviceAuthorize", value: { token } });
    });
  }

  /** Mint a one-time device join key for the signed-in account (plan 20260924-device-join-keys).
   * `replaces` names the key it supersedes; the server revokes that one immediately. */
  function createDeviceJoinKey(replaces = ""): Promise<DeviceJoinKeyResult> {
    if (!controlAuthenticated) return Promise.resolve({ ok: false, error: "尚未登录或与服务器的连接未就绪" });
    const requestId = `${notificationRequestPrefix}-join-${++joinKeyRequest}`;
    return new Promise<DeviceJoinKeyResult>((resolve) => {
      const timer = setTimeout(() => settleJoinKey(requestId, { ok: false, error: "生成密钥超时，请重试" }), DEVICE_JOIN_KEY_TIMEOUT_MS);
      pendingJoinKeys.set(requestId, { resolve, timer });
      send({ case: "deviceJoinKeyCreate", value: { requestId, replaces } });
    });
  }

  /**
   * Replace one agent's launch setting on the account (plan 20261002-account-agent-settings). Only
   * while connected to a center that serves agent settings and after this connection's configuration
   * arrived; otherwise it fails at once. On success every subscribed client of the account, this one
   * included, has received the new configuration. Failures never touch lastError.
   */
  function setAgentSetting(agentId: string, setting: AccountAgentSetting): Promise<AgentSettingWriteResult> {
    const state = store.getState();
    if (!controlAuthenticated) return Promise.resolve({ ok: false, error: "与服务器的连接未就绪，修改没有保存" });
    if (!state.agentSettingsSupported) return Promise.resolve({ ok: false, error: "服务器版本过旧，不支持在账号上保存 agent 设置" });
    if (!state.agentSettingsReceived) return Promise.resolve({ ok: false, error: "还没收到账号里的 agent 设置，请稍候再改" });
    const requestId = `${notificationRequestPrefix}-agent-${++agentSettingRequest}`;
    return new Promise<AgentSettingWriteResult>((resolve) => {
      const timer = setTimeout(() => settleAgentSettingWrite(requestId, { ok: false, error: "保存超时，修改没有保存" }), AGENT_SETTING_WRITE_TIMEOUT_MS);
      pendingAgentSettingWrites.set(requestId, { resolve, timer });
      send({ case: "agentSettingSet", value: { requestId, agentId, enabled: setting.enabled, command: setting.command } });
    });
  }

  /**
   * Ensure the device's canonical directory workspace exists without starting a shell (plan
   * 20260929-remote-desktop): the workspace a screen tab lives in. `path` is the device's HOME as
   * `listDeviceDirectory(daemonId, "~")` resolved it. Same reuse rule as terminalCreate.
   */
  function ensureDirectoryWorkspace(daemonId: string, path: string): Promise<DirectoryWorkspaceResult> {
    if (!controlAuthenticated) return Promise.resolve({ ok: false, error: "尚未登录或与服务器的连接未就绪" });
    const requestId = `${notificationRequestPrefix}-dirws-${++directoryWorkspaceRequest}`;
    return new Promise<DirectoryWorkspaceResult>((resolve) => {
      const timer = setTimeout(() => settleDirectoryWorkspace(requestId, { ok: false, error: "创建工作区超时，请重试" }), DEVICE_JOIN_KEY_TIMEOUT_MS);
      pendingDirectoryWorkspaces.set(requestId, { resolve, timer });
      send({ case: "directoryWorkspaceEnsure", value: { requestId, daemonId, path } });
    });
  }

  function connect(credential: AuthCredential) {
    // 重连/重登时若已 authed 则保持：断线期间保留最后快照渲染，由顶部横幅提示，不整页退回 loading。
    if (store.getState().authState !== "authed") store.setState({ authState: "authenticating" });
    controlAuthenticated = false;
    // 这是用户显式登录/换凭据，不是 createConnection 内部的同 token 自动重连；旧账号下的
    // remote channel 不得跨凭据继续存活，因此走 hard revoke。
    deviceRouter.setControlOnline(false);
    connection.connect(credential);
  }

  async function login(username: string, password: string) {
    store.setState({ loginError: "" });
    // 显式登录 = 可能换账号：旧账号的目录缓存不得带到新账号，authOk 后按新快照重写
    clearOfflineCatalog();
    connect({ username, password });
  }

  /**
   * Sign in with a session token that was just issued outside the WebSocket (the desktop's browser
   * login, plan 20260923): the same explicit-login semantics as `login`, carrying `{ token }` over
   * the existing token path. The token is persisted immediately so a restart before `authOk` keeps it.
   */
  function loginWithToken(issued: string) {
    if (!issued) return;
    store.setState({ loginError: "" });
    clearOfflineCatalog();
    token = issued;
    options.tokenStorage.write(issued);
    connect({ token: issued });
  }

  function logout(revoke = true) {
    shouldRetry = false;
    clearNotificationTimers();
    notificationAccount = "";
    notifiedIds.clear();
    store.setState({ notificationInbox: emptyNotificationInbox() });
    controlAuthenticated = false;
    settleDeviceAuthorize({ ok: false, error: "已登出" });
    failJoinKeys("已登出");
    failAgentSettingWrites("已登出");
    agentSettingsAccount = "";
    pendingTaskRemovals.clear();
    clearRemovals();
    clearOfflineTimer();
    clearOfflineCatalog();
    void deviceRouter.reset(true);
    if (revoke) send({ case: "clientLogout", value: {} });
    token = "";
    options.tokenStorage.clear();
    connection.stop();
    sessionMetadataSupported = false;
    sessionContents.clear();
    store.setState({
      authState: "need-login",
      loginName: "",
      daemons: [],
      projects: [],
      workspaces: [],
      tasks: [],
      ports: {},
      detachedTaskIds: new Set<string>(),
      deviceTransports: {},
      inputStates: {},
      localSessions: [],
      sessionMetadata: {},
      sessionAgents: {},
      secretRequests: {},
      executorRuns: {},
      annotationSummaries: {},
      agentSettings: EMPTY_AGENT_SETTINGS,
      agentSettingsSupported: false,
      agentSettingsReceived: false,
    });
  }

  // RUNNING 的 attach 直接交给本机 session authority；IDLE/EXITED 仍由中心 prepare durable create。
  function startTask(taskId: string, cols: number, rows: number, force = false) {
    const task = store.getState().tasks.find((item) => item.id === taskId);
    if (task?.status === TaskStatus.RUNNING && task.sessionId) {
      if (force) store.setState((state) => ({ detachedTaskIds: withoutSetValue(state.detachedTaskIds, taskId) }));
      deviceRouter.attachSession(task.daemonId, task.id, task.sessionId, cols, rows, force);
      return;
    }
    store.setState((state) => ({ detachedTaskIds: withoutSetValue(state.detachedTaskIds, taskId) }));
    send({ case: "taskStart", value: { taskId, cols, rows } });
  }

  // The tab is hidden at once (plan 20261002-optimistic-removal) and comes back only if the stop fails.
  async function closeTask(task: Task): Promise<void> {
    const removal = beginRemoval("task", task.id);
    if (!removal) return;
    if (task.status === TaskStatus.RUNNING && task.sessionId) {
      try {
        deviceRouter.attachSession(task.daemonId, task.id, task.sessionId, 80, 24, true);
        await deviceRouter.stopSession(task.daemonId, task.sessionId);
      } catch (error) {
        // session_not_found 是「设备侧已经没有它」的确定答复（daemon/supervisor 重启后的残留
        // task 都是这种），继续删 catalog task 才能收敛；其余错误仍然中止，不猜测本机状态。
        if ((error as { code?: string }).code !== "session_not_found") {
          // Settled meanwhile (the centre reported it gone): nothing to bring back or report.
          if (removals.task.get(task.id) !== removal) return;
          rollbackRemovals([removal]);
          reportLocalError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      if (removals.task.get(task.id) !== removal) return;
      // 本地 stop 是独立设备事实；中心离线时排队，重连认证后补投删除。
      removeTask(task.id);
      return;
    }
    removeTask(task.id);
  }

  /** 删除 catalog task：中心离线时不伪造成功，改为记账，authOk 后按序补投。 */
  function removeTask(taskId: string): void {
    if (!controlAuthenticated) {
      pendingTaskRemovals.add(taskId);
      return;
    }
    connection.send({ case: "taskRemove", value: { taskId } });
    const removal = removals.task.get(taskId);
    if (removal) markRemovalSent(removal);
  }

  function flushPendingTaskRemovals(): void {
    for (const taskId of pendingTaskRemovals) {
      connection.send({ case: "taskRemove", value: { taskId } });
      const removal = removals.task.get(taskId);
      if (removal) markRemovalSent(removal);
    }
    pendingTaskRemovals.clear();
  }

  function retainDevice(daemonId: string, options?: { measureOnly?: boolean }): () => void {
    const release = deviceRouter.retainDevice(daemonId, options);
    // ports 是独立 elevated RPC；失败不会触碰健康 terminal lane，URL 仍由中心门禁事实更新。
    // 只测量时不取：那会连带把 elevated lane 拉起来（还要 lease），而侧栏那个读数用不上端口清单。
    if (options?.measureOnly !== true) void deviceRouter.requestPorts(daemonId).catch(() => undefined);
    return release;
  }

  /** 设备浏览模式列目录（导入向导）：以设备用户 home 为根，path 为相对路径（"" = home 本身）。 */
  async function listDeviceDirectory(daemonId: string, path: string): Promise<FsListResult> {
    try {
      const result = await deviceRouter.fsList(daemonId, "", path, true);
      return { ok: result.ok, entries: result.entries, error: result.error ?? "", path: result.path };
    } catch (error) {
      return { ok: false, entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 读取任务（终端）的最后输出（plan 097）：web 激活已退出的 Tab 时回放。同一 task 的并发请求共享同一份
   * pending（回应不带 request id、按 task 归属）；结果不进 store（256 KB 级 bytes 不该常驻 zustand），
   * 15 秒无回应按超时收口，断连期间也靠它兜底。 */
  function readTask(taskId: string, maxBytes?: number): Promise<TaskReadResult> {
    const existing = pendingTaskReads.get(taskId);
    if (existing) return existing.promise;
    let resolve!: (result: TaskReadResult) => void;
    const promise = new Promise<TaskReadResult>((res) => {
      resolve = res;
    });
    const timer = setTimeout(() => {
      pendingTaskReads.delete(taskId);
      resolve({ ok: false, error: "读取终端输出超时" });
    }, TASK_READ_TIMEOUT_MS);
    pendingTaskReads.set(taskId, { promise, resolve, timer });
    send({ case: "taskRead", value: { taskId, maxBytes: maxBytes ?? 0 } });
    return promise;
  }

  async function execInWorkspace(workspaceId: string, command: string, args: string[], timeoutMs?: number): Promise<ExecResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { ok: false, exitCode: -1, stdout: "", stderr: "", error: "工作区不存在" };
    try {
      const result = await deviceRouter.exec(workspace.daemonId, workspaceId, command, args, timeoutMs);
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error ?? "",
      };
    } catch (error) {
      return { ok: false, exitCode: -1, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Every changed file of a workspace in one device round trip. Default: the branch scope (the
   * diff-stat base); `uncommitted`: against HEAD. An old worker that ignores the scope is reported
   * as `daemonOutdated` with `outdatedOption`, never as the wrong list.
   */
  async function listWorkspaceChanges(workspaceId: string, options: { uncommitted?: boolean } = {}): Promise<ChangesListResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { ok: false, error: "工作区不存在", daemonOutdated: false };
    const uncommitted = options.uncommitted === true;
    try {
      const result = await deviceRouter.changesList(workspace.daemonId, workspaceId, uncommitted);
      return toChangesListResult(result, uncommitted);
    } catch (error) {
      return changesFailure(error);
    }
  }

  /**
   * One changed file's two sides, against the `base` a previous `listWorkspaceChanges` returned.
   * `whitespace` picks the patch's whitespace flag; a worker that does not apply it is `daemonOutdated`.
   */
  async function readWorkspaceChangeFile(
    workspaceId: string,
    base: string,
    path: string,
    oldPath?: string,
    options: { whitespace?: WhitespaceMode } = {},
  ): Promise<ChangeFileResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { ok: false, error: "工作区不存在", daemonOutdated: false };
    const whitespace = options.whitespace ?? "show";
    try {
      const result = await deviceRouter.changesFile(workspace.daemonId, workspaceId, base, path, oldPath, whitespaceWire(whitespace));
      return toChangeFileResult(result, whitespace);
    } catch (error) {
      return changesFailure(error);
    }
  }

  /**
   * Which of `paths` exist in a workspace, and what each one canonically is (plan
   * 20261001-terminal-file-tab): one device round trip, one entry per path in order. Relative
   * paths resolve against the workspace root.
   */
  async function statWorkspaceFiles(workspaceId: string, paths: string[]): Promise<FileStatResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { kind: "failed", error: "工作区不存在" };
    try {
      return toFileStatResult(await deviceRouter.fsStat(workspace.daemonId, workspaceId, paths));
    } catch (error) {
      return fileStatFailure(error);
    }
  }

  /**
   * Every entry of a workspace in one device round trip (plan 20261002-workspace-files-view): git's
   * view of a repository top level, a walk otherwise. A workspace too large for one answer is
   * `truncated`; its folders are then listed one at a time with `listWorkspaceDirectory`.
   */
  async function indexWorkspaceFiles(workspaceId: string): Promise<FileIndexResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { kind: "failed", error: "工作区不存在" };
    try {
      return toFileIndexResult(await deviceRouter.fsIndex(workspace.daemonId, workspaceId));
    } catch (error) {
      return fileIndexFailure(error);
    }
  }

  /** One folder of a workspace (plan 20261002-workspace-files-view): `path` is workspace-relative
   * ("" = the root). Entries come directories first, then by name. */
  async function listWorkspaceDirectory(workspaceId: string, path: string): Promise<FsListResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { ok: false, entries: [], error: "工作区不存在" };
    try {
      const result = await deviceRouter.fsList(workspace.daemonId, workspaceId, path, false);
      return { ok: result.ok, entries: result.entries, error: result.error ?? "", path: result.path };
    } catch (error) {
      return { ok: false, entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * One workspace file's content (plan 20261001-terminal-file-tab). With `knownRevision` the read
   * is conditional: an unchanged file answers `notModified` without content.
   */
  async function readWorkspaceFile(workspaceId: string, path: string, knownRevision?: string): Promise<FileReadResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { kind: "failed", error: "工作区不存在" };
    try {
      return toFileReadResult(await deviceRouter.fsRead(workspace.daemonId, workspaceId, path, knownRevision));
    } catch (error) {
      return fileReadFailure(error);
    }
  }

  /** 终端剪贴板贴图（plan 014，temp 模式修订）：把图片字节上传落盘。
   * temp=true（终端贴图固定用法）：path 须为单段文件名，落到 daemon 侧系统临时目录，
   * 成功时 path 回带该处的绝对路径。temp=false：path 为该工作区 worktree 内相对路径，
   * 成功时 path 回带清洗过的相对路径。两种情况均以回带的 path 为准，不自行拼装。 */
  async function sendFsWrite(workspaceId: string, path: string, data: Uint8Array, temp: boolean): Promise<FsWriteResult> {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { ok: false, error: "工作区不存在" };
    try {
      const result = await deviceRouter.fsWrite(workspace.daemonId, workspaceId, path, data, temp);
      return { ok: result.ok, path: result.path, error: result.error ?? "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Answer a pending secret request (plan 20260926-agent-secret-input). The value goes straight to
   * the requesting device's worker over the end-to-end Device channel and never enters the store;
   * the result is the worker's acknowledgement. */
  async function answerSecretRequest(requestId: string, answer: SecretAnswer): Promise<SecretAnswerResult> {
    const request = store.getState().secretRequests[requestId];
    if (!request) return { status: "already_answered" };
    const kind =
      answer.kind === "provide" ? SecretAnswerKind.PROVIDE : answer.kind === "decline" ? SecretAnswerKind.DECLINE : SecretAnswerKind.CANCEL;
    try {
      const status = await deviceRouter.answerSecret(request.daemonId, requestId, kind, answer.kind === "provide" ? answer.value : "");
      return secretAnswerResult(status);
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /* ---------------- browser annotations (plan 20260929-browser-annotations) ---------------- */
  // Content goes end to end to the worker of the workspace's device over the Device channel; the
  // store keeps none of it (only the summaries the center relays).

  function annotationDaemon(workspaceId: string): string | null {
    return store.getState().workspaces.find((item) => item.id === workspaceId)?.daemonId ?? null;
  }

  async function listAnnotations(workspaceId: string): Promise<AnnotationListResult> {
    const daemonId = annotationDaemon(workspaceId);
    if (!daemonId) return { ok: false, reason: "refused", error: "工作区不存在" };
    try {
      const result = await deviceRouter.listAnnotations(daemonId, workspaceId);
      if (!result.ok) return { ok: false, reason: "refused", error: result.error };
      return { ok: true, revision: result.revision, annotations: result.annotations, codeComments: result.codeComments };
    } catch (error) {
      return annotationFailure(error);
    }
  }

  async function changeAnnotations(workspaceId: string, change: AnnotationChange): Promise<AnnotationMutateResult> {
    const daemonId = annotationDaemon(workspaceId);
    if (!daemonId) return { ok: false, reason: "refused", error: "工作区不存在" };
    if (change.kind === "put") {
      const imageBytes = change.put.addImages.reduce((total, image) => total + image.data.byteLength, 0);
      if (imageBytes > MAX_ANNOTATION_UPLOAD_BYTES) return { ok: false, reason: "refused", error: ANNOTATION_UPLOAD_TOO_LARGE };
    }
    const action: DeviceAnnotationsMutate["action"] =
      change.kind === "put"
        ? { case: "put", value: change.put }
        : change.kind === "delete"
          ? { case: "delete", value: create(AnnotationDeleteSchema, { annotationIds: change.annotationIds }) }
          : change.kind === "reopen"
            ? { case: "reopen", value: create(AnnotationReopenSchema, { annotationId: change.annotationId, comment: change.comment }) }
            : change.kind === "restore"
              ? { case: "restore", value: create(AnnotationRestoreSchema, { annotationIds: change.annotationIds }) }
              : { case: "clearResolved", value: create(AnnotationClearResolvedSchema) };
    try {
      const result = await deviceRouter.mutateAnnotations(daemonId, workspaceId, action);
      if (!result.ok) return { ok: false, reason: "refused", error: result.error };
      return { ok: true, revision: result.revision, annotation: result.annotation, removedIds: result.removedIds };
    } catch (error) {
      return annotationFailure(error);
    }
  }

  async function readAnnotationImage(workspaceId: string, annotationId: string, imageId: string): Promise<AnnotationImageResult> {
    const daemonId = annotationDaemon(workspaceId);
    if (!daemonId) return { ok: false, reason: "refused", error: "工作区不存在" };
    try {
      const result = await deviceRouter.readAnnotationImage(daemonId, workspaceId, annotationId, imageId);
      if (!result.ok) return { ok: false, reason: "refused", error: result.error };
      return { ok: true, mimeType: result.mimeType, data: result.data };
    } catch (error) {
      return annotationFailure(error);
    }
  }

  /** 「交给 agent」: type `text`, then Enter, into the agent terminal `taskId` of the workspace
   * without focusing or opening it. A terminal this client already drives gets the keystrokes as
   * the user's own; any other goes through the worker's agent input, which refuses while someone
   * else holds the terminal. */
  async function handOffAnnotations(workspaceId: string, taskId: string, text: string): Promise<AnnotationHandOffResult> {
    const task = store.getState().tasks.find((item) => item.id === taskId);
    if (!task?.sessionId || task.workspaceId !== workspaceId || task.status !== TaskStatus.RUNNING) {
      return { ok: false, reason: "refused", error: "终端已不在运行" };
    }
    const sessionId = task.sessionId;
    if (deviceRouter.holdsSession(task.daemonId, sessionId)) {
      const encoder = new TextEncoder();
      if (!deviceRouter.sendInput(task.daemonId, sessionId, encoder.encode(text))) {
        return { ok: false, reason: "unreachable", error: "终端输入暂时无法送达" };
      }
      await new Promise((resolve) => setTimeout(resolve, HAND_OFF_ENTER_DELAY_MS));
      deviceRouter.sendInput(task.daemonId, sessionId, encoder.encode("\r"));
      return { ok: true };
    }
    try {
      const result = await deviceRouter.handOffAnnotations(task.daemonId, workspaceId, sessionId, text);
      if (!result.ok) return { ok: false, reason: "refused", error: result.error, held: result.held };
      return { ok: true };
    } catch (error) {
      return annotationFailure(error);
    }
  }

  /** Whether this client itself holds the terminal of `taskId`: open here, attached, not taken over
   * by another client. Input typed then reaches the shell as the user's own. */
  function holdsTaskTerminal(taskId: string): boolean {
    const task = store.getState().tasks.find((item) => item.id === taskId);
    return Boolean(task?.sessionId && deviceRouter.holdsSession(task.daemonId, task.sessionId));
  }

  /** Types `text` into a terminal this client holds, as the user's own keystrokes (one write).
   * False when it is not held here or the input could not be queued. */
  function typeIntoHeldTerminal(taskId: string, text: string): boolean {
    const task = store.getState().tasks.find((item) => item.id === taskId);
    if (!task?.sessionId || !deviceRouter.holdsSession(task.daemonId, task.sessionId)) return false;
    return deviceRouter.sendInput(task.daemonId, task.sessionId, new TextEncoder().encode(text));
  }

  /** 本地失败（exec/checkout 等非服务端错误）汇入同一个全局错误提示通道 */
  function reportLocalError(message: string) {
    errorSequence += 1;
    store.setState({ lastError: { id: errorSequence, message } });
  }

  if (token) {
    connection.connect({ token });
    // 有界等待：链路半死（连上但 authOk 石沉大海）时也不能把人锁在 authenticating 页；
    // 超时装载缓存，authOk 随后到达照样覆盖。
    if (offlineCatalog) offlineTimer = setTimeout(hydrateOfflineCatalog, offlineCatalog.timeoutMs ?? OFFLINE_CATALOG_TIMEOUT_MS);
  }

  function loadNotifications(older = false) {
    if (!controlAuthenticated || !notificationSupported) return;
    const inbox = store.getState().notificationInbox;
    if (inbox.loading) return;
    store.setState({ notificationInbox: { ...inbox, loading: true, error: "" } });
    waitForNotificationPage();
    notificationPageRequestId = `${notificationRequestPrefix}-page-${++notificationRequest}`;
    send({ case: "notificationList", value: { requestId: notificationPageRequestId, beforeSequence: older ? inbox.nextBeforeSequence : 0 } });
  }
  function markNotificationRead(id = "") {
    if (!controlAuthenticated || !notificationSupported) {
      store.setState((state) => ({ notificationInbox: { ...state.notificationInbox, error: "尚未连接，无法标记已读" } }));
      return;
    }
    const requestId = `${notificationRequestPrefix}-read-${++notificationRequest}`;
    notificationReadTimers.set(requestId, setTimeout(() => {
      notificationReadTimers.delete(requestId);
      store.setState((state) => ({ notificationInbox: { ...state.notificationInbox, error: "标记已读未获确认，请重试" } }));
    }, 15000));
    send({ case: "notificationRead", value: { requestId, id, throughSequence: store.getState().notificationInbox.latestSequence } });
  }
  function onNotification(listener: (item: AccountNotification) => void) {
    notificationListeners.add(listener);
    return () => { notificationListeners.delete(listener); };
  }

  function disconnect() {
    clearNotificationTimers();
    notificationListeners.clear();
    controlAuthenticated = false;
    settleDeviceAuthorize({ ok: false, error: "客户端已断开" });
    failJoinKeys("客户端已断开");
    failAgentSettingWrites("客户端已断开");
    clearRemovals();
    clearOfflineTimer();
    deviceRouter.destroy();
    connection.stop();
    sessionConsumers.clear();
  }

  return {
    loadNotifications,
    markNotificationRead,
    onNotification,
    store,
    login,
    loginWithToken,
    logout,
    send,
    sendInput,
    resizeSession,
    startTask,
    closeTask,
    removeWorkspace,
    removeProject,
    hiddenWorkspaceIds,
    retainDevice,
    /** executor（plan 116）：订阅 daemon 推来的四条；返回退订函数。至多一个订阅者。 */
    subscribeExecutor(listener: (event: ExecutorClientEvent) => void): () => void {
      executorListener = listener;
      return () => {
        if (executorListener === listener) executorListener = undefined;
      };
    },
    answerSecretRequest,
    listAnnotations,
    changeAnnotations,
    readAnnotationImage,
    handOffAnnotations,
    sendExecutorHostRegister: deviceRouter.sendExecutorHostRegister,
    sendExecutorReport: deviceRouter.sendExecutorReport,
    /** The desktop host forwards one transcript fragment of a run it executes (plan
     * 20260929-executor-pip) to the local daemon, which buffers it for every viewer. */
    sendExecutorTranscriptFragment: deviceRouter.sendExecutorTranscriptFragment,
    /** Follow a run's transcript (plan 20260929-executor-pip) over the Device channel of the device
     * that hosts it: the backlog after `fromSeq`, then live fragments, then the end. The route is
     * held while subscribed; a reconnect resumes from the last seq. Returns the unsubscribe. */
    subscribeExecutorTranscript(
      run: Pick<ExecutorRunState, "daemonId" | "runId">,
      fromSeq: number,
      listener: (event: ExecutorTranscriptEvent) => void,
    ): () => void {
      return deviceRouter.subscribeExecutorTranscript(run.daemonId, run.runId, BigInt(Math.max(0, Math.floor(fromSeq))), listener);
    },
    /** Stop a run from its card (plan 20260929-executor-pip): one click, no confirmation; the
     * worker cancels it through the same path the CLI's timeout uses. False when the device's
     * channel is not up or cannot carry it right now. */
    stopExecutorRun(run: Pick<ExecutorRunState, "daemonId" | "runId">): boolean {
      return deviceRouter.stopExecutorRun(run.daemonId, run.runId);
    },
    registerSessionConsumer,
    watchSessionContent,
    listDeviceDirectory,
    execInWorkspace,
    listWorkspaceChanges,
    readWorkspaceChangeFile,
    statWorkspaceFiles,
    indexWorkspaceFiles,
    listWorkspaceDirectory,
    readWorkspaceFile,
    readTask,
    sendFsWrite,
    authorizeDevice,
    createDeviceJoinKey,
    setAgentSetting,
    ensureDirectoryWorkspace,
    holdsTaskTerminal,
    typeIntoHeldTerminal,
    reportLocalError,
    disconnect,
  };
}

export type CofluxClient = ReturnType<typeof createCofluxClient>;

/**
 * executor（plan 116）：daemon 经 device 通道推来的四条，归一成一个联合体交给订阅者。
 * 带上 `daemonId` 是为了让订阅者能确认「这是本机那台推来的」——host 只服务本机。
 */
export type ExecutorClientEvent =
  | {
      kind: "assign";
      runId: string;
      prompt: string;
      write: boolean;
      workspaceId: string;
      workspaceRoot: string;
      submittedAt: number;
      daemonId: string;
    }
  | { kind: "cancel"; runId: string; daemonId: string }
  | { kind: "registered"; ok: boolean; error?: string; reconcileRunIds: string[]; daemonId: string }
  | { kind: "ack"; runId: string; daemonId: string };
