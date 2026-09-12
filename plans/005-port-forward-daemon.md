# Plan 005: Daemon port detection in PTY process trees and TCP tunnel bridging

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- crates/worker crates/protocol Cargo.toml Cargo.lock`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: plans/004-port-forward-protocol.md
- Category: feature
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

Add two capabilities to the worker (`crates/worker`), using the `crates/protocol` contract implemented by plan 004 as the source of truth:

1. **Port detection:** about every 2s, enumerate TCP LISTEN ports in each live PTY session’s process tree, rooted at the shell pid reported by the supervisor. When the set changes, send a complete `ports.update` snapshot containing only sessions with ports. Exited sessions and closed ports disappear on the next scan. Unsupported platforms or insufficient permissions degrade silently to an empty set without affecting other functionality.
2. **TCP tunnel bridge:** on `proxy.open { connId, port }`, connect to local `127.0.0.1:port` and reply with `proxy.opened {ok:true}` or `{ok:false,error}`. Bridge TCP bytes bidirectionally to kind=4 ProxyData frames multiplexed by connId. Send `proxy.closed` when TCP closes or fails; on server `proxy.close`, close TCP and clean up. Concurrent connections remain independent. Close all tunnels and clear their state when the server WS disconnects.

Correctness boundary: detect **only** ports opened within PTY session process trees. Never report unrelated machine processes, system services, or manually started processes. This is a product security boundary, not an optimization.

## Decisions & tradeoffs

- **Root detection at the PTY shell pid and traverse descendants.** Obtain pids from UDS `SessionStarted.pid` and `ResyncList`, extended by plan 004. Rejected: scanning all machine ports and filtering afterward, which cannot reliably attribute ports to sessions and violates the boundary of exposing only task-started services. Evidence: `SessionStarted`/`SessionInfo` in `crates/protocol/src/ipc.rs` after plan 004.
- **Use /proc on Linux and libproc on macOS.** On Linux, recursively read `/proc/<pid>/task/*/children`, match LISTEN entries in `/proc/net/tcp{,6}` to socket inodes in `/proc/<pid>/fd`, and attribute them to the process tree. On macOS, use the `libproc` crate (proc_listchildpids and socket fd information). Both operate without privileges on processes with the same uid; other platforms return an empty set. Rejected: spawning `lsof` every 2s, since minimal containers may lack it and process overhead/parsing are fragile; also reject a broad detection crate whose dependencies exceed the need. The platform code is small enough to test independently.
- **Report complete snapshots only when ports change.** Keep the last `session→ports` snapshot. Equal sets send nothing; changed sets send the full snapshot, which the server handles idempotently (006). After successful authentication on reconnection, always resend the current full snapshot so a server restart cannot lose state. Rejected: unconditional periodic noise and incremental diffs, whose two-sided state machines are more complex and less self-healing.
- **Forward tunnel data in chunks of at most 64KiB; omit per-connection flow control in V1.** Each TCP read produces a frame. Accept that one busy tunnel can fill `to_server` and trigger global PtyPause (see Landmines). Development previews have modest traffic; prioritize a simple correct implementation and record per-connection credit as follow-up work. Rejected: implementing window flow control immediately, with substantial protocol/state-machine cost and unclear benefit. Evidence: the server’s 4MiB `maxPayload` (`apps/server/src/config.ts:68`) comfortably exceeds 64KiB; existing backpressure is in `crates/worker/src/main.rs:133-151`.
- **Scope all tunnel state to one server connection.** The connId-to-task-handle/sender map is aborted and dropped when `run_server_connection` exits. Do not restore tunnels across reconnection: browser TCP connections are already gone. Evidence: the existing connection lifecycle in `crates/worker/src/main.rs:296-398`.

## Direction

Separate detection and tunneling into modules such as `ports.rs` and `tunnel.rs`, integrated with the worker’s tokio select loop. Add `proxy.open`/`proxy.close` branches to `route_authed`. Detection reads live sessions and pids, available after plan 004, and sends text messages through `to_server_tx`; tunneling sends binary frames through the same channel.

### Milestone 1: Port detection module + unit test

Given a pid, enumerate TCP LISTEN ports in its process tree. A unit test may spawn a child listener using `python3/node -e`, since forking after binding `std::net::TcpListener` on 127.0.0.1:0 is impractical; alternatively, verify that querying the test process’s pid finds a port bound within the test. Validation: `cargo test -p coflux-worker` → exit 0, with detection passing on native macOS.

### Milestone 2: Periodic scanning + ports.update reporting access event loop

Resend complete snapshots on changes and after authed; remove ports after session exit. Validation: `cargo build -p coflux-worker` with zero warnings. Plan 007 provides behavioral black-box validation.

### Milestone 3: Tunnel Bridge Complete Life Cycle

Cover proxy.open → connect → opened → bidirectional bytes → either-side closure → closed/cleanup, and clear all tunnels on WS disconnection. **Binary routing:** send server frame kinds 1..=3 to the supervisor as before, and kind=4 to the tunnel module. Replace main.rs’s unconditional forwarding (see Landmines). Validation: `cargo test -p coflux-worker && cargo build -p coflux-worker` → exit 0 with zero warnings. A local tunnel unit test can drive mock frames against a TcpListener.

## Landmines

- `crates/worker/src/main.rs:382-387` currently forwards every server Binary frame to the supervisor through `to_sup_tx`. Without dispatch by kind, ProxyData is packed into UDS records, rejected as an invalid PTY frame, and silently lost.
- Global backpressure monitors `to_server_tx` (`crates/worker/src/main.rs:133-151`) and pauses every PTY at three-quarters capacity. Busy tunnels can trigger this accepted V1 tradeoff. Do not bypass it with a separate sink: that would break the single ordered WS write path.
- `/proc/<pid>/task/*/children` requires kernel CONFIG_PROC_CHILDREN (open for all mainstream distributions); You can fully traverse the ppid of `/proc/*/stat` to build a reverse tree. The executor can choose, but pay attention to the 2s cycle. The cost of full traversal.
- `/proc/net/tcp` inode matching: the same socket may be referenced by multiple fds (after fork), deduplicate the port set; v6 listening (`::`) also counts (node/vite is always bound to v6 wildcard by default) - only the port number is reported, the address family is not distinguished. When the daemon connects to a loopback, it will first try 127.0.0.1 and then try [::1] (or `proxy.open` directly the connection to localhost is resolved by the operating system, and the executor decides, but it must be ensured that the v6-only listening service is reachable).
- When detecting the periodic task holding lock and reading `WorkerState.alive`, be careful not to hold `std::sync::Mutex` across await (The existing code style is to take a snapshot and release it, see `main.rs:315,448-457`).

## Scope

In scope:
- `crates/worker/src/**` (new module + main.rs event loop/diversion changes)
- `Cargo.toml`/`Cargo.lock` (only the libproc class dependency of macOS is added)

Out of scope:
- `crates/protocol` — The contract has been frozen by 004; if a gap is found, stop and report instead of expanding the agreement on its own.
- `crates/supervisor` — Tunneling and detection do not involve PTY
- `apps/server`, `apps/web`, `tests/`, docs - owned by plans 006/007

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust unit test | `cargo test -p coflux-worker -p coflux-protocol` | exit 0 |
| Build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Black-box regression (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 (existing tests have no regressions) |

## Done criteria

- [ ] All listed commands pass.
- [ ] Native (macOS) unit test proves: the listening port started in the test can be detected with its parent pid as the root; Ports for non-child processes are not detected.
- [ ] The Linux path code is complete (compilable, logic has been code reviewed; running verification belongs to 007/Docker).
- [ ] Tunnel unit test proves that bidirectional byte transparent transmission and shutdown propagation under connId multiplexing are correct.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md`  status is updated.

## STOP conditions

- 004 The implemented protocol is missing fields/messages and cannot express detection or tunneling semantics.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- macOS unprivileged detection fails (libproc cannot get its process socket information) - this overturns the detection decision, A report is required for re-decision (such as downgrading to a solution other than "daemon's own uid full port ∩ process tree").

## Maintenance notes

Per-connection credit/window flow control remains known debt: one busy tunnel can pause all PTYs. Add it before supporting arbitrary TCP forwarding beyond HTTP previews. The 2s scan interval and 64KiB chunk size are empirical values that can be tuned without protocol changes.
