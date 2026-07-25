# Plan 037: supervisor 演进为本机 sessiond

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat febdd62..HEAD -- crates/supervisor/src crates/supervisor/Cargo.toml crates/protocol/src/ipc.rs crates/worker/src/dec_modes.rs tests/src/dec-modes-replay.test.mjs`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: refactor
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

把 supervisor 从“PTY + 200KB raw scrollback + 全局 pause”提升为真正的本机 sessiond：无论
worker、中心或 client 是否存在，都持续消费 PTY、维护可恢复的 VT grid/history、session
catalog、单调 output sequence、单 holder lease 与 exit tombstone。attach 必须原子返回
规范化 ANSI snapshot 与无缝后续 delta；任何慢 transport 都不能冻结 Agent 进程。

## Decisions & tradeoffs

- **结构化终端状态取代 byte ring**：使用成熟 Rust VT parser，保存有界 logical-line history、
  viewport、光标、SGR、alt screen 与输入模式。拒绝继续 raw ring；它会任意裁剪 UTF-8/escape
  （`crates/supervisor/src/sessions.rs:114-121`），现有 worker 只补 DEC 私有模式且明确忽略 SGR
  （`crates/worker/src/dec_modes.rs:1-7`, `crates/worker/src/dec_modes.rs:143-147`）。
- **先做兼容性实证再锁 parser**：首选 plan 036 冻结的轻量 parser 依赖，但必须用 xterm/Agent
  语料验证 wide/combining chars、truecolor、cursor、wrap、erase、alt-screen、bracketed paste、
  resize；不通过不得以手写补丁堆成半套模拟器。
- **按完整行有界保留**：history 行上限可配置，并有全局内存预算；默认值由多 session 内存与
  attach benchmark 决定。拒绝无限落盘和按字节裁剪。
- **每 session 串行 authority**：PTY 输出解析、sequence 推进、attach 注册、holder 变更与
  input 去重必须在同一串行边界内完成，避免“取完快照才订阅”的 gap。当前全局
  `Mutex<HashMap<...>>`（`crates/supervisor/src/sessions.rs:27-35`）不是新并发语义的依据。
- **慢消费者丢 delta、绝不 pause PTY**：每个 logical channel 有有界投递状态；溢出后标记 gap
  并要求 snapshot。移除 worker queue 反压到全部 PTY 的机制，当前 pause 会在
  `crates/supervisor/src/sessions.rs:102-109` 停住所有 reader。
- **holder 绑定 logical client 而非 socket**：不同 client 才抢占并递增 epoch；同 client 的
  更高 transport generation 迁移 channel，旧 generation 后续 input/resize 被拒。
- **worker 重启不丢状态**：catalog、holder、sequence、近期 whole-frame retransmit ring 与未 ack
  exit tombstone 都在 supervisor；worker resync 后可重建本地/relay channel。基于现有 worker
  restart 保活保证（`tests/src/worker-restart.test.mjs:9-10`）。
- **tmux 存活边界**：只承诺 supervisor 与 PTY 活着时恢复；supervisor/机器退出后不恢复活进程，
  不新增磁盘录像或 CRIU。

## Direction

### Milestone 1: VT snapshot 等价性

给终端状态层建立纯 Rust 单测与录制语料；任意 chunk 边界喂入后生成的 ANSI snapshot 写入
参考终端时，viewport、history tail、光标与关键模式等价。Validation:
`cargo test -p coflux-supervisor sessiond_vt` -> exit 0。

### Milestone 2: catalog、sequence 与原子 attach

活 session 的 catalog 包含可自证字段与当前 sequence；attach 在同一 authority 临界区取得
snapshot@N 并注册 N+1，delta 有连续 byte offset，gap 可显式恢复。Validation:
`cargo test -p coflux-supervisor sessiond_attach` -> exit 0。

### Milestone 3: holder 与幂等输入

跨 logical client handoff、同 client transport migration、stale generation/epoch 拒绝、input
重投去重和 resize latest-wins 均有确定结果。Validation:
`cargo test -p coflux-supervisor sessiond_holder` -> exit 0。

### Milestone 4: 故障与背压隔离

无 worker、worker 写端堵塞或单 channel 队列满时，PTY 仍持续被解析到 bounded grid；worker
重连可从 catalog/snapshot 恢复，退出码 tombstone 在确认前不丢。Validation:
`cargo test -p coflux-supervisor sessiond_backpressure` -> exit 0。

## Landmines

- 当前 supervisor outbound 是无界 `std::sync::mpsc` 且只有一个可替换 worker 写端
  （`crates/supervisor/src/main.rs:81-100`）；仅删除 `PtyPause` 会把冻结问题变成无界内存问题。
- `portable-pty` reader、writer、master、child 的所有权被拆在不同线程/对象；重构不能在 resize、
  close 与 EOF wait 之间制造双重 remove（`crates/supervisor/src/sessions.rs:42-87`）。
- 当前 UDS 最新连接会直接替换 worker 写端（`crates/supervisor/src/main.rs:136-148`）；迁移期必须
  保证旧连接的输出不会清掉新连接。
- 规范化 ANSI snapshot 必须先 reset 并恢复 input modes；现有 server serializer 的行为可作参考
  （`apps/server/src/mirror.ts:56-60`），但不能把 Node/xterm 引入 supervisor。
- 图像/sixel 等无法可靠物化的序列可以 live passthrough 并记录能力缺口，但不得谎称可恢复。

## Scope

In scope:
- `crates/supervisor/src/**`
- plan 036 已冻结依赖下的 supervisor 单元/夹具

Out of scope:
- loopback TCP/WS、browser pairing、中心 relay
- `crates/worker/src/**`、`apps/server/**`、`packages/client/**`
- supervisor/OS 重启后的活进程恢复

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Supervisor tests | `cargo test -p coflux-supervisor` | exit 0，零 warning |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零 warning |

## Done criteria

- [ ] 所有列出的 commands 通过。
- [ ] snapshot@N 与 N+1 delta 无 gap/duplicate 的单测成立。
- [ ] history 只在完整 logical line 边界裁剪，内存有明确上限。
- [ ] stale holder/transport/input 被拒且不会写入 PTY。
- [ ] worker/consumer 缺失或堵塞不会暂停 PTY reader。
- [ ] catalog 与 exit tombstone 足以让 worker 完成离线 reconciliation。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 文件。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- 候选 VT parser 无法通过核心 Agent/TUI 语料，且替换依赖会破坏 plan 036 合同。
- 为保证正确性必须把网络/auth 逻辑放入稳定 supervisor。
- portable-pty 无法在不中断现有会话的前提下承载新 authority 生命周期。
- validation 在一次合理修复后连续失败两次。

## Maintenance notes

sessiond 的价值是“当前状态可重建”，不是“保证每个历史原始字节永不丢”。未来多写端应扩展
holder policy，不能绕过 epoch/generation/input-sequence 三层防线。
