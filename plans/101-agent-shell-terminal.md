# Plan 101: Add persistent full-TTY login-shell terminals for agents while preserving command-job semantics

> This plan is an **outcome contract, not an execution script**. Understand requirements and decisions, then design against live code.
> Execution is delegated: implementers implement; the orchestrator runs milestone validation and acceptance outside their sessions.
> Stop on any STOP condition. Update `plans/README.md` when complete.
>
> Drift check: `git diff --stat 79b3694..HEAD -- packages/cli/cofluxd.mjs packages/cli/README.md packages/cli/skills/coflux/SKILL.md integrations/claude-plugin crates/worker/src/hook.rs crates/worker/src/agent_ctl.rs crates/worker/src/device.rs crates/worker/src/ops.rs crates/supervisor/src/sessions.rs apps/server/src/hub.ts apps/server/src/mcp/tools.ts apps/server/src/daemon-capabilities.ts proto/coflux/v1/daemon.proto proto/coflux/v1/device.proto tests/src/agent-control.test.mjs tests/src/mcp-write-tools.test.mjs scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none (uses 074 local terminal new, 091 central MCP create_terminal, and 094 local ledger/snapshot reading without changing those contracts)
- Category: feature
- Execution: subagent opus
- Planned at: `79b3694`, 2026-09-10

## Requirement

Agents currently have one terminal type: both local `cofluxd terminal new --cmd=…` and MCP create_terminal **require a command**. Worker wraps it as a login-shell `-lc <command> | log sink; exit $PIPESTATUS` script, then the terminal exits with the command status. These job terminals pipe stdout rather than presenting a TTY: colors/progress bars disappear, fullscreen programs such as vim/htop/less do not work, and each subsequent command requires another terminal. Missing commands are currently rejected by CLI die, daemon's missing-command error, and required MCP schema/server nonempty validation.

The user decided **both types coexist, selected by whether the command is empty**. Nonempty commands retain job-terminal behavior unchanged. Empty commands create a **session terminal**, equivalent to the user's New Terminal sidebar action: the workspace's default login shell, real TTY stdin/stdout, persistent until agent/user types exit.

Consumers are agents using local cofluxd terminal new in Coflux (Claude Code/Codex) and MCP create_terminal in any host. Use cases include multiple interactive commands, TUIs/colors, and user takeover.

Observable outcomes:

- **Create**: `cofluxd terminal new --title="…"` without --cmd, or with blank --cmd=, opens a session terminal and returns the same taskId/hint shape as jobs. MCP command becomes optional; missing/blank also creates a session. Sidebar immediately shows the correct title and running state, available for takeover.
- **TTY**: `python3 -c 'import sys; print(sys.stdin.isatty(), sys.stdout.isatty())'` prints `True True`, versus job-terminal `True False`.
- **Read**: one screen of ANSI-stripped snapshot text. MCP read_terminal source is snapshot, falling back to checkpoint if daemon is offline. No command log, by design.
- **Send**: unchanged; first read and wait for a prompt before sending, documented in SKILL.
- **Wait/status**: session terminals never exit automatically. Wait finishes only when the shell exits, with its exit status; assess individual command outcomes by reading the screen.
- **Jobs unchanged**: behavior, output, logs, status, and errors of command-bearing terminals stay exactly the same.
- **Readable failures**: a new CLI without --cmd talking to old daemon gets its existing missing-command rejection. Central MCP targeting a pre-091 daemon gets the existing prepared_execute upgrade-required rejection. No probing/version detection needed.
- **Documentation**: synchronized SKILL copies, CLI help/README, and MCP descriptions explain optional commands, empty=session, and when to choose each. Plugin becomes 0.8.0.

Explicit non-goals:
- No job semantic changes, hybrid command-then-stay-open mode, --shell, or --keep-open.
- No session log sink or command logs; avoiding pipes is the point.
- No prompt-readiness detection or automatic CLI prompt waiting.
- No web/mobile/iOS/macOS sidebar distinction from manually opened terminals; no frontend changes.
- No proto changes, even comments; no supervisor or ops.rs script/log-sink changes.
- No worker tags/hot upgrades, server deployment, npm, or marketplace publication. Mark pending release in the index for the user to decide.

## Decisions & tradeoffs

- **Trimmed command emptiness is the sole discriminator on both paths.** Missing/blank local --cmd and MCP command are equivalent. Rejected: explicit --shell/mode adds combinations with command that require explanation, contrary to the user's natural no-command request. Rejected: different meanings for absent and empty strings. Evidence: cofluxd.mjs:999-1000, mcp/tools.ts:403, hub.ts:3692, hook.rs:281-284.
- **No protocol changes or new capability names.** Session terminals use empty AgentTerminalNew.shell, forwarded unchanged into SessionCreate.shell; supervisor selects its default shell. Central DeviceSessionCreate.command already skips scripts for empty values. Old-daemon failures are readable: local rejects itself; pre-091 central daemons are gated by prepared_execute, while 091+ already support empty commands. Rejected: a shell_terminal capability with no unsupported combination to guard. Rejected: changing the stale AgentTerminalNew.shell comment alone and regenerating three outputs; record it for later. Evidence: daemon.proto:103-108; hub.ts:1294; supervisor sessions.rs:805-809; worker device.rs:2088; device.proto:480-482 (old workers ignore command and start ordinary shells, protected by center capability gating); daemon-capabilities.ts:11; worker main.rs:126-127.
- **Session terminals write no wrapper or log registration.** Local agent_ctl skips write_command_script, sends empty shell, and never calls remember_log. Read then uses the existing sessiond snapshot fallback. Rejected: wrapping sessions for logs would pipe stdout and destroy TTY behavior. Evidence: agent_ctl.rs:214-236 currently always writes/registers; ops.rs:334-336 documents piped stdout; agent_ctl.rs:265-279,549-603 prefers logs, then snapshots, then empty output.
- **Allow empty commands but retain the 16 KB limit for nonempty commands in both validators.** hook.rs/hub.ts errors no longer say commands cannot be empty. Evidence: hook.rs:39-40,281-289; hub.ts:136,3692-3694.
- **Default title**: empty title plus command uses server's existing `agent 终端` fallback on both paths. Central first-command-line default becomes empty and needs this explicit fallback. Rejected: web's Terminal N numbering is computed client-side and unavailable in server. Evidence: hub.ts:1272,3695; web workspace-terminal.tsx:411.
- **Keep wait semantics; document them.** It still waits for exited. SKILL must explain sessions do not finish themselves; wait is useful after sending exit, and default 30-minute expiry is a timeout rather than command failure. Rejected: special-casing wait would split semantics; agents are responsible for choosing to wait on a persistent process. Evidence: cofluxd.mjs:1030-1042 and 094 ledger status in agent_ctl.rs.
- **Synchronize all documentation; edit only authoritative SKILL.** Change packages/cli/skills/coflux/SKILL.md, then sync to the plugin; CI checks equality. Plugin content must be English, recursively checked. MCP create_terminal title/description/inputSchema and read_terminal's log description must distinguish command jobs; CLI help/README match. Bump plugin.json to 0.8.0 because SKILL changes are versioned marketplace content. Rejected: directly editing only the delivery SKILL. Evidence: sync script:9-19, session-context character test updated by 099, mcp/tools.ts:265,395-405, cofluxd.mjs:1088-1095, plugin.json.
- **Add one session lifecycle case to each existing black-box file** (planning decision). agent-control: no --cmd → running list entry → send TTY-check command → snapshot contains output → send exit → wait reports exited exit=0. mcp-write-tools: no command → snapshot source → send input → wait for exit. Executor chooses prompt waiting, e.g. unique marker command and read polling rather than literal prompt matching. Retain negative coverage proving empty accepted and nonempty oversized rejected. Rejected: new test files, since both existing fixtures already provide daemon/center/PTY. Evidence: agent-control:86-130,229-260; mcp-write-tools:186-270.

## Direction

Four disjoint milestones share one small semantic change. **Execute as one work package, without splitting.**

### Milestone 1: Local daemon and CLI support

Missing/blank --cmd opens a session: CLI no longer dies; daemon /agent terminal.new accepts empty and requests empty shell, without script/log registration. Nonempty-command behavior/errors remain. Help marks --cmd optional and explains both types. Executor chooses creation hints, including read-before-send prompt guidance.
Validation: `cargo build -p coflux-supervisor -p coflux-worker` → warning-free exit 0; `cargo test -p coflux-worker` → exit 0; `node packages/cli/cofluxd.mjs --help` → exit 0 with optional --cmd.

### Milestone 2: Central MCP support

Make command optional. createTerminalForAccount accepts empty, retains 16 KB limit, and defaults empty title to `agent 终端`. Send empty DeviceSessionCreate.command; worker's existing ordinary-shell branch handles it. Update tool and read descriptions.
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 3: Documentation and plugin

Explain job/session choice, snapshot-only/no-log reads, read before send, wait after exit, and full-TTY TUI/color support in source SKILL, then synchronize. Add a no-command CLI README example. Update plugin README if it describes terminal semantics; bump plugin.json to 0.8.0.
Validation: sync --check exits 0; session-context and guard tests pass, including English-only plugin scan.

### Milestone 4: Black-box cases

Add lifecycle and negative cases to both existing files as specified.
Milestone syntax validation: `node --check tests/src/agent-control.test.mjs && node --check tests/src/mcp-write-tools.test.mjs` → exit 0. Actual execution is acceptance below.

## Landmines

- device.rs:2088 already handles empty central commands as ordinary shells, without affecting preceding remember_create. Do not add scripts or gating there.
- hub.ts:3695 derives title from command's first line; validBoundedText("") may pass, leaving blank sidebar titles without an explicit fallback.
- CLI parseArgs needs real checks of omitted --cmd, --cmd=, and --cmd ""; do not merely remove one die. Preserve SKILL's --cmd=<value> convention.
- Removing hook.rs's empty rejection must coincide with agent_ctl changes; otherwise it writes `-lc ''` and silently creates a terminal that immediately exits.
- Snapshot fallback at agent_ctl.rs:265-279 requires central session identity to match local alive state. Initial snapshots can be empty for hundreds of milliseconds (`（暂无输出）`); poll in tests.
- Black-box tests require local PG 5432 and Docker; pnpm pretest builds Rust. Before targeted files build with `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay`. Full-suite agent-activity presence cases false-fail/hang on this installed-Coflux machine, so acceptance runs only the two touched files.
- Plugin character tests recurse: all new SKILL/plugin-description text must be English.
- Do not probe old daemons. Existing missing-command rejection is expected; add a brief no-command-rejected-means-upgrade note to SKILL's upgrade guidance.
- Production delivery differs by component: worker tags, server deployment, npm CLI, marketplace plugin. Plan completion does not mean live availability; state this in the index.

## Scope

In scope:
- packages/cli/cofluxd.mjs, README.md, source skills/coflux/SKILL.md
- Synchronized plugin SKILL, plugin.json, and README only if it describes terminal semantics
- crates/worker/src/hook.rs and agent_ctl.rs
- apps/server/src/hub.ts and mcp/tools.ts
- tests/src/agent-control.test.mjs and mcp-write-tools.test.mjs
- This plan and plans/README.md

Out of scope:
- proto, packages/protocol, packages/swift-client, including comments
- supervisor, whose empty-shell default already exists
- ops.rs, log_sink.rs, device.rs: existing wrappers/log sink/central empty-command branch
- All frontend apps; no session-terminal distinction
- Plugin hooks/scripts: unchanged, no Codex retrust
- Tags, npm, marketplace, prod-jp release/deployment

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Rust tests | `cargo test -p coflux-worker` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| CLI help | `node packages/cli/cofluxd.mjs --help` | Optional --cmd, exit 0 |
| SKILL consistency | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Plugin tests and English scan | `node --import tsx --test tests/src/claude-plugin-session-context.test.mjs tests/src/claude-plugin-guard.test.mjs` | All pass |
| Test syntax | `node --check tests/src/agent-control.test.mjs && node --check tests/src/mcp-write-tools.test.mjs` | exit 0 |
| Local black-box acceptance | `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay && cd tests && node --import tsx --test src/agent-control.test.mjs` | All pass |
| Central black-box acceptance | `cd tests && node --import tsx --test src/mcp-write-tools.test.mjs` | All pass |
| Real-machine acceptance | In this repository's Coflux terminal run `cofluxd terminal new --title="Shell"`, send `python3 -c 'import sys; print(sys.stdin.isatty(), sys.stdout.isatty())'`, then read | Persistent sidebar terminal; True True; send exit then wait returns exit=0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Both paths create persistent sessions without commands, reporting True True; command jobs retain 79b3694 behavior/logs/status/errors.
- [ ] Empty command/title displays `agent 终端`, never blank.
- [ ] Both paths reject nonempty commands over 16 KB; error no longer claims empty is invalid.
- [ ] Synchronized English-only SKILL, plugin 0.8.0, updated MCP descriptions/CLI help.
- [ ] Meaningful session lifecycle and negative cases in both black-box files.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] plans/README.md updated.

## STOP conditions

- A cited fact changes, especially central empty-command handling, supervisor defaults, or hub shell passthrough.
- Out-of-scope changes are required, such as proto/supervisor changes to create sessions.
- Validation fails twice after one reasonable fix.
- An assumption is false, such as parseArgs requiring redesign to distinguish omission from invalid syntax.

## Maintenance notes

- AgentTerminalNew.shell's proto comment still says temporary wrapper-script absolute path, but empty now means default login shell. Update it and regenerate when proto next changes for another reason.
- Session terminals have no logs; plan 097 exit replay has only one checkpoint screen. Full-output history would need a separate PTY-side recording plan, never pipes.
- The eight-active-terminals workspace limit includes sessions. Forgotten exit leaves slots occupied indefinitely; if users hit the limit, consult 074's AI-terminal automatic-reclamation backlog.
- User-decided release checklist: worker tag/hot upgrade, server prod-jp deployment, npm cofluxd release, plugin 0.8.0 through plugins-builder with main SHA.
