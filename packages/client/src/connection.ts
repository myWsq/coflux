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
/** 静默链路判死窗口：发出消息后多久没等到**任何**入站帧就认定这条 WS 已死。
 * 取值要大于最慢的一次正常往返（生产实测跨洲 relay RTT 180ms，服务端处理另计），
 * 又要短到用户在它之前不会先去刷新页面。 */
const SILENT_RESPONSE_TIMEOUT_MS = 10_000;
/** `WebSocket.OPEN`。不引用全局常量：本模块的 socket 经 `createSocket` 注入，测试替身没有
 * 那些静态字段，而这个值由 WHATWG 规范钉死。 */
const SOCKET_OPEN = 1;

type TimerHandle = ReturnType<typeof setTimeout>;

/** 可注入时钟（同 DeviceRouterClock 的形状，但本模块只依赖自己用到的这几个方法）。
 * 生产传 window，测试传假时钟——连接生命周期全是定时器驱动的，不注入就没法写确定性用例。 */
export interface ConnectionClock {
  random: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
}

/** 本模块用到的 WebSocket 子集。注入而非直接 `new WebSocket`：测试要能驱动
 * onopen/onclose/onmessage 并断言发出的字节。 */
export interface ConnectionSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send: (data: Uint8Array) => void;
  close: () => void;
}

type ConnectionOptions = {
  url: string;
  /** 构建版本（git short SHA；vite dev 固定 "dev"）：随每次认证上报，供 server 做版本准入（plan 033）。 */
  buildId: string;
  onStatus: (status: ConnectionStatus) => void;
  onMessage: (payload: ServerPayload) => void;
  /** 返回 null 表示当前不应自动重连（未登录 / 已登出 / 认证失败）。 */
  reconnectCredential: () => AuthCredential | null;
  clock?: ConnectionClock;
  createSocket?: (url: string) => ConnectionSocket;
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
  const clock: ConnectionClock = options.clock ?? {
    random: () => Math.random(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs) as unknown as TimerHandle,
    clearTimeout: (timer) => window.clearTimeout(timer as unknown as number),
  };
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as ConnectionSocket);

  let socket: ConnectionSocket | null = null;
  let stopped = false;
  let attempts = 0;
  let reconnectTimer: TimerHandle | null = null;
  let watchdogTimer: TimerHandle | null = null;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clock.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * 静默链路自愈（2026-08-17 生产事故）。公司网络与中间代理会静默丢弃长连接——不发 FIN
   * 也不发 RST，两端 TCP 都还是 ESTABLISHED。于是 `onclose` 永不触发、`readyState` 恒为
   * OPEN、`send()` 把消息写进黑洞还不报错，用户侧表现为"界面正常、点什么都没反应"，且
   * **永远不会自愈**——重连此前只由 `onclose` 驱动。daemon 侧早在 plan 033 就补过对等
   * 机制（idle 主动发 WS Ping），但浏览器发不了 WS 控制帧，只能在应用层找判据。
   *
   * 判据取"发出消息后是否还有任何入站帧"而非定期心跳：链路正常时，任何一次 client→server
   * 操作都会在几秒内引来入站流量（广播 / error / checkpoint）；链路静默死亡时则是彻底的
   * 寂静。这样既不需要服务端配合新增心跳消息，也不会在页面空闲（本就无收发）时误判。
   *
   * 判死后**只 close()**，重连交给 `onclose` 那条既有路径——它包含 `reconnectCredential()`
   * 的登出/版本失配判断。早期版本在这里提前摘掉 socket 引用并直接调 `scheduleReconnect`，
   * 绕过了那些判断，结果是认证回执尚未到达时判死会撞上 store 侧 shouldRetry 仍为 false，
   * 连接永久停在断开态——比不修更糟。
   */
  function armWatchdog() {
    // 已在等回音就不重排：计时从**第一条**未被回应的消息起算，后续消息不该把它往后推。
    if (watchdogTimer !== null || stopped) return;
    watchdogTimer = clock.setTimeout(() => {
      watchdogTimer = null;
      socket?.close();
    }, SILENT_RESPONSE_TIMEOUT_MS);
  }

  function disarmWatchdog() {
    if (watchdogTimer !== null) {
      clock.clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    if (!options.reconnectCredential()) return;
    // 指数退避 + 抖动：~1s 起步、~15s 封顶，避免服务端恢复瞬间的重连风暴。
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts);
    const delay = backoff / 2 + clock.random() * (backoff / 2);
    attempts += 1;
    reconnectTimer = clock.setTimeout(() => {
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

    const ws = createSocket(options.url);
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      options.onStatus("connected");
      ws.send(encodeClientToServer(create(ClientToServerSchema, { payload: buildAuthPayload(credential, options.buildId) })));
      // 认证包同样纳入看门狗：链路若在握手后立刻被掐，认证回执一样石沉大海——那正是
      // "刷新后能用一会儿又不行"里下一轮的起点，得让它自己重连而不是靠用户再刷一次。
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
      // 任何入站帧都证明链路还活着——哪怕这一帧本身解不出来，所以先解除看门狗再解码。
      disarmWatchdog();
      if (!(event.data instanceof ArrayBuffer)) return; // 全 binary 协议：非二进制帧一律忽略
      const message = decodeServerToClient(new Uint8Array(event.data));
      if (!message) return;
      options.onMessage(message.payload);
    };
  }

  function send(payload: ClientToServerPayload) {
    if (socket?.readyState === SOCKET_OPEN) {
      socket.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
      // readyState 在静默死亡的链路上恒为 OPEN、send 也不抛，所以发完必须开始等回音。
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
