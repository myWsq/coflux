/**
 * plan 092：每个 coflux PTY 会话注入 COFLUX_* 环境变量。
 *
 * 黑盒：中心只随建会话请求下发 id，supervisor 在 create_session 里组装六个变量。三条建会话路径各开一个
 * 终端、在里面把变量打出来，断言值与中心（MCP `list_*` / 广播里的 task）的 id 完全一致：
 *   ① MCP `create_terminal`（中心发起的 prepared session.create）：项目工作区六个变量齐全；
 *      目录工作区 `COFLUX_PROJECT_ID` 存在但为空串；
 *   ② web 手开的终端（taskCreate + taskStart 的 prepared session.create，经 device-harness 自动执行）：
 *      attach 后输入 printf，经 read_terminal 读到；
 *   ③ 在 coflux 终端里跑 `cofluxd terminal new`（直发 IPC 路径），`terminal read` 里能看到。
 * 旧 worker / 旧 supervisor 的兼容（缺字段不报错）由 crates/protocol/src/ipc.rs 的 Legacy 单测覆盖。
 *
 * 端口：8870（独占）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";
import { callTool, consentClient, obtainTokens } from "./oauth-harness.mjs";

const PORT = 8870;
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/cofluxd.mjs", import.meta.url));
/** 与 crates/supervisor/src/sessions.rs 的注入清单一致：变量名是 agent 面向的契约，只能加不能改。 */
const ENV_NAMES = [
  "COFLUX_DEVICE_ID",
  "COFLUX_PROJECT_ID",
  "COFLUX_WORKSPACE_ID",
  "COFLUX_TASK_ID",
  "COFLUX_SESSION_ID",
  "COFLUX_MCP_URL",
];
const DUMP_ENV = "env | grep '^COFLUX_' | sort";

let stack;
let repo;
let device;
let observer;
let consentWs;
let token;
let projectId;
let mainWorkspaceId;
const tmpDirs = [];

function mkDir(prefix = "coflux-env-") {
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

/** 轮询 read_terminal 直到文本满足条件（命令日志异步落盘、快照有周期）。 */
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

/** 把 `env` 输出里的 COFLUX_* 行解析成 map；空值（`COFLUX_PROJECT_ID=`）也算存在。 */
function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^(COFLUX_[A-Z_]+)=(.*)$/.exec(line.trimEnd());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function hasAllEnv(text) {
  const env = parseEnv(text);
  return ENV_NAMES.every((name) => Object.hasOwn(env, name));
}

/** 断言六个变量齐全且与中心 id 一致。 */
function assertEnv(env, expected) {
  for (const name of ENV_NAMES) assert.ok(Object.hasOwn(env, name), `${name} 必须存在（哪怕为空串）: ${JSON.stringify(env)}`);
  assert.equal(env.COFLUX_DEVICE_ID, expected.deviceId, "COFLUX_DEVICE_ID = 本机 daemon 的设备 id");
  assert.equal(env.COFLUX_PROJECT_ID, expected.projectId, "COFLUX_PROJECT_ID = 所属项目 id（目录工作区为空串）");
  assert.equal(env.COFLUX_WORKSPACE_ID, expected.workspaceId, "COFLUX_WORKSPACE_ID = 所属工作区 id");
  assert.equal(env.COFLUX_TASK_ID, expected.taskId, "COFLUX_TASK_ID = 本终端的任务 id");
  assert.equal(env.COFLUX_SESSION_ID, expected.sessionId, "COFLUX_SESSION_ID = 本 PTY 会话 id");
  assert.equal(env.COFLUX_MCP_URL, MCP_URL, "COFLUX_MCP_URL = <COFLUX_PUBLIC_URL>/mcp");
}

/** 从广播里拿某任务的 sessionId（建库时就写死，第一条 taskUpdated 就带）。 */
async function sessionIdOf(taskId) {
  const m = await observer.waitFor(
    (msg) => msg.case === "taskUpdated" && msg.task.id === taskId && !!msg.task.sessionId,
    `task ${taskId} sessionId`,
    20000,
  );
  return m.task.sessionId;
}

/** 在本机 daemon 上造一个目录工作区（DB-only，terminalCreate），返回 { ws, task }（task 为 co-created 的 IDLE 任务）。 */
async function dirWorkspace(path) {
  observer.send({ case: "terminalCreate", daemonId: stack.daemonId, path });
  const ws = await observer.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === path && m.workspace.daemonId === stack.daemonId, "dir ws");
  const idle = await observer.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.workspace.id, "task co-created");
  return { ws: ws.workspace, task: idle.task };
}

/** web 手开的路径：taskStart（prepared session.create，device-harness 自动执行）→ RUNNING。 */
async function startTask(taskId, cols = 80, rows = 24) {
  observer.send({ case: "taskStart", taskId, cols, rows });
  const run = await observer.waitFor(
    (m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING && !!m.task.sessionId,
    "task running",
    20000,
  );
  return run.task;
}

async function removeWorkspace(workspaceId) {
  observer.send({ case: "workspaceRemove", workspaceId });
  await observer.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === workspaceId, "cleanup ws removed", 20000);
}

/** 在会话里跑一条 cofluxd 命令，输出重定向到文件——比解析 PTY 分块输出可靠得多。 */
function cliCmd(gatewayPort, args, outFile) {
  return `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} ${args} > ${outFile} 2>&1\r`;
}

before(async () => {
  stack = await startStack({ port: PORT, serverEnv: { COFLUX_PUBLIC_URL: BASE } });
  consentWs = await consentClient(stack);
  token = (await obtainTokens(BASE, consentWs)).access_token;

  repo = mkRepo();
  device = await openRelayDevice(stack);
  observer = device.control;
  observer.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const created = await observer.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace", 20000);
  mainWorkspaceId = created.workspace.id;
  projectId = created.workspace.projectId;
  assert.ok(projectId, "项目工作区必须带 projectId");
});

after(async () => {
  consentWs?.close();
  device?.close();
  await stack?.stop();
  repo?.cleanup();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("路径①：MCP create_terminal 开的命令终端里六个 COFLUX_* 齐全，值与中心 id 一致", async () => {
  const { terminal } = await okTool("create_terminal", { workspaceId: mainWorkspaceId, title: "坐标", command: DUMP_ENV });
  assert.equal(terminal.workspaceId, mainWorkspaceId);
  const sessionId = await sessionIdOf(terminal.id);
  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(waited.exited, true);
  assert.equal(waited.exitCode, 0, "grep 必须命中：会话里没有 COFLUX_* 就是没注入");

  const read = await readUntil(terminal.id, (r) => r.source === "log" && hasAllEnv(r.text), "命令日志里的 COFLUX_*");
  const env = parseEnv(read.text);
  assertEnv(env, { deviceId: stack.daemonId, projectId, workspaceId: mainWorkspaceId, taskId: terminal.id, sessionId });

  // 与 MCP 自己的 list_* 交叉核对：agent 把这些值直接传给 tools 就能命中
  const { devices } = await okTool("list_devices", {});
  assert.ok(devices.some((d) => d.id === env.COFLUX_DEVICE_ID && d.online), `list_devices 里必须有在线的 ${env.COFLUX_DEVICE_ID}`);
  const { projects } = await okTool("list_projects", {});
  assert.ok(projects.some((p) => p.id === env.COFLUX_PROJECT_ID), "list_projects 里必须有 COFLUX_PROJECT_ID");
  const { workspaces } = await okTool("list_workspaces", { projectId: env.COFLUX_PROJECT_ID });
  assert.ok(workspaces.some((w) => w.id === env.COFLUX_WORKSPACE_ID), "list_workspaces 里必须有 COFLUX_WORKSPACE_ID");
  const { terminals } = await okTool("list_terminals", { workspaceId: env.COFLUX_WORKSPACE_ID });
  assert.ok(terminals.some((t) => t.id === env.COFLUX_TASK_ID), "list_terminals 里必须有 COFLUX_TASK_ID");

  await okTool("remove_terminal", { terminalId: terminal.id });
});

test("路径①（目录工作区）：COFLUX_PROJECT_ID 存在但为空串，其余照常", async () => {
  const { ws } = await dirWorkspace(mkDir("coflux-env-dir-"));
  assert.equal(ws.projectId, "", "目录工作区没有项目");
  try {
    const { terminal } = await okTool("create_terminal", { workspaceId: ws.id, title: "目录坐标", command: DUMP_ENV });
    const sessionId = await sessionIdOf(terminal.id);
    const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
    assert.equal(waited.exited, true);

    const read = await readUntil(terminal.id, (r) => r.source === "log" && hasAllEnv(r.text), "目录工作区命令日志里的 COFLUX_*");
    const env = parseEnv(read.text);
    assertEnv(env, { deviceId: stack.daemonId, projectId: "", workspaceId: ws.id, taskId: terminal.id, sessionId });
    assert.equal(env.COFLUX_PROJECT_ID, "", "变量存在但为空串，不是缺失");
    await okTool("remove_terminal", { terminalId: terminal.id });
  } finally {
    await removeWorkspace(ws.id);
  }
});

test("路径②：web 手开的终端（taskCreate + taskStart）里也有 COFLUX_*，经 read_terminal 读到", async () => {
  observer.send({ case: "taskCreate", workspaceId: mainWorkspaceId, title: "手开" });
  const idle = await observer.waitFor(
    (m) => m.case === "taskUpdated" && m.task.workspaceId === mainWorkspaceId && m.task.title === "手开",
    "web 手建的任务",
    20000,
  );
  const task = await startTask(idle.task.id);
  const sessionId = task.sessionId;
  await device.attach(sessionId);

  // 每个变量单独一行，避免 80 列画面折行把长 id 切断
  await device.input(
    sessionId,
    `printf 'W=%s\\nT=%s\\nS=%s\\nD=%s\\nP=%s\\nM=%s\\n' "$COFLUX_WORKSPACE_ID" "$COFLUX_TASK_ID" "$COFLUX_SESSION_ID" "$COFLUX_DEVICE_ID" "$COFLUX_PROJECT_ID" "$COFLUX_MCP_URL"\r`,
  );
  // 输入行的回显只含 `S=%s`，只有真正展开后的输出才会出现 `S=<sessionId>`
  const read = await readUntil(task.id, (r) => r.text.includes(`S=${sessionId}`), "手开终端里的 COFLUX_*");
  assert.notEqual(read.source, "none");
  const lines = read.text.split("\n").map((l) => l.trimEnd());
  assert.ok(lines.includes(`W=${mainWorkspaceId}`), `COFLUX_WORKSPACE_ID 不符: ${read.text}`);
  assert.ok(lines.includes(`T=${task.id}`), `COFLUX_TASK_ID 不符: ${read.text}`);
  assert.ok(lines.includes(`S=${sessionId}`), `COFLUX_SESSION_ID 不符: ${read.text}`);
  assert.ok(lines.includes(`D=${stack.daemonId}`), `COFLUX_DEVICE_ID 不符: ${read.text}`);
  assert.ok(lines.includes(`P=${projectId}`), `COFLUX_PROJECT_ID 不符: ${read.text}`);
  assert.ok(lines.includes(`M=${MCP_URL}`), `COFLUX_MCP_URL 不符: ${read.text}`);

  await device.input(sessionId, "exit\r");
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === task.id && m.task.status === TaskStatus.EXITED, "手开终端退出", 20000);
  await okTool("remove_terminal", { terminalId: task.id });
});

test("路径③：在 coflux 终端里 `cofluxd terminal new`（直发 IPC 路径）开出的终端也有 COFLUX_*，terminal read 里能看到", async () => {
  const home = mkDir("coflux-env-cli-");
  const { ws, task: idle } = await dirWorkspace(home);
  const gatewayPort = device.gateway.port;
  try {
    const origin = await startTask(idle.id);
    await device.attach(origin.sessionId);

    const newOut = join(home, "new.txt");
    await device.input(origin.sessionId, cliCmd(gatewayPort, `terminal new --title "坐标" --cmd "${DUMP_ENV}"`, newOut));
    const created = await observer.waitFor(
      (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "坐标" && !!m.task.sessionId,
      "agent 建的任务出现在侧栏",
      20000,
    );
    assert.notEqual(created.task.id, origin.id, "必须是新任务");
    const exited = await observer.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === created.task.id && m.task.status === TaskStatus.EXITED,
      "命令跑完 → EXITED",
      20000,
    );
    assert.equal(exited.task.exitCode, 0, "grep 必须命中：会话里没有 COFLUX_* 就是没注入");
    await waitForFile(newOut, (s) => s.includes(created.task.id), "terminal new 输出");

    const readOut = join(home, "read.txt");
    await device.input(origin.sessionId, cliCmd(gatewayPort, `terminal read ${created.task.id}`, readOut));
    const readText = await waitForFile(readOut, hasAllEnv, "terminal read 输出");
    const env = parseEnv(readText);
    assertEnv(env, { deviceId: stack.daemonId, projectId: "", workspaceId: ws.id, taskId: created.task.id, sessionId: created.task.sessionId });
    // 新终端拿到的是它自己的 task/session，不是发起方的
    assert.notEqual(env.COFLUX_TASK_ID, origin.id);
    assert.notEqual(env.COFLUX_SESSION_ID, origin.sessionId);
  } finally {
    await removeWorkspace(ws.id);
  }
});
