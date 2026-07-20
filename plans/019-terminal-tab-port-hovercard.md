# Plan 019: 终端 tab 端口转发展示 —— icon + HoverCard 悬浮跳转

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5465ab8..HEAD -- apps/web/src/components/workbench/workspace-terminal.tsx`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none
- Category: dx
- Execution: subagent sonnet
- Planned at: `5465ab8`, 2026-07-20

## Requirement

终端 tab 现在把监听端口直接以 `:3000` 文本拼在标题后（`workspace-terminal.tsx:439`），且**只显示第一个端口**（`taskPorts[0]`），多端口时其余不可见、无跳转入口。

完成后：当某终端存在端口预览（`taskPorts.length > 0`）时，tab 上不再显示裸端口号文本，改为一个 `PlugZap` 图标作为"存在端口转发"的聚合指示；鼠标 hover 该图标弹出一张 HoverCard 面板，面板内**每个端口一行**，含端口号 + 可点击打开预览 URL 的链接（新标签页）。无端口时 tab 与现状一致（不渲染任何端口元素）。

正确解与相邻错误解的分界：
- 图标必须在**单端口和多端口时都只是 HoverCard 的锚点**——不得给单端口加"点图标直接跳转"的特例（交互统一）。
- 面板里链接必须真的可点击跳转（这是选 HoverCard 而非 Tooltip 的唯一理由）。
- 顶栏右侧现有的端口链接列表（`:463-478`）**保持不动**——本 plan 不碰它，活动 tab 短期两处都显示端口是已接受的取舍。

## Decisions & tradeoffs

- **面板组件用 Astryx `HoverCard`，不用 `Tooltip`**：HoverCard 的 content 是可交互浮层（`hideDelay` 默认 200ms，鼠标可从锚点移入面板点击链接）。Rejected: `Tooltip` —— 其源码定位为 "short, non-interactive text" 且 "Don't stay open when hovering the tooltip content"，鼠标移向面板即关闭，点不到链接，与"快捷跳转"需求直接冲突。Based on: `@astryxdesign/core/dist/Tooltip/useTooltip.d.ts` 类注释、`@astryxdesign/core/dist/HoverCard/HoverCard.d.ts:92`（"interactive content on hover"）。两者 API 同构：`<HoverCard content={<面板>} placement="below">{trigger}</HoverCard>`。
- **图标用 lucide-react `PlugZap`**：用户既定选择。Rejected: Globe/Radio/Network —— 用户在 explore 阶段明确选 PlugZap。Based on: 同文件已从 `lucide-react` 导入图标（`workspace-terminal.tsx:4`），追加 `PlugZap` 即可。
- **图标仅作锚点，交互对单/多端口统一**：不给单端口做直跳特例，也不在 tab 上加数字角标。Rejected: 单端口直跳 + 多端口面板的分支交互 —— 增加分支且行为不一致，无收益。Based on: 需求约定。
- **面板每行链接沿用顶栏 `:466-475` 的样式与语义**：`<a href={preview.url} target="_blank" rel="noreferrer">` + 端口号 + 图标，等宽小字。Rejected: 复制 URL、iframe 内嵌预览 —— 超出本次范围。Based on: `workspace-terminal.tsx:463-478` 已是现成范式。
- **顶栏端口链接列表保留**：本 plan scope 只含 tab（`:439` 那段）。Based on: explore 阶段 departure check 选定"保留顶栏 + tab 加 icon"。
- **跟随本文件既有 DOM+Tailwind 模式，不强行 Astryx 化**（decided while planning）：本文件通篇用 `div`/`button`/`a` + Tailwind token 类（如 `text-muted-foreground`、`bg-accent`），HoverCard 面板内容照此写。Rejected: 按 `apps/web/.claude/CLAUDE.md` 的 "No <div>" 全 Astryx 布局 —— 与本文件既有约定不符，会引入不一致。Based on: `workspace-terminal.tsx:413-478` 全是 div/button/a + Tailwind。

## Direction

单文件改动，仅 `apps/web/src/components/workbench/workspace-terminal.tsx`。

数据无需改动：`taskPorts = ports[task.id] ?? []`（`:417`）已在渲染作用域内，每项 `PortPreview = { port, url }` 含现成 URL。

### Milestone 1: tab 端口文本替换为 PlugZap + HoverCard

`workspace-terminal.tsx:439` 的 `<span>:{taskPorts[0].port}</span>` 替换为：`taskPorts.length > 0` 时渲染一个 `PlugZap` 图标触发的 `HoverCard`，面板内 `taskPorts.map` 每端口一行 = 端口号 + 打开 `preview.url` 的 `<a target="_blank" rel="noreferrer">`。无端口时不渲染任何端口元素。顶栏 `:463-478` 不动。

验证：`pnpm --filter @coflux/web build` -> exit 0（`tsc -b` 通过即类型无误）。

## Landmines

- **触发器不能嵌在标题 button 内**：tab 标题是 `<button>`（`workspace-terminal.tsx:426-440`）。HoverCard 的 trigger 应是可聚焦元素（图标建议包一层 `button`/`span`），若把它塞进标题 button 内会形成 button 套交互元素 / 嵌套可交互控件，是非法 HTML 且事件冲突。正确落点：把 HoverCard 作为 tab 容器 `div`（`:419`）的直接子元素，位于标题 button（`:440` 收尾）与关闭按钮 `Tooltip`（`:441`）之间——参照关闭按钮的兄弟位置。
- **`HoverCard` 需从 `@astryxdesign/core/HoverCard` 导入**（与 `Tooltip` 同源不同子路径，见 `:8` 的 `Tooltip` 导入写法 `@astryxdesign/core/Tooltip`）。
- HoverCard 默认 `placement='above'`；tab 在顶栏、面板应向下弹，用 `placement="below"`（与同文件 Tooltip 用法一致，如 `:441`）。

## Scope

In scope:
- `apps/web/src/components/workbench/workspace-terminal.tsx`

Out of scope:
- `workspace-terminal.tsx:463-478`（顶栏端口链接列表）—— 明确保留不动
- `apps/web/src/client/store.ts`、协议层 —— 端口数据模型无需改动
- 设备左下角"汇总所有转发端口"—— 另立 plan，数据源与落点不同

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| UI 验收 (acceptance) | 启动 `pnpm dev:web`，打开一个有监听端口的终端 tab | tab 显示 PlugZap 图标（无裸端口号）；hover 弹面板列全部端口；点面板内链接在新标签打开预览 URL；无端口的 tab 无端口元素 |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` 通过（exit 0）。
- [ ] 有端口的 tab 显示 PlugZap 图标而非 `:端口号` 文本；hover 展开 HoverCard 面板，列出**全部**端口（不再只显第一个），每行链接可点击在新标签打开 `preview.url`。
- [ ] 无端口的 tab 不渲染任何端口相关元素。
- [ ] 顶栏 `:463-478` 端口链接列表未被改动。
- [ ] 单端口与多端口交互一致（图标均只作 HoverCard 锚点，无直跳特例）。
- [ ] 未改动 scope 外文件。
- [ ] `plans/README.md` status 已更新。

## STOP conditions

- `@astryxdesign/core/HoverCard` 不存在或 content 不支持交互内容（与 Decisions 所据事实冲突）。
- 实现该外观需改动 scope 外文件。
- `pnpm --filter @coflux/web build` 一次合理修复后仍失败两次。

## Maintenance notes

- 若后续要收敛"顶栏链接 vs tab 面板"的重复展示，改动落点是顶栏 `:463-478`，本 plan 的 tab 面板可作为唯一入口保留。
- 设备级"汇总所有转发端口在左下角设备区"是解耦的下一步：跨 task 聚合 `ports`（`store.ts:33`）、落点在设备侧边组件，与本 plan 无共享文件。
