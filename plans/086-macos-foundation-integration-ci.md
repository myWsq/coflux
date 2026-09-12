# Plan 086: Complete Foundation integration with atomic subscriptions, cross-stack regression, and macOS CI

> This is Phase 1's integration outcome contract, not a step-by-step script. Execute only after plans 084/085. Design server buffering, black-box tests, and CI against live code; validate/commit each milestone. Stop on any STOP condition. Update plan 082, this plan, the index, and architecture documentation when complete.
>
> Drift check: `git diff --stat 5942465..HEAD -- apps/server/src/ packages/client/src/ tests/src/ tests/fixtures/ .github/workflows/ apps/macos/scripts/ docs/ plans/082-macos-native-client-program.md`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: `plans/084-shared-swift-client-core.md`, `plans/085-macos-native-foundation-app.md`
- Category: tests
- Execution: self-execution (continues plan 082 departure check)
- Planned at: `5942465`, 2026-08-25

## Requirement

Close two system boundaries that single-machine unit tests cannot prove:

1. Snapshot querying and concurrent broadcasts during subscription must converge atomically, without native/web/iOS losing deltas in the query window.
2. PR/main CI must reproducibly generate/test shared Swift package and app on macOS, auditing universal Release artifacts, module boundaries, and probe regressions.

Phase 1 can then be DONE: relevant shared core/iOS/macOS/server regressions pass, a real isolated stack verifies login→snapshot→concurrent deltas→disconnect/reconnect, and CI catches XcodeGen/Buf drift and accidental WebRTC embedding. LAN/TCC, Intel hardware, and production signing remain Phases 6–7. Green CI is not release GO.

## Decisions & tradeoffs

- **Per-client server syncing buffer**: enter syncing and collect same-account broadcasts before querying; send database snapshot, flush in arrival order, then become subscribed. Rejected: Swift revision guesses/UI delays cannot detect lost frames without server revisions. Rejected: protocol changes when server can fix atomicity on existing wire. Evidence: hub.ts:246-250,1387-1408.
- **Buffer only the snapshot-query window**, bounded and constrained by account/connection lifecycle. Close/auth error/logout discards it. Never both directly send and buffer one broadcast. Overflow fails closed by disconnecting/resubscribing, never silently dropping oldest messages. Rejected: unbounded arrays under slow DB/broadcast storms.
- **Real concurrent black-box proof**, not only helper tests. Trigger controlled mutation during snapshot query, assert final snapshot+buffer state/order, and prove removing buffering makes tests fail. Rejected: mock DB or sleeping to guess the race window.
- **Deterministic Postgres lock barrier owned by the test stack**, no production endpoints/hooks. Expose only that stack's temporary DB URL to this test. Hold ACCESS EXCLUSIVE on a table read by snapshot but not written by the mutation; poll pg_stat_activity until actual server SELECT waits on the lock and other snapshot queries are quiescent. Trigger business mutation solely via WebSocket, then release lock. DB access is only barrier/activity observation, never reading/writing business rows. Finally/strict cleanup rolls back, closes connections, drops temporary DB. Rejected: fixed sleep remains racy; production env/file barriers add test controls to the product.
- **Do not rewrite TS reducer.** Web serves as behavioral oracle with only directly relevant shared-fixture/regression tests. Native reducer is frozen by 084. Cross-language generated reducers exceed Foundation scope.
- **Independent macOS CI job with pinned XcodeGen and Package.resolved**, no automatic dependency drift. Rejected: Apple builds in Ubuntu or latest XcodeGen each run are unreproducible. Evidence: ci.yml:15-83, macOS project.yml:1-24.
- **Ordinary CI imports no personal/Developer ID certificates and runs no GUI TCC, cross-NAT, or public-network acceptance.** It provides unsigned/ad-hoc mechanical gates; local Development evidence and Phase 6 matrix are separate. Avoid flaky external PR gates and false signing claims from unsigned builds.
- **Actually build generic Release and inspect arm64 x86_64 main Mach-O, versions, and absence of WebRTC.framework.** ARCHS settings or Debug configuration graphs are not artifact proof.
- **A macOS 14 runner proves only its actual OS/architecture.** Apple Silicon cross-build, Rosetta, or cloud runners do not substitute for Intel hardware. Final Intel/macOS 14/clean-user matrix remains Phases 6–7.
- **No production native allowlist/protocol build metadata in Phase 1.** Release app has auditable identity; independent release cadence, minimum versions, readable ClientOutdated, and update URLs need a Phase 6 compatibility plan. Rejected: exact web/mobile Git SHA admission would reject independently released native apps on the next web deploy. Evidence: hub.ts:1724-1738,1793-1818; client.proto:249-253.

## Direction

### Milestone 1: Atomic subscription and deterministic regression

Buffer same-account broadcasts during snapshot queries with bounded flush. Negative tests cover disconnect, duplicate subscribe, auth switch, overflow. Existing web/mobile/iOS wire unchanged.
Validation: server types and targeted server tests exit 0.

### Milestone 2: Real-process subscription race tests

Harness starts real server/clients with temporary DB/ports. Lock barrier confirms Store query blocked before WebSocket project/workspace/device mutations. Final state has no lost frames or duplicate side effects; removing buffering deterministically fails. Barrier never accesses business data, and timeout/error paths release every lock.
Validation: new targeted black-box file passes independently.

### Milestone 3: Reproducible macOS CI gates

Pin tools; verify XcodeGen regeneration, Buf Swift output, local package, macOS tests, Release universal/purity. Resolve from committed lock without silent updates; caches cannot conceal generated drift.
Validation: workflow syntax and equivalent local commands pass; review confirms no secrets/signing dependency.

### Milestone 4: Close the Phase 1 matrix

Relevant iOS/macOS/server/protocol/black-box/Phase 0 regressions pass. Docs/ROADMAP/architecture/plans accurately record Phase 1 completion, deferred release gates, and Phase 2 entry, never production publication.
Validation: quick matrix green; environment-specific items recorded at final acceptance.

## Landmines

- Broadcast currently skips subscribed=false, permanently losing mutations during snapshot query (hub.ts:246-250,1387-1408).
- Barrier must lock a snapshot-read table not written by the target mutation, avoiding self-deadlock. Handshake uses wait_event_type='Lock' and quiescence of other snapshot queries, never sleep.
- After snapshot, server sends full agent state per daemon. Flush order must preserve this and avoid incorrect clearing.
- ProjectCreated/WorkspaceCreated are upserts. Exercise rename/defaultBranch/diff changes, not only creation.
- Whole-checkout git diff after generation can mistake intended implementation changes for drift. Validate committed/staged baseline or a dedicated temporary copy.
- App tests include environmental WebRTC/loopback probes. PR CI runs deterministic subsets or contractual unconfigured skips; real interop is separate final acceptance.
- Committed XcodeGen projects discard manual pbxproj changes at regeneration.
- Runner labels/Xcode/actual architecture drift. Log sw_vers, uname -m, xcodebuild -version, swift --version rather than infer hardware coverage from labels.
- Historical full black-box runs may hit local cofluxd doctor environmental baselines. New cases get no exemption. Obtain full green in isolated Docker/CI or prove each failure is untouched host state.

## Scope

In scope:
- Minimal server client-subscription lifecycle changes
- tests/src and necessary tests/fixtures/control-plane
- TS client tests directly tied to shared fixtures, no product behavior changes
- ci.yml or a called macOS workflow
- macOS CI/product-audit scripts
- architecture/ROADMAP
- Plans 082/086 and index

Out of scope:
- Proto wire, worker/supervisor, Router transport
- Native production admission/update/rollback/signing/notarization, Phase 6
- Full macOS UI/terminal/diff/preview, Phases 2–5
- Mobile features, iOS UI, production deployment
- Clean-user LAN/TCC, two NATs, Intel/macOS 14 hardware, Developer ID, Phases 6–7

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Atomic subscription | `node --test tests/src/native-foundation-subscribe.test.mjs` | exit 0; negative variant proves buffer necessary |
| Swift package | `swift test --package-path packages/swift-client` | exit 0 |
| macOS tests | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -disableAutomaticPackageResolution` | exit 0 |
| iOS acceptance | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | Nonenvironmental cases pass |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0, zero warnings |
| Full black-box acceptance | `pnpm -C tests test` | Isolated green; host baselines listed separately, all new cases pass |
| Release product | `node apps/macos/scripts/macos-product-audit.mjs` | Universal/version/purity/permission mechanical gates pass |
| Real Foundation acceptance | `apps/macos/scripts/test-foundation-control-interop.sh` | Login/atomic sync/reconnect/logout pass, no remnants |
| Phase 0 acceptance | `apps/macos/scripts/test-terminal-sessiond-interop.sh && apps/macos/scripts/test-webrtc-worker-interop.sh && apps/macos/scripts/test-loopback-auth-interop.sh` | exit 0 |
| Deferred TCC build gate | `node apps/macos/scripts/local-network-tcc-acceptance.mjs --build-only` | Configurations pass; no app launch/TCC claim |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] All commands pass with audited environments/skips/host baselines.
- [ ] Same-account query-window deltas neither lost nor duplicated; disconnect/overflow fail closed.
- [ ] New black-box tests fail with syncing buffer removed.
- [ ] Real macOS runner verifies generation, package/app tests, Release universal/purity.
- [ ] CI needs no personal signing secrets and does not run/fabricate deferred LAN/release acceptance.
- [ ] iOS/web-related tests and Phase 0 probes do not regress; no mobile/daemon/proto-wire feature changes.
- [ ] Plan 082 Phase 1/index DONE; Phase 2 needs its own plan; overall product remains IN PROGRESS.
- [ ] Docs distinguish development, CI, Development signing, and release GO.

## STOP conditions

- Atomic subscription requires revisions/proto/model rewrite; create a separate protocol plan first.
- Buffer cannot be bounded or fail closed through disconnect/resubscribe.
- Mechanical macOS CI evidence requires personal/Developer ID credentials or GUI TCC.
- Foundation needs weakening/deleting 083 probes, or new black-box cases fail twice after one reasonable fix.
- Scope expands to worker/supervisor/mobile/production or Phases 2–7 features.

## Maintenance notes

- Reassess buffering if revisioned snapshots arrive; until wire changes it is a correctness boundary.
- Audit runner/toolchain upgrades explicitly rather than treating latest drift as cache updates.
- Phase 1 proves a reliable skeleton/control plane only. Full web functionality/UI/interaction reproduction still requires Phases 2–5 and detailed Phases 6–7 acceptance.
