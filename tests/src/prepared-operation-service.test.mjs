/** prepared operation 易失状态协调器的生命周期单测。 */
import { test } from "node:test";
import assert from "node:assert/strict";

// service 会读取 server config；单测显式使用开发配置，避免依赖调用机器上的生产秘密。
process.env.COFLUX_DEV = "1";
const { createPreparedOperationService } = await import("../../apps/server/src/prepared-operation.service.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("shutdown 后才完成的 prepare 不得重新注册 waiter、retry 或发送 wire", async () => {
  const enteredTransaction = deferred();
  const releaseTransaction = deferred();
  const now = Date.now();
  const record = {
    operationId: "prepared-shutdown-inflight",
    accountId: "account-shutdown",
    daemonId: "daemon-shutdown",
    kind: "project.import",
    targetId: "daemon-shutdown:/tmp/project",
    targetVersion: null,
    frame: new Uint8Array([1, 2, 3]),
    metadata: "{}",
    expiresAt: now + 60_000,
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
  const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
  const daemonSends = [];
  const clientSends = [];
  const store = {
    expirePreparedOperations: async () => undefined,
    transaction: async () => {
      enteredTransaction.resolve();
      await releaseTransaction.promise;
      return { case: "created", operation: record };
    },
  };
  const service = createPreparedOperationService(store, {
    getDaemon: () => daemon,
    isCurrentDaemon: (candidate) => candidate === daemon,
    sendDaemon: (_candidate, payload) => {
      daemonSends.push(payload);
      return true;
    },
    sendClient: (_client, payload, initialSnapshot) => {
      clientSends.push({ payload, initialSnapshot });
      return true;
    },
    validControlId: () => true,
  });

  const prepare = service.prepare({ id: "client-shutdown" }, {
    operationId: record.operationId,
    accountId: record.accountId,
    daemonId: record.daemonId,
    kind: record.kind,
    targetId: record.targetId,
    targetVersion: null,
    frame: record.frame,
    metadata: record.metadata,
    expiresAt: record.expiresAt,
  });
  await enteredTransaction.promise;
  service.shutdown();
  releaseTransaction.resolve();
  await prepare;

  assert.deepEqual(daemonSends, [], "in-flight prepare 不在 shutdown 后重新 dispatch 或创建 retry");
  assert.deepEqual(clientSends, [], "in-flight prepare 不在 shutdown 后重新注册 waiter 或发送结果");
});

test("complete 后才恢复的 resume admission 不得用旧记录重新 watch 或 dispatch", async () => {
  const enteredTransaction = deferred();
  const releaseTransaction = deferred();
  const now = Date.now();
  const record = {
    operationId: "prepared-complete-stale-resume",
    accountId: "account-stale-resume",
    daemonId: "daemon-stale-resume",
    kind: "project.import",
    targetId: "daemon-stale-resume:/tmp/project",
    targetVersion: null,
    frame: new Uint8Array([1, 2, 3]),
    metadata: "{}",
    expiresAt: now + 60_000,
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
  const completedRecord = { ...record, completed: true };
  const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
  const daemonSends = [];
  const clientSends = [];
  let getCalls = 0;
  const store = {
    expirePreparedOperations: async () => undefined,
    transaction: () => {
      enteredTransaction.resolve();
      return releaseTransaction.promise;
    },
    getPreparedOperation: async () => {
      getCalls += 1;
      return completedRecord;
    },
  };
  const service = createPreparedOperationService(store, {
    getDaemon: () => daemon,
    isCurrentDaemon: (candidate) => candidate === daemon,
    sendDaemon: (_candidate, payload) => {
      daemonSends.push(payload);
      return true;
    },
    sendClient: (_client, payload, initialSnapshot) => {
      clientSends.push({ payload, initialSnapshot });
      return true;
    },
    validControlId: () => true,
  });

  try {
    service.dispatch(record);
    const prepare = service.prepare({ id: "client-stale-resume" }, {
      operationId: "prepared-second-request",
      accountId: record.accountId,
      daemonId: record.daemonId,
      kind: record.kind,
      targetId: record.targetId,
      targetVersion: null,
      frame: record.frame,
      metadata: record.metadata,
      expiresAt: record.expiresAt,
    });
    await enteredTransaction.promise;

    releaseTransaction.resolve({ case: "resume", operation: record });
    service.complete(record.operationId);
    await prepare;

    assert.equal(getCalls, 1, "跨越 complete 的 admission 按返回的真实 operationId 重读一次");
    assert.equal(daemonSends.length, 1, "complete 后 stale resume 不得产生第二次 dispatch");
    assert.deepEqual(clientSends, [], "complete 后 stale resume 不得重新注册并放行 client");
  } finally {
    service.shutdown();
  }
});

test("外部 active 查询拿到的旧记录在 complete 后不得经 resumeForClient 复活", async () => {
  const now = Date.now();
  const record = {
    operationId: "prepared-complete-stale-public-resume",
    accountId: "account-stale-public-resume",
    daemonId: "daemon-stale-public-resume",
    kind: "session.create",
    targetId: "task-stale-public-resume",
    targetVersion: now,
    frame: new Uint8Array([1, 2, 3]),
    metadata: "{}",
    expiresAt: now + 60_000,
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
    createdAt: now,
    updatedAt: now,
  };
  const completedRecord = { ...record, state: "completed", completed: true };
  const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
  const daemonSends = [];
  const clientSends = [];
  let getCalls = 0;
  const store = {
    getPreparedOperation: async (operationId) => {
      getCalls += 1;
      assert.equal(operationId, record.operationId, "必须按旧记录的真实 operationId 重读");
      return completedRecord;
    },
  };
  const service = createPreparedOperationService(store, {
    getDaemon: () => daemon,
    isCurrentDaemon: (candidate) => candidate === daemon,
    sendDaemon: (_candidate, payload) => {
      daemonSends.push(payload);
      return true;
    },
    sendClient: (_client, payload, initialSnapshot) => {
      clientSends.push({ payload, initialSnapshot });
      return true;
    },
    validControlId: () => true,
  });

  try {
    service.complete(record.operationId);
    await service.resumeForClient({ id: "client-stale-public-resume" }, record);

    assert.equal(getCalls, 1, "公开 resume 入口不能直接信任调用方跨 await 保留的记录");
    assert.deepEqual(daemonSends, [], "completed 记录不得重新 dispatch");
    assert.deepEqual(clientSends, [], "completed installed 记录不得重新发给 client 执行");
  } finally {
    service.shutdown();
  }
});

test("complete 后才恢复的 restore list 不得用旧记录重新 dispatch", async () => {
  const enteredList = deferred();
  const releaseList = deferred();
  const now = Date.now();
  const record = {
    operationId: "prepared-complete-stale-restore",
    accountId: "account-stale-restore",
    daemonId: "daemon-stale-restore",
    kind: "project.import",
    targetId: "daemon-stale-restore:/tmp/project",
    targetVersion: null,
    frame: new Uint8Array([1, 2, 3]),
    metadata: "{}",
    expiresAt: now + 60_000,
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
  const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
  const daemonSends = [];
  let listCalls = 0;
  const store = {
    expirePreparedOperations: async () => undefined,
    listInstallablePreparedOperations: () => {
      listCalls += 1;
      if (listCalls > 1) return Promise.resolve([]);
      enteredList.resolve();
      return releaseList.promise;
    },
  };
  const service = createPreparedOperationService(store, {
    getDaemon: () => daemon,
    isCurrentDaemon: (candidate) => candidate === daemon,
    sendDaemon: (_candidate, payload) => {
      daemonSends.push(payload);
      return true;
    },
    sendClient: () => true,
    validControlId: () => true,
  });

  try {
    service.dispatch(record);
    const restore = service.restore(daemon);
    await enteredList.promise;

    releaseList.resolve([record]);
    service.complete(record.operationId);
    await restore;

    assert.equal(listCalls, 2, "跨越 complete 的 restore 必须重取 installable 列表");
    assert.equal(daemonSends.length, 1, "complete 后 stale restore 不得产生第二次 dispatch");
  } finally {
    service.shutdown();
  }
});

test("complete 后才恢复的 ready snapshot 不得把旧 installed 记录发给 client", async () => {
  const enteredList = deferred();
  const releaseList = deferred();
  const now = Date.now();
  const record = {
    operationId: "prepared-complete-stale-ready-snapshot",
    accountId: "account-stale-ready-snapshot",
    daemonId: "daemon-stale-ready-snapshot",
    kind: "project.import",
    targetId: "daemon-stale-ready-snapshot:/tmp/project",
    targetVersion: null,
    frame: new Uint8Array([1, 2, 3]),
    metadata: "{}",
    expiresAt: now + 60_000,
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
    createdAt: now,
    updatedAt: now,
  };
  const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
  const clientSends = [];
  let listCalls = 0;
  const store = {
    listReadyPreparedOperations: (accountId) => {
      assert.equal(accountId, record.accountId);
      listCalls += 1;
      if (listCalls > 1) return Promise.resolve([]);
      enteredList.resolve();
      return releaseList.promise;
    },
  };
  const service = createPreparedOperationService(store, {
    getDaemon: () => daemon,
    isCurrentDaemon: (candidate) => candidate === daemon,
    sendDaemon: () => true,
    sendClient: (_client, payload, initialSnapshot) => {
      clientSends.push({ payload, initialSnapshot });
      return true;
    },
    validControlId: () => true,
  });

  try {
    const snapshot = service.sendReadyToClient(
      { id: "client-stale-ready-snapshot" },
      record.accountId,
      true,
    );
    await enteredList.promise;

    releaseList.resolve([record]);
    service.complete(record.operationId);
    await snapshot;

    assert.equal(listCalls, 2, "跨越 complete 的 ready snapshot 必须在 service 内重取列表");
    assert.deepEqual(clientSends, [], "completed installed 记录不得作为初始快照发给 client");
  } finally {
    service.shutdown();
  }
});

test("永久撤销 daemon 必须通知 waiter、取消 retry，并让旧 ready snapshot 失效", async () => {
  const enteredList = deferred();
  const releaseList = deferred();
  const now = Date.now();
  const record = {
    operationId: "prepared-cancel-daemon",
    accountId: "account-cancel-daemon",
    daemonId: "daemon-cancel-daemon",
    kind: "project.import",
    targetId: "daemon-cancel-daemon:/tmp/project",
    targetVersion: null,
    frame: new Uint8Array([1, 2, 3]),
    metadata: "{}",
    expiresAt: now + 60_000,
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
  const readyRecord = { ...record, state: "installed" };
  const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
  const daemonSends = [];
  const clientSends = [];
  let listCalls = 0;
  const store = {
    getPreparedOperation: async () => record,
    listReadyPreparedOperations: () => {
      listCalls += 1;
      if (listCalls > 1) return Promise.resolve([]);
      enteredList.resolve();
      return releaseList.promise;
    },
  };
  const service = createPreparedOperationService(store, {
    getDaemon: () => daemon,
    isCurrentDaemon: (candidate) => candidate === daemon,
    sendDaemon: (_candidate, payload) => {
      daemonSends.push(payload);
      return true;
    },
    sendClient: (_client, payload, initialSnapshot) => {
      clientSends.push({ payload, initialSnapshot });
      return true;
    },
    validControlId: () => true,
  });
  const client = { id: "client-cancel-daemon" };

  try {
    await service.resumeForClient(client, record);
    const snapshot = service.sendReadyToClient(client, record.accountId, true);
    await enteredList.promise;

    releaseList.resolve([readyRecord]);
    service.cancelDaemon(record.daemonId, "设备已撤销，prepared operation 已取消");
    await snapshot;

    assert.equal(daemonSends.length, 1, "撤销前只发生初次安装投递，retry 已被取消");
    assert.equal(listCalls, 2, "跨越 daemon 撤销的 ready snapshot 必须重取列表");
    assert.equal(
      clientSends.filter(({ payload }) => payload.case === "error").length,
      1,
      "等待安装确认的 client 会收到明确取消错误",
    );
    assert.ok(
      !clientSends.some(({ payload }) => payload.case === "preparedDeviceOperation"),
      "撤销前读到的 installed 记录不得在提交后复活",
    );
  } finally {
    service.shutdown();
  }
});

test("TTL 扫描必须推进代际、通知到期 waiter，并取消本地 retry", async () => {
  const originalNow = Date.now;
  let clock = 1_000;
  Date.now = () => clock;
  const enteredList = deferred();
  const releaseList = deferred();
  const record = {
    operationId: "prepared-ttl-expired",
    accountId: "account-ttl-expired",
    daemonId: "daemon-ttl-expired",
    kind: "project.import",
    targetId: "daemon-ttl-expired:/tmp/project",
    targetVersion: null,
    frame: new Uint8Array([1, 2, 3]),
    metadata: "{}",
    expiresAt: 2_000,
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
    createdAt: clock,
    updatedAt: clock,
  };
  const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
  const daemonSends = [];
  const clientSends = [];
  let readyListCalls = 0;
  const store = {
    getPreparedOperation: async () => record,
    expirePreparedOperations: async () => 1,
    listInstallablePreparedOperations: async () => [],
    listReadyPreparedOperations: () => {
      readyListCalls += 1;
      if (readyListCalls > 1) return Promise.resolve([]);
      enteredList.resolve();
      return releaseList.promise;
    },
  };
  const service = createPreparedOperationService(store, {
    getDaemon: () => daemon,
    isCurrentDaemon: (candidate) => candidate === daemon,
    sendDaemon: (_candidate, payload) => {
      daemonSends.push(payload);
      return true;
    },
    sendClient: (_client, payload, initialSnapshot) => {
      clientSends.push({ payload, initialSnapshot });
      return true;
    },
    validControlId: () => true,
  });
  const client = { id: "client-ttl-expired" };

  try {
    await service.resumeForClient(client, record);
    const snapshot = service.sendReadyToClient(client, record.accountId, true);
    await enteredList.promise;

    clock = 3_000;
    await service.restore(daemon);
    releaseList.resolve([{ ...record, state: "installed" }]);
    await snapshot;

    assert.equal(daemonSends.length, 1, "到期扫描取消初次安装后的 retry");
    assert.equal(readyListCalls, 2, "跨越 TTL 终结的 ready snapshot 必须重取列表");
    assert.equal(
      clientSends.filter(({ payload }) => payload.case === "error").length,
      1,
      "到期 waiter 会收到明确超时错误",
    );
    assert.ok(
      !clientSends.some(({ payload }) => payload.case === "preparedDeviceOperation"),
      "到期前读到的 installed 记录不得继续投递",
    );
  } finally {
    service.shutdown();
    Date.now = originalNow;
  }
});

async function assertInflightRetryCancelled(cancel) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = {
      callback,
      delay,
      cleared: false,
      unref() {},
    };
    scheduled.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  try {
    const enteredRead = deferred();
    const releaseRead = deferred();
    const now = Date.now();
    const record = {
      operationId: `prepared-${cancel}-inflight-retry`,
      accountId: `account-${cancel}`,
      daemonId: `daemon-${cancel}`,
      kind: "project.import",
      targetId: `daemon-${cancel}:/tmp/project`,
      targetVersion: null,
      frame: new Uint8Array([1, 2, 3]),
      metadata: "{}",
      expiresAt: now + 60_000,
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
    const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
    const daemonSends = [];
    const store = {
      getPreparedOperation: async () => {
        enteredRead.resolve();
        return releaseRead.promise;
      },
    };
    const service = createPreparedOperationService(store, {
      getDaemon: () => daemon,
      isCurrentDaemon: (candidate) => candidate === daemon,
      sendDaemon: (_candidate, payload) => {
        daemonSends.push(payload);
        return true;
      },
      sendClient: () => true,
      validControlId: () => true,
    });

    service.dispatch(record);
    assert.equal(daemonSends.length, 1, "初次 dispatch 只发送一次");
    assert.equal(scheduled.length, 1, "初次 dispatch 创建一个 retry timer");

    scheduled[0].callback();
    await enteredRead.promise;
    if (cancel === "complete") service.complete(record.operationId);
    else service.shutdown();
    releaseRead.resolve(record);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(scheduled[0].cleared, true, `${cancel} 能看见并取消已触发但尚未结束的 retry`);
    assert.equal(daemonSends.length, 1, `${cancel} 后旧记录不得触发重复 dispatch`);
    assert.equal(scheduled.length, 1, `${cancel} 后旧 continuation 不得复活 retry timer`);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test("complete 必须取消正在等待数据库的 retry continuation", async () => {
  await assertInflightRetryCancelled("complete");
});

test("shutdown 必须取消正在等待数据库的 retry continuation", async () => {
  await assertInflightRetryCancelled("shutdown");
});

async function withCapturedTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = {
      callback,
      delay,
      cleared: false,
      unref() {},
    };
    scheduled.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timer.cleared = true;
  };
  try {
    await run(scheduled);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test("retry 查询 reject 必须有界退避并释放 attempt，不能产生 unhandledRejection", async () => {
  await withCapturedTimers(async (scheduled) => {
    const now = Date.now();
    const record = {
      operationId: "prepared-retry-read-reject",
      accountId: "account-retry-read-reject",
      daemonId: "daemon-retry-read-reject",
      kind: "project.import",
      targetId: "daemon-retry-read-reject:/tmp/project",
      targetVersion: null,
      frame: new Uint8Array([1, 2, 3]),
      metadata: "{}",
      expiresAt: now + 60_000,
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
    const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
    const daemonSends = [];
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let getCalls = 0;
    const store = {
      getPreparedOperation: async () => {
        getCalls += 1;
        throw new Error("temporary read failure");
      },
    };
    const service = createPreparedOperationService(store, {
      getDaemon: () => daemon,
      isCurrentDaemon: (candidate) => candidate === daemon,
      sendDaemon: (_candidate, payload) => {
        daemonSends.push(payload);
        return true;
      },
      sendClient: () => true,
      validControlId: () => true,
    });

    try {
      service.dispatch(record);
      assert.equal(scheduled.length, 1, "初次 dispatch 创建 retry timer");
      for (let index = 0; index < 5; index += 1) {
        scheduled[index].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.equal(getCalls, 5, "连续查询失败最多尝试固定次数");
      assert.deepEqual(
        scheduled.map((timer) => timer.delay),
        [1_000, 1_000, 2_000, 4_000, 8_000],
        "查询失败按有限指数退避重排，不形成紧循环",
      );
      assert.equal(unhandled.length, 0, "timer job 的 reject 必须在 service 内消费");
      assert.equal(daemonSends.length, 1, "读库失败不能凭旧记录重复 dispatch");

      service.complete(record.operationId);
      assert.equal(scheduled.at(-1).cleared, false, "耗尽后 attempt 已从 Map 释放，不靠 complete 兜底");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      service.shutdown();
    }
  });
});

test("retry 的 expire reject 必须直接释放 attempt，不能产生 unhandledRejection", async () => {
  await withCapturedTimers(async (scheduled) => {
    const originalNow = Date.now;
    let fakeNow = 1_000;
    Date.now = () => fakeNow;
    const record = {
      operationId: "prepared-retry-expire-reject",
      accountId: "account-retry-expire-reject",
      daemonId: "daemon-retry-expire-reject",
      kind: "project.import",
      targetId: "daemon-retry-expire-reject:/tmp/project",
      targetVersion: null,
      frame: new Uint8Array([1, 2, 3]),
      metadata: "{}",
      expiresAt: 2_000,
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
      createdAt: fakeNow,
      updatedAt: fakeNow,
    };
    const daemon = { info: { daemonId: record.daemonId }, accountId: record.accountId };
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let expireCalls = 0;
    const store = {
      getPreparedOperation: async () => record,
      expirePreparedOperations: async () => {
        expireCalls += 1;
        throw new Error("temporary expire failure");
      },
    };
    const service = createPreparedOperationService(store, {
      getDaemon: () => daemon,
      isCurrentDaemon: (candidate) => candidate === daemon,
      sendDaemon: () => true,
      sendClient: () => true,
      validControlId: () => true,
    });

    try {
      service.dispatch(record);
      assert.equal(scheduled.length, 1);
      fakeNow = record.expiresAt;
      scheduled[0].callback();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(expireCalls, 1, "frame 过期后尝试一次 durable 收口");
      assert.equal(scheduled.length, 1, "过期 frame 不再重排安装 retry");
      assert.equal(unhandled.length, 0, "expire reject 必须在 timer job 内消费");

      service.complete(record.operationId);
      assert.equal(scheduled[0].cleared, false, "expire reject 后 attempt 已主动释放");
    } finally {
      Date.now = originalNow;
      process.off("unhandledRejection", onUnhandled);
      service.shutdown();
    }
  });
});
