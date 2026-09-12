# Plan 044: First iOS slice—project skeleton, Swift client layer, and working login

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat d73c74f..HEAD -- packages/client/src/connection.ts packages/client/src/store.ts apps/mobile/src/lib/auth.ts apps/server/src/hub.ts proto/coflux/v1/client.proto proto/buf.gen.yaml proto/gen/swift`

## Status

- Priority: P1
- Effort: L
- Risk: MED (first iOS project: manually creating xcodeproj, first use of generated Swift artifacts, new WS API)
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `d73c74f`, 2026-07-25

## Requirement

Build the first native iOS slice, with the same Agent command-center positioning as Web:

1. A buildable native Swift project under `apps/ios/`, committing `Coflux.xcodeproj` directly.
2. A Swift **control-plane layer** connecting `/client` WS, authenticating through Supabase token exchange, username/password, or clientToken reconnect, and reducing stateSnapshot/entity increments into observable state.
3. Simulator login to local dev server and a project-grouped workspace/device/task list. This is a simple verification UI, not final visual design.

Later slices cover SwiftTerm rendering/interaction, PTY direct/relay/attach/takeover/checkpoint, diff, push, and App Store/TestFlight.

Do not translate packages/client line by line, including its PTY domain. Port only the control subset while strictly preserving TS reducer semantics: atomic commits, arrival order, subscribe after authOk, and token lifecycle.

**Environment prerequisite, performed by the user**: install current App Store Xcode on macOS 27 with support for the user's iOS 27 phone. Run `sudo xcode-select -s /Applications/Xcode.app`, accept the first-launch license, and download iOS platform/simulator runtime. At this baseline xcodebuild points to CommandLineTools and Xcode is absent. STOP if this prerequisite remains unmet.

## Decisions & tradeoffs

- **Native Swift 6.2, SwiftUI, vanilla @Observable**, initially retaining Xcode 26 MainActor default isolation and approachable concurrency. **Execution departure, 2026-07-25**: SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor isolates generated pb.swift types and breaks Sendable/Message conformance because generated code lacks nonisolated. Omit that setting and mark app code @MainActor explicitly; keep approachable concurrency. A separate nonisolated proto target was rejected for structural cost. TCA adds unrewarded solo-project learning cost; WKWebView contradicts the experience-upgrade motivation. See the three-way research finalized 2026-07-25 and docs/ROADMAP.md:65-70's original macOS research/update.
- **iOS 26, iPhone-only.** It runs on the user's iOS 27 phone without needing 27-only APIs and builds with Xcode 26/27. No second device justifies iOS 17/18 support; targeting 27 only raises toolchain requirements without benefit.
- **One app target and unit-test target; commit xcodeproj using filesystem-synchronized groups/buildable folders.** Defer local SPM extraction to slice two; packages would need explicit MainActor-default and approachable-concurrency flags, not inherited defaults. Reject Tuist/XcodeGen: buildable folders already reduce pbxproj conflicts, so tooling adds needless solo-project complexity. Handwrite synchronized-group pbxproj; after two unsuccessful repairs, STOP and fall back to a user-created GUI template.
- **Only apple/swift-protobuf dependency**, runtime ≥1.37.0 matching generated output. Reference proto/gen/swift/coflux/v1/*.pb.swift through a buildable folder; **never copy or edit**. CI enforces zero generation diff at .github/workflows/ci.yml:51; proto/buf.gen.yaml uses Visibility=Public. Copying detaches from truth.
- **No supabase-swift.** URLSession POST to `${SUPABASE_URL}/auth/v1/token?grant_type=password`, following apps/mobile/src/lib/auth.ts:7-24, obtains access_token for WS clientAuth.supabaseToken exchange. Do not persist/refresh Supabase sessions under this ticket-exchange architecture (client.proto:13). A whole auth package/session manager is unjustified for one POST.
- **Network.framework WebSocket behind actor/AsyncStream.** Prefer iOS 26 NetworkConnection structured concurrency; fall back to NWConnection+NWProtocolWebSocketMetadata if documentation/behavior blocks it. Reducer remains unaware. Reject URLSessionWebSocketTask for unreliable close codes (~5–7% becoming 1006) and absent backpressure; Apple DTS recommends Network.framework for serious persistent connections. Starscream targets legacy iOS 12 compatibility.
- **Port control-plane subset only**: all connection.ts and entity reducer branches. Include three credential forms (connection.ts:31-37), exponential backoff ~1s to ~15s with jitter/reset on auth (56-68), authOk/authError/clientOutdated/stateSnapshot/daemonUpdated/daemonRemoved/projectCreated/projectRemoved/workspaceCreated/workspaceRemoved/taskUpdated/taskRemoved/error, and immediate clientSubscribe after authOk (store.ts:337). Exclude all device-router, localSessions/catalog, sessionCheckpoint, ports, inputStates, pendingTaskRemovals. With no PTY domain, stateSnapshot/taskUpdated directly use server facts; localSessions merging at store.ts:376-384 is intentionally absent.
- **Report clientVersion="dev".** Production admission bootstraps allowed Web/mobile dist IDs (hub.ts:1397-1409), rejecting unknown native IDs with clientOutdated (:1476-1485). dev is the only unconditional allowance (:1464). Web reload semantics do not apply to native. Defer formal minimum-version/upgrade policy; defensively show incompatible-version error and stop reconnecting **without clearing token**.
- **Match TS token lifecycle**: persist returned clientToken on authOk and use it for reconnect (store.ts:333-336); authError clears token, stops retry, and returns login (:341-351); logout clears/disconnects. Use a small ~50-line Security Keychain wrapper with kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly. A single token does not justify KeychainAccess/Valet; UserDefaults is unsuitable for plaintext credentials.
- **Background lifecycle**: scenePhase.background disconnects and cancels retries; active discards the old connection and rebuilds unconditionally, without waiting for potentially minute-long system liveness timeout. Server/daemon sessiond/snapshot own resilience; iOS background WS survival is not guaranteed.
- **Compile-time server/Supabase config**: production defaults wss://api.coflux.dev/client. Debug can use scheme env or Debug-only setting for local server, chosen by executor. Production Supabase URL/anon key are deployment-injected, absent from repo; leave named placeholders for user device acceptance. Anon key is not secret and may be committed. Local COFLUX_DEV=1 username/password needs no Supabase values.
- **Dual login mode matches Web**, decided while planning. Deployment selects Supabase/local among three exclusive hub.ts:1429-1446 paths; client cannot discover it. Compile-time configuration chooses email/password ticket exchange in production or direct username/password locally.
- **Swift Testing** covers reducer synthesized-protobuf→state assertions and auth/token state machine through injected fake transport. New tests use Swift Testing rather than XCTest; temporary verification UI does not justify UI testing.

## Direction

Match packages/client layering: WS/backoff actor → @Observable reducer with atomic arrival-ordered commits and no reorder buffer (store.ts:320-322) → SwiftUI subscriptions. Envelope encode/decode maps encodeClientToServer/decodeServerToClient and oneof payload at client.proto:115-249.

### Milestone 1: Buildable skeleton

Create apps/ios/Coflux.xcodeproj with empty app/test targets; resolve swift-protobuf and compile referenced proto/gen/swift.
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` exits 0.

### Milestone 2: Client and unit tests

Complete transport, auth/token, Keychain, and reducer; test authError clear/stop, authOk persistence, clientOutdated, and state transitions.
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<available iPhone selected from xcrun simctl list>' test` exits 0.

### Milestone 3: Login and verification list

Compile-time login form → project-grouped workspaces/device online/task states; connecting/disconnected banner retains last snapshot like Web (store.ts:517-519). Wire scenePhase reconnect.
Validation: build/test commands pass; actual login is acceptance.

## Landmines

- Xcode is absent at baseline; xcodebuild points to /Library/Developer/CommandLineTools. Unmet prerequisite is a user action, not an executor repair.
- Non-dev native version is rejected only in production; local dev without COFLUX_BUILD_ID* can hide this issue (hub.ts:1459-1486).
- Invalid-token retry causes a credential storm. Preserve both shouldRetry=false and reconnectCredential returning null after authError.
- Cancel the old socket before replacing it (connection.ts:75-77), or server retains a ghost connection that only receives.
- Embedded-message presence is explicit: TS T|undefined corresponds to Swift hasXxx. Drop malformed entries missing required fields; neither crash nor invent defaults (store.ts:399).
- Increment snapshotRevision on every stateSnapshot (store.ts:392); slice two needs that reconnect boundary for reattach.
- Generated Swift is CI-checked; missing types require out-of-scope proto changes: STOP and report.
- Simulator Keychain differs from devices: no Secure Enclave and looser entitlements. Keep simple kSecClassGenericPassword; no access groups/synchronization.

## Scope

In scope:
- New apps/ios/**
- plans/README.md status

Out of scope:
- apps/server, apps/web, apps/mobile, packages/*, crates/*; especially no server iOS build-ID channel
- proto/**, source and generated files; report type gaps
- Terminal/PTY/SwiftTerm/Router/attach/takeover, deferred to slice two
- Device DEVELOPMENT_TEAM: user selects automatic signing for acceptance; do not commit team constant

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Unit tests | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<available iPhone simulator>' test` | exit 0 |
| Simulator login acceptance | Local pnpm dev:server with DATABASE_URL at historical 54322 direct port; simulator Debug ws://127.0.0.1:8787/client; username/password | Login and live workspace/device/task updates |
| Physical-device production acceptance | User supplies Supabase constants, runs Xcode on device, email/password login at api.coflux.dev | Production entities visible; background/foreground reconnect |

## Done criteria

- [ ] Build and unit-test commands both exit 0.
- [ ] Simulator acceptance completes login → entity lists → disconnect banner after stopping the server → automatic reconnection and recovery after restarting the server.
- [ ] Swift Testing cases for the reducer and authentication state machine exist and assert meaningful behavior, rather than empty runs.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Xcode 26+ absent or xcodebuild -version fails.
- Cited facts changed or out-of-scope proto/server changes required.
- Handwritten pbxproj still fails after two repairs; user creates empty GUI template.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- dev version is a deliberate temporary ceiling. Native needs minimum-version forced-upgrade messaging, not Web reload; plan after distribution/TestFlight settles.
- PTY slots intentionally absent. Slice two follows packages/client/src/store.ts semantics, not improvised structure.
- Update named production Supabase placeholders on project/key rotation.
- Future SPM extraction needs explicit MainActor-default/approachable-concurrency flags; Xcode 26 defaults only app targets.

### Original source references

`proto/coflux/v1/client.proto:13`, `connection.ts:56-68`, `apps/server/src/hub.ts:1397-1409`, `hub.ts:1476-1485`, `hub.ts:1464`, `store.ts:341-351`, `proto/coflux/v1/client.proto:115-249`, `apps/server/src/hub.ts:1459-1486`, `packages/client/src/store.ts:341-351`, `packages/client/src/connection.ts:75-77`.
