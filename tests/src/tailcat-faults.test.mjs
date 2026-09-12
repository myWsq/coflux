import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { TailcatTestHelper, openNativeTestDevice } from "./tailcat-harness.mjs";
const PORT = 8898;
const ROOT = resolve(import.meta.dirname, "../..");
async function freePort() { const server = net.createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
async function stopProcess(child) { if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return; await new Promise(resolve => { const force = setTimeout(() => child.kill("SIGKILL"), 2000); child.once("exit", () => { clearTimeout(force); resolve(); }); child.kill("SIGTERM"); }); }

test("native initial-region outage, serving helper crash, region failover and control grace preserve PTYs", { timeout: 180_000 }, async () => {
  const derperBinary = process.env.COFLUX_TEST_DERPER_BIN || join(ROOT, "target/debug/coflux-test-derper");
  const dir = mkdtempSync(join(tmpdir(), "coflux-native-fault-"));
  const derpers = []; const controls = []; let stack, helper, repo;
  const phase = message => console.log(`[native faults ${new Date().toISOString()}] ${message}`);
  const servingHelperPid = () => {
    const workerPid = readFileSync(join(stack.home, "worker.pid"), "utf8").trim();
    const children = spawnSync("pgrep", ["-P", workerPid], { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
    const pid = children.find(pid => /coflux-transport$/.test(spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" }).stdout.trim()));
    assert(pid, "isolated serving helper must be identifiable");
    return Number(pid);
  };
  const revokedAndClosed = async (device, control, timeout) => {
    await control.waitFor(message => message.case === "deviceTailcatClosed" && message.channelId === device.nativeChannelId, "central native channel revocation", timeout);
    await helper.wait(frame => frame.event?.op === "closed" && frame.stream === device.nativeStream, 5000);
    await device.disposeNative();
  };
  try {
    const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "127.0.0.1.key"), "-out", join(dir, "127.0.0.1.crt"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" }); assert.equal(cert.status, 0);
    const pin = createHash("sha256").update(new X509Certificate(readFileSync(join(dir, "127.0.0.1.crt"))).raw).digest("hex");
    const ports = [];
    while (ports.length < 3) {
      const port = await freePort();
      if (!ports.includes(port)) ports.push(port);
    }
    const startDerper = async (index) => {
      const child = spawn(derperBinary, ["-a", `127.0.0.1:${ports[index]}`, "-http-port", "-1", "-stun=false", "-hostname", "127.0.0.1", "-certmode", "manual", "-certdir", dir, "-c", join(dir, `derper-${index}.json`)], { stdio: ["ignore", "ignore", "pipe"] });
      derpers[index] = child;
      let output = "";
      let spawnError;
      child.stderr.on("data", bytes => { output = (output + bytes).slice(-8192); });
      child.once("error", error => { spawnError = error; });
      for (let tries = 0; ; tries++) {
        assert.ifError(spawnError);
        assert.equal(child.exitCode, null, `DERP exited before ready: ${output}`);
        assert.equal(child.signalCode, null, `DERP terminated before ready: ${output}`);
        const ready = await new Promise(resolve => {
          const socket = net.connect(ports[index], "127.0.0.1");
          socket.once("connect", () => { socket.destroy(); resolve(true); });
          socket.once("error", () => resolve(false));
        });
        if (ready) return;
        assert(tries < 50, `DERP did not start: ${output}`);
        await sleep(100);
      }
    };
    await startDerper(1);
    await startDerper(2);
    const regions = ports.map((port, index) => ({ RegionID: 901 + index, RegionCode: `test${index}`, Nodes: [{ Name: `node${index}`, RegionID: 901 + index, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none", DERPPort: port, STUNPort: -1, CertName: `sha256-raw:${pin}` }] }));
    phase("start stack with first DERP unreachable");
    const started = Date.now();
    stack = await startStack({ port: PORT, strictCleanup: true, serverEnv: { COFLUX_DERP_REGIONS: JSON.stringify(regions) }, daemonEnv: {} });
    const login = async () => { const control = stack.makeClient(); controls.push(control); await control.authSubscribe(); return control; };
    let control = await login();
    helper = new TailcatTestHelper(process.env.COFLUX_TRANSPORT_BIN || join(ROOT, "target/debug/coflux-transport")); await helper.request("hello", { version: 1 });
    let elevated = await openNativeTestDevice(stack, helper, { control, scope: 4 });
    assert(Date.now() - started < 30_000, "initial unreachable region must recover within 30 seconds");
    phase(`initial region recovery: ${Date.now() - started} ms`);
    // Restore the first region before the independent runtime outage. Otherwise
    // that phase would combine two failed regions and a second health window.
    await startDerper(0);
    repo = mkRepo(); control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir }); elevated.executePrepared(await elevated.waitPrepared("projectValidate"));
    const workspace = (await control.waitFor(m => m.case === "workspaceCreated" && m.workspace.isMain, "fault workspace")).workspace;
    control.send({ case: "taskCreate", workspaceId: workspace.id, title: "fault continuity" });
    const task = (await control.waitFor(m => m.case === "taskUpdated" && m.task.title === "fault continuity", "fault task")).task;
    control.send({ case: "taskStart", taskId: task.id, cols: 80, rows: 24 }); elevated.executePrepared(await elevated.waitPrepared("sessionCreate"));
    const running = (await control.waitFor(m => m.case === "taskUpdated" && m.task.id === task.id && m.task.status === TaskStatus.RUNNING, "fault running")).task;
    let session = await openNativeTestDevice(stack, helper, { control, scope: 2 }); await session.attach(running.sessionId);
    const pid = (await session.catalog()).sessions.find(value => value.sessionId === running.sessionId)?.pid; assert(pid > 0);
    await session.input(running.sessionId, "echo NATIVE_FAULT_BEFORE\r");
    // Kill only a helper proven to belong to this fixture's isolated worker.
    const helperPid = servingHelperPid();
    const crashedAt = Date.now();
    phase(`kill serving helper ${helperPid}; wait for central revocation and local stream disposal`);
    process.kill(helperPid, "SIGKILL");
    await revokedAndClosed(session, control, 15_000);
    phase("helper crash old lane disposed; reconnect");
    session = await openNativeTestDevice(stack, helper, { control, generation: 2n }); await session.attach(running.sessionId);
    assert.equal((await session.catalog()).sessions.find(value => value.sessionId === running.sessionId)?.pid, pid);
    assert(Date.now() - crashedAt < 30_000, "serving helper crash must recover within 30 seconds");
    phase(`serving helper recovery: ${Date.now() - crashedAt} ms`);
    // The first successful region is 902. The serving helper restart rotates to
    // 903; stopping it now leaves the restored 901 and 902 available.
    phase("stop active DERP region 903; wait for central revocation");
    const failedAt = Date.now(); await stopProcess(derpers[2]);
    await revokedAndClosed(session, control, 25_000);
    phase("DERP outage old lane disposed; reconnect");
    session = await openNativeTestDevice(stack, helper, { control, generation: 3n, timeout: 30_000 });
    assert(Date.now() - failedAt < 30_000, "runtime region outage must recover within 30 seconds");
    phase(`runtime region recovery: ${Date.now() - failedAt} ms`);
    await session.attach(running.sessionId); assert.equal((await session.catalog()).sessions.find(value => value.sessionId === running.sessionId)?.pid, pid);
    elevated = await openNativeTestDevice(stack, helper, { control, scope: 4, generation: 3n });
    phase("close client control; verify remote elevated revoke and session grace");
    const outage = Date.now(); control.close();
    await helper.wait(f => f.event?.op === "closed" && f.stream === elevated.nativeStream, 4000);
    assert((await session.catalog()).sessions.some(value => value.sessionId === running.sessionId), "opened session lane remains usable during control grace");
    await helper.wait(f => f.event?.op === "closed" && f.stream === session.nativeStream, 17_000);
    assert(Date.now() - outage >= 14_000, "session grace must not be mistaken for immediate hard revoke");
    phase("client grace expired; reconnect before server outage");
    control = await login();
    // Deliberately ignore central revocation here: prove worker authority closes
    // even if an uncooperative client retains its old WireGuard stream.
    session = await openNativeTestDevice(stack, helper, { control, generation: 4n, followControlRevocation: false });
    await session.attach(running.sessionId);
    assert.equal((await session.catalog()).sessions.find(value => value.sessionId === running.sessionId)?.pid, pid);
    const oldHelperPid = servingHelperPid();
    phase(`stop server; verify serving helper ${oldHelperPid} exits and stale requests fail`);
    const stoppedAt = Date.now();
    await stack.stopServer();
    for (;;) {
      let alive = true;
      try { process.kill(oldHelperPid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
      if (!alive) break;
      assert(Date.now() - stoppedAt < 5000, "worker must retire its serving helper immediately on control loss");
      await sleep(50);
    }
    const staleRequest = randomUUID(), staleFrom = session.mark();
    session.send("sessionCatalogRequest", { requestId: staleRequest });
    await sleep(3000);
    assert(!session.log.slice(staleFrom).some(message => message.case === "sessionCatalog" && message.requestId === staleRequest), "stale native channel must not execute catalog requests after worker control loss");
    await session.disposeNative();
    phase("worker authority retired; restart server and acquire fresh grant");
    await stack.restartServer(); control = await login(); session = await openNativeTestDevice(stack, helper, { control, generation: 5n }); await session.attach(running.sessionId);
    assert.equal((await session.catalog()).sessions.find(value => value.sessionId === running.sessionId)?.pid, pid);
    const from = session.mark(); await session.input(running.sessionId, "printf 'NATIVE_FAULT_%s\\n' AFTER\r", { inputSeq: 2n });
    await session.waitFor(m => m.case === "ptyOutput" && Buffer.from(m.data).includes(Buffer.from("NATIVE_FAULT_AFTER")), "PTY survives native faults", 10_000, from);
    phase("all fault phases retained PTY PID and input/output");
  } finally {
    for (const control of controls) control.close();
    const results = await Promise.allSettled([helper?.stop(), stack?.stop(), ...derpers.filter(Boolean).map(stopProcess)]);
    repo?.cleanup(); rmSync(dir, { recursive: true, force: true });
    const failed = results.filter(result => result.status === "rejected"); if (failed.length) throw new AggregateError(failed.map(result => result.reason), "native fault cleanup");
  }
});
