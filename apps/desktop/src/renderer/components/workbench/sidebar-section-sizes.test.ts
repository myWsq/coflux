import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SECTION_WEIGHTS,
  MIN_SECTION_PX,
  dragSectionWeights,
  persistSectionWeights,
  readSectionWeights,
  resetSectionPair,
  type SectionWeightsStore,
} from "./sidebar-section-sizes";

function memoryStore(): SectionWeightsStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    key: "sections",
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
}

test("没有记录、JSON 损坏、缺项或非正数都读成默认分布；写入后读回", () => {
  const store = memoryStore();
  assert.deepEqual(readSectionWeights(store), DEFAULT_SECTION_WEIGHTS);
  store.values.set("sections", "{not json");
  assert.deepEqual(readSectionWeights(store), DEFAULT_SECTION_WEIGHTS);
  store.values.set("sections", JSON.stringify({ current: 0.2, projects: 0.5 }));
  assert.deepEqual(readSectionWeights(store), DEFAULT_SECTION_WEIGHTS);
  store.values.set("sections", JSON.stringify({ current: 0, projects: 0.5, devices: 0.5 }));
  assert.deepEqual(readSectionWeights(store), DEFAULT_SECTION_WEIGHTS);

  const written = { current: 0.1, projects: 0.7, devices: 0.2 };
  persistSectionWeights(store, written);
  assert.deepEqual(readSectionWeights(store), written);

  const hostile: SectionWeightsStore = {
    key: "sections",
    storage: {
      getItem: () => {
        throw new Error("site data blocked");
      },
      setItem: () => {
        throw new Error("site data blocked");
      },
    },
  };
  assert.deepEqual(readSectionWeights(hostile), DEFAULT_SECTION_WEIGHTS);
  persistSectionWeights(hostile, written); // 不抛错
});

test("拖拽只在相邻两区间挪空间，比例随像素走，第三区不动", () => {
  const start = { current: 0.25, projects: 0.5, devices: 0.25 };
  // 当前 100px、项目 300px，往下拖 100px → 像素 200/200，对内权重对半分。
  const next = dragSectionWeights(start, "current", "projects", 100, 300, 100);
  assert.ok(Math.abs(next.current - 0.375) < 1e-9);
  assert.ok(Math.abs(next.projects - 0.375) < 1e-9);
  assert.equal(next.devices, 0.25);
});

test("拖到头被最小高度顶住；两区总高不足两个最小值时原样返回", () => {
  const start = { current: 0.25, projects: 0.5, devices: 0.25 };
  const pinned = dragSectionWeights(start, "current", "projects", 100, 300, -500);
  // 上区被压到 MIN_SECTION_PX：合计 400px、合计权重 0.75。
  assert.ok(Math.abs(pinned.current - (0.75 * MIN_SECTION_PX) / 400) < 1e-9);
  assert.ok(Math.abs(pinned.projects - (0.75 * (400 - MIN_SECTION_PX)) / 400) < 1e-9);

  const tooTight = dragSectionWeights(start, "current", "projects", 50, 60, 30);
  assert.deepEqual(tooTight, start);
});

test("双击分隔条：这对区段回默认比例，合计份额与第三区不变", () => {
  const dragged = { current: 0.6, projects: 0.15, devices: 0.25 };
  const reset = resetSectionPair(dragged, "current", "projects");
  // current:projects 的默认比例是 1:2，合计 0.75。
  assert.ok(Math.abs(reset.current - 0.25) < 1e-9);
  assert.ok(Math.abs(reset.projects - 0.5) < 1e-9);
  assert.equal(reset.devices, 0.25);
});
