# Plan 062: server 数据层迁 prisma-next——contract 化 + store.ts 改写 + 本地链路脱离 selfhost Supabase

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD -- apps/server tests/src/harness.mjs`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/059-server-password-auth.md
- Category: migration
- Execution: subagent sonnet
- Planned at: `c772ed4`, 2026-07-28

## Requirement

迁移组的核心工程量：server 持久化层从「porsager/postgres 手写 SQL + 代码内 SCHEMA_DDL」迁到 prisma-next（Early Access）——PSL contract 描述全部表（059 后共 14 张，含 users）、store.ts 内部改写为 prisma-next 查询、schema 从 `coflux` 迁到 `public`、本地开发与黑盒测试链路脱离 selfhost Supabase（54322）改用裸 Postgres。

**硬边界：`Store` 类对外 API 与语义完全不变，`hub.ts`（1822 行）零改动**——这是验收的第一标准。生产数据库切换（Prisma Postgres provision + 数据搬迁 + prod env）不在本 plan，见 063；本 plan 完成时本地全链路（dev + 黑盒测试）在裸 PG + prisma-next 上闭环。

prisma-next 关键文档（append `.md` 取 markdown）：
- https://www.prisma.io/docs/next/add-to-existing-project/postgresql （init --target postgres、contract infer/emit、db sign、db.connect/db.orm/db.sql 用法）
- https://www.prisma.io/docs/orm/next/reference/orm-client 、…/reference/sql-query-builder 、…/reference/raw-queries 、…/reference/transactions-and-runtime
- https://www.prisma.io/docs/cli/next/db-init 、…/db-update 、…/configuration

## Decisions & tradeoffs

- **schema `coflux` → `public`**：contract 与新建库一律用 `public`。原因：建 `coflux` schema 的唯一动机是避开 Supabase 自带对象/PostgREST 暴露面（`apps/server/src/store.ts:7` 注释），随 Supabase 退役消失；prisma-next 全部文档假设 public，PSL 无 `@@schema`，非 public 路径在 Early Access 工具链上未文档化。Rejected: 保留 `coflux` schema —— 在 beta 工具链的未文档化路径上押注，风险远大于 063 迁移时一次 `SET SCHEMA` 的成本。
  Based on: `apps/server/src/store.ts:7,219`；prisma-next psl-syntax 文档无 schema 归属语法（2026-07-28 查证）。
- **contract 手写对照 SCHEMA_DDL，不以 contract infer 为准**：SCHEMA_DDL（`store.ts:219-401`）是权威真源，逐表转写 PSL（snake_case 列名用 `@map`，表名 `@@map`）；`contract infer` 可对活库跑一次做校验对照，但产物不直接采用。Rejected: infer 为准 —— infer 产物命名/类型是首稿质量，且依赖活库状态。
  Based on: `apps/server/src/store.ts:219-401`（14 表 DDL 含索引/约束）。
- **store.ts 改写策略：Store API 冻结，内部 ORM 优先、逃生舱兜底**。ON CONFLICT upsert、`CASE WHEN` 条件更新、`RETURNING *` 等 ORM 表达不了的语句用 sql query builder 或 raw queries 逃生舱——正确性优先于 ORM 纯度，禁止为迁就 ORM 改变语句语义。Rejected: 改 hub.ts 适配新数据接口 —— 爆炸半径失控；Rejected: 只换连接串不上 ORM —— 用户已拍板要 prisma-next 接入。
  Based on: `apps/server/src/store.ts` 102 处 `this.sql` 调用点，其中 ON CONFLICT 约 6 处、RETURNING 约 10 处、`CASE WHEN` 条件更新见 `store.ts:691`。
- **事务语义保持**：现在是 `Store.transaction(fn)` 把事务连接包成新 Store 实例（`store.ts:454`），hub 在事务内调同一套方法（如 lazy 建号，`hub.ts:1546-1549`）。prisma-next 侧用 `db.transaction()` 等价实现，模式由 executor 对照 transactions-and-runtime 文档设计——但「事务内与事务外同一方法签名」这个对 hub 的承诺不能破。
  Based on: `apps/server/src/store.ts:406-455`。
- **「启动即建库」能力必须保留**：现在 server `connect()` 时跑幂等 SCHEMA_DDL + 补列 ALTER（`store.ts:432-443`），黑盒测试靠它实现「每测试 CREATE DATABASE 后 server 起来即可用」（`tests/src/harness.mjs:49-61`）。prisma-next 化后等价物由 executor 设计（编程式调 db init/update、启动时跑 migration、或保留一段 DDL 自举——任选，但 harness 的每测试新库流程必须继续零额外步骤工作）。补列 ALTER（additions/deletions/deleting 三列）在全新建库语义下并入 contract 本体，不再需要单列补丁。
  Based on: `apps/server/src/store.ts:432-443`、`tests/src/harness.mjs:49-61`。
- **本地测试 PG 默认改裸 Postgres**：`harness.mjs` 的 ADMIN_PG_URL 默认从 54322（selfhost Supabase 直连口）改为 `postgres://postgres:postgres@127.0.0.1:5432/postgres`（与 CI 一致），`COFLUX_TEST_PG_URL` 覆盖口保留。本机需常备一个裸 PG（brew services 或 docker，executor 在 plan 完成报告里写明实际用法）。Rejected: 继续用 selfhost Supabase 的 PG —— 迁移目标就是退役它。
  Based on: `tests/src/harness.mjs:44-47`、`.github/workflows/ci.yml:77-80`（CI 已是 5432 裸 PG）。
- **类型映射三处硬约束**（decided while planning）：时间戳列是 double precision 存 number 毫秒（见 `store.ts:691` 的 `::double precision`）、int8/BIGINT 必须以 number 出入（`store.ts:13` 注释：协议侧是 number，float64 精度在此量级安全）、应用层 camelCase ↔ 列名 snake_case 靠 `@map`。改写后任何一处类型漂移（string 化的 int8、Date 化的时间戳）都是语义破坏。
  Based on: `apps/server/src/store.ts:10-14,691`。
- **连接池参数重新归位**：`max: 5` 是 Supabase 免费版 session pooler 的客户端额度限制（`store.ts:419-420` 注释），prisma-next `db.connect({url})` 的池配置按其文档与 Prisma Postgres 特性重设（本地裸 PG 无此限制）；`ssl: "prefer"` 语义（本地明文、托管 TLS）保持。
  Based on: `apps/server/src/store.ts:418-424`。
- **Node 版本前置已满足**：prisma-next 要求 Node 24+；`.nvmrc` v24.17.0、prod-jp v24.17.0、本机 v26（2026-07-28 实测）。

## Direction

### Milestone 1: prisma-next 接入 + contract 就位

`prisma-next init --target postgres` 进 apps/server（PSL，contract 路径按 init 默认）；14 表 contract 手写完成并 `contract emit` 通过；对本地裸 PG `db init` 建出的库结构与 SCHEMA_DDL 语义等价（表/列/索引/唯一约束逐项核对）。
Validation: `npx prisma-next contract emit`（apps/server 内）-> exit 0；`pnpm --filter @coflux/server build` -> exit 0。

### Milestone 2: store.ts 改写

102 处调用点全部迁到 prisma-next（ORM / sql builder / raw 分层使用）；`postgres` 依赖从 apps/server 移除；Store 对外 API 与 `hub.ts` 零改动。
Validation: `pnpm --filter @coflux/server build` -> exit 0；`git diff --stat -- apps/server/src/hub.ts` 为空。

### Milestone 3: 测试链路切换

harness 默认 PG 改 5432 裸 PG；「每测试新库自动就绪」在 prisma-next 体系下工作。
Validation: `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test` -> exit 0（全量黑盒是本 plan 的主验收，acceptance 级但必须过）。

## Landmines

- `tests/package.json` 与 harness 直接依赖 `postgres` 包做管理连接（`tests/package.json:14`、`harness.mjs`）——tests 侧保留 porsager/postgres 完全合理（管理用途），别顺手迁它。
- `store.ts:1074` 的「不 RETURNING 整行快照」是 c772ed4 刚修的 egress 优化——改写时保持该语句不回传 ansi_snapshot，别在 ORM 化时退化回 RETURNING *。
- `transform: postgres.camel` 是全局双向自动转换（`store.ts:421`）——ORM 化后没有这层魔法，每个模型的 `@map` 必须逐列核对，漏一列是静默的 undefined 而非报错。
- `sql(obj, ...cols)` 插入语法（如 `store.ts:495`）隐式只取列子集——转写时核对每处实际写入的列集合。
- 5432 端口在本机可能被 selfhost Supabase 的 supavisor 占用（memory: 5432 是 supavisor 会报 tenant 错）——本机裸 PG 若端口冲突，装机时换端口并用 COFLUX_TEST_PG_URL/DATABASE_URL 显式指定，harness 默认值仍写 5432（以 CI 为准绳）。
- prisma-next 是 Early Access（`@prisma/cli` 3.0.0-beta 系）——遇到工具链 bug 优先用 raw 逃生舱绕过并记录，不 hack 语义。

## Scope

In scope:
- `apps/server/`（store.ts、config.ts 的 databaseUrl 注释、package.json、prisma-next init 新增的 contract/配置/脚本文件）
- `tests/src/harness.mjs`（ADMIN_PG_URL 默认值）

Out of scope:
- `apps/server/src/hub.ts` —— 零改动是验收标准
- `proto/`、三端客户端
- 生产 DB provision / 数据搬迁 / prod env —— 063
- selfhost Supabase 的停用与拆除 —— 用户本机环境动作，063 收尾时提示

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck/build | `pnpm --filter @coflux/server build` | exit 0 |
| contract 产物 | `cd apps/server && npx prisma-next contract emit` | exit 0 |
| 全量黑盒 (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test` | exit 0 |
| dev 冒烟 (acceptance) | `pnpm dev:server`（本地裸 PG）起服 + web 登录建 workspace | 正常 |

## Done criteria

- [ ] All listed commands pass.
- [ ] `hub.ts` 零 diff；`postgres` 依赖从 apps/server/package.json 消失。
- [ ] 全量黑盒测试在裸 PG + prisma-next 上通过。
- [ ] `rg -i supabase apps/server tests/src/harness.mjs` 零命中（注释含）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- prisma-next（含逃生舱）无法满足：事务内外同签名的 Store 模式、每测试新库自动就绪、或三处类型映射硬约束之一——停下报告，不降级语义硬闯。

## Maintenance notes

- contract（PSL）自此成为 schema 权威真源，SCHEMA_DDL 时代结束；后续加表/加列走 contract 修改 + `contract emit` + migration 流程（见 prisma-next migrations 文档）。
- 063 之后生产连接串是 Prisma Postgres（db.prisma.io）；本 plan 期间 DATABASE_URL 语义不变，仅默认值文档化为裸 PG。
