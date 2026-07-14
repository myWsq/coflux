import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8822;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("服务器重启：DB 持久化 + daemon resync 重挂运行中任务 + scrollback 回放存活", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const a = stack.makeClient();
  await a.authSubscribe();
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "rec" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "rec", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  a.send({ case: "ptyInput", sessionId: run.task.sessionId, data: "echo RECOVER_ME\r" });
  await a.waitFor((m) => m.case === "ptyOutput" && m.data.includes("RECOVER_ME"), "marker");
  a.close();

  // 杀掉并重启服务器（同一 DB）；daemon 仍存活，会重连重认证并 resync
  await stack.restartServer();
  // 给 daemon 重连 + resync 的时间
  await new Promise((r) => setTimeout(r, 4500));

  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  const rec = snap.tasks.find((t) => t.id === taskId);
  assert.ok(rec, "重启后任务记录仍在（DB 持久化）");
  assert.equal(rec.status, TaskStatus.RUNNING, "重启后任务仍 running（resync 重挂）");
  c.send({ case: "taskAttach", taskId });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("RECOVER_ME"), "重启后回放历史");
  c.close();
});
