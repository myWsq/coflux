import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8822;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("服务器重启：DB 持久化 + daemon catalog 重挂任务 + sessiond snapshot 存活", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const first = await openRelayDevice(stack);
  const a = first.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "rec" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "rec", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  await first.attach(sessionId);
  const from = first.mark();
  await first.input(sessionId, "echo RECOVER_ME\r");
  await first.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("RECOVER_ME"), "marker", 10000, from);
  first.close();

  // 杀掉并重启服务器（同一 DB）；daemon 仍存活，会重连重认证并 resync
  await stack.restartServer();
  await stack.waitDaemonOnline();

  const second = await openRelayDevice(stack);
  const snap = second.control.log.find((message) => message.case === "stateSnapshot");
  const rec = snap.tasks.find((t) => t.id === taskId);
  assert.ok(rec, "重启后任务记录仍在（DB 持久化）");
  assert.equal(rec.status, TaskStatus.RUNNING, "重启后任务仍 running（resync 重挂）");
  const attached = await second.attach(sessionId);
  assert.ok(utf8(attached.ansiSnapshot ?? new Uint8Array()).includes("RECOVER_ME"), "重启后 sessiond snapshot 保留历史");
  second.close();
});
