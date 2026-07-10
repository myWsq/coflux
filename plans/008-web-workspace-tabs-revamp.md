# Plan 008: Web 端交互重塑 —— 工作区多终端 Tab（Cursor 式任务台，后端零改动）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 9d0cabf..HEAD -- apps/web pnpm-lock.yaml apps/server/src/hub.ts packages/protocol/src/index.ts`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: agent:codex
- Planned at: `9d0cabf`, 2026-07-11

## Requirement

现有 web 端（`apps/web/src/App.tsx`，780 行单文件）功能通路完整但交互是毛坯：创建流程全靠
`window.prompt`/`confirm`，侧边栏是「项目 → 工作区 → 任务」三层树，右侧只有一个全局 xterm，
切任务清屏重放。本计划把它重塑为 Cursor 式工作台：

- **侧边栏两层**：项目为一级项，点项目本身进入其主工作区（`isMain`）；子工作区（git worktree）
  挂在项目下，点子项进入对应工作区。
- **主区域以工作区为上下文**：顶部横向终端 Tab，一个 Tab 对应一个 task（task = PTY 会话）；
  `+` 新建终端并立即启动 shell，`×` 停止并删除该 task（running 时弹确认）。「任务」一词从界面
  隐去，用户心智是「工作区里的多个终端」。
- **创建流全部正式 UI**：导入项目、新建工作区、添加设备均为 Dialog 表单，`window.prompt`/
  `window.confirm` 在 `apps/web/src` 中归零。
- **视觉**：Tailwind CSS v4 + shadcn/ui（暗色主题），观感对标 Cursor/Codex 网页端。

后端、daemon、protocol 零改动。正确解与相邻错误解的分界：**协议行为、消息序、登录/授权/门禁
三条独立页面流的语义都不变，变的只有浏览器内的组织与呈现**。

## Decisions & tradeoffs

- **信息架构：侧边栏「项目 + 工作区」两层，点项目=进主工作区**。Rejected: 扁平任务流、
  三层树（项目→工作区→任务）——用户在探索阶段明确选定两层方案；任务不再出现在侧边栏。
  Based on: 主工作区有 `isMain` 标记且排序在前（`apps/web/src/App.tsx:359-360`）。
- **一个终端 Tab = 一个 task**。Tab 列表 = 当前工作区的全部 task；这同时落地了
  OPEN_QUESTIONS B4（一个工作区多终端）。Rejected: 引入新的「终端」实体或改 task 模型——
  后端零改动是硬边界。Based on: task 状态机 idle/running/exited、一 task 一 sessionId
  （`packages/protocol/src/index.ts`，`apps/server/src/hub.ts:869-896`）。
- **Tab 关闭 = 停止并删除（task.stop + task.remove），running 时弹确认；不保留 exited 尸体**。
  打开 Tab / 新建 Tab 后统一发 `task.start`，服务端对 running 任务自动转为 attach+回放
  （`apps/server/src/hub.ts:873-879`）。Rejected: 关闭=仅停止、保留历史列表——用户拍板选删除，
  顺带消掉「exited task 长期累积」问题（ROADMAP 条目 4）。
- **后端/daemon/protocol 零改动**。Agent 自动拉起（B5）、task 携带启动命令，全部不做，
  任务仍是纯 shell。Rejected: 顺手加协议回执/启动命令——留给后续计划。
- **技术栈：保持 Vite SPA，新增 Tailwind CSS v4 + shadcn/ui（Radix 原语，组件源码复制入仓）**。
  Rejected: Next.js/React Router（登录墙后的纯 WS 应用不需要 SSR）；手写 CSS（弹层/下拉/焦点
  管理成本高）。调研依据：Codex 网页版（Tailwind v4 + Radix）与 cursor.com（Tailwind + token）
  同源收敛。
- **不引路由库**：`/authorize/<token>`、`/proxy-auth` 维持现有 pathname 分支
  （`apps/web/src/App.tsx:24-29`）；主界面选中的工作区 id 存 localStorage，刷新恢复，不进 URL。
  Rejected: react-router——两个特殊页 + 单主界面撑不起一个路由库。
- **多 xterm 常驻，帧按 sessionId 分发**：当前工作区内每个 Tab 一个 xterm 实例，切 Tab 即时
  切换不清屏；二进制帧到达时按 `frame.sessionId` 路由到对应 xterm，**废除现有「单
  activeSession 过滤、其余丢弃」的做法**（`apps/web/src/App.tsx:126-129`，OPEN_QUESTIONS A8）。
  切换工作区销毁旧工作区的 xterm 实例，重进靠 daemon 侧 scrollback 回放（200k 字符缓冲）。
  Based on: holder 是 per-session 的，同一 client 可同时持有多个 session，`pty.output` 只发给
  对应 session 的 holder（`apps/server/src/hub.ts:88`、`158-164`、`197-211`）——协议原生支持，
  无串扰。
- **桌面优先（≥1024px），不做小屏适配**。Rejected: 响应式/移动端优化——用户拍板本轮不管。
- **新建终端的自动打开用前端启发式**（decided while planning）：`task.create` 无回执，新 task
  只能从 `task.updated` 广播识别（`apps/server/src/hub.ts:700-711`）。做法：点 `+` 后记一个
  「等待新 task」标志，收到本工作区内首个未见过的 task 即视为它，自动 `task.start` 并激活 Tab。
  多 client 同时创建可能误认——单用户产品，可接受。Rejected: 协议加 requestId 回执——违反
  零后端改动。
- **被接管的 Tab 标记态**（decided while planning）：收到 `task.detached{taskId}` 只把对应
  Tab 标为「已被其它客户端接管」，不影响其它 Tab；点击该 Tab 重新 `task.start` 夺回。输入
  无控制权时服务端会回 error 消息（`apps/server/src/hub.ts:240-243`），UI 应在接管态下阻止输入
  而非依赖该报错。

## Direction

现有 `App.tsx` 的 WS 协议逻辑（登录换票、token 重连、二进制帧编解码、消息 reducer）是经过
生产验证的，重构是**搬运与拆分**，不是重写协议层。建议结构：WS 连接与状态收敛为一个
hook/store 模块，视图层（侧边栏、工作区 Tab 区、各 Dialog、三个独立页面）纯消费状态。
具体模块划分由执行者对着现行代码设计。

### Milestone 1: 样式基建接入

Tailwind CSS v4 + shadcn/ui 进入 `apps/web`（暗色主题为默认），现有功能不回归。
Validation: `pnpm -C apps/web build` → exit 0。

### Milestone 2: 协议层拆分 + 多 session 数据面

`App.tsx` 拆为模块化结构；二进制帧按 `frame.sessionId` 分发到注册的 per-session 消费者；
AuthorizePage / ProxyAuthPage 保持独立组件树与独立 WS 连接不动。
Validation: `pnpm -C apps/web build` → exit 0。

### Milestone 3: 新信息架构落地

侧边栏两层（项目=主工作区入口 + 子工作区）；主区域工作区多终端 Tab（常驻 xterm、`+`/`×`
语义、接管态标记、端口预览徽标挂 Tab 与顶部条）；选中工作区 localStorage 恢复；设备区保留
在侧边栏底部。
Validation: `pnpm -C apps/web build` → exit 0。

### Milestone 4: 创建流 Dialog 化 + 收尾

导入项目（选在线设备 + 仓库路径）、新建工作区（名称/分支/新建或检出已有）、添加设备（登记
命令展示与复制）、删除类确认（项目/工作区/设备/running Tab）全部为 shadcn Dialog/AlertDialog；
登录页与两个独立页面换新皮但流程不变；空态文案（无项目/无设备/无终端）完整。
Validation: `pnpm -C apps/web build` → exit 0 且
`rg -n "window\.prompt|window\.confirm|\balert\(" apps/web/src` → 无匹配（exit 1）。

## Landmines

- **三棵组件树各自独立 WS 连接，绝不合并**（`apps/web/src/App.tsx:22-29`）：授权页/门禁页
  不能触发主 app 的 xterm、自动重连、subscribe 副作用——plan 003 时踩过，页面挂上主 app
  effect 会导致授权流互相干扰。重构后仍须保持三条页面流的连接隔离。
- **控制权在回放返回时才转移**（`apps/server/src/hub.ts:213-225`）：`task.start`（对 running
  任务）→ 服务端向 daemon 请求 replay → replay 帧回来才 `setHolder`。attach 多个任务是逐个
  异步完成的，期间实时输出仍发旧 holder；前端不要假设 `task.start` 发出即拥有控制权。
- **回放以 `pty.output` 帧形态到达**（`apps/server/src/hub.ts:217-221`）：客户端无需处理
  `pty.replay` 类型，但必须在发起 attach 前就把对应 xterm 的帧路由注册好，否则回放帧被丢。
- **慢消费者保护会断整条 WS**（`apps/server/src/hub.ts:200-207`）：client `bufferedAmount`
  超限直接 1013 断连。多 xterm 常驻增大输出量，渲染侧用 xterm 常规 `write`（自带缓冲）即可，
  不要在帧回调里做同步昂贵操作。
- **`pty.resize`/`pty.input` 都要求 holder 权**（`apps/server/src/hub.ts:240-243`、`752`）：
  只对激活且未被接管的 Tab 发 resize/input；对全部常驻 Tab 广播 resize 会收到一串 error。
- **Supabase 登录是 build-time 开关**（`apps/web/src/App.tsx:15-17`）：`VITE_SUPABASE_URL/
  _ANON_KEY` 未设时走 local 用户名密码模式。本地 `pnpm -C apps/web build` 不带变量也必须绿；
  不要把这两个 env 变成必需。
- **`enrollmentKey.created` 的安装命令展示**（`apps/web/src/App.tsx:287-288`）：添加设备
  Dialog 要承接这条异步消息（点按钮 → 等服务端回 key → 展示命令），不是同步表单。

## Scope

In scope:
- `apps/web/**`（src、index.html、package.json、vite.config.ts、tsconfig.json、样式与
  shadcn/Tailwind 配置文件）
- `pnpm-lock.yaml`（仅随 apps/web 依赖新增而变）

Out of scope:
- `apps/server/**`、`crates/**`、`packages/**` — 后端/daemon/protocol 零改动是本计划硬边界
- `tests/**` — 黑盒测试不覆盖 web，UI 无既有自动化基线
- `docs/**`、`plans/`（除本计划状态行）— 文档另行处理
- Agent 自动拉起（B5）、`fs.*` 文件树、移动端适配 — 后续计划

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm -C apps/web build` | exit 0 |
| prompt/confirm 归零 | `rg -n "window\.prompt\|window\.confirm\|\balert\(" apps/web/src` | 无匹配（exit 1） |
| 后端黑盒回归 (acceptance) | `COFLUX_TEST_PG_URL=<54322 直连口> pnpm -C tests test` | exit 0（守护「后端零改动」） |
| UI 冒烟 (acceptance) | dev server + 浏览器走查：登录→导入项目→建工作区→多 Tab 终端→关 Tab→设备管理 | 全流程可用 |

## Done criteria

- [ ] `pnpm -C apps/web build` 通过。
- [ ] `apps/web/src` 中 `window.prompt`/`window.confirm`/`alert(` 零残留。
- [ ] 侧边栏两层 IA、工作区多终端 Tab（`+` 即开 shell、`×` 停止并删除带确认）、常驻 xterm
      切 Tab 不清屏，行为与 Decisions 各条一致。
- [ ] AuthorizePage / ProxyAuthPage / 主 app 三条页面流保持独立 WS 连接与原有语义。
- [ ] `git diff` 改动仅落在 In scope 路径内（尤其 `apps/server`、`packages`、`crates` 零 diff）。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- Decisions & tradeoffs 引用的任一代码事实不再成立（尤其 hub.ts 的 holder/replay 语义）。
- 实现被迫触碰 out-of-scope 文件（如发现必须改协议才能达成交互）。
- 某验证命令经一次合理修复后仍连续失败两次。
- 依赖安装或 shadcn 初始化与 pnpm workspace 结构冲突且无干净解法。

## Maintenance notes

- 帧分发从「单 activeSession 过滤」改为「按 sessionId 注册路由」后，OPEN_QUESTIONS A8 的
  描述随之过时，后续文档更新时应修订。
- 「新建终端自动打开」的启发式依赖单用户假设；将来若有协作场景，应回到协议层加创建回执。
- shadcn 组件源码入仓后属于本仓库代码：升级靠重新生成覆盖，不走 npm 版本。
