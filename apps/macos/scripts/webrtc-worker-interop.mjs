import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DeviceClient } from "../../../tests/src/device-harness.mjs";
import { mkRepo, startStack } from "../../../tests/src/harness.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const TIMEOUT_MS = 8 * 60 * 1000;

function marker(directory, name) {
  return join(directory, name);
}

async function pingRelay(device, label) {
  const requestId = `${label}-${randomUUID()}`;
  const result = await device.request("ping", "pong", { requestId }, { timeout: 10000 });
  if (result.requestId !== requestId || result.transport !== "relay") {
    throw new Error(`${label}: relay DevicePing 没有经原 relay 返回`);
  }
}

async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配 loopback 测试端口");
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

function hostArchitecture() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  throw new Error(`不支持的 macOS host architecture：${process.arch}`);
}

function runXcodebuild(configPath) {
  const child = spawn(
    "xcodebuild",
    [
      "test",
      "-project", "apps/macos/Coflux.xcodeproj",
      "-scheme", "Coflux",
      "-destination", `platform=macOS,arch=${hostArchitecture()}`,
      "-only-testing:CofluxTests/NativeWebRTCWorkerInteropTests",
      `COFLUX_WEBRTC_CONFIG_PATH=${configPath}`,
    ],
    { cwd: ROOT, env: process.env, stdio: "inherit", detached: true },
  );
  child.cofluxProcessGroupId = child.pid;
  return child;
}

function processGroupId(child) {
  const value = child?.cofluxProcessGroupId;
  return Number.isInteger(value) && value > 1 ? value : undefined;
}

function processGroupExists(groupId) {
  if (!groupId) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcessGroup(child, signal) {
  const groupId = processGroupId(child);
  if (!processGroupExists(groupId)) return;
  try {
    process.kill(-groupId, signal);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(signal); } catch { /* 已退出 */ }
    }
  }
}

async function waitForProcessGroupExit(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(groupId) && Date.now() < deadline) await sleep(25);
  return !processGroupExists(groupId);
}

async function stopXcodebuild(child) {
  const groupId = processGroupId(child);
  if (!processGroupExists(groupId)) return true;
  signalProcessGroup(child, "SIGTERM");
  if (!await waitForProcessGroupExit(groupId, 2000)) {
    signalProcessGroup(child, "SIGKILL");
    await waitForProcessGroupExit(groupId, 2000);
  }
  return !processGroupExists(groupId);
}

async function startIsolatedStack(signal) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal.aborted) throw new Error("native WebRTC interop stack 已取消");
    const port = await allocateLoopbackPort();
    try {
      const stack = await startStack({
        port,
        password: randomUUID(),
        signal,
        strictCleanup: true,
        serverEnv: {
          COFLUX_DEV: "1",
          COFLUX_HOST: "127.0.0.1",
          COFLUX_AUTH: "local",
          COFLUX_DAEMON_URL: `ws://127.0.0.1:${port}/daemon`,
          COFLUX_WEB_URL: `http://127.0.0.1:${port}`,
          COFLUX_RELAY_NODES: "",
          COFLUX_STUN_URLS: "",
          COFLUX_P2P_ENABLED: "1",
          COFLUX_AUTOUPDATE_REPO: "",
          COFLUX_BUILD_ID: "",
          COFLUX_BUILD_ID_FILE: "",
        },
      });
      return { port, stack };
    } catch (error) {
      lastError = error;
      if (signal.aborted || error instanceof AggregateError) throw error;
      if (attempt === 3) throw error;
    }
  }
  throw lastError;
}

async function main() {
  let coordinationDirectory;
  let repo;
  let stack;
  let relay;
  let child;
  let interruptedSignal;
  const stackAbortController = new AbortController();
  const onInterrupt = (signal) => {
    interruptedSignal ??= signal;
    stackAbortController.abort();
    signalProcessGroup(child, "SIGTERM");
    relay?.close();
    if (stack) void stack.stop().catch(() => undefined);
  };
  const onSIGINT = () => onInterrupt("SIGINT");
  const onSIGTERM = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSIGINT);
  process.on("SIGTERM", onSIGTERM);
  try {
    coordinationDirectory = mkdtempSync(join(tmpdir(), "coflux-native-webrtc-"));
    repo = mkRepo({ strictCleanup: true });
    const started = await startIsolatedStack(stackAbortController.signal);
    const port = started.port;
    stack = started.stack;
    writeFileSync(join(repo.dir, "README.md"), "# native WebRTC interop\n");
    if (interruptedSignal) throw new Error(`收到 ${interruptedSignal}，停止 native WebRTC interop`);
    const clientInstanceId = randomUUID();
    relay = await DeviceClient.pair(stack, { clientInstanceId });
    await relay.openRelay({ generation: 1n });
    relay.enablePreparedAutoExecution();
    await pingRelay(relay, "relay-before-p2p");

    relay.control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir, name: "native-webrtc-probe" });
    const workspace = await relay.control.waitFor(
      (message) => message.case === "workspaceCreated" && message.workspace.isMain,
      "native WebRTC probe workspace",
      20000,
    );
    await relay.waitWorkspaceReady(workspace.workspace.id, 10000);

    const configPath = marker(coordinationDirectory, "interop-config.json");
    writeFileSync(configPath, `${JSON.stringify({
      controlURL: `ws://127.0.0.1:${port}/client`,
      origin: `http://127.0.0.1:${port}`,
      username: stack.username,
      password: stack.password,
      daemonID: stack.daemonId,
      workspaceID: workspace.workspace.id,
      clientInstanceID: clientInstanceId,
      transportGeneration: 2,
      coordinationDirectory,
      nearMaximumPayloadBytes: 29 * 1024 * 1024,
    })}\n`, { mode: 0o600 });
    child = runXcodebuild(configPath);

    let exited = false;
    let exitCode;
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
      exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? (signal ? 128 : 1);
    });
    const deadline = Date.now() + TIMEOUT_MS;
    let rejectionHandled = false;
    let promotionHandled = false;
    let serverStopped = false;
    while (!exited && Date.now() < deadline) {
      if (interruptedSignal) break;
      if (!rejectionHandled && existsSync(marker(coordinationDirectory, "p2p-rejected"))) {
        await pingRelay(relay, "relay-after-p2p-rejection");
        writeFileSync(marker(coordinationDirectory, "relay-after-rejection"), "ok\n");
        rejectionHandled = true;
      }
      if (!promotionHandled && existsSync(marker(coordinationDirectory, "p2p-open"))) {
        await pingRelay(relay, "relay-while-p2p-open");
        writeFileSync(marker(coordinationDirectory, "relay-during-p2p"), "ok\n");
        promotionHandled = true;
      }
      if (!serverStopped && existsSync(marker(coordinationDirectory, "stop-server"))) {
        await stack.stopServer();
        writeFileSync(marker(coordinationDirectory, "server-stopped"), "ok\n");
        serverStopped = true;
      }
      await sleep(25);
    }

    if (interruptedSignal) {
      await stopXcodebuild(child);
      throw new Error(`收到 ${interruptedSignal}，已清理 native WebRTC interop`);
    }
    if (!exited) {
      await stopXcodebuild(child);
      throw new Error("native WebRTC interop 超过 8 分钟");
    }
    if (spawnError) throw new Error(`无法启动 xcodebuild：${spawnError.message}`);
    if (exitCode !== 0) throw new Error(`xcodebuild interop 失败，exit=${exitCode}`);
    if (!rejectionHandled || !promotionHandled || !serverStopped) {
      throw new Error(`interop marker 不完整：rejection=${rejectionHandled} promotion=${promotionHandled} stop=${serverStopped}`);
    }
  } catch (error) {
    if (interruptedSignal) {
      throw new Error(`收到 ${interruptedSignal}，已清理 native WebRTC interop`, { cause: error });
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    let xcodebuildStopped = false;
    try {
      xcodebuildStopped = await stopXcodebuild(child);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try { relay?.close(); } catch (error) { cleanupErrors.push(error); }
    try { await stack?.stop(); } catch (error) { cleanupErrors.push(error); }
    try { repo?.cleanup(); } catch (error) { cleanupErrors.push(error); }
    if (coordinationDirectory) {
      try { rmSync(coordinationDirectory, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
    process.off("SIGINT", onSIGINT);
    process.off("SIGTERM", onSIGTERM);
    if (!xcodebuildStopped) cleanupErrors.push(new Error("无法清理 xcodebuild/XCTest 进程组"));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "native WebRTC interop 清理不完整");
    }
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
