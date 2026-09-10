/**
 * plan 074：agent 协同控制——跑在 coflux PTY 里的 agent 把工作外化成用户看得见、能接管的实体。
 *
 * 验收核心：
 * - `cofluxd terminal new` 在中心真建出 task（标题就是 agent 给的），命令真在那个 PTY 里跑，
 *   跑完转 EXITED 并带上退出码——这是 agent 判断成败的唯一依据；
 * - `terminal read` 拿得到**已退出**终端的输出且是去 ANSI 的纯文本（最常用的场景就是「跑完了
 *   看输出」，而中心 checkpoint 是 2 秒周期缓存、秒级命令根本进不去，故 worker 侧走命令日志）；
 * - `notify` 让 presence 转 question 并带上留言，经中心广播到所有 client；
 * - 安全边界：coflux 会话之外的 pid 一律拒（身份就是「你在谁的进程树里」）；
 * - 每工作区活跃终端硬上限，超限拒绝且错误可读；
 * - plan 094：`/agent` 的拒绝原因回给调用方（超长命令、缺参数都有具体文案，不再是 `bad request`），
 *   命令 16 KB / send 文本 64 KB 与 MCP 对齐；
 * - plan 101：不带 `--cmd` 开出的是**会话终端**——常驻、全 tty 的登录 shell，不自己退出，
 *   read 读的是快照（没有命令日志），送 `exit` 才 exited；空命令不再是参数错误。
 * - plan 102：本地命令跟随**调用方 cwd** 所在的工作区（agent 可以 `/cd` 进同设备的另一个工作区），
 *   `cofluxd workspace` 报出有效/归属工作区；cwd 在所有工作区之外时落回归属工作区。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8857;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/cofluxd.mjs", import.meta.url));
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

/** 在会话里跑一条 cofluxd 命令，输出重定向到文件——比解析 PTY 分块输出可靠得多。 */
function cliCmd(gatewayPort, args, outFile) {
  return `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} ${args} > ${outFile} 2>&1\r`;
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

/** 在会话里跑一条 cofluxd 命令并等它的输出满足条件；每次换新文件，可安全重复调用。 */
async function runCli(device, sessionId, gatewayPort, home, args, predicate, label, timeout = 20000) {
  const out = join(home, `cli-${cliSeq += 1}.txt`);
  await device.input(sessionId, cliCmd(gatewayPort, args, out));
  return await waitForFile(out, predicate, label, timeout);
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

test("terminal new：中心真建出任务、命令真在 PTY 里跑、跑完带退出码；read 拿得到已退出终端的纯文本输出", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // agent 在自己的会话里开一个新终端跑命令。命令刻意带 ANSI 颜色 + 非零退出码：
    // 前者验证 read 的去转义，后者验证退出码透传（管道尾是 tee，靠 PIPESTATUS 取回）。
    const newOut = join(home, "new.txt");
    await device.input(
      task.sessionId,
      cliCmd(gatewayPort, `terminal new --title "跑单测" --cmd "printf '\\033[32mHELLO-FROM-AGENT\\033[0m\\n'; exit 3"`, newOut),
    );

    const created = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "跑单测",
      "agent 建的任务出现在侧栏",
      20000,
    );
    assert.notEqual(created.task.id, task.id, "必须是新任务，不是复用发起方那个");

    const exited = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === created.task.id && m.task.status === TaskStatus.EXITED,
      "命令跑完 → EXITED",
      20000,
    );
    assert.equal(exited.task.exitCode, 3, "退出码必须透传——agent 全靠它判断成败");

    const newText = await waitForFile(newOut, (s) => s.includes(created.task.id), "terminal new 输出");
    assert.match(newText, /已开终端/, "CLI 必须写 stdout（与 hook 子命令的约定相反）");

    // 读已退出的终端：这是最常用的场景，中心 checkpoint 的 2 秒周期覆盖不到秒级命令
    const readOut = join(home, "read.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal read ${created.task.id}`, readOut));
    const readText = await waitForFile(readOut, (s) => s.includes("HELLO-FROM-AGENT"), "terminal read 输出");
    assert.ok(!readText.includes(String.fromCharCode(27)), `read 输出必须去 ANSI 转义: ${JSON.stringify(readText)}`);
    assert.match(readText, /exited/, "read 要带上状态");
    assert.match(readText, /exit=3/, "read 要带上退出码");

    // list 看得到两个终端（发起方 + agent 建的），且 agent 建的带退出码
    const listOut = join(home, "list.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, "terminal list", listOut));
    const listText = await waitForFile(listOut, (s) => s.includes(created.task.id), "terminal list 输出");
    assert.match(listText, new RegExp(`${created.task.id}\\s+exited exit=3\\s+跑单测`), `list 形状不符: ${listText}`);
    assert.ok(listText.includes(task.id), "同工作区的其它终端也要列出来");

  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("会话终端（plan 101）：不带 --cmd 开出常驻的全 tty 登录 shell，read 读快照，送 exit 才退出", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    // 不带 --cmd：与用户在侧栏点「新建终端」等价，一个不会自己退出的登录 shell
    const newOut = join(home, "shell-new.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "调试 shell"`, newOut));

    const created = await c.waitFor(
      (m) =>
        m.case === "taskUpdated" &&
        m.task.workspaceId === ws.id &&
        m.task.title === "调试 shell" &&
        m.task.status === TaskStatus.RUNNING,
      "会话终端出现在侧栏并跑起来",
      20000,
    );
    const shellId = created.task.id;
    const newText = await waitForFile(newOut, (s) => s.includes(shellId), "terminal new 输出");
    assert.match(newText, /已开终端/, "输出与作业终端同形");
    assert.match(newText, /会话终端/, `不带 --cmd 时要提示这是会话终端: ${newText}`);

    // 先 read 等提示符：会话终端没有命令日志，read 拿到的是 sessiond 的当前画面
    await readScreenUntil(
      device,
      task.sessionId,
      gatewayPort,
      home,
      shellId,
      (s) => s.includes("# running") && !s.includes("（暂无输出）"),
      "等 shell 提示符出现",
    );

    // 全 tty 是这种终端存在的理由：作业终端的 stdout 是管道，`test -t 1` 不成立、这行不会有输出。
    // 标记里的引号让「命令回显」和「命令输出」区分得开（回显里是 TTY-"OK"-101）。
    await device.input(
      task.sessionId,
      cliCmd(gatewayPort, `terminal send ${shellId} --text 'test -t 0 && test -t 1 && echo TTY-"OK"-101' --enter`, join(home, "shell-send.txt")),
    );
    const screen = await readScreenUntil(
      device,
      task.sessionId,
      gatewayPort,
      home,
      shellId,
      (s) => s.includes("TTY-OK-101"),
      "会话终端里 stdin/stdout 都是 tty",
    );
    assert.match(screen, /# running/, "命令跑完了终端也不能退出——它是常驻的");

    const listText = await runCli(device, task.sessionId, gatewayPort, home, "terminal list", (s) => s.includes(shellId), "terminal list 输出");
    assert.match(listText, new RegExp(`${shellId}\\s+running\\s+调试 shell`), `会话终端在 list 里应是 running: ${listText}`);

    // 送 exit 才结束，退出码是 shell 的（上一条命令成功，故为 0）
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal send ${shellId} --text "exit" --enter`, join(home, "shell-exit.txt")));
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === shellId && m.task.status === TaskStatus.EXITED,
      "送 exit 后会话终端才退出",
      30000,
    );
    const waitText = await runCli(
      device,
      task.sessionId,
      gatewayPort,
      home,
      `terminal wait ${shellId} --timeout 60`,
      (s) => s.includes("# exited"),
      "wait 到会话终端退出",
      60000,
    );
    assert.match(waitText, /# exited exit=0/, `wait 要报 shell 自己的退出码: ${waitText}`);

  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("notify：presence 转 question 并携带留言，经中心广播", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
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
  const device = await openRelayDevice(stack);
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
    const tooLong = await post({ action: "terminal.new", command: "x".repeat(17 * 1024) });
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /命令超过 16384 字节上限/, "超长命令要给具体原因，不是 bad request");
    // plan 101：空命令是合法输入（会话终端），不再被参数校验拦下——它只会撞上 pid 门
    const emptyCommand = await post({ action: "terminal.new", command: "" });
    assert.equal(emptyCommand.status, 403, "空命令不再是 400：它是会话终端，只该被 pid 门拦下");
    assert.match((await emptyCommand.json()).error, /不在 coflux 终端里/);
    const blankCommand = await post({ action: "terminal.new", command: "   " });
    assert.equal(blankCommand.status, 403, "空白命令与缺省等价，同样不是参数错误");
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
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "占位" --cmd "sleep 60"`, firstOut));
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "占位" && m.task.status === TaskStatus.RUNNING,
      "占位终端跑起来",
      20000,
    );

    const overOut = join(home, "over.txt");
    await device.input(task.sessionId, cliCmd(gatewayPort, `terminal new --title "超限" --cmd "sleep 60"`, overOut));
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
 */
test("跟随 cwd：在 B 的目录里开的终端属 B、跑在 B；list 只见 B；跨工作区 read/send/wait 404；工作区之外落回 A", async () => {
  const homeA = mkDir();
  const homeB = mkDir();
  const outside = mkDir(); // 不注册成工作区：cwd 落在任何工作区之外
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws: wsA, task } = await startDirTerminal(c, homeA);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  let cdSeq = 0;
  /** 换个目录跑一条 cofluxd 命令；子 shell 保证 PTY 自己的 cwd 仍在 A。 */
  const runIn = async (dir, args, predicate, label, timeout = 20000) => {
    const out = join(homeA, `cli-cd-${cdSeq += 1}.txt`);
    await device.input(
      task.sessionId,
      `(cd ${dir} && COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} ${args}) > ${out} 2>&1\r`,
    );
    return await waitForFile(out, predicate, label, timeout);
  };
  /** `cofluxd workspace` 的契约就是「一行 JSON」——解析不出来本身就是失败，且要把原文带出来。 */
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
    // B 必须经中心建：daemon 的工作区表只认中心下发的清单，waitWorkspaceReady 等它同步到位
    c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: homeB });
    const createdB = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === homeB, "B 工作区建好");
    wsB = createdB.workspace;
    await device.waitWorkspaceReady(wsB.id, 20000);

    // 1) cofluxd workspace 三种 cwd 下都要说对话
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

    // 2) 在 B 的目录里开终端：task 挂在 B 名下，命令真的在 B 的根目录里跑
    const newText = await runIn(homeB, `terminal new --title "在 B 跑 pwd" --cmd "pwd"`, (s) => s.includes("已开终端") || s.includes("✗"), "在 B 开终端");
    assert.match(newText, /已开终端/, `在 B 开终端失败: ${newText}`);
    const inWsB = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.title === "在 B 跑 pwd",
      "B 名下出现 agent 建的终端",
      20000,
    );
    assert.equal(inWsB.task.workspaceId, wsB.id, "终端必须挂在 cwd 所在的工作区 B 名下，而不是发起方 A");
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === inWsB.task.id && m.task.status === TaskStatus.EXITED,
      "pwd 跑完",
      20000,
    );
    const bReadText = await runIn(homeB, `terminal read ${inWsB.task.id}`, (s) => s.includes("exited"), "读 B 里那个终端");
    assert.ok(bReadText.includes(homeB), `命令必须在 B 的根目录里跑: ${bReadText}`);
    assert.ok(!bReadText.includes(homeA), `绝不能落在 A 的 checkout 里（沉默错位）: ${bReadText}`);

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
    const backText = await runIn(outside, `terminal new --title "落回 A" --cmd "pwd"`, (s) => s.includes("已开终端") || s.includes("✗"), "工作区之外开终端");
    assert.match(backText, /已开终端/, `工作区之外开终端失败: ${backText}`);
    const backTask = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.title === "落回 A",
      "落回 A 的终端出现",
      20000,
    );
    assert.equal(backTask.task.workspaceId, wsA.id, "cwd 在工作区之外时必须落回归属工作区 A");

  } finally {
    if (wsB) await removeWorkspace(c, wsB.id);
    await removeWorkspace(c, wsA.id);
    device.close();
  }
});
