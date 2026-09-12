/**
 * executor：没有已登记的桌面 host 时，提交必须**立刻**失败。
 *
 * 这条守的是 executor 通路上 daemon 独自负责的那一半——不需要桌面 app 在场也能验：
 * agent 在 coflux 终端里发起 `coflux executor run`，本机没有任何 Coflux.app 注册成 executor host，
 * 于是 daemon 在提交那一刻就拒，CLI 非零退出并打出一句指向桌面 app 的可读中文。
 *
 * 为什么这条重要：提交半程唯一的失败模式如果是「挂着轮询到超时」，agent 会白等 30 分钟才知道
 * 本机根本没装/没开桌面 app。**立刻拒 + 一句人能照做的话**是产品承诺的一部分（见 plan 的验收）。
 *
 * 两版 CLI 都跑：Rust 版（coflux 终端里 PATH 命中的那个）与 npm node 版，请求体、文案与退出码
 * 逐命令对齐，这里一并钉住。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, CLI_BIN } from "./harness.mjs";
import { openNativeDevice } from "./device-harness.mjs";

const PORT = 8876;
const COFLUX_MJS = fileURLToPath(new URL("../../packages/cli/coflux.mjs", import.meta.url));
const NODE_LAUNCHER = `node ${COFLUX_MJS}`;
const RUST_LAUNCHER = CLI_BIN;
/** 「立刻」的判据：提交被拒不该经过任何一轮轮询（轮询间隔 2 秒），给足 PTY 与进程启动的余量。 */
const IMMEDIATE_MS = 15000;

let stack;
const dirs = [];

function mkDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coflux-executor-")));
  dirs.push(dir);
  return dir;
}

/** terminalCreate → 目录工作区 + 任务 → taskStart，返回 { ws, task }（task 已 RUNNING）。 */
async function startDirTerminal(c, home) {
  c.send({ case: "terminalCreate", daemonId: stack.daemonId, path: home });
  const ws = await c.waitFor((m) => m.case === "workspaceCreated" && m.workspace.path === home, "dir ws");
  const idle = await c.waitFor((m) => m.case === "taskUpdated" && m.task.workspaceId === ws.workspace.id, "task co-created");
  c.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  const run = await c.waitFor(
    (m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING,
    "task running",
  );
  return { ws: ws.workspace, task: run.task };
}

async function waitForFile(path, predicate, label, timeout) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      last = readFileSync(path, "utf8");
      if (predicate(last)) return last;
    }
    await sleep(200);
  }
  throw new Error(`${label} 超时；最后内容: ${JSON.stringify(last)}`);
}

let cliSeq = 0;

/** 在会话里跑一条 coflux 命令，输出与退出码一起落文件——退出码是本用例的核心断言之一。 */
async function runCli(device, sessionId, gatewayPort, home, args, label, launcher) {
  const out = join(home, `cli-${(cliSeq += 1)}.txt`);
  await device.input(
    sessionId,
    `COFLUX_LOCAL_GATEWAY_PORT=${gatewayPort} ${launcher} ${args} > ${out} 2>&1; echo "exit=$?" >> ${out}\r`,
  );
  const text = await waitForFile(out, (s) => /^exit=\d+\s*$/m.test(s), label, IMMEDIATE_MS);
  const exit = Number(/^exit=(\d+)\s*$/m.exec(text)[1]);
  return { text: text.replace(/^exit=\d+\s*$/m, "").trimEnd(), exit };
}

async function removeWorkspace(c, workspaceId) {
  c.send({ case: "workspaceRemove", workspaceId });
  await c.waitFor((m) => m.case === "workspaceRemoved" && m.workspaceId === workspaceId, "cleanup ws removed");
}

before(async () => {
  stack = await startStack({ port: PORT });
});
after(async () => {
  await stack?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("没有桌面 executor host 时，executor run 立刻非零退出并指向 Coflux.app（两版 CLI 一致）", async () => {
  const home = mkDir();
  const device = await openNativeDevice(stack);
  const c = device.control;
  const { ws, task } = await startDirTerminal(c, home);
  const gatewayPort = device.gateway.port;
  await device.attach(task.sessionId);

  try {
    for (const [name, launcher] of [
      ["rust", RUST_LAUNCHER],
      ["node", NODE_LAUNCHER],
    ]) {
      const started = Date.now();
      const { text, exit } = await runCli(
        device,
        task.sessionId,
        gatewayPort,
        home,
        `executor run --prompt="把 crates/worker 的 clippy 警告清掉" --write`,
        `${name} 版 executor run 的输出`,
        launcher,
      );
      // 非零退出：agent 全靠退出码判断成败，拒绝绝不能走成功路径
      assert.notEqual(exit, 0, `${name}: 提交被拒必须非零退出，实际 ${exit}；输出 ${JSON.stringify(text)}`);
      // 一句人能照做的话：说清是桌面 app 在执行、要去开它
      assert.match(text, /Coflux\.app/, `${name}: 错误必须指向桌面 app；实际 ${JSON.stringify(text)}`);
      // 「立刻」：绝不能走成挂起轮询到超时
      assert.ok(
        Date.now() - started < IMMEDIATE_MS,
        `${name}: 提交被拒必须立刻返回，实际耗时 ${Date.now() - started}ms`,
      );
      // 成功路径的字样一个都不该出现
      assert.ok(!text.includes("# succeeded"), `${name}: 不该打出成功终态；实际 ${JSON.stringify(text)}`);
    }

    // 缺 --prompt 是参数错误，在 CLI 侧就拒，连 daemon 都不打扰
    const missing = await runCli(
      device,
      task.sessionId,
      gatewayPort,
      home,
      "executor run",
      "缺 prompt 的输出",
      RUST_LAUNCHER,
    );
    assert.notEqual(missing.exit, 0, `缺 --prompt 必须非零退出；输出 ${JSON.stringify(missing.text)}`);
    assert.match(missing.text, /--prompt/, `缺 --prompt 的报错要点名这个选项；实际 ${JSON.stringify(missing.text)}`);

    // 子命令只有 run
    const bad = await runCli(
      device,
      task.sessionId,
      gatewayPort,
      home,
      "executor list",
      "未知子命令的输出",
      RUST_LAUNCHER,
    );
    assert.notEqual(bad.exit, 0, `未知子命令必须非零退出；输出 ${JSON.stringify(bad.text)}`);
    assert.match(bad.text, /coflux executor run/, `未知子命令要给出正确写法；实际 ${JSON.stringify(bad.text)}`);
  } finally {
    await removeWorkspace(c, ws.id);
    device.close();
  }
});


test("native session authority cannot register or report as the local executor host", async () => {
  const device = await openNativeDevice(stack);
  try {
    for (const [payload, value] of [
      ["executorHostRegister", { hostId: "remote-host", hostEpoch: 1n, capabilities: [], ready: true, notReadyReason: "" }],
      ["executorReport", { runId: "remote-run", state: 1, note: "", changedFiles: [], reportedAt: Date.now() }],
    ]) {
      const from = device.mark();
      device.send(payload, value);
      const denied = await device.waitFor(message => message.case === "error", "remote executor denial", 10000, from);
      assert.equal(denied.code, "executor_host_denied", "session scope alone cannot establish loopback identity");
      assert.match(denied.message, /loopback/);
    }
    assert(Array.isArray((await device.catalog()).sessions), "denial does not break the native session lane");
  } finally { device.close(); }
});
