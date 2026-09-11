/**
 * 账号 API 的跨账号隔离（password 模式，两个用户）。
 *
 * 用户 A 拥有本栈的 daemon（startStack 以 A 的邮箱/密码起栈并授权设备），并导入项目、开终端；
 * 用户 B 走同一套 账号登录 流程拿到自己的 token。断言：B 的 token 看不到 A 的任何资产，且用 A 的资产 id
 * 调 tools 得到明确错误（与"不存在"同一句，不泄漏存在性）；A 自己的 token 能读到。
 *
 * 建用户走真实的管理员建号脚本（子进程），与 password.test.mjs 同一手法；DATABASE_URL 由本文件
 * 先定下来，再经 serverEnv 覆盖 harness 自建的临时库（harness 那个库空跑一遍迁移后被它自己删掉）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { TaskStatus } from "@coflux/protocol";
import { ADMIN_PG_URL, startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";
import { callOperation as callTool, loginAccount } from "./account-harness.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const CREATE_USER_SCRIPT = join(ROOT, "scripts", "create-user.mjs");
const DEBUG = !!process.env.COFLUX_TEST_DEBUG;

const PORT = 8867;
const BASE = `http://127.0.0.1:${PORT}`;
const USER_A = { email: "owner@x.com", password: "owner-secret" };
const USER_B = { email: "other@x.com", password: "other-secret" };

let testDb;
let stack;
let repo;
let device;
let wsA;
let wsB;
let tokenA;
let tokenB;
let projectId;
let workspaceId;
let taskId;

async function createTestDatabase() {
  const name = `coflux_test_account_${randomUUID().replace(/-/g, "")}`;
  const admin = postgres(ADMIN_PG_URL, { max: 1, ssl: "prefer" });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_PG_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropTestDatabase(name) {
  const admin = postgres(ADMIN_PG_URL, { max: 1, ssl: "prefer" });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function createUser(email, password) {
  execFileSync(TSX, [CREATE_USER_SCRIPT, "--email", email, "--password", password], {
    env: { ...process.env, DATABASE_URL: testDb.url },
    stdio: DEBUG ? "inherit" : "ignore",
  });
}

before(async () => {
  testDb = await createTestDatabase();
  createUser(USER_A.email, USER_A.password);
  createUser(USER_B.email, USER_B.password);
  stack = await startStack({
    port: PORT,
    username: USER_A.email,
    password: USER_A.password,
    serverEnv: { COFLUX_AUTH: "password", DATABASE_URL: testDb.url, COFLUX_PUBLIC_URL: BASE },
  });

  // A 的资产：项目 + 运行中的终端
  repo = mkRepo();
  device = await openRelayDevice(stack);
  const c = device.control;
  c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const created = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main workspace", 20000);
  workspaceId = created.workspace.id;
  projectId = created.workspace.projectId;
  c.send({ case: "taskCreate", workspaceId, title: "owner-task" });
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "owner-task", "task idle");
  taskId = idle.task.id;
  c.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "task running", 15000);

  tokenA = await loginAccount(BASE, USER_A.email, USER_A.password);
  tokenB = await loginAccount(BASE, USER_B.email, USER_B.password);
});

after(async () => {
  wsA?.close();
  wsB?.close();
  device?.close();
  await stack?.stop();
  repo?.cleanup();
  if (testDb) await dropTestDatabase(testDb.name);
});

test("A 的 token 看得到自己的设备、项目、工作区、终端", async () => {
  const devices = (await callTool(BASE, tokenA, "list_devices")).result.structuredContent.devices;
  assert.ok(devices.some((d) => d.id === stack.daemonId && d.online));
  const projects = (await callTool(BASE, tokenA, "list_projects")).result.structuredContent.projects;
  assert.ok(projects.some((p) => p.id === projectId));
  const workspaces = (await callTool(BASE, tokenA, "list_workspaces", { projectId })).result.structuredContent.workspaces;
  assert.deepEqual(workspaces.map((w) => w.id), [workspaceId]);
  const terminals = (await callTool(BASE, tokenA, "list_terminals", { workspaceId })).result.structuredContent.terminals;
  assert.ok(terminals.some((t) => t.id === taskId));
  const read = await callTool(BASE, tokenA, "read_terminal", { terminalId: taskId });
  assert.ok(!read.result.isError);
  assert.equal(read.result.structuredContent.status, "running");
});

test("B 的 token 看不到 A 的任何资产", async () => {
  for (const name of ["list_devices", "list_projects", "list_workspaces", "list_terminals", "list_ports"]) {
    const r = await callTool(BASE, tokenB, name);
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
    assert.ok(!r.result.isError, name);
    const lists = Object.values(r.result.structuredContent);
    assert.equal(lists.length, 1, name);
    assert.deepEqual(lists[0], [], `${name} 对 B 应为空`);
  }
});

test("B 用 A 的资产 id 调 tools 得到明确错误", async () => {
  const cases = [
    ["read_terminal", { terminalId: taskId }],
  ];
  for (const [name, args] of cases) {
    const r = await callTool(BASE, tokenB, name, args);
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
    assert.equal(r.result.isError, true, `${name} 应报错`);
    assert.ok(r.result.content[0].text.includes("不存在或不属于当前账号"), `${name}: ${r.result.content[0].text}`);
    assert.equal(r.result.structuredContent, undefined, `${name} 不带任何结构化数据`);
  }
});

test("跨账号 token 互不可换：B 的 token 不能冒充 A 读终端", async () => {
  const asB = await callTool(BASE, tokenB, "read_terminal", { terminalId: taskId });
  assert.equal(asB.result.isError, true);
  const asA = await callTool(BASE, tokenA, "read_terminal", { terminalId: taskId });
  assert.ok(!asA.result.isError);
});

test("B 用 A 的资产 id 调写 tools 同样得到「不存在或不属于当前账号」，且 A 的资产分毫未动（plan 091）", async () => {
  const cases = [
    ["create_workspace", { projectId, branch: "b-steals", createNew: true }],
    ["rename_workspace", { workspaceId, name: "hijacked" }],
    ["remove_workspace", { workspaceId }],
    ["create_terminal", { workspaceId, command: "echo pwned" }],
    ["send_terminal_input", { terminalId: taskId, text: "echo pwned" }],
    ["wait_terminal", { terminalId: taskId, timeoutSeconds: 1 }],
    ["stop_terminal", { terminalId: taskId }],
    ["remove_terminal", { terminalId: taskId }],
  ];
  for (const [name, args] of cases) {
    const r = await callTool(BASE, tokenB, name, args);
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
    assert.equal(r.result.isError, true, `${name} 应报错`);
    assert.ok(r.result.content[0].text.includes("不存在或不属于当前账号"), `${name}: ${r.result.content[0].text}`);
  }
  // A 的终端仍在跑、工作区名未变、终端数未增
  const terminals = (await callTool(BASE, tokenA, "list_terminals", { workspaceId })).result.structuredContent.terminals;
  const mine = terminals.find((t) => t.id === taskId);
  assert.equal(mine?.status, "running", "A 的终端不能被 B 停掉/删掉");
  assert.ok(!terminals.some((t) => t.title === "echo pwned"), "B 不能在 A 的工作区开终端");
  const workspaces = (await callTool(BASE, tokenA, "list_workspaces", { projectId })).result.structuredContent.workspaces;
  assert.deepEqual(workspaces.map((w) => w.id), [workspaceId], "B 不能在 A 的项目下建/删工作区");
  assert.notEqual(workspaces[0].name, "hijacked");
});

test("账号 CLI 接口复用归属规则，拒绝另一账号操作及不支持的协议版本", async () => {
  const login = await fetch(`${BASE}/api/client/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, username: USER_B.email, password: USER_B.password }),
  });
  assert.equal(login.status, 200);
  const result = await login.json();
  const command = async (value, protocolVersion = 1) => fetch(`${BASE}/api/client/command`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${result.value.token}` },
    body: JSON.stringify({ protocolVersion, command: value }),
  });
  const snapshot = await (await command({ op: "snapshot" })).json();
  assert.deepEqual(snapshot.value.devices, []);
  assert.deepEqual(snapshot.value.workspaces, []);
  for (const value of [
    { op: "terminal.read", terminalId: taskId },
    { op: "terminal.send", terminalId: taskId, text: "must-not-run" },
    { op: "terminal.stop", terminalId: taskId },
    { op: "workspace.remove", workspaceId },
  ]) {
    const response = await (await command(value)).json();
    assert.equal(response.ok, false);
    assert.match(response.error, /不存在或不属于/);
  }
  assert.equal((await command({ op: "snapshot" }, 999)).status, 400);
  await command({ op: "logout" });
  assert.equal((await command({ op: "snapshot" })).status, 401);
});

// 旧协议地址不再提供授权或工具服务，防止遗留入口绕过账号 API。
test("MCP 与专用 OAuth 入口已移除", async () => {
  for (const [method, path] of [["POST", "/mcp"], ["GET", "/mcp"], ["DELETE", "/mcp"], ["POST", "/oauth/register"], ["POST", "/oauth/token"], ["GET", "/oauth/authorize"], ["GET", "/oauth/consent"], ["GET", "/.well-known/oauth-authorization-server"], ["GET", "/.well-known/oauth-protected-resource"]]) {
    const response = await fetch(`${BASE}${path}`, { method, redirect: "manual" });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});
