/**
 * plan 091：中心托管 MCP 第二片——中心发起的 daemon 副作用 + 工作区/终端写 tools。
 *
 * 黑盒：经 090 的 OAuth 拿 token 后直接调 MCP tools（JSON-RPC over HTTP），用订阅了的 web 测试 client
 * 观察广播（侧栏反应必须与用户亲手做完全一致），用 device-harness 的 attach 造「用户正在接管」的人类
 * holder，用 harness 的 rawDaemon 登记假设备模拟旧 worker / 可控的 worker。
 *
 * 覆盖：
 *   - 正向闭环：create_workspace（worktree 真在磁盘上 + workspaceCreated）→ create_terminal 跑一条会留下
 *     输出且活得够久的命令 → read_terminal 读到输出（source=log）→ send_terminal_input 写入生效 →
 *     wait_terminal 拿到退出码 → remove_terminal → remove_workspace（worktree 从磁盘消失 + workspaceRemoved）；
 *     stop_terminal 结束长命令；rename_workspace。
 *   - 负向：用户 attach 期间 send_terminal_input 被拒且文案含「用户正在接管」；删 running 终端被拒；删主工作区
 *     被拒；超每工作区终端上限被拒；旧 worker（不宣告能力的 rawDaemon）上写 tool 立即回「需要升级」且不等待；
 *     wait_terminal 超时返回状态而非错误；server 重启后中心发起的已安装 prepared 操作仍能完成（restore 续上）。
 *   - 跨账号 id 被拒见 mcp-isolation.test.mjs（那里已有两账号栈）。
 *
 * 端口：8869（独占）。每工作区活跃终端上限压到 2，上限用例才跑得快。
 */
import { test, before, after } from "node:test";
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
import { openRelayDevice } from "./device-harness.mjs";
import { callTool, consentClient, obtainTokens } from "./oauth-harness.mjs";

const PORT = 8869;
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_TERMINALS = 2;
/** 与 crates/worker/src/main.rs、apps/server/src/daemon-capabilities.ts 的能力名一致。 */
const CAPABILITIES = ["prepared_execute", "terminal_io"];

let stack;
let repo;
let device;
let observer;
let consentWs;
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

/** 轮询 read_terminal 直到文本满足条件（命令日志是异步落盘的）。 */
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
  consentWs = await consentClient(stack);
  token = (await obtainTokens(BASE, consentWs)).access_token;

  repo = mkRepo();
  device = await openRelayDevice(stack);
  observer = device.control;
  observer.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const created = await observer.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace", 20000);
  mainWorkspaceId = created.workspace.id;
  projectId = created.workspace.projectId;
});

after(async () => {
  consentWs?.close();
  device?.close();
  await stack?.stop();
  repo?.cleanup();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("create_workspace：worktree 真在磁盘上，web 收到 workspaceCreated；rename_workspace 改名同步广播", async () => {
  const { workspace } = await okTool("create_workspace", { projectId, branch: "mcp-sub", createNew: true, name: "子任务" });
  assert.equal(workspace.projectId, projectId);
  assert.equal(workspace.branch, "mcp-sub");
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

test("闭环：create_terminal → read_terminal(log) → send_terminal_input → wait_terminal 退出码 → remove_terminal", async () => {
  const { terminal } = await okTool("create_terminal", {
    workspaceId: subWorkspace.id,
    title: "闭环",
    command: "echo MCP_T1_START; read line; echo GOT:$line; exit 7",
  });
  assert.equal(terminal.workspaceId, subWorkspace.id);
  assert.equal(terminal.status, "running");
  assert.equal(terminal.title, "闭环");
  await observer.waitFor((m) => m.case === "taskUpdated" && m.task.id === terminal.id && m.task.status === TaskStatus.RUNNING, "web 侧 running");

  // 日志与 PTY 输出由 tee 同时写出：只认 source=log 的那次读，避免撞上「快照先有、日志晚一瞬」的窗口
  const started = await readUntil(terminal.id, (r) => r.source === "log" && r.text.includes("MCP_T1_START"), "命令输出落到日志");
  assert.equal(started.source, "log", "命令终端优先读命令日志");
  assert.equal(started.status, "running");
  assert.ok(!started.text.includes("GOT:"), "输入前不该有 GOT");

  const sent = await okTool("send_terminal_input", { terminalId: terminal.id, text: "ping" });
  assert.equal(sent.terminalId, terminal.id);
  assert.ok(sent.bytes >= 5, "写入含回车");

  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(waited.exited, true);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.exitCode, 7, "退出码必须透传");
  assert.equal(waited.terminal.status, "exited");

  // 退出后仍能读到完整输出：日志不随 session 一起消失
  const finished = await readUntil(terminal.id, (r) => r.text.includes("GOT:ping"), "退出后读日志");
  assert.equal(finished.source, "log");
  assert.equal(finished.status, "exited");
  assert.equal(finished.exitCode, 7);

  // 已退出的终端再输入 → 明确错误
  const exitedInput = await errTool("send_terminal_input", { terminalId: terminal.id, text: "x" });
  assert.match(exitedInput, /已退出/);

  const removed = await okTool("remove_terminal", { terminalId: terminal.id });
  assert.equal(removed.terminalId, terminal.id);
  await observer.waitFor((m) => m.case === "taskRemoved" && m.taskId === terminal.id, "web 侧 taskRemoved");
  const missing = await errTool("read_terminal", { terminalId: terminal.id });
  assert.match(missing, /不存在或不属于当前账号/);
});

test("stop_terminal 结束长命令；删 running 终端被拒；wait_terminal 超时返回状态而非错误", async () => {
  const { terminal } = await okTool("create_terminal", { workspaceId: subWorkspace.id, title: "长跑", command: "sleep 60" });
  assert.equal(terminal.status, "running");

  const rejected = await errTool("remove_terminal", { terminalId: terminal.id });
  assert.match(rejected, /仍在运行/, "running 终端必须先 stop");

  const t0 = Date.now();
  const timedOut = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 1 });
  assert.equal(timedOut.exited, false);
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
  const { terminal } = await okTool("create_terminal", { workspaceId: subWorkspace.id, title: "被接管", command: "read line; echo GOT:$line" });
  const sessionId = await runningSessionId(terminal.id);
  const attached = await device.attach(sessionId);
  assert.ok(attached.holderEpoch > 0n);

  const rejected = await errTool("send_terminal_input", { terminalId: terminal.id, text: "x" });
  assert.match(rejected, /用户正在接管/, `接管期间必须被拒: ${rejected}`);
  // 用户仍是 holder：能继续输入，命令收到的是用户的输入而不是 agent 的
  await device.input(sessionId, "from-user\r");
  const waited = await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });
  assert.equal(waited.exited, true);
  const out = await readUntil(terminal.id, (r) => r.text.includes("GOT:"), "用户输入生效");
  assert.ok(out.text.includes("GOT:from-user"), out.text);
  assert.ok(!out.text.includes("GOT:x"), "被拒的 agent 输入不能写进去");
  await okTool("remove_terminal", { terminalId: terminal.id });
});

test("每工作区活跃终端上限（含用户手开的）：超限被拒", async () => {
  const opened = [];
  for (let i = 0; i < MAX_TERMINALS; i += 1) {
    const { terminal } = await okTool("create_terminal", { workspaceId: subWorkspace.id, title: `占位${i}`, command: "sleep 60" });
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

test("remove_workspace：主工作区被拒；子工作区删除后 worktree 从磁盘消失且 web 收到 workspaceRemoved", async () => {
  const mainRejected = await errTool("remove_workspace", { workspaceId: mainWorkspaceId });
  assert.match(mainRejected, /主工作区/);

  // 留一个已退出的终端，验证随工作区一起清理
  const { terminal } = await okTool("create_terminal", { workspaceId: subWorkspace.id, title: "遗留", command: "true" });
  await okTool("wait_terminal", { terminalId: terminal.id, timeoutSeconds: 30 });

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
    const wsId = await dirWorkspaceOn(fake.daemonId, mkDir("coflux-mcp-legacy-"));
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
    const wsId = await dirWorkspaceOn(fake.daemonId, mkDir("coflux-mcp-resume-"));
    pendingCall = callTool(BASE, token, "create_terminal", { workspaceId: wsId, title: "跨重启", command: "echo resumed" }).catch(() => null);
    const install = await daemon.waitFor((m) => m.case === "preparedDeviceOperation", "首次安装");
    const template = decodeDeviceEnvelope(install.frame);
    assert.equal(template.payload.case, "sessionCreate");
    assert.equal(template.payload.value.command, "echo resumed", "命令随 prepared 模板下发");
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
    assert.equal(mine?.status, "running", "MCP 也看到它已 running");
  } finally {
    reconnected?.close();
    daemon.close();
    await pendingCall;
    await stack.waitDaemonOnline(30000);
  }
});
