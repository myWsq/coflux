import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStatus, type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";
import type { SessionAgentState, SessionMetadataState } from "@coflux/client";

import { candidateSessionTitles, currentTerminals, nextAttentionRow, type CurrentTerminalsInput } from "./current-terminals";

function project(id: string, daemonId = "d1", archivedAt?: number): Project {
  return { id, name: id, daemonId, repoPath: `/repo/${id}`, defaultBranch: "main", archivedAt } as unknown as Project;
}
function workspace(id: string, projectId: string, createdAt: number, isMain = false, daemonId = "d1"): Workspace {
  return { id, projectId, daemonId, branch: id, name: "", isMain, createdAt, additions: 0, deletions: 0, path: `/w/${id}` } as unknown as Workspace;
}
function dirWorkspace(id: string, daemonId: string, createdAt: number): Workspace {
  return { ...workspace(id, "", createdAt, false, daemonId), projectId: "" } as unknown as Workspace;
}
function daemon(daemonId: string, online = true): DaemonInfo {
  return { daemonId, name: `设备-${daemonId}`, online } as unknown as DaemonInfo;
}
function task(id: string, workspaceId: string, createdAt: number, overrides: Partial<Task> = {}): Task {
  return { id, workspaceId, sessionId: `s-${id}`, status: TaskStatus.RUNNING, title: "", createdAt, ...overrides } as unknown as Task;
}
function agent(taskId: string, state: string, message = ""): SessionAgentState {
  return { daemonId: "d1", taskId, agent: "claude", state, message, progress: "", agentSessionId: "" };
}

/** Two projects; p1 holds main + three worktrees created out of order, p2 holds main + one. */
function input(overrides: Partial<CurrentTerminalsInput> = {}): CurrentTerminalsInput {
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
    daemons: [daemon("d1")],
    tasks: [],
    sessionAgents: {},
    titles: {},
    ...overrides,
  };
}

/** One running agent terminal per entry: [task id, workspace id, createdAt, state]. */
function withAgents(entries: [string, string, number, string][]): Pick<CurrentTerminalsInput, "tasks" | "sessionAgents"> {
  const tasks: Task[] = [];
  const sessionAgents: Record<string, SessionAgentState> = {};
  for (const [taskId, workspaceId, createdAt, state] of entries) {
    tasks.push(task(taskId, workspaceId, createdAt));
    sessionAgents[`s-${taskId}`] = agent(taskId, state);
  }
  return { tasks, sessionAgents };
}

const ids = (value: CurrentTerminalsInput) => currentTerminals(value).map((row) => row.task.id);

test("active / approval / question / error / done 都入选，状态原样带在行上", () => {
  for (const state of ["active", "approval", "question", "error", "done"]) {
    const rows = currentTerminals(input(withAgents([["t1", "p1-b", 1, state]])));
    assert.deepEqual(rows.map((row) => row.task.id), ["t1"], state);
    assert.equal(rows[0]?.activity.status, state);
  }
});

test("旧 worker 的 waiting 入选并显示为 done；未知状态与缺失的 presence 不入选", () => {
  const [row] = currentTerminals(input(withAgents([["t1", "p1-b", 1, "waiting"]])));
  assert.equal(row?.activity.status, "done");
  assert.deepEqual(ids(input(withAgents([["t1", "p1-b", 1, "idle"]]))), []);
  assert.deepEqual(ids(input(withAgents([["t1", "p1-b", 1, "something-new"]]))), []);
  assert.deepEqual(ids(input({ tasks: [task("t1", "p1-b", 1)] })), []);
});

test("行上带着任务、工作区、项目、设备、agent 与活动；待处理状态带 taskId 和非空留言", () => {
  const value = input({ tasks: [task("t1", "p2-x", 1)], sessionAgents: { "s-t1": agent("t1", "approval", "要跑 rm 吗？") } });
  const [row] = currentTerminals(value);
  assert.equal(row?.workspace.id, "p2-x");
  assert.equal(row?.project?.id, "p2");
  assert.equal(row?.daemon.daemonId, "d1");
  assert.equal(row?.agent, "claude");
  assert.equal(row?.activity.status, "approval");
  assert.equal(row?.activity.status === "approval" ? row.activity.taskId : undefined, "t1");
  assert.equal(row?.activity.status === "approval" ? row.activity.message : undefined, "要跑 rm 吗？");

  const [silent] = currentTerminals(input({ tasks: [task("t1", "p2-x", 1)], sessionAgents: { "s-t1": agent("t1", "question") } }));
  assert.equal(silent?.activity.status === "question" ? silent.activity.message : "missing", undefined);
});

test("非 RUNNING、没有 sessionId、设备离线、已归档项目或工作区缺失的终端都不入选", () => {
  const sessionAgents = { "s-t1": agent("t1", "approval") };
  assert.deepEqual(ids(input({ tasks: [task("t1", "p1-a", 1, { status: TaskStatus.EXITED })], sessionAgents })), []);
  assert.deepEqual(ids(input({ tasks: [task("t1", "p1-a", 1, { sessionId: undefined })], sessionAgents })), []);
  assert.deepEqual(ids(input({ tasks: [task("t1", "p1-a", 1)], sessionAgents, daemons: [daemon("d1", false)] })), []);
  assert.deepEqual(ids(input({ tasks: [task("t1", "p1-a", 1)], sessionAgents, daemons: [] })), []);
  assert.deepEqual(ids(input({ tasks: [task("t1", "p1-a", 1)], sessionAgents, projects: [project("p1", "d1", 7), project("p2")] })), []);
  assert.deepEqual(ids(input({ tasks: [task("t1", "gone", 1)], sessionAgents })), []);
});

test("目录工作区的终端入选、project 为 null，排在所有项目终端之后，设备按 daemons 顺序", () => {
  const base = input();
  const value = input({
    daemons: [daemon("d2"), daemon("d1")],
    workspaces: [...base.workspaces, dirWorkspace("dir-d1", "d1", 1), dirWorkspace("dir-d2-late", "d2", 9), dirWorkspace("dir-d2", "d2", 2)],
    ...withAgents([
      ["t-dir-d1", "dir-d1", 1, "active"],
      ["t-dir-d2-late", "dir-d2-late", 1, "active"],
      ["t-dir-d2", "dir-d2", 1, "active"],
      ["t-p2", "p2-x", 99, "active"],
      ["t-p1", "p1-main", 50, "active"],
    ]),
  });
  const rows = currentTerminals(value);
  assert.deepEqual(rows.map((row) => row.task.id), ["t-p1", "t-p2", "t-dir-d2", "t-dir-d2-late", "t-dir-d1"]);
  assert.equal(rows[2]?.project, null);
  assert.equal(rows[2]?.daemon.daemonId, "d2");
});

test("同一工作区两个终端是两行，按 createdAt 升序（同时刻按 id）；状态变化不换位", () => {
  const before = ids(input(withAgents([["t-late", "p1-a", 20, "active"], ["t-early", "p1-a", 10, "active"], ["t-b", "p1-a", 20, "done"]])));
  assert.deepEqual(before, ["t-early", "t-b", "t-late"]);
  const after = ids(input(withAgents([["t-late", "p1-a", 20, "active"], ["t-early", "p1-a", 10, "approval"], ["t-b", "p1-a", 20, "done"]])));
  assert.deepEqual(after, before);
});

test("项目终端按树序：项目内主工作区在前、其余按 createdAt", () => {
  const rows = ids(input(withAgents([["t-c", "p1-c", 1, "active"], ["t-x", "p2-x", 1, "active"], ["t-a", "p1-a", 1, "error"], ["t-main", "p1-main", 1, "done"]])));
  assert.deepEqual(rows, ["t-main", "t-a", "t-c", "t-x"]);
});

test("标题优先级：OSC 标题 > 任务标题 > 「终端」", () => {
  const sessionAgents = { "s-t1": agent("t1", "active") };
  const titleOf = (overrides: Partial<CurrentTerminalsInput>) => currentTerminals(input({ sessionAgents, ...overrides }))[0]?.title;
  assert.equal(titleOf({ tasks: [task("t1", "p1-a", 1, { title: "任务标题" })], titles: { "s-t1": "OSC 标题" } }), "OSC 标题");
  assert.equal(titleOf({ tasks: [task("t1", "p1-a", 1, { title: "任务标题" })], titles: { "s-t1": "" } }), "任务标题");
  assert.equal(titleOf({ tasks: [task("t1", "p1-a", 1, { title: "任务标题" })] }), "任务标题");
  assert.equal(titleOf({ tasks: [task("t1", "p1-a", 1)] }), "终端");
});

test("候选标题只摘运行中且有 presence 的会话", () => {
  const tasks = [task("t1", "p1-a", 1), task("t2", "p1-a", 2), task("t3", "p1-a", 3, { status: TaskStatus.EXITED })];
  const sessionAgents = { "s-t1": agent("t1", "active"), "s-t3": agent("t3", "active") };
  const metadata = (sessionId: string, title: string): SessionMetadataState => ({ sessionId, taskId: "", title });
  const sessionMetadata = { "s-t1": metadata("s-t1", "一"), "s-t2": metadata("s-t2", "二"), "s-t3": metadata("s-t3", "三") };
  assert.deepEqual(candidateSessionTitles(tasks, sessionAgents, sessionMetadata), { "s-t1": "一" });
});

test("没有任务就是空列表", () => {
  assert.deepEqual(ids(input()), []);
  assert.deepEqual(ids(input({ projects: [], workspaces: [] })), []);
});

test("下一个待处理：屏幕上终端之后的第一个，到末尾绕回开头", () => {
  const rows = currentTerminals(input(withAgents([["t-a", "p1-a", 1, "approval"], ["t-b", "p1-b", 1, "active"], ["t-c", "p1-c", 1, "question"], ["t-main2", "p2-main", 1, "done"], ["t-x", "p2-x", 1, "error"]])));
  assert.deepEqual(rows.map((row) => row.task.id), ["t-a", "t-b", "t-c", "t-main2", "t-x"]);
  assert.equal(nextAttentionRow(rows, "t-a")?.task.id, "t-c");
  assert.equal(nextAttentionRow(rows, "t-b")?.task.id, "t-c");
  assert.equal(nextAttentionRow(rows, "t-c")?.task.id, "t-x");
  assert.equal(nextAttentionRow(rows, "t-x")?.task.id, "t-a");
  // No terminal on screen, or one outside the list: the first one.
  assert.equal(nextAttentionRow(rows, null)?.task.id, "t-a");
  assert.equal(nextAttentionRow(rows, "elsewhere")?.task.id, "t-a");
});

test("下一个待处理：同一工作区两个待处理终端是两站", () => {
  const rows = currentTerminals(input(withAgents([["t1", "p1-a", 1, "approval"], ["t2", "p1-a", 2, "question"], ["t3", "p1-b", 1, "active"]])));
  assert.equal(nextAttentionRow(rows, null)?.task.id, "t1");
  assert.equal(nextAttentionRow(rows, "t1")?.task.id, "t2");
  assert.equal(nextAttentionRow(rows, "t2")?.task.id, "t1");
});

test("下一个待处理：只有屏幕上的终端待处理时落回它自己；没有待处理就没有目标", () => {
  const only = currentTerminals(input(withAgents([["t1", "p1-b", 1, "question"], ["t2", "p2-x", 1, "active"]])));
  assert.equal(nextAttentionRow(only, "t1")?.task.id, "t1");

  const none = currentTerminals(input(withAgents([["t1", "p1-b", 1, "active"], ["t2", "p2-x", 1, "done"]])));
  assert.equal(nextAttentionRow(none, "t1"), null);
  assert.equal(nextAttentionRow([], null), null);
});
