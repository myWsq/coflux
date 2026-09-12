# Plan 006: Server/web port forwarding: host routing, authentication, and preview links

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- apps/server apps/web packages/protocol`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: plans/004-port-forward-protocol.md
- Category: feature
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

Implement complete reverse-proxy and access-control support in the server (`apps/server`) and web client (`apps/web`), using the `packages/protocol` contract established by plan 004:

1. **Port routing:** process daemon `ports.update` reports after verifying ownership against the connection’s daemonId. Maintain a shortId and preview URL per (daemonId, port), broadcast `ports.updated` to the account’s clients, and include all ports in `state.snapshot`. Revoke routes and broadcast removal when a daemon disconnects, a session exits, or a port disappears.
2. **Reverse proxy:** route HTTP requests and WS upgrades with Host `<shortId>.<proxyHost>` through the owning daemon’s tunnel (`proxy.open`, kind=4 frames, `proxy.close`) to the target port. Preserve existing /health, /daemon, and /client behavior on non-proxy hosts.
3. **Access control:** redirect requests without a valid proxy cookie to web authorization with 302. The logged-in web client exchanges WS `proxy.issueAuth` for a one-time callback URL and navigates there. The callback validates the code, sets a cookie, and redirects to the original path. Require the cookie session’s accountId to match the route’s device owner; cross-account access always receives 403 or reauthorization. Restrict redirects to this service’s proxy subdomains to prevent open redirects.
4. **Web UI:** show detected ports as preview links on running tasks. Add the `#/proxy-auth` redirect flow, following the existing `#/authorize/<token>` device-authorization page.

Expected browser experience: start a development server in a remote task’s PTY; its port link appears within seconds; click it and, after a transparent first-use authorization redirect, the page works fully, including absolute-path assets and HMR WebSockets.

## Decisions & tradeoffs

- **Route by Host header using wildcard subdomains.** Add `proxyHost` to config (`COFLUX_PROXY_HOST`, default `p.localhost` in development). Requests for `<shortId>.<proxyHost>` are proxy requests. Local tests can supply Host headers without DNS. Rejected: `/proxy/<id>/...` prefixes, which break absolute-path assets and require unbounded rewriting, as established in dev-explore. Evidence: one HTTP server handles request and upgrade events (`apps/server/src/index.ts:53,69`), allowing Host dispatch; production already sits behind Caddy (`apps/server/src/config.ts:44`), and deployment owns wildcard certificates.
- **Allocate random short IDs on the server and keep them in memory, without encoding daemonId or port.** Assign one when a (daemonId, port) first appears, for example 10 base36 characters. Keep it stable until server restart, after which a new ID is acceptable. URLs reveal no device information. Rejected: `<daemonId>-<port>`, an unattractive 43-character string exposing internal IDs, and deterministic HMAC IDs, which overengineer a change that only requires users to click a new link. Evidence: routes are runtime entities, like sessions (`docs/architecture.md` §5: sessions are not persisted).
- **Forward raw bytes per TCP connection, taking over the socket after the first request.** Identify proxy requests, authorize them, reconstruct the initial request bytes (request line, rawHeaders, buffered body), write them to the tunnel, and bridge `req.socket` bidirectionally. Subsequent keep-alive requests and WS frames pass through without server parsing. Handle upgrade similarly with head plus socket bridging. Rejected: request-level HTTP reconstruction, which needs special handling for SSE, long polling, chunked encoding, and WebSocket; raw tunneling naturally supports HMR. The cookie is not rechecked after takeover of an already authorized connection; this is accepted. Evidence: Node exposes sockets in request/upgrade events, matching the hub’s ownership-check-and-forward-bytes principle (`docs/architecture.md` §6).
- **Use a random cookie token backed by an in-memory {accountId, exp} table, with Domain=.<proxyHost>.** One authorization covers that account’s preview subdomains in the browser. Set HttpOnly, SameSite=Lax, and Secure for HTTPS. Choose a TTL on the scale of `config.sessionTtlMs`, at least one day. Validate presence, expiry, and `cookieSession.accountId === route.accountId`; this final check enforces cross-account isolation under the wildcard domain and must be tested. Server restart invalidates cookies, followed by a transparent authorization redirect for already logged-in users. Rejected: stateless JWT/HMAC cookies, since an in-memory table is simpler and revocable for the single-instance deployment (docs/OPEN_QUESTIONS B7); also reject reusing client_tokens, which mixes persistent and runtime semantics. Evidence: `pendingAuthorizations` already uses memory plus TTL (`apps/server/src/hub.ts:69-79,107`).
- **Authorization chain: 302 → web `#/proxy-auth?to=…` → WS `proxy.issueAuth {redirect}` → `proxy.auth {url}` → callback `/__coflux/auth?code=…&to=…` → cookie → 302 to the original path.** Codes are single-use, expire after 60s, and bind to accountId. Require the redirect host to match `^[a-z0-9]+\.<proxyHost>$`, with an existing shortId owned by the client’s account. Restrict `to` to path and query, excluding host, to prevent open redirects. Rejected: setting cookies directly from the cross-domain web client, or exposing long-lived tokens in URLs. Evidence: the web already has a clientToken from `auth.ok` (`apps/server/src/hub.ts:690-733`) and the hash-based authorization-page precedent from plan 003 (`/authorize/<token>`).
- **Serve `/__coflux/auth` on the proxy subdomain.** Reserve the `__coflux` prefix so proxied applications cannot collide with it. The server handles only this callback path on proxy domains; all others pass through. Rejected: a callback on the main domain, which cannot set the required `.<proxyHost>` cookie.
- **Server tunnel state:** map server-issued connId to browser socket. On daemon `proxy.opened {ok:false}` or `proxy.closed`, destroy the browser socket, returning 502 if HTTP takeover has not occurred. Browser closure sends `proxy.close`; daemon disconnection destroys its tunnel sockets and revokes its routes. Forward inbound kind=4 frames only if connId belongs to the sending daemon, matching PTY ownership checks such as `s.daemonId !== conn.daemonId` (`apps/server/src/hub.ts:183`).
- **Minimal web UI (decided during planning):** show an inline task port link such as `:5173 ↗`, opening the preview URL in a new tab. Initialize from snapshot.ports and apply ports.updated updates. Add no management panel or switches: detected ports are immediately usable.

## Direction

Server changes cover config (proxyHost), index.ts (Host dispatch for request/upgrade while preserving main-domain behavior), a proxy module (authorization, code/cookie tables, socket-to-tunnel bridging), and the hub (reports, routes, broadcasts, snapshots, proxy.issueAuth, frame forwarding, cleanup hooks). Prefer `proxy.ts` for tunneling and access control, keeping the hub focused on routing and ownership. Add proxy-auth and port links to web App.tsx.

### Milestone 1: Port routing state machine (without reverse-proxy forwarding)

Implement ports.update → route table/shortId → broadcast/snapshot, with revocation on session exit or daemon disconnection. Validation: `pnpm exec tsc --noEmit -p apps/server` → exit 0; plan 007 covers behavior.

### Milestone 2: Reverse data path (no access control, or the access control can be bypassed by a fake switch)

Implement Host dispatch, tunnel bridging, and lifecycle cleanup. A curl request with a supplied Host reaches a local test port. Validation: `pnpm exec tsc --noEmit -p apps/server` → exit 0.

### Milestone 3: Login access control closed loop + web UI

302/issueAuth/callback/cookie/account isolation; task line port link; proxy-auth routing. Validation: `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web` → exit 0.

## Landmines

- If the new ClientToServer/DaemonToServer message does not enter the FIELDS of `packages/protocol` at the same time Whitelist (004 has been added, do not change it), the transport layer silently discards it, and it appears as a timeout.
- `handleDaemonBinary` (`apps/server/src/hub.ts:178`) currently only recognizes pty three frames; kind=4 uplink the traffic must be diverted here and the connId→daemon ownership verification must be done, otherwise the malicious daemon can inject bytes into other people's browsers.
- Browser sockets need bounded buffering, just like `clientBufferHardLimit`. Respect `socket.write` return values and `drain`, or use pipe semantics; never buffer indefinitely. Follow the slow-client philosophy at `hub.ts:184-192`; destroying connections above a limit is an acceptable simple approach.
- After taking over `req.socket`, remove it from HTTP keep-alive/parser management. Confirm current Node behavior before removing listeners or calling `socket.removeAllListeners('data')`; otherwise the HTTP parser competes with raw forwarding. This is the hardest part: implement the clean socket/head upgrade path first, then request handling.
- `/health`, `/daemon`, `/client` on the proxy domain do not exist - Host offload must precede existing upgrade routing judgment (`apps/server/src/index.ts:69-78` now press pathname destroy).
- The WS service address of the web comes from `VITE_COFLUX_SERVER` (README env table); proxy-auth page IssueAuth must be issued on the same WS session, reuse the App's existing connection management, and do not open a new naked connection.
- There is no https in the dev environment, and cookies cannot have Secure; add it according to the `x-forwarded-proto`/URL scheme condition.

## Scope

In scope:
- `apps/server/src/**`
- `apps/web/src/**`

Out of scope:
- `packages/protocol` — The contract has been frozen by 004; if a gap is found, report STOP
- `crates/**` —  owned by plan 005
- `tests/src/**`, docs - owned by plan 007
- Production DNS wildcard DNS/Caddy wildcard certificate configuration - deployment side, outside the repository code

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| TS type check | `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web` | exit 0 |
| Rust build (not broken) | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| Black-box regression (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 (existing tests have no regressions) |

## Done criteria

- [ ] All listed commands pass.
- [ ] All existing behaviors of non-proxy Host remain unchanged (black-box regressions to green).
- [ ] Proxy request without cookie 302 to web; forged/expired/cross-account cookies are not allowed.
- [ ] redirect/`to` check rejects any external URL (no open redirects).
- [ ] After the daemon goes offline, all its routes and tunnels in transit are cleared, and the client receives the port revocation broadcast.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md`  status is updated.

## STOP conditions

- 004 The implemented protocol is missing fields/messages and cannot express routing or access control semantics.
- The `req.socket` takeover plan does not work in the current node version (the http parser cannot be safely deactivated)— this overrides the connection granularity decision, requiring a re-decision (downgrade to request granularity + separate upgrade).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

Production prerequisites belong to deployment: point `*.p.coflux.dev` wildcard DNS to prod-jp; add a Caddy wildcard site using DNS-01 certificates and the same server port; set `COFLUX_PROXY_HOST=p.coflux.dev`. Cookie and code tables live in single-instance memory and must be externalized alongside pendingAuthorizations if scaling out. The `__coflux` path prefix is reserved for the proxy.
