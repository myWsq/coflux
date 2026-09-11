# Plan 092: Center-hosted MCP, part three—inject COFLUX_* into every PTY session and rewrite SKILL

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c0aa426..HEAD -- proto/coflux/v1/daemon.proto proto/coflux/v1/device.proto crates/protocol/src/ipc.rs crates/supervisor/src/sessions.rs crates/supervisor/src/main.rs crates/worker/src/main.rs crates/worker/src/device.rs apps/server/src/hub.ts apps/server/src/config.ts packages/cli/skills/coflux/SKILL.md`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: plans/091-mcp-write-tools-daemon-effects.md (DONE)
- Category: feature
- Execution: subagent fable (preflight authorization 2026-09-05: write and execute 090 → 091 → 092 continuously without further confirmation; stop on STOP/BLOCK; push/PR/merge are not authorized)
- Planned at: `c0aa426`, 2026-09-05

## Requirement

After 090/091, Claude Code or Codex on any machine can access the center's /mcp over OAuth to read/write account assets. But an **agent running inside a coflux terminal** does not know its own device/project/workspace/terminal. Every tool takes explicit ids, so it needs them first. The user decided during dev-explore on 2026-09-05 to **inject COFLUX_* environment variables into every coflux PTY**. Agents read their context directly; do not add cofluxd context or infer location by comparing list_workspaces paths to pwd.

Also rewrite skills/coflux/SKILL.md distributed with cofluxd. It currently teaches only credential-free local commands; explain the local-command/MCP division and reading environment ids before passing them to MCP.

### Outcomes from the consumer's perspective

1. In **every** coflux PTY—created manually by web/iOS, cofluxd terminal new, or MCP create_terminal—`env | grep ^COFLUX_` shows:

   | Variable | Value |
   | --- | --- |
   | COFLUX_DEVICE_ID | Local daemon's device id, as returned by list_devices |
   | COFLUX_PROJECT_ID | Owning project id; empty string, with variable present, for repository-free directory workspaces |
   | COFLUX_WORKSPACE_ID | Owning workspace id |
   | COFLUX_TASK_ID | Terminal task id, used as terminalId in list_terminals/read_terminal |
   | COFLUX_SESSION_ID | This PTY session id |
   | COFLUX_MCP_URL | Center MCP address, `<COFLUX_PUBLIC_URL>/mcp`, for telling the user how to run claude mcp add |

   Ids exactly match the center's list_* results and can be passed directly to tools.
2. Supervisor/daemon upgrades **do not break sessions**. Old supervisor/new worker and old worker/new center simply lack these variables and still start sessions.
3. The npm-distributed SKILL lets agents decide: if variables are absent, ignore this integration; inside coflux without MCP, use local terminal/notify/progress/ports and offer COFLUX_MCP_URL for setup; with MCP, use account-level tools for child workspaces and cross-workspace operations while local commands remain simplest within the current workspace. Synchronize CLI/root README agent-command sections.
4. No cofluxd/web/iOS behavior changes, and no sessiond holder/input_seq/attach semantic changes.

### Incorrect neighboring solutions

- **No arbitrary environment map from the center** applied verbatim by supervisor. That opens unrestricted shell environment injection and scatters names across components. Send only **ids**; names/assembly live in supervisor.
- **No wrapper-script export**: it would alter every shell's startup/login semantics and ancestry. The user chose supervisor injection on 2026-09-05.
- **Do not cover only MCP command terminals**. Manually opening a web terminal and running claude is the primary use case; cover all three creation paths.
- **Supervisor must not read credentials to guess daemon id**. It currently knows no daemon id (no grep hits); the center sends it with creation requests.

## Decisions & tradeoffs

- **Names and assembly live only in supervisor; center sends ids**: create_session is the convergence point for legacy IPC create and device_create. After copying std::env::vars(), write COFLUX_* with command.env so explicit values override inherited names. Rejected: center env maps; worker assembly, because worker forwards DataFrame::Device unchanged and supervisor decodes it.
  Based on `crates/supervisor/src/sessions.rs:748` (signature), `:793-796` (environment copy/TERM override), `:701` (legacy create), `:1725` (device_create decodes DeviceSessionCreate); supervisor has no daemon-id/credential reads.

- **Add ids to both creation protocols without changing existing fields**: SessionCreate in daemon.proto gains workspace_id/project_id/daemon_id/mcp_url from field **7**. DeviceSessionCreate in device.proto gains the same from **10**, since 9 is 091's command. WorkerToSupervisor::SessionCreate in ipc.rs gains optional defaulted fields, omitted when empty during serialization. Populate all three center builders: direct sessionCreate for cofluxd terminal new, prepared session.create for web taskStart, and prepared session.create for MCP create_terminal. mcp_url is config.publicUrl + "/mcp".
  Rejected: changing only device creation, which misses agent-created child terminals using direct IPC.
  Based on daemon.proto SessionCreate 1–6, device.proto DeviceSessionCreate 1–9, `crates/protocol/src/ipc.rs:37-48`; `apps/server/src/hub.ts:1284` (terminalNew), `:3121` (startOrAttachTask), `:3655` (createTerminalForAccount); config publicUrl from 090.

- **Worker only maps proto to IPC on the direct path**. Forward new SessionCreate fields unchanged into session.create. Device frames remain opaque; supervisor reads their fields. 091 execute_prepared_operation decodes, changes shell, and reencodes; prost drops unknown fields, but worker/proto are upgraded together, so updated generated output suffices without extra code.
  Based on `crates/worker/src/main.rs:1785`; `crates/worker/src/device.rs` execute_prepared_operation; `crates/supervisor/src/main.rs:290-300` unchanged handle_device forwarding.

- **Compatibility means absence, never failure**: old supervisor serde parsing has no deny_unknown_fields and ignores new IPC fields; old workers do not map them; old centers do not send them. Supervisor uses Option/empty defaults. Missing values yield empty or absent corresponding variables, executor's choice, but SKILL must consistently detect upgraded coflux using **nonempty COFLUX_WORKSPACE_ID**. Add a session.create legacy compatibility test following LegacyWorkerToSupervisor at ipc.rs:409-450.
  Based on `crates/supervisor/src/main.rs:297`: failed if-let decoding silently discards the whole request, so required fields could **swallow session creation**; `:360-372` only destructures known fields; `crates/protocol/src/ipc.rs:33-48,409-450`.

- **Supervisor changes are restricted to environment assembly and argument forwarding from two entry points**. The user's 2026-09-05 choice is a **one-time exception** to 074's no-supervisor-change constraint. Preserve holder/input_seq/attach/ledger/resync semantics. Supervisor cannot hot-upgrade; users need `cofluxd update && cofluxd restart`, documented in Maintenance notes/README.
  Based on plan 074 decision 2's hot-upgrade rationale and `crates/supervisor/src/sessions.rs:261-265`: canonical ledger data includes shell, not yet these ids. Including stable ids in canonical is safe because replay of one operation carries identical values.

- **Rewrite SKILL around local commands plus MCP**: first detect nonempty COFLUX_WORKSPACE_ID. Use local cofluxd for current-workspace terminal creation/read/wait/send, progress, notifications, and ports: credential-free and simplest. Use MCP for child workspaces, cross-workspace/device work, or access from outside coflux. Explain all 14 tools and human priority, bounded waits, and upgrade-required discipline. If MCP is unconfigured, tell the user `claude mcp add --transport http coflux $COFLUX_MCP_URL`. Preserve 088's read-before-send, stop-on-rejection, progress-versus-notify, and no-polling rules. Synchronize brief CLI/root README guidance.
  Rejected: a separate MCP skill, because one installed skill should define the division consistently.
  Based on current packages/cli/skills/coflux/SKILL.md structure, CLI README agent commands, root README user-side section.

- **Black-box coverage for all three creation paths**: (1) MCP create_terminal runs `env | grep '^COFLUX_' | sort`; source=log read_terminal contains five ids and MCP_URL matching center results, with a separate empty PROJECT_ID assertion for directory workspaces. (2) Web manual taskCreate/taskStart+attach via device-harness runs `echo W=$COFLUX_WORKSPACE_ID T=$COFLUX_TASK_ID S=$COFLUX_SESSION_ID`, read through read_terminal/checkpoint. (3) Inside a coflux terminal, `cofluxd terminal new --cmd 'env | grep ^COFLUX_'` exercises direct IPC, driven like agent-control.test.mjs, then terminal read sees variables. Negative coverage: legacy IPC parser ignores new fields successfully; negatively validate new tests.
  Based on tests/src/mcp-write-tools.test.mjs tooling/readUntil, agent-control.test.mjs:25,59 child-process driving, and device-harness.mjs.

- **No frontend changes or Claude UI validation**, following repository convention.

## Direction

```
Center (three builders) ── ids + mcp_url ──▶ worker
  Direct SessionCreate ── proto→IPC ──▶ supervisor.create(...) ─┐
  Prepared DeviceSessionCreate ── opaque frame ──▶ device_create(...) ─┴─▶ create_session:
    copy std::env → override COFLUX_DEVICE_ID / PROJECT_ID / WORKSPACE_ID /
    TASK_ID / SESSION_ID / MCP_URL → spawn PTY
Agent in any PTY: populated env → pass ids to MCP; absent → outside coflux or not upgraded, use SKILL fallback
```

### Milestone 1: Protocol and IPC

Add SessionCreate fields 7+ and DeviceSessionCreate fields 10+, regenerate all three languages, and add optional IPC session.create fields/legacy test.
Validation: `cd proto && buf generate && git status --short` shows only expected generated field changes; `cargo test -p coflux-protocol` passes including new legacy coverage.

### Milestone 2: Supervisor and worker

Supervisor create_session assembles/overrides six variables; create/device_create forward fields, with no other changes. Worker maps the direct path.
Validation: `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` passes without warnings; `cargo test -p coflux-supervisor -p coflux-worker` passes; `git diff --stat c0aa426..HEAD -- crates/supervisor` contains only sessions.rs and main.rs forwarding if needed.

### Milestone 3: Center builders

Populate ids/mcp_url in all three requests, adding nearby config-derived values if needed. WS/MCP behavior unchanged.
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 4: SKILL and READMEs

Rewrite SKILL with dual paths, detection, 14 tools, and discipline. Synchronize CLI/root READMEs.
Validation: `node packages/cli/cofluxd.mjs --help` → exit 0, guarding the unchanged CLI.

### Milestone 5: Black-box acceptance

New file with port starting at **8870** covers all three paths and empty directory-workspace PROJECT_ID. Orchestrator updates plans/README.
Validation: `node --import tsx --test tests/src/<new-file>.test.mjs` → exit 0 (acceptance).

## Landmines

- **Supervisor silently drops decoding failures** at main.rs:297. New IPC fields need Option plus serde(default); a required String makes new supervisor swallow old-worker session.create without an error, so sessions never start.
- **Environment ordering**: sessions.rs:793-796 copies std::env then overrides TERM. Write COFLUX_* afterward so inherited stale SESSION_ID cannot replace it. Unrelated COFLUX_HOME does not conflict.
- **No generic env map** in IPC/proto and no incidental daemon-configuration injection such as COFLUX_HOME/COFLUX_SERVER.
- **Canonical ledger includes all DeviceSessionCreate** at sessions.rs:261-265. New values must remain identical across replay; stable ids satisfy this, timestamps would not.
- **091 decode/reencode needs updated worker generated output** or MCP command terminals lose fields. CI zero-diff generation checks catch omissions.
- Test daemon id is stack.daemonId, also returned by MCP list_devices; assert equality.
- Each black-box file owns its const PORT; 091 already uses through 8869.
- SKILL reaches users only after cofluxd npm publication. This plan edits repository content; release is out of scope.
- Old supervisors do not hot-upgrade. Production/users need cofluxd update && cofluxd restart; empty-variable detection covers the transition.

## Scope

In scope:
- proto/coflux/v1/daemon.proto, device.proto, and three-language generated outputs
- crates/protocol/src/ipc.rs and tests
- crates/supervisor/src/sessions.rs, main.rs entry forwarding only
- crates/worker/src/main.rs direct mapping; other worker files only minimal compilation fixes
- apps/server/src/hub.ts, config.ts
- packages/cli/skills/coflux/SKILL.md, packages/cli/README.md, README.md
- tests/src new cases

Out of scope:
- Sessiond holder/input_seq/attach/ledger/resync **semantics**
- packages/cli/cofluxd.mjs (no new command), existing 090/091 tools, OAuth
- Web/iOS/mobile/client/swift-client handwritten source; generated output excepted
- npm/tag releases
- plans/README.md, updated by orchestrator

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types/generated compatibility | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile build | `pnpm -C apps/mobile build` | exit 0 |
| Proto regeneration | `cd proto && buf generate` | Expected changes only |
| Rust unit tests | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker` | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0, zero warnings |
| CLI intact | `node packages/cli/cofluxd.mjs --help` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| New black-box cases (acceptance) | `node --import tsx --test tests/src/<new-file>.test.mjs` | exit 0 |
| 090/091 regression (acceptance) | `node --import tsx --test tests/src/mcp-oauth.test.mjs tests/src/mcp-isolation.test.mjs tests/src/mcp-write-tools.test.mjs tests/src/agent-control.test.mjs` | exit 0 |
| Full suite (acceptance) | `pnpm -C tests test` | All pass |

## Done criteria

- [ ] All listed commands pass.
- [ ] All three PTY creation paths provide six variables matching center ids; directory workspace PROJECT_ID is empty.
- [ ] Old supervisor/worker combinations only lack variables and still create sessions, proven by legacy tests/defaulted fields.
- [ ] SKILL explains local/MCP division, detection, and three rules; READMEs synchronized.
- [ ] Sessiond semantics, cofluxd command surface, and web/iOS remain unchanged.
- [ ] New black-box tests fail when environment assembly is removed, demonstrating negative validation.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] plans/README.md status is updated.

## STOP conditions

- Injection requires sessiond holder/input_seq/attach/ledger/resync semantic changes.
- Old parsers cannot ignore new IPC fields, e.g. format is not serde JSON or deny_unknown_fields is enabled.
- SessionCreate field 7 or DeviceSessionCreate field 10 is occupied.
- A cited decision fact no longer holds.
- Validation fails twice after one reasonable fix.

## Maintenance notes

- This is a one-time exception to 074's supervisor constraint, authorized by the 2026-09-05 environment choice. Future supervisor changes still incur manual fleet upgrades rather than hot upgrades.
- Variable names are the agent-facing SKILL contract; renaming breaks installed skills. Add names, never rename.
- Rollout: deployed server sends ids; tag hot-upgrades worker direct mapping; users update/restart supervisor; npm release distributes SKILL. Fallback applies until all four arrive.
- This completes 090–092: center MCP with OAuth/14 tools plus session context. Authorized-app listing/revocation UI, CIMD, MCP notify/progress, and fs/exec tools require separate future plans.
