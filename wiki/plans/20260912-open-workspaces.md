# Plan 20260912-open-workspaces: Keep opened workspaces within reach

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent — host-supported default; one implementation package, orchestrator verification.
- Stop after: implementation — the user accepted opening as the enrollment trigger and asked to try it.
- Workspace: isolated — `/Users/wsq/.coflux/worktrees/c3e4f5bf-2ddc-4633-a03f-ecfb6566c0b3`, branch `dev/20260912-open-workspaces`.
- Planned at: `67b5175`, 2026-09-12
- Commit gate: repository-required checks run before any commit, including the plan handoff; this overrides skill-level early commits.

## Requirement

Add a compact Workbench section above Projects in the desktop sidebar. It lists opened workspaces across projects so users can resume work without searching the project tree. Opening a workspace adds it once, in stable insertion order. Switching never reorders it. Entries show workspace, project, device context and the existing agent activity indicators. An empty section explains how to open a workspace; initial loading must not imply an empty catalog.

Users explicitly close entries from this section; task completion, terminal exit, offline devices, elapsed time, reconnects and app restarts never close them. Closing is a local navigation action that preserves the actual workspace, code, running terminals and terminal state. Provide an individual close button, Close Others, and a lightweight batch selection mode with close-selected and cancel. Closing the selected workspace selects a remaining neighbor, or leaves the main area empty if none remain. Closing background entries preserves selection. Reopening through Projects restores the entry.

## Decisions & tradeoffs

- **Open enrolls automatically**: explicitly chosen by the user. No pinning step or timeout cleanup.
- **Persist client navigation**: store the opened list and selection locally, isolated by server and account where an established account ID is available. No new server/protocol contract or cross-client synchronization. Handle unavailable/corrupt storage gracefully.
- **Stable list membership is independent of activity**: task state is presentation only. Confirmed entity deletion may remove obsolete IDs; pre-snapshot emptiness, offline cached catalogs and authentication transitions must not destroy saved entries.
- **Navigation close is non-destructive**: do not call workspaceRemove, task close/stop, session detach, or change the terminal keep-alive policy. Existing mounted terminal state is intentionally retained in `workbench.tsx:548` and `:555`.
- **Empty stays empty**: replace automatic first-project fallback for intentional empty selection with opened-list-aware selection. Existing fallback in `workbench-state.ts:72` otherwise immediately undoes closing the last entry. Initial migration can carry forward a valid previously selected workspace; do not enroll every workspace.
- **All entry paths agree**: project clicks, successful workspace creation, notification focus, and active-terminal workspace moves enter the opened list; optimistic IDs never persist. Device detail navigation remains supported and must not be hijacked by close-background actions. Keep existing device directory workspaces functional.
- **Reuse existing visual conventions**: Tooltip for icon hints, ActivityDots for status, existing sidebar density and widths. No visual redesign of the project tree.

## Direction

One dependent implementation package: persistent opened-list state and selection semantics first, then sidebar interactions integrated with all selection paths. Keep pure navigation decisions testable in-process. The executor chooses helper boundaries and details of batch controls against the live code.

Validation: desktop typecheck and desktop tests, including meaningful state-transition regressions for last-close, reopening, persistence, offline preservation, deletion, and background close. Build the desktop renderer. After code review, exercise the real rendered UI at default and minimum sidebar/window sizes with isolated fixtures and verify close actions preserve running tasks.

## Landmines

- `workbench.tsx:330`: snapshotRevision can be positive for cached offline catalog; it is not proof of a fresh authenticated server snapshot (`packages/client/src/store.ts:385`).
- `workbench.tsx:274`: active terminal relocation updates selection synchronously before child effects; do not reintroduce lost focus or attach churn.
- `workbench.tsx:427`: optimistic workspace creation uses temporary IDs and asynchronous reconciliation.
- `workbench.tsx:548`: visited workspaces and task-ID-keyed panes are terminal lifetime bookkeeping, not the new navigation list.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/` — navigation helpers/tests, sidebar/workbench integration; preserve unrelated terminal behavior.
- `apps/desktop/src/renderer/config.ts`
- `wiki/plans/20260912-open-workspaces.md`
- `wiki/plans/README.md`

Out of scope: server, daemon, shared protocol/client schema, iOS, release/deployment, git worktree cleanup, stopping terminal processes, background resource eviction.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Required commit gate (acceptance) | `pnpm -C tests test` | Rust build without warnings and full black-box suite passes |
| UI (acceptance) | Isolated desktop renderer interaction and screenshot inspection | Open, switch, close, batch-close, reload, offline preservation; no task stop/removal |

## Done criteria

- [x] Opened workspaces persist with stable order; confirmed close remains closed.
- [x] Individual, other, and batch closes preserve real work and selection semantics.
- [x] Entry paths, first-load, offline, deletion and storage edge cases are covered.
- [x] Required checks and visual acceptance complete; limitations recorded explicitly.
- [x] Only in-scope files changed; plan index updated.

## STOP conditions

- Requires changes to server/protocol or terminal lifecycle.
- A validation fails twice after one reasonable fix.
- A cited assumption is disproven and cannot be resolved within the settled behavior.

## Verification evidence

- Desktop typecheck: passed.
- Desktop unit suite: 95 tests passed, 0 failed, including 8 new navigation cases.
- Desktop production build: passed with no warnings.
- Required Rust build and black-box suite: 215 tests passed, 0 failed; Rust build emitted no warnings. The suite ran in the isolated worktree using the unchanged Rust/server code and temporary harness databases.
- Reviewed all source changes; existing terminal keep-alive and pane-lifetime code is preserved.
- Rendered the actual Workbench, Theme and production CSS against an isolated client/bridge/catalog fixture. Verified stable opening order, single close, Close Others, batch cancel/close, empty persistence after reload, notification enrollment, offline preservation, confirmed deletion, account switching/restoration, first-use device workspace creation, canonical-device close, optimistic creation success/failure, and task relocation before its workspace entity arrived. Closing navigation emitted no task close/remove calls or session-consumer disposal; moving the active terminal kept one consumer registration.
- Inspected screenshots at 1280 x 800 with a 260px sidebar and 1024 x 640 with a 200px sidebar. Batch controls fit without horizontal page overflow.
- UI acceptance uses fixture data and does not claim a packaged Electron release or a live daemon end-to-end UI test. No production deployment or release was performed.
