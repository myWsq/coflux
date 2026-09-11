import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldOpenTerminalLink } from "./terminal-link-activation";

test("普通点击不打开链接（只聚焦终端）", () => {
  assert.equal(shouldOpenTerminalLink({}), false);
  assert.equal(shouldOpenTerminalLink({ button: 0 }), false);
  assert.equal(shouldOpenTerminalLink({ metaKey: false, ctrlKey: false, button: 0 }), false);
});

test("⌘+点击打开链接", () => {
  assert.equal(shouldOpenTerminalLink({ metaKey: true }), true);
  assert.equal(shouldOpenTerminalLink({ metaKey: true, button: 0 }), true);
});

test("Ctrl+点击打开链接（非 macOS 语义）", () => {
  assert.equal(shouldOpenTerminalLink({ ctrlKey: true }), true);
  assert.equal(shouldOpenTerminalLink({ ctrlKey: true, button: 0 }), true);
});

test("其它修饰键不顶替 ⌘/Ctrl，中键右键一律不打开", () => {
  assert.equal(shouldOpenTerminalLink({ button: 0, metaKey: false, ctrlKey: false }), false);
  assert.equal(shouldOpenTerminalLink({ metaKey: true, button: 1 }), false);
  assert.equal(shouldOpenTerminalLink({ ctrlKey: true, button: 2 }), false);
});
