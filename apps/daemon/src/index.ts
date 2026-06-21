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
let workerChild: ChildProcess | null = null;
let workerRestarts = 0;
let workerStartedAt = 0;

function startWorker(): void {
  if (shuttingDown) return;
  workerStartedAt = Date.now();
  // TS-first：用 node --import tsx 跑 worker.ts（编译后改为直接跑 .js）
  workerChild = spawn(process.execPath, ["--import", "tsx", WORKER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, [SUPERVISOR_SOCK_ENV]: sockPath },
    stdio: "inherit",
  });
  workerChild.on("exit", (code, signal) => {
    workerChild = null;
    if (shuttingDown) return;
    // 运行够久（>10s）视为健康，重置崩溃计数
    if (Date.now() - workerStartedAt > 10_000) workerRestarts = 0;
    workerRestarts++;
    const delay = Math.min(5_000, 200 * workerRestarts); // 崩溃循环保护（验签/回滚的占位，详见 hot-upgrade-design.md）
    log.warn("worker exited, restarting", { code, signal, delayMs: delay, restarts: workerRestarts });
    setTimeout(startWorker, delay).unref();
  });
}

server.listen(sockPath, () => {
  log.info("supervisor listening", { sock: sockPath });
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
