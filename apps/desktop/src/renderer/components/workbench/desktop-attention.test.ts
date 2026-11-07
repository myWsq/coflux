import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStatus, type Task, type Workspace } from "@coflux/protocol";
import type { SessionAgentState } from "@coflux/client";

import { attentionNotificationText, attentionSnapshot, diffAttention, type AttentionSnapshot } from "./desktop-attention";

function workspace(id: string, branch = id): Workspace {
  return { id, projectId: "p1", daemonId: "d1", branch, name: "", isMain: false, createdAt: 1, additions: 0, deletions: 0 } as unknown as Workspace;
}
function task(id: string, workspaceId: string, sessionId: string): Task {
  return { id, workspaceId, sessionId, status: TaskStatus.RUNNING, title: "终端" } as unknown as Task;
}
function agent(taskId: string, state: string, message = ""): SessionAgentState {
  return { daemonId: "d1", taskId, agent: "claude", state, message, progress: "", agentSessionId: "" };
}

const base = {
  workspaces: [workspace("ws-a", "main"), workspace("ws-b", "feature")],
  daemons: [{ daemonId: "d1", online: true }],
  tasks: [task("t-a", "ws-a", "s-a"), task("t-b", "ws-b", "s-b")],
  projects: [{ id: "p1", name: "coflux" }],
};

test("快照只收 approval / question 两态，active/done/idle 与离线设备都不算等待", () => {
  const snapshot = attentionSnapshot({ ...base, sessionAgents: { "s-a": agent("t-a", "approval"), "s-b": agent("t-b", "active") } });
  assert.deepEqual(Object.keys(snapshot), ["ws-a"]);
  assert.equal(snapshot["ws-a"].kind, "approval");
  assert.equal(snapshot["ws-a"].agent, "claude");
  assert.equal(snapshot["ws-a"].projectName, "coflux");
  assert.equal(snapshot["ws-a"].branch, "main");

  const offline = attentionSnapshot({ ...base, daemons: [{ daemonId: "d1", online: false }], sessionAgents: { "s-a": agent("t-a", "approval") } });
  assert.deepEqual(offline, {});

  const done = attentionSnapshot({ ...base, sessionAgents: { "s-a": agent("t-a", "done"), "s-b": agent("t-b", "waiting") } });
  assert.deepEqual(done, {});
});

test("两次快照：新进入等待的才提醒，持续等待不重复；角标 = 当前等待数", () => {
  const first: AttentionSnapshot = { "ws-a": { kind: "approval", agent: "claude", branch: "main" } };
  const initial = diffAttention({}, first);
  assert.deepEqual(initial.entered.map((item) => item.workspaceId), ["ws-a"]);
  assert.equal(initial.badgeCount, 1);

  const unchanged = diffAttention(first, first);
  assert.deepEqual(unchanged.entered, []);
  assert.equal(unchanged.badgeCount, 1);

  const second: AttentionSnapshot = { ...first, "ws-b": { kind: "question", agent: "codex", branch: "feature" } };
  const added = diffAttention(first, second);
  assert.deepEqual(added.entered.map((item) => item.workspaceId), ["ws-b"]);
  assert.equal(added.badgeCount, 2);
});

test("恢复后清零；恢复再进入才再次提醒；批准 → 提问视为新事件", () => {
  const waiting: AttentionSnapshot = { "ws-a": { kind: "approval", agent: "claude", branch: "main" } };
  const recovered = diffAttention(waiting, {});
  assert.deepEqual(recovered.entered, []);
  assert.equal(recovered.badgeCount, 0);

  const again = diffAttention({}, waiting);
  assert.deepEqual(again.entered.map((item) => item.workspaceId), ["ws-a"]);

  const switched: AttentionSnapshot = { "ws-a": { kind: "question", agent: "claude", branch: "main", message: "继续？" } };
  const kindChanged = diffAttention(waiting, switched);
  assert.deepEqual(kindChanged.entered.map((item) => item.entry.kind), ["question"]);
  assert.equal(kindChanged.badgeCount, 1);
});

test("两个终端同时等待：快照的 taskId 与标题里的 agent 属于同一个任务", () => {
  const tasks = [task("t-1", "ws-a", "s-1"), task("t-2", "ws-a", "s-2")];
  const sessionAgents = {
    "s-1": { ...agent("t-1", "question", "继续？"), agent: "codex" },
    "s-2": { ...agent("t-2", "approval"), agent: "claude" },
  };
  const snapshot = attentionSnapshot({ ...base, tasks, sessionAgents });
  assert.equal(snapshot["ws-a"].kind, "approval");
  assert.equal(snapshot["ws-a"].agent, "claude");
  assert.equal(snapshot["ws-a"].taskId, "t-2");

  const questions = attentionSnapshot({ ...base, tasks, sessionAgents: { ...sessionAgents, "s-2": { ...agent("t-2", "question"), agent: "claude" } } });
  assert.equal(questions["ws-a"].agent, "codex");
  assert.equal(questions["ws-a"].taskId, "t-1");
});

test("a program stopped on an error notifies once, titled with its agent, its message in the body", () => {
  const sessionAgents = { "s-a": { ...agent("t-a", "error", "build failed"), agent: "demo" } };
  const snapshot = attentionSnapshot({ ...base, sessionAgents });
  assert.equal(snapshot["ws-a"].kind, "error");
  assert.equal(snapshot["ws-a"].taskId, "t-a");

  const diff = diffAttention({}, snapshot);
  assert.equal(diff.entered.length, 1);
  assert.deepEqual(attentionNotificationText(diff.entered[0].entry), {
    title: "demo 出错停止",
    body: "coflux · main\nbuild failed",
  });
  assert.deepEqual(diffAttention(snapshot, snapshot).entered, [], "staying stopped is not new");

  // Question → error is a change of kind, so new attention.
  const question = attentionSnapshot({ ...base, sessionAgents: { "s-a": agent("t-a", "question") } });
  assert.deepEqual(diffAttention(question, snapshot).entered.map((item) => item.entry.kind), ["error"]);

  // Without a message the body is just the place.
  const bare = attentionSnapshot({ ...base, sessionAgents: { "s-a": { ...agent("t-a", "error"), agent: "demo" } } });
  assert.deepEqual(attentionNotificationText(bare["ws-a"]), { title: "demo 出错停止", body: "coflux · main" });
});

test("error ranks below approval and question and above active", () => {
  const tasks = [task("t-1", "ws-a", "s-1"), task("t-2", "ws-a", "s-2")];
  const withActive = attentionSnapshot({ ...base, tasks, sessionAgents: { "s-1": agent("t-1", "active"), "s-2": agent("t-2", "error", "boom") } });
  assert.equal(withActive["ws-a"].kind, "error");
  assert.equal(withActive["ws-a"].taskId, "t-2");
  assert.equal(withActive["ws-a"].message, "boom");

  const withQuestion = attentionSnapshot({ ...base, tasks, sessionAgents: { "s-1": agent("t-1", "error", "boom"), "s-2": agent("t-2", "question", "继续？") } });
  assert.equal(withQuestion["ws-a"].kind, "question");
  assert.equal(withQuestion["ws-a"].message, "继续？");

});

test("an approval carries the agent's message in the body when it left one", () => {
  const withMessage = attentionSnapshot({ ...base, sessionAgents: { "s-a": agent("t-a", "approval", "Apply?") } });
  assert.equal(withMessage["ws-a"].message, "Apply?");
  assert.deepEqual(attentionNotificationText(withMessage["ws-a"]), { title: "claude 等待批准", body: "coflux · main\nApply?" });

  // A hook-driven approval has no message: the body is just the place, as before.
  const bare = attentionSnapshot({ ...base, sessionAgents: { "s-a": agent("t-a", "approval") } });
  assert.equal(bare["ws-a"].message, undefined);
  assert.deepEqual(attentionNotificationText(bare["ws-a"]), { title: "claude 等待批准", body: "coflux · main" });
});
