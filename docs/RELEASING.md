# Release process

Desktop, CLI, and daemon components share one product version. A device runs `coflux-ptyd` (owns terminals), `coflux-launcher` (version pointer, probation, rollback) and `coflux-runtime` (sessiond + centre connection, paired with the Go `coflux-transport` companion). Runtime/helper pairs are pushed by the centre and observed by the launcher (plan 20261002-runtime-launcher-merge). The companion is required and bundled for all targets. Tailcat is the default remote networking stack; custom relay and WebRTC are retired. Desktop hosts the runtime directly; on headless devices, `cofluxd` manages the system service (launchd, systemd user units, or a self-managed service on Linux without systemd; `cofluxd run` is the foreground entry point for containers), while `coflux` handles business operations.

A release builds runtime and desktop from one tag, signs and notarizes them, mirrors a stable release to the R2 download mirror at `dl.coflux.dev`, publishes a complete GitHub Release, advances the desktop update feeds and the mirror's pointers, and publishes npm packages at the same version. The Release includes a schema 3 `manifest.json`, which the server uses to dispatch runtime upgrades and cofluxd uses to verify installation artifacts. See [R2 download mirror](#r2-download-mirror-dlcofluxdev) for what is downloaded from where.

## One-time setup: signing keys

Daemon artifacts are signed with an ed25519 release private key: one domain-separated release statement per component (`runtime`, `launcher`, `cli`, `transport`, `ptyd`). No component carries a raw-binary signature any more — that was the back door a pre-plan supervisor still checks, and no such supervisor may ever verify, install or run a runtime artifact. All statements bind the version, Rust target, SHA-256, and artifact size; separate domains isolate components.

The runtime verifies pushed runtime releases before it asks the launcher to switch. The npm package's cofluxd uses the same public key to verify launcher, runtime, native CLI, transport helper and ptyd before installation. This separates release authority from the center/download source: without the private key, an attacker can neither replace artifacts nor relabel valid artifacts as another component, version, or architecture. This is not a sandbox for the central control plane, which already has exec/session orchestration capabilities.

```sh
node scripts/gen-keypair.mjs
```

The command prints two values:

1. **Private key (PKCS8 PEM)**: store it as `WORKER_SIGNING_KEY` in the `release-signing` environment secrets. **Never commit the private key.**
2. **Public key (hex)**: replace both `crates/runtime/release-pubkey.hex` and `packages/cli/release-pubkey.hex`. Public keys are not secret and belong in the repository; CI checks that both copies match.

> Until replaced with a real key, `release-pubkey.hex` contains only zeros, an invalid point: the runtime **rejects all downloaded upgrades by default**. The runtime also accepts a `COFLUX_WORKER_PUBKEY` environment override for tests and deployments with their own keys.

After committing the public-key change, newly built runtimes and newly published cofluxd packages embed your release public key.

## One-time setup: macOS signing and notarization

Native/cross-compiled Cargo artifacts carry only ad-hoc signatures, without a Team ID or notarization. Starting with macOS Sequoia, newly downloaded top-level executables launched directly by launchd—including the launcher replaced by `cofluxd update`—can receive a silent SIGKILL with `OS_REASON_CODESIGNING`. Inspect `last exit reason` in `launchctl print gui/$(id -u)/com.coflux.daemon` (observed on 2026-07-20).

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
4. Commit `docs/releases/X.Y.Z.md` together with the version bump, and add it to the [release notes index](releases/README.md). CI reads the notes file named after the current product version, so a missing file fails main.
5. Ensure no `release` / `npm-publish` workflow is running or pending. Push one tag at a time, waiting for both GitHub Release and downstream npm workflows to finish before releasing the next version.
6. **Keep main still until npm publication finishes.** The npm gate runs `ci.yml` **from the default branch** against the **release commit**, so a change merged into main between the tag and the gate is applied to an older tree. A `ci.yml` step calling a script that the release commit does not contain fails the gate and skips publication. Merge substantial pull requests after the release completes.

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

1. **Build matrix**: cross-compile launcher, runtime, ptyd, and the native CLI for `x86_64`/`aarch64` linux-musl (static, using `cross`) and native macOS `aarch64`/`x86_64`. Build the CGO-free transport companion for all four targets with pinned Go 1.27.1. Stock DERP is operated separately and is not a product release artifact.
2. **Sign and generate manifests** with `scripts/release-sign.mjs` and `WORKER_SIGNING_KEY`. The signing job has only `contents:read`, separate from the final GitHub Release job with `contents:write`. Each `coflux-<component>-<target>` receives its component's release-statement signature and nothing else. The exact runtime transcript is `"coflux-runtime-release-v1\0" || BE32(len(version)) || version || BE32(len(target)) || target || sha256(raw 32B) || size(BE64)`. The launcher substitutes domain `"coflux-launcher-release-v1\0"`, the native CLI `"coflux-cli-release-v1\0"`, the companion `"coflux-transport-release-v1\0"` and ptyd `"coflux-ptyd-release-v1\0"`; other fields are identical. The script refuses to emit a `worker` component or any raw-binary `.sig`. `version` and `target` use UTF-8. URLs are replaceable download locations, not release identity, and are unsigned. Stock DERP binaries are operated separately and do not appear in product manifests.
3. **Generate English release notes** with `scripts/release-notes.mjs`. Before release, write and commit `docs/releases/X.Y.Z.md`, beginning with `# Coflux X.Y.Z` and explaining user benefits, installation, and upgrade implications. CI checks the matching version file, English text, and unfinished placeholders. Publication reads the file from the exact tag and appends a compare link; commit messages are no longer copied into the public changelog.
4. **Build desktop** through `desktop-release.yml`, signing, notarizing, and checking artifacts at the same SHA.
5. **Upload to the R2 mirror** (`mirror-upload`, stable tags only; a no-op for prereleases): the Release assets below minus the `.dmg` go to `releases/<tag>/` on R2 before the GitHub Release exists. See [R2 download mirror](#r2-download-mirror-dlcofluxdev).
6. **Publish one unified Release**, only after runtime, desktop and the mirror upload all succeed, containing:
   - Desktop dmg/zip/blockmap and `latest-mac.yml`.
   - `coflux-runtime-<target>`, `coflux-launcher-<target>`, `coflux-ptyd-<target>` and `coflux-cli-<target>` raw binaries plus `.release.sig` (release statement), verified by the runtime (pushes) and by cofluxd (installation).
   - `coflux-transport-<target>` plus `.release.sig`, and transport dependency notices.
   - `coflux-<tag>-<target>.tar.gz` with launcher, runtime, ptyd, `coflux`, transport helper, and notices for manual installation.
   - Schema 3 `manifest.json`: top-level `version`; per-target `runtime` / `launcher` / `cli` / `transport` / `ptyd` entries with `url`, `target`, `sha256`, `size`, and `releaseSignature`; no `worker` component and no raw `signature` anywhere. Also `SHA256SUMS`. For a stable tag every `url` is `https://dl.coflux.dev/releases/<tag>/<asset>`; a prerelease keeps GitHub Release URLs.
7. **Advance the feeds and pointers** (stable tags only): `desktop-updates` pushes the branch feed, then `mirror-pointers` writes the mirror's pointers and prunes older releases from R2.

> **P2 / TODO: npm old-run idempotency versus fail-closed behavior.** `npm-publish-guard.mjs` strictly validates registry `dist-tags.latest` and its corresponding version entries before checking whether the requested version already exists. If latest is missing/corrupt, an old run fails even when its exact version exists, rather than skipping idempotently. This is intentional fail-closed behavior: the guard lacks reliable context proving it is only an old-release replay. Moving the exact-existing check ahead of latest validation could silently accept a new CLI release when registry state is invalid. Diagnose/repair npm latest manually first; relax this only after adding verifiable rerun context and corresponding negative tests.

`ci.yml` gates pushes/PRs to main: type checks and desktop build, Rust tests/build with `-D warnings`, and the full real-process black-box suite. It runs on `ubuntu-latest` and builds neither Swift nor iOS; the iOS app, its native transport framework, and the Swift package's tests are verified by hand on a Mac.

### Recovering a failed npm publication

Re-run `npm-publish` after a transient failure. Understand its two properties first, because they decide whether a re-run can work at all:

- The gate reuses `ci.yml` **from the default branch** with `checkout_ref` pinned to the release commit. The workflow definition and the code under test therefore come from different trees, and a step that depends on code newer than the release commit breaks the gate for every older tag. Steps like this must degrade when the checked-out tree lacks what they call, as the protocol breaking check does.
- **GitHub re-runs a workflow with the workflow files captured for the original run.** Repairing `ci.yml` on main does not change a re-run of an existing `npm-publish` run. The repair only reaches a **new** run, and the sole trigger for one is a successful `release` run.

So a gate failure caused by workflow/code mismatch cannot be recovered by re-running, and re-running the `release` workflow is not a remedy either: it rebuilds and re-signs artifacts already published under that tag, the mirror upload refuses to overwrite a tag whose GitHub Release exists, and the desktop update feed rejects content changes for a version it already carries. Record the gap and let the next release restore npm, as [1.2.0](releases/1.2.0-publication.md) did; a version-pinned `npm install -g cofluxd@X.Y.Z` line in that release's notes must be corrected, since the registry has no such version. Adding a standalone publication entry point is a deliberate change to the release authorization model, not a routine fix.

## R2 download mirror (dl.coflux.dev)

GitHub Release downloads crawl from mainland China (measured 18–53 KB/s from Beijing, against 1.4–2.9 MB/s from the Cloudflare edge), so the **latest stable release** is served from the Cloudflare R2 bucket `coflux-releases` (location hint APAC) on its custom domain `https://dl.coflux.dev` (plan 20260930-r2-download-mirror). GitHub Releases are still published exactly as before and remain the permanent record: every older release and every prerelease is fetched from GitHub.

**Layout.** Installed clients hard-code parts of it (`scripts/release-mirror-layout.mjs` is the single definition):

| Object | Content | Cache-Control |
| --- | --- | --- |
| `releases/<tag>/<asset>` | The tag's GitHub Release assets under their exact names, except the versioned `.dmg` | long, `immutable` |
| `releases/latest.json` | `{"version":"<tag>"}`, the latest stable tag | 60 s |
| `desktop/latest-mac.yml` | The electron-updater feed of new builds, zip URLs under `releases/<tag>/` | 60 s |
| `desktop/coflux-arm64.dmg` | The latest stable DMG under a version-less name, uploaded fresh (never a server-side copy, which would keep the versioned object's metadata) | 300 s |

The add-device page's download button and the README link point at the DMG alias. Stable manifests carry `https://dl.coflux.dev/releases/<tag>/<asset>` URLs; `scripts/release-sign.mjs` keeps GitHub URLs for prereleases.

**Retention: latest stable only** (about 0.6 GB; R2's free tier is 10 GB-month with free egress). `mirror-pointers` deletes every other `releases/<tag>/` prefix, but only after reading `releases/latest.json` back and confirming it names the new tag; it never deletes the prefix `latest.json` names. Prereleases are never uploaded. Superseded manifests (on GitHub and in any cache) therefore carry R2 URLs that 404; nothing reads them, because the server only reads the latest manifest and cofluxd builds URLs from its own base. If anything ever consumes a historical manifest's `entry.url`, rewrite it to GitHub first. Three one-shot windows around a prune are accepted and self-healing: a daemon on an even older worker may get one 404 for the pruned previous version before the server's next 10-minute poll (charged to that version's attempt quota), a desktop app mid-download of the previous zip retries at its next check, and a `cofluxd` run that read the old pointer a moment earlier succeeds on re-run.

**Two phases in `release.yml`:**

1. `mirror-upload` (needs `sign` and `desktop`; `release` needs it) puts `releases/<tag>/` **before** the GitHub Release exists: the server dispatches hot upgrades the moment it sees the Release, so the R2 URLs in its manifest must already resolve. The upload set is the Release's `files` globs (the workflow env `RELEASE_FILES`) minus the `.dmg`. The job always runs, because a skipped dependency would skip `release`; for a prerelease every step is a no-op.
2. `mirror-pointers` (needs `release` and `desktop-updates`; stable tags only, the same gate as `desktop-updates`) writes the DMG alias, `desktop/latest-mac.yml` and `releases/latest.json`, then prunes. Before its first write it refuses a lower version than the current `latest.json`, a same-version `latest-mac.yml` whose content differs, and any read failure other than a plain 404. Waiting for `desktop-updates` means the branch feed has moved on before the previous zip disappears.

Both jobs run `scripts/release-mirror.mjs` (unit-tested in `scripts/release-mirror.test.mjs`, run by CI) through the aws CLI against the R2 S3 endpoint.

**Overwrite gate.** Before touching any object, `mirror-upload` asks whether the GitHub Release for the tag already exists (`gh release view`). If it does, the job refuses to write unless every object is byte-identical (compared through the sha256 each upload records in the object's metadata), and an identical set is a no-op. The server and `cofluxd --version` consume versioned objects without looking at pointers, so a "Re-run all jobs" after publication, which rebuilds and re-notarizes different bytes, must fail rather than swap bytes under a manifest the server has cached. Before the Release exists, a re-run may overwrite.

**Failures.** A `mirror-upload` failure stops the run before the GitHub Release. A `mirror-pointers` failure fails the run, which blocks `npm-publish` (triggered by `workflow_run` on a successful `release`), exactly like a `desktop-updates` failure. Re-run the failed jobs only.

**Credentials** live in the `release-signing` environment and are read only by the two mirror jobs; the `sign` job and the `contents: write` jobs never see them, and neither mirror job has `contents: write`. A missing value fails the job explicitly.

| Name | Kind | Value |
| --- | --- | --- |
| `R2_ACCESS_KEY_ID` | secret | Access key ID of an R2 API token with Object Read & Write on `coflux-releases` |
| `R2_SECRET_ACCESS_KEY` | secret | Secret access key of that token |
| `R2_ENDPOINT` | variable | The account's S3 endpoint, `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | variable | `coflux-releases` |

```sh
gh secret set R2_ACCESS_KEY_ID --env release-signing
gh secret set R2_SECRET_ACCESS_KEY --env release-signing
gh variable set R2_ENDPOINT --env release-signing --body "https://<account-id>.r2.cloudflarestorage.com"
gh variable set R2_BUCKET --env release-signing --body coflux-releases
```

**Cloudflare side.** The bucket's `r2.dev` public URL is disabled (rate-limited, not for production); `dl.coflux.dev` is attached as the bucket's custom domain (minimum TLS 1.2). Cloudflare caches by file extension by default, which would leave extension-less binaries, `.sig`, `.json`, `.yml` and `.blockmap` uncached, so a zone Cache Rule (phase `http_request_cache_settings`, expression `http.host eq "dl.coflux.dev"`) makes every response cache-eligible with edge and browser TTLs taken from the origin `Cache-Control` that the upload sets. See [deployment.md](deployment.md#domains-and-routing).

**How clients choose.**

- **Runtime/transport pushes**: with `COFLUX_AUTOUPDATE_MIRROR_BASE=https://dl.coflux.dev` (production since 2026-10-09, when the centre moved to mainland China and `api.github.com` became unreliable from it), the server discovers releases from `releases/latest.json` and `releases/<tag>/manifest.json`; without it, it polls GitHub's `/releases/latest`. Either way it pushes the manifest's R2 URLs to launcher daemons. The pointer is written only after the GitHub Release exists, so the mirror never names a release GitHub does not have.
- **`cofluxd up` / `cofluxd update`** without `--version` read `https://dl.coflux.dev/releases/latest.json` and install that tag from the mirror; nothing calls `api.github.com`, and `latest` means latest stable. With `--version X`, cofluxd installs from the mirror only when the pointer names X, and otherwise (an older version, a prerelease, or an unreadable pointer) from GitHub Releases. There is no mirror-then-GitHub fallback on error: an R2 outage stays visible. `COFLUX_RELEASE_DOWNLOAD_BASE` overrides the mirror base and `COFLUX_RELEASE_ARCHIVE_BASE` the GitHub one.
- **Desktop auto-update**: new builds read `desktop/latest-mac.yml`; older installs read the `desktop-updates` branch. Both feeds point at the R2 zip.

**Manual fallback.** If the mirror is unreachable, `cofluxd update --version vX.Y.Z` always works: any version the pointer does not name, including every old one, is fetched from GitHub. If a prune went wrong, re-running `mirror-pointers` rewrites the pointers idempotently; a pruned version is always still on GitHub.

## Electron desktop releases

`vX.Y.Z` is the only release tag; desktop, CLI, and runtime share the version and commit. `desktop-release.yml` accepts only `workflow_call`, handling build, Developer ID signing, notarization, stapling, and `codesign`/`stapler`/`spctl` verification, then uploading artifacts for the parent `release.yml` to publish.

Advance the `desktop-updates` branch feed and the R2 mirror's pointers only after the complete GitHub Release succeeds; npm follows through Trusted Publishing. These systems do not form an atomic transaction: retry the failed job, and never infer npm publication solely from GitHub Release success. Prereleases do not update either stable desktop feed, the mirror, or npm latest. Both feeds reject version regression and content changes for an existing version.

### Bundled daemon: desktop releases include Rust components and the Go helper

The app bundles `coflux-launcher`, `coflux-runtime`, `coflux-ptyd`, Rust `coflux`, Go `coflux-transport` and Swift `coflux-screen` under `Contents/Resources/daemon/`, preparing the local device automatically after login. Users no longer need Node or npm cofluxd. The reusable workflow runs its `daemon` job before packaging/signing, building from the same SHA:

`cargo build --release --target aarch64-apple-darwin -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd`

The workflow also runs `scripts/build-transport.mjs` for the same target and version, producing the helper and dependency notices. Rust builds use `RUSTFLAGS=-D warnings` without `release-signing` or secrets. Artifacts pass to the packaging job; `scripts/stage-daemon.mjs` installs them under `build/daemon/` and restores mode 0755, since artifact transfer does not retain executable bits. electron-builder's `mac.binaries` applies Developer ID signing and hardened runtime to all four executables and includes them in notarization. Verification checks existence, `codesign --verify --strict`, and `Authority=Developer ID Application` for each.

- **Version stamp**: `COFLUX_RELEASE_VERSION=vX.Y.Z`, exactly matching the product tag, also written to the `VERSION` sidecar.
- **Updates**: the main app launches ptyd and the launcher with their original signatures; copying no longer triggers ad-hoc resigning. Components live in stable content-addressed directories. After an app update the app stages the bundled runtime and asks the running launcher to switch to it, with no click and terminals kept; a changed bundled launcher is replaced through `leave` + start, also with terminals kept; the launcher rolls a candidate that never passes its checks back to the previous version and the panel shows 「更新未能应用」 / 「重试」. Desktop-hosted daemons advertise `desktop_managed` and never accept centre pushes. Only a changed ptyd keeps the confirmed 「更新终端组件」.
- **Acceptance**: the production signed app must establish that only Coflux needs Full Disk Access, live shell PIDs/memory variables survive updates, and protected directories remain accessible afterward. Development signatures and socket black-box tests do not substitute. Isolate acceptance instances with `COFLUX_DESKTOP_USER_DATA` and `COFLUX_HOME`.
- Local `pnpm -C apps/desktop run pack` requires `COFLUX_DESKTOP_DAEMON_DIR` pointing to local Cargo artifacts; see apps/desktop/README.md. Missing input or any missing binary fails immediately.
- macOS users should now onboard through Coflux.app. `npm i -g cofluxd` remains the Linux/other-machine path. Migrating old services requires an app prompt; startup must not silently terminate existing sessions.

### One-time setup

1. **Reuse the six signing/notarization `release-signing` environment secrets** above. electron-builder reads the certificate from `CSC_LINK` / `CSC_KEY_PASSWORD` and notarization credentials from `APPLE_API_KEY` (path to a temporary `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`.
2. The `release-signing` environment and tag rulesets allow only unified `v*` tags.
3. **The R2 download mirror is the update source** (plan 20260930-r2-download-mirror; GitHub Release downloads are too slow from mainland China). electron-updater uses the generic provider at `https://dl.coflux.dev/desktop`, hardcoded in `apps/desktop/electron-builder.yml`, and reads `desktop/latest-mac.yml`, which `mirror-pointers` writes with absolute zip URLs under `https://dl.coflux.dev/releases/<tag>/`. Apps built before the mirror have `https://raw.githubusercontent.com/myWsq/coflux/desktop-updates` baked into their `app-update.yml`, so the `desktop-updates` job **must keep pushing** `latest-mac.yml` to that branch; it carries the same R2 zip URLs. Retire the branch push only once essentially every install has passed the first R2-era release. `desktop-updates` contains only this file; do not edit it manually. raw.githubusercontent.com caching may delay update visibility by a few minutes. Differential updates fetch the old blockmap from electron-updater's cache first; with latest-only retention the URL fallback is always pruned, so an app without a cached blockmap downloads the full zip.

Missing any signing/notarization secret causes an **explicit workflow failure**, never a silent skip.

### Admission uses the control-plane protocol version, independently of production deployment (plan 105)

Desktop login reports `client_kind=desktop` and `control_protocol_version`, using `CONTROL_PROTOCOL_VERSION` from `packages/protocol`. The center enforces control protocol version 2 for every client and worker, with an additional configurable Desktop floor through `COFLUX_MIN_CONTROL_PROTOCOL_VERSION` (default 2). A lower environment value cannot bypass the global floor. Build IDs identify builds but do not govern desktop admission. Compatible web/mobile clients additionally retain exact build-ID admission; the frozen version-1 clients require an upgrade, with `COFLUX_BUILD_ID_FILE` pointing to the frozen dist; see deployment.md's web-freeze section. Desktop distribution has release delays; the initial same-SHA desktop/production lockstep model proved unusable on launch day.

- Routine production deployments **do not** disconnect older desktop versions. electron-updater checks after 15 seconds at startup and every four hours.
- For breaking protocol changes, increment `CONTROL_PROTOCOL_VERSION` and raise the server minimum default accordingly (an environment override can serve emergencies). **Release desktop first, then deploy production.** Older desktop versions show Update Required and trigger automatic updates. CI's `buf breaking` gates compatibility; changes it accepts need no protocol-version increment.
- Update Required appears **only** for an outdated protocol, not a disconnection. The app neither reconnects nor reloads; it remains there until a new version is installed.

### Installing desktop updates

There is no separate desktop release entry point; use the unified version process above. Routine releases need no coordination with production deployment, but breaking protocols require releasing the client first.

The app checks after 15 seconds at startup, every four hours, and immediately upon admission failure. Available updates download automatically. Installation occurs only when the user explicitly selects Restart and Update, reconnecting to the live runtime. Ordinary quit does not install updates; it ends local terminals according to quit confirmation. Check for Updates in the menu triggers a manual check. Restarting the runtime itself may end terminals, requires separate confirmation, and can be deferred.

Local smoke testing: `pnpm -C apps/desktop run pack` produces unsigned `apps/desktop/dist/mac-arm64/Coflux.app` with fuses set and ad-hoc signing. Notifications/badges are reliable only in signed artifacts; Electron 42+ uses UNUserNotification on macOS. Failures in unsigned packages are not regressions.

## iOS TestFlight releases

The iOS app is released on its own, outside the `v*` tag: `apps/ios/release.sh` archives, uploads to App Store Connect, and then runs `apps/ios/testflight-distribute.mjs` to finish distribution. The build number is the commit count, so it rises on its own and the project file is never touched.

Distribution needs two per-machine credentials, neither in Git:

- `~/.appstoreconnect/private_keys/AuthKey_<kid>.p8` — the App Store Connect API key (App Manager). Archiving and uploading do **not** use it; they sign through the Xcode account session, because this key has no cloud-signing permission.
- `~/.appstoreconnect/issuer_id` — the issuer UUID from App Store Connect > Users and Access > Integrations > App Store Connect API, above the key table. `ASC_ISSUER_ID` / `ASC_KEY_ID` override both.

`testflight-distribute.mjs` waits for processing to reach `VALID`, writes What to Test, links external beta groups, and submits for beta review. Every step is idempotent, so a failed distribution is rerun on its own with `node apps/ios/testflight-distribute.mjs --build <number>` without repeating the upload. `--dry-run` reports what would change; `--whats-new` / `--whats-new-file` replace the default notes, which are the commit subjects touching `apps/ios`, `packages/swift-client` and `scripts/build-ios-transport.mjs` since the previous build's upload; `--groups` narrows the target groups and `--no-review` skips the submission.

Two App Store Connect rules the script already encodes: internal groups receive every build automatically and reject an explicit assignment, and a build's `betaGroups` relationship rejects `GET_RELATED`, so link state is read from the builds collection. Export compliance needs no answer because `Coflux-Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false`.

## How upgrades are applied

Paired updates require a launcher-started runtime advertising `transport_pair_v1`
and `runtime_launcher_v1`. Devices without those capabilities must first install
the complete release with `npm i -g cofluxd@latest && cofluxd update && cofluxd restart`
(terminals kept). Subsequent runtime/helper updates arrive automatically; the
sessiond rebuild pauses terminals briefly. Both artifacts must verify before their
complete immutable version directory is published; candidate startup also requires
a matching local helper handshake.
See [Native Tailcat delivery and rollback](tailcat-transport.md#delivery-bootstrap-and-rollback).
Bundling and upgrading the helper does not enable Tailcat or complete M4.

1. The server polls GitHub `/releases/latest`, which excludes prereleases/drafts, and the release's `manifest.json` (schema 3 with a `runtime` component; schema 2 with a `worker` component is still understood). It caches only when the release tag, top-level manifest version, and every target entry's shape agree. Discovery stays on GitHub, but the artifact URLs it dispatches are the manifest's, which for a stable release point at the R2 download mirror (`dl.coflux.dev`); `mirror-upload` puts them there before the Release exists.
2. Each online daemon is compared immediately at handshake when reporting `workerVersion` (the runtime version) / `platform` / `arch`; a new release triggers another scan of all online daemons. The server still pushes on version inequality, sending `worker.upgrade{version,url,target,sha256,artifactSize,releaseSignature,transport}` (the message keeps its historical name; `signature` is empty for a runtime). A schema 3 runtime goes only to daemons advertising `runtime_launcher_v1` and not `desktop_managed`; a schema 2 worker only to daemons without the launcher capability. `clientUpgradeDaemon` is refused for desktop-managed and pre-launcher daemons.
3. The runtime requires canonical strict SemVer with a `v` prefix and a matching local Rust target. Before any network request, it rejects versions below or equal to the floor the launcher reported. It then downloads with bounds and checks signed size, SHA-256 and the release-statement signature. Only after every check passes is the artifact atomically installed under `~/.coflux/runtimes/<version>/`, and only then does the runtime ask the launcher to switch. Any failure preserves the current runtime.
4. The launcher re-checks the floor, kills the running runtime and spawns the candidate with a per-spawn nonce. A candidate becomes healthy only after the launcher has checked for itself that the candidate echoed that nonce, took over every live session in ptyd's own list, and listens on the gateway port it reports; the observation period then has to pass. Commit first atomically persists `runtime.active`, then `runtime.release-floor`. Floor-write failure prevents declaring commit and disables further remote upgrades for that process. A crash between the two writes is recovered by reconstructing/persisting the floor from the safely recovered active SemVer.
5. `runtime.release-floor` is the monotonic high-water mark of committed remote releases. It advances only after observation commits, never merely after download, verification, disk installation, or a failed pending candidate. SemVer build metadata does not affect precedence, so another build string at the same precedence is replay. Candidate failure still permits internal rollback to the old active version: the floor constrains subsequent **remote requests**, not safe rollback or local administrator switching.
6. Runtime switches leave the shells in ptyd untouched; sessiond is rebuilt from ptyd with a brief pause, attached clients reattach and holders are reclaimed. After failure, the previous runtime reconnects and reports the old version. The server counts attempts per `(daemonId, version)` and permanently stops pushing that version for its current lifetime after `COFLUX_AUTOUPDATE_MAX_ATTEMPTS`, preventing an endless rollback/retry/failure loop.

Without `COFLUX_AUTOUPDATE_REPO`, automatic updates are disabled. Manual `clientUpgradeDaemon` remains available for staged/emergency use (launcher daemons only). Only switching to a version the launcher already knows, with empty `url`, bypasses the remote trust chain.

Configuration in `apps/server/src/config.ts`: `COFLUX_AUTOUPDATE_API_BASE` defaults to `https://api.github.com`; `COFLUX_AUTOUPDATE_REPO` is `owner/repo`; `COFLUX_AUTOUPDATE_POLL_MS` defaults to 10 minutes; `COFLUX_AUTOUPDATE_MAX_ATTEMPTS` defaults to 3. The launcher version (`supervisorVersion` on the wire) is visible in device tooltips but is **not** automatically upgraded.

## Central-host prerequisite: synchronized clocks

The **center** computes online-lease `expiresAt` as `now + config.localLeaseTtlMs`, default 45 seconds. The **daemon** validates it in `crates/runtime/src/local_auth.rs`, `validate_lease`, without skew tolerance. If the center trails the daemon by more than 45 seconds, every lease arrives expired. The daemon logs the literal diagnostic `local lease 安装被拒: lease 已过期`, and direct-path RPC/lifecycle scopes fail. Offline grants still cover session read/control, so `cofluxd doctor` can remain green and cannot rule out this fault.

Observed on prod-jp on 2026-07-25: `timedatectl` showed `System clock synchronized: no` and NTP service `n/a`; system time lagged RTC/real time by 78 seconds. Fix:

```sh
apt-get install -y systemd-timesyncd && timedatectl set-ntp true
timedatectl   # Confirm System clock synchronized: yes
```

Check this before bringing a new central host online.

## First cofluxd installation and launcher upgrades

The runtime updates itself; `cofluxd update` is for the launcher, ptyd and the CLI. It downloads every component, then `cofluxd restart` applies a changed launcher with terminals kept (ptyd and sessions stay); only `cofluxd restart --ptyd` ends terminals. The npm package embeds the same ed25519 public key as the runtime. Remote installation first requires the exact SemVer tag's schema 3 manifest, strict version/target/size/SHA-256 matching, and separate per-component release-statement verification; a schema 2 manifest is refused outright, and old cofluxd fails closed on schema 3 (upgrade the npm package first). Only after all supplied artifacts pass can one staging generation replace them. Releases before 1.1.0 may omit the native CLI; current releases include it. macOS local ad-hoc signing occurs only after verification. Old releases lacking supervisor entries fail closed without falling back to raw downloads. The latest stable release downloads from the R2 mirror and any other version from GitHub Releases; see [How clients choose](#r2-download-mirror-dlcofluxdev).

`--bin-dir` remains an explicit local administrator choice for development/recovery, outside the remote trust chain. This remote installation chain applies from `cofluxd@0.12.0`; 0.11.x and earlier must upgrade the CLI first.

A newly started launcher takes the greater of its builtin runtime's strict SemVer and the existing `runtime.release-floor` as the initial remote rollback-prevention floor. Both embedded public keys must match; CI rejects drift. **Do not rotate the trust root directly**: old cofluxd/runtimes cannot accept releases signed only with a new key. First design and publish an old-key-authenticated dual-trust/handover release, then switch signing keys. Editing the two hex files alone is insufficient.

> **After release, remember:** pushes cover the runtime, so a release touching the launcher (check `git diff <previous-tag>..HEAD -- crates/launcher`) or ptyd reaches devices only after each one restarts that component. `coflux device list` shows which devices still run an older `supervisorVersion` (the launcher's version on the wire):
>
> - **macOS through Coflux.app**: nothing to run by hand. The app updates itself and replaces the launcher (terminals kept) or switches the runtime by itself; only a changed ptyd asks for confirmation. `cofluxd` is not involved — see [Bundled daemon](#bundled-daemon-desktop-releases-include-rust-components-and-the-go-helper).
> - **Linux and other headless hosts**: `cofluxd update`, then `cofluxd restart` (terminals kept); `cofluxd restart --ptyd` only when ptyd changed.
>
> The first schema 3 release stops automatic pushes to every pre-plan daemon: the release notes must say that headless hosts run `npm i -g cofluxd@latest && cofluxd update && cofluxd restart` once, terminals kept, and that afterwards runtime updates arrive automatically.
>
> Devices installed before the app bundled its runtime may still run an old npm-installed service; migrating those is an app prompt, not a release step.
