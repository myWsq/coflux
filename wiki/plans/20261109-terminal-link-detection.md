# Plan 20261109-terminal-link-detection: Terminal links stop at Chinese punctuation, and OSC 8 links open

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 6393e9e4..HEAD -- apps/desktop/src/renderer/components/workbench/terminal-web-links.ts apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/terminal-link-activation.ts apps/desktop/package.json`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check
- Workspace: isolated — the session started in the main worktree; this plan lives in `.claude/worktrees/20261109-terminal-link-detection` on `dev/20261109-terminal-link-detection`
- Planned at: `6393e9e4`, 2026-11-09

## Record

### Requirement

Two defects in how the desktop terminal turns output into clickable links.

**1. Plain-text URLs swallow the Chinese text and punctuation after them.** The web-link scanner ends a URL only at ASCII whitespace, quotes and a few ASCII symbols. Everything non-ASCII counts as part of the URL, and `new URL()` accepts a CJK tail as a valid IRI. Reproduced against the current pattern:

| Terminal text | Link today | Link after this plan |
| --- | --- | --- |
| `打开 https://cchost.ai/docs，然后登录` | `https://cchost.ai/docs，然后登录` | `https://cchost.ai/docs` |
| `见 https://github.com/a/b/pull/12。` | `…/pull/12。` | `…/pull/12` |
| `（https://example.com/path）` | `…/path）` | `…/path` |
| `「https://example.com」` | `…example.com」` | `https://example.com` |
| `https://example.com/a…` | `…/a…` | `…/a` |
| `(see https://en.wikipedia.org/wiki/Foo_(bar))` | `…/wiki/Foo_` | `…/wiki/Foo_(bar)` |
| `链接：https://example.com/x这是中文说明` | `…/x这是中文说明` | unchanged: `…/x这是中文说明` |
| `https://zh.wikipedia.org/wiki/中文 后面` | `…/wiki/中文` | unchanged |

**2. OSC 8 hyperlinks (links a program declares explicitly) never open.** Clicking one shows xterm's English dialog "Do you want to navigate to …? WARNING: This link could potentially be dangerous", and after OK nothing opens. The user verified this on a real machine; it is also the user's long-standing "⌘+click never works on links in agent output" complaint (same dialog, screenshot provided). Plain web links open fine, with or without ⌘.

Product conclusions (confirmed by the user):

- **OSC 8 links behave exactly like plain web links**: a plain primary click opens the link in the system browser, with no confirmation dialog; hover paints the link colour and shows the 「点击打开 · 右键更多」 hint; the right-click menu shows 「在系统浏览器中打开 / 在内置浏览器中打开 / 复制链接」 on top; a drag-selection that ends on the link does not open it. Only `http` / `https` OSC 8 links are links at all. Accepted difference: xterm always draws an underline on an OSC 8 link under the pointer, and that cannot be turned off.
- **Plain-text URLs break like VS Code's terminal**: CJK punctuation ends the URL; a trailing `. , ; :` is not part of it; a closing bracket stays only when its opener is inside the URL.
- **CJK letters glued to a URL with no punctuation in between stay in the link**, so links with Chinese paths stay whole.
- Out of scope: the iOS client and file-path links.

Done = every row of the table above yields the right-hand column, and clicking an OSC 8 link opens it the way a plain link opens.

### Decisions & tradeoffs

- **D1 OSC 8 links go through xterm's `linkHandler` option and share one code path with the web-link provider**: activation gate (`shouldOpenTerminalWebLink`), the open call (`window.open(rewriteUnspecifiedHost(uri), "_blank", "noopener")`), hover painting, the hint, and `hoveredLinkRef` for the context menu. `allowNonHttpProtocols` stays unset, so xterm itself drops non-http(s) OSC 8 links. Rejected: a second, copied set of callbacks for OSC 8 — the two would drift. Rejected: reading OSC 8 ranges ourselves to turn the underline off — the cell's link id is not public API.
  Based on: no `linkHandler` is set anywhere in `apps/desktop/src`; without one, `OscLinkProvider` calls `defaultActivate` (`node_modules/@xterm/xterm/src/browser/OscLinkProvider.ts`, `function defaultActivate`), which calls `confirm()` and then a URL-less `window.open()`; the main process drops that (comment above `terminal.registerLinkProvider` in `terminal-pane.tsx`: "main process denies every window.open and only forwards an http(s) URL"). xterm registers `OscLinkProvider` in its constructor, ahead of ours, and `Linkifier._removeIntersectingLinks` drops a later provider's link that overlaps it, so an OSC 8 link whose text is a URL is not linked twice.
- **D2 URL boundaries follow VS Code's `LinkComputer`, while every ASCII character the current pattern refuses stays refused**:
  - The URL ends (exclusive) at the first *terminator*: whitespace; the ASCII characters `" ' ! * | \ ^ < >` and backtick (the current pattern's exclusions, brackets aside); and VS Code's CJK set `、 。 ｡ ､ ， ． ： ； ‘ ’ 〈 〉 「 」 『 』 〔 〕 （ ） ［ ］ ｛ ｝ ｢ ｣ ｀ ～ …` plus `【 】`.
  - ASCII brackets `( ) [ ] { }` are balanced per kind: an opener inside the URL lets one matching closer through; a closer with no open opener of its kind is a terminator.
  - Trailing characters that cannot end a URL are stripped repeatedly: VS Code's `. , ; :` plus `! ? ~` (the current pattern's last-character exclusions).
  - CJK letters and every other character not listed are part of the URL.
  - The existing `new URL()` sanity check, the soft-wrap window, and the string→cell mapping stay as they are.
  Rejected: VS Code's set alone — it would start accepting `! * \ ^ |` inside URLs, which the current pattern refuses; this plan does not widen anything. Rejected: ending a URL at any CJK character — it cuts Chinese-path links (user decision). Rejected: Ghostty's whitelist and WezTerm's `\S+` rules — the first rejects valid characters, the second has the very problem being fixed.
  Based on: `terminal-web-links.ts` `const STRICT_URL`; VS Code `src/vs/editor/common/languages/linkComputer.ts` (`FORCE_TERMINATION_CHARACTERS`, `CANNOT_END_WITH_CHARACTERS`, the `hasOpenParens` / `hasOpenSquareBracket` / `hasOpenCurlyBracket` handling), which VS Code's terminal reuses through `terminalUriLinkDetector.ts`; the product confirmation.
- **D3 The boundary rule is a pure function over a string, with unit tests**; the buffer layer only feeds it joined lines and maps its offsets back to cells. Based on: `apps/desktop/package.json` `test` already runs `src/renderer/components/workbench/*.test.ts` under `node --test` with no DOM, and the rule has many edge cases worth pinning.
- **D4 Nothing outside the desktop renderer changes**: not iOS, not file links, not how Claude Code decides to emit OSC 8.

### Discussion log

- Exploration (user asked what the current rule is and how the industry does it): the root cause is the ASCII-only `STRICT_URL` copied from `@xterm/addon-web-links` 0.13; VS Code (state machine with CJK terminators, trailing `.,;:`, bracket balancing), Ghostty (character whitelist) and WezTerm (`\S+`) were compared from source; OSC 8 was named as the way programs avoid guessing.
- User: 「可以，试试 OSC 8」. OSC 8 test lines printed in a visible Coflux terminal. Q: what happens when you click the OSC 8 link? → 「英文确认框后没打开」. Q: hover range on the OSC 8 URL line vs the plain line? → OSC 8 correct, plain line includes the Chinese.
- Product confirmation (OSC 8 parity with plain links incl. the unavoidable underline; VS Code-style break rules; glued CJK stays; iOS and file links out of scope). Options: confirm all / OSC 8 only / also break glued CJK → 「全部确认」.
- Departure check. Execution: sonnet / opus / fable / self → `subagent(opus)`. Autopilot: plain / plan audit → plain autopilot.
- User mid-turn: 「cmd 点击开链接好像一直都不生效」. Q: does ⌘+click on the plain test link open? → opens with or without ⌘. Q: where does it fail? → agent output (Claude Code / Codex). Q: what happens? → the same English dialog, nothing after OK (screenshot). Settled: same defect as OSC 8, covered by D1, no scope change.
- (decided while planning) D2 keeps the current ASCII exclusions (`! * \ ^ |` and backtick terminate; `! ? ~` cannot end) on top of VS Code's rule, so the change only narrows links and never widens them.
- (decided while planning) Note found during exploration: Claude Code emits OSC 8 only for terminals on its `supports-hyperlinks` list (iTerm, WezTerm, VS Code, Ghostty, kitty, …), and `TERM_PROGRAM=coflux` is not on it. The OSC 8 links the user hits come from other programs; making Claude Code emit them (e.g. `FORCE_HYPERLINK=1` in Coflux terminals) is a separate decision, not in this plan.

### Maintenance notes

- `terminal-web-links.ts` no longer mirrors `@xterm/addon-web-links`; when bumping xterm, the addon's changes are not ours to copy.
- If Coflux later makes Claude Code emit OSC 8, its links will go through D1's path; check that a hard-wrapped long link still activates as one link.

## Execution brief

> Written for `subagent(opus)` at `6393e9e4`. Implement the tasks in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

The Coflux desktop terminal (Electron renderer, xterm.js 6.1 beta) recognises web links in two ways, and both are wrong:

1. Plain-text URLs are found by `findTerminalWebLinks` in `apps/desktop/src/renderer/components/workbench/terminal-web-links.ts`. Its pattern stops only at ASCII characters, so `https://cchost.ai/docs，然后登录` becomes one link. Replace the boundary rule with VS Code's, keeping the soft-wrap windowing and the string→cell mapping.
2. OSC 8 hyperlinks (escape-sequence links) are handled by xterm's built-in provider. Coflux sets no `linkHandler`, so a click shows `confirm()` and then a URL-less `window.open()` that the main process drops. Give xterm a `linkHandler` that behaves exactly like the existing web-link provider in `terminal-pane.tsx`.

Conventions: tests are `node:test` + `node:assert/strict` files next to the module (see `terminal-link-activation.test.ts`), run without a DOM. Code comments in these files are English and explain why. There is no formatter in this repository; match the surrounding style.

Milestones 1 and 2 touch different files and are independent of each other.

### Milestone 1: plain-text URLs end where VS Code ends them

Depends on: none

#### T1 · A pure function finds URL ranges in a string by VS Code's rule

- Where: `apps/desktop/src/renderer/components/workbench/terminal-web-links.ts` — `const STRICT_URL` and its use in `findTerminalWebLinks`.
- Change: Replace `STRICT_URL` with an exported pure function (no xterm types) that takes a string and returns every URL in it as `{ start, end, text }` (string offsets, `end` exclusive). `findTerminalWebLinks` calls it on the joined window instead of `matchAll(STRICT_URL)`, then applies `isUrl` and `mapStringIndex` exactly as today. Update the file header: the boundary rule now follows VS Code's `LinkComputer` (MIT, © Microsoft Corporation); the wrap window and cell mapping still follow `@xterm/addon-web-links` 0.13.
- After (D2):
  - A URL starts at `http://` or `https://`, matching the scheme as the current pattern does (`http`, `https`, `HTTP`, `HTTPS`).
  - Scanning forward, the URL ends (exclusive) at the first terminator: any whitespace; ASCII `"`, `'`, `!`, `*`, `|`, `\`, `^`, `<`, `>`, backtick; and the CJK characters `、。｡､，．：；‘’〈〉「」『』〔〕（）［］｛｝｢｣｀～…【】`.
  - ASCII `(` `)`, `[` `]`, `{` `}` are counted per kind with a depth counter: an opener increments; a closer decrements when its kind's depth is above zero, otherwise it is a terminator.
  - Then trailing characters from `. , ; : ! ? ~` are stripped repeatedly.
  - A result that is only the scheme and `//` is dropped. Scanning resumes after the URL's end, so several URLs per string are found.
  - Every other character, CJK letters included, belongs to the URL.
- Don't: end a URL at CJK letters (D2, user decision). Don't drop `isUrl`, `windowedLines` or `mapStringIndex`, or change how they work (D2).

#### T2 · The rule is pinned by tests

- Where: new `apps/desktop/src/renderer/components/workbench/terminal-web-links.test.ts`.
- Change: Test the T1 function on strings, input → expected list of `text`:
  - `打开 https://cchost.ai/docs，然后登录` → `https://cchost.ai/docs`
  - `见 https://github.com/a/b/pull/12。` → `https://github.com/a/b/pull/12`
  - `链接：https://example.com/x这是中文说明` → `https://example.com/x这是中文说明`
  - `（https://example.com/path）` → `https://example.com/path`
  - `「https://example.com」` → `https://example.com`
  - `【https://example.com/x】` → `https://example.com/x`
  - `https://example.com/a)】 下一句` → `https://example.com/a`
  - `https://zh.wikipedia.org/wiki/中文 后面` → `https://zh.wikipedia.org/wiki/中文`
  - `(see https://en.wikipedia.org/wiki/Foo_(bar))` → `https://en.wikipedia.org/wiki/Foo_(bar)`
  - `[docs](https://example.com/p)` → `https://example.com/p`
  - `https://a.com/x?y=[2]&z={3}` → `https://a.com/x?y=[2]&z={3}`
  - `https://example.com/a…` → `https://example.com/a`
  - `Visit https://example.com.` → `https://example.com`
  - `https://example.com/?q=1;` → `https://example.com/?q=1`
  - `https://example.com/a!` → `https://example.com/a`
  - `"https://example.com"` → `https://example.com`
  - `http://localhost:3000/` → `http://localhost:3000/`
  - `https://a.com、https://b.com` → `https://a.com`, `https://b.com`
  - `https://` → no link
  - `see example.com` → no link
- After: each case asserts the exact list and fails on the current `STRICT_URL` behaviour for the CJK and bracket rows.

### Milestone 2: OSC 8 links behave like web links

Depends on: none

#### T3 · xterm gets a linkHandler that shares the web-link behaviour

- Where: `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` — the block that starts with the comment `// 输出中的 URL（plan 20260924-desktop-browser-tab` and the `terminal.registerLinkProvider({` call under it (its `activate`, `hover`, `leave` closures); helpers `paintHover`, `leaveLink`, `hoveredLinkRef`, `setLinkHint`.
- Change: Pull the web-link provider's activate / hover / leave behaviour into one helper that the provider and a new `linkHandler` both use. Set the handler on this terminal (`terminal.options.linkHandler = …`, or pass it in the constructor options) at a point where the helpers it calls exist.
- After (D1):
  - An OSC 8 `http`/`https` link opens on a plain primary click through the same `shouldOpenTerminalWebLink(event, terminal.hasSelection())` gate and the same `window.open(rewriteUnspecifiedHost(uri), "_blank", "noopener")` call as a plain web link. No `confirm()` and no dialog appear.
  - Hover sets `hoveredLinkRef.current` to `{ kind: "url", url }`, paints the range with `paintHover`, and shows the same `点击打开 · 右键更多` hint. The right-click menu then offers the three link items, because `handleContextMenuOpenChange` reads `hoveredLinkRef`.
  - Leave clears the hover through `leaveLink`.
  - The plain web-link provider behaves exactly as before.
- Don't: set `allowNonHttpProtocols` (D1). Don't write a second copy of the open / hover / leave logic for OSC 8 (D1).
- Landmine: `leaveLink(target)` clears `hoveredLinkRef` only when it holds the *same object* it is given. `ILinkHandler` is one object for every OSC 8 link, and its `leave(event, text, range)` gets no target, so keep the object created in `hover` and pass that same object to `leaveLink`. A fresh object would leave a stale link in the context menu.

### Your call

- Names and shapes of the extracted helper and of the T1 function (for example `findUrlRanges(text)`), and whether T1 is a character loop or a regex plus a scan, as long as the T1 rules hold exactly.
- Whether the handler is set via `terminal.options` or the constructor.
- Test grouping and names in T2.

### Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-web-links.ts`
- `apps/desktop/src/renderer/components/workbench/terminal-web-links.test.ts` (new)
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`

Out of scope:
- `terminal-file-links.ts` / `terminal-file-references.ts` and the file-link provider in `terminal-pane.tsx` — file links are unchanged.
- `terminal-link-activation.ts` — its rules already fit; only call them.
- `apps/ios/**`, the main process, `package.json` dependencies.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- xterm's typings in this repository have no `linkHandler` option, or `ILinkHandler`'s callbacks do not receive `(event, text, range)`.

## Verification

### Milestone validations

- Milestone 1: `pnpm --filter @coflux/desktop test` → exit 0, including the new `terminal-web-links.test.ts` cases.
- Milestone 2: `pnpm --filter @coflux/desktop typecheck` → exit 0; read the diff: the provider and the handler call one helper, `allowNonHttpProtocols` is absent, and `leave` passes the object created in `hover`.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Unit tests | `pnpm --filter @coflux/desktop test` | exit 0 |
| Typecheck | `pnpm --filter @coflux/desktop typecheck` | exit 0 |
| Lint | `pnpm --filter @coflux/desktop lint` | exit 0 |
| Real terminal walkthrough (acceptance) | In a dev preview, `printf '\033]8;;https://cchost.ai/docs\033\\打开文档\033]8;;\033\\。\n打开 https://cchost.ai/docs，然后登录\n'`, then click, hover, and right-click both links | both open in the system browser with no dialog; the plain link stops before `，`; the right-click menu shows the three link items on both |

### Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every task's `After` state holds.
- [ ] Every row of the Requirement table yields its right-hand column (covered by T2).
- [ ] Clicking an OSC 8 link opens it with no dialog; a right click and a drag-selection ending on it do not open it.
- [ ] Implementation follows D1–D4.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Renderer-only; it ships with the next desktop release. No server, daemon, protocol, or migration change.
- No automated gate drives a real xterm. The walkthrough row above is pending the user, and it is the only check of the OSC 8 half.
