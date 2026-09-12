# Plan 045: Repository-free terminals—select a device and open its HOME

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 03d98e1..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts crates/worker/src/main.rs packages/client/src apps/web/src/components/workbench/ tests/src/`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `03d98e1`, 2026-07-26

## Requirement

Currently terminals require importing a Git project and creating a task in its workspace. The user wants ordinary terminals without repositories:

- New button beside Import project in sidebar project heading; select an online device using import wizard's first-step interaction, then proceed without directory browsing.
- cwd is the device user's real `$HOME`, never `~/.coflux`.
- Each click creates a fresh directory workspace and task; user explicitly chose no per-device reuse.
- Separate Terminal sidebar group, outside project tree and device rows.
- No tab bar, Changes tab, or New-terminal button: one task per workspace.
- Hide/skip all Git diff/branch/worktree behavior; reuse existing task/session/resync/checkpoint/reconnect paths.

Correctness requires real HOME and zero Git operations, especially worktree removal and branch/diff polling.

## Decisions & tradeoffs

- **Directory workspace means workspace.projectId==""**, centralized in isDirWorkspace-style predicates on Web/server. No kind field, schema, or Workspace proto change. Existing project_id TEXT NOT NULL permits empty strings without foreign key (store.ts:276-288); proto is plain string (common.proto:33-48). A new enum causes unnecessary creation/storage ripple.
- **Absolute cwd throughout**, no tilde expansion. Web calls listDirectory(daemonId,"~") (store.ts:620-623→DeviceFsList{browse_home:true}), gets daemon-resolved FsListed.path, sends path, stores workspace.path. Existing taskStart sends sessionCreate{cwd:ws.path}. Empty cwd would fall back to COFLUX_HOME, not HOME. Worker tilde expansion would require both relay/end-to-end creation changes and still leave manifest workspace_root invalid for fs/exec (device.rs:1277-1282). Real HOME resolution: device.rs:882-897; sole server cwd source: hub.ts:1527.
- **Add TerminalCreate{daemon_id,path}**, validating account ownership, online daemon, nonempty path, then transactionally creating workspace with empty projectId/branch and isMain=false plus task; broadcast workspaceCreated/taskCreated. No prepared validation round trip: projectImport's ProjectValidate (hub.ts:1191-1216) validates Git, whereas this path came from daemon FsListed and needs no such validation. Place beside analogous client.proto:69-96 messages/handlers; regenerate and commit TS/Rust outputs.
- **Removal reuses workspaceRemove**, but directory branch only deletes records/cascades tasks/stops sessions. Never worktree.remove; allow removal while daemon offline. Existing worktree path hub.ts:783-795/:1222 is dangerous for HOME and requires online daemon.
- **Skip Git polling when manifest defaultBranch is empty**. Do not rely on Git failing outside repositories: HOME may be a yadm/dotfiles repo. Server already supplies empty fallback (hub.ts:295-299), unlike normal workspaces; worker polling at main.rs:350-377 must skip it.
- **User-selected UI**: render workspaces.filter(isDirWorkspace) in separate group, hidden entirely when empty. No terminal/Changes tabs or creation button (workspace-terminal.tsx:430/:277). Device picker matches import wizard:149-195, including online-only, keyboard access, and register-device empty state. Executor chooses reuse or lightweight dialog for minimal diff. Workspace name defaults "~"; row shows device name plus workspace name, borrowing project-row details.
- **Fresh workspace/task each click**, explicitly chosen during departure check. Task title follows existing taskCreate default, such as Terminal.
- **No mobile adaptation**: frozen mobile naturally omits empty-projectId workspaces from project grouping; only preserve build.

## Direction

Button→device→fsList("~")→absolute HOME→terminalCreate→transaction/broadcast→store selects workspace/task→existing taskStart/sessionCreate uses ws.path.

### Milestone 1: Protocol/server/worker

Add message and generated outputs, creation/removal branches, empty-defaultBranch polling skip. Black-box asserts empty projectId/correct path plus task broadcast; start/attach and run pwd to verify cwd; remove without worktree operation.
Validation: server types, zero-warning daemon build, historical 54322-PG suite below all pass.

### Milestone 2: Web entry/group/tabless view

Add button/picker/group/removal, hide tabs/Changes/New and Git counts/branches/workspace menus for directory workspaces. Web types and existing mobile build/types pass, the latter only checking shared compatibility.

## Landmines

1. Supervisor home actually means COFLUX_HOME, default ~/.coflux (sessions.rs:337/main.rs:48). Use absolute path; **do not change rarely upgraded supervisor**.
2. Divert directory removal before existing Git/online-required path.
3. Skip polling explicitly even when HOME is a repository; keep worker criterion aligned with server empty-defaultBranch fallback.
4. Project cascades filter by projectId (client store.ts:422-424, server equivalent). Empty ID naturally excludes directory workspaces; no fake project.
5. Proto is truth (common.proto:1-4); Rust/TS generated wire formats move together, checked by black-box tests.
6. Historical local tests require direct PG 54322; 5432 was Supavisor and returned tenant errors. New test files need unused exclusive ports.

## Scope

In scope: client.proto/generated TS/Rust and Swift if same generator; server hub/store create/remove without expected DDL change; worker main polling; client store/send; Web workbench views; tests; README status.

Out of scope: supervisor; mobile features; arbitrary-directory picker (user chose HOME); push/PR/release.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Black-box | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| UI acceptance | User manual verification, no Claude frontend walkthrough | User confirmation |

## Done criteria

- [ ] All listed commands pass.
- [ ] New black-box cases cover creation with empty projectId, correct path, and a task created together; session cwd equals the supplied HOME path; deletion performs no worktree operation.
- [ ] The new sidebar button opens device selection, then automatically inserts and selects the item in the Terminals group; the terminal starts in HOME.
- [ ] Directory-workspace views show no tab bar, Changes tab, New Terminal button, or Git UI.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Cited fact changes, excluded work required, especially supervisor for cwd.
- Validation fails twice after one reasonable fix.
- browse_home FsListed.path is not absolute, invalidating premise.

## Maintenance notes

- Centralize empty-projectId predicate. A second non-Git workspace type can justify explicit kind later, migrating empty string to enum default.
- Worker empty-defaultBranch skip and server fallback at hub.ts:299 are an implicit shared contract; review both together.

Additional milestone validation: `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` must pass for the minimal shared-layer compatibility changes.

### Original source references

`apps/server/src/store.ts:276-288`, `proto/coflux/v1/common.proto:33-48`, `packages/client/src/store.ts:620-623`, `crates/worker/src/device.rs:1277-1282`, `crates/worker/src/device.rs:882-897`, `apps/server/src/hub.ts:1527`, `apps/server/src/hub.ts:1191-1216`, `proto/coflux/v1/client.proto:69-96`, `apps/server/src/hub.ts:783-795`, `hub.ts:1222`, `apps/server/src/hub.ts:295-299`, `crates/worker/src/main.rs:350-377`, `apps/web/src/components/workbench/workspace-terminal.tsx:430`, `workspace-terminal.tsx:277`, `apps/web/src/components/workbench/import-project-wizard.tsx:149-195`, `crates/supervisor/src/sessions.rs:337`, `crates/supervisor/src/main.rs:48`, `apps/server/src/hub.ts:299`, `packages/client/src/store.ts:422-424`, `proto/coflux/v1/common.proto:1-4`.
