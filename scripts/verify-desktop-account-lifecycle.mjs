/** 桌面账号组件集成验收：真实中心与两台 daemon；不替代 GUI/safeStorage 验收。
 * node --import tsx scripts/verify-desktop-account-lifecycle.mjs
 * 沿用 harness 的临时 HOME/数据库/进程隔离，不注册系统服务。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopAccount } from "../apps/desktop/src/main/desktop-account.ts";
import { startStack, spawnDaemon, authorizeDaemon, killTree, mkRepo } from "../tests/src/harness.mjs";
import { openRelayDevice } from "../tests/src/device-harness.mjs";
import { loginAccount } from "../tests/src/account-harness.mjs";

const port = Number(process.env.COFLUX_ACCOUNT_ACCEPTANCE_PORT || 8878);
const base = `http://127.0.0.1:${port}`;
const server = `ws://127.0.0.1:${port}/client`;
const stack = await startStack({ port });
const remoteHome = mkdtempSync(join(tmpdir(), "coflux-account-remote-"));
const repo = mkRepo();
const remoteRepo = mkRepo();
let remote;
const clients = [];
async function command(token, op) {
  const response = await fetch(`${base}/api/client/command`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ protocolVersion: 1, command: op }),
  });
  return { status: response.status, body: await response.json() };
}
async function terminal(daemonId, path, token) {
  const device = await openRelayDevice(stack, { daemonId });
  clients.push(device);
  device.control.send({ case: "projectImport", daemonId, path });
  const { workspace } = await device.control.waitFor(m => m.case === "workspaceCreated" && m.workspace.isMain && m.workspace.daemonId === daemonId, "workspace");
  const result = await command(token, { op: "terminal.new", workspaceId: workspace.id, title: "logout-scope", command: "sleep 300" });
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.value;
}
try {
  remote = spawnDaemon({ ...process.env, COFLUX_SERVER: `ws://127.0.0.1:${port}/daemon`, COFLUX_HOME: remoteHome, COFLUX_DEVICE_NAME: "logout-other-device", COFLUX_LOCAL_GATEWAY_PORT: "0" });
  await authorizeDaemon(port, remoteHome, { username: stack.username, password: stack.password });
  const remoteId = JSON.parse(readFileSync(join(remoteHome, "credentials.json"), "utf8")).daemonId;
  const token = await loginAccount(base);
  const observer = await loginAccount(base);
  const localTask = await terminal(stack.daemonId, repo.dir, token);
  const remoteTask = await terminal(remoteId, remoteRepo.dir, token);
  const marker = join(repo.dir, "logout-preserve.txt");
  writeFileSync(marker, "project-survives");
  // 存储替身只验证跨组件重建的 outbox；不宣称验证系统钥匙串加密。
  let persisted = "";
  const store = { read: () => persisted, write: value => { persisted = value; return true; }, clear: () => { persisted = ""; return true; } };
  const account = createDesktopAccount(stack.home, server, store);
  await account.connect(token);
  for (const client of clients) client.close();
  await stack.stopServer();
  await stack.stopDaemon();
  account.logout(token);
  assert.equal(existsSync(join(stack.home, "credentials.json")), false);
  assert.equal(existsSync(join(stack.home, "terminal-data")), false);
  assert.equal(account.accountId(), null);
  await assert.rejects(account.drain());
  const restored = createDesktopAccount(stack.home, server, store);
  assert.equal(restored.hasPending(), true);
  await stack.restartServer();
  await restored.drain();
  assert.equal(restored.hasPending(), false);
  const snapshot = await command(observer, { op: "snapshot" });
  assert.equal(snapshot.body.ok, true);
  assert.equal(snapshot.body.value.terminals.some(t => t.id === localTask.id), false);
  assert.equal(snapshot.body.value.terminals.some(t => t.id === remoteTask.id), true);
  const remoteState = await command(observer, { op: "terminal.wait", terminalId: remoteTask.id, timeout: 0 });
  assert.equal(remoteState.body.ok, true, JSON.stringify(remoteState.body));
  assert.equal(remoteState.body.value.exited, false);
  assert.equal(readFileSync(marker, "utf8"), "project-survives");
  assert.equal((await command(token, { op: "snapshot" })).status, 401);
  await command(observer, { op: "logout" });
  console.log("PASS: 离线登出本地清理、重建后联网收敛、旧会话撤销、其他设备活任务与项目文件保留");
} finally {
  for (const client of clients) client.close();
  if (remote) killTree(remote);
  await stack.stop();
  rmSync(remoteHome, { recursive: true, force: true });
  repo.cleanup();
  remoteRepo.cleanup();
}
