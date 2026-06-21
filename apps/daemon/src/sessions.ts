/**
 * SessionManager —— PTY 会话的生命周期管理（活在 supervisor 进程）。
 *
 * 持有 PTY、scrollback 环形缓冲。输出/事件经注入的 Sender 发给 worker（UDS）。
 * 背压由 worker 根据其 server WS 缓冲水位驱动（pauseAll/resumeAll）—— 真正的拥塞点在
 * worker→server 那段，本进程的 UDS 是本地快通道，故这里不自行轮询缓冲。
 * 会话表常驻 supervisor，跨 worker 重连/升级存活 —— 两级 resync 的根基。
 */
import os from "node:os";
import { spawn, type IPty } from "node-pty";
import type { Logger } from "@coflux/core";
import { encodeFrame, type SessionId, type TaskId } from "@coflux/protocol";
import type { SupervisorToWorker } from "./ipc.js";

export interface Sender {
  /** 控制事件（session.started / session.exit / resync.list） */
  send(msg: SupervisorToWorker): void;
  /** pty 数据帧（pty.output / pty.replay） */
  sendFrame(frame: Uint8Array): void;
}

export interface SessionOptions {
  defaultShell: string;
  scrollbackLimit: number;
  maxSessions: number;
}

interface Live {
  pty: IPty;
  taskId: TaskId;
  scrollback: string;
  paused: boolean;
}

export class SessionManager {
  private sessions = new Map<SessionId, Live>();

  constructor(private sender: Sender, private opts: SessionOptions, private log: Logger) {}

  create(sessionId: SessionId, taskId: TaskId, cwd: string, shell: string, cols: number, rows: number): void {
    if (this.sessions.size >= this.opts.maxSessions) {
      this.log.warn("session cap reached", { max: this.opts.maxSessions });
      this.sender.send({ type: "session.exit", sessionId, exitCode: -1 });
      return;
    }
    let pty: IPty;
    try {
      pty = spawn(shell || this.opts.defaultShell, [], {
        name: "xterm-256color",
        cwd: cwd && cwd.length > 0 ? cwd : os.homedir(),
        cols: cols || 80,
        rows: rows || 24,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      this.log.error("spawn failed", { err: String(err) });
      this.sender.send({ type: "session.exit", sessionId, exitCode: -1 });
      return;
    }
    const s: Live = { pty, taskId, scrollback: "", paused: false };
    this.sessions.set(sessionId, s);
    this.log.info("session started", { sessionId, taskId, pid: pty.pid });
    this.sender.send({ type: "session.started", sessionId, taskId, pid: pty.pid });

    pty.onData((data) => {
      s.scrollback += data;
      if (s.scrollback.length > this.opts.scrollbackLimit) s.scrollback = s.scrollback.slice(-this.opts.scrollbackLimit);
      this.sender.sendFrame(encodeFrame({ type: "pty.output", sessionId, data }));
    });
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);
      this.log.info("session exited", { sessionId, exitCode });
      this.sender.send({ type: "session.exit", sessionId, exitCode });
    });
  }

  input(sessionId: SessionId, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data);
  }
  resize(sessionId: SessionId, cols: number, rows: number): void {
    try {
      this.sessions.get(sessionId)?.pty.resize(cols || 80, rows || 24);
    } catch {
      /* resize 偶发越界，忽略 */
    }
  }
  close(sessionId: SessionId): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.pty.kill();
    } catch {
      /* ignore */
    }
    this.sessions.delete(sessionId);
  }
  replay(sessionId: SessionId, requestId: string): void {
    const s = this.sessions.get(sessionId);
    this.sender.sendFrame(encodeFrame({ type: "pty.replay", sessionId, requestId, data: s?.scrollback ?? "" }));
  }

  /** worker 重连后上报仍存活的会话以便重挂（两级 resync 的下层） */
  resyncList(): { sessionId: SessionId; taskId: TaskId }[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({ sessionId, taskId: s.taskId }));
  }

  /** 背压：暂停全部 PTY（由 worker 在 server WS 缓冲过高时驱动） */
  pauseAll(): void {
    for (const s of this.sessions.values()) {
      if (s.paused) continue;
      try {
        s.pty.pause();
      } catch {
        /* ignore */
      }
      s.paused = true;
    }
  }
  /** 背压：恢复全部 PTY */
  resumeAll(): void {
    for (const s of this.sessions.values()) {
      if (!s.paused) continue;
      try {
        s.pty.resume();
      } catch {
        /* ignore */
      }
      s.paused = false;
    }
  }

  /** 优雅关闭：杀全部 PTY */
  shutdown(): void {
    for (const s of this.sessions.values()) {
      try {
        s.pty.kill();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }
}
