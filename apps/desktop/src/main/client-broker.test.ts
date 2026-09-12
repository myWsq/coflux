import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startClientBroker } from "./client-broker";

function request(path: string, command: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ protocolVersion: 1, command }) + "\n"));
    socket.on("data", (data) => { text += data; });
    socket.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  });
}

test("CLI 复用应用账号但拿不到 token；退出中的应用与独立 logout 被拒", async () => {
  const home = mkdtempSync(join(tmpdir(), "coflux-client-broker-"));
  let credential = "private-session";
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls += 1;
    assert.equal(req.headers.authorization, "Bearer private-session");
    assert.equal(req.url, "/api/client/command");
    for await (const _chunk of req) { /* 消费完整请求 */ }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, value: { accountId: "owner" } }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const close = startClientBroker(home, `ws://127.0.0.1:${address.port}/client`, () => credential);
  try {
    const path = join(home, "client.sock");
    for (let i = 0; i < 100; i++) { try { statSync(path); break; } catch { await delay(5); } }
    assert.deepEqual(await request(path, { op: "snapshot" }), { ok: true, value: { accountId: "owner" } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal((await request(path, { op: "logout" })).ok, false);
    credential = "";
    assert.equal((await request(path, { op: "snapshot" })).ok, false);
    assert.equal(calls, 1);
  } finally {
    close();
    server.closeAllConnections();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
