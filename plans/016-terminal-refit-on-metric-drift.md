# Plan 016: Refit terminal cells after metric drift to prevent overflow scrollbars

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 909575e..HEAD -- apps/web/src/components/workbench/terminal-pane.tsx apps/web/src/index.css apps/web/src/components/workbench/workbench.tsx`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `909575e`, 2026-07-20

## Requirement

The web terminal sometimes renders beyond its visible panel: the bottom line is clipped and xterm 6 shows both horizontal and vertical overlay scrollbars, as confirmed by the user. FitAddon’s cols/rows calculation is internally correct when run—flooring prevents overflow—but later changes to CSS cell dimensions do not trigger refitting when the host’s CSS size stays constant. ResizeObserver therefore misses two cases:

1. **Asynchronous WebGL attachment:** the initial rAF fit uses DOM-renderer measurements. Loading WebGL later rebuilds the glyph atlas and can change cell dimensions by subpixels, without another fit.
2. **devicePixelRatio changes:** browser zoom (Cmd +/-) or moving between displays with different scaling makes xterm round cell dimensions for the new dpr, while host CSS dimensions can remain unchanged.

Refit at both points so the terminal grid matches the visible area, eliminating overflow scrollbars and bottom-row clipping. Fix measurement synchronization, not layout or CSS clipping: overflow hidden would conceal the symptom while leaving cols/rows and PTY dimensions incorrect.

## Decisions & tradeoffs

- **Keep the fix inside terminal-pane.tsx’s mount-only useEffect**, reusing its existing `fit` closure. Metric drift belongs to each xterm instance. WorkspaceTerminal cannot observe WebGL attachment and would complicate per-instance dpr handling despite exposing controller fit. Evidence: `terminal-pane.tsx:166-178` already guards zero dimensions and catches fit errors; the mount effect runs once (`:111-113`).
- **Call fit() after successful `loadAddon(webgl)`.** xterm has no public metric-change event, and private APIs are unsuitable. The success path is inside the dynamic import’s try block after `terminal.loadAddon(webgl)` (`terminal-pane.tsx:151-164`).
- **Watch dpr with a resolution matchMedia query.** Build the query from devicePixelRatio, call fit() on change, then recreate the listener for the new dpr because the query is tied to the old value. Cleanup removes the current listener. Use the expression ``matchMedia(` (resolution: ${devicePixelRatio}dppx)`)``. Reject polling, which replaces an event signal with a timer, and window resize alone, since moving between monitors may not change CSS dimensions. VS Code also actively refits after dpr changes; the host ResizeObserver (`terminal-pane.tsx:245-246`) cannot detect them.
- **Leave CSS/layout untouched:** retain `.xterm { height: 100% }` (`index.css:261`) and host `px-3 py-2` (`terminal-pane.tsx:289`). Adding overflow hidden only hides the symptom.
- **Idempotent fit prevents redundant resize.** FitAddon calls terminal.resize only when rows/cols change, so the extra calls do not cause unnecessary ptyResize. onResize also requires active && owned (`terminal-pane.tsx:200-203`). Evidence: addon-fit 0.11.0 checks `if (this._terminal.rows !== dims.rows || this._terminal.cols !== dims.cols)`.

## Direction

One file, one milestone. Add fit after successful WebGL attachment inside the mount-only effect. Integrate dpr listener creation, replacement, and disposal with existing cleanup (`terminal-pane.tsx:249-257`). Its lifetime must match xterm’s: even though `host.isConnected` prevents a stale callback from fitting a disposed terminal, leaving the listener registered is still a leak.

### Milestone 1: Refit after metric changes

Fit once after WebGL attachment and after each dpr change; leave no listener after unmount. Validation: `pnpm --filter @coflux/web exec tsc -b` → exit 0.

## Landmines

- The fit gate `liveRef.current.active` (`terminal-pane.tsx:167`) intentionally makes inactive-pane fit a no-op. Hidden panes use display:none; activation already fits through the props.active effect (`:277-284`), using the updated measurements. Do not bypass the gate.
- The WebGL callback checks `disposed` and `terminal.element` (`terminal-pane.tsx:153`). The added fit must respect these checks and never act on a terminal disposed during async loading.
- `terminal.dispose()` also disposes addons (`terminal-pane.tsx:254`), but not matchMedia listeners. Remove those explicitly in effect cleanup.

## Scope

In scope:
- `apps/web/src/components/workbench/terminal-pane.tsx`

Out of scope:
- `apps/web/src/index.css` —  No problem with layout/CSS, do not hide overflow with clipping

- `apps/web/src/components/workbench/workspace-terminal.tsx` —  Fix ownership of single xterm instance

- Server/Protocol - ptyResize link itself is working fine

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm --filter @coflux/web exec tsc -b` | exit 0 |
| Manual acceptance (acceptance) | After opening the terminal, Cmd +/- to zoom and drag across displays with different zoom ratios | No unintended horizontal or vertical overflow scrollbars, complete bottom line |

## Done criteria

- [ ] Typecheck passed.

- [ ] There will be a refit after WebGL is mounted successfully; there will be a refit after the dpr is changed and the monitoring will be self-recursive rebuilding.

- [ ] No matchMedia monitoring remains after the component is unmounted.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The mount effect of terminal-pane.tsx is no longer a single execution with an empty dependency array (premise broken).

## Maintenance notes

- If overflow returns, investigate another unhandled metric change, such as font loading or changed xterm rounding: what changed cell dimensions without triggering fit? Start there rather than changing layout. Plan 013’s warning still applies: check #5096 for xterm 6 scrollbar behavior changes.
- If xterm later exposes public metric/renderer-change events, they can replace the self-replacing matchMedia listener.
