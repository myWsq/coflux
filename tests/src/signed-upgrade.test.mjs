import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";

// 远程下载 + ed25519 验签的验收。头等用例是负向：被篡改 / 签名不符的产物必须被拒、保持当前版本。
// 隔离：临时 127.0.0.1 HTTP server 服务产物（零外网）；临时 ed25519，公钥经 env 注入 supervisor；
// 下载产物落临时 COFLUX_HOME；不跑 launcher。
const PORT = 8829;
const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER_BIN = process.env.COFLUX_WORKER_BIN || join(ROOT, "target", "debug", "coflux-worker");

// 临时 ed25519：公钥(hex)注入 supervisor，私钥签产物
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBKEY_HEX = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
const sign = (buf) => crypto.sign(null, buf, privateKey).toString("hex");
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const ARTIFACT = readFileSync(WORKER_BIN); // 用真 worker 二进制当"新版本产物"
const TAMPERED = Buffer.from(ARTIFACT);
TAMPERED[0] ^= 0xff; // 改一个字节

let stack;
let httpServer;
let baseUrl;
const repos = [];

before(async () => {
  httpServer = http.createServer((req, res) => {
    if (req.url === "/good") return void res.writeHead(200).end(ARTIFACT);
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
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    let pid;
    try { pid = readWorkerPid(); } catch { continue; }
    if (pid !== prevPid && (await isOnline())) return pid;
  }
  return 0;
}
async function runTaskWithMarker(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const a = stack.makeClient();
  await a.authSubscribe();
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "su" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "su", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  a.send({ case: "ptyInput", sessionId, data: `echo ${marker}\r` });
  await a.waitFor((m) => m.case === "ptyOutput" && m.data.includes(marker), "marker");
  a.close();
  return { taskId, sessionId };
}

test("远程下载 + 验签：合法签名产物升级成功、会话存活", async () => {
  assert.equal(readActive(), "builtin");
  const { taskId, sessionId } = await runTaskWithMarker("SIGNED_OK");
  const pid1 = readWorkerPid();

  const c = stack.makeClient();
  await c.authSubscribe();
  c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "dl-good", url: `${baseUrl}/good`, sha256: sha256hex(ARTIFACT), signature: sign(ARTIFACT) });

  assert.ok(await waitNewWorker(pid1), "下载验签通过后新 worker 起来且在线");
  let committed = false;
  for (let i = 0; i < 40 && !committed; i++) {
    await sleep(250);
    try { committed = readActive() === "dl-good"; } catch { /* 文件瞬时缺失 */ }
  }
  assert.ok(committed, "验签产物升级提交，worker.active=dl-good");

  c.send({ case: "taskAttach", taskId });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("SIGNED_OK"), "升级后回放历史");
  c.send({ case: "ptyInput", sessionId, data: "echo AFTER_SIGNED\r" });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("AFTER_SIGNED"), "升级后交互恢复");
  c.close();
});

test("篡改产物被拒：sha256 不符 → 不切换、保持当前版本、会话不受影响", async () => {
  const activeBefore = readActive();
  const { taskId, sessionId } = await runTaskWithMarker("TAMPER_MARK");
  const pidBefore = readWorkerPid();

  const c = stack.makeClient();
  await c.authSubscribe();
  // 下发被篡改的 url，但 sha256/signature 仍是原始产物的 → 校验必失败
  c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "dl-tampered", url: `${baseUrl}/tampered`, sha256: sha256hex(ARTIFACT), signature: sign(ARTIFACT) });

  await sleep(1500); // 给下载+验签线程足够时间（localhost 很快），它应当拒绝
  assert.equal(readActive(), activeBefore, "被拒后 worker.active 未变");
  assert.equal(readWorkerPid(), pidBefore, "worker 未重启（验签在切换前就失败）");
  assert.ok(await isOnline(), "daemon 仍在线");

  // 会话不受影响：attach 接管后仍能回放 + 交互
  c.send({ case: "taskAttach", taskId });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("TAMPER_MARK"), "篡改被拒后回放历史");
  c.send({ case: "ptyInput", sessionId, data: "echo STILL_ALIVE\r" });
  await c.waitFor((m) => m.case === "ptyOutput" && m.data.includes("STILL_ALIVE"), "篡改被拒后会话仍存活");
  c.close();
});

test("签名不符被拒：产物合法但签名是别的数据 → 验签失败、保持当前版本", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();

  const c = stack.makeClient();
  await c.authSubscribe();
  // url=合法产物、sha256 正确，但 signature 是对别的字节签的 → 仅签名这关就挡住
  c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "dl-badsig", url: `${baseUrl}/good`, sha256: sha256hex(ARTIFACT), signature: sign(Buffer.from("not the artifact")) });

  await sleep(1500);
  assert.equal(readActive(), activeBefore, "签名不符被拒，worker.active 未变");
  assert.equal(readWorkerPid(), pidBefore, "worker 未重启");
  assert.ok(await isOnline(), "daemon 仍在线");
  c.close();
});
