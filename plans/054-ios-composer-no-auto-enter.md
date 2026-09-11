# Plan 054: Stop appending Enter to iOS composer sends—reconsidering plan 053

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 4bcfd8d..HEAD -- apps/ios/Coflux/Views/TerminalInputArea.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none (revisits the shipped behavior of 053)
- Category: bug
- Execution: self
- Planned at: `4bcfd8d`, 2026-07-27

## Requirement

Plan 053 chose text+CR for Send and text-only for long press (053:64). Device use reversed that decision on 2026-07-27: automatic CR submits immediately to the line editor/agent, removing control over when to execute.

TerminalComposeOverlay now sends draft text only, never appending `\r`. The existing large Enter key at the pad's lower right remains the sole explicit submission action. Remove Send's long press, whose alternate text-only meaning is now redundant. Swapping tap/long-press semantics is explicitly rejected: remove automatic Enter entirely.

## Decisions & tradeoffs

- **Tap sends text only**, with no automatic-CR path. User rejected retaining text+Enter on long press. Existing calls are onSend(true)/onSend(false) at TerminalInputArea.swift:304-311.
- **Delete newline Boolean chain**, onSend(_ newline:) and sendDraft(newline:), rather than permanently passing false. Dead parameters mislead. WorkspaceDetailView.swift:337-346 is sole consumer; :343 appends CR.
- **Preserve multiline bracketed paste** for drafts containing newline. `\u{1b}[200~ … [201~` protects internal newlines, independently of appending CR. Source :340-342 and 2026-07-26 Claude Code/zsh mode-2004 evidence.
- **Update comments** at TerminalInputArea.swift:6 and TerminalComposeOverlay :222 to text-only. Keep plan 053's original decision as history; this plan records the reversal.

## Direction

### Milestone 1: Text-only Send

Pure deletion, no new interaction/state: Send forwards draft, preserving multiline bracketed wrapping, without CR; remove long press/newline parameters and update comments. Build succeeds and newline grep has no matches.

## Scope

In scope: Views/TerminalInputArea.swift and WorkspaceDetailView.swift.

Out of scope: TerminalHostView hardware input; pad enterKey still sends CR; historical 053; Web/mobile input.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Parameter residual | `grep -rn 'newline' apps/ios/Coflux/Views/` | No output, exit 1 |
| Device acceptance | Send single/multiline draft: inserted but not executed; press pad Enter to execute | User confirmation |

## Done criteria

- [ ] Build and grep checks pass.
- [ ] Send delivers text only, retaining bracketed paste for multiline text, with no appended `\r`.
- [ ] The Send button has no long-press gesture; onSend/sendDraft have no newline parameter.
- [ ] Both comments describe the new semantics correctly.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded changes required, or validation fails twice after one reasonable fix.

## Maintenance notes

- Before restoring one-step send+Enter, revisit 053/054 reversals. A dedicated pad combination may be better than automatic Send submission.
- User performs device UI acceptance; Claude does not run simulator walkthroughs.

The milestone also checks `grep -n 'newline' apps/ios/Coflux/Views/*.swift` for leftover parameter references.

### Original source references

`plans/053-ios-terminal-input-model.md:64`, `apps/ios/Coflux/Views/TerminalInputArea.swift:304-311`, `apps/ios/Coflux/Views/WorkspaceDetailView.swift:337-346`, `apps/ios/Coflux/Views/WorkspaceDetailView.swift:340-342`.
