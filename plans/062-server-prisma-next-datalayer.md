# Plan 062: Migrate server storage to prisma-next and local standalone Postgres

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

> **Withdrawn on 2026-07-28, never executed.** User abandoned Prisma Cloud/prisma-next and chose prod-jp self-hosted Postgres in revised 063. Keep porsager/postgres, SCHEMA_DDL, and coflux schema; do not move to public. The following is historical planning only.

This migration group's main engineering task replaces handwritten SQL/in-code DDL with prisma-next Early Access. PSL describes all 14 tables including 059 users; Store internals use prisma-next, schema moves coflux→public, local dev/black-box moves selfhost Supabase 54322→standalone PG.

**Store API and semantics remain unchanged; hub.ts (1,822 lines) has zero diff**, the first acceptance criterion. Production Prisma Postgres provisioning/data/env belongs to 063; this plan closes local dev/tests only.

Documentation, append .md for Markdown:
- https://www.prisma.io/docs/next/add-to-existing-project/postgresql — init --target postgres, contract infer/emit, db sign, db.connect/db.orm/db.sql
- https://www.prisma.io/docs/orm/next/reference/orm-client and reference/sql-query-builder, raw-queries, transactions-and-runtime
- https://www.prisma.io/docs/cli/next/db-init and db-update, configuration

## Decisions & tradeoffs

- **Use public schema**: coflux existed only to avoid Supabase/PostgREST exposure (store.ts:7,219). Prisma-next docs assume public; PSL has no @@schema, verified 2026-07-28. Undocumented beta paths cost more risk than SET SCHEMA during 063.
- **Handwrite contract from authoritative DDL**, store.ts:219-401, with @map columns/@@map tables. contract infer may cross-check live DB but its naming/types are draft quality and live-state-dependent, not truth.
- **Freeze Store API; ORM first, SQL/raw escape hatches** for ON CONFLICT, CASE WHEN, RETURNING, preserving semantics over ORM purity. Do not adapt hub or merely change connection URL; user requested prisma-next. About 102 this.sql sites, six ON CONFLICT, ten RETURNING, and conditional updates such as :691.
- **Preserve transaction-bound Store**: transaction(fn) wraps connection into a Store (:454), with identical methods inside/outside transaction, e.g. lazy-account hub:1546-1549. Use db.transaction equivalent; executor chooses documented representation (:406-455).
- **Preserve automatic empty-database readiness**: connect currently applies idempotent DDL/ALTER (:432-443); harness creates a fresh database each test (:49-61). Executor may programmatically init/update, migrate at startup, or retain a bootloader, but tests need zero extra steps. Include additions/deletions/deleting columns in contract rather than separate patches.
- **Harness default standalone PG 5432**, matching CI: postgres://postgres:postgres@127.0.0.1:5432/postgres, retaining COFLUX_TEST_PG_URL override. Install local PG through brew/docker and report actual choice. Sources harness:44-47, CI:77-80. Keeping Supabase PG conflicts with retirement goal.
- **Three type invariants**: timestamps remain double-precision numeric milliseconds; int8/BIGINT remain number (protocol/float64 safe at this scale); camelCase↔snake_case uses @map. String int8 or Date timestamps is semantic drift. store.ts:10-14,691.
- **Reassess pool settings**: max:5 was Supabase free session-pooler quota, not local requirement. Use documented prisma-next/db.connect behavior while preserving ssl:prefer for plaintext local/TLS managed. store.ts:418-424.
- **Node prerequisite met**: requires 24+; .nvmrc/prod-jp v24.17.0, local v26, measured 2026-07-28.

## Direction

### Milestone 1: Contract

prisma-next init --target postgres in apps/server; handwrite 14 tables, emit, db init local PG, compare tables/columns/indexes/unique constraints individually. contract emit and server build pass.

### Milestone 2: Store

Move all 102 sites to ORM/builder/raw, remove server postgres dependency, preserve Store/hub. Build passes; git diff --stat -- apps/server/src/hub.ts empty.

### Milestone 3: Tests

Switch harness default and preserve automatic new-DB readiness. Full black-box on standalone PG is mandatory primary acceptance.

## Landmines

- Keep tests' postgres management dependency (package.json:14/harness); no need to migrate admin connections.
- Preserve c772ed4's :1074 egress optimization: do not return ansi_snapshot via RETURNING *.
- postgres.camel (:421) previously transformed both directions globally. Audit every @map or missing columns silently become undefined.
- sql(obj,...cols) (:495) writes selected columns only; preserve exact sets.
- Supavisor may occupy local 5432 and return tenant errors. Use another installed port with explicit overrides if needed; harness default still matches CI 5432.
- Early Access @prisma/cli 3.0.0-beta bugs should use documented raw escape hatches and records, never semantic hacks.

## Scope

In scope: server Store/config databaseUrl comments/package/contracts/config/scripts; harness ADMIN_PG_URL default.

Out of scope: hub.ts, protocol/clients, production provisioning/migration/env (063), local Supabase shutdown/removal user action.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build | `pnpm --filter @coflux/server build` | exit 0 |
| Contract | `cd apps/server && npx prisma-next contract emit` | exit 0 |
| Full black-box | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test` | exit 0 |
| Dev acceptance | pnpm dev:server on standalone PG, Web login/workspace creation | Works |

## Done criteria

- [ ] All listed commands pass.
- [ ] hub.ts has zero diff; the postgres dependency is removed from apps/server/package.json.
- [ ] The full black-box suite passes on standalone Postgres and prisma-next.
- [ ] `rg -i supabase apps/server tests/src/harness.mjs` returns no matches, including comments.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded work required, validation fails twice after one reasonable fix.
- Even escape hatches cannot preserve transaction Store signatures, fresh-DB readiness, or any type invariant: stop and report, never weaken semantics.

## Maintenance notes

- Under this withdrawn proposal, PSL would replace DDL truth; future changes would edit contract, emit, and migrate.
- Proposed post-063 URL was Prisma Postgres db.prisma.io; this plan itself preserves DATABASE_URL semantics, documenting standalone defaults only.

### Original source references

`apps/server/src/store.ts:7`, `apps/server/src/store.ts:7,219`, `apps/server/src/store.ts:219-401`, `store.ts:691`, `store.ts:454`, `hub.ts:1546-1549`, `apps/server/src/store.ts:406-455`, `store.ts:432-443`, `tests/src/harness.mjs:49-61`, `apps/server/src/store.ts:432-443`, `tests/src/harness.mjs:44-47`, `.github/workflows/ci.yml:77-80`, `store.ts:13`, `apps/server/src/store.ts:10-14,691`, `store.ts:419-420`, `apps/server/src/store.ts:418-424`, `tests/package.json:14`, `store.ts:1074`, `store.ts:421`, `store.ts:495`.
