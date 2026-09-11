/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { create, encodeServerToClient, ServerToClientSchema, TaskStatus, type ServerToClientPayload } from "@coflux/protocol";

// store 依赖浏览器全局（window 定时器 / WebSocket）：这里用最小假件顶上；token 与离线目录都经注入的
// 存储接口（plan 106），不碰 localStorage。只为把「离线目录缓存」（plan 103）的三条契约钉死——
// 写缓存/清缓存、首连失败装载、不传选项零变化。
// enableLocalTransport=false 让 DeviceRouter 不碰 IndexedDB；每个测试文件独立进程，全局替换不串扰。

class FakeStorage {
  private items = new Map<string, string>();
  setItemCalls = 0;
  /** 注入给 tokenStorage 的会话 token；与目录缓存的 items 分开，setItemCalls 只计目录写入 */
  token = "";
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.setItemCalls += 1;
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

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
  /** 握手成功 */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 连不上 / authOk 前被关：真实 WebSocket 出错后总是紧跟 close */
  fail(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(payload: ServerToClientPayload): void {
    const bytes = encodeServerToClient(create(ServerToClientSchema, { payload }));
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
globals.WebSocket = FakeWebSocket;

const { createCofluxClient } = await import("./store");

const CACHE_KEY = "coflux_offline_catalog:ws://127.0.0.1:1/client";

/** 下一次 newClient 注入的存储（token + 目录缓存共用一个假件） */
let currentStorage = new FakeStorage();

function installLocalStorage(token: string | null): FakeStorage {
  const storage = new FakeStorage();
  storage.token = token ?? "";
  currentStorage = storage;
  return storage;
}

function newClient(offline: boolean, timeoutMs?: number) {
  const storage = currentStorage;
  return createCofluxClient({
    serverUrl: "ws://127.0.0.1:1/client",
    tokenStorage: {
      read: () => storage.token,
      write: (token) => {
        storage.token = token;
      },
      clear: () => {
        storage.token = "";
      },
    },
    buildId: "dev",
    deviceTransport: { enableLocalTransport: false, identityDatabaseName: "test", origin: "https://desktop.coflux.dev" },
    offlineCatalog: offline ? { storage, key: CACHE_KEY, timeoutMs } : undefined,
  });
}

const snapshot: ServerToClientPayload = {
  case: "stateSnapshot",
  value: {
    daemons: [{ daemonId: "d1", name: "本机", online: true }],
    projects: [{ id: "p1", daemonId: "d1", name: "coflux" }],
    workspaces: [{ id: "ws1", daemonId: "d1", projectId: "p1", branch: "main", isMain: true }],
    tasks: [{ id: "t1", daemonId: "d1", projectId: "p1", workspaceId: "ws1", title: "终端", status: TaskStatus.RUNNING, sessionId: "s1" }],
    ports: [],
  },
};

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("(a) 开启选项：authOk + snapshot 后目录落缓存；登出清缓存", async () => {
  const storage = installLocalStorage("tok");
  const client = newClient(true);
  try {
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ case: "authOk", value: { accountId: "a1", iceServers: [], loginName: "wsq@example.com" } });
    socket.receive(snapshot);
    await flushMicrotasks();

    const raw = storage.getItem(CACHE_KEY);
    assert.ok(raw, "snapshot 后应写入缓存");
    const cached = JSON.parse(raw) as { version: number; loginName?: string; projects: { id: string }[]; tasks: { id: string; sessionId?: string }[] };
    assert.equal(cached.version, 1);
    assert.deepEqual(cached.projects.map((project) => project.id), ["p1"]);
    assert.equal(cached.tasks[0]?.sessionId, "s1");
    assert.equal(client.store.getState().authState, "authed");
    assert.equal(client.store.getState().loginName, "wsq@example.com", "authOk 的登录身份进 store（plan 110）");
    assert.equal(cached.loginName, "wsq@example.com", "登录身份随目录一起落盘");

    client.logout();
    assert.equal(storage.getItem(CACHE_KEY), null, "登出必须清掉离线目录");
    assert.equal(client.store.getState().loginName, "", "登出清空登录身份");
  } finally {
    client.disconnect();
  }
});

test("(b) 有 token + 有缓存 + 首连失败 → authed 且目录来自缓存，连接状态仍是 disconnected", async () => {
  const storage = installLocalStorage("tok");
  storage.setItem(
    CACHE_KEY,
    JSON.stringify({
      version: 1,
      savedAt: 1,
      daemons: [{ daemonId: "d1", name: "本机", online: true }],
      projects: [{ id: "p-cached", daemonId: "d1", name: "cached" }],
      workspaces: [{ id: "ws-cached", daemonId: "d1", projectId: "p-cached", branch: "main", isMain: true }],
      tasks: [{ id: "t-cached", daemonId: "d1", projectId: "p-cached", workspaceId: "ws-cached", title: "终端", status: TaskStatus.RUNNING, sessionId: "s-cached" }],
      ports: {},
      sessionAgents: {},
    }),
  );
  const client = newClient(true);
  try {
    assert.equal(client.store.getState().authState, "authenticating");
    FakeWebSocket.latest().fail();
    const state = client.store.getState();
    assert.equal(state.authState, "authed");
    assert.equal(state.status, "disconnected");
    assert.equal(state.snapshotRevision, 1);
    assert.deepEqual(state.projects.map((project) => project.id), ["p-cached"]);
    assert.deepEqual(state.workspaces.map((workspace) => workspace.id), ["ws-cached"]);
    assert.equal(state.tasks[0]?.sessionId, "s-cached");
    assert.equal(state.tasks[0]?.status, TaskStatus.RUNNING);
  } finally {
    client.disconnect();
  }
});

test("(b') 连上但 authOk 在时限内没来 → 超时装载缓存；随后真实 snapshot 照旧覆盖", async () => {
  const storage = installLocalStorage("tok");
  storage.setItem(
    CACHE_KEY,
    JSON.stringify({ version: 1, savedAt: 1, daemons: [], projects: [{ id: "p-cached", daemonId: "d1", name: "cached" }], workspaces: [], tasks: [], ports: {}, sessionAgents: {} }),
  );
  const client = newClient(true, 10);
  try {
    const socket = FakeWebSocket.latest();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(client.store.getState().authState, "authed");
    assert.deepEqual(client.store.getState().projects.map((project) => project.id), ["p-cached"]);

    socket.receive({ case: "authOk", value: { accountId: "a1", iceServers: [] } });
    socket.receive(snapshot);
    assert.deepEqual(client.store.getState().projects.map((project) => project.id), ["p1"]);
    assert.equal(client.store.getState().snapshotRevision, 2);
  } finally {
    client.disconnect();
  }
});

test("(b'') 认证失败清缓存；坏掉的缓存（版本不对）不装载", async () => {
  const storage = installLocalStorage("tok");
  storage.setItem(CACHE_KEY, JSON.stringify({ version: 99, projects: [{ id: "x" }] }));
  const client = newClient(true);
  try {
    FakeWebSocket.latest().fail();
    assert.equal(client.store.getState().authState, "authenticating", "版本不对的缓存不得装载");
  } finally {
    client.disconnect();
  }

  const storage2 = installLocalStorage("tok");
  storage2.setItem(CACHE_KEY, JSON.stringify({ version: 1, savedAt: 1, daemons: [], projects: [], workspaces: [], tasks: [], ports: {}, sessionAgents: {} }));
  const client2 = newClient(true);
  try {
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ case: "authError", value: { message: "bad" } });
    assert.equal(client2.store.getState().authState, "auth-failed");
    assert.equal(storage2.getItem(CACHE_KEY), null, "authError 必须清缓存");
  } finally {
    client2.disconnect();
  }
});

test("(d) 离线冷启动：缓存里的登录身份一并恢复；旧缓存缺该字段按空串兼容且不作废（plan 110）", async () => {
  const base = {
    version: 1,
    savedAt: 1,
    daemons: [],
    projects: [{ id: "p-cached", daemonId: "d1", name: "cached" }],
    workspaces: [],
    tasks: [],
    ports: {},
    sessionAgents: {},
  };

  const storage = installLocalStorage("tok");
  storage.setItem(CACHE_KEY, JSON.stringify({ ...base, loginName: "wsq@example.com" }));
  const client = newClient(true);
  try {
    FakeWebSocket.latest().fail();
    const state = client.store.getState();
    assert.equal(state.authState, "authed");
    assert.equal(state.loginName, "wsq@example.com", "冷启动装载后仍认得出「我是谁」");
  } finally {
    client.disconnect();
  }

  // plan 110 之前写的缓存没有 loginName：版本号仍是 1，必须照常装载，身份退回空串。
  const legacyStorage = installLocalStorage("tok");
  legacyStorage.setItem(CACHE_KEY, JSON.stringify(base));
  const legacyClient = newClient(true);
  try {
    FakeWebSocket.latest().fail();
    const state = legacyClient.store.getState();
    assert.equal(state.authState, "authed", "旧缓存不得因缺字段作废");
    assert.deepEqual(state.projects.map((project) => project.id), ["p-cached"]);
    assert.equal(state.loginName, "", "缺字段按空串");
  } finally {
    legacyClient.disconnect();
  }
});

test("(c) 不传选项：既有行为不变——不写缓存、连接失败仍停在 authenticating、已有缓存被忽略", async () => {
  const storage = installLocalStorage("tok");
  storage.setItem(CACHE_KEY, JSON.stringify({ version: 1, savedAt: 1, daemons: [], projects: [{ id: "p-cached", daemonId: "d1", name: "cached" }], workspaces: [], tasks: [], ports: {}, sessionAgents: {} }));
  storage.setItemCalls = 0;
  const client = newClient(false);
  try {
    FakeWebSocket.latest().fail();
    assert.equal(client.store.getState().authState, "authenticating");
    assert.deepEqual(client.store.getState().projects, []);
  } finally {
    client.disconnect();
  }

  const storage2 = installLocalStorage("tok");
  const client2 = newClient(false);
  try {
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ case: "authOk", value: { accountId: "a1", iceServers: [] } });
    socket.receive(snapshot);
    await flushMicrotasks();
    assert.equal(storage2.setItemCalls, 0, "浏览器路径不得写离线目录");
    assert.equal(storage2.getItem(CACHE_KEY), null);
  } finally {
    client2.disconnect();
  }
});
