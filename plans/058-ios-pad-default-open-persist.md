# Plan 058: Expand pad by default, remember per workspace, stabilize floating controls—revisiting 053/057

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 0ae44ce..HEAD -- apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `0ae44ce`, 2026-07-28

## Requirement

The workbench currently starts collapsed (inputCollapsed=true), based on the 2026-07-26 reading-first decision. Device feedback on 2026-07-28 reverses that: expand by default and remember expanded/collapsed state locally **per workspace** across reentry. Previously unseen workspaces start expanded.

After collapse/leave/return, that workspace stays collapsed; another untouched workspace still expands. UserDefaults only, no cross-device sync.

The same feedback revises 057 order: a transient middle scroll-to-bottom button moves New when appearing. Put it at top so the bottom-aligned column grows upward: conditional bottom shortcut→New→keyboard. Persistent controls stay fixed.

## Decisions & tradeoffs

- **Default expanded**, explicitly reversing prior decision. Source WorkspaceDetailView.swift:16's inputCollapsed=true/comment.
- **Per-workspace UserDefaults key includes workspace.id**. Per-task state fragments across frequent creation/removal; one global value contradicts user-requested per-project memory.
- **Store collapsed Boolean**. bool(forKey:) defaults false, naturally expanded, without optional/three-state logic. Storing expanded would make missing false mean collapsed and require inversion.
- **Transient shortcut first**, so bottom alignment grows upward without moving New/keyboard. User rejected 057's middle position.
- **Seed State(initialValue:) in custom init**, not onAppear. Post-first-frame assignment causes visible jump and unnecessary terminal resize/SIGWINCH. terminalLift at :31 derives directly from inputCollapsed.

## Direction

### Milestone 1: Expanded default and workspace memory

Initialize inputCollapsed from workspace-keyed UserDefaults, write on change, and update old :16 comment. Apply stable column ordering. Build passes.

## Scope

In scope: Views/WorkspaceDetailView.swift.

Out of scope: iCloud KVS/cross-device sync; composer-draft persistence, not requested.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Device acceptance | Fresh workspace expands; collapse/leave/return retains state; other workspace unaffected; app restart retains memory | User confirmation |

## Done criteria

- [ ] The build passes.
- [ ] The pad defaults to expanded; state persists per workspace and restores on reentry/restart.
- [ ] Floating controls run top to bottom: conditional Scroll to Bottom → New → Keyboard. Showing the conditional control does not move persistent controls.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded changes required, or validation fails twice after one reasonable fix.

## Maintenance notes

- Prefix terminalPadCollapsed. Remaining keys after workspace removal are negligible; no cleanup needed.

### Original source references

`apps/ios/Coflux/Views/WorkspaceDetailView.swift:16`, `WorkspaceDetailView.swift:31`.
