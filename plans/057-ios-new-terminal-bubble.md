# Plan 057: Move New terminal into the lower-right floating-button column

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 18e9bd1..HEAD -- apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (builds on the floating button column from 056)
- Category: feature
- Execution: self
- Planned at: `18e9bd1`, 2026-07-28

## Requirement

User feedback on 2026-07-28: the tab-bar plus is hard to reach. Move it to 056's lower-right column and remove it from tabs entirely.

Column order, top to bottom: persistent New, conditional scroll-to-bottom, persistent keyboard/collapse. Tabs contain only task chips. Keep the large empty-state New terminal button: the bubble column is hidden without tasks, so these entries complement rather than duplicate each other.

## Decisions & tradeoffs

- **Lower-frequency New at top; frequent keyboard at thumb position**. Bottom shortcut appears between them. Putting New last occupies the high-frequency position and interacts poorly with appearing/disappearing shortcut.
- **Same 52pt interactive glass circle**, plus icon, matching existing two buttons. Smaller size would disrupt the short column's rhythm. Reference WorkspaceDetailView's post-056 VStack.
- **Remove tab plus completely**, not duplicate it; duplicate entries add noise and contradict moving an unreachable control.
- **Keep empty-state button**, because column renders only when !members.isEmpty.

## Direction

### Milestone 1: Three-button column

Add New at top, remove tab plus, reuse createTerminal() and known-ID-difference auto-activation unchanged. Build succeeds; tab area has no plus button, while column may.

## Scope

In scope: Views/WorkspaceDetailView.swift.

Out of scope: TerminalInputArea.swift, TerminalHostView.swift, empty-state behavior.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Device acceptance | Column plus creates/activates; tabs have no plus; empty-state creation remains; inspect three-button arrangement | User confirmation |

## Done criteria

- [ ] The build passes.
- [ ] Floating controls run top to bottom: New → conditional Scroll to Bottom → Keyboard/Collapse; the tab bar has no plus button.
- [ ] Creating a terminal retains automatic activation semantics.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded changes required, or validation fails twice after one reasonable fix.

## Maintenance notes

- Before exceeding three floating buttons, consolidate lower-frequency actions into top toolbar menus rather than growing indefinitely.
