# Plan 087: Withdraw the native macOS client and remove apps/macos and macOS-only adapters

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7bbcc7c..HEAD -- apps/macos packages/swift-client docs/ROADMAP.md docs/architecture.md plans/README.md`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: refactor
- Execution: self
- Planned at: `7bbcc7c`, 2026-08-26

## Requirement

On 2026-08-26 the user decided to withdraw native macOS client development, plans 082–086. After completion:

1. `apps/macos/` is absent, with no unfinished 085 Foundation changes left in the checkout. All current uncommitted changes are under apps/macos; discarding them was approved at departure check.
2. `packages/swift-client` returns to the accepted 084 state: revert `7bbcc7c` (macOS-only adapters), retaining the shared core established by a402d90 / 0923ddd / 00e5c7a. iOS is its sole active consumer.
3. plans/README.md, docs/ROADMAP.md, and docs/architecture.md reflect withdrawal, no longer describe native macOS as ongoing/backlog, and contain no dangling links to deleted files.

**Incorrect neighboring solutions, all failures**: reverting 084's shared core too, which breaks iOS; rebasing history, sacrificing recoverability while 19 unpushed commits are interleaved with iOS/web/server work; deleting plans/082–086 contrary to plan 030's withdrawal precedent; changing darwin content in release.yml, which belongs to cofluxd/CLI releases rather than native client work.

## Decisions & tradeoffs

- **Use forward deletion commits, not rebase.** All 19 related commits are unpushed but interleaved with iOS/web/server changes; for example a402d90 also changes proto/buf.gen.yaml and docs. Rebase introduces broad conflicts and destroys easy recovery for a future restart. Rejected: interactive rebase erasing macOS commits — risk without benefit.
- **Revert 7bbcc7c rather than retaining it for later.** Despite its feat(macos) name, all changes are in packages/swift-client: URLSessionWebSocketTransport, OSLogClientLogger, BundleBuildIdentity, KeychainTokenStore refactor, and about 680 test lines. iOS references none of the new adapters; they are dead code after withdrawal. Revert restores the KeychainTokenStore version accepted by full iOS regression in 00e5c7a. Rejected: keeping roughly 1,100 lines solely for future use. Evidence: apps/ios/Coflux/CofluxApp.swift:21,38 references only KeychainTokenStore and NetworkFrameworkTransport.
- **Retain the rest of packages/swift-client and Swift protobuf generation paths.** 084's shared core is iOS's sole implementation, with 44/44 package tests and full iOS regression passing. proto/buf.gen.yaml points Swift output to packages/swift-client/Sources/CofluxClientCore/Generated, actively used by iOS. Rejected: reverting before 00e5c7a would discard verified modularization with no benefit.
- **Retain plan files; mark WITHDRAWN only in the index.** Follow plan 030's precedent (plans/README.md:34): retain files, mark status and explain withdrawal. Change 082 from IN PROGRESS and 085/086 from TODO to WITHDRAWN. **083/084 remain DONE** as historical facts; 083 may note its artifacts were removed by this plan.
- **Leave release.yml unchanged.** Its macos-latest/MACOS_CERT configuration cross-compiles and Developer ID signs/notarizes cofluxd/CLI darwin artifacts. Evidence: .github/workflows/release.yml:21-22,52-56.

## Direction

### Milestone 1: Clean checkout and delete apps/macos

Discard all uncommitted changes, confirmed confined to apps/macos: eight untracked Foundation* files and changes to pbxproj/project.yml/CofluxApp.swift/four Native*Tests. Then commit `git rm -r apps/macos`.
Validation: git status --porcelain is clean except subsequent planned changes; ls apps contains no macos.

### Milestone 2: Revert 7bbcc7c

`git revert 7bbcc7c`, currently HEAD, should be conflict-free.
Validation: `swift test --package-path packages/swift-client` → exit 0 at the 084 baseline of 44 tests, without 7bbcc7c's adapter tests.

### Milestone 3: Update documentation

- plans/README.md: mark 082/085/086 WITHDRAWN, noting the user's 2026-08-26 cancellation and plan 087 removal, recoverable from Git history. Append 087 to execution order. Remove or mark withdrawn the macOS native Phase 2–7 subplans in Backlog (:101-103).
- docs/ROADMAP.md: replace item 4 Native macOS Client (:74-94) with a withdrawal note, following the 2026-07-15 project/next-day withdrawal precedent at :35-36. Optionally retain one sentence that 083's feasibility conclusions remain valid for future resumption.
- docs/architecture.md: remove apps/macos from the repository table (:373). Remove or historicize macOS probe passages near 105, 130-137, 274, and 293-299 and the native macOS↔Rust/loopback cross-stack release gate at 383-385. Executor chooses based on current content; do not describe them as active gates or retain paths to deleted files.

Validation: `rg -n "apps/macos" --glob '!plans/*'` → no output.

### Milestone 4: Regression validation

Run iOS build regression and repository-wide reference scan. See Commands.

## Landmines

- 7bbcc7c is named feat(macos) but changes only packages/swift-client. Deleting apps/macos alone does not remove it; revert is required.
- architecture.md:137 and ROADMAP.md:93-94 reference apps/macos/WEBRTC_PROBE.md. After deletion, historical notes must instead link to plans/083-macos-native-client-feasibility-gates.md or Git history.
- Index rows 082/083 are extremely long; use precise unique anchors to avoid editing the wrong row.
- Swift tests before M2 include adapter tests and exceed the 44-case baseline. Revert first.
- git checkout does not remove untracked files. Use `git clean -fd apps/macos` only within that directory, first previewing with `git clean -nd apps/macos` and confirming every path is under apps/macos.

## Scope

In scope:

- apps/macos/**: delete directory and discard its uncommitted changes
- packages/swift-client/**: only files touched by git revert 7bbcc7c
- plans/README.md and this plan
- docs/ROADMAP.md, docs/architecture.md
- tests/fixtures/terminal/README.md: decided during execution after truncated exploration output missed lines 19-20 referencing deleted apps/macos/scripts/test-terminal-sessiond-interop.sh. Remove only that clause as another dangling-link fix; leave fixtures and xterm oracle consumers unchanged.

Out of scope:

- apps/ios/**: build regression only, no changes
- 084 shared-core logic in packages/swift-client (CofluxClientCore, DeviceRouter, existing CofluxApplePlatform files): untouched beyond the revert
- proto/** including Swift generation path: used by iOS
- .github/workflows/release.yml: cofluxd/CLI darwin release pipeline
- The five plans/082–086 documents: retained under plan 030 precedent

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Package tests | `swift test --package-path packages/swift-client` | exit 0, 44-case baseline after revert |
| iOS build regression | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator'` | exit 0 |
| Residual reference scan | `rg -n "apps/macos" --glob '!plans/*'` | No output |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] apps/macos is absent with no uncommitted remnants.
- [ ] git log ends with deletion/revert commits, or a combined set, without rebasing existing history.
- [ ] Index marks 082/085/086 WITHDRAWN and 083/084 DONE; execution order includes 087.
- [ ] ROADMAP/architecture no longer describe native macOS as active or link to deleted files.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] plans/README.md status updated.

## STOP conditions

- A cited fact no longer holds, for example iOS references a new 7bbcc7c symbol.
- Revert conflicts, indicating HEAD changed and needs reassessment.
- The outcome requires out-of-scope files.
- Validation fails twice after one reasonable fix.
- git clean -nd apps/macos previews paths outside apps/macos.

## Maintenance notes

- A future native macOS restart can recover all code from Git history, range 384142b..7bbcc7c plus the parent of this deletion commit. 083's feasibility results—SwiftTerm, native loopback identity, libwebrtc↔Rust worker interoperability, development GO—remain valid despite deletion; plan documents remain.
- packages/swift-client is now positioned as the iOS shared core. Treat future adapters added only for hypothetical platforms according to this precedent.
