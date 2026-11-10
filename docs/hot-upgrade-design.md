# Automatic daemon hot-upgrade design

> Status: implemented (plan 20261002-runtime-launcher-merge). A device runs three Rust processes, `coflux-ptyd`, `coflux-launcher` and `coflux-runtime`, with no Node runtime. The **runtime** is the unit that gets updated: it holds sessiond (VT/history/holder/sequence authority, PTY environment assembly, shell integration) and everything the former worker did (centre connection, git/exec/fs, local gateway, native channels, executor host), and it talks to ptyd directly. The **launcher** is a small, rarely changing process that owns the version pointer, spawns the runtime, decides probation and commit, rolls back a crash-looping or pseudo-healthy candidate, falls back to the builtin runtime and serves `runtime.sock` / `runtime.lock`. Runtime updates — centre pushes included — rebuild sessiond from ptyd: terminals pause briefly, attached clients reattach (holders are reclaimed on reattach) and the create/stop de-duplication ledger is reset. Only a change to ptyd itself still ends terminals, through its own confirmed action.

## Client updates and runtime-component updates

Updating the desktop app restarts only its interface and account client; it reconnects to the existing `runtime.sock`, which the launcher keeps across runtime swaps. After an app update the app stages its bundled runtime and asks the running launcher to switch to it, with no click; when the bundled launcher itself changed, the app asks the old launcher to `leave` (terminals stay in ptyd) and starts the new one. On headless devices the centre pushes every runtime release automatically; `cofluxd update` / `cofluxd restart` are needed only when the launcher, ptyd or the CLI change, and `restart` keeps terminals.

This is not live-process recovery: if `coflux-ptyd` (the PTY-owning process) or the operating system actually restarts, program memory is not guaranteed to survive. A launcher or runtime restart is not that event.

## 1. Why three processes?

A PTY is a resource of the process that owns it. The split keeps three change rates apart: PTY custody (near zero), the launcher (rarely), the runtime (every release):

```text
┌────────────────────────────────────────────────────────────┐
│ coflux-ptyd (long-lived; lifetime independent of the rest)  │
│ · openpty + fork/exec of a fully resolved spec, TIOCSWINSZ, │
│   waitpid; bare write(2) input                              │
│ · per-session 4 MiB output ring indexed by byte offset,     │
│   never overwriting past the last checkpoint (stops reading)│
│ · input cursors, resize log, opaque checkpoint blob, status │
│ · v1 UDS protocol with a capability handshake               │
└──────────────▲───────────────────────────▲─────────────────┘
               │ ptyd protocol (full)      │ ptyd protocol (read-only list / kill on stop)
┌──────────────┴─────────────────────┐ ┌───┴──────────────────────────────────────────┐
│ coflux-runtime (the unit updated)  │ │ coflux-launcher (rarely changes)              │
│ · sessiond: VT/history, holder/seq,│ │ · version pointer (runtime.active), remote    │
│   checkpoints, PTY env, shell rc   │◄┤   release floor (runtime.release-floor)       │
│ · centre WS, loopback gateway,     │ │ · spawns the runtime with a per-spawn nonce   │
│   git/exec/fs, native channels     │ │ · probation: nonce echo + ptyd session list   │
│ · download + verify releases       │ │   + gateway TCP connect, then observation     │
│ · in-process sessiond bridge       │ │ · commit / rollback / builtin fallback        │
└──────────────▲─────────────────────┘ │ · runtime.sock / runtime.lock for the app     │
               │ /daemon protobuf WS    └───────────────────────────────────────────────┘
            Central server               private launcher ↔ runtime channel: launcher.sock
```

When the runtime crashes, is replaced or disconnects from the centre, ptyd keeps reading each PTY into its ring (and stops reading rather than overwriting anything at or past the last checkpoint offset). The next runtime enumerates ptyd's sessions, feeds each checkpoint blob, replays the ring from the checkpoint offset with the resize log applied at the recorded offsets, restores the input cursors, and only then starts its gateway and centre connection. `output_seq` is the ring's byte offset, so the rebuilt sessiond reproduces byte-identical sequence numbers and every client's `resume_from_seq` stays meaningful. Recovery is per session; a session whose blob or ring is unusable degrades alone. Ring replay pipelines several `read` requests on a dedicated ptyd connection, within the v1 protocol. The ptyd protocol is a long-term compatibility contract: the hello advertises the ops the running ptyd implements, the runtime treats a missing op as an unavailable capability, and v1 ops are never removed or changed, so a runtime upgrade never requires a matching ptyd. ptyd is started only by whoever owns the runtime lifecycle (the desktop app as a sibling of the launcher, or the service that `cofluxd` generates); neither the launcher nor the runtime ever starts it, and the runtime refuses to run without it, naming `cofluxd update` as the fix.

## 2. The sessiond bridge and reconciliation

Inside the runtime, sessiond and the rest of the process exchange length-prefixed records over two bounded in-process channels (`crates/runtime/src/sessiond_ipc.rs`): control records are JSON (`session.create`, `session.close`, `resync.request` / `resync.list`, `session.started` / `session.exit` / `session.command`), data records are binary frames (session-dirty notifications and DeviceEnvelope frames keyed by logical channel id). sessiond keeps its own bounded outbound queue per attachment; when a lifecycle record cannot be queued it cuts the attachment and the core re-attaches with a new generation and resyncs. There is no UDS hop on the terminal data path.

Recovery after a runtime start has two levels: sessiond's live snapshot first (`resync.list`), then the centre (`daemon.resync` plus the device catalog). A missing session does not mean exit; sessiond tombstones establish exit facts, and the centre never kills unknown orphans because the runtime or server restarted.

## 3. Upgrade flow

1. The release workflow builds launcher, runtime, CLI, transport and ptyd for four platforms and creates a schema 3 manifest. One ed25519 private key signs a domain-separated release statement per component (`coflux-runtime-release-v1`, `coflux-launcher-release-v1`, `coflux-cli-release-v1`, `coflux-transport-release-v1`, `coflux-ptyd-release-v1`), binding `version`, Rust `target`, raw 32-byte SHA-256 and artifact size exactly. There is no `worker` component and no raw-binary signature for any component. The URL is only a download location and is not signed.
2. The server polls stable GitHub Releases and parses schema 2 and 3. A schema 3 `runtime` is pushed only to daemons that advertise `runtime_launcher_v1` and are not desktop-managed; a schema 2 `worker` only to daemons without the launcher capability. The push reuses `worker.upgrade {version,url,target,sha256,artifactSize,releaseSignature,transport}`; the legacy `signature` field is ignored by the runtime.
3. The runtime requires canonical strict SemVer and a matching local target, refuses versions at or below the floor the launcher reported at `ready`, then performs a bounded download into `COFLUX_HOME/runtimes/<version>/` and checks signed size, SHA-256 and the release-statement signature (and the paired transport's). Any mismatch deletes the candidate. One download executor with a latest-only mailbox makes sure a slow old download never overtakes a newer request.
4. After atomic installation the runtime sends `switch {version}` over the private channel. The launcher re-validates the installed file, enforces the floor (strict precedence, equal precedence rejected; remote-initiated requests arrive only over this channel, administrator switches only over `runtime.sock` and are not floor-bound), kills the current runtime and spawns the candidate with a fresh nonce.
5. The candidate rebuilds every session from ptyd, binds its gateway and reports `ready {nonce, sessions, gatewayPort}`. The launcher independently checks that the nonce is this spawn's, that every live session in ptyd's own list is among the reported ones, and that the gateway port accepts a TCP connection; only then is the process healthy. A self-reported ready alone never commits; alive-but-silent, a wrong nonce, a session not taken over or a gateway that does not listen are terminated at the end of the observation period and counted against the crash budget.
6. Repeated candidate crashes reaching the threshold trigger rollback to the previous version (or the builtin). On stable completion the launcher persists `runtime.active`, then `runtime.release-floor`, before committing. Pending candidates do not advance the floor. On restart the persisted active is re-observed as a candidate first; one that cannot pass falls back to the builtin.

Server pushes also have a per-daemon/version backoff cap to prevent repeated switching to the same bad version.

## 4. Security boundaries

- ed25519 separates permission to publish daemon binaries from control of the centre or download source. Without the release private key, arbitrary bytes cannot impersonate a valid upgrade artifact. This is not isolation from central control-plane authority. The public key is compiled into the runtime and distributed in the cofluxd npm package; the private key exists only in a protected environment secret.
- Tests may inject a temporary public key through `COFLUX_WORKER_PUBKEY` because the trusted local party already controls the machine.
- The runtime artifact has its own statement domain and carries no raw-binary signature: no pre-plan supervisor can verify, install or run one through any path, and a runtime `releaseSignature` never verifies against the worker-domain statement built from identical metadata. Old `cofluxd` fails closed on schema 3, so a headless machine upgrades the npm package first.
- `runtime.release-floor` uses strict SemVer precedence and constrains remote requests only; the launcher can still roll back internally, and local administrators remain responsible for switching known local versions.
- Host capabilities (`runtime_launcher_v1`, `transport_pair_v1`, `desktop_managed`) come from launcher-provided environment, never from the runtime's code, so a bare runtime started outside a launcher claims none of them.
- Download failure, hash/signature mismatch, persistence failure, or a candidate crash must not damage the current runtime or the PTYs.
- ptyd's `terminal-data` files are the one place raw terminal output is persisted: the directory and files are `0600`, each file is unlinked when its session ends, stale files are swept at ptyd startup, the total is bounded by the live-session limit times the ring size, and the directory is excluded from backups. Weakening any of these is a product decision, not a cleanup.

## 5. Relationship to the local-first data plane

- Raw PTY data is never sent to the centre.
- Local and native paths carry the same DeviceEnvelope; holder/sequence authority resides in sessiond.
- A runtime restart rebuilds channels/generations; clients resend unacknowledged input and sessiond's ptyd-backed cursors ensure each effect occurs once across the swap.
- Output gaps trigger reattachment for a sessiond snapshot.
- Checkpoints are disposable derived state, coalesced per session, and never backpressure PTYs.

## 6. Acceptance

The black-box harness launches real server, ptyd, launcher and runtime processes, isolated with temporary `COFLUX_HOME` (`tests/src/worker-upgrade.test.mjs`, `signed-upgrade.test.mjs`, `ptyd-custody.test.mjs`):

- Switching to a valid new runtime commits after observation and preserves sessions.
- A candidate crash loop triggers automatic rollback and preserves sessions.
- Candidates that are alive but silent, connect but never report, echo a wrong nonce, report none of ptyd's live sessions, or report a gateway port that does not listen never commit.
- A restart with the pointer on a pseudo-healthy version ends on the builtin.
- Valid signatures allow remote-download upgrades; tampering with SHA-256, size, version, target or the statement signature, and a worker-domain statement over identical metadata, are rejected while retaining the current version.
- Committed versions continue rejecting downgrades and equal-precedence replays after a launcher restart.
- Replacing or killing the launcher keeps every shell, byte-identical sequence numbers and the screen.

## 7. Delivery in production: discovery, dispatch and configuration

Moved here from RELEASING.md, which keeps the release procedure.

Paired updates require a launcher-started runtime advertising `transport_pair_v1` and `runtime_launcher_v1`. Devices without those capabilities must first install the complete release with `npm i -g cofluxd@latest && cofluxd update && cofluxd restart` (terminals kept). Subsequent runtime/helper updates arrive automatically; the sessiond rebuild pauses terminals briefly. Both artifacts must verify before their complete immutable version directory is published; candidate startup also requires a matching local helper handshake. See [Native Tailcat delivery and rollback](tailcat-transport.md#delivery-bootstrap-and-rollback).

1. The server discovers the latest stable release: from GitHub `/releases/latest`, which excludes prereleases/drafts, or, with `COFLUX_AUTOUPDATE_MIRROR_BASE` set (production since 2026-10-09), from the R2 mirror's `releases/latest.json` and `releases/<tag>/manifest.json`. It reads the release's `manifest.json` (schema 3 with a `runtime` component; schema 2 with a `worker` component is still understood) and caches it only when the release tag, top-level manifest version, and every target entry's shape agree. The artifact URLs it dispatches are the manifest's, which for a stable release point at the R2 download mirror (`dl.coflux.dev`); `mirror-upload` puts them there before the Release exists. See [R2 download mirror](RELEASING.md#r2-download-mirror-dlcofluxdev).
2. Each online daemon is compared immediately at handshake when reporting `workerVersion` (the runtime version) / `platform` / `arch`; a new release triggers another scan of all online daemons. The server still pushes on version inequality, sending `worker.upgrade{version,url,target,sha256,artifactSize,releaseSignature,transport}` (the message keeps its historical name; `signature` is empty for a runtime). A schema 3 runtime goes only to daemons advertising `runtime_launcher_v1` and not `desktop_managed`; a schema 2 worker only to daemons without the launcher capability. `clientUpgradeDaemon` is refused for desktop-managed and pre-launcher daemons.
3. The runtime requires canonical strict SemVer with a `v` prefix and a matching local Rust target. Before any network request, it rejects versions below or equal to the floor the launcher reported. It then downloads with bounds and checks signed size, SHA-256 and the release-statement signature. Only after every check passes is the artifact atomically installed under `~/.coflux/runtimes/<version>/`, and only then does the runtime ask the launcher to switch. Any failure preserves the current runtime.
4. The launcher re-checks the floor, kills the running runtime and spawns the candidate with a per-spawn nonce. A candidate becomes healthy only after the launcher has checked for itself that the candidate echoed that nonce, took over every live session in ptyd's own list, and listens on the gateway port it reports; the observation period then has to pass. Commit first atomically persists `runtime.active`, then `runtime.release-floor`. Floor-write failure prevents declaring commit and disables further remote upgrades for that process. A crash between the two writes is recovered by reconstructing/persisting the floor from the safely recovered active SemVer.
5. `runtime.release-floor` is the monotonic high-water mark of committed remote releases. It advances only after observation commits, never merely after download, verification, disk installation, or a failed pending candidate. SemVer build metadata does not affect precedence, so another build string at the same precedence is replay. Candidate failure still permits internal rollback to the old active version: the floor constrains subsequent **remote requests**, not safe rollback or local administrator switching.
6. Runtime switches leave the shells in ptyd untouched; sessiond is rebuilt from ptyd with a brief pause, attached clients reattach and holders are reclaimed. After failure, the previous runtime reconnects and reports the old version. The server counts attempts per `(daemonId, version)` and permanently stops pushing that version for its current lifetime after `COFLUX_AUTOUPDATE_MAX_ATTEMPTS`, preventing an endless rollback/retry/failure loop.

Without `COFLUX_AUTOUPDATE_REPO`, automatic updates are disabled. Manual `clientUpgradeDaemon` remains available for staged/emergency use (launcher daemons only). Only switching to a version the launcher already knows, with empty `url`, bypasses the remote trust chain.

Configuration in `apps/server/src/config.ts`: `COFLUX_AUTOUPDATE_API_BASE` defaults to `https://api.github.com`; `COFLUX_AUTOUPDATE_REPO` is `owner/repo`; `COFLUX_AUTOUPDATE_POLL_MS` defaults to 10 minutes; `COFLUX_AUTOUPDATE_MAX_ATTEMPTS` defaults to 3; `COFLUX_AUTOUPDATE_MIRROR_BASE` switches discovery to the mirror. The launcher version (`supervisorVersion` on the wire) is visible in device tooltips but is **not** automatically upgraded.

## 8. First cofluxd installation and launcher upgrades

Moved here from RELEASING.md.

The runtime updates itself; `cofluxd update` is for the launcher, ptyd and the CLI. It downloads every component, then `cofluxd restart` applies a changed launcher with terminals kept (ptyd and sessions stay); only `cofluxd restart --ptyd` ends terminals. The npm package embeds the same ed25519 public key as the runtime. Remote installation first requires the exact SemVer tag's schema 3 manifest, strict version/target/size/SHA-256 matching, and separate per-component release-statement verification; a schema 2 manifest is refused outright, and old cofluxd fails closed on schema 3 (upgrade the npm package first). Only after all supplied artifacts pass can one staging generation replace them. Releases before 1.1.0 may omit the native CLI; current releases include it. macOS local ad-hoc signing occurs only after verification. Old releases lacking supervisor entries fail closed without falling back to raw downloads. The latest stable release downloads from the R2 mirror and any other version from GitHub Releases; see [How clients choose](RELEASING.md#r2-download-mirror-dlcofluxdev).

`--bin-dir` remains an explicit local administrator choice for development/recovery, outside the remote trust chain. This remote installation chain applies from `cofluxd@0.12.0`; 0.11.x and earlier must upgrade the CLI first.

A newly started launcher takes the greater of its builtin runtime's strict SemVer and the existing `runtime.release-floor` as the initial remote rollback-prevention floor. Both embedded public keys must match; CI rejects drift. **Do not rotate the trust root directly**: old cofluxd/runtimes cannot accept releases signed only with a new key. First design and publish an old-key-authenticated dual-trust/handover release, then switch signing keys. Editing the two hex files alone is insufficient.

The first schema 3 release stopped automatic pushes to every pre-plan daemon; its release notes had to say that headless hosts run `npm i -g cofluxd@latest && cofluxd update && cofluxd restart` once, terminals kept, and that afterwards runtime updates arrive automatically.

## 9. Desktop-bundled daemon: release build and updates

Moved here from RELEASING.md. The app bundles `coflux-launcher`, `coflux-runtime`, `coflux-ptyd`, Rust `coflux`, Go `coflux-transport` and Swift `coflux-screen` under `Contents/Resources/daemon/`, preparing the local device automatically after login. Users no longer need Node or npm cofluxd. The reusable `desktop-release.yml` runs its `daemon` job before packaging/signing, building from the same SHA: `cargo build --release --target aarch64-apple-darwin -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd`. It also runs `scripts/build-transport.mjs` for the same target and version, producing the helper and dependency notices. Rust builds use `RUSTFLAGS=-D warnings` without `release-signing` or secrets. Artifacts pass to the packaging job; `scripts/stage-daemon.mjs` installs them under `build/daemon/` and restores mode 0755, since artifact transfer does not retain executable bits. electron-builder's `mac.binaries` applies Developer ID signing and hardened runtime to all four executables and includes them in notarization. Verification checks existence, `codesign --verify --strict`, and `Authority=Developer ID Application` for each.

- **Version stamp**: `COFLUX_RELEASE_VERSION=vX.Y.Z`, exactly matching the product tag, also written to the `VERSION` sidecar.
- **Updates**: the main app launches ptyd and the launcher with their original signatures; copying no longer triggers ad-hoc resigning. Components live in stable content-addressed directories. After an app update the app stages the bundled runtime and asks the running launcher to switch to it, with no click and terminals kept; a changed bundled launcher is replaced through `leave` + start, also with terminals kept; the launcher rolls a candidate that never passes its checks back to the previous version and the panel shows 「更新未能应用」 / 「重试」. Desktop-hosted daemons advertise `desktop_managed` and never accept centre pushes. Only a changed ptyd keeps the confirmed 「更新终端组件」.
- **Acceptance**: the production signed app must establish that only Coflux needs Full Disk Access, live shell PIDs/memory variables survive updates, and protected directories remain accessible afterward. Development signatures and socket black-box tests do not substitute. Isolate acceptance instances with `COFLUX_DESKTOP_USER_DATA` and `COFLUX_HOME`.
- Local `pnpm -C apps/desktop run pack` requires `COFLUX_DESKTOP_DAEMON_DIR` pointing to local Cargo artifacts; see apps/desktop/README.md. Missing input or any missing binary fails immediately. It produces unsigned `apps/desktop/dist/mac-arm64/Coflux.app` with fuses set and ad-hoc signing. Notifications/badges are reliable only in signed artifacts; Electron 42+ uses UNUserNotification on macOS. Failures in unsigned packages are not regressions.
- macOS users should now onboard through Coflux.app. `npm i -g cofluxd` remains the Linux/other-machine path. Migrating old services requires an app prompt; startup must not silently terminate existing sessions.

See [RELEASING.md](RELEASING.md) for release/key operations and [architecture.md](architecture.md) for the final authority/transport design.
