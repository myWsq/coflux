import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseStoredSelection,
  resolveSelectionAfterTaskMove,
  resolveWorkbenchSelection,
  serializeSelection,
} from "./workbench-state";

test("工作区与设备选择的持久化格式保持向后兼容", () => {
  assert.deepEqual(parseStoredSelection(null), null);
  assert.deepEqual(parseStoredSelection("workspace-1"), { kind: "workspace", id: "workspace-1" });
  assert.deepEqual(parseStoredSelection("device:daemon-1"), { kind: "device", id: "daemon-1" });
  assert.equal(serializeSelection({ kind: "workspace", id: "workspace-1" }), "workspace-1");
  assert.equal(serializeSelection({ kind: "device", id: "daemon-1" }), "device:daemon-1");
  assert.equal(serializeSelection(null), null);
});

test("有效设备选择即使离线也保留，乐观工作区暂不持久化", () => {
  const device = { kind: "device", id: "daemon-1" } as const;
  assert.deepEqual(
    resolveWorkbenchSelection({
      selection: device,
      pendingWorkspaceIds: new Set(),
      projects: [],
      workspaces: [],
      daemons: [{ daemonId: "daemon-1" }],
    }),
    { selection: device, changed: false, shouldPersist: true },
  );

  const pending = { kind: "workspace", id: "pending-ws-1" } as const;
  assert.deepEqual(
    resolveWorkbenchSelection({
      selection: pending,
      pendingWorkspaceIds: new Set([pending.id]),
      projects: [],
      workspaces: [],
      daemons: [],
    }),
    { selection: pending, changed: false, shouldPersist: false },
  );
});

test("失效选择优先回退到最早项目的 main workspace，再回退任一工作区", () => {
  const projects = [
    { id: "newer", createdAt: 20 },
    { id: "older", createdAt: 10 },
  ];
  const workspaces = [
    { id: "newer-main", projectId: "newer", isMain: true },
    { id: "older-child", projectId: "older", isMain: false },
    { id: "older-main", projectId: "older", isMain: true },
  ];
  assert.deepEqual(
    resolveWorkbenchSelection({
      selection: { kind: "workspace", id: "removed" },
      pendingWorkspaceIds: new Set(),
      projects,
      workspaces,
      daemons: [],
    }),
    { selection: { kind: "workspace", id: "older-main" }, changed: true, shouldPersist: true },
  );
  assert.deepEqual(
    resolveWorkbenchSelection({
      selection: { kind: "device", id: "removed" },
      pendingWorkspaceIds: new Set(),
      projects: [],
      workspaces,
      daemons: [],
    }).selection,
    { kind: "workspace", id: "newer-main" },
  );
});

test("活动 Tab 被搬去别的工作区时选中态跟过去", () => {
  assert.deepEqual(
    resolveSelectionAfterTaskMove({
      activeWorkspaceId: "ws-main",
      activeTaskId: "task-1",
      tasks: [
        { id: "task-1", workspaceId: "ws-worktree" },
        { id: "task-2", workspaceId: "ws-main" },
      ],
    }),
    { kind: "workspace", id: "ws-worktree" },
  );
});

test("非活动 Tab 被搬走、或活动 Tab 原地不动时选中态不变", () => {
  // 搬走的是后台 Tab：当前工作区仍在看，选中不动
  assert.equal(
    resolveSelectionAfterTaskMove({
      activeWorkspaceId: "ws-main",
      activeTaskId: "task-1",
      tasks: [
        { id: "task-1", workspaceId: "ws-main" },
        { id: "task-2", workspaceId: "ws-worktree" },
      ],
    }),
    null,
  );
  // 没有活动 Tab / 没有展示中的工作区：无从跟随
  assert.equal(
    resolveSelectionAfterTaskMove({ activeWorkspaceId: "ws-main", activeTaskId: null, tasks: [{ id: "task-1", workspaceId: "ws-worktree" }] }),
    null,
  );
  assert.equal(
    resolveSelectionAfterTaskMove({ activeWorkspaceId: null, activeTaskId: "task-1", tasks: [{ id: "task-1", workspaceId: "ws-worktree" }] }),
    null,
  );
});

test("活动 Tab 是被删而非被搬时不跟随，仍走原来的活动 Tab 回退", () => {
  assert.equal(
    resolveSelectionAfterTaskMove({
      activeWorkspaceId: "ws-main",
      activeTaskId: "task-1",
      tasks: [{ id: "task-2", workspaceId: "ws-main" }],
    }),
    null,
  );
});
