# Plan 042: Device PTY 输入累计 ACK 与连续 exactly-once 契约

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。只有同时承担验证职责时才运行 milestone validation；委派执行者只实现，验证
> 留给 orchestrator。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat 0da4edf..HEAD -- proto packages/protocol crates/protocol crates/supervisor/src/sessiond.rs crates/supervisor/src/sessions.rs crates/worker/src/device.rs Cargo.toml Cargo.lock`

## Status

- Priority: P0
- Effort: M
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: bug
- Planned at: `0da4edf`, 2026-07-25

## Requirement

在 web/client 开始跨 direct/relay 重投 PTY 输入前，补齐 daemon authority 的成功确认边界。
当前 wire 声称 `input_seq` 承担 exactly-once，但 supervisor 在首次应用和重复请求两条成功路径
都不返回结果；client 草稿只能无限保留输入，达到 256 条或 1 MiB 后还会静默丢弃最旧数据。
完成后，sessiond 只连续提交输入并返回累计 ACK；ACK 丢失、worker 重启或 transport 迁移时，
相同 logical client 可安全重投，既不重复写 PTY，也不会把尚未应用的序号越级确认。

本计划只建立并产出 daemon 侧 ACK；浏览器消费 ACK、输入队列背压和 UI 行为属于 plan 040。

## Decisions & tradeoffs

- **新增 transport-neutral 累计 ACK**：Device 协议新增 `DevicePtyInputAck`，至少包含
  `session_id` 与 `applied_through_seq`，由已认证 channel 隐式确定 logical client；不携带
  `request_id`，也不为每次重投制造一份永久结果。拒绝“发送成功就从 client 队列删除”，因为
  当前 supervisor 的 Apply/Duplicate 均无成功响应
  （`crates/supervisor/src/sessions.rs:696-712`）。
- **累计游标必须连续**：无游标时只允许序号 1；已有游标 N 时只有 N+1 可写入，N+2 及以上
  返回 gap/error 且游标不动。拒绝当前“任何大于 N 都 Apply”的规则，否则跨 transport 乱序
  会让 ACK 越过永久丢失的输入（`crates/supervisor/src/sessiond.rs:499-518`）。
- **成功提交后才 ACK**：首次输入必须在 PTY `write_all` 成功且 authority 游标提交后返回新
  `appliedThroughSeq`；写入或授权失败只返回关联原 `request_id` 的 error，绝不前移 ACK。
  ACK 发送失败不回滚 PTY，而由同序号重投触发再次确认。
- **所有已提交重投都返回累计 ACK**：`input_seq <= appliedThroughSeq` 一律不再写 PTY并返回
  当前累计游标；等于当前游标且 payload 不同仍可报告 collision，早于当前游标的 payload
  不做无界历史比对。拒绝把旧序号仅报 `stale_input`，因为 ACK 丢失后 client 必须有办法安全
  清掉整段已提交前缀；严格连续提交已保证旧序号对应的 effect 曾发生。
- **ACK 沿原 channel 原样返回**：worker 把它归类为 `SESSION_CONTROL` response，只投递给产生
  输入的 logical channel；它不进入 output cursor/gap 合并，也不经中心解释。Device envelope
  本来就是 local/relay 共用且由中心 opaque 转发
  （`proto/coflux/v1/device.proto:1-4`, `crates/worker/src/device.rs:1068-1147`）。
- **Protobuf 仍是唯一真相源**：消息和 oneof 字段先改 `proto/`，再完整生成 TS、Rust、Swift；
  不手写任一语言镜像。一次生成会清理并重写三套输出
  （`proto/buf.gen.yaml:1-13`）。
- **不顺带扩展 resize 或 operation**：resize 始终只保留最后尺寸，prepared/stop 已有
  `DeviceOperationAck`；本计划只修复会累积且不能丢的 PTY input。浏览器队列目前静默淘汰输入
  的行为由 plan 040 消费 ACK 后移除（`packages/client/src/device-router.ts:958-974`）。

## Direction

### Milestone 1: wire 契约可跨语言生成

ACK 的字段、累计语义、连续序号与 oneof 编号在 proto 注释中无歧义，三套生成物一致且旧字段号
不复用。Validation: `cd proto && buf lint && buf generate && cd .. && cargo test -p coflux-protocol`
-> exit 0。

### Milestone 2: sessiond 形成可证明的提交边界

authority 对首次连续输入、ACK 丢失后的相同/较旧重投、序号 gap、payload collision、PTY 写失败、
旧 holder 和旧 transport 都有测试；只有真实写入成功才能推进累计游标。Validation:
`cargo test -p coflux-supervisor sessiond_` -> exit 0。

### Milestone 3: direct/relay 共用 daemon 响应路径

worker 明确授权并转发 ACK，channel 隔离、scope 过滤和队列失败行为有测试；server 无需新增
Device payload 分派。Validation: `cargo test -p coflux-worker && cargo build -p coflux-supervisor -p coflux-worker`
-> exit 0，零 warning。

## Landmines

- `DevicePtyInput` 的注释当前只写“较小 seq 拒绝”且没有成功确认
  （`proto/coflux/v1/device.proto:307-315`）；新增累计 ACK 后必须同步修正旧注释，不能留下两套语义。
- sessiond 的 input cursor 以 logical `client_instance_id` 为键，而 channel 会随 generation 迁移；
  ACK 不能错误绑定物理 direct/relay 身份，否则 failover 后无法确认旧 effect
  （`crates/supervisor/src/sessiond.rs:509-523`）。
- worker 的 response scope 白名单目前没有 ACK case
  （`crates/worker/src/device.rs:1446-1464`）；依赖默认分支“刚好能转发”不算完成。
- generated code 不得手改；`buf generate` 的 `clean: true` 会触及与本消息无关但同目录的产物。

## Scope

In scope:
- `proto/**`
- `packages/protocol/**`
- `crates/protocol/**`
- `crates/supervisor/src/sessiond.rs`
- `crates/supervisor/src/sessions.rs`
- `crates/worker/src/device.rs`
- 协议生成确有需要时的 `Cargo.toml`、crate manifests 与 `Cargo.lock`
- `plans/README.md`

Out of scope:
- `packages/client/**`、`apps/web/**` — ACK 消费与背压由 plan 040 实现
- `apps/server/**` — relay 必须继续 opaque，不解释 ACK
- 黑盒浏览器/failover 验收 — 由 plan 041 统一完成
- resize ACK、PTY output ACK 或 supervisor/OS 重启后的进程恢复

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint/generate | `cd proto && buf lint && buf generate` | exit 0，TS/Rust/Swift 均更新 |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Supervisor semantics | `cargo test -p coflux-supervisor sessiond_` | exit 0 |
| Worker routing | `cargo test -p coflux-worker` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零 warning |
| TS generated consumers | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit && node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] 所有列出的 commands 通过。
- [ ] ACK wire 注释明确其 logical-client、累计、连续与失败语义，三语言生成物完整提交。
- [ ] N 之前未提交时 N+1 不会写入，且不会出现越级 `appliedThroughSeq`。
- [ ] Apply 与所有已提交重投都会 ACK；PTY 写失败、stale holder/transport 不会 ACK 或推进游标。
- [ ] direct 与 relay 都只把 ACK 投递回正确 channel，且 response scope 为 `SESSION_CONTROL`。
- [ ] 测试包含 ACK 丢失后从旧序号重投并得到当前累计游标的行为。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 文件。
- [ ] `plans/README.md` status 已更新。

## STOP conditions

- plan 036 的 logical client/session 输入游标边界已被后续代码改成不同 authority。
- ACK 需要 server 解码、持久化或改写 Device payload 才能工作。
- PTY writer 无法区分成功提交与失败，却只能在写入前推进游标。
- 需要改 `packages/client` 才能让协议/daemon 自身测试通过。
- 任一 validation 在一次合理修复后连续失败两次。

## Maintenance notes

`appliedThroughSeq` 只证明当前 sessiond authority 已把该连续前缀成功写给存活 PTY，不承诺终端
程序已经处理、产生 echo，也不跨 supervisor/OS 重启持久化。以后若扩大 durability 边界，必须
另立协议，而不能悄悄提升这个 ACK 的含义。
