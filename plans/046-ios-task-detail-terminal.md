# Plan 046: Second iOS slice—task details and SwiftTerm through relay-only Device transport

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 223cddf..HEAD -- packages/client/src/device-router.ts packages/client/src/store.ts packages/protocol/src/index.ts proto/coflux/v1/device.proto proto/coflux/v1/client.proto proto/gen/swift`

## Status

- Priority: P1
- Effort: L
- Risk: MED (attach/takeover state machine is the most difficult porting point in the entire project; SwiftTerm is integrated for the first time)
- Depends on: plans/044-ios-app-skeleton-client-login.md (DONE)
- Category: feature
- Execution: self (standing authorization: do not delegate iOS/Swift work to subagents, changed on 2026-07-25)
- Planned at: `223cddf`, 2026-07-26

## Requirement

Plan 044 built control/auth/reducer and workspace list. This slice adds the minimal terminal loop: **view live tasks, type, take over, and start stopped tasks**.

1. Workspace row opens task list; task row opens detail.
2. Detail hosts SwiftTerm. RUNNING attaches over relay and renders snapshot/output with input, Esc/Tab/Ctrl/arrows, resize, detached banner/force takeover. IDLE/EXITED replays available sessionCheckpoint read-only and can start via taskStart→preparedDeviceOperation→sessionCreate. Stop uses sessionStop+taskRemove, matching Web closeTask.
3. Device transport is **relay-only**: deviceRelayConnect rendezvous→relay WS→opaque DeviceEnvelope. No direct/loopback.

Do not translate all 2,500 Router lines including browser identity/pair/lease/direct races/measurement/heartbeat/fs/exec. Equally, do not simplify away input retention, output continuity, or attach triple matching: these are the client half of plan 042 exactly-once, preventing silent loss/misalignment on weak networks/background transitions. Port the subset with **identical state semantics**.

## Decisions & tradeoffs

- **Relay subset** includes per-daemon session/elevated lanes, monotonic generation, snapshot/resume/triple-match/gap recovery, input_seq/ACK/retention with 500ms retry and 256-entry/1MB cap (device-router.ts:1967-1995), resize ledger (:1997-2015), stopSession/holder waiter (:2017-2034), 3s catalog polling/exitAck (:1607-1626), prepared ledger (:2123-2153), and stale_holder/session_not_found/stale_transport/scope_denied/supervisor_busy/input_seq_gap/stale_input/stale_resize handling (:1385-1485). Exclude all browser identity/pair/lease/direct/hedge/promotion, measureOnly/retainDevice counts (demand is foreground terminal page), heartbeat/RTT, fs/exec/ports, and pendingTaskRemovals. Reimplementing a simplified state machine risks 042 drift; half the full Router serves impossible iOS loopback scenarios.
- **No pendingTaskRemovals**: TS queues offline-center deletion after direct local stop; iOS center-offline closes relay (:2196-2209), so stop cannot send. closeTask reports error immediately. TS enqueues only at !controlAuthenticated (store.ts:597-609), when iOS has no device route.
- **Complete task start**, user decision 2026-07-26: taskStart (store.ts:566-575; RUNNING+sessionId attaches instead)→preparedDeviceOperation→validate matching operationId, unexpired, empty frame channel_id (:2123-2142)→fill channel_id/send via elevated LIFECYCLE relay→clear on operationAck/projectValidated/worktreeAdded. Deferring to slice three leaves stopped tasks unusable.
- **Port sessionCheckpoint** into sessionCheckpoints[sessionId] (client.proto:254). Without live session, feed ansi_snapshot as replacement, matching store.ts:497-506/:306-307 and !liveSessionIds.has gating. taskRemoved clears checkpoint.
- **PTY bytes bypass @Observable**, through callback straight to SwiftTerm.feed, matching store.ts:107-110. Only control facts—detached/exited/blocked input—are observable. Per-output view diffs would overwhelm SwiftUI.
- **SwiftTerm is second SPM dependency**, migueldeicaza/SwiftTerm iOS TerminalView/CoreText, chosen in 2026-07-25 research recorded at ~/.claude/.../memory/ios-app.md. Wrap with UIViewRepresentable; feed on main thread. Reuse accessory if available, otherwise simple inputAccessoryView row for Esc/Tab/Ctrl/arrows.
- **Hardcode protocol constants with source comments**: DEVICE_PROTOCOL_VERSION=1, MAX_DEVICE_FRAME_BYTES=30MB (TS protocol index.ts:45,50), dimensions clamped [1,1000] (:157 clampDim/device.proto:12). Swift cannot import TS; explicit reference is simplest.
- **Reuse Transport.swift actor/AsyncStream** for binary relay WS. DeviceRelayGrant supplies full wss URL with one-use token. Failed dialing must obtain a new rendezvous, never reuse URL (device.proto:193-194).
- **Background tears down all routes** with control: close sockets, clear pending/attach. Foreground reconnects control then rendezvous/attach on demand. Generation stays monotonic in process (:330-331); clientInstanceId may randomize on cold start like TS createCofluxClient.
- **Navigation**, decided while planning: workspace→task list (status dot/title/metadata)→full-screen terminal/top bar. Existing chevron becomes real NavigationLink.
- **Swift Testing state-machine coverage** with fake transport: initial snapshot attach; rejected resume→snapshot; output gap recovery; input retry/cumulative ACK clearing; detached desired=false/force holder reset; prepared expiry/cleanup; control loss closes relay. No automated UI/SwiftTerm rendering walkthrough; user device acceptance under no-frontend-verification convention.

## Direction

Transport relay instance→new per-daemon DeviceRoute actor/@MainActor class→CofluxClient grant/prepared/checkpoint branches, taskStart/taskRemove, consumer registry→TaskListView/TaskDetailView and SwiftTerm wrapper.

### Milestone 1: Device state machine/tests

Implement rendezvous, envelope codec, route/lane/attach/input/prepared ledgers; fake-transport Swift Testing covers decisions without network.
Validation: simulator test command below exits 0.

### Milestone 2: Terminal/UI/control wiring

Resolve SwiftTerm, add task navigation/rendering/keyboard/accessory, detached/force/start/stop/checkpoint/connection banners, and scenePhase teardown. Build/tests pass; interaction remains acceptance.

## Landmines

- Wrong protocol version silently drops frames. Source constants at TS index.ts:45,50 and dimension comments device.proto:11-12.
- Attach accepts only matching requestId, initiating generation, and current channel (:1487-1510). Resume without ansi_snapshot and snapshot_seq differing from local outputSeq requires requireSnapshot retry, never acceptance.
- Output from_seq must equal outputSeq+1 and to_seq=from+len−1; otherwise discard whole segment and recover snapshot (:1512-1522; device.proto:298 forbids guessing gaps).
- Detached sets desired=false; ordinary attach returns for detached&&!force (:1319-1332/:1929), preserving 026 non-preemptive viewing. Force clears detached/holderEpoch.
- Control disconnection closes all relays immediately (:2196-2209), avoiding half-dead input sinks. Trigger whenever control status is not connected.
- Relay URLs are single-use; retries rendezvous again.
- Validate envelope channelId and protocol_version; discard malformed frames without crash (:1283-1289).
- Prepared frame may change **only channel_id** (device.proto:489-495); daemon template comparison rejects other changes.
- Swift optional scalar presence matters: hasResumeFromSeq/clearResumeFromSeq distinguish absent from zero.
- Hop to MainActor before SwiftTerm.feed; background calls cause intermittent crashes.
- Keep explicit actor annotations from 044 departure; generated pb.swift still lacks nonisolated for default MainActor isolation.
- Establish actual local server/daemon/relay topology first, and prove Web relay terminal works before iOS acceptance, excluding environment failures.

## Scope

In scope: apps/ios/** and README status.

Out of scope: proto source/generated (report missing Swift types); server/Web/mobile/packages/crates read-only references; direct, fs/exec/ports, diff, tabs, push; heartbeat/RTT deferred.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Unit tests | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<available iPhone simulator>' test` | exit 0 |
| Simulator acceptance | Local server/daemon/relay: attach/input echo, Web takeover banner, iOS force, IDLE start, checkpoint | Matches Web semantics |
| Device production acceptance | api.coflux.dev, same cases plus background/foreground reconnect/reattach | Correctly restored terminal state |

## Done criteria

- [ ] Build and unit-test commands both exit 0.
- [ ] Data-plane state-machine tests cover every scenario in Decisions and assert meaningful behavior.
- [ ] Simulator acceptance completes all five actions: attach, input, takeover, start, and checkpoint.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Generated Swift device types missing/unbuildable.
- SwiftTerm SPM/basic feed/input unavailable on iOS 26: return stack choice to user.
- Local relay topology unavailable, a user environment prerequisite.
- Cited fact changes or validation fails twice after one reasonable fix.

## Maintenance notes

- Heartbeat is deliberately deferred: TS uses it for sidebar RTT and half-dead detection; this slice exposes failures through operation timeout. Future device/latency UI ports :1628-1663 without using pendingRequests, which would pin on-demand connections.
- Extend fs/exec/ports/direct from TS semantics, not improvisation.
- Device acceptance checks IME/full-width punctuation. xterm has upstream duplicate-input issues; SwiftTerm's distinct implementation may have different ones.
- Task list uses existing reducer tasks. Extra metadata such as diff already has control fields; do not change protocol merely for UI.

### Original source references

`device-router.ts:1997-2015`, `device-router.ts:2017-2034`, `device-router.ts:1607-1626`, `device-router.ts:2123-2153`, `device-router.ts:1385-1485`, `device-router.ts:2196-2209`, `device-router.ts:2123-2142`, `proto/coflux/v1/client.proto:254`, `store.ts:306-307`, `packages/protocol/src/index.ts:45,50`, `index.ts:157`, `device-router.ts:330-331`, `device-router.ts:1487-1510`, `device-router.ts:1512-1522`, `device-router.ts:1319-1332`, `device-router.ts:1929`, `device-router.ts:1283-1289`, `device-router.ts:1628-1663`.
