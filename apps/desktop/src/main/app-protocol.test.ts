import assert from "node:assert/strict";
import { test } from "node:test";

// 只测纯函数：registerAppProtocol 依赖 electron 运行时，不在 node 单测里 import。
import { APP_ORIGIN, APP_URL, RENDERER_CSP, contentTypeFor, resolveRendererAsset } from "./app-protocol-pure";

test("scheme URL 形如 coflux-app://app/：pathname 为 /，App.tsx 才落到 MainPage", () => {
  assert.equal(APP_URL, "coflux-app://app/");
  assert.equal(new URL(APP_URL).pathname, "/");
  assert.equal(new URL(APP_URL).origin, "null"); // Node 不认识自定义 scheme；Electron 注册为 standard 后 origin 是 coflux-app://app
  assert.equal(APP_ORIGIN, "coflux-app://app");
  assert.notEqual(APP_ORIGIN.split(":")[0], "coflux"); // 不占用 coflux://，留给深链接
});

test("根与 SPA 路径回落 index.html，静态资源按相对路径", () => {
  assert.equal(resolveRendererAsset("/"), "index.html");
  assert.equal(resolveRendererAsset(""), "index.html");
  assert.equal(resolveRendererAsset("/oauth/consent"), "index.html");
  assert.equal(resolveRendererAsset("/assets/index-abc123.js"), "assets/index-abc123.js");
  assert.equal(resolveRendererAsset("/favicon.svg"), "favicon.svg");
  assert.equal(resolveRendererAsset("/manifest.webmanifest"), "manifest.webmanifest");
  assert.equal(resolveRendererAsset("/build-id.txt"), "build-id.txt");
});

test("越出产物根的路径被拒绝：.. 段、编码的 ..、NUL、非法编码", () => {
  assert.equal(resolveRendererAsset("/../package.json"), null);
  assert.equal(resolveRendererAsset("/assets/../../package.json"), null);
  assert.equal(resolveRendererAsset("/%2e%2e/package.json"), null);
  assert.equal(resolveRendererAsset("/a%00.js"), null);
  assert.equal(resolveRendererAsset("/%zz"), null);
  // 规范化后仍在根内的 .. 是允许的
  assert.equal(resolveRendererAsset("/assets/../favicon.svg"), "favicon.svg");
});

test("Content-Type 按扩展名，未知扩展名退到 octet-stream", () => {
  assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("assets/x.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("manifest.webmanifest"), "application/manifest+json; charset=utf-8");
  assert.equal(contentTypeFor("icon-512.png"), "image/png");
  assert.equal(contentTypeFor("weird.bin"), "application/octet-stream");
});

test("CSP：脚本只许 self；连接放行中心 wss/ws 与 loopback；不嵌 frame/object", () => {
  const directives = new Map(RENDERER_CSP.split("; ").map((item) => [item.split(" ")[0], item]));
  assert.equal(directives.get("script-src"), "script-src 'self'");
  assert.match(directives.get("connect-src") ?? "", /\bwss:\b/);
  assert.match(directives.get("connect-src") ?? "", /\bws:\b/);
  assert.match(directives.get("connect-src") ?? "", /http:\/\/127\.0\.0\.1:\*/);
  assert.equal(directives.get("frame-src"), "frame-src 'none'");
  assert.equal(directives.get("object-src"), "object-src 'none'");
  assert.doesNotMatch(directives.get("script-src") ?? "", /unsafe/);
});
