/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema, TaskStatus, type ServerToClientPayload } from "@coflux/protocol";

// Terminal metadata and content (plan 20261010-terminal-checkpoint-energy): pins what using the app
// cannot show — that a hidden pane never receives a whole screen, that metadata reports which change
// nothing keep the store's identity, and that a visible pane against a metadata center fetches its
// content instead of waiting for a push. Same minimal fakes as store-removal.test.ts.

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
  sentCases(): string[] {
    return this.sent.map((bytes) => decodeClientToServer(bytes)?.payload.case ?? "");
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
globals.WebSocket = FakeWebSocket;

const { createCofluxClient } = await import("./store");

const daemons = [{ daemonId: "d1", name: "本机", online: true }];
const projects = [{ id: "p1", daemonId: "d1", name: "coflux", createdAt: 1 }];
const workspaces = [{ id: "ws1", daemonId: "d1", projectId: "p1", branch: "main", isMain: true, createdAt: 1 }];
const tasks = [
  { id: "t1", daemonId: "d1", projectId: "p1", workspaceId: "ws1", title: "终端", status: TaskStatus.RUNNING, sessionId: "s1", createdAt: 1 },
];

function start(centerServesMetadata: boolean) {
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
  socket.receive({ case: "authOk", value: { accountId: "a1", controlProtocolVersion: 2, sessionMetadata: centerServesMetadata } });
  socket.receive({ case: "stateSnapshot", value: { daemons, projects, workspaces, tasks, ports: [] } });
  return { client, socket };
}

function checkpoint(title: string, text: string): ServerToClientPayload {
  return {
    case: "sessionCheckpoint",
    value: { sessionId: "s1", taskId: "t1", snapshotSeq: 1n, ansiSnapshot: new TextEncoder().encode(text), cols: 80, rows: 24, title, capturedAt: 1 },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the client declares the metadata capability when it authenticates", () => {
  const { client, socket } = start(true);
  try {
    const auth = decodeClientToServer(socket.sent[0]!);
    assert.equal(auth?.payload.case, "clientAuth");
    assert.equal(auth?.payload.case === "clientAuth" && auth.payload.value.sessionMetadata, true);
  } finally {
    client.disconnect();
  }
});

test("an older center's push reaches only a watching (visible) pane, and only its title is reactive", async () => {
  const { client, socket } = start(false);
  const live: Uint8Array[] = [];
  const unregister = client.registerSessionConsumer("s1", (data) => live.push(data));
  try {
    socket.receive(checkpoint("claude", "screen one"));
    assert.equal(live.length, 0, "a registered (hidden) pane parses no checkpoint");
    const metadata = client.store.getState().sessionMetadata;
    assert.equal(metadata.s1?.title, "claude");

    // The same title again (every content push carries it) keeps the store's identity.
    socket.receive(checkpoint("claude", "screen two"));
    assert.equal(client.store.getState().sessionMetadata, metadata);
    assert.equal(live.length, 0);

    // A visible pane gets the latest cached screen, then each new push.
    const shown: string[] = [];
    const unwatch = client.watchSessionContent("t1", "s1", (data) => shown.push(new TextDecoder().decode(data)));
    await sleep(400);
    assert.deepEqual(shown, ["screen two"]);
    socket.receive(checkpoint("claude", "screen three"));
    assert.deepEqual(shown, ["screen two", "screen three"]);
    unwatch();
    socket.receive(checkpoint("claude · done", "screen four"));
    assert.deepEqual(shown, ["screen two", "screen three"], "an unwatched (hidden again) pane gets nothing");
    assert.equal(client.store.getState().sessionMetadata.s1?.title, "claude · done");
    assert.ok(!socket.sentCases().includes("taskRead"), "an older center is never asked for content");
  } finally {
    unregister();
    client.disconnect();
  }
});

test("against a metadata center only a watching pane fetches content, and unchanged metadata keeps identity", async () => {
  const { client, socket } = start(true);
  try {
    socket.receive({ case: "sessionMetadata", value: { sessionId: "s1", taskId: "t1", title: "vim" } });
    const metadata = client.store.getState().sessionMetadata;
    assert.equal(metadata.s1?.title, "vim");
    socket.receive({ case: "sessionMetadata", value: { sessionId: "s1", taskId: "t1", title: "vim" } });
    assert.equal(client.store.getState().sessionMetadata, metadata, "a repeated report changes nothing");

    // No watching pane: nothing is fetched.
    await sleep(400);
    assert.ok(!socket.sentCases().includes("taskRead"));

    const shown: string[] = [];
    const unwatch = client.watchSessionContent("t1", "s1", (data) => shown.push(new TextDecoder().decode(data)));
    await sleep(400);
    assert.equal(socket.sentCases().filter((kind) => kind === "taskRead").length, 1, "a visible pane fetches through TaskRead");
    socket.receive({
      case: "taskReadResult",
      value: { taskId: "t1", data: new TextEncoder().encode("held elsewhere"), source: "snapshot", capturedAt: 1, status: TaskStatus.RUNNING },
    });
    await sleep(0);
    assert.deepEqual(shown, ["held elsewhere"]);
    unwatch();
  } finally {
    client.disconnect();
  }
});
