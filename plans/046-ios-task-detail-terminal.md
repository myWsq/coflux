# Plan 046: iOS 第二片 —— 任务详情页 + SwiftTerm 终端交互（relay-only Device 数据面）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 223cddf..HEAD -- packages/client/src/device-router.ts packages/client/src/store.ts packages/protocol/src/index.ts proto/coflux/v1/device.proto proto/coflux/v1/client.proto proto/gen/swift`

## Status

- Priority: P1
- Effort: L
- Risk: MED（attach/接管状态机是全项目最难移植点；SwiftTerm 首次集成）
- Depends on: plans/044-ios-app-skeleton-client-login.md（DONE）
- Category: feature
- Execution: self（standing 授权：iOS/Swift 不派 subagent，2026-07-25 变更）
- Planned at: `223cddf`, 2026-07-26

## Requirement

iOS app 第二片。第一片（044）完成了控制面（连接/认证/归约器）与工作区列表；本片
打通 PTY 数据面，完成 v1「最小终端闭环」的核心：**在手机上看任务现场、输入、接管、
把停着的任务拉起来**。完成后：

1. 工作区列表行可点进**任务列表页**（该工作区的 tasks），任务行可点进**任务详情页**；
2. 任务详情页 = SwiftTerm 终端现场：
   - RUNNING 任务：经 relay attach，渲染 ANSI snapshot + 增量输出；键盘输入（含
     快捷键条：Esc/Tab/Ctrl/方向键这一档）、resize、独占接管语义（被接管出横幅 +
     「强制接管」动作）；
   - IDLE/EXITED 任务：显示 sessionCheckpoint 只读回放（server 侧终端镜像，若有），
     并可**启动任务**（taskStart → preparedDeviceOperation → sessionCreate）；
   - 可停止任务（sessionStop + taskRemove，语义对照 web closeTask）。
3. Device 数据面 = **relay-only**：deviceRelayConnect rendezvous → 拨 relay WS →
   opaque DeviceEnvelope 字节管道。永不移植 direct/loopback 路径。

正确解与相邻错误解的分界：错误解有两种。其一是把 `device-router.ts` 2500 行逐行翻译
（含 BrowserIdentity、pair/lease、direct hedge/promotion、measureOnly、心跳、
fs/exec RPC——这些在 relay-only + 本片 UI 下全部没有对应物）；其二是图省事绕开
台账语义（比如输入不留 retained 队列直接发、输出不校验连续性、attach 响应不做
三重匹配）——这些语义是 exactly-once 契约（plan 042）的客户端半边，绕开会在弱网/
切后台时静默丢输入或渲染错位。正确解是**只移植 relay-only 子集，但子集内的状态机
语义与 TS 版严格一致**（逐条见 Decisions）。

## Decisions & tradeoffs

- **数据面移植范围 = device-router 的 relay-only 子集**。保留：per-daemon route
  （session lane + elevated lane，均走 relay）、transport generation 单调递增、
  attach 状态机（snapshot / resume_from_seq、三重匹配、gap → snapshot recovery）、
  输入台账（input_seq/acked/retained 队列 + 500ms 重投 + 256 条/1MB 上限，
  `device-router.ts:1967-1995`）、resize 台账（`device-router.ts:1997-2015`）、
  stopSession + holder waiter（`device-router.ts:2017-2034`）、catalog 3s 轮询 +
  exitAck（`device-router.ts:1607-1626`）、prepared operations 台账
  （`device-router.ts:2123-2153`）、错误码分支语义（stale_holder / session_not_found /
  stale_transport / scope_denied / supervisor_busy / input_seq_gap / stale_input /
  stale_resize，`device-router.ts:1385-1485`）。
  **不移植**：BrowserIdentity/pair/lease/direct 全部、hedge/promotion、
  measureOnly/retainDevice 计数（iOS 的 demand 就是「终端页在前台」）、
  心跳 ping/pong（本片 UI 无 RTT 读数；ponytail ceiling，见 Maintenance）、
  fs/exec/ports RPC（无对应 UI）、pendingTaskRemovals（见下条）。
  Rejected: 逐行翻译——一半代码服务于 iOS 永不存在的 loopback；重新发明简化态机——
  语义基准就是 TS 版，即兴形态会偏离 042 契约。
- **pendingTaskRemovals 不移植**：TS 版为 direct 场景（中心离线仍可本机 stop 后补投
  删除）；iOS relay-only 下中心离线 ⇒ relay 通道必然已断（`device-router.ts:2196-2209`
  setControlOnline(false) 关闭所有 relay channel），stop 根本发不出去。iOS 的
  closeTask 在中心离线时直接报错提示。Based on: `store.ts:597-609` 的记账仅在
  `!controlAuthenticated` 时入队，而该状态下 iOS 无任何设备通路。
- **启动任务链路完整移植**（departure check 2026-07-26 用户拍板）：taskStart 控制面
  消息（`store.ts:566-575`：RUNNING+sessionId → attach，否则发 taskStart）→ server 回
  preparedDeviceOperation → 客户端校验（operationId 匹配、未过期、frame 内 channel_id
  为空，`device-router.ts:2123-2142`）→ 填 channel_id 经 elevated LIFECYCLE relay lane
  发出 → operationAck/projectValidated/worktreeAdded 清账。Rejected: 后置第三片——
  停着的任务在手机上会是死页面，闭环价值不成立。
- **sessionCheckpoint 移植**（第一片刻意留白的 PTY 域空位之一）：控制面
  `sessionCheckpoint` 消息（`proto/coflux/v1/client.proto:254`）存入
  `sessionCheckpoints[sessionId]`；任务详情页无 live session 时把 `ansi_snapshot`
  作为 replace 写入终端（`store.ts:497-506` + `store.ts:306-307` 的 consumer 语义：
  checkpoint 只在 `!liveSessionIds.has()` 时投递）。taskRemoved 时清对应 checkpoint。
- **PTY 输出不进 @Observable 状态**：与 TS 版同构（`store.ts:107-110` 注释），
  输出字节经非响应式回调直达 SwiftTerm `feed`，只有控制面事实（detached、exited、
  inputState blocked）进可观察状态。Rejected: 输出进状态容器——每帧触发视图 diff，
  终端吞吐直接打爆 SwiftUI。
- **SwiftTerm 为第二个 SPM 依赖**（migueldeicaza/SwiftTerm，iOS `TerminalView`，
  CoreText 渲染路径；2026-07-25 立项调研定稿，`~/.claude/.../memory/ios-app.md`）。
  经 UIViewRepresentable 包进 SwiftUI；feed 必须在主线程。快捷键条最小档：
  Esc/Tab/Ctrl/↑↓←→（SwiftTerm 有无现成 accessory 由执行者查证，没有就自建
  inputAccessoryView，不超过一排按钮的复杂度）。
- **协议常量硬编码并注明真相源**：`DEVICE_PROTOCOL_VERSION = 1`、
  `MAX_DEVICE_FRAME_BYTES = 30MB`（`packages/protocol/src/index.ts:45,50`）、
  cols/rows 钳制 [1,1000]（`index.ts:157` clampDim + `device.proto:12` 注释）。
  Swift 侧无法 import TS 包，硬编码 + 注释指回真相源是最低熵解。
- **relay WS 复用第一片的 Network.framework 传输封装**（`apps/ios/Coflux/Client/Transport.swift`）：
  同一 actor+AsyncStream 形态再实例化一条 binary WS；relay URL 来自 DeviceRelayGrant
  （完整 wss URL，token 在 query 内、单次有效）。**连接失败不得复用 URL 重拨**，必须
  重新 rendezvous（`device.proto:193-194`）。
- **后台生命周期扩展**：既有 scenePhase 处理（background 断控制面）必须同步 tear down
  全部 device route（关 relay socket、清 pending、attach 状态归零）；回前台控制面重建
  后按需重新 rendezvous + attach。generation 不回退（进程内单调，
  `device-router.ts:330-331`）；clientInstanceId 每次冷启动随机即可（与 TS 版每
  createCofluxClient 一次同语义）。
- **导航形态**（decided while planning）：工作区列表行 push 任务列表页（Cursor 风格
  延续：行 = 状态点 + 任务标题 + 元数据），任务行 push 任务详情页（全屏终端 + 顶栏）。
  既有 WorkspaceListView 行尾 chevron 本片兑现为真 NavigationLink。
- **测试面 = 数据面状态机 Swift Testing**（fake transport 注入，对照
  `device-router.test.ts` 的关键场景收窄为 relay-only）：attach 首连拿 snapshot、
  resume 被拒转 snapshot、输出 gap 触发 snapshot recovery、input 重投与累计 ACK 清账、
  detached 后 desired=false 且 force 接管重置 holder、prepared op 过期清账、
  控制面离线关闭 relay 通道。UI/SwiftTerm 渲染不做自动化测试
  （同 [[no-frontend-verification]] 惯例，真机验收由用户做）。

## Direction

分层沿第一片形态：`Transport`（新增一条 relay WS 实例化路径）→ `DeviceRoute`
（新文件，per-daemon 状态机 actor 或 @MainActor 类，语义基准 device-router.ts 的
relay-only 子集）→ `CofluxClient` 扩展（deviceRelayGrant / preparedDeviceOperation /
sessionCheckpoint 控制面分支 + taskStart/taskRemove 发送 + session consumer 注册表）
→ SwiftUI 视图（TaskListView / TaskDetailView + SwiftTerm UIViewRepresentable）。

### Milestone 1: Device 数据面层 + 状态机单测

relay rendezvous、DeviceEnvelope 编解码、route/lane/attach/输入台账/prepared op
状态机完成；Swift Testing 覆盖 Decisions 所列场景（fake transport 注入，不碰网络）。
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<可用 iPhone 模拟器>' test` → exit 0。

### Milestone 2: SwiftTerm 集成 + 任务列表/详情 UI + 控制面扩展

SwiftTerm SPM 依赖挂入；任务列表页、任务详情页（终端渲染、键盘 + 快捷键条、
detached 横幅与强制接管、启动/停止任务、checkpoint 回放、连接横幅沿用）；
scenePhase 设备通道生命周期接线。
Validation: 构建 + 单测两条命令 → exit 0（交互属 acceptance）。

## Landmines

- **协议常量三处真相源**：`DEVICE_PROTOCOL_VERSION`/`MAX_DEVICE_FRAME_BYTES` 在
  `packages/protocol/src/index.ts:45,50`；dims 钳制注释在 `device.proto:11-12`。
  Swift 侧写错版本号的症状是 daemon 静默丢帧，极难排查。
- **attach 响应三重匹配**（`device-router.ts:1487-1510`）：requestId、发起时的
  channel generation、当前 active channel 三者都对上才接受；resume 请求若回包
  无 ansi_snapshot 且 snapshot_seq ≠ 本地 outputSeq，必须转 requireSnapshot 重发
  attach，不能就地采信。
- **ptyOutput 连续性硬校验**（`device-router.ts:1512-1522`）：from_seq 必须等于
  outputSeq+1 且 to_seq = from+len−1，否则整段丢弃并走 snapshot recovery；
  `device.proto:298` 明文禁止猜测缺口。
- **sessionDetached 语义**（`device-router.ts:1319-1332`）：detached=true 后
  desired 置 false，普通 attach 不得自动重挂（`attachSession` 里 `detached && !force`
  直接 return，`device-router.ts:1929`）——这是 plan 026「旁观不抢占」的语义，
  破坏它会做出一个自动抢别人控制权的 app。force 接管才清 detached + holderEpoch。
- **中心断线 ⇒ 立即关全部 relay 通道**（`device-router.ts:2196-2209`）：rendezvous
  与 relay 存活都依赖中心；不关会留下一条半死管道继续吞输入。iOS 上控制面
  status != connected 即触发。
- **relay URL 单次有效**（`device.proto:193-194`）：拨号失败重试 = 重新走
  deviceRelayConnect，复用旧 URL 必被 relay 拒。
- **DeviceEnvelope 的 channel_id 校验**（`device-router.ts:1283-1289`）：收帧必须
  校验 envelope.channelId == channel.channelId 且 protocol_version 匹配，畸形帧
  静默丢弃不 crash。
- **prepared frame 不可改写除 channel_id 外任何字段**（`device.proto:489-495`）：
  daemon 逐字段比对模板，多动一个字段整个 operation 被拒。
- **swift-protobuf 的 oneof + 显式 presence**：`optional uint64 resume_from_seq`
  等字段用 `hasResumeFromSeq`/`clearResumeFromSeq`；未设置与 0 语义不同
  （resume_from_seq=0 与不带该字段是两种 attach）。
- **SwiftTerm feed 主线程**：数据面若是后台 actor，投递给 TerminalView 前必须跳
  MainActor；违者偶发崩溃且难复现。
- **MainActor default isolation 仍不可开**（plan 044 执行偏离）：pb.swift 生成代码
  无 nonisolated 标注；本片新增文件继续显式标注策略。
- **模拟器验收需要本机 relay**：`COFLUX_DEV=1` 的 dev server 是否内置 relay
  rendezvous 与 crates/relay 进程，执行时以 `pnpm dev:server` 实际拓扑为准；
  acceptance 前先用 web 客户端在同一 dev 环境跑通 relay 终端，排除环境因素再验 iOS。

## Scope

In scope:

- `apps/ios/**`
- `plans/README.md`（状态登记）

Out of scope:

- `proto/**`（真相源与生成产物；发现 Swift 生成产物类型缺口 STOP 汇报）
- `apps/server`、`apps/web`、`apps/mobile`、`packages/*`、`crates/*`（语义基准只读）
- direct/loopback 传输、fs/exec/ports RPC、diff 查看、Tab 管理、推送——后续片
- 心跳/RTT 读数（见 Maintenance ceiling）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 单测 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=<可用 iPhone 模拟器>' test` | exit 0 |
| 模拟器终端闭环 (acceptance) | 本机 dev server + daemon + relay，模拟器 attach 运行中任务：输入回显、web 端接管后 iOS 出横幅、iOS 强制接管夺回、启动 IDLE 任务、checkpoint 回放 | 全部行为符合 web 语义 |
| 真机生产 (acceptance) | 用户真机连 api.coflux.dev 重复上述场景 + 切后台回前台重连 re-attach | 现场恢复无错位 |

## Done criteria

- [ ] 构建与单测命令均 exit 0。
- [ ] 数据面状态机测试覆盖 Decisions 所列全部场景且断言有意义行为。
- [ ] 模拟器 acceptance：attach/输入/接管/启动/checkpoint 五个动作闭环。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- `proto/gen/swift` 缺 device.proto 对应类型或编译不过（生成产物问题属 out-of-scope）。
- SwiftTerm 在 iOS 26 目标下无法通过 SPM 集成或 TerminalView 基本 feed/输入不可用
  （栈决策失效，需回用户重议）。
- dev 环境无法构成 relay 拓扑做 acceptance（环境前置，属用户动作）。
- A fact cited under Decisions & tradeoffs no longer holds.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- **心跳是刻意 ceiling**：TS 版 ping/pong 服务侧栏 RTT 读数 + 半死通道探活；iOS 本片
  无该 UI，半死通道靠用户操作超时暴露。若后续加设备详情页/延迟读数，对照
  `device-router.ts:1628-1663` 移植，注意「不走 pendingRequests 以免钉住按需连接」。
- fs/exec/ports RPC 与 direct 路径的留白同理：以 TS 版为语义基准扩展，勿即兴发明。
- SwiftTerm 的 IME/全角标点行为在真机验收时留意（web 端 xterm.js 有上游双输入问题，
  SwiftTerm 是另一实现，坑不一定同位）。
- 任务列表页数据全部来自第一片控制面归约器（tasks），本片只加导航与详情；若任务行
  需要更多元数据（diff 统计等），控制面已有字段，别为 UI 去动协议。
