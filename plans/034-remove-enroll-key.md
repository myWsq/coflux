# Plan 034: enrollKey removal across all layers - browser authorization becomes the only enrollment path

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 98ae2c2..HEAD -- proto/ crates/protocol/ crates/worker/ apps/server/src/ packages/client/src/ packages/protocol/src/ apps/web/src/ packages/cli/cofluxd.mjs tests/src/`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: plans/033-worker-connection-resilience.md (DONE)
- Category: refactor
- Execution: subagent sonnet
- Planned at: `98ae2c2`, 2026-07-23

## Requirement

Device enrollment currently supports the classic enrollKey flow (`DaemonEnroll`), browser authorization (`DaemonEnrollRequest`, the Tailscale-style flow from plan 003), and compatibility behavior where `enrollKey: ""` in settings.json selects browser authorization. Browser authorization is the only recommended path, including for headless devices: users can open the link on another device. enrollKey now adds only historical baggage: another CLI option and interactive prompt, mode 600 for settings.json to protect the key, a key-issuing dialog in the web client, an `enrollment_keys` server table, two protocol messages, and a three-way worker branch. There are no existing automated users, so removal is cheapest now (user decision: remove it completely, 2026-07-23).

Required outcomes:

1. Enrollment has one path: a daemon without credentials connects and sends `DaemonEnrollRequest`; the user authorizes it in a browser, and the server sends `DaemonEnrolled`.
2. Remove every enrollKey/enrollment-key code path from the protocol, server, web client, shared client package, worker, CLI, and tests. Documentation may retain historical design records.
3. Keep the web "Add Device" entry, but replace key generation with installation instructions: `npm i -g cofluxd && cofluxd up`, followed by browser authorization.
4. All black-box tests pass. The harness automatically completes the real authorization flow instead of silently enrolling through `COFLUX_ENROLL_KEY`.

Correctness boundary: remove the feature end to end. Removing CLI options while retaining server tables and protocol branches would implement the rejected "CLI out, protocol in" approach from dev-explore.

## Decisions & tradeoffs

- **Remove messages and oneof fields from the proto source of truth, reserve their field numbers, and regenerate all three languages with `cd proto && buf generate`.** Remove `DaemonEnroll` (:12-14) and `daemon_enroll = 1` (:95) from `proto/coflux/v1/daemon.proto`; remove `ClientCreateEnrollmentKey` (:27,:161) and `EnrollmentKeyCreated` (:200-202,:283) from `proto/coflux/v1/client.proto`. Use `reserved` so future messages cannot reuse these numbers and conflict with old daemons. Rejected: ignoring messages only at the application layer while retaining the protocol, contrary to complete removal. Evidence: `proto/buf.gen.yaml` uses v2 with `clean: true`, generating TS into `packages/protocol/src/gen`, Rust into `crates/protocol/src/gen`, and Swift into `proto/gen/swift`.
- **Retain `DaemonAuthError.need_enroll`.** Its true branch means invalid credentials: clear them and reauthorize. That live path is independent of enrollKey. The worker’s false branch currently calls `exit(1)` with "enrollment key invalid" (`crates/worker/src/main.rs:656-663`). Audit every server send site: remove false sends if they belong exclusively to classic enrollment, but retain the worker’s `false → exit(1)` fallback for unrecoverable authentication errors and update its log wording.
- **Worker: reduce three enrollment choices to two.** If `credentials.json` exists, send `DaemonAuth`; otherwise send `DaemonEnrollRequest`. Remove `Config.enroll_key`, the settings `enroll_key` field (`crates/protocol/src/settings.rs:10`), and comments describing empty-string pass-through in `pick`. Evidence: the current three-way branch is at `crates/worker/src/main.rs:526-550`.
- **Server: remove creation of the `enrollment_keys` table, all three associated methods, and the seed.** Sites include `apps/server/src/store.ts:117,299-319`, `hub.ts:297` (daemonEnroll), `hub.ts:697-699` (clientCreateEnrollmentKey), `config.ts:50` (`COFLUX_ENROLL_KEY`), and `plugins/store.plugin.ts:35` (startup seed upsert). Do not add a migration to drop the existing production table; see Maintenance notes.
- **Web/shared client: replace key issuance with installation guidance.** Remove `enrollCommand`, the `enrollmentKeyCreated` case, and the `createEnrollmentKey`/`clearEnrollmentCommand` APIs from `packages/client/src/store.ts` (:48,:98,:278-280,:363,:409-414,:446). Change `EnrollmentDialog` in `apps/web` (`workbench/dialogs.tsx`) to static instructions: `npm i -g cofluxd && cofluxd up`, then open the link printed by the daemon in a browser to authorize it. Keep the "Add Device" button (`workbench.tsx:243,320`). Rejected: deleting the entry entirely, since new users still need device setup guidance.
- **CLI: remove only enrollKey-related behavior.** Remove `--enroll-key`, writes of the `enrollKey` settings field, the onboard key prompt, and the enrollKey branch in `waitForAuthorization`. Command restructuring (removing onboard/reload and adding doctor) belongs to plan 035, keeping this change bounded. Once settings.json no longer contains a key, the executor may relax or retain mode 600; retaining it is simpler and harmless.
- **Harness: have startStack automatically complete the real authorization flow.** Start the daemon without `COFLUX_ENROLL_KEY`; it connects and sends enrollRequest. A test client with local-mode credentials waits for `daemonAuthorizePending` or reads pending-auth, extracts the token from the authorization URL (`authorize.test.mjs:35` already provides `tokenFromUrl`), sends `device.authorize`, and waits for the daemon to become online. Put this in a shared harness helper so every `startStack` caller benefits. Remove the `enrollKey: ""` compatibility cases in `authorize.test.mjs` (:45,:184) along with empty-string semantics. Rejected: inserting devices or fabricated credentials.json directly into the DB, which violates black-box testing through real processes and wire protocols. Evidence: `tests/src/harness.mjs:245,254-255` currently depends on `COFLUX_ENROLL_KEY`; `LOCAL_ENV` in `authorize.test.mjs:25` includes the server-side variable.
- **(Decided during planning) Boundary with plan 035:** this plan must leave argument-free `cofluxd up` and browser authorization fully functional. Plan 035 changes only the command surface and doctor, with no further protocol/server work. Proto regeneration, harness migration, and UI changes already reach the manageable limit of one REVISE loop.

## Direction

Start with proto changes and regeneration: compiler errors identify affected callers. Then update Rust, server, shared client/web, CLI, and finally the harness and tests. Follow the historical AGENTS.md requirements: matching protocols, zero Cargo warnings, Chinese comments, and a frozen mobile app except for minimal repairs if shared changes break its build.

### Milestone 1: Protocols and Rust-side removal

Delete proto messages, reserve field numbers, and regenerate all three languages. Implement the worker’s two-way enrollment branch and remove the settings field. Validation: `cargo build -p coflux-supervisor -p coflux-worker` → exit 0 with zero warnings; `cargo test -p coflux-protocol` → exit 0.

### Milestone 2: server + shared client + web delete

Remove enrollKey from hub/store/config/plugin and the client store API; replace EnrollmentDialog with installation guidance. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` and `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0. Keep mobile compiling (`node_modules/.bin/tsc -b apps/mobile/tsconfig.json`, if that entry exists), making only minimal repairs if needed.

### Milestone 3: Remove the CLI enrollKey interface

Remove `--enroll-key`, the settings field, and interactive branches; preserve argument-free `up`. Validation: `node --check packages/cli/cofluxd.mjs` → exit 0.

### Milestone 4: harness authorization flow transformation + full testing

Add the startStack automatic-authorization helper and update affected tests. Validation: `pnpm -C tests test`, run by the orchestrator for acceptance → all 60+ tests pass.

## Landmines

- `buf.gen.yaml` uses `clean: true`, so regeneration clears output directories. Confirm that generated directories contain no hand-written changes (none are currently expected).
- Empty-string pass-through in `pick()` (`crates/worker/src/main.rs`) and the default `enrollKey: ""` written by `cofluxd.mjs` jointly select browser authorization. Remove both sides together. Confirm that `Settings::load` tolerates unknown fields: serde’s default behavior should allow old settings.json files containing `enrollKey: ""` to load.
- Every one of roughly 60 tests shares `startStack` in `harness.mjs`. Races in the authorization helper will make the whole suite flaky. Reuse the proven waitFor sequence from `authorize.test.mjs` rather than inventing polling.
- Cross-account tests in `tests/src/security.test.mjs` may depend on enrollment keys selecting an account (`hub.ts:297`, `accountForEnrollmentKey`). After migration, ownership comes from the authorizing user’s session. Verify that the tests retain their original isolation semantics.
- Update `docs/auth-design.md` to describe the current single path while retaining its historical account of the three-path evolution.
- Production runs an older worker (v0.9.0). An old daemon with valid credentials continues to use `DaemonAuth` unaffected. An unregistered old daemon sending `DaemonEnroll` with an enrollKey will no longer be recognized: the removed oneof decodes to an empty payload and is discarded. This incompatibility is accepted because no such devices exist; add no compatibility layer.

## Scope

In scope:

- `proto/coflux/v1/daemon.proto`, `proto/coflux/v1/client.proto` and three sides generated artifacts (`packages/protocol/src/gen`, `crates/protocol/src/gen`, `proto/gen/swift`)
- `crates/protocol/src/settings.rs`, `crates/worker/src/`
- `apps/server/src/` (hub.ts, store.ts, config.ts, plugins/store.plugin.ts)
- `packages/client/src/`
- `apps/web/src/components/workbench/` (workbench.tsx, dialogs.tsx)
- `packages/cli/cofluxd.mjs` (enrollKey interface only)
- `tests/src/` (harness.mjs and affected test files)
- `README.md`, `docs/auth-design.md` (enrollKey mention)
- `apps/mobile/` (minimal fix only when shared layer changes break the build)

Out of scope:

- cofluxd command restructuring (onboard/reload/doctor)——plan 035
- DROP of the `enrollment_keys` table in the production database - manual operation during deployment (see Maintenance notes)
- `crates/supervisor` — not related to registration

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build (zero warnings) | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, no warnings |
| Rust protocol testing | `cargo test -p coflux-protocol` | exit 0 |
| server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| CLI syntax check | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| Black-box testing (acceptance) | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Searching the repository for `enroll` finds no live enrollment-key paths outside documentation history and plans/. Retain `DaemonEnrollRequest`, `DaemonEnrolled`, and the browser authorization flow itself.
- [ ] The web "Add Device" displays the installation guide, and there is no longer any key generation interaction.
- [ ] harness follows the real authorization flow, and is fully tested without regression.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Migrating harness authorization would require changing the semantics of more than three existing tests. This indicates a faulty helper assumption: stop and report instead of forcing assertion changes.

## Maintenance notes

- After production deployment, `enrollment_keys` becomes an orphan table. Manually confirm that rollback is no longer needed before running `DROP TABLE enrollment_keys`. This is low priority; leaving it is harmless.
- Never reuse the reserved proto field numbers: daemon.proto oneof 1, and client.proto oneof 4 / oneof 3.
- `DaemonEnrollRequest` and `DaemonEnrolled` remain live browser-authorization messages. Their names resemble the removed classic `DaemonEnroll`; do not delete them accidentally.
