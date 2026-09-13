# Plan 20260913-device-exec: One-shot cross-device command execution under `coflux device`

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ee711cc5..HEAD -- proto crates/protocol packages/protocol crates/worker/src crates/cli/src packages/cli/account-client.mjs apps/server/src/hub.ts apps/server/src/daemon-capabilities.ts apps/server/src/interface/client-command apps/server/src/index.ts integrations/claude-plugin/skills AGENTS.md`

## Status

- Priority: P2
- Effort: M
- Risk: MED — touches the daemon wire protocol and widens what an account token can reach without a visible terminal
- Depends on: none
- Category: feature
- Execution: subagent opus (user decision at the departure check); verification and code review by the orchestrator
- Stop after: implementation — the user answered "继续" to an offer to execute the plan, superseding the earlier plan-only endpoint
- Workspace: isolated — `.claude/worktrees/20260913-device-exec`, branch `dev/20260913-device-exec`, cut from main `ee711cc5` with a clean tree
- Planned at: `ee711cc5`, 2026-09-13

## Requirement

### Problem

An agent on machine A that needs to run a command on machine B has exactly one
route today: borrow a Terminal. That means `coflux terminal new --workspace <id>
--cmd=…`, then `wait`, then `read`, then `stop` — four account calls — and it
drags in three constraints that have nothing to do with running a command:

- the target device must already have a registered workspace (a device whose
  `~` directory workspace was never created from the desktop UI cannot be
  reached at all, because no account operation creates one);
- typing the command depends on the shell's OSC 133 prompt-ready mark, so a
  device whose supervisor predates the shell integration refuses `--cmd` and
  `run` outright, leaving only blind `send` + `read`;
- each execution consumes one of the workspace's 8 concurrent live terminals.

The deeper problem is semantic. A coflux Terminal is a persistent object built
so the user can watch it and take it over. A one-shot execution that borrows
that body *is* a terminal in the user's sidebar for as long as it runs, which
is precisely the confusion this requirement exists to remove.

### What is true when this is done

`coflux device exec <deviceId> --cmd="…"` returns the command's stdout, stderr
and exit code in one call, and it is **not a Terminal**: no PTY on the remote
side, no task record in the center, no entry in the user's sidebar, no draw on
the terminal cap, no dependency on OSC 133, and no workspace of any kind
required. The semantics match `ssh host "cmd"`: the command string is handed to
the remote `sh -c`, no pty means no utmp/history trace on the device, and the
only record is a structured log line in the center.

### Consumer-visible surface (CLI)

```console
$ coflux device exec ba94a51a --cmd="cd /opt && ls | wc -l"
12
# exit=0

$ coflux device exec ba94a51a --cmd="cat /nonexistent"
cat: /nonexistent: No such file or directory      # on stderr, kept separate
# exit=1

$ coflux device exec ba94a51a --cmd="sleep 5" --cwd=~/logs --timeout=10
# exit=0

$ coflux device exec c4723d40 --cmd="uname -a"
✗ <device offline, one readable sentence>
```

- stdout goes to stdout, stderr goes to stderr, and the last line is
  `# exit=<code>`.
- `--cwd` accepts an absolute path or a `~` prefix; the default is the daemon
  user's HOME.
- `--timeout` is in seconds, defaults to 60, and is capped at 600. A timeout is
  a definite failure with the remote process killed, not a silent truncation.
- There is no stdin: anything that needs to be typed (a `sudo` password, a TUI,
  a confirmation prompt) fails immediately with a message pointing at
  `coflux terminal new`.
- Both CLIs expose it: the bundled Rust `coflux` and the npm `coflux`.

## Decisions & tradeoffs

- **A dedicated exec request, not an orchestration over Terminals**: the remote
  side allocates no PTY, the center creates no `Task` record, nothing appears in
  the sidebar, the workspace terminal cap is untouched, and OSC 133 is
  irrelevant. Rejected: wrapping `terminal new --cmd` + `wait` + `read` +
  `stop` into one command — while it runs it still *is* a terminal in the
  user's sidebar (glaring for a long command), and it stays bound to OSC 133
  and to "a workspace must exist first". Based on: user decision;
  `apps/server/src/hub.ts:3897` `createTerminalForAccount` creates an IDLE task
  and calls `emitTask` (sidebar visibility);
  `crates/worker/src/agent_ctl.rs:66` `NOT_INSTRUMENTED` is a hard refusal when
  the prompt mark never arrives.

- **The command string is handed to the remote `sh -c`**: `--cmd` takes one
  string and the device runs it through a shell, so pipes, `&&`, redirection,
  globs and `$VAR` all work. Rejected: passing `command` + `args[]` straight to
  execve the way the local channel does — `cd /opt && ls` would fail with "cd is
  not an executable", which an agent will hit on its first non-trivial command.
  Based on: user decision; `crates/worker/src/ops.rs:29` `run_command` spawns
  `command` with `args` and no shell involvement anywhere. Cost accepted:
  quoting is the caller's responsibility and there is no "injection-proof by
  construction" layer.

- **`--cwd` is the only addressing; `--workspace` is not offered**: default is
  the daemon user's HOME, and `--cwd` takes an absolute path or a `~` prefix
  (reuse `crates/worker/src/ops.rs:82` `expand_home`). Rejected: also accepting
  `--workspace <id>` — it would pull the workspace concept back into a
  device-level primitive that exists specifically to be free of Terminal and
  workspace semantics; an agent that wants to run inside a workspace passes the
  `path` from `coflux workspace list --device <id>` to `--cwd`. Based on: user
  decision. Corollary: restricting cwd buys nothing against a caller who
  already holds an account token, because the decision above gives them
  `sh -c` and therefore `cd /anywhere && …` — so no "ensure the device's home
  directory workspace" operation is needed, and none is added.

- **The center-to-device exec message carries a bare `cwd`, deliberately unlike
  the local `DeviceExecRun`**: when the worker serves a center exec it does not
  consult the WorkspaceList; it expands `~`, verifies the path exists and is a
  directory, and answers with a readable error when it is not, rather than
  letting the spawn fail with ENOENT. Rejected: copying `DeviceExecRun`'s
  `workspace_id` addressing — it directly contradicts the decision above.
  Based on: `proto/coflux/v1/device.proto:532`, whose comment ties
  `workspace_id` to "worker 只接受中心当前 WorkspaceList 中属于本 daemon 的 ID
  …不信 browser 路径" — that invariant's threat model is browser-supplied
  input, not an authenticated account CLI.

- **The new request/result branch hangs off `ServerAgentRequest` /
  `ServerAgentResult`, never off the `ServerToDaemon` / `DaemonToServer` top
  level**: it takes the next free field number in those two oneofs, alongside
  `terminal_read` / `terminal_input` / `terminal_run` / `terminal_wait`. Based
  on: `proto/coflux/v1/daemon.proto:547` reserves the field name `exec_run` in
  `ServerToDaemon` and `:286` reserves `exec_result` in `DaemonToServer`, with
  the comment that server-routed exec/fs was superseded by `DeviceEnvelope` —
  those two names are burned, while the `ServerAgentRequest` oneof is clean and
  is semantically exactly "a center-initiated agent request to a daemon".

- **Timeout defaults to 60s and is capped at 600s; longer work belongs to a
  Terminal**: this is the product boundary between the two, and the CLI help and
  the coflux SKILL must present it as a division of labour rather than a
  limitation — a short command whose result you want goes to `device exec`, a
  long job whose progress the user should see and be able to take over goes to
  `coflux terminal new`. Rejected: an unbounded timeout, or a streaming/async
  exec — exec is one-shot buffered by construction, so a long job would produce
  no intermediate output, which contradicts "the user can see what the agent is
  doing" while Terminals already solve that case. Based on:
  `crates/worker/src/ops.rs:11` `DEFAULT_TIMEOUT_MS = 60_000`;
  `apps/server/src/hub.ts:127` `TERMINAL_WAIT_MAX_MS = 600_000`.

- **No stdin**: the child keeps `Stdio::null()`, so a command that waits for
  input fails immediately instead of hanging, and the failure text points at
  `coflux terminal new`. Rejected: adding a stdin field — it would extend the
  protocol for a case that is Terminal's purpose. Based on:
  `crates/worker/src/ops.rs:41` `cmd.stdin(Stdio::null())`.

- **stdout and stderr are returned separately, each truncated with an explicit
  marker**: truncation must be visible in the output, never silent. The exact
  byte limits are the executor's call (see Direction). Based on: `ExecResult`
  already has separate `stdout` / `stderr` fields
  (`proto/coflux/v1/common.proto:133-134`); the account CLI hard-caps a
  response at 8 MB and errors past it (`crates/cli/src/account.rs:63`).

- **(decided while planning) The CLI exit code follows ssh: the remote exit code
  is passed through, and the CLI's own failures use 255**. Rejected: keeping the existing `die` exit
  code 1 for CLI-side failures — a remote command that returns 1 would then be
  indistinguishable from "the device is offline" or "the timeout elapsed",
  breaking any shell check around the command. Based on:
  `crates/cli/src/main.rs:17` `die` exits 1, which stays the convention
  everywhere else; this command is a deliberate exception.

- **A third daemon capability name gates the feature**, and a device that does
  not announce it gets the existing `daemonUpgradeRequired(deviceName)` text.
  Rejected: no gate — an old worker silently discards an unknown
  `ServerToDaemon` payload, so the caller would wait out the full timeout with
  no readable reason. Based on: the module comment in
  `apps/server/src/daemon-capabilities.ts` states exactly that, and that
  capability names are part of the protocol contract and must match the
  constants in `crates/worker/src/main.rs:133-139`.

- **Auditing follows ssh: a trace in the center's log, nothing in the UI, and no
  per-device switch**. The center logs acceptance and completion (account,
  device, cwd, command, exit code, duration) through the existing
  `createLogger` (`apps/server/src/index.ts:13,24`); the sidebar and the desktop
  app show nothing. Rejected: a per-device "allow remote exec" toggle — exec
  grants no capability that is not already reachable (the same token can do
  `terminal new --workspace` + `send` today and cause identical damage); it only
  reduces visibility, which is what the log restores, so a switch would add
  friction plus a false sense of protection. Rejected: a UI audit surface — the
  agent's stdout is already in its own conversation, and for a single-maintainer
  project that does not justify a new screen.

- **Cross-device exec does not violate local-first** (recorded so a later reader
  does not misread it): plan 093 withdrew "MCP single track" and
  `daemon.proto` moved server-routed exec/fs to `DeviceEnvelope` because
  *operations that can close locally must not detour through the center*. An
  agent on machine A executing on machine B cannot close locally at all — the
  center is the only possible path. Local exec keeps using `DeviceEnvelope` and
  is not rerouted. Based on: `proto/coflux/v1/daemon.proto:283`; the local
  `DeviceExecRun` path and its caller `crates/worker/src/device.rs:2510` stay
  untouched.

- **(decided while planning) The missing `coflux terminal run <id> --remote` in
  the Rust CLI is fixed in the same pass**: the center contract and handler
  both implement `terminal.run` and the npm CLI sends it, but the Rust
  `operation` match has no `("terminal","run")` arm, so the command that the
  HELP text and the coflux SKILL both advertise fails with "未知账号命令"
  (verified by running it). Based on:
  `apps/server/src/interface/client-command/client-command.contract.ts:13` and
  `client-command.handler.ts:38` have the op;
  `packages/cli/account-client.mjs:88` sends it;
  `crates/cli/src/account.rs:229-243` lacks the arm;
  `crates/cli/src/main.rs:29` advertises it. It is one arm in the very match
  this plan already edits, so folding it in saves a second protocol review.

## Direction

One exec, end to end: the CLI's `device exec` posts a new op to
`/api/client/command`; a new `*ForAccount` method on the hub checks device
ownership, liveness and the new capability, then calls `requestDaemonAgent`
**with an explicit timeout**; the worker routes the request to the existing
`ops::run_command` with `sh -c` and the resolved cwd; the result comes back as
ok / exit code / stdout / stderr / error; the hub logs it; the CLI prints the
two streams separately and passes the exit code through.

Milestone 1 is a prerequisite for all others. Milestones 2 and 3 depend only on
Milestone 1 and are **independent of each other** (one is the Rust daemon side,
the other the TypeScript center side), so they can be dispatched concurrently.
Milestone 4 needs both 2 and 3.

### Milestone 1: the wire contract, identical on both sides

The new exec request/result pair exists in the `ServerAgentRequest` /
`ServerAgentResult` oneofs, `crates/protocol` (Rust source of truth) and
`packages/protocol` (TS) are regenerated in step with identical wire format,
and the new capability name exists as a constant on both the TS and Rust sides.

Validation: `cargo test -p coflux-protocol` -> exit 0;
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0.

### Milestone 2: the worker executes it (daemon side)

A center exec request runs through `ops::run_command`: cwd defaults to the
daemon user's HOME, a `~` prefix is expanded, the path is verified to exist and
be a directory (readable error otherwise), the request's timeout applies under
the worker's own ceiling, stdin stays null, and stdout/stderr come back
separately with an explicit marker when truncated. The worker announces the new
capability.

Validation: `cargo build` -> exit 0 with zero warnings;
`cargo test -p coflux-protocol` -> exit 0.

### Milestone 3: the center accepts and gates it (server side)

The new op exists in the contract, the handler and the hub: device ownership is
checked, an offline device produces a readable error, a device missing the
capability produces `daemonUpgradeRequired`, the daemon request carries an
explicit timeout, and acceptance plus completion are logged as structured
events.

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` ->
exit 0.

### Milestone 4: the CLI surface on both CLIs

`crates/cli/src/account.rs` gains the `("device","exec")` arm and the missing
`("terminal","run")` arm; `packages/cli/account-client.mjs` sends the same op;
the HELP text and the coflux SKILL describe `device exec` and the exec/Terminal
division of labour; the exit code follows the ssh convention; the HTTP timeout
joins the `terminal wait` exception so a 600s exec is not cut off at 40s.

Validation: `pnpm -C tests test` -> exit 0 (this is the suite whose retained
`contract.test.mjs` exists precisely to guard the exec/fs wire contract between
the Rust daemon and the TS server).

## Landmines

1. `proto/coflux/v1/daemon.proto:547` reserves the field name `exec_run` in
   `ServerToDaemon`, and `:286` reserves `exec_result` in `DaemonToServer` —
   server-routed exec was deleted from those two top-level oneofs historically.
   The new branch can only live in `ServerAgentRequest` / `ServerAgentResult`
   (around `daemon.proto:344` and `:400`, field numbers 10-13 taken). Reusing
   either name at the top level collides with a reservation.
2. `apps/server/src/hub.ts:131` `AGENT_REQUEST_TIMEOUT_MS = 10_000` is the
   default for `requestDaemonAgent`. Exec must pass an explicit timeout the way
   `waitTerminalForAccount` does, or a 60-second command is declared a device
   timeout after 10 seconds.
3. `crates/cli/src/account.rs:180` sets the account HTTP timeout to 40s, with
   only `terminal wait` getting 610s. If exec does not join that exception,
   `--timeout=300` is cut off on the CLI side first.
4. The module comment in `apps/server/src/daemon-capabilities.ts` states that
   capability names are part of the protocol contract and must match
   `crates/worker/src/main.rs:133-139`. Adding the name on one side only means
   the gate never passes (or wrongly always passes).
5. `proto/coflux/v1/device.proto:532` carries the "do not trust browser paths"
   invariant on `DeviceExecRun.workspace_id`. The new center-side message
   deliberately does not copy it; copying it reintroduces `--workspace`.
6. AGENTS.md:64 — a protocol change must update both `crates/protocol` and
   `packages/protocol` with identical wire format (internally tagged `type`,
   camelCase). Touching one side makes the black-box suite fail somewhere
   unrelated and hard to localise.
7. `tests/src/*.test.mjs` hardcode their ports and two suites cannot run on one
   machine at the same time (AGENTS.md:88). If another session is running the
   black-box suite, a whole file collapses as a timeout that looks like a code
   bug.
8. The Debian device used for real-machine acceptance (daemonId
   `ba94a51a-9a26-41f3-adf8-809c2702c560`) still runs supervisor v1.1.1 with
   worker v1.2.0. It will not announce the new capability until
   `cofluxd update && cofluxd restart` runs there, and the gate will then
   correctly refuse — which looks like the feature not working.

## Scope

In scope:

- `proto/coflux/v1/daemon.proto` (and `common.proto` if the result shape needs a
  shared message)
- `crates/protocol/`, `packages/protocol/`
- `crates/worker/src/` — routing and serving the center exec request;
  `ops.rs` only if the existing primitive genuinely needs it
- `crates/worker/src/main.rs` — the capability name constant
- `apps/server/src/daemon-capabilities.ts`, `apps/server/src/hub.ts`,
  `apps/server/src/interface/client-command/`
- `crates/cli/src/account.rs`, `crates/cli/src/main.rs` (HELP),
  `packages/cli/account-client.mjs`
- `integrations/claude-plugin/skills/` — the coflux SKILL gains `device exec`
  and the exec/Terminal division of labour (English only)
- `wiki/plans/20260913-device-exec.md`, `wiki/plans/README.md`

Out of scope:

- Cross-device push/pull — `fs_read` / `fs_write` already exist on the local
  channel (`proto/coflux/v1/device.proto:768-771`) and the cross-device version
  is structurally identical work, but it is a separate requirement
- TCP port forwarding — shares no design with exec
- Rerouting local exec (it keeps using `DeviceEnvelope`)
- Any new desktop UI surface, including an audit view
- An "ensure the device's home directory workspace" center operation — the cwd
  decision removes the need for it

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust unit tests | `cargo test -p coflux-protocol` | exit 0 |
| Rust zero-warning build | `cargo build` | exit 0, no warnings |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Black-box wire contract | `pnpm -C tests test` | exit 0 |
| Real-machine acceptance (acceptance) | `coflux device exec` against a second device, cases below | see Done criteria |

## Done criteria

- [ ] All listed commands pass.
- [ ] `coflux device exec <online-device> --cmd="cd /tmp && pwd"` prints `/tmp`
      then `# exit=0`, and the CLI exits 0.
- [ ] `--cmd="cat /nonexistent"` sends the message to stderr and the CLI exits
      with the remote exit code.
- [ ] Four failures each produce one readable sentence and CLI exit 255: device
      offline, capability missing, cwd absent or not a directory, timeout.
- [ ] During and after an exec the user's sidebar gains no entry, and
      `coflux terminal list --workspace <any workspace of that device>` gains no
      row.
- [ ] The center logs an acceptance and a completion event carrying account,
      device and exit code.
- [ ] `coflux terminal run <id> --remote` no longer fails with "未知账号命令".
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular the
  two reserved field names, `AGENT_REQUEST_TIMEOUT_MS`, and the paired
  capability-name constants.
- The next free field number in the `ServerAgentRequest` oneof is already taken
  by something this plan did not anticipate.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- The exec/Terminal division of labour — short versus long, traceless versus
  visible, no stdin versus interactive — is this feature's product semantics.
  Revisit the timeout and stdin decisions before changing either.
- The capability name is one contract with two halves (TS and Rust). They must
  move together.
- Auditing lives only in the center's log. A UI audit surface would be a new
  requirement, not the completion of this one.
- If push/pull is taken up later, `fs_read` / `fs_write` map onto this plan's
  milestone split almost one-for-one.
