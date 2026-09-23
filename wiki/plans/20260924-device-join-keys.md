# Plan 20260924-device-join-keys: A headless machine joins the account with one command and a one-time key

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 1e101fa0..HEAD -- proto apps/server/src crates/worker crates/protocol packages/cli packages/client/src apps/desktop/src/renderer/components/workbench/add-device-dialog.tsx apps/desktop/src/renderer/components/workbench/add-device-view.ts tests/src`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none (builds on the add-device dialog of `wiki/plans/20260923-add-device-dialog.md`, already merged into this branch)
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: current — the session was already in the linked worktree `.claude/worktrees/20260923-terminal-split-groups` on `dev/20260923-terminal-split-groups`
- Planned at: `1e101fa0`, 2026-09-24

## Requirement

Adding a headless machine (Linux, Intel Mac, server) today means: run `cofluxd up` there, which prints an authorization link and blocks; then carry the link back and either open it in a signed-in browser or paste it into the desktop's 添加设备 dialog. In walkthrough the user found the paste-back step baffling ("I run the command over there — why do I have to paste a link back here?"). The desktop is already signed in; it should hand the machine a credential up front, so that running the command is the whole job.

Product conclusions, confirmed by the user — settled, do not reinterpret:

1. **Headless tab mints a key automatically** the first time the tab is shown in a dialog opening. While minting, the prompt and command areas show a loading state; on failure the tab shows 「生成密钥失败」 with a 重试 action.
2. **The key is embedded** in both the agent prompt and the collapsed 「自己动手」 command, e.g. `npm i -g cofluxd && cofluxd up --server <daemon url> --key <key>`. Copying either is all the user does.
3. **The agent prompt is short** — the user asked for this explicitly. About five or six lines: make sure Node.js 20+ is present (install it if not), `npm i -g cofluxd`, run the one `cofluxd up … --key …` line, then confirm with `cofluxd status` that the machine is registered. No link retrieval, no polling instructions, no "hand the link back to me".
4. **Status line** under the command: 「等待设备接入… 密钥 N 分钟内有效，只能用一次 · 换一个」, with N counting down from the mint response. When it runs out: 「密钥已过期」 with 换一个. 换一个 mints a new key and **revokes the previous one immediately**.
5. **Key rules**: single use, valid for 1 hour. Closing the dialog does **not** revoke it (an agent may still be installing; the device then simply appears in the sidebar). Each opening of the dialog mints its own key.
6. **Success is unchanged**: while the dialog is open, a device that was not in the account when it opened flips the dialog in place to 「✓ <name> 已上线」 (existing new-device diff).
7. **The paste-the-link input and every piece of copy about links are removed** from the dialog.
8. **Unchanged**: plain `cofluxd up` without `--key` still prints the link and browser authorization (server pages) keeps working — the dialog just no longer mentions it. The Desktop tab is unchanged. This Mac's own automatic local authorization is unchanged.
9. **Non-goals**: reusable or long-lived keys, a key management list, revoke UI, keys for the desktop app itself, a curl installer.
10. **Observable when done**: on a Linux machine, pasting the prompt into an agent — or running the one command by hand — makes the open dialog show 已上线 and the device appear in the sidebar, with nothing pasted back. A used, expired or replaced key makes `cofluxd up` fail within seconds with a clear message instead of hanging.

**History to respect**: plan 034 (`plans/034-remove-enroll-key.md`) deliberately removed a previous "enrollKey" — a long-lived key seeded from a server environment variable, with its own table, CLI prompt and web dialog — because browser authorization covered headless machines. This is a different credential: minted per use by a signed-in client, bound to that account, single use, one hour. Do not resurrect any of the removed names or field numbers.

## Decisions & tradeoffs

- **Keys are persisted server-side, hash only, in a new table created by migration 8.** One row per key: sha256 hash (primary key or unique), `account_id` (FK to accounts, cascade on delete), `expires_at`, `created_at`, and a used/revoked marker. Minted with the existing `genToken` under a new prefix (e.g. `cf_join`) and stored via `hashToken` (`apps/server/src/secrets.ts`). Rejected: an in-memory map like `pendingAuthorizations` — a server restart or deploy inside the hour would silently invalidate every key a user has already handed to an agent. Rejected: reusing the old `enrollment_keys` table, which still exists un-dropped in production (plan 034 Maintenance notes) — a fresh name avoids any collision with its leftover schema. Based on: migration ledger `apps/server/src/infra/database/schema-migrations.ts` (MIGRATIONS array; latest is 7 `auth_identity`, checksum + gap check enforced); `oauth_tokens` (migration 4) is the local precedent for a hashed, expiring, account-bound token table.
- **Consumption is one atomic statement.** A key is redeemed only by a single conditional update/delete that matches "this hash, unused, unrevoked, not expired" and returns the account id; zero rows means rejected. Rejected: read-then-write in two statements — two daemons racing with the same key could both enroll.
- **Minting goes over the control WebSocket as a new request/response pair carrying a request id.** New `client.proto` messages (ClientToServer / ServerToClient oneof members on fresh field numbers): the request optionally names the key it replaces; the response carries the key, its expiry, the request id, or an error. The server revokes the replaced key (only if it belongs to the same account) in the same operation. Per-account cap on simultaneously valid keys (a small number such as 10; oldest valid keys are revoked when minting beyond it). Rejected: an `/api/client/*` HTTP route — the renderer has no HTTP path to the server (only the main process does, with the session token), so it would need a new preload bridge method and IPC for a single call; the dialog already talks to the server through the client store over the WS. Based on: `packages/client/src/store.ts` (everything in the store goes over the WS; `authorizeDevice` at ~975 is single-flight with no request id, which is why the new pair carries one); ClientToServer fields 4 and ServerToClient field 3 are `reserved` (`proto/coflux/v1/client.proto` ~163-165, ~341-343).
- **Daemons present the key in `DaemonEnrollRequest` via a new `string join_key = 9`.** Additive, so no protocol version bump (`docs/RELEASING.md` ~151); regenerate TS, Rust and Swift with `cd proto && buf generate`. Rejected: resurrecting `DaemonEnroll` / `daemon_enroll = 1` — reserved in `daemon.proto` (~283-288) and forbidden by `scripts/check-protocol-breaking.mjs` (no exceptions).
- **The server branches inside the existing `daemonEnrollRequest` handler, after protocol-version, rate-limit and field validation and before a pending authorization is minted.** A present key is consumed atomically; on success the device is created **by the same code path link authorization uses** — factor the device-creation tail out of `redeemPendingAuthorization` (device cap, `randomUUID()` device id, `ck_dev` credential, `store.createDevice`, `registerDaemonConn` with `daemonEnrolled`) into one function taking the account id and the enroll request's device info, used by both. On rejection the server answers with an explicit error the worker can distinguish ("join key invalid, expired or already used") and does **not** fall through to a pending link. Rejected: falling back to a link on a bad key — the product promise is "the command either joins or tells you why", and a silent fallback reintroduces the paste-back flow. Based on: `apps/server/src/hub.ts` ~2077-2139 (`daemonEnrollRequest`), ~3767-3798 (`redeemPendingAuthorization`), ~832-894 (`registerDaemonConn`).
- **The key reaches the worker through a one-time file, never through `settings.json` or the service unit.** `cofluxd up --key` writes `{COFLUX_HOME}/join-key.json` (or similar) with mode 0600; the worker reads it only on the "no credentials" enroll branch (both the initial send and the renewal resend), and deletes it as soon as the server answers — on success and on rejection. Rejected: `settings.json` (persists, and the desktop also writes that file) and an env var in the launchd plist / systemd unit (persists in a world-readable-ish unit file). Based on: `crates/worker/src/creds.rs` ~38-61 (`pending-auth.json` precedent, 0600), `crates/worker/src/main.rs` ~1305-1327 (enroll vs auth branch) and ~1375-1406 (renewal resend), supervisor passes its whole environment to the worker (`crates/supervisor/src/manager.rs` ~375-401).
- **Rejection has its own wire message, never `DaemonAuthError`.** Add a `ServerToDaemon` oneof member `DaemonJoinKeyRejected { string reason = 1; }` on a fresh field number; the server sends it and then closes the socket. Old workers never send `join_key`, so they never receive it. The worker handles it by logging, deleting the key file, recording the outcome, and **not exiting** — its ordinary reconnect backoff (`main.rs` ~1172-1183, ~1268) then produces a keyless enroll (link flow) as the fallback. Rejected: reusing `DaemonAuthError` — its `need_enroll:false` branch is `std::process::exit(1)` (`main.rs` ~1625-1627), which launchd/systemd would restart forever; and matching on its message string. (revised on plan audit)
- **The worker, not cofluxd, classifies the outcome, in one 0600 outcome file.** The worker knows whether it presented a key on this connection, so it writes `{COFLUX_HOME}/join-outcome.json` (name is the executor's call) with one of: `joined` (after `daemonEnrolled`), `rejected` + reason (after `DaemonJoinKeyRejected`), `unsupported` (a `DaemonAuthorizePending` arrived in answer to an enroll that carried a key — an old server ignored field 9). The key file is deleted on **any** of these three answers, so the renewal resend (`main.rs` ~1394) can never re-present it. `cofluxd up --key` removes any stale outcome and `pending-auth.json` before (re)starting the service (the worker clears `pending-auth.json` only at connection end, not on SIGTERM — `main.rs` ~1508, ~845-848), then polls **only** `credentials.json` and the outcome file: joined → 「已接入」, exit 0; rejected → the reason plus 「在 Coflux 的添加设备里换一个密钥」, exit non-zero; unsupported → 「服务器还不支持接入密钥」, exit non-zero; key file still present while `pending-auth.json` appears → the installed daemon binary predates join keys (`applyAndStart` keeps existing binaries: `ensureBinaries({ skipIfPresent: true })`, `cofluxd.mjs` ~428) → tell the user to run `cofluxd update`, exit non-zero. It never enters the 11-minute link wait when `--key` was given; its wait is bounded (e.g. 2 minutes after the service starts, plus any first-install download). (revised on plan audit)
- **`cofluxd up --key` always restarts a running service.** macOS already unloads/loads (`cofluxd.mjs` ~411); Linux runs `systemctl --user enable --now` (~415), a no-op for an active unit, so an unregistered daemon left over from the link era would not see the key until its next link renewal (~10 minutes). The `--key` path restarts the unit explicitly on both platforms. (revised on plan audit)
- **A key is never re-presented.** After any answer the key file is gone; a later `need_enroll=true` (credentials revoked) re-enrolls keylessly. `cofluxd up --key` on a machine that already has `credentials.json` prints that it is already connected (and to which server/device) and changes nothing — it does not write the key file.
- **No new failure budget for daemons.** Keys are 192-bit random tokens; the existing per-IP `enrollLimiter` on `daemonEnrollRequest` bounds guessing. Based on: `hub.ts` ~2080, `config.ts` ~120 (`COFLUX_ENROLL_RATE_LIMIT`). The incoming `join_key` is length-bounded (the existing bounded-text validation) before hashing. Minting itself gets a per-account `FixedWindowLimiter` (pattern at `hub.ts` ~505) so insert/revoke churn is bounded, not only the count of valid rows. (revised on plan audit)
- **Consume, cap check and device creation run in one store transaction**, so a key is never burnt when the device cap rejects the enroll. If `registerDaemonConn` then fails (socket gone), the key is spent and a device row is left behind — the same behaviour the link flow has today; acceptable, note it in a code comment. (revised on plan audit)
- **Desktop dialog: the Headless tab owns one key per dialog opening.** Mint on first show of the tab; keep it across tab switches within the opening; 换一个 mints with `replaces` = current key; expiry countdown from the response's `expiresAt`; a mint error shows 「生成密钥失败」 + 重试. Remove `parseAuthorizeInput`, the paste form and its state. Keep `authorizeTokenFromUrl` in `apps/desktop/src/shared/` and `client.authorizeDevice` — both still serve this Mac's automatic local authorization (`apps/desktop/src/main/daemon-files.ts`, `workbench.tsx` local auth effect). Prompt text and command stay in the pure `add-device-view.ts` module with its unit test updated (the test currently asserts link-era phrases such as `/authorize/` and `cofluxd status` polling — replace them with key-era assertions: the key and `--server` appear in both prompt and command, no `/authorize/`, prompt is short, e.g. a line-count bound).
- **A new black-box test file guards the key semantics** (AGENTS.md criterion: a key that works twice, outlives its hour, or lands in the wrong account is invisible while using the product). Cases: a minted key enrolls a raw daemon into the minting account; the same key a second time is rejected; an expired key is rejected; a key replaced via 换一个 is rejected; a key minted by account A never yields a device in account B. Own port — existing ones are 8826, 8828, 8829 (`grep -h "PORT = " tests/src/*.test.mjs`). Harness helpers `rawDaemon`, `authorizeDaemon`, `spawnDaemon` live in `tests/src/harness.mjs`. Requirements on the test, all (revised on plan audit):
  - **Cross-account needs a second account, which today's harness cannot make**: local auth mode has exactly one account (`hub.ts` ~3513-3535). Add a `startStack` option that, between `waitHealth` and `verifyServerIdentity` (`harness.mjs` ~812-814), spawns `scripts/create-user.mjs` as a child process against the stack's test database, with `serverEnv: { COFLUX_AUTH: "password" }` — process-level, so the suite stays black-box. Check the password-mode fail-closed secrets (`apps/server/src/config.ts` ~16-20) and supply test values. This harness change is in scope.
  - **Expiry** uses a server TTL knob (e.g. `COFLUX_JOIN_KEY_TTL_MS`, default one hour) set only for a second, sequential `startStack` on the same port after the first stack's `stop()` — not a file-wide short TTL, which would make the other cases timing-sensitive.
  - **The happy path and the rejection path also drive a real daemon**, not only `rawDaemon` (a bare WebSocket never exercises the worker): `mkdtemp` a second home, write the key file, `spawnDaemon({ ...daemonEnv, COFLUX_HOME: home2 })` (`harness.mjs` ~310), and assert `credentials.json` appears / the key file is gone / after a rejection the process group is still alive and the outcome file says `rejected`.
  - Raise `COFLUX_ENROLL_RATE_LIMIT` via `serverEnv` in this file: 12 per minute per IP is tight for several enrolls from 127.0.0.1.
- **Rollout order is server first.** Migration 8 is one-way. An old server ignores field 9 and hands the daemon a pending link; the worker records that as `unsupported` (see the outcome-file decision) and `cofluxd up --key` says so and exits non-zero instead of hanging. (decided while planning)
- **Prompt copy never sends the user back to links.** Confirm success with `cofluxd status` showing the machine registered; if `cofluxd up` fails, the agent reports its error to the user. The prompt must not mention links or `/authorize/`, even as a fallback. (revised on plan audit)
- **The mint request/response follows the store's existing request-id pattern** (`packages/client/src/store.ts` ~739-750 and ~1185-1197, `notificationList` requestId + timer), not the single-flight `authorizeDevice`. (revised on plan audit)

## Direction

Layers, in dependency order: protocol contract → server → worker + cofluxd → desktop dialog → black-box test. Milestones are strictly sequential (each consumes the previous one's contract); one work package, do not fan out.

### Milestone 1: Protocol and server

`client.proto` mint request/response and `DaemonEnrollRequest.join_key` exist, generated code for all three targets is committed and consistent; migration 8 creates the key table; the server mints (with replace and cap), consumes atomically, and enrolls by key through the shared device-creation path, rejecting bad keys explicitly. Validation: `cd proto && buf lint && buf generate` leaves no diff; `node scripts/check-protocol-breaking.mjs "../.git#ref=1e101fa0,subdir=proto"` run from `proto/` passes; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0; `cargo test -p coflux-protocol` passes.

### Milestone 2: Worker and cofluxd

`cofluxd up --key` writes the one-time key file, starts the service, waits for credentials or a recorded rejection, and exits accordingly; the worker presents the key only on the enroll branch, deletes it on any answer, records rejections without exiting, and never re-presents a key; already-registered machines ignore `--key` with a message; `cofluxd --help` documents `--key`. Validation: `cargo build` with zero warnings; `cargo test -p coflux-protocol`; `COFLUX_HOME= cargo test -p coflux-worker` passes.

### Milestone 3: Desktop dialog

Headless tab per the product conclusions; paste UI gone; short prompt; unit tests updated. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`.

### Milestone 4: Black-box test

The new test file covers the five cases above and passes with the rest of the suite. Validation: `pnpm -C tests test` (acceptance tier — runs real processes).

## Landmines

- Reserved protocol names/numbers: `client_create_enrollment_key` (ClientToServer 4), `enrollment_key_created` (ServerToClient 3), `daemon_enroll` (DaemonToServer 1). The breaking check has no exceptions (`scripts/check-protocol-breaking.mjs` ~27-35), and CI also fails if any of the three generated directories differ after `buf generate`.
- The migration ledger is checksummed and gap-checked (`schema-migrations.ts` ~786-790, ~1623-1643): append version 8, never edit 1–7.
- `--server` in `cofluxd` takes the daemon WebSocket URL (`wss://…/daemon`), not the https URL; the dialog already computes it with `daemonServerUrl(SERVER_URL)`.
- `cofluxd up` currently waits only when `credentials.json` is absent (`packages/cli/cofluxd.mjs` ~440) and its link wait lasts 11 minutes (~454-477); the `--key` path needs its own, much shorter wait and must also tolerate the first-install binary download before the service starts.
- The CLI never speaks the protocol (`cofluxd.mjs` ~452-453) — everything it learns comes from files the worker writes under `COFLUX_HOME`.
- `startStack()` in `tests/src/harness.mjs` authorizes every daemon through the link flow (`authorizeDaemon` ~653-683); factoring device creation must keep that path byte-for-byte equivalent, or every black-box file breaks.
- Pending authorizations are cleared when the daemon's socket closes (`hub.ts` ~2677-2685); a key enroll registers immediately and never enters that map — make sure no pending entry is created for it.
- `DaemonAuthError.need_enroll=true` clears credentials and re-enrolls (`main.rs` ~1613-1628); the key file must already be gone by then.
- Ports in `tests/src` are hardcoded; two suites cannot run on one machine at once.
- `DaemonEnrollRequest` is built as a struct literal in `crates/protocol/src/wire_tests.rs` (~571-582) and `crates/worker/src/main.rs` (~1317, ~1394); `cargo build` / `cargo test` fail until `join_key` is added there — expected, in scope.
- Enrollment docs that still describe links as the only path: `docs/auth-design.md` (~46-48) and `packages/cli/README.md` (~48-50) — update them to mention `--key`.
- Device-cap and rate-limit rejections already exist on this path (`hub.ts` ~2080, ~3772-3781); a key must not be consumed when the device cap rejects the enroll — or, if consumption happens first, the plan's executor must decide and document which; prefer checking the cap before consuming.

## Scope

In scope:
- `proto/coflux/v1/client.proto`, `proto/coflux/v1/daemon.proto` and the three generated trees (`packages/protocol/src/gen`, `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`)
- `apps/server/src/**` (hub, store, migrations, config)
- `crates/worker/src/**`, `crates/protocol/src/**` (only as needed for settings/wire tests)
- `packages/cli/cofluxd.mjs` (and its README/help text)
- `packages/client/src/**` (mint call in the store)
- `apps/desktop/src/renderer/components/workbench/add-device-dialog.tsx`, `add-device-view.ts`, `add-device-view.test.ts`
- `tests/src/` (new test file; `harness.mjs` gains the second-account option — required, see the black-box decision)
- `scripts/create-user.mjs` only if the harness needs it to accept a database URL argument
- `docs/` only where enrollment is documented (e.g. `docs/deployment.md` or architecture notes mentioning the enroll flow)
- `wiki/plans/README.md`, this plan

Out of scope:
- Server authorization pages (`apps/server/src/auth-pages.ts`) — browser authorization stays as is
- The desktop's local daemon management and automatic local authorization (`apps/desktop/src/main/**`)
- `crates/supervisor`, service unit templates (`packages/cli/service-unit.mjs`)
- The iOS / Swift client beyond regenerated protocol code
- Dropping the legacy `enrollment_keys` table

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint + codegen consistency | `cd proto && buf lint && buf generate`, then `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | exit 0; empty output once the regenerated trees are committed |
| Protocol breaking check | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=1e101fa0,subdir=proto"` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust build | `cargo build` | exit 0, zero warnings |
| Rust tests | `cargo test -p coflux-protocol && COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Black-box suite (acceptance) | `pnpm -C tests test` | exit 0, including the new file |

## Done criteria

- [ ] All commands pass.
- [ ] A minted key enrolls a daemon into the minting account; reuse, expiry, replacement and cross-account cases are rejected — asserted by the new black-box file, whose happy and rejection paths run a real daemon (not only `rawDaemon`).
- [ ] After a rejection the real daemon's process group is still alive, the key file is gone and the outcome says `rejected` — asserted by the black-box file.
- [ ] `cofluxd up --key` classifies joined / rejected / unsupported / daemon-too-old from the outcome file and `credentials.json` only, exits non-zero on every failure, never enters the 11-minute link wait, and restarts an already-running service on Linux too.
- [ ] No key is ever written to `settings.json` or a service unit; the key file is deleted after the server answers.
- [ ] The dialog has no paste input or link copy; the prompt is short (a handful of lines) and contains the key and `--server`; 换一个 revokes the previous key; expiry is shown.
- [ ] Link-based authorization (`cofluxd up` without `--key`, browser pages, this Mac's local auto-authorization) still works — the existing black-box files that go through `startStack()` pass.
- [ ] Migration 8 appended; 1–7 untouched; no reserved proto names or numbers reused.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] A row for this plan in `wiki/plans/README.md` carries the final status.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (e.g. the supervisor or service units).
- The breaking check rejects an additive change for a reason other than a reused name/number.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Plan audit (fable, 2026-09-24) verified every cited `file:line` and raised seven points; all were adopted (entries marked `revised on plan audit`): a dedicated rejection message instead of the `exit(1)` path, a worker-written outcome file with old-server and old-binary detection, an explicit restart on Linux, a second-account harness option, real-daemon coverage of the rejection path, scoped codegen/TTL commands, and smaller items (bounded key text, one transaction for consume+cap+create, per-account mint limiter, prompt never pointing at links, request-id pattern, docs to update).

- Release notes must say: the server must be deployed (migration 8, one-way) before the cofluxd release that knows `--key`; old cofluxd versions keep working through links.
- The desktop dialog only offers the key path, so until the server is deployed and cofluxd released, the Headless tab cannot actually add a machine on a real account — the walkthrough needs a local stack (`pnpm dev:pg`, `pnpm dev:server`, `pnpm -C apps/desktop dev`, a local `cofluxd up --server ws://localhost:8787/daemon --bin-dir target/debug --key …`).
- Keys live one hour; expired rows accumulate. A periodic or opportunistic cleanup of expired/used rows is welcome but not required.
