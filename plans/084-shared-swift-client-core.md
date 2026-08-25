# Plan 084: 唯一共享 Swift Client Core——协议模块化、控制面契约与 iOS 无退化迁移

> 本 plan 是结果契约，不是逐步脚本。理解需求与已定决策后，对照活代码自行设计实现；执行者在每个
> 里程碑后运行快速验证并提交，命中 STOP 条件即停。完成后更新本 plan 与 `plans/README.md`。
>
> Drift check: `git diff --stat 5942465..HEAD -- proto/buf.gen.yaml proto/gen/swift/ packages/swift-client/ apps/ios/Coflux/ apps/ios/CofluxTests/ apps/ios/Coflux.xcodeproj/ docs/ROADMAP.md`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: `plans/083-macos-native-client-feasibility-gates.md`
- Category: refactor
- Execution: self-execution（沿用 plan 082 departure check）
- Planned at: `5942465`, 2026-08-25
- Outcome: DONE（`a402d90` / `0923ddd` / `00e5c7a`）

### 执行结果（2026-08-26）

- Milestone 1：`a402d90` 建立 `packages/swift-client` 唯一物理边界与
  `CofluxProtocol` / `CofluxClientCore` / `CofluxApplePlatform` 三产品；Swift protobuf 只生成到
  `CofluxProtocol/Generated`，SwiftProtobuf 精确固定 `1.38.1`。
- Milestone 2：`0923ddd` 迁移唯一控制面与 relay Router，实现并测试首握手重连、generation 隔离、
  控制帧串行、10 秒 outbound watchdog、三维状态、完整快照替换/增量/级联清理、TokenStore 错误可见及
  terminal auth fail-closed。共享包最终为 41 个 Swift Testing 用例 + 3 个 XCTest 全过。
- Milestone 3–4：`00e5c7a` 将 iOS App/Test 切到 repo-local package，删除 App 内旧
  Client/Router/Wire/Transport/Keychain 与重复 reducer/router/auth 测试；App 保留原
  `dev.coflux.Coflux` / `clientToken` namespace 和显式 `buildID = "dev"`，首次 snapshot 前显示同步态，
  重连保留已有快照。hosted XCTest 通过 TestAction 专属环境注入空 TokenStore，避免测试启动 App 时读取、
  使用或清除正式 token；Keychain roundtrip 使用随机 service/account。
- 验收：Buf lint/generate 零漂移；package 44/44；Rust protocol 26/26；iOS generic simulator build
  通过；iOS 全量测试 5 过、2 个既有环境 probe 按契约 skip；core 平台 import、旧实现/ProtoGen/直接
  SwiftProtobuf、scope 与 diff hygiene 扫描均通过。两轮独立复审发现并关闭测试 target 冗余 Protocol
  依赖与 hosted-test 正式 Keychain 污染风险，最终均 APPROVE。
- 本 plan 没有修改 `apps/mobile`、server、worker、Web 或生产部署。LAN/TCC、Intel、macOS 14 实机与
  Developer ID 发布矩阵仍按 plan 082 保留为 Phase 6–7 发布资格门，本结果不代表这些后置门已通过。

## Requirement

建立 iOS/macOS 唯一消费的 repo-local Swift Package，结束 Swift protobuf 与客户端状态机由各 App target
直接编译或复制的形态。完成后：

- Swift protobuf 只有一个生成与编译真相侧；
- 认证、连接、重连、控制面 reducer 和现有 relay DeviceRouter 只有一份 Swift 实现；
- iOS 改为通过 public module API 消费共享核心，现有 UI、终端、上传和设备面板行为不退化；
- 平台 WebSocket、Keychain、Bundle/config 和 UI 生命周期通过小接口注入，core 可在 macOS 14 编译；
- Foundation 修掉已确认的首握手不重连、控制帧发送无保序、Keychain 错误静默与“未收快照=空账号”漂移。

相邻错误解包括：复制一份 macOS `CofluxClient`、让 package import SwiftUI/UIKit/AppKit/SwiftTerm/
WebRTC、继续硬编码 `buildID = "dev"`、把 iOS 26 `NetworkConnection<WebSocket>` 编入 macOS 14 core，
或在 Phase 1 就把当前 relay-only Router API 冻结成未来 direct/P2P 公共契约。

## Decisions & tradeoffs

- **唯一物理边界固定为 `packages/swift-client`**，产品为 `CofluxProtocol`、`CofluxClientCore` 与
  `CofluxApplePlatform`。Rejected: 两个 Xcode 工程各自添加同一批 source path——没有独立模块/API
  边界，仍会出现编译设置与依赖漂移。Based on: `apps/ios/Coflux/Client/CofluxClient.swift:1-37`、
  `apps/macos/project.yml:47-58`。

- **Swift protobuf 移入 `CofluxProtocol/Generated`，Buf 的 `clean: true` 只清专用 Generated 目录**。
  Rejected: 把 `Package.swift` 或手写 core 放在 Buf 输出目录——下一次生成会删除手写文件；Rejected:
  App/Test 继续直接编译 `proto/gen/swift`——会形成重复 module 真相侧。Based on:
  `proto/buf.gen.yaml:1-13`。

- **`CofluxClientCore` 只依赖 Foundation、Observation 和 `CofluxProtocol`**；SwiftTerm、Opus、WebRTC、
  Security、Network 与任何 UI framework 不得进入该 target。Rejected: 为迁移方便保留 concrete 默认
  依赖——现有 `NetworkTransport` 使用 iOS 26 API，无法满足 macOS 14。Based on:
  `apps/ios/Coflux/Client/Transport.swift:20-29`、`apps/macos/project.yml:5-6`。

- **现有 DeviceRouter 随 core 迁移但保持 package/internal，不冻结 Phase 2 public API**。
  `CofluxClient` 可继续用它维持 iOS 行为；macOS Foundation 只消费只读控制面。Rejected: 留在 iOS
  App——会让共享 facade 反向依赖 App；Rejected: 立即公开 direct/P2P API——当前实现明确是 relay-only
  子集，接口必然漂移。Based on: `apps/ios/Coflux/Client/DeviceRouter.swift:44-54`。

- **public 注入契约固定为显式 `ClientConfiguration`、`Transport`/`TransportConnection`、
  `TokenStore`、`ClientLogger`、clock/jitter source 与 build identity**；core 内不得读 `Bundle.main`、
  环境变量、Security、真实随机/时钟服务或平台日志。发送必须串行、`receive()` 同时只允许一个 waiter、
  `close()` 幂等。
  Rejected: 保留当前默认参数——它把包绑死到 iOS App composition root。Based on:
  `apps/ios/Coflux/Client/CofluxClient.swift:97-105`、`apps/ios/Coflux/Client/KeychainTokenStore.swift:9-14`。

- **外部状态明确区分 connection/auth/sync 三个维度**。首个 `StateSnapshot` 前是 loading，不渲染空账号；
  已认证掉线保留最后快照并显示 offline；重新订阅后的全量快照替换旧集合并递增 revision。为 iOS
  迁移可保留现有 `status`/`authState` 命名，但不能继续只靠二者猜同步状态。Rejected: 收到 AuthOk
  就把空数组当最终状态——会在冷启动制造错误空态。Based on:
  `packages/client/src/store.ts:423-449`、`apps/ios/Coflux/Client/CofluxClient.swift:323-331`。

- **认证/重连以 Web 的安全边界补齐现有 iOS 漂移**：存量 token 的首次 auth 前断线仍应退避重连；
  `AuthError` 清 token 并停重连，`ClientOutdated` 保留 token 并停重连；AuthOk 后订阅；有 outbound 后
  长时间无任何 inbound 的 socket 主动判死；旧 generation 不得污染新连接。Rejected: 原样搬现有文件——
  构造期 `shouldRetry = false` 会让首握手失败永久停住。Based on:
  `apps/ios/Coflux/Client/CofluxClient.swift:72-75,138-142,270-279`、
  `packages/client/src/connection.ts:90-112`。

- **控制帧发送必须有单一保序队列，不能每帧裸起独立 Task**。Rejected: 依赖当前 executor 调度“通常
  有序”——auth/subscribe/logout 与后续 operation 的因果顺序属于协议正确性。Based on:
  `apps/ios/Coflux/Client/CofluxClient.swift:566-568`、
  `apps/ios/Coflux/Client/DeviceRouter.swift:800-813`。

- **TokenStore 错误可观测且 service/account 显式注入**。密码永不持久化，只有 AuthOk 返回的新 token
  才写入；token-auth 的 AuthOk 没有新 token 时保留旧值。Rejected: 吞掉 Security OSStatus——UI 会把
  “重启后丢登录”伪装成成功。Based on: `apps/ios/Coflux/Client/KeychainTokenStore.swift:24-49`、
  `apps/server/src/hub.ts:1755-1777`。

- **build ID 由 App 显式注入，core 无默认值**。Debug composition 与当前 iOS 兼容 composition 可以
  明确传 `dev`，避免在 native 独立准入建立前破坏现有 iOS 发布；macOS Release provider 在 plan 085
  必须产生非空、非 `dev` 的 identity，Phase 6 再迁移 iOS 并建立独立 native 准入/升级文案。Rejected:
  把 `dev` 留在 core 内作为隐式全局绕过——正式 macOS 产物不可审计。Based on:
  `apps/ios/Coflux/Client/CofluxClient.swift:65-67,573`、
  `apps/server/src/hub.ts:1793-1807`。

- **Swift public API 只冻结 App 已消费的 facade/state/actions 与注入协议**；`Wire`、`apply`、raw callbacks
  和 Router 结构保持 internal/package。iOS 源码显式 import `CofluxProtocol` 和 `CofluxClientCore`，不使用
  `@_exported import`。Rejected: 为少改 import 暴露整个实现——会把 Phase 2 重构变成破坏性 API 迁移。

## Direction

### Milestone 1：可重复生成的 Swift Package 与协议真相侧

Package 能在 macOS 14+/iOS 26+ 语义下独立解析与编译；SwiftProtobuf runtime 精确 pin，现有 Buf
plugin 保持可审计 pin；四份生成文件只存在于 `CofluxProtocol/Generated`，TS/Rust 生成物无线格式漂移。

Milestone validation: `swift test --package-path packages/swift-client` → exit 0；
`cd proto && buf lint && buf generate` → exit 0，生成物无二次漂移。

### Milestone 2：共享控制面与 relay Router 契约

Core fake tests覆盖认证、首握手失败重连、退避/generation/watchdog、串行发送、同步状态、快照全替换、
daemon/project/workspace/task upsert 与级联删除、ports/checkpoint/sessionAgents、畸形 embedded message、
TokenStore 失败和 logout。现有 relay Router 的确定性测试迁入 package 并保持行为。

Milestone validation: `swift test --package-path packages/swift-client` → 所有 core/router 用例通过。

### Milestone 3：Apple adapter 与 iOS 唯一消费迁移

iOS concrete Network transport、Keychain/config composition 通过 `CofluxApplePlatform`/App root 注入；
App 和测试不再直接编译旧 Client 或 Swift protobuf。所有 UI 消费 public module，scene lifecycle 映射到
平台中立 suspend/resume；签名 host Keychain roundtrip 使用随机 service/account，不接触真实 token。

Milestone validation: `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator'` → exit 0。

### Milestone 4：iOS 无退化回归与边界审计

iOS 既有非环境测试全过；环境/音频 probe 只能按原契约 skip。共享 core 无 UI/终端/WebRTC import，
`apps/mobile`、server、worker、Web 与生产部署零改动。

Milestone validation: iOS Simulator 全量测试通过；静态边界扫描无禁用 import。

## Landmines

- iOS 工程使用 file-system synchronized groups；移走生成源码后必须同时移除 ProtoGen 构建成员和直接
  SwiftProtobuf product，不能留下同名类型双编译：`apps/ios/Coflux.xcodeproj/project.pbxproj:31-45,93-102`。
- Swift 6 并发设置不能只继承 iOS 的 Approachable Concurrency；package 在 macOS 独立编译时也必须
  对 `@MainActor`、`@unchecked Sendable` 和单 consumer 假设给出证据：
  `apps/ios/Coflux.xcodeproj/project.pbxproj:269-272`、`DeviceRouter.swift:88-100`。
- `ProjectCreated` / `WorkspaceCreated` 是 upsert，不是 append-only；重命名/default branch/diff 增量复用
  它们：`apps/server/src/hub.ts:1158-1185,1645-1658`。
- project 删除不得误删 `projectID == ""` 的目录工作区；protobuf 内嵌 message 缺失必须丢帧而非构造
  默认空对象。
- `buf generate` 为 clean 模式；输出目录若包含手写文件必须 STOP。
- Keychain 测试在 `CODE_SIGNING_ALLOWED=NO` 下会产生假失败，只能在签名 app host 验收。
- package 测试通过不代表 iOS UI 可编译；protobuf 离开 App module 后所有使用处都需显式 import。

## Scope

In scope:

- `packages/swift-client/**`
- `proto/buf.gen.yaml`、`proto/gen/swift/**`
- `apps/ios/Coflux/Client/**`、为 module import/composition 所需的 `apps/ios/Coflux/**/*.swift`
- `apps/ios/CofluxTests/**`
- `apps/ios/Coflux.xcodeproj/**`
- `docs/ROADMAP.md` 中“开发 GO 已允许 Foundation、发布矩阵仍后置”的最小同步
- `plans/084-shared-swift-client-core.md`、`plans/README.md`

Out of scope:

- `apps/macos/**` 产品 Foundation——plan 085 消费本 plan 的稳定模块
- `apps/server/**` 订阅窗口原子性——plan 086 单独修复与黑盒验收
- direct/loopback/P2P、pair/grant/lease 与 Router public API——Phase 2
- native 正式版本 allowlist、更新 URL、最低版本治理——Phase 6
- iOS UI 新功能、`apps/mobile`、Web/daemon 功能改动
- LAN/TCC、Intel、macOS 14 实机与 Developer ID 发布验收——Phase 6–7

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Package tests | `swift test --package-path packages/swift-client` | exit 0；core/router 全过 |
| Proto lint/generate | `cd proto && buf lint && buf generate` | exit 0；TS/Rust wire 无漂移，Swift 只落新 Generated 目录 |
| iOS build | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator'` | exit 0 |
| iOS regression (acceptance) | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | 非环境用例全过，环境 probe 按契约 skip |
| Core boundary | `rg -n 'import (UIKit|SwiftUI|AppKit|SwiftTerm|WebRTC|Security|Network)' packages/swift-client/Sources/CofluxClientCore` | 无输出 |
| Rust protocol guard | `cargo test -p coflux-protocol` | exit 0，零警告 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [x] 所有 listed commands 通过。
- [x] iOS 只通过同一 package 产品消费 Swift 协议与客户端核心；package 本身在 macOS 14 目标可编译。
  macOS App 的实际唯一消费由 plan 085 验收。
- [x] Core 无平台默认依赖、固定 `dev`、无序控制帧发送或未同步空态。
- [x] 存量 token 首次握手失败会重连；auth error/outdated/logout 的 token 与重连语义有负向测试。
- [x] reducer 覆盖完整 snapshot 和 Phase 1 所列增量/级联删除，畸形输入 fail closed。
- [x] iOS 现有非环境测试、终端、上传、设备面板与后台恢复行为不退化。
- [x] `apps/mobile`、server、worker、Web 和生产部署无改动。
- [x] `docs/ROADMAP.md` 不再错误声称 Foundation 被外部 LAN/发布矩阵阻塞，且未把后置门写成已通过。
- [x] `plans/README.md` 状态已更新。

## STOP conditions

- package 需要 import UI、SwiftTerm、WebRTC 或把 iOS 26 concrete Network API暴露给 macOS 14 core。
- 为迁移 iOS 必须公开当前 DeviceRouter 内部状态机或改变线协议。
- Buf 迁移产生 TS/Rust wire 格式变化，而不是纯 Swift 输出路径变化。
- iOS 既有业务测试在一次合理修复后仍连续失败两次，或只能删除/弱化测试变绿。
- 需要触及 `apps/mobile`、server/worker/Web 功能或 Phase 2 transport 才能完成。

## Maintenance notes

- 共享 package 是实现唯一性边界，不代表 macOS/iOS UI 或生命周期应趋同。
- 任何新增控制面消息都应同时更新 reducer fixture/测试；任何新增 platform import 先判断是否应留 adapter。
- Phase 2 可以重构 Router internals，但不得复制第二份 Swift Router；若未来做 Windows/Linux，再重开
  Swift core vs Rust core 决策。
