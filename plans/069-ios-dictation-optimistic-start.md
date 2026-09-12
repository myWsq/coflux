# Plan 069: Optimistic dictation startup—early capture and immediate visual cue

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 893f08d..HEAD -- apps/ios`

## Status

- Priority: P2
- Effort: S
- Risk: MED
- Depends on: none (iterates on the result of plan 068)
- Category: feature
- Execution: subagent opus
- Planned at: `893f08d`, 2026-08-01

## Requirement

After 068 reduced default long press from 0.5s to 0.28s, two delays remain: capture begins only after recognition (beginDictation→session.begin, WorkspaceDetailView:458-464), losing speech during the first ~0.28s; scaleEffect(0.97) alone (:70) barely communicates progress.

Show a gradual entering-dictation cue on press and retain early speech so text is already present when overlay opens. **Do not show overlay before long-press recognition**: flashing it during ordinary composer taps would break 066 disambiguation.

## Decisions & tradeoffs

- **Warm capture before recognition; show overlay only after it**. Decouple session lifetime from visibility, currently both controlled by if let dictationSession (:226). Executor chooses separate visibility/state/phase. Preconnecting WS alone does not solve absent capture; pendingPCM already covers handshake.
- **Reuse pendingPCM**, 300KB/~9.4s cap (:39-45), comfortably covering ~0.16s warmup plus 2.5s Doubao admission. No second buffer.
- **~120ms capture debounce**, adjustable but well below 0.28s and filtering normal taps. AudioCapture.record interrupts playback (:25-31); immediate warmup on every tap would interrupt music and flash orange mic. This timer schedules warmup only, not gesture recognition, so does not revive 066's forbidden custom gesture timing. Do not switch category to playAndRecord/mixWithOthers: speaker feedback changes recognition and entire audio behavior.
- **Warm only if both permissions already granted**, using 066 synchronous recordPermission/authorizationStatus checks. Otherwise wait for actual long press then normal start/permission flow. A typing tap must not prompt microphone permission. DictationSession:54-88.
- **Gradual visual cue at touch down**, user-selected: e.g. mic fade or border/background toward Theme.primary, keeping existing scaleEffect. Normal 60–120ms taps barely reveal it; sustained holds do. No instant switch. TerminalInputArea:61-71.
- **Use @GestureState pressing** from sequenced .updating (:28,94-96), earliest existing signal; no UIKit probe. If real timing still lags, later UIViewRepresentable/touchesBegan may improve it. Extra simultaneous zero-distance DragGesture risks competing disambiguation.
- **Do not expose warmup errors/permissions early**. Failed phase appears only after actual overlay; early release silently cancel/dismiss. Existing teardownRequested/cancel (:34-37/:154) already handles early end during admission.

## Direction

Input forwards pressing/cue/debounce; host separates lifetime/visibility and warm/cancel entries; DictationSession may expose permission eligibility only. AudioCapture/providers/overlay unchanged.

### Milestone 1: Optimistic capture

Press→debounce→start invisible session; recognized hold shows **same session** with buffered speech; early release silently cancels/releases mic. Build passes.

### Milestone 2: Visual cue

Press gradually reveals cue, barely visible on ordinary taps. Build passes.

## Landmines

- if-let session cannot remain visibility switch, or warmup flashes overlay.
- Every end/cancel/error stops audio; new start-then-abandon path must converge through cancel, avoiding leaked tap/next-session crash.
- Do not discard/recreate warmup session on recognition; that loses captured audio.
- Warmup must be idempotent despite pressing jitter; existing begin dedup uses dictateActive (:99-103).
- A 0.2s press can briefly activate mic then cancel, an accepted tradeoff. Ordinary <120ms taps must never activate it.
- 064/066 found AURemoteIO abort immediately after permission dialog closes (:73-86). Granted-only warmup avoids that transition; do not expand it to initial authorization.

## Scope

In scope: TerminalInputArea, WorkspaceDetailView, DictationSession, README.

Out of scope: AudioCapture.record/start-stop; providers/protocol/credentials; DictationOverlay's 068 interaction; user-retained 0.28s hold threshold; other clients/server/daemon.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Device acceptance | Cue on hold/early words retained; quick composer tap no permission/audio interruption/orange mic; 0.2s abandon leaves no capture leak and next dictation works | User confirmation |

## Done criteria

- [ ] The xcodebuild build passes.
- [ ] Audio capture starts approximately 120ms after touch-down; the overlay still appears only after long-press recognition succeeds.
- [ ] Warmup audio is retained: when the overlay appears, the draft contains speech from the initial press.
- [ ] An ordinary placeholder tap neither starts the microphone nor opens permission prompts.
- [ ] Without authorization, no warmup occurs; long press retains the complete permission flow.
- [ ] Release before long-press recognition silently cancels the session and releases the microphone, without a dangling tap.
- [ ] Pressing the placeholder gradually reveals the voice-input cue; ordinary taps make it barely visible.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded work required, same build error persists after one repair.
- Lifetime/visibility cannot separate without changing 068 confirmation: stop/report, never show overlay during warmup as workaround.

## Maintenance notes

- Distinguish touch→pressing system delay (not solved, future UIKit probe), adjustable 120ms warmup debounce, and user-fixed 0.28s overlay recognition.
- Any relaxation of warmup conditions must reconsider unwanted microphone activation when user merely wants to type.

### Original source references

`WorkspaceDetailView.swift:458-464`, `TerminalInputArea.swift:70`, `WorkspaceDetailView.swift:226`, `DictationSession.swift:39-43`, `DictationSession.swift:39-45`, `AudioCapture.swift:25-31`, `DictationSession.swift:54-88`, `TerminalInputArea.swift:61-71`, `TerminalInputArea.swift:28,94-96`, `DictationSession.swift:34-37`, `AudioCapture.swift:25-26`, `TerminalInputArea.swift:99-103`, `DictationSession.swift:73-86`.
