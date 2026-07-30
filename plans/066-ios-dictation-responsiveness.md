# Plan 066: 长按对讲跟手性——开口不丢字、按下即回馈、蒙层内成稿确认

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 06544ca..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none（迭代 plan 064 交付面）
- Category: feature
- Execution: subagent sonnet
- Planned at: `06544ca`, 2026-07-30

## Requirement

plan 064 的长按对讲真机可用（TCC 隔离崩溃已修，`06544ca`），但用户实测
"太难用了，不跟手"，链路拆解后是三段延迟：

1. **按下无回馈**：280ms 长按判定期占位条毫无动静，判定通过蒙层才淡入。
2. **开口丢字**：`DictationSession.start()` 里权限已授予也要串行过两轮
   tccd XPC（`requestRecordPermission` + `requestAuthorization`）再起
   `capture.start()`（AVAudioEngine 启动约 100-300ms）——长按后立即开口，
   头几百毫秒音频在采音开始前全丢，第一个词经常识别不到。
3. **松手拖沓**：等终稿最多 2s → 拆蒙层 → 弹成文层 + 系统键盘动画 →
   用户再点发送。松手后收尾两三秒且强制换界面。

本 plan 目标（全部达成才算完）：

- 按下瞬间有触觉 + 视觉回馈；长按判定阈值降到 ~180ms。
- 权限已授予时跳过全部权限 XPC，尽早起采音，消除开口丢字窗口。
- 松手后蒙层**留驻成稿**：中间文字定格为草稿，蒙层内直接
  发送 / 点文字编辑 / 弃掉，不再自动弹成文层。

正确/错误分界：松手后不换界面、蒙层内一击发送 = 对；松手仍自动进成文层
= 错。发送必须仍由用户显式点击确认，任何"自动发送/倒计时发送"= 错。

## Decisions & tradeoffs

- **成稿形态（用户定案 2026-07-30，推翻 plan 064 的"松手即弹成文层"）**：
  松手 → 蒙层留驻，中间转写文字定格为草稿；底部主按钮「发送」直接落终端
  （必须走现有 `sendDraft` 等价路径）；点草稿文字 → 文字落 `draft` 并打开
  成文层编辑（既有编辑通道保留）；「弃掉」次操作 → 拆蒙层丢弃。
  Rejected: 仅发送/弃掉不留编辑 — 误听一个字也得整句重说；
  Rejected: 倒计时自动发送 — 与 plan 064 "误听代价大、发送必须人工确认"
  定案冲突。确认关卡保留，只是场所从成文层移到蒙层。
- **长按阈值 180ms（用户定案 2026-07-30）**：280ms → ~180ms，蒙层更快出现。
  已知代价：短按（打开成文层）误判为长按的概率上升；若真机回归发现点击
  手感明显回退，STOP 报告，不得自行改回 280ms。
  Based on: `TerminalInputArea.swift:77` 现值 280ms。
- **权限快路径**：`AVAudioApplication.shared.recordPermission == .granted`
  且 `SFSpeechRecognizer.authorizationStatus() == .authorized` 时（两者均可
  同步查询，前者已在 `DictationSession.swift:55` 使用）完全跳过两个异步
  权限请求与后续的 active 等待/400ms 缓冲（那套时序只为权限框收起的瞬态
  服务，见 `DictationSession.swift:63-75` 注释），直接 `capture.start()`。
  未决/被拒仍走现有请求路径。Rejected: app 启动时预热权限请求 — 启动即弹
  权限框体验差，且解决不了 AVAudioEngine 启动耗时。
- **崩溃修复不可回退**：`06544ca` 把权限回调闭包脱离 MainActor 隔离
  （原生 async API + `nonisolated static`），保留的权限请求路径必须维持
  该结构——闭包一旦重新继承 `@MainActor` 隔离，tccd 后台队列回调会再次
  SIGTRAP（SE-0423）。Based on: `DictationSession.swift:217-224`。
- **按下即时回馈**：手指落下（DragGesture 首个 onChanged）立即触觉反馈 +
  占位条视觉按压态；180ms 判定通过再起蒙层。具体视觉形式 executor 定，
  与现有玻璃语汇一致即可。
- **终稿等待态**：松手后蒙层立即切成稿态（不阻塞等 `finish()`），草稿先
  显示当前已转写文本（volatile 样式），终稿到达后原位更新为定稿样式；
  终稿落定前发送不可误触发（禁用或点击后待落定自动继续，executor 二选一）。
  `finish()` 内部已 await startTask 保证 phase 落定语义不变
  （`DictationSession.swift:155-166`）。
- **空转写松手**：松手时无任何转写文字 → 直接拆蒙层，不进成稿态（无稿
  可确认）。现行为是弹开空成文层（`WorkspaceDetailView.swift:461-465`），
  一并消除。
- **失败/权限态收敛（decided while planning）**：`.permissionDenied` 与
  `.failed` 的留驻引导行为保持 plan 064 语义；但 `.failed` 且已有转写文字
  时（豆包中途断连场景），统一进成稿态并同时展示错误标注——文字可发送/
  编辑，不再只是"落 draft 等用户自己发现"（`WorkspaceDetailView.swift:451-457`
  的旧路径随成稿态重构消化）。

## Direction

改动集中在既有四个文件：`DictationSession`（权限快路径）、
`DictationOverlay`（成稿态 UI 与操作）、`TerminalInputArea`（阈值 +
按压回馈）、`WorkspaceDetailView`（松手收尾流程重构：从"落 draft 开
成文层"改为"蒙层留驻成稿"）。Speech providers（豆包/Apple）零改动。

### Milestone 1: 跟手性——按下回馈 + 180ms + 权限快路径

按下瞬间触觉/视觉回馈；已授权路径下 begin 到 capture.start() 之间无任何
权限 XPC await。
Validation: `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 2: 蒙层内成稿——留驻 + 发送/编辑/弃掉

松手进成稿态：草稿定格居中，发送直落终端、点文字进成文层编辑、弃掉拆层；
空转写直接拆层；失败态带字进成稿态并示错。
Validation: 同上 xcodebuild → exit 0。

## Landmines

- **发送语义必须复用 `sendDraft` 路径**：plan 054/055 定案换行拍平成空格、
  仅落文本不回车（`WorkspaceDetailView.swift:390` 附近）。蒙层发送若绕过
  该路径自行写终端，会破坏单行语义。
- **蒙层手势结构要变**：现在 `DictationOverlay` 全程手指按住，蒙层自身仅
  在 permissionDenied/failed 态接收点击（`DictationOverlay.swift:15-27`
  `isDismissable`）；成稿态蒙层要接收按钮点击与点文字，而对讲进行态仍
  不能拦截任何触摸（手指还按在占位条上，DragGesture 在占位条的坐标系里
  持续跟踪）。两态的 hit-testing 切换别搞反。
- **`endDictation` 的异步收尾时序是踩坑结论**：finish() 返回前不能拆
  session/蒙层，否则权限引导闪没（`WorkspaceDetailView.swift:433-436`
  注释）。成稿态重构后该保证仍须成立。
- **占位条 mic 指示与 dictateActive**：松手后蒙层留驻但手势已结束，
  `TerminalInputArea` 的 `dictateActive` 熄灭（`TerminalInputArea.swift:57-60`
  mic 图标），成稿态期间占位条不应再显示对讲中。
- **对讲结束必须释放音频会话**：成稿态留驻期间用户可能停留任意久，
  capture/engine/WS 必须在松手收尾即关闭（现 finish() 已做），不能等
  用户点完发送才释放——留驻期间占用麦克风会挂橙点。

## Scope

In scope:

- `apps/ios/Coflux/Speech/DictationSession.swift`
- `apps/ios/Coflux/Speech/DictationOverlay.swift`
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `plans/README.md`

Out of scope:

- `apps/ios/Coflux/Speech/` 其余文件（豆包/Apple provider、采音、协议）—
  转写引擎链路本 plan 不动
- 成文层/控制板既有交互（plan 053-058 定案面）— 只有"从蒙层点文字进入
  编辑"这一新入口，成文层内部行为零变更
- `apps/web`、`apps/mobile`、server/daemon — 纯 iOS 客户端交互

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 真机验收 (acceptance) | 用户真机：长按立即有回馈→开口首词不丢→松手蒙层成稿→发送/点文字编辑/弃掉三路径；短按打开成文层手感不回退 | 用户确认 |

## Done criteria

- [ ] xcodebuild 构建通过。
- [ ] 已授权路径 begin→capture.start() 无权限 XPC await；未决路径行为不变。
- [ ] 按下即时回馈，长按判定 ~180ms。
- [ ] 松手蒙层留驻成稿：发送直落终端（sendDraft 语义）、点文字进成文层
      编辑、弃掉拆层；不再自动弹成文层。
- [ ] 空转写松手直接拆层；失败态带字进成稿态并示错。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- xcodebuild 同一错误修复一次后仍失败。
- 180ms 阈值导致短按/长按判定在实现层面无法两全（如手势识别器约束）——
  停下报告，不得自行回调阈值。

## Maintenance notes

- 长按阈值若后续再调，只动 `TerminalInputArea` 一处常量；180ms 是用户
  显式定案，回调需用户拍板。
- 成稿态是对讲的第三个 UI 相位（进行中/成稿/错误留驻），后续加功能
  （如成稿态语音追加）先想清相位机再动手。
- 权限快路径依赖两个系统同步查询的准确性；iOS 大版本升级后若出现"已
  授权仍丢字"，先查这两个查询是否仍与 tccd 实况一致。
