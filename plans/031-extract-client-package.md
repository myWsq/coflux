# Plan 031: 抽取 packages/client —— 协议 client + store 双端共享

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 3ab2c65..HEAD -- apps/web/src/client apps/web/src/config.ts apps/web/src/lib/auth.ts packages/`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: refactor
- Execution: subagent sonnet
- Planned at: `3ab2c65`, 2026-07-23

## Requirement

移动随身端（plan 032）与桌面 web 需要共享同一份协议 client：连接管理
（`apps/web/src/client/connection.ts`，117 行）与控制面 store
（`apps/web/src/client/store.ts`，438 行，zustand **vanilla**，不绑 React）。
本计划把这两个文件抽成 workspace 包 `packages/client`（`@coflux/client`），
桌面 web 改为从包导入。

红线：**桌面 web 行为零变化**。这是纯结构性搬移 + 环境耦合注入化，不新增任何
功能、不改任何协议语义。正确解与相邻错误解的分界：错误解是包内仍残留
`import.meta.env` / app 特定常量（换个位置的耦合）；正确解是包只依赖注入的
options 与 `@coflux/protocol`，任何浏览器 app 传入自己的 config 即可复用。

## Decisions & tradeoffs

- **包边界**：`connection.ts` + `store.ts` 整体迁入 `packages/client/src`，
  `createCofluxClient` 与全部导出类型（`CofluxClient`、`CofluxState`、
  `FsListResult`、`ExecResult`、`FsWriteResult`、`ConnectionStatus`、
  `PortPreview`、`ClientError`、`AuthState` 等）从包根导出。Rejected: 只抽
  connection 留 store —— store 才是移动端要复用的大头（快照/增量归约、
  pending-map 请求响应关联、PTY consumer 注册表）。Based on:
  `apps/web/src/client/store.ts:62-436`（工厂函数自包含，UI 无关）。
- **环境耦合注入化**：store 对 app 的全部依赖只有
  `apps/web/src/client/store.ts:12-13` 两行——`@/config` 的
  `SERVER_URL`/`TOKEN_KEY`/`USE_SUPABASE`/`AuthCredential` 与 `@/lib/auth` 的
  `loginWithSupabase`（23 行，fetch 直连 Supabase token 端点，无 SDK 依赖）。
  改为 `createCofluxClient(options)` 注入：`serverUrl`、`tokenStorageKey`、
  以及一个可选的外部登录提供者（其存在与否即现 `USE_SUPABASE` 语义，同时决定
  authError 时的两种文案，见 `store.ts:159`）。`AuthCredential` 类型随包走；
  `loginWithSupabase` 本身留在 apps/web（它读 `VITE_SUPABASE_*`，是 app 层
  配置的一部分），web 侧作为登录提供者传入。包内不出现 `import.meta.env`。
  Rejected: 包内直读 env —— vite 前缀约定是 app 层关注点，包应环境无关。
- **包形态照抄 `@coflux/protocol`**：private、`type: module`、`main`/`types`/
  `exports` 直指 `./src/index.ts`，无构建步骤；依赖 `@coflux/protocol`
  (workspace:\*) 与 `zustand`。Based on: `packages/protocol/package.json`
  （source-direct 形态）、`pnpm-workspace.yaml`（`packages/*` 已覆盖）。
- **localStorage 留在包内**：token 持久化（`store.ts:63,150,157`）是浏览器
  client 的固有职责，两端（都是浏览器 app）共享；storage key 经 options 注入。
  Rejected: 把持久化也抽象成接口 —— 没有非浏览器消费者，YAGNI。
- **web 侧只改 import 路径与装配点**：`@/client/store` / `@/client/connection`
  的所有引用改为 `@coflux/client`；创建处（`App.tsx` 一带）传入由
  `@/config`/`@/lib/auth` 组装的 options。`apps/web/src/config.ts` 与
  `lib/auth.ts` 保留原位。web `package.json` 增加 `@coflux/client`
  workspace 依赖；zustand 依赖两处并存无妨（版本同源 workspace lockfile）。

## Direction

一次性的结构搬移：建包 → 迁文件 → 注入化 → 改 web 引用。搬移中不顺手重构、
不改注释措辞、不动 store 内部逻辑（diff 应当呈现为「文件移动 + 注入点小改 +
import 改写」，而非逻辑重写）。

### Milestone 1: packages/client 成包

包存在、导出完整、内部零 app 耦合（无 `import.meta.env`、无 `@/` 别名引用）。
Validation: `pnpm --filter @coflux/web build` → exit 0（此时 web 已切换引用，
见 M2；若执行者选择两步走，以最终态为准）。

### Milestone 2: web 切换到包引用

`apps/web/src/client/` 目录删除，所有引用改从 `@coflux/client` 导入，web 构建
通过。Validation: `pnpm --filter @coflux/web build` → exit 0；
`grep -rn "client/store\|client/connection" apps/web/src` → 无残留引用。

## Landmines

- `apps/web` 的 `@/` 路径别名由其 vite/tsconfig 配置提供，仅在 app 内有效——
  包内代码不能使用，迁移时两处 `@/` import（`store.ts:12-14`）必须消解。
- `connection.ts` 需自查对 `@/config` 是否有隐藏依赖（recon 只确认了
  `createConnection({url})` 参数化；若有残留 env 读取一并注入化）。
- `tests/` 黑盒测试直连 `@coflux/protocol`，不引用 web client，不受影响；
  不要为它加 `@coflux/client` 依赖。
- `packages/core` 是 server/daemon 侧共享基建（读 `process.env`，
  `packages/core/src/index.ts:12-14`），不要把 client 放进去——浏览器端引它会
  炸 `process` 未定义。

## Scope

In scope:

- `packages/client/**`（新建）
- `apps/web/src/client/**`（删除/迁出）
- `apps/web/src/**`（仅 import 路径与 client 创建处的装配代码）
- `apps/web/package.json`（新增 workspace 依赖）
- `pnpm-lock.yaml`（随 install 更新）

Out of scope:

- `apps/server`、`crates/`、`packages/protocol`、`packages/core` —— 协议与
  服务端不动
- 桌面 web 任何可见行为变化 —— 红线
- `apps/mobile` —— plan 032 的事

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| 残留引用检查 | `grep -rn "@/client" apps/web/src` | 无输出 |
| 桌面回归冒烟 (acceptance) | Playwright MCP，1440×900：登录 → 选工作区 → 终端出现 → 变更视图 | 与基线行为一致 |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` 通过。
- [ ] `packages/client` 内无 `import.meta.env`、无 `@/` 别名、无 supabase 具体逻辑。
- [ ] `apps/web/src/client/` 已不存在，web 全部经 `@coflux/client` 导入。
- [ ] 桌面 web 行为零变化（acceptance 冒烟通过）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- store/connection 中发现无法经 options 注入消解的 app 耦合（意味着边界判断错误，需回到规划）。

## Maintenance notes

- `@coflux/client` 是双端（apps/web、apps/mobile）共享的协议消费层真相源；
  改协议语义（快照归约、控制权状态、pending-map）只改这一处。
- 包 API 是 `createCofluxClient(options)` 一个工厂；新增注入项时保持「app 层
  组装、包层无环境」的边界。
