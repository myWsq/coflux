# Plan 20260926-agent-endpoint-hardening: only processes inside a coflux terminal can drive the local agent endpoints

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 7ae49ea8..HEAD -- crates/worker/src/hook.rs crates/worker/src/gateway.rs crates/worker/src/ports.rs crates/worker/src/secret crates/worker/src/main.rs crates/cli/src packages/cli/coflux.mjs tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH — security boundary of the local control surface; every agent command and hook goes through it
- Depends on: wiki/plans/20260926-agent-secret-input.md (DONE on this branch; reuses its `ipc/` socket module)
- Category: bug
- Execution: subagent(opus) — departure check in chat after the hazard was raised
- Stop after: implementation — same departure check (plan audit, then continue)
- Plan review: audit — same departure check
- Workspace: current — already in the linked worktree `.claude/worktrees/20260926-agent-secret-input` on `dev/20260926-agent-secret-input`
- Planned at: `7ae49ea8`, 2026-09-26

## Requirement

The worker's local control surface — `POST /agent` (every `coflux terminal|notify|progress|ports|workspace|executor` command) and `POST /hook` (agent turn-state events) — is plain HTTP on the loopback gateway port (default 8788). Identity is the caller's **self-reported** pid, checked only for sitting inside a live coflux session's process tree; the request is otherwise accepted on the strength of `content-type: application/json` alone (`crates/worker/src/hook.rs:16-19`, `196-204`; `parse_head` at `hook.rs:556-583` reads no `Host` or `Origin`). Three consequences:

1. **A web page can drive the user's terminals.** With DNS rebinding the attacker's domain resolves to 127.0.0.1, the request becomes same-origin, the JSON content type needs no preflight, and the page brute-forces a pid inside a session tree; `terminal.run` then types commands into the user's shell. Chrome's local-network-access checks stop this; Firefox and Safari do not.
2. **On Linux, any local user can read and type into another user's coflux terminals**, because loopback TCP is reachable by every account on the machine.
3. **Any same-user process can impersonate a session.** That grants no privilege a same-user process lacks (it can already read `~/.coflux` credentials and gateway grants), but it breaks the rule that identity comes from the process tree, not from what the caller says.

Done means: a browser request and a request from another Linux user are refused on the TCP endpoints; current clients (the Rust `coflux` CLI and the npm `coflux.mjs`) no longer use TCP at all when the worker offers the kernel-attested socket, and their identity there comes from the kernel, never from the body. Agents already running with an older pinned CLI keep working through the hardened TCP path until they are relaunched. Nothing the agent or user sees changes.

## Decisions & tradeoffs

- **Harden TCP `/agent` and `/hook` in place: exact `Host`, no `Origin`.** A request is refused unless its `Host` header is exactly `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, where `<port>` is the accepted stream's own `local_addr().port()` (both listeners always share one port, `crates/worker/src/gateway.rs:77-96`). A missing `Host` is refused. Any `Origin` header is refused, whatever its value, including `Origin: null`. *(revised on plan audit)* Browsers always send `Origin` on POST and put the attacker's host name in `Host` under DNS rebinding; the CLIs send neither problem (`crates/cli/src/gateway.rs:~138` sends `host: 127.0.0.1:{port}`; Node `fetch` sends `127.0.0.1:<port>`). A refusal is a readable 403, not the generic `bad request`. Rejected: an `Origin` allow-list — the endpoints have no legitimate browser caller. Rejected: relying on the content-type preflight — void under DNS rebinding.

- **Linux: the TCP caller must run as the worker's user.** The worker maps the connection's peer address/port to its row in `/proc/net/tcp` / `/proc/net/tcp6` and compares that row's `uid` column with `geteuid()` (`libc` is already a worker dependency, `crates/worker/Cargo.toml:37`); a mismatch is refused. *(revised on plan audit)* Specified precisely:
  - the lookup runs right after `accept`, before reading the request (a legitimate client keeps its end open until it has the response, `crates/cli/src/gateway.rs:149-159`);
  - the caller's row is the one whose `local_address` is the peer address and whose `rem_address` is the gateway address, **with `st == 01` (ESTABLISHED)** — a TIME_WAIT/orphan row prints uid 0, which a root worker would otherwise accept;
  - addresses are compared by decoding each 32-bit hex word in **native byte order** (`u32::to_ne_bytes`), not a hardcoded endianness; an AF_INET6 client on the v4 listener shows up in `tcp6` as an IPv4-mapped address (`…FFFF0000` + v4 word);
  - no matching row → re-read once or twice (`seq_file` can skip rows while the table changes), then refuse;
  - `ports.rs` only parses ports (`crates/worker/src/ports.rs:222-248`); the address parsing is new code — share file reading, not pretend reuse. macOS has no equivalent file; there the TCP path relies on the Host/Origin check, and cross-user macOS machines are out of the threat model. Rejected: mapping the TCP connection to a pid (libproc socket enumeration on macOS) — heavy, and the UDS below makes it unnecessary for current clients.

- **Current clients move to a kernel-attested Unix socket; the body pid stops being identity there.** The worker serves the same `/agent` and `/hook` semantics on `$COFLUX_HOME/ipc/agent.sock` in the `ipc/` directory the secret socket already prepares (0700 directory, 0600 socket, stale-socket probe then bind — reuse, do not duplicate, `crates/worker/src/secret/socket.rs`). Identity is `peer_cred()` pid + uid → `session_of_pid(&alive, peer_pid, peer_pid)` — the peer pid replaces **both** the body `pid` and `ppid`, exactly as the secret socket does (`crates/worker/src/secret/socket.rs:~256`); today those two fields are consumed only by `session_of_pid` (`crates/worker/src/main.rs:494-497`, `crates/worker/src/agent_ctl.rs:259-263`). *(revised on plan audit)*
  - **Framing is fixed: the same HTTP/1.1 request and response over the stream**, so the handlers are shared by making `hook::serve`/`handle`/`read_head` generic over `AsyncRead + AsyncWrite + Unpin` (they only use `read`/`write_all`/`shutdown`, `hook.rs:160-275`, `532-553`); the gateway's `peek` split is not needed on the socket.
  - **On the socket there is no Host check, no Origin check and no `/proc` lookup** — Node's `http.request({ socketPath })` sends `Host: localhost` with no port, and identity comes only from `peer_cred()`.
  - **`pid` and `ppid` become optional in both bodies** (`#[serde(default)]` on `HookBody` `hook.rs:115` and `AgentBody` `hook.rs:297`): on the socket a body without them must be accepted; on TCP they remain required in practice (a missing pid fails the session lookup). Both the Rust CLI (`crates/cli/src/gateway.rs` `post_json` and `agent` ~191, `crates/cli/src/integration.rs:~146-160` `local_at`, `crates/cli/src/integration.rs:353-362` the `coflux agent hook` `/hook` post, `crates/cli/src/commands.rs:~801-810` hook) and the npm CLI (`packages/cli/coflux.mjs` `agentPostResult` ~168-172 via `node:http` `socketPath`, and the hook sender ~90-111) use it. **The socket is tried before the gateway port is resolved**; `COFLUX_LOCAL_GATEWAY_PORT` is read only on the socket-absent branch (today every call site resolves the port first and `local_gateway_port_from(Some("0"))` errors, `crates/cli/src/gateway.rs:35-38`). Rejected: a per-terminal token injected into the PTY environment — it lives in the supervisor (not hot-upgradable, `AGENTS.md`), terminals opened before a runtime restart would lack it, and same-user processes can read environments on Linux.

- **Client fallback is by absence, never by refusal.** A current client uses the socket when it exists; it falls back to TCP only when the socket file is missing or the connection is refused because nobody listens (an older worker). A reply from the socket — including any refusal — is final; the client never retries over TCP. A `connect()` refused by a sandbox (`EPERM`/`EACCES`) is not absence: fail hard and name the socket path. *(revised on plan audit)* Rejected: "try UDS, on any error try TCP" — it would turn every socket refusal into a TCP retry that re-opens the self-reported-pid path.

- **The hardened TCP path stays for this release.** Agents keep their pinned CLI bundle until relaunch (`~/.coflux/agent-integrations/<hash>/coflux`; `packages/cli/skills/coflux/SKILL.md` "Managed terminal integration"), and the worker hot-upgrades under them; removing TCP now would break every running agent's `coflux` commands and hooks. Removal is a later release, recorded below.

- **One black-box test file for the invisible negatives** (`AGENTS.md` "Test harness": a break here stays invisible while using the product): on TCP, a foreign `Host`, a missing `Host`, a `Host` with the wrong port, `Origin: http://x` and `Origin: null` are all refused while a CLI-shaped request with a valid in-tree pid still works; on the socket, a caller outside every session tree is refused even when the body names a live session's pid; inside a test terminal (where the harness sets `COFLUX_LOCAL_GATEWAY_PORT=0`, so TCP is impossible) both `coflux terminal list` from the built Rust CLI **and** `node packages/cli/coflux.mjs terminal list` succeed — proof both clients use the socket first. *(revised on plan audit)* The Linux uid check has a unit test on fixture `/proc/net/tcp{,6}` content covering a v4 row, a `::1` row, an IPv4-mapped row, a TIME_WAIT row with uid 0, and no row (CI runs `cargo test -p coflux-worker` on Ubuntu, `.github/workflows/ci.yml:184`); the check is wired into the TCP accept path, not only unit-tested.

## Direction

### Milestone 1: worker — hardened TCP and the agent socket

TCP `/agent` and `/hook` enforce Host/Origin (and uid on Linux); `$COFLUX_HOME/ipc/agent.sock` serves both paths with kernel identity, sharing the existing request parsing and dispatch. Validation: `cargo build --release -p coflux-worker` zero warnings; `COFLUX_HOME= cargo test -p coflux-worker` passes.

### Milestone 2: clients

The Rust CLI and the npm CLI prefer the socket with fallback-by-absence only; the npm CLI's socket client must not import application code beyond what `coflux.mjs` already does. Validation: `cargo build --release -p coflux-cli` zero warnings; `COFLUX_HOME= cargo test -p coflux-cli` passes; `node --check packages/cli/coflux.mjs`.

### Milestone 3: black-box negatives

One new `tests/src/*.test.mjs` on an unused port (8826, 8828-8831 are taken; 8827 or 8832 are free). The gateway port is `device.gateway.port` (`tests/src/device-harness.mjs:~256`); the socket lives under the stack's `COFLUX_HOME`. Validation: `node --import tsx --test tests/src/<file>.test.mjs`.

Milestone 2 needs milestone 1's socket path and framing; milestone 3 needs both. One sequential package.

## Landmines

- **The black-box harness sets `COFLUX_LOCAL_GATEWAY_PORT=0` for PTYs** (`tests/src/harness.mjs:835`), so a CLI in a test terminal cannot reach TCP today; the new socket makes local commands reachable there. Existing tests must not start depending on that by accident, and the new test must still exercise TCP by connecting to the gateway port the harness knows.
- **Ephemeral ports in tests**: the Host check uses the accepted stream's local port, never a hardcoded 8788.
- **`/proc/net/tcp` addresses are hex, little-endian per 32-bit word, and IPv4-mapped addresses appear in `tcp6`.** Match on the peer's local-side port *and* address, from the caller's point of view (the caller's socket is the row whose `local_address` is the peer address and `rem_address` is the gateway address).
- **Codex sandbox reachability** (unverified on this machine: the local `codex` is aliased to `--yolo`): a Codex seatbelt without network denies `network*`, which covers loopback TCP as well as Unix-socket connects, so a sandboxed shell cannot reach the worker today either — the move is not a regression. Do not add a refusal-triggered TCP retry to work around it.
- **`ipc/` preparation is idempotent** (`secret/socket.rs:147-169`); prepare it once and serve both sockets from it rather than duplicating the code.
- **The Bash guard in this repository rejects compound git commands**; run git commands one per call.

## Scope

In scope:
- `crates/worker/src/hook.rs`, `crates/worker/src/gateway.rs`, `crates/worker/src/ports.rs` (only to share `/proc/net/tcp` parsing), `crates/worker/src/secret/socket.rs` (only to share `ipc/` preparation), `crates/worker/src/main.rs`, a new worker module for the agent socket if wanted
- `crates/cli/src/**`
- `packages/cli/coflux.mjs`
- `tests/src/<new>.test.mjs`
- `wiki/plans/README.md`

Out of scope:
- `crates/supervisor`, `coflux-ptyd` — no PTY environment change
- the WebSocket `/device` path of the gateway — already Origin-checked and P-256 authenticated
- removing the TCP `/agent` / `/hook` path — a later release
- `integrations/claude-plugin` scripts — they invoke the installed `coflux` CLI, which this plan updates
- protocol, server, desktop, iOS

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `cargo build --release -p coflux-worker -p coflux-cli` | zero warnings |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-worker -p coflux-cli` | exit 0 |
| npm CLI syntax | `node --check packages/cli/coflux.mjs` | exit 0 |
| New black-box file | `node --import tsx --test tests/src/<new>.test.mjs` | exit 0 (run after `pnpm -C tests run pretest`, with `FORCE_COLOR` unset) |
| Black-box suite (acceptance) | `pnpm -C tests test` | exit 0 — needs local Postgres on 5432, no other suite running |
| Real terminal check (acceptance) | in a coflux terminal on this branch's daemon: `coflux terminal list`, `coflux progress x`, an agent turn changing the sidebar state | all work over the socket; `curl -X POST -H 'content-type: application/json' -H 'Origin: http://x' http://127.0.0.1:8788/agent -d '{}'` is refused |

## Done criteria

- [ ] All non-acceptance commands pass; the black-box suite passes.
- [ ] TCP `/agent` and `/hook` refuse a foreign, missing or wrong-port `Host`, and any `Origin` including `null`, with a readable 403; the CLI-shaped request still works.
- [ ] On Linux, a TCP caller whose ESTABLISHED socket row's uid is not `geteuid()` is refused; the fixture unit test covers v4, `::1`, IPv4-mapped, TIME_WAIT uid 0 and no-row cases; the check is called from the TCP accept path.
- [ ] `$COFLUX_HOME/ipc/agent.sock` serves `/agent` and `/hook` with kernel identity; a body **without** `pid`/`ppid` is accepted there and a forged body pid changes nothing; an out-of-tree caller is refused.
- [ ] Both CLIs try the socket before resolving the gateway port, fall back to TCP only when it is absent (not on `EPERM`/`EACCES`), and never retry over TCP after a socket reply; both succeed in a test terminal where `COFLUX_LOCAL_GATEWAY_PORT=0`.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (for example, the CLIs already send an `Origin`, or `/agent` already has another caller that is a browser).
- A legitimate caller of `/agent` or `/hook` is found that sends a different `Host` or an `Origin` (the desktop main process, a plugin script) — report it instead of widening the check.
- The work requires supervisor or protocol changes.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- **Remove TCP `/agent` and `/hook` in a later release** once pinned integration bundles older than this change are no longer in use; after that, the gateway port serves only WebSocket `/device`.
- Plan audit (fable) findings were all accepted; none rejected.
- macOS keeps no uid check on the TCP fallback during the transition; the Host/Origin check is what stops the web path there.
- The secret socket and the agent socket share `ipc/`; a future move of any other local surface should land there too.
