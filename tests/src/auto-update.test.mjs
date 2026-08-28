import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, arch } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo, rawDaemon, tokenFromUrl } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";
import { workerReleaseStatement } from "../../scripts/release-statement.mjs";

// server 自动编排（plan 015）：本地 http server 同时扮演 GitHub releases API 与产物下载端，
// server 以 COFLUX_AUTOUPDATE_API_BASE/COFLUX_AUTOUPDATE_REPO 指向它。断言两件事：
// 1) daemon 上线后无任何手动触发，worker 自动升级到 mock release 声明的版本，会话不死；
// 2) 验签失败的坏版本被反复推送时，退避生效——推送次数封顶在 COFLUX_AUTOUPDATE_MAX_ATTEMPTS。
const PORT = 8835;
const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER_BIN = process.env.COFLUX_WORKER_BIN || join(ROOT, "target", "debug", "coflux-worker");

// 临时 ed25519：公钥(hex)注入 supervisor，私钥签"好"产物（照抄 signed-upgrade.test.mjs）
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBKEY_HEX = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
const sign = (buf) => crypto.sign(null, buf, privateKey).toString("hex");
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const ARTIFACT = readFileSync(WORKER_BIN); // 用真 worker 二进制当"新版本产物"

// server 侧 auto-update.ts 的 rustTarget(platform, arch) 用 Rust 命名（macos/linux、aarch64/x86_64）；
// 这里用 Node 命名算出同一台机器对应的 target 字符串（同 packages/cli/cofluxd.mjs 的 rustTarget()），
// 两套映射表对同一物理机产出同一个 target，manifest 用这个 key 才会被 maybeUpgrade 命中。
function hostRuntime() {
  const p = platform(), a = arch();
  if (p === "darwin") {
    return a === "arm64"
      ? { target: "aarch64-apple-darwin", platform: "macos", arch: "aarch64" }
      : { target: "x86_64-apple-darwin", platform: "macos", arch: "x86_64" };
  }
  if (p === "linux") {
    return a === "arm64"
      ? { target: "aarch64-unknown-linux-musl", platform: "linux", arch: "aarch64" }
      : { target: "x86_64-unknown-linux-musl", platform: "linux", arch: "x86_64" };
  }
  throw new Error(`unsupported test host platform: ${p}/${a}`);
}
const HOST = hostRuntime();
const TARGET = HOST.target;
const REPO = "acme/coflux-test";

function releaseFor(tag, overrides = {}) {
  const sha256 = sha256hex(ARTIFACT);
  const size = ARTIFACT.byteLength;
  const target = TARGET;
  return {
    tag,
    url: null,
    target,
    sha256,
    size,
    signature: sign(ARTIFACT),
    releaseSignature: sign(workerReleaseStatement({ version: tag, target, sha256, size })),
    ...overrides,
  };
}

let stack;
let httpServer;
let baseUrl;
const repos = [];
// 可变的 mock release 状态：测试 2 切换到坏版本时改这里，poll 立即拿到新值
let release = releaseFor("v1.2.3");

before(async () => {
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === `/repos/${REPO}/releases/latest`) {
      const body = JSON.stringify({ tag_name: release.tag, assets: [{ name: "manifest.json", browser_download_url: `${baseUrl}/manifest.json` }] });
      return void res.writeHead(200, { "content-type": "application/json" }).end(body);
    }
    if (url.pathname === "/manifest.json") {
      const body = JSON.stringify({
        schemaVersion: 2,
        version: release.tag,
        worker: {
          [TARGET]: {
            url: release.url,
            target: release.target,
            sha256: release.sha256,
            size: release.size,
            signature: release.signature,
            releaseSignature: release.releaseSignature,
          },
        },
      });
      return void res.writeHead(200, { "content-type": "application/json" }).end(body);
    }
    if (url.pathname === "/good") return void res.writeHead(200).end(ARTIFACT);
    res.writeHead(404).end();
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  release = releaseFor("v1.2.3", { url: `${baseUrl}/good` });

  stack = await startStack({
    port: PORT,
    serverEnv: {
      COFLUX_AUTOUPDATE_API_BASE: baseUrl,
      COFLUX_AUTOUPDATE_REPO: REPO,
      COFLUX_AUTOUPDATE_POLL_MS: "400",
      COFLUX_AUTOUPDATE_MAX_ATTEMPTS: "3",
      // 旧 server 会读该 env 并在 1s 后重开配额；新实现故意忽略已废弃的 cooldown。
      COFLUX_AUTOUPDATE_COOLDOWN_MS: "1000",
    },
    daemonEnv: { COFLUX_WORKER_PUBKEY: PUBKEY_HEX, COFLUX_WORKER_PROBATION_MS: "800" },
  });
});
after(async () => {
  await stack?.stop();
  httpServer?.close();
  repos.forEach((r) => r.cleanup());
});

function readActive() {
  return readFileSync(join(stack.home, "worker.active"), "utf8").trim();
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
async function waitActive(version, tries = 120) {
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    try {
      if (readActive() === version) return true;
    } catch {
      /* 文件瞬时缺失 */
    }
  }
  return false;
}

/** 注册一个不接 supervisor 的轻量 daemon，直接观察 server→daemon 的升级帧。
 * 它只充当派发边界探针，不执行下载，因此断言不受 supervisor latest-only mailbox 合并影响。 */
async function openUpgradeDispatchObserver(workerVersion) {
  const daemon = rawDaemon(PORT);
  const authorizer = stack.makeClient();
  try {
    await Promise.all([daemon.ready, authorizer.authSubscribe()]);
    daemon.send({
      case: "daemonEnrollRequest",
      name: "auto-update-observer",
      host: "localhost",
      platform: HOST.platform,
      workerVersion,
      supervisorVersion: "test-supervisor",
      arch: HOST.arch,
    });
    const pending = await daemon.waitFor((m) => m.case === "daemonAuthorizePending", "observer authorizePending");
    authorizer.send({ case: "deviceAuthorize", token: tokenFromUrl(pending.url) });
    await authorizer.waitFor((m) => m.case === "deviceAuthorized", "observer deviceAuthorized");
    await daemon.waitFor((m) => m.case === "daemonEnrolled", "observer daemonEnrolled");
    return { daemon, authorizer };
  } catch (error) {
    daemon.close();
    authorizer.close();
    throw error;
  }
}

async function runTaskWithMarker(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openRelayDevice(stack);
  const a = device.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "au" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "au", "idle");
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

test("release 发布后在线 daemon 无需手动触发即自动升级，会话不死", async () => {
  // 注意：不断言"升级前是 builtin"——onDaemonHandshake 与 startStack() 判定"daemon 在线"是
  // 同一事件触发，自动推送可能在测试代码跑到这里之前就已下发/提交，断言初始版本必然竞态。
  // 核心事实只有两条：(a) 最终收敛到 release 版本、全程无手动 clientUpgradeDaemon；
  // (b) 升级前创建的会话数据在升级后仍可回放 + 交互，与升级实际发生的精确时刻无关。
  const { device, sessionId, holderEpoch } = await runTaskWithMarker("AUTOUP_MARK");

  assert.ok(await waitActive("v1.2.3"), "server 自动轮询到 release 后无手动 clientUpgradeDaemon 也推送并提交升级");
  assert.ok(await isOnline(), "升级后 daemon 仍在线");

  await device.openRelay();
  const restored = await device.attach(sessionId);
  assert.equal(restored.holderEpoch, holderEpoch);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("AUTOUP_MARK"), "自动升级后 snapshot 保留历史");
  const from = device.mark();
  await device.input(sessionId, "echo AFTER_AUTOUP\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_AUTOUP"), "自动升级后交互恢复", 10000, from);
  device.close();
});

test("坏版本反复推送被退避封顶：推送次数不超过 COFLUX_AUTOUPDATE_MAX_ATTEMPTS", async () => {
  const activeBefore = readActive(); // 上一测试后应为 v1.2.3
  const observer = await openUpgradeDispatchObserver("v1.2.3");
  try {
    // 切到一个验签必失败的版本：真实 daemon 会拒绝它；轻量 observer 则在 server 派发边界
    // 直接计数 workerUpgrade 帧，不把 supervisor 合并后的实际下载次数误当成派发次数。
    const badVersion = "v9.9.9-bad";
    release = releaseFor(badVersion, {
      url: `${baseUrl}/good`,
      releaseSignature: sign(Buffer.from("not the release statement")),
    });
    const dispatchCount = () => observer.daemon.log.filter((m) => m.case === "workerUpgrade" && m.version === badVersion).length;

    await observer.daemon.waitFor(
      (m) => m.case === "workerUpgrade" && m.version === badVersion && dispatchCount() === 3,
      "observer third workerUpgrade",
      10000,
    );

    // 已确认前三次真实派发后，再跨过多个旧冷却周期；配额必须按 daemon+version 永久封顶，
    // 而不是随时间重开。旧实现会在这段窗口继续给 observer 下发第 4 次及更多帧。
    await sleep(400 * 12);
    assert.equal(dispatchCount(), 3, "累计派发三次后永久封顶，跨冷却期也不重开配额");
    assert.equal(readActive(), activeBefore, "验签失败从未切换版本");
    assert.ok(await isOnline(), "daemon 仍在线");
  } finally {
    observer.daemon.close();
    observer.authorizer.close();
  }
});
