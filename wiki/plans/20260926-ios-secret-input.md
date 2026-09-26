# Plan 20260926-ios-secret-input: answer agent secret requests from the iOS app

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ad415759..HEAD -- packages/swift-client/Sources packages/swift-client/Tests apps/ios proto`

## Status

- Priority: P2
- Effort: M
- Risk: MED — a secret value handled in a second client; no protocol or daemon change
- Depends on: wiki/plans/20260926-agent-secret-input.md (DONE on this branch)
- Category: feature
- Execution: subagent(opus) — departure check after the user added iOS to the requirement (reused the desktop slice's answers)
- Stop after: implementation — same departure check (plan audit, then continue)
- Plan review: audit — same departure check
- Workspace: current — already in the linked worktree `.claude/worktrees/20260926-agent-secret-input` on `dev/20260926-agent-secret-input`
- Planned at: `ad415759`, 2026-09-26

## Requirement

The desktop slice (`wiki/plans/20260926-agent-secret-input.md`) lets an agent in a coflux terminal run `coflux secret ask NAME --reason "…"`: the worker publishes a pending request (metadata only) through the center, every desktop shows a card over the requesting terminal, and the user's value goes straight to the worker over the end-to-end Device channel, where the first answer wins. The user then required that **the iOS app supports this too**: a user away from the desk must be able to see a pending request and answer it from the phone.

### Product conclusions (confirmed with the user)

- **Discovery**: a workspace with a pending secret request shows 「等待输入密钥：NAME」 on its row in the workspace list, taking precedence over the progress subtitle. Inside the workspace, the terminal page that has a pending request is marked.
- **Answering**: opening the requesting terminal shows a card anchored at the **top** of the terminal page (below the status strip, so a raised keyboard never covers its buttons) with the same content as desktop — source (device · workspace · terminal), the NAME, the reason clearly labelled as written by the agent, a masked input (`SecureField`; paste and system password autofill allowed), Provide / Decline, and a close button that counts as cancel. **Neither voice input nor the terminal input area ever captures this field**: the value never reaches speech recognition or the PTY.
- **States**: the same as desktop — pending; submitting; provided (card disappears); answered elsewhere (closes); expired (closes); submit failed (input kept, retry). First answer wins across desktop and iOS. *(revised on plan audit)* The desktop rules, which iOS copies exactly (`apps/desktop/src/renderer/components/workbench/secret-request.ts:56-70`, `secret-request-card.tsx`):
  - the close button sends CANCEL to the worker (the agent prints `cancelled`); it is not a local hide;
  - ack mapping: `ACCEPTED` → closed per the kind sent; `ALREADY_ANSWERED` → answered elsewhere; `EXPIRED` / `UNKNOWN_REQUEST` → expired; `INVALID` → failed with 「设备拒绝了这个值：不能为空、不能超过 64 KB，也不能含 NUL 字符」; transport error → failed, input kept;
  - expiry is driven by the live set (the worker withdraws and republishes; the request leaves the set and the card disappears), not by a local timer — showing `expiresAt` is decoration only;
  - several cards on one terminal are ordered by `createdAt` ascending; Provide is disabled while the field is empty;
  - answering a request that is no longer in the pending set short-circuits to answered elsewhere without sending a frame (`packages/client/src/store.ts:1286-1287`).
- **Not done**: system push notifications (there is no APNs infrastructure) and an inbox (iOS has none). Requests are visible only while the app is open.
- **What the user observes when done**: with an agent waiting on `coflux secret ask`, the phone's workspace list shows the marker; opening the terminal shows the card; providing a value makes the agent print `provided` and the desktop card close; declining prints `declined`.

## Decisions & tradeoffs

- **No protocol, daemon, or server change.** iOS consumes exactly what the desktop slice added: `ServerToClient.secret_requests_updated` (a per-device full replacement of the pending set), `DeviceEnvelope.secret_answer` with kind PROVIDE / DECLINE / CANCEL, and the worker's `secret_answer_ack` (ACCEPTED / ALREADY_ANSWERED / EXPIRED / UNKNOWN_REQUEST / INVALID). The generated Swift types are already on this branch. Rejected: any iOS-specific wire shape. Based on: `proto/coflux/v1/client.proto` (`SecretRequestsUpdated`), `proto/coflux/v1/device.proto` (`secret_answer = 90`, `secret_answer_ack = 91`), `packages/swift-client/Sources/CofluxProtocol/Generated/coflux/v1/*.pb.swift`.

- **The Swift client mirrors the TS store semantics** *(revised on plan audit)*: pending requests keyed by request id, replaced per device on each `secretRequestsUpdated`. The TS store clears them in exactly four places — local session exit (`store.ts:558-583`), `stateSnapshot` (858-859), `daemonRemoved` (879), `logout` (1163); "device offline" is not a client clear — the **center** broadcasts an empty set when the daemon disconnects and re-sends per device on subscribe (`apps/server/src/hub.ts:2818-2819`, `2908-2909`). Swift counterparts: a new `apply` case next to `.sessionAgentsUpdated` (`CofluxClient.swift:604-607`), `.stateSnapshot` (529), `.daemonRemoved` (549), `markSessionExited` (670), `logout()` (281). Also clearing in the Swift-only `clearDerivedState(for:)` (693) alongside `sessionAgents` is harmless. `suspend()` does not clear (a fresh snapshot on resume does). Rejected: clearing on connection status changes — the TS client does not. Landmine: `apply`'s `default: break` (614) silently swallows a forgotten case with no compile error.

- **The answer goes over the session lane via the router's own `request(lane: .session)`, not the elevated lane** *(revised on plan audit)*. The worker requires only `SESSION_CONTROL` (`crates/worker/src/device.rs:4124-4126`); the center grants the Tailcat session lane `sessionRead`+`sessionControl` (`apps/server/src/tailcat-rendezvous.ts:9`) and the iOS transport checks that (`packages/swift-client/Sources/CofluxClientCore/TailcatDeviceTransport.swift:164-167`). A pending session-lane request is itself lane demand (`DeviceRouter.swift:1075-1079`, `1381-1412`), so the router opens the lane even if the terminal is not attached — no extra retain is needed, and no `hasSessionControl`/attach precondition may be added (answers are authorised per channel, not per attach). If the lane cannot be opened (center offline: `DeviceRouter.swift:769`, `891`), the call throws and maps to failed. Shape: an internal router method modelled on `execute` (`DeviceRouter.swift:577-588`, 20 s timeout built in) returning `Coflux_V1_SecretAnswerStatus`; the failed mapping and a public result enum mirroring `SecretAnswerResult` (`packages/client/src/store.ts:56-58`) live in `CofluxClient.answerSecretRequest`. Rejected: the elevated lane — it carries RPC/lifecycle, not session control.

- **The value lives only in the card's view state** and is sent once; it is cleared when the card closes. It is never logged, never put in the store, never written to disk, never passed to the terminal input area, the speech pipeline, or `UIPasteboard`. Swift strings cannot be reliably zeroed; clearing the state is the extent of it, same as the desktop renderer. Rejected: keeping the value in `CofluxClient`.

- **The card never steals focus and has its own field state** *(revised on plan audit)*: it does not auto-focus the `SecureField` or raise the keyboard on appearance. The field is bound to the card's own `@State`, **never** to the input area's `draft` and never inside `TerminalComposeOverlay` — voice results only flow through `deliver → sendText → client.sendInput` or into `draft` (`WorkspaceDetailView.swift:466-470`, `582-599`; `TerminalInputArea.swift:637-700`), so a separate binding is what keeps speech and the terminal input out of it. `.textContentType(.password)` lets system autofill offer passwords.

- **Tests**: no new test is required by this plan — a break here is visible the first time the card is used (AGENTS.md "Test harness"). If the executor extracts pure logic (phase after an ack, per-device replacement), a small Swift Testing case alongside the existing ones is welcome, not required.

## Direction

### Milestone 1: Swift client state and router method

`CofluxClient` exposes the pending secret requests (per terminal/task and per workspace) with the lifecycle above, and an `answerSecretRequest(requestID:answer:)` that routes to the request's device over the session lane and returns the worker's acknowledgement or a failure. Validation: `swift build --package-path packages/swift-client --force-resolved-versions` and `swift test --package-path packages/swift-client --force-resolved-versions` exit 0.

### Milestone 2: iOS UI

The workspace list marker (a method next to `workspaceProgress(workspaceID:)`, `CofluxClient.swift:86-93`, used by the subtitle at `WorkspaceListView.swift:117-165`, secret first), the per-terminal page marker on the tab chip (`WorkspaceDetailView.swift:372-392`), and the card over the terminal with every state listed under Requirement. Follow the existing iOS view conventions (`Theme.swift`, the glass style used by the other overlays) and keep new copy in Chinese like the rest of the app. Validation: `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -allowProvisioningUpdates` → `** BUILD SUCCEEDED **`.

Milestone 2 needs milestone 1. They share no files but are sequential; run as one package.

## Landmines

- **`xcodebuild` needs the native transport framework**: run `node scripts/build-ios-transport.mjs` first (artifact `apps/ios/Frameworks/` is gitignored; the script pins `GOTOOLCHAIN=go1.27.1` and may download it). Without it the build fails at compile time (the bridging header imports `libcofluxtailcat.h`).
- **Package resolution can rewrite tracked lockfiles**: `packages/swift-client/Package.resolved` and `apps/ios/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` are tracked. Use `--force-resolved-versions` for `swift` commands and check `git status` after `xcodebuild`; restore them if only a re-resolve changed them.
- **CI never runs Swift**: the commands below are the only gate.
- **Signing may stall `xcodebuild`**: append `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` if it does — this row is a compile check.
- **Response matching goes through `responseRequestID(_:)`** (`DeviceRouter.swift:1650-1663`, used by `finishPending` at 1520-1522), **not** `requestID(of:)` (1632, prepared operations only). Add `case .secretAnswerAck(let value): return value.requestID` there; without it every answer times out after 20 s while the worker already accepted it, and a retry then reads as answered elsewhere.
- **The terminal page is immune to the keyboard** (`.ignoresSafeArea(.keyboard)`, `WorkspaceDetailView.swift:151`, `179`): a card pinned to the bottom (as on desktop) gets its buttons covered when the SecureField raises the keyboard. Anchor it at the top of the task page below the status strip.
- **Never bind the secret field to `draft` or reuse `TerminalComposeOverlay`**: that is the only way voice results or the input area could reach it.
- **Known shared edge (desktop too, non-blocking)**: if the lane drops between send and ack, `flushLane` resends `secretAnswer` on the new channel (`DeviceRouter.swift:1163-1169`) and the worker answers `ALREADY_ANSWERED`, so the user's own answer reads as answered elsewhere. The value went to the same worker; no leak.
- **Request/response matching in the Swift router is by request id extraction per payload type** (`DeviceRouter.swift:1635`): a new response type that is not added there never resolves its waiter and times out.
- **Do not touch** `proto/`, `crates/`, `apps/server`, `apps/desktop`, `packages/client`: the desktop slice is verified and frozen.

## Scope

In scope:
- `packages/swift-client/Sources/CofluxClientCore/**`
- `packages/swift-client/Tests/CofluxClientCoreTests/**` (optional tests only)
- `apps/ios/Coflux/**`
- `wiki/plans/README.md`

Out of scope:
- `proto/`, generated code, `crates/`, `apps/server`, `apps/desktop`, `packages/client`, `tests/` — desktop slice, frozen
- APNs / push, an iOS inbox — non-goals
- `apps/ios/Coflux.xcodeproj` — the project uses synchronized folder groups (`PBXFileSystemSynchronizedRootGroup` in `project.pbxproj`), so new Swift files under `apps/ios/Coflux/` are picked up without editing it

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Swift client build | `swift build --package-path packages/swift-client --force-resolved-versions` | exit 0 |
| Swift client tests | `swift test --package-path packages/swift-client --force-resolved-versions` | exit 0 (98 tests at baseline) |
| iOS transport framework | `node scripts/build-ios-transport.mjs` | exit 0 |
| iOS app compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -allowProvisioningUpdates` | `** BUILD SUCCEEDED **` |
| Device walkthrough (acceptance) | TestFlight or Xcode run on the user's iPhone against a daemon from this branch | user confirms marker, card states, first-answer-wins with desktop; performed by the user |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Pending requests appear, replace per device, and clear on device offline/resync, session exit and logout, mirroring the TS store.
- [ ] The answer travels over the session lane as `secret_answer` and resolves on the matching `secret_answer_ack`; a failure keeps the card's input.
- [ ] The workspace row shows 「等待输入密钥：NAME」 ahead of progress; the terminal page is marked; the card implements every listed state.
- [ ] The value never enters the store, logs, the terminal input area, speech, or the pasteboard; the card does not steal focus.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- The generated Swift types for the secret messages are missing on this branch.
- The work requires changing the protocol, the worker, the server or the desktop.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Push notifications for secret requests would need APNs end to end; that is a separate project.
- Plan audit (fable) findings were all accepted; none rejected.
- The inbox-entry text prefix (`Secret requested: `) is irrelevant on iOS (no inbox); the marker comes from the live pending set only.
