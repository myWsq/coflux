import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

const MAX_FRAME = 30 * 1024 * 1024;
const MAX_BUFFER = 128 * 1024 * 1024;
type Result = { ok?: boolean; publicKey?: string; version?: number; path?: { mode: "direct" | "relay" | "unknown"; endpoint?: string; backendRegion?: number; latencyMs?: number }; [key: string]: unknown };
type Pending = { resolve(value: Result): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Stream = { frame(bytes: Uint8Array): void; close(): void };

/** One owned process, private inherited pipes, and bounded binary framing. */
export class TailcatHelper {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private streams = new Map<number, Stream>();
  private next = 1;
  private closed = false;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private headOffset = 0;
  private expected?: { kind: number; stream: number; bytes: number };

  constructor(path: string, private readonly onClose: () => void) {
    if (!isAbsolute(path)) throw new Error("原生网络组件路径无效");
    this.child = spawn(path, [], { stdio: "pipe", env: process.env });
    this.child.stderr.resume();
    this.child.once("error", () => this.close());
    this.child.once("exit", () => this.close());
    this.child.stdin.on("error", () => this.close());
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      if (chunk.length > MAX_BUFFER - this.bytes) { this.close(); return; }
      this.chunks.push(chunk); this.bytes += chunk.length;
      this.parse();
    });
  }

  private take(size: number): Buffer {
    const output = Buffer.allocUnsafe(size); let written = 0;
    while (written < size) {
      const head = this.chunks[0]!; const count = Math.min(size - written, head.length - this.headOffset);
      head.copy(output, written, this.headOffset, this.headOffset + count); written += count; this.headOffset += count;
      if (this.headOffset === head.length) { this.chunks.shift(); this.headOffset = 0; }
    }
    this.bytes -= size; return output;
  }

  private parse(): void {
    while (!this.closed) {
      if (!this.expected) {
        if (this.bytes < 9) return;
        const header = this.take(9), size = header.readUInt32BE(0) - 5, kind = header[4]!, stream = header.readUInt32BE(5);
        if (size <= 0 || size > MAX_FRAME || !((kind === 1 && stream === 0 && size <= 65536) || (kind === 2 && stream > 0))) { this.close(); return; }
        this.expected = { kind, stream, bytes: size };
      }
      if (this.bytes < this.expected.bytes) return;
      const expected = this.expected, payload = this.take(expected.bytes); this.expected = undefined;
      if (expected.kind === 2) { const stream = this.streams.get(expected.stream); if (!stream) { this.close(); return; } stream.frame(payload); continue; }
      let event: Result;
      try { event = JSON.parse(payload.toString("utf8")); } catch { this.close(); return; }
      if (typeof event.id === "number") {
        const pending = this.pending.get(event.id); if (!pending) continue;
        this.pending.delete(event.id); clearTimeout(pending.timer);
        if (event.ok) pending.resolve(event); else pending.reject(new Error("原生远程连接未就绪"));
      } else if (event.op === "closed" && typeof event.stream === "number") {
        const stream = this.streams.get(event.stream); this.streams.delete(event.stream); stream?.close();
      } else { this.close(); return; }
    }
  }

  private write(kind: number, stream: number, bytes: Uint8Array): boolean {
    if (this.closed || bytes.length === 0 || bytes.length > MAX_FRAME || this.child.stdin.writableLength + bytes.length + 9 > MAX_BUFFER) return false;
    const header = Buffer.allocUnsafe(9); header.writeUInt32BE(bytes.length + 5, 0); header[4] = kind; header.writeUInt32BE(stream, 5);
    this.child.stdin.cork(); this.child.stdin.write(header); this.child.stdin.write(bytes); this.child.stdin.uncork(); return true;
  }
  request(op: string, fields: Record<string, unknown> = {}): Promise<Result> {
    if (this.pending.size >= 256 || this.next >= 0xffffffff || this.closed) return Promise.reject(new Error("原生网络组件繁忙"));
    const id = this.next++; const bytes = Buffer.from(JSON.stringify({ ...fields, id, op }));
    if (bytes.length > 65536) return Promise.reject(new Error("原生网络请求过大"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("原生网络组件响应超时")); this.close(); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.write(1, 0, bytes)) { clearTimeout(timer); this.pending.delete(id); reject(new Error("原生网络组件已关闭")); }
    });
  }
  watch(stream: number, handlers: Stream): void { if (this.streams.size >= 256 || this.streams.has(stream)) throw new Error("远程连接数已达上限"); this.streams.set(stream, handlers); }
  send(stream: number, bytes: Uint8Array): boolean { return this.streams.has(stream) && this.write(2, stream, bytes); }
  closeStream(stream: number): void { const existing = this.streams.get(stream); if (existing) this.streams.set(stream, { frame: () => {}, close: () => {} }); existing?.close(); if (!this.closed) void this.request("close", { stream }).catch(() => this.close()); }
  close(): void {
    if (this.closed) return; this.closed = true;
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    this.child.kill("SIGTERM");
    const reap = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 2000); reap.unref();
    this.child.once("exit", () => clearTimeout(reap));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("原生网络组件已关闭")); } this.pending.clear();
    for (const stream of this.streams.values()) stream.close(); this.streams.clear(); this.chunks = []; this.bytes = 0;
    this.onClose();
  }
}
