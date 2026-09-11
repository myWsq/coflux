# Plan 108: 桌面版终端顶栏与空态主区顶部成为窗口拖拽区（拖动 + 系统双击动作）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c1e82cc..HEAD -- apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/main/window.ts apps/desktop/package.json`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: 106（DONE 在分支 `dev/20260911-desktop-only-merge`，未合 main；本 plan 基于其尖端 `c1e82cc`，合回顺序 106 → 107（卫星页面）→ 108；原编号 107 与同日「卫星页面收进 server」plan 撞号后改号）
- Category: bug
- Execution: subagent（宿主通用子 agent，`model: opus`；出发检查 2026-09-11 记录，全自动推进，不再确认）
- Planned at: `c1e82cc`, 2026-09-11

## Requirement

桌面版（`apps/desktop`，Electron 44）用 `titleBarStyle: "hidden"` 隐藏了系统标题栏，红绿灯内嵌到侧栏顶部
（`apps/desktop/src/main/window.ts:49-50`）。隐藏标题栏后窗口只认 CSS `-webkit-app-region: drag` 声明的区域，
而当前全应用唯一的拖拽区是侧栏顶部那条 38px 空白带（`sidebar.tsx:35-36`、`:233`）。用户反馈：在终端 tab 栏的
空白处按住拖动不能移动窗口，双击也不能缩放窗口——因为终端顶栏没有声明拖拽区，与 macOS 惯例（IDE 的 tab 栏空白处
等同标题栏）不符。

### 产品结论（探索阶段已确认，勿再问）

- **消费者与触发**：桌面版用户，鼠标在终端顶栏的空白处（分支按钮、「变更」tab、各终端 tab、「+」、右侧端口链接
  之外的任何位置，含 tab 列表尾部、各元素之间的缝隙、右侧端口区周围）按下拖动 → 窗口跟随移动；在同处双击 →
  按 macOS「桌面与程序坞 → 双击窗口标题栏」的系统偏好执行填充 / 缩放 / 最小化 / 无操作，与在侧栏空白带上双击
  一致。
- **顶栏内所有可交互元素行为不变**：分支按钮（BranchMenu 下拉）、「变更」tab、每个终端 tab（点击切换、端口
  下拉、悬浮出现的关闭按钮）、pending tab、「+」按钮、右侧端口链接，都必须照常可点、可悬浮出 Tooltip、可拖拽
  上传文件的区域不受影响（拖拽区只在顶栏，不在终端主体）。
- **空态主区顶部**：三个用户可见的无顶栏主区——设备详情空态（「在「设备」上开一个终端」）、乐观创建中
  （「正在创建工作区」）、引导 / 选择空态（「从一个项目开始」/「选择一个工作区」）——顶部各留一条与侧栏空白带
  等高（38px）的拖拽带，让窗口在这些状态下也能从主区顶部拖动 / 双击。空态里的按钮（「新建终端」「导入项目」）
  在垂直居中区域，不与顶部拖拽带重叠，行为不变。两处瞬态主区（Suspense fallback、首快照未到的 loader）是否也加
  由执行者定，不作要求。
- **不在范围**：断线重连横幅、登录页、终端主体、「变更」视图主体；用户另一条反馈「终端下面有奇怪的黑条」已明确
  搁置，本 plan 不碰（探索结论见「维护说明」，供日后参考）。
- **验收**：用户在真机桌面版人工走查（拖动、双击、各按钮可点、Tooltip 可出）。按既定约定 Claude 不做 UI 走查，
  执行者与验证者都不启动 app、不跑浏览器。

## Decisions & tradeoffs

- **拖拽机制**：与侧栏完全同款——CSS `-webkit-app-region: drag`（React 内联样式键 `WebkitAppRegion`，需
  `as CSSProperties` 断言，见 `sidebar.tsx:36`）。Rejected: 任何主进程 / IPC / 鼠标事件层面的自定义拖动
  （`titleBarOverlay`、`performWindowDragWithEvent`、自绘标题栏）——Electron 隐藏标题栏的正规机制就是
  app-region，主进程零改动。Based on: `apps/desktop/src/main/window.ts:49-50`（`titleBarStyle: "hidden"` +
  `trafficLightPosition`）；`sidebar.tsx:35-36, 233`。
- **双击缩放交给 Chromium 原生，不自己实现**：本 plan 不加 IPC、不改 `apps/desktop/src/main/**`、渲染层不监听
  dblclick。Rejected: VS Code 式「渲染层 dblclick → IPC → 主进程读 `AppleActionOnDoubleClick` 再 maximize /
  minimize」——Chromium 已在 `NativeWidgetMacNSWindow sendEvent:` 里对自定义拖拽区内 clickCount==2 的左键抬起
  按该偏好执行 Fill / Zoom(`performZoom:`) / Minimize / None，再实现一遍会双重触发；且拖拽区内 DOM 收不到
  dblclick（见地雷），此路本就不通。Based on: Chromium `components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm`
  的 `sendEvent:`；Electron issue #16385 于 2025-01-17 以「已修复」关闭；当前 Electron `^44.3.0`
  （`apps/desktop/package.json`）。
- **顶栏整条为拖拽区，可交互子元素逐个 `no-drag`**：`drag` 落在 `<header>`（`workspace-terminal.tsx:363`）
  整体，`no-drag` 落在每一个可交互元素（分支按钮、「变更」tab、每个终端 tab 项、pending tab、「+」按钮、端口
  链接）上。Rejected: 只把 tab 列表尾部空白做成拖拽区——分支按钮与列表之间、右侧端口区周围的缝隙拖不动，且可拖
  范围随 tab 数量漂移；Rejected: 把 `no-drag` 标在 `overflow-x-auto` 的 tab 滚动容器（`:384`）上——容器本身
  就是空白处所在，标了之后空白处又拖不动。Based on: `workspace-terminal.tsx:363-539`。
- **空态顶部拖拽带 = 一条固定高度的空元素，不把整个空态 `<main>` 设为拖拽区**：高度沿用侧栏的
  `DESKTOP_TITLEBAR_HEIGHT`（38）。Rejected: 整个空态主区 `drag`——会吞掉「新建终端」「导入项目」按钮与文字
  选择，需逐个 `no-drag`，且大面积拖拽区不符合 macOS 惯例。Based on: `workbench.tsx:645`（设备详情空态）、
  `:673`（乐观创建中）、`:689`（引导 / 选择空态）；瞬态 `:604`（Suspense fallback）、`:685`（首快照 loader）。
- **不加运行形态门控**：plan 106 后桥接必选、没有浏览器形态，侧栏拖拽带已无条件渲染（`sidebar.tsx:233`），
  本 plan 新增的拖拽声明同样无条件。Rejected: 保留 / 恢复 `isDesktop()` 之类判断——106 已删，无可门控之物。
- **断线横幅与登录页不改**：横幅是 fixed 顶部条，出现时根容器加 `pt-7`（`workbench.tsx:577`、`:706`），顶栏与
  空态整体下移，拖拽区跟着走，无需处理。
- **不新增测试**（decided while planning）：改动是纯样式声明，渲染层单测是 `node --test` 的无 DOM 逻辑测试
  （`apps/desktop/package.json` 的 `test` 脚本），没有可断言的行为；若执行者抽出共享常量模块也不要求配测试。
  Rejected: 为 CSS 声明写快照 / DOM 测试——引入 jsdom 等新依赖，收益为零。

## Direction

两个里程碑各自独立可验证，但若执行者把侧栏的拖拽常量抽到共享位置，两者都依赖该抽取，**按一个工作包执行，不拆**。
执行者对着 live code 设计，不预设改法；下列只是结果契约。

### Milestone 1: 终端顶栏成为窗口拖拽区

`workspace-terminal.tsx` 的顶栏 `<header>` 整条声明为 `drag`，顶栏内每个可交互元素声明为 `no-drag`（清单见
产品结论第二条；`no-drag` 要落在实际产生布局盒的元素上，Astryx `Tooltip` / `DropdownMenu` 包裹层是否产生盒子
由执行者读组件源码或 DOM 结构确认）。侧栏拖拽常量若被复用，抽到共享位置与否、放哪里由执行者定，但 38 这个数只
能有一个来源。
Validation: `pnpm -C apps/desktop typecheck` → exit 0；`pnpm -C apps/desktop test` → exit 0。

### Milestone 2: 空态主区顶部拖拽带

`workbench.tsx` 里三个用户可见的空态 `<main>` 顶部各有一条 38px 高的 `drag` 空元素，空态原有内容仍垂直居中于
其余区域（或整体，只要按钮不落进拖拽带即可）。瞬态两处随执行者。
Validation: `pnpm -C apps/desktop typecheck` → exit 0；`pnpm -C apps/desktop build` → exit 0。

## Landmines

- **拖拽区吞掉全部指针事件**（Electron #37789，open，macOS 已确认）：`drag` 区域内的 DOM 收不到 click /
  dblclick / mouseenter。顶栏里任何可交互元素漏标 `no-drag` 即不可点、Tooltip 不出、hover 态不亮。逐项对照：
  BranchMenu（`workspace-terminal.tsx:366`）、「变更」tab（`:395` 附近的 button）、终端 tab 项（`:445` 附近的
  group div，含 `:461` 端口 DropdownMenu 与 `:479` 关闭按钮 Tooltip）、pending tab（`:491`）、「+」按钮
  （`:513-516`）、端口链接（`:525`）。
- **`no-drag` 与 `overflow-x-auto`**：Blink 按布局矩形计算拖拽区，标在滚动容器内子项上即可；滚出可视区的 tab
  的 `no-drag` 矩形落在容器外，无害。不要把 `no-drag` 标在容器上（见决策）。
- **React 类型**：`CSSProperties` 不含 `WebkitAppRegion`，侧栏用 `as CSSProperties` 断言（`sidebar.tsx:36`）。
  Tailwind 4 的任意属性写法 `[-webkit-app-region:drag]` 也可用，但仓库先例是内联样式；两种写法二选一，不要混用。
- **顶栏高度与侧栏带不等高**：顶栏 `h-9`（36px），侧栏带 38px，属既有事实，不需要对齐；空态拖拽带按 38。
- **新 worktree 无依赖**：`dev:execute-plan` 预检时在 worktree 根 `pnpm install --frozen-lockfile`；渲染层
  测试路径见 `apps/desktop/package.json` 的 `test` 脚本（含 `src/renderer/**/*.test.ts`）。
- **基线是 106 分支不是 main**：渲染层路径是 `apps/desktop/src/renderer/...`，main 上仍是 `apps/web`。
  不要参考 main 的路径与内容；本分支合回顺序是先 106 后 108。

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`（仅当抽取共享拖拽常量时）
- `apps/desktop/src/renderer/components/workbench/` 下新增的共享常量模块（可选，执行者定名）
- `plans/108-desktop-titlebar-drag.md`、`plans/README.md`

Out of scope:
- `apps/desktop/src/main/**`、`apps/desktop/src/preload/**`、`apps/desktop/src/shared/**` — 双击与拖动都由
  Chromium / Electron 原生处理，主进程零改动
- 断线横幅、登录页（`AuthShell`）、终端主体 `terminal-pane.tsx`、`index.css` — 不在需求内
- 「终端下面的黑条」— 用户已搁置
- `packages/client`、`apps/ios`、server、daemon — 无关

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0（基线 67 项通过，数量不减） |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| 真机走查 (acceptance，人工) | 用户打包/启动桌面版：顶栏空白处拖动窗口、双击按系统偏好动作、顶栏各元素可点可悬浮、三个空态顶部可拖动 | 用户确认 |

仓库无 lint 脚本。

## Done criteria

- [ ] All listed commands pass.
- [ ] 终端顶栏 `<header>` 整条为 `drag`，产品结论清单里的每个可交互元素都为 `no-drag`。
- [ ] 三个用户可见空态 `<main>` 顶部各有一条 38px 的 `drag` 带，空态内按钮不落在带内。
- [ ] 主进程 / preload / shared 零改动；渲染层没有新增 dblclick 监听或任何窗口缩放逻辑。
- [ ] 38 这个高度只有一个来源（沿用或抽取 `DESKTOP_TITLEBAR_HEIGHT`）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其 `window.ts` 的 `titleBarStyle` 已不是 `"hidden"`，
  或侧栏拖拽带已改用别的机制）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- 以后往顶栏里加任何可点元素都必须带 `no-drag`，否则在桌面版里点不到——建议在 header 处留一句注释说明。
- 若日后 `titleBarStyle` 改为其它值或换用 `titleBarOverlay`，拖拽区的必要性与双击行为都要重新评估。
- 「终端下面的黑条」探索结论（已搁置，未修）：xterm 6.0 的 `.xterm-viewport` 仍是纯黑 `#000`（主题背景只刷到
  新的 scrollable 元素），但 FitAddon 0.11 按宿主 border-box 高度算行数、不扣宿主 padding，画面总是盖过
  viewport 底边，纯黑只可能在右侧露 2–9px 竖条，不会在底部成横条；同一原因会让最后一行最多超出面板 8px 被窗口
  底边裁掉。底部横向黑条更可能是 Electron 44 + `titleBarStyle: "hidden"` 在 macOS 27 上的窗口层问题，未定因。
