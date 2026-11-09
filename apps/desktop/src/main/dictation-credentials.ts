import { randomUUID } from "node:crypto";
import {
  create,
  ClientToServerSchema,
  CONTROL_PROTOCOL_VERSION,
  decodeServerToClient,
  encodeClientToServer,
  SpeechProvider,
  type ClientToServerPayload,
} from "@coflux/protocol";

/**
 * Speech credentials for desktop dictation (plan 20261110-desktop-dictation D1/D2).
 *
 * The keys live in the main process only: a short control connection to the centre — authenticated
 * exactly like `accountControl` in desktop-account.ts — asks for the provider slot and, when wanted,
 * the correction record, waits for both answers by request id and closes. Nothing here ever reaches
 * the renderer or a log line; failures are reported as a category only.
 */

export type DictationProviderId = "doubao" | "openai";

/** One credential set with defaults resolved: the full endpoint (or REST base), the model, the key. */
export type DictationCredential = { baseUrl: string; model: string; apiKey: string };

/** The provider defaults an empty stored base URL or model stands for; mirrors the client store's
 * `SPEECH_PROVIDER_DEFAULTS` and the iOS app. */
export const DICTATION_PROVIDER_DEFAULTS: Readonly<Record<DictationProviderId, { baseUrl: string; model: string }>> = {
  doubao: { baseUrl: "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async", model: "volc.seedasr.sauc.duration" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-live-transcribe" },
};

export type DictationCredentialRequest = {
  provider: DictationProviderId;
  /** The slot's `updatedAt` the renderer sees; a different value than the cached one refetches. */
  providerUpdatedAt: number;
  /** Also fetch the correction record. */
  refine: boolean;
  refineUpdatedAt: number;
};

export type DictationCredentialFailure = "not_configured" | "unreachable";

export type DictationCredentialResult =
  | { ok: true; provider: DictationCredential; refine: DictationCredential | null }
  | { ok: false; error: DictationCredentialFailure };

/** What the centre answered for one request: stored values (empty = default) and the key, or an error. */
type Answer = { baseUrl: string; model: string; apiKey: string; error: string };

export type CredentialExchange = (
  serverUrl: string,
  token: string,
  wants: { provider: DictationProviderId | null; refine: boolean },
  timeoutMs: number,
) => Promise<{ provider: Answer | null; refine: Answer | null }>;

/** Connect, authenticate and both answers, together. Generous for a cold TLS handshake, still short
 * enough that a stalled network reports itself while the user is speaking. */
export const DICTATION_CREDENTIALS_TIMEOUT_MS = 8_000;

const PROVIDER_WIRE: Readonly<Record<DictationProviderId, SpeechProvider>> = {
  doubao: SpeechProvider.DOUBAO,
  openai: SpeechProvider.OPENAI,
};

/** One short control connection: `clientAuth`, then `speechCredentialsGet` / `speechRefineCredentialsGet`. */
export const exchangeSpeechCredentials: CredentialExchange = (serverUrl, token, wants, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl);
    socket.binaryType = "arraybuffer";
    const providerRequestId = wants.provider ? `dictation-${randomUUID()}` : "";
    const refineRequestId = wants.refine ? `dictation-refine-${randomUUID()}` : "";
    let provider: Answer | null = null;
    let refine: Answer | null = null;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      if (error) reject(error);
      else resolve({ provider, refine });
    }
    const complete = () => {
      if ((!providerRequestId || provider) && (!refineRequestId || refine)) finish();
    };
    const send = (payload: ClientToServerPayload) => socket.send(encodeClientToServer(create(ClientToServerSchema, { payload })));
    socket.onopen = () => {
      send({ case: "clientAuth", value: { clientToken: token, clientKind: "desktop", clientVersion: "desktop-dictation", controlProtocolVersion: CONTROL_PROTOCOL_VERSION } });
    };
    socket.onerror = () => finish(new Error("unreachable"));
    socket.onclose = () => finish(new Error("closed"));
    socket.onmessage = (event) => {
      try {
        const decoded = decodeServerToClient(new Uint8Array(event.data as ArrayBuffer));
        if (!decoded) return finish(new Error("invalid response"));
        const payload = decoded.payload;
        if (payload.case === "authOk") {
          if (payload.value.controlProtocolVersion < CONTROL_PROTOCOL_VERSION) return finish(new Error("outdated server"));
          if (wants.provider) send({ case: "speechCredentialsGet", value: { requestId: providerRequestId, provider: PROVIDER_WIRE[wants.provider] } });
          if (wants.refine) send({ case: "speechRefineCredentialsGet", value: { requestId: refineRequestId } });
          complete();
        } else if (payload.case === "speechCredentials" && payload.value.requestId === providerRequestId) {
          const value = payload.value;
          provider = { baseUrl: value.baseUrl, model: value.model, apiKey: value.apiKey, error: value.error };
          complete();
        } else if (payload.case === "speechRefineCredentials" && payload.value.requestId === refineRequestId) {
          const value = payload.value;
          refine = { baseUrl: value.baseUrl, model: value.model, apiKey: value.apiKey, error: value.error };
          complete();
        } else if (payload.case === "authError" || payload.case === "clientOutdated" || payload.case === "error") {
          finish(new Error(payload.case));
        }
      } catch {
        finish(new Error("invalid response"));
      }
    };
  });

/** A provider answer with defaults resolved; null when it carries no usable key. */
function providerCredential(provider: DictationProviderId, answer: Answer): DictationCredential | null {
  if (answer.error || !answer.apiKey) return null;
  const defaults = DICTATION_PROVIDER_DEFAULTS[provider];
  return { baseUrl: answer.baseUrl.trim() || defaults.baseUrl, model: answer.model.trim() || defaults.model, apiKey: answer.apiKey };
}

/** The correction record has no defaults: base URL, model and key must all be there. */
function refineCredential(answer: Answer): DictationCredential | null {
  if (answer.error || !answer.apiKey || !answer.baseUrl.trim() || !answer.model.trim()) return null;
  return { baseUrl: answer.baseUrl.trim(), model: answer.model.trim(), apiKey: answer.apiKey };
}

export type DictationCredentials = {
  get: (request: DictationCredentialRequest) => Promise<DictationCredentialResult>;
  /** Forget every cached key (sign-out, token change). */
  clear: () => void;
};

/**
 * The cached credential source. Entries are keyed by what the renderer last saw of the account's
 * configuration: provider + its `updatedAt`, and the correction record's `updatedAt`. Any write to a
 * slot moves its `updatedAt`, so a request carrying a different value than the cached one refetches.
 * A change of session token drops everything: the cache belongs to one sign-in.
 */
export function createDictationCredentials(options: {
  serverUrl: string;
  token: () => string;
  exchange?: CredentialExchange;
  timeoutMs?: number;
  log?: (message: string) => void;
}): DictationCredentials {
  const exchange = options.exchange ?? exchangeSpeechCredentials;
  const timeoutMs = options.timeoutMs ?? DICTATION_CREDENTIALS_TIMEOUT_MS;
  let cacheToken = "";
  const providers = new Map<DictationProviderId, { updatedAt: number; credential: DictationCredential }>();
  let refine: { updatedAt: number; credential: DictationCredential | null } | null = null;

  const clear = () => {
    providers.clear();
    refine = null;
    cacheToken = "";
  };

  async function get(request: DictationCredentialRequest): Promise<DictationCredentialResult> {
    const token = options.token();
    if (!token) {
      clear();
      return { ok: false, error: "unreachable" };
    }
    if (token !== cacheToken) {
      clear();
      cacheToken = token;
    }
    const cachedProvider = providers.get(request.provider);
    const providerHit = cachedProvider && cachedProvider.updatedAt === request.providerUpdatedAt ? cachedProvider.credential : null;
    const refineHit = request.refine && refine && refine.updatedAt === request.refineUpdatedAt ? refine : null;
    const needProvider = !providerHit;
    const needRefine = request.refine && !refineHit;

    let fetched: Awaited<ReturnType<CredentialExchange>> = { provider: null, refine: null };
    if (needProvider || needRefine) {
      try {
        fetched = await exchange(options.serverUrl, token, { provider: needProvider ? request.provider : null, refine: needRefine }, timeoutMs);
      } catch (error) {
        options.log?.(`dictation credentials unavailable: ${error instanceof Error ? error.message : "error"}`);
        return { ok: false, error: "unreachable" };
      }
      // A sign-out or token change while the exchange ran: its answers belong to the old session.
      if (options.token() !== token) return { ok: false, error: "unreachable" };
    }

    let credential = providerHit;
    if (needProvider) {
      const answer = fetched.provider;
      if (!answer) return { ok: false, error: "unreachable" };
      if (answer.error) {
        options.log?.("dictation credentials refused by the centre");
        return { ok: false, error: "unreachable" };
      }
      credential = providerCredential(request.provider, answer);
      if (!credential) return { ok: false, error: "not_configured" };
      providers.set(request.provider, { updatedAt: request.providerUpdatedAt, credential });
    }
    if (!credential) return { ok: false, error: "not_configured" };

    let refineValue: DictationCredential | null = refineHit?.credential ?? null;
    if (needRefine) {
      const answer = fetched.refine;
      refineValue = answer ? refineCredential(answer) : null;
      // An answered record is cached even when unusable (no key): the same `updatedAt` gives the
      // same answer. An error or no answer is not cached.
      if (answer && !answer.error) refine = { updatedAt: request.refineUpdatedAt, credential: refineValue };
    }
    return { ok: true, provider: credential, refine: request.refine ? refineValue : null };
  }

  return { get, clear };
}
