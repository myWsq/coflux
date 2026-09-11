# Release process

Desktop, CLI, and runtime components share one product version. The runtime consists of `coflux-supervisor` (which owns terminals) and `coflux-worker` (which supports hot upgrades). Desktop hosts the runtime directly; on headless devices, `cofluxd` manages the system service, while `coflux` handles business operations.

A release builds runtime and desktop from one tag, signs and notarizes them, publishes a complete GitHub Release, advances the desktop update feed, and publishes npm packages at the same version. The Release includes `manifest.json`, which the server uses to dispatch worker upgrades and cofluxd uses to verify installation artifacts.

## One-time setup: signing keys

Daemon artifacts are signed with an ed25519 release private key. Workers retain both a raw-binary signature for rolling compatibility with older supervisors and a domain-separated release statement. Supervisors have their own statement domain. Both statements bind the version, Rust target, SHA-256, and artifact size; separate domains isolate components.

The supervisor verifies worker hot upgrades. The npm package's cofluxd uses the same public key to verify both supervisor and worker before installation. This separates release authority from the center/download source: without the private key, an attacker can neither replace artifacts nor relabel valid artifacts as another component, version, or architecture. This is not a sandbox for the central control plane, which already has exec/session orchestration capabilities.

```sh
node scripts/gen-keypair.mjs
```

The command prints two values:

1. **Private key (PKCS8 PEM)**: store it as `WORKER_SIGNING_KEY` in the `release-signing` environment secrets. **Never commit the private key.**
2. **Public key (hex)**: replace both `crates/supervisor/release-pubkey.hex` and `packages/cli/release-pubkey.hex`. Public keys are not secret and belong in the repository; CI checks that both copies match.

> Until replaced with a real key, `release-pubkey.hex` contains only zeros, an invalid point: the supervisor **rejects all downloaded upgrades by default**. The supervisor also accepts a `COFLUX_WORKER_PUBKEY` environment override for tests and deployments with their own keys.

After committing the public-key change, newly built supervisors and newly published cofluxd packages embed your release public key.

## One-time setup: macOS signing and notarization

Native/cross-compiled Cargo artifacts carry only ad-hoc signatures, without a Team ID or notarization. Starting with macOS Sequoia, newly downloaded top-level executables launched directly by launchd—including the supervisor replaced by `cofluxd update`—can receive a silent SIGKILL with `OS_REASON_CODESIGNING`. Inspect `last exit reason` in `launchctl print gui/$(id -u)/com.coflux.daemon` (observed on 2026-07-20).

A real Developer ID signature and Apple notarization establish the release artifact's system identity. cofluxd still verifies ed25519 authenticity first, then applies local ad-hoc signing where required by observed platform behavior; users need no manual intervention.

A paid Apple Developer Program account is required. Create once:

1. A **Developer ID Application certificate**, rather than Apple Development / Apple Distribution certificates used for development/App Store distribution. Generate it in Xcode or the Apple Developer portal and export a password-protected `.p12`.
2. An **App Store Connect API key** for noninteractive `notarytool` authentication; Developer privileges suffice. Generate it under App Store Connect → Users and Access → Integrations, download the `.p8`, and record Key ID and Issuer ID.

Configure six `release-signing` environment secrets:

| Secret | Value |
| --- | --- |
| `MACOS_CERT_P12` | Base64 of the `.p12`: `base64 -i cert.p12`, without adding extra newlines |
| `MACOS_CERT_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_TEAM_ID` | Team ID; this project uses `8Y2J55823C` |
| `NOTARY_API_KEY_P8` | Full `.p8` contents, including `-----BEGIN/END PRIVATE KEY-----` delimiters |
| `NOTARY_KEY_ID` | API Key ID |
| `NOTARY_ISSUER_ID` | Issuer ID |

The signing identity is hardcoded in `release.yml` and is not secret: `Developer ID Application: Shuaiqi Wang (8Y2J55823C)`.

> **Standalone binaries do not support stapling**; only .app/.pkg/.dmg bundles do. Sign and submit them for notarization without stapling. Gatekeeper checks Apple's online notarization record on first execution, acceptable because the daemon already requires a server connection. On fully offline machines, initial notarization checks may fail or slow down; this is an inherent limitation of notarizing standalone binaries.
>
> `KEYCHAIN_PASSWORD` need not be stored as a secret. Each CI run generates it with `openssl rand`; it lasts only for that runner's lifetime.
>
> Developer ID certificates normally expire after five years. Generate a new `.p12` and update `MACOS_CERT_P12` / `MACOS_CERT_PASSWORD` before expiration.

## One-time setup: GitHub/npm release protection (required)

These are external GitHub/npm settings and cannot be created by repository YAML alone. Workflow tag/SHA and main-tip checks prevent mistakes; they are **not authorization boundaries**. Actual release authorization combines rulesets, protected environments, and npm Trusted Publisher. Complete these before going live:

- [ ] Create two GitHub tag rulesets for `v*`: one restricts **creation**, with release maintainers allowed to bypass; the other restricts **updates/deletion**, with release maintainers excluded from bypass and only a minimal, regularly audited emergency administrator group allowed. Bypass applies to an entire ruleset, so one ruleset cannot express both permissions.
- [x] Create protected environments `release-signing` and `npm-publish` with minimal deployment branch/tag rules. `release-signing` allows only `v*`; `npm-publish` must account for downstream `workflow_run` using ref `main` and allow only that source. **No required reviewers** (decision on 2026-09-05): with one maintainer, manual approval adds only a browser click per release. Signing remains conditional on an authorized maintainer pushing a `v*` tag, enforced by tag rulesets.
- [ ] Move `WORKER_SIGNING_KEY`, `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_TEAM_ID`, `NOTARY_API_KEY_P8`, `NOTARY_KEY_ID`, and `NOTARY_ISSUER_ID` from repository secrets into `release-signing` environment secrets.
- [ ] Configure npm's `cofluxd` Trusted Publisher for this repository, `.github/workflows/npm-publish.yml`, and environment `npm-publish`. The environment name must exactly match the workflow job's `environment`.
- [ ] Revoke legacy/automation/granular npm publish tokens, remove `NPM_TOKEN`-style GitHub secrets and `.npmrc` `_authToken` entries, and retain only GitHub OIDC Trusted Publishing for automated releases.
- [ ] If Immutable Releases is available, enable it and restrict write/admin roles that manage Releases. This prevents later asset replacement as defense in depth; it does not replace client-side ed25519 verification.

> **Preserve the migration order.** Secret-bearing workflow jobs already reference these environments, but YAML cannot create reviewer/ref policy. First create and protect environments in the service settings, then copy secrets and verify release/OIDC behavior, and only then delete repository secrets and old tokens. Do not push release tags or manually republish npm until environments are properly configured. An environment's name alone does not prove reviewer/ref policy is effective.

## Publishing a version

Pre-release checklist:

1. Work locally on `main` with `HEAD == origin/main`. Release metadata performs the same hard check after a fresh fetch. This prevents accidentally tagging an old/divergent commit; it does not replace the `v*` rulesets.
2. **Main CI must be green.** `ci.yml` is the quality gate; black-box tests rely on its Postgres service.
3. Run `pnpm release:version X.Y.Z` to synchronize root, desktop, and CLI versions, then commit and merge into main. `pnpm release:check vX.Y.Z` verifies consistency. Root `package.json.version` is the sole product-version source. npm publication remains automatic after the complete release succeeds. There is no separate manual publication entry point: retry the same npm workflow after failure rather than independently bumping the CLI.
4. Ensure no `release` / `npm-publish` workflow is running or pending. Push one tag at a time, waiting for both GitHub Release and downstream npm workflows to finish before releasing the next version.

```sh
git fetch --prune origin
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
pnpm release:check v1.2.3
git tag v1.2.3
git push origin refs/tags/v1.2.3
```

**Do not** use `git push --tags`, push multiple tags in one command, or push the next release tag before the previous release finishes. GitHub concurrency here permits one running and one pending run. A third burst replaces the previous pending run: latest-pending-wins, not FIFO. Superseded intermediate versions are not automatically published later.

A `v*` tag triggers `.github/workflows/release.yml`:

1. **Build matrix**: cross-compile supervisor and worker for `x86_64`/`aarch64` linux-musl (static, using `cross`) and native macOS `aarch64`/`x86_64`. Linux builds also produce the standalone `coflux-relay` for server nodes (plan 043); macOS builds do not.
2. **Sign and generate manifests** with `scripts/release-sign.mjs` and `WORKER_SIGNING_KEY`. The signing job has only `contents:read`, separate from the final GitHub Release job with `contents:write`. Each `coflux-worker-<target>` receives a legacy raw-binary signature and worker release-statement signature; each `coflux-supervisor-<target>` receives a supervisor release-statement signature. The exact worker transcript is `"coflux-worker-release-v1\0" || BE32(len(version)) || version || BE32(len(target)) || target || sha256(raw 32B) || size(BE64)`. The supervisor substitutes domain `"coflux-supervisor-release-v1\0"`; other fields are identical. `version` and `target` use UTF-8. URLs are replaceable download locations, not release identity, and are unsigned. Relay artifacts are unsigned because deployment is manual over SSH rather than automatic download/verification; they appear in `SHA256SUMS` for deployment checks.
3. **Generate English release notes** with `scripts/release-notes.mjs`. Before release, write and commit `docs/releases/X.Y.Z.md`, beginning with `# Coflux X.Y.Z` and explaining user benefits, installation, and upgrade implications. CI checks the matching version file, English text, and unfinished placeholders. Publication reads the file from the exact tag and appends a compare link; commit messages are no longer copied into the public changelog.
4. **Build desktop** through `desktop-release.yml`, signing, notarizing, and checking artifacts at the same SHA.
5. **Publish one unified Release**, only after runtime and desktop both succeed, containing:
   - Desktop dmg/zip/blockmap and `latest-mac.yml`.
   - `coflux-worker-<target>` raw binaries plus `.sig` (legacy raw) and `.release.sig` (release statement).
   - `coflux-supervisor-<target>` plus `.release.sig`, verified by cofluxd before installation.
   - `coflux-relay-<linux-target>` for standalone relay-node deployment; see [deployment.md](deployment.md).
   - `coflux-<tag>-<target>.tar.gz` with supervisor and worker for manual installation.
   - Schema 2 `manifest.json`: top-level `version`; per-target `worker` / `supervisor` entries with `url`, `target`, `sha256`, `size`, and `releaseSignature`; workers also include legacy `signature`. Also `SHA256SUMS`.

> **P2 / TODO: npm old-run idempotency versus fail-closed behavior.** `npm-publish-guard.mjs` strictly validates registry `dist-tags.latest` and its corresponding version entries before checking whether the requested version already exists. If latest is missing/corrupt, an old run fails even when its exact version exists, rather than skipping idempotently. This is intentional fail-closed behavior: the guard lacks reliable context proving it is only an old-release replay. Moving the exact-existing check ahead of latest validation could silently accept a new CLI release when registry state is invalid. Diagnose/repair npm latest manually first; relax this only after adding verifiable rerun context and corresponding negative tests.

`ci.yml` gates pushes/PRs to main: type checks and desktop build, Rust tests/build with `-D warnings`, the full real-process black-box suite, and Swift/iOS build checks.

## Electron desktop releases

`vX.Y.Z` is the only release tag; desktop, CLI, and runtime share the version and commit. `desktop-release.yml` accepts only `workflow_call`, handling build, Developer ID signing, notarization, stapling, and `codesign`/`stapler`/`spctl` verification, then uploading artifacts for the parent `release.yml` to publish.

Advance `desktop-updates` only after the complete GitHub Release succeeds; npm follows through Trusted Publishing. These systems do not form an atomic transaction: retry the failed step, and never infer npm publication solely from GitHub Release success. Prereleases do not update the stable desktop feed or npm latest. The feed rejects version regression and content changes for an existing version.

### Bundled daemon (plan 113): desktop releases include Rust builds

The app bundles `coflux-supervisor`, `coflux-worker`, and Rust `coflux` under `Contents/Resources/daemon/`, preparing the local device automatically after login. Users no longer need Node or npm cofluxd. The reusable workflow runs its `daemon` job before packaging/signing, building from the same SHA:

`cargo build --release --target aarch64-apple-darwin -p coflux-supervisor -p coflux-worker -p coflux-cli`

It uses `RUSTFLAGS=-D warnings` without `release-signing` or secrets. Artifacts pass to the packaging job; `scripts/stage-daemon.mjs` installs them under `build/daemon/` and restores mode 0755, since artifact transfer does not retain executable bits. electron-builder's `mac.binaries` applies Developer ID signing and hardened runtime to all three and includes them in notarization. Verification checks existence, `codesign --verify --strict`, and `Authority=Developer ID Application` for each.

- **Version stamp**: `COFLUX_RELEASE_VERSION=vX.Y.Z`, exactly matching the product tag, also written to the `VERSION` sidecar. The bundled worker no longer uses a lower bootstrap version. Unified versions do not force an immediate restart of a supervisor holding terminals.
- **Updates**: the main app launches runtime components with their original signatures; copying no longer triggers ad-hoc resigning. Components live in stable content-addressed directories. Normal app updates reconnect to the live instance and replace the CLI separately. Runtime updates require user-confirmed restart after tasks finish, without launchctl.
- **Acceptance**: the production signed app must establish that only Coflux needs Full Disk Access, live shell PIDs/memory variables survive updates, and protected directories remain accessible afterward. Development signatures and socket black-box tests do not substitute. Isolate acceptance instances with `COFLUX_DESKTOP_USER_DATA` and `COFLUX_HOME`.
- Local `pnpm -C apps/desktop run pack` requires `COFLUX_DESKTOP_DAEMON_DIR` pointing to local Cargo artifacts; see apps/desktop/README.md. Missing input or any missing binary fails immediately.
- macOS users should now onboard through Coflux.app. `npm i -g cofluxd` remains the Linux/other-machine path. Migrating old services requires an app prompt; startup must not silently terminate existing sessions.

### One-time setup

1. **Reuse the six signing/notarization `release-signing` environment secrets** above. electron-builder reads the certificate from `CSC_LINK` / `CSC_KEY_PASSWORD` and notarization credentials from `APPLE_API_KEY` (path to a temporary `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`.
2. The `release-signing` environment and tag rulesets allow only unified `v*` tags.
3. **GitHub is the update source**, decided during wrap-up on 2026-09-11, replacing the initial R2 design without new secrets. Installers and blockmaps live in GitHub Releases. The release job rewrites `latest-mac.yml` with absolute Release download URLs and pushes it to the repository's `desktop-updates` branch. electron-updater uses the generic provider at `https://raw.githubusercontent.com/myWsq/coflux/desktop-updates/latest-mac.yml`, hardcoded in `apps/desktop/electron-builder.yml`. Keep the fixed generic feed; the unified Release contains all desktop/runtime artifacts. The release job uses `GITHUB_TOKEN` to create Releases and push the branch. `desktop-updates` contains only this file; do not edit it manually. raw.githubusercontent.com caching may delay update visibility by a few minutes.

Missing any signing/notarization secret causes an **explicit workflow failure**, never a silent skip.

### Admission uses the control-plane protocol version, independently of production deployment (plan 105)

Desktop login reports `client_kind=desktop` and `control_protocol_version`, using `CONTROL_PROTOCOL_VERSION` from `packages/protocol`. The center rejects only versions below `COFLUX_MIN_CONTROL_PROTOCOL_VERSION` (default 1). Build IDs identify builds but do not govern desktop admission. Frozen online web/mobile clients retain exact build-ID admission, with `COFLUX_BUILD_ID_FILE` pointing to the frozen dist; see deployment.md's web-freeze section. Desktop distribution has release delays; the initial same-SHA desktop/production lockstep model proved unusable on launch day.

- Routine production deployments **do not** disconnect older desktop versions. electron-updater checks after 15 seconds at startup and every four hours.
- For breaking protocol changes, increment `CONTROL_PROTOCOL_VERSION` and raise the server minimum default accordingly (an environment override can serve emergencies). **Release desktop first, then deploy production.** Older desktop versions show Update Required and trigger automatic updates. CI's `buf breaking` gates compatibility; changes it accepts need no protocol-version increment.
- Update Required appears **only** for an outdated protocol, not a disconnection. The app neither reconnects nor reloads; it remains there until a new version is installed.

### Installing desktop updates

There is no separate desktop release entry point; use the unified version process above. Routine releases need no coordination with production deployment, but breaking protocols require releasing the client first.

The app checks after 15 seconds at startup, every four hours, and immediately upon admission failure. Available updates download automatically. Installation occurs only when the user explicitly selects Restart and Update, reconnecting to the live runtime. Ordinary quit does not install updates; it ends local terminals according to quit confirmation. Check for Updates in the menu triggers a manual check. Restarting the runtime itself may end terminals, requires separate confirmation, and can be deferred.

Local smoke testing: `pnpm -C apps/desktop run pack` produces unsigned `apps/desktop/dist/mac-arm64/Coflux.app` with fuses set and ad-hoc signing. Notifications/badges are reliable only in signed artifacts; Electron 42+ uses UNUserNotification on macOS. Failures in unsigned packages are not regressions.

## How upgrades are applied

1. The server polls GitHub `/releases/latest`, which excludes prereleases/drafts, and the release's schema 2 `manifest.json`. It caches only when the release tag, top-level manifest version, and every target entry's shape agree.
2. Each online daemon is compared immediately at handshake when reporting `workerVersion` / `platform` / `arch`; a new release triggers another scan of all online daemons. The server still pushes on version inequality, sending `worker.upgrade{version,url,target,sha256,artifactSize,signature,releaseSignature}`. Each supervisor's persistent local state enforces actual version monotonicity.
3. New supervisors require canonical strict SemVer with a `v` prefix and a matching local Rust target. Before any network request, they reject versions below or equal to the committed floor. They then download with bounds and check signed size, SHA-256, the legacy raw signature, and release-statement signature. Only after every check passes is the artifact atomically installed under `~/.coflux/workers/<version>/`. Any failure preserves the current worker.
4. A candidate becomes healthy during observation only after taking over UDS, reconnecting to the center, and completing resync. Commit first atomically persists `worker.active`, then `worker.release-floor`. Floor-write failure prevents declaring commit and disables further remote upgrades for that process. A crash between the two writes is recovered by reconstructing/persisting the floor from the safely recovered active SemVer.
5. `worker.release-floor` is the monotonic high-water mark of committed remote releases. It advances only after observation commits, never merely after download, verification, disk installation, or a failed pending candidate. SemVer build metadata does not affect precedence, so another build string at the same precedence is replay. Candidate failure still permits internal rollback to the old active version: the floor constrains subsequent **remote requests**, not safe rollback or local administrator switching.
6. Worker version switches leave PTY sessions in the supervisor untouched. After failure, the worker reconnects and reports the old version. The server counts attempts per `(daemonId, version)` and permanently stops pushing that version for its current lifetime after `COFLUX_AUTOUPDATE_MAX_ATTEMPTS`, preventing an endless rollback/retry/failure loop. See `tests/src/auto-update.test.mjs`.

Without `COFLUX_AUTOUPDATE_REPO`, automatic updates are disabled. Manual `clientUpgradeDaemon` remains available for staged/emergency use, but remote URLs sent to new supervisors require all new fields. Only switching to a known local version with empty `url` bypasses the remote trust chain. The manifest retains legacy raw signatures for rolling compatibility; older workers/supervisors may ignore new protobuf/UDS fields. Conversely, new supervisors fail closed on remote requests carrying only raw signatures.

Configuration in `apps/server/src/config.ts`: `COFLUX_AUTOUPDATE_API_BASE` defaults to `https://api.github.com`; `COFLUX_AUTOUPDATE_REPO` is `owner/repo`; `COFLUX_AUTOUPDATE_POLL_MS` defaults to 10 minutes; `COFLUX_AUTOUPDATE_MAX_ATTEMPTS` defaults to 3. Supervisor versions are visible in web device tooltips but are **not** automatically upgraded.

## Central-host prerequisite: synchronized clocks

The **center** computes online-lease `expiresAt` as `now + config.localLeaseTtlMs`, default 45 seconds. The **daemon** validates it in `crates/worker/src/local_auth.rs`, `validate_lease`, without skew tolerance. If the center trails the daemon by more than 45 seconds, every lease arrives expired. The daemon logs the literal diagnostic `local lease 安装被拒: lease 已过期`, and direct-path RPC/lifecycle scopes fail. Offline grants still cover session read/control, so `cofluxd doctor` can remain green and cannot rule out this fault.

Observed on prod-jp on 2026-07-25: `timedatectl` showed `System clock synchronized: no` and NTP service `n/a`; system time lagged RTC/real time by 78 seconds. Fix:

```sh
apt-get install -y systemd-timesyncd && timedatectl set-ntp true
timedatectl   # Confirm System clock synchronized: yes
```

Check this before bringing a new central host online.

## First cofluxd installation and supervisor upgrades

The supervisor cannot hot-upgrade because it owns PTYs. Use `cofluxd update` to download supervisor and bundled worker, then `cofluxd restart` after tasks finish; this should be rare. The npm package embeds the same ed25519 public key as the supervisor. Remote installation first requires the exact SemVer tag's schema 2 manifest, strict version/target/size/SHA-256 matching, and separate worker/supervisor release-statement verification; workers additionally require the legacy raw signature. Only after both files pass can one staging generation replace them. macOS local ad-hoc signing occurs only after verification. Old releases lacking supervisor entries fail closed without falling back to raw downloads.

`--bin-dir` remains an explicit local administrator choice for development/recovery, outside the remote trust chain. This remote installation chain applies from `cofluxd@0.12.0`; 0.11.x and earlier must upgrade the CLI first.

A newly started supervisor takes the greater of its bundled worker's strict SemVer and existing `worker.release-floor` as the initial remote rollback-prevention floor. Both embedded public keys must match; CI rejects drift. **Do not rotate the trust root directly**: old cofluxd/supervisors cannot accept releases signed only with a new key. First design and publish an old-key-authenticated dual-trust/handover release, then switch signing keys. Editing the two hex files alone is insufficient.

> **After release, remember:** hot upgrades cover only workers. If a release includes supervisor fixes (check `git diff <previous-tag>..HEAD -- crates/supervisor`), run `cofluxd update` on each daemon machine; otherwise those fixes never reach production supervisors.
