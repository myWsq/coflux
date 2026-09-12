# coflux roadmap / TODO

> Completed milestones and pending work. Discussion details are in [architecture.md](architecture.md), [auth-design.md](auth-design.md), and [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

## Completed

- **Native remote transport source migration** (September 2026): pinned Tailcat/Tailscale helper and self-hosted stock DERP replace custom relay/WebRTC. Control protocol floor 2 retires obsolete remote peers; DeviceEnvelope remains version 1. Swift/iOS remote connectivity is unavailable pending a native provider. This records source behavior, not a production rollout or a passed cold-attach latency gate.

- **V1 remote terminals and project organization**: Account → Device → Project (Git repository) → Workspace (main repository or another Git worktree) → Task → Session (PTY).
- **Tailscale-style authentication**: one-time browser authorization, per-device credentials with server-issued daemonId to prevent impersonation, and account isolation.
- **Exclusive control and handoff**: one controller per terminal at a time; attaching takes control.
- **Production hardening**: two review rounds plus an adversarial review resolved 30 confirmed issues, covering WS heartbeat, backpressure/flow control, graceful shutdown, crash handling, exponential reconnect backoff, store transactions, atomic cascading deletion, structured logs, and unified configuration.
- **General daemon primitives**: `exec`, `fs.list` / `fs.read`, and `fs.write`, with root anchoring and realpath traversal protection. `fs.write` also supports the daemon's system temporary directory. All now use DeviceEnvelope shared by local/native paths.
- **Binary data plane** (June 2026): PTY initially used center-routed protobuf; on 2026-07-25 it moved to end-to-end DeviceEnvelope. Central raw-PTY fields were removed and reserved.
- **Complete automatic hot upgrades** (June 2026, Option A; [design](hot-upgrade-design.md)): supervisor/worker split, all-Rust daemon without Node, UDS IPC and two-level resync preserving sessions across upgrades; version registry, observation-period switching and automatic rollback; remote downloads with component-separated ed25519 signatures binding version/target/SHA-256/size; persistent strict-SemVer rollback prevention rejecting invalid signatures, downgrades, and replays. This does not imply prevention of RCE after central compromise. The npm `cofluxd` CLI installs systemd/launchd services.
- **Release pipeline** (June–August 2026): strict SemVer `v*` tags trigger four-platform builds in release.yml, worker raw/release signatures, supervisor release signatures using protected environment secret `WORKER_SIGNING_KEY`, and schema 2 manifests. Supervisor and cofluxd embed the same public key. CLI verifies both daemon components and uses two floors to prevent remote downgrades. macOS artifacts receive Developer ID signatures and Apple notarization.
- **Multiple accounts and self-managed authentication/Postgres** (plans 001–002, 059–063; July 2026): retired early Supabase token exchange and managed Postgres. `local` mode uses environment credentials; `password` mode uses owned users/memberships with scrypt. Both issue coflux-owned session tokens. Business data lives in the `coflux` schema of self-hosted Postgres.
- **Device authorization** (plan 003, July 2026): daemons without enrollment keys use one-time authorization codes and the `/authorize` browser page.
- **Port-forward previews** (plans 004–007, July 2026): wildcard `*.p.coflux.dev`, account-level gate cookies and one-time codes, and byte-transparent TCP through daemon tunnels for HTTP/SSE/WS. Deterministic shortIds support bookmarks. On 2026-08-16 the preview domain flattened to `{shortId}-p.coflux.dev`: Cloudflare Universal SSL wildcards do not span dots, leaving the former nested wildcard without an edge certificate after proxying coflux.dev. Gate cookies moved to the parent domain. Since 2026-09-04, **only `*.coflux.dev` remains proxied** in the zone; api/app/m/apex use DNS-only records through owo-jp-gw, so preview routing was unaffected by the ingress migration.
- **Multiple terminal tabs per web workspace** (plan 008, July 2026).
- **Protobuf as protocol source of truth** (plan 009, 2026-07-15): Buf-managed `proto/` generates TS (protobuf-es), Rust (prost), and Swift (swift-protobuf). Wire messages moved to all-protobuf binary envelopes, retiring JSON. CI runs `buf lint`, `buf breaking`, and generated-output zero-diff checks. v0.3.0 was released and deployed to api/app.coflux.dev.
- **RavenJS server and repository-wide TypeScript 7** (2026-07-15): HTTP application code moved to `@raven.js/core` composition roots, plugins, and contract routes; WS/proxying remained transport concerns. The then-current strict-star topology including PTYs was superseded by local-first architecture on 2026-07-25. Postgres owns business metadata, not terminal authority.
- **Web stack and product structure redesign** (plans 010–012, 2026-07-16–17): Cursor-style dense workbench rewrite, ultimately React 19 with React Compiler; Astryx design system; two-step project import from online device to remote file tree.
- **Web terminal interactions** (plans 013–016, 019; 2026-07-19–20): xterm 6.0 alignment; compressed clipboard images written to remote temporary storage through `fs.write`, with paths injected into agents; global shortcuts/help; automatic refit on cell-metric drift; clickable terminal URLs; ports grouped through PlugZap + HoverCard with navigation.
- **Worker automatic-update orchestration** (plan 017, 2026-07-20): daemon reports worker/supervisor versions and architecture; server polls stable GitHub Releases/manifests and dispatches worker updates to online daemons, with capped per-device/version failure backoff. Supervisors remain manually upgraded through `cofluxd update`.
- **Device identification and management** (plan 018, 2026-07-20): web device renaming persisted/broadcast by the server, immediate online synchronization, and reconnect catch-up to local `settings.json`; device tooltips show both versions.
- **Black-box integration tests** (`tests/`, resilient to refactoring): real-process coverage for authentication/account isolation, project-worktree-task-session lifecycle, local/native channels, stock DERP, actual center outages, input/session lifecycle deduplication and worker mutation deduplication during a worker lifetime, VT oracles, checkpoints, two-level resync, cross-daemon security, handoff, hot upgrades/signature adversarial tests, port forwarding, path safety, malformed wire messages, and graceful shutdown.
- **Production deployment**: center prod-jp on Debian/systemd/self-hosted PG17; public ingress at owo-jp-gw since 2026-09-04 (plan 089), replacing Cloudflare proxying with DNS-only direct routing; relay on prod-bj. See [deployment.md](deployment.md) for topology, domains, secret locations, and rollback. `scripts/prod-smoke.mjs` uses the real protocol and native device path without persisting local grants.
- **Local-first session authority** (plans 036–042, 040–041; 2026-07-25): supervisor/sessiond owns PTYs, VT/history, holder, sequence, and tombstones. Web cached direct uses `127.0.0.1:8788`, falling back to opaque relay. Loaded/paired pages retain list/attach/input/resize/stop during center outages. Input and session create/stop deduplicate across worker replacement, not supervisor/OS restart; snapshots heal output gaps. Removed server xterm live mirrors, raw replay, viewer/holder, global pause, and server-routed exec/fs. Mobile received only an internal relay-only migration, without new features.
- **Independent VT and performance release evidence** (2026-07-25): dual xterm 6 oracles and sanitized Claude/Codex/Vim fixtures. Apple M1 Pro debug build, 2,000 history lines, 20 warmups and 100 samples: echo p95 0.589ms, attach+xterm p95 64.820ms, zero central relay frames in the timed direct path. Fidelity guarantees and exclusions are in [architecture.md](architecture.md#6-attach-and-state-recovery).
- **Server terminal mirror (historical, superseded)** (2026-07-19, 69e132a/d8b3237): `@xterm/headless` previously consumed raw PTYs to reduce attach latency. This placed the center in the terminal hot path and was replaced by sessiond snapshots and bounded derived checkpoints; server xterm dependencies and the old protocol were removed.

## Pending

### 1. Productizing desktop (primary client: `apps/desktop`, since 2026-09-11)

> The everyday client is the Electron desktop app, the only frontend; see item 4. Online web/mobile clients are frozen, with device authorization, MCP OAuth consent, and port-preview access as satellite-page flows. Product positioning is settled: **an agent command center**, organized around running claude/codex tasks in workspaces across devices, with human supervision and takeover at any time. Terminals remain the main interface, but tasks—not connections—organize the product. Detailed features/interactions await product-design discussion.

**Known issues and refinements, updated through 2026-07-25:**

- [x] Frequent terminal misalignment: no longer reproduced after xterm 6.0 (user confirmed 2026-07-19).
- [x] Image copy/paste: upload browser clipboard images to daemon temporary storage and inject remote paths (plan 014).
- [x] Terminal styling: font size 13→12 for visual balance with page UI (0f1256b, user confirmed 2026-07-19).
- [x] Project import: online-device → remote-file-tree wizard (plan 012).
- [ ] Improve device onboarding: install `cofluxd`, authorize in browser, come online.
- [x] Basic port-preview interaction: aggregate all ports in terminal tabs and open previews directly (plan 019).
- [x] Terminal recovery performance: sessiond snapshot + cached direct achieved attach+xterm p95 64.820ms (2026-07-25).
- [x] Current local-first browser release gate: physical macOS Chrome acceptance for cached direct, first relay+pair, permission denied, fallback/promotion, worker restart, and server outage. Per 2026-07-25 decision, Safari/Firefox are not blocking gates; their usability remains unknown.
- [x] Git diff display: workspace line counts `+X −Y` (plan 024).
- [x] Global shortcuts and help panel (plan 015).
- [ ] Improve login/device-authorization UI.
- [ ] Refine project/device presentation; renaming, online status, and version tooltips are complete.

### 2. Extend daemon primitives as needed

- [x] `fs.write`: root-anchored writes and daemon temporary-directory mode (plan 014).
- [ ] `fs.watch`: filesystem change watching, requiring native daemon watchers.

### 3. Product/deployment (see OPEN_QUESTIONS)

- [x] Multiple terminals/sessions per workspace (B4): implemented on web (plan 008).
- [x] Worker automatic updates: stable-release delivery with failure backoff (plan 017).
- [ ] Agent integration (B5): optionally start `claude` / `codex` with a prompt when creating tasks, retaining human takeover.
- [ ] Retention/GC policy for accumulating exited tasks.
- [ ] Multiple central instances and shared state. Current product is single-instance; no Redis, leader election, or shared presence without a concrete need.
- [x] Standalone relay, first slice (plan 043, 2026-07-25): single `crates/relay` binary and on-demand rendezvous dialing. Data no longer traverses central control WS; relay deploys independently with no central connection, sharing only the signing key pair.
- [x] Standalone relay, second slice (plan 065, 2026-07-29): center distributes a static node list; daemon samples `/healthz` RTT repeatedly, selects a home with hysteresis, and periodically reprobes. After reporting, rendezvous points both client/daemon to the same home; absent reports fall back to the first list entry. Relay nodes do not interconnect; client/web/iOS neither receive the list nor probe.
- [x] P2P direct, first slice (plan 076, 2026-08-16): end-to-end WebRTC DataChannel uses the direct slot, prioritized loopback > P2P > relay with shared promotion. Vanilla ICE signaling follows the central rendezvous triangle. Worker uses webrtc-rs and fragmented streams for 30MiB frames. Four end-to-end black-box cases verify cross-stack werift interoperability. This historical implementation has been retired in favor of native Tailcat/Tailscale networking; see the current transport contract.

### 4. macOS client: Electron (plan 103, 2026-09-11)

> Three native Swift efforts failed to reach parity (2026-07-15, 2026-08-25, 2026-09-05). The third `apps/macos` effort merged into main on 2026-09-10 with plan 100 incomplete. On 2026-09-11, the user chose Electron; plan 106 the same day established **desktop-only iteration**. `apps/desktop` is the only frontend, with React 19/xterm in `src/renderer` under alias `@`, a mandatory `window.cofluxDesktop` bridge, and no browser fallback. Server/daemon validation remains strict; the main process rewrites WS Origin to `https://desktop.coflux.dev`. `apps/macos`, web, and mobile projects now exist only in history, split baseline `ce7026b`. `packages/swift-client` remains for iOS only.

- [x] Electron shell and custom scheme serving the renderer from asar; cold-start access to local terminals through loopback direct even when the center is offline.
- [x] Native menus, pure ⌘ shortcuts, system notifications/Dock badges for agents awaiting approval/answers, notification-driven workspace focus, and all external links in the system browser.
- [x] Protocol-version admission (plan 105), replacing launch-day lockstep: only breaking protocols show Update Required and trigger electron-updater. `desktop-v*` tags produce signed/notarized GitHub Releases and update manifests on `desktop-updates`.
- [x] Retiring web, first slice (plan 106): renderer merged into `apps/desktop`, web/mobile source removed, mandatory bridge, safeStorage tokens, persistent window size/position, electron-log main-process logs, and no web entry in Help.
- [x] Second slice (plan 107, 2026-09-11): server-rendered `/authorize/<token>`, `/oauth/consent`, and `/proxy-auth` with short-lived in-memory page sessions, CSRF, PRG, and source-based login limits. Links derive from `COFLUX_PUBLIC_URL`; `COFLUX_WEB_URL` is retired. Frozen web bundles remain only legacy workbenches with no server links.
- [ ] **Third slice: deeper native desktop integration.** Independent plans, chosen as needed; the first two slices established Electron as the sole frontend. These capabilities are desktop-specific:
  - [ ] `coflux://` deep links: authorization links printed by `cofluxd up`, notifications, and Return to App from MCP consent should launch desktop. Authorization can complete in-app, retaining server pages as the no-app fallback. Plan 103 reserved but did not claim the scheme.
  - [ ] Local daemon via main-process UDS: renderer reaches supervisor UDS through the main process, sharing the trust boundary of zero-credential local cofluxd commands, removing browser-identity/grant management for loopback WS. Remote daemons use the native Tailcat helper. Analyze security separately; do not relax Origin validation incidentally.
  - [ ] Terminal renderer: evaluate ghostty-web or another native-grade replacement for xterm.js/WebGL. See docs/OPEN_QUESTIONS. An equivalent of the Chinese IME patch `patchImeCommittedInput` in `terminal-pane.tsx` is a prerequisite.
  - [ ] Simplify server admission: build-ID admission through `COFLUX_BUILD_ID` / `COFLUX_BUILD_ID_FILE` now serves only frozen web/mobile. Remove it and `client_kind=web` when those sites retire, retaining control-protocol admission only.
  - [ ] `app.coflux.dev` download page: after retiring the frozen workbench, replace `/` with static desktop downloads/release notes served by Caddy.
- [ ] Initial release acceptance by the user: CI-signed artifact passes Gatekeeper, all three transport paths work together with direct proven using lsof, and notifications/badges work in signed packages.
- [ ] Later: universal/x64 build switch and Windows/Linux portability.
