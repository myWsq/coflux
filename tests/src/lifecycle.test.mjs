import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, rawDaemon } from "./harness.mjs";

const PORT = 8821;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("auth: 错误密码被拒，正确用户名密码通过并看到在线设备", async () => {
  const bad = stack.makeClient();
  await bad.ready;
  bad.send({ case: "clientAuth", username: "admin", password: "WRONG" });
  await bad.waitFor((m) => m.case === "authError", "auth.error");
  bad.close();

  const c = stack.makeClient();
  const snap = await c.authSubscribe(); // 默认 admin/admin
  assert.ok(snap.daemons.some((d) => d.online), "有在线设备");
  // 登录应签发会话 token，供 web 重连用
  const ok = c.log.find((m) => m.case === "authOk");
  assert.ok(ok && typeof ok.clientToken === "string" && ok.clientToken.length > 0, "auth.ok 回带会话 token");
  c.close();
});

test("项目制：导入 git 仓库 → 主工作区=仓库本身 → worktree 工作区 → 任务跑 PTY", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const c = stack.makeClient();
  await c.authSubscribe();

  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const proj = await c.waitFor((m) => m.case === "projectCreated", "project.created");
  assert.ok(proj.project.repoPath.endsWith(repo.dir.split("/").pop()), "repoPath 指向仓库");
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain && m.workspace.projectId === proj.project.id, "main ws");
  assert.equal(main.workspace.branch, "main");

  c.send({ case: "workspaceCreate", projectId: proj.project.id, name: "feat", branch: "wip", createNew: true });
  const wt = await c.waitFor((m) => m.case === "workspaceCreated" && !m.workspace.isMain && m.workspace.projectId === proj.project.id, "worktree ws");
  assert.equal(wt.workspace.branch, "wip");

  c.send({ case: "taskCreate", workspaceId: wt.workspace.id, title: "t" });
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "t", "idle");
  assert.equal(idle.task.status, TaskStatus.IDLE);

  c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  const run = await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");
  assert.ok(run.task.sessionId);

  c.send({ case: "ptyInput", sessionId: run.task.sessionId, data: "echo MARK_$((6*7))\r" });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("MARK_42"), "PTY 回流");
  c.close();
});

test("主工作区不可删除", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
  c.send({ case: "workspaceRemove", workspaceId: main.workspace.id });
  await c.waitFor((m) => m.case === "error" && m.message.includes("主工作区"), "拒绝删除主工作区");
  c.close();
});

test("添加设备：web 生成登记密钥，新 daemon 可用其登记", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "clientCreateEnrollmentKey" });
  const created = await c.waitFor((m) => m.case === "enrollmentKeyCreated", "enrollmentKey.created");
  assert.ok(created.enrollmentKey.startsWith("cf_enroll_"), "登记密钥格式");
  assert.equal(created.daemonUrl, `ws://127.0.0.1:${PORT}/daemon`, "daemonUrl 指向本栈");

  // 用 harness 的裸 /daemon 连接（协议是 protobuf 信封，不再手撸 JSON/WebSocket）
  const dev = rawDaemon(PORT);
  await dev.ready;
  dev.send({ case: "daemonEnroll", enrollmentKey: created.enrollmentKey, name: "dev2", host: "h2", platform: "test" });
  const enrolled = await dev.waitFor((m) => m.case === "daemonEnrolled", "daemon.enrolled");
  assert.ok(enrolled.daemonId);
  dev.close();
  c.close();
});
