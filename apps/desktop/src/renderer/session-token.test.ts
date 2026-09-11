import assert from "node:assert/strict";
import { test } from "node:test";

import { createBridgeTokenStorage, loadSessionToken, resolveInitialToken } from "./session-token";

function fakeBridge(stored: string | Error) {
  const calls: string[] = [];
  return {
    calls,
    getSessionToken: () => (stored instanceof Error ? Promise.reject(stored) : Promise.resolve(stored)),
    setSessionToken: (token: string) => {
      calls.push(`set:${token}`);
    },
    clearSessionToken: () => {
      calls.push("clear");
    },
  };
}

function fakeLegacyStorage(value: string | null) {
  const removed: string[] = [];
  return {
    removed,
    getItem: () => value,
    removeItem: (key: string) => {
      removed.push(key);
    },
  };
}

test("resolveInitialToken：safeStorage 有值就用它，旧 localStorage 值只删不迁", () => {
  assert.deepEqual(resolveInitialToken("new", "old"), { token: "new", migrateLegacy: false, clearLegacy: true });
  assert.deepEqual(resolveInitialToken("new", null), { token: "new", migrateLegacy: false, clearLegacy: false });
  assert.deepEqual(resolveInitialToken("new", ""), { token: "new", migrateLegacy: false, clearLegacy: false });
});

test("resolveInitialToken：safeStorage 为空且旧值还在 → 迁入并删除旧值；都空 → 未登录", () => {
  assert.deepEqual(resolveInitialToken("", "old"), { token: "old", migrateLegacy: true, clearLegacy: true });
  assert.deepEqual(resolveInitialToken("", null), { token: "", migrateLegacy: false, clearLegacy: false });
  assert.deepEqual(resolveInitialToken("", ""), { token: "", migrateLegacy: false, clearLegacy: false });
});

test("loadSessionToken：迁移只发生一次——旧值写进桥接并从 localStorage 删除", async () => {
  const bridge = fakeBridge("");
  const legacy = fakeLegacyStorage("legacy-token");
  assert.equal(await loadSessionToken(bridge, legacy, "coflux_token"), "legacy-token");
  assert.deepEqual(bridge.calls, ["set:legacy-token"]);
  assert.deepEqual(legacy.removed, ["coflux_token"]);

  // 第二次启动：safeStorage 已有值、localStorage 已空，什么都不发生
  const bridge2 = fakeBridge("legacy-token");
  const legacy2 = fakeLegacyStorage(null);
  assert.equal(await loadSessionToken(bridge2, legacy2, "coflux_token"), "legacy-token");
  assert.deepEqual(bridge2.calls, []);
  assert.deepEqual(legacy2.removed, []);
});

test("loadSessionToken：桥接取回失败按未登录处理，不抛、不迁移", async () => {
  const bridge = fakeBridge(new Error("ipc down"));
  const legacy = fakeLegacyStorage(null);
  assert.equal(await loadSessionToken(bridge, legacy, "coflux_token"), "");
  assert.deepEqual(bridge.calls, []);
});

test("createBridgeTokenStorage：read 同步返回当前值；write/clear 更新内存并转发主进程", () => {
  const bridge = fakeBridge("");
  const storage = createBridgeTokenStorage(bridge, "initial");
  assert.equal(storage.read(), "initial");
  storage.write("fresh");
  assert.equal(storage.read(), "fresh");
  storage.clear();
  assert.equal(storage.read(), "");
  assert.deepEqual(bridge.calls, ["set:fresh", "clear"]);
});
