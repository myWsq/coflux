import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import {
  create,
  decodeDeviceEnvelope,
  DeviceEnvelopeSchema,
  DeviceLoopbackFailure,
  encodeDeviceEnvelope,
  type DeviceEnvelope,
  type DeviceEnvelopePayload,
} from "@coflux/protocol";

import {
  backoffDelay,
  classifyLaneError,
  CONNECTION_WINDOW_FRAMES,
  FRAME_BYTES,
  LANE_WINDOW_FRAMES,
  LoopbackTunnels,
  TunnelError,
  type LaneOpener,
  type TunnelClock,
  type TunnelSocket,
} from "./loopback-tunnel";

type Sent = DeviceEnvelope["payload"];

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await nextMacrotask();
}

function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: TunnelClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

/** A device at the other end of the lane: records what was sent, answers what the test says. */
function fixture() {
  const sent: Sent[] = [];
  const state = { online: true, sendOk: true, openFails: false, opens: 0, closes: 0 };
  let handlers: { frame(bytes: Uint8Array): void; closed(): void } | undefined;
  const opener: LaneOpener = {
    online: () => state.online,
    open: async (_daemonId, laneHandlers) => {
      state.opens++;
      if (state.openFails) throw new Error("grant refused");
      handlers = laneHandlers;
      return {
        channelId: `lane-${state.opens}`,
        send: (frame) => {
          if (!state.sendOk) return false;
          const envelope = decodeDeviceEnvelope(frame);
          assert(envelope, "a frame the device can decode");
          assert.equal(envelope.channelId, `lane-${state.opens}`);
          sent.push(envelope.payload);
          return true;
        },
        close: () => {
          state.closes++;
        },
      };
    },
  };
  const time = fakeClock();
  const logs: string[] = [];
  const tunnels = new LoopbackTunnels(opener, (message) => logs.push(message), time.clock);
  const deliver = (payload: DeviceEnvelopePayload) =>
    handlers!.frame(encodeDeviceEnvelope(create(DeviceEnvelopeSchema, { protocolVersion: 1, channelId: `lane-${state.opens}`, payload })));
  const ofCase = <C extends NonNullable<Sent["case"]>>(kind: C) => sent.filter((payload): payload is Extract<Sent, { case: C }> => payload.case === kind);
  const opens = () => ofCase("loopbackOpen").map((payload) => payload.value);
  const acked = (connectionId: number) => ofCase("loopbackAck").filter((payload) => payload.value.connectionId === connectionId).reduce((sum, payload) => sum + payload.value.frames, 0);
  const dataFrames = (connectionId?: number) => ofCase("loopbackData").filter((payload) => connectionId === undefined || payload.value.connectionId === connectionId);
  /** Connects and has the device accept the open. */
  const open = async (port = 5173): Promise<TunnelSocket> => {
    const pending = tunnels.connect("daemon-1", port);
    await settle();
    const id = opens().at(-1)!.connectionId;
    deliver({ case: "loopbackOpened", value: { connectionId: id } });
    return pending;
  };
  return { tunnels, state, sent, deliver, opens, acked, dataFrames, ofCase, open, time, logs, closeLane: () => handlers!.closed() };
}

test("connection ids are distinct per lane and device answers settle each open", async () => {
  const f = fixture();
  const first = await f.open(5173);
  const refused = f.tunnels.connect("daemon-1", 3000);
  const failed = f.tunnels.connect("daemon-1", 4000);
  await settle();
  const [a, b, c] = f.opens();
  assert.deepEqual([a!.port, b!.port, c!.port], [5173, 3000, 4000]);
  assert.equal(new Set([a!.connectionId, b!.connectionId, c!.connectionId]).size, 3);
  assert.equal(first.id, a!.connectionId);
  f.deliver({ case: "loopbackFailed", value: { connectionId: b!.connectionId, reason: DeviceLoopbackFailure.REFUSED, message: "" } });
  f.deliver({ case: "loopbackFailed", value: { connectionId: c!.connectionId, reason: DeviceLoopbackFailure.UNREACHABLE, message: "" } });
  await assert.rejects(refused, (error: unknown) => error instanceof TunnelError && error.reason === "refused");
  await assert.rejects(failed, (error: unknown) => error instanceof TunnelError && error.reason === "offline");
  assert.equal(f.state.opens, 1, "one lane for every connection to the device");
  f.tunnels.dispose();
});

test("every device data frame is acknowledged exactly once, held back only by the consumer", async () => {
  const f = fixture();
  const socket = await f.open();
  const frame = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < 4; i++) f.deliver({ case: "loopbackData", value: { connectionId: socket.id, data: frame } });
  // Three frames fit below the readable high-water mark; the fourth waits for the consumer.
  assert.equal(f.acked(socket.id), 3);
  let received = 0;
  socket.on("data", (chunk: Buffer) => {
    received += chunk.length;
  });
  await settle();
  assert.equal(received, 4 * FRAME_BYTES);
  assert.equal(f.acked(socket.id), 4);
  // A frame for a connection that is gone here is still acknowledged: the device's lane credit depends on it.
  f.deliver({ case: "loopbackData", value: { connectionId: 999, data: new Uint8Array([1]) } });
  assert.equal(f.acked(999), 1);
  f.tunnels.dispose();
});

test("writes wait for connection credit and never drop a byte", async () => {
  const f = fixture();
  const socket = await f.open();
  const payload = Buffer.alloc(10 * FRAME_BYTES + 5, 7);
  let written = false;
  socket.write(payload, () => {
    written = true;
  });
  assert.equal(f.dataFrames(socket.id).length, CONNECTION_WINDOW_FRAMES);
  assert.equal(written, false);
  f.deliver({ case: "loopbackAck", value: { connectionId: socket.id, frames: 2 } });
  assert.equal(f.dataFrames(socket.id).length, CONNECTION_WINDOW_FRAMES + 2);
  f.deliver({ case: "loopbackAck", value: { connectionId: socket.id, frames: 5 } });
  await settle();
  const frames = f.dataFrames(socket.id).map((frame) => Buffer.from(frame.value.data));
  assert.equal(frames.length, 11);
  assert(frames.every((frame) => frame.length <= FRAME_BYTES));
  assert.deepEqual(Buffer.concat(frames), payload, "in order, complete");
  assert.equal(written, true);
  f.tunnels.dispose();
});

test("the lane never has more than its window of data frames in flight", async () => {
  const f = fixture();
  const sockets = [await f.open(), await f.open(), await f.open()];
  for (const socket of sockets) socket.write(Buffer.alloc(CONNECTION_WINDOW_FRAMES * FRAME_BYTES));
  assert.equal(f.dataFrames().length, LANE_WINDOW_FRAMES);
  // Credit returned by one connection's acknowledgement goes to whoever waits for the lane.
  f.deliver({ case: "loopbackAck", value: { connectionId: sockets[0]!.id, frames: 4 } });
  assert.equal(f.dataFrames().length, LANE_WINDOW_FRAMES + 4);
  // Inflated acknowledgements cannot mint credit.
  f.deliver({ case: "loopbackAck", value: { connectionId: sockets[1]!.id, frames: 1000 } });
  assert(f.dataFrames().length <= LANE_WINDOW_FRAMES + 4 + CONNECTION_WINDOW_FRAMES);
  const lane = f.tunnels.lane("daemon-1").stats;
  assert(lane.outstanding <= LANE_WINDOW_FRAMES);
  f.tunnels.dispose();
});

test("a connection closed here gives its credit back and says so to the device", async () => {
  const f = fixture();
  const socket = await f.open();
  socket.write(Buffer.alloc(CONNECTION_WINDOW_FRAMES * FRAME_BYTES));
  assert.equal(f.tunnels.lane("daemon-1").stats.outstanding, CONNECTION_WINDOW_FRAMES);
  socket.destroy();
  await settle();
  assert.deepEqual(f.ofCase("loopbackClose").map((payload) => payload.value.connectionId), [socket.id]);
  assert.equal(f.tunnels.lane("daemon-1").stats.outstanding, 0);
  // A late acknowledgement for it is ignored.
  f.deliver({ case: "loopbackAck", value: { connectionId: socket.id, frames: 3 } });
  assert.equal(f.tunnels.lane("daemon-1").stats.outstanding, 0);
  f.tunnels.dispose();
});

test("a device close ends the readable after what was already sent", async () => {
  const f = fixture();
  const socket = await f.open();
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve) => socket.once("end", () => resolve()));
  f.deliver({ case: "loopbackData", value: { connectionId: socket.id, data: Buffer.from("HTTP/1.1 200 OK\r\n\r\nhi") } });
  f.deliver({ case: "loopbackClose", value: { connectionId: socket.id } });
  await ended;
  assert.equal(Buffer.concat(chunks).toString(), "HTTP/1.1 200 OK\r\n\r\nhi");
  await settle();
  assert.equal(f.ofCase("loopbackClose").length, 0, "a device-initiated close is not echoed");
  f.tunnels.dispose();
});

test("exactly empty_payload without a request id marks the device unsupported at once", async () => {
  assert.equal(classifyLaneError({ code: "empty_payload" }), "unsupported");
  assert.equal(classifyLaneError({ code: "empty_payload", requestId: "r1" }), "request-error");
  assert.equal(classifyLaneError({ code: "scope_denied" }), "lane-error");
  assert.equal(classifyLaneError({ code: "unsupported_payload" }), "lane-error");
  assert.equal(classifyLaneError({ code: "invalid_request_id" }), "lane-error");

  const f = fixture();
  const first = f.tunnels.connect("daemon-1", 5173);
  const second = f.tunnels.connect("daemon-1", 5174);
  await settle();
  f.deliver({ case: "error", value: { code: "empty_payload", message: "DeviceEnvelope payload 为空" } });
  await assert.rejects(first, (error: unknown) => error instanceof TunnelError && error.reason === "unsupported");
  await assert.rejects(second, (error: unknown) => error instanceof TunnelError && error.reason === "unsupported");
  // Later opens fail immediately, with nothing sent and no new grant.
  const before = f.opens().length;
  await assert.rejects(f.tunnels.connect("daemon-1", 5173), (error: unknown) => error instanceof TunnelError && error.reason === "unsupported");
  assert.equal(f.opens().length, before);
  assert.equal(f.state.opens, 1);
  f.tunnels.dispose();
});

test("other request-id-less errors fail pending opens as unreachable, not as too old", async () => {
  const f = fixture();
  const pending = f.tunnels.connect("daemon-1", 5173);
  await settle();
  f.deliver({ case: "error", value: { requestId: "someone-else", code: "invalid_request_id", message: "" } });
  f.deliver({ case: "error", value: { code: "scope_denied", message: "当前 grant/lease 不允许该 Device RPC" } });
  await assert.rejects(pending, (error: unknown) => error instanceof TunnelError && error.reason === "offline");
  assert.equal(f.tunnels.lane("daemon-1").stats.unsupported, false);
  const next = f.tunnels.connect("daemon-1", 5173);
  await settle();
  assert.equal(f.opens().length, 2, "the next open is tried, not short-circuited");
  f.tunnels.dispose();
  await assert.rejects(next);
});

test("an offline account never opens a lane", async () => {
  const f = fixture();
  f.state.online = false;
  await assert.rejects(f.tunnels.connect("daemon-1", 5173), (error: unknown) => error instanceof TunnelError && error.reason === "offline");
  assert.equal(f.state.opens, 0);
});

test("lane failures back off exponentially instead of asking for a grant per connection", async () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(backoffDelay), [500, 1000, 2000, 4000, 15_000]);
  const f = fixture();
  f.state.openFails = true;
  await assert.rejects(f.tunnels.connect("daemon-1", 5173), (error: unknown) => error instanceof TunnelError && error.reason === "offline");
  assert.equal(f.state.opens, 1);
  await assert.rejects(f.tunnels.connect("daemon-1", 5173));
  assert.equal(f.state.opens, 1, "inside the backoff window: no new attempt");
  f.time.advance(500);
  await assert.rejects(f.tunnels.connect("daemon-1", 5173));
  assert.equal(f.state.opens, 2);
  f.time.advance(500);
  await assert.rejects(f.tunnels.connect("daemon-1", 5173));
  assert.equal(f.state.opens, 2, "the second failure doubled the wait");
  f.time.advance(500);
  f.state.openFails = false;
  await f.open();
  assert.equal(f.state.opens, 3);
  f.tunnels.dispose();
});

test("a lane closed under it drops its connections and reopens only after backoff", async () => {
  const f = fixture();
  const socket = await f.open();
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  f.closeLane();
  await closed;
  assert.equal(f.tunnels.lane("daemon-1").stats.connections, 0);
  await assert.rejects(f.tunnels.connect("daemon-1", 5173), (error: unknown) => error instanceof TunnelError && error.reason === "offline");
  assert.equal(f.state.opens, 1);
  f.time.advance(backoffDelay(1));
  await f.open();
  assert.equal(f.state.opens, 2);
  f.tunnels.dispose();
});

test("a frame the transport refuses is fatal for the lane", async () => {
  const f = fixture();
  const socket = await f.open();
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  f.state.sendOk = false;
  socket.write(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
  await closed;
  assert.equal(f.state.closes, 1);
  assert.equal(f.tunnels.lane("daemon-1").stats.open, false);
  f.tunnels.dispose();
});

test("an idle lane closes without backoff and the next open asks again", async () => {
  const f = fixture();
  const socket = await f.open();
  socket.destroy();
  await settle();
  f.time.advance(60_000);
  assert.equal(f.state.closes, 1);
  assert.equal(f.tunnels.lane("daemon-1").stats.open, false);
  await f.open();
  assert.equal(f.state.opens, 2);
  f.tunnels.dispose();
});

test("an open the device never answers times out as unreachable", async () => {
  const f = fixture();
  const pending = f.tunnels.connect("daemon-1", 5173);
  await settle();
  f.time.advance(20_000);
  await assert.rejects(pending, (error: unknown) => error instanceof TunnelError && error.reason === "offline");
  assert.equal(f.ofCase("loopbackClose").length, 1, "the device is told to drop the dial");
  f.tunnels.dispose();
});
