# Plan 113: Bundle the daemon with desktop—ship supervisor/worker/cofluxd, onboarding after login, and local daemon status and upgrade notices in the account menu

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 34078ff..HEAD -- apps/desktop .github/workflows/desktop-release.yml .github/workflows/release.yml packages/cli/cofluxd.mjs crates/supervisor/src/main.rs crates/supervisor/src/upgrade.rs crates/supervisor/src/manager.rs crates/supervisor/src/fda.rs crates/worker/src/creds.rs apps/server/src/auto-update.ts packages/client/src/store.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH (CI packaging/signing/notarization, starting system services from the main process, and new onboarding; AMFI silently killing launchd top-level binaries on macOS is a known pitfall)
- Depends on: plans/112-daemon-desktop-foundation.md (its Rust `cofluxd` binary, supervisor PATH prefix and `supervisor-version` file, and `@coflux/client` `authorizeDevice`)
- Category: feature
- Execution: subagent (host general-purpose subagent, `model: fable`; preflight recorded by dev:explore on 2026-09-11: continue automatically without further confirmation; pushing, PRs, merging main, and releases still require an explicit user request)
- Planned at: `34078ff`, 2026-09-11

## Requirement

Today, enrolling the local macOS machine requires installing Coflux.app and logging in → opening a terminal and running `npm i -g cofluxd` (requiring Node 20+) → `cofluxd up` (downloads supervisor/worker from GitHub Releases into `~/.coflux/bin`, writes a LaunchAgent, and prints an authorization link) → opening the link in a browser, logging in again, and confirming → manually dragging the binary to grant Full Disk Access using `cofluxd fda` → manually running `cofluxd update && cofluxd restart` for subsequent supervisor upgrades. Desktop's entire contribution is the npm command printed in the Add Device dialog (`apps/desktop/src/renderer/components/workbench/dialogs.tsx:227`). The user described this as “very cumbersome, with a high barrier to entry.”

After completion, Coflux.app is the local daemon installer and manager on macOS. It bundles `coflux-supervisor`, `coflux-worker`, and Rust `cofluxd`. After login, an unenrolled machine receives workbench onboarding: one click installs files, starts the service, authorizes through the app's existing login without a browser or terminal, and guides Full Disk Access. The account menu gains local daemon status and actions. A newer bundled supervisor only prompts for an update; it never restarts automatically. Files and LaunchAgent match npm `cofluxd` exactly, so either installer can manage the same installation. Machines installed through npm are recognized as enrolled and taken over directly.

Acceptance (manual user validation; Claude does not walk through the frontend): on a clean Mac without Node, drag the app from the dmg, log in, and bring the device online within two minutes through onboarding. Open a terminal and run claude; `cofluxd progress` inside it appears in the sidebar and plugin hooks work. An npm-enrolled machine does not enroll again after the app update, and its status is correct. An app update containing a newer supervisor only prompts and never restarts automatically.

### Product decisions (confirmed during exploration; do not ask again)

1. **Trigger and entry**: check the local machine after successful login. If unenrolled, show workbench onboarding with a Not Now action; otherwise remain silent. Reopen through Local Daemon in the account menu. Do not put this back in Add Device, which is for other machines and keeps the npm command.
2. **Onboarding flow**:
   ```
   [Introduction] Connect this Mac to coflux
                  A background service will stay running and start at login so you and agents can open terminals on this machine.
                  [Connect] [Not Now]
   [Progress]     ✓ Install components → ✓ Start service → ● Authorizing… (current account)
                  Failure: red error on the failed step + [Retry] [Not Now]
   [FDA]          Full Disk Access: system prompts may block terminal access to Desktop/Documents/Downloads. Grant access now.
                  [Open System Settings] (also reveal the supervisor binary in Finder)
                  [I Enabled It, Restart Service] [Skip]
   [Complete]     This Mac is online. [Get Started]
   ```
   Authorize inside the app using the current login, without opening a browser. Each progress step supports retry on failure; cancel returns to the workbench.
3. **Runtime UI**: add a Local Daemon row to the account menu (plan 110's footer menu), with one of six states: running, stopped, awaiting authorization, update pending restart, Full Disk Access denied, or unenrolled. Actions: restart, stop, remove enrollment, open Full Disk Access guidance, and enroll when unenrolled. Show a `~/.coflux/bin` path hint for users who want `cofluxd` in their own terminal; do not change shell configuration.
4. **Upgrades**: the center continues hot-upgrading workers. If the bundled supervisor is newer than the running one, show update pending restart, including “This will end N local terminals.” Replace binaries and restart only after the user clicks Restart. **Never restart automatically.**
5. **Non-goals**: Intel Mac or Linux (the app only ships arm64); porting status/doctor/logs management commands to Rust (management is in the UI); separately choosing a daemon server (follow the app address); deleting credentials/configuration on uninstall (`--purge` semantics are excluded); automatically granting FDA (macOS does not allow it).

## Decisions & tradeoffs

- **Disk layout and LaunchAgent exactly match npm cofluxd**: binaries go in `~/.coflux/bin/{coflux-supervisor,coflux-worker,cofluxd}`; the plist is `~/Library/LaunchAgents/com.coflux.daemon.plist`, equivalent to `plistXml` in `packages/cli/cofluxd.mjs:386-401` (Label, ProgramArguments pointing to `~/.coflux/bin/coflux-supervisor`, `COFLUX_HOME`, RunAtLoad, KeepAlive, and log paths). Write `~/.coflux/settings.json` using `applyConfig` semantics (`cofluxd.mjs:380-384`): `serverUrl` replaces `/client` with `/daemon` in the app's client address, and `deviceName` is the hostname; mode 0600. Respect `COFLUX_HOME` when set, as `cofluxd.mjs:34` does.
  Rejected: pointing launchd directly into `Coflux.app/Contents/Resources`. App updates replace the .app in place, and users may move or rename it, breaking the service and npm interoperability.
- **Ad-hoc re-sign all three copied binaries with `codesign --force -s - <path>`** (`/usr/bin/codesign` ships with macOS).
  Based on `cofluxd.mjs:138-150`: newly written binaries carry provenance; AMFI silently SIGKILLs a launchd top-level spawn with OS_REASON_CODESIGNING. Developer ID signed and notarized artifacts still failed in testing on 2026-07-25. Ad-hoc re-signing is the production solution. Rejected: assuming a copied binary from a notarized .app counts as a local artifact; this is unverified and fails silently.
- **Port enrollment/registration/running/FDA detection from `cofluxd.mjs:549-585` (`cmdStatus`)**: plist plus both binaries means enrolled, regardless of npm/app origin. `~/.coflux/credentials.json` means registered; otherwise read `~/.coflux/pending-auth.json` for awaiting authorization. Determine liveness with `launchctl print gui/<uid>/com.coflux.daemon`, following `serviceRunningInfo`. `~/.coflux/fda-status` contains granted/denied/unknown (`crates/supervisor/src/fda.rs:13-25`). The catalog identity for this machine is `daemonId` from `credentials.json` (`crates/worker/src/creds.rs:13-14`); use it to count running local terminals.
- **In-app authorization flow**: the main process watches `~/.coflux/pending-auth.json`, extracts the token from `url` (`<publicUrl>/authorize/<token>`), and includes it in daemon status sent to the renderer. The renderer calls plan 112's `@coflux/client` `authorizeDevice(token)`. A daemon disconnect clears the file and reconnect generates a new link (`crates/worker/src/main.rs:1420` comment); always use the file's current token and replace stale tokens.
  Rejected: main-process control-plane messages; the control WS and login state live in the renderer's client store.
  Rejected: opening `/authorize/<token>` in the system browser; the product requires no browser, and desktop login does not give the browser a cookie, requiring another login.
- **Bundled binary source (user decision, 2026-09-11)**: add a job to `.github/workflows/desktop-release.yml` parallel to build/sign/notarize. At the same SHA, run `cargo build --release --target aarch64-apple-darwin -p coflux-supervisor -p coflux-worker -p coflux-cli`, then transfer artifacts to the packaging job.
  **Set `COFLUX_RELEASE_VERSION` to a parseable prerelease SemVer**, such as `v0.0.0-desktop.<dot-separated desktop version>`, accepted by `ReleaseVersion::parse` in `crates/supervisor/src/upgrade.rs` (supports a `v` prefix and prerelease; see the test at line 779). **Do not leave the default `dev`**: parsing failure makes the bundled worker version the literal `builtin` (`crates/supervisor/src/main.rs:132-141`), excluding it from anti-rollback decisions.
  Accepted consequence (record in Maintenance notes): when the center sees workerVersion ≠ latest, auto-update immediately pushes the production worker (`apps/server/src/auto-update.ts:170`). The bundled worker is only a bootstrap version; the supervisor remains bundled. Bundled versions are below every production version, so npm-installed production supervisors do not receive a replacement prompt.
  Rejected: pinning a daemon release and downloading/verifying it in CI; the user chose building together because parallel builds add no time.
  Rejected: using `github.ref_name` (`desktop-v0.1.7`) directly; it is not parseable SemVer.
- **Read the bundled version from a sidecar rather than executing a binary**: CI and local pack write a `VERSION` file beside the three binaries and include it in `extraResources`. The main process compares it with `~/.coflux/supervisor-version` (written by 112, e.g. `v0.32.0`, `v0.0.0-desktop.0.1.7`, or `dev`). When both parse as SemVer and the bundled version is strictly newer, show update pending restart. An unparseable running version (`dev`) or missing file (pre-112 supervisor) counts as older and prompts. An unparseable bundled version never prompts (local dev builds).
  Rejected: running `coflux-supervisor --version` in main; the supervisor has no such argument (`main.rs` only reads environment variables).
- **electron-builder**: place all three binaries and `VERSION` in `Contents/Resources/<subdirectory>/` through `mac.extraResources`, **outside asar** (`enableEmbeddedAsarIntegrityValidation: true`, `apps/desktop/electron-builder.yml`). Explicitly list the three binaries in `mac.binaries` for Developer ID/hardened runtime signing and notarization. Add existence checks and `codesign --verify --strict` for each to the signature/notarization-ticket/Gatekeeper verification step (`desktop-release.yml:152-163`). Local `pnpm -C apps/desktop run pack` takes an explicit input pointing to the cargo artifact directory (environment variable or argument, named by the executor). Missing input or an incomplete directory **fails packaging**, never silently emits a package without the daemon. Extend the existing `extraResources` structural assertions in `apps/desktop/test/config.test.ts:41`.
- **Main-process boundary and module shape**: the renderer receives only a daemon status object and sends narrow verbs (enroll, authorize, restart, stop, remove, open FDA guidance, restart after enabling FDA, not now). Do not expose filesystem, shell, or arbitrary command capabilities (`apps/desktop/README.md` security baseline; types in `apps/desktop/src/shared/desktop-bridge.ts`). Implement management decisions, plist/settings generation, pending-auth parsing, version comparisons, and state derivation as **pure TypeScript modules without Electron dependencies, with node:test**, following `apps/desktop/src/main/settings.ts` and `update-state.ts`. Only thin adapters touch `launchctl`, `codesign`, `fs.watch`, or `shell.openExternal`. Reuse `ipc-trust.ts` / `ipc-sanitize.ts` for IPC payload/source validation. The user may change the desktop technology later; pure modules must remain portable unchanged.
- **Atomic replacement and upgrade**: replace the three `~/.coflux/bin` binaries by writing same-directory temporary files, re-signing, and renaming. Do this together with `launchctl unload/load` only when the user clicks Restart. **Do not pre-replace files at app startup.** Rejected: writing files and awaiting a natural restart; this creates a third state where files are new but processes are old, which the status row cannot clearly explain.
- **Remove enrollment means `cofluxd uninstall` without `--purge`** (`cofluxd.mjs:846` onward): unload, delete the plist and three binaries, and preserve credentials/configuration/logs in `~/.coflux`. Use the repository's existing confirmation dialog pattern.
- **FDA guidance**: open `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` and reveal `~/.coflux/bin/coflux-supervisor` in Finder (`cmdFda`, `cofluxd.mjs:826-845`). Authorize the supervisor binary itself: TCC follows the launchd service's responsible process, so one grant covers the tree. Existing processes require a restart. I Enabled It, Restart Service performs a restart; use the resulting `fda-status` as truth. Rejected: probing protected directories from the app, which tests app permissions rather than service permissions (`fda.rs:3-5`).
- **The executor chooses file watching or polling for refresh**, but pending-auth changes must reach onboarding within 2 seconds. Query `launchctl` before/after status actions and on a low-frequency timer, never every renderer frame.

## Direction

M1 (CI/packaging) and M2 (main-process modules) are **independent**, with nonoverlapping paths, and may run as parallel work packages. M3 (renderer) **depends on M2**'s bridge types and status object. M2 defines daemon status shape and verbs in `apps/desktop/src/shared/desktop-bridge.ts`; M3 only consumes that contract.

### Milestone 1: Bundle all three binaries in desktop releases and support local pack

Add a parallel same-SHA build job to `desktop-release.yml` and deliver its artifacts to packaging. Configure electron-builder to place all three binaries and `VERSION` in `Contents/Resources`, sign, notarize, and verify them. `run pack` requires an explicit local artifact directory and fails if missing. Cover configuration in `config.test.ts`.
Validation: `pnpm -C apps/desktop test` -> exit 0; `pnpm -C apps/desktop build` -> exit 0.
(Real packaging/signing/notarization can only be verified in CI and belongs to acceptance.)

### Milestone 2: Main-process daemon management and bridge

Pure modules: derive unenrolled/stopped/running/awaiting-authorization/update-pending-restart/FDA-denied states and combinations; generate plist/settings; parse pending-auth; compare versions; locate bundled artifacts. Adapters: write/re-sign/rename files, launchctl start/stop, FDA guidance, and file watching. Bridge: status pushes and narrow verbs, using existing IPC validation. All pure logic has node:test coverage.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0.

### Milestone 3: Renderer onboarding, account-menu status, and upgrade notice

After successful login, use status to decide whether onboarding appears. Implement four pages and failure/retry/not-now paths, call `authorizeDevice(token)` on the progress page, and add the account-menu Local Daemon row/actions. Update-pending-restart notices include the running local terminal count. Map status to copy/visible actions through tested pure functions, following plan 110's account-footer presentation mapping. Claude does not perform UI walkthroughs.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0.

## Landmines

- **Fuses**: `runAsNode: false` forbids `child_process.fork`; use `utilityProcess` for background tasks (`electron-builder.yml` comment). With `onlyLoadAppFromAsar` and asar integrity enabled, modifying asar after packaging crashes startup. Binaries must use `extraResources`.
- **`resetAdHocDarwinSignature: true` matters only for unsigned local pack** (`electron-builder.yml`). CI must Developer ID sign all three binaries. `mac.binaries` paths are relative to the packaged .app; consult electron-builder 26 documentation (pinned to 26; 27 changes configuration structure).
- **Two CI signing pitfalls**: import the certificate into a temporary keychain instead of `CSC_LINK`; `CSC_NAME` omits the `Developer ID Application:` prefix (`desktop-release.yml:106-150`). The `release-signing` environment's tag rules must allow `desktop-v*` (`docs/RELEASING.md`). The new parallel job needs no signing secrets; do not attach it to `release-signing` and make it wait for approval.
- Renderer build-id uses a short git SHA, requiring `fetch-depth: 0` (`desktop-release.yml:64-67`). The parallel job also checks out the tag's SHA.
- Running `cofluxd restart` in a coflux terminal kills itself between unload/load because the service disappears. The app main process is not a PTY child and is unaffected. During local smoke testing, do not manually `launchctl unload` from a coflux terminal.
- Unpackaged dev userData is `Coflux-dev` (`apps/desktop/src/main/index.ts:31-34`), but `~/.coflux` and the LaunchAgent are machine-wide. Dev takes over the same real daemon. Set `COFLUX_HOME` elsewhere or knowingly interact with that daemon.
- `pending-auth.json` and `credentials.json` are 0600 (`crates/worker/src/creds.rs:1, 19`) and readable by the same user. Never log their contents to `electron-log` (`~/Library/Logs/Coflux/main.log`); log events only.
- On npm-enrolled machines, including the user's, the first app with a bundled supervisor compares production `v0.32.x` against `v0.0.0-desktop.*` and **does not prompt**, because bundled is older. This is an accepted consequence, not a bug. Such machines need `cofluxd update && cofluxd restart` to receive 112's PATH prefix.
- Show onboarding after successful login. Offline cold startup (`offlineCatalog`, `apps/desktop/README.md`) has no authOk; show only account-menu status in that case.
- Keep `EnrollmentDialog` (`dialogs.tsx:208-244`) for other machines, adding only a note that this Mac can be connected from the account menu.

## Scope

In scope:
- `apps/desktop/**` (main-process modules/tests, preload/shared bridge types, renderer onboarding/account menu, `electron-builder.yml`, `package.json` scripts, `test/config.test.ts`, `README.md`)
- `.github/workflows/desktop-release.yml`
- `docs/RELEASING.md` (bundled daemon build/version-stamp documentation)
- `README.md`: mention Coflux.app for macOS in the user-side daemon installation section

Out of scope:
- `crates/**`, `packages/client/**`: delivered by 112; this plan only consumes them
- `packages/cli/**`, `integrations/claude-plugin/**`: no changes
- `.github/workflows/release.yml`, `manifest.json` structure: daemon releases stay unchanged
- `apps/server/**`, `proto/**`: no changes needed
- electron-updater behavior, including update-check frequency and `autoInstallOnAppQuit`

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Local packaging (acceptance) | `cargo build --release --target aarch64-apple-darwin -p coflux-supervisor -p coflux-worker -p coflux-cli`, then run `pnpm -C apps/desktop run pack` with the executor-defined artifact-directory input | `dist/mac-arm64/Coflux.app/Contents/Resources/<subdirectory>/` contains all three binaries and `VERSION`; `codesign -dv` succeeds |
| CI packaging (acceptance) | Create a `desktop-v*` tag to trigger `desktop-release.yml` | Parallel job passes, verification asserts all three signatures, notarization succeeds |
| Real-machine walkthrough (manual user acceptance) | Install dmg on clean Mac → login → onboarding → online → `cofluxd progress` in terminal | Requirement acceptance is satisfied |

## Done criteria

- [ ] All listed commands pass.
- [ ] Unenrolled local machines show onboarding after login; one click installs, starts, and authorizes without a browser or terminal. FDA guidance opens System Settings and reveals the binary. Not Now exits.
- [ ] The account-menu Local Daemon row supports all six states and corresponding actions; npm-installed machines are recognized without reenrollment.
- [ ] A newer bundled supervisor only prompts, including local terminal count. Only Restart replaces binaries and restarts; no automatic restart path exists.
- [ ] Plist/settings.json/binary paths exactly match npm installation; npm `cofluxd status` works on app-enrolled machines.
- [ ] Required tests exist and assert meaningful behavior (state derivation, version comparison, pending-auth parsing, plist generation, presentation mapping, release configuration).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds, especially missing 112 deliveries (`authorizeDevice`, `supervisor-version`, `crates/cli`) or an electron-builder major-version change.
- The outcome requires out-of-scope files, such as supervisor/server changes.
- A validation command fails twice after one reasonable fix.
- A named assumption is false, especially AMFI still killing an ad-hoc re-signed bundled binary started by launchd. This is the largest unverified assumption; stop and report rather than inventing another workaround.

## Maintenance notes

- The bundled worker is a bootstrap version. After enrollment the center immediately hot-upgrades it to the latest production version (`auto-update.ts:170`: push whenever version differs from latest). `~/.coflux/worker.active` pointing to a downloaded worker is normal. The bundled supervisor remains the running supervisor; changing it requires a new desktop release.
- `v0.0.0-desktop.<x.y.z>` is below every production `v*`, explaining why npm-installed production machines do not receive replacement prompts. Before allowing bundled supervisors to take over these machines, decide how version sequences align (e.g. use the daemon `v*` version only when that tag exists at the same SHA). Do not change only comparison logic.
- Desktop releases now implicitly require Rust builds. The parallel job uses `RUSTFLAGS=-D warnings`; daemon warnings fail desktop releases.
- Shipping Rust `cofluxd` through daemon releases and npm `cofluxd update`, so Linux/headless machines can also become npm-free, belongs to a later plan.
- Manual user acceptance: a clean Mac goes online within two minutes of onboarding; npm-enrolled machines show correct status after app updates; app updates with newer supervisors only prompt.
