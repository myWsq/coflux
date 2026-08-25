import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { startStack } from "../../../tests/src/harness.mjs";
import {
  auditSignedApp,
  ensureCodeSigningIdentity,
  signingBuildSettings,
} from "./macos-signing-audit.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const PHASE_TIMEOUT_MS = 3 * 60 * 1000;
const ORIGIN = "https://app.coflux.dev";
const WRONG_ORIGIN = "https://wrong-origin.coflux.dev";
const DEVELOPMENT_TEAM = process.env.COFLUX_MACOS_DEVELOPMENT_TEAM || "8Y2J55823C";
const SIGNING_IDENTITY = process.env.COFLUX_MACOS_SIGNING_IDENTITY || "Apple Development";

const variants = [
  { name: "hardened", sandbox: false, networkClient: false },
  { name: "sandbox-network-client", sandbox: true, networkClient: true },
];

function hostArchitecture() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  throw new Error(`不支持的 macOS host architecture：${process.arch}`);
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

async function assertServerHealthy(port, label) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${label}：server health 返回 HTTP ${response.status}`);
  await response.body?.cancel();
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
    await waitForProcessGroupExit(groupId, 3000);
  }
  return !processGroupExists(groupId);
}

function encodeConfiguration(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function parseSentinel(output, sentinel, label) {
  const prefix = `${sentinel} `;
  const matches = output.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`${label} sentinel 数量应为 1，实际为 ${matches.length}`);
  }
  try {
    return JSON.parse(Buffer.from(matches[0].slice(prefix.length), "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`${label} sentinel 不是合法 base64 JSON`, { cause: error });
  }
}

function buildSettings(variant) {
  return signingBuildSettings({
    team: DEVELOPMENT_TEAM,
    identity: SIGNING_IDENTITY,
    sandbox: variant.sandbox,
    networkClient: variant.networkClient,
    networkServer: false,
  });
}

function spawnXcodebuild(configuration, derivedDataPath, variant) {
  const child = spawn(
    "xcodebuild",
    [
      "test",
      "-project", "apps/macos/Coflux.xcodeproj",
      "-scheme", "Coflux",
      "-destination", `platform=macOS,arch=${hostArchitecture()}`,
      "-derivedDataPath", derivedDataPath,
      "-only-testing:CofluxTests/NativeLoopbackAuthInteropTests",
      ...buildSettings(variant),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        COFLUX_LOOPBACK_CONFIG_BASE64: encodeConfiguration(configuration),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child.cofluxProcessGroupId = child.pid;
  return child;
}

async function runPhase({ configuration, derivedDataPath, variant, setCurrentChild }) {
  const child = spawnXcodebuild(configuration, derivedDataPath, variant);
  setCurrentChild(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    if (process.env.COFLUX_TEST_DEBUG) process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    if (process.env.COFLUX_TEST_DEBUG) process.stderr.write(text);
  });
  let spawnError;
  const exit = new Promise((resolveExit) => {
    child.once("error", (error) => {
      spawnError = error;
      resolveExit(1);
    });
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
  });
  const timeout = sleep(PHASE_TIMEOUT_MS, "timeout", { ref: false });
  const result = await Promise.race([exit, timeout]);
  if (result === "timeout") {
    await stopXcodebuild(child);
    throw new Error(`${variant.name} native loopback phase 超过 3 分钟`);
  }
  const stopped = await stopXcodebuild(child);
  if (!stopped) throw new Error(`${variant.name} xcodebuild/XCTest 进程组清理失败`);
  setCurrentChild(undefined);
  if (spawnError) throw new Error(`无法启动 xcodebuild：${spawnError.message}`);
  if (result !== 0) {
    if (!process.env.COFLUX_TEST_DEBUG) {
      if (stdout) process.stdout.write(stdout.slice(-40_000));
      if (stderr) process.stderr.write(stderr.slice(-40_000));
    }
    throw new Error(`${variant.name} native loopback phase 失败，exit=${result}`);
  }
  return `${stdout}\n${stderr}`;
}

function auditSignedProduct(derivedDataPath, variant) {
  return auditSignedApp({
    derivedDataPath,
    variant,
    team: DEVELOPMENT_TEAM,
    identity: SIGNING_IDENTITY,
  });
}

async function startIsolatedStack(signal) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal.aborted) throw new Error("native loopback auth stack 已取消");
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
          COFLUX_WEB_URL: ORIGIN,
          COFLUX_LOCAL_LEASE_TTL_MS: "10000",
          COFLUX_P2P_ENABLED: "0",
          COFLUX_STUN_URLS: "",
          COFLUX_AUTOUPDATE_REPO: "",
          COFLUX_BUILD_ID: "",
          COFLUX_BUILD_ID_FILE: "",
        },
      });
      return { port, stack };
    } catch (error) {
      lastError = error;
      if (signal.aborted || error instanceof AggregateError || attempt === 3) throw error;
    }
  }
  throw lastError;
}

function phaseConfiguration({ phase, port, stack, service, state }) {
  const configuration = {
    phase,
    controlURL: `ws://127.0.0.1:${port}/client`,
    origin: ORIGIN,
    wrongOrigin: WRONG_ORIGIN,
    username: stack.username,
    password: stack.password,
    daemonID: stack.daemonId,
    clientInstanceID: `native-${randomUUID()}`,
    identityService: service,
    identityAccount: "p256-signing-key",
  };
  if (state) configuration.state = state;
  return configuration;
}

async function runVariant({
  variant,
  buildDirectory,
  port,
  stack,
  setCurrentChild,
  cleanupTargets,
}) {
  const service = `dev.coflux.macos.loopback-probe.${variant.name}.${randomUUID()}`;
  const derivedDataPath = join(buildDirectory, `DerivedData-${variant.name}`);
  const target = { variant, service, derivedDataPath };
  cleanupTargets.push(target);

  const bootstrapOutput = await runPhase({
    configuration: phaseConfiguration({ phase: "bootstrap", port, stack, service }),
    derivedDataPath,
    variant,
    setCurrentChild,
  });
  const state = parseSentinel(bootstrapOutput, "COFLUX_LOOPBACK_STATE", `${variant.name} phase A state`);
  if (!state.phaseAComplete || !state.controlOriginObserved || !state.loopbackOriginObserved || !state.gatewaySignatureVerified) {
    throw new Error(`${variant.name} phase A Origin/signature marker 不完整`);
  }

  const restartOutput = await runPhase({
    configuration: phaseConfiguration({ phase: "restart", port, stack, service, state }),
    derivedDataPath,
    variant,
    setCurrentChild,
  });
  const result = parseSentinel(restartOutput, "COFLUX_LOOPBACK_RESULT", `${variant.name} phase B result`);
  for (const key of ["restart", "grantReused", "keyMismatchRecovered", "leaseExpired", "grantRevoked"]) {
    if (result[key] !== true) throw new Error(`${variant.name} phase B 缺少 ${key} marker`);
  }

  return auditSignedProduct(derivedDataPath, variant);
}

async function cleanupIdentity({ target, port, stack, setCurrentChild }) {
  const output = await runPhase({
    configuration: phaseConfiguration({
      phase: "cleanup",
      port,
      stack,
      service: target.service,
    }),
    derivedDataPath: target.derivedDataPath,
    variant: target.variant,
    setCurrentChild,
  });
  const marker = parseSentinel(
    output,
    "COFLUX_LOOPBACK_RESULT",
    `${target.variant.name} Keychain cleanup marker`,
  );
  if (marker.cleanup !== true) throw new Error(`${target.variant.name} Keychain cleanup 未确认`);
}

async function main() {
  ensureCodeSigningIdentity(SIGNING_IDENTITY);
  let directory;
  let stack;
  let port;
  let currentChild;
  let interruptedSignal;
  let primaryError;
  const cleanupTargets = [];
  const matrix = {};
  const stackAbortController = new AbortController();
  const setCurrentChild = (child) => { currentChild = child; };
  const onInterrupt = (signal) => {
    interruptedSignal ??= signal;
    stackAbortController.abort();
    signalProcessGroup(currentChild, "SIGTERM");
    if (stack) void stack.stop().catch(() => undefined);
  };
  const onSIGINT = () => onInterrupt("SIGINT");
  const onSIGTERM = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSIGINT);
  process.on("SIGTERM", onSIGTERM);

  try {
    directory = mkdtempSync(join(tmpdir(), "coflux-native-loopback-"));
    const started = await startIsolatedStack(stackAbortController.signal);
    port = started.port;
    stack = started.stack;
    for (const variant of variants) {
      if (interruptedSignal) throw new Error(`收到 ${interruptedSignal}`);
      matrix[variant.name] = await runVariant({
        variant,
        buildDirectory: directory,
        port,
        stack,
        setCurrentChild,
        cleanupTargets,
      });
    }

    const deniedVariant = { name: "sandbox-no-network-client", sandbox: true, networkClient: false };
    const deniedDerivedData = join(directory, "DerivedData-sandbox-denied");
    await assertServerHealthy(port, "sandbox 负向门之前");
    const deniedOutput = await runPhase({
      configuration: phaseConfiguration({
        phase: "networkDenied",
        port,
        stack,
        service: `dev.coflux.macos.denied.${randomUUID()}`,
      }),
      derivedDataPath: deniedDerivedData,
      variant: deniedVariant,
      setCurrentChild,
    });
    await assertServerHealthy(port, "sandbox 负向门之后");
    const deniedMarker = parseSentinel(
      deniedOutput,
      "COFLUX_LOOPBACK_RESULT",
      "sandbox deny marker",
    );
    if (
      deniedMarker.networkDenied !== true
      || typeof deniedMarker.errorDomain !== "string"
      || !Number.isInteger(deniedMarker.errorCode)
    ) {
      throw new Error("sandbox 缺少 network.client 的负向门未命中");
    }
    matrix[deniedVariant.name] = {
      ...auditSignedProduct(deniedDerivedData, deniedVariant),
      serverHealthyBeforeAndAfter: true,
      errorDomain: deniedMarker.errorDomain,
      errorCode: deniedMarker.errorCode,
    };
    writeFileSync(join(directory, "permission-matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600 });
    console.log(`COFLUX_LOOPBACK_PERMISSION_MATRIX ${JSON.stringify(matrix)}`);
  } catch (error) {
    primaryError = interruptedSignal
      ? new Error(`收到 ${interruptedSignal}，已清理 native loopback auth interop`, { cause: error })
      : error;
  } finally {
    const cleanupErrors = [];
    try {
      if (!await stopXcodebuild(currentChild)) cleanupErrors.push(new Error("无法清理 xcodebuild/XCTest 进程组"));
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (directory && stack && port) {
      for (const target of cleanupTargets) {
        try { await cleanupIdentity({ target, port, stack, setCurrentChild }); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    try { await stack?.stop(); } catch (error) { cleanupErrors.push(error); }
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
    process.off("SIGINT", onSIGINT);
    process.off("SIGTERM", onSIGTERM);
    if (cleanupErrors.length > 0) {
      if (primaryError) cleanupErrors.unshift(primaryError);
      throw new AggregateError(cleanupErrors, "native loopback auth 清理不完整");
    }
  }
  if (primaryError) throw primaryError;
}

main().catch((error) => {
  const describe = (value, indent = "") => {
    console.error(`${indent}${value?.stack ?? value}`);
    if (value instanceof AggregateError) {
      for (const nested of value.errors) describe(nested, `${indent}  `);
    } else if (value?.cause) {
      describe(value.cause, `${indent}  caused by: `);
    }
  };
  describe(error);
  process.exitCode = 1;
});
