# Plan 081: Rename projects through the context menu, matching devices and workspaces

> This plan is an outcome contract, not a step-by-step script. Understand the requirement and decisions, then design implementation against live code.
> Self-execution: the implementer also verifies, running milestone checks along the way. Stop on any STOP condition.
> Update `plans/README.md` when complete.
>
> Drift check: `git diff --stat f3a40d1..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/web/src/components/workbench/ tests/src/`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `f3a40d1`, 2026-08-20

## Requirement

The original request was to edit configuration on a workspace settings page. Exploration narrowed it down: name, the only meaningful editable workspace property, already has context-menu renaming. The actual gap is **Project: its name is locked after import, with no edit entry point**. client.proto only has ProjectImport/ProjectRemove.

Afterward, right-clicking a web sidebar project offers Rename, opens a naming dialog, and updates all online web/iOS clients immediately; refresh preserves the name. No new settings page.

The correct entry is a **project-row context-menu item plus rename dialog**, matching device (`sidebar.tsx:583`) and workspace (`:381`). Separate settings pages/dialogs or opportunistic default_branch/repo_path editing are incorrect solutions.

## Decisions & tradeoffs

- **Only context-menu renaming, no settings page.** A single name field does not justify a new UI pattern. Project rows already have ContextMenu at sidebar.tsx:260-266.
- **No manual default_branch editing.** Plan 072 makes worker correct server cache whenever local origin/HEAD differs (`crates/worker/src/main.rs:1034-1050`). Manual edits would be overwritten on the next inventory dispatch. Device owns truth; center DB caches it. Based on workspaceDefaultBranch comments at hub.ts:1172.
- **Reject empty names; no fallback.** Match device semantics at hub.ts:1652-1654. Rejected: workspace's empty-name-to-branch fallback at :1643. Workspace has a natural branch fallback; project's import-time remote-derived name (020) is not a readily available current value, and rerunning inference is unjustified. Block empty names in server and dialog.
- **Reuse projectCreated broadcast as upsert; no new downstream message.** Client store.ts:470-474 already upserts it; 072 uses the same path for default_branch corrections at hub.ts:1183. No packages/client changes; iOS/mobile sync automatically.
- **Add proto `ProjectSetName { project_id, name }` at oneof field 37.** Current ClientToServer max is 36 (DeviceP2pChannelOpen). Reserved 4/16/17/19-23/25/29-31 cannot be reused. Follow WorkspaceSetName at client.proto:82 and DeviceSetName at :88, documenting empty-name rejection.
- **Validate accountId ownership.** Workspace/device handlers at hub.ts:1642/:1651 silently return for x.accountId !== client.accountId; follow the same pattern. Store uses a single UPDATE RETURNING, matching updateWorkspaceName at store.ts:866.

## Direction

### Milestone 1: Protocol/server persistence and broadcast

Add ProjectSetName to `proto/coflux/v1/client.proto`. Run buf generate from proto/; clean:true rebuilds TS/Rust/Swift outputs, all committed together. Add hub handler and store.updateProjectName, then broadcast projectCreated.

Add black-box renaming coverage following `tests/src/device-rename.test.mjs`'s two-client broadcast/persistence assertions. Create the project with existing mkRepo/import patterns.

Validation: server tsc --noEmit exits 0; `cargo build -p coflux-supervisor -p coflux-worker` exits 0 with zero warnings after generated Rust recompilation; `pnpm -C tests test` all green including new tests.

### Milestone 2: Web context menu and dialog

Add Rename to project ContextMenu at sidebar.tsx:260-266, currently New workspace/Remove project. Add ProjectRenameDialog following DeviceRenameDialog at dialogs.tsx:82, including blocked empty submission. Wire workbench.tsx following workspaceSetName at :290. Match workspace menu ordering: Rename before the divider, destructive Remove project afterward.

Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` exits 0.

## Landmines

- buf.gen.yaml clean:true **clears and rebuilds** packages/protocol/src/gen, crates/protocol/src/gen, and proto/gen/swift. Widespread unrelated diff means plugin-version drift: STOP and report, do not commit it.
- Ownership mismatch silently returns without error response. Tests should observe broadcasts/snapshots, not wait for errors.
- Black-box tests run serially (`--test-concurrency=1`), and each file starts a stack at its own fixed PORT. Choose an unused one; device-rename uses 8843.
- Historical AGENTS.md required green relevant tsc, zero-warning cargo build, and full tests before commit, plus Chinese commit messages and a Co-Authored-By trailer. The repository's current English language policy supersedes the historical commit-language rule.

## Scope

In scope:
- `proto/coflux/v1/client.proto` and all three generated output locations
- `apps/server/src/hub.ts`, `apps/server/src/store.ts`
- `apps/web/src/components/workbench/{sidebar,dialogs,workbench}.tsx`
- New project-rename tests in `tests/src/`
- `plans/README.md` status

Out of scope:
- packages/client: projectCreated upsert already exists at store.ts:470
- Frozen apps/mobile and apps/ios: broadcasts update them automatically
- Editing default_branch/repo_path
- Separate settings pages/dialogs

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Black-box integration | `pnpm -C tests test` | All green |
| Web UI acceptance | User verifies manually; established convention excludes Claude UI verification | User confirmation |

## Done criteria

- [ ] All commands pass, except UI walkthrough delegated to user.
- [ ] Project context menu offers Rename; two clients see broadcast updates and persistence.
- [ ] Server/dialog reject empty and whitespace-only names.
- [ ] New black-box tests assert broadcasts/persistence using existing harness.
- [ ] Every decision followed.
- [ ] No out-of-scope changes; generated outputs are in scope.
- [ ] plans/README.md updated.

## STOP conditions

- A cited fact changes, such as occupied field 37 or changed projectCreated upsert semantics.
- Out-of-scope changes required, especially packages/client.
- Validation fails twice after one reasonable fix.
- buf generate produces widespread unrelated plugin-drift changes.

## Maintenance notes

- Project name is a display alias, never a path/branch input. Remote-derived naming from 020 runs once at import and will not overwrite later renames.
- Reconsider a settings dialog only if more project settings emerge. For one item, direct context-menu access is simplest.

### Original source references

`sidebar.tsx:381`, `apps/server/src/hub.ts:1172`, `hub.ts:1643`, `packages/client/src/store.ts:470-474`, `client.proto:88`, `hub.ts:1651`, `workbench.tsx:290`.
