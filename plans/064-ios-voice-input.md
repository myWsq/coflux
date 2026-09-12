# Plan 064: iOS voice input—hold the composer entry, prefer Doubao IME, fall back to local Apple speech

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 2f5647e..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `2f5647e`, 2026-07-29

## Requirement

Voice supplements slow phone typing. Tap the composer placeholder as before; long press starts push-to-talk. While held, a lightweight full-screen overlay streams transcription, with WeChat-like interaction. Slide upward past threshold and release to cancel. Otherwise release finalizes into WorkspaceDetailView.draft and opens composer with keyboard/cursor at end. **Never send transcription directly to terminal**; user reviews/edits and presses Send.

Prefer keyless Doubao IME; fall back to iOS 26 SpeechAnalyzer/SpeechTranscriber zh_CN. Fallback should be unobtrusive, optionally labeling engine. Existing input disabling without RUNNING session (TerminalInputArea:36) prevents voice too. Tap must remain responsive alongside long press.

## Decisions & tradeoffs

- **Doubao first, Apple local fallback**, user-selected 2026-07-29 for expected better Chinese recognition. Apple-only ignores that preference; paid cloud adds keys when keyless path is free.
- **Choose engine once at admission**. Doubao cached credentials→registration→token→WS StartTask/StartSession failure or total ~2.5s timeout (adjustable) selects Apple. Mid-session Doubao disconnect ends while preserving transcript; do not hot-switch and duplicate/lose contextual words.
- **Thin SpeechTranscribing protocol**, start→AsyncStream events/feed(pcm)/finish/cancel, two fixed implementations sharing AVAudioEngine capture resampled to 16kHz mono Int16 PCM. No registry/configuration framework for two providers.
- **Finalize to draft then setComposing(true)** (WorkspaceDetailView:32). Placeholder-only preview adds another step; direct terminal send turns recognition errors into actions. User explicitly chose review.
- **Port Doubao protocol in Swift** from MIT `/tmp/koe/koe-asr/src/doubaoime.rs`; if absent, `git clone --depth 1 https://github.com/missuo/koe.git /tmp/koe`. Handwrite fixed-field varint/length-delimited protobuf using that file's constants/URLs/UA, URLSessionWebSocketTask. Two message shapes/~200 lines without .proto do not justify another SwiftProtobuf dependency for this reverse-engineered protocol.
- **Automatic device registration** emulates Android IME client. Store device_id/token credential JSON in Application Support; refresh after 12h or retain old token if refresh fails, matching ensure_credentials. This synthetic device fingerprint is not user secret, so file storage rather than Keychain.
- **Opus required**, 16k mono, 20ms/640B PCM frames. First test AVAudioConverter→kAudioFormatOpus; if unavailable, permit libopus SPM such as alta/swift-opus. Executor records verified choice in README; planned as first additional dependency beyond SwiftTerm.
- **Apple local**: SpeechAnalyzer/SpeechTranscriber zh_CN with SFSpeechRecognizer authorization and microphone permission. Query/download shared model via AssetInventory/progress; system can evict it under disk pressure. Show model-download state on fallback. Deployment target 26.0 at pbxproj:258.
- **Ask permissions on first hold**, microphone and speech together even though speech is fallback-only. Either denial shows Settings guidance. Add Chinese NSMicrophoneUsageDescription/NSSpeechRecognitionUsageDescription.
- **Events distinguish volatile/finalized**. Doubao is_interim→volatile, definite/nonstream→finalized. Preserve segment-reset heuristics at doubaoime.rs:1091-1118 to avoid VAD word loss/duplication; Apple maps naturally.

## Direction

Add Speech/ protocol/providers/capture/session orchestration. Modify placeholder gestures and WorkspaceDetailView overlay/draft finalization. Reuse glass/VariableBlurView vocabulary (TerminalInputArea:215).

### Milestone 1: Speech infrastructure

Implement full Doubao registration/token/handshake/Opus/three-level result decoding/segment merge, Apple auth/model/streaming, shared PCM capture. Build below passes.

### Milestone 2: Push-to-talk UI

Preserve tap, add hold/drag/release. Overlay shows live text/engine/recording/cancel/download/denial. Release opens draft; fallback follows decisions. Build passes.

### Milestone 3: Closure

Add permission copy and README status including chosen Opus path. Build passes.

## Landmines

- Placeholder is Button(action:onCompose) at :44. Stacked long-press can swallow/delay taps. Use appropriate non-Button gesture composition or simultaneousGesture; continuous position/release requires DragGesture-level tracking, not onLongPressGesture alone.
- Workspace base deliberately ignores keyboard safe area (:131-132); composer is separate fullScreenCover, per 2026-07-26 freeze-base decision. Voice overlay must preserve it.
- Composer fadeOutAndDismiss has 320ms delayed removal (:319), a device pitfall. Reusing transparent fullScreenCover needs setComposing/withTransaction animation suppression (:379-383), avoiding end-of-transition stalls.
- sendDraft (:390-396) retains 054/055 single-line text-only semantics. Put recognition newlines/punctuation into draft unchanged; do not alter send.
- Doubao Last without First is rejected. Subframe speech must still send First then silent Last (doubaoime.rs:930-958).
- Final results often include cumulative confirmed_text; appending every Final duplicates it. Grow only through segment-reset heuristic (:1120-1131 documents prior rework).
- AVAudioSession recording interrupts other audio. Every finish/cancel/error stops engine/tap, deactivates session, closes WS; leaked taps can crash/mute next hold.
- Unofficial reverse protocol may change/disappear. User knowingly accepts personal TestFlight use; failure should fall back, never retry-storm.

## Scope

In scope: new Speech/ modules, TerminalInputArea/WorkspaceDetailView, Coflux-Info.plist, pbxproj file/SPM registration, README.

Out of scope: Web/frozen mobile/server/daemon/protocol; existing 053–058 pad/composer semantics; raw voice messages/multilanguage UI, unrequested.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Device acceptance | Hold Chinese speech→live transcript→release composer→Send; offline Apple fallback | User confirmation |

## Done criteria

- [ ] The xcodebuild build passes.
- [ ] Tapping the placeholder still opens the composer without behavioral or responsiveness regression; long press starts voice input.
- [ ] Voice overlay shows live transcription, supports upward-slide cancellation, and transfers text into the draft and opens the composer on release.
- [ ] Doubao admission failure/timeout automatically falls back to local Apple recognition; the overlay identifies the current engine.
- [ ] Permission descriptions and denial guidance are present; the Apple path includes model-download state.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change or excluded work required.
- Same build error persists after one repair.
- Doubao StartTask/StartSession fails for non-network protocol reasons on device/simulator: still deliver complete fallback, honestly mark Doubao status, then stop.

## Maintenance notes

- Check upstream koe protocol changes first when Doubao fails.
- Deleting synthetic credential JSON simply re-registers on next hold.
- Future paid ASR is another SpeechTranscribing implementation plus orchestration order change.

### Original source references

`TerminalInputArea.swift:36`, `WorkspaceDetailView.swift:32`, `Coflux.xcodeproj/project.pbxproj:258`, `TerminalInputArea.swift:215`, `TerminalInputArea.swift:44`, `WorkspaceDetailView.swift:131-132`, `TerminalInputArea.swift:319`, `WorkspaceDetailView.swift:379-383`, `WorkspaceDetailView.swift:390-396`, `doubaoime.rs:1120-1131`.
