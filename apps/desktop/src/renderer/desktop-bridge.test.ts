import assert from "node:assert/strict";
import { test } from "node:test";

import { MISSING_BRIDGE_MESSAGE, requireDesktopBridge } from "./desktop-bridge";

// 桥接必选（plan 106）：没有 window（Node/SSR）或 window 上没有 cofluxDesktop 都是启动期错误，
// 不再有「浏览器推导 ws(s)://host/client」的回退；有桥接时地址只来自桥接。
test("没有 window：抛出明确的桥接缺失错误", () => {
  const globals = globalThis as { window?: unknown };
  const original = globals.window;
  try {
    delete globals.window;
    assert.throws(() => requireDesktopBridge(), { message: MISSING_BRIDGE_MESSAGE });
  } finally {
    if (original === undefined) delete globals.window;
    else globals.window = original;
  }
});

test("window 上没有 cofluxDesktop：同样抛错，不静默降级", () => {
  const globals = globalThis as { window?: unknown };
  const original = globals.window;
  try {
    globals.window = {};
    assert.throws(() => requireDesktopBridge(), { message: MISSING_BRIDGE_MESSAGE });
  } finally {
    if (original === undefined) delete globals.window;
    else globals.window = original;
  }
});

test("有桥接：返回同一个对象，服务器地址与 Origin 只来自桥接", () => {
  const globals = globalThis as { window?: unknown };
  const original = globals.window;
  try {
    const bridge = { serverUrl: "wss://api.coflux.dev/client", origin: "https://desktop.coflux.dev" };
    globals.window = { cofluxDesktop: bridge, location: { protocol: "https:", host: "ignored.example" } };
    const resolved = requireDesktopBridge();
    assert.equal(resolved, bridge);
    assert.equal(resolved.serverUrl, "wss://api.coflux.dev/client");
    assert.equal(resolved.origin, "https://desktop.coflux.dev");
  } finally {
    if (original === undefined) delete globals.window;
    else globals.window = original;
  }
});
