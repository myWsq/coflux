/** git 操作：校验仓库、worktree 增删。execFile 异步，不阻塞事件循环。 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@coflux/core";

function run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile("git", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function sanitize(s: string): string {
  return (s || "ws").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ws";
}

export interface RepoInfo {
  ok: boolean;
  repoPath: string;
  branch: string;
  error?: string;
}
export interface WorktreeResult {
  ok: boolean;
  path: string;
  branch: string;
  error?: string;
}

export class GitService {
  constructor(private worktreesDir: string, private log: Logger) {}

  /** 校验是否为（非裸）git 仓库，返回顶层目录与当前分支 */
  async validateRepo(path: string): Promise<RepoInfo> {
    const top = await run(["-C", path, "rev-parse", "--show-toplevel"]);
    if (!top.ok) return { ok: false, repoPath: path, branch: "", error: "不是 git 仓库" };
    const repoPath = top.stdout.trim();
    const br = await run(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
    return { ok: true, repoPath, branch: br.ok ? br.stdout.trim() || "HEAD" : "HEAD" };
  }

  /** git worktree add。worktree 目录用完整 workspaceId 命名以避免碰撞。 */
  async addWorktree(repoPath: string, workspaceId: string, name: string, branch: string, createNew: boolean): Promise<WorktreeResult> {
    mkdirSync(this.worktreesDir, { recursive: true });
    const dir = join(this.worktreesDir, `${sanitize(name)}-${workspaceId}`);
    const args = createNew
      ? ["-C", repoPath, "worktree", "add", "-b", branch, dir]
      : ["-C", repoPath, "worktree", "add", dir, branch];
    const r = await run(args);
    if (!r.ok) return { ok: false, path: dir, branch, error: (r.stderr || "git worktree add failed").trim().slice(0, 400) };
    this.log.info("worktree added", { path: dir, branch });
    return { ok: true, path: dir, branch };
  }

  /** fire-and-forget：移除 worktree（失败则 prune 兜底清理） */
  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    const r = await run(["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
    if (!r.ok) {
      this.log.warn("worktree remove failed", { worktreePath, err: r.stderr.trim() });
      await run(["-C", repoPath, "worktree", "prune"]);
    } else {
      this.log.info("worktree removed", { worktreePath });
    }
  }
}
