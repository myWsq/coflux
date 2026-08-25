# macOS native WebRTC probe 物料与边界

Plan 083 Milestone 2 固定使用 `stasel/WebRTC` M151 的 SwiftPM binary target：

- tag：`151.0.0`
- wrapper source revision：`19aa8c1fc7120d50df987b7111f42d5024df3d54`
- 上游 WebRTC source：`branch-heads/7922`，commit
  `f20ebb8adbf4fa781830e4384c61f732bd28a217`（M151 GitHub release metadata）
- release asset：`WebRTC-M151.xcframework.zip`
- SwiftPM checksum：`64a218fad3d84a0d783321aa9a1eec58ca266ac7879123f86b0b44b703b7d8dc`
- 构建来源：wrapper 仓库的 GitHub Actions `scripts/build.sh`，从 Google WebRTC milestone
  branch 构建；release metadata 由 build 生成的 `metadata.json` 写入 branch/commit/checksum，
  不是仓库内手工加入的 framework
- license：wrapper 与 framework 分别携带 BSD 3-Clause / Google WebRTC BSD 3-Clause
- 更新策略：只接受 exact tag、`Package.resolved` revision、SwiftPM checksum 三者共同变化；
  升级时必须重跑 universal slice、Rust worker interop 与大帧门

上游 branch/commit 来自 GitHub release metadata，是发布者对构建输入的可审计声明；验证脚本会在线
比对该声明与 asset URL/bytes/digest，再独立校验本地 archive SHA-256。它不是 reproducible-build
证明，不能声称仅凭 binary 已反推出或复现了源码 revision。

`apps/macos/scripts/verify-webrtc-slices.sh` 同时检查 XCFramework 声明与真实 Mach-O；M151
的 macOS framework 是 `arm64 + x86_64` universal binary。当前 release archive 为
44,616,338 bytes，SHA-256 与 SwiftPM checksum 一致；解压后的 XCFramework 为 97,956 KiB，
其中 macOS Mach-O 为 28,395,760 bytes。Debug App 中实际嵌入的
`WebRTC.framework` 为 27,804 KiB（App 总计 32,360 KiB），即当前可归因的 App 体积增量；
arm64 与 Rosetta x86_64 XCTest 都已实际链接、由 dyld 加载并运行。

## 互通契约

- native 为 offerer，Rust worker (`webrtc-rs 0.20.2`) 为 DTLS passive/server answerer。
- vanilla ICE：等待 gathering complete；12 秒仍未完成时沿用生产契约，带已收集的 host candidates
  继续。SDP 经生产 `DeviceP2pOffer/Answer` 转发。
- DataChannel label 等于 `channel_id`，ordered + reliable；只有 DataChannel `open` 且双向
  `DeviceEnvelope` 成功才算建连。
- 帧为 `[u32 big-endian length][DeviceEnvelope]`，每条 DataChannel message 不超过 16 KiB，
  单 Device frame 不超过 30 MiB。
- 整帧 admission 在复制 chunks 前串行，排队时间纳入调用 deadline；`bufferedAmount`
  高水位时暂停分片排水，`sendData == false` 关闭整条 channel，不能在半帧后续传。
- relay 先可用；真实 harness 分别在中心拒绝、worker 拒绝以及 P2P open 后继续走原 relay
  `DevicePing/Pong`。真实 relay 使用 generation 1，P2P 使用 generation 2；完整 Router 不在本
  probe 复制，promotion 状态契约另断言 equal/lower generation 为 stale，迟到 open/failure
  不得接管或降级新一代 P2P。
- 中心控制链路消失即主动撤销 P2P。不能依赖远端 `closed` 回调及时到达；真实 probe 会杀中心、
  断言旧 channel 不再响应并记录 libwebrtc 此刻实际状态。

2026-08-25 本机隔离栈代表性记录：DataChannel 从 offer 开始到 open 为 147 ms。XCTest 在测试方法
运行前已经由 dyld 加载 WebRTC.framework，因此不把以下数字误称为“framework 首次加载”：进程
baseline RSS 35,291,136 bytes；完成 control auth、两条负向 offer 并创建空闲 offerer 后为
49,692,672 bytes（增量 14,401,536 bytes，约 13.7 MiB）；DataChannel open 后为
51,462,144 bytes（相对 idle 增量 1,769,472 bytes，约 1.69 MiB）。杀中心并等待旧 channel 业务
超时后，native 观察值仍为
`peer=connected / ICE=completed / DataChannel=open`，但 worker 已不再返回任何业务帧；这把
application ping/timeout 与 control disconnect 主动清理冻结为正式 Router 的硬要求。

上述代表值的验收环境：`MacBookPro18,3`、Apple M1 Pro、32 GiB、arm64，macOS 27.0
(`26A5388g`)，Xcode 26.6 (`17F113`)，Apple Swift 6.3.3。x86_64 runtime load 在同机 Rosetta 2
下执行。性能数字仅用于本次架构门量级判断，不作为跨机器 benchmark 阈值。

## 重复验收

```sh
apps/macos/scripts/test-webrtc-worker-interop.sh
```

该入口使用黑盒 harness 的临时 Postgres 数据库、临时 daemon HOME、临时 git 仓库和动态 loopback
端口；每次栈使用随机密码在 daemon 接入前识别自己的 server，bind 竞争最多换端口重试三次。
server 的 host/auth/daemon URL/relay nodes/STUN/P2P/auto-update 测试环境全部显式钉死；本入口启用
strict cleanup，临时库删除失败会让验收失败。SIGINT/SIGTERM 在栈初始化和 XCTest 阶段均会
主动回收 detached server/daemon/relay 与 xcodebuild/XCTest 进程组。它不读取真实 token、Keychain
或用户工作区。它验证中心拒绝、worker 的 malformed
SDP 拒绝、上述失败前后的 relay 连续性、native↔Rust DataChannel、1 B / 16 KiB / 多 chunk /
29 MiB 上下行、主动关闭与中心断开后的静默生命周期。可注入 writer 另在第二个 chunk 强制
`sendData=false` 等价失败，断言半帧后关闭整条 channel；不把这个单测伪装成 libwebrtc 自己必然
产生过一次 `false`。
29 MiB 上行使用 `DeviceFsWrite` 并以 worker 侧 SHA-256 回读校验；下行使用
`DeviceExecRun/ExecResult.stdout`。生产 `DeviceFsRead` 有独立的 2 MiB 业务上限，probe 不为迁就
transport 测试而放宽它。

本次本机门只证明 native↔Rust 跨栈能力，不宣称生产 STUN/TURN 或跨 NAT 打洞率。计划列出的“两台
不同 NAT/网络的 Mac”外部 acceptance 仍保持未完成，待具备第二台设备与网络时补证；它不阻塞
Milestone 3 的本机安全模型门，也不能在最终 GO 收口时被写成已通过。
