# Plan 107: 放弃 web 端第二片——三张卫星页面收进 server 直出 HTML，`COFLUX_WEB_URL` 退役

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c1e82cc..HEAD -- apps/server/src scripts/desktop-dev-fixture.mjs tests/src/authorize.test.mjs tests/src/mcp-oauth.test.mjs tests/src/proxy.test.mjs tests/src/oauth-harness.mjs tests/src/harness.mjs docs/auth-design.md docs/deployment.md docs/architecture.md README.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: 106（分支 `dev/20260911-desktop-only-merge`，本分支自其顶端 `c1e82cc` 切出；106 尚未合 main）
- Category: feature
- Execution: subagent（宿主通用子 agent，`model: fable`；出发检查 2026-09-11 记录，全自动推进，不再确认）
- Planned at: `c1e82cc`, 2026-09-11

## Requirement

plan 106 把 `apps/web` 并入桌面版并出仓后，三条必须在**系统浏览器**里完成的流——新机器登记
（`cofluxd up` 打印的 `/authorize/<token>`）、MCP 宿主 OAuth 同意页（`/oauth/consent?request=`）、端口预览
门禁（`/proxy-auth?to=`）——只剩冻结的线上 web bundle 在承担：server 仍用 `COFLUX_WEB_URL` 拼链接、302 到
`app.coflux.dev`，那份 bundle 走的是旁路 WS 连接 + `localStorage` 里的 web 会话。它是产品关键路径
（新设备登记断了就没法接入任何机器），却依赖一份不再维护的前端。本 plan 让 `apps/server` 自己直出这三张
页面，链接全部由 `COFLUX_PUBLIC_URL` 拼，`COFLUX_WEB_URL` 退役；冻结的 web 从此只剩历史工作台，server
不再生成任何指向它的链接。

### 产品结论（探索阶段已确认，勿再问）

- **消费者与触发**（三条流不变）：
  - 新机器上 `cofluxd up` 打印链接，用户在任意浏览器打开 → 登录 → 看到设备名/主机/平台 → 点「授权此设备」→ 完成页。
  - Claude Code / Codex 接入 MCP，宿主打开浏览器到 `/oauth/authorize` → 302 到同意页 → 登录 → 看到应用名/回调 host/scope
    → 允许或拒绝 → 直接 302 回宿主回调。
  - 桌面 app 点端口预览，系统浏览器落到门禁 → 登录 → server 签发一次性 code 并直接 302 到预览域回调（cookie 落在预览域，与现在一致）。
- **形态**：三张页面由 `apps/server` 直出，地址在 `COFLUX_PUBLIC_URL` 下（生产 `https://api.coflux.dev/authorize/<token>`、
  `/oauth/consent?request=<id>`、`/proxy-auth?to=<url>`），纯 HTML + 内联 CSS、表单 POST、**不需要 JS 也能走通**；外观
  沿用旧页骨架：深色、居中约 400px 卡片、顶部 `coflux` 标题、底部「安全连接到你的远程工作区」。不是桌面 app 的一部分，
  不再引用冻结的 web。
- **登录态**（用户 2026-09-11 定）：**每次流程都登录，只保留几分钟**。登录后只发一个为本次流程服务的短命 HttpOnly cookie，
  足够走完「确认」那一步；不做长期登录、不做登出、不做「记住我」。
- **状态与文案**（沿用旧页，源码在 git 历史 `ce7026b` 的 `apps/web/src/pages/{AuthorizePage,OAuthConsentPage,ProxyAuthPage}.tsx`
  与 `apps/web/src/components/auth/auth-shell.tsx`）：
  - 登录表单：标题/副标题按页面（「授权新设备 / 先登录你的账号，再确认这台设备的信息」「授权应用访问 / 先登录你的账号，
    再决定是否允许该应用访问」「访问端口预览 / 登录后将安全跳转到该工作区的预览页面」），账号/密码两栏，提交按钮
    「登录并继续」/「登录并访问」，错误横幅「登录失败：用户名或密码错误」。
  - 授权页：链接无效或已过期 →「授权链接不可用」；确认 → 设备卡片（名称 + `host · platform`）+「授权此设备」；完成 →
    「设备已授权：设备已登记到你的账号，可以关闭此页面」；失败（daemon 已断线、设备数超限、已被兑现）→「授权未完成」+ 原因。
  - 同意页：请求无效或已过期 →「授权请求不可用」；确认 →「<应用名> 请求访问你的 coflux 账号」+ 卡片（应用名、
    「授权完成后跳回 <host>」、scope）+「允许访问」「拒绝」；允许与拒绝都直接 302 到 server 算出的宿主回调 URL；
    缺 `request` 参数 → 「链接缺少授权请求 id，请回到宿主重新发起授权」。
  - 门禁页：缺 `to` 或形状不对 →「预览链接无效：链接缺少跳转目标，请从终端 Tab 的端口入口重新打开」；登录成功即
    302 到预览域回调；预览不存在/不属于当前账号 →「无法打开预览」+ 原因。
- **验收（用户可观察）**：`cofluxd up` 打印的是 `api.coflux.dev` 链接且全程走通；MCP 接入走通；预览门禁走通；
  server 代码与配置里不再有 `COFLUX_WEB_URL` / `app.coflux.dev`；黑盒覆盖三条 HTTP 流。
- **非目标**：已授权应用列表/撤销、登出、长期登录、`coflux://` 深链接、视觉重设计、多语言、去掉 WS 侧的同款消息。

正确解与相邻错误解：正确解是 **server 直出的页面复用与 WS 分支完全相同的业务逻辑（凭证校验、待授权 token 的一次性与
TTL、OAuth 决定、预览 code 签发），只多出「短命页面会话 + CSRF」这一层浏览器语义**。把凭证校验复制一份改写、让页面
登录写 `client_tokens`（30 天 WS 会话）、登录前就核对 token/request 是否有效、只靠 SameSite 不做 csrf、在 handler 里
碰 `socket`、给三张页面引前端框架或模板引擎、顺手删掉 WS 侧的 `deviceAuthorize*`/`oauthAuthorize*`/`proxyIssueAuth`——
都不是本需求的完成态。

## Decisions & tradeoffs

- **落位 = RavenJS 契约路由，handler 不含判断**：三张页面是 `defineContract` + `withSchema` 声明、在 `app.ts` 里
  `registerContractRoute` 的路由，放 `apps/server/src/interface/` 下一个新目录（命名执行者定）；handler 只从
  `RavenContext.getOrFailed()` 取 `request`/`params`/`query`、取 `HubState.getOrFailed()`、构造 `Response`，业务规则
  与 HTML 拼装放服务模块。Rejected: 在 `index.ts` 的 `http.createServer` 里手写路由——绕开 Raven 会失去统一错误信封与
  路由清单，且 `index.ts` 只该做传输分流。Based on: `apps/server/src/app.ts`（`registerContractRoute` 序列）、
  `apps/server/src/interface/oauth/oauth.contract.ts`（`schemas: {}` 的契约写法）、`oauth.handler.ts:3`（「这里不含任何判断」）、
  `oauth.handler.ts:41-42` 与 `interface/get-health/get-health.handler.ts`（RavenContext / HubState 取用范式）。
  RavenJS 事实：上下文只有标准 Fetch `request`、`params`、`query`、`url`（`apps/server/node_modules/@raven.js/core/dist/index.mjs:131-140`），
  路径参数写 `:name`（同文件 `:120-123`），**没有来源地址**（`apps/server/src/oauth.ts:135-136` 注释、`config.ts:131`）。
- **入口地址固定，全部挂 `config.publicUrl`**：`GET /authorize/:token`、`GET /oauth/consent?request=<id>`、
  `GET /proxy-auth?to=<url>` 三个入口的路径与参数名不变（daemon、CLI、黑盒 `tokenFromUrl`、文档都按这个形状），只是基址
  从 `webUrl` 换成 `publicUrl`；登录 / 确认 / 决定的 POST 路由怎么命名执行者定。`config.webUrl` 与环境变量 `COFLUX_WEB_URL`
  删除，`scripts/desktop-dev-fixture.mjs:47` 一并清掉。Based on: `apps/server/src/hub.ts:2005`（授权链接）、
  `apps/server/src/oauth.ts:152-154`（`consentUrlBase`）、`apps/server/src/proxy.ts:630-635`（`redirectToAuth`）、
  `apps/server/src/config.ts:82-98,115-120`（`publicUrl` 已做合法性校验且不看请求头）、`tests/src/harness.mjs:607`。
- **登录态 = 短命内存页面会话**：凭证校验通过后由 hub 在内存签发页面会话（随机 token、TTL 取 `config.authorizeTtlMs`、
  条目有上限、满额拒绝新建，与 `pendingAuthorizations` / `ProxyGate` 同一「单实例内存态」取舍），记 accountId 与 userId
  （password 模式才有）；`Set-Cookie` 必须 HttpOnly + SameSite=Lax + `Max-Age`=TTL，`publicUrl` 为 https 时加 Secure、
  http（本机开发与黑盒）时不加。**不写 `client_tokens`**、不签 `ck_sess`。Rejected: 复用 30 天 WS 会话——用户定的是
  每次流程都登录；Rejected: 把会话放 Postgres——与其余待确认状态不一致且无收益。Based on: `apps/server/src/hub.ts:3217-3290`
  （WS 登录路径签 `ck_sess` 并 `upsertClientToken`，页面路径不得走到这一步）、`config.ts:149`（`authorizeTtlMs` 默认 10 分钟）、
  `apps/server/src/proxy.ts:278-292`（`buildSetCookie` 的属性写法与 Secure 条件先例）。cookie 名与 Path 执行者定。
- **流程形态 = PRG**：每张页面 GET 无会话 → 登录表单；登录 POST 成功 → 303 回同一 GET；GET 有会话时——授权页显示
  设备卡片、同意页显示应用卡片、门禁页直接签发 code 并 302 到 `buildAuthCallbackUrl` 的结果；「授权此设备」「允许」「拒绝」
  各是 POST，授权页完成后渲染完成页，同意页 302 到宿主回调。**token / request id 的有效性只在登录后核对**（登录前不给
  oracle），门禁页的 `to` 参数只做形状校验（`parseProxyRedirect`），归属校验在登录后。Rejected: 一张表单同时收凭证与
  决定——确认动作必须由已认证的人做，且会把凭证和动作耦合在一次提交里。Based on: 旧页面均为「登录后再查信息」
  （`ce7026b:apps/web/src/pages/AuthorizePage.tsx` 的 `authOk → deviceAuthorizeInfo`）；`apps/server/src/proxy.ts:307-321`
  （`parseProxyRedirect` / `buildAuthCallbackUrl`）。
- **CSRF**：登录、确认、决定三类 POST 都带绑定页面会话的隐藏 csrf 字段（登录 POST 绑定一个登录前的匿名会话或等价机制，
  执行者定），服务端核对不符即拒；`Origin` / `Sec-Fetch-Site` 只作纵深：存在且不是同源/none 就拒，**缺失放行**（Node 的
  `fetch` 不带 Origin，黑盒才跑得通）。仅靠 SameSite=Lax 不算完成态。Based on: 同意页「允许」会签发 OAuth 授权码、授权页
  「授权」会把设备绑进账号，都是有副作用的跨站可诱导动作。
- **限速与失败计数**：登录 POST 按来源地址限速，复用 hub 现有 `loginLimiter`（需要一个不依赖 `ClientConn` 的入口）；
  来源地址由 `index.ts` 在把请求交给 fetch 适配器之前用 `transport.ts` 的 `requestAddress(req)` 算出，**覆盖写入**一个
  内部请求头（名字执行者定），入站同名头一律丢弃，handler 只读这个头。token / request 猜测失败按页面会话计数，
  上限沿用 `config.authorizeMaxFailures`，语义与 WS 的 `authorizeFailures` 一致。Rejected: 像 DCR 那样全局固定窗口——登录
  爆破必须按来源；Rejected: 信任入站 `X-Forwarded-For`——`requestAddress` 只在直连对端是 loopback 时才信任它，这个判断
  需要 socket，只有 `index.ts` 能做。Based on: `apps/server/src/transport.ts:39-48`、`apps/server/src/hub.ts:378-390,430-431`
  （`FixedWindowLimiter`、`loginLimiter`）、`apps/server/src/index.ts:36-45`（`getRequestListener(fetchHandler)` 之前可以改 `req.headers`）、
  `config.ts:150-155`（`authorizeMaxFailures`、`loginRateLimit`）。
- **复用而非复制业务逻辑**：`handleClientAuth` 里的凭证校验（local / password 两模式、scrypt 并发上限、
  `resolveAccountForUser`）、`checkedPendingAuth` + `completeDeviceAuthorize`、`handleProxyIssueAuth`、`oauth.describePending`
  / `oauth.decide` 的核心都抽成**不依赖 `ClientConn` / WebSocket** 的 Hub（或服务）方法，WS 分支与页面共用；WS 消息
  `deviceAuthorizeInfo` / `deviceAuthorize` / `oauthAuthorizeInfo` / `oauthAuthorizeDecide` / `proxyIssueAuth` **保留且行为不变**
  （冻结 web、既有黑盒仍在用）。抽取的切法执行者定，约束是黑盒既有用例零改动通过。Based on: `hub.ts:3217-3290`、
  `hub.ts:3456-3510`、`hub.ts:2486-2496`、`hub.ts:2690-2721`、`oauth.ts:339-370`。
- **HTML = TS 模板字符串 + 自写转义**：页面用模板字符串拼、内联 CSS，配一个转义助手；所有插值（设备名/主机/平台、
  应用名/回调 host/scope、错误文案、token/request id 回填）必须转义；响应 `content-type: text/html; charset=utf-8`、
  `Cache-Control: no-store`。不引模板引擎、不引前端框架、不需要 JS。Rejected: 复用 Astryx/React 渲染——server 不该背前端栈。
  Based on: `apps/server/src` 目前零 HTML 输出（grep `text/html` 为空），server 依赖面不含任何模板库。
- **黑盒测试**：在既有文件里加 HTTP 流用例、不新建端口：`tests/src/authorize.test.mjs`（HTTP 登录 → 确认 → daemon 上线并能跑任务；
  无效 token；未登录 GET 不泄漏 token 是否有效；csrf 不符被拒；登录限速），`tests/src/mcp-oauth.test.mjs`（`/oauth/authorize`
  的 302 落到 `<publicUrl>/oauth/consent?request=`；HTTP 允许 → 302 回宿主带 code；拒绝 → 带 `error=access_denied`；
  二次决定被拒），`tests/src/proxy.test.mjs`（门禁 302 到 `<publicUrl>/proxy-auth?to=`；HTTP 登录 → 302 到预览域回调 → 种
  cookie）。harness 加 cookie 罐 + 表单 POST 助手，`fetch` 用 `redirect: "manual"`。纯函数部分（转义、cookie 解析/拼装、
  csrf 核对、页面会话 TTL/上限）加一份进程内单测，范式照 `tests/src/proxy-gate.test.mjs`（直接 import `apps/server/src/*.ts`）。
  Based on: `tests/src/authorize.test.mjs:35-115,245`、`tests/src/oauth-harness.mjs:78-95`、`tests/src/mcp-oauth.test.mjs:119-135`、
  `tests/src/proxy.test.mjs:204-234`、`tests/src/harness.mjs:509-560`。
- **文档**：`docs/auth-design.md`（`:74`、`:99-104` 浏览器侧改为 server 直出、`:128` 302 目标）、`docs/deployment.md`
  （「web 冻结」小节改口：三张页面由 server 承担，冻结 bundle 只剩历史工作台；server.env 的 `COFLUX_WEB_URL` 可删，
  部署 107 之后由用户操作）、`docs/architecture.md` §9（端口预览「浏览器先换一次性授权 code」的主体改为 server 页面）、
  README 若提到 web 授权页则改口。措辞写现状，不写编年史。
- **不动**：`apps/desktop`、`crates/*`、`proto` 与 `packages/protocol`、`packages/client`、`packages/cli`（链接形状不变、
  CLI 只打印）、冻结 web、Caddy（`api.coflux.dev` 已整站反代到 8787，见 `docs/deployment.md:73-76`）、`ProxyGate` 的
  code/cookie 语义。

## Direction

一个工作包、两个里程碑，**M2 依赖 M1**（黑盒 HTTP 用例要打的就是 M1 的页面），不拆并发。commit message 中文、结尾带
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

### Milestone 1: server 直出三张页面，链接全部由 `publicUrl` 拼

Hub / OAuthService 暴露不依赖 WS 的共用方法；`index.ts` 注入来源地址内部头；页面会话 + csrf 基础设施；三张页面的
契约路由、handler、服务模块与 HTML；`hub.ts:2005` / `oauth.ts:153` / `proxy.ts:632` 改用 `publicUrl`；`config.webUrl`、
`COFLUX_WEB_URL`（含 `scripts/desktop-dev-fixture.mjs`）删除；纯函数单测就位。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；
`node --import tsx --test tests/src/<新单测文件>.mjs` -> exit 0；`git grep -n "COFLUX_WEB_URL\|webUrl" -- ':!plans'` -> 无输出。

### Milestone 2: 黑盒覆盖三条 HTTP 流，文档改口

`authorize` / `mcp-oauth` / `proxy` 三份黑盒加 HTTP 用例（既有 WS 用例不动），harness 加 cookie 罐与表单助手；三份文档改口。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；
`git grep -n "app.coflux.dev/authorize\|app.coflux.dev/oauth\|app.coflux.dev/proxy-auth" -- ':!plans'` -> 无输出。
（三份黑盒与全量是 acceptance，由验证方跑。）

## Landmines

- **Raven handler 里拿不到 socket**：`oauth.ts:135-136` 明说上下文无来源 IP，DCR 才退到全局限速。页面登录限速的来源地址
  必须在 `index.ts` 的 `http.createServer` 回调里算好塞进请求头（`@hono/node-server` 的 `getRequestListener` 会把 `req.headers`
  原样带进 Fetch `Request`）；先确认这条路径可行，若适配器不透传自定义头，改用其它能把地址从 `IncomingMessage` 带到 handler
  的方式，但**入站同名头永远不可信**。
- **两种 cookie 别混**：`proxy.ts:278-292` 的 `cf_proxy_session` 挂在预览父域（`Domain=.coflux.dev`）、7 天有效，是预览域
  的门禁；页面会话 cookie 挂在 `publicUrl` 的 origin、几分钟有效。`tests/src/proxy.test.mjs:225-234` 对 `cf_proxy_session`
  的断言（只能有一个 Max-Age、名字不变）不能被页面 cookie 的改动碰到。
- **黑盒里 `publicUrl` 是 `http://127.0.0.1:<port>`**：cookie 若带 Secure，Node `fetch` 不会回带，整条流会假红；Secure 只在
  `publicUrl` 为 https 时加。Node `fetch` 也不发 `Origin`，Origin 校验缺失必须放行。
- **`tokenFromUrl`（`tests/src/harness.mjs:607`）按 `<base>/authorize/<token>` 取 token**、`mcp-oauth.test.mjs:119` 断言
  Location 含 `/oauth/consent?request=`、`proxy.test.mjs:210-214` 断言 302 落到 `/proxy-auth` 且带 `to`——入口形状不变就都不用改。
- **`completeDeviceAuthorize` 的副作用面**：它会 `registerDaemonConn`、给 daemon 推 `daemonEnrolled`、设备数超限时给 daemon 发
  `daemonAuthError` 并断连（`hub.ts:3472-3510`）。抽成共用方法时这些副作用一个都不能少，只是「回给浏览器」的那一步从
  `sendClient` 变成返回值。
- **OAuth `decide` 需要 userId**（`hub.ts:2711-2712` 从 `client_tokens` 反查）：页面会话必须在登录时就记下 userId
  （password 模式来自 `getUserByEmail`，local 模式为 null），不能再靠 token 反查。
- **`config.authorizeMaxFailures` 是「同一连接累计」语义**：页面侧换成「同一页面会话累计」，不要按来源地址——共享出口
  IP 的用户会被连坐。
- **登录 POST 不要在成功前泄漏 token 状态**：登录失败页只说「用户名或密码错误」，不能顺手告诉对方链接是否有效。
- **黑盒新增用例的端口**：三份文件各自已有 `PORT`，在既有文件里加用例即可；若新建文件，用
  `grep -h "PORT = " tests/src/*.test.mjs | sort -t= -k2 -n` 挑没人用的号。
- **本仓库 Bash 守卫**：命令文本里出现 `git worktree add/remove/move` 字样的整条命令会被拦（含 heredoc / commit 正文）；
  zsh 下 `set -e` 不生效，多步用 `&&`。改文档用 Edit/Write 工具。

## Scope

In scope:
- `apps/server/src/**`（`app.ts`、`config.ts`、`hub.ts`、`oauth.ts`、`proxy.ts`、`transport.ts`、`index.ts`、`interface/<新目录>/**`、必要的新服务模块）
- `scripts/desktop-dev-fixture.mjs`（删 `COFLUX_WEB_URL`）
- `tests/src/authorize.test.mjs`、`tests/src/mcp-oauth.test.mjs`、`tests/src/proxy.test.mjs`、`tests/src/oauth-harness.mjs`、`tests/src/harness.mjs`、新增的进程内单测文件
- `docs/auth-design.md`、`docs/deployment.md`、`docs/architecture.md`、`README.md`
- `plans/107-server-auth-pages.md`（仅记录偏离；`plans/README.md` 由编排者收尾）

Out of scope:
- `apps/desktop/**`、`packages/**`、`crates/**`、`proto/**`、`integrations/**`、`apps/ios/**` — 不受影响
- WS 消息 `deviceAuthorize*` / `oauthAuthorize*` / `proxyIssueAuth` 的删除或改形 — 保留
- `ProxyGate` 的 code / cookie 语义、预览域 Caddy 配置 — 不动
- 长期登录、登出、已授权应用列表、深链接、视觉重设计 — 非目标
- 生产 server.env 删 `COFLUX_WEB_URL`、部署 — 用户操作

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| 进程内单测 | `node --import tsx --test tests/src/<新单测文件>.mjs tests/src/proxy-gate.test.mjs` | exit 0 |
| 残留引用 | `git grep -n "COFLUX_WEB_URL\|webUrl\|app.coflux.dev/authorize\|app.coflux.dev/oauth\|app.coflux.dev/proxy-auth" -- ':!plans'` | 无输出 |
| 插件目录一致 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| 三条流黑盒 (acceptance) | `node --import tsx --test tests/src/authorize.test.mjs tests/src/mcp-oauth.test.mjs tests/src/proxy.test.mjs` | exit 0 |
| 黑盒全量 (acceptance) | `pnpm -C tests test` | 除已知本机假红/flaky 外全绿 |
| 人工走查 (acceptance) | 本机 `pnpm dev:server` + `cofluxd up --server ws://localhost:8787/daemon`，浏览器打开打印的链接 | 三张页面按产品结论工作 |

## Done criteria

- [ ] 上表非 acceptance 命令全部 exit 0，acceptance 由验证方跑。
- [ ] `cofluxd up` 拿到的链接、`/oauth/authorize` 的 302、预览门禁的 302 全部以 `config.publicUrl` 开头；`config.webUrl` 与 `COFLUX_WEB_URL` 不存在。
- [ ] 三张页面无 JS 可走通：登录（错误横幅）→ 确认/决定 → 完成或 302；文案与状态对齐产品结论。
- [ ] 登录成功只签短命 HttpOnly 页面会话 cookie，`client_tokens` 不新增行；TTL 到期后须重新登录。
- [ ] csrf 不符的 POST 被拒；登录前 GET 不区分 token/request 是否有效；登录 POST 按来源限速；猜测失败按页面会话计数。
- [ ] WS 侧 `deviceAuthorize*` / `oauthAuthorize*` / `proxyIssueAuth` 行为不变，既有黑盒用例零改动通过。
- [ ] 所有 HTML 插值经转义（黑盒或单测至少覆盖设备名含 `<script>` 一例）。
- [ ] 新增单测与黑盒用例存在且断言真实行为。
- [ ] 实现遵守 Decisions & tradeoffs 每一条。
- [ ] 没有 scope 外文件改动。
- [ ] `plans/README.md` 107 行状态已更新（编排者）。

## STOP conditions

- Decisions & tradeoffs 引用的事实不再成立（尤其 Raven 上下文形状、`handleClientAuth` / `completeDeviceAuthorize` / `oauth.decide` 的签名与副作用、`requestAddress` 的信任规则）。
- 完成需求需要改 `proto` / `packages/protocol` / `packages/client` / `apps/desktop` 中任一。
- `@hono/node-server` 不透传自定义请求头且找不到把来源地址带进 handler 的可靠方式。
- 某条验证命令在一次合理修复后仍连续失败两次。

## Maintenance notes

- 三张页面从此是 server 的一部分：改 `deviceAuthorize*` / `oauthAuthorize*` / `proxyIssueAuth` 的语义时，页面与 WS 两条入口共用同一核心，改一处即两处生效。
- 页面会话与 csrf 是纯内存态、单实例前提（同 `pendingAuthorizations` / `ProxyGate`，见 `docs/OPEN_QUESTIONS.md` B7）；多实例部署要一起挪到共享存储。
- 冻结的线上 web 里那三张旧页面仍能手动访问（走 WS 消息），但 server 不再链接到它们；等 app.coflux.dev 退场时不需要再改 server。
- 生产部署 107 后 server.env 里的 `COFLUX_WEB_URL` 是死变量，删掉即可；`COFLUX_BUILD_ID_FILE` 仍为冻结工作台服务。
