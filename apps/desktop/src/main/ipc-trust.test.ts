import assert from "node:assert/strict";
import { test } from "node:test";

import { isTrustedRendererUrl } from "./ipc-trust";

const trusted = { appOrigin: "coflux-app://app", devRendererUrl: "http://localhost:5274/" };

test("打包渲染层（coflux-app://app/*）可信", () => {
  assert.equal(isTrustedRendererUrl("coflux-app://app/", trusted), true);
  assert.equal(isTrustedRendererUrl("coflux-app://app", trusted), true);
  assert.equal(isTrustedRendererUrl("coflux-app://app/oauth/consent?request=1", trusted), true);
});

test("dev 渲染层同源可信；其它 host / scheme / 空值都不可信", () => {
  assert.equal(isTrustedRendererUrl("http://localhost:5274/", trusted), true);
  assert.equal(isTrustedRendererUrl("http://localhost:5274/x", trusted), true);
  assert.equal(isTrustedRendererUrl("http://localhost:5273/", trusted), false);
  assert.equal(isTrustedRendererUrl("https://app.coflux.dev/", trusted), false);
  assert.equal(isTrustedRendererUrl("coflux-app://evil/", trusted), false);
  assert.equal(isTrustedRendererUrl("coflux-app://app.evil/", trusted), false);
  assert.equal(isTrustedRendererUrl("", trusted), false);
  assert.equal(isTrustedRendererUrl(undefined, trusted), false);
  assert.equal(isTrustedRendererUrl(null, trusted), false);
});

test("没有 dev URL（打包运行）时任何 http 来源都不可信", () => {
  assert.equal(isTrustedRendererUrl("http://localhost:5274/", { appOrigin: "coflux-app://app" }), false);
});
