# Plan 048: 终端任务 Tab 换组件库 Tooltip（状态 + 所属设备 + 调试信息）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 4e86465..HEAD -- apps/web/src/components/workbench/workspace-terminal.tsx apps/web/src/components/workbench/sidebar.tsx packages/protocol/src/gen/coflux/v1/common_pb.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `4e86465`, 2026-07-26

## Requirement

终端任务 Tab（每个工作区顶栏的 Tab 条）目前只挂原生 `title`
（`apps/web/src/components/workbench/workspace-terminal.tsx:474`），悬停约 1s 才弹、
只有任务标题一行字。要求换成组件库 Tooltip，版式对齐侧边栏设备行的 tooltip
（`apps/web/src/components/workbench/sidebar.tsx:516-537`）：一行加粗标题说结论，
下面图标条目列表铺上下文。

内容（用户已选定，含调试信息）：

- 标题行：任务标题（空则「终端」）+ 状态——运行中 / 已被接管 / 已退出
  （有 `exitCode` 时带 code N）。被接管态须保留原 title 里「点击重新接管」的提示语义。
- 条目行：所属设备（按 `task.daemonId` 查 `daemons` 得名字 + 在线/离线；查不到显示
  「设备记录缺失」）、创建时间、sessionId、更新时间。

正确解的判据：悬停任意任务 Tab 立即弹出上述结构化 tooltip，且内容随 store 更新
（状态/updatedAt 变了 tooltip 跟着变——组件库 Tooltip 天然满足，原生 title 不满足，
这正是替换动机，见 sidebar.tsx:513-514 的注释）。相邻的错误解：只把原 title 文案塞进
Tooltip content 当纯字符串、或另造一套与设备 tooltip 不同的版式。

## Decisions & tradeoffs

- **挂载点**：Tooltip 包 Tab 内的主按钮（现挂 `title` 的那个），替换掉原生 `title`
  属性。Rejected: 包整个 Tab 容器 —— 容器里还有「转发端口」下拉和关闭按钮，各自已有
  Tooltip（workspace-terminal.tsx:489、:504），嵌套会双弹。
  Based on: `apps/web/src/components/workbench/workspace-terminal.tsx:471-484`。
- **组件与参数**：`@astryxdesign/core/Tooltip`（该文件已 import，:9），
  `placement="below"`（与 Tab 区其他 Tooltip 一致，见 :504、:516），
  `hasHoverIndication={false}`（同设备 tooltip，sidebar.tsx:549）。
  Rejected: 原生 `title` —— 悬停约 1s 才弹且内容不随心跳/store 更新。
- **版式**：照抄设备 tooltip 的结构——`flex flex-col gap-1`，加粗标题行 +
  `text-xs text-muted-foreground` 图标条目列表（sidebar.tsx:522-537）。图标从 lucide
  选语义贴切的（设备用 Monitor，时间/session/更新由 executor 挑），尺寸 `size-3`。
  Rejected: 自创版式 —— 需求就是「类似设备的那种」。
- **状态文案的来源**：标题行状态由本地 `stateOf(task)`（detached/attaching/owned…）
  与 `task.status`（`TaskStatus.IDLE|RUNNING|EXITED`，
  `packages/protocol/src/gen/coflux/v1/common_pb.ts:558-578`）合成：detached 优先显示
  「已被接管（点击重新接管）」；EXITED 显示「已退出」+（`exitCode !== undefined` 时）
  ` code N`；RUNNING 显示「运行中」；IDLE/attaching 等其余态 executor 按语义给简短中文
  文案即可，不设硬性措辞。Rejected: 只看 `task.status` —— 丢掉被接管提示，语义倒退。
- **设备行**：`daemons` 来自 `client.store`（组件内已有多个 `useStore(client.store, …)`
  取数先例，workspace-terminal.tsx:47-60），按 `task.daemonId` 查；找到显示
  `名字（在线/离线）`，找不到显示「设备记录缺失」（沿用 sidebar.tsx:267 的既有文案）。
  Rejected: 从 props 新传 daemons —— store 就在手边，加 props 是绕路。
- **时间格式** (decided while planning)：`createdAt`/`updatedAt` 是 `Date.now()` 毫秒
  epoch（apps/server/src/hub.ts:850,1310）。仓库无现成日期格式化惯例（grep 无
  toLocale/dayjs/date-fns 命中），用 `Date` 原生本地化输出（如 `toLocaleString`），
  精确到分钟即可，不引第三方日期库。
- **sessionId 展示** (decided while planning)：`sessionId` 是 optional，无值时该条目行
  整行不渲染（同设备 tooltip 对 workerVersion 的条件渲染模式，sidebar.tsx:518）；
  有值时完整展示不截断语义（视觉截断用 `truncate` 即可，同 sidebar.tsx:532）。

## Landmines

- Tab 容器内嵌套交互件：主按钮旁还有 DropdownMenu（转发端口）和带 Tooltip 的关闭按钮
  （workspace-terminal.tsx:485-511）。Tooltip 只能包主按钮，包错层级会出现双 tooltip
  或吞掉 hover。
- `stateOf(task)` 是组件内闭包函数，依赖 `detachedTaskIds`/`controlStates` 本地状态——
  tooltip 内容必须在组件渲染路径里合成，不能提成纯函数搬到组件外。
- 目录工作区（`isDirWorkspace`）整个顶栏不渲染（workspace-terminal.tsx:420），
  Tab map 只在非目录工作区走到，无需为其做分支。

## Scope

In scope:

- `apps/web/src/components/workbench/workspace-terminal.tsx`

Out of scope:

- `apps/web/src/components/workbench/sidebar.tsx` — 只作版式参照，不改
- `apps/mobile/**` — 已冻结，不迭代
- `apps/ios/**`、协议/服务端 — 纯前端展示改动，不动数据面

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| UI 走查 (acceptance) | 用户人工验证（既定约定：前端改动不做 Claude 走查） | 用户确认 |

## Done criteria

- [ ] `node_modules/.bin/tsc -b apps/web/tsconfig.json` 通过。
- [ ] 任务 Tab 主按钮不再有原生 `title`，悬停弹出组件库 Tooltip：加粗标题行
      （标题 + 状态）+ 条目行（设备、创建时间、sessionId（有则显）、更新时间）。
- [ ] 实现遵守 Decisions & tradeoffs 全部条目。
- [ ] 无 out-of-scope 文件变更。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- Decisions & tradeoffs 引用的事实不再成立（如 Tooltip 组件 API 变更、Tab 结构重构）。
- 结果需要改 out-of-scope 文件。
- 类型检查在一次合理修复后仍连续失败两次。

## Maintenance notes

- tooltip 内容与设备 tooltip（sidebar.tsx）是同一版式语汇的两处手写实现；若再出现第三处，
  才值得抽公共组件，两处不抽（YAGNI）。
- 状态文案若日后要加 attaching 等更多态，标题行合成逻辑就在 Tab map 内，随 `stateOf` 演进。
