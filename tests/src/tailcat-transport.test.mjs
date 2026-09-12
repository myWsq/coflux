import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHmac, randomUUID, createHash, X509Certificate } from "node:crypto";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { create, DeviceEnvelopeSchema, DEVICE_PROTOCOL_VERSION, encodeDeviceEnvelope, decodeDeviceEnvelope, TaskStatus } from "@coflux/protocol";
import { DeviceClient } from "./device-harness.mjs";
import { mkRepo, startStack } from "./harness.mjs";
import { TailcatTestHelper } from "./tailcat-harness.mjs";

const PORT = 8896;
const enabled = process.env.COFLUX_TEST_TAILCAT === "1";
async function freePort() { const server = net.createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }

test("native grant authorizes real DeviceEnvelope traffic and central revocation closes it", { skip: !enabled, timeout: 120_000 }, async () => {
  const binary = resolve(process.env.COFLUX_TRANSPORT_BIN || resolve(import.meta.dirname, "../../target/debug/coflux-transport"));
  const derperBinary = process.env.COFLUX_TEST_DERPER_BIN;
  assert(existsSync(binary), "build the native helper beside the worker first"); assert(derperBinary && existsSync(derperBinary), "COFLUX_TEST_DERPER_BIN must name the pinned stock DERP binary");
  const dir = mkdtempSync(join(tmpdir(), "coflux-tailcat-test-"));
  let derper, stack, control, helper, repo;
  try {
    const port = await freePort();
    const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "127.0.0.1.key"), "-out", join(dir, "127.0.0.1.crt"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" }); assert.equal(cert.status, 0);
    derper = spawn(derperBinary, ["-a", `127.0.0.1:${port}`, "-http-port", "-1", "-stun=false", "-hostname", "127.0.0.1", "-certmode", "manual", "-certdir", dir, "-c", join(dir, "derper.json")], { stdio: "ignore" });
    for (let attempt = 0; ; attempt++) {
      assert.equal(derper.exitCode, null, "stock DERP exited during startup; check certificate SAN and listener configuration");
      const ready = await new Promise(resolve => { const socket = net.connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); });
      if (ready) break; assert(attempt < 50, "stock DERP listener did not start"); await sleep(100);
    }
    const pin = createHash("sha256").update(new X509Certificate(readFileSync(join(dir, "127.0.0.1.crt"))).raw).digest("hex");
    const region = { RegionID: 901, RegionCode: "test", Nodes: [{ Name: "test", RegionID: 901, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none", DERPPort: port, STUNPort: -1, CertName: `sha256-raw:${pin}` }] };
    stack = await startStack({ port: PORT, strictCleanup: true, serverEnv: { COFLUX_DERP_REGIONS: JSON.stringify([region]) }, daemonEnv: { COFLUX_TAILCAT: "1" } });
    control = stack.makeClient(); await control.authSubscribe();
    helper = new TailcatTestHelper(binary); await helper.request("hello", { version: 1 });
    const connection = randomUUID(); const { publicKey } = await helper.request("prepare", { connection });
    let grant, channel;
    for (let attempt = 0; attempt < 50; attempt++) {
      channel = randomUUID();
      control.send({ case: "deviceTailcatConnect", daemonId: stack.daemonId, channelId: channel, clientInstanceId: "native-blackbox", transportGeneration: 1n, protocolVersion: DEVICE_PROTOCOL_VERSION, nodePublicKey: publicKey, scope: 2 });
      grant = await control.waitFor(m => m.case === "deviceTailcatResult" && m.channelId === channel, "native grant");
      if (grant.ok) break; await sleep(200);
    }
    assert.equal(grant.ok, true, grant.error); assert.equal(grant.proofKey.length, 32);
    const stream = 1;
    await helper.request("open", { connection, stream, address: grant.address });
    helper.send(stream, Buffer.from(JSON.stringify({ channelId: channel })));
    const nonce = (await helper.wait(f => f.kind === 2 && f.stream === stream)).payload; assert.equal(nonce.length, 32);
    const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(channel));
    const proof = createHmac("sha256", grant.proofKey).update("coflux-tailcat-channel-v1\0").update(length).update(channel).update(nonce).digest();
    helper.send(stream, proof); assert.equal((await helper.wait(f => f.kind === 2 && f.stream === stream)).payload.toString(), "ok");
    const requestId = randomUUID();
    helper.send(stream, encodeDeviceEnvelope(create(DeviceEnvelopeSchema, { protocolVersion: DEVICE_PROTOCOL_VERSION, channelId: channel, payload: { case: "sessionCatalogRequest", value: { requestId } } })));
    const response = decodeDeviceEnvelope((await helper.wait(f => f.kind === 2 && f.stream === stream)).payload);
    assert.equal(response.payload.case, "sessionCatalog"); assert.equal(response.payload.value.requestId, requestId);
    const forbidden = randomUUID();
    helper.send(stream, encodeDeviceEnvelope(create(DeviceEnvelopeSchema, { protocolVersion: DEVICE_PROTOCOL_VERSION, channelId: channel, payload: { case: "fsRead", value: { requestId: forbidden, path: "/etc/passwd" } } })));
    const denied = decodeDeviceEnvelope((await helper.wait(f => f.kind === 2 && f.stream === stream)).payload);
    assert.equal(denied.payload.case, "error"); assert.equal(denied.payload.value.requestId, forbidden);
    const bindDevice = (id, laneStream, generation) => {
      const device = new DeviceClient(stack, { control, clientInstanceId: "native-blackbox" });
      const unsubscribe = helper.subscribe(laneStream, frame => { const envelope = decodeDeviceEnvelope(frame); if (envelope) device.receive(envelope, "tailcat", id); });
      device.replaceTransport({ channelId: id, generation, send: frame => { helper.send(laneStream, frame); return true; }, close: () => {}, unsubscribe });
      return device;
    };
    const session = bindDevice(channel, stream, 1n);
    const elevatedChannel = randomUUID();
    control.send({ case: "deviceTailcatConnect", daemonId: stack.daemonId, channelId: elevatedChannel, clientInstanceId: "native-blackbox", transportGeneration: 2n, protocolVersion: DEVICE_PROTOCOL_VERSION, nodePublicKey: publicKey, scope: 4 });
    const elevatedGrant = await control.waitFor(m => m.case === "deviceTailcatResult" && m.channelId === elevatedChannel, "elevated native grant"); assert.equal(elevatedGrant.ok, true);
    await helper.request("open", { connection, stream: 2, address: elevatedGrant.address });
    helper.send(2, Buffer.from(JSON.stringify({ channelId: elevatedChannel })));
    const elevatedNonce = (await helper.wait(f => f.kind === 2 && f.stream === 2)).payload;
    const elevatedLength = Buffer.alloc(4); elevatedLength.writeUInt32BE(Buffer.byteLength(elevatedChannel));
    helper.send(2, createHmac("sha256", elevatedGrant.proofKey).update("coflux-tailcat-channel-v1\0").update(elevatedLength).update(elevatedChannel).update(elevatedNonce).digest());
    assert.equal((await helper.wait(f => f.kind === 2 && f.stream === 2)).payload.toString(), "ok");
    const elevated = bindDevice(elevatedChannel, 2, 2n);
    repo = mkRepo();
    control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir, name: "native-acceptance" });
    elevated.executePrepared(await elevated.waitPrepared("projectValidate"));
    const workspace = (await control.waitFor(m => m.case === "workspaceCreated" && m.workspace.isMain, "native workspace")).workspace;
    await elevated.waitWorkspaceReady(workspace.id);
    const executed = await elevated.request("execRun", "execResult", { workspaceId: workspace.id, command: "/bin/sh", args: ["-c", "printf NATIVE_EXEC"], env: {} });
    assert.equal(executed.stdout, "NATIVE_EXEC");
    const content = "native-file\n".repeat(6000);
    const written = await elevated.request("fsWrite", "fsWriteResult", { operationId: randomUUID(), workspaceId: workspace.id, path: "native.txt", data: new TextEncoder().encode(content), temp: false }); assert.equal(written.ok, true);
    const read = await elevated.request("fsRead", "fsReadResult", { workspaceId: workspace.id, path: "native.txt" }); assert.equal(read.content, content);
    const binaryData = Buffer.allocUnsafe(8 * 1024 * 1024);
    let seed = 0x12345678;
    for (let index = 0; index < binaryData.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; binaryData[index] = seed >>> 24; }
    const binaryWrite = await elevated.request("fsWrite", "fsWriteResult", { operationId: randomUUID(), workspaceId: workspace.id, path: "native.bin", data: binaryData, temp: false });
    assert.equal(binaryWrite.ok, true);
    const binaryRead = await elevated.request("execRun", "execResult", { workspaceId: workspace.id, command: "/bin/sh", args: ["-c", "base64 < native.bin"], env: {} }, { timeout: 30_000 });
    assert.equal(binaryRead.ok, true);
    assert.deepEqual(Buffer.from(binaryRead.stdout, "base64"), binaryData, "8 MiB binary must roundtrip through real application frames without encoding loss");
    assert.deepEqual(readFileSync(join(repo.dir, "native.bin")), binaryData, "independent filesystem oracle must match uploaded bytes");
    control.send({ case: "taskCreate", workspaceId: workspace.id, title: "native terminal" });
    const task = (await control.waitFor(m => m.case === "taskUpdated" && m.task.title === "native terminal", "native task")).task;
    control.send({ case: "taskStart", taskId: task.id, cols: 80, rows: 24 });
    elevated.executePrepared(await elevated.waitPrepared("sessionCreate"));
    const running = (await control.waitFor(m => m.case === "taskUpdated" && m.task.id === task.id && m.task.status === TaskStatus.RUNNING, "native running")).task;
    await session.attach(running.sessionId);
    const from = session.mark();
    await session.input(running.sessionId, "printf NATIVE_PTY_OK\n");
    await session.waitFor(m => m.case === "ptyOutput" && Buffer.from(m.data).includes(Buffer.from("NATIVE_PTY_OK")), "native PTY output", 10_000, from);
    await session.resize(running.sessionId, 100, 35);
    await session.input(running.sessionId, "stty size\n");
    await session.waitFor(m => m.case === "ptyOutput" && Buffer.from(m.data).includes(Buffer.from("35 100")), "native PTY resize", 10_000, from);
    assert((await session.catalog()).sessions.some(entry => entry.sessionId === running.sessionId));
    control.send({ case: "deviceTailcatClose", channelId: elevatedChannel });
    await helper.wait(f => f.event?.op === "closed" && f.stream === 2);
    session.transport.unsubscribe(); elevated.transport.unsubscribe();
    control.send({ case: "deviceTailcatClose", channelId: channel });
    await helper.wait(f => f.event?.op === "closed" && f.stream === stream);
    await helper.request("drop", { connection });
  } finally {
    control?.close();
    const results = await Promise.allSettled([helper?.stop(), stack?.stop(), (async () => {
      if (derper && derper.exitCode === null) { const exited = new Promise(r => derper.once("exit", r)); derper.kill("SIGTERM"); const force = setTimeout(() => derper.kill("SIGKILL"), 2000); await exited; clearTimeout(force); }
    })()]);
    repo?.cleanup(); rmSync(dir, { recursive: true, force: true });
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "native test cleanup failed");
  }
});
