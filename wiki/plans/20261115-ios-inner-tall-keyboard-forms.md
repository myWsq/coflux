# Plan 20261115-ios-inner-tall-keyboard-forms: the inner display, open tall, has a two-row dock that pulls up into the full-size keyboard

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ed90eb1d..HEAD -- apps/ios/Coflux/Views/WorkspaceDetailView.swift apps/ios/Coflux/Views/TerminalInputArea.swift apps/ios/Coflux/Views/FullKeyboard.swift`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none (builds on `wiki/plans/20261110-ios-inner-tall-keyboard.md`, DONE)
- Category: feature
- Execution: self — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (plain autopilot)
- Workspace: isolated — cut from the main worktree into `.claude/worktrees/20261115-ios-inner-tall-keyboard-forms` on `dev/20261115-ios-inner-tall-keyboard-forms`
- Planned at: `ed90eb1d`, 2026-11-15

## Record

### Requirement

On the iPhone Duo's inner display, open tall, the terminal page today always shows the full-size Mac keyboard (plan `20261110-ios-inner-tall-keyboard`), which takes more than a third of the screen. Every other layout has a two-row dock of the most used keys that pulls up into more keys. The user wants the same two forms in tall: a collapsed form and the complete keyboard pulled up from it, with the collapsed form laid out exactly like the other layouts' dock so nothing has to be relearned.

Product conclusions (confirmed by the user), for the tall layout, fully open (flat):

1. **Collapsed form**: the other layouts' two-row dock, unchanged — `esc tab [input] ↑ ⌫ ⏎` over `^C ^D / ← ↓ → ⏎`, the tall ⏎ spanning both rows, the input key composing on a tap and talking on a hold.
2. **Expanded form**: today's full-size keyboard, unchanged. Expanded, it replaces the two rows. The tall layout has no pulled-out extra keys (`1 2 3 4 q : ~ …`).
3. **Expanding**: a swipe up over the dock, as in the other layouts. The keyboard follows the finger and settles open or shut on release.
4. **Collapsing**: a swipe down anywhere on the full keyboard. A key under the swiping finger is not sent. While talking through the held space key nothing collapses.
5. **Terminal**: expanded, the terminal is pushed up by the extra height; its rows and columns do not change (its top is out of view). Collapsed, it is back in place.
6. **Memory**: the form is remembered globally — across terminals, across closing and opening the phone, across app launches. The first run is collapsed.
7. **Not in this cut**: the half-folded (laptop) pose — the user never uses the phone half folded and it is not to be designed for; it keeps today's full keyboard. The outer display, the inner display open wide and Split View windows are unchanged.

Observable when done: on the Duo, inner display open tall, the terminal page opens with the two-row dock and a terminal that reaches down to it; swiping up on the dock raises the full keyboard and the terminal rides up without reflowing; swiping down on the keyboard puts it away; leaving the page, closing and opening the phone, or relaunching the app brings back the form last used.

### Decisions & tradeoffs

- **D1 One pull-out mechanism**: tall-flat drives its two forms with the page's existing pull-out state (the reveal amount that follows the finger, the rubber band, the spring settle, the terminal offset by the same amount). What is revealed is the full keyboard; the reveal's limit is the full keyboard's height minus the dock's. Rejected: a separate two-state toggle with its own animation — a second mechanism for the same gesture, and no finger following. Based on: `keypadDragChanged` / `keypadDragEnded` / `setKeypad` in `apps/ios/Coflux/Views/WorkspaceDetailView.swift`.
- **D2 The PTY never resizes for the form**: in tall-flat the terminal's resting bottom edge is always the dock's top edge, in both forms; the expanded keyboard only offsets the terminal. Rejected: resizing after the drag settles (the recommended option) — the user chose push-up only. Based on: Discussion log 3; the same rule the other layouts follow (`keypadHeight` doc comment in `WorkspaceDetailView.swift`: "no resize after the drag").
- **D3 A collapse drag cancels keys, it does not race them**: once a downward drag on the full keyboard is recognised, every pending key under any finger is dropped as if the system cancelled the touch (nothing sent, timers stopped, a prewarmed microphone released). The drag is not recognised while dictation is talking. Rejected: letting key release and drag both fire — a swipe would type the key it started on. Based on: `FullKeyBlockView.touchesCancelled` / `abandon` in `apps/ios/Coflux/Views/FullKeyboard.swift`.
- **D4 Collapsing is stricter than expanding**: on release of a drag that began on the full keyboard, the keyboard collapses only when the predicted downward travel exceeds 80 pt or it is already less than half out; the dock keeps today's rule (a 24 pt predicted flick settles in its direction). An accidental drag while typing costs at most the key it began on. Rejected: the dock's 24 pt rule on the keyboard — a sloppy keystroke would put the keyboard away. Based on: Discussion log 1 (the user chose the whole keyboard as the swipe area over the safer top row; this is the guard that choice needs). The 80 pt figure is a starting value to tune on the device.
- **D5 Form memory is one persisted flag, tall-flat only**: a single app-wide boolean (expanded or not, default not) read when tall-flat appears and written when a drag or toggle settles there. Other layouts neither read nor write it; leaving tall-flat resets the reveal to shut. Rejected: per-terminal or per-workspace memory — the user asked for one global habit. Based on: Discussion log 2.
- **D6 Touch ownership follows the settled form**: the dock takes touches while collapsed and the full keyboard while expanded; ownership changes only when a drag or toggle settles, never mid-drag. Rejected: switching by reveal progress — flipping hit testing under a finger cancels the drag (noted for the extra keys in `TerminalInputArea.dock`).
- **D7 Top-anchored overlays do not ride up**: the terminal list that drops from the avatars stays where it is when the terminal is pushed up, in every layout. Rejected: leaving it inside the offset — expanded in tall it would be 230 pt off the top. `(decided while planning)` Based on: `terminalColumn(reserveDock:)` applies `.offset` after the `.overlay(alignment: .topTrailing)`.
- **D8 The laptop pose is untouched**: half folded, the page mounts the full keyboard below the fold exactly as before, with no dock, no collapse drag and no effect on the remembered form. Based on: Discussion log 4.

### Discussion log

1. Switching gesture — top-row swipe down (recommended) / swipe down anywhere on the keyboard / a collapse key / gesture and key → **swipe down anywhere on the keyboard** (D3, D4).
2. Default form — remember the last one, first run collapsed (recommended) / always collapsed / always full → **remember, first collapsed** (D5).
3. Terminal while expanded — follow the finger then resize once settled (recommended) / push up only → **push up only, rows unchanged** (D2).
4. Laptop pose — always full (recommended) / also collapsible → the user: **do not consider the half-folded pose, now or later; it is never used** (D8).
5. Product confirmation of the seven conclusions → **confirmed**.
6. Departure check → **self**, **plain autopilot**.
7. The terminal list stays put when the terminal rides up (D7) `(decided while planning)`.

### Maintenance notes

- D4's threshold lives in one place in the page's drag-end handling; tune it there after using the keyboard on the device.
- The dock and the full keyboard still share `TerminalKeySender`; both forms send through it.
- Acceptance happens only on the device: the simulator cannot link Tailcat.

## Execution brief

> Written for `self` at `ed90eb1d`. Implement the tasks in order. Decide only
> what Your call leaves to you; on anything else that is unclear, stop and
> report.

### Goal

In the iOS app (`apps/ios`, SwiftUI + UIKit), give the tall layout's flat pose two keyboard forms: the existing two-row dock (`TerminalInputArea`) collapsed, the existing `FullTerminalKeyboard` expanded, switched by the page's existing pull-out drag. Conventions: colours and fonts from `Theme`, English doc comments, dark only, no tests (UI is accepted by hand), no formatter configured — match the surrounding style. The milestones are serial.

### Milestone 1: both inputs can take part in the pull-out

Depends on: none

#### T1 · The dock can be mounted without its extra keys

- Where: `apps/ios/Coflux/Views/TerminalInputArea.swift` — `struct TerminalInputArea`, `private var dock`.
- Change: add an option (default: extra keys shown) that leaves `TerminalExtraKeys` unmounted in `dock`.
- After: with the option off the dock is the two quick rows with the same padding, background, vertical drag callbacks (`onKeypadDrag`, `onKeypadDragEnd`), VoiceOver toggle action and floating secret bar as today; it never reports a keypad height. With the option on nothing changes.

#### T2 · The full keyboard reports a downward drag and drops its keys for it

- Where: `apps/ios/Coflux/Views/FullKeyboard.swift` — `struct FullTerminalKeyboard`, `private struct FullKeyBlock`, `final class FullKeyBlockView`.
- Change: give `FullTerminalKeyboard` two optional callbacks — the drag's vertical translation so far, and the drag's end with its predicted final vertical translation, both in window coordinates (the keyboard moves under the finger). Both the key block and the Claude row feed them.
- After:
  - A one-directional downward drag starting anywhere on the key block or the Claude row is reported; a sideways or upward movement is not recognised.
  - When the drag is recognised on the key block, every tracked touch is abandoned exactly as `touchesCancelled` does today: nothing is sent, repeat and talk timers stop, a prewarmed microphone gets `onDictateAbort` (D3).
  - While a touch is talking (`talking` is true) no drag is recognised (D3).
  - A drag the system cancels still ends through the end callback, so the host can settle.
  - With the callbacks nil (the laptop pose, D8) no recogniser is active and the keyboard behaves exactly as before.
- Don't: send the key the drag began on (D3). Don't report local coordinates.

### Milestone 2: the tall page has two forms

Depends on: Milestone 1

#### T3 · Tall-flat mounts the dock and the full keyboard on one reveal

- Where: `apps/ios/Coflux/Views/WorkspaceDetailView.swift` — `private var tallArrangement`, `private func fullKeyboard(keyHeight:laptop:)`, `private func dock(inlineKeypad:)`, `terminalColumn(reserveDock:)`, the `// MARK: - Pulling the keypad out` functions, the `.onChange(of: keypadHeight)` handler.
- Change: in the flat pose, the arrangement's primary view shows the dock (without extra keys, T1) and the full keyboard together, driven by `keypadReveal`:
  - The visible input area's height is the dock's height plus `keypadReveal`, its bottom edge fixed; the full keyboard is top-aligned in it at its natural height (48 pt keys), so its top rises with the finger. The dock fades out and the keyboard fades in with the reveal's progress.
  - `restingDockHeight` in tall-flat is the dock's height in both forms (D2); `keypadHeight` (the reveal's limit) is the full keyboard's height minus the dock's (D1).
  - The terminal offset applies in tall-flat too: remove the `layout != .tall` condition from `.offset(y: reserveDock && layout != .tall ? -keypadReveal : 0)`.
  - The dock's drag callbacks and the full keyboard's (T2) both feed `keypadDragChanged`; on release, a drag from the dock settles by today's rule, a drag from the full keyboard by D4: collapse only when the predicted downward translation exceeds 80 pt, otherwise by whether the reveal is past half.
  - Touches: the dock is hit-testable only while the form is collapsed, the full keyboard only while expanded, where the form is the last settled one (D6). The hidden one is also hidden from VoiceOver; the full keyboard offers a VoiceOver action 「收起键盘」.
  - Form memory (D5): one `@AppStorage` boolean, default false. When tall-flat appears, when the reveal's limit first becomes known, and when the pose returns from laptop to flat, set `keypadReveal` to the limit or 0 from it without animation. `setKeypad(open:)` writes it when the layout is tall-flat. When the layout stops being tall, set `keypadReveal` to 0.
  - Move the terminal list overlay (`.overlay(alignment: .topTrailing)` in `terminalColumn`) outside the offset so it does not ride up (D7).
- After:
  - Tall-flat, collapsed: the page looks like the other layouts' dock at the bottom, the terminal ending above it. Swiping up over the dock raises the full keyboard following the finger; released, it springs open or shut. Expanded: the full keyboard is exactly today's; the terminal is shifted up by the limit with unchanged rows and columns.
  - No PTY resize happens when the form changes (D2).
  - While the dictation overlay is visible neither drag moves the keyboard (existing guard in `keypadDragChanged`).
  - The secret-request bar is visible above the top edge of whichever form shows, and is not clipped by the input area's clipping.
  - The laptop pose renders the full keyboard filling the region below the fold as before, with no dock and nil drag callbacks (D8).
  - Compact, split and short-window pages behave exactly as before, apart from D7.
- Don't: feed a measured width or height back into the keys' own sizing — derive sizes from the space offered (`keyRows` comment in `TerminalInputArea.swift`: a feedback loop there hung the app until the watchdog killed it). Don't clip the input area with a plain `.clipped()` — the secret bar floats above its top edge.

### Your call

- Names of the new option, callbacks, storage key and any helper view; whether the tall input area is a helper in `WorkspaceDetailView.swift` or its own small view.
- How the downward drag is recognised on the key block (a `UIPanGestureRecognizer` with `cancelsTouchesInView`, or tracking inside the touch handlers) and on the Claude row (a SwiftUI simultaneous drag is fine).
- The fade curves of the two forms and the input area's background during the transition.
- How the full keyboard's height reaches the page (measured through `onHeight`, or a static computation from the key height).

### Landmines

- `DictationZone.hit` expects global points (`onDictateMove` in `WorkspaceDetailView.swift`); keep passing window coordinates.
- `SidebarEdgeSwipe` sits behind the pager in tall; do not put a full-width gesture over the terminal.

### Scope

In scope:
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/FullKeyboard.swift`

Out of scope:
- `FullKeyEncoding.swift`, `HoldToTalk.swift`, the key layouts of either input — the forms themselves are unchanged.
- The laptop pose's layout (D8).
- Desktop, runtime, protocol.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.

## Verification

### Milestone validations

- Every milestone: `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/coflux-duo-dd -allowProvisioningUpdates -skipPackagePluginValidation` → `** BUILD SUCCEEDED **`, no new warnings in the touched files.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | the xcodebuild line above | BUILD SUCCEEDED |
| Install (acceptance) | `xcrun devicectl device install app --device 00008160-001230303A20000A /tmp/coflux-duo-dd/Build/Products/Debug-iphoneos/Coflux.app` | installed (phone unlocked) |
| Launch (acceptance) | `xcrun devicectl device process launch --device 00008160-001230303A20000A --terminate-existing dev.coflux.Coflux` | launched |

### Done criteria

- [ ] The build passes with no new warnings.
- [ ] Every task's `After` state holds.
- [ ] `pageContent`'s non-tall branch is unchanged in the diff; `TerminalInputArea` with the option at its default is behaviourally unchanged.
- [ ] The laptop branch passes nil drag callbacks and mounts no dock.
- [ ] The terminal's bottom padding in tall-flat comes from the dock's height in both forms (no PTY resize on a form change).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.
- [ ] (acceptance, the user on the Duo inner display) the observable list in the Requirement; fast two-thumb typing does not collapse the keyboard.

### Merge and deploy

iOS-only; reaches the user through a direct device install or the next `ios-<N>` tag. No server, runtime or migration change. After the update the tall page opens collapsed once (the flag's default), so the terminal there is taller than before.
