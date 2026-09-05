# Plan 091: 中心托管 MCP 第二片——中心发起的 daemon 副作用 + 工作区/终端写 tools

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat d952471..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/device.proto crates/worker/src apps/server/src/hub.ts apps/server/src/prepared-operation.service.ts apps/server/src/prepared-operation-convergence.service.ts apps/server/src/mcp apps/server/src/oauth.ts apps/server/src/store.ts tests/src/oauth-harness.mjs`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/090-mcp-oauth-readonly-tools.md（DONE）
- Category: feature
- Execution: subagent fable（出发检查 2026-09-05 授权：090 → 091 → 092 连续写 plan 并执行，中途不再向用户确认；STOP/BLOCK 仍停；push/PR/merge 不在授权内）
- Planned at: `d952471`, 2026-09-05

## Requirement

090 之后，任何机器上的 Claude Code / Codex 已能经 OAuth 接入中心 `/mcp` 并**只读**账号资产。本片
补上用户拍板的写能力：agent 能在账号内**开子工作区（git worktree）、在任一工作区里开终端跑命令、
读输出、往终端输入、等命令结束、停止/删除终端、收尾删除工作区**——也就是「开一个工作区跑一个
子任务再回收」的最小闭环。同时把 090 的 `read_terminal` 从「中心 2 秒周期 checkpoint」升级为
「优先经 daemon 读命令日志」，秒级命令的输出不再丢。

### 做完之后为真（消费者视角）

新增 tools（snake_case 名以此为准，参数/输出形状执行者定，风格延续 090：结构化结果 + 同内容
JSON 文本，失败用 `isError` 且错误可读）：

| tool | 语义 |
|---|---|
| `create_workspace` | 在某项目下建 worktree 工作区：项目 id、分支名、是否新建分支、名称（可省，默认同分支）。返回新工作区（id、路径、分支）。设备离线 → 明确错误。 |
| `rename_workspace` | 改名（纯中心记录）。主工作区也可改名（与 web 一致）。 |
| `remove_workspace` | 删 worktree 工作区：先关掉其下所有终端会话，再删 worktree 与记录。主工作区不可删（与 web 一致，提示「删整个项目」）；目录工作区只删记录。 |
| `create_terminal` | 在某工作区开一个真实终端跑一条命令：工作区 id、标题、命令。命令在该工作区目录下用登录 shell 执行，跑完终端退出并带退出码；输出同时落 daemon 侧命令日志（供 read）。返回终端 id。受每工作区活跃终端上限约束（含用户手开的），超限 → 明确错误。 |
| `read_terminal` | （升级）优先经 daemon 读命令日志尾部；不是命令终端（用户手开）或 daemon 拿不到时退回 daemon 本地快照；设备离线时退回中心 checkpoint。返回文本 + 来源（log / snapshot / checkpoint）+ 状态/退出码。 |
| `send_terminal_input` | 往终端写文本（可选追加回车）。**用户正在接管（attach）该终端时被拒**，错误说明「用户正在接管」；终端已退出 → 明确错误。 |
| `wait_terminal` | 阻塞等某终端退出，**有上限**（默认与上限都不超过 50 秒），到期返回当前状态而非报错；退出则返回退出码。agent 需要更久就再调。 |
| `stop_terminal` | 结束终端会话（等价 web 的停止）；返回时会话已退出或已在退出中。 |
| `remove_terminal` | 删除终端记录（含 checkpoint）。仍在运行的终端必须先 `stop_terminal`，否则明确错误。 |

以上所有 tools 只作用于调用者账号的资产；带 id 的入参不属于当前账号与不存在回同一句错误（090 惯例）。
**目标设备的 daemon 不支持本片新增的控制消息时（旧 worker 未热升级），任何写 tool 都返回可读错误
「该设备的 daemon 需要升级」，绝不静默等到超时。** web 侧栏对这些操作的反应与用户在 web 上亲手做
完全一致（同一套广播），无需改 web。

### 相邻的错误解法（不是这个）

- **不是**中心持有一条「虚拟 device channel」把浏览器那套 Device RPC 全部转成中心可调：架构边界
  明写数据帧不经中心控制 WS、中心零 channel 状态；本片只加**逐操作**的控制消息。
- **不是**复活 074 的直发 `SessionCreate` 来建终端：那条路在建 task 时写死 sessionId，控制 WS 投递前
  断开会留下永远 IDLE 的僵尸任务；本片建终端走 prepared `session.create`。
- **不是**改 sessiond 的 holder / input_seq / attach 语义，也**不是**改 supervisor：输入只经 worker 既有的
  `agent_send_input` 正门（人类优先拒绝原样保留）；supervisor 目录零改动（092 才会碰它）。
- **不是**在中心复制一份 worktree/session 的落库与广播逻辑：中心发起的 prepared 操作走**同一个**收敛
  事务，差别只在「谁触发执行」与「结果通知谁」。
- **不是**按 worker 版本号做 semver 门禁：worker 在 dev/测试里上报 `builtin`，仓库的自动升级也刻意不做
  semver 比较；门禁按 daemon 认证时**宣告的能力**判定。
- **不是**给 MCP 一个长阻塞的 `wait`：Claude Code 对远程 HTTP MCP 单次请求默认 60 秒超时。

## Decisions & tradeoffs

- **中心发起的 daemon 副作用 = 复用 prepared operation + 新增「中心触发执行」控制消息，不做虚拟
  channel（方案 B）**：worktree 增/删与建会话都先按既有方式 prepare（记录落库、帧装到 daemon），
  然后由中心经控制 WS 发 `PreparedDeviceOperationExecute{operation_id}` 触发执行，worker 用已安装
  的帧走**同一条** dispatch，结果沿既有 `DeviceOperationReport` 回中心、由既有收敛事务落库与广播。
  Rejected: 方案 A「中心作为一个 device channel 客户端」——`handle_remote_frame` 要求 channel 已按
  transport 注册、`Principal::Relay` 要 scopes/generation，且 docs/architecture.md §5.2 明写数据帧
  不经中心控制 WS、中心零 channel 状态；Rejected: 复活 worker 里仍活着的直发 `WorktreeAdd→WorktreeAdded`
  （`crates/worker/src/main.rs:1707-1738`）——`WorktreeRemove` 直发无回执（`:1739-1746`），中心也已不
  处理直报 `worktreeAdded`，走这条要在中心重造一份落库/广播。
  Based on: worker 侧 prepared 执行不依赖 channel 存在：`crates/worker/src/device.rs:2270-2278`
  （`finish_call`→`send_payload` 对不存在的 channel 直接 return）、`:2264-2267`（`report_operation`
  独立走控制 WS）、`:2466-2470`（sessiond 回执先 report 再查 channel）；`authorize_prepared` 只比
  daemon_id + 帧字节（`:1888-1920`）；`Principal::request_key` 只在无 operation_id 时用（`:1985-1990`）。

- **worker 执行中心触发的 prepared 操作时用新的 `Principal::Server` 与合成 channel id
  `__coflux-server-<operationId>`**：该 principal 只对**已安装的 prepared 操作**有效（`authorize_prepared`
  按安装模板放行），不给它任何非 prepared 的 Device RPC 权限；合成 channel 不注册到 `channels`
  表，往它回的应答按既有逻辑丢弃。合成 id 不得撞 `__coflux-worker` / `__coflux-agent-` 前缀，且
  `validate_relay_dial` 对 `__coflux-` 前缀的保留照旧覆盖它。同一 operation_id 的重复 Execute（中心
  restore 后重发）必须幂等：已执行/执行中的只重发上次 report 或忽略，不得二次执行。
  Based on: `crates/worker/src/device.rs:40-43`（`INTERNAL_CHANNEL_ID`、`AGENT_CHANNEL_PREFIX`）、
  `:2450-2465`（这两类 id 的专门分派）、`:3288`（`validate_relay_dial` 保留 `__coflux-` 前缀）、
  `:485-560`（`Principal` 枚举与 `ChannelEntry`）、`:1722-1770`（`handle_client_frame` 从 `channels`
  取 principal——中心触发路径需绕过这一步）、`:399-404` + `:1346-1365`（`PreparedRecord` 只存
  canonical 帧，按 operation_id 查）。

- **中心侧：server 发起的 prepared 记录带 `initiator: "server"` 标记；安装确认后中心自己下发 Execute；
  hub 新增「完成原语」，WS 分支零改动**：`prepared-operation.service.ts` 的 `prepare` 是 client 绑定的
  （失败只 `sendError(client)`、安装确认后 `emitToClient` 把帧交给浏览器、`restore` 后无 waiter 则什么
  都不发生），必须新增一条**无 client** 的入口：admission 结果作为返回值而非发给 client；
  `handleInstalled` 与 `restore`→installed 看到 metadata 里的 `initiator:"server"` 就 `sendDaemon(Execute)`
  而不是 emitToClient（server 重启后也自动续上）；超时/取消（`watch`、`cancelDaemon`、`cancelMany`）
  对 server 发起的记录要唤醒完成原语而不是发给不存在的 client。完成原语 = hub 内按 **operationId**
  （在 `handleDeviceOperationReport` 的收敛末尾按 applied/failed 唤醒，携带 effect 或错误）与按
  **taskId**（在 `sessionStarted` / `sessionExit` 分支唤醒）的 Deferred 表，带上限与超时，daemon 断开
  或换代时以可读错误唤醒。create_workspace / remove_workspace / create_terminal / stop_terminal /
  wait_terminal 都靠它拿结果。
  Rejected: 把 MCP 伪装成一个 ClientConn 喂进 `handleClientMessage`——浏览器那跳（帧经 device channel
  送回 daemon）仍然没人做，且要拦截所有 sendClient。
  Based on: `apps/server/src/prepared-operation.service.ts:96-100`、`:457-545`（`prepare` 的 admission
  与 `sendError(client)`/`resumeCurrentForClient`）、`:128-139`、`:577-601`（`handleInstalled`→
  `emitToClient`）、`:544-557`（`restore`）；`apps/server/src/hub.ts:1319-1440`（`handleDeviceOperationReport`
  → `convergeAndApply`，effect 含 workspace/task/sessionId/removedWorkspaceId/removedTaskIds/error）、
  `:1831-1870`（sessionStarted）、`:1872-1915`（sessionExit）；`store.ts:184-200`
  （`PreparedOperationRecord.metadata` 是 JSON 文本，`hub.ts:3309` `parseOperationMetadata`）。

- **建终端走 prepared `session.create`，`DeviceSessionCreate` 加 `command` 字段（字段号 9），包装脚本
  路径按 operation_id 确定性派生**：中心在同一事务里建 IDLE task（沿用 `dispatchAgentControl.terminalNew`
  的准入：device 父行锁、项目删除中拒绝、每工作区活跃终端上限 `config.maxAgentTerminalsPerWorkspace`）
  并 prepare 带 `command` 的 `session.create`；worker 在 `authorize_prepared` 通过后、编码给 sessiond 前，
  若 `command` 非空则本地写包装脚本并把 `shell` 填成脚本路径，同时把日志路径按 task 记住（供 read）。
  **脚本路径必须由 operation_id 派生**：sessiond 账本的 canonical 请求含 `shell`，重放时路径若变会被
  判成 `operation_collision`。旧 worker 不认识 `command` 字段会起成普通 shell——由能力门禁挡在前面。
  Rejected: 沿 074 的直发 `SessionCreate` 加 command——僵尸 IDLE+sessionId 任务（见 Requirement）。
  Based on: `proto/coflux/v1/device.proto:470-479`（`DeviceSessionCreate` 字段 1-8，`shell` 为 6）；
  `crates/supervisor/src/sessions.rs:261-265`（`canonical_create_request` 只清 request_id，保留 shell）、
  `:1725-1745`（`operation_collision`）；`crates/worker/src/ops.rs:337-349`（`write_command_script`
  现用 pid+纳秒命名）；`hub.ts:1056-1145`（terminalNew 的准入事务）、`:2943-2983`（prepared
  session.create 的 admission check 形状）；`hub.ts:1091-1103`（直发路径写死 sessionId 的问题根源）。

- **读终端与输入：新增一对**可扩展的** server→daemon 请求/回执控制消息（一个 request 消息 + 一个
  result 消息，各带 oneof payload），首片装两种动作：读（task_id → 命令日志尾部优先，否则本地快照；
  回原始字节 + 来源），写（session_id + data → 经 `agent_send_input`，人类 holder 在场则拒并原样回
  错误文案）**。中心 `read_terminal` 的降级顺序：daemon 在线且支持 → 经 daemon；否则中心 checkpoint。
  去 ANSI / 尾 N 行仍在中心做（090 的 `mcp/text.ts`）。
  Rejected: 每个动作一对顶层消息——每加一种动作都要占两个字段号并改 worker 的顶层 match；
  Rejected: 复用 daemon 发起的 `AgentControlRequest/Result`——方向反了（那是 daemon 问中心）。
  Based on: `proto/coflux/v1/daemon.proto` `AgentControlRequest`/`AgentControlResult` 的 oneof 形状
  （可作同构参考）；`crates/worker/src/agent_ctl.rs:222-275`（terminal.read 的「命令日志优先、否则
  snapshot」与 `agent_logs` 表）、`:276-330`（send 的归属/已退出/未就绪判定与 `agent_send_input`）；
  `crates/worker/src/device.rs:1521-1524`（`human_holder_present`）、`:1534-1580`（`agent_send_input`
  含并发/identity 上限与超时语义，错误文案已可读）。

- **停止与删除复用既有路径**：stop = 既有 `sessionClose` 直发控制消息（与 web 的 workspaceRemove 关会话
  同一条），随后按 taskId 有界等待 `sessionExit`；remove = 与 web `taskRemove` 同一事务逻辑（device 父行锁、
  删 checkpoint、退休 runtime、广播），但 MCP 侧要求 status ≠ running（web 由 UI 保证，MCP 靠代码保证）。
  rename_workspace = 与 web `workspaceSetName` 同一逻辑；remove_workspace 目录工作区 = 与 web 的 DB-only
  分支同一逻辑，worktree 工作区 = 先 `sessionClose` 其所有会话再 prepared `worktree.remove`（server 发起）。
  Based on: `hub.ts:2510-2578`（workspaceRemove 两条分支）、`:1449-1476`（`prepareWorktreeRemoval`）、
  `:2684-2728`（taskRemove）、`:2578-2624`（workspaceSetName）；`proto/coflux/v1/daemon.proto`
  `ServerToDaemon.session_close = 10`。

- **能力门禁按 daemon 认证时宣告的能力，不按版本号**：`DaemonAuth` 加一个 repeated 字段（字段号 5）
  由新 worker 宣告本片的控制能力（名字执行者定，至少能区分「支持 Execute」与「支持读/写请求」）；
  hub 按 daemon 连接保存；MCP 写 tools 在发送任何本片新增消息前检查，缺失即返回「该设备的 daemon
  需要升级」。旧 worker 不发该字段 → 自然被挡。
  Rejected: 比较 `workerVersion`——dev/测试的 worker 上报 `builtin`，`auto-update.ts:8` 明写不做 semver
  比较；Rejected: 发了再等超时——旧 worker 对未知 `ServerToDaemon` 消息**静默丢弃**（`main.rs:1395-1410`
  的 match 只处理已知 payload），agent 会白等 50 秒且没有任何可读原因。
  Based on: `proto/coflux/v1/daemon.proto` `DaemonAuth` 字段 1-4；`hub.ts:121`、`:1557`、`:1594`、
  `:1614-1630`（daemon 认证时读取并保存 workerVersion 的位置，能力字段同处保存）；
  `crates/supervisor/src/manager.rs:841`（`builtin`）。

- **协议字段号**：`ServerToDaemon` 下一个可用 **38**（Execute、server→daemon 请求各占一个），
  `DaemonToServer` 下一个可用 **34**（回执），`DaemonAuth` **5**，`DeviceSessionCreate` **9**；reserved
  已核对。三侧 `buf generate`，CI `buf breaking` 只允许加。
  Based on: `proto/coflux/v1/daemon.proto` 两个 oneof 的 reserved 列表与最高号（37 / 33）。

- **`wait_terminal` 是中心侧有界等待**：默认与上限都 ≤ 50 秒（Claude Code 远程 HTTP MCP 单请求默认
  60 秒），靠完成原语按 taskId 等 `sessionExit`，到期返回当前状态（不是错误）。
  Based on: Claude Code docs（MCP_TOOL_TIMEOUT，HTTP 型 server 单请求 60s）。

- **硬约束零改动**：`crates/supervisor/**` 零改动；sessiond 的 holder / input_seq / attach 语义零改动；
  数据帧不经中心（读终端回执是有界文本，与 checkpoint 同级，worker 侧要钳制字节数）；`cofluxd` 与
  web 行为零变化。
  Based on: plans/074、088 的 Landmines；docs/architecture.md §5.2。

- **黑盒测试驱动方式**：经 090 的 `tests/src/oauth-harness.mjs` 拿 token 后直接调 MCP tools；「用户接管
  时输入被拒」用 `device-harness.mjs` 的 `attach` 造人类 holder（同 `agent-terminal-io.test.mjs:157-163`）；
  「旧 worker 门禁」用 `harness.mjs` 的 `rawDaemon()`（原始 /daemon 连接，不发能力字段）登记一台假设备，
  对它调写 tool 断言可读错误。负向用例做过负向验证（抽掉逻辑后确实失败）。
  Based on: `tests/src/harness.mjs:572`（`rawDaemon`）、`:616`（`authorizeDaemon`）；
  `tests/src/device-harness.mjs:736`（`openRelayDevice`）。

- **前端展示不做 Claude 验证**（仓库惯例）：本片不改 web/iOS，侧栏反应由既有广播保证。

## Direction

```
MCP tool（principal）──▶ hub 操作层（准入事务 + prepare(initiator=server)）
      │                       │ 安装确认 / restore→installed
      │                       └──控制 WS──▶ PreparedDeviceOperationExecute{operation_id}
      │                                          worker: 查已安装帧 → Principal::Server + __coflux-server-<op>
      │                                          → 同一条 dispatch（worktree add/remove → git；session.create
      │                                            → 有 command 则写脚本填 shell → sessiond）
      │                       ◀──控制 WS── DeviceOperationReport → 既有收敛事务落库/广播
      └── 完成原语（operationId / taskId 的 Deferred，有界）──▶ tool 返回结果或可读错误

read / input：hub ──ServerAgentRequest{read|input}──▶ worker（日志尾/快照；agent_send_input）──ServerAgentResult──▶ hub
stop：hub ──sessionClose──▶ worker；hub 按 taskId 等 sessionExit（有界）
门禁：DaemonAuth.capabilities ∌ 所需能力 → tool 直接返回「该设备的 daemon 需要升级」
```

### Milestone 1: 协议面

`daemon.proto`：`PreparedDeviceOperationExecute`、server→daemon 请求/回执消息对（oneof：read、input）、
`DaemonAuth` 能力字段；`device.proto`：`DeviceSessionCreate.command`。三侧 `buf generate`。
Validation: `cd proto && buf generate && git status --short` -> 只含本次消息的产物变化；
`cargo test -p coflux-protocol` -> exit 0；`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 2: worker

能力宣告；`Principal::Server` + 合成 channel 的 Execute 路径（幂等）；`command` → 确定性路径的包装
脚本 + 日志登记；server→daemon 读/写请求处理（读：日志尾优先、否则本地快照、钳制字节；写：
`agent_send_input`，错误文案原样回）。`crates/supervisor` 零 diff。
Validation: `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` -> exit 0 零警告；
`cargo test -p coflux-worker` -> exit 0；`git diff --stat d952471..HEAD -- crates/supervisor` -> 空。

### Milestone 3: 中心操作层

prepared 服务的无 client 入口 + `initiator: server` 标记 + 安装确认/restore 后自动 Execute + 超时/取消
唤醒完成原语；完成原语（operationId / taskId）；能力门禁；操作层方法：create/rename/remove workspace、
create/stop/remove terminal、read（经 daemon 降级到 checkpoint）、input、wait。WS 分支行为零变化。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: MCP tools

八个写/等 tools 挂上，`read_terminal` 升级并带来源字段；tool 描述写清人类优先、上限、wait 上限、
「需升级」错误的含义。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 5: 黑盒验收 + 文档

新测试文件（端口从 **8869** 起，独占）：正向闭环——`create_workspace`（worktree 真在磁盘上、web 广播
`workspaceCreated`）→ `create_terminal` 跑一条会留下输出且活得够久的命令 → `read_terminal` 读到输出
（来源 log）→ `send_terminal_input` 写入生效 → `wait_terminal` 拿到退出码 → `remove_terminal` →
`remove_workspace`（worktree 从磁盘消失、广播 `workspaceRemoved`）；`stop_terminal` 结束一条长命令；
`rename_workspace`。负向——用户 attach 期间 `send_terminal_input` 被拒且文案含「用户正在接管」；
删 running 终端被拒；删主工作区被拒；超每工作区终端上限被拒；旧 worker（`rawDaemon` 登记的假设备）
上任何写 tool 返回「需要升级」且**不等待**（耗时远小于 wait 上限）；跨账号 id 被拒；`wait_terminal`
超时返回状态而非错误；server 重启后（`restartServer`）中心发起的已安装 prepared 操作仍能完成
（restore 续上）。文档：`docs/architecture.md` 加「中心发起的 prepared 执行」一节；`plans/README.md`。
Validation: `node --import tsx --test tests/src/<新文件>.test.mjs` -> exit 0（acceptance）。

## Landmines

- **sessiond 账本 canonical 含 `shell`**（`crates/supervisor/src/sessions.rs:261-265`、`:1725-1745`）：
  包装脚本路径若每次不同，Execute 重发/重放会撞 `operation_collision`；路径必须由 operation_id 派生，
  且 `ops.rs` 的 `cleanup_stale_files`（`:159-175`，按年龄清理）不能在 prepared 未过期前删掉它。
- **worker 的 Execute 必须幂等**：中心 `restore`（server 重启 / daemon 重连）会重发安装与 Execute；
  已执行的 operation 再次 Execute 只能重发上次 report 或忽略（worker 有 `operation_reports` 表，
  `device.rs:2340` 附近），绝不能二次 `git worktree add` / 二次建会话。
- **`handle_client_frame` 从 `channels` 表取 principal**（`device.rs:1760-1770`）：中心触发的执行不走
  这个入口取身份，但必须复用它之后的分派（`authorize_prepared` → sessiond 路由或 `dispatch_worker_request`），
  别复制一份分派逻辑。
- **prepared 服务的 completion token / generation 语义**（`prepared-operation.service.ts:95-100`、
  `:457-545`）：无 client 入口要沿用同一套 admission（device 父行锁、target resume、并发上限
  `MAX_ACTIVE_PREPARED_PER_DAEMON`、conflict），不要绕过 `store.transaction` 的顺序。
- **`handleDeviceOperationReport` 里 applied/failed/ignored 三态**（`hub.ts:1345-1440`）：完成原语只在
  applied/failed 唤醒；ignored（重复 report）不唤醒也不清理。session.create 的 task guard 取消时也要
  唤醒（以「任务已删除」错误）。
- **旧 worker 对未知 `ServerToDaemon` 消息静默丢弃**（`crates/worker/src/main.rs:1395-1410`）且对
  `preparedDeviceOperation` 安装照常回 ok：门禁必须在 prepare **之前**判定，否则会留下一条永远不会
  被触发的 installed 记录占并发额度直到 TTL。
- **每工作区活跃终端上限含用户手开的**（`config.ts:200`，`hub.ts:1095-1107` 的计数逻辑）。
- **Claude Code 单请求 60 秒**：wait 上限 ≤ 50 秒；create_workspace / create_terminal 的完成等待也要
  有上限（建议 30 秒量级），到期返回「已提交、稍后用 list_* 查」而不是挂着。
- **测试的 worker 版本是 `builtin`**：门禁若误用版本号，本机黑盒全会被挡。
- **`send_terminal_input` 的超时语义**（`device.rs` `AGENT_IO_TIMEOUT` 5s，「结果未知」时换 identity）：
  超时不要自动重发，把「结果未知，先 read 再决定」的文案回给 agent（同 088 SKILL 纪律）。
- **删除 running 终端**：web 的 `taskRemove` 不关会话（UI 保证只删已退出的），MCP 侧必须自己拒。
- proto 改动后 Swift 产物变化，CI 会跑 swift test；`apps/mobile` 冻结只需构建过。
- 黑盒各 `*.test.mjs` 顶部 `const PORT` 独占端口，090 已用到 8868。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`、`proto/coflux/v1/device.proto` + 三侧生成产物
- `crates/worker/src/**`（device、agent_ctl、ops、main 及所需新模块）
- `apps/server/src/**`（hub、prepared-operation.service、prepared-operation-convergence.service、store、
  mcp/*、interface/mcp/*、config）
- `tests/src/`（新用例；`oauth-harness.mjs` / `device-harness.mjs` 仅在需要通用辅助时最小改动）
- `docs/architecture.md`、`plans/README.md`

Out of scope:
- `crates/supervisor/**` —— 硬约束零改动
- sessiond 的 holder / input_seq / attach **语义** —— 硬约束零改动
- `packages/cli/**`、SKILL.md、`COFLUX_*` 环境变量 —— plan 092
- `apps/web`、`apps/ios`、`apps/mobile`、`packages/client`、`packages/swift-client` 源码 —— 本片无 UI
  改动（生成产物除外）；若构建因生成类型变化而破，做最小修复并在报告里说明
- 项目导入/删除/重命名、设备操作、fs/exec/diff RPC、notify/progress 走 MCP —— 非目标
- OAuth / 认证面 —— 090 已定，不动

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查（生成类型不破） | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| mobile 构建 | `pnpm -C apps/mobile build` | exit 0 |
| proto 再生成 | `cd proto && buf generate` | 产物只含预期变化 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0，零警告 |
| supervisor 零改动 | `git diff --stat d952471..HEAD -- crates/supervisor` | 空输出 |
| client 包单测 | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| 本片黑盒 (acceptance) | `node --import tsx --test tests/src/<新文件>.test.mjs` | exit 0 |
| 090 黑盒回归 (acceptance) | `node --import tsx --test tests/src/mcp-oauth.test.mjs tests/src/mcp-isolation.test.mjs` | exit 0 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | 全过 |

黑盒需要本机 Postgres（`pnpm dev:pg`）与已构建的 daemon 二进制；全套大面积超时先查 Docker 是否半死。

## Done criteria

- [ ] All listed commands pass.
- [ ] 经 MCP 走完「建工作区 → 开终端跑命令 → 读输出 → 输入 → 等退出 → 删终端 → 删工作区」闭环，磁盘与 web 广播都对得上。
- [ ] 用户 attach 期间 `send_terminal_input` 被拒且文案可读；从未把人类 holder 踢下线。
- [ ] 旧 worker（不宣告能力）上的写 tool 立即返回「需要升级」，不等待。
- [ ] server 重启后中心发起的已安装 prepared 操作仍能完成。
- [ ] `crates/supervisor/` 零改动；holder / input_seq / attach 语义零改动；WS 分支行为零变化（既有黑盒全过）。
- [ ] 新黑盒用例做过负向验证（抽掉对应逻辑后确实失败）。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- worker 侧无法在不改 holder / attach / input_seq 语义、不改 supervisor 的前提下执行中心触发的 prepared 操作——STOP 报告。
- 包装脚本路径无法做到按 operation_id 确定且重放不撞 `operation_collision`——STOP。
- prepared 服务无法在不改变浏览器分支行为的前提下增加无 client 入口——STOP。
- `ServerToDaemon` 38 / `DaemonToServer` 34 / `DaemonAuth` 5 / `DeviceSessionCreate` 9 已被占用。
- 某条 Decisions 引用的事实已不成立。
- 任一验证命令在一次合理修复后仍连续失败两次。

## Maintenance notes

- 本片让中心第一次成为 prepared 操作的**发起方与触发方**。以后新增「中心自己要驱动 daemon 做事」的
  需求，先走这条路（prepare + Execute + 收敛），不要再开直发消息；直发只留给无落库副作用的动作
  （sessionClose、读/写请求）。
- 能力门禁的能力名是协议契约的一部分：新增控制消息时同步加能力名，并在 SKILL/文档里写清「需升级」的含义。
- 090 的 checkpoint 读法退为降级路径（设备离线时），不要删。
- 092 会给 `SessionCreate`/`DeviceSessionCreate` 再加 workspace_id/project_id 与 IPC env；本片的 `command`
  字段与它相邻，字段号别撞（092 取 10 起）。
