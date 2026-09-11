import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SERVER_URL, isValidServerUrl, resolveServerUrl } from "./settings";

test("优先级：--server > COFLUX_SERVER_URL > settings.json > 默认", () => {
  const env = { COFLUX_SERVER_URL: "wss://env.example/client" };
  assert.equal(resolveServerUrl({ argv: ["--server=wss://cli.example/client"], env, fileServerUrl: "wss://file.example/client", packaged: true }), "wss://cli.example/client");
  assert.equal(resolveServerUrl({ argv: [], env, fileServerUrl: "wss://file.example/client", packaged: true }), "wss://env.example/client");
  assert.equal(resolveServerUrl({ argv: [], env: {}, fileServerUrl: "wss://file.example/client", packaged: true }), "wss://file.example/client");
});

test("非法值跳过、落到下一级：http 不是 WS 端点，空串与乱码都不算", () => {
  assert.equal(isValidServerUrl("https://api.coflux.dev/client"), false);
  assert.equal(isValidServerUrl(""), false);
  assert.equal(isValidServerUrl("not a url"), false);
  assert.equal(isValidServerUrl("ws://localhost:8787/client"), true);
  assert.equal(resolveServerUrl({ argv: ["--server=https://bad/client"], env: { COFLUX_SERVER_URL: "nope" }, fileServerUrl: "wss://file.example/client", packaged: true }), "wss://file.example/client");
  assert.equal(resolveServerUrl({ argv: ["--server=https://bad/client"], env: {}, packaged: true }), DEFAULT_SERVER_URL);
});
