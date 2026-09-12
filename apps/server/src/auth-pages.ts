/**
 * server 直出的浏览器页面：设备授权（`/authorize/<token>`）、端口预览门禁（`/proxy-auth?to=`）。纯 HTML + 内联 CSS + 表单 POST，
 * 不需要 JS；链接全部挂在 `config.publicUrl` 下（冻结的线上 web 不再被 server 引用）。
 *
 * 业务核心（凭证校验、待授权 token 的一次性与 TTL、预览 code 签发）全部经 AuthPagesHost
 * 调 Hub 的共用方法，与 WS 分支同源；本模块只多出「短命页面会话 + csrf」这一层浏览器语义：
 *
 * - 页面会话：登录成功后签发的内存态（随机 token、TTL 同 authorizeTtlMs、条目有上限、满额拒绝新建），
 *   记 accountId / userId（password 模式才有）。**不写 client_tokens、不签 ck_sess**——用户定的是每次流程都登录，
 *   只保留几分钟。cookie `cf_page` 按流程 Path 隔离（/authorize、/proxy-auth），
 *   HttpOnly + SameSite=Lax + Max-Age=TTL，publicUrl 为 https 时加 Secure。
 * - csrf：登录前浏览器先拿到一个匿名 nonce cookie（无状态，不占内存），登录后 cookie 换成会话 token；
 *   隐藏字段 csrf = HMAC(进程随机密钥, cookie 值)。攻击者拿不到 HttpOnly cookie、算不出 HMAC，跨站表单必败；
 *   `Origin` / `Sec-Fetch-Site` 只作纵深（存在且不是同源就拒，缺失放行——Node fetch 不带 Origin）。
 * - 流程形态 PRG：GET 无会话 → 登录表单；登录 POST 成功 → 303 回同一 GET；有会话的 GET 才核对
 *   token / request id（登录前不给 oracle）；猜测失败按页面会话计数，上限沿用 authorizeMaxFailures。
 *
 * 与 pendingAuthorizations / ProxyGate 同为单实例内存态（docs/OPEN_QUESTIONS.md B7）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createLogger } from "@coflux/core";
import type { AccountId } from "@coflux/protocol";
import { config } from "./config.js";
import { genToken } from "./secrets.js";
import { parseCookies, parseProxyRedirect } from "./proxy.js";
import type { CredentialCheck, DeviceAuthorizeOutcome, PendingDeviceInfo, ProxyAuthOutcome } from "./hub.js";

const log = createLogger("server");

/* ============================ 页面会话 + csrf ============================ */

export type PageFlow = "authorize" | "proxy";

export interface PageSession {
  token: string;
  flow: PageFlow;
  accountId: AccountId;
  userId: string | null;
  expiresAt: number;
  /** token / request id 猜测失败次数（同一页面会话累计，语义同 ClientConn.authorizeFailures） */
  failures: number;
}

export const PAGE_COOKIE_NAME = "cf_page";
/** 登录前的匿名 nonce（无状态，只为 csrf 提供绑定对象）与登录后的会话 token 用前缀区分。 */
const ANON_PREFIX = "cf_pgan_";
const SESSION_PREFIX = "cf_pgs_";
const MAX_PAGE_SESSIONS = 4_096;
const MAX_FORM_BYTES = 16 * 1024;
const MAX_ID_CHARS = 512;
const MAX_TARGET_CHARS = 4_096;

/** cookie Path 按流程隔离：三张页面各自登录、互不串用，同时开两条流也不会互相覆盖 cookie。 */
export const FLOW_COOKIE_PATH: Record<PageFlow, string> = {
  authorize: "/authorize",
  proxy: "/proxy-auth",
};

/** 短命页面会话表：惰性清理（同 ProxyGate），满额拒绝新建（不能把仍有效的浏览器踢下线）。 */
export class PageSessionStore {
  private readonly sessions = new Map<string, PageSession>();
  private readonly csrfKey: Buffer;

  constructor(
    private readonly ttlMs: number,
    private readonly maxSessions = MAX_PAGE_SESSIONS,
    csrfKey: Buffer = randomBytes(32),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("页面会话 TTL 必须是正数");
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error("页面会话容量必须是正安全整数");
    if (csrfKey.length < 16) throw new Error("csrf 密钥至少 16 字节");
    this.csrfKey = csrfKey;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** 登录成功后签发；满额返回 undefined（fail-closed）。 */
  create(flow: PageFlow, identity: { accountId: AccountId; userId: string | null }, now = Date.now()): PageSession | undefined {
    this.sweep(now);
    if (this.sessions.size >= this.maxSessions) return undefined;
    const session: PageSession = {
      token: genToken(SESSION_PREFIX.slice(0, -1)),
      flow,
      accountId: identity.accountId,
      userId: identity.userId,
      expiresAt: now + this.ttlMs,
      failures: 0,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** 按 cookie 值取会话：过期即摘除；流程不符视同不存在。 */
  get(token: string | undefined, flow: PageFlow, now = Date.now()): PageSession | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return undefined;
    }
    return session.flow === flow ? session : undefined;
  }

  delete(token: string): void {
    this.sessions.delete(token);
  }

  /** 登录前发给浏览器的匿名 nonce（cookie 值），不入表。 */
  anonymousValue(): string {
    return genToken(ANON_PREFIX.slice(0, -1));
  }

  isAnonymousValue(value: string | undefined): boolean {
    return typeof value === "string" && value.startsWith(ANON_PREFIX);
  }

  /** 隐藏字段里的 csrf：与 cookie 值绑定的 HMAC，匿名 nonce 与会话 token 同一算法。 */
  csrfFor(cookieValue: string): string {
    return createHmac("sha256", this.csrfKey).update(cookieValue).digest("base64url");
  }

  verifyCsrf(cookieValue: string | undefined, submitted: string | undefined | null): boolean {
    if (!cookieValue || typeof submitted !== "string" || submitted.length === 0 || submitted.length > 128) return false;
    const expected = Buffer.from(this.csrfFor(cookieValue));
    const actual = Buffer.from(submitted);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private sweep(now: number): void {
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token);
  }
}

/* ============================ cookie / 请求辅助（纯函数） ============================ */

export function buildPageCookie(value: string, path: string, maxAgeMs: number, secure: boolean): string {
  const attrs = [`${PAGE_COOKIE_NAME}=${value}`, `Path=${path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearPageCookie(path: string, secure: boolean): string {
  return buildPageCookie("", path, 0, secure);
}

export function readPageCookie(cookieHeader: string | null | undefined): string | undefined {
  const value = parseCookies(cookieHeader ?? undefined)[PAGE_COOKIE_NAME];
  return value && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : undefined;
}

/** 来源纵深校验：`Sec-Fetch-Site` / `Origin` 存在且不是同源就拒；缺失放行（Node fetch 不带 Origin，黑盒才跑得通）。 */
export function crossSiteRequest(headers: { get(name: string): string | null }, publicOrigin: string): boolean {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = headers.get("origin");
  if (origin && origin !== publicOrigin) return true;
  return false;
}

/** 有界读取 urlencoded 表单：content-type 不对、超过上限或读失败一律 undefined。 */
export async function readForm(request: Request, maxBytes = MAX_FORM_BYTES): Promise<URLSearchParams | undefined> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) return undefined;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (!request.body) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function boundedField(value: string | null | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}
/* ============================ HTML（模板字符串 + 自写转义） ============================ */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:#111214;color:#e6e7ea;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px}
.brand{font-weight:700;font-size:18px;letter-spacing:.02em}
.card{width:100%;max-width:400px;background:#1a1b1f;border:1px solid #2a2c33;border-radius:12px;padding:32px}
.foot{margin:0;color:#8b8f98;font-size:13px}
h1{margin:0 0 4px;font-size:20px;font-weight:600;text-align:center;word-break:break-word}
.sub{margin:0 0 20px;color:#8b8f98;font-size:13px;text-align:center}
.banner{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#3a1d1f;border:1px solid #6b2a2f;color:#ffb4b4;font-size:13px}
label{display:block;margin-bottom:14px;font-size:13px;color:#b6b9c2}
input[type=text],input[type=password]{display:block;width:100%;margin-top:6px;padding:10px 12px;border-radius:8px;border:1px solid #2f323a;background:#101114;color:#e6e7ea;font-size:15px}
input:focus{outline:none;border-color:#6d8cff;box-shadow:0 0 0 3px rgba(109,140,255,.25)}
.btn{display:block;width:100%;margin-top:8px;padding:11px 14px;border-radius:8px;border:1px solid transparent;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
.btn-primary{background:#4f6ef7;color:#fff}
.btn-primary:hover{background:#4362ea}
.btn-secondary{background:transparent;border-color:#2f323a;color:#e6e7ea}
.btn-secondary:hover{background:#22242a}
.msg{text-align:center}
.msg p{margin:0;color:#8b8f98;font-size:14px}
.subject{margin:16px 0 4px;padding:12px 16px;border-radius:8px;border:1px solid #2a2c33;background:#111214;text-align:left}
.subject .name{font-size:14px;font-weight:500;word-break:break-all}
.subject .meta{margin-top:4px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8b8f98;word-break:break-all}
`.trim();

/** 页面骨架：深色、居中约 400px 卡片、顶部 coflux、底部「安全连接到你的远程工作区」（沿用旧 auth-shell）。 */
export function renderPage(title: string, body: string): string {
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)} · coflux</title><style>${CSS}</style></head>` +
    `<body><main class="page"><div class="brand">coflux</div><section class="card">${body}</section>` +
    `<p class="foot">安全连接到你的远程工作区</p></main></body></html>`
  );
}

export interface LoginFormSpec {
  action: string;
  title: string;
  description: string;
  submitLabel: string;
  /** 回填到隐藏字段的流程参数（request id / 跳转目标），登录后 303 回同一 GET 用。 */
  hidden?: Record<string, string>;
}

export function renderLoginForm(spec: LoginFormSpec, csrf: string, error?: string): string {
  const hidden = Object.entries(spec.hidden ?? {})
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  return (
    `<form method="post" action="${escapeHtml(spec.action)}" autocomplete="on">` +
    `<h1>${escapeHtml(spec.title)}</h1><p class="sub">${escapeHtml(spec.description)}</p>` +
    (error ? `<div class="banner" role="alert">${escapeHtml(error)}</div>` : "") +
    `<label>账号<input type="text" name="username" placeholder="输入账号" autocomplete="username" autofocus required></label>` +
    `<label>密码<input type="password" name="password" placeholder="输入密码" autocomplete="current-password" required></label>` +
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${hidden}` +
    `<button class="btn btn-primary" type="submit">${escapeHtml(spec.submitLabel)}</button></form>`
  );
}

export function renderMessage(title: string, description: string): string {
  return `<div class="msg"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>`;
}

export function renderAuthorizeConfirm(action: string, csrf: string, device: PendingDeviceInfo): string {
  return (
    `<div class="msg"><h1>确认设备</h1><p>允许以下设备接入你的账号和工作区。</p>` +
    `<div class="subject"><div class="name">${escapeHtml(device.name || "未命名设备")}</div>` +
    `<div class="meta">${escapeHtml(device.host || "未知主机")} · ${escapeHtml(device.platform || "未知平台")}</div></div>` +
    `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<button class="btn btn-primary" type="submit">授权此设备</button></form></div>`
  );
}

/* ============================ Response 构造 ============================ */

const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function htmlResponse(status: number, title: string, body: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers(PAGE_HEADERS);
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(renderPage(title, body), { status, headers });
}

function redirectResponse(status: 302 | 303, location: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

/* ============================ 两条流程 ============================ */

/** 页面需要的业务能力，由 Hub 结构性满足（依赖倒置，hub.ts → auth-pages.ts 单向 import）。 */
export interface AuthPagesHost {
  allowLogin(remoteAddress: string): boolean;
  verifyLoginCredentials(username: string, password: string): Promise<CredentialCheck>;
  describePendingAuthorization(token: string): PendingDeviceInfo | undefined;
  authorizeDevice(token: string, accountId: AccountId): Promise<DeviceAuthorizeOutcome | undefined>;
  issueProxyAuth(accountId: AccountId, redirect: string): ProxyAuthOutcome;
}

/** handler 交进来的请求：标准 Fetch Request + index.ts 算好的来源地址（只用于登录限速）。 */
export interface PageRequest {
  request: Request;
  remoteAddress: string;
}

type GuardedPost =
  | { ok: false; response: Response }
  | { ok: true; form: URLSearchParams; session: PageSession | undefined };

const AUTHORIZE_LOGIN = { title: "授权新设备", description: "先登录你的账号，再确认这台设备的信息", submitLabel: "登录并继续" };
const PROXY_LOGIN = { title: "访问端口预览", description: "登录后将安全跳转到该工作区的预览页面", submitLabel: "登录并访问" };

const TOO_MANY_AUTHORIZE = "尝试次数过多，请重新申请授权链接";
const INVALID_AUTHORIZE = "授权链接无效或已过期";

export class AuthPages {
  readonly sessions: PageSessionStore;
  private readonly secure: boolean;
  private readonly publicOrigin: string;

  constructor(
    private readonly host: AuthPagesHost,
    sessions = new PageSessionStore(config.authorizeTtlMs),
  ) {
    this.sessions = sessions;
    this.secure = config.publicUrl.startsWith("https:");
    this.publicOrigin = new URL(config.publicUrl).origin;
  }

  /* ------------------------------ 设备授权 ------------------------------ */

  async authorizePage(req: PageRequest, token: string): Promise<Response> {
    const session = this.currentSession(req, "authorize");
    if (!session) return this.loginPage(req, "authorize", this.authorizeLoginSpec(token));
    if (session.failures >= config.authorizeMaxFailures) return htmlResponse(429, "授权链接不可用", renderMessage("授权链接不可用", TOO_MANY_AUTHORIZE));
    const device = this.host.describePendingAuthorization(token);
    if (!device) {
      session.failures += 1;
      return htmlResponse(404, "授权链接不可用", renderMessage("授权链接不可用", INVALID_AUTHORIZE));
    }
    return htmlResponse(200, "确认设备", renderAuthorizeConfirm(`${authorizePath(token)}/confirm`, this.sessions.csrfFor(session.token), device));
  }

  authorizeLogin(req: PageRequest, token: string): Promise<Response> {
    return this.login(req, "authorize", this.authorizeLoginSpec(token), authorizePath(token));
  }

  async authorizeConfirm(req: PageRequest, token: string): Promise<Response> {
    const guarded = await this.guardPost(req, "authorize");
    if (!guarded.ok) return guarded.response;
    const { session } = guarded;
    if (!session) return redirectResponse(303, authorizePath(token));
    if (!this.sessions.verifyCsrf(session.token, guarded.form.get("csrf"))) return this.csrfRejected("授权未完成");
    if (session.failures >= config.authorizeMaxFailures) return htmlResponse(429, "授权未完成", renderMessage("授权未完成", TOO_MANY_AUTHORIZE));
    const outcome = await this.host.authorizeDevice(token, session.accountId);
    if (!outcome) {
      session.failures += 1;
      return htmlResponse(404, "授权未完成", renderMessage("授权未完成", INVALID_AUTHORIZE));
    }
    // 流程到此结束：会话与 cookie 一并作废（每次流程都登录）。
    const clear = this.endSession(session);
    if (!outcome.ok) return htmlResponse(409, "授权未完成", renderMessage("授权未完成", outcome.error), clear);
    return htmlResponse(200, "设备已授权", renderMessage("设备已授权", "设备已登记到你的账号，可以关闭此页面。"), clear);
  }

  private authorizeLoginSpec(token: string): LoginFormSpec {
    return { ...AUTHORIZE_LOGIN, action: `${authorizePath(token)}/login` };
  }

  /* ------------------------------ 端口预览门禁 ------------------------------ */

  async proxyAuthPage(req: PageRequest, to: string | undefined): Promise<Response> {
    // 登录前只做形状校验（host 形如 <shortId>-<proxyHost>）；归属校验在登录后由 issueProxyAuth 做。
    const target = boundedField(to, MAX_TARGET_CHARS);
    if (!target || !parseProxyRedirect(target)) {
      return htmlResponse(400, "预览链接无效", renderMessage("预览链接无效", "链接缺少跳转目标，请从终端 Tab 的端口入口重新打开。"));
    }
    const session = this.currentSession(req, "proxy");
    if (!session) return this.loginPage(req, "proxy", this.proxyLoginSpec(target));
    const outcome = this.host.issueProxyAuth(session.accountId, target);
    const clear = this.endSession(session);
    if (!outcome.ok) return htmlResponse(403, "无法打开预览", renderMessage("无法打开预览", outcome.error), clear);
    // code 签发即 302 到预览域回调，cookie 落在预览域（proxy.ts handleAuthCallback），与 WS 路径一致。
    return redirectResponse(302, outcome.url, clear);
  }

  async proxyAuthLogin(req: PageRequest): Promise<Response> {
    const peek = await this.guardPost(req, "proxy");
    if (!peek.ok) return peek.response;
    const target = boundedField(peek.form.get("to"), MAX_TARGET_CHARS);
    return this.loginWithForm(req, peek.form, "proxy", this.proxyLoginSpec(target ?? ""), target ? proxyAuthPath(target) : "/proxy-auth");
  }

  private proxyLoginSpec(target: string): LoginFormSpec {
    return { ...PROXY_LOGIN, action: "/proxy-auth/login", hidden: { to: target } };
  }

  /* ------------------------------ 共用 ------------------------------ */

  private currentSession(req: PageRequest, flow: PageFlow): PageSession | undefined {
    return this.sessions.get(readPageCookie(req.request.headers.get("cookie")), flow);
  }

  /** 未登录的 GET / 登录失败：渲染登录表单。cookie 里没有匿名 nonce 就发一个，csrf 与它绑定。 */
  private loginPage(req: PageRequest, flow: PageFlow, spec: LoginFormSpec, error?: string, status = 200): Response {
    const current = readPageCookie(req.request.headers.get("cookie"));
    const setCookies: string[] = [];
    let value = current;
    if (!this.sessions.isAnonymousValue(value)) {
      value = this.sessions.anonymousValue();
      setCookies.push(buildPageCookie(value, FLOW_COOKIE_PATH[flow], config.authorizeTtlMs, this.secure));
    }
    return htmlResponse(status, spec.title, renderLoginForm(spec, this.sessions.csrfFor(value!), error), setCookies);
  }

  private async login(req: PageRequest, flow: PageFlow, spec: LoginFormSpec, redirectTo: string): Promise<Response> {
    const peek = await this.guardPost(req, flow);
    if (!peek.ok) return peek.response;
    return this.loginWithForm(req, peek.form, flow, spec, redirectTo);
  }

  /** 登录 POST：csrf（绑定匿名 nonce）→ 来源限速 → 凭证校验 → 签页面会话 → 303 回同一 GET。
   * 失败页只说「用户名或密码错误」，不顺手告诉对方 token / request 是否有效。 */
  private async loginWithForm(req: PageRequest, form: URLSearchParams, flow: PageFlow, spec: LoginFormSpec, redirectTo: string): Promise<Response> {
    const cookie = readPageCookie(req.request.headers.get("cookie"));
    if (!this.sessions.verifyCsrf(cookie, form.get("csrf"))) return this.loginPage(req, flow, spec, "页面已过期，请刷新后重试", 403);
    if (!this.host.allowLogin(req.remoteAddress)) {
      log.warn("页面登录触发来源限速", { remoteAddress: req.remoteAddress, flow });
      return this.loginPage(req, flow, spec, "登录尝试过于频繁，请稍后重试", 429);
    }
    const checked = await this.host.verifyLoginCredentials(form.get("username") ?? "", form.get("password") ?? "");
    if (checked.case === "busy") return this.loginPage(req, flow, spec, "登录服务繁忙，请稍后重试", 503);
    if (checked.case === "invalid") return this.loginPage(req, flow, spec, "登录失败：用户名或密码错误", 401);
    const session = this.sessions.create(flow, { accountId: checked.accountId, userId: checked.userId });
    if (!session) {
      log.warn("页面会话达到上限", { limit: this.sessions.size });
      return this.loginPage(req, flow, spec, "登录会话已满，请稍后重试", 503);
    }
    return redirectResponse(303, redirectTo, [buildPageCookie(session.token, FLOW_COOKIE_PATH[flow], config.authorizeTtlMs, this.secure)]);
  }

  /** POST 公共前置：来源纵深校验 → 有界读表单 → 取当前会话（可能没有）。csrf 由调用方按会话/匿名 nonce 核对。 */
  private async guardPost(req: PageRequest, flow: PageFlow): Promise<GuardedPost> {
    if (crossSiteRequest(req.request.headers, this.publicOrigin)) {
      return { ok: false, response: htmlResponse(403, "请求被拒绝", renderMessage("请求被拒绝", "请求来源不合法，请回到原页面重试。")) };
    }
    const form = await readForm(req.request);
    if (!form) return { ok: false, response: htmlResponse(400, "请求无效", renderMessage("请求无效", "表单内容无效，请回到原页面重试。")) };
    return { ok: true, form, session: this.currentSession(req, flow) };
  }

  private csrfRejected(title: string): Response {
    return htmlResponse(403, title, renderMessage(title, "页面已过期，请刷新后重试。"));
  }

  private endSession(session: PageSession): string[] {
    this.sessions.delete(session.token);
    return [clearPageCookie(FLOW_COOKIE_PATH[session.flow], this.secure)];
  }
}

function authorizePath(token: string): string {
  return `/authorize/${encodeURIComponent(token)}`;
}


function proxyAuthPath(target: string): string {
  return `/proxy-auth?to=${encodeURIComponent(target)}`;
}
