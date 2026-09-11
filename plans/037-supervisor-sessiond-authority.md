# Plan 037: Evolve the supervisor into a native sessiond

> This plan is an outcome contract, not a function-by-function script. Understand
> the requirements and recorded decisions, then design the implementation against
> the live code. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat febdd62..HEAD -- crates/supervisor/src crates/supervisor/Cargo.toml crates/protocol/src/ipc.rs crates/worker/src/dec_modes.rs tests/src/dec-modes-replay.test.mjs`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: refactor
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

Evolve the supervisor from “PTY + 200KB raw scrollback + global pause” into a native sessiond. Independently of the worker, center, or client, it continuously consumes PTY output and maintains recoverable VT grid/history, a session catalog, monotonic output sequences, a single-holder lease, and exit tombstones. Attach atomically returns a normalized ANSI snapshot followed seamlessly by deltas. No slow transport may freeze the Agent process.

## Decisions & tradeoffs

- **Structured terminal state replaces the byte ring**: use a mature Rust VT parser to retain bounded logical-line history, viewport, cursor, SGR, alternate screen, and input modes. Reject keeping the raw ring, which truncates UTF-8/escape sequences arbitrarily (`crates/supervisor/src/sessions.rs:114-121`). The worker currently restores only DEC private modes and explicitly ignores SGR (`crates/worker/src/dec_modes.rs:1-7`, `crates/worker/src/dec_modes.rs:143-147`).
- **Validate compatibility before committing to a parser**: prefer the lightweight parser dependency frozen by plan 036, but verify wide/combining characters, truecolor, cursor, wrapping, erase, alternate screen, bracketed paste, and resize using xterm/Agent corpora. If it fails, do not build a partial emulator by piling on handwritten patches.
- **Bound retention by complete logical lines**: make the history limit configurable and impose a global memory budget. Choose defaults from multi-session memory and attach benchmarks. Reject unlimited disk persistence and byte-wise trimming.
- **Serialize authority per session**: PTY parsing, sequence advancement, attach registration, holder changes, and input deduplication share one serialized boundary, eliminating the gap between snapshot capture and subscription. The current global `Mutex<HashMap<...>>` (`crates/supervisor/src/sessions.rs:27-35`) is not the foundation for these concurrency semantics.
- **Slow consumers lose deltas; PTYs never pause**: bound delivery state per logical channel, mark a gap on overflow, and request a snapshot. Remove global PTY backpressure driven by worker queues. The current pause path stops every reader (`crates/supervisor/src/sessions.rs:102-109`).
- **Bind holders to logical clients, not sockets**: a different client takes over and increments the epoch. A higher transport generation for the same client migrates the channel; reject later input/resize from the old generation.
- **Preserve state across worker restarts**: the supervisor owns catalog, holder, sequence, a recent whole-frame retransmission ring, and unacknowledged exit tombstones. Rebuild local/relay channels after worker resync. This extends existing worker-restart survival guarantees (`tests/src/worker-restart.test.mjs:9-10`).
- **tmux-like survival boundary**: recovery is guaranteed only while supervisor and PTY remain alive. Do not restore processes after supervisor/machine exit; add no disk recordings or CRIU support.

## Direction

### Milestone 1: VT snapshot equivalence

Add pure Rust unit tests and recorded corpora for terminal state. Feed recordings at arbitrary chunk boundaries, serialize an ANSI snapshot, and write it into a reference terminal. Viewport, history tail, cursor, and key modes must match. Validation: `cargo test -p coflux-supervisor sessiond_vt` exits 0.

### Milestone 2: catalog, sequence and atomic attach

The live-session catalog carries self-verifiable fields and the current sequence. In one authority critical section, attach captures snapshot@N and subscribes from N+1. Deltas use contiguous byte offsets, and gaps trigger explicit recovery. Validation: `cargo test -p coflux-supervisor sessiond_attach` exits 0.

### Milestone 3: holder and idempotent input

Verify cross-client handoff, same-client transport migration, stale generation/epoch rejection, input retransmission/deduplication, and latest-wins resize with acknowledged outcomes. Validation: `cargo test -p coflux-supervisor sessiond_holder` exits 0.

### Milestone 4: Fault and Backpressure Isolation

With the worker absent, its writer blocked, or one channel queue full, PTY parsing continues into bounded terminal state. Worker reconnection recovers through catalog/snapshot; retain exit-code tombstones until acknowledged. Validation: `cargo test -p coflux-supervisor sessiond_backpressure` exits 0.

## Landmines

- Supervisor outbound delivery currently uses unbounded `std::sync::mpsc` and one replaceable worker writer (`crates/supervisor/src/main.rs:81-100`). Simply deleting `PtyPause` would replace freezing with unbounded memory growth.
- Ownership of `portable-pty` readers, writers, masters, and children is split across threads/objects. Refactoring must avoid duplicate removal across resize, close, and EOF handling (`crates/supervisor/src/sessions.rs:42-87`).
- A new UDS connection directly replaces the worker writer (`crates/supervisor/src/main.rs:136-148`). During migration, an old connection exiting must not clear the new connection.
- Normalized ANSI snapshots must first reset and restore input modes. The server serializer is a reference (`apps/server/src/mirror.ts:56-60`), but do not introduce Node/xterm into the supervisor.
- Sequences such as images/sixels that cannot be faithfully materialized may pass through live, with documented capability gaps. Never claim they are recoverable.

## Scope

In scope:
- `crates/supervisor/src/**`
- Supervisor unit tests/fixtures within plan 036’s frozen dependencies

Out of scope:
- loopback TCP/WS, browser pairing, central relay
- `crates/worker/src/**`, `apps/server/**`, `packages/client/**`
- Live process recovery after supervisor/OS restart

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Supervisor tests | `cargo test -p coflux-supervisor` | exit 0, zero warnings |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |

## Done criteria

- [ ] All listed commands pass.
- [ ] Unit tests prove snapshot@N plus delta from N+1 has no gaps or duplicates.
- [ ] History trims only at complete logical-line boundaries and has an explicit memory bound.
- [ ] stale holder/transport/input is rejected and will not be written to the PTY.
- [ ] Missing or blocked worker/consumer will not pause the PTY reader.
- [ ] The catalog and exit tombstones provide enough information for worker offline reconciliation.
- [ ] Implementation follows every Decisions & tradeoffs entry.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- Candidate VT parser fails the core Agent/TUI corpus, and replacing dependencies would break the plan 036 contract.
- To ensure correctness, the network/auth logic must be put into the stable supervisor.
- portable-pty cannot host new authority lifecycles without disrupting existing sessions.
- Validation fails twice in a row after a reasonable fix.

## Maintenance notes

sessiond guarantees reconstructable current state, not preservation of every historical raw byte. Future multiple-writer support must extend holder policy without bypassing epoch, generation, or input-sequence checks.
