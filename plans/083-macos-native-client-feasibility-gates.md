# Plan 083: Native macOS feasibility gates—SwiftTerm recovery, loopback identity, and WebRTC DataChannel

> This is an outcome contract, not a script. It is the first executable slice of plan 082, resolving three architecture-changing unknowns without a complete workbench. Design probes, harnesses, and tests against live code; the verifier must personally run cross-stack evidence. Stop on any STOP condition. Update this plan, plan 082's conclusion, and plans/README.md when complete.
>
> Drift check: `git diff --stat 8d702d2..HEAD -- tests/fixtures/terminal/ tests/src/local-first-vt-oracle.test.mjs docs/architecture.md packages/client/src/device-router.ts apps/server/src/local-control.ts crates/worker/src/p2p.rs crates/worker/src/local_auth.rs apps/ios/Coflux/Client/ apps/ios/CofluxTests/ proto/gen/swift/`

## Status

- Priority: P1
- Effort: M (2–3 engineering weeks)
- Risk: HIGH
- Depends on: `plans/082-macos-native-client-program.md`
- Category: tests
- Planned at: `8d702d2`, 2026-08-25
- Review state: user explicitly authorized execution, commits, and local dependency installation on 2026-08-25
- Execution: self-execution, explicitly selected during departure check
- Outcome: DONE (development GO; external release matrix deferred to 082 Phase 6–7)

### Execution progress (2026-08-25)

- Milestone 1: complete, commit `a70bbae`; all three fixtures passed fixed-snapshot fast gates and real sessiond acceptance.
- Milestone 2: local architecture gate complete. Native stasel/WebRTC M151 and real webrtc-rs 0.20.2 worker exchanged bidirectional production DataChannel frames. Pinned tag 151.0.0, wrapper `19aa8c1fc7120d50df987b7111f42d5024df3d54`, checksum `64a218fad3d84a0d783321aa9a1eec58ca266ac7879123f86b0b44b703b7d8dc`, upstream branch-heads/7922 / `f20ebb8adbf4fa781830e4384c61f732bd28a217`. Verified BSD license, archive bytes/hash, Info.plist, actual arm64+x86_64 Mach-O, and dyld loading for both architectures. Existing relay remained continuously usable after center/worker negative rejection. Automated assertions cover promotion generation, whole-frame concurrency serialization, closing after partial-frame send failure, and response channel IDs. A 29MiB DeviceFsWrite upload was SHA-256-verified by daemon; 29MiB download used production DeviceExecRun/ExecResult. DeviceFsRead's own 2MiB business cap stayed unchanged. Representative isolated offer→connection: 147ms. Test-process baseline memory: 35,291,136 bytes; idle offerer: 49,692,672; connected: 51,462,144. After center disconnect worker was silent while native still saw peer connected, ICE completed, channel open; future Router must actively detect death through control disconnect and application timeout. See apps/macos/WEBRTC_PROBE.md. Two different NAT/network acceptance has **not** run and remains required for release GO.
- Milestone 3: local identity/auth and signed-entitlement subgates complete, commit `50e44fa`. CryptoKit P-256 uses 32-byte scalar, 65-byte X9.63 public key, and 64-byte IEEE-P1363 signature compatible with existing wire. Fixed vectors, tampering, corrupted Keychain, and concurrent first creation fail closed. Two independently signed XCTest processes proved identity reuse after app restart. Real server/worker coverage includes pair, peer-observed Origin, session scope, grant reuse/revoke, key-mismatch recovery, elevated lease, expiry, and real RPC, without relaxing Origin/grant/lease checks. Sandbox loopback needs network.client; UDP WebRTC needs network.client plus network.server. Client-only native generates TCP host candidates against worker UDP candidates, remains ICE checking, and retains relay. Adding server entitlement passes the same full interop. Audited Development signing, Team ID, Hardened Runtime, exact entitlements, no absolute-path read/write exceptions, and no NSAllowsArbitraryLoads. Clean-user TCC Allow/Deny remains untested; privacy/final launch Sandbox awaits 082 Phase 6. Entitlement success is not TCC completion.
- Milestone 4: complete, **development GO**. All local architecture gates passed without NO-GO or forks, weakened protocol, or new maintenance costs requiring CONDITIONAL GO. User explicitly deferred LAN validation on 2026-08-25; external acceptance no longer blocks Foundation/UI/Transport but remains mandatory in 082 Phase 6–7. Added strict TCC acceptance through two standalone GUI apps: fresh bundle IDs, separate Allow/Deny compile constants and Mach-O UUIDs, manual Finder launch, controlled physical LAN peer nonce echo or NWPath.localNetworkDenied classification. Script rejects loopback, own-machine/nonphysical routes, global privacy exceptions, ordinary network errors, and automatic clicking. Only never-launched Development-signed build-only audit passed; no second controlled LAN peer exists, and no TCC result was produced or claimed. Development GO is explicitly not release GO.

### Auditable acceptance record (2026-08-25)

- Environment: MacBookPro18,3, M1 Pro 32GiB, macOS 27.0 (26A5388g), Xcode 26.6 (17F113), Swift 6.3.3. x86_64 linking/dyld/XCTest used same-machine Rosetta 2, **not physical Intel**.
- Passed: full macOS XCTest, real sessiond, hardened native WebRTC/Rust worker, Sandbox client-only negative/client+server positive, three native-loopback signing configurations, universal/supply-chain audit, Node/Shell syntax, xcodegen generate, git diff --check. Final read-only Keychain inventory found zero entries for all three test identity categories, dev.coflux.macos.loopback-probe.*, and dev.coflux.macos.denied.*; no test processes remained.
- TCC app build-only audit passed: two never-launched one-shot apps had Apple Development / Team 8Y2J55823C, Hardened Runtime, Sandbox+network.client, no network.server/absolute-path exceptions/global ATS weakening, and complete Info.plist. arm64 executable UUIDs: `E43E30F0-481D-3664-B3CA-F0DFD3DBF22C` and `434CDE7A-52F8-367F-886E-7CF076A85130`. Temporary apps/DerivedData were removed after build, without launch or TCC writes. UUIDs identify these target builds, not Intel or later revisions.
- Repository regression: protocol 26/26; zero-warning daemon build; real xterm/sessiond oracle 1/1; black-box 99/101 pass, two fail. Both are existing cofluxd doctor local-service baseline failures; CLI/doctor was unchanged, and all other 99 passed.
- External matrix remaining: first clean-user Local Network Allow/Deny and relay fallback after Deny; two Macs on different NAT/networks; physical Intel; physical macOS 14; Developer ID app/notarization/staple/clean-machine Gatekeeper. Entitlement negatives, Rosetta, and Development signing cannot replace these.

## Requirement

Before full UI investment, answer three architecture questions with minimal native probes using real production semantics:

1. **Terminal recovery**: can SwiftTerm consume current sessiond ANSI snapshots and, after tail, match the raw recording's key buffers/cells/modes?
2. **P2P**: can native macOS libwebrtc offer to webrtc-rs 0.20.2 worker and reliably carry binary Device frames, 16KiB chunks, close/timeout signals, and relay fallback/promotion?
3. **Local direct**: can native P-256 identity, stable HTTPS Origin, pair/grant/lease, and loopback session/elevated scope work without weakening authorization?

Produce an auditable outcome:

- **GO**: all three pass; Swift core/libwebrtc direction stands.
- **CONDITIONAL GO**: bounded changes, such as small upstream SwiftTerm patch, self-built libwebrtc, or formal native-identity protocol plan, have recorded costs/maintenance/dependencies and user approval.
- **NO-GO**: key semantics require WebView, weaker security, unmaintainable forks, or unlicensed binaries.

Compilation, connected status, or visually readable snapshots do not pass. Every gate needs automated state assertions and at least one real Rust worker/sessiond or existing black-box harness run. Mock-only evidence is invalid.

## Decisions & tradeoffs

- **Close all three gates before full rewrite.** Parallel UI/spikes would freeze boundaries before Router/terminal risks potentially force Rust core or a terminal fork. Based on 082 R1–R4.
- **Reuse three sanitized fixtures**, `tests/fixtures/terminal/{claude-cli,codex-cli,tui-vim}.json`, covering alternate screen, diff, resize, wide characters, styles, and tail. Existing xterm oracle: tests/src/local-first-vt-oracle.test.mjs:161-258. Simple echo/prompt demos miss actual usage.
- **Compare cells/modes; screenshots are supplementary.** At minimum: size, normal/alternate buffer, logical lines, wrap, characters/width/combining characters, 16/256/RGB foreground/background, bold/dim/italic/underline/inverse, cursor position/visibility, application cursor/keypad, bracketed paste. Preserve explicit exclusions in docs/architecture.md:202-212; do not expand/shrink them privately.
- **CoreText/CoreGraphics determines GO; Metal does not.** Experimental Metal and GPU/window rebind would mix rendering lifecycle with parser correctness. Optional performance measurements do not let Metal failure invalidate CoreText feasibility.
- **Prefer maintained universal XCFramework pinned by checksum.** On 2026-08-25, stasel/WebRTC M151 first, LiveKit alternative. Version drift may permit a newer milestone, but record exact tag/source/checksum/license/download+expanded size/slices. Unpinned latest URLs or manually dragged frameworks are unreproducible.
- **Offer to real worker, not native-to-native peers.** Worker-specific DTLS role, candidate enumeration, and 16KiB limit require cross-stack evidence. Based on 076's five execution departures and crates/worker/src/p2p.rs.
- **Use production protobuf and center signaling without full Router rewrite.** Minimal harness handles offer/answer/channel, bidirectional sizes, closure, relay-first then P2P promotion. Full lanes/fs/exec/long-term reconnect belong later. Copying 3,000 TS Router lines creates uncontrolled temporary debt before contract freeze.
- **16KiB is mandatory**, despite libwebrtc's larger limit. Cover boundary, multichunk, near-30MiB Device frames, ordering/reassembly. Based on protocol TS:57/Rust:68.
- **Do not depend on prompt RTCDataChannelState.closed.** 076 found closure invisible across stacks until ~30s ICE timeout. Measure active close, send failure, application ping/timeout and hand findings to Router. One onClose is no guarantee for every fault, as 080 proved.
- **Validate existing loopback security unchanged.** Both WS connections send stable HTTP(S) Origin matching server URL; pair request.origin matches; P-256 private key stays in Keychain; elevated scope still needs center lease. Never remove Origin validation, embed fixed grants, or reuse daemon private keys. Based on local-control.ts:99-108,401-404 and local_auth.rs.
- **Use exportable CryptoKit signing key persisted in Keychain.** Secure Enclave is a later security choice. This gate proves wire format/lifecycle. Ephemeral memory keys cannot test restart grant recognition/key mismatch.
- **Separate production STUN/TURN reachability from client interoperability.** First prove local/isolated LAN offer/answer/host/DataChannel, then two real networks. Production punching rates remain 076/080 deployment/stability work. Local interop failure cannot be blamed on public networks.
- **Probe assets enter production boundaries or are explicitly deleted.** Keep fixture runner, cross-stack tests, dependency records, minimal adapters. Debug UI, hardcoded tokens/URLs, and auth-bypass helpers must not enter Foundation or form a second temporary protocol implementation.

## Direction

### Milestone 1: SwiftTerm snapshot fidelity

Build macOS test harness using all three fixtures to verify raw recording, real sessiond snapshot, snapshot+fixture tail, and real PTY tail after snapshot. Structured diffs identify first buffer/row/column/codepoint/width/style/cursor/mode mismatch, not just screen strings. Map every guaranteed/excluded item to XCTest; document exclusions individually, never blanket-ignore.

Validation: `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -only-testing:CofluxTests/TerminalFixtureCompatibilityTests` exits 0. This fast gate consumes fixed raw/snapshot/tail. Real sessiond snapshot acceptance is in Commands and runs last.

### Milestone 2: Native libwebrtc/webrtc-rs DataChannel

Offer production protobuf/center signaling to a real debug worker; establish ICE/DTLS/SCTP/DataChannel and verify:

- arm64/x86_64 link and load selected XCFramework;
- binary ordered/reliable bidirectional transfer;
- 1B, 16KiB boundary, multichunk, near-30MiB framing/reassembly;
- server/worker rejection, timeout, active close, silent nonresponse signals;
- late P2P promotion over working relay, retaining relay on P2P failure;
- actual lifecycle after control signaling disconnect, without copying 080's cascade.

Record dependency tag/revision/checksum/license, slices, app size increment, idle memory, and setup duration. If first choice fails, test one alternative through the same gate, not opaque binaries repeatedly until something works.

Validation: `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -only-testing:CofluxTests/NativeWebRTCFramingTests` exits 0 for framing/reassembly/timeout/promotion. Real worker acceptance runs last through Commands.

### Milestone 3: Native P-256/Origin/grant/lease

Persist identity and prove: no grant→center pair→daemon install→loopback session; app restart→grant reuse; RPC/lifecycle→center lease→elevated scope; mismatch/revoke/expiry rejection with recoverable state. Both handshake Origins and pair payload match under unchanged checks; no test env disabling auth.

First record actual ATS/Sandbox/Hardened Runtime entitlements and missing-permission failures in local signed builds. Clean-user TCC and Developer ID are milestone 4 external acceptance. Together they determine 082's final Sandbox policy.

Validation: `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -only-testing:CofluxTests/NativeIdentityTests` exits 0 for wire, Keychain restart simulation, Origin construction, lease state. Real server/worker loopback acceptance runs last.

### Milestone 4: Decision closure

Write gate evidence, failure boundaries, dependencies, performance/size, and required protocol changes into 082. GO permits a separate Foundation plan freezing core path/API before parallel UI/transport. CONDITIONAL GO first needs user-approved maintenance costs and prerequisite plan. NO-GO stops full rewrite; do not relabel failed probes alpha.

Validation: `git diff --check -- plans/082-macos-native-client-program.md plans/083-macos-native-client-feasibility-gates.md docs/ROADMAP.md docs/architecture.md` exits 0.

## Landmines

- local-first-vt-oracle obtains **real sessiond snapshots**, not an arbitrary recording segment. Native must test the same subject.
- Fixture stage barriers/resize at player.mjs:22-26 are semantic. Concatenating base64 loses boundaries.
- Architecture exclusions are not blanket failure waivers. Wide Unicode/history/cursor/alternate screen/color/key modes remain mandatory.
- ICE connected is not DataChannel usable. 076 saw DTLS mismatch preventing open; require open plus bidirectional business frames.
- webrtc-rs does not automatically enumerate interfaces. Do not alter worker candidate handling because native libwebrtc does.
- Check actual Mach-O slices as well as framework declarations; README universal is not evidence.
- Checksum fixes bytes, not trust. Record source/build/license/update policy.
- Observe Origin at real peers; URLRequest construction alone does not prove handshake headers were sent.
- Keychain tests need signed hosts. CODE_SIGNING_ALLOWED=NO caused read-after-write nil in research; do not misdiagnose CryptoKit/Keychain.
- Elevated leases require online center. Reachable loopback/session attach does not prove offline RPC/lifecycle permission; test scopes separately.
- 080 was PARTIAL at this baseline. If liveness/worker close_all semantics drift, use live contract and update 082 first.
- Never read/print real tokens, Keychain contents, private keys, or unsanitized terminal recordings. Use temporary HOME/DB/ports and sanitized fixtures.

## Scope

In scope:

- `apps/macos/**`: minimal probe/test target, not full UI
- `apps/macos/scripts/**`: reproducible sessiond/WebRTC/loopback and slice checks
- Terminal fixtures, preferably read-only, with cross-engine metadata changes only
- Existing xterm oracle/harness only to share fixture/snapshot evidence
- iOS Client/Tests only for reusable platform adapters or shared probe-discovered defects, not UI
- Generated Swift consumption, no manual generated edits without protocol plan
- TS device-router and worker p2p/local_auth as behavior truth/test wiring; production semantics require separate plan
- Isolated test/fixture configuration and SwiftPM pins/checksums
- Plans 082/083/README
- ROADMAP/architecture final evidence/boundaries

Out of scope:

- Complete workbench/sidebar/diff/import/release UI
- Full Swift Router port
- Weakening/rewriting server/worker authorization: STOP and create protocol/security plan
- Production deployment/P2P flag/STUN/TURN configuration; read-only production here
- Large maintained SwiftTerm/libwebrtc fork without CONDITIONAL GO approval
- Rust core implementation
- Web/mobile/iOS UI or voice
- Updater/signing release pipeline; probe only records permission/load conditions

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| All macOS probe tests | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS'` | exit 0 |
| iOS regression if shared extraction | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | All non-environment cases pass |
| Existing xterm oracle acceptance | `node --import tsx --test tests/src/local-first-vt-oracle.test.mjs` | Three fixtures pass in real stack |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0, zero warnings |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| SwiftTerm/sessiond acceptance | `apps/macos/scripts/test-terminal-sessiond-interop.sh` | All three raw/snapshot/snapshot+tail contracts pass |
| Native WebRTC/worker acceptance | `apps/macos/scripts/test-webrtc-worker-interop.sh` | DataChannel/framing/large frames/fallback/promotion pass |
| Native loopback auth | `apps/macos/scripts/test-loopback-auth-interop.sh` | Pair/grant/restart/revoke/lease positive/negative pass |
| Full black-box acceptance | `pnpm -C tests test` | Green; independently establish any old baseline |
| Universal slices | `apps/macos/scripts/verify-webrtc-slices.sh` | Both architectures; matching checksum/license record |
| Two-network P2P acceptance | Two Macs on different NAT/networks and real daemon with relay fallback | Promote on success; relay continuously usable on failure |
| Signed network probe | `apps/macos/scripts/test-loopback-auth-interop.sh && apps/macos/scripts/test-webrtc-sandbox-interop.sh` | Development/Hardened Runtime/Sandbox positive/negative matrix; not clean-user TCC |
| TCC app build | `node apps/macos/scripts/local-network-tcc-acceptance.mjs --build-only` | Both signatures/Team/runtime/Sandbox/entitlements/Info/distinct UUID pass; no launch |
| Clean-user TCC | In new user or preinstall VM snapshot: `node apps/macos/scripts/local-network-tcc-acceptance.mjs --acceptance --peer-host <controlled-second-LAN-Mac-IP> --peer-port <port> --context new-user`; manual Finder launch and Allow/Deny | Allow nonce echo; Deny localNetworkDenied. Context flag does not prove clean-user state or native relay fallback |
| Physical system/architecture | Core interop on Intel Mac and macOS 14 | Rosetta/macOS 27 not substitutes |
| Formal signing | Developer ID app/sign/notarize/staple/clean-machine install | Gatekeeper passes; entitlements match Development probe |

## Done criteria

- [x] All three gates have automated and real cross-stack evidence, not mock-only/connected/screenshots.
- [x] Existing fixtures compare raw/real snapshot/snapshot+tail; cell/mode diffs locate failures; exclusions documented individually.
- [x] Native/Rust bidirectional binary DataChannel covers 16KiB and large frames.
- [x] P2P failure/silence preserves relay; usable liveness signals and unreliable callbacks recorded.
- [x] Exact dependency/version/revision/checksum/license/source/slices/size/memory recorded.
- [x] Identity reused across app restart; pair/grant/revoke/mismatch/expiry positive/negative pass.
- [x] Peers observe matching actual control/loopback Origins; no weaker validation.
- [x] Incomplete ATS/Local Network/Hardened Runtime/Sandbox release matrix transferred intact: local signed/entitlement/TCC build-only passed; clean-user Allow/Deny, remote worker plus same-client relay fallback, macOS 14, and Developer ID remain for Phase 6–7. Checked means deferral audited, **not external results passed**.
- [x] 082 records development GO, dependencies, core recommendation, estimate, deferred gates.
- [x] Separate Foundation may proceed under existing self-execution authorization; no early release exemption.
- [x] Runnable iOS tests did not regress; mobile/production unchanged.
- [x] Local architecture commands pass; deferred commands/environment/unfinished status retained.
- [x] README distinguishes development GO from absent release GO.

## STOP conditions

- Guaranteed fixture semantics still differ after a reasonable small adapter/upstream repair.
- Interop requires changed worker security, unlicensed/unpinnable binary, or only one macOS architecture.
- Native cannot reliably deliver required Origin and only weakened checks would work.
- Large frames require changing existing 16KiB/30MiB wire contract.
- 080/live control/data lifecycle remains contradictory, preventing one native contract.
- Full UI/Router/Rust core is required to prove gates: redesign probe boundary first.
- Probe needs real production tokens/recordings/database/flag changes.
- Validation fails twice after one reasonable fix or only passes by weakening tests.
- Measurements raise 082's net estimate >40%; return for user review.

## Maintenance notes

- Permanent assets are terminal fixtures, native/Rust interop, loopback-auth tests, and dependency audits, useful for iOS/future clients even without full macOS app.
- Fixture product versions age; ANSI coverage matters more. Add small fixtures for new escapes rather than repeatedly rerecording and losing history.
- WebRTC milestone upgrades rerun full interop, not only release-note review. Chromium/libwebrtc, webrtc-rs, and macOS SDK can all change behavior.
- If Rust core wins later, reuse the same wire/terminal/auth gates; changing language never lowers Done criteria.

The signing/entitlement gate checks the packaged `.app`, including `com.apple.security.network.client` and `com.apple.security.network.server` where the selected distribution model requires them.

### Original source references

`packages/protocol/src/index.ts:57`, `crates/protocol/src/lib.rs:68`, `apps/server/src/local-control.ts:99-108,401-404`, `tests/fixtures/terminal/player.mjs:22-26`, `docs/architecture.md:204-210`.
