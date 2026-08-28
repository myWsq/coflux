/**
 * password 认证模式集成测试（黑盒，见 plans/059；取代已删除的 supabase.test.mjs）。
 *
 * 保持黑盒性质（不 import apps/* 的实现逻辑，见 harness.mjs 顶部注释同一纪律）：建测试用户
 * 走真实的管理员建号脚本 scripts/create-user.mjs（子进程调用，等价于生产管理员建号操作）；
 * 仅"会话 token 独立性"用例需要绕过 server 直接改 users 表，用裸 SQL（非 Store 内部方法）。
 *
 * 覆盖原 supabase 测试的 5 个语义（映射见 plans/059 Decisions & tradeoffs）：
 *   - 首次登录 → lazy 建个人账号，回带 coflux 会话 token
 *   - 同一用户二次登录复用同一账号
 *   - 错密码 / 不存在邮箱 / 非 string 凭证一律拒绝
 *   - 两个不同用户账号隔离（互相看不到设备）
 *   - 会话 token 独立性：签发后即使 users 表里的该用户被删，重连仍成立（重连只查 client_tokens）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { ADMIN_PG_URL, startServer, tokenFromUrl } from "./harness.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const CREATE_USER_SCRIPT = join(ROOT, "scripts", "create-user.mjs");
const DEBUG = !!process.env.COFLUX_TEST_DEBUG;

const SERVER_PORT = 8830;

let stack, testDb, sql;

/** 独立于 harness 的临时库：password 测试需要在 server 启动前就把 DATABASE_URL 定下来，
 * 这样测试用户建号脚本与 server 才能指向同一个库（与 harness.mjs 内 createTestDatabase 同思路）。 */
async function createTestDatabase() {
  const name = `coflux_test_pw_${randomUUID().replace(/-/g, "")}`;
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

/** 建一个测试用户：真实调用管理员建号脚本（子进程），与生产建号路径完全一致。 */
function createUser(email, password, id) {
  const args = [CREATE_USER_SCRIPT, "--email", email, "--password", password, ...(id ? ["--id", id] : [])];
  execFileSync(TSX, args, { env: { ...process.env, DATABASE_URL: testDb.url }, stdio: DEBUG ? "inherit" : "ignore" });
}

before(async () => {
  testDb = await createTestDatabase();
  // users 表位于 coflux schema（见 store.ts SCHEMA_DDL），非 public。
  sql = postgres(testDb.url, { max: 1, ssl: "prefer", connection: { search_path: "coflux" } });
  // opts.env 里的 DATABASE_URL 覆盖 harness 自建的临时库（见 harness.mjs startServer 的
  // spread 顺序），让 server 与本文件建号脚本指向同一个库。
  stack = await startServer({ port: SERVER_PORT, env: { COFLUX_AUTH: "password", DATABASE_URL: testDb.url } });
});

after(async () => {
  await stack?.stop();
  await sql?.end({ timeout: 5 });
  if (testDb) await dropTestDatabase(testDb.name);
});

/** 发 client.auth 并等认证回复（authOk 或 authError）。 */
async function authWith(client, authMsg) {
  await client.ready;
  client.send({ case: "clientAuth", ...authMsg });
  return client.waitFor((m) => m.case === "authOk" || m.case === "authError", "auth reply");
}

test("首次登录：lazy 建个人账号并回带会话 token", async () => {
  createUser("first@x.com", "secret1");
  const c = stack.makeClient();
  const ok = await authWith(c, { username: "first@x.com", password: "secret1" });
  assert.equal(ok.case, "authOk", "认证成功");
  assert.ok(ok.accountId, "得到 accountId");
  assert.ok(typeof ok.clientToken === "string" && ok.clientToken.startsWith("ck_sess"), "回带 coflux 会话 token");
  c.send({ case: "clientSubscribe" });
  const snap = await c.waitFor((m) => m.case === "stateSnapshot", "snapshot");
  assert.equal(snap.daemons.length, 0, "新账号无设备");
  c.close();
});

test("并发首次登录：同一用户只 provision 一个个人账号", async () => {
  const userId = randomUUID();
  const email = "concurrent-first@x.com";
  const password = "concurrent-secret";
  createUser(email, password, userId);

  // 先等所有 WS ready，再同一轮发送认证帧，确保 8 次密码校验后的 lazy provision
  // 真正并发进入 server，而不是由建连时序碰巧串行。
  const clients = Array.from({ length: 8 }, () => stack.makeClient());
  try {
    await Promise.all(clients.map((client) => client.ready));
    for (const client of clients) client.send({ case: "clientAuth", username: email, password });
    const replies = await Promise.all(clients.map((client) => client.waitFor(
      (message) => message.case === "authOk" || message.case === "authError",
      "concurrent auth reply",
    )));
    assert.ok(replies.every((reply) => reply.case === "authOk"), "全部并发登录都成功");
    const accountIds = new Set(replies.map((reply) => reply.accountId));
    assert.equal(accountIds.size, 1, "全部登录返回同一个 accountId");
    const [accountId] = accountIds;

    const memberships = await sql`SELECT account_id FROM memberships WHERE user_id = ${userId}`;
    assert.equal(memberships.length, 1, "该 user 只有一条 membership");
    assert.equal(memberships[0].account_id, accountId, "membership 指向返回的账号");
    const accounts = await sql`SELECT id FROM accounts WHERE id = ${accountId}`;
    assert.equal(accounts.length, 1, "相关 account 只有一条");
  } finally {
    for (const client of clients) client.close();
  }
});

test("同一连接按 wire 顺序完成异步认证后再处理订阅", async () => {
  const email = "ordered-handler@x.com";
  const password = "ordered-secret";
  createUser(email, password);
  const client = stack.makeClient();
  try {
    await client.ready;
    // 不等 authOk 就紧接着发 subscribe：password scrypt 明显异步，若 transport fire-and-forget，
    // subscribe 会越过认证并收到“未认证”；连接内队列必须保住这两个 wire 事件的先后。
    client.send({ case: "clientAuth", username: email, password });
    client.send({ case: "clientSubscribe" });
    const auth = await client.waitFor((message) => message.case === "authOk", "ordered authOk");
    assert.ok(auth.accountId);
    const snapshot = await client.waitFor((message) => message.case === "stateSnapshot", "ordered snapshot");
    assert.ok(Array.isArray(snapshot.tasks), "订阅在认证完成后成功返回快照");
    assert.ok(!client.log.some((message) => message.case === "error" && message.message === "未认证"));
  } finally {
    client.close();
  }
});

test("同一用户二次登录复用同一账号，每次签发不同会话 token", async () => {
  createUser("reuse@x.com", "secret2");
  const c1 = stack.makeClient();
  const ok1 = await authWith(c1, { username: "reuse@x.com", password: "secret2" });
  c1.close();
  const c2 = stack.makeClient();
  const ok2 = await authWith(c2, { username: "reuse@x.com", password: "secret2" });
  c2.close();
  assert.equal(ok1.case, "authOk");
  assert.equal(ok2.case, "authOk");
  assert.equal(ok1.accountId, ok2.accountId, "复用同一账号");
  assert.notEqual(ok1.clientToken, ok2.clientToken, "每次登录签发不同会话 token");
});

test("错密码 / 不存在邮箱 / 非 string 凭证均被拒绝", async () => {
  createUser("wrongpw@x.com", "correct-pw");

  const c1 = stack.makeClient();
  const r1 = await authWith(c1, { username: "wrongpw@x.com", password: "incorrect-pw" });
  assert.equal(r1.case, "authError", "错密码被拒");
  c1.close();

  const c2 = stack.makeClient();
  const r2 = await authWith(c2, { username: "nobody@x.com", password: "whatever" });
  assert.equal(r2.case, "authError", "不存在的邮箱被拒");
  c2.close();

  const c3 = stack.makeClient();
  const r3 = await authWith(c3, { username: "wrongpw@x.com", password: 12345 }); // 非 string
  assert.equal(r3.case, "authError", "非 string password 被拒");
  c3.close();
});

test("两个不同用户账号隔离：互相看不到设备", async () => {
  createUser("isoa@x.com", "pwa");
  createUser("isob@x.com", "pwb");

  const a = stack.makeClient();
  const okA = await authWith(a, { username: "isoa@x.com", password: "pwa" });
  a.send({ case: "clientSubscribe" });
  await a.waitFor((m) => m.case === "stateSnapshot", "snapA");

  // 用原始 /daemon 连接走浏览器授权，在 A 账号下登记一台设备（无需 Rust supervisor）
  const dev = stack.rawDaemon();
  await dev.ready;
  dev.send({ case: "daemonEnrollRequest", name: "devA", host: "hostA", platform: "linux" });
  const pending = await dev.waitFor((m) => m.case === "daemonAuthorizePending", "authorizePending");
  a.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
  await a.waitFor((m) => m.case === "deviceAuthorized", "A 确认授权");
  await dev.waitFor((m) => m.case === "daemonEnrolled", "enrolled");
  await a.waitFor((m) => m.case === "daemonUpdated" && m.daemon.name === "devA" && m.daemon.online, "A 看到自己的设备");

  const b = stack.makeClient();
  const okB = await authWith(b, { username: "isob@x.com", password: "pwb" });
  b.send({ case: "clientSubscribe" });
  const snapB = await b.waitFor((m) => m.case === "stateSnapshot", "snapB");

  assert.notEqual(okA.accountId, okB.accountId, "两用户得到不同账号");
  assert.equal(snapB.daemons.length, 0, "B 看不到 A 的设备");

  dev.close();
  a.close();
  b.close();
});

test("会话 token 独立性：签发后该用户从 users 表被删，重连仍成立", async () => {
  createUser("reconn@x.com", "secret3");
  const c1 = stack.makeClient();
  const ok1 = await authWith(c1, { username: "reconn@x.com", password: "secret3" });
  assert.equal(ok1.case, "authOk");
  const token = ok1.clientToken;
  c1.close();

  // 删掉 users 表里的该用户：此后任何邮箱+密码登录都会失败；重连若仍成功即证明
  // password 模式下签发的会话 token 重连不再查 users 表（只查 client_tokens）。
  await sql`DELETE FROM users WHERE email = ${"reconn@x.com"}`;

  const c2 = stack.makeClient();
  const ok2 = await authWith(c2, { clientToken: token });
  assert.equal(ok2.case, "authOk", "会话 token 重连成功");
  assert.equal(ok2.accountId, ok1.accountId, "重连回到同一账号");
  c2.close();
});
