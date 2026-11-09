import { randomUUID } from "node:crypto";

import {
  closeSocket,
  messageBuffer,
  SpeechStartError,
  type SocketFactory,
  type SpeechEventListener,
  type SpeechSocket,
  type SpeechTranscriber,
} from "./dictation-transcriber";

/**
 * 豆包 Seed-ASR 2.0 streaming recognition, ported from the iOS `SeedASRProvider`
 * (apps/ios/Coflux/Speech/SeedASRProvider.swift), over the Volcengine "bigmodel_async" binary
 * WebSocket protocol, billed to the account's key. The endpoint and the resource id come from the
 * account's 豆包 configuration, defaults already resolved.
 *
 * Frame layout, both directions: a 4-byte header
 * `[version 1 | header size 1 (×4 bytes)] [message type | flags] [serialization | compression] [reserved]`,
 * then (per flags) a big-endian Int32 sequence, then a big-endian UInt32 payload size and the
 * payload. Nothing is ever compressed. The conversation context goes only in the first frame. One
 * connection per dictation; never retried and never replaced by another engine.
 */

/** 200 ms of 16 kHz mono Int16 PCM. */
export const SEED_BYTES_PER_FRAME = 6400;
/** Seed's two-pass final result arrives ~0.7–0.9 s after the last frame. */
const FINAL_RESULT_TIMEOUT_MS = 2000;

export const SEED_MESSAGE_TYPE = {
  fullClientRequest: 0b0001,
  audioOnlyRequest: 0b0010,
  fullServerResponse: 0b1001,
  serverError: 0b1111,
} as const;
export const SEED_FLAGS = {
  sequence: 0b0001,
  last: 0b0010,
  event: 0b0100,
  lastWithNegativeSequence: 0b0011,
} as const;
export const SEED_SERIALIZATION = { none: 0, json: 1 } as const;

/** One client frame: header, sequence, payload size, payload. */
export function seedFrame(type: number, flags: number, serialization: number, sequence: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(12 + payload.length);
  frame[0] = 0x11;
  frame[1] = ((type << 4) | flags) & 0xff;
  frame[2] = ((serialization << 4) | 0x00) & 0xff;
  frame[3] = 0x00;
  frame.writeInt32BE(sequence, 4);
  frame.writeUInt32BE(payload.length, 8);
  payload.copy(frame, 12);
  return frame;
}

/** The first frame's JSON: audio format, request options and, when present, the dialog context. */
export function seedConfigPayload(contextItems: readonly string[]): Buffer {
  const request: Record<string, unknown> = {
    model_name: "bigmodel",
    enable_itn: true,
    enable_punc: true,
    enable_nonstream: true,
    show_utterances: true,
    result_type: "full",
  };
  if (contextItems.length > 0) {
    const context = { context_type: "dialog_ctx", context_data: contextItems.map((text) => ({ text })) };
    request.corpus = { context: JSON.stringify(context) };
  }
  const body = {
    user: { uid: "coflux-ios" },
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request,
  };
  return Buffer.from(JSON.stringify(body), "utf8");
}

export type SeedServerFrame = { kind: "result"; payload: Buffer; isLast: boolean } | { kind: "error"; code: number };

/** Null = a frame this client cannot read (truncated, or compressed, which it never asks for). */
export function parseSeedFrame(bytes: Buffer): SeedServerFrame | null {
  if (bytes.length < 4) return null;
  const headerSize = (bytes[0]! & 0x0f) * 4;
  const type = bytes[1]! >> 4;
  const flags = bytes[1]! & 0x0f;
  const compression = bytes[2]! & 0x0f;
  if (headerSize < 4 || compression !== 0) return null;
  let offset = headerSize;
  const readUInt32 = (): number | null => {
    if (offset + 4 > bytes.length) return null;
    const value = bytes.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  if (flags & SEED_FLAGS.sequence && readUInt32() === null) return null;
  if (flags & SEED_FLAGS.event && readUInt32() === null) return null;
  if (type === SEED_MESSAGE_TYPE.serverError) {
    const code = readUInt32();
    if (code === null) return null;
    return { kind: "error", code: code | 0 };
  }
  const size = readUInt32();
  if (size === null) return null;
  const end = offset + size;
  if (end > bytes.length) return null;
  const isLast = (flags & SEED_FLAGS.last) !== 0;
  if (type !== SEED_MESSAGE_TYPE.fullServerResponse) return { kind: "result", payload: Buffer.alloc(0), isLast };
  return { kind: "result", payload: bytes.subarray(offset, end), isLast };
}

/** The text of a response payload and whether every utterance is definite; null for no text. */
export function seedResultText(payload: Buffer): { text: string; settled: boolean } | null {
  if (payload.length === 0) return null;
  let object: unknown;
  try {
    object = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const raw = (object as { result?: unknown }).result;
  const result = Array.isArray(raw) ? raw[0] : raw;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const text = (result as { text?: unknown }).text;
  if (typeof text !== "string" || text.length === 0) return null;
  const utterances = (result as { utterances?: unknown }).utterances;
  const list = Array.isArray(utterances) ? utterances : [];
  const settled = list.every((item) => !!item && typeof item === "object" && (item as { definite?: unknown }).definite === true);
  return { text, settled };
}

export class SeedASRTranscriber implements SpeechTranscriber {
  private socket: SpeechSocket | null = null;
  /** The service's trace id for this connection (`X-Tt-Logid`), for the failure log line only. */
  private logId = "";
  private pcmBuffer = Buffer.alloc(0);
  /** Sequence number of the last frame sent (the first frame is 1). */
  private sequence = 0;
  private audioSent = false;
  private finishing = false;
  private torndown = false;
  private listening = false;
  private lastText = "";
  private finalWaiter: (() => void) | null = null;

  constructor(
    private readonly options: {
      apiKey: string;
      /** The full `wss://` endpoint. */
      endpoint: string;
      /** Sent as `X-Api-Resource-Id`. */
      resourceId: string;
      /** Plain-text dialog context, most relevant first; empty = no context. */
      contextItems: readonly string[];
      socket: SocketFactory;
      onEvent: SpeechEventListener;
      log?: (message: string) => void;
    },
  ) {}

  start(): Promise<void> {
    if (this.torndown) return Promise.reject(new SpeechStartError("unreachable"));
    let url: URL;
    try {
      url = new URL(this.options.endpoint);
    } catch {
      this.log("seed-asr endpoint is not a URL");
      this.teardown(false);
      return Promise.reject(new SpeechStartError("unreachable"));
    }
    const connectId = randomUUID();
    const socket = this.options.socket(url.toString(), {
      "X-Api-Key": this.options.apiKey,
      "X-Api-Resource-Id": this.options.resourceId,
      "X-Api-Request-Id": connectId,
      "X-Api-Connect-Id": connectId,
      "X-Api-Sequence": "-1",
    });
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const refuse = (reason: "unreachable" | "invalid_key") => {
        if (settled) return;
        settled = true;
        this.teardown(false);
        reject(new SpeechStartError(reason));
      };
      socket.on("upgrade", (response) => {
        this.logId = headerValue(response.headers["x-tt-logid"]);
      });
      socket.on("unexpected-response", (_request, response) => {
        this.logId = headerValue(response.headers["x-tt-logid"]);
        const status = response.statusCode ?? 0;
        this.log(`seed-asr handshake failed: status ${status}, logid ${this.logId}`);
        refuse(status === 401 ? "invalid_key" : "unreachable");
      });
      socket.on("error", () => {
        if (!settled) {
          this.log(`seed-asr handshake failed, logid ${this.logId}`);
          refuse("unreachable");
        } else this.connectionLost();
      });
      socket.on("close", () => {
        if (!settled) refuse("unreachable");
        else this.connectionLost();
      });
      socket.on("message", (data) => this.receive(messageBuffer(data)));
      socket.on("open", () => {
        if (settled) return;
        let payload: Buffer;
        try {
          payload = seedConfigPayload(this.options.contextItems);
        } catch {
          refuse("unreachable");
          return;
        }
        this.sequence = 1;
        try {
          socket.send(seedFrame(SEED_MESSAGE_TYPE.fullClientRequest, SEED_FLAGS.sequence, SEED_SERIALIZATION.json, this.sequence, payload));
        } catch {
          refuse("unreachable");
          return;
        }
        if (this.torndown) {
          refuse("unreachable");
          return;
        }
        settled = true;
        this.listening = true;
        resolve();
      });
    });
  }

  feed(pcm: Buffer): void {
    if (this.finishing || this.torndown || !this.listening) return;
    this.pcmBuffer = this.pcmBuffer.length === 0 ? Buffer.from(pcm) : Buffer.concat([this.pcmBuffer, pcm]);
    while (!this.finishing && !this.torndown && this.pcmBuffer.length >= SEED_BYTES_PER_FRAME) {
      const chunk = this.pcmBuffer.subarray(0, SEED_BYTES_PER_FRAME);
      this.pcmBuffer = this.pcmBuffer.subarray(SEED_BYTES_PER_FRAME);
      this.sendAudio(Buffer.from(chunk), false);
    }
  }

  /** Send the remaining audio and the final frame, then wait (bounded) for the last package. */
  async finish(): Promise<void> {
    if (this.finishing || this.torndown || !this.listening) return;
    this.finishing = true;
    let final = this.pcmBuffer;
    this.pcmBuffer = Buffer.alloc(0);
    // The service needs at least one audio frame: a session without any still sends 200 ms of
    // silence as its final frame.
    if (!this.audioSent && final.length === 0) final = Buffer.alloc(SEED_BYTES_PER_FRAME);
    this.sendAudio(Buffer.from(final), true);
    if (this.torndown) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.finalWaiter) return;
        this.log(`seed-asr final result timed out, logid ${this.logId}`);
        this.teardown(true);
      }, FINAL_RESULT_TIMEOUT_MS);
      this.finalWaiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      if (this.torndown) this.finalWaiter();
    });
  }

  cancel(): void {
    this.finishing = true;
    this.teardown(true);
  }

  private sendAudio(pcm: Buffer, last: boolean): void {
    const socket = this.socket;
    if (!socket || this.torndown) return;
    this.sequence += 1;
    const frame = seedFrame(
      SEED_MESSAGE_TYPE.audioOnlyRequest,
      last ? SEED_FLAGS.lastWithNegativeSequence : SEED_FLAGS.sequence,
      SEED_SERIALIZATION.none,
      last ? -this.sequence : this.sequence,
      pcm,
    );
    try {
      socket.send(frame);
      this.audioSent = true;
    } catch {
      // A failed send means the connection is gone; the close handler reports it.
    }
  }

  private receive(data: Buffer): void {
    if (this.torndown || !this.listening) return;
    const response = parseSeedFrame(data);
    if (!response) {
      this.fail("malformed frame");
      return;
    }
    if (response.kind === "error") {
      this.fail(`server error ${response.code}`);
      return;
    }
    const result = seedResultText(response.payload);
    if (result) {
      this.lastText = result.text;
      this.options.onEvent(result.settled ? { kind: "finalized", text: result.text } : { kind: "volatile", text: result.text });
    }
    if (response.isLast) {
      if (this.lastText) this.options.onEvent({ kind: "finalized", text: this.lastText });
      this.teardown(true);
    }
  }

  private connectionLost(): void {
    if (this.torndown) return;
    this.fail("connection lost");
  }

  private fail(reason: string): void {
    this.log(`seed-asr failed: ${reason}, logid ${this.logId}`);
    this.options.onEvent({ kind: "failed", error: "unreachable" });
    this.teardown(true);
  }

  private teardown(emitClosed: boolean): void {
    if (this.torndown) return;
    this.torndown = true;
    closeSocket(this.socket);
    if (emitClosed) this.options.onEvent({ kind: "closed" });
    const waiter = this.finalWaiter;
    this.finalWaiter = null;
    waiter?.();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}
