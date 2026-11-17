# Plan 20261115-agent-turn-identity: a turn finished while the daemon was offline is not taken for the one already seen

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 1fc5d5e0..HEAD -- proto crates/protocol crates/runtime/src/observed.rs packages/protocol packages/swift-client/Sources/CofluxProtocol apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts`

## Status

- Priority: P3
- Effort: S
- Risk: MED
- Depends on: wiki/plans/20261115-persist-agent-seen.md (DONE, deployed)
- Category: bug
- Execution: subagent(opus) — departure check (2026-11-15)
- Stop after: implementation — departure check, plain autopilot
- Plan review: none — the orchestrator is already on the top tier, so the audit was not offered
- Workspace: isolated — cut from the main worktree as `dev/20261115-agent-turn-identity`
- Planned at: `1fc5d5e0`, 2026-11-15

## Record

### Requirement

Plan `20261115-persist-agent-seen` stores the account-wide "seen" mark of a finished agent turn
and decides "seen" by comparing a presence entry with the mark: same terminal session, same agent
session, a finished state. Presence says nothing about *which* turn is finished. So when a seen
terminal's agent runs a whole further turn while the daemon is disconnected from the centre, the
centre never sees an unfinished state in between, and the new finished turn passes for the old
one: it shows as seen on every client and nobody is told the agent finished again.

Once this is done, every presence entry carries the moment its current state was entered, as the
daemon recorded it. The centre stores that moment with the mark and requires it to be equal for
"seen". A turn that finished while the daemon was offline has another moment and comes back
unseen. Daemons that do not send the moment (older runtimes) behave as today. Desktop and iOS
behaviour is unchanged; they only receive regenerated protocol code.

### Decisions & tradeoffs

- **D1 The identity is a moment, not a counter.** The runtime stamps a session's record with the
  wall-clock millisecond at which its presence state last changed, and reports it. Rejected: a
  per-session turn counter — a restarted runtime starts counting again and can reach the number a
  stored mark holds; a moment cannot repeat. The centre compares for equality only, so clock
  differences between machines do not matter. Based on: `crates/runtime/src/sessiond.rs`
  `TerminalState::restore` sets `program_status: None`, i.e. nothing about the record survives a
  runtime restart.
- **D2 The moment changes only when the presence state changes.** A report that keeps the state
  (`program_presence_state` gives the same string) and changes only the message or the app name
  keeps the moment; the first record of a session and every state change take a new one.
  Rejected: stamping every report — a program that repeats `state=done` would un-see its own
  turn. Based on: `crates/runtime/src/observed.rs` `apply_program_status`,
  `program_presence_state`.
- **D3 It is stamped in the runtime core, where presence is assembled,** not in sessiond's
  terminal state: sessiond's record is compared for equality to detect change
  (`set_program_status`) and has no clock. Based on: `sessiond.rs` `set_program_status`;
  `observed.rs` `merge_annotations` fills `state` and `message` from the record.
- **D4 Wire: one new field on `SessionAgentRef`, `double state_since = 9`,** milliseconds since
  the epoch, 0 = not reported. Additive; the centre copies it to clients unchanged, which ignore
  it. Rejected: a separate message — the moment belongs to the entry it describes. Based on:
  `proto/coflux/v1/common.proto` `SessionAgentRef` (other timestamps on the wire are doubles).
- **D5 The centre adds the moment to the mark and to the test.** `agent_seen` gains a column
  (migration 15, one-way, default 0 for existing rows). An entry is seen exactly when the plan
  20261115-persist-agent-seen test holds **and** the mark's moment equals the entry's. A value
  that is not a finite, non-negative number is read as 0. An old daemon sends 0 and matches marks
  made at 0: today's behaviour. Based on: `apps/server/src/hub.ts` `acceptSessionAgents`,
  `markSessionSeen`.
- **D6 Clients do not change.** Their optimistic marks are dropped as soon as the terminal's
  entry is no longer a finished turn, which a daemon disconnect already causes (presence goes
  empty). Based on: `packages/client/src/store.ts` (the `sessionAgentsUpdated` reducer prunes
  `seenSessions`), `apps/ios/Coflux/Views/AppShell.swift` (`finishedTaskIDs`).

### Discussion log

1. After the persisted mark shipped, the owner asked to remove its known limit as well.
2. Departure check — direction as above (a moment, a new wire field, migration 15, old daemons
   compatible, clients unchanged); execution Subagent (opus); plain autopilot up to the pull
   request, without merge, deploy or release. No audit offered: top-tier orchestrator.
3. D2 and D3 `(decided while planning)`.

### Maintenance notes

- The moment is an identity. Do not order by it or show it: it is the daemon's clock.
- A runtime restart drops the record, so the entry reports no state and the centre clears the
  mark; that is the existing behaviour and stays.

## Execution brief

> Written for `subagent(opus)` at `1fc5d5e0`. Implement the tasks in order. Decide only what
> Your call leaves to you; on anything else that is unclear, stop and report.

### Goal

Give every agent presence entry the moment its current state was entered, and make the centre's
"seen" test require that moment to equal the one stored with the mark. Three layers: the
protocol (one additive field, regenerated for TypeScript, Rust and Swift), the Rust runtime
(stamp and report), the TypeScript centre (store and compare). Follow the neighbouring code;
comments in English. Run `cargo fmt` on Rust files you change. Do not run tests, type checks or
builds beyond the protocol code generation this brief asks for.

### Milestone 1: the protocol carries the moment

Depends on: none

#### T1 · `SessionAgentRef` has `state_since`

- Where: `proto/coflux/v1/common.proto` — `message SessionAgentRef`, after `bool seen = 8;`.
- Change: add `double state_since = 9;` with a comment: milliseconds since the epoch at which the
  entry's `state` was entered, on the daemon's clock; set by the daemon, copied by the centre;
  an identity for "the same turn", compared only for equality; 0 = not reported (older daemon).
  Then regenerate: `cd proto && buf generate` (buf is installed; `proto/buf.gen.yaml` writes
  `packages/protocol/src/gen`, `crates/protocol/src/gen` and
  `packages/swift-client/Sources/CofluxProtocol/Generated`). Commit the generated files.
- After: the three generated trees contain the field and nothing else changed in them. Every
  Rust struct literal of `SessionAgentRef` compiles: search all crates for
  `wire::SessionAgentRef {` and `SessionAgentRef {` and add `state_since: 0.0` where a literal
  lists the fields (`crates/runtime/src/observed.rs`, `crates/runtime/src/agents.rs`, tests
  included). TypeScript and Swift construct it through generated helpers; fix only what the
  search shows.

### Milestone 2: the runtime stamps and reports it

Depends on: Milestone 1

#### T2 · A record remembers when its state was entered

- Where: `crates/runtime/src/observed.rs` — `ObservedInner.program_status`,
  `apply_program_status`, `merge_annotations`.
- Change: keep, beside each session's record, the wall-clock millisecond at which its presence
  state was entered (D1). In `apply_program_status`: a session with no record takes the current
  time; a new record whose `program_presence_state` differs from the stored record's takes the
  current time; a new record with the same presence state keeps the stored moment (D2);
  forgetting the record forgets the moment. In `merge_annotations`, where `entry.state` is set
  from the record, set `entry.state_since` from it; entries without a record keep 0.
- After: `working → done` yields a new moment for `done`; repeating `done`, or changing only its
  message, leaves the moment as it was; `done → working → done` yields two different moments for
  the two `done` states. Add unit tests for those three cases next to the existing
  `program_status_record_*` tests; make the moment observable without sleeping (for example by
  letting the tests supply the clock) — do not write tests that depend on real time passing.
- Don't: stamp in `sessiond.rs` (D3); use a counter (D1).

### Milestone 3: the centre stores and compares it

Depends on: Milestone 1

#### T3 · Migration 15 adds the column

- Where: `apps/server/src/infra/database/schema-migrations.ts` — after `AGENT_SEEN_SCHEMA_SQL`
  and the `version: 14` entry.
- Change: a schema constant with a doc comment in the neighbours' style and a `version: 15`
  entry that adds `state_since DOUBLE PRECISION NOT NULL DEFAULT 0` to `coflux.agent_seen`.
- After: existing rows read 0. Do not edit migration 14's SQL: its checksum is recorded.

#### T4 · The mark carries the moment

- Where: `apps/server/src/store.ts` — `AgentSeenMark`, `listAgentSeen`, `putAgentSeen`.
- Change: add `stateSince: number` to the type, read it and write it (insert and the
  `ON CONFLICT` update).
- After: rows come back camel-cased (`transform: postgres.camel`): read `row.stateSince`.
  Postgres returns `DOUBLE PRECISION` as a number here; keep it a number.

#### T5 · "Seen" requires the same moment

- Where: `apps/server/src/hub.ts` — `SessionAgentData`, `acceptSessionAgents`,
  `markSessionSeen`.
- Change: carry `stateSince` on `SessionAgentData`, taken from the daemon's entry and read as 0
  unless it is a finite number ≥ 0; include it in the `seen` test (`mark.stateSince ===
  stateSince`), in the `unchanged` comparison, and in the mark `markSessionSeen` records.
- After: a re-reported finished turn with the same session, agent session and moment is seen; the
  same with another moment is unseen and its mark is cleared; entries broadcast to clients carry
  the daemon's moment. The value is whatever the daemon sent — never the centre's clock.
- Don't: change the disconnect path, the load-at-start queueing, or any client.

Milestones 2 and 3 both depend on Milestone 1 and touch disjoint files; they may be done in
either order. Do them in one pass, not as separate packages.

### Your call

Names of the Rust and TypeScript fields and helpers beyond `state_since` / `stateSince`; how the
runtime stores the moment beside the record; how tests supply the clock; comment wording.

### Landmines

- `buf generate` runs with `clean: true`: it rewrites the three generated trees. If the diff
  shows changes unrelated to the new field (a different plugin version), stop and report rather
  than committing them.
- The store camel-cases column names; a snake-case read compiles and returns `undefined`.

### Scope

In scope:
- `proto/coflux/v1/common.proto`
- `packages/protocol/src/gen/**`, `crates/protocol/src/gen/**`, `packages/swift-client/Sources/CofluxProtocol/Generated/**` (generated)
- `crates/runtime/src/observed.rs`, and other `crates/**` files only to add the field to a struct literal
- `apps/server/src/infra/database/schema-migrations.ts`, `apps/server/src/store.ts`, `apps/server/src/hub.ts`

Out of scope:
- `crates/runtime/src/sessiond.rs` — the terminal's record stays clock-free (D3)
- `packages/client/**`, `apps/desktop/**`, `apps/ios/**`, `packages/swift-client/Sources/CofluxClientCore/**` — clients do not change (D6)
- `tests/**`, `docs/**`, release notes

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- `buf generate` cannot run, or changes generated code beyond the new field.
- Field number 9 on `SessionAgentRef` is taken.

## Verification

### Milestone validations

- Milestone 1: `cd proto && buf lint` -> exit 0; `buf generate` leaves `git status` clean
- Milestone 2: `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` -> all pass; `cargo build` with zero warnings
- Milestone 3: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint and generated-code consistency | `cd proto && buf lint && buf generate` then `git status --porcelain` | exit 0, nothing changed |
| Protocol breaking check | `node scripts/check-protocol-breaking.mjs ".git#ref=1fc5d5e0,subdir=proto"` from `proto/` as CI does | exit 0 |
| Rust tests | the `cargo test` above | all pass |
| Rust build | `cargo build -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` | zero warnings |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Black-box suite (acceptance) | `pnpm -C tests test` with a clean environment | all pass |
| Turn identity (acceptance) | a one-off script on the test harness: mark a finished turn seen, stop the centre, run `working` then `done` in the terminal while it is down, start the centre | the entry comes back `seen: false`; a restart without a new turn keeps `seen: true` |

### Done criteria

- [ ] All listed commands pass, or the report says exactly which could not run and why.
- [ ] Every task's `After` state holds.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Migration 15 is one-way: back up the centre database before deploying; do not roll back past it.
- Order: deploy the centre first, then cut a desktop-line `v*` release — the runtime changed, and
  the centre pushes the new runtime to launcher daemons. An old runtime against the new centre
  and a new runtime against the old centre both behave as before the change (the field is
  additive and reads 0 when absent).
- The fix is complete on a device only once its runtime is the released one.
- iOS and desktop receive regenerated protocol code only; neither needs a release for this.

## Outcome

- Status: APPROVE — 2026-11-15
- Mode: subagent(opus); no revision round
- Commits: `92580310..553f6d80`
- Deviations: none. Generated side effect accepted: prost drops `Eq` and `Hash` from `SessionAgentRef` because the new field is an `f64`; nothing used them.
- Verification: buf lint, regeneration leaves the tree clean, protocol breaking check; Rust tests all pass (runtime 349 incl. three new stamping tests, protocol 34, cli 57, ptyd 14, launcher 9); zero-warning build; server and desktop typecheck; black-box suite 95/95 (first attempt failed fetching Ghostty sources from GitHub, the rerun passed); one-off acceptance on the test harness 4/4 — a finished turn reports its moment, a centre restart with no new turn keeps it seen, and a whole turn run while the centre was down comes back unseen with another moment.
- Follow-ups: none.
