# Plan 096: Inject Coflux coordinates at SessionStart and translate the entire plugin into English

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5d0c157..HEAD -- integrations/claude-plugin packages/cli/skills tests/src plans`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (uses deployed 092 COFLUX_* injection and 095 plugin delivery directory)
- Category: feature
- Execution: self (2026-09-07 departure check: user said to proceed immediately after planning; pause once before marketplace release)
- Planned at: `5d0c157`, 2026-09-07

## Requirement

The Coflux plugin currently puts all location/workflow guidance in a 14 KB SKILL, activated by its description. Agents still run env | grep COFLUX_ to discover coordinates, which disappear after context compaction. The local dev plugin 0.18.0 proactively injects essential information via SessionStart additionalContext. On 2026-09-07 the user chose the same approach: **inject coordinates and one division-of-responsibility rule in a coflux-session block at session start; leave SKILL for details**. They also requested **English throughout the plugin, including SKILL**.

Outcomes for Claude Code/Codex with this plugin in Coflux terminals:

1. With nonempty COFLUX_WORKSPACE_ID, SessionStart for startup/resume/clear/compact/fork prints a plain-text `<coflux-session>…</coflux-session>` block: six COFLUX_* variables, one KEY=value per line; a sentence explaining that the user can watch/take over; one local-versus-MCP rule, including not creating worktrees directly; and a skill pointer. Never inject the whole SKILL.
2. Empty/missing workspace ID means no output and exit 0. Missing script is also silent. Never disturb users outside Coflux.
3. SKILL location discovery first uses the block, falling back to environment variables if hooks are untrusted, manually connected, or absent. Retain the variable table.
4. Translate delivery README, hooks description, both scripts' comments/messages, and SKILL into English. Translate the authoritative packages/cli/skills/coflux/SKILL.md too, including npm's copy, without semantic changes.
5. Bump plugin 0.4.1 → **0.5.0**, publish the new SHA through the marketplace, and leave daemon/server/CLI code unchanged.

Incorrect alternatives: injecting all 14 KB at every start/compaction; UserPromptSubmit injection on every prompt; querying daemon/center connectivity, which is slow, quickly stale, and violates local-first's no-extra-round-trip principle; or changing the cofluxd hook messenger, whose no-stdout contract must remain intact.

## Decisions & tradeoffs

- **Plain sh with plain stdout, not Node/JSON.** Claude Code hooks.md says SessionStart stdout is added directly to context. Codex 0.153 session_start.rs parse_completed treats non-JSON stdout as additional context and empty stdout/exit 0 as no-op. `printf '%s\n' …` passes values as arguments without format-string injection. Rejected: Node hookSpecificOutput.additionalContext JSON adds a dependency without host-compatibility benefits. Evidence: both hosts' documentation/source verified through context7 on 2026-09-07; existing hook style.
- **Add SessionStart without matcher**, covering startup/resume/clear/compact/fork; compaction thus restores coordinates. Codex matches the same source semantics. Use the existing silent wrapper style: `sh -c '[ -r "$0" ] && exec sh "$0" || :' "${CLAUDE_PLUGIN_ROOT}/scripts/session-context.sh"`. Rejected: startup|compact excludes other context-loss sources. Evidence: hooks.md; trusted_hash for `coflux@plugins:hooks/hooks.json:pre_tool_use:1:0` in ~/.codex/config.toml proves Codex executes this plugin; official Codex SessionStart uses CLAUDE_PLUGIN_ROOT, proving expansion.
- **List six variables as KEY=value**, matching SKILL and allowing direct MCP argument use without renamed concepts. Print empty COFLUX_PROJECT_ID for directory workspaces and explain it on the next line. Evidence: supervisor sessions.rs:824-829 supplies all six, empty when absent.
- **Translate the entire plugin and authoritative SKILL together**, explicitly requested. Sync --check requires copy equality. Guard denial messages become English; tests assert IDs/tool names rather than language. At this historical implementation stage, plans, CI comments, and sync-script messages outside the plugin remained Chinese.
- **Tests in new tests/src/claude-plugin-session-context.test.mjs, without a stack.** Spawn sh with environments; assert block/six coordinates, three silent cases, matcher-free SessionStart/script reference, untouched messenger entries, version ≥0.5.0, and SKILL block guidance. Follow plan 095's precedent.

## Direction

### Milestone 1: Script, hook, SKILL, translation, and version

Add session-context.sh, hook entry/description, English guard comments/messages, translated/synchronized SKILL and README, plugin 0.5.0, and tests.
Validation: hook JSON parse, sh syntax, sync --check all exit 0; `cd tests && node --import tsx --test src/claude-plugin-session-context.test.mjs src/claude-plugin-guard.test.mjs` passes; `grep -rP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` produces no output.

### Milestone 2: Marketplace publication

Commit/push Coflux main; update plugins-builder catalog/plugins/coflux.json origin.sha/ref; npm run verify; npm version minor; git push origin main --follow-tags; verify myWsq/plugins@main plugins/coflux is 0.5.0.
**Pause for user approval before release**: builder contains the user's in-flight dev-plugin changes, so commit only the descriptor separately.

## Landmines

- Stdout must contain only the block; debug output enters model context. Codex fails hooks whose stdout looks like malformed JSON, so start with `<`, never `{`.
- Codex requires one-time trust for the new entry, stored by entry hash in hooks.state. Until trusted it does not execute; SKILL must remain self-sufficient through environment fallback.
- Leave messenger entries for all eight existing events and PreToolUse guard unchanged; add only SessionStart.
- Entire directory is published. scripts contains only the two scripts, not tests.
- Builder rejects publication if plugin.json version is not raised.
- Translation must preserve every rule/limit: 16 KB, 64 KB, 30 minutes, 600 s, eight terminals.
- This repository's guard can falsely reject Bash writing documents that mention direct Git worktree creation, an accepted plan 095 limitation. Use a file-writing tool or different wording.

## Scope

In scope:
- Plugin hooks/hooks.json, scripts/session-context.sh, scripts/guard-git-worktree.mjs, skills/coflux/SKILL.md, .claude-plugin/plugin.json, README.md
- Authoritative packages/cli/skills/coflux/SKILL.md, English with unchanged meaning
- New tests/src/claude-plugin-session-context.test.mjs
- plans/README.md
- plugins-builder catalog/plugins/coflux.json, SHA/ref only

Out of scope:
- crates, apps/server, packages/cli/cofluxd.mjs
- SessionStart handling in cofluxd hook messenger, unnecessary for activity state
- Hook daemon-status/terminal-list queries, violating fast/no-extra-request behavior
- Guard repository-ownership false positives from checking only project ID, reported in the builder session on 2026-09-07; requires daemon workspace-path injection and separate work, listed in Backlog

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Hook JSON | `node -e 'JSON.parse(require("fs").readFileSync("integrations/claude-plugin/hooks/hooks.json","utf8"))'` | exit 0 |
| Shell syntax | `sh -n integrations/claude-plugin/scripts/session-context.sh` | exit 0 |
| SKILL equality | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| English-only plugin | `grep -rP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` | No output |
| Unit tests | `cd tests && node --import tsx --test src/claude-plugin-session-context.test.mjs src/claude-plugin-guard.test.mjs` | All pass |
| Marketplace build acceptance | plugins-builder `npm run verify` | exit 0 |

## Done criteria

- [x] All listed commands pass.
- [x] Coflux sessions begin with a block containing six coordinates, division rule, and skill pointer.
- [x] Outside Coflux, no output/exit 0; missing script is silent.
- [x] Entire plugin English, synchronized SKILL, every original Chinese semantic preserved.
- [x] Plugin 0.5.0 published at myWsq/plugins@main.
- [x] No out-of-scope changes.
- [x] Index updated.

## STOP conditions

- Either host does not accept SessionStart plain stdout as context, contradicting 2026-09-07 verification.
- Builder verification/publication gate fails for an out-of-scope reason.

## Maintenance notes

- Future block fields such as workspace name/branch change only session-context.sh and plugin version; sources remain environment variables, never daemon queries.
- Claude Code does not fire SessionStart for subagents; parent agents must pass coordinates in prompts.
- Codex's initial new-hook trust prompt is host behavior, not a plugin defect.
- Guard ownership false positives also reject worktree operations on temporary/unrelated repos while reporting the inherited project ID. A proper fix needs supervisor COFLUX_WORKSPACE_PATH and comparison against actual repo resolved from stdin cwd plus command git -C/cd forms, allowing mismatches. The same report notes create_workspace createNew lacks startPoint and returned path is undocumented in the tool description. All are in Backlog.
