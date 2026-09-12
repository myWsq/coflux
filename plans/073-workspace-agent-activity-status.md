# Plan 073: Sidebar workspace activity shows working agents and agents awaiting input

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat bc3005f..HEAD -- proto crates/worker/src apps/server/src/hub.ts packages/client/src/store.ts apps/web/src/components/workbench/sidebar.tsx tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `bc3005f`, 2026-08-14

## Requirement

With claude/codex running in several workspaces, the sidebar does not show which is working and which is waiting for a reply. Users must open each terminal. This blind spot conflicts with the “Agent command center—human supervision and takeover at any time” positioning in `docs/ROADMAP.md`, item 1.

Each workspace row must distinguish:

- **Working (green)**: a RUNNING session produced PTY output in the last few seconds. This includes builds/tests, not just agents.
- **Waiting for interaction (amber)**: a RUNNING session has claude/codex in its PTY process tree but output has been quiet for about 10s or more.
- **Neutral (existing appearance)**: idle shells, no tasks, or offline devices.

State must survive page refresh without relying on a transition previously observed in this tab, and update even when the workspace terminal is not open. Signals go through central broadcast, independent of attach. Tooltip text includes the agent name, such as “claude is waiting for input.”

The user explicitly rejected a frontend-only heuristic that forgets activity on refresh and chose process-tree detection. Do not add a Task state: activity beneath RUNNING is volatile derived runtime state, not a Postgres state-machine value. Do not parse VT/BEL/OSC in supervisor/sessiond; supervisor is deliberately upgraded rarely (`AGENTS.md`).

## Decisions & tradeoffs

- **Waiting means an agent process exists and output is quiet**. Implement process-tree detection immediately. The user chose it during dev-explore over checkpoint freshness plus observed active→quiet transitions, which cannot distinguish an agent waiting from an idle shell after refresh. Worker already enumerates PTY process trees for port detection: `crates/worker/src/ports.rs:14`, listening_ports / imp::process_tree, using macOS libproc and Linux /proc without privilege for the same uid.
- **Working uses checkpoint freshness without another output protocol**. Worker reports a checkpoint for each output-producing session at most every 2s (`crates/worker/src/device.rs:30`, CHECKPOINT_INTERVAL). Supervisor kind-1 notifications mark it dirty regardless of client attachment (`main.rs:513-515`). Server broadcasts to all account subscribers (`apps/server/src/hub.ts:439`) and sends existing checkpoints on subscribe (:1180). Client already stores sessionCheckpoints[sessionId].capturedAt (`packages/client/src/store.ts:495-503`). Reject merging attached output as a second signal: 2s resolution is sufficient for a sidebar indicator.
- **Recognize a built-in claude/codex list by process name or argv**. Match comm/executable name, basename(argv[0]), or—when argv[0] is an interpreter such as node/bun/deno/python/sh—basename(argv[1]). Any matching process in the tree counts. Executable-only matching misses node/bun wrappers. The user does not need a configurable list. Report detected names rather than a boolean because the tooltip must show them.
- **Follow port detection's reporting pattern**: scan every 2s through spawn_blocking, send a full report only when changed, and unconditionally report after successful authentication to recover from server restart. See main.rs:183-216 report_ports_if_changed/force_report_ports and :396-407 tick. WorkerState.alive (:75) provides session→(taskId,pid). The executor may share one process_tree traversal with port detection; two BFS traversals per session every 2s are also acceptable.
- **Server presence stays in memory**. This is derived runtime state, like relay-home presence in docs/architecture.md §5.2. On daemon disconnect, clear that daemon's agents and broadcast the removal or stale amber indicators remain. Reject Postgres writes for every agent start/stop and records left behind by a crashed daemon.
- **New broadcast plus current-state delivery on subscribe/snapshot**. Executor may choose per-session increments or full per-daemon reports. The contract must express clearing on exit/disconnect, immediately deliver full current state to new subscribers (alongside checkpoint replay or in StateSnapshot), and carry session_id/task_id/agent names so client can join via task.workspaceId.
- **Update protocol and all generated targets together**. proto is authoritative; run buf generate and commit TS/Rust/Swift artifacts. Keep crates/protocol and packages/protocol wire formats identical per AGENTS.md. Use unused oneof tags: current maxima are DaemonToServer 30 and ServerToClient 33 (daemon.proto:100-123 / client.proto:241-265).
- **UI approved by user**: replace the existing GitBranch icon in place (`sidebar.tsx:349`), analogous to the device row's lightning/dot substitution (:523-530). Neutral retains GitBranch unchanged, including the main workspace's text-warning color. Add status with agent name to workspaceTooltip (:300-323). Explicitly reject a permanent status icon, an additional dot, collapsed-project aggregation, browser-title badges, and desktop notifications; the last three may be later work.
- **Thresholds and priority (decided while planning)**: green for last output ≤5s (two 2s checkpoint periods plus margin); amber for an agent present with silence ≥10s. Keep green for agents quiet between 5–10s to avoid green→neutral→amber flicker. With multiple sessions, amber outranks green because waiting for the user is actionable. Force neutral when !daemon.online because presence is untrustworthy.
- **Clock basis (decided while planning)**: daemon capturedAt can differ from browser time. Record local Date.now() as receivedAt for arriving checkpoint broadcasts and use it for freshness. Only checkpoints replayed at subscription fall back to capturedAt. Recompute sidebar state on a roughly one-second tick; executor chooses its implementation.

## Direction

```text
supervisor kind-1 output notice → worker dirty → checkpoint every ≤2s → server broadcast
                                                        → client capturedAt/receivedAt = last output
worker scans alive session process trees every 2s → claude/codex match → SessionAgents report on change
  → server in-memory presence, account broadcast, subscription replay → client store sessionAgents
sidebar aggregates RUNNING-task sessions per workspace:
  agent present and quiet ≥10s → amber
  last output ≤5s, or agent present and quiet <10s → green
  otherwise neutral; !daemon.online always forces neutral
```

The checkpoint path already exists; agent detection/reporting, server presence, and client sessionAgents are new.

### Milestone 1: Protocol contract and consistent generated targets

Add worker→server presence reporting to daemon.proto and server→client broadcast/snapshot representation to client.proto or common.proto. Comments must state that this is derived runtime state, server only mirrors/broadcasts it in memory, and disconnect clears it.

Validation: `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` → exit 0 after committing generated artifacts; regeneration produces no diff.

### Milestone 2: Worker detection and reporting

Implement all three name-matching rules, a 2s scan, change-only reports, and an unconditional report after authentication. Detection failure from exited processes or unsupported platforms quietly degrades to no agent, never panic, following ports.rs.

Validation: `cargo build --release -p coflux-worker` → exit 0 with no CI warnings; `cargo test -p coflux-protocol` → exit 0.

### Milestone 3: Server presence lifecycle

Validate source daemon ownership like workspaceBranch, maintain memory presence, broadcast changes to subscribed account clients, and send full current state on clientSubscribe. Clear and broadcast on daemon disconnect and task deletion.

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 4: Client store and sidebar

Add sessionAgents and message handling, including receivedAt. Apply the thresholds, precedence, and online gate to workspace rows. Replace GitBranch in its slot with lucide status icons; green may use existing animate-pulse-alive and amber text-warning. Add a tooltip status line. Follow docs/design-guidelines.md: Tooltip component and lucide reuse first.

Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0. Mobile is frozen; only minimally repair build breakage caused by packages/client changes (AGENTS.md).

### Milestone 5: Black-box tests

Add a test file with an exclusive port. Start stack, project/workspace/task/session, then run a fake agent in the PTY: an executable temporary script named `claude` containing a sleep loop. Linux comm is claude; macOS argv includes that basename, so both platforms match. Assert client receives presence with agent === "claude"; kill it and assert clearing. A plain shell must produce no presence. Perform a negative check by disabling the server handler or worker report and confirming the test fails.

Validation: `node --test tests/src/<new-file>` → exit 0.

## Landmines

- CI runs buf generate then git diff --exit-code for all three targets. TS embeds base64 descriptors; generated files cannot be handwritten. Commit actual TS/Rust/Swift generation. Additive fields/messages pass buf breaking.
- Checkpoints may be silently dropped: snapshots above 512KiB are discarded (device.rs:1172), and reporting waits for connection_authed (main.rs:702-704). Green can therefore mislead. These limitations are outside scope: central disconnection already shows a global banner, and oversize snapshots have not been observed (measured maximum about 99KB, docs/architecture.md §11).
- The 3s git poll (main.rs:341) and 2s port poll (:396) are separately spawned loops. Agent detection belongs with sessions, not the workspace-based git poll. Snapshot alive and release its lock before spawn_blocking; do not hold the lock across scanning, following main.rs:187.
- `exec -a` changes argv[0], not comm; Linux comm follows the executed filename. A script actually named claude reliably matches on both platforms. Do not depend on `exec -a claude sleep`.
- clientSubscribe deliberately loads data before setting subscribed=true (hub.ts:1165-1182). Put presence replay in that same atomic sequence so concurrent broadcasts cannot overtake the snapshot.
- Client store requires one setState per message (store.ts:318-320). Do not split presence commits. Clear sessionAgents on session exit/task deletion just as markSessionExited clears inputStates (:210-211), avoiding stale amber.
- Each test file needs its own unused const PORT (AGENTS.md harness). Historical local black-box setup requires COFLUX_TEST_PG_URL on 54322; the supavisor pooled 5432 port reports “no tenant identifier.”
- Preserve the row's right-hand hover-mask/delete layout (sidebar.tsx:351-390). Only change the left size-3 icon slot; maintain its dimensions to avoid jumps, following the fixed device slot at :523-524.

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`, `proto/coflux/v1/client.proto`, and `proto/coflux/v1/common.proto` if sharing a message
- Generated `packages/protocol/src/gen/`, `crates/protocol/src/gen/`, `proto/gen/swift/`
- `crates/worker/src/`: detection module, main.rs loop/reporting, and ports.rs if sharing traversal
- `apps/server/src/hub.ts`
- `packages/client/src/store.ts`
- `apps/web/src/components/workbench/sidebar.tsx` and a small adjacent hook if needed for the tick
- `tests/src/` new test file
- `plans/README.md` registration/status

Out of scope:
- `crates/supervisor/`, `crates/relay/`: session authority and the sufficient dirty→checkpoint chain stay unchanged.
- `apps/mobile`, `apps/ios`: no features; only minimal shared-layer build repairs for frozen mobile.
- Terminal-tab activity (terminal-pane.tsx already has control-ownership icons); this slice covers sidebar only.
- Collapsed-project aggregation, browser title/favicon badges, and desktop notifications, rejected or deferred by user.
- Configurable agent list.
- `apps/server/src/store.ts`: presence is not persisted.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint and generated consistency | `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` | exit 0 |
| Rust build, no CI warnings | `cargo build --release -p coflux-worker -p coflux-supervisor` | exit 0 |
| Rust unit tests | `cargo test -p coflux-protocol` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Black-box acceptance | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0, or only existing baseline failures |

## Done criteria

- [ ] All listed commands pass.
- [ ] Black-box assertions verify claude in the PTY produces centrally broadcast presence, process exit clears it, and a plain shell produces none.
- [ ] Daemon disconnect clears/broadcasts its presence, confirmed by black-box test or code review.
- [ ] Sidebar follows thresholds, priority, and daemon.online gating. Neutral exactly preserves GitBranch and main-workspace coloring.
- [ ] Tooltip includes status and agent name.
- [ ] After refresh, subscription replay restores amber/green without observing a new transition.
- [ ] Required tests assert meaningful behavior and have undergone the negative check.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- buf breaking rejects the protocol change, requiring additive redesign.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Process-tree/name detection cannot reliably match the fake agent in Linux CI. Revise the plan's matching assumptions instead of forcing the test through.

## Maintenance notes

- Waiting detection assumes claude/codex redraw a spinner at least once per second while working, then stop output when awaiting a person. A future CLI that works silently for long periods will be misclassified amber. Centralize thresholds for adjustment.
- Agent presence is derived in-memory state. Persisting it or adding it to Task creates a second source of truth; review plan 072's precedence lesson first.
- The list is fixed to claude/codex. Adding an agent requires one worker constant change and release; worker hot upgrade suffices without a supervisor change.

### Original source references

`crates/worker/src/main.rs:513-515`, `hub.ts:1180`, `crates/worker/src/main.rs:183-216`, `main.rs:396-407`, `main.rs:75`, `proto/coflux/v1/daemon.proto:100-123`, `sidebar.tsx:523-530`, `sidebar.tsx:300-323`, `crates/worker/src/device.rs:1172`, `crates/worker/src/main.rs:341`, `main.rs:396`, `apps/server/src/hub.ts:1165-1182`, `packages/client/src/store.ts:318-320`, `store.ts:210-211`, `sidebar.tsx:523-524`.
