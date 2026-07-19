# Plan 016: 终端 cell 度量漂移后自动 refit，消除溢出滚动条

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 909575e..HEAD -- apps/web/src/components/workbench/terminal-pane.tsx apps/web/src/index.css apps/web/src/components/workbench/workbench.tsx`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `909575e`, 2026-07-20

## Requirement

某些情况下 web 终端的渲染内容超出可视面板：底部行被裁掉、xterm 6 的
overlay 滚动条横竖两个方向同时出现（用户已确认此症状）。根因是 fit 失配：
FitAddon 计算 cols/rows 的那一刻数学自洽（floor 保证不溢出），但之后 cell
的 CSS 尺寸发生漂移时无人重新 fit——host 的 CSS 尺寸未变，ResizeObserver
不会触发。代码中存在两个这样的真空期：

1. WebGL 渲染器异步挂载后：mount 时 rAF fit 用的是 DOM 渲染器的字符度量，
   之后 WebGL addon 动态加载挂上，用字形图集重新度量，cell 尺寸可能有
   亚像素差异，此后再无 fit。
2. devicePixelRatio 变化后：浏览器缩放（Cmd +/-）或窗口拖到缩放比不同的
   显示器时，xterm 按新 dpr 重新取整 cell 尺寸，host CSS 尺寸不变。

完成后：上述两个时机都会触发一次 refit，终端 screen 尺寸与可视区重新对齐，
不再出现溢出滚动条与底行裁切。正确解与相邻错误解的分界：修复必须是
"度量变化时机补 fit"，而不是改布局/CSS 裁剪掩盖溢出（overflow hidden 只会
把裁切藏起来，cols/rows 与 PTY 尺寸仍是错的）。

## Decisions & tradeoffs

- **修复位置**：全部在 `apps/web/src/components/workbench/terminal-pane.tsx`
  的 mount-only useEffect（空依赖数组）内，复用现有 `fit` 闭包。Rejected:
  在 WorkspaceTerminal 层处理 — 度量漂移是每个 xterm 实例自己的事，
  controller 已暴露 fit 但由外层监听 dpr 会造成多实例重复监听且拿不到
  WebGL 挂载时机。Based on: fit 定义于 terminal-pane.tsx:166-178，已含
  0 尺寸守卫与 try/catch；mount effect 只跑一次（terminal-pane.tsx:111-113 注释）。
- **WebGL 挂载后补 fit**：在 `loadAddon(webgl)` 成功路径后调用一次 fit()。
  Rejected: 等待某个渲染器事件 — xterm 无公开的度量变化事件，私有 API
  不可依赖。Based on: WebGL 动态加载在 terminal-pane.tsx:151-164，
  成功路径是 try 块内 `terminal.loadAddon(webgl)` 之后。
- **dpr 变化监听**：`matchMedia(`(resolution: ${devicePixelRatio}dppx)`)`
  的 change 监听，触发时 fit() 并以新 dpr 重建监听（自递归模式，因为
  media query 字符串绑定的是旧 dpr 值）；cleanup 移除当前监听。
  Rejected: 轮询 devicePixelRatio — 常驻定时器换一个本可事件驱动的信号。
  Rejected: 仅依赖 window resize 事件 — 拖跨显示器时窗口 CSS 尺寸可能
  完全不变。Based on: VS Code 终端对 dpr 变化的处理同为主动 refit；
  ResizeObserver 只观察 host（terminal-pane.tsx:245-246），对 dpr 盲。
- **不动 CSS 与布局**：index.css 的 `.xterm { height: 100% }`（index.css:261）
  与 host 的 `px-3 py-2`（terminal-pane.tsx:289）保持原样。Rejected:
  给 host 加 overflow hidden 掩盖溢出 — 见 Requirement 的分界说明。
- **fit 的幂等性作为安全网**：fit() 在尺寸未变时 `terminal.resize` 不会被
  调用（FitAddon 内部先比较 cols/rows），补的两刀不会引发多余的
  ptyResize；且 onResize 已门控 active && owned（terminal-pane.tsx:200-203）。
  Based on: addon-fit 0.11.0 源码 `fit()` 中
  `if (this._terminal.rows !== dims.rows || this._terminal.cols !== dims.cols)`。

## Direction

单文件、单里程碑。实现落在 mount-only useEffect 内：WebGL 成功挂载后
补 fit；dpr 监听建立/自递归重建/清理与现有 cleanup（terminal-pane.tsx:249-257）
合流。监听器生命周期必须与 xterm 实例一致——组件卸载后不得残留
matchMedia 监听（残留监听闭包引用已 dispose 的 terminal，fit 会在
`host.isConnected` 守卫处短路，但监听本身是泄漏）。

### Milestone 1: 度量漂移时机自动 refit

WebGL 挂载完成与 dpr 变化后各触发一次 fit，卸载后无监听残留。
Validation: `pnpm --filter @coflux/web exec tsc -b` -> exit 0。

## Landmines

- fit() 门控 `liveRef.current.active`（terminal-pane.tsx:167）：非活跃
  Tab 的 pane 调 fit 是 no-op。这对本修复无害——非活跃 pane 处于
  display:none，切回时 props.active 效果（terminal-pane.tsx:277-284）
  会补 fit，届时用的已是漂移后的新度量。不要试图为非活跃 pane 绕过
  该门控。
- WebGL 挂载回调里已有 `disposed` 标志与 `terminal.element` 存在性检查
  （terminal-pane.tsx:153）：补的 fit 必须同样尊重 disposed，避免在
  卸载竞态中对已 dispose 的 terminal 操作。
- matchMedia 的 media query 字符串绑定创建时的 dpr 值，change 只在
  离开该值时触发一次——必须自递归重建监听，否则第二次 dpr 变化收不到。
- `dispose()` 时 xterm 会连带 dispose 已挂载 addons（terminal-pane.tsx:254
  注释），matchMedia 监听不在其中，需在 effect cleanup 显式移除。

## Scope

In scope:
- `apps/web/src/components/workbench/terminal-pane.tsx`

Out of scope:
- `apps/web/src/index.css` — 布局/CSS 无问题，禁止用裁剪掩盖溢出
- `apps/web/src/components/workbench/workspace-terminal.tsx` — 修复归属单个 xterm 实例
- 服务端/协议 — ptyResize 链路本身工作正常

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm --filter @coflux/web exec tsc -b` | exit 0 |
| 人工验收 (acceptance) | 打开终端后 Cmd +/- 缩放、拖跨不同缩放比显示器 | 无横竖滚动条、底行完整 |

## Done criteria

- [ ] Typecheck 通过。
- [ ] WebGL 挂载成功后有一次 refit；dpr 变化后有 refit 且监听自递归重建。
- [ ] 组件卸载后无 matchMedia 监听残留。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- terminal-pane.tsx 的 mount effect 不再是空依赖数组单次执行（前提破坏）。

## Maintenance notes

- 若日后仍偶现溢出滚动条，优先怀疑第三个未知的度量变化时机（如字体加载、
  xterm 升级改变度量取整），排查方向是"谁改了 cell 尺寸而没触发 fit"，
  而不是布局。plan 013 的预警仍有效：xterm 6 滚动条行为差异先查 #5096。
- 若 xterm 未来提供公开的度量/渲染器变化事件，可用其替换 matchMedia
  自递归监听。
