/**
 * Terminal editor groups (plan 20260923-terminal-split-groups).
 *
 * A workspace's main area is a grid of groups in the style of VS Code's editor groups: every group
 * has its own tab strip and one active tab, groups split left/right and up/down and nest
 * arbitrarily. This module is the whole model — pure values and pure functions, no React, no DOM,
 * no `@/config`, no `localStorage` — so it runs under plain Node in the unit tests. Storage is
 * injected by the caller, exactly as the ⌘P recent-places store is.
 *
 * Shape: an n-ary tree. A split lays its children out along one axis ("row" = side by side,
 * "column" = stacked) with fractional sizes that sum to 1. Splitting a group in the axis of its
 * parent inserts a sibling instead of nesting, so three side-by-side groups are one split of
 * three, not a split inside a split. The tree never goes below one group: the last group survives
 * being emptied and renders the empty state.
 *
 * Geometry is fractional (0..1 of the main area) and derived from the tree alone, so the renderer
 * can lay panes out with percentages in the same frame instead of measuring.
 */

export type SplitDirection = "row" | "column";
/** Where a new group goes relative to an existing one; also the direction of a focus move. */
export type LayoutSide = "left" | "right" | "up" | "down";

export type LayoutGroup = {
  kind: "group";
  id: string;
  /** Task ids in tab-strip order. May include the optimistic pending tab's id. */
  tabs: readonly string[];
  activeTabId: string | null;
};

export type LayoutSplit = {
  kind: "split";
  direction: SplitDirection;
  children: readonly LayoutNode[];
  /** Fractions of the split's extent along its axis; same length as `children`, sum 1. */
  sizes: readonly number[];
};

export type LayoutNode = LayoutGroup | LayoutSplit;

/**
 * The optimistic tab of an in-flight terminal create (plan 078). It is a first-class layout entry:
 * reconcile does not drop its id for being absent from the task list, and the first task that
 * appears which was not known when the create started replaces it in the same group at the same
 * position. Never persisted.
 */
export type PendingTab = {
  id: string;
  title: string;
  /** Task ids of the workspace when the create was sent. */
  knownTaskIds: readonly string[];
};

export type TerminalLayout = {
  root: LayoutNode;
  focusedGroupId: string;
  pending?: PendingTab;
};

export type LayoutRect = { x: number; y: number; w: number; h: number };

export type LayoutGroupGeometry = { group: LayoutGroup; rect: LayoutRect };

export type LayoutSash = {
  /** Child indices from the root to the split this sash belongs to. */
  path: readonly number[];
  /** The sash sits between child `index` and child `index + 1`. */
  index: number;
  direction: SplitDirection;
  /** The split's own rectangle. */
  splitRect: LayoutRect;
  /** Position of the boundary along the split's axis, in main-area fractions. */
  position: number;
};

export type LayoutGeometry = {
  /** Groups in layout order: reading order of their top-left corners (top to bottom, left to right). */
  groups: readonly LayoutGroupGeometry[];
  sashes: readonly LayoutSash[];
};

/** Prefix of the optimistic tab's fake id; such ids never reach the attach machine or storage. */
export const PENDING_TAB_PREFIX = "pending-tab-";

/**
 * Prefix of a built-in browser tab's id (plan 20260924-desktop-browser-tab). Browser tabs are
 * layout entries like terminals — they move, split, close and take focus the same way — but they
 * are not tasks: reconcile never drops them for being absent from the task list, and every
 * terminal-only path (attach, stop-on-close, cross-workspace moves) skips them by this prefix.
 * Unlike the pending tab they are persisted; their URL and title live in a separate per-workspace
 * record (browser-tabs.ts).
 */
export const BROWSER_TAB_PREFIX = "browser-tab-";

export function isBrowserTabId(id: string): boolean {
  return id.startsWith(BROWSER_TAB_PREFIX);
}

/** A layout id that is a terminal task — neither the optimistic pending tab nor a browser tab. */
export function isTaskTabId(id: string): boolean {
  return !id.startsWith(PENDING_TAB_PREFIX) && !isBrowserTabId(id);
}

const EPSILON = 1e-6;

// ---------------------------------------------------------------------------------------------
// Construction and lookup
// ---------------------------------------------------------------------------------------------

export function createLayout(tabs: readonly string[] = []): TerminalLayout {
  return { root: { kind: "group", id: "g1", tabs: [...tabs], activeTabId: tabs[0] ?? null }, focusedGroupId: "g1" };
}

/** Frozen single empty group: what a workspace without a stored layout starts from. */
export const EMPTY_LAYOUT: TerminalLayout = Object.freeze(createLayout());

/** Groups in tree (depth-first) order. */
export function listGroups(node: LayoutNode): LayoutGroup[] {
  if (node.kind === "group") return [node];
  return node.children.flatMap(listGroups);
}

export function findGroup(layout: TerminalLayout, groupId: string): LayoutGroup | null {
  return listGroups(layout.root).find((group) => group.id === groupId) ?? null;
}

export function groupOfTab(layout: TerminalLayout, taskId: string): LayoutGroup | null {
  return listGroups(layout.root).find((group) => group.tabs.includes(taskId)) ?? null;
}

export function focusedGroup(layout: TerminalLayout): LayoutGroup {
  return findGroup(layout, layout.focusedGroupId) ?? listGroups(layout.root)[0]!;
}

/** The focused group's active tab — the terminal the user is looking at and typing into. */
export function focusedTabId(layout: TerminalLayout): string | null {
  return focusedGroup(layout).activeTabId;
}

/** Every group's active tab: the set of panes on screen when the workspace is. */
export function activeTabIds(layout: TerminalLayout): string[] {
  return listGroups(layout.root)
    .map((group) => group.activeTabId)
    .filter((id): id is string => id !== null);
}

export function layoutTabIds(layout: TerminalLayout): string[] {
  return listGroups(layout.root).flatMap((group) => group.tabs);
}

/** The layout's browser tabs, in layout (tree) order. */
export function browserTabIdsOf(layout: TerminalLayout): string[] {
  return layoutTabIds(layout).filter(isBrowserTabId);
}

function nextGroupId(root: LayoutNode): string {
  let max = 0;
  for (const group of listGroups(root)) {
    const match = /^g(\d+)$/.exec(group.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `g${max + 1}`;
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

function walkGeometry(node: LayoutNode, rect: LayoutRect, path: number[], groups: LayoutGroupGeometry[], sashes: LayoutSash[]) {
  if (node.kind === "group") {
    groups.push({ group: node, rect });
    return;
  }
  const row = node.direction === "row";
  let offset = 0;
  node.children.forEach((child, index) => {
    const size = node.sizes[index] ?? 0;
    const childRect: LayoutRect = row
      ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
    walkGeometry(child, childRect, [...path, index], groups, sashes);
    offset += size;
    if (index < node.children.length - 1) {
      sashes.push({
        path,
        index,
        direction: node.direction,
        splitRect: rect,
        position: row ? rect.x + offset * rect.w : rect.y + offset * rect.h,
      });
    }
  });
}

function compareReadingOrder(left: LayoutRect, right: LayoutRect): number {
  const dy = left.y - right.y;
  if (Math.abs(dy) > EPSILON) return dy;
  const dx = left.x - right.x;
  return Math.abs(dx) > EPSILON ? dx : 0;
}

export function layoutGeometry(layout: TerminalLayout): LayoutGeometry {
  const groups: LayoutGroupGeometry[] = [];
  const sashes: LayoutSash[] = [];
  walkGeometry(layout.root, { x: 0, y: 0, w: 1, h: 1 }, [], groups, sashes);
  // Stable sort: equal corners (cannot happen in a valid tree) keep tree order.
  groups.sort((left, right) => compareReadingOrder(left.rect, right.rect));
  return { groups, sashes };
}

/** Groups in layout order — the numbering of ⌘1–9. */
export function orderedGroups(layout: TerminalLayout): LayoutGroup[] {
  return layoutGeometry(layout).groups.map((entry) => entry.group);
}

export function touchesTop(rect: LayoutRect): boolean {
  return rect.y < EPSILON;
}

export function touchesLeft(rect: LayoutRect): boolean {
  return rect.x < EPSILON;
}

export function touchesRight(rect: LayoutRect): boolean {
  return rect.x + rect.w > 1 - EPSILON;
}

// ---------------------------------------------------------------------------------------------
// Tree surgery
// ---------------------------------------------------------------------------------------------

function normalizeSizes(sizes: readonly number[]): number[] {
  const clean = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0));
  const total = clean.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return clean.map((size) => size / total);
}

/**
 * A split with one child is that child; a child split along the same axis is spliced into its
 * parent, with its sizes scaled into the slot it occupied.
 */
function normalizeSplit(split: LayoutSplit): LayoutNode {
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  split.children.forEach((child, index) => {
    const size = split.sizes[index] ?? 0;
    if (child.kind === "split" && child.direction === split.direction) {
      child.children.forEach((grandchild, grandIndex) => {
        children.push(grandchild);
        sizes.push(size * (child.sizes[grandIndex] ?? 0));
      });
    } else {
      children.push(child);
      sizes.push(size);
    }
  });
  if (children.length === 1) return children[0]!;
  return { kind: "split", direction: split.direction, children, sizes: normalizeSizes(sizes) };
}

function mapGroups(node: LayoutNode, fn: (group: LayoutGroup) => LayoutGroup): LayoutNode {
  if (node.kind === "group") return fn(node);
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapGroups(child, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function updateGroup(layout: TerminalLayout, groupId: string, fn: (group: LayoutGroup) => LayoutGroup): TerminalLayout {
  const root = mapGroups(layout.root, (group) => (group.id === groupId ? fn(group) : group));
  return root === layout.root ? layout : { ...layout, root };
}

type Removal = { node: LayoutNode | null; absorbing: ReadonlySet<string> | null };

/** Removes a group node; the sibling before it (or after, when it was first) absorbs its size. */
function removeGroupNode(node: LayoutNode, groupId: string): Removal | null {
  if (node.kind === "group") return node.id === groupId ? { node: null, absorbing: null } : null;
  for (let index = 0; index < node.children.length; index++) {
    const result = removeGroupNode(node.children[index]!, groupId);
    if (!result) continue;
    if (result.node) {
      const children = node.children.map((child, i) => (i === index ? result.node! : child));
      return { node: normalizeSplit({ ...node, children }), absorbing: result.absorbing };
    }
    const children = node.children.filter((_, i) => i !== index);
    const sizes = node.sizes.filter((_, i) => i !== index);
    const absorbingIndex = index > 0 ? index - 1 : 0;
    sizes[absorbingIndex] = (sizes[absorbingIndex] ?? 0) + (node.sizes[index] ?? 0);
    const absorbing = new Set(listGroups(children[absorbingIndex]!).map((group) => group.id));
    return { node: normalizeSplit({ ...node, children, sizes }), absorbing };
  }
  return null;
}

function rectCenter(rect: LayoutRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * Removes an empty group from the tree. The last group never goes: the tree keeps at least one.
 * When the removed group had focus, focus goes to the group of the absorbing neighbour that now
 * covers the removed group's centre (VS Code behaviour).
 */
function collapseGroup(layout: TerminalLayout, groupId: string): TerminalLayout {
  if (layout.root.kind === "group") return layout;
  const before = layoutGeometry(layout).groups.find((entry) => entry.group.id === groupId);
  const removal = removeGroupNode(layout.root, groupId);
  if (!removal || !removal.node) return layout;
  const root = removal.node;
  let focusedGroupId = layout.focusedGroupId;
  if (focusedGroupId === groupId || !listGroups(root).some((group) => group.id === focusedGroupId)) {
    const candidates = layoutGeometry({ root, focusedGroupId }).groups.filter(
      (entry) => !removal.absorbing || removal.absorbing.has(entry.group.id),
    );
    const center = before ? rectCenter(before.rect) : { x: 0, y: 0 };
    let best = candidates[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of candidates) {
      const c = rectCenter(entry.rect);
      const inside =
        center.x >= entry.rect.x - EPSILON &&
        center.x <= entry.rect.x + entry.rect.w + EPSILON &&
        center.y >= entry.rect.y - EPSILON &&
        center.y <= entry.rect.y + entry.rect.h + EPSILON;
      const distance = inside ? -1 : Math.hypot(c.x - center.x, c.y - center.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    }
    focusedGroupId = best?.group.id ?? listGroups(root)[0]!.id;
  }
  return { ...layout, root, focusedGroupId };
}

function axisOf(side: LayoutSide): SplitDirection {
  return side === "left" || side === "right" ? "row" : "column";
}

function insertsAfter(side: LayoutSide): boolean {
  return side === "right" || side === "down";
}

/** Puts `group` beside the target group: a sibling when the parent runs along that axis, else a new split. */
function insertBeside(node: LayoutNode, targetGroupId: string, side: LayoutSide, group: LayoutGroup): LayoutNode | null {
  const direction = axisOf(side);
  if (node.kind === "group") {
    if (node.id !== targetGroupId) return null;
    return {
      kind: "split",
      direction,
      children: insertsAfter(side) ? [node, group] : [group, node],
      sizes: [0.5, 0.5],
    };
  }
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index]!;
    if (child.kind === "group" && child.id === targetGroupId && node.direction === direction) {
      const half = (node.sizes[index] ?? 0) / 2;
      const children = [...node.children];
      const sizes = [...node.sizes];
      const at = insertsAfter(side) ? index + 1 : index;
      sizes[index] = half;
      children.splice(at, 0, group);
      sizes.splice(at, 0, half);
      return { ...node, children, sizes: normalizeSizes(sizes) };
    }
    const next = insertBeside(child, targetGroupId, side, group);
    if (next) {
      const children = node.children.map((item, i) => (i === index ? next : item));
      return normalizeSplit({ ...node, children });
    }
  }
  return null;
}

/** Removes one tab from one group; an emptied group collapses (unless it is the last one). */
function removeTabFromGroup(layout: TerminalLayout, groupId: string, taskId: string): TerminalLayout {
  const group = findGroup(layout, groupId);
  if (!group || !group.tabs.includes(taskId)) return layout;
  const tabs = group.tabs.filter((id) => id !== taskId);
  // Same fallback as before groups existed: closing the active tab lands on the group's first tab;
  // closing a background tab keeps the current choice.
  const activeTabId = group.activeTabId === taskId ? (tabs[0] ?? null) : group.activeTabId;
  const next = updateGroup(layout, groupId, (item) => ({ ...item, tabs, activeTabId }));
  return tabs.length === 0 ? collapseGroup(next, groupId) : next;
}

function withoutPending(layout: TerminalLayout): TerminalLayout {
  return { root: layout.root, focusedGroupId: layout.focusedGroupId };
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export function focusGroup(layout: TerminalLayout, groupId: string): TerminalLayout {
  if (layout.focusedGroupId === groupId || !findGroup(layout, groupId)) return layout;
  return { ...layout, focusedGroupId: groupId };
}

/** Makes a tab the active one of its group and focuses that group. */
export function activateTab(layout: TerminalLayout, taskId: string): TerminalLayout {
  const group = groupOfTab(layout, taskId);
  if (!group) return layout;
  const next = group.activeTabId === taskId ? layout : updateGroup(layout, group.id, (item) => ({ ...item, activeTabId: taskId }));
  return focusGroup(next, group.id);
}

/**
 * Makes sure a task is on screen: activates it where it is, or — when the layout does not have it
 * yet — appends it to the focused group and activates it there. Palette and notification jumps.
 */
export function revealTab(layout: TerminalLayout, taskId: string): TerminalLayout {
  if (groupOfTab(layout, taskId)) return activateTab(layout, taskId);
  const target = focusedGroup(layout);
  return updateGroup(layout, target.id, (group) => ({ ...group, tabs: [...group.tabs, taskId], activeTabId: taskId }));
}

/**
 * Puts a tab that is not in the layout yet right after `anchorId`, in the anchor's group, and makes
 * it that group's active tab with the group focused — a page's `window.open` / `target=_blank`
 * opening a browser tab beside its opener. Without the anchor in the layout it behaves like
 * `revealTab`.
 */
export function openTabBeside(layout: TerminalLayout, anchorId: string, taskId: string): TerminalLayout {
  if (groupOfTab(layout, taskId)) return activateTab(layout, taskId);
  const anchor = groupOfTab(layout, anchorId);
  if (!anchor) return revealTab(layout, taskId);
  const next = updateGroup(layout, anchor.id, (group) => {
    const tabs = [...group.tabs];
    tabs.splice(tabs.indexOf(anchorId) + 1, 0, taskId);
    return { ...group, tabs, activeTabId: taskId };
  });
  return focusGroup(next, anchor.id);
}

/** Removes a tab wherever it is; its group collapses when emptied. Clears the pending entry if it was that. */
export function removeTab(layout: TerminalLayout, taskId: string): TerminalLayout {
  const group = groupOfTab(layout, taskId);
  let next = group ? removeTabFromGroup(layout, group.id, taskId) : layout;
  if (next.pending?.id === taskId) next = withoutPending(next);
  return next;
}

/** Focuses the Nth group in layout order (0-based). Out of range → unchanged. */
export function focusGroupByIndex(layout: TerminalLayout, index: number): TerminalLayout {
  const group = orderedGroups(layout)[index];
  return group ? focusGroup(layout, group.id) : layout;
}

/** The group adjacent to the focused one in a direction, or null at the edge. */
export function neighbourGroup(layout: TerminalLayout, side: LayoutSide): LayoutGroup | null {
  const { groups } = layoutGeometry(layout);
  const current = groups.find((entry) => entry.group.id === layout.focusedGroupId) ?? groups[0];
  if (!current) return null;
  const from = current.rect;
  let best: { entry: LayoutGroupGeometry; gap: number; overlap: number; offset: number } | null = null;
  for (const entry of groups) {
    if (entry === current) continue;
    const to = entry.rect;
    let gap: number;
    let overlap: number;
    let offset: number;
    if (side === "left" || side === "right") {
      gap = side === "right" ? to.x - (from.x + from.w) : from.x - (to.x + to.w);
      overlap = Math.min(from.y + from.h, to.y + to.h) - Math.max(from.y, to.y);
      offset = Math.abs(to.y - from.y);
    } else {
      gap = side === "down" ? to.y - (from.y + from.h) : from.y - (to.y + to.h);
      overlap = Math.min(from.x + from.w, to.x + to.w) - Math.max(from.x, to.x);
      offset = Math.abs(to.x - from.x);
    }
    if (gap < -EPSILON || overlap <= EPSILON) continue;
    const better =
      !best ||
      gap < best.gap - EPSILON ||
      (Math.abs(gap - best.gap) <= EPSILON && (overlap > best.overlap + EPSILON || (Math.abs(overlap - best.overlap) <= EPSILON && offset < best.offset)));
    if (better) best = { entry, gap, overlap, offset };
  }
  return best?.entry.group ?? null;
}

export function focusGroupInDirection(layout: TerminalLayout, side: LayoutSide): TerminalLayout {
  const group = neighbourGroup(layout, side);
  return group ? focusGroup(layout, group.id) : layout;
}

/** The focused group's Nth tab (0-based), or null. */
export function focusedGroupTabAt(layout: TerminalLayout, index: number): string | null {
  return focusedGroup(layout).tabs[index] ?? null;
}

/** The focused group's tab `delta` steps from its active one, cycling; null when it has none. */
export function focusedGroupRelativeTab(layout: TerminalLayout, delta: number): string | null {
  const group = focusedGroup(layout);
  const count = group.tabs.length;
  if (count === 0) return null;
  const current = group.activeTabId ? group.tabs.indexOf(group.activeTabId) : -1;
  const base = current === -1 ? 0 : current;
  return group.tabs[(((base + delta) % count) + count) % count] ?? null;
}

/**
 * A new group beside `targetGroupId` holding one tab that is not in the layout yet (⌘\ opening a
 * new terminal). The new group gets focus.
 */
export function splitWithNewTab(layout: TerminalLayout, targetGroupId: string, side: LayoutSide, taskId: string): TerminalLayout {
  if (!findGroup(layout, targetGroupId) || groupOfTab(layout, taskId)) return layout;
  const group: LayoutGroup = { kind: "group", id: nextGroupId(layout.root), tabs: [taskId], activeTabId: taskId };
  const root = insertBeside(layout.root, targetGroupId, side, group);
  return root ? { ...layout, root, focusedGroupId: group.id } : layout;
}

/**
 * Moves a tab into a new group on one side of `targetGroupId` (drop on a group edge, or the tab
 * context menu's 「移到右侧新分组」/「移到下方新分组」). Its old group collapses if emptied. Splitting a group
 * with its only tab is a no-op — there would be nothing left behind.
 */
export function moveTabToNewGroup(layout: TerminalLayout, taskId: string, targetGroupId: string, side: LayoutSide): TerminalLayout {
  const source = groupOfTab(layout, taskId);
  if (!source || !findGroup(layout, targetGroupId)) return layout;
  if (source.id === targetGroupId && source.tabs.length === 1) return layout;
  const group: LayoutGroup = { kind: "group", id: nextGroupId(layout.root), tabs: [taskId], activeTabId: taskId };
  // Take the tab out first without collapsing, so the target group still exists to split beside.
  const tabs = source.tabs.filter((id) => id !== taskId);
  const activeTabId = source.activeTabId === taskId ? (tabs[0] ?? null) : source.activeTabId;
  const detached = updateGroup(layout, source.id, (item) => ({ ...item, tabs, activeTabId }));
  const root = insertBeside(detached.root, targetGroupId, side, group);
  if (!root) return layout;
  const inserted: TerminalLayout = { ...detached, root, focusedGroupId: group.id };
  return tabs.length === 0 ? collapseGroup(inserted, source.id) : inserted;
}

/**
 * Moves a tab into a group's strip at `index` (drop on a strip), or reorders within one strip.
 * The tab becomes that group's active tab and the group gets focus; an emptied source collapses.
 */
export function moveTabToGroup(layout: TerminalLayout, taskId: string, targetGroupId: string, index: number): TerminalLayout {
  const source = groupOfTab(layout, taskId);
  const target = findGroup(layout, targetGroupId);
  if (!source || !target) return layout;
  if (source.id === target.id) {
    const from = source.tabs.indexOf(taskId);
    const tabs = source.tabs.filter((id) => id !== taskId);
    // `index` counts positions in the strip as the user saw it, the dragged tab included.
    const at = Math.max(0, Math.min(tabs.length, index > from ? index - 1 : index));
    tabs.splice(at, 0, taskId);
    const unchanged = tabs.every((id, i) => id === source.tabs[i]);
    const next = unchanged ? layout : updateGroup(layout, source.id, (group) => ({ ...group, tabs }));
    return activateTab(next, taskId);
  }
  const sourceTabs = source.tabs.filter((id) => id !== taskId);
  const sourceActive = source.activeTabId === taskId ? (sourceTabs[0] ?? null) : source.activeTabId;
  let next = updateGroup(layout, source.id, (group) => ({ ...group, tabs: sourceTabs, activeTabId: sourceActive }));
  next = updateGroup(next, target.id, (group) => {
    const tabs = [...group.tabs];
    tabs.splice(Math.max(0, Math.min(tabs.length, index)), 0, taskId);
    return { ...group, tabs, activeTabId: taskId };
  });
  next = { ...next, focusedGroupId: target.id };
  return sourceTabs.length === 0 ? collapseGroup(next, source.id) : next;
}

function splitAt(node: LayoutNode, path: readonly number[]): LayoutSplit | null {
  let current: LayoutNode = node;
  for (const index of path) {
    if (current.kind !== "split") return null;
    const child: LayoutNode | undefined = current.children[index];
    if (!child) return null;
    current = child;
  }
  return current.kind === "split" ? current : null;
}

function replaceAt(node: LayoutNode, path: readonly number[], replacement: LayoutNode): LayoutNode {
  if (path.length === 0) return replacement;
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  const children = node.children.map((child, index) => (index === head ? replaceAt(child, rest, replacement) : child));
  return { ...node, children };
}

/** Current sizes of the split a sash belongs to (the sash drag's starting point). */
export function splitSizes(layout: TerminalLayout, path: readonly number[]): readonly number[] | null {
  return splitAt(layout.root, path)?.sizes ?? null;
}

/**
 * Drags the sash between child `index` and `index + 1` of the split at `path`. `delta` is in
 * fractions of the split's own extent, relative to `startSizes`; both neighbours stay at least
 * `minSize` (also a fraction of the split), or half their combined size when that is smaller.
 */
export function resizeSplit(
  layout: TerminalLayout,
  path: readonly number[],
  index: number,
  startSizes: readonly number[],
  delta: number,
  minSize: number,
): TerminalLayout {
  const split = splitAt(layout.root, path);
  if (!split || index < 0 || index + 1 >= split.children.length || startSizes.length !== split.children.length) return layout;
  const a = startSizes[index]!;
  const b = startSizes[index + 1]!;
  const pair = a + b;
  const floor = Math.min(Math.max(0, minSize), pair / 2);
  const nextA = Math.min(pair - floor, Math.max(floor, a + (Number.isFinite(delta) ? delta : 0)));
  const sizes = [...startSizes];
  sizes[index] = nextA;
  sizes[index + 1] = pair - nextA;
  if (sizes.every((size, i) => Math.abs(size - (split.sizes[i] ?? 0)) < EPSILON)) return layout;
  return { ...layout, root: replaceAt(layout.root, path, { ...split, sizes }) };
}

/** Double-click on a sash: every child of that split gets the same share. */
export function equalizeSplit(layout: TerminalLayout, path: readonly number[]): TerminalLayout {
  const split = splitAt(layout.root, path);
  if (!split) return layout;
  const share = 1 / split.children.length;
  if (split.sizes.every((size) => Math.abs(size - share) < EPSILON)) return layout;
  return { ...layout, root: replaceAt(layout.root, path, { ...split, sizes: split.children.map(() => share) }) };
}

// ---------------------------------------------------------------------------------------------
// Pending tab
// ---------------------------------------------------------------------------------------------

/**
 * Starts an optimistic create: the pending tab goes into the focused group (active there), or —
 * with a side — into a new group split off the focused one. A layout that already has a pending
 * tab is returned unchanged (one create in flight per workspace).
 */
export function beginPendingTab(layout: TerminalLayout, pending: PendingTab, side: LayoutSide | null = null): TerminalLayout {
  if (layout.pending) return layout;
  const target = focusedGroup(layout);
  let next: TerminalLayout;
  if (side && target.tabs.length > 0) {
    next = splitWithNewTab(layout, target.id, side, pending.id);
  } else {
    next = updateGroup(layout, target.id, (group) => ({ ...group, tabs: [...group.tabs, pending.id], activeTabId: pending.id }));
    next = focusGroup(next, target.id);
  }
  return { ...next, pending };
}

/** Failure or timeout: the pending tab goes, its group collapses if that empties it. */
export function dropPendingTab(layout: TerminalLayout, pendingId: string): TerminalLayout {
  if (layout.pending?.id !== pendingId) return layout;
  return removeTab(layout, pendingId);
}

/** The task that answers the pending create: the first one the workspace did not know and the layout does not hold. */
export function findCreatedTask(layout: TerminalLayout, taskIds: readonly string[]): string | null {
  const pending = layout.pending;
  if (!pending) return null;
  const known = new Set(pending.knownTaskIds);
  const present = new Set(layoutTabIds(layout));
  return taskIds.find((id) => !known.has(id) && !present.has(id)) ?? null;
}

/** The created task takes the pending tab's place: same group, same position, same active state. */
export function replacePendingTab(layout: TerminalLayout, taskId: string): TerminalLayout {
  const pending = layout.pending;
  if (!pending) return layout;
  const rest = withoutPending(layout);
  const group = groupOfTab(rest, pending.id);
  if (!group) return rest;
  return updateGroup(rest, group.id, (item) => ({
    ...item,
    tabs: item.tabs.map((id) => (id === pending.id ? taskId : id)),
    activeTabId: item.activeTabId === pending.id ? taskId : item.activeTabId,
  }));
}

// ---------------------------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------------------------

export type ReconcileOptions = {
  /** A task that must end up active and its group focused — the watched tab that moved in (plan 104). */
  follow?: string | null;
};

/**
 * Brings a workspace's layout in line with its live task list (ordered by creation):
 * - the pending tab is exempt from removal; the task answering it replaces it in place;
 * - browser tabs are not tasks and are exempt from removal too (they go when the user closes them);
 * - tasks that vanished (closed, or moved to another workspace) are removed, emptied groups collapse;
 * - tasks the layout does not hold yet (created here or elsewhere, or moved in) land in the focused
 *   group, becoming its active tab only when it had none;
 * - `follow` is activated and its group focused.
 * Returns the same object when nothing changed, so callers can compare by identity.
 */
export function reconcileLayout(layout: TerminalLayout, taskIds: readonly string[], options: ReconcileOptions = {}): TerminalLayout {
  let next = layout;
  const created = findCreatedTask(next, taskIds);
  if (created) next = replacePendingTab(next, created);

  const live = new Set(taskIds);
  const pendingId = next.pending?.id ?? null;
  for (const id of layoutTabIds(next)) {
    if (id !== pendingId && !isBrowserTabId(id) && !live.has(id)) next = removeTab(next, id);
  }

  const present = new Set(layoutTabIds(next));
  const missing = taskIds.filter((id) => !present.has(id));
  if (missing.length > 0) {
    const target = focusedGroup(next);
    next = updateGroup(next, target.id, (group) => ({
      ...group,
      tabs: [...group.tabs, ...missing],
      activeTabId: group.activeTabId ?? missing[0]!,
    }));
  }

  if (!findGroup(next, next.focusedGroupId)) next = { ...next, focusedGroupId: listGroups(next.root)[0]!.id };

  const follow = options.follow;
  if (follow && live.has(follow)) next = activateTab(next, follow);
  return next;
}

/**
 * Drops every browser tab whose id `keep` rejects — on restore, a browser id in a stored layout
 * without a stored record (URL, title) is dropped; emptied groups collapse as on any close.
 * Returns the same object when nothing was dropped.
 */
export function pruneBrowserTabs(layout: TerminalLayout, keep: (tabId: string) => boolean): TerminalLayout {
  let next = layout;
  for (const id of browserTabIdsOf(layout)) {
    if (!keep(id)) next = removeTab(next, id);
  }
  return next;
}

/**
 * The layout a workspace renders. Before the first snapshot the task list is empty only because
 * nothing has arrived yet (packages/client store starts at `tasks: []`), so the stored layout is
 * used as it is — reconciling it then would drop every tab.
 */
export function effectiveLayout(
  stored: TerminalLayout | undefined,
  taskIds: readonly string[],
  context: { snapshotReady: boolean; follow?: string | null },
): TerminalLayout {
  const base = stored ?? EMPTY_LAYOUT;
  if (!context.snapshotReady) return base;
  return reconcileLayout(base, taskIds, { follow: context.follow });
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

export type TerminalLayoutStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;

type StoredNode =
  | { kind: "group"; id: string; tabs: string[]; activeTabId: string | null }
  | { kind: "split"; direction: SplitDirection; children: StoredNode[]; sizes: number[] };

function toStoredNode(node: LayoutNode): StoredNode | null {
  if (node.kind === "group") {
    const tabs = node.tabs.filter((id) => !id.startsWith(PENDING_TAB_PREFIX));
    if (tabs.length === 0) return null;
    const activeTabId = node.activeTabId && tabs.includes(node.activeTabId) ? node.activeTabId : (tabs[0] ?? null);
    return { kind: "group", id: node.id, tabs, activeTabId };
  }
  const children: StoredNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const stored = toStoredNode(child);
    if (!stored) return;
    children.push(stored);
    sizes.push(node.sizes[index] ?? 0);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: "split", direction: node.direction, children, sizes: normalizeSizes(sizes) };
}

/** Storage form of one layout: pending tabs stripped (they are fake ids), emptied groups dropped. */
export function toStoredLayout(layout: TerminalLayout): { root: StoredNode; focusedGroupId: string } | null {
  const root = toStoredNode(layout.root);
  if (!root) return null;
  return { root, focusedGroupId: layout.focusedGroupId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParseState = { seenTabs: Set<string>; idMap: Map<string, string>; counter: number };

function parseNode(value: unknown, state: ParseState, depth: number): LayoutNode | null {
  if (!isRecord(value) || depth > 32) return null;
  if (value.kind === "group") {
    const rawTabs = Array.isArray(value.tabs) ? value.tabs : [];
    const tabs: string[] = [];
    for (const tab of rawTabs) {
      if (typeof tab !== "string" || tab.length === 0 || tab.startsWith(PENDING_TAB_PREFIX) || state.seenTabs.has(tab)) continue;
      state.seenTabs.add(tab);
      tabs.push(tab);
    }
    if (tabs.length === 0) return null;
    // Ids are reissued so a hand-edited or corrupted value cannot produce two groups with one id.
    const id = `g${++state.counter}`;
    if (typeof value.id === "string" && !state.idMap.has(value.id)) state.idMap.set(value.id, id);
    const activeTabId = typeof value.activeTabId === "string" && tabs.includes(value.activeTabId) ? value.activeTabId : tabs[0]!;
    return { kind: "group", id, tabs, activeTabId };
  }
  if (value.kind === "split") {
    const direction = value.direction;
    if (direction !== "row" && direction !== "column") return null;
    const rawChildren = Array.isArray(value.children) ? value.children : [];
    const rawSizes = Array.isArray(value.sizes) ? value.sizes : [];
    const sizesUsable =
      rawSizes.length === rawChildren.length && rawSizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0);
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    rawChildren.forEach((child, index) => {
      const parsed = parseNode(child, state, depth + 1);
      if (!parsed) return;
      children.push(parsed);
      sizes.push(sizesUsable ? (rawSizes[index] as number) : 1);
    });
    if (children.length === 0) return null;
    return normalizeSplit({ kind: "split", direction, children, sizes: normalizeSizes(sizes) });
  }
  return null;
}

/**
 * One stored layout. Anything unusable collapses to a single group; unknown tab ids are left for
 * reconcile to drop. Browser tab ids are kept as they are — reconcile keeps them, and the caller
 * drops the ones without a stored record (`pruneBrowserTabs`).
 */
export function parseLayout(value: unknown): TerminalLayout {
  if (!isRecord(value)) return createLayout();
  const state: ParseState = { seenTabs: new Set(), idMap: new Map(), counter: 0 };
  const root = parseNode(value.root, state, 0);
  if (!root) return createLayout();
  const groups = listGroups(root);
  const mapped = typeof value.focusedGroupId === "string" ? state.idMap.get(value.focusedGroupId) : undefined;
  const focusedGroupId = mapped && groups.some((group) => group.id === mapped) ? mapped : groups[0]!.id;
  return { root, focusedGroupId };
}

/** Every stored layout, by workspace id. Storage that throws or holds junk reads as "nothing stored". */
export function readStoredLayouts(store: TerminalLayoutStore): Record<string, TerminalLayout> {
  let raw: string | null;
  try {
    raw = store.storage.getItem(store.key);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) return {};
  const stored = parsed.layouts;
  if (!isRecord(stored)) return {};
  const layouts: Record<string, TerminalLayout> = {};
  for (const [workspaceId, value] of Object.entries(stored)) {
    if (workspaceId) layouts[workspaceId] = parseLayout(value);
  }
  return layouts;
}

/** The serialised value for every layout; single empty groups are not worth a byte and are left out. */
export function serializeLayouts(layouts: Readonly<Record<string, TerminalLayout>>): string {
  const stored: Record<string, unknown> = {};
  for (const workspaceId of Object.keys(layouts).sort()) {
    const layout = toStoredLayout(layouts[workspaceId]!);
    if (layout) stored[workspaceId] = layout;
  }
  return JSON.stringify({ version: STORAGE_VERSION, layouts: stored });
}

/**
 * What to write, if anything: nothing before the first snapshot (the layouts may not have been
 * reconciled against real data yet and must not overwrite what is stored), nothing when the
 * serialised value equals the last one written.
 */
export function planLayoutPersist(input: {
  snapshotReady: boolean;
  layouts: Readonly<Record<string, TerminalLayout>>;
  lastWritten: string | null;
}): string | null {
  if (!input.snapshotReady) return null;
  const serialized = serializeLayouts(input.layouts);
  return serialized === input.lastWritten ? null : serialized;
}

/** Best-effort write; a layout that cannot be remembered is not worth an error. */
export function writeStoredLayouts(store: TerminalLayoutStore, serialized: string): boolean {
  try {
    store.storage.setItem(store.key, serialized);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers (still pure: strings only)
// ---------------------------------------------------------------------------------------------

/**
 * Height of a group's tab strip, in px. Coupled to the strip's Tailwind `h-9` (36px) in
 * workspace-terminal.tsx: change both together, or panes overlap or gap their strips.
 */
export const GROUP_TAB_STRIP_HEIGHT = 36;

function percent(value: number): string {
  return `${Math.round(value * 1e6) / 1e4}%`;
}

/** A group's whole rectangle, as absolute-position CSS values in percentages of the main area. */
export function groupFrameStyle(rect: LayoutRect): { left: string; top: string; width: string; height: string } {
  return { left: percent(rect.x), top: percent(rect.y), width: percent(rect.w), height: percent(rect.h) };
}

/** A group's body (below its strip) — where its active pane sits. Laid out by the browser in the same frame. */
export function groupBodyStyle(rect: LayoutRect): { left: string; top: string; width: string; height: string } {
  return {
    left: percent(rect.x),
    top: `calc(${percent(rect.y)} + ${GROUP_TAB_STRIP_HEIGHT}px)`,
    width: percent(rect.w),
    height: `calc(${percent(rect.h)} - ${GROUP_TAB_STRIP_HEIGHT}px)`,
  };
}
