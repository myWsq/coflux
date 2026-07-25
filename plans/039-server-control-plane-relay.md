# Plan 039: server 收敛为控制面 + relay

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat febdd62..HEAD -- apps/server proto/coflux/v1 packages/protocol/src apps/server/src/mirror.ts apps/server/src/hub.ts apps/server/src/store.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: migration
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

把中心从设备操作与 session holder 的语义执行者收敛为账号/设备认证、发现、项目/task 元数据、
browser pairing、短期 online lease、prepared operation、opaque Device relay 与 checkpoint cache。
direct 与 relay 必须共用同一 Device frame；中心故障不得影响已配对同机页面接管存活 session，
但离线期间仍不允许项目/task CRUD 或高权限 daemon RPC。

## Decisions & tradeoffs

- **中心保留业务元数据 truth，放弃活 session truth**：project/workspace/task 与授权记录仍在
  Postgres；sessiond catalog 对 PTY 是否活着、seq、holder/exit 是权威。拒绝双主离线 CRUD。
- **relay 只做 channel 级鉴权/路由**：server 校验 client account 与 daemon 归属、payload 大小/
  rate/version，然后原样转发 Device envelope；不再为 exec/fs/terminal 各维护 pending registry。
  当前语义中继集中在 `apps/server/src/hub.ts:130-139`, `apps/server/src/hub.ts:460-474`。
- **配对由中心背书但不掌握 browser 私钥**：持久化 browser public key/grant 元数据，在线时把
  grant 安装/撤销到指定 daemon，并向 client 返回可信 gateway public key/端口/协议版本。
- **online lease 短期滚动**：只对当前已认证 client、在线且属于同账号的 daemon 签发/安装；
  server/daemon channel 断开即不再续期。拒绝长期全权限 local grant。
- **跨面 mutation 先持久 prepare**：start/stop/worktree 等用不可复用 op ID 和目标版本/CAS；
  direct/relay 可重投同一 operation，只有 daemon fact/ack 才完成状态。拒绝只放内存
  `PendingRegistry`，当前 registry 会随 server 重启消失（`apps/server/src/hub.ts:136-139`）。
- **resync 不再杀未知活 PTY**：已知 task 按 catalog/tombstone 收敛；unknown/mismatched session
  保留为 local orphan，不自动建业务 task，也不发 `sessionClose`。当前实现会关闭它
  （`apps/server/src/hub.ts:500-505`），与本地 authority 冲突。
- **holder 从 server 删除**：task attach/input/resize 的最终裁决来自 Device channel；server 不再
  比较 `RuntimeSession.holder`（现状 `apps/server/src/hub.ts:876-895`）。
- **mirror 变 checkpoint cache**：server 存最后一个验证过 daemon/session/seq 的有界 ANSI
  checkpoint，daemon 离线 attach 仍可只读查看；cache 可丢、可过期，不解析 live bytes。
  拒绝每 session 常驻 `@xterm/headless`（`apps/server/src/mirror.ts:20-39`）。
- **旧路径只作迁移兼容**：同一部署版本已有 build skew 门禁，可按计划组一次切换；不得长期维护
  两套 holder/relay authority。

## Direction

### Milestone 1: pairing、grant 与 lease 控制面

持久化模型、账号隔离、安装/撤销 ack、gateway identity 与 lease 生命周期具备正负测试；删除设备/
登出能在在线时收敛授权，离线撤销延迟被明确记录。Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 2: opaque relay channel

client/daemon channel open/close/frame 在 account、daemon、client connection 生命周期内正确清理；
server 不解析 Device RPC 业务 oneof，非法大小/归属/版本拒绝。Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 3: durable prepare 与 reconciliation

start/stop 等 operation 经 server restart、direct/relay 重投、late ack 与 daemon full catalog 都能
幂等收敛；unknown live session 不被杀，offline exit tombstone 恢复真实 exit fact。Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；行为测试留给 plan 041 黑盒。

### Milestone 4: checkpoint cache

只接受目标 daemon 对活 session 的单调 checkpoint；过旧/跨账号/超限 payload 拒绝；daemon
离线时可下发最后只读画面，server restart/cache miss 安全降级。Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；行为测试留给 plan 041 黑盒。

## Landmines

- `RuntimeSession` 当前把 route、holder、closing、start timeout 与 mirror 混在一个内存对象
  （`apps/server/src/hub.ts:112-124`）；不能一次删除而漏掉 task timeout/端口路由清理。
- start 当前先发 daemon 再立即把 task 标 running（`apps/server/src/hub.ts:1105-1117`）；prepared
  op 必须重新定义 crash window，而不是在其外再套 request ID。
- daemon close 当前保留 runtime session 以支持 mirror；改成 checkpoint 后仍要维护 task/port 的
  可见语义，不能把“离线”误当“已退出”。
- token 数据库只存 hash（`apps/server/src/store.ts:3-5`）；browser public key 不是 bearer secret，
  但 grant/lease ID 与撤销语义仍需明确，不能把私钥或 raw clientToken 落库。
- public preview TCP tunnel 目前依赖 server 语义路由；本计划不把它误包装成 web Device channel，
  现有外部 URL 必须保持可用。

## Scope

In scope:
- `apps/server/src/**`
- `apps/server/package.json` 中 server mirror/runtime 依赖调整

Out of scope:
- supervisor/worker 实现
- web loopback/WebCrypto 实现
- public preview URL 与 proxy gate 迁出中心
- 离线项目/task CRUD

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Existing e2e (acceptance) | `pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] 所有非 acceptance commands 通过；acceptance 留给 plan 041。
- [ ] relay 不含逐 RPC 业务分支，account/daemon/channel 校验完整。
- [ ] pairing/grant/lease 可持久、可撤销且绝不处理 browser 私钥。
- [ ] prepared op 与 full catalog/tombstone 在重启/重投后幂等收敛。
- [ ] unknown live session 不被中心自动关闭。
- [ ] server 不再拥有 holder 或实时 VT parser；checkpoint 只是有界缓存。
- [ ] public preview 与现有远程 relay 没有行为回退。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 文件。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- 设备归属无法在不解析 Device payload 的前提下于 channel open 阶段可靠绑定。
- prepared operation 需要破坏既有 task 数据且没有安全迁移路径。
- checkpoint 替换 mirror 会不可避免地移除现有 daemon 离线只读画面。
- validation 在一次合理修复后连续失败两次。

## Maintenance notes

中心仍是可信控制面，不等于它必须在每个 byte 的因果链上。未来新增 daemon RPC 时只扩 Device
协议和 endpoint handler；server relay 不应再次长出对应 pending/dispatch 分支。
