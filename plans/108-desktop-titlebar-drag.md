# Plan 108: Make desktop terminal headers and empty-state tops draggable, with native double-click actions

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c1e82cc..HEAD -- apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/main/window.ts apps/desktop/package.json`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: 106 (DONE on `dev/20260911-desktop-only-merge`, not merged to main; based on its tip `c1e82cc`; merge order 106 → 107 server-hosted satellite pages → 108. Renumbered from 107 after colliding with that day's satellite-page plan.)
- Category: bug
- Execution: subagent (host general-purpose subagent, `model: opus`; preflight recorded 2026-09-11; proceed automatically without further confirmation)
- Planned at: `c1e82cc`, 2026-09-11

## Requirement

Desktop (`apps/desktop`, Electron 44) hides the system title bar using `titleBarStyle: "hidden"`, embedding traffic lights at the top of the sidebar (`apps/desktop/src/main/window.ts:49-50`). With the title bar hidden, only CSS `-webkit-app-region: drag` regions move the window. Currently the only such region is the sidebar's 38px blank top strip (`sidebar.tsx:35-36`, `:233`). The user reports that dragging blank space in the terminal tab bar does not move the window, and double-click does not resize it. The terminal header has no drag declaration, unlike the macOS convention that an IDE's blank tab-bar space acts as its title bar.

### Product conclusions (confirmed during exploration; do not ask again)

- **Consumer and trigger**: desktop users can drag any blank part of the terminal header outside the branch button, Changes tab, terminal tabs, +, and right-hand port links. This includes trailing tab-list space, gaps between elements, and space around the port region. Double-clicking the same area follows macOS Desktop & Dock → Double-click a window's title bar: Fill / Zoom / Minimize / None, just like the sidebar strip.
- **All header interactions remain intact**: BranchMenu dropdown, Changes tab, each terminal tab (switching, port dropdown, hover close button), pending tabs, +, and port links remain clickable with working Tooltips. File-drop upload regions remain unaffected: dragging applies only to the header, not the terminal body.
- **Empty-state main-area tops**: add a 38px strip matching the sidebar at the top of the three user-visible main areas without headers: device-detail empty state (“Open a terminal on device”), optimistic creation (“Creating workspace”), and onboarding/selection (“Start with a project” / “Select a workspace”). Each supports dragging and native double-click. Existing centered New Terminal/Import Project buttons do not overlap the top strip and retain their behavior. The executor may optionally cover the two transient states, Suspense fallback and loader before the first snapshot.
- **Outside scope**: reconnect banner, login page, terminal body, Changes body. The user's separate report of a strange black strip below the terminal is explicitly deferred; do not touch it. Exploration findings are retained under Maintenance notes for future reference.
- **Acceptance**: the user manually checks the real desktop app for dragging, double-click actions, clickable buttons, and Tooltips. Under the existing agreement Claude does no UI walkthrough; neither executor nor verifier starts the app or browser.

## Decisions & tradeoffs

- **Drag mechanism**: use exactly the sidebar's CSS `-webkit-app-region: drag`, React inline key `WebkitAppRegion` with `as CSSProperties` (`sidebar.tsx:36`). Rejected: custom main-process/IPC/mouse-event dragging (`titleBarOverlay`, `performWindowDragWithEvent`, custom-drawn title bars). App-region is Electron's standard hidden-titlebar mechanism and requires no main changes. Based on: `apps/desktop/src/main/window.ts:49-50` (`titleBarStyle: "hidden"`, `trafficLightPosition`); `sidebar.tsx:35-36, 233`.
- **Leave double-click resizing to Chromium**: add no IPC, main-process changes, or renderer dblclick listener. Rejected: VS Code-style renderer dblclick → IPC → main reading `AppleActionOnDoubleClick` and maximizing/minimizing. Chromium's `NativeWidgetMacNSWindow sendEvent:` already handles left-button release with clickCount==2 in custom drag regions, honoring Fill / Zoom (`performZoom:`) / Minimize / None. Reimplementing would double-trigger; DOM dblclick is not delivered in drag regions anyway (see Landmines). Based on: Chromium `components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm` `sendEvent:`; Electron issue #16385 closed as fixed on 2025-01-17; current Electron `^44.3.0` in `apps/desktop/package.json`.
- **Make the whole header draggable and mark interactive children individually `no-drag`**: apply `drag` to `<header>` (`workspace-terminal.tsx:363`) and `no-drag` to each branch button, Changes tab, terminal tab item, pending tab, +, and port link. Rejected: making only trailing tab-list space draggable — gaps near branch/port controls remain unusable, and the region varies with tab count. Rejected: `no-drag` on the `overflow-x-auto` tab container (`:384`) — it includes the very blank space that must remain draggable. Based on: `workspace-terminal.tsx:363-539`.
- **Empty-state strip is a fixed-height empty element, not a draggable entire `<main>`**: reuse sidebar `DESKTOP_TITLEBAR_HEIGHT` (38). Rejected: making the whole empty main area draggable — it swallows buttons and text selection, requires individual exclusions, and violates macOS conventions. Based on: `workbench.tsx:645` (device empty state), `:673` (optimistic creation), `:689` (onboarding/selection); transient states at `:604` (Suspense) and `:685` (first-snapshot loader).
- **No runtime-mode gate**: after plan 106 the bridge is mandatory and there is no browser mode; the sidebar strip already renders unconditionally (`sidebar.tsx:233`). New declarations do likewise. Rejected: preserving/restoring `isDesktop()` checks — 106 removed the alternative mode.
- **Leave reconnect banner and login unchanged**: the banner is fixed at the top; the root adds `pt-7` (`workbench.tsx:577`, `:706`), shifting the header/empty state and their drag regions together. No special handling is needed.
- **No new tests** (decided during planning): these are style declarations, while renderer unit tests are DOM-free `node --test` logic tests. There is no behavior for them to assert. No tests are required even if extracting shared constants. Rejected: CSS snapshots/DOM tests requiring jsdom or other dependencies without benefit.

## Direction

The two milestones are independently verifiable, but both may depend on extracting sidebar drag constants. **Execute one work package rather than splitting.** Design against live code; the following specifies outcomes, not a predetermined patch.

### Milestone 1: Draggable terminal header

Declare the full `<header>` in `workspace-terminal.tsx` as `drag`; mark each interactive element from the product list as `no-drag`. Apply exclusions to elements that actually produce layout boxes; inspect Astryx Tooltip/DropdownMenu source or DOM structure to determine whether wrappers do so. The executor may choose whether/where to extract shared sidebar constants, but 38 must have a single source.
Validation: `pnpm -C apps/desktop typecheck` → exit 0; `pnpm -C apps/desktop test` → exit 0.

### Milestone 2: Empty-state top strips

Each of the three user-visible empty-state `<main>` elements in `workbench.tsx` gets a 38px empty `drag` element at its top. Existing content remains vertically centered in the remaining area, or overall provided no button overlaps the strip. Transient states are optional.
Validation: `pnpm -C apps/desktop typecheck` → exit 0; `pnpm -C apps/desktop build` → exit 0.

## Landmines

- **Drag regions consume all pointer events** (Electron #37789, open, confirmed on macOS): DOM receives no click/dblclick/mouseenter there. Missing `no-drag` makes controls unclickable and disables Tooltips/hover. Check BranchMenu (`workspace-terminal.tsx:366`), Changes button (near `:395`), terminal-tab group div (near `:445`, including port DropdownMenu `:461` and close Tooltip `:479`), pending tab (`:491`), + (`:513-516`), and port links (`:525`).
- **`no-drag` with `overflow-x-auto`**: Blink computes regions from layout rectangles. Mark individual children; rectangles of offscreen tabs fall outside the container harmlessly. Do not exclude the container itself.
- **React typing**: `CSSProperties` lacks `WebkitAppRegion`; the sidebar uses `as CSSProperties` (`sidebar.tsx:36`). Tailwind 4 arbitrary property `[-webkit-app-region:drag]` also works, but inline styles are the repository precedent. Choose one and do not mix.
- **Header and sidebar heights differ**: existing header `h-9` is 36px and sidebar strip 38px. No alignment change is needed; use 38 for empty-state strips.
- **New worktrees lack dependencies**: run `pnpm install --frozen-lockfile` at the worktree root during `dev:execute-plan` preflight. Desktop's test script includes `src/renderer/**/*.test.ts`.
- **Baseline is branch 106, not main**: renderer paths are `apps/desktop/src/renderer/...`, while main still has `apps/web`. Do not use main's paths/content; merge 106 before 108.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx` (only to extract shared drag constants)
- An optional shared constant module under `apps/desktop/src/renderer/components/workbench/`, named by the executor
- `plans/108-desktop-titlebar-drag.md`, `plans/README.md`

Out of scope:
- `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`, `apps/desktop/src/shared/**` — Chromium/Electron handles dragging and double-click natively; no main changes
- Reconnect banner, `AuthShell` login, `terminal-pane.tsx` body, `index.css` — outside the requirement
- Black strip below the terminal — deferred by user
- `packages/client`, `apps/ios`, server, daemon — unrelated

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0; baseline 67 tests, no reduction |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Real-machine walkthrough (manual acceptance) | User packages/starts desktop: drag blank header space, double-click follows system preference, header controls click/hover, all three empty-state tops drag | User confirmation |

The repository has no lint script.

## Done criteria

- [ ] All listed commands pass.
- [ ] Entire terminal `<header>` is `drag`; every interactive item in the product list is `no-drag`.
- [ ] Three user-visible empty-state `<main>` elements each have a 38px `drag` strip; no buttons overlap it.
- [ ] No main/preload/shared changes; no renderer dblclick listeners or window-resize logic.
- [ ] Height 38 has one source: reused or extracted `DESKTOP_TITLEBAR_HEIGHT`.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds, especially `window.ts` no longer using `titleBarStyle: "hidden"` or a changed sidebar drag mechanism.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- Every future clickable header element must carry `no-drag` or it becomes unclickable in desktop. Leave a comment at the header explaining this.
- Reassess drag-region requirements and double-click behavior if `titleBarStyle` changes or `titleBarOverlay` is introduced.
- Deferred black-strip findings (unfixed): xterm 6.0 `.xterm-viewport` remains black `#000`; theme background reaches only the new scrollable element. FitAddon 0.11 computes rows from host border-box height without deducting padding, so rendered content covers the viewport bottom. Black can show only as a 2–9px right-side vertical strip, not a bottom horizontal strip. The same cause can clip the final row by up to 8px at the window bottom. A bottom horizontal strip is more likely an Electron 44 / `titleBarStyle: "hidden"` window-layer issue on macOS 27, but its cause is not established.
