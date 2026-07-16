# Plan 011: Web 客户端迁移 React 19 + Compiler（生态回归，能力与性能地板等价）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8ec535b..HEAD -- apps/web`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none（010 已 DONE，本计划以其产物为基线）
- Category: refactor
- Execution: subagent sonnet
- Planned at: `8ec535b`, 2026-07-16

## Requirement

Plan 010 将 apps/web 重写为 SolidJS 并已验收落地。复盘后判定：SolidJS 的生态成本
（组件库/第三方集成/人才与 AI 工具链熟悉度）长期高于其渲染模型收益，且性能地板的
真正来源是"PTY 字节流零响应式直达 terminal.write"这一架构不变量，与框架选型无关。
故将 apps/web 从 SolidJS 迁移到 **React 19 + React Compiler**。

**功能能力、视图模型、Cursor 风视觉与性能地板严格保持现状（010 产物），不加新功能**：
登录（Supabase 换票 / 本地账号双模式）、设备管理与登记密钥、项目导入、工作区创建/删除、
工作区选择持久化、多终端 Tab、attach/独占接管、端口预览链接、`/authorize` 设备授权页、
`/proxy-auth` 预览域门禁页。

正确性判别标准：熟悉现版的用户操作全部主路径感觉"完全没变"；多客户端接管语义与
现版逐条一致（Landmines 1-14）；PTY 高吞吐输出下无可感知卡顿。

## Decisions & tradeoffs

- **框架 React 19 + React Compiler**（`babel-plugin-react-compiler` 经
  `@vitejs/plugin-react` 的 babel 配置启用）。Rejected: 维持 SolidJS——生态优先，
  用户拍板（2026-07-16）。本条推翻并取代 010 的框架决策；010 拒绝 React 的理由
  （VDOM 与高频数据流不同构）被"高频流不进 React 状态"的架构消解。
- **基线是当前 SolidJS 实现的语义翻译，不是复活 010 之前的旧 React 代码**。
  Rejected: 从 git 历史恢复 `bc9fec3` 前的 React 实现——旧代码缺 010 落地的
  分层（纯 TS 连接层）、WebGL 渲染、指数退避重连、bundle 优化，且 landmines
  修复不全，复活后需重做全部 010 工作。Based on: `apps/web/src/client/connection.ts:1-10`
  仅依赖 @coflux/protocol 与 config，无任何框架 import。
- **`client/connection.ts` 原样保留**（WS 连接/三凭证认证/指数退避 + 抖动重连
  `connection.ts:15-16,55-56`）。它是纯 TS，本次迁移不改其逻辑；仅当类型/接口
  需要适配时做最小改动。
- **状态库 zustand（vanilla store + `useStore` 选择器 + `useShallow`）**。
  Rejected: 手写 useSyncExternalStore——偏离"用生态标准件"的本计划动机；
  jotai——实体集合 + 级联清理的批量更新与原子模型不契合。重渲染控制三层：
  ① 组件用细粒度选择器订阅，切片不变不重渲染；② 实体集合必须**不可变更新且
  未变实体保持引用稳定**（更新一个 task 不得重建其它 task 对象）；③ React
  Compiler 自动 memo 阻断父子级联。派生数组/对象选择器必须用 `useShallow`。
- **PTY 数据流不变量继续：ptyOutput 经 consumer 注册表直达 `terminal.write`，
  绝不进 zustand/React state**。Based on: `store.ts:38,46,213-216` 现有实现即此
  模型，翻译时注册表保持在 store 层的普通 Map（非 React 状态）。这是性能地板
  的核心，违反即 review 失败。
- **不启用 StrictMode**（decided while planning）。WS 单连接、xterm 实例、
  consumer 注册均为命令式资源，StrictMode 双挂载的排错成本没有回报，现版
  SolidJS 也无对应机制。若 executor 选择启用，必须保证全部 effect cleanup
  幂等——但默认路径是不启用。
- **组件基座 radix-ui primitives + 沿用 `index.css` 的 Cursor 风 CSS 变量**。
  Rejected: 引入 shadcn CLI 及其全套生成物——现有 ui 组件仅 7 个
  （button/dialog/alert-dialog/select/input/textarea/label），手工对译即可，
  CLI 生成物是增熵。视觉 token（CSS 变量）零改动，UI 迁移后应像素级近似。
  图标 lucide-solid → lucide-react。
- **xterm 栈零变更**：`@xterm/xterm` + fit + WebGL 动态 import（addon 不进首屏
  主 chunk，`terminal-pane.tsx:64-76`）+ `onContextLoss` 回退 DOM 渲染器。
- **构建链 Vite + `@vitejs/plugin-react` + Tailwind 4 延续**；tsconfig `jsx`
  改回 `react-jsx`；`vite-plugin-solid`、`solid-js`、`@kobalte/core`、
  `lucide-solid` 全部移除。Rejected: 双栈渐进迁移——只增熵。
- **路由保持手写 pathname 分流**（三条页面流独立 WS 连接：`/authorize/<token>`、
  `/proxy-auth`、主页面），不引路由库。Based on: 现状 `App.tsx` 手写分流，
  三者不共享连接与副作用是既有决策。
- **Supabase 换票保持直接 REST fetch，不引 supabase-js**（`lib/auth.ts` 原样保留）。
- **bundle 目标是"不显著回退"而非"追平 Solid"**：React 19 + radix 必然大于
  Solid 版的 586KB 主 chunk；约束为主 chunk < 700KB（010 之前旧 React 版水平），
  WebGL addon 保持异步 chunk，最终数值记入完成报告。性能地板指运行时行为
  （渲染/重渲染/PTY 路径），不以包体积论。
- **UI 文案保持中文、enroll 命令格式保持
  `npm i -g cofluxd && cofluxd up --server <url> --enroll-key <key>` 不变**（010 既有决策延续）。

## Direction

分层保持 010 架构：连接层（`connection.ts`，原样保留）→ store 层（zustand
vanilla store，翻译 `store.ts` 全部消息处理语义）→ React UI 层。UI 组件一对一
对译现有 SolidJS 组件（pages/、components/），不重新设计信息架构。

### Milestone 1: 构建链切换 + store 层迁移

React 19 + Compiler + zustand 的工程跑通（Vite dev/build、Tailwind、TS 全绿，
vite.config 中 Compiler 已启用）；zustand store 承载与现版等价的全部语义：
三凭证认证流、token 持久化（localStorage `coflux_token`）、authError 清 token、
有 token 首屏直接 authenticating 不闪登录页、snapshot 与全部增量消息落 store、
级联清理（daemonRemoved 级联清 projects/workspaces/tasks，projectRemoved 级联清
workspaces/tasks，workspaceRemoved 级联清 tasks，taskRemoved 清 ports/detached，
`store.ts:140-199` 语义）、consumer 注册表（`store.ts:77-92`）、snapshotRevision
递增语义。
Validation: `pnpm --filter @coflux/web build` exit 0。

### Milestone 2: 登录 + workbench 交互面

登录页（Supabase 换票 + 本地模式，`USE_SUPABASE` 构建期开关）；侧栏树
（设备分组 → 项目 → 工作区，在线/离线态）；工作区选择 + localStorage
`coflux_workspace` 持久化 + snapshot 后 fallback；对话框流（导入项目、新建
工作区、添加设备含 enroll 命令复制、删除确认）；error toast 含 dismiss。
Validation: `pnpm --filter @coflux/web build` exit 0。

### Milestone 3: 终端 + attach/接管状态机 + 多 Tab

TerminalPane（xterm + WebGL 动态加载 + fit + 主题）与 WorkspaceTerminal
（Tab 条 + 状态机）完整对译，逐条对齐 Landmines 1-14；端口预览链接
（Tab 内 :port 徽标 + 顶栏链接，新窗口打开）。
Validation: `pnpm --filter @coflux/web build` exit 0。

### Milestone 4: 辅助页 + Solid 清除 + 收尾

`/authorize/<token>` 与 `/proxy-auth?redirect=` 页面流语义等价迁移；
solid-js/kobalte/lucide-solid/vite-plugin-solid 依赖与残留 import 删净；
视觉走查确认 CSS 变量驱动的 Cursor 风与现版一致。
Validation: `pnpm --filter @coflux/web build` exit 0，且
`grep -rn "solid-js\|@kobalte\|lucide-solid" apps/web/src apps/web/package.json` 无结果。

## Landmines

attach/独占接管状态机语义（1-14 继承自 plan 010，行号已更新为当前 SolidJS 实现
位置，迁移必须逐条保持）：

1. **控制权四态** `stopped | attaching | owned | detached`（`terminal-pane.tsx:7`）；
   输入/resize 只在 `active && owned` 时发送（`terminal-pane.tsx:106-113`）——
   detached 下输入锁定是安全语义不是体验细节。
2. **attach 即 taskStart**：对 RUNNING 任务发 `taskStart{taskId,cols,rows}` 就是
   申请接管，没有独立 attach 消息。
3. **ATTACH_GRACE_MS=500**（`workspace-terminal.tsx:12,94-95`）：attach 后即使无
   ptyOutput 回放也要在 500ms 后判定 owned；有输出则立即 owned（`:160`）。
4. **attach 去重 key** `${snapshotRevision}:${sessionId}`（`workspace-terminal.tsx:82-85`）：
   同一快照代内对同一 session 只 attach 一次；强制接管用递增序列 key 绕过去重。
5. **sessionReady 门控**（`workspace-terminal.tsx:37,81,146`）：必须等 ptyOutput
   consumer 注册完成才能发 attach，否则 replay 字节在 consumer 注册前到达而丢失。
6. **新建启动 vs attach 区分**（`launchingTaskIds`，`workspace-terminal.tsx:41,116-119,150-152`）：
   自己发起启动的任务在 session 就绪后直接 markOwned，不发第二次 taskStart。
7. **snapshotRevision 变更 = 重连/重登**：必须对所有 RUNNING 任务重新 beginAttach
   重新申请 holder——server 侧旧连接的 holder 已失效，不重发就变成只读观众。
8. **taskDetached 广播处理**（`store.ts:202`，`workspace-terminal.tsx` 对应分支）：
   被他端接管 → 置 detached、清 attach key、终端内写系统提示行；重新接管走
   force claim（Tab 点击或横幅按钮）。detachedTaskIds 清除时机：任务非 RUNNING
   或新 snapshot 不含该任务。
9. **markOwned 后必须 fit + focus + ptyResize**（`workspace-terminal.tsx:61-75`）：
   拿到控制权即推本端尺寸给 PTY，否则远端 PTY 保持上一 holder 尺寸导致排版错乱。
10. **taskCreate 无请求-响应关联**（`pendingCreate`，`workspace-terminal.tsx:44,165`）：
    靠"快照增量中新出现的未知 task id"识别自己创建的任务并自动激活；error 消息
    到达时清 pending 态。
11. **Tab 切换用 display 隐藏而非卸载**（`terminal-pane.tsx:159`）：React 下这意味着
    **不能用 `{active && <TerminalPane/>}` 条件渲染**——所有打开的 Tab 必须持续
    挂载，用 style/display 切换可见性；卸载 xterm 丢 scrollback 与选区。隐藏容器
    上 `fit()` 会因无尺寸抛错，需 try/catch + ResizeObserver 重试
    （`terminal-pane.tsx:86,116-118`）。
12. **EXITED 任务重启前 reset 终端**，避免旧输出与新会话混叠。
13. **protobuf-es 嵌套 message 恒为 `T | undefined`**：所有
    `payload.value.task/daemon/project/workspace` 判空后使用。
14. **同通道快照/增量排序**：server 保证 stateSnapshot 先于其后的广播；客户端
    store 按到达顺序应用，不要自行加乱序缓冲。

React 迁移特有：

15. **zustand 更新的引用稳定性**：增量消息只重建被触及的实体对象与其所在集合
    容器，未变实体引用必须稳定，否则所有订阅该集合的选择器全部触发重渲染，
    性能地板失守。派生集合选择器（如"某工作区的任务列表"）必须 `useShallow`。
16. **xterm/WS 等命令式资源放 useRef + useEffect，cleanup 必须完整**
    （terminal.dispose 一并处理 addons，`terminal-pane.tsx:155`）；React Compiler
    只优化符合 Rules of React 的组件，违反规则的组件会被静默跳过优化——建议
    启用 `eslint-plugin-react-hooks` 最新版的 compiler 规则做静态检查。
17. **SolidJS → React 的语义陷阱**：现代码中 `untrack(...)`（如
    `workspace-terminal.tsx:84,151`）在 React 无对应物，翻译时直接读
    `store.getState()`；Solid 组件体只跑一次而 React 组件体每次渲染都跑——
    现组件体内的一次性初始化逻辑（Map/Set 实例、定时器句柄）必须移入
    useRef/useEffect，不能留在函数体。

## Scope

In scope:
- `apps/web/**`（src 全部对译、package.json 依赖重置、tsconfig/vite 配置）
- 根 `pnpm-lock.yaml`（随依赖变更）

Out of scope:
- `packages/protocol`、`apps/server`、`crates/**`、`proto/**`、`tests/**` ——
  协议与后端零改动；黑盒测试不测 web
- `.github/workflows/ci.yml` —— 现有 `tsc -b apps/web/tsconfig.json` 检查应继续通过
- 生产部署（Caddy/prod-jp）—— 主会话验收后执行
- 任何新功能与视觉重设计 —— 能力与视觉严格保持 010 产物现状

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + 构建 | `pnpm --filter @coflux/web build` | exit 0 |
| CI 同款 typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Solid 残留检查 | `grep -rn "solid-js\|@kobalte\|lucide-solid" apps/web/src apps/web/package.json` | 无结果 |
| Compiler 启用检查 | `grep -n "react-compiler" apps/web/vite.config.ts` | 命中 |
| 黑盒回归 (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test` | 37/37 pass |
| UI 冒烟 (acceptance) | dev 栈 + Playwright 浏览器走查：登录→添加设备→导项目→建工作区→多 Tab 终端→输入回显→关 Tab→二客户端接管→重新接管→端口预览→登出 | 全主路径可用，接管语义正确 |
| 生产构建 (acceptance) | `VITE_SUPABASE_URL=<prod url> VITE_SUPABASE_ANON_KEY=<prod key> pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 能力清单与现版（010 产物）逐项等价，无功能增减，视觉近似不变。
- [ ] Landmines 1-17 的语义在新实现中逐条成立。
- [ ] PTY 数据路径不经过任何 React/zustand 状态（代码审查可见：ptyOutput → consumer → terminal.write）。
- [ ] xterm WebGL 动态加载 + context loss 回退保持。
- [ ] solid-js/@kobalte/lucide-solid/vite-plugin-solid 从 apps/web 完全移除。
- [ ] React Compiler 在构建链中启用。
- [ ] 主 chunk < 700KB（数值记入完成报告）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（尤其：发现需改协议或 server 才能等价复刻时，停下报告）。
- A validation command fails twice after one reasonable fix.
- `babel-plugin-react-compiler` 与当前 Vite/React 19 版本存在无法绕过的构建兼容
  问题（关闭 Compiler 属方向变更，须报告而非静默降级）。
- radix-ui 某 primitive 与 Tailwind 4 / 现有 CSS 变量体系无法达成视觉等价（换
  组件基座属方向变更，须报告）。

## Maintenance notes

- 本计划后 attach 状态机语义的文档源仍是 Landmines 清单（1-14 与 plan 010 一致，
  15-17 为 React 特有）；改接管行为先更新这里。
- "PTY 字节流零响应式"与"实体引用稳定性"是两条性能地板红线，后续任何状态层
  改造（换库、加中间件）都必须先对这两条做影响评估。
- 框架决策史：React 18（初版）→ SolidJS（plan 010，性能动机）→ React 19 + Compiler
  （本计划，生态动机）。除非生态格局再次变化，框架选型视为已终局，不再摇摆。
