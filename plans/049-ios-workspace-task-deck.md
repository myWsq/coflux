# Plan 049: Single-page iOS workbench—terminal tabs, full-page swiping, and creation

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier. Stop on any STOP condition. When complete, update
> this plan in `plans/README.md`.
>
> Drift check: `git diff --stat cc3de9e..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none (prerequisites 046/047/048 are DONE)
- Category: feature
- Execution: self
- Planned at: `cc3de9e`, 2026-07-26

## Requirement

Current navigation is workspace list→task list→task detail/terminal. The user wants terminals directly inside the workspace, matching apps/mobile workspace-detail: horizontal tabs switch terminals without another page.

Afterward, a workspace opens a **single workbench** with task tabs and New terminal above a horizontally paged terminal area. Task-list/detail cease to be separate pages. Add taskCreate so iOS no longer depends on desktop-created tasks.

Keep all terminal pages alive for instant tab/swipe switching, matching mobile. Retaining push hierarchy or destroying/rebuilding terminals, replaying checkpoints and flashing on each switch, does not satisfy this.

## Decisions & tradeoffs

- **Merge TaskListView and TaskDetailView** into workbench, linked directly from WorkspaceListView. User explicitly rejected the extra terminal navigation level. Reference mobile workspace-detail.tsx:23.
- **Full-page horizontal paging**, using TabView.page or equivalent, synchronized with tab taps. User knowingly accepted possible SwiftTerm scrollback/selection and system edge-back conflicts. Tab-bar-only swiping was rejected by user; three-finger gestures are too hidden. Observe mitigation points below.
- **Retain all terminals concurrently**, mounting on entry and unmounting together on return to list, like mobile. Active-only attach causes replay flashes/lost scroll. TerminalHostView.swift:51 owns attach per view, and CofluxClient.swift:496 consumers are keyed by sessionID, permitting multiple instances.
- **Include createTask(workspaceID:title:)** sending taskCreate, titled "Terminal N" like mobile. Proto and Swift generation already include it at client.proto:136. Deferral leaves iOS dependent on desktop.
- **No Changes tab**: diff parsing/rendering is a separate substantial plan.
- **Keep per-task statusStrip semantics**: viewing-after-takeover/force takeover, startable idle/exited state, and full input buffer. Stop+taskRemove acts on the active task.
- **Inline workspace-name title**, following 047 glass. Horizontal custom chips/status dots/New button are content, not navigation chrome, so do not violate 047.
- **taskCreate has no request-response correlation**. Follow mobile: capture known task IDs before send, identify newly appearing tasks in this workspace, and activate them. Reference workspace-detail.tsx:188-194.

## Direction

### Milestone 1: Client taskCreate

Add CofluxClient.createTask(workspaceID:title:) sending taskCreate. Build passes.

### Milestone 2: Replace two pages with one workbench

Add e.g. WorkspaceDetailView: scrollable chips/status/New, paged statusStrip+TerminalHostView retained for each task, and creation entry when empty. Link directly from workspace list; delete TaskListView.swift/TaskDetailView.swift. Keyboard focus follows active page.
Validation: build passes; both old files are absent.

## Landmines

- Page-zero edge-right swipe competes with interactivePopGestureRecognizer. Always retain system Back as fallback. Vertical scroll/long-press usually coexist with horizontal paging, but TUI mouse reporting such as Claude Code may consume drags. This is accepted risk for device observation, not a demand for perfect gestures here.
- TerminalView is UIKit firstResponder. On page change, becomeFirstResponder for active view or at least resign old view; wrong-terminal input is correctness failure, not cosmetic.
- Deleted tasks must dismantle/release consumers (TerminalHostView.swift:28,66), including remote deletion and paged-container removal.
- Parallel attach is new; 046 verified only one page. Session-keyed consumers suggest support, but any hidden DeviceRouter single-attach assumption triggers STOP, not an out-of-scope Router change.
- Preserve uncommitted project.pbxproj/Coflux.xcscheme signing edits; synchronized groups handle file additions/removals automatically.
- Other clients' taskUpdated can arrive in the creation window. Match mobile's known-ID set difference, not simply the next new task.

## Scope

In scope: CofluxClient.swift createTask and Views/ workbench, removal of old pages, updated navigation, small TerminalHostView focus changes.

Out of scope: DeviceRouter.swift; Xcode project/signing; diff tab/shortcut-bar enhancements; mobile/Web, read-only references.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Removed pages | `ls apps/ios/Coflux/Views/TaskListView.swift apps/ios/Coflux/Views/TaskDetailView.swift 2>&1` | Neither exists |
| Device acceptance | ⌘R: workspace opens terminal; tab/full-page swipe switches instantly without replay flash; creation activates; deletion converges; takeover banner/force work; observe edge-back | User confirmation |

## Done criteria

- [ ] Build and old-page removal checks pass.
- [ ] Selecting a workspace opens its task deck directly, with no remaining nested task-list/task-detail pages.
- [ ] Multiple tasks remain alive: swiping or selecting tabs produces no checkpoint-replay flash, and keyboard input always reaches the active terminal.
- [ ] iOS can create terminals and automatically activate the new page; deleting the current task reconciles page/tab state without crashing.
- [ ] All three statusStrip banner semantics are preserved per task.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed, especially pbxproj/xcscheme/DeviceRouter.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited fact changes, parallel attach needs Router/protocol changes, or validation fails twice after one reasonable fix.

## Maintenance notes

- If device testing finds unusable edge-back/terminal drag, narrow paging gesture to tab bar, the original recommended fallback, retaining structure.
- Future Changes/iPad multicolumn work extends this container, not new navigation levels.

### Original source references

`apps/mobile/src/components/workspace-detail.tsx:23`, `proto/coflux/v1/client.proto:136`, `apps/mobile/src/components/workspace-detail.tsx:188-194`.
