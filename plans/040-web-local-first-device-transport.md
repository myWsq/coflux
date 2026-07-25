# Plan 040: web/client 真正本地优先的 DeviceTransport

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。只有同时承担验证职责时才运行 milestone validation；委派执行者只实现，验证
> 留给 orchestrator。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat 0da4edf..HEAD -- packages/client apps/web apps/mobile proto/coflux/v1/device.proto crates/supervisor/src/sessiond.rs plans/042-device-input-ack-contract.md`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md, plans/042-device-input-ack-contract.md
- Category: feature
- Planned at: `0da4edf`, 2026-07-25

## Requirement

让 desktop web 的 session attach 恢复路径真正像 tmux：持有 PTY、VT、history 与 holder 的
sessiond 是本机 authority，已配对 browser 直接连接 loopback gateway 后即可取得
`snapshot@N + delta(N+1)`，中心只负责账号、发现、配对/lease 与远程 relay，不进入同机
terminal 热路径。

当前 DeviceRouter 草稿虽然能 direct/relay 切换，但中心在线时会先等待 `pair()` 才读取缓存
grant；所有 scope 又共享一个 active channel，高权限 lease/RPC 会把 terminal 一起拖进中心
路径。完成后：

- 有缓存 grant 时 direct 立即开始，中心 relay 仅作短延迟 hedge；
- 无缓存时 relay 立即可用，pair 在后台完成，随后自动升回 direct；
- 中心完全不可达时，已加载且已配对页面仍能 list/attach/input/resize/stop 存活 session；
- transport 迁移不等于 holder 抢占，输入不重不丢，显式 detached 不会自动抢回。

刷新/离线冷启动仍不保证：当前 PWA 没有 service worker，本计划只承诺已加载页面。

## Decisions & tradeoffs

- **cached direct 不等待中心**：命中本地 grant 后立刻发起 loopback handshake，不先做
  `pair()`、lease 或等待 control WS；中心是否在线只影响 hedge 与高权限能力。拒绝当前
  “control online 就先 pair”的分支，因为它把中心往返重新放进本地 attach 关键路径
  （`packages/client/src/device-router.ts:311-319`）。
- **短延迟 hedge，业务只进 winner**：有缓存时 direct 从 t=0 开始；已认证 control 可在不超过
  200ms 的固定窗口后并发打开 relay。第一个达到“已认证且满足 session scope”的 channel
  先让 terminal 可用；在 winner 确定前不得发送 attach/input/RPC，过期 contender 不得覆盖
  新状态。relay 先赢时不阻塞使用，稍后成功的 direct 可按 generation 规则升为 session lane。
  拒绝双路同时 attach/持续热流，否则同一用户会制造自我迁移与重复恢复。
- **无缓存先 relay、后台 pair**：中心已认证但本地无 grant 时，relay 立即承担现有行为；
  pair/install 不阻塞 relay。pair 成功后主动探测 direct 并迁移；失败只更新诊断，不中断 relay。
  中心离线且无缓存时明确不可用，不伪造本地能力。
- **relay 必须自动升回 direct**：仍有 route demand 时以有界退避+jitter 周期重探本地 gateway；
  direct 恢复后迁移 session lane。拒绝“本次失败后永远 relay，直到刷新页面”；当前 recovery
  只在 active channel 丢失时触发（`packages/client/src/device-router.ts:552-576`）。
- **session lane 与 elevated lane 分离**：SESSION_READ/CONTROL 的长连接永不等待 online lease；
  RPC/LIFECYCLE 可复用一个确实覆盖 scope 的 channel，也可使用独立短期 lane，但其签 lease、
  超时、失败或回退不能替换/关闭健康 session lane。拒绝当前单 `active` + “取最高所需 scope”
  的路由，因为一次 exec 就可能迁走所有 terminal 流量
  （`packages/client/src/device-router.ts:133-147`, `packages/client/src/device-router.ts:579-588`）。
- **同 logical client 迁移，不冒充用户 takeover**：session lane direct↔relay 使用同一
  `clientInstanceId` 与严格递增 generation，sessiond 保持 holder epoch；不同 client 的
  `sessionDetached` 则立即停止自动 attach/replay，只有用户显式点击才能重新接管。当前收到
  detached 后仍保留 `desired=true`，recovery 会再次抢回
  （`packages/client/src/device-router.ts:642-647`）。
- **generation 在 router 生命周期内绝不回退**：同一 tab/clientInstanceId 下，route
  release、reset、scope lane 重建与失败 contender 都不能把某 daemon 的 generation 归零；
  只有新的 clientInstanceId 才开启新序列。拒绝把 generation 只存在可删除的 DeviceRoute
  对象中（`packages/client/src/device-router.ts:133-137`, `packages/client/src/device-router.ts:220-221`）。
- **输入只由 plan 042 ACK 释放**：已接受的 input 按 seq 保留到
  `appliedThroughSeq` 累计确认，迁移时按序重投；达到条数/字节上限时暂停或显式拒绝新输入并
  暴露状态，绝不淘汰旧输入。发送返回 false 也必须进入恢复。拒绝当前超过 256 条/1 MiB 后
  静默 shift 的数据丢失（`packages/client/src/device-router.ts:958-979`）。
- **checkpoint 展示状态不冒充 live resume cursor**：只有同一 terminal consumer 已实际应用
  对应 snapshot@N，N 才能用于 `resume_from_seq`。首版首次 live attach 一律取 sessiond 完整
  snapshot；中心 checkpoint 可离线展示，但不能仅把 sequence seed 到 route。拒绝当前
  `seedCheckpoint` 只写 `outputSeq` 的捷径
  （`packages/client/src/device-router.ts:936-955`, `packages/client/src/device-router.ts:778-800`）。
- **gap/attach 单飞**：同 session/generation 同时最多一个 attach；重复 gap、乱序 delta 与
  timer 只合并为一次恢复，response/失败后才能开启下一次。拒绝每个坏帧都新发 force attach
  （`packages/client/src/device-router.ts:637-640`, `packages/client/src/device-router.ts:766-772`）。
- **control online 等于认证成功**：WebSocket `onopen` 只表示 TCP/WS 建立；router 仅在
  `authOk` 后允许 pair、lease、relay，close/authError/outdated/reset 立即撤销该能力。
  拒绝把 connection 的 `onopen → connected` 当成已认证
  （`packages/client/src/connection.ts:83-86`, `packages/client/src/store.ts:162-175`）。
- **local catalog 只陈述本地事实**：显式 `sessionExited` 才结束本地 session；一次 catalog
  缺席不能推断 exit。中心没有对应 task 的存活 session 作为 local orphan 单独展示。离线 stop
  只停止本机 PTY并记录设备事实，不顺带伪造中心 task 删除；中心 task 删除也不能在没有
  prepared stop 的情况下杀本地 orphan。
- **route 有明确 ownership**：一次 probe 不永久设置 keepAlive；只有 active consumer、desired
  session、pending request/operation 或显式 retain 才持有连接，release 后关闭 socket、interval、
  retry 与 waiter。拒绝当前 `probeDevice` 永久 keepAlive
  （`packages/client/src/device-router.ts:575-576`, `packages/client/src/device-router.ts:877-905`）。
- **RPC deadline 属于请求语义**：fs/ports 等短 RPC 可有默认 deadline；exec 必须尊重调用方/
  wire timeout 并留 transport 余量，不能统一 20s 后只在 client 侧遗弃仍运行的命令。基于当前
  全局 `DEVICE_REQUEST_TIMEOUT_MS`（`packages/client/src/device-router.ts:37-45`,
  `packages/client/src/device-router.ts:848-867`）。
- **mobile 继续冻结**：mobile 只注册 relay/旧兼容 adapter，不做 loopback 探测、配对 UI、
  orphan UI 或 desktop 新功能；共享 client/protocol 变化仅做最小构建修复。

## Direction

### Milestone 1: 可确定测试的 transport arbiter

DeviceRouter 的 clock/timer、WebSocket/relay、identity 与随机 ID 边界可在 Node 内确定驱动；
状态机测试覆盖 cached-direct hedge、no-cache relay+background pair、relay→direct promotion、
concurrent scope、stale contender、close/reset 与 generation 单调。Validation:
`node --import tsx --test packages/client/src/*.test.ts` -> exit 0。

### Milestone 2: session continuity 与输入提交

session lane 独立迁移；attach/gap 单飞；detached 必须显式恢复；checkpoint 与 live cursor 分离；
plan 042 ACK 精确释放输入前缀，队列满与 send failure 不丢数据。Validation:
`node --import tsx --test packages/client/src/*.test.ts && node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit`
-> exit 0。

### Milestone 3: desktop web 本地 catalog/holder UX

web 在用户进入目标设备/工作区时 retain/probe，在离开时 release；中心 snapshot 更新不再驱动
holder 重抢，local catalog 合并 orphan 与明确 offline 状态。已加载页面在 control 断开后仍可
attach/控制，未配对或无 app shell 时诚实回退。Validation:
`node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0。

### Milestone 4: Device RPC 迁移与兼容收口

terminal、git/fs/exec、导入浏览、ports 与 prepared lifecycle 均经相应 lane；direct 不可用时
relay 行为等价，高权限失败不影响 terminal。必要诊断只展示 direct/relay/permission/offline，
不重做工作台；mobile 仅保持构建。Validation:
`pnpm -C apps/mobile build && node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`
-> exit 0。

## Landmines

- 计划时 `packages/client/src/browser-identity.ts` 与 `device-router.ts` 是未跟踪的用户草稿；
  它们是需审慎整合的现有工作，不得删除、reset 或整文件覆盖后掩盖原 diff。
- xterm consumer 必须先注册再 attach，现有注释记录过先发 replay 导致字节丢失
  （`apps/web/src/components/workbench/terminal-pane.tsx:421-422`）；snapshot/delta 仍需保持顺序。
- web 目前用中心 `snapshotRevision` 触发 active terminal 重抢 holder
  （`apps/web/src/components/workbench/workspace-terminal.tsx:336-352`）；它必须与 Device lane
  migration 分离，detached 也不得被 workspace 显示切换绕过。
- `activate` 当前会立即给所有 desired session 强制 attach，再关闭 previous
  （`packages/client/src/device-router.ts:521-550`）；hedge contender 若复用该行为会双 attach。
- `closeRoutes` 先调用 channel.close，但 socket close callback 可反向进入 recovery
  （`packages/client/src/device-router.ts:1199-1213`, `packages/client/src/device-router.ts:552-561`）；
  teardown 必须使晚到 callback 失效。
- 浏览器不能读取 `$COFLUX_HOME`；不得随机扫端口或引入 native helper。固定 loopback 失败、
  LNA permission denied 与 Mixed Content 都是正常 relay 分支。

## Scope

In scope:
- `packages/client/**`
- `apps/web/**`
- `apps/mobile/**` 仅共享层变化导致的最小构建修复
- 为 client state-machine 测试所需的 package script/config
- `plans/README.md`

Out of scope:
- `proto/**`、`crates/**` — 先完成 plan 042；本计划不再临时发明 ACK
- `apps/server/**` 的运行行为 — 已完成的 control/opaque relay 契约不变
- service worker、离线冷启动 app shell、本地元数据数据库
- LAN/P2P、浏览器扩展、native shell、loopback preview reverse proxy
- mobile 新功能或本地直连
- VT snapshot fidelity 扩展与浏览器实机矩阵 — 由 plan 041 验收
- 工作台视觉重构

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Client state-machine tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Client typecheck | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Server compatibility | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] 所有列出的 commands 通过；真实 stack/browser/performance 留给 plan 041。
- [ ] cached-grant happy path 的 direct handshake/attach 不等待任何中心 response。
- [ ] direct 慢/失败时 relay 在 hedge 窗口后可用；无缓存时 relay 不等待 pair，且成功配对后会升回 direct。
- [ ] session lane 不因 RPC/LIFECYCLE lease、超时或失败而迁移/关闭。
- [ ] winner 选择、relay→direct promotion、close/reset 与并发 scope 均无双 attach、旧 contender 覆盖或 generation 回退。
- [ ] input 只按累计 ACK 释放；ACK 丢失/transport 切换可重投，队列满与发送失败均不静默丢数据。
- [ ] detached 后不会自动抢回；只有显式用户接管才恢复 attach/input replay。
- [ ] checkpoint 不会让首次 live attach 跳过必要 snapshot，重复 gap 不形成 attach storm。
- [ ] control 只有 authOk 后才 online，route release 后无遗留 socket/timer/poll/waiter。
- [ ] local orphan、显式 exit、离线 stop 与中心 task lifecycle 的 UI/状态含义互不冒充。
- [ ] direct unavailable、权限拒绝或版本失配时现有 relay 行为完整。
- [ ] mobile 无新功能且构建通过。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 文件。
- [ ] `plans/README.md` status 已更新。

## STOP conditions

- plan 042 尚未完成，或 ACK 最终语义与本计划的累计连续前缀不一致。
- user-owned 未跟踪草稿与本合同存在无法局部整合的冲突。
- session/elevated lane 分离需要破坏 plan 036 已冻结的 holder/generation 语义。
- 目标 browser 只能通过 native shell/service worker 才能建立任何 loopback 连接。
- 正确实现需要 server 解释 DeviceEnvelope 或新增第二套业务协议。
- 任一 validation 在一次合理修复后连续失败两次。

## Maintenance notes

DeviceRouter 是连接“本地 session authority”和多个 transport adapter 的状态机。以后增加 LAN/P2P、
本地 preview 或新 RPC，应扩展 lane/capability，不应把中心控制请求重新放进 cached local session
的 attach 路径，也不应让业务组件各自复制 direct/relay fallback。
