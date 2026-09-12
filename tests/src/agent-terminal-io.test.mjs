/**
 * plan 088：agent 协同控制第二片——终端 wait/send 与进度短评（终端只有一种：常驻的登录 shell，命令是 do-script）。
 *
 * 验收核心：
 * - `terminal wait` 阻塞到**目标命令**结束并打印它的退出码（终端本身仍在跑）；超时明确报错（非零退出），不误报成功；
 *   已结束的命令再 wait 立即拿到留档的退出码；
 * - `terminal send` 在无人接管时经 sessiond 正门写入 PTY（命令真收到输入），
 *   **用户正在 attach 时被拒**且错误可读——人类优先是本片的硬边界；
 * - `coflux progress` 的短评经中心广播到 client，**跨 hook 事件存活**（与 notify 的
 *   「hook 事件即清空」刻意不同），被下一条覆盖；
 * - plan 094（local-first）：wait/read/send 按 taskId 直接问 daemon 本地账本——目标被 `terminal list` 的 50 条窗口
 *   挤出去也照样命中；
 * - `terminal read --lines N` 取的是滚动缓冲的尾部：远超一屏的输出仍能读到最新的几百行，且不落任何日志文件。
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
const COFLUXD = fileURLToPath(new URL("../../packages/cli/coflux.mjs", import.meta.url));
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

let cliSeq = 0;

/** 在发起方会话里跑一条 coflux 命令并等它的输出满足条件；每次换新文件，可安全重复调用。 */
async function runCli(device, sessionId, gatewayPort, home, args, predicate, label, timeout = 30000) {
  const out = join(home, `cli-${cliSeq += 1}.txt`);
  await device.input(sessionId, cliCmd(gatewayPort, args, out));
  return await waitForFile(out, predicate, label, timeout);
}

/** 轮询 `terminal read` 直到画面满足条件（刚开出来的头几百毫秒快照可能还是空的）。 */
async function readScreenUntil(device, sessionId, gatewayPort, home, taskId, predicate, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await runCli(device, sessionId, gatewayPort, home, `terminal read ${taskId}`, (s) => s.includes("#"), `${label} 的单次 read`, 8000);
      if (predicate(last)) return last;
    } catch {
      // 这一轮没写出来（PTY 还在忙上一条）：下一轮再试
    }
    await sleep(500);
  }
  throw new Error(`${label} 超时；最后画面: ${JSON.stringify(last)}`);
}

/** 在发起方会话里开一个 agent 终端并把命令打进去（do-script），等它 RUNNING，返回中心侧 task。 */
async function newAgentTerminal(c, device, task, ws, gatewayPort, home, title, cmd) {
  const outFile = join(home, `new-${title}.txt`);
  await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "${title}" --cmd "${cmd}"`, outFile));
  const created = await c.waitFor(
    (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === title && m.task.status === TaskStatus.RUNNING,
    `${title} 跑起来`,
    30000,
  );
  const text = await waitForFile(outFile, (s) => s.includes("已打入命令") || s.includes("✗"), `${title} 的 terminal new 输出`);
  assert.match(text, /已打入命令/, `${title}：命令必须在提示符就绪后打入: ${text}`);
  return created.task;
}

before(async () => {
  stack = await startStack({ port: PORT });
});
after(async () => {
  await stack?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("terminal wait：阻塞到命令结束并打印它的退出码；已结束的再 wait 立即命中；超时明确报错不误报", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    const target = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "慢命令", "sleep 2; (exit 5)");

    // wait 在命令还在跑时发起，必须真的阻塞到它结束，然后把命令的退出码打出来；终端本身还在跑
    const waitText = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${target.id} --timeout 60`, (s) => s.includes("#") || s.includes("✗"), "terminal wait 输出", 60000);
    assert.match(waitText, /# finished exit=5/, `wait 要打印命令的退出码: ${waitText}`);
    assert.ok(!waitText.includes("# exited"), "命令结束不是终端退出");

    // 已结束的命令再 wait 立即返回——退出码留在 daemon 本地账本里，不经中心
    const t0 = Date.now();
    const againText = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${target.id} --timeout 5`, (s) => s.includes("#") || s.includes("✗"), "已结束命令的 wait 输出");
    assert.match(againText, /# finished exit=5/, `已结束的 wait 要立即给退出码: ${againText}`);
    assert.ok(Date.now() - t0 < 5000, "已结束的命令不该等到超时");

    // plan 094：wait/read 按 taskId 直接寻址，不受 `terminal list` 只回最近 50 条的窗口影响。
    // 用 50 个 IDLE 任务把目标挤出窗口：list 看不到它，wait/read 照样命中。
    for (let i = 0; i < 50; i += 1) c.send({ case: "taskCreate", workspaceId: ws.id, title: `filler-${i}` });
    for (let i = 0; i < 50; i += 1) {
      await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === `filler-${i}`, `filler-${i} 建好`, 30000);
    }
    const listText = await runCli(device, task.sessionId, gatewayPort, home, "terminal list", (s) => s.includes("filler-49"), "挤满后的 list 输出");
    assert.ok(!listText.includes(target.id), "目标应已被挤出 list 的 50 条窗口（否则本用例没在测东西）");
    const pushedText = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${target.id} --timeout 5`, (s) => s.trim().length > 0, "窗口外目标的 wait 输出");
    assert.match(pushedText, /# finished exit=5/, `窗口外的目标 wait 必须仍命中: ${pushedText}`);
    const readPushedText = await runCli(device, task.sessionId, gatewayPort, home, `terminal read ${target.id}`, (s) => s.trim().length > 0, "窗口外目标的 read 输出");
    assert.match(readPushedText, /^# running/m, `窗口外的目标 read 必须仍命中: ${readPushedText}`);

    // 超时路径：长命令 + 1 秒超时 → 可读报错，绝不能输出 finished
    const runner = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "长跑", "sleep 60");
    const timeoutText = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${runner.id} --timeout 1`, (s) => s.includes("超时") || s.includes("#"), "terminal wait 超时输出");
    assert.match(timeoutText, /等待超时/, `超时要可读: ${timeoutText}`);
    assert.ok(!timeoutText.includes("# finished") && !timeoutText.includes("# exited"), "超时不能误报成结束");
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("terminal send：无人接管时写得进（命令真收到输入，退出码不受影响）；用户 attach 期间被拒且错误可读", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // 目标命令用 read 等一行输入：send 进去后它回显——「写入真实生效」的闭环证据。
    // ⚠ $line 必须写成 \$line：--cmd "…" 是打进**发起方 shell** 的，双引号内不转义的话
    // $line 会被发起方先展开成空串。先打 READY、等它出现再 send，同时演练 SKILL.md 的「先 read 再 send」纪律。
    const target = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "等输入", "echo READY; read line; echo GOT:\\$line; (exit 6)");
    await readScreenUntil(device, task.sessionId, gatewayPort, home, target.id, (s) => s.includes("READY"), "READY 探测");

    const sendText = await runCli(device, task.sessionId, gatewayPort, home, `terminal send ${target.id} --text "ping" --enter`, (s) => s.trim().length > 0, "terminal send 输出");
    assert.match(sendText, /已写入终端/, `send 命令失败: ${sendText}`);

    // 打字进去的命令照样有自己的退出码：wait 拿到 (exit 6)
    const waitText = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${target.id} --timeout 30`, (s) => s.includes("#") || s.includes("✗"), "收到输入后命令结束", 40000);
    assert.match(waitText, /# finished exit=6/, waitText);
    const readText = await readScreenUntil(device, task.sessionId, gatewayPort, home, target.id, (s) => s.includes("GOT:"), "send 后 read 输出");
    assert.match(readText, /GOT:ping/, `命令必须真收到输入: ${readText}`);

    // 人类优先：用户 attach 目标终端期间，send / run 必须被拒且错误可读；wait / read 不受接管影响
    const held = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "被接管", "sleep 60");
    await device.attach(held.sessionId);
    const rejectText = await runCli(device, task.sessionId, gatewayPort, home, `terminal send ${held.id} --text "x" --enter`, (s) => s.trim().length > 0, "被拒输出");
    assert.match(rejectText, /用户正在接管/, `接管期间 send 必须被拒: ${rejectText}`);
    const rejectRun = await runCli(device, task.sessionId, gatewayPort, home, `terminal run ${held.id} --cmd "echo x"`, (s) => s.trim().length > 0, "被拒的 run");
    assert.match(rejectRun, /✗/, `接管期间 run 必须被拒: ${rejectRun}`);
    const heldRead = await runCli(device, task.sessionId, gatewayPort, home, `terminal read ${held.id}`, (s) => s.includes("#"), "接管期间的 read");
    assert.match(heldRead, /^# running/m, "read 永远不因接管被拒");
    const heldWait = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${held.id} --timeout 1`, (s) => s.trim().length > 0, "接管期间的 wait");
    assert.match(heldWait, /等待超时/, `wait 不因接管被拒，只会超时: ${heldWait}`);

    // 目标不在本工作区：随便编个 id，错误要可读
    const missText = await runCli(device, task.sessionId, gatewayPort, home, `terminal send no-such-task --text "x" --enter`, (s) => s.trim().length > 0, "不存在目标输出");
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

test("read --lines 取滚动缓冲的尾部：远超一屏的输出仍能读到最新几百行，退出码正确，不落任何日志文件", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // 4000 行远超 24 行的一屏，也远超 read 默认的 200 行：尾部必须是最新的行，且中间那段（如 3900）也在滚动缓冲里
    const target = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "大输出", "seq 1 4000; echo LAST-LINE-MARK; (exit 4)");
    const waitText = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${target.id} --timeout 60`, (s) => s.includes("#") || s.includes("✗"), "大输出跑完", 60000);
    assert.match(waitText, /# finished exit=4/, `退出码必须原样透传: ${waitText}`);

    const readText = await runCli(device, task.sessionId, gatewayPort, home, `terminal read ${target.id} --lines 300`, (s) => s.includes("LAST-LINE-MARK"), "大输出 read");
    assert.match(readText, /^# running/m, `read 要带状态: ${readText}`);
    assert.match(readText, /\n3999\n4000\nLAST-LINE-MARK/, `尾部必须是最新的几行: ${JSON.stringify(readText.slice(-80))}`);
    assert.ok(readText.includes("\n3750\n"), `--lines 300 要取到一屏之外的历史: ${JSON.stringify(readText.slice(0, 120))}`);
    const lines = readText.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length >= 290, `--lines 300 必须远超一屏: 只有 ${lines.length} 行`);
    const shortText = await runCli(device, task.sessionId, gatewayPort, home, `terminal read ${target.id} --lines 3`, (s) => s.includes("LAST-LINE-MARK"), "大输出 read --lines 3");
    assert.ok(shortText.split("\n").filter((line) => line.length > 0).length <= 4, `--lines 3 只取最后 3 行: ${JSON.stringify(shortText)}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});
