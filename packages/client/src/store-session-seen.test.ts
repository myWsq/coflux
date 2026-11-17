/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema, TaskStatus, type ServerToClientPayload } from "@coflux/protocol";

// Account-wide seen for finished agent turns (plan 20261111-agent-seen-sync): this client's
// optimistic mark, the one message it sends, and the centre's mark read from the wire. Same minimal
// fakes as store-removal.test.ts.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket, "no WebSocket created yet");
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
  receive(payload: ServerToClientPayload): void {
    const bytes = encodeServerToClient(create(ServerToClientSchema, { payload }));
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  seenSent(): string[] {
    return this.sent.flatMap((bytes) => {
      const payload = decodeClientToServer(bytes)?.payload;
      return payload?.case === "sessionSeen" ? [payload.value.sessionId] : [];
    });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
globals.WebSocket = FakeWebSocket;

const { createCofluxClient, isTurnSeen } = await import("./store");

const daemons = [{ daemonId: "d1", name: "本机", online: true }];
const projects = [{ id: "p1", daemonId: "d1", name: "coflux", createdAt: 1 }];
const workspaces = [{ id: "ws1", daemonId: "d1", projectId: "p1", branch: "main", isMain: true, createdAt: 1 }];
const tasks = [
  { id: "t1", daemonId: "d1", projectId: "p1", workspaceId: "ws1", title: "终端", status: TaskStatus.RUNNING, sessionId: "s1", createdAt: 1 },
];

function start() {
  let token = "tok";
  const client = createCofluxClient({
    serverUrl: "ws://127.0.0.1:1/client",
    tokenStorage: {
      read: () => token,
      write: (next) => {
        token = next;
      },
      clear: () => {
        token = "";
      },
    },
    buildId: "dev",
    deviceTransport: { enableLocalTransport: false, identityDatabaseName: "test", origin: "https://desktop.coflux.dev" },
  });
  const socket = FakeWebSocket.latest();
  socket.open();
  socket.receive({ case: "authOk", value: { accountId: "a1", controlProtocolVersion: 2 } });
  socket.receive({ case: "stateSnapshot", value: { daemons, projects, workspaces, tasks, ports: [] } });
  return { client, socket };
}

function presence(state: string, seen = false): ServerToClientPayload {
  return {
    case: "sessionAgentsUpdated",
    value: { daemonId: "d1", sessions: [{ sessionId: "s1", taskId: "t1", agent: "claude", state, seen }] },
  };
}

function seenNow(client: ReturnType<typeof createCofluxClient>): boolean {
  const state = client.store.getState();
  return isTurnSeen(state.sessionAgents.s1, state.seenSessions, "s1");
}

test("marking a finished turn sets the local mark and sends one SessionSeen; a second mark sends nothing", () => {
  const { client, socket } = start();
  try {
    socket.receive(presence("done"));
    assert.equal(seenNow(client), false);

    client.markSessionSeen("s1");
    assert.equal(seenNow(client), true);
    assert.equal(client.store.getState().seenSessions.has("s1"), true);
    assert.deepEqual(socket.seenSent(), ["s1"]);

    client.markSessionSeen("s1");
    assert.deepEqual(socket.seenSent(), ["s1"], "an already-seen turn is not reported again");
  } finally {
    client.disconnect();
  }
});

test("a turn that is not finished is never marked", () => {
  const { client, socket } = start();
  try {
    socket.receive(presence("active"));
    client.markSessionSeen("s1");
    assert.equal(seenNow(client), false);
    assert.deepEqual(socket.seenSent(), []);
  } finally {
    client.disconnect();
  }
});

test("an active report clears the local mark, so the next finished turn is unseen and reported again", () => {
  const { client, socket } = start();
  try {
    socket.receive(presence("done"));
    client.markSessionSeen("s1");
    socket.receive(presence("done"));
    assert.equal(seenNow(client), true, "a re-report of the same finished turn keeps the mark");

    socket.receive(presence("active"));
    assert.equal(client.store.getState().seenSessions.has("s1"), false);
    socket.receive(presence("done"));
    assert.equal(seenNow(client), false);

    client.markSessionSeen("s1");
    assert.deepEqual(socket.seenSent(), ["s1", "s1"]);
  } finally {
    client.disconnect();
  }
});

test("the centre's seen reads as seen without any local mark, and nothing is sent for it", () => {
  const { client, socket } = start();
  try {
    socket.receive(presence("done", true));
    assert.equal(client.store.getState().sessionAgents.s1?.seen, true);
    assert.equal(client.store.getState().seenSessions.size, 0);
    assert.equal(seenNow(client), true);

    client.markSessionSeen("s1");
    assert.deepEqual(socket.seenSent(), []);
  } finally {
    client.disconnect();
  }
});
