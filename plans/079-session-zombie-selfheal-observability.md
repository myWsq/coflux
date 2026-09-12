# Plan 079: Zombie task recovery, capped upgrade retries, and session-path observability

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat a74f011..HEAD -- apps/server/src/hub.ts apps/server/src/auto-update.ts apps/server/src/transport.ts apps/server/src/store.ts crates/relay/src/main.rs tests/src/harness.mjs`

## Status

- State: **DONE**
- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: self
- Planned at: `a74f011`, 2026-08-17
- Completed at: 2026-08-28, in the **uncommitted audit worktree** (no corresponding commit or release yet)

## Requirement

Users report sessions that are created but remain stuck and unusable. Production diagnosis on 2026-08-17 found a **permanent dead state**, not transient jitter.

The production database had 38 `status=running` tasks, all with `session_id`; the oldest `updated_at` was July 26. They included tasks on `Svend-Mac-mini.local`, offline for seven days, and tasks last updated July 31. Their PTYs were long gone, but center still considered them running:

- Attach fails because the PTY does not exist on daemon.
- Reopening fails because `hub.ts:1840` rejects `status === RUNNING && sessionId` with "Task is already running; attach through DeviceTransport."
- Closing/reopening the tab does not help: the dead state is persisted at center, not frontend.

The root cause is **one lossy source of session-death facts**. `reconcileSessionCatalog` (`hub.ts:356-441`) only restores sessions **present** in the catalog to RUNNING and processes tombstone exits. It ignores tasks center considers RUNNING+sessionId but absent from the complete catalog. Tombstones live in supervisor memory (`device_catalog` reads `self.tombstones` at `crates/supervisor/src/sessions.rs:519`), so machine restart or `cofluxd restart` loses them, leaving center RUNNING forever.

The same diagnosis found two issues that **trigger this state more often**, included here:

- The retry cap at `auto-update.ts:119-125` is ineffective: after cooldown, `rec.count = 0`, so failing machines retry forever. Since August 15, daemon `b5d8d5f7` (YouRan Master) received v0.26.0 50 times without installing it; `bf24034a` received 21 dispatches. Each dispatch replaces worker and disconnects it.
- Session paths have almost no production logs. Diagnosis relied on indirect timestamp evidence, such as 30/30 Caddy reloads aligning with collective daemon disconnects within a second. Lifecycle logs are debug and absent at production info level; session.create dispatch and rendezvous failure branches have no logs. Relay peer-pairing timeouts—265 over three days—lack channelId/role, preventing identification of device or missing peer.

**After implementation**:

1. Full-catalog reconciliation on daemon reconnect sets tasks to EXITED and clears sessionId when center thinks they run but daemon reports no such session. Users can reopen without manual database cleanup.
2. Automatic upgrade dispatches for one daemon/target version have a real cumulative cap, never reset by cooldown; abandonment emits one warn.
3. Future incidents identify device, session, and missing peer directly from production logs rather than timestamp archaeology.

## Decisions & tradeoffs

- **Absence from a full catalog means that PTY no longer exists.** Rejected: waiting for in-memory tombstones lost on restart delegates durable-state convergence to a non-durable component—the original bug.
  Based on: `device_catalog` at `crates/supervisor/src/sessions.rs:519-546` returns a **complete PTY-map snapshot** and all unacknowledged tombstones. PTYs live in supervisor and survive worker hot upgrades, as documented in AGENTS.md.
- **Converge only in the catalog path, never legacy resync.** Add reverse reconciliation only to `reconcileSessionCatalog` (`hub.ts:356`). Leave `reconcileDaemonSessions` (`:1234-1252`) and its "absence is not an exit fact" comment unchanged: old worker `daemon.resync.alive` is not guaranteed complete.
  Based on: `hub.ts:1238-1251`; `requestSessionCatalog` at `:348-350`, issued at every registerDaemonConn (`:308`).
- **Require all three conditions**: matching daemonId and `accountId === daemon.accountId`; `status === RUNNING`; and nonempty sessionId absent from the catalog's complete session set. Rejected: converging every task with sessionId would kill in-flight agent terminal creation, which stores IDLE plus predetermined sessionId before PTY exists.
  Based on: agent creation at `hub.ts:489-505`; client creation at `:1852-1880` stores sessionId only in prepared-operation metadata, not Task.
- **Use raw catalog session IDs, not filtered `live`.** Per-entry validation skips oversized cwd, retainedBytes above 4MB, or malformed pid/cols/rows. Using filtered live would falsely declare valid running sessions absent. Require only `validControlId(session.sessionId)` when collecting the complete ID set.
  Based on: continue branches at `hub.ts:360-376`; MAX_CATALOG_ENTRIES / MAX_CATALOG_PATH_BYTES / MAX_RETAINED_CATALOG_BYTES at `:83-85`.
- **False positives self-heal.** If a live PTY was omitted, the next catalog's existing forward reconciliation restores RUNNING (`hub.ts:392-395`). The failure mode is an extra reopen click, not killing a live PTY. **Only center persistence and mappings change; never send any daemon close instruction.**
- **Record unknown exitCode as null**, never fabricate 0 or -1. `store.updateTask` with `exitCode: undefined` writes null.
  Based on: `exitCode: number | null` at `apps/server/src/store.ts:78` and the `"exitCode" in patch` branch at `:920-924`.
- **Leave prepared operations alone.** Reverse reconciliation only updates EXITED/sessionId=undefined/exitCode=undefined, clears center sessions mapping, and broadcasts. Existing `expirePreparedOperations` TTL converges unfinished operations for that sessionId. Rejected: `finishPreparedOperationFromExit` needs a real unknown exitCode and couples independent state machines.
  Based on: exit path at `hub.ts:410-434`; TTL paths at `:672,708,737`.
- **Cap upgrades permanently per daemonId+version within the server lifetime.** Stop at autoUpdateMaxAttempts unless target version changes, already part of the key. Cooldown permits only remaining attempts and never resets counts. Tradeoff: transient failures can stop automatic upgrades for this **server lifetime**; attempts is an in-memory Map, so restart permits retries. This is acceptable: a machine failing 13 times is unlikely to benefit from 50 more disconnections. Warn once per key, not on every poll.
  Based on: key/reset at `auto-update.ts:116-131`; config.ts:160-161 defaults maxAttempts=3, cooldown=1h, poll=10min.
- **Change logging per location, not by globally promoting debug to info.** Production has 67,000 lines over seven days; do not increase volume by an order of magnitude. Follow milestone 3's exact table. Keep `catalog reconciled` (`hub.ts:441`) and `daemon resync` (`:1251`) **debug**: production saw 14,315 daemon authentications/reconnects in three days.
  Based on: production `journalctl -u coflux-server` counts.
- **Use WS close-event code/reason for daemon disconnected.** Extend attachEndpoint's `onClose(ctx)` callback signature, updating daemon and client endpoints. Heartbeat termination via `ws.terminate()` yields 1006, distinguishable from normal peer closure.
  Based on: `ws.on("close")` at `apps/server/src/transport.ts:58-66`; sweep termination at `:71-84`.
- **Include channelId and role in relay pairing-timeout logs.** Both already exist in that function; no new state needed.
  Based on: claims/role/channel_id at `crates/relay/src/main.rs:41-42` and timeout at `:287-293`.

## Direction

The three milestones are independent; suggested order puts the primary fix first and supporting work afterward.

### Milestone 1: Zombie task recovery on daemon reconnect

After existing forward reconciliation and tombstones, inspect this daemon's tasks. For those meeting all three conditions, set EXITED, clear sessionId and center sessions mapping, and broadcast. Log info **only when convergence occurs**, including daemonId, taskId, sessionId, and count. Reuse `store.listTasksByDaemon(daemonId)`.

Black-box test: create a session whose tombstone is subsequently lost by restarting the entire daemon process tree, including supervisor. Killing only worker is insufficient because supervisor retains PTY/tombstones. Reuse `COFLUX_HOME` to reconnect with the same device identity, then assert RUNNING→EXITED and cleared sessionId. Harness has stopDaemon but no restart (`tests/src/harness.mjs:428`); extend within scope as needed. Removing reverse reconciliation must make the test fail.

Validation: `node --test tests/src/<new-test>.test.mjs` exits 0; removal of implementation fails it.

### Milestone 2: Effective upgrade retry cap

Stop permanently after cumulative dispatches hit the daemonId/version cap. Never reset at cooldown; emit one abandonment warn per key.

The existing "bad version retries are capped by backoff" test at `tests/src/auto-update.test.mjs:151` observes only 4.8s with 60s cooldown, so it cannot catch this bug. Add/adapt a test that **crosses cooldown**, setting `COFLUX_AUTOUPDATE_COOLDOWN_MS` to seconds, and assert total dispatches remain maxAttempts rather than three per cooldown. Preserve the old `=== 3` assertion.

Validation: `node --test tests/src/auto-update.test.mjs` exits 0.

### Milestone 3: Session-path observability

Make only these changes:

| Location | Current | Target |
| --- | --- | --- |
| `hub.ts:1196` session started | debug | info with sessionId/taskId/pid |
| `hub.ts:1209` session exit | debug | info with sessionId/exitCode |
| `hub.ts:441` catalog reconciled | debug | **Keep debug** |
| `hub.ts:1251` daemon resync | debug | **Keep debug** |
| session.create failure at `hub.ts:1844-1850`: daemon offline, workspace absent, project deleting; prepared limit at `:685-687` | Client error only | warn with daemonId/taskId |
| Prepared-operation failures/timeouts: `failPreparedWaiters` at `:739`, waiter timeout at `:776-780` | None | warn with operationId/daemonId/kind |
| All relay/P2P rendezvous fail branches in handleDeviceRelayConnect / handleDeviceP2pOffer / handleDeviceP2pChannelOpen at `:1932-2060` | Client error only | warn with daemonId/reason |
| `hub.ts:1356` daemon disconnected | info without reason | info with close code/reason |
| Relay peer-pairing timeout at `crates/relay/src/main.rs:292` | No identifiers | Include channelId/role |

Extend transport.ts onClose beyond ctx and update both endpoint consumers.

Validation: server tsc --noEmit exits 0; `cargo build -p coflux-relay` exits 0 with zero warnings.

## Landmines

- `hub.ts:360-376` filters live with continue. Determine absence from raw catalog.sessions IDs, never the filtered map.
- Agent creation at `hub.ts:489-505` stores IDLE+sessionId before PTY exists. Omitting RUNNING would disrupt every agent terminal creation.
- Legacy resync at `hub.ts:1238-1251` is not complete; preserve its absence-is-not-exit rule.
- Forward reconciliation at `hub.ts:380-383` skips EXITED sessions whose exit was recorded by prepared operations. This does not conflict with reverse reconciliation, which clears sessionId, but preserve those conditions.
- Passing existing auto-update test `:151` does not prove the cap across cooldown.
- `stopDaemon()` at `harness.mjs:428` nulls ref.daemon and cannot restart; stack.stop() also deletes temporary directories. Preserve COFLUX_HOME for identity reuse.
- New test files need unused exclusive PORT values under AGENTS.md harness rules.

## Scope

In scope:
- `apps/server/src/hub.ts`
- `apps/server/src/auto-update.ts`
- `apps/server/src/transport.ts`
- `crates/relay/src/main.rs`, only milestone 3 timeout logging; the sole production-code change outside server
- `tests/src/harness.mjs` restart support as needed
- New/adapted `tests/src/*.test.mjs`
- `plans/079-*.md`, `plans/README.md`

Out of scope:
- `crates/supervisor`, `crates/worker`: existing full-catalog semantics suffice; changing them requires a new argument
- `packages/client`, `apps/web`, `apps/mobile`, `apps/ios`: exploration found recovery complete—setControlOnline(true) rebuilds all lanes, recovery caps at 5s, closeLane has no leak; the stuck state is elsewhere
- `proto/` and both protocol packages: no wire additions
- Production Caddy config: exploration already added `stream_close_delay 5m` to four reverse_proxy blocks and reloaded
- Root cause of daemon `YWR07M6KQ1` reconnecting 13,637 times in three days: requires evidence from that Mac
- One-off cleanup of 38 production zombies: each converges on its daemon's next reconnect

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Relay build | `cargo build -p coflux-relay` | exit 0, zero warnings |
| Full black-box integration | `pnpm -C tests test` | exit 0; two existing cli-doctor local-environment failures are unrelated baseline |
| Single black-box file | `node --test tests/src/<file>.test.mjs` | exit 0 |

## Done criteria

- [x] Server tsc and relay build pass with zero relay warnings.
- [x] Black-box coverage proves full-daemon restart/tombstone loss converges RUNNING+sessionId to EXITED with cleared sessionId; persisted snapshot exitCode remains unknown.
- [x] Dispatches stay capped at autoUpdateMaxAttempts across old cooldown windows with one abandonment warning; only new target version or server restart restores allowance.
- [x] Every milestone 3 logging row is implemented; catalog/resync remain debug.
- [x] Reverse reconciliation only conditionally updates center, calls dropSession, and broadcasts; no sessionClose/sessionStop sent to daemon.
- [x] Zombie and cross-cooldown regression tests exist. The latter uses a raw daemon observer to count server→daemon workerUpgrade frames, not downloads after supervisor's latest-only coalescing.
- [x] All decisions followed; concurrency audit strengthened read-then-unconditional-write into a store-level atomic UPDATE with account/daemon/status/session predicates.
- [x] Execution expanded scope only to conditional queries/updates in `apps/server/src/store.ts`. Other uncommitted audit work shares the worktree; do not attribute its entire diff to 079.
- [x] `plans/README.md` marks status and explicitly records uncommitted results.

### Completion record (2026-08-28)

- Milestone 1: reconcileSessionCatalog uses raw IDs passing validControlId, scans this daemon's RUNNING tasks, and atomically converges through exitRunningTaskIfSession with four ownership/version predicates. `tests/src/session-zombie.test.mjs` SIGKILLs the supervisor/worker tree, reconnects using original COFLUX_HOME, and verifies EXITED, cleared sessionId, and persisted snapshot.
- Milestone 2: AutoUpdater's `(daemonId, version)` counts never reset with time; it stops at the cap and warns once. A lightweight raw daemon observer watches workerUpgrade at the dispatch boundary, proving no fourth frame after attempt=1/2/3 across multiple old cooldowns. `tests/src/auto-update.test.mjs`: 2/2 pass.
- Milestone 3: added session start/exit, session.create/prepared failure, relay/P2P rejection, daemon close code/reason, and relay pairing-timeout context. High-frequency catalog/resync remain debug.
- Validation: Rust/TS build gates, targeted zombie test, and auto-update 2/2 passed. Final full suite on 2026-08-28: **exit 0, 129/129 pass, 0 fail, 0 skip**; Node reported 228056ms; wall time including pretest approximately 3m58s.
- Implementation, tests, and plan closure remain in the **uncommitted audit worktree**. DONE means the outcome contract is implemented, not committed, tagged, deployed, or effective in production.

## STOP conditions

- A cited fact changes, especially device_catalog no longer returning a full snapshot, invalidating the criterion.
- Convergence cannot be implemented without changing reconcileDaemonSessions.
- Out-of-scope changes are required, especially supervisor/worker or proto additions.
- A validation command fails twice after one reasonable fix.
- Negative verification fails: the test still passes after implementation is removed.

## Maintenance notes

- This fixes only **RUNNING+sessionId** zombies. Agent creation can also leave **IDLE+sessionId** forever if PTY never starts (`hub.ts:489-505`). It avoids the `:1840` guard and does not appear as the reported stuck state, so remains deferred. Investigate this path if permanent IDLE ghost terminals appear.
- The 38 production zombies converge on their own daemon's next reconnect. Offline devices such as Svend-Mac-mini.local retain them until returning, correctly: center must not decide an offline device's PTY liveness.
- Retry caps live in attempts Map and reset on server restart. For a machine that stops upgrading after failure, check restart history and the abandonment warning.
- The full diagnosis evidence—30/30 second-aligned reload/disconnects, 265 pairing timeouts, and age distribution of 38 zombies—is outside code. Milestone 3 prevents repeating that archaeology.
- Production `stream_close_delay 5m` **only delayed collective disconnect by five minutes**, rather than eliminating it: reload at 05:16:14 on 2026-08-17, five daemons disconnected together at 05:21:14. It gives in-flight rendezvous/attach a grace period and separates disconnects from deployment spikes. Actual elimination requires removing coflux from the `/etc/caddy/Caddyfile` shared with cc-host into an independent ingress; no plan exists yet.

### Original source references

`hub.ts:1234-1252`, `hub.ts:348-350`, `hub.ts:308`, `hub.ts:1852-1880`, `hub.ts:83-85`, `hub.ts:672,708,737`, `apps/server/src/auto-update.ts:116-131`, `hub.ts:739`, `hub.ts:1932-2060`.
