# Plan 20261111-sidebar-follow-selection: Jumping to a terminal reveals its workspace in the sidebar

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 974dce2e..HEAD -- apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/renderer/components/workbench/project-rows.ts apps/desktop/src/renderer/components/workbench/project-rows.test.ts apps/desktop/src/renderer/components/workbench/workbench.tsx`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self — departure check (user chose Self)
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (audit omitted: orchestrator already top-tier)
- Workspace: isolated — cut from main worktree (clean, `974dce2e`) onto `dev/20261111-sidebar-follow-selection`
- Planned at: `974dce2e`, 2026-11-11

## Record

### Requirement

Jumping to a terminal — clicking a system notification, a 「当前」 row, ⌘⇧A
下一个待处理, or a command-palette terminal — selects the terminal's workspace,
and the sidebar highlights that workspace's row. But since plan
20261109-sidebar-current-section made projects collapsed by default, the
highlighted row is often not rendered at all (project collapsed) or outside
the scroll viewport. The user lands on the terminal with no visible cue of
where they are in the project tree.

Once done, the consumer observes:

- Whenever the selected workspace changes — through any jump entry point, or
  when the app restores the persisted selection at startup — the sidebar
  expands the workspace's project (when collapsed) and scrolls the workspace
  row into view. A row already visible does not move.
- A repeated jump to the already-selected workspace (e.g. after the user
  manually collapsed its project) reveals it again.
- The auto-expansion persists exactly like a manual expansion (same
  localStorage record), so it survives restart.
- When a jump lands on a device detail view instead (directory workspace →
  device), the device row scrolls into view in the devices section (which has
  no collapse concept).
- A sidebar hidden entirely with ⌘B is never popped open by a jump; when it
  is shown again, it reveals the current selection once on mount.

### Decisions & tradeoffs

- **D1 Reveal lives in the Sidebar component, driven by props**: a Sidebar
  effect resolves the selected workspace's project and performs
  expand + scroll. Rejected: doing it in `workbench.tsx` at each call site —
  the expansion state (`expandedIds`) is Sidebar-local
  (`sidebar.tsx:445`), and call-site logic would miss startup restore and
  future entry points. Based on: all jump paths already converge on
  `selectWorkspace`/`selectDevice` and the Sidebar already receives
  `selectedWorkspaceId`/`selectedDeviceId` (workbench.tsx `landOnTask`,
  `focusFromNotification`).
- **D2 The trigger is a reveal nonce from the workbench, not the bare id
  change**: `selectWorkspace`/`selectDevice` bump a counter passed to the
  Sidebar, so a repeat jump to the already-selected workspace still reveals
  it after the user manually collapsed its project. Rejected: effect keyed
  only on `selectedWorkspaceId` — a same-id jump would change nothing and
  the sidebar would stay collapsed. `(decided while planning)`
- **D3 The reveal effect never depends on `expandedIds`**: a manual collapse
  of the selected project must stick until the next jump; an effect that
  re-fires on expansion-set changes would fight the user. Based on: the
  grilling conclusion in exploration.
- **D4 Auto-expansion persists through the same record as manual expansion**:
  a new `ensureProjectExpanded` in `project-rows.ts` shares
  `ExpandedProjectsStore` with `toggleExpandedProject`, returning the set
  unchanged (no storage write) when already expanded. Rejected: session-only
  expansion — the user confirmed "重启后保持展开" at the product
  confirmation.
- **D5 Scrolling uses `scrollIntoView({ block: "nearest" })`** so an
  already-visible row does not move; the scroll must run only after the row
  is actually rendered (expansion may happen in the same update). Based on:
  product confirmation ("已可见则不滚动").
- **D6 Startup race**: the persisted selection exists before the first
  snapshot delivers workspaces, so the reveal must take effect once the
  workspace (and hence its project id) resolves — the effect keys on the
  resolved project id, not the bare workspace id. Based on: `snapshotRevision`
  gating elsewhere in `sidebar.tsx` (plan 078 notes).

### Discussion log

1. Product confirmation (dev:explore): trigger on any selected-workspace
   change incl. startup restore; expand + scroll nearest; persist expansion
   with the manual record; device rows scroll too; ⌘B-hidden sidebar never
   auto-opens → **confirmed as recommended**.
2. Departure check: direction (Sidebar effect + `ensureProjectExpanded` +
   `scrollIntoView`) → **confirmed**; execution → **Self** (user's explicit
   pick over the recommended opus); autopilot → **直接连跑** (plain, audit
   option omitted: orchestrator top-tier).
3. `(decided while planning)` D2: the trigger is carried as a nonce bumped by
   `selectWorkspace`/`selectDevice`, so a same-id re-jump still reveals.

### Maintenance notes

- The reveal is deliberately one-shot per selection event: nothing keeps the
  selected project expanded afterwards. If a future change makes `expandedIds`
  react to selection, re-read D3.
- 「当前」 rows live at the top of the same scroll container as the project
  tree; they are never the reveal target (the highlighted terminal row there
  follows `onScreenTaskId`, not the workspace selection).

## Execution brief

> Written for `self` at `974dce2e`. Implement the tasks in order. Decide only
> what Your call leaves to you; on anything else that is unclear, stop and
> report.

### Goal

When the workbench selects a workspace (any jump entry point or startup
restore), the sidebar must expand that workspace's project and scroll its row
into view; selecting a device must scroll the device row into view. One
renderer-only change across `project-rows.ts` (pure helper + tests),
`workbench.tsx` (reveal nonce), and `sidebar.tsx` (the effect). Follow the
file's existing comment style (Chinese or English per surrounding code); no
new dependencies. Format with the repo's existing conventions (no dedicated
formatter command for the desktop app; oxlint runs in Verification).

### Milestone 1: the sidebar follows the selection

Depends on: none

#### T1 · `ensureProjectExpanded` exists and is tested

- Where: `apps/desktop/src/renderer/components/workbench/project-rows.ts` —
  below `toggleExpandedProject`
- Change: add `ensureProjectExpanded(store, expanded, projectId, knownProjectIds)`
  mirroring `toggleExpandedProject`'s signature and persistence.
- After: when `expanded` already contains `projectId`, the exact same set
  reference is returned and storage is not written (D4); otherwise the
  returned set contains `projectId`, drops ids not in `knownProjectIds`, and
  is persisted best-effort like the toggle. Tests in
  `project-rows.test.ts` cover: already-expanded → same reference, no
  setItem; not expanded → added + persisted; unknown ids dropped; throwing
  storage still returns the new set.

#### T2 · the workbench hands the sidebar a reveal trigger

- Where: `apps/desktop/src/renderer/components/workbench/workbench.tsx` —
  `function selectWorkspace` / `function selectDevice`, and the `<Sidebar`
  element
- Change: maintain a reveal counter (state) bumped by every
  `selectWorkspace` and `selectDevice` call; pass it to `Sidebar` as a new
  prop (e.g. `revealNonce`).
- After: every jump — `landOnTask`, `focusFromNotification`, 「当前」 row,
  ⌘⇧A, palette, and plain sidebar clicks — bumps the nonce; the initial
  value covers the startup-restored selection (the Sidebar's mount effect
  reveals it once, D2). No other behaviour of the two functions changes.

#### T3 · the Sidebar reveals the selection

- Where: `apps/desktop/src/renderer/components/workbench/sidebar.tsx` —
  `export function Sidebar`, near the `expandedIds` state (`useState(() =>
  readExpandedProjects…)`)
- Change: add an effect that, for the current `selectedWorkspaceId`, resolves
  the workspace's `projectId` from the store state already subscribed in the
  component, calls `ensureProjectExpanded` when the project is collapsed,
  and scrolls the workspace row into view with
  `scrollIntoView({ block: "nearest" })`; for `selectedDeviceId`, scrolls
  the device row. Locate rows via a data attribute (or ref map) on
  `WorkspaceRow`'s outer row and the device row.
- After: the reveal runs (a) on mount once the selected workspace's project
  id resolves — covering startup, snapshot-later-than-selection (D6), and
  re-mount after ⌘B — and (b) on every nonce bump. The scroll happens only
  after the expanded row is rendered (D5): when expansion was needed in the
  same pass, defer the scroll until after that render (pending-target ref
  consumed by a follow-up effect, or equivalent). A visible row does not
  move. Manually collapsing the selected project afterwards sticks (D3).
- Don't: depend on `expandedIds` in the reveal-trigger effect's dependency
  array such that manual expand/collapse re-fires the reveal (D3); don't
  scroll the 「当前」 section's rows.

### Your call

- The exact trigger plumbing (nonce prop name, state vs ref + effect event),
  the row-locating mechanism (data attribute vs ref map), and how the
  deferred scroll is sequenced, within D2/D3/D5.
- Whether the device-row scroll shares the workspace mechanism or is its own
  small effect.
- Test wording and structure in `project-rows.test.ts`.

### Landmines

- `sidebar.tsx:445` `expandedIds` is component state initialised from
  localStorage; writing through any path other than
  `toggleExpandedProject`/`ensureProjectExpanded` would desync storage.
- Directory-workspace jumps land as `selectDevice`, not `selectWorkspace`
  (`workbench.tsx:1106`): the workspace reveal must tolerate a selected id
  that resolves to no visible row without erroring.
- The devices section is its own scroll container (`max-h-[42%]`,
  `sidebar.tsx:708`); `block: "nearest"` scrolls the inner container — do
  not scroll the outer one manually.

### Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/project-rows.ts`
- `apps/desktop/src/renderer/components/workbench/project-rows.test.ts`
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`

Out of scope:
- `apps/desktop/src/renderer/components/workbench/current-terminals.ts` and
  the 「当前」 section's highlight logic — unchanged.
- The ⌘B collapse state and `setSidebarCollapsed` — a jump never changes it.
- Any main-process or protocol surface.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task
  describes.
- A task needs a file outside the in-scope list.
- Revealing turns out to require changing when `selectWorkspace` persists or
  sets the selection (it must not).

## Verification

### Milestone validations

- Milestone 1: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 (new project-rows cases included) |
| Lint | `pnpm -C apps/desktop lint` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| UI walkthrough (acceptance) | `pnpm dev:desktop:prod` | user walkthrough: jump via notification / 「当前」 / ⌘⇧A with the project collapsed → expands + scrolls; manual collapse sticks; restart restores expansion |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] Jumping to a terminal whose project is collapsed expands the project
      and scrolls the workspace row into view; a repeat jump after a manual
      collapse reveals it again.
- [ ] `ensureProjectExpanded` tests exist and assert the no-write fast path.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

Desktop renderer only: no protocol, server, or daemon change; ships with the
next `v*` desktop release. The UI walkthrough is the user's (frontend changes
are accepted by hand, not by the agent).
