import assert from "node:assert/strict";
import { test } from "node:test";

import { readExpandedProjects, summarizeProjectActivity, toggleExpandedProject, type ExpandedProjectsStore } from "./project-rows";

function memoryStore(): ExpandedProjectsStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    key: "expanded",
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
}

const known = new Set(["p1", "p2", "p3"]);

test("没有记录时全部折叠；展开的项目写入后读回，再点一次收起", () => {
  const store = memoryStore();
  assert.deepEqual([...readExpandedProjects(store)], []);
  const opened = toggleExpandedProject(store, readExpandedProjects(store), "p2", known);
  assert.deepEqual([...opened], ["p2"]);
  assert.deepEqual([...readExpandedProjects(store)], ["p2"]);
  const closed = toggleExpandedProject(store, opened, "p2", known);
  assert.deepEqual([...closed], []);
  assert.deepEqual([...readExpandedProjects(store)], []);
});

test("写入时丢掉已不存在的项目", () => {
  const store = memoryStore();
  store.values.set("expanded", JSON.stringify(["gone", "p1"]));
  assert.deepEqual([...toggleExpandedProject(store, readExpandedProjects(store), "p3", known)], ["p1", "p3"]);
});

test("存储内容损坏或直接抛错都只当作「全部折叠」，写不进去也不抛错", () => {
  const store = memoryStore();
  store.values.set("expanded", "{not json");
  assert.deepEqual([...readExpandedProjects(store)], []);
  store.values.set("expanded", JSON.stringify({ p1: true }));
  assert.deepEqual([...readExpandedProjects(store)], []);
  store.values.set("expanded", JSON.stringify(["p1", 7, "", null]));
  assert.deepEqual([...readExpandedProjects(store)], ["p1"]);

  const hostile: ExpandedProjectsStore = {
    key: "expanded",
    storage: {
      getItem: () => {
        throw new Error("site data blocked");
      },
      setItem: () => {
        throw new Error("site data blocked");
      },
    },
  };
  assert.deepEqual([...readExpandedProjects(hostile)], []);
  assert.deepEqual([...toggleExpandedProject(hostile, new Set(), "p1", known)], ["p1"]);
});

test("折叠行的汇总：approval > question > error > active > done，待处理计数只数前三种", () => {
  assert.deepEqual(summarizeProjectActivity([{ status: "idle" }, { status: "idle" }]), { top: null, attentionCount: 0 });
  assert.deepEqual(summarizeProjectActivity([]), { top: null, attentionCount: 0 });

  const done = { status: "done", agent: "codex" } as const;
  const active = { status: "active", agent: "claude" } as const;
  const error = { status: "error", agent: "claude" } as const;
  const question = { status: "question", agent: "claude" } as const;
  const approval = { status: "approval", agent: "codex" } as const;
  assert.deepEqual(summarizeProjectActivity([done, active]), { top: active, attentionCount: 0 });
  assert.deepEqual(summarizeProjectActivity([done]), { top: done, attentionCount: 0 });
  assert.deepEqual(summarizeProjectActivity([active, error, question]), { top: question, attentionCount: 2 });
  assert.deepEqual(summarizeProjectActivity([error, approval, { status: "idle" }, question]), { top: approval, attentionCount: 3 });
});
