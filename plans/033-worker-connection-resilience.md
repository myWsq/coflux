# Plan 033: worker connection resilience (self-healing of half-open connections) + observable connection status

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 16aad36..HEAD -- crates/worker/src/main.rs packages/cli/cofluxd.mjs tests/src/ apps/server/src/transport.ts apps/server/src/config.ts`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `16aad36`, 2026-07-23

## Requirement

Production incident (2026-07-23): device LVR96VXW43’s worker remained stuck on a half-open TCP connection for more than 12 hours without reconnecting. The corporate network silently dropped the long-lived connection without RST or FIN. Server-side ping/pong checks detected the dead connection and called `ws.terminate()` (`apps/server/src/transport.ts:73`), but the worker had no corresponding mechanism: no active ping, no read timeout, and `stream.next()` could remain pending forever. Meanwhile, `cofluxd status` checked only whether the launchd process was alive and displayed "Running". The user saw a healthy status while the device had actually been offline for half a day.

Required outcomes:

1. When the worker’s connection to the server dies silently, the worker detects and closes it within minutes, then reconnects through the existing `server_loop` backoff loop (30s cap). No path may remain stuck forever.
2. `connect_async` has a bounded timeout: a blackholed network causes failure and backoff instead of an indefinite hang.
3. The worker persists connection state under `$COFLUX_HOME`, and `cofluxd status` displays that state (Connected/Reconnecting plus duration). A live process is no longer mistaken for an online device.

Correctness boundary: the fix must handle a completely silent peer: no inbound frames and no TCP error. Handling only send errors or relying on server Ping does not solve this incident; the server has already removed the connection, so no more frames will arrive.

## Decisions & tradeoffs

- **Detection: an inbound-frame idle watchdog with an active Ping probe.** Track the time of the last inbound frame in the read loop. After the idle threshold, send a WS Ping. If no frame arrives during the grace period, return from `run_server_connection` and let the existing `server_loop` reconnect with backoff. Any inbound frame proves liveness, so separate Pong tracking is unnecessary. Rejected: relying on server Ping (the server has already removed the connection), or TCP keepalive (coarse timing, inconsistent platform configuration, and no detection of application-level hangs). Evidence: the server sweep interval is 30s (`apps/server/src/config.ts:84`, `COFLUX_HEARTBEAT_MS` defaults to 30_000); `apps/server/src/index.ts:90-93` schedules `sweep()`, which calls `terminate()` on unresponsive connections.
- **Thresholds: send Ping after 75s idle, then allow 10s grace; both must support environment overrides.** The idle threshold is 2.5 times the server heartbeat interval: a healthy connection receives a server Ping at least every 30s, making false positives unlikely. Follow the worker’s existing `env_or`/`pick` configuration pattern (`crates/worker/src/main.rs:177-192`); the executor chooses variable names. Overrides are required for tests to exercise the watchdog in seconds. Rejected: hard-coded thresholds, which make testing impractical, and settings.json options, which users do not need (YAGNI).
- **Connection timeout: wrap `connect_async` in `tokio::time::timeout` (15s, also overridable by environment).** Treat expiry as a connection failure and use existing backoff. Without this bound, a TLS/WS handshake on a blackholed network is a second indefinite-hang path. Evidence: `crates/worker/src/main.rs:477` currently awaits bare `connect_async(&cfg.server_url).await`.
- **Persist connection state in `$COFLUX_HOME/conn-state.json`: `state` (`connecting` | `connected` | `reconnecting`), the time that state began, and the last successful authentication time.** Enter `connected` only after DaemonAuthed/DaemonEnrolled, not when TCP connects: failed authentication still means an unusable device. Start in `connecting`; after disconnection, use `reconnecting`. Rejected: extending `worker.pid`, which has different semantics, or querying WS from the CLI, which violates its zero-protocol principle (`packages/cli/cofluxd.mjs:194` explicitly specifies file-only reads).
- **Ignore conn-state.json when the service process is absent.** The file is a snapshot written during the worker’s lifetime and becomes stale after it exits; display "not running" in that case. For a live process, display its connection state and elapsed time in that state, so `reconnecting` tells users how long the device has been offline. Evidence: `cmdStatus` already checks process liveness (`packages/cli/cofluxd.mjs:283-295`).
- **No protocol changes.** Watchdog Ping/Pong messages are WS control frames, and conn-state is a local file. Leave `crates/protocol` and `packages/protocol` untouched.
- **(Decided during planning) Use the conn-state lifecycle as the primary black-box acceptance surface.** After `startStack()`, wait for `conn-state.json` to become `connected`; stop and restart the server (the harness already provides `restartServer`, `tests/src/harness.mjs:193`) and verify `reconnecting` followed by recovery to `connected`. For the silent-connection watchdog, preferably use a bare TCP server that sends a handwritten HTTP 101 upgrade and then remains silent, with idle thresholds reduced to seconds; assert bounded disconnection and retry. If this is too expensive to implement in the harness, the lifecycle test plus the existing full regression suite is acceptable, but record the omitted watchdog test in the plan status update.

## Direction

Concentrate changes in the worker read/connect loops (`crates/worker/src/main.rs`, `server_loop`/`run_server_connection`), CLI `cmdStatus`, and a new black-box test. Follow the historical AGENTS.md discipline recorded here: zero Cargo warnings, Chinese comments, and all three required checks passing before committing.

### Milestone 1: The worker no longer has a permanent dead path, and the connection state is persisted to disk.

Detect a half-open connection within the idle threshold plus grace, then reconnect. Bound connection attempts and update `conn-state.json` on state transitions. Validation: `cargo build -p coflux-supervisor -p coflux-worker` → exit 0 with zero warnings.

### Milestone 2: cofluxd status shows the real connection status

`cofluxd status` displays connection state (connected/reconnecting plus duration), without reporting a stopped process as connected. Validation: `node --check packages/cli/cofluxd.mjs` → exit 0. Milestone 3 covers behavior through black-box acceptance tests.

### Milestone 3: Black-box test coverage

Add a conn-state lifecycle test under `tests/src/`: connected → server stopped → reconnecting → server recovered → connected. Handle the silent-connection watchdog test according to the decision above. Validation: `pnpm -C tests test` → exit 0, including new tests and the full regression suite.

## Landmines

- `crates/worker/src/main.rs:593` ignores failure from `let _ = sink.send(Message::Pong(p))`. Do not copy that pattern and hide watchdog send errors. Equally, do not use send Err as the sole failure signal: during this incident, writes to the TCP buffer could succeed.
- The read-loop match at `crates/worker/src/main.rs:587` discards `Message::Pong` through `_ => {}`. Refresh the last-inbound timestamp for every `Some(Ok(_))` frame, including Pong; otherwise valid probe responses will not reset the timer and the watchdog will kill healthy connections.
- `run_server_connection` already cleans up pending-auth and tunnels on exit (`main.rs:600-606`). Watchdog disconnection must return through this same path, preserving all cleanup.
- The historical test command is `node --test --test-concurrency=1` (AGENTS.md). New tests must use `startStack()` to create an independent stack rather than sharing another test’s state. Daemon binaries come from `target/debug`; `pretest` rebuilds them after Rust changes.
- `cmdStatus` is synchronous and is reused by `up` (`cofluxd.mjs:185,203`). Keep file reads and display synchronous; changing it to async breaks those callers.

## Scope

In scope:

- `crates/worker/src/main.rs` (watchdog, connect timeout, conn-state placement; if the executor thinks it is clearer to disassemble the small modules, he can add a new file under `crates/worker/src/`)
- `packages/cli/cofluxd.mjs` (`cmdStatus` connection state display)
- `tests/src/` (new test file; if necessary, you can add and modify the auxiliary method of `harness.mjs`)
- `plans/README.md` (status update)

Out of scope:

- `crates/protocol`/`packages/protocol` — Zero changes to the protocol are a decided decision
- `crates/supervisor` —  watchdog has nothing to do with supervisor
- `apps/server`/`apps/web`/`apps/mobile` — The server side mechanism is complete
- cofluxd command restructuring, enrollKey deletion, doctor - belongs to Plan 034 (cofluxd redesign)

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build (zero warnings) | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, no warnings |
| CLI syntax check | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| Black-box testing (acceptance) | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |

(Black-box testing requires local Supabase Postgres 54322 direct connection port, see AGENTS.md; 5432 will report tenant error.)

## Done criteria

- [ ] All listed commands pass.
- [ ] A half-open connection (the peer is completely silent) triggers disconnection and reconnection within the idle threshold + grace; the threshold can be overridden by env.
- [ ] `connect_async` limited time failure, permanent hang is no longer possible.
- [ ] `conn-state.json` is updated with connecting/connected(authed)/reconnecting transitions.
- [ ] `cofluxd status` displays the connection status and duration when the process is present, and ignores the stale file when the process is absent.
- [ ] The new black-box test exists and asserts state transitions, and there is no regression in the full test.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The `run_server_connection` exit path cannot support watchdog disconnection while preserving existing cleanup. This invalidates a structural assumption: stop and report rather than bypassing cleanup.

## Maintenance notes

- The 75s idle threshold is deliberately 2.5 times the 30s server heartbeat interval. Revisit the worker threshold whenever `COFLUX_HEARTBEAT_MS` changes to avoid false positives or slow detection.
- conn-state.json supplies the status data for `status`/`doctor` in Plan 034 (cofluxd redesign). Extend fields compatibly without changing their semantics.
