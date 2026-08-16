// P2P WebRTC 直连黑盒（plan 076）。
//
// client 侧用 werift（纯 TS WebRTC 实现）与 worker 的 webrtc-rs 跨栈互通——两个独立
// WebRTC 栈之间的信令三角、ICE/DTLS/SCTP 建连、DataChannel 分片流都是被测面。
// 同机 host candidate 走完全链路，不测真实 NAT 打洞（那只能生产实测）。
// router 侧的竞争/promotion/回落状态机在 packages/client 单测覆盖，此处不重复。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startStack, mkRepo } from "./harness.mjs";
import { openP2pDevice, DeviceClient, utf8 } from "./device-harness.mjs";

const PORT = 8859;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

async function importWorkspace(device) {
  const repo = mkRepo();
  repos.push(repo);
  writeFileSync(join(repo.dir, "README.md"), "# p2p\nhello over datachannel\n");
  device.control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await device.control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
  await device.waitWorkspaceReady(main.workspace.id);
  return main.workspace;
}

test("P2P 建连 + exec 往返：信令三角、werift↔webrtc-rs 互通、帧过 DataChannel", async () => {
  const device = await openP2pDevice(stack);
  const ws = await importWorkspace(device);
  const r = await device.request("execRun", "execResult", {
    requestId: "p2p-e1",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", "console.log('P2P', 6 * 7)"],
    env: {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /P2P 42/);
  device.close();
});

test("大帧跨 chunk：>256KB 的 fsWrite 上行与 fsRead 下行都完整重组", async () => {
  const device = await openP2pDevice(stack);
  const ws = await importWorkspace(device);
  // 400KB > Chrome 单消息上限 256KB，也远超 16KiB chunk——上行要切 ~26 片。
  const payload = new Uint8Array(400 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const wrote = await device.request("fsWrite", "fsWriteResult", {
    requestId: "p2p-w1",
    operationId: randomUUID(),
    workspaceId: ws.id,
    path: ".coflux/pastes/p2p-large.bin",
    data: payload,
    temp: false,
  }, { timeout: 20000 });
  assert.equal(wrote.ok, true);
  const read = await device.request("fsRead", "fsReadResult", {
    requestId: "p2p-r1",
    workspaceId: ws.id,
    path: ".coflux/pastes/p2p-large.bin",
  }, { timeout: 20000 });
  assert.equal(read.ok, true);
  // fsRead 以 utf8 文本回带会破坏二进制；内容一致性用长度 + 抽样字节校验由 exec 侧做。
  const digest = await device.request("execRun", "execResult", {
    requestId: "p2p-d1",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", `const b = require('fs').readFileSync('.coflux/pastes/p2p-large.bin'); let ok = b.length === ${payload.length}; for (let i = 0; i < b.length; i++) if (b[i] !== i % 251) { ok = false; break; } console.log('DIGEST', ok)`],
    env: {},
  });
  assert.match(digest.stdout, /DIGEST true/);
  device.close();
});

test("中心校验：不存在的 daemonId 的 offer 被拒，回明确拒因而非挂死", async () => {
  const device = await DeviceClient.pair(stack, {});
  await assert.rejects(
    device.openP2p({ daemonId: "daemon-does-not-exist" }),
    (error) => error.rejected === true && /不在线|不属于/.test(error.message),
  );
  device.close();
});

test("中心重启：旧 P2P channel 被 worker 摘除不再服务，daemon 重连后可建新 P2P", async () => {
  const device = await openP2pDevice(stack);
  const ws = await importWorkspace(device);
  const alive = await device.request("execRun", "execResult", {
    requestId: "p2p-e2",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", "console.log('pre-disconnect ok')"],
    env: {},
  });
  assert.equal(alive.ok, true);

  // 重启中心：daemon 控制 WS 断开，worker 按语义 close_all 摘除全部 P2P channel。
  // webrtc-rs 的关闭对 werift 不可感知（只有 ~30s ICE 超时），所以不断言远端 close 事件；
  // 生产 client 在中心断开时主动对称清理（router 单测覆盖），不依赖对端传播。
  // 这里断言 worker 侧语义的可观察结果：旧 channel 上的 RPC 不再有任何响应。
  await stack.restartServer();
  const from = device.mark();
  device.send("sessionCatalogRequest", { requestId: "p2p-stale" });
  await assert.rejects(
    device.waitFor((m) => m.requestId === "p2p-stale", "stale response", 3000, from),
    /timeout/,
    "close_p2ps 之后旧 channel 不得再被 runtime 服务",
  );

  // daemon 重连新中心后，新的信令/建连必须可用（恢复能力）。
  const fresh = await openP2pDevice(stack);
  const revived = await fresh.request("execRun", "execResult", {
    requestId: "p2p-e3",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", "console.log('post-restart', 6 * 7)"],
    env: {},
  });
  assert.equal(revived.ok, true);
  assert.match(revived.stdout, /post-restart 42/);
  fresh.close();
  device.close();
});
