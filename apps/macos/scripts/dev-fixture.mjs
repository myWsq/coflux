/** 本次 Web/native 对照环境：真实中心 + daemon + relay，严格沿用黑盒 harness 隔离。 */
import { startStack, mkRepo } from "../../../tests/src/harness.mjs";
import { openRelayDevice } from "../../../tests/src/device-harness.mjs";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.COFLUX_NATIVE_TEST_PORT ?? 19873);
const webURL = process.env.COFLUX_NATIVE_WEB_URL ?? "http://127.0.0.1:15273";
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
    // 本隔离服务器只有 HTTP；预览门禁仍保留，认证页指向同一隔离 Web。
    serverEnv: {
      COFLUX_PROXY_SCHEME: "http",
      COFLUX_PROXY_HOST: "p.localhost",
      COFLUX_PROXY_PORT: String(port),
      COFLUX_WEB_URL: webURL,
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
  client.send({ case: "workspaceCreate", projectId: project.id, name: "原生客户端", branch: "native-ui", createNew: true });
  await client.waitFor((message) => message.case === "workspaceCreated" && message.workspace.branch === "native-ui", "分支工作区");
  if (process.env.COFLUX_NATIVE_PREVIEW_FIXTURE === "1") {
    // HTTP 进程必须在真实 PTY 内启动，才能走与用户相同的端口探测/预览链路。
    writeFileSync(resolve(repo.dir, "preview-server.cjs"),
      'require("node:http").createServer((req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>Coflux 原生预览验收</title><h1>原生端口预览已连通</h1><p>PREVIEW_NATIVE_093</p>");}).listen(18091,"127.0.0.1");\n');
    client.send({ case: "taskStart", taskId: task.id, cols: 100, rows: 30 });
    const running = await client.waitFor((message) => message.case === "taskUpdated" && message.task.id === task.id && message.task.sessionId, "预览终端启动");
    await device.attach(running.task.sessionId);
    await device.input(running.task.sessionId, "node preview-server.cjs\r");
    await client.waitFor((message) => message.case === "portsUpdated" && message.taskId === task.id && message.ports.some((item) => item.port === 18091), "预览端口发现", 20000);
  }
  const fixture = { backendProfile: process.env.COFLUX_NATIVE_BACKEND_PROFILE ?? "custom-or-debug", port, webURL, serverURL: `ws://127.0.0.1:${port}/client`, gatewayPort: device.gateway.port, daemonId, projectId: project.id, workspaceId: workspace.id, taskId: task.id };
  writeFileSync(resolve(process.env.COFLUX_NATIVE_FIXTURE_FILE ?? "/tmp/coflux-native-093-fixture.json"), JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
  console.log("隔离对照环境已就绪；测试账号 admin/admin。Ctrl-C 完整清理。");
  // WebSocket 与子进程保持事件循环；没有后台重启或系统服务安装。
} catch (error) {
  await stop();
  throw error;
}
