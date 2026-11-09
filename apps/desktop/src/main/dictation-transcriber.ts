/**
 * The transcription engine contract, ported from the iOS `SpeechTranscribing`
 * (apps/ios/Coflux/Speech/SpeechTranscribing.swift). Events carry the full text, never a delta,
 * collapsed into two grades: volatile (a draft that may still change) and finalized (confirmed).
 */

export type SpeechFailure = "unreachable" | "invalid_key";

export type SpeechTranscriptEvent =
  /** Full text; later events may still rewrite it. */
  | { kind: "volatile"; text: string }
  /** Full text; confirmed (further speech grows after it without rewriting it). */
  | { kind: "finalized"; text: string }
  /** Unrecoverable error. There is a single engine and no fallback: the caller keeps whatever was
   * transcribed so far and ends the session. */
  | { kind: "failed"; error: SpeechFailure }
  /** The session has ended; nothing more follows. */
  | { kind: "closed" };

/** Why `start()` failed: the user can fix an invalid key; anything else is "unreachable". */
export class SpeechStartError extends Error {
  constructor(readonly reason: SpeechFailure) {
    super(reason);
  }
}

export interface SpeechTranscriber {
  /** Open the connection; rejects with `SpeechStartError` when it cannot be established. Never retried. */
  start(): Promise<void>;
  /** Mono Int16 little-endian PCM at the provider's rate (16 kHz 豆包, 24 kHz OpenAI); framed here. */
  feed(pcm: Buffer): void;
  /** Normal end: flush the remaining audio and wait (bounded) for the final result; afterwards
   * `closed` has been delivered. */
  finish(): Promise<void>;
  /** Abandon: disconnect at once without waiting for a final result. */
  cancel(): void;
}

export type SpeechEventListener = (event: SpeechTranscriptEvent) => void;

/** The `ws` constructor shape the engines need, injectable for tests. */
export type SocketFactory = (url: string, headers: Record<string, string>) => SpeechSocket;

/** The subset of a `ws` WebSocket the engines use. */
export type SpeechSocket = {
  readonly readyState: number;
  send(data: Buffer | string): void;
  close(code?: number): void;
  terminate(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "upgrade", listener: (response: { headers: Record<string, string | string[] | undefined> }) => void): unknown;
  on(event: "unexpected-response", listener: (request: { destroy(): void }, response: { statusCode?: number; headers: Record<string, string | string[] | undefined>; resume?(): void }) => void): unknown;
};

export const SOCKET_OPEN = 1;
export const SOCKET_CONNECTING = 0;

/** A received message as one Buffer. */
export function messageBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Close politely when open, abort when still connecting; never throws. */
export function closeSocket(socket: SpeechSocket | null): void {
  if (!socket) return;
  try {
    if (socket.readyState === SOCKET_OPEN) socket.close(1001);
    else socket.terminate();
  } catch {
    // Already closed.
  }
}
