import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8833;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

// server 侧终端镜像（mirror.ts）的核心产品能力：daemon 离线后 attach 仍能看到最后画面。
// 顺带覆盖"无人观看（无 holder）期间镜像仍在吃字节"：A 关闭后再产生输出，B 也要能看到。
test("daemon 离线后 attach：server 镜像快照可看最后现场", async () => {
  const repo = mkRepo();
  repos.push(repo);

  const A = stack.makeClient();
  await A.authSubscribe();
  A.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await A.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  A.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "ov" });
  const idle = await A.waitFor((m) => m.case === "taskUpdated" && m.task.title === "ov", "idle");
  const taskId = idle.task.id;
  A.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await A.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  await A.waitFor((m) => m.case === "ptyOutput" && m.sessionId === sessionId, "first out");
  // 延迟输出：A 关闭后 2 秒才打出的 marker，只有"无 holder 也喂镜像"才能被 B 看到
  A.send({ case: "ptyInput", sessionId, data: "(sleep 2; echo OFFLINE_MARKER) &\r" });
  await A.waitFor((m) => m.case === "ptyOutput" && m.data.includes("sleep 2"), "echo input");
  A.close();

  await sleep(3000); // 等后台 echo 落进 server 镜像（此时无任何 holder）
  await stack.stopDaemon();

  // daemon 已离线；task 仍 RUNNING、session 仍在（handleDaemonClose 按设计保留 sessions）
  const B = stack.makeClient();
  const snap = await B.authSubscribe();
  const dev = snap.daemons.find((d) => d.daemonId === stack.daemonId);
  assert.ok(dev && !dev.online, "daemon 已离线");

  B.send({ case: "taskAttach", taskId });
  const out = await B.waitFor((m) => m.case === "ptyOutput" && m.sessionId === sessionId, "offline snapshot");
  assert.ok(out.data.includes("OFFLINE_MARKER"), "快照包含无人观看期间的输出");
  assert.ok(!B.log.some((m) => m.case === "error" && m.message.includes("离线")), "没有报 daemon 离线错误");
  B.close();
});
