# Plan 20261110-release-lines: Desktop and iOS release separately, iOS builds in the cloud, and an agent runs releases

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat baf81522..HEAD -- .github/workflows apps/ios/release.sh apps/ios/testflight-distribute.mjs apps/ios/ExportOptions.plist docs/RELEASING.md docs/ROADMAP.md AGENTS.md .agents/skills .claude/skills`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: dx
- Execution: subagent(opus) — from the departure check
- Stop after: implementation — from the departure check (plain autopilot)
- Plan review: none — from the departure check
- Workspace: current — the session is in the linked worktree `.claude/worktrees/20261109-dictation-refine`; branch `dev/20261110-release-lines` was cut there from `origin/main` (`baf81522`)
- Planned at: `baf81522`, 2026-11-10

## Record

### Requirement

Two pains from the 2.25.0 release:

- The iOS build can only reach TestFlight from the owner's Mac, because upload signing borrows the Xcode account session; that session breaks every release or two ("App Store Connect access for 8Y2J55823C is required"), and the owner has to remove and re-add the account by hand.
- Releasing is a long manual procedure spread over a 281-line `docs/RELEASING.md` that mixes the steps with signing internals, the R2 mirror and hot-upgrade mechanics, and a one-time setup checklist whose state nobody knows.

Product conclusions (confirmed with the user):

1. **Two independent release lines.** The desktop line keeps `v<semver>` tags (desktop app, daemon components, npm `cofluxd`), unchanged. The iOS line gets `ios-<build>` tags, the number being the build number (the commit count of the tagged commit). Pushing an iOS tag builds, uploads and distributes the TestFlight build on a GitHub-hosted runner, with no dependence on any local Xcode session; a failed run can be rerun on GitHub. Signing uses a new App Store Connect API key with the Admin role, created by the owner.
2. **An agent runs releases.** The owner says "发版"; the agent compares what changed since the last `v*` tag and the last `ios-*` tag, decides desktop, iOS, both or neither and says why, deploys the centre first when the server changed (backup first), writes the release notes, pushes the tags and watches the workflows to the end. The steps live in a project skill the agent follows every time.
3. **A slimmer `docs/RELEASING.md`.** It opens with the two release lines and how to cut a release; one-time setup and the secret tables come after; signing, mirror and upgrade internals are condensed or moved to the design documents they belong to; outdated content is removed and the setup checklist reflects the verified state.

### Decisions & tradeoffs

- **D1 Tag scheme.** iOS tags are `ios-<N>` where `N == git rev-list --count <tagged commit>` and the tagged commit is on `main`; the workflow refuses anything else. Rejected: `ios-v<semver>` — the iOS marketing version is a fixed `1.0` and the build number is the only identity TestFlight shows; a second number would drift from it. Based on: `apps/ios/release.sh` (`BUILD_NUMBER=$(git rev-list --count HEAD)`), `apps/ios/Coflux.xcodeproj/project.pbxproj` (`MARKETING_VERSION = 1.0`).
- **D2 Signing by API key.** Archive and export authenticate with the App Store Connect API key (`-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID` plus `-allowProvisioningUpdates`), which with the Admin role permits cloud-managed signing. No certificate or profile is stored. Rejected: storing an Apple Distribution certificate and profile — no such certificate exists locally today and it adds expiry management. Based on: `docs/RELEASING.md` "iOS TestFlight releases" (the current App Manager key "has no cloud-signing permission"), user confirmation.
- **D3 Least-privilege environment.** The three ASC values live in a new GitHub environment `ios-release` whose deployment policy admits only `ios-*` tags; the iOS job sees nothing from `release-signing`, and `release-signing` keeps admitting only `v*`. Tag rulesets for `ios-*` mirror the `v*` pair (creation restricted, update/deletion blocked). The environment, its secrets and the rulesets are repository settings created by the orchestrator, not by the diff. Based on: `gh api repos/myWsq/coflux/rulesets` (`v*` creation + immutability rulesets exist).
- **D4 Runner.** `runs-on: xcode-27` (GitHub's Xcode 27 image, public preview since 2026-11-04, macOS 27, Xcode 27.0/27.1/27.2, iOS 27.1 SDK), Xcode pinned to 27.1 explicitly. Rejected: a self-hosted runner on the owner's Mac — the repository is public (roadmap decision 2026-11-09). Based on: `actions/runner-images` `images/macos/xcode-27-arm64-Readme.md` (image 20261104), issue #14404.
- **D5 One procedure, two callers.** `apps/ios/release.sh` stays the single definition of build → archive → upload → distribute; the workflow calls it. With the ASC environment variables set it signs by API key (D2); without them it keeps today's Xcode-session behaviour for an emergency local release.
- **D6 Re-runs never re-upload.** A rerun with distribution only (workflow dispatch) skips build and upload, because App Store Connect rejects a second upload of the same build number; `testflight-distribute.mjs` is idempotent.
- **D7 The release skill decides from paths, and the release request is the authorization.** "发版" authorizes the tags and the centre deploy it implies; the agent states its decision in one line and proceeds, and stops only on failures or when a one-way migration's backup cannot be taken. Path → line mapping is fixed in the skill (see the brief).
- **D8 The documentation keeps every still-true fact.** Moving a section to a design document is fine; deleting is only for what is false or superseded. Facts verified on 2026-11-10: `v*` creation and immutability rulesets exist; legacy `desktop-v*` rulesets and a `desktop-v*` tag policy on `release-signing` remain from the retired separate desktop tags; `release-signing` holds the signing, notarization, worker-signing and R2 secrets, and repository-level copies of the signing/notarization/worker secrets still exist (deleting them is the owner's call); npm publishing uses provenance (OIDC).

### Discussion log

- User: "怎么又要重新登录啊？能不能改成云端构建发布啊？就不要老依赖我本机的环境了。" — found the Xcode 27 runner image now exists, lifting the 2026-11-09 "wait" decision.
- Asked whether to move iOS to cloud builds signed by a new Admin API key. User: "可以把桌面端的 Tag 和 iOS 的 Tag 分开…打这个 tag…应该是我们 release 流程的一部分…release 文档…精简一下…每次发版的时候，由 Agent 根据本次的改动来决定要发桌面还是发 iOS 或者两个都发。"
- Product confirmation of the three points under Requirement: "确认".
- Departure check: direction "按此方向" (`ios-release.yml` on `xcode-27`, `ios-release` environment and `ios-*` rulesets, `.agents/skills/release`, rewrite of `docs/RELEASING.md`); execution "Subagent (opus)"; autopilot "直接自动执行".
- D6 `(decided while planning)`.

### Maintenance notes

- `xcode-27` is a preview image; when GitHub promotes Xcode 27 into a GA label, switch `runs-on` and re-pin Xcode.
- Cloud signing on an ephemeral runner: watch App Store Connect for accumulating certificates after the first runs.
- The old App Manager key on the owner's Mac becomes redundant once the Admin key is in place.

## Execution brief

> Written for `subagent(opus)` at `baf81522`. Implement the milestones in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

Give the project two release lines and make releasing an agent-run procedure:

- **Desktop line** (unchanged): a `v<semver>` tag runs `.github/workflows/release.yml` (desktop app, daemon components, GitHub Release, R2 mirror) and then `npm-publish.yml`.
- **iOS line** (new): an `ios-<N>` tag runs a new workflow that builds the iOS app on GitHub's `xcode-27` runner, uploads it to App Store Connect signed by an App Store Connect API key, and distributes it on TestFlight.
- **Release skill** (new): `.agents/skills/release/SKILL.md`, the procedure an agent follows when the owner asks for a release.
- **`docs/RELEASING.md`** rewritten shorter, steps first.

Conventions: English for all files (`AGENTS.md` language policy); workflow comments may follow the existing files' style. Pin third-party actions by commit SHA as `release.yml` does. Project skills live in `.agents/skills/<name>/` with a relative symlink in `.claude/skills/<name>` (see `.claude/skills/desktop-preview -> ../../.agents/skills/desktop-preview`). There is no formatter for these files.

### Milestone 1: the iOS line builds in the cloud

Depends on: none

#### T1 · `release.sh` signs by API key when given one

- Where: `apps/ios/release.sh` — the `xcodebuild archive` and `xcodebuild -exportArchive` invocations, and `BUILD_NUMBER=$(git rev-list --count HEAD)`.
- Change: when `ASC_KEY_ID`, `ASC_ISSUER_ID` and a key file (`ASC_KEY_PATH`, defaulting to `~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8`) are all present, pass `-authenticationKeyPath`, `-authenticationKeyID`, `-authenticationKeyIssuerID` to both archive and export alongside the existing `-allowProvisioningUpdates` (D2). Without them, behave exactly as today (Xcode account session) (D5). Accept an optional `--distribute-only` flag that skips transport build, archive and upload and only runs `testflight-distribute.mjs` for the current build number (D6). Keep the existing comments' facts (Metal Toolchain download, SwiftTerm plugin validation, dSYM note) true.
- After: run on a Mac with the three ASC variables set, the script needs no Xcode account; the build number is still the commit count; `testflight-distribute.mjs` receives the same `ASC_KEY_ID` / `ASC_ISSUER_ID` (it already reads them from the environment).
- Don't: print the key or the issuer id; don't touch `project.pbxproj`.

#### T2 · `ios-release.yml`

- Where: new `.github/workflows/ios-release.yml`; reference patterns in `.github/workflows/release.yml` (tag validation job, `actions/checkout` / `actions/setup-go` / `pnpm` setup and their pinned SHAs, Go `1.27.1`).
- Change: a workflow triggered by `push: tags: ["ios-*"]` and `workflow_dispatch` with inputs `tag` (required) and `distribute_only` (boolean, default false). One job, `runs-on: xcode-27`, `environment: ios-release`, `permissions: contents: read`, a concurrency group per tag with `cancel-in-progress: false` (D3, D4, D6). Steps:
  1. Check out the tag with full history (`fetch-depth: 0`).
  2. Validate: the ref is `ios-<digits>`; the tagged commit is an ancestor of `origin/main`; `<digits>` equals `git rev-list --count` of that commit. Fail with a clear message otherwise (D1).
  3. Select Xcode 27.1 explicitly (`/Applications/Xcode_27.1.app`) (D4).
  4. Unless `distribute_only`: set up Node and pnpm as `release.yml` does, install dependencies, set up Go 1.27.1.
  5. Write the `ASC_API_KEY_P8` secret to `$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8` (mode 600, never echoed) and export `ASC_KEY_ID`, `ASC_ISSUER_ID` from secrets of the same names.
  6. Run `apps/ios/release.sh` (with `--distribute-only` when requested) (D5).
  7. Always remove the key file at the end.
- After: pushing `ios-1800` for a main commit whose commit count is 1800 archives, uploads and distributes build 1800; a mismatching number or an off-main commit fails before any build; a dispatch with `distribute_only: true` only distributes.
- Don't: reference any `release-signing` secret, add `contents: write`, or use a self-hosted runner (D3, D4).

### Milestone 2: the release skill

Depends on: Milestone 1 (it names the iOS workflow and tag scheme)

#### T3 · `.agents/skills/release/SKILL.md` and its Claude link

- Where: new `.agents/skills/release/SKILL.md`; new symlink `.claude/skills/release -> ../../.agents/skills/release`; `AGENTS.md` — the "Common commands" line `git tag v1.2.3 && git push origin v1.2.3 ...` and the "CI/releases:" paragraph; `docs/RELEASING.md` will link to the skill (Milestone 3).
- Change: write a skill (frontmatter `name: release`, a `description` that triggers on release requests such as "发版", "release", "ship a version", "publish iOS") that an agent follows end to end:
  1. **Decide.** Find the last `v*` tag and the last `ios-*` tag (`git tag --sort=-creatordate`), the commit the centre runs (`ssh coflux-bj 'git -C /opt/coflux rev-parse HEAD'`), and diff each against `origin/main`. Path rules:
     - Desktop line when anything changed under `apps/desktop`, `crates/`, `packages/cli`, `packages/client`, `packages/core`, `packages/executor`, `packages/protocol`, `native/`, `transport/tailcat` (outside `cmd/coflux-transport-ios`), `integrations/claude-plugin`, or `proto/`.
     - iOS line when anything changed under `apps/ios`, `packages/swift-client`, `scripts/build-ios-transport.mjs`, `transport/tailcat`, or `proto/`.
     - Centre deploy when anything changed under `apps/server`, `packages/protocol`, `packages/core` since the deployed commit.
     - Docs, plans, tests and CI-only changes release nothing.
     State the decision and the reason in one line, then proceed (D7).
  2. **Preconditions.** Work from a branch cut from `origin/main` in a worktree (never switch the main worktree's branch); `main` CI green; no `release` / `npm-publish` / `ios-release` run in flight.
  3. **Centre first** when needed: follow `docs/deployment.md` "Server deployment" (backup with `pg_dump`, verify with `pg_restore -l`, `git fetch` with a short timeout and a git-bundle fallback, `git checkout --detach`, `pnpm install --frozen-lockfile`, restart, health and `schema_migrations` check, daemons reconnect). A one-way migration is named in the release notes.
  4. **Desktop line**: `pnpm release:version X.Y.Z`, write `docs/releases/X.Y.Z.md` (English, no Han characters, starts with `# Coflux X.Y.Z`) and index it, commit, push to `main` (`git push origin HEAD:main`), tag `vX.Y.Z` on that commit, push the one tag, watch `release` then `npm-publish` (npm registry may lag a few minutes after `+ cofluxd@X.Y.Z`).
  5. **iOS line**: tag `ios-<N>` on the release commit with `N = git rev-list --count <commit>`, push it, watch `ios-release`; on a distribution failure rerun with `distribute_only`.
  6. **Report** what shipped, what was deployed, backups, and anything pending for the owner, in Chinese.
  Keep it short and procedural; link to `docs/RELEASING.md` and `docs/deployment.md` for detail instead of repeating them. In `AGENTS.md`, point the release command line and the CI/releases paragraph at the skill and mention the iOS line.
- After: an agent reading only the skill can decide and run a release; `ls -l .claude/skills/release` shows the relative symlink.

### Milestone 3: `docs/RELEASING.md` rewritten

Depends on: Milestone 2

#### T4 · Steps first, internals condensed

- Where: `docs/RELEASING.md` (all of it); `docs/ROADMAP.md` — item "### 3a. Release automation"; optionally `docs/hot-upgrade-design.md` or `docs/architecture.md` as destinations for moved material.
- Change: restructure into, in this order: (1) the two release lines and what each ships, with a pointer to the release skill; (2) cutting a release — the desktop checklist (still true: one tag at a time, keep main still until npm finishes, notes file required by CI, `pnpm release:version` / `release:check`) and the iOS tag; (3) recovery (npm gate re-run limits, mirror overwrite gate, iOS `distribute_only`); (4) one-time setup and secrets — signing keys, macOS signing/notarization, R2, and the new `ios-release` environment with `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and how the Admin key is created; the protection checklist rewritten to the verified state in D8, listing the legacy `desktop-v*` rulesets/tag policy and the repository-level secret copies as open cleanup for the owner; (5) condensed reference — what a release publishes, the R2 mirror layout and client choice, desktop update feeds. Move "How upgrades are applied", "First cofluxd installation and launcher upgrades" and the centre clock prerequisite to the design or deployment document that fits, unless a short summary plus link reads better. Update the roadmap item to done-by-this-plan with the facts (xcode-27 preview image, API-key signing). Drop statements that are false today (e.g. iOS "released on its own, outside the `v*` tag … waits for an Xcode 27 runner").
- After: `docs/RELEASING.md` is clearly shorter than 281 lines, starts with the release lines, every still-true fact from the old file survives in it or in the document it moved to (D8), and every relative link resolves.
- Don't: change release behaviour described for the desktop line; don't delete facts merely for brevity (D8).

### Your call

- Wording, section names and exact length of the documents and the skill.
- Shell structure inside `release.sh` and the workflow, step names, how the key file is cleaned up.
- Which design document receives moved material.

### Landmines

- `npm-publish.yml` runs `ci.yml` from the default branch against the release commit; nothing in this plan may make `ci.yml` depend on files the release commit lacks.
- `apps/ios/testflight-distribute.mjs` picks the only `AuthKey_*.p8` in `~/.appstoreconnect/private_keys/` unless `ASC_KEY_ID` is set; always set it in CI.
- The workflow must never print secrets; avoid `set -x` around the key handling.

### Scope

In scope:
- `.github/workflows/ios-release.yml` (new)
- `apps/ios/release.sh`
- `.agents/skills/release/SKILL.md` (new), `.claude/skills/release` (new symlink)
- `AGENTS.md`
- `docs/RELEASING.md`, `docs/ROADMAP.md`, and `docs/hot-upgrade-design.md` / `docs/architecture.md` / `docs/deployment.md` only as destinations for moved release material
- `wiki/plans/20261110-release-lines.md`, `wiki/plans/README.md`

Out of scope:
- `.github/workflows/release.yml`, `desktop-release.yml`, `npm-publish.yml`, `ci.yml` — the desktop line is unchanged.
- `apps/ios/testflight-distribute.mjs`, `apps/ios/ExportOptions.plist`, the Xcode project.
- Repository settings (environments, rulesets, secrets) — the orchestrator does those.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Keeping a still-true fact would require rewriting a document outside the scope list.

## Verification

### Milestone validations

- Milestone 1: `bash -n apps/ios/release.sh` → exit 0; `actionlint .github/workflows/ios-release.yml` if available, otherwise a YAML parse (`node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ios-release.yml','utf8'))"`) → exit 0.
- Milestone 2: `test -L .claude/skills/release && test -f .claude/skills/release/SKILL.md`.
- Milestone 3: every relative link in `docs/RELEASING.md` resolves (scripted check); `wc -l docs/RELEASING.md` well under 281.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Shell syntax | `bash -n apps/ios/release.sh` | exit 0 |
| Workflow lint | `actionlint` (or YAML parse) on `ios-release.yml` | exit 0 |
| Product version check | `pnpm release:check v2.25.0` | exit 0 (unchanged) |
| iOS cloud release (acceptance) | after the owner provides the Admin key: create environment `ios-release` (tag policy `ios-*`), set its three secrets from the key file, add `ios-*` rulesets, then push `ios-<N>` for the 2.25.0 commit | build N on TestFlight, distributed |

### Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every task's `After` state holds.
- [ ] `ios-release.yml` references only `ios-release` secrets and has `contents: read` (D3).
- [ ] Tag validation rejects a mismatching number and an off-main commit (read the step; D1).
- [ ] `release.sh` without ASC variables behaves as before (D5).
- [ ] The skill's path rules match D7 and the brief.
- [ ] `docs/RELEASING.md` starts with the release lines; no still-true fact lost (D8).
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Repository settings (not in the diff): environment `ios-release` with deployment policy tag `ios-*`; secrets `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`; rulesets for `ios-*` tag creation and immutability mirroring `v*`.
- Needs the owner: an App Store Connect API key with the Admin role (App Store Connect › Users and Access › Integrations), its `.p8` placed in `~/.appstoreconnect/private_keys/`.
- First acceptance run publishes the 2.25.0 iOS build from the cloud.
- Open cleanup for the owner (not done here): delete legacy `desktop-v*` rulesets and tag policy; delete repository-level duplicates of the signing secrets.
