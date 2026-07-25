import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8834;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("输出环挤掉 bracketed-paste 原始转义后，sessiond snapshot 仍恢复模式状态", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const first = await openRelayDevice(stack);
  const a = first.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "dec" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "dec", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  await first.attach(sessionId);

  // 模拟 claude code 启动时打开 bracketed paste（DECSET 2004）
  let from = first.mark();
  await first.input(sessionId, "printf '\\033[?2004h'\r");
  await first.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("\x1b[?2004h"), "模式转义已写入 PTY", 10000, from);

  // 灌 >200KB 输出，把上面这段转义挤出 supervisor 的 200KB scrollback 环
  await first.input(sessionId, "yes | head -c 250000; echo FLOOD_DONE\r");
  // ACK 证明命令已写入 PTY；随后断开 subscriber，让大输出不受浏览器/relay 消费速度影响。
  first.closeTransport();
  await sleep(300);
  await first.openRelay();
  const deadline = Date.now() + 30000;
  let completed = false;
  while (Date.now() < deadline) {
    let current;
    try {
      current = await first.attach(sessionId, { timeout: 3000 });
    } catch (error) {
      if (!String(error).includes("transport send failed") && !String(error).includes("sessionAttached")) throw error;
      await first.openRelay();
      continue;
    }
    if (utf8(current.ansiSnapshot ?? new Uint8Array()).includes("FLOOD_DONE")) {
      completed = true;
      break;
    }
    await sleep(50);
  }
  assert.equal(completed, true, "大输出完成 marker 已进入原子 snapshot");
  first.close();

  // 重启服务器：session authority 仍在 supervisor；新 client 直接向 sessiond 取原子 snapshot。
  await stack.restartServer();
  await stack.waitDaemonOnline();

  const second = await openRelayDevice(stack);
  const snap = second.control.log.find((message) => message.case === "stateSnapshot");
  const rec = snap.tasks.find((t) => t.id === taskId);
  assert.ok(rec, "重启后任务记录仍在");
  assert.equal(rec.status, TaskStatus.RUNNING, "重启后任务仍 running");
  const attached = await second.attach(sessionId, { timeout: 30000 });
  const snapshot = utf8(attached.ansiSnapshot ?? new Uint8Array());
  assert.ok(snapshot.includes("FLOOD_DONE"), "snapshot 包含大输出完成 marker");
  assert.ok(snapshot.includes("\x1b[?2004h"), "snapshot 带出已不在原始输出环中的 bracketed-paste 模式");
  second.close();
});
