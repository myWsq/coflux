import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openRelayDevice, utf8 } from "./device-harness.mjs";

// 热升级：升级投递（client.upgradeDaemon → server → worker.upgrade → supervisor）
// + 切换 + 观察期/回滚。会话全程在 supervisor 存活。不接下载/验签（按安全约束，仅在
// supervisor 自有注册表的"已知版本"间切换）。
const PORT = 8828;
const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER_BIN = process.env.COFLUX_WORKER_BIN || join(ROOT, "target", "debug", "coflux-worker");
const REQUEST_ONLY_WORKER = `
const net = require("node:net");
const socket = net.connect(process.env.COFLUX_SUPERVISOR_SOCK, () => {
  const payload = Buffer.from(JSON.stringify({ type: "resync.request" }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  socket.write(Buffer.concat([header, payload]));
});
socket.on("data", () => {});
setInterval(() => {}, 1000);
`;
const BLIND_ACK_WORKER = `
const net = require("node:net");
const socket = net.connect(process.env.COFLUX_SUPERVISOR_SOCK, () => {
  const payload = Buffer.from(JSON.stringify({ type: "resync.applied", nonce: "00000000000000000000000000000000" }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  socket.write(Buffer.concat([header, payload]));
});
socket.on("data", () => {});
setInterval(() => {}, 1000);
`;

// 注入两个测试版本：good2 = 真 worker 的副本（应升级成功并提交）；bad2 = 立即崩溃（应回滚）
const SPECS = {
  good2: { cmd: WORKER_BIN, args: [] },
  bad2: { cmd: process.execPath, args: ["-e", "process.exit(1)"] },
  // 进程一直活着但从不连接 supervisor UDS；只看存活的旧观察期会错误提交它。
  noresync: { cmd: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
  // 会接管 UDS、请求并读取 resync.list，但从不回 resync.applied；“成功入队”仍不等于恢复。
  requestOnly: { cmd: process.execPath, args: ["-e", REQUEST_ONLY_WORKER] },
  // 不读取 challenge 就盲回 ACK；固定 nonce 不得碰巧通过候选健康检查。
  blindAck: { cmd: process.execPath, args: ["-e", BLIND_ACK_WORKER] },
};

let stack;
const repos = [];

before(async () => {
  stack = await startStack({
    port: PORT,
    daemonEnv: { COFLUX_WORKER_SPECS: JSON.stringify(SPECS), COFLUX_WORKER_PROBATION_MS: "1500" },
  });
});
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

function readActive() {
  return readFileSync(join(stack.home, "worker.active"), "utf8").trim();
}
function readWorkerPid() {
  return Number(readFileSync(join(stack.home, "worker.pid"), "utf8").trim());
}
async function readDaemonState() {
  const p = stack.makeClient();
  try {
    const snap = await p.authSubscribe();
    return snap.daemons.find((d) => d.daemonId === stack.daemonId);
  } catch {
    return undefined;
  } finally {
    p.close();
  }
}

/**
 * 证明一次 worker 切换真正收敛：
 * 1) 升级前建立独立 observer，只接收本次触发后的 daemonUpdated；
 * 2) 必须先看到旧 daemon 离线，再看到目标 workerVersion 的新连接上线；
 * 3) worker.pid 必须变化，最后用新鲜 snapshot 再确认当前映射仍是目标版本。
 *
 * 单纯“PID 变化 + snapshot.online”不够：PID 可能已更新，而 snapshot 仍来自尚未清掉的旧 WS。
 */
async function waitWorkerReconnect(prevPid, expectedVersion, trigger, label) {
  const observer = stack.makeClient();
  await observer.authSubscribe();
  let sawOffline = false;
  const trail = [];
  let timer;
  const transition = new Promise((resolveTransition, rejectTransition) => {
    const unsubscribe = observer.subscribe((m) => {
      if (m.case !== "daemonUpdated" || m.daemon.daemonId !== stack.daemonId) return;
      trail.push((m.daemon.online ? "online" : "offline") + ":" + (m.daemon.workerVersion || "-"));
      if (!m.daemon.online) {
        sawOffline = true;
        return;
      }
      if (sawOffline && m.daemon.workerVersion === expectedVersion) {
        unsubscribe();
        resolveTransition(m.daemon);
      }
    });
    timer = setTimeout(() => {
      unsubscribe();
      rejectTransition(new Error(label + ": 未观察到 offline → online:" + expectedVersion + "，事件=" + (trail.join(",") || "无")));
    }, 30000);
  });

  try {
    await trigger();
    const connected = await transition;
    assert.equal(connected.online, true);
    assert.equal(connected.workerVersion, expectedVersion);

    let pid = prevPid;
    for (let i = 0; i < 40 && pid === prevPid; i++) {
      await sleep(50);
      try { pid = readWorkerPid(); } catch { /* worker.pid 正在原子更新 */ }
    }
    assert.notEqual(pid, prevPid, label + ": 目标连接必须来自新 worker 进程");

    let converged;
    for (let i = 0; i < 40; i++) {
      converged = await readDaemonState();
      if (converged?.online && converged.workerVersion === expectedVersion) break;
      await sleep(100);
    }
    assert.equal(converged?.online, true, label + ": 新鲜 snapshot 应在线");
    assert.equal(converged?.workerVersion, expectedVersion, label + ": 新鲜 snapshot 应收敛到目标版本");
    return pid;
  } finally {
    clearTimeout(timer);
    observer.close();
  }
}

// 起一个运行中的任务并打个 marker，返回 {taskId, sessionId}
async function runTaskWithMarker(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openRelayDevice(stack);
  const a = device.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "up" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "up", "idle");
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

test("热升级成功：切到 good2、观察期通过提交，会话存活", async () => {
  assert.equal(readActive(), "builtin", "初始版本 builtin");
  const { device, sessionId, holderEpoch } = await runTaskWithMarker("UP_OK_MARK");
  const pid1 = readWorkerPid();

  const c = device.control;
  const pid2 = await waitWorkerReconnect(
    pid1,
    "good2",
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "good2" }),
    "升级 good2",
  );
  assert.ok(pid2, "升级后新 worker 起来且在线");
  // 等观察期通过、提交为 good2（PROBATION_MS=1500）
  let committed = false;
  for (let i = 0; i < 40 && !committed; i++) {
    await sleep(250);
    try { committed = readActive() === "good2"; } catch { /* 文件可能瞬时缺失 */ }
  }
  assert.ok(committed, "升级提交后 worker.active=good2");

  // 会话存活：新 worker 上建立更高 generation relay，sessiond holder 与 snapshot 均保留。
  await device.openRelay();
  const restored = await device.attach(sessionId);
  assert.equal(restored.holderEpoch, holderEpoch);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("UP_OK_MARK"), "升级后 snapshot 保留历史");
  const from = device.mark();
  await device.input(sessionId, "echo AFTER_UPGRADE\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_UPGRADE"), "升级后交互恢复", 10000, from);
  device.close();
});

test("坏版本回滚：切到 bad2 崩溃循环 → 自动回滚，会话存活", async () => {
  const activeBefore = readActive(); // 上一个测试后应为 good2
  const { device, sessionId, holderEpoch } = await runTaskWithMarker("ROLLBACK_MARK");
  const pidBefore = readWorkerPid();

  const c = device.control;
  // bad2 立即崩溃 → 达阈值回滚到 activeBefore → 新 good worker 起来（bad2 不写 pid，故 pid 变化=回滚后的好版本）
  const rollbackPid = await waitWorkerReconnect(
    pidBefore,
    activeBefore,
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "bad2" }),
    "bad2 回滚",
  );
  assert.ok(rollbackPid, "回滚后新 worker 起来且在线");
  // active 未变（bad2 从未通过观察期提交）
  assert.equal(readActive(), activeBefore, "回滚后 worker.active 仍是升级前版本");

  await device.openRelay();
  const restored = await device.attach(sessionId);
  assert.equal(restored.holderEpoch, holderEpoch);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("ROLLBACK_MARK"), "回滚后 snapshot 保留历史");
  const from = device.mark();
  await device.input(sessionId, "echo AFTER_ROLLBACK\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_ROLLBACK"), "回滚后交互恢复", 10000, from);
  device.close();
});

test("伪健康版本回滚：进程存活但未接管 UDS/resync，绝不提交", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();
  const c = stack.makeClient();
  await c.authSubscribe();
  // 两轮观察期都没有 resync 健康信号，supervisor 主动终止候选并回滚到已提交版本。
  const rollbackPid = await waitWorkerReconnect(
    pidBefore,
    activeBefore,
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "noresync" }),
    "noresync 回滚",
  );
  assert.ok(rollbackPid, "未接管 UDS 的存活进程被回滚，健康 worker 恢复在线");
  assert.equal(readActive(), activeBefore, "只存活不 resync 的候选从未写入 worker.active");
  c.close();
});

test("伪健康版本回滚：只请求/读取 resync 但未应用回执，绝不提交", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();
  const c = stack.makeClient();
  await c.authSubscribe();
  const rollbackPid = await waitWorkerReconnect(
    pidBefore,
    activeBefore,
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "requestOnly" }),
    "requestOnly 回滚",
  );
  assert.ok(rollbackPid, "未确认应用 resync 的候选被回滚，健康 worker 恢复在线");
  assert.equal(readActive(), activeBefore, "只把 resync.list 排入队列从未写入 worker.active");
  c.close();
});

test("伪健康版本回滚：盲回错误 nonce，绝不提交", async () => {
  const activeBefore = readActive();
  const pidBefore = readWorkerPid();
  const c = stack.makeClient();
  await c.authSubscribe();
  const rollbackPid = await waitWorkerReconnect(
    pidBefore,
    activeBefore,
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "blindAck" }),
    "blindAck 回滚",
  );
  assert.ok(rollbackPid, "未取得 challenge 的候选被回滚，健康 worker 恢复在线");
  assert.equal(readActive(), activeBefore, "错误 nonce 从未写入 worker.active");
  c.close();
});

test("重启恢复安全回退：worker.active 指向伪健康版本时最终启用 builtin", async () => {
  const pidBefore = readWorkerPid();
  // 模拟 supervisor 在 marker 已更新后异常退出，而候选实际无法接管 UDS。
  writeFileSync(join(stack.home, "worker.active"), "noresync");
  const fallbackPid = await waitWorkerReconnect(
    pidBefore,
    "builtin",
    () => stack.restartDaemon(),
    "重启恢复回退",
  );
  assert.ok(fallbackPid, "恢复候选两轮健康复检失败后 builtin 重新在线");
  assert.equal(readActive(), "builtin", "不可用持久化 active 已原子回退 builtin");
});
