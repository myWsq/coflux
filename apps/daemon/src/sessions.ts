/**
 * SessionManager —— PTY 会话的生命周期管理。
 *
 * 持有 PTY、scrollback 环形缓冲、背压（按发送缓冲水位 pause/resume PTY）。
 * 通过注入的 Sender 把输出/事件发回服务器，从而与连接层解耦（连接重连时 Sender 自动指向新 socket）。
 * 会话表在此模块内常驻，跨 WS 重连存活 —— 断线续连的根基。
 */
import os from "node:os";
import { spawn, type IPty } from "node-pty";
import type { Logger } from "@coflux/core";
import type { DaemonToServer, SessionId, TaskId } from "@coflux/protocol";

export interface Sender {
  send(msg: DaemonToServer): void;
  bufferedAmount(): number;
  isOpen(): boolean;
}

export interface SessionOptions {
  defaultShell: string;
  scrollbackLimit: number;
  pauseHigh: number;
  resumeLow: number;
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
  private drainTimer: ReturnType<typeof setInterval>;

  constructor(private sender: Sender, private opts: SessionOptions, private log: Logger) {
    this.drainTimer = setInterval(() => this.drain(), 100);
    this.drainTimer.unref();
  }

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
      this.sender.send({ type: "pty.output", sessionId, data });
      if (this.sender.bufferedAmount() > this.opts.pauseHigh && !s.paused) {
        try {
          s.pty.pause();
        } catch {
          /* ignore */
        }
        s.paused = true;
      }
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
    this.sender.send({ type: "pty.replay", sessionId, requestId, data: s?.scrollback ?? "" });
  }

  /** 重连后上报仍存活的会话以便服务器重挂 */
  resyncList(): { sessionId: SessionId; taskId: TaskId }[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({ sessionId, taskId: s.taskId }));
  }

  /** 发送缓冲降下来后恢复被背压暂停的会话（仅在连接打开时） */
  private drain(): void {
    if (!this.sender.isOpen() || this.sender.bufferedAmount() > this.opts.resumeLow) return;
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

  /** 优雅关闭：停 drain、杀全部 PTY */
  shutdown(): void {
    clearInterval(this.drainTimer);
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
