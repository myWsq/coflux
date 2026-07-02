/**
 * coflux 中心服务器装配入口。
 *
 * 职责仅限装配：配置 → 持久化 → Hub → HTTP/WS 接入 → 心跳 → 信号/兜底。
 * 连接样板在 transport.ts，领域逻辑在 hub.ts。
 */
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "@coflux/core";
import { isValidDaemonToServer, isValidClientToServer } from "@coflux/protocol";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Hub, type ClientConn, type DaemonCtx } from "./hub.js";
import { hashToken } from "./secrets.js";
import { attachEndpoint } from "./transport.js";

const log = createLogger("server");
const startedAt = Date.now();

const store = new Store(config.dbPath);
bootstrap();
const hub = new Hub(store);

function bootstrap() {
  if (!store.getAccount(config.accountId)) {
    store.createAccount({ id: config.accountId, name: "default", createdAt: Date.now() });
    log.info("created account", { accountId: config.accountId });
  }
  store.upsertEnrollmentKey(hashToken(config.enrollKey), config.accountId, Date.now());
  // 不再 seed 静态登录令牌；web 用用户名+密码登录，登录时签发会话 token。

  // 凭证变更检测：用户名/密码改了（改 env 重启）就撤销全部已签发会话 token，
  // 让改密码能即时使已泄露/在用的旧 token 失效（token 与密码解耦存于表中，否则永久有效）。
  const credFingerprint = hashToken(`${config.username}\n${config.password}`);
  if (store.getMeta("credFingerprint") !== credFingerprint) {
    store.revokeAllClientTokens(config.accountId);
    store.setMeta("credFingerprint", credFingerprint);
    log.info("credentials changed since last boot, revoked all client tokens");
  }
  // 清理已撤销/过期的会话 token，防 client_tokens 表无界增长。
  store.pruneClientTokens(Date.now());

  const masked = (s: string) => (s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-2)}`);
  log.info("bootstrap ready", { enrollKey: masked(config.enrollKey), username: config.username });
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: store.ping(), uptimeMs: Date.now() - startedAt, ...hub.stats() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wssOpts = { noServer: true as const, maxPayload: config.maxPayload, perMessageDeflate: false };
const daemonWss = new WebSocketServer(wssOpts);
const clientWss = new WebSocketServer(wssOpts);

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/daemon") {
    daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit("connection", ws, req));
  } else if (pathname === "/client") {
    clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

const daemonEp = attachEndpoint<DaemonCtx>(daemonWss, {
  makeCtx: (ws: WebSocket) => ({ ws, daemonId: null, accountId: null }),
  isAuthed: (c) => c.daemonId !== null,
  validate: isValidDaemonToServer,
  onMessage: (c, m) => hub.handleDaemonMessage(c, m as never),
  onBinary: (c, buf) => hub.handleDaemonBinary(c, buf),
  onClose: (c) => hub.handleDaemonClose(c),
  authDeadlineMs: config.authDeadlineMs,
  logger: log.child({ endpoint: "daemon" }),
});

const clientEp = attachEndpoint<ClientConn>(clientWss, {
  makeCtx: (ws: WebSocket) => ({ ws, accountId: null, subscribed: false }),
  isAuthed: (c) => c.accountId !== null,
  validate: isValidClientToServer,
  onMessage: (c, m) => hub.handleClientMessage(c, m as never),
  onBinary: (c, buf) => hub.handleClientBinary(c, buf),
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
  log.info("listening", { host: config.host, port: config.port, db: config.dbPath });
});

/* ----------------------------- 优雅关闭 / 兜底 ----------------------------- */
let shuttingDown = false;
function shutdown(reason: string, code = 0) {
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
  store.close();
  setTimeout(() => process.exit(code), 300).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: err instanceof Error ? err.stack : String(err) });
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", { err: String(err) });
});
