# Plan 057: iOS 新建终端入口迁至右下浮键列

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
- Depends on: none（在 056 浮键列之上）
- Category: feature
- Execution: self
- Planned at: `18e9bd1`, 2026-07-28

## Requirement

用户反馈（2026-07-28）：新建终端的 + 键在顶部 tab 条里不好按。迁到 plan 056
的右下浮键列，tab 条里的 + 整个移除。

完成后为真：右下浮键列三键，自上而下 = 新建终端（常驻）→ 滚到底（离底才
浮现）→ 键盘/收起（常驻）；tab 条只剩任务 chips；空状态页原「新建终端」
大按钮保留（无任务时浮键列本就不显示，二者互补不重叠）。

## Decisions & tradeoffs

- **排序 = 频率倒挂**：新建（低频）最上，键盘/收起（高频）守最下拇指位，
  滚到底浮现于中间。Rejected: 新建放列尾——挤占高频拇指位，且滚到底键
  浮现/消失会顶着它跳动。
- **同规格玻璃圆键**：52pt、`glassEffect(.regular.interactive(), in: .circle)`，
  与现有两键一致；图标 `plus`。Rejected: 小一号区分层级——三键列本就短，
  混规格破坏节奏。Based on:
  `apps/ios/Coflux/Views/WorkspaceDetailView.swift`（056 后浮键列 VStack，
  现有两键均 52pt 玻璃圆）。
- **tab 条 + 键整个删除**：不留双入口。Rejected: 两处都放——重复入口增加
  视觉噪音，与迁移动机（顶部不好按）矛盾。Based on: tab 条内 createTerminal
  按钮（`WorkspaceDetailView.swift` tabBar 的 `plus` 玻璃小键）。
- **空状态大按钮不动**：浮键列 `!members.isEmpty` 才渲染，空状态自带入口。
  Based on: `WorkspaceDetailView.swift` emptyState 的「新建终端」按钮与浮键
  列渲染条件。

## Direction

### Milestone 1: 浮键列三键

新建键入列顶部、tab 条 + 键删除；新建行为沿用 `createTerminal()`（差集识别
自建并激活的语义不变）。
Validation: 构建 exit 0；tab 条区域 grep 无 `plus` 图标按钮（浮键列内合法）。

## Scope

In scope:
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`

Out of scope:
- `TerminalInputArea.swift` / `TerminalHostView.swift` — 本 plan 不动
- 空状态页 — 行为不变

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 真机验收 (acceptance) | 浮键列顶部 + 键新建并自动激活；tab 条无 + 键；空状态大按钮仍可新建；三键排布观感 | 用户人工确认 |

## Done criteria

- [ ] 构建通过。
- [ ] 浮键列自上而下：新建 → 滚到底（条件浮现）→ 键盘/收起；tab 条无 + 键。
- [ ] 新建后自动激活语义不变。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 浮键列若继续加键（>3）应先收敛：低频操作考虑并入顶部 toolbar 菜单，
  不要无限堆圆键。
