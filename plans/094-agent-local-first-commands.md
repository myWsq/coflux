# Plan 094: Local-first agent commands, bounded logs, clearer errors, and explicit local/MCP responsibilities

> This plan is an outcome contract, not a step-by-step script. Understand requirements and decisions, then design against live code. Validate milestones only if also the verifier; delegated executors implement with verification outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat ac19939..HEAD -- crates/worker/src packages/cli apps/server/src/hub.ts apps/server/src/mcp/tools.ts tests/src README.md`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none (replaces withdrawn 093; 074/088/090–092 DONE)
- Category: refactor + bug
- Execution: self (2026-09-05 departure check authorizes immediate execution without further confirmation, observing STOP/BLOCK; no push/PR/merge)
- Planned at: `ac19939`, 2026-09-05

## Requirement

The user's 2026-09-05 principle: **agent operations that can complete locally must have no interaction with the center.** Claude/Codex in Coflux PTYs talk to local daemon through credential-free terminal/notify/progress/ports, identified by PID ancestry. Central MCP serves agents elsewhere, child-workspace creation, and cross-device operations. Plan 093's removal of eight local commands in favor of MCP contradicts this and is withdrawn.

Its explored defects remain real and must be fixed while retaining both paths:
- Wait/send find targets through a last-50 list and miss older terminals.
- Send ownership, wait exit status, and read status/checkpoint unnecessarily round-trip through center.
- /agent discards BadRequest detail; 4 KB bodies conflict with MCP's 16 KB commands.
- Shared tee command logs grow forever for long-lived dev servers.
- SKILL presents paths as peers without explaining selection.

Outcomes for agents in Coflux terminals:

1. Retain all eight local commands and current help surface; hook/activity behavior unchanged.
2. **send/read/wait/notify/progress complete locally**, without AgentControlRequest or current center connectivity. Local ownership restricts targets to caller workspace; local ledger supplies status/exit code; content is log tail or current sessiond snapshot. Offline notify/progress reaches users through existing full presence reporting after reconnect.
3. **new/list/ports still ask center through daemon WS** because tasks need persistence/broadcast and preview URLs are centralized. Disconnected behavior remains explicit error.
4. Direct taskId addressing avoids list limits. Wait on exited terminals returns immediately; missing, foreign-workspace, and pre-upgrade unknown-ownership targets return readable errors.
5. Every /agent rejection exposes its cause: missing parameters, oversized input, unknown action, body limit. Command limit 16 KB and send text 64 KB match MCP. /hook unchanged.
6. Logs are **bounded, tail-retaining, never cause command SIGPIPE, and preserve exit codes**; long-running read returns newest tail.
7. MCP wait_terminal stays default 30 seconds, raises max 50→600, documents host request-timeout limits. Other thirteen tools unchanged.
8. SKILL checks COFLUX_* first, mandates local commands for locally complete work and MCP only beyond the current workspace, removes obsolete two-second local-read delay claims, and describes cross-machine MCP use.
9. Zero supervisor/protocol changes.

Not this: deleting local commands or adding MCP notify/progress; inferring ownership by cwd/WorkspaceList instead of center-issued IDs; daemon-held long wait requests; /hook error/security changes; head -c/periodic truncation; supervisor/proto changes.

## Decisions & tradeoffs

- **Worker-local session ledger** maps session→task_id/workspace_id/state/exit_code, sourced only from direct/prepared SessionCreate and worker-observed SessionExit. Retain exited entries within executor-chosen count/time bounds. Caller/target workspace IDs must match and be nonempty. Unknown ownership, including pre-upgrade or sessiond-discovered sessions after hot upgrade, returns a readable reopen-after-upgrade message. Rejected: center lookup violates principle; cwd fallback invents competing ownership truth, as rejected in 074. Evidence: main.rs:1747-1808 direct create, device.rs:2270-2323 prepared create, main.rs:978-994 exits, observed.rs:15 alive only task/PID.
- **Keep ledger separate from alive.** Presence/ports/079 reconciliation precisely consume (task_id,pid); changing alive's shape affects every scanner. Ledger is an independent map fed lifecycle events. Evidence: main.rs:909-1040, agents.rs:52, observed.rs:241.
- **Five local commands do not check authed.** Notify/progress update observed and attempt report_agents_if_changed; offline failure is fine because reconnect force_report_agents resends all. Send/read/wait are center-independent. Keep ask_server auth checks only for new/list/ports. Evidence: main.rs:1335.
- **Wait polls new local terminal.status every three seconds**, preserving the 30-minute default. Status comes from ledger. Rejected: daemon-held requests hit loopback's 25-second timeout and require segmentation without benefit. Evidence: hook.rs AGENT_TIMEOUT and CLI WAIT_POLL_MS.
- **Read order: local log tail→live sessiond snapshot→empty**, with ledger status/exit. Reuse 091 TerminalRead logic, never center checkpoint. Evidence: agent_ctl.rs:484-538, device.rs:1616.
- **Expose /agent BadRequest detail, preserve /hook.** Separate serve error rendering; /agent 400 body is `{"ok":false,"error":"<detail>"}`. Increase body size enough for 64 KB text plus envelope, suggested 128 KB. Match server 16 KB command and 64 KB input constants. Evidence: hook.rs:121,31 and hub.ts:134-135.
- **Bounded tail log sink invariants** apply in shared write_command_script_named only. Preserve operation-script deterministic path derivation and original command exit-code propagation. Retention at least 256 KB read window. Withdrawn 093 commit 9354a71 has a reusable worker log-sink implementation. Rejected: head -c causes SIGPIPE; periodic truncation creates sparse NUL holes; retaining only beginning loses current output. Evidence: ops.rs:373,337,16,159; device.rs:2044-2047; agent_ctl.rs:44.
- **MCP wait default 30/max 600 seconds.** Long HTTP holds are fragile; repeat after timeout cheaply. Document host limits: Claude request time is max(60s, server timeout, MCP_TIMEOUT), configurable per server in plugin .mcp.json. Evidence: hub.ts:126-127, tools.ts:59-60.
- **No protocol changes.** AgentControlRequest terminal_read loses its sender but stays under buf breaking FILE precedent, without proto/generated edits. Evidence: buf.yaml:8-9, common.proto:130,139 retained unused messages.
- **One SKILL selection rule**: variables→local-first rule→eight commands→MCP only outside workspace→fourteen tools→boundaries. Source remains packages/cli/skills/coflux/SKILL.md. Updating builder's old command-free plugin SKILL and adding MCP config is separate companion work. Evidence: CLI README:48-51.
- **Supervisor untouched**: ledger/log sink/error handling all live in worker, as in 074.
- **Extend existing CLI black-box files** agent-control and agent-terminal-io: immediate exited wait/status, direct addressing beyond MAX_AGENT_TERMINAL_LIST using many terminals or a test-controllable approach, detailed oversized-command errors, log overflow retaining newest tail and exit status. Add real >60-second MCP wait in mcp-write-tools. Evidence: agent-control:84-194, agent-terminal-io:88-176.

## Direction

```text
agent → POST /agent with PID → worker identifies caller session
  ├─ send/read/wait(status)/notify/progress
  │   → local ownership/status/exit ledger + local logs/snapshot + observed
  └─ new/list/ports → existing AgentControlRequest → center
```

### Milestone 1: Local worker loop

Feed ledger from both creates/exits with bounded exited retention. Complete five actions without authed/center. Expose /agent details/limits and integrate bounded sink in shared script template.
Validation: warning-free daemon build, worker tests, empty supervisor/proto diff from ac19939.

### Milestone 2: CLI and SKILL

Wait polls terminal.status; read/send use new responses. Synchronize help/errors, SKILL, CLI README, root README responsibilities.
Validation: help exits 0 with all eight commands.

### Milestone 3: MCP wait maximum

Align max 600 across constant/schema/description; update SKILL bounded-wait section.
Validation: server tsc exits 0.

### Milestone 4: Black-box tests

Add specified cases and negative variants removing ledger ownership or sink logic to prove failures.
Acceptance: full suite passes except two existing cli-doctor baselines.

## Landmines

- Shared script template serves 074 and 091. Operation filenames derive deterministically from operation_id; change template, never naming or PIPESTATUS propagation.
- AGENT_NAMES are claude/codex; interpreter detection reads argv[1] basename. Sink process executable/first argument must not resemble those agent names.
- Splitting serve errors by path must preserve /hook 400/404/200 shape asserted by agent-activity tests.
- Existing TerminalSend asks center list then device.agent_send_input; retain local input path/human-holder checks/TOCTOU reasoning, changing only ownership source.
- Exit processing guards (task_id,pid) against stale reports; update ledger after the same check, never on bare sessionId.
- Hot-upgraded workers learn live sessions without workspace_id from sessiond. Readable rejection is intentional; never infer via cwd.
- Hook command is silent; others write stdout. After wait switches to status, errors may still validly recommend terminal list for discovery.
- Existing I/O tests assert `# exited exit=…` and user-control denial text; synchronize deliberate copy changes.
- Prove >60-second MCP holds using actual HTTP. Node requestTimeout only bounds body receipt; user verifies production proxy after deployment.

## Scope

In scope:
- Worker hook/agent_ctl/main/ops/device/observed and new ledger/sink modules
- CLI executable/README/source SKILL
- Server hub TERMINAL_WAIT_* constants and MCP wait constants/description only
- Root README responsibilities
- Three named black-box files
- Plan index

Out of scope:
- Supervisor/proto/generated outputs, hard zero-change rule
- Web/iOS/mobile UI
- Other thirteen MCP tools, OAuth, MCP wiring
- Builder repository, companion task
- Agent detection rules used by presence/hooks

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Worker tests | `cargo test -p coflux-worker` | exit 0 |
| No supervisor/protocol change | `git diff --stat ac19939..HEAD -- crates/supervisor proto crates/protocol packages/protocol` | Empty |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Help | `node packages/cli/cofluxd.mjs --help` | exit 0, eight commands |
| Black-box acceptance | `pnpm -C tests test` | Pass except two cli-doctor baselines |

## Done criteria

- [ ] All commands pass.
- [ ] Five local actions send no AgentControlRequest and check no authed, visible in review.
- [ ] Exited wait returns immediately; send/wait/read bypass list-50 limitation.
- [ ] Detailed /agent errors, 16 KB commands/64 KB input, unchanged /hook.
- [ ] Bounded tail logs, latest overflow output, correct exit status.
- [ ] MCP max 600 and actual completed >60-second wait.
- [ ] Clear local-first/outside-workspace MCP SKILL without obsolete claims.
- [ ] Required tests exist and assert meaningful behavior; new cases were negatively validated.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed; supervisor and proto have zero diff.
- [ ] Index updated.

## STOP conditions

- Cited facts change.
- Existing creates/exits cannot provide workspace_id/exit_code without supervisor/proto changes.
- Log invariants cannot hold without supervisor changes.
- Out-of-scope changes required.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- **Separate builder companion**: replace plugin SKILL, add .mcp.json URL `${COFLUX_MCP_URL:-https://api.coflux.dev/mcp}`, server timeout ≥600000 ms, bump/publish. Codex users symlink SKILL to ~/.codex/skills and add MCP manually.
  - 2026-09-06 addendum: only Claude expands the fallback syntax; Codex marketplace installation parses it literally and fails invalid MCP server URL. From plugin 0.4.1 use fixed https://api.coflux.dev/mcp; self-host/dev manually claude mcp add or codex mcp add using COFLUX_MCP_URL.
- **Rollout**: worker next-tag hot upgrade, CLI/SKILL npm, server deploy. New CLI plus old worker returns bad request for unknown terminal.status, an accepted temporary combination resolved by cofluxd update.
- Exited-ledger retention is initially an estimate. If old terminal waits say missing, inspect retention first.
- Future local capabilities must first ask whether they can complete locally; only those that cannot may use AgentControlRequest.
- Withdrawn 093 is documented in its plan; bounded-log and wait-limit decisions are carried forward here.
