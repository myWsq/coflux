# Plan 102: agent 本地命令跟随调用方 cwd 归属工作区——`/cd`、EnterWorktree 迁入同设备另一工作区后不再沉默错位

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8f73dc7..HEAD -- proto/coflux/v1/daemon.proto crates/worker/src packages/cli/cofluxd.mjs apps/server/src/hub.ts integrations/claude-plugin packages/cli/skills tests/src/agent-control.test.mjs tests/src/device-harness.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none（建立在 092 环境注入、094 本地账本、096 坐标块之上，三者均 DONE）
- Execution: subagent opus（出发检查 2026-09-11：写完即执行，不审 plan；STOP/BLOCK 仍停）
- Category: feature
- Planned at: `8f73dc7`, 2026-09-11

## Requirement

Claude Code（本机 2.1.267）有 `/cd <path>` 与 `EnterWorktree`（传 `path`）两条路能把**活着的会话**
（对话上下文不变、不重启）挪到另一个目录。coflux 的子工作区就是 `~/.coflux/worktrees/<workspace_id>`
下一个正规注册的 git worktree（`git worktree list` 可见），所以在主工作区 A 开的会话可以中途迁入子
工作区 B 继续干活。但 coflux 对 agent 本地命令的归属只认「调用方 pid → 所在 PTY 会话 → 账本里
SessionCreate 下发的 `workspace_id`」（plan 094），完全不看 cwd。于是迁入 B 之后：

- `cofluxd terminal new --cmd 'pnpm test'` 在 A 名下建 task、在 A 的根目录跑，**没有任何报错**——agent
  以为在测 B 的 worktree，实际测的是 A 的 checkout。这是沉默错位，比报错更坏。
- `cofluxd terminal list` 列的是 A 的终端；对 B 里（经 MCP `create_terminal` 开出来）的终端做
  `read/wait/send` 得到 404「终端不在本工作区」。
- `<coflux-session>` 坐标块与 `$COFLUX_WORKSPACE_ID` 仍是 A，agent 照抄 A 的 id 去调 MCP。

**做完之后为真**（消费者 = 跑在 coflux 终端里的 agent；次要消费者 = 看侧栏的用户，行为不变）：

1. 每条 `/agent` loopback 请求都带调用方的 cwd。daemon 用本地工作区表把 cwd 解析成**有效工作区**：
   本设备上路径包含该 cwd 的工作区（按路径分量做最长前缀，两边都规范化后比较）。cwd 不在任何已知工作区
   内 → 有效工作区 = 账本里的归属工作区（下称「归属工作区」，即 `COFLUX_WORKSPACE_ID`）。归属工作区为空
   （早于 daemon 升级的会话）→ 仍按 094 可读拒绝：cwd 只能**改向**一个已知归属，绝不**补上**缺失的归属。
2. 在 B 的 cwd 下：`terminal new` 在 B 名下建 task、在 B 的根目录跑，计入 B 的活跃终端上限；
   `terminal list` 列 B 的终端；对 B 的终端 `read/wait/send` 成功，对 A 的终端 404（反之亦然，与今天
   「只看本工作区」的边界对称）。`progress`、`notify`、`ports` 语义不变——它们挂在终端卡片/本会话进程树上，
   与工作区无关。
3. 中心只在有效工作区**与发起终端同账号、同设备**（仓库工作区还要求所属项目未在删除中）时接受它；
   否则请求失败、错误可读、不建任何东西。字段为空 = 今天的行为（发起 task 所在工作区），旧 daemon 照常用。
4. 新增只读本地命令 `cofluxd workspace`：打印调用方 cwd 对应的有效工作区（id 与路径）和归属工作区 id，
   让 agent 一眼看出自己有没有「挪窝」。coflux 终端之外调用 → 与其它本地命令同样的 403。
5. Claude 插件：每次 UserPromptSubmit，若 hook 载荷里 `cwd` 所在的工作区 ≠ `$COFLUX_WORKSPACE_ID`，
   在 stdout 打一个 `<coflux-session-moved>` 纯文本块（内容见 Decisions 5），告诉 agent 现在在哪个
   工作区、本地命令会落到哪、调 MCP 该传哪个 workspaceId、`COFLUX_TASK_ID`/`COFLUX_SESSION_ID` 不变。
   两者相同、不在 coflux 里、`cofluxd` 不存在或不通、stdin 不是合法 JSON → **零字节 stdout、退出 0**。
   挪窝期间每条 prompt 都重复打（无状态，compaction 后自愈）。
6. SKILL（唯一源 `packages/cli/skills/coflux/SKILL.md` + 同步副本）改写「先弄清自己在哪」一节：区分
   归属工作区与有效工作区；说明 `/cd`、EnterWorktree 迁入另一个 coflux 工作区后本地命令跟随 cwd；
   `cofluxd workspace` 的用法；刚挪窝、还没到下一条 prompt 就要调 MCP 时先跑 `cofluxd workspace` 拿 id。
   坐标块里那句「inside this workspace use the local commands… use MCP only to leave this workspace」改成
   以「你 cwd 所在的工作区」为准的措辞。
7. 插件版本 0.8.0 → 0.9.0。市场发版（push + 把 SHA 给 builder 会话）是用户的步骤，不在本 plan 内。

## Decisions & tradeoffs

- **有效工作区 = 调用方申报的 cwd 在 daemon 本地工作区表里的最长前缀命中；归属工作区仍只来自账本。**
  chosen：CLI 随每条 `/agent` 请求带 `process.cwd()`；daemon 拿 `WorkerState.workspaces`
  （workspace_id → (path, default_branch)，含 default_branch 为空的目录工作区）做按路径分量的最长前缀匹配，
  两边先 `canonicalize`（失败则退回字面比较）；命中结果只改**请求的目标**，不改会话归属。
  Rejected: ①用 cwd 给归属为空的旧会话「猜」一个归属——这正是 094 拒绝的「第二份可能与中心不一致的推断」，
  继续拒绝；②把终端卡片挪到 B 名下——PTY 外层 shell 还在 A 的目录，用户接管会落错地方；
  ③只改 SKILL 让 agent 挪窝后走 MCP `create_terminal`——违反「本地能闭环绝不经中心」，且 agent 忘了就
  还是沉默错位。
  Based on: `crates/worker/src/agent_ctl.rs:360-391`（归属判定 = 调用方与目标账本 `workspace_id` 相等）、
  `crates/worker/src/session_ledger.rs:4-7`、`crates/worker/src/main.rs:107-108`（工作区表）、
  `crates/worker/src/main.rs:1523-1528`（表由中心 WorkspaceList 下发）、`crates/worker/src/device.rs:3404`
  （`workspace_root` 已按 id 查表取路径）。

- **线上形态：`AgentControlRequest` 顶层加一个可选 `workspace_id`，不按 payload 各加一份。** 语义：
  「调用方 cwd 所在的工作区；空 = 发起 task 所在工作区」。作用于 `terminal_new` 与 `terminal_list`；
  `ports_list` 忽略它（端口是本会话进程树的）；`terminal_read` 早已本地化不经中心。中心在
  `dispatchAgentControl` 解析发起 task/workspace 的同一处应用覆盖：目标工作区存在、
  `accountId === daemon.accountId`、`daemonId === daemon.info.daemonId`，仓库工作区再做与 terminalNew
  对发起方相同的 project 活跃检查；任一不满足 → 可读错误，不建 task。
  Rejected: 按 payload 分别加字段——同一概念查两遍；让 daemon 报路径——中心按 id 索引工作区，daemon 手上
  就有 id。这条放宽了 proto 注释「daemon 不自报 workspace」：现在是 daemon **提议**、中心**核验**同账号同设备，
  与 MCP `create_terminal` 的信任模型一致（那里只查 accountId，这里必须多查 daemonId 因为终端要在本设备跑）。
  proto 注释同步改写；新增可选字段 `buf breaking` 通过。
  Based on: `proto/coflux/v1/daemon.proto:92-126`（注释与 `AgentControlRequest` 字段 1、2、10-13）、
  `apps/server/src/hub.ts:1201-1211`（发起 task/workspace 只在此解析一次）、`hub.ts:1240-1246`
  （project 活跃检查）、`hub.ts:1330-1345`（terminalList 按 `workspace.id` 列）、`hub.ts:3684-3695`
  （MCP create_terminal 的校验）。

- **兼容：字段为空 = 发起工作区，无版本协商。** 新 server + 旧 daemon = 今天的行为。旧 server + 新 daemon：
  字段被忽略、终端落回发起工作区（即今天的沉默错位）——接受，因为生产始终先部署 server 再逐机更新 daemon
  （见 Maintenance notes）。Rejected: 在回执里带 task 的 workspaceId 让 daemon 比对——多一套协议只为
  一个不会出现的部署顺序。

- **read/status/send 的本地判定：目标终端的账本 `workspace_id` 必须等于有效工作区（不是归属工作区）。**
  后果：在 B 的 cwd 下 A 的终端变 404，与今天的边界对称，agent `cd` 回去即可。
  Rejected: 「归属 ∪ 有效」并集——模糊了 094 错误文案描述的边界，还让 agent 在 B 里误敲进 A 的终端。
  Based on: `crates/worker/src/agent_ctl.rs:389`（等值判定）、`hook.rs:250-266`（`AgentBody` 现无 cwd）、
  `packages/cli/cofluxd.mjs:964-967`（所有本地动作经同一处发请求，cwd 加一次即全覆盖，含 `wait` 的轮询）。

- **坐标刷新走 UserPromptSubmit 的独立脚本，不走 CwdChanged，也不改写环境变量。** Claude Code 2.1.267 有
  `CwdChanged` hook（载荷 old_cwd/new_cwd，并设 `CLAUDE_ENV_FILE`），但其说明只承诺退出码语义，不承诺
  stdout 进模型上下文；UserPromptSubmit 的 stdout 进上下文是文档明写的，且载荷含 `cwd`（官方 hooks 文档，
  与仓库里 guard 脚本收到的 `cwd` 字段一致）。块内容（英文，插件目录零汉字）至少包含：有效工作区 id 与路径、
  归属工作区 id、「local cofluxd commands act on <effective>」、「pass <effective> as workspaceId to coflux
  MCP tools」、「COFLUX_TASK_ID / COFLUX_SESSION_ID unchanged」。
  Rejected: ①往 `CLAUDE_ENV_FILE` 写 `export COFLUX_WORKSPACE_ID=<B>`——只有 Bash 工具的命令看得到，hook、
  MCP 与模型上下文都会和它不一致，且 092 定义的 `COFLUX_WORKSPACE_ID` 语义就是「归属」；②让 SessionStart
  的坐标块也按 cwd 解析——096 的脚本是零依赖 sh、只读 env，保持；在别的目录 `--resume` 的情形由挪窝块在
  第一条 prompt 覆盖；③把块塞进 `cofluxd hook claude` 信使——信使「绝不写 stdout」是跨事件纪律
  （PreToolUse 的 stdout 会被当决策 JSON 解析）。接受的代价：块出现在**下一条 prompt**，不在挪窝的当轮；
  SKILL 因此要求 agent 挪窝后立刻要调 MCP 时先跑 `cofluxd workspace`。
  Based on: `integrations/claude-plugin/hooks/hooks.json`（UserPromptSubmit 现只挂信使）、
  `packages/cli/cofluxd.mjs:856-867`（信使纪律）、`integrations/claude-plugin/scripts/session-context.sh`
  （096 契约）、`integrations/claude-plugin/scripts/guard-git-worktree.mjs:6`（hook stdin 含 cwd）。

- **`cofluxd workspace` 是唯一新增的本地命令面（动作名 `workspace.current`），只读、daemon 本地闭环。**
  输出格式由执行者定，但必须同时含有效工作区 id、路径与归属工作区 id，且稳定到插件脚本能解析
  （建议一行 JSON：脚本是 node）；格式写进 SKILL。Rejected: 插件脚本自己 POST loopback 网关——端口发现与
  pid 契约都在 cofluxd.mjs 里，插件另行分发，不能复制一份。

- **对 Codex 与常态零影响，靠构造保证。** 挪窝脚本只在有效 ≠ 归属时输出。Codex 也执行 hooks.json，但没有
  `/cd`，cwd 不会挪，脚本恒零字节。插件目录零汉字（既定约定）。

- （decided while planning）块名 `<coflux-session-moved>`；命令名 `cofluxd workspace`；挪窝期间每条 prompt
  重复打块（无状态优于标记文件）。

## Direction

数据流：CLI 在每条 `/agent` 请求里带 `cwd` → daemon 解析有效工作区（一次/请求）→ 本地动作按有效工作区
判定；经中心的动作把有效工作区放进 `AgentControlRequest.workspace_id` → 中心核验后以它为目标建 task/列表。
插件在 UserPromptSubmit 调 `cofluxd workspace`，差异时打块。

依赖关系：M1 是契约，M2 与 M3 都依赖 M1、彼此独立可并行；M4 依赖 M2（命令名与输出格式）；M5 依赖 M2+M3。

### Milestone 1: proto 契约与生成产物

`AgentControlRequest` 有可选 `workspace_id`，注释改写为「daemon 提议、中心核验」；三处生成产物
（`packages/protocol/src/gen`、`crates/protocol/src/gen`、`packages/swift-client/Sources/CofluxProtocol/Generated`）
与 proto 一致并随代码提交。
Validation: `cd proto && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` -> 提交后为空；`cargo build -p coflux-protocol` -> exit 0。

### Milestone 2: daemon 与 CLI

`AgentBody`/`AgentRequest` 带 cwd；解析器有单测（嵌套路径、`/x/repo` 不命中 `/x/repo2`、符号链接规范化、
不在任何工作区 → None、目录工作区也参与）；read/status/send 按有效工作区判定；`workspace.current` 动作与
`cofluxd workspace` 子命令；TerminalNew/TerminalList 填 `workspace_id`；094 留下的「不按 cwd 猜」注释改写为
「归属不猜、目标可申报」。
Validation: `cargo test -p coflux-worker` -> exit 0；`node --check packages/cli/cofluxd.mjs` -> exit 0。

### Milestone 3: 中心

`dispatchAgentControl` 应用覆盖与校验；terminalNew 的 task.workspaceId、SessionCreate 的 cwd、活跃终端上限、
project 活跃检查全部以目标工作区为准；terminalList 列目标工作区。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: 插件与 SKILL

新脚本（UserPromptSubmit）、hooks.json 条目、SKILL 唯一源改写并同步、插件 0.9.0；新测试
`tests/src/claude-plugin-session-moved.test.mjs`（假 `cofluxd` 上 PATH：差异 → 块含两个 id；相同 → 零字节；
无 `COFLUX_WORKSPACE_ID` → 零字节；stdin 非 JSON → 零字节；cofluxd 缺失/失败 → 零字节；脚本用载荷 `cwd`
而非自己的 `process.cwd()` 调 cofluxd）。
Validation: `node --import tsx --test tests/src/claude-plugin-*.test.mjs` -> exit 0；
`node scripts/sync-claude-plugin.mjs --check` -> exit 0；`git grep -P '[\p{Han}]' -- integrations/claude-plugin` -> 无输出。

### Milestone 5: 黑盒（acceptance）

在 `tests/src/agent-control.test.mjs`（或新文件）里用同一设备上的两个工作区（第二个经中心 API 建、
`waitWorkspaceReady` 等 daemon 表同步）证明：在 A 的 PTY 里 `cd <B.path> && … terminal new --cmd pwd` 建出的
task 属 B、输出是 B 的路径；B 的 cwd 下 `terminal list` 只见 B；跨工作区 read/status/send 为 404；cwd 在
`/tmp` 之类 → 落 A；`cofluxd workspace` 输出正确；不带字段的请求仍落发起工作区（旧 daemon 兼容）。
Validation (acceptance): `cd tests && node --import tsx --test src/agent-control.test.mjs` -> exit 0。

## Landmines

- `crates/worker/src/session_ledger.rs:7` 与 `agent_ctl.rs:371` 的「不按 cwd 猜」注释若不改写，将来的读者会
  把本 plan 当回归改回去；改成「归属不猜；目标按申报的 cwd 改向」。
- 前缀必须按路径分量比：`/x/repo` 不能命中 `/x/repo2`。两边都 `canonicalize`：macOS 的 `/var` 是
  `/private/var`，`~/.coflux` 可能是符号链接；表里的路径是中心记录的用户原始写法，未必规范。
- 主工作区路径下有 Claude 自建的 `.claude/worktrees/*`（coflux 不认识）——最长前缀会把它们算进主工作区，
  这是正确行为，不要特判。
- `apps/server/src/hub.ts:1262-1300` terminalNew 里 task.workspaceId、SessionCreate 的 `cwd`、上限统计、
  project 检查四处都引用 `currentWorkspace`；漏改任何一处就是「task 挂在 B、命令跑在 A」的新错位。
- `packages/cli/cofluxd.mjs:866` 信使必须继续零 stdout；挪窝块放独立脚本。
- 插件测试夹具的坑（plan 098 返修记录）：假 `cofluxd` 目录要用 async 夹具、PATH 只含假目录，否则测试会打到
  真 daemon、把文案写进用户工作区卡片。
- hook 命令在会话当前目录执行，但脚本要用**载荷里的 `cwd`** 作为子进程的 `cwd` 去调 cofluxd，别信
  `process.cwd()`。
- 黑盒测试通过往 PTY 里敲 `COFLUX_LOCAL_GATEWAY_PORT=… node cofluxd …` 调本地命令
  （`tests/src/agent-control.test.mjs:63`）；第二个工作区必须经中心建（`tests/src/device-harness.mjs:564`
  `waitWorkspaceReady`），daemon 的表才知道它。
- 本机 `pnpm -C tests test` 全量必有 agent-activity presence 三条假红（进程树被真实会话污染），与本 plan
  无关，别追。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto` 与三处生成产物目录
- `crates/worker/src/hook.rs`、`agent_ctl.rs`、`session_ledger.rs`、`main.rs`（解析器可放新模块）
- `packages/cli/cofluxd.mjs`
- `apps/server/src/hub.ts`（需要 store 辅助查询时可动 `store.ts`）
- `integrations/claude-plugin/hooks/hooks.json`、`scripts/`（新脚本）、`skills/coflux/SKILL.md`、
  `.claude-plugin/plugin.json`
- `packages/cli/skills/coflux/SKILL.md`
- `tests/src/agent-control.test.mjs`（或新黑盒文件）、`tests/src/claude-plugin-session-moved.test.mjs`
- `plans/README.md`

Out of scope:
- `apps/web`、`apps/mobile`、`apps/macos` — 侧栏卡片仍挂在发起工作区，不加「agent 现在在哪」的角标
- `crates/supervisor` — 环境变量注入语义不变（`COFLUX_WORKSPACE_ID` = 归属）
- MCP tools（`apps/server/src/mcp`）— 它们本来就显式传 id
- `CwdChanged` hook、`CLAUDE_ENV_FILE` — 见 Decisions 5
- 市场发版、各机 daemon 更新 — 用户步骤

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto 生成零 diff | `cd proto && buf generate && git -C .. status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | 无输出 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Rust 构建零警告 | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| CLI 语法 | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| 插件测试 | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL 同步 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| 插件零汉字 | `git grep -P '[\p{Han}]' -- integrations/claude-plugin` | 无输出 |
| 黑盒 agent 控制 (acceptance) | `cd tests && node --import tsx --test src/agent-control.test.mjs src/agent-terminal-io.test.mjs` | exit 0（需本机 PG 5432） |
| 黑盒全量 (acceptance) | `pnpm -C tests test` | 除已知 agent-activity presence 三条外全绿 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 在 A 的 PTY 里 `cd` 进 B 后 `cofluxd terminal new --cmd pwd` 建出的 task 在侧栏挂在 B 名下且输出 B 的路径。
- [ ] B 的 cwd 下 `terminal list` 只列 B；跨工作区 `read/status/send` 为 404，文案仍是「终端不在本工作区或不存在」。
- [ ] cwd 在任何工作区之外时本地命令落回归属工作区；归属为空的旧会话仍被可读拒绝。
- [ ] 中心拒绝不属于同账号同设备的 `workspace_id`，错误可读，不建 task。
- [ ] `cofluxd workspace` 在 A/B/工作区之外三种 cwd 下输出正确；coflux 之外 403。
- [ ] 插件挪窝脚本五种情形（差异/相同/无 env/坏 stdin/无 cofluxd）符合契约；hooks.json 合法；插件 0.9.0。
- [ ] SKILL 唯一源与副本一致，且描述了归属/有效工作区、`/cd`/EnterWorktree、`cofluxd workspace`、挪窝块。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf breaking` 判定为 breaking（说明字段加法不对）。
- 发现 `WorkerState.workspaces` 在某条路径上拿不到主工作区或目录工作区的路径（解析器就没有输入）。

## Maintenance notes

- **部署顺序**：先 server（api.coflux.dev）后各机 `cofluxd update && cofluxd restart`；反过来会短暂回到
  今天的沉默错位（字段被旧 server 忽略）。
- **插件发版**：插件目录版本 0.9.0 已提；push 后把 SHA 交给 plugins-builder 会话发市场；用户
  `/plugin marketplace update` 后更新 `coflux@plugins`；Codex 需重新信任新 hook 条目。
- `COFLUX_WORKSPACE_ID` 的语义从此固定为「归属工作区（终端在哪开的）」；「现在在哪」看挪窝块或
  `cofluxd workspace`。任何新代码不要再把它当「当前工作区」用。
- 若将来 Claude Code 文档明确 `CwdChanged` 的 stdout/`additionalContext` 进上下文，可把挪窝块提前到挪窝当轮；
  届时保留 UserPromptSubmit 版本作 compaction 后的自愈。
- 侧栏给终端卡片加「agent 现在在 B」的角标是可能的后续（daemon 已能从 hook 载荷拿到 cwd），本 plan 不做。
