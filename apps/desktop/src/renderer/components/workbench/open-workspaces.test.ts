import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeWorkspaces, emptyOpenWorkspaces, migrateOpenWorkspaces, navigationAccountId,
  navigationStorageKey, openWorkspace, parseOpenWorkspaces, reconcileOpenWorkspaces,
  serializeOpenWorkspaces,
} from "./open-workspaces";

const opened = () => ["a", "b", "c"].reduce(openWorkspace, emptyOpenWorkspaces());

test("opening and switching preserve insertion order; reopening appends once", () => {
  const state = openWorkspace(opened(), "a");
  assert.deepEqual(state.workspaceIds, ["a", "b", "c"]);
  const closed = closeWorkspaces(state, new Set(["b"]));
  assert.deepEqual(openWorkspace(closed, "b").workspaceIds, ["a", "c", "b"]);
  assert.deepEqual(openWorkspace(openWorkspace(closed, "b"), "b").workspaceIds, ["a", "c", "b"]);
});

test("closing the selected item selects a surviving neighbor; last close stays empty after reload", () => {
  const state = openWorkspace(opened(), "b");
  assert.deepEqual(closeWorkspaces(state, new Set(["b"])).selection, { kind: "workspace", id: "c" });
  assert.deepEqual(closeWorkspaces(state, new Set(["b", "c"])).selection, { kind: "workspace", id: "a" });
  const empty = closeWorkspaces(state, new Set(["a", "b", "c"]));
  assert.deepEqual(empty, emptyOpenWorkspaces());
  assert.deepEqual(parseOpenWorkspaces(serializeOpenWorkspaces(empty)), empty);
  assert.deepEqual(reconcileOpenWorkspaces(empty, new Set(["a", "b"]), new Set(), true), empty);
});

test("closing other or background workspaces preserves workspace and device selection", () => {
  const state = openWorkspace(opened(), "b");
  assert.deepEqual(closeWorkspaces(state, new Set(["a", "c"])), { workspaceIds: ["b"], selection: state.selection });
  const device = { ...state, selection: { kind: "device", id: "daemon" } as const };
  assert.deepEqual(closeWorkspaces(device, new Set(["a", "b", "c"])), { workspaceIds: [], selection: device.selection });
});

test("offline or pre-snapshot catalogs cannot erase opened items; confirmed deletion can", () => {
  const state = opened();
  assert.equal(reconcileOpenWorkspaces(state, new Set(), new Set(), false), state);
  assert.deepEqual(reconcileOpenWorkspaces(state, new Set(["a", "b"]), new Set(), true), {
    workspaceIds: ["a", "b"], selection: { kind: "workspace", id: "b" },
  });
  const device = { ...state, selection: { kind: "device", id: "offline-daemon" } as const };
  assert.equal(reconcileOpenWorkspaces(device, new Set(state.workspaceIds), new Set(["offline-daemon"]), true), device);
});

test("stored navigation survives round trips and ignores corrupt data and optimistic IDs", () => {
  assert.deepEqual(parseOpenWorkspaces(serializeOpenWorkspaces(opened())), opened());
  for (const raw of [null, "{", "null", "{}", '{"version":2}', '{"version":1,"workspaceIds":[]}']) {
    assert.equal(parseOpenWorkspaces(raw), null);
  }
  assert.deepEqual(parseOpenWorkspaces('{"version":1,"workspaceIds":["a","a",null,"pending-ws-1"],"selection":{"kind":"workspace","id":"pending-ws-1"}}'), {
    workspaceIds: ["a"], selection: null,
  });
  const pending = { ...opened(), selection: { kind: "workspace", id: "pending-ws-1" } as const };
  assert.equal(serializeOpenWorkspaces(pending).includes("pending-ws-1"), false);
});

test("legacy migration enrolls only a valid selection, never the whole catalog", () => {
  assert.deepEqual(migrateOpenWorkspaces("b", new Set(["a", "b"]), new Set()), {
    workspaceIds: ["b"], selection: { kind: "workspace", id: "b" },
  });
  assert.deepEqual(migrateOpenWorkspaces("pending-ws-1", new Set(["a"]), new Set()), emptyOpenWorkspaces());
  assert.deepEqual(migrateOpenWorkspaces("device:d", new Set(), new Set(["d"])), {
    workspaceIds: [], selection: { kind: "device", id: "d" },
  });
});

test("storage uses real account IDs with distinct server and account boundaries", () => {
  assert.equal(navigationAccountId([{ accountId: "one" }, { accountId: "one" }]), "one");
  assert.equal(navigationAccountId([{ accountId: "one" }, { accountId: "two" }]), null);
  assert.equal(navigationAccountId([]), null);
  const key = navigationStorageKey("nav", "ws://server/client", "one");
  assert.notEqual(key, navigationStorageKey("nav", "ws://other/client", "one"));
  assert.notEqual(key, navigationStorageKey("nav", "ws://server/client", "two"));
});


test("closing a device's visible directory workspace navigates away, while background close preserves device details", () => {
  const state = { ...opened(), selection: { kind: "device", id: "daemon" } as const };
  assert.deepEqual(closeWorkspaces(state, new Set(["a"]), "b"), {
    workspaceIds: ["b", "c"], selection: state.selection,
  });
  assert.deepEqual(closeWorkspaces(state, new Set(["b"]), "b"), {
    workspaceIds: ["a", "c"], selection: { kind: "workspace", id: "c" },
  });
  assert.deepEqual(closeWorkspaces(state, new Set(["a", "b", "c"]), "b"), emptyOpenWorkspaces());
});
