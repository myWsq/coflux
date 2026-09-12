# Plan 047: Restore system navigation and enable iOS Liquid Glass

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat f8fd22b..HEAD -- apps/ios/Coflux/Views/`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (prerequisites 044/046 are DONE)
- Category: feature
- Execution: self
- Planned at: `f8fd22b`, 2026-07-26

## Requirement

The app targets iOS 26 and builds with Xcode 26.6, so system Liquid Glass is available. Yet PRs #23/#24 hid navigation bars on all three pages to imitate Cursor iOS, using custom gray round buttons, 34pt titles, and opaque headers. This bypasses the system navigation/toolbar/back-button surfaces and content-under-glass scrolling that produce the effect.

Afterward, workspace list, task list, and task detail use the existing NavigationStack's system navigation bar, large/inline titles, and toolbar actions. Scrolling shows glass and collapsing titles; Back uses the system glass button. Remove custom headers/title Text/CircleIconButton. Keep login unchanged.

Restore system components rather than applying glassEffect to the custom header: without scrolling content beneath it, the desired effect cannot occur. That alternative was explicitly rejected in exploration.

## Decisions & tradeoffs

- **Restore system chrome** by removing hidden navigation bars/custom headers and using navigationTitle/toolbar. Applying glassEffect or buttonStyle(.glass) to CircleIconButton retains the wrong non-floating structure. Hidden sites: WorkspaceListView.swift:55, TaskListView.swift:51, TaskDetailView.swift:42 under apps/ios/Coflux/Views/.
- **Only three navigation pages**. LoginView's Raycast-style form has neither scrolling chrome nor a reason for glass; leave it out of scope.
- **Keep one NavigationStack**, owned by WorkspaceListView.swift:11 and shared by pushes. No TabView or per-page stacks, which break push/back gestures.
- **Title decisions**: workspace list uses a large workspace title; task list uses the workspace name as large title; task detail uses inline title and iOS 26 navigationSubtitle for running state, maximizing terminal space.
- **Toolbar decisions**: workspace avatar/logout Menu moves to topBarTrailing, replacing Cursor's upper-left placement. Task detail ellipsis/stop-delete Menu also uses topBarTrailing. Back remains system-provided, without custom drawing or dismiss action.
- **Keep banners/status strips**: offlineBanner in workspace list and statusStrip/banner in detail retain implementation/position. They are state messages, not navigation chrome; glass styling is separate work.
- **Preserve local uncommitted signing edits**: DEVELOPMENT_TEAM=8Y2J55823C and version stamps in project.pbxproj/Coflux.xcscheme are user changes. Per 044:189, neither commit nor restore them. Stage only Views/ and plans/; exempt those two files from clean-worktree preflight.

## Direction

One milestone restores system chrome. Design against live code: List should be the navigation container's main scroll view to drive large-title collapse/glass; removing outer VStack's custom header/title should naturally enable this.

### Milestone 1: Restore all three navigation bars

No hidden navigationBar modifiers, custom large-title headers, or CircleIconButton definition/usages remain. Titles/actions follow Decisions.
Validation: simulator build succeeds, and residual grep below returns no matches.

## Landmines

- TaskDetailView.swift:74 uses CircleIconButton(...).allowsHitTesting(false) as Menu label, a nested-button workaround. Replace with ordinary Label/Image, not just new styling.
- TaskListView.swift:8's dismiss environment can go with custom Back. TaskDetailView.swift:10 still needs it for stop/delete confirmation at :47.
- Detail terminal ignores only bottom safe area at :33. Preserve that; ignoring all edges would hide its first line under glass.
- Never commit or restore user project.pbxproj/xcscheme signing edits; restoration breaks device operation.

## Scope

In scope:
- apps/ios/Coflux/Views/WorkspaceListView.swift
- apps/ios/Coflux/Views/TaskListView.swift
- apps/ios/Coflux/Views/TaskDetailView.swift

Out of scope:
- LoginView.swift
- TerminalHostView.swift and Client/, unrelated data/protocol code
- apps/ios/Coflux.xcodeproj/**, user signing
- Banner/status visual changes

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Residual check | `grep -rn 'toolbar(.hidden, for: .navigationBar)\|CircleIconButton' apps/ios/Coflux/Views/` | No output, exit 1 |
| Device visual acceptance | User runs ⌘R, scrolls lists, checks glass/collapsing titles/system Back | User confirmation |

## Done criteria

- [ ] Build and residual-reference checks pass.
- [ ] All three pages show system glass navigation and collapsing large titles while scrolling; detail uses an inline title and subtitle, and Back remains the system default.
- [ ] The avatar Menu for logout and ellipsis Menu for Stop and Delete work in the toolbar with unchanged behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed; in particular, pbxproj/xcscheme retain their existing uncommitted state.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited fact changes, out-of-scope work required, or validation fails twice after one reasonable fix.
- Glass still fails because of a cause outside Views, such as a build compatibility switch: stop and report.

## Maintenance notes

- Visual direction changes from Cursor-style flat custom headers to iOS 26 native glass. Future pages default to system chrome. Web guidelines from f8fd22b do not bind iOS.
- Login/banner texture alignment needs a separate plan.

### Original source references

`apps/ios/Coflux/Views/WorkspaceListView.swift:55`, `plans/044-ios-app-skeleton-client-login.md:189`, `TaskDetailView.swift:47`, `TaskDetailView.swift:33`.
