# Plan 098: Make agent background work visible with Bash denial, background wait notifications, and leak reporting

> This plan is an **outcome contract, not an execution script**. Understand requirements/decisions and implement against live code. Verifiers run milestone checks; delegated executors only implement. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat 8de554e..HEAD -- integrations/claude-plugin packages/cli/skills packages/cli/cofluxd.mjs tests/src/claude-plugin-guard.test.mjs scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none (extends 095 hooks, 094 local commands, 096 English-only delivery)
- Category: dx
- Execution: subagent opus
- Planned at: `8de554e`, 2026-09-08

## Requirement

Coflux makes agent work visible and available for takeover on web/mobile. A gap remains: **processes backgrounded in the agent's own Bash are invisible**, without sidebar entries or takeover, and failures are known only through the agent. SKILL recommends terminal new instead, but models often ignore it.

Exploration/advisor research established three facts:
1. **Two invisible-background paths, only one interceptable.** Explicit run_in_background:true passes PreToolUse. Foreground Claude commands can automatically background after timeout, except sleep-prefixed, Git-containing, or unparseable compounds; the hook already ran with false and does not run again. Blocking explicit backgrounding cannot guarantee visibility. The second path can only notify the user.
2. **The one missing capability costs no code.** Coflux lacks an exit-push wakeup, offering blocking wait/polling. Background Bash running `cofluxd terminal wait <id>` supplies native harness completion notification while actual work stays visible. This is documentation only.
3. **Transparent updatedInput rewriting is wrong**, for decision one's reasons.

Outcomes:
- Explicit background requests are denied with an executable terminal new command, title from description, and an instruction not to switch to foreground instead. Supply a practical next step, not bare prohibition.
- SKILL includes create terminal→background wait→wake/read, preserving visibility and exit notification together.
- If invisible background work still occurs through automatic backgrounding or evasion, workspace progress reports it to the user.

## Decisions & tradeoffs

- **PreToolUse denial plus guidance, never updatedInput rewriting.** Five independently sufficient objections: (1) permission mismatch: rules apply to rewritten prefixes, breaking original git-push denies/pnpm-test allows. Without allow, every wrapper may prompt; with allow, denies are bypassed. No wrapper string fixes structural prefix matching. (2) terminal.new adds center dependency although normal background Bash runs offline, violating local-first (CLI:945-948). (3) environment differs: supervisor/launchd environment plus login noninteractive zsh -lc skips .zshrc; nvm/pnpm PATH setup may disappear. (4) stdin becomes a PTY, so credentials/sudo/y-N prompts hang awaiting people rather than fail promptly. (5) signal-killed terminals all report 1, obscuring user stop versus command failure. Evidence: CLI center-path comments and SKILL:88-91 piped stdout semantics.
- **Match boolean tool_input.run_in_background===true**, never regex the command for the decision. Worktree guard's whole-text matching already false-blocks heredocs/quoted strings; do not copy that defect. Evidence: index backlog.
- **Gate on COFLUX_WORKSPACE_ID**, not PROJECT_ID, because directory workspaces also need visibility and have no project ID; inherited project-ID issues are already backlog. Evidence: SKILL:44 and session-context.sh.
- **Exempt commands containing cofluxd terminal and commands starting with sleep.** The first prevents recursively blocking our recommended creation/wait recipe; sleep already avoids auto-backgrounding and pure waiting has no visibility benefit. Blanket denial would block our own recipe.
- **Background wait is documentation only.** Rejected: new terminal run streaming command would require logPath exposure, CLI surface, local stop (absent AgentAction), signal forwarding, and fallbacks for every daemon rejection. Existing background wait supplies the outcome with zero code. Evidence: CLI:1029-1046 polls status every three seconds; agent_ctl.rs:68-92 has no Stop.
- **PostToolUse reports only, using progress rather than notify.** Notify falsely puts workspace into waiting-for-interaction when no user action is needed; progress is broadcast semantics.
- **Separate new scripts, not merged into worktree guard**: different events, booleans versus regex, workspace versus project gating, and failure modes would become harder to maintain together.
- **Planning decision: plugin 0.5.0→0.6.0**, following minor behavioral increments in 095/096.

## Direction

These milestones are not independent; execute one sequential work package. M1/M3 edit hooks.json, M4 depends on preceding outputs. Do not parallelize.

All plugin text must be English under 096. At original implementation time, plan/test prose remained Chinese.

### Milestone 1: Deny explicit background Bash with usable alternative

For Coflux background Bash, emit English PreToolUse denial explaining visibility, giving terminal new --title=… --cmd=… from description/original command, and rejecting foreground fallback. Exempt terminal commands and sleep prefixes.

Missing workspace, non-Bash, invalid JSON, or nontrue background flag produces **zero stdout/exit 0**, never false denial. Debug only to stderr. Append Bash-matched PreToolUse entry alongside existing guard.

Validation: new background tests pass; assert pure JSON denial with terminal new, both exemptions, and all four silent cases.

### Milestone 2: Full create/background-wait recipe

Edit authoritative packages/cli/skills/coflux/SKILL.md, explaining denial recovery, background cofluxd terminal wait after creation, native wakeup, then read. Document wait exit code always 0 and actual result in `# exited exit=N`. Use --cmd=<value> consistently.
Validation: sync --check exits 0 and plugin has no Han characters.

### Milestone 3: Report invisible background tasks

First verify a long nonsleep command with short timeout: does PostToolUse fire at automatic backgrounding, and expose backgroundTaskId/timedOutAfterMs?
- If yes, detect fields and call progress with description, reporting invisible work.
- If not, STOP/report and downgrade to a documented known gap; do not force another mechanism.

Always zero stdout: PostToolUse output becomes context, including in Codex. Tests assert recognized fields call progress; unrecognized/outside-Coflux cases do nothing.

### Milestone 4: Releasable plugin

Set version 0.6.0, describe new hooks, synchronize SKILL. All plugin tests and hook JSON parsing pass.

## Landmines

- Only edit source SKILL, then sync; direct delivery edits fail check (sync script:9-14).
- Codex truly executes these hooks using Claude event names. updatedInput is Claude-only and unused; unexpected environments must be silent to avoid context pollution.
- Existing PreToolUse has messenger+guard, PostToolUse messenger. Append, never replace, or activity state breaks.
- Do not normalize worktree guard's PROJECT_ID check; ownership/heredoc issues are separate backlog.
- Node parseArgs rejects --cmd values starting with dash unless using --cmd=<value>. Denial examples must use equals form.
- Daemon command limit is 16 KB (hook.rs:40,285). Do not embed the full original command in an alternative if too long to run.
- Workspace limit is eight RUNNING terminals; exited entries remain visible. Do not encourage terminals for every trivial command; preserve one-second-terminal noise guidance.

## Scope

In scope:
- Two new plugin scripts, hooks.json, plugin.json
- Source SKILL and synchronized delivery SKILL
- New background test file
- This plan/index

Out of scope:
- New cofluxd terminal run/stop commands needed only by rejected transparent rewriting
- Rust/proto/daemon/server/web changes
- Worktree guard ownership/heredoc fixes
- Global CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, which also disables background subagents/Ctrl+B
- Actual publication; user hands SHA to plugins-builder

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| New tests | `node --import tsx --test tests/src/claude-plugin-background.test.mjs` | exit 0 |
| Plugin tests | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL check | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Hook JSON | `node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` | exit 0 |
| English-only plugin | `! grep -rlP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` | No output |
| Full black-box acceptance | `pnpm -C tests test` | 276+ pass |

## Done criteria

- [ ] All commands pass.
- [ ] In coflux sessions, `Bash(run_in_background: true)` is denied with an executable `cofluxd terminal new --title=… --cmd=…` alternative.
- [ ] Terminal-containing/sleep-prefixed commands allowed.
- [ ] Outside-Coflux/non-Bash/bad-JSON/nonbackground cases silent, exit 0 in both scripts.
- [ ] SKILL documents the complete create-terminal → background wait → read-after-wake recipe and states that wait always exits with status 0.
- [ ] M3 prerequisite conclusion recorded, implemented or explicitly downgraded after STOP.
- [ ] Plugin 0.6.0, synchronized English-only SKILL.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` is updated.

## STOP conditions

- Automatic-background PostToolUse does not fire or lacks fields: report/downgrade M3, no polling substitute.
- Cited facts change, especially CLI center dependencies/source SKILL relationship.
- Rust/proto/daemon changes required.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- **M3 prerequisite conclusion: implemented, not downgraded.** Official hooks docs only describe generic tool_response, not auto-background fields. Evidence instead comes from local Claude Code **2.1.263** binary: (1) output schema declares optional backgroundTaskId with its background-task-ID description, alongside timedOutAfterMs/backgroundedByUser/backgroundedByTurnAbort/backgroundedToDeliverMessage; (2) timeout path returns `{stdout:"", stderr:"", code:0, interrupted:false, backgroundTaskId, timedOutAfterMs}`, explicit background returns only backgroundTaskId, and native tengu_bash_task_ack uses timedOutAfterMs!==undefined for trigger=timeout; (3) tool returns immediately on backgrounding, not process exit, so PostToolUse fires then; (4) payload has hook_event_name/tool_name/tool_input/tool_response/tool_use_id/duration_ms, with raw result object rather than rendered text in tool_response. Evidence was strings plus targeted binary searches, **not an actual automatic-background run**. These fields are undocumented and may change; unrecognized results do nothing safely. If reporting vanishes after upgrades, inspect field names again.
- **Release**: bump to 0.6.0 here, push, give SHA to builder. Users update /plugin; Codex must trust new entries.
- **Known gaps**: manual cmd &/nohup in foreground escapes boolean/response detection; timeout auto-backgrounding can only be reported, not forced visible; agents insisting on long foreground commands cannot be duration-predicted by PreToolUse. The sole complete closure is disabling background tasks globally, also losing subagents/Ctrl+B, rejected as too blunt; reconsider as optional only if user accepts.
- **Unrelated local hazard**: research found four daemon processes, two launchd and two under ~/.codex/worktrees/3577/coflux/target/debug. Gateway summary decides CLI target; identify actual daemon before diagnosing unusual agent-command behavior.
- Research on both invisible paths, five rewriting defects, and terminal/background capabilities remains in Decisions for future transparent-interception proposals.
