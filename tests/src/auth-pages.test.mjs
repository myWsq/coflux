/**
 * server 直出页面（plan 107）的纯函数进程内单测：HTML 转义、页面 cookie 的解析/拼装、csrf 核对、
 * 页面会话的 TTL / 流程隔离 / 上限、来源纵深校验、有界表单读取。不经 hub、不起进程；
 * 三条 HTTP 流的黑盒在 authorize / mcp-oauth / proxy 三份测试里。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// auth-pages.ts 会读取 server config；单测显式使用开发配置，避免依赖调用机器上的生产秘密。
process.env.COFLUX_DEV = "1";
const {
  PAGE_COOKIE_NAME,
  PageSessionStore,
  buildPageCookie,
  clearPageCookie,
  crossSiteRequest,
  escapeHtml,
  readForm,
  readPageCookie,
  renderAuthorizeConfirm,
  renderConsentConfirm,
  renderLoginForm,
  renderPage,
} = await import("../../apps/server/src/auth-pages.ts");

test("escapeHtml 转义五个 HTML 敏感字符，其余原样", () => {
  assert.equal(escapeHtml(`<script>alert("x") & 'y'</script>`), "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;");
  assert.equal(escapeHtml("中文 · plain-text_ok"), "中文 · plain-text_ok");
});

test("页面模板：设备名 / 应用名 / scope / 回填参数全部经转义，不出现裸标签", () => {
  const device = renderAuthorizeConfirm("/authorize/t/confirm", "c", { name: "<script>alert(1)</script>", host: "h<b>", platform: '"p"' });
  assert.ok(!device.includes("<script>"), "设备名里的 <script> 不能原样进 HTML");
  assert.ok(device.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(device.includes("h&lt;b&gt;") && device.includes("&quot;p&quot;"));

  const consent = renderConsentConfirm("/oauth/consent/decide", "c", 'req"><img src=x onerror=1>', { clientName: "<img src=x>", redirectHost: "localhost:1", scope: "<s>" });
  assert.ok(!consent.includes("<img"), "应用名与 request id 里的标签必须被转义");
  assert.ok(consent.includes('value="req&quot;&gt;&lt;img src=x onerror=1&gt;"'));
  assert.ok(consent.includes("scope: &lt;s&gt;"));

  const login = renderLoginForm({ action: "/proxy-auth/login", title: "访问端口预览", description: "d", submitLabel: "登录并访问", hidden: { to: 'http://x/"><script>' } }, "csrf-1", "登录失败：用户名或密码错误");
  assert.ok(login.includes('name="to" value="http://x/&quot;&gt;&lt;script&gt;"'));
  assert.ok(login.includes('name="csrf" value="csrf-1"'));
  assert.ok(login.includes("登录失败：用户名或密码错误"));
  assert.ok(login.includes('name="username"') && login.includes('name="password"'));

  const page = renderPage("授权新设备", "<p>x</p>");
  assert.ok(page.startsWith("<!doctype html>"));
  assert.ok(page.includes("coflux") && page.includes("安全连接到你的远程工作区"));
  assert.ok(!page.includes("<script"), "页面不含任何 JS");
});

test("页面 cookie：拼装带 HttpOnly/SameSite=Lax/Path/Max-Age，Secure 只按参数加；清除即 Max-Age=0", () => {
  const cookie = buildPageCookie("cf_pgs_abc", "/authorize", 600_000, false);
  assert.equal(cookie, "cf_page=cf_pgs_abc; Path=/authorize; HttpOnly; SameSite=Lax; Max-Age=600");
  assert.ok(buildPageCookie("v", "/proxy-auth", 1000, true).endsWith("; Secure"));
  assert.equal(clearPageCookie("/oauth/consent", false), "cf_page=; Path=/oauth/consent; HttpOnly; SameSite=Lax; Max-Age=0");
  assert.equal(PAGE_COOKIE_NAME, "cf_page");
});

test("页面 cookie：从 Cookie 头里只取 cf_page，形状不对（空、超长、非 token 字符）视同缺失", () => {
  assert.equal(readPageCookie("a=1; cf_page=cf_pgan_x-Y_9; b=2"), "cf_pgan_x-Y_9");
  assert.equal(readPageCookie(undefined), undefined);
  assert.equal(readPageCookie("cf_page="), undefined);
  assert.equal(readPageCookie("cf_page=has space"), undefined);
  assert.equal(readPageCookie(`cf_page=${"x".repeat(300)}`), undefined);
  assert.equal(readPageCookie("cf_proxy_session=abc"), undefined);
});

test("csrf：隐藏字段是 cookie 值的 HMAC，换 cookie / 换密钥 / 篡改一位都不通过", () => {
  const store = new PageSessionStore(60_000, 8, Buffer.alloc(32, 1));
  const other = new PageSessionStore(60_000, 8, Buffer.alloc(32, 2));
  const nonce = store.anonymousValue();
  assert.ok(store.isAnonymousValue(nonce));
  const csrf = store.csrfFor(nonce);
  assert.ok(store.verifyCsrf(nonce, csrf));
  assert.ok(!store.verifyCsrf(store.anonymousValue(), csrf), "绑定别的 cookie 值不通过");
  assert.ok(!other.verifyCsrf(nonce, csrf), "别的密钥算出的不通过");
  assert.ok(!store.verifyCsrf(nonce, csrf.slice(0, -1) + (csrf.endsWith("A") ? "B" : "A")));
  assert.ok(!store.verifyCsrf(undefined, csrf), "没有 cookie 一律拒");
  assert.ok(!store.verifyCsrf(nonce, undefined) && !store.verifyCsrf(nonce, ""));
  assert.equal(store.size, 0, "匿名 nonce 与 csrf 都不占会话表");
});

test("页面会话：TTL 到期即失效、流程不串用、删除后拿不到", () => {
  const store = new PageSessionStore(1_000, 8, Buffer.alloc(32, 3));
  const t0 = 1_000_000;
  const session = store.create("authorize", { accountId: "acc", userId: null }, t0);
  assert.ok(session?.token.startsWith("cf_pgs_"));
  assert.equal(session.failures, 0);
  assert.equal(store.get(session.token, "authorize", t0 + 999), session);
  assert.equal(store.get(session.token, "consent", t0 + 999), undefined, "authorize 的会话不能用于同意页");
  assert.equal(store.get(session.token, "authorize", t0 + 1_000), undefined, "TTL 到期后须重新登录");
  assert.equal(store.size, 0, "过期项已被摘除");

  const again = store.create("proxy", { accountId: "acc", userId: "u1" }, t0);
  assert.equal(again.userId, "u1");
  store.delete(again.token);
  assert.equal(store.get(again.token, "proxy", t0), undefined);
});

test("页面会话：满额拒绝新建、不淘汰仍有效项；过期项让位", () => {
  const store = new PageSessionStore(1_000, 2, Buffer.alloc(32, 4));
  const t0 = 5_000;
  const first = store.create("consent", { accountId: "a", userId: null }, t0);
  const second = store.create("consent", { accountId: "b", userId: null }, t0);
  assert.equal(store.create("consent", { accountId: "c", userId: null }, t0), undefined, "满额应 fail closed");
  assert.ok(store.get(first.token, "consent", t0) && store.get(second.token, "consent", t0));
  const third = store.create("consent", { accountId: "c", userId: null }, t0 + 1_000);
  assert.ok(third, "过期项清掉后可以新建");
  assert.equal(store.size, 1);
});

test("页面会话：拒绝非法 TTL / 容量 / 过短密钥", () => {
  assert.throws(() => new PageSessionStore(0), /TTL/);
  assert.throws(() => new PageSessionStore(1_000, 0), /容量/);
  assert.throws(() => new PageSessionStore(1_000, 1, Buffer.alloc(8)), /密钥/);
});

test("来源纵深校验：Origin / Sec-Fetch-Site 缺失放行，存在且非同源就拒", () => {
  const origin = "http://127.0.0.1:8787";
  const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });
  assert.equal(crossSiteRequest(headers({}), origin), false, "Node fetch 不带 Origin，缺失必须放行");
  assert.equal(crossSiteRequest(headers({ origin }), origin), false);
  assert.equal(crossSiteRequest(headers({ origin, "sec-fetch-site": "same-origin" }), origin), false);
  assert.equal(crossSiteRequest(headers({ "sec-fetch-site": "none" }), origin), false);
  assert.equal(crossSiteRequest(headers({ origin: "https://evil.example" }), origin), true);
  assert.equal(crossSiteRequest(headers({ origin: "null" }), origin), true);
  assert.equal(crossSiteRequest(headers({ origin, "sec-fetch-site": "cross-site" }), origin), true);
  assert.equal(crossSiteRequest(headers({ "sec-fetch-site": "same-site" }), origin), true, "预览兄弟子域也是跨站");
});

test("表单读取：只收 urlencoded、超过上限拒绝、正常表单解析成 URLSearchParams", async () => {
  const form = (body, headers = {}) => new Request("http://127.0.0.1/x", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
  const ok = await readForm(form("username=admin&password=a%26b&csrf=c"));
  assert.equal(ok.get("username"), "admin");
  assert.equal(ok.get("password"), "a&b");
  assert.equal(await readForm(new Request("http://127.0.0.1/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })), undefined);
  assert.equal(await readForm(form("a=" + "x".repeat(100)), 50), undefined, "超过上限的表单被拒");
  assert.equal(await readForm(form("a=1", { "content-length": "999999" }), 50), undefined, "声明超长直接拒");
});
