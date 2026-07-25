# Plan 036: 本地优先 session/device 协议契约

> 本计划是 outcome contract，不是逐函数脚本。先理解需求与已记录决策，再针对实时
> 代码自行设计实现。只有同时承担验证职责时才运行 milestone validation；委派执行者
> 只实现，验证留给 orchestrator。遇到 STOP condition 必须停止。完成后更新
> `plans/README.md`。
>
> Drift check: `git diff --stat febdd62..HEAD -- proto packages/protocol crates/protocol Cargo.toml Cargo.lock apps/server/src/hub.ts crates/worker/src/main.rs crates/supervisor/src/sessions.rs packages/client/src/connection.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: migration
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

冻结一套由 browser、server relay、worker gateway 与 supervisor/sessiond 共用的端到端
Device RPC/stream 契约，使同一逻辑连接可在 loopback 与中心 relay 之间切换，而不改变
holder、重复执行输入或丢失无法检测的输出。契约必须把本地身份、在线高权限 lease、
session catalog、原子快照、单调序号、幂等 operation 与 checkpoint 明确定义；本计划只
建立可编译、可生成、向后兼容的共享边界，不改变生产运行路径。

## Decisions & tradeoffs

- **统一端到端 Device 协议**：browser 与 worker 使用同一 request/response/event envelope；
  本地直接承载，远程由中心按 daemon/channel 转发。拒绝为 loopback 另做一套 hub 适配，
  因为当前 client/daemon 分段协议已让 server 逐项解释和重写请求
  （`apps/server/src/hub.ts:130-139`, `apps/server/src/hub.ts:898-905`），复制一次会永久漂移。
- **Protobuf 继续是唯一 wire 真相源**：所有跨进程/跨语言新消息从 `proto/` 生成 TS/Rust/Swift
  绑定；不手写镜像类型。基于 `packages/protocol/src/index.ts:1-9` 与
  `crates/protocol/src/lib.rs:1-14`。拒绝 JSON-only 本地协议。
- **sessiond 是 session authority**：PTY、VT grid/history、catalog、output sequence、holder
  lease 与未确认 exit tombstone 全由 supervisor 持有；worker 只承载 transport/auth/RPC。
  这是 worker 热升级仍不丢会话的延伸，基于 `docs/hot-upgrade-design.md:40-45`。
- **attach 契约是 `snapshot@N + subscribe(N+1)`**：快照为可直接写入 xterm 的规范化 ANSI，
  增量带连续 byte offset；检测到 gap 就重取快照。拒绝继续用无序号 raw replay，当前
  200KB byte ring 会从任意字节处裁剪（`crates/supervisor/src/sessions.rs:114-128`）。
- **单 holder、daemon 裁决**：不同 logical client attach 原子递增 holder epoch 并踢掉旧端；
  同一 client 的更高 transport generation 仅迁移路径，不自我抢占。input/resize 必须携带
  epoch，input 另带去重序号。首版拒绝 tmux 式多写端，但字段不得封死未来扩展。现有行为
  是 attach 即接管（`apps/server/src/hub.ts:188-194`）。
- **身份与权限分层**：持久 browser 公钥 grant 只允许离线存活 session 的
  list/attach/input/resize/stop；中心在线时滚动下发短期高权限 lease，才允许 git/fs/exec、
  project/worktree 与在线生命周期操作。拒绝把中心 `clientToken` 发给 localhost；它当前是
  账号级 bearer，保存在 web localStorage（`packages/client/src/store.ts:79-93`）。
- **配对采用双向公钥证明**：browser profile 与 gateway 各持久化 P-256 密钥；双方对绑定
  origin、daemon、nonce、client instance 与 transport generation 的 transcript 签名。
  中心在线时把 browser 公钥 grant 安装到目标 daemon。拒绝只信 Origin 或 loopback。
- **loopback 固定端点**：生产默认 `ws://127.0.0.1:8788/device`，只绑定 IPv4/IPv6 loopback；
  dev/test 可显式覆盖，端口占用或策略阻止时退回 relay。选择固定端口是因为 web 无法读取
  daemon 端点文件，且当前安装模型是一机一个 service（`packages/cli/cofluxd.mjs:32-33`,
  `packages/cli/cofluxd.mjs:139-171`）。
- **prepared operation 幂等**：会改变中心元数据与设备事实的 start/stop/worktree 操作先由
  中心持久化 prepare/op ID，再经任一 transport 执行；daemon 对同一 op ID 去重并回报事实。
  拒绝 daemon 先执行后登记，也拒绝在 direct/relay 竞速时重复执行。
- **中心 checkpoint 只是派生缓存**：sessiond 可周期上送带 sequence 的有界 viewport/recent-tail
  ANSI checkpoint；中心不得把它当 authority。拒绝继续要求所有本地输出逐字节经过中心，
  当前 mirror 正是持续消费全部输出（`apps/server/src/mirror.ts:1-10`）。
- **兼容范围**：本组只增加 desktop web 的 loopback；mobile 继续冻结，协议变化只做构建所需
  最小兼容。LAN/P2P、中心离线时刷新/冷启动 UI、跨 supervisor/OS 重启保活进程均明确排除。

## Direction

### Milestone 1: Device wire 语义冻结

新增向后兼容的 Device envelope、session stream、local pairing/lease、relay channel、prepared op
与 checkpoint 消息；旧 client/daemon envelope 的字段号保持稳定，未知新 case 可安全忽略。
Validation: `cd proto && buf lint && buf generate` -> exit 0，生成物无手工漂移。

### Milestone 2: supervisor/worker IPC 边界冻结

IPC 能表达多个 logical channel 的 catalog/attach/snapshot/delta/gap/detached/input/resize/stop、
holder epoch、transport generation、operation 去重与 exit tombstone ack；旧 session create/resync
语义保留到集成计划完成。Validation: `cargo test -p coflux-protocol` -> exit 0。

### Milestone 3: 跨语言消费面可编译

TS 与 Rust 都能构造/解析关键握手、快照、delta、relay 与 operation round trip；共享默认端口、
协议版本和尺寸钳制常量有单一、明确的对应关系。Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

## Landmines

- `buf.gen.yaml` 使用 `clean: true`，生成会同时重写 TS/Rust/Swift 目录；生成物必须全部提交
  （`proto/buf.gen.yaml:1-13`）。
- 现有 UDS 用首字节 `1..=3` 区分 frame 与 JSON（`crates/protocol/src/ipc.rs:90-93`）；新
  protobuf envelope 不能与旧 discriminator 静默碰撞，迁移期必须明确版本/记录类型。
- WebSocket 已全 binary protobuf，不要依据旧架构文档误加 JSON 控制帧；现状见
  `packages/protocol/src/index.ts:4-9`。
- generated code 不能手改；所有协议变更必须从 proto 或明确的 Rust-only IPC 真相侧产生。

## Scope

In scope:
- `proto/**`
- `packages/protocol/**`
- `crates/protocol/**`
- 为冻结成员依赖所必需的 `Cargo.toml`、各 crate `Cargo.toml` 与 `Cargo.lock`

Out of scope:
- `crates/supervisor/src/**`、`crates/worker/src/**` 的运行行为
- `apps/server/src/**`、`packages/client/**`、`apps/web/**` 的运行行为
- 生产启用 loopback 或数据迁移

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint/generate | `cd proto && buf lint && buf generate` | exit 0 |
| Generated diff | `git diff --exit-code -- packages/protocol/src/gen crates/protocol/src/gen proto/gen/swift` | 仅计划内预期生成差异；提交后 exit 0 |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |

## Done criteria

- [ ] 所有列出的 commands 通过。
- [ ] 新旧 envelope 均有 Rust/TS round-trip 或生成层覆盖，字段号无破坏性复用。
- [ ] snapshot/sequence/lease/generation/op ID 的不变量在协议注释中无歧义。
- [ ] 后续四个成员无需再共同修改共享 schema 即可独立实现。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 运行代码。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- 已占用 protobuf 字段号或 Buf breaking 检查要求破坏已发布 wire。
- P-256/WebCrypto 与 Rust 侧无法以稳定、跨目标格式互验。
- 后续成员所需核心语义无法在不复制两套 Device 协议的前提下表达。
- validation 在一次合理修复后连续失败两次。

## Maintenance notes

Device 协议是 transport-neutral 的能力协议，不得出现 `localhost` 专属业务语义；loopback 只是
一个承载。以后加 LAN/P2P 或 tmux 式多写端，应复用 principal/channel/lease 抽象而不是另起协议。
