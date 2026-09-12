# Plan 030: Basic responsive web support for all existing features on phones

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 096812c..HEAD -- apps/web/`

## Status

> **WITHDRAWN 2026-07-23**: The direction changed after this plan was written and dispatched. Instead of adapting desktop web responsively, build a separate streamlined companion app designed for mobile, with a subset of desktop features. This plan produced no commits. Its findings—iOS long press does not dispatch contextmenu, visualViewport handles the on-screen keyboard, and Astryx MobileNav works without AppShell—remain relevant to the new mobile plans.

- Priority: P1
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `096812c`, 2026-07-23

## Requirement

The web client assumes a desktop: its root hardcodes `min-w-[1024px] min-h-[640px]`, the sidebar remains visible on the left, and many actions require hover or right-click. At roughly 390px wide, iOS Safari/Android Chrome show only the upper-left corner and are effectively unusable.

All existing features must work on phones: login, a drawer sidebar with every project/workspace/device action including context-menu-only rename/remove, terminal input/output and tabs, changes/diff view, import wizard, and dialogs. The on-screen keyboard must not cover the terminal input line. Desktop layout and behavior at ≥768px remain unchanged.

“Basic adaptation” makes existing features accessible on phones without designing mobile-specific gestures, bottom navigation, or terminal typography. Merely squeezing the page onto a narrow screen while retaining horizontal scrolling or unreachable hover actions is insufficient: every existing feature needs a touch-accessible entry and correct viewport sizing.

## Decisions & tradeoffs

- **One breakpoint at 768px**: use Tailwind `md:`. Below md, use mobile layout; at/above md, preserve the current appearance. Retain `min-w-[1024px]`/`min-h-[640px]` behind `md:` rather than deleting them. Rejected: multiple progressive breakpoints; this basic adaptation needs no intermediate tablet state. Both the root at `apps/web/src/components/workbench/workbench.tsx:233` (`flex h-screen min-h-[640px] min-w-[1024px]`) and authenticating branch at line 208 (`h-screen min-w-[1024px]`) need handling.
- **Mobile sidebar as a drawer**: below `<md`, replace permanent `<aside>` with Astryx `MobileNav`, externally controlled through `isOpen`/`onOpenChange` without AppShell. Its ReactNode children reuse sidebar content. Do not render the resize handle; use MobileNav `width` (default 320, capped at 85vw). Close on workspace selection; use Astryx `useMediaQuery` for the breakpoint. Rejected: handwritten drawers or bottom navigation, since components exist and bottom navigation changes information architecture. See `apps/web/src/components/workbench/sidebar.tsx:182-184` (`<aside>`, `style={{width}}`), 419-434 (handle), and `pnpm exec astryx component MobileNav`.
- **Drawer entry**: below `<md`, add a hamburger button at the left of WorkspaceTerminal’s header. The “No workspace selected” page (`workbench.tsx:276-291`) lacks a header and also needs an accessible entry, positioned by the executor. The drawer must open from every main-page state. See `apps/web/src/components/workbench/workspace-terminal.tsx:433` and its `<header>`.
- **Viewport height**: replace `h-screen` with `h-dvh` on the workbench root and sidebar aside. Add viewport `interactive-widget=resizes-content` for Android Chrome. Since iOS Safari ignores it, listen to `visualViewport` `resize` and clamp root height to `visualViewport.height`, restoring it after keyboard dismissal (roughly 10–15 lines). No platform branch is needed if desktop behavior stays unchanged. Existing ResizeObserver refits the smaller terminal. Rejected: adding only metadata while leaving iOS input obscured. See `apps/web/index.html:6` and `apps/web/src/components/workbench/terminal-pane.tsx:385-387`.
- **Expose hover buttons on touchscreens**: inline `opacity-0 group-hover:opacity-100` actions—workspace delete, device remove, project +, and terminal-tab close—remain visible on coarse pointers through `pointer-coarse:opacity-100`, supported by Tailwind ^4.3.2. Rejected: JS touch detection; CSS has no runtime cost. See `apps/web/src/components/workbench/sidebar.tsx:345`, `sidebar.tsx:407`, and `workspace-terminal.tsx:518`.
- **Expose context-menu-only actions**: add a `pointer-coarse` ellipsis button opening Astryx `DropdownMenu` for project Remove, workspace Rename, and device Rename, with the same items as their ContextMenus. Rejected: long-press contextmenu, which iOS Safari does not dispatch. See `apps/web/src/components/workbench/sidebar.tsx:217-224`, 279-288, and 387-395.
- **Fit dialogs/wizard to narrow screens**: Astryx Dialog `width` accepts CSS strings. Replace fixed widths—400/400/480/380/400 in dialogs.tsx and 520 in import-project-wizard.tsx—with `min(<original value>px, calc(100vw - 32px))`, changing nothing else. Rejected: fullscreen variants, unnecessary for the content and broader in scope. See `apps/web/src/components/workbench/dialogs.tsx:40,105,183,268,294`, `apps/web/src/components/workbench/import-project-wizard.tsx:287`, and `width: number | string` in `pnpm exec astryx component Dialog`.
- **Constrain error toasts** (decided while planning): `fixed bottom-4 right-4 max-w-md` (`workbench.tsx:302`) can overflow a 390px viewport. Add `left-4 sm:left-auto` or an equivalent constraint.
- **Excluded**: terminal typography/gesture tuning, mobile keyboard shortcuts, desktop layout changes, and rearranging the changes view. Shortcuts naturally do nothing without a hardware keyboard; hiding their hint is optional minor polish. The changes view already uses vertical flow and hunk `overflow-x-auto` (`changes-view.tsx:166-214`).

## Direction

Use React 19, Tailwind v4, and Astryx. Prefer responsive/interaction variants (`md:`, `pointer-coarse:`) for styles and existing MobileNav/DropdownMenu/useMediaQuery components. Only iOS visualViewport needs imperative code. Constrain mobile changes to `<md`/`pointer-coarse` to protect desktop behavior.

### Milestone 1: Viewport and Root Layout

Mobile has no horizontal overflow and correct height; desktop ≥768px retains `min-w-[1024px]`. Change both h-screen instances to h-dvh, scope min-width/min-height with `md:`, and add viewport metadata plus the iOS visualViewport fallback. Validation: `pnpm --filter @coflux/web build` exits 0.

### Milestone 2: Sidebar drawer

Below md, use the MobileNav drawer with entry points in both header and empty state, closing after selection. At `≥md`, retain permanent aside and resize behavior. Validation: the same build passes.

### Milestone 3: Reachable by touch screen

Hover-reveal actions stay visible with `pointer-coarse`; all three context-menu row types gain ellipsis DropdownMenu alternatives. Validation: the same build passes.

### Milestone 4: Dialog/wizard/toast narrow screen adaptation

Cap all six dialog widths with min(); prevent toast overflow. Validation: the same build passes.

## Landmines

- iOS Safari long press **does not trigger** the `contextmenu` event (Android Chrome does), so ContextMenu is completely unreachable on iOS touch screens - don't try to solve touch screen entry problems with long presses.
- `terminal-pane.tsx:240-252` deliberately skips fit for zero-sized hidden instances, avoiding 2×1 resize corruption of remote PTYs. visualViewport resizing uses normal ResizeObserver fitting. Do not hide visible terminals with `display:none` as a layout-switching shortcut.
- The resize handle at `sidebar.tsx:419-434` captures pointers and changes global cursor state. Omit it from mobile rendering instead of merely disabling it.
- `MobileNavToggle` requires AppShell, which this app does not use. Use a normal hamburger button controlling `isOpen`.
- Handle both independent `h-screen min-w-[1024px]` layouts in workbench.tsx: authenticating at line 208 and the main layout at 233. Missing the former causes a horizontal-overflow flash during refresh.
- Preserve the existing keepalive structure (`contents`/`hidden` at workbench.tsx:258-273) and workspace-terminal attach state machine; they are unrelated to this change.

## Scope

In scope:

- `apps/web/index.html`
- `apps/web/src/index.css`
- `apps/web/src/components/workbench/workbench.tsx`
- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/terminal-pane.tsx`
- `apps/web/src/components/workbench/dialogs.tsx`
- `apps/web/src/components/workbench/import-project-wizard.tsx`
- `apps/web/src/components/workbench/changes-view.tsx` (only minor changes necessary)

Out of scope:

- `apps/server`, `crates/`, `packages/protocol` — pure front-end layout adaptation, not involving protocols and servers
- Any visible behavior change on desktop (≥768px) - the regression boundary of this plan
- Terminal font size/gesture/mobile exclusive interaction design - outside the boundaries of "simple adaptation", follow-up plans will be made

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| Mobile UI acceptance (acceptance) | Playwright MCP, 390×844 touch screen viewport through the main process: login → drawer selection workspace → terminal tab addition, deletion and cut → touch screen entry (rename/remove) → change view → import wizard/dialog box | All functions are accessible and available, no horizontal scrolling |
| Desktop regression (acceptance) | Playwright MCP, 1440×900 viewport vs. current status | Layout consistent with status quo |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` passed.
- [ ] At 390px, there is no horizontal scrolling; the drawer exposes all sidebar actions, including context-menu rename/remove; terminal creation/switching/closing works; dialogs and the import wizard fit the viewport.
- [ ] ≥768px viewport: Layout and behavior consistent with baseline (including min-w-[1024px] behavior and drag width).
- [ ] viewport includes `interactive-widget=resizes-content`; the iOS visualViewport fallback exists without changing desktop behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Astryx MobileNav cannot be used outside AppShell control (contradictory to component docs).

## Maintenance notes

- All mobile branches are hung under `md:`/`pointer-coarse:` conditions. When reviewing, the "desktop diff" is Zero behavioral change" is the red line.
- The web does not have a unit test infrastructure. The verification of this plan relies on build + Playwright acceptance; if component testing is introduced in the future, Drawer opening and closing and visualViewport logic are the first candidates.
- xterm.js mobile IME/soft keyboard input quality is the upstream capability boundary (see top of terminal-pane.tsx IME workaround comment), this plan only guarantees that "the input line is visible and the input can be delivered".
