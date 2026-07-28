# Plan 063: 生产切换 Prisma Postgres + Supabase 全面退役

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH（动生产）
- Depends on: plans/059-server-password-auth.md, plans/060-web-mobile-login-consolidation.md, plans/061-ios-login-consolidation.md, plans/062-server-prisma-next-datalayer.md
- Category: migration
- Execution: self（主会话 + 用户配合：Prisma Cloud 浏览器登录、验收）
- Planned at: `c772ed4`, 2026-07-28

## Requirement

059-062 合并后，把生产从「Supabase Postgres + Supabase Auth」切到「Prisma Postgres + 自建 password auth」，随后退役 Supabase。约束（用户 2026-07-28）：单用户自用，**无用数据可弃，关键数据保住即可**；不追求零停机——短暂维护窗口可接受（自用产品）。

完成后：api/app.coflux.dev 全功能运行在 Prisma Postgres 上；用户以邮箱+密码登录；已登记设备无需重新 enroll；历史 checkpoints 可见；生产环境无任何 SUPABASE_* 配置；Supabase 项目可删除。

## Decisions & tradeoffs

- **关键数据清单**（迁移必保）：`accounts`、`memberships`、`devices`（token_hash 保住 ⇒ 全部 daemon 免重新 enroll）、`projects`、`workspaces`、`tasks`、`session_checkpoints`、`meta`。**可弃**（自然重建/重登）：`client_tokens`（各端重新登录）、`local_gateways`、`local_browser_grants`、`local_device_leases`、`prepared_device_operations`（租约/临时态）。Rejected: 全量搬迁 —— 临时态表搬了也是过期数据。
  Based on: `apps/server/src/store.ts:219-401`（各表语义），用户拍板「关键数据在就行」。
- **身份衔接：以旧 Supabase user UUID 建号**。生产 `memberships.user_id` 是 Supabase user UUID；用 059 建号脚本的 `--id` 指定同一 UUID 建 users 行（email 用用户现邮箱），membership/账号数据零改动衔接。Rejected: 新 UUID + 数据改写 —— 多写一个 UPDATE 且易漏 `client_tokens.user_id` 类关联。
  Based on: plans/059 建号脚本决策、`apps/server/src/hub.ts:1542`（getMembershipByUser 按 user_id 查）。
- **数据搬迁路径**：维护窗口内 `pg_dump -Fc -n coflux`（只 dump 关键表，`-t` 白名单）→ restore 到 Prisma Postgres direct 连接串 → `ALTER TABLE ... SET SCHEMA public`（或 dump/restore 间改写 schema，executor 实操择优）→ `prisma-next db sign`。要求本机 PostgreSQL 17 客户端工具（Prisma 导入指南前置）。Rejected: 双写/同步渐进迁移 —— 单用户短停机成本近零，渐进方案纯增复杂度。
  Based on: https://www.prisma.io/docs/next/prisma-postgres/import-from-existing-database-postgresql （官方仅演示 public schema，故 SET SCHEMA 步骤必须显式做）、plans/062 的 public schema 决策。
- **Prisma Postgres provision 走 CLI**，需用户浏览器登录（`npx @prisma/cli@latest auth login`，2026-07-28 实测当前为 signed out）。连接串形如 `postgres://...@db.prisma.io:5432/postgres?sslmode=require`，进 prod-jp 的 server env（DATABASE_URL）。
- **prod-jp env 目标态**：`COFLUX_AUTH=password`、`DATABASE_URL=<Prisma Postgres>`；删除 `SUPABASE_URL`、`COFLUX_USERNAME`/`COFLUX_PASSWORD`（password 模式下不参与）。web 生产构建不再带 `VITE_SUPABASE_*`。部署机制（Caddy、服务单元、build-id 自举）一律不动。
  Based on: `apps/server/src/config.ts`（059 后的 env 面）、memory prod-server（构建变量现状，本 plan 完成后更新该 memory）。
- **验收顺序**：先 smoke（`scripts/prod-smoke.mjs` + 手工：web 邮箱登录、设备在线、历史 checkpoint 打开、iOS 登录），全绿后才动 Supabase 项目退役；Supabase 项目保留只读至少数天作回滚垫，由用户在控制台最终删除。Rejected: 切换即删 —— 免费额度不差这几天，回滚垫零成本。

## Direction

### Milestone 1: provision + 数据搬迁演练

用户完成 Prisma Cloud 登录；provision 生产库；对 Supabase 生产库做只读 dump，在本地或直接对 Prisma Postgres 完成一次全流程搬迁演练（含 SET SCHEMA、db sign、关键表行数对账）。
Validation: 演练库上 `prisma-next db verify` 通过；关键表行数与源库一致。

### Milestone 2: 切换窗口

停 prod server → 终态 dump → 搬迁 → 建号（旧 UUID + 用户邮箱）→ 更新 env → 部署 059-062 合并后的代码与前端产物 → 起服。
Validation: `scripts/prod-smoke.mjs` 通过；web 邮箱登录 + 设备在线 + 历史 checkpoint 可见；iOS TestFlight 版登录（新版本需先随 release.sh 发出）。

### Milestone 3: 退役与收尾

Supabase 项目暂停/删除（用户操作）；memory 更新（prod-server、local-test-postgres、deploy-strategy 中 selfhost Supabase 表述）；plans/README.md 收尾；本机 selfhost Supabase 停用提示。
Validation: 生产运行若干天无 Supabase 依赖报错（观察项，非阻塞）。

## Landmines

- 各端 `client_tokens` 弃迁 ⇒ 所有客户端（web/mobile/iOS、AuthorizePage 旁路）会收 authError 清 token 回登录页——预期行为，不是故障。
- `devices.token_hash` 若丢失，全部 daemon 需重新 `enroll`（LVR96VXW43 还有一台待手动 update 的旧设备，见 memory fix-connect-branch）——对账时 devices 表行数必须严格一致。
- Prisma Postgres 连接串分 direct 与 pooled（导入必须用 direct）；server 运行用哪种由 062 的池配置决策对齐，别混用。
- prod-jp 的 Node 已是 v24.17.0（2026-07-28 实测），满足 prisma-next 要求，无需升级——但部署脚本若有 node 版本假设需过目。
- web 构建历史命令带 `VITE_SUPABASE_*`（plans/010/011 文档、memory prod-server）——切换后按 060 已不需要；若沿用旧部署笔记会注入无效变量（无害但应清理笔记与 memory）。

## Scope

In scope:
- prod-jp 环境（env、部署、服务重启）、Prisma Cloud（provision）、Supabase 控制台（退役，用户操作）
- `scripts/`（如需一次性迁移脚本，用后可留档）
- memory 文件更新、`plans/README.md`

Out of scope:
- 任何 apps/ packages/ 源码改动 —— 059-062 已完成；此处发现代码问题一律停下报告
- 本机 selfhost Supabase 的实际拆除 —— 提示用户自行处理

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Prisma 登录态 | `npx @prisma/cli@latest auth whoami` | signed in |
| 迁移对账 | 关键表 `SELECT count(*)` 源/目标对比 | 一致 |
| 生产冒烟 (acceptance) | `node scripts/prod-smoke.mjs` | exit 0 |
| 人工验收 (acceptance) | web/iOS 邮箱登录、设备在线、checkpoint 回看 | 全通 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 生产在 Prisma Postgres + password auth 上全功能运行；设备免重新 enroll。
- [ ] 生产 env 无任何 SUPABASE_* 残留；Supabase 项目已暂停（删除由用户择日）。
- [ ] memory（prod-server、local-test-postgres、deploy-strategy）已更新。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- 059-062 任一未验收完成。
- 演练中 `db verify`/行数对账不一致且一次修正后仍不一致。
- 切换窗口内任何不可解释的数据缺失——立即回滚 env 指回 Supabase（表未动，回滚即恢复）。

## Maintenance notes

- 回滚垫：切换后 Supabase 项目保留只读数天；env 指回即回滚（代码侧 059-062 与数据库托管方无关，可不回滚代码）。
- 此后 schema 演进走 prisma-next migration 流程（见 plans/062 维护注记）；Prisma Cloud 账号/额度状况留意 Early Access → GA 的条款变化。
