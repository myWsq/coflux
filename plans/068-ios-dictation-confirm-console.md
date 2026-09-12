# Plan 068: Restore dictation confirmation, with arc buttons and slide-to-act shortcuts

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 59377fc..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none (revisits the result of plan 067)
- Category: feature
- Execution: subagent opus
- Planned at: `59377fc`, 2026-08-01

## Requirement

067 copied WeChat release-to-send, but its premise differs: WeChat sends voice with supplementary transcript; coflux sends **only text**, so recognition errors reach the agent directly. User reconsidered on 2026-08-01:

- Release in place enters confirmation: centered fixed draft, clickable Cancel left/Send right; tap draft to edit in composer.
- While holding, slide into left/right button and release to cancel/send directly, bypassing confirmation. Users can act quickly or pause to inspect.
- Replace 067's huge radius-130 circles centered at screen corners with capsule buttons arranged along a bottom arc. Hit test actual button geometry plus modest tolerance, not large screen regions.
- Held state uses subtle noninteractive targets; confirmation uses solid clickable buttons.

Ordinary release must not insert immediately. Deliberate slide-right release may send directly.

## Decisions & tradeoffs

- **Ordinary release confirms**, explicitly superseding 067. User rejects Enter-only confirmation as insufficient for transcription mistakes; inspect before terminal insertion. Existing endDictation:449-518.
- **Slide-left cancel/slide-right send**; intentional movement and visible draft express consent. Send awaits final transcript, without confirmation phase. Always-confirm would make cancellation two-step; cancel-only shortcut violates selected symmetry.
- **Only two confirmation buttons**, no Edit button; tapping draft edits, keeping layout uncluttered.
- **Restore draft-tap Edit** from 066, removed in 067. It is unavailable while held.
- **sendText remains flattened single-line/no CR**, per 054/055, WorkspaceDetailView:429-437. Execution with Enter was never approved.
- **Bottom arc capsules**, user-selected geometry. Remove DictationZone.radius=130; executor tunes arc/size/tolerance. Holding anywhere on placeholder, including far edges, must hit none. Drawing and DictationZone.hit share geometry.
- **Held targets are low-contrast/noninteractive with hit highlight**; confirmation controls are solid/clickable without hover-zone semantics. Keep glass vocabulary, not WeChat opaque background.
- **Await finish for both send and confirmation**, never premature volatile text. Disable/defer confirmation action while finalizing. Cancel immediately calls cancel/dismiss without waiting (WorkspaceDetailView:466-518).
- **Empty transcript dismisses** for ordinary or slide-send release. Failed with words enters confirmation plus error, restoring 066 rather than 067 auto-insert/1.2s annotation. Failed without words/permissionDenied retains tappable 064 error guidance.

## Direction

Same three files as 067: overlay returns to recording/confirmation/error phases with arc geometry; input retains gestures/global positions and supplies release hit; host adds ordinary-release confirmation. Session/providers unchanged.

### Milestone 1: Geometry and visuals

Arc capsules replace corner circles; held targets highlight correctly and never overlap placeholder hit area. Build passes.

### Milestone 2: Confirmation/shortcuts

Ordinary release fixed draft/buttons/Edit; slide-left cancel/right final-send; empty/errors/permissions follow decisions. Build passes.

## Landmines

- Held overlay must not intercept original placeholder gesture; confirmation **must** accept buttons/draft. Existing sectors allowsHitTesting(false) must become phase-aware.
- Gesture and overlay frame are global (WorkspaceDetailView:236-241); draw/hit in one space.
- sendText no-ops without ready terminal. Preserve terminalReady/draft fallback at :423-428 so words are never lost.
- Retain session/overlay until finish settles; microphone releases at finish, not when user later confirms (:466-476).
- Preserve LongPressGesture sequenced with global zero-distance DragGesture and onTapGesture, learned in 066 (:74-107); no custom timing.
- dictateActive becomes false after gesture ends, even while confirmation remains.

## Scope

In scope: DictationOverlay, TerminalInputArea, WorkspaceDetailView, README.

Out of scope: other Speech/session/providers/capture/protocol; composer/pad internals; Web/mobile/server/daemon.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Device acceptance | Hold/release confirms; Cancel/Send/draft Edit; Send inserts without Enter; slide shortcuts work; stationary placeholder edges never hit targets | User confirmation |

## Done criteria

- [ ] The xcodebuild build passes.
- [ ] Releasing in place enters confirmation: freeze the draft, expose actual tappable bottom-left Cancel/bottom-right Send buttons, and allow tapping the draft to edit in the composer; do not insert directly into the terminal.
- [ ] Sliding to bottom-left then releasing cancels immediately; bottom-right waits for final text then inserts into the terminal input line without Enter.
- [ ] Hit geometry uses bottom arc buttons; a stationary finger on the placeholder, including either edge, hits none. Remove the giant-circle DictationZone.radius test.
- [ ] While held, targets use corner-marker styling without intercepting touches; confirmation uses button styling and accepts taps.
- [ ] Empty transcription dismisses; failure with text enters confirmation and shows an error; failure without text or denied permission retains existing visible error behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded work required, or same build error persists after one repair.
- Cannot support nonintercepting held overlay and interactive confirmation together: stop/report, do not leave confirmation unclickable.

## Maintenance notes

- Confirmation evolved 064/066 overlay→067 terminal Enter→068 overlay again. Read this history before reopening the decision.
- Keep drawing and hit geometry/tolerance in one source for responsiveness tuning.
- UI returns to three recording/confirmation/error phases.

### Original source references

`WorkspaceDetailView.swift:449-518`, `WorkspaceDetailView.swift:429-437`, `WorkspaceDetailView.swift:466-518`, `WorkspaceDetailView.swift:236-241`, `WorkspaceDetailView.swift:423-428`, `WorkspaceDetailView.swift:466-476`, `TerminalInputArea.swift:74-107`.
