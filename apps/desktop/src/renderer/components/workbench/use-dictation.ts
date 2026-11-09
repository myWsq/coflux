import { useEffect, useRef, useState, type RefObject } from "react";

import type { DesktopDictationEvent, DesktopDictationProvider, DesktopDictationRefineContext } from "../../../shared/desktop-bridge";
import { desktop } from "@/config";
import { startDictationCapture, type DictationCapture } from "./dictation-capture";
import { createDictationContextSource, type DictationContextSource, type DictationReading } from "./dictation-context";
import type { TranscriptAgent, TranscriptExec } from "./terminal-transcript";

/**
 * One terminal pane's dictation (plan 20261110-desktop-dictation), after the iOS `DictationSession`:
 *
 *   idle → connecting → listening → finishing → (correcting) → confirm → idle, plus error.
 *
 * Start checks the microphone permission, opens the microphone at once (chunks are buffered),
 * gathers the recognition context in parallel for at most 1.2 s, then asks main for a session and
 * streams. Stop reads the correction context (at most 0.8 s) and asks main to finish; the result
 * opens the confirm state. Main holds the keys, the recogniser and the correction request.
 *
 * One dictation at a time across the window (D9): starting in another pane cancels this one.
 */

/** What the pane knows about the account's dictation configuration; null = no button. */
export type DictationSetup = {
  provider: DesktopDictationProvider;
  providerUpdatedAt: number;
  /** The correction record's `updatedAt` when the correction is usable; null = recogniser only. */
  refineUpdatedAt: number | null;
  workspaceSentence: string | null;
};

export type DictationPhase = "idle" | "connecting" | "listening" | "finishing" | "correcting" | "confirm" | "error";

/** `unreachable` shows 「连接失败」 for a moment; the other two stay with their action. */
export type DictationError = "unreachable" | "invalid_key" | "microphone";

export type DictationConfirm = { raw: string; refined: string | null; showingOriginal: boolean };

/** A level the button reads without re-rendering the pane at audio rate. */
export type DictationLevel = { get: () => number; subscribe: (listener: (level: number) => void) => () => void };

export type DictationPaneActions = {
  deliver: (text: string, submit: boolean) => void;
  done: () => void;
};

export type DictationController = {
  available: boolean;
  phase: DictationPhase;
  /** The recogniser's full text so far. */
  text: string;
  error: DictationError | null;
  confirm: DictationConfirm | null;
  /** The text the confirm state delivers: the shown version, as edited. */
  draft: () => string;
  setDraft: (text: string) => void;
  level: DictationLevel;
  canDeliver: boolean;
  /** The bubble or the button is showing anything (Esc belongs to it). */
  active: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  cancel: () => void;
  send: () => void;
  insert: () => void;
  toggleOriginal: () => void;
  /** The shortcut went down / up (keyboard press-and-hold support). */
  pressDown: () => void;
  pressUp: () => void;
};

/** The whole context wait from the start of a dictation. */
const CONTEXT_DEADLINE_MS = 1200;
/** The correction context's wait after the stop. */
const REFINE_CONTEXT_WAIT_MS = 800;
/** How long 「连接失败」 stays. */
const UNREACHABLE_NOTICE_MS = 2000;
/** A press held longer than this, which started listening, stops on release. */
const HOLD_MS = 500;
/** Audio buffered while the session is being set up: about 9.4 s at 16 kHz, scaled by rate. */
const PENDING_CAP_BYTES_16K = 300 * 1024;

const SAMPLE_RATES: Readonly<Record<DesktopDictationProvider, number>> = { doubao: 16000, openai: 24000 };

/** The pane whose dictation is running or showing; a start elsewhere cancels it. */
let activeOwner: { cancel: () => void } | null = null;

function createLevel(): DictationLevel & { set: (value: number) => void } {
  let value = 0;
  const listeners = new Set<(level: number) => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The promise's value, or undefined once `deadline` (performance.now clock) passes. */
function within<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
  const wait = deadline - performance.now();
  if (wait <= 0) return Promise.race([promise, Promise.resolve(undefined)]);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(undefined), wait);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export function useDictation(options: {
  setup: DictationSetup | null;
  workspaceId: string;
  agent: TranscriptAgent | null;
  agentSessionId: string | null;
  exec: TranscriptExec;
  visible: boolean;
  canDeliver: boolean;
  /** The pane's side, set by the pane outside render: paste the text (`submit` follows it with
   * Enter), and give the keyboard back to the terminal once a dictation ended. */
  pane: RefObject<DictationPaneActions | null>;
}): DictationController {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<DictationError | null>(null);
  const [confirm, setConfirm] = useState<DictationConfirm | null>(null);
  const [level] = useState(createLevel);

  const live = useRef<typeof options | null>(null);
  useEffect(() => {
    live.current = options;
  });

  // Session machinery: refs, so the async steps read the current values.
  const m = useRef({
    generation: 0,
    phase: "idle" as DictationPhase,
    sessionId: null as string | null,
    capture: null as DictationCapture | null,
    pending: [] as ArrayBuffer[],
    pendingBytes: 0,
    pendingCap: PENDING_CAP_BYTES_16K,
    stopRequested: false,
    finishSent: false,
    refineUsed: false,
    source: null as DictationContextSource | null,
    reading: null as DictationReading | null,
    repositoryTerms: null as string[] | null,
    text: "",
    draft: "",
    press: null as { at: number; started: boolean } | null,
    noticeTimer: 0,
  });
  // The subscription, the effects below and other panes reach this pane through the latest
  // handlers (set in an effect once they are defined); the reset they run releases the microphone
  // (an external system), never just state. `owner` is this pane's entry in the one-dictation-at-a-
  // time registry (D9).
  const latest = useRef<{ reset: () => void; onEvent: (event: DesktopDictationEvent) => void } | null>(null);
  const [owner] = useState(() => ({ cancel: () => latest.current?.reset() }));

  const go = (next: DictationPhase) => {
    m.current.phase = next;
    setPhase(next);
  };

  const release = () => {
    if (activeOwner === owner) activeOwner = null;
  };

  const clearNotice = () => {
    if (m.current.noticeTimer) window.clearTimeout(m.current.noticeTimer);
    m.current.noticeTimer = 0;
  };

  /** Stop the microphone and keep the handle: a later stop returns the same (flushing) promise. */
  const stopCapture = (flush: boolean): Promise<void> => {
    const capture = m.current.capture;
    return capture ? capture.stop(flush) : Promise.resolve();
  };

  /** Stop the microphone without delivering anything more, and forget it. */
  const discardCapture = () => {
    const capture = m.current.capture;
    m.current.capture = null;
    void capture?.stop(false);
  };

  /** Back to idle, dropping everything; the session in main (if any) is cancelled. */
  const reset = () => {
    const state = m.current;
    state.generation += 1;
    const sessionId = state.sessionId;
    state.sessionId = null;
    if (sessionId) desktop.dictationCancel(sessionId);
    discardCapture();
    state.pending = [];
    state.pendingBytes = 0;
    state.stopRequested = false;
    state.finishSent = false;
    state.source = null;
    state.text = "";
    state.draft = "";
    state.press = null;
    clearNotice();
    setText("");
    setError(null);
    setConfirm(null);
    level.set(0);
    go("idle");
    release();
  };

  const fail = (reason: DictationError) => {
    const state = m.current;
    state.generation += 1;
    const sessionId = state.sessionId;
    state.sessionId = null;
    if (sessionId) desktop.dictationCancel(sessionId);
    discardCapture();
    state.pending = [];
    state.pendingBytes = 0;
    state.press = null;
    level.set(0);
    setText("");
    setConfirm(null);
    setError(reason);
    go("error");
    clearNotice();
    if (reason === "unreachable") {
      const generation = state.generation;
      state.noticeTimer = window.setTimeout(() => {
        state.noticeTimer = 0;
        if (m.current.generation === generation && m.current.phase === "error") reset();
      }, UNREACHABLE_NOTICE_MS);
    }
  };

  const enterConfirm = (raw: string, refined: string | null) => {
    const state = m.current;
    state.sessionId = null;
    discardCapture();
    state.draft = refined ?? raw;
    level.set(0);
    setConfirm({ raw, refined, showingOriginal: false });
    go("confirm");
  };

  const onChunk = (generation: number, pcm: ArrayBuffer) => {
    const state = m.current;
    if (state.generation !== generation || state.finishSent) return;
    if (state.sessionId) {
      desktop.dictationAudio(state.sessionId, pcm);
      return;
    }
    state.pending.push(pcm);
    state.pendingBytes += pcm.byteLength;
    while (state.pendingBytes > state.pendingCap && state.pending.length > 0) state.pendingBytes -= state.pending.shift()!.byteLength;
  };

  /** Stop feeding and ask main for the final text (and the correction). */
  const finishSession = async (generation: number) => {
    const state = m.current;
    const source = state.source;
    // The correction context read starts at the stop and gets at most 0.8 s.
    const correction = state.refineUsed && source ? source.readTranscript("correction") : null;
    const waitEnd = performance.now() + REFINE_CONTEXT_WAIT_MS;
    await stopCapture(true);
    if (state.generation !== generation || !state.sessionId) return;
    let refineContext: DesktopDictationRefineContext | null = null;
    if (correction && source) {
      const reading = (await within(correction, waitEnd)) ?? null;
      if (state.generation !== generation || !state.sessionId) return;
      refineContext = source.refineContext(reading ?? state.reading, state.repositoryTerms);
    }
    state.finishSent = true;
    desktop.dictationFinish(state.sessionId, refineContext);
  };

  const start = () => {
    const opts = live.current;
    const setup = opts?.setup;
    const state = m.current;
    if (!opts || !setup || !opts.visible) return;
    if (state.phase === "connecting" || state.phase === "listening" || state.phase === "finishing" || state.phase === "correcting") return;
    if (activeOwner && activeOwner !== owner) activeOwner.cancel();
    activeOwner = owner;
    reset();
    activeOwner = owner;
    const generation = state.generation;
    const startedAt = performance.now();
    const provider = setup.provider;
    state.refineUsed = setup.refineUpdatedAt !== null;
    state.pendingCap = Math.round((PENDING_CAP_BYTES_16K * SAMPLE_RATES[provider]) / 16000);
    const source = createDictationContextSource({
      exec: opts.exec,
      workspaceId: opts.workspaceId,
      workspaceSentence: setup.workspaceSentence,
      agent: opts.agent,
      agentSessionId: opts.agentSessionId,
    });
    state.source = source;
    state.reading = null;
    state.repositoryTerms = null;
    go("connecting");

    const recognitionRead = source.readTranscript("recognition").then((reading) => {
      if (m.current.generation === generation) m.current.reading = reading;
      return reading;
    });
    const repositoryRead = source.readRepositoryTerms().then((terms) => {
      if (m.current.generation === generation) m.current.repositoryTerms = terms;
      return terms;
    });

    void (async () => {
      const access = await desktop.microphoneAccess();
      if (state.generation !== generation) return;
      if (access !== "granted") return fail("microphone");
      // Stopped before the microphone was even open: nothing was said.
      if (state.stopRequested) return reset();
      let capture: DictationCapture;
      try {
        capture = await startDictationCapture({
          sampleRate: SAMPLE_RATES[provider],
          onChunk: (pcm) => onChunk(generation, pcm),
          onLevel: (value) => {
            if (m.current.generation === generation) level.set(value);
          },
        });
      } catch (cause) {
        if (state.generation !== generation) return;
        return fail(cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError") ? "microphone" : "unreachable");
      }
      if (state.generation !== generation) {
        void capture.stop(false);
        return;
      }
      state.capture = capture;
      // Stopped while the microphone opened: what was captured so far still goes out.
      const flushing = state.stopRequested ? stopCapture(true) : Promise.resolve();

      const deadline = startedAt + CONTEXT_DEADLINE_MS;
      const reading = (await within(recognitionRead, deadline)) ?? null;
      const terms = (await within(repositoryRead, deadline)) ?? null;
      if (state.generation !== generation) return;
      const context = source.recognitionContext(reading ?? state.reading, terms ?? state.repositoryTerms);
      const result = await desktop.dictationStart({
        provider,
        providerUpdatedAt: setup.providerUpdatedAt,
        refineUpdatedAt: setup.refineUpdatedAt,
        context,
      });
      if (state.generation !== generation) {
        if (result.ok) desktop.dictationCancel(result.sessionId);
        return;
      }
      if (!result.ok) return fail(result.error === "unreachable" ? "unreachable" : "invalid_key");
      // The buffered audio goes first, in the same turn: from here on chunks are sent as they come.
      state.sessionId = result.sessionId;
      for (const chunk of state.pending) desktop.dictationAudio(result.sessionId, chunk);
      state.pending = [];
      state.pendingBytes = 0;
      await flushing;
      if (state.generation !== generation) return;
      if (state.stopRequested) void finishSession(generation);
      else go("listening");
    })();
  };

  const stop = () => {
    const state = m.current;
    if (state.phase === "connecting") {
      state.stopRequested = true;
      go("finishing");
      // The microphone is open already: stop it now, buffered audio goes out once connected.
      if (state.capture) void stopCapture(true);
      return;
    }
    if (state.phase !== "listening") return;
    go("finishing");
    void finishSession(state.generation);
  };

  const done = () => live.current?.pane.current?.done();

  const deliver = (submit: boolean) => {
    const opts = live.current;
    const pane = opts?.pane.current;
    const value = m.current.draft.trim();
    if (m.current.phase !== "confirm" || !value || !opts?.canDeliver || !pane) return;
    pane.deliver(value, submit);
    reset();
    pane.done();
  };

  /** Events from main for this pane's session. */
  const onEvent = (event: DesktopDictationEvent) => {
    const state = m.current;
    if (!state.sessionId || event.sessionId !== state.sessionId) return;
    switch (event.kind) {
      case "text":
        state.text = event.text;
        setText(event.text);
        if (event.final && state.finishSent && state.refineUsed && state.phase === "finishing") go("correcting");
        return;
      case "result":
        if (!event.raw) {
          reset();
          done();
        } else enterConfirm(event.raw, event.refined);
        return;
      case "failed": {
        // A failure after text exists is a stop: the text is kept for the confirm state.
        const recognised = event.text.trim() || state.text.trim();
        if (recognised) enterConfirm(recognised, null);
        else fail(event.error === "invalid_key" ? "invalid_key" : "unreachable");
        return;
      }
      case "closed": {
        // Closed without a result or a failure (main cancelled it): keep what was recognised.
        const recognised = state.text.trim();
        if (recognised) enterConfirm(recognised, null);
        else {
          reset();
          done();
        }
        return;
      }
    }
  };

  useEffect(() => {
    latest.current = { reset, onEvent };
  });

  useEffect(() => {
    const handlers = latest;
    return desktop.onDictationEvent((event) => handlers.current?.onEvent(event));
  }, []);

  // Hidden (another tab) while recording, configuration gone, or unmounted: the microphone is
  // released. A confirm state or an error line survives a tab switch.
  const visible = options.visible;
  const available = options.setup !== null;
  useEffect(() => {
    const current = m.current.phase;
    if (!available && current !== "idle") latest.current?.reset();
    else if (!visible && current !== "idle" && current !== "confirm" && current !== "error") latest.current?.reset();
  }, [visible, available]);
  useEffect(() => {
    const state = m.current;
    const handlers = latest;
    return () => {
      if (state.phase !== "idle") handlers.current?.reset();
    };
  }, []);

  const toggle = () => {
    const current = m.current.phase;
    if (current === "connecting" || current === "listening") stop();
    // A click on the button in the confirm state dictates again, replacing the unsent text.
    else if (current === "idle" || current === "error" || current === "confirm") start();
  };

  return {
    available,
    phase,
    text,
    error,
    confirm,
    draft: () => m.current.draft,
    setDraft: (value) => {
      m.current.draft = value;
    },
    level,
    canDeliver: options.canDeliver,
    active: phase !== "idle",
    start,
    stop,
    toggle,
    cancel: () => {
      if (m.current.phase === "idle") return;
      reset();
      done();
    },
    send: () => deliver(true),
    insert: () => deliver(false),
    toggleOriginal: () => {
      const state = m.current;
      if (state.phase !== "confirm" || !confirm || confirm.refined === null) return;
      // Switching shows that version afresh: edits made to the other one are dropped.
      const showingOriginal = !confirm.showingOriginal;
      state.draft = showingOriginal ? confirm.raw : confirm.refined;
      setConfirm({ ...confirm, showingOriginal });
    },
    pressDown: () => {
      const state = m.current;
      const current = state.phase;
      if (current === "idle" || current === "error") {
        start();
        state.press = { at: performance.now(), started: m.current.phase === "connecting" };
      } else if (current === "connecting" || current === "listening") {
        state.press = null;
        stop();
      }
    },
    pressUp: () => {
      const state = m.current;
      const press = state.press;
      state.press = null;
      if (press?.started && performance.now() - press.at > HOLD_MS) stop();
    },
  };
}
