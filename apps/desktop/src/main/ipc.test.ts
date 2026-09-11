import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeBadgeCount, sanitizeNotification, sanitizeSessionToken } from "./ipc-sanitize";

test("通知载荷：三个字符串字段齐全才接受，超长截断", () => {
  assert.deepEqual(sanitizeNotification({ workspaceId: "ws", title: "t", body: "b" }), { workspaceId: "ws", title: "t", body: "b" });
  assert.equal(sanitizeNotification({ workspaceId: "ws", title: "t" }), null);
  assert.equal(sanitizeNotification({ workspaceId: "", title: "t", body: "" }), null);
  assert.equal(sanitizeNotification({ workspaceId: 1, title: "t", body: "b" }), null);
  assert.equal(sanitizeNotification(null), null);
  assert.equal(sanitizeNotification("x"), null);
  const long = sanitizeNotification({ workspaceId: "ws", title: "t".repeat(500), body: "b".repeat(5000) });
  assert.equal(long?.title.length, 200);
  assert.equal(long?.body.length, 1000);
});

test("角标计数：非负整数，封顶 999，非数字丢弃", () => {
  assert.equal(sanitizeBadgeCount(0), 0);
  assert.equal(sanitizeBadgeCount(3.7), 3);
  assert.equal(sanitizeBadgeCount(-2), 0);
  assert.equal(sanitizeBadgeCount(5000), 999);
  assert.equal(sanitizeBadgeCount(Number.NaN), null);
  assert.equal(sanitizeBadgeCount("3"), null);
});

test("会话 token：非空、不超长、无空白/控制字符的字符串才落盘，其余丢弃不截断", () => {
  assert.equal(sanitizeSessionToken("cfx_abc.DEF-123_456"), "cfx_abc.DEF-123_456");
  assert.equal(sanitizeSessionToken(""), null);
  assert.equal(sanitizeSessionToken("a".repeat(4096)), "a".repeat(4096));
  assert.equal(sanitizeSessionToken("a".repeat(4097)), null);
  assert.equal(sanitizeSessionToken("has space"), null);
  assert.equal(sanitizeSessionToken("line\nbreak"), null);
  assert.equal(sanitizeSessionToken("nul\u0000byte"), null);
  assert.equal(sanitizeSessionToken(123), null);
  assert.equal(sanitizeSessionToken({ token: "x" }), null);
  assert.equal(sanitizeSessionToken(null), null);
});
