# Plan 082: Native macOS client program—replace the Web desktop with a functionally equivalent native workbench

> This is the macOS program's **overall outcome contract and decision record**, not a one-shot execution script or work for a single execution session. Each Roadmap phase requires a separate, narrowly scoped execution plan; plan 083 is the first executable gate. Understand requirements, decisions, and risk boundaries, then design each phase against live code. Stop on any STOP condition. Update `plans/README.md` after phases; do not mark this overall plan DONE directly.
>
> Drift check: `git diff --stat 8d702d2..HEAD -- apps/web/src/components/workbench/ packages/client/src/ apps/ios/ proto/ crates/worker/src/p2p.rs apps/server/src/local-control.ts docs/architecture.md docs/ROADMAP.md docs/RELEASING.md .github/workflows/`

## Status

- Priority: P1
- Effort: L (program-level, estimated 22–30 engineering weeks, not one execution card)
- Risk: HIGH
- Depends on: none
- Category: refactor
- Planned at: `8d702d2`, 2026-08-25
- Review state: user reviewed and authorized the overall implementation on 2026-08-25. Execute phases through individual plans. Local dependency installation and Web/native comparative acceptance are authorized; pushing, production release, and real signing credentials require separate authorization.

## Requirement

Turn the current apps/web desktop workbench into a genuine native macOS client: no Electron, Tauri, WKWebView, Catalyst, other web-main-UI shell, or bundled JS runtime. Mac users perform project, workspace, device, terminal, Git/diff, and file operations in the native app. Inherently web-based port previews and device authorization may use the default system browser.

Final product:

1. Native macOS is the default Mac workbench, covering current apps/web desktop capabilities.
2. Keep apps/web for authorization, port preview, cross-platform access, and failure fallback; native migration neither deletes nor freezes it.
3. macOS/iOS share Swift client core—auth, control plane, protocol, DeviceRouter—but have independent UIs. Do not enlarge iOS UI or use Catalyst.
4. Terminal, DeviceRouter, and version admission meet production behavior contracts with automated cross-implementation evidence, not merely demo connectivity.
5. Distribute a Developer ID-signed, notarized, updatable app with safe fallback to Web.

### Meaning of replication

- **Functional equivalence**: user goals, state semantics, error boundaries, and security constraints match Web. Mandatory.
- **Strong visual consistency**: retain Coflux colors, typography roles, density, and information hierarchy. Mandatory.
- **Native macOS interaction**: menus, shortcuts, drag/drop, clipboard, windows, focus, and accessibility follow macOS conventions; controls need not look like browser controls.
- **No frame-by-frame pixel identity**: CoreText/SwiftTerm and DOM/xterm.js necessarily differ in font rasterization, scrollbars, selection, and IME. A future pixel-identical requirement must reopen the no-WebView premise.
- **Terminal semantic equivalence**: the same recording, snapshot, and tail recover matching key buffers/cells/modes. Visual resemblance is not contract verification.

The correct solution is **native UI, native terminal, and Swift client core**, replacing the desktop workbench's functions/design language. Embedding Web, shipping relay-only terminals or only project lists, or removing browser authorization/preview for the sake of native purity does not meet the requirement.

## Research baseline and feasibility

### Conclusion

Plan 083 produced local architecture evidence: SwiftTerm snapshot fidelity, native libwebrtc↔webrtc-rs 0.20.2, and native P-256/Origin/grant/lease all passed. **Swift core plus native libwebrtc has development GO**, with no technical dead end, fork, weakened protocol, or added maintenance surface requiring CONDITIONAL GO. On 2026-08-25 the user explicitly deferred LAN validation. Two Macs on different NATs/networks, clean-user Local Network TCC Allow/Deny, physical Intel, macOS 14, and Developer ID/notarization/staple no longer block Foundation, but remain mandatory Phase 6–7 release qualifications.

Development GO is not release GO, and external matrix items must not be marked passed. No new protocol, large fork, or Rust client core was introduced, so the net 22–30-week estimate remains. TCC has two strict one-shot GUI acceptance entry points and Development-signed build-only evidence, but lacks a second controlled physical LAN peer. Fresh bundles, loopback, and outer Node relay health do not stand in for clean-user evidence or relay fallback in the same native client.

### Existing native assets

- apps/ios contains about 5,800 Swift lines including tests, beyond proof of concept. CofluxClient.swift implements login, control reduction, reconnect, and token persistence. DeviceRouter.swift implements relay session/elevated lanes, attach/snapshot/resume, holder/force takeover, input/resize ledgers, cumulative ACK replay, prepared operations, fsWrite, and device RTT.
- Swift Router explicitly remains a relay subset, lacking direct/loopback, pair/lease, fsList, fsRead, and execRun: `apps/ios/Coflux/Client/DeviceRouter.swift:44-49`.
- Swift protobuf comes from the same IDL (`proto/buf.gen.yaml:11-13`), generated at proto/gen/swift and consumed through synchronized Xcode file groups at `apps/ios/Coflux.xcodeproj/project.pbxproj:34`.
- SwiftTerm 1.15.0 is pinned in `apps/ios/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved:31-38`. It provides AppKit TerminalView, CoreText, selection/search/mouse/hyperlinks/IME/TrueColor, Sixel/iTerm/Kitty images, and optional Metal.
- Research machine on 2026-08-25: Xcode 26.6, Swift 6.3.3, macOS 27.0 arm64; local development is possible.

### Measured baseline

Actual iOS Simulator tests ran during research:

- 26 of 29 business/state-machine/Router cases passed.
- Two probes needing real dev topology or audio hardware skipped as designed.
- The only Keychain failure came from explicitly setting CODE_SIGNING_ALLOWED=NO; restoring local simulator signing and rerunning passed.

This supports reusing Swift control/relay foundations, not macOS, P2P, or snapshot compatibility claims.

### Web feature source of truth

Primary desktop surfaces:

- `apps/web/src/components/workbench/workbench.tsx`
- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/terminal-pane.tsx`
- `apps/web/src/components/workbench/changes-view.tsx`
- `apps/web/src/components/workbench/import-project-wizard.tsx`
- `packages/client/src/store.ts`
- `packages/client/src/device-router.ts`

Approximately 13,700 lines in these core files. Native migration is a rewrite, not mechanical React translation.

### Practical WebRTC path

Apple supplies no first-party WebRTC DataChannel substitute; Network.framework does not implement ICE/DTLS/SCTP. Native macOS libwebrtc distributions do exist:

- [stasel/WebRTC](https://github.com/stasel/WebRTC) released M151 XCFramework on 2026-08-07, approximately 44.6MB through SwiftPM, supporting macOS arm64/x86_64, built from official WebRTC source with a public build process.
- [livekit/webrtc-xcframework](https://github.com/livekit/webrtc-xcframework) is a maintained iOS/macOS/Catalyst alternative pinned by SwiftPM checksum.
- [Shiguredo build](https://github.com/shiguredo-webrtc-build/webrtc-build) supplies macOS arm64 but discontinued x86_64; insufficient alone for Intel launch support.

Auditable research snapshot, not a substitute for execution-time review:

| Candidate | 2026-08-25 snapshot | Supply-chain notes |
| --- | --- | --- |
| stasel/WebRTC | 151.0.0; WebRTC-M151.xcframework.zip, 44,616,338 B; checksum `64a218fad3d84a0d783321aa9a1eec58ca266ac7879123f86b0b44b703b7d8dc` | README states BSD 3-Clause plus WebRTC license; GitHub API did not identify repository license, so review license/build provenance before production |
| LiveKit WebRTC | 144.7559.14; checksum `4b0a4be4564aa05168a02f262bbbc4d6d9a552aaa1c102229ed5adf1c480b81a` | MIT repository; LiveKit-prefixed fork requiring raw DataChannel/worker interoperability verification |
| Shiguredo | macos_arm64 listed, x86_64 absent | Apache-2.0; useful source/build comparison if Intel is dropped, not the universal first choice |

Plan 083 tested stasel/WebRTC 151.0.0, wrapper revision `19aa8c1fc7120d50df987b7111f42d5024df3d54`, upstream `f20ebb8adbf4fa781830e4384c61f732bd28a217`. Audited 44,616,338-byte archive, checksum, BSD license, Info.plist, and actual arm64+x86_64 Mach-O. Debug app approximately 32,360 KiB. Native and webrtc-rs 0.20.2 exchanged production Device frames, 16KiB chunks, 29MiB uploads/downloads, relay fallback/promotion, and control-disconnect lifecycle. Representative local offer→open: 147ms. Rosetta x86_64 runtime loading proves universal loadability, not physical Intel behavior. See `apps/macos/WEBRTC_PROBE.md`.

### Release assets

Developer ID, notarytool, and GitHub secret conventions exist at `docs/RELEASING.md:24-59`, but currently serve bare daemon binaries, not completed app/DMG, Sparkle feed, native admission, or macOS app CI. The main CI gate runs ubuntu-latest (`.github/workflows/ci.yml:17`). Plan 083 audited Team ID, Hardened Runtime, and precise entitlements under Development authority; this does not replace Developer ID, notarization, staple, or clean-machine Gatekeeper evidence.

## Feature coverage matrix

| Current Web capability | Native implementation | Goal/risk |
| --- | --- | --- |
| Dense project/workspace/device sidebar, resizing, context menus, Tooltip | SwiftUI, bridging NSSplitView/NSOutlineView if density/performance requires | High confidence; no enlarged mobile navigation |
| Workspace agent state/messages, diff counts, orphan sessions | Shared Swift store/reducer and native state UI | High confidence; fill missing iOS reducer fields |
| Login/snapshot/incremental broadcasts/offline/version errors | Extract CofluxClient | Foundation exists; release builds must not report dev |
| Multiple tabs, optimistic creation, background retention, OSC titles, agent animation | SwiftUI tab state and SwiftTerm; hide rather than destroy inactive terminals | Preserve scrollback/focus |
| Attach/holder/force takeover/recovery | Shared Swift DeviceRouter | Relay exists; contract-test Web semantics |
| Links, IME, selection, search, mouse, image protocols | AppKit SwiftTerm TerminalView | Feasible; snapshot/edge escapes are high risk |
| Compressed image paste, file drag/drop | NSPasteboard, drag/drop APIs, ImageIO/NSImage, fsWrite | Preserve 3.5MB image budget and 30MB file cap |
| Direct/P2P/relay racing, promotion, RTT | Loopback WS, libwebrtc DataChannel, relay | Feasible; highest engineering risk |
| Project import with device selection/remote browsing | Swift fsList/fsRead and native wizard | Protocol/daemon exist; medium effort |
| Branch listing/creation/switching/worktree | Prepared operations/Device RPC | Preserve optimism and rollback |
| Git/untracked/unified diff/syntax highlighting | Swift RPC and virtualized TextKit 2/AppKit | Large-diff performance gate required |
| Ports/preview | Native list; NSWorkspace.open default browser | No embedded webpage |
| Global shortcuts/menus/copy-paste/accessibility | Commands, NSMenu, AppKit focus/accessibility | Native experience should improve on Web |
| Device authorization/install/cross-platform fallback | Existing Web pages in default browser | Explicitly retained, not a native gap |

## Decisions & tradeoffs

- **SwiftUI-first with necessary AppKit bridges.** Pure AppKit increases UI cost and hinders reuse of iOS models; pure SwiftUI lacks needed control for dense sidebar, large diffs, and terminal input/performance. Based on docs/ROADMAP.md:74-78 and SwiftTerm's AppKit support.
- **Real macOS target under apps/macos; product/scheme Coflux.** Reject Catalyst/Designed for iPad because of desktop density, windows, menus, shortcuts, and AppKit boundaries. Do not place macOS UI inside apps/ios, coupling navigation/releases.
- **Share client core; keep UI separate.** Share protocol/auth/control reduction/DeviceRouter/Keychain-identity abstractions/fixtures, not UI, voice, or windows. Duplicating CofluxClient creates three behavior implementations across Web/iOS/macOS; sharing iOS Views produces the wrong product. First Foundation plan after 083 freezes physical boundaries; parallel plans must not each relocate core.
- **Prefer Swift Router plus native libwebrtc; Rust client core is an explicit fallback.** Existing Rust P2P is a worker responder, not embeddable client Router. Default Rust FFI adds UniFFI/callback/actor, dual toolchains/distribution, and redoes Swift relay work. Reconsider only if 083 fails interoperability/license/size or Windows/Linux native becomes a firm one-year product goal.
- **Functional equivalence is mandatory, pixel identity is not.** Recreating all controls for screenshot similarity is costly and harms native interaction. Engine differences do not excuse recovery semantics: attach/snapshot is data correctness, per docs/architecture.md:187-212.
- **Full release includes loopback direct, P2P, and relay; relay-only is not parity.** iOS's relay-only ceiling reflects never sharing a machine with daemon and does not apply to Mac. Based on DeviceRouter.swift:44-49 and Web router:1237-1304.
- **CoreText/CoreGraphics is the launch baseline; Metal is later optimization.** SwiftTerm macOS Metal is experimental. Defaulting to it expands reparent/live-resize/GPU-context recovery validation.
- **The same Claude CLI, Codex CLI, and Vim/TUI fixtures constrain xterm and SwiftTerm.** SwiftTerm-only tests miss parser differences in daemon snapshots; screenshots confuse font antialiasing with state correctness.
- **Reuse P-256 grant/lease security without browser impersonation or authorization exceptions.** Plan 083 proved URLSessionWebSocketTask sends stable HTTPS Origin observed identically at control and loopback, plus Keychain P-256 identity, pair/grant/revoke, mismatch, and lease under unchanged validation. Any later native identity/header requirement needs a separate TS/Rust/Swift protocol plan, never silent validation weakening. Based on local-control.ts:99-108,401-404.
- **Web remains a companion, not disposable legacy.** Preserve authorize, port-preview access, install, non-Mac clients, and fallback. Removing Web loses inherent preview and cross-platform/recovery paths; embedding previews in WKWebView violates the boundary and expands cookie/auth surface.
- **Launch with Developer ID, Hardened Runtime, notarization, and Sparkle 2 or a security-reviewed equivalent, not App Store.** Store sandbox/update/loopback/WebRTC requirements add risk without reducing core risk. Plan 083 proved sandbox feasibility: loopback needs network.client; UDP WebRTC needs both network.client and network.server. Missing client blocks control/relay and makes the app unusable; client without server gives diagnosable UDP failure while relay works. Final Developer ID sandbox choice awaits clean-user TCC, macOS 14, and formal signing matrix. Always use least privilege and Keychain for tokens/private keys.
- **Default macOS 14+, universal arm64/x86_64.** Modern Observation/SwiftUI/AppKit baseline while covering supported Intel Macs. Dropping Intel before Foundation requires product/device-data justification, not build convenience.
- **Release clients report auditable native build/version, never iOS's dev allowlist.** Based on CofluxClient.swift:65-67 and hub.ts:1793-1807. Admission accommodates independent Web/native cadence, minimum protocol, and readable upgrade prompts.
- **Do not add features to frozen apps/mobile.** Only minimal repairs if shared protocol breaks its build, per AGENTS.md.
- **Web/native coexistence must explicitly resolve holder conflicts.** Do not assume users never open both. Multi-client attach/detached/force takeover and background terminal lifecycle are release gates.

## Architecture direction

```text
apps/macos: native UI, app lifecycle, menus, updates
  ├─ SwiftUI workbench: sidebar, projects/workspaces, tabs, diff, devices, preview entry
  ├─ AppKit: SwiftTerm; NSOutlineView/TextKit/NSSplitView as needed
  └─ Shared Swift Client Core for iOS/macOS
       ├─ Swift Protobuf, control WS, reducer, version admission
       ├─ DeviceRouter: loopback direct > P2P > relay; session/elevated lanes
       ├─ P-256 identity, grant/lease, Keychain
       └─ fs/exec/ports/session APIs and observability

server / relay / Rust daemon: wire/behavior source of truth
apps/web: behavior reference, companion entry, fallback
```

Core must not import SwiftUI/AppKit/UIKit. Inject storage, WebSocket, clock, randomness, and logging through small explicit adapters for deterministic tests. Use actors or a single isolation domain for network state machines; Views must not own connections. Existing iOS @MainActor can be a starting point, but assess moving high-throughput PTY processing off main rather than copying it mechanically.

## Roadmap

### Phase 0: Feasibility gates (083, 2–3 engineering weeks)

Without full UI, resolve SwiftTerm snapshot fidelity, libwebrtc/webrtc-rs DataChannel, and native P-256/Origin/grant/lease. Produce GO/CONDITIONAL GO/NO-GO, dependency choice, core-boundary recommendation, and evidence. No full rewrite with failed gates deferred to later.

2026-08-25: all local architecture gates passed without changing dependency/core direction: **development GO**. User deferred two-network P2P, clean-user TCC, Intel/macOS 14, and Developer ID distribution to Phase 6–7 release qualifications. No release/default switch/full acceptance claims before that evidence.

### Phase 1: Shared Apple core and macOS Foundation (3–5 weeks)

Separate plan freezes physical core/public API. iOS consumes it without regression; macOS logs in, persists tokens, receives snapshots/increments, and displays basic device/project state. Establish macOS CI/logs/native build version, not full workbench.

### Phase 2: DeviceRouter and remote parity (5–8 weeks)

Separate transport plan adds direct/P2P/relay race/promotion, pair/grant/lease, heartbeat/death, session/elevated lanes, exactly-once input, prepared operations, fsList/fsRead/fsWrite/exec/ports. Share business-frame/state semantics across transport, with deterministic tests and Rust worker black-box interoperability.

Consume 076's 16KiB chunks, DTLS role, and candidate findings, plus 080's silent-control-death/cascading-data-loss lessons. If 080 authorization convergence is unresolved, first create a superseding contract plan; macOS must not invent a third answer.

### Phase 3: Desktop workbench and core flows (5–7 weeks)

Separate UI plan covers dense hierarchy, selection/persistence, context menus, rename/delete, import, workspace creation, branches/worktrees, optimism, orphan sessions, agent state, shortcuts, empty/error states. Follow docs/design-guidelines.md with native menus/focus/accessibility.

### Phase 4: Terminal workbench and recovery (3–5 weeks)

Separate terminal plan covers multiple tabs, inactive retention, attach/resume/snapshot, holder/force takeover, input/resize, OSC titles/links, search/selection, mouse/keyboard protocols, Chinese IME, compressed image paste, file drop, and resize after window/display changes. Expand Phase 0 fixtures into permanent gates.

### Phase 5: Git/diff, preview, desktop completeness (3–4 weeks)

Separate workflow plan covers changes, merge-base, untracked, unified diff parsing/highlighting, large-diff virtualization/cancellation, ports/default-browser previews, install/auth browser handoff. Only after this phase may full Web desktop coverage be claimed.

### Phase 6: Distribution, updates, production quality (3–4 weeks)

Separate release plan covers universal app/DMG, Hardened Runtime, signing/notarization/staple, Sparkle, update-failure rollback, admission, macOS CI, SBOM/checksums, crash/connection observability. Never log tokens/private keys/terminal content. Complete clean-user TCC Allow/Deny including same-native-client relay fallback after Deny, macOS 14, physical Intel, and Developer ID clean-machine Gatekeeper. Development GO changes timing, not these requirements.

### Phase 7: Beta, default switch, fallback (1–2 weeks plus observation)

Progress internal→invited Beta→default recommendation. Cover Apple Silicon/Intel, one/two displays, English/Chinese IME, local daemon, remote relay/P2P, simultaneous Web/native attach. Roll back by disabling native recommendation/flags and returning to Web, never irreversible server migrations. Real P2P/relay between two Macs on different NAT/networks must pass before default recommendation; otherwise only development/internal testing may continue.

### Effort

| Phase | Engineering weeks |
| --- | ---: |
| 0 Gates | 2–3 |
| 1 Foundation | 3–5 |
| 2 Router | 5–8 |
| 3 Workbench | 5–7 |
| 4 Terminal | 3–5 |
| 5 Git/diff/preview | 3–4 |
| 6 Release quality | 3–4 |
| 7 Rollout | 1–2 |

Gross 25–38 weeks; safely parallel UI/transport after Foundation yields net 22–30 weeks. One experienced Swift/macOS engineer: ~5–7 months; two after contract freeze: ~3–4.5 months. Excludes ongoing Web feature scope growth.

## Risk register

| ID | Risk | Level | Evidence/trigger | Mitigation/exit |
| --- | --- | --- | --- | --- |
| R1 | Swift misses race/generation/recovery/exactly-once edges | CRITICAL | Web Router ~2,968 lines; Swift relay subset | Freeze behavior table, port deterministic tests, cross-stack tests; no parity without all transports/promotion |
| R2 | SwiftTerm snapshot mismatch | CRITICAL | 083 passed local Claude/Codex/Vim raw/real snapshot/tail | Permanent cell/mode regression; STOP if new critical escape difference exceeds a small repair |
| R3 | Unacceptable libwebrtc size/license/symbols/architecture | HIGH | M151 checksum/license/slices/dyld/interop audited; physical Intel/formal signing pending | Pin/checksum/license/SBOM, prefer reproducible builds; full matrix for each Chromium milestone |
| R4 | Native Origin/P-256 weakens authorization | HIGH | 083 passed strict Origin pair/grant/revoke/lease unchanged | Preserve real positive/negative loopback contracts; clean-user TCC release matrix; separate protocol plan if needed |
| R5 | Long-term Web/Swift drift | HIGH | Two Router implementations already | Shared proto/fixtures/conformance; behavior PRs list both impacts |
| R6 | Copy 080 silent-death/cascading-loss defects | CRITICAL | 080 still PARTIAL at this historical baseline | Independent native liveness/backoff tests; no production until authorization settled |
| R7 | SwiftUI stutter/CPU under dense sidebar/large diff/PTY load | HIGH | Web retention/virtualization/resize pitfalls | Allow AppKit/TextKit; 10k-line diff, sustained PTY, 20-tab gates |
| R8 | Missing admission/updater creates obsolete native clients | HIGH | iOS buildID=dev; CI lacks app | Native version in Phase 1; update/rollback/old-version rejection in Phase 6 |
| R9 | Web/native holder churn or accidental stop | HIGH | Single-holder semantics | Dual-client attach/detach/force/stop matrix; background windows do not reclaim holder repeatedly |
| R10 | Scope absorbs iOS UI/mobile/daemon rewrite | MED | Shared-repository/protocol coupling | Per-phase exclusions; mobile frozen; separate server/worker contracts |
| R11 | Third-party binary supply chain | HIGH | External XCFramework | Checksums/provenance/build/license/signature/SBOM and dedicated update matrix |
| R12 | Pixel-copying sacrifices native UX/accessibility | MED | Different renderers | Functional/semantic/token acceptance; native menus/focus/VoiceOver/Reduce Motion |

## Landmines

- **Snapshot is not raw replay**: daemon reconstructs VT/history as ANSI. Live output can work while reattach fails. Test raw, snapshot, and snapshot+tail separately.
- **16KiB is a hard cross-stack boundary** at packages/protocol/src/index.ts:57 and crates/protocol/src/lib.rs:68. Native must not use its larger default message limit.
- **Relay-first then P2P promotion is intentional** at device-router.ts:1237-1254. Waiting for P2P before relay exposes setup delay and is not equivalent.
- **Pair Origin binds both control WS and loopback** at local-control.ts:104-105,401-404; one is insufficient.
- **Never unmount inactive terminals**: Web hides them to retain scrollback/selection at terminal-pane.tsx:447-450. SwiftUI conditional NSView destruction recreates the bug.
- **Register consumer before attach** or replay/snapshot bytes are lost; terminal-pane.tsx:421-434.
- **Send input only when active and owned**; focus/tab selection does not replace holder authorization, terminal-pane.tsx:269-276.
- **Image/file budgets differ**: compress images to 3.5MB, allow regular files to 30MB, terminal-pane.tsx:38-42,279-376.
- **Metal is experimental**; do not hide semantic/window problems behind performance before CoreText passes.
- **Web P2P has remaining production evidence**: ROADMAP:68-72 still lacks full STUN/success-rate/browser/iOS matrix. Shipped Web does not prove every network condition.
- **Apple CI must test more than archives**: core, terminal fixtures, universal architecture, post-signing verification.
- **Proto generation clean:true** rebuilds TS/Rust/Swift; STOP on widespread unrelated diff.

## Scope

Program in scope:

- New `apps/macos/**`
- `apps/ios/Coflux/Client/**`, `apps/ios/CofluxTests/**` for extraction/regression
- Shared Swift core location frozen by Foundation
- `proto/gen/swift/**`; proto/buf.gen.yaml and IDL/generated outputs if required
- `packages/client/src/**` as behavior oracle/fixture/conformance only, not a TS rewrite for native
- `crates/protocol/**`, `crates/worker/**`, `apps/server/**` only under separate authorized compatibility/protocol plans
- `tests/src/**`, terminal recordings
- `.github/workflows/**`, macOS packaging/signing/updater config
- docs architecture/ROADMAP/RELEASING/design-guidelines
- apps/web only native download/auth/preview handoff/rollout messaging; maintain its workbench

Program out of scope:

- Electron/Tauri/WKWebView main UI/Catalyst/JS runtime
- Deleting/freezing apps/web
- New apps/mobile features; only minimal shared-protocol build repairs
- iOS UI expansion or desktop-feature porting; shared-core regression is not UI parity
- Windows/Linux native; would reopen Swift-vs-Rust
- App Store launch
- Pixel-identical terminal/control rendering
- Server data-model/daemon/sessiond/auth rewrites under the native umbrella
- iOS voice input and other non-Web-desktop features

## Commands

Run relevant subsets per phase; all final integration gates must pass. Environment/manual items are acceptance.

| Purpose | Command | Expected result |
| --- | --- | --- |
| macOS build/test | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS'` | exit 0 |
| iOS core regression | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | exit 0; explicitly skipped environment probes only |
| Server types if touched | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types if touched | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Protocol tests if touched | `cargo test -p coflux-protocol` | exit 0, zero warnings |
| Daemon build if touched | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Black-box acceptance | `pnpm -C tests test` | Real-process/temp-DB topology green; document old environment baseline separately, never relabel new failures |
| Native two-machine network acceptance | Apple Silicon/Intel, local loopback, remote P2P/relay, Web/native together | Transport/fallback/holder/recovery contracts hold |
| UI/IME/accessibility | Chinese/English IME, keyboard-only, VoiceOver, Reduce Motion, dual displays/scaling | No blocking defects |
| Signing/notarization/update | GitHub macOS release, clean-machine install/upgrade/rollback | Gatekeeper passes; failed updates recover; readable old-version prompt |

## Program done criteria

- [ ] All 083 gates pass, or user-approved CONDITIONAL GO alternative has its own plan.
- [ ] All hard feature-matrix requirements covered; approved deferrals cannot coexist with full-parity claims.
- [ ] Direct/P2P/relay deterministic tests and real Rust-worker interoperability include fallback/promotion.
- [ ] Claude/Codex/Vim raw/snapshot/snapshot+tail meet SwiftTerm cell/mode contract.
- [ ] iOS uses shared core with non-environment tests passing; no mobile functionality changes.
- [ ] Concurrent Web/native attach/force/stop/background retention cause no churn or accidental kills.
- [ ] Admission/updater/signing/notarization/rollback/macOS CI reproducible.
- [ ] Web auth/preview/install/fallback remain usable; no native main-UI WebView.
- [ ] Sustained PTY, 20 retained tabs, 10k-line diff, resize/cross-display gates show no unacceptable stutter/leaks.
- [ ] Subplans follow decisions; departures have user approval and records.
- [ ] Architecture/ROADMAP/RELEASING match final state.
- [ ] plans/README statuses/dependencies/rollout updated.

## STOP conditions

- A critical 083 gate fails and needs SwiftTerm/libwebrtc fork or Rust core without approved cost/maintenance.
- Cited P2P/snapshot/Web/Swift facts drift materially: update plan first.
- Native identity works only by weakening server/daemon authorization.
- Scope requires web-shell main UI.
- A phase simultaneously rewrites core/server/worker/Web without frozen contracts: split into sequential contract plans.
- 080 control/data authorization/liveness remains contradictory, forcing native to choose arbitrarily.
- Validation fails twice after one reasonable fix, or only passes by weakening/removing tests.
- Mobile functionality/iOS UI/unrelated large refactor required.
- Net estimate rises >40% without renewed scope/dependency review.

## Maintenance notes

- Full-parity baseline is fixed at `8d702d2`. Ongoing Web additions are not automatically included; product owner assigns launch/later/Web-only to avoid an endless moving target.
- Core extraction reduces behavior implementations, not all platform code. Widespread #if os(...) signals a bad boundary.
- Chromium milestone upgrades are security/compatibility work: rerun webrtc-rs, 16KiB, ICE/DTLS, and universal matrix.
- Never collect terminal body telemetry. Limit observability to phase, route kind, relay host, RTT, generation, errors, build/version, timing, following redaction rules.
- Windows/Linux commitment reopens Swift-vs-Rust before adding a third Router.
- Native completeness includes menus, shortcuts, drag/drop, focus, window restoration, VoiceOver, and browser handoff, not just resembling Web.

### Original source references

`packages/client/src/device-router.ts:1237-1304`, `apps/server/src/local-control.ts:99-108,401-404`, `apps/ios/Coflux/Client/CofluxClient.swift:65-67`, `apps/server/src/hub.ts:1793-1807`, `packages/client/src/device-router.ts:1237-1254`, `apps/server/src/local-control.ts:104-105,401-404`, `apps/web/src/components/workbench/terminal-pane.tsx:447-450`, `docs/ROADMAP.md:68-72`.
