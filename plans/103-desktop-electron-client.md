# Plan 103: Replace the native macOS client with Electron—package current Web in `apps/desktop` and delete `apps/macos`

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 0e3c7ec..HEAD -- apps/web/src/config.ts apps/web/src/App.tsx apps/web/vite.config.ts apps/web/index.html apps/web/src/components/workbench/use-shortcut-modifier.ts apps/web/src/components/workbench/use-global-shortcuts.ts apps/web/src/components/workbench/sidebar.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/web/src/components/workbench/workspace-terminal.tsx packages/client/src/store.ts packages/client/src/device-router.ts apps/server/src/local-control.ts apps/server/src/hub.ts crates/worker/src/gateway.rs .github/workflows/release.yml docs/RELEASING.md pnpm-workspace.yaml package.json apps/macos`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent fable
- Planned at: `0e3c7ec`, 2026-09-11

## Requirement

On 2026-09-11, the user decided to abandon native Swift for macOS and use **Electron**. Three native efforts failed to reach parity; the third apps/macos implementation merged into main on 2026-09-10 with plan 100 unfinished. The completed repository must satisfy:

1. Add apps/desktop: an Electron shell packages **current apps/web unchanged**, with no feature rewrites. Launch on Mac, log in, and see the same workbench as the browser, reusing sidebar, terminals, Changes, import wizard, and dialogs.
2. Deliver all four desktop integrations selected by the user; omitting any is incomplete:
   - **Native menus and plain ⌘ shortcuts**: ⌘T/⌘W/⌘N/⌘1–9/⌘[ ] are no longer intercepted by a browser and match Web's existing standalone-PWA mappings.
   - **System notifications and Dock badge**: notify when a workspace agent awaits approval or an answer; badge counts workspaces needing attention. Clicking foregrounds the window and selects that workspace. Use existing sidebar approval/question aggregation, with no new server data.
   - **Signing, notarization, automatic updates**: CI artifacts use Developer ID signing and Apple notarization, pass Gatekeeper on a clean machine, and update automatically after new releases.
   - **Offline cold startup can access local terminals**: bundle UI rather than load app.coflux.dev. When the center is unreachable, cold startup still enters the workbench and opens local-daemon terminals via loopback direct. Extend the browser's already-loaded-page offline-attach contract to cold startup.
3. Delete all apps/macos through a forward deletion commit, recoverable from Git history. Mark plan 100 WITHDRAWN and stop describing native work as ongoing. Leave packages/swift-client and apps/ios unaffected.
4. Keep version admission strict: desktop build-id must match deployed Web's SHA. On rejection, show Update Required and trigger an update check, rather than treating it as disconnection.

### Product decisions (confirmed during exploration; do not ask again)

- **Consumer**: the user's everyday Mac workbench, replacing browser tabs/PWA and native app. The parity target is current **apps/web, not apps/macos**.
- **Form**: unchanged Web workbench in Electron. Authorization `/authorize/<id>`, OAuth consent, proxy-auth, port previews, and terminal links go to the default system browser. Desktop hosts only the main workbench at `/`.
- **Window**: hidden title bar with traffic lights embedded at the sidebar top, IDE-style. Conventional native App/Edit/View/Window/Help menus, detailed by executor. Reuse Web login/error/disconnection states.
- **Non-goals**: bundled daemon (still installed by cofluxd), initial Windows/Linux releases (keep code portable), Tray/menu-bar residency, Mac App Store, Ghostty (keep xterm.js/WebGL), xterm upgrades, deep links.
- **Observable acceptance**: launch/login/browser-equivalent workbench; ⌘T/W/N/1–9 perform app actions without closing windows or opening browser tabs; awaiting approval creates a notification/badge whose click focuses the workspace; port previews use the default browser; offline cold startup opens local terminals; automatic updates work; signed/notarized CI artifacts pass clean-machine Gatekeeper. As usual, the user performs manual UI acceptance, without Playwright.

The intended solution packages **one apps/web/src source with runtime bridge detection and no relaxed server/daemon checks**. Copying components into apps/desktop, loading a remote production URL, weakening Origin validation for loopback, hardcoding build-id dev, or deleting only part of apps/macos does not satisfy the requirement.

## Decisions & tradeoffs

- **Stack**: Electron 44.x, electron-vite 5.0.x, electron-builder 26.15.x pinned to 26.x, electron-updater 6.8.x. Rejected: Electron Forge (official Vite template still experimental and pinned to Vite 5, pnpm workspace support unresolved, automatic updates only Squirrel.Mac); smaller-community vite-plugin-electron; electron-builder 27 (changes mac.universal configuration; wait for stability). Based on 2026-09-11 research: npm latest Electron 44.3.0 uses Chromium 152/Node 24 and requires macOS 13+; electron-vite 5.0.0 accepts Vite ^5/^6/^7, compatible with Web's ^6.0.7; main-process ESM is available since Electron 28.
- **Bundle renderer assets and serve through a custom scheme**: register an app-specific standard/secure/supportFetchAPI scheme with protocol.registerSchemesAsPrivileged, and serve Web build output from asar with protocol.handle. **Production loads no remote URL.** Rejected: app.coflux.dev loading, incompatible with offline cold startup; file://, whose nonstandard scheme makes IndexedDB/relative paths/secure context unreliable. Based on `packages/client/src/browser-identity.ts:5-12` (P-256 identity in IndexedDB needs stable secure origin) and `apps/web/src/App.tsx:9-22` (pathname must be `/` to choose MainPage). Executor names the scheme, but **not coflux://**, reserved for future deep links.
- **Single UI source: apps/web/src**. Desktop renderer build directly consumes Web source and Vite plugin chain: React Compiler, Tailwind, @ alias, build-id. Copy no components/styles/pages. Rejected: another UI/fork, contradicting AGENTS.md's default Web iteration target and repeating mobile's divergence/freeze. Executor chooses renderer root at apps/web or an entry importing apps/web/src/main.tsx. Browser `pnpm -C apps/web build` output/behavior must remain unchanged. Based on `apps/web/vite.config.ts:38-70`.
- **All desktop differences use runtime bridge detection, never build-time forks**: preload exposes a minimal contextBridge object, named by executor. Web checks its presence; absent in browsers, behavior remains unchanged. Rejected: import.meta.env.VITE_DESKTOP-style compilation flags, creating divergent builds. Based on runtime standalone detection in `apps/web/src/components/workbench/use-shortcut-modifier.ts:13`. Allowed bridge surface: serverUrl, origin, notify, setBadge, main-to-renderer workspace-focus callback, and minimal notification-click/update-prompt needs. **No generic Node/fs/shell access.**
- **Server address comes from the bridge**: desktop SERVER_URL defaults to wss://api.coflux.dev/client, configurable in the app for self-hosting; dev defaults to ws://localhost:8787/client. Browser derivation stays unchanged. Rejected: location.host under a custom scheme, which has no usable server host. Based on `apps/web/src/config.ts:1-3`.
- **Origin: main rewrites both WebSocket handshakes without relaxing checks**. Use session.webRequest.onBeforeSendHeaders to write the **same stable https Origin** for center /client and loopback ws://127.0.0.1:*/device. Web reports that same value through deviceTransport.origin. It must use https, remain stable across versions, differ from app.coflux.dev so grants distinguish desktop, and need not resolve. Executor chooses and records it in Maintenance notes. Rejected: allowing custom schemes in validOrigin (plan 083 made relaxed validation a STOP, retained here); reusing app.coflux.dev, which makes grants indistinguishable. Fallback only if Chromium cannot rewrite WebSocket Origin: serve the renderer on a fixed loopback HTTP port, still without relaxed checks, documenting evidence in the plan.
  Based on `apps/server/src/local-control.ts:415-418` (only http/https and parsed.origin === origin); `apps/server/src/hub.ts:206-207` (pair self-reported origin exactly matches /client handshake); `crates/worker/src/gateway.rs:168-176` (loopback allowlist from center); `packages/client/src/store.ts:317` (`options.deviceTransport.origin ?? location.origin`); Electron webRequest docs, verified with Context7 on 2026-09-11, supporting webSocket resourceType and replaceable requestHeaders.
- **Renderer drives notifications/badges from store transitions; main only executes**: detect workspace transitions into approval/question, deduplicate, and call notify/setBadge. Main opens no additional center connection. Rejected: another WebSocket subscription with duplicate state machines and holder contention. Based on existing aggregation in `apps/web/src/components/workbench/sidebar.tsx:23-24`. Executor designs click focusing and deduplication: notify once per workspace/state until recovery and reentry.
- **Desktop shortcuts equal standalone**: use-shortcut-modifier returns standalone-equivalent plain ⌘ in desktop; native accelerators match Web physical keys. The page handles ⌘W/T/N rather than closing/creating windows. Rejected: a separate mapping. Based on `use-shortcut-modifier.ts:6-13,30-36` and `apps/web/src/components/workbench/use-global-shortcuts.ts:43-58`.
- **External links/new windows always use the system browser**: setWindowOpenHandler denies app windows and passes only http(s) to shell.openExternal; will-navigate intercepts navigation away from the app scheme. Based on port-preview window.open at `apps/web/src/components/workbench/workspace-terminal.tsx:730` and WebLinksAddon at `terminal-pane.tsx:217`.
- **Lockstep admission, no server changes**: reuse resolveBuildId's short Git SHA; matching deployed Web is admitted. Version rejection displays Update Required and triggers electron-updater, never ordinary disconnection/retry. Operations can temporarily allow old desktop builds through the existing COFLUX_BUILD_ID environment union. Rejected: server-maintained desktop build lists, adding changes and weakening plan 033; reporting dev to bypass admission. Based on `apps/server/src/hub.ts:2973-2986,3071-3086` (explicit env union build-id.txt; dev always admitted) and `apps/web/vite.config.ts:12-21`. Document same-SHA desktop release/production deployment in RELEASING or deployment docs; otherwise desktops are rejected until updated.
- **Release via independent desktop-v* workflow, arm64 first, reusing signing secrets**: add `.github/workflows/desktop-release.yml` on macOS with hardened runtime, entitlements, and @electron/notarize/notarytool. Reuse signing identity and six release-signing environment secrets by reference only: MACOS_CERT_P12, MACOS_CERT_PASSWORD, APPLE_TEAM_ID, NOTARY_API_KEY_P8, NOTARY_KEY_ID, NOTARY_ISSUER_ID. Universal is a configuration option, not initial release. Rejected: daemon v* tags/release.yml, whose SemVer cadence is separate and whose cofluxd chain plan 087 explicitly preserves. Based on `.github/workflows/release.yml:112-113,144-188` and RELEASING's secret table.
- **Prefer Cloudflare R2 for updater** (user addition, 2026-09-11): CI uploads installers/latest-mac.yml through S3-compatible API; electron-updater generic reads the R2 public custom domain. User supplies **new** bucket, S3 endpoint, access key, secret, and public domain variables/secrets. Missing any must **explicitly fail** the workflow, never skip upload or silently fall back. GitHub Release may mirror notes/installers but is **not** the updater source. Rejected: GitHub provider despite the public repository, because the user requests R2 and downloads are unreliable in mainland China. Executor chooses electron-builder s3 with endpoint or a separate upload step.
- **Preserve security baseline**: sandbox/contextIsolation on, nodeIntegration off. Disable RunAsNode, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments, GrantFileProtocolExtraPrivileges; enable EnableCookieEncryption, EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar. Serve CSP at script-src 'self' strength while allowing required WebGL/WebRTC/WebSocket connections to center and 127.0.0.1. setPermissionRequestHandler denies by default; native main-process Notification needs no renderer permission. ipcMain.handle validates sender. Rejected: disabling sandbox or enabling preload Node integration for convenience.
- **Forward-delete apps/macos after rescuing reusable assets**: move `apps/macos/Sources/AppIcon.icon`, the Icon Composer source sharing Web/iOS's >- symbol, into apps/desktop; executor chooses icns export. Move `apps/macos/scripts/dev-fixture.mjs`, isolated DB/HOME/device integration tooling, into scripts if needed for desktop validation. Delete the rest with git rm -r, without rebasing/history rewriting. Mark plan 100 WITHDRAWN in plans/README with 2026-09-11 Electron switch and Git-history recovery note. Rewrite ROADMAP section 4's stale “withdrawn 2026-08-26” to Electron status; update architecture, README monorepo table, and AGENTS to add desktop/remove macOS. Based on plan 087's forward-deletion/preserved-plan/unchanged-release decisions. Current apps/macos: 476 files, 87MB, including 82MB NativeGrammars; no iOS/CI references.
- **Do not upgrade xterm**: retain Web's 6.0.0, WebGL addon, and IME patch. Based on `apps/web/src/components/workbench/terminal-pane.tsx:226-231` dynamic WebGL/onContextLoss fallback. patchImeCommittedInput depends on 6.0.0 internals; upgrades require Chinese IME retesting.
- **Workspace configuration**: apps/* already includes desktop in pnpm-workspace.yaml. Add electron to allowBuilds and dev:desktop to root package.json. No node-pty/native modules; PTYs live in the daemon. Based on existing esbuild allowBuilds entry.

## Direction

M1 precedes the other three milestones, creating bridge/desktop directory and enabling M4's icon rescue. M2/M3 share main/config files; M4 has no shared files but final docs depend on their resulting design. **Execute one work package without splitting.**

### Milestone 1: Electron runs current Web with direct/P2P/relay and unchanged validation

Build main/preload/renderer outputs. Dev uses electron-vite/local center. Production serves asar-bundled Web under the custom scheme at pathname /. Bridge provides serverUrl/origin; main rewrites both handshakes with stable https Origin and Web self-reports it. Browser build/behavior remains unchanged. Move AppIcon.icon into desktop.
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json`; `pnpm -C apps/web build` with dist/build-id.txt present; `pnpm test:web`; CI client state-machine tests; desktop typecheck/build all pass. New tests cover which URLs receive Origin rewriting, exact replacement value, no rewriting for non-WebSocket, and bridge detection/SERVER_URL with and without bridge.

### Milestone 2: Menus, ⌘ shortcuts, notifications, badges, external links

Wire native menus/accelerators, standalone-equivalent shortcuts, approval/question notifications and badges cleared on recovery, notification-click workspace focusing, browser-only window.open/links, and will-navigate interception.
Validation: types and all M1 commands pass. Test pure notification deduplication/badge-count functions from two workspace-activity snapshots.

### Milestone 3: Admission handling, packaging, signing/notarization, R2 updater, release workflow

Version rejection produces Update Required and a check. Configure arm64 builder, hardened runtime, entitlements, notarization, Fuses, and R2 generic publishing. Desktop-v* workflow signs/notarizes/uploads and explicitly fails missing secrets. Add RELEASING desktop section with lockstep and R2 secret names/locations, never values.
Validation: types pass; test rejection-to-update-prompt mapping; verify workflow/builder configuration parsing with an exit-code-based YAML/JSON parser or equivalent.

### Milestone 4: Delete apps/macos and complete documentation/index

No apps/macos entries in git ls-files. ROADMAP, architecture, README, AGENTS reflect Electron without dead links. Mark 100 WITHDRAWN and update 103 status in plans index.
Validation: `git ls-files apps/macos | wc -l` → 0; `grep -rn 'apps/macos' README.md AGENTS.md docs/*.md` contains only explicitly historical/deleted references, no live links; `git diff --check` → exit 0.

## Landmines

- **Origin is a hard gate**: local-control.ts:415-418 rejects non-http(s); hub.ts:206-207 requires exact reported/handshake match; gateway.rs:168-176 uses center-provided grant allowlists (local-control.ts:354-355). Without rewriting a custom-scheme origin, direct never pairs although relay works. **Working relay does not prove direct.** Use architecture.md:363-369's lsof method to observe Electron/coflux-worker ESTABLISHED at 127.0.0.1:8788.
- **Notifications fail in unsigned builds**: Electron uses macOS UNNotification since 42. Without local Developer ID, validate notification/badge with signed CI output; do not add an HTML5 fallback for unsigned builds.
- **Fuse consequences**: RunAsNode off disables child_process.fork; use utilityProcess. ASAR integrity makes post-packaging asar modifications crash startup; order signing/notarization correctly.
- **pnpm 11 blocks dependency build scripts**: allow electron or installation lacks its binary with an unclear error.
- **Web index assumptions**: manifest crossorigin=use-credentials, absolute /favicon.svg paths, and pathname routing require a standard scheme with host, e.g. scheme://app/, retaining Vite base / so dynamic WebGL chunks resolve.
- **Build-id/dev**: Vite dev uses admitted dev; production uses Git SHA. Package in a checkout retaining Git history/HEAD; do not lose it through shallow-checkout configuration.
- **Lockstep is intentional**: older desktop rejection after production deployment is expected. Do not turn it into a retrying connection loop.
- **Native tree size**: 476 files, 87MB, 82MB generated NativeGrammars parser.c, 10 commits. Forward-delete, never rebase. CI/iOS have no references, verified 2026-09-11.
- **Preserve loopback grant/lease semantics**: only main's Origin header changes. Pair/grant/lease/P2P, with WebRTC in renderer, stays identical.
- **Parallel branch**: dev/20260911-agent-cwd-workspace owns plan 102 in another session. Resolve plans/README conflicts by row; do not edit 102's row.
- **ROADMAP:78-85 section 4 is stale**, still saying withdrawn 2026-08-26 despite the third effort. Follow this plan rather than restoring native ongoing status.

## Scope

In scope:
- New `apps/desktop/**`
- `apps/web/src/**`: bridge detection, config server URL, deviceTransport.origin, notifications/badges, standalone-equivalent shortcuts; browser behavior unchanged. `apps/web/vite.config.ts` only if plugin-chain export is needed
- `packages/client/src/**`: only minimal origin/bridge type exposure if needed
- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- New `.github/workflows/desktop-release.yml`; ci.yml only for desktop types/build gates
- `docs/RELEASING.md`, deployment.md, ROADMAP.md, architecture.md, `README.md`, `AGENTS.md`
- `plans/README.md`, `plans/103-desktop-electron-client.md`
- `apps/macos/**` deletion, rescuing AppIcon.icon/dev-fixture.mjs; `scripts/` for migrated fixture

Out of scope:
- `apps/server/**`, `crates/**`, `proto/**`: satisfy Origin/admission client-side without relaxation
- `apps/ios/**`, `packages/swift-client/**`: iOS remains the sole consumer; unchanged
- `apps/mobile/**`: frozen; build gate only
- `.github/workflows/release.yml`, npm-publish.yml: daemon/CLI release chain
- Windows/Linux packaging, Tray, deep links, bundled daemon, xterm upgrade

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies | `pnpm install` after lockfile changes, otherwise --frozen-lockfile | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Web production build | `pnpm -C apps/web build` | exit 0; apps/web/dist/build-id.txt exists |
| Web unit tests | `pnpm test:web` | All pass |
| Client state machines | Command at `.github/workflows/ci.yml:156` (DeviceRouter transport/holder/ACK) | All pass |
| Desktop types/build | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop build` (executor defines script names and documents them) | exit 0 |
| Desktop unit tests | `pnpm -C apps/desktop test` (Origin, notification deduplication, rejection mapping) | All pass |
| Mobile build gate | `pnpm -C apps/mobile build` | exit 0; shared changes preserve frozen client |
| Formatting | `git diff --check` | exit 0 |
| Unsigned launch (acceptance) | `pnpm -C apps/desktop exec electron-builder --mac --dir`, then launch .app | Login page, no CSP/scheme errors |
| Three transports (acceptance) | Isolated fixture starts center/daemon; desktop logs in and opens terminal | lsof proves direct; test P2P and relay once each; observed/reported Origin match |
| Offline cold startup (acceptance) | Stop center, cold-start app | Workbench opens and attaches local terminals |
| Signing/notarization (acceptance) | Push desktop-v* tag after user supplies R2 secrets and explicitly requests release | Notarization passes, R2 has latest-mac.yml, clean-machine Gatekeeper passes |
| iOS shared core (acceptance) | `swift test --package-path packages/swift-client` | exit 0 |

## Done criteria

- [ ] All non-acceptance commands pass; verifier runs acceptance after review, with signing/release separately requested by user.
- [ ] Packaged app cold-starts to login and then browser-equivalent workbench; direct/P2P/relay work without server/daemon changes.
- [ ] ⌘T/W/N/1–9 match Web semantics; signed-build notifications/badges/click focusing meet Requirement.
- [ ] Version mismatch shows Update Required and checks; R2 generic source and desktop-v* workflow exist.
- [ ] apps/macos deleted, icon rescued, plan 100 WITHDRAWN, no dangling docs links.
- [ ] Meaningful tests cover Origin decisions, bridge/address resolution, notification deduplication, rejection mapping.
- [ ] Every Decisions & tradeoffs entry followed; deviations documented in plan.
- [ ] No out-of-scope changes.
- [ ] plans/README statuses updated for 103 and 100.

## STOP conditions

- A cited fact changes, especially validOrigin, hub admission, store.ts:317 injection, or standalone detection.
- Rewritten Origin is not observed by server/daemon and fixed-loopback-HTTP fallback is infeasible; never relax apps/server/crates.
- Any milestone requires server/crates/proto changes.
- Electron-vite 5 compatibility with Vite 6/TypeScript 7 cannot be isolated within desktop.
- Validation fails twice after one reasonable fix.
- iOS/swift-client/mobile functionality must change.

## Maintenance notes

- Electron majors arrive every eight weeks and only the latest three are supported. Review breaking changes; 44 removed renderer clipboard. Builder 27 changes mac.universal configuration and needs migration.
- Once released, desktop Origin becomes part of grant binding; changing it invalidates all desktop grants. Final value: `https://desktop.coflux.dev`, DESKTOP_ORIGIN in apps/desktop/src/main/origin.ts. Main rewrites every renderer WebSocket handshake, including relay, but no non-WebSocket requests.
- Lockstep: tag desktop-v* at the same SHA before deploying production, or accept rejection until CI packages it. Use COFLUX_BUILD_ID union during transitions.
- Retest Chinese IME punctuation after xterm upgrades (patchImeCommittedInput).
- Notification/Keychain behavior is trustworthy only in signed artifacts; local ad-hoc failures are not regressions.

## Final changes (2026-09-11)

- User changed the updater source from R2 to GitHub during completion. Installers/blockmaps live in GitHub Release. Workflow rewrites latest-mac.yml filenames to absolute URLs for that release and pushes it to desktop-updates. The app's generic provider reads https://raw.githubusercontent.com/myWsq/coflux/desktop-updates. Do not use electron-updater's github provider, which reads releases/latest and mixes this repository's daemon v* and desktop-v* releases. No new secrets.
