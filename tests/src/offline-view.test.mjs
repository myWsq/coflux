import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8833;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

// 中心只保存 sessiond 派生的最近 checkpoint：不持 holder、不解析 live output，也不裁决现场。
test("daemon 离线后中心仍提供最近一个有界 checkpoint 画面", async () => {
  const repo = mkRepo();
  repos.push(repo);

  const device = await openRelayDevice(stack);
  const A = device.control;
  A.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await A.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  A.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "ov" });
  const idle = await A.waitFor((m) => m.case === "taskUpdated" && m.task.title === "ov", "idle");
  const taskId = idle.task.id;
  A.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await A.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  await device.attach(sessionId);
  // 延迟输出：Device subscriber 关闭后才产生 marker，checkpoint 必须由 worker 主动向 sessiond 取。
  await device.input(sessionId, "(sleep 2; echo OFFLINE_MARKER) &\r");
  device.close();

  const observer = stack.makeClient();
  await observer.authSubscribe();
  const onlineCheckpoint = await observer.waitFor(
    (m) => m.case === "sessionCheckpoint" && m.sessionId === sessionId && utf8(m.ansiSnapshot).includes("OFFLINE_MARKER"),
    "checkpoint with offline marker",
    12000,
  );
  assert.ok(onlineCheckpoint.snapshotSeq > 0n);
  assert.ok(onlineCheckpoint.capturedAt > 0);
  observer.close();
  await stack.stopDaemon();

  // daemon 已离线；task 仍 RUNNING、session 仍在（handleDaemonClose 按设计保留 sessions）
  const B = stack.makeClient();
  const snap = await B.authSubscribe();
  const dev = snap.daemons.find((d) => d.daemonId === stack.daemonId);
  assert.ok(dev && !dev.online, "daemon 已离线");

  const checkpoint = await B.waitFor((m) => m.case === "sessionCheckpoint" && m.sessionId === sessionId, "offline checkpoint");
  assert.ok(utf8(checkpoint.ansiSnapshot).includes("OFFLINE_MARKER"), "checkpoint 包含无 subscriber 期间的输出");
  assert.equal(checkpoint.snapshotSeq, onlineCheckpoint.snapshotSeq, "离线后中心只返回最近派生 checkpoint");
  assert.equal(checkpoint.capturedAt, onlineCheckpoint.capturedAt);
  B.close();
});
