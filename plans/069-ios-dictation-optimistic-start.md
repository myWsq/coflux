# Plan 069: 对讲乐观启动——按下即采音、按下即视觉预兆

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 893f08d..HEAD -- apps/ios`

## Status

- Priority: P2
- Effort: S
- Risk: MED
- Depends on: none（迭代 plan 068 交付面）
- Category: feature
- Execution: subagent opus
- Planned at: `893f08d`, 2026-08-01

## Requirement

plan 068 把长按阈值从系统默认 0.5s 降到 0.28s 后，仍有两个残留延迟，
本 plan 分别消除：

1. **开口丢字**：麦克风在长按判定通过后才开（`beginDictation()` →
   `session.begin()`，`WorkspaceDetailView.swift:458-464`）。用户按下的
   同时开口，头 ~0.28s 的音频在采音开始前就没了。
2. **等待感**：0.28s 内除了 `scaleEffect(0.97)`
   （`TerminalInputArea.swift:70`）几乎没有反馈，主观上像"按了没反应"。

做完之后为真：按住占位条立刻能看出"正在进入对讲"（视觉预兆渐显），
且按下瞬间说的话不丢——蒙层弹出时草稿里已经有第一个词。

**明确不做的事**：蒙层出现时机不变，仍是长按判定通过的那一刻。提前显示
蒙层会让每次点击占位条都闪一次蒙层，破坏 066 定下的点击/长按系统消歧。

## Decisions & tradeoffs

- **乐观启动：touch down 起采音，长按判定通过才显示蒙层**。session 的
  生命周期与蒙层的可见性解耦——现行代码里 `if let dictationSession`
  （`WorkspaceDetailView.swift:226`）既是数据源又是可见性开关，两者必须
  拆开（拆法 executor 定：独立可见性状态、预热 session 单独存一个 state
  再移交、或给 `DictationStage` 加相位皆可）。
  Rejected: 提前显示蒙层 — 点击占位条打字也会闪蒙层，破坏消歧；
  Rejected: 只预连豆包 WS 不开麦克风 — 握手期已被 `pendingPCM` 覆盖
  （`DictationSession.swift:39-43`），丢字来源是麦克风没开，不是握手慢。
  Based on: `WorkspaceDetailView.swift:458-464`、`:226`。
- **预热音频靠既有 `pendingPCM` 接住，不新造缓冲**：准入期音频攒起来、
  provider 就绪后补喂的机制已经存在，上限 300KB ≈ 9.4s，预热
  (~0.16s) + 豆包准入 (2.5s) 远在其下。
  Based on: `DictationSession.swift:39-45`。
- **~120ms 预热去抖（decided while planning）**：touch down 后延迟约
  120ms 才真正起采音，其间松手则一个字节都不采。理由：`AudioCapture`
  用 `.record` category，激活即打断其他音频播放
  （`AudioCapture.swift:25-31` 的 landmine），无过滤的话每次点占位条
  打字都会打断用户正在听的东西 + 闪一次状态栏橙点。120ms 远短于长按
  阈值 0.28s，不影响"按下即说"。具体数值 executor 可微调，但必须
  显著小于 0.28s 且能滤掉正常点击。
  注意这**不是**066 禁止的自造计时：长按判定/消歧仍全归系统手势，这个
  定时器只决定预热何时开始，不参与任何手势判定。
  Rejected: 不去抖直接起采音 — 打断背景音频 + 橙点，代价大于收益；
  Rejected: 改 `.record` 为 `.playAndRecord + .mixWithOthers` 消除打断
  — 扬声器声音回灌进麦克风影响识别，且改的是全体对讲场景，超出范围。
- **未授权时不预热**：预热前同步查权限（`AVAudioApplication.shared
  .recordPermission == .granted && SFSpeechRecognizer.authorizationStatus()
  == .authorized`，即 066 权限快路径的同一判据），任一不满足就跳过预热，
  等长按判定通过后照常走完整 `start()`（含权限请求）。否则首次使用时
  点一下占位条就弹麦克风权限框——用户只想打字。
  Based on: `DictationSession.swift:54-88` 权限快路径与慢路径分支。
- **按下即视觉预兆（用户定案 2026-08-01）**：占位条在 touch down 瞬间
  开始渐显对讲预兆（形式 executor 定，如 mic 图标淡入 / 边框或底色向
  `Theme.primary` 过渡），让 0.28s 不是空白等待。必须用渐显动画而非
  瞬时切换：正常点击（~60-120ms 抬手）时预兆几乎不可见，按住不放才
  完全显现。现有 `scaleEffect(0.97)` 保留。
  Based on: `TerminalInputArea.swift:61-71` 的 `dictateActive` mic 指示
  与 `pressing` 按压回馈。
- **touch down 信号取 `@GestureState pressing`**：`.updating` 已挂在
  sequenced 手势上并驱动按压缩放（`TerminalInputArea.swift:28,94-96`），
  它变 true 就是当前能拿到的最早按下信号，复用它、不新引 UIKit 探针。
  若真机实测其时机仍明显滞后于手指落下，这是后续可选升级（
  `UIViewRepresentable` + `touchesBegan`），本 plan 不做。
  Rejected: 新加一条 `.simultaneousGesture(DragGesture(minimumDistance: 0))`
  取按下 — 与既有 sequenced 手势竞争消歧，风险高于收益。
- **预热态的错误/权限不提前示人**：预热期间蒙层不显示，`phase` 若已变
  `.failed` 则在蒙层显现后照常展示（错误不吞）；未达长按就松手时
  `cancel()` 静默拆除，不弹任何提示。
  Based on: `DictationSession.swift:34-37` `teardownRequested` 与
  `:154` `cancel()`——"快速按下-松开在准入判定跑完前就收尾"已被现有
  代码按真实场景处理，预热只是让这条路径变常见。

## Direction

三个文件：`TerminalInputArea`（按下信号外传 + 视觉预兆 + 去抖定时）、
`WorkspaceDetailView`（session 生命周期与蒙层可见性解耦，加预热/放弃
两个入口）、`DictationSession`（若需要，加一个"是否可预热"的权限判据
出口；转写链路本身零改动）。`AudioCapture`、providers、
`DictationOverlay` 不动。

### Milestone 1: 乐观启动

touch down → 去抖 → 起 session 采音（蒙层不显示）；长按判定通过 →
蒙层显现且草稿含预热期说的话；未达长按松手 → session 静默 cancel，
麦克风释放。
Validation: `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 2: 按下即视觉预兆

占位条按下瞬间起渐显对讲预兆，正常点击时几乎不可见。
Validation: 同上 xcodebuild → exit 0。

## Landmines

- **蒙层可见性 ≠ session 存在**：现行 `if let dictationSession`
  （`WorkspaceDetailView.swift:226`）把两者绑死，不拆开就会在预热瞬间
  弹蒙层——这正是本 plan 明令不做的事。
- **悬挂 tap / 音频会话泄漏**：`AudioCapture` 的 landmine
  （`AudioCapture.swift:25-26`）——结束/取消/出错每条路径都必须走
  `stop()`，否则下次长按静音或崩溃。预热新增了"起了又立刻弃"这条路径，
  它也必须收敛到 `cancel()`。
- **预热 session 与正式 session 必须是同一个**：长按判定通过时不得丢弃
  预热 session 重建一个（那样预热采的音全废，等于没做）。
- **`beginDictation()` 的重入**：`onDictateBegin` 在 drag 的每次
  `onChanged` 里靠 `dictateActive` 去重（`TerminalInputArea.swift:99-103`），
  预热入口同样需要幂等——按下抖动不得起两个 session。
- **麦克风橙点的用户感知**：预热成功但未达长按（按住 0.2s 松手）时橙点
  会闪一下，这是知情取舍；但正常点击（<120ms）必须完全不触发。
- **真机崩溃时序（064/066 血债）**：权限框刚收起时起 AURemoteIO 会被
  AudioToolbox abort（`DictationSession.swift:73-86` 注释）。本 plan 的
  "未授权不预热"决策同时也隔离了这条路径——预热只在已授权时发生，
  不会撞上权限框收起的瞬态。别为了"预热也支持首次授权"把它打开。

## Scope

In scope:

- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `apps/ios/Coflux/Speech/DictationSession.swift`
- `plans/README.md`

Out of scope:

- `apps/ios/Coflux/Speech/AudioCapture.swift` — `.record` category 与
  启停语义不动（换 category 是全体对讲场景的改动，已在 Decisions 否掉）
- `apps/ios/Coflux/Speech/` 的 providers、协议、凭据 — 转写链路零改动
- `apps/ios/Coflux/Speech/DictationOverlay.swift` — 蒙层内交互 068 已定案
- 长按阈值 0.28s — 用户选了"保持"，不得改
- `apps/web`、`apps/mobile`、server/daemon

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 真机验收 (acceptance) | 用户真机：按住占位条立刻见预兆→按下同时开口，蒙层弹出时第一个词已在草稿里；快速点击占位条进成文层，不弹权限框、不打断正在播放的音频、状态栏无橙点；按住 0.2s 松手不留悬挂麦克风（紧接着再长按仍能正常转写） | 用户确认 |

## Done criteria

- [ ] xcodebuild 构建通过。
- [ ] touch down 后 ~120ms 起采音，蒙层仍只在长按判定通过时出现。
- [ ] 预热期音频不丢——蒙层显现时草稿含按下瞬间说的话。
- [ ] 正常点击占位条不启动麦克风、不弹权限框。
- [ ] 未授权时完全不预热，长按走完整权限流程不变。
- [ ] 未达长按松手时 session 静默 cancel 且麦克风释放（无悬挂 tap）。
- [ ] 占位条按下即渐显对讲预兆，点击时几乎不可见。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- xcodebuild 同一错误修复一次后仍失败。
- 蒙层可见性与 session 生命周期无法解耦，或解耦会牵动 068 的确认态
  分支语义——停下报告，不得靠"预热时也显示蒙层"绕过。

## Maintenance notes

- 对讲延迟有三段，别混为一谈：①手指落下→`pressing` 变 true（系统手势
  消歧，本 plan 未消除，需要 UIKit `touchesBegan` 探针才能再压）；
  ②预热去抖 120ms（本 plan 引入，可调）；③长按阈值 0.28s→蒙层出现
  （消歧必需，用户 2026-08-01 定案保持）。
- 麦克风预热是隐私敏感行为：任何放宽预热触发条件（去掉去抖、允许未授权
  时预热）的改动都要重新审视"用户只想打字却开了麦克风"这条。
