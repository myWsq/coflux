import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";

// 热升级：升级投递（client.upgradeDaemon → server → worker.upgrade → supervisor）
// + 切换 + 观察期/回滚。会话全程在 supervisor 存活。不接下载/验签（按安全约束，仅在
// supervisor 自有注册表的"已知版本"间切换）。
const PORT = 8828;
const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER_BIN = process.env.COFLUX_WORKER_BIN || join(ROOT, "target", "debug", "coflux-worker");

// 注入两个测试版本：good2 = 真 worker 的副本（应升级成功并提交）；bad2 = 立即崩溃（应回滚）
const SPECS = {
  good2: { cmd: WORKER_BIN, args: [] },
  bad2: { cmd: process.execPath, args: ["-e", "process.exit(1)"] },
};

let stack;
const repos = [];

before(async () => {
  stack = await startStack({
    port: PORT,
    daemonEnv: { COFLUX_WORKER_SPECS: JSON.stringify(SPECS), COFLUX_WORKER_PROBATION_MS: "1500" },
  });
});
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

function readActive() {
  return readFileSync(join(stack.home, "worker.active"), "utf8").trim();
}
function readWorkerPid() {
  return Number(readFileSync(join(stack.home, "worker.pid"), "utf8").trim());
}
async function isOnline() {
  const p = stack.makeClient();
  try {
    const snap = await p.authSubscribe();
    const dev = snap.daemons.find((d) => d.daemonId === stack.daemonId);
    return !!(dev && dev.online);
  } catch {
    return false;
  } finally {
    p.close();
  }
}
// 等到「新」worker 起来且在线（pid 变化 = 新进程；避免抢到升级前的旧在线状态）
async function waitNewWorker(prevPid) {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    let pid;
    try { pid = readWorkerPid(); } catch { continue; }
    if (pid === prevPid) continue;
    if (await isOnline()) return pid;
  }
  return 0;
}

// 起一个运行中的任务并打个 marker，返回 {taskId, sessionId}
async function runTaskWithMarker(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const a = stack.makeClient();
  await a.authSubscribe();
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "up" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "up", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  a.send({ case: "ptyInput", sessionId, data: `echo ${marker}\r` });
  await a.waitFor((m) => m.case === "ptyOutput" && m.data.includes(marker), "marker");
  a.close();
  return { taskId, sessionId };
}

test("热升级成功：切到 good2、观察期通过提交，会话存活", async () => {
  assert.equal(readActive(), "builtin", "初始版本 builtin");
  const { taskId, sessionId } = await runTaskWithMarker("UP_OK_MARK");
  const pid1 = readWorkerPid();

  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "good2" });

  // 等新 worker 起来且在线（pid 变化）
  const pid2 = await waitNewWorker(pid1);
  assert.ok(pid2, "升级后新 worker 起来且在线");
  // 等观察期通过、提交为 good2（PROBATION_MS=1500）
  let committed = false;
  for (let i = 0; i < 40 && !committed; i++) {
    await sleep(250);
    try { committed = readActive() === "good2"; } catch { /* 文件可能瞬时缺失 */ }
  }
  assert.ok(committed, "升级提交后 worker.active=good2");

  // 会话存活：回放含升级前 marker + 升级后仍可交互
  c.send({ case: "taskAttach", taskId });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("UP_OK_MARK"), "升级后回放历史");
  c.send({ case: "ptyInput", sessionId, data: "echo AFTER_UPGRADE\r" });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("AFTER_UPGRADE"), "升级后交互恢复");
  c.close();
});

test("坏版本回滚：切到 bad2 崩溃循环 → 自动回滚，会话存活", async () => {
  const activeBefore = readActive(); // 上一个测试后应为 good2
  const { taskId, sessionId } = await runTaskWithMarker("ROLLBACK_MARK");
  const pidBefore = readWorkerPid();

  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "bad2" });

  // bad2 立即崩溃 → 达阈值回滚到 activeBefore → 新 good worker 起来（bad2 不写 pid，故 pid 变化=回滚后的好版本）
  assert.ok(await waitNewWorker(pidBefore), "回滚后新 worker 起来且在线");
  // active 未变（bad2 从未通过观察期提交）
  assert.equal(readActive(), activeBefore, "回滚后 worker.active 仍是升级前版本");

  // 会话存活：回放含升级前 marker + 仍可交互
  c.send({ case: "taskAttach", taskId });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("ROLLBACK_MARK"), "回滚后回放历史");
  c.send({ case: "ptyInput", sessionId, data: "echo AFTER_ROLLBACK\r" });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("AFTER_ROLLBACK"), "回滚后交互恢复");
  c.close();
});
