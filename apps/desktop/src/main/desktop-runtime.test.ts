import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stopRuntime, type RuntimeStatus } from "./desktop-runtime";

const original: RuntimeStatus = { ok: true, protocol: 1, instanceId: "old", runtimeId: "runtime", version: "test", sessions: [] };

async function fixture(handle: (request: { op: string }, socket: Socket, close: () => void) => void) {
  const home = mkdtempSync(join(tmpdir(), "coflux-stop-race-"));
  const server = createServer(socket => {
    let input = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      input += chunk;
      if (input.includes("\n")) handle(JSON.parse(input), socket, () => server.close());
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, "runtime.sock"), resolve));
  return { home, async dispose() {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  } };
}

for (const lostResponse of ["stop", "status"]) {
  test(`停止期间 ${lostResponse} 响应遇到 EOF，确认原实例消失后完成退出`, async () => {
    const requests: string[] = [];
    const f = await fixture((request, socket, close) => {
      requests.push(request.op);
      if (request.op === lostResponse) { socket.end(); close(); }
      else socket.end('{"ok":true}\n');
    });
    try {
      await stopRuntime(f.home, original);
      assert.equal(requests.filter(op => op === "stop").length, 1);
      if (lostResponse === "status") assert.deepEqual(requests, ["stop", "status"]);
    } finally { await f.dispose(); }
  });
}

test("停止响应丢失后出现新实例，保留新实例并拒绝继续退出", async () => {
  let stops = 0;
  const f = await fixture((request, socket) => {
    if (request.op === "stop") { stops++; socket.end(); }
    else socket.end(JSON.stringify({ ...original, instanceId: "new" }) + "\n");
  });
  try {
    await assert.rejects(stopRuntime(f.home, original), /新运行实例/);
    assert.equal(stops, 1);
  } finally { await f.dispose(); }
});
