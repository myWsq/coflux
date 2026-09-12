import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, rawDaemon } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8876;
let stack;
let repo;
before(async () => { stack = await startStack({ port: PORT }); repo = mkRepo(); });
after(async () => { await stack?.stop(); repo?.cleanup(); });
let request = 0;
async function page(client, beforeSequence = 0) {
  const requestId = `page-${++request}`;
  client.send({ case: "notificationList", requestId, beforeSequence });
  return client.waitFor((m) => m.case === "notificationPage" && m.requestId === requestId, "notification page");
}
async function notify(daemon, sessionId, notificationId, message = "Please review") {
  const requestId = `send-${++request}`;
  daemon.send({ case: "agentControlRequest", requestId, sessionId, payload: { case: "notify", value: { notificationId, message } } });
  return daemon.waitFor((m) => m.case === "agentControlResult" && m.requestId === requestId, "durable send ack");
}

test("durable ACK, idempotent retry, bounded history, read sync, restart and deletion", async () => {
  const device = await openRelayDevice(stack);
  let client = device.control;
  client.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const created = await client.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "workspace");
  client.send({ case: "taskCreate", workspaceId: created.workspace.id, title: "Inbox source" });
  const idle = await client.waitFor((m) => m.case === "taskUpdated" && m.task.title === "Inbox source", "task");
  client.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  const running = await client.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");
  const credentials = JSON.parse(readFileSync(join(stack.home, "credentials.json"), "utf8"));
  device.closeTransport();
  await stack.stopDaemon();
  let daemon = rawDaemon(PORT);
  await daemon.ready;
  daemon.send({ case: "daemonAuth", deviceToken: credentials.deviceToken, workerVersion: "notification-test", supervisorVersion: "test", arch: "test" });
  await daemon.waitFor((m) => m.case === "daemonAuthed", "daemon auth");
  const peer = stack.makeClient();
  await peer.authSubscribe();
  try {
    const first = await notify(daemon, running.task.sessionId, "retry-key");
    assert.equal(first.ok, true, first.error);
    const firstId = first.payload.value.notificationId;
    const retry = await notify(daemon, running.task.sessionId, "retry-key");
    assert.equal(retry.payload.value.notificationId, firstId);
    assert.equal((await page(client)).notifications.length, 1);
    assert.equal((await notify(daemon, running.task.sessionId, "retry-key", "Different content")).ok, false);
    assert.equal((await notify(daemon, "foreign-session", "spoof")).ok, false);
    for (let index = 0; index < 52; index++) assert.equal((await notify(daemon, running.task.sessionId, `history-${index}`)).ok, true);
    const newest = await page(client);
    assert.equal(newest.notifications.length, 50);
    assert.equal(newest.unreadCount, 53);
    assert.ok(newest.nextBeforeSequence > 0);
    const older = await page(client, newest.nextBeforeSequence);
    assert.equal(older.notifications.length, 3);
    assert.equal(older.nextBeforeSequence, 0);
    assert.equal(new Set([...newest.notifications, ...older.notifications].map((item) => item.id)).size, 53);
    await notify(daemon, running.task.sessionId, "after-cutoff");
    client.send({ case: "notificationRead", requestId: "read-all", throughSequence: newest.latestSequence });
    const read = await peer.waitFor((m) => m.case === "notificationChanged" && m.requestId === "read-all", "read sync");
    assert.equal(read.unreadCount, 1);
    const afterRead = await page(peer);
    assert.equal(afterRead.notifications[0].readAt, 0);
    assert.ok(afterRead.notifications.slice(1).every((item) => item.readAt > 0));
    client.send({ case: "notificationRead", requestId: "read-latest", id: afterRead.notifications[0].id });
    await peer.waitFor((m) => m.case === "notificationChanged" && m.requestId === "read-latest" && m.unreadCount === 0, "single read sync");
    daemon.close(); peer.close(); device.close();
    await stack.restartServer();
    client = stack.makeClient();
    await client.authSubscribe();
    const initial = await client.waitFor((m) => m.case === "notificationPage" && m.requestId === "initial", "restarted inbox");
    assert.equal(initial.unreadCount, 0);
    assert.equal(initial.notifications.length, 50);
    assert.ok(!client.log.some((m) => m.case === "notificationChanged" && m.created));
    client.send({ case: "clientRemoveDevice", daemonId: stack.daemonId });
    await client.waitFor((m) => m.case === "daemonRemoved" && m.daemonId === stack.daemonId, "remove source device");
    const retained = await page(client);
    assert.equal(retained.notifications.length, 50);
    assert.equal(retained.notifications[0].terminalTitle, "Inbox source");
    assert.equal(retained.notifications[0].workspaceId, created.workspace.id);
  } finally { daemon.close(); peer.close(); client.close(); device.close(); }
});
