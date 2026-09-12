/**
 * plan 074：agent 协同控制——跑在 coflux PTY 里的 agent 把工作外化成用户看得见、能接管的实体。
 *
 * 验收核心（终端只有一种：常驻的登录 shell，命令是 do-script）：
 * - `coflux terminal new --cmd` 在中心真建出 task（标题就是 agent 给的），命令在 shell 发出提示符就绪标记
 *   之后才打进真 tty 的 shell 里跑；`wait` 拿到的是**这条命令**的退出码，终端仍在跑；`close` 才结束它；
 * - `terminal read` 是去 ANSI 的纯文本，取的是滚动缓冲的尾部（`--lines` 超过一屏也读得到）；
 * - `run` 在命令还在跑时被拒（busy）；已结束的命令再 wait 立即拿到退出码；用户/agent 往跑着的命令里
 *   打字不影响退出码；远端/嵌套 shell 的裸 OSC 133 标记不会提前结束 wait；
 * - `notify` 让 presence 转 question 并带上留言，经中心广播到所有 client；
 * - 安全边界：coflux 会话之外的 pid 一律拒（身份就是「你在谁的进程树里」）；
 * - 每工作区活跃终端硬上限，超限拒绝且错误可读；
 * - plan 094：`/agent` 的拒绝原因回给调用方（超长命令、缺参数都有具体文案，不再是 `bad request`），
 *   run 命令行 / send 文本都是 64 KB 上限；旧 CLI 往 `terminal.new` 塞 command 会被明确拒绝而不是静默开出一个
 *   不跑命令的 shell；
 * - 不带 `--cmd` 只开 shell：不自己退出，read 读快照，送 `exit` 才 exited；空命令不是参数错误。
 * - plan 102：本地命令跟随**调用方 cwd** 所在的工作区（agent 可以 `/cd` 进同设备的另一个工作区），
 *   `coflux workspace` 报出有效/归属工作区；cwd 在所有工作区之外时落回归属工作区。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { mkRepo, startStack, CLI_BIN } from "./harness.mjs";
import { openNativeDevice } from "./device-harness.mjs";

const PORT = 8857;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/coflux.mjs", import.meta.url));
/** 两种 coflux 的启动方式：node 版（既有用例的默认）与 Rust 版二进制（plan 112，crates/cli）。 */
const NODE_LAUNCHER = `node ${COFLUXD}`;
const RUST_LAUNCHER = CLI_BIN;
// 上限压到 2：验证「超限被拒」不必真开 8 个终端
const MAX_TERMINALS = 2;
let stack;
const dirs = [];

function mkDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-agentctl-")));
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

/** terminalCreate 自 plan 048 起按设备幂等复用目录工作区：任一用例漏清理，后面的用例就会
 * 拿到复用路径（不广播 workspaceCreated）而级联超时。故清理一律走 finally，失败也要清。 */
async function removeWorkspace(c, workspaceId) {
  c.send({ case: "workspaceRemove", workspaceId });
  await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === workspaceId, "cleanup ws removed");
}

/** 在会话里跑一条 coflux 命令，输出重定向到文件——比解析 PTY 分块输出可靠得多。
 * launcher 缺省 = node 版；Rust 版用例传 RUST_LAUNCHER，其余一字不变。 */
function cliCmd(gatewayPort, args, outFile, launcher = NODE_LAUNCHER) {
  return `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} ${launcher} ${args} > ${outFile} 2>&1\r`;
}

/** 轮询等待文件出现且满足条件，返回内容。 */
async function waitForFile(path, predicate, label, timeout = 20000) {
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

/** 在会话里跑一条 coflux 命令并等它的输出满足条件；每次换新文件，可安全重复调用。 */
async function runCli(device, sessionId, gatewayPort, home, args, predicate, label, timeout = 20000, launcher = NODE_LAUNCHER) {
  const out = join(home, `cli-${cliSeq += 1}.txt`);
  await device.input(sessionId, cliCmd(gatewayPort, args, out, launcher));
  return await waitForFile(out, predicate, label, timeout);
}

/** Rust 版专用：跑一条命令并把退出码追加成最后一行 `exit=<code>`——非零退出路径（管理类拒绝 / 未知命令 /
 * hook 静默 0）要连退出码一起核对。文件写完的判据就是出现了 `exit=`。 */
async function runRustWithExit(device, sessionId, gatewayPort, home, args, label, stdin) {
  const out = join(home, `cli-rust-${cliSeq += 1}.txt`);
  const pipe = stdin ? `printf '%s' '${stdin}' | ` : "";
  await device.input(
    sessionId,
    `${pipe}COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} ${RUST_LAUNCHER} ${args} > ${out} 2>&1; echo "exit=$?" >> ${out}\r`,
  );
  const text = await waitForFile(out, (s) => /^exit=\d+\s*$/m.test(s), label);
  const exit = Number(/^exit=(\d+)\s*$/m.exec(text)[1]);
  return { text: text.replace(/^exit=\d+\s*$/m, "").trimEnd(), exit };
}

/** 轮询 `terminal read` 直到画面满足条件：会话终端只有快照，shell 起来、命令跑完都要等一会儿
 * （刚开出来的头几百毫秒快照可能还是空的），所以一次 read 读不到不代表失败。 */
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

before(async () => {
  stack = await startStack({ port: PORT, serverEnv: { COFLUX_MAX_AGENT_TERMINALS: String(MAX_TERMINALS) } });
});
after(async () => {
  await stack?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("terminal new --cmd：中心真建出任务，命令在提示符就绪后打进常驻 shell；wait 给命令的退出码而终端仍在跑；read 去 ANSI；close 才结束", async () => {
  const home = mkDir();
  const device = await openNativeDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // 命令写成脚本文件，免得三层 shell 引号互相转义：带 ANSI 颜色（验 read 去转义）、验 stdin/stdout 都是 tty
    // （do-script 就是打进真 tty 的 shell，不是管道）、非零退出码（验 wait 透传的是命令的退出码）。
    const job = join(home, "job.sh");
    writeFileSync(job, "printf '\\033[32mHELLO-FROM-AGENT\\033[0m\\n'\ntest -t 0 && test -t 1 && echo TTY-OK-AGENT\nexit 3\n");
    const newOut = join(home, "new.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "跑单测" --cmd "sh ${job}"`, newOut));

    const created = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "跑单测" && m.task.status === TaskStatus.RUNNING,
      "agent 建的任务出现在侧栏并跑起来",
      20000,
    );
    assert.notEqual(created.task.id, task.id, "必须是新任务，不是复用发起方那个");
    const newText = await waitForFile(newOut, (s) => s.includes("已打入命令") || s.includes("✗"), "terminal new 输出", 30000);
    assert.match(newText, /已开终端/, "CLI 必须写 stdout（与 hook 子命令的约定相反）");
    assert.match(newText, /已打入命令 #1/, `命令要在提示符就绪后打入: ${newText}`);

    // wait 等的是那条命令：退出码 3 来自 shell 集成标记，终端本身仍是 running
    const waitText = await runCli(device, task.sessionId, gatewayPort, home, `terminal wait ${created.task.id} --timeout 60`, (s) => s.includes("# finished") || s.includes("✗"), "terminal wait", 60000);
    assert.match(waitText, /# finished exit=3/, `wait 要给命令的退出码: ${waitText}`);

    // read：状态仍 running、去 ANSI 的纯文本、命令跑在真 tty 上
    const readText = await readScreenUntil(device, task.sessionId, gatewayPort, home, created.task.id, (s) => s.includes("TTY-OK-AGENT"), "terminal read");
    assert.ok(!readText.includes(String.fromCharCode(27)), `read 输出必须去 ANSI 转义: ${JSON.stringify(readText)}`);
    assert.match(readText, /^# running/m, "命令跑完了终端也不退出");
    assert.match(readText, /HELLO-FROM-AGENT/);

    // list：跑着的终端带命令状态（空闲 + 上一条命令的退出码）
    const listText = await runCli(device, task.sessionId, gatewayPort, home, "terminal list", (s) => s.includes(created.task.id), "terminal list 输出");
    assert.match(listText, new RegExp(`${created.task.id}\\s+running idle last=3\\s+跑单测`), `list 形状不符: ${listText}`);
    assert.ok(listText.includes(task.id), "同工作区的其它终端也要列出来");

    // close 才结束：等价于账号 CLI 的 stop
    const closeText = await runCli(device, task.sessionId, gatewayPort, home, `terminal close ${created.task.id}`, (s) => s.includes("终端") || s.includes("✗"), "terminal close");
    assert.match(closeText, /已关闭终端|已请求关闭终端/, closeText);
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === created.task.id && m.task.status === TaskStatus.EXITED,
      "close 后终端退出",
      30000,
    );
    const afterClose = await runCli(device, task.sessionId, gatewayPort, home, `terminal read ${created.task.id}`, (s) => s.includes("#"), "退出后的 read");
    assert.match(afterClose, /^# exited/m, `退出后 read 报 exited: ${afterClose}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("终端只有一种：不带 --cmd 只开常驻 shell；run 等提示符后打入、busy 时被拒；wait 命令级且不丢完成；打字不改退出码；裸标记不算数；read --lines 超过一屏", async () => {
  const home = mkDir();
  const device = await openNativeDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);
  const cli = (args, predicate, label, timeout) => runCli(device, task.sessionId, gatewayPort, home, args, predicate, label, timeout);

  try {
    const newOut = join(home, "shell-new.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "调试 shell"`, newOut));
    const created = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "调试 shell" && m.task.status === TaskStatus.RUNNING,
      "终端出现在侧栏并跑起来",
      20000,
    );
    const shellId = created.task.id;
    const newText = await waitForFile(newOut, (s) => s.includes("结束：") || s.includes("✗"), "terminal new 完整输出");
    assert.match(newText, /已开终端/);
    assert.match(newText, new RegExp(`跑命令：coflux terminal run ${shellId} --cmd=`), `不带 --cmd 时要提示 run: ${newText}`);

    // 还没跑过任何命令：wait 可读拒绝，不干等
    const nothing = await cli(`terminal wait ${shellId} --timeout 5`, (s) => s.trim().length > 0, "没命令时 wait");
    assert.match(nothing, /✗/, nothing);
    assert.match(nothing, /nothing to wait for|no command has run/, nothing);

    // run 不用先 read 等提示符：daemon 自己等提示符就绪标记再打入；输出超过一屏也读得到（滚动缓冲）
    const runText = await cli(`terminal run ${shellId} --cmd "seq 1 300; echo SEQ-DONE"`, (s) => s.includes("已打入命令") || s.includes("✗"), "terminal run", 30000);
    assert.match(runText, /已打入命令 #1/, runText);
    const waitText = await cli(`terminal wait ${shellId} --timeout 60`, (s) => s.includes("# finished") || s.includes("✗"), "wait seq", 60000);
    assert.match(waitText, /# finished exit=0/, waitText);
    const readText = await cli(`terminal read ${shellId} --lines 250`, (s) => s.includes("SEQ-DONE"), "read --lines 250");
    const lines = readText.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length >= 240, `--lines 250 必须超过一屏（24 行）: 只有 ${lines.length} 行`);
    assert.ok(readText.includes("\n100\n") && readText.includes("\n299\n300\nSEQ-DONE"), `尾部是滚动缓冲里的最新行: ${JSON.stringify(readText.slice(-60))}`);

    // busy：命令还在跑时再 run 被拒（可读），已结束再 wait 立即拿到退出码（不丢完成）
    const slow = await cli(`terminal run ${shellId} --cmd "sleep 3; (exit 2)"`, (s) => s.includes("已打入命令") || s.includes("✗"), "run sleep");
    assert.match(slow, /已打入命令 #2/, slow);
    const busy = await cli(`terminal run ${shellId} --cmd "echo nope"`, (s) => s.trim().length > 0, "busy run");
    assert.match(busy, /✗/, busy);
    assert.match(busy, /busy/, `命令还在跑时 run 要可读拒绝: ${busy}`);
    await cli(`terminal wait ${shellId} --timeout 60`, (s) => s.includes("# finished exit=2") || s.includes("✗"), "wait sleep", 60000);
    await sleep(1500);
    const t0 = Date.now();
    const again = await cli(`terminal wait ${shellId} --timeout 30`, (s) => s.includes("#") || s.includes("✗"), "wait again");
    assert.match(again, /# finished exit=2/, `已结束的命令再 wait 要立即给留档的退出码: ${again}`);
    assert.ok(Date.now() - t0 < 10000, "已结束的命令不该等");

    // 退出码在有人往命令里打字时也不丢：read 等输入，send 一行，wait 拿到 (exit 5)
    const reading = await cli(`terminal run ${shellId} --cmd "read line; echo GOT:\\$line; (exit 5)"`, (s) => s.includes("已打入命令") || s.includes("✗"), "run read");
    assert.match(reading, /已打入命令 #3/, reading);
    await sleep(500);
    const sendText = await cli(`terminal send ${shellId} --text "typed-in" --enter`, (s) => s.trim().length > 0, "send into running command");
    assert.match(sendText, /已写入终端/, sendText);
    const typed = await cli(`terminal wait ${shellId} --timeout 30`, (s) => s.includes("#") || s.includes("✗"), "wait read", 40000);
    assert.match(typed, /# finished exit=5/, `打字进去的命令也要给它自己的退出码: ${typed}`);
    const gotText = await readScreenUntil(device, task.sessionId, gatewayPort, home, shellId, (s) => /^GOT:typed-in$/m.test(s), "输入真的到了命令");
    assert.match(gotText, /^GOT:typed-in$/m);

    // 远端 / 嵌套 shell 的裸 OSC 133 标记不带本会话的秘密：wait 不会被它提前结束
    const foreign = await cli(`terminal run ${shellId} --cmd "printf '\\\\033]133;D;0\\\\007'; printf '\\\\033]133;A\\\\007'; sleep 3; (exit 4)"`, (s) => s.includes("已打入命令") || s.includes("✗"), "run foreign marks");
    assert.match(foreign, /已打入命令 #4/, foreign);
    const early = await cli(`terminal wait ${shellId} --timeout 1`, (s) => s.includes("#") || s.includes("✗"), "wait with foreign marks");
    assert.match(early, /等待超时/, `裸标记不能提前结束 wait: ${early}`);
    assert.ok(!early.includes("# finished"), early);
    const real = await cli(`terminal wait ${shellId} --timeout 30`, (s) => s.includes("#") || s.includes("✗"), "wait real end", 40000);
    assert.match(real, /# finished exit=4/, real);

    const listText = await cli("terminal list", (s) => s.includes(shellId), "terminal list 输出");
    assert.match(listText, new RegExp(`${shellId}\\s+running idle last=4\\s+调试 shell`), `list 要带命令状态: ${listText}`);

    // 送 exit 才结束，退出码是 shell 的；shell 退出后 wait 走通用退出路径
    await cli(`terminal send ${shellId} --text "exit 0" --enter`, (s) => s.trim().length > 0, "send exit");
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === shellId && m.task.status === TaskStatus.EXITED,
      "送 exit 后终端才退出",
      30000,
    );
    const exited = await cli(`terminal wait ${shellId} --timeout 60`, (s) => s.includes("# exited") || s.includes("✗"), "wait 到终端退出", 60000);
    assert.match(exited, /# exited exit=0/, `shell 退出后 wait 报 shell 自己的退出码: ${exited}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("notify：presence 转 question 并携带留言，经中心广播", async () => {
  const home = mkDir();
  const device = await openNativeDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // presence 的存活门是「进程树里有 agent」：CLI 自己不是 agent，故先挂一个假 claude
    const script = join(home, "claude");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(script, "#!/bin/sh\nsleep 300\n");
    chmodSync(script, 0o755);
    await device.input(task.sessionId, "./claude &\r");
    await c.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === task.sessionId),
      "presence 就位",
      20000,
    );

    const notifyOut = join(home, "notify.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `notify "两个方案拿不准，需要你定"`, notifyOut));
    // 先断言 CLI 自己成功了——否则下面等 presence 会白等 20 秒再报一个没信息量的超时
    const notifyText = await waitForFile(notifyOut, (s) => s.trim().length > 0, "notify CLI 输出");
    assert.match(notifyText, /已通知用户/, `notify 命令失败: ${notifyText}`);

    const notified = await c.waitFor(
      (m) =>
        m.case === "sessionAgentsUpdated" &&
        m.sessions.some((s) => s.sessionId === task.sessionId && s.state === "question" && s.message === "两个方案拿不准，需要你定"),
      "notify → question + 留言",
      20000,
    );
    assert.equal(notified.sessions.find((s) => s.sessionId === task.sessionId).agent, "claude", "留言不能把 agent 名弄丢");

    // 后续任一 hook 事件到达即清掉留言（agent 已换状态，旧留言过期）
    await device.input(
      task.sessionId,
      `printf '%s' '{"hook_event_name":"PreToolUse"}' | COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} hook claude\r`,
    );
    await c.waitFor(
      (m) =>
        m.case === "sessionAgentsUpdated" &&
        m.sessions.some((s) => s.sessionId === task.sessionId && s.state === "active" && s.message === ""),
      "hook 事件清掉过期留言",
      20000,
    );

  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("安全边界：coflux 会话之外的 pid 一律拒；非 json 被拒；超上限拒绝且错误可读", async () => {
  const home = mkDir();
  const device = await openNativeDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // 树外 pid（测试进程自身）= coflux 之外启动的程序，必须进不来
    const outside = await fetch(`http://127.0.0.1:${gatewayPort}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "terminal.list", pid: process.pid, ppid: process.ppid }),
    });
    assert.equal(outside.status, 403, "树外 pid 必须被拒");
    assert.match((await outside.json()).error, /不在 coflux 终端里/);

    // content-type 门禁（挡浏览器"简单请求"对 localhost 的盲打）
    const plain = await fetch(`http://127.0.0.1:${gatewayPort}/agent`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ action: "terminal.list", pid: process.pid }),
    });
    assert.equal(plain.status, 400, "非 application/json 必须被拒");

    // plan 094：/agent 的拒绝原因回给调用方。这些校验在 pid 门之前，树外也能验；`/hook` 的形态不变。
    const post = (body) =>
      fetch(`http://127.0.0.1:${gatewayPort}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, pid: process.pid, ppid: process.ppid }),
      });
    // 旧 CLI 往 terminal.new 塞 command：明确拒绝（不能静默开出一个不跑命令的 shell）
    const legacyCommand = await post({ action: "terminal.new", command: "echo hi" });
    assert.equal(legacyCommand.status, 400);
    assert.match((await legacyCommand.json()).error, /no longer takes a command/, "带 command 的 terminal.new 要指名道姓地拒绝");
    // 空命令是合法输入（只开 shell），不被参数校验拦下——它只会撞上 pid 门
    const emptyCommand = await post({ action: "terminal.new", command: "" });
    assert.equal(emptyCommand.status, 403, "空命令不是 400：只开 shell，只该被 pid 门拦下");
    assert.match((await emptyCommand.json()).error, /不在 coflux 终端里/);
    const blankCommand = await post({ action: "terminal.new", command: "   " });
    assert.equal(blankCommand.status, 403, "空白命令与缺省等价，同样不是参数错误");
    // run 的命令行与 send 文本同一个 64 KB 上限；缺参数指名道姓
    const tooLong = await post({ action: "terminal.run", taskId: "t", command: "x".repeat(64 * 1024 + 1) });
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /command 超过 65536 字节上限/, "超长命令要给具体原因，不是 bad request");
    const noCommand = await post({ action: "terminal.run", taskId: "t" });
    assert.equal(noCommand.status, 400);
    assert.match((await noCommand.json()).error, /terminal\.run 缺 command/);
    const noWaitTask = await post({ action: "terminal.wait" });
    assert.equal(noWaitTask.status, 400);
    assert.match((await noWaitTask.json()).error, /terminal\.wait 缺 taskId/);
    const noCloseTask = await post({ action: "terminal.close" });
    assert.equal(noCloseTask.status, 400);
    assert.match((await noCloseTask.json()).error, /terminal\.close 缺 taskId/);
    const noTask = await post({ action: "terminal.status" });
    assert.equal(noTask.status, 400);
    assert.match((await noTask.json()).error, /terminal\.status 缺 taskId/, "缺参数要指名道姓");
    const longText = await post({ action: "terminal.send", taskId: "t", text: "y".repeat(64 * 1024 + 1) });
    assert.equal(longText.status, 400);
    assert.match((await longText.json()).error, /text 超过 65536 字节上限/, "send 文本上限与 MCP 的 64 KB 对齐");
    const unknown = await post({ action: "terminal.frobnicate" });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /未知 action/);

    // 上限：发起方那个终端已占 1 个，再开 1 个到顶，第 3 个必须被拒
    const firstOut = join(home, "first.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "占位"`, firstOut));
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "占位" && m.task.status === TaskStatus.RUNNING,
      "占位终端跑起来",
      20000,
    );

    const overOut = join(home, "over.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "超限"`, overOut));
    const overText = await waitForFile(overOut, (s) => s.includes("上限"), "超限错误");
    assert.match(overText, new RegExp(`活跃终端已达上限 ${MAX_TERMINALS}`), `超限错误要可读: ${overText}`);

  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

/**
 * plan 102：agent 用 `/cd` 或 EnterWorktree 把活着的会话挪进同设备的另一个工作区后，本地命令跟随
 * 调用方 cwd，而不是继续按会话账本里的归属工作区办事（那是沉默错位：以为在测 B，其实测的是 A）。
 *
 * PTY 自己的 cwd 保持在 A，每条命令用子 shell `(cd <B> && …)` 改 cwd——这正是 agent 挪窝后的形态：
 * 会话没重开、归属没变，变的只是调用方的工作目录。
 *
 * A 是目录工作区（terminalCreate），B 只能是**仓库工作区**：terminalCreate 按设备幂等，每台设备至多
 * 一个目录工作区（hub.ts 的 dir 工作区复用），第二次 terminalCreate 会静默复用 A 而不是建 B。导一个
 * 真 git 仓库进来，它的主工作区就是同设备上的另一个工作区，且照样进 daemon 的工作区清单。
 */
test("跟随 cwd：在 B 的目录里开的终端属 B、跑在 B；list 只见 B；跨工作区 read/send/wait 404；工作区之外落回 A", async () => {
  const homeA = mkDir();
  const outside = mkDir(); // 不注册成工作区：cwd 落在任何工作区之外
  const repoB = mkRepo();
  let homeB; // B 工作区在中心登记的路径（= repoB.dir；mkRepo 不做 realpath，正好验证两边规范化）
  const device = await openNativeDevice(stack);
  const c = device.control;
  const { ws: wsA, task } = await startDirTerminal(c, homeA);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  let cdSeq = 0;
  /** 换个目录跑一条 coflux 命令；子 shell 保证 PTY 自己的 cwd 仍在 A。 */
  const runIn = async (dir, args, predicate, label, timeout = 20000) => {
    const out = join(homeA, `cli-cd-${cdSeq += 1}.txt`);
    await device.input(
      task.sessionId,
      `(cd ${dir} && COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} ${args}) > ${out} 2>&1\r`,
    );
    return await waitForFile(out, predicate, label, timeout);
  };
  /** `coflux workspace` 的契约就是「一行 JSON」——解析不出来本身就是失败，且要把原文带出来。 */
  const whereAmI = async (dir, label) => {
    const raw = (await runIn(dir, "workspace", (s) => s.includes("workspaceId") || s.includes("✗"), label)).trim();
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${label} 没拿到一行 JSON: ${raw}`);
    }
  };

  let wsB;
  try {
    // B 经中心建：导入一个真仓库，它的主工作区就是同设备上的第二个工作区（目录工作区一台设备只有一个）。
    // waitWorkspaceReady 等它进 daemon 的工作区表——cwd 解析就是查那张表。
    c.send({ case: "projectImport", daemonId: stack.daemonId, path: repoB.dir });
    const createdB = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "B 主工作区建好", 30000);
    wsB = createdB.workspace;
    homeB = wsB.path;
    await device.waitWorkspaceReady(wsB.id, 20000);

    // 1) coflux workspace 三种 cwd 下都要说对话
    const inA = await whereAmI(homeA, "A 的 cwd 下 workspace");
    assert.deepEqual(
      { workspaceId: inA.workspaceId, owningWorkspaceId: inA.owningWorkspaceId, moved: inA.moved },
      { workspaceId: wsA.id, owningWorkspaceId: wsA.id, moved: false },
      `没挪窝时有效工作区就是归属工作区: ${JSON.stringify(inA)}`,
    );
    assert.equal(inA.path, homeA);

    const inB = await whereAmI(homeB, "B 的 cwd 下 workspace");
    assert.deepEqual(
      { workspaceId: inB.workspaceId, path: inB.path, owningWorkspaceId: inB.owningWorkspaceId, moved: inB.moved },
      { workspaceId: wsB.id, path: homeB, owningWorkspaceId: wsA.id, moved: true },
      `挪进 B 之后有效工作区必须是 B、归属仍是 A: ${JSON.stringify(inB)}`,
    );

    const inNowhere = await whereAmI(outside, "工作区之外的 cwd 下 workspace");
    assert.deepEqual(
      { workspaceId: inNowhere.workspaceId, moved: inNowhere.moved },
      { workspaceId: wsA.id, moved: false },
      `cwd 不在任何工作区内要落回归属工作区: ${JSON.stringify(inNowhere)}`,
    );

    // 2) 在 B 的目录里开终端并打入 pwd：task 挂在 B 名下，命令真的在 B 的根目录里跑
    const newText = await runIn(homeB, `terminal new --title "在 B 跑 pwd" --cmd "pwd"`, (s) => s.includes("已打入命令") || s.includes("✗"), "在 B 开终端", 30000);
    assert.match(newText, /已开终端/, `在 B 开终端失败: ${newText}`);
    assert.match(newText, /已打入命令/, `pwd 要在提示符就绪后打入: ${newText}`);
    const inWsB = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.title === "在 B 跑 pwd",
      "B 名下出现 agent 建的终端",
      20000,
    );
    assert.equal(inWsB.task.workspaceId, wsB.id, "终端必须挂在 cwd 所在的工作区 B 名下，而不是发起方 A");
    const bWaitText = await runIn(homeB, `terminal wait ${inWsB.task.id} --timeout 30`, (s) => s.includes("#") || s.includes("✗"), "pwd 跑完", 40000);
    assert.match(bWaitText, /# finished exit=0/, bWaitText);
    const bReadText = await runIn(homeB, `terminal read ${inWsB.task.id}`, (s) => s.includes("# running"), "读 B 里那个终端");
    // macOS 的临时目录是 /var → /private/var 的符号链接：登记路径与 shell 里 pwd 打出来的物理路径
    // 可能是同一目录的两种写法，两种都算数（daemon 的匹配本来就两边规范化）。
    const bPhysical = realpathSync(homeB);
    assert.ok(
      bReadText.includes(homeB) || bReadText.includes(bPhysical),
      `命令必须在 B 的根目录里跑（登记路径 ${homeB} / 物理路径 ${bPhysical}）: ${bReadText}`,
    );
    // A 独有的标记（临时目录名前缀）不能出现——出现就说明命令落回了 A 的 checkout，正是本 plan 要根治的沉默错位
    const aMarker = homeA.slice(homeA.lastIndexOf("/") + 1);
    assert.ok(!bReadText.includes(aMarker), `绝不能落在 A 的 checkout 里（沉默错位）: ${bReadText}`);

    // 3) list 跟随 cwd：B 的目录里只见 B 的终端，A 的发起终端不在其中
    const listInB = await runIn(homeB, "terminal list", (s) => s.includes(inWsB.task.id), "B 的 cwd 下 list");
    assert.ok(!listInB.includes(task.id), `B 的 list 里不能有 A 的终端: ${listInB}`);
    const listInA = await runIn(homeA, "terminal list", (s) => s.includes(task.id), "A 的 cwd 下 list");
    assert.ok(!listInA.includes(inWsB.task.id), `A 的 list 里不能有 B 的终端: ${listInA}`);

    // 4) 跨工作区的 read/send/wait 一律 404，文案仍是「不在本工作区或不存在」（两个方向对称）
    for (const [dir, taskId, label] of [
      [homeB, task.id, "在 B 里读 A 的终端"],
      [homeA, inWsB.task.id, "在 A 里读 B 的终端"],
    ]) {
      const readText = await runIn(dir, `terminal read ${taskId}`, (s) => s.includes("✗"), label);
      assert.match(readText, /终端不在本工作区或不存在/, `${label} 必须 404: ${readText}`);
    }
    const sendText = await runIn(homeB, `terminal send ${task.id} --text "x" --enter`, (s) => s.includes("✗"), "在 B 里往 A 的终端输入");
    assert.match(sendText, /终端不在本工作区或不存在/, `跨工作区 send 必须 404: ${sendText}`);
    const waitText = await runIn(homeB, `terminal wait ${task.id} --timeout 5`, (s) => s.includes("✗"), "在 B 里 wait A 的终端");
    assert.match(waitText, /终端不在本工作区或不存在/, `跨工作区 wait 必须 404: ${waitText}`);

    // 5) cwd 在任何工作区之外 → 落回归属工作区 A（daemon 此时不申报 workspace_id，与旧 daemon 的
    //    请求逐字节等价，也就顺带证明了「不带字段仍落发起工作区」）
    const backText = await runIn(outside, `terminal new --title "落回 A"`, (s) => s.includes("已开终端") || s.includes("✗"), "工作区之外开终端");
    assert.match(backText, /已开终端/, `工作区之外开终端失败: ${backText}`);
    const backTask = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.title === "落回 A",
      "落回 A 的终端出现",
      20000,
    );
    assert.equal(backTask.task.workspaceId, wsA.id, "cwd 在工作区之外时必须落回归属工作区 A");

  } finally {
    // 主工作区不能单删（"主工作区不能删除（要删就删整个项目）"），走 projectRemove 整项目删。
    // 再套一层 finally：B 的清理失败也不能带走 A 的清理——目录工作区按设备幂等，漏清理会让后续用例
    // 拿到复用路径而级联超时。
    try {
      if (wsB) {
        c.send({ case: "projectRemove", projectId: wsB.projectId });
        await c.waitFor((m) => m.case === "projectRemoved" && m.projectId === wsB.projectId, "cleanup B 项目删掉", 30000);
      }
    } finally {
      await removeWorkspace(c, wsA.id);
      device.close();
      repoB.cleanup();
    }
  }
});

test("plan 112：Rust 版 coflux 对同一组子命令给出与 node 版相同的 stdout 短语与退出码；管理类子命令被明确拒绝（exit 1）、未知命令沿用用法提示（exit 1）、hook 永远静默 0", async () => {
  const home = mkDir();
  const device = await openNativeDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);
  const rust = (args, predicate, label, timeout) => runCli(device, task.sessionId, gatewayPort, home, args, predicate, label, timeout, RUST_LAUNCHER);

  try {
    // terminal new --cmd（do-script）：短语逐字对齐 node 版；命令在提示符就绪后打入。
    // 输出文件是边写边读的：等 `已打入命令` 出现（或 `✗`）再整段比对，只等首行会读到半截。
    const newText = await rust(`terminal new --title "rust 作业" --cmd "sh -c 'echo HELLO-FROM-RUST; exit 3'"`, (s) => s.includes("已打入命令") || s.includes("✗"), "Rust terminal new", 30000);
    const created = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "rust 作业", "Rust 版建的任务出现在侧栏", 20000);
    assert.equal(
      newText.trim(),
      `已开终端 ${created.task.id}（用户可在 coflux 侧栏看到并随时接管）\n已打入命令 #1（coflux terminal wait ${created.task.id} 等它结束，coflux terminal read ${created.task.id} 看输出）`,
      "terminal new 的两行输出与 node 版逐字一致",
    );

    // terminal wait：阻塞到命令结束并打印它的退出码（终端仍在跑）
    const waitText = await rust(`terminal wait ${created.task.id} --timeout 30`, (s) => s.includes("finished") || s.includes("✗"), "Rust terminal wait", 40000);
    assert.equal(waitText.trim(), "# finished exit=3");

    // terminal read：状态行 + 纯文本（滚动缓冲）
    await readScreenUntil(device, task.sessionId, gatewayPort, home, created.task.id, (s) => s.includes("HELLO-FROM-RUST"), "等 Rust 作业的输出上屏");
    const readText = await rust(`terminal read ${created.task.id}`, (s) => s.includes("HELLO-FROM-RUST"), "Rust terminal read");
    assert.ok(readText.startsWith("# running\n"), `read 首行: ${JSON.stringify(readText)}`);

    // terminal list：`<taskId>  <status> <busy|idle> last=<code>  <title>`
    const listText = await rust("terminal list", (s) => s.includes(created.task.id), "Rust terminal list");
    assert.ok(listText.split("\n").includes(`${created.task.id}  running idle last=3  rust 作业`), `list 形状不符: ${listText}`);

    // terminal close：结束它（本工作区上限 2，得先腾出名额）
    const closeText = await rust(`terminal close ${created.task.id}`, (s) => s.includes("终端") || s.includes("✗"), "Rust terminal close");
    assert.match(closeText, /^已关闭终端 |^已请求关闭终端 /, closeText);
    await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === created.task.id && m.task.status === TaskStatus.EXITED, "close 后退出", 30000);

    // 不带 --cmd 只开 shell：提示三行；send 的回执短语；送 exit 真的退出
    // 提示的最后一行以 `结束：` 开头：等它出现（或 `✗`）再比对
    const shellText = await rust(`terminal new --title "rust shell"`, (s) => s.includes("结束：") || s.includes("✗"), "Rust 终端");
    const shell = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "rust shell" && m.task.status === TaskStatus.RUNNING, "终端跑起来", 20000);
    assert.ok(shellText.includes("常驻的登录 shell（全 tty），不会自己退出"), `终端提示: ${shellText}`);
    assert.ok(shellText.includes(`跑命令：coflux terminal run ${shell.task.id} --cmd="<命令>"`), `run 提示: ${shellText}`);
    assert.ok(shellText.includes(`看输出：coflux terminal read ${shell.task.id}；结束：coflux terminal close ${shell.task.id}`), `close 提示: ${shellText}`);
    // 先等提示符（快照非空）再 send——与既有会话终端用例同一纪律；这里等待本身用 node 版，不是被测对象
    await readScreenUntil(device, task.sessionId, gatewayPort, home, shell.task.id, (s) => s.includes("# running") && !s.includes("（暂无输出）"), "等 Rust 会话终端的提示符");
    const sendText = await rust(`terminal send ${shell.task.id} --text "exit" --enter`, (s) => s.includes("已写入") || s.includes("✗"), "Rust terminal send");
    assert.equal(sendText.trim(), `已写入终端 ${shell.task.id}（用 coflux terminal read ${shell.task.id} 核对效果）`);
    await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === shell.task.id && m.task.status === TaskStatus.EXITED, "会话终端收到 exit 后退出", 30000);

    // workspace：一行 JSON，字段与 node 版同名同序
    const wsText = await rust("workspace", (s) => s.includes("workspaceId") || s.includes("✗"), "Rust workspace");
    assert.deepEqual(JSON.parse(wsText.trim()), { workspaceId: ws.id, path: home, owningWorkspaceId: ws.id, moved: false });

    // presence 的存活门是「进程树里有 agent」：CLI 自己不是 agent，notify 的 question 态与 hook 的
    // active 态都只为有 agent 进程的会话广播——与既有 notify 用例同一做法，先挂一个假 claude 并等 presence 就位
    const fakeClaude = join(home, "claude");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(fakeClaude, "#!/bin/sh\nsleep 300\n");
    chmodSync(fakeClaude, 0o755);
    await device.input(task.sessionId, "./claude &\r");
    await c.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === task.sessionId),
      "presence 就位",
      20000,
    );

    // progress / notify：回执短语 + 真的经中心广播出去
    const progressText = await rust(`progress "rust 进度"`, (s) => s.includes("已更新进度") || s.includes("✗"), "Rust progress");
    assert.equal(progressText.trim(), "已更新进度（显示在工作区卡片上，被下一条覆盖）");
    const notifyText = await rust(`notify "rust 叫人"`, (s) => s.includes("已通知") || s.includes("✗"), "Rust notify");
    assert.equal(notifyText.trim(), "已通知用户（工作区在侧栏转为「等待交互」）");
    await c.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === task.sessionId && s.state === "question" && s.message === "rust 叫人"),
      "notify → question + 留言",
      20000,
    );

    // ports：空态短语或 `<port>  <url>` 行
    const portsText = await rust("ports", (s) => s.trim().length > 0, "Rust ports");
    assert.ok(portsText.trim() === "本工作区暂无监听端口" || /^\d+  /m.test(portsText), `ports 输出形状: ${portsText}`);

    // hook：stdin 事件 JSON 转发到 /hook，永远退出 0、不写 stdout；到达即清掉 notify 的留言
    const hook = await runRustWithExit(device, task.sessionId, gatewayPort, home, "hook claude", "Rust hook", '{"hook_event_name":"PreToolUse"}');
    assert.deepEqual(hook, { text: "", exit: 0 }, "hook 必须静默且退出 0");
    await c.waitFor(
      (m) => m.case === "sessionAgentsUpdated" && m.sessions.some((s) => s.sessionId === task.sessionId && s.state === "active" && s.message === ""),
      "hook 事件清掉过期留言",
      20000,
    );
    const hookNoDaemon = await runRustWithExit(device, task.sessionId, gatewayPort, home, "hook bogus-agent", "Rust hook 未知 agent");
    assert.deepEqual(hookNoDaemon, { text: "", exit: 0 }, "未知 agent 也静默 0，不干扰宿主");

    // 管理类子命令：明确拒绝并指向 Coflux.app（exit 1）；未知命令：用法提示（exit 1）
    for (const managed of ["status", "up", "update"]) {
      const refused = await runRustWithExit(device, task.sessionId, gatewayPort, home, managed, `Rust ${managed}`);
      assert.equal(refused.exit, 1, `${managed} 应以 1 退出: ${refused.text}`);
      assert.match(refused.text, /Coflux\.app/, `${managed} 的提示要指向 Coflux.app: ${refused.text}`);
    }
    const unknown = await runRustWithExit(device, task.sessionId, gatewayPort, home, "bogus", "Rust 未知命令");
    assert.equal(unknown.exit, 1);
    assert.match(unknown.text, /未知命令: bogus/);
    const help = await runRustWithExit(device, task.sessionId, gatewayPort, home, "--help", "Rust --help");
    assert.equal(help.exit, 0);
    assert.match(help.text, /coflux terminal new/);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});
