# Plan 20261111-agent-seen-sync: a finished turn looked at on one device stops the confetti everywhere

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat c4c8da1a..HEAD -- proto apps/server/src/hub.ts packages/client/src/store.ts packages/swift-client/Sources apps/desktop/src/renderer/components/workbench apps/ios/Coflux/Views`

## Status

- Priority: P2
- Effort: M
- Risk: MED (protocol addition, centre deploy)
- Depends on: none
- Category: feature
- Execution: subagent(opus) — orchestrator's choice for a direct user request ("是不是可以优化一波"), same mode as the two previous sidebar plans
- Stop after: implementation
- Plan review: none
- Workspace: current — `.claude/worktrees/20261111-sidebar-agent-glyph`, branch `dev/20261111-agent-seen-sync` cut from `origin/main` (`c4c8da1a`)
- Planned at: `c4c8da1a`, 2026-11-11

## Record

### Requirement

When an agent finishes its turn, Clawd throws confetti on the terminal tab, on the desktop sidebar's
「当前」 row and on the iOS app's tabs and home rows, until the user has looked at that terminal. "Looked
at" is tracked only on the device itself (desktop: a per-workspace set in `workspace-terminal.tsx`
and another in the sidebar; iOS: `SceneNavigation.seenFinishedTaskIDs`). The user's report: a
terminal looked at on the computer still throws confetti on the phone. Looking on any device must
count as looked at on all of them.

### Decisions & tradeoffs

- **D1 · The centre owns "seen", in memory, on the presence entry.** A new `bool seen` on
  `SessionAgentRef`, set only by the centre when it fans presence out; a new client message
  `SessionSeen { session_id }`. The centre already validates and mirrors presence in memory per
  daemon (`hub.ts` `acceptSessionAgents`), so the mark lives next to it and is broadcast with it.
  Rejected: persisting (presence itself is in-memory; a centre restart re-throwing confetti once is
  harmless); a daemon-side mark (needs a runtime change and every device updated, for no gain);
  tying it to the notification inbox's read state (completion does not create notifications).
- **D2 · The mark belongs to one finished turn.** It holds while the daemon keeps reporting
  `done`/`waiting` for that session and is dropped the moment the reported state is anything else,
  the entry disappears, the `agent_session_id` changes, or the daemon disconnects. A `SessionSeen`
  for a session not currently `done`/`waiting` (or not on the sender's account) is ignored.
- **D3 · Clients keep an optimistic local mark.** The moment a client decides a finished terminal is
  on screen it marks it locally and sends `SessionSeen`; display uses `entry.seen || local`. This
  keeps the instant feedback and makes a new client against an old centre behave exactly as today.
  The local mark follows the same reset rule (dropped when the agent is no longer finished).
- **D4 · Desktop: one tracker in the shared client store.** Replace the two render-time trackers
  (tab strip, sidebar) with a store-level optimistic set plus a `markSessionSeen` action in
  `packages/client`, and a single trigger in the workbench: a finished terminal in `screen.visible`
  (each group's active task tab of the shown workspace; none while the changes overlay is open) is
  marked. Tabs and sidebar read one `seen` derived value.
- **D5 · Additive protocol change** (new field, new oneof case): accepted by `buf breaking`, no
  `CONTROL_PROTOCOL_VERSION` bump. An old centre ignores the unknown client message. Deploy order:
  centre first, then the desktop release; iOS ships on its own line.

### Discussion log

- User (2026-11-11): 「撒花这个似乎是一个只存在本地的状态, 导致我在电脑上看过的, 手机上还在撒花. 是不是可以优化一波」.
- Orchestrator proposed centre-owned seen + local optimistic mark (D1, D3); technical choice made by the
  orchestrator per standing preference (technical forks are not put to the user).

## Execution brief

> Written for `subagent(opus)` at `c4c8da1a`. Implement the milestones in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

"Seen" for a finished agent turn becomes account-wide: the centre keeps a per-session mark on the
presence entry it broadcasts, any client can set it, and desktop and iOS show confetti only while
neither the centre's mark nor the client's own optimistic mark is set.

Conventions: proto comments explain the contract; generated code comes only from `buf generate`
run in `proto/` (outputs TS `packages/protocol/src/gen`, Rust `crates/protocol/src/gen`, Swift
`packages/swift-client/Sources/CofluxProtocol/Generated`) and is committed. Code comments English.
TS style as in the surrounding files; Swift style as in the surrounding files.

### Milestone 1: Protocol

#### T1 · `seen` on presence, `SessionSeen` from clients

- Where: `proto/coflux/v1/common.proto` — `message SessionAgentRef` (after `string agent_session_id = 7;`);
  `proto/coflux/v1/client.proto` — the client oneof ending `SpeechRefineCredentialsGet speech_refine_credentials_get = 57;`.
- Change: add `bool seen = 8;` to `SessionAgentRef` with a comment: set only by the centre on
  fan-out; true once any client of the account reported this finished turn as looked at; daemons
  never set it and the centre ignores it on input. Add `SessionSeen session_seen = 58;` and
  `message SessionSeen { string session_id = 1; }` (comment: a client had this terminal's finished
  turn on screen; fire-and-forget, no reply). Run `buf generate` in `proto/` and commit the outputs.
- After: TS, Rust and Swift generated code contain the new field and message. No hand edits in generated dirs.

### Milestone 2: Centre

#### T2 · Hold, apply and reset the mark

- Where: `apps/server/src/hub.ts` — `private sessionAgents = new Map<…>`, the presence handler
  that builds `valid.push({ sessionId: entry.sessionId, … agentSessionId })` and broadcasts
  `sessionAgentsUpdated`, the daemon-disconnect branch `if (this.sessionAgents.delete(daemonId))`,
  the subscribe replay `for (const [daemonId, entry] of this.sessionAgents)`, and
  `async handleClientMessage(client: ClientConn, msg: ClientToServer)`'s switch (add a case beside
  `case "notificationRead":`).
- Change:
  - Every stored and broadcast entry carries `seen`. When a daemon report arrives, an entry's `seen`
    is carried over from the previous stored entry for the same `sessionId` only if the previous
    entry was seen, the new state is `done` or `waiting`, and `agentSessionId` is unchanged;
    otherwise `false`. The daemon's own `seen` value is ignored. (D2)
  - The "unchanged → return" comparison includes `seen`.
  - `case "sessionSeen"`: requires an authenticated client; finds the stored entry for that
    `sessionId` among the client's account's daemons; if found, its state is `done` or `waiting`
    and it is not yet seen, set `seen = true` and broadcast that daemon's `sessionAgentsUpdated`
    exactly like a daemon report would. Otherwise do nothing. No reply. (D1, D2)
  - Daemon disconnect keeps dropping the whole entry set (so the marks go too).
- After: a done entry reported again by the daemon keeps its mark; an `active` report clears it;
  a `sessionSeen` from another account or for an active session changes nothing.
- Don't: persist anything; touch the daemon/runtime code.

### Milestone 3: Desktop

#### T3 · Shared client store: seen state and `markSessionSeen`

- Where: `packages/client/src/store.ts` — `export type SessionAgentState`, `case "sessionAgentsUpdated":`,
  the client API object where `send({ case: "projectSetArchived", … })` lives.
- Change: `SessionAgentState` gains `seen: boolean` from the wire (`session.seen ?? false`). Add an
  optimistic local set in state (for example `seenSessions: ReadonlySet<string>`) and an API method
  `markSessionSeen(sessionId)` that, when the session's entry is `done`/`waiting` and neither the
  entry nor the local set marks it, adds it to the local set and sends `{ case: "sessionSeen", value: { sessionId } }`.
  On every `sessionAgentsUpdated`, drop from the local set any session of that daemon whose entry
  is gone or no longer `done`/`waiting`. Export a pure helper `isTurnSeen(entry, seenSessions, sessionId)`
  (or equivalent) = `entry.seen || seenSessions.has(sessionId)`. (D3)
- After: a unit test (in the package's existing test setup, if `packages/client` has one; otherwise
  next to the desktop module that uses it) covers: mark → local seen + one message sent; a second
  mark sends nothing; an `active` report clears the local mark; wire `seen: true` reads as seen.

#### T4 · One trigger, two readers

- Where: `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx` — `const [seenDone, setSeenDone]`,
  the render-time block commented `// Which finished agents have been seen, as of this render`, `tabSeenDone`;
  `sidebar.tsx` — the block commented `// Which finished turns have been seen, by the tab's rule`,
  `seen={seenNext.has(row.task.sessionId ?? "")}`, and the `visibleTaskIds` prop;
  `workbench.tsx` — `const screen = screenOf(activeWorkspaceId, changesOpen, renderLayouts);` and `visibleTaskIds={screen.visible}` passed to `<Sidebar`.
- Change: delete both render-time trackers. In the workbench, an effect over `screen.visible` and
  the store's presence calls `client.markSessionSeen(sessionId)` for each visible task whose
  session entry is `done`/`waiting` and not yet seen. Tabs and sidebar rows compute `seen` from the
  store (`isTurnSeen`) and pass it to `AgentGlyph`. Remove the sidebar's `visibleTaskIds` prop if
  nothing else needs it. (D4)
- After: behaviour on one desktop is unchanged (confetti stops when the finished terminal is on
  screen, both in the tab and in the sidebar row, and returns on the next finished turn); a
  terminal looked at on another device stops throwing confetti here once the centre broadcasts.

### Milestone 4: iOS

#### T5 · Swift client and the app

- Where: `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift` — `struct SessionAgentInfo`,
  `case .sessionAgentsUpdated(let value):`, `public func sendWorkbenchCommand`; `apps/ios/Coflux/Views/WorkspaceDetailView.swift` —
  `private func updateSeenFinished()`, `ClawdPose(state: agent?.state ?? "", seen: navigation.seenFinishedTaskIDs.contains(task.id))`;
  `apps/ios/Coflux/Views/HomeComponents.swift` — `let seen = activity.taskID.map { navigation.seenFinishedTaskIDs.contains($0) } ?? false`;
  `apps/ios/Coflux/Views/AppShell.swift` — the `.onChange(of: finishedTaskIDs)` pruning;
  `apps/ios/Coflux/Views/SceneNavigation.swift` — `var seenFinishedTaskIDs`.
- Change: add a client method `markSessionSeen(sessionID:)` that sends `SessionSeen`. When
  `updateSeenFinished` inserts a task into `seenFinishedTaskIDs`, also send it for that task's
  session. Every place that decides `seen` for a pose uses `session.seen || seenFinishedTaskIDs.contains(taskID)`
  (a small helper on the client or the navigation, your call). The local set stays as the
  optimistic mark with its existing pruning. (D3)
- After: confetti on iOS stops when the centre says seen, even if the phone never showed that terminal;
  a Swift client test (`packages/swift-client/Tests/CofluxClientCoreTests/ReducerTests.swift` style)
  asserts that a `sessionAgentsUpdated` with `seen = true` is visible on `sessionAgents[...].session.seen`.

### Your call

- Names of the store field, helper and methods; whether the desktop local set lives in the store state or a module-level structure inside the store factory.
- Exact effect shape for the desktop trigger, as long as it fires on visibility and presence changes and sends at most once per finished turn.

### Landmines

- `acceptSessionAgents`'s "unchanged" early return must compare `seen`, or a mark never broadcasts after a carry-over change.
- The desktop store batches bursts of messages into one write (`// 同一轮消息突发` in `store.ts`); keep the local-set pruning inside the same `setState` as the presence replacement.
- Do not edit generated files by hand; regenerate. CI checks generated output has zero diff.
- iOS builds only for a device (the simulator cannot link Tailcat); do not try to build or run it.

### Scope

In scope: `proto/coflux/v1/common.proto`, `proto/coflux/v1/client.proto`, generated outputs under
`packages/protocol/src/gen`, `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`;
`apps/server/src/hub.ts`; `packages/client/src/store.ts` (+ a test file); desktop
`workspace-terminal.tsx`, `sidebar.tsx`, `workbench.tsx`; `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift`,
`packages/swift-client/Tests/CofluxClientCoreTests/ReducerTests.swift`; iOS `WorkspaceDetailView.swift`,
`HomeComponents.swift`, `AppShell.swift`, `SceneNavigation.swift`.

Out of scope: `crates/**` source other than generated code; `apps/server` beyond `hub.ts`; tests/ black-box suite; notifications.

### Stop and report if

- A task's anchor is missing or differs from the description.
- `buf generate` is unavailable or produces changes beyond the new field/message.
- A task needs a file outside scope.

## Verification

### Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Proto | `cd proto && buf lint && buf breaking --against '../.git#branch=main,subdir=proto'` (or the CI form) and `buf generate` zero diff | exit 0, clean |
| Server | `pnpm -C apps/server typecheck` (or its tsc script) | exit 0 |
| Client + desktop | `pnpm -C packages/client test` if present; `pnpm -C apps/desktop typecheck && lint && test && build` | exit 0 |
| Rust | `cargo build -p coflux-protocol` (generated code compiles) | exit 0 |
| Swift | `swift test` in `packages/swift-client` | green |
| iOS | device build per `apps/ios` docs | BUILD SUCCEEDED |
| Walkthrough | user | finish a turn, look on desktop → phone confetti stops |

### Merge and deploy

Centre first (hub change only, no migration), then desktop `v2.26.1` (also ships #136's agent
glyph rows), then an `ios-<N>` tag.
