import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startStack, mkRepo, spawnDaemon, authorizeDaemon, killTree, CLI_BIN } from "./harness.mjs";
import { openRelayDevice } from "./device-harness.mjs";

const PORT = 8875;
const ROOT = resolve(import.meta.dirname, "../..");
function cli(kind, home, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(kind === "rust" ? CLI_BIN : process.execPath, kind === "rust" ? args : [join(ROOT, "packages/cli/coflux.mjs"), ...args], {
      env: { ...process.env, COFLUX_HOME: home, COFLUX_TASK_ID: "" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, value: code === 0 ? JSON.parse(stdout) : null }); });
    child.stdin.end(input);
  });
}
async function ok(kind, home, args, input) {
  const result = await cli(kind, home, args, input);
  assert.equal(result.code, 0, result.stderr);
  return result.value;
}

test("两种 CLI 共用账号能力：跨设备/工作区操作、短命令保活与退出撤销", async () => {
  const stack = await startStack({ port: PORT });
  const remoteHome = mkdtempSync(join(tmpdir(), "coflux-cli-device-"));
  const clientHome = mkdtempSync(join(tmpdir(), "coflux-cli-account-"));
  const repo = mkRepo();
  let remote, device;
  try {
    remote = spawnDaemon({ ...process.env, COFLUX_SERVER: `ws://127.0.0.1:${PORT}/daemon`, COFLUX_HOME: remoteHome, COFLUX_DEVICE_NAME: "remote-cli-device", COFLUX_LOCAL_GATEWAY_PORT: "0" });
    await authorizeDaemon(PORT, remoteHome, { username: stack.username, password: stack.password });
    const remoteId = JSON.parse(readFileSync(join(remoteHome, "credentials.json"), "utf8")).daemonId;
    device = await openRelayDevice(stack, { daemonId: remoteId });
    device.control.send({ case: "projectImport", daemonId: remoteId, path: repo.dir });
    const main = await device.control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain && m.workspace.daemonId === remoteId, "remote project");
    for (const kind of ["rust", "node"]) {
      const login = await ok(kind, clientHome, ["login", "--server", `http://127.0.0.1:${PORT}`, "--username", stack.username, "--password-stdin"], stack.password + "\n");
      assert.ok(login.accountId);
      assert.equal(login.token, undefined, "stdout 不应泄露 token");
      const devices = await ok(kind, clientHome, ["device", "list"]);
      assert.ok(devices.some((d) => d.daemonId === remoteId));
      assert.ok(devices.some((d) => d.daemonId === stack.daemonId));
      const workspace = await ok(kind, clientHome, ["workspace", "new", "--project", main.workspace.projectId, "--branch", `cli-${kind}`]);
      assert.equal(workspace.daemonId, remoteId);
      const terminal = await ok(kind, clientHome, ["terminal", "new", "--workspace", workspace.id, "--cmd", "printf 'cli-alive\\n'; sleep 120"]);
      assert.equal(terminal.daemonId, remoteId);
      let output;
      for (let i = 0; i < 40; i++) {
        output = await ok(kind, clientHome, ["terminal", "read", terminal.id, "--remote"]);
        if (output.text.includes("cli-alive")) break;
        await sleep(100);
      }
      assert.match(output.text, /cli-alive/);
      // 桌面正在接管时，CLI 不能越过同一套输入控制规则。
      await device.attach(terminal.sessionId);
      const deniedInput = await cli(kind, clientHome, ["terminal", "send", terminal.id, "--text", "do-not-type", "--remote"]);
      assert.notEqual(deniedInput.code, 0);
      assert.match(deniedInput.stderr, /用户正在接管/);
      device.close();
      device = await openRelayDevice(stack, { daemonId: remoteId });
      const waited = await ok(kind, clientHome, ["terminal", "wait", terminal.id, "--timeout", "0", "--remote"]);
      assert.equal(waited.exited, false, "CLI 进程已退出，任务仍应运行");
      await ok(kind, clientHome, ["terminal", "stop", terminal.id, "--remote"]);
      await ok(kind, clientHome, ["terminal", "remove", terminal.id, "--remote"]);
      await ok(kind, clientHome, ["workspace", "remove", workspace.id]);
      const saved = JSON.parse(readFileSync(join(clientHome, "cli-session.json"), "utf8"));
      await ok(kind, clientHome, ["logout"]);
      const denied = await fetch(`http://127.0.0.1:${PORT}/api/client/command`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${saved.token}` }, body: JSON.stringify({ protocolVersion: 1, command: { op: "snapshot" } }) });
      assert.equal(denied.status, 401);
    }
  } finally {
    device?.close();
    if (remote) killTree(remote);
    await stack.stop();
    repo.cleanup();
    rmSync(remoteHome, { recursive: true, force: true });
    rmSync(clientHome, { recursive: true, force: true });
  }
});

// 入口拒绝越权职责时必须在触碰服务、凭据或网络之前失败。
test("coflux/cofluxd 职责分离：错误入口不执行旧命令，也不修改本机状态", async () => {
  const home = mkdtempSync(join(tmpdir(), "coflux-cli-boundary-"));
  try {
    const { spawnSync } = await import("node:child_process");
    const { readdirSync } = await import("node:fs");
    const env = { ...process.env, COFLUX_HOME: home };
    for (const command of ["login", "terminal", "workspace", "hook"]) {
      const result = spawnSync(process.execPath, [join(ROOT, "packages/cli/cofluxd.mjs"), command], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /登录与终端操作请使用 coflux/);
    }
    for (const command of ["up", "down", "update", "restart", "uninstall"]) {
      for (const kind of ["rust", "node"]) {
        const result = await cli(kind, home, [command]);
        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stderr, /Coflux\.app 或 cofluxd/);
      }
    }
    assert.deepEqual(readdirSync(home), [], "错误入口不应落凭据或启动宿主");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
