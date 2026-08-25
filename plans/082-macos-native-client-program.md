# Plan 082: macOS 原生客户端总体重构契约——以原生工作台功能等价替代 Web 桌面端

> 本 plan 是 macOS 原生化项目的**总体结果契约与决策记录**，不是一次性执行脚本，也不应由
> 单个执行会话从头做到尾。后续每个 Roadmap 阶段都必须另立范围收敛的执行 plan；首个可执行
> 门禁是 plan 083。理解需求、已定决策和风险边界后，对照活代码重新设计阶段实现。命中 STOP
> 条件即停。阶段完成后更新 `plans/README.md`，不得把总体 plan 直接标成 DONE。
>
> Drift check: `git diff --stat 8d702d2..HEAD -- apps/web/src/components/workbench/ packages/client/src/ apps/ios/ proto/ crates/worker/src/p2p.rs apps/server/src/local-control.ts docs/architecture.md docs/ROADMAP.md docs/RELEASING.md .github/workflows/`

## Status

- Priority: P1
- Effort: L（项目级；预计 22–30 工程周，不是一张单次执行卡）
- Risk: HIGH
- Depends on: none
- Category: refactor
- Planned at: `8d702d2`, 2026-08-25
- Review state: 用户已于 2026-08-25 审阅并授权整体实现目标；按子 plan 逐阶段 self-execution，
  本机依赖安装与 Web/native 对照验收在授权内，推送、生产发布与真实签名凭据仍需另行授权

## Requirement

把 `apps/web` 当前桌面工作台做成真正的 macOS 原生客户端：不使用 Electron、Tauri、
WKWebView、Catalyst 或任何以网页作为主 UI 的壳，也不随 App 携带 JS runtime。Mac 用户应能在
原生 App 内完成项目、工作区、设备、终端、Git/diff 与文件操作；端口预览和设备授权等本质为
网页的流程允许交给系统默认浏览器。

完成后的产品形态：

1. macOS 原生 App 成为 Mac 用户默认工作台，功能覆盖当前 `apps/web` 桌面端。
2. `apps/web` 保留为授权、端口预览、跨平台访问和故障 fallback，不因原生化被删除或冻结。
3. macOS 与 iOS 共享 Swift 客户端核心（认证、控制面、协议、DeviceRouter），但各自保留独立 UI；
   不把 iOS 界面放大成桌面版，也不使用 Catalyst。
4. 终端、DeviceRouter 和版本准入达到生产级行为契约，并有跨实现自动化证据；不是只在演示环境
   “能连上”。
5. App 能以 Developer ID 签名、公证、可更新的正式产物分发，并可安全回退到 Web。

### “复刻”的验收定义

- **功能等价**：用户目标、状态语义、错误边界和安全约束与 Web 等价；这是硬要求。
- **视觉高度一致**：沿用 Coflux 的色彩、字体角色、密度和信息层级；这是硬要求。
- **macOS 原生交互**：菜单、快捷键、拖放、剪贴板、窗口、焦点、辅助功能遵循 macOS 习惯；
  允许与浏览器控件外观不同。
- **不要求像素逐帧相同**：CoreText/SwiftTerm 与 DOM/xterm.js 的字体栅格、滚动条、选区、IME
  细节必然存在差异。若未来把截图逐像素一致设为硬要求，必须重新评估“不使用 WebView”的前提。
- **终端语义等价**：同一录制流、snapshot 与 tail 在关键 buffer/cell/mode 上恢复一致；不以肉眼
  “看起来差不多”代替契约验证。

正确解与相邻错误解：正确解是**原生 UI + 原生终端控件 + Swift 客户端核心**，在功能和设计语言上
替代 Web 桌面工作台；把现有网页嵌入窗口、只做 relay-only 终端、只覆盖项目列表、或为了“原生”
而删除浏览器授权/预览入口，均不是本需求的完成态。

## 调研基线与可行性结论

### 结论

技术上没有硬性死路，建议立项为 **GO，但受 plan 083 三项门禁约束**。UI 不是最大风险；最大风险是
DeviceRouter 的 direct/P2P/relay 状态机、SwiftTerm 对 daemon ANSI snapshot 的兼容性，以及两套
客户端实现的长期行为同步。

### 已存在的原生资产

- `apps/ios` 已有约 5,800 行 Swift（含测试），不是概念验证。`CofluxClient.swift` 已实现登录、
  控制面归约、重连和 token 持久化；`DeviceRouter.swift` 已实现 relay session/elevated lane、
  attach/snapshot/resume、holder/强制接管、输入与 resize 台账、累计 ACK 重投、prepared operation、
  `fsWrite` 和设备 RTT。
- Swift Router 自己明确声明当前只是 relay 子集，缺 direct/loopback、pair/lease、`fsList`、
  `fsRead`、`execRun`：`apps/ios/Coflux/Client/DeviceRouter.swift:44-49`。
- Swift protobuf 已由同一份 IDL 生成：`proto/buf.gen.yaml:11-13`，当前产物在
  `proto/gen/swift`，iOS 工程通过同步文件组消费：
  `apps/ios/Coflux.xcodeproj/project.pbxproj:34`。
- SwiftTerm 1.15.0 已锁定：
  `apps/ios/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved:31-38`。
  该版本提供 macOS AppKit `TerminalView`、CoreText、选区、搜索、鼠标、超链接、IME、TrueColor、
  Sixel/iTerm/Kitty 图片以及可选 Metal 路径。
- 2026-08-25 调研机工具链为 Xcode 26.6、Swift 6.3.3、macOS 27.0 arm64，具备本地开发条件。

### 实测基线

调研期间实际执行 iOS Simulator 测试，而非只读源码：

- 29 条中 26 条业务/状态机/Router 用例通过；
- 2 条需要真实 dev topology 或音频设备的 probe 按设计跳过；
- 唯一失败的 Keychain 用例是调研命令显式设置 `CODE_SIGNING_ALLOWED=NO` 所致；恢复模拟器本地
  签名后单独重跑通过。

这证明现有 Swift 控制面与 relay Router 可作为真实基础，但不构成 macOS、P2P 或终端 snapshot
兼容性的证明。

### Web 功能真相面

当前需覆盖的桌面工作台主要分布在：

- `apps/web/src/components/workbench/workbench.tsx`
- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/terminal-pane.tsx`
- `apps/web/src/components/workbench/changes-view.tsx`
- `apps/web/src/components/workbench/import-project-wizard.tsx`
- `packages/client/src/store.ts`
- `packages/client/src/device-router.ts`

相关核心文件约 13,700 行；原生化是重写，不是机械翻译 React 组件。

### WebRTC 现实路径

Apple 没有提供可替代 WebRTC DataChannel 的第一方框架，`Network.framework` 也不实现
ICE/DTLS/SCTP。但 macOS 原生 libwebrtc 供应是现实存在的：

- [`stasel/WebRTC`](https://github.com/stasel/WebRTC) 在 2026-08-07 发布 M151 XCFramework，
  SwiftPM 二进制约 44.6 MB，支持 macOS arm64/x86_64；构建自官方 WebRTC 源码，构建流程公开。
- [`livekit/webrtc-xcframework`](https://github.com/livekit/webrtc-xcframework) 是维护中的备选，
  支持 iOS/macOS/Catalyst，并通过 SwiftPM checksum 固定二进制。
- [`shiguredo-webrtc-build/webrtc-build`](https://github.com/shiguredo-webrtc-build/webrtc-build)
  提供 macOS arm64 原生 libwebrtc，但已停止 macOS x86_64，若首发需要 Intel 不能单独依赖它。

调研时点的可复核快照（不等于执行时可跳过重新审计）：

| 候选 | 2026-08-25 快照 | 供应链备注 |
| --- | --- | --- |
| stasel/WebRTC | `151.0.0`，asset `WebRTC-M151.xcframework.zip` 44,616,338 B，SwiftPM checksum `64a218fad3d84a0d783321aa9a1eec58ca266ac7879123f86b0b44b703b7d8dc` | README 声明 BSD 3-Clause + WebRTC license；GitHub API 未识别 repo license，生产采用前仍需法务/构建来源复核 |
| LiveKit WebRTC | `144.7559.14`，SwiftPM checksum `4b0a4be4564aa05168a02f262bbbc4d6d9a552aaa1c102229ed5adf1c480b81a` | repo 标 MIT；为 LiveKit 前缀化 fork，需验证 raw DataChannel API 与 worker 互通 |
| Shiguredo build | 当前列表含 `macos_arm64`，不含 x86_64 | Apache-2.0；若放弃 Intel 可作为源码/构建链对照，不是本计划 universal 首选 |

因此 P2P 没有“做不到”的问题，未知量是依赖治理、体积、跨栈互通和长期维护；必须由 plan 083
实测后定型。现有 worker 使用 `webrtc-rs 0.20.2`：`crates/worker/Cargo.toml:33`。

### 发布资产

Developer ID、notarytool 和现有 GitHub secret 约定已存在：`docs/RELEASING.md:24-59`；但它们
当前服务 daemon 裸二进制，不等于 `.app`/DMG、Sparkle feed、原生版本准入和 macOS App CI 已完成。
现有 CI 主质量门只跑 `ubuntu-latest`：`.github/workflows/ci.yml:17`。

## 功能覆盖矩阵

| 当前 Web 能力 | 原生落点 | 目标与风险判断 |
| --- | --- | --- |
| 高密度项目/工作区/设备侧栏、可调宽度、右键、Tooltip | SwiftUI；密度/性能不足时桥接 `NSSplitView`/`NSOutlineView` | 高把握；不照搬移动导航 |
| 工作区 Agent 状态、留言、diff 统计、orphan session | 共享 Swift store/reducer + 原生状态组件 | 高把握；需补齐 iOS 当前未归约字段 |
| 登录、快照、增量广播、离线/版本错误 | 复用并抽取 `CofluxClient` | 已有基础；正式版本不能继续上报 `"dev"` |
| 多终端 Tab、乐观创建、后台保活、OSC 标题、Agent 动画 | SwiftUI Tab 状态 + SwiftTerm；隐藏而不销毁 inactive terminal | 高把握；要守住 scrollback/焦点 |
| attach/holder/强制接管/断线恢复 | 共享 Swift DeviceRouter | 已有 relay 基础；必须与 Web 语义做契约测试 |
| xterm 链接、IME、选区、搜索、鼠标、图片协议 | AppKit SwiftTerm `TerminalView` | 功能可做；snapshot 与边角转义序列为高风险 |
| 图片粘贴压缩、文件拖放上传 | `NSPasteboard`、拖放 API、ImageIO/`NSImage` + `fsWrite` | 高把握；守住 3.5 MB 图片预算和 30 MB 文件上限 |
| direct / P2P / relay 竞争、promotion、RTT | loopback WS + libwebrtc DataChannel + relay | 可行但为最高工程风险 |
| 项目导入：设备选择、远端目录浏览 | 补齐 Swift `fsList/fsRead` + 原生向导 | 协议/daemon 已有；中等工作量 |
| 分支列表、新建/切换、worktree | 复用 prepared operation / Device RPC | 高把握；保留乐观 UI 和失败回滚 |
| git diff、untracked、统一 diff、语法高亮 | Swift RPC + TextKit 2/AppKit 虚拟化渲染 | 可行；大 diff 性能需门禁 |
| 端口列表与预览 | 原生列表，`NSWorkspace.open` 打开系统浏览器 | 功能保留；不在 App 内嵌网页 |
| 全局快捷键、菜单、复制粘贴、辅助功能 | macOS Commands、`NSMenu`、AppKit 焦点/Accessibility | 原生体验应优于 Web |
| 设备授权、安装引导、跨平台 fallback | 保留 Web 页面，由默认浏览器打开 | 明确保留，不算原生化缺口 |

## Decisions & tradeoffs

- **技术栈采用 SwiftUI-first + 必要的 AppKit 桥接**。Rejected: 纯 AppKit — 全量 UI 成本高且
  不利于与现有 iOS Swift 模型共享；Rejected: 纯 SwiftUI — 高密度侧栏、大 diff 和终端需要
  AppKit 的可控性能与成熟输入系统。Based on: `docs/ROADMAP.md:74-78` 已记录同一方向，
  SwiftTerm 也提供 AppKit 而非只提供 SwiftUI 封装。

- **新建真正的 macOS target，目录约定为 `apps/macos`，用户可见产品名与 scheme 为 `Coflux`**。
  Rejected: Mac Catalyst / “Designed for iPad” — 不能满足桌面密度、窗口、菜单、快捷键和 AppKit
  终端边界；Rejected: 把 macOS UI 塞进 `apps/ios` — 会让两个产品的导航与发布生命周期耦合。

- **iOS/macOS 共享客户端核心，UI 完全分开**。共享边界包含协议、认证、控制面归约、
  DeviceRouter、Keychain/identity 抽象和测试 fixture；平台 UI、语音输入与窗口管理不共享。
  Rejected: 复制一份 macOS `CofluxClient` — 会形成 Web/iOS/macOS 三份行为实现；Rejected: 直接
  共用 iOS View — 产品形态错误。共享核心的最终物理目录由 plan 083 后的首个 foundation plan
  冻结，不能在多个并行 plan 各自搬一次。

- **首选 Swift Router + 原生 libwebrtc；Rust client core 仅作明确备选**。Rejected: 默认先做
  Rust FFI — 现有 Rust P2P 是 worker responder，不是可直接嵌入的客户端 Router；还会引入
  UniFFI/callback/actor、双工具链和分发复杂度，且重做已有 Swift relay 基础。若 plan 083 证明
  libwebrtc 无法满足跨栈互通/许可/体积要求，或产品确定一年内做 Windows/Linux 原生客户端，
  才重新评估 Rust core。

- **功能等价是硬门，像素一致不是**。Rejected: 为保持 xterm/React 截图一致而自绘所有控件 —
  成本高且损失原生交互；Rejected: 因引擎差异放宽终端恢复语义 — attach/snapshot 是数据正确性，
  不能按视觉差异处理。Based on: `docs/architecture.md:187-212` 的 snapshot fidelity 契约。

- **完整版本必须包含 loopback direct、P2P 与 relay，不以 relay-only 宣布 parity**。iOS 当前 relay-only
  是移动端“永不与 daemon 同机”的有意 ceiling，不适用于 Mac。Based on:
  `apps/ios/Coflux/Client/DeviceRouter.swift:44-49` 与 Web 竞争模型
  `packages/client/src/device-router.ts:1237-1304`。

- **终端首发以 CoreText/CoreGraphics 路径为基线，Metal 是后续性能优化而非上线前提**。
  SwiftTerm macOS Metal 源码明确标为 experimental；Rejected: 首版默认 Metal — 窗口 reparent、
  live resize 和 GPU context 恢复会扩大验证矩阵。

- **同一份 Claude CLI、Codex CLI、Vim/TUI fixture 同时约束 xterm 与 SwiftTerm**。Rejected:
  只写 SwiftTerm 单元测试 — 无法发现 daemon snapshot 对两个解析器的解释漂移；Rejected: 只做截图
  对比 — 会把字体抗锯齿差异混进状态正确性。

- **本机身份沿用 P-256 grant/lease 安全模型，但不默认把“伪装浏览器 Origin”当长期设计**。
  plan 083 先验证原生 WS 能用稳定 HTTPS Origin 跑通现有协议，再做威胁模型评审；若需要新增
  native client identity/header，必须另立协议 plan 并同步 TS/Rust/Swift，不能在 App 内静默降低
  校验。Based on: `apps/server/src/local-control.ts:99-108,401-404`。

- **Web 是伴生入口，不是迁移后待删除的旧实现**。保留 `/authorize`、端口预览门禁、安装引导、
  非 Mac 客户端和 fallback。Rejected: 完全删除 Web — 端口预览本身就是网页，且会失去跨平台
  与灾备入口；Rejected: 把预览塞进 WKWebView — 违背原生主 UI 边界且增加 cookie/认证面。

- **首发采用 Developer ID + Hardened Runtime + 公证 + Sparkle 2（或经安全评审的等价更新器），
  不以 Mac App Store 为首发渠道**。Rejected: 先做 App Store — sandbox、更新、loopback/WebRTC
  权限与现有直接分发体系叠加，不能降低核心产品风险。App Sandbox 是否启用由 plan 083 对本地网络
  权限实测后冻结，但无论结果都必须最小权限、Keychain 存 token/私钥。

- **默认兼容目标为 macOS 14+，首发产出 arm64/x86_64 universal App**。原因是 Swift Observation
  与现代 SwiftUI/AppKit 基线，同时覆盖仍在支持期的 Intel Mac；若立项时设备统计证明 Intel 可
  放弃，可在 foundation plan 前收窄，收窄必须是产品决策而非构建方便。

- **正式客户端必须上报可审计的 native build/version，不得继续使用 iOS 当前 `"dev"` 白名单**。
  Based on: `apps/ios/Coflux/Client/CofluxClient.swift:65-67` 与
  `apps/server/src/hub.ts:1793-1807`。版本准入需允许 Web 与 native 不同发布节奏，并有最低协议版本
  与可读升级提示。

- **不动冻结的 `apps/mobile`，不把桌面功能同步过去**。共享协议变化若破坏其构建，仅做最小修复；
  该约束来自仓库 AGENTS.md。

- **迁移期间允许 Web 与 native 并存，holder 冲突必须显式裁决**。不能靠“用户不会同时打开”规避；
  多客户端 attach、detached、force takeover 与后台 terminal 生命周期属于上线门。

## Architecture direction

目标边界：

```text
apps/macos（原生 UI / App 生命周期 / 菜单 / 更新）
  ├─ SwiftUI 工作台：侧栏、项目/工作区、Tab、diff、设备、预览入口
  ├─ AppKit 边界：SwiftTerm、必要时 NSOutlineView/TextKit/NSSplitView
  └─ 共享 Swift Client Core（iOS + macOS）
       ├─ Swift Protobuf / 控制面 WS / reducer / 版本准入
       ├─ DeviceRouter：loopback direct > P2P > relay、session/elevated lanes
       ├─ P-256 identity、grant/lease、Keychain
       └─ fs/exec/ports/session APIs + 可观测性

server / relay / Rust daemon：继续作为线协议与行为真相侧
apps/web：继续作为行为参照、伴生入口与 fallback
```

共享核心不得 import SwiftUI/AppKit/UIKit；平台存储、WebSocket、时钟、随机数与日志通过小而明确的
适配边界注入，便于确定性测试。网络状态机以 actor 或单一隔离域承载，不能让 SwiftUI view 直接
拥有连接生命周期。现有 iOS `@MainActor` 单线程模型可作为起点，但抽取时必须评估高吞吐 PTY 输出
是否需要与主线程解耦，不能机械照搬。

## Roadmap

### Phase 0：立项风险门禁（plan 083，2–3 工程周）

在不做完整 UI 的前提下关闭三个未知量：SwiftTerm snapshot fidelity、native libwebrtc 与
webrtc-rs DataChannel 互通、native loopback P-256/Origin/grant/lease。输出 GO / CONDITIONAL GO /
NO-GO 结论、WebRTC 依赖选择、共享核心边界建议和实测证据。任一门失败不得以“后面再修”为由进入
全面 UI 重写。

### Phase 1：Apple 客户端核心与 macOS Foundation（3–5 工程周）

另立 foundation plan，冻结共享 Swift core 物理边界和 public API；iOS 消费共享核心且回归不退化；
macOS App 可登录、持久化 token、接收快照/增量、显示基础设备/项目状态；建立 macOS CI、日志与
native build version。该阶段不追求完整工作台。

### Phase 2：DeviceRouter 与远端能力 parity（5–8 工程周）

另立 transport plan，补齐 loopback direct、P2P、relay 竞争/promotion、pair/grant/lease、心跳/判死、
session/elevated lanes、exactly-once 输入、prepared operation、`fsList/fsRead/fsWrite/exec/ports`。
所有 transport 共享同一业务帧与状态机语义，并有 deterministic 单测与 Rust worker 黑盒互通。

该阶段必须消费 plan 076 的 16 KiB 分片、DTLS role、candidate 枚举等结论，以及 plan 080 已暴露的
控制面静默死亡/数据面连坐问题；不得复制已知缺陷。若 plan 080 的授权收敛语义仍未定，先另立
superseding contract plan，不能让 macOS 自创第三套答案。

### Phase 3：桌面工作台与核心任务流（5–7 工程周）

另立 UI plan，完成高密度侧栏、设备/项目/工作区层级、选择与持久化、右键菜单、重命名/删除、
项目导入、workspace 创建、分支/worktree、乐观态、orphan session、Agent 状态、全局快捷键、空态/
错误态。布局和交互对齐 `docs/design-guidelines.md`，但采用 macOS 原生菜单、焦点和辅助功能。

### Phase 4：终端工作台与恢复契约（3–5 工程周）

另立 terminal plan，完成多 Tab、inactive terminal 保活、attach/resume/snapshot、holder/force takeover、
输入/resize、OSC 标题/链接、搜索/选区、鼠标/键盘协议、中文 IME、图片粘贴压缩、文件拖放上传、
窗口/屏幕切换后的 resize。以 Phase 0 fixture 扩充为长期回归门。

### Phase 5：Git/diff、预览与桌面完整性（3–4 工程周）

另立 workflow plan，完成 changes 视图、merge-base、untracked 文件、统一 diff 解析、语法高亮、
大 diff 虚拟化与取消、端口列表和默认浏览器预览、安装/授权浏览器 handoff。此阶段结束后才可宣称
Web 桌面功能完整覆盖。

### Phase 6：分发、更新与生产质量门（3–4 工程周）

另立 release plan，完成 universal `.app`、DMG、Hardened Runtime、签名、公证/staple、Sparkle feed、
更新失败回滚、版本准入、macOS CI、依赖 SBOM/checksum、崩溃与连接可观测性。日志不得记录 token、
私钥或终端内容。

### Phase 7：Beta、默认切换与回退（1–2 工程周 + 观察期）

内部 → 邀请 Beta → 默认推荐分批推进；至少覆盖 Apple Silicon/Intel、单/双显示器、中英文 IME、
同机 daemon、异地 relay/P2P、Web/native 同时 attach。回退方案始终是停用 native 推荐/相关 feature
flag 并回到 Web，不以不可逆 server 数据迁移绑死客户端发布。

### 投入区间

| 阶段 | 粗略工程量 |
| --- | ---: |
| Phase 0 风险门 | 2–3 周 |
| Phase 1 Foundation | 3–5 周 |
| Phase 2 Router parity | 5–8 周 |
| Phase 3 工作台 | 5–7 周 |
| Phase 4 终端 | 3–5 周 |
| Phase 5 Git/diff/预览 | 3–4 周 |
| Phase 6 发布质量 | 3–4 周 |
| Phase 7 rollout | 1–2 周 |

毛量约 25–38 工程周；扣除 foundation 后可安全并行的 UI/transport 工作，项目净估算为 22–30 工程周。
一名熟悉 Swift/macOS 的主力约 5–7 个月；两名工程师在契约冻结后约 3–4.5 个月。估算不包含 Web
新增功能持续追赶造成的 scope 增量。

## Risk register

| ID | 风险 | 等级 | 证据/触发器 | 缓解与退出条件 |
| --- | --- | --- | --- | --- |
| R1 | Swift Router 漏掉 Web 的竞速、generation、恢复或 exactly-once 边界 | CRITICAL | Web Router 约 2,968 行；Swift 当前明确为 relay 子集 | 先冻结行为表，移植确定性测试，再做跨栈黑盒；没有 direct/P2P/relay promotion 证据不得 parity |
| R2 | daemon ANSI snapshot 在 SwiftTerm 恢复不等价 | CRITICAL | 当前 oracle 只有 xterm：`docs/architecture.md:198-200` | plan 083 用同一 Claude/Codex/Vim fixture 比 cell/mode；关键差异无法在合理 fork 内修正则 STOP |
| R3 | libwebrtc 依赖体积、许可、符号或 macOS 架构不可接受 | HIGH | Apple 无第一方 API；候选是预编译二进制 | pin tag/checksum、记录 license/SBOM、优先可复现自建；失败时评估 Rust core，不静默换不明 binary |
| R4 | native Origin/P-256 身份复用削弱本机授权模型 | HIGH | server 强校验 WS Origin：`local-control.ts:99-108` | 走威胁模型评审和真实 loopback 测试；需要协议变化则单独 plan，禁止放宽校验赶进度 |
| R5 | Web 与 Swift 两份客户端长期语义漂移 | HIGH | TS/Swift Router 已是两份实现 | 共享 proto + fixture + conformance 测试；协议/行为变更 PR 必须同时列出 Web/Swift 影响 |
| R6 | 复制 plan 080 已知静默死亡/连坐缺陷 | CRITICAL | `plans/080-p2p-failure-fallback.md` 仍 PARTIAL | native transport 出厂即有独立 liveness/退避测试；授权语义未定前不进入生产 rollout |
| R7 | SwiftUI 在高密度侧栏/大 diff/高频 PTY 输出下抖动或占 CPU | HIGH | Web 有大量保活、虚拟化与 resize landmine | 允许 AppKit/TextKit 降级；建立 10k 行 diff、持续 PTY、20 Tab 性能门，不强守纯 SwiftUI |
| R8 | 版本准入与自动更新不完整导致 native 僵尸客户端 | HIGH | iOS 当前 `buildID = "dev"`；CI 不构建 App | Phase 1 即建立 native version，Phase 6 做更新/回滚/旧版拒绝；不把版本治理拖到发布当天 |
| R9 | Web 与 native 同时 attach 导致 holder 抖动、误停 session | HIGH | holder/force takeover 是单所有者语义 | 双客户端矩阵覆盖 attach/detach/force/stop；后台窗口不得持续抢 holder |
| R10 | 原生化范围吞入 iOS UI、mobile 或 daemon 重构 | MED | 同仓库多端、共享协议耦合 | 每阶段列 out-of-scope；`apps/mobile` 冻结；server/worker 变化另立契约 plan |
| R11 | 第三方二进制供应链风险 | HIGH | libwebrtc XCFramework 为外部二进制 | checksum、来源固定、构建说明、许可证、签名和 SBOM；依赖更新走专门兼容矩阵 |
| R12 | “高度复刻”被执行成逐像素抄 Web，牺牲原生体验和可访问性 | MED | 终端/控件渲染引擎不同 | 以功能/语义和 design token 验收；菜单、焦点、VoiceOver、Reduce Motion 按 macOS 规范验收 |

## Landmines

- **snapshot 不是 raw byte replay**：daemon 重建的是当前 VT/history 的 ANSI 表示；SwiftTerm 即使实时
  输出正常，也可能只在断线重挂时失败。必须分别测 raw、snapshot、snapshot+tail。
- **16 KiB 是跨栈硬边界**：`packages/protocol/src/index.ts:57` 与
  `crates/protocol/src/lib.rs:68` 记录 webrtc-rs 接收上限；native libwebrtc 不能直接按其更大的默认
  message 上限发送。
- **Web Router 的 relay 先赢、P2P 后 promotion 是有意体验设计**：
  `packages/client/src/device-router.ts:1237-1254`。native 若简单“先等 P2P，失败再 relay”，会把每次
  建连延迟暴露给用户，虽能用但不等价。
- **local pair 的 Origin 同时绑定控制 WS 与 loopback gateway**：只让其中一条 WS 带 Origin 不够；
  `apps/server/src/local-control.ts:104-105,401-404`。
- **inactive terminal 不能卸载**：Web 用 display 隐藏保留 scrollback/选区：
  `apps/web/src/components/workbench/terminal-pane.tsx:447-450`。SwiftUI 的条件视图若销毁 NSView 会复现
  同类问题。
- **consumer 必须先注册再 attach**：否则 replay/snapshot 字节可在 UI consumer 建立前丢失：
  `terminal-pane.tsx:421-434`。
- **输入只在 active + owned 时发送**：`terminal-pane.tsx:269-276`。焦点与 holder 是两个条件，不能
  用“当前 Tab”代替授权状态。
- **图片与文件上限不同**：图片主动压到 3.5 MB，普通上传允许 30 MB：
  `terminal-pane.tsx:38-42,279-376`。原生实现不能只留一个统一上限。
- **SwiftTerm Metal 是实验路径**：CoreText 基线通过前不要用 Metal 性能掩盖语义/窗口问题。
- **现有 P2P 自身仍有生产尾项**：`docs/ROADMAP.md:68-72` 记录 STUN、真实打洞成功率与浏览器/iOS
  矩阵未完全闭合；native 不能把“Web 已上线”误读为所有网络条件已经证明。
- **CI 现状不覆盖 Apple App**：新增 macOS job 不能只做 archive；还要跑共享 core、SwiftTerm fixture、
  universal 架构和签名后验证。
- **协议生成 `clean: true`**：若 native identity 需要改 proto，`buf generate` 会重建 TS/Rust/Swift
  三处产物；大面积无关 diff 必须 STOP。

## Scope

Program in scope:

- `apps/macos/**`（新增真正的 macOS App）
- `apps/ios/Coflux/Client/**`、`apps/ios/CofluxTests/**`（共享核心抽取与回归所需）
- 由 foundation plan 冻结的共享 Swift client core 路径
- `proto/gen/swift/**`、必要时 `proto/buf.gen.yaml` 与协议 IDL/gen 产物
- `packages/client/src/**`（行为 oracle、fixture 或确有必要的跨实现契约测试；不为 native 改写 TS）
- `crates/protocol/**`、`crates/worker/**`、`apps/server/**`（仅当另立的协议/兼容 plan 明确授权）
- `tests/src/**` 与终端录制 fixture（跨栈黑盒）
- `.github/workflows/**`、macOS 打包/签名/更新配置
- `docs/architecture.md`、`docs/ROADMAP.md`、`docs/RELEASING.md`、`docs/design-guidelines.md`
- `apps/web` 中仅限原生下载/授权/预览 handoff 与 rollout 提示；Web 工作台继续维护

Program out of scope:

- Electron、Tauri、WKWebView 主 UI、Catalyst、JS runtime — 与需求冲突
- 删除或冻结 `apps/web` — 它是伴生入口和 fallback
- `apps/mobile` 新功能 — 已冻结，只允许共享协议破坏构建时的最小修复
- iOS UI 功能扩张或把桌面新功能同步到移动端 — 共享 core 回归不等于同步 UI
- Windows/Linux 原生客户端 — 该路线若立项会重新影响 Swift vs Rust core 决策
- Mac App Store 首发 — 首发走 Developer ID 直接分发
- 终端字体/控件逐像素等同浏览器 — 不属于功能正确性
- 借原生化重构 server 数据模型、daemon/sessiond 或认证体系 — 另立 plan
- iOS 语音输入等非 Web 桌面能力 — 不属于本次 parity 范围

## Commands

每个阶段只运行其相关子集；最终集成门必须全部通过。运行环境型/人工项标记为 acceptance。

| Purpose | Command | Expected result |
| --- | --- | --- |
| macOS build/test | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS'` | exit 0 |
| iOS shared-core regression | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | exit 0；环境 probe 可显式 skip，其余全过 |
| server 类型检查（若触及） | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查（若触及） | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Rust protocol 单测（若触及） | `cargo test -p coflux-protocol` | exit 0 零警告 |
| daemon 构建（若触及） | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 零警告 |
| 黑盒集成 (acceptance) | `pnpm -C tests test` | 真实进程/临时 DB 拓扑全绿；既有环境基线必须单独记录，不得把新失败归为基线 |
| native 两机网络矩阵 (acceptance) | Apple Silicon + Intel、同机 loopback + 异地 P2P/relay、Web/native 双客户端 | direct/P2P/relay 路径、fallback、holder 与恢复均符合契约 |
| UI/IME/Accessibility 走查 (acceptance) | 中英文输入法、键盘全操作、VoiceOver、Reduce Motion、双显示器/缩放切换 | 无阻断缺陷 |
| 签名/公证/更新 (acceptance) | GitHub macOS release workflow 产出并在干净机器安装、升级、回退 | Gatekeeper 通过；更新失败可恢复；旧版提示可读 |

## Program done criteria

- [ ] plan 083 三项门禁全部通过，或 CONDITIONAL GO 的替代架构已由用户明确批准并另立 plan。
- [ ] macOS App 覆盖“功能覆盖矩阵”全部硬要求；任何延期项有用户批准且不得仍宣称完整 parity。
- [ ] direct、P2P、relay 都有确定性状态机测试和真实 Rust worker 跨栈验收，含 fallback/promotion。
- [ ] Claude/Codex/Vim fixture 的 raw、snapshot、snapshot+tail 在 SwiftTerm 通过约定的 cell/mode 契约。
- [ ] iOS 继续消费共享 Swift core，现有非环境测试全过；`apps/mobile` 无功能性改动。
- [ ] Web/native 并存的 attach、force takeover、stop、后台保活不会相互抖动或误杀 session。
- [ ] 原生版本准入、自动更新、签名、公证、回退和 macOS CI 全部可重复运行。
- [ ] Web 的授权、端口预览、安装和 fallback 入口仍可用，原生 App 内无 WebView 主 UI。
- [ ] 性能门覆盖持续 PTY 输出、20 个保活 Tab、10k 行 diff、窗口 resize/跨屏；无不可接受卡顿或泄漏。
- [ ] 所有子 plan 遵守本 plan 的 Decisions & tradeoffs，偏离均有用户批准和决策记录。
- [ ] `docs/architecture.md`、`docs/ROADMAP.md`、`docs/RELEASING.md` 与实际终态一致。
- [ ] `plans/README.md` 的子计划状态、依赖与 rollout 结果已更新。

## STOP conditions

- plan 083 任一关键门失败，且修复需要 fork SwiftTerm/libwebrtc 或新增 Rust core，但尚未获得用户对成本与
  长期维护的批准。
- Decisions 引用的事实漂移，例如 P2P 协议、snapshot 契约、Web 功能面或现有 Swift Router 已发生
  实质变化；先更新本 plan，不按旧结论执行。
- native Origin/identity 只有通过放宽 server/daemon 授权校验才能跑通。
- 需要把 WebView/Electron/Tauri 作为主 UI 才能满足范围。
- 子阶段需要同时大改共享 core、server、worker、Web UI 且没有先冻结契约；拆成串行 contract plan。
- plan 080 暴露的控制面/数据面授权与存活语义仍冲突，native 实现者只能“任选一套”。
- 某阶段验证经一次合理修复后仍连续失败两次，或只能通过删除/弱化测试变绿。
- 需要触及 `apps/mobile` 功能、iOS UI 或与本项目无关的大重构。
- 预计净工程量相对本估算增加超过 40%，但范围/依赖变化尚未重新评审。

## Maintenance notes

- 本 plan 的“完整 parity”基线固定在 `8d702d2`。执行期间 Web 继续迭代时，新功能默认不自动纳入；
  产品负责人需明确归入首发、后续，或 Web-only，防止追赶移动目标使 native 永远无法完成。
- Swift core 抽取是为了减少行为实现份数，不是为了强行共享所有平台代码。任何 `#if os(...)` 大量
  渗入核心的趋势都说明边界选错。
- 引入 libwebrtc 后，升级 Chromium milestone 是安全/兼容工作，不是普通依赖 bump；必须复跑
  webrtc-rs 互通、16 KiB 分片、ICE/DTLS 和 universal 架构矩阵。
- 不记录终端正文用于遥测。可观测字段限连接阶段、route kind、relay host、RTT、generation、错误码、
  build/version 和耗时，并按现有日志脱敏约定处理。
- 如果未来确定做 Windows/Linux 原生客户端，先重开“Swift core vs Rust core”决策；不要在 macOS
  工程完成后悄悄叠第三份 Router。
- 原生 App 的价值不只是“看起来像 Web”：菜单、快捷键、拖放、焦点、窗口恢复、VoiceOver 和系统
  浏览器 handoff 都是产品完成度的一部分。
