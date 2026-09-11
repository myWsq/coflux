# Plan 080: Recover silently dead links—control-plane liveness, isolated failure handling, and per-channel data-plane health

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 71c543b..HEAD -- packages/client/src/connection.ts packages/client/src/store.ts packages/client/src/device-router.ts packages/client/src/device-router.test.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH (changes core connection-lifecycle and channel-racing state machines; two untested production changes on 2026-08-17 both amplified the incident)
- Depends on: none
- Category: bug
- Execution: self
- Planned at: `71c543b`, 2026-08-17 (root-cause assessment revised after that day's investigation; see Requirement)
- Result: **DONE (code milestones)**. M1/M2/M4/M5 retain existing implementation. M3 completed 2026-08-28: ordinary browser `/client` transport loss immediately revokes control waiters, online leases, elevated lanes, and new rendezvous authority, but existing relay/P2P session lanes receive a bounded 15-second grace. Same-credential authOk within the window retains the channel; timeout, authError, clientOutdated, credential change, reset, destroy, or logout hard-revokes it. Client tests: 56/56. Production switch, real NAT/STUN, and Safari/Firefox/iOS remain external acceptance.

## Requirement

Production incident on 2026-08-17: a browser on Work operated a terminal on Home. **The device appeared online but its terminal did not respond** for hours, without disconnect, error, or timeout. Refresh helped briefly before recurrence. Meanwhile iOS, on cellular with an independent Swift implementation, worked throughout.

**Revised primary cause**: an intermediate network silently cut the control WebSocket without FIN or RST, leaving both TCP endpoints ESTABLISHED:

```text
Control WS silently dies
  → ws.onclose never fires; controlOnline stays true and readyState stays OPEN
  → send() writes into a black hole without error; rendezvous requests disappear
  → Established relay/P2P channels on the link are also cut
  → Rebuilding requires rendezvous through startRelay/startP2p, both guarded by !controlOnline
  → Wait forever without recovery; only onclose drives reconnect
```

**The initial diagnosis of "P2P crash plus non-fatal heartbeats" was disproved by investigation**. Preserve the evidence to avoid repeating it:

- Of 17 P2P failures in Home daemon.log, **15 were `data channel closed`** before writing, only two write timeouts. MTU problems should cause timeouts/loss, not already-closed channels. **The MTU/Tailscale hypothesis lacks evidence.**
- Those 15 closures were initiated by the peer, not local crashes. Both ends are symmetric: client setControlOnline(false) loses all relay/P2P (`device-router.ts:2549-2552`); worker clears all PeerConnections whenever center disconnects (`crates/worker/src/main.rs:420`).
- **Decisive counterevidence**: center logged no Home daemon disconnection from 14:05 until manual worker restart. Home close_all could not have fired; Work's browser closed the channels because **its own control connection failed**.
- Disabling P2P seemed to restore service, but the same action restarted coflux-server, rebuilding all connections, and the user refreshed. **Recovery cannot be attributed to disabling P2P on that evidence.**

P2P is a victim in this chain. Relay channels are also destroyed and cannot rebuild; P2P appears worse because it needs full ICE negotiation in addition to rendezvous.

**After implementation**:

1. Client detects silent control-WS death and reconnects on the order of a dozen seconds, without waiting for onclose or user refresh.
2. Failure/reconnect paths have no unrecoverable credential, state-machine, or cleanup gaps.
3. Relay/P2P/direct channels have independent liveness criteria rather than waiting for onclose, which may take ~30s ICE timeout for DataChannel.
4. Repeated P2P failure cannot repeatedly promote over a working relay.
5. Deterministic unit tests, including negative verification, cover everything without real networks or production experiments.

## Decisions & tradeoffs

- **Control liveness means receiving any inbound frame after sending a message, not periodic heartbeat.** Healthy client operations produce broadcast/error/checkpoint traffic within seconds; silent failure produces nothing. Rejected: new proto heartbeat messages require proto/server/three clients and remote-plugin TS/Rust/Swift generation for insufficient benefit. Pure idle timeout would falsely kill normally idle pages.
  Based on: connection.ts has no liveness probe and reconnects only from ws.onclose; ClientToServer oneof has no heartbeat.
- **On failure only call `close()`; let onclose reconnect. Never reconnect directly.** Reuse normal server-closure credential decisions, including logout/version mismatch. Rejected: dropping socket reference and directly calling scheduleReconnect bypassed reconnectCredential on 2026-08-17. shouldRetry only became true after authOk, causing **permanent disconnection, worse than the original bug**.
  Based on: `reconnectCredential: () => (shouldRetry && token ? { token } : null)` and authOk handling in store.ts.
- **An existing local session token permits automatic reconnect.** Initial shouldRetry=false means a first post-refresh connection cut before authOk, including server's 15s authDeadline, can remain disconnected forever. Fix this pre-existing gap too. Keep clearing on authError/clientOutdated/logout.
  Based on: `let shouldRetry = false;` and the three reset sites in store.ts.
- **Control failure must not destroy all data channels.** Current setControlOnline(false) loses all relay/P2P while startRelay/startP2p's !controlOnline guards prevent rebuilding. This turned partial availability into total outage in the second failed change on 2026-08-17. Design a grace/delayed/confirmed-disconnect policy, but prove a briefly interrupted, quickly restored control connection does not destroy a working relay.
  Based on: device-router.ts:2547-2560, startRelay at :1201, startP2p at :1219.
- **Do not change worker's symmetric close_all.** Changing whether daemon trusts existing channel authorization after center loss requires revisiting 043/076 security. Client grace is useful when **control recovers quickly**, which is why control probing comes first.
  Based on: `crates/worker/src/main.rs:420` close_all comment.
- **Data-channel heartbeat declares death after two unanswered probes, without waiting a full interval for the second.** Detection around 10–15s beats ~30s ICE timeout and tolerates one transient loss. Rejected: one 5s timeout is too sensitive; two full intervals (~35s) are slower than ICE. Apply equally to relay/direct, whose WS onclose also fails under silent dropping.
  Based on: HEARTBEAT_INTERVAL_MS=15_000 and HEARTBEAT_TIMEOUT_MS=5_000 at device-router.ts:61,63. Measured production RTT: relay-bj 31ms, relay-jp 180ms; 5s is still 27 times the slower RTT.
- **Activate the existing unused `HEARTBEAT_TIMEOUT_MS`.** Its comment already intends a shorter timeout than ordinary 20s RPC, but there are no usages. Reuse it rather than introducing another constant.
  Based on: `grep -n HEARTBEAT_TIMEOUT_MS packages/client/src/device-router.ts` matches only line 63.
- **Back off P2P failures.** Otherwise promotion repeatedly steals the newly recovered relay. Follow directRetryAttempts/scheduleDirectRetry at :290,1984-2058. Rejected: permanently disabling route P2P prevents recovery after network repair. Gate **initiation**, not already-established candidates in acceptCandidate.
  Based on: acceptCandidate promotion at :1151 admits all channel.kind !== "relay" without failure memory.
- **Make connection.ts clock-injectable first.** Direct window timers prevent deterministic testing, which is essential after two untested changes worsened production. Follow createDeviceRouter clock injection and FakeClock.advance at device-router.test.ts:56, plus harness(adapter, clock) at :267.

## Direction

Milestone order follows risk: establish testability before changing state machines.

### Milestone 1: Inject connection.ts clock without changing behavior

createConnection accepts optional clock, defaulting to window; backoff reconnect uses it. Add fake-clock tests for auth packet sending, exponential backoff timing, and no reconnect after stop().
Validation: `node --test packages/client/src/connection.test.ts` exits 0.

### Milestone 2: Recover silent control failure

After sending, wait for any inbound frame; timeout closes the socket and onclose reconnects. Include initial connection with existing token in auto-reconnect.
Validation: connection tests cover (a) send/no reply→death→reconnect, (b) reply→no death, (c) delayed auth acknowledgment→death→**successful retry**, protecting the shouldRetry corner case, and (d) no death while idle without sends/receives. Negatively verify (a)/(c).

### Milestone 3: Isolate brief control loss from data channels

`setControlDisconnected()` immediately revokes control waiters, online leases, elevated lanes, and new relay/P2P rendezvous, while granting existing relay/P2P session lanes 15 seconds. Same-credential authOk within the window cancels the timer and retains the original channel; timeout closes remote channels. authError/clientOutdated/explicit credential changes/reset/destroy/logout use setControlOnline(false) for immediate hard revocation. Control-generation tokens reject async opens started before disconnect but completed afterward, and obsolete timers across generations.

Worker `/daemon` is an independent control connection. Its loss still immediately calls close_relays() and p2p.close_all() under existing online authorization; browser grace does not change worker's boundary.
Validation: `node --import tsx --test packages/client/src/device-router.test.ts` exits 0, covering retained relay within grace, 15s timeout, hard revoke, late open, and old cross-generation timers.

### Milestone 4: Heartbeat-based data-channel death

After two unanswered heartbeats, loseChannel on any active session lane and use existing scheduleRecovery to race again. Treat P2P/relay/direct equally and respect heartbeatUnsupported.
Validation: router tests cover established P2P silently ceasing responses without onclose, heartbeat death, and relay takeover; negatively verify the case.

### Milestone 5: P2P failure backoff

After connection failure or declared death, back off P2P: no initiation, racing, or promotion during backoff; reset after stability.
Validation: router tests prove repeated P2P failures leave relay in control without relay→P2P→relay oscillation.

## Landmines

- shouldRetry becomes true only after authOk. Bypassing reconnectCredential before auth completes can permanently disconnect, as observed 2026-08-17.
- setControlOnline(false) at :2547-2560 destroys relay/P2P; !controlOnline at :1201/:1219 blocks reconstruction. Coupling failure detection to both amplified partial into total outage in production.
- Update the "heartbeat does not declare death" comment at device-router.ts:1950 together with implementation.
- HEARTBEAT_TIMEOUT_MS at :63 is unused; do not assume death detection already exists.
- Older daemons set heartbeatUnsupported=true and stop ping at :1716-1720. Respect this or old workers endlessly lose channels for missing pong.
- Existing :1957-1961 merely clears pendingPing and RTT when a prior ping remains outstanding. Store failure counts separately; clearing ping state loses history.
- Promotion at acceptCandidate :1151 replaces active relay with newer P2P generation. Backoff at initiation avoids wasted setup.
- scheduleRecovery :1492's recoveryTimer guard neither duplicates recovery nor shortens an already scheduled delay.
- FakeClock.advance is synchronous. Assert just before threshold, advance past it, then assert death, so threshold changes fail tests.
- connection.ts send silently discards messages when readyState !== OPEN. This is another source of unresponsive operations but out of scope.

## Scope

In scope:
- `packages/client/src/connection.ts`
- `packages/client/src/store.ts`
- `packages/client/src/device-router.ts`
- `packages/client/src/device-router.test.ts`
- New `packages/client/src/connection.test.ts`

Out of scope:
- `crates/worker/`: close_all involves 043/076 authorization and needs a new security argument
- `apps/server/`: COFLUX_P2P_ENABLED already exists at `be2e42c`; re-enabling is deployment, not code
- `proto/`: no wire messages; chosen control criterion deliberately requires no server cooperation
- `apps/ios/`: independent Swift worked during the incident; decide alignment after web validation
- Excluding tunnel interfaces from host candidates: evidence disproved the original MTU hypothesis
- Plan 079, held in git stash `plan 079 WIP`
- Production Caddy stream_close_delay 5m: unrelated, awaiting separate rollback

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Connection unit tests | `node --import tsx --test packages/client/src/connection.test.ts` | exit 0 |
| Router unit tests | `node --import tsx --test packages/client/src/device-router.test.ts` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| External cross-network acceptance | Two machines on different networks; browser operates remote terminal | Automatically recovers after link interruption without refresh |

## Done criteria

- [x] Code commands pass: connection/router 56/56 and web types.
- [x] M2 (a)/(c) and M4 tests fail when implementation is removed.
- [x] Test proves brief control loss/recovery does not destroy/rebuild relay.
- [x] Tests cover heartbeatUnsupported; old workers do not endlessly lose channels.
- [x] Heartbeat comments now describe death detection.
- [x] No failure path bypasses reconnectCredential().
- [x] Required tests exist and assert meaningful behavior.
- [x] All decisions followed.
- [x] M3 stays in packages/client; no worker/Swift/proto changes.
- [x] `plans/README.md` updated.

External acceptance, separate from code completion:

- [ ] Re-enable production COFLUX_P2P_ENABLED.
- [ ] Measure recovery and hole-punch success over real NAT/STUN between locations.
- [ ] Safari/Firefox and physical iOS regression checks.

## STOP conditions

- A cited fact no longer holds.
- Tests prove thresholds cannot be both faster than ICE and safe for normal slow links: redesign the criterion rather than forcing numbers.
- M3 cannot isolate brief control loss without worker changes: stop and report; worker authorization needs reconsideration.
- Out-of-scope changes required.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- **This plan itself records a lesson**: two untested production changes on 2026-08-17 worsened the incident, then were rolled back. First, reconnect bypassed credentials and hit shouldRetry's permanent-disconnect corner. Second, failure detection invoked setControlOnline(false), destroying all data channels and blocking recovery. **Downstream coupling magnifies false liveness decisions; deterministic tests must precede production.**
- **The initial P2P-crash/MTU diagnosis was wrong**, disproved by 15/17 already-closed channels and uninterrupted Home control. Preserve this in Requirement: **"disabling X helped" does not establish causality in a multi-stage chain**, especially when server restart and page refresh occur simultaneously.
- Plan 076 accepted webrtc-rs closure being invisible to werift until ~30s ICE timeout on the assumption existing recovery sufficed. That was already incorrect: recovery depended on onclose, absent here. **When adding transport, verify every signal the existing recovery logic depends on.**
- Production COFLUX_P2P_ENABLED=0 is temporary mitigation, not the final state. Re-enable after acceptance or P2P remains dead functionality.
- Missing incident evidence: Work browser console WS errors. Capture them first on recurrence to directly confirm silent control failure.

The targeted client validation is `node --test packages/client/src/device-router.test.ts`. Heartbeat constants are `HEARTBEAT_INTERVAL_MS = 15_000` and `HEARTBEAT_TIMEOUT_MS = 5_000`.

### Original source references

`device-router.ts:63`, `device-router.test.ts:267`, `device-router.ts:1716-1720`, `device-router.ts:1957-1961`.
