# Research 20261117-ios-in-app-keyboard: the letter layer as Coflux's own keyboard, presented by the system

> Research note and TODO, not an executable plan. When the spike below is
> picked up, `dev:explore` / `dev:write-plan` turn it into a plan of its own.

## Status

- Status: TODO — research done, spike not started
- Depends on: `20261116-ios-dock-letter-layer` (the letter layer and its key logic are reused as they are)
- Recorded: 2026-11-17, at `6271d2ea`

## Question

The owner asked whether the dock's letter layer could behave like an input
method such as WeChat's: sit where the system keyboard pops up, span the
screen, and work only inside Coflux, not in other apps.

## Conclusion

Yes, without building an input method. iOS lets an app give any of its own
views a keyboard: a view that can become first responder presents whatever
view is set as its `inputView` in the keyboard's place, with the keyboard's
animation, full width, under the system bars, and only inside this app.

- The terminal view already does this: `TerminalHostView.swift`, in
  `makeUIView`, sets `view.inputView = UIView()` (plan 053) so the system
  keyboard never appears while the view keeps first responder (selection,
  copy, hardware keyboard). Setting the letter layer there instead, as a
  `UIInputView` with the `.keyboard` style, makes the system present it.
- Rejected: a keyboard extension (the WeChat / Doubao kind). It is installed
  system-wide and cannot be limited to Coflux, needs adding in Settings and
  Full Access, runs in its own process, and can only insert text into a text
  field through `textDocumentProxy` — it cannot write bytes to the PTY, so
  every key would go through a field and be relayed by the app.

## What it would bring

- Position, the slide-up animation and the full width come from the system:
  the rail and the split view's sidebar insets that the dock now works out
  itself (`railReach`, `SidewaysOpenRectangle` in `WorkspaceDetailView.swift`
  and `TerminalInputArea.swift`) are no longer the app's problem, nor the
  sidebar bug they caused on the Duo.
- The system keyboard's backdrop (`UIInputView` `.keyboard` style) and its
  click sound (`UIInputViewAudioFeedback` + `UIDevice.playInputClick()`).
- 中文 can swap the responder's `inputView` between the letter layer and the
  system keyboard (`reloadInputViews()`), instead of opening the separate
  compose layer.

## Costs and risks

- **No finger-following reveal.** The system animates the keyboard in and
  out; today's dock follows the finger with a rubber band. A swipe up would
  only trigger the presentation; dismissing needs its own gesture (a swipe
  down on the keyboard, or a key).
- **The page layout changes model — the main risk.** The terminal page is
  insulated from the keyboard today (`.ignoresSafeArea(.keyboard)` in
  `WorkspaceDetailView.swift` and `TerminalInputArea.swift`) and the
  terminal is pushed up by `keypadReveal` without resizing. With a system
  keyboard the terminal has to follow the keyboard's frame (the keyboard
  layout guide or keyboard notifications). Plans 053–058 tried listening to
  the keyboard height and riding a panel on it and dropped it; their outcome
  was "no keyboard hacks". The spike must show on the Duo that opening,
  closing, rotating and moving between the inner and outer display neither
  flicker nor resize the PTY unexpectedly.
- **The quick layer's place.** Either it becomes a second input view the
  system presents too, or it stays in the page's dock and only the letter
  layer is a keyboard. Undecided.
- First responder must stay on the terminal view while the keyboard is up;
  anything that takes it (the compose layer, the secret sheet, a pager
  swipe to another terminal) dismisses the keyboard.

## TODO

- [ ] After PR #151 has been used for a few days and its keys have settled,
      merge it.
- [ ] Spike on its own branch: set the letter layer (`FullKeyBlockView` with
      `Layout.letters`, wired to the active terminal) as the terminal view's
      `inputView` inside a `.keyboard`-style `UIInputView`; present it from
      the dock's swipe up; dismiss on a swipe down. Leave the quick layer as
      it is.
- [ ] On the Duo, judge: the presentation and dismissal feel; the terminal
      following the keyboard without flicker or unwanted resizes (outer
      display portrait and landscape, inner display open wide and tall,
      Split View, moving between displays); the backdrop and click sound.
- [ ] Decide from the spike whether to move the letter layer (and maybe the
      quick layer and 中文) onto system presentation, and plan it.
