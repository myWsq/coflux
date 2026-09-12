# Plan 076: First P2P slice—WebRTC DataChannel as a third transport for web and worker

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 50d8c69..HEAD -- proto/coflux/v1/device.proto crates/protocol crates/worker packages/protocol packages/client apps/server/src/hub.ts tests/src docs/architecture.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none (prerequisites 043 standalone relay and 065 multiple nodes are DONE on main)
- Category: feature
- Execution: self
- Planned at: `50d8c69`, 2026-08-16

## Requirement

Implements the established item at `docs/ROADMAP.md:68`. The user cannot deploy a nearer relay, so 065's multi-node benefit is unavailable. CN↔JP relay hairpin latency is the main pain point. Establish end-to-end WebRTC DataChannels between client and daemon as the second candidate after loopback within the direct slot. Relay remains the fallback for failed hole punching, with unchanged semantics.

After implementation:
- For an online remote device with UDP reachability at both ends (public VPS daemon, same LAN, or successful hole punching), terminal and Device RPC hot paths use DataChannel without a relay node. Sidebar transport text distinguishes P2P from relay.
- Any failure—unreachable ICE, signaling timeout, or interrupted DataChannel—automatically falls back to relay without user intervention. Recovery promotes P2P through existing transport-generation promotion.
- DeviceEnvelope frames up to the 30MB limit (`fs.write` uploads) cross DataChannel intact.
- No supervisor or loopback gateway/grant changes. P2P lives entirely in worker and reaches production through hot upgrades.

P2P is **pure transport**. Do not alter session semantics: holder/inputSeq/mutation ledger/output sequence remain transport-independent (`docs/architecture.md:134-141`). Reuse center authorization semantics from relay rendezvous rather than creating a new authorization system. Do not make P2P a third competitor alongside direct/relay; include it within the direct slot.

Document expectations without promising a hole-punching success rate: public-VPS daemons should nearly always connect; successful CN↔CN punching keeps traffic inside China, avoiding the hairpin and GFW, with the largest benefit. GFW interference on cross-border routes affects P2P and relay alike; P2P does not solve GFW issues. Symmetric NAT/CGNAT failure falls back to relay without loss of functionality.

## Decisions & tradeoffs

- **Router: P2P joins the direct slot, not a third competitor.** Internal priority is loopback > P2P. Reuse direct-vs-relay racing, 200ms hedge, and generation promotion unchanged.
  Rejected: a third adapter method, openP2p, would require rewriting race/promotion state machines for no benefit.
  Based on: only openDirect/openRelay at `packages/client/src/device-router.ts:115-122`; hedge structure at `:974-991`.
- **Signaling follows plan 043's rendezvous triangle over center control WS.** Add P2P request/response messages: client→server request with SDP offer; server→daemon offer with account/scopes; daemon→server→client SDP answer. Center validates ownership, grants scopes, and forwards; daemon trusts the control plane as with `DeviceRelayDial`. Center signs no token: P2P crosses no center infrastructure. Authenticated control-WS signaling plus SDP-bound DTLS fingerprints establish identity, following standard WebRTC security.
  Rejected: relay tokens, because P2P has no intermediary to verify them. Based on: `proto/coflux/v1/device.proto:184-211`.
- **Vanilla ICE, without trickle.** Each side waits for gathering to finish and exchanges complete SDP once, requiring one request/response. Relay-first plus promotion masks the 1–3s setup delay.
  Rejected: trickle turns signaling into multiple bidirectional messages, roughly doubling center forwarding complexity for a setup improvement users cannot perceive with promotion. Revisit if setup is slower than expected.
- **Worker uses crates.io `webrtc` from webrtc-rs, latest stable at execution time.** It supplies ICE/DTLS/SCTP/DataChannel, native tokio support, and browser-like APIs.
  Rejected: str0m is sans-IO and requires manually pumping DataChannel I/O; node-datachannel/libdatachannel bindings add cross-language native dependencies inconsistent with the all-Rust daemon.
- **Keep one PeerConnection per daemon while its route has full demand; use one DataChannel per logical channel.**
  Rejected: per-channel PeerConnection repeats 1–3s ICE/DTLS setup; relay-style zero residency tears down expensive connections and punches again on each lane switch. Measurement-only routes, such as sidebar readings, must not establish PeerConnections; preserve the non-full-demand relay-only shortcut.
  Based on: routeHasFullDemand shortcut at `device-router.ts:964-972`.
- **Worker closes all P2P connections when center disconnects, matching relay.** Center rendezvous supplies online authorization; disconnection removes that authority.
  Rejected: P2P surviving center disconnect would require extending loopback offline grants to P2P, a separate plan.
  Based on: disconnect convergence in `crates/worker/src/relay_dial.rs:1-6`; `docs/architecture.md:108-109`.
- **Framing: DataChannel messages form a length-prefixed chunk stream.** DeviceEnvelope allows 30MB (`crates/protocol/src/lib.rs:62`), while Chrome receives at most 256KB per DataChannel message, so fragmentation is mandatory. Use a 4-byte big-endian length prefix and fixed safe chunks ≤64KB. Reliable, ordered SCTP acts as a byte stream; receivers reassemble by prefix. Put chunk/format constants in TS `packages/protocol` and Rust `crates/protocol`; implement framing separately in each language. Senders must apply bufferedAmount backpressure through bufferedAmountLowThreshold events or polling; never dump 30MB into SCTP buffers at once.
  Rejected: negotiating a larger SCTP max-message-size cannot bypass Chrome's advertised hard 256KB limit.
- **Center configures STUN with `COFLUX_STUN_URLS` and sends it to both ends through the control plane. Default empty means host candidates only.** Public VPS and same-LAN scenarios already work without STUN: the VPS host candidate is public and the client can initiate outbound connectivity checks. STUN improves cross-NAT punching. Document self-hosted coturn in stun-only mode on owo-jp-gw; the user performs deployment under normal practice, and it does not block acceptance. No TURN: coflux relay is the fallback.
  Rejected: hardcoded public STUN, because Google STUN is unreachable in mainland China and third parties are uncontrolled.
- **Use werift, pure TS WebRTC, as the black-box client peer in tests devDependencies.** Exercise cross-stack interoperability with webrtc-rs through signaling, connection, framing, fallback, and promotion. If interoperability has a compatibility problem that cannot be reasonably repaired after two attempts, downgrade black-box coverage to signaling-forwarding correctness, P2P-failure fallback to relay, and worker answer generation. Leave DataChannel data-plane verification to a real-browser walkthrough performed by the user, and record the downgrade in the plan status.
  Rejected: node-datachannel brings native dependencies into CI.
- **No mobile or iOS changes.** Mobile is frozen and relay-only: disabled `enableLocalTransport` never enters the direct slot, so P2P stays disabled. Swift iOS requires WebRTC.framework and a separate project.
  Based on: `docs/architecture.md:131-132`.
- **(Decided while planning) Inject client RTCPeerConnection through the router's existing narrow boundary.** `device-router.ts:112` describes the test philosophy: production uses global objects; unit tests inject in-memory implementations. Follow it rather than adding Node polyfill branches to production.

## Direction

Client is the offerer. createDataChannel triggers setup; wait for gathering, then send offer through control WS. Center checks daemon ownership, attaches account/scopes, and forwards. Worker creates PeerConnection, gathers, and returns answer along the same route. ICE/DTLS connects. Each logical channel sends framed DeviceEnvelope over its DataChannel. Worker pumps these through `DeviceRuntime`, matching relay open/close/handle_frame semantics and `CHANNEL_QUEUE_BYTES` backpressure (`crates/worker/src/device.rs:28`).

### Milestone 1: Protocol contract

Add P2P signaling proto messages, preserving `buf breaking` compatibility and 043's reserved-field discipline. Add framing constants to TS/Rust protocol packages; all three generated outputs must be reproducible without diff.
Validation: `buf lint`, `buf generate`, and clean generated directories in `git status`; then `cargo build -p coflux-protocol` and `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exit 0.

### Milestone 2: Worker P2P stack

Introduce webrtc-rs and a module following `relay_dial.rs`: spawn per connection, pump outgoing ChannelReceiver, route incoming frames through DeviceRuntime, and converge on disconnect. Generate answers, implement framed sends/receives with backpressure, and close all P2P on control-WS loss. Rust framing tests cover splitting/reassembly above 256KB and malformed-prefix rejection.
Validation: `cargo build -p coflux-supervisor -p coflux-worker` with zero warnings; `cargo test -p coflux-worker` exits 0.

### Milestone 3: Server signaling

hub.ts forwards offers/answers, reuses rendezvous ownership validation and `DeviceRelayDial` scope grants, parses `COFLUX_STUN_URLS`, and sends configuration to both peers.
Validation: server tsc --noEmit exits 0; M5 covers behavior.

### Milestone 4: Client P2P transport

Within the direct slot, try P2P when loopback fails or has no grant; loopback still requires a grant and same-machine reachability. Add framing and transport labels consistent with existing sidebar direct/relay wording; validate reused promotion. Update comments and shortcuts assuming direct means loopback/same-machine around `device-router.ts:964-966`, `:1228`, and `:1896`.
Validation: `pnpm -C packages/client test`, or `node --test` on the relevant unit test if no script exists; web/client tsc --noEmit exits 0.

### Milestone 5: End-to-end black-box tests

Add a test file with an exclusive port under existing `tests/src` conventions. A werift peer exercises signaling, connection, frame transfer, >256KB fragmentation/reassembly, fallback after P2P loss, and relay-first promotion to P2P. Negative verification must fail when server forwarding is removed.
Validation: `node --test tests/src/<new-file>` exits 0, then full `pnpm -C tests test` is no worse than baseline; the two known cli-doctor environment failures remain excluded.

### Milestone 6: Documentation

Add P2P to DeviceTransport in `docs/architecture.md`, including expectations and the GFW limitation. Document STUN/coturn deployment and `COFLUX_STUN_URLS` in its deployment section or a separate docs file. Update `docs/ROADMAP.md:68`.
Validation: manual reading, no command.

## Landmines

- **Cross-compilation**: daemon releases use `Cross.toml`. webrtc-rs crypto dependencies, including ring, must compile for every release target. Plan 065 already encountered tokio-rustls defaults pulling in aws-lc. Run release-target cross builds **early** after adding dependencies. Failure triggers STOP and reconsideration of features or stack.
- **Chrome's advertised SCTP receive limit is hard**: sending above the peer SDP max-message-size from webrtc-rs silently closes the channel. Use safe chunks ≤64KB; do not rely on negotiating a larger value.
- **Chrome vanilla ICE**: wait for `icegatheringstatechange === 'complete'` before reading localDescription. Empty ICE servers complete immediately; unreachable STUN waits for timeout. Client signaling timeout must cover that worst case.
- **Same-machine assumptions** are scattered in router comments/shortcuts at `device-router.ts:964-966`, `:1228`, and `:1896`. Missing one may prevent P2P attempts for remote devices. Preserve the measurement-only route shortcut, or sidebar readings create PeerConnections for every device.
- **Black-box independence**: `tests/src/device-harness.mjs:1-6` intentionally imports no application code. The werift peer must likewise use the protobuf source of truth and its own inline framing implementation, never `packages/client` framing, to avoid shared defects.
- **Worker pump backpressure**: `CHANNEL_QUEUE_BYTES = MAX_DEVICE_FRAME_BYTES + 2MB` at `device.rs:28` is existing channel behavior; incoming P2P must not bypass it. Gate outgoing 30MB frames with bufferedAmount to avoid unbounded SCTP memory.
- **Test PG/Docker**: widespread timeouts can mean OrbStack/Docker is unhealthy; check whether `docker ps` hangs before treating them as regressions. Local black-box PG uses 5432.

## Scope

In scope:
- `proto/coflux/v1/device.proto`, generated `proto/gen/**`, `packages/protocol/src`, and `crates/protocol/src`
- `crates/worker/src/**`: new P2P module, device.rs pumps, main.rs wiring
- `Cargo.toml` / `Cargo.lock` for webrtc-rs
- `apps/server/src/hub.ts` and small related server wiring files for signaling/STUN
- `packages/client/src/device-router.ts` and unit tests
- `apps/web` only where sidebar consumes transport labels, if needed
- `tests/src/` and werift devDependency in `tests/package.json`
- `docs/architecture.md`, `docs/ROADMAP.md`, `plans/README.md`

Out of scope:
- `crates/supervisor/**`: preserve the no-supervisor-change rule
- `crates/relay/**` and 065 multi-node release: unchanged relay semantics
- Frozen `apps/mobile/**` and Swift iOS, which needs a separate project
- loopback gateway/grant/local_auth: P2P does not use loopback authorization
- trickle ICE, P2P surviving center loss, TURN: later iterations
- Actual STUN deployment on owo-jp-gw: documentation is included; user performs operations

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto contract | `buf lint && buf generate`, then clean generated directories | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Rust unit tests | `cargo test -p coflux-worker -p coflux-protocol` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Full black-box acceptance | `pnpm -C tests test` | No worse than baseline; two known cli-doctor environment failures |
| Cross-build spot check | Cross-build a release target; see `Cross.toml` / RELEASING | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] New black-box tests cover P2P connection/transfer, >256KB reassembly, fallback, and relay→P2P promotion; removing server forwarding makes them fail.
- [ ] With loopback disabled in the same-machine black-box environment (no grant/occupied port), transport becomes P2P rather than relay.
- [ ] End-to-end behavior works with `COFLUX_STUN_URLS` unset, using host candidates only.
- [ ] No diff in supervisor, relay, mobile, or loopback authorization.
- [ ] Implementation follows every decision, including recording the werift downgrade if triggered.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- webrtc-rs fails to cross-compile on any release target with no low-cost feature fix.
- werift interoperability fails **and** the downgraded three-part black-box coverage cannot prove signaling/fallback correctness.
- P2P requires supervisor or loopback authorization changes.
- A code fact cited in Decisions & tradeoffs no longer holds.
- A validation command still fails twice consecutively after one reasonable fix.

## Maintenance notes

- P2P and relay share online-center authorization. Future P2P survival across center loss should extend loopback offline grants, not patch rendezvous semantics.
- Once released, chunk size/framing is a live contract across mixed worker/web versions. Format changes require version negotiation; warn beside protocol constants.
- Record measured production hole-punching success in docs. If CN↔CN success is below expectations, next consider trickle ICE and stronger srflx support, not TURN.
