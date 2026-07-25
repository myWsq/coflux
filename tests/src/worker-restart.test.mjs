import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

// supervisor/worker 拆分的核心保证：杀掉 worker，PTY 在 supervisor 存活，
// worker 重启后两级 resync（连 supervisor 取回会话 + 连 server resync）重挂会话。
const PORT = 8827;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

function readWorkerPid() {
  return Number(readFileSync(join(stack.home, "worker.pid"), "utf8").trim());
}

test("worker 重启：PTY 在 supervisor 存活，两级 resync 重挂会话", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openRelayDevice(stack);
  const a = device.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "wr" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "wr", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  const initial = await device.attach(sessionId);
  let from = device.mark();
  await device.input(sessionId, "echo SURVIVE_MARKER\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("SURVIVE_MARKER"), "marker before kill", 10000, from);

  // 杀掉 worker（SIGKILL）——supervisor 应自动重启它；PTY 在 supervisor 进程不受影响
  const pid1 = readWorkerPid();
  process.kill(pid1, "SIGKILL");

  // 等 worker 重启 + 两级 resync，daemon 重新在线
  let online = false;
  for (let i = 0; i < 40 && !online; i++) {
    await sleep(250);
    const p = stack.makeClient();
    try {
      const snap = await p.authSubscribe();
      const dev = snap.daemons.find((d) => d.daemonId === stack.daemonId);
      online = !!(dev && dev.online);
    } catch {
      /* server/worker 可能还在恢复 */
    }
    p.close();
  }
  assert.ok(online, "worker 重启后 daemon 重新在线");

  const pid2 = readWorkerPid();
  assert.notEqual(pid2, pid1, "worker 确实是新进程（被重启）");

  // 任务仍 running（两级 resync 重挂，没标 exited）
  const probe = stack.makeClient();
  const snap = await probe.authSubscribe();
  const rec = snap.tasks.find((t) => t.id === taskId);
  assert.ok(rec && rec.status === TaskStatus.RUNNING, "worker 重启后任务仍 running");
  probe.close();

  // 同 logical Device client 迁到新 relay；holder epoch 不变，snapshot 来自 supervisor/sessiond。
  await device.openRelay();
  const attached = await device.attach(sessionId);
  assert.equal(attached.holderEpoch, initial.holderEpoch, "worker transport 重建不触发 holder takeover");
  assert.ok(utf8(attached.ansiSnapshot ?? new Uint8Array()).includes("SURVIVE_MARKER"), "重启后 sessiond snapshot 历史存活");

  // 交互恢复：新输入经 Device relay→worker→sessiond→PTY。
  from = device.mark();
  await device.input(sessionId, "echo AFTER_RESTART\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_RESTART"), "重启后交互恢复", 10000, from);
  device.close();
});
