# Plan 092: 中心托管 MCP 第三片——每个 PTY 会话注入 COFLUX_* 环境变量 + SKILL 改写

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c0aa426..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/device.proto crates/protocol/src/ipc.rs crates/supervisor/src/sessions.rs crates/supervisor/src/main.rs crates/worker/src/main.rs crates/worker/src/device.rs apps/server/src/hub.ts apps/server/src/config.ts packages/cli/skills/coflux/SKILL.md`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: plans/091-mcp-write-tools-daemon-effects.md（DONE）
- Category: feature
- Execution: subagent fable（出发检查 2026-09-05 授权：090 → 091 → 092 连续写 plan 并执行，中途不再向用户确认；STOP/BLOCK 仍停；push/PR/merge 不在授权内）
- Planned at: `c0aa426`, 2026-09-05

## Requirement

090/091 之后，任何机器上的 Claude Code / Codex 都能经 OAuth 接入中心 `/mcp` 读写账号资产。但**跑在
coflux 终端里的 agent** 调这些 tools 时不知道「我在哪台设备、哪个项目、哪个工作区、哪个终端」——
tools 全部显式传 id，它得先有 id。用户拍板（dev-explore 2026-09-05）：**每个 coflux PTY 会话注入
`COFLUX_*` 环境变量**，agent 读环境变量即可引用自己的上下文；不做 `cofluxd context` 命令，也不靠
`list_workspaces` 的 path 对 `pwd` 猜。

同时改写随 `cofluxd` 分发的 `skills/coflux/SKILL.md`：它现在只教本地零凭证命令，要教清「本地命令
与 MCP 的分工」以及「先看环境变量再把 id 传给 MCP」。

### 做完之后为真（消费者视角）

1. 在 coflux 里开出来的**每一个** PTY 会话（web/iOS 手开的、`cofluxd terminal new` 开的、MCP
   `create_terminal` 开的）里，`env | grep ^COFLUX_` 能看到：

   | 变量 | 值 |
   |---|---|
   | `COFLUX_DEVICE_ID` | 本机 daemon 的设备 id（`list_devices` 的 id） |
   | `COFLUX_PROJECT_ID` | 所属项目 id；无仓库的目录工作区为空串（变量存在但为空） |
   | `COFLUX_WORKSPACE_ID` | 所属工作区 id |
   | `COFLUX_TASK_ID` | 本终端的任务 id（`list_terminals` / `read_terminal` 用的 terminalId） |
   | `COFLUX_SESSION_ID` | 本 PTY 会话 id |
   | `COFLUX_MCP_URL` | 中心 MCP 地址（`<COFLUX_PUBLIC_URL>/mcp`），供 agent 告诉用户怎么 `claude mcp add` |

   这些值与中心 `list_*` 返回的 id 完全一致；agent 直接把它们传给 MCP tools。
2. daemon 与 supervisor 升级前后**不会坏**：旧 supervisor 配新 worker、旧 worker 配新中心，都只是
   「没有这些变量」，会话照常起。
3. `SKILL.md`（随 `cofluxd` npm 包分发）改写后 agent 能自己判断：不在 coflux 里（变量不存在）就忘掉
   这套；在 coflux 里但没配 MCP 就用本地 `cofluxd terminal/notify/progress/ports`，并可把
   `$COFLUX_MCP_URL` 告诉用户去配；配了 MCP 就用账号级 tools 开子工作区/跨工作区读写，本地命令仍是
   本工作区内最省事的路径。`packages/cli/README.md` 与根 README 的「给 agent 用的命令」段同步。
4. `cofluxd`、web、iOS 行为零变化；sessiond 的 holder / input_seq / attach 语义零变化。

### 相邻的错误解法（不是这个）

- **不是**由中心下发一张任意的 env map 让 supervisor 原样 apply：那是一条「中心往用户 shell 注入任意
  环境变量」的开放通道，而且变量名会散落在中心与 supervisor 两侧。本片只下发 **id**，变量名与组装
  只在 supervisor 一处。
- **不是**用包装脚本 `export` 这些变量：要覆盖用户手开的终端，包装脚本会改所有 shell 的启动方式
  （login shell 语义、进程树），用户 2026-09-05 已选 supervisor 注入。
- **不是**只覆盖 MCP 开的命令终端：用户在 web 上手开的终端里跑 claude 是最主要的场景，必须覆盖
  全部三条建会话路径。
- **不是**让 supervisor 自己去读 credentials 猜 daemon id：supervisor 目前完全不知道 daemon id
  （grep 无命中），id 由中心随建会话请求带下来。

## Decisions & tradeoffs

- **变量名与组装只在 supervisor 一处，中心只下发 id**：`create_session` 是两条建会话入口（legacy IPC
  `create` 与 device 路径 `device_create`）的汇合点，在它里面、**拷贝完 `std::env::vars()` 之后**再
  `command.env(...)` 写入 `COFLUX_*`（覆盖语义，保证不被 supervisor 自身环境里的同名变量盖掉）。
  Rejected: 中心下发 env map——见「相邻的错误解法」；Rejected: worker 侧组装——device 路径的帧是
  worker 原样转给 sessiond 的（`DataFrame::Device`），worker 不解包，只能由 supervisor 组。
  Based on: `crates/supervisor/src/sessions.rs:748`（`create_session` 签名）、`:793-796`（env 拷贝与
  TERM 覆盖点）、`:701`（legacy `create` 入口）、`:1725`（`device_create` 入口，自己解码
  `DeviceSessionCreate` 后调 `create_session`）；supervisor 源码中无 daemon id / credentials 读取。

- **id 随两条建会话请求下发；协议字段只加不改**：`proto/coflux/v1/daemon.proto` `SessionCreate`
  加 `workspace_id` / `project_id` / `daemon_id` / `mcp_url`（字段号 **7 起**）；
  `proto/coflux/v1/device.proto` `DeviceSessionCreate` 加同名字段（字段号 **10 起**，9 是 091 的
  `command`）；`crates/protocol/src/ipc.rs` 的 `WorkerToSupervisor::SessionCreate` 加同名**可选**字段
  （`#[serde(default)]`，`skip_serializing_if` 为空）。中心三处组帧全部带上：`cofluxd terminal new`
  的直发 `sessionCreate`、web `taskStart` 的 prepared `session.create`、MCP `create_terminal` 的
  prepared `session.create`。`mcp_url` 由中心按 `config.publicUrl + "/mcp"` 填。
  Rejected: 只改 device 路径——`cofluxd terminal new` 走的是直发 IPC 路径，漏掉它 agent 自己开的
  子终端就没有变量。
  Based on: `proto/coflux/v1/daemon.proto` `SessionCreate` 字段 1-6；`proto/coflux/v1/device.proto`
  `DeviceSessionCreate` 字段 1-9；`crates/protocol/src/ipc.rs:37-48`；`apps/server/src/hub.ts:1284`
  （agent terminalNew 直发）、`:3121`（startOrAttachTask 的 createFrame）、`:3655`
  （createTerminalForAccount 的 createFrame）；`apps/server/src/config.ts` `publicUrl`（090）。

- **worker 只在直发路径做字段映射（proto → IPC），device 路径零改动**：worker 收到中心的
  `SessionCreate` 时把新字段原样塞进 IPC `session.create`；device 路径的帧不解包，supervisor 自己从
  `DeviceSessionCreate` 读。091 的 `execute_prepared_operation` 会 decode→改 shell→re-encode，prost
  decode 丢未知字段：这是 **worker 与 proto 同版本**的路径（同一次热升级带上新字段），只要 worker
  的生成产物随本片更新即可，不需要额外代码。
  Based on: `crates/worker/src/main.rs:1785`（直发 SessionCreate → IPC 的转发点）；
  `crates/worker/src/device.rs` `execute_prepared_operation`（091，decode/re-encode）；
  `crates/supervisor/src/main.rs:290-300`（device 帧原样 `handle_device`）。

- **兼容矩阵是「缺就没有，绝不报错」**：旧 supervisor 的 `serde_json::from_slice::<WorkerToSupervisor>`
  无 `deny_unknown_fields`，忽略新 IPC 字段 → 无 env；旧 worker 不映射 → 无 env；旧中心不下发 → 无 env。
  supervisor 侧字段全部 `Option`/空串默认，缺任一都只是对应变量为空串或不设置（执行者定，但 SKILL 里
  的探测规则要与之一致：以 `COFLUX_WORKSPACE_ID` 非空作为「在 coflux 且已升级」的判据）。
  `ipc.rs` 照 `:409-450` 的 `LegacyWorkerToSupervisor` 写法补一条 `session.create` 的兼容测试。
  Based on: `crates/supervisor/src/main.rs:297`（`if let Ok` 解码，失败静默丢弃整条——所以字段类型
  必须是可缺省的，否则解码失败会**吞掉建会话请求**）、`:360-372`（dispatch 只解构已知字段）；
  `crates/protocol/src/ipc.rs:33-48`、`:409-450`。

- **supervisor 本片改动，且改动只限 `create_session` 的 env 组装与两条入口的参数透传**：这是用户
  2026-09-05 明确选择环境变量方案后对 074「supervisor 零改动」约束的**一次性**放开；sessiond 的
  holder / input_seq / attach / 账本 / resync 语义零改动。supervisor 不走热升级，用户要
  `cofluxd update && cofluxd restart` 才生效——写进 Maintenance notes 与 README。
  Based on: `plans/074-agent-coflux-control.md` Decisions 第 2 条（supervisor 零改动的理由：不走热升级）；
  `crates/supervisor/src/sessions.rs:261-265`（账本 canonical 含 shell 但不含新 id 字段——新字段
  进入 canonical 也没关系，同一 operation 重放时值相同）。

- **SKILL.md 改写为「本地命令 + MCP 双轨」**：结构：先判断在不在 coflux（`COFLUX_WORKSPACE_ID` 非空）；
  本工作区内的开终端/读/等/输入/播报/叫人/端口仍用本地 `cofluxd`（零凭证、最省事）；要开子工作区、
  跨工作区/跨设备操作、或从 coflux 之外接入时用 MCP tools（列出 14 个 tool 的用途与人类优先/有界等待
  /「需要升级」三条纪律）；没配 MCP 时告诉用户 `claude mcp add --transport http coflux $COFLUX_MCP_URL`。
  保留 088 写下的纪律（先 read 再 send、被拒即停、progress 与 notify 分界、别轮询等待）。
  `packages/cli/README.md` 的「给 agent 用的命令」段与根 README 同步一段简述。
  Rejected: 另起一个 MCP 专用 skill——agent 只装一个 skill，分工写在一处才不矛盾。
  Based on: `packages/cli/skills/coflux/SKILL.md`（现有结构：什么时候用 / 命令 / 边界）；
  `packages/cli/README.md`「给 agent 用的命令」；`README.md`「用户侧」段。

- **黑盒测试覆盖三条建会话路径**：① MCP `create_terminal` 跑 `env | grep '^COFLUX_' | sort`，
  `read_terminal`（source=log）里五个 id 与 MCP_URL 与中心返回的 id 完全一致（目录工作区另断言
  `COFLUX_PROJECT_ID` 为空串）；② web 手开的终端（device-harness `taskCreate`/`taskStart` + attach）
  输入 `echo W=$COFLUX_WORKSPACE_ID T=$COFLUX_TASK_ID S=$COFLUX_SESSION_ID`，经 `read_terminal`
  或 checkpoint 读到；③ 在 coflux 终端里跑 `cofluxd terminal new --cmd 'env | grep ^COFLUX_'`
  （直发 IPC 路径，照 `agent-control.test.mjs` 的驱动方式），`terminal read` 里能看到。负向：
  `ipc.rs` 的 Legacy 兼容测试证明旧解析器忽略新字段且不失败。新用例做过负向验证。
  Based on: `tests/src/mcp-write-tools.test.mjs`（091 的 tool 驱动与 readUntil 辅助）；
  `tests/src/agent-control.test.mjs:25,59`（`cofluxd` 子进程驱动）；`tests/src/device-harness.mjs`。

- **前端零改动，不做 Claude 验证**（仓库惯例）。

## Direction

```
中心（三处组帧）──ids + mcp_url──▶ worker
   直发 SessionCreate ──proto→IPC 映射──▶ supervisor.create(...)      ─┐
   prepared DeviceSessionCreate ──帧原样──▶ supervisor.device_create(...) ─┴─▶ create_session：
                                                  拷贝 std::env → 覆盖写入 COFLUX_DEVICE_ID / PROJECT_ID /
                                                  WORKSPACE_ID / TASK_ID / SESSION_ID / MCP_URL → spawn PTY
agent（任意 PTY）：env 有值 → 传给 MCP tools；无值 → 不在 coflux 或未升级，走 SKILL 的降级分支
```

### Milestone 1: 协议与 IPC

`daemon.proto` `SessionCreate` 字段 7+、`device.proto` `DeviceSessionCreate` 字段 10+，三侧
`buf generate`；`ipc.rs` `session.create` 加可选字段 + Legacy 兼容测试。
Validation: `cd proto && buf generate && git status --short` -> 只含本次字段的产物变化；
`cargo test -p coflux-protocol` -> exit 0（含新增 Legacy 测试）。

### Milestone 2: supervisor + worker

supervisor：`create_session` 组装并覆盖写入六个变量；`create` 与 `device_create` 透传；除此之外
零改动。worker：直发路径字段映射。
Validation: `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` -> exit 0 零警告；
`cargo test -p coflux-supervisor -p coflux-worker` -> exit 0；
`git diff --stat c0aa426..HEAD -- crates/supervisor` -> 只含 `sessions.rs`（及如需的 `main.rs` 透传）。

### Milestone 3: 中心组帧

三处建会话请求带上 ids 与 `mcp_url`；`config` 若需新增派生值就近加。WS/MCP 行为零变化。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: SKILL / README

`packages/cli/skills/coflux/SKILL.md` 改写（双轨 + 探测 + 14 个 tools + 纪律），`packages/cli/README.md`
与根 `README.md` 同步。
Validation: `node packages/cli/cofluxd.mjs --help` -> exit 0（CLI 本身未改，防误伤）。

### Milestone 5: 黑盒验收

新测试文件（端口从 **8870** 起）覆盖 Decisions 里的三条路径与目录工作区空 `COFLUX_PROJECT_ID`；
`plans/README.md` 由编排者更新。
Validation: `node --import tsx --test tests/src/<新文件>.test.mjs` -> exit 0（acceptance）。

## Landmines

- **supervisor 解码失败是静默丢弃整条**（`crates/supervisor/src/main.rs:297` `if let Ok`）：IPC 新字段
  必须可缺省（`Option` + `#[serde(default)]`），任何 `String` 必填字段都会让旧 worker 的 `session.create`
  被新 supervisor 整条吞掉——会话永远起不来且没有错误。
- **env 覆盖顺序**：`sessions.rs:793-796` 先 `for (key, value) in std::env::vars()` 再 `command.env("TERM", …)`；
  `COFLUX_*` 必须写在拷贝之后，否则 supervisor 自身环境里的同名变量（例如用户 shell 里 export 过的
  `COFLUX_HOME` 之类不冲突，但 `COFLUX_SESSION_ID` 若曾泄漏进 supervisor 环境）会盖掉它。
- **不要给 IPC/proto 加名为 `env` 的通用 map**（决策第 1 条）；也不要顺手把 `COFLUX_HOME`/`COFLUX_SERVER`
  之类 daemon 配置塞进会话 env。
- **sessiond 账本 canonical 含整个 `DeviceSessionCreate`**（`sessions.rs:261-265`）：新字段进入
  canonical，同一 operation 重放时中心组帧的值必须一致（它们本来就是稳定 id，别把时间戳之类
  易变值塞进去）。
- **091 的 `execute_prepared_operation` 会 decode→re-encode**：worker 的生成产物必须随本片一起更新，
  否则 MCP 命令终端会丢掉新字段；CI 的产物零 diff 门会抓。
- **测试里 daemon 的设备 id 来自 `stack.daemonId`**，MCP 的 `list_devices` 也返回它；两边断言同一个值。
- **黑盒各 `*.test.mjs` 顶部 `const PORT` 独占端口**，091 已用到 8869。
- **SKILL.md 随 npm 包发布**，改完要在 `packages/cli` 发版后才到用户手里；本片只改仓库内容，
  发版不在范围。
- **旧 supervisor 不走热升级**：生产/用户机器上要 `cofluxd update && cofluxd restart` 才有变量；
  SKILL 的探测分支（变量为空）就是给这段过渡期用的。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`、`proto/coflux/v1/device.proto` + 三侧生成产物
- `crates/protocol/src/ipc.rs`（含测试）
- `crates/supervisor/src/sessions.rs`、`crates/supervisor/src/main.rs`（仅入口透传）
- `crates/worker/src/main.rs`（直发路径字段映射）；`crates/worker/src/**` 其它文件只在编译需要时最小改动
- `apps/server/src/hub.ts`、`apps/server/src/config.ts`
- `packages/cli/skills/coflux/SKILL.md`、`packages/cli/README.md`、`README.md`
- `tests/src/`（新用例）

Out of scope:
- sessiond 的 holder / input_seq / attach / 账本 / resync **语义** —— 零改动
- `packages/cli/cofluxd.mjs`（不加命令）、MCP tools（090/091 已定）、OAuth
- `apps/web`、`apps/ios`、`apps/mobile`、`packages/client`、`packages/swift-client` 源码（生成产物除外）
- npm/tag 发版
- `plans/README.md` —— 编排者更新

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查（生成类型不破） | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| mobile 构建 | `pnpm -C apps/mobile build` | exit 0 |
| proto 再生成 | `cd proto && buf generate` | 产物只含预期变化 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0，零警告 |
| CLI 未破 | `node packages/cli/cofluxd.mjs --help` | exit 0 |
| client 包单测 | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| 本片黑盒 (acceptance) | `node --import tsx --test tests/src/<新文件>.test.mjs` | exit 0 |
| 090/091 回归 (acceptance) | `node --import tsx --test tests/src/mcp-oauth.test.mjs tests/src/mcp-isolation.test.mjs tests/src/mcp-write-tools.test.mjs tests/src/agent-control.test.mjs` | exit 0 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | 全过 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 三条建会话路径开出的 PTY 里 `COFLUX_*` 六个变量齐全且与中心 id 一致；目录工作区 `COFLUX_PROJECT_ID` 为空串。
- [ ] 旧 supervisor / 旧 worker 组合只是缺变量，不影响建会话（Legacy 测试 + 字段全可缺省）。
- [ ] SKILL.md 讲清本地命令与 MCP 的分工、探测规则与三条纪律；README 同步。
- [ ] sessiond 语义零改动；`cofluxd` 命令面零改动；web/iOS 零改动。
- [ ] 新黑盒用例做过负向验证（抽掉 env 组装后确实失败）。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- 需要改动 sessiond 的 holder / input_seq / attach / 账本 / resync 语义才能注入 env——STOP。
- IPC 新字段无法做到旧解析器忽略（例如 IPC 不是 serde JSON 或有 `deny_unknown_fields`）——STOP。
- `SessionCreate` 7 / `DeviceSessionCreate` 10 已被占用。
- 某条 Decisions 引用的事实已不成立。
- 任一验证命令在一次合理修复后仍连续失败两次。

## Maintenance notes

- 本片是 074「supervisor 零改动」约束的一次性放开（用户 2026-09-05 选环境变量方案）；以后再碰 supervisor
  仍按「不走热升级、全网手动更新」的代价评估。
- 变量名是 agent 面向的契约（写进 SKILL）：改名等于破坏所有已装 skill 的 agent，只能加不能改。
- 生产生效节奏：server 部署即下发 id；worker 随 tag 热升级映射直发路径；supervisor 需用户
  `cofluxd update && cofluxd restart`；SKILL 随 `cofluxd` npm 发版。四端都到位前 SKILL 的降级分支兜底。
- 本片完成即 090→092 三片收官：中心 MCP（OAuth + 14 tools）+ 会话上下文注入。后续议题：已授权应用
  列表/撤销 UI、CIMD、notify/progress 经 MCP、fs/exec 类 tools——各自另立 plan。
