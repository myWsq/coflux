# Plan 033: worker 连接韧性（半死连接自愈）+ 连接态可观测

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 16aad36..HEAD -- crates/worker/src/main.rs packages/cli/cofluxd.mjs tests/src/ apps/server/src/transport.ts apps/server/src/config.ts`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `16aad36`, 2026-07-23

## Requirement

生产事故（2026-07-23）：设备 LVR96VXW43 的 worker 挂在一条"半死"TCP 连接上
12 小时以上不重连。公司网络对长连接静默 drop（无 RST/FIN），server 侧
ping/pong sweep 判死并 `ws.terminate()`（`apps/server/src/transport.ts:73`），
但 worker 侧没有任何对等机制：不主动 ping、无读超时，`stream.next()` 永久
pending。同时 `cofluxd status` 只查 launchd 进程存活就显示"运行中"，用户
看到一切正常，实际设备离线半天。

完成后为真：

1. worker 与 server 之间的连接静默死亡后，worker 在分钟级内自行察觉、断开
   并走既有 backoff 重连循环（`server_loop`，cap 30s）——不再存在永久挂死路径。
2. `connect_async` 不再可能无限挂起（黑洞网络下有限时失败进 backoff）。
3. worker 把连接状态落盘到 `$COFLUX_HOME`，`cofluxd status` 展示真实连接态
   （已连接 / 重连中 + 已持续时长），进程存活不再被误当作"在线"。

正确性的分界：修复必须覆盖"对端完全沉默"的场景（收不到任何入站帧，包括
TCP 层无错误返回）；只处理"send 返回 Err"或只依赖 server 主动 Ping 的方案
是相邻的错误解——事故里 server 已把连接摘除，不会再有任何帧到达。

## Decisions & tradeoffs

- **察觉机制：入站帧 idle watchdog + 主动 Ping 探活**。读循环记录最后收到
  任何入站帧的时刻；idle 超过阈值 → 主动发 WS Ping；再过一段宽限期仍无任何
  入站帧 → 视为连接死亡，退出本次连接（`run_server_connection` 返回），由
  `server_loop` 既有 backoff 重连。"无 Pong"判定简化为"无任何入站帧"——
  任何帧都证明链路活着，无需单独跟踪 Pong。Rejected: 依赖 server 侧 Ping
  （事故场景 server 已摘除连接，永远等不到）；TCP keepalive（粒度粗、跨平台
  配置不一致，且探不出应用层假死）。
  Based on: server sweep 周期 30s（`apps/server/src/config.ts:84`
  `COFLUX_HEARTBEAT_MS` 默认 30_000，`apps/server/src/index.ts:90-93` 定时
  `sweep()` 对无响应连接 `terminate()`）。
- **阈值：idle 75s 触发 Ping，宽限 10s；均可用环境变量覆盖**。75s = 2.5 ×
  server 心跳周期——正常连接每 ≤30s 必收到 server Ping，误伤概率可忽略。
  env 覆盖沿用 worker 既有 `env_or`/`pick` 配置模式（`crates/worker/src/main.rs:177-192`），
  变量命名执行者定；必须可覆盖，否则黑盒测试无法在秒级驱动 watchdog 路径。
  Rejected: 写死阈值——测试没法跑；进 settings.json——用户无需感知，YAGNI。
- **connect 超时：`connect_async` 包 `tokio::time::timeout`（15s，同样 env 可覆盖）**。
  超时按连接失败处理，走既有 backoff。Rejected: 不包超时——黑洞网络下
  TLS/WS 握手可永久挂起，是第二个挂死路径。
  Based on: `crates/worker/src/main.rs:477` 裸 `connect_async(&cfg.server_url).await`。
- **连接态落盘：`$COFLUX_HOME/conn-state.json`，含
  `state`（`connecting` | `connected` | `reconnecting`）+ 状态起始时间戳 +
  最后 authed 时间戳**。`connected` 的判定是 **authed 成功**（收到
  DaemonAuthed/DaemonEnrolled），不是 TCP 建立——TCP 通了但认证没过对用户
  而言仍是不可用。启动初始为 `connecting`，连接断开转 `reconnecting`。
  Rejected: 复用/扩展 `worker.pid`——语义不同；CLI 直连 WS 查询——违反
  CLI 零协议原则（`packages/cli/cofluxd.mjs:194` 明文约定只读文件）。
- **CLI 展示与进程存活联动：服务进程不在时忽略 conn-state.json**。文件是
  worker 生前写的快照，进程死后是 stale 数据，直接显示"未运行"。进程在时
  展示状态 + 该状态已持续时长（`reconnecting` 时用户即知"离线多久"）。
  Based on: `cmdStatus` 已有进程存活判定（`packages/cli/cofluxd.mjs:283-295`）。
- **协议零改动**。watchdog 的 Ping/Pong 是 WS 控制帧，不进业务协议；
  conn-state 是本地文件。`crates/protocol`、`packages/protocol` 不碰。
- **(decided while planning) 黑盒测试以 conn-state 生命周期为主要验收面**：
  `startStack()` 后等 `conn-state.json` 达到 `connected`；停/重启 server
  （harness 已有 `restartServer`，`tests/src/harness.mjs:193`）验证
  `reconnecting` → 恢复后回 `connected`。watchdog 死连接路径建议用测试内
  裸 TCP server 手写 HTTP 101 upgrade 后保持沉默（配秒级 idle env）验证
  worker 有限时内放弃并重连；若该手法在 harness 内代价过大，允许退化为仅
  conn-state 生命周期测试 + 现有全量测试无回归，但需在 plan 状态更新中注明。

## Direction

改动集中三处：worker 读循环/连接循环（`crates/worker/src/main.rs` 的
`server_loop` / `run_server_connection`）、CLI `cmdStatus`、新增黑盒测试。
遵循 AGENTS.md 纪律：cargo 零警告、全部注释中文、提交前三项验证全绿。

### Milestone 1: worker 不再有永久挂死路径，连接态落盘

半死连接在 idle 阈值 + 宽限内被察觉并进入重连；connect 有限时；
`conn-state.json` 随状态机变迁更新。
Validation: `cargo build -p coflux-supervisor -p coflux-worker` → exit 0 且零警告。

### Milestone 2: cofluxd status 展示真实连接态

`cofluxd status` 输出含连接态行（已连接 / 重连中 + 持续时长），进程不在时
不误报。Validation: `node --check packages/cli/cofluxd.mjs` → exit 0
（行为验证归 Milestone 3 黑盒测试与验收）。

### Milestone 3: 黑盒测试覆盖

conn-state 生命周期测试（connected → server 停 → reconnecting → 恢复 →
connected）落在 `tests/src/`；watchdog 死连接测试按上述决策取舍。
Validation: `pnpm -C tests test` → exit 0（含新测试，全量无回归）。

## Landmines

- `crates/worker/src/main.rs:593`：`let _ = sink.send(Message::Pong(p))` 忽略
  发送失败——实现 watchdog 时不要照抄这个模式掩盖发送错误；但也不要依赖
  send Err 作为唯一死亡信号（事故场景 send 进 TCP 缓冲不报错）。
- `crates/worker/src/main.rs:587` 读循环 match 有 `_ => {}` 兜底分支：入站
  `Message::Pong` 目前落在这里被丢弃。刷新"最后入站时刻"必须覆盖所有
  `Some(Ok(_))` 帧（含 Pong），否则探活 Ping 的回包不会刷新 idle 计时，
  watchdog 会误杀健康连接。
- `run_server_connection` 尾部有断线清理逻辑（`main.rs:600-606`：清
  pending-auth、关隧道）——watchdog 断开必须走同一条退出路径（函数返回），
  不要新开旁路跳过清理。
- `tests/` 用 `node --test --test-concurrency=1` 顺序跑（AGENTS.md），新测试
  须用 `startStack()` 起独立栈，勿复用他栈状态；daemon 二进制来自
  `target/debug`，改 Rust 后 `pretest` 会自动重编。
- `cmdStatus` 是同步函数且被 `up` 流程复用（`cofluxd.mjs:185,203`），新增
  读文件展示别把它改成 async 连锁破坏调用点。

## Scope

In scope:

- `crates/worker/src/main.rs`（watchdog、connect timeout、conn-state 落盘；
  如执行者认为拆小模块更清晰，可在 `crates/worker/src/` 下新增文件）
- `packages/cli/cofluxd.mjs`（`cmdStatus` 连接态展示）
- `tests/src/`（新增测试文件；如需可加改 `harness.mjs` 的辅助方法）
- `plans/README.md`（状态更新）

Out of scope:

- `crates/protocol` / `packages/protocol` —— 协议零改动是已定决策
- `crates/supervisor` —— watchdog 与 supervisor 无关
- `apps/server` / `apps/web` / `apps/mobile` —— server 侧机制已完备
- cofluxd 命令面重梳、enrollKey 删除、doctor —— 属 Plan 034（cofluxd 重设计）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建（零警告） | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，无 warning |
| CLI 语法检查 | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| 黑盒测试 (acceptance) | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |

（黑盒测试需本机 Supabase Postgres 54322 直连口，见 AGENTS.md；5432 会报
tenant 错。）

## Done criteria

- [ ] All listed commands pass.
- [ ] 半死连接（对端完全沉默）在 idle 阈值 + 宽限内触发断开重连；阈值可 env 覆盖。
- [ ] `connect_async` 有限时失败，不再可能永久挂起。
- [ ] `conn-state.json` 随 connecting/connected(authed)/reconnecting 变迁更新。
- [ ] `cofluxd status` 进程在时展示连接态与持续时长，进程不在时忽略 stale 文件。
- [ ] 新黑盒测试存在且断言状态迁移，全量测试无回归。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 发现 `run_server_connection` 的退出路径无法同时满足"watchdog 断开"与
  "既有清理逻辑"（说明结构假设错了，需回报而非绕过）。

## Maintenance notes

- idle 阈值（75s）与 server 心跳周期（30s）存在 2.5× 的耦合约定：将来调
  `COFLUX_HEARTBEAT_MS` 需同步审视 worker 侧阈值，否则误杀或迟钝。
- conn-state.json 是 Plan 034（cofluxd 重设计）中 `status`/`doctor` 的数据
  基础，字段扩展向后兼容即可，勿改语义。
