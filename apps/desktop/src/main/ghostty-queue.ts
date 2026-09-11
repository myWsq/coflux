import { GHOSTTY_MAX_OPERATIONS, GHOSTTY_QUOTA, type GhosttyEvent, type GhosttyMessage, type GhosttyOperation, type SurfaceKey } from "../shared/ghostty";

export type QueueExecutor = (operation: GhosttyOperation, complete: (error?: string) => void) => void;

/** 一个 generation 一条队列。排队与正在解析的字节共同占额度，destroy 使所有 completion 失效。 */
export class GhosttyQueue {
  private pending: GhosttyMessage[] = [];
  private current: GhosttyMessage | undefined;
  private sequence = 0;
  private stopped = false;
  private destroyed = false;
  private bytes = 0;
  private peak = 0;
  constructor(
    readonly key: SurfaceKey,
    private execute: QueueExecutor,
    private emit: (event: GhosttyEvent) => void,
    private quota = GHOSTTY_QUOTA,
  ) {}
  get nextSequence(): number { return this.sequence + 1; }
  get queuedBytes(): number { return this.bytes; }
  get peakBytes(): number { return this.peak; }
  get recovering(): boolean { return this.stopped; }
  accepts(key: SurfaceKey): boolean {
    return !this.destroyed && key.surfaceId === this.key.surfaceId && key.generation === this.key.generation;
  }
  receive(message: GhosttyMessage): void {
    if (!this.accepts(message) || this.stopped) return;
    if (message.sequence <= this.sequence) return;
    if (message.sequence !== this.sequence + 1) return this.recover("IPC 序号不连续");
    this.sequence = message.sequence;
    if (message.operation.kind === "recover") return this.recover(message.operation.reason);
    const size = message.operation.kind === "output" ? message.operation.bytes.byteLength : 0;
    if (this.bytes + size > this.quota || this.pending.length >= GHOSTTY_MAX_OPERATIONS) {
      return this.recover("原生队列额度耗尽，需要完整快照");
    }
    this.bytes += size;
    this.peak = Math.max(this.peak, this.bytes);
    this.pending.push(message);
    this.drain();
  }
  recover(reason: string): void {
    if (this.destroyed || this.stopped) return;
    this.stopped = true;
    // 停止消费，不把未解析 delta 当成功；旧 generation 由完整恢复取代。
    this.pending = [];
    this.bytes = this.current?.operation.kind === "output" ? this.current.operation.bytes.byteLength : 0;
    this.emit({ ...this.key, kind: "resume", reason });
  }
  destroy(): void {
    this.destroyed = true;
    this.pending = [];
    this.current = undefined;
    this.bytes = 0;
  }
  private drain(): void {
    if (this.destroyed || this.stopped || this.current) return;
    const next = this.pending.shift();
    if (!next) return;
    this.current = next;
    let completed = false;
    const complete = (error?: string) => {
      if (completed || !this.accepts(next) || this.current !== next) return;
      completed = true;
      const size = next.operation.kind === "output" ? next.operation.bytes.byteLength : 0;
      this.bytes -= size;
      this.current = undefined;
      if (error) return this.recover(error);
      if (!this.stopped) {
        this.emit({ ...this.key, kind: "ack", sequence: next.sequence, bytes: size, queuedBytes: this.bytes, peakBytes: this.peak });
        this.drain();
      }
    };
    try { this.execute(next.operation, complete); }
    catch (error) { complete(String(error)); }
  }
}

/** 保留 generation 墓碑，旧 create/destroy 不能复活或关闭新 surface。随 renderer 生命周期销毁。 */
export class GhosttyGenerations {
  private latest = new Map<string, number>();
  advance(key: SurfaceKey): boolean {
    if (key.generation <= (this.latest.get(key.surfaceId) ?? 0)) return false;
    if (!this.latest.has(key.surfaceId) && this.latest.size >= 4096) return false;
    this.latest.set(key.surfaceId, key.generation);
    return true;
  }
}
