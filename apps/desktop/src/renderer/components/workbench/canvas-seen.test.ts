import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCanvasList, parseCanvasSeen, processedRevision, serializeCanvasSeen, type CanvasSeen } from "./canvas-seen";

const canvas = (id: string, updatedAt: number) => ({ id, updatedAt });

test("a canvas this desktop never acted on is new only if it was shown after the record was created", () => {
  const seen: CanvasSeen = { since: 1000, workspaces: {} };
  const result = applyCanvasList(seen, "ws", 3, [canvas("old", 900), canvas("at", 1000), canvas("new", 1001)]);
  assert.deepEqual(result.fresh.map((entry) => entry.id), ["new"]);
  // Everything listed is recorded, so the old ones stay quiet and the workspace's revision is processed.
  assert.deepEqual(result.seen.workspaces.ws, { revision: 3, canvases: { old: 900, at: 1000, new: 1001 } });
  assert.equal(processedRevision(result.seen, "ws"), 3);
  assert.equal(processedRevision(result.seen, "other"), null);
});

test("the first canvas of a workspace this desktop has no record for still opens", () => {
  const seen: CanvasSeen = { since: 1000, workspaces: { elsewhere: { revision: 1, canvases: { x: 1500 } } } };
  const result = applyCanvasList(seen, "ws", 1, [canvas("first", 2000)]);
  assert.deepEqual(result.fresh.map((entry) => entry.id), ["first"]);
  assert.deepEqual(result.seen.workspaces.elsewhere, { revision: 1, canvases: { x: 1500 } });
});

test("a canvas shown again is new again, and an unchanged one is not", () => {
  let seen: CanvasSeen = { since: 0, workspaces: {} };
  seen = applyCanvasList(seen, "ws", 1, [canvas("a", 10), canvas("b", 20)]).seen;
  const same = applyCanvasList(seen, "ws", 1, [canvas("a", 10), canvas("b", 20)]);
  assert.deepEqual(same.fresh, []);
  const again = applyCanvasList(seen, "ws", 2, [canvas("a", 30), canvas("b", 20)]);
  assert.deepEqual(again.fresh.map((entry) => entry.id), ["a"]);
  assert.deepEqual(again.seen.workspaces.ws, { revision: 2, canvases: { a: 30, b: 20 } });
});

test("a canvas that leaves the list and comes back unchanged is not reopened", () => {
  let seen: CanvasSeen = { since: 0, workspaces: {} };
  seen = applyCanvasList(seen, "ws", 1, [canvas("a", 10)]).seen;
  seen = applyCanvasList(seen, "ws", 1, []).seen;
  assert.deepEqual(applyCanvasList(seen, "ws", 1, [canvas("a", 10)]).fresh, []);
});

test("the record round-trips and junk reads as a record created now", () => {
  const seen: CanvasSeen = { since: 5, workspaces: { ws: { revision: 2, canvases: { a: 30 } } } };
  assert.deepEqual(parseCanvasSeen(serializeCanvasSeen(seen), 99), seen);
  for (const raw of [null, "", "{", "[]", JSON.stringify({ version: 2, since: 5, workspaces: {} }), JSON.stringify({ version: 1, since: -1, workspaces: {} })]) {
    assert.deepEqual(parseCanvasSeen(raw, 99), { since: 99, workspaces: {} });
  }
  // A bad entry is skipped, the rest is kept.
  const mixed = JSON.stringify({ version: 1, since: 5, workspaces: { ok: { revision: 1, canvases: { a: 1, b: "x" } }, bad: { revision: "1", canvases: {} } } });
  assert.deepEqual(parseCanvasSeen(mixed, 99), { since: 5, workspaces: { ok: { revision: 1, canvases: { a: 1 } } } });
});
