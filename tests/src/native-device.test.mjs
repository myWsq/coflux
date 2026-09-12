// Real native transport business coverage: exec, binary IO, denial and control recovery.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startStack, mkRepo } from "./harness.mjs";
import { openNativeDevice, DeviceClient, utf8 } from "./device-harness.mjs";

const PORT = 8859;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

async function importWorkspace(device) {
  const repo = mkRepo();
  repos.push(repo);
  writeFileSync(join(repo.dir, "README.md"), "# native\nhello over datachannel\n");
  device.control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await device.control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main ws");
  await device.waitWorkspaceReady(main.workspace.id);
  return main.workspace;
}

test("native connection executes real DeviceEnvelope RPC", async () => {
  const device = await openNativeDevice(stack);
  const ws = await importWorkspace(device);
  const r = await device.request("execRun", "execResult", {
    requestId: "native-e1",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", "console.log('native', 6 * 7)"],
    env: {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /native 42/);
  device.close();
});

test("native transport preserves 400 KiB binary uploads and file reads", async () => {
  const device = await openNativeDevice(stack);
  const ws = await importWorkspace(device);
  // Exercise a payload substantially larger than an ordinary interactive frame.
  const payload = new Uint8Array(400 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const wrote = await device.request("fsWrite", "fsWriteResult", {
    requestId: "native-w1",
    operationId: randomUUID(),
    workspaceId: ws.id,
    path: ".coflux/pastes/native-large.bin",
    data: payload,
    temp: false,
  }, { timeout: 20000 });
  assert.equal(wrote.ok, true);
  const read = await device.request("fsRead", "fsReadResult", {
    requestId: "native-r1",
    workspaceId: ws.id,
    path: ".coflux/pastes/native-large.bin",
  }, { timeout: 20000 });
  assert.equal(read.ok, true);
  // fsRead 以 utf8 文本回带会破坏二进制；内容一致性用长度 + 抽样字节校验由 exec 侧做。
  const digest = await device.request("execRun", "execResult", {
    requestId: "native-d1",
    workspaceId: ws.id,
    command: "node",
    args: ["-e", `const b = require('fs').readFileSync('.coflux/pastes/native-large.bin'); let ok = b.length === ${payload.length}; for (let i = 0; i < b.length; i++) if (b[i] !== i % 251) { ok = false; break; } console.log('DIGEST', ok)`],
    env: {},
  });
  assert.match(digest.stdout, /DIGEST true/);
  device.close();
});

test("native rendezvous rejects nonexistent devices within the bounded deadline", async () => {
  const device = await DeviceClient.pair(stack, {});
  await assert.rejects(
    device.openNative({ daemonId: "daemon-does-not-exist", timeout: 1200 }),
    (error) => /设备尚未提供原生远程连接/.test(error.message),
  );
  device.close();
});

test("中心重启：旧 native channel 被 worker 摘除不再服务，daemon 重连后可建新 native", async () => {
  const device = await openNativeDevice(stack);
  let fresh;
  try {
    const ws = await importWorkspace(device);
    const alive = await device.request("execRun", "execResult", {
      requestId: "native-e2",
      workspaceId: ws.id,
      command: "node",
      args: ["-e", "console.log('pre-disconnect ok')"],
      env: {},
    });
    assert.equal(alive.ok, true);

    // The worker retires existing channel authority when central control disconnects.
    await stack.restartServer();
    await stack.waitDaemonOnline();
    const from = device.mark();
    let staleSendError;
    try {
      device.send("sessionCatalogRequest", { requestId: "native-stale" });
    } catch (error) {
      staleSendError = error;
    }
    if (staleSendError) {
      assert.match(String(staleSendError), /Device transport send failed/);
    } else {
      await assert.rejects(
        device.waitFor((m) => m.requestId === "native-stale", "stale response", 3000, from),
        /timeout/,
        "close_natives 之后旧 channel 不得再被 runtime 服务",
      );
    }

    // daemon 重连新中心后，新的信令/建连必须可用（恢复能力）。
    fresh = await openNativeDevice(stack);
    const revived = await fresh.request("execRun", "execResult", {
      requestId: "native-e3",
      workspaceId: ws.id,
      command: "node",
      args: ["-e", "console.log('post-restart', 6 * 7)"],
      env: {},
    });
    assert.equal(revived.ok, true);
    assert.match(revived.stdout, /post-restart 42/);
  } finally {
    fresh?.close();
    device.close();
  }
});
