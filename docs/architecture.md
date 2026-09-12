# coflux architecture

> Status: local-first architecture is implemented. Native remote networking now uses the pinned Go Tailcat/Tailscale companion with self-hosted stock DERP; custom relay and WebRTC are retired. Supervisor/sessiond remains the sole authority for PTYs, VT, history, holders, and sequences. The center owns accounts, devices, orchestration, native rendezvous, and bounded checkpoints. This describes the source architecture, not a claim of production deployment.

## 1. Product model

coflux runs daemons on users' nodes and drives terminal programs such as Claude Code, Codex CLI, and Vim in local PTYs. The Electron desktop client, `apps/desktop`, reaches remote daemons through the center or connects directly when client and daemon share a machine:

```text
Desktop main ── control WS ── Server ── control WS ── Worker
  │                           │                       │
  │                       Postgres                    │ UDS
  │                                                   ▼
  ├─ native helper ── Tailcat direct / stock DERP ── serving helper
  │                                                   │
  └─ same-machine loopback gateway ──────────────── Worker ── Supervisor
                                                               └─ PTY + VT + history
```

Daemons connect outbound to central control. Tailcat handles native peer
connectivity and DERP fallback. Coflux validates application authority separately
on every channel. The loopback gateway listens only locally.

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
| Device RPC and mutation deduplication | Current worker runtime / sessiond within current supervisor runtime | Local and native channels share logical client and request/operation IDs; lifecycle limits in 5.3 |
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
| Remote attach | Usually SSH first | Central grants + native Tailcat transport, no application listener ports |
| Reconnection view | tmux grid/history | sessiond ANSI snapshot + sequence deltas |
| Write control | Multiple interactive clients possible | One logical holder; others must explicitly take over |
| Central dependency | None | Initial login/pairing, cold start, orchestration; unnecessary for cached-direct hot path |
| Survival after server/OS restart | Not guaranteed | Not guaranteed |

The product boundary: a loaded, paired page can still catalog, attach, snapshot, input, resize, and stop live sessions after the center fully stops. This does not promise refresh/cold-start support while the center is offline or live-process recovery after supervisor/OS restart.

## 4. Processes and local IPC

The daemon core uses Rust without a Node runtime, split into two authority-owning processes:

- `coflux-supervisor`: rarely upgraded; owns PTYs, VT/history, holder/sequence, and exit tombstones; manages worker versions and observation-period rollback. It assembles each PTY environment: `COFLUX_*` ownership IDs, `<COFLUX_HOME>/bin` first in PATH, and shell integration (plan 115). It injects a bundled rc by shell: zsh via `ZDOTDIR`, bash via `--init-file`, fish via vendor conf in `XDG_DATA_DIRS`; unknown shells receive none. After the original user rc chain runs unchanged, it defines a `claude` function translating the injector's `COFLUX_CLAUDE_PLUGIN_DIR` into `claude --plugin-dir <dir>`. On macOS the injector is the Coflux main app. An empty variable or missing directory falls back to the original `claude` behavior.
- `coflux-worker`: frequently hot-upgraded; handles central WS, loopback gateway, local authorization, git/exec/fs, Device RPC, native helper ownership, and checkpoints.

A separate Go `coflux-transport` executable embeds pinned Tailcat/Tailscale networking. Release artifacts and Desktop bundles include this companion; paired hot updates verify and publish worker/helper together, then retain the previous immutable pair for rollback. Released workers validate the local helper handshake before probation succeeds. Networking starts automatically after control authentication. The helper owns no PTYs or business authority, needs no installed Go runtime, and communicates only through inherited stdio with its worker or Electron-main owner. See [Native Tailcat transport](tailcat-transport.md) for the pinned build, bootstrap requirement, and delivery contract.

Supervisor and worker communicate over a mode-`0600` UDS. Internal frame kinds:

- Kind 1: session-dirty notification, containing only session ID, never raw PTY.
- Kinds 2/3: removed input/replay numbers, permanently reserved and rejected by decoders.
- Kind 5: transport-neutral DeviceEnvelope.

Worker restart leaves supervisor/PTYS intact. The new worker restores transports and derived caches through resync/catalog.

## 5. DeviceTransport

Tailcat/Tailscale supplies the default remote network stack through the private
`coflux-transport` Go companion. Coflux owns account/device authorization,
per-channel scopes, DeviceEnvelope routing, and PTY lifecycle. Stock self-hosted
DERP supplies fallback forwarding; upstream networking chooses direct peers when
available. The custom relay binary, WebRTC signaling, ICE configuration, and
fragmentation code have been retired.

### 5.1 Local loopback

Desktop can connect directly to `ws://127.0.0.1:8788`. Initial pairing installs a
persistent Origin-bound grant through authenticated central control. The local
provider retains identity and grants; the gateway validates signatures, nonces,
expiry, and exact Origins. Desktop main uses `https://desktop.coflux.dev` for
both control and gateway handshakes. Cached local session read/control can
survive center outages; RPC/lifecycle requires an online lease. Supervisor PTYs
remain independent of worker and transport replacement.

### 5.2 Native remote channels and self-hosted DERP

Worker owns one serving helper per authenticated control epoch; Desktop main
owns a client helper with at most 16 demanded device backends. Helpers use
inherited private stdio, never a public proxy. Central grants bind account,
device, client instance, generation, scopes, node key, and a 30-second pending
expiry. Worker issues a nonce and consumes a single-use HMAC proof. Session
read/control and RPC/lifecycle use separate grants and lanes.

Endpoint replacement sends `deviceTailcatClosed` over central control, cancelling
only the matching pending/live channel. Client control loss preserves already
open session lanes for at most 15 seconds and immediately retires elevated
lanes. Worker control loss immediately retires its serving helper and authority.
Neither depends on observing a remote TCP FIN, and neither terminates PTYs.

The server supplies 1–8 private regions through `COFLUX_DERP_REGIONS`. Both ends
of each connection use the worker's selected region. Worker probes stock
`/derp/probe`; three failures trigger helper replacement and central rotation
to the next configured region. A client failed-dial report can nudge an owned
pending channel's health check without rotating a healthy endpoint. See the
[native transport contract](tailcat-transport.md) for probe timings and grants,
and [deployment](deployment.md) for private DERP admission and migration.

Control protocol version 2 is the compatibility floor for clients and workers;
newer compatible versions are accepted. DeviceEnvelope remains version 1. Swift
and iOS currently expose local provider support and explicitly report remote
connections unavailable. Frozen browser clients cannot use the removed remote
protocol and require the current Desktop client.

### 5.3 Ordering, deduplication, and backpressure

- Input includes `holderEpoch + inputSeq`. Sessiond applies it sequentially, returns cumulative ACKs for duplicates, and never skips gaps.
- Client clears input only through cumulative `PtyInputAck.appliedThroughSeq`. After lost ACKs, it resends in original order over the replacement transport.
- Deduplication is not generic exactly-once across arbitrary failures. Its boundary is the ledger-owning authority: sessiond deduplicates PTY input and session create/stop across local/native and worker replacement, but not supervisor/OS restart. Other worker mutations—project/worktree/exec/fs—deduplicate only within the current worker runtime. After replacement, the same operation ID cannot be relied upon to prevent repeated external effects.
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
| Brief browser `/client` control outage | Cached direct continues. Existing native remote session lanes survive up to 15 seconds and reuse same-credential `authOk`; online leases, elevated lanes, new rendezvous, and business orchestration stop immediately. Timeout/hard revoke closes remote lanes. |
| Worker `/daemon` control outage | Close native remote channels immediately; supervisor/PTYS survive and rebuild after control recovery. |
| Direct failure/permission denial | Use native remote transport while retrying local loopback; do not misreport the daemon offline. |
| Native peer traversal failure/interruption | Upstream Tailcat uses DERP fallback; the owner monitors application liveness and reconnects with bounded backoff. |
| Relay/center failure | Established loopback direct continues catalog/attach/input/resize/stop. No new native remote channels while center is offline because rendezvous/signaling require it. Existing remote channels follow the two independent control-connection rules above. |
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

Local failure means direct is degraded while native remote transport remains available. Central failure with healthy local state explicitly reports cached-direct availability.

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
apps/server          Central control / native rendezvous / checkpoints / Postgres
apps/desktop         Sole frontend/default target: Electron main + React/xterm renderer (src/renderer), direct enabled
apps/ios             SwiftUI + SwiftTerm; remote transport unavailable pending a native provider
packages/core        Shared TS infrastructure such as logging
packages/client      Control store + DeviceRouter
packages/protocol    TS protobuf bindings
packages/swift-client Swift protobuf, client core, Apple-platform transports
packages/cli         Headless cofluxd host management + coflux account/local/remote operations
crates/protocol      Rust protobuf and UDS frames/IPC
crates/supervisor    PTY/sessiond authority
crates/worker        Gateway, native helper ownership, RPC, checkpoints, upgrade adapter
transport/tailcat    Pinned native helper; self-hosted stock DERP supplies fallback
tests                Real-process WebSocket black-box harness
```

`proto/` is the protocol source of truth, generating TS/Rust/Swift through Buf. Automated release gates include Buf lint/codegen, TS/Swift client state machines, server/desktop type checks, desktop tests/build, iOS build-for-testing, Rust tests/build, independent VT oracles, the full black-box suite, and `git diff --check`. Benchmarks and current Chrome physical acceptance still require pre-release sign-off. Safari/Firefox are nonblocking and unverified; physical native-iOS production acceptance awaits the user. Black-box tests use only temporary `COFLUX_HOME`, ports, databases, and process groups, never real daemons.
