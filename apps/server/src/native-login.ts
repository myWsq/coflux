/**
 * Native login requests (plan 20260923-oauth-login-redesign): how the desktop app and `coflux login`
 * obtain a `ck_sess` token through the browser — RFC 8252 loopback redirect with PKCE (S256), plus a
 * paste-code fallback for a CLI whose browser cannot reach back (SSH).
 *
 *   client ── register(kind, host, loopback port | paste, code_challenge, state) ──► request id + page URL
 *   browser ── /login/<id>: sign in (provider or password) → confirmation card → 「允许登录」
 *           ── approve: one-time code → 303 to http://127.0.0.1:<registered port>/callback  (or shown for paste)
 *   client ── exchange(code, code_verifier) ──► ck_sess (exactly once)
 *
 * Why this shape: the loopback target is only ever the port recorded at registration (never a URL from
 * the browser), so a phished victim's browser is redirected to the victim's own machine; the code is
 * bound to the requester's `code_verifier`, so a leaked or pasted code is useless to anyone else.
 *
 * In memory with the device-authorization TTL, a global cap (full = fail closed, never evict a live
 * request) and one-time consumption — the same shape as `pendingAuthorizations` (docs/OPEN_QUESTIONS.md
 * B7: single-instance memory state). Pure except for time and randomness, both injectable for tests.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountId } from "@coflux/protocol";
import { genToken } from "./secrets.js";

export type NativeClientKind = "desktop" | "cli";
export type NativeRedirect = { kind: "loopback"; port: number } | { kind: "paste" };

/** Stable failure kinds a native client maps to its own copy. */
export type NativeLoginFailure = "not_allowed" | "not_verified" | "cancelled" | "failed";

export interface NativeLoginRegistration {
  clientKind: NativeClientKind;
  /** Self-reported by the requester; shown on the confirmation card as such. */
  host: string;
  redirect: NativeRedirect;
  codeChallenge: string;
  /** Opaque client value echoed on the loopback redirect so the listener can drop stray hits. */
  state: string;
}

export interface NativeLoginGrant {
  accountId: AccountId;
  userId: string | null;
  /** What the client prints: "已登录为 <login>". */
  login: string;
}

export interface NativeLoginView {
  id: string;
  clientKind: NativeClientKind;
  host: string;
  redirect: NativeRedirect["kind"];
  expiresAt: number;
}

interface NativeLoginRequest extends NativeLoginRegistration {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved";
  /** sha256 of the one-time code, set on approval. */
  codeHash?: string;
  grant?: NativeLoginGrant;
}

export type RegisterResult = { ok: true; id: string; expiresAt: number } | { ok: false; error: "invalid" | "full" };

/** The browser's next step after approval or refusal. `location` is always built here, from the port
 * recorded at registration; `code` is what a paste-mode page shows. */
export type NativeLoginOutcome = { kind: "loopback"; location: string } | { kind: "paste"; code: string };

const MAX_HOST_CHARS = 253;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 5;
const CODE_GROUP_LENGTH = 4;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** One-time codes are typed by people in paste mode: unambiguous letters, grouped, case-insensitive. */
export function normalizeLoginCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

function newCode(random: (size: number) => Buffer): string {
  const bytes = random(CODE_GROUPS * CODE_GROUP_LENGTH);
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    if (index > 0 && index % CODE_GROUP_LENGTH === 0) out += "-";
    out += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return out;
}

function validHost(host: string): boolean {
  // eslint-disable-next-line no-control-regex
  return host.length > 0 && host.length <= MAX_HOST_CHARS && !/[\u0000-\u001f\u007f]/.test(host);
}

export function validRegistration(input: NativeLoginRegistration): boolean {
  if (input.clientKind !== "desktop" && input.clientKind !== "cli") return false;
  if (!validHost(input.host.trim())) return false;
  if (!S256_CHALLENGE.test(input.codeChallenge) || !STATE.test(input.state)) return false;
  if (input.redirect.kind === "loopback") return Number.isInteger(input.redirect.port) && input.redirect.port >= 1024 && input.redirect.port <= 65535;
  return input.redirect.kind === "paste";
}

function loopbackLocation(port: number, params: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${port}/callback`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export class NativeLoginStore {
  private readonly requests = new Map<string, NativeLoginRequest>();
  private readonly byCode = new Map<string, string>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxRequests: number,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("native login TTL must be positive");
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("native login capacity must be a positive integer");
  }

  get size(): number {
    return this.requests.size;
  }

  register(input: NativeLoginRegistration, now = Date.now()): RegisterResult {
    if (!validRegistration(input)) return { ok: false, error: "invalid" };
    this.sweep(now);
    if (this.requests.size >= this.maxRequests) return { ok: false, error: "full" };
    const id = genToken("cf_login");
    const request: NativeLoginRequest = {
      id,
      clientKind: input.clientKind,
      host: input.host.trim(),
      redirect: input.redirect.kind === "loopback" ? { kind: "loopback", port: input.redirect.port } : { kind: "paste" },
      codeChallenge: input.codeChallenge,
      state: input.state,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: "pending",
    };
    this.requests.set(id, request);
    return { ok: true, id, expiresAt: request.expiresAt };
  }

  /** A request still waiting for the browser; approved, expired or unknown requests are not shown. */
  describe(id: string, now = Date.now()): NativeLoginView | undefined {
    const request = this.live(id, now);
    if (!request || request.status !== "pending") return undefined;
    return { id: request.id, clientKind: request.clientKind, host: request.host, redirect: request.redirect.kind, expiresAt: request.expiresAt };
  }

  /** 「允许登录」: bind the identity, mint the one-time code, and say where the browser goes next. */
  approve(id: string, grant: NativeLoginGrant, now = Date.now()): NativeLoginOutcome | undefined {
    const request = this.live(id, now);
    if (!request || request.status !== "pending") return undefined;
    const code = newCode(this.random);
    const codeHash = hashCode(normalizeLoginCode(code));
    request.status = "approved";
    request.grant = { ...grant };
    request.codeHash = codeHash;
    this.byCode.set(codeHash, request.id);
    if (request.redirect.kind === "paste") return { kind: "paste", code };
    return { kind: "loopback", location: loopbackLocation(request.redirect.port, { code, state: request.state }) };
  }

  /** The browser side ended without a login (refused email, cancelled, provider failure). A loopback
   * request is consumed and its client told why; a paste request stays so the user can try again. */
  fail(id: string, failure: NativeLoginFailure, now = Date.now()): { kind: "loopback"; location: string } | undefined {
    const request = this.live(id, now);
    if (!request || request.status !== "pending" || request.redirect.kind !== "loopback") return undefined;
    this.remove(request);
    return { kind: "loopback", location: loopbackLocation(request.redirect.port, { error: failure, state: request.state }) };
  }

  /** 「取消」on the confirmation card: the request ends whatever its redirect; a loopback client is told. */
  cancel(id: string, now = Date.now()): { kind: "loopback"; location: string } | { kind: "paste" } | undefined {
    const request = this.live(id, now);
    if (!request || request.status !== "pending") return undefined;
    this.remove(request);
    if (request.redirect.kind === "paste") return { kind: "paste" };
    return { kind: "loopback", location: loopbackLocation(request.redirect.port, { error: "cancelled", state: request.state }) };
  }

  /**
   * Trade code + verifier for the grant, exactly once. The request is removed before the verifier is
   * checked, so a wrong verifier burns the code too: a code is worth one attempt, never a guessing oracle.
   */
  exchange(rawCode: string, verifier: string, now = Date.now()): NativeLoginGrant | undefined {
    if (typeof rawCode !== "string" || typeof verifier !== "string") return undefined;
    const code = normalizeLoginCode(rawCode);
    if (code.length !== CODE_GROUPS * CODE_GROUP_LENGTH) return undefined;
    const codeHash = hashCode(code);
    const id = this.byCode.get(codeHash);
    if (!id) return undefined;
    const request = this.requests.get(id);
    this.byCode.delete(codeHash);
    if (!request) return undefined;
    this.remove(request);
    if (request.expiresAt <= now || request.status !== "approved" || !request.grant) return undefined;
    if (!VERIFIER.test(verifier)) return undefined;
    const expected = Buffer.from(request.codeChallenge, "utf8");
    const actual = Buffer.from(s256(verifier), "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    return request.grant;
  }

  private live(id: string, now: number): NativeLoginRequest | undefined {
    const request = this.requests.get(id);
    if (!request) return undefined;
    if (request.expiresAt <= now) {
      this.remove(request);
      return undefined;
    }
    return request;
  }

  private remove(request: NativeLoginRequest): void {
    this.requests.delete(request.id);
    if (request.codeHash) this.byCode.delete(request.codeHash);
  }

  private sweep(now: number): void {
    for (const request of this.requests.values()) if (request.expiresAt <= now) this.remove(request);
  }
}
