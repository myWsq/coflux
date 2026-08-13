/**
 * plan 073：session agent presence（工作区活动状态的进程树信号）。
 *
 * 验收核心：PTY 进程树里出现名为 claude 的进程 → 全账号客户端收到 sessionAgentsUpdated
 * （含 agent 名与 session/task 归属）；进程退出 → presence 清空；纯 shell 绝不误报；
 * 新订阅的客户端（页面刷新路径）订阅即拿到当前全量补发，无需等下一次变化。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8856;
let stack;
const dirs = [];

function mkDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-agent-")));
  dirs.push(dir);
  return dir;
}

/** terminalCreate → 目录工作区 + 任务 → taskStart，返回 { ws, task }（task 已 RUNNING）。 */
async function startDirTerminal(c, home) {
  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
  const ws = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === home, "dir ws");
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.workspace.id, "task co-created");
  c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  const run = await c.waitFor(
    (m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING,
    "task running",
  );
  return { ws: ws.workspace, task: run.task };
}

async function removeWorkspace(c, workspaceId) {
  // terminalCreate 自 plan 048 起按设备幂等复用目录工作区，残留会改变后续用例的行为
  c.send({ case: "workspaceRemove", workspaceId });
  await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === workspaceId, "cleanup ws removed");
}

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => {
  await stack?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("agent presence：claude 进程出现→上报（含归属），退出→清空；新订阅补发全量", async () => {
  const home = mkDir();
  // 假 agent：脚本文件本身命名为 claude——Linux 下 comm 即脚本 basename，macOS 下
  // argv[0]=/bin/sh（解释器）→ 匹配 argv[1] 的 basename，两平台各命中一条规则。
  const script = join(home, "claude");
  writeFileSync(script, "#!/bin/sh\nsleep 300\n");
  chmodSync(script, 0o755);

  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const sessionId = task.sessionId;

  await device.attach(sessionId);
  await device.input(sessionId, "./claude\r");

  // worker 2s 周期扫描 + 变化上报 → server 广播给账号内全部订阅客户端
  const updated = await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId),
    "agent presence 上报",
    20000,
  );
  const entry = updated.sessions.find((s) => s.sessionId === sessionId);
  assert.equal(entry.agent, "claude");
  assert.equal(entry.taskId, task.id, "presence 携带正确的 task 归属");
  assert.equal(updated.daemonId, stack.daemonId);

  // 新订阅客户端（页面刷新路径）：订阅即收到当前全量补发，无需重新观察"活跃→安静"转变
  const fresh = stack.makeClient();
  try {
    await fresh.authSubscribe(stack.username, stack.password);
    const replay = await fresh.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId && s.agent === "claude"),
      "订阅补发 presence",
      5000,
    );
    assert.equal(replay.daemonId, stack.daemonId);
  } finally {
    fresh.close();
  }

  // Ctrl-C 结束假 agent → 下一轮扫描发现集合变化 → 上报清空
  await device.input(sessionId, "\x03");
  await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && !m.sessions.some((s) => s.sessionId === sessionId),
    "agent 退出后 presence 清空",
    20000,
  );

  await removeWorkspace(c, ws.id);
  device.close();
});

test("负向：纯 shell（含普通子进程）不产生 presence", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const sessionId = task.sessionId;

  await device.attach(sessionId);
  await device.input(sessionId, "sleep 300 &\r");

  // 等满两个 2s 扫描周期 + 余量，再断言消息日志里从未出现该 session 的 presence
  await sleep(6000);
  const leaked = c.log.find((m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId));
  assert.equal(leaked, undefined, "普通进程树绝不上报 agent");

  await removeWorkspace(c, ws.id);
  device.close();
});
