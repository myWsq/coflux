/**
 * supervisor —— daemon 的长生进程（热升级时不动）。
 *
 * 职责：持有 PTY（经 SessionManager，唯一用到原生依赖 node-pty 的进程）；监听 UDS；
 * 起/管/重启 worker 子进程；worker 断开/重启都不影响 PTY，worker 重连后用 resync 重挂
 * 存活会话（两级 resync 的下层）。
 *
 * worker（连服务器/认证/git/exec/fs/编排）是另一个进程，见 worker.ts —— 频繁升级 = 只重启它。
 * TS-first 阶段 supervisor 与 worker 都是 TS；后续把本进程移植到 Rust 静态二进制（见 hot-upgrade-design.md）。
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "@coflux/core";
import { config } from "./config.js";
import { SessionManager, type Sender } from "./sessions.js";
import {
  writeRecord,
  writeJson,
  RecordParser,
  isFrame,
  parseFrame,
  parseJson,
  SUPERVISOR_SOCK_ENV,
  type WorkerToSupervisor,
  type SupervisorToWorker,
} from "./ipc.js";

const log = createLogger("supervisor");

let worker: net.Socket | null = null; // 当前连接的 worker（只接受一个）
let shuttingDown = false;

const sender: Sender = {
  send: (m: SupervisorToWorker) => {
    if (worker && !worker.destroyed) writeJson(worker, m);
  },
  sendFrame: (frame: Uint8Array) => {
    if (worker && !worker.destroyed) writeRecord(worker, frame);
  },
};

const sessions = new SessionManager(
  sender,
  { defaultShell: config.shell, scrollbackLimit: config.scrollbackLimit, maxSessions: config.maxSessions },
  log,
);

function handleWorkerMsg(m: WorkerToSupervisor): void {
  switch (m.type) {
    case "session.create":
      sessions.create(m.sessionId, m.taskId, m.cwd, m.shell ?? config.shell, m.cols, m.rows);
      return;
    case "session.close":
      sessions.close(m.sessionId);
      return;
    case "session.replay":
      sessions.replay(m.sessionId, m.requestId);
      return;
    case "pty.resize":
      sessions.resize(m.sessionId, m.cols, m.rows);
      return;
    case "resync.request":
      sender.send({ type: "resync.list", sessions: sessions.resyncList() });
      return;
    case "pty.pause":
      sessions.pauseAll();
      return;
    case "pty.resume":
      sessions.resumeAll();
      return;
    case "worker.upgrade":
      switchWorker(m.version);
      return;
  }
}

/* ----------------------------- UDS server ----------------------------- */

const sockPath = process.env[SUPERVISOR_SOCK_ENV] || path.join(os.tmpdir(), `coflux-sup-${process.pid}.sock`);
try {
  fs.unlinkSync(sockPath);
} catch {
  /* 不存在则忽略 */
}

const server = net.createServer((sock) => {
  log.info("worker connected");
  if (worker && !worker.destroyed) {
    try {
      worker.destroy();
    } catch {
      /* ignore */
    }
  }
  worker = sock;
  const parser = new RecordParser((payload) => {
    if (isFrame(payload)) {
      // 唯一上行数据帧是 pty.input
      const f = parseFrame(payload);
      if (f && f.type === "pty.input") sessions.input(f.sessionId, f.data);
      return;
    }
    const m = parseJson<WorkerToSupervisor>(payload);
    if (m) handleWorkerMsg(m);
  });
  sock.on("data", (c) => parser.push(c));
  sock.on("close", () => {
    if (worker === sock) worker = null;
    log.info("worker disconnected");
  });
  sock.on("error", (err) => log.warn("worker sock error", { err: (err as Error).message }));
});

/* --------------------------- worker 子进程管理 --------------------------- */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url)); // apps/daemon/src → 仓库根（用于解析 tsx）
const WORKER_ENTRY = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** 一个 worker 版本规格 = 怎么把它跑起来（TS-first: node --import tsx <entry>；打包后: 二进制路径） */
interface WorkerSpec {
  version: string;
  cmd: string;
  args: string[];
}

/** 内置版本：当前仓库里的 worker */
const BUILTIN: WorkerSpec = { version: "builtin", cmd: process.execPath, args: ["--import", "tsx", WORKER_ENTRY] };

/**
 * 已知 worker 版本注册表。将来由"下载 + 验签"步骤填充（验签是硬前置，见 hot-upgrade-design.md）；
 * 现在 = 内置 + 可经 COFLUX_WORKER_SPECS（JSON: { version: {cmd,args} }）注入，供测试/运维预注册。
 * 升级只按"版本标签"在此表里解析，绝不执行外部传入的任意路径。
 */
const known = new Map<string, WorkerSpec>([[BUILTIN.version, BUILTIN]]);
try {
  const raw = process.env.COFLUX_WORKER_SPECS;
  if (raw) {
    const obj = JSON.parse(raw) as Record<string, { cmd: string; args: string[] }>;
    for (const [version, s] of Object.entries(obj)) {
      if (s && typeof s.cmd === "string" && Array.isArray(s.args)) known.set(version, { version, cmd: s.cmd, args: s.args });
    }
  }
} catch (err) {
  log.warn("bad COFLUX_WORKER_SPECS", { err: (err as Error).message });
}

const PROBATION_MS = Number(process.env.COFLUX_WORKER_PROBATION_MS) || 8_000; // 新版本须稳定运行这么久才提交
const MAX_PENDING_CRASHES = 2; // 观察期内崩溃达此次数 → 回滚

let active: WorkerSpec = BUILTIN; // 当前认定为好的版本
let pending: WorkerSpec | null = null; // 观察期试用的新版本
let workerChild: ChildProcess | null = null;
let runningVersion = active.version; // 当前 workerChild 跑的是哪个版本
let workerRestarts = 0;
let workerStartedAt = 0;
let pendingCrashes = 0;
let probationTimer: ReturnType<typeof setTimeout> | null = null;

function currentSpec(): WorkerSpec {
  return pending ?? active;
}

function writeActiveVersion(): void {
  try {
    fs.writeFileSync(path.join(config.home, "worker.active"), active.version);
  } catch {
    /* ignore */
  }
}

function startWorker(): void {
  if (shuttingDown) return;
  const spec = currentSpec();
  runningVersion = spec.version;
  workerStartedAt = Date.now();
  // TS-first：spec 为 node --import tsx <entry>；编译后是二进制路径
  workerChild = spawn(spec.cmd, spec.args, {
    cwd: ROOT,
    env: { ...process.env, [SUPERVISOR_SOCK_ENV]: sockPath },
    stdio: "inherit",
  });
  workerChild.on("error", (err) => log.error("worker spawn error", { err: (err as Error).message, version: spec.version }));
  workerChild.on("exit", (code, signal) => {
    const exitedVersion = runningVersion;
    workerChild = null;
    if (shuttingDown) return;
    let delay = 200;
    if (pending && exitedVersion === pending.version) {
      // 观察期内的新版本崩了 → 计数，超阈值则回滚到 active
      pendingCrashes++;
      log.warn("pending worker exited", { version: pending.version, code, signal, crashes: pendingCrashes });
      if (pendingCrashes >= MAX_PENDING_CRASHES) {
        log.error("new worker crash-looping, rolling back", { from: pending.version, to: active.version });
        if (probationTimer) {
          clearTimeout(probationTimer);
          probationTimer = null;
        }
        pending = null;
        pendingCrashes = 0;
      }
      delay = 300;
    } else if (pending) {
      // 旧版本因 switch 被有意杀掉 → 下次 startWorker 用 currentSpec()=pending 拉起新版
      delay = 200;
    } else {
      // 稳定版本崩了：指数退避（运行够久则重置）
      if (Date.now() - workerStartedAt > 10_000) workerRestarts = 0;
      workerRestarts++;
      delay = Math.min(5_000, 200 * workerRestarts);
      log.warn("worker exited, restarting", { version: active.version, code, signal, delayMs: delay, restarts: workerRestarts });
    }
    setTimeout(startWorker, delay).unref();
  });

  // 新版本的观察期：稳定运行 PROBATION_MS 则提交为 active
  if (pending && spec.version === pending.version) {
    if (probationTimer) clearTimeout(probationTimer);
    probationTimer = setTimeout(() => {
      if (!pending) return;
      log.info("worker upgrade committed", { version: pending.version });
      active = pending;
      pending = null;
      pendingCrashes = 0;
      workerRestarts = 0;
      probationTimer = null;
      writeActiveVersion();
    }, PROBATION_MS);
    probationTimer.unref();
  }
}

/** 热升级：切到某个已知版本（重启 worker；观察期不过则自动回滚） */
function switchWorker(version: string): void {
  const spec = known.get(version);
  if (!spec) {
    log.warn("unknown worker version, ignoring upgrade", { version, known: [...known.keys()] });
    return;
  }
  if (spec.version === active.version && !pending) {
    log.info("already on requested version", { version });
    return;
  }
  log.info("upgrading worker", { from: active.version, to: version });
  pending = spec;
  pendingCrashes = 0;
  // 杀掉当前 worker → exit handler 会用 currentSpec()（=pending）拉起新版
  try {
    workerChild?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

server.listen(sockPath, () => {
  log.info("supervisor listening", { sock: sockPath });
  writeActiveVersion();
  startWorker();
});
server.on("error", (err) => {
  log.error("uds server error", { err: (err as Error).message });
  process.exitCode = 1;
});

/* ------------------------------ 信号/收尾 ------------------------------ */

function shutdown(reason: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { reason });
  try {
    workerChild?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  sessions.shutdown();
  try {
    server.close();
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 200).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: err instanceof Error ? err.stack : String(err) });
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", { err: String(err) });
});
