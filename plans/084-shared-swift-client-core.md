# Plan 084: One shared Swift client core, modular protocols, control-plane contracts, and regression-free iOS migration

> This plan is an outcome contract, not a step-by-step script. Understand requirements and decisions, then implement against live code. Run quick validation and commit after each milestone; stop on any STOP condition. Update this plan and `plans/README.md` when complete.
>
> Drift check: `git diff --stat 5942465..HEAD -- proto/buf.gen.yaml proto/gen/swift/ packages/swift-client/ apps/ios/Coflux/ apps/ios/CofluxTests/ apps/ios/Coflux.xcodeproj/ docs/ROADMAP.md`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: `plans/083-macos-native-client-feasibility-gates.md`
- Category: refactor
- Execution: self-execution (continues plan 082 departure check)
- Planned at: `5942465`, 2026-08-25
- Outcome: DONE (`a402d90` / `0923ddd` / `00e5c7a`)

### Execution results (2026-08-26)

- M1: a402d90 establishes the single packages/swift-client boundary and CofluxProtocol/CofluxClientCore/CofluxApplePlatform products. Swift protobuf generates only into CofluxProtocol/Generated; SwiftProtobuf is pinned exactly to 1.38.1.
- M2: 0923ddd migrates the single control plane and relay Router, implementing/testing initial-handshake reconnect, generation isolation, serialized control frames, ten-second outbound watchdog, three-dimensional state, snapshot replacement/incremental/cascade cleanup, visible TokenStore errors, and fail-closed terminal auth. Final package passes 41 Swift Testing cases and three XCTest cases.
- M3–4: 00e5c7a moves iOS App/Test to the repo-local package, deleting old in-app Client/Router/Wire/Transport/Keychain and duplicate reducer/router/auth tests. App preserves dev.coflux.Coflux / clientToken namespaces and explicit buildID=dev. It shows synchronization before first snapshot and retains existing snapshots while reconnecting. Hosted XCTest injects an empty TokenStore through TestAction-only environment, preventing app startup from reading/using/deleting production tokens. Keychain roundtrips use random service/account.
- Acceptance: Buf lint/generate without drift; package 44/44; Rust protocol 26/26; generic iOS simulator build; full iOS tests five pass and two existing environmental probes contractually skipped. Core platform-import, old implementation/ProtoGen/direct SwiftProtobuf, scope, and diff-hygiene scans pass. Two independent reviews found and closed redundant Protocol test-target dependency and hosted-test production-Keychain contamination; final verdicts both APPROVE.
- No mobile/server/worker/web/production changes. LAN/TCC, Intel, real macOS 14 hardware, and Developer ID remain plan 082 Phase 6–7 release-qualification gates; these results do not claim those gates passed.

## Requirement

Create the single repo-local Swift package consumed by iOS/macOS, ending direct compilation/copying of Swift protobuf and state machines in app targets. Outcomes:

- One Swift protobuf generation/compilation source of truth.
- One Swift implementation of auth, connections/reconnect, control reducer, and current relay DeviceRouter.
- iOS consumes public modules without UI/terminal/upload/device-panel regressions.
- Small injected interfaces separate platform WebSocket, Keychain, Bundle/config, and UI lifecycle; core compiles for macOS 14.
- Foundation fixes initial-handshake no-retry, unordered control sends, silent Keychain errors, and treating no snapshot as an empty account.

Incorrect alternatives: another macOS CofluxClient copy; package imports of SwiftUI/UIKit/AppKit/SwiftTerm/WebRTC; continued implicit buildID=dev; iOS 26 NetworkConnection<WebSocket> in macOS 14 core; freezing today's relay-only Router as Phase 1's future direct/P2P public contract.

## Decisions & tradeoffs

- **Physical boundary is packages/swift-client**, with CofluxProtocol, CofluxClientCore, CofluxApplePlatform products. Rejected: adding identical source paths to both Xcode projects leaves no independent API/module boundary and permits settings/dependency drift. Evidence: iOS CofluxClient.swift:1-37, macOS project.yml:47-58.
- **Move Swift protobuf into CofluxProtocol/Generated; Buf clean:true cleans only that dedicated folder.** Never put Package.swift/handwritten core in generated output or regeneration deletes them. App/Test cannot keep compiling proto/gen/swift directly, creating duplicate module truth. Evidence: proto/buf.gen.yaml:1-13.
- **Core depends only on Foundation, Observation, and CofluxProtocol.** Exclude SwiftTerm, Opus, WebRTC, Security, Network, and UI frameworks. Rejected: concrete defaults for convenience; current NetworkTransport uses iOS 26 APIs unavailable to macOS 14. Evidence: iOS Transport.swift:20-29, macOS project.yml:5-6.
- **Move DeviceRouter with core, keeping package/internal visibility.** CofluxClient uses it for iOS; macOS Foundation consumes only read-only control state. Rejected: leaving Router in iOS reverses dependencies; exposing direct/P2P now freezes a relay-only subset certain to change. Evidence: DeviceRouter.swift:44-54.
- **Explicit injection contracts**: ClientConfiguration, Transport/TransportConnection, TokenStore, ClientLogger, clock/jitter source, and build identity. Core never reads Bundle.main, environment, Security, real random/clock services, or platform logging. Sends serialize; receive permits one waiter; close is idempotent. Rejected: current defaults bind package to iOS composition. Evidence: CofluxClient.swift:97-105, KeychainTokenStore.swift:9-14.
- **Expose connection/auth/sync separately.** Before first StateSnapshot show loading, never an empty account. Authenticated disconnect retains last snapshot and shows offline. Resubscription snapshots replace old collections and increment revision. Existing status/authState names may remain for migration but cannot substitute for sync state. Rejected: treating AuthOk's empty arrays as final data causes false cold-start emptiness. Evidence: TS client store.ts:423-449, Swift CofluxClient.swift:323-331.
- **Align auth/retry with web security boundaries.** Existing-token disconnection before first auth still backs off/retries; AuthError clears token/stops retry; ClientOutdated retains token/stops retry; subscribe after AuthOk; long silence after outbound marks socket dead; old generations cannot mutate new connections. Rejected: moving files unchanged retains initial shouldRetry=false and permanent first-handshake failure. Evidence: CofluxClient.swift:72-75,138-142,270-279; TS connection.ts:90-112.
- **One ordered control-send queue, not a raw Task per frame.** Executor scheduling that is usually ordered cannot guarantee protocol causality for auth/subscribe/logout/operations. Evidence: CofluxClient.swift:566-568, DeviceRouter.swift:800-813.
- **Observable TokenStore errors and explicit service/account.** Never persist passwords; write only new tokens from AuthOk. Token-auth AuthOk without a new token retains the old one. Rejected: swallowed Security OSStatus falsely reports success while login disappears on restart. Evidence: KeychainTokenStore.swift:24-49, server hub.ts:1755-1777.
- **App injects build ID; core has no default.** Debug and current compatible iOS composition may explicitly pass dev until independent native admission exists. Plan 085 macOS Release must provide nonempty/non-dev identity; Phase 6 migrates iOS and adds native admission/update messaging. Rejected: implicit core-wide dev bypass makes production macOS identity unauditable. Evidence: CofluxClient.swift:65-67,573; hub.ts:1793-1807.
- **Freeze only consumed facade/state/actions and injection protocols.** Wire, apply, raw callbacks, and Router structure stay internal/package. iOS explicitly imports CofluxProtocol/CofluxClientCore, without @_exported import. Rejected: exposing implementation merely to reduce import edits turns Phase 2 refactors into breaking public-API migrations.

## Direction

### Milestone 1: Reproducible Swift package and protocol truth

Independently resolve/build for macOS 14+/iOS 26+. Pin SwiftProtobuf exactly and retain auditable Buf plugin pin. Four generated files exist only in CofluxProtocol/Generated; no TS/Rust wire drift.
Validation: swift test --package-path packages/swift-client exits 0; cd proto && buf lint && buf generate exits 0 without second-generation drift.

### Milestone 2: Shared control plane and relay Router

Fake core tests cover auth, failed initial handshake reconnect, backoff/generation/watchdog, serialized sends, sync state, full snapshot replacement, daemon/project/workspace/task upserts and cascades, ports/checkpoints/sessionAgents, malformed embedded messages, TokenStore failure, and logout. Move deterministic relay Router tests into package with unchanged behavior.
Validation: all package core/router tests pass.

### Milestone 3: Apple adapters and sole iOS consumption

Inject iOS concrete Network transport and Keychain/config through CofluxApplePlatform/app root. App/tests no longer compile old Client or Swift protobuf directly. UI consumes public modules; scene lifecycle maps to neutral suspend/resume. Signed-host Keychain roundtrip uses random service/account, never real tokens.
Validation: generic iOS Simulator xcodebuild exits 0.

### Milestone 4: iOS regression and boundary audit

All existing nonenvironmental iOS tests pass; environment/audio probes may skip only under their existing contracts. Core has no UI/terminal/WebRTC imports. No mobile/server/worker/web/production changes.
Validation: full iOS Simulator tests and forbidden-import scan pass.

## Landmines

- iOS uses filesystem-synchronized groups. Moving generated files also requires removing ProtoGen membership and direct SwiftProtobuf product to prevent duplicate type compilation: project.pbxproj:31-45,93-102.
- Swift 6 concurrency cannot merely inherit iOS Approachable Concurrency settings. Standalone macOS package builds need evidence for @MainActor, @unchecked Sendable, and single-consumer assumptions: project.pbxproj:269-272, DeviceRouter.swift:88-100.
- ProjectCreated/WorkspaceCreated are upserts, reused for rename/default-branch/diff deltas, not append-only: hub.ts:1158-1185,1645-1658.
- Project deletion must not remove directory workspaces with projectID=="". Missing embedded protobuf messages must drop the frame rather than create default empty objects.
- Buf cleans output; STOP if handwritten files share it.
- Keychain tests false-fail with CODE_SIGNING_ALLOWED=NO; accept only in a signed app host.
- Passing package tests does not prove UI builds; every protobuf consumer needs explicit import after leaving the app module.

## Scope

In scope:
- packages/swift-client/**
- proto/buf.gen.yaml and proto/gen/swift/**
- iOS Client/** and other Coflux/**/*.swift needed for imports/composition
- iOS CofluxTests/** and Coflux.xcodeproj/**
- Minimal ROADMAP correction: development GO permits Foundation; release matrix remains deferred
- This plan and index

Out of scope:
- macOS product Foundation, plan 085
- Server subscription-window atomicity, plan 086
- direct/loopback/P2P, pair/grant/lease, public Router API, Phase 2
- Native release allowlist/update URLs/minimum-version governance, Phase 6
- New iOS UI features or mobile/web/daemon feature changes
- LAN/TCC, Intel, real macOS 14 hardware, Developer ID acceptance, Phases 6–7

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Package tests | `swift test --package-path packages/swift-client` | exit 0, all core/router cases |
| Proto lint/generate | `cd proto && buf lint && buf generate` | No TS/Rust wire drift; Swift only in new Generated folder |
| iOS build | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator'` | exit 0 |
| iOS acceptance | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | Nonenvironmental cases pass; probes skip only per contract |
| Core boundary | `rg -n 'import (UIKit|SwiftUI|AppKit|SwiftTerm|WebRTC|Security|Network)' packages/swift-client/Sources/CofluxClientCore` | No output |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0, no warnings |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [x] All listed commands pass.
- [x] iOS consumes one package's protocol/core products; package compiles targeting macOS 14. Actual macOS app consumption is accepted in 085.
- [x] No platform defaults, fixed dev identity, unordered sends, or unsynchronized empty state in core.
- [x] Existing-token initial handshake failure retries; auth error/outdated/logout token/retry behavior has negative tests.
- [x] Reducer covers full snapshots and Phase 1 deltas/cascades; malformed inputs fail closed.
- [x] Existing iOS tests, terminals, upload, device panel, and background recovery do not regress.
- [x] No mobile/server/worker/web/production changes.
- [x] ROADMAP no longer incorrectly blocks Foundation on external LAN/release matrix and does not claim deferred gates passed.
- [x] Index updated.

## STOP conditions

- Package requires UI/SwiftTerm/WebRTC imports or exposes iOS 26 Network APIs to macOS 14 core.
- iOS migration requires exposing Router internals or wire changes.
- Buf migration changes TS/Rust wire format rather than only Swift output path.
- Existing iOS business tests fail twice after one reasonable fix, or only pass by deletion/weakening.
- Completion requires mobile/server/worker/web features or Phase 2 transport.

## Maintenance notes

- Shared package means one implementation, not identical iOS/macOS UI/lifecycle.
- New control messages need reducer fixtures/tests; new platform imports should first be considered for adapters.
- Phase 2 may refactor Router internals but never copy another Swift Router. Reopen Swift-versus-Rust-core decisions if Windows/Linux becomes a target.
