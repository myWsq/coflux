# Plan 038: Worker loopback gateway and dual transports

> This plan is an outcome contract, not a function-by-function script. Understand
> the requirements and recorded decisions, then design the implementation against
> the live code. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat febdd62..HEAD -- crates/worker/src crates/worker/Cargo.toml crates/protocol/src crates/supervisor/src/main.rs packages/cli/cofluxd.mjs`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: feature
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

The frequently upgraded Rust worker will host a fixed loopback gateway alongside its existing center connection. Normalize local and relay channels into one Device RPC runtime, driving sessiond through plan 036 IPC. While the center is disconnected, persisted browser grants must let paired pages authenticate again with offline session scope only. While online, short-lived leases permit full daemon RPC. After a worker crash/upgrade, rebind the port, restore grants, and resync with the supervisor without disturbing PTYs.

## Decisions & tradeoffs

- **Host the gateway in the worker, not the supervisor**: HTTP/WS, Origin checks, WebCrypto-compatible verification, central leases, and git/fs/exec evolve frequently. The stable supervisor exposes only protected UDS. Releases already contain two Rust binaries (`packages/cli/cofluxd.mjs:1-4`, `.github/workflows/release.yml:95-104`); do not introduce a third resident process.
- **Bind only a fixed loopback port**: default to 8788, explicitly trying IPv4/IPv6 loopback without listening on the LAN. Dev/tests may override through env or bind port 0. Bind failure degrades direct connectivity only; the central connection must keep working.
- **Strict Origin and mutual challenge**: before handshake, reject Origins outside the centrally issued/persisted allowlist. The gateway signs hello with its persistent P-256 key; the browser signs the transcript with its installed grant key. Nonces are single-use, expiring, and rate-limited. Reject wildcard CORS, query tokens, and implicit trust in localhost.
- **Persist grants; keep elevated leases volatile**: atomically store the gateway key and browser grants under `$COFLUX_HOME` with mode 0600. Online leases live only in memory; immediately drop elevated permissions when the central connection disconnects. Offline session grants remain valid until explicit unpairing, accepting delayed central revocation while offline.
- **Central tokens never enter loopback**: browser account tokens and daemon deviceToken must not appear in local handshakes, URLs, logs, or Device frames.
- **One router**: project validation/worktrees, sessions, exec/fs, ports, and other worker capabilities use the same request-ID/op-ID router. Direct and relay supply only principal/channel; do not duplicate handlers. Evolve the existing handlers in `route_authed` (`crates/worker/src/main.rs:745-804`) rather than copying them.
- **Enforce offline scope**: both central connection state and lease validity determine elevated permissions. Offline operations are limited to list/attach/input/resize/stop on surviving sessions. Reject project/task CRUD, all exec/fs, and creation of new PTYs.
- **Independent backpressure per channel**: independently bound queues toward the center, loopback clients, and checkpoints. Slow channels drop deltas and mark gaps. Reject the current global supervisor pause based on total `to_server` capacity (`crates/worker/src/main.rs:239-260`).
- **Checkpoints use a coalescing side channel**: dirty sessions produce bounded viewport/recent-tail snapshots. Keep only the latest pending checkpoint for central upload, never blocking local/relay terminal streams.

## Direction

### Milestone 1: Local identity storage and handshake

Positive and negative unit tests cover gateway/device keys, grant storage, the Origin allowlist, nonce transcripts, and mutual P-256 verification. Authentication works after reload/restart; reject tampering, replay, and wrong origin/daemon/key. Validation: `cargo test -p coflux-worker local_auth` exits 0.

### Milestone 2: loopback gateway life cycle

The worker attempts binding at startup and degrades without exiting on failure. Restart restores service on the fixed port. Explicitly reject incompatible protocol versions so the web can fall back. Validation: `cargo test -p coflux-worker local_gateway` exits 0.

### Milestone 3: Unify Device router and scope

Local/relay requests enter one router. Unit tests cover the offline-grant/online-lease permission matrix, request/op deduplication, response correlation, and stream channels/gaps. Validation: `cargo test -p coflux-worker device_router` exits 0.

### Milestone 4: sessiond resync and independent backpressure

Rebuild catalog/channels after worker-supervisor reconnection. A disconnected center or full queue never sends global pause to sessiond. Checkpoints coalesce and send the latest sequence after recovery. Validation: `cargo test -p coflux-worker transport_backpressure` exits 0.

## Landmines

- `server_loop` is currently the main task and holds a receiver inside the central connection (`crates/worker/src/main.rs:489-525`). Do not nest gateway lifetime inside its reconnect/backoff lifetime.
- The worker currently uses `authed` to gate both background observation and server command routing (`crates/worker/src/main.rs:727-741`). Local offline session capabilities need an independent state machine.
- Supervisor UDS supports one physical worker connection. Multiplex logical channels inside it rather than opening a UDS connection per client. Require at least mode 0600 and prevent an old connection from clearing a newer one.
- `settings.json` contains only server/device/shell settings (`packages/cli/cofluxd.mjs:20-27`). Keep gateway keys, grants, and leases out of user-editable settings.
- WebSocket Origin is a security input: read it from the upgrade header, and never trust an Origin self-reported in a Device payload.

## Scope

In scope:
- `crates/worker/src/**`
- Worker unit tests/fixtures within plan 036’s frozen dependencies

Out of scope:
- server persistence/authorization API
- web WebCrypto/transport router
- LAN/P2P, local UI assets, service worker
- public preview domain name replacement; local reverse proxy is left for independent enhancement after integration

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Worker tests | `cargo test -p coflux-worker` | exit 0, zero warnings |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |

## Done criteria

- [ ] All listed commands pass.
- [ ] gateway bind/authentication failure does not affect central relay availability.
- [ ] A correctly paired page can reestablish a local session channel after central disconnection.
- [ ] Offline elevated RPC is fully rejected, and full Device router is available under online lease.
- [ ] The two transports share handlers, request/op deduplication and session stream semantics.
- [ ] Slow or disconnected worker/hub does not pause supervisor PTY.
- [ ] Secret files use mode 0600; logs contain no sensitive values.
- [ ] Implementation follows every Decisions & tradeoffs entry.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- Mainstream browsers and Rust P-256 signature format are not interoperable and the contract needs to be changed.
- `ws://` loopback server cannot be built on the target Rust platform or forces the supervisor to expose network ports.
- The full RPC router requires trusting an arbitrary workspace root supplied by the browser that is not centrally synchronized.
- Validation fails twice in a row after a reasonable fix.

## Maintenance notes

The gateway transports the central page locally; it is not a new anonymous localhost API. Future local preview proxies or LAN direct connections must reuse the same principal/scope/lease model without opening bypass ports.
