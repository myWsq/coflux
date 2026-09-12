import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecutorJobTable, isTerminal, type ExecutorAssignment, type ExecutorEffect } from "./executor-jobs";

const READY = { ready: true, reason: "" };

function assignment(over: Partial<ExecutorAssignment> = {}): ExecutorAssignment {
  return {
    runId: "run-1",
    prompt: "把 clippy 警告清掉",
    write: true,
    workspaceId: "ws-a",
    workspaceRoot: "/repo/a",
    submittedAt: 1_000,
    ...over,
  };
}

function table(maxConcurrent = 3) {
  return new ExecutorJobTable({ maxConcurrent }, READY);
}

type ReportEffect = Extract<ExecutorEffect, { kind: "report" }>;

function reports(effects: ExecutorEffect[]): ReportEffect[] {
  return effects.filter((e): e is ReportEffect => e.kind === "report");
}

function starts(effects: ExecutorEffect[]) {
  return effects.filter((e) => e.kind === "start");
}

test("接单：报 accepted 并要求起 runner", () => {
  const t = table();
  const effects = t.assign(assignment());
  assert.deepEqual(
    reports(effects).map((e) => e.kind === "report" && e.state),
    ["accepted"],
  );
  assert.equal(starts(effects).length, 1);
  assert.equal(t.get("run-1")?.state, "accepted");
});

test("写模式同一工作区互斥：第二个写请求当场拒，且不起第二个 runner", () => {
  const t = table();
  t.assign(assignment({ runId: "run-1" }));
  const effects = t.assign(assignment({ runId: "run-2" }));
  assert.equal(starts(effects).length, 0);
  const report = reports(effects)[0];
  assert.equal(report.kind === "report" && report.state, "rejected");
  assert.match(report.kind === "report" ? report.note : "", /写模式同一工作区只能有一个/);
});

test("不同工作区的写模式互不影响", () => {
  const t = table();
  t.assign(assignment({ runId: "run-1", workspaceId: "ws-a" }));
  const effects = t.assign(assignment({ runId: "run-2", workspaceId: "ws-b" }));
  assert.equal(starts(effects).length, 1);
});

test("只读可并发，同一工作区也行", () => {
  const t = table();
  const a = t.assign(assignment({ runId: "run-1", write: false }));
  const b = t.assign(assignment({ runId: "run-2", write: false }));
  assert.equal(starts(a).length, 1);
  assert.equal(starts(b).length, 1);
});

test("写手在跑时只读仍可进（互斥只约束写与写）", () => {
  const t = table();
  t.assign(assignment({ runId: "w", write: true }));
  const effects = t.assign(assignment({ runId: "r", write: false }));
  assert.equal(starts(effects).length, 1);
});

test("总数封顶：超过上限一律拒，与读写无关", () => {
  const t = table(2);
  t.assign(assignment({ runId: "r1", write: false }));
  t.assign(assignment({ runId: "r2", write: false }));
  const effects = t.assign(assignment({ runId: "r3", write: false }));
  assert.equal(starts(effects).length, 0);
  const report = reports(effects)[0];
  assert.match(report.kind === "report" ? report.note : "", /已达上限 2/);
});

test("未配置 provider/模型时一律拒，理由透传给 agent", () => {
  const t = new ExecutorJobTable({ maxConcurrent: 3 }, { ready: false, reason: "去桌面 app 配 provider" });
  const effects = t.assign(assignment());
  assert.equal(starts(effects).length, 0);
  const report = reports(effects)[0];
  assert.equal(report.kind === "report" && report.note, "去桌面 app 配 provider");
});

test("同一 runId 重复投递是幂等的：只回报当前状态，不起第二个 runner", () => {
  const t = table();
  t.assign(assignment());
  t.markRunning("run-1", "在跑测试");
  const again = t.assign(assignment());
  assert.equal(starts(again).length, 0);
  const report = reports(again)[0];
  assert.equal(report.kind === "report" && report.state, "running");
});

test("终态后放锁，下一个写请求才进得来", () => {
  const t = table();
  t.assign(assignment({ runId: "run-1" }));
  assert.equal(starts(t.assign(assignment({ runId: "run-2" }))).length, 0);
  t.finish("run-1", { state: "succeeded", summary: "清完了" });
  assert.equal(starts(t.assign(assignment({ runId: "run-3" }))).length, 1);
});

test("终态是一次性的：重复 finish 不再发第二份回报", () => {
  const t = table();
  t.assign(assignment());
  t.finish("run-1", { state: "succeeded" });
  assert.deepEqual(t.finish("run-1", { state: "tool_failed" }), []);
  assert.equal(t.get("run-1")?.state, "succeeded");
});

test("取消幂等：重复取消只发一次 stop，已终结的 run 上取消是空操作", () => {
  const t = table();
  t.assign(assignment());
  const first = t.cancel("run-1");
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "stop");
  assert.deepEqual(t.cancel("run-1"), []);
  t.finish("run-1", { state: "cancelled" });
  assert.deepEqual(t.cancel("run-1"), []);
});

test("取消不认识的 run 是空操作，不抛", () => {
  assert.deepEqual(table().cancel("nope"), []);
});

test("ack 之后终态条目被丢掉，不再重发", () => {
  const t = table();
  t.assign(assignment());
  t.finish("run-1", { state: "succeeded" });
  assert.equal(t.get("run-1")?.reportPending, true);
  t.ack("run-1");
  assert.equal(t.get("run-1"), undefined);
});

test("对账：认识且在跑的照实报，不认识的判 unknown", () => {
  const t = table();
  t.assign(assignment({ runId: "mine" }));
  t.markRunning("mine");
  const effects = reports(t.reconcile(["mine", "stranger"]));
  const stateOf = (runId: string) => effects.find((e) => e.runId === runId)?.state;
  assert.equal(stateOf("mine"), "running");
  assert.equal(stateOf("stranger"), "unknown");
});

test("对账时把 daemon 没问起、但本地仍未 ack 的终态一并重发", () => {
  const t = table();
  t.assign(assignment({ runId: "done" }));
  t.finish("done", { state: "succeeded", summary: "好了" });
  const effects = t.reconcile([]);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].kind === "report" && effects[0].runId, "done");
});

test("对账不会把 unknown 变成重跑：只报状态，不产生 start", () => {
  const t = table();
  assert.equal(starts(t.reconcile(["gone"])).length, 0);
});

test("本机运行时停止：未终结的 run 落 cancelled 并请求停止，不留悬空", () => {
  const t = table();
  t.assign(assignment({ runId: "a" }));
  t.assign(assignment({ runId: "b", workspaceId: "ws-b" }));
  t.finish("b", { state: "succeeded" });
  t.ack("b");
  const effects = t.cancelAll("退出 Coflux，任务被中断");
  assert.equal(effects.filter((e) => e.kind === "stop").length, 1);
  const terminal = reports(effects).find((e) => e.kind === "report" && e.runId === "a");
  assert.equal(terminal?.kind === "report" && terminal.state, "cancelled");
  // The terminal state has to carry which action ended the run; the CLI prints it verbatim.
  assert.equal(terminal?.kind === "report" && terminal.outcome?.error, "退出 Coflux，任务被中断");
  assert.equal(t.activeRunIds().length, 0);
  // Idempotent: a second call emits nothing.
  assert.deepEqual(t.cancelAll("退出 Coflux，任务被中断"), []);
});

test("activeRunIds 只含未终结的", () => {
  const t = table();
  t.assign(assignment({ runId: "a" }));
  t.assign(assignment({ runId: "b", workspaceId: "ws-b" }));
  t.finish("b", { state: "succeeded" });
  assert.deepEqual(t.activeRunIds(), ["a"]);
});

test("isTerminal 覆盖全部六个终态，两个进行态不算", () => {
  for (const s of ["succeeded", "rejected", "model_error", "tool_failed", "cancelled", "unknown"] as const) {
    assert.equal(isTerminal(s), true, s);
  }
  assert.equal(isTerminal("accepted"), false);
  assert.equal(isTerminal("running"), false);
});
