# Plan 004: 端口转发协议契约(帧 + 控制面消息 + UDS 扩展)

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- packages/protocol crates/protocol crates/supervisor/src/sessions.rs crates/worker/src/main.rs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

为「HTTP 反向代理式端口转发」功能冻结全部协议契约,使 daemon 侧(plan 005)与
server/web 侧(plan 006)能并行实现。功能全貌:daemon 自动探测 PTY 会话子进程树
的监听端口并上报;server 为每个 (device, port) 签发短路由标识,浏览器经
`https://<shortId>.<proxyHost>` 访问,server 与 daemon 之间用按 TCP 连接粒度多路
复用的二进制帧隧道透传字节。

本 plan 完成后:TS 与 Rust 两侧协议真相源包含全部新消息与新帧种类、字节级一致、
有单测覆盖;整个 workspace 编译全绿(对既有调用点做最小适配,不实现任何转发行为)。

## Decisions & tradeoffs

- **数据面新帧 kind=4(ProxyData)**:帧体 `[4][cidLen:1][connId:utf8][payload]`,
  双向(server↔daemon),connId < 256 字节。Rejected: 每字节流单开 WS 连接 —— daemon
  出连接模型下增加认证/重连复杂度,现有单 WS 多路复用机制已够。
  Based on: 帧 kind 单字节可扩展、未知 kind 双侧丢弃(`crates/protocol/src/frame.rs:73`、
  `packages/protocol/src/index.ts:271`)。
- **隧道连接的 open/close 走控制面 JSON,数据走二进制帧**:同一 WS 内文本/二进制帧
  有序投递,close 不会越过 data。Rejected: 在帧里编码 open/close 子类型 —— 控制语义
  塞进数据面,校验/日志/演进都更差。
  Based on: pty 数据面与控制面并存的既有模式(`docs/architecture.md` §4)。
- **控制面新消息(两侧同步加)**:
  - DaemonToServer: `ports.update { sessions: [{ sessionId, ports: number[] }] }`
    (全量幂等,仅含有监听端口的 session)· `proxy.opened { connId, ok, error? }` ·
    `proxy.closed { connId }`
  - ServerToDaemon: `proxy.open { connId, port }` · `proxy.close { connId }`
  - ClientToServer: `proxy.issueAuth { redirect }`
  - ServerToClient: `proxy.auth { ok, url?, error? }` ·
    `ports.updated { taskId, ports: [{ port, url }] }`,且 `state.snapshot` 增加
    `ports: [{ taskId, port, url }]` 字段
  命名与字段一经落地即冻结,005/006 只消费不改。Rejected: 增量式端口上报 ——
  全量幂等与 resync 风格一致,daemon 重连/漏报自愈。
  Based on: 消息白名单校验会丢弃未注册类型(`packages/protocol/src/index.ts:302-338`),
  Rust serde 未知 type 反序列化失败即丢(`crates/worker/src/main.rs:401-404`),
  故协议必须先于两侧实现冻结。
- **UDS `ResyncList` 携带 pid**:ipc.rs 引入 `SessionInfo { session_id, task_id, pid }`
  并将 `ResyncList.sessions` 改为 `Vec<SessionInfo>`;wire.rs 的 `SessionRef`(daemon→server
  resync)保持不变。Rejected: worker 另发查询消息取 pid —— 多一轮 RTT 和状态机,resync
  快照顺带携带最自然。
  Based on: `SessionStarted` 已带 pid(`crates/protocol/src/ipc.rs:61`)而 `ResyncList`
  没有(`ipc.rs:65`),worker 重启后将拿不到 PTY 进程树根,探测(plan 005)依赖 pid。
- **UDS `is_frame` 保持只认 1..=3**:kind=4 隧道帧不经 UDS(worker 直接处理,PTY 之外
  的职责都在 worker)。执行时不得把 4 加进 `is_frame`,否则隧道帧会被误发给 supervisor。
  Based on: `crates/protocol/src/ipc.rs:77-79`;supervisor 只管 PTY(`docs/architecture.md` §8)。
- **最小适配、不实现行为 (decided while planning)**:supervisor 构造 `ResyncList` 时填
  真实 child pid(`crates/supervisor/src/sessions.rs` 持有);worker 只做类型适配让编译
  通过(可顺手把 alive map 的 value 扩成含 pid,行为不变);TS server/web 不消费新消息。
  转发行为分别归 005/006。

## Direction

TS 真相源在 `packages/protocol/src/index.ts`(类型 + encodeFrame/decodeFrame + 白名单
FIELDS 表),Rust 真相源在 `crates/protocol/src/{frame,wire,ipc}.rs`。两侧字节级/字段级
一致是硬约束,以既有 pty 三帧和 camelCase tagged JSON 为范式。

### Milestone 1: 双侧帧 codec 支持 kind=4

TS `encodeFrame`/`decodeFrame` 与 Rust `encode_frame`/`decode_frame` 支持 ProxyData 帧,
roundtrip 与截断拒收有单测(Rust 侧;TS 侧无单测框架,靠 007 集成验证 + tsc)。
Validation: `cargo test -p coflux-protocol` -> exit 0,新增 proxy 帧用例通过。

### Milestone 2: 控制面消息 + 白名单 + UDS 扩展落地,全库编译绿

四个方向的新消息在 TS 类型联合体与 FIELDS 表、Rust wire.rs enum 中同时存在;
ipc.rs `SessionInfo` 落地;supervisor/worker 最小适配完成。
Validation: `cargo build -p coflux-supervisor -p coflux-worker`(零警告)、
`cargo test -p coflux-protocol`、`pnpm exec tsc --noEmit -p apps/server`(以及 web/tsconfig
若独立)-> 全部 exit 0。

## Landmines

- 白名单 FIELDS 表与类型联合体是两处独立清单(`packages/protocol/src/index.ts:302,316`),
  漏加任何一处,消息会在 transport 层被静默丢弃,黑盒测试表现为超时而非报错。
- `proxy.issueAuth.redirect` 在 FIELDS 表只能声明为 `string`;真正的 URL 白名单校验
  属于 hub(plan 006),不要试图在协议层做。
- wire.rs 用 `rename_all_fields = "camelCase"`,`conn_id` 会序列化为 `connId`——TS 侧
  字段名必须是 `connId`(不是 `conn_id`),写单测锁住。

## Scope

In scope:
- `packages/protocol/src/index.ts`
- `crates/protocol/src/{frame,wire,ipc}.rs`
- `crates/supervisor/src/sessions.rs`(仅 ResyncList 填 pid 的最小适配)
- `crates/worker/src/main.rs`(仅类型适配,行为不变)

Out of scope:
- 任何转发/探测/门禁行为实现 —— 归 005/006
- `tests/src/` —— 归 007
- docs —— 归 007

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0,零警告 |
| TS 类型检查 | `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web` | exit 0 |
| 黑盒回归 (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0(既有用例不回归) |

## Done criteria

- [ ] All listed commands pass.
- [ ] kind=4 帧在 TS 与 Rust 双侧可 roundtrip,connId 字段名两侧一致为 `connId`。
- [ ] 新控制面消息在 TS 类型、FIELDS 白名单、Rust enum 三处全部存在。
- [ ] `ResyncList` 携带 pid 且 supervisor 填真实值。
- [ ] 未实现任何转发行为(hub/worker 对新消息最多是显式忽略)。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 发现 TS/Rust 帧格式无法做到字节级一致(例如既有布局冲突)。

## Maintenance notes

协议一经 005/006 消费即冻结;后续加帧种类沿用「单字节 kind + 未知丢弃」的演进路径。
`is_frame`(UDS)与 WS 帧分流的边界:1..=3 归 supervisor,4 及以后归 worker 自身。
