import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ORIGIN, rewriteHandshakeHeaders, shouldRewriteOrigin } from "./origin";

const baseHeaders = {
  Origin: "coflux-app://app",
  "Sec-WebSocket-Key": "abc",
  "Sec-WebSocket-Version": "13",
  "User-Agent": "coflux-desktop",
};

test("桌面 Origin 是稳定的 https 值，且与 Web 的 app.coflux.dev 不同", () => {
  assert.equal(new URL(DESKTOP_ORIGIN).protocol, "https:");
  assert.equal(new URL(DESKTOP_ORIGIN).origin, DESKTOP_ORIGIN);
  assert.notEqual(DESKTOP_ORIGIN, "https://app.coflux.dev");
});

test("中心 /client 与 loopback /device 的握手都改：Origin 换成桌面值，其余头原样", () => {
  for (const url of ["wss://api.coflux.dev/client", "ws://localhost:8787/client", "ws://127.0.0.1:8788/device"]) {
    assert.equal(shouldRewriteOrigin(url, "webSocket"), true, url);
    const rewritten = rewriteHandshakeHeaders({ url, resourceType: "webSocket", requestHeaders: baseHeaders });
    assert.ok(rewritten, url);
    assert.equal(rewritten.Origin, DESKTOP_ORIGIN);
    assert.equal(rewritten["Sec-WebSocket-Key"], "abc");
    assert.equal(rewritten["Sec-WebSocket-Version"], "13");
    assert.equal(rewritten["User-Agent"], "coflux-desktop");
    assert.equal(Object.keys(rewritten).length, Object.keys(baseHeaders).length);
  }
});

test("relay 握手同样改写（同一身份），小写 origin 键也被替换而不是并存", () => {
  const rewritten = rewriteHandshakeHeaders({
    url: "wss://relay-jp.coflux.dev/channel/abc",
    resourceType: "webSocket",
    requestHeaders: { origin: "coflux-app://app", "Sec-WebSocket-Key": "k" },
  });
  assert.ok(rewritten);
  assert.deepEqual(rewritten, { "Sec-WebSocket-Key": "k", Origin: DESKTOP_ORIGIN });
});

test("非 WebSocket 请求一律不改：脚本 / xhr / 主文档 / 自定义 scheme", () => {
  assert.equal(shouldRewriteOrigin("https://api.coflux.dev/health", "xhr"), false);
  assert.equal(shouldRewriteOrigin("coflux-app://app/assets/index.js", "script"), false);
  assert.equal(shouldRewriteOrigin("coflux-app://app/", "mainFrame"), false);
  // resourceType 说是 webSocket 但 URL 不是 ws/wss（不会发生，但别把 http 也改了）
  assert.equal(shouldRewriteOrigin("https://api.coflux.dev/client", "webSocket"), false);
  assert.equal(shouldRewriteOrigin("not a url", "webSocket"), false);
  assert.equal(rewriteHandshakeHeaders({ url: "https://api.coflux.dev/health", resourceType: "xhr", requestHeaders: baseHeaders }), null);
});

test("dev 渲染层自己的 HMR WebSocket 不改（vite 不是应用身份），其他 host 照改", () => {
  const dev = "http://localhost:5274/";
  assert.equal(shouldRewriteOrigin("ws://localhost:5274/?token=x", "webSocket", dev), false);
  assert.equal(shouldRewriteOrigin("ws://localhost:8787/client", "webSocket", dev), true);
  assert.equal(shouldRewriteOrigin("ws://127.0.0.1:8788/device", "webSocket", dev), true);
});
