# Plan 071: iOS 终端文件/图片上传——相册+剪贴板+文件 App 经 fsWrite 注入路径

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c479258..HEAD -- apps/ios/ proto/coflux/v1/device.proto crates/worker/src/device.rs apps/server/src/hub.ts packages/client/src/device-router.ts apps/web/src/components/workbench/terminal-pane.tsx`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `c479258`, 2026-08-11

## Requirement

iOS app 目前没有任何向 agent 传文件的入口。核心场景：手机截图想发给正在跑的
Claude Code / Codex 任务，传不上去。web 端同能力早已存在（plan 014 贴图 +
plan 023 拖拽上传）：字节经 device 数据面 `DeviceFsWrite`（temp=true）落
daemon 侧系统临时目录，回带绝对路径，把 ` <路径> ` 作为文本注入 PTY，CLI 自己
把 prompt 里的图片路径识别为图片读取。iOS 缺的只是这条链路的客户端半边。

完成后为真：

- 输入板（TerminalInputArea）能从**相册**（PHPicker）与**文件 App**
  （UIDocumentPicker）选取内容上传；现有**粘贴键**先识别剪贴板图片（有图走
  上传流），无图回落现行文本粘贴。
- 图片：HEIC 一律转 JPEG（CLI 只认 png/jpg/gif/webp）；png/jpeg ≤预算原字节
  直传不重编码（截图保无损）；超预算按"先质量后分辨率"JPEG 阶梯压缩。
- 任意文件：原样直传，超上限拒绝并明确报错。
- 上传成功后绝对路径（前后各一空格）包 bracketed paste 注入当前活跃终端；
  失败/超时不得静默，走既有错误面。
- 上传期间入口键呈忙态且不可重复触发。
- server / daemon / proto **零改动**——daemon handler、relay scope 授权、
  Swift protobuf 均现成。

区分相邻错误实现：不走控制面（旧 `client_fs_write` 已 reserved 拆除）；不落
用户仓库目录（必须 temp=true）；不能把剪贴板图片经 `UIPasteboard.image`
（UIImage）重编码后上传——限内图片要原字节；无 RUNNING session 时不可上传
（整板已有 sessionID 门控，天然满足）。

## Decisions & tradeoffs

- **传输通道**：device 数据面 `DeviceFsWrite`，iOS DeviceRouter 用现成
  `request(route:lane:.elevated)` 机制移植 fsWrite RPC。Rejected: 控制面
  中继——`client_fs_write` 已 reserved 拆除（client.proto:121）；rejected:
  任何服务端新协议——daemon handler 现成。Based on: device.proto:453
  （DeviceFsWrite 字段）、crates/worker/src/device.rs:907（handler）与 :1433
  （FsWrite 归 DeviceScope::Rpc）、apps/server/src/hub.ts:1714（relay 通道
  授全部四个 scope，iOS relay-only 可直接走）、proto/gen/swift/coflux/v1/
  device.pb.swift:1358（Swift 类型已生成）、TS 参照 packages/client/src/
  device-router.ts:2111-2125（RPC scope → elevated lane :1089-1090）。
- **fsWrite 请求超时单独放宽到 60s**：`request()` 加可选超时参数，仅 fsWrite
  传 60s，其余请求不变。Rejected: 沿用 20s `deviceRequestTimeout`——蜂窝网
  传数十 MB 必超时（TS 侧同为 20s 且未对 fsWrite 放宽，device-router.ts:38，
  这是 web 在快网下没暴露的坑，iOS 蜂窝是常态）。Based on:
  DeviceRouter.swift:51。
- **文件上限 = 30MB 帧上限留封皮余量**（如 30MB − 64KB），超限**前置拒绝**
  并报错。Rejected: 照抄 web 的整 30MB（terminal-pane.tsx:42）——iOS
  `encodeFrame` 对超帧**静默丢弃**（DeviceRouter.swift:674-676），恰好压线
  的文件加上 envelope 开销超帧后请求会悬到超时，用户只看到莫名"超时"。
  Based on: DeviceProtocol.maxFrameBytes = 30MB（DeviceRouter.swift:7）。
- **图片预算与压缩**：≤3.5MB 原字节直传；超限 JPEG 质量阶梯（先保分辨率降
  质量，再减半降采样），与 web 同原则同预算。HEIC 无论大小一律转 JPEG。
  Rejected: 图片也放到 30MB 直传——蜂窝上传大 PNG 慢且 CLI 读图不需要；
  rejected: 一律重编码——限内截图保无损是 plan 014 的既定语义。Based on:
  terminal-pane.tsx:39（PASTE_BUDGET_BYTES）、:121（compressToBudget）。
- **注入方式**：上传成功后 ` <绝对路径> `（前后空格）包 bracketed paste 经
  现有 `press()` 发送。Rejected: 写入 draft 等用户再发——多一步且偏离 web
  语义（web 直接 `terminal.paste(" path ")`，terminal-pane.tsx:308）。
  Based on: pasteKey 同语义（TerminalInputArea.swift:219-227）。
- **operation_id 必填新 UUID**：worker 按它对 FsWrite 做幂等去重，断连重投
  不重复落盘。Based on: device.rs:1313、TS 填 operationId
  （device-router.ts:2117）。
- **入口形态**：padRows 加图片键（`PHPickerViewController`，免相册权限弹窗）
  与文件键（`UIDocumentPickerViewController` **asCopy: true**）；粘贴键改为
  先查剪贴板图片再回落文本。均**单选**（decided while planning：截图场景单张
  为主，多选后续按需；web 的多文件拖拽语义在移动端没有对应交互压力）。
- **命名**：单段文件名 `<前缀>-<epoch毫秒>-<短随机><ext>`；剪贴板 `paste-`、
  相册 `photo-`、文件 `file-`；文件保留原扩展名但仅取 ASCII 字母数字 ≤16
  （web safeDropExtension 同原则，terminal-pane.tsx:105-108）。temp 模式
  path 仅允许单段文件名（device.proto:453 注释），带目录会被 daemon 拒。
- **DeviceRouter ceiling 声明同步修订**：`DeviceRouter.swift:40-41` 注释里
  "fs/exec RPC 不移植"要改为"fsWrite 已移植（plan 071），其余不移植"，
  否则注释与代码矛盾。

## Direction

数据流：入口键选取/读取字节 →（图片管线：HEIC 转 JPEG / 超预算压缩）→
`CofluxClient` 薄封装（从 task 解析 daemonID/workspaceID，参照 sendInput
:476-482 的解析方式）→ `DeviceRouter.fsWrite`（elevated lane，temp=true）→
daemon 落盘回绝对路径 → bracketed paste 注入 PTY；失败走
`reportLocalError`（CofluxClient.swift:514）。

### Milestone 1: DeviceRouter 移植 fsWrite RPC + 单测

`fsWrite(daemonID:workspaceID:path:data:temp:) async throws ->
Coflux_V1_FsWriteResult` 可用：走 elevated lane 现成 request/flush/重投机制；
`requestID(of:)`（:1132）补 `.fsWrite`、`responseRequestID(_:)`（:1145）补
`.fsWriteResult`，否则回包进不了 pending 配对；请求超时按决策放宽。新用例写进
**现有** `apps/ios/CofluxTests/DeviceRouterTests.swift`（FakeTransport
harness 现成；新建测试文件要动 xcodeproj，不做），至少覆盖：发出的帧带
workspace_id/temp/operation_id、收 FsWriteResult 正确 resolve、错误回包
reject。
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux
-destination 'platform=iOS Simulator,name=<可用 iPhone 模拟器>' test` → exit 0。

### Milestone 2: CofluxClient 上传封装

上传 API：入参（字节 + 建议文件名 + 会话上下文），内部解析 daemonID/
workspaceID、调 fsWrite、成功注入路径、失败 reportLocalError；对外暴露
per-session 上传中状态供 UI 置忙。无 RUNNING session 时拒绝（与输入同门控）。
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux
-destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 3: TerminalInputArea 入口三件套 + 图片管线

图片键（PHPicker）、文件键（UIDocumentPicker asCopy）、粘贴键图片分支；
HEIC→JPEG / 预算压缩管线；上传忙态（键置 ProgressView 或降透明度并禁点）。
键位样式沿用现有 `keyCap`；**不得**用 interactive glassEffect 包 Button
（plan 070 二轮返修教训：其 UIKit 背板吞点击）。
Validation: 同上 xcodebuild build → exit 0。

## Landmines

- `encodeFrame` 超帧静默丢弃（DeviceRouter.swift:674-676）：不做前置大小
  检查的话，超大文件表现为 60s 悬挂后超时，极难排查。上限校验必须在编码前。
- `UIPasteboard.general.image` 返回 UIImage，**丢原始字节**；要
  `data(forPasteboardType:)` 按 png/jpeg UTI 取原字节，仅超预算才重编码。
  首次读剪贴板 iOS 会弹系统粘贴授权提示，属正常行为。
- UIDocumentPicker 若不用 `asCopy: true`，返回的 URL 需
  `startAccessingSecurityScopedResource` 配对管理，漏配对读取直接失败；
  asCopy 拿到的是沙盒内拷贝，免这套。用 asCopy。
- PHPicker / DocumentPicker 的回调与 NSItemProvider 加载在后台线程；
  DeviceRouter/CofluxClient 全在 MainActor，回跳要显式。
- iOS 大截图（PNG 5-15MB 常见）会走压缩分支，UIImage 解码+重编码在主线程会
  卡 UI——压缩放后台。
- pasteKey 现有文本分支的 bracketed paste 包裹（TerminalInputArea.swift:222）
  是既定语义，图片分支不得影响它。
- plan 055 曾把成文层的 bracketed paste 去掉——那是**成文层**的决定，
  pasteKey/路径注入不受其约束，别顺手"统一"掉。
- CofluxTests 里 DeviceHarness/FakeTransport（DeviceRouterTests.swift:9-10）
  是现成的协议级测试基建，直接用；别为测 fsWrite 引入新 mock 体系。

## Scope

In scope:

- `apps/ios/Coflux/Client/DeviceRouter.swift`
- `apps/ios/Coflux/Client/CofluxClient.swift`
- `apps/ios/Coflux/Views/TerminalInputArea.swift`
- `apps/ios/CofluxTests/DeviceRouterTests.swift`（仅在现有文件加用例）
- 如确需最小接线：`apps/ios/Coflux/Views/WorkspaceDetailView.swift` /
  `TerminalHostView.swift`
- `plans/README.md`（状态更新）

Out of scope:

- `proto/`、`crates/`、`apps/server/`、`apps/web/`、`packages/`——服务端与
  web 侧零改动是本 plan 的正确性判据之一
- 相机拍照入口——未要求
- 多选/批量上传——decided while planning 单选，后续按需
- `apps/mobile/`——已冻结（memory: mobile-companion）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 单测 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<可用 iPhone 模拟器>' test` | exit 0 |
| 构建 | `cd apps/ios && xcodebuild -project Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 真机验收 (acceptance) | 用户真机：截图→相册选图上传→路径注入→CLI 读图；文件 App 上传；剪贴板贴图；蜂窝网大文件 | 用户人工验收 |

## Done criteria

- [ ] 单测与构建命令通过。
- [ ] 输入板可从相册、文件 App、剪贴板三路上传，成功后路径注入终端。
- [ ] HEIC 转 JPEG、限内原字节直传、超预算压缩、超上限前置拒绝并报错。
- [ ] DeviceRouterTests 覆盖 fsWrite 请求/回包/错误三线。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其 relay scope
  授权 hub.ts:1714 与 worker FsWrite handler device.rs:907）。
- The outcome requires out-of-scope files（如发现必须改 proto/server 才能
  打通——那说明某个前提破裂）。
- xcodebuild 同一错误修复一次后仍失败。
- Swift protobuf 里缺 DeviceFsWrite / FsWriteResult 类型（生成物过期）。

## Maintenance notes

- daemon 侧临时目录清理是既有语义（写入时顺删 mtime>7 天旧文件，plan 014），
  iOS 上传的文件同受其管理，无需 iOS 侧清理。
- 图片预算 3.5MB 是历史遗留（旧 4MB 控制面 maxPayload 减余量），当前帧上限
  30MB 下纯属保守值；蜂窝体验上仍合理，但若日后要提，只动 iOS/web 两处常量。
- 若未来 CLI 支持 HEIC，可去掉转码分支；转码判据集中在图片管线一处。
