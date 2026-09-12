# Plan 048: Match iOS content icons to Web Lucide icons

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier. Stop on any STOP condition. When complete, update
> this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5f84f3b..HEAD -- apps/ios/Coflux/`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none (prerequisite 047 is DONE)
- Category: feature
- Execution: self
- Planned at: `5f84f3b`, 2026-07-26

## Requirement

Both clients represent one product, but iOS SF Symbols and Web Lucide differ for branch/folder/terminal content icons, especially arrow.branch versus GitBranch. Replace those three with matching Lucide graphics. Keep SF Symbols for system chrome and state prompts, including toolbar ellipsis/avatar and banner wifi/eye/hourglass.

Use SVG template assets with no third-party dependency. Replacing all icons loses native dynamic weight/accessibility and glass-toolbar consistency; an unofficial Swift Lucide package adds uncontrolled maintenance.

## Decisions & tradeoffs

- **Content only**: arrow.branch→git-branch for workspace rows, folder→folder for project headers, square.terminal→square-terminal for empty/missing tasks. Keep ellipsis/person.fill/tray and banner/login symbols. These three deliver most visual benefit while system toolbar symbols remain native.
- **SVG assets, zero dependencies**: extract paths from installed lucide-react@1.24.0 at apps/web/node_modules/lucide-react/dist/esm/icons/{git-branch,folder,square-terminal}.mjs. Create three imagesets in Assets.xcassets with preserves-vector-representation and template-rendering-intent:template; color with foregroundStyle. Reject a community package for three icons and handwritten SwiftUI Paths prone to SVG arc mistakes. Source is 24×24, stroke 2, round caps/joins.
- **No pbxproj changes**: PBXFileSystemSynchronizedRootGroup at project.pbxproj:31 automatically includes Coflux/Assets.xcassets. Preserve existing uncommitted user signing changes, as in 047.
- **Explicit sizing**, decided while planning: asset images do not scale with font. Use resizable/scaledToFit/frame to match ~18–20pt symbols, preserving 24pt row alignment. Replace ContentUnavailableView's systemImage form with Label(_:image:).

## Direction

Reconstruct SVG from mjs path data using stroke=black, stroke-width=2, round linecap/linejoin, fill=none, viewBox="0 0 24 24". Template rendering uses alpha, so source color is irrelevant.

### Milestone 1: Replace three content icons

Add template imagesets; use them in WorkspaceListView rows/headers, TaskListView empty state, and TaskDetailView missing-task state. SF Symbols remain for chrome/state.
Validation: build succeeds; residual grep below has no matches.

## Landmines

- Do not commit or restore project.pbxproj/Coflux.xcscheme user signing edits. Asset additions need no project edits; STOP if they do.
- Preserve workspace branch foregroundStyle, including orange main-branch coloring, when replacing assets.

## Scope

In scope: apps/ios/Coflux/Assets.xcassets/** and Views/{WorkspaceListView,TaskListView,TaskDetailView}.swift.

Out of scope: Xcode project/signing; LoginView and banner/toolbar symbols; all Web files, except read-only node_modules path reference.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Residual check | `grep -rn 'arrow.branch\|systemName: "folder"\|square.terminal' apps/ios/Coflux/Views/` | No output, exit 1 |
| Visual acceptance | User runs device ⌘R and compares branch/folder/terminal against Web sidebar | User confirmation |

## Done criteria

- [ ] Build and residual-reference checks pass.
- [ ] All three content icons use Lucide geometry tinted through foregroundStyle, preserving orange for the main branch.
- [ ] Chrome and status icons remain SF Symbols.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed; in particular, pbxproj/xcscheme retain their existing uncommitted state.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, especially synchronized groups requiring pbxproj edits.
- Out-of-scope changes required or validation fails twice after one reasonable fix.

## Maintenance notes

- Match Web lucide-react, currently 1.24.0. Manually update SVG when upstream graphics change; three icons do not justify automation.
- Future content icons use template SVG imagesets; chrome retains SF Symbols.

### Original source references

`apps/ios/Coflux.xcodeproj/project.pbxproj:31`.
