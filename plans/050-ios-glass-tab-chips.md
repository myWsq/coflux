# Plan 050: Liquid Glass tab chips—glass pill and morphing selection

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5575823..HEAD -- apps/ios/Coflux/Views/WorkspaceDetailView.swift`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none (prerequisite 049 is DONE)
- Category: feature
- Execution: self
- Planned at: `5575823`, 2026-07-26

## Requirement

The user saw native tab glass/selection animation and questioned custom workbench tabs. Exploration agreed that system bottom tabs lack required scrolling, plus/status indicators, and swipe behavior. Keep custom capabilities while using iOS 26 glassEffect APIs for system-quality material/animation.

Selected tab becomes a **glass capsule** morphing between chips through GlassEffectContainer/glassEffectID. New terminal becomes an interactive glass circle. Preserve horizontal scrolling, plus, state dots, and tap/page-swipe synchronization.

## Decisions & tradeoffs

- **Keep custom structure; use glassEffect family**, with selected capsule inside GlassEffectContainer and shared identity morphing on insertion/removal. Native bottom TabView would lose capabilities and overflow many terminals; user chose glass chips.
- **Glass only on selected pill and plus**. Others remain text/state dots. Glass on every chip competes for focus and loses one moving selection indicator; use restraint.
- **Drive animation through withAnimation** on activeTaskID changes from both taps and paging, following existing tabChip/onChange linkage.

## Direction

### Milestone 1: Glass tabs

Selected background uses GlassEffectContainer/glassEffectID/Namespace capsule; plus uses interactive glass circle. Preserve foreground colors, dots, and scroll-follow behavior. Build below must succeed.

## Landmines

- Existing user signing edits in project.pbxproj/Coflux.xcscheme must neither be committed nor restored, as in 047–049.
- Opaque systemBackground beneath tabs makes refraction subtle by design. Do not float tabs over terminal, obscuring its first line.

## Scope

In scope: apps/ios/Coflux/Views/WorkspaceDetailView.swift only.

Out of scope: all other files, fixed 047 navigation chrome, terminal area.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| Device acceptance | ⌘R: tap/swipe shows morphing pill; plus has glass and press feedback | User confirmation |

## Done criteria

- [ ] The build passes.
- [ ] The active indicator is a glass capsule with morphing motion on tap/swipe; the plus control is a glass circle.
- [ ] Existing tab scrolling, plus action, status dots, and selection linkage do not regress.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- glassEffect unavailable or behaves unexpectedly with two failed builds.
- Out-of-scope changes required.

## Maintenance notes

- This pill is the workbench's only custom glass element. Remember 047: system chrome first, custom glass sparingly.
