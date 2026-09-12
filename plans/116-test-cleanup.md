# Plan 116: Clean up tests according to testing principles and remove a stale worktree

> This plan is an outcome contract, not a step-by-step script. Understand the requirements and decisions, then design against live code.
> Run milestone validation as you work only if you are also the verifier; delegated executors implement, with verification outside their sessions.
> Stop on any STOP condition. Update this plan's status in `plans/README.md` when complete.
>
> Drift check: `git diff --stat 7deedfb..HEAD -- tests/src apps/desktop/src apps/desktop/test crates docs/auth-design.md`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: tests
- Execution: subagent opus
- Planned at: `7deedfb`, 2026-09-11

## Requirement

The repository has two testing principles:

1. AGENTS.md's harness guidance and `tests/src/harness.mjs:1-15`: tests/src is **black-box**, driving real processes through the WebSocket wire protocol and **never importing apps/**, so it survives refactoring and language rewrites.
2. Development principles: **do not test reversible, low-impact changes merely by restating implementation**; frontend UI receives manual verification.

Current tests diverge from both. Restore those principles:

- **A. White-box tests in the black-box directory**: nine files directly import server implementation (hub.ts, store.ts, services, pure functions) while claiming to be black-box, about 6,100 lines total. The user chose to **delete them outright**, not move or retain them.
- **B. Desktop tests restating implementation**: literal UI copy, tones, icon names, original constant values, and copied if/else/switch branches. Delete three entire files and 16 cases across eight files.
- **C. Similar inline Rust tests**: enum/string mappings, constant passthrough, and predicates recreated in the test. Remove 15 cases (244 → 229).
- **D. Stale worktree**: `.claude/worktrees/20260908-codex-agent-tab` is 133 commits behind main, with three unmerged branch commits (Codex Agent Tab, 2026-09-08). Delete the worktree but retain its branch.

Completion means no tests/src/*.test.mjs imports apps/server; all identified restatement tests are gone, every retained case remains, all four test layers pass, and cargo build has zero warnings. **No production changes**, apart from the one documentation correction.

## Decisions & tradeoffs

- **Delete group A rather than relocate it to server unit tests**: remove nine files; add no apps/server/test, server test script, or CI changes. Rejected: moving them — the user explicitly chose deletion and accepts losing these race/migration regressions. Based on: `server-connection-concurrency.test.mjs:130`, `server-generation-entity-lifecycle.test.mjs:34` (hub imports), `prepared-operation-service.test.mjs:7`, `schema-migrations.test.mjs:10-11`, `proxy-tunnel-limits.test.mjs:18`, `proxy-gate.test.mjs:7`, `auth-pages.test.mjs:24`, `auto-update-manifest.test.mjs:6`, `relay-dial-version.test.mjs:16`, all under tests/src.
- **Group A boundary is apps/server imports, not all application code**: retain release-sign.test.mjs and cli-release-trust.test.mjs. They import scripts/release-statement.mjs and packages/cli/release-trust.mjs and exercise release scripts/npm signature verification rather than server implementation. The user knowingly approved retaining them. Evidence: release-sign.test.mjs:9-21, cli-release-trust.test.mjs:11-14. @coflux/protocol imports are likewise permitted as generated protobuf artifacts, explicitly noted by harness.mjs:10-15.
- **Group B changes only tests**: even though terminal-link-activation.ts exists solely for testability, do not inline it into terminal-pane.tsx. Retain account-footer-view.ts and desktop-update.ts too. Rejected: opportunistic inlining — user excluded production changes, leaving them for separate work. Evidence: terminal-link-activation.ts's header states pure-Node testability as its extraction reason.
- **Keep all five packages/client test files**: device-router.test.ts's shared trace fixture is consumed by Swift and serves cross-client truth. Evidence: `packages/swift-client/Tests/CofluxClientCoreTests/DeviceRouterParityTests.swift:69`.
- **Group B deletion and retention lists are exhaustive** (M2). Delete nothing outside them. Remove tests of literal UI copy/tones/icons, original constants, single-line booleans/truth tables, copied switch/OR chains. Keep security boundaries (Origin, traversal rejection, CSP, IPC sender validation, encrypted tokens), external-file equivalence, state-machine invariants, actual regressions, and persistence compatibility.
- **Group C includes four secondary cases, two trimmed rather than deleted**: ops.rs production_script_pipes_into_worker_log_sink retains only `!script.contains("| tee ")` to prevent log-sink regression. device.rs call_ledger_counts_waiter_strings_and_fixed_overhead loses two tautological assert_eq! calls deriving expected values from production functions, retaining duplicate-waiter charging protection. Rejected: complete deletion because each has an independently valuable assertion. Evidence: ops.rs:567, device.rs:4070.
- **Do not touch protocol wire_tests.rs** (17 cases): unaudited. Evidence: crates/protocol/src/lib.rs:79.
- **Delete group D through Coflux MCP remove_workspace, never git worktree remove**. Preserve branch dev/20260908-codex-agent-tab. Session rules require registered-workspace removal; its three unmerged commits are user assets.
- **Planning decision**: at docs/auth-design.md:138 remove only the sentence locating pure-function tests in tests/src/auth-pages.test.mjs. Retain the preceding statement that authorize / mcp-oauth / proxy contain HTTP black-box flows.
- **Planning decision**: executor may remove unused harness.mjs exports hiddenFieldsFrom/formActionFrom or leave them. JavaScript has no dead-code warning here.

## Direction

Four independent milestones may run in parallel; M4 is a standalone MCP operation.

### Milestone 1: Restore tests/src to black-box tests

Delete these nine tests/src/<name>.test.mjs files and eliminate apps/server imports:

server-connection-concurrency, server-generation-entity-lifecycle, prepared-operation-service, schema-migrations, proxy-tunnel-limits, proxy-gate, auth-pages, auto-update-manifest, relay-dial-version.

Update docs/auth-design.md:138 as decided.

Validation: `grep -n "from .*apps/server\|import(.*apps/server" tests/src/*.test.mjs` → no output. A literal apps/server/src search also finds comments in authorize.test.mjs:30 and mcp-write-tools.test.mjs:43; these do not count. `ls tests/src/*.test.mjs | wc -l` → 50 (59 − 9). `node --import tsx --test tests/src/claude-plugin-guard.test.mjs tests/src/claude-plugin-session-context.test.mjs` → exit 0; these stack-free files verify glob/harness loading.

### Milestone 2: Remove desktop restatement tests

Delete three files under renderer/components/workbench: account-footer-view.test.ts, desktop-update.test.ts, terminal-link-activation.test.ts.

Remove 16 individual cases; line numbers refer to test declarations at 7deedfb:

| File | Remove | Retain |
|---|---|---|
| `src/main/app-protocol.test.ts` | :7 scheme URL constant, :39 extension/MIME lookup | :15 SPA fallback, :25 traversal rejection, :47 CSP |
| `src/main/daemon-files.test.ts` | :105 literal fda-status/supervisor-version parsing | Other seven |
| `src/main/settings.test.ts` | :6 default constant values | :13 precedence, :20 invalid-value skipping |
| `src/renderer/desktop-bridge.test.ts` | :8 no window, :20 no cofluxDesktop on window | :32 address comes only from bridge |
| `workbench/workbench-state.test.ts` | :18 auth mapping, :26 three reconnect-banner values, :32 Changes activation truth table, :39 one-line close-confirmation equality | :44 and everything from :53 onward: persistence compatibility, selection fallback, six tab-follow cases |
| `workbench/desktop-attention.test.ts` | :40 question-message passthrough, :77 notification literals | :25 two-state filter, :46 dedup/badge, :62 reset on recovery |
| `workbench/daemon-view.test.ts` | :32 label/tone/pulsing, :57 copied visible-action switch, :92 terminal filter+length | :101 automatic onboarding, :116 onboarding page, :131 three onboarding steps including regression |
| `workbench/changes-refresh.test.ts` | :25 field-by-field OR chain | :18 first/reentry refresh, :33 manualRevision invalidation |

Executor discretion: daemon-view.test.ts:57's assertions at :72-73 that remove always requires confirmation and is destructive may survive as a separate minimal case or be deleted with the original.

Retain whole files: test/config.test.ts; main ipc-trust, ipc, origin, token-store, update-state, window-state, daemon-state, daemon-version, daemon-bundle tests; renderer/session-token.test.ts; every packages/client/src/*.test.ts.

Remove unused imports. **Do not change the desktop test script**; each of its four globs still matches files (see Landmines).

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0; 101 − 28 = 73 tests, or 74 if retaining a minimal destructive-confirmation case; actual implementation has 74.

### Milestone 3: Remove inline Rust restatement tests

Delete 11 cases; approximate fn line numbers refer to 7deedfb:

- crates/cli/src/main.rs: managed_commands_are_recognized_explicitly (:119), refusal_points_to_the_desktop_app (:129), migrated_hints_follow_node (:136). Keep help_keeps_agent_phrases_used_by_skill_docs (:143), since SKILL.md is an external consumer.
- crates/protocol/src/logline.rs: live_timestamp_has_expected_shape (:141).
- crates/worker/src/agent_ctl.rs: response_shapes_are_agent_readable (:756), status_names_cover_task_states (:770), request_ids_are_unique (:825).
- crates/worker/src/device.rs: transport_backpressure_detects_output_sequence_gap (:6175).
- crates/worker/src/gateway.rs: text_frame_is_a_protocol_error (:730), binary_frame_is_the_envelope (:739). Keep close_before_hello_is_a_normal_end (:698).
- crates/worker/src/hook.rs: event_mapping_covers_both_agents (:449).

Four secondary cases: delete commands.rs command_normalization_collapses_blank_to_empty (:544) and gateway.rs control_frames_keep_waiting (:718); trim ops.rs:567/device.rs:4070 as decided.

Every production function called by deleted tests retains production callers, so no dead_code should result. Clean unused test-module imports.

Validation: `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` → exit 0, 13 fewer cases (11 primary + two secondary deletions; two trimmed cases remain). `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` → zero warnings.

### Milestone 4: Remove stale worktree

Use Coflux MCP remove_workspace for `/Users/wsq/Workspace/coflux/.claude/worktrees/20260908-codex-agent-tab`, a child workspace in this project's sidebar. If its ID is unknown, use list_workspaces and match by path. Preserve dev/20260908-codex-agent-tab.

Validation: git worktree list omits the path; git branch --list dev/20260908-codex-agent-tab still produces output.

## Landmines

- Desktop's test script at package.json:13 has four **nonrecursive** literal globs: `src/main/*.test.ts src/renderer/*.test.ts src/renderer/components/workbench/*.test.ts test/*.test.ts`. npm uses sh -c; unmatched globs reach Node literally and fail. After deletion each still matches (main 12, renderer only session-token, workbench four, test config). No script change is needed; do not delete additional renderer-root/workbench test files.
- agent_ctl.rs:775 helper fn scope() remains used by three retained tests; do not remove it.
- tunnel.rs:545 uses `#[tokio::test(flavor = "current_thread")]` deliberately to create a race. It is outside deletion scope; do not normalize its flavor.
- Release builds use -D warnings. logline.rs:77 records two v0.31.0 musl jobs failing for this reason. Unused test imports can break releases.
- daemon-files.test.ts:37 claims byte equivalence with npm plistXml but uses a hardcoded golden string rather than reading packages/cli/cofluxd.mjs. Keep it, but do not treat it as cross-source validation.
- On this machine, three agent-activity tests necessarily false-fail and can hang the suite because real claude sessions pollute process-name detection. auto-update, local-first-device, and signed-upgrade may flake; one failure and two passes on identical code indicate flakiness. Run the full suite in a foreground Coflux terminal with cofluxd terminal wait, not background Bash that may be killed under memory pressure. Local Postgres: 127.0.0.1:5432 via pnpm dev:pg; Docker is OrbStack, orb start.
- Session Bash is zsh: `"$VAR:path"` interprets :p as a modifier; use `${VAR}:path`. set -e is ineffective; use && for dependent steps. Worktree guards reject git -C .. and compound $(git …) forms; run separate commands.

## Scope

In scope:
- tests/src: only the nine file deletions, optionally two unused harness exports
- docs/auth-design.md: one sentence
- Desktop main/renderer/workbench *.test.ts files
- crates/cli/src/{main,commands}.rs, crates/protocol/src/logline.rs, crates/worker/src/{agent_ctl,device,gateway,hook,ops}.rs: only #[cfg(test)] modules
- plans/README.md and this plan

Out of scope:
- All production code, including inlining terminal-link-activation.ts, per user decision
- release-sign.test.mjs, cli-release-trust.test.mjs, local-first-benchmark.mjs, device-harness.mjs, oauth-harness.mjs: no server import or utility files
- packages/client tests and Swift-client Tests: cross-client truth
- protocol wire_tests.rs and other Rust tests: unaudited
- Desktop package.json and workflows: glob/CI changes unnecessary
- apps/server: no new unit-test layer
- dev/20260908-codex-agent-tab branch: remove only its worktree

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| No server imports in black-box directory | `grep -l "apps/server/src" tests/src/*.test.mjs` | No output |
| Stack-free black-box smoke | `node --import tsx --test tests/src/claude-plugin-guard.test.mjs tests/src/claude-plugin-session-context.test.mjs` | exit 0 |
| Desktop types/tests/build | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0, 73 tests |
| Client tests, unchanged | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server types, unchanged | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust tests | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0 |
| Warning-free Rust | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0, no warnings |
| Full black-box acceptance | `pnpm -C tests test` | Pass except documented false failures/flakes |

## Done criteria

- [ ] All commands pass, applying Landmines' known false-failure/flake criteria to full black-box results.
- [ ] No apps/server imports in tests/src/*.test.mjs; nine files removed.
- [ ] Desktop: three files and 16 cases deleted; every retained case remains.
- [ ] Rust: 13 complete deletions and two trims; warning-free build.
- [ ] Stale worktree absent from git worktree list; branch remains.
- [ ] git diff 7deedfb..HEAD --stat contains no production-code files, only tests, docs/auth-design.md, and plans/.
- [ ] Every decision followed.
- [ ] plans/README.md status updated.

## STOP conditions

- A cited fact no longer holds, such as a white-box file no longer importing server or a deletion target already absent.
- Out-of-scope files, especially production code, require changes.
- Validation fails twice after one reasonable fix.
- Deleting tests causes dead_code/unused build warnings requiring production changes.
- remove_workspace cannot find the corresponding workspace. Report and stop; never fall back to git worktree remove.

## Maintenance notes

- Before adding tests/src files, ask whether they drive real processes over the wire protocol. Otherwise they do not belong here. Server in-process tests must become black-box tests or use a separate server unit layer, explicitly not created in this plan.
- terminal-link-activation.ts and desktop-update.ts now lack test consumers and may be inlined next time terminal-pane.tsx/workbench.tsx changes.
- protocol wire_tests.rs has not been audited under these criteria.
- The three Codex Agent Tab commits remain on dev/20260908-codex-agent-tab; either plan continued work or delete that branch later.
