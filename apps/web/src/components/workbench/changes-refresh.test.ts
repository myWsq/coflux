import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldRefreshChanges, type ChangesRefreshObservation } from "./changes-refresh";

function observation(overrides: Partial<ChangesRefreshObservation> = {}): ChangesRefreshObservation {
  return {
    active: true,
    workspaceId: "workspace-1",
    defaultBranch: "main",
    additions: 3,
    deletions: 2,
    manualRevision: 0,
    ...overrides,
  };
}

test("首次激活与重新进入 tab 都刷新，即使 additions/deletions 没变", () => {
  const active = observation();
  assert.equal(shouldRefreshChanges(null, active), true);
  assert.equal(shouldRefreshChanges(active, active), false);
  assert.equal(shouldRefreshChanges(observation({ active: false }), active), true);
});

test("活跃期间统计、基准分支或工作区变化会刷新", () => {
  const current = observation();
  assert.equal(shouldRefreshChanges(observation({ additions: 2 }), current), true);
  assert.equal(shouldRefreshChanges(observation({ deletions: 1 }), current), true);
  assert.equal(shouldRefreshChanges(observation({ defaultBranch: "trunk" }), current), true);
  assert.equal(shouldRefreshChanges(observation({ workspaceId: "workspace-2" }), current), true);
});

test("手动 revision 能让相同行数的正文变化失效，非激活态不拉取", () => {
  assert.equal(shouldRefreshChanges(observation(), observation({ manualRevision: 1 })), true);
  assert.equal(shouldRefreshChanges(observation(), observation({ active: false, manualRevision: 1 })), false);
});
