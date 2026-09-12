# Plan 20260912-interactive-terminal-model: Interactive-only terminals with do-script semantics

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 3526788..HEAD -- crates/worker/src/ops.rs crates/worker/src/log_sink.rs crates/worker/src/main.rs crates/worker/src/agent_ctl.rs crates/worker/src/hook.rs crates/worker/src/device.rs crates/supervisor/src/sessiond.rs crates/supervisor/src/sessions.rs crates/supervisor/src/shell_integration.rs crates/supervisor/src/shell crates/supervisor/src/main.rs crates/cli/src crates/protocol proto packages/protocol packages/client/src/store.ts packages/cli apps/server/src/hub.ts apps/server/src/interface/client-command apps/desktop/src/renderer/components/workbench/terminal-attach.ts integrations/claude-plugin tests/src README.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: deferred — resolve at the departure check of `dev:execute-plan` (the user decides mode and executor per plan; see memory `subagent-model`)
- Stop after: implementation — the user answered "开干" to the exploration report
- Workspace: isolated — `.claude/worktrees/20260912-interactive-terminal-model`, branch `dev/20260912-interactive-terminal-model`, cut from main `3526788`; main worktree carries two unrelated uncommitted files (`apps/server/src/auth-pages.ts`, `tests/src/authorize.test.mjs`, another session's referrer-policy fix) that stay untouched
- Planned at: `3526788`, 2026-09-12

## Requirement

### Problem

Agents (Claude Code / Codex running inside a coflux terminal) can open terminals the user sees and can take over. Today there are two kinds, told apart by whether `coflux terminal new` receives `--cmd`:

- a **job terminal** runs one command under a login shell with stdout piped into a log sink, exits with the command's status, and `read` returns the log tail;
- a **session terminal** is a plain interactive login shell on a real tty; `read` returns one screenful, nothing tells the agent when a command finished, and `wait` only returns when the shell itself exits.

The user judged job terminals useless: piped stdout kills colours, progress bars and TUIs, one terminal per command is sidebar noise, and the shape does not fit the scenario that matters. That scenario is the one in the screenshot the user gave during exploration: an agent needs a step only the human can do (type a root password into `ssh -t user@host "su - root -c '…'"`, confirm a prompt, drive a TUI) and today can only say "please run this in your own terminal and tell me when it is done".

### Product conclusions (settled with the user, do not reopen)

The product is modelled on the macOS Terminal.app scripting surface (`do script`, `busy`, `contents`/`history`, `close`): coflux terminals are **only** persistent interactive shells, and the agent gets control commands over them.

- **Consumer and trigger.** An agent reaches for a coflux terminal when a human must take part (password, confirmation, TUI), when a process should keep running for the user to find later, or when the user wants to watch. One-shot commands stay in the agent's own Bash tool. The SKILL keeps saying so.
- **Form.** One terminal kind: the workspace's default login shell on a real tty, alive until `exit` or `close`. Control commands, all local (no center dependency beyond what `new`/`list` already need):
  - `coflux terminal new [--title=…] [--cmd=…]` — open the shell; when `--cmd` is given, type that command in **after the shell has signalled prompt readiness**, then leave the shell alive (Terminal.app `do script`).
  - `coflux terminal run <taskId> --cmd=…` — the same into an existing terminal.
  - `coflux terminal wait <taskId> [--timeout=…]` — block until the current (or most recently started) command finishes and print its exit code; also returns when the shell itself exits, reporting `exited exit=<shell status>` as today.
  - `coflux terminal read <taskId> [--lines=N]` — the last N lines of the **full scrollback**, ANSI-stripped (default 200 as today), not one screen.
  - `coflux terminal send`, `list` — unchanged in meaning; `list`/status additionally show whether a command is running (busy) and the last command's exit code.
  - `coflux terminal close <taskId>` — end the terminal (Terminal.app `close`); same effect as the account CLI's `stop`.
  - The account CLI (`coflux terminal new --workspace <id> --cmd …`, `run`, `wait`, `read`, `stop`, `remove` with `--remote`) carries the same semantics through the center; `--cmd` there is do-script too, never a job.
- **Interaction flow for the target scenario.** Agent: `new --title="Root ssh" --cmd="ssh -t …"` → `notify "Please type the root password in the Root ssh terminal"` → run `wait <id>` in the background. User: opens the terminal, types the password, the remote script runs. Command ends → `wait` prints `exit=0` → agent `read`s the scrollback and continues. If the user takes the terminal over, `send`/`run` are refused (humans first, as today); `wait`, `read`, `list`, `close` are never refused because of takeover.
- **Failure paths the consumer sees.** A shell that coflux cannot instrument (not zsh/bash/fish through coflux's rc chain, or the integration was bypassed): the terminal still opens, but `new --cmd`/`run` fail with one readable sentence saying the command was not typed and that `send` is the fallback; `wait` on such a terminal fails readably instead of hanging. A command longer than the input bound is refused with the same bound `send` already has. A `run` while a command is still running is refused readably ("busy"; read first). Old daemon (pre-plan) behind a new CLI: readable refusal, never a silently created job terminal.
- **Observable acceptance.** In a coflux terminal: `coflux terminal new --title=Shell --cmd="python3 -c 'import sys; print(sys.stdin.isatty(), sys.stdout.isatty()); sys.exit(3)'"` → the sidebar shows a running terminal titled Shell, `wait` prints exit code 3 while the terminal keeps running, `read` shows `True True`, `run <id> --cmd="printf 'x%.0s\n' {1..300}"` then `read --lines 250` returns 250 lines (beyond one screen), `close <id>` makes it exited.
- **Non-goals.** No job/hybrid mode or compatibility switch; no `focus`/activate command; no notify-to-terminal targeting or desktop tab landing (separate later plan); no scrollback persistence after the shell exits (post-exit `read` keeps today's center checkpoint fallback); no iOS changes; no prompt detection heuristics other than the shell-integration marks; no release/publication (worker tag, npm, marketplace, prod deployment are the user's decision after merge).

## Decisions & tradeoffs

- **Job machinery is deleted, not disabled.** The wrapper script, log sink, log registry and log-first reads go away: `crates/worker/src/ops.rs:312-460` (`write_command_script`, `write_operation_command_script`, `log_sink_program`, the script template, `read_command_log_tail`, `read_tail_bytes`, `sh_quote`) plus their tests at `ops.rs:462-636`; the whole of `crates/worker/src/log_sink.rs` and its argv sniff in `crates/worker/src/main.rs:482-487`; `agent_logs`/`remember_log` and the job branch of `TerminalNew` in `crates/worker/src/agent_ctl.rs:50-71, 246-285`, the log-over-snapshot preference at `agent_ctl.rs:310-337` and `840-882`, the `WorkerState.agent_logs` field (`main.rs:99-102`, inits at `main.rs:563, 1935`, `device.rs:3804`); the operation-script branch in `crates/worker/src/device.rs:2075-2105` (the adjacent `ledger.remember_create` at `device.rs:2079-2087` is generic and stays); the 16 KB command bound `crates/worker/src/hook.rs:39-40, 290-302` and `apps/server/src/hub.ts:137`; the command branch and "title from the command's first line" in `hub.ts:3984-4021`; the `"log"` read source in `proto/coflux/v1/daemon.proto:340-344`, `proto/coflux/v1/client.proto:313-325`, `packages/client/src/store.ts:107-109` and the `\n→\r\n` special case in `apps/desktop/src/renderer/components/workbench/terminal-attach.ts:209-211`; the wrapper-script exceptions in `crates/supervisor/src/shell_integration.rs:234-236` and `sessions.rs:855-856`. Rejected: keeping the code behind a flag — the user wants one terminal model and a dead path is a maintenance trap. Keep: `cleanup_stale_files` (`ops.rs:159-181`, shared with `fs.write`), the `agent 终端` title fallback (`hub.ts:1311`), and `ops::run_command` (the unrelated exec RPC).
- **Command completion comes from shell integration marks (OSC 133), parsed in sessiond.** coflux already owns the rc chain of zsh/bash/fish (`crates/supervisor/src/shell/{zshrc.zsh,init.bash,coflux.fish}`, rendered by `shell_integration.rs:18-70`) and sessiond already captures OSC 0/2 titles from the vt100 callback (`crates/supervisor/src/sessiond.rs:205-240`). The injected integration emits prompt-start/command-start/command-end marks with the exit status; sessiond keeps per-session command state: busy or idle, a monotonically increasing command sequence, and the last finished command's sequence and exit code. Rejected: foreground-process-group polling (Terminal.app's `busy`) — no exit code, and it cannot tell "waiting for a password inside ssh" from "idle". Rejected: agent-side `echo DONE-$?` markers — unreliable once the user types into the terminal.
- **Only the top-level shell of a PTY emits accepted marks, and marks carry a per-session secret.** The supervisor hands the secret to the shell through the environment; the injected rc copies it into a shell-scoped variable and unsets the environment variable before anything else runs, so nested local shells and remote shells reached over ssh never carry it, and sessiond ignores any OSC 133 sequence that does not present the current session's secret. Based on: the target scenario is `ssh -t …`, and remote hosts often ship their own OSC 133 integration (Ghostty, WezTerm, iTerm2) whose bare marks would otherwise end `wait` prematurely; nested shells (`bash` typed into the coflux shell) must look like one long-running command from the outside. Rejected: trusting bare marks. Rejected: deriving depth from `$SHLVL` (user rc files change it).
- **do-script never types blind.** The initial command of `new --cmd` and the command of `run` are written to the PTY only after sessiond has seen this session's prompt-ready mark; for `new` the command therefore waits for the first prompt. When no mark has arrived (integration not active for that shell), `new` still returns the opened terminal and the command injection fails with one readable sentence pointing at `send`; `run` on a busy terminal is refused readably. The command text bound is the existing 64 KB input bound (`crates/worker/src/hook.rs:281`, `hub.ts:138`). Rejected: a timeout fallback that types anyway — the failure mode is a command typed into a half-initialised shell that the user then has to clean up. Executor's call: whether the queued command lives in the supervisor or the worker, and the exact wait-for-prompt bound before the readable failure.
- **`wait` is command-scoped and cannot lose a completion.** `run` (and `new --cmd`) return the command sequence they started; `wait` targets that sequence by default (the latest known) and returns immediately with the stored exit code when it already finished; while the shell is idle with no command ever run, `wait` returns readably instead of blocking. Shell exit still ends `wait` with the shell's status through the existing generic exit path (`crates/supervisor/src/sessions.rs:1104-1162` → `crates/worker/src/device.rs:1204-1219` → session ledger `mark_exited`) — that path is untouched. Rejected: `wait` = "until idle" without a sequence — a command that finished between `run` and `wait` would make the agent wait for the next one. Executor's call: how the sequence is represented in CLI output and whether the CLI keeps its polling loop (`crates/cli/src/commands.rs:236-261`) or the daemon blocks; the default timeout stays 1800 s (`commands.rs:23`).
- **`read` renders the full scrollback.** The supervisor already keeps scrollback for every session (`sessiond.rs:254-260`, rendered in `snapshot()` at `sessiond.rs:338-353` via `capture_complete_history` at `sessiond.rs:1198-1230`; `DEFAULT_HISTORY_LINE_LIMIT` 2000 lines, max 10 000, `COFLUX_HISTORY_LINES`, in `crates/supervisor/src/main.rs:54-64`). `read --lines N` tails that, ANSI-stripped, for running terminals; exited terminals keep the existing center checkpoint fallback. Rejected: a new log pipe — it is exactly what destroys the tty. Accepted loss: after the shell exits only the last checkpoint screen remains; the shell no longer exits when a command finishes, so this rarely matters.
- **Command state travels on the existing supervisor→worker→center seams.** The title already rides `DeviceSessionSnapshot` (`sessions.rs:1578-1588`) and `AgentTerminalRef` (`proto/coflux/v1/daemon.proto:213-220`) carries status/exit code to the agent CLI; command state (busy, sequence, last exit) extends those views rather than adding a parallel channel. Executor's call: push versus pull between supervisor and worker, as long as `wait` wakes without the CLI hammering the daemon.
- **Center path gets the same semantics.** `hub.createTerminalForAccount` keeps accepting a command, but it becomes "initial input typed after the prompt" handled by the same worker/supervisor path; `DeviceSessionCreate.command` (`proto/coflux/v1/device.proto:479-483`) may stay with its comment rewritten, and `DeviceSessionCreate.shell` / `AgentTerminalNew.shell` (`device.proto:476`, `daemon.proto:111-113`, forwarded at `hub.ts:1331-1340`) lose their only producer. Executor's call: delete those fields or keep them documented as unused, but `AgentTerminalNew.shell`'s stale "wrapper script path" comment must not survive. Rejected: leaving the account CLI on job semantics — two meanings for one flag.
- **A new daemon action name for do-script.** The local request must not reuse the old `terminal.new` `command` field with a new meaning: an old daemon would silently run it as a job. Use a field or action an old daemon rejects as unknown (its existing unknown-action/unknown-field behaviour is the readable refusal). Based on: desktop ships daemon and CLI at one version (`docs/RELEASING.md`), only npm headless hosts can mismatch. Executor's call: exact naming.
- **Documentation is rewritten, not patched.** The terminal sections of `packages/cli/skills/coflux/SKILL.md` (currently `:152-241` plus the upgrade hints at `:306, 322`) are rewritten around one terminal kind and the run/wait/read/close flow, synced to `integrations/claude-plugin/skills/coflux/SKILL.md` with `node scripts/sync-claude-plugin.mjs`, plugin `.claude-plugin/plugin.json` version bumped, English only (recursive scan in the plugin tests). CLI help in `crates/cli/src/main.rs:20-70` and `packages/cli/coflux.mjs` help, `README.md:74,84`, `packages/cli/README.md:30,37` follow. Rejected: keeping a "job terminals were removed" paragraph — the SKILL describes capabilities, not history.

## Direction

Milestones 1 and 2 are independent of each other (disjoint files) and both precede 3; 4 and 5 depend on 3. Milestone 2 defines the completion signal that milestone 3 exposes, so 3 must design against 2's real shape, not a stub.

### Milestone 1: Job machinery removed from worker and server

Worker and server no longer contain a wrapper script, log sink, log registry, log read source, or command-length limit; `terminal.new` without a command behaves exactly as today's session terminal; the proto `"log"` source and stale shell-field comments are gone from Rust, TS and Swift generated mirrors. Validation: `cargo build -p coflux-supervisor -p coflux-worker` → zero warnings; `cargo test -p coflux-worker -p coflux-protocol` → exit 0; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0; `pnpm -C apps/desktop typecheck` → exit 0.

### Milestone 2: Shell integration marks and per-session command state in the supervisor

zsh, bash and fish started through coflux's rc chain emit secret-bearing marks; sessiond exposes busy/idle, command sequence and last exit code; marks without the session's secret are ignored; nested shells and ssh sessions appear as one running command. Validation: `cargo test -p coflux-supervisor` → exit 0 with unit tests that feed mark sequences (accepted, foreign, nested) into sessiond and assert the state machine.

### Milestone 3: Local control commands

`coflux terminal new --cmd`, `run`, `wait` (command-scoped), `read` (scrollback tail), `close`, and the busy/last-exit fields in `list` work end to end through the daemon's local `/agent` surface and the Rust CLI; the account CLI path carries the same semantics through the center. Validation: `cargo test -p coflux-cli -p coflux-worker` → exit 0; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0; `node --check` on every touched `tests/src/*.test.mjs` → exit 0.

### Milestone 4: Black-box suite rewritten to the single terminal model

Every test that used `--cmd`/`command` as a one-shot vehicle uses a session terminal with `run`/`wait`; pure job tests are deleted; new cases cover: do-script after prompt, `wait` on an already-finished command, exit code survives user input (`send` into the running command), foreign marks ignored, `read --lines` beyond one screen, `close`, unsupported-shell readable failure (e.g. a `/bin/sh` default shell), oversized command refused. Validation: `node --check` for each touched file → exit 0 (execution is acceptance-tier, below).

### Milestone 5: Documentation, help and plugin

SKILL rewritten and synced, plugin version bumped, CLI help and READMEs updated, help-phrase test in `crates/cli/src/main.rs:112` adjusted to the new wording. Validation: `node scripts/sync-claude-plugin.mjs --check` → exit 0; `node --import tsx --test tests/src/claude-plugin-session-context.test.mjs tests/src/claude-plugin-guard.test.mjs` → all pass; `cargo test -p coflux-cli` → exit 0.

## Landmines

- **Blast radius in tests**: about 14 files / 22 cases use `--cmd` or `command:` as a convenient one-shot: `agent-control.test.mjs:134, 327 (16 KB assertions at 360-368, quota setup 381-389), 410 (475, 521), 547 (559)`; `agent-terminal-io.test.mjs:74 (helper), 91, 148, 266 (pure log-sink test — delete)`; `account-write.test.mjs:185, 260 (16 KB), 265, 293, 311, 330, 343, 362, 385`; `task-read-history.test.mjs:118 (asserts source === "log" — delete)`; `session-env-injection.test.mjs:211, 236, 287, 336, comment at 460`; `worktree-follow.test.mjs:243`; `cli-account.test.mjs:57`; `account-isolation.test.mjs:161`. Not affected despite matching greps: `contract.test.mjs`, `p2p-transport.test.mjs`, `local-first-rpc.test.mjs`, `device-harness.mjs:571` (those are `DeviceExecRun`).
- **Rust unit tests that die with the code**: `ops.rs:462-636` (8), `log_sink.rs:129-249` (4), `crates/cli/src/args.rs` cmd cases (`:107-112, 127-128, 149-150` — `cmd` stays a string option, so keep the parser cases that still apply).
- **Prompt marks and the rc chain order**: `zshrc.zsh` sources the user's `.zshrc` first and coflux's `claude.sh` last; `init.bash` replaces the interactive non-login chain; fish goes through `vendor_conf.d`. User rc files may define their own `precmd`/`preexec`/`PROMPT_COMMAND`; coflux's hooks must add to them, never replace. Prompt-frameworks (powerlevel10k instant prompt, starship) already emit their own OSC sequences — sessiond must key on the secret, not on sequence shape.
- **Secret must not leak into `read` output or the checkpoint**: OSC payloads are not rendered by vt100, but the rc must not echo it; do not put it in the title or in `list`.
- **Initial snapshot is empty for hundreds of milliseconds** (`（暂无输出）`); tests must poll, as plan 101 noted.
- **`agent_ctl.rs` snapshot fallback requires central session identity to match local alive state** (plan 101 landmine) — the new scrollback read goes through the same identity check.
- **Old-daemon mismatch**: keep the readable refusal; do not add version probing.
- **This machine's black-box quirks**: agent-activity presence cases false-fail when coflux is installed locally (memory `agent-presence-tests-unrunnable-locally`); run only touched files. Build test binaries with `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` first. Local Postgres is `127.0.0.1:5432` via `pnpm dev:pg` (Docker is OrbStack, `orb start`).
- **Bash tool guard**: commands containing worktree-removal wording or `git -C` composites are blocked in this session; run git from the worktree root.
- **Protocol double source**: any proto change must be mirrored in `crates/protocol` and `packages/protocol`, regenerating `crates/protocol/src/gen`, `packages/protocol/src/gen` and `packages/swift-client/Sources/CofluxProtocol/Generated` (`packages/swift-client/.../device.pb.swift:1310-1345, 4425` carry the command/shell fields). Wire fixtures at `crates/protocol/src/wire_tests.rs:302-310`.

## Scope

In scope:
- `crates/worker/src/{ops.rs,log_sink.rs,main.rs,agent_ctl.rs,hook.rs,device.rs}` and any worker module needed to carry command state
- `crates/supervisor/src/{sessiond.rs,sessions.rs,shell_integration.rs,main.rs}` and `crates/supervisor/src/shell/*`
- `crates/cli/src/*`, `packages/cli/coflux.mjs`, `packages/cli/account-client.mjs`, `packages/cli/README.md`, `packages/cli/skills/coflux/SKILL.md`
- `proto/coflux/v1/{daemon,device,client}.proto`, `crates/protocol`, `packages/protocol`, `packages/swift-client` generated mirrors, `packages/client/src/store.ts`
- `apps/server/src/hub.ts`, `apps/server/src/interface/client-command/*`
- `apps/desktop/src/renderer/components/workbench/terminal-attach.ts` (dead `"log"` branch only)
- `integrations/claude-plugin/**` (synced SKILL, `plugin.json` version)
- `tests/src/*.test.mjs` listed under Landmines, plus new cases in those files
- `README.md`, `wiki/plans/README.md`, this plan

Out of scope:
- `apps/ios`, `packages/swift-client` hand-written sources — no product change on mobile
- Desktop UI beyond the dead branch — notify targeting and tab landing are a separate plan
- Scrollback persistence after exit, `focus`/activate, prompt heuristics without marks
- `docs/architecture.md`, `docs/agent-integration.md` — contain no job-terminal description (verified)
- Release: worker tag/hot upgrade, npm, marketplace, prod-jp — user decision after merge
- `apps/server/src/auth-pages.ts`, `tests/src/authorize.test.mjs` — another session's pending work in the main worktree

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Rust tests | `cargo test -p coflux-supervisor -p coflux-worker -p coflux-cli -p coflux-protocol` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` | exit 0 |
| SKILL sync | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Plugin tests | `node --import tsx --test tests/src/claude-plugin-session-context.test.mjs tests/src/claude-plugin-guard.test.mjs` | all pass |
| Test syntax | `for f in <touched tests>; do node --check $f; done` | exit 0 |
| Black-box, touched files (acceptance) | `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay && cd tests && node --import tsx --test src/agent-control.test.mjs src/agent-terminal-io.test.mjs src/account-write.test.mjs src/task-read-history.test.mjs src/session-env-injection.test.mjs src/worktree-follow.test.mjs src/cli-account.test.mjs src/account-isolation.test.mjs` | all pass |
| Full black-box (acceptance) | `pnpm -C tests test` | all pass except the known local presence false-fails |
| Real machine (acceptance) | In a coflux terminal run the "Observable acceptance" sequence from Requirement, then the `ssh -t` flow with the user typing a password | exit codes and scrollback as described |

## Done criteria

- [ ] All listed commands pass.
- [ ] No wrapper script, log sink, log registry, `"log"` read source, or 16 KB command bound remains anywhere in the repository.
- [ ] `new --cmd`/`run` type only after the prompt mark; `wait` returns the exit code of the targeted command, including one that finished before `wait` started and one the user typed into; foreign and nested marks never end a `wait`.
- [ ] `read --lines` returns scrollback beyond one screen for a running terminal.
- [ ] `close` ends a terminal locally; account CLI `--cmd` is do-script.
- [ ] Unsupported shell and old daemon fail with one readable sentence each; no terminal is created as a job.
- [ ] SKILL, plugin, CLI help and READMEs describe only the single terminal model; plugin version bumped; English-only scan passes.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false — in particular: the rc chain cannot hook precmd/preexec without replacing the user's hooks; vt100's OSC callback cannot deliver 133 payloads; the supervisor cannot pass a per-session environment variable to the shell.

## Maintenance notes

- Post-exit `read` only has the center checkpoint (one screen). If that ever matters, persist the final scrollback at tombstone time in the supervisor — never reintroduce a log pipe.
- Terminals no longer self-terminate; agents must `close` what they open or the eight-terminal cap fills up. Watch whether an automatic reclamation policy becomes necessary.
- The follow-up plan (notify targeting a terminal, desktop landing on that tab) builds on the `notify` channel and `AgentTerminalRef`; nothing here should pre-empt its shape.
- Release checklist after merge is the user's call: worker tag/hot upgrade, server prod-jp deployment, npm CLI, plugin marketplace SHA.
