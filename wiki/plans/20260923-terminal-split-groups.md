# Plan 20260923-terminal-split-groups: Terminals split into VS Code-style editor groups

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 6da899cc..HEAD -- apps/desktop/src/renderer apps/desktop/src/main/menu.ts apps/desktop/src/shared/desktop-bridge.ts`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — the session was on the main worktree; moved to `.claude/worktrees/20260923-terminal-split-groups` on `dev/20260923-terminal-split-groups`
- Planned at: `6da899cc`, 2026-09-23

## Requirement

Today a workspace's main area shows one thing at a time: a single top bar (branch button │ resident 「变更」 tab, terminal tabs, ＋) and one terminal or the changes view underneath. The user wants the editor-group split of VS Code: several terminals visible side by side, each group with its own tab strip.

Product conclusions, confirmed by the user — these are settled, do not reinterpret them:

1. **Model**: VS Code editor groups. Every group has its own tab strip. Groups split left/right and up/down and nest arbitrarily (a grid, not a single row). Dragging the sash between two groups resizes them; double-clicking a sash equalises that split.
2. **Tab strips hold terminals only.** 「变更」 is no longer a resident tab. The branch button stays at the far left of the tab strip of the top-left group (with no split this looks exactly like today minus the 「变更」 tab). Directory workspaces (device detail) still have no branch button.
3. **「变更」 moves into the top-right action dock** (`workbench.tsx:979`, next to ports and notifications) as a toggle button with a pressed state and the +X −Y badge (hidden when both are 0). Pressing it covers the **whole** main area with the changes view (all groups hidden underneath); pressing it again, or Esc, returns to the split layout exactly as it was. Not rendered for directory workspaces. No side panel.
4. **Splitting**:
   - ⌘\ splits the focused group to the right and opens a **new terminal** in the new group; ⌘⇧\ splits downward.
   - Dragging a tab onto a group's top/bottom/left/right edge highlights that half; dropping **moves** that terminal into a new group there. Dropping onto another group's tab strip inserts it at that position; dragging inside one strip reorders.
   - A tab's context menu gains 「向右拆分」 and 「向下拆分」, which **move** that terminal into a new group.
   - A group whose last tab is closed or moved away disappears. When every group is empty the existing empty state shows.
   - A terminal is never shown in two groups at once.
5. **Focus and keys**: exactly one focused group; clicking anywhere in a group focuses it. The active tab of a non-focused group uses a visibly weaker highlight than the focused group's active tab.
   - ⌘1–9 focuses the Nth group in layout order (left to right, then top to bottom — reading order of the groups' top-left corners). **This replaces** today's ⌘1–9 tab selection.
   - ⌘⌥1–9 selects the Nth tab of the focused group.
   - ⌘T, ⌘W, ⌘[ and ⌘] act on the focused group.
   - ⌘⌥←/→/↑/↓ moves focus to the adjacent group in that direction.
6. **Where new terminals land**: terminals created here (including the optimistic pending tab), terminals created by agents or other clients, and terminals moved into this workspace from another one (plan 104) all land in the workspace's focused group.
7. **Persistence**: the layout is stored per workspace on this machine (groups, tab order and active tab per group, split ratios, focused group). It survives switching workspaces and restarting the app. Not synced to the account, no protocol change.
8. **Non-goals**: one terminal in several groups, maximising or locking a group, dragging tabs across workspaces or windows, account sync, a changes side panel.
9. **Observable when done**: a 2×2 grid where every group switches and closes its own tabs; tabs drag across groups and out into new groups; ratios survive a restart; the dock button opens and closes the changes overlay while agents keep running in the groups; the detached (「已被其它客户端接管」) and exited (「此终端已退出」) banners appear only over the group that shows that terminal.

## Decisions & tradeoffs

- **Panes stay in one flat layer keyed by task id and are positioned by rectangles computed from the layout tree.** Group chrome (tab strips, sashes, per-group banners, empty/pending placeholders, drop highlights) is rendered in a separate layer from the same tree. Moving a tab between groups, reordering, splitting and plan-104 workspace moves only change a pane's rectangle; the `TerminalPane` element is never unmounted, re-keyed or re-parented (no portals either). Rejected: rendering panes inside group containers — a move would remount xterm, lose selection and scrollback and re-run attach; portals — they physically move the DOM node under a WebGL canvas, untested. Based on: `terminal-panes.tsx:1-17` (plan 104 invariant: same xterm instance across moves), `terminal-pane.tsx:889-892` (panes currently `absolute inset-0` or `hidden`).
- **Layout is a pure module with unit tests, owned by `Workbench`.** Pure functions (no React/DOM), in the style of `workbench-state.ts` + `workbench-state.test.ts`: split, move (to edge / to strip index / reorder), close with empty-group collapse, focus by index and by direction, layout-order numbering, reconcile against the live task list (new task → focused group; vanished task → removed and empty groups collapsed; a task whose `workspaceId` changed → removed from the old workspace's layout and added to the new one's focused group, active there if it was the watched tab), and parse/serialise for storage (unknown or malformed data → single group; ids not in the task list dropped). Per-group active-tab fallback replaces `resolveActiveTaskId` / `resolveActiveTaskIdAfterPendingDrop` (`workbench-state.ts`), which become per-group or are removed. The per-workspace layouts replace `activeTabs` in `workbench.tsx:236`; `WorkspaceTerminal` renders chrome from the layout it is given and reports intents, it does not own a second copy of tab selection. Rejected: layout state inside `WorkspaceTerminal` — `Workbench` already needs the visible set and the focused task synchronously for the attach gate (`workbench.tsx:278-307`), and a second copy is how the ⌘P desync bug of plan 20260921 happened (`workspace-terminal.tsx:315-329`).
- **Storage**: `localStorage`, key named in the `config.ts` convention (`coflux_…`) and scoped by `SERVER_URL` like `COMMAND_PALETTE_RECENT_KEY` (`config.ts:21`), since workspace ids mean nothing on another server. Every read and write in try/catch; rendering correct when storage is empty or throws. The layout module never imports `@/config` or touches `localStorage` itself — storage and key are injected, as `RECENT_PLACES_STORE` does (`workbench.tsx:93-98`), because `@/config` calls `requireDesktopBridge()` at load (`config.ts:4`) and the unit tests run under plain Node without the `@/` alias. Rejected: server/account sync (non-goal 8). (revised on plan audit)
- **Reconcile is gated on the first snapshot and derived synchronously.** Before the first snapshot `tasks` is `[]` (`packages/client/src/store.ts:366`); `workbench.tsx:367` gates selection on `snapshotRevision === 0` for the same reason, and the offline directory cache bumps it (`store.ts:419-445`). While `snapshotRevision === 0` the stored layout is neither reconciled nor persisted — otherwise the first frame drops every id and overwrites the saved layout. After that, the effective layout is `reconcile(stored, tasks of the workspace)` computed during render (or in the store subscription), never in a `useEffect([tasks])` one frame late: the visible set is derived from it during render and must not reference a vanished task or miss a new one. Persist only when the effective layout differs from what is stored. (revised on plan audit)
- **The optimistic pending tab is a first-class layout entry.** Its fake id (`workspace-terminal.tsx:241`) is exempt from reconcile's "not in the task list → remove" rule, so a group created by ⌘\ holding only the pending tab does not collapse. On success the real task replaces the pending entry **in the same group at the same position** — not "new task → focused group", because the user may have moved focus during the up-to-15s wait; on failure or timeout the entry is removed and normal collapse applies. ⌘\ / ⌘⇧\ while a create is in flight is a no-op (`createTerminal` already refuses a second create, `workspace-terminal.tsx:237`). (revised on plan audit)
- **The tree never goes below one group.** The last remaining group does not collapse; when empty it still renders its tab strip (branch button, ＋, the window drag region of plan 108 — today the header renders unconditionally, `workspace-terminal.tsx:382-544`) above the existing empty state. When the focused group collapses, focus goes to the neighbour that absorbs its space (VS Code behaviour). (revised on plan audit)
- **Visibility is a set; focus is one task.** Visible = the active tab of every group of the selected workspace while the changes overlay is closed. `terminal-attach.ts`'s single `visibleTaskIdRef` becomes a set: every visible pane claims control exactly as the single visible pane does today (L103, L150, L242, L298), and the workspace-switch effect (L331-353) refits and attaches **every** visible pane. Opening a workspace with N groups therefore claims N terminals from other clients — the same rule as today ("visible ⇒ claim"), applied per group. Rejected: claiming only the focused pane — the other visible panes would sit un-owned and un-resized on screen.
- **Becoming visible is not a user activation.** `performActivation` force-claims whenever the task is `detached`, whatever the caller passed (`terminal-attach.ts:145`); the workspace-switch effect deliberately skips detached tasks — "必须用户点击" (`terminal-attach.ts:331-353`, `:346`). The attach machine therefore gets two distinct entry points: an "ensure visible" path (fit + non-forced attach, skipping detached, never focusing) used when a pane becomes visible without the user choosing it — closing the changes overlay, switching workspace, a background group's tab fallback, a task landing in a non-focused context, restoring a layout — and `requestActivation` (which may force-claim a detached task) reserved for user actions on a specific tab: click, shortcut, drop, palette/notification jump, the banner's 重新接管. Rejected: calling `requestActivation` for every group's active tab — with two clients showing the same grid, every switch would steal every detached pane back. (revised on plan audit)
- **`TerminalPane.active` splits into `visible` and `focused`.** `visible` drives rendering, pointer events, fit, resize reporting, input, image paste and file drop (`terminal-pane.tsx:571-576`, `605-660`, `700-710`) and closing the paper when the pane leaves the screen (`840-842`). `focused` drives `focus()` (`761-767`), the OSC 52 clipboard write (`585-590` — the clipboard is global, only the focused pane may write it), and the window-level ⌘F / ⌘↑ / ⌘↓ capture handler (`818-837`), which would otherwise fire once per visible pane. Rejected: keeping one boolean.
- **Attach never moves keyboard focus.** `performActivation` (`terminal-attach.ts:140-141`) and `markOwned` (`106-107`) call `controller.focus()` unconditionally; today that is harmless because non-visible panes are `display:none`. With several visible panes, an attach completing in a background group, a task landing in the focused group, or a per-group fallback would steal the caret from the group the user is typing in. Focus is applied only to the focused group's active pane, and only on a user action (click, shortcut, split, drop) or when the focused group's active tab changes. Fit and resize reporting stay on the attach path for every visible pane.
- **Shortcuts are dispatched by exact modifier set.** `use-global-shortcuts.ts:53` accepts only bare ⌘ (`!shift && !alt`); ⌘⇧\, ⌘⌥1–9 and ⌘⌥←→↑↓ need their own sets and must not widen the existing bare-⌘ keys (⌘⇧W is the native close-window accelerator, `main/menu.ts:56`). Keys are matched on `event.code` as today.
- **⌘⌥ chords belong to the app, not the terminal.** `decideTerminalKeyOwner` (`terminal-key-ownership.ts:60-65`) returns `"terminal"` for any event with `altKey`. The global handler wins the keydown in capture phase, but the keyup of ⌘⌥1 would still reach xterm and, in a TUI that negotiated kitty `REPORT_EVENT_TYPES`, arrive as a release without a press — the exact failure that module documents. The new ⌘⌥ digit and arrow chords must be classified `"app"`; other ⌥ combinations stay with the terminal (⌥ is Meta). Update its test.
- **Native menu and help list the new keys.** `main/menu.ts` exposes page shortcuts with display-only accelerators routed through `DesktopCommand` (`shared/desktop-bridge.ts:74`); add split right / split down entries (and the group focus keys where a menu entry makes sense) and update `ShortcutsHelpDialog` (`dialogs.tsx:265`) for the changed ⌘1–9 meaning.
- **The changes overlay stays per workspace and is opened from the dock.** The overlay's open state is per workspace and survives switching away, as the current `view` state does (`workspace-terminal.tsx:136-138`); the `ChangesView` stays kept-alive and only active when open in the selected workspace (`shouldActivateChangesView`). While it is open the visible set is empty (no pane fits at zero size, none claims). Opening it blurs the terminal and Esc is taken in capture phase while it is open, so Esc never reaches a shell as `\x1b`. How the dock reaches the selected workspace's state (handle on `activeTerminalRef`, or state lifted into `Workbench`) is the executor's call. While the overlay is open: every activating command (⌘T, ⌘1–9, ⌘⌥1–9, ⌘[ ⌘], ⌘\, ⌘⇧\, ⌘⌥ arrows, palette and notification jumps) closes the overlay first and then acts; ⌘W is suspended (today `closeActiveTab` ignores `view`, `workspace-terminal.tsx:355-357`, so a blind ⌘W already closes an unseen terminal). The overlay's Esc acts only when no dialog, settings page, palette or paper is open — those all consume Esc themselves (`settings-page.tsx:82-90`, `terminal-paper.tsx:166-176`, the ⌘P palette, `ConfirmActionDialog`), and sibling capture listeners on one target cannot stop each other. The overlay keeps a window drag band at its top (as `EmptyMain` does with `DESKTOP_DRAG_BAND_STYLE`) or leaves the top strips uncovered — the window must stay draggable. (revised on plan audit)
- **Rectangles are fractional, not measured.** A pane's rectangle is expressed in percentages of the body area derived from the tree's ratios (with `calc()` for fixed strip heights and sash gaps), so the browser lays it out in the same frame. Rejected: JS-measured rectangles — they produce a frame with a small non-zero size, `fit()` only rejects zero (`terminal-pane.tsx:520-521`), and an owned pane would push wrong cols/rows to the PTY, reflowing the remote TUI. Sashes must receive pointer events even though the pane layer comes later in the DOM with `pointer-events-auto`: either stack sashes above the pane layer or leave a gap between pane rectangles. (revised on plan audit)
- **Clicking inside a terminal focuses its group.** The pane layer sits above the chrome, so a pointerdown on a pane host must be reported upward (by task id) to set the focused group; the chrome layer never sees that click. (revised on plan audit)
- **Dragging a tab never writes a file.** `terminal-pane.tsx:605-660` turns drops on a pane into `sendFsWrite`. A tab drag passing over or released on a pane must be ignored by that path, and while a tab drag is in progress the drop-zone layer sits above the panes. Today's `hasFileTransfer` gate (`terminal-pane.tsx:634`) already ignores payloads without `Files`; keep it that way — do not give the tab drag a file-like payload. Rejected: relying on the drop landing only on chrome — the pane layer is on top of the body cell.
- **Window drag region (plan 108) per strip.** The tab strips of groups touching the window's top edge are drag regions (`DRAG_REGION_STYLE`), every clickable or draggable element inside them is `NO_DRAG_REGION_STYLE`; strips of lower groups are not drag regions. The dock's width is reserved only in the top-right group's strip. The dock is `w-20` today (`workbench.tsx:982`) with a matching `pr-20` in the strip (`workspace-terminal.tsx:383`) and a `right-full w-6` fade (`workbench.tsx:985`); a third button with a `+123 −45` badge does not fit 80px, so the dock width, the strip's reserved padding and the fade move together — do not hard-code 80px anywhere new. The existing badge uses native `title` (`workspace-terminal.tsx:424`), which the design guidelines forbid for hints; the dock button uses `Tooltip`. The dock must stay after the main area in document order (`workbench.tsx:973-978`). (revised on plan audit)
- **Per-group chrome.** The detached and exited banners (`workspace-terminal.tsx:572-593`), the pending-tab placeholder (`549-557`) and the "user is looking at it" check that clears the done-celebration (`seenDoneRef`, `441-444`) are per group: they apply to that group's active tab, and "looking at" means visible in the selected workspace, not merely focused.
- **The ⌘P palette's current place is the focused task** (`workbench.tsx:934`), and its recent-places recording (`workbench.tsx:299-303`) records the focused group's active tab, never background groups' fallbacks. A palette or notification jump to a terminal already in some group focuses that group and activates the tab there; to one not yet in the layout, it lands in the focused group.
- **Sashes reuse the hand-written pointer pattern** of `sidebar-resize-handle.tsx` / `use-sidebar-width.ts`; no layout or DnD library. (decided while planning)
- **Left to the executor**: the layout tree's exact shape and ids, the drag mechanism (native HTML5 DnD preferred, no new dependency), the minimum group size and what happens at it, highlight visuals following `docs/design-guidelines.md`, whether ⌘\ on an empty workspace splits or just creates, and group-numbering tie-breaks.

## Direction

Renderer-only change in `apps/desktop`. No protocol, server or daemon change.

### Milestone 1: Layout model

A pure layout module and its tests exist, covering every operation listed under the second decision, including reconcile and storage parsing. Nothing is wired yet. Validation: `pnpm -C apps/desktop test` → exit 0, and `pnpm -C apps/desktop typecheck` → exit 0.

### Milestone 2: Attach and pane semantics

`terminal-attach.ts` works on a visible set; `TerminalPane` takes `visible`/`focused` and a rectangle; attach no longer moves focus; `TerminalPanes` positions panes from rectangles. With a single group, behaviour is identical to today. Validation: typecheck + test → exit 0.

### Milestone 3: Groups in the workbench

`Workbench` owns per-workspace layouts (persisted), computes the visible set and focused task, renders group chrome (strips, sashes, per-group banners and placeholders, drop zones) and the dock's 「变更」 toggle with the full-area overlay; the resident 「变更」 tab is gone; tab drag and context-menu splits work; plan-104 moves and palette/notification jumps land per the decisions. Validation: typecheck + test + `pnpm -C apps/desktop build` → exit 0.

### Milestone 4: Keys

All shortcuts in product conclusion 5 plus ⌘\ / ⌘⇧\, the key-ownership change with its test, the native menu entries and the help dialog. Validation: typecheck + test → exit 0.

Milestones are strictly sequential (2 consumes 1's model, 3 wires 1 and 2, 4 dispatches into 3's operations) and they share `workbench.tsx` / `workspace-terminal.tsx` — one work package, do not fan out.

## Landmines

- `activeTerminalRef` is attached only to the selected workspace's `WorkspaceTerminal` (`workbench.tsx:793`); every shortcut goes through it. Keep one entry point for commands; don't let a hidden workspace receive them.
- Plan-104 follow must be decided in the store subscription, before React renders (`workbench.tsx:309-330`) — a parent effect is too late, the destination container would first fall back and attach a sibling. The layout move has to happen in that same synchronous step.
- The container-side follow effect for palette jumps inside an already-mounted workspace (`workspace-terminal.tsx:315-329`) exists because the task-list effect does not run for them. Keep that case working when selection moves into the layout.
- Refs mirror state everywhere in these files because imperative callbacks read "now" values before React re-renders (`workspace-terminal.tsx:154-162`, `terminal-attach.ts:66-71`). The visible set and focused task need the same synchronous mirror, written during render as `syncVisibleTask` does (`workbench.tsx:278-285`).
- Panes are fitted by a `ResizeObserver` on their host (`terminal-pane.tsx:700`); a hidden pane's fit is a no-op, and the workspace-switch effect exists to refit after a hidden period. A pane whose rectangle changes while visible is refitted by the observer; a pane that becomes visible after being hidden needs the explicit refit.
- Window-level capture listeners inside `TerminalPane` (`818-837`) run for every mounted pane that passes their gate — gate them on `focused`.
- Top-bar elements lose clicks and tooltips if they sit inside a drag region without `NO_DRAG_REGION_STYLE`, and the dock loses them if it moves before the main area in the DOM (`drag-region.ts`, `workbench.tsx:973-978`). Whether a `draggable` element starts a drag inside Electron's no-drag hole of a drag region is unverified — the real-machine walkthrough must check it.
- Hover hints use the astryx `Tooltip`, never native `title` (`docs/design-guidelines.md:5-11`).
- The desktop `test` script only picks up `src/renderer/components/workbench/*.test.ts` — flat, `.ts` only (`apps/desktop/package.json:13`). A layout module placed in a subdirectory or tested in `.test.tsx` silently never runs while typecheck stays green. Put the module and its test flat in `components/workbench/`.
- The React Compiler is on for the whole renderer (`apps/desktop/electron.vite.config.ts:99-103`). Render-time ref mirrors (the pattern this code relies on) may be memoised wrongly in new components; keep such mirrors in `Workbench`, where the pattern already works, or opt the component out with `"use no memo"`. (hunch from plan audit, unverified)
- ⌘\ on ISO keyboards may report `IntlBackslash` rather than `Backslash`; accept both. (hunch from plan audit, unverified)
- If two visible panes each have the paper open, one Esc may close both — gate the paper's Esc on `focused`. (hunch from plan audit, unverified)

## Scope

In scope:
- `apps/desktop/src/renderer/**` (workbench components, the new layout module and its test, `workbench-state.ts` and its test)
- `apps/desktop/src/main/menu.ts`
- `apps/desktop/src/shared/desktop-bridge.ts` (the `DesktopCommand` union only)
- `wiki/plans/README.md`, this plan

Out of scope:
- `packages/**`, `apps/server/**`, `crates/**` — no protocol or daemon change
- The changes view's own content (`changes-view.tsx` internals) — only where it is mounted changes
- Sidebar, settings page, command palette internals beyond the "current place" input

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0; record the pass count on the baseline before Milestone 1 and report baseline → final (the final count must include the new layout tests) |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Real-machine walkthrough (acceptance) | `pnpm dev:desktop:prod`, by the user | product conclusion 9 holds |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Layout tests cover split, move to edge / strip / reorder, empty-group collapse, direction focus, layout-order numbering, reconcile (new, vanished, moved-workspace task) and malformed storage.
- [ ] With one group the workspace looks and behaves as before, except that 「变更」 is in the dock and ⌘1–9 focuses groups.
- [ ] No code path unmounts or re-keys a `TerminalPane` when its tab moves between groups.
- [ ] Only the focused pane takes keyboard focus, writes OSC 52 to the clipboard or answers ⌘F/⌘↑/⌘↓.
- [ ] ⌘⌥ digit/arrow chords are classified `"app"` by `decideTerminalKeyOwner`, with a test.
- [ ] A tab drag released on a pane writes no file.
- [ ] Layout tests also cover: no reconcile/persist before the first snapshot (reconcile against an empty list must not be reachable from the persisted path), the pending entry surviving reconcile and being replaced in place, the last group never collapsing, and focus moving to the absorbing neighbour on collapse.
- [ ] Only user actions on a tab call the path that may force-claim a detached task; overlay close, workspace switch and background fallbacks use the non-forcing visible path.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] A row for this plan is **added** to `wiki/plans/README.md` (it has none yet) with the final status.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (e.g. a protocol field).
- Keeping panes mounted across moves turns out to be impossible without re-parenting.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Plan audit (fable, 2026-09-23) found every cited `file:line` accurate and raised 17 points; all were adopted into the decisions, landmines and done criteria above (marked `revised on plan audit`). One was downgraded rather than rejected: "a tab drag writes no file" does not by itself discriminate a wrong implementation, since `hasFileTransfer` already ignores non-file payloads — it stays as a done criterion, not as evidence.

- Stored layouts are local, per machine and per workspace id; a workspace deleted elsewhere leaves a stale key until the executor's cleanup (if any) removes it — harmless, but don't read it as data.
- ⌘1–9 changed meaning in this release (groups, not tabs); the release note should say so.
- Visible ⇒ claim now applies to every group: a user who opens a four-group workspace takes four terminals from another client. That is intended; revisit only if takeover churn is reported.
