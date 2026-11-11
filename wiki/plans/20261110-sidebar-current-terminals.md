# Plan 20261110-sidebar-current-terminals: 「当前」 lists live agent terminals, not workspaces

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat baf81522..HEAD -- apps/desktop/src/renderer/components/workbench apps/desktop/src/renderer/config.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/main/menu.ts apps/desktop/src/main/browser-policy.ts packages/client/src/store.ts`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: wiki/plans/20261109-sidebar-current-section.md (DONE, released in 2.25.0)
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check
- Workspace: isolated — the previous worktree was gone after PR #130 merged; a new worktree `.claude/worktrees/20261110-sidebar-current-terminals` on `dev/20261110-sidebar-current-terminals` was cut from `origin/main` (`baf81522`, v2.25.0)
- Planned at: `baf81522`, 2026-11-10

## Record

### Requirement

Plan 20261109-sidebar-current-section put a 「当前」 section at the top of the desktop sidebar listing
*workspaces* (any with agent activity, plus up to 5 visited in the last 24 hours). The user's
verdict after using it: the top should show the **live agent terminals**, not workspaces. The unit
of "what I am working on" is the agent conversation, and a workspace holding two agents is two
things to watch.

Product conclusions (confirmed by the user):

- **Membership**: a terminal is listed while its agent is present — a RUNNING task whose session has
  a presence entry in state 执行中 / 待批准 / 待回答 / 出错 / 本轮完成. It drops out when the agent
  exits or the terminal closes. Plain shell terminals are never listed. Terminals in a device's `~`
  directory workspace are listed like any other. A terminal on an offline device is not listed
  (presence there is neutral, as everywhere else).
- **Recency is gone**: the 24-hour / 5-slot workspace visit list is removed with its storage; recency
  is ⌘P's job.
- **Row**: agent logo + terminal title (the agent's OSC title when set, else the tab title, else 「终端」)
  + grey 「项目 · 分支」 (device name for `~` terminals) + trailing status dots. Hover shows the full
  title, the location, the status line and the agent's message / progress.
- **Order**: stable, following the tree — projects → workspaces (tree order) → terminals by creation
  time; device `~` terminals after all project terminals, in device-list order. Status changes never
  move a row.
- **Click** lands on that terminal. The terminal currently on screen is highlighted. Rows have no
  context menu and no ×.
- **⌘⇧A 下一个待处理** cycles through 待处理 *terminals* (approval / question / error); two waiting
  agents in one workspace are two stops. `~` terminals are reachable.
- The section is absent when no agent terminal is live, and before the first snapshot.
- The project tree (collapsed by default, persisted expansion, aggregated dots on collapsed rows) is
  unchanged.

Observable acceptance: with two Claude sessions in one workspace and one Codex in a `~` terminal,
「当前」 shows three rows titled with each conversation's topic; when one Claude waits for approval
its row's dots change in place; ⌘⇧A lands on that exact tab; quitting an agent removes its row;
with no agent running there is no 「当前」 header.

### Decisions & tradeoffs

- **D1 · Per-terminal derivation, one source for list and shortcut.** A pure function derives the
  rows from store state (projects, workspaces, daemons, tasks, sessionAgents, sessionMetadata); both
  the sidebar and ⌘⇧A use it. Rejected: reusing `workspaceActivity` (it collapses a workspace to one
  winner and would hide the second waiting agent); building the cycle from the notification
  snapshot (same reason as the previous plan's D1 — the list and the shortcut must agree).
- **D2 · Per-terminal status vocabulary = `WorkspaceActivity`'s.** Each row carries an activity of the
  existing `WorkspaceActivity` shape (`active` / `approval` / `question` / `error` / `done`, an old
  worker's `waiting` read as `done`), so `ActivityDots` and the existing `activityLabel` wording are
  reused unchanged. Rejected: a new status type, which would fork the copy.
- **D3 · Remove the visit store entirely** (`workspace-visits.ts`, its test, `WORKSPACE_VISITS_KEY`, the
  leave-stamping effect, the `workspaceVisits` prop, the minute clock). Product decision; leaving
  dead code would mislead. The stale `coflux_workspace_visits:*` localStorage value is simply
  abandoned (tiny, never read).
- **D4 · Order is structural, never by status or time-of-activity.** Project terminals follow the tree
  (the shared `sidebarTree` order), terminals within a workspace by `createdAt` ascending (tab-strip
  order is per-machine layout state and changes on drag; creation order is stable and the same
  everywhere). `~` terminals follow, by `daemons` order.
- **D5 · "On screen" = the active tab of the focused group in the workspace the main area shows** —
  the selected workspace, or the device's canonical directory workspace when a device is selected.
  The workbench owns layouts, so it computes this id and passes it down. ⌘⇧A starts its cycle after
  that terminal.
- **D6 · Title source = the tab's.** `sessionMetadata[sessionId].title || task.title || "终端"`, the same
  precedence the terminal tab uses (`workspace-terminal.tsx`), so the row and the tab read alike.
- **D7 · Logo = by the presence entry's agent id**: `AgentLogo` for known `AgentId`s (`isAgentId`),
  the lucide `Bot` otherwise. Static logo on the left; status lives in the trailing dots. Rejected:
  the tab's animated Clawd poses in the sidebar — status would be shown twice.
- (decided while planning) Help-dialog copy becomes 「跳到下一个待处理的终端」; menu label 「下一个待处理」
  is unchanged. The `next-attention` command, the menu item and the browser-forwarding entry stay.

### Discussion log

- Trigger: after PR #130 shipped in 2.25.0, the user: 「我感觉应该置顶展示当前活跃的agent terminal 而非工作区」.
- Q: which terminals are listed? Options: agent still present (recommended) / only 执行中 and 待处理 /
  agent terminals + recently used plain terminals. Answer: **agent still present**.
- Q: the 24 h / 5 recent workspaces? Options: remove (recommended) / keep as a second group. Answer:
  **remove**.
- Q: row's primary text? Options: terminal title first, workspace secondary (recommended) /
  workspace first. Answer: **terminal title first**.
- Q: device `~` terminals? Options: include (recommended) / exclude. Answer: **include**.
- Product confirmation (membership, row, order, click/highlight, ⌘⇧A per terminal, tree unchanged):
  **confirmed**.
- Departure check: execution **subagent(opus)**; **plain autopilot**.

### Maintenance notes

- If a row ever needs per-terminal recency again, it is a new store keyed by task id; do not revive
  the workspace visit store.
- The agent's presence entry is the only membership signal. Never infer an agent from a title.

## Execution brief

> Written for `subagent(opus)` at `baf81522`. Implement the milestones in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

Change the desktop sidebar's 「当前」 section from a list of workspaces to a list of live agent
terminals, remove the workspace visit-time machinery it used, and make ⌘⇧A 「下一个待处理」 cycle
through waiting terminals. Desktop renderer only (plus one help-dialog string); no change to
`packages/client`, protocol, server or daemon.

Conventions: pure logic in plain `.ts` modules under
`apps/desktop/src/renderer/components/workbench/` with `node:test` tests in a sibling `*.test.ts`
(Chinese test names, as in `current-workspaces.test.ts`). Pure modules never import `@/config`,
React, or touch `localStorage`. Tooltips use the Astryx `Tooltip`, never a native `title`. UI copy
Simplified Chinese, comments English. Reuse the sidebar's vocabulary: row `h-7`, `text-base` /
`text-sm`, `text-muted-foreground`, selected `bg-accent text-foreground`, unselected
`text-secondary-foreground hover:bg-accent/70 hover:text-foreground`, `ActivityDots`.

Product rules the code must hold:

- Member = a task with `status === TaskStatus.RUNNING`, a `sessionId`, whose
  `sessionAgents[sessionId]` exists with `state` in `active | approval | question | error | done |
  waiting` (`waiting` is shown as `done`), whose workspace exists, is not archived
  (`isWorkspaceArchived`), and whose daemon is online. Directory workspaces (`isDirWorkspace`) are
  included. Anything else is not a member.
- Order: project workspaces in `sidebarTree(projects, workspaces)` order, then directory workspaces
  grouped by device in `daemons` order (within a device, directory workspaces by `createdAt`);
  within any workspace, member tasks by `createdAt` ascending (tie: `id`). Never by status or time.
- 「待处理」 = `approval`, `question`, `error`.
- Section hidden when the list is empty and before the first snapshot (`snapshotRevision > 0`).

### Milestone 1: The per-terminal derivation replaces the workspace one; the visit store is gone

Depends on: none

#### T1 · `current-terminals.ts` replaces `current-workspaces.ts`

- Where: delete `current-workspaces.ts` and `current-workspaces.test.ts`; new
  `current-terminals.ts` + `current-terminals.test.ts` in the same directory. Reuse
  `sidebarTree` from `workspace-order.ts`; `isDirWorkspace`, `isWorkspaceArchived`,
  `type SessionAgentState`, `type WorkspaceActivity` from `@coflux/client`; `TaskStatus` and types from
  `@coflux/protocol`.
- Change: export a function from (projects incl. archived, workspaces, daemons, tasks,
  sessionAgents, sessionMetadata titles) to ordered rows. Each row carries: the task, the workspace,
  the project (`null` for a directory workspace), the daemon, the agent id string, the resolved
  title (D6: `sessionMetadata[sessionId]?.title || task.title || "终端"`), and an activity of type
  `WorkspaceActivity` built from the presence entry (D2: `agent`, `message` when non-empty, `taskId`
  for approval/question/error). Also export `needsAttention(row)` and
  `nextAttentionRow(rows, onScreenTaskId)` — the first 待处理 row after the row whose task id is
  `onScreenTaskId`, wrapping; that row itself only when it is the sole 待处理 one; with no match for
  `onScreenTaskId`, the first 待处理 row; `null` when none. (D1, D4)
- After, tested as input → expected:
  - each of `active`/`approval`/`question`/`error`/`done` is a member; `waiting` is a member shown as `done`;
    an unknown state string and a missing presence entry are not;
  - a non-RUNNING task, a task without `sessionId`, a task on an offline daemon, a task whose
    workspace is archived (archived project) or missing → not a member;
  - a task in a directory workspace is a member with `project === null`, ordered after every
    project terminal, devices in `daemons` order;
  - two member tasks in one workspace → two rows ordered by `createdAt`; changing one's state from
    `active` to `approval` leaves the order unchanged;
  - title precedence: metadata title > task title > 「终端」;
  - `nextAttentionRow`: next after on-screen, wrap-around, on-screen-only, two waiting in one
    workspace are two distinct stops, no 待处理 → `null`;
  - no tasks → empty list.
- Don't: call `workspaceActivity` per row (D1); sort by status anywhere.

#### T2 · Remove the workspace visit store

- Where: `workspace-visits.ts`, `workspace-visits.test.ts` (delete); `apps/desktop/src/renderer/config.ts` —
  `export const WORKSPACE_VISITS_KEY`; `workbench.tsx` — `WORKSPACE_VISIT_STORE`, `const [workspaceVisits,
  setWorkspaceVisits]`, the effect commented `// The sidebar's 「当前」 section (plan 20261109-sidebar-current-section) stamps a workspace when`
  (with `onScreenWorkspaceId` / `onScreenWorkspaceRef`), the `workspaceVisits={workspaceVisits}` prop, and the imports. (D3)
- After: no reference to `workspace-visits`, `WORKSPACE_VISITS_KEY`, `recordWorkspaceVisit`,
  `readWorkspaceVisits` or `RECENT_VISIT_WINDOW_MS` remains anywhere under `apps/desktop/src`. The ⌘P
  `visitedPlaceKey` effect directly above is untouched.

### Milestone 2: The sidebar lists terminals; ⌘⇧A walks them

Depends on: Milestone 1

#### T3 · Terminal rows in the 「当前」 section

- Where: `sidebar.tsx` — the block commented `{/* 「当前」 (plan 20261109-sidebar-current-section): in tree order, never re-sorted; the`,
  `const currentRows =`, the minute clock (`CURRENT_CLOCK_TICK_MS`, `const [now, setNow]` and its
  effect), the `workspaceVisits` prop, and the `WorkspaceRow` component's `variant` prop.
- Change: feed the section from T1. Add a terminal row component; give the sidebar new props for the
  on-screen task id and for landing on a task (the workbench's `landOnTask`). Subscribe to the
  store's `sessionMetadata` titles narrowly (a selector that only extracts titles of member
  sessions, compared shallowly with `useShallow`, as `workspace-terminal.tsx` does for
  `checkpointTitles`) so unrelated metadata churn does not re-render the sidebar. Since the section
  no longer uses `WorkspaceRow`, drop its `variant` prop and the `"current"` branch so the tree row is
  exactly the tree row again. (D5, D6, D7)
- After:
  - Header reads exactly `当前`, unchanged styling. One row per T1 row, `h-7`, in the same scroll
    container as the tree.
  - Row content left → right: logo (`AgentLogo` for `isAgentId(agent)`, else `Bot`, `size-3`,
    `opacity-70`); title `min-w-0 flex-1 truncate text-base`; location `max-w-28 shrink-0 truncate
    text-sm text-muted-foreground` reading `${project.name} · ${workspace.branch}` for project
    terminals and the device name for directory terminals; trailing `ActivityDots` for the row's
    status (labelled with `activityLabel`).
  - Selected style when the row's task id equals the on-screen task id; otherwise the unselected style.
  - Click calls the land-on-task prop with the row's task id. No `ContextMenu`, no × button.
  - `Tooltip` (placement `end`, `hasHoverIndication={false}` like the tree row) with: the full title
    (bold), the status line (`ActivityDots` + `activityLabel`), the agent message for
    approval/question/error (same block as the workspace tooltip), the progress line when the
    presence entry has `progress`, and the location line (project · branch, or device name) with the
    workspace path.
  - Section absent when no rows or `snapshotRevision === 0`.
  - The tree row (`WorkspaceRow`) renders and behaves exactly as before for the tree.
- Don't: hide anything from the tree; reuse the animated tab glyph (D7).

#### T4 · Workbench wiring: on-screen terminal and ⌘⇧A

- Where: `workbench.tsx` — `function goToNextAttention()` and its doc comment, `function landOnTask`,
  `const activeWorkspace = selection?.kind === "device" ? canonicalDirWorkspaceOf(selection.id) : selectedWorkspace;`,
  the `<Sidebar` props; `dialogs.tsx` — `description: "跳到下一个待处理的工作区"`; doc comments mentioning
  the workspace cycle in `use-global-shortcuts.ts` (`* ⌘⇧A and 「视图 → 下一个待处理」`) and
  `apps/desktop/src/shared/desktop-bridge.ts` (`* ⌘⇧A / 视图 → 下一个待处理`).
- Change: compute the on-screen task id (D5) — the active tab of the focused group in
  `activeWorkspace`'s layout (`focusedGroup(layoutOf(id)).activeTabId` or the existing equivalent
  helper), `null` when there is no active workspace or the active tab is not a task tab
  (`isTaskTabId`) — and pass it plus `landOnTask` to the sidebar. Rewrite `goToNextAttention` to derive
  T1 rows from `client.store.getState()` at the moment of the press, pick with
  `nextAttentionRow(rows, onScreenTaskId)`, and `landOnTask(row.task.id)`. Help copy becomes exactly
  `跳到下一个待处理的终端`. Update the two doc comments to say terminal. (D1, D5)
- After: with nothing waiting, ⌘⇧A does nothing; with two waiting terminals in the same workspace,
  two presses visit both; a waiting `~` terminal is reached (landOnTask selects the device for the
  canonical directory workspace). The menu item, the `next-attention` command, the browser
  forwarding and the shortcut's suspension rule are unchanged. `goToNextAttention` reads layouts
  through the same accessor the rest of the workbench uses at event time (not a stale render
  closure).

### Your call

- Module, component and prop names; whether the row shape carries the daemon or the sidebar looks it up.
- Exact spacing within the vocabulary above.
- Whether `activityLabel` moves to a shared spot or stays in `sidebar.tsx`.

### Landmines

- `sidebar.tsx` is one large component: removing the `"current"` variant must leave the tree row's
  hover × (non-main), diff mask, custom-name label and pending rows exactly as they are.
- `sessionMetadata` changes often (checkpoints); subscribing to the whole map in the sidebar would
  re-render it on every checkpoint — use the narrow shallow selector.
- CI lints `src/renderer` with oxlint; leave no unused imports after the deletions (`LoaderCircle`,
  `MessageSquare`, `ContextMenu` etc. are still used by the tree row — check before removing).

### Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`
- `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts` (comment only)
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx` (one string)
- `apps/desktop/src/renderer/components/workbench/current-workspaces.ts`, `current-workspaces.test.ts` (deleted)
- `apps/desktop/src/renderer/components/workbench/workspace-visits.ts`, `workspace-visits.test.ts` (deleted)
- new `current-terminals.ts`, `current-terminals.test.ts` in the same directory
- `apps/desktop/src/renderer/config.ts`
- `apps/desktop/src/shared/desktop-bridge.ts` (comment only)

Out of scope:
- `packages/**`, `crates/**`, `apps/server`, `apps/ios`.
- `project-rows.ts`, `workspace-order.ts` — reused as is; tree behaviour unchanged.
- `workspace-terminal.tsx` — the tab strip is unchanged.
- `main/menu.ts`, `main/browser-policy.ts` — the command and its forwarding are unchanged.
- ⌘P (`command-palette-*`), notifications and the Dock badge (`desktop-attention.ts`).

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- The on-screen tab cannot be derived from the workbench's layout state as described.
- Two tasks contradict each other, or a task contradicts the code it changes.

## Verification

### Milestone validations

- Milestone 1: `pnpm -C apps/desktop test` -> exit 0, including `current-terminals.test.ts`; `grep -rn "workspace-visits\|WORKSPACE_VISITS_KEY\|current-workspaces" apps/desktop/src` -> no output
- Milestone 2: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop lint` -> exit 0

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Lint | `pnpm -C apps/desktop lint` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` — by the user | the observable acceptance under Requirement holds |

### Done criteria

- [ ] All listed commands pass (the walkthrough is the user's).
- [ ] Every task's `After` state holds.
- [ ] One derivation feeds both the sidebar and ⌘⇧A (D1); no `workspaceActivity` call in it.
- [ ] The visit store and its key are gone (D3); ⌘P recording untouched.
- [ ] Rows ordered structurally (D4); highlight follows the on-screen tab (D5).
- [ ] Copy: `当前`, `跳到下一个待处理的终端`; no native `title` added.
- [ ] `WorkspaceRow` has no `variant` left and the tree row is unchanged.
- [ ] Tests assert behaviour and would fail without the change.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

Desktop-only; ships with the next `v*` release. No server deployment or migration. Release notes:
「当前」 now lists agent terminals (each agent conversation is its own row; ⌘⇧A visits each waiting
terminal); the 24-hour recent workspaces are gone. Walkthrough is the user's.

## Outcome

DONE on `dev/20261110-sidebar-current-terminals` (implementation `0dc5b088`, `b2223a3b`; baseline
`176bfdfe`). Executed by subagent(opus) in one package, no revision rounds.

- `current-terminals.ts` (+ test) replaces `current-workspaces.ts`; `workspace-visits.ts` (+ test)
  and `WORKSPACE_VISITS_KEY` are gone. One derivation feeds the sidebar and ⌘⇧A; it never calls
  `workspaceActivity`. An extra helper, `candidateSessionTitles`, backs the sidebar's shallow title
  selector and the shortcut.
- The sidebar's 「当前」 renders `TerminalRow`s; `WorkspaceRow` lost its `variant` and is the tree row
  only. The highlight follows the focused group's active task tab of the shown workspace (also while
  the changes overlay is open, as D5 reads).
- Gates: `pnpm -C apps/desktop typecheck`, `lint`, `test` (600/600; 602 at baseline — the two
  removed modules' tests out, the new suite in), `build` all green. The first commit alone does not
  typecheck (the second completes it); the branch tip does.
- Not verified here: the UI walkthrough (`pnpm dev:desktop:prod`) is the user's.
- The stale `coflux_workspace_visits:<server>` localStorage value is left unread on users' machines.
