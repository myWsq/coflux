/**
 * supabase 认证模式集成测试（黑盒，见 plans/001 Milestone 1）。
 *
 * 不依赖真 Supabase：本地起一个 HTTP 服务提供 JWKS（ES256 公钥），自签测试 JWT，
 * 把 server 的 SUPABASE_URL 指向该本地服务。覆盖：
 *   - 合法 JWT 首次登录 → lazy 建个人账号，回带 coflux 会话 token
 *   - 同一 userId 二次登录复用同一账号
 *   - 过期 / 错签名 / 非 string 的 supabaseToken 一律拒绝
 *   - 两个不同 userId 账号隔离（互相看不到设备）
 *   - 换票签发的会话 token 可重连（关掉 JWKS 服务后仍能重连，证明不再触碰 Supabase）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { startServer } from "./harness.mjs";

const JWKS_PORT = 8831;
const SERVER_PORT = 8830;
const KID = "test-key-1";

let jwksServer, privateKey, wrongPrivateKey, stack, supabaseUrl;

before(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = "ES256";
  jwk.use = "sig";
  const wrong = await generateKeyPair("ES256"); // 不在 JWKS 里的密钥，用于伪造错签名
  wrongPrivateKey = wrong.privateKey;

  jwksServer = http.createServer((req, res) => {
    if (req.url === "/auth/v1/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => jwksServer.listen(JWKS_PORT, "127.0.0.1", r));

  supabaseUrl = `http://127.0.0.1:${JWKS_PORT}`;
  stack = await startServer({ port: SERVER_PORT, env: { COFLUX_AUTH: "supabase", SUPABASE_URL: supabaseUrl } });
});

after(async () => {
  await stack?.stop();
  if (jwksServer && jwksServer.listening) await new Promise((r) => jwksServer.close(r));
});

/** 签一个 Supabase 风格的 access_token（ES256）。opts.exp 秒级过期时间戳或字符串；opts.key 换签名密钥。 */
function signJwt(sub, email, opts = {}) {
  const jwt = new SignJWT({ email, role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setSubject(sub)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h");
  return jwt.sign(opts.key ?? privateKey);
}

/** 发 client.auth 并等认证回复（auth.ok 或 auth.error）。 */
async function authWith(client, authMsg) {
  await client.ready;
  client.send({ type: "client.auth", ...authMsg });
  return client.waitFor((m) => m.type === "auth.ok" || m.type === "auth.error", "auth reply");
}

test("合法 JWT 首次登录：lazy 建个人账号并回带会话 token", async () => {
  const c = stack.makeClient();
  const ok = await authWith(c, { supabaseToken: await signJwt("user-first", "first@x.com") });
  assert.equal(ok.type, "auth.ok", "认证成功");
  assert.ok(ok.accountId, "得到 accountId");
  assert.ok(typeof ok.clientToken === "string" && ok.clientToken.startsWith("ck_sess"), "回带 coflux 会话 token");
  c.send({ type: "client.subscribe" });
  const snap = await c.waitFor((m) => m.type === "state.snapshot", "snapshot");
  assert.equal(snap.daemons.length, 0, "新账号无设备");
  c.close();
});

test("同一 userId 二次登录复用同一账号，每次签发不同会话 token", async () => {
  const c1 = stack.makeClient();
  const ok1 = await authWith(c1, { supabaseToken: await signJwt("user-reuse", "reuse@x.com") });
  c1.close();
  const c2 = stack.makeClient();
  const ok2 = await authWith(c2, { supabaseToken: await signJwt("user-reuse", "reuse@x.com") });
  c2.close();
  assert.equal(ok1.type, "auth.ok");
  assert.equal(ok2.type, "auth.ok");
  assert.equal(ok1.accountId, ok2.accountId, "复用同一账号");
  assert.notEqual(ok1.clientToken, ok2.clientToken, "每次换票签发不同会话 token");
});

test("过期 / 错签名 / 非 string 的 supabaseToken 均被拒绝", async () => {
  const c1 = stack.makeClient();
  const expired = await signJwt("user-exp", "exp@x.com", { exp: Math.floor(Date.now() / 1000) - 60 });
  const r1 = await authWith(c1, { supabaseToken: expired });
  assert.equal(r1.type, "auth.error", "过期 JWT 被拒");
  c1.close();

  const c2 = stack.makeClient();
  const badSig = await signJwt("user-bad", "bad@x.com", { key: wrongPrivateKey });
  const r2 = await authWith(c2, { supabaseToken: badSig });
  assert.equal(r2.type, "auth.error", "错签名 JWT 被拒");
  c2.close();

  const c3 = stack.makeClient();
  const r3 = await authWith(c3, { supabaseToken: 12345 }); // 非 string
  assert.equal(r3.type, "auth.error", "非 string supabaseToken 被拒");
  c3.close();
});

test("两个不同 userId 账号隔离：互相看不到设备", async () => {
  const a = stack.makeClient();
  const okA = await authWith(a, { supabaseToken: await signJwt("iso-a", "isoa@x.com") });
  a.send({ type: "client.subscribe" });
  await a.waitFor((m) => m.type === "state.snapshot", "snapA");
  a.send({ type: "client.createEnrollmentKey" });
  const key = await a.waitFor((m) => m.type === "enrollmentKey.created", "enrollKey");

  // 用原始 /daemon 连接在 A 账号下登记一台设备（无需 Rust supervisor）
  const dev = stack.rawDaemon();
  await dev.ready;
  dev.send({ type: "daemon.enroll", enrollmentKey: key.enrollmentKey, name: "devA", host: "hostA", platform: "linux" });
  await dev.waitFor((m) => m.type === "daemon.enrolled", "enrolled");
  await a.waitFor((m) => m.type === "daemon.updated" && m.daemon.name === "devA" && m.daemon.online, "A 看到自己的设备");

  const b = stack.makeClient();
  const okB = await authWith(b, { supabaseToken: await signJwt("iso-b", "isob@x.com") });
  b.send({ type: "client.subscribe" });
  const snapB = await b.waitFor((m) => m.type === "state.snapshot", "snapB");

  assert.notEqual(okA.accountId, okB.accountId, "两 userId 得到不同账号");
  assert.equal(snapB.daemons.length, 0, "B 看不到 A 的设备");

  dev.close();
  a.close();
  b.close();
});

test("换票签发的会话 token 可重连（关掉 JWKS 服务后仍成立，证明不再触碰 Supabase）", async () => {
  const c1 = stack.makeClient();
  const ok1 = await authWith(c1, { supabaseToken: await signJwt("reconn-u", "rc@x.com") });
  assert.equal(ok1.type, "auth.ok");
  const token = ok1.clientToken;
  c1.close();

  // 关掉 JWKS 服务：此后任何 Supabase 验签都会失败；重连若仍成功即证明其不依赖 Supabase。
  await new Promise((r) => jwksServer.close(r));

  const c2 = stack.makeClient();
  const ok2 = await authWith(c2, { clientToken: token });
  assert.equal(ok2.type, "auth.ok", "会话 token 重连成功");
  assert.equal(ok2.accountId, ok1.accountId, "重连回到同一账号");
  c2.close();
});
