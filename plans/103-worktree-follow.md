# Plan 103: coflux 跟随 agent 进入 worktree——EnterWorktree / ExitWorktree / resume / WorktreeRemove 时终端归属搬到对应工作区（未知 worktree 先登记），PTY 不动，web 面板不重挂

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 26c5d3d..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/client.proto crates/worker/src apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts packages/cli/cofluxd.mjs packages/client/src/store.ts apps/web/src/components/workbench integrations/claude-plugin packages/cli/skills tests/src`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: `plans/102-agent-cwd-workspace.md`（分支 `dev/20260911-agent-cwd-workspace`；本 plan 的分支从其顶端 `26c5d3d` 切出，合回 main 的顺序必须是 102 → 103；102 若在别的会话里继续返修，本分支要 rebase 到它的新顶端）
- Category: feature
- Execution: subagent opus（出发检查 2026-09-11：写完即执行、不审 plan；STOP/BLOCK 仍停；push / PR / 合并 / 发版不在授权内）
- Planned at: `26c5d3d`, 2026-09-11

## Requirement

### 问题

Claude Code 的 `EnterWorktree` 会把**活着的会话**切进一个 git worktree（默认自建在
`<repo>/.claude/worktrees/<name>`，分支 `worktree-<name>`；传 `path` 则进入已有 worktree），
`ExitWorktree` 切回；`--resume`/`--continue` 一个曾进入 worktree 的会话时，Claude Code 在启动时直接把它
放回那个 worktree，**不经过工具调用**；会话退出时 Claude Code 自己清理干净的 worktree（有改动则问用户）。

跑在 coflux 项目终端里的 agent 走这条路之后，coflux 的世界是错的：终端在侧栏仍挂在原工作区 A 名下，
turn 状态、diff 统计、「在哪个分支」全指向 A；Claude 自建的 worktree 在侧栏根本不存在；今天的插件 guard
还把 `git worktree add` 拦下并把 agent 引到 MCP `create_workspace`（过中心、要 OAuth），随后 `EnterWorktree`
到 `~/.coflux/worktrees/<uuid>`（在 `.claude/worktrees/` 之外）又弹一次用户确认。dev 插件的 write-plan 因此
在 coflux 里走「宿主托管」分支，要么用绝对路径硬撑，要么开新终端把任务交出去——**任务被中断**。

plan 102 已经解决了「本地命令沉默错位」：`/agent` 请求带 cwd，daemon 把请求的**目标**改向 cwd 所在的
已注册工作区，`cofluxd workspace` 报「我在哪」，UserPromptSubmit 打 `<coflux-session-moved>` 块。但 102 明确
不动**归属**（task 记录的 `workspace_id`），不登记未知 worktree，不动 web。本 plan 在 102 之上补齐另一半。

### 产品结论（消费者 = 跑在 coflux 项目工作区终端里的 Claude Code；次要消费者 = 在 web/手机侧栏看终端的用户）

**形态**：coflux 跟着 agent 走。进入 worktree 后，它成为同一项目下的子工作区（路径已有记录则复用），
这个终端挂到它下面；终端、PTY、会话、turn 状态都不断。不拦截、不弹确认、不开新终端。

**流程**：

- `EnterWorktree` 成功（PostToolUse）→ 终端归属切到目标工作区；不存在就先登记（命名沿用 `create_workspace`
  的规则）再搬。
- `ExitWorktree`（PostToolUse）→ 终端回到原工作区；子工作区保留。
- 会话启动（SessionStart：startup / resume / clear / compact）时 cwd 已在本项目另一个 worktree 里 → 同样搬；
  cwd 就是当前归属工作区时是幂等无操作，正常启动零副作用。
- Claude Code 清理 worktree（WorktreeRemove）→ 该工作区里**所有**终端回到项目主工作区（`is_main`），
  工作区记录从侧栏消失。
- 一律静默不动、会话照常的情形：daemon 不在 / 不通；目标不是本项目的 worktree（别的仓库、非 git 目录）；
  终端本来开在目录工作区（无 project）；daemon 旧到不认识新命令。
- Bash guard：`git worktree add` 不再拦；`remove|move` 照拦。
- 归属搬动后 agent 拿到更新的坐标（workspace id 变，task / session / project id 不变）；压缩后重注入的
  `<coflux-session>` 块也报当前归属。
- 纯 `cd`（不经 EnterWorktree）**不搬归属**——那是 102 的「目标改向」语义，两者叠加成一个模型：
  纯 cd → 本地命令跟随 cwd、归属不动；显式进入/离开 worktree、resume、worktree 被删 → 归属真的搬。

**UI（web 侧栏与工作台）**：终端卡片从原工作区消失、出现在新工作区下，必要时新工作区卡片出现（带分支名
与 diff 统计）；用户正看着的终端被搬走时，工作台选中态跟过去、它仍是活动 tab；**面板不重建**——同一个
xterm 实例、选区、滚动位置全部保住，零闪动。

**范围外**：Codex（无 EnterWorktree）；subagent `isolation: worktree` 的临时 worktree；纯 `cd` 搬归属；
轮询 `git worktree list` 认领手工建的 worktree（095 的「方案三」，仍另立项）；手工 `git worktree remove`
留下的孤儿记录；跨项目 / 跨设备搬终端；web 里手动搬终端的 UI；macOS 原生客户端（`apps/macos` 正被
Electron `apps/desktop` 替代）；市场发版与各机 daemon 更新。

### 做完之后为真

1. 在 coflux 项目终端里 agent 调 `EnterWorktree`（自建或进入已有路径）后，几秒内侧栏出现（或复用）该
   worktree 对应的子工作区，本终端在其下，turn 状态连续；agent 在会话里 `cofluxd terminal list` /
   `cofluxd workspace` 看到自己归属新工作区（`owningWorkspaceId` 已变）。
2. `ExitWorktree` 后终端回原工作区；子工作区还在。
3. Claude 退出并清理 worktree 后，该工作区从侧栏消失，其下终端回到项目主工作区。
4. 在 worktree 里 `--resume` 的会话启动后归属即正确；正常启动（cwd = 归属）什么都不发生。
5. daemon 不可达、目标不是本项目 worktree、终端开在目录工作区：什么都不变，会话与工具调用照常。
6. `git worktree add` 在 coflux 项目会话里通过 guard；`git worktree remove|move` 仍被拒且理由不变。
7. web 工作台：被搬终端若是当前选中工作区的活动 tab，选中态跟随到新工作区且它仍是活动 tab；xterm 实例
   不重建；原工作区不会因为它离开而去 attach 别的 tab。
8. 归属搬动后，本轮工具结果旁 agent 即看到新坐标；此后每次 SessionStart（含 compaction）注入的
   `<coflux-session>` 都报当前归属；102 的 `<coflux-session-moved>` 只在「cwd 所在工作区 ≠ 当前归属」时出现
   （不再拿过期的 `COFLUX_WORKSPACE_ID` 环境变量当归属）。

**相邻的错误解法**：不是在 PostToolUse 里 deny / 改写 EnterWorktree；不是开一个新终端把任务交过去；不是
只改 102 的「有效工作区」文案让 agent 自己记住；不是让 web 面板卸了再挂、靠 2000 行快照回放糊过去；
不是 daemon 轮询 `git worktree list`；不是把 `.claude/worktrees/*` 里的目录按 102 的最长前缀算进主工作区
（对本 plan 的「定位」，worktree 根的**相等**判定优先于前缀）。

## Decisions & tradeoffs

- **触发与通道：一个新的独立插件脚本，挂 `PostToolUse`（matcher `EnterWorktree|ExitWorktree`）、
  `SessionStart`、`WorktreeRemove` 三处；不复用信使，不用 `CwdChanged`，不只靠 UserPromptSubmit。**
  Enter / Exit / SessionStart 把 hook 载荷里的 `cwd`（官方 hooks 文档：进入后即 worktree 根，退出后即原目录，
  SessionStart 时即会话当前目录）交给一条新的零凭证本地 `cofluxd` 子命令（名字执行者定）；`WorktreeRemove`
  交载荷的 `worktree_path`。子命令经既有 loopback `/agent` 网关发请求（pid/ppid 进程树认身份，不读 env）。
  PostToolUse 脚本可在 `hookSpecificOutput.additionalContext` 里回注新坐标；SessionStart 脚本 stdout 是纯文本
  进上下文。Rejected: ①塞进 `cofluxd hook claude` 信使——它「绝不写 stdout」是跨事件纪律；②`CwdChanged`——
  对纯 `cd` 也触发（产品定纯 cd 不搬），且文档只承诺 `watchPaths`/`systemMessage`，不承诺
  `additionalContext`；③只靠 102 的 UserPromptSubmit 块——那是下一条 prompt 才出现，且它不搬归属。
  Based on: `integrations/claude-plugin/hooks/hooks.json`（信使无 matcher；102 的 `session-moved.mjs` 只挂
  UserPromptSubmit）、`packages/cli/cofluxd.mjs:856-867`（信使纪律）、`integrations/claude-plugin/scripts/guard-git-worktree.mjs:6-10`
  （独立脚本的 stdout 契约：纯 JSON 或零字节）、Claude Code hooks 文档（PostToolUse 支持
  `additionalContext`；SessionStart 的 stdout 加入上下文；`WorktreeRemove` 载荷含 `worktree_path`）。

- **线上语义是「定位到路径」，不分 enter / exit：`AgentControlRequest` 新增一个 payload 变体（带绝对
  路径 + 分支 + daemon 已解析出的既有工作区 id 或空），响应带最终工作区 id 与是否新建；另一个变体
  「worktree 已删」带路径。** 同一条消息服务 Enter / Exit / SessionStart：路径落到哪个工作区、要不要新建，
  由 daemon 解析身份、中心核验并落库。中心对定位请求的处理：目标 = 现有归属 → 无操作；目标是已有
  工作区 → 搬；目标未注册且 daemon 声明它是同仓库 worktree → 先登记再搬；其余 → 可读的「不适用」，不建
  任何东西。旧 worker 恒不发；旧 server 收到未知变体按现有 `dispatchAgentControl` 的未知 payload 路径拒绝，
  CLI 把错误静默给 hook 脚本（脚本零字节退出）。
  Rejected: ①enter / exit 两种消息——ExitWorktree 的目标就是「原目录所在的工作区」，定位即可；②复用 102 的
  顶层 `workspace_id` 字段——那是「本次请求的目标」，不是「改归属」，语义不能混；③中心自己做路径比较——
  中心手里的路径是用户原始写法、且没有 git；身份解析留在 daemon，中心只核验同账号、同设备、同项目
  （与 102 的「daemon 提议、中心核验」信任模型一致）。
  Based on: `proto/coflux/v1/daemon.proto:92-140`（`AgentControlRequest` 注释与 102 加的 `workspace_id`）、
  `apps/server/src/hub.ts:1205-1239`（session→task→workspace 解析处，102 的核验就在这里）、
  `apps/server/src/daemon-capabilities.ts:10-12`（daemon 发起的请求不需要新 capability）。

- **未注册 worktree 的身份与项目边界由 daemon 判定：以 `git rev-parse --show-toplevel` 得到的 worktree 根
  做规范化后的相等比较找既有工作区；找不到时以 `git rev-parse --git-common-dir` 与该会话归属项目主工作区
  的仓库比对，相同才允许登记；分支取该 worktree 的当前分支。** 跨项目、非 git、目录工作区起步
  （`project_id` 为空）一律「不适用」。登记时上报的 path 是规范化后的 worktree 根。
  Rejected: 用 102 的 `workspace_match::workspace_for_cwd` 最长前缀做定位——Claude 自建的 worktree 在
  `<主工作区>/.claude/worktrees/<name>` 之下，前缀匹配会把它算进主工作区，永远登记不了；102 的前缀语义
  留给本地命令的目标改向，登记之后子工作区路径更长，102 自然会优先命中它。
  Based on: `crates/worker/src/workspace_match.rs:9-16`（前缀语义与「`.claude/worktrees/*` 算进主工作区」的
  注释）、`crates/worker/src/git.rs:169-207`（今天只有 import 用的 `validate_repo`，无 worktree 家族校验）、
  `crates/worker/src/main.rs:107-108`（工作区表 workspace_id → (path, default_branch)）。

- **归属搬动的写路径：`tasks.workspace_id` 与 `tasks.project_id` 在同一条 UPDATE 里改，按现有 CAS 风格加
  一个「搬」方法；搬完 daemon 按响应更新 SessionLedger 的 `workspace_id`。** 中心是归属的唯一真相，daemon
  的账本只从中心的响应学，仍然不按 cwd 猜。
  Rejected: 扩 `Store.updateTask` 的 patch 类型——它刻意只允许 status/sessionId/exitCode/title；分两条 UPDATE——
  FK `fk_tasks_workspace_project` 与启动 preflight `task_workspace_mismatch` 都会拦。
  Based on: `apps/server/src/store.ts:803`（patch 类型）、`apps/server/src/infra/database/schema-migrations.ts:690-696`
  （双列 FK）、`:572-582`（preflight）、`crates/worker/src/session_ledger.rs:4-14`（账本只学中心）、
  `crates/worker/src/agent_ctl.rs`（102 的 `resolve_scope`：`owning` 取自账本，`effective` 取自 cwd；账本不更新，
  搬完就会误判「挪窝」）。

- **广播次序：登记时 `WorkspaceCreated` 先于 `TaskUpdated`；worktree 被删时先 `TaskUpdated`（终端回
  `is_main` 工作区）再 `WorkspaceRemoved`；删记录时不执行 `git worktree remove`。** `TaskUpdated` 已带整条
  Task（含 `workspace_id`），各端按 task id upsert，所以不需要新的下行消息。
  Rejected: 复用 `WorkspaceRemove` 的 prepared 流程——它会让 daemon 去 `git worktree remove` 一个已不存在的目录。
  Based on: `proto/coflux/v1/client.proto:268`（`TaskUpdated { Task }`）、`packages/client/src/store.ts:536-551`
  （按 id upsert）、`:528-533` 与 `packages/swift-client/.../CofluxClient.swift:558-561`（`WorkspaceRemoved`
  时删该工作区的 tasks）、`apps/server/src/prepared-operation-convergence.service.ts:133-160`（按 daemon
  上报 path+branch 写工作区行的既有逻辑，可复用）。

- **坐标：PostToolUse 脚本回注 `additionalContext`；`session-context.sh` 改为先向 daemon 定位并用响应里的
  归属 id 打块，daemon 不通则回退 env；102 的 `session-moved.mjs` 改为拿 `cofluxd workspace` 输出的
  `owningWorkspaceId` 与 `workspaceId` 比，不再拿 `$COFLUX_WORKSPACE_ID` 当归属。** `COFLUX_WORKSPACE_ID`
  环境变量从此只表示「终端开在哪」（初始归属），搬动后过期；任何需要归属的地方问 daemon。这有意推翻
  096「块绝不调 daemon」与 102「归属 = `COFLUX_WORKSPACE_ID`」两条：resume 触发本来就要这次本地调用。
  Rejected: 往 `CLAUDE_ENV_FILE` 写新 id——只有 Bash 看得到，hook 与模型上下文不一致；接受过期——
  `session-moved.mjs` 会在搬完后每条 prompt 误报「挪窝」。
  Based on: `integrations/claude-plugin/scripts/session-context.sh:16-29`、
  `integrations/claude-plugin/scripts/session-moved.mjs`（`main()` 以 env 为 `owning`）、
  `packages/cli/cofluxd.mjs`（102 的 `cmdWorkspace` 输出 `owningWorkspaceId`）、`crates/supervisor/src/sessions.rs:824-829`
  （env 在 spawn 时一次写死，无法改活着的 PTY）。

- **guard 只拦 `remove|move`；SKILL、README、`<coflux-session>` 与挪窝块的文案同步；插件版本严格递增
  （102 已提到 0.9.0，本 plan 提到 0.10.0）。** 「Never run `git worktree add` yourself」改为「进入 worktree
  coflux 会跟随；删除仍走 `remove_workspace` 或 Claude Code 自己的退出清理」。插件目录零汉字；SKILL 唯一源
  `packages/cli/skills/coflux/SKILL.md`，`scripts/sync-claude-plugin.mjs` 同步，CI `--check`。
  Rejected: 整个 guard 拆掉——`remove` 被 agent 直接跑会留下孤儿工作区记录（watcher 不会删）。
  Based on: `integrations/claude-plugin/scripts/guard-git-worktree.mjs:20`（`GUARDED` 正则）、
  `integrations/claude-plugin/README.md`（Maintenance：任何改动 bump version）、`plans/102-agent-cwd-workspace.md`
  （0.9.0）。

- **web：xterm 面板提升到 Workbench 层、按 task id 挂成兄弟节点；工作区容器只留头部 / tabs / 分支按钮 /
  ChangesView 并决定可见性；attach 状态机随面板按 task id 提升到共享模块；不用 `createPortal`。**
  可见性 = 该 task 是其工作区的活动 tab 且该工作区被选中。留在 per-workspace 的状态：`activeTaskId`、`view`、
  `pendingBranch`、`pendingTab`/`pendingCreateRef`、`checkpointTitles`。随面板走的状态：`controllersRef`、
  `sessionReadyRef`、`attachedKeysRef`、`attachTimersRef`、`attachSequenceRef`、`launchingTaskIdsRef`、
  `activationRequestsRef`、`forcedClaimsRef`、097 的回放台账、`controlStates`、rAF fit/attach effect。
  `WorkspaceTerminalHandle` 与 `use-global-shortcuts` 的「只有可见工作区响应」契约重新落位（谁拥有
  `createTerminal` / `closeActiveTab` / `selectTabByIndex` / `selectRelativeTab` 由执行者定，行为不变）。
  选中规则：`workbench-state.ts` 加纯函数（有单测）——被搬 task 是当前选中工作区的活动 tab 时，选中跟随并让它
  保持活动 tab；task 离开某工作区**不得**触发该工作区对其它 tab 的 attach。共享模块放 `apps/web` 还是
  `packages/client` 由执行者定。
  Rejected: ①面板留在 per-workspace 容器、靠重挂 + 快照回放——用户明确要求零重挂；②`createPortal` 换挂载点——
  换容器会重插 DOM，xterm 的 `open(host)` 与 WebGL 上下文都会断。
  Based on: `apps/web/src/components/workbench/workbench.tsx:339`（只挂载访问过 / 选中的工作区容器）、
  `:433-447`（容器并排挂载仅隐藏）、`workspace-terminal.tsx:96-101`（tab = 按 workspaceId 过滤）、`:145-162`
  （attach 状态机全在容器里）、`:456-521`（task 消失时的清理与 `resolveActiveTaskId` 回退）、`:243-262`
  （`performActivation` → `beginAttach` 抢持有权）、`:795-800`（面板按 taskId 建立稳定身份的注释）、
  `workbench-state.ts:39`（选中态只有 workspace/device）、`:105-112`（回退到 `taskIds[0]`）、
  `terminal-pane.tsx:424-439`（consumer 先注册再 attach）。

- **Codex 零影响，靠构造保证。** Codex 执行同一份 hooks.json 但没有 EnterWorktree，PostToolUse matcher 永不
  命中；SessionStart 脚本在 Codex 里跑到「cwd = 归属」即零字节。新 hook 条目会让 Codex 用户多一次信任确认，接受。

- （decided while planning）**与 102 的分工固定为「归属 vs 目标」两层**：本 plan 只在四个显式事件上改归属；
  102 的 cwd 目标改向、`cofluxd workspace`、挪窝块全部保留，只把它们的「归属」来源从 env 改为账本
  （见坐标决策）。搬完之后 有效 == 归属，102 的逻辑自然归于无操作。

- （decided while planning）新工作区的名称、`cofluxd` 子命令名与线上字段名由执行者定；黑盒里「同仓库的
  未注册 worktree」由测试自己在临时仓库里用 git 建（测试进程不受插件 guard 约束）。

## Direction

数据流：hook 脚本（cwd）→ `cofluxd <定位子命令>`（loopback，pid 认身份）→ worker 解析 worktree 根 / 既有
工作区 / 同仓库校验 → `AgentControlRequest` 定位变体 → 中心核验 → （登记）→ 搬 task → 广播
`WorkspaceCreated`→`TaskUpdated` → 响应回 worker → 账本更新 → CLI 打印 → 脚本回注坐标。
WorktreeRemove：脚本（worktree_path）→ 子命令 → worker → 中心：搬回主工作区 → 删记录 → 广播。
web：`TaskUpdated` 的 `workspaceId` 变化只改面板归属与选中，不动 xterm。

依赖：M1 是契约；M2 与 M3 依赖 M1、彼此独立可并行；M4 依赖 M2（子命令名与输出）；**M5 独立于其它一切，
可从一开始并行**；M6 依赖 M2 + M3 + M4。

### Milestone 1: proto 契约与生成产物

`AgentControlRequest` 有定位与「worktree 已删」两个 payload 变体，响应能带回工作区 id 与是否新建；注释写明
「daemon 解析身份、中心核验落库、归属唯一真相在中心」。三处生成产物与 proto 一致并随代码提交。
Validation: `cd proto && buf lint && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` -> 提交后为空；`cargo build -p coflux-protocol` -> exit 0。

### Milestone 2: daemon 与 CLI

worker 有 worktree 根解析（toplevel 相等比较）、同仓库校验（git-common-dir 比对）、分支读取，有单测
（既有工作区命中、`.claude/worktrees/<name>` 登记、别的仓库拒绝、非 git 拒绝、目录工作区起步拒绝、
符号链接规范化）；定位与「已删」两个本地动作经中心往返；账本按响应更新 `workspace_id`；102 的
`resolve_scope` 在搬后得到 有效 == 归属；`cofluxd` 新子命令输出稳定（建议一行 JSON），daemon 旧到不认识
动作时 CLI 报可读错误、非零退出。
Validation: `cargo test -p coflux-worker` -> exit 0；`RUSTFLAGS=-D warnings cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` -> exit 0；`node --check packages/cli/cofluxd.mjs` -> exit 0。

### Milestone 3: 中心

`dispatchAgentControl` 处理两个新变体：核验同账号同设备同项目；按 daemon 上报的既有 id 或（path, branch）
找 / 登记工作区；单条 UPDATE 搬 task（双列）；按决策的次序广播；「已删」把该工作区全部 task 搬回
`is_main` 工作区后删记录；不适用时返回可读错误且零副作用。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: 插件与 SKILL

新脚本与三条 hooks.json 条目；`session-context.sh` 先定位后打块、失败回退 env；`session-moved.mjs` 以账本
归属比对；guard 只拦 `remove|move`（既有 guard 测试里 `add` 的用例改为「放行」）；SKILL 唯一源改写并同步；
README；插件 0.10.0；插件测试（假 `cofluxd` 上 PATH 的夹具，沿用 098/102 的 async 夹具与 PATH 隔离）：
Enter → 回注坐标；Exit → 回注坐标；同工作区 → 零字节；cofluxd 缺失 / 失败 / 旧 daemon → 零字节退出 0；
stdin 非 JSON → 零字节；WorktreeRemove → 调用「已删」子命令；脚本用**载荷里的 `cwd`** 调 cofluxd。
Validation: `node --import tsx --test tests/src/claude-plugin-*.test.mjs` -> exit 0；
`node scripts/sync-claude-plugin.mjs --check` -> exit 0；`git grep -P '[\p{Han}]' -- integrations/claude-plugin` -> 无输出；
`node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` -> exit 0。

### Milestone 5: web 工作台

面板提升、attach 状态机提升、选中跟随、离开不 attach 兄弟 tab；全局快捷键行为不变；`workbench-state.test.ts`
覆盖「活动 tab 被搬 → 选中跟随」「非活动 tab 被搬 → 选中不动」「task 被删 → 原回退」三类。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0；`pnpm test:web` -> exit 0。

### Milestone 6: 黑盒（acceptance）

新黑盒文件（占唯一端口）在临时仓库主工作区 A 的 PTY 里驱动：①在 A 的仓库用 git 建一个 worktree W（未注册）
→ 定位到 W → 收到 `WorkspaceCreated`（path = W 的规范化根）再 `TaskUpdated`（同一 task，workspaceId 变）；
PTY 里 `cofluxd workspace` 的 `owningWorkspaceId` = 新 id；②定位回 A → `TaskUpdated` 回 A，工作区仍在；
③定位到已注册的子工作区 B → 不新建；④定位到另一个临时仓库的目录 / 非 git 目录 → 错误可读、无广播；
⑤「已删」W → 先 `TaskUpdated`（回 A）后 `WorkspaceRemoved`；⑥旧格式请求（无新字段）行为不变。
Validation (acceptance): `cd tests && node --import tsx --test src/<新文件>.test.mjs src/agent-control.test.mjs` -> exit 0（需本机 PG 5432）。

## Landmines

- **改 proto 必须一起提交三份生成树**（`packages/protocol/src/gen`、`crates/protocol/src/gen`、
  `packages/swift-client/Sources/CofluxProtocol/Generated`），CI 对 diff 零容忍；oneof 加变体 `buf breaking` 可过。
- `apps/server/src/hub.ts:1262-1300` terminalNew 里 task.workspaceId、SessionCreate 的 cwd、活跃终端上限、project
  检查四处引用同一个目标工作区（102 改成 `target`）；搬归属之后这些逻辑以账本为准即正确，别再加一层。
- `crates/worker/src/agent_ctl.rs` 102 的 `WorkspaceScope { owning, effective }`：`owning` 来自账本。账本若不随
  响应更新，搬完后 `moved()` 恒真，`session-moved.mjs` 每条 prompt 误报。
- `crates/worker/src/main.rs:678-751` watcher 对消失的目录只报 0/0，不会删记录——「已删」必须靠 WorktreeRemove
  事件；手工 `git worktree remove` 的孤儿是后续项。新登记的工作区会随中心下发的 WorkspaceList 自动进入 watcher。
- Claude Code 在 agent 运行期间对自建 worktree 持 `git worktree lock`；此时 MCP `remove_workspace` 会被 git
  拒绝——把错误原样报出，绝不 `--force`。
- PTY 的 shell cwd 与 `COFLUX_*` env 在 spawn 时写死（`crates/supervisor/src/sessions.rs:824-829`、
  `apps/server/src/hub.ts:3166`）：搬后 shell 实际目录仍是旧的；人接管时在 claude TUI 里无感，claude 退出后会话
  终端留在旧目录——接受，SKILL/README 写明。
- 本地命令按进程树 + 账本解析（`packages/cli/cofluxd.mjs:960-975` 只发 pid/ppid/cwd），账本更新是它们搬后正确的前提。
- 工作区路径没有唯一约束（`uq_workspaces_directory_device` 只管目录工作区）：登记前必须先按 daemon 上报的既有
  id 或规范化 path 查重，否则同一 worktree 两次定位会出两条记录。
- 现行 guard 会拦含 `git worktree add` 字样的 Bash heredoc（写文档、测试、commit 正文都会中）——用 Write 工具写
  文件；guard 改完后 `add` 放行，`remove|move` 仍拦。
- `apps/web/src/components/workbench/workspace-terminal.tsx:141-144`、`:167-171`、`:187-189` 的 React-vs-Solid
  闭包陷阱注释：提升状态机时逐条保住那些注释描述的行为；`terminal-pane.tsx:424-439` consumer 必须先于 attach
  注册；`workspaceId` prop 在面板内经 `liveRef` 镜像（`:161-181`），搬后要跟着变（拖拽粘贴的 `sendFsWrite` 根用它）。
- `workbench.tsx:339` 只挂载访问过 / 选中的工作区容器：面板提升后容器的挂载与面板的挂载解耦，别让面板的
  生命周期再依赖容器是否挂载。
- 插件测试夹具（098 返修记录）：假 `cofluxd` 目录用 async 夹具、PATH 只含假目录，否则测试打到真 daemon、把文案
  写进用户工作区卡片。
- hook 命令在会话当前目录执行，脚本要用**载荷里的 `cwd`** 作为子进程 cwd 调 cofluxd，别信 `process.cwd()`。
- 黑盒里第二个已注册工作区必须经中心建（`tests/src/device-harness.mjs:564` `waitWorkspaceReady`）；未注册
  worktree 由测试自己在临时仓库里 git 建。本机 `pnpm -C tests test` 全量必有 agent-activity presence 三条假红
  （进程树被真实会话污染），与本 plan 无关。
- 本 plan 分支基于 102 的分支顶端；102 若返修产生新提交，本分支 rebase 后再继续；合回 main 顺序 102 → 103。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`（必要时 `client.proto`）与三处生成产物目录
- `crates/worker/src/`（`agent_ctl.rs`、`hook.rs`、`session_ledger.rs`、`git.rs`、`main.rs`，新模块可加）
- `packages/cli/cofluxd.mjs`
- `apps/server/src/hub.ts`、`store.ts`（需要时 `prepared-operation-convergence.service.ts` 的可复用部分）
- `packages/client/src/`（若共享 attach 模块或选中辅助放这里）
- `apps/web/src/components/workbench/`（`workbench.tsx`、`workbench-state.ts` 及其测试、`workspace-terminal.tsx`、
  `terminal-pane.tsx`、`use-global-shortcuts.ts`，新模块可加）
- `integrations/claude-plugin/`（`hooks/hooks.json`、`scripts/`、`skills/coflux/SKILL.md`、README、
  `.claude-plugin/plugin.json`）与 `packages/cli/skills/coflux/SKILL.md`
- `tests/src/`（新黑盒文件、`claude-plugin-*.test.mjs`、必要时 `agent-control.test.mjs`）
- `plans/README.md`

Out of scope:
- `apps/mobile`、`apps/ios`、`apps/macos` — 只按 workspaceID 过滤，天然跟随；macOS 原生正被替代
- `crates/supervisor` — env 注入语义不变（`COFLUX_WORKSPACE_ID` = 终端开在哪）
- `apps/server/src/mcp` — MCP tools 显式传 id，不变
- schema 迁移 — 现有列与 FK 已够用；不加新列
- 轮询认领、孤儿记录清理、跨项目 / 跨设备、手动搬终端 UI — 见范围外
- 市场发版、各机 daemon 更新、生产部署 — 用户步骤

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto 生成零 diff | `cd proto && buf lint && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | 无输出 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0 |
| Rust 构建零警告 | `RUSTFLAGS=-D warnings cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| web 单测 | `pnpm test:web` | exit 0 |
| client 状态机单测 | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| CLI 语法 | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| 插件测试 | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL 同步 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| 插件零汉字 | `git grep -P '[\p{Han}]' -- integrations/claude-plugin` | 无输出 |
| 黑盒定位 + agent 控制 (acceptance) | `cd tests && node --import tsx --test src/<新文件>.test.mjs src/agent-control.test.mjs` | exit 0（需本机 PG 5432） |
| 黑盒全量 (acceptance) | `pnpm -C tests test` | 除已知 agent-activity presence 三条外全绿 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 黑盒 ①–⑥ 六种情形按「做完之后为真」成立，广播次序符合决策。
- [ ] 插件：Enter/Exit 回注坐标；SessionStart 块报账本归属、daemon 不通回退 env；WorktreeRemove 调「已删」；
      `add` 放行、`remove|move` 仍拒；hooks.json 合法；0.10.0；零汉字；SKILL 唯一源与副本一致。
- [ ] web：活动 tab 被搬时选中跟随且同一 xterm 实例存活（不重建）；离开不 attach 兄弟 tab；全局快捷键行为不变。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf breaking` 判定为 breaking。
- 102 的分支顶端已不是 `26c5d3d` 且本分支 rebase 冲突无法机械解决——停下报告，由用户定合并策略。
- 面板提升后无法在不重建 xterm 的前提下满足「只有可见工作区响应快捷键」——停下报告，不要退回重挂方案。

## Maintenance notes

- **部署顺序**：先 server（api.coflux.dev）后各机 `cofluxd update && cofluxd restart`；旧 daemon 不发新变体，
  行为即今天；新 daemon + 旧 server 时定位被拒、hook 脚本静默，行为也即今天。
- **插件发版**：0.10.0；push 后把 SHA 交给 plugins-builder 会话发市场；用户 `/plugin marketplace update` 后更新
  `coflux@plugins`；Codex 需重新信任三条新 hook 条目。若 102 的 0.9.0 未单独发过，直接发 0.10.0 即可。
- `COFLUX_WORKSPACE_ID` 的语义从此固定为「终端开在哪」；归属看账本（`cofluxd workspace` 的 `owningWorkspaceId`）；
  「现在在哪」看 `workspaceId`。新代码不要再把 env 当归属用。
- 095 记录的「方案三」（daemon 轮询 `git worktree list` 认领 + 同步删除）与手工 `git worktree remove` 的孤儿清理
  仍待立项；本 plan 的「已删」路径可作为它的落库半边复用。
- dev 插件的 write-plan「宿主托管」分支在本 plan 上线后不再需要走 MCP `create_workspace`：`git worktree add`
  放行 + EnterWorktree 认领即可；那是 dev 插件侧的文档更新。
