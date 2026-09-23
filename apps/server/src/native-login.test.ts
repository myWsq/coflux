import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { NativeLoginStore, s256, type NativeLoginRegistration } from "./native-login.js";

/**
 * Native (desktop / CLI) browser login. Automated because every failure mode here is silent while
 * using the product: a reusable code, a verifier that is not checked, or a redirect target taken from
 * the browser would each still "log in" normally — for the attacker too.
 */

const TTL = 10 * 60_000;
const grant = { accountId: "acct-1", userId: "user-1", login: "owner@example.com" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

function registration(overrides: Partial<NativeLoginRegistration> = {}, challenge = pkce().challenge): NativeLoginRegistration {
  return {
    clientKind: "desktop",
    host: "studio.local",
    redirect: { kind: "loopback", port: 49152 },
    codeChallenge: challenge,
    state: randomBytes(16).toString("base64url"),
    ...overrides,
  };
}

function codeFrom(location: string): string {
  const url = new URL(location);
  return url.searchParams.get("code") ?? "";
}

test("loopback approval redirects only to the registered 127.0.0.1 port and the code exchanges once", () => {
  const store = new NativeLoginStore(TTL, 16);
  const { verifier, challenge } = pkce();
  const input = registration({}, challenge);
  const registered = store.register(input, 1_000);
  assert.ok(registered.ok);
  const outcome = store.approve(registered.id, grant, 2_000);
  assert.ok(outcome && outcome.kind === "loopback");
  const location = new URL(outcome.location);
  assert.equal(location.protocol, "http:");
  assert.equal(location.hostname, "127.0.0.1");
  assert.equal(location.port, "49152");
  assert.equal(location.pathname, "/callback");
  assert.equal(location.searchParams.get("state"), input.state);

  const code = codeFrom(outcome.location);
  assert.deepEqual(store.exchange(code, verifier, 3_000), grant);
  assert.equal(store.exchange(code, verifier, 3_001), undefined, "a code is good for exactly one exchange");
  assert.equal(store.size, 0);
});

test("a wrong verifier fails and burns the code", () => {
  const store = new NativeLoginStore(TTL, 16);
  const { verifier, challenge } = pkce();
  const registered = store.register(registration({}, challenge), 0);
  assert.ok(registered.ok);
  const outcome = store.approve(registered.id, grant, 0);
  assert.ok(outcome && outcome.kind === "loopback");
  const code = codeFrom(outcome.location);
  assert.equal(store.exchange(code, pkce().verifier, 1), undefined);
  assert.equal(store.exchange(code, verifier, 2), undefined, "the right verifier after a wrong one is too late");
});

test("an expired request can be neither shown, approved nor exchanged", () => {
  const store = new NativeLoginStore(TTL, 16);
  const { verifier, challenge } = pkce();
  const first = store.register(registration({}, challenge), 0);
  assert.ok(first.ok);
  assert.equal(store.describe(first.id, TTL), undefined);
  assert.equal(store.approve(first.id, grant, TTL), undefined);

  const second = store.register(registration({}, challenge), 0);
  assert.ok(second.ok);
  const outcome = store.approve(second.id, grant, TTL - 1);
  assert.ok(outcome && outcome.kind === "loopback");
  assert.equal(store.exchange(codeFrom(outcome.location), verifier, TTL), undefined, "approved but exchanged after the TTL");
});

test("the cap fails closed and never evicts a live request", () => {
  const store = new NativeLoginStore(TTL, 2);
  const a = store.register(registration(), 0);
  const b = store.register(registration(), 0);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(store.register(registration(), 1), { ok: false, error: "full" });
  assert.ok(store.describe(a.id, 1));
  // Expired entries make room again.
  assert.ok(store.register(registration(), TTL + 1).ok);
});

test("paste mode shows a grouped code bound to the same verifier; case and dashes do not matter", () => {
  const store = new NativeLoginStore(TTL, 16);
  const { verifier, challenge } = pkce();
  const registered = store.register(registration({ clientKind: "cli", redirect: { kind: "paste" } }, challenge), 0);
  assert.ok(registered.ok);
  const outcome = store.approve(registered.id, grant, 0);
  assert.ok(outcome && outcome.kind === "paste");
  assert.match(outcome.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  assert.equal(store.exchange(outcome.code.toLowerCase().replaceAll("-", " "), pkce().verifier, 1), undefined, "someone else's verifier");

  const again = store.register(registration({ clientKind: "cli", redirect: { kind: "paste" } }, challenge), 0);
  assert.ok(again.ok);
  const second = store.approve(again.id, grant, 0);
  assert.ok(second && second.kind === "paste");
  assert.deepEqual(store.exchange(` ${second.code.toLowerCase()} `, verifier, 1), grant);
});

test("registration rejects anything but S256 challenges, sane state and unprivileged ports", () => {
  const store = new NativeLoginStore(TTL, 16);
  assert.deepEqual(store.register(registration({ codeChallenge: "plain-verifier" }), 0), { ok: false, error: "invalid" });
  assert.deepEqual(store.register(registration({ state: "short" }), 0), { ok: false, error: "invalid" });
  assert.deepEqual(store.register(registration({ redirect: { kind: "loopback", port: 80 } }), 0), { ok: false, error: "invalid" });
  assert.deepEqual(store.register(registration({ host: "" }), 0), { ok: false, error: "invalid" });
  assert.deepEqual(store.register(registration({ host: "evil\nhost" }), 0), { ok: false, error: "invalid" });
});

test("a failed or cancelled loopback request tells the client and cannot be approved afterwards", () => {
  const store = new NativeLoginStore(TTL, 16);
  const input = registration();
  const registered = store.register(input, 0);
  assert.ok(registered.ok);
  const failed = store.fail(registered.id, "not_allowed", 1);
  assert.ok(failed);
  const location = new URL(failed.location);
  assert.equal(location.host, "127.0.0.1:49152");
  assert.equal(location.searchParams.get("error"), "not_allowed");
  assert.equal(location.searchParams.get("state"), input.state);
  assert.equal(store.approve(registered.id, grant, 2), undefined);

  const paste = store.register(registration({ redirect: { kind: "paste" } }), 0);
  assert.ok(paste.ok);
  assert.equal(store.fail(paste.id, "failed", 1), undefined, "a paste request stays open for another try");
  assert.deepEqual(store.cancel(paste.id, 1), { kind: "paste" });
  assert.equal(store.describe(paste.id, 1), undefined);
});

test("the confirmation page ignores any redirect target the browser supplies", async () => {
  process.env.COFLUX_DEV = "1";
  const { AuthPages, PageSessionStore } = await import("./auth-pages.js");
  const store = new NativeLoginStore(TTL, 16);
  const registered = store.register(registration());
  assert.ok(registered.ok);
  const sessions = new PageSessionStore(TTL);
  const session = sessions.create("login", { accountId: "acct-1", userId: "user-1", login: "owner@example.com", subject: registered.id });
  assert.ok(session);
  const host = {
    allowLogin: () => true,
    verifyLoginCredentials: async () => ({ case: "invalid" as const }),
    describePendingAuthorization: () => undefined,
    authorizeDevice: async () => undefined,
    issueProxyAuth: () => ({ ok: false as const, error: "unused" }),
    identity: { providers: [], startSignIn: async () => undefined, finishSignIn: async () => ({ setCookies: [] }) },
    accountForProviderIdentity: async () => "acct-1",
    nativeLogins: store,
  };
  const pages = new AuthPages(host, sessions);
  const form = new URLSearchParams({
    csrf: sessions.csrfFor(session.token),
    redirect_uri: "https://evil.example/steal",
    redirect: "https://evil.example/steal",
    port: "1",
  });
  const request = new Request(`http://127.0.0.1:8787/login/${registered.id}/confirm?redirect_uri=https%3A%2F%2Fevil.example%2F`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `cf_page=${session.token}` },
    body: form.toString(),
  });
  const response = await pages.nativeConfirm({ request, remoteAddress: "127.0.0.1" }, registered.id);
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "http://127.0.0.1:49152");
  assert.equal(location.pathname, "/callback");
});
