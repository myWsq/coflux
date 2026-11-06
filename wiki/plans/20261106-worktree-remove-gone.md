# Plan 20261106-worktree-remove-gone: deleting a workspace whose worktree is already gone succeeds

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 91705267..HEAD -- crates/runtime/src/git.rs crates/runtime/src/device.rs crates/runtime/src/main.rs apps/server/src/prepared-operation-convergence.service.ts apps/server/src/hub.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW — one function in the runtime; the only new success path requires the target directory to be absent
- Depends on: none
- Category: bug
- Execution: subagent(sonnet) — departure check (2026-11-06)
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check
- Workspace: isolated — cut from the main worktree into `.claude/worktrees/20261106-worktree-remove-gone`, branch `dev/20261106-worktree-remove-gone`
- Planned at: `91705267`, 2026-11-06

## Record

### Requirement

Deleting a worktree workspace from the desktop app fails with
`fatal: '<path>' is not a working tree` when that worktree was already removed outside coflux — by
`dev:execute-plan` closing a plan, `git:clean`, a manual `git worktree remove`, or Claude Code's
`ExitWorktree` with removal. The workspace record then cannot be deleted at all: every retry fails the same
way. On the owner's machine 12 worktree workspaces were in this state on 2026-11-06, most of them
`<repo>/.claude/worktrees/*` worktrees that plan 104's worktree follow registered automatically.

The chain: the centre prepares a `worktree.remove` operation (`apps/server/src/hub.ts`,
`removeWorkspaceForAccount` and `prepareWorktreeRemoval`); the runtime runs
`git worktree remove --force <path>` in `crates/runtime/src/git.rs` `remove_worktree`, and on failure runs
`git worktree prune` but still returns the error; `crates/runtime/src/device.rs` turns that into an
`OperationAck` with `ok: false`; the centre's convergence
(`apps/server/src/prepared-operation-convergence.service.ts`, the `worktree.remove` branch) removes the
workspace record only for a successful ack, and the error is shown to the user.

Done means: deleting a worktree workspace whose directory no longer exists removes the record like any other
delete, with no error. Deleting a workspace whose directory still exists behaves exactly as before — in
particular a directory that is no longer a registered git worktree is still refused, not deleted. This is a
fix inside an existing action: no UI, copy, protocol or centre change. It reaches a device when its runtime
is updated; until then the stale records stay undeletable.

### Decisions & tradeoffs

- **D1 Success means the worktree is gone from disk**: `remove_worktree` reports success when, after the
  removal attempt and the prune, nothing is left at the worktree path. Rejected: reporting the git command's
  exit status alone — that is today's behaviour and makes a goal that is already reached look like a failure.
  Based on: `crates/runtime/src/git.rs` `remove_worktree`; the convergence only deletes on `ok: true`.
- **D2 Decide by path absence, never by git's error text**: the fallback looks at the filesystem, not at
  stderr. Rejected: matching `is not a working tree` / `does not exist` — git localises its messages and the
  wording differs between "unregistered" and "registered but missing", so string matching would miss cases
  and break on a translated git. Based on: the two observed failure modes (directory and `.git/worktrees/<name>`
  both gone; directory gone but still registered), both resolved by prune plus an absence check.
- **D3 An existing directory is never deleted by this path**: if the path still exists after the failed
  removal and the prune (e.g. a plain directory whose worktree registration was pruned), the original git error
  is returned unchanged. Only a definite "not found" counts as absent; an empty or non-absolute path, or a
  metadata error other than not-found (permissions, I/O), keeps the error. Rejected: `rm -rf` of a directory
  git no longer recognises — it may hold user files coflux did not create. Rejected: `Path::exists()` — it
  returns false on permission errors too and would turn an unreadable directory into a false success.
- **D4 Fix only the runtime function**: both runtime callers (`device.rs` prepared `WorktreeRemove`, and the
  legacy `main.rs` `WorktreeRemove` handler) and project deletion (which reuses the same operation) inherit
  the fix. Rejected: teaching the centre to treat a failed ack as success — the centre cannot see the disk,
  and only the device can tell "gone" from "refused". No protocol field is added.
- **D5 No new automated test**: per `AGENTS.md`'s test policy a break here is visible the first time a user
  deletes such a workspace; the orchestrator verifies with a scratch reproduction instead.

### Discussion log

- Exploration (2026-11-06): the user reported the `is not a working tree` error on delete. Exploration traced
  the chain above and found 12 affected workspaces on the owner's device; the remaining existing worktree
  directories were checked and are still valid worktrees.
- Departure check: direction "after a failed remove, prune, and report success when the path is absent; keep
  the error when a directory remains; runtime only" — approved. Execution mode: offered sonnet (recommended) /
  opus / fable / self — chose **subagent (sonnet)**. Autopilot: offered plain autopilot (recommended) / plan
  audit / pause after plan — chose **plain autopilot**.
- (decided while planning) D3's treatment of empty or relative paths and non-not-found metadata errors:
  conservative — keep the error — because a false success deletes the centre's record of a worktree that may
  still exist.

### Maintenance notes

- If a future change makes coflux delete worktree directories itself (e.g. a "force delete leftover
  directory" action), it must be an explicit user choice, not a widening of D3.
- Remote devices on an older runtime keep failing until they update; the record cannot be removed from the
  centre side alone (D4).

## Execution brief

> Written for `subagent(sonnet)` at `91705267`. Implement the tasks in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

`remove_worktree` in `crates/runtime/src/git.rs` runs `git worktree remove --force <worktree_path>`. When the
worktree was already deleted outside coflux, git fails with `fatal: '<path>' is not a working tree` and the
function returns that error, so the user can never delete the workspace. Change the failure branch so that,
after the existing `git worktree prune`, the function returns `Ok(())` when the worktree path definitely no
longer exists on disk, and returns the original error otherwise. The change is confined to this one function
(plus a private helper if you want one). Format with `cargo fmt -p coflux-runtime`. The file's existing
comments are partly Chinese; write any new comment in English.

### Milestone 1: an already-removed worktree counts as removed

Depends on: none

#### T1 · `remove_worktree` succeeds when the worktree is already gone and fails otherwise as before

- Where: `crates/runtime/src/git.rs` — `pub async fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String>`
- Change: keep the first step (`git -C <repo_path> worktree remove --force <worktree_path>`) and keep running
  `git -C <repo_path> worktree prune` when it fails. After the prune, decide the result by the worktree path's
  presence on disk (D1, D2):
  - absent → `Ok(())`;
  - anything else → `Err` with the same error string the function builds today (trimmed stderr, or
    `"git worktree remove failed"` when empty, truncated to 400 chars).
- After:
  - "Absent" means `std::fs::symlink_metadata(worktree_path)` (or the tokio equivalent) returned an error whose
    kind is `std::io::ErrorKind::NotFound`. Any other metadata error, or `Ok(_)`, is "present" (D3).
  - An empty `worktree_path`, or one that is not an absolute path, never takes the absent → `Ok` branch: it
    returns the error as before (D3).
  - Inputs → expected:
    - worktree directory and its git registration both already gone → `Ok(())`;
    - worktree directory gone but still registered in git → `Ok(())` (prune clears the registration);
    - a plain directory with files that is not a registered worktree → `Err(<git's error>)`, directory and its
      files untouched;
    - a live, registered worktree → removed by git exactly as today → `Ok(())`;
    - git fails for another reason while the directory still exists → `Err(<git's error>)`.
  - The function's signature and its two callers are unchanged.
- Don't: inspect or match git's stderr text to decide success (D2).
- Don't: delete, move or create anything at `worktree_path` yourself; the only filesystem access is the
  metadata check (D3).
- Don't: use `Path::exists()` / `try_exists` semantics that map permission errors to "absent" (D3).

### Your call

- Whether the absence check lives inline or in a small private helper, and its name.
- Whether to log the "already gone" outcome (the runtime has logging elsewhere; one `info`-level line is fine,
  none is fine).
- Whether to skip the `git worktree remove` call when the path is already absent — allowed only if
  `git worktree prune` still runs in that case.

### Scope

In scope:
- `crates/runtime/src/git.rs` — `remove_worktree` and an optional private helper

Out of scope:
- `crates/runtime/src/device.rs`, `crates/runtime/src/main.rs` — the callers; the fix flows through the
  return value (D4)
- `apps/server/**`, `apps/desktop/**`, `packages/**`, `crates/protocol/**`, `proto/**` — no centre, UI or
  protocol change (D4)
- `add_worktree` and every other function in `git.rs`
- Tests: do not add any (D5)

### Stop and report if

- `remove_worktree`'s body differs from the description in T1 (a `remove --force` call followed by `prune` on
  failure).
- A task needs a file outside the in-scope list.
- The change cannot be made without altering the function signature.

## Verification

### Milestone validations

- Milestone 1: `cargo build -p coflux-runtime` → exit 0 with zero warnings; `COFLUX_HOME= cargo test -p coflux-runtime` → exit 0.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Format | `cargo fmt -p coflux-runtime --check` | exit 0 |
| Zero-warning build | `cargo build --workspace` | exit 0, no warnings |
| Runtime unit tests | `COFLUX_HOME= cargo test -p coflux-runtime` | exit 0 |
| Scratch reproduction (acceptance) | In a `mktemp -d` scratch repo: add a worktree, delete it externally (`git worktree remove` and, separately, `rm -rf` of only the worktree dir), then call `remove_worktree` through a temporary, uncommitted `#[tokio::test]` or equivalent; also a plain non-worktree directory with a file in it | the two gone cases return `Ok`, the plain directory returns `Err` and its file still exists; the temporary test is not committed |

### Done criteria

- [ ] All listed commands pass.
- [ ] T1's `After` state holds, including every input → expected row.
- [ ] The diff touches only `crates/runtime/src/git.rs`.
- [ ] No stderr string matching, no filesystem mutation at `worktree_path` beyond git's own removal (D2, D3).
- [ ] The absence test treats only `NotFound` as absent and refuses empty or relative paths (D3).
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Ships in the next runtime release; launcher daemons receive it from the centre automatically and Coflux.app
  carries it in its bundled runtime. No centre deployment, migration or protocol change.
- After the update, the stale workspace records (12 on the owner's device on 2026-11-06) can be deleted from
  the desktop app normally — that is the user-visible acceptance.
