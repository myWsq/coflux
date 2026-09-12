# Plan 20260912-unified-release-version: Unified Coflux product version and release entry point

## Status
- State: DONE
- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: 20260912-desktop-runtime-lifecycle.md
- Execution: self
- Planned at: `c79d1202`, 2026-09-12

## Requirement
Desktop and CLI share one product version instead of separate release cadences. One `vX.Y.Z` tag builds desktop, CLI, and kernel from the same commit, delivering matching artifacts. Continue under this session's authorization for an isolated workspace, autonomous implementation, and local commits; do not push, tag, publish npm, open PRs, or deploy.

## Decisions & tradeoffs
- Root package.json is the product-version source of truth; desktop and npm package versions must match. Do not arbitrarily change internal unpublished workspace/crate versions. Binaries use the same COFLUX_RELEASE_VERSION. Evidence: apps/desktop/package.json and packages/cli/package.json currently specify 0.1.7 and 0.15.0 respectively.
- Keep only the v* release trigger; desktop becomes a reusable build step in the unified release. The same GitHub Release contains the kernel manifest and desktop artifacts. Advance the stable desktop feed only after publishing the complete artifact set. Evidence: .github/workflows/release.yml, desktop-release.yml, and apps/server/src/auto-update.ts.
- Remove npm's independent workflow_dispatch entry point; publish only after a successful unified release, rerunning the same workflow after failure. Retain Trusted Publishing, filenames, and upstream SHA/tag checks; add product-version consistency validation before publication. Unifying the entry point must not weaken signing, version monotonicity, or artifact completeness checks.
- Remove the embedded v0.0.0-desktop.* bootstrap version to prevent artificial desktop/production Worker divergence. Unified releases do not require immediate Supervisor replacement; terminal survival remains unchanged.
- Set the first pending version to 0.34.0, higher than the locally existing v0.33.0 kernel tag and desktop/CLI versions. This is pending source versioning, not evidence of publication. Actual release gates still check remote main/tags and the registry.

- Separate commands completely: cofluxd handles only headless device hosting; coflux handles account and local/remote operations. Do not retain compatibility forwarding for old operation entry points. One npm package ships both commands; desktop bundles Rust coflux without Node dependencies. The user explicitly authorized breaking cleanup on 2026-09-12.

## Direction
1. Establish unified version editing and validation; verify that inconsistent versions, incorrect tags, and invalid versions are rejected.
2. Consolidate release orchestration: desktop only builds artifacts; unified release waits for all artifacts to pass before publication. Stable update manifests and npm retain explicit failure/retry paths.
3. Update release documentation and architecture guidance, complete local validation, and commit locally.

## Scope
crates/cli/, apps/desktop/, packages/cli/, integrations/claude-plugin/, package.json, apps/desktop/package.json, packages/cli/package.json, pnpm-lock.yaml (if necessary), .github/workflows/, scripts/, tests/, AGENTS.md, README.md, docs/RELEASING.md, docs/architecture.md, wiki/plans/.

## Landmines
- The sign job currently downloads every artifact. After reusing desktop builds, restrict it to dist-* to exclude desktop temporary files.
- Desktop publication must no longer independently claim GitHub latest; a complete release must also contain the daemon manifest.
- Prereleases must not overwrite the stable desktop feed or npm latest.
- Existing desktop apps continue using desktop-updates; do not migrate installed apps' update URLs.
- Without publication privileges/signing infrastructure, perform local validation only; do not call static CI checks a successful release.

## Commands / Done criteria
- Unified-version positive/negative tests and workflow syntax/dependency checks pass.
- Desktop/server type checks, warning-free Rust build, and the full pnpm -C tests test suite pass.
- Every artifact is traceable to one tag and has a consistent version; old desktop-v* tags no longer trigger independent releases.
- Documentation updated, checkout clean, committed locally; no external publication.

## Acceptance record (2026-09-12)
- Command entry points are fully separated: one npm package contains cofluxd/coflux bins; the Rust binary and desktop injection use coflux. No forwarding of legacy operation commands. Plugin synchronized and bumped to 0.12.0.
- Product version unified at pending 0.34.0. Only v* tags remain; desktop is a called build. Independent npm dispatch removed; stable feed checks monotonicity.
- Final full black-box suite: 317/317 (304.95 seconds), covering both CLIs across devices/workspaces, wrong entry points without side effects, and live terminals across Worker updates. Log: /tmp/coflux-unified-final-blackbox.log.
- Desktop 116/116, server/desktop type checks, and desktop build pass; release configuration 6/6, version/feed 4/4, Rust CLI 29/29, warning-free Rust build, and actionlint pass.
- pnpm frozen-lockfile installation passes. The npm package was actually packed/unpacked; both 0.34.0 entry points independently run --help. Plugin SKILL consistency passes.
- Actual desktop bundle version is 0.34.0, containing coflux and no legacy cofluxd. After synchronizing final CLI help, the binary and main bundle were development-signed again; codesign --verify --deep --strict passes. This is an Apple Development local build, not notarized, with dev kernel version stamping; it is not represented as a production release artifact.
- No push, tag, PR, npm publication, or deployment. Real GitHub Actions publication and Developer ID notarization remain for the later formal release.
