import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStatus, type DaemonInfo, type Project, type Task, type Workspace } from "@coflux/protocol";
import type { SessionAgentState } from "@coflux/client";

import {
  buildPaletteSnapshot,
  deviceVisitKey,
  projectVisitKey,
  searchPaletteEntries,
  terminalVisitKey,
  workspaceVisitKey,
  type PaletteSnapshotInput,
} from "./command-palette-data";

function daemon(daemonId: string, name: string, online = true): DaemonInfo {
  return { daemonId, name, host: `${name}.local`, platform: "darwin", online } as unknown as DaemonInfo;
}

function project(id: string, name: string, daemonId = "d1"): Project {
  return { id, daemonId, name, repoPath: `/src/${name}`, defaultBranch: "main", createdAt: 1 } as unknown as Project;
}

function workspace(id: string, projectId: string, branch: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId,
    daemonId: "d1",
    branch,
    name: "",
    path: `/src/${branch}`,
    isMain: false,
    createdAt: 1,
    additions: 0,
    deletions: 0,
    ...extra,
  } as unknown as Workspace;
}

function task(id: string, workspaceId: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId,
    daemonId: "d1",
    title,
    status: TaskStatus.RUNNING,
    sessionId: `s-${id}`,
    createdAt: 1,
    ...extra,
  } as unknown as Task;
}

function agent(taskId: string, state: string, name = "claude"): SessionAgentState {
  return { daemonId: "d1", taskId, agent: name, state, message: "", progress: "", agentSessionId: "" };
}

/** Two projects on one device, one of them holding a second worktree and two running terminals. */
function fixture(current: PaletteSnapshotInput["current"] = { workspaceId: null, taskId: null, daemonId: null }): PaletteSnapshotInput {
  return {
    projects: [project("p1", "coflux"), project("p2", "verge")],
    workspaces: [
      workspace("w1", "p1", "main", { isMain: true }),
      workspace("w2", "p1", "feat/cmd-p"),
      workspace("w3", "p2", "fix/login", { isMain: true }),
      // A directory workspace (device detail carrier): no project, never listed as a workspace.
      workspace("w-dir", "", "", { name: "cc-host", path: "/Users/cc" }),
    ],
    daemons: [daemon("d1", "cc-host")],
    tasks: [
      task("t1", "w2", "claude"),
      task("t2", "w1", "终端 2"),
      task("t-dir", "w-dir", "设备终端"),
      task("t-exited", "w1", "旧终端", { status: TaskStatus.EXITED, sessionId: undefined }),
      task("t-idle", "w1", "空闲终端", { status: TaskStatus.IDLE, sessionId: undefined }),
    ],
    sessionAgents: { "s-t1": agent("t1", "active") },
    sessionCheckpoints: {},
    current,
  };
}

test("快照覆盖四种条目，目录工作区只出终端、非 RUNNING 终端一律不出现", () => {
  const snapshot = buildPaletteSnapshot(fixture());
  const keys = snapshot.entries.map((entry) => entry.key);

  assert.deepEqual(keys.filter((key) => key.startsWith("project:")), [projectVisitKey("p1"), projectVisitKey("p2")]);
  assert.deepEqual(keys.filter((key) => key.startsWith("workspace:")), [
    workspaceVisitKey("w1"),
    workspaceVisitKey("w2"),
    workspaceVisitKey("w3"),
  ]);
  assert.deepEqual(keys.filter((key) => key.startsWith("terminal:")), [
    terminalVisitKey("t1"),
    terminalVisitKey("t2"),
    terminalVisitKey("t-dir"),
  ]);
  assert.deepEqual(keys.filter((key) => key.startsWith("device:")), [deviceVisitKey("d1")]);

  // 判据是 RUNNING 本身，不是「不等于 EXITED」——IDLE 同样不是可去的地方。
  const runningIds = new Set(fixture().tasks.filter((item) => item.status === TaskStatus.RUNNING).map((item) => item.id));
  for (const entry of snapshot.entries) {
    if (entry.target.kind !== "terminal") continue;
    assert.ok(runningIds.has(entry.target.taskId), `${entry.target.taskId} 不是 RUNNING`);
  }

  const terminal = snapshot.entries.find((entry) => entry.key === terminalVisitKey("t1"))!;
  assert.deepEqual(terminal.target, { kind: "terminal", workspaceId: "w2", taskId: "t1" });
  assert.equal(terminal.detail, "feat/cmd-p");
  assert.equal(terminal.context, "coflux");
  assert.equal(terminal.activity, "active");

  // 项目条目打开的是它的主工作区
  const projectEntry = snapshot.entries.find((entry) => entry.key === projectVisitKey("p1"))!;
  assert.deepEqual(projectEntry.target, { kind: "workspace", workspaceId: "w1" });
});

test("终端标题用 Tab 自己的规则：有 OSC checkpoint 标题就覆盖 task.title", () => {
  const input = fixture();
  input.sessionCheckpoints = { "s-t1": { title: "claude · 正在改 palette" } };
  const snapshot = buildPaletteSnapshot(input);
  const terminal = snapshot.entries.find((entry) => entry.key === terminalVisitKey("t1"))!;
  assert.equal(terminal.label, "claude · 正在改 palette");
});

test("空查询给出「最近」，上一个位置排第一，当前位置整组不出现", () => {
  // 正在看 w1（p1 的主工作区）的 t2 这个 Tab；访问顺序里它们排在最前。
  const snapshot = buildPaletteSnapshot(fixture({ workspaceId: "w1", taskId: "t2", daemonId: "d1" }));
  const recent = [
    terminalVisitKey("t2"),
    workspaceVisitKey("w1"),
    workspaceVisitKey("w2"),
    deviceVisitKey("d1"),
    terminalVisitKey("t1"),
  ];
  const items = searchPaletteEntries({ snapshot, query: "", filter: "all", recent });

  assert.deepEqual(items.map((item) => item.id), [workspaceVisitKey("w2"), terminalVisitKey("t1")]);
  assert.equal(items[0].auxiliaryData.group, "最近");
  // 当前位置的四件套：选中工作区、它的活动 Tab、它所属项目、选中设备
  for (const absent of [workspaceVisitKey("w1"), terminalVisitKey("t2"), projectVisitKey("p1"), deviceVisitKey("d1")]) {
    assert.ok(!items.some((item) => item.id === absent), `${absent} 不该出现在最近里`);
  }
});

test("空查询下切到某个类别 Tab：先最近、再补齐该类别的其余条目", () => {
  const snapshot = buildPaletteSnapshot(fixture({ workspaceId: "w1", taskId: null, daemonId: null }));
  const items = searchPaletteEntries({ snapshot, query: "", filter: "device", recent: [deviceVisitKey("d1")] });
  assert.deepEqual(items.map((item) => item.id), [deviceVisitKey("d1")]);
  assert.equal(items[0].auxiliaryData.group, "最近");

  const terminals = searchPaletteEntries({ snapshot, query: "", filter: "terminal", recent: [] });
  assert.deepEqual(terminals.map((item) => item.auxiliaryData.group), ["终端", "终端", "终端"]);
});

test("一次查询同时命中分支、项目名、设备名与终端标题", () => {
  const snapshot = buildPaletteSnapshot(fixture());

  // 分支名同时是那个工作区里终端的副标题，所以一次查询两类都命中，按固定分组顺序排。
  assert.deepEqual(
    searchPaletteEntries({ snapshot, query: "cmd-p", filter: "all", recent: [] }).map((item) => item.id),
    [workspaceVisitKey("w2"), terminalVisitKey("t1")],
  );
  assert.deepEqual(
    searchPaletteEntries({ snapshot, query: "verge", filter: "all", recent: [] }).map((item) => item.id),
    [projectVisitKey("p2"), workspaceVisitKey("w3")],
  );
  assert.deepEqual(
    searchPaletteEntries({ snapshot, query: "claude", filter: "all", recent: [] }).map((item) => item.id),
    [terminalVisitKey("t1")],
  );
  assert.ok(
    searchPaletteEntries({ snapshot, query: "cc-host", filter: "all", recent: [] }).some((item) => item.id === deviceVisitKey("d1")),
  );
  // 每个词都要命中：第二个词只会收窄
  assert.deepEqual(searchPaletteEntries({ snapshot, query: "cmd-p verge", filter: "all", recent: [] }), []);
});

test("同一档命中里，正在干活 / 在等人的条目排在闲着的前面", () => {
  const input = fixture();
  input.workspaces = [
    workspace("w1", "p1", "task-a", { isMain: true }),
    workspace("w2", "p1", "task-b"),
    workspace("w3", "p1", "task-c"),
  ];
  input.tasks = [task("t1", "w2", "终端"), task("t2", "w3", "终端")];
  input.sessionAgents = { "s-t1": agent("t1", "approval"), "s-t2": agent("t2", "active") };
  const snapshot = buildPaletteSnapshot(input);
  const items = searchPaletteEntries({ snapshot, query: "task", filter: "workspace", recent: [] });
  // w2 待批准 > w3 执行中 > w1 闲置；项目条目只在关键字里命中（主工作区分支），垫底。
  assert.deepEqual(items.map((item) => item.id), [
    workspaceVisitKey("w2"),
    workspaceVisitKey("w3"),
    workspaceVisitKey("w1"),
    projectVisitKey("p1"),
  ]);
});

test("分组顺序固定为 工作区 → 终端 → 设备，不随得分漂移", () => {
  const input = fixture();
  input.daemons = [daemon("d1", "alpha")];
  input.projects = [project("p1", "alpha-project")];
  input.workspaces = [workspace("w1", "p1", "alpha-branch", { isMain: true })];
  input.tasks = [task("t1", "w1", "alpha-terminal")];
  input.sessionAgents = { "s-t1": agent("t1", "approval") };
  const snapshot = buildPaletteSnapshot(input);
  const groups = searchPaletteEntries({ snapshot, query: "alpha", filter: "all", recent: [] }).map((item) => item.auxiliaryData.group);
  assert.deepEqual(groups, ["工作区", "工作区", "终端", "设备"]);
});

test("类别 Tab 收窄查询结果", () => {
  const input = fixture();
  input.projects = [project("p1", "shared")];
  input.workspaces = [workspace("w1", "p1", "shared", { isMain: true })];
  input.tasks = [task("t1", "w1", "shared")];
  input.daemons = [daemon("d1", "shared")];
  const snapshot = buildPaletteSnapshot(input);

  const all = searchPaletteEntries({ snapshot, query: "shared", filter: "all", recent: [] });
  assert.deepEqual(all.map((item) => item.auxiliaryData.group), ["工作区", "工作区", "终端", "设备"]);
  assert.deepEqual(
    searchPaletteEntries({ snapshot, query: "shared", filter: "terminal", recent: [] }).map((item) => item.id),
    [terminalVisitKey("t1")],
  );
  assert.deepEqual(
    searchPaletteEntries({ snapshot, query: "shared", filter: "device", recent: [] }).map((item) => item.id),
    [deviceVisitKey("d1")],
  );
  // 项目与工作区共用「工作区」Tab，项目没有自己的类别
  assert.deepEqual(
    searchPaletteEntries({ snapshot, query: "shared", filter: "workspace", recent: [] }).map((item) => item.id),
    [projectVisitKey("p1"), workspaceVisitKey("w1")],
  );
});

test("离线设备的工作区仍然列出，只是标记为离线并轻微靠后", () => {
  const input = fixture();
  input.daemons = [daemon("d1", "cc-host", false)];
  const snapshot = buildPaletteSnapshot(input);
  const entry = snapshot.entries.find((item) => item.key === workspaceVisitKey("w2"))!;
  assert.equal(entry.isOffline, true);
  assert.equal(entry.activity, null);
  assert.ok(searchPaletteEntries({ snapshot, query: "cmd-p", filter: "all", recent: [] }).some((item) => item.id === entry.key));
});

test("新建浏览器标签页 is an action: offered only with a workspace on screen, only on a typed query in 全部", () => {
  const withAction = buildPaletteSnapshot({ ...fixture({ workspaceId: "w1", taskId: null, daemonId: null }), canOpenBrowserTab: true });
  const without = buildPaletteSnapshot(fixture());
  assert.equal(without.entries.some((entry) => entry.kind === "action"), false);

  const typed = searchPaletteEntries({ snapshot: withAction, query: "浏览器", filter: "all", recent: [] });
  assert.equal(typed[0]?.auxiliaryData.entry.target.kind, "action");
  assert.equal(typed[0]?.auxiliaryData.group, "操作");
  assert.equal(searchPaletteEntries({ snapshot: withAction, query: "browser", filter: "all", recent: [] })[0]?.label, "新建浏览器标签页");
  // Never on the empty-query list (not even if its key were remembered), never on a narrowed tab.
  const empty = searchPaletteEntries({ snapshot: withAction, query: "", filter: "all", recent: ["action:new-browser-tab"] });
  assert.equal(
    empty.some((item) => item.auxiliaryData.entry.kind === "action"),
    false,
  );
  assert.equal(searchPaletteEntries({ snapshot: withAction, query: "浏览器", filter: "terminal", recent: [] }).length, 0);
});
