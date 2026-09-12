// A stock DERP server validates real node keys through the Coflux admission service.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { startDerpAdmission } from "../../apps/server/src/derp-admission.ts";
import { spawnDerp } from "./derp-harness.mjs";
test("stock DERP enforces registered nodes and fails closed during admission outage", { timeout: 30000 }, async () => {
  const children = new Set(), allowed = new Set(); let admission, derp, requests = 0;
  async function startAdmission(port = 0) {
    admission = startDerpAdmission(key => { requests++; return allowed.has(key); }, port);
    await once(admission, "listening"); return admission.address().port;
  }
  async function stopAdmission() { admission.closeAllConnections(); await new Promise(resolve => admission.close(resolve)); }
  async function probe(registered, expected, verifierExpected) {
    const before = requests;
    const child = spawn(resolve(import.meta.dirname, "../../target/debug/coflux-test-admission"), [`https://127.0.0.1:${derp.port}/derp`, join(derp.directory, "127.0.0.1.crt")], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child); child.stderr.resume();
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const key = (await lines.next()).value; assert.match(key, /^nodekey:[a-f0-9]{64}$/);
    if (registered) allowed.add(key);
    child.stdin.end("\n");
    const result = (await lines.next()).value;
    assert.equal((await exited)[0], 0); children.delete(child);
    assert.equal(result, String(expected));
    assert.equal(requests > before, verifierExpected);
  }
  try {
    const port = await startAdmission();
    derp = await spawnDerp({ verifyUrl: `http://127.0.0.1:${port}/verify` });
    await probe(true, true, true);
    await probe(false, false, true);
    await stopAdmission();
    await probe(true, false, false);
    await startAdmission(port);
    await probe(true, true, true);
  } finally {
    if (admission?.listening) await stopAdmission();
    if (derp) children.add(derp.process);
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit"), timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill("SIGTERM"); await exited; clearTimeout(timer);
    }
    derp?.cleanup();
  }
});
