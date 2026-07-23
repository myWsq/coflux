# Plan 030: web 简单移动端适配 —— 手机上可正常使用现有全部功能

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 096812c..HEAD -- apps/web/`

## Status

> **WITHDRAWN 2026-07-23**：写完并派发执行后方向变更——移动端不做桌面 web 的响应式
> 适配，改为独立的精简随身端 app（按移动场景单独设计，功能面为桌面子集）。本计划
> 未产生任何提交；其中的调研结论（iOS 长按不触发 contextmenu、visualViewport 键盘
> 兜底、Astryx MobileNav 可脱离 AppShell 受控使用）对新移动端计划仍然有效。

- Priority: P1
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `096812c`, 2026-07-23

## Requirement

web 客户端目前是纯桌面假设：根布局硬编码 `min-w-[1024px] min-h-[640px]`，Sidebar
常驻左栏，大量操作只能通过 hover 或右键触达。手机浏览器（iOS Safari / Android
Chrome，视口宽 ~390px）打开只能看到左上角一块，基本不可用。

完成后：手机上能**正常使用当前全部功能**——登录、抽屉式侧栏（项目/工作区/设备的
全部操作，含仅在右键菜单里的重命名/移除）、终端输入输出与 Tab 操作、变更 diff
视图、导入向导、各对话框、软键盘弹出时正在输入的终端行不被遮挡。桌面端
（≥768px）布局与行为与现状一致——本计划不改桌面体验。

「简单适配」的边界：让现有功能在手机上可用、不难用；不做移动端专属交互重设计
（手势、底部导航、终端字号方案等）。正确解与相邻错误解的分界：错误解是只把页面
「塞进」小屏（缩放/横向滚动仍在、hover-only 操作仍触达不了）；正确解是每个现有
功能在触屏上都有可达的入口且视口尺寸正确。

## Decisions & tradeoffs

- **断点策略**：单断点 768px，用 Tailwind `md:` 变体——`<md` 为移动布局，`≥md`
  与现状逐像素一致（现有 `min-w-[1024px]`/`min-h-[640px]` 改为 `md:` 前缀保留，
  不是删除）。Rejected: 多断点渐进适配 —— 「简单适配」不需要平板中间态，双分支
  最低熵。Based on: `apps/web/src/components/workbench/workbench.tsx:233`（根布局
  `flex h-screen min-h-[640px] min-w-[1024px]`；同文件 208 行 authenticating
  分支还有一处 `h-screen min-w-[1024px]` 同样要处理）。
- **Sidebar 移动形态**：`<md` 时不渲染常驻 `<aside>`，改用 Astryx `MobileNav`
  受控抽屉（`isOpen`/`onOpenChange` 外部受控，不依赖 AppShell；children 接受任意
  ReactNode），复用现有 Sidebar 内容；移动端不渲染拖宽 handle（抽屉宽度用
  MobileNav `width`，默认 320 且自动 cap 85vw）。选中工作区后自动关抽屉。断点判定
  可用 Astryx `useMediaQuery` hook。Rejected: 自写抽屉/底部导航 —— 组件库现成，
  且底部导航改变桌面/移动信息结构一致性。Based on:
  `apps/web/src/components/workbench/sidebar.tsx:182-184`（`<aside>` 常驻 +
  `style={{width}}`）、419-434（拖宽 handle）；MobileNav API 见
  `pnpm exec astryx component MobileNav`。
- **抽屉入口（汉堡按钮）**：`<md` 时在主区顶栏（WorkspaceTerminal header）最左侧
  加汉堡按钮；「无选中工作区」的空状态页（workbench.tsx:276-291）没有顶栏，也必须
  有可达的抽屉入口（具体摆放执行者自决）。约束：主界面任何状态下抽屉都能打开。
  Based on: `apps/web/src/components/workbench/workspace-terminal.tsx:433`（顶栏
  `<header>` 是唯一常驻横栏）。
- **视口高度**：两处 `h-screen`（workbench 根、sidebar aside）改 `h-dvh`；同时
  viewport meta 加 `interactive-widget=resizes-content`（Android Chrome 键盘压缩
  布局视口）；iOS Safari 不支持该属性，用 `visualViewport` `resize` 监听把根容器
  高度钳到 `visualViewport.height`（约 10–15 行，键盘收起恢复；桌面上该监听不产生
  行为变化即可，无需按平台分支）。终端随容器变矮由既有 ResizeObserver 自动
  refit，无需额外处理。Rejected: 只加 meta 不做 iOS 兜底 —— 手机用终端输入是核心
  场景，输入行被键盘盖住等于不可用（已与用户确认投入）。Based on:
  `apps/web/index.html:6`（现有 viewport meta）、
  `apps/web/src/components/workbench/terminal-pane.tsx:385-387`（ResizeObserver
  fit）。
- **hover-reveal 按钮触屏可达**：所有 `opacity-0 group-hover:opacity-100` 类的
  行内按钮（sidebar 工作区删除、设备移除、项目行 + 号、终端 Tab 关闭）在粗指针
  设备上常显，用 Tailwind v4 `pointer-coarse:opacity-100`（项目 tailwindcss
  ^4.3.2 支持）。Rejected: JS 检测 touch —— CSS 变体零运行时成本。Based on:
  `apps/web/src/components/workbench/sidebar.tsx:345`、`sidebar.tsx:407`、
  `workspace-terminal.tsx:518`。
- **ContextMenu-only 动作的触屏替代**：sidebar 三类行里仅存在于右键菜单的动作
  （项目行「移除项目」、工作区行「重命名」、设备行「重命名」）在粗指针设备上
  需要可见入口：行内加省略号按钮（`pointer-coarse` 下显示）打开 Astryx
  `DropdownMenu`，菜单项与对应 ContextMenu 完全一致。Rejected: 依赖长按触发
  contextmenu —— iOS Safari 长按不派发 `contextmenu` 事件（见 Landmines）。
  Based on: `apps/web/src/components/workbench/sidebar.tsx:217-224`、279-288、
  387-395（三处 ContextMenu items 定义）。
- **对话框/向导窄屏自适应**：Astryx Dialog `width` 接受 CSS 字符串，所有固定
  px 宽度（dialogs.tsx 的 400/400/480/380/400，import-project-wizard.tsx 的
  520）改为 `min(<原值>px, calc(100vw - 32px))` 形式，其余不动。Rejected:
  fullscreen variant —— 内容量不需要，改动面更大。Based on:
  `apps/web/src/components/workbench/dialogs.tsx:40,105,183,268,294`、
  `apps/web/src/components/workbench/import-project-wizard.tsx:287`；Dialog
  `width: number | string` 见 `pnpm exec astryx component Dialog`。
- **错误 toast 窄屏不溢出** (decided while planning)：`fixed bottom-4 right-4
  max-w-md`（workbench.tsx:302）在 390px 视口会超宽，补 `left-4 sm:left-auto`
  一类约束即可。
- **不做**：终端字号/手势优化、快捷键系统的移动端形态（无硬件键盘时快捷键自然
  no-op，提示文案是否在触屏隐藏属执行者自决的 minor polish）、桌面端任何布局
  变化、变更视图重排（其纵向流式 + hunk `overflow-x-auto` 已天然可用，见
  `changes-view.tsx:166-214`）。

## Direction

React 19 + Tailwind v4 + Astryx 组件库。样式层面优先 Tailwind 响应式/交互变体
（`md:`、`pointer-coarse:`），组件层面优先 Astryx 现成件（MobileNav、
DropdownMenu、useMediaQuery），只有 iOS visualViewport 兜底需要少量命令式代码。
桌面回归风险控制在「所有移动改动都挂在 `<md` / `pointer-coarse` 条件下」。

### Milestone 1: 视口与根布局

手机视口下无横向滚动、页面高度正确；桌面（≥768px）保持 `min-w-[1024px]` 行为。
含：两处 h-screen → h-dvh、两处 min-w/min-h 加 `md:` 前缀、viewport meta、
iOS visualViewport 兜底。Validation: `pnpm --filter @coflux/web build` → exit 0。

### Milestone 2: Sidebar 抽屉化

`<md` 时 Sidebar 变 MobileNav 抽屉，汉堡入口在顶栏与空状态页均可达，选中工作区
自动关抽屉；`≥md` 常驻 aside + 拖宽行为不变。Validation: 同上 build 通过。

### Milestone 3: 触屏操作可达

hover-reveal 按钮 `pointer-coarse` 常显；三类行的 ContextMenu-only 动作有省略号
DropdownMenu 替代入口。Validation: 同上 build 通过。

### Milestone 4: 对话框/向导/toast 窄屏自适应

六处 Dialog 宽度 min() 封顶、错误 toast 不溢出。Validation: 同上 build 通过。

## Landmines

- iOS Safari 长按**不触发** `contextmenu` 事件（Android Chrome 会），所以
  ContextMenu 在 iOS 触屏上完全不可达——不要试图靠长按解决触屏入口问题。
- `terminal-pane.tsx:240-252`：隐藏实例尺寸为 0 时 fit 被刻意 no-op（防 2×1 钳制
  污染远程 PTY）。visualViewport 压缩高度走 ResizeObserver 正常 refit，不受影响；
  但不要用 `display:none` 之类隐藏可见终端来实现布局切换，会踩这个保护逻辑。
- `sidebar.tsx:419-434` 拖宽 handle 带 pointer capture 与全局 cursor 副作用，
  移动分支直接不渲染它，而不是试图禁用。
- Astryx `MobileNavToggle` 只能在 AppShell 上下文内用（本项目没用 AppShell），
  汉堡按钮要自己写普通 button 控制受控 `isOpen`。
- `workbench.tsx` 有两处独立的 `h-screen min-w-[1024px]`（208 行 authenticating
  分支、233 行主布局），漏掉前者会导致刷新瞬间闪横向滚动。
- 终端保活机制（workbench.tsx:258-273 的 `contents`/`hidden` 切换、
  workspace-terminal 的 attach 状态机）与本计划无关，不要动它的显隐结构。

## Scope

In scope:

- `apps/web/index.html`
- `apps/web/src/index.css`
- `apps/web/src/components/workbench/workbench.tsx`
- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/terminal-pane.tsx`
- `apps/web/src/components/workbench/dialogs.tsx`
- `apps/web/src/components/workbench/import-project-wizard.tsx`
- `apps/web/src/components/workbench/changes-view.tsx`（仅必要小改）

Out of scope:

- `apps/server`、`crates/`、`packages/protocol` —— 纯前端布局适配，不涉及协议与服务端
- 桌面端（≥768px）任何可见行为变化 —— 本计划的回归红线
- 终端字号/手势/移动端专属交互设计 —— 「简单适配」边界外，后续计划再做

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| 移动端 UI 验收 (acceptance) | Playwright MCP，390×844 触屏视口过主流程：登录 → 抽屉选工作区 → 终端 Tab 增删切 → 触屏入口（重命名/移除）→ 变更视图 → 导入向导/对话框 | 各功能可达可用，无横向滚动 |
| 桌面回归 (acceptance) | Playwright MCP，1440×900 视口对照现状 | 布局与现状一致 |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` 通过。
- [ ] 390px 视口：无横向滚动；侧栏经抽屉可达且功能完整（含重命名/移除等
      ContextMenu-only 动作）；终端 Tab 的新建/切换/关闭可触达；对话框与导入
      向导不溢出视口。
- [ ] ≥768px 视口：布局与行为与基线一致（含 min-w-[1024px] 行为与拖宽）。
- [ ] viewport meta 含 `interactive-widget=resizes-content`；iOS visualViewport
      兜底代码存在且桌面无行为变化。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Astryx MobileNav 无法脱离 AppShell 受控使用（与 component docs 矛盾）。

## Maintenance notes

- 移动分支全部挂在 `md:` / `pointer-coarse:` 条件下，review 时以「桌面 diff 为
  零行为变化」为红线。
- web 无单测基建，本计划验证依赖 build + Playwright 验收；后续若引入组件测试，
  抽屉开合与 visualViewport 逻辑是首批候选。
- xterm.js 移动端 IME/软键盘输入质量是上游能力边界（参见 terminal-pane.tsx 顶部
  的 IME workaround 注释），本计划只保证「输入行可见、输入可送达」。
