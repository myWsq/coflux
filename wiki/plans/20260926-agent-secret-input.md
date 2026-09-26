# Plan 20260926-agent-secret-input: agents obtain user secrets without the value entering their context

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 3679d5ca..HEAD -- proto crates/protocol crates/worker/src crates/supervisor/src/manager.rs packages/swift-client/Sources/CofluxProtocol/Generated crates/cli/src packages/protocol packages/client/src packages/cli apps/server/src apps/desktop/src packages/cli/skills integrations/claude-plugin tests/src`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH — new wire messages, a new local IPC surface, and secret custody
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; this plan lives on `dev/20260926-agent-secret-input` in `.claude/worktrees/20260926-agent-secret-input`
- Planned at: `3679d5ca`, 2026-09-26

## Requirement

An agent running in a coflux terminal (Claude Code, Codex) sometimes needs a secret from the user — an API key, a database password — to hand to a **non-interactive** destination: a command that reads it from the environment, or a dotenv/config file. Today the only options are asking the user to paste it into the chat (the value lands in the transcript, the model provider's logs, and the screen) or asking them to edit files by hand.

The standard answer is MCP 2025-11-25 elicitation: form mode MUST NOT carry passwords, API keys or tokens; the value is collected out of band by the *server*, which stores and uses it, and the client/LLM only ever learns accept / decline / cancel. 1Password (`op run` / `op inject`: the agent holds a reference, the tool resolves it at execution time) and GitHub Actions masking (known values are redacted from logs) are the same idea. In coflux the **worker is the server** that holds and uses the value, and the **desktop is where the user types it**. The agent never receives the value — it receives a name and an outcome, and delegates every use of the value to coflux.

This is **not an MCP tool**: MCP was removed from coflux, and agents reach coflux only through the `coflux` CLI talking to the local daemon (local-first). Interactive prompts (ssh, sudo) keep the existing flow — open a terminal the user can take over, `coflux notify`, `coflux terminal wait` — and are not part of this plan.

Honest boundary: once a value is in an environment variable of a process the agent drives, or in a file the agent can read, a deliberately malicious agent can still print it. This feature prevents *accidental* leakage into transcripts, provider logs, the center, and the screen; it does not defend against a hostile agent.

### Product conclusions (confirmed with the user)

**CLI (agent side)**

- `coflux secret ask NAME --reason "<why>"` blocks until the user answers or it times out (default 10 minutes, `--timeout` to change), then prints exactly one outcome: `provided`, `declined`, or `cancelled` (closing the card and timing out are both `cancelled`). Asking again for a NAME that already has a value re-prompts and replaces it.
- `coflux secret exec NAME [NAME…] -- <cmd> [args…]` runs the command with each value in a same-name environment variable. Every occurrence of a held value in the child's stdout/stderr is replaced with `***`. The child's exit code is passed through.
- `coflux secret inject NAME --file <path> [--key K]` inserts or updates `K=value` in a dotenv file (`K` defaults to `NAME`). The path must resolve inside the caller's effective workspace. Output says only that the file was written.
- `exec` / `inject` on a NAME with no value fail readably and tell the agent to `ask` first.

**Desktop (user side)**

- The request appears as a **card overlaid on the requesting terminal's pane**; it never steals focus. It shows the source (device, workspace, terminal), the NAME, the reason clearly labelled as written by the agent, a masked input, and Provide / Decline.
- It also produces an inbox entry, which brings the existing system notification and badge count with it; clicking either opens that terminal.
- Every desktop client of the account shows the card; the first submission wins and the others close.
- States: pending; submitting; provided (card disappears); answered elsewhere (card closes); expired (card closes, inbox entry reads as ended); submit failed (input kept, retry possible).
- iOS is out of scope.

**Lifetime and scope**: values live only in worker memory, never on disk. A value belongs to the terminal (session) that asked for it; only that session can use it, and it is cleared when that session ends. A worker hot upgrade or daemon runtime restart loses it; the agent asks again.

**Anti-leak**: held values are redacted to `***` in what `coflux terminal read` returns and in `coflux secret exec` output.

**Non-goals**: MCP; persistence (keychain or file); iOS; interactive password prompts; gitignore checks before `inject`; cross-device use (`--remote`, `coflux device exec`); multi-field forms; defending against a malicious agent.

**What the user observes when done**: the agent's transcript shows only `provided`; a command run through `secret exec` sees the variable; `inject` writes the dotenv entry; `terminal read` and `secret exec` output show `***` where the value was; after the terminal closes, `secret exec` in a new terminal reports that the NAME was not provided.

## Decisions & tradeoffs

- **Delivery surface**: a `coflux secret ask|exec|inject` CLI family served by the local worker. Rejected: an MCP server — MCP was removed and the local-first rule says PTY agents talk only to their local daemon. Based on: `AGENTS.md` ("MCP and its dedicated OAuth entry points have been removed"); `packages/cli/skills/coflux/SKILL.md` "Local commands".

- **Every `secret` action travels over a new kernel-attested local socket, never the existing `/agent` HTTP endpoint** *(decided while planning — widened from "exec only")*. The worker listens on a Unix domain socket under `COFLUX_HOME` (socket 0600 in a directory only the owner can enter). For every connection it takes the caller's pid from the kernel — tokio's `UnixStream::peer_cred()` already returns it on both platforms (`LOCAL_PEEREPID` / `SO_PEERCRED`, tokio 1.52.3 `src/net/unix/ucred.rs`), so no new dependency is needed — never from the request body, and requires that pid to sit inside a live session's process tree; that session is the caller's identity and the only session whose values it can touch. `ask`, value release for `exec`, and `inject` all go through this socket. Rejected: adding these actions to `/agent` — it is loopback TCP where the caller *self-reports* its pid, so any local process (on Linux, any local user) can impersonate a session: a forged `ask` would let it put a phishing card in front of the user, and a forged `inject` would write the value into a file of its choosing. Based on: `crates/worker/src/hook.rs:16-19` (unauthenticated endpoint, pid reverse lookup is the only gate), `crates/cli/src/gateway.rs:196` (`post_json(port, "/agent", …)`), `packages/cli/coflux.mjs:23` (default port 8788).

- **The value reaches the worker only over the device channel**, the same end-to-end channel desktop terminal input uses (loopback for a local device, Tailcat for a remote one). New `DeviceEnvelope` payloads carry provide and decline, and the worker answers each with an explicit acknowledgement (accepted / already answered / expired / unknown request) so the card leaves "submitting" without waiting for the center. *(revised on plan audit)* Scopes are granted per channel, not per session: provide/decline require only that the channel holds `SESSION_CONTROL`; they do **not** require attaching the terminal or holding its input (`holder_epoch`), because a desktop that never opened that terminal must be able to answer. The worker arbitrates by `request_id` — first answer wins, later ones get "already answered". On the client this is a typed method on the device router that retains the device for the duration of the send (a desktop that has not selected that device has no lane otherwise), not a generic envelope send. Rejected: submitting through the center — the center would see plaintext. Rejected: binding provide to the attached input holder — locks out every other desktop. Based on: `proto/coflux/v1/device.proto:818`, `crates/worker/src/device.rs:4025-4058` (`required_scope` by payload type), `crates/worker/src/device.rs:2545` (`effective_scopes` by principal), `proto/coflux/v1/device.proto:332` (`holder_epoch` on `PtyInput`), `packages/client/src/device-router.ts:790-804` (`ensureSessionLane` rejects without demand), `packages/client/src/device-router.ts:2380-2531` (typed methods only), `apps/server/src/local-control.ts:152` and `apps/server/src/tailcat-rendezvous.ts:9` (SESSION_CONTROL granted locally and remotely).

- **Pending-request metadata rides the center as ephemeral state, never the value**. Request id, NAME, reason, deadline and the owning task/session go worker → center as an idempotent full snapshot (re-sent on change and unconditionally after auth), exactly the shape of `SessionAgents`; the center keeps it in memory only, never in Postgres, and fans it out to every client of the account. This snapshot drives the card and closes it on other desktops — nothing else. *(revised on plan audit)* The system notification, dock badge and click-to-open-terminal come **only** from the existing inbox path: the worker creates one persisted notify per request (text: NAME and reason only), and the desktop already raises a system notification for each new inbox item, counts unread items in the badge, and navigates to the item's task on click. No new attention kind is added to `desktop-attention.ts` — that would ring and count twice. An inbox entry reads as ended when its `task_id` has no pending request in the live snapshot; no protocol field is added for this. The center validates each snapshot's session/task ownership against its catalog the way it does for `SessionAgents`, and re-sends it to a reconnecting client. Rejected: persisting request state in the center — needless, and a restart would resurrect requests nobody can answer. Rejected: a new attention kind alongside the inbox — double notification and double badge. Based on: `proto/coflux/v1/daemon.proto:96-100`, `proto/coflux/v1/common.proto:105-128`, `proto/coflux/v1/common.proto:187-199` (`AccountNotification` exposes `task_id`, not the request key), `proto/coflux/v1/client.proto:252`, `proto/coflux/v1/daemon.proto:222` (`AgentNotify`), `apps/desktop/src/renderer/components/workbench/notification-inbox.tsx:27-35` (navigate + `desktop.notify` per item), `apps/desktop/src/renderer/components/workbench/workbench.tsx:199` (badge = waiting + unread), `apps/server/src/hub.ts:1821-1860` (`acceptSessionAgents` validation), `apps/server/src/hub.ts:2819` (resend on reconnect).

- **Custody**: worker memory, keyed by the requesting session, zeroed and dropped when that session ends — hooked on **every** path that removes a session from the worker's live table (the supervisor-exit commit and the resync reconciliation that replaces the table wholesale), not only on the exit message. *(revised on plan audit)* Nothing is written to disk, logged, included in panics or `Debug` output, or sent to the supervisor or the center. A hot upgrade loses values and pending requests; a CLI waiting across one must end with `cancelled` (or a readable error), not hang. If the CLI's socket connection closes while its `ask` is pending (Ctrl-C, agent killed), the worker withdraws that request and republishes the snapshot so the cards close. If the worker has no authenticated center connection when `ask` arrives, `ask` fails at once with a readable reason instead of waiting out its timeout, because no desktop can see the card. Based on: `crates/worker/src/main.rs:995-1009` (`commit_supervisor_exit`), `crates/worker/src/main.rs:1120-1135` (resync replaces `alive`), `crates/worker/src/main.rs:1497` (`connection_authed`), `crates/worker/src/device.rs:3240` (the `current_matches` guard makes exit-then-clear race-free for in-flight checkpoints). Rejected: holding values in the supervisor so they survive hot upgrades — widens the rarely-upgraded supervisor's surface for a convenience the user explicitly traded away ("memory only").

- **`inject` is performed by the worker itself**; the value never leaves the worker on that path. The target is resolved and canonicalized (including the parent of a file that does not exist yet) and must lie inside the caller's effective workspace; a symlink that escapes it is refused. A newly created file is owner-only. The effective workspace comes from the caller's reported cwd, as for every other local command; that is acceptable because the caller is already kernel-attested to be inside the session, and the agent itself is outside the threat model. Rejected: returning the value to the CLI and letting it write — needless exposure in another process. Based on: `crates/cli/src/gateway.rs:68` (`caller_cwd`).

- **Redaction happens in the worker on every path where scrollback leaves toward an agent or the center**: the local `terminal read` (`crates/worker/src/agent_ctl.rs:357-370`), the center-initiated terminal read (`crates/worker/src/agent_ctl.rs:1390`), and the `SessionCheckpoint` published to the center (`crates/worker/src/device.rs:3268`) — without the last two, an echoed secret lands in Postgres and in account-CLI reads. *(revised on plan audit)* The redaction set is **every value any session in this worker currently holds, plus values since replaced by a re-ask until their session ends** — not just the snapshot's own session: an agent in session S can `inject` a file and then `terminal run "cat .env"` in another terminal T2 of the same workspace, whose own value set is empty (`crates/worker/src/agent_ctl.rs:759-790` resolves any terminal in the effective workspace). The live PTY stream and device-channel snapshots served to the user's own desktop are **not** redacted. Redaction applies before any tail truncation. `secret exec` redacts in the CLI, and must catch a value split across two output chunks. Rejected: redacting only local `terminal read` — the two center-facing paths would leak silently.

- **Rust CLI only; the npm CLI delegates** *(decided while planning)*. `coflux secret` is implemented in `crates/cli`; `packages/cli/coflux.mjs` forwards `secret` to the native binary the same way it already forwards `agent` and `workspace enter`. Rejected: a second JavaScript implementation of a peer-credential socket client and output masking. Based on: `packages/cli/coflux.mjs:11-22`.

- **Protocol changes are additive, defined once in `proto/`, and generated into both `crates/protocol/src/gen` and `packages/protocol/src/gen`** (`cd proto && buf generate`); CI fails on generated drift and on breaking changes. Based on: `.github/workflows/ci.yml:49-122`.

- **One black-box test, for negatives you cannot see while using the product**: a process connecting to the socket from outside every session's process tree is refused for ask, value release and inject; `terminal read` and the center checkpoint show `***` for a held value, including when the value was echoed in a *different* terminal of the same workspace. The socket's wire format must be simple enough (for example line-delimited JSON) that the test's Node client speaks it without importing application code. Nothing else gets a new test. *(revised on plan audit)* Based on: `AGENTS.md` "Test harness" ("a new test belongs here only if a break would stay invisible while using the product").

## Direction

Data flow, end to end:

```text
agent ──coflux secret ask──▶ CLI ──UDS (kernel pid → session)──▶ worker
worker ──pending snapshot (no value)──▶ center (memory) ──▶ every desktop: card
worker ──one notify (NAME + reason)──▶ center (inbox) ──▶ every desktop: system notification + badge
user types ──▶ desktop ──device channel (E2E, SESSION_CONTROL, no attach needed)──▶ worker  [first answer wins] ──ack──▶ desktop
worker ──outcome──▶ CLI ──▶ agent sees "provided"
agent ──coflux secret exec NAME -- cmd──▶ CLI ──UDS──▶ worker releases value to this CLI ──▶ child env; output masked
agent ──coflux secret inject NAME --file f──▶ CLI ──UDS──▶ worker writes f itself
```

Follow existing conventions: the worker's local-control module structure (`crates/worker/src/agent_ctl.rs`), the idempotent-snapshot pattern of `SessionAgents`/`PortsUpdate`, `docs/design-guidelines.md` for the card (the Tooltip component, never a native `title`), and English for new code comments and the skill.

### Milestone 1: protocol and worker custody

The wire messages exist in `proto/` and are generated for Rust and TS. The worker serves the secret socket with kernel-attested identity, arbitrates ask → provide/decline/expiry, holds values per session and drops them when the session ends, releases values for `exec` only to the session that owns them, performs `inject`, redacts the three outbound snapshot paths, publishes the pending snapshot to the center, and accepts provide/decline envelopes on the device channel. Validation: `cd proto && buf lint && buf generate` leaves no diff in the generated dirs; `cargo build --release -p coflux-worker` has zero warnings; `cargo test -p coflux-protocol -p coflux-worker` passes.

### Milestone 2: center fan-out and client store

The server keeps each daemon's latest pending snapshot in memory (validated against its catalog like `SessionAgents`), clears it when the daemon disconnects, and forwards it to the account's clients (including after a client reconnects); `packages/client` exposes the pending requests per session in its store and gains the typed device-router method that sends provide/decline and resolves on the worker's acknowledgement. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` and `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` pass.

### Milestone 3: CLI and skill

`coflux secret ask|exec|inject` in the Rust CLI with the outcomes, errors and masking described above; the npm CLI forwards `secret`; `packages/cli/skills/coflux/SKILL.md` documents when to use it (non-interactive destinations only, the interactive flow stays as is, never ask the user to paste secrets into chat, unavailable to the built-in executor because it is not a PTY child) and the plugin copy is synced. Validation: `cargo test -p coflux-cli` passes; `node scripts/sync-claude-plugin.mjs` leaves both skill copies identical.

### Milestone 4: desktop card and inbox state

The card overlays the requesting terminal's pane with the states listed under Requirement, submits through the router method from milestone 2, moves on the worker's acknowledgement, and closes when the request leaves the pending set; inbox entries for secret requests read as ended once their task has no pending request. No new attention kind. Any new unit test is named `*.test.ts` (the desktop test glob skips `.tsx`). Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` pass. The walkthrough is the user's (acceptance).

### Milestone 5: black-box negatives

One new `tests/src/*.test.mjs` file drives a real stack and asserts the negatives listed under Decisions. The harness does not put the built `coflux` on the PTY's PATH (the supervisor only prepends `$COFLUX_HOME/bin`): copy `target/debug/coflux` into the temporary `COFLUX_HOME/bin/` or invoke it by absolute path. Validation: `node --import tsx --test tests/src/<file>.test.mjs` passes.

Dependencies: Milestone 1 gates everything (the generated types). After it, milestones 2 and 3 are independent of each other; milestone 4 needs milestone 2 (the client store); milestone 5 needs milestones 1 and 3.

## Landmines

- **The existing `/agent` endpoint trusts a self-reported pid** (`crates/worker/src/hook.rs:16-19`). Do not route any `secret` action through it, not even `ask`; the socket's peer credential is the identity.
- **Supervisor-owned PTY environment does not change on a worker hot upgrade.** If the CLI needs to find the socket, derive the path from `COFLUX_HOME` (default `~/.coflux`) rather than adding a PTY environment variable, or terminals opened before a runtime restart will not find it.
- **A stale socket file survives a crashed or replaced worker**; the new worker must replace it, and a second worker instance must not steal a live one.
- **Three snapshot paths, not one** (`agent_ctl.rs:369`, `agent_ctl.rs:1390`, `device.rs:3268`). The checkpoint path runs on its own schedule inside the device runtime; redaction must see the same per-session value set there.
- **Local `/agent` rounds are bounded**: the endpoint must answer within `hook::AGENT_TIMEOUT` (25 s), which is why `terminal wait` loops rounds (`agent_ctl.rs:54-60`). The socket is not bound by that HTTP limit, but a blocking `ask` must still survive the worker going away mid-wait.
- **Old peers**: a new CLI against an old worker, and an old desktop that never renders the card, must fail readably — an unanswerable `ask` ends as `cancelled` at its timeout, and the CLI's message should say that no desktop may have shown the prompt.
- **Protocol breaking check in a worktree**: `scripts/check-protocol-breaking.mjs` needs a baseline argument; in a linked worktree `.git` is a file, so point the baseline at the common git dir, e.g. `node ../scripts/check-protocol-breaking.mjs "/Users/wsq/Workspace/coflux/.git#ref=3679d5ca,subdir=proto"` from `proto/`.
- **`buf generate` also rewrites the Swift client** (`proto/buf.gen.yaml` has `clean: true` and a third output to `packages/swift-client/Sources/CofluxProtocol/Generated`, checked for drift in CI at `.github/workflows/ci.yml:109-122`). Commit those regenerated files; they are in scope even though iOS behaviour is not.
- **No dependencies in the worktree**: `node_modules` is absent in this linked worktree; run `pnpm install` at preflight before any `tsc`, desktop or black-box command.
- **The built-in executor is not a PTY child** (`crates/worker/src/executor_host.rs:167`), so `session_of_pid` never matches it and `secret` is unavailable there by design.
- **Upgrades never run two workers at once** (`crates/supervisor/src/manager.rs:851` kills the old child before the monitor restarts it), so "probe the socket, then unlink and bind" is safe and does not break rollback.
- **Black-box port**: tests hardcode ports; existing ones are 8826, 8828, 8829, 8830 (`grep -h "PORT = " tests/src/*.test.mjs | sort`). Pick an unused one.
- **Frontend walkthrough is the user's**: do not run UI automation to verify the card.

## Scope

In scope:
- `proto/coflux/v1/*.proto` and the generated `crates/protocol/src/gen`, `packages/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`
- `crates/worker/src/**` (new secret module, socket, redaction hooks, device-channel handling, pending snapshot)
- `crates/cli/src/**` (`secret` subcommand)
- `packages/cli/coflux.mjs` (delegation only), `packages/cli/skills/coflux/SKILL.md`, `integrations/claude-plugin` skill copy via the sync script
- `apps/server/src/**` (in-memory pending snapshot, fan-out)
- `packages/client/src/**` (store for pending requests, device-router provide/decline method)
- `apps/desktop/src/renderer/**` (card, inbox ended state, submit)
- `tests/src/<new>.test.mjs`
- `wiki/plans/README.md`

Out of scope:
- `crates/supervisor`, `coflux-ptyd` — values never go there
- iOS app code and hand-written Swift client code — iOS is a non-goal (only the generated Swift protocol files change)
- `apps/desktop/src/renderer/components/workbench/desktop-attention.ts` — no new attention kind
- Server database schema/migrations — pending requests are memory-only
- Fixing the self-reported pid on `/agent` for existing commands — pre-existing hazard, report it separately
- Bumping `.claude-plugin/plugin.json` and the plugins-builder SHA — release step for the user

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies (preflight) | `pnpm install` | exit 0 |
| Proto lint + generate | `cd proto && buf lint && buf generate && git status --porcelain -- ../packages/protocol/src/gen ../crates/protocol/src/gen ../packages/swift-client/Sources/CofluxProtocol/Generated` | lint clean; after committing generated files, no drift |
| Proto breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "/Users/wsq/Workspace/coflux/.git#ref=3679d5ca,subdir=proto"` | exit 0 |
| Rust build | `cargo build --release -p coflux-worker -p coflux-cli` | zero warnings |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker -p coflux-cli` | exit 0 (empty `COFLUX_HOME` keeps this coflux terminal from polluting tests) |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client typecheck | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Desktop gates | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Skill sync | `node scripts/sync-claude-plugin.mjs && git diff --exit-code integrations/claude-plugin` | copies identical after commit |
| New black-box file | `node --import tsx --test tests/src/<new>.test.mjs` | exit 0 |
| Black-box suite (acceptance) | `pnpm -C tests test` | exit 0 — wire protocol touched; needs local Postgres on 5432, no other suite running |
| Desktop walkthrough (acceptance) | `pnpm dev:desktop:prod` with a daemon built from this branch — see the desktop-preview skill | user confirms card states; performed by the user |

## Done criteria

- [ ] All listed non-acceptance commands pass; the black-box suite passes.
- [ ] `coflux secret ask` returns only `provided` / `declined` / `cancelled`; the value never appears in CLI output, worker logs, center messages or Postgres.
- [ ] A process connecting from outside every session's process tree cannot ask, obtain or inject a value; the socket protocol carries no caller pid at all (asserted by the black-box file).
- [ ] `terminal read`, the center-initiated read and the center checkpoint show `***` for any value held in the worker, including one echoed in a different terminal than the one that asked; the user's live terminal is unchanged.
- [ ] Killing a pending `ask` closes the card on every desktop; `ask` with no center connection fails at once; provide from a desktop that never opened the terminal succeeds.
- [ ] One secret request produces exactly one system notification and one badge increment.
- [ ] Values are cleared on both session-removal paths (exit commit and resync reconciliation).
- [ ] `secret exec` passes the value as an env var, masks it in output (including across chunk boundaries — covered by a unit test in the CLI), and passes the exit code through.
- [ ] `secret inject` writes only inside the effective workspace and refuses symlink escapes.
- [ ] Values are dropped when their session ends; a new terminal cannot use them.
- [ ] The desktop card implements every state listed under Requirement; first answer wins across desktops.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (for example, `/agent` already authenticates callers, or the device channel lacks a per-session control scope).
- `UnixStream::peer_cred()` does not return a pid on macOS or Linux (verified as returning one in tokio 1.52.3 at planning time).
- The desktop cannot reach the device channel from the card without opening a new transport path.
- The outcome requires out-of-scope files (supervisor, iOS, database migrations).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- The pre-existing self-reported-pid hazard on `/agent` (any local process can already read any coflux terminal's scrollback via `terminal read`) is deliberately left alone here; the secret socket is the pattern a follow-up can move `/agent` onto.
- Redaction is a literal byte match; a value re-rendered with interleaved escape sequences or re-encoded (base64, URL-encoding) will not be caught. That is within the stated boundary (accidental leakage, not a hostile agent).
- Plan audit (fable) findings were all accepted; none rejected.
- Release note: new worker, server, desktop and CLI must all ship; the Claude plugin version bump and builder SHA are the user's release step.
