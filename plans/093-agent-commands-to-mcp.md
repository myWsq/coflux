# Plan 093: agent 能力面收成 MCP 单轨——拆除 cofluxd 的 agent 命令与 074 控制通路，补 notify_user / report_progress

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 6a0ab63..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/common.proto buf.yaml crates/worker/src apps/server/src/hub.ts apps/server/src/mcp apps/server/src/daemon-capabilities.ts packages/cli tests/src README.md`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none（收敛 074/088 与 090-092 两轨，六个 plan 均已 DONE）
- Category: refactor（含两个新 MCP tool）
- Execution: subagent fable（出发检查 2026-09-05：写完 plan 立即执行、中途不再向用户确认；STOP/BLOCK 仍停；push/PR/merge 不在授权内）
- Planned at: `6a0ab63`, 2026-09-05
- **WITHDRAWN 2026-09-05**：子代理执行到 M3（`84c1153`/`9354a71`/`083c63c`）后用户定下「本地能闭环的 agent 操作不与中心有任何交集」原则，与本 plan「收成中心 MCP 单轨」直接矛盾，整体撤回，三个提交已 revert。可复用的部分：Decisions 里日志汇不变量、wait 上限、协议 reserved 先例，以及 `9354a71` 里的日志汇实现可作参考。

## Requirement

coflux 现在给 agent 两条能力轨道：plan 074/088 做进 `cofluxd` 的八条零凭证命令
（`terminal new|list|read|wait|send`、`notify`、`progress`、`ports`，daemon 按调用方 pid 反查
进程树认身份、只管自己所在工作区），以及 plan 090-092 的中心托管 MCP（OAuth、14 个 tools、
整个账号）。其中六条终端类命令与 MCP tool 一一重复，且两轨语义已经漂移（wait 默认 30 分钟
对 50 秒上限、send 回车默认 false 对 true、标题默认「agent 终端」对命令首行）。CLI 一轨还
带着自己的缺陷：`wait`/`send` 靠 `terminal.list` 找目标而 list 只回最近 50 条；worker
`/agent` 端点的 BadRequest 细节被统一吞成 `bad request`；两轨共用的命令日志 `tee` 落盘无上限。
更根本的是，教 agent 用这套命令的 SKILL 从未自动到达 Claude Code（npm 包只随包分发、要用户
手动 symlink，而插件里的是一份不含任何命令的旧 SKILL）。

092 之后每个 coflux PTY 都有 `COFLUX_*` 坐标变量，agent 用 MCP 也能定位自己，「零凭证只管本
工作区」这个 CLI 独有优势已经不成立。用户 2026-09-05 拍板：**收成 MCP 单轨**。

**做完之后为真**（消费者 = 跑在 coflux 终端里的 Claude Code / Codex，以及任何配了 coflux MCP
的宿主）：

1. `cofluxd` 退回纯 daemon 管理命令加 `hook` 信使。`cofluxd --help` 不再出现任何 agent 命令；
   `cofluxd terminal …` / `notify` / `progress` / `ports` 四个入口按既有 `MIGRATED` 表的方式
   打印「已并入 coflux MCP，对应 tool 是 …」并非零退出。`hook` 子命令与活动状态判定零变化。
2. MCP 有 16 个 tools：既有 14 个 + `notify_user` + `report_progress`。两者语义与今天的
   `cofluxd notify` / `cofluxd progress` **逐字相同**：notify = presence 转 `question` 并携带留言，
   下一个 hook 事件即清空；progress = 覆盖式单字段、跨 hook 事件存活、随 presence 一起消失。
   web 侧栏与 iOS 卡片看到的效果与现在一致——**本 plan 不改任何 UI**。
3. 两个新 tool 以 `terminalId` 寻址（agent 自己的就是 `$COFLUX_TASK_ID`）。以下情形全部是可读
   错误、绝不静默成功：终端不存在或不属于当前账号；终端未在运行或还没有会话；设备离线；设备
   daemon 太旧（既有「需要升级」文案）；**该终端里没有 agent presence**（没扫到 claude/codex）。
4. `wait_terminal` 默认仍 30 秒，上限从 50 秒放宽到 **600 秒**；到期仍回 `timedOut=true` 让 agent
   再调。描述里写明它受宿主单请求超时约束（手动 `claude mcp add` 的宿主仍是 60 秒）。
5. 命令终端的落盘日志**有界、保留尾部、永不让命令收到 SIGPIPE**；`read_terminal` 的
   `source=log` 对跑了很久的 dev server 依然返回最新尾部，命令自己的退出码依然原样上报。
6. worker 的 `/agent` loopback 路径、`AgentControlRequest` 那条 daemon→中心的控制通路、server 侧
   对应处理器整条拆除；`/hook` 原样保留；`hook.rs` 顶部的安全边界论证改回「伪造上报最多翻转
   展示状态」这一事实。
7. SKILL 改成单轨：只教 `COFLUX_*` 变量与 16 个 tools；「在不在 coflux」只看环境变量；没配 MCP
   时把接入命令交给用户；变量为空时告诉用户该机器 `cofluxd update && cofluxd restart`。
8. `crates/supervisor` 零改动——用户不需要 `cofluxd restart`，worker 随 tag 热升级即可。

**相邻的错误解法**（不是这个）：

- **不是**把 CLI 命令留作 MCP 的别名或降级通道。命令入口只剩迁移提示，不再有任何功能。
- **不是**在中心叠加 notify/progress 状态。「下一个 hook 事件即清空」只有 daemon 知道何时发生，
  中心做不到（见 Decisions 第 2 条）。
- **不是** daemon 侧 MCP，也不是新 CLI。
- **不是**删 proto 消息类型。`buf breaking` 用 FILE 类别，删消息会挂 CI（见 Decisions 第 6 条）。
- **不是**用 `head -c` 封顶或定期截断日志——前者超限时命令收到 SIGPIPE 直接死，后者要么留头
  不留尾、要么留下稀疏文件（见 Decisions 第 9 条）。
- **不是**改 presence 语义、给 notify/progress 落库或做历史流水。
- **不是**改 supervisor。

## Decisions & tradeoffs

- **074 通路全链路拆除，不只删 CLI**：删 `cofluxd.mjs` 的八条命令；删 worker `hook.rs` 的
  `/agent` 路径与 `agent_ctl.rs` 里 074 那一半（`AgentAction`/`consume_agent_requests`/`handle`/
  `ask_server`/`agent_pending`），**保留** 091 在用的 `handle_server_request` 与 `remember_log`；
  删 `hub.ts` 的 `handleAgentControl`/`dispatchAgentControl` 与只为它服务的 `MAX_AGENT_TERMINAL_LIST`；
  删 `main.rs` 的 `agent_pending` 表，**保留** `agent_logs`。Rejected: 只删 CLI——留下一套无人
  调用的通路和一段已成事实错误的安全论证。
  Based on: `crates/worker/src/hook.rs:151`（`/agent` 路径判定）、`crates/worker/src/agent_ctl.rs:48`
  与 `:484`（091 仍用的两个入口）、`apps/server/src/hub.ts:1186`/`:1199`/`:108`、
  `crates/worker/src/main.rs:97-100`。

- **notify/progress 走 `ServerAgentRequest` 新增 payload，语义留在 worker 的 observed 里一字不动**：
  中心把 tool 调用转成一条中心→daemon 请求，worker 收到后调既有的 `apply_notify`/`apply_progress`
  并立即触发一次 presence 上报，与今天 CLI 路径的处理点相同。**新增一个能力名做门禁**（名字
  执行者定，必须是新名字），两个 tool 在 daemon 缺该能力时立即回既有的「需要升级」文案。
  Rejected: ①中心自己叠加 message/progress——`apply_hook_state` 在每个 hook 事件时清 message，
  而 hook 事件只到 daemon，中心无从得知，语义做不对；②复用 `terminal_io` 能力名——旧 daemon
  会回「未知的中心请求动作」而不是「需要升级」，违反 091 立下的门禁约定。
  Based on: `crates/worker/src/observed.rs:92-113`（三个 apply 函数与清空规则）、
  `proto/coflux/v1/daemon.proto:258`（`ServerAgentRequest` 的 oneof 只加分支不占顶层字段号）、
  `apps/server/src/daemon-capabilities.ts:1-8`（「新增控制消息时同步加名字」）。

- **目标终端没有 agent presence 时可读拒绝，绝不 200**：presence 报表只给扫到 claude/codex 进程
  的会话建条目，其余会话的标注在下一轮扫描就被剪掉——静默接受等于静默丢。worker 判定用最近
  一次已提交的 agents 报表还是现场探测一次，执行者定；不变量是「下一轮会被剪掉的调用必须被拒」。
  Based on: `crates/worker/src/agents.rs:52`（`detect_session_agents` 的 `filter_map`）、
  `crates/worker/src/observed.rs` 的 `merge_annotations`（按本轮 present 集合 retain 三张表）。

- **寻址与归属沿用 `send_terminal_input` 的规则**：tool 收 `terminalId`，中心查 task 校验账号、
  要求 RUNNING 且有 `sessionId`，再按 daemon 在线 + 能力门禁下发；账号内任何 agent 都能标注
  账号内任何有 presence 的终端（B2 信任模型：仅本人自有机器）。
  Based on: `apps/server/src/hub.ts:3801-3815`（`sendTerminalInputForAccount` 的校验顺序）、
  `docs/OPEN_QUESTIONS.md` B2。

- **tool 名 `notify_user` / `report_progress`，留言上限 200 字符超限即拒** (decided while planning)：
  CLI 路径是静默截断到 200，MCP 有 schema 可以在入口拒绝并说明上限，不做静默截断。
  Based on: `crates/worker/src/agent_ctl.rs` 的 `MAX_NOTIFY_CHARS`。

- **协议按仓库先例：envelope 字段 reserved 号与名，消息定义保留并注明废弃**：`DaemonToServer`
  的 32 `agent_control_request` 与 `ServerToDaemon` 的 35 `agent_control_result` 进 reserved；
  `AgentControlRequest`/`AgentControlResult`/`AgentTerminal*`/`AgentPortsList*` 消息定义留下，
  注释标明「plan 093 起无发送方」。Rejected: 删消息——`buf breaking` 是 FILE 类别（含
  MESSAGE_NO_DELETE），CI 必红；`ExecResult`/`FsListed` 至今留在 common.proto 就是同一原因。
  Based on: `buf.yaml:8-9`、`proto/coflux/v1/daemon.proto:202-203`（reserved 先例）、
  `proto/coflux/v1/daemon.proto:229`/`:454`、`proto/coflux/v1/common.proto:130`/`:139`。

- **老命令入口进 `MIGRATED` 表**：`terminal`/`notify`/`progress`/`ports` 四个 key，文案指出对应
  的 MCP tool 名与「用 `$COFLUX_MCP_URL` 接入」。Rejected: 直接报「未知命令」——旧 SKILL 或
  旧记忆驱动的 agent 拿不到去路。
  Based on: `packages/cli/cofluxd.mjs:1106`（`MIGRATED`）、`:1136`（`handlers`）。

- **`wait_terminal` 默认 30 秒不变、上限 600 秒**：这是穿过两层反代的长持 HTTP 请求，越长越脆，
  而到期重调是零成本；600 秒足够覆盖一次测试/构建。Rejected: 与原 CLI 一致的 30 分钟——原 CLI
  是本机 loopback 轮询，不是长持请求，不可类比。Claude Code 的单请求计时是
  max(60s, 服务器 `timeout`, `MCP_TIMEOUT`)，插件 `.mcp.json` 能设每服务器 `timeout`（配套任务，
  见 Maintenance notes）；tool 描述里写明「受宿主单请求超时约束」。
  Based on: `apps/server/src/hub.ts:126-127`、`apps/server/src/mcp/tools.ts:59-60`；
  Claude Code 文档 https://code.claude.com/docs/en/mcp.md（Timeouts for tool calls）。

- **命令日志汇的不变量：有界、保尾、永不断管道、退出码照旧**：只改 `write_command_script_named`
  这一处（两条建终端路径共用）；`write_operation_command_script` 的脚本路径派生规则不能动
  （sessiond 账本 canonical 请求含 shell，重放时路径变了会判 operation_collision）；命令退出码
  仍由脚本原样透传（agent 判成败全靠它）。机制执行者定——worker 二进制自带一个日志汇子命令
  （`std::env::current_exe()` 可得路径）是不引入外部依赖的路；保留容量执行者定，但**不得小于**
  `read_terminal` 的读窗（256 KB），否则读窗永远填不满。074 专用的 `write_command_script`
  （非 operation 命名）随 074 路径一起删。Rejected: `head -c`（超限即 SIGPIPE 杀命令）、
  周期 truncate（tee 非 append 打开，截断后继续写成稀疏文件且尾部夹 NUL）、只留头部（对 dev
  server 毫无用处）。
  Based on: `crates/worker/src/ops.rs:373`（脚本模板：`| tee` + `PIPESTATUS`）、`:337`（074 专用
  命名）、`crates/worker/src/device.rs:2044-2047`（路径派生与 operation_collision 注释）、
  `crates/worker/src/agent_ctl.rs:44`（`MAX_SERVER_READ_BYTES = 256 KB`）、`crates/worker/src/ops.rs:16`/`:159`
  （7 天清理只清 mtime 陈旧文件，活着的日志永远不清）。

- **supervisor 零改动**：本 plan 所有 worker 侧改动都在 worker 进程内完成，不改 IPC、不改
  `sessions.rs`。Rejected: 任何 supervisor 改动——它不走热升级，全网 daemon 都要用户手动重启。
  Based on: plan 074 同名决策；`crates/supervisor/` 不在 in-scope。

- **SKILL 单轨，源文件位置不变**：`packages/cli/skills/coflux/SKILL.md` 仍是唯一源（npm 随包分发
  给 Codex 用户 symlink，Claude Code 插件在配套任务里换成同一份）。内容只教变量与 16 个 tools；
  「在不在 coflux」只看 `COFLUX_WORKSPACE_ID`，不再有「跑一条本地命令探测」的分支。
  Based on: `packages/cli/README.md:48-51`（symlink 安装说明）；plugins-builder 仓库
  `plugins/coflux/skills/coflux/SKILL.md` 是不含命令的旧版（配套任务替换）。

- **测试从 CLI 套件迁到 MCP 套件**：`tests/src/agent-control.test.mjs` 与 `agent-terminal-io.test.mjs`
  里全部用例都是驱动 CLI 的，随 CLI 删除；其中 notify「经中心广播、携带留言」、progress「跨 hook
  事件存活、被下一条覆盖」两组断言原样迁成 MCP 用例，另加「无 presence 被拒」「旧 daemon 回
  需要升级」「wait_terminal 真等超过 60 秒不被中心掐断」「日志超容量后 read_terminal 仍读到最新
  尾行且命令退出码正确」。放进 `mcp-write-tools.test.mjs` 还是新文件执行者定。
  Based on: `tests/src/agent-control.test.mjs:84-194`、`tests/src/agent-terminal-io.test.mjs:88-176`、
  `tests/src/mcp-write-tools.test.mjs:101-113`（`enrollFakeDaemon(name, capabilities)` 造旧 worker）。

## Direction

数据流（`notify_user` 为例，`report_progress` 同构）：

```
agent ──MCP tool(terminalId, message)──> 中心
                                          ├─ task → 账号校验 → RUNNING 且有 sessionId
                                          ├─ daemon 在线 + 新能力名门禁（缺则「需要升级」）
                                          └──ServerAgentRequest{notify}──> worker
                                                                            ├─ session 是否有 agent presence（无则拒）
                                                                            ├─ observed.apply_notify → 立即 report_agents
                                                                            └──ServerAgentResult──> 中心 → tool 应答
web/iOS 经既有 SessionAgents 广播看到 question + 留言（零 UI 改动）
```

### Milestone 1: 协议面与能力名就位

`daemon.proto`：两个 envelope 字段 reserved（号+名），`ServerAgentRequest`/`ServerAgentResult`
各加 notify 与 progress 分支；`common.proto` 的 `message`/`progress` 字段注释不再指向
`cofluxd notify/progress`；能力名常量在 worker 与 server 两侧同名。Rust/TS 生成产物同步。
Validation: `buf lint` 与 `buf breaking`（CI 同款基线）无新增违规，生成产物零 diff；
`cargo test -p coflux-protocol` -> exit 0；`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 2: worker 侧

`/agent` 路径与 074 那一半拆除，`/hook` 行为不变；`handle_server_request` 新增 notify/progress
分支（含 presence 门）；日志汇按不变量落地并接进 `write_command_script_named`；`hook.rs` 顶部
安全边界注释重写；`device.rs` 里「要沟通用 cofluxd notify」的拒绝文案改指 `notify_user`。
Validation: `cargo build -p coflux-supervisor -p coflux-worker` -> exit 0 且零警告；
`cargo test -p coflux-worker` -> exit 0；`git diff --stat 6a0ab63..HEAD -- crates/supervisor` -> 空。

### Milestone 3: server 侧

删 074 处理器；操作层加 notify/progress 两个方法（归属校验、能力门禁、经 `requestDaemonAgent`
下发）；`tools.ts` 注册 `notify_user`/`report_progress`；`wait_terminal` 上限 600 秒且描述同步。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: CLI、SKILL、文档

八条命令与帮助文案删除，四个入口进 `MIGRATED`；SKILL 改写为单轨；根 `README.md`、
`packages/cli/README.md` 同步。
Validation: `node packages/cli/cofluxd.mjs --help` -> exit 0 且输出不含 `terminal`/`notify`/
`progress`/`ports`；`node packages/cli/cofluxd.mjs terminal list` -> 非零退出且输出含 MCP tool 名。

### Milestone 5: 黑盒迁移与验收

CLI 用例删除、MCP 用例补齐（见 Decisions 最后一条），新增用例做负向验证（抽掉 presence 门 /
抽掉能力门禁 → 对应用例变红）。
Validation: `pnpm -C tests test`（acceptance）-> 除既有 `cli-doctor` 基线失败 ×2 外全过。

## Landmines

- `crates/worker/src/ops.rs:373` `write_command_script_named` 被 074 的 `write_command_script`
  与 091 的 `write_operation_command_script` 共用；后者的文件名由 `operation_id` 确定性派生
  （`device.rs:2044-2047` 解释了为什么不能变）。改日志汇只动模板，不动命名。
- `crates/worker/src/hook.rs:40` `LocalEndpoints` 两个发送端只删 `agent_tx`；`/hook` 仍靠
  `agents::session_of_pid` 做 pid 反查，`agents.rs` 不要顺手清理。
- `crates/worker/src/agents.rs:16` `AGENT_NAMES = ["claude","codex"]`，解释器规则看 `argv[1]` 的
  basename。日志汇进程会出现在会话进程树里，**不要**让它的可执行名或首参数长得像这两个词。
- `crates/worker/src/observed.rs` `merge_annotations` 以本轮扫描的 present 集合 retain 三张表：
  presence 门若只在中心判「task RUNNING」就会漏掉「shell 活着但 agent 已退出」的情况。
- `apps/server/src/hub.ts:131` `AGENT_REQUEST_TIMEOUT_MS = 10s` 是中心等 daemon 回执的上限，
  notify/progress 在 daemon 本地闭环，够用；不要为它们另开等待原语。
- `apps/server/src/mcp/tools.ts:435` `wait_terminal` 的上限同时写在常量、zod schema 上限和描述
  文案三处，SKILL 的「有界等待」段落是第四处，一起改。
- `crates/worker/src/device.rs:1572` 拒绝文案含 `cofluxd notify`；`proto/coflux/v1/common.proto:114-121`
  注释含 `cofluxd notify/progress`。`crates/protocol/src/gen/` 与 `packages/protocol` 的生成产物
  只能重新生成，不能手改。
- `tests/src/agent-control.test.mjs:178` 与 `agent-terminal-io.test.mjs:212` 用 `cofluxd hook claude`
  在真实 PTY 里打 hook 事件——这个信使保留，新 MCP 用例验证「notify 被下一个 hook 事件清空 /
  progress 跨 hook 事件存活」时照用。
- `wait_terminal` 超过 60 秒的长持请求：Node 的 `requestTimeout` 默认 5 分钟只管收请求体，
  handler 阶段不受它管，但**必须用真实 HTTP 用例证明**，不要凭文档相信。生产链路（owo-jp-gw
  回源）是否放行 600 秒持连，部署后由用户验证（见 Maintenance notes）。
- worker 热升级后 `agent_logs` 表丢失，`read_terminal` 退回 snapshot/checkpoint——既有行为，
  本 plan 不修。
- `packages/cli/cofluxd.mjs` 的 `parseArgs` options 里 `title/cmd/lines/timeout/text/enter` 只为
  agent 命令服务，一起删；`hook` 子命令「绝不写 stdout」的约束（`cmdHook` 注释）保持。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`、`proto/coflux/v1/common.proto` 及两侧生成产物（`crates/protocol/src/gen/`、`packages/protocol/`）
- `crates/worker/src/`（`hook.rs`、`agent_ctl.rs`、`main.rs`、`ops.rs`、`device.rs`、`observed.rs`；新增日志汇模块/子命令文件）
- `apps/server/src/hub.ts`、`apps/server/src/daemon-capabilities.ts`、`apps/server/src/mcp/tools.ts`
- `packages/cli/cofluxd.mjs`、`packages/cli/README.md`、`packages/cli/skills/coflux/SKILL.md`
- `README.md`（第 51 行附近的两轨说明）
- `tests/src/agent-control.test.mjs`、`tests/src/agent-terminal-io.test.mjs`、`tests/src/mcp-write-tools.test.mjs`（或新文件）
- `plans/README.md`

Out of scope:
- `crates/supervisor/` — 零改动硬约束
- `apps/web/`、`apps/ios/`、`apps/mobile/` — 不改 UI，presence 广播形状不变
- `apps/server/src/oauth.ts` 与 `/mcp` 端点接线 — 090 已定，不动
- `crates/worker/src/agents.rs` 的探测规则 — `/hook` 与 presence 仍依赖
- plugins-builder 仓库（插件 `.mcp.json`、`timeout`、SKILL 替换）— 配套任务，见 Maintenance notes
- notify/progress 落库、历史、APNs 推送

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 协议 lint | `buf lint` | exit 0 |
| 协议兼容 | `buf breaking --against <CI 同款基线>` | exit 0，无新增违规 |
| 生成产物一致 | 按 CI「生成产物一致性」步骤重新生成后 `git status --porcelain` | 空 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| supervisor 零改动 | `git diff --stat 6a0ab63..HEAD -- crates/supervisor` | 空 |
| Typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| CLI 帮助 | `node packages/cli/cofluxd.mjs --help` | exit 0，不含 agent 命令 |
| CLI 迁移提示 | `node packages/cli/cofluxd.mjs terminal list` | 非零退出，输出含 MCP tool 名 |
| 黑盒 (acceptance) | `pnpm -C tests test` | 除既有 `cli-doctor` ×2 外全过 |

## Done criteria

- [ ] All listed commands pass.
- [ ] `cofluxd` 只剩 daemon 管理命令与 `hook`；四个老入口给出指向 MCP tool 的迁移提示。
- [ ] `notify_user` / `report_progress` 经中心到 daemon 生效，web 广播里出现与 CLI 时代同形的 `message` / `progress`；notify 被下一个 hook 事件清空，progress 跨 hook 事件存活并被下一条覆盖。
- [ ] 无 presence 的终端、旧 daemon、离线设备、非本账号终端四种情形均为可读错误。
- [ ] `wait_terminal` 上限 600 秒，黑盒里一次超过 60 秒的等待真实完成。
- [ ] 命令日志有界保尾：超容量后 `read_terminal` 仍返回最新尾行，命令退出码正确。
- [ ] worker `/agent` 路径、`AgentControlRequest` 发送方、server 074 处理器均不存在；`/hook` 用例照过。
- [ ] SKILL 只教变量与 16 个 tools，无任何 `cofluxd terminal/notify/progress/ports` 字样。
- [ ] Required tests exist and assert meaningful behavior（新用例做过负向验证）.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed（尤其 `crates/supervisor` 零 diff）.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- 实现中发现日志汇的不变量（有界、保尾、不断管道、退出码照旧）在不改 supervisor 的前提下做不到。
- `buf breaking` 对 reserved 方案仍报违规且无法在不删消息的前提下消除。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- **配套任务（plugins-builder 仓库，独立跟踪）**：coflux 插件加 `.mcp.json`，
  `"url": "${COFLUX_MCP_URL:-https://api.coflux.dev/mcp}"`（Claude Code 在进程启动时从 shell
  环境展开，coflux PTY 里就是本地/生产对应的地址）、每服务器 `timeout` ≥ 600000 ms；SKILL 换成
  本仓库 `packages/cli/skills/coflux/SKILL.md` 的新版；版本号递增并发版。Claude Code 文档确认：
  插件 MCP 的 OAuth 与手动 `claude mcp add` 相同、启用插件即连接、无需单独审批
  （https://code.claude.com/docs/en/plugins.md、https://code.claude.com/docs/en/mcp.md）。
  Codex 用户仍手动 `codex mcp add coflux --url "$COFLUX_MCP_URL"`。
- **生产生效节奏**：worker 随下一 tag 热升级；server 随部署；CLI 与 SKILL 随 npm `cofluxd` 发版。
  「旧 CLI + 新 worker」组合下老命令会从 `/agent` 路径判定拿到 `400 bad request`——可接受，
  因为旧 SKILL 从未到达 agent；「新 tool + 旧 worker」由能力门禁回「需要升级」。
- 部署后由用户在生产验证一次 `wait_terminal` 超过 60 秒的调用穿过 owo-jp-gw 回源不被掐断；
  若被掐，调的是反代超时或本 plan 的 600 秒上限，不是 tool 语义。
- 日志汇的保留容量是拍脑袋值；若用户反馈「跑了很久的终端读不到早期输出」，该考虑的是
  `read_terminal` 支持按偏移读，而不是无脑调大容量。
- 以后再给 agent 加能力，唯一入口是 MCP tool；`cofluxd` 不再承载任何 agent 能力，
  `hook.rs` 的安全边界论证以「纯展示」为准。
