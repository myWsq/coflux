import assert from "node:assert/strict";
import { test } from "node:test";

import { getDesktopBridge, isDesktop, resolveServerUrl } from "./desktop-bridge";

const browserLocation = { protocol: "https:", host: "app.coflux.dev" };

test("无桥接：沿用浏览器推导，https 同源 → wss://host/client", () => {
  assert.equal(resolveServerUrl({ bridge: null, envServerUrl: undefined, location: browserLocation }), "wss://app.coflux.dev/client");
  assert.equal(
    resolveServerUrl({ bridge: null, envServerUrl: undefined, location: { protocol: "http:", host: "localhost:5273" } }),
    "ws://localhost:5273/client",
  );
});

test("无桥接：构建期 VITE_COFLUX_SERVER 优先于同源推导", () => {
  assert.equal(
    resolveServerUrl({ bridge: null, envServerUrl: "ws://127.0.0.1:19873/client", location: browserLocation }),
    "ws://127.0.0.1:19873/client",
  );
});

test("有桥接：地址只来自桥接，location 与 env 一律忽略（自定义 scheme 下没有可用 host）", () => {
  assert.equal(
    resolveServerUrl({ bridge: { serverUrl: "wss://api.coflux.dev/client" }, envServerUrl: "ws://ignored/client", location: browserLocation }),
    "wss://api.coflux.dev/client",
  );
});

test("桥接探测：没有 window（Node/SSR）与 window 上没有 cofluxDesktop 都判为浏览器", () => {
  const globals = globalThis as { window?: unknown };
  const original = globals.window;
  try {
    delete globals.window;
    assert.equal(getDesktopBridge(), null);
    assert.equal(isDesktop(), false);

    globals.window = {};
    assert.equal(getDesktopBridge(), null);
    assert.equal(isDesktop(), false);

    const bridge = { serverUrl: "wss://api.coflux.dev/client", origin: "https://desktop.coflux.dev" };
    globals.window = { cofluxDesktop: bridge };
    assert.equal(getDesktopBridge(), bridge);
    assert.equal(isDesktop(), true);
  } finally {
    if (original === undefined) delete globals.window;
    else globals.window = original;
  }
});
