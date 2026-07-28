# Plan 059: server 自建邮箱密码多账号认证（password 模式替换 supabase 模式）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD -- apps/server tests/src/supabase.test.mjs proto/coflux/v1/client.proto`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: migration
- Execution: subagent sonnet
- Planned at: `c772ed4`, 2026-07-28

## Requirement

coflux 全面退役 Supabase（用户拍板，2026-07-28）。本 plan 是迁移组（059-063）的契约 plan：把 server 的多账号认证从「Supabase Auth JWT 换票」替换为「自建 users 表 + 邮箱密码验证」，并冻结三端客户端（060/061）依赖的登录契约。

完成后：`COFLUX_AUTH` 取值为 `local`（默认，行为不变）| `password`（新，多账号邮箱密码）；`supabase` 取值消失，server 不再有任何 Supabase 代码路径。password 模式下客户端在既有 `clientAuth` WS 帧里发 `username`(=email) + `password`，server 查 users 表验证口令、复用既有 lazy membership 机制解析账号、签发 coflux 会话 token——会话 token / 重连 / 版本准入等既有链路一律不动。

**冻结给 060/061 的契约**：三端登录一律直发 `clientAuth { username: <email 或 local 用户名>, password, clientVersion }`；`supabaseToken` 字段废弃不用但 proto 保留；`authOk`/`authError` 帧形状不变。不接 OAuth，只做邮箱+密码（用户 2026-07-28 明确）。

## Decisions & tradeoffs

- **模式命名与取值**：`COFLUX_AUTH` 改为 `local | password`，`supabase` 直接删除（非法值仍 fail-closed 退出）。Rejected: 保留 `supabase` 兼容模式灰度 —— 单用户自用项目，无灰度对象；死代码留着是负债。
  Based on: `apps/server/src/config.ts:19-25`（取值校验）、`apps/server/src/config.ts:36-38`（SUPABASE_URL fail-closed，一并删除）。
- **协议零变更**：password 模式复用既有 `ClientAuth.username`(field 1) 承载 email，`password`(field 2) 承载明文口令；`supabase_token`(field 4) 保留在 proto 里不删不 reserved（删字段需三端同步重新生成，收益为零）。Rejected: 新增 `email` 字段 —— username 字段语义上就是账号名，多一个字段是纯噪音。
  Based on: `proto/coflux/v1/client.proto:14-21`（四个互斥凭证字段已存在）、`apps/server/src/hub.ts:1463-1537`（handleClientAuth 三路互斥分发）。
- **口令哈希用 node:crypto scrypt**（`crypto.scrypt` + 随机 salt + `timingSafeEqual`，参数用 Node 默认或 OWASP 推荐，存储格式含 salt 自描述）。Rejected: bcrypt/argon2 依赖 —— 单用户低频登录场景 stdlib scrypt 强度足够，不为此加原生依赖。
  Based on: `apps/server/package.json:11-20`（现依赖面，无任何哈希库）。
- **无注册端点**：建号走管理员脚本（形式是 scripts/ 下 mjs 还是 apps/server 内 tsx 入口，executor 自定），支持 `--id` 显式指定 user UUID——063 生产迁移要用旧 Supabase user UUID 建号，使既有 `memberships.user_id` 数据无缝复用。信任模型与 plans/001 一致：管理员亲手建号 ⇒ 登录成功即可 lazy provision 账号。Rejected: 注册端点/邀请流 —— 单用户，YAGNI。
  Based on: `apps/server/src/hub.ts:1539-1552`（resolveAccountForUser lazy 建号，password 模式按 users.id 复用同一逻辑）、`apps/server/src/store.ts:236-243`（memberships 表以 user_id 为键）。
- **users 表进既有 SCHEMA_DDL**（不等 062 的 prisma-next contract；062 会把含 users 的全量表吸进 contract）。最小列集：`id`(uuid pk), `email`(unique), `password_hash`, `created_at`。
  Based on: `apps/server/src/store.ts:219-401`（SCHEMA_DDL 幂等块，新表 IF NOT EXISTS 天然安全）。
- **SupabaseVerifier 与 jose 删除**：`apps/server/src/auth.ts` 整文件重写为口令哈希/校验工具（或删除并入他处，executor 自定）；确认 server 内 jose 仅为验签引入后从 `apps/server/package.json` 移除（tests 的 jose 依赖看各自 package.json，本 plan 只动 supabase.test.mjs）。
  Based on: `apps/server/src/auth.ts:19-43`（唯一 jose 使用点）、`apps/server/src/plugins/hub.plugin.ts:19-21`（verifier 注入点）。
- **测试语义映射**（decided while planning）：`tests/src/supabase.test.mjs` 改写为 password 模式黑盒测试（可改名），5 个既有用例逐一映射：lazy 建号回带 token → 首登建账号；同 userId 复用账号；过期/错签名拒绝 → 错密码/不存在邮箱拒绝；两用户账号隔离；JWKS 停机后会话 token 仍可重连 → 会话 token 独立性（password 模式下签发的 token 重连不再查 users 表）。测试内建号直接经 ADMIN_PG_URL 写 users 表或调建号脚本，executor 自定。
  Based on: `tests/src/supabase.test.mjs:73-146`（5 用例）、`tests/src/harness.mjs:220-256`（startServer(opts.env) 注入口）。

## Direction

### Milestone 1: config + 口令哈希基础

`COFLUX_AUTH=password` 合法且不再认识 supabase；`SUPABASE_URL` 相关代码与 fail-closed 项删除；scrypt 哈希/验证工具就位（含自描述存储格式与单元级自检）。
Validation: `pnpm --filter @coflux/server build` -> exit 0。

### Milestone 2: users 表 + 认证分支

SCHEMA_DDL 增 users 表；Store 增查/建用户方法；`handleClientAuth` 增 password 分支（email 归一化小写查表 → scrypt 验证 → 按 users.id 走既有 membership 解析 → 签发会话 token，`upsertClientToken` 带 userId）；`hub.plugin.ts` 不再构造 verifier；`store.plugin.ts` 的 bootstrap seed 仍仅 local 模式执行。
Validation: `pnpm --filter @coflux/server build` -> exit 0。

### Milestone 3: 建号脚本

管理员建号入口：给定 email + 密码（+ 可选 `--id` UUID）写入 users 表，幂等（重复 email 报错或更新口令，executor 自定并写明）。
Validation: `pnpm --filter @coflux/server build` -> exit 0；脚本对本地 PG 实际建号一次成功。

### Milestone 4: 黑盒测试改写

password 模式测试替换 supabase 测试，5 用例语义齐备；其余测试（LOCAL_ENV 系）不受影响。
Validation: `cd tests && node --import tsx --test src/<新测试文件>.mjs` -> exit 0（需本地 PG，见 Commands 注记）。

## Landmines

- `handleClientAuth` 三路分支互斥且非 string 凭证自然落空到 authError（`apps/server/src/hub.ts:1461`）——password 分支必须保持同等严格性，不得让 local 与 password 模式的 username/password 分支互相吞流量（两模式由 `config.authProvider` 静态二选一，同一进程只会有一条活路径）。
- `store.plugin.ts:30` 的 default 账号 seed 仅 local 模式执行——password 模式沿 supabase 模式行为（不 seed），别把 if 改宽。
- `client_tokens.user_id` 在 local 模式写 null、多账号模式写 userId（`apps/server/src/hub.ts:1482,1490`）——password 分支要写 users.id，否则 063 迁移后按 user 撤销 token 的语义断裂。
- 版本准入拦截发生在认证成功之后（`apps/server/src/hub.ts:1504-1532`），新分支别绕过它——统一走既有函数尾部路径。
- tests 的 `jose` 依赖（`tests/package.json:13`）在测试改写后若无他用一并移除，但先 `rg` 确认其它测试文件没用。

## Scope

In scope:
- `apps/server/src/{auth.ts,config.ts,hub.ts,store.ts}`、`apps/server/src/plugins/{hub.plugin.ts,store.plugin.ts}`、`apps/server/package.json`
- `tests/src/supabase.test.mjs`（改写/改名）、`tests/package.json`（jose 移除，如确认无他用）
- 建号脚本（`scripts/` 或 `apps/server/` 内，executor 自定）

Out of scope:
- `proto/`、`packages/protocol` —— 协议零变更（决策已定）
- `apps/web`、`apps/mobile`、`apps/ios`、`packages/client` —— 060/061 负责
- prisma-next / DATABASE_URL / harness PG 地址 —— 062 负责
- 生产环境任何操作 —— 063 负责

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck/build | `pnpm --filter @coflux/server build` | exit 0 |
| 全量黑盒 (acceptance) | `cd tests && COFLUX_TEST_PG_URL=<本地 PG 直连串> pnpm test` | exit 0 |
| 本 plan 黑盒 (acceptance) | `cd tests && COFLUX_TEST_PG_URL=<同上> node --import tsx --test src/<新测试>.mjs` | exit 0 |

注记：本机既有测试 PG 是 selfhost Supabase 的 54322 直连口（harness 默认）；本 plan 不改 harness 默认值，跑测试时沿用现状即可——脱离 selfhost Supabase 是 062 的事。

## Done criteria

- [ ] All listed commands pass.
- [ ] `COFLUX_AUTH=supabase` 启动报非法值退出；`password` 模式端到端（建号→登录→authOk→token 重连）在黑盒测试中闭环。
- [ ] `rg -i supabase apps/server/src` 零命中（注释残留一并清理）。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 发现 server 内 jose 或 supabase 代码存在本 plan 未列的第二用途。

## Maintenance notes

- 密码明文在 `clientAuth` 帧内经 wss(TLS) 传输——与 local 模式既有安全模型完全一致，不是新增风险面；若未来引入第三方 IdP 再评估。
- scrypt 参数与存储格式写死在哈希工具处，轮换/升级参数时靠格式前缀区分新旧哈希。
- `supabase_token` proto 字段成为永久废弃字段，注释标明即可，不 reserved。
