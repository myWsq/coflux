/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { create, CONTROL_PROTOCOL_VERSION, decodeClientToServer, encodeServerToClient, ServerToClientSchema, type ServerToClientPayload } from "@coflux/protocol";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket, "还没有创建 WebSocket");
    return socket;
  }
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 链路断开：真实 WebSocket 出错后总是紧跟 close */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(payload: ServerToClientPayload): void {
    const bytes = encodeServerToClient(create(ServerToClientSchema, { payload }));
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  /** Decoded outgoing authorization requests. */
  authorizeTokens(): string[] {
    return this.sent
      .map((bytes) => decodeClientToServer(bytes)?.payload)
      .filter((payload) => payload?.case === "deviceAuthorize")
      .map((payload) => (payload as { case: "deviceAuthorize"; value: { token: string } }).value.token);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
globals.WebSocket = FakeWebSocket;

const { createCofluxClient } = await import("./store");

function newClient(token: string) {
  let stored = token;
  return createCofluxClient({
    serverUrl: "ws://127.0.0.1:1/client",
    tokenStorage: {
      read: () => stored,
      write: (next) => {
        stored = next;
      },
      clear: () => {
        stored = "";
      },
    },
    buildId: "dev",
    deviceTransport: { enableLocalTransport: false, identityDatabaseName: "test", origin: "https://desktop.coflux.dev" },
  });
}


function ready() {
  const client = newClient("token");
  const socket = FakeWebSocket.latest();
  socket.open();
  socket.receive({ case: "authOk", value: { accountId: "owner", controlProtocolVersion: CONTROL_PROTOCOL_VERSION, notificationInbox: true } });
  return { client, socket };
}
const entry = (sequence: number) => ({ id: `n-${sequence}`, sequence, readAt: 0, message: "Please review" });
const history = (socket: FakeWebSocket, latestSequence: number, requestId = "initial") => socket.receive({ case: "notificationPage", value: {
  requestId, notifications: [entry(latestSequence)], latestSequence, revision: latestSequence, unreadCount: 1,
} });
const live = (socket: FakeWebSocket, sequence: number) => socket.receive({ case: "notificationChanged", value: {
  notification: entry(sequence), latestSequence: sequence, revision: sequence, unreadCount: 2, created: true,
} });

test("initial and reconnect history are silent; live notification alerts exactly once", () => {
  const { client, socket } = ready();
  const alerts: string[] = [];
  client.onNotification((item) => alerts.push(item.id));
  try {
    history(socket, 5);
    live(socket, 5);
    assert.deepEqual(alerts, []);
    live(socket, 6);
    live(socket, 6);
    assert.deepEqual(alerts, ["n-6"]);
    socket.receive({ case: "authOk", value: { accountId: "owner", controlProtocolVersion: CONTROL_PROTOCOL_VERSION, notificationInbox: true } });
    history(socket, 10);
    live(socket, 10);
    assert.deepEqual(alerts, ["n-6"]);
    live(socket, 11);
    assert.deepEqual(alerts, ["n-6", "n-11"]);
  } finally { client.disconnect(); }
});

test("manual recovery establishes the initial cutoff and stale pages cannot replace a pending page", () => {
  const { client, socket } = ready();
  const alerts: string[] = [];
  client.onNotification((item) => alerts.push(item.id));
  try {
    socket.receive({ case: "notificationPage", value: { requestId: "initial", error: "temporarily unavailable" } });
    client.loadNotifications();
    const request = decodeClientToServer(socket.sent.at(-1)!)!.payload;
    assert.equal(request.case, "notificationList");
    if (request.case !== "notificationList") return;
    history(socket, 2, "initial");
    assert.equal(client.store.getState().notificationInbox.loading, true);
    history(socket, 8, request.value.requestId);
    live(socket, 9);
    assert.deepEqual(alerts, ["n-9"]);
  } finally { client.disconnect(); }
});

test("an earlier read-through suppresses a delayed created event", () => {
  const { client, socket } = ready();
  const alerts: string[] = [];
  client.onNotification((item) => alerts.push(item.id));
  try {
    history(socket, 1);
    socket.receive({ case: "notificationChanged", value: { readThroughSequence: 2, readAt: 123, revision: 3, latestSequence: 2, unreadCount: 0 } });
    live(socket, 2);
    assert.deepEqual(alerts, []);
    assert.equal(client.store.getState().notificationInbox.items.find((item) => item.id === "n-2")!.readAt, 123);
    assert.equal(client.store.getState().notificationInbox.unreadCount, 0);
  } finally { client.disconnect(); }
});

test("read request IDs differ between clients and logout clears account history", () => {
  const a = ready(); const b = ready();
  try {
    history(a.socket, 1); history(b.socket, 1);
    a.client.markNotificationRead("n-1"); b.client.markNotificationRead("n-1");
    const aRequest = decodeClientToServer(a.socket.sent.at(-1)!)!.payload;
    const bRequest = decodeClientToServer(b.socket.sent.at(-1)!)!.payload;
    assert.equal(aRequest.case, "notificationRead"); assert.equal(bRequest.case, "notificationRead");
    if (aRequest.case === "notificationRead" && bRequest.case === "notificationRead") assert.notEqual(aRequest.value.requestId, bRequest.value.requestId);
    a.client.logout(false);
    assert.deepEqual(a.client.store.getState().notificationInbox.items, []);
    assert.equal(a.client.store.getState().notificationInbox.unreadCount, 0);
  } finally { a.client.disconnect(); b.client.disconnect(); }
});
