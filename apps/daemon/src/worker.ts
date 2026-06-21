/**
 * worker —— 承载除 PTY 外的全部逻辑：连服务器(WS) + 认证 + git + exec + fs + 编排。
 *
 * PTY 操作经 UDS 转给 supervisor（见 index.ts / ipc.ts）。本进程是「频繁升级」的那个 ——
 * 升级 = supervisor 重启它；重启后两级 resync：① 重连 supervisor 拿回存活会话；② 重连 server resync。
 * 纯 JS：不 import node-pty（那留在 supervisor），git 走 spawn、fs 走 node:fs。
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { createLogger } from "@coflux/core";
import { decode, encode, type DaemonToServer, type ServerToDaemon, type SessionId, type TaskId } from "@coflux/protocol";
import { config } from "./config.js";
import { CredentialStore } from "./creds.js";
import { GitService } from "./git.js";
import { runCommand } from "./exec.js";
import { listDir, readFileText } from "./fs.js";
import {
  writeRecord,
  writeJson,
  RecordParser,
  isFrame,
  SUPERVISOR_SOCK_ENV,
  type WorkerToSupervisor,
  type SupervisorToWorker,
} from "./ipc.js";

const log = createLogger("worker");

const creds = new CredentialStore(config.credPath, config.home);
const git = new GitService(config.worktreesDir, log);

let socket: WebSocket | null = null; // → server
let sup: net.Socket | null = null; // → supervisor
let authed = false;
let reconnectAttempts = 0;
let shuttingDown = false;
let credentials = creds.load();

/** worker 对存活会话的视图（由 supervisor 事件维护），用于向 server resync */
const alive = new Map<SessionId, TaskId>();
/** 是否已拿到 supervisor 的存活快照（resync.list）——两级 resync 必须先有它再向 server resync */
let supSynced = false;

/* ----------------------------- 发送工具 ----------------------------- */
function sendServer(m: DaemonToServer): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(encode(m));
}
function sendSup(m: WorkerToSupervisor): void {
  if (sup && !sup.destroyed) writeJson(sup, m);
}

/* ----------------------- supervisor 连接（UDS） ----------------------- */
function connectSupervisor(): void {
  const sockPath = process.env[SUPERVISOR_SOCK_ENV];
  if (!sockPath) {
    log.error("missing supervisor socket path; exiting");
    process.exit(1);
  }
  const s = net.connect(sockPath);
  sup = s;
  const parser = new RecordParser((payload) => {
    if (isFrame(payload)) {
      // supervisor 下行数据帧（pty.output / pty.replay）→ 原样转发给 server
      // 复制一份：worker 作为 WS 客户端发送时会对 payload 做掩码（可能就地改写），不能动共享的解析缓冲
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(Buffer.from(payload));
      return;
    }
    let m: SupervisorToWorker | null = null;
    try {
      m = JSON.parse(payload.toString("utf8")) as SupervisorToWorker;
    } catch {
      return;
    }
    handleSupMsg(m);
  });
  s.on("connect", () => {
    log.info("connected to supervisor");
    sendSup({ type: "resync.request" });
  });
  s.on("data", (c) => parser.push(c));
  s.on("close", () => {
    if (sup === s) sup = null;
    supSynced = false; // 重连 supervisor 后会重新拿快照
    if (shuttingDown) return;
    setTimeout(connectSupervisor, 200);
  });
  s.on("error", (err) => log.warn("supervisor sock error", { err: (err as Error).message }));
}

function handleSupMsg(m: SupervisorToWorker): void {
  switch (m.type) {
    case "session.started":
      alive.set(m.sessionId, m.taskId);
      sendServer({ type: "session.started", sessionId: m.sessionId, taskId: m.taskId, pid: m.pid });
      return;
    case "session.exit":
      alive.delete(m.sessionId);
      sendServer({ type: "session.exit", sessionId: m.sessionId, exitCode: m.exitCode });
      return;
    case "resync.list":
      alive.clear();
      for (const x of m.sessions) alive.set(x.sessionId, x.taskId);
      supSynced = true;
      log.info("supervisor resync", { count: alive.size });
      // 已认证则（补）发 server resync —— 这也是先 server 后 supervisor 次序下的唯一一次 resync
      if (authed) sendServer({ type: "daemon.resync", sessions: aliveList() });
      return;
  }
}

function aliveList(): { sessionId: SessionId; taskId: TaskId }[] {
  return [...alive.entries()].map(([sessionId, taskId]) => ({ sessionId, taskId }));
}

/* ------------------------- server 连接（WS） ------------------------- */
function onAuthed(): void {
  authed = true;
  reconnectAttempts = 0;
  // 两级 resync 必须有序：先拿到 supervisor 存活快照再向 server resync。
  // 否则空列表 resync 会让 server 误标任务 exited，随后真 resync 反而触发 session.close 杀掉 PTY。
  // 若 supervisor 快照尚未到，这里跳过，由 resync.list 到达时补发。
  if (supSynced) {
    sendServer({ type: "daemon.resync", sessions: aliveList() });
    if (alive.size) log.info("resynced sessions to server", { count: alive.size });
  }
}

async function route(msg: ServerToDaemon): Promise<void> {
  switch (msg.type) {
    case "daemon.enrolled": {
      credentials = { serverUrl: config.serverUrl, daemonId: msg.daemonId, deviceToken: msg.deviceToken };
      creds.save(credentials);
      log.info("enrolled", { daemonId: msg.daemonId });
      onAuthed();
      return;
    }
    case "daemon.authed": {
      log.info("authenticated", { daemonId: msg.daemonId });
      onAuthed();
      return;
    }
    case "daemon.authError": {
      log.error("auth error", { message: msg.message });
      if (msg.needEnroll) {
        creds.clear();
        credentials = null;
      } else {
        log.error("enrollment key invalid; stop retrying");
        process.exitCode = 1;
      }
      return;
    }
    default:
      if (!authed) return; // 认证前忽略业务消息
      await routeAuthed(msg);
  }
}

async function routeAuthed(msg: ServerToDaemon): Promise<void> {
  switch (msg.type) {
    case "project.validate": {
      const r = await git.validateRepo(msg.path);
      sendServer({ type: "project.validated", requestId: msg.requestId, ok: r.ok, repoPath: r.repoPath, branch: r.branch, error: r.error });
      return;
    }
    case "worktree.add": {
      const r = await git.addWorktree(msg.repoPath, msg.workspaceId, msg.name, msg.branch, msg.createNew);
      sendServer({ type: "worktree.added", requestId: msg.requestId, ok: r.ok, path: r.path, branch: r.branch, error: r.error });
      return;
    }
    case "worktree.remove":
      await git.removeWorktree(msg.repoPath, msg.worktreePath);
      return;
    case "worker.upgrade":
      // 转给 supervisor 切版本（会重启本进程）
      sendSup({ type: "worker.upgrade", version: msg.version });
      return;
    // PTY 相关 → 转给 supervisor
    case "session.create":
      sendSup({ type: "session.create", sessionId: msg.sessionId, taskId: msg.taskId, cwd: msg.cwd, shell: msg.shell, cols: msg.cols, rows: msg.rows });
      return;
    case "session.replay":
      sendSup({ type: "session.replay", sessionId: msg.sessionId, requestId: msg.requestId });
      return;
    case "pty.resize":
      sendSup({ type: "pty.resize", sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows });
      return;
    case "session.close":
      sendSup({ type: "session.close", sessionId: msg.sessionId });
      return;
    case "exec.run": {
      const r = await runCommand(msg.cwd, msg.command, msg.args, msg.env, msg.timeoutMs);
      sendServer({ type: "exec.result", requestId: msg.requestId, ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, error: r.error });
      return;
    }
    case "fs.list": {
      const r = await listDir(msg.root, msg.path);
      sendServer({ type: "fs.listed", requestId: msg.requestId, ok: r.ok, entries: r.entries, error: r.error });
      return;
    }
    case "fs.read": {
      const r = await readFileText(msg.root, msg.path);
      sendServer({ type: "fs.read.result", requestId: msg.requestId, ok: r.ok, content: r.content, error: r.error });
      return;
    }
    default:
      log.warn("unknown message type", { type: (msg as { type?: string }).type });
  }
}

function connect(): void {
  authed = false;
  const ws = new WebSocket(config.serverUrl);
  socket = ws;
  let isAlive = true;
  let hb: ReturnType<typeof setInterval> | null = null;
  let authDeadline: ReturnType<typeof setTimeout> | null = null;

  ws.on("open", () => {
    if (credentials?.deviceToken) {
      log.info("connecting (auth)", { server: config.serverUrl, daemonId: credentials.daemonId });
      sendServer({ type: "daemon.auth", deviceToken: credentials.deviceToken });
    } else {
      log.info("connecting (enroll)", { server: config.serverUrl, name: config.deviceName });
      sendServer({ type: "daemon.enroll", enrollmentKey: config.enrollKey, name: config.deviceName, host: os.hostname(), platform: process.platform });
    }
    authDeadline = setTimeout(() => {
      if (!authed) {
        log.warn("auth timeout, terminating");
        ws.terminate();
      }
    }, config.authDeadlineMs);
    hb = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, config.heartbeatMs);
    hb.unref();
  });

  ws.on("pong", () => {
    isAlive = true;
  });
  ws.on("message", (raw, isBinary) => {
    // 数据面：二进制帧（仅 pty.input 下行）→ 原样转给 supervisor
    if (isBinary) {
      if (authed && sup && !sup.destroyed) writeRecord(sup, raw as Buffer);
      return;
    }
    let msg: ServerToDaemon;
    try {
      msg = decode<ServerToDaemon>(raw as Buffer);
    } catch {
      return;
    }
    route(msg).catch((err) => log.error("route error", { err: (err as Error).message }));
  });
  ws.on("close", () => {
    socket = null;
    authed = false;
    if (hb) clearInterval(hb);
    if (authDeadline) clearTimeout(authDeadline);
    if (shuttingDown || process.exitCode === 1) return;
    const base = Math.min(config.reconnectCapMs, config.reconnectBaseMs * 2 ** reconnectAttempts);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5)); // 指数退避 + 全抖动
    reconnectAttempts++;
    log.info("disconnected, reconnecting", { delayMs: delay });
    setTimeout(connect, delay);
  });
  ws.on("error", (err) => log.warn("ws error", { err: (err as Error).message }));
}

/* --------------------------- 背压（2 段中的上段） --------------------------- */
// 真正的拥塞点在 worker→server 这段 WS：缓冲过高就让 supervisor 暂停 PTY，降下来再恢复。
let ptyPaused = false;
const backpressure = setInterval(() => {
  const buffered = socket?.bufferedAmount ?? 0;
  if (!ptyPaused && buffered > config.ptyPauseHigh) {
    sendSup({ type: "pty.pause" });
    ptyPaused = true;
  } else if (ptyPaused && buffered < config.ptyResumeLow) {
    sendSup({ type: "pty.resume" });
    ptyPaused = false;
  }
}, 100);
backpressure.unref();

/* ------------------------------ 信号/收尾 ------------------------------ */
function shutdownWorker(reason: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { reason });
  try {
    socket?.close(1001, "worker shutting down");
  } catch {
    /* ignore */
  }
  try {
    sup?.destroy();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 200).unref();
}
process.on("SIGTERM", () => shutdownWorker("SIGTERM"));
process.on("SIGINT", () => shutdownWorker("SIGINT"));
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: err instanceof Error ? err.stack : String(err) });
  shutdownWorker("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", { err: String(err) });
});

// 写 pid 文件，便于测试/运维定位 worker 进程（如杀掉以验证 PTY 跨 worker 重启存活）
try {
  fs.writeFileSync(path.join(config.home, "worker.pid"), String(process.pid));
} catch {
  /* ignore */
}

connectSupervisor();
connect();
