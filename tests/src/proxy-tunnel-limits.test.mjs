/** 端口预览隧道的纯内存 admission 与 HTTP/Upgrade 满额语义测试。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";

// proxy.ts 会读取 server config；单测显式使用开发配置，避免依赖调用机器上的生产秘密。
process.env.COFLUX_DEV = "1";
const {
  PROXY_COOKIE_NAME,
  ProxyGate,
  ProxyRouteTable,
  TunnelRegistry,
  handleProxyRequest,
  handleProxyUpgrade,
  routeLabel,
} = await import("../../apps/server/src/proxy.ts");

const ROUTE = {
  shortId: "device-3000",
  daemonId: "daemon-1",
  accountId: "account-1",
  taskId: "task-1",
  sessionId: "session-1",
  port: 3000,
};

function socket() {
  return new PassThrough();
}

function openedMessages(sent) {
  return sent.filter(({ payload }) => payload.case === "proxyOpen");
}

function settlesQuickly(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 未立即结算`)), 200);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("TunnelRegistry 的 connecting 与 active 共用硬上限，close 立即释放名额", async () => {
  const sent = [];
  const ids = ["conn-a", "conn-b", "conn-c"];
  const tunnels = new TunnelRegistry(
    { sendControl: (daemonId, payload) => sent.push({ daemonId, payload }) },
    2,
    () => ids.shift(),
  );

  const connectingSocket = socket();
  const activeSocket = socket();
  const connecting = tunnels.open(ROUTE, connectingSocket, 5_000);
  const active = tunnels.open(ROUTE, activeSocket, 5_000);
  assert.equal(connecting.accepted, true);
  assert.equal(active.accepted, true);

  tunnels.handleOpened(ROUTE.daemonId, active.connId, true);
  assert.deepEqual(await active.ready, { ok: true, error: undefined });

  const rejectedSocket = socket();
  const rejected = tunnels.open(ROUTE, rejectedSocket);
  assert.equal(rejected.accepted, false);
  assert.match(rejected.error, /已达上限 2/);
  assert.equal(openedMessages(sent).length, 2, "满额请求不能继续下发 proxy.open");

  tunnels.close(connecting.connId);
  assert.deepEqual(
    await settlesQuickly(connecting.ready, "connecting close"),
    { ok: false, error: "隧道已关闭" },
  );

  const replacementSocket = socket();
  const replacement = tunnels.open(ROUTE, replacementSocket, 5_000);
  assert.equal(replacement.accepted, true, "close 后必须立即腾出名额");
  assert.equal(replacement.connId, "conn-c", "满额拒绝不应消耗 connId");

  tunnels.close(active.connId);
  tunnels.close(replacement.connId);
  await settlesQuickly(replacement.ready, "replacement close");
  connectingSocket.destroy();
  activeSocket.destroy();
  rejectedSocket.destroy();
  replacementSocket.destroy();
});

test("TunnelRegistry 重复 connId fail closed，不能覆盖或关闭已有连接", async () => {
  const sent = [];
  const tunnels = new TunnelRegistry(
    { sendControl: (daemonId, payload) => sent.push({ daemonId, payload }) },
    2,
    () => "same-id",
  );
  const originalSocket = socket();
  const duplicateSocket = socket();

  const original = tunnels.open(ROUTE, originalSocket, 5_000);
  assert.equal(original.accepted, true);
  tunnels.handleOpened(ROUTE.daemonId, original.connId, true);
  assert.deepEqual(await original.ready, { ok: true, error: undefined });
  tunnels.handleOpened(ROUTE.daemonId, original.connId, true);
  tunnels.handleOpened(ROUTE.daemonId, original.connId, false, "重复回包");

  const duplicate = tunnels.open(ROUTE, duplicateSocket);
  assert.equal(duplicate.accepted, false);
  assert.match(duplicate.error, /标识冲突/);
  assert.equal(openedMessages(sent).length, 1, "重复 ID 不能下发第二条 proxy.open");

  tunnels.write(original.connId, Uint8Array.from([1, 2, 3]));
  const data = sent.find(({ payload }) => payload.case === "proxyData");
  assert.ok(data, "拒绝重复 ID 后原连接仍应可写");
  assert.deepEqual([...data.payload.value.data], [1, 2, 3]);
  assert.equal(
    sent.filter(({ payload }) => payload.case === "proxyClose").length,
    0,
    "失败尝试不能误关原连接",
  );

  tunnels.close(original.connId);
  assert.equal(
    sent.filter(({ payload }) => payload.case === "proxyClose").length,
    1,
    "原连接最终只关闭一次",
  );
  originalSocket.destroy();
  duplicateSocket.destroy();
});

test("可注入 connId 工厂同步重入时也不能穿透硬上限", async () => {
  const sent = [];
  let tunnels;
  let nested;
  let calls = 0;
  const nestedSocket = socket();
  const outerSocket = socket();
  tunnels = new TunnelRegistry(
    { sendControl: (daemonId, payload) => sent.push({ daemonId, payload }) },
    1,
    () => {
      calls += 1;
      if (calls === 1) {
        nested = tunnels.open(ROUTE, nestedSocket, 5_000);
        return "outer-id";
      }
      return "nested-id";
    },
  );

  const outer = tunnels.open(ROUTE, outerSocket, 5_000);
  assert.equal(nested.accepted, true);
  assert.equal(outer.accepted, false);
  assert.match(outer.error, /已达上限 1/);
  assert.equal(openedMessages(sent).length, 1);

  tunnels.close(nested.connId, nestedSocket);
  await settlesQuickly(nested.ready, "nested close");
  nestedSocket.destroy();
  outerSocket.destroy();
});

test("旧连接的迟到 close continuation 不能误删后来同 ID 连接", async () => {
  const sent = [];
  const tunnels = new TunnelRegistry(
    { sendControl: (daemonId, payload) => sent.push({ daemonId, payload }) },
    1,
    () => "reused-id",
  );
  const oldSocket = socket();
  const old = tunnels.open(ROUTE, oldSocket, 5_000);
  assert.equal(old.accepted, true);

  // daemon 关闭会先摘掉旧 entry 并唤醒其异步调用方；随后同 ID 的新连接可以合法占位。
  tunnels.handleClosed(ROUTE.daemonId, old.connId);
  assert.deepEqual(
    await settlesQuickly(old.ready, "old handleClosed"),
    { ok: false, error: "daemon 已关闭隧道" },
  );

  const currentSocket = socket();
  const current = tunnels.open(ROUTE, currentSocket, 5_000);
  assert.equal(current.accepted, true);
  tunnels.handleOpened(ROUTE.daemonId, current.connId, true);
  assert.deepEqual(await current.ready, { ok: true, error: undefined });

  // 模拟旧 HTTP/Upgrade await continuation 或旧 socket close/error 事件迟到执行。
  tunnels.close(old.connId, oldSocket);
  tunnels.write(current.connId, Uint8Array.from([9]));
  assert.equal(
    sent.filter(({ payload }) => payload.case === "proxyClose").length,
    0,
    "旧回调不能向 daemon 误发新连接的 proxy.close",
  );
  assert.equal(
    sent.filter(({ payload }) => payload.case === "proxyData").length,
    1,
    "旧回调后新连接必须仍可用",
  );

  tunnels.close(current.connId, currentSocket);
  currentSocket.destroy();
});

test("sendControl 异常的迟到清理不能误删同步重入产生的同 ID 新连接", async () => {
  const sent = [];
  const oldSocket = socket();
  const currentSocket = socket();
  let tunnels;
  let current;
  let firstOpen = true;
  tunnels = new TunnelRegistry(
    {
      sendControl: (daemonId, payload) => {
        sent.push({ daemonId, payload });
        if (payload.case !== "proxyOpen" || !firstOpen) return;
        firstOpen = false;
        tunnels.close(payload.value.connId, oldSocket);
        current = tunnels.open(ROUTE, currentSocket, 5_000);
        throw new Error("模拟旧 sendControl 在同步重入后抛错");
      },
    },
    1,
    () => "reentrant-id",
  );

  const old = tunnels.open(ROUTE, oldSocket, 5_000);
  assert.equal(old.accepted, true);
  assert.equal(current.accepted, true);
  assert.deepEqual(
    await settlesQuickly(old.ready, "old reentrant close"),
    { ok: false, error: "隧道已关闭" },
  );

  tunnels.handleOpened(ROUTE.daemonId, current.connId, true);
  assert.deepEqual(
    await settlesQuickly(current.ready, "current opened"),
    { ok: true, error: undefined },
  );
  tunnels.write(current.connId, Uint8Array.from([7]));
  assert.equal(
    sent.filter(({ payload }) => payload.case === "proxyData").length,
    1,
    "旧 sendControl catch 不能把新 entry 从表中删除",
  );

  tunnels.close(current.connId, currentSocket);
  oldSocket.destroy();
  currentSocket.destroy();
});

test("daemon 提前关闭 connecting 时 ready 立即失败并释放名额", async () => {
  const sent = [];
  let next = 0;
  const tunnels = new TunnelRegistry(
    { sendControl: (daemonId, payload) => sent.push({ daemonId, payload }) },
    1,
    () => `conn-${++next}`,
  );
  const firstSocket = socket();
  const first = tunnels.open(ROUTE, firstSocket, 5_000);
  assert.equal(first.accepted, true);

  tunnels.handleClosed(ROUTE.daemonId, first.connId);
  assert.deepEqual(
    await settlesQuickly(first.ready, "connecting handleClosed"),
    { ok: false, error: "daemon 已关闭隧道" },
  );
  assert.equal(firstSocket.destroyed, true);

  const secondSocket = socket();
  const second = tunnels.open(ROUTE, secondSocket, 5_000);
  assert.equal(second.accepted, true, "handleClosed 后必须立即腾出名额");
  tunnels.close(second.connId);
  await settlesQuickly(second.ready, "second close");
  secondSocket.destroy();
});

function request(port, host, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/full",
        agent: false,
        headers: { Host: host, Cookie: `${PROXY_COOKIE_NAME}=${cookie}`, Connection: "close" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function upgrade(port, host, cookie) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("等待 Upgrade 拒绝响应超时"));
    }, 2_000);
    client.on("connect", () => {
      client.write(
        [
          "GET /ws HTTP/1.1",
          `Host: ${host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Cookie: ${PROXY_COOKIE_NAME}=${cookie}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    client.on("data", (chunk) => chunks.push(chunk));
    client.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    client.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("TunnelRegistry 满额时真实 HTTP 与 Upgrade 都返回 503", async (t) => {
  const sent = [];
  const routeTable = new ProxyRouteTable();
  routeTable.reconcile(
    ROUTE.sessionId,
    ROUTE.daemonId,
    ROUTE.accountId,
    ROUTE.taskId,
    "device",
    [ROUTE.port],
  );
  const route = routeTable.get(routeLabel("device", ROUTE.port));
  assert.ok(route);

  const proxyGate = new ProxyGate();
  const cookie = proxyGate.createSession(ROUTE.accountId);
  assert.ok(cookie);

  const tunnels = new TunnelRegistry(
    { sendControl: (daemonId, payload) => sent.push({ daemonId, payload }) },
    1,
    () => "occupied",
  );
  const occupiedSocket = socket();
  const occupied = tunnels.open(route, occupiedSocket, 5_000);
  assert.equal(occupied.accepted, true);

  const ctx = { routeTable, proxyGate, tunnels };
  const server = http.createServer((req, res) => void handleProxyRequest(ctx, req, res));
  server.on("upgrade", (req, peer, head) => void handleProxyUpgrade(ctx, req, peer, head));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const host = `${route.shortId}-p.localhost`;

  const httpResult = await request(address.port, host, cookie);
  assert.equal(httpResult.status, 503);
  assert.match(httpResult.body, /已达上限 1/);

  const upgradeResult = await upgrade(address.port, host, cookie);
  assert.match(upgradeResult, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.equal(openedMessages(sent).length, 1, "HTTP/Upgrade 满额请求均不能下发 proxy.open");

  tunnels.close(occupied.connId);
  await settlesQuickly(occupied.ready, "occupied close");
  occupiedSocket.destroy();
});
