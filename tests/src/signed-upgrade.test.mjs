import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, arch } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";
import { workerReleaseStatement } from "../../scripts/release-statement.mjs";

// 远程下载 + ed25519 验签的验收。头等用例是负向：被篡改 / 签名不符的产物必须被拒、保持当前版本。
// 隔离：临时 127.0.0.1 HTTP server 服务产物（零外网）；临时 ed25519，公钥经 env 注入 supervisor；
// 下载产物落临时 COFLUX_HOME；不跑 launcher。
const PORT = 8829;
const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER_BIN = process.env.COFLUX_WORKER_BIN || join(ROOT, "target", "debug", "coflux-worker");

function hostTarget() {
  const p = platform(), a = arch();
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (p === "linux") return a === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  throw new Error(`unsupported test host platform: ${p}/${a}`);
}
const TARGET = hostTarget();
const CROSS_TARGET = TARGET === "aarch64-apple-darwin" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";

// 临时 ed25519：公钥(hex)注入 supervisor，私钥签产物
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBKEY_HEX = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
const sign = (buf) => crypto.sign(null, buf, privateKey).toString("hex");
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function signedRelease(version, artifact = ARTIFACT, target = TARGET) {
  const sha256 = sha256hex(artifact);
  const size = artifact.byteLength;
  return {
    version,
    sha256,
    signature: sign(artifact), // legacy raw signature：供旧 supervisor 兼容
    target,
    artifactSize: BigInt(size),
    releaseSignature: sign(workerReleaseStatement({ version, target, sha256, size })),
  };
}

// pretest 关闭 debug info：Linux 的 DWARF 会让调试二进制超过生产下载 128 MiB 硬上限，
// 这里仍使用可执行的真 worker 验收升级链，不能为了 fixture 放宽生产上限。
const ARTIFACT = readFileSync(WORKER_BIN); // 用真 worker 二进制当"新版本产物"
const TAMPERED = Buffer.from(ARTIFACT);
TAMPERED[0] ^= 0xff; // 改一个字节

let stack;
let httpServer;
let baseUrl;
const repos = [];
let slowDownloadHits = 0;
const requestHits = new Map();

before(async () => {
  httpServer = http.createServer((req, res) => {
    requestHits.set(req.url, (requestHits.get(req.url) ?? 0) + 1);
    if (req.url === "/good") return void res.writeHead(200).end(ARTIFACT);
    if (req.url === "/slow-old") {
      slowDownloadHits++;
      return void setTimeout(() => res.writeHead(200).end(ARTIFACT), 1800);
    }
    if (req.url === "/oversize-header") {
      return void res.writeHead(200, { "content-length": String(128 * 1024 * 1024 + 1) }).end();
    }
    if (req.url === "/tampered") return void res.writeHead(200).end(TAMPERED);
    res.writeHead(404).end();
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  stack = await startStack({ port: PORT, daemonEnv: { COFLUX_WORKER_PUBKEY: PUBKEY_HEX, COFLUX_WORKER_PROBATION_MS: "1500" } });
});
after(async () => {
  await stack?.stop();
  httpServer?.close();
  repos.forEach((r) => r.cleanup());
});

function readActive() {
  return readFileSync(join(stack.home, "worker.active"), "utf8").trim();
}
function readWorkerPid() {
  return Number(readFileSync(join(stack.home, "worker.pid"), "utf8").trim());
}
async function isOnline() {
  const p = stack.makeClient();
  try {
    const snap = await p.authSubscribe();
    return !!snap.daemons.find((d) => d.daemonId === stack.daemonId && d.online);
  } catch {
    return false;
  } finally {
    p.close();
  }
}
async function waitNewWorker(prevPid) {
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    let pid;
    try { pid = readWorkerPid(); } catch { continue; }
    if (pid !== prevPid && (await isOnline())) return pid;
  }
  return 0;
}
async function waitActive(version, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    try { if (readActive() === version) return true; } catch { /* marker 原子替换期间也不应缺失，保守重试 */ }
  }
  return false;
}
async function waitDaemonVersion(version, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const c = stack.makeClient();
    try {
      const snap = await c.authSubscribe();
      const daemon = snap.daemons.find((item) => item.daemonId === stack.daemonId);
      if (daemon?.online && daemon.workerVersion === version) return true;
    } catch { /* supervisor/worker 正在重启 */ }
    finally { c.close(); }
    await sleep(250);
  }
  return false;
}
async function runTaskWithMarker(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openRelayDevice(stack);
  const a = device.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "su" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "su", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  const attached = await device.attach(sessionId);
  const from = device.mark();
  await device.input(sessionId, `echo ${marker}\r`);
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes(marker), "marker", 10000, from);
  return { device, taskId, sessionId, holderEpoch: attached.holderEpoch };
}

test("远程下载 + 验签：合法签名产物升级成功、会话存活", async () => {
  assert.equal(readActive(), "builtin");
  const { device, sessionId, holderEpoch } = await runTaskWithMarker("SIGNED_OK");
  const pid1 = readWorkerPid();

  const c = device.control;
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.0.0"),
  });

  assert.ok(await waitNewWorker(pid1), "下载验签通过后新 worker 起来且在线");
  let committed = false;
  for (let i = 0; i < 80 && !committed; i++) {
    await sleep(250);
    try { committed = readActive() === "v1.0.0"; } catch { /* 文件瞬时缺失 */ }
  }
  assert.ok(committed, "验签产物升级提交，worker.active=v1.0.0");

  await device.openRelay();
  const restored = await device.attach(sessionId);
  assert.equal(restored.holderEpoch, holderEpoch);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("SIGNED_OK"), "升级后 snapshot 保留历史");
  const from = device.mark();
  await device.input(sessionId, "echo AFTER_SIGNED\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_SIGNED"), "升级后交互恢复", 10000, from);
  device.close();
});

test("supervisor 重启：从 worker.active + 下载目录恢复已提交 worker", async () => {
  const pidBefore = readWorkerPid();
  await stack.restartDaemon();

  assert.ok(await waitDaemonVersion("v1.0.0"), "重启后运行下载目录中的 v1.0.0，而非退回 builtin");
  assert.notEqual(readWorkerPid(), pidBefore, "worker 是 supervisor 重启后重新拉起的进程");
  await sleep(2000); // 跨过 1500ms 观察期，确认不是短暂启动后回退。
  assert.ok(await waitDaemonVersion("v1.0.0"), "恢复候选通过 UDS/resync 复检后继续运行");
  assert.equal(readActive(), "v1.0.0", "恢复复检后仍提交为 v1.0.0");
});

test("并发远程升级：新请求优先，旧慢下载后到不得覆盖", async () => {
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/slow-old`,
    ...signedRelease("v1.1.0"),
  });
  for (let i = 0; i < 40 && slowDownloadHits === 0; i++) await sleep(25);
  assert.equal(slowDownloadHits, 1, "旧请求已开始下载，构造真实后到竞态");

  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.2.0"),
  });
  assert.ok(await waitActive("v1.2.0"), "新请求先完成并提交");
  await sleep(2200); // 旧响应此时必已返回并完成验签；generation 应将其丢弃。
  assert.equal(readActive(), "v1.2.0", "旧下载晚到没有反向切回");
  assert.equal(existsSync(join(stack.home, "workers", "v1.1.0", "coflux-worker")), false, "过期下载没有晋升到正式路径");
  assert.ok(await isOnline(), "最终 daemon 仍在线");
  c.close();
});

test("anti-rollback 持久化：重启后降级与同版本重放均在下载前拒绝", async () => {
  const pidBeforeRestart = readWorkerPid();
  await stack.restartDaemon();
  assert.ok(await waitDaemonVersion("v1.2.0"), "重启后恢复已提交 release");
  assert.notEqual(readWorkerPid(), pidBeforeRestart);
  await sleep(2000);
  assert.equal(readFileSync(join(stack.home, "worker.release-floor"), "utf8").trim(), "v1.2.0");

  const pidBefore = readWorkerPid();
  const hitsBefore = requestHits.get("/good") ?? 0;
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.1.0"),
  });
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.2.0"),
  });
  await sleep(750);
  assert.equal(requestHits.get("/good") ?? 0, hitsBefore, "降级与重放均不发起网络下载");
  assert.equal(readActive(), "v1.2.0");
  assert.equal(readWorkerPid(), pidBefore, "被拒请求不重启 worker");
  c.close();
});

test("发布元数据篡改被拒：legacy raw 签名正确也不能伪造 version", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();
  const signed = signedRelease("v1.3.0");
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signed,
    version: "v1.3.1", // raw 签名仍合法，release statement 必须因 version 不同而失败
  });
  await sleep(1500);
  assert.equal(readActive(), activeBefore);
  assert.equal(readWorkerPid(), pidBefore);
  c.close();
});

test("跨 target 发布被拒：合法签名的其他架构也不下载/执行", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();
  const hitsBefore = requestHits.get("/good") ?? 0;
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.3.2", ARTIFACT, CROSS_TARGET),
  });
  await sleep(750);
  assert.equal(requestHits.get("/good") ?? 0, hitsBefore, "target 不匹配在网络前 fail closed");
  assert.equal(readActive(), activeBefore);
  assert.equal(readWorkerPid(), pidBefore);
  c.close();
});

test("篡改产物被拒：sha256 不符 → 不切换、保持当前版本、会话不受影响", async () => {
  const activeBefore = readActive();
  const { device, sessionId } = await runTaskWithMarker("TAMPER_MARK");
  const pidBefore = readWorkerPid();

  const c = device.control;
  // 下发被篡改的 url，但 sha256/signature 仍是原始产物的 → 校验必失败
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/tampered`,
    ...signedRelease("v1.4.0"),
  });

  await sleep(1500); // 给下载+验签线程足够时间（localhost 很快），它应当拒绝
  assert.equal(readActive(), activeBefore, "被拒后 worker.active 未变");
  assert.equal(readWorkerPid(), pidBefore, "worker 未重启（验签在切换前就失败）");
  assert.ok(await isOnline(), "daemon 仍在线");

  const restored = await device.attach(sessionId);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("TAMPER_MARK"), "篡改被拒后 snapshot 历史保留");
  const from = device.mark();
  await device.input(sessionId, "echo STILL_ALIVE\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("STILL_ALIVE"), "篡改被拒后会话仍存活", 10000, from);
  device.close();
});

test("签名不符被拒：产物合法但签名是别的数据 → 验签失败、保持当前版本", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();

  const c = stack.makeClient();
  await c.authSubscribe();
  // url=合法产物、sha256 正确，但 signature 是对别的字节签的 → 仅签名这关就挡住
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.5.0"),
    signature: sign(Buffer.from("not the artifact")),
  });

  await sleep(1500);
  assert.equal(readActive(), activeBefore, "签名不符被拒，worker.active 未变");
  assert.equal(readWorkerPid(), pidBefore, "worker 未重启");
  assert.ok(await isOnline(), "daemon 仍在线");
  c.close();
});

test("超大下载被拒：仅凭 Content-Length 即在读取前失败，不重启 worker", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();
  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/oversize-header`,
    ...signedRelease("v1.6.0"),
  });
  await sleep(750);
  assert.equal(readActive(), activeBefore, "超过 128 MiB 硬上限的声明未改变 active");
  assert.equal(readWorkerPid(), pidBefore, "拒绝发生在切换前，worker 未重启");
  assert.equal(existsSync(join(stack.home, "workers", "v1.6.0", "coflux-worker")), false, "未写入正式产物");
  c.close();
});
