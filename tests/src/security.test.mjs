import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { startStack, mkRepo } from "./harness.mjs";

const PORT = 8824;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

/** 一个原始 /daemon 连接，用于模拟"同账号但不同设备"的恶意/有缺陷 daemon */
function rawDaemon(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
  const log = [];
  let waiters = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); log.push(m); waiters = waiters.filter((w) => !w.try(m)); };
  return {
    ready: new Promise((r) => (ws.onopen = r)),
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, label, t = 8000) => { const h = log.find(pred); if (h) return Promise.resolve(h); return new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error("timeout " + label)), t); waiters.push({ try: (m) => (pred(m) ? (clearTimeout(tm), res(m), true) : false) }); }); },
    close: () => ws.close(),
  };
}

test("跨 daemon 劫持被拒：resync/session.exit 对他设备的任务无效", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const a = stack.makeClient();
  await a.authSubscribe();
  a.send({ type: "project.import", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain, "main");
  a.send({ type: "task.create", workspaceId: main.workspace.id, title: "victim" });
  const idle = await a.waitFor((m) => m.type === "task.updated" && m.task.title === "victim", "idle");
  const taskId = idle.task.id;
  a.send({ type: "task.start", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.type === "task.updated" && m.task.id === taskId && m.task.status === "running", "run");
  const victimSession = run.task.sessionId;

  const evil = rawDaemon(PORT);
  await evil.ready;
  evil.send({ type: "daemon.enroll", enrollmentKey: "dev-enroll", name: "evil", host: "evil", platform: "x", protocolVersion: 5, capabilities: [] });
  await evil.waitFor((m) => m.type === "daemon.enrolled", "evil enrolled");
  evil.send({ type: "daemon.resync", sessions: [{ sessionId: "evil-sess", taskId }] });
  evil.send({ type: "session.exit", sessionId: victimSession, exitCode: 0 });
  await sleep(700);
  evil.close();

  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  const victim = snap.tasks.find((t) => t.id === taskId);
  assert.equal(victim.status, "running", "victim 任务仍 running（session.exit 被拒）");
  assert.equal(victim.sessionId, victimSession, "victim sessionId 未被 resync 劫持");
  assert.ok(!a.log.some((m) => m.type === "task.updated" && m.task.id === taskId && m.task.status === "exited"), "owner 未收到伪造 exited");
  a.close();
  c.close();
});

test("畸形 wire 数据不致崩溃，服务器仍正常服务", async () => {
  const junk = stack.makeClient();
  await junk.ready;
  junk.send("not json");
  junk.send({ type: "daemon.resync", sessions: null });
  junk.send({ type: "client.auth" });
  junk.send({ type: "client.auth", clientToken: 123 });
  junk.send({ type: "unknown.kind", x: 1 });
  junk.send({ type: "task.start", taskId: 1, cols: "big", rows: {} });
  await sleep(400);
  junk.close();

  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  assert.ok(snap, "畸形输入后仍能正常登录订阅");
  c.close();
});
