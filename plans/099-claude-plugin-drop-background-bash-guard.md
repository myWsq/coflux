# Plan 099: Remove Claude plugin background-Bash blocking/reporting and make terminal guidance descriptive

> This plan is an **outcome contract, not an execution script**. Understand the requirements and decisions, then design against live code.
> The implementer performs milestone validation (self-execution). Stop on any STOP condition.
> Update `plans/README.md` when complete.
>
> Drift check: `git diff --stat 3173ce2..HEAD -- integrations/claude-plugin packages/cli/skills tests/src/claude-plugin-background.test.mjs tests/src/claude-plugin-session-context.test.mjs tests/src/claude-plugin-guard.test.mjs scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (reverses 098 without changing 095's worktree guard or 096's SessionStart block structure)
- Category: dx
- Execution: self
- Planned at: `3173ce2`, 2026-09-10

## Requirement

Plan 098 (plugin 0.6.0, already published) externalized otherwise invisible background processes in Coflux workspaces. PreToolUse denied `Bash(run_in_background: true)` and inserted a tutorial to use `cofluxd terminal new` followed by a background wait. PostToolUse detected backgroundTaskId and wrote “Heads-up: a background task you cannot see…” to the workspace card. After two days, the user found **the interception too cumbersome**: agents lost native background Bash streaming, automatic wakeup, and independence from the center, replaced by a two-step terminal/wait detour. The user decided to remove it and soften SKILL's recommendation to replace background Bash with terminals. Coflux terminals are a capability; agents decide when to use them, not the plugin.

Consumers are Claude Code/Codex agents in Coflux terminals and, indirectly, users watching workspace cards. Completion means:

- **Agents**: background Bash follows normal host permission flow, without denial or instructions to use cofluxd terminal new.
- **Users**: results with backgroundTaskId, whether explicitly backgrounded or timed out into background, no longer emit Heads-up reports. Card progress contains only the agent's own message.
- **All plugin text** (SKILL, coflux-session block, hooks/plugin descriptions) stops requiring or urging terminal replacement of background Bash. Describe capabilities—sidebar visibility, user takeover, later log reading—and suitable situations, leaving judgment to the agent. Preserve command usage for new/list/read/wait/send/progress/notify/ports, `--cmd=<value>`, wait's always-zero exit with `# exited exit=N`, and the open-terminal → background-wait → wake-and-read recipe, phrased as usage guidance.
- **Unchanged**: guard-git-worktree.mjs behavior, all cofluxd messenger hooks, and coflux-session block structure, coordinates, two-track rules, worktree guidance, and skill pointer.

## Decisions & tradeoffs

- **Remove both scripts, including the reporter.** Rejected: remove only PreToolUse denial. The reporter existed solely to cover timeout-driven backgrounding that the guard could not intercept; afterward every explicit background Bash would overwrite meaningful progress with Heads-up text that still urges terminal substitution. Evidence: report-background-task.mjs:1-12 calls it a “leak reporter, not a guard.” The third PreToolUse and second PostToolUse Bash entries were added by 098; compare `git diff 8de554e..HEAD -- integrations/claude-plugin/hooks/hooks.json`.
- **In hooks.json remove only those two Bash entries and the trailing description clause; preserve everything else byte-for-byte.** Rejected: incidental reorder/merge — breaking matcher-free cofluxd hook claude entries breaks web activity state. SessionStart session-context.sh and PreToolUse guard-git-worktree.mjs belong to 096/095. Evidence: hooks.json and plugin README Components → hooks/.
- **Soften SKILL by removing persuasion/interception references, retaining capabilities and usage.** Invariants: (1) remove the entire 098 paragraph beginning “Inside a coflux workspace the plugin enforces this…”; (2) When to open a terminal must no longer begin “instead of backgrounding a process yourself” or claim “the user sees nothing.” Describe visible/takeover/readable terminals as an option for interaction, possible user takeover, persistent services, or a clickable user entry point. Retain the warning against noisy one-second terminals; (3) retain the wait recipe but remove statements such as “the one backgrounded call the plugin allows”; (4) change frontmatter/opening “externalize long tasks…” into capability language; (5) leave the two-track table, coordinates, MCP section, Boundaries, --cmd syntax, and wait exit semantics untouched. Rejected: deleting When to open a terminal entirely, because agents still need its capabilities to judge; retaining persuasion while deleting only enforcement, because the user explicitly chose softer advice too. Evidence: source SKILL:56-77,134-144 and its diff from 8de554e.
- **Edit only the authoritative SKILL, then synchronize.** Source is packages/cli/skills/coflux/SKILL.md; run node scripts/sync-claude-plugin.mjs. CI --check compares copies. Rejected: editing only the delivery copy, which fails that check. Evidence: sync script:9-14.
- **Change only the parenthetical clause on coflux-session's Rule line.** Replace “run anything long or interactive in a terminal the user can see” with capability language such as “open a terminal the user can watch and take over.” Preserve coordinates, two-track rules, create_workspace guidance, and skill pointer. Rejected: rewriting the whole line. Tests assert command/MCP/create_workspace/skill tokens and size below 2048 bytes, not this exact clause; broader rewriting has no benefit. Evidence: session-context.sh and session-context tests:51-57.
- **Bump plugin 0.6.0 → 0.7.0** and replace its “teaches agents to externalize work…” description with capability language. Rejected: a patch bump; README only requires increasing SemVer, but 095/096/098 established minor bumps for behavior changes. Evidence: plugin.json and README Maintenance.
- **Delete all of claude-plugin-background.test.mjs, moving only the English-only test first.** Thirteen of its fourteen tests cover removed scripts, guard hooks/version ≥0.6.0, or denied SKILL recipes and become obsolete. The zero-Han-character test is the sole guard for 096's English-only contract; first move it to session-context or guard tests, executor's choice, and make it pass. Rejected: keeping a misleading background-test shell with one unrelated case. Evidence: background tests:279-291 and the unique character-check search hit.
- **All plugin-directory copy remains English**, per plan 096 and its character guard.
- **Planning decision: do not proactively edit plugin README.** It currently mentions no background guard and still lists three hook categories. Soften it only if execution finds terminal-over-background persuasion. Evidence: README Components.

## Direction

Run two milestones **sequentially**, not concurrently: SKILL text, hook descriptions, and tests cross-reference one another, so splitting yields broken intermediate results.

All plugin-directory text must be English. This historical plan retained Chinese prose and test names at implementation time.

### Milestone 1: Remove hooks and consolidate tests

Delete guard-background-bash.mjs and report-background-task.mjs, their two Bash entries, and the description tail; preserve all other entries. Change the single session Rule clause and plugin description; set version 0.7.0. Move the character guard into an existing test file before deleting background tests.

Validation: `node --import tsx --test tests/src/claude-plugin-*.test.mjs` → exit 0; `node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` → exit 0; `sh -n integrations/claude-plugin/scripts/session-context.sh` → exit 0; residual checks below produce no output.

### Milestone 2: Soften SKILL and synchronize

Apply the five invariants to packages/cli/skills/coflux/SKILL.md and run node scripts/sync-claude-plugin.mjs.

Validation: sync --check exits 0; plugin Han-character scan is empty; `grep -n -i -E 'instead of backgrounding|sees nothing|plugin allows|enforces this|is \*\*denied\*\*' packages/cli/skills/coflux/SKILL.md` finds nothing.

## Landmines

- This is a Coflux project session with nonempty COFLUX_PROJECT_ID. guard-git-worktree.mjs applies regexes to the entire Bash command text: even heredoc bodies and commit messages mentioning Git worktree creation/removal/movement may be denied, as recorded in the index backlog. Use Write/Edit for files and avoid those contiguous words in commit text. This plan stays on main and needs no new worktree.
- Always synchronize both SKILL copies after editing the source, or --check fails.
- hooks.json is handwritten JSON: avoid trailing commas. PreToolUse should retain two entries (messenger/worktree guard), PostToolUse one (messenger).
- Do not run the full black-box suite here. This machine's Coflux installation makes three agent-activity process-tree cases fail/hang. No Rust/server/daemon/proto changes occur; plugin tests plus sync --check suffice.
- Move and pass the English-only test before deleting its original file, avoiding an unguarded 096 contract.
- Another branch's linked worktree at .claude/worktrees/20260908-codex-agent-tab contains 098 copies. Do not edit or scan it; restrict residual searches to integrations/claude-plugin, packages/cli/skills, tests/src.

## Scope

In scope:
- integrations/claude-plugin/hooks/hooks.json
- scripts/guard-background-bash.mjs and scripts/report-background-task.mjs in that plugin, deleted
- Plugin scripts/session-context.sh, .claude-plugin/plugin.json, synchronized skills/coflux/SKILL.md
- Plugin README only if persuasive language is found
- packages/cli/skills/coflux/SKILL.md, the sole source
- tests/src/claude-plugin-background.test.mjs, deleted
- session-context or guard plugin tests receiving the English-only case
- plans/099-*.md, plans/README.md

Out of scope:
- guard-git-worktree.mjs repository-ownership validation and heredoc false positives, separate backlog items
- Rust/proto/daemon/server/web; this is JS and documentation only
- .claude/worktrees/20260908-codex-agent-tab copies
- Marketplace release: bump, push, hand SHA to plugins-builder; user initiates publication
- Global switches such as CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, contrary to this direction

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Plugin tests | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL synchronization | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Valid hooks JSON | `node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` | exit 0 |
| Session shell syntax | `sh -n integrations/claude-plugin/scripts/session-context.sh` | exit 0 |
| No Han characters | `! grep -rlP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` | No output |
| Mechanism remnants | `! grep -rn -E 'guard-background-bash\|report-background-task\|run_in_background\|backgroundTaskId' integrations/claude-plugin packages/cli/skills tests/src` | No output |
| Persuasion remnants | `! grep -n -i -E 'instead of backgrounding\|sees nothing\|plugin allows\|enforces this' packages/cli/skills/coflux/SKILL.md` | No output |
| Real simulation | With COFLUX_WORKSPACE_ID=x COFLUX_PROJECT_ID=p, feed `{"tool_name":"Bash","tool_input":{"command":"pnpm test","run_in_background":true}}` to each remaining Bash matcher script | No stdout, exit 0 |

## Done criteria

- [ ] All commands pass.
- [ ] Background guard/reporter hooks gone; messenger, SessionStart, and worktree guard preserved unchanged.
- [ ] Both scripts and background test file deleted; relocated English-only guard passes.
- [ ] Both synchronized SKILL copies, session block, hook description, and plugin description no longer urge replacing background Bash; terminal usage/wait recipe remain.
- [ ] Plugin 0.7.0, entirely English.
- [ ] No out-of-scope changes.
- [ ] Index updated: 098 annotated as removed by 099, 099 DONE, execution order extended.

## STOP conditions

- A cited fact changes, especially SKILL source relationship, hook layout, or sole location of the English-only case.
- Implementation requires Rust/proto/daemon/server/web changes.
- The same validation still fails twice after one reasonable fix.

## Maintenance notes

- **098's research remains valid; its product direction was rejected.** Its Decisions retain the two invisible-background paths, five problems with transparent updatedInput rewriting, and differences between terminals/native background Bash. Future interception proposals should read 098, then this Requirement for why the user rejected it.
- **Release path**: version is raised to 0.7.0 by this plan. After push, give the SHA to plugins-builder for marketplace release. Users update through /plugin; Codex requests trust again because hooks.json changes. Builder docs/coflux.md gained background-guard text during 098 publication; remove it in the release too.
- The Codex Agent Tab worktree branch still includes 098. Merging it will conflict in hooks.json/SKILL/tests; resolve in favor of this plan's deletion.
