/**
 * plan 024：工作区 git diff 统计（+X −Y）。
 *
 * 验收核心：统计基准是 merge-base(default_branch, HEAD) 到工作树的累积 diff——agent 在
 * 工作区里 commit 之后数字不归零；untracked 新文件行数计入 additions。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8836;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

function commit(dir, message) {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message]);
}

test("工作区 diff 统计：untracked 计入 additions，commit 后累积数字不归零", async () => {
  const repo = mkRepo();
  repos.push(repo);
  writeFileSync(join(repo.dir, "a.txt"), "line1\n");
  commit(repo.dir, "add a");

  const c = stack.makeClient();
  await c.authSubscribe();

  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const proj = await c.waitFor((m) => m.case === "projectCreated", "project.created");
  await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");

  // 在 worktree（非默认分支）里改动：commit 后 default_branch 未动，merge-base 不变，
  // 与"主工作区直接在 default_branch 上——commit 即退化为无未提交改动"是两回事。
  c.send({ case: "workspaceCreate", projectId: proj.project.id, name: "feat", branch: "wip", createNew: true });
  const wt = await c.waitFor((m) => m.case === "workspaceCreated" && !m.workspace.isMain, "worktree ws");
  assert.equal(wt.workspace.additions, 0);
  assert.equal(wt.workspace.deletions, 0);

  // 已跟踪文件加一行 + 新建一个 untracked 文件
  appendFileSync(join(wt.workspace.path, "a.txt"), "line2\n");
  writeFileSync(join(wt.workspace.path, "b.txt"), "x\ny\nz\n");

  const afterEdit = await c.waitFor(
    (m) => m.case === "workspaceCreated" && m.workspace.id === wt.workspace.id && (m.workspace.additions > 0 || m.workspace.deletions > 0),
    "diff 上报（已跟踪改动 + untracked 新文件）",
    15000,
  );
  assert.equal(afterEdit.workspace.additions, 4, "1（a.txt 新增行）+ 3（b.txt untracked 行数）");
  assert.equal(afterEdit.workspace.deletions, 0);

  // agent 把改动 commit 掉：wip 分支前进，但 default_branch(main) 不动，merge-base 不变，
  // 累积 diff 数字应保持不变（不因为改动从"未提交"变"已提交"而归零）。
  commit(wt.workspace.path, "wip1");

  // 再做一次未提交改动：若实现错误地只统计 `git diff HEAD`（相对上一次 commit），
  // 这里会得到 1（仅本次新增的 line3），而非 5（累积 1+3+1）——以此断言累积语义。
  appendFileSync(join(wt.workspace.path, "a.txt"), "line3\n");

  const afterCommit = await c.waitFor(
    (m) => m.case === "workspaceCreated" && m.workspace.id === wt.workspace.id && m.workspace.additions === 5,
    "commit 后累积 diff 不归零",
    15000,
  );
  assert.equal(afterCommit.workspace.deletions, 0);

  c.close();
});
