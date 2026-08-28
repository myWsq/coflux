/**
 * plan 073：session agent presence（工作区活动状态的进程树信号）+ hook 回合状态。
 *
 * 验收核心：PTY 进程树里出现名为 claude 的进程 → 全账号客户端收到 sessionAgentsUpdated
 * （含 agent 名与 session/task 归属）；进程退出 → presence 清空；纯 shell 绝不误报；
 * 新订阅的客户端（页面刷新路径）订阅即拿到当前全量补发，无需等下一次变化。
 *
 * hook 化后的回合状态：`cofluxd hook` 信使在会话进程树内 POST /hook → worker 用 pid
 * 反查归属 session → presence 条目携带 state（waiting/active）立即广播；树外 pid 被拒。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8856;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/cofluxd.mjs", import.meta.url));
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

test("agent presence：出现/退出、新订阅补发与 server 重启 force 恢复", async () => {
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

  // server 的 presence 是纯内存态：重启后 daemon 侧观察结果没有变化，周期去重不会重发；
  // 必须依靠重新认证后的 force 全量补齐。先关旧 client，PTY/假 agent 仍由 supervisor 持有。
  device.close();
  await stack.restartServer();
  await stack.waitDaemonOnline();
  const reconnected = await openRelayDevice(stack);
  const reconnectedControl = reconnected.control;
  const forced = await reconnectedControl.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId && s.agent === "claude"),
    "server 重启后 force 补发 agent presence",
    20000,
  );
  assert.equal(forced.daemonId, stack.daemonId);

  // Ctrl-C 结束假 agent → 下一轮扫描发现集合变化 → 上报清空
  await reconnected.attach(sessionId);
  await reconnected.input(sessionId, "\x03");
  await reconnectedControl.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && !m.sessions.some((s) => s.sessionId === sessionId),
    "agent 退出后 presence 清空",
    20000,
  );

  await removeWorkspace(reconnectedControl, ws.id);
  reconnected.close();
});

test("hook 回合状态：Stop→done、后台在飞的 Stop→active、PermissionRequest→approval、Notification 分型、PreToolUse→active；树外 pid 与非 json 被拒", async () => {
  const home = mkDir();
  const script = join(home, "claude");
  writeFileSync(script, "#!/bin/sh\nsleep 300\n");
  chmodSync(script, 0o755);

  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const sessionId = task.sessionId;
  const gatewayPort = device.gateway.port;

  await device.attach(sessionId);
  // 假 agent 挂后台：presence 靠它，前台留给 hook 信使跑
  await device.input(sessionId, "./claude &\r");

  // presence 先就位，初始无 hook 信号（state 空）
  const present = await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId),
    "presence 上报",
    20000,
  );
  assert.equal(present.sessions.find((s) => s.sessionId === sessionId).state, "");

  // 信使在会话进程树内执行（与真实 hook 同构）：事件被接受即触发上报，无需等扫描周期
  const hookCmd = (json) =>
    `printf '%s' '${json}' | COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} hook claude\r`;
  await device.input(sessionId, hookCmd('{"hook_event_name":"Stop"}'));
  const done = await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId && s.state === "done"),
    "Stop → done",
    15000,
  );
  assert.equal(done.sessions.find((s) => s.sessionId === sessionId).agent, "claude", "state 变化不丢 agent 名");

  // 同一个 Stop，但 payload 带在飞的后台工作：agent 是「挂起等后台叫醒自己」而非做完了。
  // 这条必须走端到端——信使侧的条数提取（description 不出机）单测覆盖不到。
  const stopWithBg =
    '{"hook_event_name":"Stop","background_tasks":[{"id":"b1","type":"shell","status":"running","description":"pnpm build"}]}';
  await device.input(sessionId, hookCmd(stopWithBg));
  await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId && s.state === "active"),
    "Stop + 在飞后台工作 → active",
    15000,
  );

  await device.input(sessionId, hookCmd('{"hook_event_name":"PermissionRequest"}'));
  await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId && s.state === "approval"),
    "PermissionRequest → approval",
    15000,
  );

  await device.input(sessionId, hookCmd('{"hook_event_name":"Notification","notification_type":"agent_needs_input"}'));
  await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId && s.state === "question"),
    "Notification agent_needs_input → question",
    15000,
  );

  await device.input(sessionId, hookCmd('{"hook_event_name":"PreToolUse"}'));
  await c.waitFor(
    (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === sessionId && s.state === "active"),
    "PreToolUse → active",
    15000,
  );

  // 树外 pid（测试进程自身，coflux 之外启动的 agent 的等价形态）：404 拒收
  const outside = await fetch(`http://127.0.0.1:${gatewayPort}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "claude", event: "Stop", pid: process.pid, ppid: process.ppid }),
  });
  assert.equal(outside.status, 404, "树外 pid 的上报必须被拒");

  // content-type 门禁：非 json 直接 400（挡浏览器"简单请求"对 localhost 的盲打）
  const plain = await fetch(`http://127.0.0.1:${gatewayPort}/hook`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ agent: "claude", event: "Stop", pid: process.pid }),
  });
  assert.equal(plain.status, 400, "非 application/json 必须被拒");

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
