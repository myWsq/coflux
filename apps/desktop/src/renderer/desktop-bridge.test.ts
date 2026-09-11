import assert from "node:assert/strict";
import { test } from "node:test";

import { requireDesktopBridge } from "./desktop-bridge";

// 桥接必选（plan 106）：没有「浏览器推导 ws(s)://host/client」的回退，地址与 Origin 只来自桥接。
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
