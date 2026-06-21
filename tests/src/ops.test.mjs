import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "./harness.mjs";

const PORT = 8825;
let stack;

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); });

test("/health 返回 JSON，含探活与运行时计数", async () => {
  const { status, json } = await stack.health();
  assert.equal(status, 200);
  assert.equal(json.ok, true, "sqlite 探活通过");
  assert.ok(json.daemons >= 1, "至少 1 个在线 daemon");
  assert.equal(typeof json.sessions, "number");
  assert.ok(json.uptimeMs >= 0);
});

test("SIGTERM 优雅退出（不挂起）", async () => {
  const code = await stack.gracefulStopServer(4000);
  assert.notEqual(code, "timeout", "server 在期限内退出（未挂起）");
  assert.equal(code, 0, "退出码 0");
});
