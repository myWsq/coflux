# Plan 010: Rewrite the web client in SolidJS with feature parity, Cursor-style UI, and a sound performance baseline

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat bc9fec3..HEAD -- apps/web packages/protocol/src/index.ts`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: refactor
- Execution: subagent sonnet
- Planned at: `bc9fec3`, 2026-07-16

## Requirement

The existing React implementation in apps/web is treated as a prototype and rewritten entirely in SolidJS. **Functional capabilities and view models are strictly maintained as they are and no new features are added**: login (Supabase ticket exchange/local account dual mode), device management and registration key, project import, worktree creation/deletion, workspace selection persistence, multi-terminal tab (plan 008 semantics), attach/exclusive takeover, port preview link, `/authorize` device authorization page, `/proxy-auth` preview domain access control page.

The rewrite accomplishes two things:

1. **Cursor-inspired UI:** an IDE layout with a sidebar tree and editor-style terminal tabs, a dark-first palette of muted grays, thin borders instead of shadows, dense information, small type, and restrained accents for status and alerts.
2. **Establish the performance baseline:** xterm WebGL rendering, zero reactive overhead on PTY data, fine-grained in-place control-state updates without render storms, snapshot retention during reconnect, and smaller bundles.

Correctness criterion: users familiar with the old client can complete every main flow with identical functionality, but faster and with more polished presentation. Preserve every multi-client takeover semantic listed under Landmines; this is the migration’s highest-risk area.

## Decisions & tradeoffs

- **Use SolidJS signals for state, without a state library.** Rejected: React 19 + Compiler, whose VDOM rendering model differs from high-frequency incremental WS updates, and Svelte 5, which abandons JSX and adds more migration overhead than Solid. Evidence: entity collections are driven by incremental messages throughout `use-coflux-client.ts:140-270`.
- **Keep Vite, Tailwind 4, and TS7; add vite-plugin-solid.** Use the existing `@tailwindcss/vite` devDependency. Adapt tsconfig JSX settings for Solid. TS7 has removed `baseUrl`; paths already resolve relative to apps/web/tsconfig.json.
- **Use Kobalte primitives with project-owned Cursor-style design tokens.** React-only shadcn/Radix cannot remain. Reuse the semantics of CSS variables in `src/index.css` (background/border/muted/accent/warning/terminal) while redefining their values. Replace lucide-react with `lucide-solid` (`apps/web/package.json:12`).
- **Keep xterm.js and add `@xterm/addon-webgl`.** Changing terminal libraries is rejected: xterm is mature and scrollback/themes are already tuned. Handle `onContextLoss` by disposing the addon and falling back to DOM rendering, preventing blank terminals after display sleep or GPU changes. Preserve the palette in `terminal-pane.tsx:68-82`.
- **Keep PTY bytes outside reactive state.** Deliver ptyOutput directly to `terminal.write` through an imperative sessionId → Set<consumer> registry. Signals carry only control-plane collections, connection state, and ownership. This is already the model in `use-coflux-client.ts:47,254-258` and is the central performance invariant.
- **Replace fixed 1.5s retries with exponential backoff and jitter, starting around 1s and capped around 15s.** Retain the last snapshot and show a reconnect banner instead of clearing the UI. Fixed retries and a blank disconnected screen conflict with the experience goal. After reconnect, fully replace local entities with the new snapshot (`use-coflux-client.ts:163-177`) and reattach every RUNNING task (Landmine 7).
- **Keep direct REST password-grant fetch for Supabase login; add no supabase-js.** `src/lib/auth.ts` implements the entire flow in 23 lines; an SDK would only increase the bundle.
- **Keep independent WS connections for `/authorize/<token>`, `/proxy-auth`, and the main page.** The executor may use @solidjs/router or retain the current 11-line pathname dispatcher in `App.tsx`. The invariant is isolated connections and effects, as recorded in `App.tsx:5`.
- **Remove all old React code and dependencies:** react/react-dom/@radix-ui/*/class-variance-authority/lucide-react leave apps/web/package.json, and all src components become Solid. A dual-stack migration is rejected because the full rewrite has already been selected.
- **Make no server/protocol/black-box test changes.** `tests/` exercises server and daemon only. `packages/protocol` encode already returns `Uint8Array<ArrayBuffer>` suitable for `WebSocket.send` (`packages/protocol/src/index.ts:67-71`, fixed by the TS7 commit), so it needs no adaptation.
- **(decided while planning) The UI copy remains in Chinese**, and the enroll command format remains `npm i -g cofluxd && cofluxd up --server <url> --enroll-key <key>` (`use-coflux-client.ts:251`) - the web UI is coupled with user habits/documents, and the semantics of the copy are not changed by rewriting.

## Direction

Suggested structure, adjustable by the executor: a framework-free TS protocol client for WS/auth/reconnect/send and consumer registration; a signals/createStore state layer applying envelope updates; and UI components for workbench, terminals, dialogs, and auxiliary pages.

### Milestone 1: Base + Protocol Client + Login

Set up Solid with working Vite dev/build, Tailwind, and TS7. Support token, supabaseToken, and username/password authentication; authOk → clientSubscribe; persist localStorage `coflux_token`; clear it on authError; retry with exponential backoff. A stored token starts directly in authenticating state without flashing login (`use-coflux-client.ts:51-59`). Apply snapshots and all incremental daemon/project/workspace/task/ports/taskDetached/enrollmentKeyCreated/error messages. Preserve cascading cleanup (`use-coflux-client.ts:185-217`): daemon removal clears projects/workspaces/tasks, project removal clears workspaces/tasks, workspace removal clears tasks, and task removal clears ports/detached state. Support Supabase and local login via build-time `USE_SUPABASE`. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 2: workbench interactive surface

Build the sidebar hierarchy (device group → project → workspace, with online state), workspace selection, localStorage `coflux_workspace`, and snapshot fallback to the first project’s main workspace (`workbench.tsx:29-44`). Dialogs cover project import (daemon/path), new workspaces (existing/new branch), device addition (requestEnrollmentKey → display/copy enrollment command), and project/workspace/task deletion confirmation. Include dismissible error toasts. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 3: Terminal + attach/takeover state machine + multi-Tab

Port TerminalPane (xterm, WebGL, fit, theme) and WorkspaceTerminal (tabs and state machine), preserving every Landmine semantic. Show port links in tabs and the top bar, opening new windows. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 4: Auxiliary page + visual polish + finishing

`/authorize/<token>` (authOk → deviceAuthorizeInfo{token} displays device information → deviceAuthorize → deviceAuthorized success state; authError/failure state); `/proxy-auth?redirect=` (authOk → proxyIssueAuth{redirect} → proxyAuth{ok,url} →`location.replace(url)`; go to the login form before logging in). Unified inspection of Cursor-style tokens (density/border/accent color); delete React legacy dependencies and files; the main chunk of the bundle should be significantly lower than the current 700KB (expected to be <400KB after React+radix is removed, it is not a hard threshold but the value needs to be recorded in the completion report). Validation: `pnpm --filter @coflux/web build` exit 0, and `grep -r "from \"react\"" apps/web/src` has no results.

## Landmines

The existing semantics of attach/exclusive takeover state machine (`workspace-terminal.tsx` +`terminal-pane.tsx`) must be maintained one by one when rewriting:

1. **Four control states:** `stopped | attaching | owned | detached`. Send input/resize only when `active && owned`. Preventing input while detached is a security invariant, not merely a UX detail. References: `terminal-pane.tsx:6`, `terminal-pane.tsx:113-124`.
2. **Attach uses taskStart.** Sending `taskStart{taskId,cols,rows}` to a RUNNING task requests takeover through the server’s startOrAttachTask semantics. There is no separate attach message.
3. **ATTACH_GRACE_MS=500.** If attach produces no ptyOutput because scrollback is empty, mark the terminal owned after 500ms. Any output grants ownership immediately. References: `workspace-terminal.tsx:14,92-95`, `handleOutput:156-158`.
4. **Deduplicate attach by `${snapshotRevision}:${sessionId}`.** Attach a session once per snapshot generation; explicit force-claim uses increasing sequence keys to bypass deduplication. References: `workspace-terminal.tsx:81-84`.
5. **Gate attach on sessionReady.** Wait until the ptyOutput consumer is registered with a sessionId, or replay can arrive before registration and be lost. References: `workspace-terminal.tsx:80,142-154`.
6. **Distinguish new starts from attachment.** Tasks started by this client, tracked in launchingTaskIds, become owned as soon as their session is ready. Do not send taskStart a second time. References: `workspace-terminal.tsx:39,115-121,147-149`.
7. **A snapshotRevision change means reconnect/relogin.** Call beginAttach again for every RUNNING task to reacquire its holder. The old connection’s holder is invalid; without reattachment, the client remains read-only. References: `workspace-terminal.tsx:218-231`.
8. **Handle taskDetached explicitly.** Another client’s takeover sets detached, clears the attach key, and writes a terminal system message. Reclaim only through force-claim from a tab click or banner button (`:294,374`). Clear detachedTaskIds when the task stops being RUNNING or disappears from a new snapshot. References: `workspace-terminal.tsx:207-216`, `use-coflux-client.ts:174-175,222-224`.
9. **Follow markOwned with fit, focus, and ptyResize.** Push local dimensions immediately after gaining control; otherwise the PTY retains the previous holder’s size and renders incorrectly. References: `workspace-terminal.tsx:68-75`.
10. **taskCreate has no request/response correlation.** Track `pendingCreateRef` and use the first previously unknown task ID in incremental state to identify a pending creation and activate it. Clear pending creation when an error arrives (`:233-241`). References: `workspace-terminal.tsx:42,160-165,188-196`.
11. **Hide tabs with display rather than unmounting.** Keep xterms mounted to preserve scrollback and selection. A hidden zero-size container can make `fit()` throw; catch it and retry through ResizeObserver. References: `terminal-pane.tsx:163`, `terminal-pane.tsx:89-96`.
12. **Reset the terminal before restarting an EXITED task**, preventing old output from mixing with the new session. References: `workspace-terminal.tsx:116`.
13. **protobuf-es nested messages are `T | undefined`.** Check every `payload.value.task/daemon/project/workspace` for undefined before use. Follow the existing use-coflux-client.ts:181 convention. References: `use-coflux-client.ts:181`.
14. **Apply snapshots and increments in channel order.** The server sends stateSnapshot before subsequent broadcasts. Apply arrival order directly; add no out-of-order buffer. See the hub.ts:585 ordering comment.


## Scope

In scope:
- `apps/web/**` (src all rewritten, package.json dependency reset, tsconfig/vite configuration, index.css)
- Root `pnpm-lock.yaml` (changes with dependencies)

Out of scope:
- `packages/protocol`, `apps/server`, `crates/**`, `proto/**`, `tests/**` — zero changes to the protocol and backend; black-box tests do not cover the web client
- `.github/workflows/ci.yml` — Existing `tsc -b apps/web/tsconfig.json` checks should continue to pass without changing the CI
- Production deployment (Caddy/prod-jp) - executed by the master session after acceptance, not part of this plan
- Any new functionality (notifications, file trees, git views, task aggregation views, etc.) - explicitly excluded, capabilities remain as they are

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + Build | `pnpm --filter @coflux/web build` | exit 0 |
| CI same typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| React residual check | `grep -rn "react" apps/web/package.json` | No react runtime dependencies |
| Black-box regression (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test` | 37/37 pass |
| UI smoke (acceptance) | dev stack + Playwright browser walkthrough: Login→Add device→Guide project→Build workspace→Multi-Tab terminal→Input echo→Close Tab→Second client takeover→Retakeover→Port preview→Logout | The full main path is available and the takeover semantics are correct |
| production build (acceptance) | `VITE_SUPABASE_URL=<prod url> VITE_SUPABASE_ANON_KEY=<prod key> pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] The capability list is item-by-item equivalent to the old version (first paragraph of Requirement), with no addition or deletion of functions.
- [ ] Landmines The semantics of Listing 1-14 hold true item by item in the new implementation.
- [ ] The PTY data path does not go through any reactive state (visible for code review: ptyOutput → consumer → terminal.write).
- [ ] xterm enables WebGL rendering with context loss fallback.
- [ ] React and its ecosystem dependencies are completely removed from apps/web.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md`  status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (especially: when you find that you need to change the protocol or server to equivalently reproduce a certain capability, stop and report instead of changing the backend).
- A validation command fails twice after one reasonable fix.
- There are compatibility issues between Kobalte or @xterm/addon-webgl and Solid/existing xterm versions that cannot be bypassed (the library change is a change of direction and must be reported).

## Maintenance notes

- This plan’s Landmines list is the reference for attach-state semantics. Update it before changing takeover behavior.
- Cursor style tokens are concentrated in index.css CSS variables; subsequent theme adjustments only change variables but not components.
- Future task aggregation or notifications—the Agent command center’s differentiating features—should add views over this store without changing the protocol client.
