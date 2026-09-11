# Plan 024: Display workspace Git diff statistics (+X −Y)

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 723e4e0..HEAD -- proto/ crates/worker/ apps/server/src/ apps/web/src/ tests/src/`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `723e4e0`, 2026-07-23

## Requirement

As an Agent Command Center, coflux runs Claude/Codex tasks across workspaces and devices. Users need to see at a glance how much code each agent changed. Start with workspace-level `+X −Y` counts of added/deleted lines.

Required outcomes:

- The worker periodically computes each workspace’s cumulative diff against its project’s default branch, including committed, uncommitted, and untracked changes, and reports changes.
- The server persists and broadcasts these values. The DB is only a mirror of device truth, like branch metadata; refresh/reconnect returns the last known value even when the device is offline.
- Show small `+X −Y` text in sidebar workspace rows and beside the terminal top-bar BranchMenu. Hide both when X=Y=0; never show `+0 −0`.

Correctness boundary: count the cumulative diff from **merge-base(default_branch, HEAD) to the working tree**. Agent commits must not reset counts. `git diff HEAD` counts only dirty changes and is wrong; shortstat alone is incomplete because untracked-file lines must contribute to additions.

## Decisions & tradeoffs

- **Base the diff on `git diff --shortstat <merge-base(default_branch, HEAD)>`.** A single revision compares that base to the working tree, covering committed and uncommitted changes together. Reject HEAD-only diff, which resets after commit and violates the user’s cumulative-task perspective (confirmed 2026-07-22). For a main workspace on default_branch, merge-base naturally equals HEAD. If merge-base fails, such as an orphan branch or removed default_branch, fall back to `git diff --shortstat HEAD`. The project already exposes default_branch (`proto/coflux/v1/common.proto:27`).
- **Include untracked lines in additions.** List them with `git ls-files --others --exclude-standard -z`, then read/count directly in Rust. Count a final unterminated line as one, matching numstat; skip NUL-containing binary data and files larger than 1MB so generated artifacts cannot stall polling. Untracked files do not affect deletions. Excluding them systematically hides new agent files; the user explicitly required inclusion on 2026-07-22. Do not spawn git diff --no-index separately for every file.
- **Send default_branch in `WorkspaceRef`.** Extend the server-to-worker workspace list and have pushWorkspaceList obtain the value from the owning project. Guessing origin/HEAD on the worker can drift from the authoritative DB value captured at import. Evidence: `proto/coflux/v1/daemon.proto:278-286` currently has only workspace_id/path; worker WorkspaceList storage is `HashMap<id, path>` at `crates/worker/src/main.rs:641-643` and must carry the branch too.
- **Follow branch monitoring: poll, cache, and report only changes.** Reuse the 3s loop in `crates/worker/src/main.rs:245-278` or add an equivalent task; keep the interval at most 5s so black-box waitFor does not become slow or time out. Add daemon-to-server `WorkspaceDiff { workspace_id, additions, deletions }` with a genuinely unused oneof tag. DaemonToServer tags are not sequential; 19 already belongs to fs_write_result. Unconditional reports violate existing branch/port change-only conventions. Evidence: `proto/coflux/v1/daemon.proto:96-117`.
- **Persist counts rather than keeping only hub memory.** Add workspaces additions/deletions as INTEGER NOT NULL DEFAULT 0. Follow workspaceBranch handling: verify daemon ownership, skip unchanged values, update DB, and broadcast workspaceCreated. Add int32 additions/deletions to the Workspace proto entity. Updating idempotent CREATE DDL alone affects only new databases; also add `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ...` through migrate(). A memory-only mirror would lose counts after server restart while unchanged daemons might never resend, leaving an indefinite stale window. Persistence matches branch semantics with minimal code. Evidence: `apps/server/src/hub.ts:371-382`, `apps/server/src/store.ts:107`, migrate() at `apps/server/src/store.ts:235-239`, and updateWorkspaceBranch at `apps/server/src/store.ts:447-453`.
- **Render in both the sidebar workspace row and top-bar BranchMenu area.** Use small monospace text, separate addition/deletion colors from theme tokens, and no raw hex, following apps/web/.claude/CLAUDE.md. Read workspace fields directly from the store with no new state layer; hide 0/0. The user selected both locations on 2026-07-22 because the sidebar provides a command-center overview. Evidence: `apps/web/src/components/workbench/sidebar.tsx:299-303`, `apps/web/src/components/workbench/workspace-terminal.tsx:397-413`.
- **Use black-box acceptance, decided during planning.** After mkRepo/import, modify a tracked file and add an untracked file. Assert workspaceCreated broadcasts the expected counts, then commit and assert counts remain cumulative. Add Rust unit tests for NUL detection and final unterminated lines. Give new test files exclusive ports. Follow AGENTS.md and workspaceCreated assertions at `tests/src/lifecycle.test.mjs:42-48`.

## Direction

Follow the branch-mirror pipeline: worker Git/file calculations → change-only WorkspaceDiff → hub ownership check/persistence → workspaceCreated broadcast → web store upsert → both displays.

Proto is the sole source of truth. Run buf generate and commit generated Rust/TS bindings; never maintain handwritten mirrors.

### Milestone 1: Protocol extensions

Add additions/deletions to common.proto Workspace, WorkspaceDiff to daemon.proto and DaemonToServer, and default_branch to WorkspaceRef. Regenerate all three languages. Validation: `cd proto && buf lint && buf generate` produces no unexpected status changes; `cargo build -p coflux-protocol` and `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 2: Worker calculation and reporting

Store default_branch from WorkspaceList. Periodically compute cumulative merge-base diff plus untracked additions and send WorkspaceDiff only on change. Unit-test the pure line counter. Validation: `cargo build -p coflux-worker` with zero warnings and `cargo test -p coflux-worker` → exit 0.

### Milestone 3: Server persistence and broadcast

Add columns to initial DDL and migrate(). Handle workspaceDiff with ownership checks, unchanged-value skipping, persistence, and broadcast. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 4: Web display

Show `+X −Y` in sidebar workspace rows and the terminal top bar, hiding 0/0. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0.

### Milestone 5: Black-box acceptance

Add the specified tests, including counts surviving commit. Validation: `pnpm -C tests test` → exit 0 (acceptance; see Commands).

## Landmines

- DaemonToServer tags are not sequential: data-plane messages use 15–18, and `fs_write_result = 19` appears mid-list (`daemon.proto:96-117`). Inspect the entire oneof before choosing an unused tag.
- Production workspaces already exists. `SCHEMA_DDL` uses CREATE TABLE IF NOT EXISTS (`store.ts:107`), so new columns require migrate() (`store.ts:235-239`) for existing production/local databases or deployment will produce 500s.
- Local black-box tests need COFLUX_TEST_PG_URL at direct port 54322. Port 5432 is Supavisor and produces tenant errors in this self-hosted Supabase setup.
- Branch changes already broadcast workspaceCreated as an upsert (`hub.ts:380`); there is no workspaceUpdated. Reuse that message for diff updates.
- Follow apps/web/.claude/CLAUDE.md token/Astryx rules. These are small spans in existing components, not new component infrastructure.
- Branch monitoring skips work before authed (`crates/worker/src/main.rs:256-258`). Diff polling must do the same to avoid needless subprocesses.

## Scope

In scope:
- `proto/coflux/v1/{common,daemon}.proto` and `proto/gen/`, TS/Rust generated output directories
- `crates/worker/src/{main,git}.rs`
- `apps/server/src/{hub,store}.ts`
- `apps/web/src/components/workbench/{sidebar,workspace-terminal}.tsx`
- `tests/src/` (add or extend a `*.test.mjs`)

- `plans/README.md`, `docs/ROADMAP.md` (check off the "git diff display" entry)

Out of scope:
- File-level diff details/diff content viewing - This plan only counts the number of lines, and the details are for subsequent iterations

- `crates/supervisor` — diff is all on the worker side, without touching PTY/supervisor

- Task/session granular diff attribution - diff is a workspace (worktree) attribute

- swift generates product consumers - no swift client is in use, updates brought out by `buf generate` can be submitted as usual

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto verification + generation | `cd proto && buf lint && buf generate` | exit 0, generated artifacts match the committed files |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Rust unit test | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Black-box testing (acceptance) | `COFLUX_TEST_PG_URL=<54322 direct connection URL> pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Modifying tracked files and adding untracked files updates both sidebar and top-bar `+X −Y` within one polling interval; restoring all changes hides 0/0.

- [ ] Statistics do not regress to zero after agent/user commit changes (cumulative semantics), the black-box test case asserts this.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf breaking` reports incompatibility. Only additive fields/messages are planned, so this indicates the change was implemented incorrectly.

## Maintenance notes

- Counts mirror device truth like branches: the server/DB never originates changes. Investigate wrong numbers in worker logs before the DB.
- Each polling cycle starts two or three Git subprocesses per workspace. If many workspaces or large repositories make this costly, first check dirty state using git status --porcelain or increase the interval.
- Untracked files larger than 1MB are deliberately excluded; displayed counts may be lower than those after git add -A.
