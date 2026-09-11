# Plan 104: Follow agents into worktrees—move terminal ownership on EnterWorktree, ExitWorktree, resume, and WorktreeRemove; register unknown worktrees, preserve PTYs, and never remount web panels

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 26c5d3d..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/client.proto crates/worker/src apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts packages/cli/cofluxd.mjs packages/client/src/store.ts apps/web/src/components/workbench integrations/claude-plugin packages/cli/skills tests/src`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: `plans/102-agent-cwd-workspace.md` (branch `dev/20260911-agent-cwd-workspace`; this branch starts at its tip `26c5d3d`. Merge order into main must be 102 → 103. If another session revises 102, rebase this branch onto its new tip.)
- Category: feature
- Execution: subagent opus (preflight 2026-09-11: execute after writing without plan review; still stop on STOP/BLOCK; pushing, PRs, merging, and releasing are not authorized)
- Planned at: `26c5d3d`, 2026-09-11

## Requirement

### Problem

Claude Code's `EnterWorktree` moves a **live session** into a git worktree. By default it creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`; passing `path` enters an existing worktree. `ExitWorktree` returns. When `--resume`/`--continue` restores a session that entered a worktree, Claude Code starts directly there, **without a tool call**. On session exit, Claude Code removes clean worktrees itself and asks the user if changes remain.

After an agent in a coflux project terminal does this, coflux's view is wrong: the terminal remains under original workspace A, and turn state, diff statistics, and branch indicators all refer to A. Claude-created worktrees do not appear in the sidebar. Today's plugin guard also blocks `git worktree add` and directs the agent to MCP `create_workspace` through the center with OAuth. EnterWorktree into `~/.coflux/worktrees/<uuid>`, outside `.claude/worktrees/`, then asks for another user confirmation. Consequently, the dev plugin's write-plan uses its host-managed branch in coflux, either relying on absolute paths or handing work to a new terminal—**interrupting the task**.

Plan 102 already fixes silent local-command misdirection: /agent requests include cwd, the daemon redirects their **target** to the registered workspace containing cwd, `cofluxd workspace` reports location, and UserPromptSubmit emits a `<coflux-session-moved>` block. But 102 explicitly leaves **ownership** (`tasks.workspace_id`) unchanged, does not register unknown worktrees, and does not change web. This plan completes the other half.

### Product decisions (primary consumer: Claude Code in coflux project-workspace terminals; secondary: users viewing terminals in web/mobile sidebars)

**Form**: coflux follows the agent. An entered worktree becomes a child workspace in the same project, reusing an existing path record if present, and the terminal moves beneath it. Terminal, PTY, session, and turn state remain continuous. No interception, confirmation, or new terminal.

**Flow**:

- Successful EnterWorktree (PostToolUse) moves terminal ownership to the target workspace, registering it first with create_workspace naming rules if needed.
- ExitWorktree (PostToolUse) moves the terminal back to the original workspace; the child workspace remains.
- SessionStart (startup/resume/clear/compact) with cwd in another worktree of the same project also moves ownership. Cwd already in the owning workspace is an idempotent no-op, so ordinary startup has no side effects.
- Claude Code worktree cleanup (WorktreeRemove) returns **all** terminals in that workspace to the project's `is_main` workspace, then removes its sidebar record.
- Silently do nothing and allow the session to proceed if the daemon is absent/unreachable/too old, the target is not a worktree of this project (another repository or nongit directory), or the terminal originated in a directory workspace without a project.
- Bash guard stops blocking `git worktree add`; continue blocking `remove|move`.
- After moving, the agent receives updated coordinates: workspace id changes, task/session/project ids do not. The `<coflux-session>` block reinjected after compaction also reports current ownership.
- Plain `cd`, without EnterWorktree, **does not move ownership**. It retains 102's target-redirection semantics. Together: plain cd makes local commands follow cwd while ownership stays; explicit enter/exit, resume, or worktree removal changes ownership.

**Web sidebar/workbench UI**: the terminal card disappears from the old workspace and appears under the new one, creating a workspace card with branch/diff statistics when needed. If the viewed terminal moves, selection follows and it stays the active tab. **Never rebuild the panel**: retain the same xterm instance, selection, and scroll position, with no flicker.

**Out of scope**: Codex (no EnterWorktree); temporary subagent `isolation: worktree` worktrees; ownership movement on plain cd; polling `git worktree list` to claim manually created worktrees (095's option three remains separate); orphan records from manual `git worktree remove`; cross-project/device moves; manual move UI; native macOS (`apps/macos` is being replaced by Electron `apps/desktop`); marketplace releases and daemon upgrades on devices.

### What must be true afterward

1. EnterWorktree, whether creating or entering an existing path, creates/reuses a corresponding child workspace in the sidebar within seconds. The terminal appears beneath it with continuous turn state. `cofluxd terminal list` / `cofluxd workspace` inside the session report the new ownership, including changed owningWorkspaceId.
2. ExitWorktree returns the terminal to the original workspace while retaining the child workspace.
3. When Claude exits and removes the worktree, the workspace disappears and its terminals return to the project main workspace.
4. A resumed session starts with correct worktree ownership; ordinary startup with cwd equal to owner changes nothing.
5. An unreachable daemon, target outside the project's worktrees, or directory-workspace terminal changes nothing and does not disrupt sessions/tools.
6. The guard allows git worktree add in project sessions but still rejects remove/move with unchanged reasons.
7. If the moved terminal is the selected workspace's active tab, web selection follows it and preserves active-tab status and xterm. Its departure does not make the old workspace attach another tab.
8. The agent sees new coordinates alongside the current tool result. Every subsequent SessionStart, including compaction, reports current ownership. The 102 moved block appears only when cwd workspace differs from current ownership, no longer comparing against stale COFLUX_WORKSPACE_ID.

**Incorrect neighboring solutions**: denying or rewriting EnterWorktree in PostToolUse; handing the task to a new terminal; merely changing 102's effective-workspace copy and asking the agent to remember; remounting web and concealing it with a 2,000-line snapshot replay; daemon polling of git worktree list; or treating .claude/worktrees children as the main workspace through 102's longest-prefix rule. For this plan's location resolution, worktree-root **equality** takes precedence over prefix matching.

## Decisions & tradeoffs

- **Triggers/channel: one independent plugin script registered for PostToolUse (matcher EnterWorktree|ExitWorktree), SessionStart, and WorktreeRemove. Do not reuse the messenger, use CwdChanged, or rely only on UserPromptSubmit.**
  Enter/Exit/SessionStart pass hook payload cwd to a new credential-free local cofluxd subcommand, named by the executor. Official hook documentation says cwd is the entered worktree root, original directory after exit, or session directory on SessionStart. WorktreeRemove passes worktree_path. The command uses the existing loopback /agent gateway, identifying the caller by pid/ppid ancestry rather than environment. PostToolUse may return coordinates through hookSpecificOutput.additionalContext; SessionStart stdout is plain context text.
  Rejected: adding this to `cofluxd hook claude`, whose cross-event discipline forbids stdout; CwdChanged, which also fires on plain cd and documents watchPaths/systemMessage rather than additionalContext; or relying solely on 102's next-prompt UserPromptSubmit block, which does not move ownership.
  Based on `integrations/claude-plugin/hooks/hooks.json` (unmatched messenger, session-moved.mjs only on UserPromptSubmit); `packages/cli/cofluxd.mjs:856-867`; `integrations/claude-plugin/scripts/guard-git-worktree.mjs:6-10` (JSON-only or zero-byte stdout); Claude Code hook docs (additionalContext, SessionStart stdout, WorktreeRemove worktree_path).

- **Wire semantics locate a path, without distinct enter/exit operations**: add an AgentControlRequest payload variant containing an absolute path, branch, and daemon-resolved existing workspace id or empty value. The response returns final workspace id and whether created. Another variant reports a removed worktree by path. Enter/Exit/SessionStart use the same message: the daemon resolves identity; the center verifies and persists. Current owner means no-op; existing workspace means move; unknown worktree declared same-repository by the daemon means register then move; otherwise return readable not-applicable with no creation. Old workers never send these variants. Old servers reject unknown payloads through the existing dispatchAgentControl path; CLI errors are swallowed by hooks, which exit with zero bytes.
  Rejected: separate enter/exit messages, since exit is simply locating the original directory; reusing 102's top-level workspace_id, which targets one request rather than changing ownership; or center-side path comparison, since stored paths retain user spelling and the center has no git. The center verifies account/device/project, preserving 102's daemon-proposes/center-verifies trust model.
  Based on `proto/coflux/v1/daemon.proto:92-140`; `apps/server/src/hub.ts:1205-1239` (session→task→workspace and 102 verification); `apps/server/src/daemon-capabilities.ts:10-12` (daemon-initiated requests need no new capability).

- **The daemon determines unknown-worktree identity and project boundaries**: canonicalize the root from `git rev-parse --show-toplevel`, then use equality to find an existing workspace. If absent, compare `git rev-parse --git-common-dir` with the owning project's main workspace repository. Register only if equal, using the worktree's current branch and canonical root path. Cross-project, nongit, and directory-workspace origins (empty project_id) are not applicable.
  Rejected: 102's workspace_match::workspace_for_cwd longest-prefix matching, which would classify `<main>/.claude/worktrees/<name>` as main forever. Preserve prefix semantics for local-command targeting; once registered, the child's longer path naturally wins.
  Based on `crates/worker/src/workspace_match.rs:9-16`; `crates/worker/src/git.rs:169-207` (validate_repo handles import, not worktree families); `crates/worker/src/main.rs:107-108` (workspace_id → path/default_branch map).

- **Ownership write path**: update tasks.workspace_id and tasks.project_id in one UPDATE through a dedicated move method following existing CAS style. Afterward, the daemon updates SessionLedger.workspace_id from the response. The center remains the sole ownership authority; the ledger learns only from responses, never guesses from cwd.
  Rejected: expanding Store.updateTask's intentionally limited status/sessionId/exitCode/title patch type; separate UPDATEs, rejected by fk_tasks_workspace_project and task_workspace_mismatch preflight.
  Based on `apps/server/src/store.ts:803`; `apps/server/src/infra/database/schema-migrations.ts:690-696` (two-column FK), `:572-582` (preflight); `crates/worker/src/session_ledger.rs:4-14`; `crates/worker/src/agent_ctl.rs` (102 resolve_scope takes owning from ledger and effective from cwd; a stale ledger falsely reports movement).

- **Broadcast ordering**: registration sends WorkspaceCreated before TaskUpdated. Removal sends TaskUpdated to move terminals to is_main before WorkspaceRemoved. Deleting records must not execute git worktree remove. TaskUpdated already includes the entire Task, including workspace_id, and clients upsert by task id, so no new downstream message is needed.
  Rejected: reusing the prepared WorkspaceRemove flow, which asks the daemon to delete an already-removed directory.
  Based on `proto/coflux/v1/client.proto:268`; `packages/client/src/store.ts:536-551` (upsert), `:528-533`, and `packages/swift-client/.../CofluxClient.swift:558-561` (WorkspaceRemoved deletes associated tasks); `apps/server/src/prepared-operation-convergence.service.ts:133-160` (reusable workspace insertion from daemon path/branch).

- **Coordinates**: PostToolUse returns additionalContext. session-context.sh first asks the daemon to locate, then prints ownership from the response; fall back to environment if unavailable. In 102's session-moved.mjs, compare owningWorkspaceId and workspaceId from cofluxd workspace rather than treating $COFLUX_WORKSPACE_ID as current ownership. That environment variable now means initial terminal workspace and becomes stale after moving. Query the daemon whenever ownership is needed. This intentionally supersedes 096's no-daemon-call context block and 102's environment-based ownership; resume already needs the local call.
  Rejected: writing a new id to CLAUDE_ENV_FILE, visible only to Bash rather than hooks/model context; accepting staleness, causing moved-block false alarms on every prompt.
  Based on `integrations/claude-plugin/scripts/session-context.sh:16-29`; `integrations/claude-plugin/scripts/session-moved.mjs` main(); `packages/cli/cofluxd.mjs` cmdWorkspace; `crates/supervisor/src/sessions.rs:824-829` (spawn-time environment cannot be changed in a live PTY).

- **Guard only remove|move; synchronize SKILL, README, session block, and moved-block copy; strictly increase plugin version from 102's 0.9.0 to 0.10.0.** Replace “Never run git worktree add yourself” with guidance that coflux follows worktree entry, while removal still uses remove_workspace or Claude Code's own exit cleanup. No Han characters in the plugin. The sole SKILL source is `packages/cli/skills/coflux/SKILL.md`; synchronize with `scripts/sync-claude-plugin.mjs`, checked in CI.
  Rejected: removing the guard entirely, because direct removal leaves orphan workspace records that the watcher does not remove.
  Based on `integrations/claude-plugin/scripts/guard-git-worktree.mjs:20`; plugin README maintenance version rule; `plans/102-agent-cwd-workspace.md`.

- **Web: lift xterm panels to Workbench as task-id-keyed siblings; workspace containers retain only headers/tabs/branch controls/ChangesView and visibility decisions. Lift the attach state machine with panels into a shared task-id-keyed module. Do not use createPortal.**
  A panel is visible when its task is its workspace's active tab and that workspace is selected. Keep activeTaskId, view, pendingBranch, pendingTab/pendingCreateRef, and checkpointTitles per workspace. Move controllersRef, sessionReadyRef, attachedKeysRef, attachTimersRef, attachSequenceRef, launchingTaskIdsRef, activationRequestsRef, forcedClaimsRef, 097's replay ledger, controlStates, and rAF fit/attach effects with panels.
  Reestablish WorkspaceTerminalHandle and use-global-shortcuts' visible-workspace-only contract. The executor chooses ownership of createTerminal/closeActiveTab/selectTabByIndex/selectRelativeTab without behavioral changes.
  Add a tested pure function in workbench-state.ts: when the selected workspace's active task moves, follow selection and keep it active. A departing task **must not** trigger attaching another tab in its old workspace. The executor chooses apps/web or packages/client for the shared module.
  Rejected: keeping panels per workspace and remounting/replaying snapshots, contrary to explicit zero-remount requirements; createPortal to another host, which reinserts DOM and breaks xterm open(host)/WebGL context.
  Based on `apps/web/src/components/workbench/workbench.tsx:339` (only visited/selected containers mount), `:433-447` (siblings hidden rather than unmounted); `workspace-terminal.tsx:96-101` (workspace-filtered tabs), `:145-162` (container attach machine), `:456-521` (missing-task cleanup/fallback), `:243-262` (activation→attach ownership claim), `:795-800` (stable task identity); `workbench-state.ts:39`, `:105-112`; `terminal-pane.tsx:424-439` (register consumer before attach).

- **Codex remains unaffected by construction**: it executes the same hooks.json but has no EnterWorktree, so the PostToolUse matcher never fires. SessionStart reaches cwd-equals-owner and emits zero bytes. New hook entries require one additional Codex trust confirmation; accepted.

- **Ownership versus target remains the fixed boundary with 102** (decided while planning): only the four explicit events change ownership. Keep 102's cwd targeting, cofluxd workspace, and moved block, changing ownership's source from environment to ledger. After moving, effective equals owning and 102 naturally becomes a no-op.

- **Executor choices** (decided while planning): workspace naming, cofluxd subcommand names, and wire field names. Black-box tests create unknown same-repository worktrees with git inside temporary repositories; test processes are not subject to plugin guards.

## Direction

Flow: hook cwd → cofluxd location command via loopback/pid identity → worker resolves worktree root/existing workspace/same repository → AgentControlRequest location variant → center verifies → optionally registers → moves task → broadcasts WorkspaceCreated then TaskUpdated → response → worker ledger update → CLI output → hook coordinates.
WorktreeRemove: hook worktree_path → command → worker → center moves tasks to main, deletes record, broadcasts.
Web: a TaskUpdated workspaceId change updates panel ownership and selection without touching xterm.

Dependencies: M1 defines the contract; M2/M3 depend on M1 and may run independently in parallel. M4 depends on M2's command/output. **M5 is independent of everything and can run from the start.** M6 depends on M2/M3/M4.

### Milestone 1: Protocol contract and generated output

Add location and removed-worktree payload variants and a response carrying workspace id/created status. Comments establish daemon identity resolution, center verification/persistence, and center ownership authority. Commit all three generated outputs with the proto.
Validation: `cd proto && buf lint && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` → empty after committing; `cargo build -p coflux-protocol` → exit 0.

### Milestone 2: Daemon and CLI

Implement canonical toplevel equality, git-common-dir validation, and branch reading, with tests for existing workspaces, .claude/worktrees registration, rejection of other repositories/nongit/directory origins, and symlink canonicalization. Route location/removal through the center and update the ledger from responses. 102 resolve_scope yields effective == owning afterward. New cofluxd subcommand output is stable, preferably one-line JSON. Old-daemon unknown actions yield readable CLI errors and nonzero exit.
Validation: `cargo test -p coflux-worker`; `RUSTFLAGS=-D warnings cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay`; `node --check packages/cli/cofluxd.mjs` → exit 0.

### Milestone 3: Center

dispatchAgentControl handles both variants, verifying account/device/project. Resolve/register using the daemon's existing id or path/branch, move task with one two-column UPDATE, and broadcast in the decided order. Removal returns all tasks to is_main before deleting the workspace record. Not-applicable results are readable and side-effect-free.
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 4: Plugin and SKILL

Add the script and three hooks.json entries. session-context locates before printing with environment fallback; session-moved compares ledger ownership; guard only remove/move and change existing add tests to allow. Update/sync sole SKILL source, README, and plugin 0.10.0.
Plugin tests use fake cofluxd on PATH with 098/102 async fixtures and PATH isolation: Enter/Exit return coordinates; same workspace produces zero bytes; missing/failing command or old daemon produces zero bytes and exit 0; non-JSON stdin produces zero bytes; WorktreeRemove calls removal; cofluxd uses **payload cwd**.
Validation: `node --import tsx --test tests/src/claude-plugin-*.test.mjs`; `node scripts/sync-claude-plugin.mjs --check`; `node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` → exit 0. `git grep -P '[\p{Han}]' -- integrations/claude-plugin` → no output.

### Milestone 5: Web workbench

Lift panels and attach state, follow selection, do not attach siblings on departure, and preserve global shortcuts. workbench-state.test.ts covers active-tab movement following selection, inactive-tab movement leaving selection unchanged, and deleted tasks preserving existing fallback.
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json`; `pnpm test:web` → exit 0.

### Milestone 6: Black-box acceptance

Use a new file with an exclusive port and a PTY in temporary main workspace A:
1. Create unregistered worktree W with git, locate W, receive WorkspaceCreated with canonical root then TaskUpdated with the same task/new workspaceId. cofluxd workspace reports the new owningWorkspaceId.
2. Locate A: TaskUpdated returns to A; W remains.
3. Locate registered child B: no new workspace.
4. Locate another repository or nongit directory: readable error, no broadcasts.
5. Report W removed: TaskUpdated to A precedes WorkspaceRemoved.
6. Old-format requests without new fields behave unchanged.

Validation: `cd tests && node --import tsx --test src/<new-file>.test.mjs src/agent-control.test.mjs` → exit 0, local PG 5432 required.

## Landmines

- Commit all three generated trees with proto changes: packages/protocol/src/gen, crates/protocol/src/gen, packages/swift-client/Sources/CofluxProtocol/Generated. CI requires zero diff. Adding oneof variants can pass buf breaking.
- terminalNew at `apps/server/src/hub.ts:1262-1300` uses one target workspace for task.workspaceId, SessionCreate cwd, active-terminal limits, and project checks (102's target). Ledger-based ownership makes these correct after moving; do not add another layer.
- 102's WorkspaceScope owning comes from the ledger. Without response-driven updates, moved() stays true and session-moved falsely reports every prompt.
- The watcher at `crates/worker/src/main.rs:678-751` reports 0/0 for missing directories, never deletes records. Removal depends on WorktreeRemove; manual-removal orphans remain future work. New workspaces join the watcher automatically through WorkspaceList.
- Claude Code locks its worktree while the agent runs. MCP remove_workspace then fails through git; report the error unchanged, never --force.
- Shell cwd and COFLUX_* environment are fixed at spawn (`crates/supervisor/src/sessions.rs:824-829`, `apps/server/src/hub.ts:3166`). The shell remains in the old directory after ownership moves. This is invisible while using Claude TUI but apparent after Claude exits; accepted and documented in SKILL/README.
- Local commands use ancestry plus ledger (`packages/cli/cofluxd.mjs:960-975` sends only pid/ppid/cwd); updating the ledger is essential.
- Workspace paths lack a general uniqueness constraint (uq_workspaces_directory_device only covers directory workspaces). Deduplicate by daemon-reported existing id or canonical path before registering, or repeated location creates duplicate records.
- The current guard blocks Bash heredocs containing git worktree add, including documentation/tests/commit bodies. Write files with the Write tool. After this change add is allowed, while remove/move remains blocked.
- Preserve the React-versus-Solid closure behavior documented at `apps/web/src/components/workbench/workspace-terminal.tsx:141-144, 167-171, 187-189` while lifting state. Register the consumer before attach (`terminal-pane.tsx:424-439`). Its workspaceId liveRef mirror (`:161-181`) must update after moves because drag/paste sendFsWrite uses it as the root.
- Workbench only mounts visited/selected containers at line 339. Decouple panel mounting/lifetime from container mounting after lifting.
- Plugin fixtures must be async and set PATH to only the fake cofluxd directory (098 repair lesson), or tests hit the real daemon and write copy to user workspace cards.
- Hooks run in the session directory; set subprocess cwd from the **payload**, never trust process.cwd().
- Create the second registered test workspace through the center (`tests/src/device-harness.mjs:564`, waitWorkspaceReady). Create unknown worktrees with git in temporary repositories. Three agent-activity presence false failures in the local full suite come from real-session ancestry contamination and are unrelated.
- This branch starts at 102's tip. Rebase onto any revised 102 tip before continuing; merge order remains 102 → 103.

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`, client.proto if needed, and all three generated output directories
- `crates/worker/src/`: agent_ctl.rs, hook.rs, session_ledger.rs, git.rs, main.rs, new modules if needed
- `packages/cli/cofluxd.mjs`
- `apps/server/src/hub.ts`, store.ts, reusable prepared-operation-convergence.service.ts portions if needed
- `packages/client/src/` if shared attach/selection helpers live there
- `apps/web/src/components/workbench/`: workbench.tsx, workbench-state.ts/tests, workspace-terminal.tsx, terminal-pane.tsx, use-global-shortcuts.ts, new modules
- `integrations/claude-plugin/`: hooks/hooks.json, scripts, skills/coflux/SKILL.md, README, .claude-plugin/plugin.json; and `packages/cli/skills/coflux/SKILL.md`
- `tests/src/`: new black-box file, claude-plugin-*.test.mjs, agent-control.test.mjs if needed
- `plans/README.md`

Out of scope:
- apps/mobile, apps/ios, apps/macos: workspaceID filtering naturally follows; native macOS is being replaced
- crates/supervisor: environment injection unchanged; COFLUX_WORKSPACE_ID is initial workspace
- apps/server/src/mcp: explicit-id tools unchanged
- Schema migrations: existing columns/FK suffice
- Polling claims, orphan cleanup, cross-project/device moves, manual move UI
- Marketplace releases, device daemon upgrades, production deployment: user steps

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto generation zero diff | `cd proto && buf lint && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | No output |
| Rust unit tests | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0 |
| Rust build without warnings | `RUSTFLAGS=-D warnings cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Web unit tests | `pnpm test:web` | exit 0 |
| Client state-machine tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| CLI syntax | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| Plugin tests | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL sync | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| No Han in plugin | `git grep -P '[\p{Han}]' -- integrations/claude-plugin` | No output |
| Black-box location/agent control (acceptance) | `cd tests && node --import tsx --test src/<new-file>.test.mjs src/agent-control.test.mjs` | exit 0; local PG 5432 |
| Full black-box suite (acceptance) | `pnpm -C tests test` | All pass except three known agent-activity presence cases |

## Done criteria

- [ ] All listed commands pass.
- [ ] All six black-box cases satisfy the required outcomes and broadcast ordering.
- [ ] Plugin Enter/Exit returns coordinates; SessionStart reports ledger ownership with environment fallback; WorktreeRemove reports removal; add is allowed and remove/move denied; hooks.json valid; version 0.10.0; no Han; SKILL source/copy identical.
- [ ] Web selection follows a moved active tab with the same xterm instance; departure never attaches sibling tabs; global shortcuts unchanged.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- buf breaking reports a breaking change.
- 102's tip is no longer 26c5d3d and rebase conflicts cannot be resolved mechanically; stop and let the user choose merge strategy.
- Lifted panels cannot preserve visible-workspace-only shortcuts without rebuilding xterm; report rather than falling back to remounting.

## Maintenance notes

- **Deployment order**: server at api.coflux.dev first, then each machine's `cofluxd update && cofluxd restart`. Old daemons never send new variants. New daemon/old server rejects location and hooks stay silent. Both preserve today's behavior.
- **Plugin release**: 0.10.0. After pushing, hand the SHA to the plugins-builder session for marketplace publication. Users run /plugin marketplace update and update coflux@plugins. Codex must trust the three new hooks. If 102's 0.9.0 was never released separately, release 0.10.0 directly.
- COFLUX_WORKSPACE_ID permanently means initial terminal workspace. Ownership comes from the ledger/cofluxd workspace owningWorkspaceId; current location is workspaceId. New code must not treat environment as current ownership.
- 095's option three—poll git worktree list to claim worktrees and synchronize removals—and manual-removal orphan cleanup remain future plans. This plan's removal persistence path can be reused.
- Once shipped, dev write-plan's host-managed branch no longer needs MCP create_workspace: allowed git worktree add plus EnterWorktree claiming suffices. Updating that documentation belongs to the dev plugin.
