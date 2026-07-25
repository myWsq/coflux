import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { DeviceClient, utf8 } from "./device-harness.mjs";
import { mkRepo, startStack } from "./harness.mjs";

const PORT = 8845;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => {
  await stack?.stop();
  for (const repo of repos) repo.cleanup();
});

async function createRunningSession(device, title) {
  const repo = mkRepo();
  repos.push(repo);
  const control = device.control;
  control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  device.executePrepared(await device.waitPrepared("projectValidate"));
  const main = await control.waitFor((message) => message.case === "workspaceCreated" && message.workspace.isMain, "main workspace");
  control.send({ case: "taskCreate", workspaceId: main.workspace.id, title });
  const idle = await control.waitFor((message) => message.case === "taskUpdated" && message.task.title === title, "idle task");
  control.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  device.executePrepared(await device.waitPrepared("sessionCreate"));
  const running = await control.waitFor(
    (message) => message.case === "taskUpdated" && message.task.id === idle.task.id && message.task.status === TaskStatus.RUNNING,
    "running task",
  );
  return { repo, sessionId: running.task.sessionId };
}

function workerPid() {
  return Number(readFileSync(join(stack.home, "worker.pid"), "utf8").trim());
}

async function waitForNewWorker(previousPid, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const next = workerPid();
      if (next && next !== previousPid) return next;
    } catch {
      // worker 重启窗口内 pid 文件会短暂不存在。
    }
    await sleep(50);
  }
  throw new Error("worker 没有在期限内重启");
}

function outputSince(device, from, sessionId) {
  return device.log
    .slice(from)
    .filter((message) => message.case === "ptyOutput" && message.sessionId === sessionId)
    .map((message) => utf8(message.data))
    .join("");
}

async function input(device, sessionId, holderEpoch, inputSeq, marker) {
  const from = device.mark();
  device.send("ptyInput", {
    requestId: randomUUID(),
    sessionId,
    holderEpoch,
    inputSeq,
    data: new TextEncoder().encode(`echo ${marker}\r`),
  });
  await device.waitFor(
    (message) => message.case === "ptyInputAck" && message.sessionId === sessionId && message.appliedThroughSeq >= inputSeq,
    `${marker} input ack`,
    10000,
    from,
  );
  await device.waitFor(
    () => outputSince(device, from, sessionId).includes(marker),
    `${marker} output`,
    10000,
    from,
  );
}

test("worker 重启保留 logical holder；另一 client takeover 后旧 client 不会自动抢回", async () => {
  const first = await DeviceClient.pair(stack);
  await first.openRelay();
  const running = await createRunningSession(first, "faults");
  const attached = await first.attach(running.sessionId);
  const originalEpoch = attached.holderEpoch;
  await input(first, running.sessionId, originalEpoch, 1n, "BEFORE_WORKER_RESTART");

  const firstPid = workerPid();
  process.kill(firstPid, "SIGKILL");
  const secondPid = await waitForNewWorker(firstPid);
  assert.notEqual(secondPid, firstPid, "supervisor 拉起了新 worker 进程");
  await stack.waitDaemonOnline();

  const reconnectFrom = first.mark();
  await first.openRelay();
  const reattached = await first.attach(running.sessionId);
  assert.equal(reattached.holderEpoch, originalEpoch, "worker 重启后同 logical client 的 holderEpoch 不变");
  assert.equal(
    first.log.slice(reconnectFrom).some((message) => message.case === "sessionDetached" && message.sessionId === running.sessionId),
    false,
    "worker 重启不把原 holder 误判成另一个 client",
  );
  await input(first, running.sessionId, originalEpoch, 2n, "AFTER_WORKER_RESTART");

  const second = await first.fork();
  await second.openRelay();
  const takeoverFrom = first.mark();
  const taken = await second.attach(running.sessionId);
  assert.equal(taken.holderEpoch, originalEpoch + 1n, "另一 logical client attach 原子递增 holderEpoch");
  await first.waitFor(
    (message) => message.case === "sessionDetached" && message.sessionId === running.sessionId && message.holderEpoch === originalEpoch,
    "old holder detached",
    10000,
    takeoverFrom,
  );

  const staleRequestId = randomUUID();
  const staleFrom = first.mark();
  first.send("ptyInput", {
    requestId: staleRequestId,
    sessionId: running.sessionId,
    holderEpoch: originalEpoch,
    inputSeq: 3n,
    data: new TextEncoder().encode("echo STALE_MUST_NOT_RUN\r"),
  });
  const stale = await first.waitFor(
    (message) => message.case === "error" && message.requestId === staleRequestId,
    "stale holder rejected",
    10000,
    staleFrom,
  );
  assert.equal(stale.code, "stale_holder");

  await input(second, running.sessionId, taken.holderEpoch, 1n, "NEW_HOLDER_CONTROLS");

  // 旧 logical client 只重连 transport，不发 attach：重连本身不能夺回 holder。
  const noTakeoverFrom = first.mark();
  await first.openRelay();
  await sleep(150);
  assert.equal(
    first.log.slice(noTakeoverFrom).some((message) => message.case === "sessionAttached" && message.sessionId === running.sessionId),
    false,
    "transport 恢复不会隐式 attach/抢回",
  );
  await input(second, running.sessionId, taken.holderEpoch, 2n, "NEW_HOLDER_STILL_CONTROLS");

  first.close();
  second.close();
});
