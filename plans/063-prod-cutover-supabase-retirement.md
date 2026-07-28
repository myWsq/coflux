# Plan 063: 生产切换 prod-jp 自托管 Postgres + Supabase 全面退役

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
- Depends on: plans/059-server-password-auth.md, plans/060-web-mobile-login-consolidation.md, plans/061-ios-login-consolidation.md
- Category: migration
- Execution: self（主会话 + 用户配合验收）
- Planned at: `c772ed4`, 2026-07-28（2026-07-28 复议改写：放弃 Prisma Cloud，数据库自托管在 prod-jp；原 062 prisma-next 数据层改写随之撤回，数据层代码保持 porsager/postgres 原样）

## Requirement

059-061 合并后，把生产从「Supabase Postgres + Supabase Auth」切到「prod-jp 本机 Postgres 17 + 自建 password auth」，随后退役 Supabase。约束（用户 2026-07-28）：单用户自用，**无用数据可弃，关键数据保住即可**；短暂维护窗口可接受；不引入 Prisma（用户 2026-07-28 复议明确）。

完成后：api/app.coflux.dev 全功能运行，DATABASE_URL 指向 prod-jp 本机 PG（localhost）；用户以邮箱+密码登录；已登记设备无需重新 enroll；历史 checkpoints 可见；生产无任何 SUPABASE_* 配置；每日自动备份在位；Supabase 项目可删除。附带收益（记录动机）：消灭 Supabase egress 计费面（c772ed4 刚为 checkpoint egress 打过补丁）与 server→DB 的跨洋网络往返。

## Decisions & tradeoffs

- **数据库落点：prod-jp 本机 apt 安装 postgresql 17**（Debian 13 candidate 17+278，与 Supabase 侧 PG 17.6 同大版本，2026-07-28 实测；prod-jp 现无任何 PG 服务，85G 盘 / 2.7G 可用内存足够单用户负载）。systemd 托管、仅监听 127.0.0.1、专用库/账号（如 `coflux`）。Rejected: docker 容器 PG —— 数据路径上多一层运行时依赖，apt+systemd 更无聊更稳；Rejected: Prisma Postgres —— 用户复议放弃，自托管消灭 egress 与延迟。
- **数据层代码零改动**：保持 porsager/postgres + SCHEMA_DDL 原样（原 062 的 prisma-next 改写已撤回）。**schema 保留 `coflux`**——迁 public 的唯一动机是 prisma-next 的 beta 工具链顾虑，已消失；保留则 dump/restore 与代码全部零改动。Rejected: 借机迁 public —— 纯折腾。
  Based on: `apps/server/src/store.ts:219`（CREATE SCHEMA coflux）、`apps/server/src/store.ts:418-424`（连接配置，`ssl:"prefer"` 对 localhost 明文直接可用，max=5 无需动）。
- **关键数据清单**（迁移必保）：`accounts`、`memberships`、`devices`（token_hash 保住 ⇒ 全部 daemon 免重新 enroll）、`projects`、`workspaces`、`tasks`、`session_checkpoints`、`meta`。**可弃**（自然重建/重登）：`client_tokens`（各端重新登录）、`local_gateways`、`local_browser_grants`、`local_device_leases`、`prepared_device_operations`（租约/临时态）。实操上 `pg_dump -n coflux` 全 schema 拿下再弃也行，白名单 `-t` 也行——executor 择优，对账以关键表行数为准。Rejected: 双写/渐进迁移 —— 单用户短停机成本近零。
  Based on: `apps/server/src/store.ts:219-401`（各表语义），用户拍板「关键数据在就行」。
- **身份衔接：以旧 Supabase user UUID 建号**。生产 `memberships.user_id` 是 Supabase user UUID；用 059 建号脚本 `--id` 指定同一 UUID（email 用用户现邮箱），membership/账号数据零改动衔接。Rejected: 新 UUID + 数据改写 —— 多一步且易漏关联。
  Based on: plans/059 建号脚本决策、`apps/server/src/hub.ts:1542`（getMembershipByUser 按 user_id 查）。
- **搬迁工具链就地取材**：prod-jp 已有 pg_dump/psql 17.10，直接在 prod-jp 上对 Supabase 源库 dump（需 Supabase **direct** 连接串，不走 pooler；连接串在 prod-jp 现有 env 里是 pooler 形态，direct 串从 Supabase 控制台取——只引用位置不落明文）→ restore 进本机 PG。Rejected: 本机中转 —— 多一跳且本机无 pg 客户端工具。
- **备份是硬要求，不许懒**：自托管单盘无云备份兜底。每日 cron `pg_dump -Fc` 到本机备份目录 + 保留最近 N 份（简单 find -mtime 轮转即可）；是否异地另存由用户后续决定，plan 内先落本机每日备份。这是防数据丢失的错误处理，属 ponytail 明文不可简化项。
- **prod-jp env 目标态**：`COFLUX_AUTH=password`、`DATABASE_URL=postgres://coflux:<pw>@127.0.0.1:5432/coflux`（口令新生成，只存于 env，不入 git）；删除 `SUPABASE_URL`、`COFLUX_USERNAME`/`COFLUX_PASSWORD`。web 生产构建不再带 `VITE_SUPABASE_*`。部署机制（Caddy、服务单元、build-id 自举）一律不动。
- **验收顺序**：先 smoke（`scripts/prod-smoke.mjs` + 手工：web 邮箱登录、设备在线、历史 checkpoint 打开、iOS 登录），全绿后才动 Supabase 退役；Supabase 项目保留只读至少数天作回滚垫，最终删除由用户在控制台操作。Rejected: 切换即删 —— 回滚垫零成本。

## Direction

### Milestone 1: prod-jp PG 就位 + 搬迁演练

apt 装 postgresql 17，localhost-only，建 `coflux` 库与专用账号；对 Supabase 生产库只读 dump 一次，restore 进本机 PG 做演练（schema 原名 `coflux`），关键表行数对账一致；每日备份 cron 就位并手动触发一次验证产物可 `pg_restore --list`。
Validation: 行数对账一致；备份文件存在且可列出内容。

### Milestone 2: 切换窗口

停 prod server → 终态 dump → restore（清演练数据重灌或直接覆盖，executor 自定）→ 059 建号脚本建号（旧 UUID + 用户邮箱，密码由用户提供或临时生成后由用户改）→ 更新 env → 部署 059-061 合并后的代码与前端产物 → 起服。
Validation: `node scripts/prod-smoke.mjs` 通过；web 邮箱登录 + 设备在线 + 历史 checkpoint 可见；iOS 登录（新版随 release.sh 发 TestFlight 后验）。

### Milestone 3: 退役与收尾

Supabase 项目暂停（删除由用户择日）；memory 更新（prod-server、local-test-postgres、deploy-strategy 的 Supabase 表述）；plans/README.md 收尾。
Validation: 生产运行数天无异常（观察项，非阻塞）。

## Landmines

- `client_tokens` 弃迁 ⇒ 所有客户端收 authError 清 token 回登录页——预期行为，不是故障。
- `devices.token_hash` 若丢失，全部 daemon 需重新 enroll（含 memory fix-connect-branch 里那台待手动 update 的 LVR96VXW43）——devices 表行数对账必须严格一致。
- pg_dump 对 Supabase 必须用 **direct** 连接串；pooler（supavisor）上跑 dump 会遇到 prepared statement/超时类问题。
- prod-jp 内存仅 7.8G 且已用 5G（headroom/clickhouse 在跑）——PG 配置保持默认偏小即可（单用户负载极轻），不要照抄调优模板把 shared_buffers 拉大。
- server 的 `ssl: "prefer"`（store.ts:420）对 localhost 明文可直连，无需改代码；但若 pg_hba 配置成必须 TLS 会连不上——装机时保持 Debian 默认 local/host 认证即可。
- web 构建历史命令带 `VITE_SUPABASE_*`（plans/010/011 文档、memory prod-server）——060 后不再需要；沿用旧部署笔记会注入无效变量（无害但应清理笔记与 memory）。

## Scope

In scope:
- prod-jp 环境（apt、PG 实例、cron、env、部署、服务重启）、Supabase 控制台（退役，用户操作）
- `scripts/`（如需一次性迁移/备份脚本，落库留档）
- memory 文件更新、`plans/README.md`

Out of scope:
- 任何 apps/ packages/ 源码改动 —— 059-061 已完成；发现代码问题一律停下报告
- 本机 selfhost Supabase 容器组 —— 继续当本地开发/测试的裸 PG 用（54322 直连口），拆不拆由用户日后决定

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 迁移对账 | 关键表 `SELECT count(*)` 源/目标对比 | 一致 |
| 备份验证 | `pg_restore --list <备份文件>` | 列出对象 |
| 生产冒烟 (acceptance) | `node scripts/prod-smoke.mjs` | exit 0 |
| 人工验收 (acceptance) | web/iOS 邮箱登录、设备在线、checkpoint 回看 | 全通 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 生产在 prod-jp 本机 PG + password auth 上全功能运行；设备免重新 enroll。
- [ ] 每日备份 cron 在位且经过一次手动验证。
- [ ] 生产 env 无任何 SUPABASE_* 残留；Supabase 项目已暂停（删除由用户择日）。
- [ ] memory（prod-server、local-test-postgres、deploy-strategy）已更新。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- 059-061 任一未验收完成。
- 演练行数对账不一致且一次修正后仍不一致。
- 切换窗口内任何不可解释的数据缺失——立即回滚 env 指回 Supabase（源表未动，回滚即恢复）。

## Maintenance notes

- 回滚垫：切换后 Supabase 项目保留只读数天；env 指回即回滚（059-061 的代码改动与数据库托管方无关，可不回滚代码）。
- 自托管后 schema 演进回归本色：SCHEMA_DDL 幂等块 + 手工 ALTER 补列（store.ts:440 注释的既有惯例）。
- prod-jp 单机同时承载 server 与 PG——磁盘/内存水位纳入日常观察；若未来多机，PG 迁移只是 dump/restore + 改 DATABASE_URL。
