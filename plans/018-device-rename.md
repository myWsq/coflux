# Plan 018: 设备重命名（别名）—— server/web 展示 + daemon 本地 settings.json 同步

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat edee8b1..HEAD -- proto/ crates/worker/src crates/protocol/src apps/server/src apps/web/src/components/workbench apps/web/src/client packages/protocol/src`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `edee8b1`, 2026-07-20

## Requirement

用户在同一账号下接入多台设备（daemon）后，设备名默认取自本机 `cofluxd` 登记时的 `deviceName`（往往是 hostname），彼此难以区分。需要支持在 web 端把设备改成一个易识别的别名。

完成后成立的事实：

1. web 侧设备列表可以对任意一台归属本账号的设备发起重命名，改名后立即在 web 上生效（无需刷新）。
2. 重命名会持久化到 server 的 `devices` 表，重启/重连不丢失。
3. 该设备下次与 server 握手成功（含改名时在线的即时同步、改名时离线则等下次重连）后，其本地 `~/.coflux/settings.json` 的 `deviceName` 字段被更新为新名字，`cofluxd status` 等本机命令行视角随之一致。
4. 空名（trim 后为空）不允许提交；不存在"清空回落到默认值"的语义。

正确/错误解的分界：一个只改 web 展示、不落库、刷新就丢的实现是错的；一个新增独立 `alias` 列并列 `name` 字段的实现是错的（已决策复用 `name`，见下）；一个只改 DB 不同步本机 `settings.json` 的实现是不完整的（本次需求明确要求双向同步）；一个给 daemon 本地写入引入 tmp+rename 原子写入等新抽象的实现是过度设计的（本仓库现有同类写入都是直接 truncate 写）。

## Decisions & tradeoffs

- **别名存储：直接复用 `devices.name` 字段，不新增列**。该字段登记后从不被 daemon 重连回写（`apps/server/src/hub.ts:322` 的 `daemonAuthed` 分支只读 `device.name` 传给 `registerDaemonConn`，从不写回 store），服务端覆盖它是安全的，不会被下一次重连悄悄冲掉。Rejected: 新增 `alias` 列、展示时 `alias ?? name` —— 多一次 schema 迁移和一个"取消别名回退原名"的交互，而需求只要求"web 上能区分"，不要求保留设备原始上报名。Based on: `apps/server/src/store.ts:147-159`（devices 表 DDL）。
- **协议改动走新增字段（proto3 兼容）**：
  - `proto/coflux/v1/client.proto` 新增 `message DeviceSetName { string daemon_id = 1; string name = 2; }`，挂进 `ClientToServer.oneof payload`，tag=26（当前最大已用 tag 是 `client_fs_write=25`，`proto/coflux/v1/client.proto:177-180`）。
  - `proto/coflux/v1/daemon.proto` 新增 `message DaemonSetName { string name = 1; }`，挂进 `ServerToDaemon.oneof payload`，tag=22（当前最大已用 tag 是 `fs_write=21`，`proto/coflux/v1/daemon.proto:242-266`）。
  - `cd proto && buf generate` 在本环境已验证可联网执行（remote 插件 `buf.build/bufbuild/es`/`buf.build/community/neoeinstein-prost`/`buf.build/apple/swift`），会同时刷新 `packages/protocol/src/gen`、`crates/protocol/src/gen`、`proto/gen/swift` 三端产物，禁止手改这些生成文件。
- **改名下发时机：复用握手完成点，不建离线队列**。`apps/server/src/hub.ts:220-237` 的 `registerDaemonConn` 是所有 daemon 连接（无论是首次 enroll 还是断线重连的 `daemonAuthed`）唯一的握手完成汇合点；在其中对该连接追加下发一条携带当前 `info.name` 的 `daemonSetName`，天然覆盖"改名时设备离线，等它下次上线自动补齐"。Rejected: 只在改名 API 调用时立即下发一次、离线则丢弃 —— 离线设备永远等不到同步，需求 3 不成立；持久化一个"待同步"标记表/队列 —— 为一个幂等推送引入不必要的状态机。Based on: 已有同构先例 `WorkerUpgrade` 消息（server 推送触发 daemon 端副作用，`apps/server/src/hub.ts:233` 周边 + `crates/worker/src/main.rs` 的 `WorkerUpgrade` 分支）。
- **服务端改名入口仿 `workspaceSetName`**：新增 `case "deviceSetName"`（`apps/server/src/hub.ts:807-814` 是同构模板），校验 `device.accountId === client.accountId` 后 `store.updateDeviceName(id, name.trim())`，广播 `daemonUpdated`（复用 `apps/server/src/hub.ts:233` 同款广播 payload 形状，`{ ...info, online: true }`）。**trim 后为空则拒绝**（不落库、不广播、不下发），因为设备没有像工作区那样"回落分支名"的天然默认值。若该设备当前在线（`this.daemons.get(daemonId)` 命中），改名成功后需同时更新内存中 `this.daemons` 的 `info.name` 并即时下发一条 `daemonSetName` 给它（不必等它主动重连）——这是"在线设备改名立即生效到本机"的唯一路径，因为 `registerDaemonConn` 只在握手时跑一次。
- **worker 侧写 `settings.json` 用 `serde_json::Value` 局部 patch，不给 `Settings` 结构体加 `Serialize`**。`crates/protocol/src/settings.rs` 当前只有 `Deserialize`（只读语义，`cofluxd` 是历史上唯一写者，`packages/cli/cofluxd.mjs:96-104`）。若改成整体反序列化再序列化回写，会把「同名 env 覆盖后的解析值」（`crates/worker/src/main.rs:83-89` 的 `pick()` 优先级）错误地固化成"文件配置"，且未来 `cofluxd` 给 settings.json 加新字段时，worker 的 `Settings` 结构体若没跟着加字段会在整体回写时丢字段。改为读原始 JSON（`serde_json::Value`）、只 patch `"deviceName"` 一个键、其余字节级保留，规避以上两个问题。
- **`settings.json` 不存在时跳过本地同步，不凭空创建**：若目标路径读不到文件（測試環境常见——`tests/src/harness.mjs:255` 的默认测试 daemon 完全靠 `COFLUX_DEVICE_NAME` 等 env 驱动，从不落盘 settings.json），worker 收到 `DaemonSetName` 时静默跳过写入（可以打日志，不能报错中断连接）。Rejected: 缺文件时用当前 resolved 配置反推创建一份"全量"文件 —— 会把 env 值错误固化成文件配置，且这类纯 env 驱动场景（测试/容器化）本就不该出现一份不完整的 settings.json。
- **worker 写入方式跟随本仓库现有风格：直接 truncate 写，不引入 tmp+rename 原子写入**。`crates/worker/src/creds.rs:49-50,75-76` 与 `packages/cli/cofluxd.mjs:103` 的既有写入都是 `OpenOptions{write,create,truncate}` / `writeFileSync` 直接整文件覆盖，非原子。本次跟随而非新造模式。**已知风险不解决**：`cofluxd` 命令行与 worker 可能并发写同一文件，最坏情况后写者赢，不会产生语法损坏的 JSON（两者都是一次性写入完整合法 JSON 字符串），这是既有风险面，本次不新增也不需要额外加锁/合并逻辑。
- **web 侧改名对话框不做"清空回落默认值"语义**：`WorkspaceRenameDialog`（`apps/web/src/components/workbench/dialogs.tsx:15-73`）清空提交会回落到分支名；设备没有对应的天然默认值，新 `DeviceRenameDialog` 在 trim 后为空时禁用保存按钮，不提交空值。

## Direction

数据流（改名请求）：web 「重命名」菜单 → `DeviceRenameDialog` 提交 → `client.send({ case: "deviceSetName", value: { daemonId, name } })` → `hub.ts` 校验归属 + `store.updateDeviceName` → 广播 `daemonUpdated`（web 侧其他已登录客户端同步刷新展示）→ 若目标设备当前在线，同时更新内存 `this.daemons` 元数据并下发 `daemonSetName` 给该连接 → worker 收到后 patch 本地 `settings.json`。

数据流（离线补偿）：设备离线期间被改名 → DB 已是新名字 → 设备下次连上、`registerDaemonConn` 跑到 → 追加下发 `daemonSetName`（携带此刻的 `info.name`，此时已是新名）→ worker patch 本地文件。

协议改动须遵守 `AGENTS.md` 纪律：Rust 侧 `crates/protocol` 与 TS 侧 `packages/protocol` 线格式一致，proto 改后必须 `cd proto && buf generate`（remote 插件需联网，已确认本环境可用）。

### Milestone 1: 协议贯通 —— `DeviceSetName` / `DaemonSetName` 落地生成产物

`client.proto` 新增 `DeviceSetName`（tag=26）、`daemon.proto` 新增 `DaemonSetName`（tag=22），`buf generate` 产出 TS/Rust/Swift 三端代码，无手改生成文件。
Validation: `cd proto && buf lint` exit 0；`cd proto && buf generate` exit 0 且 `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen proto/gen/swift` 只显示与本计划改动一致的 diff；`cargo check -p coflux-protocol` exit 0。

### Milestone 2: 服务端 —— 改名持久化 + 广播 + 在线即时下发 + 握手补偿下发

`store.ts` 新增 `updateDeviceName`；`hub.ts` 新增 `deviceSetName` case（含空名拒绝、归属校验、在线设备的内存元数据更新与即时下发）；`registerDaemonConn` 追加对每次握手完成的连接下发 `daemonSetName`。
Validation: `pnpm --filter @coflux/server build`（`tsc -p tsconfig.json`）exit 0。

### Milestone 3: daemon 侧 —— 收到 `DaemonSetName` 后 patch 本地 `settings.json`

`crates/worker/src/main.rs` 的 `route_authed` 分发新增 `DaemonSetName` 分支：读原始 JSON、按存在性决定 patch-or-skip、写回；不影响其余字段。
Validation: `cargo check -p coflux-worker` exit 0；`cargo build -p coflux-worker` 零警告。

### Milestone 4: web 端 —— 重命名入口 + 对话框

`dialogs.tsx` 新增 `DeviceRenameDialog`；`sidebar.tsx` 设备行包一层 `ContextMenu`（「重命名」+ divider +「移除设备」，保留现有内联删除按钮不变）；`workbench.tsx` 接线 state + `saveDeviceName` + 挂载对话框。
Validation: `pnpm --filter @coflux/web build`（`tsc -b && vite build`）exit 0。

### Milestone 5: 黑盒验收

新增或扩展 `tests/src/` 用例，覆盖：(a) 在线设备改名后 web 端广播可见且新名落库；(b) 在线设备改名后该 daemon 收到 `daemonSetName` 且本地 `settings.json`（测试需显式在 `stack.home` 下预先写好一份含 `deviceName` 等字段的 settings.json，因为默认测试 harness 纯靠 env 驱动、不落盘，见 Landmines）的 `deviceName` 被更新为新值；(c) 离线设备改名后重连即被补发同步。
Validation: 新测试文件单独可跑（见 Commands 的 acceptance 行）。

## Landmines

- **默认黑盒测试 daemon 不落盘 `settings.json`**：`tests/src/harness.mjs:250-255` 起的 `startStack` 只传 `COFLUX_DEVICE_NAME` 等 env，`home` 是空临时目录。要验证"本地文件被同步"这条行为，测试必须自己在 `stack.home` 里先手写一份 `settings.json`（且不能再靠冲突的同名 env，否则 `pick()` 优先级会让 env 值掩盖文件读取结果——env 只影响 daemon 启动时 `Settings::load` 的取值，不影响后续 `DaemonSetName` 到达时 worker 直接读文件 patch 的行为，两者互不冲突，但断言时要读文件而非看 env）。
- **在线设备改名不能只等 `registerDaemonConn`**：那是握手时机，改名发生在已建立的连接上不会重新触发它。`hub.ts` 的 `deviceSetName` 分支必须自己判断目标是否在线（`this.daemons.get(daemonId)`）并主动下发，否则在线设备要等下次断线重连才会同步本地文件，体验上是"改名后 web 立刻变了，但本机要断线重连才变"，不符合需求 1（web 立即生效）与 3（本机同步）的合理组合预期。
- **`Settings` 结构体只有 `Deserialize`**（`crates/protocol/src/settings.rs:6-13`），不要顺手给它加 `Serialize` 走整体反序列化再序列化——会丢未知字段/固化 env 覆盖值，已在 Decisions 中定案为 `serde_json::Value` 局部 patch。
- **`ClientToServer`/`ServerToDaemon` 的字段号是唯一真相**：新增字段前务必重新 grep 一遍两个 oneof 里当前实际最大 tag（本计划记录的 26/22 是规划时刻的值），若期间又有其他并行改动占用了这些号，以实际代码为准，不要盲目复用本文档写死的数字。

## Scope

In scope:

- `proto/coflux/v1/client.proto`、`proto/coflux/v1/daemon.proto` 及 `buf generate` 产物（`packages/protocol/src/gen`、`crates/protocol/src/gen`、`proto/gen/swift`）
- `apps/server/src/store.ts`、`apps/server/src/hub.ts`
- `crates/worker/src/main.rs`（及必要时新增的小型 settings 写入 helper，放在 worker crate 内）
- `apps/web/src/components/workbench/dialogs.tsx`、`sidebar.tsx`、`workbench.tsx`
- `tests/src/`（新增/扩展黑盒用例）
- `plans/README.md`

Out of scope:

- `packages/cli/cofluxd.mjs` —— CLI 侧写入逻辑不动，仍是独立写者
- `devices` 表新增列 —— 已决策复用 `name`
- 设备"取消别名回退原名"交互 —— 需求没有要求保留原始上报名
- `crates/supervisor/`—— supervisor 不读写 `settings.json` 里的 `deviceName`（只有 worker 在这条链路上），不涉及
- tmp+rename 原子写入 / 文件锁 —— 已决策跟随现有直接覆盖写风格

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto lint | `cd proto && buf lint` | exit 0 |
| proto 重生成 | `cd proto && buf generate` | exit 0，产物已提交 |
| Rust 构建 | `cargo build -p coflux-worker -p coflux-protocol` | exit 0，零警告 |
| server 类型检查/构建 | `pnpm --filter @coflux/server build` | exit 0 |
| web 类型检查/构建 | `pnpm --filter @coflux/web build` | exit 0 |
| 黑盒全量 (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 在线设备改名：web 端广播即时可见，DB 落库，该设备本地 `settings.json` 的 `deviceName` 在无需重连的情况下被更新。
- [ ] 离线设备改名：重连后本地 `settings.json` 被补发同步。
- [ ] 空名（trim 后为空）提交被拒绝，不落库、不下发。
- [ ] `settings.json` 缺失时 worker 静默跳过本地写入，不影响连接/其他功能。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其是 26/22 这两个 tag 号，见 Landmines）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf generate` 无法运行（remote 插件不可达）——协议改动无法安全落地时停下报告。

## Maintenance notes

- 若未来 `cofluxd` 给 `settings.json` 加新字段，worker 侧的 `serde_json::Value` 局部 patch 天然兼容（不用跟着改 `Settings` 结构体）；但若哪天决定给 `Settings` 加 `Serialize` 走整体回写，要重新审视 env 覆盖值固化的问题。
- `devices.name` 现在同时承担"设备自报名"和"用户别名"两个语义（后者会覆盖前者且不可逆），未来若需要区分两者（如展示"原名"供排查），需要额外加列，当前明确不做。
