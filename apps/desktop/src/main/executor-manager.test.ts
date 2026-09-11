import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ExecutorManager, type ExecutorConfigSnapshot, type RunnerHandle } from "./executor-manager";
import type { ExecutorRunnerOutbound, ExecutorRunnerStart } from "./executor-runner-protocol";
import type { ExecutorAssignment } from "./executor-jobs";

const CONFIG: ExecutorConfigSnapshot = {
  ready: true,
  reason: "",
  provider: "anthropic",
  modelId: "claude-x",
  apiKey: "sk-secret",
  systemPrompt: "you are coflux executor",
  shell: "/bin/zsh",
};

type Report = { runId: string; state: string; note: string; summary?: string; changedFiles?: string[]; error?: string };

class FakeRunner implements RunnerHandle {
  posted: unknown[] = [];
  killed = false;
  private messageListeners: ((m: ExecutorRunnerOutbound) => void)[] = [];
  private exitListeners: ((code: number) => void)[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  kill(): void {
    this.killed = true;
  }
  on(event: "message" | "exit", listener: never): void {
    if (event === "message") this.messageListeners.push(listener as (m: ExecutorRunnerOutbound) => void);
    else this.exitListeners.push(listener as (code: number) => void);
  }
  emit(message: ExecutorRunnerOutbound): void {
    for (const listener of this.messageListeners) listener(message);
  }
  exit(code: number): void {
    for (const listener of this.exitListeners) listener(code);
  }
  start(): ExecutorRunnerStart | undefined {
    return this.posted.find((m): m is ExecutorRunnerStart => (m as { type?: string })?.type === "start");
  }
}

function harness(over: Partial<ExecutorConfigSnapshot> = {}) {
  const reports: Report[] = [];
  const runners: FakeRunner[] = [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coflux-exec-test-")));
  mkdirSync(join(root, "sub"), { recursive: true });
  const manager = new ExecutorManager({
    spawnRunner: () => {
      const runner = new FakeRunner();
      runners.push(runner);
      return runner;
    },
    config: () => ({ ...CONFIG, ...over }),
    sendReport: (report) => reports.push(report),
    // 不是 git 仓库也要能跑；这里直接给失败，走「无 git 元数据」分支
    runGit: () => ({ stdout: "", ok: false }),
  });
  return { manager, reports, runners, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function assignment(root: string, over: Partial<ExecutorAssignment> = {}): ExecutorAssignment {
  return {
    runId: "run-1",
    prompt: "做点事",
    write: true,
    workspaceId: "ws-a",
    workspaceRoot: root,
    submittedAt: 1,
    ...over,
  };
}

test("接单后起 runner，并把解析后的路径与配置下发", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    assert.equal(h.runners.length, 1);
    const start = h.runners[0].start();
    assert.equal(start?.workspaceRoot, h.root);
    assert.equal(start?.write, true);
    assert.equal(start?.model.provider, "anthropic");
    assert.ok(start?.sandboxProfilePath.endsWith("sandbox.sb"));
    assert.ok(start?.scratchDir.includes("coflux-executor-"));
  } finally {
    h.cleanup();
  }
});

test("未配置 provider 时不起 runner，直接回 rejected 并带原因", () => {
  const h = harness({ ready: false, reason: "去桌面配 provider" });
  try {
    h.manager.onAssign(assignment(h.root));
    assert.equal(h.runners.length, 0);
    assert.equal(h.reports.at(-1)?.state, "rejected");
    assert.equal(h.reports.at(-1)?.note, "去桌面配 provider");
  } finally {
    h.cleanup();
  }
});

test("工作区路径不存在：不起 runner，落终态而不是把写锁挂死", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root, { workspaceRoot: "/nope/does/not/exist" }));
    assert.equal(h.runners.length, 0);
    assert.equal(h.reports.at(-1)?.state, "tool_failed");
    assert.match(h.reports.at(-1)?.error ?? "", /启动失败/);
    // 锁必须已放开：下一个写请求进得来
    h.manager.onAssign(assignment(h.root, { runId: "run-2" }));
    assert.equal(h.runners.length, 1);
  } finally {
    h.cleanup();
  }
});

test("runner 报 running / progress 会转成回报", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    h.runners[0].emit({ type: "running" });
    h.runners[0].emit({ type: "progress", note: "正在执行 bash" });
    const states = h.reports.map((r) => r.state);
    assert.deepEqual(states, ["accepted", "running", "running"]);
    assert.equal(h.reports.at(-1)?.note, "正在执行 bash");
  } finally {
    h.cleanup();
  }
});

test("runner 报 done：终态与改动文件一并回报，写锁随之放开", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    h.runners[0].emit({ type: "done", outcome: "succeeded", summary: "做完了", changedFiles: ["a.ts"] });
    const last = h.reports.at(-1);
    assert.equal(last?.state, "succeeded");
    assert.equal(last?.summary, "做完了");
    assert.deepEqual(last?.changedFiles, ["a.ts"]);
    h.manager.onAssign(assignment(h.root, { runId: "run-2" }));
    assert.equal(h.runners.length, 2);
  } finally {
    h.cleanup();
  }
});

test("runner 进程异常消失判 unknown，而不是 tool_failed——它写到哪了我们不知道", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    h.runners[0].exit(9);
    assert.equal(h.reports.at(-1)?.state, "unknown");
    assert.match(h.reports.at(-1)?.error ?? "", /无法判断/);
  } finally {
    h.cleanup();
  }
});

test("已经落了终态之后进程退出，不会把成功覆盖成 unknown", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    h.runners[0].emit({ type: "done", outcome: "succeeded", summary: "ok", changedFiles: [] });
    h.runners[0].exit(0);
    assert.equal(h.reports.at(-1)?.state, "succeeded");
  } finally {
    h.cleanup();
  }
});

test("取消先给 runner 发 abort，不是上来就杀", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    h.manager.onCancel("run-1");
    assert.deepEqual(h.runners[0].posted.at(-1), { type: "abort" });
    assert.equal(h.runners[0].killed, false);
  } finally {
    h.cleanup();
  }
});

test("app 退出：未终结的 run 落 cancelled 且 runner 被杀", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    h.manager.shutdown();
    assert.equal(h.runners[0].killed, true);
    assert.equal(h.reports.at(-1)?.state, "cancelled");
    assert.deepEqual(h.manager.activeRunIds(), []);
  } finally {
    h.cleanup();
  }
});

test("对账把 daemon 手里不认识的 run 判 unknown", () => {
  const h = harness();
  try {
    h.manager.onReconcile(["ghost"]);
    assert.equal(h.reports.at(-1)?.runId, "ghost");
    assert.equal(h.reports.at(-1)?.state, "unknown");
  } finally {
    h.cleanup();
  }
});

test("凭证只出现在给 runner 的 start 消息里，不出现在任何回报中", () => {
  const h = harness();
  try {
    h.manager.onAssign(assignment(h.root));
    h.runners[0].emit({ type: "done", outcome: "succeeded", summary: "ok", changedFiles: [] });
    assert.equal(h.runners[0].start()?.apiKey, "sk-secret");
    assert.equal(JSON.stringify(h.reports).includes("sk-secret"), false);
  } finally {
    h.cleanup();
  }
});
