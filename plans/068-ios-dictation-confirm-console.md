# Plan 068: 对讲操作台复议——松手进确认态、弧形带按钮、滑入直执行

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 59377fc..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none（复议 plan 067 交付面）
- Category: feature
- Execution: subagent opus
- Planned at: `59377fc`, 2026-08-01

## Requirement

plan 067 把微信语音输入的"松手即发"整套照搬过来，前提错了：**微信发的是
语音消息本身，转文字只是附属**，识别错误无非是附属文本不准；coflux 是
**纯转文字**，松手直落终端等于把识别错误直接推给 agent。用户
2026-08-01 复议，改回带确认关卡的形态，但保留微信的滑入快路径：

- **原地松手 → 确认态**：草稿定格居中，左下「取消」右下「发送」变成实体
  按钮可点；点草稿文字 → 落 `draft` 开成文层编辑。
- **按住期间滑入左/右按钮再松手 → 直接执行**该操作（左=取消，右=发送），
  不进确认态。快慢两档共存：确信就一气呵成，想看一眼就原地松手。
- **几何重做**：067 的"圆心钉屏幕底角、半径 130pt 巨圆"既不像微信也易
  误判。改成微信那样——底部一条弧形带上排开的胶囊按钮，手指从底部中央
  的占位条出发往左上 / 右上滑去命中；命中区 = 按钮自身几何（可加容差），
  不是覆盖小半个屏幕的巨圆。
- **两种视觉态**：按住期间是轻量角标/提示样式（手指还在屏上，不是可点
  控件）；松手进确认态后变实体按钮样式（可点）。

正确/错误分界：原地松手后草稿留驻等你点发送 = 对；原地松手直接落终端
= 错（067 的行为，本 plan 就是要推翻它）。滑入右下松手直接发送 = 对。

## Decisions & tradeoffs

- **原地松手不再直发（用户复议 2026-08-01，推翻 067 "松手即上屏"）**：
  原地松手进确认态，文字落终端必须经用户显式点「发送」或滑入右下按钮。
  理由：coflux 转写文字即最终产物（微信不是），识别错误无兜底。
  Rejected: 保持 067 松手直发 — 前提（"确认关卡下移到终端回车层"）被
  用户否掉：回车层兜不住错字，用户要在落终端前就看见。
  Based on: `WorkspaceDetailView.swift:449-518` 现行 endDictation 分发。
- **滑入即执行（用户定案 2026-08-01）**：按住期间滑到左下松手 = 直接
  取消；滑到右下松手 = 直接发送（等终稿落定后落终端，不进确认态）。
  手指移过去这个动作本身就是明确意图，且滑动途中草稿可见。
  Rejected: 松手一律进确认态 — 取消也要两步，快路径全丢；
  Rejected: 只有取消可滑入直执行 — 用户已选两侧对称。
- **确认态两个按钮：左下「取消」右下「发送」**。中间不放第三个按钮。
  Rejected: 底部排三个（取消/编辑/发送）— 用户选了点草稿进编辑，底部
  留两个不拥挤。
- **编辑入口 = 点草稿文字（用户定案 2026-08-01）**：确认态下点中间草稿
  气泡 → 文字落 `draft` 并打开成文层（066 已有通道，067 删掉了，本
  plan 恢复）。按住期间草稿不可点（手指在占位条上）。
- **发送语义不变**：落终端 = 经 `sendText` 单行拍平、不回车
  （054/055 定案，067 未动）。Rejected: 发送即回车执行 — 从未被批准。
  Based on: `WorkspaceDetailView.swift:429-437`。
- **几何：底部弧形带胶囊按钮（用户定案 2026-08-01）**：两颗按钮分居底部
  左右，沿一条向上凸的弧线排布（微信参考图），命中判定基于按钮自身几何
  加适度容差。`DictationZone.radius = 130` 的巨圆判定删除。具体弧度、
  按钮尺寸、容差大小 executor 定，但必须满足：手指静止按在占位条上
  （含最左/最右边缘）时命中区为 none。
  Based on: `DictationOverlay.swift` 中 `DictationZone.hit` 与
  `sector(_:icon:label:tint:)` 的现行实现。
- **两态视觉**：按住期间 = 轻量角标样式（低对比、无实体按钮感，
  `allowsHitTesting(false)`，命中时高亮）；松手确认态 = 实体按钮样式
  （可点，命中高亮语义消失）。用现有玻璃语汇，不照抄微信深色实底。
- **终稿等待**：滑入发送与原地松手都要等 `session.finish()` 落定拿终稿
  （不得用 volatile 文本抢跑）；finalizing 期间确认态按钮不可误触
  （禁用或等落定后生效，executor 二选一）。滑入取消仍立即 `cancel()`
  拆层不等终稿。Based on: `WorkspaceDetailView.swift:466-518`。
- **空转写 / 失败 / 权限**：空转写（原地松手或滑入发送）→ 直接拆层，
  不进确认态；失败带字 → 进确认态并展示错误标注，文字仍可发送/编辑；
  失败无字、权限被拒 → 保留 064 的留驻示错/引导态，点任意处关闭。
  注：失败带字的处理回到 066 语义（067 改成的"照落文本 + 留 1.2s"随
  松手直发一起作废）。

## Direction

三个文件（与 067 同一批）：`DictationOverlay`（相位回到三个：进行中含
角标 / 确认态含实体按钮与可点草稿 / 错误留驻；几何换弧形带）、
`TerminalInputArea`（手势不动，仍外传全局坐标；`onDictateEnd` 需带上
松手瞬间的命中区或由宿主读状态，executor 定）、`WorkspaceDetailView`
（松手分发加确认态分支）。`DictationSession` 与 Speech providers 零改动。

### Milestone 1: 几何与两态视觉

弧形带胶囊按钮取代屏幕底角巨圆；按住态角标 + 命中高亮，命中区不再覆盖
占位条。Validation: `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 2: 确认态与滑入直执行

原地松手 → 确认态（草稿定格、按钮实体可点、点草稿进成文层）；滑入左/右
松手 → 直接取消/发送；空转写/失败/权限按 Decisions 收敛。
Validation: 同上 xcodebuild → exit 0。

## Landmines

- **hit-testing 两态切换（066 的老坑，067 删确认态后失效，现在回来）**：
  进行中态蒙层**不能拦截任何触摸**（手指按在占位条上，DragGesture 在
  TerminalInputArea 坐标系里持续跟踪）；确认态蒙层**必须**接收按钮点击
  与草稿点击。现行代码整个 sectors 是 `allowsHitTesting(false)`
  （`DictationOverlay.swift` sectors），确认态要打开。别搞反。
- **坐标系统一**：手势取 `.global`，蒙层框 `onGeometryChange` 也量
  `.global`（`WorkspaceDetailView.swift:236-241`）。换几何后按钮位置与
  命中判定仍须同源——绘制在哪判定就在哪，别一边 local 一边 global。
- **`sendText` 静默前置条件**：任务非 running / 无 sessionID 时静默
  no-op，现行代码提了 `terminalReady` 并在落不下去时退到 `draft`
  （`WorkspaceDetailView.swift:423-428`）。确认态发送也要走这条兜底，
  不得让用户的话凭空消失。
- **`finish()` 时序**：落定前不得拆 session/蒙层（权限引导会闪没）；
  松手即 `finish()` 释放麦克风，确认态可能留驻任意久，不能等用户点
  发送才释放。Based on: `WorkspaceDetailView.swift:466-476` 注释。
- **短按消歧结构不可动**：`LongPressGesture().sequenced(before:
  DragGesture(minimumDistance: 0, coordinateSpace: .global))` 与
  `.onTapGesture` 的分工是 066 复议踩坑结论（`TerminalInputArea.swift:74-107`），
  本 plan 不得回到自造计时/自定义阈值。
- **`dictateActive` 与占位条 mic 指示**：确认态期间手势已结束，占位条
  不应再显示对讲中（067 的行为保持）。

## Scope

In scope:

- `apps/ios/Coflux/Speech/DictationOverlay.swift`
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `plans/README.md`

Out of scope:

- `apps/ios/Coflux/Speech/` 其余文件（DictationSession、豆包/Apple
  provider、采音、协议）— 转写链路零改动
- 成文层/控制板既有交互 — 编辑只是复用既有通道，成文层内部零变更
- `apps/web`、`apps/mobile`、server/daemon — 纯 iOS 客户端交互

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 真机验收 (acceptance) | 用户真机：长按对讲→原地松手进确认态（草稿定格、左取消右发送可点、点草稿进成文层）→点发送文字落输入行不回车；滑入左下松手直接取消；滑入右下松手直接发送；手指静止在占位条边缘不误判命中 | 用户确认 |

## Done criteria

- [ ] xcodebuild 构建通过。
- [ ] 原地松手进确认态：草稿定格、左下取消/右下发送为实体可点按钮、
      点草稿进成文层编辑；不再直接落终端。
- [ ] 滑入左下松手直接取消；滑入右下松手等终稿落定后直接落终端输入行
      （不回车）。
- [ ] 命中几何换成底部弧形带按钮；手指静止在占位条（含左右边缘）时
      命中区为 none；`DictationZone.radius` 巨圆判定删除。
- [ ] 按住态为角标样式且不拦截触摸，确认态为按钮样式且接收点击。
- [ ] 空转写直接拆层；失败带字进确认态并示错；失败无字/权限被拒留驻
      示错不变。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- xcodebuild 同一错误修复一次后仍失败。
- 确认态 hit-testing 与进行中态不拦截触摸这两个要求在实现层面无法两全
  ——停下报告，不得靠"确认态也不接收点击"绕过。

## Maintenance notes

- 确认关卡的位置是这条产品线反复摇摆的点：064/066 在蒙层内确认 → 067
  下移到终端回车层 → 068 移回蒙层内。再改前先读这三条演化，别当新问题。
- 按钮几何/容差是跟手性调参点，绘制与命中判定必须保持同源（一处改，
  两边跟着变）。
- 对讲 UI 相位重回三个（进行中 / 确认 / 错误留驻）。
