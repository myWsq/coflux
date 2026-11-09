import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStatus, type Project, type Task, type Workspace } from "@coflux/protocol";
import type { SessionAgentState } from "@coflux/client";

import { currentWorkspaces, nextAttentionRow, type CurrentWorkspacesInput } from "./current-workspaces";
import { RECENT_VISIT_WINDOW_MS } from "./workspace-visits";
import { sidebarTree } from "./workspace-order";

const NOW = 100 * RECENT_VISIT_WINDOW_MS;
const MINUTE = 60_000;

function project(id: string, daemonId = "d1", archivedAt?: number): Project {
  return { id, name: id, daemonId, repoPath: `/repo/${id}`, defaultBranch: "main", archivedAt } as unknown as Project;
}
function workspace(id: string, projectId: string, createdAt: number, isMain = false): Workspace {
  return { id, projectId, daemonId: "d1", branch: id, name: "", isMain, createdAt, additions: 0, deletions: 0, path: `/w/${id}` } as unknown as Workspace;
}
function task(id: string, workspaceId: string): Task {
  return { id, workspaceId, sessionId: `s-${id}`, status: TaskStatus.RUNNING, title: "终端" } as unknown as Task;
}
function agent(taskId: string, state: string): SessionAgentState {
  return { daemonId: "d1", taskId, agent: "claude", state, message: "", progress: "", agentSessionId: "" };
}

/** Two projects; p1 holds main + three worktrees created out of order, p2 holds main + one. */
function input(overrides: Partial<CurrentWorkspacesInput> = {}): CurrentWorkspacesInput {
  return {
    projects: [project("p1"), project("p2")],
    workspaces: [
      workspace("p1-c", "p1", 30),
      workspace("p1-main", "p1", 50, true),
      workspace("p1-a", "p1", 10),
      workspace("p1-b", "p1", 20),
      workspace("p2-x", "p2", 5),
      workspace("p2-main", "p2", 1, true),
    ],
    daemons: [{ daemonId: "d1", online: true }],
    tasks: [],
    sessionAgents: {},
    visits: {},
    selectedWorkspaceId: null,
    now: NOW,
    ...overrides,
  };
}

/** Puts one running agent terminal in each given workspace, reporting the given state. */
function withAgents(states: Record<string, string>): Pick<CurrentWorkspacesInput, "tasks" | "sessionAgents"> {
  const tasks: Task[] = [];
  const sessionAgents: Record<string, SessionAgentState> = {};
  for (const [workspaceId, state] of Object.entries(states)) {
    const item = task(`t-${workspaceId}`, workspaceId);
    tasks.push(item);
    sessionAgents[`s-${item.id}`] = agent(item.id, state);
  }
  return { tasks, sessionAgents };
}

const ids = (value: CurrentWorkspacesInput) => currentWorkspaces(value).map((row) => row.workspace.id);

test("树序：可见项目按 store 顺序，项目内主工作区在前、其余按 createdAt 升序", () => {
  const tree = sidebarTree(input().projects, input().workspaces);
  assert.deepEqual(
    tree.map((entry) => [entry.project.id, entry.workspaces.map((item) => item.id)]),
    [
      ["p1", ["p1-main", "p1-a", "p1-b", "p1-c"]],
      ["p2", ["p2-main", "p2-x"]],
    ],
  );
  const archived = sidebarTree([project("p1"), project("p2", "d1", 7)], input().workspaces);
  assert.deepEqual(archived.map((entry) => entry.project.id), ["p1"]);
});

test("非 idle 的五种活动都入选，idle 本身不算", () => {
  for (const state of ["active", "approval", "question", "error", "done"]) {
    assert.deepEqual(ids(input(withAgents({ "p1-b": state }))), ["p1-b"], state);
  }
  assert.deepEqual(ids(input(withAgents({ "p1-b": "idle" }))), []);
});

test("行上带着该工作区的 workspaceActivity 结果与所属项目", () => {
  const [row] = currentWorkspaces(input(withAgents({ "p2-x": "approval" })));
  assert.equal(row.project.id, "p2");
  assert.equal(row.activity.status, "approval");
  assert.equal(row.activity.status === "approval" ? row.activity.taskId : undefined, "t-p2-x");
});

test("离线设备上的工作区活动是 idle，只能凭最近访问入选", () => {
  const offline = { daemons: [{ daemonId: "d1", online: false }], ...withAgents({ "p1-a": "approval" }) };
  assert.deepEqual(ids(input(offline)), []);
  assert.deepEqual(ids(input({ ...offline, visits: { "p1-a": NOW - MINUTE } })), ["p1-a"]);
  const [row] = currentWorkspaces(input({ ...offline, visits: { "p1-a": NOW - MINUTE } }));
  assert.equal(row.activity.status, "idle");
});

test("最近访问：24 小时内最近的 5 个入选，第 6 个与超出 24h 1ms 的落选", () => {
  const visits = {
    "p1-main": NOW - 6 * MINUTE,
    "p1-a": NOW - 1 * MINUTE,
    "p1-b": NOW - 2 * MINUTE,
    "p1-c": NOW - 3 * MINUTE,
    "p2-main": NOW - 4 * MINUTE,
    "p2-x": NOW - 5 * MINUTE,
  };
  // p1-main is the 6th most recent and drops out; the rest are listed in tree order.
  assert.deepEqual(ids(input({ visits })), ["p1-a", "p1-b", "p1-c", "p2-main", "p2-x"]);

  assert.deepEqual(ids(input({ visits: { "p1-a": NOW - RECENT_VISIT_WINDOW_MS } })), ["p1-a"]);
  assert.deepEqual(ids(input({ visits: { "p1-a": NOW - RECENT_VISIT_WINDOW_MS - 1 } })), []);
});

test("按活动入选的不占最近访问的名额", () => {
  const visits = {
    "p1-main": NOW - 6 * MINUTE,
    "p1-a": NOW - 1 * MINUTE,
    "p1-b": NOW - 2 * MINUTE,
    "p1-c": NOW - 3 * MINUTE,
    "p2-main": NOW - 4 * MINUTE,
    "p2-x": NOW - 5 * MINUTE,
  };
  // p1-a is a member by activity, so the five recency slots reach down to p1-main.
  assert.deepEqual(ids(input({ visits, ...withAgents({ "p1-a": "active" }) })), ["p1-main", "p1-a", "p1-b", "p1-c", "p2-main", "p2-x"]);
});

test("选中的工作区算作此刻在屏幕上：总是入选，即使存的时间早已过期", () => {
  assert.deepEqual(ids(input({ selectedWorkspaceId: "p2-x" })), ["p2-x"]);
  assert.deepEqual(ids(input({ selectedWorkspaceId: "p2-x", visits: { "p2-x": NOW - 3 * RECENT_VISIT_WINDOW_MS } })), ["p2-x"]);
  // Five visits stamped after `now` (a lagging clock) still leave room for the selected one.
  const later = { "p1-main": NOW + 1, "p1-a": NOW + 2, "p1-b": NOW + 3, "p1-c": NOW + 4, "p2-main": NOW + 5 };
  const listed = ids(input({ selectedWorkspaceId: "p2-x", visits: later }));
  assert.equal(listed.length, 5);
  assert.ok(listed.includes("p2-x"));
});

test("目录工作区与已归档项目的工作区永不入选，即使有活动或被选中", () => {
  const dir = { ...workspace("dir", "", 1), projectId: undefined } as unknown as Workspace;
  const base = input();
  const value = input({
    projects: [project("p1"), project("p2", "d1", 7)],
    workspaces: [...base.workspaces, dir],
    ...withAgents({ dir: "approval", "p2-x": "approval" }),
    selectedWorkspaceId: "p2-main",
    visits: { dir: NOW, "p2-main": NOW },
  });
  assert.deepEqual(ids(value), []);
  assert.deepEqual(ids({ ...value, selectedWorkspaceId: "dir" }), []);
});

test("输出顺序始终是树序，与活动和访问时间无关；状态变化不换位", () => {
  const visits = { "p2-x": NOW - 1 * MINUTE, "p1-a": NOW - 9 * MINUTE };
  const before = ids(input({ visits, ...withAgents({ "p1-c": "active", "p2-main": "approval" }) }));
  assert.deepEqual(before, ["p1-a", "p1-c", "p2-main", "p2-x"]);
  const after = ids(input({ visits, ...withAgents({ "p1-c": "approval", "p2-main": "active" }) }));
  assert.deepEqual(after, before);
});

test("没有工作区就是空列表", () => {
  assert.deepEqual(ids(input({ workspaces: [] })), []);
  assert.deepEqual(ids(input({ projects: [], workspaces: [] })), []);
});

test("下一个待处理：选中项之后的第一个，到末尾绕回开头", () => {
  const rows = currentWorkspaces(input(withAgents({ "p1-a": "approval", "p1-b": "active", "p1-c": "question", "p2-x": "error", "p2-main": "done" })));
  assert.deepEqual(rows.map((row) => row.workspace.id), ["p1-a", "p1-b", "p1-c", "p2-main", "p2-x"]);
  assert.equal(nextAttentionRow(rows, "p1-a")?.workspace.id, "p1-c");
  assert.equal(nextAttentionRow(rows, "p1-b")?.workspace.id, "p1-c");
  assert.equal(nextAttentionRow(rows, "p1-c")?.workspace.id, "p2-x");
  assert.equal(nextAttentionRow(rows, "p2-x")?.workspace.id, "p1-a");
  // Nothing selected, or a selection outside the list: the first one.
  assert.equal(nextAttentionRow(rows, null)?.workspace.id, "p1-a");
  assert.equal(nextAttentionRow(rows, "elsewhere")?.workspace.id, "p1-a");
});

test("下一个待处理：只有选中项待处理时落回它自己；没有待处理就没有目标", () => {
  const only = currentWorkspaces(input({ ...withAgents({ "p1-b": "question", "p2-x": "active" }), selectedWorkspaceId: "p1-b" }));
  assert.equal(nextAttentionRow(only, "p1-b")?.workspace.id, "p1-b");

  const none = currentWorkspaces(input({ ...withAgents({ "p1-b": "active", "p2-x": "done" }), selectedWorkspaceId: "p1-b" }));
  assert.equal(nextAttentionRow(none, "p1-b"), null);
  assert.equal(nextAttentionRow([], null), null);
});
