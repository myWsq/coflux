# Plan 066: Responsive dictation—immediate feedback, capture early, confirm within overlay

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 06544ca..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none (iterates on the result of plan 064)
- Category: feature
- Execution: subagent sonnet
- Planned at: `06544ca`, 2026-07-30

## Requirement

064 works on device after TCC isolation crash fix 06544ca, but feels unresponsive. Three delays explain it: no feedback during 280ms hold threshold; even granted permissions perform two serialized tccd XPC requests before 100–300ms AVAudioEngine startup, losing initial speech; release waits up to 2s for final text, dismisses overlay, then opens composer/keyboard before another Send tap.

Required outcome: immediate haptic/visual press feedback and ~180ms threshold; skip granted-permission XPC and start capture early; release **keeps an in-overlay draft** with Send, tap-text Edit, and Discard, no automatic composer transition. Explicit Send confirmation remains mandatory; no automatic/countdown send.

## Decisions & tradeoffs

- **In-overlay confirmation**, user decision 2026-07-30 superseding 064 release-to-composer. Send uses sendDraft-equivalent terminal path; text tap fills draft/opens existing composer; Discard dismisses. No-edit forces rerecording one mistaken word; countdown conflicts with explicit confirmation. Move confirmation location, not requirement.
- **180ms threshold**, replacing 280ms at TerminalInputArea:77. User accepts higher accidental-hold risk. If tap feel regresses materially, STOP/report; do not silently restore 280ms.
- **Permission fast path**: synchronous AVAudioApplication.shared.recordPermission==granted and SFSpeechRecognizer.authorizationStatus()==authorized skip async requests, active waiting, and 400ms post-dialog buffer (:63-75), directly capture.start. Unknown/denied retains existing request flow. Startup permission prompting is poor UX and does not solve engine startup.
- **Preserve 06544ca crash repair**: native async permission API/nonisolated static callback at DictationSession:217-224 prevents MainActor inheritance and tccd background SE-0423 SIGTRAP.
- **Immediate first DragGesture onChanged feedback**, haptic plus pressed visual in glass vocabulary, before threshold and overlay.
- **Draft phase appears immediately on release**, not after finish await. Show current volatile text then update final in place. Prevent premature send: disable or defer requested send until final, executor chooses. finish still awaits startTask settlement (:155-166).
- **Empty release dismisses** without empty composer/draft, replacing WorkspaceDetailView:461-465.
- **Errors**: preserve permissionDenied/failed guidance from 064. Failed with transcript, e.g. midstream Doubao loss, enters editable/sendable draft with error annotation, replacing hidden-draft handling at :451-457.

## Direction

Four files only: DictationSession permission fast path, DictationOverlay draft/actions, TerminalInputArea threshold/feedback, WorkspaceDetailView finalization. Providers unchanged.

### Milestone 1: Responsiveness

Immediate feedback/~180ms; granted begin→capture has no permission-XPC await. Build passes.

### Milestone 2: Overlay draft

Release stays with centered draft and Send/Edit/Discard; empty dismisses; failed transcript retains error and usable draft. Build passes.

## Landmines

- Reuse sendDraft's 054/055 newline-to-space, text-only/no-CR semantics at WorkspaceDetailView:390; direct new terminal writes break it.
- During hold overlay must not intercept placeholder DragGesture; during draft it must accept buttons/text taps. Existing isDismissable only handles permission/error (DictationOverlay:15-27); update hit testing by phase correctly.
- Do not remove session/overlay before finish returns, or permission guidance flashes away (WorkspaceDetailView:433-436).
- Gesture ends while overlay remains: turn dictateActive off so placeholder mic no longer indicates recording (TerminalInputArea:57-60).
- Release capture/engine/WS at finish, not later Send; draft can remain indefinitely without orange microphone indicator.

## Scope

In scope: Speech/DictationSession.swift, DictationOverlay.swift; Views/TerminalInputArea.swift, WorkspaceDetailView.swift; README.

Out of scope: other Speech providers/capture/protocol; existing composer/pad internal semantics; Web/mobile/server/daemon.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Device acceptance | Immediate hold feedback/no initial word loss; release draft then Send/Edit/Discard; tap composer unchanged | User confirmation |

## Done criteria

- [ ] The xcodebuild build passes.
- [ ] The already-authorized begin→capture.start() path has no permission-XPC await; undecided-permission behavior is unchanged.
- [ ] Pressing gives immediate feedback; long-press recognition takes approximately 180ms.
- [ ] Release retains the overlay in draft state: Send delivers directly with sendDraft semantics, tapping text opens the composer for editing, and Discard dismisses. The composer no longer opens automatically.
- [ ] Releasing an empty transcription dismisses immediately; failures with text enter draft state and show the error.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded work required, or same build error persists after one repair.
- 180ms cannot reliably distinguish gestures under recognizer constraints: stop/report, no unilateral threshold change.

## Maintenance notes

- Threshold is one TerminalInputArea constant and user-approved; changes need renewed approval.
- Dictation now has recording/draft/error phases. Revisit phase design before additions such as continuing speech into completed drafts.
- If granted permissions again delay capture after iOS upgrades, verify synchronous queries against actual tccd state.

### Original source references

`TerminalInputArea.swift:77`, `DictationSession.swift:55`, `DictationSession.swift:63-75`, `DictationSession.swift:217-224`, `DictationSession.swift:155-166`, `WorkspaceDetailView.swift:461-465`, `WorkspaceDetailView.swift:451-457`, `WorkspaceDetailView.swift:390`, `DictationOverlay.swift:15-27`, `WorkspaceDetailView.swift:433-436`, `TerminalInputArea.swift:57-60`.
