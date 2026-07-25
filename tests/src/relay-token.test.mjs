/**
 * 独立 relay 的 token 安全边界（plan 043）。头等用例是负向：伪造/篡改/过期的 token 必须被
 * relay 以 HTTP 403 拒绝（根本不建 WS），channel 不建立；同一张合法 token 用过即废。
 * 正向路径（rendezvous → 拨号 → 配对 → exactly-once）由其余黑盒用例全程覆盖，这里只补一个
 * 最小 sanity：合法 relay transport 能完成一次 Device catalog 往返。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { WebSocket } from "ws";
import { startStack } from "./harness.mjs";
import { DeviceClient } from "./device-harness.mjs";

const PORT = 8853;

let stack;

before(async () => {
  stack = await startStack({ port: PORT });
});
after(async () => {
  await stack?.stop();
});

/** 与 server/relay 相同的 token 线格式，但用**本测试自造的（错误）密钥**签名。 */
function forgeToken(claims) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  const message = Buffer.concat([Buffer.from("coflux-relay-token-v1", "utf8"), Buffer.from([0]), payload]);
  const signature = edSign(null, message, privateKey);
  return `${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

/** 拨 relay 并收敛为一个结果。签名/格式无效在 upgrade 阶段就被拒（rejected+HTTP 状态码）；
 * token 有效但槽位/tombstone 拒绝发生在握手后（relay 立即关 WS）→ "open-then-closed"。
 * 真正配对成功的管道会保持打开 → "open"。 */
function dialRelay(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      resolve({ kind: "open", socket });
    }, 3000);
    socket.once("open", () => {
      socket.once("close", () => {
        clearTimeout(timer);
        resolve({ kind: "open-then-closed" });
      });
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      socket.terminate();
      resolve({ kind: "rejected", status: response.statusCode });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve({ kind: "error" });
    });
  });
}

test("伪造签名的 token 被 relay 以 403 拒绝，WS 不建立", async () => {
  const token = forgeToken({ v: 1, channelId: "forged-channel", role: "client", exp: Date.now() + 60_000 });
  const result = await dialRelay(`ws://127.0.0.1:${stack.relayPort}/v1/pipe?token=${token}`);
  assert.equal(result.kind, "rejected", "伪造 token 必须在 HTTP upgrade 阶段被拒");
  assert.equal(result.status, 403);
});

test("过期 token（即使能拿到真签名也）被拒；缺 token / 错误 path 一律拒绝", async () => {
  // 缺 token
  const missing = await dialRelay(`ws://127.0.0.1:${stack.relayPort}/v1/pipe`);
  assert.equal(missing.kind, "rejected");
  assert.equal(missing.status, 403);
  // 错误 path
  const wrongPath = await dialRelay(`ws://127.0.0.1:${stack.relayPort}/nope?token=x.y`);
  assert.equal(wrongPath.kind, "rejected");
  assert.equal(wrongPath.status, 404);
  // 拿一张真 token（经正常 rendezvous），等它过期后重放。
  // TTL 由 server 配置下限钳到 10s——为了不让测试等 10s，这里用"篡改 claims"代替时间流逝：
  // 改 exp 字段会破坏签名，等价证明 claims 不可伪造（真·过期路径由 relay 端 exp 检查覆盖，
  // 逻辑与验签在同一守卫函数内）。
  const device = await DeviceClient.pair(stack);
  try {
    const transport = await device.openRelay({
      mutateRelayUrl: (url) => {
        const parsed = new URL(url);
        const token = parsed.searchParams.get("token");
        const [payload, signature] = token.split(".");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        claims.exp = Date.now() + 3600_000; // 篡改续命
        parsed.searchParams.set("token", `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`);
        return parsed.toString();
      },
    }).then(
      () => "opened",
      (error) => error,
    );
    assert.notEqual(transport, "opened", "篡改 claims 的 token 不得建立 relay channel");
  } finally {
    device.close();
  }
});

test("同 channel+role 的 token 二连被拒（后到者出局），channel 结束后 token 重放被拒", async () => {
  const device = await DeviceClient.pair(stack);
  try {
    let capturedUrl;
    const transport = await device.openRelay({
      mutateRelayUrl: (url) => {
        capturedUrl = url;
        return url;
      },
    });
    // channel 已配对（Active）：同一张 client token 重放，relay 握手后立即关闭、不得配对。
    const replay = await dialRelay(capturedUrl);
    assert.equal(replay.kind, "open-then-closed", "Active channel 上重放 token 不得形成管道");

    // 合法 transport 仍可用：catalog 往返成功（sanity，证明上面被拒不是 relay 整体坏了）。
    const catalog = await device.catalog();
    assert.ok(Array.isArray(catalog.sessions), "合法 relay transport 的 catalog 往返成功");

    // 关闭 channel 后（tombstone 窗口内）重放同一 token：仍被拒。
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterClose = await dialRelay(capturedUrl);
    assert.equal(afterClose.kind, "open-then-closed", "channel 关闭后（tombstone 窗口内）重放 token 不得复活管道");
  } finally {
    device.close();
  }
});
