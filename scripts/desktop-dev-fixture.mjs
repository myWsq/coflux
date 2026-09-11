/**
 * 桌面 app 联调 fixture（plan 103，自 apps/macos/scripts/dev-fixture.mjs 迁出）：起一套隔离的真实
 * 中心 + daemon + relay（严格沿用黑盒 harness 的临时 HOME/DB/端口/进程组隔离，不碰真实环境），
 * 导入一个临时仓库、开一个终端，然后打印 fixture 信息。桌面 app 用
 * `pnpm -C apps/desktop dev` 配合 `COFLUX_SERVER_URL=ws://127.0.0.1:<port>/client` 连上来，
 * 就能在本机验证 direct / P2P / relay 三路（direct 用 lsof 看 Electron 与 coflux-worker 的
 * 127.0.0.1 ESTABLISHED）与中心停掉后的冷启动 attach。测试账号 admin/admin。Ctrl-C 完整清理。
 *
 * 环境变量：COFLUX_DESKTOP_TEST_PORT（默认 19873）、COFLUX_DESKTOP_PREVIEW_FIXTURE=1（额外在终端里起一个
 * HTTP 服务验证端口预览）、COFLUX_DESKTOP_FIXTURE_FILE（fixture JSON 落盘位置）。授权 / 同意 / 门禁三张页面
 * 由这套隔离中心自己直出（plan 107），地址是 `http://127.0.0.1:<port>/...`，不再需要单独的 Web。
 */
import { startStack, mkRepo } from "../tests/src/harness.mjs";
import { openRelayDevice } from "../tests/src/device-harness.mjs";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.COFLUX_DESKTOP_TEST_PORT ?? 19873);
const repo = mkRepo();
let stack;
let client;
let device;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  client?.close();
  device?.close();
  try { await stack?.stop(); } finally { repo.cleanup(); }
}
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });

try {
  stack = await startStack({
    port,
    strictCleanup: true,
    // 自动化宿主的 NO_COLOR=1 只针对工具日志，不能污染交互终端的颜色验收。
    daemonEnv: { NO_COLOR: undefined },
    // harness 默认不是 COFLUX_DEV，不能依赖服务端的生产 HTTPS 默认值。
    // 本隔离服务器只有 HTTP；预览门禁仍保留，门禁页由 server 自己直出（COFLUX_PUBLIC_URL 默认即本机监听地址）。
    serverEnv: {
      COFLUX_PROXY_SCHEME: "http",
      COFLUX_PROXY_HOST: "p.localhost",
      COFLUX_PROXY_PORT: String(port),
    },
  });
  device = await openRelayDevice(stack);
  client = device.control;
  client.subscribe((message) => { if (message.case === "error") console.error("fixture:", message.message); });
  const daemonId = stack.daemonId;
  client.send({ case: "deviceSetName", daemonId, name: "本机开发设备" });
  client.send({ case: "projectImport", daemonId, path: repo.dir, name: "coflux" });
  const { project } = await client.waitFor((message) => message.case === "projectCreated", "导入项目");
  const { workspace } = await client.waitFor((message) => message.case === "workspaceCreated" && message.workspace.projectId === project.id, "主工作区");
  client.send({ case: "taskCreate", workspaceId: workspace.id, title: "终端 1" });
  const { task } = await client.waitFor((message) => message.case === "taskUpdated", "首个终端");
  client.send({ case: "workspaceCreate", projectId: project.id, name: "桌面客户端", branch: "desktop-ui", createNew: true });
  await client.waitFor((message) => message.case === "workspaceCreated" && message.workspace.branch === "desktop-ui", "分支工作区");
  if (process.env.COFLUX_DESKTOP_PREVIEW_FIXTURE === "1") {
    // HTTP 进程必须在真实 PTY 内启动，才能走与用户相同的端口探测/预览链路。
    writeFileSync(resolve(repo.dir, "preview-server.cjs"),
      'require("node:http").createServer((req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>coflux 桌面预览验收</title><h1>桌面端口预览已连通</h1><p>PREVIEW_DESKTOP_103</p>");}).listen(18091,"127.0.0.1");\n');
    client.send({ case: "taskStart", taskId: task.id, cols: 100, rows: 30 });
    const running = await client.waitFor((message) => message.case === "taskUpdated" && message.task.id === task.id && message.task.sessionId, "预览终端启动");
    await device.attach(running.task.sessionId);
    await device.input(running.task.sessionId, "node preview-server.cjs\r");
    await client.waitFor((message) => message.case === "portsUpdated" && message.taskId === task.id && message.ports.some((item) => item.port === 18091), "预览端口发现", 20000);
  }
  const fixture = { port, serverURL: `ws://127.0.0.1:${port}/client`, gatewayPort: device.gateway.port, daemonId, projectId: project.id, workspaceId: workspace.id, taskId: task.id };
  writeFileSync(resolve(process.env.COFLUX_DESKTOP_FIXTURE_FILE ?? "/tmp/coflux-desktop-103-fixture.json"), JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
  console.log(`隔离联调环境已就绪：桌面 app 用 COFLUX_SERVER_URL=ws://127.0.0.1:${port}/client pnpm -C apps/desktop dev 连上；测试账号 admin/admin。Ctrl-C 完整清理。`);
  // WebSocket 与子进程保持事件循环；没有后台重启或系统服务安装。
} catch (error) {
  await stop();
  throw error;
}
