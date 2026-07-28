# Plan 060: web + mobile 登录收敛——删除 Supabase 直连，统一邮箱密码直发

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD -- apps/web apps/mobile packages/client`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: plans/059-server-password-auth.md
- Category: migration
- Execution: subagent sonnet
- Planned at: `c772ed4`, 2026-07-28

## Requirement

059 之后 server 不再接受 `supabaseToken` 换票（`COFLUX_AUTH` 只剩 local | password），三端登录契约冻结为：直发 `clientAuth { username, password, clientVersion }`。本 plan 让 web 与 mobile 对齐该契约：删除「先 POST Supabase 拿 access_token 再换票」的两跳结构与全部 `VITE_SUPABASE_*` 构建开关，登录一律走 `client.login(username, password)` 直发帧。

完成后：web/mobile 无任何 Supabase 引用；登录表单在 local 与 password 两种服务端模式下都能用（用户输 `admin` 或邮箱均可）；`packages/client` 的 `LoginProvider` 注入点与 `supabaseToken` 凭证态整体删除。mobile 属冻结产品，但此变更是共享契约变化下的保活修复（不改则 mobile 无法登录迁移后的生产）——属冻结例外范围内的最小修复。

## Decisions & tradeoffs

- **登录表单文案中性化**：label 统一为「账号」+「密码」，输入 `type=text`，删除 `USE_SUPABASE` 及其全部文案/输入类型分岔。Rejected: 保留构建期变量区分 email/用户名文案 —— `type=email` 会挡 local 模式的 `admin` 输入，为一行文案维护一个构建开关不值；生产用户（单人）知道自己用邮箱登录。
  Based on: `apps/web/src/components/auth/auth-shell.tsx:12,71-75`、`apps/mobile/src/components/auth-screen.tsx:42,49-53`（分岔仅涉文案与 input type）。
- **`packages/client` 删除 LoginProvider 与 supabaseToken 凭证态**：`AuthCredential` 三态收敛为两态（`{token}` | `{username,password}`），`login()` 不再有 provider 分岔，`authError` 文案不再按 provider 分岔。protocol 生成码不动（proto 未变，059 决策）。Rejected: 保留 LoginProvider 作为未来 IdP 扩展点 —— 用户明确不接 OAuth，死抽象删除。
  Based on: `packages/client/src/store.ts:55-58,67-69,532-545`（LoginProvider 唯一抽象面）、`packages/client/src/connection.ts:10-12,31-36`（三态凭证与 buildAuthPayload）。
- **旁路 WS 页面同步收敛**：AuthorizePage / ProxyAuthPage 手写的三分支认证复制品（token / supabaseToken / username+password）收敛为两分支。Rejected: 借机把旁路逻辑下沉进 packages/client —— 超出本 plan 范围，扩大爆炸半径。
  Based on: `apps/web/src/pages/AuthorizePage.tsx:45,92-102`、`apps/web/src/pages/ProxyAuthPage.tsx:42,87-97`。
- **mobile 与 web 同构改动**（冻结例外）：删 `apps/mobile/src/lib/auth.ts`（web 侧同文件的刻意复制品）、config 开关、App.tsx 注入、auth-screen 分岔。
  Based on: `apps/mobile/src/lib/auth.ts:1-24`（与 web 逐行相同，plan 032 决策的复制品）、`apps/mobile/src/App.tsx:31`。
- **`VITE_SUPABASE_*` 声明与消费全删**：仓库内无 CI/脚本注入这两个变量（生产值一直是人工命令行注入），删声明不破坏任何自动化。
  Based on: `apps/web/src/vite-env.d.ts:7-8`、`apps/mobile/src/vite-env.d.ts:6-7`、`apps/web/src/config.ts:11-13`、`apps/mobile/src/config.ts:10-12`（仅此消费点）。

## Direction

### Milestone 1: packages/client 凭证收敛

`AuthCredential` 两态、`LoginProvider` 类型/选项/分岔删除、`login()` 直连 `connect({username,password})`、authError 文案单一化。
Validation: `pnpm --filter @coflux/client build`（若该包无 build 脚本则 `pnpm -r build` 的 tsc 部分）-> exit 0。

### Milestone 2: web 收敛

`lib/auth.ts` 删除；`config.ts`/`vite-env.d.ts` 去 Supabase 项；MainPage 不再传 loginProvider；AuthorizePage/ProxyAuthPage 两分支化；auth-shell 中性文案；workbench.tsx:319 文案随之修正。
Validation: `pnpm --filter @coflux/web build` -> exit 0（注意：不再需要任何 VITE_SUPABASE_* 变量）。

### Milestone 3: mobile 保活同构

与 web 相同语义的最小改动。
Validation: `pnpm --filter @coflux/mobile build` -> exit 0。

## Landmines

- AuthorizePage/ProxyAuthPage 是**不走 packages/client 的旁路 WS**，各自复制了认证分支——只改 client package 会漏掉它们，登录看似正常但设备授权/预览门禁在 password 模式下静默失败。
  Based on: `apps/web/src/pages/AuthorizePage.tsx:45`、`apps/web/src/pages/ProxyAuthPage.tsx:42`。
- `clientVersion: BUILD_ID` 在旁路页面的帧里必须原样保留（版本准入，plan 033）——收敛分支时别丢字段。
- mobile 已冻结：除本 plan 列出的登录链路文件外，任何顺手改动都算越界。

## Scope

In scope:
- `packages/client/src/{store.ts,connection.ts}`
- `apps/web/src/lib/auth.ts`（删）、`apps/web/src/config.ts`、`apps/web/src/vite-env.d.ts`、`apps/web/src/pages/{MainPage,AuthorizePage,ProxyAuthPage}.tsx`、`apps/web/src/components/auth/auth-shell.tsx`、`apps/web/src/components/workbench/workbench.tsx`（仅 :319 文案）
- `apps/mobile/src/lib/auth.ts`（删）、`apps/mobile/src/config.ts`、`apps/mobile/src/vite-env.d.ts`、`apps/mobile/src/App.tsx`、`apps/mobile/src/components/auth-screen.tsx`

Out of scope:
- `apps/server`、`tests/` —— 059/062 负责
- `apps/ios` —— 061 负责
- `proto/`、`packages/protocol` —— 协议零变更
- 生产构建/部署命令变更 —— 063 负责（那里更新部署文档去掉 VITE_SUPABASE_*）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| client 构建 | `pnpm --filter @coflux/client build`（无则跳过，靠 web 构建覆盖） | exit 0 |
| web 构建 | `pnpm --filter @coflux/web build` | exit 0 |
| mobile 构建 | `pnpm --filter @coflux/mobile build` | exit 0 |
| 联调 (acceptance) | 本地起 `COFLUX_AUTH=password` server + 建号，web 登录闭环 | 登录成功 |

## Done criteria

- [ ] All listed commands pass.
- [ ] `rg -i supabase apps/web/src apps/mobile/src packages/client/src` 零命中。
- [ ] web 构建在不设任何 VITE_SUPABASE_* 的环境下成功。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 059 冻结的登录契约与实现不符（如 password 模式帧形状有变）。

## Maintenance notes

- UI 走查按惯例交用户人工验收（memory: no-frontend-verification）；本 plan 的自动化门只到构建通过 + 黑盒联调。
- 生产 web 构建命令自 063 起不再携带 VITE_SUPABASE_*，plans/010、011 中的旧构建命令文档随 063 归档不改。
