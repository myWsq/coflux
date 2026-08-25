#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection, createServer, isIP } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { auditSignedApp } from "./macos-signing-audit.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const PEER_PROTOCOL_VERSION = "coflux-local-network-tcc-peer-v1";
const COORDINATOR_PROTOCOL_VERSION = "coflux-local-network-tcc-coordinator-v1";
const MAX_LINE_BYTES = 65_536;
const DEFAULT_INTERACTION_TIMEOUT_MINUTES = 15;

const VARIANTS = [
  {
    decision: "allow",
    binaryTag: "allow-probe-v1",
    scheme: "CofluxLocalNetworkAllowProbe",
    productName: "CofluxTCCAllowProbe",
    displayName: "Coflux Local Network Allow Probe",
  },
  {
    decision: "deny",
    binaryTag: "deny-probe-v1",
    scheme: "CofluxLocalNetworkDenyProbe",
    productName: "CofluxTCCDenyProbe",
    displayName: "Coflux Local Network Deny Probe",
  },
];

function usage() {
  return [
    "只构建并审计两个从未启动的签名 app：",
    "  node apps/macos/scripts/local-network-tcc-acceptance.mjs --build-only",
    "",
    "在当前 Mac 做一次性人工验收：",
    "  node apps/macos/scripts/local-network-tcc-acceptance.mjs --acceptance \\",
    "    --peer-host 192.168.1.23 --peer-port 49152 --context fresh-bundle",
    "",
    "--context 必须是 fresh-bundle、new-user 或 vm-snapshot。只有后两者可称 clean-user 证据。",
    "peer 必须是第二台同一物理 Wi-Fi/Ethernet LAN 上运行 local-network-tcc-peer.mjs 的受控主机。",
    "脚本只在 Finder 中定位 app；必须由人双击启动、人工选择系统 Allow/Don’t Allow，并在 app 内验证。",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    mode: undefined,
    context: "fresh-bundle",
    interactionTimeoutMinutes: DEFAULT_INTERACTION_TIMEOUT_MINUTES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--build-only") options.mode = options.mode ? "conflict" : "build-only";
    else if (argument === "--acceptance") options.mode = options.mode ? "conflict" : "acceptance";
    else if (argument === "--peer-host") options.peerHost = argv[++index];
    else if (argument === "--peer-port") options.peerPort = Number(argv[++index]);
    else if (argument === "--context") options.context = argv[++index];
    else if (argument === "--interaction-timeout-minutes") {
      options.interactionTimeoutMinutes = Number(argv[++index]);
    } else if (argument === "--help") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  if (options.help) return options;
  if (options.mode !== "build-only" && options.mode !== "acceptance") {
    throw new Error("必须且只能指定 --build-only 或 --acceptance");
  }
  if (!new Set(["fresh-bundle", "new-user", "vm-snapshot"]).has(options.context)) {
    throw new Error("--context 必须是 fresh-bundle、new-user 或 vm-snapshot");
  }
  if (
    !Number.isFinite(options.interactionTimeoutMinutes)
    || options.interactionTimeoutMinutes < 1
    || options.interactionTimeoutMinutes > 60
  ) {
    throw new Error("--interaction-timeout-minutes 必须是 1–60");
  }
  if (options.mode === "acceptance") {
    if (typeof options.peerHost !== "string" || options.peerHost.length === 0) {
      throw new Error("--acceptance 必须提供 --peer-host");
    }
    if (!Number.isInteger(options.peerPort) || options.peerPort < 1 || options.peerPort > 65_535) {
      throw new Error("--acceptance 必须提供合法 --peer-port");
    }
  }
  return options;
}

function hostArchitecture() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  throw new Error(`不支持的 macOS host architecture：${process.arch}`);
}

function parseSigningIdentities(output) {
  const identities = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"\s*$/u.exec(line);
    if (match) identities.push({ hash: match[1], authority: match[2] });
  }
  return identities;
}

function certificateTeamID(authority) {
  const certificate = execFileSync("security", ["find-certificate", "-c", authority, "-p"]);
  const subject = execFileSync(
    "openssl",
    ["x509", "-noout", "-subject", "-nameopt", "RFC2253"],
    { input: certificate, encoding: "utf8" },
  );
  const match = /(?:^|,)OU=([A-Z0-9]{10})(?:,|$)/u.exec(subject.replace(/^subject=/u, ""));
  if (!match) throw new Error("无法从 Apple Development 证书 OU 解析 Team ID");
  return match[1];
}

function resolveDevelopmentSigning() {
  const requested = process.env.COFLUX_MACOS_SIGNING_IDENTITY || "Apple Development";
  const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  const matches = parseSigningIdentities(output).filter(({ authority, hash }) => (
    authority.startsWith("Apple Development:")
    && (requested === "Apple Development" || authority === requested || hash === requested)
  ));
  if (matches.length !== 1) {
    throw new Error(`Apple Development identity 应唯一匹配，实际 ${matches.length}；可设置 COFLUX_MACOS_SIGNING_IDENTITY`);
  }
  const identity = matches[0];
  const certificateTeam = certificateTeamID(identity.authority);
  const requestedTeam = process.env.COFLUX_MACOS_DEVELOPMENT_TEAM;
  if (requestedTeam && requestedTeam !== certificateTeam) {
    throw new Error("COFLUX_MACOS_DEVELOPMENT_TEAM 与签名证书 OU 不一致");
  }
  return { ...identity, team: certificateTeam };
}

function assertNoGlobalLocalNetworkBypass() {
  for (const key of ["AllowedEthernetLocalNetworkAddresses", "AllowedWiFiLocalNetworkAddresses"]) {
    const result = spawnSync("defaults", ["read", "com.apple.network.local-network", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw new Error(`无法只读检查 ${key}`, { cause: result.error });
    if (result.status === 0 && result.stdout.trim().length > 0) {
      throw new Error(`检测到 ${key} 全局例外；它会绕过 Local Network privacy，本次验收必须停止`);
    }
    if (
      result.status !== 0
      && !/(does not exist|not found)/iu.test(`${result.stdout}\n${result.stderr}`)
    ) {
      throw new Error(`无法确认 ${key} 不存在；Local Network privacy 预检必须 fail closed`);
    }
  }
}

function assertSupportedOS() {
  const version = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major < 15) {
    throw new Error(`Local Network privacy 的 macOS 验收要求 macOS 15+；当前 ${version}`);
  }
  return version;
}

function ipv4Number(value) {
  if (isIP(value) !== 4) return undefined;
  return value.split(".").reduce((result, component) => ((result << 8) | Number(component)) >>> 0, 0);
}

function isPrivateIPv4(value) {
  const numeric = ipv4Number(value);
  if (numeric === undefined) return false;
  return (
    ((numeric & 0xff00_0000) >>> 0) === 0x0a00_0000
    || ((numeric & 0xfff0_0000) >>> 0) === 0xac10_0000
    || ((numeric & 0xffff_0000) >>> 0) === 0xc0a8_0000
    || ((numeric & 0xffff_0000) >>> 0) === 0xa9fe_0000
  );
}

function routeInterface(peerHost) {
  const output = execFileSync("route", ["-n", "get", peerHost], { encoding: "utf8" });
  const match = /^\s*interface:\s*(\S+)\s*$/mu.exec(output);
  if (!match) throw new Error("无法解析 peer route interface");
  return match[1];
}

function physicalNetworkDevices() {
  const output = execFileSync("networksetup", ["-listallhardwareports"], { encoding: "utf8" });
  const devices = new Map();
  let hardwarePort;
  for (const line of output.split(/\r?\n/u)) {
    const portMatch = /^Hardware Port:\s*(.+)$/u.exec(line);
    if (portMatch) hardwarePort = portMatch[1];
    const deviceMatch = /^Device:\s*(\S+)$/u.exec(line);
    if (deviceMatch && hardwarePort) {
      devices.set(deviceMatch[1], hardwarePort);
      hardwarePort = undefined;
    }
  }
  return devices;
}

function assertControlledPhysicalLANPeer(peerHost) {
  if (!isPrivateIPv4(peerHost)) {
    throw new Error("peer host 必须是明确的 RFC1918/IPv4 link-local 数字地址，不能是 loopback、DNS 或公网地址");
  }
  const interfaces = networkInterfaces();
  const ownAddresses = new Set(
    Object.values(interfaces).flatMap((entries) => (entries ?? []).map((entry) => entry.address)),
  );
  if (ownAddresses.has(peerHost)) throw new Error("peer host 是本机地址；必须使用第二台受控 LAN 主机");

  const interfaceName = routeInterface(peerHost);
  const hardwarePort = physicalNetworkDevices().get(interfaceName);
  if (!hardwarePort || !/(Wi-Fi|Ethernet)/iu.test(hardwarePort)) {
    throw new Error(`peer route 走 ${interfaceName}/${hardwarePort ?? "未知设备"}，不是受支持的物理 Wi-Fi/Ethernet`);
  }
  const localEntry = (interfaces[interfaceName] ?? []).find((entry) => entry.family === "IPv4" && !entry.internal);
  if (!localEntry) throw new Error(`物理接口 ${interfaceName} 没有活动 IPv4 地址`);
  const peer = ipv4Number(peerHost);
  const local = ipv4Number(localEntry.address);
  const mask = ipv4Number(localEntry.netmask);
  if (peer === undefined || local === undefined || mask === undefined || (peer & mask) !== (local & mask)) {
    throw new Error(`peer ${peerHost} 与 ${interfaceName} 不在同一 IPv4 子网`);
  }
  return { interfaceName, hardwarePort };
}

function assertSamePhysicalRoute(expected, actual, label) {
  if (
    expected.interfaceName !== actual.interfaceName
    || expected.hardwarePort !== actual.hardwarePort
  ) {
    throw new Error(
      `${label} physical route 漂移：${expected.interfaceName}/${expected.hardwarePort} -> ${actual.interfaceName}/${actual.hardwarePort}`,
    );
  }
}

function randomHex(bytes = 16) {
  return randomBytes(bytes).toString("hex");
}

function createRunID(decision) {
  const timestamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
  return `r${timestamp}-${decision}-${randomHex(6)}`;
}

function exchangePeerChallenge({ host, port, runID, nonce, timeoutMs = 8_000 }) {
  return new Promise((resolveChallenge, rejectChallenge) => {
    const socket = createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectChallenge(error);
      else resolveChallenge(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ protocolVersion: PEER_PROTOCOL_VERSION, runID, nonce })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_LINE_BYTES) {
        finish(new Error("peer preflight response 超过 64 KiB"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch (error) {
        finish(new Error("peer preflight response 不是合法 JSON", { cause: error }));
        return;
      }
      if (
        response?.protocolVersion !== PEER_PROTOCOL_VERSION
        || response.runID !== runID
        || response.nonce !== nonce
        || typeof response.peerID !== "string"
        || response.peerID.length === 0
      ) {
        finish(new Error("peer preflight 没有回显本次随机挑战"));
        return;
      }
      finish(undefined, response.peerID);
    });
    socket.once("timeout", () => finish(new Error("peer preflight 超时")));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("peer 在完整回显前关闭")));
  });
}

function makeVariantRuntime(variant, options, coordinatorPort, expectedPeerID) {
  const runID = createRunID(variant.decision);
  return {
    ...variant,
    runID,
    bundleID: `dev.coflux.macos.tcc.${variant.decision}.${runID}`,
    nonce: randomHex(),
    coordinatorToken: randomHex(),
    coordinatorPort,
    peerHost: options.peerHost ?? "192.168.1.254",
    peerPort: options.peerPort ?? 9,
    expectedPeerID,
    context: options.context,
  };
}

function runXcodeBuild(runtime, derivedDataPath, signing) {
  const result = spawnSync(
    "xcodebuild",
    [
      "build",
      ...(process.env.COFLUX_XCODE_VERBOSE ? [] : ["-quiet"]),
      "-project", "apps/macos/Coflux.xcodeproj",
      "-scheme", runtime.scheme,
      "-configuration", "Debug",
      "-destination", `platform=macOS,arch=${hostArchitecture()}`,
      "-derivedDataPath", derivedDataPath,
      `PRODUCT_BUNDLE_IDENTIFIER=${runtime.bundleID}`,
      `DEVELOPMENT_TEAM=${signing.team}`,
      "CODE_SIGN_STYLE=Manual",
      `CODE_SIGN_IDENTITY=${signing.hash}`,
      "PROVISIONING_PROFILE_SPECIFIER=",
      `COFLUX_TCC_RUN_ID=${runtime.runID}`,
      `COFLUX_TCC_PEER_HOST=${runtime.peerHost}`,
      `COFLUX_TCC_PEER_PORT=${runtime.peerPort}`,
      `COFLUX_TCC_EXPECTED_PEER_ID=${runtime.expectedPeerID}`,
      `COFLUX_TCC_NONCE=${runtime.nonce}`,
      `COFLUX_TCC_COORDINATOR_PORT=${runtime.coordinatorPort}`,
      `COFLUX_TCC_COORDINATOR_TOKEN=${runtime.coordinatorToken}`,
      `COFLUX_TCC_CONTEXT=${runtime.context}`,
    ],
    { cwd: ROOT, stdio: "inherit", timeout: 5 * 60 * 1000 },
  );
  if (result.error) throw new Error(`${runtime.decision} probe xcodebuild 无法运行`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${runtime.decision} probe xcodebuild 失败，exit=${result.status}`);
}

function parseInfoPlist(infoPath) {
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", infoPath], {
    encoding: "utf8",
  }));
}

function executableUUIDs(executablePath) {
  const output = execFileSync("dwarfdump", ["--uuid", executablePath], { encoding: "utf8" });
  const uuids = [...output.matchAll(/^UUID:\s+([0-9A-F-]+)\s+\(([^)]+)\)/gmu)]
    .map((match) => ({ uuid: match[1], arch: match[2] }));
  if (uuids.length === 0) throw new Error("dwarfdump 没有返回主可执行文件 UUID");
  return uuids;
}

function auditProbeProduct(runtime, derivedDataPath, signing) {
  const productDirectory = join(derivedDataPath, "Build", "Products", "Debug");
  const appPath = realpathSync(join(productDirectory, `${runtime.productName}.app`));
  const signed = auditSignedApp({
    derivedDataPath,
    variant: { name: runtime.decision, sandbox: true, networkClient: true, networkServer: false },
    team: signing.team,
    identity: signing.authority,
    productName: runtime.productName,
  });
  const infoPath = join(appPath, "Contents", "Info.plist");
  const info = parseInfoPlist(infoPath);
  const expected = {
    CFBundleIdentifier: runtime.bundleID,
    CFBundleDisplayName: runtime.displayName,
    CofluxTCCExpectedDecision: runtime.decision,
    CofluxTCCRunID: runtime.runID,
    CofluxTCCPeerHost: String(runtime.peerHost),
    CofluxTCCPeerPort: String(runtime.peerPort),
    CofluxTCCExpectedPeerID: runtime.expectedPeerID,
    CofluxTCCCoordinatorPort: String(runtime.coordinatorPort),
    CofluxTCCContext: runtime.context,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (info[key] !== value) throw new Error(`${runtime.decision} probe Info.plist ${key} 不符`);
  }
  if (info.CofluxTCCNonce !== runtime.nonce || info.CofluxTCCCoordinatorToken !== runtime.coordinatorToken) {
    throw new Error(`${runtime.decision} probe 签名配置没有封装本次 nonce/token`);
  }
  const executableName = info.CFBundleExecutable;
  if (typeof executableName !== "string" || executableName.length === 0) {
    throw new Error(`${runtime.decision} probe 缺少 CFBundleExecutable`);
  }
  const executablePath = realpathSync(join(appPath, "Contents", "MacOS", executableName));
  return {
    appPath,
    executablePath,
    audit: {
      bundleID: runtime.bundleID,
      displayName: runtime.displayName,
      decision: runtime.decision,
      runID: runtime.runID,
      context: runtime.context,
      uuids: executableUUIDs(executablePath),
      ...signed,
    },
  };
}

function assertDistinctExecutableUUIDs(products) {
  const seen = new Set();
  for (const product of products) {
    for (const item of product.audit.uuids) {
      if (seen.has(item.uuid)) throw new Error("Allow/Deny 主可执行文件 UUID 重复，不能作为两个独立 TCC identity");
      seen.add(item.uuid);
    }
  }
}

function validateCoordinatorEvent(event, runtime) {
  return event
    && event.protocolVersion === COORDINATOR_PROTOCOL_VERSION
    && event.runID === runtime.runID
    && event.token === runtime.coordinatorToken
    && event.bundleID === runtime.bundleID
    && event.binaryTag === runtime.binaryTag
    && event.expectedDecision === runtime.decision
    && event.context === runtime.context
    && Number.isInteger(event.pid)
    && event.pid > 1
    && Number.isInteger(event.parentPID)
    && event.parentPID > 0
    && new Set(["launched", "requestStarted", "verification"]).has(event.event)
    && (event.peerID === undefined || typeof event.peerID === "string")
    && (event.pathInterfaceType === undefined || typeof event.pathInterfaceType === "string")
    && typeof event.detail === "string";
}

async function startCoordinator() {
  const events = [];
  const runtimesByToken = new Map();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    const fail = () => socket.destroy();
    socket.setTimeout(15_000);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_LINE_BYTES) {
        fail();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let event;
      try {
        event = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        fail();
        return;
      }
      const runtime = runtimesByToken.get(event?.token);
      if (!runtime || !validateCoordinatorEvent(event, runtime)) {
        fail();
        return;
      }
      if (runtime.observedPID === undefined) runtime.observedPID = event.pid;
      if (runtime.observedPID !== event.pid) {
        fail();
        return;
      }
      events.push({ runtime, event, receivedAt: Date.now() });
      socket.end("ok\n");
    });
    socket.on("timeout", fail);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法读取 coordinator port");
  return {
    port: address.port,
    register(runtime) {
      runtimesByToken.set(runtime.coordinatorToken, runtime);
    },
    async waitFor(runtime, predicate, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Local Network TCC acceptance 已中断");
        const match = events.find((entry) => entry.runtime === runtime && predicate(entry.event));
        if (match) return match.event;
        await sleep(100);
      }
      throw new Error(`${runtime.decision} probe 等待人工操作超时`);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function commandMatchesExecutable(command, executablePath) {
  return command === executablePath || command.startsWith(`${executablePath} `);
}

function processParentPID(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parentPID = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(parentPID) && parentPID > 0 ? parentPID : undefined;
}

function assertLaunchServicesProcess(event, executablePath) {
  const command = processCommand(event.pid);
  if (!commandMatchesExecutable(command, executablePath)) {
    throw new Error(`PID ${event.pid} 不属于本次签名 app`);
  }
  const observedParentPID = processParentPID(event.pid);
  if (event.parentPID !== observedParentPID || observedParentPID !== 1) {
    throw new Error(
      `probe 不是由 LaunchServices/launchd 托管：event ppid=${event.parentPID} current ppid=${observedParentPID ?? "unknown"}`,
    );
  }
  if (!/\/launchd(?:\s|$)/u.test(processCommand(observedParentPID))) {
    throw new Error("probe parent PID 1 不是 launchd；拒绝把 Terminal 直接执行当作 TCC 证据");
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProbeExit(pid, executablePath, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    if (signal?.aborted) throw new Error("等待 probe 退出时收到中断");
    await sleep(100);
  }
  if (!processExists(pid)) return;
  const command = processCommand(pid);
  if (!commandMatchesExecutable(command, executablePath)) {
    throw new Error(`PID ${pid} 已被复用或不属于本次 probe，拒绝终止`);
  }
  process.kill(pid, "SIGTERM");
  const terminateDeadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < terminateDeadline) await sleep(50);
  if (processExists(pid)) throw new Error(`无法清理本次 ${executablePath} 进程`);
}

function findRunningProbePids(products) {
  const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const matches = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    const product = products.find((candidate) => commandMatchesExecutable(command, candidate.executablePath));
    if (product) matches.push({ pid, product });
  }
  return matches;
}

async function assertStablePeer(runtime, expectedRoute, expectedPeerID, label) {
  const route = assertControlledPhysicalLANPeer(runtime.peerHost);
  assertSamePhysicalRoute(expectedRoute, route, label);
  const peerID = await exchangePeerChallenge({
    host: runtime.peerHost,
    port: runtime.peerPort,
    runID: `${runtime.runID}-${label}`,
    nonce: randomHex(),
  });
  if (peerID !== expectedPeerID) {
    throw new Error(`${label} peer ID 漂移：期望 ${expectedPeerID}，实际 ${peerID}`);
  }
  return route;
}

async function runInteractiveVariant({
  runtime,
  product,
  coordinator,
  timeoutMs,
  baselineRoute,
  expectedPeerID,
  signal,
}) {
  await assertStablePeer(runtime, baselineRoute, expectedPeerID, `${runtime.decision}-before`);
  execFileSync("open", ["-R", product.appPath]);
  console.log(`\n请在 Finder 中双击：${product.appPath}`);
  console.log(`系统弹窗请选择“${runtime.decision === "allow" ? "允许" : "不允许"}”，再按 app 内两步按钮完成验证。`);

  const launched = await coordinator.waitFor(
    runtime,
    (event) => event.event === "launched" || event.event === "requestStarted",
    timeoutMs,
    signal,
  );
  assertLaunchServicesProcess(launched, product.executablePath);

  const result = await coordinator.waitFor(
    runtime,
    (event) => event.event === "verification",
    timeoutMs,
    signal,
  );
  if (result.pid !== launched.pid) throw new Error(`${runtime.decision} verification PID 与 launched PID 不一致`);
  const allowEvidenceValid = runtime.decision !== "allow" || (
    result.peerID === expectedPeerID
    && new Set(["wifi", "wiredEthernet"]).has(result.pathInterfaceType)
  );
  if (
    result.outcome !== "passed"
    || result.observedDecision !== runtime.decision
    || !allowEvidenceValid
  ) {
    throw new Error(
      `${runtime.decision} TCC 结果未通过：outcome=${result.outcome} observed=${result.observedDecision ?? "none"} detail=${result.detail}`,
    );
  }
  await assertStablePeer(runtime, baselineRoute, expectedPeerID, `${runtime.decision}-after`);
  console.log(`${runtime.decision} 路径程序化判定通过；请在 app 内点击“结束并退出”。`);
  await waitForProbeExit(launched.pid, product.executablePath, 5 * 60 * 1000, signal);
  return {
    decision: runtime.decision,
    outcome: result.outcome,
    observedDecision: result.observedDecision,
    localNetworkEvidence: runtime.decision === "allow" ? "nonce-echo" : "NWPath.localNetworkDenied",
    nativePathInterfaceType: result.pathInterfaceType ?? null,
    stablePeerID: expectedPeerID,
    loopbackCoordinatorCallback: true,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  let signing;
  let workDirectory;
  let coordinator;
  let products = [];
  let primaryError;
  let interruptedSignal;
  const interruption = new AbortController();
  const onSignal = (signal) => {
    interruptedSignal ??= signal;
    interruption.abort();
  };
  const onSIGINT = () => onSignal("SIGINT");
  const onSIGTERM = () => onSignal("SIGTERM");
  const onSIGHUP = () => onSignal("SIGHUP");
  process.on("SIGINT", onSIGINT);
  process.on("SIGTERM", onSIGTERM);
  process.on("SIGHUP", onSIGHUP);
  const interactionTimeoutMs = options.interactionTimeoutMinutes * 60 * 1000;
  try {
    signing = resolveDevelopmentSigning();
    let osVersion;
    let peerRoute;
    let peerID;
    if (options.mode === "acceptance") {
      osVersion = assertSupportedOS();
      assertNoGlobalLocalNetworkBypass();
      peerRoute = assertControlledPhysicalLANPeer(options.peerHost);
      peerID = await exchangePeerChallenge({
        host: options.peerHost,
        port: options.peerPort,
        runID: `preflight-${randomHex(6)}`,
        nonce: randomHex(),
      });
      coordinator = await startCoordinator();
    }

    workDirectory = mkdtempSync(join(tmpdir(), "coflux-native-tcc-"));
    const coordinatorPort = coordinator?.port ?? 9;
    const expectedPeerID = peerID ?? "build-only-peer-never-launched";
    const runtimes = VARIANTS.map((variant) => (
      makeVariantRuntime(variant, options, coordinatorPort, expectedPeerID)
    ));
    for (const runtime of runtimes) coordinator?.register(runtime);

    for (const runtime of runtimes) {
      const derivedDataPath = join(workDirectory, `DerivedData-${runtime.decision}`);
      runXcodeBuild(runtime, derivedDataPath, signing);
      if (interruption.signal.aborted) throw new Error(`收到 ${interruptedSignal}`);
      products.push({
        runtime,
        ...auditProbeProduct(runtime, derivedDataPath, signing),
      });
    }
    assertDistinctExecutableUUIDs(products);

    if (options.mode === "build-only") {
      console.log(`COFLUX_TCC_BUILD_AUDIT ${JSON.stringify({
        launched: false,
        signingTeam: signing.team,
        products: products.map(({ audit }) => audit),
      })}`);
      return;
    }

    console.log("本次 app 使用一次性身份；Allow/Deny TCC 记录会保留，脚本不会尝试 reset 或修改 TCC 数据库。");
    console.log(`验收 context=${options.context}；${options.context === "fresh-bundle" ? "只证明 fresh bundle，不可表述为 clean-user" : "由操作者声明为干净上下文"}。`);
    const results = [];
    for (const product of products) {
      results.push(await runInteractiveVariant({
        runtime: product.runtime,
        product,
        coordinator,
        timeoutMs: interactionTimeoutMs,
        baselineRoute: peerRoute,
        expectedPeerID: peerID,
        signal: interruption.signal,
      }));
    }
    console.log(`COFLUX_TCC_ACCEPTANCE ${JSON.stringify({
      osVersion,
      context: options.context,
      cleanUserEvidenceAutomaticallyVerified: false,
      cleanContextClaim: options.context,
      cleanContextRequiresOperatorAttestation: options.context !== "fresh-bundle",
      signingTeam: signing.team,
      peer: {
        peerID,
        interfaceName: peerRoute.interfaceName,
        hardwarePort: peerRoute.hardwarePort,
      },
      products: products.map(({ audit }) => audit),
      results,
      nativeRelayFallbackProven: false,
      relayBoundary: "本 probe 只证明 LAN TCC decision 与 loopback callback；真实 native relay fallback 仍需远端 worker/relay acceptance",
    })}`);
  } catch (error) {
    primaryError = interruptedSignal
      ? new Error(`收到 ${interruptedSignal}，Local Network TCC acceptance 已中断并清理`, { cause: error })
      : error;
  } finally {
    const cleanupErrors = [];
    try {
      for (const match of findRunningProbePids(products)) {
        try { await waitForProbeExit(match.pid, match.product.executablePath, 1_000); }
        catch (error) { cleanupErrors.push(error); }
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try { await coordinator?.close(); } catch (error) { cleanupErrors.push(error); }
    if (workDirectory) {
      try { rmSync(workDirectory, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
    process.off("SIGINT", onSIGINT);
    process.off("SIGTERM", onSIGTERM);
    process.off("SIGHUP", onSIGHUP);
    if (cleanupErrors.length > 0) {
      if (primaryError) cleanupErrors.unshift(primaryError);
      throw new AggregateError(cleanupErrors, "Local Network TCC harness 清理不完整");
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
