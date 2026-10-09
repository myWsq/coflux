# Plan 20261009-annotator-vivid-colours: annotate-mode overlays are visible on any page

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 65a2c22a..HEAD -- apps/desktop/src/main/browser-annotator-page.ts apps/desktop/src/main/browser-annotator.ts apps/desktop/src/main/browser-annotator-policy.ts apps/desktop/src/main/browser-annotator-policy.test.ts apps/desktop/src/shared apps/desktop/src/renderer/desktop-bridge.ts apps/desktop/src/renderer/components/workbench/browser-annotations-ui.tsx apps/desktop/src/renderer/components/workbench/browser-view.tsx apps/desktop/src/renderer/components/workbench/changes-comments-ui.tsx`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit chosen)
- Plan review: audit — departure check
- Workspace: isolated — the session was on the main worktree (clean); moved to `.claude/worktrees/20261009-annotator-vivid-colours` on `dev/20261009-annotator-vivid-colours`
- Planned at: `65a2c22a`, 2026-10-09

## Requirement

In the desktop built-in browser's annotate mode (⌘⇧D), everything the page script draws over the page — the hover box and its label (e.g. `div.card 320×200`), the pick/anchor box, ⇧-click multi-select boxes, the ⇧-drag region box, annotation outlines and the numbered pins — is close to invisible. They are coloured with the app theme's `--color-accent`, and the app uses astryx `theme-neutral`, whose accent is greyscale (`light-dark(#1b1b1b, #f1f1f1)`; `index.css` also defines `--accent: #262624`). In dark appearance that means near-white boxes with a 10 % fill on white pages; in light appearance near-black boxes on dark pages. The label is grey text on grey.

Product conclusions (confirmed by the user):

1. Every page overlay — hover box and hover label, pick/anchor box, ⇧-click multi-select, ⇧-drag region, outlines, pins — uses a fixed **magenta `#E6007A`** with **white** text. Resolved pins use a fixed **vivid green `#14AE5C`** with a white ✓.
2. The boxes carry a thin **white outer ring** (about 1 px) so they stand apart from any page background, including magenta-ish or busy ones.
3. The **number badges** that mirror a pin in the app's own UI — in the side panel rows and in the draft / detail card headers of browser annotations — use the same two colours, so a pin and its row always match.
4. The colours are **fixed**: they no longer follow the app's light/dark appearance.
5. Non-goals: the app's own UI around annotations (cards, panel, toolbar, hint pill) keeps its colours; overlay shapes, line widths, dashes, radii, positions and every interaction stay as they are. Diff-line comments in the 「文件」/「变更」 view are not part of this change.
6. What the user observes when done: in both dark and light app appearance, on a white page, a dark page and a blue-background page, the hover box, the label text, the selected/region boxes, outlines and pins are clearly visible at a glance.

## Decisions & tradeoffs

- **Fixed overlay palette, not the theme**: overlays are drawn on arbitrary third-party pages whose colours have nothing to do with the app theme, so their colours are constants: accent `#E6007A`, on-accent `#FFFFFF`, success `#14AE5C`, on-success `#FFFFFF`, plus white for the outer ring. Rejected: keep following the theme and pick a more saturated theme token — the neutral theme has no saturated accent, and any theme-derived colour can still vanish against a page. This **reverses** plan `20260929-annotation-polish`'s decision "Colours come from the theme, passed in the annotator state" and its done criterion "The page script contains no hard-coded palette" (`wiki/plans/20260929-annotation-polish.md:71`, `:187`). Based on: `apps/desktop/src/main/browser-annotator-page.ts:277-288` (overlay styles on `--ca`/`--con`/`--cs`/`--cson`), `apps/desktop/src/renderer/components/workbench/browser-annotations-ui.tsx:131-148` (palette read from `--color-accent` etc.), astryx `theme-neutral/dist/theme.css` `--color-accent: light-dark(#1b1b1b, #f1f1f1)`.
- **One definition, two consumers**: the palette values are defined exactly once in a module under `apps/desktop/src/shared/` and both the page script and the renderer's `NumberBadge` take them from there. Rejected: literal hex in the page script's CSS and again in Tailwind classes — the two would drift. The page script is a `String.raw` template that must stay free of template-literal syntax in its inner JavaScript; it already embeds external values by string concatenation (`annotatorPinPosition.toString()` at `apps/desktop/src/main/browser-annotator-page.ts:41`), so the values can be concatenated in the same way. The renderer applies them as an inline `style` whose values come from the shared constant (directly, or as CSS custom properties consumed by `bg-(--x)`/`text-(--x)` classes) *(revised on plan audit)*. Rejected: Tailwind arbitrary values — Tailwind 4 generates classes by static scan, so `bg-[${…}]` emits no CSS and only a literal `bg-[#E6007A]` would work, which duplicates the hex. Inline style deliberately overrides the `apps/desktop/.claude/CLAUDE.md` preference for theme classes: these are not theme colours, and workbench already uses `style={` in ten files. Based on: `apps/desktop/src/main/browser-annotator-page.ts:1,19-20,41`.
- **The theme-palette channel is deleted, not left dormant**: remove the `DesktopAnnotatorPalette` type and the `palette` field of `DesktopAnnotatorState` (`apps/desktop/src/shared/desktop-bridge.ts:259,271`), its re-export (`apps/desktop/src/renderer/desktop-bridge.ts:12`), `EMPTY_STATE.palette` (`apps/desktop/src/main/browser-annotator.ts:100`), `colour`/`sanitizePalette` and the `palette` line of `sanitizeAnnotatorSync` (`apps/desktop/src/main/browser-annotator-policy.ts:113-127,162`), the palette assertions in `apps/desktop/src/main/browser-annotator-policy.test.ts:38-60` (rewrite them so the remaining sanitiser assertions keep their coverage; do not add new tests for the colours), the hex-free assertion of the test "the page script embeds the pin placement and has no palette of its own" (`browser-annotator-policy.test.ts:129-133`: delete the `#[0-9a-fA-F]{3,8}` assertion at `:131` and rename the test, keep the pin-placement and font-size assertions at `:130,:132`; do not dodge it by writing the constants as `rgb(…)`) *(revised on plan audit)*, `resolveAnnotatorPalette`/`useAnnotatorPalette` (`browser-annotations-ui.tsx:129-167`) and their use in `browser-view.tsx:77,301,362`, and the page script's `applyPalette`, `state.palette` and `Highlight`/`HighlightText` fallback. Rejected: keep the channel and ignore it — dead plumbing that still runs a `matchMedia` listener and re-syncs state on appearance changes. The annotator state travels only inside one app bundle (renderer → main → page script injected by that same main), so dropping a field has no cross-version concern. Based on: `rg -n "alette" apps/desktop/src` at `65a2c22a`.
- **White ring outside the coloured border, widths unchanged** *(decided while planning)*: the ring sits outside the existing coloured border and does not change the border's width, dash style or radius; how it is drawn (`box-shadow` spread, `outline`, an extra layer) and the exact fill opacities are the executor's call. The anchor box already has a coloured halo (`box-shadow:0 0 0 3px …22%`, `browser-annotator-page.ts:280`): keep a visible halo and add the white ring so both survive. Pins already have a ring in the on-colour (`border:1.5px solid var(--con)`, `:286`), which becomes white by the palette alone.
- **Badges change only for browser annotations** *(decided while planning)*: `NumberBadge` is shared with diff-line comments (`apps/desktop/src/renderer/components/workbench/changes-comments-ui.tsx:10,192`), and the diff view has its own accent-coloured badges (`changes-file-tree.tsx:341`, `changes-diff-pane.tsx:953`). Browser-annotation badges (`browser-annotations-ui.tsx:448,593,958,1031`) take the fixed palette; diff-comment badges keep the theme accent exactly as today. Rejected: recolour `NumberBadge` for every caller — it would make diff-comment card badges magenta while the diff tree and gutter badges stay theme-coloured. The mechanism (a prop, a variant, a separate component) is the executor's call.

## Direction

Single package; the two milestones touch shared types, so run them in order — do not fan out.

### Milestone 1: page overlays use the fixed palette, theme channel gone

The shared palette module exists; the page script's overlays and pins use it with the white ring; the theme-palette type, state field, sanitiser, hook and their wiring are removed; the page-script doc comment no longer says it "has no palette of its own". Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0.

### Milestone 2: browser-annotation badges match the pins

Draft card, detail card and panel row badges for browser annotations use the same constants (accent for pending, success with ✓ for resolved); diff-comment badges are unchanged. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop lint && pnpm -C apps/desktop build` → exit 0.

## Landmines

- **The worktree starts without dependencies**: run `pnpm install` at the worktree root before any validation; `test` also runs `../../packages/executor/src/*.test.ts` and `build` compiles `packages/executor` first *(revised on plan audit)*.
- **The page script test forbids hex colours today**: `browser-annotator-policy.test.ts:129-133` asserts the script contains no `#rrggbb`; it encodes the reversed decision and must be updated (see Decisions), or M1's validation fails *(revised on plan audit)*.
- **`@/` resolves only into `src/renderer`** (both tsconfigs): the renderer imports the shared palette module by relative path, as `browser-address.ts:14` does with `../../../shared/browser-loopback`. Main and renderer tsconfigs both include `src/shared`, and electron-vite bundles relative imports, so no build config changes are needed *(revised on plan audit)*.
- **The page script is raw text, not a module**: `ANNOTATOR_PAGE_SCRIPT` is `String.raw` (`apps/desktop/src/main/browser-annotator-page.ts:26-27`); importing a constant does nothing inside it unless its value is concatenated into the string. No backticks or `${` may appear in the inner JavaScript.
- **`annotatorStateNeedsPage()` must not start returning true for more tabs** (`apps/desktop/src/main/browser-annotator-policy.ts`, doc comment just below `sanitizeAnnotatorSync` mentions the palette): removing the field must leave its decision unchanged — a tab with no annotate mode, pins or anchor must not get a debugger. Update the comment, not the logic.
- **Overlays hide for the screenshot frame** (`setHidden` around `browser-annotator-page.ts:562`, host `visibility`): the white ring must be part of the same shadow-root nodes so it hides with them; an element added outside the closed shadow root would land in pick screenshots.
- **The host element is `all: initial`** (`browser-annotator-page.ts:271`): custom properties set on it with `host.style.setProperty` survive, but anything relying on inherited page styles does not — keep colours inside the shadow stylesheet.

## Scope

In scope:
- `apps/desktop/src/shared/` (new palette module; `desktop-bridge.ts` type removal)
- `apps/desktop/src/main/browser-annotator-page.ts`
- `apps/desktop/src/main/browser-annotator.ts`
- `apps/desktop/src/main/browser-annotator-policy.ts`, `apps/desktop/src/main/browser-annotator-policy.test.ts`
- `apps/desktop/src/renderer/desktop-bridge.ts`
- `apps/desktop/src/renderer/components/workbench/browser-annotations-ui.tsx`
- `apps/desktop/src/renderer/components/workbench/browser-view.tsx`
- `apps/desktop/src/renderer/components/workbench/changes-comments-ui.tsx` (only if the badge mechanism requires touching its import/call; its colour must not change)
- `wiki/plans/README.md`, this plan

Out of scope:
- `apps/desktop/src/renderer/index.css` and the astryx theme — the app theme is not the problem and stays as is.
- `changes-file-tree.tsx`, `changes-diff-pane.tsx` — diff comments keep the theme accent.
- Annotation cards, panel, toolbar, hint pill colours; overlay geometry and interaction.
- `docs/design-guidelines.md` — no guideline change is needed for a page-overlay palette.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Dependencies (once, first) | `pnpm install` at the worktree root | exit 0 |
| Lint | `pnpm -C apps/desktop lint` | exit 0 |
| Visual pass (acceptance) | `pnpm dev:desktop:prod` in this worktree, per the desktop-preview skill; handed to the user | the user confirms the Requirement's observable outcome |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] `rg -n "alette" apps/desktop/src` finds nothing related to the annotator (unrelated command-palette / file-icon hits are fine).
- [ ] `rg -n "Highlight" apps/desktop/src/main/browser-annotator-page.ts` finds no system-colour fallback.
- [ ] The colour values appear as hex literals in exactly one file under `apps/desktop/src/shared/`, and nowhere else in `apps/desktop/src` (`rg -in "e6007a|14ae5c" apps/desktop/src` hits that file only).
- [ ] Hover, anchor, outline, selected outline and drag boxes render a white ring outside an unchanged-width magenta border; the label is white on magenta; pending pins are white on magenta, resolved pins white ✓ on green.
- [ ] Browser-annotation badges in the panel and cards match the pins; diff-comment badges are visually unchanged.
- [ ] `annotatorStateNeedsPage()` behaviour is unchanged (its existing tests still pass).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. the page script no longer uses `--ca`-style variables, or `NumberBadge` is no longer shared).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Removing the palette field changes what `annotatorStateNeedsPage()` returns for any state.

## Maintenance notes

- Supersedes the colour decision of `20260929-annotation-polish`. If the app ever gains a saturated brand accent, do not route it back into the page overlays: the overlays must stay legible on pages the app does not control.
- The release note can say: annotate-mode boxes, labels and pins are now magenta (green when done) on every page.
