/**
 * coflux 中心服务器装配入口。
 *
 * 职责仅限装配：配置 → 持久化 → Hub → HTTP/WS 接入 → 心跳 → 信号/兜底。
 * 连接样板在 transport.ts，领域逻辑在 hub.ts。
 */
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "@coflux/core";
import { decodeDaemonToServer, decodeClientToServer } from "@coflux/protocol";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Hub, type ClientConn, type DaemonCtx } from "./hub.js";
import { hashToken } from "./secrets.js";
import { attachEndpoint } from "./transport.js";
import { SupabaseVerifier } from "./auth.js";
import { matchProxyHost, handleProxyRequest, handleProxyUpgrade, type ProxyServerContext } from "./proxy.js";

const log = createLogger("server");
const startedAt = Date.now();

const store = await Store.connect(config.databaseUrl);
await bootstrap();
// supabase 模式启用 JWKS 验签器；local 模式不需要（省去外部依赖）。
const verifier = config.authProvider === "supabase" ? new SupabaseVerifier(config.supabaseUrl) : undefined;
const hub = new Hub(store, verifier);
// hub 结构性满足 ProxyServerContext（routeTable/proxyGate/tunnels 三个只读字段）；proxy.ts 不反向导入 Hub，
// 避免 hub.ts ⇄ proxy.ts 循环依赖（见 plan 006 决策：依赖倒置）。
const proxyCtx: ProxyServerContext = hub;

async function bootstrap() {
  // 以下三项（default 账号 seed / env 登记密钥 seed / credFingerprint 撤销）都是单账号 + env 口令的伴生物，
  // 仅 local 模式执行。supabase 模式下账号按 userId lazy 建、登记密钥走 UI 生成。
  if (config.authProvider === "local") {
    if (!(await store.getAccount(config.accountId))) {
      await store.createAccount({ id: config.accountId, name: "default", createdAt: Date.now() });
      log.info("created account", { accountId: config.accountId });
    }
    await store.upsertEnrollmentKey(hashToken(config.enrollKey), config.accountId, Date.now());
    // 不再 seed 静态登录令牌；web 用用户名+密码登录，登录时签发会话 token。

    // 凭证变更检测：用户名/密码改了（改 env 重启）就撤销全部已签发会话 token，
    // 让改密码能即时使已泄露/在用的旧 token 失效（token 与密码解耦存于表中，否则永久有效）。
    const credFingerprint = hashToken(`${config.username}\n${config.password}`);
    if ((await store.getMeta("credFingerprint")) !== credFingerprint) {
      await store.revokeAllClientTokens(config.accountId);
      await store.setMeta("credFingerprint", credFingerprint);
      log.info("credentials changed since last boot, revoked all client tokens");
    }
  }
  // 清理已撤销/过期的会话 token，防 client_tokens 表无界增长（两模式通用）。
  await store.pruneClientTokens(Date.now());

  log.info("bootstrap ready", { authProvider: config.authProvider });
}

const httpServer = http.createServer((req, res) => {
  // Host 命中 <shortId>.<proxyHost> 的请求走端口转发反代（登录门禁 + 隧道透传），
  // 与既有 /health、/daemon、/client 路由完全独立分流，见 plan 006。
  if (matchProxyHost(req.headers.host)) {
    void handleProxyRequest(proxyCtx, req, res);
    return;
  }
  if (req.url === "/health") {
    store.ping().then((ok) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, uptimeMs: Date.now() - startedAt, ...hub.stats() }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
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
