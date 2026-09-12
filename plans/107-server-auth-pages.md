# Plan 107: Serve three browser authorization pages from server and retire COFLUX_WEB_URL

> This plan is an outcome contract, not a step-by-step script. Understand requirements/decisions and implement against live code. Validate only if also the verifier; delegated executors implement with checks outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat c1e82cc..HEAD -- apps/server/src scripts/desktop-dev-fixture.mjs tests/src/authorize.test.mjs tests/src/mcp-oauth.test.mjs tests/src/proxy.test.mjs tests/src/oauth-harness.mjs tests/src/harness.mjs docs/auth-design.md docs/deployment.md docs/architecture.md README.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: 106, branch dev/20260911-desktop-only-merge; based on tip c1e82cc before 106 merges to main
- Category: feature
- Execution: subagent, host general-purpose model fable; 2026-09-11 preflight authorizes automatic progress
- Planned at: `c1e82cc`, 2026-09-11

## Requirement

After 106 removes web source, three system-browser flows depend solely on the frozen bundle: device enrollment /authorize/<token>, MCP /oauth/consent?request=, and /proxy-auth?to=. Server still generates COFLUX_WEB_URL links/redirects to app.coflux.dev, where auxiliary WS connections and localStorage sessions handle these critical paths. This plan makes server render them directly under COFLUX_PUBLIC_URL and retires WEB_URL. Frozen web remains only a historical workbench; server generates no links to it.

### Confirmed product conclusions

- **Same flows**: device CLI link→browser login→device name/host/platform→authorize→completion; MCP host /oauth/authorize→consent redirect→login→app/callback-host/scope→allow/deny→host callback; desktop preview→browser login→one-time code→preview callback/cookie on preview domain.
- **Server HTML**, production api.coflux.dev with unchanged paths/query names, inline CSS and POST forms, fully usable without JS. Preserve old visual structure: dark centered roughly 400px card, coflux title, secure-remote-workspace footer. Not part of desktop or frozen web.
- **Login every flow, lasting only minutes**, per 2026-09-11 user choice. Short HttpOnly cookie serves current confirmation only; no long login/logout/remember-me.
- **States/copy follow old pages** at ce7026b web pages and auth-shell: device/app/preview-specific login headings/subtitles; account/password fields; Login and Continue/Login and Access; invalid-credentials banner. Device invalid/expired→Authorization Link Unavailable; valid→device card and Authorize This Device; success→Device Authorized, registered to your account, page may close; disconnect/cap/redeemed failure→Authorization Incomplete plus reason. Consent invalid/expired→Authorization Request Unavailable; valid→app requests Coflux access, app/return-host/scope card, Allow/Deny; both redirect to computed callback. Missing request tells user to restart from host. Missing/malformed preview target tells user to reopen from terminal port entry; valid login redirects; missing/foreign preview shows Cannot Open Preview plus reason.
- **Acceptance**: printed api link, MCP onboarding, preview flow all work; no WEB_URL/app.coflux.dev in server code/config; HTTP black-box coverage.
- **Non-goals**: authorized-app listing/revocation, logout, persistent login, coflux deep links, redesign, localization, or deleting equivalent WS messages.

Reuse the exact WS business rules for credential validation, authorization one-time/TTL, OAuth decisions, and preview codes. Add only short-lived page session and CSRF semantics. Do not copy credential logic, write 30-day client_tokens on page login, validate token/request before login, rely only on SameSite, access socket in handlers, add frontend/template frameworks, or remove existing WS operations.

## Decisions & tradeoffs

- **Raven contract routes with logic-free handlers** in a new interface directory: defineContract/withSchema, registerContractRoute in app.ts. Handler reads RavenContext request/params/query and HubState, returning Response; service modules own rules/HTML. Rejected: handwritten routes in index's HTTP server bypass unified envelopes/route inventory; index only dispatches transport. Evidence: app.ts, OAuth contract schemas:{}, handler no-judgment pattern, health handler. Raven exposes Fetch request/params/query/url, colon parameters, **no peer address** (core index.mjs:120-140; oauth:135-136/config:131).
- **Fixed entry shapes under config.publicUrl**: GET /authorize/:token, /oauth/consent?request=, /proxy-auth?to=. Executor names POST routes. Delete webUrl/COFLUX_WEB_URL including desktop-dev-fixture:47. publicUrl already validates independently of request headers. Evidence: hub:2005, oauth:152-154, proxy:630-635, config:82-98,115-120, harness:607.
- **Short in-memory page sessions** after shared credential validation: random token, authorizeTtlMs (default ten minutes), bounded entries rejecting capacity, accountId and password-mode userId. Match existing single-instance pending authorization/ProxyGate tradeoff. Cookie HttpOnly/SameSite=Lax/Max-Age TTL; Secure only for HTTPS publicUrl. No client_tokens or ck_sess. Rejected: 30-day WS sessions contradict per-flow login; Postgres persistence adds no benefit. Executor chooses cookie name/path. Evidence: WS auth hub:3217-3290, config:149, proxy cookie:278-292.
- **Post/Redirect/Get**: unauthenticated GET login; successful login POST 303 to same GET; authenticated device GET confirms, consent GET shows app, preview GET issues code and 302 via buildAuthCallbackUrl. Device/allow/deny are POST; device finishes page, consent redirects. **Check token/request validity only after login**, avoiding an oracle. Preview target shape parse is allowed before login, ownership after. Rejected: combined credentials/decision form couples confirmation to unauthenticated submission. Evidence: old authOk→info flow; proxy:307-321.
- **CSRF on every login/confirmation/decision POST**, bound to page session; anonymous prelogin session or equivalent chosen by executor. Reject mismatches. Origin/Sec-Fetch-Site add defense: reject present cross-origin/non-none, permit absent headers for Node fetch. SameSite alone is insufficient for device binding/OAuth grant side effects.
- **Source-address login rate limit**, reusing loginLimiter through a ClientConn-independent entry. index.ts computes requestAddress(req) before Fetch adapter and **overwrites** an internal header, discarding any inbound value. Handler reads only trusted injected value. Token/request guessing failures count per page session using authorizeMaxFailures, matching WS connection accumulation. Rejected: global fixed window or trusting raw forwarded headers. requestAddress trusts forwarding only from loopback, requiring socket access available in index. Evidence: transport:39-48, hub limiter:378-390,430-431, index:36-45, config:150-155.
- **Extract shared business core, never duplicate it.** Local/password credentials, scrypt concurrency/account resolution, pending-auth checks/device completion, preview issuance, OAuth describe/decide become WS-independent Hub/service methods. Existing deviceAuthorizeInfo/deviceAuthorize/oauthAuthorizeInfo/oauthAuthorizeDecide/proxyIssueAuth remain behaviorally identical for frozen web and unchanged black-box tests. Evidence: hub:3217-3290,3456-3510,2486-2496,2690-2721; oauth:339-370.
- **HTML template strings with explicit escaping**, inline CSS, no JS/templates/frameworks. Escape every device/app/host/platform/scope/error/token/request interpolation. Set text/html;charset=utf-8 and Cache-Control:no-store. Server currently has no HTML output/template dependency; do not import React/Astryx.
- **Extend existing HTTP black-box files, no new ports**: authorize login→confirm→online daemon/task, invalid token, prelogin nonoracle, CSRF, login rate limit; OAuth redirect to public consent, allow code/deny access_denied callbacks, repeat-decision rejection; preview public gate→login→callback→cookie. Harness adds cookie jar/form POST, redirect:manual. Add in-process tests for escaping, cookie parsing/rendering, CSRF, TTL/cap, following existing proxy-gate direct-server-import style. Evidence: authorize:35-115,245, OAuth harness:78-95, OAuth tests:119-135, proxy:204-234, harness:509-560.
- **Update current docs**: auth-design browser/redirect sections, deployment frozen-workbench-only and optional postdeploy WEB_URL removal by user, architecture preview authorization actor, README if relevant. No chronology.
- **Unchanged**: desktop/Rust/proto/protocol/client/CLI, frozen web, Caddy already proxying all api traffic to 8787, and ProxyGate code/cookie semantics.

## Direction

One package, two sequential milestones, M2 depends on M1 pages. Historical commit convention here was Chinese with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

### Milestone 1: Direct pages and publicUrl links

Expose shared Hub/OAuth methods, trusted peer-address header, page sessions/CSRF, contracts/handlers/services/HTML. Switch three URL construction sites, remove webUrl/env/fixture, add pure tests.
Validation: server types and new in-process tests pass; no WEB_URL/webUrl outside plans.

### Milestone 2: HTTP flows and docs

Add HTTP cases to three files while preserving WS cases, cookie/form harness, documentation.
Validation: server types pass; no old app-domain authorization links outside plans. Verifier runs targeted/full black-box acceptance.

## Landmines

- Raven has no socket. Compute peer address in index before getRequestListener, whose adapter forwards req.headers. Verify custom-header propagation; if absent find another reliable IncomingMessage→handler path, never trust inbound header.
- Distinguish preview cf_proxy_session (parent-domain .coflux.dev, seven days) from short origin-bound page cookie. Preserve preview tests for name/single Max-Age.
- Tests use HTTP loopback publicUrl, so Secure would break cookie flow; only HTTPS gets Secure. Missing Origin must be permitted.
- Existing tokenFromUrl and OAuth/proxy Location assertions rely on unchanged shapes, requiring no edits.
- Device completion must retain registerDaemonConn, daemonEnrolled, device-cap daemonAuthError/disconnect side effects. Only browser response changes from sendClient to return value.
- OAuth decide needs userId, previously looked up from client_tokens. Store it at page login, password getUserByEmail or local null; no token lookup later.
- authorizeMaxFailures changes from per connection to per page session, not per IP, avoiding shared-egress collateral denial.
- Failed login must not reveal pending token validity.
- Reuse test-file ports; new files must choose unused PORT if needed.
- Guard can false-block heredoc/commit Git-worktree mutation wording; use editing tools. zsh dependent steps use &&.

## Scope

In scope:
- Server app/config/hub/oauth/proxy/transport/index, new interface/service modules
- desktop-dev-fixture env cleanup
- Three flow tests, OAuth/general harness, new in-process tests
- auth-design/deployment/architecture/README
- This plan deviations only; orchestrator updates index

Out of scope:
- Desktop/packages/Rust/proto/integrations/iOS
- Deleting/reshaping existing WS operations
- ProxyGate code/cookie semantics or preview Caddy
- Long login/logout/app listing/deep links/redesign
- Production env cleanup/deployment, user actions

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| In-process tests | `node --import tsx --test tests/src/<new-test-file>.mjs tests/src/proxy-gate.test.mjs` | exit 0 |
| Residual references | `git grep -n "COFLUX_WEB_URL\|webUrl\|app.coflux.dev/authorize\|app.coflux.dev/oauth\|app.coflux.dev/proxy-auth" -- ':!plans'` | Empty |
| Plugin consistency | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Three-flow acceptance | `node --import tsx --test tests/src/authorize.test.mjs tests/src/mcp-oauth.test.mjs tests/src/proxy.test.mjs` | exit 0 |
| Full acceptance | `pnpm -C tests test` | Green except known local false failures/flakes |
| Manual acceptance | pnpm dev:server and cofluxd up --server ws://localhost:8787/daemon; browser opens printed URL | Product conclusions hold |

## Done criteria

- [ ] Nonacceptance commands pass; verifier runs acceptance.
- [ ] All generated authorization/consent/preview URLs use publicUrl; no webUrl/env remains.
- [ ] JS-free login/error/confirmation/decision/completion/redirect flows with specified states/copy.
- [ ] Login issues only short HttpOnly page cookie, no client_tokens row; expiry requires login again.
- [ ] CSRF mismatch rejected, prelogin nonoracle, source login limit, per-session guess count.
- [ ] Existing WS behavior and unchanged black-box cases pass.
- [ ] Every HTML interpolation escaped, including a tested script-containing device name.
- [ ] Required unit and black-box tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The orchestrator updates the plan 107 row in `plans/README.md`.

## STOP conditions

- Cited facts change, especially Raven context, shared-method side effects/signatures, requestAddress trust.
- Requires proto/protocol/client/desktop changes.
- Adapter cannot propagate trusted source metadata through any reliable method.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- Pages are server functionality sharing core with WS; business-semantic changes affect both through one implementation.
- Page sessions/CSRF are single-instance memory like pending authorizations/ProxyGate (OPEN_QUESTIONS B7); multi-instance deployment must move them together to shared storage.
- Old frozen pages remain manually accessible through WS, but server never links them; retiring app domain needs no further server change.
- After deployment, production WEB_URL is dead and removable. BUILD_ID_FILE still serves frozen workbench admission.
