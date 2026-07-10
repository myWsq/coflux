/**
 * 黑盒集成测试基建。
 *
 * 通过真实进程（tsx 起 server + daemon）与 WebSocket 线协议驱动，完全不依赖应用内部实现，
 * 因此能在重构内部结构后依然保护"对外可观察行为"不变 —— 这正是它的目的。
 *
 * 每个测试文件用 startStack() 起一套独立的 server+daemon（独立端口 + 临时 DB + 临时 HOME），
 * after() 里 stop() 清理。
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { WebSocket } from "ws";
import postgres from "postgres";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const DEBUG = !!process.env.COFLUX_TEST_DEBUG;

/*
 * 每个测试栈用一个独立的临时 Postgres 库（而非临时 schema）：
 * 隔离干净、无需改动任何 SQL，代价只是建/删库的开销（对测试量级可忽略）。
 * 管理连接（建库/删库用）与 server 自己的连接串一样，走 COFLUX_TEST_PG_URL，
 * 弱默认值必须与 apps/server/src/config.ts 的 DATABASE_URL 开发默认值保持一致。
 */
const ADMIN_PG_URL = process.env.COFLUX_TEST_PG_URL || "postgres://postgres:postgres@127.0.0.1:5432/postgres";

/** 建一个随机命名的临时库，返回 {name, url}（url 指向新库，供 spawn 的 server 用作 DATABASE_URL）。 */
async function createTestDatabase() {
  const name = `coflux_test_${randomUUID().replace(/-/g, "")}`;
  const admin = postgres(ADMIN_PG_URL, { max: 1, ssl: "prefer" });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_PG_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

/** 删临时库：DROP ... WITH (FORCE)（PG 13+）由服务端原子地踢连接并删库。
 * 不用 pg_terminate_backend + DROP 两步：terminate 发完信号即返回、不等 backend 真正退出，
 * 紧随的 DROP 仍可能撞上垂死连接报 "being accessed by other users"，造成非确定性泄漏。 */
async function dropTestDatabase(name) {
  const admin = postgres(ADMIN_PG_URL, { max: 1, ssl: "prefer" });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** 清理路径共用：删库失败不让绿测试变红，但必须在 stderr 留痕（静默吞掉=泄漏不可见）。 */
async function dropTestDatabaseLoudly(name) {
  try {
    await dropTestDatabase(name);
  } catch (e) {
    console.error(`[harness] failed to drop test database ${name}: ${e?.message ?? e}`);
  }
}

/* 数据面二进制帧编解码（与 packages/protocol 保持一致；harness 用纯 JS 内联一份，
   刻意不依赖应用内部，符合黑盒定位）。帧体：[kind][sidLen][sessionId][?ridLen][?requestId][payload] */
const FRAME_KIND = { "pty.output": 1, "pty.input": 2, "pty.replay": 3 };
const FRAME_TYPE = { 1: "pty.output", 2: "pty.input", 3: "pty.replay" };
const DATA_PLANE = new Set(["pty.output", "pty.input", "pty.replay"]);
const _te = new TextEncoder();
const _td = new TextDecoder();
function encodeFrame(msg) {
  const sid = _te.encode(msg.sessionId);
  const payload = _te.encode(msg.data ?? "");
  const rid = msg.type === "pty.replay" ? _te.encode(msg.requestId) : null;
  const out = new Uint8Array(2 + sid.length + (rid ? 1 + rid.length : 0) + payload.length);
  out[0] = FRAME_KIND[msg.type];
  out[1] = sid.length;
  out.set(sid, 2);
  let off = 2 + sid.length;
  if (rid) { out[off++] = rid.length; out.set(rid, off); off += rid.length; }
  out.set(payload, off);
  return out;
}
function decodeFrame(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length < 2) return null;
  const type = FRAME_TYPE[u[0]];
  if (!type) return null;
  const sidLen = u[1];
  const sessionId = _td.decode(u.subarray(2, 2 + sidLen));
  let off = 2 + sidLen;
  if (type === "pty.replay") {
    const ridLen = u[off++];
    const requestId = _td.decode(u.subarray(off, off + ridLen));
    off += ridLen;
    return { type, sessionId, requestId, data: _td.decode(u.subarray(off)) };
  }
  return { type, sessionId, data: _td.decode(u.subarray(off)) };
}

function spawnApp(rel, env) {
  return spawn(TSX, [join(ROOT, rel)], { env, stdio: DEBUG ? "inherit" : "ignore", detached: true });
}

// daemon = Rust supervisor + Rust worker（两个二进制，零 node 运行时）。
// 默认用 target/debug 下的产物（pretest 会 cargo build）；可用环境变量覆盖路径。
const SUPERVISOR_BIN = process.env.COFLUX_SUPERVISOR_BIN || join(ROOT, "target/debug/coflux-supervisor");
const WORKER_BIN = process.env.COFLUX_WORKER_BIN || join(ROOT, "target/debug/coflux-worker");
export function spawnDaemon(env) {
  const env2 = { ...env, COFLUX_WORKER_CMD: WORKER_BIN, COFLUX_WORKER_ARGS: "[]" };
  return spawn(SUPERVISOR_BIN, [], { env: env2, cwd: ROOT, stdio: DEBUG ? "inherit" : "ignore", detached: true });
}
export function killTree(p) {
  if (!p) return;
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    try {
      p.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

function httpHealth(port) {
  return new Promise((res) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1000 }, (r) => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
  });
}
async function waitHealth(port, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await httpHealth(port)) return;
    await sleep(150);
  }
  throw new Error("server did not become healthy");
}

/** 造一个临时 git 仓库（一个空提交），返回路径。测试结束由 stack.stop 之外的 rmSync 清理。 */
export function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), "coflux-test-repo-"));
  // 显式 -b main：默认分支不依赖宿主/容器的 git 全局配置（否则旧 git 默认 master，断言会跨环境飘）
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

/**
 * 只起 server（不起 Rust daemon），用于 supabase 模式等需要自定认证/装配的测试。
 * opts.env 追加/覆盖 server 环境变量（如 COFLUX_AUTH、SUPABASE_URL）。
 */
export async function startServer(opts = {}) {
  const port = opts.port;
  if (!port) throw new Error("startServer requires a port");
  const testDb = await createTestDatabase();
  const serverEnv = { ...process.env, COFLUX_PORT: String(port), DATABASE_URL: testDb.url, ...(opts.env ?? {}) };
  const ref = {};
  try {
    ref.server = spawnApp("apps/server/src/index.ts", serverEnv);
    await waitHealth(port);
  } catch (e) {
    // 建库之后、句柄（含 stop()）交还调用方之前失败：就地清理，别泄漏测试库
    killTree(ref.server);
    await dropTestDatabaseLoudly(testDb.name);
    throw e;
  }
  return {
    port,
    makeClient: () => new Client(port),
    rawDaemon: () => rawDaemon(port),
    async restartServer() {
      killTree(ref.server);
      await sleep(600);
      // 复用同一个临时库（serverEnv 里的 DATABASE_URL 不变）：数据必须跨重启保留。
      ref.server = spawnApp("apps/server/src/index.ts", serverEnv);
      await waitHealth(port);
    },
    async stop() {
      killTree(ref.server);
      await sleep(150);
      await dropTestDatabaseLoudly(testDb.name);
    },
  };
}

/** 一个原始 /daemon 连接：直接发 daemon.enroll/daemon.auth，不需要 Rust supervisor。 */
export function rawDaemon(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
  const log = [];
  let waiters = [];
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } log.push(m); waiters = waiters.filter((w) => !w.try(m)); };
  return {
    ready: new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws error: " + (e.message || "?"))); }),
    /** 服务端主动关连接时解析为 close code（如 4008 auth timeout）；不关则一直 pending，调用方自行 race 超时 */
    closed: new Promise((res) => { ws.onclose = (e) => res(e.code); }),
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, label = "?", t = 8000) => {
      const h = log.find(pred);
      if (h) return Promise.resolve(h);
      return new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error("timeout " + label)), t); waiters.push({ try: (m) => (pred(m) ? (clearTimeout(tm), res(m), true) : false) }); });
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

/** 起一套独立栈，返回控制句柄。等到 daemon 在线后才返回。 */
export async function startStack(opts = {}) {
  const port = opts.port;
  if (!port) throw new Error("startStack requires a port");
  const enrollKey = opts.enrollKey ?? "dev-enroll";
  const username = opts.username ?? "admin";
  const password = opts.password ?? "admin";

  const testDb = await createTestDatabase();
  const home = mkdtempSync(join(tmpdir(), "coflux-test-home-"));

  // opts.serverEnv：额外/覆盖 server 侧 env（如 proxy.test.mjs 显式钉死 COFLUX_PROXY_SCHEME，
  // 避免测试环境未设 COFLUX_DEV 时 isDev=false 导致 proxyScheme 默认落到 https，门禁/cookie 断言随之漂移）。
  const serverEnv = { ...process.env, COFLUX_PORT: String(port), DATABASE_URL: testDb.url, COFLUX_ENROLL_KEY: enrollKey, COFLUX_USERNAME: username, COFLUX_PASSWORD: password, ...(opts.serverEnv ?? {}) };
  const daemonEnv = { ...process.env, COFLUX_SERVER: `ws://127.0.0.1:${port}/daemon`, COFLUX_ENROLL_KEY: enrollKey, COFLUX_HOME: home, COFLUX_DEVICE_NAME: opts.deviceName ?? "test-dev", ...(opts.daemonEnv ?? {}) };

  const ref = { server: null, daemon: null };
  try {
    ref.server = spawnApp("apps/server/src/index.ts", serverEnv);
    await waitHealth(port);
    ref.daemon = spawnDaemon(daemonEnv);
  } catch (e) {
    // 建库之后、stack.stop() 可用之前失败：就地清理，别泄漏测试库/临时目录
    killTree(ref.daemon);
    killTree(ref.server);
    if (existsSync(home)) try { rmSync(home, { recursive: true, force: true }); } catch {}
    await dropTestDatabaseLoudly(testDb.name);
    throw e;
  }

  const stack = {
    port,
    username,
    password,
    enrollKey,
    home,
    daemonId: null,
    makeClient: () => new Client(port),
    async restartServer() {
      killTree(ref.server);
      await sleep(800);
      // 复用同一个临时库（serverEnv 里的 DATABASE_URL 不变）：数据必须跨重启保留（reconnect.test.mjs 依赖此行为）。
      ref.server = spawnApp("apps/server/src/index.ts", serverEnv);
      await waitHealth(port);
    },
    /** 给 server 发 SIGTERM，等其优雅退出，返回退出码（或 'timeout'） */
    gracefulStopServer(ms = 3000) {
      return new Promise((res) => {
        const p = ref.server;
        if (!p) return res(null);
        const t = setTimeout(() => res("timeout"), ms);
        p.on("exit", (code) => { clearTimeout(t); res(code); });
        try { process.kill(p.pid, "SIGTERM"); } catch { clearTimeout(t); res("err"); }
      });
    },
    async health() {
      return new Promise((res, rej) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 2000 }, (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => { try { res({ status: r.statusCode, json: JSON.parse(body) }); } catch { res({ status: r.statusCode, json: null }); } });
        });
        req.on("error", rej);
        req.on("timeout", () => { req.destroy(); rej(new Error("health timeout")); });
      });
    },
    async stop() {
      killTree(ref.daemon);
      killTree(ref.server);
      await sleep(200);
      if (existsSync(home)) try { rmSync(home, { recursive: true, force: true }); } catch {}
      await dropTestDatabaseLoudly(testDb.name);
    },
  };

  // 等 daemon 在线：每次用全新 client 取一份新鲜快照（避免读到旧快照）
  let dev = null;
  for (let i = 0; i < 60 && !dev; i++) {
    const p = stack.makeClient();
    try {
      const s = await p.authSubscribe(username, password);
      dev = s.daemons.find((d) => d.online);
    } catch {
      /* server 可能还没就绪 */
    }
    p.close();
    if (!dev) await sleep(250);
  }
  if (!dev) {
    await stack.stop();
    throw new Error("daemon did not come online");
  }
  stack.daemonId = dev.daemonId;
  return stack;
}

/** 一个测试用 WebSocket client，带消息日志与 waitFor。 */
export class Client {
  constructor(port) {
    this.log = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error("ws error: " + (e.message || "?")));
    });
    this.ws.onmessage = (ev) => {
      let m;
      if (typeof ev.data === "string") {
        try { m = JSON.parse(ev.data); } catch { return; }
      } else {
        // 数据面二进制帧 → 还原为 {type,sessionId,data} 以兼容既有 waitFor 断言
        m = decodeFrame(ev.data);
        if (!m) return;
      }
      this.log.push(m);
      this.waiters = this.waiters.filter((w) => !w.try(m));
    };
  }
  send(m) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // 数据面 type 自动编码为二进制帧，控制面走 JSON —— 既有调用点无需改动
    if (DATA_PLANE.has(m.type)) this.ws.send(encodeFrame(m));
    else this.ws.send(JSON.stringify(m));
  }
  waitFor(pred, label = "?", timeout = 10000) {
    const hit = this.log.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for " + label)), timeout);
      this.waiters.push({ try: (m) => (pred(m) ? (clearTimeout(t), res(m), true) : false) });
    });
  }
  async authSubscribe(username = "admin", password = "admin") {
    await this.ready;
    this.send({ type: "client.auth", username, password });
    await this.waitFor((m) => m.type === "auth.ok", "auth.ok");
    this.send({ type: "client.subscribe" });
    return this.waitFor((m) => m.type === "state.snapshot", "snapshot");
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}
