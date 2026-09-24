# Plan 20260924-remote-localhost-tunnel: A remote workspace's browser tab reaches that device's localhost

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat d44c54f1..HEAD -- proto crates/protocol crates/worker packages/protocol packages/swift-client/Sources/CofluxProtocol apps/desktop/src docs/tailcat-transport.md`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH — new wire messages, a worker capability that dials the device's loopback ports, and a local proxy in the desktop main process
- Depends on: wiki/plans/20260924-desktop-browser-tab.md (DONE at `166b7b68`)
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore` (covers both slices)
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: current — already in the linked worktree `.claude/worktrees/20260924-desktop-browser-tab` on `dev/20260924-desktop-browser-tab`
- Planned at: `d44c54f1`, 2026-09-24

This is **slice 2 of 2** of the built-in browser tab. Slice 1 (`20260924-desktop-browser-tab`) shipped the tab itself; for a remote workspace it blocks every loopback request and shows a "not supported yet" page. This slice replaces that block with a real path to the remote device.

## Requirement

In the desktop app, a browser tab belongs to a workspace, and `localhost` in that tab means **the device the workspace lives on** (product conclusion 3 of slice 1, confirmed by the user). For a workspace on this Mac that already works. For a workspace on another device, slice 1 refuses loopback requests (`apps/desktop/src/main/browser-host.ts:282-294`, `browser-view.tsx:258-262` and `:405-408`). After this slice, `http://localhost:5173` typed into a remote workspace's browser tab shows the dev server running on that remote device, with the same URL and Origin as on the device itself, and its HMR WebSocket works.

Product conclusions that apply (settled, do not reinterpret):
- `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]` and `0.0.0.0` (already rewritten to `localhost` by slice 1) all reach the **remote device's** loopback, on the port in the URL. Every other host goes to the network from this Mac, as in any browser — and through this Mac's system proxy settings when there are any (the user runs Surge).
- The address bar shows the URL exactly as typed / as printed in the device's terminal; the page's Origin is `http://localhost:<port>`, so OAuth callbacks, CORS and secure-context rules behave as they do on the device.
- Three failure pages, each with 重试: **device offline or unreachable** (设备离线或无法连接), **nothing listening on that port on the device** (设备上的 localhost:<port> 没有服务在监听), **the device's coflux is too old for this** (该设备的 coflux 版本过旧，更新后才能在内置浏览器中访问它的 localhost). Slice 1's "not supported yet" page goes away (it becomes the "too old" page when that is the cause).
- Everything else about the tab (toolbar, persistence, per-workspace cookies, bookmarks, DevTools) is slice 1's and unchanged.

Observable when done: on a remote workspace, run `pnpm dev` in its terminal, right-click the `localhost` URL → 在内置浏览器中打开 → the page loads in the tab and edits on the device hot-reload it; a public site still loads in the same tab (also with Surge's system proxy on); stopping the dev server and reloading shows the "nothing listening" page; a device whose worker predates this change (but already speaks Tailcat) shows the "too old" page immediately (no multi-second wait); a device that is offline shows the offline page. A worker so old that it has no Tailcat endpoint at all is indistinguishable from an offline device at the centre (both answer 设备尚未提供原生远程连接, `apps/server/src/tailcat-rendezvous.ts:65`) and shows the offline page — accepted. (revised on plan audit)

## Decisions & tradeoffs

- **The tunnel is a device-protocol capability on the existing Tailcat device channel, not a new transport and not the central port proxy.** New `DeviceEnvelope` payloads (next free oneof numbers after 75, e.g. 80+) carry: open a TCP connection to a loopback port of the device (client → worker, with a client-chosen connection id), opened / failed (worker → client, with a failure reason that distinguishes "connection refused" from other errors), data in both directions, a flow-control acknowledgement in both directions, and close in both directions. Additive only: `DEVICE_PROTOCOL_VERSION` stays 1, no field is renumbered or reused (`scripts/check-protocol-breaking.mjs` has no exceptions). Rejected: the central port proxy (`apps/server/src/proxy.ts`, `<device>-<port>-p.coflux.dev`) — the bytes would detour through the centre (against the local-first rule that operations reachable without the centre never go through it), only detected ports are routable, and the Origin would be the preview domain, not `localhost`; a new Tailcat-level stream kind or helper change — the helper deliberately has "no public local listener, … generic proxy" (`docs/tailcat-transport.md:23-27`) and authority lives in the worker's DeviceEnvelope gate, not in the helper.
- **Required scope is the existing `DeviceScope.RPC`; the centre is not changed.** `RPC` already allows `exec` of arbitrary commands on the device (`proto/coflux/v1/device.proto:100-101`, `crates/worker/src/device.rs:3938-3941`), so reaching the device's loopback grants nothing new. The server already grants `RPC` to a client's Tailcat request (`apps/server/src/tailcat-rendezvous.ts:10`, `:66-70`). Every new client-initiated payload maps to `Rpc` in `required_scope`, and every new worker-initiated one in `response_required_scope` (`crates/worker/src/device.rs:3928`, `:3959`); without the mapping the worker answers `unsupported_payload` (`device.rs:1882-1890`). Rejected: a new scope — it would need a server release and a grant-protocol change for no security gain.
- **The worker dials only its own loopback.** Target = `127.0.0.1:<port>`, falling back to `[::1]:<port>` when IPv4 is refused (Vite and others often bind only `::1` for `localhost`); ports 1–65535; never a hostname, never a non-loopback address — the client sends a port, not an address. Rejected: letting the client name a host — the worker would become a pivot into the device's LAN.
- **Flow control never drops bytes.** The worker's per-channel outbound queue is non-blocking and bounded (`ChannelSink::try_send`, `device.rs:635-661`; `CHANNEL_QUEUE_RECORDS` 256 and `CHANNEL_QUEUE_BYTES`, `device.rs:35-36`; shared `GLOBAL_CHANNEL_QUEUE_BYTES`, `:39`) — PTY output survives a full queue through gap frames, a TCP stream cannot. So each tunnel connection uses credit-based flow control in each direction: a sender never has more than a fixed window of unacknowledged bytes in flight, and stops reading its socket until credit returns. If the worker still cannot enqueue a frame, it closes that tunnel connection (both ends see a close) — it never silently drops or reorders data. The real shared bottleneck is further down: the worker's Tailcat channel loop pushes each queued frame into the helper with `helper.send` and breaks (closing that channel) when it fails (`crates/worker/src/tailcat.rs:472`), and `helper.send` writes to one `out` queue of 256 records shared by **every** stream of the helper, with one 128 MiB byte budget shared by inbound and outbound (`crates/worker/src/tailcat_ipc.rs:14`, `:65`, `:126-128`, `:299-318`). Tunnel frames filling `out` would make the *next* channel's send fail — possibly a renderer PTY lane. Therefore the worker→client direction also has an **aggregate** cap: all tunnel connections of a lane together never have more than a fixed number of data frames in flight (at most a quarter of that 256-record queue, e.g. 64), enforced by the client's total credit; and on the worker, `helper.send` returning false on the tunnel lane is fatal for that lane (all its connections close) as it already is for any channel. Frame and window sizes are the executor's call within those bounds; state them in the code. Per-channel and per-worker caps on concurrent tunnel connections exist and are enforced; closing the channel closes all of its tunnel connections (`close_channel`, `device.rs:1009-1013`, and the remote-close paths after it). Client→worker: `handle_client_frame` is synchronous and runs on the channel's task (`device.rs:1817`, `tailcat.rs:471`) — writes to a TCP socket go through a bounded queue per connection and a full queue closes the connection; never await or block there. (revised on plan audit)
- **The main process owns the tunnel, on a lane of its own.** Electron main opens an `RPC`-scoped lane per remote device through the existing `NativeTailcatTransport` (`apps/desktop/src/main/tailcat-transport.ts`), which already holds the helper, the control WebSocket and the HMAC proof (`:94-151`). It uses its own `clientInstanceId` (a random id per app run) and a positive generation; the worker checks those two only for session attach (`device.rs:1902-1903`), and the server only validates their shape (`tailcat-rendezvous.ts:66`). One lane per device carries every tunnel connection of every workspace on that device (multiplexed by connection id); the lane is opened lazily on demand, reopened with exponential backoff after a failure, and closed after an idle period. The renderer owns the transport's online state: `open()` requires `online` (`tailcat-transport.ts:95`), which only the renderer sets over IPC (`tailcat-ipc.ts:20`); every central disconnect makes it call `control(false,false)`, which closes all non-session lanes at once (`tailcat-transport.ts:167`, `packages/client/src/device-router.ts:2333`), and an auth failure closes the transport (`device-router.ts:2350`). Main never sets `online` itself; a closure caused by these signals is routine; a request that arrives while offline maps straight to the offline page. `NativeTailcatTransport` gets a second open entry for **owned** lanes that takes its own `{ frame, closed }` callbacks: an owned lane's frames, close and path events never go through `emit`, and its frames are acknowledged synchronously inside the frame callback (bytes handed to the connection's own queue, throttled by tunnel credit, not by the lane budget of 256 records / 32 MiB, `tailcat-transport.ts:131`). A frame leaked to the renderer would be double-acknowledged by the preload (`apps/desktop/src/preload/index.ts:61`) and break the lane's record accounting (`tailcat-transport.ts:156`). On the desktop side, `helper.send` returning false (stdin backlog over 128 MiB, `apps/desktop/src/main/tailcat-helper.ts:71`) is fatal for that lane. (revised on plan audit) Rejected: routing tunnel bytes through the renderer's device router — the proxy runs in main, the renderer is rebuilt on ⌘R, and every byte would cross IPC twice. **This deliberately overturns an earlier rule of thumb** ("the main process has no device channel; device.proto stays untouched", recorded for the executor-settings work of 2026-09-18): that rule held because a file-level substitute existed there; a browser's TCP stream must terminate in main's proxy, and there is no file-level substitute.
- **Main's lane frames never reach the renderer.** `NativeTailcatTransport` today emits every lane frame to the renderer (`emit({ kind: "frame", … })`, `tailcat-transport.ts:131`) and frees a lane's receive budget only when the renderer acknowledges (`acknowledge`, `tailcat-ipc.ts:16`; budget: 32 MiB / 256 records per lane, `:130`). A main-owned lane is consumed and acknowledged inside main; the renderer never sees its frames or its handle.
- **Unsupported workers are recognised immediately, never by timeout.** A worker that predates the new payloads decodes them as an empty oneof and answers `DeviceError { code: "empty_payload", request_id: None }` (`device.rs:1850-1857`). Main's lane carries only tunnel traffic, and the match is exact: `code === "empty_payload"` with no `request_id` means "unsupported". Other request-id-less errors on the same lane (`scope_denied`, `unsupported_payload` from the scope gate, `device.rs:1875-1889`; `invalid_request_id` if a tunnel payload is mis-routed into the request/response path, `device.rs:2529-2539`) are bugs or grant problems, not "too old" — log them and fail the affected opens as unreachable. On "unsupported": mark the device unsupported (until the lane is reopened later, e.g. after a worker upgrade), fail every pending open on it with the "too old" reason. Rejected: the 15-second dial deadline as the signal.
- **Remote partitions go through a local proxy in main, installed at prepare time.** Slice 1's prepare hook (`browser-host.ts:305-322`) is where the partition's network path is set, before the renderer inserts the webview (`browser-view.tsx:337-341` inserts only after `prepared` resolves). For a remote partition: `await session.setProxy({ mode: "fixed_servers", proxyRules: <that partition's proxy endpoint>, proxyBypassRules: "<-loopback>" })`, then `await closeAllConnections()` — and `prepare` resolves only after both have resolved (a fire-and-forget `setProxy` would type-check and race the first navigation). (revised on plan audit) `<-loopback>` is required — Chromium otherwise bypasses any proxy for loopback implicitly, and a PAC script cannot override that (Chromium `net/docs/proxy.md`, "Implicit bypass rules"). A local partition keeps the default (system) proxy settings. When a partition's mode flips (slice 1 already re-announces mode when the local daemon id arrives, `browser-host.ts:191-199`), its proxy configuration flips with it, followed by `closeAllConnections()`. Slice 1's `onBeforeRequest` loopback block is removed for partitions that have the proxy (keep it only as the fallback when the proxy could not be started). Rejected: a PAC script (cannot route loopback), and `protocol.handle`-style interception (cannot carry WebSockets, which HMR needs).
- **The proxy speaks both forms Chromium uses.** Through an HTTP proxy, Chromium sends `CONNECT host:port` for https, wss **and ws://**, and an absolute-form request (`GET http://localhost:5173/x HTTP/1.1`) for plain http. The proxy must implement both: CONNECT splices the client socket onto a tunnel connection (or the upstream path below); a plain-http request is forwarded with its request line rewritten to origin-form (`GET /x`) and `Proxy-*` headers removed — dev servers route on `req.url` and break on absolute-form. Keep-alive and request bodies must work.
- **Non-loopback traffic is forwarded along this Mac's system proxy.** Every request of a remote partition now passes through main's proxy. For a non-loopback target the proxy asks `session.defaultSession.resolveProxy(url)` and follows the first entry it supports: `DIRECT` → connect directly; `PROXY h:p` (and `HTTPS h:p` if easy) → chain via CONNECT; `SOCKS5 h:p` / `SOCKS h:p` → chain via SOCKS5. Rejected: always connecting directly — with Surge (or any system proxy) on, sites that only work through it would fail in the tab but work everywhere else.
- **One private, authenticated proxy endpoint per remote partition; the port is the routing key.** Each remote partition gets its own listener on `127.0.0.1` (ephemeral port) and its own random credentials; the port a connection arrives on identifies the partition, hence the workspace, hence the device. A request without valid `Proxy-Authorization` gets `407 Proxy Authentication Required` with `Proxy-Authenticate: Basic realm="coflux"`; main answers the `app` `login` event only when `authInfo.isProxy` is true and `authInfo.host`/`authInfo.port` is one of its own listeners, with that listener's credentials — never on the strength of the `webContents` argument, which may be null. Listeners close when their partition stops being remote or the app quits. Rejected: an unauthenticated listener — any local process could reach the remote device's ports through it; one shared listener routed by credentials — `login`'s `webContents` can be null, so partition identification would have a hole. (revised on plan audit)
- **Failures surface as the renderer's error pages, not as proxy responses.** For a plain-http request whose tunnel cannot be opened, the proxy must not answer with an HTTP error body — Chromium treats a non-CONNECT proxy's response as the page and `did-fail-load` never fires. It drops the connection instead (CONNECT failures may answer a non-2xx status, which Chromium reports as a tunnel failure). Main records the last failure reason (`offline`, `refused`, `unsupported`) per partition and port; the renderer's `did-fail-load` handler (`browser-view.tsx:388-414`) **asks** main for it (an `invoke`) for a loopback URL in a remote workspace and picks the matching page. Rejected: main pushing the reason — the push and the webview's `did-fail-load` arrive on different paths in no guaranteed order, so the generic network page would win intermittently. The proxy classifies loopback targets (CONNECT host and absolute-form URL alike) with slice 1's shared classifier (`apps/desktop/src/shared/browser-loopback.ts`, which also counts `0.0.0.0` and `[::]`), never a second copy. (decided while planning; revised on plan audit)
- **No black-box test.** A broken tunnel is visible the first time the tab is opened (AGENTS.md "Test harness"). Unit tests cover the pure parts: proxy request parsing / request-line rewriting, `resolveProxy` answer parsing, the connection-id and flow-control state machine on both sides, the unsupported-worker classification, and the worker's port/target validation.

## Direction

Boundaries: `proto/` defines the messages; generated code for TS, Rust and Swift is regenerated and committed; the worker implements the loopback dialer and the per-channel connection table; the desktop main process implements the lane client, the proxy and their wiring into slice 1's browser host; the renderer only maps reasons to error pages. The server does not change.

### Milestone 1: Wire messages

The new payloads exist in `proto/coflux/v1/device.proto` with comments stating direction, required scope and flow-control semantics; `cd proto && buf lint && buf generate` regenerates `packages/protocol/src/gen`, `crates/protocol/src/gen` and `packages/swift-client/Sources/CofluxProtocol/Generated`, all committed; the breaking check passes against the planned SHA. Validation: `cd proto && buf lint` exit 0; `buf generate` then `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` empty after commit; `node ../scripts/check-protocol-breaking.mjs "../.git#ref=d44c54f1,subdir=proto"` (from `proto/`) exit 0; `cargo test -p coflux-protocol` pass.

### Milestone 2: Worker loopback tunnel

The worker accepts the new client payloads under `Rpc`, dials only loopback, relays bytes with the flow control above, reports refused vs other failures, enforces the caps, and tears everything down with the channel. Validation: `cargo build` with zero warnings; `COFLUX_HOME= cargo test -p coflux-worker` pass (new unit tests included).

### Milestone 3: Desktop tunnel client and proxy

**First, before writing the rest of this milestone**: the whole proxy design rests on `<-loopback>` being honoured for a `persist:` partition in Electron 44 (it is Chromium bypass-rule syntax passed through; Electron's docs list only `<local>`). A delegated executor cannot run the app, so it states this as the first item of its report; the orchestrator confirms it at acceptance (a remote partition's request to `http://localhost:<port>` arrives at main's proxy). If it does not hold, that is a STOP.

Main opens and reuses one `RPC` lane per remote device, multiplexes connections, recognises unsupported workers immediately, runs the authenticated proxy (CONNECT, plain http with origin-form rewrite, system-proxy chaining for non-loopback), configures remote partitions at prepare time and on mode flips, answers the proxy `login`, and reports failure reasons; the renderer shows the three pages. Validation: `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop test` (count grows), `pnpm -C apps/desktop build` → exit 0.

Milestones are sequential: 2 and 3 consume 1's generated code; 3 can be written without 2 but is only meaningful against it. One work package — do not fan out.

## Landmines

- **Generated code in three languages.** CI fails if any of the three generated trees differs after `buf generate` (`.github/workflows/ci.yml:115-124`). Swift code is not built in CI; its `switch payload` statements all have `default` cases (`packages/swift-client/Sources/CofluxClientCore/DeviceRouter.swift:267, 689, 835, 1515, 1648`), so new oneof members should compile — do not touch Swift sources beyond the generated directory.
- **The worker's dispatch order.** After the scope gate, request/response payloads go through `request_id` validation; executor frames are consumed before it because they carry no `request_id` (`device.rs:1891-1900`). Tunnel frames must be taken out right after the scope gate the same way. If they fall through, `request_id` is `None`, validation lets it pass (`device.rs:1927-1929`), and `dispatch_worker_request` answers `DeviceError{code:"invalid_request_id", request_id: None}` (`device.rs:2529-2539`) — which looks almost like the old-worker signal; only the code differs.
- **`crates/worker/src/tunnel.rs` already exists** and is unrelated: the TCP bridge of the *central* port proxy (server WebSocket lifecycle, `ProxyData`, dials only `127.0.0.1`, no IPv6 fallback, no per-connection flow control). Use it at most as a reference for dialing and read pumps; do not wire its `TunnelSet` into the device channel, and name the new module so the two cannot be confused.
- **Renderer reload and backoff.** ⌘R's renderer reset calls `nativeTransport.close()` (`apps/desktop/src/main/index.ts:452`), which bumps the epoch and kills the helper but leaves `online` as it was (`tailcat-transport.ts:177-181`); a proxy request arriving during the reload would make `ensure()` start a new helper and control WebSocket that the reloading renderer may close again. Lane reopening must back off so a reload never turns into a grant storm.
- **A worker-side `try_send` failure is data loss** unless it closes the connection (see the flow-control decision).
- **`::1`-only listeners**: dial IPv4 first and fall back to IPv6 on refusal, and report "refused" only if both refuse.
- **The renderer owns `online`.** Main has no right to set the transport online; after a reset or a central disconnect, no stale lane or connection state may survive, and a later request (once the renderer reports online again) must reopen.
- **Test placement.** `pnpm -C apps/desktop test` runs only the globs in `apps/desktop/package.json:13` (`src/main/*.test.ts`, `src/shared/*.test.ts`, `src/renderer/*.test.ts`, flat `components/{settings,workbench}/*.test.ts`, `test/*.test.ts`); a test elsewhere silently never runs. `buf generate` uses remote plugins and needs network access.
- **Rendezvous rate limit**: the server allows 32 grant requests per second per client connection (`tailcat-rendezvous.ts:142-147`), and main's control WebSocket is its own connection. Reopen lanes with backoff; never one grant per TCP connection.
- **Proxy authentication round trip**: Chromium sends the first request without credentials and expects a 407 before `login` fires; answer 407 correctly for CONNECT and for plain requests.
- **Remote partition = every request through main.** The proxy is on the hot path of every page load in a remote tab; do not buffer whole bodies, stream them.
- **`docs/tailcat-transport.md:101-105`** says an address alone conveys no business authority and remote streams never acquire more than their grant — still true; update the doc's authorization section to record that `RPC` now also covers loopback TCP to the device, and why that is not an escalation.
- **Release order**: the worker (hot upgrade, `v*` tag) must reach a device before the desktop that uses it can show more than the "too old" page. The server is unchanged. Say so in the release note.

## Scope

In scope:
- `proto/coflux/v1/device.proto`
- generated code: `packages/protocol/src/gen/**`, `crates/protocol/src/gen/**`, `packages/swift-client/Sources/CofluxProtocol/Generated/**`
- `crates/protocol/src/**` (only where a hand-written file must acknowledge the new variants, e.g. `wire_tests.rs`)
- `crates/worker/src/**`
- `apps/desktop/src/{main,shared,preload,renderer}/**`
- `docs/tailcat-transport.md` (authorization section)
- `wiki/plans/README.md`, this plan

Out of scope:
- `apps/server/**` — no grant or scope change
- `crates/supervisor/**`, `transport/**` (the Go helper) — the helper stays a byte pipe
- `packages/client/**`, `packages/swift-client/Sources/**` outside `Generated` — the renderer's device router and iOS never send these payloads
- `tests/**` — no black-box test (see decisions)
- Slice 1's product behaviour beyond the error pages

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies (if missing) | `pnpm install --frozen-lockfile` (repository root) | exit 0 |
| Protocol lint | `cd proto && buf lint` | exit 0 |
| Codegen consistency | `cd proto && buf generate`, then `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | empty once committed |
| Breaking check | from `proto/`: `node ../scripts/check-protocol-breaking.mjs "../.git#ref=d44c54f1,subdir=proto"` | exit 0 |
| Rust build | `cargo build` | exit 0, zero warnings |
| Rust tests | `cargo test -p coflux-protocol` and `COFLUX_HOME= cargo test -p coflux-worker` | pass |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Wire contract (protocol touched) | `pnpm -C tests test` | pass (the suite covers the exec/fs contract, signing, hot upgrade — it guards against collateral breakage; it has no tunnel test) |
| Remote walkthrough (acceptance) | a remote device running this branch's worker; `pnpm dev:desktop:prod`; the "observable when done" list above, with and without the system proxy | holds |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] New payloads are additive; `DEVICE_PROTOCOL_VERSION` unchanged; breaking check passes; generated trees committed and consistent.
- [ ] Every new client payload requires `Rpc`; an unmapped one would be refused — covered by a worker unit test.
- [ ] The worker dials only `127.0.0.1` / `[::1]`, IPv6 as fallback, and distinguishes refused from other failures — unit-tested.
- [ ] Neither side ever drops or reorders tunnel bytes: senders respect the window; a full worker queue closes the connection — unit-tested on the worker side.
- [ ] The worker never has more than the stated aggregate number of tunnel data frames in flight per lane, and a failed `helper.send` closes the lane — unit-tested.
- [ ] Tunnel payloads are handled right after the scope gate and never reach the request/response path.
- [ ] Closing the channel closes all its tunnel connections; caps on concurrent connections are enforced.
- [ ] Owned lanes: frames, close and path events never go through `emit` — proven by a unit test in `apps/desktop/src/main/tailcat-transport.test.ts`; frames are acknowledged inside the owner's callback.
- [ ] Main never sets the transport online; lane reopening backs off.
- [ ] Exactly `DeviceError{code:"empty_payload", request_id: None}` on main's lane marks the device unsupported at once; pending opens fail with that reason; other request-id-less errors do not.
- [ ] `prepare` for a remote partition resolves only after `setProxy` and `closeAllConnections` resolved; each remote partition has its own listener; `login` is answered by `authInfo.isProxy` + listener host/port, never by webContents.
- [ ] The renderer pulls the failure reason in `did-fail-load`; main keeps it per partition and port.
- [ ] The report opens with the `<-loopback>` assumption, and the orchestrator confirms it at acceptance.
- [ ] The proxy rejects unauthenticated requests with 407, serves CONNECT and plain http (origin-form rewrite, `Proxy-*` stripped), streams bodies, and follows `resolveProxy` for non-loopback targets (DIRECT, PROXY, SOCKS5) — the parsing/rewriting parts unit-tested.
- [ ] Remote partitions get `fixed_servers` + `<-loopback>` before their first navigation and on every mode flip, with `closeAllConnections`; local partitions keep system settings.
- [ ] A plain-http tunnel failure never renders a proxy-made body; the renderer shows offline / refused / too-old pages correctly.
- [ ] `docs/tailcat-transport.md` authorization section updated.
- [ ] Implementation follows every entry in Decisions & tradeoffs; no out-of-scope files changed; `wiki/plans/README.md` updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. the server no longer grants `RPC` to Tailcat clients, or an old worker no longer answers unknown payloads with `empty_payload`).
- The outcome requires a server or helper change.
- Electron's `setProxy` with `<-loopback>` does not route loopback through the proxy for a `persist:` partition (verify early with a unit-free manual check if in doubt, and report).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Main now owns device-channel lanes of its own. Anything that later tears down or rebuilds `NativeTailcatTransport` must account for them.
- The unsupported flag is per device and per lane life; a worker upgrade is picked up on the next lane open.
- If the tab ever needs to reach a non-loopback address *as seen from the device* (e.g. a LAN host), that is a new scope decision, not an extension of this one.
- Plan audit (fable, 2026-09-24) raised 10 points; all adopted (marked `revised on plan audit`). The largest: the shared helper `out` queue on the worker (not `ChannelSink`) is the bottleneck a tunnel could use to kill a PTY lane, hence the aggregate in-flight cap; and partition routing moved from credentials to one listener per partition because `login`'s `webContents` can be null.
