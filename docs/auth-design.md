# coflux authentication and device enrollment (Tailscale style)

The current model is: sign into an account, authorize a new device in the browser, and use independent credentials for each device. Early shared client tokens, EnrollmentKey, and Supabase token exchange have been retired. Their decisions remain in historical plans, outside the runtime contract.

## Entities

| Entity | Description | Persistence |
|--------|-------------|-------------|
| **User** | Email identity in `password` mode; only a scrypt password hash is stored | Postgres `users` |
| **Account** | Authorization/data isolation unit; fixed `default` in `local` mode, personal account through membership in `password` mode | Postgres |
| **Device** (= daemon, one per machine) | `{ id, accountId, name, host, platform, tokenHash, createdAt, lastSeenAt, revoked }`; the server issues `id` | Postgres |
| **deviceToken** | Independent device credential issued after browser authorization, used for subsequent daemon connections | SHA-256 hash on server; plaintext on daemon |
| **client session token** | Server-issued after username/password login; expiring and revocable, used for WS reconnection | Only SHA-256 hash in Postgres `client_tokens`; plaintext in browser |

## Credential storage

- **Server**: accounts, users, memberships, devices, and token hashes reside in Postgres. Plaintext tokens are not persisted.
- **Daemon**: `COFLUX_HOME/credentials.json` stores `{ serverUrl, daemonId, deviceToken }` with mode `0600`.
- **Web client**: only the server-issued client-session token is stored in `localStorage`; users do not configure tokens manually.

## Client login

`COFLUX_AUTH` accepts two modes:

- `local` (default): validate `COFLUX_USERNAME` / `COFLUX_PASSWORD` and sign into the fixed `default` account.
- `password`: normalize `username` as an email, check the scrypt password hash in `users`, then locate or initially create the personal account through a unique membership.

Both initial-login paths issue `ck_sess_*` session tokens. Reconnection submits only the token, without repeating password checks. Logout revokes the current token on the server; expired tokens cannot authenticate. In development, `COFLUX_DEV=1` gives `local` mode weak defaults of `admin` / `admin`. Production fails closed if `COFLUX_PASSWORD` is missing.

## Subsequent daemon connections

```text
daemon ──daemon.auth{ deviceToken }──▶ server
server: find an unrevoked Device by tokenHash; bind daemonId/accountId from its record
        ──daemon.authed{ daemonId }──▶ daemon
```

Authentication failure returns `daemon.authError`. If the device has been deleted, the daemon clears local credentials and restarts browser authorization. The key security property is that daemonId is never trusted from the client: one device's token cannot impersonate another device.

## Authorization and revocation

- Clients can reach every device in their account. Snapshots, control, rendezvous, checkpoints, proxy access, and broadcasts all validate account/daemon ownership across account boundaries.
- `client.removeDevice{ daemonId }` persistently revokes the device, disconnects it, and removes its workspace/task business data.
- Local credential persistence naturally implements one daemon per machine. Reinstalling on the same machine enrolls a new device; the old device can be removed in the UI.

## Device authorization flow (Tailscale style, plan 003; sole enrollment path since plan 034)

With no arguments, `cofluxd up` connects the daemon anonymously and requests one-time authorization, confirmed in a browser by a signed-in user. It calls `store.createDevice(...)` and writes `devices`. The resulting daemonId/deviceToken and subsequent authentication are identical regardless of how enrollment was initiated.

### State is in memory; the connection is authoritative

Pending requests live only in the hub process's in-memory map, not in a database; daemonId does not exist yet. This relies on single-instance deployment (B7 in `docs/OPEN_QUESTIONS.md`). Multiple instances would require shared storage, outside the current product model.

The central lifecycle property is that pending state is bound to the specific unauthenticated daemon WS connection. Disconnecting immediately invalidates it, avoiding dangling authorization requests after a daemon disappears without extra timeout recovery logic.

### Flow

```text
daemon (no local credentials)
  ──daemon.enrollRequest{ name, host, platform }──▶ server
server: generate one-time cf_authz_ token (at least 128 bits of entropy)
        store it in the pending map with the originating connection reference
  ──daemon.authorizePending{ url, expiresAt }──▶ daemon (same open connection; no reconnect)
daemon: write URL to ~/.coflux/pending-auth.json; cofluxd polls and prints the link

User opens <publicUrl>/authorize/<token> in the browser (server-rendered page)
browser ──POST account/password──▶ server (short-lived page-session cookie; 303 to same page)
browser ──GET authorization page──▶ server (validate token only after login; show name/host/platform)
browser ──POST authorize device──▶ server
server: validate one-time use and TTL (default 10 min; COFLUX_AUTHORIZE_TTL_MS)
        → remove token from pending map
        → create Device for the signed-in account via store.createDevice
        ──daemon.enrolled{ daemonId, deviceToken }──▶ daemon on the original pending connection
        ──Device Authorized completion page──▶ browser; invalidate page session
daemon: delete pending-auth.json and persist credentials.json
```

WS `device.authorizeInfo{ token }` / `device.authorize{ token }`, still used by the frozen online web client, share `Hub.describePendingAuthorization` / `Hub.authorizeDevice` with these pages. Only the browser response differs: WS messages versus HTML.

### Invalidation conditions

Black-box coverage of this flow was removed on 2026-09-13; acceptance is manual.

- **Single use**: successful `device.authorize` immediately removes the token from the pending map. Reuse returns `device.authorizeInfo{ ok:false }`.
- **TTL**: default 10 minutes, controlled by `COFLUX_AUTHORIZE_TTL_MS`, with active `setTimeout` cleanup. Expired tokens are treated as nonexistent, revealing no distinction between expired and never-existing tokens. The server silently removes them without notification or disconnection. **The worker renews links**: it tracks `expiresAt` and, if still unenrolled at expiry, resends `daemon.enrollRequest` on the same connection. A new `daemon.authorizePending` overwrites pending-auth.json, and cofluxd polling prints the new link. While the daemon remains alive, users receive fresh links; old links become invalid immediately at expiry.
- **Disconnect invalidation**: the daemon connection's `close` handler removes its pending token. Reconnecting generates a new token, matching the expectation of one authorization request per connected device.
- **Rate limits**: failed token guesses accumulate per page session (HTTP) or client connection (WS), using `COFLUX_AUTHORIZE_MAX_FAILURES`, default 10. Beyond the limit, all responses say too many attempts, revealing nothing about token existence. This is not keyed by source address, avoiding penalties for users sharing an egress IP. With 128-bit random tokens, brute force is infeasible; throttling is defense in depth. Page-login POSTs separately use source-address throttling via `COFLUX_LOGIN_RATE_LIMIT`, shared with WS login. `index.ts` calculates the source according to `requestAddress` trust rules and writes it into an internal header.

### Browser pages (server-rendered, plan 107)

`apps/server` renders `/authorize/<token>`, `/oauth/consent`, and `/proxy-auth` directly through `apps/server/src/auth-pages.ts` and `interface/auth-pages/`, under `COFLUX_PUBLIC_URL`. They use plain HTML, inline CSS, and form POSTs with PRG, requiring no JavaScript. They retain the former page structure: dark theme, centered 400px card, coflux branding above, and a secure-connection-to-your-remote-workspace footer. Desktop does not host these three flows. The frozen online web client remains only a legacy workbench, and the server generates no links to it.

Login is **per flow and lasts only a few minutes**. Credential checks share `Hub.checkCredentials` with WS `clientAuth`: local/password modes, scrypt concurrency limits, and lazy account creation. Success issues only an in-memory page session: random token, TTL matching `COFLUX_AUTHORIZE_TTL_MS`, bounded capacity with rejection when full. It **does not write `client_tokens` or issue `ck_sess`**. The `cf_page` cookie is isolated by flow `Path`: `/authorize`, `/oauth/consent`, or `/proxy-auth`. It uses HttpOnly, SameSite=Lax, Max-Age=TTL, and Secure when `COFLUX_PUBLIC_URL` is HTTPS. Completing authorization, a consent decision, or code issuance invalidates the session and clears the cookie. There is no long-term login, logout, or Remember Me.

CSRF: before login, the browser receives a stateless anonymous nonce cookie; after login, this becomes the session token. Every form has hidden `csrf = HMAC(process-random key, cookie value)`, with mismatches returning 403. `Origin` / `Sec-Fetch-Site` provide defense in depth: present cross-origin values are rejected, absent values allowed, since Node fetch omits Origin and black-box tests require this. SameSite alone is insufficient.

States and copy (all three pages share account/password fields and an invalid-credentials error banner):

- Authorization: before login, show Authorize New Device. GET **does not distinguish** valid from invalid tokens before login. Invalid/expired links show Authorization Link Unavailable. Confirmation shows a device card with name and `host · platform`, plus Authorize This Device. Completion says the device is registered to the account and the page may be closed. Failure, such as daemon disconnection, device limits, or prior redemption, shows Authorization Incomplete with its reason.
- Consent: missing `request` asks the user to restart authorization from the host because the request ID is absent. Invalid/expired requests show Authorization Request Unavailable. Confirmation identifies the requesting application, callback host, and scope, with Allow Access and Deny. Both decisions return 302 to the server-calculated host callback URL.
- Preview gate: missing/malformed `to` shows Invalid Preview Link; only shape is checked before login. Successful login issues a one-time code and returns 302 to the preview-domain callback, which sets its cookie there, matching WS `proxyIssueAuth`. Missing previews or ownership mismatches show Cannot Open Preview with a reason.

All interpolated values are escaped: device names/hosts/platforms, application names/callback hosts/scopes, and echoed tokens/request IDs. Responses use `Cache-Control: no-store`, `X-Frame-Options: DENY`, and CSP `default-src 'none'`. Page sessions and CSRF keys exist only in memory under the single-instance assumption, like `pendingAuthorizations` / `ProxyGate`. The HTTP-flow black-box cases were removed on 2026-09-13; acceptance is manual.

## OAuth clients (MCP, plan 090)

For **Claude Code / Codex on any machine**, the center hosts remote MCP at `<publicUrl>/mcp` over Streamable HTTP. Hosts connect with one command, `claude mcp add --transport http coflux https://api.coflux.dev/mcp`. Standard OAuth 2.1 authorization-code flow issues credentials; users confirm once in the browser without manually copying tokens. The center acts as both resource and authorization server.

| Entity | Description | Persistence |
|--------|-------------|-------------|
| **OAuth client** | Public client obtained through RFC 7591 dynamic client registration (DCR), `cf_oc_*`, `token_endpoint_auth_method=none`, with registered redirect_uris | Postgres `oauth_clients` |
| **Access token** | `cf_oat_*`, short-lived (default 1 hour; `COFLUX_OAUTH_ACCESS_TTL_MS`), bearer for `/mcp` | SHA-256 hash only in `oauth_tokens` |
| **Refresh token** | `cf_ort_*`, long-lived (default 30 days, matching session tokens; `COFLUX_OAUTH_REFRESH_TTL_MS`), rotated on use | Same table |
| **Pending request / authorization code** | `cf_oreq_*` / `cf_oac_*`, hub memory only; TTL, one-time use, and capacity limit `COFLUX_MAX_PENDING_AUTHORIZATIONS` | Not persisted, like device authorization |

Credentials are separate from web sessions. `client_tokens` are tied to browser login/logout; OAuth tokens have independent issuance, storage, and expiration. MCP transport is stateless, authenticating each request independently through its bearer token.

### Flow

```text
host ──POST /mcp (no token)──▶ 401 + WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp"
host ──GET PRM──▶ { resource: <publicUrl>/mcp, authorization_servers: [<publicUrl>] }
host ──GET /.well-known/oauth-authorization-server──▶ endpoints, code_challenge_methods_supported=[S256], registration_endpoint
host ──POST /oauth/register (DCR)──▶ client_id
host ──GET /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&state──▶ 302 <publicUrl>/oauth/consent?request=<id>
browser: server-rendered consent page; POST account/password for a short-lived page session
         → GET client name/callback host/scope → Allow Access or Deny via POST /oauth/consent/decide
server: consume pending request; on allow, issue code and redirect to full callback (code + original state + iss)
        on deny, redirect with error=access_denied
        WS oauth.authorizeInfo / oauth.authorizeDecide share OAuthService.describePending / decide
host ──POST /oauth/token (authorization_code + code_verifier)──▶ access + refresh
host ──POST /mcp (Bearer)──▶ tools
on expiry: POST /oauth/token (refresh_token) → new access + refresh; old refresh immediately invalidated
```

### Validation and invalidation

Black-box coverage of this flow was removed on 2026-09-13; acceptance is manual.

- **redirect_uri**: loopback `http://localhost`, `127.0.0.1`, and `[::1]` permit arbitrary ports/paths under RFC 8252; Claude Code chooses a random callback port each time. Non-loopback redirects must exactly match registered values. Invalid client_id/redirect_uri returns 400 without redirecting to an unvalidated address. Other invalid parameters return an `error` to the host according to the specification.
- **PKCE S256 is mandatory**: verifier mismatch returns `invalid_grant`.
- **Single-use authorization codes**: reuse returns `invalid_grant` and revokes the entire token chain issued by the first redemption.
- **Refresh rotation**: atomic conditional updates rotate only an unrevoked refresh token. Reuse of a just-rotated token within `COFLUX_OAUTH_REFRESH_REUSE_GRACE_MS`, default 60 seconds, is treated as concurrent rotation by multiple hosts on one machine: issue another pair under the same grant without revoking the chain. Reuse after the grace period signals possible compromise and revokes the entire chain. A mismatched `client_id` is also rejected.
- **Isolation**: all tools read only under the bearer-derived `accountId`. IDs belonging to another account return the same error as nonexistent IDs.
- All URLs derive from `COFLUX_PUBLIC_URL`, never request `Host` / `X-Forwarded-*`, since production has two reverse-proxy layers.
- Deferred: authorized-app list and individual-revocation UI, CIMD registration, and token introspection/revocation endpoints.
