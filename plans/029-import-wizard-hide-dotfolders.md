# Plan 029: 导入向导浏览步默认隐藏点开头文件夹 + header 开关

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8d7ca3b..HEAD -- apps/web/src/components/workbench/import-project-wizard.tsx`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `8d7ca3b`, 2026-07-23

## Requirement

导入项目两步向导（选设备 → 浏览文件夹）的浏览步目前展示全部子目录，包括 `.` 开头的隐藏文件夹（`.git`、`.cache` 等），列表噪音大。改为：

1. 默认隐藏 `.` 开头的文件夹。
2. Dialog header 提供 Switch 开关「显示隐藏项」，打开后展示全部；开关仅在浏览步（browse）显示，选设备步（device）header 保持现状（只有步骤文案）。
3. 开关不持久化：每次打开对话框重置为隐藏（默认 false）。
4. 小增强：路径栏过滤词以 `.` 开头时（如输 `.c` 找 `.config`），即使开关关闭也临时放行隐藏目录参与匹配，与 VSCode quick-open 行为一致；清空过滤词后恢复隐藏。

正确解 vs 相邻错误解：过滤必须发生在前端已加载的 entries 上，切换开关或输入 `.` 前缀过滤词**不得触发重新请求目录**；隐藏的判定对象是目录名（entry.name），不是完整路径。

## Decisions & tradeoffs

- **过滤位置**：前端 `filteredEntries` useMemo 内完成。Rejected: 在 `loadDirectory` 的 `setEntries` 处过滤 — 会导致切换开关时数据已丢失、需重新请求。
  Based on: `loadDirectory` 一次性拿全所有子目录，`apps/web/src/components/workbench/import-project-wizard.tsx:137`；现有文本过滤挂点在 `filteredEntries`，同文件 `:78-82`。
- **开关组件**：Astryx `Switch`（`@astryxdesign/core/Switch`），label「显示隐藏项」。Rejected: CheckboxInput — Switch 语义是「立即生效的偏好」，与本场景匹配（Astryx 文档明确此分工）。header 空间有限，可用 `isLabelHidden` 以外的紧凑布局手段（如小号文案），但 label 必须可见或可访问。
- **开关位置**：`DialogHeader` 的 `endContent`，browse 步渲染 Switch + 原步骤文案「第 2 步（共 2 步）」，device 步仅原步骤文案。Rejected: 放路径栏或 footer — 用户明确要求 header。
  Based on: `endContent` 现渲染 stepLabel，`import-project-wizard.tsx:285-294`。
- **状态生命周期**：`showHidden` useState 默认 false，在 `props.open` 重置 effect 中一并重置。Rejected: localStorage 持久化 — 会话级足够，需要时再加。
  Based on: 打开时统一重置各 state 的 effect，`import-project-wizard.tsx:86-99`。
- **`.` 前缀过滤词临时放行**：`showHidden || pathFilter 去空格后以 "." 开头` 即展示隐藏目录。Rejected: 严格遵守开关 — 已与用户确认要做此增强。
- **旧注释更新**：`import-project-wizard.tsx:136` 注释「与 Cursor 一致：展示全部子目录（含隐藏）」声明的行为不再成立，必须改写为新行为的描述。

## Direction

单文件改动，React 19 + Astryx 组件，遵循文件内既有代码风格（中文注释、函数组件 + hooks）。

### Milestone 1: 默认隐藏 + header 开关 + `.` 前缀放行

浏览步默认不显示 `.` 开头文件夹；header 开关可切换；过滤词以 `.` 开头时临时放行；重新打开对话框后开关回到关闭。键盘高亮（highlight）与列表长度计算基于过滤后的列表，现有逻辑复用 `filteredEntries` 即自动正确，勿另起列表变量。

Validation: `pnpm -C apps/web exec tsc -b` -> exit 0。

## Landmines

- `highlight`/`listLength`/Tab 补全/Enter 进入均以 `filteredEntries` 为索引源（`import-project-wizard.tsx:84,181,210,228`）。隐藏过滤必须并入同一个 `filteredEntries`，若另设一个列表变量会造成键盘选择与渲染错位。
- `DialogHeader` 的 `endContent` 内放交互控件时注意不要吞掉 Dialog 的关闭按钮点击区域；Switch 的 `onChange` 不应触发对话框关闭或 step 变化。

## Scope

In scope:
- `apps/web/src/components/workbench/import-project-wizard.tsx`

Out of scope:
- daemon / server 侧 FsList 协议与实现 — 过滤纯前端完成
- 文件（非文件夹）展示逻辑 — 向导本就只列目录
- 偏好持久化（localStorage）— 已决策不做

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/web exec tsc -b` | exit 0 |
| Build (acceptance) | `pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 浏览步默认不显示 `.` 开头文件夹；开关打开后显示；过滤词以 `.` 开头时临时显示；重开对话框开关重置为关。
- [ ] device 步 header 无开关，browse 步 header 有开关且步骤文案保留。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Astryx Switch 无法在 header endContent 中以合理尺寸渲染（需换组件时停下报告）。

## Maintenance notes

隐藏项判定是 `name.startsWith(".")`，仅覆盖 Unix 惯例；Windows hidden 属性不在本计划范围（daemon 未上报该属性）。若未来需要持久化偏好，参考 plan 021 的 localStorage 模式。
