import { GHOSTTY_BATCH, GHOSTTY_CHUNK, GHOSTTY_MAX_OPERATIONS, GHOSTTY_QUOTA, type GhosttyEvent, type GhosttyMessage, type GhosttyOperation, type SurfaceKey } from "./ghostty";

/** 发送前记账，使 Electron IPC 自身也有界。解析 ack 前不释放任何输出额度。 */
export class GhosttySender {
  private pending: GhosttyMessage[] = [];
  private outstanding = new Map<number, number>();
  private sequence = 0;
  private bytes = 0;
  private batchBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  peakBytes = 0;
  constructor(readonly key: SurfaceKey, private send: (messages: GhosttyMessage[]) => void, private resume: (reason: string) => void, private quota = GHOSTTY_QUOTA) {}
  get lastSequence(): number { return this.sequence; }
  get queuedBytes(): number { return this.bytes; }
  output(bytes: Uint8Array, replace = false, replay = replace): boolean {
    if (this.stopped) return false;
    const count = Math.max(1, Math.ceil(bytes.byteLength / GHOSTTY_CHUNK));
    if (this.bytes + bytes.byteLength > this.quota || this.outstanding.size + count > GHOSTTY_MAX_OPERATIONS) {
      this.fail("渲染层未确认输出超过额度，需要完整快照");
      return false;
    }
    for (let offset = 0; offset < bytes.byteLength || offset === 0; offset += GHOSTTY_CHUNK) {
      this.enqueue({ kind: "output", bytes: bytes.slice(offset, offset + GHOSTTY_CHUNK), replace: replace && offset === 0, replay });
    }
    return true;
  }
  control(operation: Exclude<GhosttyOperation, { kind: "output" }>): void {
    if (this.stopped) return;
    if (this.outstanding.size >= GHOSTTY_MAX_OPERATIONS) return this.fail("控制消息队列超过额度");
    this.enqueue(operation);
    this.flush();
  }
  ack(event: GhosttyEvent): void {
    if (this.stopped || event.kind !== "ack" || event.surfaceId !== this.key.surfaceId || event.generation !== this.key.generation) return;
    const size = this.outstanding.get(event.sequence);
    if (size === undefined || size !== event.bytes) return;
    this.bytes -= size;
    this.outstanding.delete(event.sequence);
  }
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.batchBytes = 0;
    this.send(batch);
  }
  destroy(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.pending = [];
    this.outstanding.clear();
    this.bytes = 0;
  }
  private fail(reason: string): void {
    if (this.stopped) return;
    // 先送完已编号消息，再把同序列中的 recover 交给宿主；本地立即注销 consumer。
    this.flush();
    this.send([{ ...this.key, sequence: ++this.sequence, operation: { kind: "recover", reason } }]);
    this.destroy();
    this.resume(reason);
  }
  private enqueue(operation: GhosttyOperation): void {
    const size = operation.kind === "output" ? operation.bytes.byteLength : 0;
    const sequence = ++this.sequence;
    this.bytes += size;
    this.batchBytes += size;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
    this.outstanding.set(sequence, size);
    this.pending.push({ ...this.key, sequence, operation });
    if (this.batchBytes >= GHOSTTY_BATCH || this.pending.length >= 64) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 4);
  }
}
