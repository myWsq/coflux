/**
 * 生产冒烟：走真实 wire 协议驱动一轮最小端到端流程。
 *
 * 用法：
 *   COFLUX_SMOKE_TOKEN=<clientToken> [COFLUX_SMOKE_URL=wss://api.coflux.dev/client] \
 *   [COFLUX_SMOKE_DAEMON=<daemon 名>] [COFLUX_SMOKE_REPO=/opt/coflux] \
 *   node --import tsx scripts/prod-smoke.mjs
 *
 * 步骤：auth(clientToken) → subscribe → 等 daemon 在线 → 导入项目 → 建任务 →
 * 启动终端 → echo 标记串并断言回显 → 二连接 attach 断言 replay + 首连接 taskDetached →
 * 清理（移除任务与项目）。任一步失败即非零退出。
 */
import {
  create,
  ClientToServerSchema,
  encodeClientToServer,
  decodeServerToClient,
  TaskStatus,
} from "../packages/protocol/src/index.ts";

const URL_ = process.env.COFLUX_SMOKE_URL ?? "wss://api.coflux.dev/client";
const TOKEN = process.env.COFLUX_SMOKE_TOKEN;
const USER = process.env.COFLUX_SMOKE_USER; // 本地账号模式备选（token 优先）
const PASS = process.env.COFLUX_SMOKE_PASS;
const DAEMON_NAME = process.env.COFLUX_SMOKE_DAEMON; // 缺省取任一在线 daemon
const REPO = process.env.COFLUX_SMOKE_REPO ?? "/opt/coflux";
if (!TOKEN && !(USER && PASS)) {
  console.error("缺 COFLUX_SMOKE_TOKEN（或 COFLUX_SMOKE_USER/PASS）");
  process.exit(2);
}
// clientVersion "dev" 走版本准入的放行通道（plan 033）——本脚本是运维工具，不是受管 bundle
const AUTH = { clientVersion: "dev", ...(TOKEN ? { clientToken: TOKEN } : { username: USER, password: PASS }) };

const td = new TextDecoder();
const te = new TextEncoder();

class SmokeClient {
  constructor(url) {
    this.log = [];
    this.waiters = [];
    this.out = ""; // 累积的 pty 输出（解码后）
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error("ws error: " + (e?.message ?? "?")));
    });
    this.ws.onmessage = (ev) => {
      let env;
      try {
        env = decodeServerToClient(new Uint8Array(ev.data));
      } catch {
        return;
      }
      const p = env?.payload;
      if (!p?.case) return;
      if (p.case === "ptyOutput") this.out += td.decode(p.value.data, { stream: true });
      this.log.push(p);
      this.waiters = this.waiters.filter((w) => !w.try(p));
    };
  }
  send(c, value = {}) {
    this.ws.send(encodeClientToServer(create(ClientToServerSchema, { payload: { case: c, value } })));
  }
  waitFor(pred, label, timeout = 15000) {
    const hit = this.log.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("超时等待 " + label)), timeout);
      this.waiters.push({ try: (p) => (pred(p) ? (clearTimeout(t), res(p), true) : false) });
    });
  }
  waitOutput(sub, label, timeout = 15000) {
    if (this.out.includes(sub)) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("超时等待输出 " + label)), timeout);
      this.waiters.push({
        try: (p) => (p.case === "ptyOutput" && this.out.includes(sub) ? (clearTimeout(t), res(), true) : false),
      });
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const steps = [];
const step = (name) => steps.push(name) && console.log(`▶ ${name}`);

const c1 = new SmokeClient(URL_);
await c1.ready;

step("认证 + 订阅");
c1.send("clientAuth", AUTH);
const auth = await Promise.race([
  c1.waitFor((p) => p.case === "authOk", "authOk"),
  c1.waitFor((p) => p.case === "authError", "authError").then((p) => {
    throw new Error("认证失败: " + p.value.message);
  }),
]);
c1.send("clientSubscribe");
const snap = (await c1.waitFor((p) => p.case === "stateSnapshot", "stateSnapshot")).value;

step("等待 daemon 在线");
let daemon = snap.daemons.find((d) => d.online && (!DAEMON_NAME || d.name === DAEMON_NAME));
if (!daemon) {
  const upd = await c1.waitFor(
    (p) => p.case === "daemonUpdated" && p.value.daemon?.online && (!DAEMON_NAME || p.value.daemon.name === DAEMON_NAME),
    "daemon 上线",
    30000,
  );
  daemon = upd.value.daemon;
}
console.log(`  daemon: ${daemon.name} (${daemon.daemonId})`);

step(`导入项目 ${REPO}`);
c1.send("projectImport", { daemonId: daemon.daemonId, path: REPO, name: "smoke-" + Date.now() });
const project = (await c1.waitFor((p) => p.case === "projectCreated" && p.value.project?.name.startsWith("smoke-"), "projectCreated")).value.project;
const ws = (await c1.waitFor((p) => p.case === "workspaceCreated" && p.value.workspace?.projectId === project.id, "workspaceCreated")).value.workspace;

step("建任务并启动终端");
c1.send("taskCreate", { workspaceId: ws.id, title: "冒烟" });
const task = (await c1.waitFor((p) => p.case === "taskUpdated" && p.value.task?.workspaceId === ws.id, "taskUpdated")).value.task;
c1.send("taskStart", { taskId: task.id, cols: 120, rows: 32 });
await c1.waitFor(
  (p) => p.case === "taskUpdated" && p.value.task?.id === task.id && p.value.task.status === TaskStatus.RUNNING,
  "task RUNNING",
  30000,
);
const running = c1.log.findLast((p) => p.case === "taskUpdated" && p.value.task?.id === task.id).value.task;
console.log(`  task ${task.id} session ${running.sessionId}`);

step("终端回显断言");
const marker = "coflux-smoke-" + Math.random().toString(36).slice(2, 10);
c1.send("ptyInput", { sessionId: running.sessionId, data: te.encode(`echo ${marker}\r`) });
await c1.waitOutput(marker, "echo 标记回显", 20000);

step("第二连接 attach：replay + 独占接管");
const c2 = new SmokeClient(URL_);
await c2.ready;
c2.send("clientAuth", AUTH);
await c2.waitFor((p) => p.case === "authOk", "authOk#2");
c2.send("clientSubscribe");
await c2.waitFor((p) => p.case === "stateSnapshot", "snapshot#2");
c2.send("taskAttach", { taskId: task.id });
await c2.waitOutput(marker, "replay 含标记", 20000);
await c1.waitFor((p) => p.case === "taskDetached" && p.value.taskId === task.id, "首连接 taskDetached");

step("清理任务与项目");
c2.send("taskStop", { taskId: task.id });
await c2.waitFor(
  (p) => p.case === "taskUpdated" && p.value.task?.id === task.id && p.value.task.status === TaskStatus.EXITED,
  "task EXITED",
  20000,
);
c2.send("taskRemove", { taskId: task.id });
await c2.waitFor((p) => p.case === "taskRemoved" && p.value.taskId === task.id, "taskRemoved");
c2.send("projectRemove", { projectId: project.id });
await c2.waitFor((p) => p.case === "projectRemoved" && p.value.projectId === project.id, "projectRemoved");

c1.close();
c2.close();
console.log(`\n✅ 冒烟通过（${steps.length} 步全过）：${URL_}`);
process.exit(0);
