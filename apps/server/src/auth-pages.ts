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
 *
 * Plan 20260923 adds provider sign-in and a third flow:
 * - Provider buttons are same-origin form POSTs (csrf-checked) whose handler starts Better Auth's
 *   OAuth server-side and 303s to the provider; the return lands on a GET under the flow's own path
 *   (`<flow>/oauth`), which reads the identity, ends the Better Auth session and issues the same
 *   short-lived `cf_page` session a password login would. Error returns carry `?error=<code>`, mapped
 *   to fixed copy; `error_description` is never echoed.
 * - `/login/<request>` is the native (desktop / CLI) login page: sign in, then a mandatory
 *   confirmation card, then a loopback redirect or a paste code (native-login.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createLogger } from "@coflux/core";
import type { AccountId } from "@coflux/protocol";
import { config } from "./config.js";
import { genToken } from "./secrets.js";
import { parseCookies, parseProxyRedirect } from "./proxy.js";
import type { CredentialCheck, DeviceAuthorizeOutcome, PendingDeviceInfo, ProxyAuthOutcome } from "./hub.js";
import { providerErrorKind, providerErrorMessage, type Identity, type ProviderIdentity } from "./identity.js";
import type { NativeLoginStore, NativeLoginView } from "./native-login.js";
import { readFileSync } from "node:fs";

const log = createLogger("server");

/* ============================ 页面会话 + csrf ============================ */

export type PageFlow = "authorize" | "proxy" | "login";

export interface PageSession {
  token: string;
  flow: PageFlow;
  accountId: AccountId;
  userId: string | null;
  /** The signed-in email (or local-mode username); the native login grant reports it back. */
  login: string;
  /** Native login flow only: the request this session was created for; it confirms nothing else. */
  subject?: string;
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
  login: "/login",
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
  create(
    flow: PageFlow,
    identity: { accountId: AccountId; userId: string | null; login?: string; subject?: string },
    now = Date.now(),
  ): PageSession | undefined {
    this.sweep(now);
    if (this.sessions.size >= this.maxSessions) return undefined;
    const session: PageSession = {
      token: genToken(SESSION_PREFIX.slice(0, -1)),
      flow,
      accountId: identity.accountId,
      userId: identity.userId,
      login: identity.login ?? "",
      ...(identity.subject === undefined ? {} : { subject: identity.subject }),
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
  // 浏览器已声明同源（或用户直接发起），以它为准：同源表单 POST 的 Origin 在部分 referrer 策略下会被
  // 浏览器序列化成字面量 "null"（Fetch 规范），再拿它和 publicOrigin 比就会把真人误拒。
  if (site) return site !== "same-origin" && site !== "none";
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

/** Release version shown in the page footer: the monorepo's root package.json (the product version). */
const SERVER_VERSION = (() => {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "";
  } catch {
    return "";
  }
})();

// One visual language with the desktop login screen: centred column, no card, provider buttons first,
// the email form below an "或" divider, host · version in the footer. Light and dark from the same tokens.
const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#17181b;--muted:#6b6f78;--border:#e2e3e7;--field:#fff;--field-border:#d5d7dd;--accent:#4f6ef7;--focus:rgba(79,110,247,.25);--strong-bg:#17181b;--strong-fg:#fff;--strong-hover:#2b2d33;--quiet-hover:#eeeff2;--danger-bg:#fdecec;--danger-border:#f3c2c2;--danger-fg:#a52a2a;--code-bg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--fg:#e8e9ec;--muted:#8b8f98;--border:#2a2c33;--field:#16171a;--field-border:#2f323a;--accent:#6d8cff;--focus:rgba(109,140,255,.3);--strong-bg:#e8e9ec;--strong-fg:#111214;--strong-hover:#cfd1d6;--quiet-hover:#1c1d21;--danger-bg:#2c1719;--danger-border:#5a2429;--danger-fg:#ffb4b4;--code-bg:#16171a}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px}
.stack{width:100%;max-width:360px;display:flex;flex-direction:column;gap:20px}
.head{text-align:center;display:flex;flex-direction:column;gap:6px}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;font-size:22px;font-weight:700;letter-spacing:.01em}
.mark{flex:none}
.tagline{margin:0;color:var(--muted);font-size:14px;word-break:break-word}
.foot{margin:8px 0 0;text-align:center;color:var(--muted);font-size:12px}
.banner{padding:10px 12px;border-radius:8px;background:var(--danger-bg);border:1px solid var(--danger-border);color:var(--danger-fg);font-size:13px}
form{margin:0}
.group{display:flex;flex-direction:column;gap:10px}
label{display:block;font-size:13px;color:var(--muted)}
input[type=text],input[type=email],input[type=password]{display:block;width:100%;margin-top:6px;padding:10px 12px;border-radius:8px;border:1px solid var(--field-border);background:var(--field);color:var(--fg);font-size:15px;font-family:inherit}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--focus)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:44px;padding:10px 14px;border-radius:8px;border:1px solid transparent;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none}
.btn svg{width:18px;height:18px;flex:none}
.btn-strong{background:var(--strong-bg);color:var(--strong-fg)}
.btn-strong:hover{background:var(--strong-hover)}
.btn-quiet{background:transparent;border-color:var(--field-border);color:var(--fg)}
.btn-quiet:hover{background:var(--quiet-hover)}
.divider{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--border)}
.msg{text-align:center;display:flex;flex-direction:column;gap:8px}
.msg h1{margin:0;font-size:18px;font-weight:600;word-break:break-word}
.msg p{margin:0;color:var(--muted);font-size:14px}
.subject{padding:12px 16px;border-radius:8px;border:1px solid var(--border);text-align:left}
.subject .name{font-size:14px;font-weight:500;word-break:break-all}
.subject .meta{margin-top:4px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);word-break:break-all}
.note{margin:0;color:var(--muted);font-size:12px;text-align:center}
.code{padding:14px 16px;border-radius:8px;border:1px solid var(--border);background:var(--code-bg);font:600 20px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;text-align:center;user-select:all;word-break:break-all}
`.trim();

/** The app icon (apps/desktop/src/renderer/public/favicon.svg), inlined: the pages load no resources. */
const BRAND_MARK =
  `<svg class="mark" viewBox="0 0 512 512" width="28" height="28" aria-hidden="true"><rect width="512" height="512" rx="96" fill="#111214"/>` +
  `<path d="M152,180 L232,256 L152,332" fill="none" stroke="#e6e6e3" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<rect x="272" y="234" width="110" height="44" rx="10" fill="#e6e6e3"/></svg>`;

function footerText(): string {
  let host = "";
  try {
    host = new URL(config.publicUrl).host;
  } catch {
    host = "";
  }
  return [host, SERVER_VERSION ? `v${SERVER_VERSION}` : ""].filter(Boolean).join(" · ");
}

/** 页面骨架：居中单列、无卡片；顶部品牌 + 一句说明，底部服务器 host · 版本。 */
export function renderPage(title: string, body: string, tagline = "登录以连接你的工作区"): string {
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)} · Coflux</title><style>${CSS}</style></head>` +
    `<body><main class="page"><div class="stack">` +
    `<header class="head"><div class="brand">${BRAND_MARK}Coflux</div>` +
    `<p class="tagline">${escapeHtml(tagline)}</p></header>` +
    body +
    `<p class="foot">${escapeHtml(footerText())}</p></div></main></body></html>`
  );
}

const PROVIDER_LABELS: Record<string, { label: string; icon: string }> = {
  github: {
    label: "使用 GitHub 继续",
    icon:
      `<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
  },
  google: {
    label: "使用 Google 继续",
    icon:
      `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
  },
};

export interface LoginFormSpec {
  /** Password form POST target. */
  action: string;
  title: string;
  /** The line under the brand. */
  description: string;
  submitLabel: string;
  /** 回填到隐藏字段的流程参数（request id / 跳转目标），登录后 303 回同一 GET 用。 */
  hidden?: Record<string, string>;
  /** Provider form POST target (`<flow path>/oauth/<provider>`); absent = no provider buttons. */
  providerAction?: (provider: string) => string;
}

function hiddenFields(values: Record<string, string> | undefined, csrf: string): string {
  return (
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    Object.entries(values ?? {})
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("")
  );
}

/** Provider buttons (only the enabled ones) above an "或" divider, then the password form. With no
 * provider enabled there are no buttons and no divider — never a dead button. */
export function renderLoginForm(spec: LoginFormSpec, csrf: string, error?: string, providers: readonly string[] = []): string {
  const shown = spec.providerAction ? providers.filter((provider) => PROVIDER_LABELS[provider]) : [];
  const providerForms = shown
    .map((provider) => {
      const view = PROVIDER_LABELS[provider]!;
      return (
        `<form method="post" action="${escapeHtml(spec.providerAction!(provider))}">${hiddenFields(spec.hidden, csrf)}` +
        `<button class="btn btn-strong" type="submit">${view.icon}<span>${escapeHtml(view.label)}</span></button></form>`
      );
    })
    .join("");
  const localMode = config.authProvider === "local";
  const submitLabel = shown.length > 0 ? (localMode ? "用账号登录" : "用邮箱登录") : spec.submitLabel;
  return (
    (error ? `<div class="banner" role="alert">${escapeHtml(error)}</div>` : "") +
    (shown.length > 0 ? `<div class="group">${providerForms}</div><div class="divider">或</div>` : "") +
    `<form class="group" method="post" action="${escapeHtml(spec.action)}" autocomplete="on">` +
    (localMode
      ? `<label>账号<input type="text" name="username" placeholder="输入账号" autocomplete="username" required></label>`
      : `<label>邮箱<input type="email" name="username" placeholder="you@example.com" autocomplete="username" required></label>`) +
    `<label>密码<input type="password" name="password" placeholder="输入密码" autocomplete="current-password" required></label>` +
    hiddenFields(spec.hidden, csrf) +
    `<button class="btn ${shown.length > 0 ? "btn-quiet" : "btn-strong"}" type="submit">${escapeHtml(submitLabel)}</button></form>`
  );
}

export function renderMessage(title: string, description: string): string {
  return `<div class="msg"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>`;
}

export function renderAuthorizeConfirm(action: string, csrf: string, device: PendingDeviceInfo): string {
  return (
    `<div class="msg"><h1>确认设备</h1><p>允许以下设备接入你的账号和工作区。</p></div>` +
    `<div class="subject"><div class="name">${escapeHtml(device.name || "未命名设备")}</div>` +
    `<div class="meta">${escapeHtml(device.host || "未知主机")} · ${escapeHtml(device.platform || "未知平台")}</div></div>` +
    `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<button class="btn btn-strong" type="submit">授权此设备</button></form>`
  );
}

const CLIENT_KIND_LABEL: Record<NativeLoginView["clientKind"], string> = { desktop: "桌面端", cli: "命令行" };

/** The mandatory confirmation card of a native login: who is asking (as they reported it) and as whom. */
export function renderNativeConfirm(base: string, csrf: string, request: NativeLoginView, login: string): string {
  const csrfField = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  return (
    `<div class="msg"><h1>在 ${escapeHtml(request.host)} 上的 Coflux ${CLIENT_KIND_LABEL[request.clientKind]}请求登录</h1>` +
    `<p>允许后，这个${CLIENT_KIND_LABEL[request.clientKind]}将以你的身份访问账号和工作区。</p></div>` +
    `<div class="subject"><div class="name">${escapeHtml(login || "当前账号")}</div>` +
    `<div class="meta">主机名 ${escapeHtml(request.host)} 由请求方自报 · 仅在你刚刚发起登录时允许</div></div>` +
    `<div class="group"><form method="post" action="${escapeHtml(`${base}/confirm`)}">${csrfField}` +
    `<button class="btn btn-strong" type="submit">允许登录</button></form>` +
    `<form method="post" action="${escapeHtml(`${base}/deny`)}">${csrfField}` +
    `<button class="btn btn-quiet" type="submit">取消</button></form></div>`
  );
}

export function renderPasteCode(code: string): string {
  return (
    `<div class="msg"><h1>复制登录码</h1><p>把下面的代码粘贴到终端里等待的 coflux login。</p></div>` +
    `<div class="code">${escapeHtml(code)}</div>` +
    `<p class="note">登录码只能用一次，几分钟内有效；不要发给任何人。</p>`
  );
}

/* ============================ Response 构造 ============================ */

const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // same-origin 而非 no-referrer：no-referrer 会让同源表单 POST 的 Origin 头变成 "null"，没有 Sec-Fetch-Site 的浏览器就过不了来源校验
  "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function htmlResponse(status: number, title: string, body: string, setCookies: readonly string[] = [], tagline?: string): Response {
  const headers = new Headers(PAGE_HEADERS);
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(renderPage(title, body, tagline), { status, headers });
}

function redirectResponse(status: 302 | 303, location: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

/* ============================ 三条流程 ============================ */

/** 页面需要的业务能力，由 Hub 结构性满足（依赖倒置，hub.ts → auth-pages.ts 单向 import）。 */
export interface AuthPagesHost {
  allowLogin(remoteAddress: string): boolean;
  verifyLoginCredentials(username: string, password: string): Promise<CredentialCheck>;
  describePendingAuthorization(token: string): PendingDeviceInfo | undefined;
  authorizeDevice(token: string, accountId: AccountId): Promise<DeviceAuthorizeOutcome | undefined>;
  issueProxyAuth(accountId: AccountId, redirect: string): ProxyAuthOutcome;
  readonly identity: Pick<Identity, "providers" | "startSignIn" | "finishSignIn">;
  accountForProviderIdentity(identity: ProviderIdentity): Promise<AccountId>;
  readonly nativeLogins: Pick<NativeLoginStore, "describe" | "approve" | "fail" | "cancel">;
}

/** handler 交进来的请求：标准 Fetch Request + index.ts 算好的来源地址（只用于登录限速）。 */
export interface PageRequest {
  request: Request;
  remoteAddress: string;
}

type GuardedPost =
  | { ok: false; response: Response }
  | { ok: true; form: URLSearchParams; session: PageSession | undefined };

const AUTHORIZE_LOGIN = { title: "授权新设备", description: "登录以授权新设备接入你的账号", submitLabel: "登录并继续" };
const PROXY_LOGIN = { title: "访问端口预览", description: "登录以打开该工作区的预览页面", submitLabel: "登录并访问" };
const NATIVE_LOGIN = { title: "登录 Coflux", description: "登录以连接你的工作区", submitLabel: "登录" };

const TOO_MANY_AUTHORIZE = "尝试次数过多，请重新申请授权链接";
const INVALID_AUTHORIZE = "授权链接无效或已过期";
const INVALID_NATIVE = "登录请求无效或已过期，请回到 Coflux 重新发起登录";
const PROVIDER_UNFINISHED = "登录未完成，请重试";

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
    return htmlResponse(200, "确认设备", renderAuthorizeConfirm(`${authorizePath(token)}/confirm`, this.sessions.csrfFor(session.token), device), [], AUTHORIZE_LOGIN.description);
  }

  authorizeLogin(req: PageRequest, token: string): Promise<Response> {
    return this.login(req, "authorize", this.authorizeLoginSpec(token), authorizePath(token));
  }

  authorizeProviderStart(req: PageRequest, token: string, provider: string): Promise<Response> {
    return this.providerStart(req, "authorize", this.authorizeLoginSpec(token), provider, `${authorizePath(token)}/oauth`);
  }

  authorizeProviderReturn(req: PageRequest, token: string): Promise<Response> {
    return this.providerReturn(req, "authorize", this.authorizeLoginSpec(token), authorizePath(token));
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
    return {
      ...AUTHORIZE_LOGIN,
      action: `${authorizePath(token)}/login`,
      providerAction: (provider) => `${authorizePath(token)}/oauth/${encodeURIComponent(provider)}`,
    };
  }

  /* ------------------------------ 端口预览门禁 ------------------------------ */

  async proxyAuthPage(req: PageRequest, to: string | undefined): Promise<Response> {
    // 登录前只做形状校验（host 形如 <shortId>-<proxyHost>）；归属校验在登录后由 issueProxyAuth 做。
    const target = proxyTarget(to);
    if (!target) return invalidProxyTarget();
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

  async proxyProviderStart(req: PageRequest, provider: string): Promise<Response> {
    const peek = await this.guardPost(req, "proxy");
    if (!peek.ok) return peek.response;
    const target = proxyTarget(peek.form.get("to"));
    if (!target) return invalidProxyTarget();
    return this.providerStartWithForm(req, peek.form, "proxy", this.proxyLoginSpec(target), provider, `/proxy-auth/oauth?to=${encodeURIComponent(target)}`);
  }

  async proxyProviderReturn(req: PageRequest, to: string | undefined): Promise<Response> {
    const target = proxyTarget(to);
    if (!target) return invalidProxyTarget();
    return this.providerReturn(req, "proxy", this.proxyLoginSpec(target), proxyAuthPath(target));
  }

  private proxyLoginSpec(target: string): LoginFormSpec {
    return { ...PROXY_LOGIN, action: "/proxy-auth/login", hidden: { to: target }, providerAction: (provider) => `/proxy-auth/oauth/${encodeURIComponent(provider)}` };
  }

  /* ------------------------------ 原生登录（桌面 / CLI） ------------------------------ */

  async nativePage(req: PageRequest, id: string): Promise<Response> {
    const request = this.host.nativeLogins.describe(id);
    if (!request) return htmlResponse(404, "登录请求不可用", renderMessage("登录请求不可用", INVALID_NATIVE));
    const session = this.nativeSession(req, id);
    if (!session) {
      // The app's own provider button opens `/login/<id>?provider=<p>`: go straight to the provider
      // instead of asking for a second click. Nothing is granted by this — the confirmation card with
      // its csrf still stands between any sign-in and the code — so no csrf is needed to start it.
      const provider = new URL(req.request.url).searchParams.get("provider");
      if (provider && this.host.identity.providers.includes(provider as never)) return this.nativeProviderAutoStart(req, id, provider);
      return this.loginPage(req, "login", this.nativeLoginSpec(id));
    }
    return htmlResponse(200, "确认登录", renderNativeConfirm(nativePath(id), this.sessions.csrfFor(session.token), request, session.login), [], "确认这次登录");
  }

  nativeLogin(req: PageRequest, id: string): Promise<Response> {
    return this.login(req, "login", this.nativeLoginSpec(id), nativePath(id), id);
  }

  nativeProviderStart(req: PageRequest, id: string, provider: string): Promise<Response> {
    return this.providerStart(req, "login", this.nativeLoginSpec(id), provider, `${nativePath(id)}/oauth`);
  }

  private async nativeProviderAutoStart(req: PageRequest, id: string, provider: string): Promise<Response> {
    const spec = this.nativeLoginSpec(id);
    if (!this.host.allowLogin(req.remoteAddress)) return this.loginPage(req, "login", spec, "登录尝试过于频繁，请稍后重试", 429);
    const returnUrl = `${config.publicUrl}${nativePath(id)}/oauth`;
    let started: { url: string; setCookies: string[] } | undefined;
    try {
      started = await this.host.identity.startSignIn(provider as never, returnUrl, returnUrl, req.request.headers);
    } catch (error) {
      log.warn("provider sign-in could not start", { flow: "login", provider, error: String(error) });
    }
    if (!started) return this.loginPage(req, "login", spec, "暂时无法连接登录服务，请稍后重试", 502);
    return redirectResponse(302, started.url, started.setCookies);
  }

  /** A failed provider return ends a loopback request right away, so the waiting app shows why
   * (not allowed / cancelled / failed) instead of waiting out the TTL. A paste request stays open. */
  async nativeProviderReturn(req: PageRequest, id: string): Promise<Response> {
    const error = new URL(req.request.url).searchParams.get("error");
    if (error) {
      const failed = this.host.nativeLogins.fail(id, providerErrorKind(error));
      if (failed) return redirectResponse(303, failed.location);
    }
    return this.providerReturn(req, "login", this.nativeLoginSpec(id), nativePath(id), id);
  }

  async nativeConfirm(req: PageRequest, id: string): Promise<Response> {
    const guarded = await this.guardPost(req, "login");
    if (!guarded.ok) return guarded.response;
    const session = this.nativeSession(req, id);
    if (!session) return redirectResponse(303, nativePath(id));
    if (!this.sessions.verifyCsrf(session.token, guarded.form.get("csrf"))) return this.csrfRejected("登录未完成");
    const outcome = this.host.nativeLogins.approve(id, { accountId: session.accountId, userId: session.userId, login: session.login });
    const clear = this.endSession(session);
    if (!outcome) return htmlResponse(404, "登录未完成", renderMessage("登录未完成", INVALID_NATIVE), clear);
    if (outcome.kind === "loopback") return redirectResponse(303, outcome.location, clear);
    return htmlResponse(200, "复制登录码", renderPasteCode(outcome.code), clear, "回到终端完成登录");
  }

  async nativeDeny(req: PageRequest, id: string): Promise<Response> {
    const guarded = await this.guardPost(req, "login");
    if (!guarded.ok) return guarded.response;
    const session = this.nativeSession(req, id);
    if (!session) return redirectResponse(303, nativePath(id));
    if (!this.sessions.verifyCsrf(session.token, guarded.form.get("csrf"))) return this.csrfRejected("登录未完成");
    const outcome = this.host.nativeLogins.cancel(id);
    const clear = this.endSession(session);
    if (outcome?.kind === "loopback") return redirectResponse(303, outcome.location, clear);
    return htmlResponse(200, "已取消登录", renderMessage("已取消登录", "这次登录没有生效，可以关闭此页面。"), clear);
  }

  /** Better Auth's fallback error page (a failure it could not attribute to any flow). */
  loginErrorPage(req: PageRequest): Response {
    const error = new URL(req.request.url).searchParams.get("error");
    return htmlResponse(400, "登录未完成", renderMessage("登录未完成", `${providerErrorMessage(error)}。请回到原页面重新开始。`));
  }

  private nativeLoginSpec(id: string): LoginFormSpec {
    return { ...NATIVE_LOGIN, action: `${nativePath(id)}/login`, providerAction: (provider) => `${nativePath(id)}/oauth/${encodeURIComponent(provider)}` };
  }

  /** A native page session is only good for the request it was created for. */
  private nativeSession(req: PageRequest, id: string): PageSession | undefined {
    const session = this.currentSession(req, "login");
    return session && session.subject === id ? session : undefined;
  }

  /* ------------------------------ 共用 ------------------------------ */

  private currentSession(req: PageRequest, flow: PageFlow): PageSession | undefined {
    return this.sessions.get(readPageCookie(req.request.headers.get("cookie")), flow);
  }

  /** 未登录的 GET / 登录失败：渲染登录表单。cookie 里没有匿名 nonce 就发一个，csrf 与它绑定。 */
  private loginPage(req: PageRequest, flow: PageFlow, spec: LoginFormSpec, error?: string, status = 200, extraCookies: readonly string[] = []): Response {
    const current = readPageCookie(req.request.headers.get("cookie"));
    const setCookies: string[] = [...extraCookies];
    let value = current;
    if (!this.sessions.isAnonymousValue(value)) {
      value = this.sessions.anonymousValue();
      setCookies.push(buildPageCookie(value, FLOW_COOKIE_PATH[flow], config.authorizeTtlMs, this.secure));
    }
    return htmlResponse(status, spec.title, renderLoginForm(spec, this.sessions.csrfFor(value!), error, this.host.identity.providers), setCookies, spec.description);
  }

  private async login(req: PageRequest, flow: PageFlow, spec: LoginFormSpec, redirectTo: string, subject?: string): Promise<Response> {
    const peek = await this.guardPost(req, flow);
    if (!peek.ok) return peek.response;
    return this.loginWithForm(req, peek.form, flow, spec, redirectTo, subject);
  }

  /** 登录 POST：csrf（绑定匿名 nonce）→ 来源限速 → 凭证校验 → 签页面会话 → 303 回同一 GET。
   * 失败页只说「用户名或密码错误」，不顺手告诉对方 token / request 是否有效。 */
  private async loginWithForm(req: PageRequest, form: URLSearchParams, flow: PageFlow, spec: LoginFormSpec, redirectTo: string, subject?: string): Promise<Response> {
    const cookie = readPageCookie(req.request.headers.get("cookie"));
    if (!this.sessions.verifyCsrf(cookie, form.get("csrf"))) return this.loginPage(req, flow, spec, "页面已过期，请刷新后重试", 403);
    if (!this.host.allowLogin(req.remoteAddress)) {
      log.warn("页面登录触发来源限速", { remoteAddress: req.remoteAddress, flow });
      return this.loginPage(req, flow, spec, "登录尝试过于频繁，请稍后重试", 429);
    }
    const username = form.get("username") ?? "";
    const checked = await this.host.verifyLoginCredentials(username, form.get("password") ?? "");
    if (checked.case === "busy") return this.loginPage(req, flow, spec, "登录服务繁忙，请稍后重试", 503);
    if (checked.case === "invalid") return this.loginPage(req, flow, spec, "登录失败：用户名或密码错误", 401);
    const login = config.authProvider === "password" ? username.trim().toLowerCase() : username;
    const session = this.sessions.create(flow, { accountId: checked.accountId, userId: checked.userId, login, subject });
    if (!session) {
      log.warn("页面会话达到上限", { limit: this.sessions.size });
      return this.loginPage(req, flow, spec, "登录会话已满，请稍后重试", 503);
    }
    return redirectResponse(303, redirectTo, [buildPageCookie(session.token, FLOW_COOKIE_PATH[flow], config.authorizeTtlMs, this.secure)]);
  }

  private async providerStart(req: PageRequest, flow: PageFlow, spec: LoginFormSpec, provider: string, returnPath: string): Promise<Response> {
    const peek = await this.guardPost(req, flow);
    if (!peek.ok) return peek.response;
    return this.providerStartWithForm(req, peek.form, flow, spec, provider, returnPath);
  }

  /**
   * Provider button POST: csrf (bound to the anonymous nonce) → source rate limit → Better Auth starts
   * the OAuth flow server-side → 303 to the provider, forwarding Better Auth's state cookie. The return
   * URL is always built here from the public origin and the flow's own path, never from the request.
   */
  private async providerStartWithForm(req: PageRequest, form: URLSearchParams, flow: PageFlow, spec: LoginFormSpec, provider: string, returnPath: string): Promise<Response> {
    const cookie = readPageCookie(req.request.headers.get("cookie"));
    if (!this.sessions.verifyCsrf(cookie, form.get("csrf"))) return this.loginPage(req, flow, spec, "页面已过期，请刷新后重试", 403);
    if (!this.host.identity.providers.includes(provider as never)) return this.loginPage(req, flow, spec, "不支持该登录方式", 400);
    if (!this.host.allowLogin(req.remoteAddress)) {
      log.warn("页面登录触发来源限速", { remoteAddress: req.remoteAddress, flow });
      return this.loginPage(req, flow, spec, "登录尝试过于频繁，请稍后重试", 429);
    }
    const returnUrl = `${config.publicUrl}${returnPath}`;
    let started: { url: string; setCookies: string[] } | undefined;
    try {
      started = await this.host.identity.startSignIn(provider as never, returnUrl, returnUrl, req.request.headers);
    } catch (error) {
      log.warn("provider sign-in could not start", { flow, provider, error: String(error) });
    }
    if (!started) return this.loginPage(req, flow, spec, "暂时无法连接登录服务，请稍后重试", 502);
    return redirectResponse(303, started.url, started.setCookies);
  }

  /**
   * The provider round trip came back under the flow's path. An `?error=` is mapped to fixed copy on the
   * login form; otherwise the Better Auth identity is read, its session ended (clearing cookies
   * forwarded), and the same short-lived `cf_page` session a password login gives is issued.
   */
  private async providerReturn(req: PageRequest, flow: PageFlow, spec: LoginFormSpec, redirectTo: string, subject?: string): Promise<Response> {
    const error = new URL(req.request.url).searchParams.get("error");
    if (error) return this.loginPage(req, flow, spec, providerErrorMessage(error));
    let finished: { identity?: ProviderIdentity; setCookies: string[] } = { setCookies: [] };
    try {
      finished = await this.host.identity.finishSignIn(req.request.headers);
    } catch (failure) {
      log.warn("provider sign-in handoff failed", { flow, error: String(failure) });
    }
    if (!finished.identity) return this.loginPage(req, flow, spec, PROVIDER_UNFINISHED, 200, finished.setCookies);
    const accountId = await this.host.accountForProviderIdentity(finished.identity);
    const session = this.sessions.create(flow, { accountId, userId: finished.identity.userId, login: finished.identity.email, subject });
    if (!session) {
      log.warn("页面会话达到上限", { limit: this.sessions.size });
      return this.loginPage(req, flow, spec, "登录会话已满，请稍后重试", 503, finished.setCookies);
    }
    return redirectResponse(303, redirectTo, [...finished.setCookies, buildPageCookie(session.token, FLOW_COOKIE_PATH[flow], config.authorizeTtlMs, this.secure)]);
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

function nativePath(id: string): string {
  return `/login/${encodeURIComponent(id)}`;
}

function proxyAuthPath(target: string): string {
  return `/proxy-auth?to=${encodeURIComponent(target)}`;
}

function proxyTarget(to: string | null | undefined): string | undefined {
  const target = boundedField(to, MAX_TARGET_CHARS);
  return target && parseProxyRedirect(target) ? target : undefined;
}

function invalidProxyTarget(): Response {
  return htmlResponse(400, "预览链接无效", renderMessage("预览链接无效", "链接缺少跳转目标，请从终端 Tab 的端口入口重新打开。"));
}
