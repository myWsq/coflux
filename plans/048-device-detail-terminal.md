# Plan 048: Move repository-free terminals into device details with one reusable workspace per device

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 97df47b..HEAD -- apps/server/src/hub.ts apps/web/src/components/workbench/ packages/client/src tests/src/no-repo-terminal.test.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none (rewrite the UI form and creation semantics of plan 045)
- Category: feature
- Execution: self
- Planned at: `97df47b`, 2026-07-26

## Requirement

Plan 045 added a sidebar New terminal button, device picker, a fresh directory workspace/task per click, a separate Terminal group, and no tabs. User review replaces that model:

- Device rows become clickable/selectable and open device details in main area.
- Details are the device's terminal workbench, **with tabs, New, and ports**, like project workspaces, but no branch controls or Changes tab.
- **Reuse one canonical directory workspace per device**, enforced on server; tabs are its tasks.
- Remove old sidebar New button, Terminal group, and ImportProjectWizard pickDeviceOnly mode. Device rows are the sole entry.

Selection must remain on device after snapshots. Repeated creation never makes a second workspace, regardless of Web state/races. Device details never expose Git controls.

## Decisions & tradeoffs

- **Render WorkspaceTerminal for canonical directory workspace**. Selection becomes workspace|device. For device, choose matching isDirWorkspace+daemonId with earliest createdAt, or show device-level empty state. Converting selection to workspace ID would lose device selection when no workspace exists and highlight an invisible row. Main area is selection-driven, not routed (App.tsx:6-11, workbench.tsx:34).
- **Server terminalCreate is idempotent**: reuse earliest existing directory workspace and create only task; otherwise create both. Web with known workspace sends taskCreate directly. Web-only checks fail across clients/races. Current unconditional creation is hub.ts:1285-1318; taskCreate already permits directory workspaces at :1388-1393.
- **Explicitly supersede two 045 decisions**: render directory terminal tabs/New/ports, excluding BranchMenu/separators/Changes; remove Mod+T single-task restriction. Keep historical 045 text. Existing gates: workspace-terminal.tsx:420, :279-281; preserve ChangesView exclusion at :591.
- **No UI aggregation for old duplicate workspaces**, a planning departure from exploration's flattened-tabs idea. Only earliest canonical is reachable; user manually cleans the single-digit legacy records with SQL after rollout. Generalizing WorkspaceTerminal's workspaceId-filtered state machine (:47-59), or permanent migration code, is unjustified for one-time data.
- **Closing tab removes task**, using existing running confirmation/closeTask. Retain workspace after last tab for reuse. Remove Web's directory-workspace removal confirmation at workbench:183-191 with its sole Terminal-group entry. **Keep server workspaceRemove directory branch** at hub.ts:1327-1342 for device cascade, old clients, and tests; device removal remains cascading at workbench:200-207.
- **Offline/empty behavior**: offline details remain viewable with retained terminal/checkpoint; disable creation needing fsList/taskStart. No workspace: Workbench empty state creates via listDeviceDirectory(daemonId,"~") then terminalCreate (existing :126-134). Existing empty workspace: WorkspaceTerminal :566-577 uses taskCreate. Match both empty states visually.
- **Persist selection union in localStorage**, using WORKSPACE_KEY or new key at executor discretion, accepting old bare workspace-ID values. Snapshot reconciliation preserves device if still in daemons, otherwise existing fallback; current :63-77 only understands workspace and falls back to first project's main.
- **No mobile/iOS adaptation**: mobile frozen, iOS outside slice. Shared changes must not break builds. Put any canonical helper alongside isDirWorkspace in packages/client/src/store.ts:100-104; avoid scattered predicates.

## Direction

Device click→device selection→canonical workspace→WorkspaceTerminal, or empty device view. Initial fsList("~")/terminalCreate emits workspace/task broadcasts and naturally populates selected view. Later tabs use existing createTerminal/taskCreate.

### Milestone 1: Server reuse and black-box update

Implement reuse. Rewrite no-repo-terminal.test.mjs:53-64's opposite "fresh workspace every time" assertion: second terminalCreate adds a task to first workspace. Preserve create/cwd/remove/empty-path tests.
Validation: server tsc and historical 54322-PG full-suite command below pass.

### Milestone 2: Device details and removal of old entry points

Add selected device row matching workspace styling (sidebar:311-321), device main branch, restored tab bar, two empty states, offline creation disabling. Remove top button :210-217, Terminal group :383-439, pickDeviceOnly wizard and second instance at workbench:388-400, plus dead onNewTerminal props/removal confirmation. Web/mobile types pass, the latter only checks shared compatibility.

## Landmines

1. SnapshotRevision reconciliation at workbench:63-77 must accept device selections or immediately return to project view.
2. selectedDaemonId/retainDevice at :60/:88-91 must use selected device directly; otherwise details never establishes route/attach.
3. Add canonical workspace to visitedWorkspaceIds/terminalWorkspaces retention (:37/:228-235), still filtered out on removal. Active ref belongs only to active instance (:48-50/:330), preventing shortcuts reaching wrong workbench.
4. workspaceCreated is upsert, already used by rename (hub.ts:1358-1360), but pendingWorkspaceCreateRef identifies unknown IDs (:138/:146-155). Reuse yields none. Device is already selected; do not copy that pending-switch mechanism.
5. Separate WorkspaceTerminal pendingCreateRef/creating for taskCreate (:276-285/:308-315) from Workbench first terminalCreate; each cleans errors independently (:158-161 and :342-351).
6. document.title currently understands projects only (:80-84); use device name/default to avoid stale project title.
7. Reuse test file's exclusive port 8854 (:12). New files need unused ports. Historical local PG configuration is direct 54322.

## Scope

In scope:
- apps/server/src/hub.ts reuse
- Web workbench/sidebar/workspace-terminal/import wizard/dialogs
- apps/web/src/config.ts if new persistence key
- packages/client/src canonical helper if needed
- tests/src/no-repo-terminal.test.mjs and plans/README.md

Out of scope:
- proto/generated files; Workspace.daemon_id already exists (common.proto:36)
- crates daemon/supervisor/relay
- mobile/iOS features, only preserve builds
- Legacy duplicate migration, manual cleanup
- Push/PR/release

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile compatibility | `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` | exit 0 |
| Black-box | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| UI acceptance | User manually verifies, no Claude walkthrough | User confirmation |

## Done criteria

- [ ] All listed commands pass.
- [ ] Black-box assertions prove a second terminalCreate on the same device reuses the workspace and creates only a task; existing creation, PTY cwd, deletion, and empty-path cases still pass.
- [ ] Clicking a device row highlights selection and shows device details in the main area; incoming snapshots do not steal selection.
- [ ] The device header contains only terminal tabs, New, and ports, without branch controls or Changes; repeated Mod+T creates multiple tabs.
- [ ] All three old entry points—the top button, Terminals group, and pickDeviceOnly—are removed without dead code.
- [ ] Offline devices disable creation while still displaying existing terminal state.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited fact changes or out-of-scope proto/crates edits required.
- Validation fails twice after one reasonable fix.
- taskCreate directory permission at hub.ts:1388-1393 was removed/tightened, invalidating multi-tab premise.

## Maintenance notes

- Canonical earliest-created directory workspace is shared Web/server contract; review changes together and centralize isDirWorkspace.
- Legacy duplicates are unreachable but harmless until user cleanup with `delete from workspaces where project_id = '' and...` plus tasks, or temporary cascading device removal. They participate only in canonical selection.
- Historical 045 stays intact; this plan supersedes its UI/creation semantics.

### Original source references

`apps/web/src/App.tsx:6-11`, `apps/web/src/components/workbench/workbench.tsx:34`, `apps/server/src/hub.ts:1285-1318`, `apps/server/src/hub.ts:1388-1393`, `apps/web/src/components/workbench/workspace-terminal.tsx:420`, `workspace-terminal.tsx:279-281`, `workspace-terminal.tsx:591`, `workspace-terminal.tsx:47-59`, `workbench.tsx:183-191`, `apps/server/src/hub.ts:1327-1342`, `workbench.tsx:200-207`, `workbench.tsx:126-134`, `workspace-terminal.tsx:566-577`, `workbench.tsx:63-77`, `sidebar.tsx:311-321`, `sidebar.tsx:210-217`, `sidebar.tsx:383-439`, `workbench.tsx:388-400`, `workbench.tsx:60`, `workbench.tsx:37`, `workbench.tsx:48-50`, `apps/server/src/hub.ts:1358-1360`, `workbench.tsx:138`, `workspace-terminal.tsx:276-285`, `workbench.tsx:158-161`, `workspace-terminal.tsx:342-351`, `workbench.tsx:80-84`, `no-repo-terminal.test.mjs:12`, `proto/coflux/v1/common.proto:36`.
