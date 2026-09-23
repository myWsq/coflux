/**
 * Provider sign-in (plan 20260923-oauth-login-redesign): self-hosted Better Auth embedded in the server.
 *
 * Better Auth does the OAuth round trip and account linking, **nothing else**:
 * - Coflux keeps minting its own credentials (`ck_sess` client tokens, `cf_page` page sessions). A
 *   Better Auth session exists only between the provider callback and coflux reading the identity out
 *   of it (`finishSignIn`), which deletes it on the spot. No Better Auth cookie authorises anything.
 * - `emailAndPassword` is off; passwords keep going through `checkCredentials` (scrypt).
 * - One identity store: the create hook decides the `auth_user.id`, and it is always a coflux
 *   `users.id` (existing email → that user; allowlisted new email → a new passwordless user; anything
 *   else refused). Better Auth's tables come from coflux's own migration ledger (version 7), never from
 *   Better Auth's runtime migration.
 * - Linking a second provider bypasses the create hook; it stays safe because GitHub/Google are not in
 *   `trustedProviders` (so linking requires a provider-verified email) and every stored `auth_user`
 *   is verified (the hook refuses unverified emails).
 *
 * Only `/api/auth/callback/<enabled provider>` is reachable from outside; every other Better Auth
 * endpoint answers 404. Sign-in is started server-side by coflux's own page handlers.
 */
import { randomUUID } from "node:crypto";
import { APIError, betterAuth } from "better-auth";
import pg from "pg";
import { createLogger } from "@coflux/core";
import type { OAuthProviderId } from "./config.js";
import { decideProviderSignup, normalizeEmail, parseSignupAllowlist, SIGNUP_REFUSAL, type SignupAllowlist } from "./signup-policy.js";
import type { User } from "./store.js";

const log = createLogger("server");

export const AUTH_BASE_PATH = "/api/auth";
/** Better Auth sessions only live for the handoff; the TTL just bounds one that escaped it. */
const HANDOFF_SESSION_TTL_SECONDS = 10 * 60;

/** The part of Store the create hook needs (structural, so tests can pass the real Store). */
export interface IdentityUserStore {
  getUserByEmail(email: string): Promise<User | undefined>;
  ensurePasswordlessUser(u: { id: string; email: string; createdAt: number }): Promise<User>;
}

export interface ProviderIdentity {
  userId: string;
  email: string;
}

export interface IdentityOptions {
  store: IdentityUserStore;
  databaseUrl: string;
  publicUrl: string;
  secret: string;
  providers: readonly { id: OAuthProviderId; clientId: string; clientSecret: string }[];
  allowlist: string | SignupAllowlist;
  /** Where Better Auth sends failures it cannot attribute to a flow (no parsable state). */
  errorUrl: string;
}

function buildAuth(options: IdentityOptions, pool: pg.Pool) {
  const allowlist = typeof options.allowlist === "string" ? parseSignupAllowlist(options.allowlist) : options.allowlist;
  const credentials = (id: OAuthProviderId) => {
    const provider = options.providers.find((candidate) => candidate.id === id);
    return provider ? { clientId: provider.clientId, clientSecret: provider.clientSecret } : undefined;
  };
  const github = credentials("github");
  const google = credentials("google");
  const socialProviders = { ...(github ? { github } : {}), ...(google ? { google } : {}) };
  return betterAuth({
    appName: "Coflux",
    baseURL: options.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
    database: pool,
    telemetry: { enabled: false },
    trustedOrigins: [new URL(options.publicUrl).origin],
    emailAndPassword: { enabled: false },
    user: { modelName: "auth_user" },
    session: {
      modelName: "auth_session",
      expiresIn: HANDOFF_SESSION_TTL_SECONDS,
      updateAge: HANDOFF_SESSION_TTL_SECONDS,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "auth_account",
      // Linking stays on, but only for a provider-verified email: no provider is trusted blindly, and
      // the stored user must itself be verified (always true here, the create hook guarantees it).
      accountLinking: { enabled: true, trustedProviders: [], requireLocalEmailVerified: true },
    },
    verification: { modelName: "auth_verification" },
    socialProviders,
    advanced: { cookiePrefix: "coflux-auth" },
    onAPIError: { errorURL: options.errorUrl },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            const email = typeof user.email === "string" ? normalizeEmail(user.email) : "";
            const existing = email ? await options.store.getUserByEmail(email) : undefined;
            const decision = decideProviderSignup({ email: user.email, emailVerified: user.emailVerified }, existing?.id, allowlist);
            if (decision.case === "refuse") throw new APIError("FORBIDDEN", { code: decision.code, message: decision.code });
            if (decision.case === "existing") return { data: { ...user, id: decision.userId, email: decision.email } };
            // The coflux row is written first, on coflux's own pool: if the Better Auth insert that follows
            // fails, the next sign-in finds this row by email and reuses it (self-healing, never a second user).
            const created = await options.store.ensurePasswordlessUser({ id: randomUUID(), email: decision.email, createdAt: Date.now() });
            return { data: { ...user, id: created.id, email: created.email } };
          },
        },
      },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof buildAuth>;

export interface Identity {
  /** Enabled providers, in display order. Empty means no provider buttons anywhere. */
  readonly providers: readonly OAuthProviderId[];
  readonly auth: BetterAuthInstance | undefined;
  /** Serve `/api/auth/*`: only the enabled providers' callbacks, 404 for everything else. */
  handle(request: Request): Promise<Response>;
  /** Start a provider sign-in: the provider URL to send the browser to, and Better Auth's state cookie. */
  startSignIn(provider: OAuthProviderId, callbackURL: string, errorCallbackURL: string, headers: Headers): Promise<{ url: string; setCookies: string[] } | undefined>;
  /**
   * Read the identity out of the Better Auth session the callback just created, then end it: the
   * current session is signed out (its clearing cookies are returned for the response) and every other
   * Better Auth session of the user is deleted. Returns no identity when there is no valid session.
   */
  finishSignIn(headers: Headers): Promise<{ identity?: ProviderIdentity; setCookies: string[] }>;
  close(): Promise<void>;
}

const NOT_FOUND = () => Response.json({ ok: false, error: "未知的端点" }, { status: 404, headers: { "Cache-Control": "no-store" } });

/** No provider enabled (local mode, or no credentials configured): no Better Auth instance at all. */
export function disabledIdentity(): Identity {
  return {
    providers: [],
    auth: undefined,
    handle: async () => NOT_FOUND(),
    startSignIn: async () => undefined,
    finishSignIn: async () => ({ setCookies: [] }),
    close: async () => undefined,
  };
}

export function createIdentity(options: IdentityOptions): Identity {
  const providers = options.providers.map((provider) => provider.id);
  if (providers.length === 0) return disabledIdentity();
  // Better Auth does not take the postgres.js client coflux uses; it gets its own small pg pool pinned
  // to coflux's schema. Its tables are created by coflux's migration ledger before this pool is used.
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 3, options: "-c search_path=coflux" });
  const auth = buildAuth(options, pool);
  const publicOriginPrefix = `${new URL(options.publicUrl).origin}/`;
  const callbackPaths = new Set(providers.map((provider) => `${AUTH_BASE_PATH}/callback/${provider}`));

  return {
    providers,
    auth,
    async handle(request) {
      const { pathname } = new URL(request.url);
      if ((request.method !== "GET" && request.method !== "POST") || !callbackPaths.has(pathname)) return NOT_FOUND();
      return auth.handler(request);
    },
    // Better Auth's trustedOrigins check of callbackURL/errorCallbackURL does NOT run for a server-side
    // `auth.api` call (its origin-check middleware returns early without a Request). Callers must build
    // both URLs from the public origin and a fixed per-flow path — never from anything the browser sent.
    async startSignIn(provider, callbackURL, errorCallbackURL, headers) {
      if (!providers.includes(provider)) return undefined;
      // The one place that enforces it: both return URLs stay on the public origin (no open redirect).
      if (!callbackURL.startsWith(publicOriginPrefix) || !errorCallbackURL.startsWith(publicOriginPrefix)) return undefined;
      const result = await auth.api.signInSocial({
        body: { provider, callbackURL, errorCallbackURL, newUserCallbackURL: callbackURL, disableRedirect: true },
        headers,
        returnHeaders: true,
      });
      const url = result.response?.url;
      if (typeof url !== "string" || !url) return undefined;
      return { url, setCookies: result.headers.getSetCookie() };
    },
    async finishSignIn(headers) {
      const session = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
      if (!session) return { setCookies: [] };
      let setCookies: string[] = [];
      try {
        const signedOut = await auth.api.signOut({ headers, returnHeaders: true });
        setCookies = signedOut.headers.getSetCookie();
      } catch (error) {
        // The rows are deleted below either way; only the cookie clearing is lost, and that cookie
        // points at a session that no longer exists.
        log.warn("Better Auth sign-out at handoff failed", { error: String(error) });
      }
      // Whatever signOut did, no Better Auth session of this user outlives the handoff.
      const context = await auth.$context;
      await context.internalAdapter.deleteUserSessions(session.user.id);
      // Every stored auth_user is verified (the create hook refuses otherwise); refuse again if not.
      if (session.user.emailVerified !== true || typeof session.user.email !== "string") return { setCookies };
      return { identity: { userId: session.user.id, email: normalizeEmail(session.user.email) }, setCookies };
    },
    async close() {
      await pool.end().catch(() => undefined);
    },
  };
}

/** Error codes a flow page may receive as `?error=<code>`, mapped to fixed copy. Unknown codes fall back
 * to a generic sentence; `error_description` is never shown (anyone can craft that URL). */
export function providerErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case SIGNUP_REFUSAL.emailNotAllowed:
      return "该邮箱未开通 Coflux";
    case SIGNUP_REFUSAL.emailNotVerified:
    case "email_not_found":
    case "account_not_linked":
    case "unable_to_link_account":
      return "该账号的邮箱未经验证，无法登录";
    case "access_denied":
      return "已取消登录";
    default:
      return "登录未完成，请重试";
  }
}

/** The same mapping as a stable short code for native clients (loopback `error=` / exchange replies). */
export function providerErrorKind(code: string | null | undefined): "not_allowed" | "not_verified" | "cancelled" | "failed" {
  switch (code) {
    case SIGNUP_REFUSAL.emailNotAllowed:
      return "not_allowed";
    case SIGNUP_REFUSAL.emailNotVerified:
    case "email_not_found":
    case "account_not_linked":
    case "unable_to_link_account":
      return "not_verified";
    case "access_denied":
      return "cancelled";
    default:
      return "failed";
  }
}
