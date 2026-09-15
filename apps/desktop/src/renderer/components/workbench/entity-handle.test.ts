import assert from "node:assert/strict";
import { test } from "node:test";

import { entityHandle } from "./entity-handle";

test("a handle is coflux:<kind>:<the uuid's first 8 hex characters>", () => {
  assert.equal(entityHandle("device", "b6767697-60b2-4700-a304-1404bf03c675"), "coflux:device:b6767697");
  assert.equal(entityHandle("project", "c66dc1d4-5955-4ba5-b41e-9e37f364eb95"), "coflux:project:c66dc1d4");
  assert.equal(entityHandle("workspace", "dee657f0-4083-4684-be45-0fd2746c5d35"), "coflux:workspace:dee657f0");
  assert.equal(entityHandle("terminal", "f562304a-2235-4523-8fc6-1493c1fcca53"), "coflux:terminal:f562304a");
});

test("the short id stops before the first dash and is always emitted lowercase", () => {
  const handle = entityHandle("terminal", "9E21C4D0-1111-2222-3333-444444444444");
  assert.equal(handle, "coflux:terminal:9e21c4d0");
  const short = handle.split(":")[2]!;
  assert.equal(short.length, 8);
  assert.match(short, /^[0-9a-f]{8}$/);
});
