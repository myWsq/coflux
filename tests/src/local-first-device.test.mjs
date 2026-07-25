import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { DeviceClient, utf8 } from "./device-harness.mjs";
import { mkRepo, startStack } from "./harness.mjs";

const PORT = 8844;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => {
  await stack?.stop();
  for (const repo of repos) repo.cleanup();
});

async function runningSession(device, title) {
  const repo = mkRepo();
  repos.push(repo);
  const client = device.control;
  client.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  device.executePrepared(await device.waitPrepared("projectValidate"));
  const main = await client.waitFor((message) => message.case === "workspaceCreated" && message.workspace.isMain, "main workspace");
  client.send({ case: "taskCreate", workspaceId: main.workspace.id, title });
  const idle = await client.waitFor((message) => message.case === "taskUpdated" && message.task.title === title, "idle task");
  client.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  device.executePrepared(await device.waitPrepared("sessionCreate"));
  const running = await client.waitFor(
    (message) => message.case === "taskUpdated" && message.task.id === idle.task.id && message.task.status === TaskStatus.RUNNING,
    "running task",
  );
  return { client, repo, taskId: idle.task.id, sessionId: running.task.sessionId };
}

function outputSince(device, from, sessionId) {
  return device.log
    .slice(from)
    .filter((message) => message.case === "ptyOutput" && message.sessionId === sessionId)
    .map((message) => utf8(message.data))
    .join("");
}

async function waitForFile(path, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for file ${path}`);
}

test("本地优先：direct/relay 重投 exactly-once，中心停止后完整控制 session", async () => {
  const device = await DeviceClient.pair(stack);
  await device.openRelay();
  const running = await runningSession(device, "local-first");
  await device.openDirect();

  const catalog = await device.catalog();
  assert.ok(catalog.sessions.some((session) => session.sessionId === running.sessionId), "direct catalog 由 sessiond 返回存活 session");
  const attached = await device.attach(running.sessionId);
  assert.ok(attached.ansiSnapshot instanceof Uint8Array, "首次 direct attach 返回原子 ANSI snapshot");
  const originalEpoch = attached.holderEpoch;

  const directFrom = device.mark();
  device.send("ptyInput", {
    requestId: randomUUID(),
    sessionId: running.sessionId,
    holderEpoch: originalEpoch,
    inputSeq: 1n,
    data: new TextEncoder().encode("echo DIRECT_READY\r"),
  });
  await device.waitFor(
    () => outputSince(device, directFrom, running.sessionId).includes("DIRECT_READY"),
    "direct PTY output",
    10000,
    directFrom,
  );
  await device.waitFor(
    (message) => message.case === "ptyInputAck" && message.sessionId === running.sessionId && message.appliedThroughSeq >= 1n,
    "direct input ack",
    10000,
    directFrom,
  );

  // ACK 观察点在发送前摘掉，随后硬断 direct；shell 的文件副作用证明 input 已提交。
  const exactlyOncePath = join(running.repo.dir, "exactly-once.txt");
  const replayRequestId = randomUUID();
  const replayData = new TextEncoder().encode(`printf X >> '${exactlyOncePath}'\r`);
  device.transport.unsubscribe();
  device.send("ptyInput", {
    requestId: replayRequestId,
    sessionId: running.sessionId,
    holderEpoch: originalEpoch,
    inputSeq: 2n,
    data: replayData,
  });
  await waitForFile(exactlyOncePath);
  device.closeTransport(true);

  await device.openRelay();
  const relayAttached = await device.attach(running.sessionId);
  assert.equal(relayAttached.holderEpoch, originalEpoch, "同 logical client 切到 relay 不触发 takeover");
  const replayFrom = device.mark();
  device.send("ptyInput", {
    requestId: replayRequestId,
    sessionId: running.sessionId,
    holderEpoch: relayAttached.holderEpoch,
    inputSeq: 2n,
    data: replayData,
  });
  await device.waitFor(
    (message) => message.case === "ptyInputAck" && message.appliedThroughSeq >= 2n,
    "relay cumulative input ack",
    10000,
    replayFrom,
  );
  assert.equal(readFileSync(exactlyOncePath, "utf8"), "X", "ACK 丢失后的 direct→relay 重投只产生一次外部副作用");

  const gapPath = join(running.repo.dir, "gap-must-not-run.txt");
  const gapRequestId = randomUUID();
  const gapFrom = device.mark();
  device.send("ptyInput", {
    requestId: gapRequestId,
    sessionId: running.sessionId,
    holderEpoch: relayAttached.holderEpoch,
    inputSeq: 4n,
    data: new TextEncoder().encode(`printf GAP > '${gapPath}'\r`),
  });
  const gapError = await device.waitFor(
    (message) => message.case === "error" && message.requestId === gapRequestId,
    "input sequence gap",
    10000,
    gapFrom,
  );
  assert.equal(gapError.code, "input_seq_gap");
  await sleep(100);
  assert.equal(existsSync(gapPath), false, "input gap 不得越级写入 PTY");

  const seq3From = device.mark();
  device.send("ptyInput", {
    requestId: randomUUID(),
    sessionId: running.sessionId,
    holderEpoch: relayAttached.holderEpoch,
    inputSeq: 3n,
    data: new TextEncoder().encode("echo RELAY_READY\r"),
  });
  await device.waitFor(
    (message) => message.case === "ptyInputAck" && message.appliedThroughSeq >= 3n,
    "relay seq3 ack",
    10000,
    seq3From,
  );

  // 回到 direct 后真实杀掉中心；现存 browser→loopback→sessiond 链路必须继续工作。
  await device.openDirect();
  const offlineAttached = await device.attach(running.sessionId);
  assert.equal(offlineAttached.holderEpoch, originalEpoch);
  await stack.stopServer();

  const offlineCatalog = await device.catalog();
  assert.ok(offlineCatalog.sessions.some((session) => session.sessionId === running.sessionId), "中心进程停止后 local catalog 仍可用");
  const reattached = await device.attach(running.sessionId, { cols: 91, rows: 31 });
  assert.equal(reattached.holderEpoch, originalEpoch, "中心离线重挂不改变 holder");

  const offlineFrom = device.mark();
  device.send("ptyInput", {
    requestId: randomUUID(),
    sessionId: running.sessionId,
    holderEpoch: reattached.holderEpoch,
    inputSeq: 4n,
    data: new TextEncoder().encode("echo SERVER_IS_GONE\r"),
  });
  await device.waitFor(
    () => outputSince(device, offlineFrom, running.sessionId).includes("SERVER_IS_GONE"),
    "offline PTY output",
    10000,
    offlineFrom,
  );
  await device.waitFor(
    (message) => message.case === "ptyInputAck" && message.appliedThroughSeq >= 4n,
    "offline input ack",
    10000,
    offlineFrom,
  );

  // 中心 socket 已死时制造持续大输出；完成文件是 PTY 子进程的外部事实，随后用新 snapshot
  // 读取尾部 marker，证明中心 queue/checkpoint 不会反压 sessiond 或 PTY reader。
  const outputDonePath = join(running.repo.dir, "large-output.done");
  const largeFrom = device.mark();
  device.send("ptyInput", {
    requestId: randomUUID(),
    sessionId: running.sessionId,
    holderEpoch: reattached.holderEpoch,
    inputSeq: 5n,
    data: new TextEncoder().encode(
      `node -e 'process.stdout.write("x".repeat(2*1024*1024)); console.log("LOCAL_LARGE_OUTPUT_DONE"); require("fs").writeFileSync("${outputDonePath}", "done")'\r`,
    ),
  });
  await waitForFile(outputDonePath, 10000);
  const afterLargeOutput = await device.attach(running.sessionId, { cols: 91, rows: 31 });
  assert.match(utf8(afterLargeOutput.ansiSnapshot), /LOCAL_LARGE_OUTPUT_DONE/, "断中心期间大输出完成且 snapshot 含完成 marker");
  await device.waitFor(
    (message) => message.case === "ptyInputAck" && message.appliedThroughSeq >= 5n,
    "large output input ack",
    10000,
    largeFrom,
  );

  device.send("ptyResize", {
    requestId: randomUUID(),
    sessionId: running.sessionId,
    holderEpoch: reattached.holderEpoch,
    resizeSeq: 1n,
    cols: 91,
    rows: 31,
  });
  const resizedCatalog = await device.catalog();
  const resized = resizedCatalog.sessions.find((session) => session.sessionId === running.sessionId);
  assert.deepEqual([resized?.cols, resized?.rows], [91, 31], "offline resize 由 sessiond 生效");

  const stopRequestId = randomUUID();
  const operationId = randomUUID();
  const stopFrom = device.mark();
  device.send("sessionStop", {
    requestId: stopRequestId,
    operationId,
    sessionId: running.sessionId,
    holderEpoch: reattached.holderEpoch,
  });
  const stopped = await device.waitFor(
    (message) => message.case === "operationAck" && message.requestId === stopRequestId,
    "offline stop ack",
    10000,
    stopFrom,
  );
  assert.equal(stopped.ok, true);
  await device.waitFor(
    (message) => message.case === "sessionExited" && message.sessionId === running.sessionId,
    "offline session exit",
    10000,
    stopFrom,
  );

  device.close();
});
