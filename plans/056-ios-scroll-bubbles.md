# Plan 056: iOS 终端滚动治理——禁状态栏回顶 + 滚到底浮键 + 气泡常驻两态

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

真机反馈（2026-07-28）三件事，同一块交互面：

1. 点屏幕顶部（状态栏）终端会滚回最顶——iOS 给 UIScrollView 的系统便捷
   行为，在终端场景纯属误触源，要关掉。
2. 反方向的「一键滚到底」才是真需求：终端不在底部时，右下角键盘悬浮气泡
   旁边出现一个直达底部的浮键；在底部时不出现。
3. 悬浮气泡改为**常驻两态**：控制板展开时气泡不再消失，键盘气泡变为
   「收起」键（点按收起控制板）；输入区里现有的收起按钮删除——收起入口
   只此一处。

完成后为真：点状态栏无任何滚动效果；激活终端离底时右下气泡列多出一个
滚到底键，点按直达底部并随即消失；键盘气泡两态常驻（折叠=展开输入区、
展开=收起输入区），输入区内无收起按钮。

## Decisions & tradeoffs

- **禁回顶**：`scrollsToTop = false`，在 TerminalView 创建处设置。Rejected:
  条件性保留（如折叠态才禁）——终端场景任何回顶都是误触。Based on:
  SwiftTerm iOS `TerminalView: UIScrollView`（checkout
  `Sources/SwiftTerm/iOS/iOSTerminalView.swift:54`），宿主创建点
  `apps/ios/Coflux/Views/TerminalHostView.swift:47-66`。
- **滚到底 = SwiftTerm 现成 API**：显示条件 = 激活任务终端 `canScroll` 且
  `scrollPosition < 1`；点按 `scroll(toPosition: 1)`。Rejected: 自己操
  contentOffset——SwiftTerm 内部维护 yDisp/userScrolling 状态，绕过 API 会
  失同步。Based on: checkout `Apple/AppleTerminalView.swift:2009-2056`
  （scrollPosition 0-1、canScroll 排除 alternate buffer、scroll(toPosition:)）。
- **离底信号上报路径**：`scrolled` delegate（现空实现，
  `TerminalHostView.swift:150`）按 taskID 上报给 WorkspaceDetailView，具体
  用回调（仿 `onSizeChanged`）还是注册表（仿 `TerminalModeRegistry`，
  `TerminalHostView.swift:7-22`）由执行者按代码现状定。浮键只看**激活任务**
  的信号（paged deck 多任务各有终端）。
- **气泡列结构**：bottomTrailing 垂直堆叠——滚到底键在上、键盘/收起键在下；
  键盘气泡两态常驻，图标随态切换（展开输入区 vs 收起输入区语义）。控制板
  展开时气泡列整体抬到控制板上方（`panelHeight` 已有）。Rejected: 展开态
  藏气泡（现状）——用户定案要常驻。Based on:
  `apps/ios/Coflux/Views/WorkspaceDetailView.swift:128-152`（现气泡仅
  `inputCollapsed` 渲染）。
- **输入区收起按钮删除**：`TerminalInputArea` 的 `collapsed` Binding 若因此
  无消费者则一并移除，不留死参。Based on:
  `apps/ios/Coflux/Views/TerminalInputArea.swift:58-66`（composerRow 收起
  按钮）。
- **布局不动画约束沿用**：气泡态切换与控制板展开/收起沿用现有「布局一步
  到位、动画只给气泡自身 transition」的机制——布局动画会引发逐帧 resize
  让远端 TUI 闪动（plan 053 踩过）。Based on:
  `WorkspaceDetailView.swift:129-131,147-149` 注释。

## Direction

### Milestone 1: 禁回顶 + 滚到底浮键 + 气泡常驻

三件事一个 diff：makeUIView 关 scrollsToTop；scrolled delegate 上报离底态；
WorkspaceDetailView 气泡列重构（常驻两态 + 条件滚到底键）；TerminalInputArea
删收起按钮。
Validation: 构建 exit 0；
`grep -n 'keyboard.chevron.compact.down' apps/ios/Coflux/Views/TerminalInputArea.swift`
无输出。

## Landmines

- `scrolled` delegate 的触发时机需实测：用户拖动时触发有保证，但**新输出
  导致 maxScrollback 变化时未必回调**——若实测发现离底态不新鲜，可结合
  `rangeChanged`（`TerminalHostView.swift:166`，现空实现）或输出 feed 路径
  兜底刷新。信号不新鲜的表现：浮键该出现时不出现/该消失时残留。
- alternate buffer（全屏 TUI 如 vim/htop）下 `canScroll == false`，浮键
  自然不显示——这是正确行为，不要为 TUI 场景另造滚动。
- 气泡列抬升高度依赖 `panelHeight`（onGeometryChange 上报，
  `WorkspaceDetailView.swift:107-111`），首帧可能为 0——注意展开瞬间浮键
  位置跳变。

## Scope

In scope:
- `apps/ios/Coflux/Views/TerminalHostView.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `apps/ios/Coflux/Views/TerminalInputArea.swift`

Out of scope:
- SwiftTerm 包内部 — 只用公开 API
- 成文层（TerminalComposeOverlay）— 本 plan 不动发送语义
- web/mobile 端 — 仅 iOS

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' build CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED |
| 收起按钮残留 | `grep -rn 'keyboard.chevron.compact.down' apps/ios/Coflux/Views/` | 无输出（exit 1） |
| 真机验收 (acceptance) | 点状态栏不回顶；上滑离底后浮键出现、点按直达底部并消失；控制板展开时气泡变收起键且常驻；输入区内无收起按钮；vim/htop 等全屏 TUI 下浮键不出现 | 用户人工确认 |

## Done criteria

- [ ] 构建与 grep 检查通过。
- [ ] 点状态栏无滚动效果。
- [ ] 离底浮现滚到底键、点按到底并消失；仅对激活任务生效。
- [ ] 键盘气泡两态常驻、图标/语义随态切换；输入区收起按钮及死参已删。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 离底信号若真机发现不新鲜（Landmines 第一条），优先在 feed 路径补刷新，
  不要改成定时轮询。
- SwiftTerm 升级时留意 scrollPosition/canScroll 语义是否变化。
