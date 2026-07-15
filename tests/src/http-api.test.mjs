/**
 * HTTP 只读 API（/api/*）黑盒：Bearer clientToken 认证 + protojson 快照与 WS 快照同源。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "./harness.mjs";

const PORT = 8832;
let stack;

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); });

const api = (path, token) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("GET /api/state：无 token 与伪造 token 均 401，不泄露任何状态", async () => {
  const anon = await api("/api/state");
  assert.equal(anon.status, 401);
  const forged = await api("/api/state", "cf_client_forged");
  assert.equal(forged.status, 401);
});

test("GET /api/state：Bearer clientToken 返回 protojson 快照，与 WS stateSnapshot 同源", async () => {
  const c = stack.makeClient();
  const wsSnap = await c.authSubscribe();
  const token = c.log.find((m) => m.case === "authOk").clientToken;

  const res = await api("/api/state", token);
  assert.equal(res.status, 200);
  const json = await res.json();

  // 同源断言：五个字段齐全，数量与 WS 快照一致
  assert.equal(json.daemons?.length ?? 0, wsSnap.daemons.length, "daemons 与 WS 快照一致");
  assert.equal(json.workspaces?.length ?? 0, wsSnap.workspaces.length, "workspaces 与 WS 快照一致");
  assert.equal(json.projects?.length ?? 0, wsSnap.projects.length, "projects 与 WS 快照一致");
  assert.equal(json.tasks?.length ?? 0, wsSnap.tasks.length, "tasks 与 WS 快照一致");
  assert.ok(json.daemons.some((d) => d.online), "至少一个在线 daemon");
  // protojson：枚举出名字而非数字（有任务时校验其 status 是字符串）
  for (const t of json.tasks ?? []) assert.equal(typeof t.status, "string");
  c.close();
});

test("撤销 token 后 /api/state 立即 401（与 WS 同一撤销语义）", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  const token = c.log.find((m) => m.case === "authOk").clientToken;
  c.send({ case: "clientLogout" });
  await new Promise((r) => setTimeout(r, 300)); // logout 撤销落库
  const res = await api("/api/state", token);
  assert.equal(res.status, 401);
  c.close();
});
