# Plan 045: 无 repo 终端 —— 选设备后在其 HOME 直接开终端

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 03d98e1..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts crates/worker/src/main.rs packages/client/src apps/web/src/components/workbench/ tests/src/`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `03d98e1`, 2026-07-26

## Requirement

目前发起终端的唯一路径是：导入一个 git 仓库为 project → 在其 workspace 下建
task。用户想跳过 repo，直接在某台设备上开一个普通终端：

- 入口：侧栏「项目」分组标题上"导入项目"按钮旁新增一个按钮；点开后选择一台
  在线设备（交互对齐导入向导第一步），**没有目录浏览步**，选完即建即跳转。
- 终端 cwd = 该设备的 `$HOME`（真实用户 HOME，不是 `~/.coflux`）。
- 每次点击新建一个"目录工作区"+ 一个任务（用户明确选择"每次新建"，不做
  按设备幂等复用）。
- 展示在侧栏**单独的「终端」分组**（不混入项目树、不挂设备行下）。
- 其终端视图**不显示 tab 栏**（含「变更」tab 与新建终端按钮都不出现——
  一工作区一任务，tab 无意义）。
- diff/branch/worktree 等 git 语义功能对目录工作区全部隐藏/跳过。
- 复用现有 task/session/resync/终端镜像/重连全链路，终端体验与普通任务无差别。

正确性的分界：终端必须打开在设备真实 `$HOME`（打开在 `~/.coflux` 即错，见
Landmines 1）；目录工作区绝不能触发任何 git 操作（worktree remove、branch/diff
上报，见 Landmines 2/3）。

## Decisions & tradeoffs

- **目录工作区的表达**：约定 `workspace.projectId === ""` 即目录工作区，**不加
  kind 字段、不改 DB schema、不改 `Workspace` proto**。Rejected: `Workspace.kind`
  enum——两侧生成物与存储涟漪大，而空 projectId 已无歧义（现有 workspace 一定有
  projectId）。Based on: workspaces 表无外键约束、`project_id TEXT NOT NULL` 存空串
  合法（`apps/server/src/store.ts:276-288`）；proto 字段本就是 plain string
  （`proto/coflux/v1/common.proto:33-48`）。判定逻辑在 web/server 各收敛为一个
  谓词（如 `isDirWorkspace`），不许散落裸比较。

- **cwd 全链路绝对路径，不做 `~` 展开**：web 选完设备后先用现成目录浏览通道
  `listDirectory(daemonId, "~")`（`packages/client/src/store.ts:620-623` →
  `DeviceFsList{browse_home:true}`）取响应 `FsListed.path` 里 daemon 解析好的
  HOME 绝对路径，再把它作为 `path` 发给 server 落库为 `workspace.path`；此后
  taskStart 下发 `sessionCreate{cwd: ws.path}` 零改动。Rejected: 空 cwd 靠
  supervisor 回落——回落值实为 `COFLUX_HOME`（见 Landmines 1）；worker 侧展开
  `~`——SessionCreate 有 relay 与端到端两条通路都要改，且 daemon 工作区清单里的
  `workspace_root` 仍会拿到 `~`，弄坏 fs 上传/exec（`crates/worker/src/device.rs:1277-1282`）。
  Based on: daemon 已在 `browse_home` 分支解析真实 `$HOME` 并在 `FsListed.path`
  回传解析后路径（`crates/worker/src/device.rs:882-897`）；server 下发 cwd 唯一
  来源是 `ws.path`（`apps/server/src/hub.ts:1527`）。

- **新 client 消息 `TerminalCreate{daemon_id, path}`，server 直接落库，不走
  prepared-operation 校验往返**：server 校验 daemon 属于该账号且在线、path 非空后，
  同一事务建 workspace（`projectId:""`、`branch:""`、`isMain:false`）+ 一个 task，
  广播 `workspaceCreated`/`taskCreated`。Rejected: 仿 `projectImport` 的
  `ProjectValidate` 往返（`apps/server/src/hub.ts:1191-1216`）——那是为了校验
  git repo；这里 path 本来就是 daemon 自己在 `FsListed` 里报的，无可校验之物。
  消息与处理放在现有 client.proto / hub.ts 的同类消息旁（`proto/coflux/v1/client.proto:69-96`）。
  改 proto 后 `buf generate`，TS/Rust 生成物一并提交。

- **删除语义**：终端分组行提供移除入口，复用 `workspaceRemove` 消息；server 对
  `projectId === ""` 的 workspace 走"仅删记录 + 级联删其任务/停 session"分支，
  **绝不进入 `worktree.remove` prepared operation，且 daemon 离线也可删**。
  Rejected: 复用现有 worktree.remove 路径——它会对目标路径执行 git worktree
  操作并要求 daemon 在线（`apps/server/src/hub.ts:783-795`、`hub.ts:1222`），对
  HOME 目录属危险误用。

- **daemon 跳过目录工作区的 git 轮询**：工作区清单项 `defaultBranch` 为空即跳过
  branch 监视与 diff_stat 轮询。Rejected: 依赖 git 命令对非 git 目录"安静失败"——
  若用户 HOME 恰被 dotfiles 仓库（yadm 等）管理，会把无意义 branch/diff 上报进
  一个 branch 为空的 workspace。Based on: 清单下发时目录工作区的 defaultBranch
  已自然回落空串（`apps/server/src/hub.ts:295-299`），普通工作区不会为空；轮询
  循环在 `crates/worker/src/main.rs:350-377`。

- **UI 形态（用户已定）**：侧栏新增独立「终端」分组渲染
  `workspaces.filter(isDirWorkspace)`；无目录工作区时整个分组不渲染（不做常驻
  空态）。目录工作区的主视图不渲染 tab 栏——含终端 tabs、「变更」tab
  （`apps/web/src/components/workbench/workspace-terminal.tsx:430` 一带）与
  新建终端按钮（`workspace-terminal.tsx:277` 的 `taskCreate` 入口）。选设备
  对话框对齐导入向导第一步的交互与视觉（`apps/web/src/components/workbench/import-project-wizard.tsx:149-195`，
  含只列在线设备、键盘可达、无在线设备时的"登记设备"空态）；复用组件还是新建
  轻量对话框由执行时判断，以最小 diff 为准。工作区 `name` 默认存 `"~"`，分组行
  展示设备名 + name，行内细节从现有项目树行的样式惯例。

- **每次点击新建 workspace+task（不幂等复用）**（用户在出发检查明确选择）。
  任务 title 沿用现有默认命名惯例（如「终端」），执行时对齐 `taskCreate` 现状。

- **mobile 不适配**：apps/mobile 已冻结；目录工作区 projectId 为空，在 mobile 的
  项目分组下自然不可见即可，仅保证其构建不坏。

## Direction

数据流（全部复用现有机制）：web 新按钮 → 选设备 → `fsList(daemonId,"~")` 取
HOME 绝对路径 → `terminalCreate{daemonId, path}` → server 落库 workspace+task 并
广播 → web store 收到后跳转该 workspace/task → 用户点开即走现有
`taskStart` → `sessionCreate{cwd: ws.path}` → PTY 起在 HOME。

### Milestone 1: 协议 + server + daemon 后端闭环

`TerminalCreate` 消息落地（proto 两侧生成物提交）；server 处理创建与删除两个
分支；daemon 跳过空 defaultBranch 的 git 轮询。新增黑盒测试用例：发
`terminalCreate` → 断言 `workspaceCreated`（projectId 为空、path 正确）与
`taskCreated` 广播 → `taskStart` 后 session 可 attach（cwd 为传入 path，可经
PTY 内执行 `pwd` 验证）→ `workspaceRemove` 在不触发 worktree 操作的情况下删除
成功。Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`、
`cargo build -p coflux-supervisor -p coflux-worker`（零警告）、
`COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` → exit 0。

### Milestone 2: web 入口 + 终端分组 + 无 tab 终端视图

侧栏导入按钮旁新按钮与选设备对话框；「终端」分组；目录工作区终端视图无 tab
栏/无变更 tab/无新建终端按钮；分组行移除入口；git 类 UI（diff 数字、branch、
新建工作区菜单等）对目录工作区不出现。Validation:
`node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0；
`node_modules/.bin/tsc -b apps/mobile/tsconfig.json`（若存在该 build 入口，以
仓库现有 mobile 构建命令为准）→ exit 0（仅证明共享层未弄坏 mobile）。

## Landmines

1. **supervisor 的 `home` 字段实为 `COFLUX_HOME`**（默认 `~/.coflux`）：空 cwd
   会让 PTY 起在 `~/.coflux` 而非用户 HOME（`crates/supervisor/src/sessions.rs:337`、
   `crates/supervisor/src/main.rs:48`）。本方案用绝对路径绕开；**不要动
   supervisor**（其升级节奏刻意极低，见 AGENTS.md）。
2. **workspaceRemove 现行路径会对 workspace.path 执行 git worktree 操作且要求
   daemon 在线**（`apps/server/src/hub.ts:783-795`、`hub.ts:1222`）。目录工作区
   必须在进入该路径前分流。
3. **daemon 对清单内所有 workspace 无差别跑 git 轮询**
   （`crates/worker/src/main.rs:350-377`）：HOME 被 dotfiles 仓库管理时会误报
   branch/diff。用 defaultBranch 空串判据跳过（该判据依赖
   `apps/server/src/hub.ts:299` 的空串回落行为，改动时保持一致）。
4. **项目/工作区删除的级联都按 projectId 过滤**（web 侧
   `packages/client/src/store.ts:422-424`，server 同构）：projectId 为空使目录
   工作区天然免疫项目级联——不要为它发明伪 project，否则破坏此免疫。
5. **改协议必须 Rust/TS 两侧生成物一致提交**（proto 是唯一真相源，
   `proto/coflux/v1/common.proto:1-4`），黑盒测试会抓线格式漂移。
6. 黑盒测试本机跑必须 `COFLUX_TEST_PG_URL` 指 54322 直连口（5432 是 supavisor
   会报 tenant 错）；新测试文件端口须选未占用端口（见各 `*.test.mjs` 顶部惯例）。

## Scope

In scope:

- `proto/coflux/v1/client.proto`（新消息）及 `buf generate` 生成物
  （`packages/protocol/src/gen/`、`crates/protocol/src/gen/`、Swift 生成物若同链自动产出则一并提交）
- `apps/server/src/hub.ts`、`apps/server/src/store.ts`（创建/删除分支；DDL 预期零改动）
- `crates/worker/src/main.rs`（轮询跳过判据）
- `packages/client/src/`（store/协议 client 的消息发送与状态）
- `apps/web/src/components/workbench/`（侧栏、选设备对话框、终端视图）
- `tests/src/`（新黑盒用例）
- `plans/README.md`

Out of scope:

- `crates/supervisor/` — 绝对路径方案下无需改动，且升级成本高（Landmine 1）
- `apps/mobile/` 功能适配 — 已冻结，仅保证构建不坏
- 「任意目录开终端」（目录浏览步）— 用户已选一步到位 HOME；将来另立 plan
- push / PR / 发版

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| daemon 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| 黑盒集成测试 | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| UI 走查 (acceptance) | 用户人工验证（用户既定约定：前端改动不做 Claude 走查） | 用户确认 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 新黑盒用例覆盖：创建（projectId 空 + path 正确 + task 同建）、session cwd
      为传入 HOME 路径、删除不触发 worktree 操作。
- [ ] 侧栏新按钮 → 选设备 → 自动出现在「终端」分组并跳转，终端打开即在 HOME。
- [ ] 目录工作区视图无 tab 栏、无变更 tab、无新建终端按钮；git 类 UI 不出现。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（尤其发现必须改 supervisor 才能达成 cwd 语义时）.
- A validation command fails twice after one reasonable fix.
- 发现 `FsListed.path` 在 `browse_home` 请求下并不回传绝对路径（方案基石假设为假）。

## Maintenance notes

- `projectId === ""` 是目录工作区的唯一判据，谓词收敛在各端一处；未来若引入第二种
  非 git 工作区形态，再升级为显式 kind 字段，届时迁移成本仅为"空串 → 枚举默认值"。
- daemon 的"defaultBranch 空 → 跳过 git 轮询"与 server 清单下发的空串回落
  （`hub.ts:299`）是一对隐式契约，两侧改动需同步审视。
