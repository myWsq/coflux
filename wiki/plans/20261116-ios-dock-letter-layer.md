# Plan 20261116-ios-dock-letter-layer: swiping the dock up turns it into a letters-and-digits keyboard

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 4c9b4654..HEAD -- apps/ios/Coflux/Views/TerminalInputArea.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift apps/ios/Coflux/Views/FullKeyboard.swift apps/ios/Coflux/Views/FullKeyEncoding.swift apps/ios/Coflux/Views/Theme.swift`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (plain autopilot)
- Workspace: isolated — cut from the main worktree into `.claude/worktrees/20261116-ios-dock-letter-layer` on `dev/20261116-ios-dock-letter-layer`
- Planned at: `4c9b4654`, 2026-11-16

## Record

### Requirement

On the iPhone Duo, every layout except the inner display open tall uses the dock: two rows of quick keys (`esc tab [⌨|🎤] ↑ ⌫ ⏎` / `^C ^D / ← ↓ →`). Swiping the dock up today pulls out two more rows above it (`1 2 3 4 q : ~` / `⇧⇥ ^R ^U ^L ^Z | ^W`); in a short window the same keys open as a sheet. After several days of use the owner finds those extra keys useless. What is missing is typing short words — a filename, `git status`, `y`, a branch name — without opening the compose layer and the system keyboard.

Product conclusions (confirmed by the owner):

- **Where**: every layout that uses the dock — the outer display (portrait and landscape), the inner display open wide, Split View windows and short windows. The inner display open tall keeps its full-size Mac keyboard unchanged.
- **Quick layer** (the default) is unchanged.
- **Swipe up** over the dock: the whole dock becomes the letter layer. **Swipe down**: back to the quick layer. Nothing else switches layers — in particular ⏎ on the letter layer does not.

  ```
  1 2 3 4 5 6 7 8 9 0
  q w e r t y u i o p
  a s d f g h j k l ⏎
  z x c v b n m [␣] ⌫
  ```

- Lower case only, no ⇧. Space only types a space (talking stays on the quick layer's 🎤). ⌫ repeats while held. Every key sends straight to the terminal, like the quick keys.
- The letter layer is taller than the quick layer; the difference pushes the terminal up, which never changes size (the same model as today's swipe-up). Short windows swap in place the same way; the keypad sheet goes.
- The old extra keys (`1 2 3 4 q : ~ ⇧⇥ ^R ^U ^L ^Z | ^W`) are removed without being moved anywhere.
- While the terminal is not running the letter layer is dimmed and inert, like the quick keys.
- VoiceOver gets the switch as an action: 「字母键盘」 on the quick layer, 「快捷键」 on the letter layer.
- **Observable when done**: on the outer display, swipe up, type `git status` ⏎ with two thumbs, swipe down, then use the arrows or ^C. In a short window (outer display in landscape) the same works in place, with no sheet.

### Decisions & tradeoffs

- **D1 The letter layer replaces the dock, it does not stack**: while it shows, the quick rows are not visible or touchable. Rejected: letters rising above the quick rows (the recommended option) — the owner chose the whole swap. Based on: Discussion log 2.
- **D2 The letter layer is one UIKit multi-touch surface**, built by generalising the tall layout's key block (`FullKeyBlockView` in `apps/ios/Coflux/Views/FullKeyboard.swift`) to take a layout, so both keyboards share finger tracking, send-on-release, slide-off cancel, ⌫ repeat and `FullKeyEncoder`. Rejected: one SwiftUI key view per key — SwiftUI arbitrates gestures between sibling views and drops or reorders the second finger of fast two-thumb typing (plan `20261110-ios-inner-tall-keyboard` D3; the `RepeatKey` doc comment in `TerminalInputArea.swift`). Rejected: a second, separate UIKit view — it would duplicate the touch state machine. Based on: (decided in exploration).
- **D3 The tall layout's keyboard behaves exactly as before**: generalising the block changes no key, byte, timing, modifier, dictation or layout of `FullTerminalKeyboard`. Based on: Discussion log 1.
- **D4 Each layer owns its swipe**: the quick layer keeps the existing SwiftUI vertical drag; the letter surface recognises its own vertical swipe in UIKit and reports it into the same host callbacks (drag translation, end with predicted translation). A touch that becomes a swipe sends nothing. Rejected: relying on the dock-wide SwiftUI `simultaneousGesture` to see touches that land in a `UIViewRepresentable` — whether it does, and whether its recognition cancels the UIKit touches, is undocumented and would make a key fire at the start of every swipe-down (the failure already seen with `RepeatKey` on the Duo, 2026-11-10). Exactly one source drives a given drag. Based on: (decided while planning).
- **D5 The drag model stays**: the host's `keypadReveal` / `keypadHeight`, rubber band and settle rules in `WorkspaceDetailView.swift` keep working unchanged in spirit; `keypadHeight` becomes the letter layer's height minus the quick layer's, and the terminal is offset by `-keypadReveal` and keeps the resting (quick layer) padding, so it never resizes during the swap. Based on: the `keypadReveal` doc comment in `WorkspaceDetailView.swift` (owner's call 2026-11-08: no resize after the drag).
- **D6 Short windows swap in place**: the keypad sheet and the short-window special case (`shortWindow`, `shortPageHeight`, `showingKeypad`) are deleted. Rejected: keeping a sheet with the letter layer — two forms of one feature. Based on: Discussion log 7.
- **D7 Dead code goes with it**: `TerminalExtraKeys` and the dock's `inlineKeypad` branch are deleted. `inlineKeypad: true` has no caller since the tall layout moved to `FullTerminalKeyboard`. Based on: `dock(inlineKeypad:)` in `WorkspaceDetailView.swift` is only called with `false`.

### Discussion log

1. The inner display open tall after the change: dock everywhere and delete the full keyboard (recommended) / always-on letter layer / keep the full keyboard → **keep the full keyboard** (D3).
2. Quick rows while letters show: keep them below (recommended) / swap the whole dock → **swap the whole dock** (D1).
3. Old extra keys `⇧⇥ ^R ^U ^L ^Z ^W : ~ |`: delete all (recommended) / ⇧⇥ into the letter layer / ⇧⇥ into the quick rows → **delete all**.
4. ⏎ on the letter layer returns to the quick layer? no, swipe down only (recommended) / yes → **no**.
5. Upper case: no ⇧ (recommended) / one-shot ⇧ → **no ⇧**.
6. Space held to talk (recommended) / space only types a space → **space only types a space**.
7. Short windows: swap in place (recommended) / keep a sheet → **swap in place** (D6).
8. Product confirmation → **confirmed**.
9. Departure check → direction approved; **subagent(opus)**; **plain autopilot**.
10. Each layer owns its swipe; the letter surface reports its own (D4) `(decided while planning)`.

### Maintenance notes

- D4 is the place to look if a swipe down on the letter layer ever types a letter, or a swipe misses: the letter surface's swipe recognition decides it alone.
- The letter layer has no punctuation. If the owner asks for `-`, `.`, `/` or `~`, it is a layout change in one table, not a new mechanism.

## Execution brief

> Written for `subagent(opus)` at `4c9b4654`. Implement the milestones in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

The iOS terminal dock (`TerminalInputArea`, used on every layout but the inner display open tall) has a quick layer of two key rows. Today a swipe up pulls out two rows of extra keys above it (`TerminalExtraKeys`), or opens them as a sheet in a short window. Replace that: a swipe up swaps the whole dock for a lower-case letters-and-digits layer, a swipe down swaps it back. The letter layer is built on the tall layout's multi-touch key block (`FullKeyBlockView`), generalised to take a layout. The extra keys, the sheet and the dock's unused inline mode are deleted.

Conventions: SwiftUI with `@Observable`, Swift 6; colours and fonts from `apps/ios/Coflux/Views/Theme.swift`; doc comments in English describing behaviour (match the surrounding style). The project uses Xcode buildable folders, so no `project.pbxproj` edit is needed for new code in existing files; prefer keeping the new code in the existing files.

### Milestone 1: the key block takes a layout

Depends on: none

#### T1 · `FullKeyBlockView` lays out and behaves from a layout value

- Where: `apps/ios/Coflux/Views/FullKeyboard.swift` — `final class FullKeyBlockView`, its `private static let rows`, `static let columns`, `static func height(keyHeight:)`, `private static let slots`, and `begin(_:)` (the `if key == .space { scheduleTalk(entry) }` branch).
- Change: move the rows, the column count and whether space talks into a layout value the view is created with. Keep today's Mac layout as one such value, used by `FullTerminalKeyboard`. Add the letter layout:

  ```
  1 2 3 4 5 6 7 8 9 0
  q w e r t y u i o p
  a s d f g h j k l ⏎
  z x c v b n m ␣ ⌫
  ```

  Digits are sent as plain characters with no shifted alternate; letters as `.letter`; `⏎` `.enter`; `␣` `.space`; `⌫` `.backspace`. No modifiers, no ⇪, no arrows, no tab.
- After:
  - The Mac layout's keys, columns, spans, row gap, fonts, modifier latching, space prewarm (330 ms) and talk (450 ms), ⌫/arrow repeat and every byte sent are exactly as before (D3).
  - In the letter layout a space tap types a space and a held space never prewarms or talks; ⌫ held repeats with `RepeatKey` timing; every row spans the full width; each key sends on release and is cancelled by sliding more than the slop off it.
  - A digit cap shows only its digit (no small shifted character above it). The letter layer's space cap shows no microphone and no 按住说话. ⏎ is drawn inverted like the Mac layout's ⏎.
  - `height(keyHeight:)` (or its replacement) answers for a given layout.
- Don't: copy the touch-tracking code into a second view (D2).

#### T2 · The letter surface reports its own vertical swipe

- Where: same file, `FullKeyBlockView` touch handling (`touchesBegan` / `touchesMoved` / `touchesEnded` / `touchesCancelled`) and the SwiftUI wrapper (`private struct FullKeyBlock: UIViewRepresentable`, or a generalised replacement).
- Change: give the view an optional swipe behaviour, enabled only for the letter layout: a single tracked finger whose movement becomes mainly vertical past the dock's drag threshold (10 pt: the dock drag's `minimumDistance` and `RepeatKey`'s private `slop`) turns into a keypad swipe. From then it reports the vertical translation (global coordinates, measured from where the touch began) through a drag callback while it moves, and the predicted end translation (translation plus a velocity term, so a short flick down settles shut) through an end callback when it lifts or is cancelled.
- After: a touch that became a swipe sends no key and starts no repeat; the key under it shows unpressed. Taps and fast two-thumb typing are unaffected. With the swipe behaviour off (the Mac layout) nothing changes (D3). A cancelled swipe still reports its end so the host settles.
- Don't: rely on a SwiftUI gesture attached around the representable to see these touches (D4).

### Milestone 2: the dock swaps layers

Depends on: Milestone 1

#### T3 · The dock is the quick layer or the letter layer

- Where: `apps/ios/Coflux/Views/TerminalInputArea.swift` — `struct TerminalInputArea`: `var inlineKeypad`, `var keypadReveal`, `onKeypadHeight`, `@State private var extrasHeight`, `var body`, `private var dock`, the `.accessibilityAction(named: keypadReveal > 0 ? "收起按键" : "展开按键")`, and the type's doc comment.
- Change: rebuild `dock` so it shows the quick key rows at rest and the letter layer (the M1 surface with the letter layout, wired to the active terminal like `FullKeyBlock` does) once the dock is swiped up. `keypadReveal` now runs from 0 to the letter layer's height minus the quick layer's; the dock's height grows by `keypadReveal` above the resting quick layer, and the two layers cross-fade with progress. Report that height difference through `onKeypadHeight`. Remove `inlineKeypad` and its branch (D7) and `TerminalExtraKeys` (T5).
- After:
  - At rest (`keypadReveal == 0`) the dock looks and behaves exactly as today's quick rows, secret bar included; `onRestingHeight` still reports the quick layer's height.
  - Open, only the letter layer is visible and touchable; the quick keys are not hit-testable. While a drag is under way the layer the drag started on stays hit-testable, so dropping hit testing never cancels a running drag.
  - The quick layer keeps the existing SwiftUI vertical drag, attached so that it does not cover the letter surface; the letter surface's own swipe (T2) calls the same `onKeypadDrag` / `onKeypadDragEnd` callbacks (D4). Only one source ever drives a drag.
  - The letter layer uses the dock's side inset, bottom gap and the quick keys' key height (`Theme.Metrics.keyHeight`) unless Your call says otherwise; it is dimmed to 0.45 and inert while `sender.sessionID == nil`.
  - The VoiceOver action reads 「字母键盘」 when the quick layer shows and 「快捷键」 when the letter layer shows, and toggles.
  - The secret-request bar still floats just above the dock's top edge, outside its measured height.
- Don't: size the letter layer or the height difference from a measurement of the dock's own animated frame — the dock's height depends on `keypadReveal`, and feeding a measurement of it back spun SwiftUI in an endless layout loop on the Duo (the note in `keyRows`). Use a fixed-size measurement or the static row metrics.

#### T4 · The host drives one swap on every dock layout, with no sheet

- Where: `apps/ios/Coflux/Views/WorkspaceDetailView.swift` — `@State private var showingKeypad`, `static let shortPageHeight`, `private var shortWindow`, the `.sheet(isPresented: $showingKeypad)` block, `private func dock(inlineKeypad:)`, `keypadDragChanged`, `keypadDragEnded`, `toggleKeypad`, the `.onChange(of: keypadHeight)` handler, and the doc comments on `keypadHeight` / `keypadReveal`.
- Change: delete the keypad sheet, `showingKeypad`, `shortWindow` and `shortPageHeight` with their branches (D6); drop the `inlineKeypad` parameter from `dock` (D7). Keep the drag, rubber band and settle logic for every dock layout, short windows included.
- After: in any dock layout, swiping up swaps to the letter layer and the terminal rides up by `keypadReveal` without resizing (the `.offset(y: reserveDock && layout != .tall ? -keypadReveal : 0)` and the resting padding stay) (D5); swiping down swaps back; a clear flick settles in its direction; ⏎ or any other key never changes the layer. The tall layout (`tallArrangement`, `fullKeyboard`) is untouched. Doc comments describe the letter layer, not "extra keys" or a sheet.

#### T5 · The extra keys are gone

- Where: `apps/ios/Coflux/Views/TerminalInputArea.swift` — `struct TerminalExtraKeys` and its doc comment.
- Change: delete it.
- After: no reference to `TerminalExtraKeys` remains anywhere under `apps/ios`.

### Your call

- Column spans of the letter layout, as long as every row fills the width and the order of keys is the one in T1; the letter layer's row gap, key corner radius and fonts (match the dock's quick keys or the Mac block, consistently).
- The space cap's label in the letter layer (blank or a short word), and the cross-fade curve.
- The velocity term of the predicted end translation in T2, and the exact "mainly vertical" test.
- Naming and the shape of the layout value; whether the SwiftUI wrapper is generalised or a second small wrapper is added.

### Landmines

- `FullKeyBlockView.willMove(toWindow:)` and `dismantleUIView` cancel all touches; when the dock swaps layers the letter surface may be mounted permanently or created on demand — either way a swipe in progress must still reach `onKeypadDragEnd`, or the host is left with `keypadDragStart` set.
- `keypadDragChanged` in `WorkspaceDetailView.swift` ignores drags while the dictation overlay is visible (the finger slides from 🎤 onto 发送 / 取消); keep that guard.

### Scope

In scope:
- `apps/ios/Coflux/Views/FullKeyboard.swift`
- `apps/ios/Coflux/Views/FullKeyEncoding.swift` (only if the letter layout needs a key kind it lacks)
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `apps/ios/Coflux/Views/Theme.swift` (only for letter-layer fonts or metrics)

Out of scope:
- The tall layout's `FullTerminalKeyboard` behaviour and the `tallArrangement` / `laptopPose` code — D3.
- The quick key rows' keys and layout, `HoldToTalk`, the compose layer, the toolbar items.
- `apps/desktop`, `crates`, `packages` — iOS only.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- Generalising `FullKeyBlockView` would change any byte, timing or layout of the tall keyboard.

## Verification

### Milestone validations

- Milestone 1: the iOS device compile below → `** BUILD SUCCEEDED **`, no new warnings in the touched files.
- Milestone 2: the same compile, plus `rg -n "TerminalExtraKeys|showingKeypad|shortWindow|shortPageHeight|inlineKeypad" apps/ios` → no matches.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| iOS device compile | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED, no new warnings |
| Dead references | `rg -n "TerminalExtraKeys\|showingKeypad\|shortWindow\|shortPageHeight\|inlineKeypad" apps/ios` | no output |
| Duo walkthrough (acceptance) | install on the USB-paired Duo (xcodebuild with the device id + `devicectl` install/launch) and hand to the owner | the observable behaviour in the Requirement |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] Reading the diff, the Mac layout's rows, spans, delays, modifier code and encoder calls are unchanged (D3).
- [ ] In the letter layout, space never reaches the prewarm/talk path and a touch that became a swipe never reaches `onPress` (D4).
- [ ] The dock's quick-layer drag does not cover the letter surface; one source per drag (D4).
- [ ] The terminal offset and resting padding still come from `keypadReveal` and the quick layer's height (D5).
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- iOS only: ships with the next `ios-<N>` tag; no centre deploy, no desktop release.
- Acceptance is the owner's on the Duo: outer display portrait and landscape (short window), inner display open wide, and a check that the inner display open tall is unchanged.

## Outcome

- Status: APPROVE — 2026-11-17
- Mode: subagent(opus), one package (two serial milestones), no revision rounds
- Commits: `122ebb29..37011c3f`
- Deviations: the letter layer still swipes while the terminal is not running (its keys are dimmed and send nothing) — accepted, otherwise the dock could be stuck on the letter layer until the terminal runs; a few comments outside the listed anchors reworded to drop "extra keys" / short-window wording.
- Verification: iOS device compile BUILD SUCCEEDED with exactly the baseline's warnings (none in touched files); no `TerminalExtraKeys` / `showingKeypad` / `shortWindow` / `shortPageHeight` / `inlineKeypad` left under `apps/ios`; diff reviewed against D1–D7. Installed on the Duo (Debug, direct install); the walkthrough is the owner's.
- Follow-ups: device check that the hidden letter layer never takes taps at rest (it relies on SwiftUI `allowsHitTesting(false)` over a `UIViewRepresentable`) and that a swipe down starting on a letter key types nothing. A fresh worktree needs `apps/ios/Frameworks/CofluxTailcat.xcframework` copied in (a symlink is not accepted) and its own `-derivedDataPath` to build.
