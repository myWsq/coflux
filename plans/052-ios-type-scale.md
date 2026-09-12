# Plan 052: iOS typography—semantic roles anchored to Dynamic Type

> This plan is an outcome contract, not a step-by-step script. Stop on any
> STOP condition. When complete, update `plans/README.md`.
>
> Drift check: `git diff --stat ce1e2cd..HEAD -- apps/ios/Coflux/Views/`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none (prerequisite 051 is DONE)
- Category: refactor
- Execution: self
- Planned at: `ce1e2cd`, 2026-07-26

## Requirement

Current fonts use 13 Apple text styles plus two hardcoded sizes. Row titles use system(size:19), inherited from PR #24, outside the scale and without Dynamic Type. Calls use raw styles rather than explicit roles; explanatory footnotes are only convention.

Add Theme semantic roles brand/rowTitle/sectionLabel/control/label/meta/subtitle. Except brand wordmark, anchor every role to Apple text styles and Dynamic Type. Views reference only role tokens; replace 19pt with title3.

## Decisions & tradeoffs

- **Apple text styles, not Web pixel sizes**. Web's 13px desktop IDE density harms phone readability/accessibility. As in 047/048, match colors/graphics for brand and size/interaction to platform. User confirmed.
- **Semantic role names**, not text-sm/text-lg. Keep weight/monospaced emphasis at call sites: role defines purpose, modifier defines emphasis, as with Web's independent weight and scale.
- **Only fixed-size exception**: login brand wordmark, 40pt bold monospaced, treated as graphic rather than body text.
- **system(size:19)→title3, 20pt**, nearest system level, one-point increase with Dynamic Type. Source: WorkspaceListView.swift:107.

## Direction

### Milestone 1: Theme fonts and all call sites

Add documented roles/exemption to Theme.swift and redirect every Views .font call. Build succeeds and residual font grep below is empty.

## Landmines

- Preserve uncommitted project.pbxproj/Coflux.xcscheme user signing edits, as in 047–051.

## Scope

In scope: apps/ios/Coflux/Views/**.

Out of scope: terminal SF Mono 12, fixed by 051 terminal semantics; system navigation-title fonts.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Role adoption | `grep -rn '\.font(' apps/ios/Coflux/Views/ \| grep -v 'Theme.Fonts' \| grep -v Theme.swift` | No output |
| Device acceptance | Increase system font size: list/banner/login scale; row titles fit the scale | User confirmation |

## Done criteria

- [ ] Build and type-scale adoption checks pass.
- [ ] Hardcoded 19pt is gone; the brand wordmark is the only fixed-size text.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Excluded changes required or validation fails twice after one reasonable fix.

## Maintenance notes

- Choose a semantic role before adding text. Add a missing role rather than a raw font call.
