/**
 * The handful of path facts a run's sandbox needs, worked out for one executor task.
 *
 * Split from executor-sandbox on purpose: that module only turns facts into profile text, this one
 * asks git for the facts. Asking means running commands, so `runGit` is injected and the pure part
 * (parsing, deduplication, excluding ourselves) stays unit-testable.
 */

import { otherWorktreePaths } from "./executor-sandbox";

export type GitRunner = (args: readonly string[], cwd: string) => { stdout: string; ok: boolean };

export type WorkspaceFacts = {
  /** The workspace root, realpath-resolved. */
  root: string;
  /** This worktree's gitdir and the shared common dir, deduplicated; empty outside a git repo. */
  gitDirs: string[];
  /** Every other registered worktree, nested ones included; git hands these back realpath-resolved. */
  otherWorktrees: string[];
};

/**
 * `--path-format=absolute` makes git return absolute paths directly, saving a join.
 * All three failing (not a git repository) is not an error: a directory workspace can run the
 * executor too, it simply has no git metadata to protect.
 */
export function collectWorkspaceFacts(root: string, runGit: GitRunner): WorkspaceFacts {
  const gitDir = readGitPath(runGit, root, "--git-dir");
  const commonDir = readGitPath(runGit, root, "--git-common-dir");
  const listed = runGit(["worktree", "list", "--porcelain"], root);

  const gitDirs = [...new Set([gitDir, commonDir].filter((path): path is string => Boolean(path)))];
  const otherWorktrees = listed.ok ? otherWorktreePaths(listed.stdout, root) : [];

  return { root, gitDirs, otherWorktrees: [...new Set(otherWorktrees)] };
}

function readGitPath(runGit: GitRunner, cwd: string, flag: string): string | null {
  const result = runGit(["rev-parse", "--path-format=absolute", flag], cwd);
  if (!result.ok) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}
