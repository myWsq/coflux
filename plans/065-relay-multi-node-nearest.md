# Plan 065: Multi-node relay—center supplies nodes, daemon chooses home, rendezvous follows it

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat bd88f86..HEAD -- crates/relay/ crates/worker/ apps/server/src/ proto/coflux/v1/daemon.proto tests/src/ docs/architecture.md`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none (the first standalone-relay slice, 043, is DONE)
- Category: feature
- Execution: agent:codex
- Planned at: `bd88f86`, 2026-07-29

## Requirement

Plan 043 separated relay into a standalone binary, but production has one COFLUX_RELAY_URL (config.ts:79), causing detours for geographically distributed use. Adopt a Tailscale home-DERP-like model:

1. Center sends static relay list after daemon authentication.
2. Daemon measures HTTPS RTT, selects/reports nearest home, probes periodically and immediately after dial failure.
3. Rendezvous sends both peers to daemon home; without report use first node. A channel's peers must share node because pairing is by channelId with no mesh.
4. Client/Web/iOS remain unchanged, consuming one relay_url.

Client probing/list delivery, candidate-array grants, inter-relay forwarding, or DB node records are wrong directions. Existing single COFLUX_RELAY_URL behavior must remain identical.

## Decisions & tradeoffs

- **Daemon home selection**. Two-sided probing/center arbitration from 043:223 complicates browser/iOS timing/cache for little benefit when relay near daemon keeps total path near direct distance. Mesh adds hop/state/topology. Relay currently pairs two WS by channelId only.
- **COFLUX_RELAY_NODES JSON [{id,url}]**, stable short IDs and external wss bases. If unset, synthesize one node from COFLUX_RELAY_URL, including dev ws://127.0.0.1:8790. First node is documented primary fallback. No DB/admin UI for single-digit personal nodes, nor self-registration that breaks relay's independence from center (architecture:112-114).
- **Add /healthz; timed HTTPS GET**. Probe multiple times, compare medians; switch only with meaningful hysteresis, suggested ≥20ms and ≥20%, executor chooses. Minute-scale periodic probes plus immediate dial-failure probe. TCP alone mistakes live Caddy/dead relay for healthy; invalid pipe handshakes create noisy error-based health checks. Existing relay recognizes only /v1/pipe at main.rs:205.
- **Probe-driven failover; one URL**. DeviceRelayDial/Grant unchanged (device.proto:180-205). On home failure, daemon probes/reports new home and next rendezvous follows; window roughly probe interval, clients may retry meanwhile. Candidate lists would require three-sided consistent selection logic for a rare failure.
- **Existing daemon control WS** adds server list and daemon home-report oneofs. Send once after auth; config changes require center restart, naturally refreshing all reconnects. Report home ID, optionally node RTT for logs/display; re-report after reconnect. Store in DaemonConn memory (hub:96-101), no DB. Envelopes daemon.proto:88,216; registerDaemonConn hub:248.
- **Old-worker fallback**: no report means first node. Verify prost unknown-oneof ignore behavior; if disconnecting, gate by version using supportsRelayDial precedent in relay-rendezvous.ts.
- **Shared keys across nodes**: same COFLUX_RELAY_PUBKEY and one center signing seed; tokens not node-bound. Short TTL≤120s and channelId binding make per-node isolation unhelpful while multiplying rotation work. config signing comment/relay main.rs:133.
- **Rustls-only worker HTTP**, no OpenSSL for Cross.toml release portability. Minimal reqwest-rustls or handwritten GET, executor chooses. Existing WS uses tokio-tungstenite rustls, no HTTP client.
- **Derive health URL** by ws/wss→http/https plus /healthz, no extra setting; production Caddy provides same-origin TLS termination.

## Direction

Center parses list→authenticated daemon receives/probes/reports→center stores presence→rendezvous gives both peers home URL.

### Milestone 1: Health

Plain HTTP GET /healthz returns 200 behind Caddy TLS; pipe behavior unchanged. cargo test -p coflux-relay passes with health/pipe regression.

### Milestone 2: Proto/center

Add two daemon messages/generate outputs, parse list/fallback, send after auth, accept home presence, route grants. Server build and relay-token/relay-dial-version tests pass.

### Milestone 3: Worker

Probe medians/hysteresis/periodic and dial-failure triggers, report chosen home. Empty list/all probes fail means no report and center fallback. Worker test/build pass.

### Milestone 4: Black-box/docs

Two-node test proves both rendezvous URLs match reported home; killing home changes report/next rendezvous to survivor; old-worker/no-report uses first. Document multi-VPS relay binary+Caddy+shared key and COFLUX_RELAY_NODES. relay-multi-node.test.mjs passes; executor may rename and record actual path.

## Landmines

- Ordinary HTTP is not WS Upgrade. Recognize /healthz before tungstenite accept, e.g. peek/parse first line; handshake callback alone (:199-206) is insufficient.
- Preserve token TTL≤120s within relay tombstone window; no TTL changes.
- Measure old-worker unknown payload, gate if needed.
- Keep pnpm dev:relay single 127.0.0.1:8790. Harness starts second instance using device-harness pattern; do not alter dev semantics.
- Regenerate/commit all tracked outputs after daemon.proto, including Swift; iOS does not consume daemon messages but stale outputs fail drift checks.

## Scope

In scope: relay health; worker list/probes/report/minimal rustls dependency; server config/hub/rendezvous; daemon.proto/generated outputs; relay tests; architecture/README.

Out of scope: client/Web/mobile/iOS; DeviceRelayDial/Grant semantics; relay mesh/P2P; DB; actual multi-region VPS/DNS operations, performed by user from docs.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust | `cargo build --workspace && cargo test -p coflux-relay -p coflux-worker` | exit 0 |
| Server | `pnpm --filter @coflux/server build` | exit 0 |
| Relay black-box | `cd tests && node --import tsx --test src/relay-*.test.mjs` | exit 0 |
| Full acceptance | `pnpm --dir tests test` | exit 0; known flaky baseline in 059 status |

## Done criteria

- [ ] All listed commands pass.
- [ ] Two-node black-box tests prove both rendezvous URLs use the daemon-reported home, killing home triggers automatic failover, and missing reports fall back to the first entry.
- [ ] Configuring only COFLUX_RELAY_URL without NODES behaves exactly as bd88f86.
- [ ] No client/web/iOS files changed.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited fact changes, excluded edits required, validation fails twice after one reasonable fix.
- Old workers disconnect on new payload and version gate cannot support deployed fleet.

## Maintenance notes

- Change center list/restart to update nodes; daemons reconnect/reprobe. Keep IDs stable for reports/logs.
- First node should be most reliable fallback.
- Follow 043 dual-public-key rotation, rolling nodes individually.
- If minute-scale recovery becomes too slow, revisit the rejected candidate-list approach explicitly.

Milestone validations retain `cd tests && node --import tsx --test src/relay-token.test.mjs src/relay-dial-version.test.mjs`, `cargo test -p coflux-worker && cargo build -p coflux-worker`, and `cd tests && node --import tsx --test src/relay-multi-node.test.mjs`.

### Original source references

`apps/server/src/config.ts:79`, `docs/architecture.md:112-114`, `crates/relay/src/main.rs:205`, `proto/coflux/v1/device.proto:180-205`, `apps/server/src/hub.ts:96-101`, `proto/coflux/v1/daemon.proto:88,216`, `crates/relay/src/main.rs:133`, `crates/relay/src/main.rs:199-206`, `package.json:12`.
