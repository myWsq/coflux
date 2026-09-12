# Plan 106: Consolidate the frontend into desktop, remove web/mobile source, require the bridge, and add four desktop features

> This plan is an outcome contract, not a step-by-step script. Understand requirements/decisions and implement against live code. Validate only if also the verifier; delegated executors implement with checks outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat ce7026b..HEAD -- apps/web apps/desktop apps/mobile packages/client package.json pnpm-workspace.yaml .github/workflows/ci.yml .github/workflows/desktop-release.yml docs AGENTS.md README.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: 103, 105, both DONE on main
- Category: refactor
- Execution: subagent (host general-purpose agent, model fable; 2026-09-11 preflight authorized automatic progress without further confirmation)
- Planned at: `ce7026b`, 2026-09-11

## Requirement

On 2026-09-11 the user decided: **iterate only Electron desktop; freeze web without taking it offline**. Three native macOS attempts failed to reach parity (082/083/100 withdrawn); 103 packaged existing web into Electron with parity immediately, making separate frontend maintenance pointless. This is the first of three slices. Server-hosted satellite pages and further desktop-native upgrades each require separate plans.

### Product conclusions, confirmed during exploration

- **Consumer**: user's daily Mac desktop app. New-device authorization links, MCP OAuth consent, and port-preview authentication still run in the system browser through the frozen bundle.
- **Shape**: apps/desktop is the sole frontend/default iteration target. app.coflux.dev and m.coflux.dev serve the last pre-split build unchanged, not a download page or changed root. Remove all apps/web and apps/mobile source; recoverable from Git baseline ce7026b.
- **Same stack**: React 19/Compiler, Vite/electron-vite, Tailwind 4/Astryx, xterm 6/WebGL, Zustand. Move, do not replace technologies.
- **Scope**: structural merge with unchanged behavior plus safeStorage tokens, persisted window geometry, file-based main logs, and removing Open Web Version from Help. Everything else remains observably identical.
- **User acceptance**: same workbench; window size/position restore; no coflux_token in localStorage after login; main logs in ~/Library/Logs/Coflux; no web Help entry; device/MCP/preview browser flows still work. User performs UI walkthrough, not Playwright.

Correct result moves renderer with git mv to apps/desktop/src/renderer, makes window.cofluxDesktop mandatory, removes browser-only branches, changes no server code, and leaves frozen production web intact. Retaining web as source, copying instead of moving, isDesktop dual-mode logic, generic Node bridges, changed admission/COFLUX_WEB_URL, or a web download landing page do not satisfy this task.

## Decisions & tradeoffs

- **Renderer at apps/desktop/src/renderer, preserving history with git mv.** Move web src/index.html/public; merge createWebViteConfig compiler/Tailwind/alias/build-ID chain into electron.vite.config.ts; remove web directory. Rejected: duplicate copies risk drift; retaining independent web violates explicit request. Preserve absoluteBase forcing `/`, currently needed by coflux-app protocol, and __COFLUX_BUILD_ID__ as identity only under 105. writeBuildIdFile may remain/move or be deleted with its release notice; workflow must not reference web. Evidence: desktop config:9-33, web config:38-61,12-21, release workflow:105.
- **Executor chooses tsconfig split/references.** Main/preload need Node/electron-vite types; renderer DOM/react-jsx/vite/client/alias paths. Desktop typecheck must cover all three, tests both prior renderer and main cases. CI/release call only these consolidated commands. Evidence: both tsconfigs, root test:web and desktop test script.
- **Mandatory bridge, authoritative types in desktop/src/shared.** Missing bridge is an explicit startup error, never silent fallback. Delete nullable getDesktopBridge/isDesktop, beforeunload confirmation, PWA/apple metadata/manifest/icons, Cmd+Ctrl prefix/standalone detection, location-derived client URL, build-ID reload guard, reloadOnOutdated, and environment-selected clientKind/offlineCatalog. Rejected: keeping contingency browser code retains abandoned burden. Keep narrow bridge; only token methods may be added, no generic Node/fs/shell. Satellite routes disappear with web; desktop serves root only. Evidence: web desktop-bridge:59-80, config:4-8, MainPage:12-40, App:18-22, shortcut hooks, sidebar:234, workbench:153, index.html:9-15, client store:288-291.
- **Retain independent packages/client.** React/Electron-free protocol/store/DeviceRouter with separate tests and protocol/Zustand dependencies remains TS truth. Do not fold into desktop. Keep ClientKind literal web because frozen clients/server 105 contract still use it.
- **Inject token storage into createCofluxClient**, replacing direct localStorage token access. Executor chooses names/sync/async. Preserve login write and logout/authError removal timing. Offline catalog remains localStorage, and IndexedDB P-256 identity unchanged. Client never detects the desktop bridge. Evidence: store:153-154,255,567,577,828; browser-identity.ts.
- **safeStorage encryption in main**, persisted under userData through preload. Renderer stores no plaintext token. On first launch migrate legacy coflux_token only if secure storage empty, then delete old localStorage entry. Encryption unavailable, decrypt failure, or corrupt file becomes logged-out state without crash, plaintext fallback, or custom dialog. Rejected: keytar/native dependency, or a second main-process login connection already rejected by 103. Token must be ready when creating client, e.g. async startup read before MainPage mount. Evidence: main index:27-31 isolates dev userData; existing preload/IPC trust patterns.
- **Persist window bounds** in a separate userData file, not user-editable settings.json. Save on close/quit, validate intersection with a current display before restore, otherwise default centered 1280×820. No window-state dependency for a small main-process implementation. Evidence: window.ts:31-40, settings.ts.
- **electron-log for main and updater**, latest 5.x resolved by pnpm, macOS default ~/Library/Logs/<app.name>/main.log and default rotation. Do not collect renderer console. Rejected: custom rotation/path/multiprocess logger. Updater currently lacks one.
- **Remove Open Web Version Help item and WEB_URL only**, leaving other Help items. Evidence: menu.ts:12,97.
- **Zero server changes**: COFLUX_WEB_URL, three satellite redirects, client-kind admission untouched. STOP if server/proto changes become necessary. Evidence: config:115-116, hub:2005, oauth:153, proxy:632.
- **Remove mobile source entirely.** Retaining it keeps browser compatibility/build obligations; native iOS covers mobile use. Live m domain stays untouched. Evidence: CI:176-177, mobile dependency on client.
- **Document freezing/deployment; user performs production operations.** Remove web/mobile rebuild commands from normal deploy docs. Explain frozen pre-split builds, user-recorded production SHA, recoverable ce7026b source. Move frozen dist outside checkout, e.g. /opt/coflux-web-frozen/{app,m}, and point Caddy root/COFLUX_BUILD_ID_FILE there **before deploying any post-split commit**. User decides a baseline tag; do not create it here. Rejected: incidental production changes require user authority. Evidence: deployment:111-117,41-42, config:221-226 rereads build-ID file per auth.
- **Consolidate CI/release/root scripts**: delete web build/test:web/mobile steps; desktop now covers renderer. Remove release web tsc, update/remove build-ID notice. Remove dev:web/dev:mobile/test:web; make dev server+desktop, or executor's documented equivalent. Update lockfile for members/new dependency; frozen install must pass. Evidence: CI:140-149,176-177; release:94-105; root package.
- **Update all current documentation**, not a chronological web history: AGENTS default target/commands and remove obsolete production-port-forward dev-web/manifest-crossorigin pitfalls; root README table/quickstart; ROADMAP §§1/4; OPEN_QUESTIONS:16,45; design-guidelines title/introduction only; architecture §§1/12; RELEASING:161,191; desktop README; index. History belongs in plans.
- **Unchanged**: xterm/WebGL/IME patches, 078 startup overlay through first snapshot, desktop Origin, protocol admission, iOS/Swift, builder config, protocol package, Rust, black-box tests.

## Direction

One package, three milestones. M2/M3 depend on M1; although otherwise independent they share package/lock/docs and should not parallelize. Historically each milestone used one or more Chinese commits with Co-Authored-By trailers.

### Milestone 1: Move without desktop behavior changes

Remove web, place renderer, require bridge, delete browser branches. Inject client token storage, temporarily backed by localStorage until M2. Remove reloadOnOutdated/guard. Root/lock no longer reference @coflux/web.
Validation: frozen install; desktop types/tests/build; client tests; source scan outside plans/docs for apps/web/@coflux/web/isDesktop/getDesktopBridge empty.

### Milestone 2: Four desktop features

Secure token persistence/migration, bounds/display checks, electron-log main/updater, no web menu. Add meaningful pure tests at least for bounds fallback, token-failure logged-out normalization, and migration decisions.
Validation: desktop types/tests/build pass; no app.coflux.dev in desktop source.

### Milestone 3: Remove mobile and consolidate CI/docs

Delete mobile, update workflows/root scripts/docs/index.
Validation: frozen install, untouched-server types, plugin sync check; no web/mobile/package/dev:test references outside plans or workflows.

## Landmines

- absoluteBase remains necessary: electron-vite forces production renderer base `./`, but coflux-app://app/ serves from root and needs `/`. Do not delete its post plugin when moving root (config:11-25).
- safeStorage Keychain ACL follows signing. Ad-hoc dev and Developer ID app share Coflux Safe Storage item and may prompt/fail decrypt on switching. Logged-out fallback handles this; separate userData prevents encrypted-file overwrite.
- Existing resolveServerUrl browser-fallback tests must become bridge-only tests, not disappear wholesale.
- If deleting build-ID writer, remove release workflow's cat notice too or builds fail.
- Startup overlay references /favicon.svg; retain it when removing PWA assets.
- apps/* workspace glob removes members with directories; regenerate lockfile using nonfrozen install, commit it, then verify frozen install.
- Production checkout does not remove ignored old dist, which can keep frozen web apparently working while build-ID path remains old. Explicit directory migration is required, not automatic compatibility.
- Full black-box remains precommit gate despite frontend independence: needs OrbStack PG and built daemon. Three local presence cases false-fail; auto-update/local-first/signed-upgrade may flake and be classified by targeted rerun. Do not tune unrelated thresholds.
- Claude guard regex can reject document heredocs/commit bodies mentioning Git worktree mutations; use file editing tools. Session shell is zsh; dependent steps use && rather than relying on set -e.
- Remove desktop devDependency @coflux/web. Migrate client/protocol plus Astryx/xterm/shiki/lucide/tailwind-merge/clsx/Zustand/React dependencies. Executor classifies build/runtime; builder packages only out/**, and build/pack must pass.
- AGENTS points to design-guidelines; update its UI wording alongside document title without breaking links.

## Scope

In scope:
- Move/delete web, delete mobile, desktop renderer/main/config/tests/README
- Client token injection/browser-only removal/exports
- Root package/lock; workspace comments if needed
- CI and desktop-release workflows
- AGENTS, README, ROADMAP, OPEN_QUESTIONS, design-guidelines, architecture, RELEASING, deployment
- This plan/index

Out of scope:
- Server/proto/protocol package, hard zero-change rule
- Rust/CLI/integrations
- iOS/Swift
- Black-box tests
- Satellite-page ownership, second slice
- coflux deep links, local UDS, terminal replacement, server-admission cleanup, download page, Windows/Linux, third slice
- Production directory/Caddy/env changes, tags/push/merge, user operations

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies | `pnpm install --frozen-lockfile` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server unchanged | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Plugin consistency | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Residual source references | `git grep -n "apps/web\|apps/mobile\|@coflux/web\|@coflux/mobile\|dev:web\|test:web\|isDesktop\|getDesktopBridge" -- ':!plans'` | Empty |
| Workflow references | `grep -n "apps/web\|apps/mobile" .github/workflows/*.yml` | Empty |
| Unsigned acceptance package | `pnpm -C apps/desktop pack` | exit 0; dist/mac-arm64/Coflux.app launches |
| Full black-box acceptance | `pnpm -C tests test` | Green except documented local false failures/flakes |
| UI acceptance | User launches packaged app | Requirement checklist |

## Done criteria

- [ ] Nonacceptance commands pass; verifier runs acceptance.
- [ ] Web/mobile absent; git log --follow on moved workbench traces web history.
- [ ] No renderer desktop-detection/beforeunload/manifest/Cmd+Ctrl/location-derived URL/outdated-reload paths.
- [ ] Client no longer uses localStorage for tokens or exposes reloadOnOutdated.
- [ ] Encrypted userData token only; legacy migrated/deleted; failures show login, not crash.
- [ ] Bounds restore and offscreen fallback.
- [ ] Main/updater logs use default electron-log file.
- [ ] No web Help item or app.coflux.dev source literal.
- [ ] Scripts/workflows/current docs drop web/mobile references; deployment explains frozen directory migration.
- [ ] Meaningful bounds/token/migration tests.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The plan 106 row in `plans/README.md` is updated.

## STOP conditions

- Cited facts change, especially renderer wiring, token storage points, server webUrl use.
- Completion needs server/proto/protocol-package/black-box changes.
- electron-log cannot resolve or frozen lock fails for unrelated reasons after update.
- Mandatory bridge reveals a browser-only flow without an agreed treatment.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- Frontend iteration now means desktop. ClientKind web and 105 admission remain for frozen web.
- Until slice two, authorize/OAuth consent/proxy-auth exist only in frozen bundle. Before changing corresponding server messages, verify frozen flows or implement slice two first.
- Repeated login prompts: inspect Coflux Safe Storage Keychain permissions and ~/Library/Logs/Coflux/main.log.
- ce7026b contains last web/mobile source; live frozen bundle SHA belongs in deployment docs.
