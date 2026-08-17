import {
  create,
  encodeClientToServer,
  decodeServerToClient,
  ClientToServerSchema,
  type ClientToServerPayload,
  type ServerToClient,
} from "@coflux/protocol";

export type AuthCredential = { token: string } | { username: string; password: string };

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type ServerPayload = ServerToClient["payload"];

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/** 静默链路自愈（见 createConnection 内 watchdog 注释）：发出消息后多久没等到任何入站帧就判死。
 * 取值要大于最慢的一次正常往返（跨洲 relay + daemon 侧落盘），又要短到用户不会先去刷新页面。 */
const SILENT_RESPONSE_TIMEOUT_MS = 10_000;
/** 看门狗扫描粒度：判死延迟最多因此多出一格，10s 判据下足够细。 */
const WATCHDOG_TICK_MS = 2_000;

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
  // 静默链路看门狗：见 armWatchdog 处的注释。null = 当前没有在等任何回音。
  let awaitingSince: number | null = null;
  let watchdogTimer: number | null = null;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * 静默链路自愈（2026-08-17 生产事故）：公司网络/中间代理会静默丢弃长连接——不发 FIN 也不发
   * RST，两端的 TCP 都还是 ESTABLISHED。于是 `ws.onclose` 永不触发、`readyState` 恒为 OPEN，
   * `send()` 把消息写进黑洞而不报错，用户侧表现为"界面正常、点什么都没反应"，且**永远不会自愈**
   * （重连只由 onclose 驱动）。daemon 侧早在 plan 033 就补过对等机制（idle 主动发 WS Ping），
   * 但浏览器不能发 WS 控制帧，只能在应用层找判据。
   *
   * 判据取"发出消息后是否还有任何入站帧"而非定期心跳：链路正常时，任何一次 client→server 的
   * 操作都会在几秒内引来入站流量（广播 / error / checkpoint）；链路静默死亡时则是彻底的寂静。
   * 这样既不需要服务端配合加心跳消息，也不会在页面空闲（本就无收发）时误判。
   * 判死后**主动 close()** —— 等 onclose 正是这次故障里等不到的东西。
   */
  function armWatchdog() {
    if (awaitingSince !== null || watchdogTimer !== null) return;
    awaitingSince = Date.now();
    watchdogTimer = window.setInterval(() => {
      if (awaitingSince === null || Date.now() - awaitingSince < SILENT_RESPONSE_TIMEOUT_MS) return;
      disarmWatchdog();
      const dying = socket;
      if (!dying) return;
      // 先摘引用再 close：close() 可能同步触发 onclose，届时 socket !== ws 的守卫会吃掉它，
      // 所以这里显式驱动一次重连，避免"关了但没人重连"。
      socket = null;
      options.onStatus("disconnected");
      try {
        dying.close();
      } catch {
        /* 已经死的 socket，close 本身失败也无所谓 */
      }
      scheduleReconnect();
    }, WATCHDOG_TICK_MS);
  }

  function disarmWatchdog() {
    awaitingSince = null;
    if (watchdogTimer !== null) {
      window.clearInterval(watchdogTimer);
      watchdogTimer = null;
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
    disarmWatchdog();
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
      // 认证包也纳入看门狗：链路若在握手后立刻被掐，认证回执同样石沉大海——这正是
      // "刷新后能用一会儿又不行"里下一轮的起点，必须让它自己重连而不是靠用户再刷新。
      armWatchdog();
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      disarmWatchdog();
      options.onStatus("disconnected");
      scheduleReconnect();
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      // 任何入站帧都证明链路活着（哪怕是本次解不出来的畸形帧），故先解除看门狗再解码。
      disarmWatchdog();
      if (!(event.data instanceof ArrayBuffer)) return; // 全 binary 协议：非二进制帧一律忽略
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      options.onMessage(message.payload);
    };
  }

  function send(payload: ClientToServerPayload) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
      // readyState 在静默死亡的链路上恒为 OPEN，send 也不会抛——所以发完必须开始等回音。
      armWatchdog();
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
      disarmWatchdog();
      socket?.close();
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;
