# Plan 025: 工作区「变更」tab + diff 查看视图

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat e152ebb..HEAD -- apps/web/src/ apps/web/package.json apps/web/src/index.css`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none（024 已 DONE，其数据链路是本 plan 的信号源）
- Category: feature
- Execution: subagent sonnet
- Planned at: `e152ebb`, 2026-07-23

## Requirement

产品定位是「Agent 指挥中心」：024 已让用户扫一眼知道每个工作区改了多少行
（+X −Y），下一步是**看到改了什么**。在工作区顶栏 BranchMenu（分支按钮）右侧
增加一个**常驻「变更」tab**，携带 +X −Y 徽标；点击切换主面板到变更视图，
展示该工作区所有文件的 git diff（交互参考 Codex web 的 Diff tab 与 Cursor
的文件卡片）。

做完后成立的事实：
- 顶栏 BranchMenu 右侧、竖线分隔符左侧有一个常驻「变更」tab：有变更时显示
  `+X −Y` 徽标，X=Y=0 时徽标隐藏但 tab 仍在；原顶栏独立的 +X −Y span 被
  移除（并入徽标）；sidebar 工作区行的统计**保留不动**。
- 点击「变更」tab 主面板切到变更视图；点击任意终端会话 tab 切回终端。
  两种视图选中态互斥（「变更」激活时终端 tab 均不高亮）。终端实例保活
  （显隐切换，不卸载）。
- 变更视图：顶部汇总条（N 个文件、总 +X −Y）+ 单列可折叠文件卡片（卡片头 =
  文件路径 + 该文件 +X −Y，可点击折叠/展开），正文为 unified diff，代码按
  文件语言经 shiki 语法高亮，增/删行有可区分的背景与颜色（token 色）。
- diff 范围与 024 统计**同一基准**：merge-base(default_branch, HEAD) 到
  工作树的累积 diff，untracked 新文件以「全新增」形式展示。tab 徽标数字与
  页面内容一致。
- 视图打开期间，工作区 additions/deletions 广播值变化时自动重拉 diff，
  文件卡片折叠状态按路径保留。
- 无变更时显示空态；daemon 离线或 exec 失败时显示错误提示（不白屏、不 spin
  卡死）。

正确解 vs 相邻错误解的分界：
- diff 基准必须与 024 一致（merge-base 累积 + untracked）。只展示
  `git diff`（未提交脏改动）的实现是错的——agent commit 后页面变空但
  tab 数字非零，自相矛盾。
- untracked 文件必须出现在文件列表中（渲染为全新增），否则数字对不上。
- 后端（proto/worker/server）**零改动**。新增任何 proto 消息或 worker
  计算路径都是错的——现有 exec RPC 已覆盖。

## Decisions & tradeoffs

- **数据获取：复用现有 exec RPC，后端零改动**。web 端用
  `execInWorkspace(workspaceId, command, args)`（注意函数名，探索期笔记里
  误记为 sendExec）按需跑 git 命令拿 diff 文本。
  Rejected: 新增 `WorkspaceDiffContent` proto + worker 计算 —— exec 链路
  已有请求关联（crypto.randomUUID）、超时、断线清理与黑盒测试覆盖，新链路
  纯属重复。
  Based on: `apps/web/src/client/store.ts:369-374`（execInWorkspace）、
  `apps/server/src/hub.ts:929-935`（clientExec relay）、
  `crates/worker/src/ops.rs:28`（run_command）、`tests/src/contract.test.mjs`
  （exec relay 已有黑盒覆盖）。

- **diff 基准与 024 完全一致**：以 web store 中该 workspace 所属 project 的
  `defaultBranch` 为准（protocol 类型已带该字段），exec
  `git merge-base <defaultBranch> HEAD` 求 base；解析失败（孤儿分支等）回退
  HEAD 作 base——与 worker 侧 `diff_stat` 的回退语义相同。正文用
  `git diff <base>`（单 rev = base 对比工作树），untracked 列表用
  `git ls-files --others --exclude-standard`。per-file 统计用
  `git diff --numstat <base>`。
  Rejected: `git diff HEAD` —— 仅未提交改动，与 024 累积语义矛盾（见
  Requirement 分界）。Rejected: web 端自己猜默认分支 —— project 实体有
  权威值。
  Based on: `crates/worker/src/git.rs:48`（024 的 diff_stat 基准与回退）、
  `packages/protocol/src/gen/coflux/v1/common_pb.ts:102`（Project.defaultBranch）。

- **shiki 按文件语言高亮，语言按需加载，单暗色主题**。用户明确选择 shiki
  （拒绝了纯行级着色方案）。约束：①按文件扩展名映射语言高亮代码内容，
  未知扩展名/无语言降级纯文本渲染；②语言资源必须按需懒加载，不得把全部
  语言打进主 bundle（fine-grained `shiki/core` 或 `shiki/bundle/web` 均可，
  executor 自定）；③只需一套暗色主题——web 是纯暗色应用，无主题切换。
  ④增/删行的背景与 +/− 颜色用现有 token（`text-success`/`text-destructive`
  等），不用 shiki 主题色或裸 hex。
  Rejected: `lang='diff'` 整体高亮 —— 只给 +/− 行着色、代码本身无语言
  token，达不到用户选 shiki 的意图（接近 Cursor/GitHub 档次）。
  Rejected: dual themes / CSS variables 主题 —— 应用无亮色模式，纯增复杂度。
  Based on: `apps/web/src/index.css:30`（`color-scheme: dark` 固定，无
  主题切换代码）、`apps/web/package.json`（现无任何高亮/diff 依赖）。

- **视图切换是 WorkspaceTerminal 内部本地 state（"terminal" | "changes"），
  非路由**。项目无 react-router，一切视图切换靠 state 显隐；终端面板保持
  现有保活模式（隐藏不卸载）。「变更」激活时终端 tab 去高亮；点终端 tab
  回 terminal 视图并激活该 task。
  Rejected: 引入路由 —— 项目既有约定是 state 显隐（workbench 工作区切换
  即此模式），路由是无端新范式。
  Based on: `apps/web/src/components/workbench/workspace-terminal.tsx:511-529`
  （TerminalPane 按 active 显隐保活）、`workbench.tsx:258-273`（同模式）。

- **刷新信号：监听 store 里该 workspace 的 additions/deletions**（024 的
  worker 3s 轮询 → 变化才广播 → store 更新，信号免费），值变化且变更视图
  处于激活态时重拉 diff；**非激活时不拉取**（切到 changes 视图时拉当次）。
  折叠状态按文件路径保留，刷新不重置。
  Rejected: 变更视图自己起轮询 —— 与 024「变化才动」的约定重复且浪费。
  Rejected: 后台常拉（视图未打开也拉）—— 每工作区 3s 一次全量 diff 文本
  relay，纯浪费。
  Based on: `apps/server/src/hub.ts:386-393`（workspaceDiff → 广播）、
  `workspace-terminal.tsx:415-423`（web 已实时持有 additions/deletions）。

- **顶栏统计移入徽标，sidebar 统计保留**（decided while planning，用户在
  departure check 确认「统计放在 tab 上」指顶栏一处；sidebar 是指挥中心
  总览，024 明确要的，本需求未触及）。
  Based on: `workspace-terminal.tsx:415-423`（待移除的顶栏 span）、
  `apps/web/src/components/workbench/sidebar.tsx:305-311`（保留）。

- **空态与错误态**（decided while planning）：additions=deletions=0 时直接
  渲染空态（「无变更」），不发 exec；exec 返回 `ok=false` 或 `error` 非空
  （含 relay 超时「超时」、「daemon 掉线」）时显示错误提示与重试按钮。
  Based on: `apps/web/src/client/store.ts:288-292`（execResult resolve 形态，
  错误也走 resolve 不 reject）、`apps/server/src/hub.ts:181-185,653`
  （relayError 回包）。

- **不新增自动化测试**（decided while planning）：本 plan 后端零改动，全部
  改动在 web 展示层；项目无前端单测基建（无 vitest/jest），黑盒测试只覆盖
  协议/服务端行为且 exec relay 已有覆盖。验收靠 typecheck+build 与
  acceptance 手验。
  Based on: `apps/web/package.json`（无测试 script）、
  `tests/src/contract.test.mjs`（exec relay 既有覆盖）。

## Direction

### Milestone 1: 「变更」tab 与视图骨架

顶栏出现常驻「变更」tab（含徽标、0 值隐藏数字），点击切换到变更视图占位，
与终端 tab 选中态互斥，终端保活；原顶栏 +X −Y span 移除。
Validation: `pnpm --filter @coflux/web build` -> exit 0。

### Milestone 2: diff 拉取与文件卡片渲染

变更视图经 exec RPC 拿 merge-base 基准的累积 diff + untracked，渲染汇总条 +
可折叠文件卡片 + shiki 高亮正文；空态/错误态可达。
Validation: `pnpm --filter @coflux/web build` -> exit 0。

### Milestone 3: 自动刷新与状态保留

additions/deletions 变化触发重拉（仅视图激活时），折叠态按路径保留。
Validation: `pnpm --filter @coflux/web build` -> exit 0。

## Landmines

- **exec 不走 shell**：`run_command` 直接 spawn command+args
  （`crates/worker/src/ops.rs:28-38`），不能用管道、`&&`、`$()`。多条 git
  命令 = 多次 execInWorkspace 调用。
- **非 ASCII 路径转义**：git 默认把中文等路径转义成 `\346\226\207` 八进制。
  跑 diff/ls-files 时带 `-c core.quotepath=false`，否则文件名显示乱码且
  路径匹配（折叠态、untracked 合并）失效。
- **`git diff --no-index` 有差异时 exit code 为 1**：若用它渲染 untracked
  文件内容，exit 1 + `ok=true` 是正常成功，不能当错误处理
  （`ops.rs:44-48` 会原样回带 exit_code）。
- **exec 超时上限在 server**：`execTimeout = min(execMaxTimeoutMs, 请求值||默认)`
  （`apps/server/src/hub.ts:933`），worker 默认 60s（`ops.rs:12`）。大仓库
  diff 文本可达数 MB，stdout 无截断，全量走 relay——正常规模没问题，但
  不要逐 untracked 文件起几十次 exec（一次 ls-files 拿列表后合并处理）。
- **顶栏 BranchMenu 的 ghost 按钮有内联样式压 StyleX 的既有 hack**
  （`workspace-terminal.tsx:404-410`），新 tab 按钮样式跟随顶栏现有手写
  Tailwind + token 风格（`apps/web/.claude/CLAUDE.md` 约定：禁裸 hex/px，
  终端工作台区域按现状走 Tailwind 原子类而非强套 Astryx 页面组件）。
- **workspace.additions/deletions 是 int32 恒有值**（024 落库默认 0），
  判空态用 `=== 0`，不要当 optional 处理。

## Scope

In scope:
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/` 下新增变更视图组件文件
- `apps/web/package.json`、`pnpm-lock.yaml`（新增 shiki 依赖）
- `apps/web/src/index.css`（如需少量 diff 渲染样式）

Out of scope:
- `proto/`、`crates/`、`apps/server/`、`packages/protocol/` —— 后端零改动是
  本 plan 的决策红线
- `apps/web/src/components/workbench/sidebar.tsx` —— 统计保留原样
- diff 的 review/评论/勾选文件等交互 —— 本期只读查看
- 亮色主题适配 —— 应用无亮色模式

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| 黑盒回归（后端未动，跑通即可） | `cd tests && COFLUX_TEST_PG_URL=<54322 直连口> pnpm test` | exit 0 (acceptance) |
| Playwright 手验变更视图 | 本机 `pnpm dev` + daemon 后浏览器操作 | 视图/徽标/刷新符合 Requirement (acceptance) |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` 通过。
- [ ] 顶栏常驻「变更」tab + 徽标行为符合 Requirement（0 值隐藏数字）；原顶栏
      独立统计 span 已移除；sidebar 统计未动。
- [ ] 变更视图展示与 024 同基准的累积 diff（含 untracked 全新增），shiki
      按语言高亮，文件卡片可折叠，汇总条正确。
- [ ] additions/deletions 变化时激活态视图自动重拉，折叠态保留。
- [ ] 空态与错误态可达且不卡死。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（尤其：发现必须改 proto/worker/server
  才能实现——停下报告，不得越线）。
- A validation command fails twice after one reasonable fix.
- shiki 无法在语言懒加载约束下集成（主 bundle 不可避免地全量膨胀）——停下
  报告，不得擅自降级为无高亮方案。

## Maintenance notes

- 变更视图的 diff 基准逻辑（merge-base + 回退 HEAD + untracked）与
  `crates/worker/src/git.rs` 的 `diff_stat` 是**语义镜像**：一侧改基准语义，
  另一侧必须同步，否则 tab 数字与页面内容漂移。
- exec 拉全量 diff 文本在超大 diff（数十 MB）下会变慢；若未来遇到，升级
  方向是按文件懒拉（先 numstat 列表，展开卡片时再拉单文件 diff），不需要
  动协议。
- shiki 语言 chunk 由构建器代码分割产生，dist 文件数量增多是预期行为。
