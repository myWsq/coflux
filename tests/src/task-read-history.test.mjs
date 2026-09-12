/**
 * plan 097：web 回放已退出终端的最后输出——客户端 `taskRead` / `taskReadResult`。
 *
 * 验收核心：
 * - 用户手开的 shell 有输出后退出：`taskRead` 拿到中心 checkpoint（source=checkpoint），内容含标记，
 *   status=EXITED、exitCode=0——daemon 侧会话已不在、也没有命令日志，全靠中心按 task 保留的最后一屏；
 * - 经 `coflux terminal new` 开的命令终端跑完退出：`taskRead` 拿到 daemon 命令日志尾部（source=log），
 *   秒级命令的输出也在，退出码正确；
 * - 不存在的 task：结果自带 error，连接不断、后续请求照常。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStatus } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8872;
const COFLUXD = fileURLToPath(new URL("../../packages/cli/coflux.mjs", import.meta.url));
let stack;
const dirs = [];

function mkDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-taskread-")));
  dirs.push(dir);
  return dir;
}

function text(bytes) {
  return Buffer.from(bytes ?? new Uint8Array()).toString("utf8");
}

/** terminalCreate → 目录工作区 + 任务 → taskStart（同 agent-terminal-io.test.mjs）。 */
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

/** 在发起方会话里开一个 agent 命令终端并等它 RUNNING，返回中心侧 task。 */
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

async function readTask(c, taskId) {
  c.send({ case: "taskRead", taskId, maxBytes: 0 });
  return c.waitFor((m) => m.case === "taskReadResult" && m.taskId === taskId, `taskReadResult ${taskId}`, 20000);
}

before(async () => {
  stack = await startStack({ port: PORT });
});
after(async () => {
  await stack?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("taskRead：用户手开的 shell 退出后回放最后一屏（checkpoint），带状态与退出码", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  try {
    await device.attach(task.sessionId);
    await device.input(task.sessionId, "echo HIST-MARK-ONE\r");
    // checkpoint 2 秒周期、只在 RUNNING 时入库（hub.acceptSessionCheckpoint）：等中心真的拿到含标记的那一份再退出，
    // 否则退出后永远没有可回放内容。
    await c.waitFor(
      (m) => m.case === "sessionCheckpoint" && m.taskId === task.id && text(m.ansiSnapshot).includes("HIST-MARK-ONE"),
      "checkpoint 含标记",
      15000,
    );
    await device.input(task.sessionId, "exit\r");
    await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === task.id && m.task.status === TaskStatus.EXITED,
      "shell 退出",
      15000,
    );

    const result = await readTask(c, task.id);
    assert.equal(result.error ?? "", "", `不该报错: ${result.error}`);
    assert.equal(result.source, "checkpoint", "手开 shell 退出后只剩中心 checkpoint 可回放");
    assert.equal(result.status, TaskStatus.EXITED);
    assert.equal(result.exitCode, 0);
    assert.ok(result.capturedAt > 0, "checkpoint 来源要带采集时间");
    assert.ok(text(result.data).includes("HIST-MARK-ONE"), `最后一屏要含标记: ${JSON.stringify(text(result.data))}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});

test("taskRead：命令终端跑完退出后回放完整命令日志（log）；不存在的 task 回 error 且连接照常", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);
  try {
    // 负向先行：不存在的 task 不是断连也不是 ServerError，而是结果自带 error
    const missing = await readTask(c, "no-such-task");
    assert.ok(missing.error, "不存在的 task 要回 error");
    assert.equal(text(missing.data), "", "出错时不带内容");

    const target = await newAgentTerminal(c, device, task, ws, gatewayPort, home, "秒级命令", "echo LOG-MARK-TWO; exit 3");
    const exited = await c.waitFor(
      (m) => m.case === "taskUpdated" && m.task.id === target.id && m.task.status === TaskStatus.EXITED,
      "命令终端退出",
      30000,
    );
    assert.equal(exited.task.exitCode, 3);

    const result = await readTask(c, target.id);
    assert.equal(result.error ?? "", "", `不该报错: ${result.error}`);
    assert.equal(result.source, "log", "命令终端退出后应读到 daemon 命令日志");
    assert.equal(result.status, TaskStatus.EXITED);
    assert.equal(result.exitCode, 3);
    assert.ok(text(result.data).includes("LOG-MARK-TWO"), `日志尾部要含标记: ${JSON.stringify(text(result.data))}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});
