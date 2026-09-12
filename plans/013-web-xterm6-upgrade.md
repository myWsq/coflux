# Plan 013: Upgrade web xterm.js from 5.5 to 6.0 to match server-side headless 6.0

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat d8b3237..HEAD -- apps/web/package.json apps/web/src/components/workbench/terminal-pane.tsx pnpm-lock.yaml`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: migration
- Execution: subagent sonnet
- Planned at: `d8b3237`, 2026-07-19

## Requirement

apps/web still uses `@xterm/xterm` 5.5, while the server terminal mirror (commit 69e132a, apps/server/src/mirror.ts) generates snapshots using `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0. Production therefore serializes with headless 6.0 and replays in frontend 5.5. This works but should not remain the long-term arrangement.

Upgrade apps/web to `@xterm/xterm` ^6.0.0, `@xterm/addon-fit` ^0.11.0, and `@xterm/addon-webgl` ^0.19.0, matching the server generation. Preserve input/output, attach snapshot replay, tab switching, WebGL rendering/fallback, and resize/fit.

Scope the change to dependency upgrades and strictly necessary compatibility adaptations. Do not refactor terminal-pane.tsx, change themes/fonts/options, or add search/web-links or other addons. Expect three package.json version changes plus the lockfile; adapt code minimally only if compilation or runtime reveals incompatibility.

## Decisions & tradeoffs

- **Stay with xterm.js and upgrade to 6.0 instead of switching to ghostty-web.** coder/ghostty-web offers an API-compatible modern alternative, but remains a 0.4.0 proof of concept: its author reports unoptimized performance, no WebGL renderer, and untested Chinese IME. Drop-in compatibility makes a later switch inexpensive. Replacing a production terminal with a POC offers little value for this agent command center. Evidence: research and user confirmation on 2026-07-19; memory/terminal-mirror.md also requires IME testing before any switch.
- **Upgrade only the three web packages:** `@xterm/xterm` ^6.0.0, `@xterm/addon-fit` ^0.11.0, and `@xterm/addon-webgl` ^0.19.0. Server `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0 already match and need no changes. Evidence: apps/server/package.json uses headless ^6.0.0; apps/web/package.json uses xterm ^5.5.0.
- **Expect no source changes; adapt minimally only for demonstrated incompatibility.** Exploration compared every 6.0 breaking change with terminal-pane.tsx, the only usage site, and found no overlap. Used options (`allowProposedApi/convertEol/cursorBlink/cursorStyle/fontFamily/fontSize/lineHeight/scrollback/theme`) and APIs (`open/write/writeln/reset/clear/focus/loadAddon/dispose/onData/onResize/cols/rows/element`) remain supported. The project uses none of the removed windowsMode, fastScrollModifier, overviewRulerWidth, canvas renderer, or alt→ctrl hack. `@xterm/xterm/css/xterm.css` remains importable because the package has no exports restriction. Proactive refactoring would expand regression risk without evidence. Sources: `apps/web/src/components/workbench/terminal-pane.tsx:62-90` and 6.0.0 release notes #5105/#5462/#5107/#5346/#5104.
- **The 6.0 companion addons no longer declare peerDependencies**: fit 0.11.0 and webgl 0.19.0 package.json files contain no peerDependencies; the `^5.0.0` peer constraint from the 5.x era caused installation conflicts that do not exist in the new versions, so no pnpm peer configuration is needed. Based on unpkg, `@xterm/addon-fit@0.11.0`, `@xterm/addon-webgl@0.19.0` package.json (Verified on 2026-07-19).

## Direction

One milestone: update the three versions in `apps/web/package.json`, run `pnpm install` to refresh the lockfile, and build. If tsc/Vite exposes a 6.0 type/API incompatibility, adapt terminal-pane.tsx minimally and report each adaptation with its upstream cause.

### Milestone 1: Dependencies upgraded and build passed

Set `@xterm/xterm` ^6.0.0, `@xterm/addon-fit` ^0.11.0, and `@xterm/addon-webgl` ^0.19.0 in `apps/web/package.json`; synchronize `pnpm-lock.yaml` without unrelated dependency changes. Validation: `pnpm --filter @coflux/web build` → exit 0, including tsc -b and Vite.

## Landmines

- **#5096’s scrollbar/viewport rewrite is the only substantial 6.0 behavior change.** Its VS Code-style overlay scrollbar changes scrolling and appearance. Acceptance must manually verify three cases: scroll position after server-mirror replay (ordinary pty_output, see apps/server/src/hub.ts); fit and scroll position after showing tabs hidden with `display: none` (`terminal-pane.tsx:185-190`); and scrolling with `scrollback: 10_000` (`terminal-pane.tsx:70`) plus scrollbar appearance on the `#0a0a0a` theme. These checks belong to the verifier, not the executor.
- **Keep WebGL dynamically imported into a separate chunk** (`terminal-pane.tsx:96-109`). Confirm Vite still splits it and resolves `@xterm/addon-webgl` after upgrading. If 0.19 changes its size substantially, optionally update the existing "about 247KB" comment.
- **Black-box testing requires local Postgres direct port**: `pnpm -C tests test` requirement `COFLUX_TEST_PG_URL` points to 54322 (5432 of supavisor will report tenant error), and pretest will compile Rust. Belongs to the acceptance layer and is run by the verifier.

## Scope

In scope:
- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/src/components/workbench/terminal-pane.tsx` (only when 6.0 is incompatible and requires minimum adaptation)

Out of scope:
- `apps/server/**` —  The headless side is already in 6.0, no need to change
- Add any xterm addon (search/web-links/serialize, etc.) - this time only version alignment is done
- Refactoring of terminal-pane.tsx, theme/option adjustment - no changes that are not necessary for upgrading will be made
- Kitty keyboard protocol / Shift+Enter support — 6.1 feature, separate requirement

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| black-box e2e (acceptance) | `COFLUX_TEST_PG_URL=<54322 direct connection URL> pnpm -C tests test` | exit 0 |
| Terminal behavior manual acceptance (acceptance) | `pnpm dev` and then press the three-point check of Landmines Article 1 | No behavioral regression |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` exit 0.
- [ ] The three dependency version numbers are as listed in Decisions, and the xterm 5.5.0 related entries in the lockfile disappear.
- [ ] No changes except for the files in Scope; if there are changes in terminal-pane.tsx, each location will correspond to an upstream breaking change and be listed in the report.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The amount of adaptation exceeds the "minimum adaptation" level (if the source code other than terminal-pane.tsx needs to be modified, or a single file changes more than ~30 lines) - it indicates that the 6.0 compatibility assessment is wrong, and must be reported rather than forcing the change.

## Maintenance notes

- Starting from 6.0, the scroll bar is VS Code overlay style; if there are subsequent bug reports related to terminal scrolling, first suspect #5096 behavioral differences rather than the logic of this project.
- ghostty-web remains in the watch list (memory/terminal-mirror.md): it will be re-evaluated after switching to the Ghostty RenderState API and releasing a stable version. The Chinese IME must be tested before changing. The API is compatible with xterm.js drop-in, and the migration cost will be about the same as changing the import.
- 6.1 will bring the Kitty keyboard protocol (Shift+Enter, etc. in the web terminal) as a separate item if needed.
