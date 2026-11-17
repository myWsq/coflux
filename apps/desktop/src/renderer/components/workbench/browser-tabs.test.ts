import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBrowserTabId,
  parseBrowserTabRecords,
  readBrowserTabRecords,
  restoreBrowserTabs,
  serializeBrowserTabRecords,
  writeBrowserTabRecords,
} from "./browser-tabs";
import { BROWSER_TAB_PREFIX, createLayout, layoutTabIds, revealTab } from "./terminal-layout";

const A = `${BROWSER_TAB_PREFIX}a`;
const B = `${BROWSER_TAB_PREFIX}b`;
const C = `${BROWSER_TAB_PREFIX}c`;

test("tab ids carry the browser prefix and nothing unsafe", () => {
  assert.equal(createBrowserTabId("123e4567-e89b-12d3-a456-426614174000"), `${BROWSER_TAB_PREFIX}123e4567-e89b-12d3-a456-426614174000`);
  assert.equal(createBrowserTabId("a b/c"), `${BROWSER_TAB_PREFIX}abc`);
});

test("records round-trip; only http(s) and about:blank URLs survive, bad entries are skipped", () => {
  const records = {
    [A]: { workspaceId: "w1", url: "http://localhost:5173/", title: "Vite" },
    [B]: { workspaceId: "w2", url: "", title: "" },
  };
  assert.deepEqual(parseBrowserTabRecords(serializeBrowserTabRecords(records)), records);

  const parsed = parseBrowserTabRecords(
    JSON.stringify({
      version: 1,
      tabs: {
        [A]: { workspaceId: "w1", url: "file:///etc/passwd", title: 12 },
        [B]: { url: "https://example.com/" },
        "not-a-browser-tab": { workspaceId: "w1", url: "https://example.com/", title: "" },
        [C]: "junk",
      },
    }),
  );
  assert.deepEqual(parsed, { [A]: { workspaceId: "w1", url: "", title: "" } });
  assert.deepEqual(parseBrowserTabRecords(null), {});
  assert.deepEqual(parseBrowserTabRecords("{"), {});
  assert.deepEqual(parseBrowserTabRecords(JSON.stringify({ version: 2, tabs: {} })), {});

  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  assert.ok(writeBrowserTabRecords({ storage, key: "k" }, serializeBrowserTabRecords(records)));
  assert.deepEqual(readBrowserTabRecords({ storage, key: "k" }), records);
  const throwing = {
    getItem: (): string | null => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(readBrowserTabRecords({ storage: throwing, key: "k" }), {});
  assert.equal(writeBrowserTabRecords({ storage: throwing, key: "k" }, "{}"), false);
});

test("restore keeps tabs with a record for the same workspace and drops the rest on both sides", () => {
  const w1 = revealTab(revealTab(createLayout(["t1"]), A), B);
  const w2 = revealTab(createLayout(["t2"]), C);
  const records = {
    [A]: { workspaceId: "w1", url: "http://localhost:3000/", title: "" },
    // B has no record: dropped from the layout.
    // C's record names another workspace: dropped too.
    [C]: { workspaceId: "w1", url: "https://example.com/", title: "" },
    // A record no layout references: dropped.
    [`${BROWSER_TAB_PREFIX}orphan`]: { workspaceId: "w2", url: "", title: "" },
  };
  const restored = restoreBrowserTabs({ w1, w2 }, records);
  assert.deepEqual(layoutTabIds(restored.layouts.w1!), ["t1", A]);
  assert.deepEqual(layoutTabIds(restored.layouts.w2!), ["t2"]);
  assert.deepEqual(Object.keys(restored.records), [A]);
  // Untouched layouts come back as the same objects.
  const clean = restoreBrowserTabs({ w2: createLayout(["t2"]) }, {});
  assert.deepEqual(layoutTabIds(clean.layouts.w2!), ["t2"]);
});

test("a canvas tab's record keeps its canvas; a malformed one reads as an ordinary tab", () => {
  const records = {
    [A]: { workspaceId: "w1", url: "http://localhost:8795/abc123/home.html", title: "Home", canvas: { id: "abc123", title: "Home redesign" } },
    [B]: { workspaceId: "w1", url: "http://localhost:5173/", title: "Vite" },
  };
  const parsed = parseBrowserTabRecords(serializeBrowserTabRecords(records));
  assert.deepEqual(parsed, records);
  assert.equal("canvas" in parsed[B]!, false);

  const raw = JSON.stringify({
    version: 1,
    tabs: {
      [A]: { workspaceId: "w1", url: "http://localhost:8795/x/a.html", title: "", canvas: { id: "../x", title: "t" } },
      [B]: { workspaceId: "w1", url: "http://localhost:8795/x/b.html", title: "", canvas: "nope" },
    },
  });
  assert.deepEqual(parseBrowserTabRecords(raw), {
    [A]: { workspaceId: "w1", url: "http://localhost:8795/x/a.html", title: "" },
    [B]: { workspaceId: "w1", url: "http://localhost:8795/x/b.html", title: "" },
  });
});
