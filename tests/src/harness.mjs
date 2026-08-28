/**
 * 黑盒集成测试基建。
 *
 * 通过真实进程（tsx 起 server + daemon）与 WebSocket 线协议驱动，完全不依赖应用内部实现，
 * 因此能在重构内部结构后依然保护"对外可观察行为"不变 —— 这正是它的目的。
 *
 * 每个测试文件用 startStack() 起一套独立的 server+daemon（独立端口 + 临时 DB + 临时 HOME），
 * after() 里 stop() 清理。
 *
 * wire（plan 009）：WS 上只有 binary message，每条 = 一个 protobuf 编码的信封
 * （/daemon：DaemonToServer/ServerToDaemon；/client：ClientToServer/ServerToClient）。
 * 本文件 import 生成代码与 `@coflux/protocol` 的信封编解码 helper——它们源自 proto 真相源
 * （buf generate 产物），而非应用（apps/server、apps/web）的实现逻辑，黑盒性质因此保持
 * （仍然完全不 import apps/* 的任何代码）。
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { WebSocket } from "ws";
import postgres from "postgres";
import {
  create,
  ClientToServerSchema,
  ServerToClientSchema,
  DaemonToServerSchema,
  ServerToDaemonSchema,
  encodeClientToServer,
  decodeServerToClient,
  encodeDaemonToServer,
  decodeServerToDaemon,
} from "@coflux/protocol";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const DEBUG = !!process.env.COFLUX_TEST_DEBUG;

function stackAbortError(label) {
  const error = new Error(`${label} aborted`);
  error.name = "AbortError";
  return error;
}

function throwIfStackAborted(signal, label = "test stack") {
  if (signal?.aborted) throw stackAbortError(label);
}

function waitForStackOperation(promise, { signal, timeoutMs, label, cancel }) {
  return new Promise((resolveValue, rejectValue) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) {
        try { cancel?.(); } catch { /* best effort；主 cleanup 仍会严格复核 */ }
        rejectValue(error);
      } else {
        resolveValue(value);
      }
    };
    const aborted = () => finish(stackAbortError(label));
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    promise.then((value) => finish(undefined, value), (error) => finish(error));
    if (signal?.aborted) aborted();
  });
}

/*
 * 每个测试栈用一个独立的临时 Postgres 库（而非临时 schema）：
 * 隔离干净、无需改动任何 SQL，代价只是建/删库的开销（对测试量级可忽略）。
 * 管理连接（建库/删库用）与 server 自己的连接串一样，走 COFLUX_TEST_PG_URL，
 * 弱默认值必须与 apps/server/src/config.ts 的 DATABASE_URL 开发默认值保持一致。
 */
export const ADMIN_PG_URL = process.env.COFLUX_TEST_PG_URL || "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DATABASE_OPERATION_TIMEOUT_MS = 10000;
const DATABASE_BACKEND_DRAIN_TIMEOUT_MS = 5000;

class DatabaseBackendUnconfirmedError extends AggregateError {}

function databaseAdminClient(timeoutMs) {
  return postgres(ADMIN_PG_URL, {
    max: 1,
    ssl: "prefer",
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    connection: {
      application_name: "coflux-test-harness",
      statement_timeout: timeoutMs,
    },
  });
}

async function ensureDatabaseBackendGone(backend, timeoutMs = DATABASE_BACKEND_DRAIN_TIMEOUT_MS) {
  const admin = databaseAdminClient(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`database backend ${backend.pid} did not terminate`);
      }
      const queryTimeoutMs = Math.max(1, Math.min(remainingMs, 1000));
      const terminate = admin.unsafe(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND pid <> pg_backend_pid()",
        [backend.pid, backend.backendStart],
      ).execute();
      await waitForStackOperation(terminate, {
        timeoutMs: queryTimeoutMs,
        label: `terminate database backend ${backend.pid}`,
      });
      const count = admin.unsafe(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND pid <> pg_backend_pid()",
        [backend.pid, backend.backendStart],
      ).execute();
      const rows = await waitForStackOperation(count, {
        timeoutMs: queryTimeoutMs,
        label: `observe database backend ${backend.pid}`,
      });
      if (Number(rows[0]?.count ?? 0) === 0) return;
      await sleep(25);
    }
  } finally {
    await admin.end({ timeout: 0 });
  }
}

async function runDatabaseAdminQuery(statement, { signal, timeoutMs = DATABASE_OPERATION_TIMEOUT_MS, label }) {
  const admin = databaseAdminClient(timeoutMs);
  let reserved;
  let backend;
  let query;
  let querySettled = false;
  let result;
  let primaryError;
  try {
    reserved = await waitForStackOperation(admin.reserve(), {
      signal,
      timeoutMs,
      label: `${label} connection`,
    });
    const identity = reserved.unsafe(
      "SELECT pg_backend_pid()::int AS pid, backend_start::text AS backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()",
    ).execute();
    const identityRows = await waitForStackOperation(identity, {
      signal,
      timeoutMs,
      label: `${label} backend identity`,
    });
    const pid = Number(identityRows[0]?.pid);
    const backendStart = identityRows[0]?.backend_start;
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof backendStart !== "string") {
      throw new Error(`${label} could not identify its PostgreSQL backend`);
    }
    backend = { pid, backendStart };

    query = reserved.unsafe(statement).execute();
    const settledQuery = query.then(
      (value) => {
        querySettled = true;
        return value;
      },
      (error) => {
        querySettled = true;
        throw error;
      },
    );
    result = await waitForStackOperation(settledQuery, {
      signal,
      timeoutMs,
      label,
    });
  } catch (error) {
    primaryError = error;
  }

  try {
    // reserve 保证 PID 查询与目标语句在同一 backend；已终态时先归还，正常关闭连接，
    // 未终态时直接强拆，再由独立管理连接按 PID + backend_start 终止并观测消失。
    if (reserved && query && querySettled) reserved.release();
    await admin.end({ timeout: primaryError && (!query || !querySettled) ? 0 : 5 });
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError([primaryError, error], `${label} failed while closing its admin connection`)
      : error;
  }
  if (primaryError && query && backend) {
    try {
      await ensureDatabaseBackendGone(backend);
    } catch (error) {
      throw new DatabaseBackendUnconfirmedError(
        [primaryError, error],
        `${label} failed and PostgreSQL backend ${backend.pid} could not be confirmed terminated`,
      );
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

/** 建一个随机命名的临时库，返回 {name, url}（url 指向新库，供 spawn 的 server 用作 DATABASE_URL）。 */
export async function createTestDatabase({ signal, timeoutMs = DATABASE_OPERATION_TIMEOUT_MS } = {}) {
  const name = `coflux_test_${randomUUID().replace(/-/g, "")}`;
  let primaryError;
  try {
    await runDatabaseAdminQuery(`CREATE DATABASE ${name}`, {
      signal,
      timeoutMs,
      label: `create test database ${name}`,
    });
  } catch (error) {
    primaryError = error;
  }
  if (primaryError) {
    // 未确认 CREATE backend 消失时，DROP 可能先返回、CREATE 随后落库；此时必须保留明确失败，
    // 禁止执行会伪装成成功回滚的竞态操作。
    if (primaryError instanceof DatabaseBackendUnconfirmedError) throw primaryError;
    try {
      await dropTestDatabase(name);
    } catch (rollbackError) {
      throw new AggregateError([primaryError, rollbackError], `failed to create and roll back test database ${name}`);
    }
    throw primaryError;
  }

  try {
    const url = new URL(ADMIN_PG_URL);
    url.pathname = `/${name}`;
    return { name, url: url.toString() };
  } catch (error) {
    try {
      await dropTestDatabase(name);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `failed to prepare and roll back test database ${name}`);
    }
    throw error;
  }
}

/** 删临时库：DROP ... WITH (FORCE)（PG 13+）由服务端原子地踢连接并删库。
 * 不用 pg_terminate_backend + DROP 两步：terminate 发完信号即返回、不等 backend 真正退出，
 * 紧随的 DROP 仍可能撞上垂死连接报 "being accessed by other users"，造成非确定性泄漏。 */
export async function dropTestDatabase(name) {
  await runDatabaseAdminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, {
    label: `drop test database ${name}`,
  });
}

/** 清理路径共用：删库失败不让绿测试变红，但必须在 stderr 留痕（静默吞掉=泄漏不可见）。 */
async function dropTestDatabaseLoudly(name) {
  try {
    await dropTestDatabase(name);
  } catch (e) {
    console.error(`[harness] failed to drop test database ${name}: ${e?.message ?? e}`);
  }
}

/* ------------------------------------------------------------------ *
 * 信封 <-> 测试端消息的薄映射
 *
 * 发送：测试代码写 `{ case: "clientAuth", username, password }`（扁平，"case" 挑一个
 * oneof 分支，其余字段是该分支消息的 init）；这里拆成 `create(Schema, { payload: {case, value} })`
 * 再整包编码。字节字段（各消息里统一叫 `data` 的 pty/proxy payload）若传的是 string 自动
 * UTF-8 编码为 Uint8Array——纯粹是测试断言的人体工学，不影响线上真实字节。
 *
 * 接收：解码信封后把 `payload` 拍平成 `{ case, ...value }` 塞进 log/waitFor，`data` 字段
 * （若是 Uint8Array）配套解码回 string。既有测试的 `m.type === "..."` 判定改成 `m.case === "..."`
 * 后，字段访问（`m.task`、`m.workspace`、`m.data` 等）基本不用再改。
 * ------------------------------------------------------------------ */
const _te = new TextEncoder();
const _td = new TextDecoder();

function toWireValue(fields) {
  if (typeof fields.data === "string") return { ...fields, data: _te.encode(fields.data) };
  return fields;
}

/** 把 `msg.payload`（`{case, value}`，未命中任何 oneof 分支时 case 为 undefined）拍平为
 * `{case, ...value}`；未命中/解码失败返回 null，调用方按"丢弃"处理。 */
function flattenPayload(payload) {
  if (!payload || payload.case === undefined) return null;
  const { $typeName, ...rest } = payload.value;
  if (rest.data instanceof Uint8Array) rest.data = _td.decode(rest.data);
  return { case: payload.case, ...rest };
}

function toUint8(data) {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function spawnApp(rel, env) {
  const child = spawn(TSX, [join(ROOT, rel)], { env, stdio: DEBUG ? "inherit" : "ignore", detached: true });
  child.cofluxProcessGroupId = child.pid;
  return child;
}

// daemon = Rust supervisor + Rust worker（两个二进制，零 node 运行时）。
// 默认用 target/debug 下的产物（pretest 会 cargo build）；可用环境变量覆盖路径。
const SUPERVISOR_BIN = process.env.COFLUX_SUPERVISOR_BIN || join(ROOT, "target/debug/coflux-supervisor");
const WORKER_BIN = process.env.COFLUX_WORKER_BIN || join(ROOT, "target/debug/coflux-worker");
export function spawnDaemon(env) {
  const env2 = { ...env, COFLUX_WORKER_CMD: WORKER_BIN, COFLUX_WORKER_ARGS: "[]" };
  const child = spawn(SUPERVISOR_BIN, [], { env: env2, cwd: ROOT, stdio: DEBUG ? "inherit" : "ignore", detached: true });
  child.cofluxProcessGroupId = child.pid;
  return child;
}
// 独立 relay（plan 043）：每套 stack 生成一对临时 ed25519 密钥——seed(hex) 给 server 签
// rendezvous token，公钥(hex) 经 env 注入 relay 验签（同 COFLUX_WORKER_PUBKEY 的注入惯例）。
// relay 用随机端口并在 stdout 打就绪行，这里解析实际端口，遵守"各测试文件独占端口"纪律。
const RELAY_BIN = process.env.COFLUX_RELAY_BIN || join(ROOT, "target/debug/coflux-relay");

export function makeRelayKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seedHex = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("hex");
  const pubHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  return { seedHex, pubHex };
}

export async function spawnRelay(pubHex, ms = 8000, signal, onSpawn) {
  const child = spawn(RELAY_BIN, [], {
    env: { ...process.env, COFLUX_RELAY_LISTEN: "127.0.0.1:0", COFLUX_RELAY_PUBKEY: pubHex },
    stdio: ["ignore", "pipe", DEBUG ? "inherit" : "ignore"],
    detached: true,
  });
  child.cofluxProcessGroupId = child.pid;
  onSpawn?.(child);
  const port = await new Promise((resolvePort, rejectPort) => {
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) {
        killTree(child);
        rejectPort(error);
      } else {
        resolvePort(value);
      }
    };
    const aborted = () => finish(stackAbortError("relay spawn"));
    const timer = setTimeout(() => finish(new Error("relay did not report listening line")), ms);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/coflux-relay listening on [^\s:]*:(\d+)/);
      if (match) {
        if (DEBUG) process.stdout.write(buffer);
        finish(undefined, Number(match[1]));
      }
    });
    child.once("exit", () => {
      finish(new Error("relay exited before listening"));
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
  return { process: child, port };
}

function detachedProcessGroupId(child) {
  const groupId = child?.cofluxProcessGroupId ?? child?.pid;
  return Number.isSafeInteger(groupId) && groupId > 1 ? groupId : undefined;
}

function processGroupExists(groupId) {
  if (!groupId) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessTree(child, signal = "SIGKILL") {
  if (!child) return;
  const groupId = detachedProcessGroupId(child);
  if (groupId) {
    try {
      process.kill(-groupId, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
      let fallbackError;
      try {
        if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
          fallbackError = new Error(`child ${child.pid ?? "?"} rejected ${signal}`);
        }
      } catch (childError) {
        fallbackError = childError;
      }
      throw new AggregateError(
        fallbackError ? [error, fallbackError] : [error],
        `failed to signal detached process group ${groupId}`,
      );
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.kill(signal)) throw new Error(`child ${child.pid ?? "?"} rejected ${signal}`);
}

async function waitForProcessTreeExit(child, groupId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const alive = groupId
      ? processGroupExists(groupId)
      : child.exitCode === null && child.signalCode === null;
    if (!alive) return;
    if (Date.now() >= deadline) {
      throw new Error(groupId
        ? `detached process group ${groupId} survived SIGKILL`
        : `child ${child.pid ?? "?"} survived SIGKILL`);
    }
    await sleep(25);
  }
}

async function stopProcessTrees(children, { strict = false } = {}) {
  const trees = children
    .filter(Boolean)
    .map((child) => ({ child, groupId: detachedProcessGroupId(child) }));
  const errors = [];
  for (const tree of trees) {
    try {
      signalProcessTree(tree.child);
    } catch (error) {
      if (strict) errors.push(error);
    }
  }
  if (strict) {
    await Promise.all(trees.map(async (tree) => {
      try {
        await waitForProcessTreeExit(tree.child, tree.groupId);
      } catch (error) {
        errors.push(error);
      }
    }));
  } else {
    await sleep(200);
  }
  if (errors.length > 0) throw new AggregateError(errors, "test stack process cleanup failed");
}

export function killTree(child) {
  try {
    signalProcessTree(child);
  } catch {
    /* 普通测试沿用 best effort；严格 interop 入口由 stopProcessTrees 复核。 */
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
async function waitHealth(port, ms = 12000, signal) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    throwIfStackAborted(signal, "server health wait");
    if (await httpHealth(port)) return;
    await sleep(150);
  }
  throw new Error("server did not become healthy");
}

/** 造一个临时 git 仓库（一个空提交），返回路径。测试结束由 stack.stop 之外的 rmSync 清理。 */
export function mkRepo({ strictCleanup = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coflux-test-repo-"));
  try {
    // 显式 -b main：默认分支不依赖宿主/容器的 git 全局配置（否则旧 git 默认 master，断言会跨环境飘）
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `failed to initialize and clean temporary repo ${dir}`);
    }
    throw error;
  }
  return {
    dir,
    cleanup: () => {
      if (strictCleanup) rmSync(dir, { recursive: true, force: true });
      else try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * 只起 server（不起 Rust daemon），用于 password 模式等需要自定认证/装配的测试。
 * opts.env 追加/覆盖 server 环境变量（如 COFLUX_AUTH）；manageRelay=false 时调用方自行
 * 装配 relay 与签名配置（多节点测试用），stop() 不接管这些外部 relay。
 */
export async function startServer(opts = {}) {
  const port = opts.port;
  if (!port) throw new Error("startServer requires a port");
  const testDb = await createTestDatabase();
  // 测试栈总是配一个 relay 进程（随机端口 + 每栈临时密钥），rendezvous 才有落点；
  // 这只是测试装配——生产上 relay 独立部署（自有主机/域名），与中心零连接、只共享密钥对。
  // config 对 COFLUX_RELAY_SIGNING_KEY 也是 fail-closed。
  const manageRelay = opts.manageRelay !== false;
  const relayKeys = manageRelay ? makeRelayKeys() : null;
  const ref = {};
  let relayPort;
  let serverEnv;
  try {
    if (manageRelay) {
      const relay = await spawnRelay(relayKeys.pubHex);
      ref.relay = relay.process;
      relayPort = relay.port;
    }
    serverEnv = {
      ...process.env,
      COFLUX_PORT: String(port),
      DATABASE_URL: testDb.url,
      ...(manageRelay ? {
        COFLUX_RELAY_SIGNING_KEY: relayKeys.seedHex,
        COFLUX_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
      } : {}),
      ...(opts.env ?? {}),
    };
    ref.server = spawnApp("apps/server/src/index.ts", serverEnv);
    await waitHealth(port);
  } catch (e) {
    // 建库之后、句柄（含 stop()）交还调用方之前失败：就地清理，别泄漏测试库
    killTree(ref.server);
    killTree(ref.relay);
    await dropTestDatabaseLoudly(testDb.name);
    throw e;
  }
  return {
    port,
    /** 仅供需要用 PG 锁制造确定性并发窗口的黑盒测试；业务断言仍必须走公开 wire。 */
    databaseUrl: testDb.url,
    relayPort,
    makeClient: (options) => new Client(port, options),
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
      killTree(ref.relay);
      await sleep(150);
      await dropTestDatabaseLoudly(testDb.name);
    },
  };
}

/** 一个原始 /daemon 连接：直接发 daemon.enrollRequest/daemon.auth，不需要 Rust supervisor。
 * send(m) 里 m 形如 `{ case: "daemonEnrollRequest", name, host, platform }`（扁平）；
 * 收到的消息同样拍平为 `{ case, ...value }` 塞进 log/waitFor。 */
export function rawDaemon(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
  const log = [];
  let waiters = [];
  const closedInfo = new Promise((res) => {
    ws.addEventListener("close", (event) => res({ code: event.code, reason: event.reason }), { once: true });
  });
  ws.onmessage = (ev) => {
    let env;
    try { env = decodeServerToDaemon(toUint8(ev.data)); } catch { return; }
    const m = flattenPayload(env?.payload);
    if (!m) return;
    log.push(m);
    waiters = waiters.filter((w) => !w.try(m));
  };
  return {
    ready: new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws error: " + (e.message || "?"))); }),
    /** 服务端主动关连接时解析为 close code（如 4008 auth timeout）；不关则一直 pending，调用方自行 race 超时 */
    closed: closedInfo.then(({ code }) => code),
    /** 需要同时断言关闭码与 reason 的资源边界测试使用；closed 保留原数字语义兼容既有用例。 */
    closedInfo,
    log,
    send: (m) => {
      const { case: c, ...fields } = m;
      ws.send(encodeDaemonToServer(create(DaemonToServerSchema, { payload: { case: c, value: toWireValue(fields) } })));
    },
    waitFor: (pred, label = "?", t = 8000) => {
      const h = log.find(pred);
      if (h) return Promise.resolve(h);
      return new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error("timeout " + label)), t); waiters.push({ try: (m) => (pred(m) ? (clearTimeout(tm), res(m), true) : false) }); });
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

/** 从 daemon.authorizePending 的 url（`<webUrl>/authorize/<token>`）里取 token。 */
export function tokenFromUrl(url) {
  return url.split("/").filter(Boolean).pop();
}

/** 驱动一次浏览器授权确认：等 daemon 把待授权链接落到 `<home>/pending-auth.json`
 * （daemon 已发出 daemon.enrollRequest 是前提，spawnDaemon 之后调用即可），
 * 用一个测试 client 以 username/password 登录后确认 device.authorize。
 * startStack 用它替代已删除的 classic enrollKey 登记；也供需要手动起第二台 daemon 的测试复用。 */
export async function authorizeDaemon(
  port,
  home,
  { username = "admin", password = "admin", ms = 20000, signal } = {},
) {
  const pendingPath = join(home, "pending-auth.json");
  const t0 = Date.now();
  let pending;
  while (Date.now() - t0 < ms && !pending) {
    throwIfStackAborted(signal, "daemon authorization");
    if (existsSync(pendingPath)) {
      try {
        pending = JSON.parse(readFileSync(pendingPath, "utf8"));
      } catch {
        /* 文件可能正在被写，重试 */
      }
    }
    if (!pending) await sleep(200);
  }
  throwIfStackAborted(signal, "daemon authorization");
  if (!pending?.url) throw new Error("daemon did not write pending-auth.json in time");
  const c = new Client(port);
  try {
    await c.authSubscribe(username, password);
    throwIfStackAborted(signal, "daemon authorization");
    c.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
    await c.waitFor((m) => m.case === "deviceAuthorized", "device.authorized");
    throwIfStackAborted(signal, "daemon authorization");
  } finally {
    c.close();
  }
}

/** health 只证明端口上有 HTTP 服务；随机密码认证在 daemon 接入前证明它就是本次 spawn 的 server。
 * 这样即使动态端口在 bind 窗口被别的 coflux 测试抢占，也不会污染对方的 enrollment/presence。 */
async function verifyServerIdentity(port, username, password, signal) {
  throwIfStackAborted(signal, "server identity check");
  const client = new Client(port);
  try {
    await waitForStackOperation(client.ready, {
      signal,
      timeoutMs: 3000,
      label: "server identity websocket",
      cancel: () => client.close(),
    });
    throwIfStackAborted(signal, "server identity check");
    client.send({ case: "clientAuth", username, password });
    const result = await waitForStackOperation(
      client.waitFor(
        (message) => message.case === "authOk" || message.case === "authError",
        "server identity",
        3000,
      ),
      {
        signal,
        timeoutMs: 3000,
        label: "server identity auth",
        cancel: () => client.close(),
      },
    );
    if (result.case !== "authOk") throw new Error("loopback port belongs to another server");
    throwIfStackAborted(signal, "server identity check");
  } finally {
    client.close();
  }
}

/** 起一套独立栈，返回控制句柄。等到 daemon 在线后才返回。 */
export async function startStack(opts = {}) {
  const port = opts.port;
  if (!port) throw new Error("startStack requires a port");
  const username = opts.username ?? "admin";
  const password = opts.password ?? "admin";
  const signal = opts.signal;
  const strictCleanup = opts.strictCleanup === true;
  const ref = { server: null, daemon: null, relay: null };
  const retiredProcessTrees = new Set();
  let testDb;
  let home;
  let relayPort;
  let cleanupPromise;
  const onAbort = () => {
    // 先同步杀掉已取得句柄的 detached 进程；异步删库/删目录由同一个幂等 cleanup 收口。
    killTree(ref.daemon);
    killTree(ref.server);
    killTree(ref.relay);
    for (const child of retiredProcessTrees) killTree(child);
    if (testDb || home) void cleanupResources().catch(() => undefined);
  };
  const cleanupResources = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      signal?.removeEventListener("abort", onAbort);
      const processes = [...retiredProcessTrees, ref.daemon, ref.server, ref.relay];
      retiredProcessTrees.clear();
      ref.daemon = null;
      ref.server = null;
      ref.relay = null;
      const errors = [];
      try {
        await stopProcessTrees(processes, { strict: strictCleanup });
      } catch (error) {
        errors.push(error);
      }
      if (home && existsSync(home)) {
        try {
          rmSync(home, { recursive: true, force: true });
        } catch (error) {
          if (strictCleanup) errors.push(error);
        }
      }
      if (testDb) {
        try {
          if (strictCleanup) await dropTestDatabase(testDb.name);
          else await dropTestDatabaseLoudly(testDb.name);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "test stack cleanup failed");
    })();
    return cleanupPromise;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfStackAborted(signal);
    testDb = await createTestDatabase({ signal });
    throwIfStackAborted(signal);
    home = mkdtempSync(join(tmpdir(), "coflux-test-home-"));
    const relayKeys = makeRelayKeys();
    throwIfStackAborted(signal);
    // relay 先起（随机端口），server env 才能带上它的 URL。
    const relay = await spawnRelay(
      relayKeys.pubHex,
      8000,
      signal,
      (child) => { ref.relay = child; },
    );
    ref.relay = relay.process;
    relayPort = relay.port;
    throwIfStackAborted(signal);
    // opts.serverEnv：额外/覆盖 server 侧 env（如 proxy.test.mjs 显式钉死 COFLUX_PROXY_SCHEME，
    // 避免测试环境未设 COFLUX_DEV 时 isDev=false 导致 proxyScheme 默认落到 https，门禁/cookie 断言随之漂移）。
    const serverEnv = {
      ...process.env,
      COFLUX_PORT: String(port),
      DATABASE_URL: testDb.url,
      COFLUX_USERNAME: username,
      COFLUX_PASSWORD: password,
      COFLUX_RELAY_SIGNING_KEY: relayKeys.seedHex,
      COFLUX_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
      ...(opts.serverEnv ?? {}),
    };
    const daemonEnv = {
      ...process.env,
      COFLUX_SERVER: `ws://127.0.0.1:${port}/daemon`,
      COFLUX_HOME: home,
      COFLUX_DEVICE_NAME: opts.deviceName ?? "test-dev",
      // 黑盒栈绝不能占用真实 daemon 的生产端口；worker 会把实际随机端口上报给 control plane。
      COFLUX_LOCAL_GATEWAY_PORT: "0",
      ...(opts.daemonEnv ?? {}),
    };
    ref.serverEnv = serverEnv;
    ref.daemonEnv = daemonEnv;
    ref.server = spawnApp("apps/server/src/index.ts", serverEnv);
    await waitHealth(port, 12000, signal);
    await verifyServerIdentity(port, username, password, signal);
    throwIfStackAborted(signal);
    ref.daemon = spawnDaemon(daemonEnv);
    // 空 home，daemon 无 credentials.json → 走浏览器授权（唯一登记路径），这里现场自动确认。
    await authorizeDaemon(port, home, { username, password, signal });
    throwIfStackAborted(signal);
  } catch (e) {
    // 资源获取从建库开始就在同一个清理域；strict 模式下删库/删目录失败不能伪装成绿验收。
    try {
      await cleanupResources();
    } catch (cleanupError) {
      throw new AggregateError([e, cleanupError], "startStack failed and cleanup was incomplete");
    }
    throw e;
  }

  const stack = {
    port,
    username,
    password,
    home,
    relayPort,
    daemonId: null,
    makeClient: (options) => new Client(port, options),
    /** 真正停止中心进程，但保留 daemon、临时数据库与 loopback gateway。 */
    async stopServer() {
      const serverProcess = ref.server;
      if (!serverProcess) return;
      ref.server = null;
      retiredProcessTrees.add(serverProcess);
      await stopProcessTrees([serverProcess], { strict: strictCleanup });
    },
    async restartServer() {
      await stack.stopServer();
      throwIfStackAborted(signal, "server restart");
      // 复用同一个临时库（serverEnv 里的 DATABASE_URL 不变）：数据必须跨重启保留（reconnect.test.mjs 依赖此行为）。
      ref.server = spawnApp("apps/server/src/index.ts", ref.serverEnv);
      await waitHealth(port, 12000, signal);
    },
    /** 杀掉整个 daemon 进程树（supervisor+worker），模拟用户机器离线（offline-view.test.mjs） */
    async stopDaemon() {
      const daemonProcess = ref.daemon;
      if (!daemonProcess) return;
      ref.daemon = null;
      retiredProcessTrees.add(daemonProcess);
      await stopProcessTrees([daemonProcess], { strict: strictCleanup });
      if (!strictCleanup) await sleep(100);
    },
    /** 整树重启 supervisor + worker，并复用原 COFLUX_HOME/设备凭证。活 PTY 与未 ack tombstone
     * 都只在 supervisor 内存中；该入口用于验证它们同时丢失后的 catalog 自愈。 */
    async restartDaemon() {
      await stack.stopDaemon();
      throwIfStackAborted(signal, "daemon restart");
      ref.daemon = spawnDaemon(ref.daemonEnv);
    },
    /** 给 server 发 SIGTERM，等其优雅退出，返回退出码（或 'timeout'） */
    gracefulStopServer(ms = 3000) {
      return new Promise((res) => {
        const p = ref.server;
        if (!p) return res(null);
        retiredProcessTrees.add(p);
        const t = setTimeout(() => res("timeout"), ms);
        p.on("exit", (code) => {
          if (ref.server === p) ref.server = null;
          clearTimeout(t);
          res(code);
        });
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
    stop: cleanupResources,
    /** 轮询新鲜快照直到 daemon 在线（每轮全新 client，避免读到旧快照）。
     * 首次启动与 server 重启后 daemon 重连均适用：重连有 backoff，时长跨机器不定，
     * 裸 sleep 固定毫秒数在慢 CI 上会赌输（dec-modes-replay 曾因此 flaky）。 */
    async waitDaemonOnline(ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        throwIfStackAborted(signal, "daemon online wait");
        const p = stack.makeClient();
        try {
          const s = await p.authSubscribe(username, password);
          throwIfStackAborted(signal, "daemon online wait");
          const dev = s.daemons.find((d) => d.online && (!stack.daemonId || d.daemonId === stack.daemonId));
          if (dev) return dev;
        } catch {
          /* server 可能还没就绪 */
        } finally {
          p.close();
        }
        await sleep(250);
      }
      throw new Error("daemon did not come online");
    },
  };

  let dev;
  try {
    dev = await stack.waitDaemonOnline(15000);
  } catch (e) {
    await stack.stop();
    throw e;
  }
  stack.daemonId = dev.daemonId;
  return stack;
}

/** 一个测试用 WebSocket client，带消息日志与 waitFor。
 * send(m)：m 形如 `{ case: "clientAuth", username, password }`（扁平，"case" 选 oneof 分支）。
 * 收到的消息拍平为 `{ case, ...value }`（`waitFor` 按 `payload.case` 匹配）。 */
export class Client {
  // options.url 覆盖目标（生产冒烟走 wss://api.coflux.dev/client；黑盒仍是本地临时端口）。
  constructor(port, options = {}) {
    this.log = [];
    this.waiters = [];
    this.listeners = new Set();
    this.ws = new WebSocket(options.url ?? `ws://127.0.0.1:${port}/client`, { origin: options.origin });
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error("ws error: " + (e.message || "?")));
    });
    this.ws.onmessage = (ev) => {
      let env;
      try { env = decodeServerToClient(toUint8(ev.data)); } catch { return; }
      const m = flattenPayload(env?.payload);
      if (!m) return;
      this.log.push(m);
      this.waiters = this.waiters.filter((w) => !w.try(m));
      for (const listener of this.listeners) listener(m);
    };
  }
  send(m) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const { case: c, ...fields } = m;
    this.ws.send(encodeClientToServer(create(ClientToServerSchema, { payload: { case: c, value: toWireValue(fields) } })));
  }
  waitFor(pred, label = "?", timeout = 10000) {
    const hit = this.log.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for " + label)), timeout);
      this.waiters.push({ try: (m) => (pred(m) ? (clearTimeout(t), res(m), true) : false) });
    });
  }
  /** clientVersion 缺省不带（黑盒测试依赖"无版本=跳过准入"语义）；生产冒烟传 "dev" 显式放行。 */
  async authSubscribe(username = "admin", password = "admin", clientVersion) {
    await this.ready;
    this.send(clientVersion ? { case: "clientAuth", username, password, clientVersion } : { case: "clientAuth", username, password });
    await this.waitFor((m) => m.case === "authOk", "auth.ok");
    this.send({ case: "clientSubscribe" });
    return this.waitFor((m) => m.case === "stateSnapshot", "snapshot");
  }
  /** 会话 token 认证（生产冒烟用）。clientVersion=dev 是版本准入的显式放行值，见 plan 033。 */
  async authTokenSubscribe(clientToken, clientVersion = "dev") {
    await this.ready;
    this.send({ case: "clientAuth", clientToken, clientVersion });
    await this.waitFor((m) => m.case === "authOk", "auth.ok");
    this.send({ case: "clientSubscribe" });
    return this.waitFor((m) => m.case === "stateSnapshot", "snapshot");
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    this.listeners.clear();
    try { this.ws.close(); } catch {}
  }
}
