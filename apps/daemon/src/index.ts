/**
 * coflux daemon 装配入口 + 连接生命周期。
 *
 * 跑在用户开发机上，主动外连中心服务器。领域逻辑分布在：
 *   creds.ts     设备凭证持久化
 *   git.ts       仓库校验 / worktree 增删
 *   sessions.ts  PTY 会话生命周期 + scrollback + 背压
 * 本文件只负责：装配 + WS 连接（认证/心跳/认证截止/指数退避重连）+ 消息路由 + 信号。
 */
import { WebSocket } from "ws";
import { createLogger } from "@coflux/core";
import os from "node:os";
import { decode, encode, decodeFrame, type DaemonToServer, type ServerToDaemon } from "@coflux/protocol";
import { config } from "./config.js";
import { CredentialStore } from "./creds.js";
import { GitService } from "./git.js";
import { SessionManager, type Sender } from "./sessions.js";
import { runCommand } from "./exec.js";
import { listDir, readFileText } from "./fs.js";

const log = createLogger("daemon");

const creds = new CredentialStore(config.credPath, config.home);
const git = new GitService(config.worktreesDir, log);

let socket: WebSocket | null = null;
let authed = false;
let reconnectAttempts = 0;
let shuttingDown = false;
let credentials = creds.load();

const sender: Sender = {
  send: (m: DaemonToServer) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(encode(m));
  },
  sendFrame: (frame: Uint8Array) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(frame);
  },
  bufferedAmount: () => socket?.bufferedAmount ?? 0,
  isOpen: () => !!socket && socket.readyState === WebSocket.OPEN,
};

const sessions = new SessionManager(
  sender,
  {
    defaultShell: config.shell,
    scrollbackLimit: config.scrollbackLimit,
    pauseHigh: config.ptyPauseHigh,
    resumeLow: config.ptyResumeLow,
    maxSessions: config.maxSessions,
  },
  log,
);

function onAuthed(): void {
  authed = true;
  reconnectAttempts = 0;
  const alive = sessions.resyncList();
  sender.send({ type: "daemon.resync", sessions: alive });
  if (alive.length) log.info("resynced sessions", { count: alive.length });
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
      sender.send({ type: "project.validated", requestId: msg.requestId, ok: r.ok, repoPath: r.repoPath, branch: r.branch, error: r.error });
      return;
    }
    case "worktree.add": {
      const r = await git.addWorktree(msg.repoPath, msg.workspaceId, msg.name, msg.branch, msg.createNew);
      sender.send({ type: "worktree.added", requestId: msg.requestId, ok: r.ok, path: r.path, branch: r.branch, error: r.error });
      return;
    }
    case "worktree.remove":
      await git.removeWorktree(msg.repoPath, msg.worktreePath);
      return;
    case "session.create":
      sessions.create(msg.sessionId, msg.taskId, msg.cwd, msg.shell ?? config.shell, msg.cols, msg.rows);
      return;
    case "session.replay":
      sessions.replay(msg.sessionId, msg.requestId);
      return;
    // pty.input 走二进制数据面（见 ws "message" 的 isBinary 分支）
    case "pty.resize":
      sessions.resize(msg.sessionId, msg.cols, msg.rows);
      return;
    case "session.close":
      sessions.close(msg.sessionId);
      return;
    case "exec.run": {
      const r = await runCommand(msg.cwd, msg.command, msg.args, msg.env, msg.timeoutMs);
      sender.send({ type: "exec.result", requestId: msg.requestId, ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, error: r.error });
      return;
    }
    case "fs.list": {
      const r = await listDir(msg.root, msg.path);
      sender.send({ type: "fs.listed", requestId: msg.requestId, ok: r.ok, entries: r.entries, error: r.error });
      return;
    }
    case "fs.read": {
      const r = await readFileText(msg.root, msg.path);
      sender.send({ type: "fs.read.result", requestId: msg.requestId, ok: r.ok, content: r.content, error: r.error });
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
      sender.send({ type: "daemon.auth", deviceToken: credentials.deviceToken });
    } else {
      log.info("connecting (enroll)", { server: config.serverUrl, name: config.deviceName });
      sender.send({ type: "daemon.enroll", enrollmentKey: config.enrollKey, name: config.deviceName, host: os.hostname(), platform: process.platform });
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
    // 数据面：二进制帧（目前仅 pty.input 下行到 daemon）
    if (isBinary) {
      if (!authed) return;
      const frame = decodeFrame(raw as Buffer);
      if (frame && frame.type === "pty.input") sessions.input(frame.sessionId, frame.data);
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

function shutdownDaemon(reason: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { reason });
  sessions.shutdown();
  try {
    socket?.close(1001, "daemon shutting down");
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 200).unref();
}
process.on("SIGTERM", () => shutdownDaemon("SIGTERM"));
process.on("SIGINT", () => shutdownDaemon("SIGINT"));
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: err instanceof Error ? err.stack : String(err) });
  shutdownDaemon("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", { err: String(err) });
});

connect();
