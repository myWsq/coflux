# Plan 002: 存储层迁移 —— node:sqlite → Supabase Postgres（托管 PG 模式）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Validate each milestone before continuing.
> Stop on any STOP condition. When complete, update this plan in
> `plans/README.md`.
>
> Drift check: `git diff --stat ef34fed..HEAD -- apps/server/src tests/src`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: plans/001-multi-account-supabase-auth.md (DONE)
- Category: migration
- Execution: subagent
- Planned at: `ef34fed`, 2026-07-04

## Requirement

用户选 Supabase 的**主要动机是用它的数据库**（探索阶段曾误对齐为"只用 Auth"，
plan 001 保留了 sqlite——本计划纠正这一点）。目标：coflux server 的持久化层从
`node:sqlite` 整体迁移到 Postgres，生产连 Supabase 云项目的托管 Postgres，
本地开发/测试连用户本机 selfhost Supabase 的 Postgres（docker compose，
`localhost:5432`）。

完成后成立的事实：

1. server 唯一的持久化引擎是 Postgres（`DATABASE_URL` 连接），`node:sqlite`
   及 `COFLUX_DB` 配置从代码中移除。
2. **架构不变**：server 仍是唯一数据访问方（"托管 PG"模式）。不用 Supabase 的
   RLS / PostgREST / Realtime / Storage；web 与 daemon 的通路、协议、授权模型
   零变化。plan 001 的换票认证逻辑原样保留。
3. 集成测试连本地 Postgres（每套 stack 一个随机名临时 database，跑完删除），
   26 个既有测试语义不变全绿。
4. 本地 harness 与线上数据的隔离维持成立（本地连 selfhost PG，生产连云 pooler）。

正确 vs 相邻错误的判别：这是**换存储引擎，不是改架构**。如果实现开始让 web 直
连 Supabase、用 RLS 做授权、或给表加 Supabase 专属机制（如依赖 auth.uid()），
就是走偏了。同样，若保留 sqlite 做双引擎抽象也是走偏（见决策）。

## Decisions & tradeoffs

- **单引擎 Postgres，删除 sqlite**。Rejected: `COFLUX_DB_DRIVER=sqlite|postgres`
  双引擎抽象——每个查询两份实现+两套测试，复杂度翻倍；用户已明确数据库就是要
  Supabase PG，自托管故事变为"需要一个 Postgres"（selfhost Supabase 或任意 PG），
  可接受。
- **PG 客户端：`postgres`（postgres.js，porsager/postgres）**。纯 JS 零依赖、
  tagged-template 参数化天然防注入、内置连接池。Rejected: `pg`（node-postgres）
  ——同样可行但依赖更多、API 更啰嗦；不要两个都装。
- **coflux 表放独立 schema `coflux`，不放 `public`**。Supabase 的 `public`
  schema 可能被 PostgREST Data API 暴露（取决于项目设置），独立 schema 从根上
  隔离，也避免与 Supabase 自带对象混杂。连接后 `SET search_path` 或 SQL 里显式
  schema 前缀，executor 选一种并全局一致。
- **schema 管理沿用"启动时自建"**：server 启动时 `CREATE SCHEMA IF NOT EXISTS`
  + `CREATE TABLE IF NOT EXISTS`（对应现 `store.ts:58-105` 的做法），轻量列迁移
  沿用现 `migrate()` 思路（information_schema 查列补列）。Rejected: supabase
  CLI migrations / 迁移工具——引入工具链与部署耦合，单应用自管 schema 的现状
  风格熵更低。单实例部署无并发 DDL 问题。
- **异步化的并发语义靠数据库约束兜底（关键）**：sqlite 同步 API 下每条消息处理
  天然原子；Postgres async 后同一 client 的多条消息、多个 client 的消息可能交错。
  不引入应用层锁/队列；改为：关键不变量用 DB 约束表达——memberships 主键
  (userId, accountId) + lazy provision 走 `ON CONFLICT`/幂等事务；devices
  tokenHash、client_tokens tokenHash 主键/唯一约束已有对应物，照搬。hub 中
  "查后写"的路径（如 lazy 建号 `hub.ts:667-680`、级联删除的 4 个
  `store.transaction`）改为 async 事务（postgres.js `sql.begin`），事务内保持
  原子。Rejected: 每连接消息串行队列——对当前消息模式是过度设计，且不解决跨
  连接竞态。
- **`Store` API 全量 async 化**：所有方法返回 Promise，`hub.ts`（65 处调用）、
  `index.ts`（10 处，含 bootstrap）全部 await 化。消息 handler 本已允许 async
  （`handleClientAuth` 先例，`hub.ts:396-399` fire-and-forget + 未认证守卫）。
  注意 handler 内先查后广播的顺序保持不变，不要把广播提前到写入完成前。
- **连接配置：`DATABASE_URL` env**，进 `config.ts` 的 fail-closed 体系：生产
  必须显式提供；dev（`COFLUX_DEV=1`）弱默认
  `postgres://postgres:postgres@127.0.0.1:5432/postgres`。`COFLUX_DB` 配置与
  dbPath 逻辑删除。连接池设小（max ~5）：生产走 Supabase session pooler，免费
  版客户端连接额度有限，单实例 server 用不了多的。
- **生产连接走 IPv4 session pooler（已验证）**：prod-jp 无 IPv6，直连
  `db.<ref>.supabase.co:5432` 不通；`aws-0-ap-northeast-1.pooler.supabase.com`
  的 5432（session）与 6543（transaction）均可达。用 **session pooler(5432)**
  ——语义等同直连（支持 prepared statements）；transaction pooler 对
  postgres.js 的默认 prepared 模式不兼容。Based on: 本轮 ssh prod-jp nc 实测。
- **测试 harness：每套 stack 一个随机名临时 database**。harness 用管理连接
  （`COFLUX_TEST_PG_URL`，默认同 dev 弱默认串）`CREATE DATABASE coflux_test_<rand>`，
  server 进程的 `DATABASE_URL` 指向它，stop 时 DROP（需先断该库连接）。
  Rejected: 临时 schema——server 的建表逻辑按 schema 名固定，改参数化 schema
  名侵入更大；database 级隔离最干净。Rejected: docker 起临时 PG——用户本机
  已有常驻 selfhost PG，测试前置写明即可。
- **`meta` 表 / credFingerprint / pruneClientTokens 逻辑照搬**，仅换存取层。
  local auth 模式（COFLUX_AUTH=local）行为语义不变——它与存储引擎正交。
- **生产数据迁移 = 手工重放，不做迁移工具**：生产现有数据量趋近零（1 account
  `default` + 1 membership + 少量 enrollment_keys/client_tokens、0 devices）。
  切换时在新库手工 INSERT account/membership（运维步骤，见 Maintenance notes），
  client_tokens 不迁（用户重新登录即可）。Rejected: sqlite→pg 数据泵——为零数据
  写一次性工具是浪费。

## Direction

`store.ts` 是唯一持久化边界（hub/index 只经它触库），替换它的实现并 async 化
调用面即可，协议/web/daemon/crates 零改动。

### Milestone 1: Postgres 存储层 + 全调用面 async 化，本地 PG 验证全绿

之后成立：server 以 `DATABASE_URL` 连 Postgres 启动，功能与 `ef34fed` 等价
（local 与 supabase 两种 auth 模式都工作）；`node:sqlite` import 与 `COFLUX_DB`
不复存在；harness 按临时 database 模式跑，26 个既有测试文件**语义零改动**全绿
（harness.mjs 本身的环境装配可改）。

验证：`pnpm --filter @coflux/tests test` 全绿（前置：本机 selfhost PG 可连）；
`pnpm -r build` exit 0；`grep -r "node:sqlite" apps/server/src` 无结果。

## Landmines

- **执行前置**：本机 selfhost Supabase PG 在 `127.0.0.1:5432`（已验证端口可达），
  但**密码未知**。先用 dev 弱默认串试连；连不通 → STOP，请用户在环境里提供
  `COFLUX_TEST_PG_URL`（含真实密码），不要猜密码、不要把密码写进任何文件。
- `store.transaction(fn)` 的 4 个调用点（`hub.ts:469,516,677,779`）目前传同步
  闭包；postgres.js 的 `sql.begin` 回调拿到的是**事务专属的 sql 实例**，事务内
  所有语句必须用它而非全局实例，否则语句逃逸出事务（静默的原子性丢失）。Store
  的事务 API 设计要把这一点封进去，不要让调用方拿得到全局连接。
- sqlite 布尔/时间戳以 INTEGER 存（`isMain INTEGER`、`revoked INTEGER`、
  `rowToWorkspace`/`rowToDevice` 手工转换，`store.ts:326-368`）；PG 下若改用
  boolean/bigint，注意 postgres.js 对 bigint 默认返回 string——`createdAt` 等
  毫秒时间戳字段用 `BIGINT` 时要配置解析或用 `DOUBLE PRECISION`/`NUMERIC` 谨慎
  处理。协议侧类型是 number（`packages/protocol`），别让 string 漏出去。
- `handleClientAuth` 已是 async fire-and-forget（`hub.ts:396-399`），其余
  handler async 化后同一连接的消息处理可能交错；现有测试对消息顺序有隐式依赖
  （如 `state.snapshot` 在 subscribe 后回、广播顺序），改动后靠全量测试兜底，
  出现顺序类失败优先怀疑交错而非改测试。
- `pnpm dev:server` 的 dev 模式（`COFLUX_DEV=1`）现在零依赖可跑；迁移后它需要
  本机 PG 在跑。README 的"快速开始"段需要同步更新（前置多一条 selfhost PG）。
- harness `startServer`/`startStack` 目前给子进程传 `COFLUX_DB` 临时文件路径
  （`tests/src/harness.mjs:124` 及 `startServer`），改临时 database 后注意
  `restartServer` 场景要复用同一个 database（重启后数据仍在的语义被
  reconnect.test 依赖）。
- DROP DATABASE 前要断开目标库的所有连接（`pg_terminate_backend` 或
  postgres.js `.end()` 顺序），否则 DROP 报 "being accessed by other users"，
  在 after 钩子里静默失败会泄漏测试库。

## Scope

In scope:
- `apps/server/src/`（store / config / hub / index / auth 的触库处）
- `apps/server/package.json`（+`postgres`，−无；`node:sqlite` 是内置模块无需删依赖）
- `tests/src/`（harness 环境装配；测试文件语义不动）
- `tests/package.json`（如需 `postgres` devDep 用于管理连接）
- `README.md`（快速开始的前置说明）
- `pnpm-lock.yaml`
- `plans/`

Out of scope:
- `packages/protocol`、`apps/web`、`crates/`、`packages/cli` —— 存储引擎对它们不可见
- Supabase RLS / PostgREST / Realtime —— 明确不用（见 Requirement 判别）
- 生产切换与数据重放 —— 运维步骤（Maintenance notes），代码合并后单独执行
- sqlite→pg 自动迁移工具 —— 生产数据趋近零，不做

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Test | `pnpm --filter @coflux/tests test` | exit 0（前置：本机 PG 可连） |
| Typecheck/Build | `pnpm -r build` | exit 0 |
| sqlite 清除确认 | `grep -rn "node:sqlite\|COFLUX_DB\b" apps/server/src tests/src` | 无结果 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 26 个既有测试文件语义零改动全绿（harness 装配层改动除外）。
- [ ] `COFLUX_AUTH=local` 与 `COFLUX_AUTH=supabase` 两模式在 PG 下都工作（supabase.test.mjs 覆盖后者）。
- [ ] 事务路径（设备删除级联、workspace 删除级联、lazy provision）在 PG 事务内原子。
- [ ] coflux 表全部位于 `coflux` schema，`public` 无残留。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- 本机 PG 连不上且用户未提供 `COFLUX_TEST_PG_URL`。
- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- postgres.js 与 node 24/tsx 环境不兼容（如需原生构建）——停下报告。

## Maintenance notes

- **生产切换运维手册（代码合并后）**：
  1. Supabase dashboard 拿云项目 database password（Settings → Database，必要时
     reset）；连接串用 **session pooler**：
     `postgres://postgres.yafiocdmkhjuphmmwtrn:<密码>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`
     （prod-jp 无 IPv6，不能用直连串）。密码由用户亲手写入
     `/etc/coflux/server.env` 的 `DATABASE_URL`，不经对话。
  2. 部署新代码 → 启动自建 schema → 手工重放数据：INSERT `default` account、
     用户 membership（UUID `096b387d-73e3-4cb2-830e-f07fd9baae22` → `default`,
     role owner）。client_tokens 不迁，重新登录即可。
  3. 旧 sqlite 文件 `/var/lib/coflux/coflux.db` 保留一段时间作回滚兜底后再删。
  4. `COFLUX_DB` 从 server.env 删除。
- 本地开发前置：selfhost Supabase（docker compose）在跑、`127.0.0.1:5432` 可连；
  非默认密码时 export `DATABASE_URL`/`COFLUX_TEST_PG_URL`。
- Supabase 免费版注意：数据库 500MB、pooler 客户端连接数有限；server 常驻查询
  会保持项目活跃（不会被 pause）。
- 将来 server 多实例（OPEN_QUESTIONS B7）：存储已外置，剩运行时状态（sessions/
  daemons Map）外置——那是另一个计划。
