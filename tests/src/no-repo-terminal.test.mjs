// 无 repo 终端（plan 045）：terminalCreate → 目录工作区（projectId 为空）+ 任务，
// PTY cwd = 传入的绝对路径；删除只删记录、不碰文件系统（不走 worktree.remove）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
  // 清理：terminalCreate 自 plan 048 起按设备幂等复用目录工作区，残留会改变后续用例的行为
  c.send({ case: "workspaceRemove", workspaceId: ws.workspace.id });
  await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === ws.workspace.id, "cleanup ws removed");
  device.close();
});

test("terminalCreate：同设备幂等复用目录工作区，第二次只建任务（plan 048）", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const c = device.control;

  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
  const first = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === home, "first ws");
  const firstTask = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === first.workspace.id, "first task");
  // 第二次传不同 path：幂等复用不看 path，任务仍挂在首个工作区下
  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: mkDir() });
  const secondTask = await c.waitFor(
    (m) => m.case === "taskUpdated" && m.task.workspaceId === first.workspace.id && m.task.id !== firstTask.task.id,
    "second task on same ws",
  );
  assert.equal(secondTask.task.projectId, "", "复用任务同样不挂 project");
  // 若第二次误建了新工作区，上面的 taskUpdated 之前必先有它的 workspaceCreated——在已收
  // 消息日志里断言只存在一个目录工作区的创建广播
  const extraWs = c.log.find((m) => m.case === "workspaceCreated" && m.workspace.projectId === "" && m.workspace.id !== first.workspace.id);
  assert.equal(extraWs, undefined, "不产生第二个目录工作区");
  // 清理：不给后续用例留存量目录工作区
  c.send({ case: "workspaceRemove", workspaceId: first.workspace.id });
  await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === first.workspace.id, "cleanup ws removed");
  device.close();
});

test("terminalCreate：多 client 并发首次创建只产生一个 canonical 目录工作区", async () => {
  const home = mkDir();
  const device = await openRelayDevice(stack);
  const observer = device.control;
  const extraClients = Array.from({ length: 7 }, () => stack.makeClient());
  let workspaceId;

  try {
    await Promise.all(extraClients.map((client) => client.authSubscribe()));
    const senders = [observer, ...extraClients];
    const from = observer.log.length;

    // 8 条独立 WS 各发两次。即使 transport 对单连接严格顺序执行，不同连接的首个请求
    // 仍会并发撞进 terminalCreate，能实际验到 device 父行锁，而非只验连接内队列。
    for (const client of senders) {
      client.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
      client.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
    }

    const deadline = Date.now() + 15000;
    let taskIds = new Set();
    while (Date.now() < deadline) {
      taskIds = new Set(observer.log.slice(from)
        .filter((message) => message.case === "taskUpdated" && message.task.daemonId === stack.daemonId && message.task.projectId === "")
        .map((message) => message.task.id));
      if (taskIds.size === 16) break;
      await sleep(20);
    }
    assert.equal(taskIds.size, 16, "收到 16 个不同任务的广播");

    const fresh = stack.makeClient();
    try {
      const snapshot = await fresh.authSubscribe();
      const directoryWorkspaces = snapshot.workspaces.filter(
        (workspace) => workspace.daemonId === stack.daemonId && workspace.projectId === "",
      );
      assert.equal(directoryWorkspaces.length, 1, "该 daemon 只有一个目录工作区");
      workspaceId = directoryWorkspaces[0].id;
      const tasks = snapshot.tasks.filter((task) => task.workspaceId === workspaceId);
      assert.equal(tasks.length, 16, "canonical 工作区下恰有 16 个任务");
      assert.ok(tasks.every((task) => task.workspaceId === workspaceId), "全部任务指向同一个 workspaceId");

      const workspaceCreated = observer.log.slice(from).filter(
        (message) => message.case === "workspaceCreated" && message.workspace.daemonId === stack.daemonId && message.workspace.projectId === "",
      );
      assert.equal(workspaceCreated.length, 1, "目录 workspaceCreated 只广播一次");
    } finally {
      fresh.close();
    }

    observer.send({ case: "workspaceRemove", workspaceId });
    await observer.waitFor(
      (message) => message.case === "workspaceRemoved" && message.workspaceId === workspaceId,
      "cleanup concurrent directory workspace",
    );
  } finally {
    for (const client of extraClients) client.close();
    device.close();
  }
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
