# Plan 041: 本地优先架构集成、迁移与验收

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat febdd62..HEAD -- proto crates packages apps tests docs packages/cli package.json pnpm-lock.yaml .github/workflows/ci.yml`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/037-supervisor-sessiond-authority.md, plans/038-worker-local-gateway.md, plans/039-server-control-plane-relay.md, plans/040-web-local-first-device-transport.md
- Category: tests
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

把四个成员实现收敛成可发布的本地优先架构，迁移掉旧 raw replay/server holder/全局 pause 的
双重 authority，补齐黑盒、协议、浏览器兼容、性能基线、CLI 诊断与架构文档。最终同机
browser→daemon 的 Device 热路径不经过中心；中心完全停止时，已加载且已配对页面仍能快速
恢复并控制存活 PTY；任何 direct 故障都能自动回到现有中心 relay。

## Decisions & tradeoffs

- **一次 authority，允许迁移 adapter**：最终只有 sessiond 持 holder/seq/VT truth；旧 replay 与
  server holder 可在组内过渡，但 plan 完成时必须删除或变成明确兼容 adapter。拒绝长期双写。
- **黑盒优先验收**：继续用真实 server + Rust supervisor/worker + WS 协议，不从内部对象断言，
  保持重构语言/边界后仍有效。基于 `tests/src/harness.mjs` 与 AGENTS.md 的测试哲学。
- **中心故障是一级用例**：必须真的停止/隔离 server，再通过 loopback client 做 catalog、attach、
  snapshot、input、resize、stop；不是 mock “offline” flag。
- **背压测试看 Agent 是否继续**：中心 queue 堵塞/断开期间持续大输出必须完成，local attach 能
  看到完成 marker；不以 queue metric 代替行为。
- **故障切换必须证明 exactly-once effect**：direct 在 ACK 前断开、同 op/input 经 relay 重投，
  shell/文件/exec 的可观察副作用只发生一次；output gap 通过 snapshot 自愈。
- **云端离线画面保留但允许短周期滞后**：checkpoint cache 只读、带明确 capturedAt/seq；不要求
  逐字节实时，不允许它反压 sessiond。
- **渐进 rollout**：协议/build version 不兼容、端口占用、Origin/LNA 拒绝均自动 relay；CLI doctor
  显示 local gateway 独立层状态，但不把它误报为 daemon 整体离线。
- **性能 SLO 是发布基线而非脆弱 CI gate**：同机合成 PTY echo p95 目标 <20ms，默认历史 attach
  到首屏 p95 目标 <100ms；CI 记录/比较，真实桌面测量决定是否达标。

## Direction

### Milestone 1: 端到端 session authority

现有 reconnect/worker restart/handoff/DEC replay 用例迁移到 snapshot/seq/lease，且新增 server
完全离线的 local attach/input/resize/stop。Validation: 相关黑盒测试文件 -> exit 0。

### Milestone 2: transport/auth/failover 对抗

Origin、nonce replay、错误 gateway/browser key、grant revoke、lease 过期、端口占用、版本失配、
direct↔relay 竞速与 worker restart 全有正负用例。Validation: local auth/transport 黑盒 -> exit 0。

### Milestone 3: 全 Device RPC 与 prepared op

terminal、project validate/worktree、exec/fs、ports 经 direct 与 relay 结果等价；mutation 重投只有
一次副作用，server restart/catalog reconciliation 不杀 orphan。Validation: Device RPC/operation
黑盒 -> exit 0。

### Milestone 4: checkpoint、背压与性能

中心离线可看最后 checkpoint；慢/断中心不冻结 PTY；内存/history 有界；输出/attach 性能有可
复现报告。Validation: backpressure/checkpoint tests exit 0，benchmark 产出记录。

### Milestone 5: 发布面收口

CLI status/doctor、配置、构建、release 双二进制、文档与 ROADMAP 反映新架构；server xterm mirror
依赖与 dead protocol/code 清除，mobile 仅做构建兼容。Validation:
`cargo build -p coflux-supervisor -p coflux-worker && node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit && node_modules/.bin/tsc -b apps/web/tsconfig.json`
-> exit 0。

## Landmines

- harness 当前每 stack 用临时 HOME/端口/进程组；gateway 测试也必须使用独立端口或明确 override，
  不能碰用户真实 `~/.coflux` 或常驻 service。
- `tests/src/offline-view.test.mjs:14-16` 断言 server mirror；应迁移为 checkpoint 语义且保留能力，
  不是简单删除测试。
- `tests/src/dec-modes-replay.test.mjs:31-50` 在 CI 上 250KB replay 曾需 30s；新测试应验证终端状态
  等价与 attach latency，而不是继续等待 raw marker 来证明模式。
- `tests/src/handoff.test.mjs:14-49` 是现有单 holder 契约；必须扩展 direct/relay 跨路径，而非改成
  多写以让测试通过。
- `cofluxd doctor` 当前按中心 DNS→TCP→TLS→WS 分层；local gateway 是独立诊断层，失败只提示
  “直连降级”，不能覆盖中心连接状态。
- 浏览器工具本轮没有可用实例，Chrome/Safari/Firefox loopback 行为尚未实测；发布前矩阵是明确
  acceptance gap，不能凭 MDN/Chrome 文档宣称完成。

## Scope

In scope:
- `tests/**`
- `docs/**`、`README.md`、`plans/README.md`
- `packages/cli/cofluxd.mjs`
- `package.json`、`pnpm-lock.yaml`、必要 CI/release 配置
- 为集成修复所需的 plan 036-040 组件文件

Out of scope:
- LAN/P2P、远程直连、ICE/STUN/TURN
- service worker/offline UI 冷启动
- tmux 多写端
- supervisor/OS 重启后的活进程恢复
- mobile 新功能
- push、PR、merge、生产部署

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto governance | `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0 |
| Rust daemon | `cargo test -p coflux-supervisor -p coflux-worker && cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零 warning |
| Full black-box (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| Browser matrix (acceptance) | macOS Chrome/Safari/Firefox：direct、LNA 拒绝、relay fallback、worker restart | 记录全部结果，无阻断回归 |
| Performance (acceptance) | 同机 synthetic PTY echo 与默认/上限 history attach benchmark | p95 报告满足目标或明确阻塞发布 |

## Done criteria

- [ ] 所有列出的 commands/acceptance 通过。
- [ ] server 完全不可达时，已加载/配对页面仍可 list/attach/input/resize/stop 存活 session。
- [ ] direct 热路径没有中心 Device 数据帧，中心恢复/故障不改变 local PTY 进展。
- [ ] worker restart 后 fixed gateway、grant、catalog、holder 与 snapshot 自动恢复。
- [ ] direct/relay failover 对 input/op exactly-once，对 output gap 可检测自愈。
- [ ] 全 app 内 daemon RPC 共享 Device router，relay 无逐 RPC 复制实现。
- [ ] 中心只持 checkpoint 派生缓存，不持 holder/实时 VT authority。
- [ ] 固定端口、Origin、pairing、grant/lease 与 UDS 文件权限有负向覆盖。
- [ ] tmux 边界、离线边界、浏览器回退与 future multiwriter 路径写入架构文档。
- [ ] mobile 未新增功能且构建通过。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 行为。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- 任一成员偏离 plan 036 已冻结协议，需要破坏性重做 contract。
- 主流目标浏览器均阻止 HTTPS cloud page 到 loopback WS，且只能靠 native shell/service worker
  才能继续。
- exactly-once mutation 需要中心与 daemon 做无法恢复的分布式锁，而现有数据模型无迁移路径。
- 相关 validation 在一次合理修复后连续失败两次。
- 需要生产部署、push、PR 或 merge 才能完成。

## Maintenance notes

这组计划完成后，新增设备能力的默认路径应是“扩 Device endpoint + direct/relay 共用”，而不是在
Hub 新增一对 client↔daemon pending switch。中心可继续变强，但不能重新进入本地 PTY 热路径。
