# Plan 067: 对讲蒙层微信式操作台——松手即上屏、扇区滑入取消/编辑

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat e23e440..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none（迭代 plan 066 交付面）
- Category: feature
- Execution: subagent opus
- Planned at: `e23e440`, 2026-08-01

## Requirement

plan 066 的松手成稿确认态（蒙层留驻、点「发送」二次确认）用户实测后复议：
参考微信语音输入操作台，改为**一次手势完成**——

- 长按对讲进行中，蒙层底部常驻两个滑入扇区：左「取消」、右「编辑」；
- 手指滑入扇区内松手 = 执行该扇区操作；扇区外任意位置松手 = 把转写文字
  落终端输入行（不回车）并拆蒙层；
- 成稿确认态整个移除：松手后不再留驻等待用户点按钮。

正确/错误分界：扇区外松手 → 文字直落输入行、蒙层自动拆除、全程无第二次
点击 = 对；松手后蒙层留驻等确认、或落文本附带回车执行 = 错。

推翻的旧定案要留痕：064/066 的"发送必须人工确认"被本次用户定案
（2026-08-01）显式推翻——落地语义改为仅落输入行不回车后，误听误发的
最终执行仍卡在用户按终端回车这一层，确认关卡由蒙层内下移到终端回车。

## Decisions & tradeoffs

- **松手即上屏（用户定案 2026-08-01，推翻 064/066"发送必须人工确认"）**：
  扇区外松手 → 转写文字经 `sendText` 等价路径落终端输入行，蒙层自动拆除。
  Rejected: 保留成稿确认态（066 现状）— 用户要一次手势完成；
  Rejected: 落文本+回车直接执行 — 误听一个词就直接跑进 agent 会话，且
  推翻 054/055 单行不回车定案；用户已显式选"仅落文本"。
  Based on: `WorkspaceDetailView.swift:431-435` sendText 单行拍平语义。
- **两扇区：左「取消」右「编辑」（用户定案 2026-08-01）**：滑入松手即
  执行。编辑 = 文字落 `draft` 并打开成文层（复用 066 已有 onEdit 通道，
  `WorkspaceDetailView.swift:233-238`）。中间不设第三扇区——微信的
  「指令」在 coflux 无对应物，用户已排除"+回车执行"档。
  Rejected: 照搬微信三扇区 — 中间无行为可放，硬凑降低两侧命中面积。
- **上滑取消移除**：取消唯一入口 = 左下扇区。`dictateCancelThreshold`
  上滑判定（`TerminalInputArea.swift:95,102,108`）随之删除，
  `onDictateMove/onDictateEnd` 的 Bool 语义改为位置/命中区语义（签名
  executor 定）。Rejected: 上滑取消与扇区并存 — 两套取消手势语义打架，
  上滑轨迹还会穿过屏幕中部草稿区。
- **长按判定结构不可动（066 复议踩坑结论）**：`LongPressGesture()`
  系统默认参数 `.sequenced(before: DragGesture(minimumDistance: 0))`
  保持原样，不得回到自造计时/自定义阈值。本 plan 只动 drag 阶段的
  位置消费方式。Based on: `TerminalInputArea.swift:74-106` 注释。
- **松手终稿未落定**：蒙层短暂留驻（沿用 finalizing 语义），
  `session.finish()` 落定后自动落文本并拆层，期间不接收任何交互。
  finish() 落定前不得拆 session/蒙层（066 landmine 继续成立：权限
  引导会闪没）。Based on: `WorkspaceDetailView.swift:462-497`。
- **空转写松手（含滑入编辑区松手时无字）**：直接拆层，什么都不落。
  Based on: 066 已定"无稿可确认"，`WorkspaceDetailView.swift:491-494`。
- **失败/权限态收敛**：失败且已有转写文字（豆包中途断连）→ 照常把文字
  落输入行并给出简短错误提示（形式 executor 定，如短暂 toast/标注后
  自动拆层）；失败无字、权限被拒 → 保留 064 的留驻示错/引导态，点
  任意处关闭。Rejected: 失败带字也留驻等确认 — 成稿确认态已整体移除，
  不为失败路径单独保留一个。
- **进行中态蒙层仍不拦截触摸**：手指全程按在占位条上，DragGesture 在
  TerminalInputArea 的手势里跟踪；扇区只是视觉目标 + 命中判定输入，
  不是可点击控件。仅失败/权限留驻态蒙层接收点击（064 语义）。
  Based on: `DictationOverlay.swift:39-47`、plan 066 landmine。
- **视觉（executor 定细节）**：草稿气泡居中定格 + 底部左右扇形操作区，
  滑入扇区有高亮/提示反馈（微信参考：扇区隆起、提示文字随命中区切换，
  如"松手发送"/"松手取消"/"松手编辑"），用现有玻璃语汇
  （`glassEffect`/`VariableBlurView`），不照抄微信深色实底与绿气泡。

## Direction

改动集中三个文件：`TerminalInputArea`（drag 位置外传，删上滑取消）、
`DictationOverlay`（删成稿态相位，加扇区 UI 与命中反馈）、
`WorkspaceDetailView`（松手收尾从"留驻成稿"改为"按命中区分发：
取消/编辑/落文本拆层"）。`DictationSession` 与 Speech providers 零改动。

UI 相位从三个收敛回两个：进行中（含扇区）、错误/权限留驻。
`released` 成稿态语义消失；`finalizing` 保留为松手后的短暂等待窗口。

### Milestone 1: 手势与扇区命中链路

drag 位置从 TerminalInputArea 传出，扇区命中判定成立（命中区状态可驱动
UI 高亮），上滑取消删除。
Validation: `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 2: 松手分发与相位收敛

扇区外松手 → finalizing 短暂留驻 → 自动落文本拆层；取消区松手 → 拆层
弃稿；编辑区松手 → 文字落 draft 开成文层；空转写/失败/权限路径按
Decisions 收敛；成稿态 UI 与 `dictationReleased` 留驻语义删除。
Validation: 同上 xcodebuild → exit 0。

## Landmines

- **坐标系**：DragGesture 现在默认 `.local`（占位条坐标系，
  `TerminalInputArea.swift:84`），扇区在全屏蒙层底部——命中判定必须
  统一到全局坐标（如 `DragGesture(minimumDistance: 0, coordinateSpace: .global)`），
  扇区几何与手势位置要在同一坐标空间比对，别一边 local 一边 global。
- **落文本必须复用 `sendText` 路径**：换行拍平成空格、仅落文本不回车
  （`WorkspaceDetailView.swift:425-435` 注释即 054/055 定案）。绕过它
  自行写终端 = 破坏单行语义。
- **`endDictation` 异步收尾时序**：finish() 返回前不能拆 session/蒙层
  （`WorkspaceDetailView.swift:462-467` 注释）；松手自动落文本也必须等
  finish() 落定拿终稿，不得用松手瞬间的 volatile 文本抢跑。
- **麦克风释放**：松手即走 finish() 关闭 capture/engine/WS（现有行为），
  finalizing 等待窗口不得延后释放——挂橙点。
- **`sendText` 的静默前置条件**：task 非 running / 无 sessionID 时
  sendText 静默 no-op（`WorkspaceDetailView.swift:432`）。松手自动落
  文本若命中该分支，文字会无声丢失——转写非空而落不了时须有兜底
  （如落 draft），不得让用户的话凭空消失。
- **短按消歧**：`.onTapGesture`（`TerminalInputArea.swift:70`）与长按
  sequenced 手势的系统消歧是 066 复议结果，改 drag 回调时别动这层结构。

## Scope

In scope:

- `apps/ios/Coflux/Speech/DictationOverlay.swift`
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `plans/README.md`

Out of scope:

- `apps/ios/Coflux/Speech/` 其余文件（DictationSession、豆包/Apple
  provider、采音、协议）— 转写链路零改动
- 成文层/控制板既有交互 — 编辑入口只是复用既有通道，成文层内部零变更
- `apps/web`、`apps/mobile`、server/daemon — 纯 iOS 客户端交互

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 真机验收 (acceptance) | 用户真机：长按对讲→扇区外松手文字直落输入行不回车→滑入左扇区松手取消→滑入右扇区松手进成文层编辑→空转写松手静默拆层；短按打开成文层不回退 | 用户确认 |

## Done criteria

- [ ] xcodebuild 构建通过。
- [ ] 扇区外松手：等终稿落定后文字经 sendText 语义落输入行（不回车），
      蒙层自动拆除，全程无第二次点击。
- [ ] 左扇区松手取消弃稿；右扇区松手文字落 draft 开成文层。
- [ ] 上滑取消与成稿确认态（含「发送」「弃掉」按钮、点文字编辑）全部移除。
- [ ] 空转写松手直接拆层；失败带字落文本+示错；失败无字/权限被拒留驻
      示错不变。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- xcodebuild 同一错误修复一次后仍失败。
- 扇区命中判定与 LongPressGesture sequenced 结构冲突、无法在不改判定
  结构的前提下拿到 drag 全局位置——停下报告，不得回退到自造计时方案。

## Maintenance notes

- 确认关卡自 067 起下移到终端回车层：若未来发送语义改为可直接回车执行，
  必须先恢复某种蒙层内确认，两者不可同时缺席。
- 扇区几何（位置/大小/命中容差）是跟手性调参点，改动只应落在
  DictationOverlay 的扇区布局与命中判定一处。
- 对讲 UI 相位缩回两个（进行中/错误留驻）；再加相位（如成稿追加语音）
  前先回看 066→067 的相位演化史。
