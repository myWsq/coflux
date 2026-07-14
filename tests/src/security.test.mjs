import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { create, ClientToServerSchema, encodeClientToServer, TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, rawDaemon } from "./harness.mjs";

const PORT = 8824;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("跨 daemon 劫持被拒：resync/session.exit 对他设备的任务无效", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const a = stack.makeClient();
  await a.authSubscribe();
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "victim" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "victim", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const victimSession = run.task.sessionId;

  // 模拟"同账号但不同设备"的恶意/有缺陷 daemon（复用 harness 的裸 /daemon 连接）
  const evil = rawDaemon(PORT);
  await evil.ready;
  evil.send({ case: "daemonEnroll", enrollmentKey: "dev-enroll", name: "evil", host: "evil", platform: "x" });
  await evil.waitFor((m) => m.case === "daemonEnrolled", "evil enrolled");
  evil.send({ case: "daemonResync", sessions: [{ sessionId: "evil-sess", taskId }] });
  evil.send({ case: "sessionExit", sessionId: victimSession, exitCode: 0 });
  await sleep(700);
  evil.close();

  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  const victim = snap.tasks.find((t) => t.id === taskId);
  assert.equal(victim.status, TaskStatus.RUNNING, "victim 任务仍 running（session.exit 被拒）");
  assert.equal(victim.sessionId, victimSession, "victim sessionId 未被 resync 劫持");
  assert.ok(!a.log.some((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.EXITED), "owner 未收到伪造 exited");
  a.close();
  c.close();
});

test("畸形 wire 数据不致崩溃，服务器仍正常服务", async () => {
  const junk = stack.makeClient();
  await junk.ready;
  // 真正畸形的字节（非法 protobuf 编码）：decode* helper 应 try/catch 兜底为 null，服务端丢弃，
  // 连接与进程都不应崩溃（见 packages/protocol/src/index.ts 的运行时校验说明）。
  junk.ws.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]));
  junk.ws.send(new Uint8Array([0x00]));
  junk.ws.send(Buffer.from("not protobuf at all, just plain garbage bytes"));
  // 合法编码但 oneof 未设置任何分支（空 payload）——服务端应按"未知 case"丢弃。
  junk.ws.send(encodeClientToServer(create(ClientToServerSchema, {})));
  // 结构合法但引用不存在实体的正常消息——不应导致崩溃。
  junk.send({ case: "taskStart", taskId: "does-not-exist", cols: 80, rows: 24 });
  junk.send({ case: "clientAuth" }); // 缺字段
  await sleep(400);
  junk.close();

  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  assert.ok(snap, "畸形输入后仍能正常登录订阅");
  c.close();
});
