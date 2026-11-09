import assert from "node:assert/strict";
import { test } from "node:test";

import { RECENT_VISIT_WINDOW_MS, readWorkspaceVisits, recordWorkspaceVisit, type WorkspaceVisitStore } from "./workspace-visits";

function memoryStore(): WorkspaceVisitStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    key: "visits",
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
}

test("写入后读回离开时间，再写同一工作区覆盖为新时间", () => {
  const store = memoryStore();
  recordWorkspaceVisit(store, "ws-a", 1_000);
  recordWorkspaceVisit(store, "ws-b", 2_000);
  assert.deepEqual(readWorkspaceVisits(store), { "ws-a": 1_000, "ws-b": 2_000 });
  const next = recordWorkspaceVisit(store, "ws-a", 3_000);
  assert.deepEqual(next, { "ws-a": 3_000, "ws-b": 2_000 });
  assert.deepEqual(readWorkspaceVisits(store), next);
});

test("写入时裁掉窗口之外的旧记录", () => {
  const store = memoryStore();
  const now = 10 * RECENT_VISIT_WINDOW_MS;
  recordWorkspaceVisit(store, "old", now - RECENT_VISIT_WINDOW_MS - 1);
  recordWorkspaceVisit(store, "edge", now - RECENT_VISIT_WINDOW_MS);
  assert.deepEqual(recordWorkspaceVisit(store, "fresh", now), { edge: now - RECENT_VISIT_WINDOW_MS, fresh: now });
});

test("存储为空、内容损坏、不是对象或直接抛错都只当作「没有记录」", () => {
  const store = memoryStore();
  assert.deepEqual(readWorkspaceVisits(store), {});

  store.values.set("visits", "{not json");
  assert.deepEqual(readWorkspaceVisits(store), {});
  store.values.set("visits", JSON.stringify(["ws-a"]));
  assert.deepEqual(readWorkspaceVisits(store), {});
  store.values.set("visits", JSON.stringify(42));
  assert.deepEqual(readWorkspaceVisits(store), {});
  store.values.set("visits", "null");
  assert.deepEqual(readWorkspaceVisits(store), {});
  store.values.set("visits", JSON.stringify({ "ws-a": 5, "ws-b": "x", "ws-c": null }));
  assert.deepEqual(readWorkspaceVisits(store), { "ws-a": 5 });

  const hostile: WorkspaceVisitStore = {
    key: "visits",
    storage: {
      getItem: () => {
        throw new Error("site data blocked");
      },
      setItem: () => {
        throw new Error("site data blocked");
      },
    },
  };
  assert.deepEqual(readWorkspaceVisits(hostile), {});
  // 写不进去不抛错：调用方拿到本该落盘的记录，下次读仍然是空的
  assert.deepEqual(recordWorkspaceVisit(hostile, "ws-a", 7), { "ws-a": 7 });
  assert.deepEqual(readWorkspaceVisits(hostile), {});
});
