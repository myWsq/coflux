import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MIN_VISIBLE_PX, parseWindowBounds, readWindowBounds, resolveWindowBounds, visibleOn, writeWindowBounds } from "./window-state";

const laptop = { x: 0, y: 0, width: 1728, height: 1080 };
const external = { x: 1728, y: -400, width: 2560, height: 1440 };

test("parseWindowBounds：合法 JSON 四个整数才接受；缺字段 / 非整数 / 小于最小尺寸 / 非 JSON 都当没存过", () => {
  assert.deepEqual(parseWindowBounds(JSON.stringify({ x: 10, y: 20, width: 1280, height: 820 })), { x: 10, y: 20, width: 1280, height: 820 });
  assert.equal(parseWindowBounds(JSON.stringify({ x: 10, y: 20, width: 1280 })), null);
  assert.equal(parseWindowBounds(JSON.stringify({ x: 10.5, y: 20, width: 1280, height: 820 })), null);
  assert.equal(parseWindowBounds(JSON.stringify({ x: "10", y: 20, width: 1280, height: 820 })), null);
  assert.equal(parseWindowBounds(JSON.stringify({ x: 0, y: 0, width: 800, height: 820 })), null); // 窄于 minWidth
  assert.equal(parseWindowBounds(JSON.stringify({ x: 0, y: 0, width: 1280, height: 600 })), null); // 矮于 minHeight
  assert.equal(parseWindowBounds("not json"), null);
  assert.equal(parseWindowBounds(JSON.stringify([1, 2, 3, 4])), null);
  assert.equal(parseWindowBounds(null), null);
  assert.equal(parseWindowBounds(""), null);
});

test("visibleOn：重叠区两个方向都不少于 MIN_VISIBLE_PX 才算在屏上", () => {
  assert.equal(visibleOn({ x: 100, y: 100, width: 1280, height: 820 }, laptop), true);
  // 只露出一条 10px 的边：抓不住标题栏，判离屏
  assert.equal(visibleOn({ x: laptop.width - 10, y: 100, width: 1280, height: 820 }, laptop), false);
  // 恰好露出 MIN_VISIBLE_PX：算可见
  assert.equal(visibleOn({ x: laptop.width - MIN_VISIBLE_PX, y: 100, width: 1280, height: 820 }, laptop), true);
  assert.equal(visibleOn({ x: -1280, y: 100, width: 1280, height: 820 }, laptop), false);
});

test("resolveWindowBounds：任一显示器上可见就恢复；离屏 / 没存过回 null（默认尺寸居中）", () => {
  const saved = { x: 200, y: 120, width: 1280, height: 820 };
  assert.deepEqual(resolveWindowBounds(saved, [laptop]), saved);
  assert.equal(resolveWindowBounds(null, [laptop]), null);
  assert.equal(resolveWindowBounds(saved, []), null);

  // 曾放在外接屏上：外接屏还在 → 恢复；拔掉后 → 回默认
  const onExternal = { x: 2000, y: -300, width: 1400, height: 900 };
  assert.deepEqual(resolveWindowBounds(onExternal, [laptop, external]), onExternal);
  assert.equal(resolveWindowBounds(onExternal, [laptop]), null);
});

test("读写文件：写入后可读回；文件缺失或损坏读为 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-window-state-"));
  try {
    const path = join(dir, "nested", "window-state.json");
    assert.equal(readWindowBounds(path), null);
    const bounds = { x: 30, y: 40, width: 1300, height: 900 };
    writeWindowBounds(path, bounds);
    assert.deepEqual(readWindowBounds(path), bounds);
    writeFileSync(path, "{broken");
    assert.equal(readWindowBounds(path), null);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});
