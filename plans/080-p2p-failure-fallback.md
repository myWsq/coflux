# Plan 080: P2P 静默失效的根因与回退——心跳判死接管，relay 兜底不再落空

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat be2e42c..HEAD -- packages/client/src/device-router.ts packages/client/src/device-router.test.ts crates/worker/src/p2p.rs apps/server/src/config.ts`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none（plan 076 已 DONE，本 plan 修它遗留的失效模式）
- Category: bug
- Execution: self
- Planned at: `be2e42c`, 2026-08-17

## Requirement

2026-08-17 生产事故：用户在 Work 机器的浏览器里操作 Home 机器上的终端，表现为**设备显示在线、终端点不动**——不断线、不报错、不超时，就是彻底没反应，持续数小时；刷新页面能好一小会儿又复发。同一时间 iOS 端（走蜂窝网络，且是独立的 Swift 实现）全程正常。

因果链已查明五环，第四环是核心缺陷：

1. **P2P 跨网络连通了，而它本不该通**。生产没配 STUN（`COFLUX_STUN_URLS` 未设置），按 `apps/server/src/config.ts` 的注释，空值时只有 host candidate，跨 NAT 建不起来。但两台机器都挂着 Tailscale，worker 用 `if_addrs::get_if_addrs()` 枚举**全部**非 loopback 接口（`crates/worker/src/p2p.rs:373`），于是 Tailscale 的 `100.x` 成了双方可达的 host candidate。
2. **连上了但不稳**。Home 的 `~/.coflux/daemon.log` 累计 17 条 `p2p channel ... 结束: p2p 写失败: data channel closed` / `p2p 写超时`。该机 Tailscale 接口 `utun1` 的 MTU 为 1380（标准 1500）——**首要怀疑但尚未证实**。
3. **P2P 会顶掉正在正常工作的 relay**：`acceptCandidate`（`device-router.ts:1151`）在非 relay 通道 generation 更高时替换 active 的 relay 通道。这是 plan 076 有意设计的 promotion（"relay 先赢、P2P 后到升级，用户无感"）。
4. **崩掉之后没有任何机制及时发现**。plan 076 把"webrtc-rs 的关闭对 werift 不可感知（仅 ~30s ICE 超时）"当已知限制接受，前提是"既有恢复逻辑"能兜住——但那套逻辑依赖 channel 的 `onclose`，只对 WebSocket（relay/loopback）成立，对 WebRTC DataChannel 不成立。而心跳每 15s 就能发现链路无响应（`sendHeartbeat` 见 `route.pendingPing` 还在），却被明确设计成**只抹 RTT 读数、不摘通道**（`device-router.ts:1950` 的注释："发送失败不在这里判死：那是既有恢复逻辑的职责，心跳只负责让读数别撒谎"）。
5. **于是回退根本没机会触发**。`candidateDone`（`:1178`）里的 `startRelay()` 只覆盖**建连阶段**失败，不覆盖**建成后崩掉**。那 ~30 秒里用户的每次按键都经 `sendOn` 发进一个已死、但状态仍为 open 的 DataChannel。

当前生产靠 `COFLUX_P2P_ENABLED=0` 止血（commit `be2e42c`），等于退回 plan 076 上线前的行为。

**做完之后为真**：

1. 任何 session lane 通道（p2p / relay / direct）在**建成后静默死亡**时，都能在**远快于 ICE 超时**的时间内被摘掉，并触发既有恢复路径重新竞速，让 relay 接管。
2. P2P 反复失败时不会靠 promotion 反复抢走可用的 relay 通道，不产生震荡。
3. 上述行为由 `device-router.test.ts` 的确定性用例覆盖（含负向验证），不依赖真实网络。
4. 以上全部通过后，生产的 `COFLUX_P2P_ENABLED` 恢复为开启，并在真实跨网络场景确认终端可用。

## Decisions & tradeoffs

- **判死职责归心跳，不再等 `onclose`**：`sendHeartbeat` 承担探活，连续无响应即 `loseChannel`，交给既有 `scheduleRecovery`（`:1492`）重新竞速。拒绝方案：给 P2P 单独加一套 DataChannel 存活检测——那只修 P2P，而"通道状态是 open、实际已死"对 relay/loopback 同样可能（中间设备静默丢弃时 WebSocket 也不触发 onclose），心跳是唯一对三种通道都成立的判据。
  Based on: `device-router.ts:1950` 的注释把判死甩给"既有恢复逻辑"，而该逻辑依赖 `onClose` 回调（`:645` loopback、`:743` relay、`:871` p2p），对 DataChannel 需等 ~30s ICE 超时。

- **判死阈值：连续两次心跳无响应，且第二次不等完整周期**。第一次 ping 超过 `HEARTBEAT_TIMEOUT_MS` 无 pong 即记一次失败并立刻补发，第二次同样超时才判死——判死时间因此约 10-15 秒，显著快于 ICE 的 ~30 秒，又留了一次容忍抖动的机会。拒绝方案 A：单次超时判死（5 秒）——对偶发丢包过于敏感，会在正常链路上制造无谓的通道重建。拒绝方案 B：等两个完整心跳周期（~35 秒）——比 ICE 超时还慢，等于没修。
  Based on: `HEARTBEAT_INTERVAL_MS = 15_000`、`HEARTBEAT_TIMEOUT_MS = 5_000`（`:61,63`）；生产实测 RTT relay-bj 31ms、relay-jp 180ms，5 秒对最慢链路仍有 27 倍余量。

- **`HEARTBEAT_TIMEOUT_MS` 目前是死常量，本 plan 让它生效**：`device-router.ts:63` 定义了它、注释还写明"心跳超时远短于普通 RPC 的 20s：心跳测的是链路好坏，等满 20s 才判失败毫无意义"，但**全文件没有任何使用点**。这说明超时判死本就在设计意图内，只是没实现完。实现时用它，不要另起新常量。
  Based on: `grep -n HEARTBEAT_TIMEOUT_MS packages/client/src/device-router.ts` 只有第 63 行定义。

- **判死对 relay 通道同样生效，这是有意的**：不给 p2p 开特例。relay 走 WebSocket，中间设备静默丢弃时同样不触发 onclose（本次事故的 daemon 侧就出现过 45 分钟的 ESTABLISHED 僵尸连接）。误判代价是一次通道重建（recovery 退避 `RECOVER_BASE_MS=350` 起、封顶 5s），远小于一次 30 秒黑洞。
  Based on: `device-router.ts:1492-1510` 的 `scheduleRecovery` 退避实现。

- **P2P 失败必须退避，否则震荡**：判死后重新竞速时 P2P 会再次靠 promotion 抢走刚接管的 relay，崩一次抢一次。参照 `direct` 既有的 `directRetryAttempts` + `scheduleDirectRetry`（`:290,1984-2058`）建立对等机制。拒绝方案：判死后永久禁用该 route 的 P2P——网络恢复后就再也用不上直连，而 P2P 的价值（低延迟）正是为长会话准备的。
  Based on: `acceptCandidate`（`:1151`）的 promotion 分支对 `channel.kind !== "relay"` 一律放行，没有任何失败记忆。

- **隧道接口是否排除出 host candidate，由调查结论决定，不预先拍板**：排除（utun/tailscale/wg）能从源头避免这条不稳链路，但会砍掉"两台机器只在 Tailscale 里互通"这种本来能用 P2P 的场景。Milestone 1 的结论若证实 MTU/隧道是崩溃主因，则做；若主因另有其他（DERP 中继路径、NAT 映射老化等），则不动 worker。**这一条明确委托给执行者，依据是 Milestone 1 的实测结论，不是猜测。**
  Based on: `crates/worker/src/p2p.rs:373` 的 `if_addrs::get_if_addrs()` 枚举全部非 loopback 接口。

- **开关默认值不在本 plan 改**：`config.ts` 的 `p2pEnabled` 保持 `?? "1"`（默认开启），生产的 `COFLUX_P2P_ENABLED=0` 是运维侧的止血值。全部验收通过后由人去生产改回，属于部署动作不是代码改动。
  Based on: `apps/server/src/config.ts` 的 `p2pEnabled` 定义与生产 `/etc/coflux/server.env`。

## Direction

### Milestone 1: 查实 P2P 在隧道链路上崩溃的直接原因

产出一个有实测支撑的结论：DataChannel 崩溃的主因是什么（MTU/PMTU、DERP 中继路径、NAT 映射老化，或其他），并据此决定"是否把隧道接口排除出 host candidate"。结论连同证据写进本 plan 的 Maintenance notes。

这一步需要真实的两机 + Tailscale 环境，属于 acceptance 层，不能用单测替代。可用手段：`daemon.log` 里 p2p 相关记录、worker 侧 webrtc 的 ICE/DTLS 诊断、对隧道接口做 MTU 探测、必要时临时把 `COFLUX_P2P_ENABLED` 打开复现。

Validation: 结论可复现——能说明"在什么条件下 DataChannel 会崩"，并且该条件与生产观测到的 17 次失败一致。

### Milestone 2: 心跳判死接管，通道死亡被及时发现

任一 session lane 的 active 通道连续两次心跳无响应时被 `loseChannel` 摘掉，走既有 `scheduleRecovery` 重新竞速。对 p2p / relay / direct 一视同仁。判死时间显著短于 ICE 的 ~30 秒。

Validation: `node --test packages/client/src/device-router.test.ts` -> exit 0，且新增用例覆盖"P2P 建成后静默崩掉（只停止响应、不触发 onclose）→ 心跳判死 → relay 接管"，并做过负向验证（抽掉判死逻辑该用例必红）。

### Milestone 3: P2P 失败退避，不与 relay 震荡

P2P 建连失败或被判死后进入退避，退避期内不参与竞速、不触发 promotion；成功建立并稳定后重置。

Validation: `node --test packages/client/src/device-router.test.ts` -> exit 0，且新增用例证明"P2P 反复崩溃时 relay 保持接管，不出现 relay→p2p→relay 的反复切换"。

### Milestone 4（仅当 Milestone 1 结论支持）: 隧道接口不进 host candidate

worker 侧枚举 host candidate 时跳过隧道类接口。

Validation: `cargo build -p coflux-worker` -> exit 0 零警告；worker 侧单测覆盖接口过滤规则。

## Landmines

- `device-router.ts:1950` 的注释明确写着心跳"不判死"，本 plan 正是要推翻它——改实现时必须同步改注释，否则下一个读者会以为这是设计意图而不是已修的缺陷。
- `device-router.ts:63` 的 `HEARTBEAT_TIMEOUT_MS` 是死常量（无使用点）。看到它别以为超时判死已经实现了。
- `device-router.ts:1716-1720`：老 daemon 不支持 ping 时会设 `heartbeatUnsupported = true` 并停掉心跳。判死逻辑必须尊重这个标记——否则对老 worker 会因"永远收不到 pong"而无限摘通道。
- `device-router.ts:1957-1961` 现有逻辑：上一发 ping 没回来时，只是把 `pendingPing` 清空并抹掉 rttMs。改成判死后要注意别把"清空 pendingPing"和"记一次失败"混在一起——清空之后下一轮就看不出上一轮失败过了，计数必须独立存放。
- `acceptCandidate`（`:1151`）的 promotion 分支：P2P 通道 generation 更高就直接替换 active relay。退避机制必须在**发起**侧拦住（不去建 P2P），而不是在这里拦——否则已经建好的连接被丢弃，白付一次建连成本。
- `scheduleRecovery`（`:1492`）有 `lane.recoveryTimer !== undefined` 的守卫。判死路径若在 recovery 已排期时再次触发，不会重复排期，但也别指望它会缩短已排的延迟。
- 测试 harness 的 `FakeClock.advance()`（`device-router.test.ts:56`）是同步推进；心跳与判死都挂在 clock 上，用例要按"advance 到超时点 → 断言未判死 → 再 advance → 断言已判死"的方式钉住阈值，否则改了阈值测试也不会红。

## Scope

In scope:
- `packages/client/src/device-router.ts`
- `packages/client/src/device-router.test.ts`
- `crates/worker/src/p2p.rs`（仅 Milestone 4，且仅当 Milestone 1 结论支持）

Out of scope:
- `apps/server/` —— 开关已就位（`be2e42c`），本 plan 不改服务端逻辑；把 `COFLUX_P2P_ENABLED` 改回开启是部署动作。
- `packages/client/src/connection.ts` —— 控制面 WS 的静默链路自愈是另一个洞（无任何探活、且需先改造成可注入时钟才能测），2026-08-17 尝试过并回滚，单独立项。
- `apps/ios/` —— Swift 端是独立实现，本次事故中表现正常；等 web 侧方案验证后再决定是否对齐。
- plan 079 的改动（僵尸 task 自愈 + 升级重试封顶 + 会话链路可观测性）—— 在 git stash `plan 079 WIP` 里，黑盒测试因本机 OrbStack 卡死未跑。
- 生产 caddy 的 `stream_close_delay 5m` —— 与本次无关，待单独回滚。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| client 单测 | `node --test packages/client/src/device-router.test.ts` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| worker 构建（仅 M4） | `cargo build -p coflux-worker` | exit 0，零警告 |
| 真实跨网络验收 (acceptance) | 两台不同网络的机器 + 浏览器操作对端终端，`COFLUX_P2P_ENABLED` 开启 | 终端可用；P2P 崩溃时自动回落 relay，用户无感 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Milestone 1 的结论（含证据）写进本 plan 的 Maintenance notes，并据此明确记录 Milestone 4 做或不做及理由。
- [ ] 新增用例覆盖"P2P 建成后静默崩掉 → 心跳判死 → relay 接管"，且负向验证成立（抽掉判死逻辑该用例必红）。
- [ ] 新增用例覆盖 P2P 反复失败后的退避，证明不与 relay 震荡。
- [ ] 判死逻辑尊重 `heartbeatUnsupported`，老 worker 不会被无限摘通道（用例覆盖）。
- [ ] `device-router.ts:1950` 那条"心跳不判死"的注释已同步更新。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds。
- Milestone 1 无法在合理成本内得出结论——此时停下来报告，不要靠猜测决定 Milestone 4 做不做。
- 判死阈值在测试里被证明无法同时满足"快于 ICE 超时"与"不误摘正常慢链路"——这意味着判据选错了，需要重新设计而不是调数字硬凑。
- The outcome requires out-of-scope files。
- A validation command fails twice after one reasonable fix。

## Maintenance notes

- **本 plan 的存在本身是一条教训**：2026-08-17 当天，在没有测试的情况下两次直接改生产、两次都让情况更糟——第一次把判死后的重连绕过了凭据检查，撞上 `store.ts` 的 `shouldRetry` 只在 `authOk` 后才置 true，连接被推进永久断开态；第二次判死联动 `setControlOnline(false)`，而 `startRelay`/`startP2p` 都有 `!controlOnline` 守卫，等于亲手摧毁所有数据面通道并封死重建路径，把"部分可用"放大成"全面瘫痪"。两次均已回滚。**判死这类逻辑的误判代价会被下游联动放大，必须先有确定性测试再上生产。**
- plan 076 把"webrtc-rs 的关闭对 werift 不可感知（~30s ICE 超时）"记为已知限制并接受，理由是"既有恢复逻辑"能兜住。这个判断在当时就不成立——那套逻辑依赖 `onclose`，而 DataChannel 恰恰不给。**引入新 transport 时，"既有恢复逻辑能兜住"这句话必须逐条验证它依赖的信号在新 transport 上是否存在。**
- 生产 `COFLUX_P2P_ENABLED=0` 是止血值，不是终态。全部验收通过后要记得改回，否则 P2P 会一直是死功能。
- 若 Milestone 4 决定排除隧道接口，注意这会同时影响"两台机器只在 Tailscale 里互通"的合法场景——那种场景下 P2P 会退化为不可用，只能走 relay。
