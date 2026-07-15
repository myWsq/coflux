# Plan 010: Web 客户端 SolidJS 全量重写（能力等价 + Cursor 风 UI + 性能地板）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat bc9fec3..HEAD -- apps/web packages/protocol/src/index.ts`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: refactor
- Execution: subagent sonnet
- Planned at: `bc9fec3`, 2026-07-16

## Requirement

apps/web 现有 React 实现按 demo 归零，整体重写为 SolidJS。**功能能力与视图模型严格保持现状、不加新功能**：登录（Supabase 换票 / 本地账号双模式）、设备管理与登记密钥、项目导入、工作区（worktree）创建/删除、工作区选择持久化、多终端 Tab（plan 008 语义）、attach/独占接管、端口预览链接、`/authorize` 设备授权页、`/proxy-auth` 预览域门禁页。

重写要达成的两件事：

1. **UI 参照 Cursor**：IDE 形态骨架（侧栏树 + 编辑器式终端 Tab）、深色优先、低饱和灰阶、细边框分层（非阴影）、高信息密度小字号、克制强调色（状态点/警示）。
2. **性能地板一次做对**：xterm WebGL 渲染、PTY 数据流零响应式开销、细粒度响应式状态（增量消息 → 原地更新，无重渲染风暴）、重连不清屏（乐观 UI）、bundle 瘦身。

正确性的判别标准：一个熟悉旧版的用户操作全部主路径感觉"功能一样但更快更精致"；多客户端接管语义与旧版逐条一致（见 Landmines 的状态机语义清单——这是本计划最高风险移植点）。

## Decisions & tradeoffs

- **框架 SolidJS（signals 即状态层，不引状态库）**。Rejected: React 19 + Compiler——渲染模型仍是 VDOM 重渲染，与高频 WS 增量数据流不同构；Svelte 5——放弃 JSX，迁移心智成本高于 Solid。Based on: 增量消息驱动的实体集合更新遍布 `use-coflux-client.ts:140-270`。
- **构建链 Vite + vite-plugin-solid + Tailwind 4 + TS7 延续**。Tailwind 4 经 `@tailwindcss/vite`（apps/web/package.json devDeps 已有）。tsconfig 需按 Solid 要求改 jsx 配置；TS7 下 `baseUrl` 已删除、paths 相对 tsconfig 解析（apps/web/tsconfig.json 现状）。
- **组件基座 Kobalte + 自建 Cursor 风 design token**。Rejected: 继续 shadcn/radix——React 专属不可用。现有 `src/index.css` 的 CSS 变量（background/border/muted/accent/warning/terminal 等）语义可沿用重定值，图标换 `lucide-solid`（现用 lucide-react，apps/web/package.json:12）。
- **终端 xterm.js 延续 + 新增 `@xterm/addon-webgl`**。Rejected: 换终端库——xterm 是唯一成熟选项且 scrollback/主题已调好。WebGL addon 必须处理 context loss（`onContextLoss` → dispose addon 回退 DOM 渲染器），否则息屏/切显卡后白屏。主题色板沿用 `terminal-pane.tsx:68-82`。
- **PTY 数据流绝不进响应式状态**：ptyOutput 经命令式 consumer 注册表（sessionId → Set<consumer>）直达 `terminal.write`，signals 只承载控制面（实体集合/连接态/控制权态）。Based on: 现实现同此模型（`use-coflux-client.ts:47,254-258`），这是性能地板的核心不变量。
- **重连策略升级：固定 1.5s → 指数退避 + 抖动（约 1s 起步、上限 ~15s）；断线期间保留最后快照渲染 + 顶部重连横幅，不清空状态**。Rejected: 沿用固定间隔 + 断线白屏——与"性能/体验地板"目标冲突。注意：重连成功后新 snapshot 全量覆盖本地实体（旧语义，`use-coflux-client.ts:163-177`），且必须触发所有 RUNNING 任务重新 attach（见 Landmines #7）。
- **Supabase 换票保持直接 REST（password grant fetch），不引 supabase-js**。Based on: `src/lib/auth.ts` 全部 23 行即完整实现，引 SDK 纯增 bundle。
- **三条页面流保持独立 WS 连接、按 pathname 分流**（`/authorize/<token>`、`/proxy-auth`、主页面）。用 @solidjs/router 或保持手写 pathname 分流均可（executor's call，现状是 11 行手写分流 `App.tsx`）；关键是三者不共享连接与副作用（`App.tsx:5` 注释的既有决策）。
- **旧 React 代码与依赖全删**：react/react-dom/@radix-ui/*/class-variance-authority/lucide-react 从 apps/web/package.json 移除；`src/` 下 React 实现整体替换。Rejected: 双栈渐进迁移——重写决策已定，双栈只增熵。
- **黑盒测试与 server/协议零改动**：`tests/` 只驱动 server/daemon 不碰 web；`packages/protocol` encode 已返回 `Uint8Array<ArrayBuffer>` 可直接喂 `WebSocket.send`（packages/protocol/src/index.ts:67-71，TS7 提交已收敛），协议包不需要任何改动。
- **（decided while planning）UI 文案保持中文**、enroll 命令格式保持 `npm i -g cofluxd && cofluxd up --server <url> --enroll-key <key>`（`use-coflux-client.ts:251`）——web UI 与用户习惯/文档耦合，不借重写改文案语义。

## Direction

新实现建议结构（executor 可调整，边界不变）：协议客户端层（WS 连接/认证/重连/发送 + consumer 注册表，纯 TS 无框架依赖）→ 状态 store 层（signals/createStore，消费信封 payload 更新实体集合）→ UI 层（workbench/终端/对话框/辅助页）。

### Milestone 1: 基座 + 协议客户端 + 登录

Solid 工程跑通（Vite dev/build、Tailwind、TS7 全绿）；WS 客户端具备三凭证认证（token/supabaseToken/username+password）、authOk→clientSubscribe、token 持久化（localStorage `coflux_token`）、authError 清 token、指数退避重连、有 token 首屏直接 authenticating 不闪登录页（`use-coflux-client.ts:51-59` 语义）；snapshot 与全部增量消息（daemon/project/workspace/task/ports/taskDetached/enrollmentKeyCreated/error）落入 store，级联清理语义对齐（`use-coflux-client.ts:185-217`：daemonRemoved 级联清 projects/workspaces/tasks，projectRemoved 级联清 workspaces/tasks，workspaceRemoved 级联清 tasks，taskRemoved 清 ports/detached）。登录页可用（Supabase 换票 + 本地模式，`USE_SUPABASE` 构建期开关）。
Validation: `pnpm --filter @coflux/web build` exit 0。

### Milestone 2: workbench 交互面

侧栏树（设备分组 → 项目 → 工作区，在线/离线态），工作区选择 + localStorage `coflux_workspace` 持久化 + snapshot 后 fallback（首项目 main workspace，`workbench.tsx:29-44` 语义）；对话框流：导入项目（选 daemon + 路径）、新建工作区（分支/新建分支）、添加设备（requestEnrollmentKey → enroll 命令展示复制）、删除项目/工作区/任务确认；error toast（含 dismiss）。
Validation: `pnpm --filter @coflux/web build` exit 0。

### Milestone 3: 终端 + attach/接管状态机 + 多 Tab

TerminalPane（xterm + WebGL + fit + 主题）与 WorkspaceTerminal（Tab 条 + 状态机）完整移植，逐条对齐 Landmines 清单语义；端口预览链接（Tab 内 :port 徽标 + 顶栏链接，新窗口打开）。
Validation: `pnpm --filter @coflux/web build` exit 0。

### Milestone 4: 辅助页 + 视觉打磨 + 收尾

`/authorize/<token>`（authOk → deviceAuthorizeInfo{token} 展示设备信息 → deviceAuthorize → deviceAuthorized 成功态；authError/失效态）；`/proxy-auth?redirect=`（authOk → proxyIssueAuth{redirect} → proxyAuth{ok,url} → `location.replace(url)`；未登录先走登录表单）。Cursor 风 token 统一走查（密度/边框/强调色）；删净 React 遗留依赖与文件；bundle 主 chunk 应显著低于现状 700KB（React+radix 移除后预期 <400KB，非硬门槛但需在完成报告中记录数值）。
Validation: `pnpm --filter @coflux/web build` exit 0，且 `grep -r "from \"react\"" apps/web/src` 无结果。

## Landmines

attach/独占接管状态机的既有语义（`workspace-terminal.tsx` + `terminal-pane.tsx`），重写必须逐条保持：

1. **控制权四态** `stopped | attaching | owned | detached`（`terminal-pane.tsx:6`）；输入/resize 只在 `active && owned` 时发送（`terminal-pane.tsx:113-124`）——detached 下输入锁定是安全语义不是体验细节。
2. **attach 即 taskStart**：对 RUNNING 任务发 `taskStart{taskId,cols,rows}` 就是申请接管（server 端 startOrAttachTask 复用语义），没有独立的 attach 消息。
3. **ATTACH_GRACE_MS=500**（`workspace-terminal.tsx:14,92-95`）：attach 后即使无 ptyOutput 回放（空 scrollback）也要在 500ms 后判定 owned；有输出则立即 owned（`handleOutput:156-158`）。
4. **attach 去重 key** `${snapshotRevision}:${sessionId}`（`workspace-terminal.tsx:81-84`）：同一快照代内对同一 session 只 attach 一次；强制接管（force claim）用递增序列 key 绕过去重。
5. **sessionReady 门控**（`workspace-terminal.tsx:80,142-154`）：必须等 ptyOutput consumer 注册完成（sessionId 就位）才能发 attach，否则 replay 字节会在 consumer 注册前到达而丢失。
6. **新建启动 vs attach 区分**（`launchingTaskIds`，`workspace-terminal.tsx:39,115-121,147-149`）：自己发起启动的任务在 session 就绪后直接 markOwned，不再发第二次 taskStart。
7. **snapshotRevision 变更 = 重连/重登**：必须对所有 RUNNING 任务重新 beginAttach 重新申请 holder（`workspace-terminal.tsx:218-231`）——server 侧旧连接的 holder 已失效，不重发就变成只读观众。
8. **taskDetached 广播处理**（`workspace-terminal.tsx:207-216`）：被他端接管 → 置 detached、清 attach key、终端内写系统提示行；重新接管走 force claim（Tab 点击或横幅按钮，`:294,374`）。detachedTaskIds 的清除时机：任务非 RUNNING 或新 snapshot 不含该任务（`use-coflux-client.ts:174-175,222-224`）。
9. **markOwned 后必须 fit + focus + ptyResize**（`workspace-terminal.tsx:68-75`）：拿到控制权即把本端尺寸推给 PTY，否则远端 PTY 保持上一个 holder 的尺寸导致排版错乱。
10. **taskCreate 无请求-响应关联**（`pendingCreateRef`，`workspace-terminal.tsx:42,160-165,188-196`）：靠"快照增量中新出现的未知 task id"识别自己创建的任务并自动激活；error 消息到达时清 pending 态（`:233-241`）。
11. **Tab 切换用 display 隐藏而非卸载**（`terminal-pane.tsx:163`）：卸载 xterm 会丢 scrollback 与选区；隐藏容器上 `fit()` 会因无尺寸抛错，需 try/catch + ResizeObserver 重试（`terminal-pane.tsx:89-96`）。
12. **EXITED 任务重启前 reset 终端**（`workspace-terminal.tsx:116`），避免旧输出与新会话混叠。
13. **protobuf-es 嵌套 message 恒为 `T | undefined`**：所有 `payload.value.task/daemon/project/workspace` 需判空后使用（`use-coflux-client.ts:181` 注释的既有约定）。
14. **同通道快照/增量排序**：server 保证 stateSnapshot 先于其后的广播（hub.ts:585 landmine 注释）；客户端 store 直接按到达顺序应用即可，不要自行加乱序缓冲。

## Scope

In scope:
- `apps/web/**`（src 全部重写、package.json 依赖重置、tsconfig/vite 配置、index.css）
- 根 `pnpm-lock.yaml`（随依赖变更）

Out of scope:
- `packages/protocol`、`apps/server`、`crates/**`、`proto/**`、`tests/**` —— 协议与后端零改动；黑盒测试不测 web
- `.github/workflows/ci.yml` —— 现有 `tsc -b apps/web/tsconfig.json` 检查应继续通过，无需改 CI
- 生产部署（Caddy/prod-jp）—— 由主会话在验收后执行，不属于本计划
- 任何新功能（通知、文件树、git 视图、任务聚合视图等）—— 明确排除，能力保持现状

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + 构建 | `pnpm --filter @coflux/web build` | exit 0 |
| CI 同款 typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| React 残留检查 | `grep -rn "react" apps/web/package.json` | 无 react 运行时依赖 |
| 黑盒回归 (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test` | 37/37 pass |
| UI 冒烟 (acceptance) | dev 栈 + Playwright 浏览器走查：登录→添加设备→导项目→建工作区→多 Tab 终端→输入回显→关 Tab→二客户端接管→重新接管→端口预览→登出 | 全主路径可用，接管语义正确 |
| 生产构建 (acceptance) | `VITE_SUPABASE_URL=<prod url> VITE_SUPABASE_ANON_KEY=<prod key> pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 能力清单与旧版逐项等价（Requirement 首段），无功能增减。
- [ ] Landmines 清单 1-14 的语义在新实现中逐条成立。
- [ ] PTY 数据路径不经过任何响应式状态（代码审查可见：ptyOutput → consumer → terminal.write）。
- [ ] xterm 启用 WebGL 渲染且有 context loss 回退。
- [ ] React 及其生态依赖从 apps/web 完全移除。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files（尤其：发现需要改协议或 server 才能等价复刻某能力时，停下报告而非改后端）。
- A validation command fails twice after one reasonable fix.
- Kobalte 或 @xterm/addon-webgl 与 Solid/现有 xterm 版本存在无法绕过的兼容问题（换库属方向变更，须报告）。

## Maintenance notes

- attach 状态机语义此后以本计划 Landmines 清单为文档源；改动接管行为时先更新这里。
- Cursor 风 token 集中在 index.css CSS 变量；后续主题调整只动变量不动组件。
- 若未来做任务聚合/通知（Agent 指挥中心的差异化能力），在本次 store 分层上加视图即可，不应再动协议客户端层。
