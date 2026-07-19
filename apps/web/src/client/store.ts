import { createStore, type StoreApi } from "zustand/vanilla";
import {
  TaskStatus,
  type ClientToServerPayload,
  type DaemonInfo,
  type FsEntry,
  type Project,
  type Task,
  type Workspace,
} from "@coflux/protocol";

import { SERVER_URL, TOKEN_KEY, USE_SUPABASE, type AuthCredential } from "@/config";
import { loginWithSupabase } from "@/lib/auth";
import { createConnection, type ConnectionStatus, type ServerPayload } from "@/client/connection";

export type { ConnectionStatus } from "@/client/connection";
export type AuthState = "need-login" | "authenticating" | "authed" | "auth-failed";
export type PortPreview = { port: number; url: string };
export type ClientError = { id: number; message: string };
export type FsListResult = { ok: boolean; entries: FsEntry[]; error: string; path?: string };
export type ExecResult = { ok: boolean; exitCode: number; stdout: string; stderr: string; error: string };
export type FsWriteResult = { ok: boolean; path?: string; error: string };
type SessionConsumer = (data: Uint8Array) => void;

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
  enrollCommand: string | null;
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
 * 须在顶层页面组件内只创建一次（如 useState(() => createCofluxClient())[0]）：
 * 连接生命周期需要与调用方显式配对 disconnect()。
 */
export function createCofluxClient() {
  let token = localStorage.getItem(TOKEN_KEY) ?? "";
  let shouldRetry = false;
  let errorSequence = 0;
  const sessionConsumers = new Map<string, Set<SessionConsumer>>();
  // fsList 请求-响应关联（一次性数据不进 store）：requestId → resolve。
  // 超时由 server 中继兜底（超时回 ok:false）；断线时本地统一 reject 清空。
  const pendingFsLists = new Map<string, (result: FsListResult) => void>();
  const pendingExecs = new Map<string, (result: ExecResult) => void>();
  // 终端剪贴板贴图（plan 014）：requestId → resolve，同一 pending-map 模式。
  const pendingFsWrites = new Map<string, (result: FsWriteResult) => void>();

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
    enrollCommand: null,
    lastError: null,
    snapshotRevision: 0,
  }));

  const connection = createConnection({
    url: SERVER_URL,
    onStatus: (status) => {
      store.setState({ status });
      // 断线时 in-flight 的 fsList 无法再收到响应，统一以失败结清避免调用方悬挂。
      if (status !== "connected" && pendingFsLists.size > 0) {
        const pending = [...pendingFsLists.values()];
        pendingFsLists.clear();
        for (const resolve of pending) resolve({ ok: false, entries: [], error: "连接已断开", path: undefined });
      }
      if (status !== "connected" && pendingExecs.size > 0) {
        const pending = [...pendingExecs.values()];
        pendingExecs.clear();
        for (const resolve of pending) resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", error: "连接已断开" });
      }
      if (status !== "connected" && pendingFsWrites.size > 0) {
        const pending = [...pendingFsWrites.values()];
        pendingFsWrites.clear();
        for (const resolve of pending) resolve({ ok: false, error: "连接已断开" });
      }
    },
    onMessage: handleServerMessage,
    reconnectCredential: () => (shouldRetry && token ? { token } : null),
  });

  function send(payload: ClientToServerPayload) {
    connection.send(payload);
  }

  function sendInput(sessionId: string, data: string) {
    send({ case: "ptyInput", value: { sessionId, data: new TextEncoder().encode(data) } });
  }

  function registerSessionConsumer(sessionId: string, consumer: SessionConsumer) {
    let consumers = sessionConsumers.get(sessionId);
    if (!consumers) {
      consumers = new Set<SessionConsumer>();
      sessionConsumers.set(sessionId, consumers);
    }
    consumers.add(consumer);
    return () => {
      const current = sessionConsumers.get(sessionId);
      if (!current) return;
      current.delete(consumer);
      if (current.size === 0) sessionConsumers.delete(sessionId);
    };
  }

  // 快照/增量按到达顺序应用（server 保证 stateSnapshot 先于其后的广播），不做乱序缓冲。
  // 每条消息只调用一次 store.setState：天然原子提交，订阅者只看到一致的最终状态
  // （不依赖 React 批处理细节，比 Solid 版的 batch(...) 包裹更直接）。
  function handleServerMessage(payload: ServerPayload) {
    switch (payload.case) {
      case "authOk": {
        const value = payload.value;
        store.setState({ authState: "authed", loginError: "" });
        shouldRetry = true;
        connection.resetBackoff();
        if (value.clientToken) {
          token = value.clientToken;
          localStorage.setItem(TOKEN_KEY, value.clientToken);
        }
        send({ case: "clientSubscribe", value: {} });
        break;
      }
      case "authError": {
        token = "";
        localStorage.removeItem(TOKEN_KEY);
        store.setState({
          loginError: USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误",
          authState: "auth-failed",
        });
        shouldRetry = false;
        break;
      }
      case "stateSnapshot": {
        const value = payload.value;
        const nextPorts: Record<string, PortPreview[]> = {};
        for (const group of value.ports) {
          nextPorts[group.taskId] = group.ports.map((preview) => ({ port: preview.port, url: preview.url }));
        }
        const taskIds = new Set(value.tasks.map((task) => task.id));
        store.setState((state) => ({
          daemons: value.daemons,
          projects: value.projects,
          workspaces: value.workspaces,
          tasks: value.tasks,
          ports: nextPorts,
          detachedTaskIds: new Set([...state.detachedTaskIds].filter((taskId) => taskIds.has(taskId))),
          snapshotRevision: state.snapshotRevision + 1,
        }));
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
        const task = payload.value.task;
        if (!task) break;
        store.setState((state) => ({
          tasks: upsert(state.tasks, task, (item) => item.id === task.id),
          detachedTaskIds: task.status !== TaskStatus.RUNNING ? withoutSetValue(state.detachedTaskIds, task.id) : state.detachedTaskIds,
        }));
        break;
      }
      case "taskRemoved": {
        const value = payload.value;
        store.setState((state) => {
          let ports = state.ports;
          if (value.taskId in ports) {
            ports = { ...ports };
            delete ports[value.taskId];
          }
          return {
            tasks: state.tasks.filter((task) => task.id !== value.taskId),
            ports,
            detachedTaskIds: withoutSetValue(state.detachedTaskIds, value.taskId),
          };
        });
        break;
      }
      case "portsUpdated": {
        const value = payload.value;
        store.setState((state) => ({
          ports: { ...state.ports, [value.taskId]: value.ports.map((preview) => ({ port: preview.port, url: preview.url })) },
        }));
        break;
      }
      case "taskDetached": {
        const value = payload.value;
        store.setState((state) => ({ detachedTaskIds: new Set(state.detachedTaskIds).add(value.taskId) }));
        break;
      }
      case "enrollmentKeyCreated": {
        const value = payload.value;
        store.setState({ enrollCommand: `npm i -g cofluxd && cofluxd up --server ${value.daemonUrl} --enroll-key ${value.enrollmentKey}` });
        break;
      }
      case "ptyOutput": {
        // PTY 数据零响应式开销：直达 consumer（terminal.write），不进 store。
        const value = payload.value;
        const consumers = sessionConsumers.get(value.sessionId);
        if (consumers) for (const consumer of consumers) consumer(value.data);
        break;
      }
      case "fsListed": {
        const value = payload.value;
        const resolve = pendingFsLists.get(value.requestId);
        if (resolve) {
          pendingFsLists.delete(value.requestId);
          resolve({ ok: value.ok, entries: value.entries, error: value.error ?? "", path: value.path });
        }
        break;
      }
      case "execResult": {
        const value = payload.value;
        const resolve = pendingExecs.get(value.requestId);
        if (resolve) {
          pendingExecs.delete(value.requestId);
          resolve({ ok: value.ok, exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr, error: value.error ?? "" });
        }
        break;
      }
      case "fsWriteResult": {
        const value = payload.value;
        const resolve = pendingFsWrites.get(value.requestId);
        if (resolve) {
          pendingFsWrites.delete(value.requestId);
          resolve({ ok: value.ok, path: value.path, error: value.error ?? "" });
        }
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
    connection.connect(credential);
  }

  async function login(username: string, password: string) {
    store.setState({ loginError: "" });
    if (!USE_SUPABASE) {
      connect({ username, password });
      return;
    }

    store.setState({ authState: "authenticating" });
    const result = await loginWithSupabase(username, password);
    if (!result.ok) {
      store.setState({ loginError: result.message, authState: "auth-failed" });
      return;
    }
    connect({ supabaseToken: result.accessToken });
  }

  function logout() {
    shouldRetry = false;
    send({ case: "clientLogout", value: {} });
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    connection.stop();
    store.setState({
      authState: "need-login",
      daemons: [],
      projects: [],
      workspaces: [],
      tasks: [],
      ports: {},
      detachedTaskIds: new Set<string>(),
      enrollCommand: null,
    });
  }

  // attach 即 taskStart：对 RUNNING 任务发 taskStart 就是申请接管（server 端 startOrAttachTask 复用语义）。
  function startTask(taskId: string, cols: number, rows: number) {
    store.setState((state) => ({ detachedTaskIds: withoutSetValue(state.detachedTaskIds, taskId) }));
    send({ case: "taskStart", value: { taskId, cols, rows } });
  }

  /** 设备浏览模式列目录（导入向导）：以设备用户 home 为根，path 为相对路径（"" = home 本身）。 */
  function listDeviceDirectory(daemonId: string, path: string): Promise<FsListResult> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      pendingFsLists.set(requestId, resolve);
      send({ case: "clientFsList", value: { requestId, workspaceId: "", path, daemonId } });
    });
  }

  function execInWorkspace(workspaceId: string, command: string, args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      pendingExecs.set(requestId, resolve);
      send({ case: "clientExec", value: { requestId, workspaceId, command, args } });
    });
  }

  /** 终端剪贴板贴图（plan 014，temp 模式修订）：把图片字节上传落盘。
   * temp=true（终端贴图固定用法）：path 须为单段文件名，落到 daemon 侧系统临时目录，
   * 成功时 path 回带该处的绝对路径。temp=false：path 为该工作区 worktree 内相对路径，
   * 成功时 path 回带清洗过的相对路径。两种情况均以回带的 path 为准，不自行拼装。 */
  function sendFsWrite(workspaceId: string, path: string, data: Uint8Array, temp: boolean): Promise<FsWriteResult> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      pendingFsWrites.set(requestId, resolve);
      send({ case: "clientFsWrite", value: { requestId, workspaceId, path, data, temp } });
    });
  }

  /** 本地失败（exec/checkout 等非服务端错误）汇入同一个全局错误提示通道 */
  function reportLocalError(message: string) {
    errorSequence += 1;
    store.setState({ lastError: { id: errorSequence, message } });
  }

  function requestEnrollmentKey() {
    store.setState({ enrollCommand: null });
    send({ case: "clientCreateEnrollmentKey", value: {} });
  }

  function clearEnrollmentCommand() {
    store.setState({ enrollCommand: null });
  }

  if (token) connection.connect({ token });

  function disconnect() {
    connection.stop();
    sessionConsumers.clear();
    const pending = [...pendingFsLists.values()];
    pendingFsLists.clear();
    for (const resolve of pending) resolve({ ok: false, entries: [], error: "连接已断开", path: undefined });
    const pendingExec = [...pendingExecs.values()];
    pendingExecs.clear();
    for (const resolve of pendingExec) resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", error: "连接已断开" });
    const pendingWrite = [...pendingFsWrites.values()];
    pendingFsWrites.clear();
    for (const resolve of pendingWrite) resolve({ ok: false, error: "连接已断开" });
  }

  return {
    store,
    login,
    logout,
    send,
    sendInput,
    startTask,
    registerSessionConsumer,
    listDeviceDirectory,
    execInWorkspace,
    sendFsWrite,
    reportLocalError,
    requestEnrollmentKey,
    clearEnrollmentCommand,
    disconnect,
  };
}

export type CofluxClient = ReturnType<typeof createCofluxClient>;
