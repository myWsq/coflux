# Plan 053: Mobile terminal input—persistent control pad, native composer, and collapsible bubble

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update `plans/README.md`.
>
> Drift check: `git diff --stat e4e9b94..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none (prerequisites 049–052 are DONE)
- Category: feature
- Execution: self
- Planned at: `e4e9b94`, 2026-07-26

## Requirement

Mobile terminal input, not display, is the bottleneck. Tapping a terminal to type through a soft keyboard lacks Esc/Ctrl/arrows, interrupts reading, and invites accidental focus. The user selected:

- **Display-only terminal**: no tap-triggered system keyboard or SwiftTerm shortcut accessory.
- **Persistent compact control pad**: never automatically hides based on input state. Dedicated keys send 1–0 for TUI menus, Esc, `/`, Tab, Shift+Tab, Backspace, ^C, four arrows, Enter. No letters or sticky Ctrl; text belongs in the composer.
- **Native composer**: TextField/system IME including Chinese; edit a whole passage before sending. **Send appends carriage return; long press inserts text only.**
- **Manual glass-bubble collapse**: collapse the entire composer/pad into a lower-right AssistiveTouch-like glass circle; tap to expand. No automatic collapse.

Workbench becomes tabs, display terminal, and composer above pad, routed to active task. Remove 049's keyboard-focus transfer/resign logic.

## Decisions & tradeoffs

- **Two input layers**, explicitly chosen: mostly single-key agent interactions (menus/y/n/Esc/Shift+Tab), occasionally full prompts. Reject terminal-tap soft keyboard and custom full QWERTY; user chose compact controls plus native text.
- **No letters means no sticky Ctrl**. Dedicated ^C sends `\x03`; add other dedicated combinations only when needed, not a modifier system.
- **Display-only SwiftTerm**: subclass inputView to return an empty view, suppressing system keyboard while preserving firstResponder for selection/copy; inputAccessoryView returns nil. Keep delegate send for hardware pressesBegan passthrough. Remove isActive/resignFirstResponder at TerminalHostView.swift:15,30-32; no soft keyboard means no accidental keyboard routing.
- **Respect DECCKM arrows**: application cursor mode sends ESC O A..D, normal mode ESC [ A..D. Query active terminal's applicationCursor via registry; unavailable instance falls back to CSI. Always-CSI can break TUI arrows.
- **Sequences**: Esc=`\x1b`, Tab=`\t`, Shift+Tab=`\x1b[Z`, Backspace=`\x7f`, ^C=`\x03`, Enter=`\r`, slash literal. Shift+Tab supports Claude Code mode cycling.
- **Route shared pad/composer to activeTask.sessionID** through client.sendInput (CofluxClient.swift:480). Disable with reduced opacity if not RUNNING or no session.
- **User-selected send behavior**: primary sends text+CR, long press text only; clear draft but retain focus for continuing conversation.
- **Collapse button at composer-row end** hides entire input area; lower-right overlay uses glassEffect(.regular.interactive(), in:.circle), like 050. Tap expands. State is not persisted, though retained within session.
- **Resize follows existing sizeChanged→resizeSession** when input area changes terminal height; no extra path.

## Direction

### Milestone 1: Display-only SwiftTerm

Override inputView/inputAccessoryView, remove focus flags/resign logic, expose applicationCursor registry query. Build and residual grep pass.

### Milestone 2: Input area and bubble

New view contains composer row, three-row keypad, and collapse bubble; attach below workbench, routing/disabling by active task. Add light key haptics. Build passes.

## Landmines

- Preserve user project.pbxproj/Coflux.xcscheme signing edits, as in 047–052.
- If SwiftTerm lacks the assumed applicationCursor property, use CSI fallback and record debt; do not modify SwiftTerm.
- Composer keyboard temporarily covering pad is expected; no avoidance animation needed while composing.
- Revisit bottom ignoresSafeArea because terminal no longer touches screen bottom. A bottom safe area may remain when collapsed; avoid two competing safe-area policies.

## Scope

In scope: Views/TerminalHostView.swift, WorkspaceDetailView.swift, and new input-area views.

Out of scope: Client/** and protocol; cursor-driven composer state/agent hooks; iPad/landscape (iPhone portrait first).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Focus residual | `grep -rn 'isActive\|resignFirstResponder' apps/ios/Coflux/Views/` | No output, exit 1 |
| Device interaction | Check menu digits/Esc/^C/arrows/Shift+Tab, Chinese composer/send, bubble collapse/expand, no keyboard on terminal tap | User confirmation |

## Done criteria

- [ ] Build and residual-reference checks pass.
- [ ] Tapping a terminal does not open the system keyboard and no built-in accessory strip remains; hardware keyboard passthrough is preserved.
- [ ] Every control-pad key sends the specified sequence to the active task and is disabled without a session.
- [ ] Send emits text plus Enter; long press inserts text only. Sending clears the draft and retains focus.
- [ ] The collapsed control becomes a lower-right glass bubble; tapping expands it and resizes the terminal.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded changes required, or validation fails twice after one reasonable fix.

## Maintenance notes

- Future input-container enhancements: cursor-driven composer hints, repeat-on-long-press, custom keys. On 2026-07-26 Claude Code DECTCEM correctly hid cursor in menus/showed it for input, needing 100–200ms debounce.
- Add dedicated missing frequent keys such as Ctrl+D or repeating arrows, not a modifier system.
