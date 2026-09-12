# Plan 042: Device PTY input cumulative ACK and contiguous exactly-once contract

> This plan is an outcome contract, not a function-by-function script. Understand
> the requirements and recorded decisions, then design the implementation against
> the live code. Run milestone validations only if you are also the verifier;
> delegated executors implement, and the orchestrator validates. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat 0da4edf..HEAD -- proto packages/protocol crates/protocol crates/supervisor/src/sessiond.rs crates/supervisor/src/sessions.rs crates/worker/src/device.rs Cargo.toml Cargo.lock`

## Status

- Priority: P0
- Effort: M
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: bug
- Planned at: `0da4edf`, 2026-07-25

## Requirement

Define the daemon authority’s successful-input acknowledgment boundary before web/client reroutes PTY input between direct and relay.

The wire claims exactly-once behavior through `input_seq`, but neither first application nor duplicate success currently returns a result. The client draft can only retain input indefinitely, silently dropping the oldest entries above 256 entries or 1 MiB.

After completion, sessiond commits only contiguous input and returns cumulative ACKs. After ACK loss, worker restart, or transport migration, the same logical client can retransmit safely without writing twice or acknowledging unapplied sequence numbers.

This plan defines the ACK and implements daemon production of it. Browser ACK consumption, input-queue backpressure, and UI belong to plan 040.

## Decisions & tradeoffs

- **Transport-neutral cumulative ACK**: add `DevicePtyInputAck` with at least `session_id` and `applied_through_seq`; the authenticated channel implicitly identifies the logical client. Carry no `request_id` and create no permanent result per retry. Reject removing input merely because send succeeded: supervisor Apply/Duplicate currently returns no success response (`crates/supervisor/src/sessions.rs:696-712`).
- **Cumulative cursors are contiguous**: with no cursor, accept only sequence 1. At cursor N, only N+1 may be written; N+2 or greater returns a gap/error without advancing. Reject applying anything greater than N: transport reordering would ACK past permanently lost input (`crates/supervisor/src/sessiond.rs:499-518`).
- **ACK only after a successful commit**: return `appliedThroughSeq` only after PTY `write_all` succeeds and authority commits the cursor. Write/authorization failure returns only the error correlated to the original `request_id`, never advancing ACK. Failed ACK delivery does not roll back PTY input; retransmitting the same sequence obtains another acknowledgment.
- **Every already-committed retransmission returns cumulative ACK**: `input_seq <= appliedThroughSeq` never writes to the PTY and returns the current cursor. A payload mismatch at the current cursor may still be a collision; do not retain unbounded historical payloads to compare older sequences. Reject responding only with `stale_input`: after ACK loss the client needs a safe way to retire the entire committed prefix, whose effects are guaranteed by contiguous commits.
- **Return ACK unchanged on its originating channel**: the worker classifies it as `SESSION_CONTROL` and delivers it only to the logical channel that produced the input. It does not participate in output-cursor/gap coalescing and is not interpreted centrally. Device envelopes already span local/relay with opaque central forwarding (`proto/coflux/v1/device.proto:1-4`, `crates/worker/src/device.rs:1068-1147`).
- **Protobuf remains the sole source of truth**: edit message/oneof fields in `proto/`, then regenerate all TS/Rust/Swift bindings. No handwritten language mirrors. Generation cleans and rewrites all three output trees (`proto/buf.gen.yaml:1-13`).
- **Do not expand resize or operation semantics**: resize keeps only the latest size, and prepared/stop already uses `DeviceOperationAck`. This plan fixes accumulated PTY input that must not be lost. Plan 040 removes silent client queue eviction when it consumes ACK (`packages/client/src/device-router.ts:958-974`).

## Direction

### Milestone 1: wire contracts can be generated across languages

Proto comments unambiguously define ACK fields, cumulative semantics, contiguous sequences, and oneof numbering. All three generated outputs agree, with no existing field-number reuse. Validation: `cd proto && buf lint && buf generate && cd .. && cargo test -p coflux-protocol` exits 0.

### Milestone 2: sessiond forms provable commit boundaries

Test authority handling of first contiguous input, current/older retries after ACK loss, sequence gaps, payload collisions, PTY write failure, stale holders, and stale transports. Only a successful actual write advances the cumulative cursor. Validation: `cargo test -p coflux-supervisor sessiond_` exits 0.

### Milestone 3: direct/relay shared daemon response path

The worker explicitly authorizes and forwards ACK. Test channel isolation, scope filtering, and queue failures without adding server Device-payload dispatch. Validation: `cargo test -p coflux-worker && cargo build -p coflux-supervisor -p coflux-worker` exits 0 with no warnings.

## Landmines

- `DevicePtyInput` currently documents only rejection of lower sequences, with no success acknowledgment (`proto/coflux/v1/device.proto:307-315`). Update those comments when adding cumulative ACK; do not leave conflicting semantics.
- sessiond keys its input cursor by logical `client_instance_id`; channels migrate with generation. Binding ACK to physical direct/relay identity would prevent acknowledgment of earlier effects after failover (`crates/supervisor/src/sessiond.rs:509-523`).
- The worker response-scope allowlist has no ACK case (`crates/worker/src/device.rs:1446-1464`). Accidental forwarding through a default branch is not a complete implementation.
- Never edit generated code manually. `buf generate` with `clean: true` also rewrites neighboring generated artifacts unrelated to this message.

## Scope

In scope:
- `proto/**`
- `packages/protocol/**`
- `crates/protocol/**`
- `crates/supervisor/src/sessiond.rs`
- `crates/supervisor/src/sessions.rs`
- `crates/worker/src/device.rs`
- Protocol generation `Cargo.toml`, crate manifests and `Cargo.lock` when necessary
- `plans/README.md`

Out of scope:
- `packages/client/**`, `apps/web/**` —  ACK consumption and backpressure are implemented by plan 040
- `apps/server/**` —  relay remains opaque and does not interpret ACK
- Black-box browser/failover acceptance: consolidated in plan 041
- Resize ACK, PTY-output ACK, and process recovery across supervisor/OS restarts

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint/generate | `cd proto && buf lint && buf generate` | exit 0, TS/Rust/Swift are all updated |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Supervisor semantics | `cargo test -p coflux-supervisor sessiond_` | exit 0 |
| Worker routing | `cargo test -p coflux-worker` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| TS generated consumers | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit && node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] ACK wire comments specify logical-client, cumulative contiguous-prefix, and failure semantics; commit generated artifacts for all three languages.
- [ ] If N is not committed, N+1 is not written; appliedThroughSeq never reports a noncontiguous prefix.
- [ ] Successful application and retransmission of committed input both produce ACK. Failed PTY writes and stale holder/transport requests neither ACK nor advance the cursor.
- [ ] Both direct and relay only deliver ACK back to the correct channel, and the response scope is `SESSION_CONTROL`.
- [ ] Tests resend an old sequence after ACK loss and verify the current cumulative cursor is returned.
- [ ] Implementation follows every Decisions & tradeoffs entry.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- The logical client/session input cursor boundary of plan 036 has been changed to a different authority by subsequent code.
- ACK requires the server to decode, persist or rewrite the Device payload to work.
- The PTY writer cannot distinguish between successful commits and failures, but can only advance the cursor before writing.
- `packages/client` needs to be changed to allow the protocol/daemon itself to pass the test.
- Any validation fails twice in a row after a reasonable fix.

## Maintenance notes

`appliedThroughSeq` proves only that the current sessiond authority wrote a contiguous prefix to the surviving PTY. It does not promise that the terminal application processed it or produced an echo, and it does not persist across supervisor/OS restarts. Expanding durability requires a separate contract; never silently strengthen this ACK’s meaning.
