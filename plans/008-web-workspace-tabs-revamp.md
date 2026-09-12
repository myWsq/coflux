# Plan 008: Web workbench redesign: workspace terminal tabs and a Cursor-style layout without backend changes

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 9d0cabf..HEAD -- apps/web pnpm-lock.yaml apps/server/src/hub.ts packages/protocol/src/index.ts`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: agent:codex
- Planned at: `9d0cabf`, 2026-07-11

## Requirement

The existing web client (`apps/web/src/App.tsx`, a 780-line file) has complete functionality but rough interaction: creation relies on `window.prompt`/`confirm`, the sidebar is a Project → Workspace → Task tree, and one global xterm clears and replays whenever tasks switch. Reshape it into a Cursor-style workbench:

- **Two-level sidebar:** projects are top-level entries; clicking a project opens its main workspace (`isMain`). Child workspaces (git worktrees) appear beneath it and open their corresponding workspace.
- **Workspace-centered main area:** horizontal terminal tabs each represent one task/PTY session. `+` creates a terminal and immediately starts its shell. `×` stops and deletes it, asking for confirmation if running. Hide the term "task" from the UI: users work with multiple terminals in a workspace.
- **Use proper creation forms:** dialogs handle project import, workspace creation, and device addition. Remove all `window.prompt`/`window.confirm` usage from `apps/web/src`.
- **Visual**: Tailwind CSS v4 + shadcn/ui (dark theme), the look and feel is aligned with the Cursor/Codex web page.

Make no backend, daemon, or protocol changes. Correctness requires preserving protocol behavior, message ordering, and the semantics of the three independent login/authorization/access-control flows; only browser organization and presentation change.

## Decisions & tradeoffs

- **Use a Project + Workspace sidebar; clicking a project opens its main workspace.** The user explicitly chose this two-level structure over a flat task feed or three-level Project → Workspace → Task tree. Remove tasks from the sidebar. Evidence: `isMain` identifies the main workspace, already sorted first (`apps/web/src/App.tsx:359-360`).
- **One terminal tab equals one task.** List all tasks in the current workspace, also fulfilling OPEN_QUESTIONS B4 (multiple terminals per workspace). Rejected: adding a terminal entity or changing the task model, since zero backend changes is mandatory. Evidence: tasks have idle/running/exited states and one sessionId each (`packages/protocol/src/index.ts`, `apps/server/src/hub.ts:869-896`).
- **Closing a tab stops and deletes its task (`task.stop` + `task.remove`), with confirmation when running.** Retain no exited-task history. Opening/creating a tab sends `task.start`; for running tasks, the server performs attach and replay (`apps/server/src/hub.ts:873-879`). The user chose deletion over stop-and-retain, also preventing long-term exited-task accumulation (ROADMAP item 4).
- **No backend/daemon/protocol changes.** Automatic agent startup (B5) and task startup commands are out of scope; tasks remain plain shells. Do not opportunistically add protocol acknowledgments or startup commands.
- **Keep the Vite SPA; add Tailwind CSS v4 and shadcn/ui**, using Radix primitives and component source copied into the repository. Rejected: Next.js/React Router, since a login-gated WS application needs no SSR, and hand-written CSS, given overlay/dropdown/focus-management costs. Research found the same convergence in Codex web (Tailwind v4 + Radix) and cursor.com (Tailwind + tokens).
- **Add no routing library.** Preserve pathname branches for `/authorize/<token>` and `/proxy-auth` (`apps/web/src/App.tsx:24-29`). Persist the selected workspace ID in localStorage and restore it on refresh without putting it in the URL. Two special pages plus one main view do not justify react-router.
- **Keep multiple xterms mounted and route frames by sessionId.** Each tab in the current workspace owns an xterm; switching tabs never clears the screen. Dispatch by `frame.sessionId` and remove the current single-activeSession filter that drops other frames (`apps/web/src/App.tsx:126-129`, OPEN_QUESTIONS A8). Destroy the old workspace’s xterms when switching workspaces; reentry uses daemon scrollback replay (200k characters). The protocol already supports this: holders are per session, one client can hold multiple sessions, and `pty.output` goes only to each session’s holder (`apps/server/src/hub.ts:88`, `158-164`, `197-211`).
- **Desktop priority (≥1024px), no small screen adaptation**. Rejected: Responsive/mobile-optimized—the user explicitly excluded it from this iteration.
- **Use a frontend heuristic to open newly created terminals (decided during planning).** `task.create` has no acknowledgment; creation appears only through `task.updated` (`apps/server/src/hub.ts:700-711`). Clicking `+` sets a waiting-for-new-task flag. Treat the first unseen task in that workspace as the result, send `task.start`, and activate its tab. Simultaneous creation by another client can be misidentified; this is accepted for the single-user product. Adding requestId acknowledgments would violate the backend boundary.
- **Mark takeover per tab (decided during planning).** On `task.detached{taskId}`, mark only that tab as controlled by another client. Clicking it sends `task.start` to reclaim control. Disable input while detached rather than relying on the server’s ownership error (`apps/server/src/hub.ts:240-243`).

## Direction

App.tsx’s WS logic—login-ticket exchange, token reconnection, binary codec, and reducer—is production-proven. Extract and move it rather than rewrite the protocol layer. Prefer one hook/store for connection and state, consumed by sidebar, terminal tabs, dialogs, and the three independent pages. The executor chooses module boundaries from current code.

### Milestone 1: Style infrastructure access

Tailwind CSS v4 + shadcn/ui enters `apps/web` (dark theme is the default), and existing functions will not regress. Validation: `pnpm -C apps/web build`  → exit 0.

### Milestone 2: Protocol layer split + multi-session data plane

`App.tsx` is split into a modular structure; binary frames are distributed to registered per-session consumers as `frame.sessionId`; AuthorizePage / ProxyAuthPage keeps the standalone component tree and standalone WS connection intact. Validation: `pnpm -C apps/web build`  → exit 0.

### Milestone 3: Implementation of new information architecture

Two layers of sidebar (project = main workspace entrance + sub-workspace); multi-terminal tab in the main area workspace (resident xterm, `+`/`×` Semantics, takeover status mark, port preview logo hanging tab and top bar); selected workspace localStorage restore; device area retained at the bottom of the sidebar. Validation: `pnpm -C apps/web build`  → exit 0.

### Milestone 4: Replace creation prompts with dialogs + finishing

Import projects (select online device + repository path), create a new workspace (name/branch/new or check out existing), add device (register Command display and copy), deletion class confirmation (Project/Workspace/Device/running Tab) are all shadcn Dialog/AlertDialog; the login page and two independent pages have been reskinned but the process remains unchanged; the empty-state copy (no project/no device/no terminal) is complete. Validation: `pnpm -C apps/web build` → exit 0 and `rg -n "window\.prompt|window\.confirm|\balert\(" apps/web/src` → No matches (exit 1).

## Landmines

- **Keep the three component trees’ WS connections independent** (`apps/web/src/App.tsx:22-29`). Authorization/access-control pages must never trigger main-app xterm, reconnect, or subscription effects. Plan 003 already exposed interference when main-app effects ran on authorization pages; preserve isolation after refactoring.
- **Control transfers when replay returns** (`apps/server/src/hub.ts:213-225`). For a running task, `task.start` requests daemon replay, and the returning frame triggers `setHolder`. Attaching several tasks completes asynchronously; live output goes to the old holder meanwhile. Sending `task.start` does not immediately grant control.
- **Replay arrives as `pty.output`** (`apps/server/src/hub.ts:217-221`), so clients need no `pty.replay` handling. Register the xterm frame route before requesting attach or the replay will be lost.
- **Slow-consumer protection disconnects the entire WS** with code 1013 when client `bufferedAmount` exceeds its limit (`apps/server/src/hub.ts:200-207`). Multiple resident terminals increase output; use xterm’s buffered `write` and avoid expensive synchronous frame callbacks.
- **`pty.resize` and `pty.input` require holder rights** (`apps/server/src/hub.ts:240-243`, `752`). Send them only for the active, non-detached tab; resizing every resident terminal produces ownership errors.
- **Supabase login is a build-time switch** (`apps/web/src/App.tsx:15-17`). Without `VITE_SUPABASE_URL/ _ANON_KEY`, use local username/password login. `pnpm -C apps/web build` must still pass without those variables.
- **Device setup is asynchronous:** `enrollmentKey.created` supplies the installation command (`apps/web/src/App.tsx:287-288`). The dialog must wait for this response after requesting a key, then display the command; it is not a synchronous form.

## Scope

In scope:
- `apps/web/**` (src, index.html, package.json, vite.config.ts, tsconfig.json, styles and shadcn/Tailwind configuration file)
- `pnpm-lock.yaml` (only changes with new apps/web dependencies)

Out of scope:
- `apps/server/**`, `crates/**`, `packages/**` —  zero changes to backend/daemon/protocol is the hard limit of this plan
- `tests/**` —  Black-box testing does not cover the web, and the UI does not have an existing automated baseline
- `docs/**`, `plans/` (except this plan status line) - the document will be processed separately
- Agent automatic startup (B5), `fs.*` file tree, mobile terminal adaptation - follow-up plan

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm -C apps/web build`  | exit 0 |
| prompt/confirm reset | `rg -n "window\.prompt\|window\.confirm\|\balert\(" apps/web/src` | No matches (exit 1) |
| Backend black-box regression (acceptance) | `COFLUX_TEST_PG_URL=<54322 direct connection URL> pnpm -C tests test` | exit 0 (guarding "zero backend changes") |
| UI smoke (acceptance) | dev server + browser walkthrough: Log in → Import project → Build workspace → Multi-Tab terminal → Close Tab → Device management | Full process available |

## Done criteria

- [ ] `pnpm -C apps/web build` passed.
- [ ] `apps/web/src` in `window.prompt`/`window.confirm`/`alert(` with zero residue.
- [ ] Two-layer IA in the sidebar, multi-terminal tab in the workspace (`+` instant shell, `×` stop and delete with confirmation), resident xterm the screen will not clear when switching tabs, and the behavior is consistent with the Decisions items.
- [ ] AuthorizePage / ProxyAuthPage / The three page flows of the main app maintain independent WS connections and original semantics.
- [ ] `git diff` changes only fall within the In scope path (especially `apps/server`, `packages`, `crates` zero diff).
- [ ] `plans/README.md` status updated.

## STOP conditions

- Any code referenced by Decisions & tradeoffs is no longer true (especially the holder/replay semantics of hub.ts).
- The implementation is forced to touch out-of-scope files (if it is found that the protocol must be changed to achieve interaction).
- A certain verification command failed twice in a row even after a reasonable repair.
- Dependency installation or shadcn initialization conflicts with pnpm workspace structure and has no clean solution.

## Maintenance notes

- Routing by sessionId replaces single-activeSession filtering and makes OPEN_QUESTIONS A8 obsolete. Revise that entry in a later documentation update.
- Automatic tab opening assumes a single user. Future collaboration requires a protocol-level creation acknowledgment.
- Once copied into the repository, shadcn components are project source. Upgrade by regenerating/replacing that source, not by changing an npm package version.
