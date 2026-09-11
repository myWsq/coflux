/**
 * 为一次 executor 任务算出沙箱要用的那几个路径事实（plan 116 M3）。
 *
 * 与 executor-sandbox 分开：那边只管把事实翻译成 profile 文本，这边管从 git 里把事实问出来。
 * 问的部分需要跑命令，所以 `runGit` 是注入的，纯逻辑（解析、去重、排除自己）可以单测。
 */

import { otherWorktreePaths } from "./executor-sandbox";

export type GitRunner = (args: readonly string[], cwd: string) => { stdout: string; ok: boolean };

export type WorkspaceFacts = {
  /** realpath 解析后的工作区根 */
  root: string;
  /** 本 worktree 的 gitdir 与共享 common dir，去重后；非 git 目录时为空 */
  gitDirs: string[];
  /** 其他已登记 worktree（含嵌套在本工作区内的），realpath 由 git 给出 */
  otherWorktrees: string[];
};

/**
 * `--path-format=absolute` 让 git 直接给绝对路径，省一次拼接。
 * 三条都失败（不是 git 仓库）不算错：目录工作区也能跑 executor，只是没有 git 元数据要保护。
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
