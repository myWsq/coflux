# Plan 015: web 端全局快捷键（Cmd+Ctrl 前缀）+ 帮助面板

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat a0657e7..HEAD -- apps/web/src/components/workbench apps/web/src/config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `a0657e7`, 2026-07-20

## Requirement

roadmap（docs/ROADMAP.md「快捷键支持」）：web 工作台的高频操作目前全靠鼠标，
焦点又几乎永远在 xterm 终端里，来回移动手是主要摩擦。完成后：

- `Cmd+Ctrl+T`：在当前工作区新建终端
- `Cmd+Ctrl+W`：关闭当前终端 Tab（RUNNING 任务仍走现有确认对话框，不静默杀）
- `Cmd+Ctrl+1..9`：切到当前工作区第 N 个终端 Tab（顺序 = Tab 栏顺序，即 createdAt 升序）
- `Cmd+Ctrl+[` / `Cmd+Ctrl+]`：上一个 / 下一个终端 Tab（不越界循环与否是 executor 的 call，二选一保持一致即可）
- `Cmd+Ctrl+N`：弹出当前选中工作区所属项目的「新建工作区」BranchMenu
- `Cmd+/`：快捷键帮助浮层（列全部键位；Esc 或再按一次关闭）
- 快捷键在焦点位于终端内时照常生效，且被拦截的组合键**不会**下发给远端 shell
- 无对应目标时安静忽略（如无选中工作区按 Cmd+Ctrl+T、数字越界、无任务时 Cmd+Ctrl+W）

明确不做：工作区切换快捷键（用户否决）；PWA / Keyboard Lock 增强；快捷键自定义。

正确性的分界：一个"相邻的错误实现"是把监听挂在每个 xterm 的
`attachCustomKeyEventHandler` 上、或让非 active 的保活 WorkspaceTerminal 实例
也响应快捷键（见 Landmines）。

## Decisions & tradeoffs

- **键位 = 统一 `Cmd+Ctrl` 前缀**：用户在探索阶段拍板。Rejected: Cmd 单修饰
  / Cmd+Shift / Ctrl+Shift — `Cmd+W/T/N/1-9`、`Cmd+Shift+W/T/N/[/]/3/4/5` 是
  浏览器/系统硬保留键，浏览器 chrome 层先于 DOM 处理，preventDefault 无效，
  网页物理上收不到或拦不住；Ctrl+Shift 拦截失效时会退化成 Ctrl+字母误伤
  shell（Ctrl+W 删词）。Cmd+Ctrl 是 macOS 上唯一浏览器与系统都未占用的修饰组合。
  此决策已与用户确认过三轮（含 PWA 路线否决），不得改键位。
- **拦截层 = 单一 window 级 capture keydown，挂在 Workbench**：capture 阶段
  先于 xterm textarea 的 target 阶段，`preventDefault() + stopPropagation()`
  即可拦在 shell 之前。Rejected: 每个 xterm 挂 `attachCustomKeyEventHandler`
  — 多实例重复注册、且覆盖不了焦点在终端外的情况。
  Based on: 现有唯一键盘监听先例 `apps/web/src/components/workbench/import-project-wizard.tsx:259`
  （window keydown 模式）；xterm 实例创建在 `terminal-pane.tsx:117`。
- **修饰键判定 = `event.metaKey && event.ctrlKey`，不做平台分支** (decided
  while planning)：产品自用、用户是 macOS；Windows/Linux 上等价于
  Win/Super+Ctrl 组合，能用但不刻意适配。Rejected: 按 platform 映射两套键位
  — 无用户，纯投机复杂度。
- **`[` / `]` 用 `event.code`（BracketLeft/BracketRight）判定** (decided while
  planning)：`event.key` 随键盘布局漂移。数字键同理可用 code Digit1..9 或
  key 判定，executor 的 call，但需对非 QWERTY 布局无致命误伤即可。
- **Cmd+Ctrl+W 复用现有确认链路**：调用 Workbench 已有的
  `requestCloseTask`（`workbench.tsx:150`，RUNNING 走 ConfirmActionDialog，
  非 RUNNING 直接关）。Rejected: 快捷键直接 `closeTaskNow` — 破坏"运行中的
  shell 不被无确认杀掉"的既有安全语义。
- **Cmd+Ctrl+N 复用 sidebar 受控 BranchMenu**：`sidebar.tsx` 的
  `createMenuProjectId` 受控状态已存在（`sidebar.tsx:106,151-152`），快捷键把
  它设为当前选中工作区的 projectId 即弹出菜单。Rejected: 为快捷键另做一个
  新建工作区对话框 — 重复交互面、双份分支列表逻辑。桥接该状态需要把它提升
  到 Workbench 或经 ref/回调暴露，具体形态 executor 依现有 props 流设计。
- **动作桥接方向 = WorkspaceTerminal 向上暴露命令**：`requestActivation` /
  `createTerminal` 是 active 工作区实例的内部函数
  （`workspace-terminal.tsx:158,236`），需以某种形式（如 onReady 回调注册
  imperative handle / 提升回调）让 Workbench 的全局监听调用到 **active 实例**
  的这两个动作。具体机制 executor 设计，约束只有一条：非 active 的保活实例
  绝不能响应（见 Landmines）。
- **帮助面板 = 简单浮层组件，键位表硬编码**：参考 `dialogs.tsx` 现有对话框
  模式与 Astryx 组件（apps/web/.claude/CLAUDE.md）。Rejected: 键位注册表
  抽象/配置化 — 6 个快捷键不值得一层注册框架，硬编码一个 handler + 一份
  展示表即可。

## Direction

单里程碑即可交付；实现自然分两块：全局 keydown 分发 + 帮助浮层。

### Milestone 1: 快捷键全量生效 + 帮助面板

上述 Requirement 列表全部为真；被拦截组合不泄漏进终端；类型检查绿。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0。

## Landmines

- **WorkspaceTerminal 是 keep-alive 多实例**：访问过的工作区隐藏不卸载
  （`workbench.tsx:32,224-234`，`display:hidden` 包裹）。全局快捷键若广播给
  所有实例，隐藏实例会在 0 尺寸下 fit/attach 造成 2×1 重排（见
  `terminal-pane.tsx:166-178` 的防御注释）。只有 `active` 的实例可响应。
- **xterm 吞键**：焦点在终端时 keydown 的 target 是 xterm 的隐藏 textarea；
  必须在 window capture 阶段拦截并 `stopPropagation`，否则组合键经 xterm 编码
  下发 PTY（`terminal-pane.tsx:196-199` 的 onData 通道）。
- **对话框叠加**：ConfirmActionDialog 打开期间再按 Cmd+Ctrl+W 会覆盖
  `confirmAction` 状态（`workbench.tsx:36,155`）。executor 需保证不产生叠加
  混乱（禁用或幂等皆可）。
- **`requestActivation` 有 force-claim 语义**：第二参数 `forceClaim` 用于
  detached 重接管（`workspace-terminal.tsx:158`）；Tab 栏点击传
  `state === "detached"`（`workspace-terminal.tsx:390`）。快捷键切 Tab 应与
  点击行为一致，不要漏传。
- **创建终端有 pending 防重**：`createTerminal` 已有 `pendingCreateRef` 防重
  （`workspace-terminal.tsx:237`），快捷键连按天然安全，不要在外层再包一层
  状态。

## Scope

In scope:
- `apps/web/src/components/workbench/`（workbench.tsx、workspace-terminal.tsx、
  sidebar.tsx、dialogs.tsx，以及新增的快捷键 handler / 帮助浮层文件）

Out of scope:
- `apps/server`、`crates/*`、`packages/protocol` — 纯前端交互，不碰协议
- `apps/web/src/components/workbench/terminal-pane.tsx` 的 xterm 键处理 —
  拦截发生在 window capture 层，不改 xterm 配置（除非 executor 发现 capture
  拦不住某键，届时属 STOP 条件外的正常设计权，但需在完成报告中说明）
- 快捷键自定义/持久化配置 — 未来需求
- `tests/` — 黑盒 harness 不覆盖纯前端交互，不新增

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| 黑盒回归 | `pnpm -C tests test` | exit 0（无新增用例，纯回归） |

## Done criteria

- [ ] All listed commands pass.
- [ ] Requirement 列表中的 7 组行为全部可用；无目标时安静忽略。
- [ ] 被拦截的组合键不出现在终端输入流中（shell 收不到）。
- [ ] 非 active 的保活 WorkspaceTerminal 实例不响应快捷键。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- window capture 拦截被证实拦不住 Cmd+Ctrl 组合中的任意一个键（说明键位前提
  错误，需回到用户）。

## Maintenance notes

- 键位表硬编码在帮助浮层与 handler 两处，新增快捷键时两处同步。
- 若未来做 PWA standalone 增强（Cmd+1-9/Cmd+T 别名）或全屏 Keyboard Lock，
  在同一 handler 内加分支即可，不需要新架构。
- Cmd+Ctrl 前缀是与用户确认过的契约；改键位先回用户。
