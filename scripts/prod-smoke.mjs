/**
 * 生产冒烟：走真实 wire 协议 + Device opaque relay 驱动一轮最小端到端流程。
 *
 * 用法：
 *   COFLUX_SMOKE_TOKEN=<clientToken> [COFLUX_SMOKE_URL=wss://api.coflux.dev/client] \
 *   [COFLUX_SMOKE_DAEMON=<daemon 名>] [COFLUX_SMOKE_REPO=/opt/coflux] \
 *   node --import tsx scripts/prod-smoke.mjs
 *
 * 步骤：auth → subscribe → 等 daemon 在线 → 开 Device relay 通道 → 导入项目（prepared
 * projectValidate 由本客户端执行）→ 建任务 → 启动 session（prepared sessionCreate）→
 * sessiond catalog/attach 断言 → 输入回显 → resize 落到 PTY → 第二 logical client 接管
 * （断言 snapshot 续接 + 原端 detached）→ stop → 清理任务与项目。任一步失败即非零退出。
 *
 * 只用 relay：不做 loopback pair，因此不在生产留下 local grant（grant 只有 direct 需要）。
 * 结束时也不发 clientLogout——那会撤销 token 本身（见 hub.ts clientLogout），冒烟要能反复跑。
 *
 * 复用黑盒的两份客户端实现（harness.Client 控制面 + device-harness.DeviceClient Device 面），
 * 二者都只依赖 proto 生成物，不 import apps/*，所以冒烟仍是黑盒。
 */
import { randomUUID } from "node:crypto";
import { TaskStatus } from "../packages/protocol/src/index.ts";
import { Client } from "../tests/src/harness.mjs";
import { DeviceClient, utf8 } from "../tests/src/device-harness.mjs";

const URL_ = process.env.COFLUX_SMOKE_URL ?? "wss://api.coflux.dev/client";
const TOKEN = process.env.COFLUX_SMOKE_TOKEN;
const USER = process.env.COFLUX_SMOKE_USER; // 本地账号模式备选（token 优先）
const PASS = process.env.COFLUX_SMOKE_PASS;
const DAEMON_NAME = process.env.COFLUX_SMOKE_DAEMON; // 缺省取任一在线 daemon
const REPO = process.env.COFLUX_SMOKE_REPO ?? "/opt/coflux";
// Device relay 不校验 origin（那是 loopback gateway 的事），但 server 会记录，用可辨识的值。
const ORIGIN = process.env.COFLUX_SMOKE_ORIGIN ?? "https://smoke.coflux.dev";
if (!TOKEN && !(USER && PASS)) {
  console.error("缺 COFLUX_SMOKE_TOKEN（或 COFLUX_SMOKE_USER/PASS）");
  process.exit(2);
}

const steps = [];
const step = (name) => steps.push(name) && console.log(`▶ ${name}`);
const clients = [];

async function connect(label) {
  const client = new Client(0, { url: URL_, origin: ORIGIN });
  clients.push(client);
  const snapshot = TOKEN
    ? await client.authTokenSubscribe(TOKEN)
    : await client.authSubscribe(USER, PASS, "dev");
  console.log(`  ${label} 已认证`);
  return { client, snapshot };
}

/** relay-only Device：不调 initialize()（那会 pair 并落一条 grant），只开中心 relay 通道。 */
async function openRelay(control, daemonId) {
  const device = new DeviceClient({}, { control, daemonId, origin: ORIGIN });
  await device.openRelay();
  device.enablePreparedAutoExecution();
  return device;
}

function outputSince(device, from, sessionId) {
  return device.log
    .slice(from)
    .filter((m) => m.case === "ptyOutput" && m.sessionId === sessionId)
    .map((m) => utf8(m.data))
    .join("");
}

step("认证 + 订阅");
const { client: c1, snapshot } = await connect("c1");

step("等待 daemon 在线");
let daemon = snapshot.daemons.find((d) => d.online && (!DAEMON_NAME || d.name === DAEMON_NAME));
if (!daemon) {
  const updated = await c1.waitFor(
    (m) => m.case === "daemonUpdated" && m.daemon?.online && (!DAEMON_NAME || m.daemon.name === DAEMON_NAME),
    "daemon 上线",
    30000,
  );
  daemon = updated.daemon;
}
console.log(`  daemon: ${daemon.name} (${daemon.daemonId})`);

step("打开 Device opaque relay 通道");
const A = await openRelay(c1, daemon.daemonId);

step(`导入项目 ${REPO}`);
const projectName = "smoke-" + Date.now();
c1.send({ case: "projectImport", daemonId: daemon.daemonId, path: REPO, name: projectName });
const project = (await c1.waitFor((m) => m.case === "projectCreated" && m.project?.name === projectName, "projectCreated", 30000)).project;
const workspace = (await c1.waitFor((m) => m.case === "workspaceCreated" && m.workspace?.projectId === project.id, "workspaceCreated", 30000)).workspace;

step("建任务并启动 session");
c1.send({ case: "taskCreate", workspaceId: workspace.id, title: "冒烟" });
const idle = await c1.waitFor((m) => m.case === "taskUpdated" && m.task?.workspaceId === workspace.id, "taskUpdated");
const taskId = idle.task.id;
c1.send({ case: "taskStart", taskId, cols: 120, rows: 32 });
const running = await c1.waitFor(
  (m) => m.case === "taskUpdated" && m.task?.id === taskId && m.task.status === TaskStatus.RUNNING,
  "task RUNNING",
  30000,
);
const sessionId = running.task.sessionId;
console.log(`  task ${taskId} session ${sessionId}`);

step("sessiond catalog + attach");
const catalog = await A.catalog();
if (!catalog.sessions.some((s) => s.sessionId === sessionId)) throw new Error("catalog 未包含新建 session");
const attached = await A.attach(sessionId, { cols: 120, rows: 32 });
if (!(attached.ansiSnapshot instanceof Uint8Array)) throw new Error("attach 未返回 ANSI snapshot");

step("终端输入回显");
const marker = "coflux-smoke-" + randomUUID().slice(0, 8);
let from = A.mark();
await A.input(sessionId, `echo ${marker}\r`);
await A.waitFor(() => outputSince(A, from, sessionId).includes(marker), "echo 标记回显", 20000, from);

step("resize 落到 PTY");
await A.resize(sessionId, 100, 40);
from = A.mark();
await A.input(sessionId, "stty size\r");
await A.waitFor(() => outputSince(A, from, sessionId).includes("40 100"), "stty size 反映 resize", 20000, from);

step("第二 logical client 接管");
const { client: c2 } = await connect("c2");
const B = await openRelay(c2, daemon.daemonId);
from = A.mark();
const takeover = await B.attach(sessionId, { cols: 100, rows: 40 });
if (!utf8(takeover.ansiSnapshot ?? new Uint8Array()).includes(marker)) throw new Error("接管方 snapshot 未续接接管前画面");
await A.waitFor((m) => m.case === "sessionDetached" && m.sessionId === sessionId, "原端 sessionDetached", 15000, from);

step("停止 session");
const stopped = await B.stopSession(sessionId);
if (!stopped.ok) throw new Error("sessionStop 未成功：" + (stopped.error ?? "?"));
await c2.waitFor(
  (m) => m.case === "taskUpdated" && m.task?.id === taskId && m.task.status === TaskStatus.EXITED,
  "task EXITED",
  20000,
);

step("清理任务与项目");
c2.send({ case: "taskRemove", taskId });
await c2.waitFor((m) => m.case === "taskRemoved" && m.taskId === taskId, "taskRemoved");
c2.send({ case: "projectRemove", projectId: project.id });
await c2.waitFor((m) => m.case === "projectRemoved" && m.projectId === project.id, "projectRemoved");

A.close();
B.close();
for (const client of clients) client.close();
console.log(`\n✅ 冒烟通过（${steps.length} 步全过）：${URL_}`);
process.exit(0);
