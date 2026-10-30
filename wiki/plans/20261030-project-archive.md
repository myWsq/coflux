# Plan 20261030-project-archive: Archive a project out of the sidebar, restore or delete it from settings

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 32d8ede1..HEAD -- proto apps/server/src packages/client/src packages/protocol/src apps/desktop/src/renderer apps/ios/Coflux packages/swift-client/Sources packages/cli/skills integrations/claude-plugin`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree; work lives in `.claude/worktrees/20261030-project-archive` on `dev/20261030-project-archive`
- Planned at: `32d8ede1`, 2026-10-30

## Record

### Requirement

Today a project leaves the sidebar only by being removed, which deletes its record and its worktrees.
A user who is done with a project for now, but may come back to it, has no way to get it out of the
sidebar without losing it. After this change a project can be **archived**:

- **Entry.** In the sidebar, the project row's right-click menu offers 「归档项目」 where it offered
  「移除项目」. Removal is no longer offered in the sidebar; permanent deletion happens only from
  settings, after archiving.
- **Confirmation.** When the project has live terminals, archiving asks first ("归档后其工作区里的 N
  个终端会被关闭，可在 设置 → 已归档项目 里取消归档"). Without live terminals it applies immediately.
- **Effect.** The project and its workspaces leave the sidebar and the ⌘P palette at once, on every
  client of the account (desktop and iOS). Every terminal in the project's workspaces is closed and
  its record deleted, so unarchiving brings the workspaces back with no terminals. A selection inside
  the project falls back as it does after a removal. If the project's device is offline, archiving
  still succeeds; shells that survive on that device later show as the device row's existing
  「本地 N」 orphan badge.
- **Frozen.** While archived, nothing can open a workspace or a terminal in the project: the desktop,
  the account CLI and a local agent's `coflux terminal new` are all refused with 「项目已归档」.
  `coflux project import` of the archived project's repository unarchives it and returns it as already
  imported.
- **Settings.** A new section 「已归档项目」 sits in its own navigation group after Agents. It lists one
  row per archived project — the name, then device · repository path · archived date — with
  [取消归档] and [删除]. 删除 uses the existing remove-project confirmation. Empty state: 「没有已归档的项目」.
- **CLI.** `coflux project list` keeps listing archived projects; each carries `archivedAt`.
- **Non-goals.** Archiving workspaces or devices, an archived group in the sidebar, bulk actions,
  auto-archive, archive controls on iOS.

Observable when done: archive a project that has a live terminal on one Mac → it disappears from the
sidebar and palette on both Macs and the terminal is gone; it is listed in settings; 取消归档 brings it
back without terminals; 删除 from settings removes it permanently.

### Decisions & tradeoffs

- **D1 Account-wide flag on the project**: the archived state is a centre-persisted, centre-clocked
  timestamp on the project (`archived_at`, ms epoch, absent when active), carried on the wire
  `Project` message and broadcast to every client of the account. Rejected: a desktop-local
  preference — closing terminals is an account-wide effect, so a local-only hide would be
  inconsistent with it. Based on: Discussion log (scope); `proto/coflux/v1/common.proto` `message Project`.
- **D2 Archiving deletes the project's terminals**: every task in every workspace of the project goes
  through the same teardown as removing a terminal (session closed, record deleted, `taskRemoved`
  broadcast). Rejected: hide only (terminals keep running out of sight); refuse while running;
  closing sessions but keeping exited records (unarchive would show dead tabs). Based on: Discussion
  log; `removeTaskRecord` in `apps/server/src/hub.ts`.
- **D3 Flag first, then teardown**: the archive commits the flag under the project row lock before the
  centre enumerates tasks to tear down. Any creation that commits before the flag is in the
  enumeration; any creation after it is refused (D4), because each creation re-reads the archived
  state on the row it holds locked (revised on plan audit). Rejected: enumerating first — a task created
  between enumeration and flag would survive in an archived project. Based on: `claimActiveProject`
  (`apps/server/src/store.ts`, `SELECT … FOR UPDATE`) is the row lock the creation paths already take.
- **D4 Archived means frozen**: every admission that refuses a project being deleted also refuses an
  archived project, with the message 「项目已归档」 (not the deleting message). Rejected: hidden but
  usable — work could run out of sight. Based on: Discussion log (dormancy); creation call sites of
  `claimActiveProject` and `isProjectDeleting` in `apps/server/src/hub.ts` and
  `apps/server/src/prepared-operation-convergence.service.ts`, including the agent-control
  `terminalNew` path a local `coflux terminal new` takes.
- **D5 Re-import unarchives**: importing the repository root of an archived project reuses that
  project, clears its archived state, broadcasts it, and reports it as already imported. Rejected:
  refusing the import; creating a second project for the same repository root (breaks the
  one-project-per-root rule). Based on: the reuse branch in `prepared-operation-convergence.service.ts`
  ("One repository root on one device has exactly one project").
- **D6 Offline device does not block archiving**. Rejected: refusing with 「设备离线」 — a project on a dead
  machine could then never be archived. Based on: Discussion log (offline device); the 「本地 N」 orphan
  badge in `apps/desktop/src/renderer/components/workbench/sidebar.tsx` already covers surviving shells.
- **D7 One new client command, no new downstream message**: `ProjectSetArchived { project_id, archived }`;
  the centre answers by broadcasting the updated project on the existing `projectCreated` upsert, the
  way `projectSetName` does. Rejected: dedicated `ProjectArchived`/`ProjectUnarchived` broadcasts —
  clients already upsert on `projectCreated`. The device protocol is untouched, so no runtime release
  and no protocol version bump. Based on: `case "projectSetName"` in `hub.ts`; `case "projectCreated"`
  in `packages/client/src/store.ts`.
- **D8 Capability flag on `AuthOk` (decided while planning)**: the centre advertises `project_archive`;
  a desktop connected to a centre without it keeps today's 「移除项目」 in the sidebar and shows the
  settings section as unsupported. Rejected: assuming support — a new desktop against an older
  (self-hosted) centre would lose project removal entirely, because D11 takes it out of the sidebar.
  Based on: the existing `AuthOk.agent_settings` → `agentSettingsSupported` pattern.
- **D9 One definition of "visible" in the client package (decided while planning)**: archived projects
  stay in the store's `projects` array with `archivedAt` set; a single helper exported from
  `@coflux/client` decides whether a project — and so each of its workspaces — is visible, and every
  desktop surface that lists projects or workspaces, or validates a selection against them, goes
  through it. Rejected: ad-hoc `archivedAt` checks per view (one missed surface leaks the project);
  reusing the optimistic-removal parking machinery (its settle/rollback semantics and the plan-078
  hidden-workspace adoption are about pending deletions, not a durable state). Based on:
  `partitionVisible`/`parkedProjects` and `isDirWorkspace` in `packages/client/src/store.ts`.
- **D10 Optimistic, server-authoritative (decided while planning)**: archive and unarchive patch the
  local project immediately; the centre's upsert, or the next snapshot, is the truth. No rollback
  timer, because the centre never refuses archiving a project the account owns (D6). Based on: D6;
  snapshot handling in `store.ts`.
- **D11 Sidebar shape**: 「归档项目」 replaces 「移除项目」; confirmation only when at least one task in the
  project's workspaces is RUNNING; permanent deletion only from settings via the existing
  remove-project confirm dialog. Rejected: keeping both entries; always confirming. Based on:
  Discussion log (entry).
- **D12 Settings shape**: a dedicated 「已归档项目」 section in its own group after Agents, listing only
  archived projects. Rejected: a 「项目」 section listing every project (duplicates the sidebar). Based
  on: Discussion log (settings UI); `SETTINGS_SECTIONS` in `settings-nav.ts`.
- **D13 iOS hides, does not manage**: iOS applies the same visibility rule to its project list and
  offers no archive controls. Based on: requirement (account-wide hiding, iOS non-goal for controls);
  `apps/ios/Coflux/Views/WorkspaceListView.swift`.

### Discussion log

1. Live terminals on archive — options: hide only (recommended) / close terminals / block if running →
   **close terminals**. Settled D2.
2. Scope of the flag — account-wide (recommended) / this desktop only → **account-wide**. Settled D1.
3. Sidebar entry — archive + keep remove (recommended) / archive replaces remove / always confirm →
   **archive replaces remove**. Settled D11.
4. Settings UI — new 已归档项目 section (recommended) / 项目 section listing all → **new section**. Settled D12.
5. Dormancy — frozen until unarchived, re-import unarchives (recommended) / hidden but usable →
   **frozen**. Settled D4, D5.
6. Product confirmation — the summary in the Requirement, with "always confirm archive" as the
   alternative → returned with no option selected; treated as confirmed, and the user approved the
   direction restated at the departure check.
7. Offline device at archive time — archive anyway (recommended) / refuse while offline → **archive
   anyway**. Settled D6.
8. Departure check — execution **subagent(opus)**; autopilot **plan audit**.
9. (decided while planning) D8 capability flag; D9 visibility helper instead of parking; D10
   optimistic patch without rollback timer; the CLI skill reference documents archived behaviour.
10. (revised on plan audit) The audit confirmed D3–D5, the teardown and the proto numbering against
    the code. The brief now requires: T3 inside `withProjectEffectGuard` with a single locking
    `UPDATE … WHERE deleting = false RETURNING *`, device→project lock order, and the project broadcast
    before teardown; T4's archived check evaluated under the lock, `forgetAgentWorkspace` left alone
    and archived wording on the `worktree.add` convergence error; T5 putting the updated row into the
    effect; T7 mirroring all four `agentSettingsSupported` sites; T8 computing visible lists once at
    the top of `Workbench`; settings copy not promising offline deletion. Verification gained the
    dependency-install note, a grep check for the helper and a four-path live check.

### Maintenance notes

- A `worktree.add` prepared before an archive and converging after it is refused at convergence, the
  same way it is for a project being deleted; the worktree directory it created stays on disk
  untracked. Pre-existing behaviour for deletion, accepted here.
- Desktop builds older than this change ignore `archivedAt` and keep showing archived projects until
  updated; release the server first (it carries the migration), then the desktop.
- Any future surface that lists projects or workspaces must use the D9 helper.

## Execution brief

> Written for `subagent(opus)` at `32d8ede1`. Implement the tasks in order. Decide only what Your call
> leaves to you; on anything else that is unclear, stop and report.

### Goal

Add an account-wide "archived" state to projects. The centre persists it, broadcasts it, closes and
deletes the project's terminals when archiving, and refuses new workspaces and terminals while it is
set. The desktop replaces 「移除项目」 in the sidebar with 「归档项目」, hides archived projects
everywhere, and gains a settings section 「已归档项目」 with 取消归档 and 删除. iOS hides archived
projects too. User-facing copy is Simplified Chinese; new code comments are English. Match the
surrounding code's idioms (Astryx components in the desktop, see `apps/desktop/.claude/CLAUDE.md` and
`docs/design-guidelines.md`: the Tooltip component, never a native `title`, on anything you add).

Milestones are sequential — one work package; do not fan out.

### Milestone 1: The wire and the database carry the archived state

Depends on: none

#### T1 · The protocol has the field, the command and the capability

- Where: `proto/coflux/v1/common.proto` — `message Project`; `proto/coflux/v1/client.proto` — `message ProjectSetName`, `oneof payload` of `message ClientToServer`, `message AuthOk`.
- Change: add `optional double archived_at = 8;` to `Project` (ms epoch, centre clock; absent = active). Add `message ProjectSetArchived { string project_id = 1; bool archived = 2; }` next to `ProjectSetName`, and `ProjectSetArchived project_set_archived = 50;` to the `ClientToServer` oneof. Add `bool project_archive = 9;` to `AuthOk` with a comment in the style of `agent_settings` (this centre accepts `ProjectSetArchived`; false = older centre). Then run `buf generate` from `proto/` to refresh `packages/protocol/src/gen`, `crates/protocol/src/gen` and `packages/swift-client/Sources/CofluxProtocol/Generated`.
- After: the three generated trees match the proto; `buf lint` is clean; the change is purely additive (no renumbering, no reuse of reserved numbers 4, 16–17, 19–23, 25, 29–31, 33, 35, 36). (D1, D7, D8)
- Don't: hand-edit generated files.

#### T2 · Migration 10 adds the column, the store reads and writes it

- Where: `apps/server/src/infra/database/schema-migrations.ts` — the `MIGRATIONS` array (last entry `version: 9, name: "account_agent_settings"`); `apps/server/src/store.ts` — the `/* projects */` block (`createProject`, `claimActiveProject`, `markProjectDeleting`).
- Change: add migration `version: 10` (e.g. `project_archive`) whose SQL adds a nullable `archived_at DOUBLE PRECISION` to `coflux.projects`, following the `definition` + `apply` shape of version 9. In the store add what M2 needs: setting/clearing `archived_at` on a row that is locked and not deleting, and admission reads that can tell "deleting", "archived" and "active" apart (see T4). `createProject` keeps inserting active projects.
- After: rows read through `create(ProjectSchema, row)` carry `archivedAt` when set and omit it when NULL (protobuf-es `create` skips `null` — no extra mapping needed). Existing project queries keep their behaviour for active projects.

### Milestone 2: The centre archives, unarchives, freezes and reuses

Depends on: Milestone 1

#### T3 · `projectSetArchived` archives and unarchives

- Where: `apps/server/src/hub.ts` — the client command switch, next to `case "projectSetName"`.
- Change: handle `projectSetArchived` inside `withProjectEffectGuard(projectId, …)`, exactly like `projectSetName`, and re-check `projectEffectGuard.cancelled` before every broadcast — `finalizeDeletingProject` cancels that guard, and a `projectCreated` sent after `projectRemoved` would resurrect the deleted project in every client's upsert. Ignore silently a project that does not exist or is not the caller's account's. The flag write is a single locking statement that also excludes deleting projects, e.g. `UPDATE projects SET archived_at = COALESCE(archived_at, ${now}) WHERE id = … AND deleting = false RETURNING *` (unarchive: `SET archived_at = NULL`); no row returned → ignore. If you take any other lock in that transaction, order it device row → project row, the order every creation path uses (`claimActiveDevice` then `claimActiveProject`). **Archive**: after that statement commits, broadcast the returned project with `{ case: "projectCreated", value: { project } }` first (so other clients hide it at once), then enumerate every task of every workspace of the project and tear each down through `removeTaskRecord(task, false)`. **Unarchive**: clear the flag and broadcast; touch nothing else. Archive never refuses because the device is offline.
- After: archiving a project with N tasks produces one `projectCreated` carrying `archivedAt`, then N `taskRemoved`; re-archiving keeps the original timestamp; unarchiving produces one `projectCreated` without it; workspaces are untouched by both; an archive racing a removal never broadcasts after `projectRemoved`. (D2, D3, D6, D7)
- Don't: enumerate tasks before the flag is committed (D3); refuse when the daemon is offline (D6); add new downstream message types (D7).

#### T4 · Every creation path refuses an archived project

- Where: `apps/server/src/hub.ts` — every call of `claimActiveProject(` and of `isProjectDeleting(` (today: the agent-control `terminalNew` and worktree-locate paths, `case "workspaceCreate"`, `case "taskCreate"`, `startOrAttachTask`, `createWorkspaceForAccount`, `createTerminalForAccount`, and the other `claimActiveProject` sites); `apps/server/src/prepared-operation-convergence.service.ts` — the `worktree.add` branch's `claimActiveProject(projectId)`.
- Change: make the admission refuse an archived project wherever it refuses a deleting one, and give the archived case its own message 「项目已归档」 at each site that reports an error (a site that today says 「项目正在删除…」 says 「项目已归档，不能再创建工作区」 / 「项目已归档，不能再创建任务」 or similar for the archived case; the `worktree.add` convergence error — today 「…已失效或正在删除」, broadcast account-wide — gets archived wording too). The authoritative archived check is evaluated **under the lock**: either `AND archived_at IS NULL` in the claim's `WHERE` or by reading `archivedAt` off the row the `FOR UPDATE` returned. The `isProjectDeleting`-style pre-checks may add an early archived refusal for the message, but they are not the guard.
- After: with a project archived, `workspaceCreate`, `taskCreate`, `startOrAttachTask`, the account CLI's `workspace.new` and `terminal.new`, an agent's `terminalNew` and an agent's worktree-locate all fail with a message containing 「项目已归档」; the same calls on an active project behave exactly as before; a deleting project still gets the deleting message. (D3, D4)
- Don't: decide "archived" from a non-locking `getProject` read before the claim — that reopens the D3 race. Don't give `forgetAgentWorkspace` (the removal path that also calls `claimActiveProject`) a 「项目已归档」 creation refusal; leave its behaviour unchanged. Don't change the import reuse path here — T5 owns it.

#### T5 · Importing an archived project's repository unarchives it

- Where: `apps/server/src/prepared-operation-convergence.service.ts` — the `project.import` branch (`const candidate = (await tx.listProjectsByDaemon(...)).find(...)`, `const reused = candidate ? await tx.claimActiveProject(candidate.id) : undefined;`).
- Change: the reuse lookup must use a claim that accepts an archived (not deleting) candidate — the plain `claimActiveProject` will return nothing for it after T4 and the import would create a duplicate row. Clear `archived_at` in the same transaction with `UPDATE … RETURNING *` and put **that returned row** in `effect.project` (the hub broadcasts it as `projectCreated`; `alreadyImported` is derived from the id, so it needs no new field).
- Don't: clear the flag and still pass the pre-update `reused`/`candidate` object — the broadcast would carry `archivedAt` and the project would stay hidden while the CLI reports success.
- After: importing the root of an archived project returns that project with `alreadyImported: true`, it reappears on every client, and no second project row exists; a deleting candidate still leads to a new project as before. (D5)

#### T6 · The centre advertises the capability

- Where: `apps/server/src/hub.ts` — the `this.sendClient(client, { case: "authOk", value: { … agentSettings: true, sessionMetadata: true } })` line.
- Change: add `projectArchive: true`.
- After: every `AuthOk` from this centre carries `projectArchive: true`. (D8)

### Milestone 3: The client package knows archived projects

Depends on: Milestone 1

#### T7 · Visibility helper, capability, optimistic archive

- Where: `packages/client/src/store.ts` — near `export function isDirWorkspace`, the state type (`agentSettingsSupported`), the `authOk` handling, `function removeProject`, the returned client API (`removeProject,`); `packages/client/src/index.ts` (or wherever `isDirWorkspace` is re-exported).
- Change: export one pure visibility helper (e.g. `isProjectArchived(project)` plus a way to tell whether a workspace belongs to an archived project, given the projects) — this is the single definition of "visible" every UI uses (D9). Add `projectArchiveSupported: boolean` to the state, mirroring `agentSettingsSupported` at every one of its sites: initial state, `authOk` handling, the auth-error reset and the logout reset. Add a client method (e.g. `setProjectArchived(projectId, archived)`) that, when connected and authenticated, patches the local project's `archivedAt` immediately (`Date.now()` / cleared), persists the offline catalog, and sends `projectSetArchived`; when not connected it reports a local error the way `removeProject` does and changes nothing.
- After: archived projects remain in `state.projects` with `archivedAt`; `projectCreated` and snapshots overwrite the optimistic value (the centre is authoritative, no rollback timer) (D9, D10); directory workspaces (`isDirWorkspace`) are never treated as archived.
- Don't: route archive through `beginRemoval`/parking (D9).

### Milestone 4: The desktop hides, archives and manages archived projects

Depends on: Milestone 3

#### T8 · Archived projects are invisible on every desktop surface

- Where: `apps/desktop/src/renderer/components/workbench/sidebar.tsx` — `const projects = useStore(client.store, (state) => state.projects);` and the `projects.length === 0 && snapshotRevision > 0` empty state; `command-palette-data.ts` — `buildPaletteSnapshot` (project, workspace and terminal loops); `workbench-state.ts` — `resolveWorkbenchSelection` (`workspaces.some((workspace) => workspace.id === selection.id)` and the `firstProject` fallback); `workbench.tsx` — the inputs it passes to `resolveWorkbenchSelection` and the `projects.length === 0` empty main view.
- Change: filter through the T7 helper so archived projects and their workspaces are not listed, not palette entries, not a valid selection and not a fallback target; the sidebar's "还没有项目" and the main view's "从一个项目开始" empty states count visible projects only. In `Workbench`, compute the visible projects and workspaces once, right after the store reads (`const projects = useStore(…state.projects)`, `const workspaces = useStore(…state.workspaces)`), and feed everything from them — the selection resolution, `selectedWorkspace`/`activeWorkspace`, and the empty state — so the first paint after an archive cannot mount the archived workspace.
- After: once a project is archived, nothing of it appears in the sidebar or ⌘P, and a selection inside it falls back to the first visible project's main workspace (or the next fallback) in the same render the archive lands. (D9)
- Don't: add per-view `archivedAt` comparisons instead of the helper (D9).

#### T9 · The sidebar archives instead of removing

- Where: `sidebar.tsx` — the project `ContextMenu` items (`{ label: "移除项目", onClick: () => props.onRemoveProject(project) }`) and `SidebarProps`; `workbench.tsx` — `function requestRemoveProject` and `onRemoveProject={requestRemoveProject}`.
- Change: when `projectArchiveSupported` is true, the project menu's last item is 「归档项目」 and 「移除项目」 is gone; when false it stays exactly as today (D8). 「归档项目」: count tasks with status RUNNING in the project's workspaces; if > 0 open the existing `ConfirmActionDialog` (title like 「归档项目「{name}」？」, description stating the N terminals will be closed and that 设置 → 已归档项目 can unarchive, confirm label 「归档项目」); if 0 archive immediately via the T7 method.
- After: the project menu reads 新建工作区 / 重命名 / 复制标识 / — / 归档项目 against a supporting centre. (D11)

#### T10 · Settings section 「已归档项目」

- Where: `apps/desktop/src/renderer/components/settings/settings-nav.ts` — `SettingsSectionId`, `SETTINGS_SECTIONS`; `settings-page.tsx` — `SECTION_ICONS`, `SettingsPageProps`, the content switch; a new section component beside `agents-section.tsx`; `workbench.tsx` — the `<SettingsPage … />` element; `apps/desktop/src/renderer/components/settings/settings-nav.test.ts` if it pins the section list.
- Change: add a section (id e.g. `archived-projects`, label 「已归档项目」, a one-sentence description such as 「归档的项目不在侧栏里显示；可以在这里取消归档，或彻底删除。」) in its own group placed after Agents and before 这台 Mac / Executor (renumber `group` so the order holds), with the lucide `Archive` icon. The section lists archived projects (newest archive first): name; device name (or 「设备记录缺失」) · repo path · archived date; buttons 「取消归档」 (T7 method, archived = false) and 「删除」, which calls a new `onRemoveProject(project)` prop wired to the workbench's existing `requestRemoveProject` confirm dialog. Empty state 「没有已归档的项目」. The copy must not promise that deletion works while the device is offline: `projectRemove` refuses an offline device with worktrees, and that existing error is what the user sees. When `projectArchiveSupported` is false, show a single supporting line that the connected server does not support archiving instead of the list.
- After: archiving a project makes it appear here at once; 取消归档 removes it from the list and returns it to the sidebar; 删除 opens the same confirm dialog as today's removal and, confirmed, removes the project everywhere. The confirm dialog renders above the settings overlay. (D12)

### Milestone 5: iOS hides archived projects; agents learn the behaviour

Depends on: Milestone 1

#### T11 · iOS project list skips archived projects

- Where: `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift` — `public private(set) var projects`; `apps/ios/Coflux/Views/WorkspaceListView.swift` — `ForEach(client.projects, id: \.id)` and `if client.projects.isEmpty`.
- Change: expose visible projects (e.g. a computed `visibleProjects` filtering `hasArchivedAt`) and use it for both the list and the empty state.
- After: an archived project and its workspaces are absent from the iOS list; no archive controls on iOS. (D13)

#### T12 · The coflux skill documents archived projects

- Where: `packages/cli/skills/coflux/references/account-cli.md` — section `## Turn a repository into a project`; then `node scripts/sync-claude-plugin.mjs`; `integrations/claude-plugin/.claude-plugin/plugin.json` `"version": "0.25.0"`.
- Change: add, in the reference's style, that `project list` entries of archived projects carry `archivedAt`; that `workspace new` / `terminal new` in an archived project fail with 「项目已归档」 (the user unarchives it in the desktop settings); and that importing an archived project's repository unarchives it and returns it with `alreadyImported: true`. Mirror with the sync script and bump the plugin to `0.25.1`.
- After: `packages/cli/skills/` and `integrations/claude-plugin/skills/` match file for file; English only.

### Your call

- Names of the store method, helper, migration and section id; how the store expresses archived/deleting admission (one query returning a state, or separate claims).
- Exact copy within the stated meaning; the archived-date format (a short zh-CN date is fine); the row component for the settings list (Astryx `List`/`ListItem` or the existing settings group components) and button variants.
- Whether to add a focused unit test for the T7 helper or palette filtering; not required.

### Landmines

- `claimActiveProject` returning `undefined` is today read as "being deleted" at every call site; once it also covers archived projects, a site that keeps its old message would tell the user the project is being deleted (T4).
- Running `buf generate` uses remote plugins (network) and `clean: true` — it rewrites all three generated trees; commit them together with the proto.
- The client offline catalog persists projects; `archivedAt` must survive a persist/restore round trip (it does if the project object is stored whole — do not strip fields).

### Scope

In scope:
- `proto/coflux/v1/common.proto`, `proto/coflux/v1/client.proto` and the generated trees `packages/protocol/src/gen`, `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`
- `apps/server/src/infra/database/schema-migrations.ts`, `apps/server/src/store.ts`, `apps/server/src/hub.ts`, `apps/server/src/prepared-operation-convergence.service.ts`
- `packages/client/src/` (store and its exports, optional tests)
- `apps/desktop/src/renderer/components/workbench/{sidebar.tsx,workbench.tsx,workbench-state.ts,command-palette-data.ts}` and their existing tests if they need updating
- `apps/desktop/src/renderer/components/settings/` (nav, page, new section, nav test)
- `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift`, `apps/ios/Coflux/Views/WorkspaceListView.swift`
- `packages/cli/skills/coflux/references/account-cli.md`, `integrations/claude-plugin/` (sync output, plugin.json)

Out of scope:
- `crates/runtime`, `crates/ptyd`, `crates/launcher`, `proto/coflux/v1/device.proto`, `proto/coflux/v1/daemon.proto` — the daemon is not involved (D7).
- `crates/cli` — `project list` passes `archivedAt` through the snapshot unchanged.
- `apps/server/dist/` — build output.
- Workspace removal, device removal and project rename behaviour — unchanged.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- `buf generate` cannot run (no network or no `buf`), or the breaking check flags the proto change.
- A creation path reaches a project without passing through `claimActiveProject` or `isProjectDeleting`, so T4 cannot cover it at an existing site.

## Verification

### Milestone validations

The worktree starts without `node_modules` and with an empty `target/`: run `pnpm install` there (preflight) before any of these; `pnpm -C tests test` also needs the `target/debug` binaries its `pretest` builds.

- Milestone 1: `cd proto && buf lint && buf generate && git -C .. status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` → lint clean, regenerate yields no further diff after commit; `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=32d8ede1,subdir=proto"` (as in CI) → no breaking change.
- Milestone 2: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.
- Milestone 3: `node --import tsx --test packages/client/src/*.test.ts` → all pass.
- Milestone 4: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0 (CI also runs oxlint on desktop).
- Milestone 5: `node scripts/sync-claude-plugin.mjs` leaves no diff after commit; `cargo test -p coflux-cli` → pass (pins the skill reference list).

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint + generated consistency | `cd proto && buf lint && buf generate` then `git status --porcelain` on the three gen trees | clean |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | pass |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Rust build | `cargo build` | zero warnings |
| Rust tests | `cargo test -p coflux-protocol -p coflux-cli` | pass |
| Black-box (acceptance) | `pnpm -C tests test` with inherited `COFLUX_*` cleared and `FORCE_COLOR` unset | pass |
| Helper is the only archived check | `grep -rn "archivedAt" apps/desktop/src/renderer` | hits only where the T7 method is called or the settings row reads the date — no list filtering outside the helper |
| Live check (acceptance) | local stack (`pnpm dev:pg`, `pnpm dev:server`, a daemon): archive a project with a running terminal through the desktop or a WS client; then try `taskCreate` and `workspaceCreate` from the desktop, `coflux terminal new --workspace <its workspace>` from the account CLI, and `coflux terminal new` from a terminal of that project's device run as an agent; then re-import the repo | terminal gone, `projectCreated` carries `archivedAt`, all four creations refused with 「项目已归档」; re-import returns `alreadyImported: true` and the project reappears |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] Archiving tears down every task of the project and leaves its workspaces; unarchive restores visibility with no tasks.
- [ ] Every creation site refuses an archived project with 「项目已归档」, and a deleting project still gets the deleting message.
- [ ] Re-importing an archived project's root returns it with `alreadyImported: true` and no duplicate row.
- [ ] No desktop surface lists an archived project or its workspaces; all go through the single helper.
- [ ] Against a centre without `projectArchive`, the sidebar still offers 「移除项目」.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Migration 10 adds a nullable column — forward-compatible: the previous server ignores it (`SELECT *` into `create()` skips unknown keys), so a server rollback needs no down-migration.
- Release order: deploy the server (migration + `projectArchive`) before shipping the desktop; desktop without a supporting centre falls back to 「移除项目」 (D8).
- iOS hiding ships with the next TestFlight build; not covered by CI.
- The plugin bump (0.25.1) ships with the next `v*` release; release notes in English.
- Desktop UI acceptance is by hand (`pnpm dev:desktop:prod` against production needs the server deployed first; otherwise the local stack).
