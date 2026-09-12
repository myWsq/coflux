# Plan 043: Standalone relay service, part one - crates/relay binary + dial-on-demand rendezvous

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier. Stop on any STOP condition. When complete, update
> this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 607cef3..HEAD -- crates/ apps/server/src/ packages/protocol/ packages/client/ proto/ tests/src/ docs/architecture.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none (preceding plans 036–042 are all DONE)
- Category: feature
- Execution: self
- Planned at: `607cef3`, 2026-07-25

## Requirement

The Device relay data plane currently shares both control WebSockets rather than using separate connections. The client sends `deviceRelayFrame` through `sendControl` (`packages/client/src/device-router.ts:581-647`), while daemon traffic shares the single daemon→server WS (`crates/worker/src/main.rs:937-960`). Every remote client↔daemon byte therefore detours through the center in prod-jp, adding 150–250ms typing RTT for CN↔CN traffic.

After this part is complete:

1. Add `crates/relay`: a standalone Rust binary that pairs connections and forwards bytes without parsing DeviceEnvelope, deployable independently of the center.
2. Relay data frames leave the central control WebSockets. Client and daemon each establish a dedicated WS per channel with relay; the center handles only rendezvous: ownership checks, short-lived token issuance, and daemon dialing notification.
3. One relay node, colocated with or separate from the center, supports all existing relay semantics: attach/snapshot/input/resize/stop/exec/fs, exactly-once behavior, and direct↔relay fallback/promotion, covered by black-box tests.
4. Multi-node probing/nearest-node selection and multi-location deployment are excluded from this part and belong to part two.

The implementation is incorrect if client relay bytes still travel as `deviceRelayFrame` over `/client` control WS, if the relay parses DeviceEnvelope business oneofs, or if relay requires account-database/Postgres access.

## Decisions & tradeoffs

- **Relay implementation**: add `crates/relay`, a Rust binary using tokio and tokio-tungstenite, to workspace members (`Cargo.toml:6`). Rejected: extracting a TS service from `device-relay.ts`, which requires Node on each VPS and retains little reusable code after removing accountId/memory coupling. The worker already uses `tokio-tungstenite = 0.24 (rustls)` (`crates/worker/Cargo.toml:20`), with cross-compilation infrastructure in `release.yml`.
- **No Device parsing or persistent state**: relay pairs two WebSockets by channelId, forwarding opaque bytes with rate limits. Do not import/decode DeviceEnvelope or connect to a database. Preserve limits from `apps/server/src/device-relay.ts:49-54`: MAX_DEVICE_FRAME_BYTES, 2048 frames/s, 128 MiB/s, total channels, and similar bounds. Without account concepts, per-client/per-daemon limits become per-connection/per-channel plus global limits. Rejected: business authentication at relay; exactly-once, holder, and scope semantics remain end-to-end in worker/sessiond (`device-relay.ts:1-7`).
- **Authenticate with short-lived center-signed ed25519 tokens**: the server holds the signing private key and relay only public keys, injected through env like `COFLUX_WORKER_PUBKEY` (see AGENTS.md signature acceptance). Tokens bind {channelId, role(client|daemon), daemonId, transportGeneration, exp}, with TTL ≤60s and single use; reject a second arrival for the same channelId+role. Node `crypto` interoperates with `ed25519-dalek` using raw 32-byte public keys and 64-byte signatures, already verified in this repository. The server key comes from `COFLUX_RELAY_SIGNING_KEY`, otherwise generate/persist it to DB/file using the server’s existing key-management conventions; never print it. Rejected: relay calling the center to verify tokens, adding a dependency and RTT contrary to the stateless design.
- **One WS per channel, with channelId+token in the URL** (approved direction): connection performs authentication; disconnect closes the channel. No multiplexing frame protocol. Tokens are single-use with TTL ≤60s to limit URL exposure; neither relay logs nor documented Caddy configuration may log query strings. Rejected: multiplexing channels over one connection, which reintroduces frame headers and per-channel flow control that this change removes.
- **Rendezvous dials on demand without permanent connections**: the client opens through `/client` control WS. After checking authentication, IDs, protocol version, daemon online state, account ownership, and channel quota (`device-relay.ts:70-87`), the server returns {relayUrl, token}. It pushes {relayUrl, token, channelId, accountId, clientInstanceId, transportGeneration, scopes} over daemon control WS, preserving server-issued scopes (`device-relay.ts:106`). Both sides dial relay and forward once paired. Channel disconnect triggers fresh client rendezvous through existing route recovery. Rejected: permanent DERP-style home relay connections, adding connection/lease management (see center-clock-lease experience) merely to save a nearby WS handshake.
- **Remove the old control-WS relay path in the same version** (open-item decision): delete `DeviceRelayClientOpen/DeviceRelayDaemonOpen/DeviceRelayFrame/DeviceRelayClose/DeviceRelayStatus` from client/daemon control protocols, marking names and field numbers `reserved` (`proto/coflux/v1/device.proto:175-207` and their client/daemon references). Add rendezvous replacements. Plan 033’s build-version admission rejects old bundles, so no dual-path transition is needed. Mobile follows the shared `packages/client` change with no new mobile behavior. Rejected: maintaining both paths, recreating the dual-semantics debt just removed by plans 036–041.
- **Deploy relay independently; embed no server data plane** (user revision during execution, 2026-07-25): production relay gets its own host/domain instead of being a colocated companion. Delete `apps/server/src/device-relay.ts` entirely. The server configures only `COFLUX_RELAY_URL` for the external relay—one node/URL in this part, a list in part two. Relay has no center connection; signing keys are the only coupling. Dev/harness spawns the binary as test topology independently of production layout. Rejected: an equivalent TS endpoint embedded in server, producing two drifting implementations.
- **No P2P/WebRTC or nearest-node selection**: record only a line in `docs/ROADMAP.md`. P2P will layer over relay, which remains the baseline; multi-node selection belongs to part two.
- **Keep both protocol sides consistent**: generate `proto/` changes through buf into `packages/protocol/src/gen` and `crates/protocol/src/gen` (`proto/buf.gen.yaml:4-9`). Preserve the recorded internally tagged `type`/camelCase wire convention, and update `crates/protocol` wire tests (`wire_tests.rs`) for new messages.

## Direction

Data flow (new):

```text
client ── /client control WS ──▶ server: rendezvous (validate + sign token + notify daemon)
client ── wss://relay/…channelId+token ──▶ relay ◀── wss dial ── worker
              (one WS per channel, frames = end-to-end DeviceEnvelope bytes, relay performs zero parsing)
```

### Milestone 1: Agreement contract + relay binary

Add rendezvous request/grant/dial notifications, delete and reserve the five old messages, and regenerate both protocol sides. The `crates/relay` executable supports env/flag port configuration, including port 0 with its actual port observable by the harness, signature verification, channelId pairing, bidirectional forwarding, rate limiting, and half-open cleanup for one-sided arrivals, expired tokens, and replay. Validation: `cargo build` (including the new crate, no warnings) and `cargo test -p coflux-protocol` exit 0.

### Milestone 2: server rendezvous + worker dialing

Delete `device-relay.ts` and old hub relay branches (`apps/server/src/hub.ts:170,197,254,893-900,1103,1171-1181,1628,1649,1660`), replacing them with rendezvous and token issuance. On dial notification, the worker uses `connect_async` to relay; its frame pump switches from central `to_server` delivery (`crates/worker/src/device.rs:343-388`) to that channel’s relay WS. Preserve `close_relay` behavior on disconnect. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` and `cargo build` exit 0.

### Milestone 3: client dialing + harness access + black-box regression

Change `openRelayTransport` in `packages/client` (`device-router.ts:581-647`) to rendezvous followed by `new WebSocket(relayUrl)`, following `connectDirectTransport` socket lifetime handling. Preserve `channelCovers`, fallback/promotion, and `relayStarted` race semantics. Extend harness `startStack` (`tests/src/harness.mjs:287`) to spawn `target/debug/coflux-relay`, built by pretest, and inject the relay URL and matching signing/verification keys. Migrate all existing relay black-box tests; add at least one negative test rejecting forged/expired tokens without establishing a channel. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` and `pnpm -C tests test` exit 0.

### Milestone 4: Document Convergence

Update `docs/architecture.md` §5.2/§8 for standalone relay/rendezvous. Record P2P and part-two multi-node selection in `docs/ROADMAP.md`. Validation: manually compare documentation with implementation; no command.

## Landmines

- **`packages/client` is shared by web/mobile**: mobile is frozen and relay-only (`AGENTS.md`). It may follow the shared transport change, but do not change `apps/mobile` business code. Verify mobile still builds; fix only compatibility breaks.
- **Relay-only configuration**: `device-router.ts` supports relay-only mobile and direct+relay modes. Relay RPC/LIFECYCLE in `channelCovers` (`device-router.ts:454-461`) depends on `controlOnline`. Preserve semantics when relay WS survives but control WS disconnects: no rendezvous means no new channel; established session-lane survival follows `docs/architecture.md` §8’s failure table.
- **Worker frame pumping has service-mode branches**: `relay_to_server` and `to_server` are separate paths at `crates/worker/src/device.rs:368`, related to hot upgrades/service mode. Understand both before changing the pump; changing just one is insufficient.
- **Do not regress the direct-path benchmark**: `docs/architecture.md` §11 requires zero central `deviceRelayFrame` increase during timed direct traffic. Once that message is deleted, replace the assertion with equivalent black-box evidence that the relay process handles zero frames on the direct path.
- **Port isolation**: black-box test files own exclusive ports (`tests/src/harness.mjs` header). Relay must bind port 0 and expose the actual port to avoid conflicts.
- **`__coflux-` is a reserved channelId prefix** (`device-relay.ts:75`); retain this rejection in rendezvous validation.
- **Zero Warning Discipline**: Any warning for `cargo build` is considered a validation failure (AGENTS.md).

## Scope

In scope:

- `proto/coflux/v1/*.proto` and generated bindings on both sides (`packages/protocol/`, `crates/protocol/`)
- `crates/relay/` (new), `Cargo.toml` (workspace members), `Cargo.lock`
- `crates/worker/src/` (dial + frame pump reconnection)
- `apps/server/src/` (rendezvous, token issuance, removal of device-relay.ts)
- `packages/client/src/` (`openRelayTransport` transformation and its unit test)
- `tests/src/` (harness + relay related use cases + new negative use cases)
- `docs/architecture.md`, `docs/ROADMAP.md`, `plans/README.md`

Out of scope:

- Multi-node nearby detection/selection, relay list delivery - second part
- P2P/WebRTC - ROADMAP records only
- `apps/mobile/` business code - frozen (except for minimal build fixes due to shared layer)
- Production deployment (prod-jp/systemd/Caddy changes for the new VPS): operational execution is separate; this part documents deployment requirements only. Leave CI behavior outside release.yml unchanged; adding relay to the release artifact matrix is allowed.
- `crates/supervisor/` (unless protocol gen is involved in compilation, which is not expected)

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build (zero warnings) | `cargo build` | exit 0, no warnings |
| Rust protocol unit test | `cargo test -p coflux-protocol` | exit 0 |
| server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| client unit test | `pnpm -C packages/client test` (if there is no such script, run the existing equivalent unit test entrance of the repository) | exit 0 |
| black-box integration (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] The commands in the above table are all green.
- [ ] relay data frames no longer traverse `/client` or daemon control WebSockets; the old five messages have been deleted and protobuf `reserved`.
- [ ] `crates/relay` does not rely on DeviceEnvelope decoding and does not rely on DB; forged/expired tokens have negative black-box test cases and are rejected.
- [ ] Existing relay semantic black-box test cases (fallback/promotion, exactly-once, central shutdown performance) all pass under the new path.
- [ ] an equivalent assertion proves that the direct path sends zero relay data frames.
- [ ] Implementation follows all Decisions & tradeoffs entries; no out-of-scope file changes.
- [ ] `plans/README.md` status updated.

## STOP conditions

- Decisions refer to facts that no longer hold true (e.g.`device-relay.ts` has been changed/deleted by others).
- The implementation is forced to touch out-of-scope files (such as `apps/mobile` business code must be changed).
- A verification command failed twice in a row even after a reasonable fix.
- Rendezvous cannot reuse existing control-WS semantics and requires new control connections, invalidating the chosen direction.

## Maintenance notes

- Signing-key rotation and relay public-key synchronization form a new operational boundary: install both public keys before removing the old one. Multiple-key/env support may wait for part two; this part needs only one public key, but documentation must describe rotation order.
- Part two expands rendezvous from one `relayUrl` to a candidate list and RTT reports from both ends. Choose names that avoid unnecessary singular/plural churn without adding unused fields now.
- After relay enters the release matrix, server-token compatibility follows protobuf/field evolution rules rather than adding an independent handshake version.
