# Plan 040: A truly local-first DeviceTransport for web/client

> This plan is an outcome contract, not a function-by-function script. Understand
> the requirements and recorded decisions, then design the implementation against
> the live code. Run milestone validations only if you are also the verifier;
> delegated executors implement, and the orchestrator validates. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat 0da4edf..HEAD -- packages/client apps/web apps/mobile proto/coflux/v1/device.proto crates/supervisor/src/sessiond.rs plans/042-device-input-ack-contract.md`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md, plans/042-device-input-ack-contract.md
- Category: feature
- Planned at: `0da4edf`, 2026-07-25

## Requirement

Make desktop web session attachment and recovery genuinely tmux-like: sessiond, which owns PTYs, VT state, history, and holders, is the local authority. A paired browser connects directly to the loopback gateway to obtain `snapshot@N + delta(N+1)`. The center handles only accounts, discovery, pairing/leases, and remote relay, staying outside the same-machine terminal hot path.

The current DeviceRouter draft switches between direct/relay, but while the center is online it waits for `pair()` before reading the cached grant. All scopes share one active channel, so elevated leases/RPC can drag terminal traffic back through the center. After completion:

- With a cached grant, direct starts immediately and central relay uses only a short hedging delay.
- Without a cache, relay works immediately, pairing runs in the background, and the route then automatically promotes to direct.
- With the center completely unreachable, loaded and paired pages can still list/attach/input/resize/stop surviving sessions.
- Transport migration does not imply holder takeover. Input is neither lost nor applied twice, and an explicitly detached session is never automatically reclaimed.

Refresh/offline cold start is still not guaranteed: the current PWA does not have a service worker, and this plan only promises loaded pages.

## Decisions & tradeoffs

- **Cached direct never waits for the center**: a local grant immediately starts the loopback handshake, without first calling `pair()`, obtaining a lease, or waiting for control WS. Center availability affects only hedging and elevated capabilities. Reject the current “pair first when control is online” branch, which puts a central round trip back into the local attach critical path (`packages/client/src/device-router.ts:311-319`).
- **Short hedge delay; send business traffic only to the winner**: with a cache, direct starts at t=0. If control is authenticated, open relay concurrently after a fixed window no longer than 200ms. The first authenticated channel covering session scope makes the terminal available. Send no attach/input/RPC before choosing a winner, and never let stale contenders overwrite newer state. Use relay immediately if it wins; later direct success may promote the session lane under generation rules. Reject simultaneous attach or continuous hot traffic on both channels, which would cause self-migration and repeated recovery.
- **Without a cache, use relay first and pair in the background**: authenticated control without a local grant immediately uses relay. Pairing/install must not block it. Successful pairing triggers direct probing and migration; failure only updates diagnostics, leaving relay intact. When both center and cache are unavailable, report that honestly instead of inventing local capability.
- **Automatically promote relay back to direct**: while route demand exists, periodically reprobe the local gateway with bounded exponential backoff and jitter. Migrate the session lane when direct recovers. Reject remaining on relay until refresh after one failure; current recovery runs only when the active channel is lost (`packages/client/src/device-router.ts:552-576`).
- **Separate session and elevated lanes**: persistent SESSION_READ/CONTROL channels never wait for online leases. RPC/LIFECYCLE may reuse a channel covering its scope or use a separate short-lived lane, but lease issuance, timeout, failure, or fallback must never replace/close a healthy session lane. Reject the current single `active` channel with highest-required-scope routing, where one exec can move all terminal traffic (`packages/client/src/device-router.ts:133-147`, `packages/client/src/device-router.ts:579-588`).
- **Migrate the logical client without a user takeover**: session-lane direct↔relay migration retains `clientInstanceId`, strictly increases generation, and preserves the holder epoch in sessiond. A `sessionDetached` caused by another client immediately stops automatic attach/input replay; only explicit user action may reclaim it. The current draft retains `desired=true` after detachment and reclaims it during recovery (`packages/client/src/device-router.ts:642-647`).
- **Generation never decreases during router lifetime**: for one tab/clientInstanceId, route release, reset, scope-lane recreation, and contender failure must not reset a daemon generation to zero. Only a new clientInstanceId starts a new sequence. Reject storing generation solely in a deletable DeviceRoute object (`packages/client/src/device-router.ts:133-137`, `packages/client/src/device-router.ts:220-221`).
- **Remove input only on plan 042 ACK**: retain accepted input by sequence until cumulatively acknowledged by `appliedThroughSeq`, replaying in order across migration. At the entry/byte limit, pause or explicitly reject new input and expose the condition; never evict old input. A send returning false must trigger recovery too. Reject silently shifting entries out above 256 entries/1 MiB (`packages/client/src/device-router.ts:958-979`).
- **A displayed checkpoint is not a live resume cursor**: use N as `resume_from_seq` only after that same terminal consumer has actually applied snapshot@N. In version one, the first live attach always receives a complete sessiond snapshot. Central checkpoints may display an offline screen but must not merely seed a route sequence. Reject the current `seedCheckpoint` shortcut that writes only `outputSeq` (`packages/client/src/device-router.ts:936-955`, `packages/client/src/device-router.ts:778-800`).
- **Single-flight gap/attach recovery**: allow at most one attach per session/generation. Repeated gaps, out-of-order deltas, and timers coalesce into one recovery; start another only after response/failure. Reject issuing a new force attach for every bad frame (`packages/client/src/device-router.ts:637-640`, `packages/client/src/device-router.ts:766-772`).
- **Control is online only after authentication**: WebSocket `onopen` proves only TCP/WS establishment. Permit pair/lease/relay after `authOk`; immediately revoke that capability on close/authError/outdated/reset. Do not treat `onopen → connected` as authenticated (`packages/client/src/connection.ts:83-86`, `packages/client/src/store.ts:162-175`).
- **Local catalog expresses local facts only**: explicit `sessionExited` ends a local session; absence from a catalog does not imply exit. Display surviving sessions without central tasks separately as local orphans. Offline stop terminates only the local PTY and records device facts, without fabricating central task deletion. Deleting a central task must not kill a local orphan without a prepared stop.
- **Routes have explicit owners**: probes must not set permanent keepAlive. Only active consumers, desired sessions, pending requests/operations, or explicit retain hold connections. Release closes sockets and clears intervals, retries, and waiters. Reject permanent keepAlive in `probeDevice` (`packages/client/src/device-router.ts:575-576`, `packages/client/src/device-router.ts:877-905`).
- **RPC deadlines follow request semantics**: short fs/ports RPCs may use default deadlines. Exec must respect caller/wire timeouts plus transport margin, rather than discarding a still-running command client-side after a universal 20 seconds. See the current global `DEVICE_REQUEST_TIMEOUT_MS` (`packages/client/src/device-router.ts:37-45`, `packages/client/src/device-router.ts:848-867`).
- **Mobile remains frozen**: register only relay/legacy-compatible adapters, with no loopback probing, pairing UI, orphan UI, or new desktop features. Shared client/protocol changes permit only minimum build fixes.

## Direction

### Milestone 1: Transport arbiter for deterministic testing

Make DeviceRouter clock/timers, WebSocket/relay, identity, and random-ID boundaries controllable in Node. State-machine tests cover cached-direct hedging, no-cache relay/background pairing, relay→direct promotion, concurrent scopes, stale contenders, close/reset, and monotonic generations. Validation: `node --import tsx --test packages/client/src/*.test.ts` exits 0.

### Milestone 2: session continuity and input submission

Session lanes migrate independently; attach/gap recovery is single-flight; detached sessions require explicit recovery; checkpoints remain separate from live cursors. Plan 042 ACK retires precisely the acknowledged input prefix, without data loss on full queues or failed sends. Validation: `node --import tsx --test packages/client/src/*.test.ts && node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` exits 0.

### Milestone 3: desktop web local catalog/holder UX

Retain/probe when entering a target device/workspace and release when leaving. Central snapshot updates no longer reclaim holders. Local catalogs integrate orphans and clear offline state. Loaded pages still attach/control after control disconnects; unpaired pages or missing app shells degrade honestly. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` exits 0.

### Milestone 4: Device RPC migration and compatibility closure

terminal, git/fs/exec, import browsing, ports and prepared lifecycle all go through the corresponding lane; when direct is unavailable the relay behavior is equivalent, and high-privilege failures will not affect the terminal. Necessary diagnostics only display direct/relay/permission/offline, do not redo workbench; mobile just keeps building. Validation: `pnpm -C apps/mobile build && node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

## Landmines

- `packages/client/src/browser-identity.ts` and `device-router.ts` are untracked user drafts when planning; they are existing work that needs to be carefully integrated and must not be deleted, reset, or overwritten with the entire file to obscure the original diff.
- Register xterm consumers before attach. Existing comments document losing replay bytes when replay precedes registration (`apps/web/src/components/workbench/terminal-pane.tsx:421-422`); preserve snapshot/delta ordering.
- The web currently reclaims the active terminal holder on central `snapshotRevision` changes (`apps/web/src/components/workbench/workspace-terminal.tsx:336-352`). Decouple that behavior from Device-lane migration; switching workspace visibility must not bypass detachment.
- `activate` immediately force-attaches every desired session before closing previous (`packages/client/src/device-router.ts:521-550`). Reusing this behavior for hedge contenders causes duplicate attaches.
- `closeRoutes` closes the channel first, but socket-close callbacks can re-enter recovery (`packages/client/src/device-router.ts:1199-1213`, `packages/client/src/device-router.ts:552-561`). Teardown must invalidate late callbacks.
- The browser cannot read `$COFLUX_HOME`; it is not allowed to randomly scan ports or introduce native helpers. Fixed loopback failure, LNA permission denied and Mixed Content are both normal relay branches.

## Scope

In scope:
- `packages/client/**`
- `apps/web/**`
- `apps/mobile/**` only minimal build fixes caused by shared-layer changes
- Package script/config required for client state-machine testing
- `plans/README.md`

Out of scope:
- `proto/**`, `crates/**` —  complete plan 042 first; do not invent temporary ACK semantics here
- Operational behavior of `apps/server/**` — Completed control/opaque relay contract unchanged
- service worker, offline cold start app shell, local metadata database
- LAN/P2P, browser extension, native shell, loopback preview reverse proxy
- Mobile new features or local direct connection
- VT snapshot fidelity extensions and real-browser matrix acceptance: plan 041
- Workbench visual redesign

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Client state-machine tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Client typecheck | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Server compatibility | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] All listed commands pass; real stack/browser/performance is left to plan 041.
- [ ] Direct handshake/attach of cached-grant happy path does not wait for any central response.
- [ ] When direct is slow/failed, relay is available after the hedge window; when there is no cache, relay does not wait for pair, and will be promoted to direct after successful pairing.
- [ ] session lane is not migrated/closed due to RPC/LIFECYCLE lease, timeout or failure.
- [ ] Winner selection, relay-to-direct promotion, close/reset, and concurrent scopes cause no duplicate attach, stale-contender override, or generation rollback.
- [ ] Retire queued input only through cumulative ACK. Retransmit after lost ACK or transport changes; full queues and failed sends never silently lose data.
- [ ] Detachment stops automatic reclaim; only explicit user takeover restores attach/input replay.
- [ ] checkpoint will not allow the first live attach to skip necessary snapshots, and repeated gaps will not form an attach storm.
- [ ] Mark control online only after authOk. Route release leaves no sockets, timers, polls, or waiters.
- [ ] UI/state distinguishes local orphans, explicit exit, offline stop, and central task lifecycle.
- [ ] Existing relay behavior intact when direct unavailable, permission denied, or version mismatched.
- [ ] Mobile gains no features and still builds.
- [ ] Implementation follows every Decisions & tradeoffs entry.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status updated.

## STOP conditions

- plan 042 is not yet complete, or the final ACK semantics are inconsistent with the cumulative contiguous prefix of this plan.
- User-owned untracked drafts conflict with this contract and cannot be partially integrated.
- session/elevated lane detachment requires breaking the frozen holder/generation semantics of plan 036.
- The target browser can only establish any loopback connection through the native shell/service worker.
- Correct implementation requires the server to interpret DeviceEnvelope or add a second set of business protocols.
- Any validation fails twice in a row after a reasonable fix.

## Maintenance notes

DeviceRouter connects local session authority to transport adapters. Future LAN/P2P, local preview, or RPC work should extend lanes/capabilities without putting central requests back into cached local attach paths or duplicating direct/relay fallback inside business components.
