import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeFrame,
  encodeFrame,
  type ClientToServer,
  type DaemonInfo,
  type Project,
  type ServerToClient,
  type Task,
  type Workspace,
} from "@coflux/protocol";

import { SERVER_URL, TOKEN_KEY, USE_SUPABASE, type AuthCredential } from "@/config";
import { loginWithSupabase } from "@/lib/auth";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type AuthState = "need-login" | "authenticating" | "authed" | "auth-failed";
export type PortPreview = { port: number; url: string };
export type ClientError = { id: number; message: string };
type SessionConsumer = (data: string) => void;

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
  const messageHandlerRef = useRef<(message: ServerToClient) => void>(() => undefined);
  const connectRef = useRef<(credential: AuthCredential) => void>(() => undefined);
  const sessionConsumersRef = useRef(new Map<string, Set<SessionConsumer>>());
  const errorSequenceRef = useRef(0);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [authState, setAuthState] = useState<AuthState>("need-login");
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

  const send = useCallback((message: ClientToServer) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const sendInput = useCallback((sessionId: string, data: string) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(encodeFrame({ type: "pty.input", sessionId, data }));
    }
  }, []);

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
      const message: ClientToServer =
        "token" in credential
          ? { type: "client.auth", clientToken: credential.token }
          : "supabaseToken" in credential
            ? { type: "client.auth", supabaseToken: credential.supabaseToken }
            : { type: "client.auth", username: credential.username, password: credential.password };
      socket.send(JSON.stringify(message));
    };

    socket.onclose = () => {
      if (wsRef.current !== socket) return;
      setStatus("disconnected");
      if (!stopReconnectRef.current && shouldRetryRef.current && tokenRef.current) {
        reconnectTimerRef.current = window.setTimeout(() => connectRef.current({ token: tokenRef.current }), 1500);
      }
    };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = decodeFrame(new Uint8Array(event.data));
        if (frame?.type === "pty.output") {
          const consumers = sessionConsumersRef.current.get(frame.sessionId);
          if (consumers) for (const consumer of consumers) consumer(frame.data);
        }
        return;
      }

      let message: ServerToClient;
      try {
        message = JSON.parse(event.data) as ServerToClient;
      } catch {
        return;
      }
      messageHandlerRef.current(message);
    };
  }, []);
  connectRef.current = connect;

  const handleServerMessage = useCallback(
    (message: ServerToClient) => {
      switch (message.type) {
        case "auth.ok":
          setAuthState("authed");
          setLoginError("");
          shouldRetryRef.current = true;
          if (message.clientToken) {
            tokenRef.current = message.clientToken;
            localStorage.setItem(TOKEN_KEY, message.clientToken);
          }
          send({ type: "client.subscribe" });
          break;
        case "auth.error":
          tokenRef.current = "";
          localStorage.removeItem(TOKEN_KEY);
          setLoginError(USE_SUPABASE ? "登录失败：会话已过期或凭证无效，请重新登录" : "登录失败：用户名或密码错误");
          setAuthState("auth-failed");
          shouldRetryRef.current = false;
          break;
        case "state.snapshot": {
          setDaemons(message.daemons);
          setProjects(message.projects);
          setWorkspaces(message.workspaces);
          setTasks(message.tasks);
          const nextPorts: Record<string, PortPreview[]> = {};
          for (const preview of message.ports ?? []) {
            (nextPorts[preview.taskId] ??= []).push({ port: preview.port, url: preview.url });
          }
          setPorts(nextPorts);
          const taskIds = new Set(message.tasks.map((task) => task.id));
          setDetachedTaskIds((previous) => new Set([...previous].filter((taskId) => taskIds.has(taskId))));
          setSnapshotRevision((value) => value + 1);
          break;
        }
        case "daemon.updated":
          setDaemons((previous) => upsert(previous, message.daemon, (daemon) => daemon.daemonId === message.daemon.daemonId));
          break;
        case "daemon.removed":
          setDaemons((previous) => previous.filter((daemon) => daemon.daemonId !== message.daemonId));
          setProjects((previous) => previous.filter((project) => project.daemonId !== message.daemonId));
          setWorkspaces((previous) => previous.filter((workspace) => workspace.daemonId !== message.daemonId));
          setTasks((previous) => previous.filter((task) => task.daemonId !== message.daemonId));
          break;
        case "project.created":
          setProjects((previous) => upsert(previous, message.project, (project) => project.id === message.project.id));
          break;
        case "project.removed":
          setProjects((previous) => previous.filter((project) => project.id !== message.projectId));
          setWorkspaces((previous) => previous.filter((workspace) => workspace.projectId !== message.projectId));
          setTasks((previous) => previous.filter((task) => task.projectId !== message.projectId));
          break;
        case "workspace.created":
          setWorkspaces((previous) => upsert(previous, message.workspace, (workspace) => workspace.id === message.workspace.id));
          break;
        case "workspace.removed":
          setWorkspaces((previous) => previous.filter((workspace) => workspace.id !== message.workspaceId));
          setTasks((previous) => previous.filter((task) => task.workspaceId !== message.workspaceId));
          break;
        case "task.updated":
          setTasks((previous) => upsert(previous, message.task, (task) => task.id === message.task.id));
          if (message.task.status !== "running") {
            setDetachedTaskIds((previous) => withoutSetValue(previous, message.task.id));
          }
          break;
        case "task.removed":
          setTasks((previous) => previous.filter((task) => task.id !== message.taskId));
          setPorts((previous) => {
            if (!(message.taskId in previous)) return previous;
            const next = { ...previous };
            delete next[message.taskId];
            return next;
          });
          setDetachedTaskIds((previous) => withoutSetValue(previous, message.taskId));
          break;
        case "ports.updated":
          setPorts((previous) => ({ ...previous, [message.taskId]: message.ports }));
          break;
        case "task.detached":
          setDetachedTaskIds((previous) => new Set(previous).add(message.taskId));
          break;
        case "enrollmentKey.created":
          setEnrollCommand(`npm i -g cofluxd && cofluxd up --server ${message.daemonUrl} --enroll-key ${message.enrollmentKey}`);
          break;
        case "error":
          errorSequenceRef.current += 1;
          setLastError({ id: errorSequenceRef.current, message: message.message });
          break;
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
    if (wsRef.current?.readyState === WebSocket.OPEN) send({ type: "client.logout" });
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
      send({ type: "task.start", taskId, cols, rows });
    },
    [send],
  );

  const requestEnrollmentKey = useCallback(() => {
    setEnrollCommand(null);
    send({ type: "client.createEnrollmentKey" });
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
