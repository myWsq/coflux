/**
 * 本地优先发布 benchmark（不进入 CI 的脆弱性能门）。
 *
 * 运行：
 *   COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
 *     node --import tsx tests/src/local-first-benchmark.mjs
 *
 * 独立临时 stack 先经中心完成配对/建任务，再切到 warm cached direct。计时区间内普通
 * Device frame 不经过中心；attach 指标包含 sessiond 生成/传输 snapshot，以及全新 xterm 6
 * 把 snapshot 解析成首个可用画面的时间。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpus, totalmem, platform, release, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import XTermHeadless from "@xterm/headless";
import { TaskStatus } from "@coflux/protocol";
import { openRelayDevice, utf8 } from "./device-harness.mjs";
import { mkRepo, startStack } from "./harness.mjs";

const PORT = Number(process.env.COFLUX_BENCH_PORT ?? 8848);
const COLS = 80;
const ROWS = 24;
const HISTORY_LINES = 2000;
const WARMUP = 20;
const SAMPLES = 100;
const ECHO_P95_LIMIT_MS = 20;
const ATTACH_P95_LIMIT_MS = 100;
const { Terminal } = XTermHeadless;
const require = createRequire(import.meta.url);
const xtermVersion = require("@xterm/headless/package.json").version;

function outputSince(device, from, sessionId) {
  return device.log
    .slice(from)
    .filter((message) => message.case === "ptyOutput" && message.sessionId === sessionId)
    .map((message) => utf8(message.data))
    .join("");
}

function relayFrameCount(device) {
  return device.control.log.filter((message) => message.case === "deviceRelayFrame").length;
}

function observeClientRelayFrames(control) {
  const send = control.send.bind(control);
  let count = 0;
  control.send = (message) => {
    if (message.case === "deviceRelayFrame") count += 1;
    return send(message);
  };
  return () => count;
}

function relayFrameSnapshot(device, sentCount) {
  const clientToServer = sentCount();
  const serverToClient = relayFrameCount(device);
  return { clientToServer, serverToClient, total: clientToServer + serverToClient };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function distribution(samples) {
  const sum = samples.reduce((total, sample) => total + sample, 0);
  return {
    samples: samples.length,
    minMs: round(Math.min(...samples)),
    medianMs: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    maxMs: round(Math.max(...samples)),
    meanMs: round(sum / samples.length),
  };
}

function git(args, fallback = "unknown") {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

async function writeSnapshot(snapshot) {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: HISTORY_LINES, allowProposedApi: true });
  try {
    await new Promise((resolve) => terminal.write(snapshot, resolve));
  } finally {
    terminal.dispose();
  }
}

async function createRunningSession(stack, device, repo) {
  const control = device.control;
  control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir, name: "local-first-benchmark" });
  const main = await control.waitFor(
    (message) => message.case === "workspaceCreated" && message.workspace.isMain,
    "benchmark main workspace",
  );
  control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "local-first-benchmark" });
  const idle = await control.waitFor(
    (message) => message.case === "taskUpdated" && message.task.title === "local-first-benchmark",
    "benchmark idle task",
  );
  control.send({ case: "taskStart", taskId: idle.task.id, cols: COLS, rows: ROWS });
  const running = await control.waitFor(
    (message) =>
      message.case === "taskUpdated" &&
      message.task.id === idle.task.id &&
      message.task.status === TaskStatus.RUNNING &&
      message.task.sessionId,
    "benchmark running task",
  );
  return running.task.sessionId;
}

async function fillDefaultHistory(device, sessionId) {
  const marker = "COFLUX_BENCH_HISTORY_READY";
  const from = device.mark();
  const command =
    `i=0; while [ $i -lt ${HISTORY_LINES + ROWS} ]; do ` +
    "printf 'HISTORY_%04d_abcdefghijklmnopqrstuvwxyz\\n' \"$i\"; i=$((i+1)); " +
    "done; printf 'COFLUX_BENCH_HISTORY_%s\\n' READY\r";
  await device.input(sessionId, command, { timeout: 30000 });
  await device.waitFor(
    () => outputSince(device, from, sessionId).includes(marker),
    "history ready marker",
    30000,
    from,
  );
  const attached = await device.attach(sessionId, { cols: COLS, rows: ROWS, timeout: 30000 });
  assert.ok(utf8(attached.ansiSnapshot ?? new Uint8Array()).includes(marker), "default history snapshot 已包含完成 marker");
  return attached.ansiSnapshot;
}

async function sampleEcho(device, sessionId, index) {
  const marker = `ECHO_${index}_${randomUUID().slice(0, 8)}`;
  const from = device.mark();
  const startedAt = performance.now();
  const acknowledged = device.input(sessionId, `printf '${marker}\\n'\r`);
  await device.waitFor(
    () => outputSince(device, from, sessionId).includes(marker),
    `echo ${index}`,
    5000,
    from,
  );
  const elapsed = performance.now() - startedAt;
  await acknowledged;
  return elapsed;
}

async function sampleAttach(device, sessionId) {
  const startedAt = performance.now();
  const attached = await device.attach(sessionId, { cols: COLS, rows: ROWS, timeout: 5000 });
  assert.ok(attached.ansiSnapshot?.byteLength > 0, "warm attach 必须返回原子 snapshot");
  await writeSnapshot(attached.ansiSnapshot);
  return { elapsed: performance.now() - startedAt, snapshotBytes: attached.ansiSnapshot.byteLength };
}

async function main() {
  assert.ok(Number.isInteger(PORT) && PORT > 0 && PORT <= 65535, "COFLUX_BENCH_PORT 必须是有效端口");
  let stack;
  let device;
  const repo = mkRepo();
  try {
    stack = await startStack({
      port: PORT,
      daemonEnv: { COFLUX_HISTORY_LINES: String(HISTORY_LINES) },
    });
    device = await openRelayDevice(stack);
    const sentRelayFrameCount = observeClientRelayFrames(device.control);
    const sessionId = await createRunningSession(stack, device, repo);
    await device.attach(sessionId, { cols: COLS, rows: ROWS });
    const seededSnapshot = await fillDefaultHistory(device, sessionId);

    await device.openDirect();
    await device.attach(sessionId, { cols: COLS, rows: ROWS });
    const relayFramesBefore = relayFrameSnapshot(device, sentRelayFrameCount);

    for (let index = 0; index < WARMUP; index += 1) await sampleEcho(device, sessionId, `warmup-${index}`);
    const echoSamples = [];
    for (let index = 0; index < SAMPLES; index += 1) echoSamples.push(await sampleEcho(device, sessionId, index));

    for (let index = 0; index < WARMUP; index += 1) await sampleAttach(device, sessionId);
    const attachSamples = [];
    let snapshotBytes = seededSnapshot?.byteLength ?? 0;
    for (let index = 0; index < SAMPLES; index += 1) {
      const sample = await sampleAttach(device, sessionId);
      attachSamples.push(sample.elapsed);
      snapshotBytes = Math.max(snapshotBytes, sample.snapshotBytes);
    }

    const relayFramesAfter = relayFrameSnapshot(device, sentRelayFrameCount);
    const relayFrameDelta = {
      clientToServer: relayFramesAfter.clientToServer - relayFramesBefore.clientToServer,
      serverToClient: relayFramesAfter.serverToClient - relayFramesBefore.serverToClient,
      total: relayFramesAfter.total - relayFramesBefore.total,
    };
    const echo = distribution(echoSamples);
    const attach = distribution(attachSamples);
    const cpu = cpus()[0];
    const report = {
      benchmark: "coflux-local-first-warm-direct",
      measuredAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpu?.model ?? "unknown",
        logicalCpus: cpus().length,
        memoryGiB: round(totalmem() / 1024 ** 3),
        node: process.version,
      },
      browser: {
        label: process.env.COFLUX_BENCH_BROWSER ?? "headless-node（不含 DOM renderer）",
        xterm: `@xterm/headless ${xtermVersion}`,
      },
      build: {
        commit: git(["rev-parse", "HEAD"]),
        dirty: git(["status", "--porcelain"], "") !== "",
        supervisor: process.env.COFLUX_SUPERVISOR_BIN ?? "target/debug/coflux-supervisor",
        worker: process.env.COFLUX_WORKER_BIN ?? "target/debug/coflux-worker",
      },
      configuration: {
        transport: "direct",
        warmupPerMetric: WARMUP,
        samplesPerMetric: SAMPLES,
        cols: COLS,
        rows: ROWS,
        maxHistoryLines: HISTORY_LINES,
        maxSnapshotBytes: snapshotBytes,
      },
      serverRelayFrames: {
        beforeTimedDirectPath: relayFramesBefore,
        afterTimedDirectPath: relayFramesAfter,
        timedDirectPathDelta: relayFrameDelta,
      },
      echo,
      attachToParsedScreen: attach,
      slo: {
        echoP95LimitMs: ECHO_P95_LIMIT_MS,
        attachP95LimitMs: ATTACH_P95_LIMIT_MS,
        echoPassed: echo.p95Ms < ECHO_P95_LIMIT_MS,
        attachPassed: attach.p95Ms < ATTACH_P95_LIMIT_MS,
      },
    };

    console.log(JSON.stringify(report, null, 2));
    assert.equal(report.serverRelayFrames.timedDirectPathDelta.total, 0, "direct 热路径不得产生中心 Device relay frame");
    assert.ok(echo.p95Ms < ECHO_P95_LIMIT_MS, `echo p95 ${echo.p95Ms}ms 必须 < ${ECHO_P95_LIMIT_MS}ms`);
    assert.ok(attach.p95Ms < ATTACH_P95_LIMIT_MS, `attach p95 ${attach.p95Ms}ms 必须 < ${ATTACH_P95_LIMIT_MS}ms`);
  } finally {
    device?.close();
    await stack?.stop();
    repo.cleanup();
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
