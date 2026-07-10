/**
 * 黑盒集成测试：端口转发反代（plan 004-006）的验收（plan 007）。
 *
 * 覆盖四类行为，全部对真实起的 Rust daemon + TS server 做，不 mock 任何一层：
 *   1. 探测/撤销 —— PTY 内起的 HTTP 服务端口出现在 ports.updated 里；停任务后撤销（空集广播）；
 *      测试进程自己开的、不在 PTY 进程树下的端口，绝不出现在任何 ports.updated / state.snapshot 里
 *      （这是 crates/worker/src/ports.rs 已有单测覆盖的安全边界，这里在黑盒层面再验一遍）。
 *   2. 门禁 —— 无 cookie 302 到 web /proxy-auth；client 用 WS proxy.issueAuth 换一次性回调 URL；
 *      回调种 cookie 并 302 回原路径；带 cookie 200 拿到被代理服务的真实响应体；伪造 cookie 仍被
 *      拒（302，不放行）；对外部域名的 redirect 被拒（ok:false）。
 *   3. WS 透传 —— 代理一个 PTY 内起的真实 WebSocket echo 服务，伪造 Host + 合法 cookie 完成
 *      upgrade 握手并 echo 往返（验证 HMR 一类流量能走通）。
 *   4. 生命周期 —— daemon 断线：在途代理请求应失败、路由撤销广播应到达；daemon 重连（底层服务
 *      进程仍存活）后：端口重新上报，(可能换了 shortId 的)新链接可再次打通。
 *
 * 设计要点（对应 plan 007 的 Decisions）：
 * - 用 node:http 手发请求而非 fetch：fetch 禁止覆盖 Host 头（WHATWG 禁止头名单），
 *   而伪造 Host 打到 <shortId>.p.localhost 正是本测试的核心手法（真实连的是 127.0.0.1:<PORT>）。
 * - PTY 内跑的辅助服务写成真实 .js 文件（而非一行 node -e）：更易读、避免 shell 转义地雷。
 * - WS echo 服务在 PTY 内用真实 `ws` 库实现（而非手撸帧解析），靠 daemonEnv.NODE_PATH 指向
 *   tests/node_modules（已有到 pnpm store 的 ws 符号链接），让 PTY 里的 node 能 require("ws")。
 *   tests/package.json 已有 ws/postgres/jose 等 devDependency，未新增。
 * - COFLUX_PROXY_SCHEME=http：测试栈由 harness 起，未设 COFLUX_DEV=1，config.ts 的 isDev 为 false，
 *   proxyScheme 会默认落到 https（只影响 Location/cookie 里拼的 scheme 字符串，不影响测试服务器
 *   实际监听的是不是 TLS——它本来就是普通 http.Server）。为了断言简单、避免 scheme 漂移，
 *   显式钉死为 http（经 harness.mjs 新增的 opts.serverEnv 通道注入）。
 * - Client.waitFor 会先查历史 log 再等待新消息，同一 client 上对"可能出现不止一次"的消息类型
 *   （ports.updated、proxy.auth）重复等待时，若直接复用 waitFor 会命中陈旧的历史消息。
 *   waitForSince() 显式从某个 log 位置之后找，规避这个陷阱（用法见下）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8831;
const TESTS_ROOT = resolve(import.meta.dirname, "..");

let stack;
let repo;
let workspaceId;

/* ============================ PTY 内跑的辅助服务 ============================ */

const HTTP_ECHO_SERVER_SRC = `
const http = require("http");
const server = http.createServer((req, res) => {
  res.end("hello-from-pty");
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT=" + server.address().port);
});
`;

const GATE_SERVER_SRC = `
const http = require("http");
const server = http.createServer((req, res) => {
  res.end("GATE-OK");
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT=" + server.address().port);
});
`;

const SLOW_SERVER_SRC = `
const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/slow") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("CHUNK1\\n");
    setTimeout(() => {
      try { res.end("CHUNK2\\n"); } catch (e) { /* 客户端可能已断开 */ }
    }, 10000);
    return;
  }
  res.end("OK-C");
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT=" + server.address().port);
});
`;

const WS_ECHO_SERVER_SRC = `
const { WebSocketServer } = require("ws");
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
  console.log("WSPORT=" + wss.address().port);
});
wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    ws.send(data, { binary: isBinary });
  });
});
`;

/* ============================ 通用 helper ============================ */

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** 累积某 sessionId 的全部 pty.output，直到正则匹配（PTY 输出可能带 ANSI 转义、可能跨帧分片）。 */
async function waitPtyMatch(client, sessionId, re, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const acc = client.log
      .filter((m) => m.type === "pty.output" && m.sessionId === sessionId)
      .map((m) => m.data)
      .join("");
    const m = stripAnsi(acc).match(re);
    if (m) return m;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for PTY output matching ${re}`);
    await sleep(150);
  }
}

/** 从 sinceIndex（含）之后的 log 位置里找 pred 命中的消息；避免命中同类型/同内容在测试更早阶段
 * 就已出现过的历史消息（如同一 taskId 的 ports.updated、同一 client 的 proxy.auth 在测试里可能
 * 出现不止一次，纯用 client.waitFor(pred) 会直接命中陈旧的第一条）。 */
function waitForSince(client, sinceIndex, pred, label, timeout = 10000) {
  const hit = client.log.slice(sinceIndex).find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for " + label)), timeout);
    client.waiters.push({ try: (m) => (pred(m) ? (clearTimeout(t), resolve(m), true) : false) });
  });
}

function waitPortsUpdated(client, sinceIndex, pred, label, timeout = 12000) {
  return waitForSince(client, sinceIndex, (m) => m.type === "ports.updated" && pred(m), label, timeout);
}

async function waitUntil(pred, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for " + label);
    await sleep(150);
  }
}

/** 建一个任务并启动，等到 running，返回 {taskId, sessionId}。 */
async function startTaskRunning(client, wsId, title) {
  const sinceIndex = client.log.length;
  client.send({ type: "task.create", workspaceId: wsId, title });
  const created = await waitForSince(client, sinceIndex, (m) => m.type === "task.updated" && m.task.title === title && m.task.status === "idle", "task idle");
  const taskId = created.task.id;
  client.send({ type: "task.start", taskId, cols: 80, rows: 24 });
  const running = await client.waitFor((m) => m.type === "task.updated" && m.task.id === taskId && m.task.status === "running" && m.task.sessionId, "task running", 15000);
  return { taskId, sessionId: running.task.sessionId };
}

/** 裸 HTTP 请求：连 127.0.0.1:PORT，显式设 Host 头伪装成打到 <shortId>.p.localhost。
 * 用 node:http（而非 fetch）因为 fetch 禁止覆盖 Host 头。一次性连接（agent:false），
 * 与反代"每请求一条隧道、响应完主动关连接"的设计天然匹配。 */
function rawRequest(port, { method = "GET", host, path = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, agent: false, headers: { Host: host, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 与 rawRequest 同样的连接手法，但不等响应结束，暴露一个可轮询的累积状态——用于观察"在途"请求
 * 在 daemon 断线时被切断（永远等不到完整响应）。 */
function rawStreamingRequest(port, { method = "GET", host, path = "/", headers = {} } = {}) {
  const state = { body: "", closed: false, reason: null };
  const req = http.request(
    { host: "127.0.0.1", port, method, path, agent: false, headers: { Host: host, ...headers } },
    (res) => {
      res.on("data", (c) => { state.body += c.toString("utf8"); });
      res.on("end", () => { state.closed = true; state.reason = state.reason ?? "end"; });
      res.on("aborted", () => { state.closed = true; state.reason = state.reason ?? "aborted"; });
      res.on("close", () => { state.closed = true; state.reason = state.reason ?? "close"; });
      res.on("error", () => { state.closed = true; state.reason = state.reason ?? "error"; });
    },
  );
  req.on("error", () => { state.closed = true; state.reason = state.reason ?? "req-error"; });
  req.end();
  return state;
}

/** 门禁完整握手：无 cookie 请求 -> 302 -> WS proxy.issueAuth 换回调 URL -> 打回调 URL 拿 Set-Cookie。
 * 返回 {cookie, callbackLocation}。每个测试用它时都传入一个"这次测试专属"的 client，
 * 或至少接受它会往该 client 的 log 里追加一条 proxy.auth（本文件里同一 client 若要多次拿
 * proxy.auth 应答，一律通过 waitForSince 按位置消歧，见 requirement 2 里对伪造 redirect 的断言）。 */
async function gateLogin(client, port, host, path = "/") {
  const first = await rawRequest(port, { host, path });
  assert.equal(first.status, 302, "无 cookie 请求应被 302 到 web 授权页");
  const loc = new URL(first.headers.location);
  assert.equal(loc.pathname, "/proxy-auth", "302 应指向 web 的 /proxy-auth 授权路由");
  const to = loc.searchParams.get("to");
  assert.ok(to, "302 Location 应带 to 参数（原始完整 URL）");

  const sinceIndex = client.log.length;
  client.send({ type: "proxy.issueAuth", redirect: to });
  const auth = await waitForSince(client, sinceIndex, (m) => m.type === "proxy.auth", "proxy.auth", 8000);
  assert.equal(auth.ok, true, "proxy.issueAuth 应成功换到回调 URL");
  assert.ok(auth.url, "proxy.auth 应带回调 URL");

  const cb0 = new URL(auth.url);
  const cb = await rawRequest(port, { host: cb0.host, path: cb0.pathname + cb0.search });
  assert.equal(cb.status, 302, "授权回调应种 cookie 并 302 回原路径");
  const setCookie = [].concat(cb.headers["set-cookie"] ?? [])[0];
  assert.ok(setCookie, "授权回调应种下门禁 cookie");
  const cookieMatch = /cf_proxy_session=([^;]+)/.exec(setCookie);
  assert.ok(cookieMatch, "Set-Cookie 应含 cf_proxy_session");
  return { cookie: cookieMatch[1], callbackLocation: cb.headers.location };
}

/* ============================ 生命周期 ============================ */

before(async () => {
  stack = await startStack({
    port: PORT,
    // 让 PTY 内的 node 能 require("ws")（tests/node_modules/ws 是到 pnpm store 的符号链接）。
    daemonEnv: { NODE_PATH: join(TESTS_ROOT, "node_modules") },
    // 钉死 http，避免测试环境未设 COFLUX_DEV=1 时 proxyScheme 默认落到 https 导致断言漂移
    // （代理的实际传输仍是普通 TCP，与这个 scheme 字符串无关，见文件头注释）。
    serverEnv: { COFLUX_PROXY_SCHEME: "http" },
  });
  repo = mkRepo();
  writeFileSync(join(repo.dir, "server-http.js"), HTTP_ECHO_SERVER_SRC);
  writeFileSync(join(repo.dir, "server-gate.js"), GATE_SERVER_SRC);
  writeFileSync(join(repo.dir, "server-slow.js"), SLOW_SERVER_SRC);
  writeFileSync(join(repo.dir, "ws-echo.js"), WS_ECHO_SERVER_SRC);

  const setup = stack.makeClient();
  await setup.authSubscribe(stack.username, stack.password);
  setup.send({ type: "project.import", daemonId: stack.daemonId, path: repo.dir });
  const main = await setup.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain, "main workspace", 15000);
  workspaceId = main.workspace.id;
  setup.close();
});

after(async () => {
  if (stack) await stack.stop();
  if (repo) repo.cleanup();
});

/* ============================ Requirement 1：探测 + 撤销 + 安全边界 ============================ */

test("端口探测：PTY 内服务端口出现在 ports.updated；停任务后撤销为空集；非 PTY 端口绝不上报", async () => {
  const c = stack.makeClient();
  await c.authSubscribe(stack.username, stack.password);

  // 安全边界对照组：测试进程自己开一个监听端口（不在任何 daemon PTY 进程树下）。
  const rogue = net.createServer();
  await new Promise((resolve, reject) => {
    rogue.listen(0, "127.0.0.1", resolve);
    rogue.on("error", reject);
  });
  const roguePort = rogue.address().port;

  try {
    const { taskId, sessionId } = await startTaskRunning(c, workspaceId, "probe-task");
    const sinceStart = c.log.length;
    c.send({ type: "pty.input", sessionId, data: "node server-http.js\r" });
    const m = await waitPtyMatch(c, sessionId, /PORT=(\d+)/);
    const port = Number(m[1]);

    const updated = await waitPortsUpdated(c, sinceStart, (msg) => msg.taskId === taskId && msg.ports.some((p) => p.port === port), "ports.updated with probed port");
    const entry = updated.ports.find((p) => p.port === port);
    assert.ok(entry.url, "端口上报应带预览 URL");
    assert.ok(!updated.ports.some((p) => p.port === roguePort), "rogue 端口不应出现在同一条 ports.updated 里");

    // 显式安全边界断言：整段测试期间任何一条 ports.updated 广播都不该含 rogue 端口。
    const everReported = c.log.filter((x) => x.type === "ports.updated").flatMap((x) => x.ports.map((p) => p.port));
    assert.ok(!everReported.includes(roguePort), "PTY 之外起的端口绝不应出现在任何 ports.updated 广播里");

    // state.snapshot 同样不该含 rogue 端口，且应含探测到的端口。
    const fresh = stack.makeClient();
    const snap = await fresh.authSubscribe(stack.username, stack.password);
    assert.ok(snap.ports?.some((p) => p.taskId === taskId && p.port === port), "state.snapshot 应含探测到的端口");
    assert.ok(!snap.ports?.some((p) => p.port === roguePort), "state.snapshot 不应含 rogue 端口");
    fresh.close();

    // 停任务 -> 路由应被撤销（空集广播）。task.stop 的撤销是异步的（要等 daemon 的
    // session.exit 回执才触发 dropSession），故用轮询等待，不假设同步生效。
    const sinceStop = c.log.length;
    c.send({ type: "task.stop", taskId });
    const revoked = await waitPortsUpdated(c, sinceStop, (msg) => msg.taskId === taskId && msg.ports.length === 0, "revocation ports.updated");
    assert.equal(revoked.ports.length, 0, "任务停止后应广播空端口集（撤销）");
  } finally {
    rogue.close();
    c.close();
  }
});

/* ============================ Requirement 2：门禁 ============================ */

test("门禁：无 cookie 302 到授权页；issueAuth 换回调 URL；回调种 cookie 并 302 回原路径；带 cookie 200 拿到真实响应；伪造 cookie 与外部 redirect 均被拒", async () => {
  const c = stack.makeClient();
  await c.authSubscribe(stack.username, stack.password);
  const { taskId, sessionId } = await startTaskRunning(c, workspaceId, "gate-task");
  const sinceStart = c.log.length;
  c.send({ type: "pty.input", sessionId, data: "node server-gate.js\r" });
  const m = await waitPtyMatch(c, sessionId, /PORT=(\d+)/);
  const port = Number(m[1]);
  const updated = await waitPortsUpdated(c, sinceStart, (msg) => msg.taskId === taskId && msg.ports.some((p) => p.port === port), "gate task port reported");
  const url = updated.ports.find((p) => p.port === port).url;
  const host = new URL(url).host;

  const { cookie, callbackLocation } = await gateLogin(c, PORT, host, "/");
  assert.equal(callbackLocation, "/", "授权回调应 302 回原始路径");

  const ok = await rawRequest(PORT, { host, path: "/", headers: { Cookie: `cf_proxy_session=${cookie}` } });
  assert.equal(ok.status, 200, "带有效 cookie 的请求应被代理并 200");
  assert.equal(ok.body, "GATE-OK", "响应体应来自被代理的真实服务，而非网关自己拼的内容");

  const forged = await rawRequest(PORT, { host, path: "/", headers: { Cookie: "cf_proxy_session=forged-not-a-real-token" } });
  assert.equal(forged.status, 302, "伪造 cookie 不应放行，仍应被 302 到授权页");

  const sinceReject = c.log.length;
  c.send({ type: "proxy.issueAuth", redirect: "https://evil.com/" });
  const rejected = await waitForSince(c, sinceReject, (msg) => msg.type === "proxy.auth", "proxy.auth（外部 redirect）");
  assert.equal(rejected.ok, false, "issueAuth 对外部域名的 redirect 应拒绝（ok:false）");

  c.close();
});

/* ============================ Requirement 3：WS 透传 ============================ */

test("WS 透传：代理一个 PTY 内的 WebSocket echo 服务，伪造 Host + 合法 cookie 完成 upgrade 并 echo 往返", async () => {
  const c = stack.makeClient();
  await c.authSubscribe(stack.username, stack.password);
  const { taskId, sessionId } = await startTaskRunning(c, workspaceId, "ws-task");
  const sinceStart = c.log.length;
  c.send({ type: "pty.input", sessionId, data: "node ws-echo.js\r" });
  const m = await waitPtyMatch(c, sessionId, /WSPORT=(\d+)/);
  const port = Number(m[1]);
  const updated = await waitPortsUpdated(c, sinceStart, (msg) => msg.taskId === taskId && msg.ports.some((p) => p.port === port), "ws task port reported");
  const url = updated.ports.find((p) => p.port === port).url;
  const host = new URL(url).host;

  const { cookie } = await gateLogin(c, PORT, host, "/");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, {
    headers: { Host: host, Cookie: `cf_proxy_session=${cookie}` },
  });
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const echoed = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("echo timeout")), 8000);
      ws.once("message", (data) => { clearTimeout(t); resolve(data.toString("utf8")); });
      ws.once("error", (e) => { clearTimeout(t); reject(e); });
      ws.send("hello-over-tunnel-42");
    });
    assert.equal(echoed, "hello-over-tunnel-42", "经代理隧道的 WS upgrade 应能正常 echo 往返（HMR 一类流量能走通）");
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
  c.close();
});

/* ============================ Requirement 4：生命周期 ============================ */

test("生命周期：daemon 断线使在途代理请求失败并触发路由撤销；重连后端口重新上报、新链接可再次打通", async () => {
  const c = stack.makeClient();
  await c.authSubscribe(stack.username, stack.password);
  const { taskId, sessionId } = await startTaskRunning(c, workspaceId, "lifecycle-task");
  const sinceStart = c.log.length;
  c.send({ type: "pty.input", sessionId, data: "node server-slow.js\r" });
  const m = await waitPtyMatch(c, sessionId, /PORT=(\d+)/);
  const port = Number(m[1]);
  const first = await waitPortsUpdated(c, sinceStart, (msg) => msg.taskId === taskId && msg.ports.some((p) => p.port === port), "first ports.updated");
  const firstUrl = first.ports.find((p) => p.port === port).url;
  const firstHost = new URL(firstUrl).host;

  const { cookie } = await gateLogin(c, PORT, firstHost, "/");

  const ok1 = await rawRequest(PORT, { host: firstHost, path: "/", headers: { Cookie: `cf_proxy_session=${cookie}` } });
  assert.equal(ok1.status, 200, "断线之前，正常代理请求应先能打通");
  assert.equal(ok1.body, "OK-C");

  // 制造"在途"请求：命中 /slow，服务端先写 CHUNK1、再 sleep 10s 才写 CHUNK2+end。
  // 收到 CHUNK1 后立刻杀掉 worker，断言连接被切断、CHUNK2 永远送不到。
  const inflight = rawStreamingRequest(PORT, { host: firstHost, path: "/slow", headers: { Cookie: `cf_proxy_session=${cookie}` } });
  await waitUntil(() => inflight.body.includes("CHUNK1"), 5000, "CHUNK1 到达");

  const sinceKill = c.log.length;
  const workerPid1 = Number(readFileSync(join(stack.home, "worker.pid"), "utf8").trim());
  process.kill(workerPid1, "SIGKILL");

  await waitUntil(() => inflight.closed, 8000, "在途请求因 daemon 断线而终止");
  assert.ok(!inflight.body.includes("CHUNK2"), "daemon 断线应切断在途代理请求，CHUNK2 不应送达");

  // 路由撤销广播到达（daemon 断线 -> handleDaemonClose -> routeTable.releaseDaemon -> 广播空集）。
  const revoked = await waitPortsUpdated(c, sinceKill, (msg) => msg.taskId === taskId && msg.ports.length === 0, "revocation ports.updated after daemon disconnect");
  assert.equal(revoked.ports.length, 0);

  // 旧链接此时应失败（路由已摘除，非"仍代理成功"）。
  const afterKill = await rawRequest(PORT, { host: firstHost, path: "/", headers: { Cookie: `cf_proxy_session=${cookie}` } });
  assert.equal(afterKill.status, 404, "daemon 掉线期间旧预览链接的路由已被摘除，应 404 而非继续代理成功");

  // 等 supervisor 自动重启 worker、两级 resync 完成、daemon 重新在线。
  await waitUntil(async () => {
    const p = stack.makeClient();
    try {
      const snap = await p.authSubscribe(stack.username, stack.password);
      return !!snap.daemons.find((d) => d.daemonId === stack.daemonId && d.online);
    } catch {
      return false;
    } finally {
      p.close();
    }
  }, 20000, "daemon 重新在线");

  const workerPid2 = Number(readFileSync(join(stack.home, "worker.pid"), "utf8").trim());
  assert.notEqual(workerPid2, workerPid1, "supervisor 应已拉起一个新的 worker 进程");

  // 重连后 worker 立即强制上报一次端口（见 crates/worker/src/main.rs 的 on_authed），无需等 2s 周期。
  // 复用 sinceKill（而非在"确认 daemon 在线"轮询之后才取新的 log 位置）：重新上报可能在
  // 轮询期间就已经到达 c 的 log，若在那之后才截取起点，会因切片起点晚于消息本身而永远等不到。
  // sinceKill 必然早于任何"重新上报"、又晚于"首次上报"，据此就能把两者精确分开。
  const second = await waitPortsUpdated(c, sinceKill, (msg) => msg.taskId === taskId && msg.ports.some((p) => p.port === port), "re-reported ports.updated after reconnect", 20000);
  const secondUrl = second.ports.find((p) => p.port === port).url;
  const secondHost = new URL(secondUrl).host;

  const ok2 = await rawRequest(PORT, { host: secondHost, path: "/", headers: { Cookie: `cf_proxy_session=${cookie}` } });
  assert.equal(ok2.status, 200, "重连后新（或相同）shortId 的链接应可再次打通代理");
  assert.equal(ok2.body, "OK-C");

  c.close();
});
