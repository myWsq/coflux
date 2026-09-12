# Plan 095: Guard Git worktree operations in the Claude plugin and direct project sessions to workspace tools

> This plan is an outcome contract, not a step-by-step script. Understand requirements and recorded decisions, then implement against live code. Validate milestones only if you are also the verifier; delegated executors implement with verification outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat eecf8d6..HEAD -- integrations/claude-plugin packages/cli/skills tests/src scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (delivery directory published with eecf8d6 as 0.3.0)
- Category: feature
- Execution: self (2026-09-06 departure check: execute immediately after planning through marketplace publication, observing STOP/BLOCK)
- Planned at: `eecf8d6`, 2026-09-06

## Requirement

A Coflux workspace is a Git worktree plus a center record: ID/name, terminal ownership, branch/diff statistics, and COFLUX_* injection. Claude Code running `git worktree add` directly inside a Coflux project creates a directory invisible in the sidebar, where users cannot open terminals. SKILL guidance alone is insufficient. On 2026-09-06 the user selected approach one: **PreToolUse intercepts these commands and directs agents to MCP workspace operations**. Approach three, daemon adoption of external worktrees, needs a separate plan.

Outcomes for Claude Code in Coflux project sessions:

1. Nonempty COFLUX_PROJECT_ID plus Bash containing `git … worktree add|remove|move` is denied. Briefly explain visibility and alternatives: create_workspace using the actual project ID, remove_workspace for deletion, git worktree list/list_workspaces for inspection.
2. **No decision output**, normal permissions continue, when project ID is empty/absent (including directory workspaces), command uses list/lock/unlock/prune/repair, tool is not Bash, stdin is invalid JSON, or Node is unavailable. Exceptions must never falsely block.
3. Change only plugin hook/script/SKILL and authoritative SKILL source; bump 0.3.0 → **0.4.0**, publish new SHA through marketplace. No daemon/server/CLI changes.
4. Applies only to Claude Code; Codex and manually entered user commands remain unaffected.

Incorrect alternatives: PATH git shims would block users and require supervisor changes; cofluxd hook messenger must never write stdout and cannot contain this guard; ask decisions request user confirmation instead of giving direction; list/prune must not be blocked.

## Decisions & tradeoffs

- **Independent Bash-matched hook shipped with plugin.** Add a PreToolUse array entry with matcher Bash and a command using `${CLAUDE_PLUGIN_ROOT}/scripts/…`, alongside the matcher-free messenger. Claude runs multiple event hooks independently in parallel. Rejected: adding interception to cofluxd hook violates no-stdout and ties it to npm rather than plugin version. Evidence: official hooks/plugins-reference verified with claude-code-guide on 2026-09-06: exact tool matcher, plugin-root expansion, inherited environment, parallel hooks; current hooks.json style.
- **Deny via stdout JSON, exit 0**, with hookSpecificOutput hookEventName=PreToolUse, permissionDecision=deny, permissionDecisionReason. The reason reaches the model. Allowed cases output zero bytes and exit 0, expressing no opinion. Rejected: exit 2/stderr is less suitable than documented conditional JSON decisions. Stdout must contain pure JSON or parsing fails.
- **Use Node; silently allow if unavailable.** Command wrapper: `sh -c 'command -v node >/dev/null 2>&1 && exec node "$0" || :' "${CLAUDE_PLUGIN_ROOT}/scripts/<script>"`. Follow cofluxd hook readStdinJson: TTY short-circuit, timeout, null on parse error. Rejected: shell JSON parsing has no guaranteed jq; cofluxd already requires Node. Evidence: cofluxd.mjs:873-882 and existing silent messenger wrapper.
- **Match any command-string occurrence of Git plus global options plus worktree add/remove/move**, including git -C and after cd/&&/;/pipes. Permit list/lock/unlock/prune/repair. Accept false positives such as `echo "git worktree add"` rather than misses. Rejected: full shell parsing is disproportionate for a guidance hook.
- **Include actual COFLUX_PROJECT_ID in the reason**, directly usable in create_workspace, plus delete/inspection alternatives so agents do not retry another raw subcommand.
- **Tests outside delivery in tests/src/claude-plugin-guard.test.mjs**, stack-free child processes receiving env/stdin. Cover deny and silent cases, valid hooks JSON/Bash script reference, and version >0.3.0. Rejected: tests in delivery would publish with the whole directory. Evidence: stack-free build-version tests and docs/external-plugins.md.
- **Add one source-SKILL sentence and synchronize.** In central MCP guidance, explain not to run git worktree add directly because project sessions redirect to create_workspace. Run node scripts/sync-claude-plugin.mjs. Evidence: plan 094 source decision and CI equality check.

## Direction

### Milestone 1: Script, hook, SKILL, and version

Add script/hook, one SKILL sentence, plugin 0.4.0, and one README component explanation.
Validation: hook JSON parses, sync --check exits 0, guard tests pass.

### Milestone 2: Marketplace publication

Commit/push Coflux main; update builder catalog/plugins/coflux.json origin.sha/ref; npm run verify; npm version minor; git push origin main --follow-tags. Verify successful publication and myWsq/plugins@main plugins/coflux version 0.4.0 with scripts directory.
Acceptance: builder verification exit 0; gh run watch succeeds; `gh api repos/myWsq/plugins/contents/plugins/coflux/.claude-plugin/plugin.json` reports 0.4.0.

## Landmines

- Existing PreToolUse entry has no matcher and reports all tools. Add a second entry without modifying the first.
- Stdout must be pure JSON. Debug console.log breaks decisions; debug only to stderr, off by default under COFLUX_HOOK_DEBUG.
- Whole directory ships: scripts contains only this script, no tests/node_modules. Executable bit does not matter because Node invokes it.
- Builder rejects changed payload without a plugin version bump.
- Builder checkout contains user work. Inspect status before descriptor edits and commit only catalog/plugins/coflux.json.

## Scope

In scope:
- Plugin hooks/hooks.json, scripts, synchronized skills/coflux/SKILL.md, plugin.json, README
- Authoritative packages/cli/skills/coflux/SKILL.md
- New tests/src/claude-plugin-guard.test.mjs
- plans/README.md
- Builder catalog/plugins/coflux.json, SHA/ref only

Out of scope:
- crates, apps/server, packages/cli/cofluxd.mjs
- Codex interception, with no corresponding mechanism
- Daemon external-worktree adoption, approach three in a separate plan

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Hook JSON | `node -e 'JSON.parse(require("fs").readFileSync("integrations/claude-plugin/hooks/hooks.json","utf8"))'` | exit 0 |
| SKILL consistency | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Guard tests | `cd tests && node --import tsx --test src/claude-plugin-guard.test.mjs` | All pass |
| Marketplace build acceptance | builder `npm run verify` | exit 0 |
| Publication acceptance | `gh run watch <release run> --exit-status` | success |

## Done criteria

- [ ] All commands pass.
- [ ] Project sessions deny git worktree add/remove/move with create_workspace and actual project ID in the reason.
- [ ] Missing ID, allowed inspection subcommands, non-Bash, and malformed JSON are silent with exit 0.
- [ ] Marketplace 0.4.0 includes scripts.
- [ ] No out-of-scope changes.
- [ ] Index updated.

## STOP conditions

- Verified Claude hook contract proves false during implementation, e.g. missing plugin-root expansion.
- Builder verification/publication fails for an out-of-scope reason.

## Maintenance notes

- Approach three, periodic daemon git worktree list --porcelain adoption/deletion synchronization, is a more complete fallback awaiting planning.
- This guard is guidance, not a security boundary. Commands hidden in scripts bypass it; blocking those is not intended.
- Future guarded commands, such as git worktree prune, require matching-table changes and a plugin version bump.
