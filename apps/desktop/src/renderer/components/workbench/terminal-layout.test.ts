import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_LAYOUT,
  activateTab,
  activeTabIds,
  beginPendingTab,
  createLayout,
  dropPendingTab,
  effectiveLayout,
  equalizeSplit,
  focusGroup,
  focusGroupByIndex,
  focusGroupInDirection,
  focusedGroup,
  focusedGroupRelativeTab,
  focusedGroupTabAt,
  focusedTabId,
  groupBodyStyle,
  groupOfTab,
  layoutGeometry,
  listGroups,
  moveTabToGroup,
  moveTabToNewGroup,
  orderedGroups,
  parseLayout,
  planLayoutPersist,
  readStoredLayouts,
  reconcileLayout,
  removeTab,
  resizeSplit,
  serializeLayouts,
  splitWithNewTab,
  writeStoredLayouts,
  type TerminalLayout,
} from "./terminal-layout";

/** The groups' tabs in layout order, for compact assertions. */
function tabsInOrder(layout: TerminalLayout): string[][] {
  return orderedGroups(layout).map((group) => [...group.tabs]);
}

function groupIdOf(layout: TerminalLayout, taskId: string): string {
  const group = groupOfTab(layout, taskId);
  assert.ok(group, `no group holds ${taskId}`);
  return group.id;
}

/** 2×2: [a | b] over [c | d], built with the same moves a user would make. */
function grid2x2(): TerminalLayout {
  let layout = createLayout(["a", "b", "c", "d"]);
  const g1 = groupIdOf(layout, "a");
  layout = moveTabToNewGroup(layout, "c", g1, "down");
  layout = moveTabToNewGroup(layout, "b", g1, "right");
  layout = moveTabToNewGroup(layout, "d", groupIdOf(layout, "c"), "right");
  return layout;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("a fresh layout is one group whose first tab is active", () => {
  const layout = createLayout(["a", "b"]);
  assert.equal(listGroups(layout.root).length, 1);
  assert.equal(focusedTabId(layout), "a");
  assert.deepEqual(activeTabIds(layout), ["a"]);
});

test("splitting to the right and down builds a grid numbered in reading order", () => {
  const layout = grid2x2();
  assert.deepEqual(tabsInOrder(layout), [["a"], ["b"], ["c"], ["d"]]);
  const rects = layoutGeometry(layout).groups.map((entry) => entry.rect);
  assert.deepEqual(rects, [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ]);
  assert.deepEqual(activeTabIds(layout).sort(), ["a", "b", "c", "d"]);
  // Every move focuses the group it created.
  assert.equal(focusedTabId(layout), "d");
});

test("a split along the parent's axis adds a sibling instead of nesting", () => {
  let layout = createLayout(["a", "b", "c"]);
  layout = moveTabToNewGroup(layout, "b", groupIdOf(layout, "a"), "right");
  layout = moveTabToNewGroup(layout, "c", groupIdOf(layout, "b"), "right");
  assert.equal(layout.root.kind, "split");
  assert.equal(layout.root.kind === "split" ? layout.root.children.length : 0, 3);
  assert.deepEqual(tabsInOrder(layout), [["a"], ["b"], ["c"]]);
  const widths = layoutGeometry(layout).groups.map((entry) => entry.rect.w);
  assert.deepEqual(widths, [0.5, 0.25, 0.25]);
  // Splitting to the left inserts before the target.
  layout = moveTabToNewGroup(createLayout(["a", "b"]), "b", "g1", "left");
  assert.deepEqual(tabsInOrder(layout), [["b"], ["a"]]);
});

test("splitting a group with its only tab does nothing", () => {
  const layout = createLayout(["a"]);
  assert.equal(moveTabToNewGroup(layout, "a", "g1", "right"), layout);
});

test("a new tab can open in a new group beside the focused one (⌘\\)", () => {
  const layout = splitWithNewTab(createLayout(["a"]), "g1", "down", "n");
  assert.deepEqual(tabsInOrder(layout), [["a"], ["n"]]);
  assert.equal(focusedTabId(layout), "n");
  assert.equal(layoutGeometry(layout).groups[1]!.rect.y, 0.5);
});

test("moving to another group's strip inserts at the index, activates there and collapses the emptied source", () => {
  let layout = createLayout(["a", "b", "c"]);
  layout = moveTabToNewGroup(layout, "c", "g1", "right");
  const right = groupIdOf(layout, "c");
  layout = moveTabToGroup(layout, "a", right, 0);
  assert.deepEqual(tabsInOrder(layout), [["b"], ["a", "c"]]);
  assert.equal(focusedTabId(layout), "a");
  layout = moveTabToGroup(layout, "b", right, 1);
  assert.deepEqual(tabsInOrder(layout), [["a", "b", "c"]]);
  assert.equal(layout.root.kind, "group");
});

test("dragging inside one strip reorders it", () => {
  const layout = createLayout(["a", "b", "c"]);
  assert.deepEqual(tabsInOrder(moveTabToGroup(layout, "a", "g1", 3)), [["b", "c", "a"]]);
  assert.deepEqual(tabsInOrder(moveTabToGroup(layout, "c", "g1", 0)), [["c", "a", "b"]]);
  assert.deepEqual(tabsInOrder(moveTabToGroup(layout, "b", "g1", 1)), [["a", "b", "c"]]);
  assert.equal(focusedTabId(moveTabToGroup(layout, "c", "g1", 0)), "c");
});

test("closing the last tab of a group collapses it; its neighbour absorbs the space and the focus", () => {
  let layout = grid2x2();
  layout = focusGroup(layout, groupIdOf(layout, "b"));
  layout = removeTab(layout, "b");
  assert.deepEqual(tabsInOrder(layout), [["a"], ["c"], ["d"]]);
  // [a] took b's half of the top row, and focus went to it.
  const top = layoutGeometry(layout).groups[0]!;
  assert.deepEqual(top.rect, { x: 0, y: 0, w: 1, h: 0.5 });
  assert.equal(focusedTabId(layout), "a");
});

test("focus moves to the absorbing neighbour that covers the removed group's place", () => {
  // [a | [b / c]]: removing c, b absorbs it; removing a (first child), the next sibling absorbs it.
  let layout = createLayout(["a", "b", "c"]);
  layout = moveTabToNewGroup(layout, "b", "g1", "right");
  layout = moveTabToNewGroup(layout, "c", groupIdOf(layout, "b"), "down");
  assert.equal(focusedTabId(removeTab(layout, "c")), "b");
  const focusedA = focusGroup(layout, groupIdOf(layout, "a"));
  const withoutA = removeTab(focusedA, "a");
  // The right column now fills the width. a's centre (0.25, 0.5) sits on the b/c boundary, and on a
  // tie the first group in layout order wins.
  assert.deepEqual(tabsInOrder(withoutA), [["b"], ["c"]]);
  assert.equal(focusedTabId(withoutA), "b");
  // With c taller, a's centre falls inside c and focus goes there.
  const sash = layoutGeometry(focusedA).sashes.find((entry) => entry.direction === "column")!;
  const tallC = resizeSplit(focusedA, sash.path, sash.index, [0.5, 0.5], -0.2, 0.1);
  assert.equal(focusedTabId(removeTab(tallC, "a")), "c");
});

test("closing a background group keeps the focus where it is", () => {
  let layout = grid2x2();
  layout = focusGroup(layout, groupIdOf(layout, "a"));
  assert.equal(focusedTabId(removeTab(layout, "d")), "a");
});

test("the last group never collapses", () => {
  const layout = removeTab(createLayout(["a"]), "a");
  assert.equal(layout.root.kind, "group");
  assert.deepEqual(tabsInOrder(layout), [[]]);
  assert.equal(focusedTabId(layout), null);
  assert.equal(focusedGroup(layout).id, layout.focusedGroupId);
});

test("closing the active tab falls back to the group's first tab; a background tab keeps the choice", () => {
  let layout = activateTab(createLayout(["a", "b", "c"]), "b");
  assert.equal(focusedTabId(removeTab(layout, "b")), "a");
  layout = activateTab(layout, "c");
  assert.equal(focusedTabId(removeTab(layout, "a")), "c");
});

test("focus by index follows layout order and ignores out-of-range", () => {
  const layout = grid2x2();
  assert.equal(focusedTabId(focusGroupByIndex(layout, 0)), "a");
  assert.equal(focusedTabId(focusGroupByIndex(layout, 1)), "b");
  assert.equal(focusedTabId(focusGroupByIndex(layout, 2)), "c");
  assert.equal(focusGroupByIndex(layout, 8), layout);
});

test("layout order is reading order of the top-left corners, whatever the tree shape", () => {
  // [[a / c] | b]: the tree lists a, c, b; reading order is a, b, c.
  let layout = createLayout(["a", "b", "c"]);
  layout = moveTabToNewGroup(layout, "b", "g1", "right");
  layout = moveTabToNewGroup(layout, "c", groupIdOf(layout, "a"), "down");
  assert.deepEqual(listGroups(layout.root).map((group) => group.tabs[0]), ["a", "c", "b"]);
  assert.deepEqual(tabsInOrder(layout), [["a"], ["b"], ["c"]]);
});

test("focus moves to the adjacent group in each direction and stays put at the edge", () => {
  let layout = focusGroup(grid2x2(), "g1");
  assert.equal(focusedTabId(layout), "a");
  layout = focusGroupInDirection(layout, "right");
  assert.equal(focusedTabId(layout), "b");
  layout = focusGroupInDirection(layout, "down");
  assert.equal(focusedTabId(layout), "d");
  layout = focusGroupInDirection(layout, "left");
  assert.equal(focusedTabId(layout), "c");
  layout = focusGroupInDirection(layout, "up");
  assert.equal(focusedTabId(layout), "a");
  assert.equal(focusGroupInDirection(layout, "up"), layout);
  assert.equal(focusGroupInDirection(layout, "left"), layout);
});

test("directional focus prefers the neighbour that overlaps the most", () => {
  // [a | [b / c]] with b taking 70% of the right column: from a, right goes to b.
  let layout = createLayout(["a", "b", "c"]);
  layout = moveTabToNewGroup(layout, "b", "g1", "right");
  layout = moveTabToNewGroup(layout, "c", groupIdOf(layout, "b"), "down");
  const sash = layoutGeometry(layout).sashes.find((entry) => entry.direction === "column")!;
  layout = resizeSplit(layout, sash.path, sash.index, [0.5, 0.5], 0.2, 0.1);
  layout = focusGroup(layout, groupIdOf(layout, "a"));
  assert.equal(focusedTabId(focusGroupInDirection(layout, "right")), "b");
});

test("per-group tab selection works on the focused group only", () => {
  let layout = createLayout(["a", "b", "c"]);
  layout = moveTabToNewGroup(layout, "c", "g1", "right");
  layout = focusGroup(layout, "g1");
  assert.equal(focusedGroupTabAt(layout, 1), "b");
  assert.equal(focusedGroupTabAt(layout, 2), null);
  assert.equal(focusedGroupRelativeTab(layout, 1), "b");
  assert.equal(focusedGroupRelativeTab(layout, -1), "b");
  assert.equal(focusedGroupRelativeTab(activateTab(layout, "b"), 1), "a");
});

test("sash drags respect the minimum size and double-click equalises", () => {
  let layout = moveTabToNewGroup(createLayout(["a", "b"]), "b", "g1", "right");
  const sash = layoutGeometry(layout).sashes[0]!;
  layout = resizeSplit(layout, sash.path, sash.index, [0.5, 0.5], 0.3, 0.1);
  assert.deepEqual(layoutGeometry(layout).groups.map((entry) => Math.round(entry.rect.w * 100)), [80, 20]);
  layout = resizeSplit(layout, sash.path, sash.index, [0.5, 0.5], 0.9, 0.1);
  assert.deepEqual(layoutGeometry(layout).groups.map((entry) => Math.round(entry.rect.w * 100)), [90, 10]);
  layout = equalizeSplit(layout, sash.path);
  assert.deepEqual(layoutGeometry(layout).groups.map((entry) => entry.rect.w), [0.5, 0.5]);
  assert.equal(equalizeSplit(layout, sash.path), layout);
});

test("pane rectangles are percentages with the strip height taken off the top", () => {
  assert.deepEqual(groupBodyStyle({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }), {
    left: "50%",
    top: "calc(50% + 36px)",
    width: "50%",
    height: "calc(50% - 36px)",
  });
});

test("reconcile appends new tasks to the focused group without stealing its active tab", () => {
  let layout = moveTabToNewGroup(createLayout(["a", "b"]), "b", "g1", "right");
  layout = focusGroup(layout, groupIdOf(layout, "a"));
  const next = reconcileLayout(layout, ["a", "b", "n"]);
  assert.deepEqual(tabsInOrder(next), [["a", "n"], ["b"]]);
  assert.equal(focusedTabId(next), "a");
  // An empty focused group takes the new task as its active tab.
  const empty = reconcileLayout(createLayout(), ["n"]);
  assert.equal(focusedTabId(empty), "n");
});

test("reconcile removes vanished tasks and collapses emptied groups", () => {
  const layout = grid2x2();
  const next = reconcileLayout(layout, ["a", "c"]);
  assert.deepEqual(tabsInOrder(next), [["a"], ["c"]]);
});

test("reconcile returns the same object when nothing changed", () => {
  const layout = grid2x2();
  assert.equal(reconcileLayout(layout, ["a", "b", "c", "d"]), layout);
  assert.equal(reconcileLayout(EMPTY_LAYOUT, []), EMPTY_LAYOUT);
});

test("a task that moved workspace leaves the old layout and lands in the new one's focused group, active if it was watched", () => {
  // Workspace A shows a and b; b moves to workspace B, which shows x in two groups.
  const before = moveTabToNewGroup(createLayout(["a", "b"]), "b", "g1", "right");
  const oldLayout = reconcileLayout(before, ["a"]);
  assert.deepEqual(tabsInOrder(oldLayout), [["a"]]);

  let target = moveTabToNewGroup(createLayout(["x", "y"]), "y", "g1", "right");
  target = focusGroup(target, groupIdOf(target, "x"));
  const unwatched = reconcileLayout(target, ["x", "y", "b"]);
  assert.deepEqual(tabsInOrder(unwatched), [["x", "b"], ["y"]]);
  assert.equal(focusedTabId(unwatched), "x");
  const watched = reconcileLayout(target, ["x", "y", "b"], { follow: "b" });
  assert.equal(focusedTabId(watched), "b");
  assert.equal(groupIdOf(watched, "b"), groupIdOf(target, "x"));
});

test("the pending tab survives reconcile and is replaced in place by the created task", () => {
  let layout = moveTabToNewGroup(createLayout(["a", "b"]), "b", "g1", "right");
  layout = focusGroup(layout, groupIdOf(layout, "a"));
  layout = beginPendingTab(layout, { id: "pending-tab-1", title: "终端 3", knownTaskIds: ["a", "b"] }, "down");
  assert.equal(focusedTabId(layout), "pending-tab-1");
  const pendingGroup = groupIdOf(layout, "pending-tab-1");
  // Still waiting: the group holding only the pending tab does not collapse.
  assert.equal(reconcileLayout(layout, ["a", "b"]), layout);
  // The user moves focus elsewhere while waiting; the created task still lands where the pending tab was.
  const moved = focusGroup(layout, groupIdOf(layout, "b"));
  const settled = reconcileLayout(moved, ["a", "b", "new"]);
  assert.equal(settled.pending, undefined);
  assert.equal(groupIdOf(settled, "new"), pendingGroup);
  assert.equal(focusedTabId(settled), "b");
  assert.equal(orderedGroups(settled).find((group) => group.id === pendingGroup)?.activeTabId, "new");
});

test("a pending tab in an existing group is replaced at its position", () => {
  let layout = beginPendingTab(createLayout(["a", "b"]), { id: "pending-tab-2", title: "终端 3", knownTaskIds: ["a", "b"] });
  layout = moveTabToGroup(layout, "pending-tab-2", "g1", 1);
  const settled = reconcileLayout(layout, ["a", "b", "new"]);
  assert.deepEqual(tabsInOrder(settled), [["a", "new", "b"]]);
  assert.equal(focusedTabId(settled), "new");
});

test("a second pending create is refused while one is in flight", () => {
  const layout = beginPendingTab(createLayout(["a"]), { id: "pending-tab-1", title: "终端 2", knownTaskIds: ["a"] });
  assert.equal(beginPendingTab(layout, { id: "pending-tab-2", title: "终端 3", knownTaskIds: ["a"] }, "right"), layout);
});

test("dropping a failed pending tab collapses its group and returns focus to the absorbing neighbour", () => {
  const layout = beginPendingTab(createLayout(["a"]), { id: "pending-tab-1", title: "终端 2", knownTaskIds: ["a"] }, "right");
  const dropped = dropPendingTab(layout, "pending-tab-1");
  assert.deepEqual(tabsInOrder(dropped), [["a"]]);
  assert.equal(focusedTabId(dropped), "a");
  assert.equal(dropped.pending, undefined);
  // A stale id (another create) is ignored.
  assert.equal(dropPendingTab(layout, "pending-tab-9"), layout);
});

test("before the first snapshot the stored layout is used untouched", () => {
  const stored = grid2x2();
  // An empty task list before the first snapshot means "nothing has arrived", not "everything closed".
  assert.equal(effectiveLayout(stored, [], { snapshotReady: false }), stored);
  assert.equal(effectiveLayout(undefined, [], { snapshotReady: false }), EMPTY_LAYOUT);
  assert.deepEqual(tabsInOrder(effectiveLayout(stored, ["a"], { snapshotReady: true })), [["a"]]);
});

test("nothing is persisted before the first snapshot, and an unchanged value is not rewritten", () => {
  const layouts = { ws: grid2x2() };
  assert.equal(planLayoutPersist({ snapshotReady: false, layouts: { ws: createLayout() }, lastWritten: "anything" }), null);
  const first = planLayoutPersist({ snapshotReady: true, layouts, lastWritten: null });
  assert.ok(first);
  assert.equal(planLayoutPersist({ snapshotReady: true, layouts, lastWritten: first }), null);
});

test("layouts round-trip through storage with ratios, active tabs and focus", () => {
  let layout = grid2x2();
  const sash = layoutGeometry(layout).sashes[0]!;
  layout = resizeSplit(layout, sash.path, sash.index, [0.5, 0.5], 0.1, 0.05);
  layout = focusGroup(layout, groupIdOf(layout, "b"));
  const storage = memoryStorage();
  const store = { storage, key: "layouts" };
  assert.ok(writeStoredLayouts(store, serializeLayouts({ ws: layout })));
  const restored = readStoredLayouts(store).ws!;
  assert.deepEqual(tabsInOrder(restored), tabsInOrder(layout));
  assert.deepEqual(
    layoutGeometry(restored).groups.map((entry) => entry.rect),
    layoutGeometry(layout).groups.map((entry) => entry.rect),
  );
  assert.equal(focusedTabId(restored), "b");
});

test("the pending tab is never persisted", () => {
  const layout = beginPendingTab(createLayout(["a"]), { id: "pending-tab-1", title: "终端 2", knownTaskIds: ["a"] }, "right");
  const storage = memoryStorage();
  writeStoredLayouts({ storage, key: "k" }, serializeLayouts({ ws: layout }));
  const restored = readStoredLayouts({ storage, key: "k" }).ws!;
  assert.deepEqual(tabsInOrder(restored), [["a"]]);
  assert.equal(restored.pending, undefined);
});

test("malformed storage reads as nothing stored or as a single group", () => {
  const read = (raw: string) => readStoredLayouts({ storage: memoryStorage({ k: raw }), key: "k" });
  assert.deepEqual(read("not json"), {});
  assert.deepEqual(read("[]"), {});
  assert.deepEqual(read(JSON.stringify({ version: 99, layouts: {} })), {});
  const junk = read(JSON.stringify({ version: 1, layouts: { ws: { root: { kind: "banana" } }, other: 42 } }));
  assert.deepEqual(tabsInOrder(junk.ws!), [[]]);
  assert.deepEqual(tabsInOrder(junk.other!), [[]]);
  // Storage that throws is the same as empty storage.
  const throwing = {
    storage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
    key: "k",
  };
  assert.deepEqual(readStoredLayouts(throwing), {});
  assert.equal(writeStoredLayouts(throwing, "{}"), false);
});

test("parsing repairs bad ratios, duplicate tabs, duplicate group ids and a missing focus", () => {
  const layout = parseLayout({
    focusedGroupId: "nope",
    root: {
      kind: "split",
      direction: "row",
      sizes: [-1, "x"],
      children: [
        { kind: "group", id: "same", tabs: ["a", "a", 7, "pending-tab-3"], activeTabId: "zzz" },
        { kind: "group", id: "same", tabs: ["a", "b"], activeTabId: "b" },
        { kind: "group", id: "empty", tabs: [] },
      ],
    },
  });
  assert.deepEqual(tabsInOrder(layout), [["a"], ["b"]]);
  assert.deepEqual(layoutGeometry(layout).groups.map((entry) => entry.rect.w), [0.5, 0.5]);
  const ids = listGroups(layout.root).map((group) => group.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(focusedGroup(layout).id, ids[0]);
  assert.equal(orderedGroups(layout)[0]!.activeTabId, "a");
});

test("stored ids that are no longer tasks are dropped by the first reconcile after the snapshot", () => {
  const storage = memoryStorage();
  writeStoredLayouts({ storage, key: "k" }, serializeLayouts({ ws: grid2x2() }));
  const restored = readStoredLayouts({ storage, key: "k" }).ws!;
  assert.deepEqual(tabsInOrder(effectiveLayout(restored, ["b", "d", "e"], { snapshotReady: true })), [["b"], ["d", "e"]]);
});
