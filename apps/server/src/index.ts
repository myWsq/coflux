/**
 * coflux 中心服务器 serve 入口。
 *
 * HTTP 应用层由 RavenJS 承载（组合根在 app.ts：插件装配 Store/Hub，/health 走契约路由）；
 * 本文件只负责传输层：ready() → Node http 服务器（预览域反代按 Host 分流）→
 * WS 升级（/daemon、/client）→ 心跳 → 信号/兜底。
 */
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { getRequestListener } from "@hono/node-server";
import { currentAppStorage } from "@raven.js/core";
import { createLogger } from "@coflux/core";
import { decodeDaemonToServer, decodeClientToServer } from "@coflux/protocol";
import { config } from "./config.js";
import { app } from "./app.js";
import { StoreState } from "./plugins/store.plugin.js";
import { HubState } from "./plugins/hub.plugin.js";
import type { ClientConn, DaemonCtx } from "./hub.js";
import { attachEndpoint } from "./transport.js";
import { matchProxyHost, handleProxyRequest, handleProxyUpgrade, type ProxyServerContext } from "./proxy.js";
import { AutoUpdater } from "./auto-update.js";

const log = createLogger("server");

const fetchHandler = await app.ready();
// WS 消息/关闭回调与 shutdown 都运行在 HTTP 请求上下文之外（无 ALS 环境），
// 在 app 上下文里一次性取出实例引用，后续直接闭包消费。
const { store, hub } = currentAppStorage.run(app, () => ({
  store: StoreState.getOrFailed(),
  hub: HubState.getOrFailed(),
}));
// hub 结构性满足 ProxyServerContext（routeTable/proxyGate/tunnels 三个只读字段）；proxy.ts 不反向导入 Hub，
// 避免 hub.ts ⇄ proxy.ts 循环依赖（见 plan 006 决策：依赖倒置）。
const proxyCtx: ProxyServerContext = hub;

const listener = getRequestListener(fetchHandler);
const httpServer = http.createServer((req, res) => {
  // Host 命中 <shortId>.<proxyHost> 的请求走端口转发反代（整条 TCP 原始字节级接管，见 proxy.ts），
  // 必须在进 fetch 适配器之前分流；其余 HTTP 全部交给 Raven 应用层（/health + 默认 404）。
  if (matchProxyHost(req.headers.host)) {
    void handleProxyRequest(proxyCtx, req, res);
    return;
  }
  void listener(req, res);
});

const wssOpts = { noServer: true as const, maxPayload: config.maxPayload, perMessageDeflate: false };
const daemonWss = new WebSocketServer(wssOpts);
const clientWss = new WebSocketServer(wssOpts);

httpServer.on("upgrade", (req, socket, head) => {
  if (matchProxyHost(req.headers.host)) {
    void handleProxyUpgrade(proxyCtx, req, socket, head);
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/daemon") {
    daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit("connection", ws, req));
  } else if (pathname === "/client") {
    clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

const daemonEp = attachEndpoint(daemonWss, {
  makeCtx: (ws: WebSocket): DaemonCtx => ({ ws, daemonId: null, accountId: null }),
  isAuthed: (c) => c.daemonId !== null,
  // 等浏览器授权的 daemon（已发 enrollRequest、持有 pending token）是合法未认证态，
  // 不能被 auth deadline 踢——否则每 15s 断连重连、授权链接无限换新（生产实测踩过）。
  // 存活边界：pending 有 TTL（worker 到期续期）、断线即作废，heartbeat 扫描照常适用。
  canWaitAuth: (c) => !!c.pendingAuthToken,
  decode: decodeDaemonToServer,
  onMessage: (c, m) => hub.handleDaemonMessage(c, m),
  onClose: (c) => hub.handleDaemonClose(c),
  authDeadlineMs: config.authDeadlineMs,
  logger: log.child({ endpoint: "daemon" }),
});

const clientEp = attachEndpoint(clientWss, {
  makeCtx: (ws: WebSocket): ClientConn => ({ ws, accountId: null, subscribed: false }),
  isAuthed: (c) => c.accountId !== null,
  decode: decodeClientToServer,
  onMessage: (c, m) => hub.handleClientMessage(c, m),
  onClose: (c) => hub.handleClientClose(c),
  authDeadlineMs: config.authDeadlineMs,
  logger: log.child({ endpoint: "client" }),
});

const heartbeat = setInterval(() => {
  daemonEp.sweep();
  clientEp.sweep();
}, config.heartbeatMs);
heartbeat.unref();

// 自动更新编排（plan 015）：未设 COFLUX_AUTOUPDATE_REPO 时 enabled=false，start() 直接空转。
const autoUpdater = new AutoUpdater(hub);
hub.onDaemonHandshake = (daemonId) => autoUpdater.checkDaemon(daemonId);
autoUpdater.start();

httpServer.listen(config.port, config.host, () => {
  // 注意：绝不打印 config.databaseUrl（含密码）。
  log.info("listening", { host: config.host, port: config.port });
});

/* ----------------------------- 优雅关闭 / 兜底 ----------------------------- */
let shuttingDown = false;
async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { reason });
  clearInterval(heartbeat);
  autoUpdater.stop();
  try {
    httpServer.close();
  } catch {
    /* ignore */
  }
  hub.shutdown();
  await store.close();
  setTimeout(() => process.exit(code), 300).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: err instanceof Error ? err.stack : String(err) });
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", { err: String(err) });
});
