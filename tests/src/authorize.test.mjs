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

    c.send({ type: "device.authorizeInfo", token });
    const info = await c.waitFor((m) => m.type === "device.authorizeInfo", "authorizeInfo");
    assert.equal(info.ok, true, "待授权设备信息可查");
    assert.equal(info.name, deviceName);
    assert.ok(info.host);
    assert.ok(info.platform);

    c.send({ type: "device.authorize", token });
    await c.waitFor((m) => m.type === "device.authorized", "device.authorized");

    const upd = await c.waitFor((m) => m.type === "daemon.updated" && m.daemon.name === deviceName, "daemon.updated", 15000);
    assert.ok(upd.daemon.online, "授权后 daemon 在线");
    const daemonId = upd.daemon.daemonId;

    // 与 classic enroll 流无差：能真正导入项目、起任务、走 PTY
    c.send({ type: "project.import", daemonId, path: repo.dir });
    const main = await c.waitFor((m) => m.type === "workspace.created" && m.workspace.isMain, "main ws");
    c.send({ type: "task.create", workspaceId: main.workspace.id, title: "authz-task" });
    const idle = await c.waitFor((m) => m.type === "task.updated" && m.task.title === "authz-task", "idle");
    c.send({ type: "task.start", taskId: idle.task.id, cols: 80, rows: 24 });
    const run = await c.waitFor((m) => m.type === "task.updated" && m.task.id === idle.task.id && m.task.status === "running", "running");
    assert.ok(run.task.sessionId);
    c.send({ type: "pty.input", sessionId: run.task.sessionId, data: "echo MARK_$((6*7))\r" });
    await c.waitFor((m) => m.type === "pty.output" && m.data.includes("MARK_42"), "PTY 回流");

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
    d.send({ type: "daemon.enrollRequest", name: "ttl-dev", host: "h", platform: "test" });
    const pending = await d.waitFor((m) => m.type === "daemon.authorizePending", "authorizePending");
    const token = tokenFromUrl(pending.url);

    await sleep(500); // 超过 300ms TTL

    const c = short.makeClient();
    await c.authSubscribe();
    c.send({ type: "device.authorizeInfo", token });
    const info = await c.waitFor((m) => m.type === "device.authorizeInfo", "authorizeInfo expired");
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
  d.send({ type: "daemon.enrollRequest", name: "once-dev", host: "h", platform: "test" });
  const pending = await d.waitFor((m) => m.type === "daemon.authorizePending", "authorizePending");
  const token = tokenFromUrl(pending.url);

  const c = server.makeClient();
  await c.authSubscribe();
  c.send({ type: "device.authorize", token });
  await c.waitFor((m) => m.type === "device.authorized", "first authorize ok");

  const c2 = server.makeClient();
  await c2.authSubscribe();
  c2.send({ type: "device.authorize", token });
  const second = await c2.waitFor((m) => m.type === "device.authorizeInfo", "second authorize rejected");
  assert.equal(second.ok, false, "同一 token 二次授权应被拒");

  c.close();
  c2.close();
  d.close();
});

test("daemon 断线后待授权 token 立即作废", async () => {
  const d = rawDaemon(PORT);
  await d.ready;
  d.send({ type: "daemon.enrollRequest", name: "disc-dev", host: "h", platform: "test" });
  const pending = await d.waitFor((m) => m.type === "daemon.authorizePending", "authorizePending");
  const token = tokenFromUrl(pending.url);

  d.close();
  await sleep(400); // 等 server 处理关闭事件、清掉 pendingAuthorizations

  const c = server.makeClient();
  await c.authSubscribe();
  c.send({ type: "device.authorizeInfo", token });
  const info = await c.waitFor((m) => m.type === "device.authorizeInfo", "authorizeInfo after disconnect");
  assert.equal(info.ok, false, "daemon 断线后 token 应作废");
  c.close();
});

test("device.authorize 暴力尝试被限速", async () => {
  const limited = await startServer({ port: PORT + 2, env: { ...LOCAL_ENV, COFLUX_AUTHORIZE_MAX_FAILURES: "3" } });
  try {
    const c = limited.makeClient();
    await c.authSubscribe();
    // 响应不回带请求的 token，靠"到第 n 条 device.authorizeInfo 消息"而非消息内容来对齐请求/响应顺序
    // （单条 WS 连接上服务端按到达顺序处理并回复，顺序有保证）。
    const nth = (n) => c.waitFor((m) => m.type === "device.authorizeInfo" && c.log.filter((x) => x.type === "device.authorizeInfo").length >= n, `resp#${n}`);
    for (let i = 1; i <= 3; i++) {
      c.send({ type: "device.authorizeInfo", token: `garbage-${i}` });
      const r = await nth(i);
      assert.equal(r.ok, false);
      assert.ok(!r.error?.includes("过多"), `第 ${i} 次仍是普通失败，未到限速阈值`);
    }
    c.send({ type: "device.authorizeInfo", token: "garbage-final" });
    const limitedResp = await nth(4);
    assert.equal(limitedResp.ok, false, "超过失败次数阈值后应报限速错误");
    assert.ok(limitedResp.error?.includes("过多"), "第 4 次触发限速");
    c.close();
  } finally {
    await limited.stop();
  }
});
