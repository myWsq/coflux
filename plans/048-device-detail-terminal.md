# Plan 048: 无 repo 终端迁入设备详情 —— 设备行可点、每设备幂等一个目录工作区

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 97df47b..HEAD -- apps/server/src/hub.ts apps/web/src/components/workbench/ packages/client/src tests/src/no-repo-terminal.test.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none（改写 plan 045 的 UI 形态与创建语义）
- Category: feature
- Execution: self
- Planned at: `97df47b`, 2026-07-26

## Requirement

plan 045 的无 repo 终端目前形态：侧栏「项目」标题栏按钮 → 选设备弹窗 → 每次
点击新建一个目录工作区 + 一个任务，展示在侧栏独立「终端」分组，主视图刻意
不渲染 tab 栏（一工作区一任务）。用户复议后的新形态：

- 侧栏设备行**可点击并有选中态**（现状：`sidebar.tsx` 设备行不是 button、无
  onClick、无选中态）。点击设备 → 主区切换为该设备的「设备详情」视图。
- 设备详情 = 该设备的终端工作台：**有 tab 栏**（终端 Tabs + 新建按钮 + 端口，
  形态同项目工作区的顶栏），但**无分支按钮、无「变更」tab**（无 git 语义）。
- 数据模型改为**每设备幂等复用一个目录工作区**：tab = 该工作区下的 task；
  幂等在 server 侧收敛（见 Decisions）。
- 旧入口**全删**：侧栏顶部「新建终端」按钮、侧栏「终端」分组、
  `ImportProjectWizard` 的 `pickDeviceOnly` 模式。设备行是唯一入口。

正确性分界：点击设备必须稳定停留在该设备详情（快照校准不得把选中抢回项目
工作区）；对同一设备连续新建终端绝不产生第二个目录工作区（server 幂等兜底，
不依赖 web 自觉）；分支按钮与「变更」tab 在设备详情下绝不出现。

## Decisions & tradeoffs

- **设备详情的载体 = canonical 目录工作区的 `WorkspaceTerminal`**：选中态扩展
  为 workspace|device 二选一；选中 device 时解析该设备的 canonical 目录工作区
  （`isDirWorkspace` 且 `daemonId` 匹配、`createdAt` 最早），渲染其
  `WorkspaceTerminal`；无目录工作区时渲染设备层空态。Rejected: 点设备时把
  selection 转成 workspace id——设备无工作区时无物可选，且「设备被选中」这一
  UI 事实会丢失（高亮错位到不可见的终端分组行）。Based on: web 无路由，主区
  内容完全由 Workbench 的选中态驱动（`apps/web/src/App.tsx:6-11`、
  `apps/web/src/components/workbench/workbench.tsx:34`）。

- **server 幂等，`terminalCreate` 复用已有目录工作区**：处理 `terminalCreate`
  时若该 daemon 已有目录工作区（多个时取 `createdAt` 最早），跳过建
  workspace，只建 task；不复用时行为照旧。web 端本地已知有目录工作区时直接发
  `taskCreate`，不发 `terminalCreate`。Rejected: 仅 web 端判断——双端/竞态会
  建出重复 workspace，幂等判据必须收敛在 server 一处。Based on:
  `terminalCreate` 现行处理无条件新建（`apps/server/src/hub.ts:1285-1318`）；
  `taskCreate` 已对目录工作区放行（`apps/server/src/hub.ts:1388-1393`），故
  「第二个及以后的 tab」后端零改动。

- **反转 plan 045 的两条 UI 决策（显式记录）**：目录工作区**渲染顶栏**（终端
  Tabs + 新建按钮 + 端口），只是不渲染 `BranchMenu`、分隔线与「变更」tab；
  删除「目录工作区已有任务时 Mod+T 安静忽略」的单任务限制。plan 045 的
  「不渲染 tab 栏」「每次新建不复用」两决策由本 plan 作废，045 文档不改（历史
  记录）。Based on: 顶栏整体跳过在
  `apps/web/src/components/workbench/workspace-terminal.tsx:420`，单任务限制在
  `workspace-terminal.tsx:279-281`，`ChangesView` 跳过在
  `workspace-terminal.tsx:591`（这条保留）。

- **存量多目录工作区不做 UI 兼容**（decided while planning，偏离探索阶段
  「tab 平铺」设想）：045 的「每次新建」可能已留下同设备多个目录工作区；
  canonical 规则（createdAt 最早）只认一个，其余成为 UI 不可达记录，由用户
  上线后手动 SQL 清理（自用产品，量为个位数）。Rejected: 把
  `WorkspaceTerminal` 泛化为多 workspace 聚合——它的整个 attach 状态机按单
  `workspaceId` 过滤（`workspace-terminal.tsx:47-59`），为一次性存量写永久
  聚合代码，长期成本倒挂。Rejected: server 迁移合并——同理，一次性数据不值
  永久迁移代码。

- **删除语义**：关 tab = 删 task（现有 `onCloseTask` 链路，含 RUNNING 确认），
  最后一个 tab 关掉后目录工作区留作复用、不删除；web 端目录工作区的
  `requestRemoveWorkspace` 确认分支（`workbench.tsx:183-191`）随唯一入口
  （终端分组）一起删除。server 的 `workspaceRemove` 目录工作区分支
  （`apps/server/src/hub.ts:1327-1342`）**保留**——它仍是设备级联删除与旧
  客户端的正确路径，且黑盒测试覆盖它。Based on: 移除设备已有级联删除文案与
  链路（`workbench.tsx:200-207`）。

- **离线与空态**：设备离线时详情可进（保活现场/最后快照照常显示），新建
  终端禁用（创建链路 `fsList` 与 `taskStart` 都需要设备在线）。空态分两层：
  设备无目录工作区 → Workbench 层空态，点「新建终端」走
  `listDeviceDirectory(daemonId,"~")` → `terminalCreate`（链路照抄
  `workbench.tsx:126-134`）；有工作区无 task → `WorkspaceTerminal` 现有空态
  （`workspace-terminal.tsx:566-577`）走 `taskCreate`。两层空态视觉对齐。

- **选中态持久化与校准**：选中态（workspace|device）持久化到 localStorage
  （沿用 `WORKSPACE_KEY` 或新 key，执行者定，注意旧值兼容：现存裸 workspace
  id 字符串）；快照校准 effect 必须覆盖 device 分支——设备仍存在于 `daemons`
  即保留选中，否则回退现有 fallback。Based on: 现校准逻辑只认 workspace，
  无效选择会被抢回首项目 main workspace（`workbench.tsx:63-77`）。

- **mobile/iOS 不适配**：apps/mobile 已冻结、apps/ios 不在本片；仅保证共享层
  （packages/client）改动不弄坏两者构建。packages/client 若需新增
  「canonical 目录工作区」查询 helper，与 `isDirWorkspace` 放一处
  （`packages/client/src/store.ts:100-104`），谓词不许散落。

## Direction

数据流：点设备行 → selection=device → 解析 canonical 目录工作区 → 有则渲染
其 `WorkspaceTerminal`（顶栏反转后含 Tabs/新建），无则设备空态 →首次新建走
`fsList("~")` + `terminalCreate`（server 幂等兜底）→ `workspaceCreated`/
`taskCreated` 广播 → 视图自然出现终端；后续新建全部走 `WorkspaceTerminal`
现有 `createTerminal()`（`taskCreate`）。

### Milestone 1: server 幂等 + 黑盒测试改写

`terminalCreate` 复用分支落地；`tests/src/no-repo-terminal.test.mjs` 的
「每次点击各建一个工作区，互不复用」用例（`no-repo-terminal.test.mjs:53-64`）
断言与新语义正对立，改写为：第二次 `terminalCreate` 不产生新 workspace、
产生挂在首个 workspace 下的新 task。其余用例（创建、PTY cwd、删除、空 path
拒绝）保持通过。Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0；
`COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` → exit 0。

### Milestone 2: web 设备详情 + 旧入口删除

设备行可点带选中态（样式对照工作区行选中态 `sidebar.tsx:311-321`）；主区
device 分支渲染；顶栏反转；两层空态；离线禁用新建；删除三处旧入口（顶部
按钮 `sidebar.tsx:210-217`、终端分组 `sidebar.tsx:383-439`、`pickDeviceOnly`
模式 `import-project-wizard.tsx` 与 `workbench.tsx:388-400` 的第二个向导
实例）及其随之死掉的代码（`onNewTerminal` prop、dir 工作区 remove 确认分支
等）。Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0；
`node_modules/.bin/tsc -b apps/mobile/tsconfig.json` → exit 0（仅证共享层
未弄坏 mobile；以仓库现有 mobile 构建命令为准）。

## Landmines

1. **快照校准会抢走 device 选中**：`workbench.tsx:63-77` 在每次
   `snapshotRevision` 变化时把「不在 workspaces 里的选中」回退到首项目 main
   workspace。device 选中若不在该 effect 里显式放行，点开设备后下一次快照
   就被抢回项目视图。
2. **`retainDevice` 依赖 selectedDaemonId**：现从选中 workspace 推导
   （`workbench.tsx:60`、`88-91`）；selection 为 device 时须直接以设备 id
   retain，否则设备详情期间 Device route 不建连，终端 attach 不上。
3. **保活集合按 workspace id**：`visitedWorkspaceIds`/`terminalWorkspaces`
   （`workbench.tsx:37`、`228-235`）驱动 keep-alive 挂载；设备详情渲染的
   canonical 工作区必须纳入，且工作区被删时仍靠 workspaces 过滤自动卸载。
   同时 active ref 只挂 active 实例的约定（`workbench.tsx:48-50`、`330`）
   对 device 分支同样成立，否则全局快捷键广播错实例。
4. **`workspaceCreated` 是 upsert 广播**：`workspaceSetName` 已复用它
   （`apps/server/src/hub.ts:1358-1360`）。幂等复用分支若重播已有 workspace
   不会弄坏 web store，但 web 的 `pendingWorkspaceCreateRef` 靠「广播中新
   出现的未知 id」识别自建工作区（`workbench.tsx:138`、`146-155`）——复用
   分支不产生新 id，不能再依赖该机制自动切换；好在 device 流程点击时已选中
   设备，无需切换，执行时别把这套 pending 机制照搬进 device 创建链路。
5. **两套 creating/pending 不要混**：`WorkspaceTerminal` 内部的
   `pendingCreateRef`/`creating`（`workspace-terminal.tsx:276-285`、
   `308-315`）管 `taskCreate`；Workbench 层设备空态的首次创建管
   `terminalCreate`。互不相认，各自处理 error 清理（参考
   `workbench.tsx:158-161`、`workspace-terminal.tsx:342-351`）。
6. **document.title 只认项目**（`workbench.tsx:80-84`）：device 选中时按
   设备名（或回落默认）处理，避免标题残留上一个项目名。
7. **测试端口惯例**：`tests/src/*.test.mjs` 每文件独占端口（
   `no-repo-terminal.test.mjs:12` 用 8854），改写用例留在原文件即可；若新增
   文件须选未占用端口。本机跑黑盒必须 `COFLUX_TEST_PG_URL` 指 54322 直连口。

## Scope

In scope:

- `apps/server/src/hub.ts`（terminalCreate 幂等分支）
- `apps/web/src/components/workbench/`（workbench、sidebar、
  workspace-terminal、import-project-wizard、dialogs 等随动）
- `apps/web/src/config.ts`（若选中态持久化需要新 key）
- `packages/client/src/`（canonical 目录工作区 helper，若需要）
- `tests/src/no-repo-terminal.test.mjs`（幂等断言改写）
- `plans/README.md`

Out of scope:

- `proto/`、生成物 — 协议零改动（`Workspace.daemon_id` 已有，
  `proto/coflux/v1/common.proto:36`）
- `crates/`（daemon/supervisor/relay）— 后端行为不变
- `apps/mobile/`、`apps/ios/` — 冻结/另片，仅保证构建不坏
- 存量多目录工作区的数据迁移 — 手动清理（见 Decisions）
- push / PR / 发版

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| mobile 构建不坏 | `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` | exit 0 |
| 黑盒集成测试 | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| UI 走查 (acceptance) | 用户人工验证（既定约定：前端改动不做 Claude 走查） | 用户确认 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 黑盒用例断言：同设备第二次 `terminalCreate` 复用 workspace 只建 task；
      原有创建/PTY cwd/删除/空 path 用例保持通过。
- [ ] 点击设备行 → 选中态高亮 + 主区设备详情；快照到达后选中不被抢走。
- [ ] 设备详情顶栏只有终端 Tabs + 新建 + 端口；无分支按钮、无「变更」tab；
      Mod+T 可连续新建多个 tab。
- [ ] 三处旧入口（顶部按钮、终端分组、pickDeviceOnly）全部删除，无死代码残留。
- [ ] 设备离线时新建禁用；已有终端现场照常展示。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（尤其发现必须改 proto 或 crates 才能
  达成幂等/选中语义时）.
- A validation command fails twice after one reasonable fix.
- 发现 `taskCreate` 对目录工作区的放行（`hub.ts:1388-1393`）被移除或收紧
  （多 tab 的后端基石假设为假）。

## Maintenance notes

- canonical 目录工作区规则（该 daemon 下 `isDirWorkspace` 且 createdAt 最早）
  是 web 与 server 的隐式契约，两侧改动需同步审视；谓词仍收敛在
  `isDirWorkspace` 一处，不许散落裸比较。
- 045 遗留的同设备多目录工作区为 UI 不可达记录，生产上手动清理：
  `delete from workspaces where project_id = '' and ...`（连带 tasks），或
  临时用移除设备级联。清理前它们无害（不参与幂等 canonical 之外的任何路径）。
- plan 045 文档保留历史决策原文；本 plan 是其 UI 形态与创建语义的替代真相源。
