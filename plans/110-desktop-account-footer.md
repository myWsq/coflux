# Plan 110: Desktop sidebar account footer—identity, account menu, and an Update button replacing the gear when ready

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c202a0d..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/config.ts apps/server/src/infra/database/schema-migrations.ts packages/protocol/src/index.ts packages/client/src/store.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/main/updater.ts apps/desktop/src/main/update-state.ts apps/desktop/src/renderer/config.ts apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/desktop-update.ts apps/desktop/src/renderer/components/workbench/branch-menu.tsx tests/src/password.test.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED (generated protocol code for three languages, server, client, and desktop; small behavioral surface)
- Depends on: none (main `c202a0d`, including 109; current desktop version 0.1.5)
- Category: feature
- Execution: subagent (host general-purpose subagent, `model: opus`; preflight recorded in dev:explore on 2026-09-11: advance automatically without further confirmation; pushing, PRs, merging main, and releases still require an explicit user request)
- Planned at: `c202a0d`, 2026-09-11

## Requirement

Desktop (`apps/desktop`, Electron 44 with a React 19 renderer) has only Projects and Devices in its sidebar. Its skeleton is a top drag strip followed by a `flex-1` scrolling region (`apps/desktop/src/renderer/components/workbench/sidebar.tsx:225-232`). It shows no account information or logout entry. Nothing in the desktop renderer calls `@coflux/client` `logout()` (`packages/client/src/store.ts:816`). Check for Updates… and Server Address… exist only in the native app menu (`apps/desktop/src/main/menu.ts:35-37`). electron-updater already checks after 15 seconds and every four hours, downloads automatically, and installs on quit so the next launch uses the new version (`apps/desktop/src/main/updater.ts:14-16, 47-48`). Users cannot see that an update is ready and must wait for a later quit. The user requests a Cursor-style bottom-left footer: avatar, two text lines, and a trailing gear that becomes an update button when ready.

One fact requires a protocol change: the renderer currently **does not know its own identity**. `AuthOk` returns only `account_id / client_token / ice_servers` (`proto/coflux/v1/client.proto:197-204`). Password login briefly holds the username in memory and then discards it; token-based cold startup knows nothing. The server user model has only `email` (`apps/server/src/store.ts:114-119`; local mode uses an environment username, `apps/server/src/config.ts:110`), with no nickname, avatar, or plan.

After completion, entering the workbench shows the login identity and connected server. Account actions—check for updates, server address, logout—have a clear entry. Once an update finishes downloading, an accent-colored Update button appears in the sidebar; clicking restarts into the new version. Ignoring it and quitting/reopening still installs the update, preserving existing behavior.

### Product decisions (confirmed during exploration; do not ask again)

```
├──────────────────────────────┤
│ (W)  wsq@example.com    [⚙] │   Default: gear
│      api.coflux.dev          │
└──────────────────────────────┘
│ (W)  wsq@example.com [↑Update]│  Downloaded: accent-colored Update replaces gear
```

1. **Position and structure**: a fixed footer outside the sidebar scrolling region. From left to right: initials avatar (no photo; Astryx `Avatar` derives initials from `name`, using the email portion before `@`), login identity on the first line (email in password mode, username in local mode), server host on the second line (from renderer `SERVER_URL`, e.g. `api.coflux.dev`), and trailing button. If identity is unknown because an old server omits it or an offline cold-start cache lacks it, show Signed In and Astryx's default person icon; never leave a blank.
2. **Menu**: the entire row and gear open the **same** dropdown, containing Check for Updates (state-dependent copy; see pure-function mapping), Server Address… (reuse the existing native main-process dialog), a separator, and Log Out (return directly to login without confirmation).
3. **Update button**: replace the gear with an accent-colored Update button only when `DesktopUpdateState.status === "downloaded"`. Its Tooltip says, for example, “v0.1.6 downloaded; click to restart and update.” Clicking calls `bridge.installUpdate()`. For `checking / available / downloading / not-available / error`, retain the gear and a quiet footer; show details only in menu copy. The full row still opens the menu when the update button is present.
4. **No background updater changes**: preserve timing, autoDownload, and autoInstallOnAppQuit. Mounting the footer **does not** trigger a check.
5. **Non-goals**: settings page, avatar/profile editing, billing/plans, in-app server switching, check-frequency changes, Windows/Linux, or native-menu additions/removals.
6. **Observable acceptance**: after login, show email and host; all three menu actions work; logout returns to login. Within four hours of a new `desktop-v*` release, or after restarting, the gear becomes Update; clicking enters the new version. Ignoring it and quitting/reopening also updates. The footer remains fully visible with the disconnection banner. As usual, the user performs a real-machine UI walkthrough; Claude does not use Playwright or launch the app for a walkthrough.

## Decisions & tradeoffs

- **Identity comes from the protocol, not local inference**: add an `optional string` login display identity to `AuthOk`. At successful authentication, the server sets it to the token-bound user's `users.email` in password mode (token path: `userIdForClientToken` then read user by id; password path: `checkCredentials` already returns userId), or `config.username` in local mode. Missing users, including legacy tokens with NULL `user_id` or deleted users, leave the field **unset**, never reject authentication. Optional distinguishes an old server's omission from an empty string.
  Rejected: saving a login name alongside the token in safeStorage. Token cold startup cannot establish token ownership, local mode has no email, and protocol must remain the source of truth. Rejected: a separate user-profile message, adding unnecessary messaging and timing when one handshake field suffices.
  Based on `proto/coflux/v1/client.proto:197-204`; `apps/server/src/hub.ts:3280-3344` (both clientAuth paths and authOk), `:3350-3372` (checkCredentials returns userId); `apps/server/src/store.ts:435-438` (userIdForClientToken), `:377-386` (getUserByEmail/claimUser; claimUser uses FOR UPDATE and requires a transaction; add an ordinary by-id reader because none exists); `apps/server/src/config.ts:110` (COFLUX_USERNAME defaults to admin); `apps/server/src/infra/database/schema-migrations.ts:176-181` (users only has id/email/password_hash/created_at).
- **Do not change the control-plane protocol version**: an optional field is nonbreaking. Keep `CONTROL_PROTOCOL_VERSION` and the server minimum unchanged, and require `buf breaking` to pass. Frozen web/mobile and iOS can ignore the field. Rejected: incrementing the version incidentally, which would send all online desktops to Update Required, precisely what plan 105 avoids. Based on `packages/protocol/src/index.ts:47` and `plans/105-desktop-protocol-admission.md`.
- **Regenerate and commit all three language outputs together**: run `buf generate` from `proto/`; commit TS (`packages/protocol/src/gen`), Rust (`crates/protocol/src/gen`), and Swift (`packages/swift-client/Sources/CofluxProtocol/Generated`). CI checks zero diff in all three. Rejected: editing generated files manually, which fails CI. Based on `proto/buf.gen.yaml` and `.github/workflows/ci.yml:109-118`.
- **Add identity to client state and persist it in the offline catalog**: add a string field to `CofluxState` (executor names it), write it on authOk with empty string for omission, and clear it on logout/authError. Include it in `OfflineCatalog`; restore during `hydrateOfflineCatalog`. `parseOfflineCatalog` accepts old caches without the field as empty string; **keep `OFFLINE_CATALOG_VERSION` at 1**. Rejected: memory-only storage, leaving offline cold startup (a first-class plan 103 scenario) blank. Rejected: bumping the cache version, needlessly invalidating every user's cache.
  Based on `packages/client/src/store.ts:181-215` (OfflineCatalog/parser), `:304-330` (persist only while controlAuthenticated), `:346-370` (hydrate), `:561-575` (authOk), `:577-590` (authError), `:816-835` (logout).
- **Place the fixed footer inside `<aside>` but outside the scrolling section**: drag strip → `flex-1` scroll region → footer. Do not mark the footer as draggable. Rejected: putting it at the end of the scrolling region, requiring scrolling past many projects. Based on `sidebar.tsx:225-232`.
- **Use existing Astryx menu components, with one menu instance for row and gear**: choose `DropdownMenu` (existing compound usage in `branch-menu.tsx:39-48`, Button trigger with visible content overridable through `children`) or `Popover` (children trigger must contain a button). **Do not hand-roll** positioning/outside-click behavior or use right-click `ContextMenu` as the sole entry. Style with Astryx tokenized Tailwind classes such as `bg-sidebar`, `text-muted-foreground`, and `hover:bg-accent`, with no raw hex/px. Based on `apps/desktop/.claude/CLAUDE.md` and `sidebar.tsx:3-4, 235-245`.
- **Map update state to presentation with a pure function and `node --test`**, following `resolveOutdatedPrompt`. Input: `DesktopUpdateState` plus current app version. Output: trailing button (`gear | install`) and Check for Updates menu item (copy, disabled state, `check | install` action). Fixed semantics, with wording adjustable: `idle` → Check for Updates, enabled/check; `checking` → Checking for Updates…, disabled; `available` → Downloading vX…, disabled; `downloading` → Downloading vX (n%)…, disabled; `downloaded` → Restart and Update vX, enabled/install, and trailing `install`; `not-available` → Up to Date (vCurrent), enabled/check; `error` → Update Check Failed, Retry, enabled/check (reason in title/secondary copy). **Only downloaded yields an install trailing button.** Rejected: scattered JSX switches, which are not unit-testable and diverge from `desktop-update.ts`.
  Based on `apps/desktop/src/renderer/components/workbench/desktop-update.ts:15-45`, `desktop-update.test.ts`, and `apps/desktop/src/shared/desktop-bridge.ts:10-20`.
- **Server Address… bridges to the existing main-process dialog**: add a parameterless fire-and-forget `DesktopBridge` method and a `shared/ipc.ts` channel. Preload implements it with `ipcRenderer.send`; `main/ipc.ts` registers it using the checkForUpdates trusted-sender pattern; `main/index.ts` connects it to `showServerInfo(serverUrl)`. Do not expose Node/fs/shell/settings-file paths. Rejected: a renderer-owned dialog, because settings.json's path and Open Settings File action belong to main. Rejected: also removing Check for Updates from the native menu, which is out of scope.
  Based on `apps/desktop/src/main/index.ts:69-86` (showServerInfo), `:178` (menu wiring); `apps/desktop/src/main/ipc.ts:47-53`; `apps/desktop/src/preload/index.ts:40-45`; `apps/desktop/src/shared/ipc.ts`; `apps/desktop/src/shared/desktop-bridge.ts:1-8` (types only).
- **Logout calls `client.logout()` directly without confirmation**: it already clears token/offline cache/state and sets need-login, causing Workbench to show login. Rejected: confirmation, because logout is reversible by logging in again; Cursor also does not confirm. Based on `packages/client/src/store.ts:816-835, 982`.
- **Extract a shared update-state subscription hook**: both `DesktopOutdated` and the footer need an initial `getUpdateState()`, `onUpdateState` subscription, and cleanup. Reuse one hook. Keep DesktopOutdated's mount-triggered check in that component; **the footer does not check on mount**. Rejected: duplicate subscriptions whose disposed guards diverge. Rejected: footer `checkForUpdates()` on mount, duplicating the 15-second startup timer and hitting the source on every login/logout.
  Based on `apps/desktop/src/renderer/components/workbench/workbench.tsx:129-165`; `apps/desktop/src/main/updater.ts:14-16, 67-68`.
- **The footer must remain fully visible with the disconnection banner** (decided while planning): the root `h-screen overflow-hidden` adds `pt-7` for the banner, while sidebar `<aside>` is also `h-screen`, clipping the bottom 28px. Existing `pb-3` blank space concealed this. Make sidebar height follow its parent (`h-full` / `min-h-0`, executor's choice); do not change the banner. Based on `workbench.tsx:589-593` (root), `:721-728` (banner), `sidebar.tsx:226`.
- **Do not bump desktop version or release**: `apps/desktop/package.json` version and tags belong to user-requested releases (`docs/RELEASING.md:203`). Based on `docs/RELEASING.md:199-212`.

## Direction

The four milestones form a dependency chain: M2 uses M1's generated types, M4 uses M2 state and M3 bridge methods, while M3 is independent of M1/M2. M3/M4 share `shared/desktop-bridge.ts`, so **execute as one work package without splitting**. Design against live code; these are outcome contracts.

### Milestone 1: Protocol/server—include identity in authOk

Add the optional AuthOk field; regenerate and commit all three language outputs. Server sets password email/local `config.username`, omitting it when unavailable, without changing authentication-failure or admission behavior. Add black-box assertions in `tests/src/password.test.mjs` that password login and token reconnect both return the user's normalized lowercase email.
Validation: `cd proto && buf lint && buf breaking --against "../.git#ref=c202a0d,subdir=proto"` → exit 0; after `cd proto && buf generate`, run `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` at repository root → empty output once outputs are committed; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0; `cargo test -p coflux-protocol` → exit 0.

### Milestone 2: Client store—identity in state and offline cache

CofluxState includes identity; authOk writes it and logout/authError clear it. Persist/restore through the offline cache while accepting older caches. `packages/client/src/store-offline.test.ts` covers identity restored on cold startup and missing identity in an old cache producing empty string without invalidating the cache.
Validation: `node --import tsx --test packages/client/src/*.test.ts` → exit 0 (baseline 66 tests; only add).

### Milestone 3: Desktop bridge—renderer can open Server Address…

New DesktopBridge method → preload → trusted-sender-validated IPC → existing main-process showServerInfo. Update capability lists in `apps/desktop/README.md` and the `shared/desktop-bridge.ts` header.
Validation: `pnpm -C apps/desktop typecheck` → exit 0; `pnpm -C apps/desktop test` → exit 0.

### Milestone 4: Sidebar footer—identity, account menu, and update button

Implement the product decisions in a new footer component (executor chooses name), tested pure presentation mapping, shared update-state hook also used by DesktopOutdated, and parent-relative sidebar height. In development, checkForUpdates immediately produces `error: 开发版不检查更新` (the existing literal means updates are not checked in development); display it through the mapping without adding updater branches.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0 (baseline 71 unit tests; only add).

## Landmines

- **Update state lives in main; fetch once on renderer mount**: `updater.ts:42-55` broadcasts only changes. A downloaded state reached during login will not be broadcast again. DesktopOutdated fills this gap with `getUpdateState()` (`workbench.tsx:133-139`); the footer must too.
- **Downloaded is a sticky terminal state** (`apps/desktop/src/main/update-state.ts:19-20`). Periodic checking/not-available/progress cannot demote it, keeping the Update button stable. Do not change that rule for rechecking.
- **Development checkForUpdates directly dispatches the existing error literal `开发版不检查更新`** (`updater.ts:57-60`). Failure copy after clicking in dev is expected; electron-updater emits no events for unpackaged apps.
- **Disconnection-banner clipping**: see the decision on `workbench.tsx:591-592` `pt-7` plus `sidebar.tsx:226` `h-screen`.
- **Identity lookup cannot create a rejection path**: every `reject()` branch in `hub.ts:3280-3344` closes the connection. A thrown error or empty identity lookup must only omit the field. `store.claimUser` (`store.ts:383`) uses FOR UPDATE and requires `transaction()`; do not use it for ordinary reads.
- **Automatic updates have never been observed on a real machine**: local `~/Applications/Coflux.app` is a July Safari web app (`com.apple.Safari.WebApp.*`). Electron has only run from unsigned `pnpm pack` output; neither `~/Library/Application Support/Coflux` nor `~/Library/Logs/Coflux` exists. Executor and verifier cannot locally produce a downloaded state. Validate footer logic with pure tests and pack smoke testing. The user must perform end-to-end acceptance: install signed desktop-v0.1.5, then observe the gear become Update after this plan merges and the next version releases.
- **Update-source caching/network prerequisites**: raw.githubusercontent.com `latest-mac.yml` is cached for several minutes (`docs/RELEASING.md:183`), and direct access from mainland China is unreliable. This is out of scope; a few minutes without a change is not automatically a bug.
- **Never change Origin `https://desktop.coflux.dev`** (`apps/desktop/src/main/origin.ts`, README Origin section); it is part of loopback-grant binding. This plan does not touch handshakes.
- **Black-box environment**: `pnpm -C tests test` requires PG on port 5432 in local Docker (OrbStack, `orb start`). On machines with coflux installed, agent-activity presence/hook tests produce false failures and may hang the full suite. Judge this plan with `cd tests && node --import tsx --test src/password.test.mjs`; investigate those three cases first if the full suite fails.
- **Run buf generate from proto/**: all buf.gen.yaml output paths are relative `../` paths. CI checks Swift output too; commit all three.
- **shared/desktop-bridge.ts contains only types; preload is sandbox CommonJS** (`desktop-bridge.ts:1-8`, `preload/index.ts:6-7`). Bridge implementations only use ipcRenderer.send/invoke.
- **Astryx component shapes**: DropdownMenu's trigger is a Button (`label` required, children override visible content); Popover children must contain `<button>` or `role="button"`; Tooltip wraps with display:contents (verified in plan 108). Avoid nested buttons when making the row a trigger, for accessibility and React warnings.
- **Fresh worktrees have no dependencies**: dev:execute-plan preflight runs `pnpm install --frozen-lockfile` at worktree root. Rust target is empty, so initial protocol tests compile for a while. In a worktree session, Bash guards block compound forms such as `git -C ..` and `$(git …)`; use separate commands from repository root.

## Scope

In scope:
- `proto/coflux/v1/client.proto`; generated `packages/protocol/src/gen/**`, `crates/protocol/src/gen/**`, `packages/swift-client/Sources/CofluxProtocol/Generated/**`
- `apps/server/src/hub.ts`, `apps/server/src/store.ts`
- `packages/client/src/store.ts`, `packages/client/src/index.ts` if exports are needed, `packages/client/src/store-offline.test.ts`
- `apps/desktop/src/shared/desktop-bridge.ts`, `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`, `workbench.tsx`, new footer/pure-function/hook files and `*.test.ts` beside them, named by the executor
- `apps/desktop/README.md`
- `tests/src/password.test.mjs`
- `plans/110-desktop-account-footer.md`, `plans/README.md`

Out of scope:
- `apps/desktop/src/main/updater.ts`, `update-state.ts`, `menu.ts`, `origin.ts`, `window.ts`: updater behavior, native menus, Origin, windows unchanged
- `apps/desktop/package.json` version, `electron-builder.yml`, `.github/workflows/desktop-release.yml`: release is the user's decision
- `packages/protocol/src/index.ts` CONTROL_PROTOCOL_VERSION, `apps/server/src/config.ts`: versions/config unchanged
- `apps/server/src/auth-pages.ts`, `oauth.ts`, page login flows: only WS authOk gains identity
- `apps/ios`, handwritten `packages/swift-client` source, daemon (`crates/` except generated output): ignore the field
- AuthShell login page, terminal main area, notifications/badges: unrelated

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint + breaking | `cd proto && buf lint && buf breaking --against "../.git#ref=c202a0d,subdir=proto"` | exit 0 |
| Generated output zero diff | `cd proto && buf generate`, then at repository root `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | Empty after outputs are committed |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client unit tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0; baseline 66, only add |
| Desktop types/tests/build | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0; unit-test baseline 71, only add |
| Rust generated code compiles | `cargo test -p coflux-protocol` | exit 0 |
| Git diff formatting | `git diff --check c202a0d HEAD` | exit 0 |
| Black-box password flow (acceptance) | `cd tests && node --import tsx --test src/password.test.mjs` (Docker PG 5432 required) | exit 0, including new email assertions |
| Full black-box suite (acceptance) | `pnpm -C tests test` | exit 0; three local presence false failures may be exempted as described above |
| Swift generated output (acceptance) | `swift test --package-path packages/swift-client --parallel` | exit 0 |
| Pack smoke test (acceptance) | `pnpm -C apps/desktop pack` | exit 0; `dist/mac-arm64/Coflux.app` launches |
| Real-machine walkthrough (manual acceptance) | User logs in: email/host visible; row/gear open menu; all three actions work; logout returns to login; footer is visible under disconnected banner; after installing a signed build and releasing the next version, observe Update and click into the new version | User confirms |

The repository has no lint script.

## Done criteria

- [ ] All listed commands pass.
- [ ] Optional AuthOk identity returns password email/local config.username or is omitted when unavailable; authentication-failure/admission unchanged; buf breaking passes; all three generated outputs committed and zero diff.
- [ ] Client state writes identity on authOk, clears on logout/authError, persists/restores it offline, accepts old caches, and keeps OFFLINE_CATALOG_VERSION at 1.
- [ ] Fixed footer shows avatar, identity (Signed In fallback), host, and trailing button; row/gear share one menu; actions call checkForUpdates, the new bridge method, and client.logout().
- [ ] Only downloaded shows the accent Update button and calls installUpdate(); other states show a gear; pure mapping has node --test coverage.
- [ ] Footer mounting does not call checkForUpdates; updater.ts/update-state.ts/menu.ts unchanged.
- [ ] Footer remains fully visible with the disconnection banner through parent-relative sidebar height.
- [ ] Trusted-sender-validated IPC reaches existing showServerInfo; no Node/fs/shell capabilities added; README and bridge header synchronized.
- [ ] Required tests exist and assert meaningful behavior (pure presentation mapping, offline store, black-box email assertions).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A cited fact no longer holds, especially AuthOk already containing identity, updater no longer using autoDownload/autoInstallOnAppQuit, missing showServerInfo, or OfflineCatalog version no longer 1.
- buf breaking rejects the new field; fix the field addition rather than forcing a protocol-version change.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- Future footer actions must use existing bridge/client capabilities; do not grow generic Node/fs/shell access.
- Future nickname/avatar support can add adjacent AuthOk fields. The renderer treats identity as display text; never use email as a primary key.
- Sticky downloaded state keeps the button visible until restart, intentionally encouraging updates. Adjust copy if necessary, not the state machine.
- Real-machine automatic-update verification remains missing. Merging/releasing this plan provides the first in-app update-ready observation; ask the user to record the outcome (memory `desktop-auto-update-unverified` awaits an update).
