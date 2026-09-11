# Plan 032: apps/mobile: a streamlined mobile Agent command center

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 3f45104..HEAD -- packages/client apps/web/src/components/workbench/parse-diff.ts apps/web/src/components/workbench/changes-view.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/web/index.html`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: plans/031-extract-client-package.md
- Category: feature
- Execution: subagent sonnet
- Planned at: `3f45104`, 2026-07-23 (baseline after 031 DONE)

## Requirement

Create an independent mobile web app, `apps/mobile` (`@coflux/mobile`), for controlling remote agents from a phone. It is intended for separate deployment at m.coflux.dev; deployment itself is out of scope. Leave desktop apps/web unchanged.

Functional surface (a subset relationship with desktop, reorganized according to mobile scenarios):

1. **Login**: reuse `@coflux/client` for the same Supabase/local-account dual-mode authentication as desktop.
2. **Workspace/task overview**: group workspaces by project, showing task status, diff statistics (+X −Y), and device connectivity. Selecting a workspace opens its detail page.
3. **View and interact with terminals**: workspace details show terminal tabs with xterm output. System keyboard/IME provides text; a shortcut bar adds Esc, Tab, arrows, Enter, and Ctrl combinations such as Ctrl+C, sufficient for Claude Code/TUI menu selection, interruption, slash commands, and confirmation. Preserve desktop holder semantics: attach takes control, detachment is visible, and users can reclaim control.
4. **Light terminal management**: create/close terminal tabs and reclaim control.
5. **Changes view**: cumulative workspace file diffs and per-file hunks, using simple line coloring.

Excluded until desktop use or later versions: import wizard, device enrollment/rename/removal, workspace creation/deletion/rename, branch switching, port-forwarding management, global shortcuts, and drag-and-drop/image uploads.

Do not squeeze the desktop workbench, permanent sidebar, hover actions, and full feature set into a phone. Use two-level list→detail navigation with touch-first interactions. Keep scope deliberately small but useful, especially a shortcut bar that can actually drive TUIs.

## Decisions & tradeoffs

- **Two-level navigation**: home lists workspaces grouped by project with status badges. Workspace detail has back/branch/terminal tabs/changes entry above mutually exclusive terminal and changes views. No permanent sidebar, right-click menus, or hover-only actions. Rejected: forking desktop layout, the reason plan 030 was withdrawn.
- **Reuse `@coflux/client` completely** (plan 031): connection/authentication, snapshot/incremental reduction, PTY consumers, pending maps, and holder semantics (`startTask` takes control, `detachedTaskIds`, `taskDetached`) come from the shared package. Do not rewrite protocol logic in mobile. Use zustand `useStore`, matching web (`apps/web/src/components/workbench/workbench.tsx:50-58`).
- **Terminal rendering**: use `@xterm/xterm` 6.0 and `@xterm/addon-fit`, aligned with `apps/web/package.json`. Omit WebGL conservatively for mobile GPU compatibility; DOM rendering is sufficient. Choose fontSize 13–14, slightly larger than desktop. Server mirror snapshots already supply attach replay (`apps/server/src/mirror.ts`), requiring no mobile protocol changes. Copy the desktop full-width IME punctuation workaround, `patchImeCommittedInput` (`apps/web/src/components/workbench/terminal-pane.tsx:55-88`, xtermjs/xterm.js#5887), because mobile uses the same affected textarea path.
- **Shortcut bar**: keep it below the terminal, with visualViewport handling placing it above the on-screen keyboard. Initial keys: Esc, Tab, ↑ ↓ ← →, sticky Ctrl, and Enter. Enabling Ctrl modifies the next letter (Ctrl+C = \x03); arrows use CSI \x1b[A/B/C/D. Send through `client.sendInput` only while owned, matching `apps/web/src/components/workbench/terminal-pane.tsx:269-273`. The executor may adjust individual keys, but sticky-Ctrl interaction is fixed. Rejected: long-press combination menus, which add unnecessary first-version complexity.
- **Simple changes view without shiki**: display files and +/−-colored hunk lines without syntax highlighting; shiki language bundles/memory are a desktop tradeoff. Reuse desktop fetching semantics through `execInWorkspace` and copy the 127-line pure parser `apps/web/src/components/workbench/parse-diff.ts` into mobile. Do not copy shiki’s `diff-highlight.ts`. Rejected: expanding shared package boundaries merely to avoid this small deliberate duplication; see Maintenance notes for extraction criteria. Match `apps/web/src/components/workbench/changes-view.tsx` commands and defaultBranch/merge-base semantics.
- **Three viewport measures** from withdrawn plan 030: use `h-dvh`, not h-screen; add `interactive-widget=resizes-content` for Android Chrome; handle iOS `visualViewport` resize by clamping root height. Terminal and shortcut bar move above the keyboard, keeping the input line visible. ResizeObserver refits automatically.
- **Match apps/web tooling**: Vite 6, React 19 with Compiler Babel plugin, Tailwind 4, Astryx, `@coflux/protocol`, and `@coflux/client`. Reuse layer declarations/theme variables from `apps/web/src/index.css`, including the near-black IDE palette. config.ts uses `VITE_COFLUX_SERVER`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`; production must inject Supabase variables as for web. Copy the 23-line `loginWithSupabase` into mobile lib. Give mobile separate localStorage keys such as `coflux_m_*` to avoid same-origin desktop/debug collisions. Rejected: Ionic or another mobile stack, whose long-term divergence costs exceed benefits.
- **PWA**: provide an independent `manifest.webmanifest`, a distinct name such as “coflux m”, icons, and `apple-mobile-web-app-*` metadata. As in plan 022, omit service workers to avoid cache-invalidation complexity. Adapt icons from `apps/web/public/` if useful.
- **Simplify keepalive** (decided while planning): desktop keeps visited workspaces mounted (`workbench.tsx:33-36`) to follow several in parallel. Mobile version one retains only tabs in the current workspace detail, using `terminal-pane` display toggles so tab switching preserves scrollback. Leaving details unmounts/detaches terminals to save memory; reentering restores them quickly from mirror snapshots.

## Direction

Build the app from scratch using existing references: copy apps/web project configuration; consume `@coflux/client`; adapt `terminal-pane.tsx`, removing drag/image paste/WebGL/dpr handling while retaining xterm, fit, IME patch, consumers, and input gating. Simplify `workspace-terminal.tsx` attachment logic for one workspace without hidden-instance matrices. Prefer Astryx components; configure mobile dependencies before querying `pnpm exec astryx`.

### Milestone 1: Engineering Skeleton + Login

`pnpm --filter @coflux/mobile build` succeeds; dual-mode login works and the store receives a snapshot after authentication. Validate mobile build and `pnpm --filter @coflux/web build`, both exit 0.

### Milestone 2: Workspace List → Detail Navigation

Show project grouping, task/diff/device status, and working list/detail navigation. Browser back gestures must return through navigation without losing login; use History API or minimal hash routing, chosen by the executor, without a routing library. Validation: both builds above pass.

### Milestone 3: You can watch and chat on the terminal

Workspace details render terminal tabs with correct attach/takeover/detached state. System keyboards accept Chinese and English, shortcut keys emit correct sequences, and New/Close Tab work. Validation: both builds above pass.

### Milestone 4: Change View + PWA Finishing

Render file/hunk diffs and finish manifest, icons, viewport metadata, and visualViewport handling. Validation: both builds above pass.

## Landmines

- iOS Safari does not dispatch contextmenu on long press and has no hover. Do not introduce ContextMenu/Tooltip-only actions into the touch interface.
- Preserve the zero-size fit guard from `terminal-pane.tsx:240-252`; fitting a display-hidden tab can send 2×1 ptyResize and corrupt the remote screen.
- Gate input/resize on owned state (`terminal-pane.tsx:269-277`). Shortcut-bar input must use the same gate, preventing observers from injecting control sequences into a session held elsewhere.
- Register the session consumer before taskStart or replay bytes can arrive before registration and be lost. Preserve the sessionReady gate (`terminal-pane.tsx:422-435`).
- `snapshotRevision` changes on reconnect/relogin; the server cleared the old holder. Reattach the currently viewed terminal (`workspace-terminal.tsx:336-352`) or it becomes read-only.
- The xterm 6 IME patch depends on private fields. If any are absent, skip the whole patch and retain upstream behavior, as already guarded at `terminal-pane.tsx:62-66`.
- Include Astryx `reset.css`/`astryx.css` and correct CSS layer declarations (`apps/web/src/index.css:1-12`), or component styling breaks.
- Integrate the new app with `tsconfig.base.json` and configure `@/` as in web’s tsconfig/Vite setup so `tsc -b` includes it.

## Scope

In scope:

- `apps/mobile/**` (new)
- Root `package.json` (optional: `dev:mobile` script)
- `pnpm-lock.yaml` (updated with install)

Out of scope:

- `apps/web`, `apps/server`, `crates/`, `packages/*`: leave desktop, server, and shared packages unchanged. Stop and report gaps in packages/client rather than patching it here.
- Deployment/DNS/Hosting Configuration (online action of m.coflux.dev) - Operation and maintenance actions will be handled separately
- Import wizard, device management, workspace/branch management, port forwarding UI - beyond the functional surface

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| mobile build | `pnpm --filter @coflux/mobile build` | exit 0 |
| Desktop regression build | `pnpm --filter @coflux/web build` | exit 0 |
| Mobile terminal acceptance (acceptance) | Local server+daemon+mobile dev, Playwright MCP 390×844 touch screen: Login → List → Details → Terminal output is visible, keyboard input and shortcut key bar (Esc/arrow keys/Ctrl+C) drive TUI → New/Close Tab → Change view | Full process available, no horizontal scrolling |
| Desktop regression smoke test (acceptance) | Playwright MCP 1440×900 through desktop main flow | Consistent with baseline |

## Done criteria

- [ ] Both build commands pass.
- [ ] The full acceptance flow works at 390×844; the shortcut bar drives TUI arrow navigation, Esc dismissal, and Ctrl+C interruption.
- [ ] The control semantics are consistent with the desktop: the desktop receives a detached prompt when the mobile takes over, and vice versa.
- [ ] apps/web does not have any diff (except package.json/lockfile in scope).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (including `packages/client` capability gap).
- A validation command fails twice after one reasonable fix.
- plan 031 not DONE.

## Maintenance notes

- parse-diff.ts duplication is intentional. Extract into `packages/` when a third consumer appears or bug fixes start diverging; assess whether to include changes-data fetching then.
- The shortcut-bar key list will likely evolve after real Claude Code use reveals missing keys. Keep label→sequence definitions as data so additions require no structural changes.
- Unmounting terminals when leaving detail depends on server mirror snapshots for restoration. Revisit this assumption if mirror.ts semantics change.
