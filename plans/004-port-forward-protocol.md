# Plan 004: Port-forwarding protocol contract: frames, control messages, and UDS extensions

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- packages/protocol crates/protocol crates/supervisor/src/sessions.rs crates/worker/src/main.rs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

Freeze the protocol contract for HTTP reverse-proxy port forwarding so daemon work (plan 005) and server/web work (plan 006) can proceed in parallel. The daemon detects listening ports in PTY process trees and reports them. The server allocates a short route ID for each (device, port), accessed as `https://<shortId>.<proxyHost>`. Multiplexed binary tunnels between server and daemon carry raw bytes at TCP-connection granularity.

After this plan, the TS and Rust protocol sources of truth contain every new message and frame type, with byte-level consistency and unit-test coverage. The entire workspace compiles; make only minimal caller adaptations, without implementing forwarding behavior.

## Decisions & tradeoffs

- **Add data-plane frame kind=4 (ProxyData):** `[4][cidLen:1][connId:utf8][payload]`, bidirectional between server and daemon, with connId shorter than 256 bytes. Rejected: one WS connection per byte stream, which adds authentication/reconnection complexity to the daemon’s outbound-only model. Existing single-WS multiplexing suffices. Evidence: the one-byte kind is extensible, and both sides discard unknown kinds (`crates/protocol/src/frame.rs:73`, `packages/protocol/src/index.ts:271`).
- **Use control-plane JSON for tunnel open/close and binary frames for data.** Text and binary frames share WS ordering, so close cannot overtake data. Rejected: encoding open/close subtypes inside data frames, which complicates validation, logging, and evolution by mixing control semantics into the data plane. Evidence: the existing PTY control/data-plane split (`docs/architecture.md` §4).
- **New messages on the control plane (synchronized on both sides)**:
  - DaemonToServer: `ports.update { sessions: [{ sessionId, ports: number[] }] }` (Fully idempotent, only sessions with listening ports) ·`proxy.opened { connId, ok, error? }`· `proxy.closed { connId }`
  - ServerToDaemon: `proxy.open { connId, port }` · `proxy.close { connId }`
  - ClientToServer: `proxy.issueAuth { redirect }`
  - ServerToClient: `proxy.auth { ok, url?, error? }` · `ports.updated { taskId, ports: [{ port, url }] }`; add `ports: [{ taskId, port, url }]` to `state.snapshot`. Freeze names and fields at implementation; plans 005/006 only consume this contract. Rejected: incremental port reports. Complete idempotent snapshots match resync conventions and heal after reconnection or missed detection. Evidence: the message whitelist rejects unregistered types (`packages/protocol/src/index.ts:302-338`); Rust drops unknown serde types on deserialization failure (`crates/worker/src/main.rs:401-404`). Freeze both sides before implementation proceeds.
- **Add pid to UDS `ResyncList`.** Introduce `SessionInfo { session_id, task_id, pid }` in ipc.rs and change `ResyncList.sessions` to `Vec<SessionInfo>`. Leave wire.rs `SessionRef` (daemon-to-server resync) unchanged. Rejected: a separate worker query for pids, which adds another round trip and state machine; the resync snapshot is the natural carrier. Evidence: `SessionStarted` already includes pid (`crates/protocol/src/ipc.rs:61`), while `ResyncList` does not (`ipc.rs:65`). Without it, a restarted worker cannot recover the PTY process-tree roots required by plan 005.
- **Keep UDS `is_frame` limited to 1..=3.** The worker handles kind=4 directly; the supervisor owns only PTYs. Adding 4 would misroute tunnel frames to the supervisor. Evidence: `crates/protocol/src/ipc.rs:77-79`, `docs/architecture.md` §8.
- **Minimal compatibility adaptations, with no forwarding implementation (decided during planning).** Populate the actual child pid when the supervisor constructs `ResyncList` (`crates/supervisor/src/sessions.rs` already holds it). Adapt worker types only enough to compile; expanding alive-map values to hold pid is acceptable without changing behavior. TS server/web do not consume the new messages yet. Plans 005/006 own forwarding behavior.

## Direction

The TS source of truth is `packages/protocol/src/index.ts` (types, encodeFrame/decodeFrame, and FIELDS whitelist); Rust uses `crates/protocol/src/{frame,wire,ipc}.rs`. Matching bytes and fields are mandatory. Follow the existing three PTY frame kinds and camelCase tagged JSON.

### Milestone 1: Bilateral frame codec supports kind=4

Add ProxyData support to TS `encodeFrame`/`decodeFrame` and Rust `encode_frame`/`decode_frame`. Rust unit tests cover round trips and truncated-frame rejection. TS has no unit-test framework, so rely on tsc and plan 007 integration coverage. Validation: `cargo test -p coflux-protocol` → exit 0, including the new proxy-frame cases.

### Milestone 2: Control plane message + whitelist + UDS extension implemented, full library compilation green

Define all four message directions consistently in TS unions, FIELDS, and Rust wire.rs enums. Add ipc.rs `SessionInfo` and minimal supervisor/worker adaptations. Validation: `cargo build -p coflux-supervisor -p coflux-worker` with zero warnings, `cargo test -p coflux-protocol`, and `pnpm exec tsc --noEmit -p apps/server` (plus the separate web tsconfig if applicable) → all exit 0.

## Landmines

- The whitelist FIELDS table and type union are two independent lists (`packages/protocol/src/index.ts:302,316`), if any part is omitted, the message will be silently discarded at the transport layer, and the black-box test will time out instead of reporting an error.
- Declare `proxy.issueAuth.redirect` as `string` in FIELDS. Actual URL allowlist validation belongs in the hub (plan 006), not the protocol layer.
- wire.rs uses `rename_all_fields = "camelCase"`, `conn_id` will be serialized into `connId` —TS side the field name must be `connId` (not `conn_id`), and it is locked when writing a unit test.

## Scope

In scope:
- `packages/protocol/src/index.ts`
- `crates/protocol/src/{frame,wire,ipc}.rs`
- `crates/supervisor/src/sessions.rs` (only minimal adaptation of ResyncList to fill in pid)
- `crates/worker/src/main.rs` (only type adaptation, unchanged behavior)

Out of scope:
- Any forwarding/detection/access control behavior implementation - owned by plans 005/006
- `tests/src/` —  owned by plan 007
- docs — owned by plan 007

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust unit test | `cargo test -p coflux-protocol` | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| TS type check | `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web` | exit 0 |
| Black-box regression (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 (existing tests have no regressions) |

## Done criteria

- [ ] All listed commands pass.
- [ ] kind=4 frames can be roundtripped on both sides in TS and Rust, and the connId field name on both sides is consistent with `connId`.
- [ ] New control plane messages exist in all three places: TS type, FIELDS whitelist, and Rust enum.
- [ ] `ResyncList` carries pid and supervisor fills in the real value.
- [ ] No forwarding behavior is implemented (the hub/worker will at most explicitly ignore new messages).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md`  status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- It was found that the TS/Rust frame format cannot achieve byte-level consistency (for example, existing layout conflicts).

## Maintenance notes

Once plans 005/006 consume this contract, it is frozen. Future frame kinds follow the extensible one-byte-kind model, with unknown kinds discarded. Preserve the routing boundary: UDS `is_frame` recognizes 1..=3 for the supervisor; WS kinds 4 and above belong to the worker.
