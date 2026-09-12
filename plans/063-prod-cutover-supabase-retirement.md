# Plan 063: Production cutover to prod-jp Postgres and retirement of Supabase

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
- Risk: HIGH (production changes)
- Depends on: plans/059-server-password-auth.md, plans/060-web-mobile-login-consolidation.md, plans/061-ios-login-consolidation.md
- Category: migration
- Execution: self (main session with user-assisted acceptance)
- Planned at: `c772ed4`, 2026-07-28 (2026-07-28 reconsideration and rewriting: abandon Prisma Cloud, the database is self-hosted in prod-jp; the original 062 prisma-next data layer rewriting was subsequently withdrawn, and the data layer code remains porsager/postgres as it is)

## Requirement

After 059–061 merge, move from Supabase Postgres/Auth to prod-jp local Postgres 17 plus password auth, then retire Supabase. User decision 2026-07-28: single-user deployment, **retain essential data; disposable data may be dropped**, brief maintenance acceptable, no Prisma. Original 062 was withdrawn; retain porsager/postgres.

api/app.coflux.dev remain fully functional. DATABASE_URL becomes localhost PG; email/password login; no daemon reenrollment; old checkpoints visible; no SUPABASE_* env; daily backup; Supabase project may be deleted. Motivation also removes Supabase egress billing (c772ed4 just reduced checkpoint egress) and cross-ocean server→DB RTT.

## Decisions & tradeoffs

- **apt Postgres 17 on prod-jp**, Debian 13 candidate 17+278, same major as Supabase 17.6. Measured 2026-07-28: no PG service, 85GB disk and 2.7GB free RAM sufficient. systemd, 127.0.0.1 only, dedicated coflux DB/user. Reject Docker runtime layer and user-rejected Prisma Postgres; local hosting removes egress/latency.
- **No data-layer changes; keep coflux schema**. Only prisma-next beta concerns motivated public, now gone. Existing DDL/search path/dump restore stay unchanged; ssl:prefer and max:5 work locally (store.ts:219,418-424). Moving public adds pointless work.
- **Essential tables**: accounts, memberships, devices including token_hash, projects, workspaces, tasks, session_checkpoints, meta. **Disposable**: client_tokens (relogin), local_gateways, local_browser_grants, local_device_leases, prepared_device_operations (temporary leases/state). Executor may dump whole schema with pg_dump -n coflux or whitelist -t, then compare essential row counts. No dual-write/gradual migration for negligible single-user downtime. Source DDL:219-401.
- **Preserve user UUID** through 059 admin script --id using old memberships.user_id and current email. This reconnects account/membership without rewrites. New UUID risks missed associations; hub.ts:1542 looks up by user_id.
- **Use prod-jp's pg_dump/psql 17.10** to dump source directly then restore locally. Require Supabase direct URL from console, not existing pooler env; reference credential location, never print it. Local machine lacks PG tools and would add a hop.
- **Daily backups mandatory**: pg_dump -Fc to local backup directory with recent-N retention, simple find -mtime sufficient. Off-site choice can follow user decision; local daily protection cannot be deferred. Self-hosting has one disk and no managed cloud backup.
- **Target env**: COFLUX_AUTH=password; DATABASE_URL=postgres://coflux:<pw>@127.0.0.1:5432/coflux with generated password only in env, never Git. Remove SUPABASE_URL/COFLUX_USERNAME/COFLUX_PASSWORD and Web VITE_SUPABASE_* build inputs. Keep Caddy/service/build-ID deployment mechanics.
- **Smoke before retirement**: prod-smoke plus Web email login/device online/historical checkpoint/iOS login. Keep Supabase read-only for several days as rollback; user performs final console deletion. Immediate deletion discards free rollback.

## Direction

### Milestone 1: Install and rehearse

Install localhost-only PG17/dedicated DB/user; read-only source dump, restore coflux schema, compare essential counts. Install daily backup cron, trigger once, inspect with pg_restore --list. Counts match and backup is readable.

### Milestone 2: Cutover window

Stop server→final dump→replace rehearsal data/restore→admin user with old UUID/email and user-provided or temporary password→update env→deploy merged 059–061/backend/frontend→start. prod-smoke passes; Web login/devices/checkpoints visible; iOS new release.sh/TestFlight build verified afterward.

### Milestone 3: Retire and close

Suspend Supabase; user chooses deletion date. Update recorded prod-server/local-test-postgres/deploy-strategy guidance and README. Observe several uneventful days; observation is nonblocking.

## Landmines

- Discarded client_tokens cause authError/token clear/login everywhere, expected.
- Losing devices.token_hash forces reenrollment, including remembered manually updated LVR96VXW43. Device counts must match strictly.
- Dump through direct Supabase connection; Supavisor pooler risks prepared-statement/timeouts.
- prod-jp has 7.8GB total/~5GB used by headroom/ClickHouse. Keep modest PG defaults; do not inflate shared_buffers with generic tuning.
- ssl:prefer supports plaintext localhost; requiring TLS in pg_hba would break that. Keep Debian local/host defaults.
- Historical 010/011/prod-server commands inject obsolete VITE_SUPABASE_*; harmless after 060 but clean docs/guidance.

## Scope

In scope: prod-jp apt/PG/cron/env/deployment/restart, user Supabase-console retirement, scripts if useful to retain, guidance/README updates.

Out of scope: apps/packages source, completed by 059–061; report defects. Local selfhost Supabase remains usable as direct PG54322 until user separately chooses removal.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Reconciliation | Essential table SELECT count(*) source/target | Match |
| Backup | `pg_restore --list <backup-file>` | Objects listed |
| Production smoke | `node scripts/prod-smoke.mjs` | exit 0 |
| Manual acceptance | Web/iOS email login, devices online, checkpoint review | All work |

## Done criteria

- [ ] All listed commands pass.
- [ ] Production runs all functionality on prod-jp local Postgres with password authentication, without device reenrollment.
- [ ] Daily backup cron is installed and verified through one manual run.
- [ ] Production environment has no SUPABASE_* values; the Supabase project is suspended, with deletion left to the user on a later date.
- [ ] Memory entries prod-server, local-test-postgres, and deploy-strategy are updated.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Any 059–061 acceptance incomplete.
- Rehearsal row mismatch persists after one correction.
- Any unexplained cutover data loss: immediately restore DATABASE_URL to untouched Supabase source.

## Maintenance notes

- Rollback source remains a few days; restore env pointer, not code, because 059–061 do not depend on DB host.
- Schema evolution retains idempotent SCHEMA_DDL plus manual ALTER supplements per store.ts:440.
- Observe shared server/PG disk/memory. Future relocation is dump/restore plus DATABASE_URL.

### Original source references

`apps/server/src/store.ts:219`, `apps/server/src/store.ts:418-424`, `apps/server/src/store.ts:219-401`, `apps/server/src/hub.ts:1542`.
