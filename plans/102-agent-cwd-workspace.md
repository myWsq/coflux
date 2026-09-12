# Plan 102: Route local agent commands by caller cwd after moving to another workspace on the same device

> This plan is an outcome contract, not a step-by-step script. Understand requirements/decisions and implement against live code. Validate only if also the verifier; delegated executors implement with checks outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat 8f73dc7..HEAD -- proto/coflux/v1/daemon.proto crates/worker/src packages/cli/cofluxd.mjs apps/server/src/hub.ts integrations/claude-plugin packages/cli/skills tests/src/agent-control.test.mjs tests/src/device-harness.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none (092 environment, 094 ledger, 096 coordinate block, all DONE)
- Execution: subagent opus (2026-09-11 departure check: execute immediately without plan review, observing STOP/BLOCK)
- Category: feature
- Planned at: `8f73dc7`, 2026-09-11

## Requirement

Claude Code 2.1.267 can move a live conversation through /cd or EnterWorktree(path) without restart/context loss. Coflux child workspaces are registered Git worktrees under ~/.coflux/worktrees/<workspace_id>, so a session started in A can move to B. Local command ownership still uses PID→PTY→ledger SessionCreate workspace_id (094), ignoring cwd. After moving:
- terminal new runs under A's task/root without error, silently testing A rather than B.
- list shows A; read/wait/send on B terminals created via MCP return not-in-workspace 404.
- Session block/environment still says A, so copied MCP IDs are stale.

Outcomes for terminal agents, with sidebar users otherwise unchanged:

1. Every /agent request carries cwd. Daemon resolves an **effective workspace** from known same-device workspace roots by canonicalized, component-wise longest prefix. No match falls back to the **owning workspace**, ledger/COFLUX_WORKSPACE_ID. Missing ownership in pre-upgrade sessions still receives 094's readable rejection: cwd can redirect known ownership, never invent missing ownership.
2. From B cwd, new creates/runs/counts against B; list shows B; read/wait/send accept B and reject A with 404, symmetrically. Progress/notify/ports remain tied to the current terminal/process tree and unchanged.
3. Center accepts an effective workspace only on the same account/device; repository workspaces also require a nondeleting project. Invalid targets fail readably without creation. Empty field preserves initiating-task workspace for old daemons.
4. New read-only cofluxd workspace prints effective ID/path and owning ID, exposing moves. Outside Coflux it returns the same 403 as local commands.
5. On every UserPromptSubmit, if payload cwd resolves differently from COFLUX_WORKSPACE_ID, plugin emits an English coflux-session-moved block with effective ID/path, ownership, local/MCP targeting, and unchanged task/session IDs. Same workspace, absent environment, unavailable/failing CLI, malformed JSON are silent/exit 0. Repeat every prompt while moved, statelessly recovering after compaction.
6. Source/synchronized SKILL distinguish ownership/effective workspace, /cd/EnterWorktree, cofluxd workspace, and querying immediately before MCP if the next prompt has not arrived. Original coordinate-block rule refers to cwd's workspace.
7. Plugin 0.8.0→0.9.0. Marketplace push/SHA handoff is a user step outside this plan.

## Decisions & tradeoffs

- **Effective target from declared cwd/local longest-prefix map; ownership only from ledger.** CLI includes process.cwd each request. WorkerState.workspaces maps IDs to path/default_branch, including directory workspaces with empty branch. Canonicalize both sides, falling back to literal paths on failure; component-match longest root. Change request target, never session ownership. Rejected: guessing old missing ownership violates 094; moving the terminal card would misrepresent its outer shell still in A; SKILL-only MCP workaround violates local-first and retains silent failure when forgotten. Evidence: agent_ctl.rs:360-391, session_ledger.rs:4-7, main.rs:107-108,1523-1528, device.rs:3404 workspace_root.
- **Optional top-level AgentControlRequest.workspace_id**, not repeated payload fields. It applies to terminal_new/list; ports ignores it, read is already local. dispatchAgentControl resolves initiating task/workspace once, then validates override exists, matches daemon.accountId and daemon.info.daemonId, and has active project if applicable. Reject before creating anything. Daemon proposes an ID; center validates, relaxing the old comment against self-reported workspace without trusting it blindly. MCP uses account validation; this additionally needs device because execution stays local. Update proto comment; optional addition passes buf breaking. Evidence: daemon.proto:92-126, hub.ts:1201-1211,1240-1246,1330-1345,3684-3695.
- **Empty field means original behavior, no negotiation.** New server/old daemon works unchanged. Old server/new daemon ignores override and temporarily retains silent misrouting; accepted because deployment is always server first. Rejected: response workspaceId comparison adds protocol solely for an excluded rollout order.
- **Local read/status/send compare target ledger ID with effective workspace**, not owning workspace or their union. B cwd rejects A; cd back restores access. Union would blur boundary and permit mistaken input into A. Evidence: agent_ctl.rs:389, hook.rs:250-266, CLI:964-967 shared request path covers wait polling too.
- **Independent UserPromptSubmit script, not CwdChanged or environment rewriting.** Claude's CwdChanged provides old/new cwd and CLAUDE_ENV_FILE but guarantees exit-code semantics, not context stdout. UserPromptSubmit explicitly injects stdout and includes cwd. Block contains effective ID/path, owner ID, local-target instruction, MCP workspaceId instruction, and unchanged COFLUX_TASK_ID/SESSION_ID. Rejected: rewriting workspace env affects only Bash and conflicts with hook/MCP/context plus 092 ownership meaning; cwd-aware SessionStart would violate 096's dependency-free env-only shell contract, while first prompt covers resumed moved sessions; messenger stdout is forbidden across events. Accepted delay: next prompt, so immediate MCP use must first run workspace. Evidence: hooks.json, CLI:856-867, session-context.sh, guard stdin cwd.
- **workspace.current is the sole new local command surface**, read-only and center-free. Output must stably expose effective ID/path and owner ID for plugin parsing; one-line JSON recommended. Document format. Rejected: plugin POST directly to gateway duplicates port discovery/PID contracts distributed separately in CLI.
- **No ordinary/Codex impact by construction**: only differing effective/owner IDs emit. Codex executes hooks but has no /cd and does not move cwd, so remains silent. Plugin stays English.
- **Planning decisions**: tag coflux-session-moved, command cofluxd workspace, repeat while moved rather than persistent marker files.

## Direction

CLI cwd→daemon resolves once→local actions validate effective target; central actions send override→center validates/creates/lists. Plugin runs workspace with prompt cwd and emits only on difference.

M1 contract precedes M2/M3, which may parallelize. M4 depends on M2 command/output; M5 on M2+M3.

### Milestone 1: Protocol

Add optional workspace_id and proposed/validated comment. Commit matching TS/Rust/Swift generated outputs.
Validation: `cd proto && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` empty after commit; protocol build exits 0.

### Milestone 2: Daemon and CLI

Carry cwd in AgentBody/Request. Resolver tests nested roots, repo versus repo2, symlinks, no-match None, directory workspaces. Use effective target for local operations; add workspace.current/CLI; populate central new/list override. Replace old no-cwd-guess comments with ownership never guessed, target may be declared.
Validation: worker tests and node --check CLI pass.

### Milestone 3: Center

Validate override once. New task.workspaceId, SessionCreate cwd, active cap, project activity all use target; list targets it too.
Validation: server tsc exits 0.

### Milestone 4: Plugin and SKILL

Add prompt script/hook, update/sync SKILL, bump 0.9.0. New session-moved tests use fake CLI on PATH: difference includes both IDs; same/no env/bad stdin/missing or failed CLI silent. Verify payload cwd, not script process.cwd, is used.
Validation: all plugin tests, sync --check, and English-only grep pass.

### Milestone 5: Black-box acceptance

Same-device A/B, B created through center and waitWorkspaceReady ensures daemon map. In A PTY cd B then new --cmd pwd: task belongs B/output B. B list only B; cross-workspace read/status/send 404; /tmp fallback A; workspace output correct; missing override preserves old-daemon behavior.
Validation: targeted agent-control tests pass.

## Landmines

- Update no-cwd-guess comments in ledger:7/agent_ctl:371 or future readers may revert the intended change.
- Match path components; canonicalize both sides for /var→/private/var and symlinked ~/.coflux. Center paths may be user-original forms.
- Unknown .claude/worktrees children under main root correctly match main by longest prefix; no special case.
- hub.ts:1262-1300 has four target-sensitive uses: task workspace, session cwd, cap, project check. Missing one recreates mismatched ownership/execution.
- Messenger remains silent; moved block is independent.
- Fake-CLI test fixtures must be async with PATH only the fake directory, following 098 repair; otherwise tests contact real daemon and overwrite user progress.
- Invoke CLI with payload cwd rather than trusting hook process.cwd.
- Black-box calls local CLI by typing gateway env/node command into PTY. B must be center-created and synchronized through device-harness:564 waitWorkspaceReady.
- Installed local Coflux causes three full-suite agent-activity presence false failures; unrelated, do not chase.

## Scope

In scope:
- daemon.proto and three generated directories
- Worker hook/agent_ctl/ledger/main, optional resolver module
- CLI
- Server hub, store helper if necessary
- Plugin hook/new script/SKILL/version and source SKILL
- Agent-control or new black-box file; session-moved plugin tests
- Index

Out of scope:
- Web/mobile/macOS sidebar: card stays with initiating workspace, no moved-agent badge
- Supervisor/environment ownership semantics
- MCP tools, already explicitly targeted
- CwdChanged/CLAUDE_ENV_FILE
- Marketplace and device rollout

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Generated consistency | `cd proto && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | Empty |
| Rust tests | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Warning-free build | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| CLI syntax | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| Plugin tests | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL sync | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| English-only plugin | `git grep -P '[\p{Han}]' -- integrations/claude-plugin` | Empty |
| Targeted acceptance | `cd tests && node --import tsx --test src/agent-control.test.mjs src/agent-terminal-io.test.mjs` | exit 0; local PG 5432 |
| Full acceptance | `pnpm -C tests test` | Pass except three known presence cases |

## Done criteria

- [ ] All commands pass.
- [ ] After `cd` from workspace A's PTY into B, `cofluxd terminal new --cmd pwd` creates a task under B in the sidebar and outputs B's path.
- [ ] B cwd lists only B; cross-workspace local operations 404 with existing not-in-workspace/missing message.
- [ ] Outside-root cwd falls back to owner; missing owner still rejected readably.
- [ ] Center rejects foreign account/device overrides without creation.
- [ ] workspace output correct for A/B/outside; non-Coflux 403.
- [ ] Five plugin cases satisfy contract, valid hooks JSON, version 0.9.0.
- [ ] SKILL source/copy match and explain owning/effective workspaces, `/cd`/EnterWorktree, `cofluxd workspace`, and the moved-context block.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change or out-of-scope changes needed.
- Validation fails twice after one reasonable fix.
- buf breaking rejects the field addition.
- Workspace map lacks main/directory paths on some path, leaving resolver without input.

## Maintenance notes

- Deploy server first, then devices cofluxd update && cofluxd restart. Reverse order temporarily preserves silent misrouting.
- Plugin 0.9.0 source bump here; after push hand SHA to builder. Users marketplace-update then update coflux@plugins; Codex retrusts new hook.
- COFLUX_WORKSPACE_ID permanently means where terminal opened, not current cwd. Use moved block/workspace command for current target.
- If CwdChanged later documents context injection, emit immediately there while retaining prompt hook for compaction recovery.
- Future sidebar moved-agent badge can use hook cwd, but is outside this plan.
