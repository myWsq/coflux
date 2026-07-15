import { batch, createSignal, onCleanup } from "solid-js";
import {
  TaskStatus,
  type ClientToServerPayload,
  type DaemonInfo,
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
type SessionConsumer = (data: Uint8Array) => void;

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
 * 主页面状态 store：signals 只承载控制面（实体集合 / 连接态 / 控制权态）。
 * PTY 数据流（ptyOutput）绝不进响应式状态——经 consumer 注册表直达 terminal.write。
 *
 * 须在组件（reactive owner）内创建：连接生命周期挂在 onCleanup 上。
 */
export function createCofluxClient() {
  let token = localStorage.getItem(TOKEN_KEY) ?? "";
  let shouldRetry = false;
  let errorSequence = 0;
  const sessionConsumers = new Map<string, Set<SessionConsumer>>();

  const [status, setStatus] = createSignal<ConnectionStatus>(token ? "connecting" : "disconnected");
  // 有本地会话 token 时首屏直接进入 authenticating，避免刷新先闪登录页。
  const [authState, setAuthState] = createSignal<AuthState>(token ? "authenticating" : "need-login");
  const [loginError, setLoginError] = createSignal("");
  const [daemons, setDaemons] = createSignal<DaemonInfo[]>([]);
  const [projects, setProjects] = createSignal<Project[]>([]);
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [ports, setPorts] = createSignal<Record<string, PortPreview[]>>({});
  const [detachedTaskIds, setDetachedTaskIds] = createSignal<Set<string>>(new Set());
  const [enrollCommand, setEnrollCommand] = createSignal<string | null>(null);
  const [lastError, setLastError] = createSignal<ClientError | null>(null);
  const [snapshotRevision, setSnapshotRevision] = createSignal(0);

  const connection = createConnection({
    url: SERVER_URL,
    onStatus: setStatus,
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
      consumers = new Set();
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
  // batch 让单条消息触发的多个 signal 更新原子提交，effect 只看到一致的最终状态。
  function handleServerMessage(payload: ServerPayload) {
    batch(() => {
      switch (payload.case) {
        case "authOk": {
          const value = payload.value;
          setAuthState("authed");
          setLoginError("");
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
          setLoginError(USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误");
          setAuthState("auth-failed");
          shouldRetry = false;
          break;
        }
        case "stateSnapshot": {
          const value = payload.value;
          setDaemons(value.daemons);
          setProjects(value.projects);
          setWorkspaces(value.workspaces);
          setTasks(value.tasks);
          const nextPorts: Record<string, PortPreview[]> = {};
          for (const group of value.ports) {
            nextPorts[group.taskId] = group.ports.map((preview) => ({ port: preview.port, url: preview.url }));
          }
          setPorts(nextPorts);
          const taskIds = new Set(value.tasks.map((task) => task.id));
          setDetachedTaskIds((previous) => new Set([...previous].filter((taskId) => taskIds.has(taskId))));
          setSnapshotRevision((v) => v + 1);
          break;
        }
        case "daemonUpdated": {
          const daemon = payload.value.daemon;
          if (!daemon) break; // 内嵌 message 字段在 protobuf-es 里始终是 T | undefined（显式 presence），服务端必填，这里按畸形消息丢弃
          setDaemons((previous) => upsert(previous, daemon, (item) => item.daemonId === daemon.daemonId));
          break;
        }
        case "daemonRemoved": {
          const value = payload.value;
          setDaemons((previous) => previous.filter((daemon) => daemon.daemonId !== value.daemonId));
          setProjects((previous) => previous.filter((project) => project.daemonId !== value.daemonId));
          setWorkspaces((previous) => previous.filter((workspace) => workspace.daemonId !== value.daemonId));
          setTasks((previous) => previous.filter((task) => task.daemonId !== value.daemonId));
          break;
        }
        case "projectCreated": {
          const project = payload.value.project;
          if (!project) break;
          setProjects((previous) => upsert(previous, project, (item) => item.id === project.id));
          break;
        }
        case "projectRemoved": {
          const value = payload.value;
          setProjects((previous) => previous.filter((project) => project.id !== value.projectId));
          setWorkspaces((previous) => previous.filter((workspace) => workspace.projectId !== value.projectId));
          setTasks((previous) => previous.filter((task) => task.projectId !== value.projectId));
          break;
        }
        case "workspaceCreated": {
          const workspace = payload.value.workspace;
          if (!workspace) break;
          setWorkspaces((previous) => upsert(previous, workspace, (item) => item.id === workspace.id));
          break;
        }
        case "workspaceRemoved": {
          const value = payload.value;
          setWorkspaces((previous) => previous.filter((workspace) => workspace.id !== value.workspaceId));
          setTasks((previous) => previous.filter((task) => task.workspaceId !== value.workspaceId));
          break;
        }
        case "taskUpdated": {
          const task = payload.value.task;
          if (!task) break;
          setTasks((previous) => upsert(previous, task, (item) => item.id === task.id));
          if (task.status !== TaskStatus.RUNNING) {
            setDetachedTaskIds((previous) => withoutSetValue(previous, task.id));
          }
          break;
        }
        case "taskRemoved": {
          const value = payload.value;
          setTasks((previous) => previous.filter((task) => task.id !== value.taskId));
          setPorts((previous) => {
            if (!(value.taskId in previous)) return previous;
            const next = { ...previous };
            delete next[value.taskId];
            return next;
          });
          setDetachedTaskIds((previous) => withoutSetValue(previous, value.taskId));
          break;
        }
        case "portsUpdated": {
          const value = payload.value;
          setPorts((previous) => ({
            ...previous,
            [value.taskId]: value.ports.map((preview) => ({ port: preview.port, url: preview.url })),
          }));
          break;
        }
        case "taskDetached": {
          const value = payload.value;
          setDetachedTaskIds((previous) => new Set(previous).add(value.taskId));
          break;
        }
        case "enrollmentKeyCreated": {
          const value = payload.value;
          setEnrollCommand(`npm i -g cofluxd && cofluxd up --server ${value.daemonUrl} --enroll-key ${value.enrollmentKey}`);
          break;
        }
        case "ptyOutput": {
          // PTY 数据零响应式开销：直达 consumer（terminal.write），不进任何 signal。
          const value = payload.value;
          const consumers = sessionConsumers.get(value.sessionId);
          if (consumers) for (const consumer of consumers) consumer(value.data);
          break;
        }
        case "error": {
          errorSequence += 1;
          setLastError({ id: errorSequence, message: payload.value.message });
          break;
        }
        default:
          break;
      }
    });
  }

  function connect(credential: AuthCredential) {
    // 重连/重登时若已 authed 则保持：断线期间保留最后快照渲染，由顶部横幅提示，不整页退回 loading。
    if (authState() !== "authed") setAuthState("authenticating");
    connection.connect(credential);
  }

  async function login(username: string, password: string) {
    setLoginError("");
    if (!USE_SUPABASE) {
      connect({ username, password });
      return;
    }

    setAuthState("authenticating");
    const result = await loginWithSupabase(username, password);
    if (!result.ok) {
      setLoginError(result.message);
      setAuthState("auth-failed");
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
    batch(() => {
      setAuthState("need-login");
      setDaemons([]);
      setProjects([]);
      setWorkspaces([]);
      setTasks([]);
      setPorts({});
      setDetachedTaskIds(new Set());
      setEnrollCommand(null);
    });
  }

  // attach 即 taskStart：对 RUNNING 任务发 taskStart 就是申请接管（server 端 startOrAttachTask 复用语义）。
  function startTask(taskId: string, cols: number, rows: number) {
    setDetachedTaskIds((previous) => withoutSetValue(previous, taskId));
    send({ case: "taskStart", value: { taskId, cols, rows } });
  }

  function requestEnrollmentKey() {
    setEnrollCommand(null);
    send({ case: "clientCreateEnrollmentKey", value: {} });
  }

  function clearEnrollmentCommand() {
    setEnrollCommand(null);
  }

  if (token) connection.connect({ token });

  onCleanup(() => {
    connection.stop();
    sessionConsumers.clear();
  });

  return {
    status,
    authState,
    loginError,
    daemons,
    projects,
    workspaces,
    tasks,
    ports,
    detachedTaskIds,
    enrollCommand,
    lastError,
    snapshotRevision,
    login,
    logout,
    send,
    sendInput,
    startTask,
    registerSessionConsumer,
    requestEnrollmentKey,
    clearEnrollmentCommand,
  };
}

export type CofluxClient = ReturnType<typeof createCofluxClient>;
