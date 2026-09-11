export type TerminalSample = {
  requestId: string; at: number; mainRss: number; mainLoopMaxMs: number; mainLoopP99Ms: number;
  metalAllocatedBytes: number | null;
  processes: Array<{ type: string; cpu: number; workingSetKB: number }>;
};
export type TerminalMetricsBridge = {
  enabled: boolean;
  sample(requestId: string): void;
  onSample(listener: (sample: TerminalSample) => void): () => void;
};

/** 两种引擎使用相同 PING/PONG 语料，统计 sendInput→解析完成，不能当成 GPU 呈现时间。 */
export class TerminalLatencyProbe {
  private sent = new Map<string, number>();
  private decoder = new TextDecoder();
  private tail = "";
  constructor(private report: (latency: number) => void) {}
  input(id: string): string {
    this.sent.set(id, performance.now());
    if (this.sent.size > 256) this.sent.delete(this.sent.keys().next().value!);
    return `COFLUX_PING_${id}\n`;
  }
  parsed(bytes: Uint8Array): void {
    const text = this.tail + this.decoder.decode(bytes, { stream: true });
    this.tail = text.replace(/COFLUX_PONG_([a-zA-Z0-9-]+)\r?\n/g, (_match, id: string) => {
      const start = this.sent.get(id);
      if (start !== undefined) { this.sent.delete(id); this.report(performance.now() - start); }
      return "";
    }).slice(-256);
  }
}
