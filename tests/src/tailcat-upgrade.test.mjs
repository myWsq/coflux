// Signed companion updates use isolated processes, keys, files, and loopback HTTP.
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { arch, platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";
import { workerReleaseStatement, transportReleaseStatement } from "../../scripts/release-statement.mjs";
const PORT = 8897;
const ROOT = resolve(import.meta.dirname, "../..");
const enabled = process.env.COFLUX_TEST_TAILCAT === "1";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function until(predicate, label, timeout = 20_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { if (await predicate()) return; } catch {} await sleep(100); } throw new Error(`timeout: ${label}`); }

test("signed worker/helper pair activates together and rejects tamper or failed helper without losing PTYs", { skip: !enabled, timeout: 100_000 }, async () => {
  const worker = readFileSync(process.env.COFLUX_WORKER_BIN || join(ROOT, "target/debug/coflux-worker"));
  const helper = readFileSync(process.env.COFLUX_TRANSPORT_BIN || join(ROOT, "target/debug/coflux-transport"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const sign = bytes => crypto.sign(null, bytes, privateKey).toString("hex");
  const target = platform() === "darwin" ? `${arch() === "arm64" ? "aarch64" : "x86_64"}-apple-darwin` : `${arch() === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
  let servedHelper = helper;
  const server = http.createServer((req, res) => { if (req.url === "/worker") res.end(worker); else if (req.url === "/helper") res.end(servedHelper); else res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const release = (version, companion = helper) => ({ version, url: `${base}/worker`, target, sha256: hash(worker), signature: sign(worker), artifactSize: BigInt(worker.length), releaseSignature: sign(workerReleaseStatement({ version, target, sha256: hash(worker), size: worker.length })), transport: { url: `${base}/helper`, sha256: hash(companion), size: BigInt(companion.length), releaseSignature: sign(transportReleaseStatement({ version, target, sha256: hash(companion), size: companion.length })) } });
  let stack, device, repo;
  try {
    stack = await startStack({ port: PORT, strictCleanup: true, daemonEnv: { COFLUX_WORKER_PUBKEY: publicHex, COFLUX_WORKER_PROBATION_MS: "2000" } });
    device = await openRelayDevice(stack); repo = mkRepo();
    const control = device.control;
    control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
    const workspace = (await control.waitFor(m => m.case === "workspaceCreated" && m.workspace.isMain, "paired workspace")).workspace;
    control.send({ case: "taskCreate", workspaceId: workspace.id, title: "paired upgrade" });
    const task = (await control.waitFor(m => m.case === "taskUpdated" && m.task.title === "paired upgrade", "paired task")).task;
    control.send({ case: "taskStart", taskId: task.id, cols: 80, rows: 24 });
    const running = (await control.waitFor(m => m.case === "taskUpdated" && m.task.id === task.id && m.task.status === TaskStatus.RUNNING, "paired running")).task;
    await device.attach(running.sessionId); await device.input(running.sessionId, "echo PAIR_BEFORE\r");
    const originalPid = (await device.catalog()).sessions.find(s => s.sessionId === running.sessionId)?.pid;
    assert(originalPid > 0);
    const active = () => readFileSync(join(stack.home, "worker.active"), "utf8").trim();
    const send = metadata => control.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, ...metadata });
    servedHelper = Buffer.from(helper); servedHelper[0] ^= 0xff;
    send(release("v2.0.0")); await sleep(2500);
    assert.equal(active(), "builtin"); assert.equal(existsSync(join(stack.home, "workers/v2.0.0/coflux-worker")), false);
    servedHelper = helper; send(release("v2.0.0")); await until(() => active() === "v2.0.0", "complete pair activation");
    assert.equal(hash(readFileSync(join(stack.home, "workers/v2.0.0/coflux-transport"))), hash(helper));
    assert(existsSync(join(stack.home, "workers/v2.0.0/transport-pair.json")));
    await device.openRelay(); await device.attach(running.sessionId);
    assert.equal((await device.catalog()).sessions.find(s => s.sessionId === running.sessionId)?.pid, originalPid);
    // A correctly signed executable that cannot speak helper IPC fails local
    // probation, so the prior complete release remains the active fallback.
    servedHelper = readFileSync("/usr/bin/false");
    send(release("v3.0.0", servedHelper));
    await until(() => existsSync(join(stack.home, "workers/v3.0.0/transport-pair.json")), "bad helper pair staged");
    await sleep(5000); assert.equal(active(), "v2.0.0");
    await device.openRelay(); const restored = await device.attach(running.sessionId);
    assert(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("PAIR_BEFORE"));
    assert.equal((await device.catalog()).sessions.find(s => s.sessionId === running.sessionId)?.pid, originalPid);
    const from = device.mark(); await device.input(running.sessionId, "echo PAIR_AFTER\r");
    await device.waitFor(m => m.case === "ptyOutput" && utf8(m.data).includes("PAIR_AFTER"), "PTY after pair rollback", 10_000, from);
  } finally {
    device?.close();
    const cleanup = await Promise.allSettled([stack?.stop(), new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })]);
    repo?.cleanup();
    const failed = cleanup.filter(result => result.status === "rejected"); if (failed.length) throw new AggregateError(failed.map(result => result.reason), "pair fixture cleanup");
  }
});
