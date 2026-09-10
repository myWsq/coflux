import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStatus } from "@coflux/protocol";

import {
  parseStoredSelection,
  requestWorkbenchExitConfirmation,
  resolveActiveTaskId,
  resolveActiveTaskIdAfterPendingDrop,
  resolveSelectionAfterTaskMove,
  resolveWorkbenchSelection,
  resolveWorkbenchSurface,
  serializeSelection,
  shouldActivateChangesView,
  shouldShowReconnectBanner,
  taskCloseNeedsConfirmation,
} from "./workbench-state";

test("认证状态映射到独立页面，版本失配不会冒充登录失败", () => {
  assert.equal(resolveWorkbenchSurface("authenticating"), "authenticating");
  assert.equal(resolveWorkbenchSurface("outdated"), "outdated");
  assert.equal(resolveWorkbenchSurface("need-login"), "login");
  assert.equal(resolveWorkbenchSurface("auth-failed"), "login");
  assert.equal(resolveWorkbenchSurface("authed"), "workspace");
});

test("连接中和已断开都展示重连横幅，connected 才撤除", () => {
  assert.equal(shouldShowReconnectBanner("connecting"), true);
  assert.equal(shouldShowReconnectBanner("disconnected"), true);
  assert.equal(shouldShowReconnectBanner("connected"), false);
});

test("变更视图只在当前工作区且选中 changes tab 时激活", () => {
  assert.equal(shouldActivateChangesView(true, "changes"), true);
  assert.equal(shouldActivateChangesView(true, "terminal"), false);
  assert.equal(shouldActivateChangesView(false, "changes"), false);
  assert.equal(shouldActivateChangesView(false, "terminal"), false);
});

test("离开工作台会阻止默认卸载并设置浏览器兼容字段", () => {
  let prevented = false;
  const event = {
    returnValue: "unchanged",
    preventDefault() {
      prevented = true;
    },
  };

  requestWorkbenchExitConfirmation(event);

  assert.equal(prevented, true);
  assert.equal(event.returnValue, "");
});

test("只有仍在运行的终端关闭前需要确认", () => {
  assert.equal(taskCloseNeedsConfirmation(TaskStatus.RUNNING), true);
  assert.equal(taskCloseNeedsConfirmation(TaskStatus.EXITED), false);
});

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

test("关闭 active Tab 回退第一项，关闭后台 Tab 保留当前选择", () => {
  assert.equal(resolveActiveTaskId("task-2", ["task-1", "task-3"], null), "task-1");
  assert.equal(resolveActiveTaskId("task-2", ["task-1", "task-2"], null), "task-2");
  assert.equal(resolveActiveTaskId("pending-1", ["task-1"], "pending-1"), "pending-1");
  assert.equal(resolveActiveTaskId("removed", [], null), null);
});

test("pending Tab 失败只在仍 active 时回退，不抢用户后来选择的 Tab", () => {
  assert.equal(resolveActiveTaskIdAfterPendingDrop("pending-1", "pending-1", ["task-1", "task-2"]), "task-1");
  assert.equal(resolveActiveTaskIdAfterPendingDrop("task-2", "pending-1", ["task-1", "task-2"]), "task-2");
  assert.equal(resolveActiveTaskIdAfterPendingDrop("pending-1", "pending-1", []), null);
});

test("被搬进来的终端继续当活动 Tab，还没进快照时不影响原有回退", () => {
  // 搬进来的 task 优先于当前选择，也优先于首项回退
  assert.equal(resolveActiveTaskId("task-1", ["task-1", "moved"], null, "moved"), "moved");
  assert.equal(resolveActiveTaskId(null, ["task-1", "moved"], null, "moved"), "moved");
  // 跟随目标还没出现在本工作区的快照里：按原规则走
  assert.equal(resolveActiveTaskId("task-1", ["task-1"], null, "moved"), "task-1");
  assert.equal(resolveActiveTaskId(null, ["task-1"], null, "moved"), "task-1");
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
  assert.equal(resolveActiveTaskId("task-1", ["task-2"], null, null), "task-2");
});
