import assert from "node:assert/strict";
import test from "node:test";
import { isGhosttyOccluded, type OcclusionCandidate } from "../shared/ghostty-occlusion";

const terminal = { x: 260, y: 36, width: 1020, height: 784 };
const candidate = (rect = terminal, extra: Partial<OcclusionCandidate> = {}): OcclusionCandidate => ({ rect, visible: true, emptyHost: false, ...extra });

test("空的常开通知 popover 有矩形也不遮挡", () => {
  assert.equal(isGhosttyOccluded(terminal, [candidate(terminal, { emptyHost: true })]), false);
});
test("零面积 popover 不遮挡", () => {
  for (const rect of [{ ...terminal, width: 0 }, { ...terminal, height: 0 }]) {
    assert.equal(isGhosttyOccluded(terminal, [candidate(rect)]), false);
  }
});
test("只覆盖侧栏或停在屏幕外的 popover 不遮挡", () => {
  for (const rect of [{ x: 0, y: 36, width: 260, height: 200 }, { x: -500, y: -500, width: 100, height: 100 }]) {
    assert.equal(isGhosttyOccluded(terminal, [candidate(rect)]), false);
  }
});
test("dialog 或菜单实际覆盖终端即遮挡", () => {
  assert.equal(isGhosttyOccluded(terminal, [candidate({ x: 250, y: 100, width: 30, height: 50 })]), true);
  assert.equal(isGhosttyOccluded(terminal, [candidate()]), true);
});
test("不可见候选不遮挡，有内容的通知与其他弹层同样按几何判断", () => {
  assert.equal(isGhosttyOccluded(terminal, [candidate(terminal, { visible: false })]), false);
  assert.equal(isGhosttyOccluded(terminal, [candidate(terminal, { emptyHost: true }), candidate()]), true);
});
