# Plan 055: Single-line plain-text iOS composer—remove bracketed paste, revisiting 053/054

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat b236eb0..HEAD -- apps/ios/Coflux/Views/TerminalInputArea.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none (further narrows the behavior after 054)
- Category: bug
- Execution: self
- Planned at: `b236eb0`, 2026-07-28

## Requirement

After 054 removed appended CR, device users still saw occasional automatic submission. Multiline drafts were bracketed with `\u{1b}[200~…[201~`, which only protects newlines if the receiver enabled mode 2004. Otherwise wrappers are ignored and raw draft newlines execute.

User decision on 2026-07-28: composer is **single-line plain text**, without newline support or escape wrappers. Multiline entry is outside its responsibility. Keyboard Enter no longer inserts newline; sending defensively replaces pasted CR/LF so emitted bytes contain neither.

## Decisions & tradeoffs

- **Single-line TextField**: remove axis:.vertical and lineLimit(1...6) at TerminalInputArea.swift:291-292. Multiline editing flattened only on send would violate what users see.
- **Remove wrapping, sanitize at send boundary**: delete sendDraft bracketed-paste branch and replace draft newlines with spaces, including pasted ones. Single-line UI alone does not guarantee paste safety. Source WorkspaceDetailView.swift:340-343.
- **Keyboard Enter means Send**, decided while planning: submitLabel(.send)/onSubmit use the same text-only path as button, preserving 054's no-CR rule. Merely dismissing keyboard wastes a frequent action.
- **Keep pad pasteKey unchanged**: clipboard may legitimately contain multiline text; its bracketed paste belongs to a separate input path, not the composer restriction. It works correctly when receiver mode 2004 is enabled; the disabled-mode limitation is independent of this plan and was not reconsidered by the user (TerminalInputArea.swift:124-132).

## Direction

### Milestone 1: Single-line plain-text composer

Remove multiline TextField modifiers, wire keyboard submit to Send, delete composer paste wrappers, replace CR/LF with spaces, and align the TerminalInputArea header, pasteKey’s “same as composer” comment, and sendDraft documentation. The build and both grep checks below pass.

## Scope

In scope: Views/TerminalInputArea.swift and WorkspaceDetailView.swift.

Out of scope: control-pad pasteKey, terminal/hardware input, Web/mobile, and historical decisions in 053/054.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| No composer paste wrapper | `grep -n '200~' apps/ios/Coflux/Views/WorkspaceDetailView.swift` | No output; exit 1 |
| No multiline axis | `grep -n 'axis' apps/ios/Coflux/Views/TerminalInputArea.swift` | No output; exit 1 |
| Device acceptance | Single-line entry; keyboard Send inserts only text; pasted multiline is flattened and never executes automatically | User confirmation |

## Done criteria

- [ ] Build and both grep checks pass.
- [ ] The input is single-line; keyboard Return and the Send button use the same text-only path, without appending `\r`.
- [ ] Sent bytes contain neither `\n` nor `\r`, and no bracketed-paste wrapper.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded changes required, or validation fails twice after one reasonable fix.

## Maintenance notes

- Bracketed paste is safe only with receiver mode 2004, so unconditional sender wrapping is unreliable. Future multiline composer support must depend on receiver state, potentially cursor visibility signals, rather than unconditional wrapping.

### Original source references

`apps/ios/Coflux/Views/TerminalInputArea.swift:291-292`, `apps/ios/Coflux/Views/WorkspaceDetailView.swift:340-343`, `apps/ios/Coflux/Views/TerminalInputArea.swift:124-132`.
