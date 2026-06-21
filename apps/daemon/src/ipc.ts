/**
 * worker ↔ supervisor 的本地 IPC（Unix domain socket，字节流）。
 *
 * 复用数据面（#1）的二进制 pty 帧；控制消息走 JSON。UDS 无消息边界，故每条记录加
 * 4 字节大端长度前缀：[uint32 BE 长度][payload]。
 * payload 首字节是 FrameKind(1/2/3) → pty 数据帧（decodeFrame）；否则按 UTF-8 JSON 解析
 * （JSON 控制消息以 '{'=0x7b 开头，与 1/2/3 不冲突）。
 *
 * 这套"长度前缀帧 + 首字节判别"就是设计文档里 UDS 与 WS 共用的帧格式，只是 WS 自带分帧、
 * UDS 需自己加长度前缀。
 */
import type { Socket } from "node:net";
import { decodeFrame, type DataFrame, type SessionId, type TaskId, type RequestId } from "@coflux/protocol";

/** supervisor 把 UDS 路径经此环境变量传给 worker 子进程 */
export const SUPERVISOR_SOCK_ENV = "COFLUX_SUPERVISOR_SOCK";

/** worker → supervisor 控制消息（JSON） */
export type WorkerToSupervisor =
  | { type: "session.create"; sessionId: SessionId; taskId: TaskId; cwd: string; shell?: string; cols: number; rows: number }
  | { type: "session.close"; sessionId: SessionId }
  | { type: "session.replay"; sessionId: SessionId; requestId: RequestId }
  | { type: "pty.resize"; sessionId: SessionId; cols: number; rows: number }
  /** worker（重）连后索要存活会话列表 */
  | { type: "resync.request" }
  /** 背压：worker 的 server WS 缓冲水位驱动 supervisor 暂停/恢复全部 PTY */
  | { type: "pty.pause" }
  | { type: "pty.resume" };

/** supervisor → worker 控制消息（JSON） */
export type SupervisorToWorker =
  | { type: "session.started"; sessionId: SessionId; taskId: TaskId; pid: number }
  | { type: "session.exit"; sessionId: SessionId; exitCode: number }
  | { type: "resync.list"; sessions: { sessionId: SessionId; taskId: TaskId }[] };

/** 写一条带长度前缀的记录（一次 write，避免 header/payload 被其它写交错） */
export function writeRecord(sock: Socket, payload: Uint8Array): void {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.set(payload, 4);
  sock.write(out);
}

/** 写一条 JSON 控制消息 */
export function writeJson(sock: Socket, msg: WorkerToSupervisor | SupervisorToWorker): void {
  writeRecord(sock, Buffer.from(JSON.stringify(msg), "utf8"));
}

/** 累积式分帧解析器：喂入任意字节块，凑齐一条记录就回调 */
export class RecordParser {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onRecord: (payload: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      this.onRecord(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
  }
}

/** payload 是 pty 数据帧（首字节 1/2/3）还是 JSON 控制消息 */
export function isFrame(payload: Buffer): boolean {
  const k = payload[0];
  return k === 1 || k === 2 || k === 3;
}

export function parseFrame(payload: Buffer): DataFrame | null {
  return decodeFrame(payload);
}

export function parseJson<T>(payload: Buffer): T | null {
  try {
    return JSON.parse(payload.toString("utf8")) as T;
  } catch {
    return null;
  }
}
