# Plan 088: Agent control, part two: terminal wait/send and progress notes

> This plan is an outcome contract, not a step-by-step script. Understand requirements and recorded decisions, then design against live code. Validate milestones only if you are also the verifier; delegated executors implement with verification outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat b0deda4..HEAD -- proto crates/worker/src apps/server/src/hub.ts packages/cli packages/client packages/swift-client apps/web apps/ios tests/src`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none (extends 074 and revisits its first decision)
- Category: feature
- Execution: self
- Planned at: `b0deda4`, 2026-08-26

## Requirement

Plan 074 lets PTY agents create/read terminals but leaves daily friction, identified in the 2026-08-26 comparison with Orca's CLI skill:

1. **Waiting requires polling**: SKILL tells agents to list every few seconds until exited. Each poll costs an inference roundtrip; provide one blocking command.
2. **Created terminals cannot be controlled**: interactive y/N confirmation or another command in the same shell is impossible, forcing abandonment/recreation. The original no-AI-PTY-write rule was a useful first slice; revisit it as promised by 074's maintenance notes, within decision two's constraints rather than granting unrestricted input.
3. **Cards do not show progress**: automatic hook activity distinguishes working/waiting, while notify means requesting help and clears on any hook. Neither holds a note such as reproducing an issue and locating relay reconnect behavior.

Agents in Coflux terminals can then use:

```sh
cofluxd terminal wait <taskId> [--timeout <seconds>]   # Block until exit, print status; report timeout explicitly
cofluxd terminal send <taskId> --text "y" [--enter]  # Write PTY text; readable rejection while a user controls it
cofluxd progress "Reproduced; investigating relay reconnect" # Visible on web workspace row and iOS task card until replaced or agent exits
```

Update SKILL to teach wait instead of polling, read-before-send/stop-on-rejection discipline, and progress versus notify (status reporting versus requesting help).

Incorrect neighboring solutions:
- No unconditional write authority. An attached user always wins; agents never evict them.
- No input bypass. Use supervisor's existing attach/holder/input_seq path as an ordinary holder, without nonexclusive semantics.
- No progress enums/history/database. One overwritable display field with presence lifecycle.
- Do not redefine notify. Its help/question/hook-clear channel remains separate from progress surviving hooks.

## Decisions & tradeoffs

- **wait is blocking CLI-side polling with no protocol additions.** Repeatedly call existing terminal.list/read status/exitCode until exited or timeout. Only wait for exit, not heuristic TUI idleness. Rejected: daemon long-poll/server push adds protocol surface merely to save loopback polls without agent-visible benefit. Evidence: agent_ctl.rs:168-185 returns validated status/exit_code; cofluxd.mjs:762 AGENT_TIMEOUT_MS=30_000 cannot support a long single request.
- **send uses supervisor's normal path through a worker-local holder and rejects human holders.** This is a controlled revision of 074's no-write rule. Its two rejected approaches remain rejected: never steal user control and never bypass exactly-once input_seq. Reuse center ownership/address lookup from terminal.list/read, whose response already carries session_id; targets remain in the caller's workspace. Rejected: a holder-free supervisor input endpoint, since supervisor is not hot-upgraded and bypass semantics were 074's costly option. Rejected: server-proxied input, because local-first input travels client↔daemon and center is outside that path. Evidence: supervisor sessions.rs:654 apply_device_input is sole entry, :584-585 attach takeover emits holder_taken_over; worker device.rs:710,1346 terminates device channels and relays SessionAttach/PtyInput, uniquely knowing attach state and accessing local UDS. **Zero supervisor changes and unchanged holder/input_seq/attach semantics remain hard constraints.**
- **Progress is new SessionAgentRef field 6, independent of message.** It survives hooks, is overwritten by progress, disappears with the agent, and is length-clamped like message. Reuse presence reporting: worker updates/reports SessionAgents; server acceptSessionAgents broadcasts and resends on subscribe; clients render. Rejected: message clears on every hook by common.proto:114-116, immediately erasing progress. Rejected: persisted entities add migrations/read-state concerns for inherently live work whose workspace goes offline with daemon. Evidence: common.proto:105-118 has fields 1–5 used; hub.ts:622; Swift CofluxClient.swift:51 already stores sessionAgents.
- **Separate local progress command, no new server RPC.** Like notify: loopback→PID ancestry→field update→report, without state changes/question. Rejected: a notify flag merges distinct semantics and complicates guidance. Evidence: existing notify and 074 decision five's local-path reasoning.
- **Include iOS now.** 074 deferred it until presence stabilized; 073/074 have now run in practice. Add Swift decode/reducer passthrough and one card line. Web renders the workspace row under design guidelines; user validates visuals. Rejected: web-only omits the user's primary agent-monitoring device. Evidence: iOS currently has no sessionAgents references while Swift store already exists.
- **Claude does not visually verify frontends.** User performs web/iOS walkthrough; builds/types still run.

## Direction

Send flow, with wait/progress simpler:

```text
agent → loopback → worker
  → PID ancestry identifies caller session, rejecting outsiders as in 074
  → center validates target task belongs to same workspace and returns session_id
  → local attach-state check rejects a human holder with readable error
  → ordinary holder attaches via supervisor UDS, writes sequenced input, releases
```

### Milestone 1: terminal wait

Add taskId/optional timeout. Executor chooses default, suggested 20–30 minutes for coding tasks. Poll internally; on exited print terminal status and exit 0 because waiting succeeded; timeout gives readable nonzero error. Update help.
Validation: CLI --help exits 0 and lists wait.

### Milestone 2: terminal send, the core risk

Implement ownership→human-holder check→normal input path and CLI --text/--enter. Distinguish readable wrong-workspace, user-control, and exited errors.
Validation: daemon build warning-free; git diff --stat b0deda4..HEAD -- crates/supervisor is empty.

### Milestone 3: Progress channel

Add field 6 and regenerate TS/Rust/Swift; worker action/clamp/immediate reporting; server passthrough; CLI progress.
Validation: Rust protocol tests/server types pass; generated directories have no drift after regeneration.

### Milestone 4: Web and iOS display

Latest note on web workspace row and iOS task card, including Swift decode/reducer/UI.
Validation: web tsc, Swift package tests, generic iOS simulator build pass.

### Milestone 5: SKILL and black-box acceptance

Replace polling guidance; document read-before-send, stop on rejection, yield interaction to users; distinguish progress/notify. New exclusive-port cases verify wait on real command/status, effective send without user, **rejection with human attach**, progress broadcast surviving hooks, and existing outsider-PID rejection. Remove corresponding logic in negative variants to prove tests fail.
Validation: full suite passes except two existing cofluxd doctor baseline failures.

## Landmines

- The revised 074 rule still forbids human-holder takeover and input_seq bypass. Together with zero supervisor changes these define the entire solution space. STOP if incompatible; invent no fourth input path.
- Long wait cannot increase one agentPost timeout: daemon control WS has its own SERVER_TIMEOUT. Poll in CLI with short requests.
- message clears on every hook; progress needs separate field/clearing at merge_hook_states in worker main.rs. Preserve existing message clearing.
- M5 must remove current every-few-seconds-list guidance or agents keep polling despite wait.
- Snapshot delay is about two seconds, but sessionExit status/exitCode is independent. Wait on status, never unchanged output.
- cofluxd hook never writes stdout because Claude treats it as decision JSON; agent commands must write stdout. Keep new commands on the right side of the cofluxd.mjs:759 boundary.
- Test files own exclusive PORT values; choose unused ports. Harness never installs services.
- New CLI/old worker versions can differ in rollout. Unsupported commands must return readable upgrade-required rejection, never silence/timeout.
- 084 isolated hosted tests from real Keychain after contamination; follow its isolation for new Swift tests.

## Scope

In scope:
- packages/cli/cofluxd.mjs and skills/coflux/SKILL.md
- Worker agent_ctl/device/main and needed modules
- common.proto and TS/Rust/Swift generated outputs
- hub.ts passthrough and ownership case extension if needed
- TS client passthrough/web sidebar
- Swift client decode/reducer/iOS task card
- New tests/src cases

Out of scope:
- supervisor source, hard zero-change constraint
- Sessiond holder/input_seq/attach semantics, unchanged ordinary-holder behavior
- Workspace/worktree creation and subagent orchestration, deferred by 2026-08-26 exploration
- Progress state enums/history/persistence, rejected to avoid competing activity truth
- Frozen mobile
- APNs, separate topic

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Black-box integration | `pnpm -C tests test` | Pass except two existing doctor baseline failures |
| Rust tests | `cargo test -p coflux-protocol` | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Swift tests | `swift test --package-path packages/swift-client` | exit 0 |
| iOS build | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator'` | exit 0 |
| Supervisor unchanged | `git diff --stat b0deda4..HEAD -- crates/supervisor` | Empty |

Web/iOS visuals are manually accepted by the user; no Playwright/UI walkthrough.

## Done criteria

- [ ] All commands pass.
- [ ] Real-session wait blocks until command exit and prints status; timeout works with readable error.
- [ ] Send works without user control and rejects attached users, never evicting human holders.
- [ ] Progress broadcasts, survives hooks, and is replaced by next note.
- [ ] SKILL teaches wait, send discipline, and progress/notify distinction.
- [ ] Supervisor and holder/input_seq/attach semantics unchanged.
- [ ] Negative test variants fail when corresponding logic is removed while unrelated cases pass.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] Index updated.

## STOP conditions

- Send cannot simultaneously preserve zero supervisor changes, normal attach/holder/input_seq, and no human eviction. Report, do not invent new semantics.
- Existing read/list path fails or changes semantics.
- SessionAgentRef field 6 is already occupied by concurrent changes.
- Validation fails twice after one reasonable fix.
- Out-of-scope changes required.

## Maintenance notes

- 074's boundary is now **human-priority limited input**: while a human is attached, agents remain read-only. Future TUI-driving/idleness features must rejustify this boundary, not assume send implies unrestricted control.
- Activity and progress are separate: hooks alone determine state; agents explicitly write notes. Manual agent state changes should revisit the 2026-08-26 rejection of conflicting truth sources.
- Delivery follows 072/073/074: worker tag hot upgrade, npm CLI, server/web deploy, iOS TestFlight. Verify mixed-version degradation on first rollout.
- Frequent default wait timeout hits warrant reconsidering whether agents should leave such long tasks unattended, not blindly raising limits.
