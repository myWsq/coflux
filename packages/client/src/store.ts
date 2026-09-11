import { createStore, type StoreApi } from "zustand/vanilla";
import {
  TaskStatus,
  type ClientToServerPayload,
  type DaemonInfo,
  type DeviceSessionCatalog,
  type FsEntry,
  type Project,
  type SessionCheckpoint,
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
};

export type WorkspaceActivity =
  | { status: "idle" }
  | { status: "active"; agent?: string }
  | { status: "approval"; agent: string }
  | { status: "question"; agent: string; message?: string }
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
  let approval: string | null = null;
  let question: SessionAgentState | null = null;
  let active: string | undefined;
  let done: string | null = null;
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || task.status !== TaskStatus.RUNNING || !task.sessionId) continue;
    const entry = sessionAgents[task.sessionId];
    if (entry === undefined) continue;
    if (entry.state === "approval") approval = approval ?? entry.agent;
    else if (entry.state === "question") question = question ?? entry;
    else if (entry.state === "active") active = active ?? entry.agent;
    else if (entry.state === "done" || entry.state === "waiting") done = done ?? entry.agent;
  }
  if (approval !== null) return { status: "approval", agent: approval };
  if (question !== null) return { status: "question", agent: question.agent, message: question.message || undefined };
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
  createDeviceRouter,
  type DeviceInputState,
  type DeviceRouter,
  type DeviceTransportState,
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
/** 设备授权兑现结果（plan 112；与桌面版 plan 113 的契约）：失败文案来自服务端 `deviceAuthorizeInfo{ ok:false }`
 * 或本地（未登录 / 连接未就绪 / 断连 / 超时）。 */
export type DeviceAuthorizeResult = { ok: true } | { ok: false; error: string };
const TASK_READ_TIMEOUT_MS = 15_000;
/** deviceAuthorize 的等待上限：服务端要把 DaemonEnrolled 送达 daemon 并等它上线才回 deviceAuthorized。 */
const DEVICE_AUTHORIZE_TIMEOUT_MS = 20_000;

/** 已退出终端的最后输出来源（plan 097）：log = 命令终端的非 tty 纯文本日志尾部；snapshot / checkpoint = 规范化 ANSI
 * 屏幕（分别来自 daemon 当前画面与中心缓存）；none = 没有任何可回放内容。 */
export type TaskReadSource = "log" | "snapshot" | "checkpoint" | "none";
export type TaskReadResult =
  | { ok: true; taskId: string; data: Uint8Array; source: TaskReadSource; capturedAt: number; status: TaskStatus; exitCode?: number }
  | { ok: false; error: string };
type SessionConsumer = (data: Uint8Array, replace: boolean) => void;

export type LocalSessionState = {
  daemonId: string;
  sessionId: string;
  taskId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  outputSeq: bigint;
  startedAt: number;
  status: "running" | "exited";
  exitCode?: number;
  exitedAt?: number;
};

export type DeviceTransportOptions = {
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
};

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
      sessionAgents: catalog.sessionAgents && typeof catalog.sessionAgents === "object" ? catalog.sessionAgents : {},
    };
  } catch {
    return null;
  }
}

export type CofluxState = {
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
  sessionCheckpoints: Record<string, SessionCheckpoint>;
  /** agent presence + hook 回合状态（plan 073）：sessionId → agent/state。来自 sessionAgentsUpdated 按设备全量替换。 */
  sessionAgents: Record<string, SessionAgentState>;
  lastError: ClientError | null;
  snapshotRevision: number;
};

function upsert<T>(list: T[], item: T, match: (value: T) => boolean): T[] {
  const index = list.findIndex(match);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

/** 目录工作区（无 repo 终端，plan 045）：projectId 为空即目录工作区。
 * 判定在客户端收敛于此一处，勿在 UI 层散落裸比较。 */
export function isDirWorkspace(workspace: Workspace): boolean {
  return !workspace.projectId;
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
  const sessionConsumers = new Map<string, Set<SessionConsumer>>();
  // plan 097：taskRead 的 pending 表，按 taskId 去重共享（回应不带 request id）。
  const pendingTaskReads = new Map<string, { promise: Promise<TaskReadResult>; resolve: (result: TaskReadResult) => void; timer: ReturnType<typeof setTimeout> }>();
  // 中心离线期间已在本机 stop、但还没能删除的 catalog task；重连认证后补投（见 removeTask）。
  const pendingTaskRemovals = new Set<string>();
  // plan 112：在飞的 deviceAuthorize（回应不带 request id，一次只允许一个在飞）。
  let pendingDeviceAuthorize: { resolve: (result: DeviceAuthorizeResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;

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
    sessionCheckpoints: {},
    sessionAgents: {},
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
      projects: catalog.projects,
      workspaces: catalog.workspaces,
      tasks: catalog.tasks,
      ports: catalog.ports,
      sessionAgents: catalog.sessionAgents,
      snapshotRevision: state.snapshotRevision + 1,
    }));
  }

  const liveSessionIds = new Set<string>();

  function deliverSession(sessionId: string, data: Uint8Array, replace: boolean): void {
    const consumers = sessionConsumers.get(sessionId);
    if (consumers) for (const consumer of consumers) consumer(data, replace);
  }

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
          outputSeq: session.outputSeq,
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
          outputSeq: exit.finalOutputSeq,
          startedAt: existing?.startedAt ?? 0,
          status: "exited",
          exitCode: exit.exitCode,
          exitedAt: exit.exitedAt,
        };
        localSessions = upsert(localSessions, next, (item) => item.daemonId === daemonId && item.sessionId === exit.sessionId);
      }
      return { localSessions };
    });
    for (const exit of catalog.exits) markSessionExited(daemonId, exit.taskId, exit.sessionId, exit.exitCode);
  }

  function markSessionExited(daemonId: string, taskId: string, sessionId: string, exitCode: number): void {
    liveSessionIds.delete(sessionId);
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
        outputSeq: existing?.outputSeq ?? 0n,
        startedAt: existing?.startedAt ?? 0,
        status: "exited",
        exitCode,
        exitedAt: existing?.exitedAt ?? Date.now(),
      };
      const inputStates = { ...state.inputStates };
      delete inputStates[sessionId];
      // session 已退出：agent presence 一并清理，防僵尸琥珀（plan 073）
      const sessionAgents = { ...state.sessionAgents };
      delete sessionAgents[sessionId];
      return {
        localSessions: upsert(state.localSessions, local, (item) => item.daemonId === daemonId && item.sessionId === sessionId),
        tasks: state.tasks.map((task) => task.id === taskId && task.sessionId === sessionId
          ? { ...task, status: TaskStatus.EXITED, sessionId: undefined, exitCode }
          : task),
        detachedTaskIds: withoutSetValue(state.detachedTaskIds, taskId),
        inputStates,
        sessionAgents,
      };
    });
  }

  let connection!: ReturnType<typeof createConnection>;
  const deviceRouter: DeviceRouter = createDeviceRouter({
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
    onSessionDetached: (_daemonId, taskId) => {
      store.setState((state) => ({ detachedTaskIds: new Set(state.detachedTaskIds).add(taskId) }));
    },
    onSessionExited: markSessionExited,
    onCatalog: updateLocalCatalog,
    onPorts: () => {
      // 预览 URL 仍由中心的账号门禁路由签发；Device RPC 只负责确认本机原始监听事实。
    },
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
        // 回应不会再来了：在飞的设备授权立即失败而不是挂到超时（plan 112）
        settleDeviceAuthorize({ ok: false, error: "与服务器的连接已断开，请重试" });
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
    const task = store.getState().tasks.find((item) => item.sessionId === sessionId);
    if (task) {
      deviceRouter.sendInput(task.daemonId, sessionId, bytes);
      return;
    }
    reportLocalError("会话不存在，无法发送终端输入");
  }

  function resizeSession(sessionId: string, cols: number, rows: number) {
    const task = store.getState().tasks.find((item) => item.sessionId === sessionId);
    if (task) {
      deviceRouter.resize(task.daemonId, sessionId, cols, rows);
      return;
    }
    reportLocalError("会话不存在，无法调整终端尺寸");
  }

  function registerSessionConsumer(sessionId: string, consumer: SessionConsumer) {
    const routedTask = store.getState().tasks.find((task) => task.sessionId === sessionId);
    let consumers = sessionConsumers.get(sessionId);
    if (!consumers) {
      consumers = new Set<SessionConsumer>();
      sessionConsumers.set(sessionId, consumers);
    }
    consumers.add(consumer);
    const checkpoint = store.getState().sessionCheckpoints[sessionId];
    if (checkpoint && !liveSessionIds.has(sessionId)) consumer(checkpoint.ansiSnapshot, true);
    return () => {
      const current = sessionConsumers.get(sessionId);
      if (!current) return;
      current.delete(consumer);
      if (current.size === 0) {
        sessionConsumers.delete(sessionId);
        liveSessionIds.delete(sessionId);
        if (routedTask) deviceRouter.suspendSession(routedTask.daemonId, sessionId);
      }
    };
  }

  // 快照/增量按到达顺序应用（server 保证 stateSnapshot 先于其后的广播），不做乱序缓冲。
  // 每条消息只调用一次 store.setState：天然原子提交，订阅者只看到一致的最终状态
  // （不依赖 React 批处理细节，比 Solid 版的 batch(...) 包裹更直接）。
  function handleServerMessage(payload: ServerPayload) {
    if (deviceRouter.handleControlPayload(payload)) return;
    switch (payload.case) {
      case "authOk": {
        const value = payload.value;
        controlAuthenticated = true;
        deviceRouter.setIceServers(value.iceServers);
        deviceRouter.setControlOnline(true);
        store.setState({ authState: "authed", loginError: "", loginName: value.loginName ?? "" });
        shouldRetry = true;
        connection.resetBackoff();
        if (value.clientToken) {
          token = value.clientToken;
          options.tokenStorage.write(value.clientToken);
        }
        send({ case: "clientSubscribe", value: {} });
        flushPendingTaskRemovals();
        options.onAuthenticated?.();
        break;
      }
      case "authError": {
        controlAuthenticated = false;
        deviceRouter.setControlOnline(false);
        token = "";
        options.tokenStorage.clear();
        clearOfflineCatalog();
        store.setState({
          loginError: "登录失败：用户名或密码错误",
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
      case "stateSnapshot": {
        const value = payload.value;
        const nextPorts: Record<string, PortPreview[]> = {};
        for (const group of value.ports) {
          nextPorts[group.taskId] = group.ports.map((preview) => ({ port: preview.port, url: preview.url }));
        }
        const taskIds = new Set(value.tasks.map((task) => task.id));
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
            projects: value.projects,
            workspaces: value.workspaces,
            tasks,
            ports: nextPorts,
            detachedTaskIds: new Set([...state.detachedTaskIds].filter((taskId) => taskIds.has(taskId))),
            // agent presence 清零重建：server 会紧随快照按设备补发当前全量（plan 073）。
            sessionAgents: {},
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
        store.setState((state) => ({
          daemons: state.daemons.filter((daemon) => daemon.daemonId !== value.daemonId),
          projects: state.projects.filter((project) => project.daemonId !== value.daemonId),
          workspaces: state.workspaces.filter((workspace) => workspace.daemonId !== value.daemonId),
          tasks: state.tasks.filter((task) => task.daemonId !== value.daemonId),
          sessionAgents: Object.fromEntries(Object.entries(state.sessionAgents).filter(([, entry]) => entry.daemonId !== value.daemonId)),
        }));
        break;
      }
      case "projectCreated": {
        const project = payload.value.project;
        if (!project) break;
        store.setState((state) => ({ projects: upsert(state.projects, project, (item) => item.id === project.id) }));
        break;
      }
      case "projectRemoved": {
        const value = payload.value;
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
        store.setState((state) => ({ workspaces: upsert(state.workspaces, workspace, (item) => item.id === workspace.id) }));
        break;
      }
      case "workspaceRemoved": {
        const value = payload.value;
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
            tasks: upsert(state.tasks, task, (item) => item.id === task.id),
            detachedTaskIds: task.status !== TaskStatus.RUNNING ? withoutSetValue(state.detachedTaskIds, task.id) : state.detachedTaskIds,
          };
        });
        break;
      }
      case "taskRemoved": {
        const value = payload.value;
        const removed = store.getState().tasks.find((task) => task.id === value.taskId);
        const removedSessionId = removed?.sessionId ?? store.getState().localSessions.find((session) => session.taskId === value.taskId)?.sessionId;
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
            sessionCheckpoints: removedSessionId
              ? Object.fromEntries(Object.entries(state.sessionCheckpoints).filter(([sessionId]) => sessionId !== removedSessionId))
              : state.sessionCheckpoints,
            sessionAgents: removedSessionId
              ? Object.fromEntries(Object.entries(state.sessionAgents).filter(([sessionId]) => sessionId !== removedSessionId))
              : state.sessionAgents,
          };
        });
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
        const checkpoint = payload.value;
        store.setState((state) => ({
          sessionCheckpoints: { ...state.sessionCheckpoints, [checkpoint.sessionId]: checkpoint },
        }));
        const task = store.getState().tasks.find((item) => item.id === checkpoint.taskId);
        if (task) deviceRouter.seedCheckpoint(task.daemonId, checkpoint.taskId, checkpoint.sessionId, checkpoint.snapshotSeq);
        if (!liveSessionIds.has(checkpoint.sessionId)) deliverSession(checkpoint.sessionId, checkpoint.ansiSnapshot, true);
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
            };
          }
          return { sessionAgents };
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
          value.source === "log" || value.source === "snapshot" || value.source === "checkpoint" ? value.source : "none";
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
        store.setState({ lastError: { id: errorSequence, message: payload.value.message } });
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
      default:
        break;
    }
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

  function logout(revoke = true) {
    shouldRetry = false;
    controlAuthenticated = false;
    settleDeviceAuthorize({ ok: false, error: "已登出" });
    pendingTaskRemovals.clear();
    clearOfflineTimer();
    clearOfflineCatalog();
    void deviceRouter.reset(true);
    if (revoke) send({ case: "clientLogout", value: {} });
    token = "";
    options.tokenStorage.clear();
    connection.stop();
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
      sessionCheckpoints: {},
      sessionAgents: {},
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

  async function closeTask(task: Task): Promise<void> {
    if (task.status === TaskStatus.RUNNING && task.sessionId) {
      try {
        deviceRouter.attachSession(task.daemonId, task.id, task.sessionId, 80, 24, true);
        await deviceRouter.stopSession(task.daemonId, task.sessionId);
      } catch (error) {
        // session_not_found 是「设备侧已经没有它」的确定答复（daemon/supervisor 重启后的残留
        // task 都是这种），继续删 catalog task 才能收敛；其余错误仍然中止，不猜测本机状态。
        if ((error as { code?: string }).code !== "session_not_found") {
          reportLocalError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
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
  }

  function flushPendingTaskRemovals(): void {
    for (const taskId of pendingTaskRemovals) connection.send({ case: "taskRemove", value: { taskId } });
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

  function disconnect() {
    controlAuthenticated = false;
    settleDeviceAuthorize({ ok: false, error: "客户端已断开" });
    clearOfflineTimer();
    deviceRouter.destroy();
    connection.stop();
    sessionConsumers.clear();
  }

  return {
    store,
    login,
    logout,
    send,
    sendInput,
    resizeSession,
    startTask,
    closeTask,
    retainDevice,
    registerSessionConsumer,
    listDeviceDirectory,
    execInWorkspace,
    readTask,
    sendFsWrite,
    authorizeDevice,
    reportLocalError,
    disconnect,
  };
}

export type CofluxClient = ReturnType<typeof createCofluxClient>;
