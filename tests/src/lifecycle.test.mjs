import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, rawDaemon, tokenFromUrl } from "./harness.mjs";

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
  execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", "https://github.com/myWsq/coflux.git"]);
  const c = stack.makeClient();
  await c.authSubscribe();

  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const proj = await c.waitFor((m) => m.case === "projectCreated", "project.created");
  assert.ok(proj.project.repoPath.endsWith(repo.dir.split("/").pop()), "repoPath 指向仓库");
  assert.equal(proj.project.name, "myWsq/coflux", "项目名取 origin 的完整 namespace/project");
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

test("导入项目：显式名称覆盖 remote 推导名称", async () => {
  const repo = mkRepo();
  repos.push(repo);
  execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", "https://github.com/myWsq/coflux.git"]);
  const c = stack.makeClient();
  await c.authSubscribe();

  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir, name: "  我的项目  " });
  const proj = await c.waitFor((m) => m.case === "projectCreated", "explicit project.created");
  assert.equal(proj.project.name, "我的项目");
  c.close();
});

test("导入项目：无有效 remote 时从规范仓库根目录取名称", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const subdir = join(repo.dir, "nested", "directory");
  mkdirSync(subdir, { recursive: true });
  execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", repo.dir]);
  const c = stack.makeClient();
  await c.authSubscribe();

  c.send({ case: "projectImport", daemonId: stack.daemonId, path: subdir });
  const proj = await c.waitFor((m) => m.case === "projectCreated", "fallback project.created");
  assert.equal(proj.project.name, repo.dir.split("/").pop(), "回退名来自仓库根目录而非导入子目录");
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

test("关闭终端：运行中任务 taskStop+taskRemove 连发，删除后不复活", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");

  c.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "rm" });
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "rm", "idle");
  c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");

  // 复刻旧 web 的连发（transport 不串行同连接消息，两个 handler 并发跑）：
  // 曾触发 updateTask 先读后写把已删行复活广播成僵尸 Tab
  c.send({ case: "taskStop", taskId: idle.task.id });
  c.send({ case: "taskRemove", taskId: idle.task.id });
  await c.waitFor((m) => m.case === "taskRemoved" && m.taskId === idle.task.id, "removed");

  // 留出 daemon sessionExit 回流窗口：removed 之后任何该 task 的 taskUpdated 都是复活 bug
  await new Promise((resolve) => setTimeout(resolve, 800));
  const removedAt = c.log.findIndex((m) => m.case === "taskRemoved" && m.taskId === idle.task.id);
  const resurrected = c.log.slice(removedAt + 1).find((m) => m.case === "taskUpdated" && m.task.id === idle.task.id);
  assert.equal(resurrected, undefined, "已删除任务不得复活");
  c.close();
});

test("添加设备：浏览器授权登记新 daemon", async () => {
  // 用 harness 的裸 /daemon 连接（协议是 protobuf 信封，不再手撸 JSON/WebSocket）
  const dev = rawDaemon(PORT);
  await dev.ready;
  dev.send({ case: "daemonEnrollRequest", name: "dev2", host: "h2", platform: "test" });
  const pending = await dev.waitFor((m) => m.case === "daemonAuthorizePending", "authorizePending");

  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
  await c.waitFor((m) => m.case === "deviceAuthorized", "device.authorized");

  const enrolled = await dev.waitFor((m) => m.case === "daemonEnrolled", "daemon.enrolled");
  assert.ok(enrolled.daemonId);
  dev.close();
  c.close();
});
