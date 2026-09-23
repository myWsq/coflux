# Plan 20260923-add-device-dialog: Adding a device is split into Desktop and Headless, with an agent prompt and in-app authorization

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 6da899cc..HEAD -- apps/desktop/src/renderer/components/workbench apps/desktop/src/main/daemon-files.ts apps/desktop/src/shared apps/desktop/src/renderer/config.ts packages/client/src/store.ts apps/server/src/hub.ts apps/server/src/secrets.ts packages/cli/cofluxd.mjs .github/workflows/desktop-release.yml`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — session was on the main worktree; moved to `.claude/worktrees/20260923-add-device-dialog` on `dev/20260923-add-device-dialog`
- Planned at: `6da899cc`, 2026-09-23

## Requirement

The desktop 添加设备 dialog (`EnrollmentDialog`, `apps/desktop/src/renderer/components/workbench/dialogs.tsx:184-222`) is a static paragraph plus one line, `npm i -g cofluxd && cofluxd up`, then tells the user to open the printed link in a browser and sign in again with account and password. It is unattractive, and it ignores two facts that arrived with the desktop split:

- An Apple-silicon Mac does not need the CLI at all: installing Coflux.app and signing in enrolls the machine automatically (plan 113's bundled daemon + `DaemonOnboardingDialog`).
- The desktop client is already signed in and can redeem a device authorization token itself (`client.authorizeDevice`, `packages/client/src/store.ts:975`), so a second browser sign-in is unnecessary.

The user also wants the headless path to be "paste this prompt to your agent": the agent on the target machine does the install and hands back the authorization link.

### Product conclusions (confirmed by the user)

- **Consumer and trigger**: a signed-in desktop user who wants another machine in their account. Entry points are unchanged: sidebar 设备 `+`, 添加第一台设备, and the import wizard's 登记设备.
- **Form**: one dialog titled 添加设备 with a top segmented control `Desktop | Headless`. It opens on **Desktop** every time.
- **Desktop tab** (macOS only):
  - Primary 下载 Coflux button → the arm64 dmg of the running app's version, opened externally.
  - One line: after installing, sign in with the same account and the Mac joins automatically.
  - Requirement note: Apple silicon and macOS 26+; an Intel Mac uses Headless.
  - Only when **this** Mac is not yet enrolled: an extra row 这台 Mac 尚未接入 → 接入 that closes this dialog and opens the existing `DaemonOnboardingDialog`.
- **Headless tab** (Linux, Intel Mac, servers), in this order:
  1. Primary: 让 agent 帮你装 — the full prompt visible in a read-only code block with a copy action. The prompt instructs the agent to:
     - check for Node.js 20+; if missing, **stop and ask the user** how to install it;
     - install `cofluxd` and start it with `--server <this server's daemon URL>`;
     - obtain the authorization link (via `cofluxd status`) and give it to the user, asking them to paste it into Coflux's 添加设备 dialog;
     - after authorization, confirm the device reports as registered/online.
  2. Secondary, collapsed by default: 自己动手 — the manual command.
  3. Bottom: 授权链接 input + 授权 button. It accepts either the full link or the bare token and authorizes with the desktop's own session. Opening the link in a browser keeps working as before.
- **States**:
  - **Success**: while the dialog is open, *any* device that was not in the account when it opened appears (paste-authorize, another Mac signing in, browser authorization) → the dialog switches in place to 「✓ <device name> 已上线」 with a 完成 button.
  - **Paste failure**: red text under the input carrying the reason (malformed input, expired/invalid link, cap reached, timeout).
  - **In flight**: the 授权 button is disabled while a request is pending.
  - **Cancel**: closing the dialog has no side effects.
- **Non-goals**: a curl / no-Node installer, Windows, changes to the this-Mac onboarding dialog, changes to the server's browser authorization pages, changes to `cofluxd` output or behaviour, changes to the entry points.
- **Observable when done**: on a Linux machine, the prompt pasted into an agent yields a link; pasting it into the dialog shows 已上线 and the device appears in the sidebar — without any browser sign-in. On another Apple-silicon Mac, the dialog's download yields a working dmg, and signing in there flips the open dialog to success.

## Decisions & tradeoffs

- **Tabs are named `Desktop` and `Headless`, not by OS**: Desktop means "the Coflux.app route" and is macOS-only; Headless is everything that runs `cofluxd`. Rejected: `Mac | Linux` — an Intel Mac belongs to the headless route and an OS-named tab would misfile it. Based on: user's answer at the product gate; the only desktop artifact is `coflux-<version>-arm64.dmg` (`.github/workflows/desktop-release.yml:213`, v2.4.0 release assets).
- **Download URL is pinned to the running app's version**: exactly `https://github.com/myWsq/coflux/releases/download/v${desktop.version}/coflux-${desktop.version}-arm64.dmg`, opened with `window.open(url, "_blank", "noopener")` so the main process routes it to the system browser. Rejected: `releases/latest` — the repository's "latest" pointer has been hijacked before by release ordering and does not deep-link to an asset; rejected: a new IPC for external links — the codebase routes every external link through `window.open` (plan 109). The installed app then updates itself through the normal feed. Based on: `desktop.version` on the bridge (`apps/desktop/src/shared/desktop-bridge.ts:97`); release tag is always `v<product version>` (`scripts/product-version.mjs:19`); `apps/desktop/src/renderer/components/workbench/terminal-paper.tsx:377`.
- **The prompt always passes `--server`**, with the value derived from the desktop's own `SERVER_URL` by the existing `daemonServerUrl()` mapping (`/client` → `/daemon`). Rejected: omitting it for the default server — one code path, and an explicit default is harmless while a missing non-default silently enrolls the machine into the wrong server. The pure function moves to `apps/desktop/src/shared/` so the renderer can import it; the main process keeps importing it from there. Based on: `apps/desktop/src/main/daemon-files.ts:64`; `apps/desktop/src/renderer/config.ts:7`; renderer already imports `../shared/…` (`apps/desktop/src/renderer/desktop-bridge.ts:6`).
- **Paste input is parsed and validated locally before any request is sent**: if the trimmed input parses as a URL, the token is what the existing `authorizeTokenFromUrl()` returns (it already anchors on `/authorize/<token>`, strips a trailing slash/query/fragment and URL-decodes); otherwise the trimmed input itself. Either way it is accepted only if it matches the server's token shape `^cf_authz_[A-Za-z0-9_-]+$`. Malformed input shows an error and sends nothing, and the send path only accepts the validator's output type, so an unvalidated string cannot reach `authorizeDevice`. `authorizeTokenFromUrl` moves to `apps/desktop/src/shared/` alongside `daemonServerUrl` and is reused, never re-implemented; the shape check is a separate renderer-side layer and does **not** tighten `authorizeTokenFromUrl` itself (revised on plan audit). Rejected: send whatever was pasted and let the server judge — the server counts every miss against a **per-connection** budget of 10 (`COFLUX_AUTHORIZE_MAX_FAILURES`), and that budget is shared with this Mac's own automatic local authorization; exhausting it breaks local enrollment until reconnect. Based on: `apps/server/src/hub.ts:3665-3677`; token minted by `genToken("cf_authz")` → `cf_authz_<base64url>` (`apps/server/src/secrets.ts:4-5`, `hub.ts:2090`); link is `${publicUrl}/authorize/${token}` (`hub.ts:2112`).
- **Success is "a device id that was not present when the dialog opened"**, observed from the client store's `daemons` list; a successful `authorizeDevice` result also counts but still names the device by waiting for (or reading) its entry. Rejected: tracking only the paste result — it would miss the Desktop route and browser authorizations, which the user explicitly wants covered. This is reliable because every authorization mints a fresh `randomUUID()` device id, so a reconnecting old device never looks new. Based on: `apps/server/src/hub.ts:3721` (redeemPendingAuthorization); device list source `useStore(client.store, (state) => state.daemons)` (`workbench.tsx:252`).
- **The baseline is taken from live data only** (revised on plan audit): the baseline id set is captured when the dialog opens *and* the client `status === "connected"`; if the dialog opens while not connected, the baseline is the first `daemons` list seen after `status` becomes `connected`. Until a baseline exists, no device counts as new. Rejected: snapshot on open unconditionally — the dialog is reachable with `daemons = []` (添加第一台设备, `sidebar.tsx:419-426`; boot overlay lifts after 8s without a snapshot, `App.tsx`), and the first live snapshot replaces the whole list (`packages/client/src/store.ts:780`), which would flip the dialog to 「✓ <some old device> 已上线」. `snapshotRevision > 0` is not a live-data signal: offline-catalogue hydration also bumps it (`store.ts:434-443`). Based on: `workbench.tsx:247` (`status`).
- **This Mac enrolling while the dialog is open counts as a new device** — accepted, consistent with "any new device" in the product conclusions; the 接入 row closes this dialog anyway, so the common path never shows it (decided on plan audit).
- **The this-Mac row shows exactly when `daemonState != null && daemonState.bundled && daemonState.status === "not-installed"`** (revised on plan audit). Rejected: any non-`running` status — `stopped` / `pending-auth` mean installed-but-not-registered, and `DaemonOnboardingDialog` treats anything other than `not-installed` as already started (`daemon-onboarding.tsx:66`); rejected: ignoring `bundled` — the onboarding's 接入 button is disabled when not bundled (`daemon-onboarding.tsx:156`), so a dev build would get a row leading to a dead button.
- **The prompt is English and states three operational hazards explicitly** (third revised on plan audit):
  1. Before `npm i -g`, check that the global prefix (`npm config get prefix`) is writable by the current user; if not, stop and ask the user — common distro Node installs use a root-owned prefix, and the no-sudo rule would otherwise strand the agent at the very first step.
  2. `cofluxd up` prints the link within about a second and then blocks in the foreground for up to 11 minutes waiting for authorization; there is no `cofluxd start` and `--no-start` does not start the service. The prompt must tell the agent to run `up` with a timeout or in the background, treat its non-zero/timeout exit as expected, and then read the link from `cofluxd status`.
  3. On Linux a `systemctl --user` service stops at logout unless lingering is enabled — the agent asks the user before `loginctl enable-linger`.
  Throughout: never use sudo on its own; Node, the npm prefix and linger are all stop-and-ask. Rejected: changing `cofluxd` to not block or to handle linger — out of scope (non-goal). Based on: `packages/cli/cofluxd.mjs:452-476` (wait loop, `status` prints the link at `:548-549`); `:415-418` (systemd `--user`, no linger handling anywhere in `packages/cli`).
- **The dialog lives in its own file** under `apps/desktop/src/renderer/components/workbench/`, built from astryx `SegmentedControl`, `Collapsible` and `CodeBlock` inside the existing `Dialog`/`Layout` shell. Rejected: keep growing `dialogs.tsx`. Based on: astryx exports `./SegmentedControl`, `./Collapsible`, `./CodeBlock`; `Collapsible` usage at `apps/desktop/src/renderer/components/settings/executor-endpoint-dialog.tsx:195`.
- **Left to the executor**: exact Chinese copy and the English prompt wording (within the content above); layout, spacing and width; what happens if the dialog is closed mid-request (the request may complete; reopening must start clean); whether the pure helpers get unit tests beyond the token parser.

## Direction

The dialog becomes a small state machine — `Desktop` / `Headless` tab, plus a terminal `success` view — fed by three inputs the workbench already has: the client (for `authorizeDevice` and the `daemons` list), the local `DesktopDaemonState`, and a callback that opens the existing onboarding dialog. Pure logic (token extraction/validation, prompt text, download URL) sits in a React-free module next to the dialog so it can be unit-tested like `daemon-view.ts`. No protocol, server, daemon or CLI change.

### Milestone 1: Shared helpers

`daemonServerUrl` and `authorizeTokenFromUrl` live in `apps/desktop/src/shared/` with main-process callers and their existing tests still passing; a renderer-side pure module provides token validation (reusing `authorizeTokenFromUrl` for links, adding bare-token acceptance and the `cf_authz_` shape check), the agent prompt, the manual command, the download URL, and the new-device diff against a baseline. The validator has unit tests covering: full link, link with trailing slash/query, bare token, surrounding whitespace, and rejection of non-token input (a URL without `/authorize/`, a link whose token lacks the `cf_authz_` shape, free text). The baseline/diff logic has a unit test for "baseline not yet taken → nothing is new". Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0.

### Milestone 2: The dialog

The new dialog replaces `EnrollmentDialog` at its existing mount point (`workbench.tsx:942`), with every product conclusion above implemented, and the old component and its stale comment ("这台 Mac 自己走账号菜单…不放回这里", `dialogs.tsx:189-190`) removed. All three entry points still open it. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

Milestone 2 depends on milestone 1. Run as one sequential work package — do not fan out.

## Landmines

- `authorizeDevice` is single-flight per client and resolves immediately with 「上一次设备授权还在进行中」 if another call is pending — including the workbench's automatic local authorization (`packages/client/src/store.ts:975-986`, `workbench.tsx:340-355`). Surface that message; don't retry in a loop.
- A successful `ok:true` `deviceAuthorizeInfo` is a lookup echo, not a result; the client already ignores it. Do not add a second listener that treats it as success (`packages/client/src/store-device-authorize.test.ts:130-147`).
- The desktop test script only globs `src/main`, `src/renderer`, `src/renderer/components/{settings,workbench}` and `test/` (`apps/desktop/package.json:13`) — a test placed under `src/shared/` silently never runs. Keep `daemonServerUrl`'s and `authorizeTokenFromUrl`'s tests where the glob sees it.
- `authorizeTokenFromUrl` is also used by the local pending-auth path (`apps/desktop/src/main/daemon-files.ts:112`) and its tests accept tokens that are not `cf_authz_`-shaped (`daemon-files.test.ts:128-133`). Do not tighten it; put the shape check in the renderer layer.
- Removing `EnrollmentDialog` leaves `TerminalSquare`, `CodeBlock` and `Icon` imports in `dialogs.tsx` used by nothing else. `noUnusedLocals` is off (`tsconfig.base.json`), so typecheck will not flag them — remove them by hand.
- `daemons` includes offline devices from the offline catalogue; a device that goes offline and back online is not new. Compare ids, not online flags.
- The sidebar `+` uses a native `title` (`sidebar.tsx:413`), which violates `docs/design-guidelines.md`. Entry points are out of scope: leave it, don't fix it in passing. Any new icon-only control in the dialog uses `Tooltip`, never `title`.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/` — new dialog file, its pure helper module and test, removal of `EnrollmentDialog` from `dialogs.tsx`, wiring in `workbench.tsx`
- `apps/desktop/src/shared/` — `daemonServerUrl` and `authorizeTokenFromUrl` new home
- `apps/desktop/src/main/daemon-files.ts`, `daemon-manager.ts`, `daemon-files.test.ts` — only to follow the move of `daemonServerUrl` / `authorizeTokenFromUrl`
- `wiki/plans/` — status

Out of scope:
- `apps/server/**`, `packages/**`, `crates/**`, `packages/cli/**` — no protocol, auth page or CLI change (non-goal)
- `daemon-onboarding.tsx` — this-Mac onboarding is reused as is
- `sidebar.tsx`, `import-project-wizard.tsx` — entry points unchanged

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0, count above the baseline |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| UI walkthrough (acceptance) | `pnpm dev:desktop:prod` | done by the user by hand, not by Claude |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] The dialog has `Desktop | Headless`, opens on Desktop, and every state in the product conclusions exists (download, this-Mac row, prompt with copy, collapsed manual command, paste input with in-flight/error, in-place success, clean cancel).
- [ ] Malformed paste input produces an error and no request: the function that calls `authorizeDevice` only accepts the validator's output type, and the validator tests cover the rejections.
- [ ] Opening the dialog before the first live snapshot never shows 已上线 for a device that already existed (baseline rule under Decisions; covered by the baseline/diff unit test).
- [ ] The this-Mac row condition is exactly `bundled && status === "not-installed"`.
- [ ] The prompt contains `--server` with the value `daemonServerUrl(SERVER_URL)`, the Node stop-and-ask rule, the writable-npm-prefix stop-and-ask rule, the instruction to run `cofluxd up` with a timeout or in the background (non-zero/timeout exit expected) and then read the link from `cofluxd status`, the linger ask-first rule, and the no-sudo rule.
- [ ] The download URL matches the pinned format exactly.
- [ ] `EnrollmentDialog` and its stale comment are gone, along with the imports only it used; no out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. the token prefix, the failure budget, the dmg asset name).
- The outcome requires touching server, protocol, client package or CLI.
- A validation command fails twice after one reasonable fix.
- astryx lacks `SegmentedControl` / `Collapsible` / `CodeBlock` at the installed version.

## Maintenance notes

- If desktop ever ships a universal or x64 build, the pinned dmg name and the "Intel Mac → Headless" note both change.
- If the server's token prefix or link path changes, the local validator will reject valid links — keep it in step with `genToken("cf_authz")` and the `/authorize/` route.
- If `cofluxd` gains a non-blocking `up` or linger handling, simplify the prompt.
- A preview build made after `release:version` but before the tag is published links to a dmg that does not exist yet (404) — expected, not a bug.
