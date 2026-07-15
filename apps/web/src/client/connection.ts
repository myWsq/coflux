import {
  create,
  encodeClientToServer,
  decodeServerToClient,
  ClientToServerSchema,
  type ClientToServerPayload,
  type ServerToClient,
} from "@coflux/protocol";

import type { AuthCredential } from "@/config";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type ServerPayload = ServerToClient["payload"];

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

type ConnectionOptions = {
  url: string;
  onStatus: (status: ConnectionStatus) => void;
  onMessage: (payload: ServerPayload) => void;
  /** 返回 null 表示当前不应自动重连（未登录 / 已登出 / 认证失败）。 */
  reconnectCredential: () => AuthCredential | null;
};

export function buildAuthPayload(credential: AuthCredential): ClientToServerPayload {
  return "token" in credential
    ? { case: "clientAuth", value: { clientToken: credential.token } }
    : "supabaseToken" in credential
      ? { case: "clientAuth", value: { supabaseToken: credential.supabaseToken } }
      : { case: "clientAuth", value: { username: credential.username, password: credential.password } };
}

/**
 * /client 链路的 WS 连接管理：认证包发送、二进制信封解码、指数退避重连。
 * 纯命令式实现，不依赖任何 UI 框架——响应式状态由上层 store 通过回调自行维护。
 */
export function createConnection(options: ConnectionOptions) {
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempts = 0;
  let reconnectTimer: number | null = null;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    if (!options.reconnectCredential()) return;
    // 指数退避 + 抖动：~1s 起步、~15s 封顶，避免服务端恢复瞬间的重连风暴。
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    attempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      const credential = options.reconnectCredential();
      if (!stopped && credential) connect(credential);
    }, delay);
  }

  function connect(credential: AuthCredential) {
    stopped = false;
    clearReconnectTimer();
    options.onStatus("connecting");

    const ws = new WebSocket(options.url);
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      options.onStatus("connected");
      ws.send(encodeClientToServer(create(ClientToServerSchema, { payload: buildAuthPayload(credential) })));
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      options.onStatus("disconnected");
      scheduleReconnect();
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      if (!(event.data instanceof ArrayBuffer)) return; // 全 binary 协议：非二进制帧一律忽略
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      options.onMessage(message.payload);
    };
  }

  function send(payload: ClientToServerPayload) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
    }
  }

  return {
    connect,
    send,
    /** 认证成功后调用：重置退避序列，下次断线从 ~1s 重来。 */
    resetBackoff() {
      attempts = 0;
    },
    /** 停止自动重连并关闭当前连接（登出 / 组件卸载）。 */
    stop() {
      stopped = true;
      clearReconnectTimer();
      socket?.close();
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;
