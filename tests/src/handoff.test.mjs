import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8823;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("独占 + handoff：第二个 client 接管，原控制端被踢、输入被拒、不再收输出", async () => {
  const repo = mkRepo();
  repos.push(repo);

  const A = stack.makeClient();
  await A.authSubscribe();
  A.send({ type: "project.import", daemonId: stack.daemonId, path: repo.dir });
  const main = await A.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain, "main");
  A.send({ type: "task.create", workspaceId: main.workspace.id, title: "h" });
  const idle = await A.waitFor((m) => m.type === "task.updated" && m.task.title === "h", "idle");
  const taskId = idle.task.id;
  A.send({ type: "task.start", taskId, cols: 80, rows: 24 });
  const run = await A.waitFor((m) => m.type === "task.updated" && m.task.id === taskId && m.task.status === "running", "run");
  const sess = run.task.sessionId;
  await A.waitFor((m) => m.type === "pty.output" && m.sessionId === sess, "A first out");
  A.send({ type: "pty.input", sessionId: sess, data: "echo AAA\r" });
  await A.waitFor((m) => m.type === "pty.output" && m.data.includes("AAA"), "A sees AAA");
  await sleep(200);

  // B 接管
  const B = stack.makeClient();
  await B.authSubscribe();
  B.send({ type: "task.attach", taskId });
  await B.waitFor((m) => m.type === "pty.output" && m.data.includes("AAA"), "B replay AAA");
  await A.waitFor((m) => m.type === "task.detached" && m.taskId === taskId, "A detached");

  // A 输入被拒
  A.send({ type: "pty.input", sessionId: sess, data: "echo A_FAIL\r" });
  await A.waitFor((m) => m.type === "error" && m.message.includes("无控制权"), "A input rejected");

  // B 正常输入；A 收不到后续输出
  B.send({ type: "pty.input", sessionId: sess, data: "echo BBB\r" });
  await B.waitFor((m) => m.type === "pty.output" && m.data.includes("BBB"), "B sees BBB");
  await sleep(400);
  assert.ok(!A.log.some((m) => m.type === "pty.output" && m.data.includes("BBB")), "A 收不到 B 的后续输出");
  assert.ok(!A.log.some((m) => m.type === "pty.output" && m.data.includes("A_FAIL")), "被拒输入未进入 PTY");

  A.close();
  B.close();
});
