/**
 * 端口转发反代模块（plan 006）—— 门禁（一次性 code + 长效 cookie）+ 隧道 socket↔连接对拼。
 *
 * 边界：本模块只做机制，不碰账号/会话领域逻辑；路由表的"谁拥有哪个 shortId"由调用方（hub.ts）
 * 通过 ProxyServerContext 注入（依赖倒置，避免 proxy.ts ⇄ hub.ts 循环导入）。
 *
 * 反代模型：Host 形如 `<shortId>.<proxyHost>` 的请求/升级，在网关校验门禁 cookie 后，把整条底层
 * TCP 连接（含后续 keep-alive 请求/SSE/WS）原始字节级接管，经 daemon 的 proxy.open/proxy.data/
 * proxy.close 隧道透传到 daemon 本地端口——不逐请求重新解析，见 handleProxyRequest 的 hijack。
 *
 * 门禁：无有效 cookie ⇒ 302 到 web 的 /proxy-auth（带原始完整 URL）；web（已登录）用 WS
 * proxy.issueAuth 换一次性 code，浏览器带 code 跳回 <shortId>.<proxyHost>/__cf_proxy_auth，
 * 服务器验 code、发 Domain=.<proxyHost> 的长效 cookie（覆盖账号下所有预览子域名）、302 回原路径。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
// 统一用 Duplex 而非 net.Socket：Node 'upgrade' 事件签名里 socket 声明为 stream.Duplex
// （运行时实际是 net.Socket），而本模块只用到 Duplex 能力（write/end/destroy/writableLength/事件），
// 放宽参数类型即可让 req.socket 与 upgrade socket 走同一套隧道代码，无需类型断言。
import type { Duplex } from "node:stream";
import { encodeFrame, type AccountId, type DaemonId, type SessionId, type TaskId, type ServerToDaemon } from "@coflux/protocol";
import { config } from "./config.js";
import { genToken } from "./secrets.js";

export const PROXY_COOKIE_NAME = "cf_proxy_session";
export const AUTH_CALLBACK_PATH = "/__cf_proxy_auth";

/* ============================ 路由标识（shortId）与 Host 匹配 ============================ */

/** 把设备名收敛为 DNS label 安全的片段：小写、非 [a-z0-9] 转 '-'、压缩/修剪 '-'、截长。
 * 截到 40 字符：给 `-<port>`（最长 6）和极端冲突时的 `-<daemonId 前 6 位>` 消歧后缀留足空间，
 * 保证整个 label ≤ 63（DNS 单级上限）。全被清空（如纯中文设备名）时退回 "device"。 */
function sanitizeDeviceName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "device";
}

/** 可读的确定性路由标识：`<设备名>-<端口>`（如 wsq-mbp-5173）。确定性带来 URL 稳定——server
 * 重启、daemon 重连后同一 (设备, 端口) 的预览链接不变，可收藏。可读性没有安全代价：真正的
 * 权限边界是账号级门禁 cookie（见文件头注释），URL 可猜也进不来。
 * 极端冲突（不同设备 sanitize 后同名且同端口）由调用方追加 daemonId 前缀消歧。 */
export function routeLabel(deviceName: string, port: number): string {
  return `${sanitizeDeviceName(deviceName)}-${port}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 允许任意合法 DNS label（含 '-'，1..63，首尾字母数字）——路由标识现在含设备名与连字符。
const PROXY_HOST_RE = new RegExp(`^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.${escapeRegExp(config.proxyHost)}$`, "i");

/** Host 头可能带 `:port`；本项目预览域不支持 IPv6 字面量 Host，遇到方括号原样返回兜底。 */
export function stripPort(hostHeader: string): string {
  if (hostHeader.includes("]")) return hostHeader;
  const idx = hostHeader.lastIndexOf(":");
  return idx === -1 ? hostHeader : hostHeader.slice(0, idx);
}

export function shortIdFromHostname(hostname: string): string | null {
  const m = PROXY_HOST_RE.exec(hostname.toLowerCase());
  return m ? m[1] : null;
}

/** 供 index.ts 分流：Host 命中 `<shortId>.<proxyHost>` 形态即为预览域请求（是否有效路由在内部处理）。 */
export function matchProxyHost(hostHeader: string | undefined): boolean {
  return !!hostHeader && shortIdFromHostname(stripPort(hostHeader)) !== null;
}

/** 预览链接展示用 URL：省略与 scheme 默认端口相同的端口（标准浏览器省略惯例）。 */
export function buildPreviewUrl(shortId: string): string {
  const defaultPort = config.proxyScheme === "https" ? 443 : 80;
  const portSuffix = config.proxyPort === defaultPort ? "" : `:${config.proxyPort}`;
  return `${config.proxyScheme}://${shortId}.${config.proxyHost}${portSuffix}`;
}

/* ============================ 路由表 ============================ */

export interface ProxyRoute {
  shortId: string;
  daemonId: DaemonId;
  accountId: AccountId;
  taskId: TaskId;
  sessionId: SessionId;
  port: number;
}

/** shortId ↔ (session, port) 路由表。daemon 侧 `ports.update` 是全量幂等上报，故用 reconcile
 * 语义：同一 (session,port) 复用既有 shortId（链接不因重复上报而漂移），消失的端口摘除 route。 */
export class ProxyRouteTable {
  private byShortId = new Map<string, ProxyRoute>();
  private bySession = new Map<SessionId, Map<number, string>>();
  private sessionMeta = new Map<SessionId, { daemonId: DaemonId; accountId: AccountId; taskId: TaskId }>();

  private ensure(sessionId: SessionId, daemonId: DaemonId, accountId: AccountId, taskId: TaskId, deviceName: string, port: number): string {
    let m = this.bySession.get(sessionId);
    if (!m) {
      m = new Map();
      this.bySession.set(sessionId, m);
    }
    const existing = m.get(port);
    if (existing) return existing;
    // 可读的确定性标识：<设备名>-<端口>。被占用（不同设备 sanitize 后同名同端口，或同机两个
    // session 用 SO_REUSEPORT 共享端口）时逐级追加 daemonId 前缀消歧，保持 URL 尽量可读。
    let shortId = routeLabel(deviceName, port);
    if (this.byShortId.has(shortId)) shortId = `${routeLabel(deviceName, port)}-${daemonId.slice(0, 6)}`;
    if (this.byShortId.has(shortId)) shortId = `${routeLabel(deviceName, port)}-${sessionId.slice(0, 6)}`;
    this.byShortId.set(shortId, { shortId, daemonId, accountId, taskId, sessionId, port });
    m.set(port, shortId);
    return shortId;
  }

  /** 把某 session 的端口集合收敛到 `ports`：多退（摘除 route）少补（分配新 shortId）。
   * 返回本次被摘除的 shortId 列表，供调用方顺带关闭对应的在途隧道连接。 */
  reconcile(sessionId: SessionId, daemonId: DaemonId, accountId: AccountId, taskId: TaskId, deviceName: string, ports: number[]): string[] {
    const removed: string[] = [];
    const keep = new Set(ports);
    const m = this.bySession.get(sessionId);
    if (m) {
      for (const [port, shortId] of [...m]) {
        if (keep.has(port)) continue;
        this.byShortId.delete(shortId);
        m.delete(port);
        removed.push(shortId);
      }
    }
    if (ports.length === 0) {
      this.sessionMeta.set(sessionId, { daemonId, accountId, taskId });
      if (m && m.size === 0) this.bySession.delete(sessionId);
      return removed;
    }
    this.sessionMeta.set(sessionId, { daemonId, accountId, taskId });
    for (const port of ports) this.ensure(sessionId, daemonId, accountId, taskId, deviceName, port);
    return removed;
  }

  get(shortId: string): ProxyRoute | undefined {
    return this.byShortId.get(shortId);
  }

  portsForTask(taskId: TaskId): ProxyRoute[] {
    return [...this.byShortId.values()].filter((r) => r.taskId === taskId);
  }

  listForAccount(accountId: AccountId): ProxyRoute[] {
    return [...this.byShortId.values()].filter((r) => r.accountId === accountId);
  }

  sessionsForDaemon(daemonId: DaemonId): SessionId[] {
    return [...this.sessionMeta.entries()].filter(([, meta]) => meta.daemonId === daemonId).map(([sid]) => sid);
  }

  /** session 终结（session.exit / 任务停止移除等）：摘除其全部 route，返回受影响 taskId + 被摘 shortId。 */
  releaseSession(sessionId: SessionId): { taskId: TaskId; shortIds: string[] } | undefined {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return undefined;
    const m = this.bySession.get(sessionId);
    const shortIds = m ? [...m.values()] : [];
    for (const shortId of shortIds) this.byShortId.delete(shortId);
    this.bySession.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    return { taskId: meta.taskId, shortIds };
  }

  /** daemon 掉线：摘除其名下所有 session 的 route。 */
  releaseDaemon(daemonId: DaemonId): { taskId: TaskId; shortIds: string[] }[] {
    const out: { taskId: TaskId; shortIds: string[] }[] = [];
    for (const sessionId of this.sessionsForDaemon(daemonId)) {
      const r = this.releaseSession(sessionId);
      if (r) out.push(r);
    }
    return out;
  }
}

/* ============================ 门禁：一次性 code + 长效 cookie ============================ */

interface AuthCode {
  accountId: AccountId;
  expiresAt: number;
}
interface ProxySession {
  accountId: AccountId;
  expiresAt: number;
}

/** code/cookie 表：纯内存态（同 pendingAuthorizations 的取舍，单实例部署，见 plan 006）。
 * 量级小（每次预览页登录一次），惰性清理即可，无需独立定时器。 */
export class ProxyGate {
  private codes = new Map<string, AuthCode>();
  private sessions = new Map<string, ProxySession>();

  issueAuthCode(accountId: AccountId): string {
    this.sweep();
    const code = genToken("cf_pxauth");
    this.codes.set(code, { accountId, expiresAt: Date.now() + config.proxyAuthCodeTtlMs });
    return code;
  }

  /** 一次性消费：命中即摘除（无论是否已过期），避免占位复用。 */
  consumeAuthCode(code: string): { accountId: AccountId } | undefined {
    const c = this.codes.get(code);
    this.codes.delete(code);
    if (!c || c.expiresAt < Date.now()) return undefined;
    return { accountId: c.accountId };
  }

  createSession(accountId: AccountId): string {
    const token = genToken("cf_pxsess");
    this.sessions.set(token, { accountId, expiresAt: Date.now() + config.proxyCookieTtlMs });
    return token;
  }

  checkSession(token: string): { accountId: AccountId } | undefined {
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return { accountId: s.accountId };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.sessions) if (v.expiresAt < now) this.sessions.delete(k);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function buildSetCookie(token: string): string {
  const attrs = [
    `${PROXY_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Domain=.${config.proxyHost}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(config.proxyCookieTtlMs / 1000)}`,
  ];
  if (config.proxyScheme === "https") attrs.push("Secure");
  return attrs.join("; ");
}

/** 防开放重定向：只接受同源相对路径（单个 `/` 开头、第二个字符不得是 `/` 或 `\`、不含换行），
 * 否则退回根路径。`\` 也要挡：浏览器会把 Location 里的 `\` 规范化为 `/`，`/\evil.com`
 * 等价 `//evil.com`（协议相对 URL），仍是跨站跳转。 */
function safeRelativeTarget(to: string | null): string {
  if (!to) return "/";
  if (!/^\/(?![/\\])/.test(to)) return "/";
  if (/[\r\n]/.test(to)) return "/";
  return to;
}

/** hub 侧校验 client.proxy.issueAuth 的 redirect 入参：host 必须形如 `<shortId>.<proxyHost>`
 * （open-redirect 防御第一道；第二道是 handleAuthCallback 里对 `to` 的 safeRelativeTarget）。 */
export function parseProxyRedirect(redirect: string): { host: string; shortId: string; pathAndQuery: string } | null {
  let u: URL;
  try {
    u = new URL(redirect);
  } catch {
    return null;
  }
  const shortId = shortIdFromHostname(stripPort(u.host));
  if (!shortId) return null;
  return { host: u.host, shortId, pathAndQuery: `${u.pathname}${u.search}` };
}

export function buildAuthCallbackUrl(host: string, code: string, pathAndQuery: string): string {
  return `${config.proxyScheme}://${host}${AUTH_CALLBACK_PATH}?code=${encodeURIComponent(code)}&to=${encodeURIComponent(pathAndQuery)}`;
}

/* ============================ 隧道注册表（socket ↔ daemon 连接对拼） ============================ */

export interface TunnelHost {
  sendControl: (daemonId: DaemonId, msg: ServerToDaemon) => void;
  sendFrame: (daemonId: DaemonId, frame: Uint8Array) => void;
}

interface OpenConn {
  connId: string;
  daemonId: DaemonId;
  shortId: string;
  socket: Duplex;
  resolveReady?: (ok: boolean, error?: string) => void;
}

/** 每条隧道连接 = 一个浏览器侧 TCP socket 接管 + 一个 daemon 侧本地端口连接（经 proxy.open/data/close
 * 控制），字节双向原始透传。connId 由服务器签发（randomUUID），daemon 只认它转发到的本地端口。 */
export class TunnelRegistry {
  private conns = new Map<string, OpenConn>();

  constructor(private host: TunnelHost) {}

  /** 发起打开：立即向 daemon 发 proxy.open，返回 ready promise（daemon 回 proxy.opened 或超时二选一，先到者准）。 */
  open(route: ProxyRoute, socket: Duplex, timeoutMs = 8000): { connId: string; ready: Promise<{ ok: boolean; error?: string }> } {
    const connId = randomUUID();
    const entry: OpenConn = { connId, daemonId: route.daemonId, shortId: route.shortId, socket };
    this.conns.set(connId, entry);
    const ready = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        entry.resolveReady = undefined;
        resolve({ ok: false, error: "连接超时" });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      entry.resolveReady = (ok, error) => {
        clearTimeout(timer);
        resolve({ ok, error });
      };
    });
    this.host.sendControl(route.daemonId, { type: "proxy.open", connId, port: route.port });
    return { connId, ready };
  }

  /** 把浏览器侧原始字节转发给 daemon（数据面 proxy.data 帧）。 */
  write(connId: string, data: Uint8Array): void {
    const e = this.conns.get(connId);
    if (!e) return;
    this.host.sendFrame(e.daemonId, encodeFrame({ type: "proxy.data", connId, data }));
  }

  /** 浏览器侧关闭（或调用方主动放弃）：通知 daemon 收尾、摘表。幂等（重复调用安全）。 */
  close(connId: string): void {
    const e = this.conns.get(connId);
    this.conns.delete(connId);
    if (!e) return;
    this.host.sendControl(e.daemonId, { type: "proxy.close", connId });
  }

  /** daemon → server 数据面 proxy.data：写给对应的浏览器 socket。daemonId 须与建连时一致（防跨 daemon 冒充 connId）。 */
  handleData(daemonId: DaemonId, connId: string, data: Uint8Array): void {
    const e = this.conns.get(connId);
    if (!e || e.daemonId !== daemonId || e.socket.destroyed) return;
    // 背压兜底：与 hub.ts 对 client ws.bufferedAmount 的处理同一哲学——过硬水位直接断，不无界缓冲。
    if (e.socket.writableLength > config.clientBufferHardLimit) {
      this.conns.delete(connId);
      try {
        e.socket.destroy();
      } catch {
        /* ignore */
      }
      this.host.sendControl(daemonId, { type: "proxy.close", connId });
      return;
    }
    e.socket.write(Buffer.from(data));
  }

  /** server→daemon proxy.open 的回应。命中未超时的等待方就直接唤醒；迟到的（已判超时放弃）自行收尾。 */
  handleOpened(daemonId: DaemonId, connId: string, ok: boolean, error?: string): void {
    const e = this.conns.get(connId);
    if (!e || e.daemonId !== daemonId) return;
    if (e.resolveReady) {
      const resolve = e.resolveReady;
      e.resolveReady = undefined;
      resolve(ok, error);
      return;
    }
    // 迟到：调用方早已判超时并放弃（浏览器侧可能已收到 502 或已断开）。若迟到的是"成功"，
    // 没人会消费这条连接，主动告知 daemon 关掉，避免其空占一条到本地端口的连接。
    this.conns.delete(connId);
    if (ok) this.host.sendControl(daemonId, { type: "proxy.close", connId });
  }

  /** daemon 侧连接关闭（本地端口那头挂了/daemon 主动关）：销毁浏览器侧 socket。 */
  handleClosed(daemonId: DaemonId, connId: string): void {
    const e = this.conns.get(connId);
    if (!e || e.daemonId !== daemonId) return;
    this.conns.delete(connId);
    try {
      if (!e.socket.destroyed) e.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  /** daemon 掉线：其名下所有隧道连接失去对端，销毁浏览器侧 socket（daemon 已死，无需再通知它）。 */
  closeAllForDaemon(daemonId: DaemonId): void {
    for (const [connId, e] of [...this.conns]) {
      if (e.daemonId !== daemonId) continue;
      this.conns.delete(connId);
      try {
        if (!e.socket.destroyed) e.socket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  /** 端口路由被摘除（session 退出/端口消失）：关掉该 shortId 名下仍在途的隧道连接。 */
  closeAllForShortId(shortId: string): void {
    for (const [connId, e] of [...this.conns]) {
      if (e.shortId !== shortId) continue;
      this.conns.delete(connId);
      try {
        if (!e.socket.destroyed) e.socket.destroy();
      } catch {
        /* ignore */
      }
      this.host.sendControl(e.daemonId, { type: "proxy.close", connId });
    }
  }
}

/* ============================ HTTP / Upgrade 网关 ============================ */

export interface ProxyServerContext {
  routeTable: ProxyRouteTable;
  proxyGate: ProxyGate;
  tunnels: TunnelRegistry;
}

const BODY_HARD_LIMIT = 64 * 1024 * 1024;

function drainBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > BODY_HARD_LIMIT) {
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 把请求头改写为发给 daemon 本地端口的原始请求行+头块：Host 重写为本地端口地址（多数开发服务器
 * 校验 Host，转发原始子域名 Host 会被拒），Transfer-Encoding/Content-Length 剥离后按已排空的
 * body 长度重算精确 Content-Length（Node 收body时已自动解 chunked，若原样转发 chunked 头会与
 * 未分块字节矛盾，破坏下游解析——见 plan 006 landmine）。
 *
 * 强制 Connection: close（剥离原 connection/keep-alive/proxy-connection）：接管 socket 后
 * keep-alive 的后续请求是原始字节透传，Host 无法再被重写，vite 5+ 等的 Host 白名单会拒掉
 * 第二个请求（首屏正常、后续资源随机 403）。牺牲连接复用换 Host 一致性——每个 HTTP 请求
 * 单独一条隧道连接，响应完 dev server 主动关连接，浏览器为下一个请求重新建连、重新走
 * 门禁 + Host 重写；单请求内的流式响应（SSE/大文件）不受影响，dev 预览场景此代价可忽略。
 * WS 走 buildRawUpgradeHead，不在此列（Upgrade 语义需要原 Connection 头）。 */
function buildRawRequestHead(req: IncomingMessage, route: ProxyRoute, bodyLength: number): string {
  const method = req.method ?? "GET";
  const target = req.url ?? "/";
  const originalHost = req.headers.host ?? "";
  const skip = new Set(["host", "transfer-encoding", "content-length", "connection", "keep-alive", "proxy-connection"]);
  const lines: string[] = [`${method} ${target} HTTP/1.1`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || skip.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
    else lines.push(`${key}: ${value}`);
  }
  lines.push(`Host: 127.0.0.1:${route.port}`);
  lines.push(`Content-Length: ${bodyLength}`);
  lines.push("Connection: close");
  if (originalHost) lines.push(`X-Forwarded-Host: ${originalHost}`);
  lines.push(`X-Forwarded-Proto: ${config.proxyScheme}`);
  lines.push("", "");
  return lines.join("\r\n");
}

function buildRawUpgradeHead(req: IncomingMessage, route: ProxyRoute): string {
  const target = req.url ?? "/";
  const originalHost = req.headers.host ?? "";
  const skip = new Set(["host"]);
  const lines: string[] = [`GET ${target} HTTP/1.1`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || skip.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
    else lines.push(`${key}: ${value}`);
  }
  lines.push(`Host: 127.0.0.1:${route.port}`);
  if (originalHost) lines.push(`X-Forwarded-Host: ${originalHost}`);
  lines.push(`X-Forwarded-Proto: ${config.proxyScheme}`);
  lines.push("", "");
  return lines.join("\r\n");
}

function respondPlain(res: ServerResponse, code: number, message: string): void {
  if (res.headersSent) {
    try {
      res.socket?.destroy();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    res.end(message);
  } catch {
    /* ignore */
  }
}

function rejectUpgrade(socket: Duplex, code: number, message: string): void {
  try {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* ignore */
  }
}

function redirectToAuth(res: ServerResponse, hostHeader: string, pathAndQuery: string): void {
  const original = `${config.proxyScheme}://${hostHeader}${pathAndQuery}`;
  const location = `${config.webUrl}/proxy-auth?to=${encodeURIComponent(original)}`;
  res.writeHead(302, { Location: location });
  res.end();
}

function handleAuthCallback(ctx: ProxyServerContext, res: ServerResponse, params: URLSearchParams): void {
  const code = params.get("code");
  const consumed = code ? ctx.proxyGate.consumeAuthCode(code) : undefined;
  if (!consumed) return respondPlain(res, 403, "授权链接已失效，请返回预览页重新登录");
  const sessionToken = ctx.proxyGate.createSession(consumed.accountId);
  const target = safeRelativeTarget(params.get("to"));
  res.writeHead(302, { Location: target, "Set-Cookie": buildSetCookie(sessionToken) });
  res.end();
}

/** 接管整条 TCP 连接：先按正常流式 API 排空请求体（此时 Node 的 chunked 解码/长度处理仍然生效），
 * 拿到 daemon 侧隧道就绪后，摘掉 socket 的 data/end 监听，此后该连接上的一切字节（含后续 keep-alive
 * 请求、SSE）都原始透传，不再经 Node 的 HTTP 解析——这是本 plan 里技术难度最高的一处（已用 Node
 * v26.3 实测验证可行：/tmp 实验脚本，非仓库交付物）。 */
async function tunnelHttpRequest(ctx: ProxyServerContext, route: ProxyRoute, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const socket = req.socket;
  let body: Buffer;
  try {
    body = await drainBody(req);
  } catch {
    if (!socket.destroyed) respondPlain(res, 413, "请求体过大或读取失败");
    return;
  }
  if (socket.destroyed) return;

  const { connId, ready } = ctx.tunnels.open(route, socket);
  const result = await ready;
  if (socket.destroyed) {
    ctx.tunnels.close(connId);
    return;
  }
  if (!result.ok) {
    respondPlain(res, 502, `无法连接到该任务的端口 ${route.port}：${result.error ?? "连接失败"}`);
    ctx.tunnels.close(connId);
    return;
  }

  socket.removeAllListeners("data");
  socket.removeAllListeners("end");
  socket.removeAllListeners("error");
  socket.on("data", (chunk: Buffer) => ctx.tunnels.write(connId, chunk));
  socket.on("close", () => ctx.tunnels.close(connId));
  socket.on("error", () => ctx.tunnels.close(connId));

  const head = buildRawRequestHead(req, route, body.length);
  ctx.tunnels.write(connId, Buffer.concat([Buffer.from(head, "utf8"), body]));
}

/** 普通 HTTP 请求入口（非 Upgrade）：先分流授权回调路径，再门禁校验 cookie，最后交给隧道透传。 */
export async function handleProxyRequest(ctx: ProxyServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const hostHeader = req.headers.host ?? "";
  const shortId = shortIdFromHostname(stripPort(hostHeader));
  if (!shortId) return respondPlain(res, 400, "Bad Request");

  const reqUrl = new URL(req.url ?? "/", "http://internal");
  if (reqUrl.pathname === AUTH_CALLBACK_PATH) return handleAuthCallback(ctx, res, reqUrl.searchParams);

  const route = ctx.routeTable.get(shortId);
  if (!route) return respondPlain(res, 404, "预览链接不存在或已失效（对应任务可能已停止，或端口已变化）");

  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[PROXY_COOKIE_NAME];
  const session = raw ? ctx.proxyGate.checkSession(raw) : undefined;
  if (!session || session.accountId !== route.accountId) {
    return redirectToAuth(res, hostHeader, req.url ?? "/");
  }

  return tunnelHttpRequest(ctx, route, req, res);
}

/** WebSocket（及其它 Upgrade）入口：门禁逻辑与 handleProxyRequest 一致，通过后把 head 缓冲
 * （Node 在识别出 Upgrade 前已读到的字节）与后续原始字节一并转发。无法在这里做 302（Upgrade
 * 语义没有重定向），未过门禁直接拒绝——预览页首次访问走普通 HTTP 请求触发登录，WS 是后续动作。 */
export async function handleProxyUpgrade(ctx: ProxyServerContext, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const hostHeader = req.headers.host ?? "";
  const shortId = shortIdFromHostname(stripPort(hostHeader));
  if (!shortId) return rejectUpgrade(socket, 400, "Bad Request");

  const reqUrl = new URL(req.url ?? "/", "http://internal");
  if (reqUrl.pathname === AUTH_CALLBACK_PATH) return rejectUpgrade(socket, 404, "Not Found");

  const route = ctx.routeTable.get(shortId);
  if (!route) return rejectUpgrade(socket, 404, "Not Found");

  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[PROXY_COOKIE_NAME];
  const session = raw ? ctx.proxyGate.checkSession(raw) : undefined;
  if (!session || session.accountId !== route.accountId) return rejectUpgrade(socket, 401, "Unauthorized");

  const { connId, ready } = ctx.tunnels.open(route, socket);
  const result = await ready;
  if (socket.destroyed) {
    ctx.tunnels.close(connId);
    return;
  }
  if (!result.ok) {
    rejectUpgrade(socket, 502, "Bad Gateway");
    ctx.tunnels.close(connId);
    return;
  }

  socket.removeAllListeners("data");
  socket.removeAllListeners("end");
  socket.removeAllListeners("error");
  socket.on("data", (chunk: Buffer) => ctx.tunnels.write(connId, chunk));
  socket.on("close", () => ctx.tunnels.close(connId));
  socket.on("error", () => ctx.tunnels.close(connId));

  const prefix = Buffer.from(buildRawUpgradeHead(req, route), "utf8");
  ctx.tunnels.write(connId, head && head.length > 0 ? Buffer.concat([prefix, head]) : prefix);
}
