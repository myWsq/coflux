/**
 * 多 relay home 选择（plan 065）：真实 worker 探测两个真实 relay，中心按 home 给双端指路；
 * home 故障后切到存活节点；不认识新消息、因而从不上报 home 的旧 worker 回退清单首项。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DEVICE_PROTOCOL_VERSION } from "@coflux/protocol";

import {
  authorizeDaemon,
  killTree,
  makeRelayKeys,
  spawnDaemon,
  spawnRelay,
  startServer,
  tokenFromUrl,
} from "./harness.mjs";
import { DeviceClient } from "./device-harness.mjs";

const PORT = 8855;

/** 只延迟 healthz 首包，WS 数据面原样转发：稳定制造“远节点”，又保持它可实际配对 channel。 */
async function startHealthDelayedProxy(targetPort, delayMs) {
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = net.createServer((clientSocket) => {
    const client = track(clientSocket);
    const upstream = track(net.connect({ host: "127.0.0.1", port: targetPort }));
    client.once("data", (first) => {
      client.pause();
      const delay = first.subarray(0, 32).toString("ascii").startsWith("GET /healthz ") ? delayMs : 0;
      setTimeout(() => {
        if (client.destroyed || upstream.destroyed) return;
        upstream.write(first);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      }, delay);
    });
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function relayPort(url) {
  return Number(new URL(url).port);
}

async function waitForGrantPort(control, daemonId, expectedPort, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let generation = BigInt(Date.now());
  while (Date.now() < deadline) {
    const channelId = `relay-home-${randomUUID()}`;
    generation += 1n;
    control.send({
      case: "deviceRelayConnect",
      daemonId,
      channelId,
      clientInstanceId: "relay-home-test-client",
      transportGeneration: generation,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    });
    const grant = await control.waitFor(
      (message) => message.case === "deviceRelayGrant" && message.channelId === channelId,
      `deviceRelayGrant ${channelId}`,
      4_000,
    );
    assert.equal(grant.ok, true, grant.error ?? "rendezvous 应成功");
    if (relayPort(grant.relayUrl) === expectedPort) return grant;
    await sleep(100);
  }
  throw new Error(`rendezvous 未切到 relay port ${expectedPort}`);
}

test("daemon home 决定双端 relay，home 故障自愈；旧 worker 回退首项", { timeout: 60_000 }, async () => {
  const keys = makeRelayKeys();
  let relayFar;
  let relayNear;
  let delayed;
  let server;
  let daemon;
  let home;
  let observer;
  let device;
  let oldDaemon;
  let oldAuthorizer;
  let oldControl;

  try {
    relayFar = await spawnRelay(keys.pubHex);
    relayNear = await spawnRelay(keys.pubHex);
    delayed = await startHealthDelayedProxy(relayFar.port, 90);
    server = await startServer({
      port: PORT,
      manageRelay: false,
      env: {
        COFLUX_USERNAME: "admin",
        COFLUX_PASSWORD: "admin",
        COFLUX_RELAY_SIGNING_KEY: keys.seedHex,
        COFLUX_RELAY_NODES: JSON.stringify([
          { id: "far-primary", url: `ws://127.0.0.1:${delayed.port}` },
          { id: "near", url: `ws://127.0.0.1:${relayNear.port}` },
        ]),
      },
    });

    home = mkdtempSync(join(tmpdir(), "coflux-test-relay-home-"));
    daemon = spawnDaemon({
      ...process.env,
      COFLUX_SERVER: `ws://127.0.0.1:${PORT}/daemon`,
      COFLUX_HOME: home,
      COFLUX_DEVICE_NAME: "multi-relay-dev",
      COFLUX_LOCAL_GATEWAY_PORT: "0",
      COFLUX_RELAY_PROBE_INTERVAL_MS: "250",
      COFLUX_RELAY_PROBE_TIMEOUT_MS: "1000",
      COFLUX_CONNECT_TIMEOUT_MS: "1000",
    });
    await authorizeDaemon(PORT, home);

    observer = server.makeClient();
    const snapshot = await observer.authSubscribe();
    const daemonInfo = snapshot.daemons.find((entry) => entry.name === "multi-relay-dev" && entry.online);
    assert.ok(daemonInfo, "真实 daemon 已在线");
    const daemonId = daemonInfo.daemonId;

    // 清单首项是 far；最终 URL 落 near 只能来自 worker 探测并上报的 home。
    const nearGrant = await waitForGrantPort(observer, daemonId, relayNear.port);
    assert.equal(relayPort(nearGrant.relayUrl), relayNear.port);

    const deviceStack = { ...server, username: "admin", password: "admin", daemonId };
    device = await DeviceClient.pair(deviceStack);
    let clientHomeUrl;
    await device.openRelay({ mutateRelayUrl: (url) => (clientHomeUrl = url) });
    assert.equal(relayPort(clientHomeUrl), relayNear.port, "client 被指到 daemon home");
    assert.ok(Array.isArray((await device.catalog()).sessions), "同节点上的 daemon/client 两端能完成实际配对");

    // home 进程消失：拨号失败会立即唤醒重探，周期探测也兜底；下一次 rendezvous 改指存活首项。
    device.closeTransport(true);
    killTree(relayNear.process);
    const failoverGrant = await waitForGrantPort(observer, daemonId, delayed.port);
    assert.equal(relayPort(failoverGrant.relayUrl), delayed.port);

    let failoverClientUrl;
    await device.openRelay({ mutateRelayUrl: (url) => (failoverClientUrl = url) });
    assert.equal(relayPort(failoverClientUrl), delayed.port, "切换后 client 也使用新 home");
    assert.ok(Array.isArray((await device.catalog()).sessions), "故障切换后的同节点双端管道可配对");

    // 裸 daemon 收到新 relayNodeList 但刻意不发 relayHome，等价模拟 prost 忽略未知 oneof 的旧 worker。
    oldDaemon = server.rawDaemon();
    await oldDaemon.ready;
    oldDaemon.send({
      case: "daemonEnrollRequest",
      name: "old-worker",
      host: "legacy-host",
      platform: "test",
      workerVersion: "builtin",
      supervisorVersion: "test",
      arch: "x86_64",
    });
    const pending = await oldDaemon.waitFor((message) => message.case === "daemonAuthorizePending", "old authorizePending");
    oldAuthorizer = server.makeClient();
    await oldAuthorizer.authSubscribe();
    oldAuthorizer.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
    await oldAuthorizer.waitFor((message) => message.case === "deviceAuthorized", "old deviceAuthorized");
    const enrolled = await oldDaemon.waitFor((message) => message.case === "daemonEnrolled", "old daemonEnrolled");
    const list = await oldDaemon.waitFor((message) => message.case === "relayNodeList", "old relayNodeList");
    assert.deepEqual(list.nodes.map((node) => node.id), ["far-primary", "near"]);

    oldControl = server.makeClient();
    await oldControl.authSubscribe();
    const channelId = `old-fallback-${randomUUID()}`;
    const dialPromise = oldDaemon.waitFor(
      (message) => message.case === "deviceRelayDial" && message.channelId === channelId,
      "old deviceRelayDial",
    );
    oldControl.send({
      case: "deviceRelayConnect",
      daemonId: enrolled.daemonId,
      channelId,
      clientInstanceId: "old-worker-client",
      transportGeneration: 1n,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    });
    const grantPromise = oldControl.waitFor(
      (message) => message.case === "deviceRelayGrant" && message.channelId === channelId,
      "old deviceRelayGrant",
    );
    const [dial, grant] = await Promise.all([dialPromise, grantPromise]);
    assert.equal(relayPort(dial.relayUrl), delayed.port, "未上报 home 的 daemon 端回退首项");
    assert.equal(relayPort(grant.relayUrl), delayed.port, "同一 channel 的 client 端也回退同一首项");
  } finally {
    oldControl?.close();
    oldAuthorizer?.close();
    oldDaemon?.close();
    device?.close();
    observer?.close();
    killTree(daemon);
    await server?.stop();
    await delayed?.close();
    killTree(relayNear?.process);
    killTree(relayFar?.process);
    if (home) rmSync(home, { recursive: true, force: true });
  }
});
