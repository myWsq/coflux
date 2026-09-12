# Plan 072: Let the daemon repair the project's default branch after import

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat ce9de7a..HEAD -- proto crates/worker/src/git.rs crates/worker/src/main.rs apps/server/src/hub.ts apps/server/src/store.ts tests/src/lifecycle.test.mjs`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: self
- Planned at: `ce9de7a`, 2026-08-12

## Requirement

`projects.default_branch` is the diff-stat baseline, `merge-base(default_branch, HEAD)`, but the daemon detects and stores it only at project import. There is no automatic repair or manual correction interface; the INSERT at `apps/server/src/store.ts:789` is its only write site.

An incorrect value produces no error, only silently wrong sidebar counts: a main workspace shows tens of thousands of “changed” lines that actually accumulated on main since a feature branch diverged. Such bugs are difficult for users to report:

- On 2026-08-01, production stored `haolin` as `HEAD` and `aohun/maxkb` as `feature/sso-default-application-chat`; both required manual SQL repair.
- On 2026-08-12, `interview-evals` was `HEAD` and `wangshuaiqi.com/data-analysis` was `chore/lightweight-repository-structure`; again repaired manually.
- PR #29 (`6261c54`) fixed detection for new imports but does not repair existing records. Renaming `master` to `main` can cause the same drift.

After this change, each workspace-list delivery makes the daemon check local `origin/HEAD`. A mismatch is reported, stored by the server, and followed by a refreshed list. Existing mistakes repair themselves on daemon reconnect—restart, network interruption, or worker hot upgrade—without manual SQL.

Do not substitute a manual UI, since users do not know the value needs correction. Do not probe on every existing 3s poll: default-branch changes are too rare to justify ongoing overhead. Failed detection must not clear local repositories with no remote.

## Decisions & tradeoffs

- **Daemon reports the truth; server stores a cache**. Only the daemon can run `git symbolic-ref refs/remotes/origin/HEAD`; the server cannot verify it. Correct comments claiming “server is authoritative; worker must not guess” at `apps/server/src/hub.ts:292` and `proto/coflux/v1/daemon.proto:268-270`. Follow existing `workspaceBranch` (hub.ts:930) and `workspaceDiff` (hub.ts:942), whose comments correctly describe device truth and DB mirroring/broadcast. Based on `crates/worker/src/git.rs:169`, where detect_default_branch runs locally.
- **Automatic repair, no manual selector**. This field means the repository's default branch, not a user-selected comparison baseline, so it should match the remote. A settings dropdown does not address silent corruption; both incidents were found by us rather than reported. Explicitly reject `default_branch_pinned` or similar flags for a nonexistent custom-baseline requirement. A future custom diff baseline needs a separate field and feature.
- **Probe on `workspaceList`, outside the 3s poll**. `pushWorkspaceList` at hub.ts:295 sends the full list on daemon connection and workspace creation/deletion. Use that event. Adding a git subprocess per workspace every 3s at `crates/worker/src/main.rs:341` only discovers a monthly-scale event sooner. Accept delayed detection of a master→main migration while a daemon neither reconnects nor changes workspaces; appropriate for P3. Based on hub.ts:292-303.
- **No report on failed detection**. If detect_default_branch returns `None` for a repository without a remote or not created by clone, preserve the current value. Sending an empty string would erase its branch; worker interprets empty as a directory workspace and skips git polling, disabling diff stats too (main.rs:356-358). Preserve the existing None contract at git.rs:169-177.
- **Report by workspace; server resolves project**. `WorkspaceRef` has workspace_id/path/default_branch but no project_id (daemon.proto:271-275). Send `{workspace_id, default_branch}` and resolve through `getWorkspace(workspaceId).projectId`. Do not enlarge every list item with project_id for a rare message.
- **Server absorbs duplicate workspace reports idempotently**. Worker cannot deduplicate by project because it lacks that association. Compare the stored value and return immediately if equal, without writes or another list push, following workspaceDiff at hub.ts:942-950. Duplicate reports during connection are negligible one-time overhead.
- **Convergence (decided while planning)**: worker detects mismatch → reports → server writes → resends workspaceList → worker sees equality and stops reporting. This converges on the second pass without a storm. Resending is required so worker's diff_stat no longer uses the stale baseline.
- **Broadcast through `projectCreated` (decided while planning)**. Existing project updates use it (hub.ts:764), and frontend upserts by id. No additional client message is needed.

## Direction

Worker receives workspaceList → checks each repository workspace's origin/HEAD → on mismatch sends `send_d2s(WorkspaceDefaultBranch{workspace_id, default_branch})` → hub resolves project → persists, `broadcast(projectCreated)`, and `pushWorkspaceList`.

### Milestone 1: Additive protocol message and consistent generated artifacts

Add a worker→server message to `DaemonToServer`, near WorkspaceBranch/WorkspaceDiff, carrying workspace_id and detected default_branch. Use an unused oneof tag; the current maximum is 29 relay_home. Correct the authoritative-server comment above WorkspaceList in daemon.proto.

Validation: `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` → exit 0 after committing generated artifacts; regeneration must yield no diff.

### Milestone 2: Worker checks incoming lists

On WorkspaceList, detect origin/HEAD for each workspace with a nonempty default_branch. Report only a successful, different result; send nothing on failure.

Validation: `cargo build --release -p coflux-worker` → exit 0 with no warnings, matching CI's `-D warnings`.

### Milestone 3: Server persistence, broadcast, and refreshed list

Validate workspace ownership using the same `ws.daemonId !== conn.daemonId` guard as workspaceBranch, resolve its project, and return if unchanged. Otherwise update the DB, broadcast projectCreated, and resend that daemon's workspaceList. Add a store method for projects.default_branch and correct hub.ts:292's comment.

Validation: `pnpm -r typecheck` or the repository's existing typecheck command → exit 0.

### Milestone 4: Black-box repair coverage

Beside the existing lifecycle.test.mjs origin/HEAD import test, add a repair case: import a repository whose origin/HEAD differs from its recorded value, trigger workspaceList by creating a workspace, and assert corrected project.defaultBranch. Remove the “editable project default branch” item from the plans/README.md Backlog because this plan fulfills it.

Validation: `node --test tests/src/lifecycle.test.mjs` or the existing black-box command → exit 0.

## Landmines

- CI at `.github/workflows/ci.yml:50-51` runs buf generate and checks all three outputs for zero diff. TS `fileDesc(...)` embeds the complete .proto as a base64 descriptor (packages/protocol/src/gen/coflux/v1/device_pb.ts:19), so handwritten generated files cannot work. Run installed buf 1.71.0 and commit TS/Rust/Swift outputs. CI also runs `buf breaking --against main`; additive messages/fields should pass.
- WorkspaceList handling holds a synchronous `state.lock().unwrap()` at main.rs:876-881, but detect_default_branch is async and starts git. Collect work under the lock and release it before probing, or spawn a separate task. Awaiting under the lock causes deadlock or a MutexGuard-across-await compilation failure.
- Empty default_branch means a directory workspace and must be skipped even if its directory lies inside a repository, such as a dotfiles-managed HOME. Match the 3s poll's filter at main.rs:356-358.
- Worktrees share refs/remotes with the main repository, so each sees the same origin/HEAD. Server idempotency handles the resulting duplicate project reports.
- Do not reuse or add fields to WorkspaceBranch: it describes each worktree's current branch, distinct from the project's default branch. Mixing them gives hub.ts:930 two different responsibilities.

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`
- `packages/protocol/src/gen/`, `crates/protocol/src/gen/`, `proto/gen/swift/` generated by buf
- `crates/worker/src/main.rs`, `crates/worker/src/git.rs`
- `apps/server/src/hub.ts`, `apps/server/src/store.ts`
- `tests/src/lifecycle.test.mjs`
- `plans/README.md` status and Backlog removal

Out of scope:
- Frontend changes in apps/web, apps/mobile, or apps/ios. Sidebar already shows project.defaultBranch (apps/web/src/components/workbench/sidebar.tsx:318) and follows corrected data.
- A user-editable default_branch interface, explicitly rejected above.
- Bulk backfill scripts: production values were repaired on 2026-08-12, and reconnect repairs them after rollout.
- Stale local origin/HEAD after the remote changes its default: retain the `ponytail:` note at git.rs:168 and add ls-remote --symref only if this becomes a real issue.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint and generated consistency | `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` | exit 0 |
| Rust build (CI uses `-D warnings`) | `cargo build --release -p coflux-worker` | exit 0 |
| Rust unit tests | `cargo test -p coflux-protocol` | exit 0 |
| TS typecheck | Existing repository command from `AGENTS.md` / `.github/workflows/ci.yml` | exit 0 |
| Black-box acceptance | Existing `tests/` command, using CI's Postgres service | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] On workspace-list delivery, a mismatched local origin/HEAD is reported, persisted, broadcast, and returned in a refreshed list. Matching values produce no report.
- [ ] Missing origin/HEAD produces no report and preserves projects.default_branch.
- [ ] Directory workspaces with empty default_branch are skipped.
- [ ] hub.ts and daemon.proto comments state that daemon is the source of truth and DB is a cache.
- [ ] A black-box repair case asserts the corrected value, not merely absence of a crash.
- [ ] plans/README.md status is updated and its editable-default-branch Backlog item is removed.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- buf breaking rejects the change, indicating it is not purely additive and needs redesign.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Worker and server repeatedly correct one another without convergence, indicating different meanings for detected and returned values.

## Maintenance notes

- Correctness requires server data to remain a cache of daemon-local origin/HEAD. A future user-configurable baseline creates a second authority and requires explicit precedence between user choice and detection; a writable field alone is insufficient.
- origin/HEAD is set automatically at clone, then does not track remote changes. After remote master→main migration, run `git remote set-head origin -a` locally to expose the new branch. If this recurs, consider `git ls-remote --symref`; network overhead keeps it outside this plan.
- Repair timing follows pushWorkspaceList triggers (hub.ts:295: daemon connect and workspace creation/deletion). Reducing these calls slows or can disable repair.

### Original source references

`apps/server/src/hub.ts:292-303`, `crates/worker/src/main.rs:356-358`, `crates/worker/src/git.rs:169-177`, `proto/coflux/v1/daemon.proto:271-275`, `crates/worker/src/main.rs:876-881`, `crates/worker/src/git.rs:168`.
