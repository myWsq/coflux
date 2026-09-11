# Plan 085: Native macOS Foundation app with real login, persistent sessions, and a basic read-only workbench

> This plan is an outcome contract, not a step-by-step script. Confirm plan 084's public module contract is complete, then design macOS adapters and native UI against live code. The self-executor validates and commits each milestone. Stop on any STOP condition; update this plan and `plans/README.md` when complete.
>
> Drift check: `git diff --stat 5942465..HEAD -- packages/swift-client/ apps/macos/ docs/design-guidelines.md plans/084-shared-swift-client-core.md`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: `plans/084-shared-swift-client-core.md`
- Category: feature
- Execution: self-execution (continues plan 082 departure check)
- Planned at: `5942465`, 2026-08-25

## Requirement

Turn apps/macos/Coflux.app from a twenty-line probe shell into an extensible native-client Foundation: connect to a configured server, sign in with account/password, securely persist session tokens, authenticate on restart, receive snapshots/deltas, and show basic device/project/workspace state plus loading/offline/auth error/outdated in native macOS UI.

This is not full workbench parity, but must be production architecture's first piece. No hardcoded demo, WebView, JS runtime, app data from test mocks, or copied core. Remove Coflux Native Probe copy and placeholder UI.

## Decisions & tradeoffs

- **Compose only plan 084's CofluxProtocol, CofluxClientCore, CofluxApplePlatform.** Rejected: copied reducer/transport contracts in apps/macos create a third implementation. Evidence: CofluxApp.swift:1-20.
- **Use async URLSessionWebSocketTask on macOS 14**, binary-only, one receive waiter, ordered sends, idempotent close. Never copy probe semaphore/blocking helpers. Rejected: iOS 26 NetworkConnection<WebSocket> is deployment-incompatible. Evidence: iOS Transport.swift:20-29, NativeLoopbackAuthProbe.swift:201-221.
- **Keychain uses explicit stable app-specific service/account and structured errors.** Tests use random namespaces and never real Coflux tokens. Rejected: implicit Bundle.main service differs across package/test/app hosts. Evidence: iOS KeychainTokenStore.swift:9-14.
- **Composition root injects server URL, build identity, logger, transport, token store.** Debug may use COFLUX_SERVER_URL for isolated dev or product default if absent. Release identity comes from CFBundleShortVersionString/CFBundleVersion and must be nonempty/non-dev. Production allowlist remains Phase 6. Rejected: reading environment/Bundle in core or views breaks test/module boundaries.
- **SwiftUI-first native UI**, matching web's hierarchy while following macOS interaction: separate login/update/error states, resizable authenticated sidebar, clear device/project/workspace hierarchy and online status, loading before snapshot, retained state plus offline banner. Rejected: enlarged iOS views or embedded web pages. Evidence: web sidebar.tsx and iOS RootView.swift.
- **Foundation UI is read-only**, without early task/terminal/diff actions. Core may retain iOS relay Router, but macOS exposes no unfinished attach/direct/P2P controls. Rejected: fake buttons or relay-only terminals to appear complete would misrepresent parity.
- **Production app directly links neither SwiftTerm nor WebRTC.** Phase 0 probes retain pinned dependencies in test targets and scripts. Rejected: embedding 44 MB WebRTC merely for hosted-test convenience. Evidence: project.yml:27-58.
- **Enable Hardened Runtime and explicit Foundation Sandbox entitlements with only network.client.** Do not pregrant network.server/path exceptions. Existing WebRTC sandbox scripts may explicitly override test configuration; Phase 2 reviews final P2P entitlements. Rejected: carrying ENABLE_APP_SANDBOX:NO into product or pregranting future permissions. Evidence: project.yml:43-45, WEBRTC_PROBE.md:60-74.
- **Narrow ClientLogger→OSLog adapter**, stable subsystem/category, recording only state/generation/route/duration/redacted IDs. Never log tokens, passwords, private keys, protobuf payloads, or terminal contents. Remote telemetry remains Phase 6.
- **XcodeGen project.yml is authoritative**; commit generated pbxproj without drift. Keep exact package pins and Phase 0 TCC targets/docs/scripts. Rejected: manual pbxproj edits disappear on generation.

## Direction

### Milestone 1: macOS 14 adapters and secure persistence

CofluxApplePlatform provides URLSession WebSocket, explicit Keychain, Bundle identity, and OSLog adapters usable on macOS 14. Fake/host tests cover binary-only transport, Origin/request construction, one receive, ordered sends, close, Keychain add/update/read/delete/error, and log redaction.
Validation: package and macOS adapter tests exit 0.

### Milestone 2: Real composition and state UI

Use the same shared client for login/authenticating/outdated/loading/offline/hierarchy/error. Windows reopen normally; quit/restart restores tokens correctly. No probe copy, fake data, WebView, or unimplemented actions.
Validation: xcodebuild test for Coflux on platform=macOS exits 0.

### Milestone 3: Project, permissions, versions, and product purity

App has explicit marketing/build versions, Hardened Runtime, minimal Sandbox entitlements. Generic Release produces universal main Mach-O without WebRTC in product. Existing SwiftTerm/WebRTC/loopback/TCC probes still independently build/run; Foundation must not remove risk gates.
Validation: XcodeGen regeneration yields no diff; Release audit passes.

### Milestone 4: Real isolated-stack acceptance

Automation starts isolated server and uses temporary account/token/Keychain namespace for password login, AuthOk persistence, snapshots/deltas, offline retention, reconnect convergence, and logout revocation. Real-server flow explicitly uses dev Debug composition because independent native Release admission awaits Phase 6. Fake transport captures Release's first auth frame, and product audit checks Bundle fields. Clean processes/databases/Keychain without touching real users.
Validation: quick tests stay green; real-process checks run only at final acceptance.

## Landmines

- Swift protobuf currently belongs only to macOS test target; app cannot decode control messages (project.yml:47-58).
- Hosted-test dependencies may embed SwiftTerm/WebRTC in app. Inspect the actual Release artifact after removing direct app dependencies, not just project graph.
- Scripts hardcode scheme Coflux, CofluxTests paths, and Coflux.app. Target/scheme changes must update webrtc-worker-interop.mjs, loopback-auth-interop.mjs, macos-signing-audit.mjs rather than silently disabling gates.
- Sandbox network.client supports outbound control/relay but not UDP WebRTC. Real P2P probes need existing explicit configurations; expected entitlement denial is not regression.
- Debug active architecture is not universal evidence. Build generic Release with ONLY_ACTIVE_ARCH=NO and run lipo -archs on main Mach-O.
- Unsigned/ad-hoc CI is neither Apple Development nor Developer ID. Record only actual local Development evidence here; release signing remains later.
- No snapshot and an empty snapshot must look different; offline retains state.
- Keychain acceptance requires signed host, random namespace, and zero remnants afterward.

## Scope

In scope:
- packages/swift-client/Sources/CofluxApplePlatform and tests
- apps/macos/Coflux and CofluxTests
- project.yml, generated Coflux.xcodeproj, workspace resolved pins
- Script/probe-target changes necessary to preserve Phase 0
- This plan and index

Out of scope:
- Server subscription atomicity/CI, plan 086
- direct/P2P/loopback Router, terminal/task actions, full workbench, diff/preview, Phases 2–5
- Developer ID, DMG, notarization, Sparkle, production native allowlist, Phase 6
- Clean-user LAN/TCC, two NATs, Intel/real macOS 14 release matrix, Phases 6–7
- iOS UI, mobile, web/daemon features

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Package regression | `swift test --package-path packages/swift-client` | exit 0 |
| XcodeGen truth | `xcodegen generate -s apps/macos/project.yml -p apps/macos && git diff --exit-code -- apps/macos/Coflux.xcodeproj` | exit 0 after committing |
| macOS tests | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -disableAutomaticPackageResolution` | exit 0 |
| Real Foundation acceptance | `apps/macos/scripts/test-foundation-control-interop.sh` | Login/persistence/snapshot/deltas/reconnect/logout pass; zero remnants |
| Release audit | `node apps/macos/scripts/macos-product-audit.mjs` | arm64+x86_64, nonempty version, hardened/minimal entitlements, no WebRTC |
| Phase 0 terminal acceptance | `apps/macos/scripts/test-terminal-sessiond-interop.sh` | exit 0 |
| Phase 0 WebRTC acceptance | `apps/macos/scripts/test-webrtc-worker-interop.sh` | exit 0 |
| Phase 0 auth acceptance | `apps/macos/scripts/test-loopback-auth-interop.sh` | exit 0 |
| TCC build-only | `node apps/macos/scripts/local-network-tcc-acceptance.mjs --build-only` | Both unlaunched app configurations pass; no TCC claim |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] All commands pass; environmental acceptance records isolation/cleanup.
- [ ] Real app logs in, persists/deletes tokens, restores on restart, receives snapshots/deltas, and converges after offline reconnect.
- [ ] UI distinguishes need-login/authenticating/outdated/loading/synced/offline/error, with entities from real core.
- [ ] No WebView/JS runtime, copied core, probe shell, or fake actions in product source.
- [ ] Universal Release main Mach-O, nonempty/non-dev identity, no bundled WebRTC.
- [ ] Minimal permissions/redacted logging; real user Keychain untouched.
- [ ] Phase 0/TCC build-only paths remain; no false LAN/TCC completion.
- [ ] Index updated.

## STOP conditions

- Control connection requires raising macOS 14 target or using iOS 26 APIs.
- Inadequate public contract requires copied/forked reducer/Router in macOS.
- Login needs path exceptions, globally relaxed ATS, or excessive network entitlements.
- Project refactor breaks Phase 0 probes despite one reasonable fix.
- Real-stack tests touch existing user tokens/database/daemon/services or cannot clean reliably.
- Completion requires early Phase 2 transport, Phase 3 UI, or Phase 6 release systems.

## Maintenance notes

- Foundation UI is a skeleton for future comparison, not full parity; never claim web has been reproduced.
- Audit product purity after every app dependency addition to prevent test/probe frameworks leaking into release artifacts.
- Before Phase 6, run LAN/TCC only with build-only. Actual prompts need plan 083 clean-user/controlled-peer conditions.
