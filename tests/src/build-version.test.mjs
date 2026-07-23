/**
 * 构建版本准入（黑盒，plan 033）。
 *
 * server 设 COFLUX_BUILD_ID 时，认证阶段（handleClientAuth，认证成功判定之后、subscribed 之前）
 * 按 ClientAuth.client_version 比对准入：
 *   - 匹配（含显式 "dev"）→ 正常 authOk + 订阅
 *   - 失配（有版本但不等）→ 只发 clientOutdated（不发 authError，authError 会清 token）
 *   - 缺失（旧 bundle 从不发这个字段）→ 只发 authError（唯一它认识、能让它退回登录页的杠杆）
 * 两种拒绝路径都在 send 之后关闭连接，且都不进入 subscribed（不发 authOk）。
 *
 * 现存测试（server 均不设 COFLUX_BUILD_ID）保持全绿即证明门控被 COFLUX_BUILD_ID 完全把关，
 * 不影响本机开发 / 其它黑盒测试的模拟客户端（它们从不带 client_version 字段）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./harness.mjs";

const PORT = 8851;
const BUILD_ID = "test-build-abc123";
const LOCAL_ENV = { COFLUX_ENROLL_KEY: "dev-enroll", COFLUX_PASSWORD: "admin", COFLUX_BUILD_ID: BUILD_ID };

let stack;
before(async () => { stack = await startServer({ port: PORT, env: LOCAL_ENV }); });
after(async () => { await stack?.stop(); });

function onceClosed(c) {
  return new Promise((resolve) => { c.ws.onclose = resolve; });
}

test("版本匹配：正常走到 authOk + 订阅", async () => {
  const c = stack.makeClient();
  await c.ready;
  c.send({ case: "clientAuth", username: "admin", password: "admin", clientVersion: BUILD_ID });
  await c.waitFor((m) => m.case === "authOk", "auth.ok");
  c.send({ case: "clientSubscribe" });
  await c.waitFor((m) => m.case === "stateSnapshot", "snapshot");
  c.close();
});

test('vite dev（clientVersion="dev"）总放行，不受 COFLUX_BUILD_ID 门控', async () => {
  const c = stack.makeClient();
  await c.ready;
  c.send({ case: "clientAuth", username: "admin", password: "admin", clientVersion: "dev" });
  await c.waitFor((m) => m.case === "authOk", "auth.ok");
  c.close();
});

test("版本失配：只收到 clientOutdated（不收 authError），随后连接被关闭，未进入 subscribed", async () => {
  const c = stack.makeClient();
  await c.ready;
  const closed = onceClosed(c);
  c.send({ case: "clientAuth", username: "admin", password: "admin", clientVersion: "some-other-build" });
  await c.waitFor((m) => m.case === "clientOutdated", "client.outdated");
  await closed;
  assert.ok(!c.log.some((m) => m.case === "authOk"), "未收到 authOk（未进入 subscribed 前置状态）");
  assert.ok(!c.log.some((m) => m.case === "authError"), "失配走的不是 authError（发它会清本地 token，违背无感升级）");
});

test("缺失版本（旧 bundle 从不发 client_version）：只收到 authError（不收 clientOutdated），随后连接被关闭", async () => {
  const c = stack.makeClient();
  await c.ready;
  const closed = onceClosed(c);
  c.send({ case: "clientAuth", username: "admin", password: "admin" }); // 不带 clientVersion
  await c.waitFor((m) => m.case === "authError", "auth.error");
  await closed;
  assert.ok(!c.log.some((m) => m.case === "authOk"), "未收到 authOk（未进入 subscribed 前置状态）");
  assert.ok(!c.log.some((m) => m.case === "clientOutdated"), "缺失版本走的不是 clientOutdated（旧客户端不认识该未知 case，唯一杠杆是 authError）");
});
