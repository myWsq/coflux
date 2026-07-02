# Plan 001: 多账号 SaaS 化 —— Supabase Auth 身份层 + 换票登录

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Validate each milestone before continuing.
> Stop on any STOP condition. When complete, update this plan in
> `plans/README.md`.
>
> Drift check: `git diff --stat d8ba0df..HEAD -- apps/server/src apps/web/src packages/protocol/src tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent
- Planned at: `d8ba0df`, 2026-07-02

## Requirement

coflux 目前是单账号系统：身份 = env 里一对 `COFLUX_USERNAME`/`COFLUX_PASSWORD`，
`accountId` 硬编码 `"default"`（`apps/server/src/config.ts:33-35`）。要把它改造成
Tailscale 式多账号 SaaS：多个用户各自登录、各自拥有隔离的 Account（设备/项目/
工作区/任务互不可见）。

完成后成立的事实：

1. 生产 SaaS 模式（`COFLUX_AUTH=supabase`）下，用户用 Supabase 托管的
   email+password 登录 web；不同用户登录后各自只能看到/触达自己账号下的设备与数据。
2. 首次登录的合法 Supabase 用户自动获得一个个人 Account（lazy provision），
   无需管理端在 coflux 侧做任何操作。
3. local 模式（`COFLUX_AUTH=local`，默认）行为与现状完全一致：env 用户名密码、
   单一 `default` 账号——`pnpm dev`、集成测试、自托管零感知。
4. daemon 登记/认证机制（enrollmentKey → deviceToken）完全不变，Rust 侧零改动。

正确 vs 相邻错误的判别：**Supabase 只做"你是谁"的一次性认证（IdP），coflux 的
会话、数据、授权全部自持**。如果实现让 WS 连接持续依赖 Supabase JWT（比如每次
重连都要新 JWT、或 server 定期调 Supabase API 校验会话），就是走偏了。

## Decisions & tradeoffs

- **身份提供方**：Supabase Auth（email+password，dashboard 侧关闭 signup、手动建
  用户）。Rejected: 自建 users 表 + scrypt——当前阶段更简单，但开放注册时需要自建
  邮件验证/密码重置/防爆破整套；选 Supabase 是为未来开放注册付的一次性结构成本。
  Rejected: 用 Supabase 的 Postgres/RLS 存业务数据——coflux 数据留在自己 sqlite
  （`apps/server/src/store.ts`），Supabase 的接触面只有登录验签一处。
- **换票模式（核心）**：web 用 Supabase 拿 access_token(JWT) → WS
  `client.auth{ supabaseToken }` → server 用 JWKS **本地验签**（无网络往返，公钥
  缓存）→ 取 `sub` 为 userId → 查/建 membership → 签发 coflux 自己的 30 天
  session token（复用现有 `client_tokens` 机制，`store.ts:188-205`）→ 之后所有
  WS 重连只用 coflux session token。Rejected: 每次连接都验 Supabase JWT——JWT
  1 小时过期，WS 长连接/重连会被迫依赖 Supabase 可用性且要处理刷新。
  Based on: `client.auth` 已有 clientToken 重连分支（`apps/server/src/hub.ts:396-421`），
  `client_tokens` 已有 `expiresAt`（`store.ts:69-72`）。
- **账号模型**：User : Account = 1:1 个人账号；新增 `memberships (userId,
  accountId, role)` 表（PRIMARY KEY (userId, accountId)），role MVP 固定
  `"owner"`。userId = Supabase user UUID（JWT `sub`）。**不建本地 users 表**——
  身份资料在 Supabase，email 从 JWT claim 取。Rejected: users 表直挂 accountId
  ——加团队时要迁移；memberships 表一行结构成本换未来零迁移。
- **注册策略**：不做注册页/注册端点。Supabase dashboard 关 signup、手动 Add
  user；coflux 侧对任何验签通过且无 membership 的 userId lazy 创建
  Account（id = randomUUID，name = email claim）+ owner membership。能出示合法
  JWT ⇒ 管理员亲手建的用户，故 lazy provision 安全。
- **provider 抽象**：`COFLUX_AUTH` env，取值 `local`（默认）| `supabase`。
  local = 现有 `verifyLogin` env 密码逻辑（`hub.ts:774`）原样保留。config 的
  fail-closed 校验（`config.ts:52-59`）按 provider 分支：supabase 模式必需
  `SUPABASE_URL`（及 web 侧 anon key），不再要求 `COFLUX_PASSWORD`/
  `COFLUX_ENROLL_KEY`；local 模式要求维持现状。Rejected: 只留 Supabase——
  集成测试（`tests/src/harness.mjs:117-135` 全走 username/password）和本地开发
  会被迫依赖外部服务。
- **bootstrap 按 provider 分支**：`default` 账号 seed、env enroll key seed、
  credFingerprint 撤销逻辑（`apps/server/src/index.ts:24-46`）都是单账号/env
  密码的伴生物，仅 local 模式执行。supabase 模式下 enroll key 全部走 UI 生成
  （该能力已存在，`hub.ts:444-446`）。
- **JWT 验签**：server 新增依赖 `jose`（纯 JS，无原生依赖），用
  `createRemoteJWKSet(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)`，校验
  iss = `${SUPABASE_URL}/auth/v1`、aud = `authenticated`、exp。要求 Supabase
  项目启用 asymmetric signing keys（新项目默认）；HS256 legacy secret 不支持，
  验签失败回 `auth.error`。Rejected: node:crypto 手写验签——JWKS 轮换/缓存细节
  不值得自研。
- **web 侧 Supabase 配置来源** (decided while planning)：Vite build-time env
  `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`。两者都设时登录表单走
  Supabase（email+password 换 JWT），否则维持现状 username/password 表单。
  Rejected: server 下发 auth 配置的运行时端点——web 本来就是 per-environment
  静态构建，build-time env 是 Vite 惯例且少一个 HTTP 路由。
- **web 登录不引 supabase-js SDK** (decided while planning)：email+password 换
  token 就是一个 `fetch` POST 到
  `${SUPABASE_URL}/auth/v1/token?grant_type=password`（header `apikey: <anon>`），
  取响应 `access_token`。Rejected: 引 `@supabase/supabase-js`——只用一个端点就
  引整个 SDK 不值；将来要 OAuth/magic link 再引。
- **协议变更仅 TS 侧**：`client.auth` 增加可选 `supabaseToken` 字段
  （`packages/protocol/src/index.ts:134`）；`auth.ok` 不变（照旧回带 coflux
  session token）。client↔server 消息不经过 Rust 线协议真相源，crates/protocol
  零改动。
- **client_tokens 加 userId 列**：沿用 `store.ts:107-114` 的轻量 migrate 模式
  （PRAGMA table_info 补列）。local 模式签发的 token userId 存 NULL。
  per-user token 撤销不在本期范围。
- **生产数据迁移**：prod-jp 现有 `default` 账号数据不动，切 supabase 模式后给
  管理员的 Supabase userId 手动插一条 membership 指向 `default`。属运维步骤，
  见 Maintenance notes，不在本计划代码范围内。

## Direction

现有隔离层（所有表带 accountId + hub 按 accountId 过滤广播/snapshot/路由）已经
支撑多账号，本计划只增加"User → Account"的身份解析层，不动编排/数据面。

### Milestone 1: server 支持 supabase provider（换票 + memberships + lazy provision）

之后成立：`COFLUX_AUTH=supabase` 启动的 server 能接受
`client.auth{ supabaseToken }`，验签→解析 userId→查/建 membership→签发 coflux
session token；不同 userId 得到不同 accountId，数据互相不可见；local 模式行为
与 `d8ba0df` 完全一致。

验证：`pnpm --filter @coflux/tests test` 全绿（证明 local 模式零回归）；新增的
supabase 分支集成测试通过——测试里自建 ES256 key pair、起本地 HTTP 服务提供
JWKS、签测试 JWT，把 `SUPABASE_URL` 指向该本地服务（这样不依赖真 Supabase）。
至少覆盖：合法 JWT 首次登录建号、二次登录复用同一账号、过期/错签名 JWT 拒绝、
两个不同 userId 账号隔离（互相看不到设备/任务）、换票得到的 session token 可重连。

### Milestone 2: protocol + web 登录改造

之后成立：`packages/protocol` 的 `client.auth` 含 `supabaseToken` 可选字段；web
在设了 `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` 时展示 email+password 表单、
fetch Supabase 换 access_token、经 WS 完成换票并把 coflux session token 存
localStorage（复用现有逻辑，`apps/web/src/App.tsx:96-157`）；未设时表单与现状
完全一致。Supabase 登录失败（401/网络错误）在表单上有明确报错。

验证：`pnpm -r build` exit 0；`pnpm --filter @coflux/tests test` 全绿。手工验证
路径（可选，若有可用 Supabase 项目）：设 env 起 dev server + web，真实登录走通。

## Landmines

- `client.auth` 消息在 rate-limit 白名单里有特殊条目（`packages/protocol/src/index.ts:303`
  附近的 `"client.auth": {}`），新增字段后确认该表/校验器（`isValidClientToServer`）
  同步放行 `supabaseToken`，否则消息会在 transport 层被静默丢弃。
- `index.ts:35-40` credFingerprint 逻辑会在 env 密码变化时**撤销全部** client
  token。若在 supabase 模式下误执行，等于每次改任何 env 都把所有用户登出；
  必须限定 local 模式。
- `tests/src/security.test.mjs:66-67` 对 `client.auth` 发畸形字段（数字型
  clientToken 等）断言拒绝——新增 `supabaseToken` 字段的类型校验要同样严格
  （非 string 即拒绝），否则该测试思路下有漏洞。
- `config.ts` 是模块加载时求值 + `process.exit(1)` fail-closed。新增的
  provider 分支校验要保持这个模式，别把校验推迟到运行时。
- web 的 token 恢复逻辑（`App.tsx:72-97`）在"有存量 token"时直接走 clientToken
  重连分支——supabase 模式下这条路径必须保持可用（换票后的日常路径），别把它
  改成每次都要重新向 Supabase 要 JWT。

## Scope

In scope:
- `apps/server/src/`（config / hub / store / index / 新增 auth 模块）
- `apps/server/package.json`（新增 `jose`）
- `packages/protocol/src/`（client.auth 消息 + 校验器）
- `apps/web/src/`（登录表单 + Supabase fetch）
- `tests/src/`（新增 supabase provider 集成测试；现有测试不应需要改动）
- `plans/`

Out of scope:
- `crates/`、`packages/cli` —— daemon 登记/认证机制不变
- 真实 Supabase 项目的创建与配置（关 signup、建用户）—— 运维步骤，见
  Maintenance notes
- 生产 prod-jp / staging 部署与 default 账号 membership 迁移 —— 运维步骤
- 团队/多成员、角色权限、per-user token 撤销、开放注册 —— 未来迭代
- OAuth / magic link / supabase-js SDK —— 未来迭代

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Test | `pnpm --filter @coflux/tests test` | exit 0（pretest 会 cargo build daemon） |
| Typecheck/Build | `pnpm -r build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] supabase 模式：两个不同 Supabase userId 登录得到两个隔离账号（集成测试断言互不可见）。
- [ ] supabase 模式：换票签发的 coflux session token 可用于 WS 重连，全程不再触碰 Supabase。
- [ ] local 模式行为与 `d8ba0df` 一致，现有测试文件零改动即通过。
- [ ] 过期 / 错误签名 / 非 string 的 supabaseToken 均被拒绝（auth.error 或断连）。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `jose` 无法在纯 node:sqlite/tsx 运行环境下工作（如需原生依赖）——停下报告。
- 发现 client↔server 的 auth 消息实际经过 crates/protocol（与"仅 TS 侧"决策冲突）。

## Maintenance notes

- **上线运维手册（代码合并后、切生产前）**：
  1. Supabase 项目（可用 Supabase MCP 创建/管理）：Authentication → 关闭
     signup；手动 Add user（管理员 + 受邀用户）；确认项目用 asymmetric
     signing keys（JWKS 端点可访问）。
  2. prod-jp env：`COFLUX_AUTH=supabase`、`SUPABASE_URL=<项目 URL>`；web 构建
     加 `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`。anon key 是公开值，非秘密。
  3. 迁移既有数据：对管理员的 Supabase user UUID 执行
     `INSERT INTO memberships (userId, accountId, role) VALUES ('<uuid>', 'default', 'owner')`
     ——设备/项目/任务全保留。其他用户首次登录自动建新账号。
  4. 迁移后 `COFLUX_USERNAME`/`COFLUX_PASSWORD` 可从 prod env 移除。
- anon key 泄露无害（设计即公开），但 Supabase service_role key 永远不应出现在
  coflux 任何配置里——本设计完全不需要它。
- 将来加团队：memberships 已是多对多形状，加邀请流程 + role 检查即可，schema
  无需迁移。
- 将来换身份提供方：换票边界意味着只需替换"JWT 验签 → userId"这一个函数。
