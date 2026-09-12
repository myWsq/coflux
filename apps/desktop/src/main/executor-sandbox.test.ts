import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSandboxProfile, otherWorktreePaths, sandboxArgv, type SandboxInput } from "./executor-sandbox";

function input(over: Partial<SandboxInput> = {}): SandboxInput {
  return {
    workspaceRoot: "/Users/alice/repo",
    writable: true,
    nestedWorktrees: [],
    gitDirs: [],
    scratchDir: "/private/var/folders/x/executor-run-1",
    ...over,
  };
}

test("可写模式放行工作区，只读模式不放行", () => {
  assert.match(buildSandboxProfile(input({ writable: true })), /\(allow file-write\* \(subpath "\/Users\/alice\/repo"\)\)/);
  assert.doesNotMatch(
    buildSandboxProfile(input({ writable: false })),
    /\(allow file-write\* \(subpath "\/Users\/alice\/repo"\)\)/,
  );
});

test("两种模式都先全局拒写，且都断网", () => {
  for (const writable of [true, false]) {
    const profile = buildSandboxProfile(input({ writable }));
    assert.match(profile, /\(deny file-write\*\)/);
    assert.match(profile, /\(deny network\*\)/);
  }
});

test("scratch 目录总是可写，但不放行整个 /tmp", () => {
  const profile = buildSandboxProfile(input());
  assert.match(profile, /\(allow file-write\* \(subpath "\/private\/var\/folders\/x\/executor-run-1"\)\)/);
  assert.doesNotMatch(profile, /subpath "\/private\/tmp"/);
});

test("shell 重定向要的 /dev/null 在放行列表里", () => {
  assert.match(buildSandboxProfile(input()), /\(literal "\/dev\/null"\)/);
});

test("git 目录的 deny 排在工作区 allow 之后——否则主工作区的 .git 会被放行盖掉", () => {
  const profile = buildSandboxProfile(input({ gitDirs: ["/Users/alice/repo/.git"] }));
  const allowAt = profile.indexOf('(allow file-write* (subpath "/Users/alice/repo"))');
  const denyAt = profile.indexOf('(deny file-write* (subpath "/Users/alice/repo/.git"))');
  assert.ok(allowAt >= 0 && denyAt >= 0);
  assert.ok(denyAt > allowAt, "deny 必须在 allow 之后，Seatbelt 是后者覆盖前者");
});

test("嵌套 worktree 的 deny 也排在 allow 之后", () => {
  const nested = "/Users/alice/repo/.claude/worktrees/other";
  const profile = buildSandboxProfile(input({ nestedWorktrees: [nested] }));
  assert.ok(profile.indexOf(`(deny file-write* (subpath "${nested}"))`) > profile.indexOf('(allow file-write* (subpath "/Users/alice/repo"))'));
});

test("多个嵌套 worktree 与多个 git 目录逐条挖掉", () => {
  const profile = buildSandboxProfile(
    input({
      nestedWorktrees: ["/Users/alice/repo/.claude/worktrees/a", "/Users/alice/repo/.claude/worktrees/a/.claude/worktrees/b"],
      gitDirs: ["/Users/alice/repo/.git", "/Users/alice/main/.git"],
    }),
  );
  for (const path of [
    "/Users/alice/repo/.claude/worktrees/a",
    "/Users/alice/repo/.claude/worktrees/a/.claude/worktrees/b",
    "/Users/alice/repo/.git",
    "/Users/alice/main/.git",
  ]) {
    assert.match(profile, new RegExp(`\\(deny file-write\\* \\(subpath "${path.replace(/[/.]/g, "\\$&")}"\\)\\)`));
  }
});

test("未经 realpath 解析的 /var /tmp /etc 路径被拒收——写进去规则会静默失效", () => {
  for (const bad of ["/var/folders/x/run", "/tmp/run", "/etc/thing"]) {
    assert.throws(() => buildSandboxProfile(input({ scratchDir: bad })), /未经 realpath 解析/);
  }
});

test("相对路径、含引号或换行的路径、含 .. 的路径一律拒收", () => {
  assert.throws(() => buildSandboxProfile(input({ workspaceRoot: "repo" })), /必须是绝对路径/);
  assert.throws(() => buildSandboxProfile(input({ workspaceRoot: '/Users/a"/x' })), /含引号或换行/);
  assert.throws(() => buildSandboxProfile(input({ workspaceRoot: "/Users/a\nx" })), /含引号或换行/);
  assert.throws(() => buildSandboxProfile(input({ workspaceRoot: "/Users/a/../b" })), /realpath/);
  assert.throws(() => buildSandboxProfile(input({ workspaceRoot: "/Users/a/" })), /斜杠结尾/);
});

test("sandboxArgv 把命令原样作为 -c 的实参传，不做字符串拼接", () => {
  const argv = sandboxArgv("/p.sb", "/bin/zsh", "echo 'a b'; rm -rf x");
  assert.deepEqual(argv, ["/usr/bin/sandbox-exec", "-f", "/p.sb", "/bin/zsh", "-c", "echo 'a b'; rm -rf x"]);
});

test("otherWorktreePaths 解析 porcelain 并排除自己", () => {
  const porcelain = [
    "worktree /Users/alice/repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /Users/alice/repo/.claude/worktrees/a",
    "HEAD def",
    "detached",
    "",
  ].join("\n");
  assert.deepEqual(otherWorktreePaths(porcelain, "/Users/alice/repo"), ["/Users/alice/repo/.claude/worktrees/a"]);
});

test("otherWorktreePaths 对空输入与无自身条目都不炸", () => {
  assert.deepEqual(otherWorktreePaths("", "/x"), []);
  assert.deepEqual(otherWorktreePaths("worktree /y\n", "/x"), ["/y"]);
});
