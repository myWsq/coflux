# Plan 056: iOS terminal scrolling—disable status-bar jump, add bottom shortcut, retain toggle bubble

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat ecfab0f..HEAD -- apps/ios/Coflux/Views/TerminalHostView.swift apps/ios/Coflux/Views/WorkspaceDetailView.swift apps/ios/Coflux/Views/TerminalInputArea.swift`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `ecfab0f`, 2026-07-28

## Requirement

Device feedback on 2026-07-28 identified three related changes:

1. Tapping status bar scrolls UIScrollView terminal to top, an accidental action in this context. Disable it.
2. Add one-tap scroll-to-bottom beside the lower-right keyboard bubble, visible only away from bottom.
3. Keep keyboard bubble visible in **both states**. With pad expanded, it becomes Collapse. Remove the input area's separate collapse button, leaving one toggle.

Afterward, status-bar taps do not scroll. Only the active terminal's off-bottom state shows the shortcut; tapping reaches bottom and hides it immediately. The persistent keyboard bubble expands/collapses input, without a duplicate inside the input area.

## Decisions & tradeoffs

- **Set scrollsToTop=false at TerminalView creation**. No conditional exception: status-bar jumps are unwanted throughout. SwiftTerm TerminalView inherits UIScrollView at iOSTerminalView.swift:54; host creation is TerminalHostView.swift:47-66.
- **Use SwiftTerm scrolling API**: show when active terminal canScroll and scrollPosition<1; invoke scroll(toPosition:1). Direct contentOffset manipulation desynchronizes yDisp/userScrolling. Source AppleTerminalView.swift:2009-2056; canScroll excludes alternate buffer.
- **Report off-bottom through scrolled delegate**, currently empty at TerminalHostView.swift:150, keyed by taskID. Executor chooses callback like onSizeChanged or registry like TerminalModeRegistry (:7-22). Only active task drives shared button.
- **bottomTrailing vertical stack**: bottom shortcut above keyboard/collapse. Keyboard remains visible with state-specific icon; lift whole column above expanded panel using existing panelHeight. Existing inputCollapsed-only render at WorkspaceDetailView.swift:128-152 is explicitly rejected.
- **Remove composer-row collapse button** at TerminalInputArea.swift:58-66 and its collapsed Binding if no consumers remain; no dead parameter.
- **No inherited layout animation**: layout snaps immediately; only bubble transition animates. Per-frame terminal resize causes remote TUI flicker, learned in 053 and documented at WorkspaceDetailView.swift:129-131,147-149.

## Direction

### Milestone 1: Scrolling and persistent bubbles

Set scrollsToTop in makeUIView, report scrolled state, rebuild bubble column, and remove input-area collapse button in one diff. Build and residual grep below pass.

## Landmines

- scrolled fires on user drag but may not fire when output changes maxScrollback. If stale, supplement with rangeChanged (:166, currently empty) or feed-path refresh. Missing/stuck buttons reveal stale state.
- canScroll=false in alternate-screen vim/htop correctly hides shortcut; do not invent TUI scrolling.
- panelHeight from onGeometryChange at WorkspaceDetailView.swift:107-111 may be zero initially; inspect button position jumps on expansion.

## Scope

In scope: Views/TerminalHostView.swift, WorkspaceDetailView.swift, TerminalInputArea.swift.

Out of scope: SwiftTerm internals (public APIs only), TerminalComposeOverlay/send semantics, Web/mobile.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Removed collapse button | `grep -n 'keyboard.chevron.compact.down' apps/ios/Coflux/Views/TerminalInputArea.swift` | No output, exit 1; same icon is valid in bubble |
| Device acceptance | Status-bar no-op; off-bottom shortcut appears/jumps/hides; expanded pad retains collapse bubble; no duplicate; vim/htop hide shortcut | User confirmation |

## Done criteria

- [ ] Build and grep checks pass.
- [ ] Tapping the status bar does not scroll.
- [ ] The bottom shortcut appears away from the bottom, scrolls to the bottom and disappears on tap, and affects only the active task.
- [ ] The keyboard bubble remains present in both states with matching icon/semantics; the old input-area collapse button and dead parameters are removed.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded changes required, or validation fails twice after one reasonable fix.

## Maintenance notes

- Fix stale off-bottom state through feed refresh before considering polling.
- Recheck scrollPosition/canScroll semantics on SwiftTerm upgrades.

### Original source references

`Sources/SwiftTerm/iOS/iOSTerminalView.swift:54`, `apps/ios/Coflux/Views/TerminalHostView.swift:47-66`, `Apple/AppleTerminalView.swift:2009-2056`, `TerminalHostView.swift:7-22`, `apps/ios/Coflux/Views/WorkspaceDetailView.swift:128-152`, `apps/ios/Coflux/Views/TerminalInputArea.swift:58-66`, `TerminalHostView.swift:166`.
