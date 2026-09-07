import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { DeviceClient, openRelayDevice, utf8 } from "./device-harness.mjs";
import { callTool, consentClient, obtainTokens } from "./oauth-harness.mjs";
import { fileURLToPath } from "node:url";
for (const launcher of ["codex", "claude"]) {
  describe(`${launcher} 原生终端`, () => {
    const PORT = 8873;
    const BASE = `http://127.0.0.1:${PORT}`;
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
        serverEnv: { COFLUX_PUBLIC_URL: BASE },
        daemonEnv: {
          COFLUX_CODEX_BIN: executable,
          COFLUX_CLAUDE_BIN: executable,
        },
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
    test("Agent 普通终端：真实 TTY、幂等创建、输入、重连、worker 热重启与退出重开", async () => {
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
          launcher,
        });
        const idle = (
          await device.control.waitFor(
            (m) => m.case === "taskUpdated" && m.task.title === "Codex test",
            "task",
          )
        ).task;
        assert.equal(idle.launcher, launcher);
        let { task, operation } = await start(device, idle);
        await sleep(150);
        const attached = await device.attach(task.sessionId);
        const initial = utf8(attached.ansiSnapshot);
        await device.waitFor(
          () => (initial + output(device)).includes("CODEX_READY"),
          "Codex 启动并持有 TTY",
        );
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
        assert.equal(exited.launcher, launcher);
        ({ task } = await start(device, task));
        const reopened = await device.attach(task.sessionId);
        await device.waitFor(
          () => readFileSync(join(repo.dir, "starts"), "utf8") === "XX",
          "Codex 重开",
        );
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

    // 两条原有职责分别验收：MCP 发起账号范围编排；CLI 在已有 PTY 中继承本工作区身份。
    async function workspaceFor(device) {
      const snapshot = device.control.log.find(
        (m) => m.case === "stateSnapshot",
      );
      const found = snapshot.workspaces.find((w) => w.path === repo.dir);
      if (found) return found;
      device.control.send({
        case: "projectImport",
        daemonId: stack.daemonId,
        path: repo.dir,
      });
      return (
        await device.control.waitFor(
          (m) => m.case === "workspaceCreated" && m.workspace.isMain,
          "workspace",
        )
      ).workspace;
    }

    test("MCP 创建 Agent：保持 TTY，复用 read/send/stop，拒绝 command 混用", async () => {
      const consent = await consentClient(stack);
      const device = await openRelayDevice(stack);
      try {
        const token = (await obtainTokens(BASE, consent)).access_token;
        const ws = await workspaceFor(device);
        const invoke = async (name, args) => {
          const { result } = await callTool(BASE, token, name, args);
          assert.ok(result && !result.isError, JSON.stringify(result));
          return result.structuredContent;
        };
        const { terminal } = await invoke("create_terminal", {
          workspaceId: ws.id,
          launcher,
          title: "MCP Codex",
        });
        assert.equal(terminal.launcher, launcher);
        let read;
        for (let i = 0; i < 60; i++) {
          read = await invoke("read_terminal", { terminalId: terminal.id });
          if (read.text.includes("CODEX_READY")) break;
          await sleep(100);
        }
        assert.ok(read.text.includes("CODEX_READY"), JSON.stringify(read));
        assert.notEqual(read.source, "log", "交互程序不能通过日志管道运行");
        await invoke("send_terminal_input", {
          terminalId: terminal.id,
          text: "mcp-input",
          enter: true,
        });
        for (let i = 0; i < 60; i++) {
          read = await invoke("read_terminal", { terminalId: terminal.id });
          if (read.text.includes("CODEX_REPLY:mcp-input")) break;
          await sleep(100);
        }
        assert.ok(
          read.text.includes("CODEX_REPLY:mcp-input"),
          JSON.stringify(read),
        );
        await invoke("stop_terminal", { terminalId: terminal.id });
        const mixed = await callTool(BASE, token, "create_terminal", {
          workspaceId: ws.id,
          launcher,
          command: "echo forbidden",
        });
        assert.equal(mixed.result.isError, true);
        assert.match(mixed.result.content[0].text, /不能同时使用/);
      } finally {
        device.close();
        consent.close();
      }
    });

    test("本地 CLI 创建 Agent：从调用进程继承工作区并保存 launcher", async () => {
      const device = await openRelayDevice(stack);
      try {
        const ws = await workspaceFor(device);
        device.control.send({
          case: "taskCreate",
          workspaceId: ws.id,
          title: "CLI origin",
        });
        const idle = (
          await device.control.waitFor(
            (m) => m.case === "taskUpdated" && m.task.title === "CLI origin",
            "CLI origin",
          )
        ).task;
        device.control.send({
          case: "taskStart",
          taskId: idle.id,
          cols: 100,
          rows: 30,
        });
        const origin = (
          await device.control.waitFor(
            (m) =>
              m.case === "taskUpdated" &&
              m.task.id === idle.id &&
              m.task.status === TaskStatus.RUNNING,
            "origin running",
          )
        ).task;
        await device.attach(origin.sessionId);
        const cli = fileURLToPath(
          new URL("../../packages/cli/cofluxd.mjs", import.meta.url),
        );
        const out = join(repo.dir, "cli-new.txt");
        await device.input(
          origin.sessionId,
          `COFLUX_LOCAL_GATEWAY_PORT=${device.gateway.port} node '${cli}' terminal new --launcher ${launcher} --title 'CLI Codex' > '${out}' 2>&1\r`,
        );
        const codex = (
          await device.control.waitFor(
            (m) =>
              m.case === "taskUpdated" &&
              m.task.title === "CLI Codex" &&
              m.task.status === TaskStatus.RUNNING,
            "CLI Codex running",
          )
        ).task;
        assert.equal(codex.workspaceId, ws.id);
        assert.equal(codex.launcher, launcher);
        const initial = await device.attach(codex.sessionId);
        await device.waitFor(
          () =>
            (utf8(initial.ansiSnapshot) + output(device)).includes(
              "CODEX_READY",
            ),
          "CLI TTY ready",
        );
        await device.input(codex.sessionId, "cli-input\r");
        await device.waitFor(
          () => output(device).includes("CODEX_REPLY:cli-input"),
          "CLI input",
        );
        assert.match(readFileSync(out, "utf8"), /已开终端/);
        await device.stopSession(codex.sessionId);
        await device.stopSession(origin.sessionId);
      } finally {
        device.close();
      }
    });
  });
}
