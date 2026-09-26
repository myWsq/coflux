# Plan 20260926-popover-no-drag: menus opened from the top tab strip are clickable and never drag the window

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 29f14f4f..HEAD -- apps/desktop/src/renderer/index.css apps/desktop/src/renderer/components/workbench/drag-region.ts apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx docs/design-guidelines.md`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (plain autopilot)
- Workspace: isolated — planned from the main worktree, moved to `.claude/worktrees/20260926-popover-no-drag` on `dev/20260926-popover-no-drag`
- Planned at: `29f14f4f`, 2026-09-26

## Requirement

In the desktop app (2.6.0), opening the ＋ menu in a top tab strip (「终端 ⌘T」/「浏览器」) shows the menu, but its items cannot be clicked, and pressing and dragging on the menu moves the whole window. The branch menu in the same strip (`BranchMenu`) is built the same way and is expected to have the same defect.

Cause: Astryx renders a layer (`DropdownMenu`, `Tooltip`, any `usePopover`/`useLayer` user) **inline at its JSX position** as a native `[popover]` element; it only portals out when an ancestor is in its `UNSAFE_HOSTS` list (`@astryxdesign/core/src/Layer/layerHost.ts`, `resolveLayerPortalTarget`). A menu whose trigger sits in the strip is therefore a DOM descendant of the strip `<header>`, which carries `-webkit-app-region: drag` (`workspace-terminal.tsx:825`). The menu inherits `drag` even though it paints in the top layer below the strip, so Electron treats its rectangle as window drag area and swallows pointer events. The trigger buttons already declare `no-drag` on the `<button>` (`workspace-terminal.tsx:204`, `:839`), but the popover is the button's sibling, not its descendant, so that hole does not cover it.

Done means: no Astryx layer ever counts as window drag area, wherever its trigger lives — present and future menus in drag regions work without each call site remembering anything. Empty strip space keeps dragging the window and double-click keeps the macOS title-bar behaviour (plan 108).

## Decisions & tradeoffs

- **One global rule makes every `[popover]` element `-webkit-app-region: no-drag`**, in `apps/desktop/src/renderer/index.css`, as an **unlayered** rule placed after the `@import` block. Rejected: passing `style={NO_DRAG_REGION_STYLE}` to each `DropdownMenu` — `style` lands on the inner `role="menu"` div, not on the popover viewport element that wraps it, and every future menu in a drag region would need to remember it; that per-call-site discipline is exactly what failed here. Rejected: forcing Astryx to portal to `document.body` — there is no public switch, and inline hosting is deliberate upstream (theme scope, tab order). Based on: `DropdownMenu.tsx` `popover.render(<div … style>…)` with a separate viewport `xstyle` (`@astryxdesign/core/src/DropdownMenu/DropdownMenu.tsx:936-990`); `useLayer.tsx:926,990` sets the `popover` attribute on the layer element.
- **The selector is `[popover]`, not an Astryx class or `:popover-open`.** It covers every layer (menus, tooltips, dialogs-as-popover) whether open or animating out, and does not depend on Astryx's generated StyleX class names. Tooltips becoming `no-drag` is accepted: they are transient and the only cost is that a press on a visible tooltip does not start a window drag.
- **Unlayered on purpose.** `index.css` declares cascade layers (`reset, theme, base, astryx-base, astryx-theme, components, utilities`); an unlayered rule outranks all of them, so nothing inside a layer can undo it. Based on: `apps/desktop/src/renderer/index.css:3`.
- **Document the pitfall where the drag-region rules already live**: the header comment of `apps/desktop/src/renderer/components/workbench/drag-region.ts` and the "Interactive elements over a window drag region" section of `docs/design-guidelines.md` (English). Both must state that `app-region` is inherited by DOM descendants — including Astryx layers rendered inline, which paint outside the drag element's box — and that the global `[popover]` rule is what keeps layers out of the drag area, so it must not be removed. Wording is the executor's call; the existing Chinese comment in `drag-region.ts` may be extended in Chinese or the new part written in English, matching the file's style.
- **No per-call-site changes.** Leave the `NO_DRAG_REGION_STYLE` on the trigger buttons (`workspace-terminal.tsx:204`, `:839`) as is — the button still needs its own hole.
- **No tests** (decided while planning): the behaviour is only observable in a real Electron window, and a test would restate a one-line CSS rule. Acceptance is manual by the user (project policy, `AGENTS.md` "Test harness").

## Direction

### Milestone 1: layers never belong to the window drag area

The global rule exists in `index.css` after the imports, and the two documents describe the inheritance pitfall and the rule. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop build` -> exit 0; `grep -n "popover" apps/desktop/src/renderer/index.css` shows the unlayered rule.

Single milestone; nothing to fan out.

## Landmines

- CSS requires every `@import` before other rules; putting the new rule above them (or above the `@font-face` blocks that already follow the imports) makes postcss-import skip later imports — see the comment at `apps/desktop/src/renderer/index.css:14-24`.
- Do not wrap the rule in any `@layer`; inside a layer, Astryx or Tailwind layers could outrank or reorder it.
- `-webkit-app-region` is not in React's `CSSProperties` and is not a Tailwind utility here; the global CSS is the only place a plain declaration works without a cast.

## Scope

In scope:
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/src/renderer/components/workbench/drag-region.ts` (comment only)
- `docs/design-guidelines.md`
- `wiki/plans/README.md`, this plan

Out of scope:
- Call sites in `workspace-terminal.tsx`, `branch-menu.tsx`, `workbench.tsx` — the global rule removes the need for changes there.
- `node_modules/@astryxdesign/*` — no patching of the design system.
- Release notes / version bump — release is a separate, user-initiated step.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` — open the ＋ menu and the branch menu in a top tab strip | items clickable; press-and-drag on the menu does not move the window; empty strip space still drags; double-click on empty strip still follows the macOS setting; in DevTools `getComputedStyle(document.querySelector('[popover]')).webkitAppRegion` (or `appRegion`) is `no-drag` while a menu is open |

## Done criteria

- [ ] Typecheck and build pass.
- [ ] `index.css` has one unlayered `[popover] { -webkit-app-region: no-drag; }` rule after the imports.
- [ ] `drag-region.ts` header comment and `docs/design-guidelines.md` explain inheritance by inline Astryx layers and point at the global rule.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- Astryx no longer renders layers as `[popover]` elements (`useLayer.tsx` changed).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- The fix relies on Chromium propagating `app-region` from a drag ancestor into inline-hosted layers; the user's report (menu below the 36px strip still drags the window) is the evidence. If a future Electron stops inheriting, the rule becomes harmless, not wrong.
- Any new non-Astryx overlay rendered inside a drag element (a hand-rolled absolutely positioned panel) is not covered by `[popover]` and needs its own `NO_DRAG_REGION_STYLE`.
