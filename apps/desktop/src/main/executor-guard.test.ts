import assert from "node:assert/strict";
import { test } from "node:test";

import { guardToolCall, isInsideWorkspace } from "./executor-guard";

const ROOT = "/Users/alice/repo";

test("工作区内的路径放行，根自身也算在内", () => {
  assert.equal(isInsideWorkspace(ROOT, ROOT), true);
  assert.equal(isInsideWorkspace(ROOT, `${ROOT}/src/main.ts`), true);
  assert.equal(isInsideWorkspace(ROOT, `${ROOT}/a/b/c`), true);
});

test("同前缀的兄弟目录不算在内——字符串前缀判定会在这里出洞", () => {
  assert.equal(isInsideWorkspace(ROOT, "/Users/alice/repo-evil/x"), false);
  assert.equal(isInsideWorkspace(ROOT, "/Users/alice/repository/x"), false);
});

test("`..` 先归一化再判，逃逸不了", () => {
  assert.equal(isInsideWorkspace(ROOT, `${ROOT}/../etc/passwd`), false);
  assert.equal(isInsideWorkspace(ROOT, `${ROOT}/src/../../../tmp/x`), false);
  // A path that wanders out and back into the workspace should still be allowed.
  assert.equal(isInsideWorkspace(ROOT, `${ROOT}/src/../lib/x`), true);
});

test("上级目录与完全无关的路径都不算在内", () => {
  assert.equal(isInsideWorkspace(ROOT, "/Users/alice"), false);
  assert.equal(isInsideWorkspace(ROOT, "/etc/hosts"), false);
  assert.equal(isInsideWorkspace(ROOT, "/"), false);
});

test("相对路径一律不算在内", () => {
  assert.equal(isInsideWorkspace(ROOT, "src/main.ts"), false);
  assert.equal(isInsideWorkspace(ROOT, "./x"), false);
  assert.equal(isInsideWorkspace(ROOT, "../x"), false);
});

test("重复斜杠与多余的 . 段不影响判定", () => {
  assert.equal(isInsideWorkspace(ROOT, `${ROOT}//src///main.ts`), true);
  assert.equal(isInsideWorkspace(ROOT, `${ROOT}/./src/./main.ts`), true);
});

test("只读模式拒绝 write 与 edit，且理由告诉模型该怎么做", () => {
  for (const toolName of ["write", "edit"]) {
    const verdict = guardToolCall({ toolName, input: { path: `${ROOT}/a.txt` }, workspaceRoot: ROOT, writable: false });
    assert.equal(verdict?.block, true);
    assert.match(verdict?.reason ?? "", /只读模式/);
  }
});

test("只读模式仍允许 read 与 grep", () => {
  assert.equal(guardToolCall({ toolName: "read", input: { path: `${ROOT}/a.txt` }, workspaceRoot: ROOT, writable: false }), null);
  assert.equal(guardToolCall({ toolName: "grep", input: { path: ROOT }, workspaceRoot: ROOT, writable: false }), null);
});

test("可写模式下工作区内的写放行、工作区外的写拦下", () => {
  assert.equal(guardToolCall({ toolName: "write", input: { path: `${ROOT}/a.txt` }, workspaceRoot: ROOT, writable: true }), null);
  const verdict = guardToolCall({ toolName: "write", input: { path: "/etc/hosts" }, workspaceRoot: ROOT, writable: true });
  assert.equal(verdict?.block, true);
  assert.match(verdict?.reason ?? "", /在工作区外/);
});

test("读工作区外的文件同样拦下——只读不等于可以到处读", () => {
  const verdict = guardToolCall({ toolName: "read", input: { path: "/Users/alice/.ssh/id_rsa" }, workspaceRoot: ROOT, writable: true });
  assert.equal(verdict?.block, true);
});

test("相对路径被拒，并把工作区根告诉模型", () => {
  const verdict = guardToolCall({ toolName: "read", input: { path: "src/main.ts" }, workspaceRoot: ROOT, writable: true });
  assert.equal(verdict?.block, true);
  assert.match(verdict?.reason ?? "", /必须是绝对路径/);
  assert.match(verdict?.reason ?? "", /\/Users\/alice\/repo/);
});

test("多个路径字段里任何一个越界都拦下", () => {
  const verdict = guardToolCall({
    toolName: "edit",
    input: { path: `${ROOT}/ok.txt`, filePath: "/etc/evil" },
    workspaceRoot: ROOT,
    writable: true,
  });
  assert.equal(verdict?.block, true);
});

test("bash 不走这层（它由 Seatbelt 兜底），不会因为没有路径字段就被拦", () => {
  assert.equal(guardToolCall({ toolName: "bash", input: { command: "rm -rf /" }, workspaceRoot: ROOT, writable: true }), null);
});

test("入参不是对象 / 缺字段时不炸也不误拦", () => {
  assert.equal(guardToolCall({ toolName: "read", input: null, workspaceRoot: ROOT, writable: true }), null);
  assert.equal(guardToolCall({ toolName: "read", input: {}, workspaceRoot: ROOT, writable: true }), null);
  assert.equal(guardToolCall({ toolName: "read", input: { path: 42 }, workspaceRoot: ROOT, writable: true }), null);
});
