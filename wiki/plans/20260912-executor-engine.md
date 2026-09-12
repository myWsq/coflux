# Plan 20260912-executor-engine: Executor engine and transport — a built-in pi agent, sub-tasks handed over through `coflux executor`, executed in a desktop utilityProcess and locked inside the workspace by Seatbelt

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition.
>
> Drift check: `git diff --stat 7deedfb..HEAD -- proto/coflux/v1/device.proto crates/worker/src/agent_ctl.rs crates/worker/src/hook.rs crates/worker/src/agents.rs crates/worker/src/device.rs crates/worker/src/gateway.rs crates/cli/src/commands.rs crates/cli/src/gateway.rs crates/cli/src/main.rs apps/desktop/src/main apps/desktop/electron-builder.yml apps/desktop/package.json packages/client/src/device-router.ts apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/account-footer.tsx packages/cli/skills/coflux/SKILL.md`

## Status

- State: DONE (implemented on branch `dev/20260912-executor-engine`; not merged into main and not released)
- Priority: P2
- Effort: L
- Risk: HIGH (a new execution path spanning daemon and desktop, the repository's first `utilityProcess`, a Seatbelt sandbox policy, and one confirmed sandbox-escape vector to close)
- Depends on: none
- Category: feature
- Execution: subagent (generic host sub-agent, `model: opus`; departure check recorded in dev:explore on 2026-09-12: proceed continuously and automatically, no further confirmation mid-flight; push / PR / merging into main / releasing still require an explicit request from the user)
- Planned at: `7deedfb`, 2026-09-12

**Relocated and reconciled.** This plan was originally `plans/116-executor-engine.md`, written in Chinese and numbered 116. Main has since taken the 1.0.0 release, which reassigned number 116 to the test-cleanup plan, adopted an English documentation policy and moved plans to `wiki/plans/YYYYMMDD-slug.md`. The file moved here and was translated without changing any product conclusion or recorded decision; the command examples now read `coflux executor run`, because `cofluxd` became the headless device-host entry point only. The follow-up work that brought this branch onto main 1.0.0 is recorded in [wiki/plans/20260912-executor-reconcile.md](20260912-executor-reconcile.md).

## Requirement

An agent working inside a coflux terminal (Claude Code / Codex) has no way to hand a sub-task off. Bounded, mechanical, verbose work — running a test suite and fixing what it reports, bulk file edits, mechanical refactors — has to be done in-conversation, burning context on round trips unrelated to the main thread. Opening a child terminal and starting another `claude` does not solve it: that is a second full agent, needing configuration and authorization, sharing no context, and disproportionately heavy.

When this is done, coflux ships a small built-in executor. An agent starts it with one zero-credential local command:

```sh
coflux executor run --prompt="Fix every clippy warning in crates/worker" --write
```

The command blocks until the task ends, then prints the executor's final reply and which files it changed. The executor is one-shot: no session, no follow-up; to change something, send another run. It works inside **the workspace that started it**, confined by a kernel sandbox to that workspace's directory, unable to touch any file outside it and unable to reach the local daemon's loopback endpoint. The model is configured once, globally, by the user in the desktop app (provider / model / API key); the system prompt is fixed by coflux; the agent may pass only a prompt and a read/write mode.

### Product conclusions (confirmed with the user item by item during exploration; do not reopen, do not change)

1. **The only consumer is "the user's agent, through the plugin."** No manual entry point in the desktop app, no UI for the user to type an executor task themselves.
2. **One-shot: prompt in, result out, no follow-up.** The same shape as Codex's MCP offering `codex` but no `codex-reply`.
3. **The only inputs are the prompt and the read/write mode** (read-only / writable). No model override: the moment one exists, the agent has to know which models the user configured, which needs another query entry point, and the whole point of a global configuration is defeated.
4. **Only workspaces on the machine the desktop app runs on are supported.** Agents on remote daemons cannot reach it, and **a run ends when the app goes away** — an accepted cost, not a defect awaiting a fix.
5. **Concurrency: write mode is mutually exclusive per workspace** (a second write request is refused with a reason), read-only runs may go in parallel up to a total cap.
6. **Configuration entry point**: the account menu gains an "Executor settings…" item opening a dialog, structurally the same as the existing "Server address…" and "Local daemon". The desktop app has no settings page and will not grow one for this.
7. **No UI in this slice.** The agent getting a result through the CLI closes the loop. The desktop read-only floating window (a glass card in the bottom-right corner, click to expand the full transcript, a stop button, stacked tasks) **gets its own second plan** and is out of scope here.

### Acceptance (by the user, by hand; front-end work is not walked through by Claude)

- In a coflux terminal, `coflux executor run --prompt="..." --write` blocks for some minutes, prints a result, and the files really changed.
- In read-only mode the executor can read and run tests, but writing a file is refused and the error makes clear the sandbox refused it.
- The executor fails to write a file outside the workspace (say `~/x.txt`); fails to `curl` the local daemon's loopback port; external network and DNS work.
- Two `--write` runs in the same workspace: the second is refused with a readable reason.
- After the desktop app exits, running tasks are interrupted and the CLI gets a definite terminal state instead of hanging forever.
- Starting a run with no provider/model configured returns one readable "configure it in the desktop app" sentence immediately instead of timing out.

## Decisions & tradeoffs

- **The pi process lives in the desktop app's `utilityProcess`, not in the daemon.** Rejected: the daemon spawning a pi child process — three hard pieces of evidence rule it out. (1) `apps/desktop/electron-builder.yml:19` sets `runAsNode: false` as the plan 103 security baseline, flipped before signing with Gatekeeper guaranteeing it stays flipped, so "reuse the installed Electron binary as Node, at zero extra size" is unavailable and a daemon-side design must ship a separately signed and notarized Node runtime. (2) `crates/supervisor/src/manager.rs:808` hot upgrades by calling `Child::kill()` on the worker, with no drain and no child handover, so a pi run of several minutes hanging under a frequently hot-upgraded worker is orphaned by construction, while re-parenting it to the supervisor would push the code that most needs fast iteration into the component that upgrades least. (3) Provider credentials live in desktop `safeStorage` (`apps/desktop/src/main/token-store.ts:5`), which a daemon-side runner cannot read — a daemon design would mean building a new credential-distribution path for this one feature. Based on: `apps/desktop/electron-builder.yml:18-27`, `crates/supervisor/src/manager.rs:808`, `docs/hot-upgrade-design.md` section 1, `apps/desktop/src/main/token-store.ts:5`. Note that the same electron-builder comment states that disabling RunAsNode also breaks `child_process.fork` (background work should use `utilityProcess`) — `utilityProcess` is the sanctioned path, but **there is no precedent in the repository** (`grep -rn utilityProcess apps/desktop/src` returns nothing), so it is a new pattern.

- **The transport invents no reverse RPC; it uses the existing push plus ordinary upstream messages.** Rejected: adding "device sends a request to client and awaits a response" semantics to the device protocol — unnecessary: pushing frames down an already-connected channel is an existing capability (`pty_output` does it constantly), and `packages/client/src/device-router.ts:1647` already dispatches non-reply messages, so not every inbound message has to be paired with a pending request. The daemon pushes the assignment; desktop reports state and outcome with ordinary upstream messages. Based on: the oneof at `proto/coflux/v1/device.proto:667`, `packages/client/src/device-router.ts:1647`.

- **Desktop keeps an independent, permanent `retainDevice` on the local daemon.** Rejected: relying on whatever connection the user's currently selected workspace happens to bring — `retainDevice` is reference-counted (`packages/client/src/device-router.ts:2312`), and `apps/desktop/src/renderer/components/workbench/workbench.tsx:376` currently does `measureOnly` for non-selected devices, a lane that **deliberately skips direct and goes over relay**. The executor service must retain the local daemon on its own and must not depend on which workspace the user is looking at. Retaining alone grants no executor capability; the capability declaration and the send/receive dispatch are added separately. Based on: `packages/client/src/device-router.ts:2312-2322`, `apps/desktop/src/renderer/components/workbench/workbench.tsx:376`.

- **The CLI uses the zero-credential local command path, not the center's MCP.** Rejected: a center MCP tool — the executor closes entirely locally, and by the design principle already established in this repository (plan 093, "single MCP track", was withdrawn precisely for this), an agent operation that can close locally never goes through the center. A new `AgentAction` variant suffices: `handle()` at `crates/worker/src/agent_ctl.rs:206` already identifies the session through `agents::session_of_pid` and resolves the effective workspace from cwd through `resolve_scope`. Based on: `crates/worker/src/agent_ctl.rs:84` (the enum) and `:206` (dispatch), the two-track rule in `packages/cli/skills/coflux/SKILL.md`.

- **Long runs use submit → runId → status/result polling from the CLI side.** Rejected: holding one `/agent` request open — the server caps it at 25 seconds (`crates/cli/src/gateway.rs:19-20`, `AGENT_TIMEOUT_MS = 30_000`), and an executor run of several minutes would always time out. It must use the same shape as `terminal wait`: `AgentAction::TerminalStatus` is the existing polling primitive and the CLI-side loop is at `crates/cli/src/commands.rs:236`. A submission timeout **must never be blindly re-sent**; a stable submission id is generated internally for deduplication, adding no input for the user. Based on: `crates/cli/src/gateway.rs:19-20`, `crates/worker/src/agent_ctl.rs:95-98`.

- **The job table and the write lock live in the desktop main process; the daemon keeps only state and outcomes.** Rejected: putting the job table in the worker — worker memory is lost on hot upgrade (already stated in the command-log index comment at `crates/worker/src/main.rs:99`; the same holds for `WorkerState`'s ledger/workspaces and the operation ledger at `crates/worker/src/device.rs:796`), and `docs/architecture.md:195` states explicitly that ordinary mutations offer no cross-worker replacement deduplication. The daemon side keeps only the state and final result the CLI polls. The existing channel is in the renderer, so **one narrow IPC bridge to the main process is enough; there is no need to rebuild a main-process DeviceRouter for this slice**. Based on: `crates/worker/src/main.rs:99`, `crates/worker/src/device.rs:796`, `docs/architecture.md:195`.

- **The MVP keeps six things and drops seven.** Kept: host registration (the local daemon binds **one** desktop instance plus a hostEpoch, rather than letting any connected client execute), push with an acceptance receipt (the daemon pushes runId + prompt + mode + **an already-resolved workspace id and real root**; the main process accepts or refuses), runId deduplication and per-workspace write exclusion, reconnect reconciliation (after a worker restart or a channel generation change, desktop re-reports running tasks and unacknowledged outcomes), retaining results until the daemon acknowledges receipt, and idempotent cancellation. Dropped: long-poll queues, competitive claiming, lease scheduling, automatic executor migration, resuming across app restarts, a general bidirectional RPC abstraction, and relaying tokens through the daemon. **Failure boundary**: a dropped channel does not mean the app died, so **the writer must not be re-dispatched**; when the old host's state is unknown, return "result unknown / awaiting reconnect" and **never re-run automatically**. Rejected: handing a task to a new host after a lease timeout — an expired lease does not prove the old writer stopped, and double-writing would follow.

- **The v1 executor does not commit, and git metadata is read-only.** Rejected: allowing the whole main repository `.git` and then carving out hooks and config — that compromise does measurably make add/commit work while blocking hook writes and config changes (see the measured table below), but what it leaves open is a long list: worktree-level config when `extensions.worktreeConfig` is on, the effective `core.hooksPath`, other worktrees' admin directories, `exec` lines that can be inserted into `rebase-merge/git-rebase-todo`, submodules' `.git/modules/**/config`, `info/exclude|attributes`, and refs/reflog/objects. Turning those into a precise allowlist is a substantial piece of engineering and is not v1. `git status` / `git diff` still work (in read-only mode, `GIT_OPTIONAL_LOCKS=0` is recommended to reduce optional index writes). **This one is visible to the agent**: the SKILL must state that the executor never commits and that the initiating agent reviews and commits the changes itself.

- **The sandbox tier is "against mistakes", not "against adversaries".** The baseline is `(allow default)` plus file-write denials and network denials, which stops out-of-bounds writes and loopback escape. Rejected: copying Codex's deny-by-default base policy and allowing system services back one by one — an order of magnitude more work to build and maintain. **The cost has to be stated in the documentation**: Mach/XPC and Apple Events are not covered by `deny network*` and remain open under an `allow default` baseline. The threat model is "a confused agent taking a wrong turn", not "a hostile attacker" — Claude Code on the user's own machine runs with no sandbox at all, so this tier is already stricter than the status quo. **It must not be marketed as full isolation or as workspace transaction isolation.**

- **pi must use a closed ResourceLoader.** Rejected: using `DefaultResourceLoader` and only overriding the system prompt — it discovers and loads project-level and global extensions / skills / prompts / configuration by default, so dropping a `.pi/` directory into a workspace would let the executor run arbitrary code: a back door alongside the sandbox. The model, tool list, credential source and session storage must be specified explicitly, with `SessionManager.inMemory()` so nothing is persisted, the user's existing `~/.pi` state is not read, and executable extensions in the workspace are not loaded; the system prompt is supplied through `systemPromptOverride`. Based on: the resource-discovery defaults in the pi SDK documentation (upstream 0.85.1).

- **Stop by process group, and classify the terminal state.** pi's bash tool starts the shell with `detached: true` on non-Windows, so **killing pi's pid, or even its own process group, does not guarantee those bash groups have exited**. Abort cooperatively first, then force-kill within a bound; the custom tool backend must record each shell's process group; release the write lock only after confirming the tool's child processes really stopped. Also, **never treat `prompt()` returning or the process exiting 0 as success** — the terminal state must distinguish success / model error / tool failure / interrupted / result unknown.

- **(decided while planning) Tool processes have no network by default.** The tool profile uses `(deny network*)`; model calls happen in the runner, which is not inside the sandbox, so they are unaffected. The cost is that the executor cannot run `npm install` / `cargo fetch` and similar dependency-fetching commands. Rejected: allowing one local download-proxy port — "open one loopback port" reopens the escape vector below, and building a controlled proxy that re-validates its target after DNS resolution and redirects is a separate body of work. **This limit must go into the SKILL** so the initiating agent knows to install dependencies before handing a task over.

### Measured data (run for real on this machine during planning, macOS 26 / Darwin 27; take it as given, do not re-measure)

In a temporary git repository with a workspace created by `git worktree add`, `sandbox-exec` behaves as follows:

| Profile rule | Result |
| --- | --- |
| Allow the worktree directory only | `git status` rc=0, editing a file rc=0; `git add`/`commit` rc=128, stuck on `<main>/.git/worktrees/<name>/index.lock` |
| Additionally allow `<main>/.git/worktrees/<name>` | Still fails (`git add` reports "failed to update file") |
| Allow all of `<main>/.git` | add/commit rc=0; writing `<main>/leak.txt` is still refused |
| Then deny the `.git/hooks` subtree plus the literal `.git/config` | add/commit still rc=0; writing pre-commit refused; `git config core.fsmonitor evil` rc=4 |
| `(deny network* (remote ip "localhost:*"))` | loopback TCP refused; DNS fine; external HTTPS fine |
| Plus `(deny network-outbound (remote unix-socket))` | UDS refused, but **system name resolution breaks with it** (`getaddrinfo` reaches mDNSResponder over UDS; curl reports "Could not resolve host") |
| Instead, per path: `(deny network-outbound (literal "<specific sock path>"))` | UDS refused + DNS fine + external 200 + loopback refused: all three at once |

Two silent traps that would otherwise cost half a day:

- **The profile must contain `realpath`-resolved paths.** Writing `/var/...` into it makes the rule behave as if it were absent (`/var` is a symlink to `/private/var`): allow rules silently do nothing, with no error.
- **`-D` parameters with `(param "X")` were measured not to work**; the literal path has to be interpolated into the profile.

## Direction

Four main lines. M1 → M2 → M3 are sequential; M4 shares no files with M2/M3 and can run in parallel; M5 closes out and needs the others in place.

**Architecture in one line**: the agent runs `coflux executor` → the daemon's `/agent` endpoint identifies the session, resolves the workspace and registers the run → the daemon pushes the assignment to the registered local desktop client → the desktop main process starts a `utilityProcess` running pi (closed loader; every bash command wrapped in `sandbox-exec`) → the terminal state is reported back to the daemon → the CLI's polling picks up the result. The transcript stays inside the desktop app and never passes through the daemon.

### Milestone 1: Protocol and the daemon-side path

When done: `proto` carries the executor's assignment push and upstream report messages and `buf breaking` passes; the worker has a run ledger (submit, query state, fetch result, cancel) and `/agent` gains the matching `AgentAction`; with no registered executor host, a submission returns one readable error immediately instead of hanging; host registration binds a single desktop instance plus a hostEpoch. The daemon-side capability name follows the name-gated pattern of `apps/server/src/daemon-capabilities.ts`.

Validation: `cargo test -p coflux-protocol` -> exit 0; `cargo build -p coflux-supervisor -p coflux-worker` -> exit 0.

### Milestone 2: Desktop host registration and the job table

When done: the desktop main process owns the job table and the per-workspace write lock (write exclusion, read-only cap); the renderer keeps an independent permanent retain on the local daemon and declares the executor capability; a narrow IPC bridge carries assignments into the main process and state back out; runId deduplication, idempotent cancellation and reconnect reconciliation are all in place; tasks still running when the app exits are put into a definite terminal state. The runner may still be a fake echo implementation at this point.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0; `pnpm -C apps/desktop test` -> exit 0 (including pure-function unit tests for the job-table state machine and the write lock).

### Milestone 3: The runner and the Seatbelt closure

When done: real pi runs inside the `utilityProcess` (pinned to 0.85.1, closed ResourceLoader, `SessionManager.inMemory()`, system prompt supplied by coflux); structured file tools validate paths against the resolved workspace root; the bash tool backend wraps every command in `sandbox-exec`, with the profile generated from the workspace root plus the exclusion list from `git worktree list --porcelain`; the network section blocks loopback, blocks the supervisor UDS and the Docker/Podman/SSH-agent sockets by path, and tool processes get `(deny network*)`; stopping goes "cooperative abort → bounded force-kill of the process group"; terminal states are classified into success / model error / tool failure / interrupted / result unknown.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0; `pnpm -C apps/desktop test` -> exit 0 (including pure-function unit tests for profile generation: real-path resolution, nested worktree exclusion, read-only git metadata, well-formed network section).

### Milestone 4: Global configuration and credentials

When done: the account menu gains "Executor settings…", whose dialog configures provider, model and API key; the key is encrypted with `safeStorage` into userData while non-sensitive items go to a configuration file; with nothing configured, an executor submission is refused with a readable reason. The key reaches the runner only through a dedicated IPC path and never enters `settings.json`, the tool processes' environment, the transcript or the logs. No file overlap with M2/M3; can run in parallel.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0; `pnpm -C apps/desktop test` -> exit 0.

### Milestone 5: CLI command, SKILL and documentation

When done: `coflux executor run --prompt=... [--write]` works, with submit plus polling internally, a stable submission id for deduplication, and one readable sentence per error; the SKILL gains an executor section (**all English**, not duplicating what is already documented elsewhere) stating that it is one-shot, does not commit, that tool processes have no network, and that it only exists on the machine the desktop app is on; `docs/architecture.md` gains a paragraph on the execution path; `.claude-plugin/plugin.json` gets a version bump.

Validation: `cargo build -p coflux-supervisor -p coflux-worker` -> exit 0; `node scripts/sync-claude-plugin.mjs` -> exit 0 and both SKILL copies identical; `pnpm -C tests test` -> green except the known flaky cases below.

## Landmines

1. **The sandbox escape vector (the most important one; leave it open and the sandbox is pointless)**: a tool process inside the sandbox can call the daemon's loopback `/agent` directly and use `terminal.new` to make the entirely unsandboxed daemon run arbitrary commands on its behalf. The pid/ppid at `crates/worker/src/hook.rs:251` **come from the request body**, and `crates/worker/src/agents.rs:77` only checks whether that pid belongs to some session's process tree — it validates "who the reported pid belongs to", not "this HTTP connection really came from that process". The tool profile must close off loopback, the supervisor UDS, Docker/Podman sockets, and the SSH agent and ControlMaster sockets.
2. **Nested worktrees**: this repository's `git worktree list --porcelain` currently shows **two levels of nesting** under `.claude/worktrees/` (including the plan 114 spike and two unmerged pieces of plan 115 work). If the executor runs in the main workspace, a naive "allow the workspace's whole subtree" makes five other worktrees writable too. Profile generation must run `git worktree list --porcelain` and deny every other registered worktree. Parent-directory renames and symlink aliases also matter; testing writes on the original path alone is not enough.
3. **Credentials must not leak**: the provider key is stored in `safeStorage` and reaches the runner through a dedicated IPC path. It **must not enter `settings.json`, the tool processes' environment, or the transcript**. Note that `apps/desktop/src/main/settings.ts:37` currently recognizes only the `serverUrl` key; non-sensitive configuration should extend it rather than start a parallel mechanism.
4. **When cwd is pinned**: `resolve_scope` in `crates/worker/src/agent_ctl.rs` picks the effective workspace from the request's cwd and falls back to the owning workspace when nothing matches. The executor must pin the resolved workspace id and real root **at submission time** and ship them with the assignment; the parent agent later running `cd` or entering a worktree **must not change the boundary of an already running task**.
5. **pi version and dependencies**: pin `@earendil-works/pi-coding-agent@0.85.1`, **not with `^`**. MIT, engines `node>=22.19.0`; dependencies are all pure JS (`@silvia-odwyer/photon-node` is WASM, not a native addon — no node-gyp, no ABI concerns), and Electron 44.3.0's bundled Node 24.20.0 satisfies the requirement. The package moved from `@mariozechner/*` to `@earendil-works/*`; the old scope is frozen at 0.73.1 and marked deprecated, so do not install the wrong one.
6. **The SKILL's only source** is `packages/cli/skills/coflux/SKILL.md`; after editing it, run `node scripts/sync-claude-plugin.mjs` to sync it to `integrations/claude-plugin/skills/coflux/SKILL.md`. **CI verifies the two copies match** (see `AGENTS.md`). The plugin directory's SKILL **must be entirely English**.
7. **UI conventions** (this slice builds no floating window, but the configuration dialog is still bound by them): `docs/design-guidelines.md` requires the `Tooltip` component instead of the native `title` attribute for hover hints, and the `ActivityDots` dot matrix for activity indication — **no `LoaderCircle`, no spinners, no Unicode braille**. Icons come from lucide-react.
8. **The Bash guard**: once the session moves into a worktree, the guard blocks compound forms such as `git -C ..`, `$(git …)`, arithmetic and complex templates, and it also blocks commit messages or heredocs containing worktree-removal wording. Split them into single commands, or work around it with the Edit tool / `git commit -F <file>`. `set -e` **does not take effect** under the Bash tool's zsh; chain multi-step scripts with `&&` or check exit codes explicitly.
9. **The release path (not part of this slice)**: worker-side changes reach daemons through a hot upgrade only after the next `v*` tag; desktop goes out under a `desktop-v*` tag; the npm `cofluxd` package needs a new version before the new sub-command exists; the plugin's SHA has to be handed to the builder session. **This slice goes only as far as being mergeable into main, with no release** — releasing is the user's decision.

## Scope

In scope:
- `proto/coflux/v1/device.proto` and its generated artifacts on all three sides (`crates/protocol/src/gen/**`, `packages/protocol/src/gen/**`, `packages/swift-client/Sources/CofluxProtocol/Generated/**`) — generated artifacts are regenerated with buf, never hand-edited
- `crates/worker/src/agent_ctl.rs` (or split into an `agent_ctl/` module directory), `crates/worker/src/device.rs`, `crates/worker/src/gateway.rs`, `crates/worker/src/hook.rs` (`/agent` endpoint parsing and dispatch of the new actions) — the minimum needed for the executor path
- `crates/cli/src/commands.rs`, `crates/cli/src/main.rs`, `crates/cli/src/args.rs`
- `apps/desktop/src/main/**` (host registration, job table, write lock, runner, Seatbelt profile, configuration and credentials)
- `apps/desktop/src/preload/**`, `apps/desktop/src/shared/**` (narrow bridge types)
- `apps/desktop/src/renderer/components/workbench/account-footer.tsx`, `workbench.tsx` (the menu item and the permanent retain)
- `apps/desktop/package.json` (the pi dependency), `apps/desktop/electron.vite.config.ts` (the runner's second entry point), `pnpm-workspace.yaml`'s `allowBuilds` (a decision on pi's transitive dependencies' build scripts; with no decision recorded, pnpm 11 treats the install as failed)
- `packages/client/src/device-router.ts`, `packages/client/src/store.ts` (executor message dispatch and the subscription surface)
- `packages/cli/skills/coflux/SKILL.md` and its synced copy, `integrations/claude-plugin/.claude-plugin/plugin.json`
- `docs/architecture.md`, `plans/README.md`
- The matching unit tests and black-box cases

Out of scope:
- The desktop read-only floating window (transcript display, stop button, stacked tasks) — its own second plan
- Executors on remote daemons — excluded by product conclusion 4
- The executor committing to git — excluded by decision; it needs a precise allowlist, to be discussed separately
- Networking for tool processes and a controlled download proxy — excluded by decision, to be discussed separately
- Closing off the Mach/XPC and Apple Events layers — the sandbox tier is settled as "against mistakes"
- Exposing the executor through the center's MCP — contrary to the local-first principle
- Releasing (`v*` / `desktop-v*` tags, npm, the plugin marketplace) — the user's decision

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust unit tests | `cargo test -p coflux-protocol` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| Desktop type check | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| SKILL sync | `node scripts/sync-claude-plugin.mjs` | exit 0, both copies identical |
| Black-box integration (acceptance) | `pnpm -C tests test` | green except known flaky cases |

Known flaky cases and environment-baseline failures. **Do not tune thresholds or edit the tests for them**:

- The two `cofluxd doctor` cases fail on this machine as an environment baseline (cofluxd is installed but the service is not running, so a different output branch is taken); unrelated to this slice.
- auto-update / local-first / signed-upgrade go red occasionally; one red and two greens when run alone locally is enough to call it flaky.
- The three agent-activity presence/hook cases are **guaranteed false reds** on a machine with coflux installed (they identify claude processes through the process tree and are polluted by real sessions), and they stall the whole suite.
- Front-end changes do not need a UI walkthrough by Claude; the user verifies them by hand.

## Done criteria

- [ ] Everything in the table above passes except the acceptance row.
- [ ] `coflux executor run --prompt=... --write` works in a coflux terminal and prints the result and the changed files.
- [ ] In read-only mode writing a file is refused; out-of-bounds writes (outside the workspace) are refused; connecting to the daemon's loopback is refused; external network and DNS work.
- [ ] A second write-mode request in the same workspace is refused with a readable reason.
- [ ] With no provider/model configured, a submission returns a readable error immediately instead of timing out.
- [ ] After the desktop app exits, running tasks reach a definite terminal state and the CLI does not hang forever.
- [ ] Profile generation is covered by pure-function unit tests: real-path resolution, nested worktree exclusion, read-only git metadata, well-formed network section.
- [ ] Both SKILL copies are identical and in English, stating one-shot / no commit / no network for tools / local machine only.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The plan index status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (in particular the `runAsNode` fuse in `electron-builder.yml`, the `Child::kill()` hot-upgrade mechanism in `manager.rs`, and `device-router.ts`'s ability to dispatch non-reply messages).
- The implementation requires files outside Scope.
- A validation command fails twice in a row after one reasonable fix.
- pi 0.85.1 will not run inside `utilityProcess` (ESM loading, WASM initialization, or Electron's Node environment differences, say) — that undermines the premise of D1, so stop and report rather than deciding to fall back to a daemon-side design.
- The Seatbelt profile breaks a real workspace badly enough to be unworkable (common build commands all failing, say) — that means the tier needs to be reconsidered, so stop and report.

## Maintenance notes

- **The sandbox tier** is "against mistakes", not "against adversaries": Mach/XPC and Apple Events remain open under the `allow default` baseline. Any copy presenting the executor as security isolation is wrong. Raising the tier means redoing it on Codex's deny-by-default base policy, which is its own project.
- **`sandbox-exec` has been marked deprecated by Apple for years** but currently works. The real cost is future compatibility — re-run the profile acceptance after every major macOS release.
- **pi is a fast-moving upstream project** (a release every one to two weeks from August into early September). The version is pinned; before upgrading, check whether `DefaultResourceLoader` and the bash tool's `detached` behavior have changed, since those two are the basis of two decisions here.
- The executor is **not** mutually exclusive with the agent that started it, the user's editor, or an ordinary terminal: the write lock only guarantees exclusion among executor writers and provides no workspace transaction isolation. A read-only task running alongside a writer gets no consistent snapshot either. The SKILL has to state this boundary clearly.
- The second slice (the floating window) will need an incremental transcript stream. This slice keeps the transcript inside the desktop main process; leave it a subscribable outlet by design, but do not push per-token data through the daemon for it.
