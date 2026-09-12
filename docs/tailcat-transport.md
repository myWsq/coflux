# Native Tailcat transport contract

This is the candidate transport contract. The Go companion is included in
release artifacts and Desktop bundles, but native networking still requires
`COFLUX_TAILCAT=1` in both worker and Desktop-main environments. The existing
custom relay/WebRTC transport remains the default. Promotion and legacy
retirement (M4) are not complete; local test success does not waive the plan's
performance, real-network, or packaged-delivery gates.

## Ownership and dependency boundary

`coflux-transport` embeds `github.com/tailscale/tailcat` at
`v0.6.1-0.20260909154426-91dc4979bd4a`, using Go 1.27.1 and `CGO_ENABLED=0`.
The worker owns one serving helper per authenticated control epoch. Electron main
owns its client helper, reusing a Tailcat client per demanded device (maximum 16).
Neither terminal tabs nor idle sidebar entries create networking processes.

The executable accepts only `--version` for local artifact identification. Its
networking mode communicates only through inherited
stdin/stdout pipes; there is no public local listener, shell, generic proxy,
filesystem API, subnet routing, or renderer access to its pipes. Logs never
contain Tailcat addresses, private keys, grants, or upstream diagnostic output.
The owner must spawn an absolute verified bundle path and close both pipes on
logout, hard rejection, epoch replacement, or shutdown.

## IPC version 1

All integer fields in binary framing are unsigned big endian. A record is
`bodyLength:u32 || kind:u8 || stream:u32 || payload`. `bodyLength` includes the
kind and stream fields. Control records use kind 1, stream zero and a UTF-8 JSON
object (1–65,536 bytes). Data records use kind 2, a nonzero stream and 1–31,457,280
opaque bytes. Tailcat TCP uses `payloadLength:u32 || payload` for each data record;
DeviceEnvelope bytes are neither reencoded nor interpreted by Go.

The first owner command is `{"id":1,"op":"hello","version":1}`. The response
contains `ok`, `version`, `releaseVersion`, and `publicKey` (Tailscale's `nodekey:` representation).
This generates a node key without opening a tunnel. The owner registers the
public key through authenticated Coflux control and waits for relay admission
before sending `serve`. Client owners first call `prepare` for each demanded device
and register its distinct public key before `open`; independent Tailcat backends
must not compete for one DERP node identity. Keys never appear in process arguments.

Every command has a nonzero `id`. Responses echo `id` and `op`, with `ok:true`
or a sanitized `error`. Commands may finish out of order; at most 32 run
concurrently. Unsolicited events have no `id`.

| Operation | Owner fields | Result |
| --- | --- | --- |
| `prepare` | `connection` | A unique client `publicKey` for that demanded device, without network startup |
| `serve` | `region` (embedded DERPRegion object) | `address` (secret, owner memory only) |
| `allow` | `publicKey` | Adds a centrally admitted node to the serving allowlist |
| `open` | `connection`, `stream`, `address` | Opens one reliable TCP stream |
| `authorize` | `stream` | Worker confirms its application challenge succeeded |
| `close` | `stream` | Cancels a pending dial or closes an existing stream |
| `drop` | `connection` | Closes that device's streams and its Tailcat client |
| `probe` | `connection` | Measured `path` with mode, backendRegion, latencyMs |
| `health` | none | Whether a configured stock DERP probe endpoint is reachable |
| `shutdown` | none | Closes all networking and exits |

Owner-created stream IDs are 1–2,147,483,647. Server-accepted streams have IDs
2,147,483,648–4,294,967,294 and are announced by `accepted`. A `closed` event ends
either kind of stream. Stream IDs cannot identify an account or grant authority.
Accepted streams expire in five seconds unless the worker sends `authorize`.
The server starts with a nonempty self-key allowlist; an empty upstream allowlist
would incorrectly allow every client. At most 256 distinct client keys may be
added before the owner must rotate the serving epoch.

## Authorization boundary

Go's allowlist and DERP admission protect network reachability only. The worker
must receive a short-lived, single-use channel grant over authenticated central
control. The grant binds account, device, client identity, channel, generation,
scopes and an independent random 32-byte proof key. On a new remote stream the
worker issues a fresh random challenge and verifies HMAC-SHA256 possession of
that proof key, atomically consuming the grant before admitting DeviceEnvelope.
An address alone conveys no Coflux business authority. Remote streams never
pass through the loopback gateway or acquire local offline grants.

Worker control loss clears unconsumed grants and closes pre-auth streams and active remote
channels by retiring the serving helper. Client control loss retains only existing session lanes for the
existing 15-second grace window; no new or elevated operations are permitted.
Expiry is checked again at proof consumption, not only when installing a grant.
Endpoint replacement and channel revocation send `deviceTailcatClosed` to the
owning client. Owners subscribe before requesting a grant, so the notification
cancels pending dial/handshake work as well as live streams. Socket epochs and
unique channel IDs prevent stale notifications from closing replacements.
Remote peer loss need not produce a prompt TCP FIN; the control notification
is an explicit lifecycle signal.

## Bounds, cancellation and failures

The helper admits at most 256 streams. A stream's queued payload is capped at
32 MiB and 256 records. The aggregate 128 MiB payload budget includes partial
reads, queued records and writes in flight, shared across both directions.
Headers are validated and capacity reserved before payload allocation. Malformed
or oversized IPC closes the helper; malformed remote framing closes its stream.
Queue exhaustion closes the affected stream, or the helper if control output
cannot be delivered. There is no unbounded retry buffer.

Writes handle partial success and have a 20-second deadline. A stalled owner
output pipe terminates the helper. Dials have a 15-second deadline and can be
cancelled by stream ID. Owner pipe EOF, SIGTERM or SIGINT closes all streams and
upstream clients/server; there are no IPC pathnames to leave behind. Owners apply
bounded restart/backoff and reauthorize channels after process loss. Networking
failure must not restart the PTY/session supervisor.

Both server and client require an embedded private DERP region. Missing region
data is rejected before upstream startup, preventing a public map fetch. TLS
verification bypass is accepted only for literal loopback test descriptors.
Production descriptors use normal TLS or a pinned `CertName`; changing region
means replacing the serving epoch and rediscovering its endpoint. Upstream is
not assumed to provide automatic cross-region failover.

`probe` uses upstream `DiscoPing`. `direct` means the measured pong had a direct
endpoint; `relay` means it identified a DERP region. Absence of measurement is
`unknown`. The local pipe is never evidence of a direct remote connection.

## Validation

`go -C transport/tailcat test ./internal/...` exercises framing, bounds, partial
read/write ownership and helper lifetime without external services. The main
agent runs network/process acceptance separately against temporary stock DERP
fixtures and real Coflux channels. Passing helper tests alone does not promote
the candidate or authorize retiring the legacy transport.


## Region recovery and private DERP operations

Enable the candidate with `COFLUX_TAILCAT=1` in the worker and desktop-main
process environments. The server receives `COFLUX_DERP_REGIONS`, a JSON array
of 1–8 private DERP region descriptors. Each must contain at least one reachable
DERP node, matching `RegionID` values, and a valid TLS hostname or certificate
pin. An initial unavailable region and a later region outage use the same
worker-owned recovery loop: every 10 seconds in the healthy state, every second
after a failure, with a three-second per-probe deadline and three consecutive
failures before replacing the helper. The next centrally registered identity
selects the next configured region. This bounds detection to approximately
21 seconds; the complete recovery budget also includes helper restart and client
reauthorization and must be measured with real fault injection.

A native dial failure can request an immediate worker health probe through an
owned, installed, unopened channel. Reports are limited to one per device per
10 seconds. A single client's disconnected network cannot rotate a healthy
worker. Health uses the stock HTTPS `/derp/probe` route and creates no DERP node
session. It honors IPv4/IPv6 hints, disabled address families, normal certificate
names and upstream `sha256-raw:` pins. It checks endpoint reachability, not
successful authenticated DERP forwarding. Real stop/refuse-connection tests are
required in addition to this signal.

`COFLUX_DERP_ADMISSION_PORT` starts a separate loopback-only admission listener
on the Coflux server. Point stock `derper` at its `/verify` route and explicitly
set `-verify-client-url-fail-open=false`; upstream's default is **true**. When
DERP runs on another host, use authenticated private forwarding to the listener.
Do not expose it through the public application reverse proxy. Admission accepts
only registered serving keys or keys of centrally owned channel grants. A
network admission check is never a replacement for worker challenge validation.
Use an ordinary publicly trusted certificate in production; a local fixture's
certificate still needs a SAN because stock derper verifies its own hostname at
startup, before client TLS settings matter.

## Delivery, bootstrap and rollback

`node scripts/build-transport.mjs <Rust-target> <output-directory>` builds the
CGO-free helper for the four existing desktop/headless targets. It also emits
`TRANSPORT-NOTICES.txt` and `TRANSPORT-MODULES.txt` from the actual compiled Go
dependency graph, including the Go standard library license. Release archives,
Desktop resources and CLI installs include the notices; end users do not need Go.

The release manifest's `transport` component has a separate
`coflux-transport-release-v1` Ed25519 domain, binding the same release version
and target as its worker plus its digest and size. Desktop includes the helper
in content-addressed runtime identity, signing and notarization. A downloaded
worker and companion occupy `workers/<version>/` together. The supervisor verifies
both before activation, fsyncs the worker, companion and pair metadata inside a
private sibling staging directory, publishes the complete directory with one
rename, and only then enters existing worker probation. Existing version
directories are never extended or mutated. Recovery
rejects a pair with a missing, non-executable or digest-mismatched member.
Rollback selects the previous immutable directory and its matching helper.

This migration needs a one-time supervisor bootstrap. A new supervisor advertises
`COFLUX_TRANSPORT_PAIR=1` to its worker, which exposes `transport_pair_v1` centrally.
The server refuses paired hot updates to devices without that capability. A
released worker also rejects an older supervisor locally, protecting the case
where an older server ignores newly added manifest metadata. Install the complete
release with `cofluxd update`, then explicitly restart the daemon when existing
terminals can be stopped. Subsequent worker/helper hot updates leave supervisor
PTYs alive. No production installation or restart is part of implementing this
candidate.

Before a paired/released worker joins UDS or acknowledges resync, it must complete
a local helper IPC handshake. Release builds require the helper's embedded
release to match. A missing/incompatible helper therefore fails candidate startup
and uses existing supervisor retry/rollback. An unexpected serving-helper exit
during candidate probation also fails the worker, while intentional region
rotation remains a networking restart. This health condition does not depend on
DERP reachability or grant availability.

## Reproducible application acceptance

Build `coflux-transport` beside the debug worker and a stock DERP binary from the
pinned module. Then run:

```sh
COFLUX_TEST_TAILCAT=1 \
COFLUX_TEST_DERPER_BIN="$PWD/target/debug/coflux-test-derper" \
pnpm -C tests test
```

`tailcat-transport.test.mjs` owns temporary certificates, DERP, server, database,
worker/helper processes and PTYs. It exercises real grant/proof admission,
separate session/elevated scopes, prepared operations, terminal input/output and
resize, file and exec operations, and revocation. `tailcat-upgrade.test.mjs`
exercises signed pair activation, tampering, failed-helper rollback and PTY PID
continuity. `tailcat-faults.test.mjs` exercises initial region unavailability,
helper crashes, a running region outage, client control grace, worker control
loss, and PTY continuity. It verifies central revocation and local stream
cleanup separately; during server outage it also checks serving-helper exit
and rejection of stale-channel requests. CI and the repository Docker test
image enable these fixtures.
Candidate promotion still requires the plan's real NAT/fault, packaged-app,
signed-artifact, capacity and latency gates; green local tests do not waive them.
