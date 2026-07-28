# Plan 064: iOS 终端语音输入——占位条长按对讲，豆包 IME 优先、Apple 本地降级

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 2f5647e..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `2f5647e`, 2026-07-29

## Requirement

移动端打字慢，语音是自然的补充输入通道。给 iOS app 的终端输入加对讲模式：

- 占位条（成文入口条）**点击**行为不变 = 打开成文层；**长按** = 进入对讲。
- 对讲期间（手指按住不放）：全屏轻覆层实时展示流式转写文字（微信按住说话
  的手感）；**上滑超过阈值后松手 = 取消**（覆层内给出可视反馈）。
- **松手 = 结束**：转写终稿落入 `draft`，随即直接打开成文层（键盘弹起、
  光标在尾）——看一眼没问题按发送落终端，要改直接改。**转写文字绝不直接
  发终端**，发送永远由用户在成文层确认。
- 转写引擎：**豆包 IME 免 key 通道优先**，不可用时**降级 Apple 本地
  SpeechAnalyzer/SpeechTranscriber（zh_CN）**。降级应尽量无感（覆层上可给
  小字标注当前引擎）。
- 无 RUNNING session 时输入区本就禁用（`TerminalInputArea.swift:36`），
  对讲随之不可触发，无需额外处理。

正确/错误分界：松手后文字落 draft 并进成文层编辑 = 对；松手即发终端 =
错。长按进对讲、点击进成文层共存且互不干扰 = 对；长按导致点击失效/延迟
明显 = 错。

## Decisions & tradeoffs

- **引擎次序**：豆包 IME 主、Apple 本地降级。Rejected: 只用 Apple 本地 —
  用户实测期望豆包中文口语效果更好；Rejected: 云端付费 API — 要管 key，
  免 key 通道成本为零。用户定案（2026-07-29）。
- **降级时机**：对讲会话开始时一次性决定引擎——豆包整条准入链（缓存凭据
  加载→缺则设备注册→token→WS 握手 StartTask/StartSession）失败或整体超时
  （~2.5s，executor 可调）即用 Apple 本地兜底；**对讲中途豆包断连不换引
  擎**，结束会话保留已转写文字。Rejected: 中途热切换 — 换引擎丢上下文，
  中间结果拼接会出重复/丢字。
- **转写协议层**：最薄 `SpeechTranscribing` 协议（start→AsyncStream 事件
  /feed(pcm)/finish/cancel 量级）+ 两个实现，共享一份 AVAudioEngine 采音
  （tap 重采样到 16kHz mono Int16 PCM 后喂 provider）。Rejected: 更厚的
  provider 注册表/配置化 — 只有两个实现且次序固定，YAGNI。
- **松手去向**：终稿落 `WorkspaceDetailView.draft`（`WorkspaceDetailView.swift:32`）
  并调 `setComposing(true)` 进成文层。Rejected: 只落占位条预览 — 发送要
  多一步；Rejected: 松手直发终端 — 终端命令容错为零，误识别即事故。
  用户定案（2026-07-29）。
- **豆包协议实现**：Swift 手写移植，参考 Rust 实现
  `/tmp/koe/koe-asr/src/doubaoime.rs`（若被清理：
  `git clone --depth 1 https://github.com/missuo/koe.git /tmp/koe`，MIT）。
  手写 protobuf 编解码（固定字段号，varint + length-delimited，全部字段
  号/常量/URL/UA 以该文件为准）；WebSocket 用 URLSessionWebSocketTask。
  Rejected: 引入 SwiftProtobuf 依赖 — 消息只有一进一出两个，手写 ~200 行
  且逆向协议无 .proto 源。
- **设备凭据**：首次自动设备注册（伪装豆包输入法 Android 客户端），
  device_id/token 等凭据存 Application Support 下 JSON 文件，token 12h
  刷新、刷新失败回退旧 token（语义照搬 doubaoime.rs `ensure_credentials`）。
  Rejected: Keychain — 非用户机密，是伪造的设备指纹，文件即可。
- **Opus 编码**：豆包通道音频必须 Opus（16k mono，20ms/帧=640B PCM/帧）。
  先验证 `AVAudioConverter` 到 `kAudioFormatOpus` 的编码能力（iOS 系统
  编码器）；确实不可用则允许加 libopus 的 SPM 包（如 `alta/swift-opus`），
  这将是 SwiftTerm 之外第一个第三方依赖，二选一由 executor 按验证结果定，
  在 plan README 状态里注明走了哪条。
- **Apple 本地路径**：iOS 26 SpeechAnalyzer + SpeechTranscriber(zh_CN)。
  授权走老机制 `SFSpeechRecognizer.requestAuthorization` + 麦克风权限；
  语言模型是系统共享资产，须经 AssetInventory 查询/下载（有进度对象），
  且系统可能因磁盘紧张删除模型——**不可假设装过就永远在**。覆层需有
  "模型下载中"态（豆包可用时该态几乎不出现，仅降级且模型缺失时可见）。
  Based on: 部署目标 iOS 26.0（`Coflux.xcodeproj/project.pbxproj:258`）。
- **权限申请时机**：首次长按对讲时一并请求麦克风 + 语音识别两个权限
  （后者仅 Apple 降级路径需要，但一次问清，之后永不打扰）；任一被拒则
  覆层展示引导去系统设置的提示。`Coflux-Info.plist` 新增
  `NSMicrophoneUsageDescription` 与 `NSSpeechRecognitionUsageDescription`
  中文文案。
- **实时上屏事件模型**：统一为 volatile（可变中间稿）+ finalized（定稿）
  两档。豆包侧 is_interim → volatile，definite/nonstream → finalized，
  含 doubaoime.rs 的 segment-reset 拼接启发式（`doubaoime.rs:1091-1118`，
  必须照搬，否则跨 VAD 段丢字或翻倍）；Apple 侧 SpeechTranscriber 的
  volatile/finalized 天然对应。

## Direction

新增一个语音模块（建议 `apps/ios/Coflux/Speech/` 若干新文件：协议 + 豆包
实现 + Apple 实现 + 采音器 + 对讲会话编排），UI 侧改 `TerminalInputArea`
（占位条手势）与 `WorkspaceDetailView`（对讲覆层挂载与 draft 落稿），
覆层视觉复用现有玻璃语汇（`VariableBlurView`，`TerminalInputArea.swift:215`）。

### Milestone 1: 转写基建——协议 + 豆包实现 + Apple 实现 + 采音

`SpeechTranscribing` 协议与两实现落地，采音器输出 16k mono Int16 PCM。
豆包实现完整覆盖：设备注册→token→WS 握手→Opus 帧流→三档结果解析→
segment 拼接；Apple 实现覆盖授权、AssetInventory 模型态、流式转写。
Validation: `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 2: 对讲交互——长按覆层 + 实时上屏 + 上滑取消 + 松手落稿

占位条长按进对讲（点击行为不受影响），覆层实时显示 volatile/finalized
文字与当前引擎、录音态指示、上滑取消反馈、模型下载态、权限被拒引导；
松手终稿落 draft 并打开成文层。降级链路按决策生效。
Validation: 同上 xcodebuild → exit 0。

### Milestone 3: 收尾

Info.plist 权限文案、`plans/README.md` 状态更新（含 Opus 走了系统编码器
还是 SPM 包的记录）。
Validation: 同上 xcodebuild → exit 0。

## Landmines

- **Button + 长按手势冲突**：占位条现为 `Button(action: onCompose)`
  （`TerminalInputArea.swift:44`）。SwiftUI 里给 Button 叠
  `onLongPressGesture` 会互相吞事件（点按延迟或失效）。需改为非 Button
  方案（如自绘视图 + `LongPressGesture`/`DragGesture` 组合，或
  `.simultaneousGesture`）并实测点击手感不回退。对讲的"按住期间持续跟踪
  手指、上滑量、松手"需要 DragGesture 级别的连续跟踪，纯
  onLongPressGesture 不够。
- **基座对键盘免疫是刻意设计**：`WorkspaceDetailView.swift:131-132`
  `ignoresSafeArea(.keyboard)` + 成文层走独立 fullScreenCover 呈现层
  （2026-07-26 用户定案"冻结基座"）。对讲覆层应加入同类独立呈现或
  overlay，不得破坏基座冻结模型。
- **成文层拆除时序**：`fadeOutAndDismiss`（`TerminalInputArea.swift:319`）
  的 320ms 延迟拆除是真机踩坑结论；对讲覆层若复用 fullScreenCover +
  `presentationBackground(.clear)` 模式，呈现切换要沿用
  `setComposing`/`withTransaction` 禁系统动画的做法
  （`WorkspaceDetailView.swift:379-383`），别重新踩"结尾一卡"。
- **draft 单行语义**：`sendDraft`（`WorkspaceDetailView.swift:390-396`）
  按 plan 054/055 把换行拍平成空格、仅落文本不回车。转写文字里的换行/
  标点原样进 draft 即可，发送语义不要动。
- **豆包 FinishSession 的 First/Last 帧规则**：服务端拒绝没有 First 就来
  Last 的流；不足一帧的短语音要先补 First 再补静音 Last
  （`doubaoime.rs:930-958`）。照搬该状态机。
- **豆包 confirmed_text 不可在 Final 时累积**：results 数组常自带已确认
  段（cumulative），Final 时再拼 confirmed_text 会翻倍——只能经
  segment-reset 启发式增长（`doubaoime.rs:1120-1131` 注释记录了返工史）。
- **对讲期间独占音频**：AVAudioSession 激活录音会打断别的音频；结束/取消
  /出错路径都必须停 engine、deactivate session、关 WS，不能留悬挂 tap
  （下次长按会 crash 或静音）。
- **逆向接口的合规提醒**：豆包 IME 通道是非官方逆向协议，可能随时失效或
  变更；本 app 自用（TestFlight 个人分发），风险用户已知悉并接受。失效的
  表现按降级链路兜底即可，不要加额外重试风暴。

## Scope

In scope:

- `apps/ios/Coflux/Speech/`（新目录，命名可调）
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift`
- `apps/ios/Coflux-Info.plist`
- `apps/ios/Coflux.xcodeproj/project.pbxproj`（新文件/SPM 依赖登记）
- `plans/README.md`

Out of scope:

- `apps/web`、`apps/mobile`（mobile 已冻结）、server/daemon/protocol — 纯
  客户端功能，零协议面变更
- 成文层/控制板既有交互（plan 053-058 定案面）— 只加对讲入口不改现有行为
- 语音消息原声发送、多语言切换 UI — 未提出的需求

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 真机验收 (acceptance) | 用户真机：长按对讲说中文→实时上屏→松手进成文层→发送；断网验证降级 Apple 本地 | 用户确认 |

## Done criteria

- [ ] xcodebuild 构建通过。
- [ ] 占位条点击进成文层行为与手感不回退；长按进对讲。
- [ ] 对讲覆层：实时转写上屏、上滑取消、松手落 draft 即开成文层。
- [ ] 豆包准入链失败/超时时自动落 Apple 本地，覆层可见当前引擎。
- [ ] 权限文案齐备，权限被拒有引导；Apple 路径含模型下载态。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- xcodebuild 同一错误修复一次后仍失败。
- 豆包协议移植后 StartTask/StartSession 在真机/模拟器上无法通过握手且
  非网络原因（意味着协议已变更）——降级路径仍应完整交付，豆包部分如实
  标注状态后停。

## Maintenance notes

- 豆包 IME 是逆向通道，报错/失效先对照上游 koe 仓库是否有协议更新。
- 凭据 JSON 是伪造设备指纹，删除后下次对讲会重新注册，无副作用。
- 若日后要换云端付费 ASR，实现 `SpeechTranscribing` 第三个 provider 即可，
  降级次序在会话编排一处改。
