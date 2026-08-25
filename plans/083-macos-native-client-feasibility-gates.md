# Plan 083: macOS 原生客户端立项门禁——SwiftTerm 恢复、native loopback 身份与 WebRTC DataChannel

> 本 plan 是结果契约，不是逐步脚本。它是 plan 082 Roadmap 的第一个可执行片，只关闭会改变
> 总体架构的三个未知量，不实现完整工作台。理解需求与已定决策后，对照活代码自行设计 probe、
> harness 与测试；验证者必须亲自运行跨栈证据。命中 STOP 条件即停。完成后更新本 plan、
> `plans/082-macos-native-client-program.md` 的结论和 `plans/README.md`。
>
> Drift check: `git diff --stat 8d702d2..HEAD -- tests/fixtures/terminal/ tests/src/local-first-vt-oracle.test.mjs docs/architecture.md packages/client/src/device-router.ts apps/server/src/local-control.ts crates/worker/src/p2p.rs crates/worker/src/local_auth.rs apps/ios/Coflux/Client/ apps/ios/CofluxTests/ proto/gen/swift/`

## Status

- Priority: P1
- Effort: M（2–3 工程周）
- Risk: HIGH
- Depends on: `plans/082-macos-native-client-program.md`
- Category: tests
- Planned at: `8d702d2`, 2026-08-25
- Review state: 用户已于 2026-08-25 明确授权执行、提交与本机依赖安装
- Execution: self-execution（用户在 departure check 中明确选择）

## Requirement

在投入完整 macOS UI 重写前，用最小但生产语义真实的 native probe 回答三个架构级问题：

1. **终端恢复**：SwiftTerm 能否正确消费 daemon/sessiond 现有 ANSI snapshot，并在追加 tail 后与原始
   录制流保持关键 buffer/cell/mode 等价？
2. **P2P**：macOS 原生 libwebrtc 能否作为 offerer，与现有 `webrtc-rs 0.20.2` worker 建立
   WebRTC DataChannel，可靠承载当前二进制 Device frames、16 KiB 分片、关闭/超时和 relay
   fallback/promotion 所需信号？
3. **同机 direct**：原生客户端能否在不放宽授权校验的前提下，使用 P-256 identity、稳定 HTTPS
   Origin、pair/grant/lease 与 loopback gateway 跑通 session/elevated scope？

完成后必须给出一种可审计结论：

- **GO**：三门均通过，plan 082 的“Swift core + libwebrtc”方向保持；
- **CONDITIONAL GO**：某门需有界改动（如 SwiftTerm 小型上游补丁、自建 libwebrtc、正式 native
  identity 协议 plan），成本、维护面和依赖已记录并经用户批准；
- **NO-GO**：关键语义只能靠 WebView、放宽安全校验、不可维护的大型 fork 或未经许可的二进制实现。

“能编译”“DataChannel 状态显示 connected”“snapshot 肉眼可读”均不算通过。每一门都要有自动化
状态断言，并至少一次使用真实 Rust worker / sessiond 或其现有黑盒 harness；只用 mock 的结果无效。

## Decisions & tradeoffs

- **三门全部关闭后才进入全面重构**。Rejected: UI 与 spike 并行开工 — UI 是低风险大宗工作，若
  Router/终端最终迫使架构换成 Rust core 或自维护终端 fork，早做 UI 会固化错误边界。Based on:
  `plans/082-macos-native-client-program.md` 的 Risk R1–R4。

- **终端门复用现有三份脱敏 fixture，不另造简单 echo demo**。现有语料位于
  `tests/fixtures/terminal/{claude-cli,codex-cli,tui-vim}.json`，包含 alternate screen、diff、
  resize、宽字、样式和 tail；当前 xterm oracle 在
  `tests/src/local-first-vt-oracle.test.mjs:161-258`。Rejected: 只测 shell prompt — 无法覆盖实际
  Claude/Codex/Vim 使用面。

- **终端比较 cell/mode 契约，截图只作辅助证据**。至少比较尺寸、normal/alternate buffer、逻辑行、
  wrap、字符/宽度/组合字符、16/256/RGB 前后景、bold/dim/italic/underline/inverse、cursor 位置与可见性、
  application cursor/keypad、bracketed paste。明确不保证项沿用
  `docs/architecture.md:202-212`，不能在 native probe 私自扩大或缩小。

- **SwiftTerm 基线走 CoreText/CoreGraphics，Metal 不参与 GO 判定**。Rejected: 先开 Metal 再测 —
  SwiftTerm macOS 源码把该路径标为 experimental，且 GPU/window rebind 会把渲染生命周期问题混入
  parser/snapshot 语义。Metal 可记录性能数据，但失败不能反向否定 CoreText 可行性。

- **P2P 首选 probe 当前维护、支持 universal macOS 且可 checksum 固定的原生 XCFramework**。
  2026-08-25 的首选候选为 [`stasel/WebRTC`](https://github.com/stasel/WebRTC) M151，备选为
  [`livekit/webrtc-xcframework`](https://github.com/livekit/webrtc-xcframework)；执行时若版本已漂移，允许更新 milestone，但必须记录 exact tag、
  source revision、checksum、license、下载/解压体积和 arm64/x86_64 slices。Rejected: 未固定 URL 的
  “latest” 或手工拖入 framework — 不可复现且无法审计供应链。

- **P2P 必须对真实 worker 作 offer，不能拿两个 native PeerConnection 自测**。worker 侧有特定 DTLS
  role、candidate 枚举和 16 KiB 接收限制，native↔native 通过不能证明互通。Based on:
  `plans/076-p2p-webrtc-direct-transport.md` 的五项执行期偏离与
  `crates/worker/src/p2p.rs`。

- **P2P probe 使用生产 protobuf envelope 和现有中心信令语义，但不在本 plan 完整重写
  DeviceRouter**。最小 harness 要能 offer/answer、open DataChannel、双向发送多尺寸 frame、检测关闭、
  证明 relay 先可用后 P2P 可 promotion；完整 lane、fs/exec、长期重连属于后续 transport plan。
  Rejected: 为了 probe 复制 3,000 行 TS Router — scope 失控且会在 contract 冻结前制造临时代码债。

- **16 KiB 分片是硬约束，不以 libwebrtc 自身更大的 send limit 放宽**。测试必须覆盖 16 KiB 边界、
  跨多 chunk frame、接近 30 MiB 最大 Device frame，以及顺序/重组；Based on:
  `packages/protocol/src/index.ts:57`、`crates/protocol/src/lib.rs:68`。

- **关闭/判死测试不依赖 `RTCDataChannelState.closed` 及时到达**。plan 076 已记录 webrtc-rs 关闭对
  另一栈可能约 30s ICE 超时才可见；probe 要测主动 close、发送失败和 application ping/timeout 可提供
  哪些信号，并把结论交给后续 Router。Rejected: 看到一次 onClose 就假设所有网络故障都会通知 —
  plan 080 生产事故已证明该假设危险。

- **loopback 首先验证现有安全模型，不在 probe 中放宽 server/worker**。控制面 WS 与 loopback WS
  都设置与 server URL 匹配的稳定 HTTP(S) Origin，P-256 私钥存 Keychain，pair request 的
  `request.origin` 与 WS Origin 一致；scope 提升继续走中心 lease。Rejected: 删除 Origin 校验、把
  固定 grant 写进 App 或复用 daemon 私钥 — 均改变威胁模型。Based on:
  `apps/server/src/local-control.ts:99-108,401-404` 与
  `crates/worker/src/local_auth.rs`。

- **probe 的 P-256 key 使用 CryptoKit 可导出的 signing key + Keychain 持久化**。Secure Enclave 是否
  作为正式实现由后续安全设计决定；本门只证明 wire signature/key format 与授权生命周期可互通。
  Rejected: 内存临时 key — 无法验证重启后 grant 识别与 key mismatch 恢复。

- **不把生产 STUN/TURN 可达性与客户端跨栈能力混成一门**。自动化先用隔离本机/局域网拓扑证明
  offer/answer/host candidate/DataChannel；acceptance 再做两种真实网络。生产打洞率本身仍属于
  plan 076/080 的部署和稳定性尾项。若本地互通失败，禁止用“可能是公网网络”解释。

- **probe 产物要么进入后续生产边界，要么明确删除；不留第二套临时协议实现**。可长期保留的是
  fixture runner、cross-stack tests、依赖选择记录和最小 platform adapter；纯调试 UI、硬编码 token/
  URL、绕过授权的 helper 不得进入后续 foundation。

## Direction

### Milestone 1：SwiftTerm snapshot fidelity 门

建立可在 macOS 测试 target 中运行的 SwiftTerm harness，复用三份现有 fixture，分别验证：

1. 原始录制流；
2. 真实 sessiond snapshot；
3. snapshot + fixture tail；
4. snapshot 后继续接真实 PTY tail。

输出结构化 diff，至少能指出 buffer、row/col、cell codepoint/width/style、cursor 或 mode 的第一处差异；
不允许只输出整屏字符串。把“保证恢复/明确不保证”逐项映射到 XCTest，差异若属于不保证项要有明确
注释而不是 blanket ignore。

Milestone validation: `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -only-testing:CofluxTests/TerminalFixtureCompatibilityTests` → exit 0。该快速测试消费固定的 raw/snapshot/tail fixture；从真实 sessiond 重新取得 snapshot 的运行环境测试列在 Commands 的 acceptance 项，最后执行。

### Milestone 2：native libwebrtc ↔ webrtc-rs DataChannel 门

用生产 protobuf 和中心 P2P 信令对真实 debug worker 发 offer，完成 ICE/DTLS/SCTP/DataChannel；验证：

- macOS arm64 与 x86_64 均能链接/加载所选 XCFramework；
- binary ordered/reliable DataChannel 双向收发；
- 1 B、16 KiB 边界、多 chunk 与接近 30 MiB frame 的分片/重组；
- server/worker 拒绝、超时、主动关闭和静默无响应的可观察信号；
- relay 已工作时 P2P 后到可接管，P2P 失败时 relay 不被破坏；
- control 信令断开后 PeerConnection 的真实生命周期记录，不复制 plan 080 已知连坐行为。

输出所选依赖的 tag/revision/checksum/license、universal slices、App 体积增量、idle 内存与一次连接耗时。
若首选失败，可对一个备选做同一门；不得循环试不透明的 binary 直到偶然成功。

Milestone validation: `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -only-testing:CofluxTests/NativeWebRTCFramingTests` → exit 0，覆盖 frame 分片/重组、超时和 promotion 状态；真实 Rust worker interop 列在 Commands 的 acceptance 项，最后执行。

### Milestone 3：native P-256 / Origin / loopback grant+lease 门

以持久化 native identity 依次证明：首次无 grant → 中心 pair → daemon install → loopback session scope；
重启 App → 复用 grant；需要 RPC/lifecycle 时中心签 lease → elevated scope；key mismatch、grant revoke、
lease expiry 均被拒并进入可恢复状态。两个 WebSocket 握手与 pair payload 的 Origin 必须一致且通过现有
校验，不能使用测试专属环境变量关闭认证。

同时记录 macOS ATS、Local Network privacy、App Sandbox/Hardened Runtime 下实际所需权限；这份结果
决定 plan 082 中 App Sandbox 的终态决策。

Milestone validation: `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -only-testing:CofluxTests/NativeIdentityTests` → exit 0，覆盖 P-256 wire、Keychain 重启模拟、Origin request 构造和 lease 状态；真实 server/worker loopback 闭环列在 Commands 的 acceptance 项，最后执行。

### Milestone 4：GO/CONDITIONAL GO/NO-GO 决策收口

把三门证据、失败边界、依赖物料、性能/体积和需要的协议变化回写 plan 082。若结论为 GO，另立
Foundation plan，冻结共享 Swift core 物理路径/API 后才允许并行 UI/transport；若为 CONDITIONAL GO，
先由用户批准新增维护成本并另立前置 plan；若为 NO-GO，停止 macOS 全面重构，不把失败 probe 包装成
alpha。

Validation: `git diff --check -- plans/082-macos-native-client-program.md plans/083-macos-native-client-feasibility-gates.md docs/ROADMAP.md docs/architecture.md` → exit 0。

## Landmines

- `tests/src/local-first-vt-oracle.test.mjs` 取得的是**真实 sessiond snapshot**，不是把 fixture 中间一段
  当 snapshot；native harness 必须复用同一机制，否则绕过了待验证对象。
- fixture schema 的 stage barrier 与 resize 是语义的一部分：
  `tests/fixtures/terminal/player.mjs:22-26`。一次性把所有 base64 拼起来会漏掉 resize/mode 边界。
- `docs/architecture.md:204-210` 的“明确不保证”不是失败豁免通配符；只有列出的元数据/模式可忽略，
  Unicode 宽字、history、cursor、alternate screen、颜色和关键 mode 仍是硬门。
- WebRTC “ICE connected” 不等于 DataChannel 可用。plan 076 曾遇到 DTLS role 不匹配导致 ICE connected
  但 channel 永不开；必须等 open 并完成双向业务 frame。
- webrtc-rs 不自动枚举接口，worker 已有特定 candidate 处理；native 侧不要因为 libwebrtc 自动完成
  枚举就删除/修改 worker 逻辑来“简化 probe”。
- XCFramework 必须同时检查 framework 声明与实际 Mach-O slices；README 写 universal 不算证据。
- SwiftPM binary target 的 checksum 只证明下载内容固定，不证明来源可信；还需记录源码/构建链、license
  和更新策略。
- `URLSessionWebSocketTask` 是否允许目标握手头按预期送出必须抓实际 server/worker 收到的 Origin 证明；
  只检查 `URLRequest` 对象不算通过。
- Keychain 测试必须在签名 test host 中跑。调研时 `CODE_SIGNING_ALLOWED=NO` 会让 write 后 read 仍为 nil；
  这是环境失败，不要误判 CryptoKit/Keychain 方案。
- elevated lease 依赖中心在线；loopback 物理可达不代表中心离线时允许 RPC/lifecycle。probe 必须分别
  证明 session scope 与 elevated scope，不能用 session attach 代替全部 direct 验收。
- plan 080 当前为 PARTIAL；若执行时 Web/client 的 liveness 或 worker `close_all` 授权语义已改变，先
  做 drift check，native probe 以活契约为准并同步更新 plan 082。
- probe 不得读取或打印真实用户 token、Keychain 内容、P-256 私钥或终端未脱敏录制；测试全部使用
  临时 HOME/DB/端口和仓库已有脱敏 fixture。

## Scope

In scope:

- `apps/macos/**`（新增最小原生 probe/test target；不是完整 UI）
- `apps/macos/scripts/**`（可重复运行的 sessiond/WebRTC/loopback interop 与 binary slice 检查入口）
- `tests/fixtures/terminal/**`（优先只读复用；仅为跨引擎 metadata 扩展时可改）
- `tests/src/local-first-vt-oracle.test.mjs` 与相关 harness（仅共享 fixture/snapshot 证据所需）
- `apps/ios/Coflux/Client/**`、`apps/ios/CofluxTests/**`（只允许提取可复用 platform adapter 或修正
  probe 暴露的共享缺陷，不做 iOS UI）
- `proto/gen/swift/**`（消费，不在无协议 plan 的情况下手改生成文件）
- `packages/client/src/device-router.ts`、`crates/worker/src/p2p.rs`、
  `crates/worker/src/local_auth.rs`（行为真相与测试接线；生产语义修改需另立 plan）
- 隔离的本地测试/fixture 配置、SwiftPM dependency pin/checksum
- `plans/082-macos-native-client-program.md`、本 plan、`plans/README.md`
- `docs/ROADMAP.md`、`docs/architecture.md`（只回写最终证据与边界）

Out of scope:

- 完整 macOS 工作台、侧栏、diff、项目导入、发布 UI — 后续 phases
- 完整 Swift DeviceRouter 移植 — 本 plan 只做足以判定架构的真实 interop harness
- 放宽或重写 server/worker 授权模型 — 若需要，STOP 并另立协议/安全 plan
- 生产部署、修改 `COFLUX_P2P_ENABLED`、配置生产 STUN/TURN — 本 plan 只读生产状态
- 自维护大型 SwiftTerm/libwebrtc fork — 需要用户先批准 CONDITIONAL GO 成本
- Rust client core 实现 — 只是本门失败后的备选方向，不在本 plan 偷做
- `apps/web` UI、`apps/mobile`、iOS UI、语音输入
- App 自动更新、签名发布流水线 — Phase 6；probe 只记录权限/框架装载条件

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| macOS probe 全部单测 | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS'` | exit 0 |
| iOS 回归（若抽取共享代码） | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | 除显式环境 probe 外全过 |
| 既有 xterm snapshot oracle (acceptance) | `node --test tests/src/local-first-vt-oracle.test.mjs` | 真实 stack 中三份 fixture 全过 |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0 零警告 |
| daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 零警告 |
| SwiftTerm ↔ 真实 sessiond (acceptance) | `apps/macos/scripts/test-terminal-sessiond-interop.sh` | 三份 fixture 的 raw/snapshot/snapshot+tail 契约全过 |
| native WebRTC ↔ 真实 worker (acceptance) | `apps/macos/scripts/test-webrtc-worker-interop.sh` | DataChannel、分片、大 frame、失败回落与 promotion 全过 |
| native loopback auth (acceptance) | `apps/macos/scripts/test-loopback-auth-interop.sh` | pair/grant/restart/revoke/lease 正负路径全过 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | 全绿；任何既有基线单独证明 |
| universal slices | `apps/macos/scripts/verify-webrtc-slices.sh` | 锁定 XCFramework 同时含 arm64、x86_64，checksum/license 与记录一致 |
| 两网络 P2P (acceptance) | 两台不同 NAT/网络的 Mac 与真实 daemon，保留 relay fallback | P2P 成功时 promotion；失败时 relay 连续可用 |
| signed local-network probe (acceptance) | Hardened Runtime/App Sandbox 两种构型分别跑 loopback/P2P | 权限、提示和失败模式已记录，能冻结首发 sandbox 决策 |

## Done criteria

- [ ] 三门各有自动化测试和真实跨栈证据，不以 mock-only、connected 状态或截图代替。
- [ ] 三份现有终端 fixture 的 raw、真实 snapshot、snapshot+tail 均按架构契约比较；差异报告可定位到
  cell/mode，忽略项逐项说明。
- [ ] native libwebrtc 与当前 Rust worker 完成双向 binary DataChannel，覆盖 16 KiB 分片与大 frame。
- [ ] P2P 失败/静默后 relay 不被破坏；probe 明确记录可用 liveness 信号和不能依赖的回调。
- [ ] WebRTC 依赖的 exact version/revision/checksum/license、源码来源、架构 slices、体积/内存已记录。
- [ ] P-256 identity 跨 App 重启复用，pair/grant/revoke/key mismatch/lease expiry 的正负路径均通过。
- [ ] control WS 与 loopback WS 的实际 Origin 由对端观测证明一致，server/worker 校验未放宽。
- [ ] ATS、Local Network、Hardened Runtime 与 App Sandbox 权限矩阵有真实结果。
- [ ] plan 082 回写最终 GO/CONDITIONAL GO/NO-GO、依赖选择、共享 core 建议与估算变化。
- [ ] 若为 GO，foundation plan 已单独创建，但没有在未经用户确认的情况下自动执行；若非 GO，后续
  UI phases 未启动。
- [ ] iOS 可运行的既有测试未退化，`apps/mobile` 与生产部署无改动。
- [ ] 所有 listed commands 通过，acceptance 项由验证者记录环境与结果。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- 任一 fixture 在架构保证项上不等价，且合理的小型 adapter/上游修复尝试后仍失败。
- WebRTC 互通需要修改 worker 的安全/授权语义、换用无明确许可/不可固定的 binary，或只能支持单一
  macOS 架构。
- native WebSocket 无法可靠设置并由对端收到所需 Origin，且唯一替代是放宽 Origin/grant 校验。
- P2P 大 frame 只能通过改变现有 16 KiB/30 MiB 线契约实现。
- plan 080/活代码的控制面与数据面生命周期仍相互矛盾，无法为 native Router 写出唯一契约。
- 需要开始完整 UI、完整 Router 或 Rust core 才能“证明”门禁；说明 probe 边界设计失败，先重写 plan。
- probe 需要真实生产 token、用户终端录制、生产数据库或修改生产开关。
- 某验证命令经一次合理修复后仍连续失败两次，或只能删除/弱化用例变绿。
- 实测把 plan 082 净估算推高超过 40%；先回用户重新评审是否继续。

## Maintenance notes

- 本 plan 的长期资产是跨终端 fixture、native↔Rust WebRTC interop、loopback auth 测试和依赖审计记录；
  即使最终不做完整 App，这些证据也能约束 iOS P2P 与未来客户端。
- fixture 中的 Claude/Codex 版本会过时，但 ANSI 能力覆盖比产品版本号更重要。新增 escape sequence 时
  追加小 fixture，不频繁重录并丢失历史覆盖。
- WebRTC milestone 更新必须复跑整套 interop，不能只看上游 release notes。Chromium/libwebrtc、
  webrtc-rs 与 macOS SDK 三者都可能改变行为。
- 如果最终选择 Rust core，把本 plan 的 wire/terminal/auth 证据作为 Rust FFI 方案的同一验收门；不要因
  换语言降低 Done criteria。
