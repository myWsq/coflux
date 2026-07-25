# Plan 041: 本地优先架构集成、迁移与发布验收

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。只有同时承担验证职责时才运行 milestone validation；委派执行者只实现，验证
> 留给 orchestrator。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat 0da4edf..HEAD -- proto crates packages apps tests docs README.md packages/cli package.json pnpm-lock.yaml .github/workflows/ci.yml plans/040-web-local-first-device-transport.md plans/042-device-input-ack-contract.md`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/037-supervisor-sessiond-authority.md, plans/038-worker-local-gateway.md, plans/039-server-control-plane-relay.md, plans/042-device-input-ack-contract.md, plans/040-web-local-first-device-transport.md
- Category: tests
- Planned at: `0da4edf`, 2026-07-25

## Requirement

把已完成的 sessiond、worker gateway、server opaque relay 与待完成的 input ACK、web DeviceRouter
收敛成可发布的本地优先架构，并迁移掉旧 raw replay/server holder/全局 pause 的双重 authority。
最终：

- 同机 browser→daemon 的 terminal 与普通 Device RPC 热路径不经过中心；
- 中心进程和网络完全停止时，已加载且已配对页面仍能快速 list/attach/input/resize/stop；
- direct/relay/worker/control 故障自动恢复，input 与 mutation effect exactly-once，output gap 可检测；
- sessiond 生成的 ANSI snapshot 经独立 xterm.js oracle 和真实 Agent/TUI 语料证明可恢复现场；
- 浏览器兼容、性能、CLI 诊断、迁移清理与文档都有发布证据。

不承诺中心离线后的刷新/冷启动，也不承诺 supervisor/OS 重启后保活 PTY。

## Decisions & tradeoffs

- **唯一 session authority**：发布态只有 supervisor/sessiond 持 PTY、VT/history、holder、sequence
  与 exit tombstone；worker 是 transport/auth adapter，server 只有 control、opaque relay 与
  checkpoint 派生缓存。旧 replay/mirror/holder 可在迁移中短暂兼容，完成时必须删除或成为明确
  无裁决权 adapter。拒绝长期双写。
- **input exactly-once 必须黑盒证明**：除 plan 042 unit tests 外，真实 direct 在 ACK 到达前断开，
  同 input 由 relay 重投时，shell/文件可观察 effect 只能发生一次；累计 ACK 必须最终清理 client
  队列，序号 gap 不得越级应用。拒绝只断言内部 cursor，因为现有 wire 虽声明 exactly-once，
  Apply/Duplicate 却没有成功响应（`proto/coflux/v1/device.proto:307-315`）。
- **snapshot 使用独立 xterm 6 oracle**：测试从真实 sessiond 的 Device attach 取得 ANSI snapshot；
  原始录制流喂给 `@xterm/headless` 6 的 oracle A，snapshot 喂给全新 oracle B，再给两边追加相同
  tail，比较公开 buffer/cell/mode 状态。不得调用 Rust `vt100` 解析结果构造 expected；当前测试
  用同一个 parser 自证（`crates/supervisor/src/sessiond.rs:784-808`），不能发现共同盲点。
- **真实语料可复现且脱敏**：提交 Claude CLI、Codex CLI 和代表性 TUI 的 sanitized ANSI 录制，
  覆盖 normal/alternate screen 切换、resize、滚动、Unicode、颜色和持续输出；CI 只回放 fixture，
  不登录外部服务、不含 prompt、路径、token 或用户内容。拒绝只用手写 escape sequence 宣称
  “Agent 现场可恢复”。
- **明确 snapshot fidelity 边界**：首版保证 Unicode 宽字/组合字、完整逻辑行 history、wrap、
  cursor 位置/可见性、normal/alternate screen、application cursor/keypad、bracketed paste、
  16/256/RGB 前后景及 bold/dim/italic/underline/inverse。sixel/kitty/iTerm images、OSC 8 link
  metadata、title/icon name、cursor shape/color、blink/strike/invisible/underline variants、
  focus/mouse/kitty keyboard state 明确列为非保证项。当前 CellStyle 只保存已保证的样式子集
  （`crates/supervisor/src/sessiond.rs:585-613`）；非保证项不得在文档中暗示完整恢复。
- **中心故障是真实进程故障**：验收要停止/隔离 server，再经 loopback 做 catalog、attach、
  snapshot、input、resize、stop；不能 mock 一个 offline flag。测试 harness 继续只通过真实进程
  与 wire 协议，不读取应用内部对象。
- **failover 证明 effect 而非消息次数**：direct↔relay、worker restart、control restart、
  ACK/response 丢失时，input/op 的外部副作用各一次；output 从 snapshot 自愈；同 logical client
  不出现 detached。另一 client takeover 则必须 detached 且不会自动抢回。现有 handoff 用例是
  单 holder 基线（`tests/src/handoff.test.mjs:14-49`）。
- **慢/断中心不得影响 PTY 进展**：中心 queue 堵塞期间运行大输出 Agent/TUI，进程必须完成，
  local attach 能看到完成 marker；checkpoint 丢弃/滞后可以，sessiond 或 PTY 被反压不可以。
  拒绝用 queue metric 代替行为结果。
- **checkpoint 只做离线画面**：中心保存最近一个有界、带 capturedAt/seq 的派生 snapshot，不用它
  裁决 holder 或跳过首次 live snapshot。旧 offline-view 测试迁移为该语义，不是删掉离线画面
  能力（`tests/src/offline-view.test.mjs:14-46`）。
- **catalog 与 lifecycle 分层**：local catalog 缺席不等于 exit，unknown live session 是 orphan；
  local stop 与中心 task 删除分别收敛，server restart/reconciliation 不杀 orphan，也不把已退出
  session 伪装成中心在线状态。
- **浏览器实机矩阵是发布门**：macOS 当前稳定版 Chrome、Safari、Firefox 都测 cached direct、
  首次无缓存 relay+pair、LNA/loopback permission denied、relay fallback、worker restart 与
  server outage；记录版本和结果。首版只承诺“页面已经加载并配对”，与 plan 022 的无 service
  worker 边界一致。
- **性能 SLO 用可复现 benchmark 守发布，不做脆弱 CI gate**：同机 warm cached direct 至少
  20 次 warmup + 100 次采样；PTY echo p95 <20ms，默认 history attach 到首个可用画面 p95
  <100ms，同时报告最大 history。用 monotonic clock，记录机器/browser/build；CI 防功能回归，
  真实桌面数据决定能否发布。
- **渐进 rollout**：协议/build 失配、固定端口占用、Origin/LNA 拒绝均自动 relay；`cofluxd doctor`
  独立显示 gateway bind、grant、loopback reachability 与中心状态，本地失败只能标“直连降级”，
  不能把 daemon 整体误报 offline。

## Direction

### Milestone 1: input、holder 与 transport 对抗

plan 042/040 的连续 ACK、client queue、session/elevated lanes 与 holder 语义在 daemon/client
unit tests 中稳定；真实黑盒覆盖 ACK 前断线重投、seq gap、direct↔relay promotion、worker restart、
不同 client takeover。Validation:
`cargo test -p coflux-supervisor sessiond_ && cargo test -p coflux-worker && node --import tsx --test packages/client/src/*.test.ts`
-> exit 0。

### Milestone 2: 独立 VT snapshot fidelity

Rust snapshot 单测继续覆盖内部不变量；独立 xterm oracle、sanitized Agent/TUI fixtures 与“原流、
snapshot、相同 tail 后等价”黑盒用例形成发布契约，保证项和非保证项写入架构文档。Validation:
`cargo test -p coflux-supervisor sessiond_` -> exit 0；独立 oracle 作为 acceptance 最后运行。

### Milestone 3: 中心故障、背压与全 Device RPC

server 真停后 local catalog/attach/input/resize/stop 成功；慢/断中心不冻结 PTY；terminal、
project validate/worktree、exec/fs、ports 在 direct/relay 结果等价；checkpoint 与 orphan
reconciliation 保留但无 authority。Validation:
`cargo test -p coflux-supervisor -p coflux-worker && node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`
-> exit 0。

### Milestone 4: browser 与性能发布证据

实机浏览器矩阵记录 permission、fallback、promotion、server/worker fault；benchmark 记录 warm
cached direct 的 echo/attach 分布与 server Device frame 计数，direct hot path 为零中心数据帧。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0；矩阵与 benchmark 作为
acceptance 最后运行。

### Milestone 5: 迁移与发布面收口

删除或降权旧 raw replay/server holder/xterm live mirror 与 dead protocol；CLI status/doctor、
配置、构建、release、architecture/ROADMAP/tmux 边界与故障排查文档反映最终架构。mobile 只做
构建兼容。Validation:
`cargo build -p coflux-supervisor -p coflux-worker && node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit && node_modules/.bin/tsc -b apps/web/tsconfig.json && pnpm -C apps/mobile build`
-> exit 0，Rust 零 warning。

## Landmines

- harness 每个 stack 使用临时 HOME、端口和进程组；gateway、录制与 benchmark 也必须显式使用
  临时端口/目录，绝不能碰真实 `~/.coflux` 或常驻 service（`tests/src/harness.mjs`）。
- 本地 Postgres 测试必须走 54322 直连口；5432 是 Supavisor 池化口，会报
  `no tenant identifier`。不要把环境错误误判成架构回归。
- `tests/src/dec-modes-replay.test.mjs:31-50` 的 250KB raw replay 在 CI 曾需长等待；迁移后应比较
  terminal 状态与 attach latency，不延续“等 raw marker”作为 snapshot 正确性的证明。
- `@xterm/headless` 与 `@xterm/addon-serialize` 已是 server 依赖；oracle 可以复用锁定版本，但
  expected 必须来自原始录制流，不能来自待测 Rust serializer 的中间状态。
- ANSI fixtures 必须以 binary-safe 方式保存并带来源/脱敏说明；禁止录制真实账号、repo 私有输出
  或 Agent 对话内容。
- 浏览器 loopback/LNA 行为尚未实测；不能凭文档或单一 Chromium 结果宣称矩阵完成。
- 集成修复若触及 mobile，只允许恢复共享协议/client 的构建，不得同步 desktop route/orphan UI。

## Scope

In scope:
- `tests/**`
- `docs/**`、`README.md`、`plans/README.md`
- `packages/cli/cofluxd.mjs`
- `package.json`、`pnpm-lock.yaml`、必要 CI/release 配置
- 为集成、迁移和验收修复所需的 plan 036-040、042 组件文件

Out of scope:
- LAN/P2P、远程直连、ICE/STUN/TURN
- service worker、离线 UI 冷启动、native desktop shell
- tmux 式多写端
- supervisor/OS 重启后的活进程恢复
- 为非保证 VT 特性新增完整 terminal emulator
- mobile 新功能
- push、PR、merge、生产部署

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto governance | `cd proto && buf lint && buf generate` | exit 0，三语言生成物一致 |
| Client state-machine | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0 |
| Rust daemon | `cargo test -p coflux-supervisor -p coflux-worker && cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零 warning |
| VT xterm oracle (acceptance) | `node --import tsx --test --test-concurrency=1 tests/src/local-first-vt-oracle.test.mjs` | 原流与 snapshot+tail 的保证状态全部等价 |
| Full black-box (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| Browser matrix (acceptance) | macOS 当前 Chrome/Safari/Firefox：cached direct、无缓存、permission denied、fallback/promotion、worker/server fault | 记录版本与全部结果，无阻断回归 |
| Performance (acceptance) | `node --import tsx tests/src/local-first-benchmark.mjs` | echo p95 <20ms，默认 history attach p95 <100ms，输出完整报告 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] 所有列出的 commands/acceptance 通过。
- [ ] server 完全不可达时，已加载/配对页面仍可 list/attach/input/resize/stop 存活 session。
- [ ] warm cached direct attach 不等待中心响应，且 server 观测不到 terminal/普通 Device 数据帧。
- [ ] direct/relay/worker/control 故障切换对 input/op effect exactly-once，对 output gap 自动取 snapshot 自愈。
- [ ] input queue 只由累计 ACK 清理；ACK 长时间不可达时产生可见背压且没有静默丢弃。
- [ ] session lane 不受 elevated RPC lease/failure 影响；relay 会自动升回 direct。
- [ ] detached 必须显式接管；local catalog 缺席不伪造 exit，orphan 与 lifecycle reconciliation 正确。
- [ ] 独立 xterm 6 oracle 与 Claude/Codex/TUI fixtures 覆盖保证 fidelity，非保证项已写入文档。
- [ ] 慢/断中心期间 Agent/TUI 继续完成，checkpoint 滞后不反压 sessiond。
- [ ] 浏览器矩阵有可复核版本/结果，冷启动边界没有被夸大。
- [ ] 性能报告满足 SLO；不满足时明确阻塞发布而不是放宽指标。
- [ ] server 只持 checkpoint 派生缓存，不持 holder/实时 VT authority，旧双 authority 已清除或明确降权。
- [ ] CLI doctor、架构/运维/ROADMAP 文档与 release 配置反映最终行为。
- [ ] mobile 未新增功能且构建通过。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 行为。
- [ ] `plans/README.md` status 已更新。

## STOP conditions

- 任一成员偏离 plan 036/042 已冻结协议，需要破坏性重做 shared contract。
- 主流目标浏览器均阻止已加载 cloud page 到 loopback WebSocket，且只能靠 native shell/service
  worker 才能继续。
- 独立 xterm oracle 证明保证 fidelity 无法由当前 snapshot 表达，且修复需要实现另一套完整
  terminal emulator；先重新收窄/确认产品保证。
- exactly-once mutation 需要中心与 daemon 做无法恢复的分布式锁，而现有 operation model 无迁移路径。
- acceptance 需要真实用户凭证、私有 Agent 对话或污染常驻 daemon 才能运行。
- 任一 validation 在一次合理修复后连续失败两次。
- 需要生产部署、push、PR 或 merge 才能完成。

## Maintenance notes

这组计划完成后，新增设备能力的默认路径应是“扩 Device endpoint + direct/relay 共用”，而不是在
Hub 新增一对 client↔daemon pending switch。snapshot fidelity 表是公开兼容契约：新增保证必须先
进入独立 oracle/fixture；新增 transport 必须复用 logical client、generation、ACK 与 holder 语义。
