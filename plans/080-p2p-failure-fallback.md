# Plan 080: 静默死亡的链路自愈——控制面探活、判死不连坐、数据面通道各自判活

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 71c543b..HEAD -- packages/client/src/connection.ts packages/client/src/store.ts packages/client/src/device-router.ts packages/client/src/device-router.test.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH（改的是连接生命周期与通道竞速的核心状态机；2026-08-17 已有两次未测试就上生产、两次都放大故障的记录）
- Depends on: none
- Category: bug
- Execution: self
- Planned at: `71c543b`, 2026-08-17（主因判断于同日调查后修订，见 Requirement）
- Result: **DONE（代码里程碑）**。M1/M2/M4/M5 沿用既有实现；M3 于 2026-08-28 完成：
  浏览器 `/client` 普通 transport 短断立即撤 control waiter、online lease、elevated lane 与新
  rendezvous 权限，但既有 relay/P2P session lane 有 15 秒有界宽限；同凭据 `authOk` 在窗口内
  恢复会继续使用同一 channel，超时或 authError/clientOutdated/换凭据/reset/destroy/logout 则
  hard revoke。client 单测 56/56 通过。生产开关、真实 NAT/STUN 与 Safari/Firefox/iOS 属外部验收。

## Requirement

2026-08-17 生产事故：用户在 Work 机器的浏览器里操作 Home 机器上的终端，表现为**设备显示在线、终端点不动**——不断线、不报错、不超时，持续数小时；刷新页面能好一小会儿又复发。同一时间 iOS 端（走蜂窝网络、独立 Swift 实现）全程正常。

**主因（调查修订后）**：控制面 WebSocket 被中间网络静默掐断——不发 FIN 也不发 RST，两端 TCP 都还是 ESTABLISHED。于是：

```
控制面 WS 静默死亡
  → ws.onclose 永不触发，client 的 controlOnline 仍为 true，readyState 仍为 OPEN
  → send() 把消息写进黑洞且不报错，rendezvous 请求石沉大海
  → 与此同时链路上已建立的 relay / p2p 通道也被掐断
  → 想重建：startRelay / startP2p 都有 `!controlOnline` 守卫、都要先 rendezvous
  → 干等，彻底卡死，且永不自愈（重连只由 onclose 驱动）
```

**初版 plan 把主因判成"P2P 崩溃 + 心跳不判死"，调查证据推翻了它**，记录于此以免重蹈：

- Home 的 `daemon.log` 里 17 次 p2p 失败，**15 次是 `data channel closed`**（写之前 channel 已关），只有 2 次写超时。MTU 受限链路的症状应是超时与丢包，不是"已关闭"——**MTU/Tailscale 假设无证据支持**。
- 那 15 次是**被对端主动关闭**的结果，不是自身崩溃。两侧是对称设计：client 在 `setControlOnline(false)` 时主动 `loseChannel` 掉全部 relay + p2p 通道（`device-router.ts:2549-2552`）；worker 侧同样"每次中心断开 close_all 清空全部 PeerConnection"（`crates/worker/src/main.rs:420` 注释）。
- **决定性反证**：中心日志显示 Home 的 daemon 从 14:05 起一条 `disconnected` 都没有（直到人工重启 worker），所以 Home 侧的 `close_all` 不可能被触发——那些 channel 只能是 Work 那端的浏览器关的，而它关的原因正是**它自己的控制面断了**。
- 事故当天关闭 P2P 后用户恢复，但同一动作重启了 `coflux-server`（所有连接因此重建）且用户刷新了页面，**把恢复归因于关闭 P2P 证据不足**。

P2P 在这条链里是受害者而非元凶：relay 通道同样被摧毁、同样重建不了，只是 relay 重建只需一次 rendezvous，而 P2P 还要走完整 ICE 协商，所以显得更糟。

**做完之后为真**：

1. 控制面 WS 静默死亡能被 client 自己发现，并在十几秒量级内完成重连——不依赖 `onclose`，不依赖用户刷新页面。
2. 判死与重连的路径不会把连接推进任何不可恢复的死角（凭据、状态机、联动清理都不留缺口）。
3. 数据面通道（relay / p2p / direct）拥有自己的存活判据，不必等 `onclose`——后者对 WebRTC DataChannel 要 ~30s ICE 超时才来。
4. P2P 反复失败时不会靠 promotion 反复抢走可用的 relay 通道。
5. 以上全部由确定性单测覆盖（含负向验证），不依赖真实网络、不靠上生产试。

## Decisions & tradeoffs

- **控制面判死的判据取"发出消息后是否还有任何入站帧"，不做定期心跳**：链路正常时任何一次 client→server 操作都会在几秒内引来入站流量（广播 / error / checkpoint）；静默死亡时是彻底的寂静。拒绝方案 A：新增 proto 心跳消息——要动 proto + server + 三端，代价与收益不成比例，且 buf 用远程插件、一改要同时生成 TS/Rust/Swift。拒绝方案 B：纯 idle 判据（超过 N 秒无入站即判死）——页面空闲时服务端本就不发消息，会误判。
  Based on: `packages/client/src/connection.ts` 全文无任何探活，重连唯一入口是 `ws.onclose`；`proto/coflux/v1/client.proto` 的 `ClientToServer` oneof 无任何心跳消息。

- **判死后只 `close()`，让 `onclose` 驱动重连，绝不自行调用重连**：与"服务端主动关闭"完全同构，凭据判断（登出 / 版本失配）一并复用。拒绝方案：判死时提前摘掉 socket 引用并直接调 `scheduleReconnect`——2026-08-17 实测这样会绕过 `reconnectCredential()`，撞上 `store.ts` 的 `shouldRetry` 只在 `authOk` 之后才置 true，**连接被推进永久断开态，比不修更糟**。
  Based on: `packages/client/src/store.ts` 的 `reconnectCredential: () => (shouldRetry && token ? { token } : null)` 与 `shouldRetry` 仅在 `authOk` 分支置 true。

- **本地已有会话 token 即视为可自动重连**：`shouldRetry` 初始为 false，导致刷新后的第一条连接若在 `authOk` 到达前断掉（被掐、或 server 的 15s authDeadline 关闭），会永久停在断开态等用户再刷一次。这个洞早于本次改动就存在，本 plan 一并修掉。清零点（authError / clientOutdated / logout）保持不变。
  Based on: `store.ts` 的 `let shouldRetry = false;` 与三处清零点。

- **控制面判死不得连坐摧毁数据面通道**：`setControlOnline(false)` 现在会主动 `loseChannel` 掉全部 relay + p2p 通道，同时 `startRelay`/`startP2p` 的 `!controlOnline` 守卫封死重建——两者叠加意味着控制面一抖，数据面全废且无法自救。2026-08-17 的第二次改砸正是踩了这个：判死联动 `setControlOnline(false)`，把"部分可用"放大成"全面瘫痪"。**本 plan 必须保证控制面的短暂抖动不会造成数据面的全毁重建**，具体做法（宽限窗口 / 延迟收敛 / 仅在确认断开后收敛）由执行者设计，但必须有用例证明"控制面抖动一次并快速恢复"不会摧毁正在工作的 relay 通道。
  Based on: `device-router.ts:2547-2560` 的 `setControlOnline(false)` 分支；`:1201`（`startRelay`）与 `:1219`（`startP2p`）的 `!controlOnline` 守卫。

- **worker 侧的对称 `close_all` 本 plan 不动**：改它要重新论证"中心断开后 daemon 还该不该信任既有 channel 的授权"，那是 plan 043/076 的安全语义，超出本次范围。因此 client 侧的宽限只在**控制面快速恢复**的前提下有意义——这也正是本 plan 把控制面探活放在首位的原因。
  Based on: `crates/worker/src/main.rs:420` 注释"每次中心断开 close_all 清空全部 PeerConnection"。

- **数据面通道的判死归心跳，阈值为连续两次无响应且第二次不等完整周期**：判死时间因此约 10-15 秒，显著快于 WebRTC 的 ~30s ICE 超时，又留一次容忍抖动的机会。拒绝方案 A：单次超时（5s）判死——对偶发丢包过于敏感。拒绝方案 B：等两个完整心跳周期（~35s）——比 ICE 超时还慢，等于没修。判死对 relay/direct 同样生效（WebSocket 在静默丢弃下同样不触发 onclose）。
  Based on: `HEARTBEAT_INTERVAL_MS = 15_000`、`HEARTBEAT_TIMEOUT_MS = 5_000`（`device-router.ts:61,63`）；生产实测 RTT relay-bj 31ms、relay-jp 180ms，5 秒对最慢链路仍有 27 倍余量。

- **`HEARTBEAT_TIMEOUT_MS` 目前是死常量，本 plan 让它生效**：`device-router.ts:63` 定义了它、注释写明"心跳超时远短于普通 RPC 的 20s"，但全文件无任何使用点——超时判死本就在设计意图内，只是没实现完。实现时用它，不要另起新常量。
  Based on: `grep -n HEARTBEAT_TIMEOUT_MS packages/client/src/device-router.ts` 只有第 63 行。

- **P2P 失败必须退避**：否则判死后重新竞速时 P2P 会再次靠 promotion 抢走刚接管的 relay，崩一次抢一次。参照 `direct` 既有的 `directRetryAttempts` + `scheduleDirectRetry`（`:290,1984-2058`）建立对等机制。拒绝方案：判死后永久禁用该 route 的 P2P——网络恢复后就再也用不上直连。退避必须拦在**发起**侧（不去建 P2P），而不是在 `acceptCandidate` 里丢弃已建好的连接。
  Based on: `acceptCandidate`（`:1151`）的 promotion 分支对 `channel.kind !== "relay"` 一律放行，无任何失败记忆。

- **`connection.ts` 必须先可注入时钟**：现在用裸 `window.setTimeout`/`setInterval`，无法写确定性测试。而本 plan 的全部价值都建立在"有测试"之上——2026-08-17 两次未测试就上生产、两次都放大故障。参照 `device-router.ts` 既有的 clock 注入（`createDeviceRouter` 的 `clock` 参数与 `device-router.test.ts:56` 的 `FakeClock.advance`）。
  Based on: `connection.ts` 内 `window.setTimeout` 直接调用；`device-router.test.ts:267` 的 `harness(adapter, clock)`。

## Direction

Milestone 顺序即风险顺序：先把可测性建起来，再动状态机。

### Milestone 1: `connection.ts` 可注入时钟，既有行为不变

`createConnection` 接受可选 clock（默认取 `window`），退避重连改用它。新增 `connection` 的测试文件，用假时钟覆盖既有行为：认证包发送、指数退避的时序、`stop()` 后不再重连。

Validation: `node --test packages/client/src/connection.test.ts` -> exit 0。

### Milestone 2: 控制面静默死亡自愈

发出消息后开始等回音，超时无任何入站帧即判死；判死只 `close()`，重连由 `onclose` 驱动；已有 token 的首连纳入自动重连。

Validation: `node --test packages/client/src/connection.test.ts` -> exit 0，用例须覆盖：(a) 发消息后无回音 → 判死 → 重连；(b) 有回音 → 不判死；(c) 认证回执迟迟不到 → 判死后**仍能**重连（守住 `shouldRetry` 死角）；(d) 空闲不收发时不判死。(a)(c) 做负向验证。

### Milestone 3: 控制面抖动不再连坐摧毁数据面

浏览器控制面短暂断开时，`setControlDisconnected()` 立即撤销只在 online control 下才安全的
能力（control waiter、online lease、elevated lane、新 relay/P2P rendezvous），但对已经建立的
relay/P2P session lane 给 15 秒有界宽限。同凭据自动重连在窗口内收到 `authOk` 后取消 timer，
保留原 channel；超时则关闭远端 channel。authError、clientOutdated、显式换凭据、reset、destroy、
logout 走 `setControlOnline(false)` hard revoke，立即收敛。control generation token 同时拦截
断线前发起、断线后才完成的异步 open，以及跨代旧 timer。

worker 的 `/daemon` 是另一条独立控制连接：它若断开，仍按既有在线授权语义立即
`close_relays()` + `p2p.close_all()`；浏览器宽限不改变 worker 授权边界。

Validation: `node --import tsx --test packages/client/src/device-router.test.ts` -> exit 0。用例覆盖
窗口内同一 relay、15 秒超时、hard revoke、迟到 open 和旧 timer 跨代五条路径。

### Milestone 4: 数据面通道心跳判死

任一 session lane 的 active 通道连续两次心跳无响应即被 `loseChannel`，走既有 `scheduleRecovery` 重新竞速。对 p2p / relay / direct 一视同仁，且尊重 `heartbeatUnsupported`。

Validation: `node --test packages/client/src/device-router.test.ts` -> exit 0，用例覆盖"P2P 建成后静默停止响应（不触发 onclose）→ 心跳判死 → relay 接管"，并做负向验证。

### Milestone 5: P2P 失败退避

P2P 建连失败或被判死后进入退避，退避期内不发起、不参与竞速、不触发 promotion；稳定后重置。

Validation: `node --test packages/client/src/device-router.test.ts` -> exit 0，用例证明 P2P 反复失败时 relay 保持接管，不出现 relay→p2p→relay 反复切换。

## Landmines

- `store.ts` 的 `shouldRetry` 只在 `authOk` 后置 true。任何"判死→重连"路径若绕过 `reconnectCredential()`，都会在认证完成前判死时把连接推进**永久断开态**。2026-08-17 实测踩过。
- `device-router.ts:2547-2560`：`setControlOnline(false)` 会主动摧毁全部 relay + p2p 通道，且 `:1201`/`:1219` 的 `!controlOnline` 守卫同时封死重建。**控制面判死会连坐引爆这两处**，这是把"部分可用"放大成"全面瘫痪"的机制，2026-08-17 实测踩过。
- `device-router.ts:1950` 的注释明确写着心跳"不判死"，本 plan 要推翻它——改实现时必须同步改注释。
- `device-router.ts:63` 的 `HEARTBEAT_TIMEOUT_MS` 是死常量（无使用点），别以为超时判死已实现。
- `device-router.ts:1716-1720`：老 daemon 不支持 ping 时设 `heartbeatUnsupported = true` 并停心跳。判死逻辑必须尊重它，否则老 worker 会因"永远收不到 pong"被无限摘通道。
- `device-router.ts:1957-1961`：现有逻辑在上一发 ping 未回时只清 `pendingPing` 并抹 rttMs。改成判死后要注意，清空之后下一轮就看不出上一轮失败过——失败计数必须独立存放。
- `acceptCandidate`（`:1151`）的 promotion：P2P generation 更高就替换 active relay。退避必须拦在发起侧，否则白付一次建连成本。
- `scheduleRecovery`（`:1492`）有 `lane.recoveryTimer !== undefined` 守卫，判死路径在 recovery 已排期时不会重复排期，也不会缩短已排的延迟。
- `FakeClock.advance()`（`device-router.test.ts:56`）同步推进；用例要按"advance 到阈值前 → 断言未判死 → 再 advance → 断言已判死"钉住数值，否则改了阈值测试也不会红。
- `connection.ts` 的 `send()` 在 `readyState !== OPEN` 时静默丢弃消息（既有行为）。这也是一种"操作没反应"的来源，但不在本 plan 范围，别顺手改。

## Scope

In scope:
- `packages/client/src/connection.ts`
- `packages/client/src/store.ts`
- `packages/client/src/device-router.ts`
- `packages/client/src/device-router.test.ts`
- `packages/client/src/connection.test.ts`（新增）

Out of scope:
- `crates/worker/` —— 对称的 `close_all` 涉及 plan 043/076 的授权语义，改它要重新论证安全模型。
- `apps/server/` —— `COFLUX_P2P_ENABLED` 开关已就位（`be2e42c`）；把它改回开启是部署动作不是代码改动。
- `proto/` —— 本 plan 不新增任何线协议消息（控制面判据刻意选了不需要服务端配合的那种）。
- `apps/ios/` —— Swift 端独立实现，本次事故中表现正常；等 web 侧方案验证后再决定是否对齐。
- 隧道接口是否排除出 host candidate —— 初版 plan 的 MTU 假设已被证据推翻，该问题不再是本 plan 的一部分。
- plan 079（僵尸 task 自愈 + 升级重试封顶 + 会话链路可观测性）—— 在 git stash `plan 079 WIP` 里。
- 生产 caddy 的 `stream_close_delay 5m` —— 与本次无关，待单独回滚。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| connection 单测 | `node --import tsx --test packages/client/src/connection.test.ts` | exit 0 |
| device-router 单测 | `node --import tsx --test packages/client/src/device-router.test.ts` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| 外部真实跨网络验收 | 两台不同网络的机器 + 浏览器操作对端终端 | 链路被掐后自动恢复，无需刷新页面 |

## Done criteria

- [x] 所列代码命令通过（connection + device-router 合计 56/56；web 类型检查通过）。
- [x] Milestone 2 的 (a)(c) 与 Milestone 4 的用例都做过负向验证（抽掉实现该用例必红）。
- [x] 存在用例证明控制面抖动一次并快速恢复后，relay 通道未被摧毁重建。
- [x] 判死逻辑尊重 `heartbeatUnsupported`，老 worker 不会被无限摘通道（用例覆盖）。
- [x] `device-router.ts` 的心跳注释已同步为判死语义。
- [x] 任何判死路径都不绕过 `reconnectCredential()`。
- [x] Required tests exist and assert meaningful behavior.
- [x] Implementation follows every entry in Decisions & tradeoffs。
- [x] M3 代码仍只改 `packages/client` 既定范围；worker/Swift/proto 零改动。
- [x] `plans/README.md` status is updated.

外部验收（不冒充代码完成）：

- [ ] 生产重新开启 `COFLUX_P2P_ENABLED`。
- [ ] 两地真实 NAT/STUN 链路断连恢复与打洞成功率实测。
- [ ] Safari / Firefox 与 iOS 真机回归。

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds。
- 判死阈值在测试里被证明无法同时满足"快于 ICE 超时"与"不误摘正常慢链路"——判据选错了，重新设计而非调数字硬凑。
- Milestone 3 的"不连坐"在不动 `crates/worker` 的前提下做不到——停下报告，那意味着要重新论证 worker 侧的授权语义。
- The outcome requires out-of-scope files。
- A validation command fails twice after one reasonable fix。

## Maintenance notes

- **本 plan 的存在本身是一条教训**：2026-08-17 当天在没有测试的情况下两次直接改生产、两次都让情况更糟。第一次判死后的重连绕过凭据检查，撞上 `shouldRetry` 死角，连接进入永久断开态；第二次判死联动 `setControlOnline(false)`，摧毁所有数据面通道并封死重建路径，把"部分可用"放大成"全面瘫痪"。两次均已回滚。**判死这类逻辑的误判代价会被下游联动放大，必须先有确定性测试再上生产。**
- **初版 plan 的主因判断（P2P 崩溃 + MTU）是错的**，被 `data channel closed` 占 15/17、以及"Home 控制面全程未断"这两条证据推翻。留在 Requirement 里作为记录：**在多环因果链上，"关掉 X 之后好了"不足以证明 X 是元凶**——当时同一动作还重启了 server、用户还刷新了页面。
- plan 076 把"webrtc-rs 的关闭对 werift 不可感知（~30s ICE 超时）"记为已知限制并接受，理由是"既有恢复逻辑能兜住"。这个判断在当时就不成立——那套逻辑依赖 `onclose`，而 DataChannel 恰恰不给。**引入新 transport 时，"既有恢复逻辑能兜住"必须逐条验证它依赖的信号在新 transport 上是否存在。**
- 生产 `COFLUX_P2P_ENABLED=0` 是止血值不是终态。本 plan 验收通过后应改回开启，否则 P2P 是死功能。
- 事故当天未能取得的关键证据：Work 那台机器浏览器 console 的 WS 报错。下次复现时应优先抓取，它能直接坐实"控制面静默死亡"这一环。
