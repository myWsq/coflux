# Plan 093: Consolidate agent capabilities into MCP—remove cofluxd agent commands and the 074 control path; add notify_user/report_progress

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 6a0ab63..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/common.proto buf.yaml crates/worker/src apps/server/src/hub.ts apps/server/src/mcp apps/server/src/daemon-capabilities.ts packages/cli tests/src README.md`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none (consolidates 074/088 and 090–092; all six plans are DONE)
- Category: refactor (including two new MCP tools)
- Execution: subagent fable (preflight 2026-09-05: execute immediately after writing without further user confirmation; stop on STOP/BLOCK; push/PR/merge not authorized)
- Planned at: `6a0ab63`, 2026-09-05
- **WITHDRAWN 2026-09-05**: after the subagent reached M4 (`84c1153`/`9354a71`/`083c63c`/`d7511af`), the user established that agent operations which can complete locally must have no interaction with the center. This directly contradicts this plan's center-MCP-only direction. The entire plan was withdrawn and all four commits reverted. Reusable references: log-sink invariants, wait limits, reserved protocol precedent, and the log-sink implementation in `9354a71`.

## Requirement

Coflux currently offers two agent interfaces: 074/088's eight credential-free cofluxd commands (terminal new/list/read/wait/send, notify, progress, ports), identified through caller pid ancestry and restricted to its workspace; and 090–092's center-hosted MCP with OAuth, 14 tools, and account scope. Six terminal commands map directly to MCP tools, but semantics already differ: wait defaults to 30 minutes versus a 50-second limit; send defaults enter=false versus true; default titles are the literal `agent 终端` versus the first command line. CLI also has defects: wait/send find targets through terminal.list's latest-50 limit; worker /agent collapses BadRequest details into bad request; shared tee command logs grow unbounded. More fundamentally, the SKILL teaching these commands never reached Claude Code automatically: npm merely bundles it for manual symlinking, while the plugin has an older command-free SKILL.

After 092, COFLUX_* coordinates let MCP agents locate themselves, eliminating the CLI's unique local-context advantage. On 2026-09-05, the user chose **one MCP interface**.

**Required outcomes**, for Claude Code/Codex in coflux terminals and any configured MCP host:

1. cofluxd returns to daemon management plus the hook messenger. Help contains no agent commands. terminal/notify/progress/ports entries follow the MIGRATED-table pattern: explain migration to the corresponding MCP tool and exit nonzero. Hook behavior/activity detection stays identical.
2. MCP has 16 tools: existing 14 plus notify_user/report_progress. Preserve notify/progress semantics **exactly**: notify changes presence to question with a message, cleared by the next hook event; progress overwrites one field, survives hook events, and disappears with presence. Web/iOS see identical effects; **no UI changes**.
3. Both tools address terminalId, with the caller's own id in COFLUX_TASK_ID. Return readable errors, never silent success, for missing/foreign terminals, nonrunning/no-session terminals, offline devices, old daemons (existing upgrade-required copy), and **terminals with no detected claude/codex presence**.
4. wait_terminal retains a 30-second default and raises its maximum from 50 to **600 seconds**. Expiry still returns timedOut=true for another call. Describe the host's per-request timeout constraint; manually configured claude mcp add hosts still use 60 seconds.
5. Command logs are **bounded, retain the tail, and never cause SIGPIPE in the command**. source=log read_terminal returns recent output even for long-running dev servers, and original exit codes remain intact.
6. Remove the worker /agent loopback route, daemon-to-center AgentControlRequest path, and corresponding server handlers. Keep /hook unchanged; restore hook.rs's security argument to the fact that forged reports can only change display state.
7. SKILL teaches only COFLUX_* and 16 tools. Detect coflux only through environment; offer setup if MCP is missing and cofluxd update && cofluxd restart if variables are empty.
8. No crates/supervisor changes, so users need no restart; worker hot-upgrades through tags.

**Incorrect neighboring solutions**:

- Keeping CLI aliases or fallback functionality; old entries only show migration guidance.
- Overlaying notify/progress in the center, which cannot observe every hook event needed to clear messages.
- Daemon-hosted MCP or another CLI.
- Deleting proto message definitions, forbidden by buf breaking FILE checks.
- Capping with head -c or periodically truncating: the former kills commands with SIGPIPE; the latter loses tails or creates sparse files.
- Changing presence semantics, persisting annotations, adding history, or changing supervisor.

## Decisions & tradeoffs

- **Remove the entire 074 path**: delete eight cofluxd commands, hook.rs /agent, and 074 portions of agent_ctl.rs (AgentAction/consume_agent_requests/handle/ask_server/agent_pending). **Keep** 091's handle_server_request and remember_log. Delete hub handleAgentControl/dispatchAgentControl and their exclusive MAX_AGENT_TERMINAL_LIST. Remove main agent_pending, **keep agent_logs**. Rejected: CLI-only removal leaving unused paths and a false security rationale.
  Based on `crates/worker/src/hook.rs:151`, `agent_ctl.rs:48,484`, `apps/server/src/hub.ts:1186,1199,108`, `crates/worker/src/main.rs:97-100`.

- **Add ServerAgentRequest payloads and keep annotation semantics in worker observed**: center translates tool calls to daemon requests; worker invokes existing apply_notify/apply_progress and immediately reports presence at the same handling point as CLI. Add a **new capability name**, chosen by executor, and reject missing capability with existing upgrade-required copy. Rejected: center overlays, because apply_hook_state clears messages on every daemon-only hook; reusing terminal_io, which lets old daemons return unknown-action instead of upgrade-required, violating 091's gate contract.
  Based on `crates/worker/src/observed.rs:92-113`, `proto/coflux/v1/daemon.proto:258` oneof extension, `apps/server/src/daemon-capabilities.ts:1-8`.

- **Reject targets without agent presence, never return 200**: reports contain only sessions where claude/codex is detected; annotations for other sessions are pruned next scan, so accepting them silently loses data. Executor chooses latest committed report or fresh detection. Invariant: reject calls whose annotations would be pruned next scan.
  Based on `crates/worker/src/agents.rs:52` filter_map and observed merge_annotations retaining maps by the current present set.

- **Address/authorize like send_terminal_input**: accept terminalId, look up task/account, require RUNNING/sessionId, then gate online daemon/capability. Any account agent can annotate any account terminal with presence, under B2's user-owned-machine trust model.
  Based on `apps/server/src/hub.ts:3801-3815` sendTerminalInputForAccount and docs/OPEN_QUESTIONS.md B2.

- **Names notify_user/report_progress; reject messages over 200 characters** (decided while planning). CLI silently truncated to 200; MCP schema can explicitly reject with the limit. Based on agent_ctl.rs MAX_NOTIFY_CHARS.

- **Reserve envelope numbers and names; retain deprecated definitions**: reserve DaemonToServer field 32 agent_control_request and ServerToDaemon field 35 agent_control_result. Keep AgentControlRequest/Result, AgentTerminal*, AgentPortsList* definitions with comments saying no senders since plan 093. Rejected: deletion, because FILE includes MESSAGE_NO_DELETE; ExecResult/FsListed remain in common.proto for the same reason.
  Based on buf.yaml:8-9, daemon.proto:202-203 reserved precedent, :229/:454, common.proto:130/:139.

- **Move old entries into MIGRATED**: terminal/notify/progress/ports messages identify MCP tool names and COFLUX_MCP_URL setup. Rejected: unknown command, leaving agents driven by old skills/memory without a path. Based on cofluxd.mjs:1106 MIGRATED and :1136 handlers.

- **Wait default 30 seconds, maximum 600**: long HTTP requests traverse two reverse proxies and become more fragile with duration; repeating after expiry is cheap, and 600 covers a test/build. Rejected: the old CLI's 30 minutes, which used local loopback polling rather than one long request. Claude Code timeout is max(60s, server timeout, MCP_TIMEOUT). Plugin .mcp.json supports per-server timeout as a companion task. Tool description explicitly notes host timeout limits.
  Based on hub.ts:126-127, mcp/tools.ts:59-60, and https://code.claude.com/docs/en/mcp.md tool-call timeouts.

- **Log-sink invariants: bounded, tail-preserving, never break the pipe, unchanged exit code**. Modify only shared write_command_script_named. Preserve write_operation_command_script path derivation because sessiond canonical requests include shell and changed replay paths cause operation_collision. Preserve command exit code, which agents depend on. Executor chooses mechanism; a worker-binary log-sink subcommand located with std::env::current_exe avoids external dependencies. Capacity is executor-selected but **at least 256KB**, the read_terminal read window. Delete 074-only nonoperation write_command_script with its path. Rejected: head -c SIGPIPE, periodic truncate of nonappend tee creating sparse files/NULs, or retaining only the head, useless for dev servers.
  Based on ops.rs:373 tee/PIPESTATUS template, :337 naming, device.rs:2044-2047 canonical-path rule, agent_ctl.rs:44 MAX_SERVER_READ_BYTES, ops.rs:16/159 seven-day cleanup only for stale mtimes, never active logs.

- **No supervisor changes**: all worker changes remain within worker, without IPC/sessions.rs changes. Rejected: supervisor edits requiring manual fleet restarts. Based on 074's same decision; crates/supervisor out of scope.

- **One SKILL interface, same source location**: packages/cli/skills/coflux/SKILL.md remains sole source. npm distributes it for Codex symlinking; companion work replaces Claude plugin copy. Teach only variables/16 tools, detect using COFLUX_WORKSPACE_ID, and remove local-command probing. Based on CLI README:48-51 and the outdated command-free plugins-builder/plugins/coflux/skills/coflux/SKILL.md.

- **Migrate tests from CLI to MCP**: delete agent-control.test.mjs and agent-terminal-io.test.mjs, entirely CLI-driven. Preserve equivalent assertions for notify's center broadcast/message and progress surviving hooks/overwriting. Add no-presence rejection, old-daemon upgrade-required, a real wait longer than 60 seconds, and over-capacity logs still returning latest lines/correct exit code. Executor chooses mcp-write-tools.test.mjs or a new file.
  Based on agent-control.test.mjs:84-194, agent-terminal-io.test.mjs:88-176, mcp-write-tools.test.mjs:101-113 enrollFakeDaemon(name, capabilities).

## Direction

notify_user flow, with report_progress equivalent:

```
agent → MCP tool(terminalId, message) → center
  task/account validation → RUNNING + sessionId → online/capability gate
  → ServerAgentRequest{notify} → worker
    presence gate → observed.apply_notify → immediate report_agents
    → ServerAgentResult → center → tool response
Web/iOS receive question + message through existing SessionAgents broadcasts, with no UI changes
```

### Milestone 1: Protocol and capability

Reserve both envelope fields by name/number; add notify/progress branches to ServerAgentRequest/Result. Update common.proto message/progress comments to stop referencing CLI commands. Match capability constants in worker/server. Regenerate Rust/TS.
Validation: buf lint/breaking against CI's baseline with no new violations, generated output zero diff, `cargo test -p coflux-protocol`, server typecheck all pass.

### Milestone 2: Worker

Remove /agent and 074 portions, preserve /hook. Add presence-gated notify/progress handling, implement log-sink invariants in the shared template, rewrite hook security comments, and point device.rs communication rejection copy to notify_user.
Validation: `cargo build -p coflux-supervisor -p coflux-worker` passes without warnings; `cargo test -p coflux-worker` passes; `git diff --stat 6a0ab63..HEAD -- crates/supervisor` is empty.

### Milestone 3: Server

Remove 074 handlers. Add account-validated/capability-gated operation methods through requestDaemonAgent, register two tools, and synchronize the 600-second wait limit/descriptions.
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 4: CLI, SKILL, documentation

Delete eight commands/help, move four entries into MIGRATED, rewrite SKILL and root/CLI README for MCP only.
Validation: `node packages/cli/cofluxd.mjs --help` succeeds without terminal/notify/progress/ports; `node packages/cli/cofluxd.mjs terminal list` exits nonzero with MCP tool names.

### Milestone 5: Black-box migration and acceptance

Remove CLI cases, add MCP cases described above, and negatively validate by removing presence/capability gates and observing failures.
Validation: `pnpm -C tests test` passes except two existing cli-doctor baseline failures.

## Landmines

- write_command_script_named is shared by 074 and 091. Preserve the operation_id-derived path in write_operation_command_script; change template only (ops.rs:373, device.rs:2044-2047).
- LocalEndpoints at hook.rs:40 loses only agent_tx. /hook still uses agents::session_of_pid; do not clean up agents.rs incidentally.
- AGENT_NAMES at agents.rs:16 contains claude/codex; interpreter detection checks argv[1] basename. The log sink appears in the process tree; its executable/first argument must not resemble those names.
- observed merge_annotations prunes by scanned presence. Center-side task RUNNING alone misses a living shell whose agent exited.
- hub.ts:131 AGENT_REQUEST_TIMEOUT_MS=10s is enough for local annotation acknowledgments; add no waiting primitive.
- wait_terminal's maximum occurs in constant, zod bound, tools.ts:435 description, and SKILL bounded-wait guidance. Update all four.
- device.rs:1572 and common.proto:114-121 mention old notify/progress commands. Regenerate outputs, never edit generated Rust/TS manually.
- Existing tests send real-PTY hooks using cofluxd hook claude at agent-control.test.mjs:178/agent-terminal-io.test.mjs:212. Keep the messenger and reuse it for message-clearing/progress-survival tests.
- Node requestTimeout's five-minute default governs request-body reception, not handlers, but prove >60-second waits with real HTTP rather than trusting docs. The user verifies 600-second production requests through owo-jp-gw after deployment.
- Worker hot upgrades lose agent_logs and read_terminal falls back to snapshot/checkpoint. Existing behavior, not fixed here.
- Remove parseArgs title/cmd/lines/timeout/text/enter options used only by agent commands. Preserve cmdHook's never-write-stdout contract.

## Scope

In scope:
- daemon.proto, common.proto, and generated crates/protocol/src/gen / packages/protocol outputs
- crates/worker/src hook.rs, agent_ctl.rs, main.rs, ops.rs, device.rs, observed.rs, new log-sink module/subcommand
- apps/server/src/hub.ts, daemon-capabilities.ts, mcp/tools.ts
- packages/cli/cofluxd.mjs, README.md, skills/coflux/SKILL.md
- Root README dual-interface description near line 51
- agent-control.test.mjs, agent-terminal-io.test.mjs, mcp-write-tools.test.mjs or a new file
- plans/README.md

Out of scope:
- crates/supervisor: hard zero-change constraint
- Web/iOS/mobile UI and presence broadcast shape
- Server oauth.ts and /mcp wiring established in 090
- agents.rs detection rules still used by /hook/presence
- plugins-builder .mcp.json/timeout/SKILL companion work
- Annotation persistence/history/APNs

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint | `buf lint` | exit 0 |
| Compatibility | `buf breaking --against <CI-baseline>` | exit 0; no new violations |
| Generated consistency | Regenerate with CI steps, then `git status --porcelain` | Empty |
| Rust unit tests | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0; no warnings |
| Supervisor unchanged | `git diff --stat 6a0ab63..HEAD -- crates/supervisor` | Empty |
| Typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| CLI help | `node packages/cli/cofluxd.mjs --help` | exit 0; no agent commands |
| Migration guidance | `node packages/cli/cofluxd.mjs terminal list` | Nonzero; MCP tool names |
| Black-box acceptance | `pnpm -C tests test` | All pass except two existing cli-doctor cases |

## Done criteria

- [ ] All listed commands pass.
- [ ] cofluxd only manages daemon/hooks; four old entries direct users to MCP.
- [ ] notify_user/report_progress reach worker through center and broadcast identical message/progress shapes; next hook clears notify, while progress survives and is overwritten by the next report.
- [ ] No-presence, old-daemon, offline-device, and foreign-account targets return readable errors.
- [ ] wait_terminal maximum is 600 seconds, with a real >60-second black-box wait.
- [ ] Logs remain bounded and retain latest lines beyond capacity with correct command exit codes.
- [ ] No worker /agent, AgentControlRequest sender, or server 074 handler; /hook tests still pass.
- [ ] SKILL teaches only variables/16 tools, with no cofluxd terminal/notify/progress/ports references.
- [ ] Meaningful tests exist and new cases were negatively validated.
- [ ] Every Decisions & tradeoffs entry is followed.
- [ ] No out-of-scope changes, especially zero supervisor diff.
- [ ] plans/README status updated.

## STOP conditions

- A cited fact no longer holds.
- Log invariants cannot be achieved without changing supervisor.
- buf breaking still rejects reserved fields and cannot be satisfied without deleting messages.
- Out-of-scope files are required.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- **Companion plugins-builder task, tracked separately**: add plugin .mcp.json with `"url": "${COFLUX_MCP_URL:-https://api.coflux.dev/mcp}"`, expanded by Claude Code from shell environment at startup so coflux PTYs use the correct local/production center. Set per-server timeout ≥600000ms, replace SKILL with this repository's source, bump version, and release. Claude docs confirm plugin MCP uses the same OAuth as manual setup, connects when enabled, and needs no separate approval: https://code.claude.com/docs/en/plugins.md and https://code.claude.com/docs/en/mcp.md. Codex users still run `codex mcp add coflux --url "$COFLUX_MCP_URL"` manually.
- **Rollout**: next tag hot-upgrades workers, deployment updates server, npm updates CLI/SKILL. Old CLI/new worker returns 400 bad request from removed /agent, accepted because old SKILL never reached agents. New tool/old worker returns upgrade-required through capability gating.
- After deployment, the user verifies one >60-second wait through owo-jp-gw. If cut off, adjust proxy timeout or this plan's 600-second maximum, not tool semantics.
- Retention capacity is an estimate. If users need early output from long-running terminals, consider offset reads rather than blindly increasing capacity.
- Future agent capabilities enter through MCP only; cofluxd hosts none. hook.rs security rationale remains display-only.
