/**
 * The dictation capture processor (plan 20261110-desktop-dictation), loaded with
 * `audioWorklet.addModule` from the URL Vite emits for it (`?worker&url`): a same-origin script,
 * as the renderer's CSP (`script-src 'self'`) requires.
 *
 * Mono input at the context's rate is box-filtered down to the provider's rate (16 kHz 豆包,
 * 24 kHz OpenAI) and posted as Int16 PCM chunks; the input's RMS is posted every ~20 ms for the
 * level meter. `flush` posts the partial last chunk and answers `flushed`; `stop` ends processing.
 */

// The AudioWorkletGlobalScope is not part of the DOM lib.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void;
declare const sampleRate: number;

type CaptureOptions = { targetRate: number; chunkSamples: number };

const LEVEL_SECONDS = 0.02;

class DictationCaptureProcessor extends AudioWorkletProcessor {
  private readonly ratio: number;
  private readonly out: Int16Array;
  private outLength = 0;
  private acc = 0;
  private count = 0;
  private position = 0;
  private levelSum = 0;
  private levelCount = 0;
  private readonly levelEvery: number;
  private stopped = false;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const { targetRate, chunkSamples } = options.processorOptions as CaptureOptions;
    this.ratio = sampleRate / targetRate;
    this.out = new Int16Array(Math.max(1, chunkSamples));
    this.levelEvery = Math.max(128, Math.round(sampleRate * LEVEL_SECONDS));
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === "flush") {
        this.postChunk();
        this.port.postMessage({ type: "flushed" });
      } else if (event.data === "stop") {
        this.stopped = true;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index]!;
      this.levelSum += sample * sample;
      this.levelCount += 1;
      this.acc += sample;
      this.count += 1;
      this.position += 1;
      // Each output sample is the mean of the input samples since the previous one; an input rate
      // below the target (never seen on a Mac) holds the sample instead.
      while (this.position >= this.ratio) {
        this.position -= this.ratio;
        this.emit(this.acc / this.count);
        if (this.ratio >= 1) {
          this.acc = 0;
          this.count = 0;
        }
      }
      if (this.ratio < 1) {
        this.acc = 0;
        this.count = 0;
      }
    }
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({ type: "level", rms: Math.sqrt(this.levelSum / this.levelCount) });
      this.levelSum = 0;
      this.levelCount = 0;
    }
    return true;
  }

  private emit(value: number): void {
    const clamped = Math.max(-1, Math.min(1, value));
    this.out[this.outLength] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    this.outLength += 1;
    if (this.outLength === this.out.length) this.postChunk();
  }

  private postChunk(): void {
    if (this.outLength === 0) return;
    const chunk = this.out.slice(0, this.outLength).buffer;
    this.outLength = 0;
    this.port.postMessage({ type: "pcm", buffer: chunk }, [chunk]);
  }
}

registerProcessor("coflux-dictation-capture", DictationCaptureProcessor);

export {};
