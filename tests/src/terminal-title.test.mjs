/**
 * plan 075：OSC 0/2 终端标题经 sessiond 捕获、随 checkpoint 链路到达客户端。
 *
 * 验收核心：PTY 里的程序发 OSC 标题序列（claude 自动标题即此机制）→ sessiond 的
 * vt100 回调捕获 → worker checkpoint 携带 title → server 落库广播；**没有任何
 * Device subscriber 时依然更新**（worker 主动向 sessiond 取 snapshot），且**新订阅
 * 的客户端（页面刷新路径）订阅即在存量补发里拿到 title**。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8858;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("OSC 标题无 subscriber 也随 checkpoint 上报，新订阅补发仍带 title", async () => {
  const repo = mkRepo();
  repos.push(repo);

  const device = await openRelayDevice(stack);
  const A = device.control;
  A.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await A.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  A.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "tt" });
  const idle = await A.waitFor((m) => m.case === "taskUpdated" && m.task.title === "tt", "idle");
  const taskId = idle.task.id;
  A.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await A.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  await device.attach(sessionId);
  // 延迟发 OSC：Device subscriber 关闭后才产生标题序列，checkpoint 必须由 worker 主动取。
  await device.input(sessionId, "(sleep 2; printf '\\033]0;TITLE_MARKER \\345\\244\\207\\346\\263\\250\\007') &\r");
  device.close();

  // 谓词直接等我们的标题：shell 自身也可能发 OSC（CI 的 bash PS1 带 \e]0;\u@\h…\a，
  // 每次出 prompt 都会覆盖标题——这正是「通用终端标题」语义），不能假设第一条非空
  // title 就是 marker。clamp_title 剔除控制字符、保留 UTF-8（\345\244\207\346\263\250 = 备注）。
  const observer = stack.makeClient();
  await observer.authSubscribe();
  await observer.waitFor(
    (m) => m.case === "sessionCheckpoint" && m.sessionId === sessionId && m.title === "TITLE_MARKER 备注",
    "checkpoint carries OSC title",
    12000,
  );
  observer.close();

  // 页面刷新路径：全新客户端订阅即拿到存量补发。补发只保存最新 title，此后 shell 可能
  // 已再次覆盖（如 bash 的 job-done 重绘 prompt），故只断言 title 字段经落库补发存续非空。
  const B = stack.makeClient();
  await B.authSubscribe();
  const replayed = await B.waitFor(
    (m) => m.case === "sessionCheckpoint" && m.sessionId === sessionId,
    "checkpoint replay on subscribe",
  );
  assert.notEqual(replayed.title, "", "订阅补发的 checkpoint 带非空 title");
  B.close();
});
