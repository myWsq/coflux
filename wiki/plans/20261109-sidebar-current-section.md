# Plan 20261109-sidebar-current-section: The sidebar opens on what you are working on

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 56db5dcb..HEAD -- apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts apps/desktop/src/renderer/components/workbench/dialogs.tsx apps/desktop/src/renderer/components/workbench/command-palette-recent.ts apps/desktop/src/renderer/config.ts apps/desktop/src/main/menu.ts apps/desktop/src/main/browser-policy.ts apps/desktop/src/shared/desktop-bridge.ts packages/client/src/store.ts`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (plain autopilot)
- Workspace: isolated — planned from the main worktree, moved to `.claude/worktrees/20261109-sidebar-current-section` on `dev/20261109-sidebar-current-section`
- Planned at: `56db5dcb`, 2026-11-09

## Record

### Requirement

With about 22 projects and 15 worktree workspaces in the account, the desktop sidebar lists
roughly 37 rows, every project expanded, projects in import order. Collapse state lives in
component state and resets on every restart. The workspaces the user is actually working on
today sit between projects untouched for weeks, so the user hunts through the sidebar to find and
keep sight of them. The activity signals already exist (agent state per workspace, progress
notes, diff stats, ⌘P recent visits) but only decorate rows; nothing uses them to organise the
list.

Done, the sidebar answers "what am I working on, and what is waiting for me" at a glance.

Product conclusions (confirmed with the user at the product gate; copy reworked at their request):

- **「当前」 section** at the top of the sidebar, above 「项目」. A two-character noun like
  「项目」/「设备」. It is an automatic shortcut list, not a new level of hierarchy.
- **Membership, fully automatic** (no manual pin or remove):
  - every workspace with a non-idle agent state — 正在执行, 等待批准, 等待回答, 出错停止, 本轮完成;
  - plus workspaces on screen on this machine within the last 24 hours, at most 5 of them, most
    recent first when choosing which 5.
  - Directory workspaces (a device's `~`, the carrier of the device view) and workspaces of
    archived projects are never members.
- **Order is stable and identical to the tree's**: project order as the tree lists projects, then
  workspace order within the project as the tree lists it. Only a workspace entering or leaving
  changes the list; existing rows never swap places, whatever their activity.
- **Rows**: the same icon slot as the tree row (activity dots when there is activity, otherwise the
  branch glyph), the branch or custom name as the label, the project name muted on the right. The
  tooltip and right-click menu are the tree row's.
- **Both places**: a workspace in 「当前」 stays in the tree too, and the selection is highlighted
  in both.
- **Empty**: when nothing qualifies, the section and its header are not shown. Nothing renders
  before the first snapshot has arrived.
- **Project tree**: projects are collapsed by default; expanding or collapsing one is remembered
  across restarts. A collapsed project row shows its highest-priority descendant activity dot and
  a tooltip summarising it (for example 「2 个工作区待处理」, 「Claude 正在执行」). The tree never reorders
  by activity and never expands itself on selection.
- **「待处理」** is the umbrella word for 等待批准 / 等待回答 / 出错停止.
- **Shortcut 「下一个待处理」** cycles through the 待处理 workspaces in 「当前」 order and lands on the
  waiting terminal. It is listed in the 视图 menu and in the shortcut help.
- **Non-goals**: manual pin/unpin, iOS, archiving single workspaces, an activity-sorted tree,
  syncing visits across devices.
- **What the user observes when done** (by hand, `pnpm dev:desktop:prod`): on opening the app,
  workspaces with running agents and those touched today are on top and stale projects are one
  collapsed line each; a workspace going to 等待批准 changes colour in place without moving, and the
  shortcut jumps to its terminal; a workspace with no agent and not on screen for 24 hours leaves
  「当前」; collapse state survives a restart.

### Decisions & tradeoffs

- **D1 One derivation**: a single pure function turns (projects, workspaces, daemons, tasks,
  session agents, visit times, selected workspace, now) into the ordered 「当前」 rows, each with its
  aggregated activity (including the waiting terminal's task id). The sidebar section renders it
  and the 「下一个待处理」 shortcut walks it; neither re-derives membership or order. Rejected: the
  shortcut walking `attentionSnapshot` (desktop-attention.ts) — that snapshot covers directory and
  archived workspaces and has no order, so the cycle could visit places the section does not show
  and in a different order `(decided while planning)`. Based on: `workspaceActivity` at
  `packages/client/src/store.ts:168` already returns status and `taskId`; `attentionSnapshot` in
  `apps/desktop/src/renderer/components/workbench/desktop-attention.ts` iterates every workspace
  unfiltered.
- **D2 Tree order is shared, not copied**: the order the tree uses — the visible project list in
  store order (archived filtered out), and within a project the main workspace first, then the
  others by `createdAt` — is extracted from `sidebar.tsx` and used by both the tree and D1. The
  existing order does not change. Rejected: a second copy of the sort in the new module — two
  copies drift and the section would stop matching the tree. Based on: `workspacesOf` at
  `apps/desktop/src/renderer/components/workbench/sidebar.tsx:207`.
- **D3 Visit times are their own store**: a server-scoped localStorage record of workspace id →
  the last time it was on screen, in its own pure module with storage and key injected (the
  `command-palette-recent.ts` pattern). The ⌘P `coflux_recent_places` list and its format are left
  untouched. Rejected: adding timestamps to the ⌘P list — it records order only, mixes terminals
  and devices, is capped at 20, and is re-recorded on every selection reconciliation. Based on:
  `apps/desktop/src/renderer/components/workbench/command-palette-recent.ts`,
  `COMMAND_PALETTE_RECENT_KEY` in `apps/desktop/src/renderer/config.ts`.
- **D4 "On screen" means until you leave**: the selected workspace counts as visited *now* for as
  long as it is selected, and its stored time is written when the selection moves off it (to
  another workspace, a device or a screen). Therefore the selected workspace is always in
  「当前」, and staying in one workspace longer than 24 hours never drops it. Rejected: stamping the
  time on entry only — a workspace the user sits in for 30 hours would vanish from 「当前」 while on
  screen. Based on: the selection effect keyed on `visitedPlaceKey` in
  `apps/desktop/src/renderer/components/workbench/workbench.tsx:1568`.
- **D5 Recent slots are extra rows**: the up-to-5 recent slots are filled from eligible workspaces
  that are *not* already members through agent activity, most recent first, within 24 hours.
  Agent-active members are uncapped. Rejected: choosing the 5 most recent among all workspaces and
  then unioning — agent-active ones would eat recent slots and push out the manual work the recency
  rule exists for `(decided while planning)`. Based on: product conclusion "最近访问这一类最多 5 个".
- **D6 Collapse persistence stores the expanded set**, server-scoped in localStorage, so a project
  never seen before is collapsed with no extra rule. Rejected: persisting the collapsed set (today's
  in-memory shape) — new projects would open expanded, contradicting "collapsed by default". Based
  on: `collapsedIds` `useState` in `sidebar.tsx` ("默认全部展开，只记折叠集合").
- **D7 Shortcut is ⌘⇧A, a page shortcut**: handled in `use-global-shortcuts.ts`'s ⌘⇧ branch,
  shown (not registered) in the 视图 menu like the other page shortcuts, forwarded from focused
  built-in browser pages by `classifyGuestKey`, and listed in the help dialog. Navigation reuses
  `landOnTask`. ⌘⇧A rather than another letter: it is free in the app (⇧⌘W closes the window,
  ⌘⇧D is browser annotate, ⌘⇧\ splits down) and reads as "attention" `(decided while planning)`.
  Based on: `apps/desktop/src/main/browser-policy.ts` `classifyGuestKey`;
  `apps/desktop/src/main/menu.ts` `pageShortcut`; `decideTerminalKeyOwner` in
  `terminal-key-ownership.ts` already gives every ⌘⇧ chord to the app.

### Discussion log

1. Main pain? Options: 看不到全局 + 噪音太多 / 只是噪音 / 在几个之间来回切 / 不知道哪个在等我.
   Answer: **看不到全局 + 噪音太多** → a top section plus tree de-noising.
2. Who belongs in the section? Options: 自动 (agent 活动 + 最近访问) / 自动 + 手动移出置顶 / 只看 agent /
   纯手动. Answer: **自动：agent 活动 + 最近访问**.
3. Relation to the tree? Options: 两处都在，树不动 / 移走 / 不要分区只改树. Answer: **两处都在，树不动**.
4. Tree de-noising? Options: 项目默认折叠 + 记住 / 项目内收起不活跃 worktree / 不活跃项目沉底 / 只靠分区.
   Answer: **项目默认折叠 + 记住折叠**.
5. Section order? Options: 稳定跟树序 / 等我的浮顶 / 按最近访问. Answer: **稳定：跟树的顺序一致**.
6. Recency window? Options: 24h 最多 5 / 最近前 3 / 72h 最多 8. Answer: **过去 24 小时内，最多 5 个**.
7. Include a jump shortcut? Answer: **包含**.
8. Product confirmation: the user rejected 「进行中」 as a status word that does not read as a place
   in Chinese product copy and asked for the copy to be reworked. Section name options: 当前 / 最近
   / 活跃 / 手头 (「最近」 noted to clash with ⌘P's pure-MRU 「最近」 group). Answer: **当前**, with
   「待处理」 and 「下一个待处理」. Product conclusions then confirmed; continue to implementation.
9. Departure check: execution **subagent(opus)**; **plain autopilot**, no plan audit.
10. `(decided while planning)` D1 shortcut source, D5 recent slots as extra rows, D7 the ⌘⇧A key.

### Maintenance notes

- A directory workspace (device `~`) whose agent waits is not in 「当前」 and so not reached by
  「下一个待处理」; desktop notifications and the Dock badge still cover it. Revisit if that bites.
- Visit times are per machine and per server address; they are not cleared on sign-out, like the
  ⌘P list.
- If a later change gives `workspaceActivity` new states, the section's membership and the
  collapsed-row priority both follow it through D1; check the collapsed-row tooltip wording.

## Execution brief

> Written for `subagent(opus)` at `56db5dcb`. Implement the tasks in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

Add an automatic 「当前」 section to the top of the desktop sidebar, persist project collapse state
with projects collapsed by default, and add a 「下一个待处理」 shortcut (⌘⇧A). All work is in the
Electron renderer and a few main-process shortcut tables; no protocol, server, or daemon change.

Conventions: pure logic lives in plain `.ts` modules next to their callers in
`apps/desktop/src/renderer/components/workbench/`, with `node:test` tests in a sibling
`*.test.ts` (see `command-palette-recent.ts` / `command-palette-recent.test.ts`). Modules that
persist take storage and key as arguments and never import `@/config` or touch `localStorage`
themselves (the module comment in `command-palette-recent.ts` explains why: `@/config` needs the
desktop bridge at evaluation time and Node has no `localStorage`). Storage keys are declared in
`apps/desktop/src/renderer/config.ts` with a doc comment, server-scoped as
`` `coflux_<name>:${SERVER_URL}` ``. Tooltips use the Astryx `Tooltip` component, never a native
`title` (`docs/design-guidelines.md`). UI copy is Simplified Chinese; code comments English. The
sidebar's visual vocabulary (row heights `h-7`/`h-8`, `text-base`/`text-sm`, `text-muted-foreground`,
`ActivityDots`) is reused as is.

Product rules the code must hold (restated from the requirement):

- 「当前」 = workspaces with a non-idle `workspaceActivity` status (`active`, `approval`,
  `question`, `error`, `done`) ∪ up to 5 further workspaces on screen within the last 24 hours;
  directory workspaces (`isDirWorkspace`) and archived ones (`isWorkspaceArchived`) never qualify.
- Order = tree order. Rows never swap; only membership changes.
- Section hidden when empty and before the first snapshot (`snapshotRevision > 0`).
- 「待处理」 = `approval`, `question`, `error`.

### Milestone 1: The 「当前」 derivation and visit-time store exist and are tested

Depends on: none

#### T1 · Tree order is one shared function

- Where: `apps/desktop/src/renderer/components/workbench/sidebar.tsx` — `const workspacesOf = (projectId: string) =>` and the `projects` line `.filter((project) => !isProjectArchived(project))`
- Change: move the ordering rule into a pure, exported function in a new module (for example `workspace-order.ts` or inside the T3 module) and make the sidebar's tree use it. (D2)
- After: the tree renders exactly the same order as before — visible projects in store order; within a project the main workspace first, then the rest by ascending `createdAt`. The new module is importable from Node tests (no `@/config`, no React).
- Don't: write a second copy of the sort for the section (D2).

#### T2 · Visit-time store

- Where: new `apps/desktop/src/renderer/components/workbench/workspace-visits.ts` (+ `workspace-visits.test.ts`); key in `apps/desktop/src/renderer/config.ts` next to `COMMAND_PALETTE_RECENT_KEY`
- Change: a pure module that reads and writes workspace id → last-on-screen epoch ms, storage and key injected; a new server-scoped key constant with a doc comment. (D3)
- After: reading tolerates missing, malformed or non-object stored values and throwing storage by returning an empty record (same failure posture as `readRecentPlaces`); writing is best-effort and never throws; entries older than the window can be pruned on write so the record stays small. Tests: write then read returns the time; garbage in storage → empty; a throwing `setItem` does not throw.
- Don't: change `command-palette-recent.ts` or the `coflux_recent_places` format (D3).

#### T3 · The 「当前」 derivation

- Where: new `apps/desktop/src/renderer/components/workbench/current-workspaces.ts` (+ `current-workspaces.test.ts`)
- Change: a pure function from (projects, workspaces, daemons, tasks, sessionAgents, visit times, selected workspace id, now) to the ordered list of 「当前」 rows; each row carries the workspace, its project, and its `workspaceActivity` result (status, agent, message, taskId). Use `workspaceActivity`, `isDirWorkspace`, `isWorkspaceArchived` from `@coflux/client` and the T1 order. (D1, D2, D5)
- After, tested as input → expected:
  - a workspace with `active` / `approval` / `question` / `error` / `done` is a member; `idle` alone is not;
  - a workspace on an offline daemon has idle activity (that is what `workspaceActivity` returns) and qualifies only by recency;
  - recent slots: among eligible workspaces not already members by activity, those with a visit time within 24 h of `now` (the selected one counts as `now`, D4), the 5 most recent; a 6th drops out; one at 24 h + 1 ms drops out;
  - the selected workspace is always a member (when eligible);
  - directory and archived workspaces are never members, even when active or selected;
  - output order equals tree order regardless of activity or visit time: changing a member's status from `active` to `approval` leaves the order unchanged;
  - no workspaces → empty list.
- Don't: sort by activity or by recency anywhere in the output (D1).

### Milestone 2: The sidebar shows 「当前」 and remembers collapse state

Depends on: Milestone 1

#### T4 · 「当前」 section in the sidebar

- Where: `apps/desktop/src/renderer/components/workbench/sidebar.tsx` — inside `<section className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">`, before the 「项目」 header row (`<span className="text-sm text-muted-foreground">项目</span>`)
- Change: render a 「当前」 header and one row per T3 row, fed by the T3 function; the sidebar receives the visit times, the current time, and anything else T3 needs through props or store reads. Extract the tree's workspace row (icon slot, tooltip content, context menu) into a shared component or function so the section row reuses it. (D1)
- After: the header reads exactly `当前`, styled like the 「项目」 header (without its import button). Each row: same icon slot as the tree row, label as the tree row's branch text, the project name in `text-sm text-muted-foreground` truncated on the right, the tree row's `Tooltip` content and `ContextMenu`; click selects the workspace through `onSelectWorkspace`; selected row uses the tree's selected style, and the same workspace's tree row is highlighted too. The section (header included) is absent when the list is empty or `snapshotRevision === 0`. A section row has no hover × delete button — deletion stays in the tree row and its context menu. The 「当前」 rows live in the same scroll container as the tree.
- Don't: hide the workspace from the tree while it is in 「当前」; don't reorder rows by activity.

#### T5 · Visit times are recorded

- Where: `apps/desktop/src/renderer/components/workbench/workbench.tsx` — the effect `useEffect(() => { if (visitedPlaceKey) recordRecentPlace(RECENT_PLACES_STORE, visitedPlaceKey); }, [visitedPlaceKey]);`
- Change: when the selection moves off a workspace (to another workspace, a device, a screen, or to nothing), write that workspace's leave time to the T2 store; keep the ⌘P recording as it is. Keep the visit record in React state so the sidebar re-renders when it changes, and give the sidebar a current time that advances so a 24-hour expiry takes effect without a reload. (D4)
- After: switching A → B stores A's time = the moment of leaving; B, while selected, counts as now via T3; restarting the app with A selected shows A in 「当前」 regardless of its stored time; a workspace left more than 24 h ago with no agent disappears from 「当前」 within about a minute of crossing the boundary, without user input.
- Don't: stamp the time on entry only (D4).

#### T6 · Project collapse state persists, collapsed by default, with a summary on collapsed rows

- Where: `apps/desktop/src/renderer/components/workbench/sidebar.tsx` — `const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());`, `function toggleProject`, the project row `<button ... onClick={() => toggleProject(project.id)} title={project.repoPath}>`; new server-scoped key in `config.ts`
- Change: replace the in-memory collapsed set with a persisted expanded set (storage and key injected, a small pure module with a test is fine); a project is expanded only when its id is in the set. On a collapsed project row, show the highest-priority activity among its workspaces in the trailing slot, priority `approval` > `question` > `error` > `active` > `done`, and a `Tooltip` summarising it. Replace the native `title={project.repoPath}` with the Tooltip, which also shows the repo path. (D6)
- After: first launch after the change shows every project collapsed; expanding project X and restarting shows X expanded and the rest collapsed; a newly imported project appears collapsed. A collapsed row whose workspaces are idle shows no dots (the existing offline grey dot rule stays). Tooltip wording: when any workspace is 待处理, a line `N 个工作区待处理`; otherwise when any is active, `<agent> 正在执行` (the `activityLabel` wording); otherwise when any is done, `<agent> 本轮完成`; plus the repo path line. An expanded row shows no aggregated dots (its rows already do). Selecting a workspace in a collapsed project does not expand it.
- Don't: persist the collapsed set (D6); don't auto-expand on selection.

### Milestone 3: 「下一个待处理」 (⌘⇧A)

Depends on: Milestone 1 (uses T3); independent of Milestone 2 except that both edit `workbench.tsx`

#### T7 · Command, menu, browser forwarding, help

- Where: `apps/desktop/src/shared/desktop-bridge.ts` — `export type DesktopCommand =`; `apps/desktop/src/main/menu.ts` — the 视图 submenu after `pageShortcut("显示/隐藏侧边栏", "CmdOrCtrl+B", "toggle-sidebar"),`; `apps/desktop/src/main/browser-policy.ts` — `classifyGuestKey`'s `if (withShift) {` block (and `browser-policy.test.ts`); `apps/desktop/src/renderer/components/workbench/dialogs.tsx` — `function shortcutRows()` (D7)
- Change: add a command (for example `"next-attention"`) with a doc comment; a display-only `pageShortcut("下一个待处理", "Shift+CmdOrCtrl+A", …)` in 视图; `classifyGuestKey` maps ⌘⇧`KeyA` to that command; a help row `{ keys: ["⇧", ...mod, "A"], description: "跳到下一个待处理的工作区" }` placed after the ⌘P row.
- After: `browser-policy.test.ts` asserts ⌘⇧A → the new command and that ⌘A (bare) is still unclassified (`null`).
- Don't: register the accelerator (`registerAccelerator` stays false via `pageShortcut`).

#### T8 · The shortcut walks 「当前」

- Where: `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts` — the `if (withShift) {` branch (`// ⌘⇧\ splits downward.`) and the `desktop.onCommand` switch; `workbench.tsx` — `function landOnTask(taskId: string): boolean`
- Change: ⌘⇧A (keyboard) and the new command (menu / browser forwarding) call one handler supplied by the workbench. The handler derives 「当前」 through T3 at the moment of the press, takes the 待处理 rows (`approval`, `question`, `error`), and picks the first one after the selected workspace in list order, wrapping; when the selected workspace is the only 待处理 one, it is picked. It lands with `landOnTask(row.activity.taskId)`, or `selectWorkspace` when there is no task id. With no 待处理 rows it does nothing. (D1, D7)
- After: the suspension rule matches the other workbench shortcuts (ignored while an overlay suspends them); the ⇧ branch still splits on ⌘⇧\ and still ignores everything else; a test of the picking rule (pure, for example exported from `current-workspaces.ts`) covers: next after selected, wrap-around, selected-only, none → no target.
- Don't: build the cycle from `attentionSnapshot` (D1).

### Your call

- Module and component names, file split, prop shapes, and whether the expanded-set store and the
  visit store share a helper.
- How the current time advances (a minute tick or a timer to the next expiry), as long as T5's
  "within about a minute" holds and idle sidebars do not re-render more than once a minute.
- Pruning policy for both stores (stale ids, old visits), and the storage value formats.
- Exact visual spacing of the 「当前」 section within the sidebar vocabulary listed in Goal.

### Landmines

- `sidebar.tsx` is one large component; extracting the workspace row (T4) must keep the tree row's
  behaviour byte-for-byte: the hover × delete button for non-main workspaces, the diff mask on
  hover, the 「创建中」 pending rows, `group/workspace` hover classes.
- `workbench.tsx` records the ⌘P visit in an effect keyed on `visitedPlaceKey`, declared after the
  terminal-visit effect on purpose (see its comment); keep that order when adding T5.
- CI lints `src/renderer` with oxlint; write code that passes it (no unused imports or variables
  left behind by the T4 extraction).

### Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`
- `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts`
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx`
- new modules and tests under `apps/desktop/src/renderer/components/workbench/`
- `apps/desktop/src/renderer/config.ts`
- `apps/desktop/src/shared/desktop-bridge.ts`
- `apps/desktop/src/main/menu.ts`
- `apps/desktop/src/main/browser-policy.ts`, `apps/desktop/src/main/browser-policy.test.ts`

Out of scope:
- `packages/client`, `packages/protocol`, `crates/**`, `apps/server`, `apps/ios` — no protocol, store, or server change; `workspaceActivity` is used as is.
- `command-palette-recent.ts`, `command-palette-data.ts`, `command-palette.tsx` — ⌘P behaviour unchanged.
- `desktop-attention.ts` and notification/badge behaviour — unchanged.
- `terminal-key-ownership.ts` — ⌘⇧ chords already go to the app.
- The 设备 section of the sidebar.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- ⌘⇧A turns out to be taken by something in the app or by xterm handling in this codebase.
- Keeping the tree order unchanged (T1) conflicts with how the store orders projects or workspaces.

## Verification

### Milestone validations

- Milestone 1: `pnpm -C apps/desktop test` -> exit 0, including the new `workspace-visits.test.ts` and `current-workspaces.test.ts`
- Milestone 2: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop lint` -> exit 0
- Milestone 3: `pnpm -C apps/desktop test` -> exit 0, including the new `browser-policy.test.ts` cases and the picking-rule test

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Lint | `pnpm -C apps/desktop lint` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` — by the user, per the desktop-preview skill | the observations listed under Requirement hold |

### Done criteria

- [ ] All listed commands pass (the walkthrough is the user's).
- [ ] Every task's `After` state holds.
- [ ] The diff shows one ordering function used by both tree and 「当前」 (D2), and the shortcut reading the T3 output (D1).
- [ ] The ⌘P recent-places module and key are untouched (D3).
- [ ] Collapse persistence stores the expanded set (D6).
- [ ] Copy is exactly 「当前」, 「下一个待处理」, `N 个工作区待处理`.
- [ ] No native `title` added; new tooltips use `Tooltip`.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

Desktop-only; ships with the next `v*` release. No server deployment, migration, or environment
change. Release notes should mention that the sidebar now opens with projects collapsed (one-time
change of the user's view) and the new ⌘⇧A 「下一个待处理」 shortcut. UI walkthrough is by the user;
Claude does not verify frontend behaviour.

## Outcome

- Status: APPROVE — 2026-11-09
- Mode: subagent(opus), one work package (milestones 2 and 3 both depend on milestone 1 and share `workbench.tsx`); no revision rounds
- Commits: `f70cb6ed..7b27d9dd`
- Deviations: the tree row's hover × keeps its pre-existing native `title="删除工作区"` (the brief required the tree row unchanged); the project row's native `title` was replaced by a `Tooltip` as planned
- Follow-ups: the UI walkthrough (`pnpm dev:desktop:prod`) is the user's; a directory workspace whose agent waits is not reached by ⌘⇧A (see Maintenance notes)
- Verification: `pnpm -C apps/desktop typecheck`, `lint`, `build` exit 0; `test` 587/587 (one unrelated timing flake in `src/main/desktop-account.test.ts` on the first run, green on rerun and three isolated reruns)
