# Plan 20261108-terminal-tab-recap: Hovering a Claude terminal tab shows Claude's own session recap

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat afe5a152..HEAD -- apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/renderer/components/workbench/terminal-transcript.ts apps/desktop/src/renderer/components/workbench/terminal-recap.ts apps/desktop/src/renderer/components/workbench/sidebar.tsx packages/client/src/store.ts docs/design-guidelines.md`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check ("直接自动执行")
- Plan review: none — departure check
- Workspace: isolated — the session started in the main worktree; this plan lives in `.claude/worktrees/20261108-terminal-tab-recap` on `dev/20261108-terminal-tab-recap`
- Planned at: `afe5a152`, 2026-11-08

## Record

### Requirement

Claude Code writes a **session recap** (internally "away summary") when a session has been idle for a while. The recap is one or two sentences: the overall goal, the current task, and the next action. Claude prints it in the terminal when you come back, but only once you are looking at that terminal. A user running several Claude tabs in Coflux wants to know where each tab stands **without switching to it**.

What a recap is, on disk: Claude appends a record to the session transcript (`<claude config dir>/projects/<slug>/<session-id>.jsonl`):

```json
{"type":"system","subtype":"away_summary","content":"<recap text> (disable recaps in /config)","timestamp":"2026-11-03T07:06:23.914Z", ...}
```

No hook event carries it. Measured over 141 local records (Claude Code 2.1.31x): each one is written about 3.1 minutes after the session's last record, and there is exactly one per idle period. The next user/assistant record follows it, with a median gap of about 11 minutes. Generation belongs to Claude Code (`awaySummaryEnabled`, `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`). There is no public way for another program to trigger one.

Product conclusions (confirmed by the user):

1. **Consumer and trigger**: a user with several Claude tabs open, glancing at the tab strip, who wants to know what a tab did and what it does next without switching to it.
2. **Form**: hovering a terminal tab that runs Claude opens a card with the tab's title, the agent's current status, the recap text (without the trailing ` (disable recaps in /config)`), and when it was written ("N 分钟前"). The tab's own appearance does not change.
3. **Freshness**: a recap belongs to the current idle period only. As soon as Claude starts a new turn it is no longer shown; the card keeps only title and status until the next recap exists.
4. **Tabs without a recap**: shell tabs, Codex tabs, and tabs where Claude is not detected keep today's hover behaviour.
5. **Scope**: Claude Code only, on terminals of every device in the account. Not the sidebar, not iOS, no recap history, never triggering a recap, never changing Claude's settings.
6. **Observable when done**: a Claude tab that finished a turn and sat idle for 3+ minutes shows its recap and its age on hover. After the user sends it a new message, hovering shows no recap. After the desktop app restarts, an idle tab still shows its recap.

### Decisions & tradeoffs

- **D1 Desktop-only, pulled on demand through the existing transcript reader**: the desktop renderer reads the transcript tail on the device that owns the workspace through `client.execInWorkspace`, the route the terminal paper overlay already uses, which works the same for local and remote devices. It parses the recap in the renderer. No daemon, protocol, server, or Claude plugin change. Rejected: teaching the runtime to watch transcripts and adding a `recap` field to `sessionAgentsUpdated`. That welds a private, unannounced vendor format into the wire protocol, and every vendor change would need a coordinated daemon release. Based on: the boundary stated in the header of `apps/desktop/src/renderer/components/workbench/terminal-transcript.ts` ("The daemon returns bytes and nothing else … Resist any later proposal to move this into the daemon or the protocol"), and `execInWorkspace` routing in `terminal-pane.tsx:95`.
- **D2 Freshness is decided in two layers**: (a) when the tab's presence entry has `state === "active"`, no recap is shown and none is fetched, whatever the transcript says; (b) otherwise, the transcript decides: the recap is the **last** `type:"system", subtype:"away_summary"` record, and it counts only when no record of `type` `"user"` or `"assistant"` comes after it in the file. Rejected: comparing timestamps with a fixed threshold, or treating every `away_summary` in the tail as valid. A recap from an earlier idle period must never show. Based on: the measured one-recap-per-idle-period behaviour; the presence states in `packages/client/src/store.ts` `workspaceActivity` (`active`, `approval`, `question`, `done`, `waiting`, or empty).
- **D3 Fetched each time the card opens, never polled**: opening the card (the Tooltip's `onOpenChange(true)`) starts one read. Each open reads again: a recap appears about 3 minutes after the state turns `done` *without the state changing again*, so a result cached by session and state would keep showing "no recap" forever. A previous result for the same session may be shown while the new read is in flight, but only if D2(a) still allows it. Read failures and missing transcripts show no recap and no error. Rejected: background polling of every Claude tab, and a cache keyed only by session and state. `(decided while planning; refines the explored direction's "cache keyed by session + agent state")`
- **D4 The card is the Astryx `Tooltip` with rich content, placed on the tab's main button**: for a Claude tab, the existing OSC-title tooltip is replaced by the card, which carries the full title itself. Every other tab keeps exactly today's tooltips. Rejected: Astryx `HoverCard`/`Popover` (not used anywhere in the app; Tooltip with rich content is the established pattern for the sidebar workspace card, `sidebar.tsx` "workspaceTooltip"); a terminal banner or inline text in the tab (rejected by the user, see the Discussion log). `(decided while planning)` Based on: `docs/design-guidelines.md` "Hover hints: use `Tooltip`, not native `title`".
- **D5 A "Claude tab" is one whose presence entry says `agent === "claude"`**: the same test the tab glyph uses (`AgentGlyph` in `workspace-terminal.tsx`). When Claude exits, the presence entry disappears and the tab returns to today's behaviour. A tab merely *launched* as Claude from the ＋ menu but not currently detected is not a Claude tab here.
- **D6 Read a small tail, with the same safety properties as the paper's reader**: the recap read uses a fixed-literal locator script and passes the agent session id as its own argv entry, validated by `isUsableAgentSessionId`. It reads a much smaller tail than the paper's 512 KB, because a fresh recap is followed only by small records. 64 KB is the target. Rejected: reading the whole 512 KB on every hover, which is wasteful for remote devices. Based on: `CLAUDE_LOCATOR_SCRIPT` and `transcriptCommand` in `terminal-transcript.ts`.
- **D7 No new automated tests**: a wrong freshness rule or a missing card is visible the first time the user hovers a tab, which is the repository's bar for not writing a test. Existing `terminal-transcript.test.ts` must keep passing unchanged. Based on: `AGENTS.md` "Test harness".

### Discussion log

- Research: the user first asked whether Claude can drive CapCut. They then corrected themselves: what they had in mind was Claude's "tell me what you're doing" summary. That turned out to be Claude Code's Session recap (`/recap`, away summary). There is no hook for it; it is persisted in the transcript as `subtype: away_summary`.
- Q1 Placement (product): tab hover card (recommended) / hover card + sidebar workspace card / banner above the terminal / one line inside the tab → **tab hover card**. Settled D4's surface and the "not sidebar" scope.
- Q2 Stale recap (product): grey it out as "上一轮" (recommended) / hide as soon as a new turn starts / ignore freshness → **hide as soon as a new turn starts**. Settled D2.
- Product confirmation: the six conclusions in Requirement → **"对，按这个来"**.
- Technical direction (stated in chat, approved at the departure check): desktop-only pull through the transcript reader; two-layer freshness; fetch on hover, no polling; strip the suffix, show relative time.
- Departure check: execution **subagent(opus)**; autopilot **"直接自动执行"** (plain autopilot, no plan audit).
- D3 refined while planning: caching by session + state would freeze "no recap" across the 3-minute gap, so every open reads again `(decided while planning)`.
- D4 and D6 decided while planning: Tooltip as the card; 64 KB tail `(decided while planning)`.

### Maintenance notes

- The record shape (`type: "system"`, `subtype: "away_summary"`, the ` (disable recaps in /config)` suffix) is Claude Code's private format and may change without notice. If cards stop showing recaps after a Claude Code update, check a fresh transcript first. The fix belongs in the renderer parser alone (D1).
- Recap generation depends on the user's Claude settings. With `awaySummaryEnabled: false`, cards show title and status only, which is correct behaviour, not a bug.
- `user`-type records include tool results and local slash-command echoes, so running a local command such as `/config` in an idle session hides its recap until the next one. This is accepted: it errs toward not showing a stale recap.

## Execution brief

> Written for `subagent(opus)` at `afe5a152`. Implement the tasks in order.
> Decide only what Your call leaves to you; on anything else that is unclear,
> stop and report.

### Goal

Claude Code appends a "session recap" record to its transcript JSONL after a session has been idle about 3 minutes:

```json
{"type":"system","subtype":"away_summary","content":"<recap text> (disable recaps in /config)","timestamp":"2026-11-03T07:06:23.914Z"}
```

Make hovering a desktop terminal tab that runs Claude open a card with the tab's full title, the agent's current status, and — when a fresh recap exists — the recap text and its age. Read the transcript on demand from the renderer through `client.execInWorkspace`, the same route `terminal-transcript.ts` uses for the terminal paper overlay. This is a desktop-renderer-only change in `apps/desktop/src/renderer/components/workbench/`. Follow the conventions in `terminal-transcript.ts`: fixed-literal shell scripts, the session id only ever as its own argv entry, pure parsing functions separate from React. UI copy is Simplified Chinese, like the surrounding code; code comments are English. The project has no formatter; match the surrounding style.

### Milestone 1: Recap reading and parsing (pure module)

Depends on: none

#### T1 · A pure module can fetch and parse the current recap of a Claude session

- Where: new file `apps/desktop/src/renderer/components/workbench/terminal-recap.ts`. It may import from `terminal-transcript.ts`, and you may export currently private constants or helpers there (`HEADER_PREFIX`, `EXIT_NOT_FOUND`, `EXIT_READ_FAILED`, the Claude locator) if you need them.
- Change: add a loader `loadRecap(exec, { agentSessionId, workspaceId })` that reads the tail of the Claude transcript on the owning device and returns either `{ text, timestamp }` or "none". Add a pure parser over the raw tail text, and a formatter for the age.
- After:
  - The locator is a fixed-literal script with the same lookup as `CLAUDE_LOCATOR_SCRIPT`: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/*/<id>.jsonl`, newest match. It tails **64 KB** (D6). The id is passed as `"$1"` through `sh -c '<script>' sh <id>`. No runtime value is ever interpolated into the script text.
  - The id is checked with `isUsableAgentSessionId` before anything runs. An unusable id, a missing transcript, a non-zero exit, an exec rejection, a missing header, or unparsable content all return "none", never throw.
  - The parser splits on newlines and skips lines that fail `JSON.parse`; the first line of a tail is usually a fragment. It finds the **last** record with `type === "system"` and `subtype === "away_summary"`. It returns that recap only if no later record has `type === "user"` or `type === "assistant"` (D2b). Records of any other type after it do not matter.
  - The returned text is `content` trimmed, with a trailing ` (disable recaps in /config)` removed when present. An empty result after trimming means "none". The timestamp comes from the record's `timestamp`; a record without a parsable timestamp still yields its text with no age.
  - Age formatter, as a function of now and the timestamp: under 1 minute → `刚刚`; under 60 minutes → `N 分钟前`; under 24 hours → `N 小时前`; otherwise `N 天前`.
- Don't: reuse the 512 KB `TRANSCRIPT_TAIL_BYTES` read for this, or change the paper's existing script or its behaviour (D6). Existing `terminal-transcript.test.ts` must pass untouched.

### Milestone 2: The hover card on Claude tabs

Depends on: Milestone 1

#### T2 · Hovering a Claude terminal tab opens the recap card

- Where: `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx`, the terminal-tab branch of the tab renderer — the block after `const agentEntry = task.sessionId ? sessionAgents[task.sessionId] : undefined;` through the `<button … onClick={() => actions.activateTab(workspaceId, task.id)}>` that holds the glyph and the title, including the existing OSC-title tooltip (`<Tooltip content={tabTitle} placement="below">`). You may put the card in its own component, in this file or a new file next to it.
- Change: when `agentEntry?.agent === "claude"` (D5), wrap the tab's main button (glyph + title + executor dots) in one Astryx `Tooltip` (`@astryxdesign/core/Tooltip`, `placement="below"`) whose content is the card (D4). In this case drop the inner OSC-title tooltip, because the card shows the full title. When the Tooltip opens (`onOpenChange(true)`) and the state is not `"active"`, call `loadRecap` with `client.execInWorkspace`, the tab's workspace id, and `agentEntry.agentSessionId` (D3). Ignore a result that arrives after the card closed or after the tab's session or state changed.
- After:
  - Card content, top to bottom: the full tab title (`tabTitle || "终端"`) as the heading. Then a status line with the agent's state, worded like the sidebar's `activityLabel` in `sidebar.tsx`: `active` → `正在执行`, `approval` → `等待批准`, `question` → `等待回答`, `done`/`waiting` → `本轮完成`, any other or empty state → no status line. Then, when a recap is held for this tab, the recap text, wrapping fully (`whitespace-pre-wrap break-words`, not truncated), followed by its age (e.g. `4 分钟前`) in muted text.
  - When `agentEntry.state === "active"`, the card never shows a recap and no read starts (D2a). If the state turns `active` while a recap is displayed, the recap disappears.
  - Each opening of the card starts a fresh read; there is no polling and no timer (D3). While a read is in flight, the card shows title and status. It may also show the previous recap for this same session, only if D2(a) still allows it. Swap in the new result when it arrives. A "none" result removes any shown recap. No spinner and no error text are required.
  - The card is bounded in width so a long recap wraps instead of stretching across the window. Use token-backed Tailwind utilities, no raw pixel values.
  - Tabs where `agentEntry?.agent !== "claude"` render exactly as before, including the OSC-title tooltip when the title differs from `task.title`. The close button's tooltip, the context menu, drag-and-drop, and the click-to-activate behaviour are unchanged for all tabs.
- Don't: add a polling interval or a background fetch for tabs nobody is hovering (D3). Don't use a native `title` attribute, `HoverCard`, or `Popover` (D4). Don't touch `packages/client`, the protocol, the runtime, the server, or the Claude plugin (D1).

### Your call

- File layout inside `components/workbench/` (one new module plus a card component, or the card inside `workspace-terminal.tsx`), and names.
- How the per-session last result is held (component state, a ref map), and how stale results are discarded, within D3.
- Card typography and spacing, using existing utilities and tokens; following the sidebar workspace card in `sidebar.tsx` is a good default.
- Whether the Tooltip's show delay stays at the default.

### Landmines

- The tab strip is a window drag region (`docs/design-guidelines.md`, "app-region"). Tooltip layers are `[popover]` elements and are covered by the `[style*="app-region: drag"] [popover]` rule in `apps/desktop/src/renderer/index.css`. Keep the card a Tooltip so this keeps working, and don't edit that rule.
- `agentEntry.agentSessionId` may be an empty string for older workers or restored offline caches (see the comment on `SessionAgentState.agentSessionId` in `packages/client/src/store.ts`). Treat empty as "no recap", never as an error.

### Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-recap.ts` (new)
- `apps/desktop/src/renderer/components/workbench/terminal-transcript.ts` (only to export existing private constants or helpers)
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx`
- A new card component file in `apps/desktop/src/renderer/components/workbench/`, if you choose one

Out of scope:
- `sidebar.tsx` and its workspace card: the sidebar is explicitly not part of this feature.
- `terminal-paper.tsx` and the paper's 512 KB reader behaviour.
- `packages/client`, `packages/protocol`, `crates/*`, `apps/server`, `integrations/claude-plugin`, `apps/ios`.
- Browser tabs and file tabs in the same tab strip.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- `client.execInWorkspace` is not reachable from the tab renderer without threading new props through files outside the scope.
- Wrapping the tab's main button in a Tooltip breaks its click, drag, or context-menu behaviour and the fix would need changes outside the tab renderer.

## Verification

### Milestone validations

- Milestone 1: `pnpm -C apps/desktop typecheck` → exit 0; `pnpm -C apps/desktop test` → exit 0 with `terminal-transcript.test.ts` unchanged and passing.
- Milestone 2: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop lint && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Lint | `pnpm -C apps/desktop lint` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` from the worktree, by the user | the six observable outcomes in Requirement hold |

### Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every task's `After` state holds.
- [ ] Reading the diff: the recap read passes the session id only as an argv entry; the script text is a compile-time literal.
- [ ] Reading the diff: no polling interval or timer drives recap reads; a read starts only from the card opening.
- [ ] Reading the diff: a recap is accepted only when no `user`/`assistant` record follows the last `away_summary`, and never while the state is `active`.
- [ ] Reading the diff: non-Claude tabs render exactly as before.
- [ ] No files outside the in-scope list changed; `terminal-transcript.test.ts` is unchanged.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Desktop-only. It ships with the next desktop release, with no server deployment and no runtime release. Remote devices work through the existing `execInWorkspace` route, so no daemon on any device needs updating.
- Human acceptance is manual: the user walks through the six outcomes in a `pnpm dev:desktop:prod` preview. A recap appears only after a Claude session has been idle about 3 minutes, so the walkthrough needs that wait.
