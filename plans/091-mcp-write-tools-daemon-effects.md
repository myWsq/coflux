# Plan 091: Second centrally hosted MCP slice—server-initiated daemon effects and workspace/terminal write tools

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat d952471..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/device.proto crates/worker/src apps/server/src/hub.ts apps/server/src/prepared-operation.service.ts apps/server/src/prepared-operation-convergence.service.ts apps/server/src/mcp apps/server/src/oauth.ts apps/server/src/store.ts tests/src/oauth-harness.mjs`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/090-mcp-oauth-readonly-tools.md (DONE)
- Category: feature
- Execution: subagent fable (departure-check authorization on 2026-09-05: write and execute plans 090 → 091 → 092 continuously, without asking the user again between them; STOP/BLOCK still require stopping; push/PR/merge are outside authorization)
- Planned at: `d952471`, 2026-09-05

## Requirement

After 090, Claude Code / Codex on any machine can connect to the central `/mcp` through OAuth and **read** account assets. This slice adds the write capabilities approved by the user: an agent can **create a child workspace (git worktree), open a terminal in any workspace to run a command, read output, send terminal input, wait for completion, stop/delete the terminal, and remove the workspace afterward**. This is the minimal “create a workspace for a subtask, then clean it up” loop. It also upgrades 090's `read_terminal` from the center's two-second checkpoints to preferring daemon command logs, so output from commands lasting only seconds is not lost.

### Required outcome from the consumer's perspective

Add the tools below. These snake_case names are authoritative; the executor chooses parameter/result shapes, following 090's structured result plus identical JSON text, with `isError` and readable messages for failures.

| Tool | Semantics |
| --- | --- |
| `create_workspace` | Create a worktree workspace under a project using project id, branch name, whether to create the branch, and optional name defaulting to the branch. Return id, path, and branch. An offline device produces a clear error. |
| `rename_workspace` | Rename the central record only. Main workspaces can also be renamed, matching Web. |
| `remove_workspace` | Close all terminal sessions, then remove a worktree workspace and its record. Main workspaces cannot be removed; instruct callers to remove the whole project, matching Web. Directory workspaces remove only records. |
| `create_terminal` | Open a real terminal to run a command, using workspace id, title, and command. Execute through a login shell in the workspace directory; the terminal exits with an exit code when the command finishes. Also write output to a daemon command log for reading. Return the terminal id. Enforce the per-workspace active-terminal limit, including manually opened terminals, with a clear limit error. |
| `read_terminal` | Upgrade to prefer the daemon command-log tail. For non-command terminals opened by users, or when the daemon cannot obtain the log, fall back to a daemon-local snapshot. If the device is offline, use the central checkpoint. Return text, source (`log` / `snapshot` / `checkpoint`), and state/exit code. |
| `send_terminal_input` | Write text with optional appended carriage return. **Reject while a user has attached to and taken control of the terminal**, explaining that the user is in control. An exited terminal produces a clear error. |
| `wait_terminal` | Block until terminal exit, **with a bound**: default and maximum are both at most 50 seconds. On timeout return current state, not an error; on exit return its code. Agents can call again for longer waits. |
| `stop_terminal` | End the session, equivalent to Web stop. On return it has exited or is already exiting. |
| `remove_terminal` | Remove the terminal record, including its checkpoint. A running terminal must first be stopped with `stop_terminal`; otherwise return a clear error. |

All tools operate only on the caller's account assets. An id outside that account and a nonexistent id return the same error, following 090. **If the target daemon does not support this slice's control messages because its old worker has not been hot-upgraded, every write tool returns a readable “This device's daemon must be upgraded” error, never a silent timeout.** Existing broadcasts make the Web sidebar react exactly as if the user performed these operations there; no Web changes are needed.

### Nearby approaches that do not satisfy the requirement

- Do not give the center a virtual device channel that exposes every browser Device RPC. Architecture explicitly keeps data frames outside the central control WS and keeps the center free of channel state. Add only **per-operation** control messages.
- Do not revive 074's direct `SessionCreate` for terminal creation. It fixes sessionId when creating the task; disconnect before control-WS delivery leaves a permanently IDLE zombie. Use prepared `session.create`.
- Do not alter sessiond holder / input_seq / attach semantics or supervisor. Input must use the existing worker `agent_send_input` entry point, preserving human-priority rejection. Supervisor has zero changes here; 092 will touch it.
- Do not duplicate worktree/session persistence and broadcast logic at the center. Server-initiated prepared operations use the **same** convergence transaction; only the execution trigger and result recipient differ.
- Do not gate on semver worker versions. Dev/tests report `builtin`, and automatic upgrade deliberately avoids semver comparisons. Gate on capabilities **advertised during daemon authentication**.
- Do not expose a long-blocking MCP wait. Claude Code's remote HTTP MCP requests default to a 60-second timeout.

## Decisions & tradeoffs

- **Server-initiated daemon effects reuse prepared operations plus a control message that triggers execution, without a virtual channel (option B)**. Worktree add/remove and session creation first use existing preparation: persist the record and install the frame on daemon. Center then sends `PreparedDeviceOperationExecute{operation_id}` over control WS. Worker dispatches the installed frame through the **same** path; existing `DeviceOperationReport` returns to center, where the existing convergence transaction persists and broadcasts it. Rejected option A, center as a device-channel client: `handle_remote_frame` requires a channel registered for transport, `Principal::Relay` requires scopes/generation, and docs/architecture.md §5.2 prohibits data frames through central control WS or central channel state. Also reject the still-live direct `WorktreeAdd→WorktreeAdded` path (`crates/worker/src/main.rs:1707-1738`): direct WorktreeRemove has no acknowledgement (`:1739-1746`), and center no longer handles direct worktreeAdded reports, requiring duplicate persistence/broadcast logic.
  Based on: prepared execution does not require a channel to exist. At `crates/worker/src/device.rs:2270-2278`, `finish_call`→`send_payload` simply returns for a missing channel; `:2264-2267` independently sends `report_operation` over control WS; `:2466-2470` reports sessiond replies before looking up the channel. `authorize_prepared` compares only daemon_id and frame bytes (`:1888-1920`); `Principal::request_key` is used only without operation_id (`:1985-1990`).

- **Use a new `Principal::Server` and synthetic channel id `__coflux-server-<operationId>` for server-triggered prepared execution**. This principal is valid only for **installed prepared operations**, admitted by `authorize_prepared` against their templates. It has no non-prepared Device RPC authority. Do not register the synthetic channel in `channels`; existing reply handling discards responses to it. Its id must not collide with `__coflux-worker` / `__coflux-agent-`, and `validate_relay_dial`'s reserved `__coflux-` prefix continues to cover it. Repeated Execute for one operation_id after server restore must be idempotent: already-running/completed operations resend the last report or ignore it, never execute twice.
  Based on: `crates/worker/src/device.rs:40-43` defines `INTERNAL_CHANNEL_ID` and `AGENT_CHANNEL_PREFIX`; `:2450-2465` specially dispatches those ids; `:3288` reserves `__coflux-`; `:485-560` defines Principal and ChannelEntry; `:1722-1770` looks up principal in channels within handle_client_frame, a step the server-triggered path must bypass; `:399-404` and `:1346-1365` show PreparedRecord's canonical frame indexed by operation_id.

- **Mark server-initiated records with `initiator: "server"`; send Execute after installation; add hub completion primitives without changing WS branches**. `prepared-operation.service.ts` prepare is client-bound: failures use sendError(client), installation emits the frame to the browser, and restore without a waiter does nothing. Add a **client-free** entry point whose admission result is returned rather than sent to a client. In handleInstalled and restore→installed, metadata initiator:"server" selects sendDaemon(Execute) instead of emitToClient, automatically continuing after server restart. Timeout/cancellation through watch, cancelDaemon, and cancelMany must wake server completion waiters instead of addressing a nonexistent client. Completion primitives are bounded, timed Deferred maps keyed by **operationId**, awakened at the end of handleDeviceOperationReport convergence on applied/failed with effect/error, and by **taskId**, awakened in sessionStarted/sessionExit. Daemon disconnect or generation replacement resolves them with readable errors. create_workspace, remove_workspace, create_terminal, stop_terminal, and wait_terminal use them for results.
  Rejected: fake a ClientConn and feed MCP into handleClientMessage. No browser would forward the frame over a device channel, and every sendClient would need interception.
  Based on: `apps/server/src/prepared-operation.service.ts:96-100`, `:457-545` for prepare admission/sendError/resumeCurrentForClient; `:128-139`, `:577-601` for handleInstalled→emitToClient; `:544-557` for restore. `apps/server/src/hub.ts:1319-1440` handles reports through convergeAndApply with workspace/task/sessionId/removedWorkspaceId/removedTaskIds/error effects; `:1831-1870` handles sessionStarted and `:1872-1915` sessionExit. `store.ts:184-200` stores PreparedOperationRecord.metadata as JSON text, parsed by `hub.ts:3309` parseOperationMetadata.

- **Create terminals through prepared `session.create`; add `DeviceSessionCreate.command` at field 9 and derive script paths deterministically from operation_id**. In one transaction, create an IDLE task with existing dispatchAgentControl.terminalNew admission: lock the device parent row, reject deleting projects, and enforce config.maxAgentTerminalsPerWorkspace. Prepare session.create with command. After authorize_prepared and before encoding for sessiond, worker writes a local wrapper script for a nonempty command, sets shell to its path, and records the log path by task for reads. **The script path must derive from operation_id**: sessiond's canonical ledger request includes shell, so a different replay path causes operation_collision. Old workers ignore command and would start an ordinary shell, which capability gating must prevent.
  Rejected: adding command to 074's direct SessionCreate path, which creates IDLE+sessionId zombies described above.
  Based on: `proto/coflux/v1/device.proto:470-479` currently has DeviceSessionCreate fields 1–8, shell at 6; `crates/supervisor/src/sessions.rs:261-265` canonical_create_request clears only request_id, retaining shell, and `:1725-1745` handles operation_collision. `crates/worker/src/ops.rs:337-349` currently names write_command_script output with pid+nanoseconds. `hub.ts:1056-1145` contains terminalNew admission, `:2943-2983` prepared session.create admission, and `hub.ts:1091-1103` the direct path's fixed-sessionId problem.

- **Add one extensible server→daemon request/result control-message pair for terminal read/input, each with a oneof payload**. Initially support read, using task_id to prefer command-log tail then local snapshot and returning raw bytes plus source; and input, using session_id+data through agent_send_input, rejecting human holders and returning its readable errors unchanged. Central read_terminal uses daemon when online and capable, otherwise central checkpoint. ANSI removal and last-N-line selection remain central in 090's mcp/text.ts.
  Rejected: separate top-level request/result types for every action, consuming two tags and changing worker's top-level match each time. Do not reuse AgentControlRequest/Result, which run in the opposite direction, daemon asking center.
  Based on: AgentControlRequest/AgentControlResult oneof structures in `proto/coflux/v1/daemon.proto` are a structural reference; `crates/worker/src/agent_ctl.rs:222-275` implements log-first/snapshot terminal.read and agent_logs; `:276-330` checks ownership/exited/not-ready before agent_send_input. `crates/worker/src/device.rs:1521-1524` checks human_holder_present; `:1534-1580` implements agent_send_input concurrency/identity limits and timeout semantics with readable errors.

- **Reuse existing stop/delete paths**. stop sends existing sessionClose directly over control WS, the same path Web workspaceRemove uses to close sessions, then waits boundedly by taskId for sessionExit. remove uses Web taskRemove's transaction: device parent lock, checkpoint deletion, runtime retirement, and broadcast; MCP must enforce status ≠ running in code, where Web relies on UI. rename_workspace uses workspaceSetName logic. Directory remove_workspace uses the same DB-only branch; worktree removal first sessionCloses all sessions, then prepares a server-initiated worktree.remove.
  Based on: `hub.ts:2510-2578` workspaceRemove branches; `:1449-1476` prepareWorktreeRemoval; `:2684-2728` taskRemove; `:2578-2624` workspaceSetName; `proto/coflux/v1/daemon.proto` ServerToDaemon.session_close = 10.

- **Gate on capabilities advertised during daemon authentication, not version numbers**. Add repeated field 5 to DaemonAuth. New workers advertise names chosen by the executor, at least distinguishing Execute support from read/input-request support. Store them on the hub daemon connection. Before sending new messages, MCP write tools check them and return “This device's daemon must be upgraded” when absent. Old workers omit the field and are naturally blocked.
  Rejected: workerVersion comparisons, since dev/tests report builtin and auto-update.ts:8 explicitly avoids semver. Reject send-and-wait: old worker's known-payload-only match silently drops unknown ServerToDaemon messages (`main.rs:1395-1410`), wasting 50 seconds without an explanation.
  Based on: DaemonAuth fields 1–4 in daemon.proto; `hub.ts:121`, `:1557`, `:1594`, `:1614-1630` read/store workerVersion during authentication, where capabilities also belong; `crates/supervisor/src/manager.rs:841` uses builtin.

- **Protocol field numbers**: next available ServerToDaemon tag is **38** (one each for Execute and server→daemon request); next DaemonToServer is **34** (result); DaemonAuth **5**; DeviceSessionCreate **9**. Reserved tags have been checked. Run buf generate for all three languages; CI buf breaking permits only additive changes.
  Based on: both daemon.proto oneof reserved lists and current maxima 37 / 33.

- **wait_terminal is a bounded central wait**. Default and maximum are ≤50 seconds because Claude Code remote HTTP MCP defaults to 60 seconds per request. Wait for sessionExit through the taskId completion primitive; timeout returns current state rather than an error.
  Based on: Claude Code MCP_TOOL_TIMEOUT documentation for the 60s HTTP-server request default.

- **Hard boundaries remain unchanged**: zero changes under crates/supervisor/**; no sessiond holder/input_seq/attach semantic changes; no data frames through center. Terminal-read replies are bounded text like checkpoints, with worker-side byte clamping. cofluxd and Web behavior remain unchanged.
  Based on: plans/074 and 088 Landmines, and docs/architecture.md §5.2.

- **Black-box driving**: obtain an OAuth token through 090's tests/src/oauth-harness.mjs, then call MCP tools directly. Use device-harness.mjs attach to create a human holder for input rejection, matching agent-terminal-io.test.mjs:157-163. For old-worker gating, enroll a fake device with harness.mjs rawDaemon(), a raw /daemon connection omitting capabilities, and assert readable errors from write tools. Perform negative validation by removing the relevant logic and confirming tests fail.
  Based on: `tests/src/harness.mjs:572` rawDaemon, `:616` authorizeDaemon, and `tests/src/device-harness.mjs:736` openRelayDevice.

- **Claude does not verify frontend presentation**, following repository convention. This slice changes neither Web nor iOS; existing broadcasts provide sidebar updates.

## Direction

```text
MCP tool (principal) ──▶ hub operations (admission transaction + prepare(initiator=server))
      │                       │ installation acknowledgement / restore→installed
      │                       └── control WS ──▶ PreparedDeviceOperationExecute{operation_id}
      │                                          worker: find installed frame
      │                                          → Principal::Server + __coflux-server-<op>
      │                                          → shared dispatch (worktree add/remove → git;
      │                                            session.create → command script/shell → sessiond)
      │                       ◀── control WS ── DeviceOperationReport
      │                                          → existing persistence/broadcast convergence
      └── bounded operationId/taskId Deferred completion ──▶ result or readable error

read/input: hub ──ServerAgentRequest{read|input}──▶ worker (log tail/snapshot; agent_send_input)
               ◀──ServerAgentResult──────────────
stop: hub ──sessionClose──▶ worker; hub waits boundedly by taskId for sessionExit
gate: missing required DaemonAuth.capabilities → immediate daemon-upgrade error
```

### Milestone 1: Protocol

In daemon.proto, add PreparedDeviceOperationExecute, the server→daemon request/result pair with read/input oneofs, and DaemonAuth capabilities. Add DeviceSessionCreate.command in device.proto. Generate all three targets.

Validation: `cd proto && buf generate && git status --short` → generated changes contain only this slice's messages; `cargo test -p coflux-protocol` → exit 0; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 2: Worker

Advertise capabilities; implement idempotent Execute through Principal::Server and synthetic channels; turn command into a deterministic wrapper path and log registration; handle server read/input requests. Reads prefer log tails, then local snapshots, with byte limits. Writes use agent_send_input and return errors unchanged. crates/supervisor has zero diff.

Validation: `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` → exit 0 with zero warnings; `cargo test -p coflux-worker` → exit 0; `git diff --stat d952471..HEAD -- crates/supervisor` → empty.

### Milestone 3: Central operation layer

Add client-free preparation with `initiator: server`, automatic Execute after install/restore, timeout/cancellation completion, operationId/taskId waiters, and capability gates. Implement workspace create/rename/remove and terminal create/stop/remove/read/input/wait, with daemon-read fallback to checkpoint. WS branch behavior remains unchanged.

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 4: MCP tools

Register the eight write/wait tools and upgrade read_terminal with its source field. Descriptions explain human priority, limits, bounded waits, and the meaning of daemon-upgrade errors.

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 5: Black-box acceptance and documentation

New test files use exclusive ports starting at **8869**. Positive loop: create_workspace creates a real on-disk worktree and workspaceCreated broadcast → create_terminal runs a command that emits output and lasts long enough → read_terminal returns its output from log → send_terminal_input takes effect → wait_terminal returns exit code → remove_terminal → remove_workspace removes the on-disk worktree and broadcasts workspaceRemoved. Also test stop_terminal against a long-running command and rename_workspace.

Negative cases: human attach makes send_terminal_input fail with a message stating the user is in control; reject running-terminal deletion, main-workspace deletion, and terminal-limit overflow. Every write tool on an old-worker fake device enrolled through rawDaemon returns an upgrade error **without waiting**, far below the wait limit. Reject cross-account ids. wait_terminal timeout returns state rather than error. After restartServer, an installed server-initiated prepared operation still completes through restore continuation. Add a server-initiated prepared-execution section to docs/architecture.md and update plans/README.md.

Validation: `node --import tsx --test tests/src/<new-file>.test.mjs` → exit 0 (acceptance).

## Landmines

- **sessiond canonical requests include shell** (`crates/supervisor/src/sessions.rs:261-265`, `:1725-1745`). Changing wrapper paths between Execute retries/replays causes operation_collision. Derive paths from operation_id; ops.rs cleanup_stale_files (`:159-175`, age-based) must not remove them before prepared expiry.
- **Worker Execute must be idempotent**. Server restore after restart/daemon reconnect repeats install and Execute. Completed operations may only repeat their last report or ignore the request, using operation_reports near device.rs:2340; never perform a second git worktree add or session creation.
- **handle_client_frame gets principal from channels** (`device.rs:1760-1770`). Server-triggered execution bypasses that identity lookup but must reuse subsequent authorize_prepared→sessiond routing/dispatch_worker_request, never duplicate dispatch logic.
- **Preserve prepared completion-token/generation semantics** (`prepared-operation.service.ts:95-100`, `:457-545`). The client-free entry retains admission: device parent lock, target resume, MAX_ACTIVE_PREPARED_PER_DAEMON, and conflict checks. Do not bypass store.transaction ordering.
- **handleDeviceOperationReport has applied/failed/ignored outcomes** (`hub.ts:1345-1440`). Wake completion only for applied/failed. Ignored duplicate reports neither wake nor clean up waiters. Cancellation through the session.create task guard must also wake with a task-deleted error.
- **Old workers silently drop unknown ServerToDaemon messages** (`crates/worker/src/main.rs:1395-1410`) while still acknowledging preparedDeviceOperation installation. Gate **before prepare**, or an installed operation that can never execute consumes capacity until TTL.
- **Active-terminal limits include manually opened terminals** (`config.ts:200`, hub.ts:1095-1107 counting).
- **Claude Code requests time out after 60 seconds**. Keep wait ≤50s, and bound create_workspace/create_terminal completion too, preferably around 30s. On expiry report “Submitted; check later with list_*” instead of hanging.
- **Test worker version is builtin**; accidental version-number gating blocks every local black-box case.
- **send_terminal_input timeout semantics**: device.rs AGENT_IO_TIMEOUT is 5s, with identity replacement when outcome is unknown. Do not automatically resend on timeout. Tell the agent the outcome is unknown and to read before deciding, matching 088's SKILL discipline.
- **Deleting running terminals**: Web taskRemove does not stop sessions because UI only permits deletion after exit. MCP must enforce rejection itself.
- Proto changes affect generated Swift and trigger CI swift test. Frozen apps/mobile only needs to build.
- Each black-box *.test.mjs owns its const PORT; 090 already uses through 8868.

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`, `proto/coflux/v1/device.proto`, and all three generated targets
- `crates/worker/src/**`: device, agent_ctl, ops, main, and required new modules
- `apps/server/src/**`: hub, prepared-operation.service, prepared-operation-convergence.service, store, mcp/*, interface/mcp/*, config
- `tests/src/`: new cases; minimal oauth-harness.mjs/device-harness.mjs changes only for needed shared helpers
- `docs/architecture.md`, `plans/README.md`

Out of scope:
- `crates/supervisor/**`: hard zero-change boundary
- sessiond holder / input_seq / attach **semantics**: hard zero-change boundary
- `packages/cli/**`, SKILL.md, and `COFLUX_*` environment variables: plan 092
- apps/web, apps/ios, apps/mobile, packages/client, and packages/swift-client source: no UI changes, excluding generated artifacts. If generated-type changes break builds, make minimal repairs and disclose them in the report.
- Project import/deletion/rename, device operations, fs/exec/diff RPC, and notify/progress through MCP
- OAuth/authentication: settled by 090 and unchanged

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web typecheck for generated compatibility | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Regenerate proto | `cd proto && buf generate` | Only expected generated changes |
| Rust unit tests | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0, zero warnings |
| Supervisor unchanged | `git diff --stat d952471..HEAD -- crates/supervisor` | Empty output |
| Client package unit tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| This slice's black-box acceptance | `node --import tsx --test tests/src/<new-file>.test.mjs` | exit 0 |
| 090 black-box regression acceptance | `node --import tsx --test tests/src/mcp-oauth.test.mjs tests/src/mcp-isolation.test.mjs` | exit 0 |
| Full black-box acceptance | `pnpm -C tests test` | All pass |

Black-box tests require local Postgres (`pnpm dev:pg`) and built daemon binaries. If widespread timeouts occur, first check whether Docker is partially unresponsive.

## Done criteria

- [ ] All listed commands pass.
- [ ] MCP completes create workspace → run command terminal → read → input → wait for exit → remove terminal → remove workspace, with matching disk state and Web broadcasts.
- [ ] send_terminal_input rejects human attach with readable errors and never evicts a human holder.
- [ ] Write tools on old workers without capabilities immediately return upgrade errors without waiting.
- [ ] Installed server-initiated prepared operations complete after server restart.
- [ ] Supervisor, holder/input_seq/attach semantics, and WS branch behavior remain unchanged; all existing black-box cases pass.
- [ ] New black-box cases have negative validation: removing corresponding logic makes them fail.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] plans/README.md status is updated.

## STOP conditions

- Worker cannot execute server-triggered prepared operations without changing holder/attach/input_seq semantics or supervisor: STOP and report.
- Wrapper paths cannot be deterministic by operation_id with replay free of operation_collision: STOP.
- Prepared service cannot add the client-free entry without changing browser behavior: STOP.
- ServerToDaemon 38 / DaemonToServer 34 / DaemonAuth 5 / DeviceSessionCreate 9 are already occupied.
- A fact cited under Decisions & tradeoffs no longer holds.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- This makes center both the **initiator and execution trigger** of prepared operations for the first time. Future center-driven daemon work should use prepare + Execute + convergence, not new direct messages. Keep direct messages only for actions without persistence effects, such as sessionClose and read/input requests.
- Capability names are part of the protocol contract. Add names with new control messages and explain upgrade errors in SKILL/documentation.
- Keep 090's checkpoint-reading implementation as the offline-device fallback.
- Plan 092 adds workspace_id/project_id and IPC env to SessionCreate/DeviceSessionCreate. Its fields neighbor command; avoid collisions by starting 092 at 10.
