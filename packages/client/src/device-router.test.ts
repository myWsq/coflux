/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  type OnlineDeviceLease,
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
  kind: "direct" | "p2p" | "relay";
  options: DeviceTransportOpenOptions & { grant?: CachedLocalGrant; lease?: OnlineDeviceLease };
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

function onlineLease(leaseId: string, daemonId = "daemon-1"): OnlineDeviceLease {
  return {
    $typeName: "coflux.v1.OnlineDeviceLease",
    leaseId,
    grantId: `grant-${daemonId}`,
    accountId: "account-1",
    daemonId,
    scopes: [DeviceScope.RPC, DeviceScope.LIFECYCLE],
    expiresAt: 60_000,
  };
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
    return { ...onlineLease(`lease-${this.leaseCalls}`, daemonId), grantId };
  }

  openDirect(options: DeviceTransportOpenOptions & { grant: CachedLocalGrant; lease?: OnlineDeviceLease }): Promise<OpenedDeviceTransport> {
    return this.open("direct", options);
  }

  openRelay(options: DeviceTransportOpenOptions): Promise<OpenedDeviceTransport> {
    return this.open("relay", options);
  }

  // 默认模拟无 WebRTC 的环境（node/旧浏览器）：立即拒绝，竞争落回 relay。
  // P2P 状态机用例见 P2pFakeAdapter。
  async openP2p(_options: DeviceTransportOpenOptions, _reuseOnly?: boolean): Promise<OpenedDeviceTransport> {
    throw new Error("环境不支持 WebRTC");
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

  resolve(call: OpenCall, lease?: OnlineDeviceLease): void {
    const scopes = call.options.scope === DeviceScope.RPC || call.options.scope === DeviceScope.LIFECYCLE
      ? new Set([DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL, DeviceScope.RPC, DeviceScope.LIFECYCLE])
      : new Set([DeviceScope.SESSION_READ, DeviceScope.SESSION_CONTROL]);
    call.resolve({
      channelId: call.channelId,
      scopes,
      leaseExpiresAt: call.kind === "direct" && scopes.has(DeviceScope.RPC) ? 60_000 : undefined,
      lease,
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

  protected open(
    kind: "direct" | "p2p" | "relay",
    options: DeviceTransportOpenOptions & { grant?: CachedLocalGrant; lease?: OnlineDeviceLease },
  ): Promise<OpenedDeviceTransport> {
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

/** P2P 可用的环境：openP2p 与 direct/relay 一样进入 pending 队列，由测试手动 resolve。 */
class P2pFakeAdapter extends FakeAdapter {
  override openP2p(options: DeviceTransportOpenOptions): Promise<OpenedDeviceTransport> {
    return this.open("p2p", options);
  }
}

class DeferredPairAdapter extends FakeAdapter {
  override pair(_daemonId: string, signal: AbortSignal): Promise<CachedLocalGrant> {
    this.pairCalls += 1;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }
}

class FlakyReadAdapter extends FakeAdapter {
  readCalls = 0;

  override async readGrant(): Promise<CachedLocalGrant | undefined> {
    this.readCalls += 1;
    if (this.readCalls === 1) throw new Error("IndexedDB temporarily blocked");
    return this.cachedGrant;
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

function latestOpen(adapter: FakeAdapter, kind: "direct" | "p2p" | "relay", scope = DeviceScope.SESSION_CONTROL): OpenCall {
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

type SharedRouterTraceStep =
  | { event: "sendInput"; utf8: string; expectSeq: string }
  | { event: "inputAck"; throughSeq: string }
  | { event: "setControlOnline"; online: boolean; expectChannelClosed?: boolean }
  | { event: "reopenSession"; holderEpoch: string; expectResumeFromSeq: string }
  | {
      event: "sessionCatalog";
      requestId: string;
      snapshotOwnerId: string;
      snapshotEpoch: string;
      eventIds: string[];
    }
  | {
      event: "expectExitAck";
      expectEventIds: string[];
      expectRequestId: string;
      expectSnapshotOwnerId: string;
      expectSnapshotEpoch: string;
    }
  | {
      event: "expectInputReplay";
      expectUniqueSeqs: string[];
      expectUtf8BySeq: Record<string, string>;
      expectHolderEpoch: string;
    };

interface SharedRouterTrace {
  id: string;
  description: string;
  daemonId: string;
  taskId: string;
  sessionId: string;
  initialSnapshotSeq: string;
  initialHolderEpoch: string;
  steps: SharedRouterTraceStep[];
}

interface SharedRouterTraceFixture {
  schemaVersion: number;
  traces: SharedRouterTrace[];
}

function loadSharedRouterTraces(): SharedRouterTrace[] {
  const fixture = JSON.parse(readFileSync(
    new URL("../../../tests/fixtures/device-router/behavior-traces.json", import.meta.url),
    "utf8",
  )) as SharedRouterTraceFixture;
  assert.equal(fixture.schemaVersion, 1, "未知的 DeviceRouter 共享 trace schema");
  assert.ok(Array.isArray(fixture.traces) && fixture.traces.length > 0, "DeviceRouter 共享 trace 不能为空");
  return fixture.traces;
}

async function runSharedRouterTrace(trace: SharedRouterTrace): Promise<void> {
  // Swift 是 relay-only；TS 解释共享 trace 时也固定走 relay，避免把 Web 独有的 direct/P2P
  // promotion 混进跨端契约。Deferred pair 使 relay 成为唯一可用候选，但仍运行真实 Router。
  const adapter = new DeferredPairAdapter();
  const h = harness(adapter);
  let active: OpenCall;
  try {
    h.router.setControlOnline(true);
    h.router.attachSession(trace.daemonId, trace.taskId, trace.sessionId, 80, 24);
    await flush();
    active = latestOpen(adapter, "relay");
    adapter.resolve(active);
    await flush();

    const initialAttach = attachRequest(active);
    assert.equal(initialAttach.resumeFromSeq, undefined, `${trace.id}: 首次 attach 不得猜测 resume cursor`);
    adapter.emit(active, {
      case: "sessionAttached",
      value: {
        requestId: initialAttach.requestId,
        sessionId: trace.sessionId,
        holderEpoch: BigInt(trace.initialHolderEpoch),
        snapshotSeq: BigInt(trace.initialSnapshotSeq),
        ansiSnapshot: new TextEncoder().encode("SNAPSHOT"),
        cols: 80,
        rows: 24,
      },
    });
    await flush();
    assert.equal(h.snapshots.length, 1, `${trace.id}: 初始 snapshot 未投递`);

    for (const step of trace.steps) {
      switch (step.event) {
        case "sendInput": {
          assert.equal(
            h.router.sendInput(trace.daemonId, trace.sessionId, new TextEncoder().encode(step.utf8)),
            true,
            `${trace.id}: input 应进入台账`,
          );
          const expectedSeq = BigInt(step.expectSeq);
          const sent = [...payloads(active)].reverse().find(
            (payload) => payload?.case === "ptyInput" && payload.value.inputSeq === expectedSeq,
          );
          assert.equal(sent?.case, "ptyInput", `${trace.id}: 缺少 input_seq=${step.expectSeq}`);
          if (sent?.case === "ptyInput") {
            assert.equal(new TextDecoder().decode(sent.value.data), step.utf8, `${trace.id}: input 数据漂移`);
          }
          break;
        }
        case "inputAck":
          adapter.emit(active, {
            case: "ptyInputAck",
            value: { sessionId: trace.sessionId, appliedThroughSeq: BigInt(step.throughSeq) },
          });
          break;
        case "setControlOnline":
          h.router.setControlOnline(step.online);
          await flush();
          if (step.expectChannelClosed !== undefined) {
            assert.equal(active.closed, step.expectChannelClosed, `${trace.id}: control 状态切换后的 channel 生命周期漂移`);
          }
          break;
        case "reopenSession": {
          const reopened = latestOpen(adapter, "relay");
          assert.notEqual(reopened, active, `${trace.id}: control 恢复后必须建立新 relay`);
          adapter.resolve(reopened);
          await flush();
          const resumed = attachRequest(reopened);
          assert.equal(
            resumed.resumeFromSeq,
            BigInt(step.expectResumeFromSeq),
            `${trace.id}: 重连 attach 未沿用已应用输出游标`,
          );
          adapter.emit(reopened, {
            case: "sessionAttached",
            value: {
              requestId: resumed.requestId,
              sessionId: trace.sessionId,
              holderEpoch: BigInt(step.holderEpoch),
              snapshotSeq: BigInt(step.expectResumeFromSeq),
              cols: 80,
              rows: 24,
            },
          });
          await flush();
          active = reopened;
          break;
        }
        case "sessionCatalog":
          adapter.emit(active, {
            case: "sessionCatalog",
            value: {
              requestId: step.requestId,
              sessions: [],
              exits: step.eventIds.map((eventId, index) => ({
                eventId,
                sessionId: `exited-session-${index}`,
                taskId: `exited-task-${index}`,
                exitCode: index,
                finalOutputSeq: BigInt(index),
                exitedAt: index + 1,
              })),
              snapshotOwnerId: step.snapshotOwnerId,
              snapshotEpoch: BigInt(step.snapshotEpoch),
            },
          });
          break;
        case "expectExitAck": {
          const ack = [...payloads(active)].reverse().find((payload) => payload?.case === "exitAck");
          assert.equal(ack?.case, "exitAck", `${trace.id}: catalog exits 未产生 ACK`);
          if (ack?.case === "exitAck") {
            assert.deepEqual(ack.value.eventIds, step.expectEventIds, `${trace.id}: exitAck 未过滤空 eventId`);
            assert.equal(ack.value.requestId, step.expectRequestId, `${trace.id}: exitAck requestId 未绑定 catalog`);
            assert.equal(
              ack.value.snapshotOwnerId,
              step.expectSnapshotOwnerId,
              `${trace.id}: exitAck snapshotOwnerId 未绑定 catalog`,
            );
            assert.equal(
              ack.value.snapshotEpoch,
              BigInt(step.expectSnapshotEpoch),
              `${trace.id}: exitAck snapshotEpoch 未绑定 catalog`,
            );
          }
          break;
        }
        case "expectInputReplay": {
          const frames = payloads(active).flatMap((payload) => payload?.case === "ptyInput" ? [payload.value] : []);
          assert.ok(frames.length > 0, `${trace.id}: 重连后未重投输入`);
          const uniqueSeqs = [...new Set(frames.map((frame) => frame.inputSeq.toString()))]
            .sort((left, right) => {
              const leftSeq = BigInt(left);
              const rightSeq = BigInt(right);
              return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0;
            });
          assert.deepEqual(uniqueSeqs, step.expectUniqueSeqs, `${trace.id}: ACK 前缀被重复投递或未确认后缀丢失`);
          assert.ok(
            frames.every((frame) => frame.holderEpoch === BigInt(step.expectHolderEpoch)),
            `${trace.id}: replay 未采用新 holder epoch`,
          );
          const utf8BySeq = Object.fromEntries(
            frames.map((frame) => [frame.inputSeq.toString(), new TextDecoder().decode(frame.data)]),
          );
          assert.deepEqual(utf8BySeq, step.expectUtf8BySeq, `${trace.id}: replay 数据与 seq 映射漂移`);
          break;
        }
        default:
          assert.fail(`${trace.id}: 未实现的共享 trace 事件`);
      }
    }
    assert.deepEqual(h.errors, [], `${trace.id}: trace 不应产生 Router 错误`);
  } finally {
    h.router.destroy();
  }
}

for (const trace of loadSharedRouterTraces()) {
  test(`共享 DeviceRouter trace：${trace.id}`, async () => runSharedRouterTrace(trace));
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

test("缓存读取的瞬时失败不会永久禁用离线 direct", async () => {
  const adapter = new FlakyReadAdapter(grant());
  const h = harness(adapter);
  h.router.retainDevice("daemon-1");
  await flush();
  assert.equal(h.states.at(-1)?.mode, "offline");
  assert.equal(adapter.readCalls, 1);
  h.clock.advance(350);
  await flush();
  assert.equal(adapter.readCalls, 2);
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

test("direct 内部续签采用的新 lease 会写回 route 并供下一条 elevated lane 复用", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const firstResult = h.router.fsList("daemon-1", "workspace-1", "", false);
  await flush();
  const first = latestOpen(h.adapter, "direct", DeviceScope.RPC);
  assert.equal(first.options.lease?.leaseId, "lease-1");
  const refreshed = onlineLease("lease-refreshed");
  h.adapter.resolve(first, refreshed);
  await flush();
  const firstRequest = payloads(first).find((payload) => payload?.case === "fsList");
  assert.equal(firstRequest?.case, "fsList");
  h.adapter.emit(first, {
    case: "fsListed",
    value: { requestId: firstRequest!.value.requestId, ok: true, entries: [] },
  });
  await firstResult;

  const secondResult = h.router.fsList("daemon-1", "workspace-1", "", false);
  await flush();
  const second = latestOpen(h.adapter, "direct", DeviceScope.RPC);
  assert.notEqual(second, first);
  assert.equal(h.adapter.leaseCalls, 1);
  assert.equal(second.options.lease?.leaseId, refreshed.leaseId);
  h.adapter.resolve(second, refreshed);
  await flush();
  const secondRequest = payloads(second).find((payload) => payload?.case === "fsList");
  assert.equal(secondRequest?.case, "fsList");
  h.adapter.emit(second, {
    case: "fsListed",
    value: { requestId: secondRequest!.value.requestId, ok: true, entries: [] },
  });
  await secondResult;
  h.router.destroy();
});

test("direct elevated scope_denied 会废弃旧 lease 并重新签发", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const result = h.router.fsList("daemon-1", "workspace-1", "", false);
  await flush();
  const first = latestOpen(h.adapter, "direct", DeviceScope.RPC);
  h.adapter.resolve(first);
  await flush();
  const request = payloads(first).find((payload) => payload?.case === "fsList");
  assert.equal(request?.case, "fsList");
  h.adapter.emit(first, {
    case: "error",
    value: { requestId: request!.value.requestId, code: "scope_denied", message: "lease rejected" },
  });
  await flush();
  const retried = latestOpen(h.adapter, "direct", DeviceScope.RPC);
  assert.notEqual(retried, first);
  assert.equal(h.adapter.leaseCalls, 2);
  assert.equal(retried.options.lease?.leaseId, "lease-2");
  h.adapter.resolve(retried);
  await flush();
  const retriedRequest = payloads(retried).find((payload) => payload?.case === "fsList");
  assert.equal(retriedRequest?.case, "fsList");
  h.adapter.emit(retried, {
    case: "fsListed",
    value: { requestId: retriedRequest!.value.requestId, ok: true, entries: [] },
  });
  await result;
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

test("logout 清空 grant 时更换 logical client，避免沿用已丢失的 input cursor", async () => {
  const h = harness();
  const release = h.router.retainDevice("daemon-1");
  await flush();
  const first = latestOpen(h.adapter, "direct");
  h.adapter.resolve(first);
  await flush();
  release();

  await h.router.reset(true);
  h.adapter.cachedGrant = grant();
  h.router.retainDevice("daemon-1");
  await flush();
  const second = latestOpen(h.adapter, "direct");
  assert.notEqual(second.options.clientInstanceId, first.options.clientInstanceId);
  assert.equal(second.options.generation, 1n);
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

test("attach 返回 stale_holder 后释放无其它 demand 的 session lane", async () => {
  const h = harness();
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  const request = attachRequest(direct);
  h.adapter.emit(direct, {
    case: "error",
    value: { requestId: request.requestId, code: "stale_holder", message: "taken" },
  });
  await flush();
  assert.equal(direct.closed, true);
  assert.equal(h.detached.at(-1), "taken");
  assert.equal(h.clock.pendingTimers, 0);
  h.router.destroy();
});

test("attach 返回 session_not_found 时 stopSession 立即带 code 失败，不空等 holder", async () => {
  const h = harness();
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  const stopped = h.router.stopSession("daemon-1", "session-1").then(
    () => undefined,
    (error: { code?: string }) => error,
  );
  await flush();
  const request = attachRequest(direct);
  h.adapter.emit(direct, {
    case: "error",
    value: { requestId: request.requestId, code: "session_not_found", message: "session 不存在或已退出" },
  });
  await flush();
  // 推进过 holder 超时：修复前要空等到这里才得到无从判定的「等待 session holder 超时」，
  // 上层据此中止、不删 catalog task（残留 tab 永远关不掉）。
  h.clock.advance(10_000); // > CONTROL_REQUEST_TIMEOUT_MS
  await flush();
  const error = await stopped;
  assert.equal((error as { code?: string })?.code, "session_not_found");
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
  assert.equal(h.inputStates.at(-1)?.blocked, true);
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

test("已完成 attach 的重复 response 不会覆盖 live snapshot", async () => {
  const h = harness();
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  const request = attachRequest(direct);
  attach(h.router, h.adapter, direct, 12n);
  assert.equal(h.snapshots.length, 1);
  h.adapter.emit(direct, {
    case: "sessionAttached",
    value: {
      requestId: request.requestId,
      sessionId: request.sessionId,
      holderEpoch: 1n,
      snapshotSeq: 3n,
      ansiSnapshot: new Uint8Array([9]),
      cols: 80,
      rows: 24,
    },
  });
  assert.equal(h.snapshots.length, 1);
  h.router.destroy();
});

test("terminal consumer 释放后丢弃 live cursor，重新 attach 必须取完整 snapshot", async () => {
  const h = harness();
  h.router.retainDevice("daemon-1");
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  attach(h.router, h.adapter, direct, 12n);
  h.router.suspendSession("daemon-1", "session-1");
  h.router.attachSession("daemon-1", "task-1", "session-1", 80, 24);
  await flush();
  const request = attachRequest(direct);
  assert.equal(request.resumeFromSeq, undefined);
  h.router.destroy();
});

test("初始 direct 与 relay 都失败后发布 offline 并进入有界恢复", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.clock.advance(200);
  await flush();
  const relay = latestOpen(h.adapter, "relay");
  h.adapter.fail(direct, "gateway down");
  h.adapter.fail(relay, "relay down");
  await flush();
  assert.equal(h.states.at(-1)?.mode, "offline");
  assert.match(h.states.at(-1)?.detail ?? "", /gateway down/);
  assert.ok(h.clock.pendingTimers > 0);
  h.router.destroy();
});

test("catalog 请求与 exit ACK 的 send=false 都触发 session lane 恢复", async () => {
  const catalog = harness();
  catalog.router.retainDevice("daemon-1");
  await flush();
  const catalogChannel = latestOpen(catalog.adapter, "direct");
  catalogChannel.sendOk = false;
  catalog.adapter.resolve(catalogChannel);
  await flush();
  assert.equal(catalogChannel.closed, true);
  assert.equal(catalog.states.at(-1)?.mode, "offline");
  assert.match(catalog.states.at(-1)?.detail ?? "", /catalog/);
  catalog.router.destroy();

  const ack = harness();
  ack.router.retainDevice("daemon-1");
  await flush();
  const ackChannel = latestOpen(ack.adapter, "direct");
  ack.adapter.resolve(ackChannel);
  await flush();
  ackChannel.sendOk = false;
  ack.adapter.emit(ackChannel, {
    case: "sessionCatalog",
    value: {
      requestId: "catalog-1",
      sessions: [],
      exits: [{
        eventId: "exit-1",
        sessionId: "session-1",
        taskId: "task-1",
        exitCode: 0,
        finalOutputSeq: 0n,
        exitedAt: 1,
      }],
    },
  });
  assert.equal(ackChannel.closed, true);
  assert.equal(ack.states.at(-1)?.mode, "offline");
  assert.match(ack.states.at(-1)?.detail ?? "", /exit ACK/);
  ack.router.destroy();
});

test("release 会立即取消并清除后台 pair，下一次 demand 可重新配对", async () => {
  const adapter = new DeferredPairAdapter();
  const h = harness(adapter);
  h.router.setControlOnline(true);
  const release = h.router.retainDevice("daemon-1");
  await flush();
  assert.equal(adapter.pairCalls, 1);
  const firstRelay = latestOpen(adapter, "relay");
  adapter.resolve(firstRelay);
  await flush();

  release();
  h.router.retainDevice("daemon-1");
  await flush();
  assert.equal(adapter.pairCalls, 2);
  h.router.destroy();
});

test("离线 prepared operation 过期后停止 elevated recovery", async () => {
  const h = harness();
  const operationId = "operation-1";
  const frame = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    channelId: "",
    payload: {
      case: "sessionCreate",
      value: {
        requestId: "request-1",
        operationId,
        sessionId: "session-1",
        taskId: "task-1",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      },
    },
  }));
  h.router.executePrepared({
    $typeName: "coflux.v1.PreparedDeviceOperation",
    operationId,
    daemonId: "daemon-1",
    frame,
    expiresAt: 100,
  });
  await flush();
  assert.ok(h.clock.pendingTimers > 0);
  h.clock.advance(350);
  await flush();
  assert.equal(h.clock.pendingTimers, 0);
  assert.match(h.errors.at(-1) ?? "", /已过期/);
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

test("心跳往返产生 rttMs，链路断掉后读数被清掉而不是留着", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const release = h.router.retainDevice("daemon-1");
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();

  // 建连即打第一发，不等满一个周期——否则 UI 头 15s 没有读数。
  const ping = payloads(direct).find((payload) => payload?.case === "ping");
  assert.ok(ping, "建连后应立刻发出一次 ping");

  // daemon 侧 echo 回来时已过 42ms：这个差值就是 rtt。
  h.clock.advance(42);
  h.adapter.emit(direct, { case: "pong", value: { requestId: (ping.value as { requestId: string }).requestId } });
  await flush();
  assert.equal(h.states.at(-1)?.rttMs, 42);

  // 周期到点会再打一发（而不是只打建连那一次）。
  const before = payloads(direct).filter((payload) => payload?.case === "ping").length;
  h.clock.advance(15_000);
  await flush();
  assert.equal(payloads(direct).filter((payload) => payload?.case === "ping").length, before + 1);

  // 链路掉了必须清读数：留着上一次的 42ms 会让一条已断的链路在 UI 上继续显示"很快"。
  release();
  await flush();
  assert.equal(h.states.at(-1)?.rttMs, undefined);
  h.router.destroy();
});

/* ===== 心跳承担探活（plan 080 M4）=====
 * 通道"状态是 open、实际已死"时，onclose 未必会来——WebRTC DataChannel 要等 ~30s ICE
 * 超时。心跳每 15s 就能发现，此前却只抹 rtt 读数不摘通道，用户于是对着死通道敲键盘。 */

test("通道静默死亡：连续两次心跳无响应即摘掉通道", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  assert.equal(payloads(direct).filter((payload) => payload?.case === "ping").length, 1, "建连即发第一发");

  // 首发超时：记一次 miss 并**立刻**补发，不等下一个完整周期——否则判死要拖到两个周期后，
  // 比 ICE 超时还慢，等于没修。
  h.clock.advance(5_000);
  await flush();
  assert.equal(payloads(direct).filter((payload) => payload?.case === "ping").length, 2, "首次超时应立刻补发");
  assert.equal(direct.closed, false, "一次无响应不足以判死");

  h.clock.advance(5_000);
  await flush();
  assert.equal(direct.closed, true, "连续两次无响应即摘通道（累计 ~10s，快于 30s ICE 超时）");
  h.router.destroy();
});

test("偶发丢包不判死：补发拿到 pong 后 miss 计数归零", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();

  h.clock.advance(5_000); // 首发丢了，补发第二发
  await flush();
  const pings = payloads(direct).filter((payload) => payload?.case === "ping");
  assert.equal(pings.length, 2);
  h.adapter.emit(direct, { case: "pong", value: { requestId: (pings[1]!.value as { requestId: string }).requestId } });
  await flush();
  assert.equal(direct.closed, false);

  // 计数归零的证据：再让**一发**超时，仍不该判死（若未归零，这一发就是第二次 miss）。
  // 心跳周期从建连起算，下一个周期点在 t=15000；此刻 t=5000，故先推 10s 到点发出，
  // 再推 5s 让它超时——只跨一个超时点，多推会累出第二次 miss，那测的就不是这条了。
  h.clock.advance(10_000);
  await flush();
  h.clock.advance(5_000);
  await flush();
  assert.equal(direct.closed, false, "拿到 pong 后 miss 必须归零，否则通道会背着旧欠账被判死");
  h.router.destroy();
});

test("旧 daemon 不支持 ping 时不得被判成通道已死", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();

  h.adapter.emit(direct, { case: "error", value: { code: "empty_payload", message: "DeviceEnvelope payload 为空" } });
  await flush();

  // 旧 daemon 永远不会回 pong：若 miss 计数不跟着清零、超时闸不撤，它会被无限摘通道重连。
  h.clock.advance(60_000);
  await flush();
  assert.equal(direct.closed, false, "只是对端太老，不是通道死了");
  h.router.destroy();
});

test("旧 daemon 对 ping 回 unsupported_payload 时静默降级，不弹错误", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const release = h.router.retainDevice("daemon-1");
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  h.adapter.resolve(direct);
  await flush();
  const ping = payloads(direct).find((payload) => payload?.case === "ping");
  assert.ok(ping, "建连后应发出 ping");

  const errorsBefore = h.errors.length;
  // 真实回归（2026-07-26 线上）：旧 daemon 的 prost 解不出 ping 的字段号，整个 payload 落成
  // None，于是回的是 **不带 requestId** 的 empty_payload。按 requestId 匹配的拦截够不着它，
  // 错误一路落到 onError，每 15s 弹一次。requestId 缺席是这条用例的全部要害，别给它补上。
  h.adapter.emit(direct, {
    case: "error",
    value: {
      code: "empty_payload",
      message: "DeviceEnvelope payload 为空",
    },
  });
  await flush();
  assert.equal(h.errors.length, errorsBefore, "旧 daemon 不认识 ping 不该弹给用户");
  assert.equal(h.states.at(-1)?.rttMs, undefined);

  // 归因之后必须彻底停发：在旧 daemon 上心跳永远不会成功，再发只是白费往返 + 再弹一次。
  const pingsBefore = payloads(direct).filter((payload) => payload?.case === "ping").length;
  h.clock.advance(60_000);
  await flush();
  assert.equal(payloads(direct).filter((payload) => payload?.case === "ping").length, pingsBefore, "已判定不支持后不该继续发心跳");
  assert.equal(h.errors.length, errorsBefore, "更不该继续弹错误");
  release();
  h.router.destroy();
});

test("measureOnly 持有只建 relay：不读 grant、不试 direct、不配对、不轮询 catalog", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const release = h.router.retainDevice("daemon-1", { measureOnly: true });
  await flush();

  // 本机有 cached grant（harness 默认给了），完整持有本会从 t=0 抢 direct；measureOnly 必须
  // 跳过整条本地路径——direct 走 loopback，只有与浏览器同机的设备可能命中，为侧栏一个读数
  // 去敲它，对其余设备就是每 5s 一次注定失败的重试。
  assert.equal(h.adapter.opens.filter((call) => call.kind === "direct").length, 0, "不该尝试 direct");
  assert.equal(h.adapter.pairCalls, 0, "不该发起本机配对");
  const relay = latestOpen(h.adapter, "relay");
  h.adapter.resolve(relay);
  await flush();

  // 该有的还得有：心跳照发，否则侧栏拿不到读数，这层持有就没意义了。
  assert.ok(payloads(relay).some((payload) => payload?.case === "ping"), "measureOnly 仍须发心跳");
  // 不该有的：catalog 轮询是给真正在用这台设备的人的。
  assert.equal(payloads(relay).filter((payload) => payload?.case === "sessionCatalogRequest").length, 0, "不该轮询 catalog");

  h.clock.advance(30_000);
  await flush();
  assert.equal(h.adapter.opens.filter((call) => call.kind === "direct").length, 0, "30s 内也不该冒出 direct 重试");
  assert.equal(h.adapter.pairCalls, 0, "30s 内也不该冒出配对");

  release();
  h.router.destroy();
});

test("measureOnly 之上叠加完整持有会立即提升 direct，且释放完整持有后连接仍在", async () => {
  const h = harness();
  h.router.setControlOnline(true);
  const releaseMeasure = h.router.retainDevice("daemon-1", { measureOnly: true });
  await flush();
  h.adapter.resolve(latestOpen(h.adapter, "relay"));
  await flush();
  assert.equal(h.states.at(-1)?.mode, "relay");

  // 进项目：此时 lane 已是测量期建好的 relay，它当时刻意跳过了 direct。不补这一下，
  // 本机设备会一直用着 relay，永远升不回 direct。
  const releaseFull = h.router.retainDevice("daemon-1");
  h.clock.advance(1); // immediate 提升排的是 delay=0 的 timer，FakeClock 要走一步才触发
  await flush();
  const direct = latestOpen(h.adapter, "direct");
  assert.ok(direct, "完整持有必须立即触发 direct 提升");
  h.adapter.resolve(direct);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "direct");

  // 退出项目：measureOnly 还在，连接不该被拆掉（侧栏还要读数）。
  releaseFull();
  await flush();
  assert.equal(h.states.at(-1)?.mode, "direct", "measureOnly 仍持有时不该掉线");
  releaseMeasure();
  h.router.destroy();
});

test("无 grant 设备 P2P 参与直连槽位：relay 先赢，迟到 P2P 经重试自动升迁", async () => {
  const adapter = new P2pFakeAdapter(undefined);
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const firstP2p = latestOpen(adapter, "p2p");
  h.clock.advance(200);
  await flush();
  const relay = latestOpen(adapter, "relay");
  adapter.resolve(relay);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "relay");

  // 迟到的 P2P generation 落后于 relay winner：关闭并立即以新 generation 重试（与 direct 同语义）。
  adapter.resolve(firstP2p);
  await flush();
  assert.equal(firstP2p.closed, true);
  h.clock.advance(0);
  await flush();
  // pair 在后台已成功（中心协助配对不验证同机），升级 probe 先撞 loopback；
  // 远程设备上它连不通，随后才轮到 P2P——这正是非同机设备的真实序列。
  const retryDirect = latestOpen(adapter, "direct");
  retryDirect.reject(new Error("connection refused"));
  await flush();
  const promoted = latestOpen(adapter, "p2p");
  assert.notEqual(promoted, firstP2p);
  assert.ok(promoted.options.generation > relay.options.generation);
  adapter.resolve(promoted);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "p2p");
  assert.equal(payloads(relay).filter((payload) => payload?.case === "sessionAttach").length, 0);
  h.router.destroy();
});

// 事故复现（2026-08-17）：P2P 靠 promotion 顶掉正常工作的 relay，随后 DataChannel 崩掉，
// 而 webrtc 的 onclose 要等 ~30s ICE 超时才来——那 30s 里用户的每次按键都发进黑洞。
// 心跳判死把这个窗口压到 ~10s，并让 relay 重新接管。
test("P2P 建成后静默停止响应：心跳判死摘掉它，relay 重新接管", async () => {
  const adapter = new P2pFakeAdapter(undefined);
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const firstP2p = latestOpen(adapter, "p2p");
  h.clock.advance(200);
  await flush();
  const relay = latestOpen(adapter, "relay");
  adapter.resolve(relay);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "relay");

  // 迟到的 P2P 以新 generation 升迁，顶掉正在工作的 relay（plan 076 的既有设计）。
  adapter.resolve(firstP2p);
  await flush();
  h.clock.advance(0);
  await flush();
  latestOpen(adapter, "direct").reject(new Error("connection refused"));
  await flush();
  const promoted = latestOpen(adapter, "p2p");
  adapter.resolve(promoted);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "p2p", "前置：P2P 已接管");

  // 此刻 DataChannel 静默死亡：不回 pong，也不触发 onclose（正是 WebRTC 的实际行为）。
  h.clock.advance(5_000);
  await flush();
  assert.equal(promoted.closed, false, "一次无响应不判死");
  h.clock.advance(5_000);
  await flush();
  assert.equal(promoted.closed, true, "连续两次无响应即摘掉这条 P2P");

  // recovery 重新竞速：loopback 依旧不通，relay 再次接管。
  h.clock.advance(1_000);
  await flush();
  latestOpen(adapter, "direct").reject(new Error("connection refused"));
  await flush();
  h.clock.advance(200);
  await flush();
  const relay2 = latestOpen(adapter, "relay");
  assert.notEqual(relay2, relay, "应建一条新的 relay 通道");
  adapter.resolve(relay2);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "relay", "P2P 判死后必须回落 relay——这正是事故里没发生的事");
  h.router.destroy();
});

test("P2P 判死后进入退避：重新竞速时不再发起，relay 稳住不被反复抢占", async () => {
  const adapter = new P2pFakeAdapter(undefined);
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const firstP2p = latestOpen(adapter, "p2p");
  h.clock.advance(200);
  await flush();
  adapter.resolve(latestOpen(adapter, "relay"));
  await flush();
  adapter.resolve(firstP2p);
  await flush();
  h.clock.advance(0);
  await flush();
  latestOpen(adapter, "direct").reject(new Error("connection refused"));
  await flush();
  const promoted = latestOpen(adapter, "p2p");
  adapter.resolve(promoted);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "p2p", "前置：P2P 已接管");

  // 静默死亡 → 判死
  h.clock.advance(5_000);
  await flush();
  h.clock.advance(5_000);
  await flush();
  assert.equal(promoted.closed, true);
  const p2pOpensAtDeath = adapter.opens.filter((call) => call.kind === "p2p").length;

  // recovery 重新竞速：loopback 仍不通，relay 接管。
  h.clock.advance(1_000);
  await flush();
  latestOpen(adapter, "direct").reject(new Error("connection refused"));
  await flush();
  h.clock.advance(200);
  await flush();
  adapter.resolve(latestOpen(adapter, "relay"));
  await flush();
  assert.equal(h.states.at(-1)?.mode, "relay");
  assert.equal(
    adapter.opens.filter((call) => call.kind === "p2p").length,
    p2pOpensAtDeath,
    "退避期内一次都不该再发起 P2P——否则它建成就 promotion 抢走 relay，崩一次抢一次",
  );

  // 退避到期前始终不发起：再推一段仍在窗口内的时间，并触发一次直连重试。
  h.clock.advance(3_000);
  await flush();
  assert.equal(
    adapter.opens.filter((call) => call.kind === "p2p").length,
    p2pOpensAtDeath,
    "退避未到期就不该重新发起",
  );
  h.router.destroy();
});

/* ===== 控制面判死不连坐（plan 080 M3）=====
 * 浏览器 `/client` 与 worker `/daemon` 是两条独立控制连接。这里复现的是事故中的前者短暂
 * 断开、后者仍在线：既有 relay session lane 应继续工作；新 rendezvous 与高权限能力仍关闭。 */

test("client 控制面在 15s 宽限内恢复时保留同一条 relay", async () => {
  const adapter = new DeferredPairAdapter();
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const relay = latestOpen(adapter, "relay");
  adapter.resolve(relay);
  await flush();
  // 关闭心跳，避免本用例推进 15s 时把“未模拟 pong”误当成数据面故障；本用例只测控制面。
  adapter.emit(relay, { case: "error", value: { code: "unsupported_payload", message: "old daemon" } });
  await flush();
  const relayOpenCount = adapter.opens.filter((call) => call.kind === "relay").length;

  h.router.setControlDisconnected();
  h.clock.advance(14_999);
  await flush();
  assert.equal(relay.closed, false, "宽限期内既有 relay 不得被 client 自己摧毁");

  h.router.setControlOnline(true);
  h.clock.advance(2); // 越过旧宽限 timer 原本的到期点，也执行恢复时排下的 delay=0 probe
  await flush();
  assert.equal(relay.closed, false, "authOk 在宽限内到达后应继续使用同一条 relay");
  assert.equal(
    adapter.opens.filter((call) => call.kind === "relay").length,
    relayOpenCount,
    "短暂抖动不得经历 loseChannel → 新 relay 竞速",
  );
  h.router.destroy();
});

test("client 控制面断开超过 15s 后关闭保留的 relay", async () => {
  const adapter = new DeferredPairAdapter();
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const relay = latestOpen(adapter, "relay");
  adapter.resolve(relay);
  await flush();
  adapter.emit(relay, { case: "error", value: { code: "unsupported_payload", message: "old daemon" } });
  await flush();

  h.router.setControlDisconnected();
  h.clock.advance(14_999);
  await flush();
  assert.equal(relay.closed, false, "到期前一毫秒仍须保留");
  h.clock.advance(1);
  await flush();
  assert.equal(relay.closed, true, "宽限到期必须 fail closed，不能把在线授权变成无限离线授权");
  h.router.destroy();
});

test("hard revoke 不经过 transient grace，立即关闭 relay", async () => {
  const adapter = new DeferredPairAdapter();
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const relay = latestOpen(adapter, "relay");
  adapter.resolve(relay);
  await flush();

  h.router.setControlDisconnected();
  assert.equal(relay.closed, false, "前置：普通 transport disconnect 已进入宽限");
  h.router.setControlOnline(false); // authError/outdated/换凭据/reset/destroy 共用的 hard revoke
  assert.equal(relay.closed, true, "明确授权失效必须立即收敛");
  h.router.destroy();
});

test("断线前发起、断线后才完成的 relay continuation 不能跨控制代际提交", async () => {
  const adapter = new DeferredPairAdapter();
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const stale = latestOpen(adapter, "relay");

  h.router.setControlDisconnected();
  adapter.resolve(stale); // 模拟 relay WS open 与断线同时完成，continuation 迟到
  await flush();
  assert.equal(stale.closed, true, "旧控制代际签出的异步 open 结果必须被关闭");
  assert.notEqual(h.states.at(-1)?.mode, "relay", "旧 continuation 不得成为 active lane");
  h.router.destroy();
});

test("旧 control grace timer 不会误关恢复后新建的 relay", async () => {
  const adapter = new DeferredPairAdapter();
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const first = latestOpen(adapter, "relay");
  adapter.resolve(first);
  await flush();
  adapter.emit(first, { case: "error", value: { code: "unsupported_payload", message: "old daemon" } });
  await flush();

  h.router.setControlDisconnected(); // t=0：旧 timer 原定 t=15000 提交
  h.clock.advance(10_000);
  h.router.setControlOnline(true); // 取消旧代际
  first.options.onClose("relay test close");
  h.clock.advance(350);
  await flush();
  const recovered = latestOpen(adapter, "relay");
  assert.notEqual(recovered, first, "前置：在线后已恢复出一条新 relay");
  adapter.resolve(recovered);
  await flush();

  h.clock.advance(5_000); // 越过旧 timer 原定提交点
  await flush();
  assert.equal(recovered.closed, false, "旧断线代际的 timer 不得关闭新 channel");
  h.router.destroy();
});

test("中心授权 hard revoke 时 active P2P channel 立即失效，不等对端关闭事件", async () => {
  const adapter = new P2pFakeAdapter(undefined);
  const h = harness(adapter);
  h.router.setControlOnline(true);
  h.router.retainDevice("daemon-1");
  await flush();
  const p2p = latestOpen(adapter, "p2p");
  adapter.resolve(p2p);
  await flush();
  assert.equal(h.states.at(-1)?.mode, "p2p");

  h.router.setControlOnline(false);
  await flush();
  assert.equal(p2p.closed, true, "明确授权失效必须立即关闭 P2P channel");
  assert.notEqual(h.states.at(-1)?.mode, "p2p");
  h.router.destroy();
});
