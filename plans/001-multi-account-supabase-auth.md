# Plan 001: Multi-account SaaS — Supabase Auth identity layer and token-exchange login

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Validate each milestone before continuing.
> Stop on any STOP condition. When complete, update this plan in
> `plans/README.md`.
>
> Drift check: `git diff --stat d8ba0df..HEAD -- apps/server/src apps/web/src packages/protocol/src tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent
- Planned at: `d8ba0df`, 2026-07-02

## Requirement

coflux currently supports one account: identity comes from the `COFLUX_USERNAME`/`COFLUX_PASSWORD` environment variables, and `accountId` is hardcoded to `"default"` (`apps/server/src/config.ts:33-35`). Convert it to a Tailscale-style multi-account SaaS: users log in independently and own isolated Accounts, with no visibility into each other's devices, projects, workspaces, or tasks.

The following must hold on completion:

1. In production SaaS mode (`COFLUX_AUTH=supabase`), users log in to the web client with Supabase-hosted email/password authentication. Each user can see and access only the devices and data in their own account.
2. A valid Supabase user receives a personal Account on first login through lazy provisioning, without administrator action in coflux.
3. Local mode (`COFLUX_AUTH=local`, the default) behaves exactly as before: environment-based credentials and a single `default` account. `pnpm dev`, integration tests, and self-hosted installations require no changes.
4. Daemon enrollment/authentication (enrollmentKey → deviceToken) remains unchanged, with no Rust changes.

**Supabase provides a one-time identity check; coflux owns its sessions, data, and authorization.** Making WS connections continually depend on Supabase JWTs—for example, obtaining a new JWT on every reconnect or periodically calling Supabase to validate sessions—would violate this boundary.

## Decisions & tradeoffs

- **Identity provider**: Supabase Auth with email/password. Disable signup in the dashboard and create users manually. Rejected: a local users table plus scrypt. Although simpler initially, opening registration would then require building email verification, password resets, and brute-force protection. Supabase incurs a one-time structural cost for future public signup. Rejected: storing business data in Supabase Postgres/RLS. coflux data stays in its own SQLite database (`apps/server/src/store.ts`); login verification is its only integration with Supabase.
- **Token exchange is the core model**: the web client obtains a Supabase access_token (JWT), sends `client.auth{ supabaseToken }` over WS, and the server verifies the signature **locally using JWKS** with cached public keys and no verification round trip. It extracts `sub` as userId, looks up or creates membership, and issues a coflux session token valid for 30 days using the existing `client_tokens` mechanism (`store.ts:188-205`). Subsequent WS reconnects use only that coflux token. Rejected: checking a Supabase JWT on every connection. JWTs expire after one hour, making long-lived connections/reconnects depend on Supabase availability and refresh handling. Based on: the existing clientToken reconnect branch in `client.auth` (`apps/server/src/hub.ts:396-421`) and `expiresAt` in `client_tokens` (`store.ts:69-72`).
- **Account model**: User : Account is initially 1:1 for personal accounts. Add `memberships (userId, accountId, role)` with PRIMARY KEY (userId, accountId); the MVP role is always `"owner"`. userId is the Supabase user UUID from JWT `sub`. **Do not create a local users table**: identity data remains in Supabase, and email comes from the JWT claim. Rejected: putting accountId directly on a users table, which would require migration when teams are added. The small membership-table cost avoids that later migration.
- **Signup policy**: no signup page or endpoint. Disable signup in the Supabase dashboard and use Add user manually. For any verified userId without membership, coflux lazily creates an Account (id = randomUUID, name = email claim) and owner membership. A valid JWT then identifies an administrator-created user, making lazy provisioning safe.
- **Provider abstraction**: `COFLUX_AUTH` accepts `local` (default) or `supabase`. Local mode preserves the existing environment-password `verifyLogin` logic (`hub.ts:774`). Branch the fail-closed configuration checks (`config.ts:52-59`) by provider: Supabase mode requires `SUPABASE_URL` and the web anon key, but no longer requires `COFLUX_PASSWORD`/`COFLUX_ENROLL_KEY`; local requirements remain unchanged. Rejected: supporting only Supabase, which would force integration tests (`tests/src/harness.mjs:117-135`, all using username/password) and local development to depend on an external service.
- **Provider-specific bootstrap**: the `default` account seed, environment enroll-key seed, and credFingerprint revocation logic (`apps/server/src/index.ts:24-46`) belong to the single-account/environment-password model and run only in local mode. Supabase mode generates all enroll keys through the existing UI capability (`hub.ts:444-446`).
- **JWT verification**: add `jose` to the server (pure JS, no native dependencies). Use ``createRemoteJWKSet(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)`` and validate iss = `${SUPABASE_URL}/auth/v1`, aud = `authenticated`, and exp. Require asymmetric signing keys in the Supabase project, the default for new projects. Do not support the legacy HS256 secret; return `auth.error` on verification failure. Rejected: handwritten node:crypto verification, because implementing JWKS rotation and caching is not worthwhile.
- **Web Supabase configuration** (decided while planning): Vite build-time `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. When both are set, the login form exchanges email/password for a Supabase JWT; otherwise retain the current username/password form. Rejected: a server endpoint supplying runtime auth configuration. The web is already built per environment; build-time variables follow Vite conventions and avoid another HTTP route.
- **No supabase-js SDK for web login** (decided while planning): exchange credentials with a `fetch` POST to `${SUPABASE_URL}/auth/v1/token?grant_type=password`, setting header `apikey: <anon>`, and read `access_token` from the response. Rejected: importing `@supabase/supabase-js` for one endpoint. Reconsider the SDK if OAuth or magic links are needed later.
- **Protocol changes only on the TS side**: add optional `supabaseToken` to `client.auth` (`packages/protocol/src/index.ts:134`). Keep `auth.ok` unchanged, including its coflux session token. Client↔server messages do not pass through the Rust wire-protocol source, so crates/protocol remains unchanged.
- **Add userId to client_tokens**: follow the lightweight migration pattern in `store.ts:107-114`, using PRAGMA table_info to add missing columns. Tokens issued in local mode store NULL as userId. Per-user token revocation is out of scope.
- **Production data migration**: retain prod-jp's existing `default` account data. After switching to Supabase mode, manually insert a membership linking the administrator's Supabase userId to `default`. This is an operational step described in Maintenance notes, outside this plan's code changes.

## Direction

The existing isolation layer already supports multiple accounts: every table has accountId, and the hub filters broadcasts, snapshots, and routes by accountId. Add only the User → Account identity-resolution layer, leaving orchestration and the data plane unchanged.

### Milestone 1: Server Supabase provider, token exchange, memberships, and lazy provisioning

A server started with `COFLUX_AUTH=supabase` accepts `client.auth{ supabaseToken }`, verifies it, resolves userId, looks up/creates membership, and issues a coflux session token. Different userIds receive different accountIds and cannot see each other's data. Local mode remains identical to `d8ba0df`.

Validation: `pnpm --filter @coflux/tests test` passes, demonstrating no local-mode regression. New Supabase integration tests generate an ES256 key pair, serve JWKS over local HTTP, sign test JWTs, and point `SUPABASE_URL` at that service without using real Supabase. Cover first-login account creation, reuse on subsequent login, expired/incorrectly signed JWT rejection, device/task isolation between two userIds, and reconnecting with the exchanged session token.

### Milestone 2: Protocol and web login

`packages/protocol` exposes optional `supabaseToken` on `client.auth`. With `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` set, the web displays email/password login, fetches a Supabase access_token, exchanges it over WS, and saves the coflux token in localStorage using the existing logic (`apps/web/src/App.tsx:96-157`). Without those variables, the form remains unchanged. Supabase 401/network failures produce clear form errors.

Validation: `pnpm -r build` exits 0 and `pnpm --filter @coflux/tests test` passes. Optional manual validation, if a Supabase project is available: configure the variables, start server/web development processes, and complete a real login.

## Landmines

- `client.auth` has a special rate-limit allowlist entry near `"client.auth": {}` in `packages/protocol/src/index.ts:303`. Update that table/validator (`isValidClientToServer`) to allow `supabaseToken`, or transport will silently discard the message.
- The credFingerprint logic in `index.ts:35-40` **revokes all** client tokens when the environment password changes. Running it in Supabase mode could log out everyone on environment changes; restrict it to local mode.
- `tests/src/security.test.mjs:66-67` asserts rejection of malformed `client.auth` fields such as numeric clientToken. Apply the same strict string-only validation to `supabaseToken`.
- `config.ts` validates during module loading and fails closed with `process.exit(1)`. Preserve this behavior for provider-specific checks rather than deferring validation until runtime.
- Web token restoration (`App.tsx:72-97`) reconnects directly with an existing clientToken. Preserve this normal post-exchange path in Supabase mode; do not fetch another JWT on every reconnect.

## Scope

In scope:

- `apps/server/src/` (config, hub, store, index, and a new auth module)
- `apps/server/package.json` (add `jose`)
- `packages/protocol/src/` (client.auth message and validator)
- `apps/web/src/` (login form and Supabase fetch)
- `tests/src/` (new Supabase integration tests; existing tests should need no changes)
- `plans/`

Out of scope:

- `crates/`, `packages/cli`: daemon enrollment/authentication is unchanged
- Creating/configuring a real Supabase project, disabling signup, and creating users: operational steps in Maintenance notes
- prod-jp/staging deployment and default-account membership migration: operational steps
- Teams, multiple members, role permissions, per-user token revocation, and public signup: future work
- OAuth, magic links, and the supabase-js SDK: future work

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Test | `pnpm --filter @coflux/tests test` | exit 0; pretest builds the daemon with cargo |
| Typecheck/build | `pnpm -r build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Supabase mode: two different Supabase userIds receive isolated accounts, asserted by integration tests.
- [ ] Supabase mode: the exchanged coflux session token reconnects over WS without contacting Supabase again.
- [ ] Local behavior matches `d8ba0df`; existing test files pass unchanged.
- [ ] Expired, incorrectly signed, and non-string supabaseTokens are rejected with auth.error or disconnect.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `jose` cannot run in the pure node:sqlite/tsx environment, for example because it requires native dependencies: stop and report.
- Client↔server authentication actually passes through crates/protocol, contradicting the TS-only decision.

## Maintenance notes

- **Production operations after merging code and before cutover**:
  1. Create/manage the Supabase project, optionally through Supabase MCP. Disable signup under Authentication; manually add the administrator and invited users. Confirm asymmetric signing keys and an accessible JWKS endpoint.
  2. Set prod-jp environment variables `COFLUX_AUTH=supabase` and `SUPABASE_URL=<project URL>`. Add `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` to the web build. The anon key is public, not a secret.
  3. Migrate existing data by running `INSERT INTO memberships (userId, accountId, role) VALUES ('<uuid>', 'default', 'owner')` with the administrator's Supabase user UUID. All devices/projects/tasks remain intact. Other users receive new accounts on first login.
  4. Remove `COFLUX_USERNAME`/`COFLUX_PASSWORD` from production configuration after migration.
- The anon key is public by design. The Supabase service_role key must never appear in any coflux configuration; this design does not need it.
- Future teams need only invitations and role checks: memberships already supports many-to-many relationships without a schema migration.
- Switching identity providers only requires replacing the JWT-verification → userId function at the token-exchange boundary.
