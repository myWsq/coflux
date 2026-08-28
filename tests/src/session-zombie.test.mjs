import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8862;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((repo) => repo.cleanup()); });

test("daemon 整树重启丢失 PTY 与 tombstone 后，catalog 将僵尸 task 收敛为 EXITED", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openRelayDevice(stack);
  const control = device.control;

  control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await control.waitFor(
    (message) => message.case === "workspaceCreated" && message.workspace.isMain,
    "main workspace",
  );
  control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "zombie" });
  const idle = await control.waitFor(
    (message) => message.case === "taskUpdated" && message.task.title === "zombie",
    "idle task",
  );
  control.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  const running = await control.waitFor(
    (message) => message.case === "taskUpdated" &&
      message.task.id === idle.task.id &&
      message.task.status === TaskStatus.RUNNING,
    "running task",
  );
  const sessionId = running.task.sessionId;
  await device.attach(sessionId);
  const from = device.mark();
  await device.input(sessionId, "echo ZOMBIE_PRECONDITION\r");
  await device.waitFor(
    (message) => message.case === "ptyOutput" && utf8(message.data).includes("ZOMBIE_PRECONDITION"),
    "live PTY precondition",
    10000,
    from,
  );

  // SIGKILL 整个 detached 进程组：supervisor 来不及生成/上报 tombstone，新 supervisor 又没有旧 PTY。
  // 中心只能依据同一设备重连后的全量空 catalog 反向收敛，不能依赖 sessionExit。
  await stack.restartDaemon();
  const exited = await control.waitFor(
    (message) => message.case === "taskUpdated" &&
      message.task.id === idle.task.id &&
      message.task.status === TaskStatus.EXITED,
    "zombie task convergence",
    20000,
  );
  assert.equal(exited.task.sessionId, undefined, "反向收敛清空 sessionId");
  assert.equal(exited.task.exitCode, undefined, "未知退出原因不编造 exitCode");

  await stack.waitDaemonOnline();
  const verifier = stack.makeClient();
  const snapshot = await verifier.authSubscribe();
  const persisted = snapshot.tasks.find((task) => task.id === idle.task.id);
  assert.ok(persisted, "任务记录仍存在");
  assert.equal(persisted.status, TaskStatus.EXITED, "EXITED 状态已持久化");
  assert.equal(persisted.sessionId, undefined, "快照中 sessionId 已清空");
  assert.equal(persisted.exitCode, undefined, "快照中 exitCode 为未知");
  verifier.close();
  device.close();
});
