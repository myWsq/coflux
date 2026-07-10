# Plan 006: server/web 侧 —— Host 路由反代 + 登录门禁 + 预览链接 UI

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- apps/server apps/web packages/protocol`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: plans/004-port-forward-protocol.md
- Category: feature
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

server(`apps/server`)与 web(`apps/web`)获得完整的反代与门禁能力,协议契约以
plan 004 落地后的 `packages/protocol` 代码为真相源:

1. **端口路由**:处理 daemon 上报的 `ports.update`(按连接 daemonId 归属校验),
   为每个 (daemonId, port) 维护短路由标识 shortId 与预览 URL;向该账号 client
   广播 `ports.updated`,`state.snapshot` 带全量端口;daemon 掉线、会话退出、端口
   消失时撤销路由并广播空集。
2. **反向代理**:Host 匹配 `<shortId>.<proxyHost>` 的 HTTP 请求与 WS upgrade,经
   持有该路由的 daemon 隧道(`proxy.open`/kind=4 帧/`proxy.close`)透传到目标端口;
   非代理 Host 的行为与现状完全一致(/health、/daemon、/client)。
3. **登录门禁**:代理请求无有效 proxy cookie 时 302 到 web 的授权路由;web(已
   登录会话)经 WS `proxy.issueAuth` 换取一次性回调 URL 并跳转;server 在回调端点
   验 code、种 cookie、302 回原路径。cookie 会话必须与路由所属 device 的 accountId
   匹配,跨账号访问一律 403/重新授权。redirect 目标严格限定本服务的代理子域名
   (防开放重定向)。
4. **web UI**:运行中 task 显示探测到的端口徽标/链接(点开即预览 URL);实现
   `#/proxy-auth` 授权跳转路由(参照既有 `#/authorize/<token>` 设备授权页模式)。

浏览器可见的正确行为:在远程 task 的 PTY 里起 dev server → 数秒内 task 行出现
端口链接 → 点击 → (首次经一次无感跳转)页面完整可用,含绝对路径静态资源与
HMR WebSocket。

## Decisions & tradeoffs

- **Host 头路由 + 泛子域名**:`proxyHost` 进 config(env `COFLUX_PROXY_HOST`,dev
  默认 `p.localhost`);请求 Host 形如 `<shortId>.<proxyHost>` 即代理请求。本地/
  测试用 Host 头模拟,不需要真 DNS。Rejected: 路径前缀 `/proxy/<id>/...` —— 绝对
  路径资源全 404,重写是无底洞(dev-explore 已定)。
  Based on: `apps/server/src/index.ts:53,69` 单一 http server 同时处理 request 与
  upgrade,天然可按 Host 分流;生产 Caddy 在前(`apps/server/src/config.ts:44`),
  泛证书由部署侧承担。
- **shortId:server 内存签发的随机短标识(不含 daemonId/port 语义)**:每个
  (daemonId, port) 首次出现时签发(如 10 字符 base36),server 运行期间稳定,重启
  重签。URL 不泄露设备信息。Rejected: `<daemonId>-<port>` 直拼 —— 43 字符难看且
  泄露内部 id;HMAC 确定性 id —— 过度设计,重启后 URL 变化的代价仅是重新点一次
  链接。Based on: 路由是运行时态,与 Session 同生命周期哲学
  (`docs/architecture.md` §5「Session 是运行时实体,不落盘」)。
- **代理采用连接粒度透传(首请求后接管 socket)**:识别为代理请求后完成门禁
  校验,然后重建请求原始字节(请求行 + rawHeaders + 已缓冲 body)写入隧道,并把
  `req.socket` 与隧道双向对拼;此后该 TCP 连接上的 keep-alive 后续请求、WS upgrade
  帧全部透传,server 不再解析。upgrade 事件同理(head + socket 对拼)。Rejected:
  按请求粒度转发(重组 HTTP)—— SSE/长轮询/分块编码/websocket 各要专门处理,
  透传一劳永逸且天然支持 HMR。注意:接管后同连接不再重验 cookie(连接已授权),
  可接受。Based on: node http server 在 'request'/'upgrade' 事件均可拿到底层
  socket;hub 中继「只校验归属、原样转发字节」的既有原则(`docs/architecture.md` §6)。
- **门禁 cookie:随机 token,server 内存表 {accountId, exp},Domain=.<proxyHost>**:
  一次授权覆盖该账号在本浏览器的所有预览子域名;HttpOnly + SameSite=Lax +
  (https 时)Secure;TTL 复用 `config.sessionTtlMs` 量级(执行者定,≥1 天)。每个
  代理请求校验 cookie 存在、未过期、且 `cookieSession.accountId ===
  route.accountId`——通配 Domain 下跨账号路由靠这一步隔离,必须有测试意识。
  server 重启 cookie 失效 → 自动重走无感跳转,用户已登录故无感。Rejected:
  JWT/HMAC 无状态 cookie —— 单实例部署(docs/OPEN_QUESTIONS B7)内存表更简单
  且可主动撤销;复用 client_tokens 表 —— 语义混杂,proxy 会话是运行时态。
  Based on: `pendingAuthorizations` 同款内存 + TTL 模式(`apps/server/src/hub.ts:69-79,107`)。
- **授权链路:302 → web `#/proxy-auth?to=…` → WS `proxy.issueAuth {redirect}` →
  `proxy.auth {url}` → 302 回调 `/__coflux/auth?code=…&to=…` → 种 cookie → 302 原路径**:
  code 一次性、TTL 60s、绑定 accountId。server 校验 redirect 的 host 匹配
  `^[a-z0-9]+\.<proxyHost>$` 且 shortId 存在、属于该 client 的 account;`to` 仅取
  path+query(不含 host),杜绝开放重定向。Rejected: web 直接种 cookie —— 跨域
  种不了;URL 上带长期 token —— 泄露面大,一次性 code 是标准解法。
  Based on: web 已有会话(`auth.ok` 的 clientToken,`apps/server/src/hub.ts:690-733`)
  与 hash 路由授权页先例(plan 003 的 `/authorize/<token>` 页)。
- **回调路径挂在代理子域名的 `/__coflux/auth`**:被代理应用自身的路径不可能撞
  `__coflux` 前缀(约定保留);仅此一条路径在代理域上由 server 自答,其余全透传。
  Rejected: 挂在主域 —— cookie 要种在 `.<proxyHost>` 上,必须由该域下的响应来 Set-Cookie。
- **隧道 server 侧状态**:connId(server 签发)→ 浏览器 socket 的 map;daemon 的
  `proxy.opened {ok:false}`/`proxy.closed` → 毁浏览器 socket(HTTP 未接管时可回
  502);浏览器 socket close → `proxy.close`;daemon 掉线 → 该 daemon 全部隧道
  socket 毁 + 路由撤销。归属校验:kind=4 上行帧仅当 connId 属于该 daemon 连接时
  转发(同 pty 帧的 `s.daemonId !== conn.daemonId` 模式,`apps/server/src/hub.ts:183`)。
- **web UI 最小呈现 (decided while planning)**:task 行内端口徽标(`:5173 ↗`),
  href = 预览 URL,新标签打开;数据来自 snapshot.ports + ports.updated 增量维护。
  不做端口管理面板/开关——探到即可用是已确认方向。

## Direction

server 侧改动集中在:config(proxyHost)、index.ts(Host 分流:代理 request/upgrade
→ 新 proxy 模块;主域行为不变)、新 proxy 模块(门禁 + code/cookie 表 + socket↔隧道
对拼)、hub(ports.update 处理/路由表/广播/snapshot/proxy.issueAuth/隧道帧转发/
清理钩子)。建议隧道与门禁独立成 `proxy.ts`,hub 只做路由与归属,保持 hub 的
「编排路由」定位。web 侧:App.tsx 加 proxy-auth 路由与端口徽标。

### Milestone 1: 端口路由状态机(无反代)

ports.update → 路由表 + shortId + 广播 + snapshot;session 退出/daemon 掉线撤销。
Validation: `pnpm exec tsc --noEmit -p apps/server` -> exit 0(行为归 007 黑盒)。

### Milestone 2: 反代数据通路(无门禁,或门禁可用假开关旁路)

Host 分流 + 隧道对拼 + 生命周期清理;curl 带伪造 Host 可打通到本机测试端口。
Validation: `pnpm exec tsc --noEmit -p apps/server` -> exit 0。

### Milestone 3: 登录门禁闭环 + web UI

302/issueAuth/回调/cookie/账号隔离;task 行端口链接;proxy-auth 路由。
Validation: `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web`
-> exit 0。

## Landmines

- 新 ClientToServer/DaemonToServer 消息若未同时进 `packages/protocol` 的 FIELDS
  白名单(004 已加,勿改坏),transport 层静默丢弃,表现为超时。
- `handleDaemonBinary`(`apps/server/src/hub.ts:178`)目前只认 pty 三帧;kind=4 上行
  必须在此分流并做 connId→daemon 归属校验,否则恶意 daemon 可向他人浏览器注字节。
- 浏览器 socket 有 `clientBufferHardLimit` 类似的内存风险:对拼时用
  `socket.write` 返回值/`drain` 或 `pipe` 语义控制,别无限缓冲(参考
  `hub.ts:184-192` 对慢 client 的处理哲学;简单做法:超水位直接毁连接)。
- `req.socket` 接管后必须把该 socket 从 http server 的 keep-alive 管理里摘干净
  (移除已有 listeners / `socket.removeAllListeners('data')` 前先确认 node 版本行为),
  否则 http parser 会和透传字节打架——这是本 plan 实现难度最高的一处,先写
  upgrade 路径(干净拿到 socket+head)再做 request 路径。
- 代理域上的 `/health`、`/daemon`、`/client` 不存在——Host 分流必须先于现有
  upgrade 路由判断(`apps/server/src/index.ts:69-78` 现按 pathname destroy 兜底)。
- web 的 WS 服务地址来自 `VITE_COFLUX_SERVER`(README env 表);proxy-auth 页面
  必须在同一 WS 会话上发 issueAuth,复用 App 现有连接管理,别新开裸连接。
- dev 环境无 https,cookie 不能带 Secure;按 `x-forwarded-proto`/URL scheme 条件加。

## Scope

In scope:
- `apps/server/src/**`
- `apps/web/src/**`

Out of scope:
- `packages/protocol` —— 契约已由 004 冻结;发现缺口 STOP 上报
- `crates/**` —— 归 005
- `tests/src/**`、docs —— 归 007
- 生产 DNS 泛解析 / Caddy 泛证书配置 —— 部署侧,不在本仓库代码内

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| TS 类型检查 | `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web` | exit 0 |
| Rust 构建(未破坏) | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| 黑盒回归 (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0(既有用例不回归) |

## Done criteria

- [ ] All listed commands pass.
- [ ] 非代理 Host 的所有既有行为不变(黑盒回归绿)。
- [ ] 无 cookie 的代理请求 302 到 web;伪造/过期/跨账号 cookie 不放行。
- [ ] redirect/`to` 校验拒绝任意外部 URL(无开放重定向)。
- [ ] daemon 掉线后其全部路由与在途隧道被清理,client 收到端口撤销广播。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- 004 落地的协议缺字段/缺消息,无法表达路由或门禁语义。
- `req.socket` 接管方案在当前 node 版本走不通(http parser 无法安全解除)——
  这推翻连接粒度决策,需回报重新决策(降级为请求粒度 + 单独处理 upgrade)。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

生产上线前置(部署侧,不在代码内):`*.p.coflux.dev` 泛解析指向 prod-jp、Caddy
增加该泛域名 site(DNS-01 泛证书)反代到 server 同端口、`COFLUX_PROXY_HOST=p.coflux.dev`。
proxy cookie 与 code 表都是单实例内存态,未来多实例部署时需外置(与
pendingAuthorizations 同批)。`__coflux` 路径前缀是对被代理应用的保留字约定。
