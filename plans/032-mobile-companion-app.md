# Plan 032: apps/mobile 移动随身端 —— 精简 Agent 指挥中心

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 3f45104..HEAD -- packages/client apps/web/src/components/workbench/parse-diff.ts apps/web/src/components/workbench/changes-view.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/web/index.html`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: plans/031-extract-client-package.md
- Category: feature
- Execution: subagent sonnet
- Planned at: `3f45104`, 2026-07-23（031 DONE 后的基线）

## Requirement

手机上随时掌握并驱动远程 agent：新建独立移动 web app `apps/mobile`
（`@coflux/mobile`），面向 m.coflux.dev 独立部署（部署动作本身不在本计划内）。
桌面 web（apps/web）不动。

功能面（与桌面是子集关系，按移动场景重新组织）：

1. **登录**：与桌面同双模式（Supabase / 本地账号），复用 `@coflux/client` 的
   登录语义。
2. **工作区/任务总览**：按项目分组的工作区列表，可见任务运行状态、diff 统计
   （+X −Y）、设备在线状态；选择工作区进入详情。
3. **终端查看与对话**：进入工作区看到终端 Tab，xterm 渲染输出；**可交互**——
   文字输入走系统键盘/IME，**快捷键条**补齐移动端缺失的控制键（Esc、Tab、
   方向键、Enter、Ctrl 组合如 Ctrl+C 等），足以驱动 claude code 一类 TUI
   agent（菜单选择、中断、斜杠命令、确认）。控制权语义与桌面一致（attach 即
   申请接管、detached 显示被接管态并可重新接管）。
4. **终端轻管理**：新建/关闭终端 Tab、重新接管。
5. **变更 diff 查看**：工作区累计 diff 的文件列表 + 逐文件 hunk 展示（简版，
   行级着色）。

不做（留桌面或后续版本）：导入向导、设备登记/重命名/移除、新建/删除/重命名
工作区、切分支、端口转发管理、快捷键系统、拖拽/贴图上传。

正确解与相邻错误解的分界：错误解是把桌面 workbench 塞进手机壳（常驻侧栏、
hover 交互、追求功能全量）；正确解是「列表 → 详情」两级移动导航 + 触屏优先
交互，功能面刻意小但每一项在手机上真正好用——尤其快捷键条必须能实际驱动 TUI。

## Decisions & tradeoffs

- **信息架构：两级导航**。首页 = 项目分组的工作区列表（含状态徽记）；详情页 =
  单工作区（顶部：返回 + 分支名 + 终端 Tab 条 + 变更入口；主体：终端/变更
  视图互斥）。无常驻侧栏、无右键菜单、无 hover 交互。Rejected: 复刻桌面
  workbench 布局 —— 这正是 plan 030 撤回的原因。
- **状态层全量复用 `@coflux/client`**（plan 031 产物）：连接、认证、快照/增量
  归约、PTY consumer 注册表、pending-map、控制权语义（`startTask` 即申请接管、
  `detachedTaskIds`、`taskDetached` 广播）全部来自共享包，mobile 不重写任何
  协议逻辑。UI 状态订阅用 `zustand` 的 `useStore`（同 web 惯例，如
  `apps/web/src/components/workbench/workbench.tsx:50-58`）。
- **终端呈现**：`@xterm/xterm` 6.0 + `@xterm/addon-fit`（版本与
  `apps/web/package.json` 对齐）；不加 WebGL addon（移动 GPU 兼容性保守，DOM
  渲染器在手机屏行数下足够）；fontSize 较桌面调大（13–14，执行者定）。attach
  快照回放由 server 镜像下发（协议不变，见 `apps/server/src/mirror.ts` 顶注），
  mobile 无需特殊处理。桌面 web 的 IME 全角标点 workaround
  （`apps/web/src/components/workbench/terminal-pane.tsx:55-88`
  `patchImeCommittedInput`，上游 xtermjs/xterm.js#5887）原样带入 mobile 的
  终端组件——移动输入法走同一条 textarea input 路径，同样受该缺陷影响。
- **快捷键条**：常驻终端下方（visualViewport 兜底下自然贴软键盘上沿）。
  第一版键位：Esc、Tab、↑ ↓ ← →、Ctrl（粘滞修饰：点亮后下一个字母键发
  Ctrl 组合码，如 Ctrl+C=\x03）、Enter；控制序列经 `client.sendInput` 直发
  （方向键 CSI：\x1b[A/B/C/D）。键位增删是执行者/后续迭代自由度，粘滞 Ctrl
  的交互模型是定死的。Rejected: 长按弹出组合键盘 —— 交互复杂度不配第一版。
  受输入门控约束：sendInput 仅在持有控制权时有效（同桌面语义，
  `apps/web/src/components/workbench/terminal-pane.tsx:269-273`）。
- **变更视图：简版无 shiki**。文件列表 + hunk 行级 +/− 着色，不做语法高亮
  （shiki 及其语言包体积/内存对手机不友好，桌面 changes-view 引入它是桌面
  决策）。diff 获取与解析复用桌面路径：`execInWorkspace` 跑 git diff + 纯函数
  解析器；`apps/web/src/components/workbench/parse-diff.ts`（127 行纯函数）
  **复制**进 apps/mobile，`diff-highlight.ts`（shiki 封装）不带。Rejected:
  为 parse-diff 扩共享包 —— 127 行纯函数的双份成本低于包边界维护成本；
  何时抽包见 Maintenance notes。获取命令的具体形式以
  `apps/web/src/components/workbench/changes-view.tsx` 现行实现为准（与
  defaultBranch merge-base 的语义保持一致）。
- **移动视口三件套**（plan 030 撤回时保留的调研结论，全部适用）：
  `h-dvh`（不用 h-screen）；viewport meta 加
  `interactive-widget=resizes-content`（Android Chrome）；iOS Safari 用
  `visualViewport` resize 监听钳制根容器高度（键盘弹出时终端与快捷键条随之
  上移，输入行不被遮挡）。终端高度变化经 ResizeObserver 自动 refit。
- **技术栈与工程形态照抄 apps/web**：Vite 6 + React 19（含 compiler babel
  插件）+ Tailwind 4 + Astryx（含 `apps/web/src/index.css` 同款 layer 声明与
  主题变量，色板延用近黑 IDE 风）+ `@coflux/protocol` + `@coflux/client`。
  config.ts 同款环境变量：`VITE_COFLUX_SERVER`、`VITE_SUPABASE_URL`、
  `VITE_SUPABASE_ANON_KEY`（生产构建必须注入 Supabase 变量，同 web 部署
  惯例）；`loginWithSupabase`（23 行）复制进 mobile 的 lib。localStorage key
  用 mobile 自己的一组（如 `coflux_m_*`），避免与桌面同域调试时串台。
  Rejected: 引入移动 UI 框架（Ionic 等）—— 栈分叉的长期成本远超收益。
- **PWA**：独立 `manifest.webmanifest`（name 区分于桌面，如「coflux m」）+
  图标 + `apple-mobile-web-app-*` meta，无 service worker（同 plan 022 的
  决策：不引入缓存失效复杂度）。图标可基于 `apps/web/public/` 现有资产改制。
- **保活策略简化** (decided while planning)：桌面 web 的「访问过的工作区保持
  挂载」（`workbench.tsx:33-36`）是多工作区并行盯梢的桌面场景；mobile 第一版
  只保活**当前**工作区详情页内的多个终端 Tab（Tab 间切换不丢 scrollback，同
  `terminal-pane` 的 display 切换模式），离开详情页即卸载并断开 attach。
  省内存，且返回列表页时重新进入会经镜像快照秒恢复现场。

## Direction

新 app 从零搭骨架，但每一层都有既有参照：工程配置抄 apps/web 根文件；状态层
是 `@coflux/client` 的纯消费者；终端组件可参照 `terminal-pane.tsx` 裁剪
（去掉拖拽/贴图/WebGL/dpr 监听，保留 xterm 创建、fit、IME patch、consumer
注册、控制权门控）；attach/控制权编排参照 `workspace-terminal.tsx` 大幅简化
（单工作区、无隐藏实例矩阵）。UI 组件优先 Astryx（`pnpm exec astryx` CLI 可查，
在 apps/mobile 下需先配好依赖）。

### Milestone 1: 工程骨架 + 登录

`apps/mobile` 可 `pnpm --filter @coflux/mobile build`；登录页双模式工作，
authed 后能收到快照（store 有数据）。Validation:
`pnpm --filter @coflux/mobile build` → exit 0；
`pnpm --filter @coflux/web build` → exit 0（确认未破坏桌面）。

### Milestone 2: 工作区列表 → 详情导航

列表页呈现项目分组、任务状态、diff 统计、设备在线；进入/返回详情页导航成立
（含浏览器返回手势不退出登录态的路由处理，History API 或极简 hash 路由，
执行者定，不引路由库）。Validation: 同上 build 通过。

### Milestone 3: 终端可看可聊

详情页终端 Tab 渲染输出、attach/接管/detached 语义正确、系统键盘可输入中英文、
快捷键条各键发出正确序列、新建/关闭 Tab 可用。Validation: 同上 build 通过。

### Milestone 4: 变更视图 + PWA 收尾

diff 文件列表与 hunk 着色展示；manifest/图标/视口 meta/visualViewport 兜底
就位。Validation: 同上 build 通过。

## Landmines

- iOS Safari 长按不触发 `contextmenu`、hover 不存在——mobile UI 从设计上就
  不得使用右键菜单与 hover-reveal（本计划的 IA 决策已规避，勿在实现中引入
  Astryx ContextMenu/Tooltip-only 入口）。
- `terminal-pane.tsx:240-252` 的教训：尺寸为 0 时绝不 fit（会把 2×1 经
  ptyResize 推给远程 PTY 污染镜像）。mobile 终端组件同样要带这个守卫——
  Tab 切换用 display 隐藏时必然遇到 0 尺寸。
- 输入与 resize 只在持有控制权（owned）时发送（`terminal-pane.tsx:269-277`
  的门控模式）；快捷键条也必须过同一道门，否则旁观态会把控制序列漏发给
  他端持有的会话。
- attach 时序：先注册 session consumer 再发 taskStart，否则镜像快照回放字节
  在 consumer 注册前到达会丢（`terminal-pane.tsx:422-435` 的 sessionReady
  门控注释）。
- `snapshotRevision` 变更 = 重连/重登，server 侧旧 holder 已失效，当前正在看
  的终端必须重新 attach（`workspace-terminal.tsx:336-352`），否则变成只读。
- xterm 6 内部字段补丁（IME workaround）依赖私有结构，任一字段缺失需整体
  跳过回落上游行为（`terminal-pane.tsx:62-66` 已有该防御，照搬时保留）。
- Astryx 组件需要 `reset.css`/`astryx.css` 入口引入与 layer 顺序声明
  （`apps/web/src/index.css:1-12`），漏掉会整体无样式。
- 新 app 的 tsconfig 需挂进根 `tsconfig.base.json` 体系并配 `@/` 别名
  （参照 apps/web 的 tsconfig/vite 配置），否则 `tsc -b` 编排会漏掉它。

## Scope

In scope:

- `apps/mobile/**`（新建）
- 根 `package.json`（可选：`dev:mobile` 脚本）
- `pnpm-lock.yaml`（随 install 更新）

Out of scope:

- `apps/web`、`apps/server`、`crates/`、`packages/*` —— 桌面、服务端、共享包
  一概不动（`packages/client` 若在实现中发现缺口，STOP 汇报而非顺手改）
- 部署/DNS/托管配置（m.coflux.dev 的上线动作）—— 运维动作另行处理
- 导入向导、设备管理、工作区/分支管理、端口转发 UI —— 功能面之外

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| mobile 构建 | `pnpm --filter @coflux/mobile build` | exit 0 |
| 桌面回归构建 | `pnpm --filter @coflux/web build` | exit 0 |
| 移动端验收 (acceptance) | 本地起 server+daemon+mobile dev，Playwright MCP 390×844 触屏：登录 → 列表 → 详情 → 终端输出可见、键盘输入与快捷键条（Esc/方向键/Ctrl+C）驱动 TUI → 新建/关闭 Tab → 变更视图 | 全流程可用，无横向滚动 |
| 桌面回归冒烟 (acceptance) | Playwright MCP 1440×900 过桌面主流程 | 与基线一致 |

## Done criteria

- [ ] 两个 build 命令均通过。
- [ ] 390×844 视口验收流程全部可用；快捷键条能实际驱动 TUI（方向键选菜单、
      Esc 退出、Ctrl+C 中断得到验证）。
- [ ] 控制权语义与桌面一致：mobile 接管时桌面收到 detached 提示，反之亦然。
- [ ] apps/web 无任何 diff（scope 内根 package.json/lockfile 除外）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（含 `packages/client` 能力缺口）。
- A validation command fails twice after one reasonable fix.
- plan 031 未 DONE。

## Maintenance notes

- parse-diff.ts 在 web/mobile 各有一份**刻意的**复制；当第三个消费者出现或
  两份开始分叉修 bug 时，抽进 `packages/`（届时连 changes 数据获取逻辑一起
  评估）。
- 快捷键条键位表是第一版最可能迭代的点（用户实际驱动 claude code 后会知道
  缺哪些键）；保持键位定义为数据（label → 序列映射），加键零结构成本。
- 移动端"离开详情页即卸载终端"依赖 server 镜像快照恢复现场；若未来 server
  镜像语义变化（mirror.ts），复核该假设。
