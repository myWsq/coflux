# Plan 031: Extract packages/client to share the protocol client and store across web and mobile

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 3ab2c65..HEAD -- apps/web/src/client apps/web/src/config.ts apps/web/src/lib/auth.ts packages/`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: refactor
- Execution: subagent sonnet
- Planned at: `3ab2c65`, 2026-07-23

## Requirement

Mobile (plan 032) and desktop web need one shared protocol client: connection management (`apps/web/src/client/connection.ts`, 117 lines) and control-plane store (`apps/web/src/client/store.ts`, 438 lines, zustand **vanilla**, independent of React). Extract both into workspace package `packages/client` (`@coflux/client`) and update desktop web imports.

**Desktop web behavior must not change.** This is file relocation plus injection of environment dependencies, with no new functionality or protocol changes. Leaving `import.meta.env` or app-specific constants in the package merely relocates coupling. The package should depend only on injected options and `@coflux/protocol`, so another browser app can supply its own configuration.

## Decisions & tradeoffs

- **Package boundary**: move `connection.ts` and `store.ts` into `packages/client/src`; export `createCofluxClient` and all public types from the package root: `CofluxClient`, `CofluxState`, `FsListResult`, `ExecResult`, `FsWriteResult`, `ConnectionStatus`, `PortPreview`, `ClientError`, `AuthState`, and others. Rejected: extracting connection alone. Mobile chiefly needs the store’s snapshot/incremental reduction, pending request correlation, and PTY consumers. The factory is self-contained and UI-independent (`apps/web/src/client/store.ts:62-436`).
- **Inject environment dependencies**: app coupling is concentrated at `apps/web/src/client/store.ts:12-13`: `SERVER_URL`/`TOKEN_KEY`/`USE_SUPABASE`/`AuthCredential` from `@/config` and `loginWithSupabase` from `@/lib/auth` (23 lines of direct token-endpoint fetch, no SDK). `createCofluxClient(options)` receives `serverUrl`, `tokenStorageKey`, and an optional external login provider; provider presence replaces `USE_SUPABASE` and selects the two authError messages (`store.ts:159`). Move `AuthCredential` into the package. Keep `loginWithSupabase` in apps/web because it reads `VITE_SUPABASE_*`; inject it as the login provider. No `import.meta.env` in the package. Rejected: package-owned env reads, since Vite prefixes belong to the app.
- **Follow `@coflux/protocol` packaging**: private, `type: module`, with `main`/`types`/`exports` pointing directly to `./src/index.ts`, no build step. Depend on `@coflux/protocol` (workspace:*) and `zustand`. See `packages/protocol/package.json` and `pnpm-workspace.yaml` (`packages/*`).
- **Keep localStorage in the package**: token persistence (`store.ts:63,150,157`) is shared browser-client behavior; inject only the storage key. Rejected: a persistence interface when there are no non-browser consumers.
- **Change only imports and client assembly in web**: replace all `@/client/store`/`@/client/connection` imports with `@coflux/client`. Build options at the creation point near App.tsx from `@/config`/`@/lib/auth`; retain `apps/web/src/config.ts` and `lib/auth.ts`. Add the workspace dependency to web `package.json`. Both packages may depend on zustand, resolved to one version by the workspace lockfile.

## Direction

Create package → move files → inject dependencies → rewrite web imports. Do not refactor opportunistically or rewrite comments/store internals. The diff should show file movement, small injection changes, and import updates, not a logical rewrite.

### Milestone 1: packages/client into packages

The package exists with complete exports and no `import.meta.env` or `@/` coupling. Validation: `pnpm --filter @coflux/web build` exits 0 after web imports switch in M2; a two-step implementation is acceptable if the final state passes.

### Milestone 2: web switches to package references

Remove `apps/web/src/client/`; import everything through `@coflux/client`. Validation: `pnpm --filter @coflux/web build` exits 0, and `grep -rn "client/store\|client/connection" apps/web/src` finds no residual references.

## Landmines

- `apps/web` owns the `@/` alias through Vite/tsconfig. It is invalid inside the package; resolve both imports at `store.ts:12-14` during migration.
- Inspect `connection.ts` for hidden `@/config` dependencies. Exploration confirmed `createConnection({url})`, but any remaining env reads must also be injected.
- Black-box `tests/` uses `@coflux/protocol`, not the web client. Leave it unaffected; do not add `@coflux/client` there.
- `packages/core` is server/daemon infrastructure reading `process.env` (`packages/core/src/index.ts:12-14`). Do not put the client there: browsers would fail on undefined `process`.

## Scope

In scope:

- `packages/client/**` (new)
- `apps/web/src/client/**` (delete/move out)
- `apps/web/src/**` (only import path and assembly code where client is created)
- `apps/web/package.json` (new workspace dependency)
- `pnpm-lock.yaml` (updated with install)

Out of scope:

- `apps/server`, `crates/`, `packages/protocol`, `packages/core` — protocol and server behavior remain unchanged
- Any visible behavior change on desktop web - red line
- `apps/mobile` — owned by plan 032

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| Residual reference check | `grep -rn "@/client" apps/web/src` | No output |
| Desktop regression smoke test (acceptance) | Playwright MCP, 1440×900: Login → Select workspace → Terminal appears → Change view | Consistent with baseline behavior |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` passed.
- [ ] There is no `import.meta.env`, no `@/` alias, and no supabase specific logic in `packages/client`.
- [ ] `apps/web/src/client/` no longer exists, and all web pages are imported via `@coflux/client`.
- [ ] Zero change in desktop web behavior (acceptance smoke test passes).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- App coupling was found in store/connection that cannot be resolved through options injection (meaning that the boundary judgment is wrong and needs to go back to planning).

## Maintenance notes

- `@coflux/client` is the shared protocol-consumption source of truth for apps/web and apps/mobile. Change snapshot reduction, control state, and pending-map semantics there only.
- Keep `createCofluxClient(options)` as the factory boundary: apps assemble configuration; the package stays environment-independent when new options are added.
