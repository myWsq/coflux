import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8821;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("auth: 错误令牌被拒，正确令牌通过并看到在线设备", async () => {
  const bad = stack.makeClient();
  await bad.ready;
  bad.send({ type: "client.auth", clientToken: "WRONG" });
  await bad.waitFor((m) => m.type === "auth.error", "auth.error");
  bad.close();

  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  assert.ok(snap.daemons.some((d) => d.online), "有在线设备");
  c.close();
});

test("项目制：导入 git 仓库 → 主工作区=仓库本身 → worktree 工作区 → 任务跑 PTY", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const c = stack.makeClient();
  await c.authSubscribe();

  c.send({ type: "project.import", daemonId: stack.daemonId, path: repo.dir });
  const proj = await c.waitFor((m) => m.type === "project.created", "project.created");
  assert.ok(proj.project.repoPath.endsWith(repo.dir.split("/").pop()), "repoPath 指向仓库");
  const main = await c.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain && m.workspace.projectId === proj.project.id, "main ws");
  assert.equal(main.workspace.branch, "main");

  c.send({ type: "workspace.create", projectId: proj.project.id, name: "feat", branch: "wip", createNew: true });
  const wt = await c.waitFor((m) => m.type === "workspace.created" && !m.workspace.isMain && m.workspace.projectId === proj.project.id, "worktree ws");
  assert.equal(wt.workspace.branch, "wip");

  c.send({ type: "task.create", workspaceId: wt.workspace.id, title: "t" });
  const idle = await c.waitFor((m) => m.type === "task.updated" && m.task.title === "t", "idle");
  assert.equal(idle.task.status, "idle");

  c.send({ type: "task.start", taskId: idle.task.id, cols: 80, rows: 24 });
  const run = await c.waitFor((m) => m.type === "task.updated" && m.task.id === idle.task.id && m.task.status === "running", "running");
  assert.ok(run.task.sessionId);

  c.send({ type: "pty.input", sessionId: run.task.sessionId, data: "echo MARK_$((6*7))\r" });
  await c.waitFor((m) => m.type === "pty.output" && m.data.includes("MARK_42"), "PTY 回流");
  c.close();
});

test("主工作区不可删除", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ type: "project.import", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain, "main ws");
  c.send({ type: "workspace.remove", workspaceId: main.workspace.id });
  await c.waitFor((m) => m.type === "error" && m.message.includes("主工作区"), "拒绝删除主工作区");
  c.close();
});
