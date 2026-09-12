import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema } from "@coflux/protocol";
import { NativeTailcatTransport } from "./tailcat-transport";
import type { NativeEvent, NativeOpen } from "../shared/native-transport";

const request = (id: string, scope = 2): NativeOpen => ({ requestId: id, daemonId: "daemon", clientInstanceId: "client", generation: "1", scope });
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture() {
  const events: NativeEvent[] = [], watched = new Map<number, { frame(bytes: Uint8Array): void; close(): void }>();
  let sends = 0, rejectSend = false;
  const streamSends = new Map<number, number>();
  const helper = {
    request: async (op: string) => op === "prepare" ? { publicKey: `nodekey:${"a".repeat(64)}` } : {},
    watch: (stream: number, listener: { frame(bytes: Uint8Array): void; close(): void }) => watched.set(stream, listener),
    send: (stream: number, _frame: Uint8Array) => {
      if (rejectSend) return false;
      sends++;
      const count = (streamSends.get(stream) ?? 0) + 1; streamSends.set(stream, count);
      if (count === 1) watched.get(stream)?.frame(new Uint8Array(32));
      if (count === 2) { watched.get(stream)?.frame(Buffer.from("ok")); watched.get(stream)?.frame(Buffer.from("first-data")); }
      return true;
    },
    closeStream: (stream: number) => { const listener = watched.get(stream); watched.delete(stream); listener?.close(); },
    close: () => {},
  };
  const transport = new NativeTailcatTransport("/helper", "ws://localhost", () => "token", event => events.push(event));
  // Controlled peer boundaries let these tests interleave control, handshake,
  // and renderer events without spawning a process or opening a real account.
  const internal = transport as any;
  internal.online = true; internal.controlAuthed = true; internal.helper = helper;
  internal.ensure = async () => {};
  internal.sendControl = (payload: any) => {
    if (payload.case === "deviceTailcatConnect") internal.grants.get(payload.value.channelId)?.resolve({ address: "private", proofKey: new Uint8Array(32), expiresAt: BigInt(Date.now() + 30_000), scopes: [1, 2] });
  };
  return { transport, internal, events, helper, watched, sends: () => sends, rejectSend: () => { rejectSend = true; } };
}

test("native auth acceptance and first frame in one callback preserve ordering", async () => {
  const f = fixture();
  try {
    const result = await f.transport.open(request("one"));
    assert.equal(result.handle, "one");
    assert.equal(f.events.filter(event => event.kind === "frame").length, 1);
    assert.equal(f.transport.send("one", Buffer.from("device-frame")), true);
  } finally { f.transport.close(); }
});

test("pending native handshake cannot accept renderer data and control outage cancels it", async () => {
  const f = fixture();
  let prepared!: () => void;
  f.helper.request = op => op === "prepare" ? new Promise(resolve => { prepared = () => resolve({ publicKey: "test" }); }) : Promise.resolve({});
  const opened = f.transport.open(request("pending"));
  const rejected = assert.rejects(opened, /取消/);
  await flush();
  assert.equal(f.transport.send("pending", Buffer.from("injected")), false);
  f.transport.setControl(false, false); prepared(); await rejected;
  assert.equal(f.sends(), 0); f.transport.close();
});

test("control outage cancels openings still waiting for shared helper startup", async () => {
  const f = fixture(); let ready!: () => void;
  f.internal.ensure = () => new Promise<void>(resolve => { ready = resolve; });
  const opened = f.transport.open(request("startup")); const rejected = assert.rejects(opened, /取消/);
  f.transport.setControl(false, false); ready(); await rejected;
  assert.equal(f.watched.size, 0); f.transport.close();
});

test("renderer recovery cannot erase dedicated-control disconnect grace", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.transport.open(request("session"));
    f.internal.controlAuthed = false; f.internal.pauseLanes();
    f.transport.setControl(true, false);
    t.mock.timers.tick(15_000);
    assert(f.events.some(event => event.kind === "closed" && event.handle === "session"));
    assert.equal(f.transport.send("session", Buffer.from("late")), false);
  } finally { f.transport.close(); }
});

test("failed handshake send rejects once and leaves no orphan receive timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.rejectSend();
  try { await assert.rejects(f.transport.open(request("failure")), /发送失败/); t.mock.timers.tick(30_000); await flush(); assert.equal(f.watched.size, 0); }
  finally { f.transport.close(); }
});


test("central native close disposes its lane and a stale channel cannot close its replacement", async () => {
  const f = fixture();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  f.internal.serverUrl = `ws://127.0.0.1:${address.port}`;
  f.internal.ensure = Object.getPrototypeOf(f.transport).ensure;
  f.internal.sendControl = Object.getPrototypeOf(f.transport).sendControl;
  let peer: WebSocket;
  const sendClosed = (channelId: string) => peer.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "deviceTailcatClosed", value: { channelId } } })));
  server.on("connection", socket => {
    peer = socket;
    socket.on("message", raw => {
      const message = decodeClientToServer(new Uint8Array(raw as Buffer));
      if (message?.payload.case === "clientAuth") socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "authOk", value: {} } })));
      if (message?.payload.case === "deviceTailcatConnect") socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "deviceTailcatResult", value: { channelId: message.payload.value.channelId, ok: true, address: "private", proofKey: new Uint8Array(32), expiresAt: BigInt(Date.now() + 30_000), scopes: [1, 2] } } })));
    });
  });
  try {
    await f.transport.open(request("obsolete"));
    sendClosed("obsolete");
    for (let i = 0; !f.events.some(event => event.kind === "closed" && event.handle === "obsolete"); i++) { assert(i < 100, "central revocation must close the native lane"); await sleep(10); }
    assert.equal(f.transport.send("obsolete", Buffer.from("late")), false);
    await f.transport.open(request("replacement"));
    sendClosed("obsolete");
    // WebSocket frame ordering puts this pong after the stale close handler.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("control ordering barrier timed out")), 1000);
      peer.once("pong", () => { clearTimeout(timeout); resolve(); });
      peer.ping();
    });
    assert.equal(f.transport.send("replacement", Buffer.from("live")), true);
    assert(!f.events.some(event => event.kind === "closed" && event.handle === "replacement"));
  } finally {
    f.transport.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
