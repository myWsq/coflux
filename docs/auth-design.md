# coflux 认证与设备登记设计（Tailscale 式）

当前模型是「用户登录账号 → 浏览器授权新设备 → 每设备独立凭证」。早期共享 client token、
EnrollmentKey 与 Supabase 换票均已退役；历史决策仍保存在对应 plans，不属于运行时契约。

## 实体

| 实体 | 说明 | 持久化 |
|------|------|--------|
| **User** | `password` 模式的邮箱身份；密码只存 scrypt 哈希 | Postgres `users` |
| **Account** | 授权与数据隔离单元；`local` 模式固定为 `default`，`password` 模式通过 membership 归属个人账号 | Postgres |
| **Device**（= daemon，一机一个） | `{ id, accountId, name, host, platform, tokenHash, createdAt, lastSeenAt, revoked }`；`id` 由服务器签发 | Postgres |
| **deviceToken** | 每设备独立凭证，浏览器授权成功时签发，daemon 后续连接使用 | server 存 sha256 hash；daemon 本地明文 |
| **client session token** | 用户名/密码登录成功后由 server 签发；有期限、可撤销，用于 WS 重连 | Postgres `client_tokens` 只存 sha256 hash；浏览器存明文 |

## 凭证存放

- **服务器**：账号、用户、membership、设备与 token hash 全部落 Postgres；不持久化 token 明文。
- **Daemon**：`COFLUX_HOME/credentials.json` 保存 `{ serverUrl, daemonId, deviceToken }`，权限 `0600`。
- **Web Client**：只把 server 签发的 client session token 存入 `localStorage`；用户不手工配置 token。

## Client 登录

`COFLUX_AUTH` 只接受两个模式：

- `local`（默认）：校验 `COFLUX_USERNAME` / `COFLUX_PASSWORD`，登录固定 `default` account。
- `password`：把 `username` 字段按邮箱归一化，在 `users` 表查 scrypt 密码哈希，再通过唯一 membership
  找到或首次创建个人 account。

两条首次登录路径都会签发 `ck_sess_*` 会话 token；重连只提交该 token，不再重复做密码校验。登出会
在服务器撤销当前 token，过期 token 也不能重新认证。开发模式 `COFLUX_DEV=1` 下 `local` 弱默认是
`admin` / `admin`；生产缺少 `COFLUX_PASSWORD` 会 fail closed。

## Daemon 后续连接

```
daemon ──daemon.auth{ deviceToken }──▶ server
server: 按 tokenHash 查未撤销 Device → 从记录绑定 daemonId/accountId
        ──daemon.authed{ daemonId }──▶ daemon
```

认证失败时 daemon 会收到 `daemon.authError`；设备已删除则清本地凭证并重新走浏览器授权。关键安全性质
是 daemonId 不接受客户端自报，持有一台设备的 token 不能冒充另一台设备。

## 授权与撤销

- 同一 account 下的 client 可达该账号全部 device；跨 account 的快照、控制、rendezvous、checkpoint、
  proxy 与广播均做 account/daemon 归属校验。
- `client.removeDevice{ daemonId }` 会持久撤销设备、断开连接并清理其 workspace/task 等业务数据。
- 一机一 daemon 由本地凭证持久化自然保证；同机重装会登记为新设备，旧设备可在 UI 删除。

## 设备授权流（Tailscale 式，plan 003；plan 034 起是唯一登记路径）

`cofluxd up` 零参数时，daemon 以匿名身份连上后现场申请一次性授权，由已登录账号的
用户在浏览器里确认。走 `store.createDevice(...)`，落到 `devices` 表，产物
（daemonId/deviceToken）与后续认证方式完全一致——对服务器和 daemon 而言无法区分
设备是怎么登记进来的。

### 状态只在内存里，连接是唯一的真相来源
待授权请求不落库、只存在 hub 进程的内存 map（`daemonId` 尚不存在，谈不上持久化
到哪张表）。这依赖 coflux 是单实例部署（见 `docs/OPEN_QUESTIONS.md` B7）；多实例
部署要把这段状态挪到共享存储，目前不是目标形态。日常语义上更关键的性质是：
待授权状态与「那条尚未认证的 daemon WS 连接」强绑定——连接一断，状态立即作废，
不需要额外的超时兜底逻辑来处理"daemon 消失了但授权还挂着"的悬空情况。

### 流程
```
daemon（本地无凭证）
  ──daemon.enrollRequest{ name, host, platform }──▶ server
server: 生成一次性 token（cf_authz_ 前缀，≥128bit 熵）、记入内存 pending map（含来源连接引用）
  ──daemon.authorizePending{ url, expiresAt }──▶ daemon（同一条已打开的连接，不需要重连）
daemon: 把 url 落盘 ~/.coflux/pending-auth.json；cofluxd 轮询该文件，打印链接引导用户打开

用户在浏览器打开 <webUrl>/authorize/<token>（未登录则先登录，走既有 client.auth）
client ──device.authorizeInfo{ token }──▶ server   （核对 token 有效性，回显待授权设备 name/host/platform）
client ──device.authorize{ token }──▶ server
server: 校验一次性 + TTL（默认 10min，COFLUX_AUTHORIZE_TTL_MS 可调）→ 从内存 map 摘除该 token（一次性）
        → 按发起授权的账号建 Device（store.createDevice 调用）
        ──daemon.enrolled{ daemonId, deviceToken }──▶ daemon（原 pending 连接上直接推，无需重连）
        ──device.authorized──▶ client
daemon: 清 pending-auth.json、落盘 credentials.json
```

### 失效条件（均有黑盒断言，见 `tests/src/authorize.test.mjs`）
- **一次性**：`device.authorize` 成功后立即从 pending map 摘除，同一 token 二次使用返回
  `device.authorizeInfo{ ok:false }`。
- **TTL**：默认 10 分钟（`COFLUX_AUTHORIZE_TTL_MS`），到期由 `setTimeout` 主动清理，过期后按
  "不存在"处理，不区分"过期"与"从未存在"（避免给攻击者额外信息）。server 到期只默默摘除，
  不通知也不断连；**换新链接由 worker 负责**——它跟踪 `expiresAt`，到期仍未登记就在同一条
  连接上重发 `daemon.enrollRequest`，收到新的 `daemon.authorizePending` 后覆盖写
  pending-auth.json，`cofluxd` 的轮询会自然打印新链接。只要 daemon 活着，用户手里的链接
  永远是新鲜的（旧链接一过期即失效）。
- **断线作废**：daemon 连接的 `close` 事件里连带清掉其挂着的 pending token，与「一机一次授权
  请求」的直觉一致——重新连接会生成一个新 token。
- **限速**：`device.authorizeInfo`/`device.authorize` 在同一 client 连接上失败次数计数
  （`COFLUX_AUTHORIZE_MAX_FAILURES`，默认 10），超过后统一回"尝试次数过多"，不再泄漏
  token 是否存在。因 token 本身是 128bit 随机值、爆破不可行，限速是纵深防御而非主防线。

### Web 侧
`/authorize/<token>` 是 `apps/web/src/App.tsx` 里的独立组件（`AuthorizePage`），
不经路由库、在 `App()` 顶层按 `location.pathname` 分支决定渲染哪棵组件树——避免
主 app 的 xterm 初始化/自动重连副作用在授权页上跑起来。复用已有登录态
（`localStorage` 会话 token）与登录表单，未登录则退回同一套登录 UI。

## OAuth 客户端（MCP，plan 090）

面向**任何机器上的 Claude Code / Codex**：中心托管远程 MCP（`<publicUrl>/mcp`，Streamable HTTP），宿主
一行接入（`claude mcp add --transport http coflux https://api.coflux.dev/mcp`），凭证由标准 OAuth 2.1
授权码流程签发，用户只在浏览器确认一次、不手工粘贴任何令牌。中心同时是资源服务器与授权服务器。

| 实体 | 说明 | 持久化 |
|------|------|--------|
| **OAuth client** | 宿主经 RFC 7591 动态注册（DCR）得到的公共客户端（`cf_oc_*`，`token_endpoint_auth_method=none`），带注册的 redirect_uris | Postgres `oauth_clients` |
| **access token** | `cf_oat_*`，短期（`COFLUX_OAUTH_ACCESS_TTL_MS`，默认 1h），`/mcp` 的 bearer | `oauth_tokens` 只存 sha256 hash |
| **refresh token** | `cf_ort_*`，长期（`COFLUX_OAUTH_REFRESH_TTL_MS`，默认同会话 token 30 天），用过即作废（轮换） | 同上 |
| **待确认请求 / 授权码** | `cf_oreq_*` / `cf_oac_*`，只在 hub 进程内存（TTL、一次性、上限同 `COFLUX_MAX_PENDING_AUTHORIZATIONS`） | 不落库（同设备授权，见上文「状态只在内存里」） |

凭证与 web 会话彻底分开：`client_tokens` 与浏览器登录/登出绑定，OAuth token 独立签发、独立存储、
独立过期；MCP transport 无状态，每个请求凭 bearer 独立认身份。

### 流程
```
宿主 ──POST /mcp（无 token）──▶ 401 + WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp"
宿主 ──GET  PRM──▶ { resource: <publicUrl>/mcp, authorization_servers: [<publicUrl>] }
宿主 ──GET  /.well-known/oauth-authorization-server──▶ 端点清单、code_challenge_methods_supported=[S256]、registration_endpoint
宿主 ──POST /oauth/register（DCR）──▶ client_id
宿主 ──GET  /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&state──▶ 302 <webUrl>/oauth/consent?request=<id>
浏览器：确认页独立 WS clientAuth（未登录先登录）→ oauth.authorizeInfo{ requestId }（回显客户端名/回调 host）
        → 用户允许/拒绝 → oauth.authorizeDecide{ requestId, approve }
server: 摘除待确认请求（一次性）→ 允许则签授权码并回完整回调 URL（code + 原 state + iss）；拒绝则回调带 error=access_denied
浏览器 location.assign 跳回宿主的回调地址
宿主 ──POST /oauth/token（authorization_code + code_verifier）──▶ access + refresh
宿主 ──POST /mcp（Bearer）──▶ tools；到期后 ──POST /oauth/token（refresh_token）──▶ 新 access + 新 refresh，旧 refresh 立即失效
```

### 校验与失效（黑盒断言见 `tests/src/mcp-oauth.test.mjs`、`mcp-isolation.test.mjs`）
- **redirect_uri**：loopback（`http://localhost` / `127.0.0.1` / `[::1]`）允许任意端口与路径（RFC 8252，
  Claude Code 每次随机端口回调）；非 loopback 必须与注册值精确相等。client_id / redirect_uri 不合法时
  直接 400，绝不往未经校验的地址跳；其余参数错误按规范带 `error` 跳回宿主。
- **PKCE S256 必填**：verifier 不符 → `invalid_grant`。
- **授权码一次性**：二次使用 → `invalid_grant`，且首次兑现签出的整链 token 作废。
- **refresh 轮换**：原子条件更新（只有仍未撤销的 refresh 会被本次轮换掉）；刚被轮换掉的 refresh 在
  `COFLUX_OAUTH_REFRESH_REUSE_GRACE_MS`（默认 60s）内再次出现按同机多宿主并发轮换处理——同一 grant 下再签一对、
  不撤链；超过宽限再出现视为泄露信号，整链撤销；`client_id` 不匹配也拒。
- **隔离**：所有 tools 只按 bearer 解析出的 `accountId` 读取；带 id 的入参不属于当前账号与不存在回同一句错误。
- URL 全部由 `COFLUX_PUBLIC_URL` 拼，不从请求 `Host` / `X-Forwarded-*` 推导（生产前面压着两层反代）。
- 未做（后续）：已授权应用列表 / 单个撤销 UI、CIMD 注册、token 内省/撤销端点。

