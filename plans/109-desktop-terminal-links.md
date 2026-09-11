# Plan 109: Open terminal URLs in the system browser with ⌘+click

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat df18ba9..HEAD -- apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/main/window.ts apps/desktop/src/preload/index.ts apps/desktop/package.json`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (after 106 the renderer is in `apps/desktop/src/renderer`; based on main `df18ba9`)
- Category: bug
- Execution: subagent (host general-purpose subagent, `model: opus`; preflight recorded 2026-09-11, proceed automatically without further confirmation)
- Planned at: `df18ba9`, 2026-09-11

## Requirement

URLs printed in the desktop terminal (`apps/desktop`, Electron 44) cannot be opened. Neither ⌘+click nor ordinary click works. The console only says `Opening link blocked as opener could not be cleared`.

Root cause (verified during exploration; do not investigate again): the terminal loads the link addon with argument-free `new WebLinksAddon()` (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:217`). The default activation handler in `@xterm/addon-web-links` 0.12 calls `window.open()` **without a URL**, then sets the returned window's `location.href` (`node_modules/@xterm/addon-web-links/src/WebLinksAddon.ts:24-36`). Desktop's main process returns `{ action: "deny" }` for every `window.open`, handing only http(s) URLs to the system browser (`apps/desktop/src/main/window.ts:63-66`). It receives and discards `about:blank`; `window.open()` returns null, and the addon only warns. This worked in the web client because the browser actually opened a tab. The port-preview button in the same directory has always worked because it calls `window.open(preview.url, "_blank", "noreferrer")` **with the URL** (`workspace-terminal.tsx:486`), using the main process's external-link path.

### Product conclusions (confirmed during exploration; do not ask again)

- **Gesture**: require modifier+click: ⌘ (`metaKey`) on macOS, Ctrl (`ctrlKey`) elsewhere, matching VS Code/iTerm. Ordinary clicks only focus the terminal, avoiding accidental browser launches when entering a claude session.
- **Destination**: the default system browser through the existing main-process external-link handler; no in-app window or new app tab.
- **Outside scope**: preserve xterm's default hover underline, without modifier gating; leave the main-process link policy, other `window.open` calls, and all other xterm behavior unchanged.
- **User acceptance**: ⌘+click on terminal http(s) links opens the system browser; ordinary click does nothing; main still rejects non-http(s) URLs. The user checks the real desktop app manually. Under the existing agreement, Claude performs no UI walkthrough; neither executor nor verifier launches the app or browser.

## Decisions & tradeoffs

- **Renderer-only fix: pass a custom activation handler to `WebLinksAddon`**. Call `window.open(uri, "_blank", "noopener")` with the URL; the existing `setWindowOpenHandler` receives it and invokes `shell.openExternal`. Rejected: a new preload bridge/`openExternal` IPC — an additional IPC surface and trust boundary with no benefit, since URL-bearing `window.open` already works nearby. Rejected: allow `about:blank` in main and assign `location.href` later — after denial there is no window object to assign to. Based on: `apps/desktop/src/main/window.ts:20-25, 63-66`; `workspace-terminal.tsx:486`; `node_modules/@xterm/addon-web-links/typings/addon-web-links.d.ts:23` (`constructor(handler?: (event: MouseEvent, uri: string) => void, options?)`).
- **Gate in the activation handler using `metaKey || ctrlKey`, without platform detection.** When mousedown/mouseup hit the same link, xterm Linkifier unconditionally calls `link.activate(event, text)` without checking modifiers. There is no addon option to require modifiers, so the handler must gate activation. Desktop currently packages only macOS (`apps/desktop/electron-builder.yml:32-48` contains only `mac` targets); accepting `ctrlKey` preserves cross-platform semantics at no cost. Rejected: `navigator.platform` detection accepting only meta or ctrl per platform — more detection without benefit. Rejected: open on ordinary click (xterm default) — ruled out by the product decision. Based on: `node_modules/@xterm/xterm/src/browser/Linkifier.ts:216-232`; `electron-builder.yml:32-48`.
- **Ignore the return value of `window.open`**: main denies the window in Electron, so it always returns null. Do not branch or warn based on it. Based on: `apps/desktop/src/main/window.ts:63-66`.
- **Extract the opening decision into a pure function with `node --test` coverage** (decided during planning; exploration had left it to the executor). Put the module and matching `*.test.ts` in `apps/desktop/src/renderer/components/workbench/`, covered by the existing test glob. Accept event fields (`metaKey`/`ctrlKey`; checking `button` is optional), without runtime references to DOM globals such as `MouseEvent` or `window`: renderer tests run in plain Node without DOM. Do not unit-test `window.open` itself. Rejected: no tests — modifier combinations are this plan's sole logic and merit assertions. Rejected: jsdom to test `window.open` — a dependency with no benefit. Based on: the test script in `apps/desktop/package.json`; existing test style at `desktop-update.test.ts:1-10`.
- **No main-process, preload, or shared bridge-type changes.** Based on: `apps/desktop/src/preload/index.ts` has no openExternal bridge; exploration confirmed URL-bearing `window.open` is sufficient.

## Direction

One milestone; no parallel split.

### Milestone 1: Modifier-click opens terminal links; ordinary click does not

- Pass a custom activation handler when loading `WebLinksAddon` in `terminal-pane.tsx`. Replace the comment describing default new-tab behavior with the actual modifier gate and URL-bearing `window.open` routed through main.
- Add a pure-function module and tests covering at least no modifiers → do not open, metaKey → open, and ctrlKey → open.
- Validation: `pnpm -C apps/desktop typecheck` -> exit 0; `pnpm -C apps/desktop test` -> all pass, including new cases; `pnpm -C apps/desktop build` -> exit 0.

## Landmines

- The comment at `terminal-pane.tsx:217` describing default new-tab opening is true for browsers but false for Electron. Update it with the code so future readers do not assume the default works.
- The addon's default handler (`node_modules/@xterm/addon-web-links/src/WebLinksAddon.ts:24-36`) only calls `console.warn` when `window.open()` returns null; it does not throw. Diagnose silent inactivity, not an exception.
- Desktop `window.open(url, ...)` always returns null because main denies it and calls `shell.openExternal`. Main also drops non-http(s) URLs (`window.ts:20-25`); renderer needs neither duplicate scheme validation nor return-value handling.
- Renderer tests are plain Node `node --test`, without DOM. The pure module must not access runtime `window`/`MouseEvent` values at module scope; type references are fine.
- This new worktree has no `node_modules`. During `dev:execute-plan` preflight, run `pnpm install --frozen-lockfile` from the repository root before validation. Do not change the lockfile.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`
- `apps/desktop/src/renderer/components/workbench/<new-pure-function-module>.ts` and matching `.test.ts` (executor chooses names within this directory)
- `plans/109-desktop-terminal-links.md`, `plans/README.md`

Out of scope:
- `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`, `apps/desktop/src/shared/**` — no external-link policy or bridge changes
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx` — port-preview `window.open` already works
- `apps/desktop/package.json`, `pnpm-lock.yaml` — no dependencies or version bumps
- Modifier-gated xterm hover underlining — explicitly excluded

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (preflight, repository root) | `pnpm install --frozen-lockfile` | exit 0; no lockfile diff |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0, including new cases |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Real-machine walkthrough (acceptance) | User ⌘+clicks and ordinarily clicks an http(s) link in the desktop terminal | Modifier click opens the system browser; ordinary click does nothing |

## Done criteria

- [ ] All listed commands pass.
- [ ] Terminal http(s) links open in the system browser on ⌘/Ctrl+click, but not ordinary click.
- [ ] New tests assert no opening without modifiers and opening with either meta or ctrl.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds, especially main's `setWindowOpenHandler` forwarding http(s) to `shell.openExternal` or the handler argument accepted by `WebLinksAddon`.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- Future VS Code-style underlining only while holding ⌘ can use dynamic `ILink.decorations` and event-bearing `WebLinksAddon` `options.hover/leave`, but needs keydown/keyup listeners to synchronize modifiers. This plan explicitly excludes it.
- Main's `openExternalIfHttp` is the sole scheme allowlist. Future renderer external links should continue using URL-bearing `window.open`, rather than new IPC.
