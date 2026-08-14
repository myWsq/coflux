# Plan 074: AI 协同控制第一片——PTY 里的 agent 把工作外化成用户可见可接管的 coflux 实体

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7cbed03..HEAD -- proto crates/worker/src crates/supervisor/src/sessions.rs apps/server/src/hub.ts packages/cli/cofluxd.mjs packages/client/src/store.ts apps/web/src/components/workbench/sidebar.tsx tests/src`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `7cbed03`, 2026-08-15

## Requirement

跑在 coflux PTY 里的 claude/codex 目前对自己所处的 coflux 环境**完全无感也无能**：它想跑
个长任务只能用自己的 Bash 后台起进程，那个进程在 coflux 里不存在——用户在 web/手机侧栏
上看不见它、接管不了它、它卡住了也叫不动人。

**这次要建立的价值不是「给 AI 更多执行原语」**（Bash 已经能跑命令、能开 worktree、能 tail
日志，经 coflux 绕一圈的增量接近零）。coflux 唯一不可替代的资产是**人在回路**：AI 开的东西
是 web/手机上看得见的**真实终端**，用户能随时接管、能收到 AI 主动的求助、端口能一键预览。
本 plan 的全部设计都必须服务于这一条。

**做完之后为真**——在 coflux 终端里跑的 agent 能：

```
cofluxd terminal new --title "跑单测" --cmd "pnpm -C tests test"   → 用户侧栏立刻出现一个标题为
                                                                     「跑单测」的真实终端，可点进去接管
cofluxd terminal list                                              → 拿到自己 workspace 下所有终端的
                                                                     id/title/status/exit_code
cofluxd terminal read <task-id>                                    → 拿到该终端**去 ANSI 转义后的纯文本**当前内容
cofluxd notify "需要你定 X"                                        → 用户侧栏该工作区状态转「等待交互」，
                                                                     tooltip 里能看到这句话
cofluxd ports                                                      → 拿到本会话进程树监听端口的预览 URL
```

配套一份 SKILL.md，教 agent 何时该用这些命令（长任务开真实终端而不是后台跑、卡住时 notify
叫人、跑完用 list 看 exit_code）。

判断"相邻的错误解法"：

- **不是**让 AI 能往终端里打字。AI 只「开」和「读」，交互永远交给人接管（见 Decisions 第 1 条）。
- **不是**给 AI 发一个 client token 让它直连中心。那等于把全账号权限交给 AI，与「只管自己
  workspace」直接矛盾（见 Decisions 第 3 条）。
- **不是**做 MCP server。形态是 CLI 子命令 + SKILL.md（见 Decisions 第 8 条）。
- **不是**在 daemon 本地默默起进程。默默起 = 用户看不见 = 直接违背本 plan 的全部价值。

## Decisions & tradeoffs

- **AI 无 PTY 写权，只「开」和「读」**：AI 建终端时把命令一次定死，之后只能读 snapshot 和
  status，永不 attach、永不持 holder、永不发 `DevicePtyInput`。想再交互，用户接管。
  Rejected: ①AI 作为普通 client 抢 holder——AI 一 attach 就把正在看输出的用户踢下线
  （`DeviceSessionAttached` 的 holder_epoch 递增语义会向旧 holder 发 detached），UX 灾难；
  ②新增「旁路非独占输入」语义——直接冲掉 plan 042 的 per-client 连续 `input_seq` exactly-once
  串行契约，是所有选项里最贵的一条。
  Based on: `proto/coflux/v1/device.proto` 中 `DeviceSessionAttach`/`DevicePtyInput` 的 holder 与
  input_seq 契约注释。**本 plan 不得改动 sessiond 的 holder / input_seq / attach 任何语义。**

- **supervisor 零改动，命令靠 worker 侧临时脚本包装送进 PTY**：worker 生成一个临时脚本
  （复用 `fs.write` 已有的 daemon 临时目录能力），内容形如 `exec <shell> -lc '<命令>; exec <shell> -i'`，
  把脚本路径作为 `SessionCreate.shell` 下发。命令因此是 exec 的第一个进程——无「等 prompt 再写」
  的竞态、无输入回显问题、进程树探测照常工作。
  Rejected: ①给 `SessionCreate` 加 `args` 字段并改 supervisor——supervisor **不走热升级**，改它
  意味着全网 daemon 都要用户手动 `cofluxd update`，这是本 plan 里最贵的一次性成本，为一个功能
  首片付不值；②session 起来后由 worker 往 PTY 写一次初始输入——那是「写 PTY」，与第 1 条冲突，
  且有 shell 未就绪丢字符的竞态。
  Based on: `crates/supervisor/src/sessions.rs:336-338`——`shell` 为空取默认、非空则
  `CommandBuilder::new(&shell)`，**只吃一个可执行程序名、不接受 args**；
  `crates/worker/src/main.rs:1164-1165`——worker 收到 server→daemon 的 `SessionCreate` 后把 `shell`
  原样透传给 supervisor。
  **若实现中发现这条绕不过去，STOP 并报告，不要改 supervisor。**

- **AI 零凭证，身份由 worker 用调用方 pid 反查进程树确定**：CLI 把自己的 pid 报给 loopback
  端点，worker 遍历各存活 session 的进程树定位它属于哪个 session；**pid 不在任何存活 session
  的进程树内 = 拒绝**。这既是身份也是安全边界——只有 coflux 自己起的 PTY 里的进程能调这组
  能力，本机其它进程一律拒。`hook.rs` 现有的 `content-type: application/json` 门槛（挡浏览器
  跨源，预检必失败）必须保留。
  Rejected: 给 AI 发 token——存哪、怎么轮换、泄漏了怎么办，全是新问题，而 pid 反查一条都没有。
  Based on: `crates/worker/src/agents.rs` 的 `detect_in_tree` + `ports::process_tree(root_pid)`；
  `crates/worker/src/hook.rs:17-19` 的安全边界注释；`tests/src/agent-activity.test.mjs:168` 已有
  「树外 pid 被拒」的用例可作同构参考。

- **中心操作走 daemon 控制 WS 直发，不走 prepared operation**：server 收到 daemon 的请求后建
  Task，然后**经 daemon 控制 WS 直接下发 `SessionCreate`**（`ServerToDaemon` 既有 payload）。
  Rejected: 复用 browser 那套 prepared operation——它的最后一跳是「server 把 frame 交给 **client**，
  client 经 device channel 转投给 daemon」，而 AI 场景根本没有 browser client 可以转投；
  prepared operation 存在的理由是 browser 不可信，而 daemon 控制 WS 是**已认证的可信控制面**，
  多绕一圈只增加失败模式。
  Based on: `apps/server/src/hub.ts:1669-1713` `startOrAttachTask` 走的是
  `preparedFrame` + `prepareOperation` + `sendPrepared(client, ...)`；而
  `crates/worker/src/main.rs:1164` 证明 server→daemon 控制 WS 的 `SessionCreate` 路径**仍然活着**，
  worker 收到即转 supervisor 起 PTY。

- **只有 `terminal new` 和 `terminal list` 需要新的 server 往返，其余三条全在 daemon 本地闭环**：
  `terminal read` 用 worker 已有的本地 snapshot 能力；`ports` 用 worker 已有的端口探测；
  `notify` 复用 plan 073 的 presence 通道（见下条）。协议新增面因此被压到最小。
  Based on: `proto/coflux/v1/device.proto` 中 `DeviceSessionSnapshotRequest` 的注释明写「只读取得
  原子 snapshot，不注册 subscriber、不读取也不改变 holder……供 worker 生成中心 checkpoint 使用」；
  `crates/worker/src/ports.rs` 的进程树端口探测。

- **notify 复用 073 presence，不做新的通知通路**：`cofluxd notify "…"` → worker 把该 session 的
  hook 状态置为 `question` 并附上这句话 → 立即触发一次 `SessionAgents` 上报 → server 既有
  `acceptSessionAgents` 广播 → web 侧栏图标已经在渲染，只需把消息显示到 tooltip。
  `SessionAgentRef` 加一个 `message` 字段（下一个可用字段号 **5**）。
  Rejected: 新建一套 AI→用户消息实体（要落库、要已读状态、要三端 UI）——为首片付不起，且 073
  的四态图标已经是用户已经在看的位置。APNs 真推送是独立议题，不进本 plan。
  Based on: `proto/coflux/v1/common.proto:105-115` `SessionAgentRef` 已有 `state` 字段；
  `apps/server/src/hub.ts:479-506` `acceptSessionAgents` + 广播；`hub.ts:1244-1245` 订阅补发；
  `crates/worker/src/main.rs:225-230` `merge_hook_states` 是状态合并点。

- **workspace 归属由 server 从 task_id 反查，daemon 只上报 session_id**：daemon 侧不需要知道
  自己在哪个 workspace——它报「我是 session S」，server 查 `session → task → task.workspaceId`
  即可，且这一步天然完成了归属校验（该 session 必须属于该 daemon 名下的 task）。
  Rejected: worker 用 cwd 去 `WorkspaceList` 里匹配路径——多一份可能与中心不一致的推断。

- **形态是 CLI 子命令 + SKILL.md，不做 MCP**：复用 `packages/cli/cofluxd.mjs` 的
  `localGatewayPort()` 端口发现（含 `COFLUX_LOCAL_GATEWAY_PORT` env 覆盖，测试要用）。
  claude/codex 都能跑 shell，通吃。
  Rejected: daemon 暴露 MCP server——daemon 要实现一整套 JSON-RPC、用户要改 `~/.claude.json`、
  codex 侧支持度另评估，为「工具描述更结构化」这点收益换来显著变大的安装面。

- **每 workspace 活跃 AI 终端上限，落在 server 侧**（建议 8，放 config）：跑飞的 agent 能刷出
  几十个终端。B2 信任模型下这是 UX 问题不是安全问题，所以做成简单硬上限、超限返回明确错误
  即可，不做配额/回收/优先级。
  Based on: `docs/OPEN_QUESTIONS.md` B2「仅本人自有机器，无需路径白名单/沙箱/容器」。

- **ANSI 去转义在 CLI 侧做**（decided while planning）：worker 返回的 snapshot 保持原样不失真
  （它同时是 checkpoint 的数据来源，不能为了 AI 可读性去改），CLI 侧用正则剥掉转义序列后
  打到 stdout。Rejected: worker 侧转——多一条 Rust 侧的 VT 文本化逻辑，且污染了 snapshot 的单一语义。

- **CLI 不自动重试有副作用的请求**（decided while planning）：`terminal new` 超时就返回错误给
  AI，由 AI 自己决定要不要再来一次。Rejected: CLI 内建重试——daemon 控制 WS 断连重连期间的
  在飞请求会导致建出两个终端；而引入 operation_id 幂等是为一个低频命令付协议复杂度。

## Direction

数据流（`terminal new` 为例，其余同构或更短）：

```
agent 进程 ──POST /hook 式 loopback──> worker
                                        ├─ pid 反查进程树 → 定位 session_id（失败即拒）
                                        ├─ 写临时脚本（含 --cmd 的命令）
                                        └──daemon 控制 WS──> server
                                                              ├─ session_id → task → workspace（归属校验）
                                                              ├─ 上限检查
                                                              ├─ 建 Task（title = --title）+ 广播 taskUpdated
                                                              └──控制 WS──> SessionCreate{shell=脚本路径}
                                                                              → worker → supervisor 起 PTY
                                        <──结果回传──                        → SessionStarted 上报 → task RUNNING
agent 拿到 task_id                                                            → 用户侧栏出现可接管的终端
```

proto 字段编号（已核对现状，避免撞号）：`DaemonToServer` 下一个可用 **32**；
`ServerToDaemon` 下一个可用 **35**；`SessionAgentRef` 下一个可用 **5**。

### Milestone 1: 协议面就位

`proto/` 里新增 daemon→server 请求 / server→daemon 结果各一对（覆盖 terminal new 与 list），
`SessionAgentRef` 加 `message` 字段；Rust 与 TS 两侧生成产物同步且线格式一致。
Validation: `cargo test -p coflux-protocol` -> exit 0；`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；
`buf lint` 与 `buf breaking` 无新增违规（CI 同款命令），生成产物零 diff。

### Milestone 2: worker 侧控制端点

loopback 端点从「只翻转 UI 状态」扩成受 pid 身份约束的控制端点：pid 反查定位 session（树外
一律拒）、临时脚本生成、本地 snapshot 读取、本地 ports 读取、notify 置 `question` + message 并
立即触发一次 presence 上报。`hook.rs` 顶部的安全边界注释必须重写以反映新的权限面。
supervisor 目录下**零改动**。
Validation: `cargo build -p coflux-supervisor -p coflux-worker` -> exit 0 且零警告；
`git diff --stat <baseline>..HEAD -- crates/supervisor` -> 空。

### Milestone 3: server 侧编排

新增 handler：校验归属（session → task → workspace → daemon）、检查每 workspace 活跃 AI 终端
上限、建 Task 并广播、经控制 WS 下发 `SessionCreate`、把结果回传给发起 daemon；presence 的
`message` 字段透传进既有广播与订阅补发路径。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: CLI 子命令 + SKILL.md

`cofluxd terminal new|list|read`、`cofluxd notify`、`cofluxd ports` 五条，复用 `localGatewayPort()`；
输出走 **stdout**（供 AI 读），错误信息可读且明确区分「不在 coflux 终端里」「daemon 未连中心」
「超上限」。配套 SKILL.md 写清何时该用（长任务开真实终端而非后台跑、卡住 notify 叫人、
list 看 exit_code 判完成）。
Validation: `node packages/cli/cofluxd.mjs --help` -> exit 0 且新命令出现在帮助里。

### Milestone 5: 黑盒验收 + 侧栏 tooltip

`tests/src/` 新增用例（选一个未占用端口）：在真实 session 里执行 CLI → 断言中心确实建出
Task 并转 RUNNING、`list` 能读到、`read` 拿到纯文本、`notify` 让 presence 转 `question` 且带
message、**树外 pid 被拒**、**超上限被拒**。新用例必须做负向验证（抽掉 server handler 后确实失败）。
web 侧栏把 presence 的 message 显示进既有 tooltip。
Validation: `pnpm -C tests test` -> 除既有 `cofluxd doctor` 基线失败外全过；
`node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0。

## Landmines

- `crates/supervisor/src/sessions.rs:338` `CommandBuilder::new(&shell)` **没有 args**。看到
  `SessionCreate` 有 `shell` 字段就以为能塞 `pnpm test` 是错的——那会被当成一个可执行文件名去 exec。
- `crates/worker/src/main.rs:1164` 的 server→daemon `SessionCreate` 路径**仍然活着**。本地优先
  重构（plans 036-042）之后容易误以为起 session 只剩 prepared operation 一条路，从而多绕一大圈。
- `apps/server/src/hub.ts:1669` `startOrAttachTask` 的最后一跳是 `sendPrepared(client, ...)`——
  把 frame 交给 **browser client** 去转投。照抄它到 AI 场景会卡死在「没有 client」。
- `crates/worker/src/hook.rs:17-19` 的安全边界注释明写「伪造上报最多翻转 UI 活动状态（纯展示、
  不触发任何操作）」。扩权后这句话变成事实错误，**必须同步重写**，否则后来者会依据它做错误的
  安全判断。
- `packages/cli/cofluxd.mjs:679-680` 记着 `hook` 子命令「绝不写 stdout」（claude 会把 hook 的
  stdout 当决策 JSON 解析）。**新子命令必须写 stdout**——它们是给 AI 读的普通命令，不是 hook。
  不要照抄这条约束。
- `crates/worker/src/agents.rs:31` `AGENT_NAMES = ["claude", "codex"]` + 解释器规则会看 `argv[1]`
  的 basename。临时包装脚本**不要**起名为 `claude`/`codex`，否则会被误认成 agent 进程。
- `tests/src/agent-activity.test.mjs:136-137` 给出了黑盒测 CLI 的现成同构写法：在真实 session 里
  `device.input()` 执行 `COFLUX_LOCAL_GATEWAY_PORT=<port> node <COFLUXD> …`。harness 从不跑安装器，
  新用例也不要。
- 各 `*.test.mjs` 顶部 `const PORT` 独占端口，新用例必须挑未占用的。

## Scope

In scope:
- `proto/coflux/v1/{common,daemon}.proto` + 生成产物
- `crates/worker/src/{hook,main,agents,ports}.rs`（及为实现所需的 worker 内新模块）
- `apps/server/src/hub.ts`（及 config）
- `packages/cli/cofluxd.mjs`
- SKILL.md（随 CLI 包分发，具体落点由 executor 按仓库现状定）
- `packages/client` + `apps/web` 侧栏 tooltip 的 message 显示
- `tests/src/` 新用例

Out of scope:
- `crates/supervisor/**` —— 硬约束，零改动（理由见 Decisions 第 2 条）
- sessiond 的 holder / input_seq / attach 语义 —— 硬约束，零改动（Decisions 第 1 条）
- `cofluxd workspace new`（AI 开 worktree 跑并行分支）—— 会引出「子 agent 怎么起 / prompt 怎么传 /
  结果怎么收」一整套，独立 plan；也正好是 `docs/OPEN_QUESTIONS.md` B5 悬着那条
- MCP server —— Decisions 第 8 条已否决
- APNs 真推送 —— 独立议题
- `apps/mobile`、`apps/ios` —— 本片不加功能（mobile 已冻结；iOS 侧待 presence message 稳定后另议）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 黑盒集成 | `pnpm -C tests test` | 除既有 `cofluxd doctor` 基线失败外全过 |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| supervisor 零改动核实 | `git diff --stat <baseline>..HEAD -- crates/supervisor` | 空输出 |

web 侧视觉按本仓库惯例交用户人工验收，不做 Playwright/UI 走查。

## Done criteria

- [ ] All listed commands pass.
- [ ] 在真实 session 里跑 `cofluxd terminal new --title X --cmd Y`，中心建出 title=X 的 Task 并转 RUNNING，命令确实在该 PTY 里执行。
- [ ] `terminal list` 能读到自己 workspace 的终端及 status/exit_code；`terminal read` 输出是无 ANSI 转义的纯文本。
- [ ] `notify` 使该 session 的 presence 转 `question` 并携带消息，经中心广播到 client。
- [ ] 树外 pid 调用一律被拒；超过每 workspace 上限被拒且错误可读。
- [ ] `crates/supervisor/` 零改动；holder / input_seq / attach 语义零改动。
- [ ] 新黑盒用例做过负向验证（抽掉 server handler 后确实失败，其余用例照常通过）。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- worker 侧临时脚本包装被证明走不通（须改 supervisor 才能把命令送进 PTY）——STOP 报告，不要改 supervisor。
- `crates/worker/src/main.rs:1164` 的 server→daemon `SessionCreate` 路径已失效或语义变了。
- 实现需要触碰 holder / input_seq / attach 任一语义。
- 需要给 AI 发放任何形式的账号级凭证才能跑通。
- 任一验证命令在一次合理修复后仍连续失败两次。
- 需要改动 Out of scope 里的文件。

## Maintenance notes

- **生产生效必须发版**：worker 侧改动只随 tag 经热升级到达 daemon（同 072/073），本地黑盒全绿
  不等于生产可用。server/web 随部署生效，CLI 随 npm 发版生效，三者节奏不同，首次上线要注意
  「新 CLI + 旧 worker」的组合会拿到什么错误——确保它是可读的拒绝而不是静默失败。
- loopback 端点从此不再是「纯展示」。以后任何人再往这个端点加能力，都必须重新审视
  `hook.rs` 顶部的安全边界论证，而不是默认它还成立。
- 每 workspace 终端上限是个拍脑袋的数（8）。如果用户反馈 AI 经常撞上限，说明该考虑的是
  「AI 开的终端的自动回收策略」，而不是简单调大——那与 ROADMAP「退出任务的保留/GC 策略」
  是同一个问题。
- 第二片（`workspace new` + 子 agent 编排）会需要重新审视本 plan「AI 无 PTY 写权」的决定：
  给子 agent 喂 prompt 的正路是**创建时经命令行参数**（`claude -p "…"`），不是事后往 PTY 打字。
