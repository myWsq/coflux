import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { DeviceClient, utf8 } from "./device-harness.mjs";
const PORT = 8873;
let stack, repo;
before(async () => {
  repo = mkRepo();
  const executable = join(repo.dir, "fake codex's.sh");
  writeFileSync(
    executable,
    `#!/bin/sh
[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || { echo CODEX_NOT_TTY; exit 91; }
printf X >> "$PWD/starts"
printf 'CODEX_READY:%s\\n%s\\n%s\\n' "$$" "$PWD" "$COFLUX_WORKSPACE_ID"
while IFS= read -r line; do
  [ "$line" = /quit ] && exit 23
  printf 'CODEX_REPLY:%s\\n' "$line"
done
`,
    { mode: 0o700 },
  );
  stack = await startStack({
    port: PORT,
    daemonEnv: { COFLUX_CODEX_BIN: executable },
  });
});
after(async () => {
  await stack?.stop();
  repo?.cleanup();
});
function output(device, from = 0) {
  return device.log
    .slice(from)
    .filter((m) => m.case === "ptyOutput")
    .map((m) => utf8(m.data))
    .join("");
}
async function start(device, task) {
  device.control.send({
    case: "taskStart",
    taskId: task.id,
    cols: 90,
    rows: 30,
  });
  const operation = await device.waitPrepared("sessionCreate");
  device.executePrepared(operation);
  const running = await device.control.waitFor(
    (m) =>
      m.case === "taskUpdated" &&
      m.task.id === task.id &&
      m.task.status === TaskStatus.RUNNING &&
      m.task.sessionId !== task.sessionId,
    "running",
  );
  return { task: running.task, operation };
}
test("Codex 普通终端：真实 TTY、幂等创建、输入、重连、worker 热重启与退出重开", async () => {
  const device = await DeviceClient.pair(stack);
  await device.openRelay();
  try {
    device.control.send({
      case: "projectImport",
      daemonId: stack.daemonId,
      path: repo.dir,
    });
    device.executePrepared(await device.waitPrepared("projectValidate"));
    const ws = (
      await device.control.waitFor(
        (m) => m.case === "workspaceCreated" && m.workspace.isMain,
        "workspace",
      )
    ).workspace;
    device.control.send({
      case: "taskCreate",
      workspaceId: ws.id,
      title: "Codex test",
      launcher: "codex",
    });
    const idle = (
      await device.control.waitFor(
        (m) => m.case === "taskUpdated" && m.task.title === "Codex test",
        "task",
      )
    ).task;
    assert.equal(idle.launcher, "codex");
    let { task, operation } = await start(device, idle);
    await sleep(150);
    const attached = await device.attach(task.sessionId);
    const initial = utf8(attached.ansiSnapshot);
    await device.waitFor(() => (initial + output(device)).includes("CODEX_READY"), "Codex 启动并持有 TTY");
    assert.ok((initial + output(device)).includes(ws.id));
    assert.ok((initial + output(device)).includes(repo.dir));
    device.executePrepared(operation);
    await sleep(100);
    assert.equal(
      readFileSync(join(repo.dir, "starts"), "utf8"),
      "X",
      "prepared 重投不重复运行 Codex",
    );
    let from = device.mark();
    await device.input(task.sessionId, "hello\r");
    await device.waitFor(
      () => output(device, from).includes("CODEX_REPLY:hello"),
      "输入回复",
    );
    device.closeTransport(true);
    await device.openRelay();
    const reattached = await device.attach(task.sessionId);
    assert.match(utf8(reattached.ansiSnapshot), /CODEX_REPLY:hello/);
    const workerPid = Number(
      readFileSync(join(stack.home, "worker.pid"), "utf8"),
    );
    process.kill(workerPid, "SIGKILL");
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      try {
        if (
          Number(readFileSync(join(stack.home, "worker.pid"), "utf8")) !==
          workerPid
        )
          break;
      } catch {}
    }
    await stack.waitDaemonOnline();
    await device.openRelay();
    await device.attach(task.sessionId);
    from = device.mark();
    await device.input(task.sessionId, "after-restart\r");
    await device.waitFor(
      () => output(device, from).includes("CODEX_REPLY:after-restart"),
      "重启后回复",
    );
    assert.equal(readFileSync(join(repo.dir, "starts"), "utf8"), "X");
    await device.input(task.sessionId, "/quit\r");
    const exited = (
      await device.control.waitFor(
        (m) =>
          m.case === "taskUpdated" &&
          m.task.id === task.id &&
          m.task.status === TaskStatus.EXITED,
        "exited",
      )
    ).task;
    assert.equal(exited.exitCode, 23);
    assert.equal(exited.launcher, "codex");
    ({ task } = await start(device, task));
    const reopened = await device.attach(task.sessionId);
    await device.waitFor(() => readFileSync(join(repo.dir, "starts"), "utf8") === "XX", "Codex 重开");
    assert.equal(
      readFileSync(join(repo.dir, "starts"), "utf8"),
      "XX",
      "重开仍使用 Codex launcher",
    );
    await device.stopSession(task.sessionId);
    const mark = device.control.log.length;
    device.control.send({
      case: "taskCreate",
      workspaceId: ws.id,
      title: "bad-launcher",
      launcher: "arbitrary shell",
    });
    const denied = await device.control.waitFor(
      (m) => m.case === "error" && m.message.includes("启动程序"),
      "未知 launcher 被拒",
      10000,
      mark,
    );
    assert.ok(denied);
  } finally {
    device.close();
  }
});
