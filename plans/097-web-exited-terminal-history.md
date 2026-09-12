# Plan 097: Replay exited terminal output on web instead of opening a blank replacement shell

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5d43adf..HEAD -- proto/coflux/v1/client.proto packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated apps/server/src/hub.ts packages/client/src/store.ts apps/web/src/components/workbench/workspace-terminal.tsx apps/web/src/components/workbench/terminal-pane.tsx tests/src plans`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none (uses deployed 074 task checkpoints and 091/094 daemon command logs/three-level readTerminalForAccount)
- Category: feature
- Execution: self (2026-09-07 departure check: user requested the change and immediate execution after planning; UI walkthrough remains with user)
- Planned at: `5d43adf`, 2026-09-07

## Requirement

Agent command terminals created through MCP or cofluxd often finish in a second or two. Clicking their web sidebar tabs shows a blank new shell, never the command output. After experiencing this on 2026-09-07, the user requested retained history. Two causes: EXITED activation clears the display and starts another shell (workspace-terminal.tsx:257-262), discarding job results; web has no output-history read path. Center already retains a task's last screen checkpoint for 30 days (074), and daemon has full command logs (091/094), but only agent reads use them. Web uses checkpoints only for tab titles (075).

Outcomes for desktop web users:

1. **Activating stopped tabs replays, never restarts.** Clicking EXITED or auto-selecting it on workspace opening displays last output: the tail of full command logs for jobs, or the final screen for manual shells. Append a system line saying the process exited with code N. If nothing is replayable, such as immediate exit or expired checkpoint, show only that line.
2. **Reopen is explicit.** Current stopped tabs show a top banner matching the takeover banner, explaining that the terminal exited and this is its last output, with a Reopen button. Only that button clears/restarts. IDLE tasks still auto-start.
3. **Watching exit preserves scrollback.** A panel that has received output from this session appends only the exit line, without clearing or replacing its display with a smaller history subset.
4. **One center read per exit.** Fetch only on stopped-tab activation, not for every sidebar task. With unchanged task.updatedAt, switching back reuses the result without another request.
5. Existing manual terminals, checkout, ports, takeover, and other behavior remain. Frozen mobile gets no feature but must build. No daemon binary changes.

Incorrect alternatives: deleting completed tabs despite requested history; web calling agent-facing OAuth MCP; daemon pushing whole logs to center on exit, violating opaque data-plane forwarding with only derived checkpoints visible (hub.ts:16); changing checkpoint cadence to capture brief jobs, already rejected by 074 and addressed by logs.

## Decisions & tradeoffs

- **Add TaskRead client→server and unicast TaskReadResult server→requester.** Request has task_id and optional max_bytes. Result has task_id, bytes data, source string log/snapshot/checkpoint/none matching TerminalReadSource, captured_at, status, exit_code, error. No request ID: concurrent reads of one task share a response; web validates applicability using task status/updatedAt. Rejected: ServerError triggers lastError behavior clearing launching state and interferes with unrelated tasks (workspace-terminal.tsx:455-463). Keep errors in results. Rejected: SessionCheckpoint broadcasts lack command logs and exited tasks have no sessionId (server store.ts:844). Evidence: client.proto:149-176,301-329 oneof numbering; hub.ts:287 source enum.
- **Reuse readTerminalForAccount directly** for account ownership, daemon log→snapshot priority, offline/unsupported checkpoint fallback, and 256 KB limit. Rejected: checkpoint-only reads miss short jobs. Evidence: hub.ts:3766-3800,142 and 074 execution findings.
- **Write based on source.** Logs are non-TTY command stdout with LF line endings from 091 tee; normalize lone LF to CRLF before xterm, which uses convertEol:false at terminal-pane.tsx:187. Snapshot/checkpoint contain normalized ANSI screens; reset and write raw. Rejected: global convertEol changes live PTY semantics. Evidence: mcp/tools.ts:287 assumes log data can be stripAnsi/plain text; terminal configuration.
- **Watching exit means this panel received session bytes.** handleOutput at workspace-terminal.tsx:300 is the sole callback; remember task→seen session ID before exit clears task.sessionId. Rejected: past owned control state neither proves output receipt nor covers observers that receive bytes without attach. Evidence: terminal-pane.tsx:424-434 and server store.ts:844.
- **Reuse detached-banner structure/style and Button**, with design-guideline Lucide icons/Tooltip rather than native title. No new banner component. Evidence: workspace-terminal.tsx:756-764.
- **Expose client readTask(taskId): Promise with 15-second timeout.** Deduplicate pending requests by taskId. Do not put result bytes in store state: 256 KB payloads should not propagate through Zustand shallow comparisons on every setState. Follow checkpoint deliverSession direct delivery (client store.ts:584-592).
- **New black-box task-read-history.test.mjs on port 8872**: manual shell outputs marker/exits → checkpoint, marker, EXITED, exitCode 0; agent command exits → log, marker, correct status; nonexistent task → error without disconnection. Evidence: agent-terminal-io.test.mjs:38-88 fixtures and highest existing port 8871.
- **Commit all three generated protocol outputs.** buf generate from proto with clean:true regenerates TS, Rust prost, and Swift. Rust/Swift merely gain unused structures; daemon behavior is unchanged. Evidence: proto/buf.gen.yaml and tracked generated files.

## Direction

Web activates EXITED → client.readTask → WS taskRead → hub readTerminalForAccount → daemon terminalRead or center checkpoint → unicast taskReadResult → resolve → source-specific panel write and exit line. Reopen banner invokes existing startTask.

### Milestone 1: Protocol, server, client package

Independently verifiable without M2: add messages/regenerate, handle taskRead in hub, provide client readTask/result dispatch, and pass three black-box scenarios.
Validation: `cd proto && buf generate && cd .. && git status --short proto packages/protocol crates/protocol packages/swift-client` shows three generated-output diffs; server tsc exits 0; daemon build exits 0 without warnings; new black-box file passes.

### Milestone 2: Web replay, banner, and exit line

Depends on M1 API. Split activation into IDLE auto-start and EXITED replay. Add explicit reopening and exit notification. If controller needs raw-byte writing for replay, add it alongside existing writeSystem in terminal-pane.tsx.
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0; mobile equivalent if configuration exists → exit 0. User performs UI acceptance.

## Landmines

- performActivation (:236-263) currently starts all non-RUNNING tasks. Optimistic createTerminal completion depends on IDLE auto-start (:412-420); preserve it.
- workspaceTasks effect (:392-437) auto-selects the first task without currentActive, including EXITED. Replaying rather than restarting fixes the silent workspace-open shell creation; it is intentional.
- Results can arrive after Reopen. Discard if task is RUNNING or updatedAt changed, avoiding overwriting the new shell.
- Attached registerSessionConsumer replace=true resets terminal (:429). Replay must bypass that consumer path and write directly through controller.
- TerminalPane stays alive with display:hidden (:447); hidden fit is a no-op. No replay fit is needed while hidden; existing rAF fit runs on return.
- acceptSessionCheckpoint persists only RUNNING tasks (hub.ts:1410-1418); no new checkpoint arrives after exit. Manual-shell test must leave at least three seconds before exit for the two-second checkpoint cycle, or source may be none.
- Frozen apps/mobile shares packages/client; guarantee builds without adding replay.
- Plugin guard can falsely intercept Bash containing direct Git worktree creation text; this plan avoids that wording.

## Scope

In scope:
- proto/coflux/v1/client.proto
- Generated packages/protocol/src/gen, crates/protocol/src/gen, packages/swift-client/Sources/CofluxProtocol/Generated
- apps/server/src/hub.ts
- packages/client/src/store.ts and index exports if needed
- Web workbench workspace-terminal.tsx and terminal-pane.tsx
- New tests/src/task-read-history.test.mjs
- plans/README.md

Out of scope:
- supervisor/worker handwritten source; generated diff does not change daemon behavior
- apps/server/src/mcp: existing reads unchanged
- Mobile functionality, frozen; build only
- Swift client behavior, generated output only
- Checkpoint cadence/retention and log capacity

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol generation | `cd proto && buf generate` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| New black-box tests | `node --import tsx --test tests/src/task-read-history.test.mjs` | All pass |
| Full black-box acceptance | `pnpm -C tests test` | exit 0 |
| UI acceptance | User opens completed agent terminal in dev web, sees output/status, reopens to a new shell, and watches shell exit without losing scrollback | User confirmation |

## Done criteria

- [x] All commands pass except pending user UI walkthrough.
- [x] Stopped-tab activation shows final output/status without restarting; only Reopen starts a shell.
- [x] Panels watching exit append notification without clearing.
- [x] Black-box tests assert source/marker/status; three scenarios implemented as two tests, folding nonexistent-task negative into log case.
- [x] Implementation follows every entry in Decisions & tradeoffs.
- [x] No out-of-scope files changed.
- [x] Index updated.

## STOP conditions

- readTerminalForAccount signature/source semantics differ from hub.ts:3766-3800.
- Remote buf plugins cannot be downloaded and offline generation is impossible.
- Manual-shell case consistently lacks checkpoints, implying changed persistence conditions.
- Daemon source changes are necessary.

## Maintenance notes

- Fuller stopped-terminal replay, including complete manual-shell scrollback, requires daemon retention-policy changes, not web changes. Web consumes source; add future sources to the string enum.
- TaskReadResult has no request ID. If future concurrent reads of one task require different parameters, add IDs rather than forcing updatedAt heuristics.
