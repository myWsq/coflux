# 099: Reimplement the macOS client using current Web as the acceptance baseline

Status: In progress. Reauthorized by the user on 2026-09-05; do not consult, restore, or reuse code or conclusions from previous native attempts.

User clarification: App changes are authorized, and **functionality, not only UI, must fully match current Web**. Continue development/local validation autonomously; do not declare a prototype or functional subset complete.

User adjustment on 2026-09-07: login needs correct behavior, error feedback, and usability, not visual parity. Screen-by-screen visual acceptance focuses on workbench, terminals, Changes, and their action panels. Other functional/performance goals remain.

## Goal

A genuinely native macOS client preserving current desktop Web UI, layout, copy, state, and interaction, while improving speed, smoothness, and system integration. Web remains usable; mobile features remain frozen. The main window does not use WebView, Electron, or browser rendering.

Current sources of truth: apps/web/src/index.css, components/workbench, components/auth, packages/client, and proto. Review/verify the current shared Swift protocol/client as live dependencies; do not duplicate protocol models. Base implementation and judgments on current source and measurements from this effort.

## Implementation and acceptance checklist

- [ ] Native project, runnable app, development configuration, login/errors/version/logout, isolated Keychain.
- [ ] Project/workspace/device sidebar, resizable persisted width, tree collapse, Tooltip, activity dots, progress/diff counts.
- [ ] Workbench header, terminal tabs, create/close confirmation, shortcuts, cross-workspace persistence, selection restoration.
- [ ] Native terminal input, IME, copy/paste, scroll, search, mouse, ANSI, disconnected snapshot recovery, control ownership/takeover.
- [ ] Project import device/path wizard, branch list/switch/create, rename/delete, device authorization/install guidance.
- [ ] Git changes/files/unified diff/highlighting, refresh/empty states, large files without main-thread stalls.
- [ ] File/image drag/drop and paste uploads, port list/browser preview, native menus/accessibility.
- [ ] Direct/relay and other connectivity matching current Web, with behavioral evidence for network failure/reconnection.
- [ ] Same-data/same-logical-size Web/native screenshot comparison for every screen; record and eliminate differences.
- [ ] Measure startup, switching latency, frame stability, CPU/memory under identical output loads; native technology alone does not prove speed.
- [ ] Real local-service integration, relevant regressions, distributable signed build and runtime validation.

The overall goal is complete only with current evidence for every item. Partial milestones do not replace the full goal. Record platform differences such as font rasterization separately; they do not automatically exempt UI/interaction gaps.

## Progress in this effort

- Xcode 26.6 and XcodeGen are available; this worktree began clean.
- Current Web: minimum content 1024×640, sidebar 260 (range 200–480), header 36; base type sizes 13/12/11.
- First connect newly written native login/workbench/terminal, then expand through the checklist.
- All integration uses harness temporary DB, temporary COFLUX_HOME, and exclusive ports, never production accounts/devices.
- Newly created apps/macos builds/runs natively. Same-size login/workbench screenshots exist; actual theme, sidebar width, icon assets, and footer differences were corrected. Overall acceptance remains incomplete.
- Real integration passed login failure/success, directory browsing/file errors, Git, project import, worktree create/branch switch/rename/delete, terminal I/O, two-terminal object persistence, and continued output after reconnect.
- Latest macOS full suite: 33 tests passed; shared Swift passed. Reproducible commands/gaps are in apps/macos/README.md. These results do not establish signed distribution, full parity, or speed over Web.
- Uploads/OSC titles are connected. Real multifile uploads matched remote content, and switching tabs left paths in the original terminal. Eligibility checks active-channel generation and device-confirmed holder; reject disconnection. Paste follows current bracketed-paste mode. Real OS drag/drop, ordinary text/IME, oversized images, and control contention still need acceptance.
- Current Web review: use-global-shortcuts.ts standalone uses plain Command with physical keys; terminal has no SearchAddon. Search is not a current-Web parity gap; future enhancement needs separate recording.
- Added ⌘N workspace creation, menu/help copy, and window-scoped physical-key interception. Eleven macOS tests passed, including queued real AppKit keyboard events creating a terminal with differing physical key/character. This does not establish all shortcut/IME/window behavior.
- Explicit tab activation now retakes control after contention and restarts exited terminals. Two isolated real clients verified handoff, ordinary snapshot refresh not reclaiming control, resumed input, and new session creation. Startup timeout clears busy state and waits for explicit retry. Changes views persist per workspace and refresh only when visible; visual acceptance remains.
- Git diff path parsing handles C quoting/UTF-8 octal, deleted paths, and pure renames without treating body +++ as a header. Temporary real repositories cover both quotepath settings, special paths, and binaries; 12 tests passed. Rename-source headers, binary hints, and body line height follow Web; highlighting/full visual acceptance remain.

## Native-first implementation decisions (explicit user correction)

Match overall UI/interactions/full functionality. Reasonable local differences in tokenization/system controls are allowed. Prefer mature native libraries and smooth system behavior; do not introduce JS/browser runtime for exact local pixels/tokens. The JavaScriptCore highlighting experiment was withdrawn in favor of Tree-sitter C parsers and Swift wrappers.

- apps/macos/NATIVE-AUDIT.md records full removal of the JS highlighting attempt. Clean-build scans of Mach-O/resources show no direct JavaScriptCore/WebKit links or JS/HTML/WASM.
- Native Tree-sitter supports JS/TS/JSX/TSX; 13 tests passed including Chinese, emoji, and multiline comments. Real Changes colors observed; short-diff centering fixed. Other languages/load performance remain.
- Branch selection now trims queries, places creation first, allows current branch selection, skips occupied branches, and supports load retry. AppKit command callbacks handle arrows/Return/Esc while allowing marked text. Fifteen regressions passed; actual keyboard/IME and import navigation remain.
- Separate draft import path from device-confirmed directory; import only after successful navigation. Segmented paths/keyboard navigation connected.
- Native NSTextView field editor entered a branch name and dispatched Return; real-device worktree creation passed. Sixteen regressions passed; marked text, complete wizard keyboard flow, and long-list scrolling remain.
- Import requires online device, center connection, and confirmed home directory. Disable stale entries while loading. Keyboard selection scrolls into view; hidden-file toggles/device changes reconcile selection. Sixteen regressions passed, not a substitute for full UI acceptance.
- CUA ran the actual native app through device selection by Return, path entry, and ⌘Return submission; temporary project appeared. Invalid paths/duplicate imports disable submission; Esc steps back.
- Real use exposed unstable path-edit focus. After AppKit input replacement, editing selects the path and confirmed navigation returns focus to filtering. Sixteen regressions still pass. Debug defaults to this isolated service to avoid accidental production reconnect on restart.

## Batched terminal output and backpressure (2026-09-05)

- SwiftTerm processes at most 4KiB per feed and yields after roughly 4ms. Snapshot replacement cancels old queues; closing releases backlog.
- At 4MiB aggregate terminal backlog, native device WebSocket pauses its next read until consumption. Center /client control traffic/sends are unaffected. Removed synchronous draining after exceeding the limit.
- 4MiB is a receive threshold, not process-memory cap: each connection may already have an in-flight frame, and Foundation buffers/scrollback are excluded. Device RPC reception may briefly wait behind terminal backlog.
- Same Debug measurement: 345,016 bytes/5,000 lines fed once took ~138ms; 29 batches peaked ~5.7ms each and ~155ms total. Continuous 8,480,000-byte test peaked ~6.9ms/batch, 4,720,848-byte backlog, ~6.04s total. This demonstrates shorter continuous main-thread occupation, not guaranteed frame rate or superiority to Web.
- Twenty-one tests passed, adding split-frame UTF-8/emoji/ANSI comparison to synchronous results, nonzero Data indices, over-limit waiting/cancellation/snapshot recovery, and sustained drain checks.
- Real integration intermittently timed out restarting exited terminals, reproduced later; handling/evidence follows.
- Artifact review again found no JS/HTML/WASM resources or direct JavaScriptCore/WebKit links.

## Exited-terminal restart timing correction (2026-09-05)

- Fixed a race: device exit notification makes UI show EXITED before center stops reporting RUNNING; immediate taskStart is rejected.
- Shared Swift retains center's original running session. macOS waits up to 10 seconds for center-confirmed exit before restart. Cancellation, close, disconnect, or deletion prevents sending; if another client starts a new session, attach to latest facts.
- Auto-attach bound sessions only when RUNNING and foreground/locally starting, avoiding background claims. Foreground return attaches once per binding. Cancel unrendered old output before restart.
- Controlled tests cover device-first exit, delayed/stale center RUNNING, exactly one start after confirmation, and no start after cancellation. Shared Swift: 44 Swift Testing cases (this test has two parameters) and three XCTest passed.
- macOS 21 tests passed. After final connection-condition adjustment, real login/switch/upload/reconnect/two-client handoff/exit-restart passed ten consecutive runs. iOS Simulator build passed.
- Original intermittent server errors were obscured by startup-timeout copy, so not all timeouts are attributed to this race. Preserve task/error/activation-count failure diagnostics for future investigation.

## Workspace details and local-session hints (2026-09-05)

- Match approval > question > active > done aggregation; legacy waiting means this turn completed. Hide activity offline. Progress uses first nonempty RUNNING-session comment independently of priority.
- Sidebar details include agent name/status/full message/progress/path/device status/correct diff base. Use native macOS help/accessibility values, retaining message newlines; native tooltip typography may differ.
- Shared core consumes live device catalog entries/exit tombstones. Device rows compare taskID+sessionID against center tasks and show Local N plus ids for unregistered live sessions. Hint only, as Web does; no kill/delete actions.
- Tests cover priorities, offline/progress independence, waiting, messages, diff bases, device isolation, empty catalogs not implying exit, retained tombstone metadata, and old-session exit not altering a new session.
- macOS 23, shared Swift 45 Swift Testing plus three XCTest, and iOS build passed.
- CUA after app restart/login confirmed native Help includes path/device. Actual hover with messages/progress/nonzero orphans remains; agent glyph/completion-read status not yet implemented.

## Agent icons and read completion (2026-09-05)

- Tabs use agent presence: current Web Clawd for Claude, Lucide Bot for others, and priority Unplug when control is taken. Approval/question warning and done completion colors match Web.
- `python3 apps/macos/scripts/sync-clawd.py` expands Web gym/flag/confetti SVG into 62 static vector frames. Preserve clawd-glyph.tsx attribution to ayotomcs.me/claude-mascot and brand #D97757. Asset Catalog compiles resources; Swift Task plays Web frame order/timings, without SVG animation interpreter, JS, or WebView.
- Mark completion read only when its terminal is displayed in the current workspace, not in Changes. Next active/approval/question clears it; remove disappeared sessions. Read Claude shows a static standing pose.
- Reduced motion/inactive scenes use static frames; pose changes/view removal cancel old animation tasks.
- macOS 26 passed; subsequent native-window pixel comparison and four AgentGlyphTests prove active frames change/inactive stay still. All 62 resources load and rendered image was manually inspected at /tmp/coflux-native-agent-glyphs.png. Actual system Reduce Motion toggling remains.
- Real agent-hook continuity for read/reset has not been validated; local rendering tests do not replace full UI acceptance.

## Immediate workspace-creation feedback (2026-09-05)

- After submission, show a spinning sidebar placeholder, expand/select its project, and display worktree preparation. Placeholder never enters shared store, terminal binding, network parameters, or persisted fake ids.
- Match success broadcasts using project/device/target branch/preexisting workspace ids, avoiding other-branch results. Duplicate same-project/same-branch submission reuses placeholder.
- Switch to the real workspace only while placeholder remains selected; preserve user navigation otherwise. This improves native behavior over Web's unconditional success selection.
- Errors/project deletion/logout/15-second timeout clear placeholders/timers. Without valid selection, use existing restoration rules. No protocol correlation id exists, so errors clear pending creations like Web and cannot be precisely assigned concurrently.
- macOS 28 passed, then expanded real-device lifecycle tests passed immediate placeholder, success replacement, invalid-branch cleanup, no fake persisted ids, duplicate submission, and background success without selection theft. Extra test worktrees were deleted in the isolated case. Real no-response timeout and placeholder screen comparison remain.

## Native loopback handshake (2026-09-05)

- LocalGatewayConnector uses CryptoKit P-256 ECDSA-SHA256, uncompressed SEC1 public key, and 64-byte P1363 signature. Encode domain+NUL and u32-BE length-prefixed fields; connection generation uses full u64 BE, matching Web/device.proto.
- Dial only 127.0.0.1 at descriptor port. Validate protocol/device/Origin/pinned gateway key/nonce/signature. Outer channelID must be empty before authentication; return actual channelID/scopes afterward. Reads timeout at three seconds; cancellation closes connection.
- Three targeted tests passed invalid Origin/device/key/nonce/signature rejection, cancellation release, and real isolated center pairing→Rust verification→direct session catalog. No lease means no RPC; forged lease yields LEASE_INVALID; center-signed lease grants RPC/lifecycle.
- Tests create in-memory identities/temporary isolated grants, unpair and verify cleanup, without touching persistent user pairings.
- Handshake/persistent identity now connect to workbench routing, with acceptance below; native P2P remains absent.

## Persistent direct identity and pairing storage (2026-09-05)

- LocalIdentityStore keeps P-256 identity/pairings in ThisDeviceOnly Keychain. Service namespace hashes length-prefixed full server URL, authenticated accountID, and Origin. Never write private keys to files/UserDefaults or fall back to ephemeral identity on storage failure.
- First SecItemAdd uses unique service/account; on duplicate, read persisted winner rather than overwrite. Pairing binds identity public key and validates protocol/port/P-256 gateway key. Remove one/all pairings independently while keeping identity.
- Concurrent tests hit macOS legacy Keychain lock waits. Sampling led to shared KeychainAccess serializing Security calls for login/direct credentials; unique Keychain keys still arbitrate across processes.
- Eight concurrent creators got one public key. Reconstructed stores restored signing; server/account/Origin isolation, invalid gateway preserving prior pairing, and pairing deletion preserving identity passed. Restored identity/pairing authenticated and validated leases with real Rust gateway.
- Client exposes authenticated accountID, retaining it across temporary disconnect and clearing on logout/auth failure for provider namespaces. macOS 33, shared Swift 45 plus three XCTest, and iOS build passed.
- Tests use UUID namespaces. Temporary in-app cleanup removed interrupted-test records, verified no remnants, then removed cleanup code.
- App now uses store/connector through NativeLocalDeviceProvider; full transport parity remains incomplete.

## Native workbench routing (2026-09-05)

- App injects native provider by default with Keychain identity/center pairing and leases. Shared clients without injection remain relay-only.
- Direct starts immediately; relay races after 250ms. Once relay activates, promotion starts after two seconds and retries every 30 seconds on failure.
- Separate session/elevated lanes. Center disconnect preserves authenticated direct session, closes relay/elevated; RPC/lifecycle require an online valid lease.
- Real isolated Rust integration passed relay output→direct promotion preserving output→input during center disconnect→Git RPC after recovery→direct loss/fallback relay input→direct promotion→task close/logout.
- Connection loss immediately cancels stale promotion. Disconnection banner explains local terminals remain usable.
- Lease expiry, real revocation, more generation races, and WebRTC/P2P remain. These successful paths do not complete all connectivity.
- Regression: macOS 34, shared Swift 45 plus three XCTest, and iOS build passed. Twenty Mach-O including test frameworks showed no direct JSCore/WebKit links or JS/HTML/WASM resources.

## Pairing concurrency and device removal (2026-09-05)

- NativeLocalDeviceProvider shares first pairing by account/device: eight waiters send one request. One cancellation preserves others; all canceled/device removed cancels request.
- Late success after cancellation cannot repersist a grant; stale auth failure removes only the grant it used, preserving newer pairing.
- daemonRemoved or absence in a recovery snapshot closes all lanes, measurement/catalog polling, pending requests, and pairing. Auth invalidation closes router and account pairings.
- Tests found/fixed late ping repopulating removed-device state. Expired routes cannot reconnect; entirely empty connection details are removed.
- Real Keychain tests cover pairing cancellation/late responses; shared injected-control tests cover removal/snapshot/auth invalidation. Real server unpair, natural lease expiry, and more races remain.
- Final regression: macOS 37, shared Swift 47 (removal has three parameter cases), three XCTest, and iOS build passed.

## Authorization recovery and real revocation acceptance (2026-09-05)

- Added shared-router recovery cases for injected time advancing within the lease's two-second safety margin and device scope_denied. Both close old connections, increase generation, and complete two pending Git requests, preserving original requestID/operationID on replay.
- Real isolated Rust gateway localUnpair closes established session/elevated connections and prevents old-grant reconnect. Removing the last pairing for an Origin also removes its center allowlist entry, so HTTP upgrade may reject; with another same-Origin pairing, authentication may return grantUnknown.
- Shared Swift 48 (recovery has two parameters), three XCTest, and three targeted macOS gateway tests passed. This round added acceptance tests only, no app runtime changes.
- Natural lease-expiry end-to-end timing remains unproven, P2P absent, and old-pairing cache recovery after HTTP-upgrade rejection needs evaluation. Full connectivity remains unchecked.

## Startup address validation (2026-09-05)

- COFLUX_SERVER_URL uses the build default only when unset. Explicit empty values, relative paths, non-WebSocket schemes, credentials, fragments, and invalid ports stop initialization.
- Show native Invalid Server Address without constructing CofluxClient, reading tokens, falling back to another environment, or exposing potentially sensitive raw URL text. Correct environment and restart.
- Two tests cover defaults, invalid configuration, custom paths, IPv4/IPv6. CUA launched with invalid input and verified error/quit; restarting against isolated service restored workbench/terminals/local-direct indicator.
- All 39 macOS tests passed after startup changes.

## Native highlighting language expansion (2026-09-05)

- Added official Tree-sitter Rust 0.23.2, Python 0.23.6, Go 0.23.4, JSON 0.24.8, Bash 0.23.3, C 0.23.4 alongside JS/TS/JSX/TSX, all ABI 14 compatible.
- Extensions: rs, py/pyi/pyw, go, json/jsonc, sh/bash, c/h, plus .bashrc/.bash_profile/.profile. JSONC uses tolerant JSON parsing; complete JSONC extensions are not promised.
- Pin packages/queries/licenses together. App downloads no language code and executes no highlighted source.
- Highlight semantics/Unicode-range tests passed. CUA inspected real six-language Changes colors/scrolling in the isolated repo, then removed samples. Twenty Mach-O including tests/resources had no direct JSCore/WebKit or JS/HTML/WASM.
- All 40 macOS tests passed.

## Separate old/new diff syntax (2026-09-05)

- Fixed parsing removed/added lines as one source. Parse old deletion/context and new addition/context independently, then map to diff line ids. Deleted lines choose language using the pre-rename path.
- Parse disjoint hunks separately so missing-context unterminated strings do not contaminate later hunks. Only diff fragments are available, not full-file syntax context.
- Move line projection/token-overlap sorting to highlighting actor. Main creates attributed text, yielding/checking cancellation every 64 lines. Keep plain text visible until complete-file results publish.
- Tests passed old/new multiline Python strings, following return keyword, and separate hunks.
- Debug synthetic 6,000-line Rust diff: background parse/mapping ~329ms, 111 executions of a 2ms main-thread heartbeat, all keyword mappings correct. Excludes SwiftUI layout/scrolling and does not compare Web. All 42 macOS tests passed.

## Development credential isolation and port entries (2026-09-06)

- User reported Keychain prompts after resigning dev app. Debug now defaults to memory-only login without persistent identity provider, using relay for routine UI integration. Only COFLUX_KEYCHAIN_DEV=1 enables dev credentials/persistent direct identity. Release retains Keychain/native provider.
- Keychain integration tests skip by default and run only with COFLUX_KEYCHAIN_TESTS=1. Never count skips as passes. No old Keychain records accessed/deleted/modified.
- Match Web: every tab has an independent port menu, allowing background preview without activation; right side lists active-terminal ports. Show decimal ports without grouping separators.
- CUA login/ports showed no Keychain prompts. A real isolated terminal served 18089 with HTTP 200; after switching tabs, the first tab's menu still opened the browser.
- Test server generated HTTPS localhost preview URLs without TLS configured, so loading failed. No security bypass; end-to-end preview remains unaccepted. Test service/extra terminal/browser page cleaned up.
- Default regression: 42 tests, 35 passed, seven explicit Keychain skips, zero failures.

## IME commit and ordinary paste (2026-09-06)

- SwiftTerm 1.15 insertText handles NSString only, while AppKit can supply NSAttributedString. UploadTerminalView converts to plain text before superclass handling, retaining marked-text cleanup and keyboard protocol.
- AppKit callback tests show attributed candidates are not sent early; committing the intentional sample `你好😀` sends UTF-8 once, clears marked text, and allows subsequent input.
- CUA system-pasted a printf command and pressed Return; real PTY displayed the intentional sample `原生粘贴😀`. Tool reported clipboard timeout, but screenshot proved paste, so it was not repeated.
- This does not establish specific Chinese IME candidate selection/cancel or complex shortcuts. Routine testing still avoids Keychain.
- Regression: 36 passed, seven Keychain skips, zero failures.

## Sidebar width restoration (2026-09-06)

- Web keeps project collapse only for the current run, persists width, and resets to 260 on divider double-click. Native now resets/persists similarly, keeping 200–480 range.
- Build passed. CUA widened sidebar, logged out/in, confirmed restoration, then double-clicked to default. Dev used temporary sessions without Keychain.

## Add Device and P2P framing preparation (2026-09-06)

- Add Device matches Web's `npm i -g cofluxd && cofluxd up`, copy entry, explanation, and Done. Build/layout/Return/Esc close passed. Clipboard content not yet tested; installer command not executed.
- Added shared Swift P2PFraming/P2PFrameAssembler matching Web/Rust u32-BE length prefix, 16KiB messages, and 30MiB frame limit. Accumulate arriving bytes; invalid length permanently invalidates assembler and requires channel close.
- Six tests cover handwritten wire format, every two-part split, bytewise input, nonzero Data indices, 300KiB frames, trailing partial frames, invalid lengths, and complete 30MiB frames. Shared Swift 54 plus three XCTest passed without Keychain.
- Framing is not yet runtime-integrated. Native WebRTC, SDP, backpressure, transport racing/fallback, and real P2P integration remain; framing alone is not P2P delivery.

## Native WebRTC negotiation verification (2026-09-06)

- Added stasel/WebRTC 152.0.0, pinning SPM revision/binary checksum. Preserve upstream/distribution licenses in resources; complete binary dependency notices review still required before distribution.
- NativeRTCPeer uses reliable/ordered data-only channel and vanilla ICE with one SDP exchange after gathering. Close is idempotent; negotiation errors/cancel close peer. No audio/video tracks or Keychain access.
- Four native XCTest passed real local peers without STUN/TURN: identical 300KiB chunks/Chinese-emoji response and observable remote close, plus invalid SDP/closed-object/cancel cases. SDP has application/candidate and no audio/video m-lines.
- This only proves library/framing cooperation. TransportConnection send backpressure/receive queue, center offer/channel authorization, device peer reuse, transport races/fallback, and real Rust integration remain.
- Full macOS: 47 tests, 40 passed, seven Keychain skips, zero failures. Build passed; WebRTC has no direct JSCore/WebKit link.

## Native DataChannel transport adapter (2026-09-06)

- NativeRTCConnection implements shared TransportConnection with a dedicated background serial queue for framing/assembly/continuations. Concurrent sends serialize whole frames without interleaved fragments.
- Pause at 1MiB SCTP buffered amount, yield after at most 256KiB per round, bound queued bytes/frame count. Account receive data before callback enqueue, bound backlog/unconsumed frames, close on overflow. Limits cover adapter buffers only, not WebRTC/system/app total memory.
- Canceled sends may leave partial frames, so close stream and end all send/receive waits. Invalid prefixes, nonbinary messages, and send errors also close to avoid desynchronization.
- Five real native tests passed 30MiB plus later Chinese/emoji and reverse frames, eight concurrent full frames, invalid prefix rejection, cancel pending send ending receive, and 4,097 unconsumed small frames closing at limit.
- Center authorization/routing remain unconnected; next steps are offer/answer/channel messages, peer reuse, and transport races/fallback. Product P2P parity is not established.
- Full macOS: 52 tests, 45 passed, seven Keychain skips, zero failures.

## P2P negotiation and authorization provider (2026-09-06)

- Added shared P2PDeviceTransportProvider and native provider. Reuse peer by account/daemon/clientInstance; create first channel before generating offer. Each channel independently requests authorization with generation.
- Strictly match answer.connectionID, channelResult.channelID, and success before returning TransportConnection. Injected authorize handles center timeout/cancel; connection/DataChannel open separately wait at most 10 seconds.
- Closing each channel releases its reference; last closes peer. closeAll/remove invalidates old peers and late authorization cannot revive them. NativeRTCPeer gains usability checks.
- Four tests with real peers/controlled center responses passed two channels/one negotiation/two authorizations/independent close, bad channelID, late authorization after removal followed by fresh peer, and one canceled authorization leaving another usable. Shared Swift 54 plus three XCTest passed.
- Provider is not injected into App/DeviceRouter yet. Real center/worker signaling, correlation, disconnect cleanup, races/promotions/fallback, and end-to-end acceptance remain. No Keychain access.

## P2P routing and real Rust integration (2026-09-06)

- CofluxClient accepts provider and authOk ICE servers; DeviceRouter correlates offer/answer/channel responses. Center disconnect/account reset/device removal clears provider/pending requests.
- Integrated direct/P2P/relay races, relay promotion, and failure fallback; P2P failures initially back off 30 seconds. Sidebar uses Web Radio icon/P2P hint. App enables native P2P by default; Debug still avoids Keychain/persistent loopback identity.
- Three shared tests cover authorized activation, disconnect closure, relay fallback/promotion, later P2P failure, and cancellation during removal.
- Real isolated center/Rust worker passed native P2P PTY I/O/Git RPC. Closing peer falls back to relay in the same terminal, preserving output and accepting input. Test terminal closed/cleaned.
- macOS 57: 50 passed/seven skipped/zero failed; shared Swift 57 plus three XCTest passed. Fourteen Mach-O/resources had no direct JSCore/WebKit or JS/HTML/WASM.
- Full network parity remains: silent-link heartbeat, Web exponential backoff/stability window, unreachable-STUN fallback, cross-network NAT, and more three-way races. Local integration is not cross-network acceptance.
- iOS Simulator build passed without iOS/mobile feature changes.

## Silent-link liveness and P2P backoff (2026-09-06)

- Probe session lane immediately on activation then every 15 seconds. After five seconds without pong, retry immediately; two misses remove/recover connection. Heartbeats no longer depend on sidebar measurements or enter pendingRequests, avoiding pinned idle lanes.
- Match pong requestID/generation/current active connection. New connections inherit no timeout/miss. Old-worker empty_payload/unsupported_payload disables heartbeat for that device rather than endless false reconnects.
- P2P backoff now 5/10/20/40/80/160/300 seconds, reset by valid current-P2P pong; promotion waits remaining backoff. Current Web uses pong recovery, not the extra stability window previously described broadly.
- Four injected-short-timer tests cover silent P2P fallback without measurements, wrong pong not clearing timeout/correct pong clearing, quiet old-worker degradation, and in-flight heartbeat not blocking idle release.
- Shared Swift 61 plus three XCTest passed; macOS 50 passed/seven skipped/zero failed, including real P2P PTY/Git/fallback. No Keychain access.
- Review found Web preserves remote session channels for 15 seconds during brief center disconnect, while native still closes relay/P2P immediately. Align next. Unreachable STUN, real silent packet loss, cross-NAT remain.
- iOS App/test build-for-testing passed.

## Session grace period for brief center disconnect (2026-09-06)

- setControlDisconnected preserves existing relay/P2P session channels for up to 15 seconds on ordinary network loss. Only channels already active may continue I/O; new connections/elevated RPC/lifecycle fail immediately. Repeated disconnect/connecting does not extend grace.
- Successful reauthentication cancels timer and reuses channels; expiry closes remote channels/peers. Authenticated local-direct sessions retain offline semantics.
- setControlOnline(false) always explicitly revokes, even during grace. Credential changes/logout/authError/outdated get no grace; explicit suspend still immediately closes remote channels.
- Five shared tests cover grace I/O/RPC rejection, same-channel reconnect, no extension, explicit revocation, and immediate elevated closure. Shared Swift 66 plus three XCTest passed.
- Real isolated center/Rust test disconnects only client-center WS and blocks redial. Native P2P receives `grace:survived`, remains usable after recovery, then falls back to relay after P2P loss. Banner distinguishes center loss with usable terminals.
- iOS App/test build-for-testing passed, no Keychain access. macOS 50 passed/seven skipped/zero failed.

## Keep gathered candidates when STUN is silent (2026-09-06)

- NativeRTCPeer matches Web: wait at most three seconds for ICE, then continue with existing local SDP rather than fail on STUN timeout. Cancel/close/SDP errors still clean up.
- Real test binds a random local UDP port without replying and confirms receipt of STUN datagrams. After ~3 seconds, host-candidate SDP allows real peers to connect and transfer complete Chinese/emoji frames, without public STUN.
- macOS 58: 51 passed/seven skipped/zero failed; shared core/iOS unchanged.
- Host-candidate success does not prove cross-NAT. Return focus to full UI/interaction comparisons and same-load performance while retaining network gaps.

## Changes empty state and batched untracked reads (2026-09-06)

- CUA compared same-workspace Web/native empty states. Native refresh becomes a transparent text button with progress/disabled repeat click while loading. Window sizes were not yet identical, so not full pixel evidence.
- Read at most eight untracked files concurrently, matching Web, and merge in original path order. Preserve NUL separators/argv for newline/space names. One disappearing file does not hide other changes.
- Three tests passed 19 Unicode/newline paths peaking at eight requests, reverse results retaining order, single-file failure skip, and cancellation preventing later batches. No full regression this round.
- Restarted app CUA checked empty button. Real repo with 19 samples showed 19 files/+38 and file-18 after scrolling, with Chinese/emoji colors. Removed sample directory; UI returned to empty/refresh works. Fast local requests prevented loading screenshot.
- No same-load latency/frame comparison, so no speed claim. Preserve Web comparison page and continue full matrix/performance acceptance.

## Changes refresh and collapse acceptance (2026-09-06)

- Web changes-refresh.ts confirms added/deleted counts are not a content version; reactivation/manual refresh must fetch again.
- Real CUA: two-line Python sample changed REFRESH_PHASE_A to B at constant +2/−0. Collapse, switch to terminal, edit, return: collapse preserved and expansion showed B.
- While active, change to C with unchanged counts; refresh shows C. Remove sample directory; automatic empty state returns.
- Existing behavior already matched; no refresh implementation change. Evidence covers this untracked text case, not full UI/performance.
- Full macOS 61: 54 passed/seven skipped/zero failed, including batch reads and real P2P/PTY/Git/fallback. Log `/tmp/coflux-macos-093-refresh-full.log`.

## Sidebar trailing removal controls (2026-09-06)

- Added nonmain-workspace X and device Trash2 from Web sidebar, using same Lucide assets/existing confirmations. Main workspace has no remove action.
- Workspace hover fades trailing text; device rows reserve space. Icons appear on hover/keyboard focus, retaining accessible names/hit targets.
- Debug build passed. CUA clicked both entries for the sample native-client workspace/local-dev device, canceled, and verified both remain. No deletion performed; main-workspace AX has no delete button.
- Hover screenshots/Tab-focus acceptance remain. Only build/real entry/cancel verified; previous 54/seven result predates this change.

## Branch selection as anchored popover (2026-09-06)

- Replace modal sheet with native SwiftUI popover matching Web's 320px dropdown, anchored to project plus/workbench branch button. Buttons/context menu/shortcuts share controlled target; stale close callbacks clear only their target.
- Remove modal title bar; fixed search top, list height by item count capped at 240pt. Keep occupied disabled/current selectable and search/arrows/Return/cancel.
- CUA: plus opens AX popover below button without window overlay; search auto-focus, native-popover-check creation option, Esc close. ⌘N reopens/reset query. Switch menu shows current native-ui and occupied main; Return closes current branch without change.
- Initial short-list screenshot showed unnecessary scrollbar from height estimate. Set 28pt rows/2pt gap and 30pt per item. No workspace created or branch changed; final tweak initially awaited observation.
- Final CUA showed both entries and no AX scrollbar. Full macOS 61: 54 passed/seven skipped/zero failed, including sidebar/menu changes. Log `/tmp/coflux-macos-093-popover-full.log`.

## Terminal-close confirmation copy and shortcut (2026-09-06)

- Match Web requestCloseTask: title includes catalog terminal name, falling back to Terminal. Explain shell termination, permanent tab removal, and no retained output. Button becomes Stop and Close. Mechanism unchanged.
- Debug build passed. CUA close button showed Terminal 1 in title/full explanation; Esc preserved terminal. ⌘W opened same confirmation; Cancel preserved window/terminal.
- No actual termination/deletion, new tests, or full regression. Different background names/empty-name fallback await real UI samples.

## Tab close visibility and long-title hints (2026-09-06)

- Match Web: close icon appears on tab hover or close-button keyboard focus. Keep hit target/accessibility, add stable tab.close id, use 60% accent on inactive hover.
- Use native full-title tooltip, avoiding clipping of custom overlays inside horizontal ScrollView. This is a native overflow-hint difference without JS. OSC nonempty override/empty fallback unchanged.
- Debug build passed; CUA shows icon hidden when unhovered while AX button remains. Clicking opens correct confirmation; cancel preserves session.
- Real hover/focus visibility/long-OSC tooltip acceptance remains; no full suite repeat or inference from build success.

## Preserve image orientation during reencoding (2026-09-06)

- Web createImageBitmap versus ImageIO review found native CGImage-only reencoding dropped EXIF and rotated portrait uploads incorrectly. Apply full-size ImageIO rotation/mirroring for orientations 2–8 before PNG/JPEG. Supported under-budget formats remain byte-preserved with metadata.
- Two tests: orientation-6 120×80 TIFF becomes 80×120 PNG; deterministic-noise 1800×1200 JPEG >3.5MB compresses within budget at 1200×1800. Assert input orientation to avoid false conclusions.
- Initial large-image test inferred dictionary orientation as Double, which ImageIO dropped. Explicit [CFString: Any] fixed metadata and output assertions.
- Six TerminalUploadTests passed, including IME/bracketed-paste/file limits/TIFF. Log `/tmp/coflux-macos-093-orientation.log`. No user images/clipboard; real drag/drop/remote viewing and mirrored pixel checks for 2–5/7–8 remain.

## Real image upload and background-tab integration (2026-09-06)

- Expanded isolated center/Rust test starts orientation-6 TIFF conversion/upload through UploadTerminalView callback, immediately switches tabs, and confirms result stays with original coordinator.
- Read PNG back through real exec/base64; ImageIO verifies 80×120. Returning to original terminal clears pending path and displays it there. Remove uploaded file and Ctrl-U input, never execute the image path.
- First contiguous-string assertion failed at visual wrapping of a long path. Diagnostics confirmed cleared pending/valid control/echoed path. Test alone now ignores visual breaks in that UUID path; upload behavior unchanged.
- Real targeted integration passed in 3.667 seconds, retaining switch/upload/OSC/reconnect/takeover/restart coverage. Log `/tmp/coflux-macos-093-image-integration.log`. No user clipboard; does not prove OS drag/paste events or full regression.

## Background cancellation during upload preparation (2026-09-06)

- Hold explicit detached task and forward cancellation with withTaskCancellationHandler. Previously terminal close prevented sending but could keep compressing the entire image.
- Cooperative checks before/after file reads, after decode/orientation, each resize/JPEG encode, and caller cancellation after background return prevent late uploads.
- Individual ImageIO/FileHandle calls cannot be interrupted until they return; this does not cancel already-sent remote RPC.
- Deterministic test starts work, cancels caller, then releases gate, asserting background Task.isCancelled and caller CancellationError rather than merely discarding output. No clipboard/Keychain.
- Full macOS 64: 57 passed/seven skipped/zero failed, covering cancellation/large-image orientation/budget/real upload-switch. Log `/tmp/coflux-macos-093-upload-cancel-full.log`.

## Device HOME-terminal creation busy state (2026-09-06)

- Match Web's device entry centered on HOME terminal. Add per-device reentrancy guard, busy/disabled button, HOME error/offline explanation. Stop simultaneously showing Select a Workspace in device empty state.
- Busy spans HOME query to directory-workspace arrival, with 15-second retryable timeout using async sleep. Center errors converge via global lastError like Web; no creation correlation id exists. Account changes prevent the post-query create request.
- Debug build passed. Real center/Rust concurrent creation test confirms two calls create one task, clear busy/no error, and clean up task. Log `/tmp/coflux-macos-093-device-create-test.log`.
- Existing isolated HOME workspace opens directly; it was not deleted to force empty state. First-empty busy screenshot, timeout/offline retry, and full regression remain.

## Preview-fixture protocol configuration (2026-09-06)

- Harness lacked COFLUX_DEV, making preview default HTTPS despite HTTP listener. Like proxy.test.mjs, dev-fixture now explicitly sets COFLUX_PROXY_SCHEME=http, p.localhost, and isolated port.
- Point preview authentication at the same isolated Web, default http://127.0.0.1:15273 with COFLUX_NATIVE_WEB_URL override; record webURL in metadata. Preserve gate/one-time code/account checks; no production changes/security bypass.
- node --check passed. Existing fixture was not restarted, so new configuration applies next launch. Native-click-to-browser success is not yet claimed; preserve/clean existing samples and restart isolated environment for acceptance.

## Separate preview environment and browser authorization (2026-09-06)

- Original 19873 service remains healthy but its fixture parent exited. Preserve it and start center 19874/Web 15274. Add COFLUX_NATIVE_FIXTURE_FILE to avoid overwriting old metadata.
- Optional COFLUX_NATIVE_PREVIEW_FIXTURE=1 starts a real task-PTY HTTP sample on 18091 and waits for portsUpdated before ready. Fixture exit uses harness cleanup. Start with node --import tsx; plain node fails TS protocol .js import resolution.
- After CUA login to 15274, main workspace shows :18091 and actual URL http://device-18091-p.localhost:19874. Navigating that observed URL first showed preview authorization, then reused login and displayed the intentional test text `原生端口预览已连通` and PREVIEW_NATIVE_093. No certificate/gate bypass or cookie injection.
- Web link clicking did not create a tab in the controlled browser list, so validation used the observed URL directly. This is not native-app click acceptance; next connect native to 19874 and test controls.
- Metadata /tmp/coflux-native-093-preview-fixture.json; fixture exec session 47943, Vite 8514; browser id=1, tab 2 Web/tab 3 preview preserved for continuation. Old 19873/15273 remain running.

## Native port button to system browser acceptance (2026-09-06)

- Debug build setting COFLUX_DEBUG_SERVER_URL passes through generated Coflux-Info.plist, defaulting to 19873; environment COFLUX_SERVER_URL wins. Release ignores debug key. This build uses 19874, verified in final plist, without changing production address.
- CUA native login showed real 18091. Clicking Open Port 18091 launched Safari at 15274/proxy-auth. Isolated admin/admin login reached device-18091-p.localhost:19874 with the test confirmation text and PREVIEW_NATIVE_093.
- Chose Later on Safari password prompt, saving no test password. Closed only the newly created preview tab. No gate/certificate bypass or cookies injected.
- Evidence covers active-terminal right button→system browser→isolated auth→real PTY HTTP. Background menus, disappearing ports, production HTTPS/HMR remain. Running app uses 19874; next unoverridden build returns to 19873.
- Build log /tmp/coflux-macos-093-preview-build.log; no full regression yet after explicit plist addition.

## Background-terminal port menu browser acceptance (2026-09-06)

- Created/kept Terminal 2 active in native 19874, id d0372db8-b306-4799-ba54-83e236d98440; selected :18091 from background Terminal 1's forwarded-port menu.
- New Safari tab displayed the real test confirmation/PREVIEW_NATIVE_093 using existing authentication. After closing it, native screenshot still highlighted Terminal 2 and right side lacked Terminal 1's active-port entry. Preview did not activate the background tab.
- Preserve second tab in isolated preview fixture for switching/disappearance acceptance, leaving old 19873 untouched. Production HTTPS/HMR and entry removal after process stop remain.
- Full macOS 65: 58 passed/seven Keychain skips/zero failed, including device reentrancy/upload/network integration and explicit plist/debug configuration. Log `/tmp/coflux-macos-093-preview-full.log`.

## Preview port stop and recovery (2026-09-06)

- CUA Ctrl-C stopped preview-server.cjs in isolated Terminal 1. After direct 18091 failed, AX confirmed both tab menu and right-side Open Port 18091 disappeared automatically.
- Rerunning node preview-server.cjs restored HTTP and both entries. Clicking the restored right entry displayed PREVIEW_NATIVE_093 in Safari, proving rediscovered links work.
- No product changes or repeated suite. Covers process stop/restart only; daemon disconnect, production HTTPS/HMR, other network edges remain.
- Attempting to close this Safari tab reported changed browser state; closure was not confirmed and no other tabs were touched. Isolated preview service is running again.

## No-terminal empty state and takeover warning (2026-09-06)

- Match Web workspace-terminal.tsx titles/shell explanation/⌘T hint for empty workspace/device. Use a true 20pt icon in a 40pt outlined rounded frame; font previously did not resize a fixed-size icon.
- Add Unplug, warning foreground/10% background/20% bottom border, and right-aligned recovery button after takeover, matching Web semantics/layout without changing takeover/restart.
- Debug build passed. CUA opened empty native-ui workspace at 19874; AX/screenshot showed title/explanation/icon/create button. No terminals created/deleted.
- Warning only compile-checked so far, without new two-client visual capture/full regression. Previous 58/seven predates this presentation change.

## Takeover warning and real input from both clients (2026-09-06)

- In the same 19874 terminal, Web Retake Control immediately produced native warning/Unplug/right recovery button, confirmed by screenshot.
- Native Ctrl-C while lacking control left HTTP serving PREVIEW_NATIVE_093. Native Retake Control removed warning and locked Web input. Native Ctrl-C then made 18091 fail, proving PTY input control returned rather than merely hiding a banner.
- Restarted node preview-server.cjs and verified HTTP recovery. No code/unit-test changes. This proves local Web/direct/native handoff, not cross-NAT/loss behavior.

## Reclaim UI state for deleted entities (2026-09-06)

- reconcile now prunes terminalTitles, activeTasks, showingChanges, upload/drop sets, removed-project collapse, and device errors against current task/workspace/session catalogs. Previously only visited sets/activation requests converged, leaving stale records after repeated creation/deletion.
- Preserve surviving background tasks/sessions by id across tab changes. Prune only after a catalog snapshot, never interpret initial unloaded login as deletion.
- Expanded real lifecycle test closes second task, injects old session/workspace state, reconciles it away, and retains live title. Full login/switch/upload/reconnect/takeover/restart case passed in 3.632 seconds. Log `/tmp/coflux-macos-093-state-pruning.log`.
- No long memory curve/full regression. State convergence does not prove leak freedom or speed over Web.

## Logout cleanup and stale-request isolation (2026-09-06)

- Logout clears titles, uploads/drops, pending branches, project collapse, device busy/errors, close confirmation/dialogs, retaining window preferences such as sidebar width.
- HOME requests capture login generation; late response/error/defer after logout cannot alter a later login, even same account.
- Eight WorkbenchStateTests passed, log `/tmp/coflux-macos-093-logout-race.log`. New test pauses device request at relay authorization, logs out/reinjects same-account auth/snapshot, and verifies stale completion cannot clear new busy/overwrite new errors. Also verifies cleared identity and retained 320pt width.
- Injected-control test uses no external connection/Keychain and does not replace real login UI/full regression/separate late-success acceptance.

## Port-menu icon alignment (2026-09-06)

- CUA found native Menu used router asset's intrinsic size, ignoring SwiftUI 12pt frame, and added a chevron. Web uses 12px Router/20px button/hasChevron=false.
- Keep native AppKit menu; use a separate copied template NSImage with intrinsic 12pt, 20pt button, hidden chevron, and Forwarded Ports accessibility description. Do not mutate shared asset.
- Debug build passed with SwiftTerm bundle incremental-node warning, log `/tmp/coflux-macos-093-port-icon.log`. After restart, screenshot showed correct icon/no chevron; AX named it. With Terminal 2 active, Terminal 1 menu listed :18091; Esc preserved Terminal 2 selection.
- Covers icon/menu open-cancel/background selection, not repeated browser/full-suite acceptance. Full screen comparison remains.

## Diff long lines and row layout (2026-09-06)

- Match Web changes-view.tsx by removing extra two-column line numbers, left-aligning hunk headers, and restoring separate 12pt +/- slots/semantic colors.
- Fixed native Text wrapping and leading clipping after fixedSize-only changes. Measure parsed content width once off-main with native monospace font and give lazy rows explicit horizontal width, keeping single lines without JS.
- Debug build passed, log `/tmp/coflux-macos-093-diff-lines.log`. CUA showed preview-server.cjs from leading require through trailing listen(18091,"127.0.0.1") after horizontal scroll, with colors intact.
- Horizontal scroll still applies to the whole file column, unlike Web's per-file content. Long-file performance/multifile widths/refresh style/full regression remain; no full Changes parity claim.

## Independent per-file horizontal scrolling (2026-09-06)

- Outer Changes scroll is vertical only; each file's code scrolls horizontally, with header/collapse/statistics fixed to card width. Long filenames middle-truncate with full tooltip.
- Explicit row heights size nested horizontal areas to content, avoiding short files filling the viewport. Keep LazyVStack; large-file performance remains unmeasured.
- Debug build passed, log `/tmp/coflux-macos-093-diff-scroll.log`. Added a second isolated long-line file: first scroll=1 while second=0; screenshot showed first tail/second start with both headers/stats visible.
- Collapse second and refresh preserves collapse/first scroll. Temporary file deleted without affecting preview service. No full regression or large-diff performance claim.

## Full regression and artifact review after Changes updates (2026-09-06)

- Full macOS XCTest 67: 60 passed/seven explicit Keychain skips/zero failures. Covers latest logout/generation races, image upload, native highlighting/P2P, and real terminal lifecycle. Log `/tmp/coflux-macos-093-diff-full.log`.
- Debug test-host scan deduplicated real paths: 14 Mach-O including XCTest, no direct WebKit/JavaScriptCore or JS/MJS/CJS/HTML/HTM/WASM resources. Report `/tmp/coflux-macos-093-artifact-audit.json`. No system indirect-dependency scan; not Release acceptance.
- Full current-suite regression does not cover every UI/feature. Real long-diff scrolling, cross-NAT, screen comparison, and distribution remain.

## Diagnosing 5,000-line diff stalls and rendering visible rows (2026-09-06)

- A real 5,000-line Rust file with Chinese/emoji made old nested LazyVStack time out CUA reads. Sampling showed main-thread SwiftUI/AppKit layout: 100% CPU/RSS 574176KiB, later 856944KiB. Sample `/tmp/coflux-macos-093-large-diff.sample.txt`.
- Use cumulative row heights/binary search for visible range, preserving full file height/per-file horizontal scroll and creating rows only within viewport plus 100pt overscan. Update geometry with outer vertical scrolling, not instantiate all rows based on horizontal-container height.
- DiffRowLayout test traverses 5,000 rows with differing-height hunks every 100, asserting at most 47 rows in a 700pt viewport, no gaps, and end/empty boundaries. Three UnifiedDiffTests passed, log `/tmp/coflux-macos-093-diff-window-tests.log`.
- Same real file opened/paged through CUA: initial AX ~40 nearby rows, page moved near 0028–0076 continuously. Post-fix idle snapshot CPU 1.4%, RSS 174368KiB. Debug snapshots are not rigorous benchmarks or same-load Web comparisons. Bottom scrolling/highlight latency/frame rate/full regression remain.
- Temporary large file deleted, preview sample kept. Prior 60/seven full suite predates visible-row changes.

## Long-diff tail and deletion convergence (2026-09-06)

- CUA scrolled 5,000 lines to bottom, showing continuous ~4963–4999 with Chinese/emoji/colors. Following preview-server.cjs joined correctly and scrolled independently.
- Removing the large file at bottom exposed outer LazyVStack height caching, leaving toolbar/blank page. Since rows are already viewport-controlled, replace outer file container with VStack for deterministic height while retaining row-demand rendering.
- Debug build passed, log `/tmp/coflux-macos-093-diff-shrink.log`. Repeated load→bottom→delete→refresh restored short file at top without blankness. Test file cleaned.
- No full suite repeat. Many-file layout cost/continuous frames/same-condition Web comparison remain.

## Changes refresh and error-recovery presentation (2026-09-06)

- Refresh now uses same-source 14pt Lucide refresh-cw/24pt button/Refresh Changes hint. Add circle-alert, centered muted error, and busy/disabled Retry. SVG sync is build-time only, no runtime script.
- Trim Git errors, prefer error then stderr, and fall back to exit-code copy if both empty, preventing empty errors leaving apparent loading.
- Debug build passed, log `/tmp/coflux-macos-093-diff-controls.log`. CUA confirmed icons; temporarily setting isolated repo core.bare=true produced real must be run in a work tree with icon/text/retry. Retrying still showed error.
- Restored/read back core.bare=false. Catalog statistics triggered automatic refresh and restored preview-server.cjs before manual retry, so do not record manual recovery success. Busy visual duration/full regression not tested.

## Cooperative cancellation during diff preparation (2026-09-06)

- Direct await detached.value did not cancel background parsing/measurement when the page task canceled. Extract existing upload BackgroundPreparation to retain handles/forward cancellation through handler; migrate upload callers without behavior change.
- Add throwing cancellation entry to UnifiedDiff, checking at start/per line; measurement checks per file/line. Existing synchronous parse remains nonthrowing for callers.
- Eleven UnifiedDiffTests/TerminalUploadTests passed, log `/tmp/coflux-macos-093-background-cancel.log`: background observes parent cancel, 5,000-line parse stops at check 32, and upload/image/IME cases remain.
- String splitting/font measurement system calls must return to checkpoints before stopping. No new switching-latency/full-suite measurement; no instant-cancel-at-any-scale claim.

## System clipboard multiline-text acceptance (2026-09-06)

- CUA native paste through system clipboard into isolated 19874 Terminal 2 pasted printf with Chinese, emoji, two lines, and trailing newline.
- Tool timed out awaiting clipboard-read confirmation, but screenshot showed complete text in zsh bracketed-paste selection. Did not resend. Output file absent before Return proves trailing newline did not execute early.
- After Return, prompt recovered. Independent output read matched all 32 UTF-8 bytes, including intentional `第一行中文😀`, English second line, and newlines. Test file deleted.
- Proves system text paste, not image paste/file drop/real IME candidate selection. Tool timeout is not tool success; app behavior is supported by screenshot/bytes. No business-code changes or suite rerun.

## Clear drag overlay when permissions change (2026-09-06)

- Web uses drop uploads for files and primarily image paste; no extra file-paste semantics added. Prepared Finder test window was closed/cleaned; full cross-window drag still incomplete.
- Fixed overlay persisting when control is lost/upload starts and draggingUpdated rejects. Entry/update/final preparation re-evaluate current permission/file pasteboard and clear hint on rejection.
- Eight TerminalUploadTests passed, log `/tmp/coflux-macos-093-drag-revoke.log`. Named private NSPasteboard test accepts file→rejects revoked permission→accepts recovery→rejects text, with hints true/false/true/false. User general clipboard untouched.
- Covers shared actual acceptance logic, not full NSDraggingSession or successful cross-window upload; real acceptance remains.

## Latest full regression and login-draft fix (2026-09-06)

- Full macOS XCTest 70: 63 passed/seven Keychain skips/zero failed, log `/tmp/coflux-macos-093-latest-full.log`. Includes prior diff viewport/cancel/upload/drag permission changes; following login changes occurred afterward.
- Review found replacing LoginView during auth destroyed account-local state, requiring reentry on failure; Web keeps draft outside. Move native account draft to RootView binding: failure preserves account, clears password, focuses password.
- Debug build passed, log `/tmp/coflux-macos-093-login-draft.log`. CUA wrong-password admin login showed retained admin/empty focused password after real rejection; correct password plus Return entered workbench.
- No TODO/FIXME/unimplemented placeholder found in native source, which does not prove completeness. Screen comparison/system image paste/drop/real IME/network/signed distribution remain.

## System Preview image copy and terminal paste (2026-09-06)

- Created 32×24 RGBA gradient PNG, opened in Preview, selected/copied, then actual Command-V in isolated Terminal 2 read system image clipboard, uploaded to daemon, and inserted returned paste-UUID.png path.
- Screenshot showed bracketed-paste input without execution. ImageIO/CoreGraphics decoded source/upload with identical sRGB RGBA; both 32×24 and byte-identical pixels. Script `/tmp/coflux-image-check-093.swift` cannot rerun directly because test input was cleaned.
- Ctrl-U cleared input, Preview test window closed, source/upload deleted. No other images/uploads accessed/deleted.
- Proves actual system image copy/paste, not merely onImage callback. Oversized images, IME candidates, Finder cross-window drop remain. No business-code changes/full-suite repeat.

## Bundle third-party licenses (2026-09-06)

- Added scripts/sync-notices.py to verify checkout full revisions against current Package.resolved and collect original LICENSE/NOTICE files, including dependency subdirectories, WebRTC binary framework license, and original Lucide license.
- Generated 14 pinned dependencies including build tools, WebRTC framework, and icons: 83764 bytes in Sources/ThirdPartyNotices.txt, bundled as resources. Help offers Third-Party Licenses through system text viewer.
- Debug build, generator --check, and byte comparison of bundled/source notices passed; log `/tmp/coflux-macos-093-notices.log`. No full regression or actual menu click.
- Complete WebRTC internal component distribution notices and current Web illustration source/license still need verification; collecting resources is not completed distribution review.

Regenerate: `python3 apps/macos/scripts/sync-notices.py --source-packages /tmp/coflux-macos-093-build/SourcePackages`; add --check to detect stale notices after upgrades.

## Optimized Release build and reproducible artifact audit (2026-09-06)

- First optimized Release build in this effort passed with temporary CODE_SIGN_IDENTITY=-, without developer certificates or launching persistent Release credentials. Final log `/tmp/coflux-macos-093-release.log`.
- Fixed two Release-exposed source warnings: Optional.map trailing-closure ambiguity and unused import-wizard binding. Rebuild removed them; Xcode AppIntents metadata-skip and SwiftTerm resource-bundle incremental-node warnings remain.
- Added scripts/audit-bundle.py: real-path deduplicate Mach-O, inspect script resources/direct WebKit/JavaScriptCore links, compare notices to source, verify codesign integrity. Current Release main contains x86_64/arm64; two unique Mach-O (main/WebRTC) passed. Report `/tmp/coflux-macos-093-release-audit.json`.
- Command: `python3 apps/macos/scripts/audit-bundle.py /tmp/coflux-macos-093-build/Build/Products/Release/Coflux.app`. Does not establish Developer ID/notarization/system indirect dependencies/runtime behavior or replace distribution acceptance.
- Official WebRTC 152.0.0 release metadata points to upstream 6f37672d358475cd17544121a12494da454d85fb (branch-heads/7977). Assets contain only xcframework/dSYM; build scripts copy top-level LICENSE only. Internal component notices remain incomplete. Current Web confirms illustration source ayotomcs.me/claude-mascot; exact license remains unverified.
