/**
 * plan 088：agent 协同控制第二片——终端 wait/send 与进度短评。
 *
 * 验收核心：
 * - `terminal wait` 阻塞到目标终端退出并打印退出码；超时明确报错（非零退出），不误报成功；
 * - `terminal send` 在无人接管时经 sessiond 正门写入 PTY（命令真收到输入），
 *   **用户正在 attach 时被拒**且错误可读——人类优先是本片的硬边界；
 * - `cofluxd progress` 的短评经中心广播到 client，**跨 hook 事件存活**（与 notify 的
 *   「hook 事件即清空」刻意不同），被下一条覆盖；
 * - plan 094（local-first）：wait/read/send 按 taskId 直接问 daemon 本地账本——目标已退出时 wait 立即
 *   给退出码，目标被 `terminal list` 的 50 条窗口挤出去也照样命中；命令日志有界保尾，输出远超一段
 *   容量后 read 仍返回最新尾行、退出码正确、磁盘占用有界。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, chmodSync } from "node:fs";
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

    // plan 094：目标已退出时 wait 立即返回——退出码留在 daemon 本地账本里，不经中心
    const againOut = join(home, "wait-again.txt");
    const t0 = Date.now();
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal wait ${target.id} --timeout 5`, againOut));
    const againText = await waitForFile(againOut, (s) => s.includes("exited"), "已退出终端的 wait 输出");
    assert.match(againText, /# exited exit=5/, `已退出的 wait 要立即给退出码: ${againText}`);
    assert.ok(Date.now() - t0 < 5000, "已退出的终端不该等到超时");

    // plan 094：wait/read 按 taskId 直接寻址，不受 `terminal list` 只回最近 50 条的窗口影响。
    // 用 50 个 IDLE 任务把目标挤出窗口：list 看不到它，wait/read 照样命中（074 时代这里会误报「没有终端」）。
    for (let i = 0; i < 50; i += 1) c.send({ case: "taskCreate", workspaceId: ws.id, title: `filler-${i}` });
    for (let i = 0; i < 50; i += 1) {
      await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === `filler-${i}`, `filler-${i} 建好`, 30000);
    }
    const listOut = join(home, "list-window.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, "terminal list", listOut));
    const listText = await waitForFile(listOut, (s) => s.includes("filler-49"), "挤满后的 list 输出");
    assert.ok(!listText.includes(target.id), "目标应已被挤出 list 的 50 条窗口（否则本用例没在测东西）");
    const pushedOut = join(home, "wait-pushed.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal wait ${target.id} --timeout 5`, pushedOut));
    const pushedText = await waitForFile(pushedOut, (s) => s.trim().length > 0, "窗口外目标的 wait 输出");
    assert.match(pushedText, /# exited exit=5/, `窗口外的目标 wait 必须仍命中: ${pushedText}`);
    const readPushedOut = join(home, "read-pushed.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal read ${target.id}`, readPushedOut));
    const readPushedText = await waitForFile(readPushedOut, (s) => s.trim().length > 0, "窗口外目标的 read 输出");
    assert.match(readPushedText, /# exited exit=5/, `窗口外的目标 read 必须仍命中: ${readPushedText}`);

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

test("命令日志有界保尾（plan 094）：输出远超一段容量后 read 仍返回最新尾行、退出码正确，磁盘占用有界", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // seq 1..400000 ≈ 2.7 MB，远超日志汇的单段 1 MiB：必须轮转两次以上。命令秒级跑完，
    // 不等 RUNNING（可能已经 EXITED），直接等 EXITED。
    const newOut = join(home, "new-big.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "大输出" --cmd "seq 1 400000; echo LAST-LINE-MARK; exit 4"`, newOut));
    const created = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "大输出", "大输出任务出现", 30000);
    const exited = await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === created.task.id && m.task.status === TaskStatus.EXITED, "大输出跑完", 60000);
    assert.equal(exited.task.exitCode, 4, "退出码必须原样透传（管道尾换成日志汇后仍靠 PIPESTATUS）");

    const readOut = join(home, "big-read.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal read ${created.task.id} --lines 3`, readOut));
    const readText = await waitForFile(readOut, (s) => s.includes("LAST-LINE-MARK"), "大输出 read");
    assert.match(readText, /exit=4/, `read 要带退出码: ${readText}`);
    assert.match(readText, /400000\nLAST-LINE-MARK/, `尾部必须是最新的几行（保尾）: ${JSON.stringify(readText.slice(-80))}`);

    // 磁盘占用有界：当前段与上一段各不超过 1 MiB（log_sink SEGMENT_BYTES），且最新输出在当前段尾部
    const dir = realpathSync(join(tmpdir(), "coflux-agent-cmd"));
    const logs = readdirSync(dir)
      .filter((n) => n.startsWith("cmd-") && n.endsWith(".sh.log"))
      .map((n) => ({ path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    assert.ok(logs.length > 0, "应有命令日志落盘");
    const newest = logs[0].path;
    const size = statSync(newest).size;
    assert.ok(size <= 1024 * 1024, `当前段必须 ≤ 1 MiB: ${size}`);
    assert.ok(readFileSync(newest, "utf8").endsWith("LAST-LINE-MARK\n"), "最新输出必须在当前段尾部");
    const rotated = `${newest}.1`;
    assert.ok(existsSync(rotated), "远超一段容量后必须留有上一段");
    assert.ok(statSync(rotated).size <= 1024 * 1024, `上一段也必须 ≤ 1 MiB: ${statSync(rotated).size}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});
