import workletUrl from "./dictation-capture.worklet?worker&url";

/**
 * Microphone capture for dictation (plan 20261110-desktop-dictation D4): mono audio with the
 * browser's echo cancellation, noise suppression and gain control, downsampled in an AudioWorklet
 * to Int16 PCM at the provider's rate and delivered in ~100 ms chunks, plus a smoothed 0…1 level
 * for the button. `stop` releases the tracks, so the macOS microphone indicator goes off.
 */

export type DictationCapture = {
  /** `flush` delivers the partial last chunk first; either way no chunk follows the returned promise. */
  stop: (flush: boolean) => Promise<void>;
};

const PROCESSOR_NAME = "coflux-dictation-capture";
/** Chunk length the worklet posts. */
const CHUNK_SECONDS = 0.1;
/** Level smoothing per ~20 ms update: fast attack, slower release. */
const LEVEL_ATTACK = 0.6;
const LEVEL_RELEASE = 0.15;
/** RMS in dBFS mapped onto 0…1: quiet room at the floor, loud speech near the top. */
const LEVEL_FLOOR_DB = -55;
const LEVEL_RANGE_DB = 45;
/** How long `stop(true)` waits for the worklet's last chunk. */
const FLUSH_TIMEOUT_MS = 250;

export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / LEVEL_RANGE_DB));
}

export async function startDictationCapture(options: {
  sampleRate: number;
  onChunk: (pcm: ArrayBuffer) => void;
  onLevel: (level: number) => void;
}): Promise<DictationCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let context: AudioContext | null = null;
  try {
    context = new AudioContext({ latencyHint: "interactive" });
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { targetRate: options.sampleRate, chunkSamples: Math.round(options.sampleRate * CHUNK_SECONDS) },
    });
    // The node writes no output; a muted path to the destination keeps the graph pulling it.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    if (context.state === "suspended") await context.resume();

    let delivering = true;
    let smoothed = 0;
    let flushed: (() => void) | null = null;
    node.port.onmessage = (event: MessageEvent<{ type: string; buffer?: ArrayBuffer; rms?: number }>) => {
      const data = event.data;
      if (data.type === "pcm" && data.buffer && delivering) options.onChunk(data.buffer);
      else if (data.type === "level" && delivering) {
        const level = levelFromRms(data.rms ?? 0);
        smoothed += (level - smoothed) * (level > smoothed ? LEVEL_ATTACK : LEVEL_RELEASE);
        options.onLevel(smoothed);
      } else if (data.type === "flushed") flushed?.();
    };

    const audioContext = context;
    let stopping: Promise<void> | null = null;
    return {
      stop(flush) {
        if (stopping) return stopping;
        stopping = (async () => {
          if (flush) {
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(resolve, FLUSH_TIMEOUT_MS);
              flushed = () => {
                window.clearTimeout(timer);
                resolve();
              };
              node.port.postMessage("flush");
            });
          }
          delivering = false;
          options.onLevel(0);
          node.port.postMessage("stop");
          node.port.onmessage = null;
          source.disconnect();
          node.disconnect();
          mute.disconnect();
          stopTracks();
          await audioContext.close().catch(() => undefined);
        })();
        return stopping;
      },
    };
  } catch (error) {
    stopTracks();
    await context?.close().catch(() => undefined);
    throw error;
  }
}
