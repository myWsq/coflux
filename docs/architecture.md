# coflux architecture

> Status: local-first architecture is implemented. The default remote paths remain custom relay/WebRTC. A pinned Go `coflux-transport` companion is now included in the release pipeline, but Tailcat remains opt-in through `COFLUX_TAILCAT=1`; default promotion and legacy retirement (M4) are not complete. The relay data plane is a standalone service supporting multiple nodes (plans 043/065). Devices on different machines can connect directly through end-to-end WebRTC DataChannels (plan 076). Supervisor/sessiond is the sole authority for PTYs, VT, history, holders, and sequences. Same-machine web clients prefer the loopback gateway. The center owns only accounts, devices, project/task orchestration, relay/P2P rendezvous, and bounded checkpoints. When loopback/P2P is unavailable, traffic automatically uses independently deployed `coflux-relay` nodes.

## 1. Product model

coflux runs daemons on users' nodes and drives terminal programs such as Claude Code, Codex CLI, and Vim in local PTYs. The Electron desktop client, `apps/desktop`, reaches remote daemons through the center or connects directly when client and daemon share a machine:

```text
Desktop ── /client control WS ──▶ Server ── rendezvous: tokens / SDP + dial notification ──▶ Worker
 │                              ├─ Postgres: accounts/devices/projects/tasks                 │
 │   direct unavailable         └─ latest derived checkpoint                                 │ UDS
 ├── wss://relay/…?token ──▶ coflux-relay ◀── outbound wss ────────────────────────────────────┤
 │   one WS per channel; opaque DeviceEnvelope bytes, no parsing                             ▼
 ├──── WebRTC DataChannel ── end-to-end P2P, no intermediate nodes ─────────────────────▶ Supervisor
 │                                                                                      / sessiond
 └──── ws://127.0.0.1:8788 ── direct Device channel on the same machine ─────────────────▶    │
                                                                                           └─ PTY + VT + history
```

Daemons still connect outbound to the center, so remote devices behind NAT need no inbound ports. The loopback gateway listens only locally, exposing nothing to LAN/public networks. P2P UDP sockets use ICE/DTLS and handshake only with peers authenticated through signaling.

### Desktop, CLI, and runtime

```text
Device-host entry points                  Unified operations tool
+--------------------------+              +----------------------------+
| Coflux.app (desktop)     |              | coflux (humans / agents)  |
| cofluxd (headless)       |              | login/workspaces/terminals|
+-------------+------------+              +-------------+--------------+
              | start/stop/update                      | local channel / account API
              v                                        v
+---------------------------------------------------------------------+
| Runtime: Worker (network/business) <-> Supervisor (owns PTYs)         |
+---------------------------------------------------------------------+
```

`cofluxd` manages only headless device hosting; it no longer accepts login, terminal, or workspace operations. `coflux` is the unified business entry point, including the command injected into desktop terminals. Cross-device capabilities use the same account permissions as desktop. The npm `cofluxd` package ships both entry points; desktop bundles Rust `coflux` without Node dependencies. Desktop, npm packages, and bundled components share one product version and `vX.Y.Z` tag. Updating the operations tool leaves running terminals intact. Updating the PTY-owning supervisor can be deferred; restart does not promise restoration of the original processes.

Desktop serves humans and CLI serves agents, operating the same account's workspaces and terminals. CLI account operations enter existing Hub account operations through `/api/client/login` and `/api/client/command`. They share task transactions, prepared execution, terminal I/O, and human-priority rules. CLI is the unified agent entry point; MCP has been removed. Desktop live views continue using DeviceRouter; CLI does not introduce another PTY authority.

The main app directly starts managed local processes. Content-addressed runtime directories under `COFLUX_HOME/desktop-runtimes/` preserve files used by live processes when the `.app` updates. `runtime.sock` exposes versions, instance IDs, live-session queries, and stop; `runtime.lock` prevents duplicate startup. Stop requests include a random instance identifier to avoid stopping a replacement process after a confirmation delay. The app owns `client.sock`, allowing CLI under the same OS user to reuse login state without returning session credentials.

Closing the window hides it. Confirmed quit stops the local runtime; update restart preserves it. Logout first stops local work, then saves an encrypted cleanup record, removes device credentials and current terminal temporary data, and, once online, deletes this device's cloud terminal records and revokes the logged-out client session. Project directories and other devices are excluded. Development uses separate runtime directories; old LaunchAgent migration requires an explicit prompt. Permission guidance points to the main app. TCC ownership and inheritance across updates require system acceptance with production signatures, not inference from parent/child process relationships.

## 2. Authority boundaries

| State | Sole authority | Other layers |
|---|---|---|
| PTY processes, VT, history, output sequence | Supervisor/sessiond | Worker forwards DeviceEnvelope; server receives no raw PTY |
| Holder, holder epoch, input cursor | Supervisor/sessiond | Client retains unacknowledged input; transport is replaceable |
| Device RPC and mutation deduplication | Current worker runtime / sessiond within current supervisor runtime | Direct and relay share logical client and request/operation IDs; lifecycle limits in 5.3 |
| Accounts, devices, projects, workspaces, tasks | Server/Postgres | Daemon catalogs reconcile local facts without inventing exits |
| Offline-visible screen | Latest server checkpoint | Display only; cannot decide holder or replace initial live snapshot |
| Browser terminal rendering | xterm.js | Apply contiguous output deltas after attach snapshot |

Core invariants:

- Server, worker, or transport disconnection cannot stop PTY readers or backpressure local processes.
- Absence from a local catalog does not establish exit. Unknown live sessions are orphans awaiting business reconciliation.
- Only sessiond exit facts/tombstones establish session exit, never central connectivity.
- The server maintains no live xterm, raw replay, viewer/holder state, or global PTY pause.

## 3. Similarities to and differences from tmux

tmux's ability to restore a view at any time does not restore processes; it keeps them alive:

1. Each user has a long-lived local tmux server, with clients attaching through Unix sockets.
2. The server owns PTY masters, panes/windows, screen grids, and history. Clients provide views and input.
3. Client detach, SSH disconnection, and terminal closure leave the server/PTYS alive. Reattach sends current screen state followed by deltas, without central replay of all bytes.
4. If the tmux server or OS actually exits, PTYs/children disappear. Plugins such as tmux-resurrect can save layouts, commands, and some buffers, but cannot revive arbitrary process memory.

coflux maps `supervisor/sessiond` to the tmux server and the browser to an attach client:

| Capability | tmux | coflux |
|---|---|---|
| Session authority | Local tmux server | Local supervisor/sessiond |
| Local attach | Unix socket | Loopback WebSocket + DeviceEnvelope |
| Remote attach | Usually SSH first | Central rendezvous + independent opaque relay, no inbound ports |
| Reconnection view | tmux grid/history | sessiond ANSI snapshot + sequence deltas |
| Write control | Multiple interactive clients possible | One logical holder; others must explicitly take over |
| Central dependency | None | Initial login/pairing, cold start, orchestration; unnecessary for cached-direct hot path |
| Survival after server/OS restart | Not guaranteed | Not guaranteed |

The product boundary: a loaded, paired page can still catalog, attach, snapshot, input, resize, and stop live sessions after the center fully stops. This does not promise refresh/cold-start support while the center is offline or live-process recovery after supervisor/OS restart.

## 4. Processes and local IPC

The daemon core uses Rust without a Node runtime, split into two authority-owning processes:

- `coflux-supervisor`: rarely upgraded; owns PTYs, VT/history, holder/sequence, and exit tombstones; manages worker versions and observation-period rollback. It assembles each PTY environment: `COFLUX_*` ownership IDs, `<COFLUX_HOME>/bin` first in PATH, and shell integration (plan 115). It injects a bundled rc by shell: zsh via `ZDOTDIR`, bash via `--init-file`, fish via vendor conf in `XDG_DATA_DIRS`; unknown shells receive none. After the original user rc chain runs unchanged, it defines a `claude` function translating the injector's `COFLUX_CLAUDE_PLUGIN_DIR` into `claude --plugin-dir <dir>`. On macOS the injector is the Coflux main app. An empty variable or missing directory falls back to the original `claude` behavior.
- `coflux-worker`: frequently hot-upgraded; handles central WS, loopback gateway, local authorization, git/exec/fs, Device RPC, relay, and checkpoints.

A separate Go `coflux-transport` executable embeds pinned Tailcat/Tailscale networking. Release artifacts and Desktop bundles include this companion; paired hot updates verify and publish worker/helper together, then retain the previous immutable pair for rollback. Released workers validate the local helper handshake even when the candidate network path is disabled. Networking itself starts only with `COFLUX_TAILCAT=1`. The helper owns no PTYs or business authority, needs no installed Go runtime, and communicates only through inherited stdio with its worker or Electron-main owner. See [Native Tailcat transport](tailcat-transport.md) for the pinned build, bootstrap requirement, and delivery contract.

Supervisor and worker communicate over a mode-`0600` UDS. Internal frame kinds:

- Kind 1: session-dirty notification, containing only session ID, never raw PTY.
- Kinds 2/3: removed input/replay numbers, permanently reserved and rejected by decoders.
- Kind 5: transport-neutral DeviceEnvelope.

Worker restart leaves supervisor/PTYS intact. The new worker restores transports and derived caches through resync/catalog.

## 5. DeviceTransport

The direct/P2P/relay paths below describe the retained default stack. With
`COFLUX_TAILCAT=1` on both worker and Desktop main, the candidate uses the Go
helper and self-hosted stock DERP for remote transport; local loopback remains
available. Electron main retains keys, grant proofs, and the native control
socket. The renderer receives opaque frames and handles. Coflux still owns
account permissions, per-channel grants, and worker challenge validation.

For native channels, endpoint replacement sends `deviceTailcatClosed` over
central control. The owner cancels the matching pending dial or live stream;
an obsolete channel cannot close its replacement. Client control loss retains
only already-open session lanes for up to 15 seconds. Worker control loss
retires the serving helper and remote authority immediately, without relying
on the remote client observing a TCP FIN. Neither case terminates supervisor
PTYs. Local acceptance passing does not waive the outstanding performance,
real-network, and packaged-delivery promotion gates.

### 5.1 Direct slot: loopback and P2P

The direct slot prioritizes loopback over P2P. The slot competes with relay through hedging and generation promotion (5.2).

**Loopback**: desktop tries `ws://127.0.0.1:8788` by default. Initial pairing uses an authenticated central connection to install a persistent Origin-bound grant. Thereafter, device identity (P-256 key in IndexedDB), grant, and generation remain reusable offline. In Electron (`apps/desktop`, plan 103), the renderer uses a custom scheme; main rewrites `/client` and `/device` handshake Origins to stable `https://desktop.coflux.dev`, matching the self-reported origin. Grants distinguish it from browser `https://app.coflux.dev`. Server/daemon Origin validation is unchanged. Gateway accepts exact Origins and checks signatures, nonces, expiry, and rate limits. Cached-direct terminals and regular Device RPC do not wait for the center: browser → loopback gateway → worker → UDS → sessiond. Low-frequency control/checkpoints may continue through the center in parallel, outside the hot path.

**P2P (WebRTC DataChannel, plan 076)** is the main direct path across machines. Signaling follows the relay rendezvous triangle through central control WS: client sends a complete offer SDP, center validates ownership and forwards account/scopes, worker returns an answer. Vanilla ICE waits for complete gathering on both ends and exchanges once, without trickle. Relay-first behavior and promotion hide the 1–3 second setup. The center signs no P2P token: authenticated signaling and SDP DTLS fingerprints bind peer identity. PeerConnections persist per daemon, created when the client has full demand. Each logical channel uses a DataChannel whose label equals channelId; the center still grants channel-specific scopes. Frames use length-prefixed fragmented streams, with `P2P_CHUNK_BYTES = 16KiB`, within both webrtc-rs receive limits and Chrome's 256KiB limit; outbound SCTP buffering applies backpressure.

**P2P requires online authorization.** Worker `/daemon` control disconnection immediately closes every PeerConnection, like relay. It has no offline survival equivalent to loopback grants. Browser `/client` is a separate control connection: a brief transport outage does not prove worker authorization is invalid. Client immediately stops new rendezvous, revokes online leases/control waiters/elevated lanes, but permits existing relay/P2P session lanes a bounded 15-second grace period. `authOk` with the same credentials within that window reuses channels. Timeout or hard revocation—authError, clientOutdated, changed credentials, reset/destroy/logout—closes them immediately.

The worker uses `webrtc` (webrtc-rs) as answerer, enumerating all non-loopback interfaces (LAN/Tailscale/public IPv4/IPv6) for host candidates. The library does not enumerate interfaces itself; candidates reflect bound addresses. The answer explicitly uses passive DTLS, making the peer the client for best interoperability. The center distributes `COFLUX_STUN_URLS` to both sides in authOk/deviceP2pDial; default empty means host candidates only.

Expected behavior: daemons on public-IP VPSs should connect nearly always through client outbound connectivity checks; same-LAN peers connect through host candidates; successful CN↔CN hole punching keeps traffic domestic, avoiding hairpinning and the GFW. **P2P does not solve GFW interference**: disrupted cross-border routes affect the same IP paths as relay. Symmetric NAT/CGNAT failures automatically fall back to relay without losing functionality. Production hole-punch success rates remain to be measured.

Historical evidence: a 2026-08-25 macOS native probe verified M151 libwebrtc offerer interoperability with a `webrtc-rs 0.20.2` worker. That project was withdrawn on 2026-08-26; see `plans/083-macos-native-client-feasibility-gates.md` and Git history. Its still-applicable finding—that Router liveness must use both control disconnect and application ping/timeout, not transport callbacks alone—was implemented through plan 080 heartbeats.

### 5.2 Relay and automatic switching

With no cache, occupied fixed ports, denied Origin/LNA/loopback permission, or direct-slot failures, DeviceRouter immediately uses relay. P2P setup exceeds the 200ms hedge, so relay normally wins first and P2P promotes automatically with a higher generation when ready.

Relay is the independently deployed `crates/relay` binary (plan 043). During rendezvous, the center validates account/daemon ownership and issues each side a short-lived (≤120s), single-use ed25519 token and complete dial URL. Client and worker each dial one channel-specific WS. Relay pairs by channelId into an opaque byte pipe without parsing DeviceEnvelope or holding an account database; rate/capacity limits match the former embedded relay. Data no longer crosses central control WS. The center holds no channel state; clients rendezvous again after channel loss. Daemons have no standing relay connection, dialing only on demand. Worker central-control disconnection closes all relay channels. Restored direct connectivity promotes with a higher transport generation, retaining logical client, holder, and input queue.

Multiple nodes use a daemon-home-relay model. After daemon authentication, the center sends a static node list. Worker converts each ws/wss base to http/https and probes `/healthz`, selecting a home from median RTT across multiple samples with hysteresis. It reprobes periodically and immediately after relay dial failures. Once daemon reports a home ID, the center directs **both** ends of a channel to that node; until then, it uses the first list entry. Relay nodes neither interconnect nor forward between one another. Client/web/iOS receive no list and perform no probing; they consume one rendezvous `relay_url`. Home is in-memory online presence, never database state.

Production can run one `coflux-relay` per regional VPS, with local Caddy terminating TLS and proxying `/healthz` and `/v1/pipe` to its plaintext listener. All nodes receive the same `COFLUX_RELAY_PUBKEY`; the center retains the matching `COFLUX_RELAY_SIGNING_KEY` and a fallback-ordered list:

```sh
COFLUX_RELAY_NODES='[{"id":"jp","url":"wss://relay-jp.example.com"},{"id":"us","url":"wss://relay-us.example.com"}]'
```

IDs should be short, stable, and unique. The first entry must be the most reliable primary: older workers and newly connected workers still probing fall back to it. Restart the center after list changes; daemons receive the new list when control WS reconnects. Single-node deployments may still use only `COFLUX_RELAY_URL`; the center synthesizes `id=default` with unchanged dialing behavior. Relays do not register with the center or hold account/node databases. There is no connection between them and the center; shared signing keys are the coupling.

**Optional STUN deployment** improves NAT traversal. Without STUN, host candidates already support public-IP VPS daemons and same-LAN peers. STUN is needed when both sides are behind NAT. Run standard coturn beside a relay node such as owo-jp-gw:

```sh
apt install coturn
# /etc/turnserver.conf needs only these two lines for unauthenticated STUN without relay:
#   stun-only
#   listening-port=3478
systemctl enable --now coturn
# Allow UDP 3478 in the VPS firewall; configure and restart the center:
COFLUX_STUN_URLS=stun:relay-jp.coflux.dev:3478
```

The center sends this list to clients in authOk and daemons in deviceP2pDial. Both query reflected addresses to create srflx candidates. There is no TURN: coflux relay already provides fallback. The daemon VPS firewall must permit **established outbound UDP sessions**. ICE sockets use ephemeral ports; worker initiates checks to client candidates, and conntrack can allow replies without inbound allowlists.

Frozen online mobile (source removed in plan 106) disables loopback direct and uses relay-only DeviceRouter. The repository has no legacy `taskAttach/ptyInput/ptyOutput/clientExec/clientFs*` compatibility path.

### 5.3 Ordering, deduplication, and backpressure

- Input includes `holderEpoch + inputSeq`. Sessiond applies it sequentially, returns cumulative ACKs for duplicates, and never skips gaps.
- Client clears input only through cumulative `PtyInputAck.appliedThroughSeq`. After lost ACKs, it resends in original order over the replacement transport.
- Deduplication is not generic exactly-once across arbitrary failures. Its boundary is the ledger-owning authority: sessiond deduplicates PTY input and session create/stop across direct/relay and worker replacement, but not supervisor/OS restart. Other worker mutations—project/worktree/exec/fs—deduplicate only within the current worker runtime. After replacement, the same operation ID cannot be relied upon to prevent repeated external effects.
- `execRun` may have started or completed an external command before a worker crash prevented result recording. The outcome is unknown: callers must not automatically retry non-idempotent commands or claim exactly-once execution.
- `fs.write` to a stable path fully overwrites contents. Retrying identical path/data after an unknown outcome converges to the same content: outcome idempotency, not exactly one execution.
- Worktree operations can define dedicated probing/recovery using stable paths and Git state. Such semantics belong to each operation, not the generic ledger.
- Output has monotonic sequence numbers. Gaps trigger reattach/snapshot, never silent concatenation across missing output.
- Channels have record/byte limits and a separate priority gap slot. Only the latest checkpoint per session is retained; a slow/disconnected center cannot backlog PTYs.

## 6. Attach and state recovery

Attach checks holder, resizes, snapshots, and establishes subscription under the session mutex:

```text
DeviceSessionAttach(resumeFromSeq?, clientInstanceId, generation)
  ├─ contiguous recovery possible: DeviceSessionAttached + replay delta
  └─ insufficient history / first attach: DeviceSessionAttached(ansiSnapshot, snapshotSeq)
       accept subsequent DevicePtyOutput only fromSeq = snapshotSeq + 1
```

Snapshots reconstruct current sessiond VT/history as ANSI; they are not raw-byte replay. An independent `@xterm/headless` 6 oracle feeds the original recording to terminal A and the snapshot to a fresh terminal B, appends identical tails, then compares public buffer/cell/mode state. CI fixtures include sanitized Claude CLI, Codex CLI, and Vim/TUI recordings.

Initial fidelity contract:

| Guaranteed recovery | Explicitly not guaranteed |
|---|---|
| Wide/combining Unicode, complete logical-line history, wrapping | sixel/kitty/iTerm images |
| Cursor position and visibility | OSC 8 link metadata, title/icon name |
| Normal/alternate screens | Cursor shape/color |
| Application cursor/keypad, bracketed paste | Blink/strike/invisible/underline variants |
| 16/256/RGB foreground/background, bold/dim/italic/underline/inverse | Focus/mouse/kitty keyboard state |

An exclusion means metadata or modes may be lost after attach, not that the escape sequence crashes the session.

## 7. Central control plane and checkpoints

The center persists Account → Device → Project → Workspace → Task metadata and handles login, device authorization, task creation, worktrees, port previews, upgrades, and prepared operations. Sessions themselves are not persisted.

At most every two seconds, worker requests current snapshots for dirty sessions and reports through an independent coalescing outbox. Server retains only the latest `snapshotSeq/capturedAt/cols/rows/ansiSnapshot` per session, capped at 512 KiB:

- Offline daemons can still show their latest screen.
- Checkpoints cannot grant holder, clear input queues, or bypass live attach.
- Older/duplicate sequences are discarded; mismatched task/session ownership is rejected.

The former server xterm live mirror, raw `ptyOutput/ptyReplay`, `TaskAttach/TaskDetached`, and server-routed exec/fs protocol were removed. Their protobuf names/numbers are permanently `reserved`.

### 7.1 Server-initiated prepared execution (plan 091)

Prepared operations originally had one initiator: the browser. The center persists a prepared operation, installs its template on the daemon over control WS, waits for installation confirmation, hands the frame to the browser, and the browser delivers it through Device channel. The daemon verifies frame/template equality, executes, and returns `DeviceOperationReport` for central reconciliation.

Plan 091 also permits the center/account CLI to initiate. Only the execution trigger and result recipient differ; persistence, validation, reconciliation, and broadcasts are shared:

```text
Account CLI ──▶ Hub operations (admission transaction + prepare(metadata.initiator = "server"))
   │              │ installed / restore→installed
   │              └── control WS ──▶ PreparedDeviceOperationExecute{operation_id}
   │                                 worker: installed local template → Principal::Server
   │                                 synthetic channel __coflux-server-<operation_id>
   │                                 → same dispatch as browser
   │              ◀── control WS ── DeviceOperationReport → same transaction/broadcast
   └── bounded completion Deferred by operationId/taskId ──▶ result or readable error
```

- **No virtual transport channels**: data still avoids central control WS, and the center holds no channel state. Only per-operation control messages are added. Synthetic channels do not enter the worker channels table; responses to them are discarded by existing logic. Only OperationAck/Error reaches the center through reports.
- **Idempotency**: central restore after server restart/daemon reconnect reinstalls templates and executes again. Already-executed operation IDs resend the previous report; in-flight ones are ignored, preventing duplicate worktree/session creation within the applicable ledger lifetime.
- **Command terminals**: with nonempty `DeviceSessionCreate.command`, worker authorizes, writes a local wrapper using a login shell and `tee` logging, and exits with the command's exit code. `shell` becomes the script path. Paths derive deterministically from operation_id because sessiond's canonical ledger request includes `shell`; a changed replay path causes `operation_collision`.
- **Direct reads/writes**: `ServerAgentRequest/Result`, each with a oneof, carries actions without persistent business-data effects: read command-log tails/local snapshots (falling back to central checkpoints offline) and send input through `agent_send_input`. Human holders cause rejection; holder/input_seq/attach semantics remain unchanged. Stop reuses `sessionClose`.
- **Capability gates**: daemon authentication/enrollment advertises `capabilities`, including `prepared_execute` and `terminal_io`. Center checks names, not versions. Missing capabilities cause write tools to return a daemon-upgrade-required error **before prepare**, avoiding installed records old workers can never trigger. Older workers silently discard unknown ServerToDaemon payloads, so timeout is insufficient.
- **Bounded waits**: create/delete wait 30 seconds; `terminal wait` is capped at 600 seconds. Expiry returns submitted/current status rather than hanging. Daemon disconnect/replacement/revocation, task deletion, and center shutdown awaken waiters with readable errors.

Future server-driven daemon actions should use prepare + Execute + reconciliation. Reserve direct messages for actions without persistent business-data effects.

## 8. Lifecycle and failure semantics

| Failure | Behavior |
|---|---|
| Brief browser `/client` control outage | Cached direct continues. Existing relay/P2P session lanes survive up to 15 seconds and reuse same-credential `authOk`; online leases, elevated lanes, new rendezvous, and business orchestration stop immediately. Timeout/hard revoke closes remote lanes. |
| Worker `/daemon` control outage | Close relay/P2P channels immediately; supervisor/PTYS survive and rebuild after control recovery. |
| Direct failure/permission denial | Try P2P after loopback failure, then rendezvous+relay; do not misreport daemon offline. |
| P2P traversal failure/interruption | Fall back to relay; once stable, retry loopback→P2P promotion with backoff. |
| Relay/center failure | Established loopback direct continues catalog/attach/input/resize/stop. No new relay/P2P channels while center is offline because rendezvous/signaling require it. Existing remote channels follow the two independent control-connection rules above. |
| Worker restart | Supervisor/PTYS survive; increment generation and rebuild channel/catalog. |
| Server restart | Reconcile Postgres metadata with daemon catalogs/checkpoints; preserve unknown orphans. |
| Slow center | Relay/checkpoints may lag or be discarded; local PTYS/direct channels continue. |
| Supervisor/OS restart | Live-process recovery is not guaranteed and is outside V1. |

Task creation and first session creation require central orchestration. Local stop is a sessiond fact; central task deletion is separate business metadata. Stop succeeds with the center unreachable, and exit tombstones reconcile after reconnect. Permanent task deletion is a separate action after control-plane recovery.

## 9. Port previews

Worker detects only LISTEN ports within PTY process trees and reports them so the center can generate `<shortId>-<proxyHost>`. Without a gate cookie, preview domains return 302 to the server-rendered `<publicUrl>/proxy-auth?to=` page (plan 107). After short-lived page-session login, server issues a one-time authorization code and redirects back to the preview-domain callback, which sets an account cookie before proxying. HTTP/SSE/WebSocket use `ProxyData` tunnels. This remote-port traffic explicitly traverses the center, outside the local-first terminal/RPC hot path.

## 10. Authentication and security boundaries

- Daemons exchange one-time browser authorization for server-issued per-device credentials; server stores only token SHA-256 hashes.
- Server-issued client-session tokens bind accounts. All control, rendezvous, checkpoint, and proxy operations validate account/daemon ownership.
- Relay has no account database. It validates short-lived, single-use, domain-separated ed25519 tokens from the center, rejects later duplicate channel+role connections, and rejects replay during the post-channel tombstone window.
- Loopback identity/grant stores and daemon credentials live under `COFLUX_HOME` with mode `0600`. `cofluxd doctor` exposes no private keys, grant IDs, tokens, or credential contents.
- Worker resolves exec/fs roots from center-synchronized workspace IDs with realpath anchoring; it does not trust browser-reported cwd.
- The trust model is still one user's own machines; coflux is not a multitenant code-execution sandbox.

## 11. Diagnostics and release evidence

`cofluxd doctor` reports separately:

1. Central DNS, TCP, TLS, and WebSocket.
2. Gateway binding.
3. Persistent grant/Origin counts.
4. Host-side loopback WebSocket reachability.
5. Daemon-to-center connection state.

Local failure means direct is degraded while central relay remains available. Central failure with healthy local state explicitly reports cached-direct availability.

Reproducible benchmark on 2026-07-25: Apple M1 Pro, `a3592ff` debug daemon, default 2,000 history lines, maximum snapshot 98,939 bytes; Node v26.3.0 and `@xterm/headless` 6 without DOM rendering; 20 warmups, 100 samples, `performance.now()`:

| Metric | p95 | Release gate |
|---|---:|---:|
| Cached-direct PTY echo | 0.589 ms | < 20 ms |
| Device attach + fresh xterm 6 parsing to usable screen | 64.820 ms | < 100 ms |
| Relay-frame increase on timed direct path | 0 | = 0 |

Since plan 043 removed relay frames from central control WS, the last metric observes bidirectional relay-transport frame counts through `relayFrameSnapshot` in `tests/src/local-first-benchmark.mjs`. Its meaning is unchanged: zero relay involvement in the timed direct hot path.

A second run on `a89476b`, also 2026-07-25, measured echo p95 0.771ms, attach p95 59.838ms, and zero central-frame increase; all SLOs still passed within normal sampling variation.

The original physical-browser matrix covered current macOS Chrome, Safari, and Firefox for cached direct, initial relay+pair, permission denial, fallback/promotion, worker restart, and server outage. The 2026-07-25 decision narrowed blocking coverage to Chrome:

| Browser | Version | Result |
|---|---|---|
| Chrome stable | Local Chrome 150.0.7871.187, real instance through CDP, not headless shell | PASS, all six scenarios; three UI/reconciliation defects found below |
| Safari stable | Local Safari 27.0, macOS 27.0 build 26A5378n | Not tested this round per 2026-07-25 decision; automation requires enabling Develop → Allow JavaScript from Apple Events or `safaridriver --enable` |
| Firefox stable | Not installed | Not tested this round per 2026-07-25 decision |

Local-first direct behavior on Safari/Firefox remains unverified, including loopback WebSockets and LNA/permission behavior. This table does not establish cross-browser support. Restoring three-browser coverage requires all six scenarios with recorded versions/results.

Physical Chrome 150 results on 2026-07-25 used Vite 5273, server 8787, `.coflux-dev` daemon, and gateway 8788. Transport mode came from sidebar device-row `title`; lsof confirmed Chrome↔worker loopback TCP; an append-only file counted input effects. The translated observations below retain the original measurements:

| Scenario | Observation |
|---|---|
| Cached direct | Device row reported same-machine direct device data; Chrome PID↔`coflux-worker` had ESTABLISHED TCP at `127.0.0.1:8788`; input effect occurred exactly once. |
| First uncached relay+pair | After clearing IndexedDB: probing at 341ms, central opaque relay at 425ms, local direct at 525ms as background pairing completed. |
| Loopback denied | Injected WebSocket `SecurityError` for `:8788`: immediate relay with denial detail, no loopback TCP; attach/input/resize worked over relay (36×132 → 37×118). |
| Real relay fallback | Occupied gateway ports on both `127.0.0.1` and `::1`, forcing worker bind failure: relay at 328ms. Releasing ports allowed automatic bind retry. |
| Worker restart | `kill -9` worker while supervisor lived: gateway closed → probing → direct recovery in 591ms. PTY PID unchanged, history complete, no duplicate input. |
| Server outage | `kill -9` server: detail reported center offline with local session read/control available; direct persisted. List/attach with full snapshot/input/resize (37×118 → 39×160)/stop with actual PTY exit all worked. Banner disappeared after center restart. |

The same run exposed three defects beyond wire-only black-box tests, which do not render DOM. All were fixed and physically reverified:

1. The offline banner at `fixed top-0 h-7` covered terminal tabs at y=4..32; `elementFromPoint` hit the banner, preventing tab/close-button clicks despite offline attach/stop support. Fix: add root `pt-7` while disconnected; ResizeObserver refits terminals. Recheck: tabs moved to y=32 with the banner present, and all four hit tests reached their tabs.
2. `closeTask()` aborted on `stopSession` errors without deleting catalog tasks, leaving unclosable tasks after daemon/supervisor restart when PTYs were gone. Router failed to reject holder waits on `session_not_found`, causing an uninformative timeout. Fix: reject immediately with that code (regression in `device-router.test.ts`) and let `closeTask` continue task deletion. Physical recheck removed all zombie tabs.
3. The same function silently skipped `taskRemove` while `controlAuthenticated` was false, without retry. Fix: record offline deletions and replay sequentially after `authOk`; logout clears them to prevent cross-account deletion. Recheck: closing during outage immediately exited the PTY but temporarily retained the tab; center restart removed it automatically.

Known minor issues, unfixed: transport detail can retain the center-offline/local-read-control-available message after recovery because it is not republished, though direct works. A cached grant with a stale gateway port is not refreshed; direct returns only when gateway uses that stored port again. The fixed default port makes this uncommon.

Playwright simulation cannot replace these results: all six scenarios ran against real Chrome, daemon, and server processes.

## 12. Repository structure and verification

```text
apps/server          Central control / relay rendezvous / checkpoints / Postgres
apps/desktop         Sole frontend/default target: Electron main + React/xterm renderer (src/renderer), direct enabled
apps/ios             Native iOS client: SwiftUI + SwiftTerm
packages/core        Shared TS infrastructure such as logging
packages/client      Control store + DeviceRouter
packages/protocol    TS protobuf bindings
packages/swift-client Swift protobuf, client core, Apple-platform transports
packages/cli         Headless cofluxd host management + coflux account/local/remote operations
crates/protocol      Rust protobuf and UDS frames/IPC
crates/supervisor    PTY/sessiond authority
crates/worker        Gateway, relay dialing, RPC, checkpoints, upgrade adapter
crates/relay         Standalone token verification, channel pairing, opaque pipes
tests                Real-process WebSocket black-box harness
```

`proto/` is the protocol source of truth, generating TS/Rust/Swift through Buf. Automated release gates include Buf lint/codegen, TS/Swift client state machines, server/desktop type checks, desktop tests/build, iOS build-for-testing, Rust tests/build, independent VT oracles, the full black-box suite, and `git diff --check`. Benchmarks and current Chrome physical acceptance still require pre-release sign-off. Safari/Firefox are nonblocking and unverified; physical native-iOS production acceptance awaits the user. Black-box tests use only temporary `COFLUX_HOME`, ports, databases, and process groups, never real daemons.
