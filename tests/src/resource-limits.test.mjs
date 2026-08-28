/**
 * server 匿名认证入口的资源边界黑盒测试。
 *
 * 只通过真实 WebSocket 线协议观察结果，不 import server 内部实现。每个用例在同一未占用
 * 端口上顺序启动一套独立 server，避免 fixed-window 与 pending 状态跨用例串扰。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./harness.mjs";

const PORT = 8863;
const RATE_WINDOW_MS = 1_000;
const USERNAME = "limit-user";
const PASSWORD = "limit-pass";
const BASE_ENV = {
  COFLUX_AUTH: "local",
  COFLUX_USERNAME: USERNAME,
  COFLUX_PASSWORD: PASSWORD,
  COFLUX_BUILD_ID: "",
  COFLUX_BUILD_ID_FILE: "",
  COFLUX_AUTHORIZE_TTL_MS: "10000",
};

const VALID_ENROLL = {
  case: "daemonEnrollRequest",
  name: "limit-device",
  host: "limit-host",
  platform: "test",
  workerVersion: "",
  supervisorVersion: "",
  arch: "",
};

async function withServer(env, run) {
  const stack = await startServer({ port: PORT, env: { ...BASE_ENV, ...env } });
  try {
    return await run(stack);
  } finally {
    await stack.stop();
  }
}

async function openDaemon(stack) {
  const daemon = stack.rawDaemon();
  await daemon.ready;
  return daemon;
}

async function waitClosed(closedInfo, label, timeout = 3_000) {
  return Promise.race([
    closedInfo,
    sleep(timeout).then(() => { throw new Error(`timeout waiting for ${label}`); }),
  ]);
}

async function expectDaemonClose(stack, message, expected, label) {
  const daemon = await openDaemon(stack);
  daemon.send(message);
  const close = await waitClosed(daemon.closedInfo, label);
  assert.deepEqual(close, expected, label);
  assert.ok(!daemon.log.some((item) => item.case === "daemonAuthorizePending"), `${label} 不得占用 pending 名额`);
}

async function clientAuthAttempt(stack, auth) {
  const client = stack.makeClient();
  await client.ready;
  const closedInfo = new Promise((resolve) => {
    client.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
  client.send({ case: "clientAuth", ...auth });
  const reply = await client.waitFor(
    (message) => message.case === "authOk" || message.case === "authError",
    "client auth reply",
  );
  return { client, reply, closedInfo };
}

function authAttempt(stack, username, password) {
  return clientAuthAttempt(stack, { username, password });
}

test("daemon 登记与认证字段按 UTF-8 字节长度拒绝", async () => {
  await withServer({ COFLUX_ENROLL_RATE_LIMIT: "100", COFLUX_MAX_PENDING_AUTHORIZATIONS: "100" }, async (stack) => {
    const oversizedEnrollFields = [
      ["name", "界".repeat(86)],
      ["host", "界".repeat(86)],
      ["platform", "界".repeat(22)],
      ["workerVersion", "界".repeat(43)],
      ["supervisorVersion", "界".repeat(43)],
      ["arch", "界".repeat(11)],
    ];
    for (const [field, value] of oversizedEnrollFields) {
      await expectDaemonClose(
        stack,
        { ...VALID_ENROLL, [field]: value },
        { code: 1008, reason: "invalid enroll request" },
        `超长 enroll.${field}`,
      );
    }

    // 六个字段都恰好卡在边界上时应正常进入待授权态，防止实现产生 off-by-one。
    const boundary = await openDaemon(stack);
    boundary.send({
      ...VALID_ENROLL,
      name: "n".repeat(256),
      host: "h".repeat(256),
      platform: "p".repeat(64),
      workerVersion: "w".repeat(128),
      supervisorVersion: "s".repeat(128),
      arch: "a".repeat(32),
    });
    await boundary.waitFor((message) => message.case === "daemonAuthorizePending", "边界 enroll authorizePending");
    boundary.close();

    const oversizedAuthFields = [
      ["deviceToken", "界".repeat(171)],
      ["workerVersion", "界".repeat(43)],
      ["supervisorVersion", "界".repeat(43)],
      ["arch", "界".repeat(11)],
    ];
    for (const [field, value] of oversizedAuthFields) {
      await expectDaemonClose(
        stack,
        { case: "daemonAuth", deviceToken: "token", workerVersion: "", supervisorVersion: "", arch: "", [field]: value },
        { code: 1008, reason: "invalid daemon auth" },
        `超长 daemonAuth.${field}`,
      );
    }
  });
});

test("daemon 待授权请求受全局 pending 硬上限约束，断线后释放名额", async () => {
  await withServer({ COFLUX_ENROLL_RATE_LIMIT: "100", COFLUX_MAX_PENDING_AUTHORIZATIONS: "2" }, async (stack) => {
    const first = await openDaemon(stack);
    first.send({ ...VALID_ENROLL, name: "pending-1" });
    await first.waitFor((message) => message.case === "daemonAuthorizePending", "pending-1");

    const second = await openDaemon(stack);
    second.send({ ...VALID_ENROLL, name: "pending-2" });
    await second.waitFor((message) => message.case === "daemonAuthorizePending", "pending-2");

    await expectDaemonClose(
      stack,
      { ...VALID_ENROLL, name: "pending-overflow" },
      { code: 1013, reason: "pending authorization limit" },
      "pending 全局上限",
    );

    first.close();
    await first.closedInfo;
    await sleep(50);

    const replacement = await openDaemon(stack);
    replacement.send({ ...VALID_ENROLL, name: "pending-replacement" });
    await replacement.waitFor((message) => message.case === "daemonAuthorizePending", "pending 名额释放后重试");
    second.close();
    replacement.close();
  });
});

test("daemon 匿名登记按同一来源 IP 固定窗口限速，窗口后恢复", async () => {
  await withServer({
    COFLUX_AUTH_RATE_WINDOW_MS: String(RATE_WINDOW_MS),
    COFLUX_ENROLL_RATE_LIMIT: "2",
    COFLUX_MAX_PENDING_AUTHORIZATIONS: "100",
  }, async (stack) => {
    const accepted = [];
    for (let index = 1; index <= 2; index += 1) {
      const daemon = await openDaemon(stack);
      daemon.send({ ...VALID_ENROLL, name: `rate-${index}` });
      await daemon.waitFor((message) => message.case === "daemonAuthorizePending", `rate-${index}`);
      accepted.push(daemon);
    }

    await expectDaemonClose(
      stack,
      { ...VALID_ENROLL, name: "rate-overflow" },
      { code: 1013, reason: "enroll rate limit" },
      "同 IP 第三次 enroll",
    );

    await sleep(RATE_WINDOW_MS + 150);
    const recovered = await openDaemon(stack);
    recovered.send({ ...VALID_ENROLL, name: "rate-recovered" });
    await recovered.waitFor((message) => message.case === "daemonAuthorizePending", "enroll 限速窗口恢复");
    for (const daemon of accepted) daemon.close();
    recovered.close();
  });
});

test("client 用户名密码登录按同一来源 IP 限速，窗口后恢复", async () => {
  await withServer({
    COFLUX_AUTH_RATE_WINDOW_MS: String(RATE_WINDOW_MS),
    COFLUX_LOGIN_RATE_LIMIT: "2",
  }, async (stack) => {
    for (let index = 1; index <= 2; index += 1) {
      const attempt = await authAttempt(stack, USERNAME, `wrong-${index}`);
      assert.equal(attempt.reply.case, "authError", `第 ${index} 次错误口令正常拒绝`);
      assert.equal(attempt.reply.message, "认证失败", `第 ${index} 次尚未触发限速`);
      assert.deepEqual(
        await waitClosed(attempt.closedInfo, `第 ${index} 次登录关闭`),
        { code: 4001, reason: "bad credentials" },
      );
    }

    const limited = await authAttempt(stack, USERNAME, "wrong-3");
    assert.equal(limited.reply.case, "authError");
    assert.match(limited.reply.message, /过于频繁/, "第 3 次同 IP 登录应收到明确限速错误");
    assert.deepEqual(
      await waitClosed(limited.closedInfo, "登录限速关闭"),
      { code: 1013, reason: "login rate limit" },
    );

    await sleep(RATE_WINDOW_MS + 150);
    const recovered = await authAttempt(stack, USERNAME, PASSWORD);
    assert.equal(recovered.reply.case, "authOk", "限速窗口结束后正确口令恢复登录");
    recovered.client.close();
  });
});

test("daemon token 认证按同一来源 IP 限速，窗口后恢复", async () => {
  await withServer({
    COFLUX_AUTH_RATE_WINDOW_MS: String(RATE_WINDOW_MS),
    COFLUX_DAEMON_AUTH_RATE_LIMIT: "2",
  }, async (stack) => {
    for (let index = 1; index <= 2; index += 1) {
      const daemon = await openDaemon(stack);
      daemon.send({
        case: "daemonAuth",
        deviceToken: `invalid-device-token-${index}`,
        workerVersion: "",
        supervisorVersion: "",
        arch: "",
      });
      await daemon.waitFor((message) => message.case === "daemonAuthError", `第 ${index} 次 daemon auth 拒绝`);
      assert.deepEqual(
        await waitClosed(daemon.closedInfo, `第 ${index} 次 daemon auth 关闭`),
        { code: 4001, reason: "bad device token" },
      );
    }

    const limited = await openDaemon(stack);
    limited.send({
      case: "daemonAuth",
      deviceToken: "invalid-device-token-3",
      workerVersion: "",
      supervisorVersion: "",
      arch: "",
    });
    assert.deepEqual(
      await waitClosed(limited.closedInfo, "daemon token 限速关闭"),
      { code: 1013, reason: "daemon auth rate limit" },
    );
    assert.ok(!limited.log.some((message) => message.case === "daemonAuthError"), "限速应先于 token 查库与认证错误");

    await sleep(RATE_WINDOW_MS + 150);
    const recovered = await openDaemon(stack);
    recovered.send({
      case: "daemonAuth",
      deviceToken: "invalid-device-token-recovered",
      workerVersion: "",
      supervisorVersion: "",
      arch: "",
    });
    await recovered.waitFor((message) => message.case === "daemonAuthError", "daemon auth 限速窗口恢复");
    assert.deepEqual(
      await waitClosed(recovered.closedInfo, "恢复后的 daemon auth 关闭"),
      { code: 4001, reason: "bad device token" },
    );
  });
});

test("client session token 认证使用独立限速桶，窗口后恢复", async () => {
  await withServer({
    COFLUX_AUTH_RATE_WINDOW_MS: String(RATE_WINDOW_MS),
    COFLUX_LOGIN_RATE_LIMIT: "100",
    COFLUX_TOKEN_AUTH_RATE_LIMIT: "2",
  }, async (stack) => {
    const issued = await authAttempt(stack, USERNAME, PASSWORD);
    assert.equal(issued.reply.case, "authOk");
    assert.ok(issued.reply.clientToken, "先取得一个有效 session token");
    issued.client.close();

    for (let index = 1; index <= 2; index += 1) {
      const attempt = await clientAuthAttempt(stack, { clientToken: `invalid-client-token-${index}` });
      assert.equal(attempt.reply.case, "authError", `第 ${index} 次无效 token 正常拒绝`);
      assert.deepEqual(
        await waitClosed(attempt.closedInfo, `第 ${index} 次 client token 关闭`),
        { code: 4001, reason: "bad credentials" },
      );
    }

    const limited = await clientAuthAttempt(stack, { clientToken: "invalid-client-token-3" });
    assert.equal(limited.reply.case, "authError");
    assert.match(limited.reply.message, /过于频繁/, "第 3 次 token 认证收到明确限速错误");
    assert.deepEqual(
      await waitClosed(limited.closedInfo, "client token 限速关闭"),
      { code: 1013, reason: "login rate limit" },
    );

    await sleep(RATE_WINDOW_MS + 150);
    const recovered = await clientAuthAttempt(stack, { clientToken: issued.reply.clientToken });
    assert.equal(recovered.reply.case, "authOk", "限速窗口结束后有效 token 恢复认证");
    recovered.client.close();
  });
});

test("单连接入站消息积压超过硬上限即断开，且不影响新连接", async () => {
  await withServer({
    COFLUX_INBOUND_QUEUE_MAX_MESSAGES: "1",
    COFLUX_INBOUND_QUEUE_MAX_BYTES: "1048576",
    COFLUX_LOGIN_RATE_LIMIT: "100",
  }, async (stack) => {
    const overloaded = stack.makeClient();
    await overloaded.ready;
    const closedInfo = new Promise((resolve) => {
      overloaded.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });

    // clientAuth 至少包含一次异步 token 落库；后续 subscribe 也会异步查快照。同步灌入多帧，
    // 无论首条 handler 卡在哪个 await，都能稳定制造“正在执行 1 条 + pending 超限”。
    overloaded.send({ case: "clientAuth", username: USERNAME, password: PASSWORD });
    for (let index = 0; index < 16; index += 1) overloaded.send({ case: "clientSubscribe" });
    assert.deepEqual(
      await waitClosed(closedInfo, "入站队列过载关闭"),
      { code: 1013, reason: "inbound queue limit" },
    );

    const healthy = await authAttempt(stack, USERNAME, PASSWORD);
    assert.equal(healthy.reply.case, "authOk", "过载连接关闭后 server 仍可服务新连接");
    healthy.client.close();
  });
});
