# Plan 071: iOS terminal uploads from Photos, clipboard, and Files through fsWrite

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c479258..HEAD -- apps/ios/ proto/coflux/v1/device.proto crates/worker/src/device.rs apps/server/src/hub.ts packages/client/src/device-router.ts apps/web/src/components/workbench/terminal-pane.tsx`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `c479258`, 2026-08-11

## Requirement

The iOS app has no way to send files to an agent. The core scenario is sending a phone screenshot to an active Claude Code/Codex task. Web already supports this through plan 014 image paste and plan 023 drag-and-drop: `DeviceFsWrite` on the device data plane writes bytes into the daemon's system temporary directory with temp=true, returns an absolute path, and injects ` <path> ` into the PTY. The CLI recognizes an image path in the prompt and reads it. Only the iOS client half is missing.

The completed behavior must be:

- TerminalInputArea uploads selections from Photos (PHPicker) and Files (UIDocumentPicker). The existing paste key checks for a clipboard image first and otherwise retains text paste.
- Always convert HEIC to JPEG because the CLI recognizes only png/jpg/gif/webp. Send png/jpeg within budget as original bytes, preserving lossless screenshots. Above budget, compress through JPEG quality steps before reducing resolution.
- Send arbitrary files unchanged; reject oversized files with a clear error.
- On success, inject the absolute path with one space on either side into the active terminal inside bracketed paste. Surface failures/timeouts through the existing error UI.
- Show upload controls as busy and prevent repeated activation during upload.
- Make **no server, daemon, or proto changes**: handlers, relay scope authorization, and Swift protobuf types already exist.

Do not use the control plane: old `client_fs_write` is removed and reserved. Do not write into the user's repository; temp=true is required. Do not obtain clipboard images through `UIPasteboard.image`/UIImage and re-encode images that are within budget. Uploads require a RUNNING session, matching the input pad's existing sessionID gate.

## Decisions & tradeoffs

- **Transport**: port fsWrite RPC using DeviceRouter's existing `request(route:lane:.elevated)` mechanism and device-plane `DeviceFsWrite`. Reject control-plane relay (`client.proto:121` reserves the old message) or a new server protocol. Evidence: device.proto:453 fields; crates/worker/src/device.rs:907 handler and :1433 FsWrite's DeviceScope::Rpc; apps/server/src/hub.ts:1714 grants all four scopes to relay, so relay-only iOS works; proto/gen/swift/coflux/v1/device.pb.swift:1358 contains generated types; packages/client/src/device-router.ts:2111-2125 is the TS reference, with RPC→elevated at :1089-1090.
- **Use a 60s timeout only for fsWrite**. Add an optional timeout to `request()` without changing other requests. Existing 20s `deviceRequestTimeout` (DeviceRouter.swift:51) is insufficient for tens of MB over cellular. TS also uses 20s without a fsWrite override (device-router.ts:38), a limitation fast Web networks have concealed.
- **Leave envelope headroom below the 30MB frame limit**, for example 30MB − 64KB. Reject oversized files before encoding and report the error. Do not copy Web's full 30MB limit (terminal-pane.tsx:42): iOS `encodeFrame` silently drops oversized frames (DeviceRouter.swift:674-676), so a payload at the limit plus envelope would hang until timeout. `DeviceProtocol.maxFrameBytes` is 30MB at DeviceRouter.swift:7.
- **Image budget is 3.5MB**, matching Web. Preserve original bytes within budget, except always convert HEIC. Above budget, lower JPEG quality while retaining resolution, then halve dimensions if necessary. Reject sending 30MB images unchanged because cellular uploads are slow and CLI image reading does not need that size; reject unconditional recompression because plan 014 preserves lossless screenshots. See terminal-pane.tsx:39 PASTE_BUDGET_BYTES and :121 compressToBudget.
- **Inject immediately through existing `press()`**, wrapping ` <absolute path> ` in bracketed paste. Do not put it in draft and require another send: Web directly uses `terminal.paste(" path ")` (terminal-pane.tsx:308), matching pasteKey (TerminalInputArea.swift:219-227).
- **Assign a new UUID to required operation_id**. Worker uses it for FsWrite idempotency so reconnect/replay does not write duplicates. See device.rs:1313 and TS operationId at device-router.ts:2117.
- **Controls**: add an image key using `PHPickerViewController` without a Photos permission prompt and a file key using `UIDocumentPickerViewController` with **asCopy: true**. Paste checks images before text. Use single selection (decided while planning): one screenshot is the main scenario; add multiple selection later if needed. Web multi-file dragging does not create a corresponding mobile requirement.
- **Names**: a single filename component `<prefix>-<epoch milliseconds>-<short random><ext>`. Prefixes are `paste-`, `photo-`, and `file-`. Preserve file extensions only after restricting them to at most 16 ASCII alphanumeric characters, following Web safeDropExtension (terminal-pane.tsx:105-108). Temp mode accepts only a single path component (device.proto:453); daemon rejects directories.
- **Update the DeviceRouter scope comment** at DeviceRouter.swift:40-41 from “fs/exec RPC is not ported” to “fsWrite is ported (plan 071); other RPCs remain unported,” so the documented boundary matches code.

## Direction

Controls select/read bytes → image pipeline converts HEIC or compresses over-budget data → thin `CofluxClient` wrapper resolves daemonID/workspaceID from task, like sendInput at :476-482 → `DeviceRouter.fsWrite` with elevated lane and temp=true → daemon returns the written absolute path → bracketed paste into PTY. Failures use `reportLocalError` (CofluxClient.swift:514).

### Milestone 1: DeviceRouter fsWrite RPC and unit tests

Provide `fsWrite(daemonID:workspaceID:path:data:temp:) async throws -> Coflux_V1_FsWriteResult` through the existing elevated request/flush/replay mechanism. Add `.fsWrite` to `requestID(of:)` (:1132) and `.fsWriteResult` to `responseRequestID(_:)` (:1145), or replies cannot match pending requests. Apply the timeout decision. Add cases to existing `apps/ios/CofluxTests/DeviceRouterTests.swift` using FakeTransport; do not add a test file requiring xcodeproj changes. Cover workspace_id/temp/operation_id in outgoing frames, successful FsWriteResult resolution, and error rejection.

Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<available iPhone simulator>' test` → exit 0.

### Milestone 2: CofluxClient upload wrapper

Accept bytes, a suggested filename, and session context; resolve daemonID/workspaceID, call fsWrite, inject the path on success, and reportLocalError on failure. Expose per-session uploading state for busy UI. Reject without a RUNNING session, matching input gating.

Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0.

### Milestone 3: Three upload controls and image pipeline

Implement the PHPicker image key, UIDocumentPicker asCopy file key, and image branch of paste; HEIC conversion/budget compression; and busy state via ProgressView or reduced opacity plus disabled interaction. Reuse `keyCap` styling. Never wrap Button in interactive glassEffect: plan 070's second rework found that its UIKit backing view swallowed taps.

Validation: the same xcodebuild build command → exit 0.

## Landmines

- Validate size before `encodeFrame` (DeviceRouter.swift:674-676). Silent oversized-frame drops otherwise appear as a 60s hang and timeout.
- `UIPasteboard.general.image` loses original bytes. Use `data(forPasteboardType:)` with png/jpeg UTIs and re-encode only above budget. The first clipboard read may show iOS's normal paste-authorization prompt.
- Without `asCopy: true`, UIDocumentPicker URLs need balanced `startAccessingSecurityScopedResource` management or reads fail. asCopy returns a sandbox copy and avoids this; use it.
- PHPicker/DocumentPicker callbacks and NSItemProvider loading run in the background. Explicitly return to MainActor for DeviceRouter/CofluxClient.
- Large iOS screenshots are commonly 5–15MB PNGs. Run UIImage decoding/recompression off the main thread to avoid freezing UI.
- Preserve pasteKey's existing text bracketed-paste wrapper (TerminalInputArea.swift:222).
- Plan 055 removed bracketed paste only from the composer. It does not apply to pasteKey or path injection; do not “unify” them.
- Reuse DeviceHarness/FakeTransport (DeviceRouterTests.swift:9-10), the existing protocol-level harness, instead of introducing new mocks.

## Scope

In scope:
- `apps/ios/Coflux/Client/DeviceRouter.swift`
- `apps/ios/Coflux/Client/CofluxClient.swift`
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/CofluxTests/DeviceRouterTests.swift` (cases in the existing file only)
- Minimal wiring, if needed, in `apps/ios/Coflux/Views/WorkspaceDetailView.swift` / `TerminalHostView.swift`
- `plans/README.md` status

Out of scope:
- `proto/`, `crates/`, `apps/server/`, `apps/web/`, `packages/`: zero server/Web changes is a correctness criterion.
- Camera capture, which was not requested.
- Multiple selection/batch upload, deferred by the single-selection decision.
- `apps/mobile/`, frozen (memory: mobile-companion).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Unit tests | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<available iPhone simulator>' test` | exit 0 |
| Build | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Physical-device acceptance | User checks screenshot → Photos upload → path injection → CLI image reading; Files upload; clipboard image; large file over cellular | Manual user acceptance |

## Done criteria

- [ ] Unit tests and build pass.
- [ ] Photos, Files, and clipboard uploads inject the path into the terminal on success.
- [ ] HEIC converts to JPEG; within-budget original bytes are preserved; oversized images compress; files above the limit fail early with an error.
- [ ] DeviceRouterTests cover fsWrite requests, replies, and errors.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds, especially relay scope authorization at hub.ts:1714 or worker FsWrite handling at device.rs:907.
- The outcome requires out-of-scope changes, such as a proto/server change to make the path work; a premise has failed.
- xcodebuild still fails after one attempt to fix the same error.
- Generated Swift protobuf lacks DeviceFsWrite / FsWriteResult types and is stale.

## Maintenance notes

- Existing daemon temp cleanup removes files with mtime older than seven days during writes (plan 014); it also manages iOS uploads. No iOS cleanup is needed.
- The 3.5MB image budget comes from the old 4MB control-plane maxPayload minus headroom. With a 30MB frame limit it is conservative, but remains reasonable over cellular. Increase only the iOS/Web constants if needed later.
- If the CLI gains HEIC support, remove the conversion branch; keep the conversion decision centralized in the image pipeline.
