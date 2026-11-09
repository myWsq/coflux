import { estimatedTokens, RECOGNITION_TOKEN_BUDGET } from "./dictation-text";
import {
  closeSocket,
  messageBuffer,
  SpeechStartError,
  type SocketFactory,
  type SpeechEventListener,
  type SpeechFailure,
  type SpeechSocket,
  type SpeechTranscriber,
} from "./dictation-transcriber";

/**
 * OpenAI Realtime transcription, ported from the iOS `OpenAIRealtimeTranscriber`
 * (apps/ios/Coflux/Speech/OpenAIRealtimeTranscriber.swift), over the JSON WebSocket protocol of a
 * transcription-only session, billed to the account's OpenAI key.
 *
 * One connection per dictation: `session.update` configures a `transcription` session with 24 kHz
 * mono PCM, the live model, the conversation context as `prompt` and no turn detection (live models
 * support neither server nor semantic VAD, and the stop is the turn's end). Audio goes as base64
 * `input_audio_buffer.append` events while the user speaks and one `input_audio_buffer.commit` at
 * the stop. Never retried and never replaced by another engine.
 */

/** 150 ms of 24 kHz mono Int16 PCM per append event. */
export const OPENAI_BYTES_PER_CHUNK = 7200;
/** Bounded wait for the completed transcript after the commit. Measured live (2026-11-09, from
 * China): the live model's last deltas and the completion arrive 3–13 s after the commit, so a short
 * bound cuts off the end of what was said. On timeout the draft so far is kept. */
const FINAL_RESULT_TIMEOUT_MS = 10_000;

/** `https://host/base` → `wss://host/base/realtime?intent=transcription`. Null for anything that is
 * not an https URL. */
export function openAISocketUrl(baseUrl: string): string | null {
  const scheme = "https://";
  if (!baseUrl.toLowerCase().startsWith(scheme)) return null;
  let rest = baseUrl.slice(scheme.length);
  while (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (!rest) return null;
  try {
    return new URL(`wss://${rest}/realtime?intent=transcription`).toString();
  } catch {
    return null;
  }
}

export function openAISessionUpdate(model: string, prompt: string): string {
  const transcription: Record<string, unknown> = { model, languages: ["zh", "en"] };
  if (prompt) transcription.prompt = prompt;
  return JSON.stringify({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription,
          turn_detection: null,
        },
      },
    },
  });
}

/** The context as one prompt, one item per line in reading order: the workspace sentence, then the
 * conversation oldest to newest so the latest turn sits next to the speech. The items already fit
 * the token budget; the oldest conversation entries are dropped should the line breaks push it over. */
export function openAIPrompt(items: readonly string[]): string {
  // Conversation entries carry their speaker prefix; anything else is the workspace or term sentence.
  const isConversation = (item: string) => item.startsWith("我：") || item.startsWith("Agent：");
  const sentence = items.filter((item) => !isConversation(item));
  const conversation = items.filter(isConversation).reverse();
  const joined = () => [...sentence, ...conversation].join("\n");
  while (conversation.length > 0 && estimatedTokens(joined()) > RECOGNITION_TOKEN_BUDGET) conversation.shift();
  return joined();
}

export class OpenAIRealtimeTranscriber implements SpeechTranscriber {
  private socket: SpeechSocket | null = null;
  /** The service's id for this session (`session.created`), for the failure log line only. */
  private sessionId = "";
  private pcmBuffer = Buffer.alloc(0);
  /** The service has applied our `session.update`. Audio is held until then: appended before it, a
   * live probe once got no deltas at all until the commit. */
  private configured = false;
  private audioSent = false;
  private finishing = false;
  private torndown = false;
  private listening = false;
  /** All transcript text received so far: deltas are appended, events always carry the whole. */
  private draft = "";
  private finalWaiter: (() => void) | null = null;
  private readonly prompt: string;

  constructor(
    private readonly options: {
      apiKey: string;
      /** The REST base (`https://…`); the socket URL is derived from it. */
      baseUrl: string;
      model: string;
      /** Plain-text context: the workspace sentence first, then conversation entries newest first. */
      contextItems: readonly string[];
      socket: SocketFactory;
      onEvent: SpeechEventListener;
      log?: (message: string) => void;
    },
  ) {
    this.prompt = openAIPrompt(options.contextItems);
  }

  start(): Promise<void> {
    if (this.torndown) return Promise.reject(new SpeechStartError("unreachable"));
    const url = openAISocketUrl(this.options.baseUrl);
    if (!url) {
      this.log("openai-realtime base URL is not an https URL");
      this.teardown(false);
      return Promise.reject(new SpeechStartError("unreachable"));
    }
    const update = openAISessionUpdate(this.options.model, this.prompt);
    const socket = this.options.socket(url, { Authorization: `Bearer ${this.options.apiKey}` });
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const refuse = (reason: SpeechFailure) => {
        if (settled) return;
        settled = true;
        this.teardown(false);
        reject(new SpeechStartError(reason));
      };
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        this.log(`openai-realtime handshake failed: status ${status}`);
        refuse(status === 401 ? "invalid_key" : "unreachable");
      });
      socket.on("error", () => {
        if (!settled) {
          this.log("openai-realtime handshake failed");
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
        try {
          socket.send(update);
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
    this.sendBufferedChunks();
  }

  /** Send every whole chunk buffered so far, once the session is configured. */
  private sendBufferedChunks(): void {
    while (this.configured && !this.finishing && !this.torndown && this.pcmBuffer.length >= OPENAI_BYTES_PER_CHUNK) {
      const chunk = Buffer.from(this.pcmBuffer.subarray(0, OPENAI_BYTES_PER_CHUNK));
      this.pcmBuffer = this.pcmBuffer.subarray(OPENAI_BYTES_PER_CHUNK);
      this.sendAudio(chunk);
    }
  }

  /** Send the remaining audio and the commit, then wait (bounded) for the completed transcript. */
  async finish(): Promise<void> {
    if (this.finishing || this.torndown || !this.listening) return;
    this.finishing = true;
    let remaining = this.pcmBuffer;
    this.pcmBuffer = Buffer.alloc(0);
    // Committing an empty buffer is an error: a session without any audio still sends one chunk of
    // silence first.
    if (!this.audioSent && remaining.length === 0) remaining = Buffer.alloc(OPENAI_BYTES_PER_CHUNK);
    if (remaining.length > 0) this.sendAudio(Buffer.from(remaining));
    if (this.torndown) return;
    this.sendEvent({ type: "input_audio_buffer.commit" });
    if (this.torndown) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.finalWaiter) return;
        this.log(`openai-realtime final transcript timed out, session ${this.sessionId}`);
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

  private sendAudio(pcm: Buffer): void {
    if (this.torndown) return;
    this.sendEvent({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    this.audioSent = true;
  }

  private sendEvent(event: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || this.torndown) return;
    try {
      socket.send(JSON.stringify(event));
    } catch {
      // A failed send means the connection is gone; the close handler reports it.
    }
  }

  private receive(data: Buffer): void {
    if (this.torndown || !this.listening) return;
    let event: { type?: unknown; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString("utf8")) as typeof event;
    } catch {
      this.fail("malformed event");
      return;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.fail("malformed event");
      return;
    }
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const session = event.session as { id?: unknown } | undefined;
        if (session && typeof session.id === "string") this.sessionId = session.id;
        if (event.type === "session.updated" && !this.configured) {
          this.configured = true;
          this.sendBufferedChunks();
        }
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const delta = event.delta;
        if (typeof delta !== "string" || delta.length === 0) return;
        this.draft += delta;
        this.options.onEvent({ kind: "volatile", text: this.draft });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = typeof event.transcript === "string" ? event.transcript : "";
        if (transcript) {
          this.draft = transcript;
          this.options.onEvent({ kind: "finalized", text: transcript });
        }
        // One commit per dictation: its completion is the end of the session.
        this.teardown(true);
        return;
      }
      case "error": {
        // Only the error's type and code: its message may quote request details.
        const error = event.error as { type?: unknown; code?: unknown } | undefined;
        const kind = typeof error?.type === "string" ? error.type : "?";
        const code = typeof error?.code === "string" ? error.code : "?";
        // A wrong key passes the handshake (HTTP 101) and is reported as this event right after it
        // (measured 2026-11-09), never as a 401.
        this.fail(`server error ${kind}/${code}`, code === "invalid_api_key" ? "invalid_key" : "unreachable");
        return;
      }
      default:
        return;
    }
  }

  private connectionLost(): void {
    if (this.torndown) return;
    this.fail("connection lost");
  }

  private fail(reason: string, error: SpeechFailure = "unreachable"): void {
    this.log(`openai-realtime failed: ${reason}, session ${this.sessionId}`);
    this.options.onEvent({ kind: "failed", error });
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
