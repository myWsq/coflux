# Plan 003: Tailscale-style device authorization without an enroll key by default

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Validate each milestone before continuing.
> Stop on any STOP condition. When complete, update this plan in
> `plans/README.md`.
>
> Drift check: `git diff --stat 61d2129..HEAD -- apps/server/src apps/web/src crates/worker/src crates/protocol packages/cli tests/src`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: plans/001-multi-account-supabase-auth.md (account/login status)
- Category: feature
- Execution: subagent sonnet (implementation); verification/review is done by the main session itself
- Planned at: `61d2129`, 2026-07-04

## Requirement

Connecting a new machine currently requires generating an enrollmentKey in the web console and running `cofluxd up --enroll-key <KEY>`. Change the default to a Tailscale-style flow:

1. `cofluxd up` (with no arguments) → the daemon connects to the server in an unregistered state;
2. The server generates a one-time authorization request, and the daemon/CLI prints the authorization link;
3. The user opens the link in the browser and confirms "Authorize this device" using the existing web login state;
4. The server binds the device to the **authorizing account** and sends its deviceToken over the daemon’s existing WS connection; enrollment completes without restarting the daemon.
5. The CLI side gives clear feedback throughout the process (waiting for authorization → registration successful).

At the same time (explicitly requested by the user), the `cofluxd up` interaction **no longer asks for the server address**.

Correctness criterion (distinguish between correct solutions and incorrect solutions that appear to be correct):
- After authorization is completed, the daemon is indistinguishable from a device registered through the enrollment-key flow (the same devices table, the same deviceToken mechanism, and the same reconnection/resync behavior).
- The authorization code is single-use, expires after its TTL, and becomes invalid when the daemon disconnects. Rate-limit `device.authorize` attempts to prevent brute force.
- The existing `--enroll-key` flow remains unchanged, and the existing black-box tests (lifecycle/security/ and Supabase enrollment cases) continue to pass with the same semantics.

## Decisions & tradeoffs

- **The authorization path reuses the WS that the daemon has opened and does not introduce a second HTTP polling path**: The daemon sends a new message `daemon.enrollRequest{name,host,platform}` after anonymous connection. server returns `daemon.authorizePending{url,expiresAt}`, and reuses the existing `daemon.enrolled{daemonId,deviceToken}` (already available in hub.ts:249). Rejected: connecting an OAuth device code directly to Supabase — coflux server, rather than the identity layer, owns device registration, and a second path would only add complexity. Based on: `apps/server/src/hub.ts:229-249` (unauthenticated gate control + enrolled delivery).
- **Pending authorization is stored in hub memory and not in Postgres**: authorization state is tied to the connection. If the daemon WS disconnects, there is no live connection to receive the deviceToken, so the code is invalidated with the connection. On reconnect, the worker resends the enrollRequest to obtain a new code. The single-instance deployment (OPEN_QUESTIONS B7) requires no shared state. Rejected: storing pending requests in the database would accumulate garbage rows and conflict with the semantics of “disconnection means failure”. Based on: `docs/OPEN_QUESTIONS.md` B7 (single instance); `apps/server/src/hub.ts` the conn object is the connection phase state carrier.
- **The authorization URL contains a long random token (≥128 bits, in the style of `genToken`), not a human-readable shortcode**: the link is delivered by clicking or scanning it, so there is no manual entry flow. A shortcode would only reduce the search space. The URL looks like `<webUrl>/authorize/<token>`. Rejected: a 6–8 digit code plus an input box — Tailscale also uses a direct link. Based on: `apps/server/src/hub.ts:429` (genToken already exists).
- **Authorization semantics: whoever logs in claims the device**: `device.authorize{token}` binds the device to the current accountId of the confirming client. The token is not pre-bound to an account; whoever holds the link authorizes it into their own account, consistent with Tailscale. The security boundary is the unguessable, one-time, expiring, rate-limited token rather than account pre-binding. Based on: `apps/server/src/hub.ts:430` (client.accountId semantics).
- **The CLI and daemon hand off through a file under `~/.coflux`; the CLI has no protocol logic**: after receiving authorizePending, the worker writes `pending-auth.json` (url/expiresAt). After successful registration it writes the credential file and deletes the pending file as usual. The CLI polls this after `cofluxd up` starts the service: pending means print the authorization link and wait; the credential appearing means registration succeeded. Rejected: CLI directly connects to the server (protocol + authentication needs to be implemented repeatedly); tail log parsing (fragile). Based on: `crates/worker/src/creds.rs` (the credential file already has this mode); `packages/cli/cofluxd.mjs` Zero dependency status quo.
- **`cofluxd up` will no longer interactively ask for the server address** (user decision, 2026-07-04): priority is `--server` > the saved value in settings.json > `DEFAULT_SERVER`; the saved value remains effective, but if it differs from the default, print a prominent notice to prevent silent staging misconnections. Rejected: Force default override of saved value - user chooses to retain self-hosted experience. Based on: `packages/cli/cofluxd.mjs:173,186` (existing priority and interactive Q&A).
- **Do not introduce a routing library for the authorization page.** The web client is currently a single page without routing. Parse `location.pathname` and render a branch for `/authorize/<token>`, reusing the login form and WS client. Rejected: adding react-router for one page. Evidence: `apps/web/src/App.tsx` is a 443-line component without Route.
- **Generate the authorization URL on the server; the daemon passes it through unchanged.** Add `webUrl` to server config (env `COFLUX_WEB_URL`, following `daemonUrl`) so self-hosted deployments work naturally. Rejected: URL assembly in the CLI/daemon, which cannot know where the web client is deployed. Evidence: `apps/server/src/config.ts:56-57` provides the daemonUrl precedent.
- **Wire compatibility:** old daemons never send `daemon.enrollRequest`, so their behavior remains unchanged. New daemons need not support old servers: deploy the centrally controlled server before releasing daemon binaries. Add `daemon.enrollRequest` to the unauthenticated whitelist at `hub.ts:229`. Define matching TS and `crates/protocol` types using existing serde conventions. Evidence: `apps/server/src/hub.ts:229`.
- **Retain the enrollmentKey flow unchanged** for headless/scripted use. With `--enroll-key`, follow the existing path without affecting browser authorization. Evidence: `crates/worker/src/main.rs:310`, `apps/server/src/hub.ts:232-249`.

## Direction

### Milestone 1: server supports device authorization flow

An unauthenticated daemon can send `daemon.enrollRequest` to obtain pending authorization held in memory for 10 minutes and invalidated on disconnection. A logged-in client sends `device.authorize{token}`; the server persists the device and sends `daemon.enrolled`. Reject invalid, expired, or reused tokens with clear errors. Rate-limit failed authorization attempts, for example with per-connection exponential backoff or an attempt cap. Use a bare WS client and the black-box harness to verify this before changing the web client. Validation: first exercise the server path with a minimal script for the new M4 cases; all existing `pnpm -C tests test` cases pass.

### Milestone 2: worker unregistered state machine + file handover

When credentials and an enroll key are both absent, send enrollRequest after connecting, write url/expiresAt to `~/.coflux/pending-auth.json`, and keep the connection open while awaiting enrollment (do not exit; see Landmines). On enrolled, delete the pending file, persist credentials as before, and immediately enter authenticated operation. Resend enrollRequest after reconnecting. Preserve existing behavior when an enroll key is configured. Validation: `cargo build -p coflux-worker` passes; M4 black-box tests cover behavior.

### Milestone 3: CLI default process

Argument-free `cofluxd up` works without prompting for a server address or requiring an enroll key. Honor saved server settings and prominently identify non-default values. After starting the service, poll `~/.coflux`, print the authorization link, report enrollment success, and explain how to retry after a timeout. Preserve `--enroll-key`/`--server` semantics. `cofluxd status` distinguishes "waiting for authorization". Validation: `node -c packages/cli/cofluxd.mjs`; the main session manually exercises the local `--bin-dir` flow during acceptance.

### Milestone 4: web authorization page + black-box testing

The `/authorize/<token>` page shows the login form when needed, then the device name/host/platform, and success or failure after confirmation. Add black-box cases using a bare WS client to simulate web behavior, consistent with existing tests:
1. Authorization is successful end-to-end: anonymous daemon → get link token → client authorization → daemon enrolled, able to run tasks;
2. The token expired and was rejected (TTL can be shortened by env injection);
3. The token can only be used once (secondary authorization fails);
4. After the daemon is disconnected, the old token will be invalid;
5. The existing enrollmentKey flow passes regression tests unchanged. Validation: all `pnpm -C tests test` cases pass; this machine requires `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres`.

## Landmines

- `apps/server/src/hub.ts:229` whitelists unauthenticated messages and returns early for others. Add the new message explicitly or it will be silently discarded, appearing as an unresponsive daemon rather than an error.
- `crates/worker/src/main.rs:365-371` exits on authError/need_enroll. Do not reuse that path while waiting for authorization: the supervisor would treat it as a crash loop, invoking manager.rs crash-budget/rollback logic (see plan 002 security hardening).
- Preserve `v.server || s.serverUrl || DEFAULT_SERVER` at `packages/cli/cofluxd.mjs:173`; remove only the interactive question near line 186.
- web `App.tsx` is a single component without routing. Select the authorization-page branch before creating the WS connection, so terminal-related connection effects cannot run on that page.
- The black-box harness server requires Postgres; the local machine 5432 is a supavisor (will report tenant error), you must use the 54322 direct port (service mapping 5432 in CI does not have this problem).
- `tests/src/lifecycle.test.mjs`, `security.test.mjs`, `supabase.test.mjs` Contains existing use cases related to enroll. When changing the protocol, read their assertions before proceeding.
- Protocol definitions exist in Rust (`crates/protocol`, serde tagged enums) and TS. Add both sides and preserve matching field names, following existing camelCase messages.

## Scope

In scope:
- `apps/server/src/` (hub/config/store/transport related changes)
- `crates/protocol/`, `crates/worker/src/`
- `packages/cli/cofluxd.mjs` (version bumped to 0.2.0, released via npm-publish.yml)
- `apps/web/src/`
- `tests/src/` (new test case + revision of affected use cases)
- `docs/auth-design.md` (register one section of supplementary authorization flow), `plans/README.md`

Out of scope:
- `crates/supervisor/` — The authorization flow is all in the worker/server/CLI/web layer, supervisor not aware of registration.
- EnrollmentKey generation/management UI changes - the old process remains intact.
- QR code rendering - link first, QR code is the icing on the cake later.
- Production deployment and release actions themselves (follow RELEASING.md in the main session after implementation).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit && node_modules/.bin/tsc -b apps/web/tsconfig.json`  | exit 0 |
| Rust Test | `cargo test -p coflux-protocol` | exit 0 |
| Rust Build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| Full black-box suite | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0, new test cases are listed |
| CLI syntax | `node -c packages/cli/cofluxd.mjs` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Argument-free `cofluxd up` completes enrollment through the authorization link, manually verified with local `--bin-dir`.
- [ ] Black-box assertions cover single use, TTL, disconnection invalidation, and rate limiting.
- [ ] The `--enroll-key` flow and existing test semantics remain unchanged.
- [ ] `cofluxd up` no longer asks for the server address; there will be an eye-catching prompt when the saved value takes effect and is not the default.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md`  status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (especially supervisor must be aware of when registering - stop and reconsider).
- A validation command fails twice after one reasonable fix.
- Existing black-box tests require altered assertion semantics to pass, indicating that the old flow has been broken.

## Maintenance notes

- Pending authorizations live only in memory. Losing them on server restart is expected: daemons reconnect and repeat enrollment. Do not treat this as a bug.
- If multi-instance deployment reopens B7, externalize pending authorization to Redis/Postgres and reconsider invalidation on disconnection.
- Starting with cofluxd 0.2.0, argument-free startup is the complete enrollment flow. Update the README/package description at the same time.
