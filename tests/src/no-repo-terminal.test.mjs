// 无 repo 终端（plan 045）：terminalCreate → 目录工作区（projectId 为空）+ 任务，
// PTY cwd = 传入的绝对路径；删除只删记录、不碰文件系统（不走 worktree.remove）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStatus } from "@coflux/protocol";
import { startStack } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8854;
let stack;
const dirs = [];

function mkDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-home-")));
  dirs.push(dir);
  return dir;
}

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => {
  await stack?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("terminalCreate：目录工作区 + 任务同建，PTY 打开在传入目录", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;

  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
  const ws = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === home, "dir ws created");
  assert.equal(ws.workspace.projectId, "", "目录工作区 projectId 为空");
  assert.equal(ws.workspace.branch, "", "目录工作区无 branch 语义");
  assert.equal(ws.workspace.isMain, false);
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.workspace.id, "task co-created");
  assert.equal(idle.task.status, TaskStatus.IDLE);
  assert.equal(idle.task.projectId, "", "任务不挂任何 project");

  c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  const run = await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");
  assert.ok(run.task.sessionId);

  await device.attach(run.task.sessionId);
  const from = device.mark();
  await device.input(run.task.sessionId, "echo CWD_$(pwd -P)_END\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes(`CWD_${home}_END`), "PTY cwd 为传入目录", 10000, from);
  device.close();
});

test("terminalCreate：每次点击各建一个工作区，互不复用", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;

  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
  const first = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === home, "first ws");
  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
  const second = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === home && m.workspace.id !== first.workspace.id, "second ws");
  assert.notEqual(second.workspace.id, first.workspace.id);
  device.close();
});

test("workspaceRemove：目录工作区连带任务删除，目录本身不被触碰", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;

  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
  const ws = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === home, "dir ws");
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.workspace.id, "task");
  c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");

  // 会话活着时直接删：旧 worktree.remove 路径对非 git 目录会失败，删除成功的广播本身
  // 即证明走了"仅删记录"分支。
  c.send({ case: "workspaceRemove", workspaceId: ws.workspace.id });
  await c.waitFor((m) => m.case === "taskRemoved" && m.taskId === idle.task.id, "task removed");
  await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === ws.workspace.id, "workspace removed");
  assert.ok(existsSync(home), "目录本身仍在（只删记录，不删文件系统）");
  device.close();
});

test("terminalCreate：空 path 拒绝", async () => {
  const device = await openRelayDevice(stack);
  const c = device.control;
  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: "  " });
  await c.waitFor((m) => m.case === "error" && m.message.includes("路径"), "空 path 报错");
  device.close();
});
