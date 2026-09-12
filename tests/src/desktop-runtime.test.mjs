import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, spawnDaemon, killTree } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8874;
function request(home, message) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(home, "runtime.sock"));
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => socket.destroy(new Error("runtime timeout")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      socket.destroy();
      try { resolve(JSON.parse(text.split("\n")[0])); } catch (error) { reject(error); }
    });
  });
}

test("桌面托管：控制端重连保留同一 PTY，旧实例停止请求被拒，显式退出结束 shell", async () => {
  const stack = await startStack({ port: PORT, daemonEnv: { COFLUX_RUNTIME_CONTROL: "1", COFLUX_RUNTIME_ID: "test-old-app" } });
  const repo = mkRepo();
  let device;
  try {
    const first = await request(stack.home, { op: "status" });
    assert.equal(first.protocol, 1);
    assert.equal(first.runtimeId, "test-old-app");
    assert.deepEqual(first.sessions, []);
    device = await openRelayDevice(stack);
    const c = device.control;
    c.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
    const main = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "workspace");
    c.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "update-survivor" });
    const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.title === "update-survivor", "task");
    c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
    const live = await c.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "running");
    await device.attach(live.task.sessionId);
    const from = device.mark();
    await device.input(live.task.sessionId, 'export COFLUX_SURVIVAL_PROBE=alive; printf "STATE-READY\\n"\r');
    await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("STATE-READY"), "ready", 10000, from);
    const running = await request(stack.home, { op: "status" });
    assert.equal(running.sessions.length, 1);
    assert.equal(running.instanceId, first.instanceId);
    const pid = running.sessions[0].pid;
    const duplicate = spawnDaemon({
      ...process.env,
      COFLUX_HOME: stack.home,
      COFLUX_SERVER: `ws://127.0.0.1:${PORT}/daemon`,
      COFLUX_LOCAL_GATEWAY_PORT: "0",
      COFLUX_RUNTIME_CONTROL: "1",
      COFLUX_RUNTIME_ID: "test-duplicate-app",
    });
    try {
      const [code, signal] = await once(duplicate, "exit", { signal: AbortSignal.timeout(3000) });
      assert.equal(code, 1, "a second supervisor must fail while the runtime is serving");
      assert.equal(signal, null);
      const preserved = await request(stack.home, { op: "status" });
      assert.equal(preserved.instanceId, first.instanceId, "the original control socket must remain reachable");
      assert.equal(preserved.sessions[0].pid, pid);
    } finally { killTree(duplicate); }
    device.close();
    device = await openRelayDevice(stack);
    await device.attach(live.task.sessionId);
    const after = device.mark();
    await device.input(live.task.sessionId, 'printf "PROBE-%s\\n" "$COFLUX_SURVIVAL_PROBE"\r');
    await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("PROBE-alive"), "原 shell 内存状态存活", 10000, after);
    const reattached = await request(stack.home, { op: "status" });
    assert.equal(reattached.sessions[0].pid, pid);
    assert.equal((await request(stack.home, { op: "stop", instanceId: "stale" })).ok, false);
    assert.equal((await request(stack.home, { op: "status" })).sessions[0].pid, pid);
    assert.equal((await request(stack.home, { op: "stop", instanceId: first.instanceId })).ok, true);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await sleep(50); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    }
    assert.equal(alive, false, "显式退出不能留下原 shell");
  } finally { device?.close(); await stack.stop(); repo.cleanup(); }
});
