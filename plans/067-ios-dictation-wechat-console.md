# Plan 067: WeChat-style dictation console—release to insert, slide to cancel/edit

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat e23e440..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none (iterates on the result of plan 066)
- Category: feature
- Execution: subagent opus
- Planned at: `e23e440`, 2026-08-01

## Requirement

User review reverses 066's release-then-Send confirmation. **One gesture completes insertion**: while held, show lower-left Cancel and lower-right Edit sectors. Release inside a sector executes it; release elsewhere inserts transcription into terminal input **without Enter** and dismisses. Remove persistent draft confirmation entirely.

User decision 2026-08-01 explicitly supersedes 064/066 manual-Send requirement: text-only insertion still leaves final execution behind the user's terminal Enter. Confirmation moves from overlay to Enter, never disappears from execution.

## Decisions & tradeoffs

- **Release outside sectors inserts through sendText then dismisses**, no second tap. Reject retained 066 confirmation and automatic Enter, which violates 054/055 and executes recognition errors. sendText flattening at WorkspaceDetailView:431-435.
- **Two sectors only**, Cancel left/Edit right. Edit fills draft and opens existing composer (066 onEdit at :233-238). No center WeChat "Command" sector because user excluded +Enter execution.
- **Remove upward-cancel threshold**, TerminalInputArea:95,102,108. Replace Bool move/end callbacks with position/hit-zone semantics. Coexisting upward and sector cancellation would conflict through the central text area.
- **Keep system gesture sequence unchanged**: default LongPressGesture sequenced before zero-distance DragGesture, following 066 reconsideration/pitfall comments at :74-106. No custom timing/threshold revival; change only drag-position consumption.
- **Finalizing remains briefly after release** until session.finish settles, then automatically insert/dismiss, with no interaction meanwhile. Do not remove session early and flash away permission guidance (:462-497).
- **Empty release dismisses**, including Edit with no words (:491-494).
- **Failed with words inserts plus brief error**, e.g. toast/short annotation before dismissal. Failed without words/permissionDenied retains 064 tappable error guidance. No failure-only confirmation phase.
- **Recording overlay remains noninteractive**; sectors are visual/hit targets while original placeholder tracks drag. Only error/permission overlay accepts taps (DictationOverlay:39-47).
- **Visuals**: fixed centered draft bubble plus bottom sectors, highlighted/raised on entry with release-to-insert/cancel/edit prompt. Reuse glassEffect/VariableBlurView rather than copying WeChat opaque dark/green styling.

## Direction

Three files: TerminalInputArea forwards drag and removes upward cancel; DictationOverlay removes draft phase/adds sectors; WorkspaceDetailView dispatches Cancel/Edit/Insert after finish. No DictationSession/provider changes. UI returns to recording/error phases, with finalizing only transient and no released draft residency.

### Milestone 1: Gestures/hit zones

Forward positions, compute sector hits/highlighting, remove upward cancel. Build passes.

### Milestone 2: Release dispatch

Outside→finalize→insert/dismiss; Cancel→discard/dismiss; Edit→draft/composer. Handle empty/error/permissions as decided. Remove dictationReleased and confirmation UI. Build passes.

## Landmines

- Unify global coordinates: current DragGesture.local is placeholder space (:84), sectors are full-screen. Use coordinateSpace.global or equivalent for both geometry/gesture.
- Reuse sendText at :425-435, flattening newlines/no Enter.
- Await finish, not release-time volatile text, before insertion (:462-467).
- finish releases capture/engine/WS promptly, not after finalizing UI.
- sendText silently no-ops without running task/sessionID (:432). If session disappears, preserve nonempty transcript in draft rather than silently losing it.
- Preserve onTapGesture/system long-press disambiguation at TerminalInputArea:70.

## Scope

In scope: DictationOverlay, TerminalInputArea, WorkspaceDetailView, README.

Out of scope: other Speech files/session/providers/capture/protocol; composer/pad internals; other clients/server/daemon.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Device acceptance | Hold/release outside inserts without Enter; left cancels; right edits; empty dismisses; tap composer unchanged | User confirmation |

## Done criteria

- [ ] The xcodebuild build passes.
- [ ] Releasing outside both sectors waits for final text, inserts through sendText without Enter, and automatically dismisses the overlay without a second tap.
- [ ] Releasing in the left sector cancels/discards; releasing in the right sector transfers text to the draft and opens the composer.
- [ ] Upward-slide cancellation and the entire draft-confirmation state—including Send/Discard buttons and tap-to-edit text—are removed.
- [ ] Empty transcription dismisses; failure with text inserts it and shows an error; failure without text or denied permission remains visible with an error, unchanged.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded work required, or same build error persists after one repair.
- Sector/global tracking cannot coexist with existing sequenced gesture: stop/report, not custom timing fallback.

## Maintenance notes

- Since 067, confirmation is terminal Enter. If later insertion also executes, first restore overlay confirmation; never remove both.
- Keep sector geometry/tolerance and hit testing together in DictationOverlay for responsiveness tuning.
- Revisit 066→067 phase evolution before adding completed-draft states again.

### Original source references

`WorkspaceDetailView.swift:431-435`, `WorkspaceDetailView.swift:233-238`, `TerminalInputArea.swift:95,102,108`, `TerminalInputArea.swift:74-106`, `WorkspaceDetailView.swift:462-497`, `WorkspaceDetailView.swift:491-494`, `DictationOverlay.swift:39-47`, `TerminalInputArea.swift:84`, `WorkspaceDetailView.swift:425-435`, `WorkspaceDetailView.swift:462-467`, `WorkspaceDetailView.swift:432`, `TerminalInputArea.swift:70`.
