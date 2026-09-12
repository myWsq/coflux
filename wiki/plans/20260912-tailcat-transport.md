# Plan 20260912-tailcat-transport: Replace custom remote networking with Tailcat

> This plan is an outcome contract, not a step-by-step script. Design against
> the live code and preserve the decisions below. Validate feasibility before
> retiring the existing transport. Stop on a STOP condition; do not turn a
> successful loopback demonstration into a production-readiness claim.
>
> Drift check: `git diff --stat 67b5175..HEAD -- AGENTS.md Cargo.toml Cargo.lock apps packages crates proto scripts tests .github Dockerfile docs wiki/plans`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none. The in-progress unified release plan shares packaging paths; recheck its landed changes before implementation.
- Category: migration
- Execution: subagent — use the host default implementation agent; the primary agent performs review and all validation.
- Stop after: implementation — the user explicitly requested continued implementation and verification after the plan and terminal move.
- Workspace: isolated — `/Users/wsq/.coflux/worktrees/b4ccca3f-d348-414a-8291-7147ba79de2a`, branch `dev/20260912-tailcat-transport`.
- Planned at: `67b51751c0e33e5742312975d9876dd83cbd0664`, 2026-09-12.
- Planning checks: source inspection only; no implementation, builds, dependency installation, network benchmark, or deployment performed. The prescribed `dev:advisor` model (`fable`) is unavailable in this host; no advisor review is claimed.

## Requirement

Coflux currently maintains WebRTC negotiation, peer discovery, direct/relay
competition, and a custom relay service. Replace remote network transport with
Tailcat's WireGuard/magicsock/DERP stack while retaining Coflux's account model,
authorization, device operations, and terminal session authority.

The user explicitly chose self-hosted DERP: the goal is to stop developing the
network stack, not to eliminate relay hosting. The user also explicitly relaxed
the pure-Rust daemon constraint to permit a bundled Go networking helper.

The release target for this work is the existing macOS desktop and Linux/headless
device path. Users still install Coflux, sign in, and select their devices. They
do not install Tailscale, create a tailnet, share Tailcat addresses manually, or
install Go. Local work remains usable through the existing loopback grant path.
Remote terminal input, history, resize, file operations, and permission errors
retain their current semantics. Connection diagnostics describe the measured
direct/relayed path; a local IPC connection must never be displayed as a direct
remote path. No new networking settings screen is required.

Completeness means a validated replacement for the supported release surface,
including delivery and recovery. A helper binary, TCP echo, or feature flag by
itself is not completion. Production deployment and removal of live relay nodes
are separate actions, not authorized by this plan.

## Decisions & tradeoffs

1. **Use Tailcat as a library behind a narrow native helper.** Create a small Go
   module at `transport/tailcat/`, producing `coflux-transport`. Rust retains PTYs
   and business logic; Electron's main process owns the desktop client helper.
   Rejected: reimplementing magicsock in Rust, embedding Tailcat WASM in the
   renderer, or parsing human-facing CLI output. WASM currently cannot establish
   direct paths. Based on the user's accepted Go-process tradeoff and upstream
   [README](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/README.md#tailcat).
   The helper exposes only transport operations, never Tailcat's shell, file
   serving, exit-node, arbitrary proxy, or subnet-routing features.

2. **Self-host stock DERP; retain Coflux coordination.** Both endpoints receive a
   Coflux-controlled DERP map or embedded region descriptor. Normal operation
   must not fall back to public Tailcat relays or fetch their map. Initial
   discovery still needs a reachable DERP bootstrap endpoint; P2P does not remove
   this dependency. Rejected: Tailscale account/control-plane integration and
   reliance on free public relay uptime. Based on the user's hosting choice and
   upstream [custom DERP support and stability statement](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/README.md#bring-your-own-derp-relay).

3. **Preserve the DeviceEnvelope/session boundary.** A remote route becomes one
   reliable, ordered Tailcat stream abstraction; direct UDP versus DERP is a
   path property inside that abstraction. Keep local-versus-remote route choice,
   cancellation, bounded queues, heartbeats, logical client identity, generation,
   input acknowledgments, and operation deduplication in Coflux. Rejected:
   replacing sessiond or treating a network switch as a new terminal session.
   Based on `packages/client/src/device-router.ts:118`, `:373`,
   `crates/worker/src/device.rs:933`, and `docs/architecture.md:104`.

4. **Transport reachability does not grant business access.** Only the central
   authenticated session can authorize an account/client/device/channel/scope
   tuple. Before admitting DeviceEnvelope frames, the worker verifies a short-
   lived channel grant and proof of the client identity to which it is bound.
   Use a fresh challenge or an equivalent replay-resistant binding; a channel ID
   or client-supplied identity alone is insufficient. Tailcat addresses and PSKs
   are secrets, excluded from logs, URLs, process arguments, telemetry, and
   renderer persistence. Do not forward remote connections through the local
   gateway and accidentally acquire its offline grants. Based on
   `crates/worker/src/device.rs:964`, `crates/worker/src/gateway.rs:1`, and
   upstream [address semantics](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/README.md#tailcat-addresses).
   Exact grant encoding and proof protocol are executor decisions, documented
  and tested before either endpoint relies on them. They must not require an
  undocumented conversion from Tailcat's synthetic IPv6 address to peer identity.
  Register endpoint node public keys through authenticated Coflux control before
  DERP admission is needed; generate keys before starting the tunnel so relay
  admission and tunnel startup do not depend circularly on each other.

5. **Retain existing revocation semantics.** Worker control disconnect closes
   authorized remote channels immediately. A client control transport outage
   stops new grants and elevated operations immediately and preserves only
   existing session lanes for the existing bounded 15-second grace period.
   Logout, changed credentials, hard rejection, or grace expiry closes those
   lanes. A healthy WireGuard tunnel cannot extend a Coflux authorization.
   Based on `crates/worker/src/main.rs:1181` and
   `packages/client/src/device-router.ts:2649`. Do not implement account removal
   merely by deleting a Tailcat allowlist entry while old streams remain usable.

6. **Isolate helper lifetime from PTY lifetime.** The worker owns its serving
   helper; desktop main owns its client helper. Helpers exit on owner loss,
   have bounded restart/backoff, and cannot leave stale IPC endpoints or children.
   Application update/restart may reconnect networking but must not restart
   sessiond. A worker/helper fault cannot prevent local PTY readers from draining.
   Reuse a helper across terminal tabs; do not spawn a process per terminal.
   Based on `apps/desktop/src/main/desktop-runtime.ts:115` and
   `docs/hot-upgrade-design.md:11`. IPC serialization is left to the executor,
   subject to version negotiation, authenticated/private endpoints, frame limits,
   multiplexed channel ownership, cancellation, and backpressure.

7. **Deliver and roll back worker/helper as a compatible unit.** The helper is
   a versioned, signed release component with the same trust and artifact-integrity
   guarantees as the worker. Verify all required components before activation;
   activate or roll back a matching pair, including after process/host interruption.
   Resolve the helper from verified version directories, never ambient PATH or an
   unverified runtime download. Desktop content identity includes helper bytes.
   Reject a candidate that lacks a compatible helper while retaining the active
   runtime and PTYs. If an old supervisor cannot support the new artifact format,
   stage the required supervisor upgrade through the existing explicit restart
   lifecycle; never silently restart live terminals. Based on
   `crates/supervisor/src/upgrade.rs:300`,
   `apps/desktop/src/main/desktop-runtime.ts:78`, and
   `apps/desktop/scripts/stage-daemon.mjs:25`.

8. **Retire the old supported remote path after acceptance.** Temporary
   coexistence is allowed only while validating this migration. The final desktop
   and worker implementation must not continue racing WebRTC, custom relay, and
   Tailcat. Reserve obsolete protobuf numbers and update generated consumers;
   never reuse wire tags. Negotiate actual transport capability and reject
   incompatible peers explicitly instead of returning a Tailcat address in a
   legacy relay URL field. Preserve stable DeviceEnvelope semantics independently
   of control-plane admission. Based on `proto/coflux/v1/device.proto:180`,
   `packages/protocol/src/index.ts:45`, and
   `apps/server/src/relay-rendezvous.ts:60`.

9. **Pin the candidate and make promotion evidence-driven (decided while planning).**
   Evaluate upstream commit `91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a`; record its
   exact module version/checksums and transitive versions during implementation.
   Do not use `@latest` in release builds or silently downgrade to remove a build
   error. Upstream's Go requirement is 1.27.1; the planning host has 1.26.6, and
   the 1.27.1 darwin/arm64 toolchain metadata is available from the Go proxy.
   Buildability is not yet verified. Retain BSD notices and audit bundled
   dependency licenses. Based on upstream
   [go.mod](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/go.mod),
   [LICENSE](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/LICENSE),
  and [experimental threat model](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/SECURITY.md).
  The 30-second controlled recovery and 20% paired latency-regression limits
  below are initial engineering acceptance budgets chosen while planning, not
  existing product promises or observed Tailcat results.

## Direction

One serial workstream: these milestones share protocol, lifecycle, and delivery
contracts. Do not split implementation into independent writers before those
contracts exist. Milestone checks are local/in-process; process, container, UI,
and real-network tests belong to the final acceptance tier below.

### Milestone 1: A bounded native transport contract

The pinned Go module builds a helper with a versioned IPC contract. It can serve
and dial only authorized Coflux channels over private local IPC, transports
bounded length-framed bytes without changing DeviceEnvelope, and exposes truthful
connection/path status. Document owner loss, malformed IPC, oversized frames,
queue exhaustion, stream EOF, partial writes, and cancellation. A coordinator
must never pass a Tailcat bearer address to a shell command.

Validation: `go -C transport/tailcat test ./internal/...` passes deterministic IPC,
lifetime, bounds, and authorization tests; `go -C transport/tailcat build ./...`
passes. Keep networked integration tests outside this unit-test command.

### Milestone 2: Coflux remote channels use the new contract

Depends on milestone 1. Server discovery/grants, Rust worker channel admission,
Electron main/preload, and shared client routing implement the same contract.
Local offline grants remain independent. Network path changes preserve logical
session identity; actual connection loss reattaches with the normal recovery
ledger. DERP descriptors are validated and can be refreshed by the worker and
control plane after a region failure; the adapter must not assume automatic
cross-region failover in Tailcat. The renderer receives only scoped transport
handles/status, not arbitrary native networking or private keys.

Validation: server/desktop typechecks, shared client/router tests, and relevant
Rust unit tests pass. New tests cover wrong-account/wrong-device grants, expiry,
replay, revocation, stale generation, helper loss, and bounded backpressure.

### Milestone 3: Self-hosting and signed delivery are complete

Depends on milestones 1 and 2. All existing release targets receive the helper;
desktop staging, npm/headless installation, runtime identity, signature checks,
activation, observation, and rollback agree on the component set. No runtime Go
toolchain is required. Document stock DERP provisioning, TLS, UDP/STUN access,
admission, map configuration, diagnostics, and failure recovery without changing
production machines. DERP admission uses standard upstream mechanisms, not a
fork of its byte-forwarding protocol. Keep packet relay authorization distinct
from the Coflux application channel grant.

Validation: release/installer and desktop packaging unit tests reject missing,
tampered, wrong-target, mismatched-version, and incomplete component sets. Rust
builds produce zero warnings. Test fixtures represent both pre-migration and new
runtime layouts.

### Milestone 4: Accepted replacement and legacy retirement

Depends on milestones 1–3. Complete code review, then all acceptance below before
enabling the replacement by default and removing old active network code. Delete
or adapt transport-specific tests while retaining equivalent session, auth,
malformed-input, and recovery coverage. Update architecture and contributor docs
to describe the mixed Rust/Go runtime accurately. Publish evidence in
`wiki/plans/20260912-tailcat-transport-evidence.md`; missing real-network evidence
leaves this milestone incomplete, not implicitly passed.

Validation: the final unit/type/build set still passes after legacy removal;
source inspection finds no active WebRTC/custom-relay fallback in supported
desktop/worker runtime or its release artifacts. Historical documents and
reserved wire fields are not active implementations.

## Landmines

- **One region at startup is not fleet failover.** Tailcat's `Server.RegionID`
  selects at Start and its backend stores the selected region. Coflux currently
  reprobes and changes its home relay after failure (`docs/architecture.md:126`).
  Existing direct connections, initial bootstrap failure, reconnect to the same
  region, and replacement of a failed region are separate acceptance cases.
  Upstream evidence: [tailcat.go:423](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/tailcat.go#L423)
  and [tailcat.go:583](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/tailcat.go#L583).
- **Tailcat allowlists are not the grant/revocation API.** Empty `AllowedClients`
  permits any client, and `AddAllowedClient` is additive. Do not invent an
  upstream per-client removal API or infer peer identity from a claimed IPC field.
  [tailcat.go:441](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/tailcat.go#L441).
- **Relay admission defaults need deliberate configuration.** Stock derper has
  `--verify-client-url`, whereas `--verify-clients` depends on local tailscaled.
  URL-verifier failure defaults to fail-open. Use a Coflux-controlled admission
  endpoint with fail-open disabled and bounded requests; test its outage behavior.
  This is an integration adapter, not a new relay protocol.
  [derper.go:82](https://github.com/tailscale/tailscale/blob/31d8badb3bfb/cmd/derper/derper.go#L82).
- **The Go client is not a free shared connection pool.** Each Tailcat `Client`
  owns a backend. Reuse per demanded remote device and measure idle/single-device/
  multi-device footprint; do not eagerly create stacks for every sidebar entry.
  [tailcat.go:1743](https://github.com/tailscale/tailcat/blob/91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a/tailcat.go#L1743).
- **Updates currently describe one worker artifact.** Signed size/hash and atomic
  installation do not automatically extend to a sibling helper. The observation
  period must detect helper failure even if the worker itself stays alive.
  `crates/supervisor/src/upgrade.rs:300`, `docs/hot-upgrade-design.md:37`.
- **Generated Swift is an additional wire consumer.** `proto/buf.gen.yaml:14`
  regenerates Swift alongside TS/Rust. Do not delete definitions still referenced
  by the unreleased Swift client merely to clean the supported desktop path.
  Keep obsolete definitions deprecated/reserved as appropriate until that consumer
  is migrated; generated source consistency is still required.

## Scope

In scope for later implementation (planning edits remain confined to `wiki/plans/`):

- `transport/tailcat/` — helper, pinned Go dependencies, IPC contract, unit tests.
- `proto/`, `packages/protocol/`, `crates/protocol/`, and
  `packages/swift-client/Sources/CofluxProtocol/Generated/` — transport negotiation
  and grants, version constants, synchronized generation; no session redesign.
- `packages/client/src/`, `apps/desktop/src/{main,preload,shared}/`, and existing
  renderer connection setup/diagnostics and their tests — adapter and lifecycle.
- `crates/worker/`, networking-component lifecycle/delivery portions of
  `crates/supervisor/`, `crates/relay/`, `apps/server/src/`, `packages/cli/` — remote
  transport, grants, DERP admission, legacy retirement, verified installation.
- Root `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `.gitignore`,
  `Dockerfile`, `.github/workflows/{ci,release,desktop-release,npm-publish}.yml`,
  `apps/desktop/{package.json,electron-builder.yml,scripts}/`, and `scripts/` — only
  build/test/delivery changes required by the extra component and relay retirement.
- `tests/`, relevant desktop unit/acceptance tests, `AGENTS.md`, `README.md`,
  `docs/{architecture,hot-upgrade-design,deployment,RELEASING}.md`, a new transport
  contract/runbook if needed, and this plan/index/evidence — verification and docs.

Out of scope:

- Production deployment, DNS/firewall changes, purchases, release publication,
  pushes/PRs/merges, and shutdown of existing production relays.
- PTY/sessiond authority, terminal UI redesign, authentication product changes,
  or changing the local offline-grant policy.
- Migrating frozen browser clients or shipping native iOS support. Browser WASM
  currently lacks direct connectivity, and iOS cannot use the desktop subprocess
  approach. Record their compatibility limits without claiming this plan provides
  a universal client migration. Preserve buildable in-tree Swift sources.
- Unrelated CLI/agent integration changes left on the original main worktree.

## Commands

New helper and acceptance commands below are delivery requirements, not commands
claimed to exist at the planning baseline. The executor adds their implementations
and documents required local fixtures before using them as evidence.

| Purpose | Command | Expected result |
| --- | --- | --- |
| Helper unit tests (new) | `go -C transport/tailcat test ./internal/...` | Exit 0; deterministic, no external services |
| Helper build (new) | `go -C transport/tailcat build ./...` | Exit 0 with pinned toolchain/dependencies |
| Shared client tests | `node --import tsx --test packages/client/src/*.test.ts` | Exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | Exit 0 |
| Desktop types/unit tests | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` | Exit 0 |
| Rust units/build | `cargo test -p coflux-protocol -p coflux-worker -p coflux-supervisor && cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli` | Exit 0, zero build warnings |
| Protocol consistency | `(cd proto && buf lint && buf generate)` | Exit 0; generated output matches checked-in files; CI breaking check passes |
| Release metadata | `node --test scripts/product-version.test.mjs && pnpm release:check` | Exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | Exit 0 |
| Full black-box suite (acceptance) | `pnpm -C tests test` | Exit 0 against temporary stacks/databases; pretest also builds helper |
| Transport fault acceptance (new, acceptance) | `node --import tsx --test tests/src/tailcat-transport.test.mjs` | Exit 0 with private DERP and real Coflux processes |
| Signed upgrade acceptance (acceptance) | `node --import tsx --test tests/src/signed-upgrade.test.mjs` | Exit 0 including worker/helper atomicity and rollback cases |
| Isolated network matrix (new, acceptance) | `node tests/acceptance/tailcat-network.mjs` | Exit 0; records path and recovery evidence using container-only fault injection |
| Desktop account lifecycle (acceptance) | `node --import tsx scripts/verify-desktop-account-lifecycle.mjs` | Exit 0 using isolated fixtures; does not substitute for GUI/safeStorage acceptance |

During implementation, install dependencies only in this worktree and provision
the repository's dedicated test Postgres when needed. Do not use real account
credentials, real COFLUX_HOME, or host firewall changes in automated fault tests.
All new runtime tests must clean child processes, containers, temporary keys,
databases, ports, and temporary files on both success and failure.

## Done criteria

- [ ] Every milestone's outcome and command passes; evidence identifies exact
  Coflux/Tailcat/toolchain versions and distinguishes automated from manual checks.
- [ ] Real terminal attach/input/output/resize and a large binary file roundtrip
  work across the native helper and worker, not just an echo server.
- [ ] Container-isolated cases demonstrate direct UDP, forced DERP with direct
  UDP unavailable, path change during traffic, unreachable initial relay, same-
  region relay restart, and complete selected-region failure with a healthy
  alternate. Success is corroborated by transport status/network observation.
- [ ] Under induced loss, recovery never changes PTY PID/session ID, duplicates
  accepted input, reexecutes a completed mutation, or fabricates terminal exit.
  After a usable path returns, the controlled fixture resumes within 30 seconds.
- [ ] Cross-account/device grants, expiry, replay, stale generation, logout,
  client grace expiry, and worker control disconnect fail closed. Capturing an
  address alone cannot execute a Coflux operation. DERP admission outage behavior
  is tested separately from application-channel revocation.
- [ ] Helper kill, worker restart, mismatched IPC version, partial installation,
  corrupted helper, and failed upgrade observation preserve PTYs and recover or
  reject the candidate predictably. No helper survives its owning process.
- [ ] A 30-minute soak and 100 connect/disconnect cycles leave no orphan helper,
  authorized channel, or descriptor accumulation. Measure helper RSS/CPU/FDs and
  attach/ping latency with 0, 1, and 10 demanded devices; idle sidebar entries do
  not create tunnels. Resource counts return to their starting range after
  cleanup; investigate sustained memory growth rather than calling it GC noise.
- [ ] Compare at least 30 paired attempts on the same machines/networks against
  the old path. Record cold attach success, p50/p95 latency, direct success, and
  relay recovery. Deterministic cases must all pass; p95 cold attach and steady-
  state latency must not regress by more than 20% without reporting a failed
  promotion gate. These are acceptance budgets, not measured performance claims.
- [ ] At least one real cross-machine macOS-to-Linux run and one NAT-constrained
  network run confirm usability. Container/loopback results alone cannot establish
  internet NAT traversal rates. Missing suitable endpoints remain an explicit gap.
- [ ] Every supported release target builds and packages the helper, has matching
  component integrity metadata, and requires no user-installed Go/Tailscale.
  macOS packaged-app launch/signature/lifecycle acceptance is recorded separately
  from a development build. No production signing/release success is inferred.
- [ ] Old active WebRTC/custom-relay implementation is retired for the supported
  release path; local direct, shared session tests, and in-tree generated consumers
  remain intact. Historical documentation is not rewritten for cleanup alone.
- [ ] Only in-scope files changed, relevant architecture/docs are accurate, and
  `wiki/plans/README.md` becomes DONE only after all required evidence exists.

## STOP conditions

- A cited architectural fact is no longer true and changes a recorded decision.
- Work requires a new product scope, production operation, mobile runtime design,
  or relaxation of authorization/session guarantees beyond the user's decisions.
- The pinned upstream cannot support required lifecycle, private DERP operation,
  or bounded region-failure recovery without maintaining a replacement network stack.
- A helper update cannot preserve the established signing/rollback trust boundary.
- A validation fails twice after one reasonable fix, or a promotion gate fails.
  Report the exact failure and retain the old usable path; do not mark DONE.
- Real-network or packaged-app acceptance cannot be performed. Report the missing
  evidence and retain candidate status; do not substitute a passing mock result.

## Maintenance notes

Tailcat is an experimental wrapper around production networking components.
Track upstream changes at the pinned module boundary, not by copying its internal
magicsock logic into Coflux. A stock derper plus a small admission adapter still
requires capacity monitoring, TLS operations, geographic placement, and incident
response. That operational responsibility is the user's accepted tradeoff.

Keep source-review conclusions, local tests, cross-network measurements, and
published-artifact verification separate in the evidence report. Future changes
to admission policy or transport lifetime must recheck the existing control-loss
grace and session recovery guarantees.
