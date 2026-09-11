# Plan 011: Migrate the web client to React 19 and Compiler for ecosystem support while preserving behavior and performance

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8ec535b..HEAD -- apps/web`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none (010 is DONE, this plan uses its products as the baseline)
- Category: refactor
- Execution: subagent sonnet
- Planned at: `8ec535b`, 2026-07-16

## Requirement

Plan 010’s SolidJS rewrite is implemented and accepted. Review found that its long-term ecosystem costs—component libraries, integrations, hiring, and AI-tool familiarity—outweigh rendering-model benefits. The real performance foundation is architectural: PTY bytes bypass reactive state and go directly to terminal.write. That invariant is framework-independent, so migrate apps/web to **React 19 + React Compiler**.

**Functional capabilities, view models, Cursor style and performance baselines are strictly maintained as they are (010 products), and no new features are added**: Login (Supabase ticket exchange/local account dual mode), device management and registration key, project import, workspace creation/deletion, Workspace selection persistence, multi-terminal tab, attach/exclusive takeover, port preview link, `/authorize` device authorization page, `/proxy-auth` previews the domain access control page.

Correctness criterion: every main flow feels unchanged to current users, all multi-client takeover semantics remain equivalent (Landmines 1–14), and high-throughput PTY output causes no perceptible lag.

## Decisions & tradeoffs

- **Use React 19 + React Compiler**, enabling `babel-plugin-react-compiler` through `@vitejs/plugin-react` Babel configuration. The user chose ecosystem support over retaining SolidJS on 2026-07-16. This supersedes plan 010’s framework decision: keeping high-frequency bytes outside React state addresses its earlier VDOM objection.
- **Translate the current Solid implementation’s semantics; do not restore pre-010 React code.** The version before `bc9fec3` lacks plan 010’s pure-TS connection layer, WebGL, exponential reconnect, bundle work, and several state-machine fixes. Restoring it would require redoing that work. Evidence: `apps/web/src/client/connection.ts:1-10` depends only on @coflux/protocol and config, with no framework imports.
- **Keep `client/connection.ts` unchanged.** Its pure-TS WS, three-credential authentication, and exponential-backoff/jitter logic (`connection.ts:15-16,55-56`) needs no migration. Allow only minimal type/interface adaptations if required.
- **Use zustand with a vanilla store, `useStore` selectors, and `useShallow`.** Reject handwritten useSyncExternalStore because this plan favors ecosystem standards, and jotai because atomic state is a poor fit for batch entity updates and cascading cleanup. Control rendering at three levels: fine-grained subscriptions skip unchanged slices; immutable updates preserve references for untouched entities, so changing one task never rebuilds others; React Compiler memoizes parent-child propagation. Derived object/array selectors must use `useShallow`.
- **Preserve direct ptyOutput → consumer registry → `terminal.write`, outside zustand/React state.** Keep the registry as an ordinary Map in the store layer, matching `store.ts:38,46,213-216`. Violating this central performance invariant fails review.
- **Do not enable StrictMode by default (decided during planning).** WS connections, xterm instances, and consumer registrations are imperative resources; double-mount debugging adds little value here, and the Solid version has no equivalent behavior. If the executor enables it, every effect and cleanup must be idempotent.
- **Use radix-ui primitives and retain index.css’s Cursor-style variables.** Translate the seven existing UI components manually: button/dialog/alert-dialog/select/input/textarea/label. A full shadcn CLI/generator setup adds unnecessary output. Keep visual tokens unchanged and aim for pixel-level equivalence. Replace lucide-solid with lucide-react.
- **Keep the xterm stack unchanged:** `@xterm/xterm`, fit, dynamically imported WebGL outside the initial main chunk (`terminal-pane.tsx:64-76`), and `onContextLoss` fallback to DOM rendering.
- **Keep Vite and Tailwind 4, replacing the framework plugin with `@vitejs/plugin-react`.** Restore tsconfig `jsx` to `react-jsx`. Remove `vite-plugin-solid`, `solid-js`, `@kobalte/core`, and `lucide-solid` completely; reject a dual-stack migration.
- **Retain handwritten pathname dispatch and independent WS connections** for `/authorize/<token>`, `/proxy-auth`, and the main page. Add no router. App.tsx already establishes isolation of connections and side effects.
- **Supabase ticket swap remains direct REST fetch, does not reference supabase-js** (`lib/auth.ts` is retained as is).
- **Target no substantial bundle regression, not parity with Solid.** React 19 + Radix will exceed Solid’s 586KB main chunk; require less than 700KB, the pre-010 React baseline. Keep WebGL asynchronous and record final sizes. The performance baseline is about rendering and the PTY runtime path, not bundle size alone.
- **UI copy remains in Chinese and enroll command format remains `npm i -g cofluxd && cofluxd up --server <url> --enroll-key <key>` unchanged** (010 existing decision continues).

## Direction

Preserve plan 010’s layers: unchanged connection.ts → zustand vanilla store translating every store.ts message semantic → React UI. Translate pages/components one for one without redesigning information architecture.

### Milestone 1: Build chain switching + store layer migration

Set up React 19, Compiler, and zustand with passing Vite dev/build, Tailwind, and TS; enable Compiler in vite.config. Preserve all store semantics: three-credential authentication, localStorage `coflux_token`, clearing on authError, direct authenticating state for stored tokens, snapshots, and incremental updates. Preserve cascading cleanup (`store.ts:140-199`): daemon removal clears projects/workspaces/tasks, project removal clears workspaces/tasks, workspace removal clears tasks, task removal clears ports/detached. Retain consumer registration (`store.ts:77-92`) and snapshotRevision increments. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 2: Login + workbench interactive interface

Implement Supabase/local login selected by build-time `USE_SUPABASE`; device → project → workspace sidebar with online state; workspace selection with localStorage `coflux_workspace` and snapshot fallback; import/create/device dialogs with enrollment-command copying and deletion confirmation; dismissible error toasts. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 3: Terminal + attach/takeover state machine + multi-Tab

Translate TerminalPane (xterm, dynamic WebGL, fit, theme) and WorkspaceTerminal (tabs/state machine), preserving Landmines 1–14. Keep port links in tabs and the top bar opening new windows. Validation: `pnpm --filter @coflux/web build` → exit 0.

### Milestone 4: Auxiliary Page + Solid Clear + Finish

`/authorize/<token>` and `/proxy-auth?redirect=` page flow semantic equivalence migration; Solid-js/kobalte/lucide-solid/vite-plugin-solid dependencies and residual imports are deleted; A visual walkthrough confirms that the CSS variable-driven Cursor style is consistent with the current version. Validation: `pnpm --filter @coflux/web build` exit 0, and `grep -rn "solid-js\|@kobalte\|lucide-solid" apps/web/src apps/web/package.json` No matches.

## Landmines

attach/exclusive takeover state machine semantics (1-14 inherited from plan 010, line numbers updated to current SolidJS implementation Location, migration must be maintained item by item):

1. **Four control states:** `stopped | attaching | owned | detached`. Send input/resize only when `active && owned`. Preventing input while detached is a security invariant, not merely a UX detail. References: `terminal-pane.tsx:7`, `terminal-pane.tsx:106-113`.
2. **Attach uses taskStart.** Sending `taskStart{taskId,cols,rows}` to a RUNNING task requests takeover through the server’s startOrAttachTask semantics. There is no separate attach message.
3. **ATTACH_GRACE_MS=500.** If attach produces no ptyOutput because scrollback is empty, mark the terminal owned after 500ms. Any output grants ownership immediately (`:160`). References: `workspace-terminal.tsx:12,94-95`.
4. **Deduplicate attach by `${snapshotRevision}:${sessionId}`.** Attach a session once per snapshot generation; explicit force-claim uses increasing sequence keys to bypass deduplication. References: `workspace-terminal.tsx:82-85`.
5. **Gate attach on sessionReady.** Wait until the ptyOutput consumer is registered with a sessionId, or replay can arrive before registration and be lost. References: `workspace-terminal.tsx:37,81,146`.
6. **Distinguish new starts from attachment.** Tasks started by this client, tracked in launchingTaskIds, become owned as soon as their session is ready. Do not send taskStart a second time. References: `workspace-terminal.tsx:41,116-119,150-152`.
7. **A snapshotRevision change means reconnect/relogin.** Call beginAttach again for every RUNNING task to reacquire its holder. The old connection’s holder is invalid; without reattachment, the client remains read-only.
8. **Handle taskDetached explicitly.** Another client’s takeover sets detached, clears the attach key, and writes a terminal system message. Reclaim only through force-claim from a tab click or banner button. Clear detachedTaskIds when the task stops being RUNNING or disappears from a new snapshot. References: `store.ts:202`.
9. **Follow markOwned with fit, focus, and ptyResize.** Push local dimensions immediately after gaining control; otherwise the PTY retains the previous holder’s size and renders incorrectly. References: `workspace-terminal.tsx:61-75`.
10. **taskCreate has no request/response correlation.** Track `pendingCreate` and use the first previously unknown task ID in incremental state to identify a pending creation and activate it. Clear pending creation when an error arrives. References: `workspace-terminal.tsx:44,165`.
11. **Hide tabs with display rather than unmounting.** Keep xterms mounted to preserve scrollback and selection. A hidden zero-size container can make `fit()` throw; catch it and retry through ResizeObserver. In React, do not use `{active && <TerminalPane/>}`; mount every open tab and toggle style/display. References: `terminal-pane.tsx:159`, `terminal-pane.tsx:86,116-118`.
12. **Reset the terminal before restarting an EXITED task**, preventing old output from mixing with the new session.
13. **protobuf-es nested messages are `T | undefined`.** Check every `payload.value.task/daemon/project/workspace` for undefined before use.
14. **Apply snapshots and increments in channel order.** The server sends stateSnapshot before subsequent broadcasts. Apply arrival order directly; add no out-of-order buffer.

Specific to React migrations:

15. **Stable zustand entity references:** incremental messages recreate only the affected entity and its collection container. Rebuilding untouched entities causes unnecessary selector renders and loses the performance baseline. Use `useShallow` for derived collections such as a workspace’s task list.
16. **Manage imperative xterm/WS resources with useRef/useEffect and complete cleanup.** terminal.dispose also disposes addons (`terminal-pane.tsx:155`). React Compiler optimizes only components following the Rules of React and silently skips violations; consider the latest `eslint-plugin-react-hooks` compiler checks.
17. **Solid-to-React traps:** `untrack(...)` (`workspace-terminal.tsx:84,151`) needs no counterpart; read `store.getState()` directly. Solid component bodies run once, while React bodies rerun. Move one-time Map/Set creation and timer handles into useRef/useEffect instead of leaving them in the function body.


## Scope

In scope:
- `apps/web/**` (all src translation, package.json dependency reset, tsconfig/vite configuration)
- Root `pnpm-lock.yaml` (changes with dependencies)

Out of scope:
- `packages/protocol`, `apps/server`, `crates/**`, `proto/**`, `tests/**` — Zero changes to the protocol and backend; black-box testing without testing web
- `.github/workflows/ci.yml` — Existing `tsc -b apps/web/tsconfig.json` checks should continue to pass
- Production deployment (Caddy/prod-jp) - executed after main session acceptance
- Any new features and visual redesign - capabilities and visuals strictly maintain 010 product status

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + Build | `pnpm --filter @coflux/web build` | exit 0 |
| CI same typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Solid residue check | `grep -rn "solid-js\|@kobalte\|lucide-solid" apps/web/src apps/web/package.json` | No matches |
| Compiler Enable Check | `grep -n "react-compiler" apps/web/vite.config.ts` | Hit |
| Black-box regression (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test` | 37/37 pass |
| UI smoke (acceptance) | dev stack + Playwright browser walkthrough: Login→Add device→Guide project→Build workspace→Multi-Tab terminal→Input echo→Close Tab→Second client takeover→Retakeover→Port preview→Logout | The full main path is available and the takeover semantics are correct |
| production build (acceptance) | `VITE_SUPABASE_URL=<prod url> VITE_SUPABASE_ANON_KEY=<prod key> pnpm --filter @coflux/web build` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] The capability list is equivalent to the current version (010 product) item by item, with no addition or deletion of functions, and the visual appearance is approximately unchanged.
- [ ] The semantics of Landmines 1-17 are established item by item in the new implementation.
- [ ] The PTY data path does not go through any React/zustand state (visible for code review: ptyOutput → consumer → terminal.write).
- [ ] xterm WebGL dynamic loading + context loss fallback retention.
- [ ] solid-js/@kobalte/lucide-solid/vite-plugin-solid completely removed from apps/web.
- [ ] React Compiler enabled in the build chain.
- [ ] Main chunk < 700KB (value included in completion report).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (especially: when it is found that the protocol or server needs to be changed to achieve equivalent replication, stop and report).
- A validation command fails twice after one reasonable fix.
- `babel-plugin-react-compiler` has an incompatibility with the current Vite/React 19 version that causes an unavoidable build Problem (disabling the Compiler is a change of direction and must be reported rather than silently downgrading).
- A certain primitive of radix-ui cannot achieve visual equivalence with Tailwind 4/the existing CSS variable system (replace Module base is a change of orientation and must be reported).

## Maintenance notes

- The document source for attach state machine semantics after this plan is still the Landmines list (1-14 is consistent with plan 010, 15-17 is React-specific); update here first before changing the takeover behavior.
- PTY bytes outside reactive state and stable entity references are the two performance invariants. Evaluate both before changing state libraries or middleware.
- Framework history: React 18 initially → SolidJS in plan 010 for performance → React 19 + Compiler here for ecosystem support. Treat the choice as settled unless the ecosystem materially changes.
