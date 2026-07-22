# Plan 024: 工作区 git diff 统计展示（+X −Y）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 723e4e0..HEAD -- proto/ crates/worker/ apps/server/src/ apps/web/src/ tests/src/`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `723e4e0`, 2026-07-23

## Requirement

产品定位是「Agent 指挥中心」：用户在多台设备的多个工作区里跑 claude/codex 任务，
需要扫一眼就知道每个工作区（worktree）的 agent 总共改了多少代码。第一步先做
行数统计：每个 workspace 展示 `+X −Y`（新增/删除行数）。

做完后成立的事实：
- daemon worker 周期计算每个 workspace 相对项目默认分支的累积 diff 行数
  （已提交 + 未提交 + untracked 新文件），变化才上报 server。
- server 落库（DB 只是镜像，真相源在设备侧，与 branch 同语义）并广播给所有
  client；client 刷新/重连后能拿到最后已知值，设备离线时亦然。
- web 在 sidebar 工作区行和终端顶栏 BranchMenu 旁各展示 `+X −Y` 小字；
  X=Y=0 时两处都不渲染（不显示 `+0 −0`）。

正确解 vs 相邻错误解的分界：统计基准是 **merge-base(default_branch, HEAD) 到
工作树** 的累积 diff——agent 自己 commit 之后数字**不归零**；只统计未提交脏改动
（`git diff HEAD`）的实现是错的。untracked 新文件行数计入 additions——纯
`git diff --shortstat` 不含 untracked 的实现是不完整的。

## Decisions & tradeoffs

- **diff 基准**：`git diff --shortstat <merge-base(default_branch, HEAD)>`
  （单 rev 参数 = base 对比工作树，一条命令同时涵盖已提交与未提交改动）。
  Rejected: `git diff --shortstat HEAD`（仅未提交）—— agent commit 后归零，
  不符合任务视角；用户已在 explore 阶段明确选择累积语义。
  主工作区正在 default_branch 上时 merge-base = HEAD，自然退化为未提交改动，无需特判。
  merge-base 解析失败（孤儿分支、default_branch 已删）时回退 `git diff --shortstat HEAD`。
  Based on: 用户 2026-07-22 grill 确认；`proto/coflux/v1/common.proto:27` 项目已有 `default_branch` 字段。

- **untracked 文件计入 additions**：`git ls-files --others --exclude-standard -z`
  拿列表后由 worker 直接读文件统计行数（无尾随换行的末行也算 1 行，对齐 git numstat
  语义）；内容含 NUL 字节视为二进制跳过（对齐 git 行为）；单文件 >1MB 跳过行数统计
  （防大产物文件拖慢轮询）。deletions 不涉及 untracked。
  Rejected: 不计 untracked —— agent 未 commit 的新建文件完全不可见，系统性低估；
  用户已明确选择计入。Rejected: 对每个 untracked 文件起 `git diff --no-index`
  子进程 —— N 个子进程无必要，Rust 读文件即可。
  Based on: 用户 2026-07-22 grill 确认。

- **worker 侧 default_branch 来源**：扩展 `WorkspaceRef`（server→daemon 的
  工作区清单）加 `default_branch` 字段，`pushWorkspaceList` 从所属 project 带出。
  Rejected: worker 自己猜默认分支（origin/HEAD 等）—— server DB 已有权威值，
  猜测会与项目导入时落库的值漂移。
  Based on: `proto/coflux/v1/daemon.proto:278-286` WorkspaceRef 现只有
  workspace_id + path；`crates/worker/src/main.rs:641-643` worker 收
  WorkspaceList 存 `HashMap<id, path>`，需扩为携带 default_branch。

- **上报机制**：复用现有分支监视循环的形态（周期轮询、内存缓存上次值、变化才发），
  并入 `crates/worker/src/main.rs:245-278` 的 3 秒循环或同构新任务均可（executor
  自定）；但轮询间隔必须 ≤5 秒——黑盒测试靠 waitFor 等广播，间隔过长会拖慢/超时。
  新增 daemon→server 消息 `WorkspaceDiff { workspace_id, additions, deletions }`
  （oneof 编号取下一个未用号；注意 `daemon.proto` 的 DaemonToServer oneof 编号
  不连续，19 已被 fs_write_result 占用）。
  Rejected: 每 tick 无条件上报 —— 与现有 branch/ports 的「变化才发」约定不一致。
  Based on: `crates/worker/src/main.rs:245-278`（branch 监视循环）、
  `proto/coflux/v1/daemon.proto:96-117`（DaemonToServer oneof）。

- **server 落库而非内存态**：workspaces 表加 `additions`/`deletions` 两列
  （INTEGER NOT NULL DEFAULT 0），hub 收到 workspaceDiff 后仿 `workspaceBranch`
  case：校验 daemon 归属 → 值未变则跳过 → 更新 DB → `broadcast workspaceCreated`。
  Workspace proto 实体加 `additions`/`deletions` 字段（int32），全链路自然带到 web。
  建表 DDL 是幂等 CREATE，生产已有表不会得到新列——必须同时在 `migrate()` 挂载点
  补 `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ...`（该方法注释即为此预留）。
  Rejected: hub 内存 Map —— server 重启后值丢失且 daemon 不重报（变化才发），
  出现无限期陈旧窗口；落库与 branch 镜像语义一致且代码最少。
  Based on: `apps/server/src/hub.ts:371-382`（workspaceBranch 处理）、
  `apps/server/src/store.ts:107`（幂等 DDL）、`apps/server/src/store.ts:235-239`
  （migrate() no-op 挂载点，注释明确"information_schema 查列补列"思路）、
  `apps/server/src/store.ts:447-453`（updateWorkspaceBranch 可仿写）。

- **web 展示位置与形态**：两处——sidebar 工作区行（branch 名右侧）与终端顶栏
  BranchMenu 旁，各一个 `+X −Y` 小字（等宽字体、加色/删色区分，颜色用主题 token
  不用裸 hex，遵循 `apps/web/.claude/CLAUDE.md` 的 astryx/token 约定）；
  X=Y=0 时不渲染。数据直接读 store 里 workspace 的新字段，无新增状态管理。
  Rejected: 仅一处 —— 用户已明确选两处都放；指挥中心视角需要 sidebar 总览。
  Based on: 用户 2026-07-22 grill 确认；`apps/web/src/components/workbench/sidebar.tsx:299-303`
  （工作区行 branch 展示）、`apps/web/src/components/workbench/workspace-terminal.tsx:397-413`
  （顶栏 BranchMenu）。

- **黑盒测试为主要验收**（decided while planning）：新增或扩展一个 `*.test.mjs`：
  mkRepo 导入项目后，在工作区改一个已跟踪文件、新建一个 untracked 文件，
  waitFor `workspaceCreated` 广播携带期望的 additions/deletions；再验证 agent
  commit 后数字不归零（累积语义）。worker 内的行数统计纯函数（NUL 判二进制、
  末行无换行计数）加 Rust 单测。新测试文件须独占端口（见各 test 顶部 PORT 约定）。
  Based on: `AGENTS.md` 测试哲学；`tests/src/lifecycle.test.mjs:42-48`
  （workspaceCreated 断言模式可仿）。

## Direction

数据流与既有 branch 镜像链路完全同构：
worker 周期计算（git 子进程 + 文件读）→ 变化才发 `WorkspaceDiff` → hub 校验落库
→ `workspaceCreated` 广播 → web store upsert → 两处 UI 渲染。

协议改动横跨 `proto/`（唯一真相源，`buf generate` 出 TS/Rust，禁止手写镜像），
Rust 与 TS 生成产物都要重新生成并提交。

### Milestone 1: 协议扩展

`common.proto` Workspace 加 additions/deletions；`daemon.proto` 加 WorkspaceDiff
消息进 DaemonToServer oneof、WorkspaceRef 加 default_branch。`buf generate` 后
三端生成产物更新。Validation: `cd proto && buf lint && buf generate` 后
`git status` 无未预期改动、`cargo build -p coflux-protocol` exit 0、
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exit 0。

### Milestone 2: worker 计算与上报

worker 收 WorkspaceList 保存 default_branch；周期计算各 workspace 的
+X/−Y（merge-base 累积 + untracked），变化才发 WorkspaceDiff。行数统计纯函数
带 Rust 单测。Validation: `cargo build -p coflux-worker`（零警告）、
`cargo test -p coflux-worker` exit 0。

### Milestone 3: server 落库广播

workspaces 表新列 + migrate() 补列；hub 处理 workspaceDiff（归属校验、
值未变跳过、落库、广播）。Validation: `node_modules/.bin/tsc -p
apps/server/tsconfig.json --noEmit` exit 0。

### Milestone 4: web 展示

sidebar 工作区行 + 终端顶栏各加 `+X −Y`（0/0 隐藏）。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` exit 0。

### Milestone 5: 黑盒验收

按 Decisions 所述新增黑盒用例（含 commit 后不归零断言）。
Validation: `pnpm -C tests test` exit 0（acceptance，见 Commands）。

## Landmines

- `DaemonToServer` oneof 编号不连续：数据面消息占了 15-18，`fs_write_result = 19`
  插在中间（`proto/coflux/v1/daemon.proto:96-117`）。新消息编号必须取全 oneof
  实际未用的下一个号，不能看末尾字段想当然。
- 生产 DB 已存在 workspaces 表，`SCHEMA_DDL` 是 `CREATE TABLE IF NOT EXISTS`
  幂等块（`apps/server/src/store.ts:107`）——只改 CREATE 块新库才有新列，
  生产/本地既有库必须靠 `migrate()`（`store.ts:235-239`）补列，否则上线即 500。
- 本机跑黑盒测试必须 `COFLUX_TEST_PG_URL` 指向 54322 直连口；5432 是 supavisor
  会报 tenant 错（本机 selfhost Supabase 环境特性）。
- `hub.ts` 的 branch 更新广播复用的是 `workspaceCreated` case（upsert 语义，
  `hub.ts:380`），不存在单独的 workspaceUpdated —— diff 更新沿用同一广播,
  不要发明新 client 消息。
- web 的 `apps/web/.claude/CLAUDE.md` 有 astryx 设计系统约束（no raw hex、
  token 优先）；两处 UI 都是现有组件内加小 span，不需要新组件。
- 分支监视循环在 `authed` 前跳过（`crates/worker/src/main.rs:256-258`），
  diff 轮询须同样处理，否则未认证时空跑子进程。

## Scope

In scope:
- `proto/coflux/v1/{common,daemon}.proto` 及 `proto/gen/`、TS/Rust 生成产物目录
- `crates/worker/src/{main,git}.rs`
- `apps/server/src/{hub,store}.ts`
- `apps/web/src/components/workbench/{sidebar,workspace-terminal}.tsx`
- `tests/src/`（新增或扩展一个 `*.test.mjs`）
- `plans/README.md`、`docs/ROADMAP.md`（勾掉「git diff 的展示」条目）

Out of scope:
- 文件级 diff 明细 / diff 内容查看 —— 本计划只做行数统计，明细是后续迭代
- `crates/supervisor` —— diff 全在 worker 侧，不碰 PTY/supervisor
- task/session 粒度的 diff 归因 —— diff 是 workspace（worktree）属性
- swift 生成产物消费方 —— 无 swift 客户端在用，`buf generate` 带出的更新照常提交即可

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto 校验+生成 | `cd proto && buf lint && buf generate` | exit 0，生成产物与提交一致 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| 黑盒测试 (acceptance) | `COFLUX_TEST_PG_URL=<54322 直连口> pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 在工作区改已跟踪文件 + 新建 untracked 文件后，web 两处（sidebar 行、
      终端顶栏）在一个轮询周期内出现正确的 `+X −Y`；全部还原后消失（0/0 隐藏）。
- [ ] agent/用户 commit 改动后统计不归零（累积语义），黑盒用例断言了这一点。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf breaking` 报不兼容（本计划全部是加字段/加消息，理论上不触发；触发即说明
  改动方式错了）。

## Maintenance notes

- diff 数值是设备侧真相的镜像，与 branch 同语义：server/DB 永远不主动改它，
  只接受 daemon 上报。排查「数字不对」先看设备侧 worker 日志，不是 DB。
- 轮询每周期对每个 workspace 起 2-3 个 git 子进程；工作区数量大或超大 repo
  时若成为负担，升级路径是先 `git status --porcelain` 判脏再算 diff，或拉长间隔。
- untracked 大文件（>1MB）行数不计入，展示值可能略低于 `git add -A` 后的真实值，
  是刻意取舍。
