import { useCallback, useEffect, useRef, useState } from "react";
import {
  create,
  encodeClientToServer,
  decodeServerToClient,
  ClientToServerSchema,
  TaskStatus,
  type ClientToServerPayload,
  type DaemonInfo,
  type Project,
  type Task,
  type Workspace,
} from "@coflux/protocol";

import { SERVER_URL, TOKEN_KEY, USE_SUPABASE, type AuthCredential } from "@/config";
import { loginWithSupabase } from "@/lib/auth";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
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

export function useCofluxClient() {
  const wsRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef("");
  const stopReconnectRef = useRef(false);
  const shouldRetryRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const messageHandlerRef = useRef<(payload: NonNullable<ReturnType<typeof decodeServerToClient>>["payload"]) => void>(() => undefined);
  const connectRef = useRef<(credential: AuthCredential) => void>(() => undefined);
  const sessionConsumersRef = useRef(new Map<string, Set<SessionConsumer>>());
  const errorSequenceRef = useRef(0);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  // 有本地会话 token 时首屏直接进入 authenticating，避免刷新先闪登录页。
  const [authState, setAuthState] = useState<AuthState>(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) {
      tokenRef.current = savedToken;
      return "authenticating";
    }
    return "need-login";
  });
  const [loginError, setLoginError] = useState("");
  const [daemons, setDaemons] = useState<DaemonInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ports, setPorts] = useState<Record<string, PortPreview[]>>({});
  const [detachedTaskIds, setDetachedTaskIds] = useState<Set<string>>(() => new Set());
  const [enrollCommand, setEnrollCommand] = useState<string | null>(null);
  const [lastError, setLastError] = useState<ClientError | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState(0);

  const send = useCallback((payload: ClientToServerPayload) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
  }, []);

  const sendInput = useCallback(
    (sessionId: string, data: string) => {
      send({ case: "ptyInput", value: { sessionId, data: new TextEncoder().encode(data) } });
    },
    [send],
  );

  const registerSessionConsumer = useCallback((sessionId: string, consumer: SessionConsumer) => {
    let consumers = sessionConsumersRef.current.get(sessionId);
    if (!consumers) {
      consumers = new Set();
      sessionConsumersRef.current.set(sessionId, consumers);
    }
    consumers.add(consumer);
    return () => {
      const current = sessionConsumersRef.current.get(sessionId);
      if (!current) return;
      current.delete(consumer);
      if (current.size === 0) sessionConsumersRef.current.delete(sessionId);
    };
  }, []);

  const connect = useCallback((credential: AuthCredential) => {
    stopReconnectRef.current = false;
    setAuthState("authenticating");
    setStatus("connecting");
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const socket = new WebSocket(SERVER_URL);
    socket.binaryType = "arraybuffer";
    wsRef.current = socket;

    socket.onopen = () => {
      if (wsRef.current !== socket) return;
      setStatus("connected");
      const payload: ClientToServerPayload =
        "token" in credential
          ? { case: "clientAuth", value: { clientToken: credential.token } }
          : "supabaseToken" in credential
            ? { case: "clientAuth", value: { supabaseToken: credential.supabaseToken } }
            : { case: "clientAuth", value: { username: credential.username, password: credential.password } };
      socket.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
    };

    socket.onclose = () => {
      if (wsRef.current !== socket) return;
      setStatus("disconnected");
      if (!stopReconnectRef.current && shouldRetryRef.current && tokenRef.current) {
        reconnectTimerRef.current = window.setTimeout(() => connectRef.current({ token: tokenRef.current }), 1500);
      }
    };

    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return; // 全 binary 协议：非二进制帧一律忽略
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      messageHandlerRef.current(message.payload);
    };
  }, []);
  connectRef.current = connect;

  const handleServerMessage = useCallback(
    (payload: NonNullable<ReturnType<typeof decodeServerToClient>>["payload"]) => {
      switch (payload.case) {
        case "authOk": {
          const value = payload.value;
          setAuthState("authed");
          setLoginError("");
          shouldRetryRef.current = true;
          if (value.clientToken) {
            tokenRef.current = value.clientToken;
            localStorage.setItem(TOKEN_KEY, value.clientToken);
          }
          send({ case: "clientSubscribe", value: {} });
          break;
        }
        case "authError": {
          tokenRef.current = "";
          localStorage.removeItem(TOKEN_KEY);
          setLoginError(USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误");
          setAuthState("auth-failed");
          shouldRetryRef.current = false;
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
          setPorts((previous) => ({ ...previous, [value.taskId]: value.ports.map((preview) => ({ port: preview.port, url: preview.url })) }));
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
          const value = payload.value;
          const consumers = sessionConsumersRef.current.get(value.sessionId);
          if (consumers) for (const consumer of consumers) consumer(value.data);
          break;
        }
        case "error": {
          errorSequenceRef.current += 1;
          setLastError({ id: errorSequenceRef.current, message: payload.value.message });
          break;
        }
        default:
          break;
      }
    },
    [send],
  );
  messageHandlerRef.current = handleServerMessage;

  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) {
      tokenRef.current = savedToken;
      connectRef.current({ token: savedToken });
    } else {
      setStatus("disconnected");
    }

    return () => {
      stopReconnectRef.current = true;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      sessionConsumersRef.current.clear();
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setLoginError("");
    if (!USE_SUPABASE) {
      connectRef.current({ username, password });
      return;
    }

    setAuthState("authenticating");
    const result = await loginWithSupabase(username, password);
    if (!result.ok) {
      setLoginError(result.message);
      setAuthState("auth-failed");
      return;
    }
    connectRef.current({ supabaseToken: result.accessToken });
  }, []);

  const logout = useCallback(() => {
    stopReconnectRef.current = true;
    shouldRetryRef.current = false;
    if (wsRef.current?.readyState === WebSocket.OPEN) send({ case: "clientLogout", value: {} });
    tokenRef.current = "";
    localStorage.removeItem(TOKEN_KEY);
    wsRef.current?.close();
    setAuthState("need-login");
    setDaemons([]);
    setProjects([]);
    setWorkspaces([]);
    setTasks([]);
    setPorts({});
    setDetachedTaskIds(new Set());
    setEnrollCommand(null);
  }, [send]);

  const startTask = useCallback(
    (taskId: string, cols: number, rows: number) => {
      setDetachedTaskIds((previous) => withoutSetValue(previous, taskId));
      send({ case: "taskStart", value: { taskId, cols, rows } });
    },
    [send],
  );

  const requestEnrollmentKey = useCallback(() => {
    setEnrollCommand(null);
    send({ case: "clientCreateEnrollmentKey", value: {} });
  }, [send]);

  const clearEnrollmentCommand = useCallback(() => setEnrollCommand(null), []);

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

export type CofluxClient = ReturnType<typeof useCofluxClient>;
