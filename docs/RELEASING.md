# Release process

## Release lines

| Line | Tag | Workflow | Ships |
| --- | --- | --- | --- |
| Desktop | `vX.Y.Z` (strict SemVer, on the `origin/main` tip) | `.github/workflows/release.yml`, then `npm-publish.yml` | The signed, notarized desktop app; launcher, runtime, ptyd, native CLI and transport helper for four targets; one GitHub Release; the R2 mirror at `dl.coflux.dev`; the desktop update feeds; npm `cofluxd` at the same version |
| iOS | `ios-<N>` (N = commit count of the tagged commit, on `main`) | `.github/workflows/ios-release.yml` | Build N of the iOS app on App Store Connect, distributed on TestFlight |

Releasing is agent-run: when the owner asks for a release, an agent follows the [release skill](../.agents/skills/release/SKILL.md), which decides from the changed paths which lines and whether a centre deploy ([deployment.md](deployment.md#server-deployment)) are due, and runs them. This document is the reference behind it.

Desktop, CLI, and daemon components share one product version. A device runs `coflux-ptyd` (owns terminals), `coflux-launcher` (version pointer, probation, rollback) and `coflux-runtime` (sessiond + centre connection, paired with the Go `coflux-transport` companion). Runtime/helper pairs are pushed by the centre and observed by the launcher (plan 20261002-runtime-launcher-merge); see [hot-upgrade-design.md](hot-upgrade-design.md#7-delivery-in-production-discovery-dispatch-and-configuration). The companion is required and bundled for all targets. Tailcat is the default remote networking stack; custom relay and WebRTC are retired. Desktop hosts the runtime directly; on headless devices, `cofluxd` manages the system service (launchd, systemd user units, or a self-managed service on Linux without systemd; `cofluxd run` is the foreground entry point for containers), while `coflux` handles business operations.

## Cutting a release

### Desktop line (`vX.Y.Z`)

1. Work on a branch cut from `origin/main` (in a worktree), and tag only the `origin/main` tip: release metadata re-checks this after a fresh fetch. This prevents tagging an old/divergent commit; it does not replace the `v*` rulesets.
2. **Main CI must be green.** `ci.yml` is the quality gate; black-box tests rely on its Postgres service.
3. Run `pnpm release:version X.Y.Z` to synchronize root, desktop, and CLI versions; `pnpm release:check vX.Y.Z` verifies consistency. Root `package.json.version` is the sole product-version source. There is no separate npm publication entry point: retry the same npm workflow after failure rather than independently bumping the CLI.
4. Commit `docs/releases/X.Y.Z.md` together with the version bump, and add it to the [release notes index](releases/README.md). It begins with `# Coflux X.Y.Z`, is English, and explains user benefits, installation, and upgrade implications (one-way migrations included). CI reads the notes file named after the current product version and checks English text and unfinished placeholders, so a missing file fails main. Publication reads the file from the exact tag and appends a compare link; commit messages are not copied into the public changelog.
5. Ensure no `release` / `npm-publish` workflow is running or pending. Push one tag at a time, waiting for both the GitHub Release and the downstream npm workflow to finish before releasing the next version.
6. **Keep main still until npm publication finishes.** The npm gate runs `ci.yml` **from the default branch** against the **release commit**, so a change merged into main between the tag and the gate is applied to an older tree. A `ci.yml` step calling a script that the release commit does not contain fails the gate and skips publication. Merge substantial pull requests after the release completes.

```sh
git fetch --prune origin
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
pnpm release:check v1.2.3
git tag v1.2.3
git push origin refs/tags/v1.2.3
```

**Do not** use `git push --tags`, push multiple tags in one command, or push the next release tag before the previous release finishes. GitHub concurrency here permits one running and one pending run. A third burst replaces the previous pending run: latest-pending-wins, not FIFO. Superseded intermediate versions are not automatically published later. The npm registry may lag a few minutes after the workflow prints `+ cofluxd@X.Y.Z`.

Routine releases need no coordination with the centre. A breaking protocol change (raised `CONTROL_PROTOCOL_VERSION`) releases the desktop app first and deploys the centre after; see [Admission](#admission-and-desktop-updates).

**After release:** pushes cover the runtime, so a release touching the launcher (check `git diff <previous-tag>..HEAD -- crates/launcher`) or ptyd reaches devices only after each one restarts that component. `coflux device list` shows which devices still run an older `supervisorVersion` (the launcher's version on the wire):

- **macOS through Coflux.app**: nothing to run by hand. The app updates itself and replaces the launcher (terminals kept) or switches the runtime by itself; only a changed ptyd asks for confirmation. `cofluxd` is not involved — see [Desktop builds](#desktop-builds-and-the-bundled-daemon).
- **Linux and other headless hosts**: `cofluxd update`, then `cofluxd restart` (terminals kept); `cofluxd restart --ptyd` only when ptyd changed. See [hot-upgrade-design.md](hot-upgrade-design.md#8-first-cofluxd-installation-and-launcher-upgrades).
- Devices installed before the app bundled its runtime may still run an old npm-installed service; migrating those is an app prompt, not a release step.

### iOS line (`ios-<N>`)

```sh
N=$(git rev-list --count <commit>)   # a commit on main, usually the desktop release commit or the main tip
git tag "ios-$N" <commit>
git push origin "refs/tags/ios-$N"
```

`ios-release.yml` first validates the tag: the name is `ios-<digits>`, the tagged commit is an ancestor of `origin/main`, and `<digits>` equals its commit count; anything else fails before a build. It then runs on GitHub's `xcode-27` image (public preview since 2026-11-04: macOS 27, Xcode 27.0/27.1/27.2, iOS 27.1 SDK) with Xcode 27.1 selected explicitly, sets up Node 22, pnpm and Go 1.27.1, installs the App Store Connect API key from the `ios-release` environment, and runs `apps/ios/release.sh`, removing the key file at the end. A self-hosted runner is ruled out: the repository is public.

`apps/ios/release.sh` is the single iOS procedure, in CI and on a Mac. It builds the Tailcat xcframework (`scripts/build-ios-transport.mjs`), downloads the Metal Toolchain when missing (a separate Xcode 27 component SwiftTerm's shaders need), archives with `-skipPackagePluginValidation` (SwiftTerm's build plugin), uploads to App Store Connect, then runs `apps/ios/testflight-distribute.mjs`. The build number is the commit count, so it rises on its own and the project file is never touched. Signing always uses `-allowProvisioningUpdates`, so Xcode creates the distribution certificate and profile itself and no certificate is stored: with `ASC_KEY_ID`, `ASC_ISSUER_ID` and the key file (`ASC_KEY_PATH`, default `~/.appstoreconnect/private_keys/AuthKey_<kid>.p8`) present it signs with that API key, which needs the Admin role (an App Manager key has no cloud-signing permission); otherwise it signs through the Xcode account session logged in on the Mac. dSYMs are not uploaded (see `uploadSymbols` in `ExportOptions.plist`); the script prints the kept archive's path.

`testflight-distribute.mjs` waits for processing to reach `VALID` (10-30 minutes, an hour at most), writes What to Test, links external beta groups, and submits for beta review. `--dry-run` reports what would change; `--whats-new` / `--whats-new-file` replace the default notes, which are the commit subjects touching `apps/ios`, `packages/swift-client` and `scripts/build-ios-transport.mjs` since the previous build's upload; `--groups` narrows the target groups and `--no-review` skips the submission. Two App Store Connect rules the script encodes: internal groups receive every build automatically and reject an explicit assignment, and a build's `betaGroups` relationship rejects `GET_RELATED`, so link state is read from the builds collection. Export compliance needs no answer because `Coflux-Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false`.

`ci.yml` gates pushes/PRs to main: type checks and desktop build, Rust tests/build with `-D warnings`, and the black-box suite. It runs on `ubuntu-latest` and builds neither Swift nor iOS; the iOS app is built only by `ios-release.yml` (or `release.sh` on a Mac), and the Swift package's tests are run by hand on a Mac.

## Recovery

### Desktop: release workflow and mirror

Re-run the **failed jobs only**. A `mirror-upload` failure stops the run before the GitHub Release. A `mirror-pointers` or `desktop-updates` failure fails the run, which blocks `npm-publish` (triggered by `workflow_run` on a successful `release`). After the GitHub Release exists, a "Re-run all jobs" is refused by the [mirror's overwrite gate](#r2-download-mirror-dlcofluxdev): it would rebuild and re-notarize different bytes under a manifest the server has cached. The desktop feeds likewise reject content changes for a version they already carry. If a prune went wrong, re-running `mirror-pointers` rewrites the pointers idempotently; a pruned version is always still on GitHub.

### Desktop: npm publication

Re-run `npm-publish` after a transient failure. Understand its two properties first, because they decide whether a re-run can work at all:

- The gate reuses `ci.yml` **from the default branch** with `checkout_ref` pinned to the release commit. The workflow definition and the code under test therefore come from different trees, and a step that depends on code newer than the release commit breaks the gate for every older tag. Steps like this must degrade when the checked-out tree lacks what they call, as the protocol breaking check does.
- **GitHub re-runs a workflow with the workflow files captured for the original run.** Repairing `ci.yml` on main does not change a re-run of an existing `npm-publish` run. The repair only reaches a **new** run, and the sole trigger for one is a successful `release` run.

So a gate failure caused by workflow/code mismatch cannot be recovered by re-running, and re-running the `release` workflow is not a remedy either (see above). Record the gap and let the next release restore npm, as [1.2.0](releases/1.2.0-publication.md) did; a version-pinned `npm install -g cofluxd@X.Y.Z` line in that release's notes must be corrected, since the registry has no such version. Adding a standalone publication entry point is a deliberate change to the release authorization model, not a routine fix.

> **P2 / TODO: npm old-run idempotency versus fail-closed behavior.** `npm-publish-guard.mjs` strictly validates registry `dist-tags.latest` and its corresponding version entries before checking whether the requested version already exists. If latest is missing/corrupt, an old run fails even when its exact version exists, rather than skipping idempotently. This is intentional fail-closed behavior: the guard lacks reliable context proving it is only an old-release replay. Moving the exact-existing check ahead of latest validation could silently accept a new CLI release when registry state is invalid. Diagnose/repair npm latest manually first; relax this only after adding verifiable rerun context and corresponding negative tests.

### iOS: distribution

A failure after the upload leaves the uploaded build intact. Every distribution step is idempotent, so rerun distribution alone, never the upload:

```sh
gh workflow run ios-release.yml --ref ios-<N> -f tag=ios-<N> -f distribute_only=true
```

`--ref` must be the tag itself: the `ios-release` environment admits only `ios-*` refs, and the workflow refuses a run whose ref differs from `tag`. On a Mac the same is `apps/ios/release.sh --distribute-only` or `node apps/ios/testflight-distribute.mjs --build <N>`. A transient archive or upload failure is re-run as is (re-run the workflow run). A fix that needs a code change ships as a new commit and therefore a new `ios-<N>` tag: the build number is tied to the commit.

## One-time setup and secrets

### Release signing key (ed25519)

Daemon artifacts are signed with an ed25519 release private key: one domain-separated release statement per component (`runtime`, `launcher`, `cli`, `transport`, `ptyd`). No component carries a raw-binary signature any more — that was the back door a pre-plan supervisor still checks, and no such supervisor may ever verify, install or run a runtime artifact. All statements bind the version, Rust target, SHA-256, and artifact size; separate domains isolate components.

The runtime verifies pushed runtime releases before it asks the launcher to switch. The npm package's cofluxd uses the same public key to verify launcher, runtime, native CLI, transport helper and ptyd before installation. This separates release authority from the center/download source: without the private key, an attacker can neither replace artifacts nor relabel valid artifacts as another component, version, or architecture. This is not a sandbox for the central control plane, which already has exec/session orchestration capabilities.

`node scripts/gen-keypair.mjs` prints two values:

1. **Private key (PKCS8 PEM)**: store it as `WORKER_SIGNING_KEY` in the `release-signing` environment secrets. **Never commit the private key.**
2. **Public key (hex)**: replace both `crates/runtime/release-pubkey.hex` and `packages/cli/release-pubkey.hex`. Public keys are not secret and belong in the repository; CI checks that both copies match. After committing it, newly built runtimes and newly published cofluxd packages embed it.

> Until replaced with a real key, `release-pubkey.hex` contains only zeros, an invalid point: the runtime **rejects all downloaded upgrades by default**. The runtime also accepts a `COFLUX_WORKER_PUBKEY` environment override for tests and deployments with their own keys. **Do not rotate the trust root directly**; see [hot-upgrade-design.md](hot-upgrade-design.md#8-first-cofluxd-installation-and-launcher-upgrades).

### macOS signing and notarization

Native/cross-compiled Cargo artifacts carry only ad-hoc signatures, without a Team ID or notarization. Starting with macOS Sequoia, newly downloaded top-level executables launched directly by launchd—including the launcher replaced by `cofluxd update`—can receive a silent SIGKILL with `OS_REASON_CODESIGNING`. Inspect `last exit reason` in `launchctl print gui/$(id -u)/com.coflux.daemon` (observed on 2026-07-20). A real Developer ID signature and Apple notarization establish the release artifact's system identity. cofluxd still verifies ed25519 authenticity first, then applies local ad-hoc signing where required by observed platform behavior; users need no manual intervention.

A paid Apple Developer Program account is required. Create once:

1. A **Developer ID Application certificate**, rather than Apple Development / Apple Distribution certificates used for development/App Store distribution. Generate it in Xcode or the Apple Developer portal and export a password-protected `.p12`.
2. An **App Store Connect API key** for noninteractive `notarytool` authentication; Developer privileges suffice. Generate it under App Store Connect → Users and Access → Integrations, download the `.p8`, and record Key ID and Issuer ID.

Configure six `release-signing` environment secrets. Desktop builds reuse them: electron-builder reads the certificate from a temporary keychain the workflow imports it into, and notarization credentials from `APPLE_API_KEY` (path to a temporary `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`. Missing any signing/notarization secret causes an **explicit workflow failure**, never a silent skip.

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

### R2 mirror credentials

Live in the `release-signing` environment and are read only by the two mirror jobs; the `sign` job and the `contents: write` jobs never see them, and neither mirror job has `contents: write`. A missing value fails the job explicitly.

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

### iOS: the `ios-release` environment

The iOS job reads only this environment, never `release-signing`, and has only `contents: read`.

1. **Create an Admin API key** (cloud signing needs Admin; the existing App Manager key cannot sign): App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → add a key with Access **Admin**. Download `AuthKey_<kid>.p8` (it can be downloaded only once) and note the Key ID and the Issuer ID shown above the key table.
2. **Create the environment** with a tag deployment policy `ios-*` and no required reviewers:

```sh
gh api -X PUT repos/myWsq/coflux/environments/ios-release \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/myWsq/coflux/environments/ios-release/deployment-branch-policies \
  -f name='ios-*' -f type=tag
gh secret set ASC_API_KEY_P8 --env ios-release < AuthKey_<kid>.p8   # full .p8 contents
gh secret set ASC_KEY_ID --env ios-release                           # Key ID
gh secret set ASC_ISSUER_ID --env ios-release                        # Issuer ID
```

On the owner's Mac, `~/.appstoreconnect/private_keys/AuthKey_<kid>.p8` holds the App Manager key used for distribution and `~/.appstoreconnect/issuer_id` the issuer UUID; `ASC_ISSUER_ID` / `ASC_KEY_ID` override both. Placing the Admin key there and exporting both variables makes a local `release.sh` sign with it too.

### Protection checklist

These are GitHub/npm settings that repository YAML cannot create. Workflow tag/SHA and main-tip checks prevent mistakes; they are **not authorization boundaries**. Release authorization combines tag rulesets, protected environments, and npm Trusted Publishing. State verified on 2026-11-10:

- [x] Two `v*` tag rulesets: one restricts **creation**, with release maintainers allowed to bypass; the other restricts **updates/deletion**, with release maintainers excluded from bypass and only a minimal, regularly audited emergency administrator group allowed. Bypass applies to an entire ruleset, so one ruleset cannot express both permissions.
- [x] Protected environments `release-signing` (admits `v*`) and `npm-publish` (admits only `main`, the ref of its downstream `workflow_run`). **No required reviewers** (decision on 2026-09-05): with one maintainer, manual approval adds only a browser click per release. Signing remains conditional on an authorized maintainer pushing a `v*` tag, enforced by the tag rulesets.
- [x] `release-signing` holds the signing, notarization, worker-signing and R2 secrets above.
- [x] npm publishing uses Trusted Publishing (OIDC) with provenance: npm's `cofluxd` Trusted Publisher names this repository, `.github/workflows/npm-publish.yml` and environment `npm-publish`, which must exactly match the job's `environment`.
- [ ] **Owner cleanup**: legacy `desktop-v*` tag rulesets and a `desktop-v*` tag policy on `release-signing` remain from the retired separate desktop tags.
- [ ] **Owner's call**: repository-level copies of `WORKER_SIGNING_KEY`, `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_TEAM_ID`, `NOTARY_API_KEY_P8`, `NOTARY_KEY_ID` and `NOTARY_ISSUER_ID` still exist; the jobs read the `release-signing` copies. Delete the repository copies only after confirming a release still works from the environment alone.
- [ ] Create the `ios-release` environment and its three secrets (above), and consider `ios-*` creation/immutability rulesets mirroring `v*`, since pushing an `ios-*` tag is what admits a run to the Admin key.
- [ ] Not verified: legacy/automation/granular npm publish tokens revoked, no `NPM_TOKEN`-style GitHub secrets or `.npmrc` `_authToken` entries left, so only OIDC Trusted Publishing can publish.
- [ ] Not verified: Immutable Releases enabled (if available) with write/admin roles that manage Releases restricted. This prevents later asset replacement as defense in depth; it does not replace client-side ed25519 verification.

> **Preserve the migration order.** First create and protect an environment, then copy secrets and verify release/OIDC behavior, and only then delete repository secrets and old tokens. Do not push release tags or manually republish npm while an environment is unconfigured. An environment's name alone does not prove its reviewer/ref policy is effective.

## Reference

### What a desktop release publishes

A `v*` tag triggers `release.yml`:

1. **Build matrix**: cross-compile launcher, runtime, ptyd, and the native CLI for `x86_64`/`aarch64` linux-musl (static, using `cross`) and native macOS `aarch64`/`x86_64`. Every target needs Zig 0.17.x (pinned with `mlugg/setup-zig`), because the runtime's VT engine, libghostty-vt, is compiled from Ghostty's source and linked statically; never set `LIBGHOSTTY_VT_SYS_CPU=native`. The musl builds run Zig inside `cross`'s container: `Cross.toml`'s `pre-build` installs Zig 0.17.0 for the container's architecture plus `git`, and the workflow prefetches Ghostty's source (at the commit the `libghostty-vt-sys` build script pins) on the runner, runs one lib-vt `zig build` there so every Zig package lands in the source's `zig-pkg/`, and hands the source and a writable Zig cache to the container as `GHOSTTY_SOURCE_DIR` and `ZIG_GLOBAL_CACHE_DIR`: `Cross.toml`'s `[build.env] volumes` mounts both directories at the same path and its `passthrough` sets both variables, because cross 0.2.5's `volumes` alone does not set them. Build the CGO-free transport companion for all four targets with pinned Go 1.27.1. Stock DERP is operated separately: it is not a product release artifact and does not appear in product manifests.
2. **Sign and generate manifests** with `scripts/release-sign.mjs` and `WORKER_SIGNING_KEY`. The signing job has only `contents:read`, separate from the final GitHub Release job with `contents:write`. Each `coflux-<component>-<target>` receives its component's release-statement signature and nothing else. The exact runtime transcript is `"coflux-runtime-release-v1\0" || BE32(len(version)) || version || BE32(len(target)) || target || sha256(raw 32B) || size(BE64)`. The launcher substitutes domain `"coflux-launcher-release-v1\0"`, the native CLI `"coflux-cli-release-v1\0"`, the companion `"coflux-transport-release-v1\0"` and ptyd `"coflux-ptyd-release-v1\0"`; other fields are identical. The script refuses to emit a `worker` component or any raw-binary `.sig`. `version` and `target` use UTF-8. URLs are replaceable download locations, not release identity, and are unsigned.
3. **Generate English release notes** with `scripts/release-notes.mjs` from `docs/releases/X.Y.Z.md` at the tag.
4. **Build desktop** through `desktop-release.yml`, signing, notarizing, and checking artifacts at the same SHA.
5. **Upload to the R2 mirror** (`mirror-upload`, stable tags only; a no-op for prereleases): the Release assets below minus the `.dmg` go to `releases/<tag>/` on R2 before the GitHub Release exists.
6. **Publish one unified Release**, only after runtime, desktop and the mirror upload all succeed, containing:
   - Desktop dmg/zip/blockmap and `latest-mac.yml`.
   - `coflux-runtime-<target>`, `coflux-launcher-<target>`, `coflux-ptyd-<target>` and `coflux-cli-<target>` raw binaries plus `.release.sig` (release statement), verified by the runtime (pushes) and by cofluxd (installation).
   - `coflux-transport-<target>` plus `.release.sig`, and transport dependency notices.
   - `coflux-<tag>-<target>.tar.gz` with launcher, runtime, ptyd, `coflux`, transport helper, and notices for manual installation.
   - Schema 3 `manifest.json`: top-level `version`; per-target `runtime` / `launcher` / `cli` / `transport` / `ptyd` entries with `url`, `target`, `sha256`, `size`, and `releaseSignature`; no `worker` component and no raw `signature` anywhere. Also `SHA256SUMS`. For a stable tag every `url` is `https://dl.coflux.dev/releases/<tag>/<asset>`; a prerelease keeps GitHub Release URLs. The server uses the manifest to dispatch runtime upgrades and cofluxd to verify installation artifacts.
7. **Advance the feeds and pointers** (stable tags only): `desktop-updates` pushes the branch feed, then `mirror-pointers` writes the mirror's pointers and prunes older releases from R2. npm follows through Trusted Publishing. These systems do not form an atomic transaction: retry the failed job, and never infer npm publication solely from GitHub Release success. Prereleases do not update either stable desktop feed, the mirror, or npm latest.

### R2 download mirror (dl.coflux.dev)

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

**Two phases in `release.yml`**, both running `scripts/release-mirror.mjs` (unit-tested in `scripts/release-mirror.test.mjs`, run by CI) through the aws CLI against the R2 S3 endpoint:

1. `mirror-upload` (needs `sign` and `desktop`; `release` needs it) puts `releases/<tag>/` **before** the GitHub Release exists: the server dispatches hot upgrades the moment it sees the Release, so the R2 URLs in its manifest must already resolve. The upload set is the Release's `files` globs (the workflow env `RELEASE_FILES`) minus the `.dmg`. The job always runs, because a skipped dependency would skip `release`; for a prerelease every step is a no-op.
2. `mirror-pointers` (needs `release` and `desktop-updates`; stable tags only, the same gate as `desktop-updates`) writes the DMG alias, `desktop/latest-mac.yml` and `releases/latest.json`, then prunes. Before its first write it refuses a lower version than the current `latest.json`, a same-version `latest-mac.yml` whose content differs, and any read failure other than a plain 404. Waiting for `desktop-updates` means the branch feed has moved on before the previous zip disappears.

**Overwrite gate.** Before touching any object, `mirror-upload` asks whether the GitHub Release for the tag already exists (`gh release view`). If it does, the job refuses to write unless every object is byte-identical (compared through the sha256 each upload records in the object's metadata), and an identical set is a no-op. The server and `cofluxd --version` consume versioned objects without looking at pointers, so a "Re-run all jobs" after publication, which rebuilds and re-notarizes different bytes, must fail rather than swap bytes under a manifest the server has cached. Before the Release exists, a re-run may overwrite.

**How clients choose.**

- **Runtime/transport pushes**: with `COFLUX_AUTOUPDATE_MIRROR_BASE=https://dl.coflux.dev` (production since 2026-10-09, when the centre moved to mainland China and `api.github.com` became unreliable from it), the server discovers releases from `releases/latest.json` and `releases/<tag>/manifest.json`; without it, it polls GitHub's `/releases/latest`. Either way it pushes the manifest's R2 URLs to launcher daemons. The pointer is written only after the GitHub Release exists, so the mirror never names a release GitHub does not have.
- **`cofluxd up` / `cofluxd update`** without `--version` read `https://dl.coflux.dev/releases/latest.json` and install that tag from the mirror; nothing calls `api.github.com`, and `latest` means latest stable. With `--version X`, cofluxd installs from the mirror only when the pointer names X, and otherwise (an older version, a prerelease, or an unreadable pointer) from GitHub Releases. There is no mirror-then-GitHub fallback on error: an R2 outage stays visible. `COFLUX_RELEASE_DOWNLOAD_BASE` overrides the mirror base and `COFLUX_RELEASE_ARCHIVE_BASE` the GitHub one.
- **Desktop auto-update**: new builds read `desktop/latest-mac.yml`; older installs read the `desktop-updates` branch. Both feeds point at the R2 zip.

**Manual fallback.** If the mirror is unreachable, `cofluxd update --version vX.Y.Z` always works: any version the pointer does not name, including every old one, is fetched from GitHub.

### Desktop builds and the bundled daemon

`vX.Y.Z` is the only desktop release tag; desktop, CLI, and runtime share the version and commit, and the `release-signing` environment and tag rulesets admit only these unified tags (the `desktop-v*` leftovers are listed in the protection checklist). `desktop-release.yml` accepts only `workflow_call`, handling build, Developer ID signing, notarization, stapling, and `codesign`/`stapler`/`spctl` verification, then uploading artifacts for the parent `release.yml` to publish.

The app bundles the daemon components under `Contents/Resources/daemon/`, built, signed and notarized by the same workflow at the same SHA, and stamped with `COFLUX_RELEASE_VERSION=vX.Y.Z`; the build, the update behaviour, acceptance and local `pack` smoke testing are in [hot-upgrade-design.md, Desktop-bundled daemon](hot-upgrade-design.md#9-desktop-bundled-daemon-release-build-and-updates).

**Update feeds.** The R2 download mirror is the update source (GitHub Release downloads are too slow from mainland China). electron-updater uses the generic provider at `https://dl.coflux.dev/desktop`, hardcoded in `apps/desktop/electron-builder.yml`, and reads `desktop/latest-mac.yml`, which `mirror-pointers` writes with absolute zip URLs under `https://dl.coflux.dev/releases/<tag>/`. Apps built before the mirror have `https://raw.githubusercontent.com/myWsq/coflux/desktop-updates` baked into their `app-update.yml`, so the `desktop-updates` job **must keep pushing** `latest-mac.yml` to that branch; it carries the same R2 zip URLs. Retire the branch push only once essentially every install has passed the first R2-era release. `desktop-updates` contains only this file; do not edit it manually. raw.githubusercontent.com caching may delay update visibility by a few minutes. Both feeds reject version regression and content changes for an existing version. Differential updates fetch the old blockmap from electron-updater's cache first; with latest-only retention the URL fallback is always pruned, so an app without a cached blockmap downloads the full zip.

### Admission and desktop updates

Admission uses the control-plane protocol version, not the build, so routine centre deployments never disconnect older desktop versions; a breaking protocol change raises `CONTROL_PROTOCOL_VERSION` and releases the desktop app **before** the centre is deployed, and older apps then show Update Required (only for an outdated protocol, never for a disconnection) and update. Full rules: [deployment.md, Desktop admission](deployment.md#desktop-admission-plan-105).

The app checks for updates after 15 seconds at startup, every four hours, and immediately upon admission failure. Available updates download automatically. Installation occurs only when the user explicitly selects Restart and Update, reconnecting to the live runtime. Ordinary quit does not install updates; it ends local terminals according to quit confirmation. Check for Updates in the menu triggers a manual check. Restarting the runtime itself may end terminals, requires separate confirmation, and can be deferred.

How the centre discovers and pushes runtime releases, the floor and rollback rules, and the first `cofluxd` installation are in [hot-upgrade-design.md](hot-upgrade-design.md#7-delivery-in-production-discovery-dispatch-and-configuration). The centre's clock prerequisite is in [deployment.md](deployment.md#central-host-prerequisite-synchronized-clocks).
