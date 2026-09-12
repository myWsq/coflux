# Plan 009: Protobuf as the protocol source of truth and binary wire format

## Background and decision-making

Maintaining four protocol representations—TS types, the TS validation table, Rust serde, and the future Swift client—is unsustainable. Decision agreed with the user on 2026-07-15:

- **Source of truth**: `proto/` (independent sub-project, Buf management), `coflux/v1/{common,daemon,client}.proto`.
- **Generate all three languages:** TS (protobuf-es v2) → `packages/protocol/src/gen`; Rust (prost) → `crates/protocol/src/gen`; Swift (swift-protobuf) → `proto/gen/swift`, to be moved into the app directory once the macOS project is approved.
- **Make an atomic breaking wire-format change, with no old/new coexistence:** all daemons and clients are under our control.
  - Old: JSON text frame (internal tag `type` + camelCase) + custom binary frame (kind 1..4).
  - New: **Every WS message is binary and contains one protobuf envelope:** `/daemon` uses `DaemonToServer`/`ServerToDaemon`; `/client` uses `ClientToServer`/`ServerToClient`. PTY/proxy data is an ordinary envelope oneof payload, always represented as `bytes`.
  - protojson is only used for log debugging, not wire.
- **Retain the Rust daemon** (CLI language issues decoupled from source of truth, idea of migrating to TS is shelved indefinitely).

## Key points of semantic mapping (compare with old protocol)

- Preserve the message set and semantics 1:1. Split bidirectional `device.authorizeInfo` into `DeviceAuthorizeInfoRequest` (C→S) and `DeviceAuthorizeInfoResult` (S→C); rename `error` to `ServerError`.
- `TaskStatus`/`FsEntry.type` is changed from string to proto enum (DB storage is still string, hub does mapping).
- Use `double` for timestamps (such as `created_at`, milliseconds since epoch) and `FsEntry.size` : Keep the JS number semantics of old JSON and avoid the type ripple of protobuf-es int64→bigint.
- `timeout_ms` narrowed to `uint32`; `cols/rows/port` to `uint32` (Rust side clamped to u16).
- Replace decoded-string PTY payloads with `bytes`, making replay and live output naturally byte-consistent. Remove the old byte-level `replayFrameToOutput` hack. xterm.js `write(Uint8Array)` and SwiftTerm `feed(byteArray:)` support this directly.
- Protobuf decoding supplies structural validation; remove the handwritten `isValid*` tables. Discard and log decoding failures and unknown oneof cases.
- The UDS IPC (`crates/protocol/src/ipc.rs`) of supervisor⟷worker is an internal protocol of the process and is **not moved**.

## Stages and gates

1. **Proto modeling and generation:** `buf lint` passes; `buf generate` outputs are committed at each consumer. ✅
2. **TS migration:** refactor `packages/protocol` into generated code plus envelope helpers; migrate `apps/server` and `apps/web` completely. Gate: both `tsc --noEmit` checks report zero errors.
3. **Rust migration:** retire `crates/protocol` wire.rs in favor of prost-generated types. **Retain frame.rs:** it still serves supervisor-worker UDS traffic, including PTY data and hot-upgrade transfer. Changing it would require supervisor changes. The worker converts between UDS frames and WS protobuf envelopes. Gate: `cargo build` has zero warnings and `cargo test` passes.
4. **Black-box migration:** replace the inline codec in `tests/src/harness.mjs` with generated envelopes from `packages/protocol`. These types derive from the protocol source of truth, not application implementation, preserving black-box testing. Adapt every case. Gate: `pnpm -C tests test` passes.
5. **Release**: version bump (breaking, 0.x mainline jump version) + tag trigger release.yml (cross-compilation + ed25519 signature worker + GitHub Release).
6. **prod-jp deployment test**: server/web/daemon is fully updated; smoke: daemon online, task creation, terminal IO, disconnection replay, port forwarding.

## CI Governance

- Add `buf lint` and `buf breaking --against '.git#branch=main,subdir=proto'` to ci.yml. Commit generated artifacts and require zero diff after regeneration in CI to prevent manual edits.

## Risk and rollback

- Atomic switching means that the old and new versions are not interoperable within the deployment window: the server and the daemon must be upgraded in the same batch (on prod-jp, both are on the same machine, and the window is extremely short).
- Rollback = deploy old version binary/static resources (no DB schema changes in the protocol, the data layer is not affected).
