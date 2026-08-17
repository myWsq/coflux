# Plan 079: 僵尸 task 自愈 + 升级重试封顶 + 会话链路可观测性

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat a74f011..HEAD -- apps/server/src/hub.ts apps/server/src/auto-update.ts apps/server/src/transport.ts apps/server/src/store.ts crates/relay/src/main.rs tests/src/harness.mjs`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: self
- Planned at: `a74f011`, 2026-08-17

## Requirement

用户反馈"经常有会话创建出来、但不能操作卡住"。2026-08-17 的生产诊断查明这是一个**永久死态**，不是瞬时抖动：

生产库里 `status=running` 的 task 有 38 个，全部挂着 `session_id`，最老的 `updated_at` 是 7/26，其中包含已离线 7 天的设备（`Svend-Mac-mini.local`）和停在 7/31 的 task。这些 PTY 早就不存在了，但中心仍认为它们在跑。用户侧的表现正是"卡住"：

- attach 不上 —— PTY 不在 daemon 上；
- 想重开也不行 —— `hub.ts:1840` 的守卫见 `status === RUNNING && sessionId` 就回 "任务已在运行，请通过 DeviceTransport attach"，直接拒绝重建 session；
- 关掉 tab 重开也没用 —— 死态在中心的持久状态里，不在前端。

根因是**中心对"session 已死"只有一条信源，而那条信源会丢**：`reconcileSessionCatalog`（`hub.ts:356-441`）只做两件事——把 catalog 里**存在**的 session 正向补齐成 RUNNING，以及处理 tombstone 里的 exit 事件。对"中心认为 RUNNING+sessionId、但本次全量 catalog 里缺席"的 task 完全不处理。而 tombstone 活在 supervisor 的内存里（`crates/supervisor/src/sessions.rs:519` 的 `device_catalog` 从 `self.tombstones` 取），机器重启 / `cofluxd restart` 一次就全丢，中心那边就永远 RUNNING。

同批诊断还查出两个把这个死态**触发得更频繁**的问题，一并在本 plan 修掉：

- `auto-update.ts:119-125` 的重试封顶形同虚设：冷却期一过 `rec.count = 0`，于是失败的机器被永远重试。生产实证：daemon `b5d8d5f7`（YouRan Master）从 8/15 起被派了 50 次同一个 v0.26.0，至今没装上；`bf24034a` 21 次。每次派发都换一次 worker、断一次连。
- 会话链路几乎没有线上日志：这次诊断只能靠"caddy reload 时刻 30/30 与 daemon 集体断连秒级对齐"这类时间戳反推。session 生命周期全是 debug（线上 info 不落盘），session.create 派发与 rendezvous 的失败分支零日志，relay 的"等待对端配对超时"（3 天 265 条）不带 channelId/role，无法定位是哪台设备、哪一端没来。

**做完之后为真**：

1. daemon 重连做全量 catalog 对账时，中心认为在跑、而 daemon 说不存在的 session，其 task 被收敛为 EXITED 并清空 sessionId —— 用户重开会话即可用，无需人工清库。
2. 同一个 daemon + 同一个目标版本的自动升级，累计派发次数真正封顶，不再随冷却周期无限重开；放弃时留一条 warn。
3. 下一次出现同类故障时，能直接从线上日志读出"哪台设备、哪条 session、哪一端没来"，而不必靠时间戳对齐反推。

## Decisions & tradeoffs

- **反向收敛的判据**：全量 catalog 中缺席 = 该 PTY 已不存在。拒绝方案：等 tombstone —— tombstone 是 supervisor 的内存态，机器重启即全丢，等于把持久状态的收敛权交给一个不持久化且会重启的组件，这正是本 bug 的成因。
  Based on: `crates/supervisor/src/sessions.rs:519-546` 的 `device_catalog` 返回 PTY map 的**全量快照** + 全部未 ack tombstone；PTY 活在 supervisor，worker 热升级不影响它（`AGENTS.md` 的 supervisor/worker 分工）。

- **只在 catalog 路径收敛，绝不动 legacy resync 路径**：反向收敛只加在 `reconcileSessionCatalog`（`hub.ts:356`）。`reconcileDaemonSessions`（`hub.ts:1234-1252`）保持原样，其"absence 不是 exit 事实"的注释与实现都不许改。理由：那是老 worker 的 `daemon.resync` 路径，其 `alive` 列表不保证全量；catalog 才有全量语义。
  Based on: `hub.ts:1238-1251` 的注释与实现；`hub.ts:348-350` `requestSessionCatalog` 在每次 `registerDaemonConn` 时发出（`hub.ts:308`）。

- **收敛条件必须同时满足三条**：task 属于本 daemon（`daemonId` 匹配且 `accountId === daemon.accountId`）、`status === RUNNING`、`sessionId` 非空且不在本次 catalog 的 session 全集里。拒绝方案：只看 "有 sessionId 就收敛" —— 会误杀在途的 agent 终端创建，那条路径建库时 `status: TaskStatus.IDLE` 但 `sessionId` 已写死，PTY 尚未起来。
  Based on: `hub.ts:489-505`（`sessionId` 建库即写死、status 为 IDLE）；`hub.ts:1852-1880` 的 client 创建路径 sessionId 只进 prepared operation 的 metadata、不进 task。

- **缺席判定用 catalog 的原始 sessionId 全集，不用 `live` map**：`live` 是**过滤后**的结果，per-entry 校验（cwd 超长、`retainedBytes` 超 4MB、pid/cols/rows 畸形）会 `continue` 跳过条目，用它判缺席会把被截断掉的活 session 误杀。取全集时只要求 `validControlId(session.sessionId)` 通过。
  Based on: `hub.ts:360-376` 的 per-entry `continue` 分支；`hub.ts:83-85` 的 `MAX_CATALOG_ENTRIES` / `MAX_CATALOG_PATH_BYTES` / `MAX_RETAINED_CATALOG_BYTES`。

- **误杀是自愈的，这是本方案敢做的底气**：万一某个 PTY 其实还活着只是这次 catalog 没带上，下一次 catalog 会经既有正向补齐把它写回 RUNNING（`hub.ts:392-395`）。所以反向收敛的失败模式是"用户多点一次重开"，不是"活 PTY 被杀"——中心不因此向 daemon 发任何 `sessionClose`。**收敛动作只改中心的持久状态与内存映射，绝不向 daemon 下发任何关闭指令。**

- **exitCode 记为未知（null）**：中心确实不知道它是怎么死的，不许编造 0 或 -1。`store.updateTask` 传 `exitCode: undefined` 即写 null。
  Based on: `apps/server/src/store.ts:78` `exitCode: number | null`、`:920-924` `updateTask` 的 `"exitCode" in patch` 分支。

- **不碰 prepared operation**：反向收敛只做 `updateTask(EXITED, sessionId=undefined, exitCode=undefined)` + 清中心 `sessions` 映射 + 广播 task。指向同一 sessionId 的未完成 prepared operation 交给既有 TTL 路径（`expirePreparedOperations`）收敛。拒绝方案：顺手 `finishPreparedOperationFromExit` —— 那需要一个我们并不知道的 exitCode，且把两套独立状态机耦合起来。
  Based on: `hub.ts:410-434` exit 路径的 `finishPreparedOperationFromExit` 需要真实 exitCode；`hub.ts:672,708,737` 的 TTL 收敛路径。

- **自动升级按 daemonId+version 永久封顶**：达到 `autoUpdateMaxAttempts` 后不再重试，除非目标版本变了（key 里已含 version）。冷却期到期只允许"尚未用满次数"的继续，绝不重置计数。代价：一次偶发失败会让该机器在**本次 server 生命周期内**不再自动升级（`attempts` 是内存 Map，server 重启自然给回重试机会）—— 可接受，13 次失败还不成的机器再试 50 次也不会成，只会白白断连。放弃时打一条 warn（每个 daemonId+version 只打一次，不要每轮轮询都打）。
  Based on: `apps/server/src/auto-update.ts:116-131` 的 `key`/`rec.count = 0`；`config.ts:160-161` maxAttempts=3、cooldown=1h、poll=10min。

- **日志按位置逐条处置，不做"debug 一律升 info"的一刀切**：线上现在 7 天 6.7 万行，升级后不许出现数量级膨胀。逐条见 Direction 的 Milestone 3 表格。特别地，`catalog reconciled`（`hub.ts:441`）与 `daemon resync`（`hub.ts:1251`）**保持 debug** —— 前者每次 daemon 重连都会打，生产 3 天有 14315 次重连，升 info 就是刷屏。
  Based on: 生产 `journalctl -u coflux-server` 7 天 6.7 万行；3 天 `daemon authed` 14315 次。

- **`daemon disconnected` 的原因要从 WS close 事件取**：`attachEndpoint` 现在的 `onClose(ctx)` 不带 code/reason，需要扩展这个回调签名，两个 endpoint（daemon 与 client）都受影响。心跳判死走 `ws.terminate()` 表现为 code 1006，与对端正常关闭可区分。
  Based on: `apps/server/src/transport.ts:58-66` 的 `ws.on("close")`、`:71-84` sweep 里的 `ws.terminate()`。

- **relay 的配对超时日志带 channelId 与 role**：两者在该错误分支的作用域内已经拿得到，不需要新增状态。
  Based on: `crates/relay/src/main.rs:41-42`（`claims`/`role` 解出、`channel_id` 取出）与 `:287-293` 的超时分支在同一函数内。

## Direction

三个里程碑互不依赖，可按任意顺序做，但建议按下列顺序（1 是本 plan 的目的，2、3 是配套）。

### Milestone 1: 僵尸 task 在 daemon 重连时自愈

`reconcileSessionCatalog` 在完成既有的正向补齐与 tombstone 处理之后，再做一次反向收敛：取本 daemon 名下的 task，把满足收敛三条件的 task 收敛为 EXITED、清空 sessionId、清中心 `sessions` 映射、广播 task 更新。收敛发生时（且仅在发生时）打一条 info，带 daemonId、taskId、sessionId、本次收敛条数。

`store.listTasksByDaemon(daemonId)` 已存在，直接用。

测试：黑盒新增用例，制造"session 存在过、但 tombstone 已丢失"的现场——重启整个 daemon 进程树（supervisor 一并重启才会丢 tombstone；只杀 worker 不行，PTY 与 tombstone 都在 supervisor 里活着），复用同一个 `COFLUX_HOME` 让它以同一设备身份重连，断言 task 从 RUNNING 收敛为 EXITED 且 sessionId 被清空。harness 目前只有 `stopDaemon()`、没有重启能力（`tests/src/harness.mjs:428`），按需扩展它——这在 scope 内。用例必须做负向验证：抽掉反向收敛后它必须失败。

Validation: `node --test tests/src/<新用例>.test.mjs` -> exit 0，且抽掉实现后该用例失败。

### Milestone 2: 自动升级重试真正封顶

同一 daemonId + 同一目标版本累计派发达到上限后彻底停止，冷却期到期不再重置计数。放弃时一条 warn（每个 key 只打一次）。

现有用例 `tests/src/auto-update.test.mjs:151`（"坏版本反复推送被退避封顶"）的窗口只有 4.8 秒、cooldown 设的是 60 秒，从未跨过冷却期，所以抓不到这个 bug —— 新增或改造用例必须**跨过冷却期**（把 `COFLUX_AUTOUPDATE_COOLDOWN_MS` 设成秒级），断言总推送次数仍封顶在 `maxAttempts`，而不是每个冷却周期再来 3 次。既有那条用例的断言（`=== 3`）在本改动后应当继续成立，不要改坏它。

Validation: `node --test tests/src/auto-update.test.mjs` -> exit 0。

### Milestone 3: 会话链路可观测性

逐条处置，不许扩大：

| 位置 | 现状 | 目标 |
| --- | --- | --- |
| `hub.ts:1196` session started | debug | info（带 sessionId/taskId/pid） |
| `hub.ts:1209` session exit | debug | info（带 sessionId/exitCode） |
| `hub.ts:441` catalog reconciled | debug | **保持 debug** |
| `hub.ts:1251` daemon resync | debug | **保持 debug** |
| session.create 的失败分支（`hub.ts:1844-1850`：daemon 不在线 / 工作区不存在 / 项目删除中；`:685-687` prepared 上限） | 只回 client error | warn，带 daemonId/taskId |
| prepared operation 失败与超时（`hub.ts:739` `failPreparedWaiters`、`:776-780` waiter 超时） | 无 | warn，带 operationId/daemonId/kind |
| relay/P2P rendezvous 的全部 fail 分支（`hub.ts:1932-2060` 的 `handleDeviceRelayConnect` / `handleDeviceP2pOffer` / `handleDeviceP2pChannelOpen`） | 只回 client error | warn，带 daemonId + 失败原因 |
| `hub.ts:1356` daemon disconnected | info，无原因 | info，带 close code 与 reason |
| `crates/relay/src/main.rs:292` 等待对端配对超时 | 无标识 | 带 channelId 与 role |

`daemon disconnected` 带原因需要扩展 `transport.ts` 的 `onClose` 回调签名（现在只收 ctx），daemon 与 client 两个 endpoint 都要跟着改。

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；`cargo build -p coflux-relay` -> exit 0 且零警告。

## Landmines

- `hub.ts:360-376`：per-entry 校验用的是 `continue`，`live` map 是**过滤后**的集合。拿它当"daemon 上还活着的 session 全集"来判缺席会误杀被截断掉的条目。缺席判定必须另取 `catalog.sessions` 的原始 sessionId 集合。
- `hub.ts:489-505`：agent 终端创建路径建库时 `status: TaskStatus.IDLE` 且 `sessionId` 已写死，PTY 此刻尚未存在。收敛条件漏掉 `status === RUNNING` 就会打断每一次 agent 终端创建。
- `hub.ts:1238-1251` `reconcileDaemonSessions`：注释"absence 不是 exit 事实"针对的是 **legacy resync** 路径，那里的 `alive` 不保证全量。不要顺手把反向收敛也加到那里。
- `hub.ts:380-383`：正向补齐里有一段"EXITED 且已由 prepared operation 记录过退出"的跳过逻辑。反向收敛发生后，同一 session 如果又出现在后续 catalog 里，会走这段——设计上不冲突（我们清了 sessionId），但改动时别把这段的条件破坏掉。
- `tests/src/auto-update.test.mjs:151`：这条既有用例的通过**不能**证明封顶生效——它的窗口短于冷却期。别把它当回归基线就完事。
- `tests/src/harness.mjs:428` `stopDaemon()` 杀完就把 `ref.daemon` 置 null，没有重启路径；`stack.stop()` 会连临时目录一起删。要复用同一设备身份重连，得保住 `COFLUX_HOME`。
- 每个 `*.test.mjs` 顶部各占一个独立 PORT，新增测试文件要挑没被占用的端口（见 `AGENTS.md` 测试 harness 一节）。

## Scope

In scope:
- `apps/server/src/hub.ts`
- `apps/server/src/auto-update.ts`
- `apps/server/src/transport.ts`
- `crates/relay/src/main.rs`（仅 Milestone 3 的配对超时日志，是唯一超出 apps/server 的生产代码）
- `tests/src/harness.mjs`（按需加 daemon 重启能力）
- `tests/src/*.test.mjs`（新增用例 / 改造 auto-update 用例）
- `plans/079-*.md`、`plans/README.md`

Out of scope:
- `crates/supervisor`、`crates/worker` —— 本 plan 的判据建立在 supervisor 现有的 catalog 全量语义之上，不需要动它，动了反而要重新论证。
- `packages/client`、`apps/web`、`apps/mobile`、`apps/ios` —— client 侧的恢复路径已在探索阶段核实是完整的（`setControlOnline(true)` 全量重建 lane、恢复退避封顶 5s、`closeLane` 无泄漏），卡住不在那里。
- `proto/` 与两侧 protocol 包 —— 本 plan 不新增任何线协议字段。
- 生产 caddy 配置 —— 已在探索阶段完成（四处 `reverse_proxy` 加 `stream_close_delay 5m` 并 reload 生效）。
- daemon `YWR07M6KQ1` 三天重连 13637 次的根因 —— 需要在那台 Mac 上取证，另行处理。
- 清理生产库里已有的 38 条历史僵尸 task —— 本 plan 让它们在各自 daemon 下次重连时自动收敛，不写一次性清库脚本。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| relay 构建 | `cargo build -p coflux-relay` | exit 0，零警告 |
| 黑盒集成测试（全量） | `pnpm -C tests test` | exit 0（既有基线：`cli-doctor` 两项因本机环境失败，与本 plan 无关） |
| 单文件黑盒 | `node --test tests/src/<file>.test.mjs` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 黑盒用例证明：daemon 整树重启（tombstone 丢失）后重连，中心的 RUNNING+sessionId task 被收敛为 EXITED 且 sessionId 清空；抽掉实现该用例失败。
- [ ] 黑盒用例证明：跨过冷却期后，同一 daemon+version 的升级派发总次数仍封顶在 `autoUpdateMaxAttempts`。
- [ ] Milestone 3 表格里每一行都按目标处置，且 `catalog reconciled` 与 `daemon resync` 仍是 debug。
- [ ] 收敛路径全程不向 daemon 下发任何 session 关闭指令（`sessionClose` / `sessionStop` 在 diff 中零新增调用）。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds —— 尤其是 supervisor 的 `device_catalog` 不再返回全量快照，那样整个判据就塌了。
- 收敛逻辑无法在不触碰 `reconcileDaemonSessions` 的前提下实现。
- The outcome requires out-of-scope files（特别是需要动 supervisor/worker 或新增 proto 字段）。
- A validation command fails twice after one reasonable fix。
- 黑盒用例的负向验证不成立（抽掉实现后用例仍然通过）。

## Maintenance notes

- 本 plan 只治 **RUNNING + sessionId** 这一种僵尸。还有一种同源但表现不同的：agent 终端创建路径（`hub.ts:489-505`）建库时是 **IDLE + sessionId**，若 PTY 从未起来，task 会永远停在 IDLE 且带着一个不存在的 sessionId。它不撞 `hub.ts:1840` 的守卫，所以不表现为"卡住"，暂不处理——如果日后发现侧栏有永远 IDLE 的幽灵终端，根因在这里。
- 生产的 38 条历史僵尸会随各自 daemon 的下一次重连自动收敛。离线设备（如 `Svend-Mac-mini.local`）名下的会一直留着，直到那台机器再上线，这是符合预期的：中心不该替一台不在线的设备判定它的 PTY 死活。
- 升级永久封顶是内存态（`attempts` Map），server 重启即清空。若日后发现"某台机器升级失败后一直不升级"，先看 server 有没有重启过，再看 warn 日志里那条放弃记录。
- 这次诊断的完整证据链（caddy reload 与集体断连 30/30 秒级对齐、relay 配对超时 265 条、38 条僵尸 task 的时间分布）不在代码里。Milestone 3 补的日志就是为了让下一次不必再做这种考古。
- 生产 caddy 的 `stream_close_delay 5m` 经实测**只是把断连延后 5 分钟，并未消除集体断连**（2026-08-17 实测：reload 于 05:16:14，5 台 daemon 于 05:21:14 同秒断开）。它的价值是给正在进行的 rendezvous/attach 一个 5 分钟宽限窗口、并让断连与部署负载尖峰错开。要真正消除，得把 coflux 从 cc-host 共享的那份 `/etc/caddy/Caddyfile` 里摘出去（独立入口），未立项。
