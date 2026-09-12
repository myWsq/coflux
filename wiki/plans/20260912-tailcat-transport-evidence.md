# Tailcat transport migration evidence

## Current outcome

The opt-in candidate is implemented and locally validated; migration promotion is **not complete**. `COFLUX_TAILCAT=1` selects it, and the old supported transport remains the default. The final full black-box suite passed **220/220**, with zero failures/skips, in **141.21 s**. Final fault recovery measured **16.83 s** for the initial unreachable region, **5.03 s** after helper crash, and **13.15 s** after active-region loss, with unchanged PTY identity. Client grace and stale requests after worker control loss also passed.

The thirty-minute application soak, 100 reconnect cycles, real Debian LAN application traffic, 8 MiB binary roundtrip, and paired signed-upgrade rollback passed. The documented latency budget failed. Actual internet NAT coverage, real DERP-admission outage/unauthorized-node acceptance, and macOS GUI/keychain plus production-signature acceptance are still missing. No default switch, legacy removal, production deployment, push, or release is claimed.

## Baseline and scope

- Coflux baseline: `67b51751c0e33e5742312975d9876dd83cbd0664`.
- Workspace: `dev/20260912-tailcat-transport`; the original main worktree is not modified by this migration.
- Implementation was explicitly authorized after the planning handoff. Production deployment is outside this execution.
- Tailcat: `github.com/tailscale/tailcat v0.6.1-0.20260909154426-91dc4979bd4a`, commit `91dc4979bd4ae88af6ae2c8bb549616de4bcaa5a`.
- Module checksum: `h1:DbJO8q3BPLAfr5wG5MARO6fcnVFJNQhQKJBFsZyzsUM=`.
- Go toolchain: `go1.27.1`, acquired through Go's toolchain mechanism.

## Pre-implementation checks

- `pnpm install --frozen-lockfile`: passed without changing the lockfile.
- Server `tsc --noEmit` and desktop typechecks: passed.
- Rust test prebuild (supervisor, worker, relay, CLI): passed with no warnings.
- Initial full black-box run: 209 passed, 6 failed out of 215. All six failures were setup failures in two files: PostgreSQL database creation and cancellation timed out before behavioral tests started.
- Serial rerun of `p2p-transport.test.mjs` and `project-rename.test.mjs`: all 6 passed without source changes.
- Complete rerun against task-owned temporary PostgreSQL: **215 passed, 0 failed, 0 skipped**, 121.28 seconds; no source changes were required.

## Upstream feasibility probe

The pinned upstream root package compiled with `CGO_ENABLED=0`, and its real
`TestTailcat` passed against its local DERP/STUN fixture (1.185 seconds). This
establishes buildability and basic upstream connectivity on the development Mac,
not Coflux integration or internet NAT success.

The first default-CGO link failed because the host linker rejected the installed
macOS 27 SDK's `arm64e.x1` TBD entries. Pure-Go compilation avoids that host toolchain
mismatch without altering or downgrading upstream source. Use the same explicit
CGO-free build mode for the helper unless a required feature proves incompatible.

## Native helper checks

- `CGO_ENABLED=0 go -C transport/tailcat test -mod=readonly ./internal/...`: passed for backend, helper, and IPC packages.
- `CGO_ENABLED=0 go -C transport/tailcat vet ./internal/...`: passed.
- Native helper builds passed for macOS arm64, Linux amd64, and Linux arm64. Cross-compilation alone does not prove packaged delivery.
- `buf lint && buf generate`: passed, including TypeScript, Rust, and Swift consumers.
- A process-level probe used two real helpers over inherited pipes and a temporary stock DERP server with a pinned TLS certificate. Binary payloads of 1 byte, 64 KiB, and 30 MiB roundtripped intact; `DiscoPing` reported direct transport. Dropping the connection and closing owner stdin terminated helpers successfully.
- A `TS_DEBUG_NEVER_DIRECT_UDP=true` comparison reported relay transport, roundtripped 1 byte and 64 KiB, and completed connection/owner cleanup. This debug flag is not firewall or NAT acceptance.
- `TS_DEBUG_ALWAYS_USE_DERP=true` also transported all three payload sizes, but `drop` hung for more than 25 seconds. A small-payload reproduction captured WireGuard shutdown waiting for receive goroutines blocked inside `magicsock.blockForeverConn`. This upstream debug socket does not implement read deadlines. Keep this failed probe distinct from ordinary relay behavior; no upstream patch or version substitution was applied.
- Upstream address serialization discards DERP region identifiers and restores embedded regions starting at 1. A helper's raw probe region is therefore a backend-local identifier, not the original Coflux region ID (901 in this fixture).
- Two Linux arm64 helper processes in separate temporary containers passed the same 1-byte, 64-KiB, and 30-MiB roundtrips with real container-local IPv4/IPv6 UDP drop rules. Firewall counters confirmed dropped packets, `DiscoPing` reported relay, and drop/owner EOF cleanup passed. No host firewall was changed. The initial OrbStack `host.docker.internal` route failed; the reachable Mac LAN address was used for the stock DERP fixture.
- Authorized macOS-to-Debian Linux amd64 helper probes passed 1-byte, 64-KiB, and 30-MiB roundtrips. The binary was transferred over certificate-pinned temporary TLS and checked by SHA-256; private helper IPC remained inside that temporary authenticated TLS controller link. Five post-transfer probes reported four direct results and one relay result. These are path samples, not an attach benchmark. The existing Debian daemon was neither restarted nor upgraded; temporary helper directories/processes and completed test terminals were removed, with remote exit code 0.
- The two physical machines share a LAN. Debian also has an existing Tailscale interface; a direct status without the numeric endpoint is not evidence of which underlying interface was used and does not establish internet NAT traversal.
- A helper-only 100-cycle connect/drop probe and ten simultaneously demanded, distinct serving helpers passed. Each of the ten connections roundtripped 1 MiB. Client file-descriptor records returned from 49 to 9 after dropping all devices (9 before the demand). RSS grew from approximately 35 MiB after the cycles to 188 MiB after the data burst; memory reclamation and sustained-growth investigation remain open, so the full resource gate is not marked passed.
- A second resource run observed post-burst RSS reclaiming from 196,368 KiB to 147,328 / 128,336 / 46,800 KiB at one / two / three idle minutes. FD records remained 9 and CPU samples reached 0.0%. Both runs exited and cleaned up successfully. This short idle observation does not substitute for the 30-minute application soak.
- Native-process negative probes reject arguments, incompatible IPC versions, and oversized headers. The initial real inherited-pipe handshake timeout failed despite the in-memory pipe tests; wrapping nonblocking inherited descriptors in Go's poller fixed it. Rebuilt native-process probes now pass the five-second initial-handshake deadline and bounded shutdown when the owner stops reading output.
- The rebuilt helper again passed the macOS-to-Debian 30-MiB roundtrip and cleanup. With the temporary stock STUN listener enabled, a subsequent 1-byte/64-KiB run recorded ten direct probes to `192.168.1.124:54841` (approximately 6–16 ms), confirming the LAN endpoint rather than Debian's pre-existing Tailscale interface. These samples establish this LAN path only; they remain separate from WAN/NAT and paired-performance acceptance.

## Worker integration checks in progress

The first worker integration snapshot passed `cargo test -p coflux-protocol -p
coflux-worker -p coflux-supervisor` and the supervisor/worker/CLI build. The worker
suite contained 119 passing tests, including new grant proof, account/device,
expiry, generation, and revocation unit cases. Subsequent control-grace and
coordinator changes still require new verification and real Coflux black-box
acceptance.

Server type checking and four coordinator unit tests passed after the scope and
opened-channel changes. They cover cross-account rejection, grant delivery only
after worker installation, immediate pending/elevated revocation with opened
session grace, and helper-identity replacement.

These probes exercise transport bytes and helper lifecycle only. They do not
establish Coflux grant verification, terminal semantics, or release readiness.

## Desktop and worker integration snapshot checks

The in-progress M2 snapshot passed desktop type checking, all 89 existing desktop
unit tests, all 71 shared-client tests, and the Electron main/preload/renderer
production build. These checks precede the latest pending-channel, per-stream
budget, region-recovery, and idle-device revisions; they do not validate those
later changes or substitute for the new transport acceptance tests.

Rust protocol/supervisor/worker unit suites passed 41 / 73 / 119 tests,
respectively. The supervisor/worker/CLI build completed without warnings. Server
type checking and the four coordinator tests also passed again.

The helper rebuilt for darwin/arm64, darwin/amd64, linux/arm64, and linux/amd64.
After the stream event-ordering fix, the native inherited-pipe process probe
roundtripped 1 byte and 64 KiB through stock DERP and completed owner-EOF cleanup.
The sampled path was relay; no direct-path or performance claim is derived from
this run. The generated protocol consumers were refreshed after adding the
bounded failed-dial notification, with `buf lint && buf generate` passing.

## First real application-channel smoke test

`COFLUX_TEST_TAILCAT=1 COFLUX_TEST_DERPER_BIN=/tmp/coflux-tailcat-derper
COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres
node --import tsx --test tests/src/tailcat-transport.test.mjs` passed one test in
4.97 seconds. It starts the real server, supervisor, worker, stock DERP, and
native helper. An independently implemented test IPC client received a central
grant, proved the fresh challenge, requested a session catalog over DeviceEnvelope,
received rejection for an elevated request on a session lane, and observed the
stream closing after central revocation. All fixture processes were cleaned up.
This is the first application-channel smoke test, not full terminal acceptance.

The first two runs failed at `open` because the fixture's certificate contained
only a Common Name and no SAN. A separate stock-derper startup reproduction exited
with `certificate relies on legacy Common Name field, use SANs instead`. Upstream
`cmd/derper/cert.go` validates the certificate hostname before serving, regardless
of client TLS settings. Adding an IP SAN and an explicit certificate pin fixed the
fixture. Separate helper probes confirmed that loopback-only DERP binding,
disabled STUN, and the restricted `InsecureForTests` field were not the cause.

Five new desktop-main behavioral tests passed: authentication acceptance followed
by data in the same callback, rejection of renderer data during authentication,
cancellation during shared startup, dedicated-control grace expiry, and cleanup
after a failed handshake send. Worker tests increased to 120 with independent
session/elevated generation coverage. The Linux amd64 supervisor, worker, and CLI
snapshot also built successfully in the isolated musl container; it has not yet
been used for application-level Debian acceptance.

## Expanded terminal regression and soak in progress

The expanded native application fixture passed from the `tests/` working directory
in 8.72 seconds. It uses separate session/elevated native lanes to prepare a
workspace and terminal, run exec, roundtrip a 72-KB text file, acknowledge terminal
input, observe shell output, resize and verify `stty size`, query the session
catalog, and revoke both lanes. The complete suite ran 216 tests: all 215 existing
tests passed, while the new fixture initially failed before runtime startup because
its default helper path depended on cwd. The file-relative path fix then passed
the expanded native test separately. This is not recorded as a single all-green
full-suite invocation; that check remains required after the final changes.

A scratch application soak is running against frozen M2 binaries and port 12097,
using the same real server/worker/helper path and temporary PostgreSQL. It performs
catalog and acknowledged shell-output checks every ten seconds, asserts that the
PTY PID is unchanged, and samples both helpers' RSS/CPU/FD counts each minute.
The intended duration is 30 minutes plus post-drop cleanup observation; it is not
yet a passing result. Frozen SHA-256 identities:

- Supervisor: `c8a8a5d8476b876b4e29415949d4f0ccc2678da01c0c4951fb456ed38e30016a`.
- Worker: `22ba7fe76dd2c0e6d8dfa3ef4dfcb1e06e82466ce99a061212b34d8d5d4abbee`.
- Helper: `f06e00f8517b396bdf0ae6baf46701df38cedd813bbd3f093c04f1dc68978038`.

## Acceptance status

Implementation, signed bundle delivery, Coflux terminal acceptance, network-fault
matrix, resource soak, cross-machine comparison, and packaged-app acceptance are
not yet complete. No performance or production-readiness claim is made.

## Continued M3 verification and Debian application acceptance

- The four release-script helper builds completed successfully for macOS arm64/x86_64 and Linux arm64/x86_64. Each contains compiled-module notices; no host Go runtime is needed by the resulting binaries.
- A real macOS client helper connected to a temporary Debian supervisor/worker through a temporary central server and stock private DERP. The application fixture passed in 7.62 s: scoped grant admission, project/session preparation, exec, 72 KB file write/read, PTY input, resize to 35x100, catalog, and session/elevated revocation. Controller cleanup completed and the temporary remote terminal was removed. Existing Debian services were not restarted or upgraded. This establishes LAN application usability, not internet NAT traversal.
- The Debian snapshot was the frozen M2 Linux build: supervisor `28e3f61768edf9c250c7b7473fe0617ada2995f8224b15e5159c1de8338d2f1c`, worker `dd08c0bb84d85ce0dbc62ec9c33bf799f14e0af5e9f38190513d6c19b201089b`, helper `22a5c170c8b10e1613e6f9f171ef7fe2ac23c6f1e626372c9722a8704d0c29bf`. It does not validate the later paired-upgrade implementation.
- The first Debian fixture attempt could not enroll because the temporary center retained its default loopback bind. The controller removed its remote process/directory. Binding only the temporary center for the LAN fixture resolved the test setup error.
- M3 desktop/server types, 94 desktop tests, and 16 release-signing/installer tests passed. The Rust build produced zero warnings. The protocol, worker, and supervisor unit suites passed; after atomic directory staging was added, 75 supervisor tests passed.
- Paired upgrade acceptance passed once before the atomic directory revision: tampered companion rejection, complete pair activation, incompatible helper rollback, and unchanged PTY PID. This is not evidence for crash atomicity; the revised implementation publishes a complete fsynced staging directory with one rename and requires a fresh acceptance run.
- The expanded application fixture passed an 8 MiB deterministic binary upload and base64-returned download with full byte equality and an independent filesystem oracle.

### Application cycles and failed latency promotion gate

100 real application reconnect/attach/catalog/revoke/drop cycles passed using the frozen M2 Mac artifacts. Every catalog retained the original PTY PID. Client helper FD records returned from 13 connected to the initial 9 after each drop; after 60 seconds idle, RSS was 25,344 KiB and CPU 0%, with 9 FD records. The first unpaced fixture hit the existing 32-rendezvous-per-second limit; a paced 150 ms cycle interval completed all 100 cycles without weakening admission limits.

The first 30 cycles included interleaved old custom-relay measurements on the same Mac and temporary application server. Both cold measurements include grant/connection and real session attach; Tailcat additionally creates its per-demand backend. Results in milliseconds:

| Measurement | Old p50 | Old p95 | Tailcat p50 | Tailcat p95 |
| --- | ---: | ---: | ---: | ---: |
| Cold attach | 4.57 | 7.37 | 12.72 | 25.66 |
| Immediate post-attach catalog | 0.48 | 0.68 | 0.75 | 16.05 |

The cold attach ratio is 3.48, above the plan's 1.20 limit: **promotion failed**. The second row measures the first request after attachment, not a warmed steady-state ping; no steady-state claim is made from that row. Tailcat path probes observed both direct and relay during these cold attempts. These loopback observations do not establish WAN performance. Milestone 4 must remain incomplete; default enablement and old-stack retirement are not authorized by passing correctness checks.

The atomically staged pair revision passed the paired-upgrade black-box test again (23.96 s). Offline desktop-account convergence and preservation of another device's active terminal passed; product-version tests and `release:check` passed. macOS arm64 packaging completed with local ad-hoc signing only; no Developer ID or notarization result is claimed.

A separate warmed comparison held both channels open, waited one second, ran ten warmup catalog requests, then alternated 30 paired requests at 100 ms intervals. Old relay p50/p95 were 0.85/1.16 ms; native p50/p95 were 6.41/14.09 ms. The observed native path was direct (LAN endpoint, probe RTT 3.57 ms). The relative latency promotion gate remains failed. No attempt was made to change its budget or infer WAN results from this host.

The packaged-app smoke test could not reach its renderer: a native process sample showed macOS Security `SecItemAdd -> defaultKeychainUI -> AuthorizationCopyRights` blocking startup with the isolated HOME. The temporary app and its test stack were stopped and their directories removed. No keychain setting was changed; GUI/safeStorage lifecycle acceptance remains incomplete. Packaging success is not launch or notarization acceptance.

A complete black-box run finished with 220 tests: 219 passed, 1 failed (`tailcat-faults`, helper-crash channel timeout). Investigation found a real missing server-to-client invalidation notification, rather than claiming a dead TCP peer would provide an immediate FIN. The revision adds `DeviceTailcatClosed` for the exact channel and closes that desktop helper stream through the existing epoch-checked control connection. A fresh protocol lint/generation/breaking check and zero-warning Rust build passed; final fault and full-suite results remain pending.

The final Linux amd64 supervisor/worker/CLI snapshot also built successfully in the isolated Alpine builder (2m36s, zero warnings). The final Mac Rust unit suites passed (protocol, supervisor, worker), and the build produced zero warnings. After adding channel invalidation, desktop/server type checks, 95 desktop tests, and 79 shared-client/server tests passed. The locally packaged app passed `codesign --verify --deep --strict`; this checks local bundle integrity and does not imply Developer ID signing, notarization, or completed launch acceptance.

### Completed thirty-minute application soak

The frozen M2 application stack completed 1,801,946 ms of continuous PTY activity (179 acknowledged commands with actual-output matching and catalog PID checks). PTY PID `44428` and its session ID stayed unchanged. Active client/server helper FD records remained at 13 throughout sampling. After both lanes closed, backend drop, and a further 60 seconds idle, the client helper returned to 9 FD records (its initial count), 26,656 KiB RSS, and 0% CPU. The whole fixture passed in 1,868,674 ms; the supervisor, worker, both helpers, and PTY processes were confirmed absent afterward. No monotonically growing active RSS trend was observed. This does not cover subsequent M3 delivery or channel-invalidation changes.
