# Plan 20261115-ios-current-section: the iOS home and sidebar open on 「当前」, with collapsed projects

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ed90eb1d..HEAD -- apps/ios apps/desktop/src/renderer/components/workbench/current-terminals.ts apps/desktop/src/renderer/components/workbench/workspace-order.ts apps/desktop/src/renderer/components/workbench/project-rows.ts`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self — departure check (2026-11-15)
- Stop after: implementation — departure check, plain autopilot
- Plan review: none — the orchestrator is already on the top tier, so the audit was not offered
- Workspace: isolated — cut from the main worktree as `dev/20261115-ios-current-section`
- Planned at: `ed90eb1d`, 2026-11-15

## Record

### Requirement

The desktop sidebar is now three sections — 「当前」 (live agent terminals), 「项目」 (collapsed by
default) and 「设备」. The iOS app still shows 「待处理」 (only agents waiting for approval or an
answer, and secret requests), then every project with all of its workspaces laid out flat, then
the devices. An agent that is running or has just finished has no entry of its own on the phone,
and with about 22 projects the list is long. The iOS home (outer display) and sidebar (inner
display, wide and tall) follow the desktop.

Product conclusions, confirmed by the owner:

- **Structure.** The outer-display home and the inner-display sidebar show 「当前 / 项目 / 设备」;
  on the outer display 「设备」 stays in its own tab and is not part of the home.
- **「当前」 replaces 「待处理」.**
  - Members and order as on the desktop: a terminal whose device is online, whose task is
    running, and whose agent reports approval, question, error, active or done (an old
    `waiting` reads as done). Order is the tree's — visible projects in store order, the main
    workspace first then by creation time, then directory workspaces by device, terminals by
    creation time — and never changes with state.
  - In addition, a running terminal with a pending secret request is a member even when it has
    no agent state.
  - A row is two lines: the agent glyph (Clawd's pose; a finished turn already seen stops the
    confetti) and the terminal's title (the program's title, else the task's, else 「终端」);
    below, the state with the agent's message or progress, then 「项目 · 分支」 (the device name
    for a directory workspace). A row that waits for the user is in the warning tone, an error
    in the destructive tone.
  - A secret request shows as 「等待输入 X」 on its terminal's row. Tapping it opens the terminal
    and the input sheet, as today.
  - The section is absent when it has no rows and before the first snapshot.
  - Badges (the 首页 tab, the tall layout's sidebar button) count only rows that wait for the
    user: approval, question, error, or a pending secret request.
- **Outer display.** The paged card row is removed; it uses the same rows as the sidebar.
- **「项目」.** A project is a tappable row, collapsed by default; the expanded set is remembered
  on the device. Workspace rows keep their two-line form. A collapsed row ends with a summary:
  「N 待处理」 when workspaces wait for the user, else the highest activity among them; a hollow
  dot when the device is offline. Showing a workspace — from 「当前」 or anywhere else — expands
  its project and brings its row into view, highlighted where the layout has a selection.
  Projects without workspaces stay unlisted; the 「暂无项目」 empty state is unchanged.
- **「设备」** in the sidebar is unchanged.
- **Not done.** Draggable section dividers, independently scrolling sections (each page keeps
  one scroll), a mobile counterpart of ⌘⇧A, entries for creating a workspace or importing a
  project, any desktop change.
- **Observable when done.** In all three forms 「当前」 lists the terminals the desktop lists, in
  the same order; tapping a row lands on that terminal; an agent that starts waiting turns its
  row to the warning tone and raises the badge; projects are collapsed on first launch and the
  expanded set survives a relaunch; a jump expands and reveals.

### Decisions & tradeoffs

- **D1 One derivation, mirrored from the desktop.** 「当前」 rows come from one pure function over
  the client's projects, workspaces, daemons, tasks, agent presence, titles and secret requests,
  following `apps/desktop/src/renderer/components/workbench/current-terminals.ts` and
  `workspace-order.ts` rule for rule, plus the secret-request member. The badge count is the
  number of its rows that need attention. Rejected: keeping `WaitingItems` beside it for the
  badge — two derivations of "who waits" would drift. Based on: `current-terminals.ts:54-83`,
  `workspace-order.ts:17-26`, `apps/ios/Coflux/Views/WaitingItems.swift`.
- **D2 Attention = approval, question, error, pending secret.** Error joins the badge, as on the
  desktop (`current-terminals.ts:105`). Rejected: the old iOS set without error — an agent that
  stopped on an error needs the user as much as one that asks. Based on: owner's answer.
- **D3 Secret-only terminals are members.** A running task on an online device with a pending
  secret request is a row even with no presence entry; its glyph is the plain terminal mark.
  Rejected: desktop's exact membership — the request would then be invisible on the home.
  Based on: owner's answer; `WaitingItems.swift:73-83` listed secret requests without an agent.
- **D4 One set of views for both surfaces.** The current-terminal row, the project row and its
  workspace rows are shared by the outer home and the sidebar; a surface only supplies its
  container (scroll stack or list) and insets. Rejected: per-surface copies, as the 待处理 card
  and row were. Based on: `HomeComponents.swift` already shares `WorkspaceRowContent`.
- **D5 Expanded projects live in `UserDefaults`.** One array of project ids under one key, read
  by every window and both surfaces; ids of projects that no longer exist are dropped on write.
  Absent or unreadable means none expanded. Rejected: per-window state in `SceneNavigation` —
  it would not survive a relaunch. Based on: `project-rows.ts:21-52`.
- **D6 Reveal hangs off the single jump entry.** `SceneNavigation.show(workspaceID:taskID:)` is
  the only way a workspace is shown; it bumps a reveal counter, and the surfaces answer a change
  of (counter, selected workspace's project) by expanding the project and scrolling to the row.
  A project the user collapses by hand stays collapsed until the next jump. Rejected: expanding
  whenever the selected workspace changes — re-selecting a workspace in a just-collapsed project
  must expand again. Based on: `sidebar.tsx:480-522`, `SceneNavigation.swift` `show`.
- **D7 The collapsed row's summary follows `summarizeProjectActivity`.** Priority approval,
  question, error, active, done; the attention count is workspaces, not terminals. Based on:
  `project-rows.ts:72-91`.
- **D8 `WaitingItemsTests` is deleted, not replaced** `(decided while planning)`. It tests the
  removed derivation; a wrong member or order in 「当前」 is visible the first time the app is
  opened, which is the repository's bar for not writing a test (AGENTS.md, "Test harness").

### Discussion log

1. Top section's form — offered: 「当前」 replaces 「待处理」 (recommended); 「待处理」 above a new
   「当前」; 「当前」 with waiting rows pinned first. Answer: replaces. Settled one section with the
   desktop's fixed order.
2. Outer display — offered: the same rows, cards removed (recommended); waiting rows grow into
   cards in place; keep the carousel and add 「当前」 below. Answer: the same rows.
3. Projects — offered: collapsed by default as on the desktop (recommended); keep flat;
   collapsed but auto-expanded when active. Answer: as the desktop.
4. Product confirmation of all branches — answer: 确认.
5. Two points raised in the report (secret-only terminals join; error counts in the badge) —
   answer: 「两点都按你的倾向」. Settled D2 and D3.
6. Departure check — execution Self, plain autopilot (no audit offered: top-tier orchestrator).
7. D8 `(decided while planning)`.

### Maintenance notes

- The derivation is a hand mirror of the desktop's; a change to `current-terminals.ts` or
  `workspace-order.ts` membership or order needs the same change in the Swift file.
- Simulators cannot link the device-only Tailcat framework: the automated gate is a device
  compile, and the three forms are accepted by the owner on the iPhone Duo.

## Execution brief

> Written for `self` at `ed90eb1d`. Implement the tasks in order. Decide only what Your call
> leaves to you; on anything else that is unclear, stop and report.

### Goal

Make the iOS home (`WorkspaceListView`, compact layout) and sidebar (`HomeSidebar`, split and
tall layouts) show 「当前 / 项目 / 设备」 like the desktop sidebar: a 「当前」 section of live agent
terminals replacing 「待处理」, and projects as collapsible rows, collapsed by default. SwiftUI,
system containers and toolbars only; lay out from the container, never the device (AGENTS.md,
"iOS app"). Colours and fonts from `Theme.swift`. Comments in English, UI copy in Chinese. The
Xcode project uses synchronized folders, so new files under `apps/ios/Coflux` need no project
edit.

### Milestone 1: the 「当前」 derivation replaces the waiting items

Depends on: none

#### T1 · One pure function yields the 「当前」 rows

- Where: new file beside `apps/ios/Coflux/Views/WaitingItems.swift`, which it replaces. Keep that
  file's `CofluxClient` helpers `agent(forTask:)`, `terminalTitle(forTask:)` and `deviceName(_:)`.
- Change: derive rows from projects, workspaces, daemons, tasks, `sessionAgents`, titles and
  `secretRequests`. Order (D1): `visibleProjects` in store order; within a project the main
  workspace first, then ascending `createdAt`; then, per daemon in store order, its directory
  workspaces (`isDirWorkspace`) by `createdAt` then id; within a workspace, tasks by `createdAt`
  then id. Skip workspaces of archived projects. A task is a member when its daemon is online,
  it is running with a session id, and either its presence state is approval, question, error,
  active, done or waiting (waiting reads as done), or it has a pending secret request (D3). A
  pending secret request outranks the agent state for the row's state.
- After: each row carries the task, workspace, project (nil for a directory workspace), daemon,
  agent name (empty when none), title (OSC title, else task title, else 「终端」), state, message,
  progress, the centre's `seen`, the secret request if any, and whether it needs attention (D2:
  approval, question, error, secret). `CofluxClient` exposes the rows — empty while
  `snapshotRevision == 0` — and `waitingCount` as the attention count.
- Don't: sort by time or state (D1).

#### T2 · Nothing refers to the waiting items

- Where: `WaitingItems.swift`, `WaitingItemText` in `HomeComponents.swift`,
  `apps/ios/CofluxTests/WaitingItemsTests.swift`.
- Change: delete them once T3–T5 no longer use them (D8).
- After: `AppShell`'s two `waitingCount` readers compile unchanged against the new count.

### Milestone 2: shared rows and the persisted expanded set

Depends on: Milestone 1

#### T3 · Shared views: the current-terminal row and the project row

- Where: `apps/ios/Coflux/Views/HomeComponents.swift` or a new file beside it.
- Change: (a) a current-terminal row content: `AgentAvatar` at the workspace rows' size with the
  state's tone as its dot and Clawd's pose from `ClawdPose(state:seen:)` through
  `navigation.isTurnSeen`; the title on the first line; on the second, the state text in the
  tone's colour — `TerminalActivity` already has the wording, add what it lacks — followed by the
  location in the muted colour, the location giving way first when space is short. (b) a project
  row content: a chevron that turns when expanded, the project name, 「· device」 as the header
  has it today, and when collapsed the trailing summary (D7): 「N 待处理」 in the warning tone, else
  the top activity's wording in its tone, else nothing; a hollow dot when the device is offline.
  (c) the expanded-projects store (D5): read, toggle, ensure-expanded, pruning unknown ids on
  write, observable so every surface and window updates together.
- After: both surfaces can render the three sections from these pieces plus the existing
  `WorkspaceRowContent`, `DeviceRowContent` and `HomeSectionHeader`.

#### T4 · Jumps reveal

- Where: `SceneNavigation.show(workspaceID:taskID:)`.
- Change: bump a reveal counter there (D6).
- After: a surface observing (counter, the selected workspace's project id) expands that project
  through the store and scrolls its workspace row into view; this also runs when the snapshot
  arrives after the selection. Collapsing the selected project by hand sticks until the next
  `show`.

### Milestone 3: both surfaces use them

Depends on: Milestone 2

#### T5 · The outer home and the sidebar show 「当前 / 项目 (/ 设备)」

- Where: `WorkspaceListView` (its `waitingSection`, cards, page dots and `projectsSection`) and
  `HomeSidebar` (its 待处理 section, `waitingRow` and per-project sections).
- Change: replace the 待处理 section with 「当前」 — header `当前` with the row count as detail,
  hidden when there are no rows — and the per-project headers with a `项目` header followed by
  project rows; an expanded project lists its workspace rows indented under it. Tapping a
  current row calls `navigation.show(workspaceID:taskID:)`; when the row has a secret request it
  also presents `SecretRequestSheet`, and in the tall layout keeps the floating sidebar out
  while the sheet is up, exactly as `waitingRow` does now. In the sidebar a current row is
  highlighted when its terminal is the selected one, a workspace row when its workspace is
  selected. Projects with no workspaces stay unlisted. Remove the card carousel and its state.
- After: the outer home is 当前, 项目; the sidebar is 当前, 项目, 设备 (devices untouched). The
  「暂无项目」 overlay shows when there are no visible projects and no current rows. Context menus
  on workspace and device rows still work.
- Don't: add hand-drawn headers or floating controls; give sections their own scroll views.

The milestones are strictly serial; do not fan out.

### Your call

Names and file split; row metrics and fonts within `Theme`; the scroll-reveal mechanism
(`ScrollViewReader`, scroll position, or the list's own) and its animation; whether the sidebar's
wide form shows extra detail on current rows, as the old waiting row did; the indentation of
workspace rows under a project.

### Landmines

- `HomeSidebar` presents the secret sheet from the sidebar itself: in the tall layout putting the
  sidebar away dismisses the view the sheet hangs from (`HomeSidebar.swift`, `waitingRow`).
- The sidebar's `List` rows are sized by `defaultMinListRowHeight` 1 and explicit insets; a new
  row kind needs the same `listRowInsets`, hidden separators and `listRowBackground`.

### Scope

In scope:
- `apps/ios/Coflux/Views/**`
- `apps/ios/CofluxTests/WaitingItemsTests.swift` (deletion)

Out of scope:
- `apps/desktop/**`, `packages/**`, `crates/**` — no desktop, client-core or protocol change
- `DevicesView`, `DeviceSessionsView`, `WorkspaceDetailView` — the terminal page and 设备 tab are unchanged
- `NewTerminalPicker` — its flat project list is a picker, not the home

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list (for example a client-core accessor that does not exist).
- Two tasks contradict each other, or a task contradicts the code it changes.

## Verification

### Milestone validations

- Milestones 1–3 (one gate, after M3; M1 alone does not compile until its readers move):
  `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`
  -> `BUILD SUCCEEDED`, no new warnings. A fresh worktree first needs
  `apps/ios/Frameworks/CofluxTailcat.xcframework` copied from the main checkout (git-ignored).

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| iOS device compile | the `xcodebuild … build` above | BUILD SUCCEEDED |
| Test target compiles | the same with `build-for-testing` | BUILD SUCCEEDED |
| No leftovers | `grep -rn "WaitingItem" apps/ios` | no matches |
| Duo walkthrough (acceptance) | owner, on the iPhone Duo: outer, inner wide, inner tall | the Requirement's "Observable when done" |

### Done criteria

- [ ] All listed commands pass (the walkthrough is the owner's and stays pending).
- [ ] Every task's `After` state holds.
- [ ] The derivation's order and membership match `current-terminals.ts` line for line, plus D3.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

iOS only: no centre deploy, no desktop release. Ships with the next `ios-<N>` tag after merge.
CI does not build the iOS app; the device compile above is the only automated gate.
