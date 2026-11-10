# Plan 20261110-ios-inner-tall-keyboard: a full-size Mac keyboard on the inner display, open tall

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 26c9c752..HEAD -- apps/ios/Coflux/Views/TerminalInputArea.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift apps/ios/Coflux/Views/TerminalHostView.swift apps/ios/Coflux/Views/HoldToTalk.swift apps/ios/Coflux/Views/SceneNavigation.swift apps/ios/Coflux/Views/Theme.swift`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (plain autopilot)
- Workspace: current — already in the linked worktree `dev/20261109-ios-duo-inner-display`
- Planned at: `26c9c752`, 2026-11-10

## Record

### Requirement

On the iPhone Duo's inner display, open tall (626–669 × 890–951 pt), there is room for a real keyboard. Vibe coding with Claude Code there today means a two-row dock of shortcut keys plus the system keyboard in a compose layer. The user wants a full-size keyboard that types straight into the terminal, as if a Mac keyboard were plugged in.

Product conclusions (confirmed by the user, mockup `wiki/plans/20261110-ios-inner-tall-keyboard-mockup.html`):

- **Where**: only when the window's layout is the tall one (inner display open tall, flat or half folded). It replaces the dock and the swipe-up extra keys there. The outer display, the inner display open wide, Split View windows and short windows keep today's dock unchanged.
- **What it is**: an app-drawn keyboard whose keys send bytes to the PTY. It is not an input method: no Chinese, no suggestions, no autocorrect.
- **Layout**, top to bottom:
  - Claude row: `esc`, `⇧⇥ 模式`, `^C`, an empty gap, `粘贴`, `中文`. It never changes with the agent's state.
  - `` ` 1 2 3 4 5 6 7 8 9 0 - = ⌫ `` (each key shows its shifted symbol small above)
  - `tab q w e r t y u i o p [ ] \`
  - `⇪ a s d f g h j k l ; ' ⏎`
  - `⇧ z x c v b n m , . / ↑` — no right ⇧; the corner above → is empty
  - `ctrl ⌥ [space] ← ↓ →` — space centred on the board, the four arrows one size, ↑ straight above ↓
  - No ⌘ key.
- **Sizes**: 48 pt keys when flat. Half folded (laptop pose) the keyboard sits below the fold and its keys grow to fill that space.
- **Modifiers ⇧ ctrl ⌥**: a tap arms the modifier for the next key only; a second tap within 300 ms locks it (a bar under the cap); a tap on a locked one unlocks it; holding it while another finger taps a key chords like a hardware key. While ⇧ applies, letter caps show upper case and the number and symbol keys show their shifted character big. ⇪ toggles the ⇧ lock.
- **Pressing**: a key sends when the finger lifts; a finger that slides off the key cancels it. ⌫ and the arrows repeat while held. Every send gives a light haptic. While the terminal is not running the whole keyboard is greyed and inert.
- **Space**: a tap types a space and never opens the microphone. Held for 450 ms it starts dictation, the same overlay and flow as today's microphone key (slide onto 发送 / 取消, or lift for the confirm state). The cap reads a mic glyph and 按住说话.
- **中文**: opens the existing compose layer with the system keyboard (pinyin). **粘贴**: the existing paste (an image on the clipboard uploads first).
- **Not in this cut**: key magnifier bubbles, space-drag cursor, letter repeat, custom layouts, the full keyboard on other displays, hardware keyboard handling.
- **Observable when done**: on the Duo, inner display open tall, a Claude Code terminal can be driven without the system keyboard — an English prompt with ⇧⏎ line breaks, ⏎ to submit, ⇧⇥ to cycle modes, ctrl→c to clear, the approval menu answered with 1 / 2 / 3 or ↑↓⏎, `/compact` + ⏎, Chinese by holding space or through 中文. Half folded, every key is below the fold. On the outer display the dock is exactly as before.

### Decisions & tradeoffs

- **D1 Trigger**: the full keyboard shows exactly when `ShellLayout` is `.tall`, in both poses; every other layout keeps today's dock with no change. Rejected: laptop pose only, or an on-demand toggle — the user wants it always there in tall. Based on: Discussion log; `ShellLayout.choose(for:)` in `apps/ios/Coflux/Views/SceneNavigation.swift` maps a large window taller than wide to `.tall`.
- **D2 Replace, not stack**: in tall the full keyboard is the page's whole input area; the quick rows, the swipe-up extra keys and their drag are not mounted there. Rejected: keeping the dock above it — duplicated keys and a drag that would fight multi-touch typing. Based on: Discussion log ("取代 dock").
- **D3 One UIKit touch surface**: the main key block (the five rows under the Claude row) is one `UIView` that receives all touches itself (`isMultipleTouchEnabled`), hit-tests each touch against its key frames and runs every key's state machine. Rejected: one SwiftUI `Button` or gesture per key — SwiftUI arbitrates gestures between siblings and drops or reorders the second finger of a chord or of fast two-thumb typing. Based on: (decided in exploration); the existing per-key gesture fights recorded in `TerminalInputArea.swift` (`RepeatKey` doc comment: "used to send on touch-down … fired an arrow at the start of every swipe").
- **D4 Legacy xterm encoding, one exception**: a pure function maps (key, active modifiers, application-cursor mode, keyboard-enhancement flags) to bytes, using legacy xterm sequences: ctrl+letter → C0 byte, ctrl+`[` `\` `]` → ESC FS GS, ctrl+space → NUL, ⌥ → ESC prefix, ⇧⇥ → `CSI Z`, ⌥⌫ → `ESC DEL`, modified arrows `CSI 1;m X` with m = 1 + ⇧1 + ⌥2 + ctrl4, plain arrows `ESC [` or `ESC O` by DECCKM. The exception is ⇧⏎ and ⌥⏎: when the terminal's kitty keyboard flags are non-empty (the program negotiated the protocol) they send `CSI 13;2u` and `CSI 13;3u`, otherwise both send `ESC CR`. Rejected: full kitty encoding of every key — it changes bytes Claude Code already reads correctly in legacy form and multiplies the surface to verify; always `ESC CR` — once Claude Code negotiates kitty, the desktop sends `CSI 13;2u` for ⇧⏎, and the phone should send what the desktop sends. Based on: desktop enables `vtExtensions: { kittyKeyboard: true }` (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:330`); sessiond keeps kitty flags across replays (`crates/runtime/src/sessiond.rs`, `state_dump` asserts `kitty_flags`); SwiftTerm exposes `TerminalInputStateSnapshot.keyboardEnhancementFlags` next to `applicationCursor`. (decided while planning)
- **D5 No ⌘**: there is no ⌘ key. Rejected: a ⌘ key translated iTerm-style (⌘← → ^A) — the desktop rule is that ⌘ never enters the terminal (`apps/desktop/src/renderer/components/workbench/terminal-key-ownership.ts`), and the only ⌘ action that matters on the phone, paste, has its own key. Based on: Discussion log.
- **D6 Space dictation reuses the page's dictation**: holding space for 450 ms calls the same prewarm / begin / move / end / abort callbacks the microphone key uses today, with the finger's position in global (window) coordinates; prewarm fires at 330 ms. A touch that lifts or is cancelled before 450 ms types nothing extra and, if prewarm fired, calls abort so the microphone is released. A tap never prewarms. Rejected: today's 120 ms prewarm — slow taps while typing would flash the microphone indicator. Based on: `HoldToTalk` in `apps/ios/Coflux/Views/HoldToTalk.swift` (prewarm 120 ms, begin 0.28 s); `DictationZone.hit` takes global points; Discussion log (C = 450 ms).
- **D7 Modifier semantics**: per modifier the state is off / once / locked, plus "held" while a finger is on it. A tap (touch down and up with no other key sent meanwhile) cycles off → once; once + second tap within 300 ms of the first → locked; once + a later tap → off; locked + tap → off. A key sent while a modifier is held applies it and marks that hold as used, so lifting a used hold does not toggle it. Sending any non-modifier key clears every "once" modifier. ⇪ toggles ⇧ between off and locked. Based on: Discussion log; mockup `tapMod` / `consumeMods`.
- **D8 Sizing**: flat, key height is 48 pt and the terminal ends above the keyboard's top edge, resizing only when the keyboard's height changes (layout change), never while typing. Half folded, the keyboard fills the region after the fold and its rows share the available height. Based on: Discussion log (A = 48, B = fill); the tall arrangement already places the input after the fold (`tallArrangement` in `WorkspaceDetailView.swift`).
- **D9 Waiting agents get no special handling**: neither the Claude row nor any key changes with the agent's `approval` / `question` state. Based on: user instruction 2026-11-10, already applied to the dock in `26c9c752`.
- **D10 Secret requests stay reachable**: the secret-request bar that floats above the dock today floats above the full keyboard the same way, outside its measured height. Based on: `notice` in `TerminalInputArea.swift` (the only way to open the secret sheet from the page).

### Discussion log

1. Keyboard nature — system keyboard + Claude strip / app-drawn QWERTY straight to the PTY / a Claude control panel without letters → **app-drawn QWERTY**.
2. When it shows — always in tall, replacing the dock / laptop pose only / on demand → **always in tall, replacing the dock** (D1, D2).
3. Layout — Mac 14-column / phone 10-column with a symbols layer → **Mac** (exact rows settled in the mockup).
4. Modifiers — one-shot + double-tap lock + hold chord / one-shot only / hold only → **all three** (D7).
5. Claude row extras — mic key, 中文 key, ^O ^T ^B, slash commands → **mic key and 中文**; the user then replaced the mic key with hold-space ("长按空格键其实就可以说话", D6).
6. Feel items — magnifier bubble / space cursor / letter repeat / haptics → **haptics only**.
7. Product confirmation → confirmed, continue to implementation.
8. User asked for an HTML mockup review first. Mockup decisions: A key height 44 / **48** / 52; B laptop pose **fill** / original size at the fold / original size at the bottom; C hold threshold → **450 ms** (recommended); D space cap **writes 按住说话**; E **keep 粘贴**.
9. Layout corrections from the mockup: ctrl to the bottom-left corner, space centred, no stacked half-height ↑↓, no right ⇧, all four arrows one size.
10. ⌘ — the user asked whether ⌘ was missing; after learning the desktop never sends ⌘ to the terminal → **no ⌘** (D5).
11. Separately the user removed all waiting-agent special handling from the dock (committed `26c9c752`) → also governs this keyboard (D9).
12. Departure check → **subagent(opus)**, **plain autopilot**.
13. ⇧⏎ bytes follow the negotiated kitty flags, like the desktop (D4) `(decided while planning)`.

### Maintenance notes

- D4 is the place to revisit if Claude Code changes how it reads newlines: the bytes live in one pure function.
- The legacy compact/split dock and this keyboard share `TerminalKeySender` (bytes, haptics, paste, uploads); keep sending through it so both inputs behave alike.
- Acceptance happens only on the device: the simulator cannot link Tailcat, and `devicectl` screenshots of the inner display come out black.

## Execution brief

> Written for `subagent(opus)` at `26c9c752`. Implement the tasks in order.
> Decide only what Your call leaves to you; on anything else that is unclear,
> stop and report.

### Goal

In the iOS app (`apps/ios`, SwiftUI + UIKit, iOS 26 SDK), add a full-size Mac-layout terminal keyboard that replaces the dock whenever the window's layout is `ShellLayout.tall`. Keys send bytes to the active terminal's PTY through the existing `TerminalKeySender` (`apps/ios/Coflux/Views/TerminalInputArea.swift`). The reference for look and behaviour is the approved mockup `wiki/plans/20261110-ios-inner-tall-keyboard-mockup.html` (open it; its `ROWS`, `claudeRow`, `encode`, `tapMod`, `consumeMods` and pointer handling are the behavioural model, its CSS the visual one). Follow the repo's iOS conventions: colours and fonts only from `Theme` (`apps/ios/Coflux/Views/Theme.swift`), English doc comments on new types, no native `title`-style tooltips, dark only. There is no Swift formatter configured; match the surrounding style. Do not write tests (repository policy: UI is accepted by hand).

### Milestone 1: the byte encoder and terminal state it needs

Depends on: none

#### T1 · The registry also reports the terminal's kitty keyboard flags

- Where: `apps/ios/Coflux/Views/TerminalHostView.swift` — `final class TerminalModeRegistry` and the `register(` call in `updateUIView` (`applicationCursor: { [weak uiView] in uiView?.terminalInputStateSnapshot()?.applicationCursor ?? false }`).
- Change: register a second closure that reads `terminalInputStateSnapshot()?.keyboardEnhancementFlags` and expose a `keyboardEnhanced(taskID:) -> Bool` (true when the flags are non-empty), owner-guarded exactly like `applicationCursor(taskID:)`.
- After: for a task whose program pushed kitty flags, the registry answers true; for a plain shell, false; for an unknown task, false.

#### T2 · A pure encoder maps a key press to bytes

- Where: a new file `apps/ios/Coflux/Views/FullKeyboard.swift` (add it to the Xcode project's Coflux target; check how `HoldToTalk.swift` is listed in `apps/ios/Coflux.xcodeproj/project.pbxproj` — if the project uses a synchronized folder group, no project edit is needed).
- Change: define the key model (an enum or struct for each key kind: character key with base and shifted character, letter key, tab, ⏎, ⌫, space, the four arrows, ⇧, ctrl, ⌥, ⇪) and a pure function `(key, modifiers {shift, ctrl, alt}, applicationCursor: Bool, keyboardEnhanced: Bool) -> String?` (nil = sends nothing).
- After (D4), with no modifiers unless stated:
  - letter `a` → `a`; ⇧ → `A`; ctrl → `\u{01}`; ctrl+⇧ → `\u{01}`; ⌥ → `\u{1b}a`; ⌥+⇧ → `\u{1b}A`.
  - `2` → `2`; ⇧ → `@`; `;` ⇧ → `:`; ⌥+`.` → `\u{1b}.`.
  - ctrl + `[` `\` `]` → `\u{1b}` `\u{1c}` `\u{1d}`; ctrl + `2` → `\u{00}`; ctrl + `6` → `\u{1e}`; ctrl + `-` → `\u{1f}`; ctrl + any other non-letter character → the character unchanged.
  - space → ` `; ctrl → `\u{00}`; ⌥ → `\u{1b} `.
  - tab → `\t`; ⇧ → `\u{1b}[Z`.
  - ⏎ → `\r`; ⇧ or ⌥ with `keyboardEnhanced == false` → `\u{1b}\r`; ⇧ with `keyboardEnhanced == true` → `\u{1b}[13;2u`; ⌥ with `true` → `\u{1b}[13;3u`; ctrl+⏎ → `\r`.
  - ⌫ → `\u{7f}`; ⌥ → `\u{1b}\u{7f}`; ctrl → `\u{08}`.
  - arrow ← with no modifier → `\u{1b}[D`, or `\u{1b}OD` when `applicationCursor`; any modifier → `\u{1b}[1;<m>D` with m = 1 + (⇧ ? 1 : 0) + (⌥ ? 2 : 0) + (ctrl ? 4 : 0), regardless of application-cursor mode. Same letters as today: ↑ A, ↓ B, → C, ← D.
  - ⇧ / ctrl / ⌥ / ⇪ themselves → nil.
- Don't: encode ordinary keys as kitty `CSI … u` even when `keyboardEnhanced` is true — only ⇧⏎ and ⌥⏎ change (D4).

### Milestone 2: the keyboard view

Depends on: Milestone 1

#### T3 · The main key block is one UIKit touch surface

- Where: `apps/ios/Coflux/Views/FullKeyboard.swift`.
- Change: implement a `UIView` subclass with `isMultipleTouchEnabled = true` that lays out the five rows below and handles `touchesBegan/Moved/Ended/Cancelled` itself, tracking each `UITouch` separately (D3), wrapped in a `UIViewRepresentable` for SwiftUI.
- Rows (columns are units of one shared grid; reproduce the mockup's proportions: in the mockup a letter key is 4 of 58 units, the row gap is 6 pt, keys have 3 pt horizontal margin, corner radius 12):
  1. `` ` 1 2 3 4 5 6 7 8 9 0 - = `` (4 units each) + ⌫ (6)
  2. tab (6) + `q w e r t y u i o p [ ] \` (4 each)
  3. ⇪ (7) + `a s d f g h j k l ; '` (4 each) + ⏎ (7)
  4. ⇧ (8) + `z x c v b n m , . /` (4 each) + ↑ (5) + empty (5)
  5. ctrl (8) + ⌥ (7) + space (28) + ← (5) + ↓ (5) + → (5)
- After:
  - Key caps: character keys draw the base character large and the shifted character small above (numbers and symbols); letter keys draw one letter. While ⇧ applies (held, once or locked) letters draw upper case and character keys swap which character is large. Function keys (tab, ⇪, ⏎, ⌫, ⇧, ctrl, ⌥, arrows) use the secondary surface; ⏎ is the inverted primary (`Theme.primary` fill, `Theme.primaryForeground` glyph). Space shows a mic glyph and 按住说话 in muted text. An armed ("once") or held modifier draws inverted; a locked one draws inverted with a short bar under its glyph; ⇪ draws locked while ⇧ is locked. A pressed key dims to 0.6 opacity.
  - Touch down records the key under the touch (nothing sent). Touch moving more than 6 pt outside that key's frame cancels it (nothing sent, timers stop) — except modifiers, which stay held. Touch up on a non-cancelled key sends it once through the encoder and `TerminalKeySender.press` (which already plays the light haptic), then clears every "once" modifier (D7).
  - ⌫ and the four arrows: held for 0.35 s they send at once and then every 80 ms until the touch ends or is cancelled; lifting after repeating sends nothing more. Reuse `RepeatKey`'s timing constants if you extract them.
  - Modifiers follow D7 exactly: tap off → once; tap on once within 300 ms of the previous tap → locked; tap on once later → off; tap on locked → off; a key sent while a modifier's finger is down applies it and marks that hold used, and lifting a used hold leaves the modifier's state unchanged. ⇪ tap toggles ⇧ between off and locked.
  - Each send reads `applicationCursor` and `keyboardEnhanced` for the active task from `TerminalModeRegistry` at send time.
  - When `sender.sessionID` is nil the whole block draws at 0.45 opacity and ignores touches.
- Don't: send on touch down, and don't use per-key SwiftUI `Button`s or gestures for this block (D3).

#### T4 · Space: tap types, hold talks

- Where: the touch surface from T3.
- Change: give the space key its own timers: prewarm at 330 ms, begin at 450 ms (D6). Once begun, forward every move of that touch as a global point (`touch.location(in: nil)`, which is window coordinates) and the touch's end as end, its cancellation as abort.
- After: tap (< 330 ms) → sends ` ` on lift, never calls prewarm. Lift between 330 and 450 ms → sends ` ` and calls abort. Held to 450 ms → calls begin (with a medium haptic, as `HoldToTalk` does), sends no space; moves call move with window coordinates; lift calls end; system cancel calls abort. The key draws the dictation state while talking. Other fingers' keys keep working while space is held but not yet talking; while talking, other touches are ignored.
- Don't: reuse the 120 ms prewarm or the `HoldToTalk` modifier on the space key (D6); `HoldToTalk` stays as is for the dock's microphone key.

#### T5 · The full keyboard view: Claude row + key block + secret bar

- Where: `apps/ios/Coflux/Views/FullKeyboard.swift` — a SwiftUI view `FullTerminalKeyboard` taking the same client, task and callbacks `TerminalInputArea` takes for compose, secret and dictation, plus a key height.
- Change: stack the Claude row above the T3 block. The Claude row uses SwiftUI `TerminalKey` / `KeyCap` (from `TerminalInputArea.swift`): `esc` (sends `\u{1b}`), `⇧⇥ 模式` (sends `\u{1b}[Z`), `^C` (destructive style, sends `\u{03}`), a flexible gap, `粘贴` (calls `TerminalKeySender.paste()`, with the same haptic as other keys), `中文` (calls the compose callback). Proportions as in the mockup (7 / 10 / 7 / gap / 7 / 9 units). Float the secret-request bar above the keyboard's top edge outside its measured height, the way `TerminalInputArea` does with `notice` (D10). Report the keyboard's measured height to the host.
- After: the Claude row never depends on the agent's state (D9). Every key in both parts goes inert and dims when the terminal is not running. VoiceOver can reach every key with its label (e.g. 删除, 回车, 空格，按住说话).
- Don't: add waiting-state option keys, banners or colours (D9).

### Milestone 3: the page uses it in tall

Depends on: Milestone 2

#### T6 · Tall layout mounts the full keyboard instead of the dock

- Where: `apps/ios/Coflux/Views/WorkspaceDetailView.swift` — `private var tallArrangement: some View`, `private func dock(inlineKeypad: Bool)`, `terminalColumn(reserveDock:)` and the `.padding(.bottom, reserveDock ? restingDockHeight : 0)` / `.offset(y: reserveDock ? -keypadReveal : 0)` lines.
- Change: in `tallArrangement` replace `dock(inlineKeypad: laptop)` with the full keyboard, wired to the same callbacks the dock uses (`setComposing(true)` guarded by `!dictationOverlayVisible`, `openSecretSheet()`, `prewarmDictation()`, `beginDictation()`, the `DictationZone.hit` move, `endDictation()`, `abortDictation()`). Flat: key height 48 pt (D8); the keyboard's measured height feeds `restingDockHeight` so the terminal ends above it; `keypadReveal` stays 0 in tall. Laptop pose: the keyboard fills the region after the fold, top-aligned, with its rows sharing the available height (key height = (available height − Claude row − gaps − bottom padding) / 6, never below 48 pt).
- After: in `.tall` neither the quick rows, the extra keys nor the keypad drag are mounted; the terminal never moves or resizes while typing; switching flat ↔ laptop resizes the terminal once. `.compact` and `.split` pages render exactly as before (`pageContent`'s non-tall branch untouched).
- Don't: change `TerminalInputArea`'s behaviour for non-tall layouts (D1).

### Your call

- Type and file names beyond `FullKeyboard.swift` / `FullTerminalKeyboard`; whether the encoder and key model sit in their own file.
- How the UIKit block draws (sublayers, `draw(_:)`, or child views), as long as touches stay in the one surface.
- Accessibility structure (accessibility elements per key frame are fine).
- Whether modifiers reset when the active terminal changes (default: they persist).
- Fonts for caps, chosen from `Theme.Fonts` (add a role there if none fits).

### Landmines

- `DictationZone.hit` expects global points; a local point puts the finger on the wrong zone (`onDictateMove` in `WorkspaceDetailView.swift`).
- Sizing the keys from the keyboard's own measured width loops SwiftUI's layout until the watchdog kills the app (comment in `keyRows`, `TerminalInputArea.swift`): derive key sizes from the size offered, never from a measurement fed back.
- The terminal page ignores the keyboard safe area (`.ignoresSafeArea(.keyboard)`); the compose layer and the system keyboard overlay the page and must keep doing so.

### Scope

In scope:
- `apps/ios/Coflux/Views/FullKeyboard.swift` (new)
- `apps/ios/Coflux/Views/TerminalHostView.swift` (T1)
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift` (T6)
- `apps/ios/Coflux/Views/TerminalInputArea.swift` — only to make shared pieces reusable (`KeyCap`, `TerminalKey`, `TerminalKeySender`, repeat constants); no behaviour change
- `apps/ios/Coflux/Views/Theme.swift` — new roles only
- `apps/ios/Coflux.xcodeproj/project.pbxproj` — only if the new file needs registering

Out of scope:
- The dock, extra keys and keypad sheet in compact and split layouts — unchanged by D1.
- `HoldToTalk.swift` — the dock's microphone key keeps its timing.
- Desktop, runtime, protocol.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- SwiftTerm's `TerminalInputStateSnapshot` has no `keyboardEnhancementFlags` in the resolved package version.

## Verification

### Milestone validations

- Every milestone: `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -configuration Debug -destination 'id=00008160-001230303A20000A' -derivedDataPath /tmp/coflux-duo-dd -allowProvisioningUpdates -allowProvisioningDeviceRegistration -skipPackagePluginValidation` → `** BUILD SUCCEEDED **`, no new warnings in the touched files.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | the xcodebuild line above | BUILD SUCCEEDED |
| Install (acceptance) | `xcrun devicectl device install app --device 00008160-001230303A20000A /tmp/coflux-duo-dd/Build/Products/Debug-iphoneos/Coflux.app` | installed (phone unlocked; retry on transient errors) |
| Launch (acceptance) | `xcrun devicectl device process launch --device 00008160-001230303A20000A --terminate-existing dev.coflux.Coflux` | launched |

### Done criteria

- [ ] The build passes with no new warnings.
- [ ] Every task's `After` state holds (encoder cases checked by reading the function against T2's list).
- [ ] `pageContent`'s non-tall branch and `TerminalInputArea`'s dock behaviour are unchanged in the diff.
- [ ] The space key's prewarm is at 330 ms and begin at 450 ms; no `HoldToTalk` on it.
- [ ] No ⌘ key, no right ⇧, no waiting-state handling anywhere in the new view.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.
- [ ] (acceptance, the user on the Duo inner display) the observable list in the Requirement; ⇧⏎ inserts a newline in Claude Code.

### Merge and deploy

iOS-only; reaches the user through a direct device install or TestFlight. No server, runtime or migration change.

## Outcome

- Status: APPROVE — 2026-11-11
- Mode: subagent(opus)
- Commits: `07f3aabd..c395682e`
- Deviations: the encoder and key model sit in their own file `FullKeyEncoding.swift` (Your call); laptop-pose key height lets all six rows (Claude row included) share the region below the fold, `max(48, (height − 16 − 5×6) / 6)`; `terminalColumn`'s keypad offset is also gated on `layout != .tall` so a leftover reveal cannot move the terminal there; the secret-request bar moved into a shared `SecretRequestNotice` view used by both inputs (dock unchanged); `KeyCap` / `TerminalKey` gained an optional `functionSurface` for the Claude row's darker fill; `Theme.microphone` and fixed-size `Theme.Fonts.FullKeyboard` caps added; where D4 is silent the encoder follows the mockup (⌥ + ctrl⌫ → `ESC BS`, ⇧⌥⏎ under kitty → `CSI 13;4u`).
- Follow-ups: device acceptance on the Duo inner display was not run (the phone was unavailable over USB); check there that ⇧⏎ inserts a newline in Claude Code (D4), that the bottom row is not delayed by the home-indicator gesture, that left-edge keys do not lose touches to the sidebar edge swipe, and that a system-cancelled touch while talking leaves no stuck dictation overlay (same `abortDictation` path as the dock's microphone key).
