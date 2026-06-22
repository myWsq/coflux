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
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { WebSocket } from "ws";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const DEBUG = !!process.env.COFLUX_TEST_DEBUG;

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
function spawnDaemon(env) {
  const env2 = { ...env, COFLUX_WORKER_CMD: WORKER_BIN, COFLUX_WORKER_ARGS: "[]" };
  return spawn(SUPERVISOR_BIN, [], { env: env2, cwd: ROOT, stdio: DEBUG ? "inherit" : "ignore", detached: true });
}
function killTree(p) {
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

/** 起一套独立栈，返回控制句柄。等到 daemon 在线后才返回。 */
export async function startStack(opts = {}) {
  const port = opts.port;
  if (!port) throw new Error("startStack requires a port");
  const enrollKey = opts.enrollKey ?? "dev-enroll";
  const username = opts.username ?? "admin";
  const password = opts.password ?? "admin";

  const dataDir = mkdtempSync(join(tmpdir(), "coflux-test-db-"));
  const home = mkdtempSync(join(tmpdir(), "coflux-test-home-"));
  const db = join(dataDir, "coflux.db");

  const serverEnv = { ...process.env, COFLUX_PORT: String(port), COFLUX_DB: db, COFLUX_ENROLL_KEY: enrollKey, COFLUX_USERNAME: username, COFLUX_PASSWORD: password };
  const daemonEnv = { ...process.env, COFLUX_SERVER: `ws://127.0.0.1:${port}/daemon`, COFLUX_ENROLL_KEY: enrollKey, COFLUX_HOME: home, COFLUX_DEVICE_NAME: opts.deviceName ?? "test-dev", ...(opts.daemonEnv ?? {}) };

  const ref = { server: null, daemon: null };
  ref.server = spawnApp("apps/server/src/index.ts", serverEnv);
  await waitHealth(port);
  ref.daemon = spawnDaemon(daemonEnv);

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
      for (const d of [dataDir, home]) if (existsSync(d)) try { rmSync(d, { recursive: true, force: true }); } catch {}
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
