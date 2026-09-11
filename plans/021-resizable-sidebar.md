# Plan 021: Resizable sidebar with persistent width

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8cf04db..HEAD -- apps/web/src/components/workbench/sidebar.tsx apps/web/src/components/workbench/workbench.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/web/src/config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent
- Planned at: `8cf04db`, 2026-07-20

## Requirement

The workbench sidebar is fixed at 260px. Long project, branch, or device names cannot be given more room, and users cannot narrow it to prioritize terminals. Support resizing from its right edge.

Keep a 260px default and allow continuous dragging from a wide right-edge hit area, clamped to 200–480px. Give subtle divider feedback, persist the released width across refresh/reopening, and reset/persist 260px on double-click. This is pointer-only interaction without a focusable keyboard width control. The terminal refits automatically; existing clicks, context menus, scrolling, and text truncation remain intact.

Correctness boundary: change actual flex width, not only the divider; persist the result; enforce 200–480px; continue dragging after the pointer leaves the 1px border. A split-pane dependency or PTY protocol change would be excessive.

## Decisions & tradeoffs

- **Use default 260px, minimum 200px, maximum 480px.** Reject 180–600px because the list gets cramped at one extreme and consumes too much terminal space at the other. Viewport-relative bounds make persisted width less predictable across screens. Evidence: `w-[260px]` at `apps/web/src/components/workbench/sidebar.tsx:74` and Workbench’s 1024px minimum viewport (`apps/web/src/components/workbench/workbench.tsx:226`).
- **Persist in localStorage; validate finite numbers and clamp to 200–480px on read.** Resetting on refresh would violate IDE-layout expectations. Use a coflux_* key beside existing config constants. Evidence: `TOKEN_KEY`/`WORKSPACE_KEY` at `apps/web/src/config.ts:5-6` and lazy localStorage initialization at `apps/web/src/components/workbench/workbench.tsx:33`.
- **Keep width as Sidebar-local view state.** The parent flex naturally consumes it; server or cross-browser synchronization adds no value. Avoid Workbench prop wiring and mixing local layout into the Zustand server-state store. Sidebar already owns project-collapse state (`apps/web/src/components/workbench/sidebar.tsx:33-44`); Workbench handles business/cross-component wiring (`apps/web/src/components/workbench/workbench.tsx:227-241`).
- **Use a custom Pointer Events edge handle.** Provide about 6px of transparent hit area, with the line highlighted only on hover/active. Continue dragging outside the edge and suppress accidental text selection. Native `resize: horizontal` has an uncontrollable corner handle; a split-pane library is unnecessary for one sidebar. The current edge is only border-r (`apps/web/src/components/workbench/sidebar.tsx:74`), with no existing resizer dependency.
- **Double-click resets to 260px; support pointer drag only.** Arrow/Home/End adjustment was explicitly excluded in preflight. Keep the handle out of Tab order and do not claim full keyboard-separator semantics.
- **Persist on drag completion and double-click reset, not every pointermove (decided during planning).** localStorage is synchronous; frame-by-frame writes add needless work. Updating storage from every state-change effect has the same problem. Update view state while dragging and commit only the final width.
- **Reuse TerminalPane’s existing ResizeObserver.** Sidebar width changes alter the adjacent flex item; its host observer calls fit, and the active owned terminal sends onResize through existing PTY logic. Explicit Sidebar-to-terminal callbacks or protocol changes duplicate that mechanism. Evidence: `apps/web/src/components/workbench/terminal-pane.tsx:216-228,245-252,295-297`.

## Direction

Keep Workbench’s horizontal flex structure. Sidebar applies its local persisted width to the actual `<aside>` and overlays a right-edge drag layer without consuming content space. Handle start, move, end, cancel, and unmount cleanup, validating/clamping final values consistently. Retain the static border and add feedback on that same edge without a permanently visible icon.

### Milestone 1: Persistent, resettable Sidebar width interaction

Allow continuous 200–480px dragging with a 260px fallback for invalid/missing storage. Persist on release, restore on refresh, and reset/persist on double-click. Provide clear hit area/cursor/hover feedback, retain dragging beyond the edge, prevent text selection, and leave no listeners or global cursor/user-select changes after unmount. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 2: Regression and real layout acceptance

Preserve project/workspace/device interactions. Drag to both limits without exceeding them; active xterm must adapt without persistent size mismatch. Validation: web build and full black-box suite in Commands exit 0, plus the listed browser observations.

## Landmines

- **Terminal fit already has zero size/hidden workspace guard**: Do not bypass the `fit()` guard of `TerminalPane` to trigger PTY resize directly from the Sidebar, otherwise it may clamp the hidden keepalive terminal to 2×1 and pollute the remote TUI. Based on: `apps/web/src/components/workbench/terminal-pane.tsx:216-227`.
- **There is not only a normal pointerup at the end of dragging**: the browser/system may issue a pointercancel, and the component may also be unmounted when the login status changes; any temporary monitoring, pointer capture or global cursor/user-select changes must be cleaned up in these paths, otherwise unselectable text or resize cursors will remain on the entire page.
- **The persistent value is an untrusted string**: `Number(...)` may get `NaN`/`Infinity`. Old versions or manual modifications may be out of bounds; neither initialization nor final submission can write illegal widths into inline style.
- **The current repository does not have a web DOM unit test framework**: `apps/web/package.json:6-9,27-35` only has dev/build/preview and build dependencies, and there should be no new test framework for this small change. Interaction correctness is covered by browser acceptance, static typing and production builds take care of mechanical verification.

## Scope

In scope:

- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/config.ts`
- `plans/README.md`

Out of scope:

- `apps/web/src/components/workbench/workbench.tsx` — The existing flex layout is enough to consume the Sidebar width, no need to add new controlled props
- `apps/web/src/components/workbench/terminal-pane.tsx`, `workspace-terminal.tsx` — existing ResizeObserver/fit pipeline should be reused directly
- `apps/web/package.json`, lock file - no new split-pane, test or gesture dependencies
- Keyboard direction keys/Home/End width adjustment, folding Sidebar, responsive mobile drawer - preflight clarification not selected, separate requirement
- Server, protocol, daemon, PTY resize line format - this requirement is a pure web layout state

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Web type checking + production build | `pnpm --filter @coflux/web build` | exit 0 |
| Repository black-box regression (acceptance) | `pnpm -C tests test` | exit 0 |
| UI acceptance (acceptance) | Start local stack and web, operate in Workbench with projects, workspaces and active terminals Sidebar | Default 260px; can be dragged to but not beyond 200/480px; recover after letting go and refresh; double-click to return to 260px and refresh is still 260px; hover/active highlighting and resize The cursor is correct; the dragged edge is still continuous; text is not accidentally selected; lists, right-click menus, and scrolling are normal; active xterm automatically fits |

## Done criteria

- [ ] All listed commands pass.
- [ ] When there is no valid stored value, the Sidebar is 260px; the valid stored value is restored after refreshing; illegal, non-finite or out-of-bounds values are safely dropped/clamped to the contract range.
- [ ] Dragging is continuous, limited to 200–480px, normal end and cancel/unmount paths have no monitoring, pointer capture or global style residue.
- [ ] The hit area about 6px from the right edge provides resize cursor and hover/active highlighting; does not increase resident visual noise and does not enter the keyboard Tab order.
- [ ] Persistence final width after pointerup, pointermove high-frequency path does not write localStorage; double-click to restore and persist 260px.
- [ ] Sidebar has existing interaction without regression, and the active terminal automatically fits through the existing ResizeObserver.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files or new runtime dependencies.
- A validation command fails twice after one reasonable fix.
- The existing ResizeObserver cannot be triggered when the Sidebar width is adjusted, and the terminal life cycle/protocol must be changed to adapt correctly.

## Maintenance notes

- If you add Sidebar folding or mobile drawers in the future, you need to define their priority with the persistent width; the current width only describes the desktop expanded state.
- If keyboard width adjustment is added in the future, the handle should be upgraded to a complete, focusable separator with `aria-valuemin/max/now`, and the focus style should be redesigned; half-set keyboard semantics are currently not provided.
