# Plan 025: Workspace "Changes" tab and diff viewer

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat e152ebb..HEAD -- apps/web/src/ apps/web/package.json apps/web/src/index.css`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none (024 is DONE, its data link is the signal source of this plan)
- Category: feature
- Execution: subagent sonnet
- Planned at: `e152ebb`, 2026-07-23

## Requirement

Plan 024 gives this Agent Command Center an overview of workspace changes through +X −Y. Next, show what changed: add a permanent **Changes tab** with those counts to the right of BranchMenu, switching the main panel to a workspace diff view inspired by Codex web’s Diff tab and Cursor’s file cards.

Required outcomes:
- Place Changes between BranchMenu and the vertical separator. Show its +X −Y badge only for nonzero counts, while keeping the tab visible at 0/0. Remove the standalone top-bar counts now incorporated into the badge. Preserve sidebar statistics.
- Clicking Changes opens the diff panel; clicking any terminal tab returns to that terminal. Selected states are mutually exclusive. Keep terminal instances mounted and toggle visibility.
- Show a summary (N files, total +X −Y), then one column of collapsible file cards. Headers contain path and per-file counts; bodies show unified diff with Shiki language highlighting and token-based addition/deletion backgrounds and colors.
- Match plan 024’s cumulative merge-base(default_branch, HEAD)-to-working-tree range, including untracked files as additions. Badge numbers and displayed content must agree.
- While Changes is active, refetch when broadcast additions/deletions change. Preserve each card’s collapsed state by path.
- Show an empty state for no changes and explicit errors for offline daemons or failed exec, never a blank screen or endless spinner.

The boundary between correct solution vs plausible but incorrect solutions:
- The diff base must be consistent with 024 (merge-base + untracked). Show only the implementation of `git diff` (dirty changes not committed) is wrong - the page becomes empty after agent commit but the tab number is non-zero, which is contradictory.
- The untracked file must appear in the file list (rendered as newly added), otherwise the numbers will not match.
- Backend (proto/worker/server) **zero changes**. Add any proto messages or workers the calculated paths are all wrong - the existing exec RPC already covers these operations.

## Decisions & tradeoffs

- **Use existing exec RPC with no backend changes.** Call `execInWorkspace(workspaceId, command, args)` — exploration notes incorrectly called it sendExec—to run Git as needed. A WorkspaceDiffContent proto/worker path would duplicate request IDs, timeout/disconnect handling, and existing black-box coverage. Evidence: `apps/web/src/client/store.ts:369-374`, `apps/server/src/hub.ts:929-935`, `crates/worker/src/ops.rs:28`, and `tests/src/contract.test.mjs`.

- **Match plan 024’s exact base.** Read the project’s authoritative defaultBranch from the web store, run `git merge-base <defaultBranch> HEAD`, and fall back to HEAD on failure, matching worker diff_stat. Use `git diff <base>` for tracked content, `git ls-files --others --exclude-standard` for untracked files, and `git diff --numstat <base>` for per-file counts. Reject `git diff HEAD` and guessing the default branch. Evidence: `crates/worker/src/git.rs:48`, `packages/protocol/src/gen/coflux/v1/common_pb.ts:102`.

- **Use Shiki with file-language highlighting, on-demand languages, and one dark theme.** Map extensions to languages; fall back to plain text for unknown types. Lazy-load languages through shiki/core or shiki/bundle/web as the executor chooses; never bundle every language into the main chunk. Use existing tokens such as text-success/text-destructive for added/deleted line backgrounds and markers, not raw hex or theme-specific diff colors. The user rejected line-only coloring: `lang='diff'` does not syntax-highlight the code itself. Dual themes/CSS-variable theme machinery is unnecessary in this `color-scheme: dark` app. Evidence: `apps/web/src/index.css:30` and apps/web/package.json, which currently has no highlighting/diff dependencies.

- **Keep local WorkspaceTerminal state (`"terminal" | "changes"`), without routing.** Preserve mounted terminals, remove their selected highlight while Changes is active, and switch back/activate on terminal-tab clicks. Routing would add a new paradigm to the existing state-driven workspace visibility model. Evidence: `apps/web/src/components/workbench/workspace-terminal.tsx:511-529`, `workbench.tsx:258-273`.

- **Use store additions/deletions as the refresh signal.** Plan 024 already polls every 3s and broadcasts only changes. Refetch only while Changes is active, including on entry; keep collapsed states by file path. Do not duplicate polling or transfer full diff text in the background. Evidence: `apps/server/src/hub.ts:386-393`, `workspace-terminal.tsx:415-423`.

- **Move top-bar counts into the badge; retain sidebar counts.** Preflight confirmed that "put statistics on the tab" refers only to the top bar; plan 024’s sidebar overview remains. Evidence: remove `workspace-terminal.tsx:415-423`, retain `apps/web/src/components/workbench/sidebar.tsx:305-311`.

- **Empty/error states (decided during planning):** if additions=deletions=0, render no changes without exec. If exec returns ok=false or nonempty error, including timeout/daemon disconnected, show the error and Retry. execResult resolves even for errors rather than rejecting. Evidence: `apps/web/src/client/store.ts:288-292`, `apps/server/src/hub.ts:181-185,653`.

- **No new automated tests (decided during planning).** This is a web-only presentation change; the project has no vitest/jest infrastructure, and tests/src/contract.test.mjs already covers exec relay. Use typecheck/build and manual acceptance.

## Direction

### Milestone 1: "Change" tab and view skeleton

Add the permanent Changes tab with a badge hidden at 0/0. Switch to its placeholder panel, keep terminal tabs mutually exclusive and mounted, and remove the old standalone top-bar counts. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 2: diff pulling and file card rendering

Fetch cumulative merge-base diff plus untracked files via exec. Render summary, collapsible cards, Shiki content, and reachable empty/error states. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 3: Automatic refresh and state retention

Refetch on additions/deletions changes only while active, preserving collapse by path. Validation: `pnpm --filter @coflux/web build` → exit 0.

## Landmines

- **exec does not run through a shell**: `run_command` directly spawn command+args (`crates/worker/src/ops.rs:28-38`), pipes, `&&`, `$()` cannot be used. Multiple git command = multiple execInWorkspace calls.
- **Non-ASCII path escaping**: git escapes Chinese and other paths into `\346\226\207` octal by default. Run diff/ls-files with `-c core.quotepath=false`, otherwise the file name will be garbled and Path matching (collapsed state, untracked merge) fails.
- **`git diff --no-index` exit code is 1** when there is a difference: if it is used to render untracked File content, exit 1 +`ok=true` is a normal success and cannot be treated as an error. (`ops.rs:44-48` will bring back exit_code unchanged).
- **exec timeout upper limit is on server**: `execTimeout = min(execMaxTimeoutMs, requested value || default)` (`apps/server/src/hub.ts:933`), worker defaults to 60s (`ops.rs:12`). large repository the diff text can be up to several MB, stdout is not truncated, and the entire amount is relayed - normal scale is no problem, but do not execute untracked files dozens of times one by one (use ls-files once to get the list and then merge it).
- **BranchMenu’s ghost button already uses inline styles to suppress a StyleX issue** (`workspace-terminal.tsx:404-410`). Follow the existing handwritten Tailwind/token top-bar style, per apps/web/.claude/CLAUDE.md; no raw hex/px or forced Astryx page layout.
- **workspace.additions/deletions are int32 fields, defaulting to zero in plan 024’s DB.** Test `=== 0`; do not treat them as optional.

## Scope

In scope:
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- Added change view component file under `apps/web/src/components/workbench/`
- `apps/web/package.json`, `pnpm-lock.yaml` (new shiki dependency)
- `apps/web/src/index.css` (if a small amount of diff rendering style is required)

Out of scope:
- `proto/`, `crates/`, `apps/server/`, `packages/protocol/` — Zero changes to the backend are the decision-making red line of this plan
- `apps/web/src/components/workbench/sidebar.tsx` — Leave statistics as is
- diff's review/comment/check file and other interactions - this issue is read-only
- Bright color theme adaptation - apply no bright color mode

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| Black-box regression (the backend is not touched, just run through) | `cd tests && COFLUX_TEST_PG_URL=<54322 direct connection URL> pnpm test` | exit 0 (acceptance) |
| Playwright manual change view | Native `pnpm dev`+ daemon post-browser operation | View/logo/refresh meets Requirement (acceptance) |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` passed.
- [ ] The behavior of the permanent "Change" tab + logo in the top bar complies with Requirement (0 value hides the number); the original top bar the independent statistics span has been removed; the sidebar statistics remain unchanged.
- [ ] Change the view to display the cumulative diff on the same basis as 024 (including untracked newly added), shiki Highlighting by language, file cards collapsible, summary bars correct.
- [ ] When additions/deletions change, the active state view is automatically redrawn, and the collapsed state is retained.
- [ ] The empty state and error state are reachable and not stuck.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (especially: it is found that proto/worker/server must be changed to achieve this - stop and report, do not cross the line).
- A validation command fails twice after one reasonable fix.
- shiki cannot be integrated under language lazy loading constraints (the main bundle is inevitably fully bloated) - stop Report, and may not be downgraded to a non-highlighted plan without authorization.

## Maintenance notes

- The view’s merge-base/HEAD-fallback/untracked logic semantically mirrors diff_stat in crates/worker/src/git.rs. Change both together or badge counts and content drift.
- Full diff snapshots become slow at tens of megabytes. If needed later, fetch numstat first and load each file’s diff on expansion; no protocol change is required.
- shiki language chunks are generated by builder code splitting, increasing the number of dist files is expected behavior.
