# Plan 002: Storage layer migration - node:sqlite → Supabase Postgres (hosted PG mode)

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

The user chose Supabase primarily for its database. Exploration incorrectly narrowed the choice to Auth, so plan 001 retained SQLite; this plan corrects that decision. Fully migrate the coflux server's persistence layer from `node:sqlite` to Postgres. Production connects to the Supabase cloud project's managed Postgres, while local development/tests use self-hosted Postgres through docker compose at `localhost:5432`.

The following must hold on completion:

1. Postgres, configured by `DATABASE_URL`, is the server's only persistence engine. Remove `node:sqlite` and `COFLUX_DB` from the code.
2. **Architecture remains unchanged**: the server remains the sole data-access layer in a hosted-PG model. Do not use Supabase RLS, PostgREST, Realtime, or Storage. Web/daemon paths, protocol, authorization, and plan 001's token-exchange authentication remain unchanged.
3. Integration tests use local Postgres, with a randomly named temporary database per stack, deleted afterward. All 26 existing test files retain their semantics and pass.
4. The local harness remains isolated from production data: local tests use self-hosted PG, while production uses the cloud pooler.

This changes the storage engine, not the architecture. Direct web access to Supabase, RLS authorization, Supabase-specific table behavior such as auth.uid(), or retaining SQLite behind a dual-engine abstraction would violate the scope.

## Decisions & tradeoffs

- **Use Postgres exclusively and remove SQLite**. Rejected: `COFLUX_DB_DRIVER=sqlite|postgres`. Two engines require two implementations and two test paths for every query. The user explicitly chose Supabase PG, and requiring self-hosters to supply Postgres—self-hosted Supabase or any PG—is acceptable.
- **PG client: `postgres` (postgres.js, porsager/postgres)**. Pure JS with no dependencies, parameterized tagged templates to prevent injection, and a built-in connection pool. Rejected: `pg` (node-postgres), which is also viable but has more dependencies and a more verbose API. Do not install both.
- **Store coflux tables in a dedicated `coflux` schema rather than `public`**. Supabase may expose `public` through PostgREST depending on project settings. A separate schema isolates application data and avoids mixing with Supabase objects. Use either `SET search_path` after connection or explicit schema prefixes consistently; the executor chooses.
- **Continue application-managed schema creation at startup**: `CREATE SCHEMA IF NOT EXISTS` plus `CREATE TABLE IF NOT EXISTS`, following `store.ts:58-105`. Preserve lightweight `migrate()` behavior by inspecting information_schema and adding missing columns. Rejected: Supabase CLI migrations or another migration tool, which adds tooling/deployment coupling. A single application managing its own schema is simpler here; single-instance deployment avoids concurrent DDL.
- **Use database constraints for asynchronous concurrency**. SQLite's synchronous API made message handling naturally atomic. With async Postgres, messages from the same or different clients may interleave. Do not add application locks/queues. Express invariants with DB constraints: memberships primary key (userId, accountId), idempotent lazy provisioning through `ON CONFLICT`/transactions, and the existing devices/client_tokens tokenHash primary-key/uniqueness constraints. Convert check-then-write paths such as lazy account creation (`hub.ts:667-680`) and the four cascade-deletion `store.transaction` calls into async transactions using postgres.js `sql.begin`. Rejected: per-connection serial message queues, which overcomplicate the current model and do not solve races across connections.
- **Make the entire `Store` API asynchronous**. Every method returns a Promise; await all 65 calls in `hub.ts` and 10 in `index.ts`, including bootstrap. Message handlers already allow async (`handleClientAuth`, `hub.ts:396-399`, with fire-and-forget and an unauthenticated guard). Preserve validation/write-before-broadcast ordering; never broadcast before persistence completes.
- **Connection configuration uses `DATABASE_URL`**, integrated into `config.ts` fail-closed checks. Production must supply it explicitly; dev (`COFLUX_DEV=1`) defaults to `postgres://postgres:postgres@127.0.0.1:5432/postgres`. Remove `COFLUX_DB` and dbPath. Keep the pool small, around max 5: production uses the Supabase session pooler, the free tier limits client connections, and a single server instance needs few connections.
- **Use the IPv4 session pooler in production (verified)**. prod-jp has no IPv6, so `db.<ref>.supabase.co:5432` is unreachable. Both 5432 (session) and 6543 (transaction) on `aws-0-ap-northeast-1.pooler.supabase.com` are reachable. Choose **session pooler 5432** for direct-connection semantics and prepared-statement support; the transaction pooler is incompatible with postgres.js's default prepared mode. Based on SSH/nc measurements from prod-jp during this investigation.
- **A randomly named temporary database per test stack**. The harness management connection uses `COFLUX_TEST_PG_URL`, defaulting to the dev connection string, and runs `CREATE DATABASE coflux_test_<rand>`. Point the server process's `DATABASE_URL` at it; disconnect database clients and DROP it during cleanup. Rejected: a temporary schema, since parameterizing the server's fixed schema name is more invasive; and starting temporary PG containers, since local self-hosted PG already exists.
- **Preserve `meta`, credFingerprint, and pruneClientTokens logic**, changing only database access. Local auth (`COFLUX_AUTH=local`) is orthogonal to storage and retains its semantics.
- **Replay production data manually; no migration tool**. Production has almost no data: one `default` account, one membership, a few enrollment_keys/client_tokens, and zero devices. Manually INSERT the account/membership into PG during cutover; do not migrate client_tokens, so users log in again. Rejected: a disposable sqlite→pg data-pump tool for this near-empty dataset. See Maintenance notes.

## Direction

`store.ts` is the sole persistence boundary; hub/index access the database only through it. Replace its implementation and await its callers, with no protocol/web/daemon/crates changes.

### Milestone 1: Postgres storage, async callers, and passing local tests

The server connects through `DATABASE_URL` and behaves like `ef34fed` in both local and Supabase auth modes. Remove the `node:sqlite` import and `COFLUX_DB`. The harness uses temporary databases, and all 26 existing test files pass with **no semantic changes**; harness.mjs environment setup may change.

Validation: `pnpm --filter @coflux/tests test` passes with local PG available; `pnpm -r build` exits 0; `grep -r "node:sqlite" apps/server/src` finds no matches.

## Landmines

- **Prerequisite**: local self-hosted Supabase PG is reachable at `127.0.0.1:5432`, but its **password is unknown**. Try the dev default first. If it fails, STOP and ask for `COFLUX_TEST_PG_URL` with the real password. Do not guess passwords or write the password to a file.
- The four `store.transaction(fn)` callers (`hub.ts:469,516,677,779`) currently use synchronous closures. postgres.js passes a **transaction-specific sql instance** to `sql.begin`; every statement in the transaction must use it, or it silently escapes the transaction. Design the Store transaction API so callers cannot accidentally use the global connection.
- SQLite stores booleans/timestamps as INTEGER (`isMain INTEGER`, `revoked INTEGER`, and manual `rowToWorkspace`/`rowToDevice` conversion in `store.ts:326-368`). If PG uses boolean/`BIGINT` instead, remember that postgres.js returns bigint as strings by default. Configure timestamp parsing for fields such as `createdAt`, or carefully choose `DOUBLE PRECISION`/`NUMERIC`. `packages/protocol` expects numbers; do not leak strings.
- `handleClientAuth` is already async fire-and-forget (`hub.ts:396-399`). Making other handlers async allows same-connection messages to interleave. Existing tests implicitly depend on ordering, such as `state.snapshot` preceding later broadcasts after subscribe. Run the full suite; investigate interleaving before changing assertions when ordering failures appear.
- `pnpm dev:server` in dev mode (`COFLUX_DEV=1`) currently runs without external dependencies. After migration, local PG must be running. Update the README quick-start prerequisites accordingly.
- The harness currently sets `COFLUX_DB` when `startServer`/`startStack` spawn the server (`tests/src/harness.mjs:124` and `startServer`). After moving to temporary databases, `restartServer` must reuse the same database: reconnect.test depends on persistence across restart.
- Disconnect all clients before DROP DATABASE, using `pg_terminate_backend` or appropriate postgres.js `.end()` ordering. Otherwise PG reports "being accessed by other users"; silently failing in an after hook leaks a test database.

## Scope

In scope:
- `apps/server/src/` (database access in store/config/hub/index/auth)
- `apps/server/package.json` (+`postgres`, −None; `node:sqlite` is a built-in module and does not need to be deleted)
- `tests/src/` (harness environment assembly; test file semantics unchanged)
- `tests/package.json` (if `postgres` devDep is required to manage the connection)
- `README.md` (preliminary instructions for quick start)
- `pnpm-lock.yaml`
- `plans/`

Out of scope:
- `packages/protocol`, `apps/web`, `crates/`, `packages/cli` — the storage engine is invisible to them
- Supabase RLS / PostgREST / Realtime - explicitly not used (see Requirement judgment)
- Production switching and data replay - operation and maintenance steps (Maintenance notes), the code is merged and executed separately
- sqlite→pg automatic migration tool - production data approaches zero, do not do it

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Test | `pnpm --filter @coflux/tests test` | exit 0 (prerequisite: local PG can be connected) |
| Typecheck/Build | `pnpm -r build`  | exit 0 |
| Confirm SQLite removal | `grep -rn "node:sqlite\|COFLUX_DB\b" apps/server/src tests/src` | No matches |

## Done criteria

- [ ] All listed commands pass.
- [ ] 26 existing test files have zero semantic changes and are all green (except for harness assembly layer changes).
- [ ] Both `COFLUX_AUTH=local` and `COFLUX_AUTH=supabase` modes work under PG (supabase.test.mjs covers the latter).
- [ ] Transaction paths (device delete cascade, workspace delete cascade, lazy provision) are atomic within PG transactions.
- [ ] coflux tables are all in `coflux` schema, `public` has no residue.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md`  status is updated.

## STOP conditions

- The local PG cannot be connected and the user does not provide `COFLUX_TEST_PG_URL`.
- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- postgres.js is not compatible with node 24/tsx environments (if native builds are required) - stop and report.

## Maintenance notes

- **Production Switching Operation and Maintenance Manual (after code merger)**:
  1. Get the cloud project database password from Supabase dashboard (Settings → Database, if necessary reset); use **session pooler** for connection string: `postgres://postgres.yafiocdmkhjuphmmwtrn:<password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres` (prod-jp does not have IPv6 and cannot use direct connection). The password is written manually by the user `DATABASE_URL` of `/etc/coflux/server.env` without pasting it into the conversation.
  2. Deploy new code → start application-managed schema → manually replay data: INSERT `default` account, User membership (UUID `096b387d-73e3-4cb2-830e-f07fd9baae22` →`default`, role owner). client_tokens will not be migrated, just log in again.
  3. The old sqlite file `/var/lib/coflux/coflux.db` is retained for a period of time for rollback and then deleted.
  4. Remove `COFLUX_DB` from server.env.
- Local development prerequisite: selfhost Supabase (docker compose) is running, `127.0.0.1:5432` can be connected; if the password is not the default, export `DATABASE_URL`/`COFLUX_TEST_PG_URL`.
- Supabase free version note: database 500MB, pooler client connection number is limited; server resident query will keep the project active (not paused).
- Multi-instance server in the future (OPEN_QUESTIONS B7): the storage has been externalized, leaving runtime status (sessions/ daemons Map) external - that's another plan.
