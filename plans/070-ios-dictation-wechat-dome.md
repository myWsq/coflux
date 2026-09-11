# Plan 070: WeChat-style dictation overlay with an arched base and two round shoulder buttons

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 9538a03..HEAD -- apps/ios/Coflux/Speech/DictationOverlay.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (iterates on 068/069 and answers 068's unresolved arc question)
- Category: feature
- Execution: subagent sonnet
- Planned at: `9538a03`, 2026-08-03

## Requirement

After plan 068, the dictation overlay has two 112×52 capsules floating at the left and right screen edges with no visual anchor. The user described them as “two buttons appearing out of nowhere.” The 068 executor left the arc unresolved (see its plans/README.md entry): WeChat's arc appeared to come from three buttons at different heights, but the middle button had been removed. On 2026-08-03 the user chose three visual elements modeled on WeChat's hold-to-talk controls:

1. **Arched base**: a full-width, upward-bulging arch at the screen bottom. WeChat uses a very wide arc rather than a strict semicircle; place a waveform/microphone icon inside. This is purely a visual anchor. While the finger stays in place without entering a button, highlight the whole base and position the instruction, such as “Release to confirm,” above its crest.
2. **Two circular buttons**: cancel ✕ at the left shoulder and send ↑ at the right shoulder of the arch, inset from the screen edges. Put the icons inside the circles and the labels above them. During listening, use low-contrast circular markers that enlarge and highlight when entered. In confirmation, keep their position and shape but make them tappable controls: a solid primary-colored send button and a glass cancel button. Retain the base as an anchor.
3. **Transcription bubble**: keep the existing centered, stationary bubble.

Visual references (WeChat screenshots, Mobbin):
- Sliding to cancel, with the left circle enlarged and white and its label above: https://mobbin.com/screens/bca1a25e-8b1b-4565-8cef-3e4fa9077f96
- Finger on the base, with the entire base highlighted and “Release to send” above the arch: https://mobbin.com/screens/fd891c97-d90e-46aa-b2f5-d091fdf2ac12

This changes appearance only. Preserve plan 068's release-in-place confirmation, hidden buttons during finalizing, and tap-anywhere dismissal of persistent errors, as well as plan 069's optimistic start. Releasing on the base must not send immediately: that was plan 067's superseded behavior.

## Decisions & tradeoffs

- **The base is visual only**. Highlighting it visualizes the existing `.none` zone; release still enters confirmation. Rejected: WeChat's release-to-send behavior, overturned by the user on 2026-08-01 because coflux only transcribes and has no voice-message fallback. The user reconfirmed that decision before this plan. Based on DictationOverlay.swift:11-13.
- **No additional hit zone**. Highlight the base when `stage == .listening && zone == .none`, reusing the three-valued `DictationZone`. Release semantics are identical inside and outside the base, so a third geometric target adds no meaning. Based on DictationOverlay.swift:30-36, where hit() distinguishes cancel/send/none.
- **Replace capsules with circles and move labels above**. Change `DictationZone.size` from 112×52 to a circle roughly 56–64pt in diameter; the executor chooses the exact size. A rectangular hit box expanded by tolerance remains sufficient. Move x positions inward onto the arch shoulders, with exact coordinates chosen to fit the curve. Rejected: adding a base while retaining capsules; the user explicitly requested circles on the shoulders.
- **Confirmation preserves position, shape, and base**. Use solid `Theme.primary` ↑ for the primary action and glass ✕ for the secondary action, preserving plan 068's hierarchy. Do not fade the base or return to capsules: either loses the anchor or creates a jarring transition. Based on DictationOverlay.swift:185-197.
- **Preserve placeholder-bar isolation**. The lower hit-box edge must stay at least 200pt above the overlay bottom: approximately 178pt for the placeholder top plus 22pt margin. Require `lift - hitHalfHeight - tolerance >= 200`. Lower circles require a smaller diameter or tolerance, never loss of the margin. A stationary finger anywhere on the placeholder, including its far edges, must remain `.none`. Based on the lift/tolerance derivation at DictationOverlay.swift:17-24.
- **Share geometry between drawing and hit testing**. Put base and button geometry in `DictationZone` or an adjacent constant group in the same file. Draw relative to the overlay bottom and hit-test against its global frame so both change together. Keep call-site interfaces unchanged. Based on DictationOverlay.swift:28-29 and WorkspaceDetailView.swift:147, `DictationZone.hit($0, in: dictationBounds)`.
- **Keep plan 068's phase visibility**. Listening and confirming show all three elements. Finalizing has no buttons; the executor may keep or remove the purely visual base, preferably keep it to avoid abruptly removing the scene on release. Resting error states hide all three and retain plan 064's tap-anywhere dismissal. Based on DictationOverlay.swift:125-127, `if !resting, stage != .finalizing`.
- **Move instructions and footer upward (decided while planning)**. Existing bottom padding of 48 would put the footer behind the base. Put listening instructions above the arch. permissionDenied/modelDownloading/failed footer content must also avoid overlap, either by moving it or hiding the base. Based on DictationOverlay.swift:122-123.

## Direction

Limit the UI change to DictationOverlay.swift: revise `DictationZone` constants/hit geometry for circles and the base; redraw `buttons`; change both marker/solid branches of `pill` to circles with external labels; move footer/instructions out of the base. Do not change `DictationStage`, `DictationSession`, gesture wiring, `.allowsHitTesting`, or `sensoryFeedback`.

### Milestone 1: Listening appearance

Replace capsules with the base, two circles, and external labels. Highlight the base while the finger stays in place; enlarge/highlight the entered circle. Use shared drawing/hit geometry and preserve placeholder isolation.

Validation: `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0.

### Milestone 2: Confirmation and other phases

Turn the circles into tappable solid-primary/glass controls in place, retain the base, and avoid overlap with “Tap text to edit” and other instructions. Finalizing has no buttons; resting hides the controls and allows dismissal anywhere. Verify every plan 068 behavior remains intact.

Validation: the same xcodebuild command → exit 0.

## Landmines

- The 22pt placeholder margin at DictationOverlay.swift:17-24 was accepted on a physical device in 068. Violating it misclassifies a stationary hold as entering a button.
- Keep the single overlay-level `.allowsHitTesting(stage == .settled)` at DictationOverlay.swift:132, which fixed plan 066's touch issue. Do not add separate gestures/hit-testing modifiers to new base/label views and leak touches across phases.
- Drawing and hit testing share the overlay-bottom reference (DictationOverlay.swift:28-29). If `ignoresSafeArea` moves the base to the physical screen bottom, recheck the hit constants' coordinate system.
- Failed recognition with text joins confirmation; its error label appears below the bubble (DictationOverlay.swift:91-93, 114-120). Preserve this path when moving the footer.
- Add no files and do not change xcodeproj. Plan 067 showed that new files require project changes outside this scope.

## Scope

In scope:
- `apps/ios/Coflux/Speech/DictationOverlay.swift`

Out of scope:
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`: its global-frame interface stays unchanged. STOP and report if implementation requires even a small change.
- `apps/ios/Coflux/Views/TerminalInputArea.swift` (placeholder), `DictationSession`, `AudioCapture`, and other logic.
- `Coflux.xcodeproj`: no new files.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| Physical-device interaction acceptance | User walkthrough on a physical device; by convention Claude does not perform UI acceptance | User approval |

## Done criteria

- [ ] xcodebuild passes.
- [ ] Listening retains the base, highlights it for a stationary finger, and shows instructions above the arch. Entering either circle enlarges/highlights it with its label above. Release in place still enters confirmation.
- [ ] Confirmation has tappable circles in place (solid primary ↑ and glass ✕), retains the base, supports tapping the draft to edit, and preserves the error-label path.
- [ ] Finalizing has no buttons; resting hides all three elements and permits tap-anywhere dismissal.
- [ ] Hit-box lower edges remain at least 200pt above the overlay bottom; update the derivation comments for the new constants.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- Implementation requires WorkspaceDetailView.swift or another out-of-scope file.
- xcodebuild still fails after one attempt to fix the same error.

## Maintenance notes

- The base formally answers plan 068's unresolved arc question. The curve comes from the base itself, not three buttons at different heights. Review the shared `DictationZone` constants before changing button count or placement.
- Interaction history: 067 immediate send on release (overturned) → 068 confirmation (accepted on device) → 069 optimistic start → this purely visual change. Read 068's reconsideration record before changing semantics.
