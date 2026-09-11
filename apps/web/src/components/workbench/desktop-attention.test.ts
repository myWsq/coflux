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
  return { daemonId: "d1", taskId, agent: "claude", state, message, progress: "" };
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

test("question 态带 agent 留言", () => {
  const snapshot = attentionSnapshot({ ...base, sessionAgents: { "s-b": agent("t-b", "question", "要不要跑测试？") } });
  assert.equal(snapshot["ws-b"].kind, "question");
  assert.equal(snapshot["ws-b"].message, "要不要跑测试？");
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

test("通知文案：标题说谁在等什么，正文定位项目/分支，提问态附留言", () => {
  assert.deepEqual(attentionNotificationText({ kind: "approval", agent: "claude", branch: "main", projectName: "coflux" }), {
    title: "claude 等待批准",
    body: "coflux · main",
  });
  assert.deepEqual(attentionNotificationText({ kind: "question", agent: "codex", branch: "feature", message: "要不要跑测试？" }), {
    title: "codex 等待回答",
    body: "feature\n要不要跑测试？",
  });
});
