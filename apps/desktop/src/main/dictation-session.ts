import { randomUUID } from "node:crypto";

import type {
  DesktopDictationEvent,
  DesktopDictationRefineContext,
  DesktopDictationStartInput,
  DesktopDictationStartResult,
} from "../shared/desktop-bridge";
import type { DictationCredential, DictationCredentials } from "./dictation-credentials";
import { OpenAIRealtimeTranscriber } from "./dictation-openai";
import { refineDictation, type RefineFetch } from "./dictation-refine";
import { SeedASRTranscriber } from "./dictation-seed";
import { SpeechStartError, type SocketFactory, type SpeechTranscriber, type SpeechTranscriptEvent } from "./dictation-transcriber";

/**
 * The main-process side of one dictation (plan 20261110-desktop-dictation D1/D9), after the iOS
 * `DictationSession` (apps/ios/Coflux/Speech/DictationSession.swift): credentials from the centre,
 * the recogniser of the provider in use, and the correction pass after the final text. The renderer
 * owns the microphone and the context; it sees session ids, text and outcomes, never a key.
 *
 * At most one session exists: a new start cancels the previous one, wherever it is. A recogniser
 * failure is reported with the text recognised so far, so the renderer can treat it as a stop.
 */

/** The recogniser's handshake, bounded so a stalled network reports itself while the user speaks. */
const CONNECT_TIMEOUT_MS = 4_000;
/** The correction request, from the moment the recogniser's final text is available (D14). */
const REFINE_BUDGET_MS = 3_000;

type Session = {
  id: string;
  transcriber: SpeechTranscriber | null;
  started: boolean;
  finishing: boolean;
  failed: boolean;
  refine: DictationCredential | null;
  text: string;
};

export type DictationHost = {
  start: (input: DesktopDictationStartInput) => Promise<DesktopDictationStartResult>;
  audio: (sessionId: string, pcm: Buffer) => void;
  finish: (sessionId: string, refineContext: DesktopDictationRefineContext | null) => void;
  cancel: (sessionId: string) => void;
  /** The window was hidden, closed or its page rebuilt: whatever runs stops, silently. */
  cancelAll: () => void;
};

export function createDictationHost(deps: {
  credentials: DictationCredentials;
  socket: SocketFactory;
  fetch: RefineFetch;
  send: (event: DesktopDictationEvent) => void;
  log?: (message: string) => void;
  connectTimeoutMs?: number;
}): DictationHost {
  let current: Session | null = null;
  const log = deps.log ?? (() => {});

  function drop(session: Session): void {
    if (current === session) current = null;
    session.transcriber?.cancel();
  }

  function cancelAll(): void {
    if (current) drop(current);
  }

  function handle(session: Session, event: SpeechTranscriptEvent): void {
    if (current !== session) return;
    switch (event.kind) {
      case "volatile":
      case "finalized":
        session.text = event.text;
        deps.send({ sessionId: session.id, kind: "text", text: event.text, final: event.kind === "finalized" });
        return;
      case "failed":
        session.failed = true;
        deps.send({ sessionId: session.id, kind: "failed", error: event.error, text: session.text.trim() });
        return;
      case "closed":
        // A close while finishing is the finish path's to report; any other close ends the session.
        if (session.finishing) return;
        current = null;
        deps.send({ sessionId: session.id, kind: "closed" });
        return;
    }
  }

  async function start(input: DesktopDictationStartInput): Promise<DesktopDictationStartResult> {
    cancelAll();
    const session: Session = { id: randomUUID(), transcriber: null, started: false, finishing: false, failed: false, refine: null, text: "" };
    current = session;
    const credentials = await deps.credentials.get({
      provider: input.provider,
      providerUpdatedAt: input.providerUpdatedAt,
      refine: input.refineUpdatedAt !== null,
      refineUpdatedAt: input.refineUpdatedAt ?? 0,
    });
    // Superseded or cancelled while the credentials were on their way.
    if (current !== session) return { ok: false, error: "unreachable" };
    if (!credentials.ok) {
      current = null;
      return { ok: false, error: credentials.error };
    }
    session.refine = credentials.refine;
    const onEvent = (event: SpeechTranscriptEvent) => handle(session, event);
    const transcriber: SpeechTranscriber =
      input.provider === "doubao"
        ? new SeedASRTranscriber({
            apiKey: credentials.provider.apiKey,
            endpoint: credentials.provider.baseUrl,
            resourceId: credentials.provider.model,
            contextItems: input.context.items,
            socket: deps.socket,
            onEvent,
            log,
          })
        : new OpenAIRealtimeTranscriber({
            apiKey: credentials.provider.apiKey,
            baseUrl: credentials.provider.baseUrl,
            model: credentials.provider.model,
            contextItems: input.context.items,
            socket: deps.socket,
            onEvent,
            log,
          });
    session.transcriber = transcriber;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transcriber.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SpeechStartError("unreachable")), deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      transcriber.cancel();
      if (current === session) current = null;
      if (error instanceof SpeechStartError && error.reason === "unreachable") log("dictation recogniser unreachable");
      return { ok: false, error: error instanceof SpeechStartError ? error.reason : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
    if (current !== session) {
      transcriber.cancel();
      return { ok: false, error: "unreachable" };
    }
    session.started = true;
    return { ok: true, sessionId: session.id };
  }

  function audio(sessionId: string, pcm: Buffer): void {
    const session = current;
    if (!session || session.id !== sessionId || !session.started || session.finishing) return;
    session.transcriber?.feed(pcm);
  }

  function finish(sessionId: string, refineContext: DesktopDictationRefineContext | null): void {
    const session = current;
    if (!session || session.id !== sessionId || !session.started || session.finishing) return;
    session.finishing = true;
    void (async () => {
      await session.transcriber?.finish();
      if (current !== session) return;
      // A failure was already reported with its text; the session simply ends.
      if (session.failed) {
        current = null;
        deps.send({ sessionId: session.id, kind: "closed" });
        return;
      }
      const raw = session.text.trim();
      let refined: string | null = null;
      if (refineContext && session.refine && raw) {
        const outcome = await refineDictation({
          raw,
          context: refineContext,
          credentials: session.refine,
          deadline: Date.now() + REFINE_BUDGET_MS,
          fetch: deps.fetch,
          log,
        });
        if (current !== session) return;
        if (outcome.kind === "refined") refined = outcome.text;
      }
      current = null;
      deps.send({ sessionId: session.id, kind: "result", raw, refined });
      deps.send({ sessionId: session.id, kind: "closed" });
    })();
  }

  function cancel(sessionId: string): void {
    if (current?.id === sessionId) drop(current);
  }

  return { start, audio, finish, cancel, cancelAll };
}
