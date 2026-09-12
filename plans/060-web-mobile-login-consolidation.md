# Plan 060: Unify Web/mobile login—remove Supabase exchange and send account/password directly

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD -- apps/web apps/mobile packages/client`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: plans/059-server-password-auth.md
- Category: migration
- Execution: subagent sonnet
- Planned at: `c772ed4`, 2026-07-28

## Requirement

After 059, local/password servers accept clientAuth { username,password,clientVersion }, no supabaseToken exchange. Remove two-hop Supabase POST/access_token exchange and VITE_SUPABASE_* switches; use client.login(username,password).

No Supabase references remain in Web/mobile/shared client. One form accepts admin or email. Remove LoginProvider and supabaseToken credential state. Mobile is frozen, but this minimal compatibility repair is authorized: without it migrated production login breaks.

## Decisions & tradeoffs

- **Neutral Account/Password labels and type=text**, removing USE_SUPABASE copy/type forks. type=email blocks local admin; one label does not justify build switches. Sources auth-shell.tsx:12,71-75; auth-screen.tsx:42,49-53.
- **Remove LoginProvider and third credential state**. Keep token or username/password; login connects directly and authError copy no longer varies by provider. Generated proto unchanged per 059. User rejects OAuth, so no speculative IdP abstraction. store.ts:55-58,67-69,532-545; connection.ts:10-12,31-36.
- **Update standalone WS pages too**: AuthorizePage and ProxyAuthPage duplicated token/supabase/password branches become two branches. Do not expand scope by refactoring them into shared client. Sources :45,92-102 and :42,87-97.
- **Minimal matching mobile changes**: remove lib/auth.ts, config switch, App injection, auth-screen forks. It intentionally duplicated Web in 032; sources auth.ts:1-24, App.tsx:31.
- **Remove all VITE_SUPABASE declarations/uses**. No repository CI/script injects them; production used manual command-line injection. Sources Web vite-env:7-8/config:11-13 and mobile vite-env:6-7/config:10-12.

## Direction

### Milestone 1: Shared credentials

Two-state AuthCredential, no LoginProvider/options/branches, direct connect and simpler errors. Client build, or recursive tsc if no script, passes.

### Milestone 2: Web

Delete auth helper/config declarations; remove MainPage loginProvider, simplify standalone pages/form/workbench:319 copy. Web build passes without Supabase env.

### Milestone 3: Mobile

Apply only equivalent login compatibility changes. Mobile build passes.

## Landmines

- Standalone authorization/preview WS pages bypass packages/client; omitting them makes normal login work while these flows silently fail.
- Preserve clientVersion:BUILD_ID in standalone auth frames, required by 033 admission.
- Frozen mobile scope is limited strictly to listed login files.

## Scope

In scope: client store/connection; Web lib/auth deletion, config, vite-env, MainPage/AuthorizePage/ProxyAuthPage, auth-shell, workbench:319 copy; mobile lib/auth deletion, config/vite-env/App/auth-screen.

Out of scope: server/tests (059/062), iOS (061), proto/generated, production build/deploy documentation (063).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Client | `pnpm --filter @coflux/client build` | exit 0; if absent, rely on Web build |
| Web | `pnpm --filter @coflux/web build` | exit 0 |
| Mobile | `pnpm --filter @coflux/mobile build` | exit 0 |
| Acceptance | Local password-mode server/admin-created account, Web login | Success |

## Done criteria

- [ ] All listed commands pass.
- [ ] `rg -i supabase apps/web/src apps/mobile/src packages/client/src` returns no matches.
- [ ] Web builds successfully without any VITE_SUPABASE_* environment variables.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited facts change, excluded work required, or validation fails twice after one reasonable fix.

## Maintenance notes

- username is the shared account identifier, carrying email in password mode and local username otherwise.
- Production deployment documentation removes obsolete Supabase build variables in 063.

Historical integration acceptance uses a local `COFLUX_AUTH=password` server and a created account to complete the login flow.

UI walkthrough remains manual user acceptance (historical memory convention: no-frontend-verification); automated gates cover builds and black-box integration. From 063 onward, production Web builds omit VITE_SUPABASE_*; the historical build commands in plans/010 and 011 remain archived unchanged. STOP if the login contract frozen by 059 differs from implementation, such as a changed password-mode frame. If the client has no build script, use the tsc portion of `pnpm -r build`.

### Original source references

`apps/web/src/components/auth/auth-shell.tsx:12,71-75`, `apps/mobile/src/components/auth-screen.tsx:42,49-53`, `packages/client/src/store.ts:55-58,67-69,532-545`, `packages/client/src/connection.ts:10-12,31-36`, `apps/web/src/pages/AuthorizePage.tsx:45,92-102`, `apps/web/src/pages/ProxyAuthPage.tsx:42,87-97`, `apps/mobile/src/lib/auth.ts:1-24`, `apps/mobile/src/App.tsx:31`, `apps/web/src/vite-env.d.ts:7-8`, `apps/mobile/src/vite-env.d.ts:6-7`, `apps/web/src/config.ts:11-13`, `apps/mobile/src/config.ts:10-12`, `apps/web/src/pages/AuthorizePage.tsx:45`, `apps/web/src/pages/ProxyAuthPage.tsx:42`.
