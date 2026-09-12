import assert from "node:assert/strict";
import { test } from "node:test";

// 只测纯函数：registerAppProtocol 依赖 electron 运行时，不在 node 单测里 import。
import { RENDERER_CSP, resolveRendererAsset } from "./app-protocol-pure";

test("根与 SPA 路径回落 index.html，静态资源按相对路径", () => {
  assert.equal(resolveRendererAsset("/"), "index.html");
  assert.equal(resolveRendererAsset(""), "index.html");
  assert.equal(resolveRendererAsset("/oauth/consent"), "index.html");
  assert.equal(resolveRendererAsset("/assets/index-abc123.js"), "assets/index-abc123.js");
  assert.equal(resolveRendererAsset("/favicon.svg"), "favicon.svg");
  assert.equal(resolveRendererAsset("/manifest.webmanifest"), "manifest.webmanifest");
  assert.equal(resolveRendererAsset("/build-id.txt"), "build-id.txt");
});

test("含 .. 段的路径一律拒绝：开头的 ..、中间的 ..、编码的 ..；NUL 与非法编码同样拒绝", () => {
  assert.equal(resolveRendererAsset("/../package.json"), null);
  assert.equal(resolveRendererAsset("/assets/../../package.json"), null);
  assert.equal(resolveRendererAsset("/%2e%2e/package.json"), null);
  assert.equal(resolveRendererAsset("/assets/%2e%2e/index.html"), null);
  // 规范化后仍在根内的 .. 也拒绝（保守）：产物里没有需要 .. 才能引用的资源
  assert.equal(resolveRendererAsset("/assets/../favicon.svg"), null);
  assert.equal(resolveRendererAsset("/a%00.js"), null);
  assert.equal(resolveRendererAsset("/%zz"), null);
  // 单个 . 段与重复斜杠只是规范化，不算越界
  assert.equal(resolveRendererAsset("/./favicon.svg"), "favicon.svg");
  assert.equal(resolveRendererAsset("//assets//x.js"), "assets/x.js");
});

test("CSP：脚本只许 self；连接放行中心 wss/ws 与 loopback；不嵌 frame/object", () => {
  // 按 "; " 拆指令、再按空格拆 token（`wss:` 后面是空格，`\b` 在冒号与空格之间不成立，不能用正则词边界）
  const directives = new Map(RENDERER_CSP.split("; ").map((item) => {
    const [name, ...sources] = item.split(" ");
    return [name, sources] as const;
  }));
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  const connect = directives.get("connect-src") ?? [];
  assert.ok(connect.includes("wss:"), "connect-src 放行 wss:");
  assert.ok(connect.includes("ws:"), "connect-src 放行 ws:");
  assert.ok(connect.includes("http://127.0.0.1:*"), "connect-src 放行 loopback");
  assert.deepEqual(directives.get("frame-src"), ["'none'"]);
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.ok(!(directives.get("script-src") ?? []).some((source) => source.includes("unsafe")));
});
