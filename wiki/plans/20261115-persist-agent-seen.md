# Plan 20261115-persist-agent-seen: a finished turn stays "seen" across daemon reconnects and centre restarts

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ed90eb1d..HEAD -- apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts`

## Status

- Priority: P2
- Effort: S
- Risk: MED
- Depends on: none
- Category: bug
- Execution: self — departure check (2026-11-15)
- Stop after: implementation — departure check, plain autopilot
- Plan review: none — the orchestrator is already on the top tier, so the audit was not offered
- Workspace: isolated — cut from the main worktree as `dev/20261115-persist-agent-seen`
- Planned at: `ed90eb1d`, 2026-11-15

## Record

### Requirement

Plan `20261111-agent-seen-sync` made "this finished turn has been looked at" an account-wide
mark held by the centre, so Clawd stops throwing confetti on every client once one client has had
the terminal on screen. The centre holds the mark only in memory, on the device's presence entry.
It is therefore lost whenever the centre restarts and whenever the device's daemon disconnects —
the centre drops the whole presence entry on disconnect, and the entries the daemon reports after
reconnecting start unmarked. Clients also keep an optimistic mark in memory, which hides the loss
until the app is relaunched; the owner saw every finished terminal throw confetti again after a
fresh install of the iOS app.

Once this is done: a finished turn marked seen stays seen across a daemon reconnect and a centre
restart, on every client, until the agent starts another turn, a different agent session takes
over the terminal, or the terminal is deleted. The wire protocol, the daemon and all clients are
unchanged; only the centre changes.

Known limit, accepted: presence carries no turn identifier. If a seen terminal's agent runs a
whole further turn while the daemon is disconnected from the centre — the centre never sees an
unfinished state in between — the new finished turn is taken for the old one and shows as seen.

### Decisions & tradeoffs

- **D1 The mark is a row, one per terminal.** A new table keyed by task id holds the terminal
  session id, the agent session id at the time of marking, the account and the time. Deleting
  the task deletes the row through the foreign key. Rejected: a column on `session_checkpoints`
  — that table is a prunable cache (`pruneSessionCheckpoints`), so marks would vanish with it.
  Rejected: keying by session id — a restarted terminal would leave rows behind with nothing to
  collect them. Based on: `apps/server/src/store.ts` `pruneSessionCheckpoints`;
  `schema-migrations.ts` migration 13 for the form.
- **D2 "Seen" is decided against the stored mark, not the previous presence entry.** An entry is
  seen exactly when a mark exists for its task, the mark's session id and agent session id equal
  the entry's, and the entry's state is a finished one. A report for a marked task that fails
  that test — an unfinished state, another session, another agent session — deletes the mark.
  Rejected: keeping the carry-over from the previous in-memory entry and adding the table as a
  second source — two rules for one fact. Based on: `hub.ts` `acceptSessionAgents`, the line
  computing `seen` from `before`.
- **D3 The centre reads all marks once, at start, and answers from memory.** Presence reports are
  handled synchronously and in order; a database read per report would reorder them. Reports
  that arrive before the read finishes wait for it, in order; after it, handling is synchronous
  as today. Rejected: a query inside `acceptSessionAgents`. Based on: `hub.ts`
  `case "sessionAgents"` calls it synchronously.
- **D4 Writes are best-effort and ordered.** Marking and clearing update memory at once and write
  the row afterwards through one serial queue, so a clear can never land before the mark it
  follows; a failed write is logged and the broadcast still happens. Rejected: awaiting the
  write before broadcasting — `SessionSeen` is fire-and-forget and the mark is a convenience.
- **D5 A daemon disconnect clears presence but not marks.** The existing clear-and-broadcast on
  disconnect stays (plan 073: no stale waiting dots); the marks survive it and are applied to
  the next report. Based on: `hub.ts`, the block commented `agent presence 是在线连接的派生事实`.
- **D6 Migration 14 is one-way,** like its predecessors: a server older than it refuses the
  migrated database. Based on: `schema-migrations.ts`, the ledger check.
- **D7 No turn identifier is added.** The known limit above is accepted for now. Rejected: a
  per-turn counter reported by the daemon — a protocol and runtime change out of proportion to
  the case. Based on: the departure check.
- **D8 No new automated test** `(decided while planning)`. The break is visible while using the
  product (confetti returns after a reconnect); the repository keeps tests only for breaks that
  are not (AGENTS.md, "Test harness"). Verified by a one-off run against a local stack.

### Discussion log

1. The owner asked why every terminal threw confetti after a fresh iOS install, believing the
   state had moved to the server and been persisted. Finding: the centre holds it in memory only.
2. The owner asked for a new plan that persists the mark.
3. Departure check — direction as above including the known limit; execution Self; plain
   autopilot, deployment not included. No audit offered: top-tier orchestrator.
4. D1's key (task, not session), D3, D4 and D8 `(decided while planning)`.

### Maintenance notes

- A turn identifier in presence would remove the known limit; it belongs with the next protocol
  change to `SessionAgentRef`.
- The in-memory marks are the read path; the table is only read at start. Anything that deletes
  tasks outside the hub leaves a harmless stale entry in memory until the next restart.

## Execution brief

> Written for `self` at `ed90eb1d`. Implement the tasks in order. Decide only what Your call
> leaves to you; on anything else that is unclear, stop and report.

### Goal

Persist the centre's account-wide "seen" mark for finished agent turns so it survives daemon
reconnects and centre restarts. Centre only (`apps/server`): one migration, store accessors, and
the hub's presence handling. TypeScript, comments in English, follow the neighbouring code.

### Milestone 1: the mark is stored and decides "seen"

Depends on: none

#### T1 · Migration 14 creates the table

- Where: `apps/server/src/infra/database/schema-migrations.ts` — after
  `ACCOUNT_SPEECH_REFINE_SCHEMA_SQL` and the `version: 13` entry of `MIGRATIONS`.
- Change: add a schema constant with a doc comment in the style of its neighbours (what it
  holds, that it is one-way) and a `version: 14` entry (D1, D6).
- After: a table with the task id as primary key referencing the tasks table with
  `ON DELETE CASCADE`, the account id, the session id, the agent session id (empty allowed) and
  the time of marking. Check how `tasks` is keyed before writing the reference.

#### T2 · Store accessors

- Where: `apps/server/src/store.ts` — beside `removeSessionCheckpointsByTask`.
- Change: list every mark; upsert one by task; delete one by task.
- After: three small methods; the upsert replaces the row for the task.

#### T3 · The hub answers from the marks

- Where: `apps/server/src/hub.ts` — `acceptSessionAgents`, `markSessionSeen`,
  `case "sessionAgents"`, the constructor, and the field list near `private sessionAgents`.
- Change: hold the marks in a map by task id, filled once from the store when the hub is
  constructed (D3). In `acceptSessionAgents` compute `seen` by D2 in place of the `before`-based
  line, and delete the mark of any reported task that fails the test. In `markSessionSeen`,
  after the existing guards, record the mark (D4) along with the existing in-memory update and
  broadcast. Until the initial read finishes, queue `sessionAgents` reports behind it, in order,
  re-checking that the connection is still the daemon's current one when they run; if the read
  fails, log it and carry on with no marks.
- After: after a daemon reconnect, or a centre restart, a re-reported finished turn with the same
  session and agent session comes out with `seen: true`; a report with any other state, session
  or agent session comes out unseen and the row is gone. The `unchanged` comparison and every
  broadcast are as before. The disconnect path is untouched (D5).
- Don't: read the database inside `acceptSessionAgents` (D3); await a write before broadcasting
  (D4); change `SessionAgentRef`, the daemon or any client (D7).

### Your call

Table and method names; the queue's form; whether hub paths that delete a task also drop its
in-memory mark; log wording.

### Scope

In scope:
- `apps/server/src/infra/database/schema-migrations.ts`
- `apps/server/src/store.ts`
- `apps/server/src/hub.ts`

Out of scope:
- `crates/**`, `packages/**`, `apps/desktop/**`, `apps/ios/**` — no protocol, daemon or client change
- `docs/**` release notes — written at release time

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- `tasks` cannot be referenced by a single-column foreign key and no existing unique key fits.

## Verification

### Milestone validations

- Milestone 1: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Black-box suite (acceptance) | `pnpm -C tests test` | all pass — a fresh database runs migration 14 |
| Persistence (acceptance) | a one-off script on the test harness: mark a finished turn seen, restart the daemon's connection, and read the presence a client receives | the entry comes back `seen: true`; after a new turn it is unseen |

### Done criteria

- [ ] All listed commands pass, or the report says exactly which acceptance could not run and why.
- [ ] Every task's `After` state holds.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

Centre only. Migration 14 is one-way: take the usual pre-deploy database backup, and do not roll
the server back past it. No desktop, daemon or iOS release is needed; the fix takes effect when
the centre is deployed. Marks made before the deploy are not recovered (they were never stored).

## Outcome

- Status: COMPLETE — 2026-11-15
- Mode: self
- Commits: `384e65c4..a85b59d4`
- Deviations: none. Hub paths that delete a task do not drop its in-memory mark; the row goes through the foreign key and the stale entry is harmless until the next start.
- Verification: server typecheck green; black-box suite 95/95 on a fresh database (migration 14 applied) — run before the one-line read fix `a85b59d4`, not rerun after it; one-off acceptance on the test harness, run after the fix, 5/5: a finished turn starts unseen, a client marks it, it is still seen after a centre restart on the same database with the daemon reconnecting, a new turn clears it, and it stays cleared after another restart. The acceptance run caught a real defect the typecheck could not: the store camel-cases column names, so the first read of the table returned nothing usable.
- Follow-ups: a turn identifier in presence, to close the known limit (a whole turn run while the daemon is disconnected is taken for the seen one). The centre must be deployed for the fix to take effect; not deployed here.
