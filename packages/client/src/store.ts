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
export type SessionAgentState = { daemonId: string; taskId: string; agent: string; state: string; /** `cofluxd notify` 的留言（plan 074），空 = agent 没留话 */ message: string };

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

import { createConnection, type AuthCredential, type ConnectionStatus, type ServerPayload } from "./connection";
import {
  createDeviceRouter,
  type DeviceInputState,
  type DeviceRouter,
  type DeviceTransportState,
} from "./device-router";

export type { AuthCredential, ConnectionStatus } from "./connection";
// "outdated"：构建版本失配，reload 一次仍未拿到新 bundle（plan 033）——不是认证失败，
// UI 须走独立展示面，不与 auth-failed 的 loginError 混用（语义不同，混用会误导用户）。
export type AuthState = "need-login" | "authenticating" | "authed" | "auth-failed" | "outdated";
export type PortPreview = { port: number; url: string };
export type ClientError = { id: number; message: string };
export type FsListResult = { ok: boolean; entries: FsEntry[]; error: string; path?: string };
export type ExecResult = { ok: boolean; exitCode: number; stdout: string; stderr: string; error: string };
export type FsWriteResult = { ok: boolean; path?: string; error: string };
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
  /** desktop 为 true；mobile 为 false，只使用中心 opaque relay。 */
  enableLocalTransport: boolean;
  identityDatabaseName: string;
  origin?: string;
};

export type CofluxClientOptions = {
  /** /client WS 端点地址（含协议与路径）。 */
  serverUrl: string;
  /** 会话 token 的 localStorage key，两端（web/移动）各自命名空间。 */
  tokenStorageKey: string;
  /** 构建版本（git short SHA；vite dev 固定 "dev"），随认证上报供 server 做版本准入（plan 033）。 */
  buildId: string;
  /** 所有客户端统一走 DeviceTransport；是否尝试 loopback direct 由 enableLocalTransport 决定。 */
  deviceTransport: DeviceTransportOptions;
};

export type CofluxState = {
  status: ConnectionStatus;
  authState: AuthState;
  loginError: string;
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
  let token = localStorage.getItem(options.tokenStorageKey) ?? "";
  // 本地已有会话 token = 之前认证成功过，首次连接就该纳入自动重连——否则刷新后的第一条连接
  // 若在拿到 authOk 前断掉（链路被静默掐、server authDeadline 关闭…），会永久停在断开态等
  // 用户再刷一次。清零点在 authError / clientOutdated / logout，那几处都会把它设回 false。
  let shouldRetry = token !== "";
  let controlAuthenticated = false;
  let errorSequence = 0;
  const sessionConsumers = new Map<string, Set<SessionConsumer>>();
  // 中心离线期间已在本机 stop、但还没能删除的 catalog task；重连认证后补投（见 removeTask）。
  const pendingTaskRemovals = new Set<string>();
  // 有本地会话 token 时首屏直接进入 authenticating，避免刷新先闪登录页。
  const store: StoreApi<CofluxState> = createStore<CofluxState>(() => ({
    status: token ? "connecting" : "disconnected",
    authState: token ? "authenticating" : "need-login",
    loginError: "",
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

  // 版本失配 reload 防循环（plan 033）：一次性守卫（key 带 tokenStorageKey 命名空间，
  // 与 web/mobile 各自 token key 一致，避免同源双 app 互相踩）——首次 reload 拿新 bundle；
  // reload 后仍失配（如 index.html 被缓存）则不再 reload，改停止重连 + 提示强制刷新。
  const outdatedReloadKey = `${options.tokenStorageKey}_outdated_reloaded_for`;

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
    origin: options.deviceTransport.origin ?? location.origin,
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
    onStatus: (status) => {
      store.setState({ status });
      if (status !== "connected") {
        controlAuthenticated = false;
        deviceRouter.setControlOnline(false);
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
        store.setState({ authState: "authed", loginError: "" });
        shouldRetry = true;
        connection.resetBackoff();
        if (value.clientToken) {
          token = value.clientToken;
          localStorage.setItem(options.tokenStorageKey, value.clientToken);
        }
        send({ case: "clientSubscribe", value: {} });
        flushPendingTaskRemovals();
        break;
      }
      case "authError": {
        controlAuthenticated = false;
        deviceRouter.setControlOnline(false);
        token = "";
        localStorage.removeItem(options.tokenStorageKey);
        store.setState({
          loginError: "登录失败：用户名或密码错误",
          authState: "auth-failed",
        });
        shouldRetry = false;
        break;
      }
      case "clientOutdated": {
        controlAuthenticated = false;
        deviceRouter.setControlOnline(false);
        // server 判定本连接的构建版本失配（plan 033）：token 不清（无感升级），只判断是否已为
        // 当前 buildId reload 过，避免 index.html 被缓存导致 reload 后仍失配的无限刷新循环。
        if (sessionStorage.getItem(outdatedReloadKey) !== options.buildId) {
          sessionStorage.setItem(outdatedReloadKey, options.buildId);
          location.reload();
        } else {
          // reload 后仍失配（如 index.html 被缓存）：停止重连，进入专用状态页（非认证失败，
          // 不设 loginError——auth-failed 展示面语义是"账号/密码错了"，混用会误导用户）。
          shouldRetry = false;
          store.setState({ authState: "outdated" });
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
            };
          }
          return { sessionAgents };
        });
        break;
      }
      case "error": {
        errorSequence += 1;
        store.setState({ lastError: { id: errorSequence, message: payload.value.message } });
        break;
      }
      default:
        break;
    }
  }

  function connect(credential: AuthCredential) {
    // 重连/重登时若已 authed 则保持：断线期间保留最后快照渲染，由顶部横幅提示，不整页退回 loading。
    if (store.getState().authState !== "authed") store.setState({ authState: "authenticating" });
    controlAuthenticated = false;
    deviceRouter.setControlOnline(false);
    connection.connect(credential);
  }

  async function login(username: string, password: string) {
    store.setState({ loginError: "" });
    connect({ username, password });
  }

  function logout() {
    shouldRetry = false;
    controlAuthenticated = false;
    pendingTaskRemovals.clear();
    void deviceRouter.reset(true);
    send({ case: "clientLogout", value: {} });
    token = "";
    localStorage.removeItem(options.tokenStorageKey);
    connection.stop();
    store.setState({
      authState: "need-login",
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

  if (token) connection.connect({ token });

  function disconnect() {
    controlAuthenticated = false;
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
    sendFsWrite,
    reportLocalError,
    disconnect,
  };
}

export type CofluxClient = ReturnType<typeof createCofluxClient>;
