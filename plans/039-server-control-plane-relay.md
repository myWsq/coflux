# Plan 039: Reduce the server to the control plane and relay

> This plan is an outcome contract, not a function-by-function script. Understand
> the requirements and recorded decisions, then design the implementation against
> the live code. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat febdd62..HEAD -- apps/server proto/coflux/v1 packages/protocol/src apps/server/src/mirror.ts apps/server/src/hub.ts apps/server/src/store.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: migration
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

Reduce the center from an executor of device operations and session-holder semantics to account/device authentication, discovery, project/task metadata, browser pairing, short-lived online leases, prepared operations, opaque Device relay, and checkpoint caching. Direct and relay share identical Device frames. Central failure must not prevent a paired page on the same machine from taking control of a surviving session, but project/task CRUD and elevated daemon RPC remain unavailable offline.

## Decisions & tradeoffs

- **The center owns business metadata, not live session state**: project/workspace/task and authorization records remain in Postgres. sessiond catalog is authoritative for PTY liveness, sequences, holders, and exits. Reject dual-master offline CRUD.
- **Relay authenticates and routes at channel level only**: verify client account, daemon ownership, payload size, rate, and version, then forward Device envelopes unchanged. Do not retain separate pending registries for exec/fs/terminal. Current semantic relays live in `apps/server/src/hub.ts:130-139` and `apps/server/src/hub.ts:460-474`.
- **The center endorses pairing without handling browser private keys**: persist browser public keys and grant metadata. Install/revoke grants on the specified daemon while online, and return the trusted gateway public key, port, and protocol version to the client.
- **Renew short-lived online leases**: issue/install leases only for currently authenticated clients and online daemons in the same account. Stop renewing if the server/daemon channel disconnects. Reject permanent local grants with full privileges.
- **Persist mutations spanning control and device state first**: start/stop/worktree operations persist a non-reusable op ID and target version/CAS before execution. Direct/relay may resubmit the same operation; only daemon facts/acknowledgments complete it. Reject memory-only `PendingRegistry`, which disappears on server restart (`apps/server/src/hub.ts:136-139`).
- **Resync no longer kills unknown live PTYs**: reconcile known tasks from catalog/tombstones. Leave unknown or mismatched sessions as local orphans; neither create business tasks automatically nor send `sessionClose`. The current implementation closes them (`apps/server/src/hub.ts:500-505`), conflicting with local authority.
- **Remove server-side holder authority**: Device channels make the final attach/input/resize decision. The server no longer compares `RuntimeSession.holder` (`apps/server/src/hub.ts:876-895`).
- **Replace mirrors with checkpoint caches**: store the latest verified, bounded ANSI checkpoint for daemon/session/seq. Offline daemon attach can still show a read-only display. Caches may expire or be lost; do not parse live terminal bytes. Reject persistent per-session `@xterm/headless` instances (`apps/server/src/mirror.ts:20-39`).
- **Old paths exist only for migration compatibility**: build-skew admission already permits switching this plan group in one deployment version. Do not maintain two holder/relay authorities indefinitely.

## Direction

### Milestone 1: pairing, grant and lease control plane

Positive/negative tests cover persistence, account isolation, installation/revocation acknowledgments, gateway identity, and lease lifetime. Device deletion/logout converges authorization while online, with offline revocation delay documented explicitly. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0.

### Milestone 2: opaque relay channel

Clean up client/daemon channel open/close/frame state throughout account, daemon, and client-connection lifetimes. The server does not parse Device RPC business oneofs; reject invalid size, ownership, or version. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0.

### Milestone 3: durable prepare and reconciliation

Start/stop operations converge idempotently across server restarts, direct/relay resubmission, delayed acknowledgments, and full daemon catalogs. Never kill unknown live sessions; offline exit tombstones restore actual exit facts. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0; plan 041 covers black-box behavior.

### Milestone 4: checkpoint cache

Accept only monotonically advancing checkpoints for live sessions from the correct daemon. Reject stale, cross-account, and oversized payloads. Serve the last read-only display while the daemon is offline, and degrade safely after server restart or cache misses. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0; plan 041 covers black-box behavior.

## Landmines

- `RuntimeSession` combines routing, holder, closing, startup timeout, and mirror state (`apps/server/src/hub.ts:112-124`). Removing it must preserve task-timeout and port-route cleanup.
- Start currently sends to the daemon and immediately marks the task running (`apps/server/src/hub.ts:1105-1117`). Prepared operations must redefine the crash window, not merely wrap it in a request ID.
- Daemon disconnect currently retains runtime sessions for the mirror. Checkpoint migration must preserve visible task/port semantics: offline is not exited.
- Token storage retains only hashes (`apps/server/src/store.ts:3-5`). Browser public keys are not bearer secrets, but grant/lease IDs and revocation semantics still need explicit definitions. Never persist browser private keys or raw clientToken.
- Public preview TCP tunnels currently depend on server semantic routing. Do not mistakenly move them into web Device channels; existing external URLs must continue working.

## Scope

In scope:
- `apps/server/src/**`
- Server mirror/runtime dependency adjustment in `apps/server/package.json`

Out of scope:
- supervisor/worker implementation
- web loopback/WebCrypto implementation
- moving public preview URLs and proxy access control away from the center
- Offline project/task CRUD

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Existing e2e (acceptance) | `pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All non-acceptance commands pass; acceptance is left to plan 041.
- [ ] relay does not include per-RPC business branches, and account/daemon/channel verification is complete.
- [ ] pairing/grant/lease is durable, revocable and never handles browser private keys.
- [ ] prepared op and full catalog/tombstone converge idempotently after restart/resubmission.
- [ ] unknown live session is not automatically closed by the center.
- [ ] The server no longer has a holder or real-time VT parser; checkpoints are just bounded caches.
- [ ] public preview and existing remote relay behavior have no regressions.
- [ ] Implementation follows every Decisions & tradeoffs entry.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- Device ownership cannot be reliably bound in the channel open phase without parsing the Device payload.
- Prepared operation requires destroying existing task data and has no safe migration path.
- Checkpoint replacement of the mirror will inevitably remove the existing daemon offline read-only screen.
- Validation fails twice in a row after a reasonable fix.

## Maintenance notes

The center remains a trusted control plane without being required on the causal path of every byte. New daemon RPCs should extend the Device protocol and endpoint handlers; server relay must not grow corresponding pending/dispatch branches again.
