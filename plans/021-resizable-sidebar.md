# Plan 021: Sidebar 拖拽调宽与本地记忆

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8cf04db..HEAD -- apps/web/src/components/workbench/sidebar.tsx apps/web/src/components/workbench/workbench.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/web/src/config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent
- Planned at: `8cf04db`, 2026-07-20

## Requirement

Web 工作台的左侧 Sidebar 当前固定为 260px，项目名、分支名或设备名较长时用户无法主动扩展可读空间，终端优先场景也无法收窄侧栏。需要支持从 Sidebar 右边缘拖拽调整宽度。

完成后：Sidebar 初始宽度仍为 260px；用户可通过右边缘的宽命中区把它连续拖到 200–480px 之间；拖动时有清晰但低噪音的分隔线反馈；松手后的宽度在刷新和下次打开时保留；双击把手恢复 260px 并同步更新持久化值。拖动只要求指针交互，不增加可聚焦的键盘调宽控件。右侧终端随布局变化自动重新 fit，Sidebar 内现有点击、右键菜单、滚动与文本截断行为不回归。

正确解与相邻错误解的分界：只改变视觉分隔线而不改变实际 flex 宽度是错的；刷新后丢失用户宽度是不完整的；允许侧栏越过 200–480px 是错的；拖动过程中因指针离开 1px 边框就中断是错的；为此引入 split-pane 依赖或修改 PTY resize 协议是过度设计。

## Decisions & tradeoffs

- **宽度契约为默认 260px、最小 200px、最大 480px**。Rejected: 180–600px —— 极窄时当前列表控件拥挤，极宽时明显吞噬终端；按视口比例限制 —— 让本地持久化后的实际宽度跨屏变化，行为更难预测。Based on: Sidebar 当前固定 `w-[260px]`（`apps/web/src/components/workbench/sidebar.tsx:74`），Workbench 已强制最小视口宽度 1024px（`apps/web/src/components/workbench/workbench.tsx:226`）。
- **宽度保存在浏览器 localStorage，并对读出的值做有限数值校验与 200–480px 钳制**。Rejected: 仅当前页面有效/刷新恢复默认 —— 不符合用户对 IDE 布局的记忆预期。存储 key 跟随 `coflux_*` 命名并置于现有配置常量边界。Based on: `TOKEN_KEY`、`WORKSPACE_KEY` 集中在 `apps/web/src/config.ts:5-6`，Workbench 通过惰性 state 初始化读取 localStorage（`apps/web/src/components/workbench/workbench.tsx:33`）。
- **Sidebar 内部自管纯视图宽度，不把它提升到 Workbench 或全局 Zustand store**。Sidebar 的宽度不会影响业务状态，父级 flex 会自然消费实际宽度；与服务端/其他浏览器同步没有意义。Rejected: Workbench 受控 prop —— 增加无业务价值的接线；Zustand —— 把设备本地布局混入服务端快照消费层。Based on: Sidebar 已自管项目折叠集合（`apps/web/src/components/workbench/sidebar.tsx:33-44`），Workbench 当前只负责跨组件/业务状态接线（`apps/web/src/components/workbench/workbench.tsx:227-241`）。
- **使用自定义 Pointer Events 边缘把手，不用原生 CSS `resize` 或第三方 split-pane**。把手有约 6px 的透明命中区，视觉线仅在 hover/active 时高亮；拖拽必须在指针离开窄边缘后继续生效，并防止拖动时误选页面文本。Rejected: CSS `resize: horizontal` —— 浏览器角落手柄的位置、样式和命中不可控；第三方库 —— 单一侧栏不值得增加依赖。Based on: 当前右边界只是 Sidebar 自身的 1px `border-r`（`apps/web/src/components/workbench/sidebar.tsx:74`），仓库没有现成 resizer/splitter 组件或依赖。
- **双击把手恢复 260px；仅支持指针拖动，不提供方向键/Home/End 调宽**。这是 departure check 明确选定的交互范围。把手不应因此进入 Tab 顺序或伪装成完整的键盘 separator 控件。
- **拖动结束和双击复位时持久化，不在每个 pointermove 同步写 localStorage**（decided while planning）。Rejected: 每帧同步写 localStorage —— 它是同步 API，会给高频指针路径增加无意义的主线程工作；每次 state 变化 effect 写入 —— 同样会把临时拖动帧全部落盘。拖动期间只更新 React 视图状态，结束时提交最终值。
- **终端尺寸适配沿用现有 ResizeObserver，不新增显式 terminal refit 接线或 PTY 协议变化**。Sidebar 实际宽度改变后，右侧 flex 子项尺寸随之改变，TerminalPane 观察 host 尺寸并调用 fit；持有控制权的活动终端再由既有 onResize 发送 PTY 尺寸。Rejected: Sidebar 主动调用终端方法 —— 制造跨组件耦合且重复现有观察机制。Based on: `apps/web/src/components/workbench/terminal-pane.tsx:216-228,245-252,295-297`。

## Direction

保持现有 Workbench 横向 flex 架构不变。Sidebar 把持久化宽度作为自己的纯 UI 状态应用到实际 `<aside>`，并在右边缘提供一个不挤占内容布局的自定义拖拽层。拖动生命周期需要完整覆盖开始、移动、结束/取消与组件卸载清理；最终提交值必须经过统一的有限数值和边界钳制。现有边框继续承担静态分隔，拖拽反馈叠加在同一边缘且不新增常驻高噪音图标。

### Milestone 1: 可持久化、可复位的 Sidebar 宽度交互

Sidebar 在 200–480px 内连续响应边缘拖拽，默认与无有效存储值时为 260px；松手持久化，刷新恢复；双击恢复并持久化 260px。命中区、光标、hover/active 反馈明确，拖动跨出边缘不丢失，过程中不误选文本，组件卸载不残留全局监听或全局 cursor/user-select 状态。Validation: `pnpm --filter @coflux/web build` -> exit 0。

### Milestone 2: 回归与真实布局验收

Sidebar 原有项目/工作区/设备交互保持可用；拖到两个边界时都不会越界；有活动终端时右侧 xterm 自动适配新空间且不出现持续的尺寸错位。Validation: Commands 中的 web 构建与全量黑盒测试均 exit 0；浏览器验收满足对应观察项。

## Landmines

- **终端 fit 已经有零尺寸/隐藏工作区保护**：不要绕过 `TerminalPane` 的 `fit()` 守卫直接从 Sidebar 触发 PTY resize，否则可能把隐藏保活终端钳成 2×1 并污染远端 TUI。Based on: `apps/web/src/components/workbench/terminal-pane.tsx:216-227`。
- **拖拽结束不仅有正常 pointerup**：浏览器/系统可能发出 pointercancel，组件也可能在登录状态变化时卸载；任何临时监听、pointer capture 或全局 cursor/user-select 改动都必须在这些路径清理，否则整个页面会残留不可选文字或 resize 光标。
- **持久化值是不可信字符串**：`Number(...)` 可能得到 `NaN`/`Infinity`，旧版本或手工修改可能越界；初始化和最终提交都不能把非法宽度写进 inline style。
- **当前仓库没有 web DOM 单元测试框架**：`apps/web/package.json:6-9,27-35` 只有 dev/build/preview 与构建依赖，不应为这个小改动新增测试框架。交互正确性由浏览器 acceptance 覆盖，静态类型与生产构建负责机械验证。

## Scope

In scope:

- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/config.ts`
- `plans/README.md`

Out of scope:

- `apps/web/src/components/workbench/workbench.tsx` —— 现有 flex 布局足以消费 Sidebar 宽度，无需新增受控 props
- `apps/web/src/components/workbench/terminal-pane.tsx`、`workspace-terminal.tsx` —— 现有 ResizeObserver/fit 管道应直接复用
- `apps/web/package.json`、锁文件 —— 不新增 split-pane、测试或手势依赖
- 键盘方向键/Home/End 调宽、折叠 Sidebar、响应式移动端抽屉 —— departure check 未选择，另立需求
- 服务端、协议、daemon、PTY resize 线格式 —— 本需求是纯 web 布局状态

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Web 类型检查 + 生产构建 | `pnpm --filter @coflux/web build` | exit 0 |
| 仓库黑盒回归 (acceptance) | `pnpm -C tests test` | exit 0 |
| UI 验收 (acceptance) | 启动本地 stack 与 web，在有项目、工作区和活动终端的 Workbench 中操作 Sidebar | 默认 260px；可拖到且不越过 200/480px；松手刷新后恢复；双击回到 260px 且刷新仍为 260px；hover/active 高亮与 resize 光标正确；拖出边缘仍连续；文本不被误选；列表、右键菜单、滚动正常；活动 xterm 自动 fit |

## Done criteria

- [ ] All listed commands pass.
- [ ] 无有效存储值时 Sidebar 为 260px；有效存储值刷新后恢复；非法、非有限或越界值安全回落/钳制到契约范围。
- [ ] 拖拽连续、限制在 200–480px，正常结束和取消/卸载路径无监听、pointer capture 或全局样式残留。
- [ ] 右边缘约 6px 命中区提供 resize 光标与 hover/active 高亮；不增加常驻视觉噪音，不进入键盘 Tab 顺序。
- [ ] pointerup 后持久化最终宽度，pointermove 高频路径不写 localStorage；双击恢复并持久化 260px。
- [ ] Sidebar 既有交互无回归，活动终端通过既有 ResizeObserver 自动 fit。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files or新增运行时依赖.
- A validation command fails twice after one reasonable fix.
- 现有 ResizeObserver 无法在 Sidebar 调宽时触发，必须改终端生命周期/协议才能正确适配。

## Maintenance notes

- 若未来增加 Sidebar 折叠或移动端抽屉，需要定义它们与持久化宽度的优先级；当前宽度只描述桌面展开态。
- 若未来加入键盘调宽，应把把手升级为完整、可聚焦且带 `aria-valuemin/max/now` 的 separator，并重新设计 focus 样式；当前明确不提供半套键盘语义。
