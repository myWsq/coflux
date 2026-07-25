# Plan 043: 独立 relay 服务·第一片 —— crates/relay 二进制 + 按需拨号 rendezvous

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier. Stop on any STOP condition. When complete, update
> this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 607cef3..HEAD -- crates/ apps/server/src/ packages/protocol/ packages/client/ proto/ tests/src/ docs/architecture.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none（前置 036-042 已全部 DONE）
- Category: feature
- Execution: self
- Planned at: `607cef3`, 2026-07-25

## Requirement

Device relay 数据面目前不是独立连接，而是复用两条控制面 WS 的消息类型
（client 侧 `packages/client/src/device-router.ts:581-647` 经 `sendControl` 发
`deviceRelayFrame`；daemon 侧混在唯一那条 daemon→server WS，
`crates/worker/src/main.rs:937-960`）。因此远端 client↔daemon 的每个字节都必须
绕经中心（prod-jp），CN↔CN 场景 hairpin 造成 150-250ms 打字 RTT。

本片完成后：

1. 存在 `crates/relay`：Rust 单二进制、零解析 DeviceEnvelope 的配对管道服务，
   可独立于中心部署。
2. relay 数据帧不再流经中心控制 WS：client 与 daemon 各自与 relay 建立**每
   channel 一条**的专用 WS；中心只做 rendezvous（校验归属、签发短时 token、
   通知 daemon 拨号）。
3. 单 relay 节点（与中心同机或异机）跑通全部现有 relay 语义：attach/snapshot/
   input/resize/stop/exec/fs、exactly-once、direct↔relay fallback/promotion，
   黑盒测试覆盖。
4. 多节点就近探测/选择、多地部署清单**不在本片**（第二片）。

判别正确与相邻错误：改完后若「client 的 relay 帧仍以 `deviceRelayFrame` 走
`/client` 控制 WS」或「relay 二进制需要理解 DeviceEnvelope 内部 oneof」或
「relay 需要访问账号 DB / Postgres」，即为走错方向。

## Decisions & tradeoffs

- **relay 实现形态**：新增 `crates/relay` Rust 单二进制（tokio + tokio-tungstenite
  WS server），进 workspace members（`Cargo.toml:6`）。Rejected: TS 复用
  `device-relay.ts` 抽小服务 —— 每个 relay VPS 需 node 运行时，部署重；且去掉
  accountId 内存耦合后可复用代码所剩无几。Based on: worker 已用同栈
  `tokio-tungstenite = 0.24 (rustls)`（`crates/worker/Cargo.toml:20`），交叉编译
  基建现成（`release.yml`）。
- **relay 零解析、零状态**：relay 只按 channelId 配对两条 WS 并做 opaque 字节
  管道 + 限速限量；不 import/decode DeviceEnvelope，不连 DB。限额沿用现有
  `apps/server/src/device-relay.ts:49-54` 的数值（MAX_DEVICE_FRAME_BYTES、
  2048 帧/s、128 MiB/s、channel 总数上限等，per-client/per-daemon 维度在无账号
  概念的 relay 上退化为 per-connection/per-channel + 全局上限）。Rejected: relay
  端做业务鉴权 —— exactly-once/holder/scope 语义已全部在 worker/sessiond 端到端
  完成（`device-relay.ts:1-7` 的既有原则）。
- **认证 = 中心签发短时 ed25519 token**：server 持签名私钥，relay 只持公钥
  （env 注入，仿 `COFLUX_WORKER_PUBKEY` 模式，见 AGENTS.md 签名验收节）；token
  绑定 {channelId, role(client|daemon), daemonId, transportGeneration, exp}，
  TTL ≤ 60s，一次性（同 channelId+role 二连即拒后到者）。Node `crypto` ed25519
  与 `ed25519-dalek` 互通（原始 32B 公钥 + 64B 签名，仓库已验证）。server 私钥
  来源：env `COFLUX_RELAY_SIGNING_KEY`（缺省时启动自动生成并落
  DB/文件，执行时按 server 现有密钥管理惯例定，不得打印私钥）。Rejected:
  relay 回连中心校验 —— 引入 relay→中心依赖与额外 RTT，违背无状态原则。
- **每 channel 一条 WS，channelId+token 经 URL**（批准方向）：连接即认证、断开
  即 channel 关闭，无多路复用帧协议。约束（decided while planning）：token TTL
  ≤ 60s 且一次性，缓解 URL 泄漏面；relay 自身日志与部署文档中的 Caddy 配置不得
  记录 query string。Rejected: 单连接多 channel 复用 —— 需要重新发明帧头与
  per-channel 流控，正是本次要删掉的东西。
- **rendezvous 按需拨号，零驻留连接**：client 经 `/client` 控制 WS 发起 open；
  server 沿用 `device-relay.ts:70-87` 的校验语义（认证、id 合法性、协议版本、
  daemon 在线且同账号、channel 配额）后：给 client 回 {relayUrl, token}，经
  daemon 控制 WS 推 {relayUrl, token, channelId, accountId, clientInstanceId,
  transportGeneration, scopes}（scopes 仍由 server 授予，语义同现
  `device-relay.ts:106`）；双方各自拨号 relay，配对成功开始转发。channel 断开
  即由 client 重新 rendezvous（复用现有 route 重建路径）。Rejected: DERP 式
  home relay 长驻 —— 新增驻留连接管理/lease 语义（前科见 center-clock-lease），
  收益仅是省一次就近 WS 握手。
- **旧控制面复用 relay 路径同版本删除**（开放项定夺）：`DeviceRelayClientOpen/
  DeviceRelayDaemonOpen/DeviceRelayFrame/DeviceRelayClose/DeviceRelayStatus`
  五个消息从 client/daemon 两条控制 WS 协议中删除，字段号与名称 protobuf
  `reserved`（`proto/coflux/v1/device.proto:175-207` 及 client/daemon proto 中的
  引用位），新增 rendezvous 消息替代。理由：033 版本失配踢出已上线，旧 bundle
  客户端会被踢，无需双路径过渡；mobile 经共享 `packages/client` 自动跟随（属
  允许的共享层变更，不加 mobile 功能）。Rejected: 过渡期双路径 —— 两套语义并存
  正是 036-041 刚清理掉的债。
- **relay 独立部署，server 不内嵌数据面**（2026-07-25 执行中经用户修订：生产不做
  同机伴生，relay 自有主机/域名独立部署）：`apps/server/src/device-relay.ts` 整个
  删除；server 只配置 `COFLUX_RELAY_URL` 指向外部 relay（本片单节点、单 URL；第二片
  扩为列表），relay 与中心零连接、耦合面仅签名密钥对。dev/harness 以 spawn 二进制
  方式起 relay（测试拓扑，与部署形态无关）。Rejected: server 内嵌 TS 等价端点兜底
  —— 同一协议两套实现，长期漂移。
- **不做 P2P/WebRTC、不做多节点就近**：仅在 `docs/ROADMAP.md` 记一行（P2P 叠加
  在 relay 之上、relay 为其兜底层；多节点就近为第二片）。
- **协议双侧一致纪律**：`proto/` 改动经 buf 生成到 `packages/protocol/src/gen`
  与 `crates/protocol/src/gen`（`proto/buf.gen.yaml:4-9`），wire 格式内部标签
  `type` + camelCase；`crates/protocol` 的 wire 测试（`wire_tests.rs`）随新消息
  更新。

## Direction

数据流（新）：

```text
client ── /client 控制 WS ──▶ server：rendezvous（校验+签 token+通知 daemon）
client ── wss://relay/…channelId+token ──▶ relay ◀── wss 拨号 ── worker
              （每 channel 一条 WS，帧 = 端到端 DeviceEnvelope bytes，relay 零解析）
```

### Milestone 1: 协议契约 + relay 二进制

`proto/` 完成消息增删（rendezvous 请求/授予/拨号通知；旧五消息 reserved），双侧
gen 更新；`crates/relay` 可执行：监听端口（env/flag 注入，含 0 随机端口 + 实际
端口可被 harness 读取）、验签、按 channelId 配对、双向管道、限速限量、半开清理
（单侧到达超时、token 过期/重放拒绝）。
Validation: `cargo build`（零警告，含新 crate）+ `cargo test -p coflux-protocol` → exit 0。

### Milestone 2: server rendezvous + worker 拨号

server 删除 `device-relay.ts` 与 hub 中旧 relay 分支（`apps/server/src/hub.ts:170,
197, 254, 893-900, 1103, 1171-1181, 1628, 1649, 1660`），实现 rendezvous 与 token
签发；worker 收到拨号通知后 `connect_async` 到 relay，channel 帧泵从「经
to_server 通道回中心」（`crates/worker/src/device.rs:343-388`）改接到该 channel
的 relay WS；relay WS 断开触发 `close_relay` 语义不变。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` + `cargo build` → exit 0。

### Milestone 3: client 拨号 + harness 接入 + 黑盒回归

`packages/client` 的 `openRelayTransport`（`device-router.ts:581-647`）改为
rendezvous → `new WebSocket(relayUrl)`（形态参考同文件 `connectDirectTransport`
的 socket 生命周期处理）；transport 状态语义（`channelCovers`、fallback/
promotion、`relayStarted` 探测竞速）保持不变。harness `startStack`
（`tests/src/harness.mjs:287`）扩展为 spawn relay 二进制（`target/debug/
coflux-relay`，随 pretest cargo build），server env 注入 relay URL 与验签公钥对
接。现有 relay 相关黑盒用例全部改走新路径并通过；新增至少一个负向用例：伪造/
过期 token 被 relay 拒绝，channel 不建立。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` + `pnpm -C tests test` → exit 0。

### Milestone 4: 文档收敛

`docs/architecture.md` §5.2/§8 更新为独立 relay + rendezvous 语义；
`docs/ROADMAP.md` 记 P2P 与第二片（多节点就近）待办。
Validation: 人工检视 diff 与实现一致（无命令）。

## Landmines

- **`packages/client` 为 web/mobile 双端共享**：mobile 已冻结且 relay-only
  （`AGENTS.md`），本片只允许它经共享层自动跟随，禁止动 `apps/mobile` 业务代码；
  改完必须保证 mobile 构建通过（如坏，做最小修复）。
- **relay-only 配置路径**：`device-router.ts` 存在 relay-only（mobile）与
  direct+relay 两种配置；`channelCovers`（`device-router.ts:454-461`）对 relay
  channel 的 RPC/LIFECYCLE 依赖 `controlOnline` —— 新路径下 relay WS 活着但控制
  WS 断开时的语义要与现状一致（rendezvous 不可用 = 无法开新 channel，已建
  channel 的 session lane 是否存续按现有 `docs/architecture.md` §8 故障表执行）。
- **worker 的 relay 帧泵有 services 分流**：`crates/worker/src/device.rs:368` 处
  `relay_to_server` 与 `to_server` 有两条发送路径（热升级/服务化相关），改造帧泵
  时两条都要理解后再动，不要只改一处。
- **direct 基准不许回归**：`docs/architecture.md` §11 的发布门包括「timed direct
  path 中心 `deviceRelayFrame` 增量 = 0」；旧消息删除后该断言对象消失，黑盒里
  等价断言应改为「direct 路径上 relay 进程零帧经手」。
- **端口纪律**：黑盒测试各文件独占端口（`tests/src/harness.mjs` 头部注释），
  relay 监听端口须走随机端口（listen 0 后读实际端口），避免与既有测试端口冲突。
- **`__coflux-` 前缀 channelId 是保留命名空间**（`device-relay.ts:75`），新
  rendezvous 校验须保留该拒绝。
- **零警告纪律**：`cargo build` 出现任何警告即视为验证失败（AGENTS.md）。

## Scope

In scope:

- `proto/coflux/v1/*.proto` 及两侧 gen（`packages/protocol/`、`crates/protocol/`）
- `crates/relay/`（新建）、`Cargo.toml`（workspace members）、`Cargo.lock`
- `crates/worker/src/`（拨号 + 帧泵改接）
- `apps/server/src/`（rendezvous、token 签发、删 `device-relay.ts`）
- `packages/client/src/`（`openRelayTransport` 改造及其单测）
- `tests/src/`（harness + relay 相关用例 + 新负向用例）
- `docs/architecture.md`、`docs/ROADMAP.md`、`plans/README.md`

Out of scope:

- 多节点就近探测/选择、relay 列表下发 —— 第二片
- P2P/WebRTC —— 仅 ROADMAP 记录
- `apps/mobile/` 业务代码 —— 冻结（共享层导致的最小构建修复除外）
- 生产部署实操（prod-jp/新 VPS 的 systemd/Caddy 变更）—— 执行属运维，本片只在
  文档留部署要点；不改 `release.yml` 之外的 CI 行为（relay 进发布产物矩阵允许）
- `crates/supervisor/`（除非协议 gen 牵连编译，预期不动）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建（零警告） | `cargo build` | exit 0，无 warning |
| Rust 协议单测 | `cargo test -p coflux-protocol` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| client 单测 | `pnpm -C packages/client test`（如无此脚本则跑仓库现有等价单测入口） | exit 0 |
| 黑盒集成 (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] 上表命令全绿。
- [ ] relay 数据帧不再经 `/client` 或 daemon 控制 WS；旧五消息已删且 protobuf `reserved`。
- [ ] `crates/relay` 不依赖 DeviceEnvelope 解码、不依赖 DB；伪造/过期 token 有负向黑盒用例且被拒。
- [ ] 现有 relay 语义黑盒用例（fallback/promotion、exactly-once、中心停机表现）在新路径下全部通过。
- [ ] direct 路径零 relay 帧经手的等价断言存在且通过。
- [ ] 实现遵循 Decisions & tradeoffs 全部条目；无 out-of-scope 文件变更。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- Decisions 引用的事实不再成立（如 `device-relay.ts` 已被他人改动/删除）。
- 实现被迫触碰 out-of-scope 文件（如必须改 `apps/mobile` 业务代码）。
- 某验证命令在一次合理修复后仍连续失败两次。
- 发现 rendezvous 无法沿用现有控制 WS 语义表达（需要新控制连接）——方向级假设破裂。

## Maintenance notes

- token 私钥的运维轮换与 relay 公钥同步是新增的密钥面：轮换时先双公钥并存再撤旧
  （relay 支持多公钥 env 可留作第二片；本片单公钥即可，但文档需写明轮换顺序）。
- 第二片（多节点）到来时，rendezvous 响应从单 `relayUrl` 扩为候选列表 + 两端 RTT
  上报；本片协议设计时字段命名避免单数复数返工即可，不必预埋未用字段。
- relay 二进制进入发布矩阵后，其版本与 server token 格式的兼容以 protobuf/字段
  演进纪律约束，不引入独立握手版本号。
