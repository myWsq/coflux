/**
 * plan 003：Tailscale 式设备授权流的黑盒用例。
 *
 * web 层未接入这里（不起浏览器），用裸 WS client 模拟"已登录用户打开授权链接确认"，
 * 与仓库既有黑盒测试风格一致（见 harness.mjs 顶部说明）。
 *
 * 场景 1（真实 daemon 全链路：匿名 → 拿链接 → 授权 → 上线 → 能跑任务）用真实
 * Rust supervisor+worker 二进制起一个"未登记"的 daemon（settings.json 显式
 * enrollKey:""，触发 crates/worker/src/main.rs 里 pick() 的空串直通语义）；
 * 场景 2-4（TTL/一次性/断线作废）与限速用 harness 的裸 /daemon WS 连接
 * （rawDaemon）直接发 daemon.enrollRequest，更快也更聚焦协议本身。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startServer, rawDaemon, mkRepo, spawnDaemon, killTree } from "./harness.mjs";

const PORT = 8830;
// startServer 不像 startStack 会带默认的 enrollKey/password；local 认证模式下这两个是必需的秘密类配置
// （见 apps/server/src/config.ts 的 secret()/fail-closed），显式给一份弱默认值，仅供测试用。
const LOCAL_ENV = { COFLUX_ENROLL_KEY: "dev-enroll", COFLUX_PASSWORD: "admin" };
let server;

before(async () => {
  server = await startServer({ port: PORT, env: LOCAL_ENV });
});
after(async () => {
  await server?.stop();
});

/** 从 daemon.authorizePending 的 url（`<webUrl>/authorize/<token>`）里取 token */
function tokenFromUrl(url) {
  return url.split("/").filter(Boolean).pop();
}

test("授权成功端到端：匿名 daemon 拿链接 → client 授权 → daemon 上线且能跑任务", async () => {
  const home = mkdtempSync(join(tmpdir(), "coflux-test-authhome-"));
  const deviceName = "auth-e2e-dev";
  // 显式空串（非缺省）：这正是 worker 判定"走新授权流而非 classic enroll"的信号
  // （见 crates/protocol/src/settings.rs + crates/worker/src/main.rs 的 pick() 语义）。
  writeFileSync(join(home, "settings.json"), JSON.stringify({ enrollKey: "" }), { mode: 0o600 });

  const daemonEnv = { ...process.env, COFLUX_SERVER: `ws://127.0.0.1:${PORT}/daemon`, COFLUX_HOME: home, COFLUX_DEVICE_NAME: deviceName };
  delete daemonEnv.COFLUX_ENROLL_KEY;
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

    // 与 classic enroll 流无差：能真正导入项目、起任务、走 PTY
    c.send({ case: "projectImport", daemonId, path: repo.dir });
    const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
    c.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "authz-task" });
    const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "authz-task", "idle");
    c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
    const run = await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");
    assert.ok(run.task.sessionId);
    c.send({ case: "ptyInput", sessionId: run.task.sessionId, data: "echo MARK_$((6*7))\r" });
    await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("MARK_42"), "PTY 回流");

    // credentials.json 落盘（daemon 端与 classic enroll 一样持久化，重启可重连而非再次授权）
    assert.ok(existsSync(join(home, "credentials.json")), "授权后 daemon 落地 credentials.json");
    assert.ok(!existsSync(pendingPath), "授权完成后 pending-auth.json 应被清理");

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
  writeFileSync(join(home, "settings.json"), JSON.stringify({ enrollKey: "" }), { mode: 0o600 });
  const daemonEnv = { ...process.env, COFLUX_SERVER: `ws://127.0.0.1:${short.port}/daemon`, COFLUX_HOME: home, COFLUX_DEVICE_NAME: "renew-dev" };
  delete daemonEnv.COFLUX_ENROLL_KEY;
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
