# Plan 20261011-screen-resolution-presets: Choose the remote screen's resolution from a few presets

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat c78cdb71..HEAD -- apps/desktop/src/renderer/components/workbench/screen-view.tsx apps/desktop/src/renderer/components/workbench/screen-session.ts apps/desktop/src/renderer/config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: wiki/plans/20261010-screen-lane-frames.md (same branch; the screen tab only works with it)
- Category: feature
- Execution: subagent(opus) — departure check, 2026-10-11
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check
- Workspace: current — already in the linked worktree `.claude/worktrees/20261010-screen-lane-frames` on `dev/20261010-screen-lane-frames`; lands in PR #107
- Planned at: `c78cdb71`, 2026-10-11

## Requirement

Today the remote virtual display always follows the screen tab's size 1:1 in points, which gives odd resolutions (e.g. 1252×885) that lay remote apps out oddly, and re-lays out the remote whenever the window is resized. The user wants to pick the resolution from a few presets.

Product conclusions (confirmed by the user at the product gate; do not reopen):

- **Entry.** A resolution dropdown in the screen tab's status bar, labelled with the current choice (e.g. `1440×900 ▾`, or `跟随窗口 ▾`), placed left of 「沉浸」 and 「断开」.
- **Options.** 「跟随窗口」 (default — today's behaviour), then fixed sizes in points: 1280×800, 1440×900, 1512×982, 1728×1117, 1920×1080. Scale follows the local screen as today (`displayRequest`: 2× on a Retina screen).
- **Behaviour.** Picking an option changes the remote resolution at once, without reconnecting. On a fixed size, resizing the window or entering/leaving immersive mode only scales the picture; the remote resolution and its window layout stay. On 「跟随窗口」, behaviour is unchanged.
- **Memory.** The choice is remembered per remote device on this machine; reopening that device's screen (new tab, restart) uses it.
- **Non-goals.** Custom sizes; 1× presets; the controlled Mac's physical display mirroring mode (it drops to 800×600 — separate round).
- **Acceptance (user-observable).** Switching presets changes the remote resolution at once and the picture stays sharp; resizing the window on a fixed preset leaves the remote layout alone; closing and reopening the tab keeps the last choice.

## Decisions & tradeoffs

- **Controlling-side renderer only.** The fixed size is sent through the existing `screenSessionResize` (and as the size of `screenSessionOpen`). Rejected: protocol, runtime or helper changes — the helper already builds any requested geometry (`DisplayModeSelection.requested`, 320 pt … 8192 px) and resizes in place. Based on: `screen-session.ts` `setSize`/`applySize`/`sendOpen`; `native/screen/Sources/CofluxScreenCore/DisplayModeSelection.swift`.
- **The picture side needs no new scaling.** The canvas is `object-fit: contain` and pointer/cursor mapping already go through `drawnRect` against the remote display's points, so a remote size different from the tab displays letterboxed and clicks correctly. Based on: `screen-view.tsx` canvas (`objectFit: "contain"`), `drawnRect`, the pointer mapping using `display.widthPoints`.
- **Storage: one local record per (server, device), alongside the screen tab records.** Key scoped by server address like `SCREEN_TABS_KEY` (`apps/desktop/src/renderer/config.ts:43`); a missing, unparsable or unknown value means 「跟随窗口」. Wrap storage access so a throwing `localStorage` falls back to the default. Rejected: storing it in the tab record — the user asked for per device, surviving a new tab.
- **The dropdown uses the Astryx `DropdownMenu`** (as the ＋ menu does, `workspace-terminal.tsx:9,299`), with the checked option marked; Tooltip component only, never native `title` (`docs/design-guidelines.md`).
- **Presets live in one exported constant** so the list is defined once; the scale is still chosen from the local devicePixelRatio as `displayRequest` does.

## Direction

### Milestone 1: the status bar offers resolutions and the remote follows the choice

The status bar shows the dropdown; choosing a preset resizes the remote at once and pins it; 「跟随窗口」 restores following the tab size (and applies the current tab size at once). The choice is read when the tab's session is created and written when the user picks. The status-bar label reflects the choice (the existing resolution text in `phaseLabel`/status may stay or be folded into the dropdown label — executor's call, no duplicate). A pure helper resolving the stored value to a size request may get a small test only if it pins storage parsing (unknown/garbage → follow), not a restatement.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

One milestone; nothing to fan out.

## Landmines

- In immersive mode the status bar slides in at the window's top edge, which is a drag region: the dropdown trigger (and anything new clickable there) must be `no-drag` like the existing buttons' context, and later in document order than the drag area (`apps/desktop/src/renderer/components/workbench/drag-region.ts:9-37`). A global `[popover]` no-drag rule exists for popovers; check the menu is clickable in immersive mode.
- While the picture has keyboard focus, every key goes to the remote and menu accelerators are suppressed (`setIgnoreMenuShortcuts`). Opening the dropdown moves focus out of the picture; make sure choosing an option does not leave the picture believing it still has focus (stuck keys are released on blur — `releaseAll`), and that focus returns sensibly.
- `applySize` skips sending when the wanted size equals the applied one; switching from a fixed preset back to 「跟随窗口」 must send the current tab size, not wait for the next ResizeObserver callback.
- `flushSize` is called on immersive enter/leave; on a fixed preset it must not resize the remote.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/screen-view.tsx`
- `apps/desktop/src/renderer/components/workbench/screen-session.ts`
- `apps/desktop/src/renderer/components/workbench/screen-runtime.ts` (only if the choice must be passed through it)
- a new small module under `apps/desktop/src/renderer/components/workbench/` for presets and the per-device record, with an optional test
- `apps/desktop/src/renderer/config.ts` (the storage key)
- `docs/remote-screen.md` (one line on the resolution choice)

Out of scope:
- `native/screen`, `crates/`, `proto/`, `apps/server`, `packages/`, `apps/desktop/src/main` — nothing on the wire or in main changes
- the physical display's mirroring mode on the controlled Mac
- `wiki/plans/` (the orchestrator updates it)

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Side-by-side packed app on Work (acceptance) | as in `wiki/plans/20261010-screen-lane-frames.md`, "Acceptance: quick two-Mac check" | the acceptance list under Requirement holds |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] The dropdown offers 跟随窗口 + the five presets, marks the current one, and is clickable in tab and immersive mode.
- [ ] A fixed preset is sent at once and is not changed by tab resizes or immersive toggles; 跟随窗口 resumes following immediately.
- [ ] The choice persists per (server, device) and an absent/garbage value means 跟随窗口.
- [ ] Implementation follows every entry in Decisions & tradeoffs; no out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
