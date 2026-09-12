# Plan 090: Center-hosted MCP, slice one—OAuth 2.1 authorization, `/mcp`, and read-only tools

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 80eedb0..HEAD -- proto/coflux/v1/client.proto apps/server/src apps/server/package.json apps/web/src/App.tsx apps/web/src/pages tests/src/harness.mjs docs/auth-design.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none (first of three slices, 090 → 091 → 092; prerequisite for 091/092)
- Category: feature
- Execution: subagent fable (preflight authorization on 2026-09-05: write and execute plans 090 → 091 → 092 consecutively without further user confirmation; STOP/BLOCK still applies; push/PR/merge are not authorized)
- Planned at: `80eedb0`, 2026-09-05

## Requirement

Coflux currently exposes capabilities through Web/iOS for people and the zero-credential agent commands in `cofluxd` from plans 074/088. Those commands are available only to agents **inside Coflux terminals** and only within their own workspace. The user wants Claude Code/Codex **on any machine**, including outside Coflux terminals or without a daemon installed, to inspect account assets, create child workspaces, run terminals, and read results.

The user confirmed this design during dev-explore on 2026-09-05; do not ask again:

- A **center-hosted remote MCP server**, using Streamable HTTP at production URL `https://api.coflux.dev/mcp`. Hosts connect with `claude mcp add --transport http coflux <url>` or `codex mcp add coflux --url <url>`.
- **Standard OAuth 2.1**: the host initiates authorization through Claude Code's `/mcp` menu or `codex mcp login`. A browser opens the Web consent page, the signed-in account confirms once, and the host subsequently refreshes tokens automatically.
- **No new CLI or daemon-side MCP**. Keep `cofluxd`, its PID-based local agent commands, and `hook` unchanged; MCP adds account-level access.
- Three slices: **090 provides OAuth authorization, `/mcp`, and read-only tools**; 091 adds center-initiated daemon effects and workspace/terminal write tools; 092 injects `COFLUX_*` into every PTY session.

### Outcomes after this slice

1. Claude Code on any machine connects with one command. Its first request receives 401 and the host opens Web consent. Sign in if needed; otherwise show the client name requesting account access with Allow/Deny. Approval redirects to the host callback, which obtains tokens without further interruption. Denial returns `access_denied`.
2. Agents can call these canonical snake_case tools; the executor chooses parameter/output shapes:
   - `list_devices`: account devices with ID, name, host, platform, online state, and worker/supervisor versions.
   - `list_projects`: ID, device, name, repository path, and default branch.
   - `list_workspaces`: ID, project, device, name, path, branch, main-workspace flag, and added/deleted line counts; optionally filter by project.
   - `list_terminals`: terminal/task ID, workspace, title, status, exit code, and creation time; optionally filter by workspace.
   - `read_terminal`: ANSI-stripped terminal text, defaulting to the last 200 lines with a configurable count, plus status, exit code, and snapshot time.
   - `list_ports`: listening ports and directly usable preview URLs for the account or a workspace.
3. Every tool returns only the **caller's account** data. Invalid/expired tokens produce `/mcp` 401 with `WWW-Authenticate: Bearer resource_metadata="…"` so the host can reauthorize or refresh.
4. Existing Web sidebar, iOS, and `cofluxd` behavior remains unchanged.

### Rejected alternatives

- Static tokens generated in Web and pasted into host configuration would leave plaintext credentials there and require token-management UI. Use host-initiated OAuth authorization codes.
- Do not lend Web session tokens to MCP. `client_tokens` follows browser login/logout; MCP credentials need independent issuance, storage, and expiry.
- No stateful MCP sessions: authenticate every request independently by bearer.
- No writes or daemon-backed reads in this slice. Both write tools and daemon command-log reads belong to 091. Here `read_terminal` uses the center's existing two-second checkpoints as a **transitional implementation**.
- No new notification/progress path; `notify`/`progress` remain in `cofluxd`.

## Decisions & tradeoffs

- **Center-hosted remote MCP, not a CLI or daemon-side MCP.** Plan 074 rejected MCP because of Rust JSON-RPC implementation cost, editing `~/.claude.json`, and uncertain Codex support; those objections concerned daemon-side MCP. The center uses TS and Raven/Hono, where the official Streamable HTTP SDK is inexpensive to mount. Claude Code and Codex now support remote HTTP MCP with OAuth. Rejected: a new `coflux` CLI and `coflux login`; the npm name is taken, descriptions would drift with npm versions, and the user explicitly chose MCP on 2026-09-05. Evidence: plan 074's CLI-plus-SKILL decision; `apps/server/src/app.ts:12-18` for Raven and `registerContractRoute`.

- **Standard OAuth 2.1 with authorization hosted at the center.** The center is both resource and authorization server. Implement `/.well-known/oauth-protected-resource` with self-referencing `authorization_servers`, `/.well-known/oauth-authorization-server`, DCR for public clients with `token_endpoint_auth_method: none`, authorize redirecting to Web consent, and token exchange requiring authorization codes plus PKCE `S256` and rotating refresh tokens. Missing/bad `/mcp` tokens receive 401 with `resource_metadata`. CIMD is optional at the executor's discretion. Permit arbitrary ports and paths for loopback redirect URIs at `http://localhost`, `127.0.0.1`, or `[::1]`, following the recorded RFC 8252 decision and Claude Code's random callback port; non-loopback URIs must exactly match registration. Rejected: CIMD-only, because DCR is supported by both hosts. Evidence: MCP authorization specification dated 2026-07-28 requires PRM/OAuth 2.1 and recommends CIMD while retaining deprecated DCR; Claude Code documents localhost callbacks, DCR/CIMD, `/mcp` authorization on 401/403, and one automatic refresh/retry after an authorized 401; Codex documents `codex mcp login` and `AUTO|CIMD|DCR` registration strategies.

- **Independent credential tables storing hashes; pending requests and authorization codes remain in memory.** Persist DCR clients and access/refresh token hashes with account_id, optional user_id, client_id, scope, expiry, and revocation. Pending consent and issued codes use bounded, expiring, single-use maps like `pendingAuthorizations`; the single-instance center restarting merely requires another authorization attempt. Rejected: `client_tokens`, whose revoke-all behavior is tied to Web logout and lacks client binding/refresh rotation; and persistent authorization codes, whose ten-minute single-use lifetime does not justify migration/cleanup. Evidence: `store.ts:358-387`, `hub.ts:276` and `:1562-1590`, OPEN_QUESTIONS single-instance design, and auth-design's in-memory-state rationale.

- **Opaque random tokens using `genToken` prefixes, short access lifetime, and long single-use refresh lifetime.** Rotation immediately invalidates the old refresh token while old access expires naturally. The executor chooses lifetimes; suggested access is hours and refresh comparable to `COFLUX_SESSION_TTL_MS`. Rejected: JWT adds key management and cannot be immediately revoked; repository credentials use random strings with SHA-256 hashes. Evidence: `secrets.ts:4-10` and auth-design's hash-only persistence.

- **Consent follows AuthorizePage's independent WebSocket pattern through new client messages.** Select the page by pathname in App.tsx. Authenticate with `clientAuth`, reusing the login form when necessary; query the pending request for client name/callback host; confirm or deny; receive the complete redirect URL with code/original state or `error=access_denied`; call `location.assign`. Next free ClientToServer/ServerToClient fields are **38/37**, with reserved numbers checked. Rejected: HTTP-cookie sessions because Web stores session tokens in localStorage; bearer-fetch consent would create another authentication entry point outside the sole client-auth path. Evidence: `AuthorizePage.tsx:35-60`, `App.tsx:17-20`, client.proto maxima 37/36, and unknown-branch defaults in client store.ts:620 and Swift CofluxClient.swift:498. Accounts and users are 1:1 at hub.ts:2819-2826, so no account selector is needed.

- **Mount POST/GET/DELETE `/mcp` as Raven contract routes with stateless transport and a new principal-bound McpServer per request.** Resolve bearer to `{ accountId, userId?, clientId, scope }`; tools receive the principal, never Request. Raven unconditionally consumes JSON bodies before handlers, so pass its parsed body to SDK `handleRequest` as `parsedBody`. Construct Responses for all OAuth/MCP failures rather than throwing into Raven's incompatible error envelope. Rejected: bypassing Raven in index.ts duplicates routing/errors and loses request context; stateful `Mcp-Session-Id` adds unnecessary cross-request state and future multi-instance risk. Evidence: `node_modules/.pnpm/@raven.js+core@3.0.0_hono@4.12.30/node_modules/@raven.js/core/dist/index.mjs:432-441` for parsing, `:534-542` for errors, `:614-618` for method/path routes; server index.ts:37-44 only diverts preview hosts, leaving `.well-known` intact. SDK `WebStandardStreamableHTTPServerTransport` uses `sessionIdGenerator: undefined` for stateless mode and `handleRequest(request, { parsedBody })`.

- **Executor selects exact-pinned SDK/schema versions.** Either `@modelcontextprotocol/sdk` 1.30.0 or `@modelcontextprotocol/server` 2.0.0 supplies a Web-standard transport. Add zod for tool schemas; the server currently lacks it. Evidence: npm view on 2026-09-05 reported these versions and zod 4.5.4; server package.json has no zod.

- **Read-only tools reuse existing account-scoped center reads without new storage/protocol.** Use hub `daemonInfoList` for device status/versions; store `listProjects/listWorkspaces/listTasks`; `routeTable` plus `buildPreviewUrl` for ports; and `getSessionCheckpointByTask` for terminal content. Strip ANSI, take the last N lines, and trim trailing blank lines on the server without changing checkpoint semantics shared with Web. Default to 200 lines. Daemon command-log reads belong to 091; this slice does not touch the daemon. Evidence: hub.ts:2186-2216 snapshot assembly; store.ts:416,619,676,709,1095; proxy.ts:75; CLI `stripAnsi`/`tailLines` are conceptual references, not directly importable.

- **Configure the center's public URL and derive all issuer/PRM/metadata URLs from it.** Never derive from Host/X-Forwarded headers. Default locally to `http://127.0.0.1:<port>` and configure production `https://api.coflux.dev`. Two reverse proxies, owo-jp-gw then prod-jp Caddy, make headers inconsistent and forgeable. Evidence: config.ts:96-97 has only webUrl, and deployment.md records topology.

- **Add versioned migrations without changing the frozen baseline.** Append version 4 to MIGRATIONS. `initialSchemaSql` is the immutable ledger-validation definition. Evidence: schema-migrations.ts:1177-1207 for versions 1–3 and :159-176 for the baseline containing client_tokens.

- **Black-box tests call OAuth/MCP through fetch and consent through the test WebSocket Client.** Import no application code; negative cases are mandatory. Evidence: AGENTS harness philosophy and harness.mjs:509-570, where startServer(opts.env) injects public-URL configuration.

- **Claude does not visually accept frontend presentation under the recorded repository convention.** The user reviews consent-page appearance; still run type checks/builds.

## Direction

```text
Claude Code/Codex ──HTTP──▶ api.coflux.dev
   │ POST /mcp without token → 401 + WWW-Authenticate: resource_metadata
   │ GET /.well-known/oauth-protected-resource → { resource, authorization_servers:[issuer] }
   │ GET /.well-known/oauth-authorization-server → endpoints, code_challenge_methods:[S256], DCR endpoint
   │ POST /oauth/register → persistent client_id
   │ GET /oauth/authorize?… → in-memory pending request → 302 to <webUrl>/<consent>?<request id>
   │   Browser: independent WS clientAuth → request details → user decision → code issuance → redirect to host
   │ POST /oauth/token (code+PKCE / refresh) → access + refresh, hashed persistence and rotation
   └ POST /mcp (Bearer) → principal → per-request McpServer → account-filtered read-only tools
```

### Milestone 1: Protocol and storage

Add consent message pairs at fields 38/37 and regenerate all three languages. Migration 4 creates OAuth client/token tables; add public-URL configuration and SDK/zod dependencies.

Validation: `cd proto && buf generate && git status --short proto packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` shows only expected new-message artifacts; server tsc and `cargo test -p coflux-protocol` exit 0.

### Milestone 2: OAuth 2.1 authorization

Implement PRM/AS metadata, DCR, authorize, code-plus-S256 and refresh token exchange, and `/mcp` challenges. Bound/expire pending consent and one-time codes in memory. Hub handles consent messages and issues codes. Every failure returns OAuth 4xx JSON such as invalid_request, invalid_client, invalid_grant, or unauthorized_client, bypassing Raven's envelope. Server tsc exits 0.

### Milestone 3: `/mcp` and six read-only tools

Mount POST/GET/DELETE, resolve bearer principals, and create McpServer per request. Support initialize/tools/list/tools/call. Return the account-scoped data specified above, including ANSI-stripped terminal tails. Server tsc exits 0.

### Milestone 4: Web consent

Add the page with reused login, client name/callback host, allow/deny, redirect, and readable failure/expiry states. Route by pathname and always include clientVersion on its WebSocket. Web tsc and build exit 0.

### Milestone 5: Black-box acceptance and documentation

Use new files with exclusive ports beginning at 8866. Exercise DCR → authorize 302 → test WS login/consent → token exchange → MCP initialize/tools/list and at least one positive assertion per tool. Verify online-daemon visibility and real terminal output. Negative cases cover missing-token 401/resource_metadata, wrong PKCE, reused authorization code, old refresh after rotation, cross-account isolation in password mode, unregistered non-loopback redirect URIs, and denial callbacks containing access_denied. The second account must see none of the first's assets and get explicit errors for its IDs. Remove relevant handlers to prove the new tests fail.

Add OAuth-client/MCP design documentation, environment variables to deployment.md/README, and plan status. Run `node --import tsx --test tests/src/<new-file>.test.mjs` for acceptance.

## Landmines

- Raven preconsumes JSON at index.mjs:432-441. Obtain its parsed body for SDK parsedBody. Raven leaves form-urlencoded token bodies alone; use request.formData(). Load the installed raven-use skill before writing routes.
- Thrown errors become Raven envelopes at index.mjs:534-542, unreadable to OAuth/MCP hosts. Construct Response on every failure path.
- Consent WebSockets require clientVersion under plan 033. AuthorizePage.tsx:41-43 records the 2026-07-24 incident where omission caused stale-bundle rejection.
- Deploy Web/server together: new messages and artifact-derived build admission require matching builds. Follow deployment.md ordering.
- Never change initialSchemaSql at schema-migrations.ts:158-176. New tables belong to version 4; CORE_PREFLIGHT_CHECKS/:396 and CORE_INTEGRITY_SQL/:619 are part of version 3, so new ownership constraints belong in their own migration.
- Checkpoints refresh every two seconds; very short commands may leave none, as agent-control.test.mjs notes. Use sufficiently long-lived/output-retaining commands rather than instant echo. Describe up-to-two-second delay and potentially empty new terminals in the tool. Plan 091 replaces this read path.
- Claude Code defaults remote HTTP MCP requests to 60 seconds and truncates outputs above 25k tokens. Bound read_terminal defaults/maximum, matching the CLI's 200-line default.
- Only startServer(opts.env) forwards environment at harness.mjs:527-537. Set test public URLs to the actual local port or discovery points nowhere.
- startStack includes relay/daemon; use lighter startServer when unnecessary, but startStack for online-device/terminal assertions. Every test file needs an exclusive PORT.
- Cross-account tests require COFLUX_AUTH=password and two users, following password.test.mjs.
- Frozen apps/mobile shares protocol types, so its build must still pass; unknown-branch defaults should avoid source changes.
- owo-jp-gw Caddy also hosts other sites. Before deployment, verify no competing `.well-known` handle in the API block; HTTP-01 only occupies acme-challenge. Preserve origin tls_server_name. SSE flushes immediately by default; consider flush_interval only if measurements show stalling. These are deployment checks, not code changes.

## Scope

In scope:

- client.proto and generated TS/Rust/Swift outputs.
- apps/server/src/** for OAuth/MCP modules/routes, config, store, migrations, consent handling, and read tools.
- Server package.json and pnpm-lock.yaml for SDK/zod.
- Web App.tsx/pages and shared auth components if needed.
- New tests; minimal harness changes only for reusable helpers.
- auth-design.md, deployment.md, root README environment table, and plans/README.md.

Out of scope:

- Worker/supervisor source; generated Rust changes are the only daemon-side exception.
- Write tools, new server-to-daemon messages, and daemon terminal reads: plan 091.
- COFLUX_* injection, packages/cli, and SKILL: plan 092 or unchanged.
- packages/client source; if generated types break builds, make only a minimal reported repair.
- Frozen mobile source and iOS; mobile build must still pass.
- Authorized-app lists, individual-revocation UI, registration beyond CIMD, token introspection/revocation endpoints: future work.
- MCP resources/prompts.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web type check | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Web build | `pnpm -C apps/web build` | exit 0 |
| Frozen mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Generate protocol | `cd proto && buf generate` | Expected artifact changes only |
| Rust protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Daemon build after generated changes | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0, no warnings |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Focused black-box acceptance | `node --import tsx --test tests/src/<new-file>.test.mjs` | exit 0 |
| Full black-box acceptance | `pnpm -C tests test` | Pass except existing cli-doctor baseline failures |
| Real-host acceptance, manual | Local dev server; `claude mcp add --transport http coflux http://127.0.0.1:8787/mcp`; authorize in `/mcp`, then call list_devices | One authorization enables use |

Black-box tests need local Postgres through pnpm dev:pg and daemon binaries built by pretest. For widespread timeouts, first check Docker health. Consent-page visuals require user acceptance.

## Done criteria

- [ ] All listed commands pass.
- [ ] One-command Claude Code setup → 401 → browser consent → tokens → usable tools, without pasted tokens.
- [ ] All six tools return only caller-account data, proven by isolation tests.
- [ ] PKCE, one-time codes, refresh rotation, and redirect checks have negatively validated tests.
- [ ] Missing-token `/mcp` returns 401 with parseable resource_metadata; Claude Code can consume discovery metadata.
- [ ] Credential tables store only hashes; client_tokens and Web login/logout are unchanged.
- [ ] No nongenerated crates changes; cofluxd and the Web sidebar behave unchanged.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Raven contract routes cannot carry MCP transport, including parsed bodies or text/event-stream Responses. Report and stop; do not bypass index.ts without a decision change.
- The selected SDK cannot accept parsed bodies and Raven cannot disable JSON parsing.
- Concurrent work occupies ClientToServer 38 or ServerToClient 37.
- Implementation requires worker/supervisor source changes or new server-to-daemon messages.
- A fact cited by Decisions no longer holds.
- A validation command fails twice after one reasonable repair.

## Maintenance notes

- The user's 2026-09-05 decision explicitly supersedes plan 074's AI-zero-credential decision and its stop condition against account-level agent credentials. OAuth provides independent account credentials while local PID-based cofluxd remains zero-credential. Distinguish these identities before evaluating future capabilities.
- Checkpoint-based read_terminal is transitional; 091 prefers daemon command logs. Do not expand checkpoint semantics on this foundation.
- Token lifetimes/map bounds are tuning parameters; review Decisions' storage/token rationale first. Authorized-app revocation UI is separate future work organized by client_id.
- Production checklist: configure prod-jp public URL, deploy server/Web together, run real Claude Code authorization, and inspect owo-jp-gw's API `.well-known` handling.
- Plan 091 adds hub completion primitives and prepared-operation initiator: server. Keep the boundary between principal and hub/store clean; do not leak Request or Raven context into tools.
