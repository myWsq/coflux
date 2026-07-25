import {
  create,
  clampDim,
  decodeDeviceEnvelope,
  encodeDeviceEnvelope,
  DEVICE_PROTOCOL_VERSION,
  DeviceEnvelopeSchema,
  DeviceScope,
  LocalAuthErrorCode,
  MAX_DEVICE_FRAME_BYTES,
  type ClientToServerPayload,
  type DeviceEnvelope,
  type DeviceEnvelopePayload,
  type DevicePortsResult,
  type DeviceSessionCatalog,
  type FsListed,
  type FsReadResult,
  type FsWriteResult,
  type LocalGatewayDescriptor,
  type OnlineDeviceLease,
  type PreparedDeviceOperation,
  type ServerToClient,
  type ExecResult as WireExecResult,
} from "@coflux/protocol";

import {
  BrowserIdentityStore,
  signLocalClientTranscript,
  verifyGatewayHello,
  type BrowserIdentity,
  type CachedLocalGrant,
} from "./browser-identity";

type ServerPayload = ServerToClient["payload"];
type RuntimeDevicePayload = DeviceEnvelope["payload"];

const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const DEVICE_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const TRANSPORT_DEADLINE_MARGIN_MS = 5_000;
const DIRECT_CONNECT_TIMEOUT_MS = 2_500;
const RECOVER_BASE_MS = 350;
const RECOVER_MAX_MS = 5_000;
const DIRECT_HEDGE_MS = 200;
const INPUT_RETRY_MS = 500;
const CATALOG_INTERVAL_MS = 3_000;
const LEASE_EXPIRY_MARGIN_MS = 2_000;
const MAX_RETAINED_INPUTS = 256;
const MAX_RETAINED_INPUT_BYTES = 1024 * 1024;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type DeviceTransportMode = "idle" | "probing" | "direct" | "relay" | "offline";

export interface DeviceTransportState {
  mode: DeviceTransportMode;
  generation: number;
  scopes: DeviceScope[];
  detail: string;
  updatedAt: number;
}

export interface DeviceInputState {
  pendingCount: number;
  pendingBytes: number;
  blocked: boolean;
  detail: string;
}

export interface DeviceRouterClock {
  now: () => number;
  random: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
  setInterval: (callback: () => void, delayMs: number) => TimerHandle;
  clearInterval: (timer: TimerHandle) => void;
}

export interface OpenedDeviceTransport {
  channelId: string;
  scopes: ReadonlySet<DeviceScope>;
  leaseExpiresAt?: number;
  /** direct handshake 因 LEASE_INVALID 内部续签时，把实际采用的 lease 回写给 route。 */
  lease?: OnlineDeviceLease;
  send: (frame: Uint8Array<ArrayBuffer>) => boolean;
  close: () => void;
}

export interface DeviceTransportOpenOptions {
  daemonId: string;
  clientInstanceId: string;
  generation: bigint;
  scope: DeviceScope;
  signal: AbortSignal;
  onFrame: (frame: Uint8Array) => void;
  onClose: (reason: string) => void;
}

/**
 * Router 与 browser/WS 的窄边界。生产实现仍是 IndexedDB + loopback/relay；测试可注入纯内存
 * adapter，确定性推进 hedge、promotion、close 与 ACK，而不伪造浏览器全局对象。
 */
export interface DeviceRouterAdapter {
  readGrant: (daemonId: string) => Promise<CachedLocalGrant | undefined>;
  pair: (daemonId: string, signal: AbortSignal) => Promise<CachedLocalGrant>;
  requestLease: (daemonId: string, grantId: string, signal: AbortSignal) => Promise<OnlineDeviceLease>;
  openDirect: (
    options: DeviceTransportOpenOptions & { grant: CachedLocalGrant; lease?: OnlineDeviceLease },
  ) => Promise<OpenedDeviceTransport>;
  openRelay: (options: DeviceTransportOpenOptions) => Promise<OpenedDeviceTransport>;
  removeGrant: (daemonId: string) => Promise<void>;
  clearGrants: () => Promise<void>;
  close: () => void;
}

export interface DeviceRouterOptions {
  enableLocalTransport: boolean;
  identityDatabaseName: string;
  origin: string;
  sendControl: (payload: ClientToServerPayload) => void;
  onTransportState: (daemonId: string, state: DeviceTransportState) => void;
  onSessionSnapshot: (daemonId: string, taskId: string, sessionId: string, data: Uint8Array, snapshotSeq: bigint) => void;
  onSessionOutput: (daemonId: string, taskId: string, sessionId: string, data: Uint8Array, toSeq: bigint) => void;
  onSessionAttached: (daemonId: string, taskId: string, sessionId: string) => void;
  onSessionDetached: (daemonId: string, taskId: string, sessionId: string, reason: string) => void;
  onSessionExited: (daemonId: string, taskId: string, sessionId: string, exitCode: number) => void;
  onCatalog: (daemonId: string, catalog: DeviceSessionCatalog) => void;
  onPorts: (daemonId: string, ports: DevicePortsResult) => void;
  onError: (message: string) => void;
  onInputState?: (daemonId: string, taskId: string, sessionId: string, state: DeviceInputState) => void;
  /** 仅供确定性状态机测试与非 browser host；desktop 生产调用不传。 */
  adapter?: DeviceRouterAdapter;
  clock?: DeviceRouterClock;
  randomUUID?: () => string;
}

type LaneKind = "session" | "elevated";

interface DeviceChannel {
  kind: "direct" | "relay";
  daemonId: string;
  channelId: string;
  generation: bigint;
  scopes: Set<DeviceScope>;
  leaseExpiresAt?: number;
  lane: LaneKind;
  closed: boolean;
  send: (frame: Uint8Array<ArrayBuffer>) => boolean;
  close: () => void;
}

interface RetainedInput {
  requestId: string;
  seq: bigint;
  data: Uint8Array<ArrayBuffer>;
}

interface RetainedResize {
  requestId: string;
  seq: bigint;
  cols: number;
  rows: number;
}

interface RoutedSession {
  daemonId: string;
  taskId: string;
  sessionId: string;
  desired: boolean;
  detached: boolean;
  cols: number;
  rows: number;
  holderEpoch?: bigint;
  /** 仅在当前 terminal consumer 实际应用过 live snapshot/delta 后存在。 */
  outputSeq?: bigint;
  checkpointSeq?: bigint;
  hasLiveSnapshot: boolean;
  inputSeq: bigint;
  ackedInputSeq: bigint;
  resizeSeq: bigint;
  retainedInputs: RetainedInput[];
  retainedInputBytes: number;
  retainedResize?: RetainedResize;
  attachRequestId?: string;
  attachGeneration?: bigint;
  attachedGeneration?: bigint;
  inputRetryTimer?: TimerHandle;
  holderWaiters: Set<HolderWaiter>;
}

interface HolderWaiter {
  timer: TimerHandle;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingRequest {
  requestId: string;
  scope: DeviceScope;
  payload: RuntimeDevicePayload;
  sentGeneration?: bigint;
  resolve: (payload: RuntimeDevicePayload) => void;
  reject: (error: Error) => void;
  timer: TimerHandle;
}

interface PendingOperation {
  operationId: string;
  requestId?: string;
  payload: RuntimeDevicePayload;
  expiresAt: number;
  sentGeneration?: bigint;
}

interface DeviceLane {
  kind: LaneKind;
  token: number;
  active?: DeviceChannel;
  attempt?: LaneAttempt;
  recoveryAttempts: number;
  recoveryTimer?: TimerHandle;
}

interface LaneAttempt {
  token: number;
  controller: AbortController;
  ready: Promise<DeviceChannel>;
  resolve: (channel: DeviceChannel) => void;
  reject: (error: Error) => void;
  settled: boolean;
  pending: number;
  cachePending: boolean;
  directStarted: boolean;
  relayStarted: boolean;
  hedgeTimer?: TimerHandle;
  startRelay?: () => void;
}

interface DeviceRoute {
  daemonId: string;
  epoch: number;
  sessionLane: DeviceLane;
  elevatedLane: DeviceLane;
  sessions: Map<string, RoutedSession>;
  pendingRequests: Map<string, PendingRequest>;
  pendingOperations: Map<string, PendingOperation>;
  lease?: OnlineDeviceLease;
  localFailure: string;
  grantLoaded: boolean;
  grant?: CachedLocalGrant;
  grantPromise?: Promise<CachedLocalGrant | undefined>;
  pairPromise?: Promise<CachedLocalGrant | undefined>;
  pairController?: AbortController;
  directProbe?: Promise<void>;
  directProbeController?: AbortController;
  directRetryTimer?: TimerHandle;
  directRetryAttempts: number;
  catalogTimer?: TimerHandle;
  retainCount: number;
  transientDemand: number;
}

interface ControlWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: TimerHandle;
  abort?: () => void;
}

interface RelayOpenWaiter extends ControlWaiter<void> {
  daemonId: string;
}

class DeviceRouteError extends Error {
  constructor(message: string, readonly code = "route_unavailable") {
    super(message);
  }
}

class LocalAuthFailure extends Error {
  constructor(message: string, readonly code: LocalAuthErrorCode) {
    super(message);
  }
}

/**
 * 每台 daemon 一个 logical Device route。direct 与 relay 只负责承载同一 DeviceEnvelope；
 * request/op/input identity 全部保存在 route/session 账本里，因此换 transport 时原样重投。
 */
export function createDeviceRouter(options: DeviceRouterOptions) {
  const clock: DeviceRouterClock = options.clock ?? {
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: (timer) => globalThis.clearInterval(timer),
  };
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  let clientInstanceId = randomUUID();
  const identityStore = !options.adapter && options.enableLocalTransport
    ? new BrowserIdentityStore(options.identityDatabaseName)
    : undefined;
  const routes = new Map<string, DeviceRoute>();
  // generation 属于 logical client/daemon，而不是可释放的 route。reset/release/recreate 都不能回退。
  const generations = new Map<string, bigint>();
  const pairWaiters = new Map<string, ControlWaiter<{ grantId: string; gateway: LocalGatewayDescriptor }>>();
  const leaseWaiters = new Map<string, ControlWaiter<OnlineDeviceLease>>();
  const relayOpenWaiters = new Map<string, RelayOpenWaiter>();
  const relayChannels = new Map<string, { route: DeviceRoute; channel: DeviceChannel }>();
  let controlOnline = false;
  let destroyed = false;

  const adapter: DeviceRouterAdapter = options.adapter ?? {
    async readGrant(daemonId) {
      return identityStore?.grant(daemonId);
    },
    async pair(daemonId, signal) {
      if (!identityStore) throw new DeviceRouteError("本地直连未启用");
      if (!controlOnline) throw new DeviceRouteError("中心未连接，无法建立新配对");
      const identity = await identityStore.identity();
      throwIfAborted(signal);
      const requestId = randomUUID();
      const result = await controlRequest(pairWaiters, requestId, signal, () => {
        options.sendControl({
          case: "localPairRequest",
          value: {
            requestId,
            daemonId,
            origin: options.origin,
            browserPublicKeySec1: identity.publicKeySec1,
          },
        });
      });
      throwIfAborted(signal);
      return identityStore.saveGrant(daemonId, result.grantId, result.gateway);
    },
    async requestLease(daemonId, grantId, signal) {
      if (!controlOnline) throw new DeviceRouteError("中心未连接，无法签发 online lease");
      const requestId = randomUUID();
      return controlRequest(leaseWaiters, requestId, signal, () => {
        options.sendControl({ case: "localLeaseRequest", value: { requestId, daemonId, grantId } });
      });
    },
    async openDirect(openOptions) {
      if (!identityStore) throw new DeviceRouteError("本地直连未启用");
      const identity = await identityStore.identity();
      throwIfAborted(openOptions.signal);
      try {
        return await connectDirectTransport(openOptions, identity);
      } catch (error) {
        if (
          error instanceof LocalAuthFailure &&
          error.code === LocalAuthErrorCode.LEASE_INVALID &&
          controlOnline &&
          openOptions.lease
        ) {
          const lease = await adapter.requestLease(openOptions.daemonId, openOptions.grant.grantId, openOptions.signal);
          return connectDirectTransport({ ...openOptions, lease }, identity);
        }
        throw error;
      }
    },
    openRelay: openRelayTransport,
    async removeGrant(daemonId) {
      await identityStore?.removeGrant(daemonId);
    },
    async clearGrants() {
      await identityStore?.clearGrants();
    },
    close() {
      identityStore?.close();
    },
  };

  function controlRequest<T>(
    waiters: Map<string, ControlWaiter<T>>,
    requestId: string,
    signal: AbortSignal,
    send: () => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const timer = clock.setTimeout(() => {
        const waiter = waiters.get(requestId);
        if (!waiter) return;
        waiters.delete(requestId);
        waiter.abort?.();
        reject(new DeviceRouteError("中心控制请求超时", "control_timeout"));
      }, CONTROL_REQUEST_TIMEOUT_MS);
      const aborted = () => {
        const waiter = waiters.get(requestId);
        if (!waiter) return;
        waiters.delete(requestId);
        clock.clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener("abort", aborted, { once: true });
      waiters.set(requestId, {
        resolve: (value) => {
          signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
        timer,
        abort: () => signal.removeEventListener("abort", aborted),
      });
      send();
    });
  }

  function routeFor(daemonId: string): DeviceRoute {
    let route = routes.get(daemonId);
    if (!route) {
      route = {
        daemonId,
        epoch: 1,
        sessionLane: { kind: "session", token: 0, recoveryAttempts: 0 },
        elevatedLane: { kind: "elevated", token: 0, recoveryAttempts: 0 },
        sessions: new Map(),
        pendingRequests: new Map(),
        pendingOperations: new Map(),
        localFailure: "",
        grantLoaded: !options.enableLocalTransport,
        directRetryAttempts: 0,
        retainCount: 0,
        transientDemand: 0,
      };
      routes.set(daemonId, route);
      publish(route, "idle", "尚未建立 Device transport");
    }
    return route;
  }

  function publish(route: DeviceRoute, mode: DeviceTransportMode, detail: string, channel = route.sessionLane.active): void {
    options.onTransportState(route.daemonId, {
      mode,
      generation: Number(channel?.generation ?? generations.get(route.daemonId) ?? 0n),
      scopes: channel ? [...channel.scopes].sort((left, right) => left - right) : [],
      detail,
      updatedAt: clock.now(),
    });
  }

  function nextGeneration(route: DeviceRoute): bigint {
    const next = (generations.get(route.daemonId) ?? 0n) + 1n;
    generations.set(route.daemonId, next);
    return next;
  }

  function channelCovers(channel: DeviceChannel | undefined, scope: DeviceScope): channel is DeviceChannel {
    if (!channel || channel.closed || !channel.scopes.has(scope)) return false;
    if (scope === DeviceScope.RPC || scope === DeviceScope.LIFECYCLE) {
      if (channel.kind === "relay") return controlOnline;
      return controlOnline && (channel.leaseExpiresAt ?? 0) > clock.now() + LEASE_EXPIRY_MARGIN_MS;
    }
    return true;
  }

  function normalizePayload(payload: DeviceEnvelopePayload): RuntimeDevicePayload {
    return create(DeviceEnvelopeSchema, {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: "",
      payload,
    }).payload;
  }

  function encodeForChannel(channel: DeviceChannel, payload: RuntimeDevicePayload): Uint8Array<ArrayBuffer> {
    return encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: channel.channelId,
      payload,
    }));
  }

  function sendOn(channel: DeviceChannel, payload: RuntimeDevicePayload): boolean {
    if (channel.closed) return false;
    const frame = encodeForChannel(channel, payload);
    if (frame.byteLength === 0 || frame.byteLength > MAX_DEVICE_FRAME_BYTES) return false;
    return channel.send(frame);
  }

  async function connectDirectTransport(
    openOptions: DeviceTransportOpenOptions & { grant: CachedLocalGrant; lease?: OnlineDeviceLease },
    identity: BrowserIdentity,
  ): Promise<OpenedDeviceTransport> {
    const { daemonId, clientInstanceId: logicalClientId, generation, grant, lease, signal } = openOptions;
    const url = `ws://127.0.0.1:${grant.gateway.port}/device`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const abortSocket = () => {
      try { socket.close(); } catch { /* ignore */ }
    };
    signal.addEventListener("abort", abortSocket, { once: true });
    try {
      await waitForOpen(socket, DIRECT_CONNECT_TIMEOUT_MS, signal);
      const gatewayEnvelope = await waitForEnvelope(socket, DIRECT_CONNECT_TIMEOUT_MS, signal);
      if (
        gatewayEnvelope.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
        gatewayEnvelope.channelId !== "" ||
        gatewayEnvelope.payload.case !== "localGatewayHello" ||
        !(await verifyGatewayHello(gatewayEnvelope.payload.value, {
          daemonId,
          origin: options.origin,
          gateway: grant.gateway,
        }))
      ) throw new DeviceRouteError("loopback gateway identity 验证失败", "gateway_identity");

      const hello = gatewayEnvelope.payload.value;
      const signature = await signLocalClientTranscript(identity, {
        daemonId,
        origin: options.origin,
        nonce: hello.nonce,
        gatewayPublicKeySec1: hello.gatewayPublicKeySec1,
        grantId: grant.grantId,
        clientInstanceId: logicalClientId,
        transportGeneration: generation,
        leaseId: lease?.leaseId,
      });
      socket.send(encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
        protocolVersion: DEVICE_PROTOCOL_VERSION,
        channelId: "",
        payload: {
          case: "localClientHello",
          value: {
            protocolVersion: DEVICE_PROTOCOL_VERSION,
            grantId: grant.grantId,
            browserPublicKeySec1: identity.publicKeySec1,
            clientInstanceId: logicalClientId,
            transportGeneration: generation,
            leaseId: lease?.leaseId,
            gatewayNonce: hello.nonce,
            signatureP1363: signature,
          },
        },
      })));

      const authEnvelope = await waitForEnvelope(socket, DIRECT_CONNECT_TIMEOUT_MS, signal);
      if (
        authEnvelope.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
        authEnvelope.channelId !== "" ||
        authEnvelope.payload.case !== "localAuthResult"
      ) throw new DeviceRouteError("loopback gateway auth response 畸形", "auth_malformed");
      const auth = authEnvelope.payload.value;
      if (!auth.ok || !auth.channelId) throw new LocalAuthFailure(auth.error ?? "loopback gateway 拒绝认证", auth.errorCode);

      const transport: OpenedDeviceTransport = {
        channelId: auth.channelId,
        scopes: new Set(auth.scopes),
        leaseExpiresAt: lease?.expiresAt,
        lease,
        send(frame) {
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_DEVICE_FRAME_BYTES) return false;
          socket.send(frame);
          return true;
        },
        close() {
          signal.removeEventListener("abort", abortSocket);
          try { socket.close(); } catch { /* ignore */ }
        },
      };
      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        openOptions.onFrame(new Uint8Array(event.data));
      };
      socket.onclose = () => openOptions.onClose("本地 gateway 连接已关闭");
      socket.onerror = () => {
        // close 是唯一状态迁移出口；error 在浏览器里通常紧跟 close，避免重复恢复。
      };
      return transport;
    } catch (error) {
      signal.removeEventListener("abort", abortSocket);
      try { socket.close(); } catch { /* ignore */ }
      throw error;
    }
  }

  async function openRelayTransport(openOptions: DeviceTransportOpenOptions): Promise<OpenedDeviceTransport> {
    if (!controlOnline) throw new DeviceRouteError("中心 relay 不可用");
    const channelId = `relay-${randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      if (openOptions.signal.aborted) return reject(abortError());
      const timer = clock.setTimeout(() => {
        const waiter = relayOpenWaiters.get(channelId);
        if (!waiter) return;
        relayOpenWaiters.delete(channelId);
        waiter.abort?.();
        if (controlOnline) {
          options.sendControl({ case: "deviceRelayClose", value: { channelId, reason: "client relay open timeout" } });
        }
        reject(new DeviceRouteError("中心 relay channel 打开超时"));
      }, CONTROL_REQUEST_TIMEOUT_MS);
      const aborted = () => {
        const waiter = relayOpenWaiters.get(channelId);
        if (!waiter) return;
        relayOpenWaiters.delete(channelId);
        clock.clearTimeout(timer);
        if (controlOnline) {
          options.sendControl({ case: "deviceRelayClose", value: { channelId, reason: "client relay open aborted" } });
        }
        reject(abortError());
      };
      openOptions.signal.addEventListener("abort", aborted, { once: true });
      relayOpenWaiters.set(channelId, {
        daemonId: openOptions.daemonId,
        resolve: () => {
          openOptions.signal.removeEventListener("abort", aborted);
          resolve();
        },
        reject: (error) => {
          openOptions.signal.removeEventListener("abort", aborted);
          reject(error);
        },
        timer,
        abort: () => openOptions.signal.removeEventListener("abort", aborted),
      });
      options.sendControl({
        case: "deviceRelayOpen",
        value: {
          daemonId: openOptions.daemonId,
          channelId,
          clientInstanceId: openOptions.clientInstanceId,
          transportGeneration: openOptions.generation,
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      });
    });

    let closed = false;
    return {
      channelId,
      scopes: new Set([DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL, DeviceScope.RPC, DeviceScope.LIFECYCLE]),
      send(frame) {
        if (!controlOnline || closed) return false;
        options.sendControl({ case: "deviceRelayFrame", value: { channelId, frame } });
        return true;
      },
      close() {
        if (closed) return;
        closed = true;
        if (controlOnline) options.sendControl({ case: "deviceRelayClose", value: { channelId, reason: "client route replaced" } });
      },
    };
  }

  async function openChannel(
    route: DeviceRoute,
    lane: LaneKind,
    kind: "direct" | "relay",
    scope: DeviceScope,
    signal: AbortSignal,
    grant?: CachedLocalGrant,
    lease?: OnlineDeviceLease,
  ): Promise<DeviceChannel> {
    const generation = nextGeneration(route);
    let channel: DeviceChannel | undefined;
    const earlyFrames: Uint8Array[] = [];
    let earlyClose: string | undefined;
    const openOptions: DeviceTransportOpenOptions = {
      daemonId: route.daemonId,
      clientInstanceId,
      generation,
      scope,
      signal,
      onFrame(frame) {
        if (channel) receiveFrame(route, channel, frame);
        else earlyFrames.push(copyBytes(frame));
      },
      onClose(reason) {
        if (channel) loseChannel(route, channel, reason);
        else earlyClose = reason;
      },
    };
    const transport = kind === "direct"
      ? await adapter.openDirect({ ...openOptions, grant: grant!, lease })
      : await adapter.openRelay(openOptions);
    if (signal.aborted || destroyed || routes.get(route.daemonId) !== route) {
      transport.close();
      throw abortError();
    }
    if (kind === "direct" && transport.lease) route.lease = transport.lease;
    channel = {
      kind,
      daemonId: route.daemonId,
      channelId: transport.channelId,
      generation,
      scopes: new Set(transport.scopes),
      leaseExpiresAt: transport.leaseExpiresAt ?? transport.lease?.expiresAt ?? lease?.expiresAt,
      lane,
      closed: false,
      send: transport.send,
      close() {
        if (channel!.closed) return;
        channel!.closed = true;
        if (kind === "relay") relayChannels.delete(channel!.channelId);
        transport.close();
      },
    };
    if (kind === "relay") relayChannels.set(channel.channelId, { route, channel });
    if (earlyClose) {
      channel.close();
      throw new DeviceRouteError(earlyClose);
    }
    for (const frame of earlyFrames) receiveFrame(route, channel, frame);
    return channel;
  }

  function loadGrant(route: DeviceRoute): Promise<CachedLocalGrant | undefined> {
    if (!options.enableLocalTransport) return Promise.resolve(undefined);
    if (route.grantLoaded) return Promise.resolve(route.grant);
    route.grantPromise ??= adapter.readGrant(route.daemonId)
      .then((grant) => {
        if (routes.get(route.daemonId) === route) {
          route.grant = grant;
          route.grantLoaded = true;
        }
        return grant;
      })
      .catch((error) => {
        if (routes.get(route.daemonId) === route) {
          // IndexedDB blocked 等瞬时错误允许下一轮有界 recovery 重新读取；成功读到“无记录”才缓存 miss。
          route.grantLoaded = false;
          route.localFailure = errorMessage(error);
        }
        return undefined;
      })
      .finally(() => {
        if (routes.get(route.daemonId) === route) route.grantPromise = undefined;
      });
    return route.grantPromise;
  }

  function pairInBackground(route: DeviceRoute): void {
    if (!options.enableLocalTransport || !controlOnline || route.pairPromise || !routeHasDemand(route)) return;
    const epoch = route.epoch;
    const controller = new AbortController();
    route.pairController = controller;
    route.pairPromise = adapter.pair(route.daemonId, controller.signal)
      .then((grant) => {
        if (
          destroyed ||
          routes.get(route.daemonId) !== route ||
          route.epoch !== epoch ||
          route.pairController !== controller ||
          controller.signal.aborted
        ) return undefined;
        route.grant = grant;
        route.grantLoaded = true;
        route.localFailure = "";
        if (route.sessionLane.active?.kind === "relay") scheduleDirectRetry(route, true);
        return grant;
      })
      .catch((error) => {
        if (route.pairController === controller && !isAbortError(error)) {
          route.localFailure = `本地配对失败：${errorMessage(error)}`;
        }
        return undefined;
      })
      .finally(() => {
        if (routes.get(route.daemonId) === route && route.pairController === controller) {
          route.pairController = undefined;
          route.pairPromise = undefined;
        }
      });
  }

  function ensureSessionLane(route: DeviceRoute): Promise<DeviceChannel> {
    if (destroyed) return Promise.reject(new DeviceRouteError("Device router 已停止"));
    if (channelCovers(route.sessionLane.active, DeviceScope.SESSION_READ)) {
      return Promise.resolve(route.sessionLane.active);
    }
    if (route.sessionLane.attempt) return route.sessionLane.attempt.ready;

    const lane = route.sessionLane;
    const token = ++lane.token;
    const controller = new AbortController();
    let resolveReady!: (channel: DeviceChannel) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<DeviceChannel>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // recovery 调用可能不 await；始终挂一个 rejection handler，避免离线时产生 unhandled rejection。
    void ready.catch(() => undefined);
    const attempt: LaneAttempt = {
      token,
      controller,
      ready,
      resolve: resolveReady,
      reject: rejectReady,
      settled: false,
      pending: 0,
      cachePending: options.enableLocalTransport,
      directStarted: false,
      relayStarted: false,
    };
    lane.attempt = attempt;
    publish(route, "probing", "正在选择本地直连或中心 relay");

    const valid = () => (
      !destroyed &&
      routes.get(route.daemonId) === route &&
      lane.attempt === attempt &&
      lane.token === token &&
      !controller.signal.aborted
    );
    const settleWinner = (channel: DeviceChannel) => {
      if (!attempt.settled) {
        attempt.settled = true;
        attempt.resolve(channel);
      }
    };
    const finish = () => {
      if (!valid() || attempt.pending > 0 || attempt.cachePending || attempt.hedgeTimer !== undefined) return;
      if (lane.attempt === attempt) lane.attempt = undefined;
      if (!attempt.settled) {
        attempt.settled = true;
        const reason = route.localFailure || "中心与本地 gateway 均不可用";
        publish(route, "offline", reason);
        attempt.reject(new DeviceRouteError(reason));
      }
      if (lane.active?.kind === "relay") scheduleDirectRetry(route);
    };
    const acceptCandidate = (channel: DeviceChannel) => {
      if (!valid() || !sessionLaneDemand(route)) {
        channel.close();
        return;
      }
      const active = lane.active;
      if (!active) {
        activateSessionLane(route, channel);
        settleWinner(channel);
        if (channel.kind === "direct" && attempt.hedgeTimer !== undefined) {
          clock.clearTimeout(attempt.hedgeTimer);
          attempt.hedgeTimer = undefined;
        }
        return;
      }
      if (channel.kind === "direct" && active.kind === "relay") {
        if (channel.generation > active.generation) {
          activateSessionLane(route, channel);
        } else {
          channel.close();
          scheduleDirectRetry(route, true);
        }
      } else {
        // 已有 winner 后，任何 stale hedge contender 都不发送业务，也不能覆盖 lane。
        channel.close();
      }
    };
    const candidateDone = (kind: "direct" | "relay", error?: unknown) => {
      attempt.pending -= 1;
      if (error && kind === "direct" && !isAbortError(error)) {
        route.localFailure = errorMessage(error);
        if (
          error instanceof LocalAuthFailure &&
          (error.code === LocalAuthErrorCode.GRANT_UNKNOWN || error.code === LocalAuthErrorCode.KEY_MISMATCH)
        ) {
          route.grant = undefined;
          route.grantLoaded = true;
          void adapter.removeGrant(route.daemonId).catch(() => undefined);
          pairInBackground(route);
        }
        attempt.startRelay?.();
      }
      finish();
    };
    const startRelay = () => {
      if (!valid() || attempt.relayStarted || !controlOnline) return;
      attempt.relayStarted = true;
      if (attempt.hedgeTimer !== undefined) {
        clock.clearTimeout(attempt.hedgeTimer);
        attempt.hedgeTimer = undefined;
      }
      attempt.pending += 1;
      void openChannel(route, "session", "relay", DeviceScope.SESSION_CONTROL, controller.signal)
        .then(acceptCandidate)
        .catch((error) => {
          if (!isAbortError(error)) route.localFailure ||= errorMessage(error);
        })
        .finally(() => candidateDone("relay"));
    };
    attempt.startRelay = startRelay;
    const startDirect = (grant: CachedLocalGrant) => {
      if (!valid() || attempt.directStarted) return;
      attempt.directStarted = true;
      attempt.pending += 1;
      void (async () => {
        try {
          const channel = await openChannel(route, "session", "direct", DeviceScope.SESSION_CONTROL, controller.signal, grant);
          route.localFailure = "";
          route.directRetryAttempts = 0;
          acceptCandidate(channel);
          candidateDone("direct");
        } catch (error) {
          candidateDone("direct", error);
        }
      })();
    };

    if (!options.enableLocalTransport) {
      attempt.cachePending = false;
      startRelay();
      finish();
      return ready;
    }

    // 从 t=0 读缓存并准备 direct；中心 relay 只在 200ms hedge 窗口后加入竞争。
    if (controlOnline) {
      attempt.hedgeTimer = clock.setTimeout(() => {
        attempt.hedgeTimer = undefined;
        startRelay();
        finish();
      }, DIRECT_HEDGE_MS);
    }
    void loadGrant(route).then((grant) => {
      if (!valid()) return;
      attempt.cachePending = false;
      if (grant) startDirect(grant);
      else {
        startRelay();
        pairInBackground(route);
      }
      finish();
    });
    return ready;
  }

  async function ensureElevatedLane(route: DeviceRoute, scope: DeviceScope): Promise<DeviceChannel> {
    if (destroyed) throw new DeviceRouteError("Device router 已停止");
    if (!controlOnline) throw new DeviceRouteError("中心离线时不允许高权限 Device RPC", "lease_offline");
    const lane = route.elevatedLane;
    if (channelCovers(lane.active, scope)) return lane.active;
    if (lane.attempt) return lane.attempt.ready;

    const token = ++lane.token;
    const controller = new AbortController();
    let resolveReady!: (channel: DeviceChannel) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<DeviceChannel>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const attempt: LaneAttempt = {
      token,
      controller,
      ready,
      resolve: resolveReady,
      reject: rejectReady,
      settled: false,
      pending: 1,
      cachePending: false,
      directStarted: false,
      relayStarted: false,
    };
    lane.attempt = attempt;
    const epoch = route.epoch;
    const valid = () => !destroyed && routes.get(route.daemonId) === route && route.epoch === epoch && lane.attempt === attempt && lane.token === token;

    void (async () => {
      let directError: unknown;
      const grant = await loadGrant(route);
      if (!valid()) throw abortError();
      if (grant) {
        try {
          let lease = route.lease;
          if (!lease || lease.grantId !== grant.grantId || lease.expiresAt <= clock.now() + LEASE_EXPIRY_MARGIN_MS) {
            lease = await adapter.requestLease(route.daemonId, grant.grantId, controller.signal);
            if (valid()) route.lease = lease;
          }
          const direct = await openChannel(route, "elevated", "direct", scope, controller.signal, grant, lease);
          if (!valid()) {
            direct.close();
            throw abortError();
          }
          activateElevatedLane(route, direct);
          return direct;
        } catch (error) {
          directError = error;
          if (!isAbortError(error)) {
            route.localFailure = errorMessage(error);
            if (error instanceof LocalAuthFailure && error.code === LocalAuthErrorCode.LEASE_INVALID) {
              route.lease = undefined;
            }
          }
        }
      } else {
        pairInBackground(route);
      }
      if (!valid()) throw abortError();
      try {
        const relay = await openChannel(route, "elevated", "relay", scope, controller.signal);
        if (!valid()) {
          relay.close();
          throw abortError();
        }
        activateElevatedLane(route, relay);
        return relay;
      } catch (relayError) {
        throw new DeviceRouteError(
          `高权限 Device lane 不可用：${errorMessage(directError ?? relayError)}`,
          "elevated_unavailable",
        );
      }
    })().then((channel) => {
      if (!attempt.settled) {
        attempt.settled = true;
        attempt.resolve(channel);
      }
    }).catch((error) => {
      if (!attempt.settled) {
        attempt.settled = true;
        attempt.reject(error instanceof Error ? error : new DeviceRouteError(String(error)));
      }
    }).finally(() => {
      if (lane.attempt === attempt) lane.attempt = undefined;
    });
    return ready;
  }

  function ensureRoute(route: DeviceRoute, scope: DeviceScope): Promise<DeviceChannel> {
    return scope === DeviceScope.RPC || scope === DeviceScope.LIFECYCLE
      ? ensureElevatedLane(route, scope)
      : ensureSessionLane(route);
  }

  function activateSessionLane(route: DeviceRoute, channel: DeviceChannel): void {
    const lane = route.sessionLane;
    const previous = lane.active;
    if (previous && previous !== channel && channel.generation <= previous.generation) {
      channel.close();
      return;
    }
    lane.active = channel;
    lane.recoveryAttempts = 0;
    if (lane.recoveryTimer !== undefined) clock.clearTimeout(lane.recoveryTimer);
    lane.recoveryTimer = undefined;
    publish(
      route,
      channel.kind,
      channel.kind === "direct"
        ? "同机 Device 数据直连本地 daemon"
        : route.localFailure
          ? `本地直连不可用，已回退中心 relay：${route.localFailure}`
          : "Device 数据经中心 opaque relay",
      channel,
    );

    for (const session of route.sessions.values()) {
      session.attachRequestId = undefined;
      session.attachGeneration = undefined;
      session.attachedGeneration = undefined;
      if (session.desired) sendAttach(route, session, false);
    }
    for (const pending of route.pendingRequests.values()) {
      if (pending.scope === DeviceScope.SESSION_READ || pending.scope === DeviceScope.SESSION_CONTROL) {
        pending.sentGeneration = undefined;
      }
    }
    flushLane(route, "session");
    sendCatalogRequest(route);
    maintainCatalogTimer(route);
    if (previous && previous !== channel) previous.close();
    if (channel.kind === "relay") scheduleDirectRetry(route);
    else {
      route.directRetryAttempts = 0;
      if (route.directRetryTimer !== undefined) clock.clearTimeout(route.directRetryTimer);
      route.directRetryTimer = undefined;
    }
  }

  function activateElevatedLane(route: DeviceRoute, channel: DeviceChannel): void {
    const lane = route.elevatedLane;
    const previous = lane.active;
    if (previous && previous !== channel && channel.generation <= previous.generation) {
      channel.close();
      return;
    }
    lane.active = channel;
    lane.recoveryAttempts = 0;
    if (lane.recoveryTimer !== undefined) clock.clearTimeout(lane.recoveryTimer);
    lane.recoveryTimer = undefined;
    for (const pending of route.pendingRequests.values()) {
      if (pending.scope === DeviceScope.RPC || pending.scope === DeviceScope.LIFECYCLE) pending.sentGeneration = undefined;
    }
    for (const operation of route.pendingOperations.values()) operation.sentGeneration = undefined;
    flushLane(route, "elevated");
    if (previous && previous !== channel) previous.close();
  }

  function loseChannel(route: DeviceRoute, channel: DeviceChannel, reason: string): void {
    if (channel.closed) return;
    const lane = channel.lane === "session" ? route.sessionLane : route.elevatedLane;
    channel.close();
    if (lane.active !== channel) return;
    lane.active = undefined;
    if (channel.lane === "session") {
      for (const pending of route.pendingRequests.values()) {
        if (pending.scope === DeviceScope.SESSION_READ || pending.scope === DeviceScope.SESSION_CONTROL) pending.sentGeneration = undefined;
      }
      for (const session of route.sessions.values()) {
        session.attachRequestId = undefined;
        session.attachGeneration = undefined;
        session.attachedGeneration = undefined;
      }
      publish(route, "offline", reason);
    } else {
      for (const pending of route.pendingRequests.values()) {
        if (pending.scope === DeviceScope.RPC || pending.scope === DeviceScope.LIFECYCLE) pending.sentGeneration = undefined;
      }
      for (const operation of route.pendingOperations.values()) operation.sentGeneration = undefined;
    }
    scheduleRecovery(route, lane);
  }

  function scheduleRecovery(route: DeviceRoute, lane: DeviceLane): void {
    const needed = lane.kind === "session" ? sessionLaneDemand(route) : elevatedLaneDemand(route);
    if (destroyed || lane.recoveryTimer !== undefined || !needed) return;
    const base = Math.min(RECOVER_MAX_MS, RECOVER_BASE_MS * 2 ** Math.min(lane.recoveryAttempts, 4));
    const delayMs = Math.round(base * (1 + clock.random() * 0.2));
    lane.recoveryAttempts += 1;
    lane.recoveryTimer = clock.setTimeout(() => {
      lane.recoveryTimer = undefined;
      const stillNeeded = lane.kind === "session" ? sessionLaneDemand(route) : elevatedLaneDemand(route);
      if (!stillNeeded) {
        releaseIdle(route);
        return;
      }
      const promise = lane.kind === "session"
        ? ensureSessionLane(route)
        : ensureElevatedLane(route, requiredElevatedScope(route));
      void promise.then(() => flushLane(route, lane.kind)).catch(() => scheduleRecovery(route, lane));
    }, delayMs);
  }

  function sessionLaneDemand(route: DeviceRoute): boolean {
    if (route.retainCount > 0 || route.transientDemand > 0) return true;
    if ([...route.sessions.values()].some((session) => session.desired)) return true;
    return [...route.pendingRequests.values()].some(
      (pending) => pending.scope === DeviceScope.SESSION_READ || pending.scope === DeviceScope.SESSION_CONTROL,
    );
  }

  function elevatedLaneDemand(route: DeviceRoute): boolean {
    pruneExpiredOperations(route);
    if (route.pendingOperations.size > 0) return true;
    return [...route.pendingRequests.values()].some(
      (pending) => pending.scope === DeviceScope.RPC || pending.scope === DeviceScope.LIFECYCLE,
    );
  }

  function routeHasDemand(route: DeviceRoute): boolean {
    return sessionLaneDemand(route) || elevatedLaneDemand(route);
  }

  function pruneExpiredOperations(route: DeviceRoute): void {
    let expired = false;
    for (const operation of route.pendingOperations.values()) {
      if (operation.expiresAt > clock.now()) continue;
      route.pendingOperations.delete(operation.operationId);
      expired = true;
    }
    if (expired) options.onError("prepared device operation 已过期，请重试");
  }

  function requiredElevatedScope(route: DeviceRoute): DeviceScope {
    if (route.pendingOperations.size > 0) return DeviceScope.LIFECYCLE;
    for (const pending of route.pendingRequests.values()) {
      if (pending.scope === DeviceScope.LIFECYCLE) return DeviceScope.LIFECYCLE;
    }
    return DeviceScope.RPC;
  }

  function flushLane(route: DeviceRoute, laneKind: LaneKind): void {
    const lane = laneKind === "session" ? route.sessionLane : route.elevatedLane;
    const channel = lane.active;
    if (!channel) return void scheduleRecovery(route, lane);
    for (const pending of route.pendingRequests.values()) {
      const pendingLane: LaneKind = pending.scope === DeviceScope.RPC || pending.scope === DeviceScope.LIFECYCLE
        ? "elevated"
        : "session";
      if (pendingLane !== laneKind) continue;
      if (pending.sentGeneration === channel.generation) continue;
      if (!channelCovers(channel, pending.scope)) {
        if (laneKind === "elevated") {
          closeLane(route, lane, "scope 已失效");
          void ensureElevatedLane(route, pending.scope).catch((error) => finishPendingWithError(route, pending, error));
        } else {
          void ensureSessionLane(route).catch((error) => finishPendingWithError(route, pending, error));
        }
        continue;
      }
      if (sendOn(channel, pending.payload)) pending.sentGeneration = channel.generation;
      else loseChannel(route, channel, "Device request 发送失败");
    }
    if (laneKind !== "elevated") return;
    for (const operation of [...route.pendingOperations.values()]) {
      if (operation.expiresAt <= clock.now()) {
        route.pendingOperations.delete(operation.operationId);
        options.onError("prepared device operation 已过期，请重试");
        continue;
      }
      if (operation.sentGeneration === channel.generation) continue;
      if (!channelCovers(channel, DeviceScope.LIFECYCLE)) {
        closeLane(route, lane, "lifecycle scope 已失效");
        void ensureElevatedLane(route, DeviceScope.LIFECYCLE).catch(() => scheduleRecovery(route, lane));
        continue;
      }
      if (sendOn(channel, operation.payload)) operation.sentGeneration = channel.generation;
      else loseChannel(route, channel, "prepared operation 发送失败");
    }
    if (!elevatedLaneDemand(route)) releaseIdle(route);
  }

  function receiveFrame(route: DeviceRoute, channel: DeviceChannel, frame: Uint8Array): void {
    const active = channel.lane === "session" ? route.sessionLane.active : route.elevatedLane.active;
    if (active !== channel || channel.closed || frame.byteLength === 0 || frame.byteLength > MAX_DEVICE_FRAME_BYTES) return;
    const envelope = decodeDeviceEnvelope(frame);
    if (!envelope || envelope.protocolVersion !== DEVICE_PROTOCOL_VERSION || envelope.channelId !== channel.channelId || !envelope.payload.case) return;
    handleDevicePayload(route, channel, envelope.payload);
  }

  function handleDevicePayload(route: DeviceRoute, channel: DeviceChannel, payload: RuntimeDevicePayload): void {
    switch (payload.case) {
      case "sessionCatalog":
        options.onCatalog(route.daemonId, payload.value);
        if (payload.value.exits.length > 0) {
          const ids = payload.value.exits.map((item) => item.eventId).filter(Boolean);
          if (
            ids.length > 0 &&
            !sendOn(channel, normalizePayload({ case: "exitAck", value: { eventIds: ids } }))
          ) loseChannel(route, channel, "session exit ACK 发送失败");
        }
        break;
      case "sessionAttached":
        handleAttached(route, channel, payload.value);
        break;
      case "ptyOutput":
        handleOutput(route, channel, payload.value.sessionId, payload.value.fromSeq, payload.value.toSeq, payload.value.data);
        break;
      case "ptyGap": {
        const session = route.sessions.get(payload.value.sessionId);
        if (session?.desired) requestSnapshotRecovery(route, session);
        break;
      }
      case "ptyInputAck": {
        const session = route.sessions.get(payload.value.sessionId);
        if (session) handleInputAck(route, session, payload.value.appliedThroughSeq);
        break;
      }
      case "sessionDetached": {
        const session = route.sessions.get(payload.value.sessionId);
        if (session) {
          session.desired = false;
          session.detached = true;
          session.holderEpoch = undefined;
          session.attachRequestId = undefined;
          session.attachGeneration = undefined;
          session.attachedGeneration = undefined;
          clearInputRetry(session);
          rejectHolderWaiters(session, new DeviceRouteError("session holder 已被其它客户端接管", "stale_holder"));
          options.onSessionDetached(route.daemonId, session.taskId, session.sessionId, payload.value.reason ?? "holder detached");
          releaseIdle(route);
        }
        break;
      }
      case "sessionExited": {
        const session = route.sessions.get(payload.value.sessionId);
        if (session) {
          session.desired = false;
          session.detached = false;
          session.holderEpoch = undefined;
          clearInputRetry(session);
          rejectHolderWaiters(session, new DeviceRouteError("session 已退出", "session_exited"));
          options.onSessionExited(route.daemonId, session.taskId, session.sessionId, payload.value.exitCode);
          releaseIdle(route);
        }
        break;
      }
      case "portsResult":
        options.onPorts(route.daemonId, payload.value);
        break;
      case "projectValidated":
      case "worktreeAdded":
      case "operationAck": {
        const operationId = payload.value.operationId;
        if (operationId) route.pendingOperations.delete(operationId);
        releaseIdle(route);
        break;
      }
      case "error":
        if (handleDeviceError(route, channel, payload.value.requestId, payload.value.code, payload.value.message)) return;
        break;
      default:
        break;
    }

    const requestId = responseRequestId(payload);
    if (!requestId) return;
    const pending = route.pendingRequests.get(requestId);
    if (!pending) return;
    route.pendingRequests.delete(requestId);
    clock.clearTimeout(pending.timer);
    pending.resolve(payload);
    releaseIdle(route);
  }

  function handleDeviceError(
    route: DeviceRoute,
    channel: DeviceChannel,
    requestId: string | undefined,
    code: string,
    message: string,
  ): boolean {
    if (requestId) {
      for (const session of route.sessions.values()) {
        if (session.attachRequestId === requestId) {
          session.attachGeneration = undefined;
          session.attachRequestId = undefined;
          if (["stale_transport", "scope_denied", "supervisor_busy"].includes(code)) {
            closeLane(route, route.sessionLane, message);
            void ensureSessionLane(route).catch(() => scheduleRecovery(route, route.sessionLane));
          } else if (code === "stale_holder") {
            session.desired = false;
            session.detached = true;
            session.holderEpoch = undefined;
            clearInputRetry(session);
            rejectHolderWaiters(session, new DeviceRouteError(message, code));
            options.onSessionDetached(route.daemonId, session.taskId, session.sessionId, message);
            releaseIdle(route);
          } else if (code === "session_not_found") {
            // authority 明确说没有这个 session：立刻带 code 拒掉 holder 等待，否则 stopSession
            // 之类的调用要空等到 holder 超时，上层拿不到可判定的原因（本机 stop 永远收敛不了）。
            session.desired = false;
            session.holderEpoch = undefined;
            clearInputRetry(session);
            rejectHolderWaiters(session, new DeviceRouteError(message, code));
            options.onError(message);
            releaseIdle(route);
          } else {
            options.onError(message);
          }
          return true;
        }
        const input = session.retainedInputs.find((entry) => entry.requestId === requestId);
        if (input) {
          if (code === "input_seq_gap") scheduleInputRetry(route, session, true);
          else if (code !== "stale_input") options.onError(message);
          return true;
        }
        if (session.retainedResize?.requestId === requestId) {
          if (code !== "stale_resize") options.onError(message);
          return true;
        }
      }

      const pending = route.pendingRequests.get(requestId);
      if (pending) {
        if (["scope_denied", "stale_transport", "channel_mismatch", "supervisor_busy"].includes(code)) {
          pending.sentGeneration = undefined;
          if (channel.lane === "elevated") {
            if (channel.kind === "direct" && code === "scope_denied") route.lease = undefined;
            closeLane(route, route.elevatedLane, message);
          } else {
            closeLane(route, route.sessionLane, message);
          }
          void ensureRoute(route, pending.scope).then(() => flushLane(route, channel.lane)).catch((error) => finishPendingWithError(route, pending, error));
        } else {
          finishPendingWithError(route, pending, new DeviceRouteError(message, code));
        }
        return true;
      }

      const operation = [...route.pendingOperations.values()].find((entry) => entry.requestId === requestId);
      if (operation) {
        if (["scope_denied", "stale_transport", "supervisor_busy"].includes(code)) {
          operation.sentGeneration = undefined;
          if (channel.kind === "direct" && code === "scope_denied") route.lease = undefined;
          closeLane(route, route.elevatedLane, message);
          void ensureElevatedLane(route, DeviceScope.LIFECYCLE)
            .then(() => flushLane(route, "elevated"))
            .catch(() => scheduleRecovery(route, route.elevatedLane));
        } else {
          route.pendingOperations.delete(operation.operationId);
          options.onError(message);
          releaseIdle(route);
        }
        return true;
      }
    }
    options.onError(message);
    return true;
  }

  function handleAttached(route: DeviceRoute, channel: DeviceChannel, attached: Extract<RuntimeDevicePayload, { case: "sessionAttached" }>["value"]): void {
    const session = route.sessions.get(attached.sessionId);
    if (!session || !session.desired || route.sessionLane.active !== channel) return;
    if (!session.attachRequestId || attached.requestId !== session.attachRequestId) return;
    if (session.attachGeneration !== channel.generation) return;
    session.attachRequestId = undefined;
    session.attachGeneration = undefined;
    session.attachedGeneration = channel.generation;
    session.holderEpoch = attached.holderEpoch;
    resolveHolderWaiters(session);
    if (attached.ansiSnapshot !== undefined) {
      session.outputSeq = attached.snapshotSeq;
      session.hasLiveSnapshot = true;
      options.onSessionSnapshot(route.daemonId, session.taskId, session.sessionId, attached.ansiSnapshot, attached.snapshotSeq);
    } else if (!session.hasLiveSnapshot || session.outputSeq === undefined || attached.snapshotSeq !== session.outputSeq) {
      session.outputSeq = undefined;
      session.hasLiveSnapshot = false;
      session.attachedGeneration = undefined;
      sendAttach(route, session, true);
      return;
    }
    options.onSessionAttached(route.daemonId, session.taskId, session.sessionId);
    replayControl(route, session);
  }

  function handleOutput(route: DeviceRoute, channel: DeviceChannel, sessionId: string, fromSeq: bigint, toSeq: bigint, data: Uint8Array): void {
    const session = route.sessions.get(sessionId);
    if (!session?.desired || session.attachedGeneration !== channel.generation || data.byteLength === 0) return;
    const expected = (session.outputSeq ?? 0n) + 1n;
    if (fromSeq !== expected || toSeq !== fromSeq + BigInt(data.byteLength) - 1n) {
      requestSnapshotRecovery(route, session);
      return;
    }
    session.outputSeq = toSeq;
    options.onSessionOutput(route.daemonId, session.taskId, session.sessionId, data, toSeq);
  }

  function requestSnapshotRecovery(route: DeviceRoute, session: RoutedSession): void {
    session.outputSeq = undefined;
    session.hasLiveSnapshot = false;
    session.attachedGeneration = undefined;
    sendAttach(route, session, true);
  }

  function sendAttach(route: DeviceRoute, session: RoutedSession, requireSnapshot: boolean): void {
    if (!session.desired || session.detached) return;
    const channel = route.sessionLane.active;
    if (!channelCovers(channel, DeviceScope.SESSION_READ)) {
      void ensureSessionLane(route)
        .then(() => sendAttach(route, session, requireSnapshot))
        .catch(() => scheduleRecovery(route, route.sessionLane));
      return;
    }
    if (session.attachRequestId && session.attachGeneration === channel.generation) return;
    if (!requireSnapshot && session.attachedGeneration === channel.generation && session.holderEpoch !== undefined) return;
    const requestId = randomUUID();
    session.attachRequestId = requestId;
    session.attachGeneration = channel.generation;
    const payload = normalizePayload({
      case: "sessionAttach",
      value: {
        requestId,
        sessionId: session.sessionId,
        clientInstanceId,
        transportGeneration: channel.generation,
        cols: session.cols,
        rows: session.rows,
        resumeFromSeq: requireSnapshot || !session.hasLiveSnapshot ? undefined : session.outputSeq,
      },
    });
    if (!sendOn(channel, payload)) {
      session.attachRequestId = undefined;
      session.attachGeneration = undefined;
      loseChannel(route, channel, "session attach 发送失败");
    }
  }

  function replayControl(route: DeviceRoute, session: RoutedSession): void {
    const channel = route.sessionLane.active;
    if (!channelCovers(channel, DeviceScope.SESSION_CONTROL) || session.holderEpoch === undefined) return;
    for (const input of session.retainedInputs) {
      if (!sendInputFrame(route, channel, session, input)) return;
    }
    if (session.retainedResize) sendResizeFrame(route, channel, session, session.retainedResize);
    scheduleInputRetry(route, session);
  }

  function sendInputFrame(route: DeviceRoute, channel: DeviceChannel, session: RoutedSession, input: RetainedInput): boolean {
    if (session.holderEpoch === undefined) return false;
    const sent = sendOn(channel, normalizePayload({
      case: "ptyInput",
      value: {
        requestId: input.requestId,
        sessionId: session.sessionId,
        holderEpoch: session.holderEpoch,
        inputSeq: input.seq,
        data: input.data,
      },
    }));
    if (!sent) loseChannel(route, channel, "PTY input 发送失败");
    return sent;
  }

  function sendResizeFrame(route: DeviceRoute, channel: DeviceChannel, session: RoutedSession, resize: RetainedResize): boolean {
    if (session.holderEpoch === undefined) return false;
    const sent = sendOn(channel, normalizePayload({
      case: "ptyResize",
      value: {
        requestId: resize.requestId,
        sessionId: session.sessionId,
        holderEpoch: session.holderEpoch,
        resizeSeq: resize.seq,
        cols: resize.cols,
        rows: resize.rows,
      },
    }));
    if (!sent) loseChannel(route, channel, "PTY resize 发送失败");
    return sent;
  }

  function sendCatalogRequest(route: DeviceRoute): void {
    const channel = route.sessionLane.active;
    if (!channelCovers(channel, DeviceScope.SESSION_READ)) return;
    if (!sendOn(channel, normalizePayload({
      case: "sessionCatalogRequest",
      value: { requestId: randomUUID() },
    }))) loseChannel(route, channel, "session catalog 请求发送失败");
  }

  function maintainCatalogTimer(route: DeviceRoute): void {
    if (!sessionLaneDemand(route) || !route.sessionLane.active) {
      if (route.catalogTimer !== undefined) clock.clearInterval(route.catalogTimer);
      route.catalogTimer = undefined;
      return;
    }
    route.catalogTimer ??= clock.setInterval(() => sendCatalogRequest(route), CATALOG_INTERVAL_MS);
  }

  function scheduleDirectRetry(route: DeviceRoute, immediate = false): void {
    if (
      !options.enableLocalTransport ||
      destroyed ||
      routes.get(route.daemonId) !== route ||
      route.sessionLane.active?.kind !== "relay" ||
      !sessionLaneDemand(route) ||
      route.directProbe ||
      (route.sessionLane.attempt && !immediate)
    ) return;
    if (route.directRetryTimer !== undefined) {
      if (!immediate) return;
      clock.clearTimeout(route.directRetryTimer);
      route.directRetryTimer = undefined;
    }
    const base = immediate
      ? 0
      : Math.min(RECOVER_MAX_MS, RECOVER_BASE_MS * 2 ** Math.min(route.directRetryAttempts, 4));
    const delayMs = base === 0 ? 0 : Math.round(base * (1 + clock.random() * 0.2));
    route.directRetryTimer = clock.setTimeout(() => {
      route.directRetryTimer = undefined;
      probeDirectPromotion(route);
    }, delayMs);
  }

  function probeDirectPromotion(route: DeviceRoute): void {
    if (
      route.directProbe ||
      route.sessionLane.active?.kind !== "relay" ||
      !sessionLaneDemand(route) ||
      destroyed
    ) return;
    const epoch = route.epoch;
    const controller = new AbortController();
    route.directProbeController = controller;
    route.directProbe = (async () => {
      const grant = await loadGrant(route);
      if (!grant) {
        pairInBackground(route);
        throw new DeviceRouteError("本机没有已配对 grant", "grant_missing");
      }
      const channel = await openChannel(
        route,
        "session",
        "direct",
        DeviceScope.SESSION_CONTROL,
        controller.signal,
        grant,
      );
      if (
        destroyed ||
        routes.get(route.daemonId) !== route ||
        route.epoch !== epoch ||
        route.sessionLane.active?.kind !== "relay" ||
        !sessionLaneDemand(route)
      ) {
        channel.close();
        return;
      }
      route.localFailure = "";
      route.directRetryAttempts = 0;
      activateSessionLane(route, channel);
    })().catch((error) => {
      if (isAbortError(error)) return;
      route.localFailure = errorMessage(error);
      route.directRetryAttempts += 1;
      if (
        error instanceof LocalAuthFailure &&
        (error.code === LocalAuthErrorCode.GRANT_UNKNOWN || error.code === LocalAuthErrorCode.KEY_MISMATCH)
      ) {
        route.grant = undefined;
        route.grantLoaded = true;
        void adapter.removeGrant(route.daemonId).catch(() => undefined);
        pairInBackground(route);
      }
    }).finally(() => {
      if (routes.get(route.daemonId) !== route || route.directProbeController !== controller) return;
      route.directProbe = undefined;
      route.directProbeController = undefined;
      if (route.sessionLane.active?.kind === "relay" && sessionLaneDemand(route)) scheduleDirectRetry(route);
    });
  }

  function publishInputState(route: DeviceRoute, session: RoutedSession, blocked: boolean, detail: string): void {
    options.onInputState?.(route.daemonId, session.taskId, session.sessionId, {
      pendingCount: session.retainedInputs.length,
      pendingBytes: session.retainedInputBytes,
      blocked,
      detail,
    });
  }

  function clearInputRetry(session: RoutedSession): void {
    if (session.inputRetryTimer !== undefined) clock.clearTimeout(session.inputRetryTimer);
    session.inputRetryTimer = undefined;
  }

  function scheduleInputRetry(route: DeviceRoute, session: RoutedSession, immediate = false): void {
    if (!session.desired || session.detached || session.retainedInputs.length === 0) {
      clearInputRetry(session);
      return;
    }
    if (session.inputRetryTimer !== undefined) {
      if (!immediate) return;
      clock.clearTimeout(session.inputRetryTimer);
    }
    session.inputRetryTimer = clock.setTimeout(() => {
      session.inputRetryTimer = undefined;
      if (!session.desired || session.detached || session.retainedInputs.length === 0) return;
      const channel = route.sessionLane.active;
      if (!channelCovers(channel, DeviceScope.SESSION_CONTROL) || session.holderEpoch === undefined) {
        void ensureSessionLane(route)
          .then(() => sendAttach(route, session, false))
          .catch(() => scheduleRecovery(route, route.sessionLane));
        return;
      }
      // ACK 可能在 transport 存活时丢失；严格按 seq 重投全部未确认前缀，authority 幂等裁决。
      for (const input of session.retainedInputs) {
        if (!sendInputFrame(route, channel, session, input)) return;
      }
      scheduleInputRetry(route, session);
    }, immediate ? 0 : INPUT_RETRY_MS);
  }

  function handleInputAck(route: DeviceRoute, session: RoutedSession, appliedThroughSeq: bigint): void {
    if (appliedThroughSeq <= session.ackedInputSeq) return;
    if (appliedThroughSeq > session.inputSeq) {
      options.onError(`PTY input ACK 越界：${session.sessionId}`);
      return;
    }
    session.ackedInputSeq = appliedThroughSeq;
    while (session.retainedInputs[0]?.seq !== undefined && session.retainedInputs[0]!.seq <= appliedThroughSeq) {
      const confirmed = session.retainedInputs.shift()!;
      session.retainedInputBytes -= confirmed.data.byteLength;
    }
    clearInputRetry(session);
    const blocked = session.retainedInputs.length >= MAX_RETAINED_INPUTS || session.retainedInputBytes >= MAX_RETAINED_INPUT_BYTES;
    publishInputState(route, session, blocked, session.retainedInputs.length > 0 ? "等待 PTY 累计确认" : "输入已确认");
    if (session.retainedInputs.length > 0) scheduleInputRetry(route, session);
  }

  function waitForSessionHolder(session: RoutedSession): Promise<void> {
    if (session.holderEpoch !== undefined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: HolderWaiter = {
        timer: clock.setTimeout(() => {
          session.holderWaiters.delete(waiter);
          reject(new DeviceRouteError("等待 session holder 超时"));
        }, CONTROL_REQUEST_TIMEOUT_MS),
        resolve,
        reject,
      };
      session.holderWaiters.add(waiter);
    });
  }

  function resolveHolderWaiters(session: RoutedSession): void {
    for (const waiter of session.holderWaiters) {
      clock.clearTimeout(waiter.timer);
      waiter.resolve();
    }
    session.holderWaiters.clear();
  }

  function rejectHolderWaiters(session: RoutedSession, error: Error): void {
    for (const waiter of session.holderWaiters) {
      clock.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    session.holderWaiters.clear();
  }

  function request(
    daemonId: string,
    scope: DeviceScope,
    payload: DeviceEnvelopePayload,
    timeoutMs = DEVICE_REQUEST_TIMEOUT_MS,
  ): Promise<RuntimeDevicePayload> {
    const normalized = normalizePayload(payload);
    const requestId = requestIdOf(normalized);
    if (!requestId) return Promise.reject(new DeviceRouteError("Device request 缺少 requestId"));
    const route = routeFor(daemonId);
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        const current = route.pendingRequests.get(requestId);
        if (!current) return;
        route.pendingRequests.delete(requestId);
        current.reject(new DeviceRouteError("Device request 超时", "request_timeout"));
        releaseIdle(route);
      }, timeoutMs);
      const pending: PendingRequest = { requestId, scope, payload: normalized, resolve, reject, timer };
      route.pendingRequests.set(requestId, pending);
      void ensureRoute(route, scope)
        .then(() => flushLane(route, scope === DeviceScope.RPC || scope === DeviceScope.LIFECYCLE ? "elevated" : "session"))
        .catch((error) => finishPendingWithError(route, pending, error));
    });
  }

  function finishPendingWithError(route: DeviceRoute, pending: PendingRequest, error: unknown): void {
    if (route.pendingRequests.get(pending.requestId) !== pending) return;
    route.pendingRequests.delete(pending.requestId);
    clock.clearTimeout(pending.timer);
    pending.reject(error instanceof Error ? error : new DeviceRouteError(String(error)));
    releaseIdle(route);
  }

  async function probeDevice(daemonId: string): Promise<void> {
    const route = routeFor(daemonId);
    route.transientDemand += 1;
    try {
      await ensureSessionLane(route);
    } finally {
      route.transientDemand = Math.max(0, route.transientDemand - 1);
      releaseIdle(route);
    }
  }

  function retainDevice(daemonId: string): () => void {
    const route = routeFor(daemonId);
    route.retainCount += 1;
    void ensureSessionLane(route).catch(() => scheduleRecovery(route, route.sessionLane));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (routes.get(daemonId) !== route) return;
      route.retainCount = Math.max(0, route.retainCount - 1);
      releaseIdle(route);
    };
  }

  function attachSession(daemonId: string, taskId: string, sessionId: string, cols: number, rows: number, force = false): void {
    const route = routeFor(daemonId);
    let session = route.sessions.get(sessionId);
    if (!session) {
      session = {
        daemonId,
        taskId,
        sessionId,
        desired: true,
        detached: false,
        cols: clampDim(cols, 80),
        rows: clampDim(rows, 24),
        inputSeq: 0n,
        ackedInputSeq: 0n,
        resizeSeq: 0n,
        hasLiveSnapshot: false,
        retainedInputs: [],
        retainedInputBytes: 0,
        holderWaiters: new Set(),
      };
      route.sessions.set(sessionId, session);
    } else {
      session.taskId = taskId;
      if (session.detached && !force) return;
      session.desired = true;
      if (force) session.detached = false;
      session.cols = clampDim(cols, session.cols);
      session.rows = clampDim(rows, session.rows);
    }
    if (force) session.holderEpoch = undefined;
    void ensureSessionLane(route)
      .then(() => sendAttach(route, session!, false))
      .catch(() => scheduleRecovery(route, route.sessionLane));
  }

  function seedCheckpoint(daemonId: string, taskId: string, sessionId: string, snapshotSeq: bigint): void {
    const route = routeFor(daemonId);
    const existing = route.sessions.get(sessionId);
    if (existing) {
      if (existing.checkpointSeq === undefined || snapshotSeq > existing.checkpointSeq) existing.checkpointSeq = snapshotSeq;
      return;
    }
    route.sessions.set(sessionId, {
      daemonId,
      taskId,
      sessionId,
      desired: false,
      detached: false,
      cols: 80,
      rows: 24,
      checkpointSeq: snapshotSeq,
      hasLiveSnapshot: false,
      inputSeq: 0n,
      ackedInputSeq: 0n,
      resizeSeq: 0n,
      retainedInputs: [],
      retainedInputBytes: 0,
      holderWaiters: new Set(),
    });
  }

  function sendInput(daemonId: string, sessionId: string, data: Uint8Array): boolean {
    const route = routeFor(daemonId);
    const session = route.sessions.get(sessionId);
    if (!session?.desired || session.detached || data.byteLength === 0) return false;
    const copy = copyBytes(data);
    if (
      session.retainedInputs.length >= MAX_RETAINED_INPUTS ||
      session.retainedInputBytes + copy.byteLength > MAX_RETAINED_INPUT_BYTES
    ) {
      publishInputState(route, session, true, "输入等待本机确认，缓冲区已满");
      return false;
    }
    session.inputSeq += 1n;
    const input: RetainedInput = { requestId: randomUUID(), seq: session.inputSeq, data: copy };
    session.retainedInputs.push(input);
    session.retainedInputBytes += copy.byteLength;
    const blocked = session.retainedInputs.length >= MAX_RETAINED_INPUTS || session.retainedInputBytes >= MAX_RETAINED_INPUT_BYTES;
    publishInputState(route, session, blocked, blocked ? "输入等待本机确认，缓冲区已满" : "等待 PTY 累计确认");
    const channel = route.sessionLane.active;
    if (channelCovers(channel, DeviceScope.SESSION_CONTROL) && session.holderEpoch !== undefined) {
      sendInputFrame(route, channel, session, input);
      scheduleInputRetry(route, session);
    } else {
      void ensureSessionLane(route)
        .then(() => sendAttach(route, session, false))
        .catch(() => scheduleRecovery(route, route.sessionLane));
    }
    return true;
  }

  function resize(daemonId: string, sessionId: string, cols: number, rows: number): void {
    const route = routeFor(daemonId);
    const session = route.sessions.get(sessionId);
    if (!session?.desired) return;
    session.cols = clampDim(cols, session.cols);
    session.rows = clampDim(rows, session.rows);
    session.resizeSeq += 1n;
    const resize: RetainedResize = {
      requestId: randomUUID(),
      seq: session.resizeSeq,
      cols: session.cols,
      rows: session.rows,
    };
    session.retainedResize = resize;
    const channel = route.sessionLane.active;
    if (channelCovers(channel, DeviceScope.SESSION_CONTROL) && session.holderEpoch !== undefined) {
      sendResizeFrame(route, channel, session, resize);
    }
  }

  async function stopSession(daemonId: string, sessionId: string): Promise<void> {
    const route = routeFor(daemonId);
    const session = route.sessions.get(sessionId);
    if (!session) throw new DeviceRouteError("本地没有该 session 的路由状态");
    if (session.holderEpoch === undefined) {
      attachSession(daemonId, session.taskId, sessionId, session.cols, session.rows, true);
      await waitForSessionHolder(session);
    }
    const requestId = randomUUID();
    const operationId = randomUUID();
    const response = await request(daemonId, DeviceScope.SESSION_CONTROL, {
      case: "sessionStop",
      value: { requestId, operationId, sessionId, holderEpoch: session.holderEpoch! },
    });
    if (response.case === "operationAck" && !response.value.ok) {
      throw new DeviceRouteError(response.value.error ?? "停止 session 失败");
    }
  }

  function forgetSession(daemonId: string, sessionId: string): void {
    const route = routes.get(daemonId);
    if (!route) return;
    const session = route.sessions.get(sessionId);
    if (session) {
      clearInputRetry(session);
      rejectHolderWaiters(session, new DeviceRouteError("session route 已释放"));
    }
    route.sessions.delete(sessionId);
    releaseIdle(route);
  }

  function suspendSession(daemonId: string, sessionId: string): void {
    const route = routes.get(daemonId);
    const session = route?.sessions.get(sessionId);
    if (!route || !session) return;
    session.desired = false;
    session.holderEpoch = undefined;
    session.outputSeq = undefined;
    session.hasLiveSnapshot = false;
    session.attachRequestId = undefined;
    session.attachGeneration = undefined;
    session.attachedGeneration = undefined;
    clearInputRetry(session);
    rejectHolderWaiters(session, new DeviceRouteError("terminal consumer 已释放"));
    releaseIdle(route);
  }

  async function exec(
    daemonId: string,
    workspaceId: string,
    command: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<WireExecResult> {
    const wireTimeout = timeoutMs === undefined ? undefined : Math.max(1, Math.floor(timeoutMs));
    const response = await request(daemonId, DeviceScope.RPC, {
      case: "execRun",
      value: { requestId: randomUUID(), workspaceId, command, args, timeoutMs: wireTimeout },
    }, (wireTimeout ?? DEFAULT_EXEC_TIMEOUT_MS) + TRANSPORT_DEADLINE_MARGIN_MS);
    if (response.case === "execResult") return response.value;
    throw unexpectedResponse("execResult", response);
  }

  async function fsList(daemonId: string, workspaceId: string, path: string, browseHome: boolean): Promise<FsListed> {
    const response = await request(daemonId, DeviceScope.RPC, {
      case: "fsList",
      value: { requestId: randomUUID(), workspaceId, path, browseHome },
    });
    if (response.case === "fsListed") return response.value;
    throw unexpectedResponse("fsListed", response);
  }

  async function fsRead(daemonId: string, workspaceId: string, path: string): Promise<FsReadResult> {
    const response = await request(daemonId, DeviceScope.RPC, {
      case: "fsRead",
      value: { requestId: randomUUID(), workspaceId, path },
    });
    if (response.case === "fsReadResult") return response.value;
    throw unexpectedResponse("fsReadResult", response);
  }

  async function fsWrite(daemonId: string, workspaceId: string, path: string, data: Uint8Array, temp: boolean): Promise<FsWriteResult> {
    const response = await request(daemonId, DeviceScope.RPC, {
      case: "fsWrite",
      value: {
        requestId: randomUUID(),
        operationId: randomUUID(),
        workspaceId,
        path,
        data,
        temp,
      },
    });
    if (response.case === "fsWriteResult") return response.value;
    throw unexpectedResponse("fsWriteResult", response);
  }

  async function requestPorts(daemonId: string): Promise<DevicePortsResult> {
    const response = await request(daemonId, DeviceScope.RPC, {
      case: "portsRequest",
      value: { requestId: randomUUID() },
    });
    if (response.case === "portsResult") return response.value;
    throw unexpectedResponse("portsResult", response);
  }

  function executePrepared(operation: PreparedDeviceOperation): void {
    if (
      !operation.operationId ||
      !operation.daemonId ||
      !Number.isFinite(operation.expiresAt) ||
      operation.expiresAt <= clock.now() ||
      operation.frame.byteLength === 0 ||
      operation.frame.byteLength > MAX_DEVICE_FRAME_BYTES
    ) return;
    const envelope = decodeDeviceEnvelope(operation.frame);
    if (
      !envelope ||
      envelope.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
      envelope.channelId !== "" ||
      !envelope.payload.case ||
      preparedOperationId(envelope.payload) !== operation.operationId
    ) {
      options.onError("server 下发了无效 prepared device operation");
      return;
    }
    const route = routeFor(operation.daemonId);
    route.pendingOperations.set(operation.operationId, {
      operationId: operation.operationId,
      requestId: requestIdOf(envelope.payload),
      payload: envelope.payload,
      expiresAt: operation.expiresAt,
    });
    void ensureElevatedLane(route, DeviceScope.LIFECYCLE)
      .then(() => flushLane(route, "elevated"))
      .catch(() => scheduleRecovery(route, route.elevatedLane));
  }

  function handleControlPayload(payload: ServerPayload): boolean {
    switch (payload.case) {
      case "localPairResult": {
        const waiter = pairWaiters.get(payload.value.requestId);
        if (!waiter) return true;
        pairWaiters.delete(payload.value.requestId);
        clock.clearTimeout(waiter.timer);
        waiter.abort?.();
        if (payload.value.ok && payload.value.grantId && payload.value.gateway) {
          waiter.resolve({ grantId: payload.value.grantId, gateway: payload.value.gateway });
        } else waiter.reject(new DeviceRouteError(payload.value.error ?? "本地配对失败"));
        return true;
      }
      case "localLeaseResult": {
        const waiter = leaseWaiters.get(payload.value.requestId);
        if (!waiter) return true;
        leaseWaiters.delete(payload.value.requestId);
        clock.clearTimeout(waiter.timer);
        waiter.abort?.();
        if (payload.value.ok && payload.value.lease) waiter.resolve(payload.value.lease);
        else waiter.reject(new DeviceRouteError(payload.value.error ?? "online lease 签发失败"));
        return true;
      }
      case "deviceRelayStatus": {
        const waiter = relayOpenWaiters.get(payload.value.channelId);
        if (!waiter) return true;
        relayOpenWaiters.delete(payload.value.channelId);
        clock.clearTimeout(waiter.timer);
        waiter.abort?.();
        if (payload.value.ok) waiter.resolve();
        else waiter.reject(new DeviceRouteError(payload.value.error ?? "relay channel 打开失败"));
        return true;
      }
      case "deviceRelayFrame": {
        const target = relayChannels.get(payload.value.channelId);
        if (target) receiveFrame(target.route, target.channel, payload.value.frame);
        return true;
      }
      case "deviceRelayClose": {
        const opening = relayOpenWaiters.get(payload.value.channelId);
        if (opening) {
          relayOpenWaiters.delete(payload.value.channelId);
          clock.clearTimeout(opening.timer);
          opening.abort?.();
          opening.reject(new DeviceRouteError(payload.value.reason ?? "relay channel 已关闭"));
        }
        const target = relayChannels.get(payload.value.channelId);
        if (target) loseChannel(target.route, target.channel, payload.value.reason ?? "relay channel 已关闭");
        return true;
      }
      case "preparedDeviceOperation":
        executePrepared(payload.value);
        return true;
      default:
        return false;
    }
  }

  function setControlOnline(online: boolean): void {
    if (controlOnline === online) return;
    controlOnline = online;
    if (!online) {
      rejectControlWaiters("中心连接已断开");
      for (const { route, channel } of [...relayChannels.values()]) loseChannel(route, channel, "中心 relay 已断开");
      for (const route of routes.values()) {
        route.lease = undefined;
        if (route.elevatedLane.active) closeLane(route, route.elevatedLane, "中心离线，online lease 已撤销");
        if (route.sessionLane.active?.kind === "direct") {
          publish(route, "direct", "中心离线；本地 session read/control 仍可用");
        }
      }
      return;
    }
    for (const route of routes.values()) {
      route.sessionLane.attempt?.startRelay?.();
      if (sessionLaneDemand(route)) {
        void ensureSessionLane(route)
          .then(() => flushLane(route, "session"))
          .catch(() => scheduleRecovery(route, route.sessionLane));
      }
      if (elevatedLaneDemand(route)) {
        void ensureElevatedLane(route, requiredElevatedScope(route))
          .then(() => flushLane(route, "elevated"))
          .catch(() => scheduleRecovery(route, route.elevatedLane));
      }
      if (!route.grantLoaded || !route.grant) pairInBackground(route);
      if (route.sessionLane.active?.kind === "relay") scheduleDirectRetry(route, true);
    }
  }

  async function reset(clearGrants: boolean): Promise<void> {
    setControlOnline(false);
    closeRoutes("Device router 已重置");
    // logout 会丢弃 route 内的 input cursor；同步更换 logical client，避免新输入与 sessiond
    // 为旧 clientInstanceId 保留的累计序号发生碰撞。普通 transport reset 仍保持原 identity/generation。
    if (clearGrants) {
      clientInstanceId = randomUUID();
      generations.clear();
    }
    if (clearGrants) await adapter.clearGrants().catch(() => undefined);
  }

  function destroy(): void {
    destroyed = true;
    setControlOnline(false);
    closeRoutes("Device router 已停止");
    adapter.close();
  }

  function closeRoutes(reason: string): void {
    for (const route of routes.values()) {
      closeRoute(route, reason);
    }
    routes.clear();
    relayChannels.clear();
  }

  function closeLane(route: DeviceRoute, lane: DeviceLane, reason: string): void {
    lane.token += 1;
    if (lane.recoveryTimer !== undefined) clock.clearTimeout(lane.recoveryTimer);
    lane.recoveryTimer = undefined;
    const attempt = lane.attempt;
    lane.attempt = undefined;
    if (attempt) {
      if (attempt.hedgeTimer !== undefined) clock.clearTimeout(attempt.hedgeTimer);
      attempt.controller.abort();
      if (!attempt.settled) {
        attempt.settled = true;
        attempt.reject(new DeviceRouteError(reason));
      }
    }
    const active = lane.active;
    lane.active = undefined;
    active?.close();
    if (lane.kind === "session") {
      for (const session of route.sessions.values()) {
        session.attachRequestId = undefined;
        session.attachGeneration = undefined;
        session.attachedGeneration = undefined;
      }
    }
  }

  function releaseIdle(route: DeviceRoute): void {
    const needsSession = sessionLaneDemand(route);
    const needsElevated = elevatedLaneDemand(route);
    if (!needsSession) {
      if (route.directRetryTimer !== undefined) clock.clearTimeout(route.directRetryTimer);
      route.directRetryTimer = undefined;
      route.directProbeController?.abort();
      route.directProbeController = undefined;
      route.directProbe = undefined;
      if (route.catalogTimer !== undefined) clock.clearInterval(route.catalogTimer);
      route.catalogTimer = undefined;
      closeLane(route, route.sessionLane, "session lane 已释放");
      publish(route, "idle", "没有活跃 session consumer 或请求");
    } else {
      maintainCatalogTimer(route);
    }
    if (!needsElevated) closeLane(route, route.elevatedLane, "elevated lane 已释放");
    if (!needsSession && !needsElevated) {
      const pairController = route.pairController;
      pairController?.abort();
      if (route.pairController === pairController) {
        route.pairController = undefined;
        route.pairPromise = undefined;
      }
    }
  }

  function closeRoute(route: DeviceRoute, reason: string): void {
    route.epoch += 1;
    if (route.directRetryTimer !== undefined) clock.clearTimeout(route.directRetryTimer);
    if (route.catalogTimer !== undefined) clock.clearInterval(route.catalogTimer);
    route.directRetryTimer = undefined;
    route.catalogTimer = undefined;
    route.directProbeController?.abort();
    route.directProbeController = undefined;
    route.directProbe = undefined;
    route.pairController?.abort();
    route.pairController = undefined;
    route.pairPromise = undefined;
    closeLane(route, route.sessionLane, reason);
    closeLane(route, route.elevatedLane, reason);
    for (const session of route.sessions.values()) {
      clearInputRetry(session);
      rejectHolderWaiters(session, new DeviceRouteError(reason));
    }
    for (const pending of route.pendingRequests.values()) {
      clock.clearTimeout(pending.timer);
      pending.reject(new DeviceRouteError(reason));
    }
    route.pendingRequests.clear();
    route.pendingOperations.clear();
  }

  function rejectControlWaiters(message: string): void {
    const error = new DeviceRouteError(message);
    for (const map of [pairWaiters, leaseWaiters] as const) {
      for (const waiter of map.values()) {
        clock.clearTimeout(waiter.timer);
        waiter.abort?.();
        waiter.reject(error);
      }
      map.clear();
    }
    for (const waiter of relayOpenWaiters.values()) {
      clock.clearTimeout(waiter.timer);
      waiter.abort?.();
      waiter.reject(error);
    }
    relayOpenWaiters.clear();
  }

  return {
    handleControlPayload,
    setControlOnline,
    probeDevice,
    retainDevice,
    attachSession,
    seedCheckpoint,
    sendInput,
    resize,
    stopSession,
    suspendSession,
    forgetSession,
    exec,
    fsList,
    fsRead,
    fsWrite,
    requestPorts,
    executePrepared,
    reset,
    destroy,
  };
}

export type DeviceRouter = ReturnType<typeof createDeviceRouter>;

function requestIdOf(payload: RuntimeDevicePayload): string | undefined {
  switch (payload.case) {
    case "sessionCatalogRequest":
    case "sessionAttach":
    case "sessionSnapshotRequest":
    case "ptyInput":
    case "ptyResize":
    case "sessionStop":
    case "sessionCreate":
    case "projectValidate":
    case "worktreeAdd":
    case "worktreeRemove":
    case "execRun":
    case "fsList":
    case "fsRead":
    case "fsWrite":
    case "portsRequest":
      return payload.value.requestId;
    default:
      return undefined;
  }
}

function responseRequestId(payload: RuntimeDevicePayload): string | undefined {
  switch (payload.case) {
    case "sessionCatalog":
    case "sessionAttached":
    case "sessionSnapshot":
    case "operationAck":
    case "projectValidated":
    case "worktreeAdded":
    case "execResult":
    case "fsListed":
    case "fsReadResult":
    case "fsWriteResult":
    case "portsResult":
      return payload.value.requestId;
    case "error":
      return payload.value.requestId;
    default:
      return undefined;
  }
}

function preparedOperationId(payload: RuntimeDevicePayload): string | undefined {
  switch (payload.case) {
    case "sessionCreate":
    case "projectValidate":
    case "worktreeAdd":
    case "worktreeRemove":
      return payload.value.operationId;
    default:
      return undefined;
  }
}

function unexpectedResponse(expected: string, payload: RuntimeDevicePayload): Error {
  return new DeviceRouteError(`Device response 类型不匹配：期望 ${expected}，收到 ${payload.case ?? "empty"}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function abortError(): DOMException {
  return new DOMException("Device route 操作已取消", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function waitForOpen(socket: WebSocket, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    let done = false;
    const timer = globalThis.setTimeout(() => finish(new DeviceRouteError("连接 loopback gateway 超时")), timeoutMs);
    const opened = () => finish();
    const failed = () => finish(new DeviceRouteError("浏览器拒绝或无法连接 loopback gateway"));
    const aborted = () => finish(abortError());
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      globalThis.clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function waitForEnvelope(socket: WebSocket, timeoutMs: number, signal: AbortSignal): Promise<DeviceEnvelope> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    let done = false;
    const timer = globalThis.setTimeout(() => finish(undefined, new DeviceRouteError("loopback gateway 握手超时")), timeoutMs);
    const message = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return finish(undefined, new DeviceRouteError("loopback gateway 握手不是 binary frame"));
      const envelope = decodeDeviceEnvelope(new Uint8Array(event.data));
      if (!envelope) return finish(undefined, new DeviceRouteError("loopback gateway 握手 envelope 畸形"));
      finish(envelope);
    };
    const closed = () => finish(undefined, new DeviceRouteError("loopback gateway 在握手期间关闭"));
    const aborted = () => finish(undefined, abortError());
    const finish = (envelope?: DeviceEnvelope, error?: Error) => {
      if (done) return;
      done = true;
      globalThis.clearTimeout(timer);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", closed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(envelope!);
    };
    socket.addEventListener("message", message, { once: true });
    socket.addEventListener("close", closed, { once: true });
    socket.addEventListener("error", closed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
  });
}
