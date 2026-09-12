# Plan 074: First slice of AI collaboration—agents in PTYs expose work as visible, user-controllable coflux entities

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7cbed03..HEAD -- proto crates/worker/src crates/supervisor/src/sessions.rs apps/server/src/hub.ts packages/cli/cofluxd.mjs packages/client/src/store.ts apps/web/src/components/workbench/sidebar.tsx tests/src`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `7cbed03`, 2026-08-15

## Requirement

Claude/Codex running inside a coflux PTY currently has **no awareness of, or control over, its coflux environment**. To run a long task, it can only start a background process through Bash. That process has no coflux entity: users cannot see it in the web/mobile sidebar, take it over, or receive a request for help when it gets stuck.

**The value here is not giving AI more execution primitives.** Bash already runs commands, creates worktrees, and tails logs; routing those through coflux adds almost nothing. coflux's unique asset is **keeping the human in the loop**: AI-created work becomes a **real terminal** visible on web/mobile, which the user can take over at any time, with proactive requests for help and one-click port previews. Every design choice in this plan must serve that purpose.

**After implementation**, an agent running in a coflux terminal can do the following:

```text
cofluxd terminal new --title "Run unit tests" --cmd "pnpm -C tests test"
  → A real terminal titled "Run unit tests" immediately appears in the user's sidebar; the user can open and take it over.
cofluxd terminal list
  → Returns id/title/status/exit_code for all terminals in the agent's workspace.
cofluxd terminal read <task-id>
  → Returns the terminal's current contents as plain text with ANSI escape sequences removed.
cofluxd notify "I need your decision on X"
  → The workspace sidebar status becomes "waiting for interaction"; its tooltip displays this message.
cofluxd ports
  → Returns preview URLs for listening ports in this session's process tree.
```

Ship a SKILL.md explaining when agents should use these commands: open real terminals for long tasks instead of background processes, call `notify` when blocked, and inspect `exit_code` through `list` after completion.

Nearby but incorrect solutions:

- This does **not** let AI type into terminals. AI only creates and reads them; humans always take over interaction (decision 1).
- Do **not** issue a client token for direct access to the center. That grants account-wide authority and contradicts workspace-only control (decision 3).
- This is **not** an MCP server. Deliver CLI subcommands and SKILL.md (decision 8).
- Do **not** silently start local daemon processes. Invisible processes contradict the entire purpose of this plan.

## Decisions & tradeoffs

- **AI has no PTY write access; it only creates and reads.** The command is fixed when AI creates a terminal. Afterward it may only read snapshots and status: never attach, hold the holder, or send `DevicePtyInput`. The user takes over further interaction.
  Rejected: (1) AI attaches as an ordinary client and claims the holder, evicting the user viewing output (`DeviceSessionAttached` increments holder_epoch and sends detached to the previous holder)—a disastrous UX; (2) adding non-exclusive side-channel input, which breaks plan 042's per-client, contiguous `input_seq`, exactly-once serial contract and is the most expensive option.
  Based on: holder and input_seq contract comments for `DeviceSessionAttach`/`DevicePtyInput` in `proto/coflux/v1/device.proto`. **This plan must not change any sessiond holder / input_seq / attach semantics.**

- **No supervisor changes; the worker wraps commands in temporary scripts passed to the PTY.** The worker writes a temporary script using the existing daemon temporary-directory support for `fs.write`, with contents such as `exec <shell> -lc '<command>; exec <shell> -i'`, then passes its path as `SessionCreate.shell`. The command is the first process executed: no race waiting for a prompt before writing, no input echo issue, and normal process-tree detection.
  Rejected: (1) adding `args` to `SessionCreate` and changing supervisor. Supervisor **does not hot-upgrade**; every daemon user would need to run `cofluxd update` manually. That one-time cost is too high for this first feature slice. (2) Having worker write initial input after session creation is PTY writing, contradicts decision 1, and risks losing characters before the shell is ready.
  Based on: `crates/supervisor/src/sessions.rs:336-338` chooses the default shell for an empty value, otherwise calls `CommandBuilder::new(&shell)`, which **accepts only an executable name, not arguments**. `crates/worker/src/main.rs:1164-1165` forwards `shell` unchanged from the server's `SessionCreate` to supervisor.
  **If this approach proves impossible, STOP and report; do not change supervisor.**

- **AI has no credentials; worker derives identity by locating the caller PID in a process tree.** The CLI reports its PID to the loopback endpoint. Worker traverses live session process trees to find its session. **Reject a PID absent from every live session tree.** This is both identity and the security boundary: only processes in PTYs created by coflux can call these capabilities; reject all other local processes. Preserve the existing `content-type: application/json` requirement in `hook.rs`, which blocks browser cross-origin requests through failed preflight.
  Rejected: issuing tokens introduces storage, rotation, and leakage questions, none of which PID lookup requires.
  Based on: `detect_in_tree` in `crates/worker/src/agents.rs`, `ports::process_tree(root_pid)`, security-boundary comments at `crates/worker/src/hook.rs:17-19`, and the existing out-of-tree PID rejection test at `tests/src/agent-activity.test.mjs:168`.

- **Center operations use the daemon control WS directly, not prepared operations.** Server creates a Task upon receiving the daemon request, then sends `SessionCreate` directly over the daemon control WS using the existing `ServerToDaemon` payload.
  Rejected: reusing browser prepared operations. Their final hop gives a frame to the **client**, which forwards it over the device channel; the AI scenario has no browser client to forward it. Prepared operations exist because the browser is untrusted, while daemon control WS is an **authenticated, trusted control plane**. The detour adds failure modes.
  Based on: `startOrAttachTask` at `apps/server/src/hub.ts:1669-1713` uses `preparedFrame`, `prepareOperation`, and `sendPrepared(client, ...)`; `crates/worker/src/main.rs:1164` confirms that the server→daemon control-WS `SessionCreate` path **remains live**, forwarding to supervisor to start a PTY.

- **Only `terminal new` and `terminal list` require new server round trips; the other three commands finish locally on daemon.** `terminal read` uses worker's existing local snapshots; `ports` uses existing port detection; `notify` reuses plan 073 presence (next decision). This minimizes protocol additions.
  Based on: comments for `DeviceSessionSnapshotRequest` in `proto/coflux/v1/device.proto` explicitly define a read-only atomic snapshot that registers no subscriber and neither reads nor changes the holder, used by worker to generate center checkpoints; `crates/worker/src/ports.rs` detects process-tree ports.

- **Notify reuses 073 presence instead of introducing a notification channel.** `cofluxd notify "…"` makes worker set this session's hook state to `question` with the message, immediately report `SessionAgents`, and use server's existing `acceptSessionAgents` broadcast. The web sidebar already renders the icon; only tooltip text is needed. Add `message` to `SessionAgentRef` at the next available field number, **5**.
  Rejected: a new AI→user message entity requires persistence, read state, and UI on three clients—too much for the first slice. Users already watch 073's four-state icon. Real APNs push is a separate topic.
  Based on: `SessionAgentRef.state` at `proto/coflux/v1/common.proto:105-115`; `acceptSessionAgents` and broadcast at `apps/server/src/hub.ts:479-506`; subscription replay at `hub.ts:1244-1245`; `merge_hook_states` at `crates/worker/src/main.rs:225-230`.

- **Server resolves workspace ownership from task_id; daemon reports only session_id.** Daemon need not know its workspace. It identifies session S; server follows `session → task → task.workspaceId`. This also validates ownership: the session must belong to a task on that daemon.
  Rejected: matching worker cwd against paths in `WorkspaceList`, which adds another inference that could disagree with the center.

- **Deliver CLI subcommands and SKILL.md, not MCP.** Reuse `localGatewayPort()` in `packages/cli/cofluxd.mjs`, including the `COFLUX_LOCAL_GATEWAY_PORT` environment override required by tests. Both Claude and Codex can run shell commands.
  Rejected: exposing an MCP server on daemon requires JSON-RPC implementation, user edits to `~/.claude.json`, and separate evaluation of Codex support. More structured tool descriptions do not justify the much larger installation surface.

- **Enforce an active AI-terminal limit per workspace on server** (suggested configurable default: 8). A runaway agent could create dozens. Under the B2 trust model this is a UX issue, not a security issue: a simple hard limit and readable error suffice; no quotas, reclamation, or priorities.
  Based on: B2 in `docs/OPEN_QUESTIONS.md`: only the owner's machines, no path allowlist, sandbox, or container needed.

- **Strip ANSI escapes in the CLI** (decided while planning). Worker snapshots remain faithful and unchanged because they also feed checkpoints; do not alter them for AI readability. The CLI strips escape sequences with a regex before printing to stdout.
  Rejected: worker conversion would add Rust VT-to-text logic and compromise the snapshot's single meaning.

- **CLI does not automatically retry requests with side effects** (decided while planning). A `terminal new` timeout returns an error; AI decides whether to retry.
  Rejected: automatic retries can create duplicate terminals when requests are in flight across daemon control-WS reconnections. Adding operation_id idempotency is too much protocol complexity for a low-frequency command.

## Direction

Data flow for `terminal new`; other commands follow an equivalent or shorter path:

```text
agent process ──POST to /hook-style loopback endpoint──> worker
    ├─ Locate caller PID in process trees → session_id; reject if absent
    ├─ Write temporary script containing --cmd
    └─ daemon control WS → server
        ├─ session_id → task → workspace; validate ownership
        ├─ Check limit
        ├─ Create Task with title = --title; broadcast taskUpdated
        └─ control WS → SessionCreate{shell=script path}
            → worker → supervisor starts PTY
            → SessionStarted report → task RUNNING
            → User sidebar shows a terminal available for takeover
    ← Return result
agent receives task_id
```

Verified next available proto field numbers: **32** in `DaemonToServer`, **35** in `ServerToDaemon`, and **5** in `SessionAgentRef`.

### Milestone 1: Protocol surface

Add daemon→server request and server→daemon result pairs in `proto/` for terminal new and list. Add `SessionAgentRef.message`; synchronize Rust and TS generated artifacts and wire formats.
Validation: `cargo test -p coflux-protocol` and `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exit 0; `buf lint` and `buf breaking` add no violations using CI commands; generated artifacts have no diff.

### Milestone 2: Worker control endpoint

Expand loopback from UI-state updates into a control endpoint constrained by PID identity: resolve session from process trees and reject outsiders, generate temporary scripts, read local snapshots and ports, and set notify's `question` state/message with an immediate presence report. Rewrite the security-boundary comments at the top of `hook.rs` to reflect the expanded permissions. **No changes** under supervisor.
Validation: `cargo build -p coflux-supervisor -p coflux-worker` exits 0 with zero warnings; `git diff --stat <baseline>..HEAD -- crates/supervisor` is empty.

### Milestone 3: Server orchestration

Add handlers to validate ownership (`session → task → workspace → daemon`), enforce the workspace's active AI-terminal limit, create/broadcast Task, send `SessionCreate` over control WS, and return results to the requesting daemon. Forward presence `message` through existing broadcast and subscription replay paths.
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exits 0.

### Milestone 4: CLI subcommands and SKILL.md

Implement the five commands `cofluxd terminal new|list|read`, `cofluxd notify`, and `cofluxd ports` using `localGatewayPort()`. Write output to **stdout** for AI consumption. Readable errors distinguish "not in a coflux terminal," "daemon disconnected from center," and "limit exceeded." SKILL.md explains when to open real terminals for long tasks, notify the user when blocked, and use list's exit_code to detect completion.
Validation: `node packages/cli/cofluxd.mjs --help` exits 0 and lists the new commands.

### Milestone 5: Black-box acceptance and sidebar tooltip

Add tests in `tests/src/` with an unused port. Execute CLI in a real session and assert that center creates a Task transitioning to RUNNING, `list` includes it, `read` returns plain text, and `notify` sets presence to `question` with its message. Assert **out-of-tree PID rejection** and **limit enforcement**. Verify the new tests fail when the server handler is removed.
Show the presence message in the web sidebar's existing tooltip.
Validation: `pnpm -C tests test` passes except for the existing `cofluxd doctor` baseline failure; `node_modules/.bin/tsc -b apps/web/tsconfig.json` exits 0.

## Landmines

- `CommandBuilder::new(&shell)` at `crates/supervisor/src/sessions.rs:338` has **no args**. Passing `pnpm test` in `SessionCreate.shell` attempts to execute that entire string as a filename.
- The server→daemon `SessionCreate` path at `crates/worker/src/main.rs:1164` **remains live**. After the local-first refactor (036–042), assuming prepared operations are the only session creation route adds an unnecessary detour.
- `startOrAttachTask` at `apps/server/src/hub.ts:1669` ends with `sendPrepared(client, ...)`, handing the frame to a **browser client**. Copying it into the AI path stalls because no client exists.
- Security comments at `crates/worker/src/hook.rs:17-19` currently say forged reports only change display state and trigger no operations. Expanded privileges make this false. **Rewrite them together with the implementation**, or future contributors may make incorrect security decisions.
- `packages/cli/cofluxd.mjs:679-680` says hook must never write stdout because Claude parses hook stdout as decision JSON. **New subcommands must write stdout**: they are ordinary commands for AI consumption, not hooks. Do not copy that restriction.
- `AGENT_NAMES = ["claude", "codex"]` at `crates/worker/src/agents.rs:31` and interpreter rules inspect the basename of `argv[1]`. **Do not** name wrapper scripts `claude` or `codex`, or they will be mistaken for agents.
- `tests/src/agent-activity.test.mjs:136-137` demonstrates black-box CLI testing: execute `COFLUX_LOCAL_GATEWAY_PORT=<port> node <COFLUXD> …` using `device.input()` in a real session. The harness never runs the installer; neither should new tests.
- Each `*.test.mjs` owns its top-level `const PORT`; choose an unused port.

## Scope

In scope:
- `proto/coflux/v1/{common,daemon}.proto` and generated artifacts
- `crates/worker/src/{hook,main,agents,ports}.rs` and required new worker modules
- `apps/server/src/hub.ts` and config
- `packages/cli/cofluxd.mjs`
- SKILL.md distributed with the CLI package; executor chooses its location from the live repository
- `packages/client` and `apps/web` sidebar tooltip message display
- New tests under `tests/src/`

Out of scope:
- `crates/supervisor/**`: hard constraint, zero changes; decision 2
- sessiond holder / input_seq / attach semantics: hard constraint, zero changes; decision 1
- `cofluxd workspace new` for AI-created parallel worktrees: child-agent launch, prompt delivery, and result collection need a separate plan; also the unresolved B5 in `docs/OPEN_QUESTIONS.md`
- MCP server: rejected in decision 8
- Real APNs push: separate topic
- `apps/mobile` and `apps/ios`: no functionality in this slice; mobile is frozen, and iOS presence messages can follow once stable

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Black-box integration | `pnpm -C tests test` | All pass except existing `cofluxd doctor` baseline failure |
| Rust unit tests | `cargo test -p coflux-protocol` | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Server type checking | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Verify no supervisor changes | `git diff --stat <baseline>..HEAD -- crates/supervisor` | Empty output |

Following repository practice, the user performs visual acceptance for web; no Playwright/UI walkthrough.

## Done criteria

- [ ] All listed commands pass.
- [ ] Running `cofluxd terminal new --title X --cmd Y` in a real session creates a center Task with title=X, transitions it to RUNNING, and actually executes the command in that PTY.
- [ ] `terminal list` returns workspace terminals and status/exit_code; `terminal read` prints plain text without ANSI escapes.
- [ ] `notify` sets session presence to `question` with a message, broadcast through center to clients.
- [ ] All out-of-tree PIDs are rejected; exceeding the workspace limit returns a readable error.
- [ ] No changes to `crates/supervisor/` or holder / input_seq / attach semantics.
- [ ] New black-box tests were negatively verified: removing the server handler fails them while other tests continue passing.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Worker temporary-script wrapping proves infeasible without changing supervisor to deliver commands to PTY: STOP and report; do not change supervisor.
- The server→daemon `SessionCreate` path at `crates/worker/src/main.rs:1164` is no longer live or its semantics changed.
- Implementation requires changing holder / input_seq / attach semantics.
- Any account-level credential must be issued to AI.
- A validation command still fails twice consecutively after one reasonable repair attempt.
- Changes are needed in out-of-scope files.

## Maintenance notes

- **Production requires a release**: worker changes reach daemons only through tagged hot upgrades, as in 072/073. Green local black-box tests do not establish production availability. Server/web changes take effect on deployment; CLI changes require npm publication. These schedules differ. During initial rollout, ensure a new CLI talking to an old worker receives a readable rejection rather than silent failure.
- The loopback endpoint is no longer display-only. Every future capability addition must revisit the security argument at the top of `hook.rs`, not assume it still holds.
- The per-workspace limit of 8 is an estimate. Frequent limit complaints should prompt an automatic reclamation policy for AI-created terminals rather than a simple increase—the same issue as ROADMAP's retention/GC policy for exited tasks.
- A second slice (`workspace new` and child-agent orchestration) must revisit the no-PTY-write decision: the proper way to feed child agents prompts is **command-line arguments at creation**, such as `claude -p "…"`, not subsequent PTY typing.
