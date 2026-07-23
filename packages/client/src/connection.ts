import {
  create,
  encodeClientToServer,
  decodeServerToClient,
  ClientToServerSchema,
  type ClientToServerPayload,
  type ServerToClient,
} from "@coflux/protocol";

export type AuthCredential =
  | { token: string }
  | { supabaseToken: string }
  | { username: string; password: string };

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type ServerPayload = ServerToClient["payload"];

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

type ConnectionOptions = {
  url: string;
  /** 构建版本（git short SHA；vite dev 固定 "dev"）：随每次认证上报，供 server 做版本准入（plan 033）。 */
  buildId: string;
  onStatus: (status: ConnectionStatus) => void;
  onMessage: (payload: ServerPayload) => void;
  /** 返回 null 表示当前不应自动重连（未登录 / 已登出 / 认证失败）。 */
  reconnectCredential: () => AuthCredential | null;
};

export function buildAuthPayload(credential: AuthCredential, buildId: string): ClientToServerPayload {
  return "token" in credential
    ? { case: "clientAuth", value: { clientToken: credential.token, clientVersion: buildId } }
    : "supabaseToken" in credential
      ? { case: "clientAuth", value: { supabaseToken: credential.supabaseToken, clientVersion: buildId } }
      : { case: "clientAuth", value: { username: credential.username, password: credential.password, clientVersion: buildId } };
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

    // 换新连接前先关旧的：否则旧 socket 对象只是被覆盖引用丢弃，底层 WS 在 server 侧继续
    // 存活为只收不发的幽灵连接（不会自动因失去 JS 引用而关闭）。
    socket?.close();

    const ws = new WebSocket(options.url);
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      options.onStatus("connected");
      ws.send(encodeClientToServer(create(ClientToServerSchema, { payload: buildAuthPayload(credential, options.buildId) })));
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
