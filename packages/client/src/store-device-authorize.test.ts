/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema, type ServerToClientPayload } from "@coflux/protocol";

// plan 112：`authorizeDevice(token)`——用桌面的登录态兑现 daemon 打印的一次性授权 token。三种结果都可等待：
// 成功（deviceAuthorized）/ 服务端拒绝（deviceAuthorizeInfo{ ok:false } 的 error 原文）/ 未登录或连接未就绪
// （立即失败，不发请求、不挂起）。假件与 store-offline.test.ts 同款：假 WebSocket 喂服务端回音，浏览器全局最小顶替。

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
  /** 已发出的 deviceAuthorize 请求里的 token 列表 */
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

/** 连上并拿到 authOk 的 client */
function authedClient() {
  const client = newClient("tok");
  const socket = FakeWebSocket.latest();
  socket.open();
  socket.receive({ case: "authOk", value: { accountId: "a1", controlProtocolVersion: 2, loginName: "wsq@example.com" } });
  assert.equal(client.store.getState().authState, "authed");
  return { client, socket };
}

test("未登录 / 连接未就绪：立即失败、不发请求、不挂起", async () => {
  const socketsBefore = FakeWebSocket.instances.length;
  const client = newClient("");
  try {
    assert.equal(client.store.getState().authState, "need-login");
    const result = await client.authorizeDevice("abc");
    assert.deepEqual(result, { ok: false, error: "尚未登录或与服务器的连接未就绪" });
    assert.equal(FakeWebSocket.instances.length, socketsBefore, "没有 token 不会建连接，更不会发请求");
  } finally {
    client.disconnect();
  }

  // 有 token 但 authOk 还没来：同样立即失败
  const connecting = newClient("tok");
  try {
    const socket = FakeWebSocket.latest();
    socket.open();
    const result = await connecting.authorizeDevice("abc");
    assert.equal(result.ok, false);
    assert.deepEqual(socket.authorizeTokens(), [], "authOk 之前不得发 deviceAuthorize");
  } finally {
    connecting.disconnect();
  }
});

test("成功：发出 deviceAuthorize{token}，收到 deviceAuthorized 即 { ok: true }", async () => {
  const { client, socket } = authedClient();
  try {
    const pending = client.authorizeDevice("tok-123");
    assert.deepEqual(socket.authorizeTokens(), ["tok-123"], "请求体里的 token 原样带上");
    socket.receive({ case: "deviceAuthorized", value: {} });
    assert.deepEqual(await pending, { ok: true });

    // 结算后可以再发下一次
    const again = client.authorizeDevice("tok-456");
    assert.deepEqual(socket.authorizeTokens(), ["tok-123", "tok-456"]);
    socket.receive({ case: "deviceAuthorized", value: {} });
    assert.deepEqual(await again, { ok: true });
  } finally {
    client.disconnect();
  }
});

test("失败：deviceAuthorizeInfo{ ok:false } 的 error 原文交给调用方；ok:true 的 info 不结算", async () => {
  const { client, socket } = authedClient();
  try {
    const pending = client.authorizeDevice("expired");
    // 查询类回音（ok:true）不属于兑现结果，不能误判成成功或失败
    socket.receive({ case: "deviceAuthorizeInfo", value: { ok: true, name: "mac", host: "h", platform: "darwin" } });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false, "ok:true 的 deviceAuthorizeInfo 不结算");

    socket.receive({ case: "deviceAuthorizeInfo", value: { ok: false, error: "授权链接无效或已过期" } });
    assert.deepEqual(await pending, { ok: false, error: "授权链接无效或已过期" });
  } finally {
    client.disconnect();
  }
});

test("在飞期间：并发第二次立即拒绝；断连让在飞的那次失败而不是挂起", async () => {
  const { client, socket } = authedClient();
  try {
    const first = client.authorizeDevice("t1");
    const second = await client.authorizeDevice("t2");
    assert.equal(second.ok, false, "一次只允许一个在飞");
    assert.deepEqual(socket.authorizeTokens(), ["t1"], "第二次不得再发请求");

    socket.drop();
    const result = await first;
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; error: string }).error, /断开/);
  } finally {
    client.disconnect();
  }
});
