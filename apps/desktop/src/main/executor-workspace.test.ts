import assert from "node:assert/strict";
import { test } from "node:test";

import { collectWorkspaceFacts, type GitRunner } from "./executor-workspace";

const ROOT = "/Users/alice/repo";

function runner(map: Record<string, { stdout: string; ok?: boolean }>): GitRunner {
  return (args) => {
    const key = args.join(" ");
    const hit = map[key];
    return hit ? { stdout: hit.stdout, ok: hit.ok !== false } : { stdout: "", ok: false };
  };
}

test("主工作区：gitdir 与 common dir 相同，去重成一条", () => {
  const facts = collectWorkspaceFacts(
    ROOT,
    runner({
      "rev-parse --path-format=absolute --git-dir": { stdout: `${ROOT}/.git\n` },
      "rev-parse --path-format=absolute --git-common-dir": { stdout: `${ROOT}/.git\n` },
      "worktree list --porcelain": { stdout: `worktree ${ROOT}\n` },
    }),
  );
  assert.deepEqual(facts.gitDirs, [`${ROOT}/.git`]);
  assert.deepEqual(facts.otherWorktrees, []);
});

test("linked worktree：gitdir 与 common dir 不同，两条都要保护", () => {
  const wt = "/Users/alice/wt";
  const facts = collectWorkspaceFacts(
    wt,
    runner({
      "rev-parse --path-format=absolute --git-dir": { stdout: `${ROOT}/.git/worktrees/wt\n` },
      "rev-parse --path-format=absolute --git-common-dir": { stdout: `${ROOT}/.git\n` },
      "worktree list --porcelain": { stdout: `worktree ${ROOT}\nworktree ${wt}\n` },
    }),
  );
  assert.deepEqual(facts.gitDirs, [`${ROOT}/.git/worktrees/wt`, `${ROOT}/.git`]);
  assert.deepEqual(facts.otherWorktrees, [ROOT]);
});

test("嵌套 worktree 被列出来（本仓库真实形状：两层嵌套）", () => {
  const a = `${ROOT}/.claude/worktrees/a`;
  const b = `${a}/.claude/worktrees/b`;
  const facts = collectWorkspaceFacts(
    ROOT,
    runner({
      "rev-parse --path-format=absolute --git-dir": { stdout: `${ROOT}/.git\n` },
      "rev-parse --path-format=absolute --git-common-dir": { stdout: `${ROOT}/.git\n` },
      "worktree list --porcelain": { stdout: `worktree ${ROOT}\nworktree ${a}\nworktree ${b}\n` },
    }),
  );
  assert.deepEqual(facts.otherWorktrees, [a, b]);
});

test("不是 git 仓库：三条命令都失败，不抛，事实为空", () => {
  const facts = collectWorkspaceFacts("/tmp/plain", runner({}));
  assert.deepEqual(facts.gitDirs, []);
  assert.deepEqual(facts.otherWorktrees, []);
  assert.equal(facts.root, "/tmp/plain");
});

test("git 输出为空串时不会产生空路径条目", () => {
  const facts = collectWorkspaceFacts(
    ROOT,
    runner({
      "rev-parse --path-format=absolute --git-dir": { stdout: "\n" },
      "rev-parse --path-format=absolute --git-common-dir": { stdout: "  \n" },
      "worktree list --porcelain": { stdout: "\n\n" },
    }),
  );
  assert.deepEqual(facts.gitDirs, []);
  assert.deepEqual(facts.otherWorktrees, []);
});
