# Plan 20260923-oauth-login-redesign: Sign in with GitHub or Google, on a login page worth looking at

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 6da899cc..HEAD -- apps/server/src apps/desktop/src packages/client/src packages/cli crates/cli/src scripts/create-user.mjs .github/workflows/ci.yml docs/deployment.md`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH — authentication boundary, a one-way schema migration, and a new account-creation path
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check, 2026-09-23
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — cut from the main worktree at `.claude/worktrees/20260923-oauth-login-redesign`, branch `dev/20260923-oauth-login-redesign`
- Planned at: `6da899cc`, 2026-09-23

## Requirement

Today every Coflux sign-in is a bare "账号 / 密码" form: the desktop login screen is an astryx `Card` with two inputs (`apps/desktop/src/renderer/components/auth/auth-shell.tsx:23-97`, used at `apps/desktop/src/renderer/components/workbench/workbench.tsx:717-731`), the server-rendered device authorization and port-preview gate pages are plain HTML forms (`apps/server/src/auth-pages.ts:245-300`), and `coflux login` only takes `--username --password-stdin` (`crates/cli/src/account.rs:228-243`, `packages/cli/account-client.mjs:109`). Accounts exist only if an administrator ran `scripts/create-user.mjs`. The owner finds the page ugly and wants GitHub and Google sign-in.

When this is done:

**Surfaces.** Four entry points share one visual language and gain GitHub + Google: the desktop login screen, `/authorize/<token>` (device enrollment from `cofluxd up`), `/proxy-auth` (port-preview gate), and `coflux login` in both CLIs. Desktop pages that already reuse `AuthShell` (for example the "需要更新" page, `workbench.tsx:160-184`) take on the same look.

**Layout (all login pages).** Centered, no card:

```
              ◆ Coflux
        登录以连接你的工作区

   [   使用 GitHub 继续   ]
   [ G 使用 Google 继续   ]
   ──────────  或  ──────────
   邮箱  [                ]
   密码  [                ]
   [      用邮箱登录      ]

     api.coflux.dev · v2.4.0
```

Provider buttons are primary; the email/password form is secondary, below an "或" divider. The footer shows the server host and version. When the server has no OAuth provider enabled (for example `COFLUX_AUTH=local`, or no provider credentials configured), only the password form is shown — no dead buttons.

**Registration: email allowlist.** A provider sign-in whose **provider-verified** email equals an existing user's email signs into that existing user, and so into the same account, workspaces and terminals. A provider sign-in with an unknown email creates a user and its personal account only when the email matches the allowlist (an exact address, or `@domain`); otherwise it is refused with "该邮箱未开通 Coflux". Password sign-up does not exist; passwords only sign in existing users.

**Desktop flow.** Clicking a provider opens the **system browser** (embedded webviews are refused by Google). The app switches to a waiting state — "在浏览器中完成登录…" with 「重新打开浏览器」 and 「取消」. In the browser: provider consent → a **confirmation card** ("在 <host> 上的 Coflux 桌面端请求登录", button 「允许登录」) → "已登录，可以回到 Coflux". The app then enters the workbench on its own and brings itself to the front. Failures return to the login page with a banner: "该邮箱未开通 Coflux", "已取消登录", or a timeout/network message with retry.

**Server pages.** On `/authorize` and `/proxy-auth` the provider buttons run OAuth in the same tab and return to the flow that started it (the device confirmation card, or the preview pass). Page sessions stay short-lived and per-flow exactly as today — a provider sign-in never leaves a lasting browser session behind.

**CLI.** `coflux login` with no credentials flags prints a URL, tries to open the browser, waits, and prints "已登录为 <email>"; Ctrl-C cancels. The same confirmation card appears in the browser. When the CLI runs somewhere the browser cannot reach back to (SSH), the page shows a one-time code that the user pastes into the terminal. `--username … --password-stdin` keeps working unchanged.

**Out of product scope:** password reset, password sign-up, linking/unlinking providers in settings, avatars or display names, providers other than GitHub and Google, the frozen web client, iOS, and deploying to production.

**What the owner can observe when done:** the new login page; signing in with their own GitHub or Google lands on their existing account with its data; a non-allowlisted email is refused with a clear message; `cofluxd up` authorization and a gated preview both complete through OAuth; `coflux login` completes through the browser; email/password still works everywhere it did.

## Decisions & tradeoffs

- **Identity provider: self-hosted Better Auth embedded in `apps/server`, mounted under `${COFLUX_PUBLIC_URL}/api/auth/*`.** Rejected: Neon Managed Better Auth (the user's first suggestion; the dormant Neon project "CoFlux", `snowy-tree-05037095`, Singapore) — it keeps users in the Neon database's `neon_auth` schema, a second identity store beside production Postgres on prod-jp; OAuth callbacks and the Google consent screen would show `*.neon.tech`; its session cookie lives on the Neon origin, so the server-rendered pages on `api.coflux.dev` would need cross-site cookie workarounds; and reachability of `neon.tech` from mainland China is unverified. The user chose self-hosting at the departure check. Based on: `apps/server/src/config.ts:15-25` (password mode is coflux's own `users` table), `docs/deployment.md` (self-hosted PG17 on prod-jp).

- **Better Auth does the OAuth round trip and account linking, nothing else.** Coflux keeps minting its own credentials: `ck_sess` client tokens through the existing path (`apps/server/src/hub.ts:3513-3521` `loginClient` → `store.upsertClientToken`) and `cf_page` page sessions (`apps/server/src/auth-pages.ts:60`, `PageSessionStore`). Better Auth's own browser session is deleted as soon as coflux has read the identity from it — no Better Auth cookie authorises anything in coflux, and no Better Auth session outlives its handoff. Better Auth's `emailAndPassword` stays **disabled**; password sign-in keeps using `checkCredentials` (`hub.ts:3489-3510`, scrypt in `apps/server/src/auth.ts`). Rejected: letting Better Auth sessions become coflux sessions — it would fork session revocation (`revokeClientSession`, `hub.ts:3523`) and the WS `clientToken` auth path (`hub.ts:3386-3389`) into two systems.

- **One identity store: a Better Auth user's id *is* the coflux `users.id`.** When Better Auth is about to create a user (`databaseHooks.user.create.before`), coflux decides the id: an existing coflux user with that email → reuse its id (no new `users` row); otherwise, if the email matches the allowlist → create the coflux `users` row and use its id; otherwise refuse the sign-in. The personal account keeps being provisioned lazily by `resolveAccountForUser` (`hub.ts:3549-3565`) — do not add a second account-creation path. `users.password_hash` becomes nullable (OAuth-only users have none) — a **one-way** migration; `checkCredentials` must treat a null hash as "no password" (never as a match). Better Auth's tables (user, account, session, verification — whatever the pinned version needs) are **separate tables**, never mapped onto coflux `users` (incompatible columns: `created_at DOUBLE PRECISION`, `password_hash`), and are created by coflux's own migration ledger (`apps/server/src/infra/database/schema-migrations.ts`, runner at `:1688`), never by Better Auth's runtime `migrate`/`getMigrations`. Rejected: Better Auth's own id + a mapping table — two ids for one person is exactly the drift this avoids.

- **Account linking only on a provider-verified email.** Keep Better Auth account linking on, but GitHub and Google must **not** be listed in `accountLinking.trustedProviders` (that list links even unverified emails, which would let anyone who registers a GitHub account with the owner's address take over the owner's account). A sign-in whose provider email is unverified or missing is refused. Based on: Better Auth docs (v1.6), "trustedProviders … link accounts … even if email verification is not confirmed"; GitHub returns private emails only via `/user/emails` with a `verified` flag.

- **Allowlist lives in server config, `COFLUX_SIGNUP_ALLOWLIST`**, comma-separated exact addresses and `@domain` entries, compared case-insensitively on the normalised (trimmed, lower-cased) email — the same normalisation `create-user.mjs` and `checkCredentials` use. Empty or unset means nobody new can sign up (existing users still sign in). Existing users never need to be on it. Rejected: a database table with an admin UI — not in scope; a config list matches how every other admission knob is configured.

- **OAuth exists only when `COFLUX_AUTH=password` and a provider's client id + secret are configured**; each provider is independent (GitHub alone is valid). The server tells clients which providers are enabled — through an unauthenticated read under `/api/client/*` or an equivalent the executor chooses — and every login surface renders buttons only for those. `COFLUX_AUTH=local` shows no provider buttons anywhere. New secrets (provider client secrets, Better Auth's signing secret) are required in production through the existing `secret()` fail-closed mechanism (`config.ts:29-34`) **only when that provider is enabled**, and get a dev default otherwise.

- **Desktop and CLI receive their token by RFC 8252 loopback redirect with PKCE (S256), plus a paste-code fallback for the CLI.** The native client opens an ephemeral listener on `127.0.0.1`, registers a login request with the server (loopback port + `code_challenge`), and opens the system browser on a server page for that request. After provider sign-in and the confirmation card, the server redirects the browser to `http://127.0.0.1:<port>/…` with a one-time code; the client exchanges code + `code_verifier` for a `ck_sess` token. The CLI, when it cannot listen or the browser is elsewhere, uses the same request but the page shows a one-time code for the user to paste; that code is still bound to the request's `code_verifier`. Login requests are in memory with the `authorizeTtlMs` TTL, a global cap, and one-time consumption — the same shape as `pendingAuthorizations` (`hub.ts:2081-2110`). Rejected: a custom URL scheme (`coflux://`) — it binds to one installed app, breaks side-by-side dev previews (the desktop-preview skill runs one instance per worktree), and needs OS registration; rejected: device-code polling without loopback — anyone who starts a request and mails the link to a victim receives the victim's session (link phishing). With loopback, a phished victim's browser is redirected to the victim's own machine.

- **The confirmation card is mandatory for native logins.** Between provider sign-in and the loopback redirect, the page shows who is asking (client kind and host name reported at request registration) and requires an explicit 「允许登录」 (a same-origin POST with csrf, like `renderAuthorizeConfirm`, `auth-pages.ts:283`). The user chose this at the departure check.

- **Server pages reuse their flow's page session.** A provider button on `/authorize` or `/proxy-auth` starts OAuth with a callback that returns under that flow's own path (`FLOW_COOKIE_PATH`, `auth-pages.ts:55-58`); on return, coflux reads the Better Auth identity, resolves the account, deletes the Better Auth session, and issues the same `cf_page` session a password login would. The post-login behaviour of each flow (device card, preview code) is unchanged.

- **The desktop signs in from the main process.** Opening the browser, owning the loopback listener, the PKCE verifier, and the code exchange all live in the Electron main process; the renderer reaches them through new `window.cofluxDesktop` bridge verbs (`apps/desktop/src/shared/desktop-bridge.ts`) and receives only the outcome. The resulting token is stored through the existing `setSessionToken` (`desktop-bridge.ts:126-131`, safeStorage) and the renderer connects with `{ token }` through the existing client path (`packages/client/src/store.ts:1158`). No WS protocol change: the token path already exists. Rejected: running the flow in the renderer — the renderer has no listener capability and must not hold the verifier.

- **Better Auth is mounted ahead of Raven routing, never as a Raven/Hono route** (revised on plan audit). Raven parses JSON bodies for every matched route before the handler runs (`@raven.js/core@3.0.0` `dist/index.mjs:434-438`), so `auth.handler` behind `app.post("/api/auth/*")` receives a consumed Request. Mount it with `app.onRequest` (runs before `hono.fetch` and may short-circuit, `dist/index.mjs:571-577`) or by pathname split in `apps/server/src/index.ts:39-49`; the executor picks.

- **Server pages drive Better Auth from coflux's own same-origin handlers** (revised on plan audit). Better Auth's `sign-in/social` takes JSON and answers `{ url, redirect }`; the pages have no JavaScript and a `default-src 'none'` CSP. So a provider button is a coflux form POST (csrf-checked) whose handler calls `auth.api.signInSocial({ body: { provider, callbackURL, errorCallbackURL }, headers, returnHeaders: true })`, forwards Better Auth's `Set-Cookie` (OAuth state) and 302s to the returned URL. The return lands on a **new GET route under the flow's path** (for example `/authorize/:token/oauth`), because the existing `GET /authorize/:token` renders the login form whenever there is no `cf_page` (`auth-pages.ts:361-363`). That route reads the identity with `auth.api.getSession`, signs out with `auth.api.signOut(..., returnHeaders: true)` forwarding the clearing cookie, then issues `cf_page`. Error returns carry `?error=<code>`; pages map known codes to fixed copy and never echo `error_description` (anyone can craft that URL). The native login page (`/login/<request>`) is a third `PageFlow` with its own cookie path (`PageFlow` is a literal union, `auth-pages.ts:31`).

- **Better Auth storage details** (revised on plan audit). Better Auth does not accept the `postgres` (porsager) client coflux uses (`store.ts:257-263`); it gets its own `pg` pool with `search_path` set to coflux's schema. Its models are renamed with an `auth_` prefix via `modelName` (`auth_user`, `auth_session`, `auth_account`, `auth_verification`) so none reads like coflux `accounts`/`users` and none needs the reserved word `user`. Column sets come from Better Auth's own generator for the pinned version, pasted into a new coflux migration — never hand-written. The coflux `users` insert in the create hook uses `INSERT … ON CONFLICT (email) DO NOTHING` plus a re-read, so a crash between the two pools' writes self-heals on the next sign-in. The hook normalises the email (trim + lower-case) and returns it in `data.email`, and decides verification from Better Auth's `user.emailVerified` only.

- **Visual system.** Desktop pages use astryx components and tokens per `docs/design-guidelines.md` (Tooltip rule included). The server pages stay dependency-free HTML + inline CSS with no JavaScript (`auth-pages.ts:1-4`) but must look like the same product — same structure, typography scale and colour tokens, light and dark. Exact visuals are the executor's call; the brand mark is a placeholder glyph unless an existing asset is found.

## Direction

Server first, then clients. Boundaries:

```
browser ──► /api/auth/* (Better Auth: OAuth dance, linking, allowlist hook)
        ──► /login/<request> (native login page: buttons → confirm card → loopback | paste code)
        ──► /authorize/<token>, /proxy-auth (existing flows; + provider buttons)
desktop main / CLI ──► /api/client/... (register request, exchange code+verifier → ck_sess)
                    ──► existing WS / HTTP with { token }
```

### Milestone 1: Server identity layer

Better Auth is mounted, its tables exist through a new coflux migration, `users.password_hash` is nullable, the create-user hook enforces "existing email → reuse id; allowlisted → create; else refuse", only verified emails link, provider enablement and allowlist come from config, and the enabled-provider list is readable by clients. `checkCredentials` rejects users without a password hash. `scripts/create-user.mjs` still works. The allowlist matcher and the verified-email rule get unit tests (a mismatch here is a silent takeover or a silent lockout — invisible while using the product). Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0; the new server unit test(s) → exit 0.

### Milestone 2: Native login requests

The server can register a login request (client kind, host, loopback port or "paste", PKCE challenge), serve its page (provider buttons + password form, then the confirmation card), redirect to loopback or show a paste code, and exchange code + verifier for a `ck_sess` exactly once. Wrong verifier, reused code, expired request and cap overflow all fail closed. Needs milestone 1. Validation: server typecheck → exit 0; unit tests for the request store's one-time/TTL/verifier behaviour → exit 0.

### Milestone 3: Server pages redesigned, with provider sign-in

`/authorize`, `/proxy-auth` and the milestone-2 login page share the new layout; `/authorize` and `/proxy-auth` gain provider buttons that return into their own flow and yield a normal `cf_page` session. Needs milestone 1; shares `auth-pages.ts` with milestone 2, so it runs after it. Validation: server typecheck → exit 0.

### Milestone 4: Desktop login

New `AuthShell` design; provider buttons appear only for enabled providers; the waiting state with reopen/cancel; errors mapped to the three banners; main-process loopback + PKCE + exchange behind bridge verbs; on success the token is stored, the renderer connects, and the window comes to the front. Needs milestone 2. Independent of milestone 5. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

### Milestone 5: CLI login through the browser

Both `crates/cli` and `packages/cli` gain the no-flag `coflux login` browser flow with loopback and the paste fallback; `--password-stdin` is unchanged; the token lands where password login already stores it. Needs milestone 2. Independent of milestone 4. Validation: `cargo build -p coflux-cli` with zero warnings and `cargo test -p coflux-cli` → exit 0; `node --check packages/cli/account-client.mjs` → exit 0.

### Milestone 6: Operator docs

`docs/deployment.md` (or the file that owns server env documentation) lists the new variables, the provider callback URLs to register (`${COFLUX_PUBLIC_URL}/api/auth/callback/github|google`), that migration N is one-way, and that Google's consent screen must be published before non-test users can sign in. Independent; can run any time after milestone 1 fixes the variable names.

## Landmines

- **Server unit tests are listed by name in CI** (`.github/workflows/ci.yml:177`). A new `apps/server/src/*.test.ts` that is not added there never runs in CI.
- **Origin handling.** The desktop main process rewrites the WebSocket handshake Origin to `https://desktop.coflux.dev` (`apps/desktop/src/main/index.ts:117-125`) and server validation stays strict. New `/api/client/*` endpoints called from the main process or CLI must not relax CORS or origin checks; browser pages keep `crossSiteRequest` depth checks (`auth-pages.ts:154-160`) and csrf (`verifyCsrf`, `auth-pages.ts:125`).
- **Cookie Path isolation.** `cf_page` cookies are scoped per flow path (`auth-pages.ts:55-58`). Better Auth's callback lands on `/api/auth/callback/<provider>`, outside those paths; its final redirect (`callbackURL`) must come back **under the originating flow's path**, and must be validated against the public origin (Better Auth `trustedOrigins`) so it cannot become an open redirect.
- **Loopback redirect target.** Only `http://127.0.0.1:<port>` (optionally `[::1]`) with the port recorded at registration may be redirected to. Never accept a redirect URL from the browser request.
- **Concurrent first sign-in.** `resolveAccountForUser` serialises on `claimUser` (`hub.ts:3551-3560`); the create-user hook runs before that and must not race two `users` rows for one email — the `email UNIQUE` constraint (`schema-migrations.ts:176-181`) must be treated as "reuse", not surfaced as an error.
- **`User.passwordHash` is typed non-null** (`apps/server/src/store.ts:122-125`) and `upsertUser` writes it (`store.ts:419-423`); making the column nullable must ripple through the type, not be hidden with a cast.
- **Rate limiting.** Page and WS logins share `loginLimiter` (`hub.ts:3535`); native login registration and code exchange need a limit too.
- **`verifyPassword(password, null)` throws** (`apps/server/src/auth.ts:24`, `stored.split` outside the try): `checkCredentials` must short-circuit a null hash before calling it, or an OAuth-only user typing a password gets a 500 instead of "认证失败".
- **The hook-supplied user id must actually stick.** Better Auth's own tests cover `user.create.before` returning `{ data: { ...user, id } }` together with `advanced.database.generateId: "uuid"`; confirm on real Postgres that `auth_user.id` equals the coflux id the hook returned, and fall back to a `generateId` function if not. This is the first thing to verify after installing — if neither works, STOP.
- **Linking a second provider bypasses the create hook** (Better Auth `link-account` path, gated on the stored user's `emailVerified` and the provider's). It stays safe only because the hook refuses unverified emails, so every stored `auth_user` is verified — do not relax that.
- **Self-reported host on the confirmation card.** The host shown is whatever the requesting client registered; the card copy must say it is reported by the requester.
- **Abandoned OAuth attempts** leave `auth_verification` rows; give them a cleanup (Better Auth expiry or a periodic delete).
- **Fresh worktree has no `node_modules`**: run `pnpm install` first; the lockfile change from adding `better-auth` and `pg` is in scope.
- **Google in production** only admits listed test users until its OAuth consent screen is published; GitHub needs its own OAuth app. Both are owner operations — do not treat an OAuth failure caused by missing credentials as a code defect.

## Scope

In scope:
- `apps/server/src/` — Better Auth mount, config, migration, hub/store identity changes, native login requests, `auth-pages.ts` redesign, new contracts/handlers under `interface/`
- `apps/server/package.json`, root `pnpm-lock.yaml` — Better Auth and its Postgres driver
- `apps/desktop/src/` — `components/auth/`, the login branch of `workbench.tsx`, main-process login, `shared/desktop-bridge.ts`, preload
- `packages/client/src/` — only if the store needs a hook for "connect with a freshly issued token" or the provider list
- `crates/cli/src/`, `packages/cli/account-client.mjs`
- `scripts/create-user.mjs` — only as needed for the nullable column
- `.github/workflows/ci.yml` — only to list new server unit tests
- `docs/deployment.md` (or the doc that owns server env)

Out of scope:
- `crates/protocol`, `packages/protocol` — no wire change is needed; a change there means the design went wrong (STOP)
- The frozen web client, iOS, `apps/macos`
- Password reset, password sign-up, provider link/unlink UI, avatars
- Production deployment, creating OAuth apps, editing `server.env`

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Server unit tests | `node --import tsx --test apps/server/src/*.test.ts` | exit 0 |
| Desktop gates | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Rust CLI | `cargo build -p coflux-cli 2>&1 \| grep -c '^warning'`, then `cargo test -p coflux-cli` | prints `0` (grep exits 1 on zero matches — read the number, not the exit code); test exit 0 |
| TS CLI syntax | `node --check packages/cli/account-client.mjs` | exit 0 |
| Local stack walk-through (acceptance) | `pnpm dev:pg`, `COFLUX_AUTH=password pnpm dev:server` with dev GitHub/Google OAuth credentials, `pnpm -C apps/desktop dev`, `coflux login` | the observable outcomes in Requirement |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Better Auth tables and the nullable `password_hash` arrive through a new coflux migration; nothing calls Better Auth's runtime migration.
- [ ] A provider sign-in with an existing user's verified email lands on that user's existing account; an unverified or missing email is refused; an unknown non-allowlisted email is refused with "该邮箱未开通 Coflux"; an allowlisted one gets a new user and personal account.
- [ ] GitHub/Google are not in `trustedProviders`; Better Auth `emailAndPassword` is disabled; no Better Auth session survives a handoff — asserted by a test that counts `auth_session` rows for the user after a handoff (0).
- [ ] Native login: PKCE S256, loopback redirect only to the registered `127.0.0.1` port, one-time code, TTL and cap, mandatory confirmation card; CLI paste-code fallback works. Unit tests cover: a redirect target supplied by the browser request is ignored; wrong verifier, reused code and expired request all fail.
- [ ] A user with a null password hash never passes password login — tested with an empty and an arbitrary password.
- [ ] A test on real Postgres shows `auth_user.id` equals the coflux `users.id` chosen by the create hook, for both an existing and an allowlisted new email.
- [ ] `/authorize` and `/proxy-auth` complete through a provider and through a password, returning into their own flow.
- [ ] Desktop and both server pages use the new centered layout; with no provider enabled, only the password form renders.
- [ ] Password login unchanged on desktop, both pages, and both CLIs; `COFLUX_AUTH=local` unaffected.
- [ ] New server unit tests are listed in `ci.yml`.
- [ ] No change in `crates/protocol` or `packages/protocol`.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- Better Auth cannot let coflux choose the user id at creation, or cannot refuse a sign-in from the create hook — the single-identity decision depends on both.
- The outcome appears to need a WS protocol change.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Migration adding the Better Auth tables and dropping `NOT NULL` on `users.password_hash` is one-way; release notes must say so.
- Pin the Better Auth version; its table shape is part of coflux's migration ledger, so upgrades that change it need a new coflux migration.
- The allowlist is config: adding someone means editing `server.env` and restarting.
- Plan audit (2026-09-23) was accepted in full; small line-number drifts it found (`FLOW_COOKIE_PATH` is at `auth-pages.ts:54-57`, `loginLimiter` is defined at `hub.ts:499`) do not change any decision. Already-existing gap noted but not fixed here: `executor-secrets.test.ts` is not listed in `ci.yml`.
