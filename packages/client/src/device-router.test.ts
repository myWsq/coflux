/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  create,
  decodeDeviceEnvelope,
  encodeDeviceEnvelope,
  DEVICE_PROTOCOL_VERSION,
  DeviceEnvelopeSchema,
  DeviceScope,
  type DeviceEnvelopePayload,
  type LocalGatewayDescriptor,
} from "@coflux/protocol";

import {
  createDeviceRouter,
  type DeviceRouterAdapter,
  type DeviceRouterClock,
  type DeviceTransportOpenOptions,
  type DeviceTransportState,
  type OpenedDeviceTransport,
} from "./device-router";
import type { CachedLocalGrant } from "./browser-identity";

type Timer = ReturnType<typeof globalThis.setTimeout>;

class FakeClock implements DeviceRouterClock {
  current = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void; interval?: number }>();

  now = () => this.current;
  random = () => 0;

  setTimeout = (callback: () => void, delayMs: number): Timer => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id as unknown as Timer;
  };

  clearTimeout = (timer: Timer): void => {
    this.timers.delete(timer as unknown as number);
  };

  setInterval = (callback: () => void, delayMs: number): Timer => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + Math.max(1, delayMs), callback, interval: Math.max(1, delayMs) });
    return id as unknown as Timer;
  };

  clearInterval = this.clearTimeout;

  advance(ms: number): void {
    const target = this.current + ms;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.current = timer.at;
      if (timer.interval === undefined) this.timers.delete(id);
      else timer.at += timer.interval;
      timer.callback();
    }
    this.current = target;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

interface OpenCall {
  kind: "direct" | "relay";
  options: DeviceTransportOpenOptions;
  channelId: string;
  sent: Uint8Array<ArrayBuffer>[];
  closed: boolean;
  aborted: boolean;
  sendOk: boolean;
  resolve: (transport: OpenedDeviceTransport) => void;
  reject: (error: Error) => void;
}

const gateway: LocalGatewayDescriptor = {
  $typeName: "coflux.v1.LocalGatewayDescriptor",
  protocolVersion: DEVICE_PROTOCOL_VERSION,
  port: 8788,
  publicKeySec1: new Uint8Array([4, ...new Uint8Array(64)]),
};

function grant(daemonId = "daemon-1"): CachedLocalGrant {
  return { daemonId, grantId: `grant-${daemonId}`, gateway, updatedAt: 1 };
}

class FakeAdapter implements DeviceRouterAdapter {
  cachedGrant: CachedLocalGrant | undefined;
  pairedGrant: CachedLocalGrant | undefined;
  pairCalls = 0;
  leaseCalls = 0;
  removedGrants: string[] = [];
  clearCalls = 0;
  closed = false;
  readonly opens: OpenCall[] = [];

  constructor(cached?: CachedLocalGrant) {
    this.cachedGrant = cached;
    this.pairedGrant = grant();
  }

  async readGrant(): Promise<CachedLocalGrant | undefined> {
    return this.cachedGrant;
  }

  async pair(_daemonId: string, signal: AbortSignal): Promise<CachedLocalGrant> {
    this.pairCalls += 1;
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    this.cachedGrant = this.pairedGrant;
    return this.pairedGrant!;
  }

  async requestLease(daemonId: string, grantId: string, signal: AbortSignal) {
    this.leaseCalls += 1;
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return {
      $typeName: "coflux.v1.OnlineDeviceLease" as const,
      leaseId: `lease-${this.leaseCalls}`,
      grantId,
      accountId: "account-1",
      daemonId,
      scopes: [DeviceScope.RPC, DeviceScope.LIFECYCLE],
      expiresAt: 60_000,
    };
  }

  openDirect(options: DeviceTransportOpenOptions): Promise<OpenedDeviceTransport> {
    return this.open("direct", options);
  }

  openRelay(options: DeviceTransportOpenOptions): Promise<OpenedDeviceTransport> {
    return this.open("relay", options);
  }

  async removeGrant(daemonId: string): Promise<void> {
    this.removedGrants.push(daemonId);
    this.cachedGrant = undefined;
  }

  async clearGrants(): Promise<void> {
    this.clearCalls += 1;
    this.cachedGrant = undefined;
  }

  close(): void {
    this.closed = true;
  }

  resolve(call: OpenCall): void {
    const scopes = call.options.scope === DeviceScope.RPC || call.options.scope === DeviceScope.LIFECYCLE
      ? new Set([DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL, DeviceScope.RPC, DeviceScope.LIFECYCLE])
      : new Set([DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL]);
    call.resolve({
      channelId: call.channelId,
      scopes,
      leaseExpiresAt: call.kind === "direct" && scopes.has(DeviceScope.RPC) ? 60_000 : undefined,
      send: (frame) => {
        if (!call.sendOk || call.closed) return false;
        call.sent.push(frame);
        return true;
      },
      close: () => {
        call.closed = true;
      },
    });
  }

  fail(call: OpenCall, message = `${call.kind} failed`): void {
    call.reject(new Error(message));
  }

  emit(call: OpenCall, payload: DeviceEnvelopePayload): void {
    call.options.onFrame(encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      channelId: call.channelId,
      payload,
    })));
  }

  private open(kind: "direct" | "relay", options: DeviceTransportOpenOptions): Promise<OpenedDeviceTransport> {
    return new Promise((resolve, reject) => {
      const call: OpenCall = {
        kind,
        options,
        channelId: `${kind}-${options.generation}`,
        sent: [],
        closed: false,
        aborted: false,
        sendOk: true,
        resolve,
        reject,
      };
      options.signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
      this.opens.push(call);
    });
  }
}

function payloads(call: OpenCall) {
  return call.sent.map((frame) => decodeDeviceEnvelope(frame)?.payload).filter((payload) => payload?.case);
}

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function harness(adapter = new FakeAdapter(grant()), clock = new FakeClock()) {
  const states: DeviceTransportState[] = [];
  const snapshots: Uint8Array[] = [];
  const outputs: Uint8Array[] = [];
  const detached: string[] = [];
  const inputStates: Array<{ pendingCount: number; blocked: boolean }> = [];
  const errors: string[] = [];
  let uuid = 0;
  const router = createDeviceRouter({
    enableLocalTransport: true,
    identityDatabaseName: "unused-test-db",
    origin: "https://p.coflux.dev",
    sendControl: () => undefined,
    onTransportState: (_daemonId, state) => states.push(state),
    onSessionSnapshot: (_daemonId, _taskId, _sessionId, data) => snapshots.push(data),
    onSessionOutput: (_daemonId, _taskId, _sessionId, data) => outputs.push(data),
    onSessionAttached: () => undefined,
    onSessionDetached: (_daemonId, _taskId, _sessionId, reason) => detached.push(reason),
    onSessionExited: () => undefined,
    onCatalog: () => undefined,
    onPorts: () => undefined,
    onError: (message) => errors.push(message),
    onInputState: (_daemonId, _taskId, _sessionId, state) => inputStates.push(state),
    adapter,
    clock,
    randomUUID: () => `uuid-${++uuid}`,
  });
  return { router, adapter, clock, states, snapshots, outputs, detached, inputStates, errors };
}

function latestOpen(adapter: FakeAdapter, kind: "direct" | "relay", scope = DeviceScope.SESSION_CONTROL): OpenCall {
  const call = [...adapter.opens].reverse().find((item) => item.kind === kind && item.options.scope === scope);
  if (!call) throw new Error(`missing ${kind} open for scope ${scope}`);
  return call;
}

function attachRequest(call: OpenCall) {
  const payload = [...payloads(call)].reverse().find((item) => item?.case === "sessionAttach");
  if (payload?.case !== "sessionAttach") throw new Error("missing sessionAttach payload");
  return payload.value;
}

function attach(router: ReturnType<typeof createDeviceRouter>, adapter: FakeAdapter, call: OpenCall, snapshotSeq = 0n): void {
  const request = attachRequest(call);
  adapter.emit(call, {
    case: "sessionAttached",
    value: {
      requestId: request.requestId,
      sessionId: request.sessionId,
      holderEpoch: 1n,
      snapshotSeq,
      ansiSnapshot: new Uint8Array([27, 91, 72]),
      cols: 80,
      rows: 24,
    },
  });
  void router;
}

test("cached grant 从 t=0 直连，且 relay 严格延迟到 200ms hedge", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  assert.equal(h.adapter.pairCalls, 0);
  assert.equal(h.adapter.opens.filter((call) => call.kind === "direct").length, 1);
  assert.equal(h.adapter.opens.filter((call) => call.kind === "relay").length, 0);

  h.clock.advance(199);
  await flush();
  assert.equal(h.adapter.opens.filter((call) => call.kind === "relay").length, 0);
  h.clock.advance(1);
  await flush();
  assert.equal(h.adapter.opens.filter((call) => call.kind === "relay").length, 1);
  h.router.destroy();
});

test("relay 先赢后不发送双路业务，迟到 direct 以新 generation 自动升迁", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const firstDirect = latestOpen(h.adapter, "direct");
  h.clock.advance(200);
  await flush();
  const relay = latestOpen(h.adapter, "relay");
  h.adapter.resolve(relay);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "relay");

  h.adapter.resolve(firstDirect);
  await flush();
  assert.equal(firstDirect.closed, true);
  h.clock.advance(0);
  await flush();
  const promoted = latestOpen(h.adapter, "direct");
  assert.notEqual(promoted, firstDirect);
  assert.ok(promoted.options.generation > relay.options.generation);
  h.adapter.resolve(promoted);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "direct");
  assert.equal(payloads(relay).filter((payload) => payload?.case === "sessionAttach").length, 0);
  h.router.destroy();
});

test("无缓存时 relay 立即工作，pair 后后台迁回 direct", async () => {
  const adapter = new FakeAdapter(undefined);
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  assert.equal(adapter.pairCalls, 1);
  const relay = latestOpen(adapter, "relay");
  adapter.resolve(relay);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "relay");
  h.clock.advance(350);
  await flush();
  const direct = latestOpen(adapter, "direct");
  adapter.resolve(direct);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "direct");
  h.router.destroy();
});

test("elevated lane 的 direct/relay 失败不会关闭健康 session lane", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const release = h.router.retainDevice("daemon-1");
  await flush();
  const session = latestOpen(h.adapter, "direct");
  h.adapter.resolve(session);
  await flush();

  const pending = h.router.fsList("daemon-1", "workspace-1", "", false);
  await flush();
  const elevatedDirect = latestOpen(h.adapter, "direct", DeviceScope.RPC);
  h.adapter.fail(elevatedDirect);
  await flush();
  const elevatedRelay = latestOpen(h.adapter, "relay", DeviceScope.RPC);
  h.adapter.fail(elevatedRelay);
  await assert.rejects(pending, /高权限 Device lane 不可用/);
  assert.equal(session.closed, false);
  assert.equal(h.states.at(-1)?.mode, "direct");
  release();
  h.router.destroy();
});

test("generation 跨 release 与 reset 严格递增", async () => {
  const h = harness();
  const release1 = h.router.retainDevice("daemon-1");
  await flush();
  const first = latestOpen(h.adapter, "direct");
  h.adapter.resolve(first);
  await flush();
  release1();
  await flush();

  const release2 = h.router.retainDevice("daemon-1");
  await flush();
  const second = latestOpen(h.adapter, "direct");
  assert.ok(second.options.generation > first.options.generation);
  h.adapter.resolve(second);
  await flush();
  release2();
  await h.router.reset(false);

  h.router.retainDevice("daemon-1");
  await flush();
  const third = latestOpen(h.adapter, "direct");
  assert.ok(third.options.generation > second.options.generation);
  h.router.destroy();
});

test("detached 后自动 attach 被抑制，只有显式 force 才重新接管", async () => {
  const h = harness();
  h.router.retainDevice("daemon-1");
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  attach(h.router, h.adapter, direct);
  const before = payloads(direct).filter((payload) => payload?.case === "sessionAttach").length;
  h.adapter.emit(direct, { case: "sessionDetached", value: { sessionId: "session-1", holderEpoch: 1n, reason: "taken" } });
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24, false);
  await flush();
  assert.equal(payloads(direct).filter((payload) => payload?.case === "sessionAttach").length, before);
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24, true);
  await flush();
  assert.equal(payloads(direct).filter((payload) => payload?.case === "sessionAttach").length, before + 1);
  h.router.destroy();
});

test("累计 ACK 只释放确认前缀，ACK 丢失时活连接严格重投", async () => {
  const h = harness();
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  attach(h.router, h.adapter, direct);

  assert.equal(h.router.sendInput("daemon-1", "session-1", new Uint8Array([1])), true);
  assert.equal(h.router.sendInput("daemon-1", "session-1", new Uint8Array([2])), true);
  h.adapter.emit(direct, { case: "ptyInputAck", value: { sessionId: "session-1", appliedThroughSeq: 1n } });
  assert.equal(h.inputStates.at(-1)?.pendingCount, 1);
  const beforeRetry = payloads(direct).filter((payload) => payload?.case === "ptyInput").length;
  h.clock.advance(500);
  await flush();
  const retried = payloads(direct).filter((payload) => payload?.case === "ptyInput");
  assert.equal(retried.length, beforeRetry + 1);
  assert.equal(retried.at(-1)?.case === "ptyInput" ? retried.at(-1)!.value.inputSeq : 0n, 2n);
  h.adapter.emit(direct, { case: "ptyInputAck", value: { sessionId: "session-1", appliedThroughSeq: 2n } });
  assert.equal(h.inputStates.at(-1)?.pendingCount, 0);
  h.router.destroy();
});

test("输入队列满时拒绝新输入但不淘汰旧前缀", async () => {
  const h = harness();
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  attach(h.router, h.adapter, direct);
  for (let index = 0; index < 256; index += 1) {
    assert.equal(h.router.sendInput("daemon-1", "session-1", new Uint8Array([index % 255])), true);
  }
  assert.equal(h.router.sendInput("daemon-1", "session-1", new Uint8Array([9])), false);
  assert.equal(h.inputStates.at(-1)?.blocked, true);
  h.clock.advance(500);
  await flush();
  const retried = payloads(direct).filter((payload) => payload?.case === "ptyInput");
  assert.equal(retried.at(-256)?.case === "ptyInput" ? retried.at(-256)!.value.inputSeq : 0n, 1n);
  h.router.destroy();
});

test("send=false 触发 session lane 恢复，未确认 input 在新 transport 重投", async () => {
  const h = harness();
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const first = latestOpen(h.adapter, "direct");
  h.adapter.resolve(first);
  await flush();
  attach(h.router, h.adapter, first);
  first.sendOk = false;
  assert.equal(h.router.sendInput("daemon-1", "session-1", new Uint8Array([7])), true);
  assert.equal(first.closed, true);
  h.clock.advance(350);
  await flush();
  const recovered = latestOpen(h.adapter, "direct");
  assert.notEqual(recovered, first);
  h.adapter.resolve(recovered);
  await flush();
  attach(h.router, h.adapter, recovered);
  const inputs = payloads(recovered).filter((payload) => payload?.case === "ptyInput");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.case === "ptyInput" ? inputs[0].value.inputSeq : 0n, 1n);
  h.router.destroy();
});

test("checkpoint 不 seed live cursor，重复 gap 合并为单个 full attach", async () => {
  const h = harness();
  h.router.seedCheckpoint("daemon-1", "task-1", "session-1", 99n);
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  const firstAttach = attachRequest(direct);
  assert.equal(firstAttach.resumeFromSeq, undefined);
  attach(h.router, h.adapter, direct, 5n);
  const before = payloads(direct).filter((payload) => payload?.case === "sessionAttach").length;
  h.adapter.emit(direct, { case: "ptyGap", value: { sessionId: "session-1", expectedSeq: 6n, availableSeq: 9n } });
  h.adapter.emit(direct, { case: "ptyGap", value: { sessionId: "session-1", expectedSeq: 6n, availableSeq: 9n } });
  const attaches = payloads(direct).filter((payload) => payload?.case === "sessionAttach");
  assert.equal(attaches.length, before + 1);
  assert.equal(attaches.at(-1)?.case === "sessionAttach" ? attaches.at(-1)!.value.resumeFromSeq : 1n, undefined);
  h.router.destroy();
});

test("direct 先赢后迟到 relay 不能覆盖，release 后无重试与轮询残留", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const release = h.router.retainDevice("daemon-1");
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.clock.advance(200);
  await flush();
  const relay = latestOpen(h.adapter, "relay");
  h.adapter.resolve(direct);
  await flush();
  h.adapter.resolve(relay);
  await flush();
  assert.equal(relay.closed, true);
  assert.equal(h.states.at(-1)?.mode, "direct");
  const opens = h.adapter.opens.length;
  release();
  assert.equal(direct.closed, true);
  h.clock.advance(10_000);
  await flush();
  assert.equal(h.adapter.opens.length, opens);
  assert.equal(h.clock.pendingTimers, 0);
  h.router.destroy();
});
