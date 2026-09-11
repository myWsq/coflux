# Plan 041: Local-first architecture integration, migration and release acceptance

> This plan is an outcome contract, not a function-by-function script. Understand
> the requirements and recorded decisions, then design the implementation against
> the live code. Run milestone validations only if you are also the verifier;
> delegated executors implement, and the orchestrator validates. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat 0da4edf..HEAD -- proto crates packages apps tests docs README.md packages/cli package.json pnpm-lock.yaml .github/workflows/ci.yml plans/040-web-local-first-device-transport.md plans/042-device-input-ack-contract.md`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/037-supervisor-sessiond-authority.md, plans/038-worker-local-gateway.md, plans/039-server-control-plane-relay.md, plans/042-device-input-ack-contract.md, plans/040-web-local-first-device-transport.md
- Category: tests
- Planned at: `0da4edf`, 2026-07-25

## Requirement

Integrate the completed sessiond, worker gateway, and opaque server relay with the pending input ACK and web DeviceRouter into a releasable local-first architecture. Migrate away from old raw replay, server-side holders, and global pause, eliminating dual authority.

- Same-machine browser→daemon terminal and ordinary Device RPC hot paths bypass the center.
- With the central process/network fully stopped, loaded and paired pages still quickly list/attach/input/resize/stop surviving sessions.
- Direct/relay/worker/control failures recover automatically; input and mutation effects occur exactly once, and output gaps are detectable.
- Independent xterm.js oracles and real Agent/TUI corpora prove sessiond ANSI snapshots restore terminal state.
- Browser compatibility, performance, CLI diagnostics, migration cleanup, and documentation provide release evidence.

This does not guarantee refreshing/cold-starting the UI while the center is offline, or preserving PTYs across supervisor/OS restarts.

## Decisions & tradeoffs

- **One session authority**: only supervisor/sessiond owns PTYs, VT/history, holders, sequences, and exit tombstones. Worker adapts transport/auth; server owns control, opaque relay, and derived checkpoint caches. Old replay/mirror/holder paths exist only during migration and must be removed or explicitly demoted to non-authoritative adapters. Reject indefinite dual writes.
- **Prove exactly-once input through black-box tests**: beyond plan 042 unit tests, disconnect real direct transport before ACK arrival and resend the same input through relay. Observable shell/file effects occur only once; cumulative ACK eventually drains the client queue, and sequence gaps are never skipped. Internal cursor assertions alone are insufficient: the existing wire claims exactly-once but Apply/Duplicate currently has no success response (`proto/coflux/v1/device.proto:307-315`).
- **Use an independent xterm 6 snapshot oracle**: obtain an ANSI snapshot through Device attach from real sessiond. Feed the original recording into `@xterm/headless` 6 oracle A and the snapshot into fresh oracle B; append the same tail to both, then compare public buffer/cell/mode state. Never construct expectations from Rust `vt100` parsing. Current tests verify with the same parser (`crates/supervisor/src/sessiond.rs:784-808`) and cannot reveal shared blind spots.
- **Reproducible, sanitized real corpora**: commit sanitized Claude CLI, Codex CLI, and representative TUI ANSI recordings covering normal/alternate screens, resize, scrolling, Unicode, colors, and sustained output. CI replays fixtures without external login and without prompts, paths, tokens, or user content. Handwritten escape tests alone do not establish Agent-session recoverability.
- **Explicit snapshot-fidelity boundaries**: version one guarantees wide/combining Unicode characters, complete logical-line history, wrapping, cursor position/visibility, normal/alternate screens, application cursor/keypad modes, bracketed paste, 16/256/RGB foreground/background, and bold/dim/italic/underline/inverse. Explicitly exclude sixel/kitty/iTerm images, OSC 8 link metadata, title/icon names, cursor shape/color, blink/strike/invisible/underline variants, and focus/mouse/kitty keyboard state. CellStyle currently retains only the guaranteed subset (`crates/supervisor/src/sessiond.rs:585-613`); documentation must not imply complete restoration of unsupported items.
- **Central failures must be real process/network failures**: stop or isolate the server, then perform catalog, attach, snapshot, input, resize, and stop through loopback. Do not mock an offline flag. The harness uses only real processes and wire protocols, never application-internal objects.
- **Verify failover effects, not message counts**: direct↔relay migration, worker/control restart, and lost ACK/response produce each input/op side effect once. Output recovers from snapshots; the same logical client is not detached. Another client taking over must cause detachment with no automatic reclaim. Existing handoff tests define the single-holder baseline (`tests/src/handoff.test.mjs:14-49`).
- **A slow or broken center must not block PTY progress**: run an Agent/TUI producing heavy output while the central queue is congested. The process completes, and local attach sees its completion marker. Checkpoint loss/lag is acceptable; sessiond/PTY backpressure is not. Queue metrics cannot replace behavioral evidence.
- **Checkpoints provide offline display only**: the center stores the latest bounded derived snapshot with capturedAt/seq. It neither arbitrates holders nor skips the first live snapshot. Migrate the offline-view test to these semantics rather than deleting the capability (`tests/src/offline-view.test.mjs:14-46`).
- **Separate catalog and lifecycle semantics**: absence from a local catalog is not exit; unknown live sessions are orphans. Local stop and central task deletion reconcile separately. Server restart/reconciliation must neither kill orphans nor misrepresent exited sessions as centrally online.
- **The real browser matrix gates release**: test current stable macOS Chrome, Safari, and Firefox for cached direct, first-time no-cache relay/pairing, denied LNA/loopback permission, relay fallback, worker restart, and server outage. Record versions and results. Version one guarantees only loaded, paired pages, consistent with plan 022’s no-service-worker boundary.
- **Reproducible performance SLOs gate release without fragile CI timing gates**: same-machine warm cached direct uses at least 20 warmups and 100 samples. PTY echo p95 must be <20ms; default-history attach to first usable display p95 must be <100ms. Also report maximum-history results. Use a monotonic clock and record machine/browser/build. CI guards functional regression; real desktop measurements decide release readiness.
- **Progressive rollout**: protocol/build mismatch, fixed-port conflicts, and Origin/LNA denial fall back automatically to relay. `cofluxd doctor` separately reports gateway binding, grants, loopback reachability, and central status. A local failure means degraded direct connectivity, not an offline daemon.

## Direction

### Milestone 1: input, holder and transport adversarial testing

Plan 042/040 contiguous ACKs, client queues, session/elevated lanes, and holder semantics pass daemon/client unit tests. Real black-box tests cover disconnect-before-ACK retransmission, sequence gaps, direct↔relay promotion, worker restart, and cross-client takeover. Validation: `cargo test -p coflux-supervisor sessiond_ && cargo test -p coflux-worker && node --import tsx --test packages/client/src/*.test.ts` exits 0.

### Milestone 2: Standalone VT snapshot fidelity

Rust snapshot tests continue to verify internal invariants. Independent xterm oracles, sanitized Agent/TUI fixtures, and black-box comparisons of original stream versus snapshot with an identical tail form the release contract. Document guaranteed/unsupported features in architecture docs. Validation: `cargo test -p coflux-supervisor sessiond_` exits 0; run the independent oracle last during acceptance.

### Milestone 3: Central Failure, Backpressure and Full Device RPC

With the server actually stopped, local catalog/attach/input/resize/stop succeeds. A slow/broken center never freezes PTYs. Terminal, project validation/worktrees, exec/fs, and ports return equivalent results over direct/relay. Preserve checkpoint/orphan reconciliation without granting it authority. Validation: `cargo test -p coflux-supervisor -p coflux-worker && node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0.

### Milestone 4: Browser and Performance Release Evidence

Record real-browser permission, fallback/promotion, and server/worker failure results. Benchmarks record warm cached-direct echo/attach distributions and server Device-frame counts: the direct hot path has zero central data frames. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` exits 0; run the matrix and benchmarks last during acceptance.

### Milestone 5: Migration and release closure

Remove or demote old raw replay, server holder, xterm live mirrors, and dead protocol paths. CLI status/doctor, configuration, builds, release workflow, architecture/ROADMAP/tmux limits, and troubleshooting docs reflect the final architecture. Mobile receives only build compatibility. Validation: `cargo build -p coflux-supervisor -p coflux-worker && node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit && node_modules/.bin/tsc -b apps/web/tsconfig.json && pnpm -C apps/mobile build` exits 0 with no Rust warnings.

## Landmines

- Harness uses temporary HOME, port and process group for each stack; gateway, recording and benchmark must also be used explicitly Temporary port/directory, must not touch the real `~/.coflux` or the resident service (`tests/src/harness.mjs`).
- The local Postgres test must use the 54322 direct connection port; 5432 is the Supavisor pooled port, which will report `no tenant identifier`. Don't mistake environmental errors for architectural regressions.
- The 250KB raw replay of `tests/src/dec-modes-replay.test.mjs:31-50` had a long wait in CI; should be compared after migration the terminal status and attach latency do not continue "waiting for raw marker" as proof of the correctness of the snapshot.
- `@xterm/headless` and `@xterm/addon-serialize` are already server dependencies; Oracle can reuse the locked version, but expected must come from the original recording stream and cannot come from an intermediate state of the Rust serializer under test.
- ANSI fixtures must be saved in binary-safe mode with source/desensitization instructions; recording of real accounts and repo private output is prohibited or Agent conversation content.
- Browser loopback/LNA behavior has not been tested; matrix completion cannot be claimed based on documentation or a single Chromium result.
- If the integration fix touches mobile, only the shared protocol/client build is allowed to be restored, and the desktop route/orphan UI is not allowed to be synchronized.

## Scope

In scope:
- `tests/**`
- `docs/**`, `README.md`, `plans/README.md`
- `packages/cli/cofluxd.mjs`
- `package.json`, `pnpm-lock.yaml`, necessary CI/release configuration
- Fix required plan 036-040, 042 component files for integration, migration and acceptance

Out of scope:
- LAN/P2P, remote direct connection, ICE/STUN/TURN
- service worker, offline UI cold start, native desktop shell
- tmux-style multi-write client
- Live process recovery after supervisor/OS restart
- Added complete terminal emulator for non-guaranteed VT feature
- mobile new features
- push, PR, merge, production deployment

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto governance | `cd proto && buf lint && buf generate` | exit 0, the three language products are consistent |
| Client state-machine | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0 |
| Rust daemon | `cargo test -p coflux-supervisor -p coflux-worker && cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| VT xterm oracle (acceptance) | `node --import tsx --test --test-concurrency=1 tests/src/local-first-vt-oracle.test.mjs` | The guaranteed status of the original stream and snapshot+tail are all equivalent |
| Full black-box suite (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| Browser matrix (acceptance) | macOS current Chrome/Safari/Firefox: cached direct, no cache, permission denied, fallback/promotion, worker/server fault | Record version and all results, no blocking regression |
| Performance (acceptance) | `node --import tsx tests/src/local-first-benchmark.mjs` | echo p95 <20ms, default history attach p95 <100ms, output complete report |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] All listed commands/acceptance passed.
- [ ] With the server completely unreachable, a loaded and paired page can list, attach, input, resize, and stop surviving sessions.
- [ ] warm cached direct attach does not wait for the center's response, and the server cannot observe terminal/ordinary Device data frames.
- [ ] Direct/relay/worker/control failover preserves exactly-once input/op effects, and snapshots automatically recover output gaps.
- [ ] Only cumulative ACK retires input. Prolonged ACK loss produces visible backpressure without silent drops.
- [ ] session lane is not affected by elevated RPC lease/failure; relay will automatically upgrade back to direct.
- [ ] Detachment requires explicit reclaim. Catalog absence never fabricates exit; orphan and lifecycle reconciliation remain correct.
- [ ] An independent xterm 6 oracle with Claude/Codex/TUI fixtures verifies guaranteed fidelity; document unsupported features.
- [ ] Agent/TUI work continues while the center is slow or disconnected; checkpoint lag never backpressures sessiond.
- [ ] Browser matrices have auditable versions/results and cold start boundaries are not exaggerated.
- [ ] Performance meets the SLO; failure blocks release instead of weakening thresholds.
- [ ] The server only holds the checkpoint derived cache and does not hold the holder/real-time VT authority. The old dual authorities have been cleared or explicitly downgraded.
- [ ] CLI doctor, architecture/ops/ROADMAP documentation and release configuration reflect final behavior.
- [ ] Mobile gains no features and still builds.
- [ ] Implementation follows every Decisions & tradeoffs entry.
- [ ] No out-of-scope behavior changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- A component needs to break the frozen plan 036/042 contract and redesign shared semantics.
- Major target browsers block cloud pages from connecting to loopback WebSocket, requiring a native shell or service worker.
- The independent xterm oracle shows that guaranteed fidelity cannot be expressed by the current snapshot, and fixing it requires another complete emulator. Narrow/reconfirm the product guarantee first.
- Exactly-once mutation requires an irrecoverable distributed lock between the center and the daemon, and the existing operation model has no migration path.
- Acceptance requires real user credentials, private Agent sessions, or modifying the installed daemon.
- Any validation fails twice in a row after a reasonable fix.
- Requires production deployment, push, PR or merge to complete.

## Maintenance notes

After this plan group completes, new device capabilities should extend Device endpoints shared by direct/relay, not add paired client↔daemon pending branches in the hub. Snapshot fidelity is a public compatibility contract: add independent oracle/fixture coverage before new guarantees. New transports reuse logical-client, generation, ACK, and holder semantics.
