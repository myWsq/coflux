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
 * - 每工作区活跃终端硬上限，超限拒绝且错误可读。
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
