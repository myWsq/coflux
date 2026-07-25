import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

const PORT = 8823;
let stack;
const repos = [];

before(async () => { stack = await startStack({ port: PORT }); });
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("sessiond holder handoff：第二个 Device client 接管，原控制端被拒且不再收输出", async () => {
  const repo = mkRepo();
  repos.push(repo);

  const A = await openRelayDevice(stack);
  const control = A.control;
  control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "h" });
  const idle = await control.waitFor((m) => m.case === "taskUpdated" && m.task.title === "h", "idle");
  const taskId = idle.task.id;
  control.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await control.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sess = run.task.sessionId;
  await A.attach(sess);
  let from = A.mark();
  await A.input(sess, "echo AAA\r");
  await A.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AAA"), "A sees AAA", 10000, from);
  await sleep(200);

  // B 接管
  const B = await openRelayDevice(stack);
  from = A.mark();
  const attached = await B.attach(sess);
  assert.ok(utf8(attached.ansiSnapshot ?? new Uint8Array()).includes("AAA"), "B snapshot 包含接管前输出");
  await A.waitFor((m) => m.case === "sessionDetached" && m.sessionId === sess, "A detached", 10000, from);

  // A 输入被拒
  const rejectedFrom = A.mark();
  const rejectedRequestId = randomUUID();
  A.send("ptyInput", {
    requestId: rejectedRequestId,
    sessionId: sess,
    holderEpoch: A.sessionControls.get(sess).holderEpoch,
    inputSeq: 2n,
    data: new TextEncoder().encode("echo A_FAIL\r"),
  });
  const rejected = await A.waitFor(
    (m) => m.case === "error" && m.requestId === rejectedRequestId,
    "A input rejected",
    10000,
    rejectedFrom,
  );
  assert.match(rejected.code, /stale_holder|stale_transport/);

  // B 正常输入；A 收不到后续输出
  const aAfterDetached = A.mark();
  from = B.mark();
  await B.input(sess, "echo BBB\r");
  await B.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("BBB"), "B sees BBB", 10000, from);
  await sleep(400);
  assert.ok(!A.log.slice(aAfterDetached).some((m) => m.case === "ptyOutput" && utf8(m.data).includes("BBB")), "A 收不到 B 的后续输出");
  assert.ok(!B.log.some((m) => m.case === "ptyOutput" && utf8(m.data).includes("A_FAIL")), "被拒输入未进入 PTY");

  A.close();
  B.close();
});
