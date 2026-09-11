import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeBadgeCount, sanitizeNotification } from "./ipc-sanitize";

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
