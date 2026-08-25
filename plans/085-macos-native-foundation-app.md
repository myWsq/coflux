# Plan 085: macOS 原生 Foundation App——真实登录、持久会话与基础只读工作台

> 本 plan 是结果契约，不是逐步脚本。先确认 plan 084 的 public module 契约已完成，再对照活代码设计
> macOS adapter 与原生 UI；每个里程碑由 self-executor 验证并提交。命中 STOP 条件即停，完成后更新
> 本 plan 与 `plans/README.md`。
>
> Drift check: `git diff --stat 5942465..HEAD -- packages/swift-client/ apps/macos/ docs/design-guidelines.md plans/084-shared-swift-client-core.md`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: `plans/084-shared-swift-client-core.md`
- Category: feature
- Execution: self-execution（沿用 plan 082 departure check）
- Planned at: `5942465`, 2026-08-25

## Requirement

把 `apps/macos/Coflux.app` 从 20 行 probe shell 变成可持续迭代的真正原生客户端 Foundation：能连接
配置的 Coflux server，以账号密码登录、把 session token 安全持久化、重启自动认证、接收全量快照与
增量，并以 macOS 原生界面显示基础设备/项目/工作区状态、loading/offline/auth error/outdated。

该阶段不追求完整工作台，但必须是生产架构的第一块，不允许 hardcoded demo、WebView、JS runtime、
测试专用 mock 作为 App 数据源，或复制共享 core。`Coflux Native Probe` 文案和占位界面必须消失。

## Decisions & tradeoffs

- **macOS App 只组合 plan 084 的 `CofluxProtocol`、`CofluxClientCore` 与
  `CofluxApplePlatform`**。Rejected: 在 `apps/macos` 复制 reducer/transport contract——会形成第三份
  行为实现。Based on: `apps/macos/Coflux/CofluxApp.swift:1-20`。

- **macOS 14 control WebSocket 使用异步 `URLSessionWebSocketTask` adapter**，只接受 binary，单一
  receive waiter、发送保序、close 幂等；不得复制 probe 的 semaphore/blocking helper。Rejected: 复用
  iOS 26 `NetworkConnection<WebSocket>`——部署目标不兼容。Based on:
  `apps/ios/Coflux/Client/Transport.swift:20-29`、
  `apps/macos/CofluxTests/NativeLoopbackAuthProbe.swift:201-221`。

- **Keychain adapter 使用显式、稳定、App 专属的 service/account，并上报结构化错误**；测试使用随机
  namespace，绝不读取真实 Coflux token。Rejected: `Bundle.main` 隐式 service——package/test host 与 App
  会产生不同值。Based on: `apps/ios/Coflux/Client/KeychainTokenStore.swift:9-14`。

- **App composition root 显式提供 server URL、build identity、logger、transport 与 token store**。
  Debug 可由 `COFLUX_SERVER_URL` 指向隔离 dev server，未设置时走产品默认；Release build identity 从
  `CFBundleShortVersionString`/`CFBundleVersion` 形成非空、非 `dev` 值。正式 allowlist 留 Phase 6。
  Rejected: 在 core 或 View 里读环境/Bundle——破坏测试与模块边界。

- **原生 UI 采用 SwiftUI-first，基础层级与 Web 一致但遵循 macOS 交互**：登录/升级/错误为独立状态，
  认证后采用可调侧栏，设备、项目、工作区有明确层级和在线状态，未收快照显示 loading，掉线保留最后
  状态并显示横幅。Rejected: 把 iOS View 放大或把网页嵌进窗口。Based on:
  `apps/web/src/components/workbench/sidebar.tsx`、`apps/ios/Coflux/Views/RootView.swift`。

- **Foundation 只读 UI 不提前实现任务/终端/diff 操作**。App 可以保留 core 中的 iOS relay Router，
  但 macOS 本阶段不暴露半成品 attach/direct/P2P 控件。Rejected: 为“看起来完整”接假按钮或 relay-only
  终端——会误报功能 parity。

- **生产 App target 不直接链接 SwiftTerm 或 WebRTC**；Phase 0 tests/probes 继续在 test target 依赖固定
  包并保持脚本入口。Rejected: 因 hosted tests 方便把 44 MB WebRTC 提前嵌入 App。Based on:
  `apps/macos/project.yml:27-58`。

- **Hardened Runtime 开启，App Sandbox 在 Foundation 使用显式 entitlement，仅允许
  `network.client`**；不提前给 `network.server` 或路径例外。现有 WebRTC sandbox 脚本可显式覆盖测试
  构型，Phase 2 再审最终 P2P entitlement。Rejected: 沿用当前 `ENABLE_APP_SANDBOX: NO` 到产品代码，
  或为未来 P2P 预授多余权限。Based on: `apps/macos/project.yml:43-45`、
  `apps/macos/WEBRTC_PROBE.md:60-74`。

- **日志采用窄 `ClientLogger` → OSLog adapter**，稳定 subsystem/category，只记录状态、代际、route、
  duration 与脱敏 ID；token、密码、私钥、protobuf payload、终端正文禁止进入日志。远端 telemetry 留
  Phase 6。

- **XcodeGen 的 `project.yml` 是工程真相侧，生成的 pbxproj 必须零漂移提交**。Package 版本继续 exact
  pin；Phase 0 的 TCC target/docs/scripts 原样保留。Rejected: 手改 pbxproj——下一次 generate 会丢失。

## Direction

### Milestone 1：macOS 14 平台 adapter 与安全持久化

`CofluxApplePlatform` 提供可在 macOS 14 编译运行的 URLSession WebSocket、显式 Keychain、Bundle build
identity 与 OSLog adapter；fake/host tests覆盖 binary-only、Origin/request 构造、单 receive、发送保序、
关闭、Keychain add/update/read/delete/error 和日志脱敏。

Milestone validation: `swift test --package-path packages/swift-client` 与 macOS adapter tests → exit 0。

### Milestone 2：真正的 App composition 与状态 UI

`Coflux.app` 通过同一 shared client 展示登录、authenticating、outdated、loading、offline、基础层级与
错误；窗口可正常重开，退出/重启 token 恢复语义正确。UI 不出现 probe 文案、假数据、WebView 或未实现
操作入口。

Milestone validation: `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS'` → exit 0。

### Milestone 3：工程、权限、版本与产品纯度

App target 有显式 marketing/build version、Hardened Runtime、最小 Sandbox entitlement；Release generic
能产出 universal 主 Mach-O，产品 App 不嵌 WebRTC。现有 SwiftTerm/WebRTC/loopback/TCC probe 入口仍能
独立构建和运行，不借 Foundation 删除风险门。

Milestone validation: XcodeGen regeneration 零 diff；Release product audit 通过。

### Milestone 4：真实隔离栈 Foundation acceptance

自动化入口拉起隔离 server，使用临时账号/token/Keychain namespace 跑密码登录、AuthOk token 持久化、
快照、增量、断线保留、重连收敛与 logout 撤销；该真实 server 流程使用显式 `dev` 的 Debug composition，
因为 Phase 6 前 server 尚无独立 native Release 准入。Release identity 另由 fake transport 捕获首个 auth
帧并由 product audit 核对 Bundle 字段；结束后清理临时进程/数据库/Keychain，不触碰真实用户环境。

Milestone validation: 快速测试保持绿；真实进程项仅在最终 acceptance 运行。

## Landmines

- 当前 Swift protobuf 只编入 macOS test target，App 本身无法解码控制面：`apps/macos/project.yml:47-58`。
- hosted test 对 SwiftTerm/WebRTC 的依赖可能把 framework 嵌进 App；移除 App 直接依赖后必须实际检查
  Release product，而不是只读 project graph。
- 现有脚本硬编码 `-scheme Coflux`、`CofluxTests/...` 与 `Coflux.app`；若调整 target/scheme，必须同步
  `webrtc-worker-interop.mjs`、`loopback-auth-interop.mjs`、`macos-signing-audit.mjs`，不能静默废掉门禁。
- App Sandbox `network.client` 足够 control/relay 出站但不足 UDP WebRTC；本阶段真实 P2P probe 必须用
  既有显式构型，不能把预期 entitlement 负向误判成回归。
- Debug active arch 不是 universal 证据；必须 Release generic + `ONLY_ACTIVE_ARCH=NO` 后对主 Mach-O
  执行 `lipo -archs`。
- ad-hoc/unsigned CI build 不是 Apple Development，更不是 Developer ID；本阶段只记录 Development
  本机证据，发布签名仍后置。
- 未收到 snapshot 与收到空 snapshot 必须视觉不同；offline 时不能清空最后状态。
- Keychain acceptance 需要签名 host；测试 namespace 必须随机且收尾盘点为零。

## Scope

In scope:

- `packages/swift-client/Sources/CofluxApplePlatform/**` 及其 tests
- `apps/macos/Coflux/**`、`apps/macos/CofluxTests/**`
- `apps/macos/project.yml`、生成的 `apps/macos/Coflux.xcodeproj/**`、workspace resolved pins
- 为保持 Phase 0 probe 可用所需的 `apps/macos/scripts/**` 与 probe test target 调整
- `plans/085-macos-native-foundation-app.md`、`plans/README.md`

Out of scope:

- server 订阅原子性和 CI——plan 086
- direct/P2P/loopback Router、终端/任务操作、完整工作台、diff/预览——Phase 2–5
- Developer ID、DMG、公证、Sparkle、正式 native allowlist——Phase 6
- clean-user LAN/TCC、两 NAT、Intel/macOS 14 实机发布矩阵——Phase 6–7
- iOS UI、`apps/mobile`、Web/daemon 功能改动

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Package regression | `swift test --package-path packages/swift-client` | exit 0 |
| XcodeGen truth | `xcodegen generate -s apps/macos/project.yml -p apps/macos && git diff --exit-code -- apps/macos/Coflux.xcodeproj` | 已提交状态下 exit 0 |
| macOS tests | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -disableAutomaticPackageResolution` | exit 0 |
| Foundation real stack (acceptance) | `apps/macos/scripts/test-foundation-control-interop.sh` | 登录/持久化/快照/增量/重连/logout 全过且零环境残留 |
| Release product audit | `node apps/macos/scripts/macos-product-audit.mjs` | arm64+x86_64、版本非空、Hardened Runtime/最小 entitlement、App 无 WebRTC |
| Phase 0 terminal guard (acceptance) | `apps/macos/scripts/test-terminal-sessiond-interop.sh` | exit 0 |
| Phase 0 WebRTC guard (acceptance) | `apps/macos/scripts/test-webrtc-worker-interop.sh` | exit 0 |
| Phase 0 auth guard (acceptance) | `apps/macos/scripts/test-loopback-auth-interop.sh` | exit 0 |
| TCC build-only guard | `node apps/macos/scripts/local-network-tcc-acceptance.mjs --build-only` | 两个未启动 app 构型通过；不声称 TCC 结果 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] 所有 listed commands 通过；环境 acceptance 记录隔离方式与清理结果。
- [ ] 真正 App 能登录、持久化/清除 token、重启恢复、接收快照和增量、离线重连收敛。
- [ ] UI 明确区分 need-login/authenticating/outdated/loading/synced/offline/error，基础实体来自真实 core。
- [ ] App 生产源码无 WebView/JS runtime、无复制 core、无 probe shell/假操作。
- [ ] Release App 主 Mach-O universal，build identity 非空非 dev，产品不嵌 WebRTC。
- [ ] 权限与日志满足最小化/脱敏契约，真实用户 Keychain 不受测试影响。
- [ ] Phase 0 probe 与 TCC build-only 入口保持可用，LAN/TCC 未被伪报通过。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- macOS 14 只能通过放宽部署目标或复用 iOS 26 API连接控制面。
- 共享 package public contract 不足，且完成需要在 macOS 复制/分叉 reducer 或 Router。
- App Sandbox 需要路径例外、ATS 全局放宽或多余 network entitlement 才能登录。
- Phase 0 的 SwiftTerm/WebRTC/loopback probe 因工程重构失效，且一次合理修复后仍失败。
- 真实栈测试触及用户现有 token、数据库、daemon/service 或无法可靠清理。
- 需要提前实现 Phase 2 transport、Phase 3 UI 或 Phase 6 发布系统才可完成。

## Maintenance notes

- Phase 1 基础 UI 是后续视觉/交互对照的骨架，不是完整 parity 里程碑；不得据此宣称 Web 已复刻。
- App target 依赖每次新增都应做 product purity 检查，避免 test/probe binary framework 泄入发布产物。
- LAN/TCC 脚本在 Phase 6 前只运行 build-only；真实 prompt 必须在符合 plan 083 的 clean-user/受控 peer
  条件下进行。
