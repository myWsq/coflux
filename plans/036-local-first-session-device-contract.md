# Plan 036: Local-first session/device protocol contract

> This plan is an outcome contract, not a function-by-function script. Understand
> the requirements and recorded decisions, then design the implementation against
> the live code. Run milestone validations only if you are also the verifier;
> delegated executors implement, and the orchestrator validates. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat febdd62..HEAD -- proto packages/protocol crates/protocol Cargo.toml Cargo.lock apps/server/src/hub.ts crates/worker/src/main.rs crates/supervisor/src/sessions.rs packages/client/src/connection.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: migration
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

Freeze an end-to-end Device RPC/stream contract shared by the browser, server relay, worker gateway, and supervisor/sessiond. The same logical connection must switch between loopback and central relay without changing the holder, executing input twice, or losing output undetectably. Define local identity, online elevated leases, session catalog, atomic snapshots, monotonic sequences, idempotent operations, and checkpoints explicitly. This plan establishes only shared boundaries that compile, generate, and remain backward-compatible; it does not change production runtime paths.

## Decisions & tradeoffs

- **Unified end-to-end Device protocol**: browser and worker use the same request/response/event envelope, carried directly for local connections and forwarded by daemon/channel through the center for remote connections. Reject a separate hub adapter for loopback: the existing split client/daemon protocol already makes the server interpret and rewrite each request (`apps/server/src/hub.ts:130-139`, `apps/server/src/hub.ts:898-905`), and another copy would drift permanently.
- **Protobuf remains the sole wire source of truth**: generate TS/Rust/Swift bindings for every new cross-process/cross-language message from `proto/`; do not handwrite mirrored types. Based on `packages/protocol/src/index.ts:1-9` and `crates/protocol/src/lib.rs:1-14`. Reject a JSON-only local protocol.
- **sessiond owns session authority**: the supervisor owns PTYs, VT grid/history, catalog, output sequences, holder leases, and unacknowledged exit tombstones. The worker handles only transport/auth/RPC. This extends the existing guarantee that worker hot upgrades preserve sessions (`docs/hot-upgrade-design.md:40-45`).
- **Attach uses `snapshot@N + subscribe(N+1)`**: snapshots are normalized ANSI that can be written directly to xterm; deltas carry contiguous byte offsets. Fetch a new snapshot when a gap is detected. Reject unsequenced raw replay: the existing 200KB byte ring truncates at arbitrary byte boundaries (`crates/supervisor/src/sessions.rs:114-128`).
- **A single holder, arbitrated by the daemon**: attaching a different logical client atomically increments the holder epoch and detaches the old client. A higher transport generation for the same client migrates its path without taking control from itself. Input/resize carry the epoch; input also carries a deduplication sequence. Version one excludes tmux-style multiple writers, but the fields must permit future extension. Existing semantics make attach a takeover (`apps/server/src/hub.ts:188-194`).
- **Identity and Permission Hierarchy**: A persistent browser public-key grant permits only list/attach/input/resize/stop for surviving sessions while offline. Git/fs/exec, project/worktree operations, and online lifecycle operations require short-lived elevated leases continually issued while the center is online. Refuse to send center `clientToken` to localhost; it is currently Account-level bearer, stored in web localStorage (`packages/client/src/store.ts:79-93`).
- **Pairing uses mutual public-key proof**: the browser profile and gateway each persist a P-256 key. Both sign a transcript binding origin, daemon, nonce, client instance, and transport generation. While online, the center installs the browser public-key grant on the target daemon. Reject trusting Origin or loopback alone.
- **Fixed loopback endpoint**: production defaults to `ws://127.0.0.1:8788/device`, binding only IPv4/IPv6 loopback. Dev/tests may explicitly override it; fall back to relay if the port is occupied or policy blocks access. A fixed port is necessary because the web cannot read a daemon endpoint file, and installation currently runs one service per machine (`packages/cli/cofluxd.mjs:32-33`, `packages/cli/cofluxd.mjs:139-171`).
- **Prepared operations are idempotent**: for start/stop/worktree operations changing both central metadata and device facts, the center first persists the prepare/op ID, then executes over either transport. The daemon deduplicates by op ID and reports facts. Reject executing on the daemon before registration or executing twice when direct and relay race.
- **Central checkpoints are derived caches only**: sessiond may periodically upload bounded viewport/recent-tail ANSI checkpoints with a sequence number. The center must never treat these as authoritative. Reject requiring every local output byte to traverse the center, as the current continuously consuming mirror does (`apps/server/src/mirror.ts:1-10`).
- **Compatibility scope**: this plan group adds loopback only to desktop web. Mobile remains frozen, receiving only the minimum protocol compatibility needed to build. Exclude LAN/P2P, refreshing or cold-starting the UI while the center is offline, and preserving processes across supervisor/OS restarts.

## Direction

### Milestone 1: Device wire semantic freeze

Add backward-compatible Device envelopes, session streams, local pairing/lease, relay channels, prepared operations, and checkpoint messages. Preserve existing client/daemon field numbers and safely ignore unknown cases. Validation: `cd proto && buf lint && buf generate` exits 0 with no manually edited generated code.

### Milestone 2: supervisor/worker IPC boundary frozen

IPC expresses catalog/attach/snapshot/delta/gap/detached/input/resize/stop across multiple logical channels, holder epochs, transport generations, operation deduplication, and exit-tombstone acknowledgments. Retain old session create/resync semantics until integration completes. Validation: `cargo test -p coflux-protocol` exits 0.

### Milestone 3: Cross-language consumption can be compiled

TS and Rust can construct/parse the key handshakes, snapshots, deltas, relays, and operation round trips. Shared default-port, protocol-version, and size-clamping constants have one unambiguous mapping. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0.

## Landmines

- `buf.gen.yaml` uses `clean: true`, rewriting TS/Rust/Swift output together. Commit all generated output (`proto/buf.gen.yaml:1-13`).
- Existing UDS distinguishes frames from JSON by the first byte `1..=3` (`crates/protocol/src/ipc.rs:90-93`). New protobuf envelopes must not silently collide with this discriminator; make migration record types/versions explicit.
- WebSocket already uses binary protobuf exclusively. Do not add JSON control frames based on obsolete architecture documentation; see `packages/protocol/src/index.ts:4-9`.
- Never hand-edit generated code. Produce protocol changes from proto or the explicit Rust-only IPC source of truth.

## Scope

In scope:
- `proto/**`
- `packages/protocol/**`
- `crates/protocol/**`
- `Cargo.toml`, each crate `Cargo.toml` and `Cargo.lock` required to freeze member dependencies

Out of scope:
- Runtime behavior in `crates/supervisor/src/**`, `crates/worker/src/**`
- Runtime behavior in `apps/server/src/**`, `packages/client/**`, `apps/web/**`
- Production loopback enablement or data migration

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint/generate | `cd proto && buf lint && buf generate` | exit 0 |
| Generated diff | `git diff --exit-code -- packages/protocol/src/gen crates/protocol/src/gen proto/gen/swift` | Only planned expected diffs; exit 0 after submission |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Rust/TS round trips or generated-code checks cover old and new envelopes, without reusing occupied field numbers.
- [ ] The invariant of snapshot/sequence/lease/generation/op ID is unambiguous in protocol comments.
- [ ] The next four work packages can implement independently without modifying the shared schema together.
- [ ] Implementation follows every Decisions & tradeoffs entry.
- [ ] No out-of-scope runtime code changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- A protobuf field number is already occupied, or passing Buf breaking checks requires breaking the published wire format.
- P-256 signatures from WebCrypto and Rust cannot be mutually verified in a stable cross-target format.
- Subsequent work packages require semantics that cannot be expressed without two separate Device protocols.
- Validation fails twice in a row after a reasonable fix.

## Maintenance notes

The Device protocol is a transport-neutral capability protocol and must not have `localhost` exclusive business semantics; loopback is just a transport. If LAN/P2P or tmux-style multiple writers are added in the future, the principal/channel/lease abstraction should be reused instead of creating a new protocol.
