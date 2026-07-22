import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8834;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("supervisor scrollback 环挤掉 bracketed-paste 模式转义后，replay 仍带得出模式状态", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const a = stack.makeClient();
  await a.authSubscribe();
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "dec" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "dec", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;

  // 模拟 claude code 启动时打开 bracketed paste（DECSET 2004）
  a.send({ case: "ptyInput", sessionId, data: "printf '\\033[?2004h'\r" });
  await a.waitFor((m) => m.case === "ptyOutput" && m.data.includes("\x1b[?2004h"), "模式转义已写入 PTY");

  // 灌 >200KB 输出，把上面这段转义挤出 supervisor 的 200KB scrollback 环
  a.send({ case: "ptyInput", sessionId, data: "yes | head -c 250000; echo FLOOD_DONE\r" });
  await a.waitFor((m) => m.case === "ptyOutput" && m.data.includes("FLOOD_DONE"), "灌水完成");
  a.close();

  // 重启服务器：session 记录在 daemon 侧存活，但 server 镜像重新创建，primed=false，
  // 下次 attach 走慢路径———向 daemon 要全量 replay（此时 supervisor 环里早已没有 ?2004h 原文，
  // 全靠 worker 层的 DecModeTracker 补前缀）
  await stack.restartServer();
  await new Promise((r) => setTimeout(r, 4500));

  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  const rec = snap.tasks.find((t) => t.id === taskId);
  assert.ok(rec, "重启后任务记录仍在");
  assert.equal(rec.status, TaskStatus.RUNNING, "重启后任务仍 running");
  c.send({ case: "taskAttach", taskId });
  const replayed = await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("FLOOD_DONE"), "回放到达");
  assert.ok(replayed.data.includes("\x1b[?2004h"), "replay 数据应带出被环挤掉的 bracketed-paste 模式前缀");
  c.close();
});
