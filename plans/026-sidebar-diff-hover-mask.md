# Plan 026: 侧边栏工作区行右端内容 hover 遮罩统一 + diff 数字固定行末

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat aa514dd..HEAD -- apps/web/src/components/workbench/sidebar.tsx`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `aa514dd`, 2026-07-23

## Requirement

侧边栏工作区行 hover 时，右端绝对定位的删除按钮（X，约占行末 24px）会直接
压在 diff 统计数字（+X −Y）上，没有任何淡出过渡——用户看到 "−2" 被按钮遮住。
既有的 hover 渐变遮罩（`mask-image:linear-gradient` 从右侧淡出）只挂在
「自定义名称」span 上；plan 024（f2ac56b）新增的 diff 统计 span 插在名称
左侧且没有复用遮罩，工作区无自定义名称时 diff 成为行末元素、裸露在按钮下。

另一处用户明确要求的行为变化：diff 统计数字应固定在行内容最末（最右端），
即顺序从当前的 `branch 名 → diff 统计 → 自定义名称` 调整为
`branch 名 → 自定义名称 → diff 统计`。

完成后为真：

1. 工作区行右端内容（自定义名称 + diff 统计）在非 main 工作区 hover 时统一
   从右侧渐变淡出，为删除按钮让位；不 hover 时完整显示。
2. diff 统计（存在时）位于行内容最末，自定义名称（存在时）在它左侧。
3. main 工作区（无删除按钮）hover 时右端内容不淡出，行为与现状一致。

## Decisions & tradeoffs

- **遮罩挂载点**: 用一个包裹「自定义名称 + diff 统计」两个 span 的右端容器
  承载 hover 渐变遮罩，原名称 span 上的遮罩类移除。Rejected: 给 diff span
  单独复制一份遮罩类 —— 两处重复，且名称很短时按钮仍会压到未遮罩的相邻
  元素边缘。Based on: 现有遮罩类只在名称 span 上，
  `apps/web/src/components/workbench/sidebar.tsx:325-330`；删除按钮为绝对
  定位 `right-1` + `size-5`，`sidebar.tsx:340-346`。
- **元素顺序**: diff 统计移到自定义名称之后，成为行内容最末元素（用户
  mid-turn 明确指令）。Rejected: 维持现状（diff 在名称左侧）—— 用户要求
  diff 数字固定在最后。Based on: 当前顺序 diff 在前、名称在后，
  `sidebar.tsx:305-336`。
- **遮罩仅对非 main 工作区生效**: 保持现有 `!workspace.isMain` 条件——main
  工作区不渲染删除按钮，无让位需求。Based on: 删除按钮的渲染条件
  `sidebar.tsx:339`，现有遮罩条件 `sidebar.tsx:328`。
- **渐变参数沿用现值**: `linear-gradient(to_left,transparent_18px,black_44px)`
  已按按钮占位（right-1 + 20px）调校，不重新设计。Based on:
  `sidebar.tsx:329`。

## Direction

单文件 JSX/className 调整，无数据流、无协议、无状态变化。包裹容器需保持
现有 flex 布局语义：branch 名 `min-w-0 flex-1 truncate` 占据剩余宽度，右端
容器整体 shrink-0（内部名称仍 `max-w-24 truncate`），不得引起行高或对齐
变化（行高 h-7，按钮垂直居中）。

### Milestone 1: 右端容器 + 遮罩迁移 + 顺序调整

工作区行 JSX 中「自定义名称」与「diff 统计」两个 span 被一个容器包裹，
顺序为名称在前、diff 在后；hover 渐变遮罩类从名称 span 移至该容器，条件
仍为 `!workspace.isMain`。Validation:
`pnpm --filter @coflux/web exec tsc -b` -> exit 0。

## Landmines

- 名称 span 由 IIFE 条件渲染（label 可能为 null），diff span 由
  additions/deletions > 0 条件渲染，`sidebar.tsx:306-336`——两者都可能
  不存在。容器在两者皆空时不应留下多余间距（两个条件都 falsy 时最好不
  渲染容器，或确保空容器无宽度）。
- 名称 span 与 diff span 之间目前靠外层 button 的 `gap-2` 分隔
  （`sidebar.tsx:299`）；包裹后外层 gap 不再作用于两者之间，容器内需自行
  处理间距（如容器内 gap），注意别让视觉密度与现状偏差过大。
- mask-image 是任意值 Tailwind 类，下划线转空格语法
  （`[mask-image:linear-gradient(to_left,...)]`）照抄时注意保持转义正确。

## Scope

In scope:

- `apps/web/src/components/workbench/sidebar.tsx`

Out of scope:

- `apps/web/src/components/workbench/workspace-terminal.tsx` 顶栏的 diff
  展示 —— 无遮罩问题，不动。
- daemon/server/proto 的 diff 统计链路 —— 纯展示层问题。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm --filter @coflux/web exec tsc -b` | exit 0 |
| Build (acceptance) | `pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 非 main 工作区 hover 时右端内容（名称 + diff）从右侧渐变淡出，删除按钮不再生压数字。
- [ ] diff 统计存在时位于行内容最末，自定义名称在其左侧。
- [ ] main 工作区行为不变（无遮罩、无删除按钮）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

今后向工作区行右端追加任何元素（图标、计数等）时放进该右端容器内，遮罩
自动覆盖；放在容器外会重现本 bug。
