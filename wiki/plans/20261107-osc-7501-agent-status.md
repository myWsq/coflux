# Plan 20261107-osc-7501-agent-status: Agents report their own status through OSC 7501

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat afe5a152..HEAD -- crates/runtime/src/sessiond.rs crates/runtime/src/sessions.rs crates/runtime/src/sessiond_ipc.rs crates/runtime/src/observed.rs crates/runtime/src/main.rs crates/runtime/src/agents.rs apps/server/src/hub.ts packages/client/src/store.ts apps/desktop/src/renderer/components/workbench`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check 2026-11-07
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (the audit was recommended; the user chose plain autopilot)
- Workspace: isolated — planning moved the session from the main worktree to `.claude/worktrees/20261107-osc-7501-agent-status` on `dev/20261107-osc-7501-agent-status`
- Planned at: `afe5a152`, 2026-11-07

## Record

### Requirement

Coflux only knows a terminal runs an agent when a process in its tree is literally named
`claude` or `codex`, and only knows the agent's turn state when the Claude plugin's hooks
(or Codex hooks) post to the runtime. Every other agent — pi, Grok Build, Crush, OpenCode,
Docker Agent — is invisible, and adding one means a release.

The Program Status Protocol (OSC 7501, proposed by Ghostty's author; spec at
<https://www.superlogical.com/rex/docs/build/program-status>) lets a program say in-band
what it is doing: `idle`, `working`, `done`, `blocked` (with `kind` permission / question /
auth) or `error`, plus an `app` identifier and a one-line `msg`. Claude Code ≥ 2.1.295,
pi ≥ 1.1.0, Grok Build, Crush and recent Codex builds emit it. Claude Code only emits after
the terminal answers its `OSC 7501 ; ?` probe within about two seconds, so a terminal that
does not answer the probe never receives status from it.

Once done, any program that reports OSC 7501 in a coflux terminal appears as an agent in
the desktop sidebar, tab strip, ⌘P palette and desktop notifications, with no per-agent
code. Product conclusions, confirmed by the user:

1. **Who counts as an agent**: any program that reports an OSC 7501 root record. Its name
   is the report's `app`: `claude-code` is shown as `claude` (keeps the Clawd glyph),
   `codex` keeps the Codex logo, anything else shows the generic robot glyph. Process-name
   detection stays as the fallback for agents that do not report.
2. **States**: `working` → 执行中; `blocked` with kind `permission`, `auth` or no kind →
   等待批准; `blocked` with kind `question` → 等待回答; `done` → 本轮完成; `error` → a new
   state 「出错停止」 shown in red and raising a desktop notification like the two waiting
   states; `idle` → the agent is listed but shows no state indicator. When several
   terminals of a workspace disagree, the workspace shows the first of: 等待批准 > 等待回答
   > 出错停止 > 执行中 > 本轮完成.
3. **Message**: the report's `msg` is the one-line text under the sidebar entry and the
   notification body for the waiting and error states.
4. **Lifetime**: the agent disappears when its program exits back to a coflux shell prompt,
   on a hard terminal reset, on `state=clear`, or when the terminal ends.
5. **Probe and precedence**: coflux answers the `OSC 7501 ; ?` probe so reporting turns on.
   While a terminal has a 7501 root record, that record decides its state; hook-reported
   state is the fallback, and hooks keep supplying the agent's own session id (used for the
   transcript paper view).

Non-goals: child records (reports with an `id`), progress percentages, and any iOS change
(iOS does not consume agent state).

Amended after the first implementation (D13): turn state comes **only** from OSC 7501. The
hooks stop reporting state; they keep supplying the agent's own session id and their
non-status jobs (session context, workspace following, the worktree guard). Agents that do
not emit 7501 — Claude Code below 2.1.295, Codex builds without it — still appear through
process detection but show no state. The user accepted that explicitly.

Observable when done: Claude Code ≥ 2.1.295 in a coflux terminal with the plugin's hooks
disabled still shows correct states; pi shows 「pi 正在执行」;
`printf '\e]7501;state=error:app=demo:msg=Ym9vbQ==\e\\'; sleep 60` shows 「demo 出错停止」
with "boom" under it and raises a notification; pressing Ctrl-C back to the prompt removes it.

### Decisions & tradeoffs

- **D1 Capture point**: OSC 7501 is recognised by sessiond's `OutputScanner` on the thread
  that feeds PTY output, next to OSC 0/2/133, and the record lives in `TerminalState`.
  Rejected: libghostty's `Terminal::on_program_status` callback in the VT thread — sessiond
  never asks the VT thread anything while feeding and registers no reply-producing callback,
  so status would need a new asynchronous return path out of that thread. Based on:
  `crates/runtime/src/sessiond/vt.rs` module header ("no reply-producing callback is
  registered"); `TerminalState::feed` doc ("title, marks, DA1 queries and the checkpoint
  boundary come from the scanner on this thread").
- **D2 Parser**: either libghostty's standalone `libghostty_vt::osc::Parser` (pinned
  libghostty-rs `9ede35b` knows `PROGRAM_STATUS`), if it can live in the scanner without
  breaking `Send` or the scanner's byte-at-a-time model, or a small parser written to the
  spec. Delegated to the executor (Your call). Either way the accepted input is the spec's:
  `key=value` pairs separated by `:`, `state` required (missing or unknown → report
  dropped), unknown keys ignored, last duplicate wins, `msg`/`title` base64 UTF-8.
- **D3 Root record only**: only reports with no `id` (or an empty one) create or replace the
  record. Reports with a non-empty `id` are ignored, except that `state=clear` with no id
  removes the record. Rejected: tracking the record tree — child records are a non-goal and
  the presence entry has one state. Based on: product non-goals.
- **D4 State mapping**, applied where the record becomes a presence entry:
  `working`→`active`; `blocked`+`permission`/`auth`/no kind→`approval`;
  `blocked`+`question`→`question`; `done`→`done`; `error`→`error`; `idle`→`""`.
  `message` is the decoded `msg` for `blocked` and `error` and empty otherwise. Based on:
  product conclusions 2 and 3.
- **D5 Probe answer**: sessiond answers every live `OSC 7501 ; ?` itself, whoever holds the
  terminal, with exactly
  `ESC ] 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth`
  followed by the terminator the query used (BEL or `ESC \`). The reply goes through the
  same ordered reply path as sessiond's DA1 answer; replies from one feed keep output order,
  so a probe followed by `CSI c` is answered before the DA1 reply sessiond writes. A probe
  answer does not move `answered_query_seq`. Re-fed history is never answered. Rejected:
  answering only when no human client receives raw bytes (the DA1 rule) — xterm.js never
  answers 7501, so that rule would leave the probe unanswered whenever a human is attached.
  Based on: `SessionState::feed` DA1 logic; spec feature-detection section; Claude Code's
  probe-gated emission.
- **D6 Upward path mirrors the title**: a status change becomes a new `SessiondEvent`
  pushed by the same code that pushes `SessionTitle`, recorded per session in
  `ObservedState`, and reported at once through `report_agents_if_changed`. Rejected:
  waiting for the 2-second periodic agent scan — `blocked` must surface promptly.
  Based on: `sessions.rs` "Same for the OSC title" block; `main.rs` hook path calling
  `report_agents_if_changed` right after `apply_hook_state`.
- **D7 Presence and precedence**: the reported agent list is the union of process-detected
  sessions and alive sessions holding a 7501 root record. For a session with a root record,
  the record decides `state`, `message` and `agent`; hook-reported state and message are
  ignored for it but still kept, so they apply again once the record is gone. Hooks still
  supply `agent_session_id`; `progress` is unchanged. Rejected: last-writer-wins between the
  two sources — hooks travel a separate HTTP path and can arrive after a newer in-band
  report. Based on: `observed.rs` `merge_annotations`; product conclusion 5.
- **D8 Agent name**: `app` is untrusted PTY input: keep it only if non-empty after removing
  control characters, and clamp it to 32 bytes on a character boundary. `claude-code` →
  `claude`; any other value passes through unchanged. Empty → the process-detected name for
  that session, else `agent`.
- **D9 Clearing**: the record is removed by an accepted coflux `133;A` mark
  (`Mark::PromptStart`, which carries the session secret), by RIS (`ESC c`), by
  `state=clear` without an id, and by the session ending. A soft reset and switching
  screens do not clear it. Rejected: also clearing on unauthenticated `133;A` — any program
  can print that, which is why coflux marks carry a secret. Based on: `Mark` enum doc;
  spec reset section; product conclusion 4.
- **D10 Not checkpointed**: the record is not written into sessiond checkpoints. After a
  runtime hot upgrade it is recovered only from ring bytes fed after the checkpoint, and the
  rebuild pushes whatever record it recovered once. Rejected: a new checkpoint field — a
  blob format change for state that hooks already lose across an upgrade today. Based on:
  `TerminalState::restore`; hook state lives only in `ObservedState` memory.
- **D11 Wire**: no protocol change. `SessionAgentRef.state` is already a free string; it
  gains the value `error`. The server's state allowlist must accept `error`, because a
  report with an unknown state is dropped whole — every agent of the device would vanish.
  Based on: `apps/server/src/hub.ts` `AGENT_STATES` and its comment
  ("名单外的按畸形消息整条丢弃").
- **D12 Desktop**: `error` is a first-class activity in the client store, sidebar, tab glyph,
  ⌘P palette and desktop attention, in red (`text-destructive`, the existing red token), and
  ranks between question and active everywhere states are ranked. `message` is carried and
  shown for approval and error as well as question. Based on: product conclusions 2 and 3.
- **D13 Hooks carry no state** `(amended after implementation)`: supersedes D7's fallback.
  The runtime no longer maps hook events to turn states; `/hook` only records the agent's
  session id (and still refuses callers outside every session tree). The messengers send a
  body only when the payload carries a session id and no longer send notification type or
  background-task counts. Hook registrations whose only job was state are removed from the
  plugin and from the device-managed integration; registrations with another job stay, and
  the plugin gains the messenger on `SessionStart` so the session id arrives at once.
  Process detection stays, for presence, the agent name and the transcript button. Rejected:
  keeping hooks as a fallback — the user chose one source of truth and accepted that
  non-7501 agent versions show no state. Based on: Discussion log entry 8.

### Discussion log

1. After the herdr-core research the user asked to start item 1, OSC 7501 adoption.
2. Q: which terminals show an agent? Options: any 7501 reporter / only a known-agent list /
   7501 refines state of process-detected agents only. Answer: **any 7501 reporter**
   (recommended). Settled conclusion 1.
3. Q: how to show `error` and `blocked` kinds beyond today's four states? Options: new
   「出错」 state with notification / fold into existing states (error as done) / new state
   without notification. Answer: **new 「出错」 state with notification** (recommended).
   Settled conclusion 2.
4. The user asked whether 7501 removes the need for hooks. Answer given: for turn state yes,
   but hooks still carry the agent's session id, cover older or disabled Claude Code and
   Codex stable (0.162.1, no 7501 yet), and the plugin's other hooks are unrelated. Settled
   conclusion 5 and the non-goal "retiring the hooks".
5. Product confirmation of conclusions 1–5, non-goals and acceptance: **confirmed**.
6. Departure check: execution **subagent(opus)** (recommended); autopilot **plain, no plan
   audit** (the audit was recommended).
7. `(decided while planning)` D2 parser choice delegated; D3 root-only; D5 probe answer
   does not move `answered_query_seq` and is independent of the holder; D8 clamp of 32 bytes;
   D10 no checkpoint field.
8. After the first implementation was approved, the user asked to remove every state-related
   part of the hooks in this same change and rely on OSC 7501 alone, explicitly not caring
   about agent versions that do not emit it. Settled D13. Which registrations stay was
   decided while planning: plugin keeps `SessionStart` (context, plus the messenger for the
   session id), `UserPromptSubmit` (session-moved script), `PreToolUse` (worktree guard),
   `PostToolUse` EnterWorktree/ExitWorktree and `WorktreeRemove` (worktree following);
   the managed Claude integration keeps `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse`, `SessionEnd`, `WorktreeRemove`; managed Codex keeps `SessionStart`,
   `UserPromptSubmit`, `SessionEnd`.

### Maintenance notes

- Deploy order matters (D11): a runtime that sends `error` to a centre without it in the
  allowlist erases all agent presence of that device. Deploy the centre first.
- Shells without coflux shell integration (fish, anything not using the injected init)
  never send a secret-bearing `133;A`, so a `done` record lingers until the terminal ends.
  Accepted.
- When the hooks' state role is retired later, D7's fallback is what goes; the session-id
  hook stays.
- Proto comments on `SessionAgentRef.state` (`proto/coflux/v1/common.proto`) still list four
  states; updating them requires regenerating every generated tree, left for the next proto
  change.

## Execution brief

> Written for `subagent(opus)` at `afe5a152`. Implement the tasks in order. Decide only
> what Your call leaves to you; on anything else that is unclear, stop and report.

### Goal

Make OSC 7501 (Program Status Protocol) a source of agent presence. sessiond recognises
reports and the `OSC 7501 ; ?` probe in PTY output, answers the probe, keeps the root
record per session and pushes changes up; the runtime core merges records into the agent
presence it already reports; the server accepts a new state value `error`; the desktop
shows `error` as 「出错停止」.

Protocol essentials (spec: <https://www.superlogical.com/rex/docs/build/program-status>):
`OSC 7501 ; key=value:key=value ST`, ST is BEL or `ESC \`. Keys: `state` (required:
idle, working, done, blocked, error, clear — missing or unknown drops the report), `id`
(record path; absent/empty = root), `kind` (blocked only: permission, question, auth;
unknown = absent), `progress`, `app`, `title` (base64), `msg` (base64 UTF-8). Unknown keys
are ignored; a repeated key's last value wins; malformed pairs are skipped. Each report
replaces its record completely. The probe is `OSC 7501 ; ? ST`.

Conventions: comments in English; Rust formatted by `cargo fmt` on the files you change;
the desktop renderer follows `docs/design-guidelines.md`; keep sessiond's rule that the
feed thread never waits on the VT thread.

Milestones 1 → 2 are sequential (2 consumes the event 1 adds). Milestones 3 and 4 are
independent of each other and of 1–2: they only depend on the state string `error`.

### Milestone 1: sessiond recognises 7501, answers the probe and pushes the root record

Depends on: none

#### T1 · The scanner turns 7501 reports and probes into events, and RIS into a reset event

- Where: `crates/runtime/src/sessiond.rs` — `enum ScanEvent`, `OscCapture::put` (it decides
  `Wanted` only for `b"0" | b"2" | b"133"` and gives up once the number reaches 3 bytes),
  `OutputScanner::dispatch_osc`, and the `ScanState::Escape` arm of the scanner.
- Change: capture OSC `7501` payloads; turn a probe (`?` payload) into a probe event that
  remembers its terminator; turn a report into a parsed report event; add an event for RIS
  (`ESC c`). (D1, D2)
- After: feeding `\x1b]7501;state=blocked:kind=question:app=pi:msg=QXBwbHk/\x07` yields one
  report event with state blocked, kind question, app `pi`, message `Apply?`, no id; the
  same bytes fed one at a time yield the same; `\x1b]7501;?\x1b\\` yields a probe event with
  terminator ST and `\x1b]7501;?\x07` one with BEL; `\x1b]7501;app=x\x07` (no state) and
  `\x1b]7501;state=bogus\x07` yield nothing; `ESC c` yields the reset event; OSC 0/2/133
  behaviour, the DA1 recognition and `between_sequences` are unchanged (existing tests pass).
- Don't: register `on_program_status` or any other callback on the VT thread's `Terminal`
  (D1).

#### T2 · `TerminalState` holds the root record and knows when it changed

- Where: `crates/runtime/src/sessiond.rs` — `TerminalState` (fields, `new`, `restore`,
  `feed`), next to `title_changed` / `take_title_change`.
- Change: keep `Option<root record>` plus a changed flag; apply events in byte order within
  a feed: a root report replaces the record; `state=clear` with no id removes it; reports
  with a non-empty id are ignored (D3); an accepted `Mark::PromptStart` and the RIS event
  remove it (D9). Add `take_program_status_change()` returning the new value (record or
  "gone") once per change. Do not add the record to `Checkpoint` (D10).
- After: the record stored is the raw report facts (state, kind, app, message) — the D4
  mapping happens in the runtime core (T5), not here. Two identical consecutive reports
  produce one change. A `133;A` without the session secret leaves the record. Tests cover:
  report → change; identical repeat → no change; secret `133;A` clears; un-secret `133;A`
  doesn't; RIS clears; `state=clear:id=x` doesn't clear the root; `state=clear` does.

#### T3 · Probe answers join DA1 answers in output order

- Where: `crates/runtime/src/sessiond.rs` — `SessionState::feed` (the block that builds
  `self.query_replies = vec![DA1_REPLY.to_vec(); queries.len()]`), `TerminalState::feed`
  (`da1_queries`), `take_da1_queries`.
- Change: record queries in output order with their kind, and build `query_replies` in
  that order: every live 7501 probe gets the D5 reply regardless of holder; DA1 queries keep
  today's holder rule and today's `answered_query_seq` raise. (D5)
- After: exact reply bytes are
  `\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth`
  + `\x07` when the probe ended with BEL, + `\x1b\\` when it ended with ST. Tests:
  probe alone with no holder → one 7501 reply; probe with a human holder receiving raw →
  one 7501 reply and no DA1 reply for a following `CSI c`; probe then `CSI c` with no
  holder → `[7501 reply, DA1 reply]` in that order; a feed with only a probe leaves
  `answered_query_seq` unchanged.
- Don't: route the probe answer through libghostty's `on_pty_write` (D1).

#### T4 · sessiond pushes record changes, including after a rebuild

- Where: `crates/runtime/src/sessiond_ipc.rs` — `enum SessiondEvent` (next to
  `SessionTitle`); `crates/runtime/src/sessions.rs` — the live feed block with the comment
  "Same for the OSC title", and the rebuild path where
  `// Re-fed history was answered when it was live; never write a reply for it.` precedes
  `let _ = state.take_query_replies();`.
- Change: add a variant (e.g. `session.programStatus`) carrying `session_id` and the record
  or its absence; push it best-effort after a live feed when `take_program_status_change`
  yields; at the end of the rebuild, push the recovered record once if one exists (D10).
- After: the rebuild still writes no query replies; a rebuilt session holding a record
  produces exactly one push; a rebuilt session without one produces none.

### Milestone 2: the runtime core merges records into agent presence

Depends on: Milestone 1

#### T5 · `ObservedState` keeps one record per session and merges it per D4/D7/D8

- Where: `crates/runtime/src/observed.rs` — `ObservedInner`, the `apply_*` methods,
  `commit_agents`, `merge_annotations`; `crates/runtime/src/agents.rs` —
  `detect_session_agents` produces the process-detected list and `SessionAgentRef` shape.
- Change: add `apply_program_status(session_id, Option<record>)`; make the committed list
  the union of process-detected entries and alive sessions holding a record (task id from
  the alive snapshot), sorted by `session_id` as today; for a session with a record, set
  `state`/`message`/`agent` per D4 and D8 and skip hook state and hook message; keep
  `agent_session_id` and `progress` from hooks; prune records of sessions no longer alive.
  (D4, D7, D8)
- After: tests as input → expected: record `working`/`app=pi` on an alive session with no
  process match → entry `{agent:"pi", state:"active"}`; record `blocked`/kind `auth` →
  `approval`; `blocked`/`question` with msg "Apply?" → `question`, message "Apply?";
  `error` → `error`; `idle` → entry with state `""`; `app=claude-code` → agent `claude`;
  empty app on a process-detected `codex` session → `codex`; empty app, no process match →
  `agent`; hook state `approval` plus record `working` → `active`; record removed → hook
  `approval` shows again; `agent_session_id` from a hook survives alongside a record; a
  session leaving the alive set drops its record; a 40-byte app is clamped to 32 bytes.
- Don't: let hooks override a present record by arrival time (D7).

#### T6 · The event reaches `ObservedState` and is reported at once

- Where: `crates/runtime/src/main.rs` — the `match` with
  `SessiondEvent::SessionTitle { session_id, title } => {`; the hook path that calls
  `observed.apply_hook_state(...)` then `report_agents_if_changed(...)`; the session-exit
  handling.
- Change: handle the new variant by calling `apply_program_status` and then
  `report_agents_if_changed` the way the hook path does; on session exit, clear the
  session's record. (D6, D9)
- After: a 7501 report in a live terminal is reported to the server without waiting for the
  2-second scan; a session exit leaves no record behind.

### Milestone 3: the centre accepts `error`

Depends on: none

#### T7 · `error` is an allowed agent state

- Where: `apps/server/src/hub.ts` — `const AGENT_STATES = new Set([...])` and the field
  comment that lists `active / approval / question / done`.
- Change: add `"error"`; update both comments. (D11)
- After: a `SessionAgents` report containing `state: "error"` is accepted and broadcast like
  any other; other values outside the set are still rejected.

### Milestone 4: the desktop shows 「出错停止」

Depends on: none

#### T8 · The store aggregates `error` and carries messages for every waiting/error state

- Where: `packages/client/src/store.ts` — `export type WorkspaceActivity` and
  `export function workspaceActivity`.
- Change: add `{ status: "error"; agent: string; message?: string; taskId?: string }`;
  give `approval` a `message?` too; rank approval > question > error > active > done (D12).
- After: a workspace with one `error` and one `active` terminal → `error`; with `question`
  and `error` → `question`; `message` is the entry's non-empty message for approval,
  question and error.

#### T9 · Every surface that renders activity handles `error`

- Where (all under `apps/desktop/src/renderer/components/workbench/`):
  `sidebar.tsx` — `function activityLabel` and the block
  `{activity.status === "question" && activity.message ? (`;
  `pending-dots.tsx` — `export type ActivityDotsStatus` and `const STATES`;
  `workspace-terminal.tsx` — `function AgentGlyph`;
  `command-palette-data.ts` — `function agentActivityOf` and the ranking
  `entry.activity === "approval" ? 9 : ...`; `command-palette.tsx` — the label map with
  `approval: "等待批准"` and the `entry.activity === "approval" || entry.activity === "question"` branch;
  `desktop-attention.ts` — `AttentionKind` and the filter
  `if (activity.status !== "approval" && activity.status !== "question") continue;` and the
  title builder; plus `desktop-attention.test.ts` and `command-palette-data.test.ts`.
- Change: add the `error` state everywhere states are enumerated, in red
  (`text-destructive`), ranked between question and active (palette rank between 8 and 6);
  label text 「出错停止」 (sidebar `${name}出错停止`); show the message under the sidebar
  entry for approval and error as for question; desktop attention notifies for `error` with
  title `` `${agent} 出错停止` `` and the message in the body when present, and keeps
  treating a change of kind as new attention. (D12)
- After: tests: `agentActivityOf("error", true)` → `"error"`; an attention snapshot entering
  `error` yields one notification titled `demo 出错停止`; existing approval/question
  behaviour and texts are unchanged.

### Milestone 5: hooks stop carrying state (amendment, D13)

Depends on: Milestones 1–4 (already implemented). Turn state now comes only from OSC 7501.

#### T10 · The runtime keeps no hook state

- Where: `crates/runtime/src/hook.rs` — `pub fn event_state`, `HookRequest`, the `/hook`
  branch of `handle` ("Two independent reasons to forward"), its tests;
  `crates/runtime/src/main.rs` — the hook consumer that calls
  `observed.apply_hook_state(session_id, hook_state)`;
  `crates/runtime/src/observed.rs` — `hook_states`, `hook_messages`, `apply_hook_state`,
  `apply_notify`, the hook branch in `merge_annotations`, tests.
- Change: delete the event→state mapping and everything that stores or merges hook state
  and hook messages. `/hook` forwards a request only when it carries a valid agent session
  id; the consumer records that id and reports. The request no longer carries notification
  type or background-task count.
- After: a session's `state`/`message` come only from its OSC 7501 record; a
  process-detected session without one has `state: ""`. A `/hook` body without a session id
  is answered as today's "ignored" outcome and never reaches the consumer. A caller outside
  every session tree that sends a session id is still refused. `agent_session_id` keeps its
  existing lifetime. Remove or rewrite tests that asserted hook-driven states.
- Don't: keep a hook fallback "for old agents" (D13).

#### T11 · The messengers send only the session id

- Where: `crates/cli/src/commands.rs` — `pub fn build_hook_body`, `pub fn run_hook`, tests
  (`hook_body_mirrors_node_field_rules` and the `background_tasks` case);
  `packages/cli/coflux.mjs` — the hook messenger section
  (`/* ------------------------------ hook：agent 事件信使`), including its header comment.
- Change: build a body only when the payload carries a session id (`session_id`, or the Codex
  field the current code already reads); drop `notification` and `backgroundTasks`. When
  there is no body, post nothing. `run_hook` still prints the worktree-guard decision first.
- After: `{hook_event_name:"Stop"}` without a session id → no POST; `{hook_event_name:
  "SessionStart", session_id:"s1"}` → body with agent, event, pid, ppid, agentSessionId only.
  Node and Rust messengers agree.

#### T12 · Only non-status hooks are registered

- Where: `crates/cli/src/integration.rs` — `const EVENTS`, `fn claude_hooks`,
  `fn codex_args`, and any test pinning them; `integrations/claude-plugin/hooks/hooks.json`;
  `integrations/claude-plugin/.claude-plugin/plugin.json`;
  `integrations/claude-plugin/README.md` (the hooks section).
- Change: managed Claude registers exactly `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `SessionEnd`, `WorktreeRemove`; managed Codex exactly `SessionStart`,
  `UserPromptSubmit`, `SessionEnd`. In the plugin: delete the `Stop`, `StopFailure`,
  `PermissionRequest`, `Notification`, `PostToolUseFailure` keys; delete the
  `coflux hook claude` entries under `UserPromptSubmit` and the unmatched one under
  `PostToolUse` (keep `session-moved.mjs` and the EnterWorktree/ExitWorktree matcher entry);
  keep `PreToolUse`'s messenger (worktree guard); add the same messenger command as a second
  hook under `SessionStart`, after `session-context.sh`. Rewrite the hooks.json
  `description`, the README hooks section and `plugin.json`'s description so none of them
  says hooks report turn states; bump `plugin.json` to `0.26.0`.
- After: nothing in either integration registers an event whose only job was turn state;
  every remaining job (context, session moved, worktree follow/forget/guard, session id) is
  still wired.
- Don't: touch `integrations/claude-plugin/skills/` (mirrored from `packages/cli/skills`).

#### T13 · Wording and the black-box body follow

- Where: `apps/server/src/hub.ts` — the `state` field comment ("Turn state from hooks or OSC
  7501"); `packages/client/src/store.ts` — the `workspaceActivity` and `workspaceProgress`
  doc comments; `tests/src/agent-endpoint.test.mjs` — `const bodies`, whose `/hook` body is
  `{ agent: "claude", event: "Stop", pid: livePid, ppid: livePid }`.
- Change: say state comes from OSC 7501; give the test's `/hook` body a valid
  `agentSessionId` (a UUID) and event `SessionStart`, so the request still reaches the
  in-tree gate the test exercises.
- After: the test's assertions are unchanged and meaningful — an in-tree caller gets 200,
  a forged or foreign caller is refused.

### Your call

- D2: which parser, and the internal representation of the record and events.
- Name of the new `SessiondEvent` variant and its JSON tag.
- Where the D8 sanitising lives and the clamp length for `message` (reuse an existing
  worker-side clamp if one fits; otherwise ≤ 256 bytes on a character boundary).
- The red dots' glyph in `pending-dots.tsx` and the Clawd pose for `error`, provided error
  is visibly distinct from done and from the waiting states.
- Which further unit tests to add beyond those listed; keep them pure (no PTY processes).

### Landmines

- Local `cargo test` picks up the coflux session's environment and fails spuriously:
  run it as `COFLUX_HOME= cargo test -p coflux-runtime`.
- `SessionState::feed` clears `query_replies` at its start and the rebuild path discards
  them deliberately; any reordering must keep "re-fed history is never answered".
- The scanner must keep working byte-at-a-time across arbitrary chunk splits; a report or
  probe split over two feeds must behave as one.

### Scope

In scope:
- `crates/runtime/src/sessiond.rs`
- `crates/runtime/src/sessiond_ipc.rs`
- `crates/runtime/src/sessions.rs`
- `crates/runtime/src/observed.rs`
- `crates/runtime/src/agents.rs` (only if the merge needs a helper there)
- `crates/runtime/src/main.rs`
- (`crates/runtime` already depends on `base64 = "0.22"`; no manifest change is expected)
- `apps/server/src/hub.ts`
- `packages/client/src/store.ts`
- `apps/desktop/src/renderer/components/workbench/{sidebar.tsx,pending-dots.tsx,workspace-terminal.tsx,command-palette-data.ts,command-palette.tsx,desktop-attention.ts,desktop-attention.test.ts,command-palette-data.test.ts}`
- Milestone 5 adds: `crates/runtime/src/hook.rs`, `crates/cli/src/commands.rs`,
  `crates/cli/src/integration.rs`, `packages/cli/coflux.mjs`,
  `integrations/claude-plugin/hooks/hooks.json`,
  `integrations/claude-plugin/.claude-plugin/plugin.json`,
  `integrations/claude-plugin/README.md`, `tests/src/agent-endpoint.test.mjs`

Out of scope:
- `proto/` and every generated tree — comment-only changes would force regeneration (D11).
- `crates/ptyd`, `crates/launcher` — no PTY-ownership or upgrade change.
- The plugin's scripts (`integrations/claude-plugin/scripts/`) and skills — their jobs are
  not status.
- `apps/ios` — no change.
- Agent progress percentage and child records (non-goals).

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- Answering the probe appears to require writing from the VT thread or a callback on it.
- The chosen parser needs a crate not already in the Cargo workspace lockfile.

## Verification

### Milestone validations

- Milestone 1–2: `cargo build -p coflux-runtime 2>&1 | grep -c warning` → `0`;
  `COFLUX_HOME= cargo test -p coflux-runtime` → exit 0, including the new sessiond and
  observed tests.
- Milestone 3: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.
- Milestone 4: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop lint` → exit 0.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Zero-warning build | `cargo build` | exit 0, no warnings |
| Rust unit tests | `COFLUX_HOME= cargo test -p coflux-runtime` | exit 0 |
| Format | `cargo fmt --check -p coflux-runtime` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client package types | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop lint && pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | the four observations under Requirement, on a dev preview against a runtime built from this branch — by the user | as described |

The black-box suite is not required: the wire protocol, release signing and hot-upgrade
path are unchanged.

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] The probe reply bytes match D5 exactly, for both terminators.
- [ ] A live probe is answered with a human holder attached; re-fed history is not.
- [ ] Hook state never overrides a present root record; it returns when the record goes.
- [ ] The server allowlist contains `error` and nothing else changed in its validation.
- [ ] Desktop ranks approval > question > error > active > done in the store, palette and attention.
- [ ] Required tests exist and assert meaningful behaviour.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- **Deploy the centre before releasing the runtime** (D11). A new runtime reporting `error`
  to an old centre has every agent of that device dropped. Follow the existing practice:
  centre first, then tag.
- Runtime and desktop are independent: an old desktop shows `error` as neutral; an old
  runtime never sends it.
- The release notes should say that any agent reporting OSC 7501 (Claude Code ≥ 2.1.295,
  pi ≥ 1.1.0, Grok Build, Crush, Codex builds that emit it) now shows its status, and that
  error stops now notify. English only.
- Acceptance is manual and needs a runtime built from this branch (the change lives in the
  runtime and hot-upgrades with it); the desktop half is visible in a dev preview.

## Outcome

- Status: APPROVE — 2026-11-07
- Mode: subagent(opus), one work package (M3/M4 too small to outweigh a split); one revision round;
  Milestone 5 (D13) added afterwards at the user's request and dispatched to the same executor
- Commits: `7206efc7..11843e43` (Milestones 1–4), `fd1703ca..457e9a63` (Milestone 5)
- Milestone 5: hooks carry no turn state; `/hook` only records the agent session id; plugin
  0.26.0 and the managed integration register only hooks with another job. Verified: zero-warning
  build, runtime 346/346, `coflux-cli` 57/57, `node --check`, plugin mirror check, server tsc,
  desktop 563/563 + build, black-box `agent-endpoint.test.mjs` 5/5.
- Deviations:
  - T4: a rebuilt session's record is not pushed at the end of the rebuild — recovery runs
    before the core attaches, so that push would have nowhere to go. Instead `send_resync`
    sends every session's current value, absence included, right after `resync.list` under the
    session's lock; this also repairs any live push lost to a full queue.
  - T6: the immediate report runs in a dedicated task woken by a `tokio::sync::Notify` instead
    of inline in the sessiond bridge loop, which also carries Device frames and must not wait
    on a process scan; a burst of reports costs one scan.
  - Parser (D2, Your call): hand-written in `sessiond.rs`; `msg` decoded with the existing
    `base64` dependency (padding optional) and clamped like a title (256 bytes).
  - A `claude` tab in `error` shows the red error cross instead of Clawd (no Clawd pose reads
    apart from done and waiting; its file was out of scope).
  - Approval notifications now carry the agent's message when there is one (hook approvals
    have none, so their text is unchanged).
  - `agentActivityOf` in `command-palette-data.ts` is exported for its test.
- Verification: zero-warning `cargo build`; `COFLUX_HOME= cargo test -p coflux-runtime`
  347/347; server `tsc --noEmit`; desktop typecheck, oxlint, 563/563 tests and build.
  `tsc -p packages/client` reports errors only in the untouched `connection.test.ts`
  (pre-existing). `cargo fmt --check` differs only in files this plan did not touch.
- Follow-ups: the manual walkthrough (the four observations under Requirement) on a runtime
  built from this branch, pending the user; proto comments on `SessionAgentRef.state` still
  list four states (see Maintenance notes); `error` now also counts toward the Dock badge.
