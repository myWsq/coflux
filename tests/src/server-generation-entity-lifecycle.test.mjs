/**
 * daemon generation gate 的实体生命周期审计回归。
 *
 * 这些用例刻意把数据库操作建模为“事务已经提交，但 Promise continuation 尚未回到 Hub”：
 * 另一连接可在这个窗口完成删除并广播 removed。generation gate 只能串行 daemon WS 换代，
 * 不能代替 workspace/project/device 自身的退休 guard。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  create,
  decodeServerToClient,
  DeviceEnvelopeSchema,
  DEVICE_PROTOCOL_VERSION,
  encodeDeviceEnvelope,
} from "@coflux/protocol";

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

function resultFrame(caseName, value) {
  return encodeDeviceEnvelope(create(DeviceEnvelopeSchema, {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    channelId: "",
    payload: { case: caseName, value },
  }));
}

async function makeHub(store, { accountId = "audit-account", daemonId = "audit-daemon" } = {}) {
  const Hub = await loadHubClass();
  const hub = new Hub(store);
  const daemonWs = fakeWebSocket();
  const clientWs = fakeWebSocket();
  const daemon = {
    ws: daemonWs,
    accountId,
    arch: "audit-arch",
    info: {
      daemonId,
      name: "audit-daemon",
      host: "audit-host",
      platform: "test",
      online: true,
      workerVersion: "audit-worker",
      supervisorVersion: "audit-supervisor",
    },
  };
  const daemonConn = {
    ws: daemonWs,
    daemonId,
    accountId,
    remoteAddress: "127.0.0.1",
  };
  const client = {
    ws: clientWs,
    accountId,
    subscribed: true,
    remoteAddress: "127.0.0.1",
  };
  hub.daemons.set(daemonId, daemon);
  hub.clients.add(client);
  return { hub, daemon, daemonConn, daemonWs, client, clientWs };
}

function assertNoCreatedAfterRemoved(messages, removedCase, createdCase, entityId, idOf) {
  const removedIndex = messages.findIndex(
    (payload) => payload.case === removedCase && idOf(payload.value, removedCase) === entityId,
  );
  assert.ok(removedIndex >= 0, `${removedCase} 已先广播`);
  assert.equal(
    messages.slice(removedIndex + 1).some(
      (payload) => payload.case === createdCase && idOf(payload.value, createdCase) === entityId,
    ),
    false,
    `${removedCase} 后旧 DB continuation 不得再广播 ${createdCase}`,
  );
}

for (const scenario of [
  {
    name: "workspaceBranch",
    payload: { case: "workspaceBranch", value: { workspaceId: "audit-workspace", branch: "new-branch" } },
    updateMethod: "updateWorkspaceBranch",
    updated: { branch: "new-branch", name: "new-branch" },
  },
  {
    name: "workspaceDiff",
    payload: { case: "workspaceDiff", value: { workspaceId: "audit-workspace", additions: 7, deletions: 3 } },
    updateMethod: "updateWorkspaceDiff",
    updated: { additions: 7, deletions: 3 },
  },
]) {
  test(`${scenario.name} 已提交后 workspaceRemove 先广播，旧 RETURNING 不得复活 workspace`, async () => {
    const workspace = {
      id: "audit-workspace",
      accountId: "audit-account",
      daemonId: "audit-daemon",
      projectId: "",
      name: "~",
      path: "/tmp/audit-workspace",
      branch: "",
      isMain: false,
      createdAt: 1,
      additions: 0,
      deletions: 0,
    };
    const updateCommitted = deferred();
    const deliverReturning = deferred();
    let removed = false;
    const store = {
      async getWorkspace(id) {
        return !removed && id === workspace.id ? workspace : undefined;
      },
      async [scenario.updateMethod]() {
        // 模拟 UPDATE 已在 PostgreSQL 提交；仅延迟把 RETURNING 交回旧 handler。
        updateCommitted.resolve();
        await deliverReturning.promise;
        return { ...workspace, ...scenario.updated };
      },
      async transaction(fn) {
        return await fn(this);
      },
      async claimActiveDevice() {
        return { id: workspace.daemonId };
      },
      async removeTasksByWorkspace() {
        return [];
      },
      async removeWorkspace() {
        removed = true;
      },
      async listWorkspacesByDaemon() {
        return [];
      },
      async listProjectsByDaemon() {
        return [];
      },
    };
    const { hub, daemonConn, client, clientWs } = await makeHub(store);
    try {
      const updateJob = hub.handleDaemonMessage(daemonConn, { payload: scenario.payload });
      await updateCommitted.promise;

      await hub.handleClientMessage(client, {
        payload: { case: "workspaceRemove", value: { workspaceId: workspace.id } },
      });
      deliverReturning.resolve();
      await updateJob;

      assertNoCreatedAfterRemoved(
        decodedClientMessages(clientWs),
        "workspaceRemoved",
        "workspaceCreated",
        workspace.id,
        (value, messageCase) => messageCase === "workspaceRemoved" ? value.workspaceId : value.workspace.id,
      );
    } finally {
      deliverReturning.resolve();
      hub.shutdown();
    }
  });
}

test("workspaceDefaultBranch 已提交后 projectRemove 先广播，旧 RETURNING 不得复活 project", async () => {
  const project = {
    id: "audit-project",
    accountId: "audit-account",
    daemonId: "audit-daemon",
    name: "audit-project",
    repoPath: "/tmp/audit-project",
    defaultBranch: "main",
    deleting: false,
    createdAt: 1,
  };
  const workspace = {
    id: "audit-main-workspace",
    accountId: project.accountId,
    daemonId: project.daemonId,
    projectId: project.id,
    name: "main",
    path: project.repoPath,
    branch: "main",
    isMain: true,
    createdAt: 1,
    additions: 0,
    deletions: 0,
  };
  const updateCommitted = deferred();
  const deliverReturning = deferred();
  let removed = false;
  let deleting = false;
  const store = {
    async getWorkspace(id) {
      return !removed && id === workspace.id ? workspace : undefined;
    },
    async getProject(id) {
      return !removed && id === project.id ? { ...project, deleting } : undefined;
    },
    async updateProjectDefaultBranch() {
      updateCommitted.resolve();
      await deliverReturning.promise;
      return { ...project, defaultBranch: "trunk" };
    },
    async listWorkspacesByProject(id) {
      return !removed && id === project.id ? [workspace] : [];
    },
    async listTasksByWorkspace() {
      return [];
    },
    async markProjectDeleting() {
      deleting = true;
    },
    async transaction(fn) {
      return await fn(this);
    },
    async claimActiveDevice(id, accountId) {
      return id === project.daemonId && accountId === project.accountId ? { id } : undefined;
    },
    async claimDeletingProject(id) {
      return !removed && deleting && id === project.id ? { ...project, deleting: true } : undefined;
    },
    async removeTasksByWorkspace() {
      return [];
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeWorkspace() {},
    async removeProject() {
      removed = true;
    },
    async listWorkspacesByDaemon() {
      return [];
    },
    async listProjectsByDaemon() {
      return [];
    },
  };
  const { hub, daemonConn, client, clientWs } = await makeHub(store);
  try {
    const updateJob = hub.handleDaemonMessage(daemonConn, {
      payload: {
        case: "workspaceDefaultBranch",
        value: { workspaceId: workspace.id, defaultBranch: "trunk" },
      },
    });
    await updateCommitted.promise;

    await hub.handleClientMessage(client, {
      payload: { case: "projectRemove", value: { projectId: project.id } },
    });
    deliverReturning.resolve();
    await updateJob;

    assertNoCreatedAfterRemoved(
      decodedClientMessages(clientWs),
      "projectRemoved",
      "projectCreated",
      project.id,
      (value, messageCase) => messageCase === "projectRemoved" ? value.projectId : value.project.id,
    );
  } finally {
    deliverReturning.resolve();
    hub.shutdown();
  }
});

test("project.import report 已提交后 projectRemove 先广播，旧 effect 不得复活 project/workspace", async () => {
  const operationId = "audit-project-import-operation";
  const projectId = "audit-imported-project";
  const workspaceId = "audit-imported-workspace";
  const reportCommitted = deferred();
  const deliverReportCommit = deferred();
  let project;
  let workspace;
  let deleting = false;
  let reportTransaction = true;
  const operation = {
    operationId,
    accountId: "audit-account",
    daemonId: "audit-daemon",
    kind: "project.import",
    targetId: "audit-daemon:/tmp/audit-import",
    targetVersion: null,
    frame: new Uint8Array([1]),
    metadata: JSON.stringify({ projectId, workspaceId, explicitName: "audit import" }),
    expiresAt: Date.now() + 60_000,
    state: "installed",
    completed: false,
    installError: null,
    reportOk: null,
    reportTaskId: null,
    reportSessionId: null,
    reportPid: null,
    reportExitCode: null,
    reportError: null,
    resultFrame: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const store = {
    async getPreparedOperation(id) {
      return id === operationId ? operation : undefined;
    },
    async transaction(fn) {
      const result = await fn(this);
      if (reportTransaction) {
        reportTransaction = false;
        // converge 的 device/project/workspace/prepared 写入均已提交，只延迟 transaction Promise。
        reportCommitted.resolve();
        await deliverReportCommit.promise;
      }
      return result;
    },
    async claimActiveDevice(id, accountId) {
      return id === operation.daemonId && accountId === operation.accountId ? { id } : undefined;
    },
    async claimPreparedOperationReport(id, daemonId) {
      return id === operationId && daemonId === operation.daemonId ? operation : undefined;
    },
    async createProject(value) {
      project = value;
      return value;
    },
    async createWorkspace(value) {
      workspace = value;
      return value;
    },
    async finishPreparedOperation() {
      operation.completed = true;
      operation.state = "completed";
      return operation;
    },
    async getProject(id) {
      return project?.id === id ? { ...project, deleting } : undefined;
    },
    async listWorkspacesByProject(id) {
      return workspace?.projectId === id ? [workspace] : [];
    },
    async listTasksByWorkspace() {
      return [];
    },
    async markProjectDeleting() {
      deleting = true;
    },
    async claimDeletingProject(id) {
      return deleting && project?.id === id ? { ...project, deleting: true } : undefined;
    },
    async removeTasksByWorkspace() {
      return [];
    },
    async expirePreparedOperationsByTarget() {
      return [];
    },
    async removeSessionCheckpointsByTask() {},
    async removeWorkspace(id) {
      if (workspace?.id === id) workspace = undefined;
    },
    async removeProject(id) {
      if (project?.id === id) project = undefined;
    },
    async listWorkspacesByDaemon() {
      return workspace ? [workspace] : [];
    },
    async listProjectsByDaemon() {
      return project ? [project] : [];
    },
  };
  const { hub, daemonConn, client, clientWs } = await makeHub(store);
  try {
    const reportJob = hub.handleDaemonMessage(daemonConn, {
      payload: {
        case: "deviceOperationReport",
        value: {
          operationId,
          daemonId: operation.daemonId,
          ok: true,
          resultFrame: resultFrame("projectValidated", {
            requestId: "",
            operationId,
            ok: true,
            repoPath: "/tmp/audit-import",
            branch: "main",
            suggestedName: "audit import",
            defaultBranch: "main",
          }),
        },
      },
    });
    await reportCommitted.promise;

    await hub.handleClientMessage(client, {
      payload: { case: "projectRemove", value: { projectId } },
    });
    deliverReportCommit.resolve();
    await reportJob;

    const messages = decodedClientMessages(clientWs);
    assertNoCreatedAfterRemoved(
      messages,
      "projectRemoved",
      "projectCreated",
      projectId,
      (value, messageCase) => messageCase === "projectRemoved" ? value.projectId : value.project.id,
    );
    assertNoCreatedAfterRemoved(
      messages,
      "workspaceRemoved",
      "workspaceCreated",
      workspaceId,
      (value, messageCase) => messageCase === "workspaceRemoved" ? value.workspaceId : value.workspace.id,
    );
  } finally {
    deliverReportCommit.resolve();
    hub.shutdown();
  }
});

test("daemonAuth 读到旧 active 记录后设备已撤销，迟到 register 不得重新上线", async () => {
  const device = {
    id: "audit-daemon",
    accountId: "audit-account",
    name: "audit-daemon",
    host: "audit-host",
    platform: "test",
    tokenHash: "unused-by-fake-store",
    createdAt: 1,
    lastSeenAt: 1,
    revoked: false,
  };
  const authSnapshotCaptured = deferred();
  const deliverAuthSnapshot = deferred();
  let revoked = false;
  const store = {
    async getDeviceByTokenHash() {
      const snapshot = revoked ? undefined : { ...device };
      authSnapshotCaptured.resolve();
      await deliverAuthSnapshot.promise;
      return snapshot;
    },
    async transaction(fn) {
      return await fn(this);
    },
    async claimActiveDevice(id, accountId) {
      return !revoked && id === device.id && accountId === device.accountId ? { ...device } : undefined;
    },
    async listWorkspacesByDaemon() {
      return [];
    },
    async listProjectsByDaemon() {
      return [];
    },
    async revokeDevice() {
      revoked = true;
    },
    async expirePreparedOperationsByDaemon() {
      return [];
    },
    async removeSessionCheckpointsByDaemon() {},
    async removeTasksByDaemon() {
      return [];
    },
    async listLocalGrantsByDaemon() {
      return [];
    },
    async revokeLocalLeasesForDaemon() {},
    async touchDevice() {},
    async pruneLocalControlState() {},
    async expirePreparedOperations() {
      return 0;
    },
    async listInstallablePreparedOperations() {
      return [];
    },
    async listDeletingProjectsByDaemon() {
      return [];
    },
    async listRunningTasksByDaemon() {
      return [];
    },
  };
  const Hub = await loadHubClass();
  const hub = new Hub(store);
  const clientWs = fakeWebSocket();
  const client = {
    ws: clientWs,
    accountId: device.accountId,
    subscribed: true,
    remoteAddress: "127.0.0.1",
  };
  hub.clients.add(client);
  const daemonWs = fakeWebSocket();
  const daemonConn = {
    ws: daemonWs,
    daemonId: null,
    accountId: null,
    remoteAddress: "127.0.0.1",
  };
  try {
    const authJob = hub.handleDaemonMessage(daemonConn, {
      payload: {
        case: "daemonAuth",
        value: {
          deviceToken: "stale-but-once-valid-token",
          workerVersion: "audit-worker",
          supervisorVersion: "audit-supervisor",
          arch: "audit-arch",
        },
      },
    });
    await authSnapshotCaptured.promise;

    await hub.handleClientMessage(client, {
      payload: { case: "clientRemoveDevice", value: { daemonId: device.id } },
    });
    const removedMessages = decodedClientMessages(clientWs);
    assert.ok(
      removedMessages.some(
        (payload) => payload.case === "daemonRemoved" && payload.value.daemonId === device.id,
      ),
      "设备撤销已提交并广播 removed",
    );

    deliverAuthSnapshot.resolve();
    await authJob;

    assert.equal(hub.daemons.has(device.id), false, "撤销后迟到认证不得重新注册 current daemon");
    assertNoCreatedAfterRemoved(
      decodedClientMessages(clientWs),
      "daemonRemoved",
      "daemonUpdated",
      device.id,
      (value, messageCase) => messageCase === "daemonRemoved" ? value.daemonId : value.daemon.daemonId,
    );
  } finally {
    deliverAuthSnapshot.resolve();
    hub.shutdown();
  }
});

test("daemon register restore 与 remove revoke 共用完整 generation gate", async () => {
  const device = {
    id: "audit-daemon",
    accountId: "audit-account",
    name: "audit-daemon",
    host: "audit-host",
    platform: "test",
    tokenHash: "unused-by-fake-store",
    createdAt: 1,
    lastSeenAt: 1,
    revoked: false,
  };
  const restoreEntered = deferred();
  const releaseRestore = deferred();
  const order = [];
  let revoked = false;
  let durableRevokeCalls = 0;
  let localRevokeCalls = 0;
  const store = {
    async getDeviceByTokenHash() {
      return revoked ? undefined : { ...device };
    },
    async transaction(fn) {
      return await fn(this);
    },
    async claimActiveDevice(id, accountId) {
      return !revoked && id === device.id && accountId === device.accountId
        ? { ...device }
        : undefined;
    },
    async touchDevice() {},
    async listWorkspacesByDaemon() {
      return [];
    },
    async listProjectsByDaemon() {
      return [];
    },
    async revokeDevice() {
      durableRevokeCalls += 1;
      order.push("durable-revoke");
      revoked = true;
    },
    async expirePreparedOperationsByDaemon() {
      return [];
    },
    async removeSessionCheckpointsByDaemon() {},
    async removeTasksByDaemon() {
      return [];
    },
    async listDeletingProjectsByDaemon() {
      return [];
    },
    async listRunningTasksByDaemon() {
      return [];
    },
  };
  const Hub = await loadHubClass();
  const hub = new Hub(store);
  hub.localControl = {
    async restoreDaemon() {
      order.push("restore-start");
      restoreEntered.resolve();
      await releaseRestore.promise;
      order.push("restore-end");
    },
    async revokeDevice() {
      localRevokeCalls += 1;
      order.push("local-revoke");
    },
    shutdown() {},
  };
  hub.preparedOperations = {
    async restore() {},
    cancelDaemon() {},
    shutdown() {},
  };
  const clientWs = fakeWebSocket();
  const client = {
    ws: clientWs,
    accountId: device.accountId,
    subscribed: true,
    remoteAddress: "127.0.0.1",
  };
  hub.clients.add(client);
  const daemonWs = fakeWebSocket();
  const daemonConn = {
    ws: daemonWs,
    daemonId: null,
    accountId: null,
    remoteAddress: "127.0.0.1",
  };
  try {
    const authJob = hub.handleDaemonMessage(daemonConn, {
      payload: {
        case: "daemonAuth",
        value: {
          deviceToken: "once-valid-token",
          workerVersion: "audit-worker",
          supervisorVersion: "audit-supervisor",
          arch: "audit-arch",
        },
      },
    });
    await restoreEntered.promise;

    const removeJob = hub.handleClientMessage(client, {
      payload: { case: "clientRemoveDevice", value: { daemonId: device.id } },
    });
    // 给 remove handler 足够的 microtask/macrotask 机会。若 remove 的事务或 local revoke
    // 仍在 generation gate 外，它们会在被阻塞的 restore 结束前确定性进入。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(durableRevokeCalls, 0, "restore 持 gate 时 remove 事务不得提前进入");
    assert.equal(localRevokeCalls, 0, "restore 持 gate 时 local revoke 不得并发进入");

    releaseRestore.resolve();
    await Promise.all([authJob, removeJob]);

    assert.deepEqual(
      order,
      ["restore-start", "restore-end", "durable-revoke", "local-revoke"],
      "注册 restore 必须完整先于撤销，不能交错覆盖 grant 状态",
    );
    assert.equal(hub.daemons.has(device.id), false);
  } finally {
    releaseRestore.resolve();
    hub.shutdown();
  }
});
