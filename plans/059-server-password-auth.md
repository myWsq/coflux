# Plan 059: Server-owned email/password multi-account authentication

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD -- apps/server tests/src/supabase.test.mjs proto/coflux/v1/client.proto`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: migration
- Execution: subagent sonnet
- Planned at: `c772ed4`, 2026-07-28

## Requirement

User decided on 2026-07-28 to retire Supabase entirely. This is migration group's 059–063 contract plan: replace Supabase JWT exchange with users-table email/password verification and freeze the client contract for 060/061.

COFLUX_AUTH becomes local (default, unchanged) or password (new multi-account mode); supabase mode and server code disappear. Existing clientAuth.username carries email, password carries password; users-table verification feeds existing lazy membership resolution and coflux token issuance. Preserve reconnect, session tokens, and version admission.

**060/061 contract**: all clients send clientAuth { username: email or local username, password, clientVersion }. Stop using supabaseToken but retain proto field. authOk/authError shapes unchanged. User explicitly accepts email/password only, no OAuth.

## Decisions & tradeoffs

- **Remove supabase mode**, keep invalid-value fail-closed startup. No compatibility rollout for a personal-use project; dead code is liability. config.ts:19-25 and SUPABASE_URL prerequisite :36-38.
- **No protocol changes**: username field 1/password field 2 suffice. Keep obsolete supabase_token field 4, neither delete nor reserve; regeneration across clients adds no value. No separate email field. client.proto:14-21; hub.ts:1463-1537 exclusive credentials.
- **node:crypto scrypt**, random salt, timingSafeEqual, Node-default or OWASP parameters, self-describing salted storage. Avoid bcrypt/argon2 native dependencies for low-frequency personal login; package.json:11-20 has no hash library.
- **Admin account script, no registration endpoint**. Executor chooses mjs under scripts/ or server tsx. Support --id UUID so 063 can reuse Supabase user IDs and existing memberships.user_id. Admin-created users retain 001's lazy account provisioning. No registration/invite flow. hub.ts:1539-1552 and store.ts:236-243.
- **Add users to SCHEMA_DDL**, not 062's prisma-next contract yet; 062 later absorbs all tables. Minimum id UUID PK, unique email, password_hash, created_at. Existing IF NOT EXISTS DDL at store.ts:219-401.
- **Remove SupabaseVerifier/jose**: rewrite auth.ts for hashing or relocate/delete at executor discretion. Confirm server's only jose use at auth.ts:19-43 and remove dependency/injection at hub.plugin.ts:19-21. Test jose is separate and removable only after usage check.
- **Map all five supabase black-box cases**: first login lazy account; same userId reuses account; wrong password/nonexistent email reject; two accounts isolated; issued session token reconnects independently of users-table checks, replacing JWKS-shutdown test. Seed users through direct DB or admin script, using ADMIN_PG_URL as appropriate. Source supabase.test.mjs:73-146 and harness env injection :220-256.

## Direction

### Milestone 1: Config/hash

Accept password/reject supabase, delete SUPABASE_URL paths, implement self-describing scrypt and unit-level self-check. Server build passes.

### Milestone 2: Users/auth

Add schema/query/create methods. Lowercase email lookup→verify→membership by users.id→issue token with userId. Remove verifier construction; local seed stays local-only. Server build passes.

### Milestone 3: Admin creation

Email/password/optional UUID create users. Define duplicate-email behavior explicitly: reject or update password, executor chooses. Server build and real local-PG creation pass.

### Milestone 4: Black-box migration

Replace/rename supabase test with all five mapped behaviors; other LOCAL_ENV tests unchanged. Targeted and full tests below pass.

## Landmines

- Preserve exclusive credential branches and non-string rejection at hub.ts:1461. config.authProvider statically selects local/password; neither consumes the other's path.
- store.plugin.ts:30 local default-account seed must not run in password mode.
- client_tokens.user_id is null locally, users.id in multi-account mode (hub.ts:1482,1490), needed for per-user revocation after 063.
- Keep shared post-auth version gate at :1504-1532; no new branch bypass.
- Remove tests/package.json:13 jose only after rg proves no other usage.

## Scope

In scope: server auth/config/hub/store, hub/store plugins, package.json; supabase test rewrite/rename and test dependency cleanup; admin script.

Out of scope: protocol/generated, clients (060/061), prisma-next/DATABASE_URL/harness address (062), production (063).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `pnpm --filter @coflux/server build` | exit 0 |
| Full acceptance | `cd tests && COFLUX_TEST_PG_URL=<local direct PG connection string> pnpm test` | exit 0 |
| Targeted acceptance | `cd tests && COFLUX_TEST_PG_URL=<same connection> node --import tsx --test src/<new-test>.mjs` | exit 0 |

Historical local PG is selfhost Supabase direct 54322, harness default. Leave it unchanged here; 062 handles local retirement.

## Done criteria

- [ ] All listed commands pass.
- [ ] COFLUX_AUTH=supabase exits at startup with an invalid-value error; black-box password-mode acceptance completes account creation → login → authOk → token reconnect.
- [ ] `rg -i supabase apps/server/src` returns no matches, including comments.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited fact changes, excluded work required, validation fails twice after one reasonable fix, or jose/Supabase has another unplanned server use.

## Maintenance notes

- Password travels inside clientAuth over wss/TLS, matching existing local-mode security. Reassess if introducing an IdP later.
- Hash format prefix distinguishes parameter versions during upgrades.
- supabase_token remains obsolete proto field, documented rather than reserved.

For password-mode integration, start with `COFLUX_AUTH=password`; the obsolete `COFLUX_AUTH=supabase` mode is removed.

### Original source references

`apps/server/src/config.ts:19-25`, `apps/server/src/config.ts:36-38`, `proto/coflux/v1/client.proto:14-21`, `apps/server/src/hub.ts:1463-1537`, `apps/server/package.json:11-20`, `apps/server/src/hub.ts:1539-1552`, `apps/server/src/store.ts:236-243`, `apps/server/src/store.ts:219-401`, `apps/server/src/auth.ts:19-43`, `apps/server/src/plugins/hub.plugin.ts:19-21`, `tests/src/supabase.test.mjs:73-146`, `tests/src/harness.mjs:220-256`, `apps/server/src/hub.ts:1461`, `apps/server/src/hub.ts:1482,1490`, `apps/server/src/hub.ts:1504-1532`.
