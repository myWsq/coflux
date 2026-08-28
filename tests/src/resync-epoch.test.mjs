import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, rawDaemon } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8865;
const RESYNC_ENTRY_LIMIT = 4096;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((repo) => repo.cleanup()); });

let taskObserver;

function latestTask(taskId) {
  for (let index = taskObserver.log.length - 1; index >= 0; index -= 1) {
    const message = taskObserver.log[index];
    if (message.case === "taskUpdated" && message.task.id === taskId) return message.task;
    if (message.case === "taskRemoved" && message.taskId === taskId) return undefined;
    if (message.case === "stateSnapshot") {
      const task = message.tasks.find((candidate) => candidate.id === taskId);
      if (task) return task;
    }
  }
  return undefined;
}

async function waitTaskStatus(taskId, status, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = latestTask(taskId);
    if (last?.status === status) return last;
    await sleep(25);
  }
  assert.fail(`${label}: expected status ${status}, got ${last?.status ?? "missing"}`);
}

async function assertTaskStatus(taskId, status, label) {
  await sleep(150);
  const task = latestTask(taskId);
  assert.equal(task?.status, status, label);
  return task;
}

async function settledTask(taskId) {
  await sleep(150);
  return latestTask(taskId);
}

let requestSequence = 0;

async function connectRawDaemon(credentials) {
  const daemon = rawDaemon(PORT);
  await daemon.ready;
  daemon.send({
    case: "daemonAuth",
    deviceToken: credentials.deviceToken,
    workerVersion: "resync-test-worker",
    supervisorVersion: "resync-test-supervisor",
    arch: "test-arch",
  });
  const authed = await daemon.waitFor((message) => message.case === "daemonAuthed", "raw daemon auth");
  assert.equal(authed.daemonId, stack.daemonId);
  return daemon;
}

async function agentRequest(daemon, sessionId, payload, label) {
  requestSequence += 1;
  const requestId = `resync-agent-${requestSequence}`;
  daemon.send({ case: "agentControlRequest", requestId, sessionId, payload });
  const result = await daemon.waitFor(
    (message) => message.case === "agentControlResult" && message.requestId === requestId,
    label,
  );
  assert.equal(result.ok, true, result.error ?? label);
  return result.payload;
}

async function createPendingTerminal(daemon, originSessionId, title) {
  const payload = await agentRequest(
    daemon,
    originSessionId,
    { case: "terminalNew", value: { title, shell: "/bin/true" } },
    `create ${title}`,
  );
  assert.equal(payload?.case, "terminalNew");
  const terminal = payload.value;
  await waitTaskStatus(terminal.taskId, TaskStatus.IDLE, `${title} idle`);
  return terminal;
}

async function barrier(daemon, originSessionId, label) {
  await agentRequest(
    daemon,
    originSessionId,
    { case: "terminalList", value: {} },
    label,
  );
}

function sendResync(daemon, ownerId, epoch, sessions) {
  daemon.send({
    case: "daemonResync",
    sessions,
    ...(ownerId === undefined ? {} : { snapshotOwnerId: ownerId, snapshotEpoch: epoch }),
  });
}

async function exitTerminal(daemon, terminal, exitCode, label) {
  daemon.send({ case: "sessionExit", sessionId: terminal.sessionId, exitCode });
  return waitTaskStatus(terminal.taskId, TaskStatus.EXITED, label);
}

test("resync authority 跨 WS 保留、owner 集有界且 exit fact 不可逆", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openRelayDevice(stack);
  const control = device.control;

  control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await control.waitFor(
    (message) => message.case === "workspaceCreated" && message.workspace.isMain,
    "main workspace",
  );
  control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "resync-epoch" });
  const idle = await control.waitFor(
    (message) => message.case === "taskUpdated" && message.task.title === "resync-epoch",
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
  assert.ok(sessionId);
  const credentials = JSON.parse(readFileSync(join(stack.home, "credentials.json"), "utf8"));
  taskObserver = control;
  device.closeTransport();

  await stack.stopDaemon();
  let daemon = await connectRawDaemon(credentials);
  try {
    const origin = { sessionId, taskId: idle.task.id };

    const overLimit = await createPendingTerminal(daemon, sessionId, "resync-over-limit");
    sendResync(
      daemon,
      "bounded-owner",
      1n,
      Array.from({ length: RESYNC_ENTRY_LIMIT + 1 }, (_, index) => ({
        sessionId: `oversized-session-${index}`,
        taskId: `oversized-task-${index}`,
      })),
    );
    await barrier(daemon, sessionId, "oversized resync barrier");
    await assertTaskStatus(overLimit.taskId, TaskStatus.IDLE, "超条数 resync 整份拒绝");
    sendResync(daemon, "bounded-owner", 1n, [origin, overLimit]);
    await waitTaskStatus(overLimit.taskId, TaskStatus.RUNNING, "超限快照不消耗 owner epoch");
    await exitTerminal(daemon, overLimit, 7, "over-limit terminal exited");

    const invalidId = await createPendingTerminal(daemon, sessionId, "resync-invalid-id");
    sendResync(daemon, "bounded-owner", 2n, [
      origin,
      invalidId,
      { sessionId: "x".repeat(256), taskId: "invalid-id-task" },
    ]);
    await barrier(daemon, sessionId, "invalid id resync barrier");
    await assertTaskStatus(invalidId.taskId, TaskStatus.IDLE, "非法 ID resync 整份拒绝");
    sendResync(daemon, "bounded-owner", 2n, [origin, invalidId]);
    await waitTaskStatus(invalidId.taskId, TaskStatus.RUNNING, "非法 ID 快照不消耗 owner epoch");
    await exitTerminal(daemon, invalidId, 8, "invalid-id terminal exited");

    const duplicated = await createPendingTerminal(daemon, sessionId, "resync-duplicates");
    sendResync(daemon, "bounded-owner", 3n, [origin, ...Array(128).fill(duplicated)]);
    await waitTaskStatus(duplicated.taskId, TaskStatus.RUNNING, "完全重复 session 引用去重后接受");
    await exitTerminal(daemon, duplicated, 9, "duplicate terminal exited");

    const first = await createPendingTerminal(daemon, sessionId, "owner-a-first");
    sendResync(daemon, "owner-a", 1n, [origin, first]);
    await waitTaskStatus(first.taskId, TaskStatus.RUNNING, "owner A epoch 1 accepted");

    const firstExited = await exitTerminal(daemon, first, 10, "first terminal exited");
    assert.equal(firstExited.sessionId, undefined);
    sendResync(daemon, "owner-a", 2n, [origin, first]);
    await barrier(daemon, sessionId, "owner A epoch 2 barrier");
    const monotonicExit = await assertTaskStatus(first.taskId, TaskStatus.EXITED, "new snapshot cannot reverse exit");
    assert.equal(monotonicExit.sessionId, undefined);
    assert.equal(monotonicExit.exitCode, 10);

    const second = await createPendingTerminal(daemon, sessionId, "same-epoch-replay");
    sendResync(daemon, "owner-a", 2n, [origin, second]);
    await barrier(daemon, sessionId, "same owner epoch replay barrier");
    await assertTaskStatus(second.taskId, TaskStatus.IDLE, "same owner epoch replay rejected");
    sendResync(daemon, "owner-b", 1n, [origin, second]);
    await waitTaskStatus(second.taskId, TaskStatus.RUNNING, "new owner B accepted");
    await exitTerminal(daemon, second, 11, "second terminal exited");

    const acrossReconnect = await createPendingTerminal(daemon, sessionId, "across-reconnect");
    daemon.close();
    await daemon.closed;
    daemon = await connectRawDaemon(credentials);

    const catalogRequest = await daemon.waitFor(
      (message) => message.case === "sessionCatalogRequest",
      "catalog request after reconnect",
    );
    daemon.send({
      case: "sessionCatalog",
      requestId: catalogRequest.requestId,
      sessions: [
        {
          sessionId,
          taskId: idle.task.id,
          pid: 42,
          cwd: repo.dir,
          cols: 80,
          rows: 24,
          outputSeq: 0n,
          startedAt: Date.now(),
        },
        {
          sessionId: first.sessionId,
          taskId: first.taskId,
          pid: 43,
          cwd: repo.dir,
          cols: 80,
          rows: 24,
          outputSeq: 0n,
          startedAt: Date.now(),
        },
      ],
      exits: [],
      snapshotOwnerId: "catalog-owner",
      snapshotEpoch: 1n,
      sessionOffset: 0,
      exitOffset: 0,
      nextSessionOffset: 2,
      nextExitOffset: 0,
      complete: true,
      reset: false,
    });
    await barrier(daemon, sessionId, "stale catalog barrier");
    await assertTaskStatus(first.taskId, TaskStatus.EXITED, "stale catalog cannot reverse exit");

    sendResync(daemon, "owner-b", 1n, [origin, acrossReconnect]);
    await barrier(daemon, sessionId, "reconnected owner B replay barrier");
    await assertTaskStatus(acrossReconnect.taskId, TaskStatus.IDLE, "owner epoch survives WS reconnect");

    sendResync(daemon, "owner-a", 99n, [origin, acrossReconnect]);
    await barrier(daemon, sessionId, "retired owner barrier");
    await assertTaskStatus(acrossReconnect.taskId, TaskStatus.IDLE, "retired owner rejected after reconnect");

    sendResync(daemon, undefined, undefined, [origin, acrossReconnect]);
    await barrier(daemon, sessionId, "legacy downgrade barrier");
    await assertTaskStatus(acrossReconnect.taskId, TaskStatus.IDLE, "legacy snapshot cannot bypass modern authority");

    sendResync(daemon, "owner-b", 2n, [origin, acrossReconnect]);
    await waitTaskStatus(acrossReconnect.taskId, TaskStatus.RUNNING, "current owner advances after reconnect");
    await exitTerminal(daemon, acrossReconnect, 12, "reconnect terminal exited");

    let currentOwner = "owner-b";
    let overflow;
    for (let index = 1; index <= 20; index += 1) {
      const candidate = await createPendingTerminal(daemon, sessionId, `owner-candidate-${index}`);
      const candidateOwner = `owner-${index}`;
      sendResync(daemon, candidateOwner, 1n, [origin, candidate]);
      await barrier(daemon, sessionId, `owner candidate ${index} barrier`);
      const task = await settledTask(candidate.taskId);
      assert.ok(task, `owner candidate ${index} task should exist`);
      if (task.status === TaskStatus.RUNNING) {
        currentOwner = candidateOwner;
        await exitTerminal(daemon, candidate, 20 + index, `owner candidate ${index} exited`);
        continue;
      }
      assert.equal(task.status, TaskStatus.IDLE, "达到硬上限后的首个新 owner 必须 fail-closed");
      overflow = candidate;
      break;
    }
    assert.ok(overflow, "应在有限 owner 切换后命中退休集合硬上限");

    sendResync(daemon, "owner-a", 100n, [origin, overflow]);
    await barrier(daemon, sessionId, "ancient owner barrier");
    await assertTaskStatus(overflow.taskId, TaskStatus.IDLE, "ancient retired owner remains rejected");

    sendResync(daemon, currentOwner, 2n, [origin, overflow]);
    await waitTaskStatus(overflow.taskId, TaskStatus.RUNNING, "current owner still advances at hard limit");
  } finally {
    daemon.close();
    device.close();
  }
});
