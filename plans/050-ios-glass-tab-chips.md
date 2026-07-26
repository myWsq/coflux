# Plan 050: 任务台 tab 条液态玻璃化（玻璃药丸 + 切换形变动画）

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
- Depends on: none（前置 049 已 DONE）
- Category: feature
- Execution: self
- Planned at: `5575823`, 2026-07-26

## Requirement

用户看到系统 tab 组件的液态玻璃质感与切换动画，问为什么任务台 tab 条是自绘
的。探索结论（已与用户对齐）：系统底部 tab bar 语义/能力不匹配（不滚动、
无加号/状态点、无滑动手势），但玻璃质感与切换动画应该补上——iOS 26 的
`glassEffect` API 族正是给自定义视图上系统级液态玻璃的正门。

完成后：任务台 tab 条的激活指示是一颗**液态玻璃药丸**，切换 tab 时药丸以
玻璃形变动画流到新 chip（`GlassEffectContainer` + `glassEffectID` 的 morph
语义）；新建终端钮为玻璃圆钮（interactive）。横向滚动、加号、状态点、点按
/滑动联动全部保留。

## Decisions & tradeoffs

- **质感实现 = glassEffect API 族，不换系统 tab bar**: 自绘结构保留，激活
  背景用 `GlassEffectContainer` 内带 `glassEffectID` 的玻璃胶囊——同 ID 的
  玻璃形状在插入/移除间自动形变，这正是"药丸流动"动画的官方路径。
  Rejected: 硬套系统底部 TabView —— 丢滑动切换/状态点/加号，终端多了摆不下
  （探索时已与用户过完，用户选玻璃 chip 条）。
- **玻璃只给激活药丸与加号钮**: 非激活 chip 保持纯文本+状态点。Rejected:
  全部 chips 上玻璃 —— Liquid Glass 设计指引要求克制，满排玻璃互相抢焦点，
  且药丸形变动画会失去"唯一焦点"的叙事。
- **切换动画由 withAnimation 驱动**: 点 chip 与 paged 滑动两条路都改
  activeTaskID，动画统一挂在该状态变化上。
  Based on: `WorkspaceDetailView.swift` tabChip/onChange 现有联动结构。

## Direction

### Milestone 1: 玻璃药丸 tab 条

激活 chip 背景 = 玻璃胶囊（GlassEffectContainer + glassEffectID + Namespace），
切换时形变流动；加号钮 = 玻璃圆钮（.interactive()）；chip 前景色/状态点/
滚动跟随逻辑不变。Validation:
`xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO`
→ BUILD SUCCEEDED。

## Landmines

- `project.pbxproj`/`Coflux.xcscheme` 用户签名改动仍在工作区，不得 commit、
  不得还原（同 047-049）。
- tab 条底是纯色 `systemBackground` 而非滚动内容，玻璃的折射感会偏含蓄——
  这是预期效果，不要为了"更玻璃"把 tab 条改成悬浮 overlay 盖住终端（终端
  首行会被遮）。

## Scope

In scope:
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`

Out of scope:
- 其余一切文件；导航 chrome（047 已定）；终端区

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 真机验收 (acceptance) | 真机 ⌘R：点 chip/滑动切换看玻璃药丸流动动画；加号钮玻璃质感与按压反馈 | 用户人工确认 |

## Done criteria

- [ ] 构建通过。
- [ ] 激活指示为玻璃药丸，点按/滑动切换时有形变流动动画；加号为玻璃圆钮。
- [ ] tab 条既有能力（滚动/加号/状态点/联动）无回退。
- [ ] No out-of-scope files changed。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- glassEffect API 族在当前 SDK 不可用或行为与预期严重不符（构建两次失败）。
- The outcome requires out-of-scope files.

## Maintenance notes

- 玻璃药丸是任务台唯一的自定义玻璃元素；后续加玻璃请先想 047 的教训——
  系统 chrome 优先，自定义玻璃保持克制。
