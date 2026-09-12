# Plan 033: Propagate build IDs and reject mismatched clients to retire stale bundles

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 16aad36..HEAD -- proto/coflux/v1/client.proto packages/protocol packages/client apps/server/src/hub.ts apps/server/src/config.ts apps/web/vite.config.ts apps/web/src/pages/MainPage.tsx apps/mobile/vite.config.ts apps/mobile/src/App.tsx tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `16aad36`, 2026-07-23

## Requirement

Production incident (2026-07-23): after deploying a terminal-takeover fix, a Mac Safari tab still running an old app.coflux.dev bundle continued the previous aggressive attach behavior, stealing each new terminal’s holder within about 300ms, confirmed by packet capture. Two other stale pages repeatedly sent taskStart about every 100ms. Deploying new code could not retire old clients: without a service worker or version check, they could reconnect indefinitely with their original bundle.

Required outcomes:

1. Production identifies each client’s build version during authentication. Missing or mismatched versions cannot subscribe and therefore cannot take control through taskStart.
2. New clients receiving a mismatch automatically call location.reload() once to fetch the new bundle, preserving their token for seamless recovery. If still mismatched afterward, stop reconnecting and show a readable message instead of looping.
3. Old clients without version reporting receive authError, return to login, and stop automatic retries through existing shouldRetry=false behavior.
4. Local server/Vite development and existing black-box tests remain unaffected when the server has no configured build ID.

This is authentication-phase admission control, not post-connection notification. Broadcasting a version and trusting clients to reload cannot stop old code that ignores new messages. authError is the existing message that can control those clients.

## Decisions & tradeoffs

- **Build-version source of truth (revised after user feedback on 2026-07-23): use the short Git SHA.** Production Vite builds obtain `git rev-parse --short HEAD`, embed it with define, and write the same value to `dist/build-id.txt`; vite dev uses `"dev"`. The server’s allowed set is the union of `COFLUX_BUILD_ID` (explicit override, including tests) and file contents from comma-separated `COFLUX_BUILD_ID_FILE` paths, configured once for web/mobile dist. Read files on every authentication; an empty set disables checking. Artifact-derived IDs keep the expected version aligned with what Caddy serves, without rebuild/restart coupling or manual version alignment. The user rejected manually setting SHA env values every deployment. Runtime Git lookup is also wrong: pulling without rebuilding would make Git disagree with dist. Evidence: systemd runs server source via `tsx src/index.ts` (apps/server/package.json start); config env conventions are in `apps/server/src/config.ts:43-50`.
- **Environment-gated checking:** the original decision skips checking when `COFLUX_BUILD_ID` is unset and allows client `"dev"` when it is set, supporting a local frontend against a production debug endpoint. Unconditional enforcement would break existing black-box clients that construct ClientAuth without a version.
- **Add `optional string client_version = 5` to ClientAuth.** Fields 1–4 are already occupied (`proto/coflux/v1/client.proto:14-19`); only add new numbers. Regenerate all three languages with buf generate. WS query parameters would hide protocol semantics in transport plumbing and require additional upgrade handling.
- **For a present but mismatched version, send clientOutdated and close; do not send authError (decided during planning).** Use the next free ServerToClient oneof tag. The earlier clientOutdated + authError idea was rejected because authError clears the token (`packages/client/src/store.ts:168-176`), forcing login after every deployment. clientOutdated enables reload while preserving it.
- **For a missing version, send authError with an expired-client/refresh message, then close.** Old clients ignore unknown messages through `default: break` (`store.ts:322`). Their existing authError path stops retries and returns to login (`store.ts:168-176`). The user accepts having to log in again after refreshing these legacy clients.
- **Prevent reload loops and show a dedicated status page (revised after user feedback on 2026-07-23).** On clientOutdated, record in sessionStorage that version X has triggered a reload. Reload on the first occurrence; if it repeats, stop retries and enter `authState: "outdated"`. Web/mobile render a dedicated version-updated page with explanatory text and Refresh. Never clear the token. Reusing loginError/auth-failed was explicitly rejected because version updates are not authentication failures. Unguarded reload can loop forever on cached index.html. Mobile remains frozen except for this minimal UI required by the shared store-state change.
- **Pass buildId through the shared client.** Add it to createCofluxClient options and all three ClientAuth variants (`packages/client/src/connection.ts:29-35`, buildAuthPayload). Wire web/mobile creation at `apps/web/src/pages/MainPage.tsx:12` and `apps/mobile/src/App.tsx:22`. This minimal shared-layer adaptation respects the mobile freeze (AGENTS.md:11).
- **Fix ghost sockets in the same change.** connect() currently overwrites `socket = ws` without closing the old socket (`packages/client/src/connection.ts:68-75`), leaving a receive-only ghost on the server. The incident exposed this multiplier for zombie connections; closing the previous socket before replacement is a small, related fix.

## Direction

Implement protocol → server admission → client response → tests in dependency order.

### Milestone 1: Version propagation

Add ClientAuth client_version and regenerate TS, Rust prost, and Swift together. buf generate uses clean: true and rewrites output directories; never edit generated artifacts manually. Embed the short SHA in web/mobile production builds and dev in Vite development; pass buildId through createCofluxClient into authentication. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`, `node_modules/.bin/tsc -b apps/web/tsconfig.json`, and `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` → exit 0; `cargo build -p coflux-supervisor -p coflux-worker` has zero warnings.

### Milestone 2: Server admission

The original milestone adds optional COFLUX_BUILD_ID configuration and checks versions **after successful credential validation but before subscription**. Allow unset configuration or client dev; send clientOutdated and close on mismatch; send authError with an expired-client/refresh message and close when missing. Ensure send-before-close delivery, using ws buffer semantics if needed; M4 verifies receipt. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 3: Client response

Handle clientOutdated with the sessionStorage guard: reload once; on repetition, stop shouldRetry and show a version-updated/force-refresh message through the recorded loginError/authState path, preserving the token. Fix connect() by closing the previous socket before replacement while retaining the `socket !== ws` guard semantics. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0.

### Milestone 4: Black-box tests

Run a server configured with COFLUX_BUILD_ID. Verify matching clients receive authOk and subscribe, mismatched clients receive clientOutdated and close, and versionless clients receive authError. Existing tests without this configuration stay green, proving enforcement is gated. Validation: the verifier runs `pnpm -C tests test` (Commands acceptance entry).

## Landmines

- Existing harness/lifecycle/security/supabase clients construct versionless ClientAuth. Ungated checking would reject the entire suite.
- authError clears localStorage tokens and sets shouldRetry=false (`packages/client/src/store.ts:168-176`). Use it only for missing versions, never for a reported mismatch, or every deployment forces another login.
- `buf generate` uses clean: true in proto/buf.gen.yaml and rewrites packages/protocol/src/gen, crates/protocol/src/gen, and proto/gen/swift. Commit them together and retain zero-warning Rust builds per AGENTS.md.
- Production runs server source directly through tsx src/index.ts, without a server build artifact. The recorded server-ID configuration uses environment variables, not bundler injection.
- Old clients silently ignore unknown ServerToClient cases (`store.ts:322`, default: break). Any behavior expected of old code must use messages it already understands.
- Add field numbers without changing existing ClientAuth 1–4. Absence of new field 5 is itself the legacy-client signal.

## Scope

In scope:

- `proto/coflux/v1/client.proto`
- `packages/protocol/src/gen/**`, `crates/protocol/src/gen/**`, `proto/gen/swift/**`
- `packages/client/src/store.ts`, `packages/client/src/connection.ts`, and `packages/client/src/index.ts` if exports are needed
- `apps/server/src/hub.ts`, `apps/server/src/config.ts`
- `apps/web/vite.config.ts`, `apps/web/src/pages/MainPage.tsx` or minimal client-creation wiring, the web auth gate, and a minimal version-updated page
- `apps/mobile/vite.config.ts`, `apps/mobile/src/App.tsx`: buildId wiring and minimal version-updated page
- `tests/src/**`: version-admission cases
- `plans/README.md`

Out of scope:

- Server taskStart rate limiting: a separately filed defect.
- Empty-workspace first-terminal races: the non-RUNNING branch at apps/web/src/components/workbench/workspace-terminal.tsx:182-190 lacks an activeRef gate; this is a separate defect.
- Production deployment itself: configuring systemd COFLUX_BUILD_ID, adding app/m index.html Cache-Control: no-cache in Caddy, and restarting the server are manual acceptance/deployment steps; see Maintenance notes.
- Daemon behavior in crates/{supervisor,worker}: admission applies only to /client. Daemon upgrades have their own orchestration (plan 015).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| mobile type check | `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` | exit 0 |
| Rust build (zero warnings) | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, no warnings |
| Black-box testing (acceptance) | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |

Black-box tests require local self-hosted Supabase’s direct port 54322. The Supavisor pooled port 5432 reports tenant errors; see AGENTS.md development pitfalls.

## Done criteria

- [ ] All listed commands pass.
- [ ] Set the server of `COFLUX_BUILD_ID`: the matching version is subscribed normally; it is disconnected after receiving `clientOutdated` for mismatch and the token is not cleared; it stops reconnecting after receiving `authError` without version.

- [ ] The behavior of the server without `COFLUX_BUILD_ID` is exactly the same as before the change (the existing black-box test is completely green with no modifications).

- [ ] The web/mobile production build product embeds git short SHA; under vite dev it is `"dev"`.

- [ ] `connect()` reconnect no longer leaks old sockets.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The `buf generate` artifact causes the Rust side to fail to build with zero warnings and cannot be resolved within gen boundaries.

## Maintenance notes

- **Initial production rollout, performed manually:**
  1. Pull on prod-jp and build web/mobile, which automatically emit dist/build-id.txt.
  2. Add `COFLUX_BUILD_ID_FILE=/opt/coflux/apps/web/dist/build-id.txt,/opt/coflux/apps/mobile/dist/build-id.txt` once to `/etc/coflux/server.env`. Later deployments need no manual version update because authentication rereads artifact IDs.
  3. Add `Cache-Control: no-cache` to app.coflux.dev / m.coflux.dev index.html responses in Caddy, preventing reload from repeatedly fetching a cached shell and hitting the guard.
  4. Restart coflux-server. Old bundle pages are rejected to login on their next reconnect and lose takeover access.
- Routine deployment needs only pull and build; restart the server only when its code changes. The allowed version set follows build-id.txt immediately.
- Match exact versions rather than minimum versions. Rollback also triggers reload, preserving consistent semantics.
