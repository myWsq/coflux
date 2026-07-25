# Plan 044: iOS app 第一片 —— apps/ios 工程骨架 + Swift 客户端层 + 登录跑通

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat d73c74f..HEAD -- packages/client/src/connection.ts packages/client/src/store.ts apps/mobile/src/lib/auth.ts apps/server/src/hub.ts proto/coflux/v1/client.proto proto/buf.gen.yaml proto/gen/swift`

## Status

- Priority: P1
- Effort: L
- Risk: MED（首个 iOS 工程：手工创建 xcodeproj、首次消费 swift 生成产物、新 WS API）
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `d73c74f`, 2026-07-25

## Requirement

原生 iOS app（产品定位与 web 相同：Agent 指挥中心）的第一片。本片完成后：

1. `apps/ios/` 存在可构建的全原生 Swift 工程（`Coflux.xcodeproj` 直接提交）；
2. Swift 客户端**控制面层**成立：连 `/client` WS、认证（Supabase 换票 / 用户名密码 /
   clientToken 重连）、接收 stateSnapshot 与实体增量并归约为可观察状态；
3. 在模拟器上对本机 dev server 完成登录，看到项目分组的工作区/设备/任务列表
   （朴素验证 UI，最终视觉设计不在本片）。

不做（后续片）：终端渲染与交互（SwiftTerm）、PTY 数据面（device-router 的
direct/relay、attach/接管、checkpoint）、diff 查看、推送、App Store/TestFlight。

正确解与相邻错误解的分界：错误解是把 `packages/client` 逐行翻译成 Swift（含
device-router、localSessions、checkpoint 等 PTY 域逻辑）；正确解是只移植控制面
子集（见 Decisions），PTY 域完全留白，但归约器的**语义**（原子提交、按到达顺序
应用、authOk 后 subscribe、token 生命周期）与 TS 版严格一致。

**环境前置（用户动作，执行者无法代劳）**：本机（macOS 27）需安装 App Store 当前
最新 Xcode（须支持 iOS 27 真机——用户手机为 iOS 27），
`sudo xcode-select -s /Applications/Xcode.app` 切换 developer directory，首次启动
接受许可并下载 iOS 平台（含模拟器 runtime）。当前本机 `xcodebuild` 指向
CommandLineTools，未装 Xcode——执行前置未满足即 STOP。

## Decisions & tradeoffs

- **全原生 Swift 6.2 + SwiftUI + vanilla `@Observable`**，保持 Xcode 26 新工程默认的
  MainActor default isolation + approachable concurrency 设置。
  【执行偏离 2026-07-25】`SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor` 使 buf 生成的
  pb.swift 类型隔离进 MainActor、打破 Sendable/Message conformance（编译失败，
  生成代码无 nonisolated 标注），故不设该项，app 代码显式标 `@MainActor`；
  approachable concurrency 保留。备选「proto 拆独立 nonisolated target」因结构成本
  被拒。Rejected: TCA——单人
  项目学习成本无回报；WKWebView 包壳——违背「体验全面升级」的立项动机（2026-07-25
  三路调研定稿，见 `docs/ROADMAP.md:65-70` 原 macOS 调研与本计划的更新）。
- **部署目标 iOS 26，iPhone-only**。用户手机为 iOS 27（2026-07），26 目标在其上
  直接运行，且本片不涉及 iOS 27 独有 API——定 26 让 Xcode 26/27 均可构建。自用
  真机无兼容负担。Rejected: iOS 17/18 下限——没有要照顾的第二台设备；追 27——
  无 API 需求，白白抬高构建工具链要求。
- **工程形态：单 app target + 单元测试 target，`Coflux.xcodeproj` 直接提交，用
  filesystem-synchronized groups（buildable folders）**。不拆本地 SPM package（第二片
  再评估；若拆，须手动开 MainActor default isolation + approachable concurrency 两个
  flag，package 默认不继承）。Rejected: Tuist/XcodeGen——Xcode 26 buildable folders
  已消解 pbxproj 冲突，单人项目引工具是负熵。pbxproj 由执行者手工编写（synchronized
  groups 形态下很小），`xcodebuild` 两次修复仍不过则 STOP（fallback：用户 GUI 建模板）。
- **第三方依赖仅一个：`apple/swift-protobuf`（runtime ≥ 1.37.0，与生成产物同源）**。
  生成产物 `proto/gen/swift/coflux/v1/*.pb.swift` 以 buildable folder 引用挂进 target，
  **不复制不手改**（CI 零 diff 门禁：`.github/workflows/ci.yml:51`；生成配置
  `proto/buf.gen.yaml`，`Visibility=Public`）。Rejected: 把生成文件拷进 apps/ios——
  与真相源脱钩。
- **不引 supabase-swift**。登录 = 一个 URLSession POST
  `${SUPABASE_URL}/auth/v1/token?grant_type=password`（对照
  `apps/mobile/src/lib/auth.ts:7-24`，23 行 fetch），拿 `access_token` 后经 WS
  `clientAuth.supabaseToken` 换票；Supabase session 不持久化不刷新（换票架构，
  `proto/coflux/v1/client.proto:13`）。Rejected: supabase-swift 仅 Auth product——
  为一个 POST 引整包，且其 session 管理在换票架构下无用武之地。
- **WebSocket 用 Network.framework，封装在 actor + AsyncStream 之后**：优先 iOS 26 新
  `NetworkConnection` API（结构化并发原生）；若文档/行为受阻，退
  `NWConnection + NWProtocolWebSocketMetadata`——封装边界隔离，上层归约器不感知切换。
  Rejected: `URLSessionWebSocketTask`——close code 不可靠（~5-7% 变 1006）、无背压，
  Apple DTS 明确建议严肃长连场景用 Network.framework；Starscream——iOS 12 兼容场景
  遗产。
- **客户端层移植范围 = 控制面子集**（参照 `packages/client/src/connection.ts` 全部 +
  `packages/client/src/store.ts` 的实体归约分支）：认证三凭证（`clientAuth` 的
  supabaseToken / username+password / clientToken 重连，`connection.ts:31-37`）、指数
  退避重连（~1s 起步 ~15s 封顶 + 抖动，认证成功重置，`connection.ts:56-68`）、消息
  处理含 authOk / authError / clientOutdated / stateSnapshot / daemonUpdated /
  daemonRemoved / projectCreated / projectRemoved / workspaceCreated /
  workspaceRemoved / taskUpdated / taskRemoved / error，authOk 后立即发
  `clientSubscribe`（`store.ts:337`）。**不移植**：device-router 全部、
  localSessions/catalog、sessionCheckpoint、ports、inputStates、pendingTaskRemovals——
  第一片无 PTY 域，`stateSnapshot`/`taskUpdated` 直接采信 server 事实（web 版与
  localSessions 的合并逻辑 `store.ts:376-384` 在本片没有对应物，跳过是刻意的）。
- **`clientVersion` 上报固定 `"dev"`**。生产 server 版本准入的允许集合从 web/mobile
  dist 产物自举（`apps/server/src/hub.ts:1397-1409`），iOS 构建号不在集合内会被
  `clientOutdated` 踢出（`hub.ts:1476-1485`）；`"dev"` 是唯一无条件放行通道
  （`hub.ts:1464`）。web 的 clientOutdated 语义是 reload 拿新 bundle，对原生 app
  不成立。ponytail: 原生版本准入（最低版本强制升级提示）后续另立 plan；本片收到
  clientOutdated 时防御性处理——展示「客户端版本不兼容」并停止重连，不清 token。
- **token 生命周期与 TS 版严格一致**：authOk 回带 `clientToken` 时持久化并用于此后
  重连（`store.ts:333-336`）；authError 清 token、停止自动重连、退回登录页
  （`store.ts:341-351`，否则退避循环打服务器）；登出清 token 断连。持久化用**裸
  Security framework Keychain 封装（~50 行）**，`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`。
  Rejected: KeychainAccess/Valet 等库——单条 token 不值一个依赖；UserDefaults——
  凭证不落非加密存储。
- **后台生命周期**：`scenePhase` 进 `.background` 主动断连并取消重连计时器；回
  `.active` 无条件废弃旧连接重建（不探测旧 socket 活性，系统超时可达分钟级）。iOS
  不保证后台 WS 存活，会话韧性本就在 server/daemon 侧（sessiond + snapshot 恢复），
  客户端只做无脑重连。
- **服务端地址与 Supabase 常量为编译期配置**：默认生产
  `wss://api.coflux.dev/client`；Debug 构建可覆盖为本机 dev server（形式执行者定：
  scheme 环境变量或 Debug-only 设置项）。Supabase 生产 URL/anon key 不在 repo
  （web 部署时注入），代码留具名常量占位，真机验收时由用户填入（anon key 非密，
  可提交）。本机 dev server（`COFLUX_DEV=1`）走 local 模式用户名密码登录，不需要
  Supabase 值。
- **登录 UI 双模式与 web 对齐** (decided while planning)：server 是 supabase 模式还是
  local 模式由部署决定（`hub.ts:1429-1446` 三条互斥路径），客户端无从探测——与
  web 同样用编译期配置决定表单语义（生产=邮箱密码走换票；本机 dev=用户名密码直发）。
- **测试用 Swift Testing**：归约器（合成 protobuf 消息 → 断言状态）与认证/token
  状态机（WS 层抽协议注入 fake transport）为最小测试面。Rejected: XCTest——新代码
  一律 Swift Testing；UI 测试——本片验证 UI 是临时物。

## Direction

分层与 `packages/client` 同构：传输 actor（WS + 指数退避）→ 消息归约（`@Observable`
状态容器，每消息一次原子提交、按到达顺序应用不做乱序缓冲，`store.ts:320-322`）→
SwiftUI 视图订阅。protobuf 信封 encode/decode 对应 TS 的
`encodeClientToServer`/`decodeServerToClient`（oneof payload，
`proto/coflux/v1/client.proto:115-249`）。

### Milestone 1: 工程骨架可构建

`apps/ios/Coflux.xcodeproj` + app target（空壳 SwiftUI app）+ 测试 target；
swift-protobuf SPM 依赖解析成功；`proto/gen/swift` 挂入并参与编译。
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` → exit 0。

### Milestone 2: Swift 客户端层 + 单测

传输 actor、认证/token 状态机、Keychain 封装、控制面归约器完成；Swift Testing
覆盖归约与认证状态转移（含 authError 清 token 停重连、authOk 持久化 clientToken、
clientOutdated 防御分支）。
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<执行时 xcrun simctl list 选可用 iPhone 机型>' test` → exit 0。

### Milestone 3: 登录与实体列表（验证 UI）

登录页（编译期模式决定表单）→ 登录后项目分组的工作区列表 + 设备在线/任务状态、
连接状态提示（connecting/disconnected 横幅语义对照 web：断线保留最后快照展示，
`store.ts:517-519`）；scenePhase 断连/重连接线完成。
Validation: 同 Milestone 2 两条命令 → exit 0（实际登录属 acceptance）。

## Landmines

- **本机未装 Xcode**：`xcodebuild` 现指向 `/Library/Developer/CommandLineTools`。
  环境前置未满足即 STOP，这不是执行者能修的。
- **版本准入踢新客户端**（`apps/server/src/hub.ts:1459-1486`）：iOS 不上报 `"dev"`
  会在生产被 `clientOutdated` 踢出且现象像「连不上」；本机 dev（无
  COFLUX_BUILD_ID*）不拦，问题只在生产暴露。
- **authError 后必须停重连**（`packages/client/src/store.ts:341-351`）：token 已被
  server 侧视为无效，继续退避重连=凭证风暴；TS 版靠 `shouldRetry=false` +
  `reconnectCredential()` 返回 null 双闸。
- **换新连接前先关旧 socket**（`packages/client/src/connection.ts:75-77`）：否则旧
  连接在 server 侧成为只收不发的幽灵连接。NWConnection/NetworkConnection 同理，
  重建前显式 cancel。
- **protobuf 内嵌 message 的显式 presence**（`store.ts:399` 的防御模式）：TS 侧
  `T | undefined`，swift-protobuf 侧对应 `hasXxx`——服务端必填字段缺失按畸形消息
  丢弃该条，不 crash 不猜默认值。
- **`snapshotRevision` 每次 stateSnapshot 自增**（`store.ts:392`）：本片就要带上
  ——第二片终端 re-attach 依赖它判定重连边界，落下会导致第二片改归约器。
- **`proto/gen/swift` 是生成产物**：CI 零 diff 门禁（`.github/workflows/ci.yml:51`），
  手改必挂 CI；缺类型去改 `proto/` 真相源属于 out-of-scope，STOP 汇报。
- **模拟器无 Keychain 差异陷阱**：模拟器 Keychain 行为与真机有差异（无 Secure
  Enclave、entitlement 宽松），封装保持最朴素的 kSecClassGenericPassword 用法即可，
  勿引入 access group / 同步属性。

## Scope

In scope:

- `apps/ios/**`（新建）
- `plans/README.md`（状态登记）

Out of scope:

- `apps/server`、`apps/web`、`apps/mobile`、`packages/*`、`crates/*` —— 一概不动；
  尤其**不为 iOS 加 server 侧 build-id 通道**（本片用 `"dev"`，原生版本准入另立 plan）
- `proto/**` —— 真相源与生成产物均不动；发现类型缺口 STOP 汇报
- 终端/PTY 域（SwiftTerm、device-router 移植、attach/接管）—— 第二片
- 真机签名配置（DEVELOPMENT_TEAM）—— 验收时用户在 Xcode 里选自动签名，不提交
  team 常量

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 单测 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<可用 iPhone 模拟器>' test` | exit 0 |
| 模拟器登录闭环 (acceptance) | 本机起 `pnpm dev:server`（DATABASE_URL 指 54322 直连口）+ 模拟器跑 app，Debug 配置指向 `ws://127.0.0.1:8787/client`，用户名密码登录 | 登录成功，工作区/设备/任务列表随 dev daemon 状态变化 |
| 真机生产登录 (acceptance) | 用户填入生产 Supabase 常量，Xcode 真机 run，邮箱密码登录 api.coflux.dev | 登录成功看到生产实体；进后台回前台自动重连 |

## Done criteria

- [ ] 构建与单测命令均 exit 0。
- [ ] 模拟器 acceptance 闭环可用：登录 → 实体列表 → 断 server 出横幅 → 重启 server 自动重连恢复。
- [ ] 归约器与认证状态机的 Swift Testing 用例存在且断言有意义行为（非空跑）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Xcode（26+）未安装或 `xcodebuild -version` 失败（环境前置未满足，属用户动作）。
- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（含 proto 类型缺口、server 改动）。
- pbxproj 手工编写经两次修复 `xcodebuild` 仍失败（fallback：用户 GUI 建空模板后续跑）。
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- `clientVersion="dev"` 是刻意的 ponytail ceiling：原生 app 的版本准入应是「最低
  版本强制升级提示」而非 web 的 reload 语义，待 TestFlight/分发形态明确后另立 plan。
- 控制面归约器刻意留了 PTY 域空位（localSessions/checkpoint/inputStates 未移植）：
  第二片扩展时以 `packages/client/src/store.ts` 为语义基准，勿在第一片结构上即兴
  发明新形态。
- Supabase 生产常量占位在代码里具名标注；换 Supabase 项目/轮换 anon key 时改这一处。
- 若未来拆本地 SPM package，记得给 package 手动开 MainActor default isolation +
  approachable concurrency（Xcode 26 只给 app target 默认开）。
