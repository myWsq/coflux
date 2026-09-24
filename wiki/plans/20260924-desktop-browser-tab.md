# Plan 20260924-desktop-browser-tab: A browser tab in the editor groups, on par with Cursor's

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 39f4e3cc..HEAD -- apps/desktop/src docs/design-guidelines.md`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — the session was on the main worktree; moved to `.claude/worktrees/20260924-desktop-browser-tab` on `dev/20260924-desktop-browser-tab`
- Planned at: `39f4e3cc`, 2026-09-24

This is **slice 1 of 2**. Slice 2 (`20260924-remote-localhost-tunnel`, planned after this one is done, on the same branch) makes `localhost` in a remote workspace's browser tab reach that workspace's device through a new device-channel TCP tunnel. The user authorised both slices back to back at the departure check. Until slice 2 lands, remote workspaces get the "not supported yet" behaviour defined below.

## Requirement

Today the desktop app has no way to look at a web page next to a terminal: the ports menu (`port-menu.tsx:51`) and ⌘+click on a terminal URL (`terminal-pane.tsx:320-324`, plan 109) both hand the URL to the system browser, and editor-group tab strips (plan 20260923-terminal-split-groups) hold terminals only. The user wants a built-in browser tab whose interaction and UI follow Cursor's in-editor browser (Cursor 3.20: `BrowserEditorContent` / `BrowserMoreMenu`). The system browser stays the primary path — the built-in tab is a minority case, reached as a secondary action.

Product conclusions, confirmed by the user — settled, do not reinterpret them:

1. **Who and when**: someone in the desktop app looking at a workspace's dev server who wants the page beside the terminal instead of in another app.
2. **Form**: a new kind of tab in the editor groups, on the same tab strips as terminals. Drag to reorder, drag to another group, drag out to a new group, the tab context menu's move-to-new-group-right/down, ⌘W closes it, ⌘[ ⌘] cycle through it — all exactly as terminal tabs. Out of scope for this and the next slice: Cursor's "Select element" / Design Mode and any agent control of the browser.
3. **What `localhost` means**: in a browser tab, `localhost`, `127.0.0.1` (all of `127.0.0.0/8`), `[::1]` and `0.0.0.0` mean *the device the tab's workspace lives on*. For a workspace on this Mac that is this Mac. For a remote workspace that is the remote device (slice 2); in this slice, a remote workspace's tab refuses loopback addresses with an explanatory error page — it must never silently show this Mac's `localhost` instead. Every other host goes to the network from this Mac as normal.
4. **Entry points**:
   - Terminal links: a **plain left click** on a URL opens it in the system browser — the ⌘ requirement of plan 109 is removed for web links. A **right click on a URL** shows the terminal's existing context menu (`terminal-pane.tsx:894-906`) with three extra items at its top: 在系统浏览器中打开 / 在内置浏览器中打开 / 复制链接. A right click elsewhere shows the menu unchanged. Dragging a selection across a link never opens it.
   - Ports menu: clicking a row still opens the system browser (the preview URL, unchanged). Each row gains a trailing icon button, 用内置浏览器打开, which opens `http://localhost:<port>` in a browser tab.
   - The ⌘P palette and the native 文件 menu gain 新建浏览器标签页. No keyboard shortcut for it. ＋ and ⌘T still create a terminal.
   - Every new browser tab lands in the workspace's focused group and becomes its active tab.
5. **The tab**, aligned with Cursor 3.20 minus select-element / take-control:
   - Tab strip entry: page favicon + page `<title>` (fallback: host), a spinner while loading, a close button — same chrome as a terminal tab.
   - Toolbar: ← → ⟳ (reload; a hard reload that bypasses the cache is in ⋯), the address bar (placeholder 输入网址或搜索, history + bookmark suggestions, a ☆ button to bookmark / unbookmark the current page), a Console button toggling DevTools, and ⋯.
   - ⋯ menu: 截取可见区域 / 框选截图 (both to the clipboard, so they can be pasted into an agent terminal), 复制当前网址, 在系统浏览器中打开, 硬刷新（清除缓存）, zoom − 100% +, 显示书签栏 (toggle), 清除浏览历史 / 清除 Cookies / 清除缓存 / 清除已信任的证书.
   - Bookmarks bar under the toolbar when enabled.
   - A self-signed / invalid certificate shows a trust prompt (信任证书) instead of a bare Chromium error.
   - A blank new tab: the address bar is focused, the page area lists the current workspace's forwarded ports (from the same `ports` state the ports menu reads) as one-click entries.
   - Address bar input: a bare port (`5173`) → `http://localhost:5173`; `host:port` or a hostname → `http://`…; a full URL as is; anything that is not URL-like → a web search.
   - With focus inside the tab: ⌘L focuses the address bar, ⌘R reloads the page (not the app), ⌥⌘I toggles DevTools, ⌘+ / ⌘− / ⌘0 zoom the page (not the app).
6. **Data and persistence**:
   - Cookies, localStorage, IndexedDB and cache are isolated **per workspace** and persist across restarts. The ⋯ 清除 Cookies / 缓存 / 已信任的证书 act on the current workspace only.
   - Bookmarks, the bookmarks-bar toggle and history are **global on this Mac** (all workspaces); 清除浏览历史 clears that global history. A bookmark opened in a workspace resolves `localhost` against that workspace's device, per conclusion 3.
   - Browser tabs and their URLs are stored with the split layout, per workspace, on this Mac; after a restart they come back in place and reload their URL. Not synced to the account; no other device sees them.
   - A browser tab that is not visible (another tab of its group is active, or another workspace is selected) keeps its page running — HMR state is not lost — until the tab is closed.
7. **Failure states** — the page area shows an error page with a 重试 button: nothing listening on a local port (connection refused), a generic network error, and (this slice) a remote workspace's loopback address.
8. **Non-goals**: select element / Design Mode, agent control via CLI, pop-up windows as separate windows (a page's `window.open` / `target=_blank` opens a new browser tab in the same group), extensions, password manager, a download manager (downloads go straight to the system Downloads folder), account sync.
9. **Observable when done** (this slice): in a workspace on this Mac, run a dev server, right-click its `localhost` URL in the terminal → 在内置浏览器中打开 → the page shows in the focused group and HMR updates it; drag the tab beside the terminal; left-click a terminal link → the system browser opens; two local workspaces on the same port keep separate logins; restart the app → browser tabs and URLs are back; ⌘R in the page reloads only the page; a remote workspace's browser tab opens public sites but shows the "not supported yet" page for `localhost`.

## Decisions & tradeoffs

- **Pages are embedded with the `<webview>` tag, not `WebContentsView`.** Cursor 3.20's in-editor browser is a `<webview>` (its workbench creates `webview` elements with a `partition` attribute and docks DevTools through a second webview + `setDevToolsWebContents`). A webview is composited with the DOM, so menus, tooltips, ⌘P, dialogs and tab-drag drop zones draw over it, and it follows the split layout's fractional rectangles in the same frame. Rejected: `WebContentsView` — a native layer above all DOM (every overlay would need hide/snapshot choreography) and its bounds would have to be pushed from main on every sash drag. Based on: `terminal-panes.tsx:10-20` (flat pane layer positioned by rectangles).
- **The main window's webview hardening is replaced, not loosened wholesale.** `webviewTag` becomes `true` (`window.ts:70`) and the blanket `will-attach-webview` deny (`window.ts:97`) becomes a gate that: deletes `webPreferences.preload` (the guest gets no preload at all); forces `nodeIntegration: false`, `sandbox: true`, `contextIsolation: true`, `webSecurity: true`; accepts only the partition naming scheme `persist:coflux-browser-<workspaceId>` for a partition main has already prepared (unknown or unprepared → `preventDefault`); accepts only `about:blank` as the attach-time `src`. Guest navigations are restricted to `http:`, `https:` and `about:blank` in main (other schemes — `file:`, `javascript:`, custom — are cancelled or handed to `openExternalIfHttp`). The main window's own `setWindowOpenHandler` / `will-navigate` rules (`window.ts:86-95`) stay as they are for the app's renderer. Rejected: keeping a preload in the guest — nothing in this slice needs one (title, favicon, loading state, navigation state all come from webview/webContents events), and the Electron security guide says strip it.
- **Order is prepare → insert → navigate.** The renderer first asks main (IPC) to prepare the workspace's partition; only after that resolves does it insert the `<webview>` into the DOM with its `partition` and `src="about:blank"`; only after the guest attaches does it set the real URL. Every restored tab on cold start goes through the same order. Preparing configures `session.fromPartition(...)`: permission handlers, download path, certificate handling, and — for remote workspaces — the loopback block of this slice (slice 2 installs its proxy here). Rejected: inserting the webview first and preparing while it sits on `about:blank` — the gate would see an unprepared partition and destroy the guest, and `partition` cannot change after the first navigation; configuring the session inside `will-attach-webview` — it is synchronous and `setProxy` (slice 2) is async. The gate reads the partition from `webPreferences.partition` as well as `params`. (revised on plan audit)
- **Main decides whether a workspace is local or remote.** The renderer passes the workspace's `daemonId` when preparing; main compares it with the local daemon id it derives itself (`daemon-state.ts:53`). When main does not know the local daemon id yet, preparing waits for it (bounded; on timeout treat as remote and let a later registration re-prepare the partition's mode). Rejected: the renderer's `daemonState?.daemonId` (`workbench.tsx:259`) — it is `null` until the first daemon state arrives (`use-desktop-daemon.ts:11-24`), so tabs restored on the first frame would be misclassified as remote and have loopback blocked for good. (revised on plan audit)
- **Browser partitions deny permissions by default.** Every prepared partition gets `setPermissionRequestHandler` and `setPermissionCheckHandler` that refuse camera, microphone, geolocation, notifications, MIDI, HID/serial/USB and the like; allow only what a dev page harmlessly needs without a prompt (clipboard-sanitized-write, fullscreen). The existing handlers are installed on the default session only (`index.ts:176-179`); a session without handlers grants every request. (revised on plan audit)
- **Per-workspace persistent partition** `persist:coflux-browser-<workspaceId>`. Clearing cookies / cache / accepted certificates targets that session only. Rejected: per project (worktrees of one project on the same port would overwrite each other's cookies), global (different workspaces' `localhost` point at different devices and branches).
- **Remote workspaces in this slice: loopback is blocked in main, not in the address bar.** For a partition prepared as remote, main cancels every request whose host is loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`) — top-level navigations, subresources, fetch/XHR and WebSockets alike — and the renderer shows the conclusion-7 error page for a blocked top-level load. Rejected: checking only what is typed into the address bar — a public page could still fetch this Mac's `localhost` and a redirect would bypass it, which contradicts conclusion 3. The loopback classifier is one module shared by main and the address bar; it lives in `src/main/` (covered by the test glob) or the glob is extended — see Scope. (decided while planning)
- **Browser tabs are layout entries with their own id namespace.** Their ids carry a fixed prefix (in the spirit of `PENDING_TAB_PREFIX`, `terminal-layout.ts:84`) and their URLs/metadata are stored per workspace next to the layouts (the layouts live under `TERMINAL_LAYOUTS_KEY`, `config.ts:27`). `reconcileLayout` (`terminal-layout.ts:658-685`) must keep them — today it removes every id that is not a live task id — and `parseLayout` must keep them too (it already drops pending ids, `terminal-layout.ts:756`). Everything terminal-specific must skip them: the attach machine's visible set and claiming (filter where `setVisibleTaskIds` is fed, `workbench.tsx:383` / `:860`, rather than inside `terminal-attach.ts`), ⌘W's stop-the-terminal path (`workbench.tsx:1017-1023`; closing a browser tab just removes it, no confirmation), plan-104 cross-workspace moves, done-celebration, the palette's recent places, detached/exited banners. The places that special-case pending ids today (`workbench.tsx:376`, `:434`, `:475`, `:499`) are the checklist for browser ids. The tab strip currently renders nothing for a layout id with no task (`workspace-terminal.tsx:514-515`) — that is where the browser tab chip goes, and the drag ghost title (`:553`), the tab context menu (`:572-589`, whose 复制标识 is terminal-only) and the close/new tooltips (`:615`, `:707`) need browser-appropriate variants. The browser-tab records are stored under a `config.ts` key scoped by `SERVER_URL` like `TERMINAL_LAYOUTS_KEY` (`config.ts:27`), written no later than the layout; on restore, a browser id in the layout with no record is dropped. Rejected: modelling a browser tab as a fake task — the task list comes from the server and drives attach. (revised on plan audit)
- **Background tabs stay alive, and a webview is never re-parented.** Webviews live in the same flat layer as terminal panes, keyed by browser-tab id, positioned by rectangles; moving a tab between groups only changes the rectangle. Moving a `<webview>` element to another parent reloads its page — that would break conclusion 6. Hidden tabs are hidden without `display:none` (see landmines). Browser tabs are removed from the DOM only when closed or when their workspace goes away.
- **App shortcuts reach the app while focus is inside a page.** Keys typed in a guest never reach the renderer's window listeners (`use-global-shortcuts.ts`). Main listens to `before-input-event` on every guest and, for the page shortcuts the menu does **not** register (`registerAccelerator: false`, `menu.ts:19-22`: ⌘T, ⌘W, ⌘N, ⌘P, ⌘[, ⌘], ⌘\, ⌘⇧\, ⌘1–9, ⌘⌥1–9, ⌘⌥ arrows, ⌘/, ⌘,), prevents the guest from seeing them and forwards them to the renderer through the existing `DesktopCommand` channel (`desktop-bridge.ts:74`; add the commands that are missing there, e.g. digit selection). The browser's own keys go the same way: ⌘L → focus the address bar, ⌥⌘I → toggle DevTools. Everything else stays with the page (⌘C, ⌘V, ⌘A, ⌘F, ⌘Z, typing, arrows, Tab). (revised on advisor review)
- **⌘R is dispatched by the menu to the focused surface.** Replace `{ role: "reload" }` (`menu.ts:93`) with a custom item that keeps the main-registered `CmdOrCtrl+R` accelerator and, in its click, reloads the focused browser guest when `webContents.getFocusedWebContents()` is one, and the window otherwise. On macOS the key reaches the focused guest first and only falls through to the menu when the page leaves it unhandled (Electron `PlatformHandleKeyboardEvent`), so a page that handles ⌘R itself keeps it — that is browser-normal. Rejected: the stock role — it reloads the whole app. Keeping the accelerator main-registered preserves plan 20260918-desktop-reload-shortcut's goal (⌘R works when the renderer is wedged); do not edit that plan. When the focused webContents is a docked DevTools host, map it back to its page guest (or leave ⌘R to DevTools) — never reload the app from it. Zoom: verify the `zoomIn`/`zoomOut`/`resetZoom` roles (`menu.ts:95-98`) act on a focused guest; if not, apply the same dispatch. The toolbar's zoom percentage follows the guest's actual zoom (listen for it). (revised on advisor review; rationale revised on plan audit)
- **`window.open` and `target=_blank` open a browser tab in the same group.** Webviews get `allowpopups` (otherwise no handler sees the popup), and main installs `setWindowOpenHandler` on each guest (after `did-attach-webview`) that always returns `deny` and tells the renderer to open the URL as a new browser tab in the opener's group (http/https only). Rejected: real pop-up windows (non-goal 8).
- **DevTools are docked inside the tab**, below or beside the page, the way Cursor does it (a second webview as DevTools host, `setDevToolsWebContents`; the host must not have navigated anywhere but its initial `about:blank`). The DevTools host is a distinct, explicitly recognised guest kind: the gate admits it with its own partition name and it may load `devtools://`; the page-guest rules (browser partition prefix, http/https/about:blank only) do not apply to it, and nothing else may claim that kind. If docking proves unworkable after one reasonable attempt **with these gate rules in place**, a detached DevTools window per guest is an accepted fallback — report it. (decided while planning; revised on plan audit)
- **Focus follows the guest through main.** DOM events (pointerdown, keydown) are not delivered from inside a `<webview>` to the embedder, so the terminal pane layer's pointerdown reporting (`terminal-pane.tsx:943`) cannot see clicks into a page. Main listens to each guest's `focus` and tells the renderer which browser tab took focus; the renderer focuses that tab's group. Conversely, every path that focuses the active tab of a group — ⌘1–9 and ⌘⌥ arrows (`workbench.tsx:475`), user tab activation (`workbench.tsx:431-439`, which today returns early when no task matches), switching workspace (`workbench.tsx:1173`) — must call `focus()` on the webview element when that tab is a browser tab (today `attach.focusTask` is a no-op for non-task ids, `terminal-attach.ts:264-266`). (revised on plan audit)
- **Main's per-guest bookkeeping resets with the renderer.** Reloading the main window destroys every webview; maps keyed by guest id, prepared-partition modes held for the renderer, and DevTools host links must be cleared through the existing renderer-reset hook (`index.ts:428-436`, `renderer-reset.ts`). (revised on plan audit)
- **Favicons do not widen the renderer CSP.** The packaged renderer's CSP has `img-src 'self' data: blob:` (`app-protocol-pure.ts:24`); main fetches the favicon through the guest's own session and hands the renderer a `data:` URL (so, in slice 2, a remote workspace's favicon also resolves `localhost` on the right device). Rejected: adding `http: https:` to `img-src`.
- **Certificate trust** is per partition: the renderer shows the trust prompt for a top-level load; accepting remembers host + certificate fingerprint for that workspace's partition across restarts and then also covers that host's subresources and WebSockets (an https dev server's HMR socket must not prompt again); 清除已信任的证书 forgets that workspace's entries. Never auto-trust. Whether this is built on `app`'s `certificate-error` or on the session's `setCertificateVerifyProc` is the executor's call. (decided while planning; revised on plan audit)
- **Downloads** from a browser partition are saved straight to the system Downloads folder under a non-colliding name, with a toast naming the file. (decided while planning)
- **Screenshots** use the guest's `capturePage` (whole visible page, or the rectangle the user drags over a frozen frame) and write an image to the clipboard, with a toast. (decided while planning)
- **Terminal link behaviour**: web links open on a plain primary click — `shouldOpenTerminalLink` (`terminal-link-activation.ts:21-24`) is no longer the gate for `WebLinksAddon` (`terminal-pane.tsx:320-324`); the file-reference provider (`terminal-pane.tsx:336-365`, ⌘+click copies the path) keeps its ⌘ gate — it is not a web link. A drag-selection that starts and ends on the same link must not open it: xterm activates on mousedown+mouseup over one link with no selection check (`@xterm/xterm` `Linkifier` `_handleMouseUp`), so the activate path checks `terminal.hasSelection()` first. The hover hint text changes accordingly. The right-click items read "the link under the pointer" from the web-link addon's `hover`/`leave` callbacks (link computation is asynchronous — a right click the instant the pointer arrives may miss the link; acceptable). `terminal-link-activation.ts` has no test file today; whatever pure rule remains gets one, or the module is removed if nothing is left in it. (revised on plan audit)
- **New-tab search engine is Google** (`https://www.google.com/search?q=`), matching Cursor. (decided while planning)
- **Bookmarks and history storage is the executor's call** (renderer `localStorage` in the `config.ts` key convention, or a JSON file in main's `userData`), within these constraints: persists across restart, global on this Mac, history capped (drop oldest), every read/write tolerant of missing or corrupt data. Pure parsing / suggestion ranking / address-bar input classification live in flat `components/workbench/*.ts` modules with unit tests.
- **Left to the executor**: component structure, IPC channel names, error-page and trust-prompt visuals (following `docs/design-guidelines.md`: `Tooltip`, lucide icons, no native `title` hints), the drag-to-screenshot interaction, the exact loading indicator, how the ports list on the blank page looks, and the tab context-menu items beyond move-to-new-group / close (e.g. 复制网址, 重新加载).

## Direction

Desktop-only change: `apps/desktop/src/{main,preload,shared,renderer}`. No protocol, server, daemon or CLI change in this slice.

Boundaries: main owns sessions/partitions, guest hardening, key forwarding, certificate/download/popup/screenshot/favicon handling, and the menu. The renderer owns tabs in the layout, toolbar, address bar, bookmarks bar, error pages, and the `<webview>` elements. The preload bridge (`window.cofluxDesktop`, types in `src/shared/desktop-bridge.ts`) gains the narrow calls between them; every new IPC handler checks the sender with the existing `isTrustedRendererUrl` pattern (`ipc-trust.ts`, as `tailcat-ipc.ts:9` does) and validates its arguments.

### Milestone 1: Pure models

Flat, unit-tested modules in `components/workbench/`: the layout accepts browser-tab entries (survive reconcile and parse, participate in move/split/close/focus like any tab), the per-workspace browser-tab records (URL, title) with storage parse/serialise, address-bar input classification (conclusion 5's rules plus the loopback set of conclusion 3), history/bookmark storage parsing with the cap, and suggestion ranking. Nothing wired yet. Validation: `pnpm -C apps/desktop test` → exit 0 (count grows); `pnpm -C apps/desktop typecheck` → exit 0.

### Milestone 2: Main-process browser host

Webview gate, partition preparation (local vs remote; remote blocks loopback), guest popup/key/⌘R/zoom handling, certificate trust storage, downloads, screenshots, favicon fetch, clearing data, the bridge API and its types. Validation: typecheck + test → exit 0.

### Milestone 3: The browser tab in the workbench

Browser tabs render in the flat layer and in the tab strips, with the toolbar, address bar + suggestions, ☆, bookmarks bar, ⋯ menu, DevTools toggle, blank-tab port list, error pages and trust prompt; entry points (terminal left-click/right-click, ports-menu button, palette and 文件 menu entry, popups); persistence and restore; all terminal-only paths skip browser tabs. Validation: typecheck + test + `pnpm -C apps/desktop build` → exit 0.

Milestones are strictly sequential (2 and 3 consume 1's model; 3 consumes 2's bridge) and 1 and 3 share the workbench files — one work package, do not fan out.

## Landmines

- **Hiding a webview.** Terminal panes are hidden with `hidden`/`display:none` (`terminal-pane.tsx`, pane layer). Electron documents that a `<webview>` must keep its internal `display:flex`, and `display:none` on a webview is a known source of detached/blank guests. Hide inactive browser tabs by other means (`visibility:hidden`, zero size, off-screen) and **verify** a hidden tab keeps its page and WebSocket (HMR) alive — conclusion 6 depends on it. This applies to **ancestors** too: `workbench.tsx:1157` puts `hidden` on the whole `<main>` (which contains the pane layer) whenever `activeWorkspaceId` is null — selecting a device without a directory workspace, an optimistic workspace, no selection. Either keep browser webviews out from under that element's `display:none`, or verify on Electron 44 what a `display:none` ancestor does to a guest and its sockets; do not assume either way.
- **Re-parenting reloads the page.** Any React structure that moves the `<webview>` element to a different parent node (a group container, a portal, a key change) reloads the guest. Keep it in the flat layer with a stable key.
- **The renderer CSP has `frame-src 'none'`** (`app-protocol-pure.ts:30`) and is only applied when the renderer is served from `coflux-app://` (`app-protocol.ts:47`), not by the Vite dev server. Whether it blocks a `<webview>` is unverified and a dev-server check will not catch it: build, then run Electron against `out/` without `ELECTRON_RENDERER_URL` (see Commands). If the CSP must change, change it minimally and update `app-protocol.test.ts:42`, which asserts `frame-src 'none'`, in the same change — that is expected, not a STOP.
- **Focus into a guest is invisible to the embedder** — see the focus decision. Clicking into a page must focus its group; a background load must never move focus.
- **Dev-only oddity**: in unpackaged runs `menu.ts:29` adds window-level `forceReload` (⌘⇧R) and `toggleDevTools` roles; with a guest focused they still act on the main window. Leave them; don't mistake it for a bug in the dispatch.
- **Origin rewrite is on the default session only** (`index.ts:118-121`). Do not install it, or anything else from the app's own session, on browser partitions — guest pages must send their real Origin.
- **`0.0.0.0` is blocked by Chromium** as a navigation target in recent versions; the address bar and the terminal/ports entry points should rewrite `0.0.0.0` to `localhost` before navigating.
- **`::1`-only dev servers.** Vite and others often bind `localhost` → `::1` only; `http://localhost:5173` works in the guest, but a hand-built `127.0.0.1` URL would fail. Build entry-point URLs with `localhost`, not `127.0.0.1`.
- **Menu drag regions.** Toolbar controls placed in a top-edge tab strip or toolbar that overlaps a window drag region must be `NO_DRAG_REGION_STYLE` and come later in document order (`docs/design-guidelines.md` "Interactive elements over a window drag region").
- **The desktop test script only picks up** `src/main/*.test.ts`, `src/renderer/*.test.ts`, flat `src/renderer/components/{settings,workbench}/*.test.ts` and `test/*.test.ts` (`apps/desktop/package.json:13`) — not `src/shared/`, not subdirectories, not `.test.tsx`. A test placed elsewhere silently never runs while typecheck stays green.
- **The worktree has no dependencies installed**; `pnpm install --frozen-lockfile` at the repository root comes first (Commands). A failure caused by missing dependencies is not a validation failure for the STOP rule.
- **React Compiler is on for the renderer**; render-time ref mirrors belong in `Workbench` (see plan 20260923's landmine).
- **Release note must say**: terminal links now open on a plain click (plan 109's ⌘ gate is gone for web links).

## Scope

In scope:
- `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`, `apps/desktop/src/shared/**`, `apps/desktop/src/renderer/**`
- `apps/desktop/package.json` — only to extend the `test` glob (e.g. to cover `src/shared/*.test.ts`); no new runtime dependency
- `docs/design-guidelines.md` (only if a new cross-cutting UI rule emerges)
- `wiki/plans/README.md`, this plan

Out of scope:
- `crates/**`, `packages/**`, `proto/**`, `apps/server/**`, `transport/**` — slice 2 owns the device tunnel; this slice changes no protocol
- `tests/**` — no black-box test: a broken browser tab is visible the first time it is opened (AGENTS.md "Test harness")
- Select element, agent control, extensions, password manager, sync (non-goals)

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies (first) | `pnpm install --frozen-lockfile` (repository root) | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0; report baseline → final pass count |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| CSP check (acceptance) | after the build, `node_modules/.bin/electron apps/desktop` with `ELECTRON_RENDERER_URL` unset (the main process then serves `out/renderer` over `coflux-app://` with `RENDERER_CSP`, `index.ts:39-40,59,440`); obey the desktop-preview skill's rules on profiles and what not to touch | a browser tab renders a page (webview not blocked by CSP) |
| Real-machine walkthrough (acceptance) | `pnpm dev:desktop:prod`, by the user | conclusion 9 holds |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Unit tests cover: browser entries surviving `reconcileLayout` and `parseLayout` and taking part in move/split/close; address-bar classification (bare port, host:port, URL, search, `0.0.0.0` rewrite, loopback detection incl. `127.x`, `[::1]`, `*.localhost`); history cap and corrupt-storage tolerance; suggestion ranking.
- [ ] `will-attach-webview` rejects a non-prefixed or unprepared partition and any attach-time `src` other than `about:blank`, and deletes `preload`; the DevTools host kind is admitted only as that kind.
- [ ] The renderer inserts a webview only after its partition's prepare call resolved; restored tabs on cold start follow the same order.
- [ ] Local vs remote is decided in main from the local daemon id, not from renderer state that is null on the first frame.
- [ ] Every browser partition has permission request and check handlers that deny by default.
- [ ] A remote workspace's partition cancels loopback requests of every resource type; a local workspace's does not.
- [ ] On a page that does not handle ⌘R itself, ⌘R with the guest focused reloads only the guest; with the renderer focused it reloads the window; from a docked DevTools host it never reloads the app; the accelerator stays main-registered.
- [ ] App page shortcuts work with focus inside a page; ⌘L and ⌥⌘I act on the tab.
- [ ] Clicking into a page focuses its group; ⌘1–9, ⌘⌥ arrows, tab clicks and workspace switches focus the webview when the target is a browser tab.
- [ ] No code path moves a `<webview>` to another parent or re-keys it when its tab moves between groups; neither a hidden tab nor any of its ancestors is `display:none` (including `workbench.tsx:1157`'s `<main>`), unless verified harmless on Electron 44 and reported.
- [ ] Main's per-guest state is cleared on renderer reset.
- [ ] Terminal web links open on a plain click but not after a drag-selection; file references still need ⌘; right-click on a link shows the three extra items.
- [ ] Terminal-only paths (attach, ⌘W stop, plan-104 move, recent places, banners) ignore browser tabs.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` has a row for this plan with its final status.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- `<webview>` cannot be kept alive while hidden, or cannot be moved between group rectangles without reloading — the embedding decision would need revisiting.
- The outcome requires out-of-scope files (e.g. a protocol field).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Slice 2 replaces this slice's remote-workspace loopback block with the tunnel; it hooks into partition preparation (the reason the webview starts at `about:blank`).
- The memory note "the main process has no device channel, and device.proto stays untouched" (executor settings, 2026-09-18) is deliberately overturned by slice 2, not this slice: a TCP data path for a browser must terminate in main's proxy, and there is no file-level substitute.
- Browser partitions accumulate under `userData/Partitions/`; a deleted workspace leaves its partition behind unless cleaned up — harmless, not data.
- Plan audit (fable, 2026-09-24) raised 12 points; all were adopted (marked `revised on plan audit`). One changed a rationale rather than a decision: on macOS a focused guest sees ⌘R before the menu, so the menu dispatch stays but its stated reason was corrected; plan 20260918-desktop-reload-shortcut and the `menu.ts:12-15, 91-92` comments describe the renderer case and are left alone.
- 2026-09-24, after implementation, by the user: the tab strip's ＋ now opens a menu (终端 ⌘T / 浏览器), Cursor's new-tab menu without its search box. This replaces conclusion 4's "＋ still creates a terminal"; ⌘T is unchanged and the empty group's 新建终端 button still creates a terminal directly.
