import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword, verifyStoredPassword } from "./auth.js";
import { decideProviderSignup, isAllowlisted, normalizeEmail, parseSignupAllowlist, SIGNUP_REFUSAL } from "./signup-policy.js";

/**
 * Who may sign in through a provider. Automated because a mistake is invisible while using the
 * product: a too-loose rule is a silent takeover of an existing account, a too-tight one a silent
 * lockout that looks like a provider outage.
 */

test("allowlist: exact addresses and @domain entries, case-insensitive after trimming", () => {
  const allowlist = parseSignupAllowlist(" Owner@Example.com , @Team.dev,, @, nobody, a@b@c.com ");
  assert.equal(isAllowlisted("owner@example.com", allowlist), true);
  assert.equal(isAllowlisted("  OWNER@EXAMPLE.COM ", allowlist), true);
  assert.equal(isAllowlisted("anyone@team.dev", allowlist), true);
  assert.equal(isAllowlisted("Anyone@TEAM.DEV", allowlist), true);
  assert.equal(isAllowlisted("other@example.com", allowlist), false, "an exact address does not open its domain");
  assert.equal(isAllowlisted("x@sub.team.dev", allowlist), false, "a subdomain is not its parent domain");
  assert.equal(isAllowlisted("x@team.dev.evil.com", allowlist), false);
  assert.equal(isAllowlisted("team.dev", allowlist), false);
  assert.equal(isAllowlisted("a@b@team.dev", allowlist), false, "a second @ never matches the domain part");
  assert.equal(isAllowlisted("", allowlist), false);
  // Malformed entries are dropped rather than widened into something that matches.
  assert.deepEqual([...allowlist.addresses], ["owner@example.com"]);
  assert.deepEqual([...allowlist.domains], ["team.dev"]);
});

test("allowlist: empty or unset means nobody new", () => {
  for (const raw of ["", " ", ",,"]) {
    const allowlist = parseSignupAllowlist(raw);
    assert.equal(isAllowlisted("owner@example.com", allowlist), false);
  }
});

test("verified rule: only a literal true provider flag is trusted, for existing and new emails alike", () => {
  const allowlist = parseSignupAllowlist("@example.com");
  for (const emailVerified of [false, undefined, null, "true", 1]) {
    assert.deepEqual(
      decideProviderSignup({ email: "owner@example.com", emailVerified }, "existing-user-id", allowlist),
      { case: "refuse", code: SIGNUP_REFUSAL.emailNotVerified },
      `existing user must not be reachable with emailVerified=${String(emailVerified)}`,
    );
    assert.deepEqual(
      decideProviderSignup({ email: "new@example.com", emailVerified }, undefined, allowlist),
      { case: "refuse", code: SIGNUP_REFUSAL.emailNotVerified },
    );
  }
  for (const email of [undefined, null, "", "   "]) {
    assert.deepEqual(decideProviderSignup({ email, emailVerified: true }, undefined, allowlist), { case: "refuse", code: SIGNUP_REFUSAL.emailNotVerified });
  }
});

test("decision: existing email reuses the user, allowlisted creates, anything else is refused", () => {
  const allowlist = parseSignupAllowlist("invited@example.com");
  assert.deepEqual(decideProviderSignup({ email: " Owner@Example.com ", emailVerified: true }, "user-1", allowlist), {
    case: "existing",
    userId: "user-1",
    email: "owner@example.com",
  });
  assert.deepEqual(decideProviderSignup({ email: "Invited@example.com", emailVerified: true }, undefined, allowlist), {
    case: "create",
    email: "invited@example.com",
  });
  assert.deepEqual(decideProviderSignup({ email: "stranger@example.com", emailVerified: true }, undefined, allowlist), {
    case: "refuse",
    code: SIGNUP_REFUSAL.emailNotAllowed,
  });
  assert.equal(normalizeEmail("  A@B.C "), "a@b.c");
});

test("a user without a password hash never passes password login", async () => {
  for (const stored of [null, undefined, ""]) {
    for (const typed of ["", "arbitrary-password", "scrypt::"]) {
      assert.equal(await verifyStoredPassword(typed, stored), false, `stored=${String(stored)} typed=${JSON.stringify(typed)}`);
    }
  }
  const real = await hashPassword("correct horse");
  assert.equal(await verifyStoredPassword("correct horse", real), true);
  assert.equal(await verifyStoredPassword("", real), false);
});
