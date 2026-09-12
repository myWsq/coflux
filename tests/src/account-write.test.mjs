/**
 * 账号 API：工作区与终端操作——中心发起的 daemon 副作用 + 工作区/终端写 tools。
 *
 * 黑盒：通过账号登录拿 token 后直接调用 HTTP 账号接口，用订阅了的 web 测试 client
 * 观察广播（侧栏反应必须与用户亲手做完全一致），用 device-harness 的 attach 造「用户正在接管」的人类
 * holder，用 harness 的 rawDaemon 登记假设备模拟旧 worker / 可控的 worker。
 *
 * 覆盖：
 *   - 正向闭环：create_workspace（worktree 真在磁盘上 + workspaceCreated）→ create_terminal 把一条会留下
 *     输出且活得够久的命令打进常驻 shell（do-script）→ read_terminal 读到输出（source=snapshot）→
 *     send_terminal_input 写入生效 → wait_terminal 拿到**命令**的退出码而终端仍在跑 → stop_terminal →
 *     remove_terminal → remove_workspace（worktree 从磁盘消失 + workspaceRemoved）；rename_workspace。
 *   - 终端只有一种：create_terminal 不带 command 只开常驻、全 tty 的登录 shell，空标题落到「agent 终端」兜底，
 *     run_terminal 事后打入命令，送 exit 才退出；wait_terminal 在没跑过命令时可读拒绝而不是干等。
 *   - 负向：用户 attach 期间 send_terminal_input 被拒且文案含「用户正在接管」；删 running 终端被拒；删主工作区
 *     被拒；超每工作区终端上限被拒；旧 worker（不宣告能力的 rawDaemon）上写 tool 立即回「需要升级」且不等待；
 *     wait_terminal 超时返回状态而非错误；server 重启后中心发起的已安装 prepared 操作仍能完成（restore 续上）。
 *   - 跨账号 id 被拒见 account-isolation.test.mjs（那里已有两账号栈）。
 *
 * 端口：8869（独占）。每工作区活跃终端上限压到 2，上限用例才跑得快。
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  create,
  DeviceEnvelopeSchema,
  DEVICE_PROTOCOL_VERSION,
  decodeDeviceEnvelope,
  encodeDeviceEnvelope,
  TaskStatus,
} from "@coflux/protocol";
import { startStack, mkRepo, rawDaemon, tokenFromUrl } from "./harness.mjs";
import { openNativeDevice } from "./device-harness.mjs";
import { callOperation as callTool, loginAccount } from "./account-harness.mjs";

const PORT = 8869;
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_TERMINALS = 2;
/** 与 crates/worker/src/main.rs、apps/server/src/daemon-capabilities.ts 的能力名一致。 */
const CAPABILITIES = ["prepared_execute", "terminal_io"];

let stack;
let repo;
let device;
let observer;
let token;
let projectId;
let mainWorkspaceId;
let subWorkspace;
const tmpDirs = [];

function mkDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

async function tool(name, args) {
  const r = await callTool(BASE, token, name, args);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
  assert.ok(r.result, `${name} 无 result: ${JSON.stringify(r.json)}`);
  return r.result;
}

async function okTool(name, args) {
  const result = await tool(name, args);
  assert.ok(!result.isError, `${name} 应成功: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

async function errTool(name, args) {
  const result = await tool(name, args);
  assert.equal(result.isError, true, `${name} 应失败: ${JSON.stringify(result.structuredContent)}`);
  return result.content[0].text;
}

/** Terminals opened by the current test. Shells never exit on their own any more, so a test that
 * fails midway would otherwise leave them running and every later test would hit the per-workspace
 * cap: afterEach stops and removes whatever is left, ignoring terminals the test already cleaned. */
const openedTerminals = new Set();

/** create_terminal that registers the terminal for afterEach cleanup. */
async function openTerminal(args) {
  const value = await okTool("create_terminal", args);
  openedTerminals.add(value.terminal.id);
  return value;
}

afterEach(async () => {
  const leftovers = [...openedTerminals];
  openedTerminals.clear();
  for (const terminalId of leftovers) {
    try {
      await callTool(BASE, token, "stop_terminal", { terminalId });
    } catch {
      // offline device or already gone: nothing to stop
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const removed = await callTool(BASE, token, "remove_terminal", { terminalId }).catch(() => null);
      if (!removed || !removed.result?.isError || /不存在或不属于当前账号/.test(removed.result.content?.[0]?.text ?? "")) break;
      await sleep(500);
    }
  }
});

/** 轮询 list_terminals 直到某终端的条目满足条件：命令状态（busy / lastCommandExitCode）随 checkpoint 到中心，滞后最多两秒。 */
async function listedUntil(terminalId, predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = (await okTool("list_terminals", {})).terminals.find((t) => t.id === terminalId);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  throw new Error(`${label} 超时；最后一次: ${JSON.stringify(last)}`);
}

/** 轮询 read_terminal 直到文本满足条件（快照有周期，输出不一定立刻上屏）。 */
async function readUntil(terminalId, predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await okTool("read_terminal", { terminalId });
    if (predicate(last)) return last;
    await sleep(300);
  }
  throw new Error(`${label} 超时；最后一次: ${JSON.stringify(last)}`);
}

async function runningSessionId(terminalId) {
  const running = await observer.waitFor(
    (m) => m.case === "taskUpdated" && m.task.id === terminalId && m.task.status === TaskStatus.RUNNING && m.task.sessionId,
    `terminal ${terminalId} running`,
    20000,
  );
  return running.task.sessionId;
}

/** 用 rawDaemon 走登记流程造一台假设备；capabilities 为空数组即「旧 worker」。返回 { daemon, daemonId, deviceToken }。 */
async function enrollFakeDaemon(name, capabilities) {
  const daemon = rawDaemon(PORT);
  await daemon.ready;
  daemon.send({
    case: "daemonEnrollRequest",
    name,
    host: `${name}-host`,
    platform: "test",
    workerVersion: "builtin",
    supervisorVersion: "test",
    arch: "x86_64",
    capabilities,
  });
  const pending = await daemon.waitFor((m) => m.case === "daemonAuthorizePending", `${name} authorizePending`);
  const authorizer = stack.makeClient();
  try {
    await authorizer.authSubscribe();
    authorizer.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
    await authorizer.waitFor((m) => m.case === "deviceAuthorized", `${name} deviceAuthorized`);
  } finally {
    authorizer.close();
  }
  const enrolled = await daemon.waitFor((m) => m.case === "daemonEnrolled", `${name} daemonEnrolled`);
  return { daemon, daemonId: enrolled.daemonId, deviceToken: enrolled.deviceToken };
}

/** 在某台设备上造一个目录工作区（DB-only，terminalCreate），返回工作区 id。假设备也能用。 */
async function dirWorkspaceOn(daemonId, path) {
  const c = stack.makeClient();
  try {
    await c.authSubscribe();
    c.send({ case: "terminalCreate", daemonId, path });
    const ws = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === path && m.workspace.daemonId === daemonId, "dir ws");
    return ws.workspace.id;
  } finally {
    c.close();
  }
}

before(async () => {
  stack = await startStack({ port: PORT, serverEnv: { COFLUX_PUBLIC_URL: BASE, COFLUX_MAX_AGENT_TERMINALS: String(MAX_TERMINALS) } });
  token = await loginAccount(BASE);

  repo = mkRepo();
  device = await openNativeDevice(stack);
  observer = device.control;
  observer.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const created = await observer.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace", 20000);
  mainWorkspaceId = created.workspace.id;
  projectId = created.workspace.projectId;
});

after(async () => {
  device?.close();
  await stack?.stop();
  repo?.cleanup();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("create_workspace：worktree 真在磁盘上，web 收到 workspaceCreated；rename_workspace 改名同步广播", async () => {
  const { workspace } = await okTool("create_workspace", { projectId, branch: "account-sub", createNew: true, name: "子任务" });
  assert.equal(workspace.projectId, projectId);
  assert.equal(workspace.branch, "account-sub");
  assert.equal(workspace.name, "子任务");
  assert.equal(workspace.isMain, false);
  assert.ok(existsSync(workspace.path), `worktree 目录必须真在磁盘上: ${workspace.path}`);
  assert.ok(existsSync(join(workspace.path, ".git")), "是 git worktree（含 .git 指针）");
  await observer.waitFor((m) => m.case === "workspaceCreated" && m.workspace.id === workspace.id, "web 侧 workspaceCreated");
  subWorkspace = workspace;

  const listed = await okTool("list_workspaces", { projectId });
  assert.ok(listed.workspaces.some((w) => w.id === workspace.id), "list_workspaces 能看到");

  const renamed = await okTool("rename_workspace", { workspaceId: workspace.id, name: "子任务-2" });
  assert.equal(renamed.workspace.id, workspace.id);
  assert.equal(renamed.workspace.name, "子任务-2");
  await observer.waitFor((m) => m.case === "workspaceCreated" && m.workspace.id === workspace.id && m.workspace.name === "子任务-2", "web 侧改名广播");
  // 主工作区也可改名（与 web 一致）
  const mainRenamed = await okTool("rename_workspace", { workspaceId: mainWorkspaceId, name: "主" });
  assert.equal(mainRenamed.workspace.name, "主");
});

test("闭环：create_terminal --cmd（do-script）→ read_terminal(snapshot) → send_terminal_input → wait_terminal 命令退出码 → stop → remove_terminal", async () => {
  const { terminal } = await openTerminal({
    workspaceId: subWorkspace.id,
    title: "闭环",
    command: "echo ACCOUNT_T1_START; read line; echo GOT:$line; (exit 7)",
  });
  assert.equal(terminal.workspaceId, subWorkspace.id);
  assert.equal(terminal.status, "running");
  assert.equal(terminal.title, "闭环");
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.RUNNING, "web 侧 running");

  // 命令在提示符就绪后才打入：输出出现在设备快照里（滚动缓冲 + 当前屏）。真 tty 会回显命令行本身
  // （含 `echo ACCOUNT_T1_START` 与 `GOT:$line`），所以只认**行首**的产出，不认回显。
  const started = await readUntil(terminal.id, (r) => r.source === "snapshot" && /^ACCOUNT_T1_START$/m.test(r.text), "命令输出出现在快照里");
  assert.equal(started.status, "running");
  assert.ok(!/^GOT:ping/m.test(started.text), "输入前不该有 GOT:ping");

  const sent = await okTool("send_terminal_input", { terminalId: terminal.id, text: "ping" });
  assert.equal(sent.terminalId, terminal.id);
  assert.ok(sent.bytes >= 5, "写入含回车");

  // wait 等的是那条命令：退出码 7 来自 shell 集成标记，终端本身还在跑
  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(waited.finished, true, JSON.stringify(waited));
  assert.equal(waited.exited, false, "命令结束不等于终端退出");
  assert.equal(waited.timedOut, false);
  assert.equal(waited.exitCode, 7, "退出码必须透传");
  assert.equal(waited.terminal.status, "running");
  // 已结束的命令再 wait：立即拿到留档的退出码，不会等下一条
  const again = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 5 });
  assert.equal(again.finished, true);
  assert.equal(again.exitCode, 7);

  const finished = await readUntil(terminal.id, (r) => /^GOT:ping$/m.test(r.text), "输入生效后的快照");
  assert.equal(finished.source, "snapshot");
  assert.equal(finished.status, "running");

  // 账号 API 的 list 里，跑着的终端带命令状态：空闲 + 上一条退出码。这份视图由 checkpoint 喂（2 秒周期），
  // 比 wait 的即时回执晚一拍，得轮询到字段出现为止。
  const listed = await listedUntil(terminal.id, (t) => t.commandSeq === 1 && t.lastCommandExitCode !== null, "list_terminals receives the completed command checkpoint");
  assert.equal(listed.busy, false, JSON.stringify(listed));
  assert.equal(listed.lastCommandExitCode, 7, JSON.stringify(listed));

  // 事后再打一条：run_terminal 与 create_terminal 的 --cmd 是同一条路
  const ran = await okTool("run_terminal", { terminalId: terminal.id, command: "echo SECOND-RUN" });
  assert.equal(ran.commandSeq, 2, JSON.stringify(ran));
  const second = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(second.finished, true);
  assert.equal(second.exitCode, 0);
  await readUntil(terminal.id, (r) => /^SECOND-RUN$/m.test(r.text), "第二条命令的输出（不是回显）");

  const stopped = await okTool("stop_terminal", { terminalId: terminal.id });
  if (!stopped.exited) {
    const gone = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
    assert.equal(gone.exited, true, "停止后必须退出");
  }
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.EXITED, "web 侧 exited", 30000);

  // 已退出的终端再输入 → 明确错误
  const exitedInput = await errTool("send_terminal_input", { terminalId: terminal.id, text: "x" });
  assert.match(exitedInput, /已退出/);

  const removed = await okTool("remove_terminal", { terminalId: terminal.id });
  assert.equal(removed.terminalId, terminal.id);
  await observer.waitFor((m) => m.case === "taskRemoved" && m.taskId === terminal.id, "web 侧 taskRemoved");
  const missing = await errTool("read_terminal", { terminalId: terminal.id });
  assert.match(missing, /不存在或不属于当前账号/);
});

test("终端只有一种：create_terminal 不带 command 开出常驻 shell，read 是快照，wait 没命令时可读拒绝，送 exit 才退出", async () => {
  // 命令与标题都不给：标题必须落到「agent 终端」兜底，侧栏不能出现空标题
  const { terminal } = await openTerminal({ workspaceId: subWorkspace.id });
  assert.equal(terminal.status, "running");
  assert.equal(terminal.title, "agent 终端", "没给标题时要落到兜底");
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.RUNNING, "web 侧 running");

  // read 是设备上会话的快照（滚动缓冲 + 当前画面）
  const prompt = await readUntil(terminal.id, (r) => r.source === "snapshot" && r.text.trim().length > 0, "shell 提示符出现在快照里");
  assert.equal(prompt.status, "running", "它不会自己退出");

  // 还没跑过任何命令：wait 可读拒绝而不是干等到超时
  const nothing = await errTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 2 });
  assert.match(nothing, /no command has run|nothing to wait for/, nothing);

  // 全 tty：标记里的引号让命令回显（TTY-"OK"-ACCOUNT）与命令输出（TTY-OK-ACCOUNT）区分得开。
  await okTool("send_terminal_input", { terminalId: terminal.id, text: 'test -t 0 && test -t 1 && echo TTY-"OK"-ACCOUNT' });
  const screen = await readUntil(terminal.id, (r) => /^TTY-OK-ACCOUNT$/m.test(r.text), "终端里 stdin/stdout 都是 tty");
  assert.equal(screen.source, "snapshot");
  assert.equal(screen.status, "running", "命令跑完了终端也不能退出");
  // 手敲（send）的命令同样被标记观测到：wait 立即拿到它的退出码
  const typed = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 10 });
  assert.equal(typed.finished, true, JSON.stringify(typed));
  assert.equal(typed.exitCode, 0);

  await okTool("send_terminal_input", { terminalId: terminal.id, text: "exit 0" });
  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(waited.exited, true, "送 exit 之后才退出");
  assert.equal(waited.exitCode, 0, "退出码是 shell 的");
  // The device wait result can precede the center's terminal-exit projection.
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.EXITED, "shell exit reaches the center", 30000);
  await okTool("remove_terminal", { terminalId: terminal.id });
});

test("stop_terminal 结束长命令；删 running 终端被拒；wait_terminal 超时返回状态而非错误", async () => {
  const { terminal } = await openTerminal({ workspaceId: subWorkspace.id, title: "长跑", command: "sleep 60" });
  assert.equal(terminal.status, "running");

  const rejected = await errTool("remove_terminal", { terminalId: terminal.id });
  assert.match(rejected, /仍在运行/, "running 终端必须先 stop");

  const t0 = Date.now();
  const timedOut = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 1 });
  assert.equal(timedOut.exited, false);
  assert.equal(timedOut.finished, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.terminal.status, "running");
  assert.ok(Date.now() - t0 < 10000, "1 秒超时不该等很久");

  const stopped = await okTool("stop_terminal", { terminalId: terminal.id });
  assert.equal(stopped.terminal.id, terminal.id);
  if (!stopped.exited) {
    const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
    assert.equal(waited.exited, true, "停止后必须退出");
  }
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.EXITED, "web 侧 exited", 30000);
  // 已退出的再 stop 直接返回
  const again = await okTool("stop_terminal", { terminalId: terminal.id });
  assert.equal(again.exited, true);
  await okTool("remove_terminal", { terminalId: terminal.id });
});

test("人类优先：用户 attach 期间 send_terminal_input 被拒且文案含「用户正在接管」，用户没被踢下线", async () => {
  const { terminal } = await openTerminal({ workspaceId: subWorkspace.id, title: "被接管", command: "read line; echo GOT:$line" });
  const sessionId = await runningSessionId(terminal.id);
  const attached = await device.attach(sessionId);
  assert.ok(attached.holderEpoch > 0n);

  const rejected = await errTool("send_terminal_input", { terminalId: terminal.id, text: "x" });
  assert.match(rejected, /用户正在接管/, `接管期间必须被拒: ${rejected}`);
  // 用户仍是 holder：能继续输入，命令收到的是用户的输入而不是 agent 的；wait 不因接管被拒，
  // 且拿到的是**这条命令**的退出码（用户打字进去的那条）
  await device.input(sessionId, "from-user\r");
  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(waited.finished, true, JSON.stringify(waited));
  assert.equal(waited.exitCode, 0);
  // 回显里也有 `GOT:$line`：只认行首的产出
  const out = await readUntil(terminal.id, (r) => /^GOT:from-user$/m.test(r.text), "用户输入生效");
  assert.ok(!/^GOT:x/m.test(out.text), "被拒的 agent 输入不能写进去");
  await okTool("stop_terminal", { terminalId: terminal.id });
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.EXITED, "被接管的终端停掉", 30000);
  await okTool("remove_terminal", { terminalId: terminal.id });
});

test("每工作区活跃终端上限（含用户手开的）：超限被拒", async () => {
  const opened = [];
  for (let i = 0; i < MAX_TERMINALS; i += 1) {
    const { terminal } = await openTerminal({ workspaceId: subWorkspace.id, title: `占位${i}`, command: "sleep 60" });
    opened.push(terminal.id);
  }
  const rejected = await errTool("create_terminal", { workspaceId: subWorkspace.id, title: "超限", command: "sleep 60" });
  assert.match(rejected, /上限/, rejected);
  assert.ok(rejected.includes(String(MAX_TERMINALS)));
  for (const id of opened) {
    await okTool("stop_terminal", { terminalId: id });
    const waited = await okTool("wait_terminal", { terminalId: id, timeoutSeconds: 30 });
    assert.equal(waited.exited, true);
    await okTool("remove_terminal", { terminalId: id });
  }
  const terminals = await okTool("list_terminals", { workspaceId: subWorkspace.id });
  assert.equal(terminals.terminals.length, 0, "本工作区终端已全部清理");
});

test("wait_terminal 上限 600 秒（plan 094）：一次超过 60 秒的等待穿过真实 HTTP 完整返回，不被中心掐断", async () => {
  // Node 的 requestTimeout 默认 5 分钟只管收请求体，handler 阶段不受它管——但要用真实请求证明，不凭文档。
  const { terminal } = await openTerminal({ workspaceId: subWorkspace.id, title: "慢退出", command: "sleep 65; (exit 0)" });
  const t0 = Date.now();
  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 120 });
  const elapsed = Date.now() - t0;
  assert.equal(waited.finished, true, `65 秒的命令必须等到结束: ${JSON.stringify(waited)}`);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.exitCode, 0);
  assert.ok(elapsed >= 60_000, `真实等待应超过 60 秒: ${elapsed}ms`);
  await okTool("stop_terminal", { terminalId: terminal.id });
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.EXITED, "慢退出停掉", 30000);
  await okTool("remove_terminal", { terminalId: terminal.id });
});

test("remove_workspace：主工作区被拒；子工作区删除后 worktree 从磁盘消失且 web 收到 workspaceRemoved", async () => {
  const mainRejected = await errTool("remove_workspace", { workspaceId: mainWorkspaceId });
  assert.match(mainRejected, /主工作区/);

  // 留一个已退出的终端，验证随工作区一起清理
  const { terminal } = await openTerminal({ workspaceId: subWorkspace.id, title: "遗留", command: "true" });
  const ran = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(ran.finished, true);
  await okTool("stop_terminal", { terminalId: terminal.id });
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.EXITED, "遗留终端停掉", 30000);

  const removed = await okTool("remove_workspace", { workspaceId: subWorkspace.id });
  assert.equal(removed.workspaceId, subWorkspace.id);
  assert.ok(removed.removedTerminalIds.includes(terminal.id), "遗留终端随工作区删除");
  await observer.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === subWorkspace.id, "web 侧 workspaceRemoved");
  assert.ok(!existsSync(subWorkspace.path), `worktree 目录必须从磁盘消失: ${subWorkspace.path}`);
  const listed = await okTool("list_workspaces", { projectId });
  assert.deepEqual(listed.workspaces.map((w) => w.id), [mainWorkspaceId]);
  const gone = await errTool("remove_workspace", { workspaceId: subWorkspace.id });
  assert.match(gone, /不存在或不属于当前账号/);
});

test("旧 worker 门禁：不宣告能力的设备上，写 tool 立即返回「需要升级」且不等待", async () => {
  const fake = await enrollFakeDaemon("legacy-worker", []);
  try {
    const wsId = await dirWorkspaceOn(fake.daemonId, mkDir("coflux-account-legacy-"));
    const t0 = Date.now();
    const rejected = await errTool("create_terminal", { workspaceId: wsId, title: "x", command: "echo hi" });
    assert.match(rejected, /需要升级/, rejected);
    assert.ok(rejected.includes("legacy-worker"), "错误里点名设备");
    assert.ok(Date.now() - t0 < 5000, `门禁必须即时判定，不能等超时（耗时 ${Date.now() - t0}ms）`);
    // 门禁在 prepare 之前：假设备不该收到任何 prepared 安装
    await sleep(300);
    assert.ok(!fake.daemon.log.some((m) => m.case === "preparedDeviceOperation"), "旧 worker 不得收到 prepared 安装（会留下永远不触发的记录）");
    // 只读仍可用：read 退回 checkpoint/none 而不是报升级
    const idle = (await okTool("list_terminals", { workspaceId: wsId })).terminals[0];
    const read = await okTool("read_terminal", { terminalId: idle.id });
    assert.equal(read.source, "none");
    // 目录工作区删除是纯 DB 路径，不需要能力
    await okTool("remove_workspace", { workspaceId: wsId });
  } finally {
    fake.daemon.close();
  }
});

test("server 重启后，中心发起的已安装 prepared 操作经 restore 续上并完成", async () => {
  // 可控的「新 worker」：宣告能力、对安装回 ok、但在重启前刻意不执行 Execute。
  const fake = await enrollFakeDaemon("resumable-worker", CAPABILITIES);
  let daemon = fake.daemon;
  let pendingCall;
  let reconnected;
  try {
    const wsId = await dirWorkspaceOn(fake.daemonId, mkDir("coflux-account-resume-"));
    pendingCall = callTool(BASE, token, "create_terminal", { workspaceId: wsId, title: "跨重启" }).catch(() => null);
    const install = await daemon.waitFor((m) => m.case === "preparedDeviceOperation", "首次安装");
    const template = decodeDeviceEnvelope(install.frame);
    assert.equal(template.payload.case, "sessionCreate");
    assert.equal(template.payload.value.command, "", "模板不再携带命令：终端一律是默认登录 shell");
    assert.equal(template.payload.value.shell, undefined, "shell 字段留空，supervisor 取默认 shell");
    const { operationId } = install;
    daemon.send({ case: "preparedDeviceOperationInstalled", operationId, ok: true });
    const execute = await daemon.waitFor((m) => m.case === "preparedDeviceOperationExecute" && m.operationId === operationId, "首次 Execute");
    assert.equal(execute.operationId, operationId);

    // 重启中心：DB 里的记录仍是 installed；假设备随旧连接断开后按凭证重新认证
    await stack.restartServer();
    daemon.close();
    reconnected = rawDaemon(PORT);
    await reconnected.ready;
    reconnected.send({
      case: "daemonAuth",
      deviceToken: fake.deviceToken,
      workerVersion: "builtin",
      supervisorVersion: "test",
      arch: "x86_64",
      capabilities: CAPABILITIES,
    });
    await reconnected.waitFor((m) => m.case === "daemonAuthed", "重启后认证");
    const reinstall = await reconnected.waitFor((m) => m.case === "preparedDeviceOperation" && m.operationId === operationId, "restore 重装同一记录", 15000);
    assert.equal(reinstall.operationId, operationId, "restore 重装的是同一条记录");
    reconnected.send({ case: "preparedDeviceOperationInstalled", operationId, ok: true });
    await reconnected.waitFor((m) => m.case === "preparedDeviceOperationExecute" && m.operationId === operationId, "restore 后再次 Execute", 15000);

    // 设备执行完毕：沿既有 DeviceOperationReport 回中心，同一个收敛事务落库/广播
    const watcher = stack.makeClient();
    try {
      await watcher.authSubscribe();
      const resultFrame = encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
        protocolVersion: DEVICE_PROTOCOL_VERSION,
        channelId: "",
        payload: {
          case: "operationAck",
          value: { requestId: "", operationId, ok: true, sessionId: template.payload.value.sessionId, pid: 4242 },
        },
      }));
      reconnected.send({ case: "deviceOperationReport", operationId, daemonId: fake.daemonId, ok: true, sessionId: template.payload.value.sessionId, pid: 4242, resultFrame });
      const running = await watcher.waitFor(
        (m) => m.case === "taskUpdated" && m.task.id === template.payload.value.taskId && m.task.status === TaskStatus.RUNNING,
        "重启后收敛为 running",
        15000,
      );
      assert.equal(running.task.sessionId, template.payload.value.sessionId);
    } finally {
      watcher.close();
    }
    const terminals = await okTool("list_terminals", { workspaceId: wsId });
    const mine = terminals.terminals.find((t) => t.id === template.payload.value.taskId);
    assert.equal(mine?.status, "running", "账号 API 也看到它已 running");
  } finally {
    reconnected?.close();
    daemon.close();
    await pendingCall;
    await stack.waitDaemonOnline(30000);
  }
});
