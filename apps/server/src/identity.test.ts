import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

import { hashPassword, verifyStoredPassword } from "./auth.js";
import { createIdentity, type Identity } from "./identity.js";
import { Store } from "./store.js";

/**
 * The single-identity contract on real Postgres (plan 20260923-oauth-login-redesign):
 * - the Better Auth create hook chooses `auth_user.id`, and it is the coflux `users.id` — for an
 *   existing email and for an allowlisted new one;
 * - unknown and unverified emails are refused before anything is written;
 * - no Better Auth session survives the handoff.
 *
 * Automated because each break is silent while using the product: a second id for the same person,
 * an account takeover through linking, or a Better Auth cookie that quietly keeps working.
 *
 * Uses a temporary database on COFLUX_TEST_PG_URL (default: the local dev Postgres) and skips cleanly
 * when no Postgres is reachable.
 */

const BASE_URL = process.env.COFLUX_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SECRET = randomBytes(32).toString("hex");
const DB_NAME = `coflux_identity_test_${process.pid}_${randomBytes(3).toString("hex")}`;

let admin: postgres.Sql | undefined;
let store: Store | undefined;
let identity: Identity | undefined;
let raw: postgres.Sql | undefined;
let unavailable = "";

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

before(async () => {
  try {
    admin = postgres(BASE_URL, { max: 1, connect_timeout: 3, onnotice: () => undefined });
    await admin`SELECT 1`;
  } catch (error) {
    unavailable = `Postgres not reachable at COFLUX_TEST_PG_URL (${String(error)})`;
    await admin?.end({ timeout: 0 }).catch(() => undefined);
    admin = undefined;
    return;
  }
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const url = databaseUrl(DB_NAME);
  store = await Store.connect(url);
  raw = postgres(url, { max: 1, onnotice: () => undefined, connection: { search_path: "coflux" } });
  identity = createIdentity({
    store,
    databaseUrl: url,
    publicUrl: "http://127.0.0.1:8787",
    secret: SECRET,
    providers: [{ id: "github", clientId: "test-client", clientSecret: "test-secret" }],
    allowlist: "@invited.dev",
    errorUrl: "http://127.0.0.1:8787/login-error",
  });
});

after(async () => {
  await identity?.close();
  await raw?.end({ timeout: 0 }).catch(() => undefined);
  await store?.close().catch(() => undefined);
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined);
    await admin.end({ timeout: 0 }).catch(() => undefined);
  }
});

const oauthSource = { method: "oauth", oauth: { providerId: "github" } } as const;

async function authContext() {
  assert.ok(identity?.auth, "identity must be enabled in this test");
  return identity.auth.$context;
}

async function signedSessionCookie(userId: string): Promise<string> {
  const context = await authContext();
  const session = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", SECRET).update(session.token).digest("base64");
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
}

/** Plain SQL against the test database (schema `coflux` on the search path). */
async function query(text: string, params: string[] = []): Promise<Record<string, unknown>[]> {
  assert.ok(raw);
  return [...(await raw.unsafe(text, params))] as Record<string, unknown>[];
}

async function count(text: string, params: string[] = []): Promise<number> {
  const rows = await query(`SELECT count(*)::int AS count FROM ${text}`, params);
  return Number(rows[0]?.count);
}

async function sessionCount(userId: string): Promise<number> {
  return count(`auth_session WHERE "userId" = $1`, [userId]);
}

test("existing email: auth_user.id is the existing coflux users.id", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const existing = await store!.upsertUser({ id: "legacy-user-id", email: "owner@example.com", passwordHash: await hashPassword("pw"), createdAt: Date.now() });
  const context = await authContext();
  const created = await context.internalAdapter.createUser({ name: "", email: "Owner@Example.com", emailVerified: true }, oauthSource);
  assert.equal(created.id, existing.id);
  const rows = await query(`SELECT id FROM auth_user WHERE email = 'owner@example.com'`);
  assert.deepEqual(rows.map((row) => row.id), [existing.id]);
  assert.equal(await count(`users WHERE email = 'owner@example.com'`), 1, "no second coflux user for the same email");
});

test("allowlisted new email: a passwordless coflux user is created and auth_user.id equals its id", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const context = await authContext();
  const created = await context.internalAdapter.createUser({ name: "", email: "New@Invited.dev", emailVerified: true }, oauthSource);
  const user = await store!.getUserByEmail("new@invited.dev");
  assert.ok(user, "the coflux users row exists");
  assert.equal(created.id, user.id);
  assert.equal(user.passwordHash, null);
  const rows = await query(`SELECT id FROM auth_user WHERE email = 'new@invited.dev'`);
  assert.deepEqual(rows.map((row) => row.id), [user.id]);
  for (const typed of ["", "anything"]) assert.equal(await verifyStoredPassword(typed, user.passwordHash), false);
});

test("an allowlisted new user gets a personal account through the existing lazy path", async (t) => {
  if (unavailable) return t.skip(unavailable);
  process.env.COFLUX_DEV = "1";
  const { Hub } = await import("./hub.js");
  const hub = new Hub(store!);
  try {
    const user = await store!.getUserByEmail("new@invited.dev");
    assert.ok(user);
    const accountId = await hub.accountForProviderIdentity({ userId: user.id, email: user.email });
    assert.equal(await hub.accountForProviderIdentity({ userId: user.id, email: user.email }), accountId, "the second sign-in lands on the same account");
    const membership = await store!.getMembershipByUser(user.id);
    assert.equal(membership?.accountId, accountId);
  } finally {
    hub.shutdown();
  }
});

test("unknown and unverified emails are refused before anything is written", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const context = await authContext();
  const refusals: [string, boolean, string][] = [
    ["stranger@example.com", true, "email_not_allowed"],
    ["owner@example.com", false, "email_not_verified"],
    ["someone@invited.dev", false, "email_not_verified"],
  ];
  for (const [email, emailVerified, code] of refusals) {
    await assert.rejects(
      context.internalAdapter.createUser({ name: "", email, emailVerified }, oauthSource),
      (error: unknown) => (error as { body?: { code?: string } }).body?.code === code,
      `${email} verified=${emailVerified} must be refused with ${code}`,
    );
  }
  assert.equal(await count(`users WHERE email IN ('stranger@example.com', 'someone@invited.dev')`), 0);
  assert.equal(await count(`auth_user WHERE email IN ('stranger@example.com', 'someone@invited.dev')`), 0);
});

test("the handoff reads the identity and leaves no Better Auth session behind", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const cookie = await signedSessionCookie("legacy-user-id");
  // A second, escaped session of the same user must not survive the handoff either.
  await signedSessionCookie("legacy-user-id");
  assert.equal(await sessionCount("legacy-user-id"), 2);

  const finished = await identity!.finishSignIn(new Headers({ cookie }));
  assert.deepEqual(finished.identity, { userId: "legacy-user-id", email: "owner@example.com" });
  assert.equal(await sessionCount("legacy-user-id"), 0);

  const replay = await identity!.finishSignIn(new Headers({ cookie }));
  assert.equal(replay.identity, undefined, "the same cookie cannot be handed off twice");
});

test("only the enabled providers' callbacks are served under /api/auth", async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const path of ["/api/auth/get-session", "/api/auth/sign-in/social", "/api/auth/sign-up/email", "/api/auth/callback/google", "/api/auth/list-accounts"]) {
    const response = await identity!.handle(new Request(`http://127.0.0.1:8787${path}`, { method: "POST" }));
    assert.equal(response.status, 404, path);
  }
});
