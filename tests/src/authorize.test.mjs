/**
 * plan 003：Tailscale 式设备授权流的黑盒用例。
 *
 * web 层未接入这里（不起浏览器），用裸 WS client 模拟"已登录用户打开授权链接确认"，
 * 与仓库既有黑盒测试风格一致（见 harness.mjs 顶部说明）。
 *
 * 场景 1（真实 daemon 全链路：匿名 → 拿链接 → 授权 → 上线 → 能跑任务）用真实
 * Rust supervisor+worker 二进制起一个本地无凭证的 daemon（空 home，无 credentials.json，
 * 唯一登记路径就是发 daemon.enrollRequest）；场景 2-4（TTL/一次性/断线作废）与限速用
 * harness 的裸 /daemon WS 连接（rawDaemon）直接发 daemon.enrollRequest，更快也更聚焦协议本身。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startServer, rawDaemon, mkRepo, spawnDaemon, killTree, tokenFromUrl, CookieJar, pageGet, formPost, pageLogin } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8830;
// server 直出的授权页（plan 107）挂在 COFLUX_PUBLIC_URL 下；黑盒不设它，默认即本机监听地址。
const BASE = `http://127.0.0.1:${PORT}`;
// startServer 不像 startStack 会带默认的 password；local 认证模式下这是必需的秘密类配置
// （见 apps/server/src/config.ts 的 secret()/fail-closed），显式给一份弱默认值，仅供测试用。
const LOCAL_ENV = { COFLUX_PASSWORD: "admin" };
let server;

before(async () => {
  server = await startServer({ port: PORT, env: LOCAL_ENV });
});
after(async () => {
  await server?.stop();
});

test("授权成功端到端：匿名 daemon 拿链接 → client 授权 → daemon 上线且能跑任务", async () => {
  const home = mkdtempSync(join(tmpdir(), "coflux-test-authhome-"));
  const deviceName = "auth-e2e-dev";
  // 空 home（无 settings.json/credentials.json）：daemon 无凭证，唯一路径就是发 enrollRequest。
  const daemonEnv = {
    ...process.env,
    COFLUX_SERVER: `ws://127.0.0.1:${PORT}/daemon`,
    COFLUX_HOME: home,
    COFLUX_DEVICE_NAME: deviceName,
    COFLUX_LOCAL_GATEWAY_PORT: "0",
  };
  const daemonProc = spawnDaemon(daemonEnv);

  const repo = mkRepo();
  try {
    // daemon 把待授权链接落到 <home>/pending-auth.json（文件交接，CLI 也是这样轮询的）
    const pendingPath = join(home, "pending-auth.json");
    let pending;
    for (let i = 0; i < 80 && !pending; i++) {
      if (existsSync(pendingPath)) {
        try {
          pending = JSON.parse(readFileSync(pendingPath, "utf8"));
        } catch {
          /* 文件可能正在被写，重试 */
        }
      }
      if (!pending) await sleep(250);
    }
    assert.ok(pending?.url, "daemon 落地了待授权链接");
    const token = tokenFromUrl(pending.url);

    const c = server.makeClient();
    await c.authSubscribe();

    c.send({ case: "deviceAuthorizeInfo", token });
    const info = await c.waitFor((m) => m.case === "deviceAuthorizeInfo", "authorizeInfo");
    assert.equal(info.ok, true, "待授权设备信息可查");
    assert.equal(info.name, deviceName);
    assert.ok(info.host);
    assert.ok(info.platform);

    c.send({ case: "deviceAuthorize", token });
    await c.waitFor((m) => m.case === "deviceAuthorized", "device.authorized");

    const upd = await c.waitFor((m) => m.case === "daemonUpdated" && m.daemon.name === deviceName, "daemon.updated", 15000);
    assert.ok(upd.daemon.online, "授权后 daemon 在线");
    const daemonId = upd.daemon.daemonId;
    const device = await openRelayDevice({ ...server, daemonId });
    const control = device.control;

    // 授权后即是一台正常设备：能真正导入项目、起任务、走 PTY
    control.send({ case: "projectImport", daemonId, path: repo.dir });
    const main = await control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
    control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "authz-task" });
    const idle = await control.waitFor((m) => m.case === "taskUpdated" && m.task.title === "authz-task", "idle");
    control.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
    const run = await control.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");
    assert.ok(run.task.sessionId);
    await device.attach(run.task.sessionId);
    const from = device.mark();
    await device.input(run.task.sessionId, "echo MARK_$((6*7))\r");
    await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("MARK_42"), "PTY 回流", 10000, from);

    // credentials.json 落盘（daemon 端持久化，重启可重连而非再次授权）
    assert.ok(existsSync(join(home, "credentials.json")), "授权后 daemon 落地 credentials.json");
    assert.ok(!existsSync(pendingPath), "授权完成后 pending-auth.json 应被清理");

    device.close();
    c.close();
  } finally {
    killTree(daemonProc);
    repo.cleanup();
    await sleep(200);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("授权码 TTL 过期后被拒", async () => {
  const short = await startServer({ port: PORT + 1, env: { ...LOCAL_ENV, COFLUX_AUTHORIZE_TTL_MS: "300" } });
  try {
    const d = rawDaemon(short.port);
    await d.ready;
    d.send({ case: "daemonEnrollRequest", name: "ttl-dev", host: "h", platform: "test" });
    const pending = await d.waitFor((m) => m.case === "daemonAuthorizePending", "authorizePending");
    const token = tokenFromUrl(pending.url);

    await sleep(500); // 超过 300ms TTL

    const c = short.makeClient();
    await c.authSubscribe();
    c.send({ case: "deviceAuthorizeInfo", token });
    const info = await c.waitFor((m) => m.case === "deviceAuthorizeInfo", "authorizeInfo expired");
    assert.equal(info.ok, false, "过期 token 应被拒");
    assert.ok(info.error, "带错误说明");
    c.close();
    d.close();
  } finally {
    await short.stop();
  }
});

test("授权码只能用一次：二次授权失败", async () => {
  const d = rawDaemon(PORT);
  await d.ready;
  d.send({ case: "daemonEnrollRequest", name: "once-dev", host: "h", platform: "test" });
  const pending = await d.waitFor((m) => m.case === "daemonAuthorizePending", "authorizePending");
  const token = tokenFromUrl(pending.url);

  const c = server.makeClient();
  await c.authSubscribe();
  c.send({ case: "deviceAuthorize", token });
  await c.waitFor((m) => m.case === "deviceAuthorized", "first authorize ok");

  const c2 = server.makeClient();
  await c2.authSubscribe();
  c2.send({ case: "deviceAuthorize", token });
  const second = await c2.waitFor((m) => m.case === "deviceAuthorizeInfo", "second authorize rejected");
  assert.equal(second.ok, false, "同一 token 二次授权应被拒");

  c.close();
  c2.close();
  d.close();
});

test("daemon 断线后待授权 token 立即作废", async () => {
  const d = rawDaemon(PORT);
  await d.ready;
  d.send({ case: "daemonEnrollRequest", name: "disc-dev", host: "h", platform: "test" });
  const pending = await d.waitFor((m) => m.case === "daemonAuthorizePending", "authorizePending");
  const token = tokenFromUrl(pending.url);

  d.close();
  await sleep(400); // 等 server 处理关闭事件、清掉 pendingAuthorizations

  const c = server.makeClient();
  await c.authSubscribe();
  c.send({ case: "deviceAuthorizeInfo", token });
  const info = await c.waitFor((m) => m.case === "deviceAuthorizeInfo", "authorizeInfo after disconnect");
  assert.equal(info.ok, false, "daemon 断线后 token 应作废");
  c.close();
});

test("TTL 过期后 worker 自动换新链接：旧 token 作废、新 token 可授权", async () => {
  // 续期是 worker 的逻辑（裸 WS 模拟覆盖不到），必须起真实 daemon + 短 TTL server。
  // TTL 2s + worker 1s 粒度的续期检查 → 第二个链接应在 ~3s 内出现。
  const short = await startServer({ port: PORT + 3, env: { ...LOCAL_ENV, COFLUX_AUTHORIZE_TTL_MS: "2000" } });
  const home = mkdtempSync(join(tmpdir(), "coflux-test-renewhome-"));
  const daemonEnv = { ...process.env, COFLUX_SERVER: `ws://127.0.0.1:${short.port}/daemon`, COFLUX_HOME: home, COFLUX_DEVICE_NAME: "renew-dev" };
  const daemonProc = spawnDaemon(daemonEnv);

  try {
    const pendingPath = join(home, "pending-auth.json");
    const readUrl = () => {
      try {
        return JSON.parse(readFileSync(pendingPath, "utf8"))?.url ?? null;
      } catch {
        return null; // 不存在或正在被写
      }
    };
    let firstUrl = null;
    for (let i = 0; i < 80 && !firstUrl; i++) {
      firstUrl = readUrl();
      if (!firstUrl) await sleep(250);
    }
    assert.ok(firstUrl, "第一个授权链接落地");
    const token1 = tokenFromUrl(firstUrl);

    // 先把 client 连好，等新链接一出现就立刻授权（新链接同样只有 2s 有效期）
    const c = short.makeClient();
    await c.authSubscribe();

    let secondUrl = null;
    for (let i = 0; i < 100 && !secondUrl; i++) {
      const u = readUrl();
      if (u && u !== firstUrl) secondUrl = u;
      else await sleep(100);
    }
    assert.ok(secondUrl, "TTL 过期后出现第二个授权链接（同一条连接，未重启 daemon）");
    const token2 = tokenFromUrl(secondUrl);
    assert.notEqual(token2, token1, "新链接 token 与旧的不同");

    c.send({ case: "deviceAuthorizeInfo", token: token1 });
    const oldInfo = await c.waitFor((m) => m.case === "deviceAuthorizeInfo", "old token info");
    assert.equal(oldInfo.ok, false, "旧 token 已失效");

    c.send({ case: "deviceAuthorize", token: token2 });
    await c.waitFor((m) => m.case === "deviceAuthorized", "authorize with renewed token");
    const upd = await c.waitFor((m) => m.case === "daemonUpdated" && m.daemon.name === "renew-dev", "daemon online", 15000);
    assert.ok(upd.daemon.online, "用换新后的 token 授权成功，daemon 上线");

    // daemon 侧收尾与常规路径一致
    for (let i = 0; i < 40 && !existsSync(join(home, "credentials.json")); i++) await sleep(100);
    assert.ok(existsSync(join(home, "credentials.json")), "credentials.json 落盘");
    c.close();
  } finally {
    killTree(daemonProc);
    await sleep(200);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await short.stop();
  }
});

test("device.authorize 暴力尝试被限速", async () => {
  const limited = await startServer({ port: PORT + 2, env: { ...LOCAL_ENV, COFLUX_AUTHORIZE_MAX_FAILURES: "3" } });
  try {
    const c = limited.makeClient();
    await c.authSubscribe();
    // 响应不回带请求的 token，靠"到第 n 条 device.authorizeInfo 消息"而非消息内容来对齐请求/响应顺序
    // （单条 WS 连接上服务端按到达顺序处理并回复，顺序有保证）。
    const nth = (n) => c.waitFor((m) => m.case === "deviceAuthorizeInfo" && c.log.filter((x) => x.case === "deviceAuthorizeInfo").length >= n, `resp#${n}`);
    for (let i = 1; i <= 3; i++) {
      c.send({ case: "deviceAuthorizeInfo", token: `garbage-${i}` });
      const r = await nth(i);
      assert.equal(r.ok, false);
      assert.ok(!r.error?.includes("过多"), `第 ${i} 次仍是普通失败，未到限速阈值`);
    }
    c.send({ case: "deviceAuthorizeInfo", token: "garbage-final" });
    const limitedResp = await nth(4);
    assert.equal(limitedResp.ok, false, "超过失败次数阈值后应报限速错误");
    assert.ok(limitedResp.error?.includes("过多"), "第 4 次触发限速");
    c.close();
  } finally {
    await limited.stop();
  }
});

test("等待授权的 daemon 不被 auth deadline 踢；未发 enrollRequest 的裸连接仍会被踢", async () => {
  // 生产实测踩过的 bug：auth deadline（默认 15s）把等待浏览器授权的 daemon 当未认证连接
  // 反复踢掉 → 每次重连换发新链接，用户手里的链接永远在变。修复 = 持有 pending 授权的
  // 连接豁免 deadline（transport 的 canWaitAuth）。此处用 1s deadline 复现两侧行为。
  const short = await startServer({ port: PORT + 4, env: { ...LOCAL_ENV, COFLUX_AUTH_DEADLINE_MS: "1000" } });
  try {
    // 裸连接：什么都不发，到点应被 4008 关闭（deadline 机制本身必须仍然生效）
    const idle = rawDaemon(short.port);
    await idle.ready;
    const idleCode = await Promise.race([idle.closed, sleep(4000).then(() => "not-closed")]);
    assert.equal(idleCode, 4008, "裸连接应在 deadline 被 4008 关闭");

    // 已申请授权的连接：跨过 deadline 仍存活，且此后仍能完成授权
    const d = rawDaemon(short.port);
    await d.ready;
    d.send({ case: "daemonEnrollRequest", name: "wait-dev", host: "h", platform: "test" });
    const pending = await d.waitFor((m) => m.case === "daemonAuthorizePending", "authorizePending");
    const survived = await Promise.race([d.closed, sleep(2500).then(() => "alive")]);
    assert.equal(survived, "alive", "等待授权的连接不应被 deadline 关闭");

    const c = short.makeClient();
    await c.authSubscribe();
    c.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
    await c.waitFor((m) => m.case === "deviceAuthorized", "authorized after deadline");
    const enrolled = await d.waitFor((m) => m.case === "daemonEnrolled", "enrolled");
    assert.ok(enrolled.deviceToken, "跨过 deadline 后授权仍能完成");
    c.close();
    d.close();
  } finally {
    await short.stop();
  }
});

/* ============================ server 直出的授权页（plan 107，HTTP 流） ============================ */

test("HTTP 授权页端到端：链接落在 publicUrl → 登录 → 确认 → daemon 上线且能跑任务", async () => {
  const home = mkdtempSync(join(tmpdir(), "coflux-test-authpage-"));
  const deviceName = "auth-page-dev";
  const daemonEnv = {
    ...process.env,
    COFLUX_SERVER: `ws://127.0.0.1:${PORT}/daemon`,
    COFLUX_HOME: home,
    COFLUX_DEVICE_NAME: deviceName,
    COFLUX_LOCAL_GATEWAY_PORT: "0",
  };
  const daemonProc = spawnDaemon(daemonEnv);
  const repo = mkRepo();
  try {
    const pendingPath = join(home, "pending-auth.json");
    let pending;
    for (let i = 0; i < 80 && !pending; i++) {
      if (existsSync(pendingPath)) {
        try {
          pending = JSON.parse(readFileSync(pendingPath, "utf8"));
        } catch {
          /* 文件可能正在被写，重试 */
        }
      }
      if (!pending) await sleep(250);
    }
    assert.ok(pending?.url, "daemon 落地了待授权链接");
    assert.ok(pending.url.startsWith(`${BASE}/authorize/`), `授权链接由 publicUrl 拼出：${pending.url}`);

    // 未登录：登录表单 + 匿名 nonce cookie（HttpOnly、SameSite=Lax、按 /authorize 隔离、http 下不带 Secure）
    const jar = new CookieJar();
    const first = await pageGet(pending.url, jar);
    assert.equal(first.status, 200);
    assert.ok(first.html.includes("授权新设备") && first.html.includes("先登录你的账号，再确认这台设备的信息"));
    assert.ok(first.hidden.csrf, "登录表单带 csrf 隐藏字段");
    const anon = first.headers.getSetCookie().find((c) => c.startsWith("cf_page="));
    assert.ok(anon && /cf_page=cf_pgan_/.test(anon), `登录前发匿名 nonce cookie：${anon}`);
    assert.ok(anon.includes("Path=/authorize") && anon.includes("HttpOnly") && anon.includes("SameSite=Lax") && !anon.includes("Secure"));
    assert.ok(!first.html.includes("<script"), "页面不含 JS 也能走通");

    // 登录 → 303 回同一 GET，cookie 换成页面会话
    const login = await pageLogin(pending.url, jar);
    assert.equal(login.status, 303, login.html);
    assert.equal(login.location, `/authorize/${tokenFromUrl(pending.url)}`);
    const sess = login.headers.getSetCookie().find((c) => c.startsWith("cf_page="));
    assert.ok(sess && /cf_page=cf_pgs_/.test(sess) && sess.includes("HttpOnly") && sess.includes("SameSite=Lax") && !sess.includes("Secure"), `登录只签短命页面会话：${sess}`);

    // 有会话的 GET：设备卡片
    const confirm = await pageGet(pending.url, jar);
    assert.equal(confirm.status, 200);
    assert.ok(confirm.html.includes("确认设备") && confirm.html.includes(deviceName) && confirm.html.includes("授权此设备"));
    assert.equal(confirm.action, `/authorize/${tokenFromUrl(pending.url)}/confirm`);

    // 授权此设备 → 完成页，会话作废
    const done = await formPost(new URL(confirm.action, BASE).toString(), confirm.hidden, jar);
    assert.equal(done.status, 200, done.html);
    assert.ok(done.html.includes("设备已授权") && done.html.includes("可以关闭此页面"));
    assert.ok(done.headers.getSetCookie().some((c) => c.startsWith("cf_page=;") && c.includes("Max-Age=0")), "流程结束即清页面会话 cookie");
    const after = await pageGet(pending.url, jar);
    assert.ok(after.html.includes("授权新设备"), "会话已作废，再打开须重新登录");

    // 与 WS 授权完全相同的结果：daemon 在线、能导入项目、起任务、走 PTY
    const c = server.makeClient();
    const snap = await c.authSubscribe();
    let daemon = snap.daemons.find((d) => d.name === deviceName);
    if (!daemon?.online) {
      const upd = await c.waitFor((m) => m.case === "daemonUpdated" && m.daemon.name === deviceName && m.daemon.online, "daemon.updated", 15000);
      daemon = upd.daemon;
    }
    const daemonId = daemon.daemonId;
    const device = await openRelayDevice({ ...server, daemonId });
    const control = device.control;
    control.send({ case: "projectImport", daemonId, path: repo.dir });
    const main = await control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
    control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "authpage-task" });
    const idle = await control.waitFor((m) => m.case === "taskUpdated" && m.task.title === "authpage-task", "idle");
    control.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
    const run = await control.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");
    await device.attach(run.task.sessionId);
    const from = device.mark();
    await device.input(run.task.sessionId, "echo PAGE_$((7*6))\r");
    await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("PAGE_42"), "PTY 回流", 10000, from);
    assert.ok(existsSync(join(home, "credentials.json")), "授权后 daemon 落地 credentials.json");
    device.close();
    c.close();
  } finally {
    killTree(daemonProc);
    repo.cleanup();
    await sleep(200);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("HTTP 授权页：未登录 GET 不区分 token 是否有效；无效 token 登录后才报不可用；csrf / 跨站 POST 被拒；设备名经转义", async () => {
  const d = rawDaemon(PORT);
  await d.ready;
  d.send({ case: "daemonEnrollRequest", name: "<script>alert(1)</script>", host: "h<b>", platform: "test" });
  const pending = await d.waitFor((m) => m.case === "daemonAuthorizePending", "authorizePending");
  const bogusUrl = `${BASE}/authorize/cf_authz_definitely-not-a-token`;

  // 登录前：有效与无效 token 的响应无差别（都是登录表单），不给 oracle
  const validPage = await pageGet(pending.url, new CookieJar());
  const bogusPage = await pageGet(bogusUrl, new CookieJar());
  assert.equal(validPage.status, 200);
  assert.equal(bogusPage.status, 200);
  for (const page of [validPage, bogusPage]) {
    assert.ok(page.html.includes("授权新设备"));
    assert.ok(!page.html.includes("授权链接不可用") && !page.html.includes("确认设备"));
  }
  const strip = (html) => html.replace(/name="csrf" value="[^"]+"/, "").replace(/action="[^"]+"/, "");
  assert.equal(strip(validPage.html), strip(bogusPage.html), "登录前的页面除 csrf/action 外完全一致");

  // 登录 POST：csrf 不符 403；密码错 401 只说「用户名或密码错误」
  const jar = new CookieJar();
  const page = await pageGet(pending.url, jar);
  const badCsrf = await formPost(new URL(page.action, BASE).toString(), { ...page.hidden, csrf: "forged", username: "admin", password: "admin" }, jar);
  assert.equal(badCsrf.status, 403);
  assert.ok(badCsrf.html.includes("页面已过期"));
  const badPassword = await formPost(new URL(page.action, BASE).toString(), { ...page.hidden, username: "admin", password: "wrong" }, jar);
  assert.equal(badPassword.status, 401);
  assert.ok(badPassword.html.includes("登录失败：用户名或密码错误"));
  assert.ok(!badPassword.html.includes("授权链接") && badPassword.html.includes("授权新设备"), "登录失败页不泄漏 token 状态");

  // 登录成功后：无效 token → 授权链接不可用；有效 token → 设备卡片且设备名/主机经转义
  const login = await pageLogin(pending.url, jar);
  assert.equal(login.status, 303, login.html);
  const bogus = await pageGet(bogusUrl, jar);
  assert.equal(bogus.status, 404);
  assert.ok(bogus.html.includes("授权链接不可用") && bogus.html.includes("授权链接无效或已过期"));
  const confirm = await pageGet(pending.url, jar);
  assert.equal(confirm.status, 200);
  assert.ok(confirm.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && confirm.html.includes("h&lt;b&gt;"), "设备名与主机经转义");
  assert.ok(!confirm.html.includes("<script>"), "设备名里的 <script> 绝不能原样进页面");

  // 确认 POST：csrf 不符 / 跨站 Origin / 跨站 Sec-Fetch-Site 都被拒，token 仍有效
  const confirmUrl = new URL(confirm.action, BASE).toString();
  const forged = await formPost(confirmUrl, { csrf: "forged" }, jar);
  assert.equal(forged.status, 403);
  const crossSite = await formPost(confirmUrl, confirm.hidden, jar, { origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  const secFetch = await formPost(confirmUrl, confirm.hidden, jar, { "sec-fetch-site": "cross-site" });
  assert.equal(secFetch.status, 403);
  const stillValid = await pageGet(pending.url, jar);
  assert.equal(stillValid.status, 200, "被拒的 POST 不消费 token");
  assert.ok(stillValid.html.includes("确认设备"));

  // 正确的确认（同源 Origin 放行）：daemon 收到 enrolled；同一 token 二次使用报不可用
  const done = await formPost(confirmUrl, stillValid.hidden, jar, { origin: BASE });
  assert.equal(done.status, 200, done.html);
  assert.ok(done.html.includes("设备已授权"));
  const enrolled = await d.waitFor((m) => m.case === "daemonEnrolled", "enrolled");
  assert.ok(enrolled.deviceToken);
  const again = new CookieJar();
  assert.equal((await pageLogin(pending.url, again)).status, 303);
  const consumed = await pageGet(pending.url, again);
  assert.equal(consumed.status, 404, "已兑现的 token 再打开应报不可用");
  assert.ok(consumed.html.includes("授权链接不可用"));
  d.close();
});

test("HTTP 授权页：登录 POST 按来源限速", async () => {
  const limited = await startServer({ port: PORT + 5, env: { ...LOCAL_ENV, COFLUX_LOGIN_RATE_LIMIT: "2" } });
  try {
    const url = `http://127.0.0.1:${limited.port}/authorize/cf_authz_whatever`;
    const jar = new CookieJar();
    const page = await pageGet(url, jar);
    const attempt = (password) => formPost(new URL(page.action, url).toString(), { ...page.hidden, username: "admin", password }, jar);
    assert.equal((await attempt("wrong-1")).status, 401);
    assert.equal((await attempt("wrong-2")).status, 401);
    const third = await attempt("admin");
    assert.equal(third.status, 429, "窗口内第 3 次登录应被来源限速，正确密码也不例外");
    assert.ok(third.html.includes("登录尝试过于频繁"));
  } finally {
    await limited.stop();
  }
});

test("HTTP 授权页：token 猜测失败按页面会话计数，达上限后统一报「尝试次数过多」", async () => {
  const limited = await startServer({ port: PORT + 6, env: { ...LOCAL_ENV, COFLUX_AUTHORIZE_MAX_FAILURES: "3" } });
  try {
    const base = `http://127.0.0.1:${limited.port}`;
    const jar = new CookieJar();
    assert.equal((await pageLogin(`${base}/authorize/garbage-0`, jar)).status, 303);
    for (let i = 1; i <= 3; i++) {
      const r = await pageGet(`${base}/authorize/garbage-${i}`, jar);
      assert.equal(r.status, 404, `第 ${i} 次仍是普通失败`);
      assert.ok(!r.html.includes("过多"));
    }
    const capped = await pageGet(`${base}/authorize/garbage-final`, jar);
    assert.equal(capped.status, 429);
    assert.ok(capped.html.includes("尝试次数过多"), "第 4 次触发限速");
    // 另一个页面会话不受连坐（按页面会话计数，不按来源地址）
    const fresh = new CookieJar();
    assert.equal((await pageLogin(`${base}/authorize/garbage-x`, fresh)).status, 303);
    assert.equal((await pageGet(`${base}/authorize/garbage-x`, fresh)).status, 404);
  } finally {
    await limited.stop();
  }
});
