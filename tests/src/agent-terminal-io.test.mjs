/**
 * plan 088：agent 协同控制第二片——终端 wait/send 与进度短评。
 *
 * 验收核心：
 * - `terminal wait` 阻塞到目标终端退出并打印退出码；超时明确报错（非零退出），不误报成功；
 * - `terminal send` 在无人接管时经 sessiond 正门写入 PTY（命令真收到输入），
 *   **用户正在 attach 时被拒**且错误可读——人类优先是本片的硬边界；
 * - `cofluxd progress` 的短评经中心广播到 client，**跨 hook 事件存活**（与 notify 的
 *   「hook 事件即清空」刻意不同），被下一条覆盖。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8861;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/cofluxd.mjs", import.meta.url));
let stack;
const dirs = [];

function mkDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-agentio-")));
  dirs.push(dir);
  return dir;
}

/** terminalCreate → 目录工作区 + 任务 → taskStart（同 agent-control.test.mjs）。 */
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
  c.send({ case: "workspaceRemove", workspaceId });
  await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === workspaceId, "cleanup ws removed");
}

function cliCmd(gatewayPort, args, outFile) {
  return `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} ${args} > ${outFile} 2>&1\r`;
}

async function waitForFile(path, predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      last = readFileSync(path, "utf8");
      if (predicate(last)) return last;
    }
    await sleep(200);
  }
  throw new Error(`${label} 超时；最后内容: ${JSON.stringify(last)}`);
}

/** 在发起方会话里开一个 agent 终端并等它 RUNNING，返回中心侧 task。 */
async function newAgentTerminal(c, device, task, ws, gatewayPort, home, title, cmd) {
  const outFile = join(home, `new-${title}.txt`);
  await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "${title}" --cmd "${cmd}"`, outFile));
  const created = await c.waitFor(
    (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === title && m.task.status === TaskStatus.RUNNING,
    `${title} 跑起来`,
    30000,
  );
  return created.task;
}

before(async () => {
  stack = await startStack({ port: PORT });
});
after(async () => {
  await stack?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("terminal wait：阻塞到退出并打印退出码；超时明确报错不误报", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    const target = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "慢命令", "sleep 2; exit 5");

    // wait 在命令还在跑时发起，必须真的阻塞到退出，然后把退出码打出来
    const waitOut = join(home, "wait.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal wait ${target.id} --timeout 60`, waitOut));
    const waitText = await waitForFile(waitOut, (s) => s.includes("exited"), "terminal wait 输出");
    assert.match(waitText, /# exited exit=5/, `wait 要打印退出码: ${waitText}`);

    // 超时路径：长跑终端 + 1 秒超时 → 可读报错，绝不能输出 exited
    const runner = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "长跑", "sleep 60");
    const timeoutOut = join(home, "timeout.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal wait ${runner.id} --timeout 1`, timeoutOut));
    const timeoutText = await waitForFile(timeoutOut, (s) => s.includes("超时"), "terminal wait 超时输出");
    assert.match(timeoutText, /等待超时/, `超时要可读: ${timeoutText}`);
    assert.ok(!timeoutText.includes("# exited"), "超时不能误报成退出");
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("terminal send：无人接管时写得进（命令真收到输入）；用户 attach 期间被拒且错误可读", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // 目标命令用 read 等一行输入：send 进去后它回显并退出——「写入真实生效」的闭环证据。
    // ⚠ $line 必须写成 \$line：--cmd "…" 是打进**发起方 shell** 的，双引号内不转义的话
    // $line 会被发起方先展开成空串，目标终端存下的命令就只剩 `echo GOT:`（曾真踩过）。
    // 先打 READY、等它出现再 send，同时演练 SKILL.md 的「先 read 再 send」纪律。
    const target = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "等输入", "echo READY; read line; echo GOT:\\$line; exit 0");
    const readyOut = join(home, "ready.txt");
    for (let attempt = 0; ; attempt += 1) {
      await device.input(task.sessionId, cliCmd(gatewayPort, `terminal read ${target.id}`, readyOut));
      const text = await waitForFile(readyOut, (s) => s.trim().length > 0, "READY 探测");
      if (text.includes("READY")) break;
      if (attempt >= 20) throw new Error(`等 READY 超时: ${JSON.stringify(text)}`);
      rmSync(readyOut, { force: true });
      await sleep(500);
    }

    const sendOut = join(home, "send.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal send ${target.id} --text "ping" --enter`, sendOut));
    const sendText = await waitForFile(sendOut, (s) => s.trim().length > 0, "terminal send 输出");
    assert.match(sendText, /已写入终端/, `send 命令失败: ${sendText}`);

    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === target.id && m.task.status === TaskStatus.EXITED,
      "收到输入后 read 返回并退出",
      30000,
    );
    const readOut = join(home, "after-send.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal read ${target.id}`, readOut));
    const readText = await waitForFile(readOut, (s) => s.includes("GOT:"), "send 后 read 输出");
    assert.match(readText, /GOT:ping/, `命令必须真收到输入: ${readText}`);

    // 人类优先：用户 attach 目标终端期间，send 必须被拒且错误可读
    const held = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "被接管", "sleep 60");
    await device.attach(held.sessionId);
    const rejectOut = join(home, "reject.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal send ${held.id} --text "x" --enter`, rejectOut));
    const rejectText = await waitForFile(rejectOut, (s) => s.trim().length > 0, "被拒输出");
    assert.match(rejectText, /用户正在接管/, `接管期间必须被拒: ${rejectText}`);

    // 目标不在本工作区：随便编个 id，错误要可读
    const missOut = join(home, "miss.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal send no-such-task --text "x" --enter`, missOut));
    const missText = await waitForFile(missOut, (s) => s.trim().length > 0, "不存在目标输出");
    assert.match(missText, /不在本工作区或不存在/, `目标不存在要可读: ${missText}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("progress：短评经中心广播、跨 hook 事件存活、被下一条覆盖", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // presence 存活门：进程树里得有个 agent（同 agent-control.test.mjs 的假 claude）
    const script = join(home, "claude");
    writeFileSync(script, "#!/bin/sh\nsleep 300\n");
    chmodSync(script, 0o755);
    await device.input(task.sessionId, "./claude &\r");
    await c.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === task.sessionId),
      "presence 就位",
      30000,
    );

    const progressOut = join(home, "progress.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `progress "复现了，正在定位"`, progressOut));
    const progressText = await waitForFile(progressOut, (s) => s.trim().length > 0, "progress CLI 输出");
    assert.match(progressText, /已更新进度/, `progress 命令失败: ${progressText}`);

    const first = await c.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === task.sessionId && s.progress === "复现了，正在定位"),
      "progress 广播到 client",
      30000,
    );
    // progress 与 state 是两个维度：播报进度不该把回合状态改成 question
    assert.notEqual(first.sessions.find((s) => s.sessionId === task.sessionId).state, "question", "progress 不能置 question");

    // 跨 hook 事件存活：hook 会清 notify 的 message，但 progress 必须留下
    await device.input(
      task.sessionId,
      `printf '%s' '{"hook_event_name":"PreToolUse"}' | COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} hook claude\r`,
    );
    await c.waitFor(
      (m) =>
        m.case === "sessionAgentsUpdated" &&
        m.sessions.some((s) => s.sessionId === task.sessionId && s.state === "active" && s.progress === "复现了，正在定位"),
      "hook 事件后 progress 仍在（state 已转 active）",
      30000,
    );

    // 覆盖式：下一条替换上一条
    const secondOut = join(home, "progress2.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `progress "修完了，在跑回归"`, secondOut));
    await c.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === task.sessionId && s.progress === "修完了，在跑回归"),
      "progress 被下一条覆盖",
      30000,
    );
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});
