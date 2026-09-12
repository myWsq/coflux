/**
 * plan 092：每个 coflux PTY 会话注入 COFLUX_* 环境变量。
 *
 * 黑盒：中心只随建会话请求下发 id，supervisor 在 create_session 里组装五个变量。三条建会话路径各开一个
 * 终端、在里面把变量打出来，断言值与中心（账号 API `list_*` / 广播里的 task）的 id 完全一致：
 *   ① 账号 API `create_terminal`（中心发起的 prepared session.create）：项目工作区五个变量齐全；
 *      目录工作区 `COFLUX_PROJECT_ID` 存在但为空串；
 *   ② web 手开的终端（taskCreate + taskStart 的 prepared session.create，经 device-harness 自动执行）：
 *      attach 后输入 printf，经 read_terminal 读到；
 *   ③ 在 coflux 终端里跑 `coflux terminal new`（直发 IPC 路径），`terminal read` 里能看到。
 * 旧 worker / 旧 supervisor 的兼容（缺字段不报错）由 crates/protocol/src/ipc.rs 的 Legacy 单测覆盖。
 *
 * plan 112（同一套会话环境，加在一起验）：supervisor 把 `<COFLUX_HOME>/bin` 前置进每个会话的 PATH 首段、
 * 启动时把自身版本写到 `<COFLUX_HOME>/supervisor-version`；Rust 版 `coflux`（target/debug/coflux）在同一个
 * coflux 终端里走路径③，输出短语与 node 版一致。
 *
 * plan 115（同一套会话环境的第三件）：supervisor 给会话 shell 注入 shell 集成，把 `COFLUX_CLAUDE_PLUGIN_DIR`
 * 翻译成 `claude --plugin-dir <dir>`。这条用例另起一套栈（见文件末尾），因为主栈的 `COFLUX_SHELL` 指向包装
 * 脚本，按 basename 分派会（正确地）判成未知 shell、不注入。
 *
 * 端口：8870（独占）；plan 115 的第二套栈用 8874（同样独占）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, CLI_BIN } from "./harness.mjs";
import { openNativeDevice } from "./device-harness.mjs";
import { callOperation as callTool, loginAccount } from "./account-harness.mjs";

const PORT = 8870;
const BASE = `http://127.0.0.1:${PORT}`;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/coflux.mjs", import.meta.url));
/** Rust 版 coflux（plan 112）：与 node 版同一组子命令、同样的 stdout 短语。 */
const COFLUXD_RUST = CLI_BIN;
/** 与 crates/supervisor/src/sessions.rs 的注入清单一致：变量名是 agent 面向的契约，只能加不能改。 */
const ENV_NAMES = [
  "COFLUX_DEVICE_ID",
  "COFLUX_PROJECT_ID",
  "COFLUX_WORKSPACE_ID",
  "COFLUX_TASK_ID",
  "COFLUX_SESSION_ID",
];
const DUMP_ENV = "env | grep '^COFLUX_' | sort";

let stack;
let repo;
let device;
let observer;
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

/** 断言五个变量齐全且与中心 id 一致。 */
function assertEnv(env, expected) {
  for (const name of ENV_NAMES) assert.ok(Object.hasOwn(env, name), `${name} 必须存在（哪怕为空串）: ${JSON.stringify(env)}`);
  assert.equal(env.COFLUX_DEVICE_ID, expected.deviceId, "COFLUX_DEVICE_ID = 本机 daemon 的设备 id");
  assert.equal(env.COFLUX_PROJECT_ID, expected.projectId, "COFLUX_PROJECT_ID = 所属项目 id（目录工作区为空串）");
  assert.equal(env.COFLUX_WORKSPACE_ID, expected.workspaceId, "COFLUX_WORKSPACE_ID = 所属工作区 id");
  assert.equal(env.COFLUX_TASK_ID, expected.taskId, "COFLUX_TASK_ID = 本终端的任务 id");
  assert.equal(env.COFLUX_SESSION_ID, expected.sessionId, "COFLUX_SESSION_ID = 本 PTY 会话 id");
  assert.equal(env.COFLUX_MCP_URL, undefined, "新终端不再注入 账号 API 地址");
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

/** 在会话里跑一条 coflux 命令，输出重定向到文件——比解析 PTY 分块输出可靠得多。 */
function cliCmd(gatewayPort, args, outFile) {
  return `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} node ${COFLUXD} ${args} > ${outFile} 2>&1\r`;
}

/** 同上，但执行 Rust 版二进制（plan 112）。 */
function cliCmdRust(gatewayPort, args, outFile) {
  return `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} ${COFLUXD_RUST} ${args} > ${outFile} 2>&1\r`;
}

/** 会话 shell **启动时**拿到的环境（不是跑命令那一刻的 `$PATH`——rc 文件可能已经改过它）：daemon 的 COFLUX_SHELL
 * 指向一个包装脚本，它先把 `env` 原样落到 `<COFLUX_HOME>/initial-env-<COFLUX_SESSION_ID>.txt`，再 exec 真实 shell
 * 并原样转发参数——对本文件其它用例透明。（macOS 不让看别的进程的环境，/proc、ps -E 那套拿不到。） */
function writeShellWrapper(dir) {
  const realShell = process.env.SHELL || "/bin/zsh";
  const script = join(dir, "coflux-test-shell");
  writeFileSync(script, `#!/bin/sh\nenv > "$COFLUX_HOME/initial-env-$COFLUX_SESSION_ID.txt"\nexec ${realShell} "$@"\n`);
  chmodSync(script, 0o755);
  return script;
}

function initialEnvFile(sessionId) {
  return join(stack.home, `initial-env-${sessionId}.txt`);
}

before(async () => {
  const shellWrapper = writeShellWrapper(mkDir("coflux-env-shell-"));
  stack = await startStack({ port: PORT, serverEnv: { COFLUX_PUBLIC_URL: BASE }, daemonEnv: { COFLUX_SHELL: shellWrapper } });
  token = await loginAccount(BASE);

  repo = mkRepo();
  device = await openNativeDevice(stack);
  observer = device.control;
  observer.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const created = await observer.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace", 20000);
  mainWorkspaceId = created.workspace.id;
  projectId = created.workspace.projectId;
  assert.ok(projectId, "项目工作区必须带 projectId");
});

after(async () => {
  device?.close();
  await stack?.stop();
  repo?.cleanup();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("路径①：账号 API create_terminal 开的命令终端里五个 COFLUX_* 齐全，值与中心 id 一致", async () => {
  const { terminal } = await okTool("create_terminal", { workspaceId: mainWorkspaceId, title: "坐标", command: DUMP_ENV });
  assert.equal(terminal.workspaceId, mainWorkspaceId);
  const sessionId = await sessionIdOf(terminal.id);
  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(waited.exited, true);
  assert.equal(waited.exitCode, 0, "grep 必须命中：会话里没有 COFLUX_* 就是没注入");

  const read = await readUntil(terminal.id, (r) => r.source === "log" && hasAllEnv(r.text), "命令日志里的 COFLUX_*");
  const env = parseEnv(read.text);
  assertEnv(env, { deviceId: stack.daemonId, projectId, workspaceId: mainWorkspaceId, taskId: terminal.id, sessionId });

  // 与 账号 API 自己的 list_* 交叉核对：agent 把这些值直接传给 tools 就能命中
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
  assert.ok(lines.includes("M="), `COFLUX_MCP_URL 不符: ${read.text}`);

  await device.input(sessionId, "exit\r");
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === task.id && m.task.status === TaskStatus.EXITED, "手开终端退出", 20000);
  await okTool("remove_terminal", { terminalId: task.id });
});

test("路径③：在 coflux 终端里 `coflux terminal new`（直发 IPC 路径）开出的终端也有 COFLUX_*，terminal read 里能看到", async () => {
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

/** 握手上报的 supervisor 版本：首个 stateSnapshot 或其后的 daemonUpdated 里带非空 supervisorVersion 的那条。 */
async function reportedSupervisorVersion() {
  const hit = await observer.waitFor(
    (m) =>
      (m.case === "stateSnapshot" && m.daemons.some((d) => d.daemonId === stack.daemonId && d.supervisorVersion)) ||
      (m.case === "daemonUpdated" && m.daemon?.daemonId === stack.daemonId && !!m.daemon.supervisorVersion),
    "握手上报的 supervisorVersion",
    20000,
  );
  return hit.case === "stateSnapshot" ? hit.daemons.find((d) => d.daemonId === stack.daemonId).supervisorVersion : hit.daemon.supervisorVersion;
}

test("plan 112：会话 PATH 首段是 <COFLUX_HOME>/bin（其余段顺序不变）；supervisor-version 落盘等于握手上报的版本；Rust 版 coflux 走路径③输出与 node 版一致", async () => {
  // ① supervisor-version：启动即落盘，纯文本一行 = 握手上报的原文 + 换行（桌面版 plan 113 的读取契约）
  const version = await reportedSupervisorVersion();
  const versionFile = join(stack.home, "supervisor-version");
  assert.ok(existsSync(versionFile), `supervisor 启动后必须写出 ${versionFile}`);
  assert.equal(readFileSync(versionFile, "utf8"), `${version}\n`, "文件内容 = 握手上报的 supervisor 版本原文 + 换行");

  const home = mkDir("coflux-env-rust-");
  const { ws, task: idle } = await dirWorkspace(home);
  const gatewayPort = device.gateway.port;
  try {
    const origin = await startTask(idle.id);
    await device.attach(origin.sessionId);

    // ② PATH：看 shell 启动时拿到的初始环境（包装脚本在 exec 真实 shell 之前落盘的 env；rc 文件改过的 $PATH 不算），
    //    首段必须是 <COFLUX_HOME>/bin，其余段就是 supervisor 自己的 PATH（黑盒里 = 本测试进程的 PATH）按原顺序、去掉重复的那一段
    const envText = await waitForFile(initialEnvFile(origin.sessionId), (s) => /^PATH=/m.test(s), "会话初始环境落盘");
    const initialPath = envText.split("\n").find((line) => line.startsWith("PATH=")).slice("PATH=".length);
    const binDir = join(stack.home, "bin");
    const segments = initialPath.split(":");
    assert.equal(segments[0], binDir, `PATH 首段必须是 <COFLUX_HOME>/bin: ${initialPath}`);
    assert.deepEqual(
      segments.slice(1),
      (process.env.PATH ?? "").split(":").filter((segment) => segment !== binDir),
      "其余段 = supervisor 继承的 PATH，顺序不变、不重复",
    );

    // ③ Rust 版 coflux 在同一个终端里走路径③：开终端、读输出——短语与 node 版逐字一致
    const newOut = join(home, "new.txt");
    await device.input(origin.sessionId, cliCmdRust(gatewayPort, `terminal new --title "Rust 坐标" --cmd "${DUMP_ENV}"`, newOut));
    const created = await observer.waitFor(
      (m) => m.case === "taskUpdated" && m.task.workspaceId === ws.id && m.task.title === "Rust 坐标" && !!m.task.sessionId,
      "Rust 版建的任务出现在侧栏",
      20000,
    );
    assert.notEqual(created.task.id, origin.id, "必须是新任务");
    const exited = await observer.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === created.task.id && m.task.status === TaskStatus.EXITED,
      "命令跑完 → EXITED",
      20000,
    );
    assert.equal(exited.task.exitCode, 0);
    // 输出文件边写边读：等最后一行 `看输出：` 出现（或 `✗`）再比对，只等首行会读到半截
    const newText = await waitForFile(newOut, (s) => s.includes("看输出：") || s.includes("✗"), "Rust 版 terminal new 输出");
    assert.ok(
      newText.includes(`已开终端 ${created.task.id}（用户可在 coflux 侧栏看到并随时接管）`) && newText.includes(`看输出：coflux terminal read ${created.task.id}`),
      `Rust 版 terminal new 的短语必须与 node 版逐字一致: ${JSON.stringify(newText)}`,
    );

    const readOut = join(home, "read.txt");
    await device.input(origin.sessionId, cliCmdRust(gatewayPort, `terminal read ${created.task.id}`, readOut));
    const readText = await waitForFile(readOut, hasAllEnv, "Rust 版 terminal read 输出");
    assert.ok(readText.startsWith("# exited exit=0\n"), `read 首行是状态 + 退出码: ${JSON.stringify(readText.split("\n")[0])}`);
    const env = parseEnv(readText);
    assertEnv(env, { deviceId: stack.daemonId, projectId: "", workspaceId: ws.id, taskId: created.task.id, sessionId: created.task.sessionId });
  } finally {
    await removeWorkspace(ws.id);
  }
});

/* ===== plan 115：coflux 终端里手敲的 `claude` 自动带上 COFLUX_CLAUDE_PLUGIN_DIR 指向的插件 ===== */

/** 第二套栈的端口（独占）。不能复用主栈：主栈的 COFLUX_SHELL 是包装脚本，按 basename 分派会判成未知 shell，
 * 而这条用例要验的恰恰是真 shell（zsh/bash）那条注入链。 */
const PLUGIN_PORT = 8874;

/** 会话里被 `claude` 命中的假 claude：把自己的 argv 一行一个写进 `<dir>/claude-argv-<sessionId>.txt`
 * （每个会话一份，互不覆盖）。放在 daemon PATH 的首段，会话 PATH 继承它。 */
function writeFakeClaude(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "claude");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/claude-argv-$COFLUX_SESSION_ID.txt"\n`);
  chmodSync(script, 0o755);
  return bin;
}

/** 临时家目录：把本机真实 rc 挡在外面（开发机的 ~/.zshrc 会把自己的 bin 目录重新前置，真 claude 会抢在假的
 * 前面），同时给「用户原来的 rc 仍然照跑」一个可断言的落点。 */
function writeFakeHome(dir) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const marker = join(home, "user-rc.log");
  for (const rc of [".zshrc", ".bashrc"]) writeFileSync(join(home, rc), `printf '%s\\n' '${rc}' >> '${marker}'\n`);
  return { home, marker };
}

/** zsh 优先（macOS 默认 shell），没有就退 bash——两条注入链都必须过。 */
function realShell() {
  const found = ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path));
  if (!found) throw new Error("本机既没有 zsh 也没有 bash，无法验证 shell 集成");
  return found;
}

test("plan 115：真 shell 起的 coflux 会话里 `claude` 自动带 --plugin-dir，用户 rc 照跑；变量为空时与今天逐字一致", async () => {
  const dir = mkDir("coflux-plugin-");
  const pluginDir = join(dir, "claude-plugin");
  const wsPath = join(dir, "ws");
  for (const path of [pluginDir, wsPath]) mkdirSync(path, { recursive: true });
  const bin = writeFakeClaude(dir);
  const { home: fakeHome, marker } = writeFakeHome(dir);

  // 注入方（真机上是 Coflux.app 的 LaunchAgent）只做一件事：把变量写进 daemon 的环境。
  const plugged = await startStack({
    port: PLUGIN_PORT,
    daemonEnv: {
      COFLUX_SHELL: realShell(),
      COFLUX_CLAUDE_PLUGIN_DIR: pluginDir,
      HOME: fakeHome,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  });
  let plugDevice;
  try {
    plugDevice = await openNativeDevice(plugged);
    const control = plugDevice.control;
    control.send({ case: "terminalCreate", daemonId: plugged.daemonId, path: wsPath });
    const created = await control.waitFor(
      (m) => m.case === "workspaceCreated" && m.workspace.path === wsPath && m.workspace.daemonId === plugged.daemonId,
      "plan 115 目录工作区",
      20000,
    );
    const workspaceId = created.workspace.id;

    // 会话终端（不带命令）才走默认 shell；命令终端的 shell 是包装脚本，本来就不该注入
    const openSession = async (title) => {
      control.send({ case: "taskCreate", workspaceId, title });
      const idle = await control.waitFor(
        (m) => m.case === "taskUpdated" && m.task.workspaceId === workspaceId && m.task.title === title,
        `${title}：建任务`,
        20000,
      );
      control.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
      const run = await control.waitFor(
        (m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING && !!m.task.sessionId,
        `${title}：会话 RUNNING`,
        20000,
      );
      await plugDevice.attach(run.task.sessionId);
      return run.task;
    };
    const argvOf = async (sessionId, label) => {
      const text = await waitForFile(join(dir, `claude-argv-${sessionId}.txt`), (s) => s.includes("chat"), label);
      return text.split("\n").filter((line) => line !== "");
    };

    // ① 变量指向存在的目录：真 claude 收到 --plugin-dir <dir>，用户自己的参数原样跟在后面（含带空格的）
    const on = await openSession("带插件");
    await plugDevice.input(on.sessionId, "claude chat 'a b'\r");
    assert.deepEqual(
      await argvOf(on.sessionId, "带插件时的 claude argv"),
      ["--plugin-dir", pluginDir, "chat", "a b"],
      "shell 集成必须把变量翻译成 --plugin-dir，且不动用户自己的参数",
    );
    assert.ok(existsSync(marker), `用户原来的 rc 必须照常加载（没看到 ${marker}）`);

    // ② 变量为空 = 逃生口，命令行与今天逐字相同。栈级 env 是固定的，所以在会话里把它清空——函数每次调用
    //    才读这个变量，语义与「开一个变量为空的会话」等价。
    const off = await openSession("变量为空");
    await plugDevice.input(off.sessionId, "export COFLUX_CLAUDE_PLUGIN_DIR=\r");
    await plugDevice.input(off.sessionId, "claude chat 'a b'\r");
    assert.deepEqual(
      await argvOf(off.sessionId, "变量为空时的 claude argv"),
      ["chat", "a b"],
      "变量为空时必须退化成今天的 claude：不加任何 flag",
    );
  } finally {
    plugDevice?.close();
    await plugged.stop();
  }
});
