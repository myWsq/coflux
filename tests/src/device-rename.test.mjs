import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStack, spawnDaemon } from "./harness.mjs";

const PORT = 8843;
let stack;

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); });

test("设备重命名：在线改名后 web 端广播可见且新名落库", async () => {
  const c1 = stack.makeClient();
  const snap1 = await c1.authSubscribe();
  const daemon = snap1.daemons.find((d) => d.online);
  const originalName = daemon.name;
  assert.ok(originalName, "有在线设备");

  // 另一个客户端也要订阅，用来验证广播
  const c2 = stack.makeClient();
  await c2.authSubscribe();

  // c1 发起重命名
  const newName = "My MacBook Pro";
  c1.send({ case: "deviceSetName", daemonId: daemon.daemonId, name: newName });

  // c1 应该立即收到 daemonUpdated，新名称生效
  const updated1 = await c1.waitFor(
    (m) => m.case === "daemonUpdated" && m.daemon.daemonId === daemon.daemonId && m.daemon.name === newName,
    "c1: daemonUpdated with new name"
  );
  assert.equal(updated1.daemon.name, newName, "c1 看到新名称");

  // c2 也应该收到广播
  const updated2 = await c2.waitFor(
    (m) => m.case === "daemonUpdated" && m.daemon.daemonId === daemon.daemonId && m.daemon.name === newName,
    "c2: daemonUpdated with new name"
  );
  assert.equal(updated2.daemon.name, newName, "c2 也看到新名称");

  c1.close();
  c2.close();
});

test("设备重命名：空名（trim 后为空）被拒绝，不落库不下发", async () => {
  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  const daemon = snap.daemons.find((d) => d.online);
  const originalName = daemon.name;

  // 尝试用空名或空格重命名
  c.send({ case: "deviceSetName", daemonId: daemon.daemonId, name: "   " });

  // 应该看不到任何 daemonUpdated（空名被拒绝）
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterEmpty = c.log.filter(
    (m) => m.case === "daemonUpdated" && m.daemon.daemonId === daemon.daemonId
  );

  assert.equal(afterEmpty.length, 0, "空名不应该产生 daemonUpdated 广播");

  c.close();
});

test("设备重命名：在线改名后 daemon 收到 DaemonSetName 且本地 settings.json 被更新", async () => {
  // 这个测试需要 daemon 有实际的 settings.json 文件
  // 我们停止原有的 daemon，手写 settings.json，然后重启 daemon

  // 1. 停止原有 daemon
  await stack.stopDaemon();
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 2. 在 stack.home 下写初始 settings.json（包含 deviceName 和其他字段）
  const settingsPath = join(stack.home, "settings.json");
  const initialSettings = {
    serverUrl: `ws://127.0.0.1:${stack.port}/daemon`,
    enrollKey: stack.enrollKey,
    deviceName: "original-device",
    shell: "/bin/bash"
  };
  writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2));

  // 3. 重启 daemon
  const daemonEnv = {
    ...process.env,
    COFLUX_SERVER: `ws://127.0.0.1:${stack.port}/daemon`,
    COFLUX_ENROLL_KEY: stack.enrollKey,
    COFLUX_HOME: stack.home,
    // 不设 COFLUX_DEVICE_NAME，让 daemon 从 settings.json 读
  };
  const daemonProcess = spawnDaemon(daemonEnv);

  try {
    // 给 daemon 时间启动并连接
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 获取 daemonId
    const c = stack.makeClient();
    const snap = await c.authSubscribe();
    const daemon = snap.daemons.find((d) => d.online);
    assert.ok(daemon, "daemon 已上线");

    // 发起重命名
    const newName = "laptop-renamed";
    c.send({ case: "deviceSetName", daemonId: daemon.daemonId, name: newName });

    // 等待 daemonUpdated 确保改名已下发
    await c.waitFor(
      (m) => m.case === "daemonUpdated" && m.daemon.daemonId === daemon.daemonId && m.daemon.name === newName,
      "daemonUpdated after rename"
    );

    // 给 daemon 点时间处理并写入文件
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 验证本地 settings.json 被更新
    const updatedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(updatedSettings.deviceName, newName, "settings.json 中的 deviceName 已更新为新名称");
    assert.equal(updatedSettings.shell, "/bin/bash", "其他字段未被改动");

    c.close();
  } finally {
    // 清理这个测试专用的 daemon
    try {
      daemonProcess.kill();
    } catch {}
  }
});

test("设备重命名：离线设备改名后重连即被补发同步", async () => {
  // 1. 停止原有 daemon
  await stack.stopDaemon();
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 2. 建立 settings.json（为了验证离线改名后重连会同步）
  const settingsPath = join(stack.home, "settings.json");
  const offlineSettings = {
    serverUrl: `ws://127.0.0.1:${stack.port}/daemon`,
    enrollKey: stack.enrollKey,
    deviceName: "offline-device",
    shell: "/bin/bash"
  };
  writeFileSync(settingsPath, JSON.stringify(offlineSettings, null, 2));

  // 3. 此时 daemon 离线，web 客户端改名
  const c = stack.makeClient();
  const snap = await c.authSubscribe();
  const daemon = snap.daemons.find((d) => !d.online);
  assert.ok(daemon, "有离线设备");

  const newName = "offline-renamed";
  c.send({ case: "deviceSetName", daemonId: daemon.daemonId, name: newName });

  // 改名应该成功（落库但不即时下发，因为设备离线）
  const updated = await c.waitFor(
    (m) => m.case === "daemonUpdated" && m.daemon.daemonId === daemon.daemonId && m.daemon.name === newName,
    "daemonUpdated for offline device"
  );
  assert.equal(updated.daemon.online, false, "设备仍离线");

  // 4. 重启 daemon
  const daemonEnv = {
    ...process.env,
    COFLUX_SERVER: `ws://127.0.0.1:${stack.port}/daemon`,
    COFLUX_ENROLL_KEY: stack.enrollKey,
    COFLUX_HOME: stack.home,
  };
  const daemonProcess = spawnDaemon(daemonEnv);

  try {
    // 等待握手完成，此时应该收到 DaemonSetName
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 验证 settings.json 被同步更新
    const syncedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(syncedSettings.deviceName, newName, "离线改名后重连，settings.json 被补发同步为新名称");

    c.close();
  } finally {
    try {
      daemonProcess.kill();
    } catch {}
  }
});
