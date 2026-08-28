/**
 * server 连接代际、订阅窗口与 device 父锁的黑盒并发回归。
 *
 * 业务输入与断言只走真实 WebSocket 线协议；数据库直连通常只持锁制造确定性
 * TOCTOU 窗口。session 同 ID 换代用例会在该锁内原子替换 task 身份：公开协议的 sessionId
 * 由中心随机生成，无法精确构造重用；最终状态仍只从 fresh client snapshot 断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import {
  create,
  decodeServerToClient,
  decodeServerToDaemon,
  decodeDeviceEnvelope,
  DeviceEnvelopeSchema,
  DEVICE_PROTOCOL_VERSION,
  encodeDeviceEnvelope,
  TaskSchema,
  TaskStatus,
} from "@coflux/protocol";
import { startServer, tokenFromUrl } from "./harness.mjs";

const PORT = 8864;
const BASE_ENV = {
  COFLUX_AUTH: "local",
  COFLUX_USERNAME: "concurrency-user",
  COFLUX_PASSWORD: "concurrency-pass",
  COFLUX_BUILD_ID: "",
  COFLUX_BUILD_ID_FILE: "",
  COFLUX_ENROLL_RATE_LIMIT: "100",
  COFLUX_DAEMON_AUTH_RATE_LIMIT: "100",
  COFLUX_LOGIN_RATE_LIMIT: "100",
};

async function withServer(run) {
  const stack = await startServer({ port: PORT, env: BASE_ENV });
  try {
    return await run(stack);
  } finally {
    await stack.stop();
  }
}

async function authClient(stack, subscribe = true) {
  const client = stack.makeClient();
  await client.ready;
  client.send({ case: "clientAuth", username: BASE_ENV.COFLUX_USERNAME, password: BASE_ENV.COFLUX_PASSWORD });
  await client.waitFor((message) => message.case === "authOk", "client authOk");
  if (!subscribe) return { client };
  client.send({ case: "clientSubscribe" });
  const snapshot = await client.waitFor((message) => message.case === "stateSnapshot", "client snapshot");
  return { client, snapshot };
}

async function enrollDaemon(stack, authorizer, name = "concurrency-daemon") {
  const daemon = stack.rawDaemon();
  await daemon.ready;
  daemon.send({
    case: "daemonEnrollRequest",
    name,
    host: "concurrency-host",
    platform: "test",
    workerVersion: "old-worker",
    supervisorVersion: "test-supervisor",
    arch: "test-arch",
  });
  const pending = await daemon.waitFor((message) => message.case === "daemonAuthorizePending", "daemon authorize pending");
  authorizer.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
  await authorizer.waitFor((message) => message.case === "deviceAuthorized", "device authorized");
  const enrolled = await daemon.waitFor((message) => message.case === "daemonEnrolled", "daemon enrolled");
  return { daemon, ...enrolled };
}

async function createDirectoryWorkspace(client, daemonId, path) {
  client.send({ case: "terminalCreate", daemonId, path });
  const created = await client.waitFor(
    (message) => message.case === "workspaceCreated" && message.workspace.daemonId === daemonId && message.workspace.path === path,
    "directory workspace created",
  );
  await client.waitFor(
    (message) => message.case === "taskUpdated" && message.task.workspaceId === created.workspace.id,
    "directory task created",
  );
  return created.workspace;
}

async function prepareDeviceOperation(client, daemon, seen, payloadCase, trigger) {
  trigger();
  const installed = await daemon.waitFor((message) => {
    if (message.case !== "preparedDeviceOperation" || seen.has(message.operationId)) return false;
    return decodeDeviceEnvelope(message.frame)?.payload.case === payloadCase;
  }, `prepared install: ${payloadCase}`);
  seen.add(installed.operationId);
  daemon.send({ case: "preparedDeviceOperationInstalled", operationId: installed.operationId, ok: true });
  const prepared = await client.waitFor(
    (message) => message.case === "preparedDeviceOperation" && message.operationId === installed.operationId,
    `prepared client delivery: ${payloadCase}`,
  );
  const template = decodeDeviceEnvelope(prepared.frame);
  assert.ok(template && template.payload.case === payloadCase, `${payloadCase} 模板可独立解码`);
  return { prepared, template };
}

function resultFrame(caseName, value) {
  return encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    channelId: "",
    payload: { case: caseName, value },
  }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let hubClassPromise;

async function loadHubClass() {
  if (!hubClassPromise) {
    const previousDev = process.env.COFLUX_DEV;
    process.env.COFLUX_DEV = "1";
    hubClassPromise = import("../../apps/server/src/hub.ts")
      .then((module) => module.Hub)
      .finally(() => {
        if (previousDev === undefined) delete process.env.COFLUX_DEV;
        else process.env.COFLUX_DEV = previousDev;
      });
  }
  return await hubClassPromise;
}

function fakeWebSocket() {
  const sent = [];
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send(frame) {
      sent.push(new Uint8Array(frame));
    },
    close() {
      this.readyState = 3;
    },
  };
}

function decodedClientMessages(ws) {
  return ws.sent.flatMap((frame) => {
    const decoded = decodeServerToClient(frame);
    return decoded?.payload.case ? [decoded.payload] : [];
  });
}

function decodedDaemonMessages(ws) {
  return ws.sent.flatMap((frame) => {
    const decoded = decodeServerToDaemon(frame);
    return decoded?.payload.case ? [decoded.payload] : [];
  });
}

async function makeUnitHub(store, task) {
  const Hub = await loadHubClass();
  const hub = new Hub(store);
  const daemonWs = fakeWebSocket();
  const clientWs = fakeWebSocket();
  const daemon = {
    ws: daemonWs,
    accountId: task.accountId,
    arch: "test-arch",
    info: {
      daemonId: task.daemonId,
      name: "unit-daemon",
      host: "unit-host",
      platform: "test",
      online: true,
      workerVersion: "unit-worker",
      supervisorVersion: "unit-supervisor",
    },
  };
  const daemonConn = {
    ws: daemonWs,
    daemonId: task.daemonId,
    accountId: task.accountId,
    remoteAddress: "127.0.0.1",
  };
  const client = {
    ws: clientWs,
    accountId: task.accountId,
    subscribed: true,
    remoteAddress: "127.0.0.1",
  };
  hub.daemons.set(task.daemonId, daemon);
  if (task.sessionId) {
    hub.sessions.set(task.sessionId, {
      sessionId: task.sessionId,
      daemonId: task.daemonId,
      accountId: task.accountId,
      taskId: task.id,
    });
  }
  hub.clients.add(client);
  return { hub, daemon, daemonConn, daemonWs, client, clientWs };
}

async function assertLateTaskStartRejected(removalCase) {
  const task = create(TaskSchema, {
    id: `unit-late-start-${removalCase}-task`,
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: `unit-late-start-${removalCase}-workspace`,
    title: `unit late start ${removalCase}`,
    status: TaskStatus.IDLE,
    createdAt: 1,
    updatedAt: 1,
  });
  const workspace = {
    id: task.workspaceId,
    accountId: task.accountId,
    daemonId: task.daemonId,
    projectId: "",
    name: "unit directory",
    path: `/tmp/unit-late-start-${removalCase}`,
    branch: "",
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  const sweepEntered = deferred();
  const releaseSweep = deferred();
  let taskExists = true;
  let workspaceExists = true;
  let expiredTargets = 0;
  const store = {
    async getTask(id) {
      return taskExists && id === task.id ? task : undefined;
    },
    async getWorkspace(id) {
      return workspaceExists && id === workspace.id ? workspace : undefined;
    },
    async isProjectDeleting() {
      return false;
    },
    async expirePreparedOperations() {
      sweepEntered.resolve();
      await releaseSweep.promise;
      return 0;
    },
    async transaction(fn) {
      return await fn(this);
    },
    async claimActiveDevice() {
      return { id: task.daemonId };
    },
    async findActivePreparedOperation() {
      assert.fail("删除提交后的 admission 不得再查询/恢复 active session.create");
    },
    async countActivePreparedOperations() {
      assert.fail("删除提交后的 admission 不得进入 prepared 容量检查");
    },
    async createPreparedOperation() {
      assert.fail("删除提交后的 admission 不得创建 prepared row");
    },
    async expirePreparedOperationsByTarget(accountId, daemonId, kind, targetId) {
      assert.equal(accountId, task.accountId);
      assert.equal(daemonId, task.daemonId);
      assert.equal(kind, "session.create");
      assert.equal(targetId, task.id);
      expiredTargets += 1;
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeTask(id) {
      assert.equal(id, task.id);
      taskExists = false;
    },
    async removeTasksByWorkspace(id) {
      assert.equal(id, workspace.id);
      if (!taskExists) return [];
      taskExists = false;
      return [task.id];
    },
    async removeWorkspace(id) {
      assert.equal(id, workspace.id);
      workspaceExists = false;
    },
    async listWorkspacesByDaemon() {
      return workspaceExists ? [workspace] : [];
    },
    async listProjectsByDaemon() {
      return [];
    },
  };
  const { hub, daemonWs, client, clientWs } = await makeUnitHub(store, task);
  const startJob = hub.handleClientMessage(client, {
    payload: { case: "taskStart", value: { taskId: task.id, cols: 80, rows: 24 } },
  });
  await sweepEntered.promise;

  await hub.handleClientMessage(client, {
    payload: removalCase === "taskRemove"
      ? { case: "taskRemove", value: { taskId: task.id } }
      : { case: "workspaceRemove", value: { workspaceId: workspace.id } },
  });
  releaseSweep.resolve();
  await startJob;

  assert.equal(expiredTargets, 1, "删除事务按 target 终结既有 session.create（即使当前为空）");
  assert.equal(taskExists, false, "删除事实已经提交");
  assert.ok(
    decodedDaemonMessages(daemonWs).every((payload) => payload.case !== "preparedDeviceOperation"),
    "迟到 taskStart 不向 daemon 下发 orphan session.create",
  );
  const clientMessages = decodedClientMessages(clientWs);
  assert.ok(
    clientMessages.some((payload) => payload.case === "taskRemoved" && payload.value.taskId === task.id),
    "删除先对外广播 taskRemoved",
  );
  assert.ok(
    clientMessages.some((payload) => payload.case === "error" && payload.value.message.includes("已删除")),
    "迟到 start 收到明确 admission 拒绝",
  );
  hub.shutdown();
}

async function waitForBlockedTaskRead(sql, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ~* 'from[[:space:]]+tasks'
      ) AS blocked
    `;
    if (row?.blocked) return;
    await sleep(20);
  }
  assert.fail("旧 catalog 的 tasks 查询未进入受控锁等待");
}

async function waitForBlockedCommit(sql, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ~* '^[[:space:]]*commit[[:space:]]*$'
      ) AS blocked
    `;
    if (row?.blocked) return;
    await sleep(20);
  }
  assert.fail("旧 catalog 事务未在 COMMIT 阶段进入受控锁等待");
}

async function waitForBlockedPreparedQuery(sql, minimum = 1, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql`
      SELECT COUNT(*)::int AS blocked
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND (
          query ~* 'prepared_device_operations'
          OR query ~* 'from[[:space:]]+devices'
          OR query ~* '^[[:space:]]*commit[[:space:]]*$'
        )
    `;
    if (Number(row?.blocked ?? 0) >= minimum) return;
    await sleep(20);
  }
  assert.fail(`prepared operation 未出现 ${minimum} 条受控锁等待`);
}

async function waitForBlockedTaskUpdate(sql, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ~* 'update[[:space:]]+tasks'
      ) AS blocked
    `;
    if (row?.blocked) return;
    await sleep(20);
  }
  assert.fail(`${label} 的 task UPDATE 未进入受控锁等待`);
}

async function waitForCondition(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail(`timeout ${label}`);
}

async function startRawDaemonTask(client, daemon, task) {
  const seen = new Set();
  const { prepared, template } = await prepareDeviceOperation(
    client,
    daemon,
    seen,
    "sessionCreate",
    () => client.send({ case: "taskStart", taskId: task.id, cols: 80, rows: 24 }),
  );
  const sessionId = template.payload.value.sessionId;
  daemon.send({
    case: "deviceOperationReport",
    operationId: prepared.operationId,
    daemonId: task.daemonId,
    ok: true,
    taskId: task.id,
    sessionId,
    pid: 4242,
    resultFrame: resultFrame("operationAck", {
      requestId: "",
      operationId: prepared.operationId,
      ok: true,
      sessionId,
      pid: 4242,
    }),
  });
  const running = await client.waitFor(
    (message) => message.case === "taskUpdated" && message.task.id === task.id && message.task.status === TaskStatus.RUNNING,
    "raw daemon task running",
  );
  return running.task;
}

test("sessionExit 等锁时 taskRemove 先广播，旧 RETURNING 不得复活任务", async () => {
  const sessionId = "unit-direct-exit-session";
  const running = create(TaskSchema, {
    id: "unit-direct-exit-task",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-workspace",
    title: "unit direct exit",
    status: TaskStatus.RUNNING,
    sessionId,
    createdAt: 1,
    updatedAt: 1,
  });
  const exited = create(TaskSchema, {
    ...running,
    status: TaskStatus.EXITED,
    sessionId: undefined,
    exitCode: 7,
    updatedAt: 2,
  });
  const exitEntered = deferred();
  const releaseExit = deferred();
  let removed = false;
  const store = {
    async exitTaskIfSession() {
      exitEntered.resolve();
      return await releaseExit.promise;
    },
    async getTask(id) {
      return !removed && id === running.id ? running : undefined;
    },
    async transaction(fn) {
      return await fn(this);
    },
    async claimActiveDevice() {
      return { id: running.daemonId };
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeTask() {
      removed = true;
    },
  };
  const { hub, daemonConn, client, clientWs } = await makeUnitHub(store, running);

  const exitJob = hub.handleDaemonMessage(daemonConn, {
    payload: { case: "sessionExit", value: { sessionId, exitCode: 7 } },
  });
  await exitEntered.promise;
  await hub.handleClientMessage(client, {
    payload: { case: "taskRemove", value: { taskId: running.id } },
  });
  const removedMessages = decodedClientMessages(clientWs);
  const removedIndex = removedMessages.findIndex(
    (payload) => payload.case === "taskRemoved" && payload.value.taskId === running.id,
  );
  assert.ok(removedIndex >= 0, "taskRemove 在 exit 解锁前已广播 removed");

  releaseExit.resolve(exited);
  await exitJob;
  const finalMessages = decodedClientMessages(clientWs);
  assert.ok(
    finalMessages.slice(removedIndex + 1).every(
      (payload) => !(payload.case === "taskUpdated" && payload.value.task.id === running.id),
    ),
    "taskRemoved 之后没有旧 exit taskUpdated",
  );
  assert.equal(hub.sessions.has(sessionId), false, "taskRemove 在广播前摘除运行时映射");
});

test("catalog exit 提交后 taskRemove 先广播，旧 continuation 不得复活任务", async () => {
  const sessionId = "unit-catalog-exit-session";
  const running = create(TaskSchema, {
    id: "unit-catalog-exit-task",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-workspace",
    title: "unit catalog exit",
    status: TaskStatus.RUNNING,
    sessionId,
    createdAt: 1,
    updatedAt: 1,
  });
  let currentTask = running;
  let removed = false;
  let transactionCount = 0;
  const catalogCommitted = deferred();
  const releaseCatalogContinuation = deferred();
  const store = {
    async transaction(fn) {
      transactionCount += 1;
      const ordinal = transactionCount;
      const result = await fn(this);
      if (ordinal === 1) {
        catalogCommitted.resolve();
        await releaseCatalogContinuation.promise;
      }
      return result;
    },
    async claimActiveDevice() {
      return { id: running.daemonId };
    },
    async getTask(id) {
      return !removed && id === running.id ? currentTask : undefined;
    },
    async findLatestPreparedOperation() {
      return undefined;
    },
    async updateTask() {
      currentTask = create(TaskSchema, {
        ...running,
        status: TaskStatus.EXITED,
        sessionId: undefined,
        exitCode: 9,
        updatedAt: 2,
      });
      return currentTask;
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeTask() {
      removed = true;
    },
  };
  const { hub, daemon, daemonConn, client, clientWs } = await makeUnitHub(store, running);
  const requestId = "unit-catalog-exit-request";
  daemon.catalogRequest = { requestId, absenceCandidates: [] };
  const catalogJob = hub.handleDaemonMessage(daemonConn, {
    payload: {
      case: "sessionCatalog",
      value: {
        requestId,
        sessions: [],
        exits: [{
          eventId: "unit-catalog-exit-event",
          sessionId,
          taskId: running.id,
          exitCode: 9,
          finalOutputSeq: 0n,
          exitedAt: Date.now(),
        }],
        snapshotOwnerId: "unit-catalog-owner",
        snapshotEpoch: 1n,
        sessionOffset: 0,
        exitOffset: 0,
        nextSessionOffset: 0,
        nextExitOffset: 1,
        complete: true,
        reset: false,
      },
    },
  });
  await catalogCommitted.promise;
  await hub.handleClientMessage(client, {
    payload: { case: "taskRemove", value: { taskId: running.id } },
  });
  const removedMessages = decodedClientMessages(clientWs);
  const removedIndex = removedMessages.findIndex(
    (payload) => payload.case === "taskRemoved" && payload.value.taskId === running.id,
  );
  assert.ok(removedIndex >= 0, "catalog continuation 恢复前已广播 removed");

  releaseCatalogContinuation.resolve();
  await catalogJob;
  const finalMessages = decodedClientMessages(clientWs);
  assert.ok(
    finalMessages.slice(removedIndex + 1).every(
      (payload) => !(payload.case === "taskUpdated" && payload.value.task.id === running.id),
    ),
    "taskRemoved 之后没有 catalog 旧 taskUpdated",
  );
  assert.equal(hub.sessions.has(sessionId), false, "DB session_id 已清空时仍按 taskId 摘映射");
});

test("catalog live 提交后目录 workspaceRemove 批量删除，旧 continuation 不得复活任务", async () => {
  const sessionId = "unit-catalog-live-session";
  const idle = create(TaskSchema, {
    id: "unit-catalog-live-task",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-directory-workspace",
    title: "unit catalog live",
    status: TaskStatus.IDLE,
    sessionId,
    createdAt: 1,
    updatedAt: 1,
  });
  const running = create(TaskSchema, {
    ...idle,
    status: TaskStatus.RUNNING,
    updatedAt: 2,
  });
  const workspace = {
    id: idle.workspaceId,
    accountId: idle.accountId,
    daemonId: idle.daemonId,
    projectId: "",
    name: "unit directory",
    path: "/tmp/unit-catalog-live",
    branch: "",
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  let currentTask = idle;
  let removed = false;
  let transactionCount = 0;
  const catalogCommitted = deferred();
  const releaseCatalogContinuation = deferred();
  const store = {
    async transaction(fn) {
      transactionCount += 1;
      const ordinal = transactionCount;
      const result = await fn(this);
      if (ordinal === 1) {
        catalogCommitted.resolve();
        await releaseCatalogContinuation.promise;
      }
      return result;
    },
    async getTask(id) {
      return !removed && id === idle.id ? currentTask : undefined;
    },
    async runTaskIfSession() {
      currentTask = running;
      return running;
    },
    async getWorkspace(id) {
      return id === workspace.id && !removed ? workspace : undefined;
    },
    async claimActiveDevice() {
      return { id: idle.daemonId };
    },
    async removeTasksByWorkspace(id) {
      if (id !== workspace.id || removed) return [];
      removed = true;
      return [idle.id];
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeWorkspace() {},
    async listWorkspacesByDaemon() {
      return [];
    },
    async listProjectsByDaemon() {
      return [];
    },
  };
  const { hub, daemon, daemonConn, client, clientWs } = await makeUnitHub(store, idle);
  const requestId = "unit-catalog-live-request";
  daemon.catalogRequest = { requestId, absenceCandidates: [] };
  const catalogJob = hub.handleDaemonMessage(daemonConn, {
    payload: {
      case: "sessionCatalog",
      value: {
        requestId,
        sessions: [{
          sessionId,
          taskId: idle.id,
          pid: 4242,
          cwd: workspace.path,
          cols: 80,
          rows: 24,
          outputSeq: 0n,
          startedAt: Date.now(),
        }],
        exits: [],
        snapshotOwnerId: "unit-catalog-live-owner",
        snapshotEpoch: 1n,
        sessionOffset: 0,
        exitOffset: 0,
        nextSessionOffset: 1,
        nextExitOffset: 0,
        complete: true,
        reset: false,
      },
    },
  });
  await catalogCommitted.promise;
  await hub.handleClientMessage(client, {
    payload: { case: "workspaceRemove", value: { workspaceId: workspace.id } },
  });
  const removedMessages = decodedClientMessages(clientWs);
  const removedIndex = removedMessages.findIndex(
    (payload) => payload.case === "taskRemoved" && payload.value.taskId === idle.id,
  );
  assert.ok(removedIndex >= 0, "目录 workspaceRemove 在 catalog continuation 恢复前广播 removed");
  assert.equal(hub.sessions.has(sessionId), false, "批量删除在广播前按 task identity 摘 runtime");

  releaseCatalogContinuation.resolve();
  await catalogJob;
  const finalMessages = decodedClientMessages(clientWs);
  assert.ok(
    finalMessages.slice(removedIndex + 1).every(
      (payload) => !(payload.case === "taskUpdated" && payload.value.task.id === idle.id),
    ),
    "taskRemoved 之后没有 catalog live 旧 taskUpdated",
  );
  assert.equal(hub.sessions.has(sessionId), false, "旧 catalog live 不重建已删除 task 的 runtime");
});

test("taskCreate 提交后目录 workspaceRemove 批量删除，旧 create continuation 不得广播任务", async () => {
  const seed = create(TaskSchema, {
    id: "unit-task-create-seed",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-task-create-workspace",
    title: "unit seed",
    status: TaskStatus.RUNNING,
    sessionId: "unit-task-create-seed-session",
    createdAt: 1,
    updatedAt: 1,
  });
  const workspace = {
    id: seed.workspaceId,
    accountId: seed.accountId,
    daemonId: seed.daemonId,
    projectId: "",
    name: "unit directory",
    path: "/tmp/unit-task-create",
    branch: "",
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  let createdTask;
  let removed = false;
  let transactionCount = 0;
  const createCommitted = deferred();
  const releaseCreateContinuation = deferred();
  const store = {
    async transaction(fn) {
      transactionCount += 1;
      const ordinal = transactionCount;
      const result = await fn(this);
      if (ordinal === 1) {
        createCommitted.resolve();
        await releaseCreateContinuation.promise;
      }
      return result;
    },
    async getWorkspace(id) {
      return id === workspace.id && !removed ? workspace : undefined;
    },
    async claimActiveDevice() {
      return { id: seed.daemonId };
    },
    async createTask(task) {
      createdTask = task;
    },
    async removeTasksByWorkspace(id) {
      if (id !== workspace.id || removed) return [];
      removed = true;
      return [seed.id, createdTask.id];
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeWorkspace() {},
    async listWorkspacesByDaemon() {
      return [];
    },
    async listProjectsByDaemon() {
      return [];
    },
  };
  const { hub, client, clientWs } = await makeUnitHub(store, seed);
  const createJob = hub.handleClientMessage(client, {
    payload: { case: "taskCreate", value: { workspaceId: workspace.id, title: "unit created task" } },
  });
  await createCommitted.promise;
  assert.ok(createdTask, "taskCreate 已在受控事务中提交 task");

  await hub.handleClientMessage(client, {
    payload: { case: "workspaceRemove", value: { workspaceId: workspace.id } },
  });
  const removedMessages = decodedClientMessages(clientWs);
  const removedIndex = removedMessages.findIndex(
    (payload) => payload.case === "taskRemoved" && payload.value.taskId === createdTask.id,
  );
  assert.ok(removedIndex >= 0, "目录删除在 create continuation 恢复前广播新 task removed");

  releaseCreateContinuation.resolve();
  await createJob;
  const finalMessages = decodedClientMessages(clientWs);
  assert.ok(
    finalMessages.slice(removedIndex + 1).every(
      (payload) => !(payload.case === "taskUpdated" && payload.value.task.id === createdTask.id),
    ),
    "taskRemoved 之后没有旧 taskCreate taskUpdated",
  );
});

test("terminalCreate 复用目录 workspace 提交后被 workspaceRemove 删除，旧 continuation 不得广播", async () => {
  const seed = create(TaskSchema, {
    id: "unit-terminal-create-seed",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-terminal-create-workspace",
    title: "unit terminal seed",
    status: TaskStatus.RUNNING,
    sessionId: "unit-terminal-create-seed-session",
    createdAt: 1,
    updatedAt: 1,
  });
  const workspace = {
    id: seed.workspaceId,
    accountId: seed.accountId,
    daemonId: seed.daemonId,
    projectId: "",
    name: "unit directory",
    path: "/tmp/unit-terminal-create",
    branch: "",
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  let createdTask;
  let removed = false;
  let transactionCount = 0;
  const createCommitted = deferred();
  const releaseCreateContinuation = deferred();
  const store = {
    async transaction(fn) {
      transactionCount += 1;
      const ordinal = transactionCount;
      const result = await fn(this);
      if (ordinal === 1) {
        createCommitted.resolve();
        await releaseCreateContinuation.promise;
      }
      return result;
    },
    async claimActiveDevice() {
      return { id: seed.daemonId };
    },
    async listWorkspacesByDaemon() {
      return removed ? [] : [workspace];
    },
    async createTask(task) {
      createdTask = task;
    },
    async getWorkspace(id) {
      return id === workspace.id && !removed ? workspace : undefined;
    },
    async removeTasksByWorkspace(id) {
      if (id !== workspace.id || removed) return [];
      removed = true;
      return [seed.id, createdTask.id];
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeWorkspace() {},
    async listProjectsByDaemon() {
      return [];
    },
  };
  const { hub, client, clientWs } = await makeUnitHub(store, seed);
  const createJob = hub.handleClientMessage(client, {
    payload: {
      case: "terminalCreate",
      value: { daemonId: seed.daemonId, path: workspace.path },
    },
  });
  await createCommitted.promise;
  assert.ok(createdTask, "terminalCreate 已在既有目录 workspace 中提交 task");

  await hub.handleClientMessage(client, {
    payload: { case: "workspaceRemove", value: { workspaceId: workspace.id } },
  });
  const removedMessages = decodedClientMessages(clientWs);
  const taskRemovedIndex = removedMessages.findIndex(
    (payload) => payload.case === "taskRemoved" && payload.value.taskId === createdTask.id,
  );
  const workspaceRemovedIndex = removedMessages.findIndex(
    (payload) => payload.case === "workspaceRemoved" && payload.value.workspaceId === workspace.id,
  );
  assert.ok(taskRemovedIndex >= 0, "目录删除先广播新 task removed");
  assert.ok(workspaceRemovedIndex > taskRemovedIndex, "目录删除随后广播 workspace removed");

  releaseCreateContinuation.resolve();
  await createJob;
  const afterRemoval = decodedClientMessages(clientWs).slice(workspaceRemovedIndex + 1);
  assert.ok(
    afterRemoval.every(
      (payload) => !(payload.case === "taskUpdated" && payload.value.task.id === createdTask.id),
    ),
    "workspaceRemoved 之后没有旧 terminalCreate taskUpdated",
  );
  assert.ok(
    afterRemoval.every(
      (payload) => !(payload.case === "workspaceCreated" && payload.value.workspace.id === workspace.id),
    ),
    "workspaceRemoved 之后没有旧 terminalCreate workspaceCreated",
  );
});

test("agent terminalNew 提交后目录 workspaceRemove 批量删除，旧 continuation 不得建 runtime", async () => {
  const origin = create(TaskSchema, {
    id: "unit-agent-create-origin",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-agent-create-workspace",
    title: "unit agent origin",
    status: TaskStatus.RUNNING,
    sessionId: "unit-agent-create-origin-session",
    createdAt: 1,
    updatedAt: 1,
  });
  const workspace = {
    id: origin.workspaceId,
    accountId: origin.accountId,
    daemonId: origin.daemonId,
    projectId: "",
    name: "unit directory",
    path: "/tmp/unit-agent-create",
    branch: "",
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  let createdTask;
  let removed = false;
  let transactionCount = 0;
  const createCommitted = deferred();
  const releaseCreateContinuation = deferred();
  const store = {
    async transaction(fn) {
      transactionCount += 1;
      const ordinal = transactionCount;
      const result = await fn(this);
      if (ordinal === 1) {
        createCommitted.resolve();
        await releaseCreateContinuation.promise;
      }
      return result;
    },
    async getTaskBySession(sessionId) {
      return sessionId === origin.sessionId && !removed ? origin : undefined;
    },
    async getTask(id) {
      if (removed) return undefined;
      if (id === origin.id) return origin;
      if (id === createdTask?.id) return createdTask;
      return undefined;
    },
    async getWorkspace(id) {
      return id === workspace.id && !removed ? workspace : undefined;
    },
    async claimActiveDevice() {
      return { id: origin.daemonId };
    },
    async listTasksByWorkspace() {
      return createdTask ? [origin, createdTask] : [origin];
    },
    async createTask(task) {
      createdTask = task;
    },
    async removeTasksByWorkspace(id) {
      if (id !== workspace.id || removed) return [];
      removed = true;
      return [origin.id, createdTask.id];
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeWorkspace() {},
    async listWorkspacesByDaemon() {
      return [];
    },
    async listProjectsByDaemon() {
      return [];
    },
  };
  const { hub, daemonConn, client, clientWs } = await makeUnitHub(store, origin);
  const createJob = hub.handleDaemonMessage(daemonConn, {
    payload: {
      case: "agentControlRequest",
      value: {
        requestId: "unit-agent-create-request",
        sessionId: origin.sessionId,
        payload: {
          case: "terminalNew",
          value: { title: "unit agent child", shell: "/bin/sh" },
        },
      },
    },
  });
  await createCommitted.promise;
  assert.ok(createdTask?.sessionId, "agent terminalNew 已提交预绑定 session 的 task");

  await hub.handleClientMessage(client, {
    payload: { case: "workspaceRemove", value: { workspaceId: workspace.id } },
  });
  const removedMessages = decodedClientMessages(clientWs);
  const removedIndex = removedMessages.findIndex(
    (payload) => payload.case === "taskRemoved" && payload.value.taskId === createdTask.id,
  );
  assert.ok(removedIndex >= 0, "目录删除在 agent continuation 恢复前广播 child removed");

  releaseCreateContinuation.resolve();
  await createJob;
  const finalMessages = decodedClientMessages(clientWs);
  assert.ok(
    finalMessages.slice(removedIndex + 1).every(
      (payload) => !(payload.case === "taskUpdated" && payload.value.task.id === createdTask.id),
    ),
    "taskRemoved 之后没有旧 agent terminalNew taskUpdated",
  );
  assert.equal(hub.sessions.has(createdTask.sessionId), false, "旧 agent continuation 不安装 child runtime");
});

test("agent terminalNew 的 control WS 同步发送失败时补偿删除 task，不留下 runtime 或 taskUpdated", async () => {
  const origin = create(TaskSchema, {
    id: "unit-agent-send-failure-origin",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-agent-send-failure-workspace",
    title: "unit agent send failure origin",
    status: TaskStatus.RUNNING,
    sessionId: "unit-agent-send-failure-origin-session",
    createdAt: 1,
    updatedAt: 1,
  });
  const workspace = {
    id: origin.workspaceId,
    accountId: origin.accountId,
    daemonId: origin.daemonId,
    projectId: "",
    name: "unit directory",
    path: "/tmp/unit-agent-send-failure",
    branch: "",
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  let createdTask;
  let removedTask;
  const store = {
    async getTaskBySession(sessionId) {
      return sessionId === origin.sessionId ? origin : undefined;
    },
    async getTask(id) {
      if (id === origin.id) return origin;
      if (id === createdTask?.id && !removedTask) return createdTask;
      return undefined;
    },
    async getWorkspace(id) {
      return id === workspace.id ? workspace : undefined;
    },
    async transaction(fn) {
      return await fn(this);
    },
    async claimActiveDevice() {
      return { id: origin.daemonId };
    },
    async listTasksByWorkspace() {
      return createdTask ? [origin, createdTask] : [origin];
    },
    async createTask(task) {
      createdTask = task;
    },
    async removeIdleTaskIfSession(id, accountId, daemonId, sessionId) {
      if (
        createdTask &&
        !removedTask &&
        id === createdTask.id &&
        accountId === createdTask.accountId &&
        daemonId === createdTask.daemonId &&
        sessionId === createdTask.sessionId &&
        createdTask.status === TaskStatus.IDLE
      ) {
        removedTask = createdTask;
        return removedTask;
      }
      return undefined;
    },
  };
  const { hub, daemonConn, daemonWs, clientWs } = await makeUnitHub(store, origin);
  daemonWs.send = () => {
    throw new Error("unit synchronous send failure");
  };

  try {
    await hub.handleDaemonMessage(daemonConn, {
      payload: {
        case: "agentControlRequest",
        value: {
          requestId: "unit-agent-send-failure-request",
          sessionId: origin.sessionId,
          payload: {
            case: "terminalNew",
            value: { title: "unit doomed child", shell: "/bin/sh" },
          },
        },
      },
    });

    assert.ok(createdTask?.sessionId, "发送前已经持久化带 session 绑定的 idle task");
    assert.equal(removedTask?.id, createdTask.id, "同步发送失败后用完整 incarnation CAS 删除 task");
    assert.equal(hub.sessions.has(createdTask.sessionId), false, "发送失败不得安装 session runtime");
    const messages = decodedClientMessages(clientWs);
    assert.ok(
      messages.some((payload) => payload.case === "taskRemoved" && payload.value.taskId === createdTask.id),
      "补偿删除后广播 taskRemoved，覆盖并发 snapshot 窗口",
    );
    assert.ok(
      messages.every((payload) => !(payload.case === "taskUpdated" && payload.value.task.id === createdTask.id)),
      "发送失败的 task 从未对外广播 taskUpdated",
    );
  } finally {
    hub.shutdown();
  }
});

test("agent terminalNew 持 generation gate 到事务提交与 control 发送完成，replacement 才能接管", async () => {
  const origin = create(TaskSchema, {
    id: "unit-agent-generation-origin",
    accountId: "unit-account",
    daemonId: "unit-daemon",
    workspaceId: "unit-agent-generation-workspace",
    title: "unit agent generation origin",
    status: TaskStatus.RUNNING,
    sessionId: "unit-agent-generation-origin-session",
    createdAt: 1,
    updatedAt: 1,
  });
  const workspace = {
    id: origin.workspaceId,
    accountId: origin.accountId,
    daemonId: origin.daemonId,
    projectId: "",
    name: "unit directory",
    path: "/tmp/unit-agent-generation",
    branch: "",
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  const transactionCallbackFinished = deferred();
  const releaseCommit = deferred();
  let createdTask;
  const store = {
    async getTaskBySession(sessionId) {
      return sessionId === origin.sessionId ? origin : undefined;
    },
    async getTask(id) {
      if (id === origin.id) return origin;
      if (id === createdTask?.id) return createdTask;
      return undefined;
    },
    async getWorkspace(id) {
      return id === workspace.id ? workspace : undefined;
    },
    async transaction(fn) {
      const result = await fn(this);
      transactionCallbackFinished.resolve();
      await releaseCommit.promise;
      return result;
    },
    async claimActiveDevice() {
      return { id: origin.daemonId };
    },
    async listTasksByWorkspace() {
      return createdTask ? [origin, createdTask] : [origin];
    },
    async createTask(task) {
      createdTask = task;
    },
    async removeIdleTaskIfSession() {
      assert.fail("generation gate 内 current 不应失效并触发补偿删除");
    },
    async touchDevice() {},
    async listWorkspacesByDaemon() {
      return [workspace];
    },
    async listProjectsByDaemon() {
      return [];
    },
  };
  const { hub, daemon: oldDaemon, daemonConn, daemonWs } = await makeUnitHub(store, origin);
  // 本用例只验证 register 的 generation 临界区；其后的 durable restore/catalog 各有独立测试。
  hub.localControl.restoreDaemon = async () => {};
  hub.preparedOperations.restore = async () => {};
  hub.reconcileDeletingProjects = async () => {};
  hub.requestSessionCatalog = async () => {};

  const createJob = hub.handleDaemonMessage(daemonConn, {
    payload: {
      case: "agentControlRequest",
      value: {
        requestId: "unit-agent-generation-request",
        sessionId: origin.sessionId,
        payload: {
          case: "terminalNew",
          value: { title: "unit generation child", shell: "/bin/sh" },
        },
      },
    },
  });
  await transactionCallbackFinished.promise;
  assert.ok(createdTask?.sessionId, "terminalNew transaction callback 已建立 child task");

  const replacementWs = fakeWebSocket();
  const replacementConn = {
    ws: replacementWs,
    remoteAddress: "127.0.0.1",
  };
  let replacementFinished = false;
  const replacementJob = hub.registerDaemonConn(
    replacementConn,
    { ...oldDaemon.info, workerVersion: "unit-replacement-worker" },
    origin.accountId,
    "test-arch",
  ).then(() => {
    replacementFinished = true;
  });
  await sleep(0);

  assert.equal(replacementFinished, false, "旧事务 COMMIT 前 replacement 仍在 generation gate 外等待");
  assert.equal(hub.daemons.get(origin.daemonId), oldDaemon, "旧 generation 在提交前仍是 current");
  assert.equal(daemonWs.readyState, daemonWs.OPEN, "旧 generation 在提交前不会被 replacement 提前关闭");

  releaseCommit.resolve();
  await Promise.all([createJob, replacementJob]);
  const oldMessages = decodedDaemonMessages(daemonWs);
  assert.ok(
    oldMessages.some(
      (payload) => payload.case === "sessionCreate" && payload.value.sessionId === createdTask.sessionId,
    ),
    "先取得 gate 的旧请求在换代前完整发送 sessionCreate",
  );
  assert.ok(
    oldMessages.some(
      (payload) => payload.case === "agentControlResult" && payload.value.requestId === "unit-agent-generation-request",
    ),
    "旧请求在换代前完整回执 agent",
  );
  assert.equal(daemonWs.readyState, 3, "旧请求释放 gate 后 replacement 才关闭旧 socket");
  assert.equal(hub.daemons.get(origin.daemonId)?.ws, replacementWs, "replacement 最终成为 current generation");
  assert.equal(hub.sessions.has(createdTask.sessionId), true, "完整发送后 child runtime 正常安装");
  hub.shutdown();
});

test("taskStart 晚于 taskRemove admission 时拒绝，不创建或下发 orphan session.create", async () => {
  await assertLateTaskStartRejected("taskRemove");
});

test("taskStart 晚于目录 workspaceRemove admission 时拒绝，不创建或下发 orphan session.create", async () => {
  await assertLateTaskStartRejected("workspaceRemove");
});

test("taskStart 先提交时 taskRemove 同事务 expire prepared row，并取消 waiter/retry", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false, unref() {} };
    scheduled.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  let hub;
  try {
    const task = create(TaskSchema, {
      id: "unit-start-before-remove-task",
      accountId: "unit-account",
      daemonId: "unit-daemon",
      workspaceId: "unit-start-before-remove-workspace",
      title: "unit start before remove",
      status: TaskStatus.IDLE,
      createdAt: 1,
      updatedAt: 1,
    });
    const workspace = {
      id: task.workspaceId,
      accountId: task.accountId,
      daemonId: task.daemonId,
      projectId: "",
      name: "unit directory",
      path: "/tmp/unit-start-before-remove",
      branch: "",
      isMain: false,
      createdAt: 1,
      additions: 0,
      deletions: 0,
    };
    let taskExists = true;
    let operation;
    let retryReadCalls = 0;
    const store = {
      async getTask(id) {
        return taskExists && id === task.id ? task : undefined;
      },
      async getWorkspace(id) {
        return id === workspace.id ? workspace : undefined;
      },
      async isProjectDeleting() {
        return false;
      },
      async expirePreparedOperations() {
        return 0;
      },
      async transaction(fn) {
        return await fn(this);
      },
      async claimActiveDevice() {
        return { id: task.daemonId };
      },
      async findActivePreparedOperation(accountId, kind, targetId, now) {
        return operation &&
          operation.accountId === accountId &&
          operation.kind === kind &&
          operation.targetId === targetId &&
          !operation.completed &&
          operation.state !== "expired" &&
          operation.expiresAt > now
          ? operation
          : undefined;
      },
      async countActivePreparedOperations() {
        return operation && !operation.completed && operation.state !== "expired" ? 1 : 0;
      },
      async createPreparedOperation(candidate) {
        const now = Date.now();
        operation = {
          ...candidate,
          state: "pending_install",
          completed: false,
          installError: null,
          reportOk: null,
          reportTaskId: null,
          reportSessionId: null,
          reportPid: null,
          reportExitCode: null,
          reportError: null,
          resultFrame: null,
          createdAt: now,
          updatedAt: now,
        };
        return operation;
      },
      async expirePreparedOperationsByTarget(accountId, daemonId, kind, targetId, now) {
        if (
          operation &&
          operation.accountId === accountId &&
          operation.daemonId === daemonId &&
          operation.kind === kind &&
          operation.targetId === targetId &&
          !operation.completed &&
          operation.state !== "expired"
        ) {
          operation = { ...operation, state: "expired", updatedAt: now };
          return [operation.operationId];
        }
        return [];
      },
      async removeSessionCheckpointsByTask() {},
      async removeTask(id) {
        assert.equal(id, task.id);
        taskExists = false;
      },
      async getPreparedOperation() {
        retryReadCalls += 1;
        return operation;
      },
    };
    const unit = await makeUnitHub(store, task);
    hub = unit.hub;

    await hub.handleClientMessage(unit.client, {
      payload: { case: "taskStart", value: { taskId: task.id, cols: 80, rows: 24 } },
    });
    assert.equal(operation?.state, "pending_install", "start admission 先提交 active prepared row");
    assert.equal(
      decodedDaemonMessages(unit.daemonWs).filter((payload) => payload.case === "preparedDeviceOperation").length,
      1,
      "提交后向 daemon 下发一次安装帧",
    );
    assert.equal(scheduled.length, 2, "active operation 同时持有 waiter timeout 与 retry timer");

    await hub.handleClientMessage(unit.client, {
      payload: { case: "taskRemove", value: { taskId: task.id } },
    });
    assert.equal(taskExists, false, "task 删除已经提交");
    assert.equal(operation?.state, "expired", "删除事务原子终结 target 对应 active prepared row");
    assert.ok(scheduled.every((timer) => timer.cleared), "提交后的 cancelMany 同步清除 waiter/retry timer");
    const clientMessages = decodedClientMessages(unit.clientWs);
    assert.ok(
      clientMessages.some(
        (payload) => payload.case === "error" && payload.value.message.includes("session.create 已取消"),
      ),
      "等待安装的 client 收到明确取消结果",
    );
    assert.ok(
      clientMessages.some((payload) => payload.case === "taskRemoved" && payload.value.taskId === task.id),
      "取消运行时状态后广播 taskRemoved",
    );

    const retryTimer = scheduled.find((timer) => timer.delay === 1_000);
    assert.ok(retryTimer, "定位到 prepared retry timer");
    retryTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retryReadCalls, 0, "即使已清除 timer 的 callback 被排队，旧 retry 也不重读/复活 operation");
    assert.equal(
      decodedDaemonMessages(unit.daemonWs).filter((payload) => payload.case === "preparedDeviceOperation").length,
      1,
      "删除后不再重发 session.create",
    );
  } finally {
    hub?.shutdown();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("catalog 请求后新建的 session 不属于该快照的缺席收敛候选", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "catalog-frozen-candidates-daemon");
    const catalogRequest = await enrolled.daemon.waitFor(
      (message) => message.case === "sessionCatalogRequest",
      "catalog request before session create",
    );

    // request 已经发出后才建成 RUNNING：这条 session 不可能出现在该 request 对应的快照里，
    // 空 catalog 不能据此把它误判成已退出。
    const workspace = await createDirectoryWorkspace(owner, enrolled.daemonId, "/tmp/coflux-catalog-frozen-candidates");
    const idle = owner.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(idle, "拿到 request 后新建的任务");
    const running = await startRawDaemonTask(owner, enrolled.daemon, idle);
    assert.ok(running.sessionId, "request 后任务已绑定 session");

    enrolled.daemon.send({
      case: "sessionCatalog",
      requestId: catalogRequest.requestId,
      sessions: [],
      exits: [],
      snapshotOwnerId: "frozen-candidates-owner",
      snapshotEpoch: 1n,
      sessionOffset: 0,
      exitOffset: 0,
      nextSessionOffset: 0,
      nextExitOffset: 0,
      complete: true,
      reset: false,
    });
    // 同连接严格按 wire 顺序执行；回执即 catalog handler 已经完整结束。
    const barrierId = "catalog-frozen-candidates-barrier";
    enrolled.daemon.send({
      case: "agentControlRequest",
      requestId: barrierId,
      sessionId: running.sessionId,
      payload: { case: "terminalList", value: {} },
    });
    await enrolled.daemon.waitFor(
      (message) => message.case === "agentControlResult" && message.requestId === barrierId,
      "catalog frozen candidates barrier",
    );

    const { client: fresh, snapshot } = await authClient(stack);
    const stored = snapshot.tasks.find((task) => task.id === running.id);
    assert.ok(stored, "request 后新建的任务仍存在");
    assert.equal(stored.status, TaskStatus.RUNNING, "旧 catalog 不收敛 request 后的新 session");
    assert.equal(stored.sessionId, running.sessionId, "旧 catalog 不清空 request 后的新 session 绑定");
    fresh.close();
    owner.close();
    enrolled.daemon.close();
  });
});

test("catalog 同时含同 ID 新 live 与旧 tombstone 时保留新 task 映射和端口", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "catalog-same-id-incarnation-daemon");
    const catalogRequest = await enrolled.daemon.waitFor(
      (message) => message.case === "sessionCatalogRequest",
      "same-id incarnation catalog request",
    );
    const workspace = await createDirectoryWorkspace(
      owner,
      enrolled.daemonId,
      "/tmp/coflux-catalog-same-id-incarnation",
    );
    const oldTask = owner.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(oldTask, "拿到旧 incarnation task");
    const oldRunning = await startRawDaemonTask(owner, enrolled.daemon, oldTask);
    assert.ok(oldRunning.sessionId, "旧 incarnation 已建立 session");
    const reusedPort = 43210;
    enrolled.daemon.send({
      case: "portsUpdate",
      sessions: [{ sessionId: oldRunning.sessionId, ports: [reusedPort] }],
    });
    await owner.waitFor(
      (message) =>
        message.case === "portsUpdated" &&
        message.taskId === oldRunning.id &&
        message.ports.some((entry) => entry.port === reusedPort),
      "old incarnation owns reused port",
    );

    const newTitle = "catalog-same-id-new-task";
    owner.send({ case: "taskCreate", workspaceId: workspace.id, title: newTitle });
    const newCreated = await owner.waitFor(
      (message) => message.case === "taskUpdated" && message.task.title === newTitle,
      "same-id new task created",
    );
    const newTask = newCreated.task;
    const mutationDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    try {
      // 公开协议的 sessionId 由中心随机生成；在一笔事务中转移绑定，构造
      // supervisor catalog 合法表达的“同 ID 新 live + 旧 task tombstone”。旧 task 保留
      // 已完成 session.create metadata，tombstone 仍能按 prepared identity 幂等收敛。
      await mutationDb.begin(async (tx) => {
        await tx`
          UPDATE coflux.tasks
          SET status = 'exited', session_id = NULL, exit_code = 0, updated_at = ${Date.now()}
          WHERE id = ${oldRunning.id}
        `;
        await tx`
          UPDATE coflux.tasks
          SET status = 'running', session_id = ${oldRunning.sessionId}, exit_code = NULL,
              updated_at = ${Date.now()}
          WHERE id = ${newTask.id}
        `;
      });

      const eventId = "catalog-same-id-old-exit";
      enrolled.daemon.send({
        case: "sessionCatalog",
        requestId: catalogRequest.requestId,
        sessions: [{
          sessionId: oldRunning.sessionId,
          taskId: newTask.id,
          pid: 5252,
          cwd: workspace.path,
          cols: 80,
          rows: 24,
          outputSeq: 0n,
          startedAt: Date.now(),
        }],
        exits: [{
          eventId,
          sessionId: oldRunning.sessionId,
          taskId: oldRunning.id,
          exitCode: 0,
          finalOutputSeq: 0n,
          exitedAt: Date.now(),
        }],
        snapshotOwnerId: "catalog-same-id-owner",
        snapshotEpoch: 1n,
        sessionOffset: 0,
        exitOffset: 0,
        nextSessionOffset: 1,
        nextExitOffset: 1,
        complete: true,
        reset: false,
      });
      await enrolled.daemon.waitFor(
        (message) => message.case === "exitAck" && message.eventIds.includes(eventId),
        "same-id old tombstone ack",
      );
      const oldPortsCleared = await owner.waitFor(
        (message) =>
          message.case === "portsUpdated" &&
          message.taskId === oldRunning.id &&
          message.ports.length === 0,
        "old incarnation ports cleared",
      );
      assert.deepEqual(oldPortsCleared.ports, [], "换代先释放旧 task 的 route");

      enrolled.daemon.send({
        case: "portsUpdate",
        sessions: [{ sessionId: oldRunning.sessionId, ports: [reusedPort] }],
      });
      const ports = await owner.waitFor(
        (message) =>
          message.case === "portsUpdated" &&
          message.taskId === newTask.id &&
          message.ports.some((entry) => entry.port === reusedPort),
        "same-id new incarnation ports",
      );
      assert.ok(ports.ports.some((entry) => entry.port === reusedPort), "新 incarnation 重新建立同端口路由");

      const { client: fresh, snapshot } = await authClient(stack);
      const storedOld = snapshot.tasks.find((task) => task.id === oldRunning.id);
      const storedNew = snapshot.tasks.find((task) => task.id === newTask.id);
      assert.ok(storedOld && storedNew, "新旧 task 都保留业务记录");
      assert.equal(storedOld.status, TaskStatus.EXITED, "旧 tombstone 保持终态");
      assert.equal(storedNew.status, TaskStatus.RUNNING, "新 live 保持运行");
      assert.equal(storedNew.sessionId, oldRunning.sessionId, "同 ID 绑定属于新 task");
      fresh.close();
    } finally {
      await mutationDb.end({ timeout: 5 });
      owner.close();
      enrolled.daemon.close();
    }
  });
});

test("catalog 查询期间连接换代，旧快照不得覆盖 catalog 或做缺席 EXITED 收敛", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "catalog-generation-daemon");
    const workspace = await createDirectoryWorkspace(owner, enrolled.daemonId, "/tmp/coflux-catalog-generation");
    const idle = owner.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(idle, "拿到 catalog TOCTOU 的任务");
    const running = await startRawDaemonTask(owner, enrolled.daemon, idle);
    assert.ok(running.sessionId, "任务已绑定 session");

    // 让受测 catalog request 在 RUNNING 绑定存在后发出，确保该任务属于冻结的缺席候选。
    const catalogDaemon = stack.rawDaemon();
    await catalogDaemon.ready;
    catalogDaemon.send({
      case: "daemonAuth",
      deviceToken: enrolled.deviceToken,
      workerVersion: "catalog-generation-worker",
      supervisorVersion: "test-supervisor",
      arch: "test-arch",
    });
    const catalogAuthed = await catalogDaemon.waitFor((message) => message.case === "daemonAuthed", "catalog daemon authed");
    assert.equal(catalogAuthed.daemonId, enrolled.daemonId);
    const catalogRequest = await catalogDaemon.waitFor(
      (message) => message.case === "sessionCatalogRequest",
      "old daemon catalog request",
    );
    await enrolled.daemon.closedInfo;

    const replacement = stack.rawDaemon();
    await replacement.ready;
    const lockDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const inspectDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const locked = deferred();
    const release = deferred();
    let lockJob;
    try {
      lockJob = lockDb.begin(async (tx) => {
        await tx.unsafe("LOCK TABLE coflux.tasks IN ACCESS EXCLUSIVE MODE").execute();
        locked.resolve();
        await release.promise;
      });
      void lockJob.catch(locked.reject);
      await locked.promise;

      catalogDaemon.send({
        case: "sessionCatalog",
        requestId: catalogRequest.requestId,
        sessions: [{
          sessionId: "stale-catalog-session",
          taskId: "stale-catalog-task",
          pid: 41,
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          outputSeq: 0n,
          startedAt: Date.now(),
        }],
        exits: [],
        snapshotOwnerId: "stale-catalog-owner",
        snapshotEpoch: 1n,
        sessionOffset: 0,
        exitOffset: 0,
        nextSessionOffset: 1,
        nextExitOffset: 0,
        complete: true,
        reset: false,
      });
      await waitForBlockedTaskRead(inspectDb);

      replacement.send({
        case: "daemonAuth",
        deviceToken: enrolled.deviceToken,
        workerVersion: "replacement-worker",
        supervisorVersion: "test-supervisor",
        arch: "test-arch",
      });
      const authed = await replacement.waitFor((message) => message.case === "daemonAuthed", "replacement daemon authed");
      assert.equal(authed.daemonId, enrolled.daemonId);
      assert.deepEqual(
        await catalogDaemon.closedInfo,
        { code: 4002, reason: "replaced by new connection" },
        "旧 catalog 在途时完成连接换代",
      );
    } finally {
      release.resolve();
      try {
        await lockJob;
      } finally {
        await Promise.all([lockDb.end({ timeout: 5 }), inspectDb.end({ timeout: 5 })]);
      }
    }

    try {
      await replacement.waitFor(
        (message) => message.case === "sessionCatalogRequest",
        "replacement catalog request",
      );
      // 解锁后旧 getTask 必然返回；无代际守卫时它会继续把未出现在旧 catalog 的 running task
      // 收敛为 EXITED。fresh snapshot 只观察 wire 上的持久化结果。
      await sleep(500);
      const { client: fresh, snapshot } = await authClient(stack);
      const stored = snapshot.tasks.find((task) => task.id === idle.id);
      assert.ok(stored, "换代后任务仍存在");
      assert.equal(stored.status, TaskStatus.RUNNING, "旧 catalog 未做缺席 EXITED 收敛");
      assert.equal(stored.sessionId, running.sessionId, "旧 catalog 未清空 session 绑定");
      fresh.close();
    } finally {
      owner.close();
      catalogDaemon.close();
      replacement.close();
    }
  });
});

test("catalog COMMIT 与连接换代线性化，新 generation 不得越过旧事务提交", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "catalog-commit-generation-daemon");
    const workspace = await createDirectoryWorkspace(owner, enrolled.daemonId, "/tmp/coflux-catalog-commit-generation");
    const idle = owner.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(idle, "拿到 COMMIT gap 的任务");
    const running = await startRawDaemonTask(owner, enrolled.daemon, idle);
    assert.ok(running.sessionId, "COMMIT gap 任务已运行");

    // 初始连接的 catalog request 早于任务创建，候选集按设计为空。先换一次连接，让本次
    // request 在 RUNNING 绑定存在后发出，下面的空快照才会真实进入缺席 EXITED 事务。
    const catalogDaemon = stack.rawDaemon();
    await catalogDaemon.ready;
    catalogDaemon.send({
      case: "daemonAuth",
      deviceToken: enrolled.deviceToken,
      workerVersion: "commit-gap-catalog-worker",
      supervisorVersion: "test-supervisor",
      arch: "test-arch",
    });
    const catalogAuthed = await catalogDaemon.waitFor((message) => message.case === "daemonAuthed", "commit-gap catalog daemon auth");
    assert.equal(catalogAuthed.daemonId, enrolled.daemonId);
    const catalogRequest = await catalogDaemon.waitFor(
      (message) => message.case === "sessionCatalogRequest",
      "commit-gap old catalog request",
    );
    await enrolled.daemon.closedInfo;

    const replacement = stack.rawDaemon();
    await replacement.ready;
    const setupDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const blockerDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    let advisoryHeld = false;
    try {
      // constraint trigger 到事务 COMMIT 才执行；它等待测试连接持有的 advisory lock，精确打开
      // postgres.js callback 已返回、COMMIT 尚未完成的窗口。
      await setupDb.unsafe(`
        CREATE FUNCTION coflux.test_block_task_commit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(8864, 731);
          RETURN NEW;
        END
        $$
      `).execute();
      await setupDb.unsafe(`
        CREATE CONSTRAINT TRIGGER test_block_task_commit
        AFTER UPDATE ON coflux.tasks
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION coflux.test_block_task_commit()
      `).execute();
      await blockerDb.unsafe("SELECT pg_advisory_lock(8864, 731)").execute();
      advisoryHeld = true;

      catalogDaemon.send({
        case: "sessionCatalog",
        requestId: catalogRequest.requestId,
        sessions: [],
        exits: [],
        snapshotOwnerId: "commit-gap-owner",
        snapshotEpoch: 1n,
        sessionOffset: 0,
        exitOffset: 0,
        nextSessionOffset: 0,
        nextExitOffset: 0,
        complete: true,
        reset: false,
      });
      await waitForBlockedCommit(setupDb);

      replacement.send({
        case: "daemonAuth",
        deviceToken: enrolled.deviceToken,
        workerVersion: "commit-gap-replacement",
        supervisorVersion: "test-supervisor",
        arch: "test-arch",
      });
      await sleep(200);
      assert.equal(
        replacement.log.some((message) =>
          message.case === "daemonAuthed" || message.case === "sessionCatalogRequest"
        ),
        false,
        "旧 COMMIT 完成前 replacement 不能收到成功认证或成为 current generation",
      );
      const oldClosedEarly = await Promise.race([
        catalogDaemon.closedInfo.then(() => true),
        sleep(100).then(() => false),
      ]);
      assert.equal(oldClosedEarly, false, "旧连接在其事务线性化完成前不被替换");

      await blockerDb.unsafe("SELECT pg_advisory_unlock(8864, 731)").execute();
      advisoryHeld = false;
      const authed = await replacement.waitFor(
        (message) => message.case === "daemonAuthed",
        "commit-gap replacement auth after old commit",
      );
      assert.equal(authed.daemonId, enrolled.daemonId);
      await replacement.waitFor(
        (message) => message.case === "sessionCatalogRequest",
        "replacement catalog request after old commit",
      );
      assert.deepEqual(
        await catalogDaemon.closedInfo,
        { code: 4002, reason: "replaced by new connection" },
        "旧事务提交后 replacement 完成换代",
      );

      const { client: fresh, snapshot } = await authClient(stack);
      const stored = snapshot.tasks.find((task) => task.id === idle.id);
      assert.ok(stored, "COMMIT gap 任务仍存在");
      assert.equal(stored.status, TaskStatus.EXITED, "先取得 gate 的旧 catalog 在换代前完整提交");
      assert.equal(stored.sessionId, undefined, "旧提交与新 generation 之间没有可见顺序反转");
      fresh.close();
    } finally {
      if (advisoryHeld) {
        await blockerDb.unsafe("SELECT pg_advisory_unlock(8864, 731)").execute().catch(() => undefined);
      }
      await Promise.all([setupDb.end({ timeout: 5 }), blockerDb.end({ timeout: 5 })]);
      owner.close();
      catalogDaemon.close();
      replacement.close();
    }
  });
});

test("sessionExit 按收到事件时的 task 身份正常收敛", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "session-exit-normal-daemon");
    const workspace = await createDirectoryWorkspace(owner, enrolled.daemonId, "/tmp/coflux-session-exit-normal");
    const idle = owner.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(idle, "拿到正常 sessionExit 任务");
    const running = await startRawDaemonTask(owner, enrolled.daemon, idle);
    assert.ok(running.sessionId, "正常 sessionExit 前已建立运行时身份");

    try {
      enrolled.daemon.send({ case: "sessionExit", sessionId: running.sessionId, exitCode: 23 });
      const exited = await owner.waitFor(
        (message) =>
          message.case === "taskUpdated" &&
          message.task.id === running.id &&
          message.task.status === TaskStatus.EXITED &&
          message.task.exitCode === 23,
        "normal session exit",
      );
      assert.equal(exited.task.sessionId, undefined, "正常 exit 清空 session 绑定");

      const { client: fresh, snapshot } = await authClient(stack);
      const stored = snapshot.tasks.find((task) => task.id === running.id);
      assert.ok(stored, "正常 exit 任务仍在持久化快照");
      assert.equal(stored.status, TaskStatus.EXITED);
      assert.equal(stored.exitCode, 23);
      assert.equal(stored.sessionId, undefined);
      fresh.close();
    } finally {
      owner.close();
      enrolled.daemon.close();
    }
  });
});

test("迟到 sessionExit 与 daemon 换代线性化，不得按裸 sessionId 误杀新 task", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "session-exit-generation-daemon");
    const workspace = await createDirectoryWorkspace(
      owner,
      enrolled.daemonId,
      "/tmp/coflux-session-exit-generation",
    );
    const oldTask = owner.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(oldTask, "拿到旧 generation 的任务");
    const running = await startRawDaemonTask(owner, enrolled.daemon, oldTask);
    assert.ok(running.sessionId, "旧 generation 已建立 session 身份");

    const replacementTitle = "session-exit-replacement-task";
    owner.send({ case: "taskCreate", workspaceId: workspace.id, title: replacementTitle });
    const replacementCreated = await owner.waitFor(
      (message) => message.case === "taskUpdated" && message.task.title === replacementTitle,
      "replacement task created",
    );
    const replacementTask = replacementCreated.task;

    const replacement = stack.rawDaemon();
    await replacement.ready;
    const lockDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const inspectDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const locked = deferred();
    const swapRequested = deferred();
    const swapped = deferred();
    const release = deferred();
    let lockJob;
    try {
      // ACCESS EXCLUSIVE 让旧 exit UPDATE 在取得语句快照前等待。同一锁持有事务内
      // 删除旧 task、把已由公开 wire 创建的新 task 预绑到同一 sessionId，精确模拟
      // replacement resync 看到的新 incarnation。旧的按 session_id 批量 UPDATE 解锁后会命中新行。
      lockJob = lockDb.begin(async (tx) => {
        await tx.unsafe("LOCK TABLE coflux.tasks IN ACCESS EXCLUSIVE MODE").execute();
        locked.resolve();
        await swapRequested.promise;
        try {
          await tx`
            DELETE FROM coflux.tasks
            WHERE id = ${running.id} OR id = ${replacementTask.id}
          `;
          await tx`
            INSERT INTO coflux.tasks (
              id, account_id, daemon_id, project_id, workspace_id, title, status,
              session_id, exit_code, created_at, updated_at
            ) VALUES (
              ${replacementTask.id}, ${replacementTask.accountId}, ${replacementTask.daemonId},
              ${replacementTask.projectId || null}, ${replacementTask.workspaceId}, ${replacementTask.title},
              'running', ${running.sessionId}, NULL, ${replacementTask.createdAt}, ${Date.now()}
            )
          `;
          swapped.resolve();
          await release.promise;
        } catch (error) {
          swapped.reject(error);
          throw error;
        }
      });
      void lockJob.catch((error) => {
        locked.reject(error);
        swapped.reject(error);
      });
      await locked.promise;

      enrolled.daemon.send({ case: "sessionExit", sessionId: running.sessionId, exitCode: 41 });
      await waitForBlockedTaskUpdate(inspectDb, "sessionExit");

      replacement.send({
        case: "daemonAuth",
        deviceToken: enrolled.deviceToken,
        workerVersion: "session-exit-replacement-worker",
        supervisorVersion: "test-supervisor",
        arch: "test-arch",
      });
      await sleep(200);
      assert.equal(
        replacement.log.some((message) => message.case === "daemonAuthed"),
        false,
        "旧 exit 线性化前 replacement 不得提前收到成功认证",
      );

      swapRequested.resolve();
      await swapped.promise;
      await sleep(200);
      assert.equal(
        replacement.log.some((message) => message.case === "sessionCatalogRequest"),
        false,
        "旧 exit 的 DB CAS 完成前 replacement 不能进入 current generation",
      );
      const oldClosedEarly = await Promise.race([
        enrolled.daemon.closedInfo.then(() => true),
        sleep(100).then(() => false),
      ]);
      assert.equal(oldClosedEarly, false, "旧 exit 线性化前不关闭其连接");

      release.resolve();
      await lockJob;
      // 取一次强锁作 DB barrier：返回时上面早已排队的旧 UPDATE/autocommit 必定结束。
      await inspectDb.begin(async (tx) => {
        await tx.unsafe("LOCK TABLE coflux.tasks IN ACCESS EXCLUSIVE MODE").execute();
      });
      const authed = await replacement.waitFor(
        (message) => message.case === "daemonAuthed",
        "session exit replacement auth after old exit",
      );
      assert.equal(authed.daemonId, enrolled.daemonId);
      await replacement.waitFor(
        (message) => message.case === "sessionCatalogRequest",
        "replacement catalog request after old exit",
      );
      assert.deepEqual(
        await enrolled.daemon.closedInfo,
        { code: 4002, reason: "replaced by new connection" },
        "旧 exit 完成后 replacement 才接管",
      );

      replacement.send({
        case: "daemonResync",
        sessions: [{ sessionId: running.sessionId, taskId: replacementTask.id }],
        snapshotOwnerId: "session-exit-generation-owner",
        snapshotEpoch: 1n,
      });
      const barrierId = "session-exit-generation-barrier";
      replacement.send({
        case: "agentControlRequest",
        requestId: barrierId,
        sessionId: running.sessionId,
        payload: { case: "terminalList", value: {} },
      });
      await replacement.waitFor(
        (message) => message.case === "agentControlResult" && message.requestId === barrierId,
        "replacement resync barrier",
      );

      const { client: fresh, snapshot } = await authClient(stack);
      const stored = snapshot.tasks.find((task) => task.id === replacementTask.id);
      assert.ok(stored, "新 incarnation task 仍在持久化快照");
      assert.equal(stored.status, TaskStatus.RUNNING, "迟到旧 exit 没有退出新 task");
      assert.equal(stored.sessionId, running.sessionId, "新 task 保留同 ID session 绑定");
      assert.ok(!snapshot.tasks.some((task) => task.id === running.id), "被替换的旧 task 不在快照");
      fresh.close();
    } finally {
      swapRequested.resolve();
      release.resolve();
      try {
        await lockJob;
      } finally {
        await Promise.all([lockDb.end({ timeout: 5 }), inspectDb.end({ timeout: 5 })]);
        owner.close();
        enrolled.daemon.close();
        replacement.close();
      }
    }
  });
});

test("prepared installed ack 等待行锁时，replacement 不得越过 daemon generation gate", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "prepared-installed-generation-daemon");
    const operationPath = "/tmp/coflux-prepared-installed-generation";
    owner.send({
      case: "projectImport",
      daemonId: enrolled.daemonId,
      path: operationPath,
      name: "prepared-installed-generation",
    });
    const operation = await enrolled.daemon.waitFor((message) => {
      if (message.case !== "preparedDeviceOperation") return false;
      const template = decodeDeviceEnvelope(message.frame);
      return template?.payload.case === "projectValidate" && template.payload.value.path === operationPath;
    }, "prepared operation before installed lock");

    const replacement = stack.rawDaemon();
    await replacement.ready;
    const lockDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const inspectDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const locked = deferred();
    const release = deferred();
    let lockJob;
    try {
      lockJob = lockDb.begin(async (tx) => {
        await tx`
          SELECT operation_id
          FROM coflux.prepared_device_operations
          WHERE operation_id = ${operation.operationId}
          FOR UPDATE
        `;
        locked.resolve();
        await release.promise;
      });
      void lockJob.catch(locked.reject);
      await locked.promise;

      enrolled.daemon.send({
        case: "preparedDeviceOperationInstalled",
        operationId: operation.operationId,
        ok: true,
      });
      await waitForBlockedPreparedQuery(inspectDb);

      replacement.send({
        case: "daemonAuth",
        deviceToken: enrolled.deviceToken,
        workerVersion: "prepared-installed-replacement",
        supervisorVersion: "test-supervisor",
        arch: "test-arch",
      });
      await sleep(200);
      assert.equal(
        replacement.log.some((message) =>
          message.case === "daemonAuthed" ||
          message.case === "preparedDeviceOperation" ||
          message.case === "sessionCatalogRequest"
        ),
        false,
        "旧 installed ack 提交前 replacement 不能成功认证、restore prepared state 或请求 catalog",
      );
      const oldClosedEarly = await Promise.race([
        enrolled.daemon.closedInfo.then(() => true),
        sleep(100).then(() => false),
      ]);
      assert.equal(oldClosedEarly, false, "旧连接的 installed ack 线性化前不能被 replacement 关闭");

      release.resolve();
      await lockJob;
      await owner.waitFor(
        (message) => message.case === "preparedDeviceOperation" && message.operationId === operation.operationId,
        "installed operation delivered after row unlock",
      );
      const authed = await replacement.waitFor(
        (message) => message.case === "daemonAuthed",
        "prepared installed replacement auth after old ack",
      );
      assert.equal(authed.daemonId, enrolled.daemonId);
      await replacement.waitFor(
        (message) => message.case === "preparedDeviceOperation" && message.operationId === operation.operationId,
        "replacement restores installed operation after old ack",
      );
      assert.deepEqual(
        await enrolled.daemon.closedInfo,
        { code: 4002, reason: "replaced by new connection" },
        "旧 installed ack 完整提交后 replacement 才接管",
      );
    } finally {
      release.resolve();
      try {
        await lockJob;
      } finally {
        await Promise.all([lockDb.end({ timeout: 5 }), inspectDb.end({ timeout: 5 })]);
        owner.close();
        enrolled.daemon.close();
        replacement.close();
      }
    }
  });
});

test("prepared operation 的 daemon 上限在五连接并发 admission 下仍为硬上限", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "prepared-admission-limit-daemon");
    const baselinePrefix = "/tmp/coflux-prepared-admission-baseline-";
    const baselineIds = new Set();

    // 每条基线都走真实 client → server → daemon wire，并完成 installed ack：记录仍是 active，
    // 但不会留下 retry timer 刷 daemon log，也不会撞单连接入站队列上限。
    for (let index = 0; index < 127; index += 1) {
      const path = `${baselinePrefix}${index}`;
      owner.send({ case: "projectImport", daemonId: enrolled.daemonId, path, name: `baseline-${index}` });
      const operation = await enrolled.daemon.waitFor((message) => {
        if (message.case !== "preparedDeviceOperation" || baselineIds.has(message.operationId)) return false;
        const template = decodeDeviceEnvelope(message.frame);
        return template?.payload.case === "projectValidate" && template.payload.value.path === path;
      }, `prepared admission baseline ${index}`);
      baselineIds.add(operation.operationId);
      enrolled.daemon.send({
        case: "preparedDeviceOperationInstalled",
        operationId: operation.operationId,
        ok: true,
      });
      await owner.waitFor(
        (message) => message.case === "preparedDeviceOperation" && message.operationId === operation.operationId,
        `prepared admission baseline installed ${index}`,
      );
    }
    assert.equal(baselineIds.size, 127, "真实 wire 建成 127 条 active prepared operation 基线");

    const contenders = await Promise.all(Array.from({ length: 5 }, () => authClient(stack)));
    const lockDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const inspectDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const locked = deferred();
    const release = deferred();
    let lockJob;
    const contenderPrefix = "/tmp/coflux-prepared-admission-contender-";
    const daemonLogFrom = enrolled.daemon.log.length;
    try {
      lockJob = lockDb.begin(async (tx) => {
        await tx`
          SELECT id
          FROM coflux.devices
          WHERE id = ${enrolled.daemonId}
          FOR UPDATE
        `;
        locked.resolve();
        await release.promise;
      });
      void lockJob.catch(locked.reject);
      await locked.promise;

      for (let index = 0; index < contenders.length; index += 1) {
        contenders[index].client.send({
          case: "projectImport",
          daemonId: enrolled.daemonId,
          path: `${contenderPrefix}${index}`,
          name: `contender-${index}`,
        });
      }
      // 修复后五条 SELECT ... FOR UPDATE 等父锁；旧实现则在 deferred FK 的 COMMIT 等父锁。
      await waitForBlockedPreparedQuery(inspectDb, 5);
      assert.equal(
        enrolled.daemon.log.slice(daemonLogFrom).some((message) => message.case === "preparedDeviceOperation"),
        false,
        "父锁释放前不能向 daemon 投递 contender",
      );

      release.resolve();
      await lockJob;
      const contenderOperations = () => {
        const byId = new Map();
        for (const message of enrolled.daemon.log.slice(daemonLogFrom)) {
          if (message.case !== "preparedDeviceOperation") continue;
          const template = decodeDeviceEnvelope(message.frame);
          if (template?.payload.case !== "projectValidate") continue;
          if (!template.payload.value.path.startsWith(contenderPrefix)) continue;
          byId.set(message.operationId, message);
        }
        return byId;
      };
      const limitErrors = () => contenders.flatMap(({ client }) =>
        client.log.filter((message) => message.case === "error" && message.message.includes("prepared operation 已达上限"))
      );
      await waitForCondition(
        () => contenderOperations().size >= 1 && limitErrors().length >= 4,
        "prepared concurrent admission outcome",
      );
      await sleep(200);
      assert.equal(contenderOperations().size, 1, "127 条基线后五连接并发只准新增一条 operation");
      assert.equal(limitErrors().length, 4, "其余四条 contender 都收到确定的 daemon 上限错误");
    } finally {
      release.resolve();
      try {
        await lockJob;
      } finally {
        await Promise.all([lockDb.end({ timeout: 5 }), inspectDb.end({ timeout: 5 })]);
        for (const { client } of contenders) client.close();
        owner.close();
        enrolled.daemon.close();
      }
    }
  });
});

test("旧 daemon 被同设备新连接替换后，已排队状态上报不得落库", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner);
    const workspace = await createDirectoryWorkspace(owner, enrolled.daemonId, "/tmp/coflux-stale-daemon");

    // 先把 replacement WS 建好，避免握手建连耗时让旧连接的阻塞消息提前跑完。
    const replacement = stack.rawDaemon();
    await replacement.ready;

    // daemonResync 对每个未知 task 都会真实查库，给紧随其后的 workspaceDiff 制造稳定队列；
    // replacement 在另一条连接上认证并接管同一 daemonId，旧队列必须被丢弃/代际守卫拒绝。
    const slowResync = Array.from({ length: 1_000 }, (_, index) => ({
      sessionId: `stale-session-${index}`,
      taskId: `stale-task-${index}`,
    }));
    enrolled.daemon.send({ case: "daemonResync", sessions: slowResync });
    enrolled.daemon.send({ case: "workspaceDiff", workspaceId: workspace.id, additions: 777, deletions: 333 });
    replacement.send({
      case: "daemonAuth",
      deviceToken: enrolled.deviceToken,
      workerVersion: "new-worker",
      supervisorVersion: "test-supervisor",
      arch: "test-arch",
    });

    const authed = await replacement.waitFor((message) => message.case === "daemonAuthed", "replacement daemon authed");
    assert.equal(authed.daemonId, enrolled.daemonId);
    assert.deepEqual(
      await enrolled.daemon.closedInfo,
      { code: 4002, reason: "replaced by new connection" },
      "旧连接被明确替换",
    );

    // fresh snapshot 是持久化真相；若旧 workspaceDiff 在替换后仍执行，这里会看到 777/333。
    await sleep(250);
    const { client: fresh, snapshot } = await authClient(stack);
    const stored = snapshot.workspaces.find((candidate) => candidate.id === workspace.id);
    assert.ok(stored, "工作区仍存在");
    assert.equal(stored.additions, 0, "旧连接排队的 additions 未落库");
    assert.equal(stored.deletions, 0, "旧连接排队的 deletions 未落库");

    fresh.close();
    owner.close();
    replacement.close();
  });
});

test("subscribe 与跨连接任务创建并发时，快照先行且任务不永久丢失", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "subscribe-daemon");
    const workspace = await createDirectoryWorkspace(owner, enrolled.daemonId, "/tmp/coflux-subscribe-backlog");
    const creators = await Promise.all(Array.from({ length: 12 }, () => authClient(stack)));
    const { client: subscriber } = await authClient(stack, false);

    try {
      const from = subscriber.log.length;
      subscriber.send({ case: "clientSubscribe" });
      const titles = [];
      for (let index = 0; index < creators.length; index += 1) {
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const title = `subscribe-race-${index}-${repeat}`;
          titles.push(title);
          creators[index].client.send({ case: "taskCreate", workspaceId: workspace.id, title });
        }
      }

      const created = await Promise.all(titles.map((title) => owner.waitFor(
        (message) => message.case === "taskUpdated" && message.task.title === title,
        `task created: ${title}`,
      )));
      const snapshot = await subscriber.waitFor((message) => message.case === "stateSnapshot", "racing subscriber snapshot");
      const snapshotIndex = subscriber.log.slice(from).findIndex((message) => message === snapshot);
      assert.ok(snapshotIndex >= 0, "订阅窗口内收到快照");
      assert.ok(
        subscriber.log.slice(from, from + snapshotIndex).every((message) => message.case !== "taskUpdated"),
        "任何增量都不能抢在首个快照之前",
      );

      const snapshotTaskIds = new Set(snapshot.tasks.map((task) => task.id));
      for (const message of created) {
        if (snapshotTaskIds.has(message.task.id)) continue;
        await subscriber.waitFor(
          (candidate) => candidate.case === "taskUpdated" && candidate.task.id === message.task.id,
          `snapshot backlog replay: ${message.task.title}`,
        );
      }
      assert.equal(created.length, 24, "并发创建样本完整");
    } finally {
      subscriber.close();
      for (const { client } of creators) client.close();
      owner.close();
      enrolled.daemon.close();
    }
  });
});

test("删除设备与 browser 子项写入并发，最终快照不留 workspace/task orphan", async () => {
  await withServer(async (stack) => {
    const { client: observer } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, observer, "remove-race-daemon");
    const workspace = await createDirectoryWorkspace(observer, enrolled.daemonId, "/tmp/coflux-device-remove-race");
    const writers = await Promise.all(Array.from({ length: 10 }, () => authClient(stack)));
    const { client: remover } = await authClient(stack);

    try {
      // 前半批先撞父锁，删除请求紧随其后，后半批再从其它 WS 进入。无论事务获锁顺序如何，
      // 合法终态都只能是“先创建后全部删除”或“先撤销后创建失败”。
      for (const { client } of writers.slice(0, 5)) {
        client.send({ case: "taskCreate", workspaceId: workspace.id, title: "before-remove" });
        client.send({ case: "terminalCreate", daemonId: enrolled.daemonId, path: "/tmp/ignored-canonical-path" });
      }
      remover.send({ case: "clientRemoveDevice", daemonId: enrolled.daemonId });
      for (const { client } of writers.slice(5)) {
        client.send({ case: "taskCreate", workspaceId: workspace.id, title: "after-remove" });
        client.send({ case: "terminalCreate", daemonId: enrolled.daemonId, path: "/tmp/ignored-canonical-path" });
      }

      await observer.waitFor(
        (message) => message.case === "daemonRemoved" && message.daemonId === enrolled.daemonId,
        "daemon removed after concurrent writes",
      );
      assert.deepEqual(
        await enrolled.daemon.closedInfo,
        { code: 4003, reason: "device removed" },
        "设备删除关闭 daemon control WS",
      );

      await sleep(500);
      const { client: fresh, snapshot } = await authClient(stack);
      assert.ok(!snapshot.daemons.some((daemon) => daemon.daemonId === enrolled.daemonId), "已删除设备不在快照");
      assert.ok(!snapshot.workspaces.some((candidate) => candidate.daemonId === enrolled.daemonId), "没有 workspace orphan");
      assert.ok(!snapshot.tasks.some((task) => task.daemonId === enrolled.daemonId), "没有 task orphan");
      fresh.close();
    } finally {
      remover.close();
      for (const { client } of writers) client.close();
      observer.close();
      enrolled.daemon.close();
    }
  });
});

test("project.import report 与设备删除并发，撤销后不得落 project/workspace orphan", async () => {
  await withServer(async (stack) => {
    const { client: observer } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, observer, "prepared-remove-daemon");
    const { client: remover } = await authClient(stack);
    const seen = new Set();
    const reports = [];

    try {
      for (let index = 0; index < 8; index += 1) {
        const { prepared, template } = await prepareDeviceOperation(
          observer,
          enrolled.daemon,
          seen,
          "projectValidate",
          () => observer.send({
            case: "projectImport",
            daemonId: enrolled.daemonId,
            path: `/tmp/coflux-prepared-remove-${index}`,
            name: `prepared-remove-${index}`,
          }),
        );
        reports.push({
          case: "deviceOperationReport",
          operationId: prepared.operationId,
          daemonId: enrolled.daemonId,
          ok: true,
          resultFrame: resultFrame("projectValidated", {
            requestId: "",
            ok: true,
            repoPath: `/tmp/coflux-prepared-remove-${index}`,
            branch: "main",
            suggestedName: `prepared-remove-${index}`,
            operationId: template.payload.value.operationId,
            defaultBranch: "main",
          }),
        });
      }

      // 第一条 report 可先拿锁并落库，删除事务必须把它一起清掉；删除已经排队后到达的
      // report 则只能等待父锁后发现 revoked。两种获锁顺序最终都不能留下子项。
      enrolled.daemon.send(reports[0]);
      remover.send({ case: "clientRemoveDevice", daemonId: enrolled.daemonId });
      for (const report of reports.slice(1)) enrolled.daemon.send(report);

      await observer.waitFor(
        (message) => message.case === "daemonRemoved" && message.daemonId === enrolled.daemonId,
        "prepared report race daemon removed",
      );
      await enrolled.daemon.closedInfo;
      await sleep(500);

      const { client: fresh, snapshot } = await authClient(stack);
      assert.ok(!snapshot.projects.some((project) => project.daemonId === enrolled.daemonId), "没有 project orphan");
      assert.ok(!snapshot.workspaces.some((workspace) => workspace.daemonId === enrolled.daemonId), "没有 workspace orphan");
      assert.ok(!snapshot.tasks.some((task) => task.daemonId === enrolled.daemonId), "没有 task orphan");
      await sleep(200);
      assert.ok(
        !fresh.log.some(
          (message) => message.case === "preparedDeviceOperation" && message.daemonId === enrolled.daemonId,
        ),
        "永久撤销后新订阅不得收到旧 prepared operation",
      );
      fresh.close();
    } finally {
      remover.close();
      observer.close();
      enrolled.daemon.close();
    }
  });
});

test("catalog exit 与设备删除统一 generation gate→device→prepared/task 锁序，不得形成 40P01", async () => {
  await withServer(async (stack) => {
    const { client: owner } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, owner, "catalog-exit-remove-lock-order-daemon");
    const catalogRequest = await enrolled.daemon.waitFor(
      (message) => message.case === "sessionCatalogRequest",
      "catalog exit/remove catalog request",
    );
    const workspace = await createDirectoryWorkspace(
      owner,
      enrolled.daemonId,
      "/tmp/coflux-catalog-exit-remove-lock-order",
    );
    const task = owner.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(task, "拿到 catalog exit/remove 任务");
    const seen = new Set();
    const { prepared, template } = await prepareDeviceOperation(
      owner,
      enrolled.daemon,
      seen,
      "sessionCreate",
      () => owner.send({ case: "taskStart", taskId: task.id, cols: 80, rows: 24 }),
    );
    const sessionId = template.payload.value.sessionId;
    assert.ok(sessionId, "prepared session.create 提供 exit 身份");

    const { client: remover } = await authClient(stack);
    const setupDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    const blockerDb = postgres(stack.databaseUrl, { max: 1, ssl: "prefer" });
    let advisoryHeld = false;
    try {
      // AFTER ROW trigger 在 task 行已被 UPDATE 锁住后等待 advisory lock。catalog 持有
      // generation gate + device 父行；remove 必须先等 generation gate，连 device SELECT
      // 都不能提前进入，因而不会形成 task↔prepared 或 restore↔revoke 的反向等待。
      await setupDb.unsafe(`
        CREATE FUNCTION coflux.test_block_catalog_exit_task() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(8864, 732);
          RETURN NEW;
        END
        $$
      `).execute();
      await setupDb.unsafe(`
        CREATE TRIGGER test_block_catalog_exit_task
        AFTER UPDATE ON coflux.tasks
        FOR EACH ROW EXECUTE FUNCTION coflux.test_block_catalog_exit_task()
      `).execute();
      await blockerDb.unsafe("SELECT pg_advisory_lock(8864, 732)").execute();
      advisoryHeld = true;

      const eventId = "catalog-exit-remove-event";
      enrolled.daemon.send({
        case: "sessionCatalog",
        requestId: catalogRequest.requestId,
        sessions: [],
        exits: [{
          eventId,
          sessionId,
          taskId: task.id,
          exitCode: 0,
          finalOutputSeq: 0n,
          exitedAt: Date.now(),
        }],
        snapshotOwnerId: "catalog-exit-remove-owner",
        snapshotEpoch: 1n,
        sessionOffset: 0,
        exitOffset: 0,
        nextSessionOffset: 0,
        nextExitOffset: 1,
        complete: true,
        reset: false,
      });
      await waitForBlockedTaskUpdate(setupDb, "catalog exit");

      remover.send({ case: "clientRemoveDevice", daemonId: enrolled.daemonId });
      await sleep(200);
      const [removeWait] = await setupDb`
        SELECT COUNT(*)::int AS blocked
        FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ~* 'from[[:space:]]+devices'
      `;
      assert.equal(
        Number(removeWait?.blocked ?? 0),
        0,
        "catalog 持 generation gate 时 remove 不得先进入 device row 等待",
      );

      await blockerDb.unsafe("SELECT pg_advisory_unlock(8864, 732)").execute();
      advisoryHeld = false;
      const [ack] = await Promise.all([
        enrolled.daemon.waitFor(
          (message) => message.case === "exitAck" && message.eventIds.includes(eventId),
          "catalog exit ack after lock barrier",
        ),
        owner.waitFor(
          (message) => message.case === "daemonRemoved" && message.daemonId === enrolled.daemonId,
          "daemon removed after catalog exit lock barrier",
        ),
      ]);
      assert.ok(ack.eventIds.includes(eventId), "catalog exit 事务未被 deadlock victim 回滚");
      assert.deepEqual(
        await enrolled.daemon.closedInfo,
        { code: 4003, reason: "device removed" },
        "删除事务也完整提交并关闭 daemon",
      );

      const { client: fresh, snapshot } = await authClient(stack);
      assert.ok(!snapshot.tasks.some((candidate) => candidate.id === task.id), "删除后不留 task orphan");
      await sleep(100);
      assert.ok(
        !fresh.log.some(
          (message) => message.case === "preparedDeviceOperation" && message.operationId === prepared.operationId,
        ),
        "catalog 完成或设备撤销后不复活 prepared session.create",
      );
      fresh.close();
    } finally {
      if (advisoryHeld) {
        await blockerDb.unsafe("SELECT pg_advisory_unlock(8864, 732)").execute().catch(() => undefined);
      }
      await Promise.all([setupDb.end({ timeout: 5 }), blockerDb.end({ timeout: 5 })]);
      remover.close();
      owner.close();
      enrolled.daemon.close();
    }
  });
});

test("agent terminalNew 与设备删除并发，撤销后不得插回 task orphan", async () => {
  await withServer(async (stack) => {
    const { client: observer } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, observer, "agent-remove-daemon");
    const workspace = await createDirectoryWorkspace(observer, enrolled.daemonId, "/tmp/coflux-agent-remove");
    const idle = observer.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(idle, "拿到 agent 发起方 idle task");
    const seen = new Set();

    // 先用真实 prepared wire 把 origin task 收敛为 RUNNING，构造合法 agent session 身份。
    const { prepared, template } = await prepareDeviceOperation(
      observer,
      enrolled.daemon,
      seen,
      "sessionCreate",
      () => observer.send({ case: "taskStart", taskId: idle.id, cols: 80, rows: 24 }),
    );
    const sessionId = template.payload.value.sessionId;
    enrolled.daemon.send({
      case: "deviceOperationReport",
      operationId: prepared.operationId,
      daemonId: enrolled.daemonId,
      ok: true,
      taskId: idle.id,
      sessionId,
      pid: 4242,
      resultFrame: resultFrame("operationAck", {
        requestId: "",
        operationId: prepared.operationId,
        ok: true,
        sessionId,
        pid: 4242,
      }),
    });
    await observer.waitFor(
      (message) => message.case === "taskUpdated" && message.task.id === idle.id && message.task.status === TaskStatus.RUNNING,
      "origin task running",
    );

    const { client: remover } = await authClient(stack);
    try {
      const requests = Array.from({ length: 12 }, (_, index) => ({
        case: "agentControlRequest",
        requestId: `agent-remove-${index}`,
        sessionId,
        payload: {
          case: "terminalNew",
          value: { title: `agent-race-${index}`, shell: "/bin/sh" },
        },
      }));
      enrolled.daemon.send(requests[0]);
      remover.send({ case: "clientRemoveDevice", daemonId: enrolled.daemonId });
      for (const request of requests.slice(1)) enrolled.daemon.send(request);

      await observer.waitFor(
        (message) => message.case === "daemonRemoved" && message.daemonId === enrolled.daemonId,
        "agent terminal race daemon removed",
      );
      await enrolled.daemon.closedInfo;
      await sleep(500);

      const { client: fresh, snapshot } = await authClient(stack);
      assert.ok(!snapshot.workspaces.some((candidate) => candidate.daemonId === enrolled.daemonId), "origin workspace 已删除");
      assert.ok(!snapshot.tasks.some((task) => task.daemonId === enrolled.daemonId), "agent terminal 没有插回 task orphan");
      fresh.close();
    } finally {
      remover.close();
      observer.close();
      enrolled.daemon.close();
    }
  });
});

test("大 checkpoint 与设备删除并发，最终无 orphan 且删除广播后不复活", async () => {
  await withServer(async (stack) => {
    const { client: observer } = await authClient(stack);
    const enrolled = await enrollDaemon(stack, observer, "checkpoint-remove-daemon");
    const workspace = await createDirectoryWorkspace(observer, enrolled.daemonId, "/tmp/coflux-checkpoint-remove");
    const idle = observer.log.find(
      (message) => message.case === "taskUpdated" && message.task.workspaceId === workspace.id,
    )?.task;
    assert.ok(idle, "拿到 checkpoint 所属 idle task");

    // 用 prepared session.create 的真实 wire 结果建立 server 认可的 RUNNING session。
    const seen = new Set();
    const { prepared, template } = await prepareDeviceOperation(
      observer,
      enrolled.daemon,
      seen,
      "sessionCreate",
      () => observer.send({ case: "taskStart", taskId: idle.id, cols: 80, rows: 24 }),
    );
    const sessionId = template.payload.value.sessionId;
    enrolled.daemon.send({
      case: "deviceOperationReport",
      operationId: prepared.operationId,
      daemonId: enrolled.daemonId,
      ok: true,
      taskId: idle.id,
      sessionId,
      pid: 4343,
      resultFrame: resultFrame("operationAck", {
        requestId: "",
        operationId: prepared.operationId,
        ok: true,
        sessionId,
        pid: 4343,
      }),
    });
    await observer.waitFor(
      (message) => message.case === "taskUpdated" && message.task.id === idle.id && message.task.status === TaskStatus.RUNNING,
      "checkpoint task running",
    );

    const { client: remover } = await authClient(stack);
    try {
      const from = observer.log.length;
      // 512 KiB 恰为协议允许上限：旧实现会先单独查 task，再做一笔大 upsert；另一连接的
      // removeDevice 可稳定插进两者之间，删完后旧 upsert 会把 checkpoint 插回。新实现用
      // device 父锁把“重读 task + upsert”与删除事务串行，并在提交后用 effect guard 裁掉旧广播。
      enrolled.daemon.send({
        case: "sessionCheckpoint",
        sessionId,
        taskId: idle.id,
        snapshotSeq: 1n,
        ansiSnapshot: new Uint8Array(512 * 1024).fill(65),
        cols: 80,
        rows: 24,
        title: "checkpoint-remove-race",
        capturedAt: Date.now(),
      });
      remover.send({ case: "clientRemoveDevice", daemonId: enrolled.daemonId });

      const removed = await observer.waitFor(
        (message) => message.case === "daemonRemoved" && message.daemonId === enrolled.daemonId,
        "checkpoint race daemon removed",
      );
      await enrolled.daemon.closedInfo;
      await sleep(600);

      const racedMessages = observer.log.slice(from);
      const removedIndex = racedMessages.findIndex((message) => message === removed);
      assert.ok(removedIndex >= 0, "定位到设备删除广播");
      assert.ok(
        racedMessages.slice(removedIndex + 1).every(
          (message) => !(message.case === "sessionCheckpoint" && message.sessionId === sessionId),
        ),
        "daemonRemoved 之后不得再广播旧 checkpoint",
      );

      const { client: fresh, snapshot } = await authClient(stack);
      assert.ok(!snapshot.tasks.some((task) => task.daemonId === enrolled.daemonId), "删除后没有 task 真相");
      await sleep(250); // checkpoint 初始补发位于 stateSnapshot 之后，留出 WS 事件投递窗口。
      assert.ok(
        !fresh.log.some((message) => message.case === "sessionCheckpoint" && message.sessionId === sessionId),
        "fresh subscribe 不补发孤儿 checkpoint",
      );
      fresh.close();
    } finally {
      remover.close();
      observer.close();
      enrolled.daemon.close();
    }
  });
});
