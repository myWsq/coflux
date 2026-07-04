# coflux 认证与设备登记设计（Tailscale 式）

> 决策来源：单用户管自有多机、一机一 daemon、登录一个账号。详见 OPEN_QUESTIONS B1。

## 实体

| 实体 | 说明 | 持久化 |
|------|------|--------|
| **Account** | 隔离单元。MVP 单账号（`default`），模型留多账号位 | server sqlite |
| **EnrollmentKey** | 登记密钥，账号级、可复用（≈ Tailscale auth key）。让新机器登记进账号 | server，存 **hash** |
| **Device**（= daemon，一机一个） | `{ id, accountId, name, host, platform, tokenHash, createdAt, lastSeenAt, revoked }`。`id` 服务器签发 | server |
| **deviceToken** | 每设备独立凭证，登记时签发，daemon 后续连接用它认证 | server 存 hash；daemon 本地明文 |
| **ClientToken** | 账号级登录凭证，client 用它登录账号 | server，存 **hash** |

服务器只存 token 的 **sha256 hash**，从不持久化明文。

## 凭证存放
- **服务器**：accounts / devices / enrollment_keys / client_tokens 落 sqlite。
- **Daemon**：`~/.coflux/credentials.json` = `{ serverUrl, daemonId, deviceToken }`，`chmod 600`。
- **Web Client**：登录成功后把 client token 存 `localStorage`。

## 流程

### Daemon 首次登记（本地无凭证）
```
daemon ──daemon.enroll{ enrollmentKey, name, host, platform }──▶ server
server: 校验 key（存在/未撤销）→ 建 Device（服务器签发 daemonId）
        → 签发随机 deviceToken，存 tokenHash → 绑定连接身份 = daemonId/accountId
        ──daemon.enrolled{ daemonId, deviceToken }──▶ daemon
daemon: 落盘 credentials.json
```

### Daemon 后续连接
```
daemon ──daemon.auth{ deviceToken }──▶ server
server: 按 tokenHash 查 Device（未撤销）→ 绑定连接身份 = daemonId/accountId
        ──daemon.authed{ daemonId }──▶ daemon
（认证失败 → daemon.authError；若设备被删，daemon 清本地凭证并用 enrollmentKey 重新登记）
```
→ **关键安全性质**：daemonId 由服务器按设备凭证绑定，客户端无法自报/冒充他机（修掉审查 #9）。
登记密钥只能"在账号里新建一台设备"，不能冒充已有设备。

### Client 登录
```
client ──client.auth{ clientToken }──▶ server
server: 校验 → 绑定连接 accountId → 可见/可达该账号下所有设备
        ──auth.ok{ accountId }──▶ client（失败 auth.error）
```

## 授权
- 同一 account 下所有 device 与 client 互相可达（单用户自有多机，无需细粒度 ACL）。
- 跨 account 隔离：snapshot / daemon 列表 / 广播 / PTY 路由全部按 `accountId` 过滤；
  client 操作某 session 前，校验 `session.accountId === client.accountId` **且** client 是该 session 订阅者。

## 撤销 / 一机一 daemon
- `client.removeDevice{ daemonId }`：标记设备 `revoked`、断开其连接、连带删除其 workspace/task、关闭 session。
- 一机一 daemon 由 daemon 端凭证持久化天然保证；同机重装会登记成新设备，旧的可在 UI 删除。

## 开发期默认值（零配置可跑）
- `COFLUX_ENROLL_KEY`（默认 `dev-enroll`）、`COFLUX_CLIENT_TOKEN`（默认 `dev-client`）。
- 服务器启动时确保 `default` 账号存在，并把这两个值的 hash 登记为该账号的登记密钥/客户端令牌。
- 生产环境改成随机强值即可（daemon/web 通过同名 env 配置）。

## 协议变更（相对前一版）
- `daemon.register{daemonId,token}` → `daemon.enroll{enrollmentKey,...}` + `daemon.auth{deviceToken}`；新增 `daemon.enrolled` / `daemon.authed` / `daemon.authError`。
- `client.hello{token}` → `client.auth{clientToken}`；`hello.ok` → `auth.ok{accountId}` / `auth.error`。
- `DaemonInfo` 增加 `name`；`Workspace`/`Task` 增加 `accountId`。
- 新增 `client.removeDevice`、`device.removed`。

## 设备授权流（Tailscale 式，plan 003）

`enrollmentKey` 流仍是唯一的登记密钥机制，未变。这一节加的是**默认路径**：
`cofluxd up` 零参数时不再要求先有登记密钥，而是让 daemon 以匿名身份连上后
现场申请一次性授权，由已登录账号的用户在浏览器里确认。两条路径最终都走同一个
`store.createDevice(...)`，落到同一张 `devices` 表，产物（daemonId/deviceToken）
与后续认证方式完全一致——对服务器和 daemon 而言无法区分设备是怎么登记进来的。

### 状态只在内存里，连接是唯一的真相来源
待授权请求不落库、只存在 hub 进程的内存 map（`daemonId` 尚不存在，谈不上持久化
到哪张表）。这依赖 coflux 是单实例部署（见 `docs/OPEN_QUESTIONS.md` B7）；多实例
部署要把这段状态挪到共享存储，目前不是目标形态。日常语义上更关键的性质是：
待授权状态与「那条尚未认证的 daemon WS 连接」强绑定——连接一断，状态立即作废，
不需要额外的超时兜底逻辑来处理"daemon 消失了但授权还挂着"的悬空情况。

### 流程
```
daemon（本地无凭证、enroll key 留空）
  ──daemon.enrollRequest{ name, host, platform }──▶ server
server: 生成一次性 token（cf_authz_ 前缀，≥128bit 熵）、记入内存 pending map（含来源连接引用）
  ──daemon.authorizePending{ url, expiresAt }──▶ daemon（同一条已打开的连接，不需要重连）
daemon: 把 url 落盘 ~/.coflux/pending-auth.json；cofluxd 轮询该文件，打印链接引导用户打开

用户在浏览器打开 <webUrl>/authorize/<token>（未登录则先登录，走既有 client.auth）
client ──device.authorizeInfo{ token }──▶ server   （核对 token 有效性，回显待授权设备 name/host/platform）
client ──device.authorize{ token }──▶ server
server: 校验一次性 + TTL（默认 10min，COFLUX_AUTHORIZE_TTL_MS 可调）→ 从内存 map 摘除该 token（一次性）
        → 按发起授权的账号建 Device（与 daemon.enroll 相同的 store.createDevice 调用）
        ──daemon.enrolled{ daemonId, deviceToken }──▶ daemon（原 pending 连接上直接推，无需重连）
        ──device.authorized──▶ client
daemon: 清 pending-auth.json、落盘 credentials.json（与 classic enroll 一致）
```

### 失效条件（均有黑盒断言，见 `tests/src/authorize.test.mjs`）
- **一次性**：`device.authorize` 成功后立即从 pending map 摘除，同一 token 二次使用返回
  `device.authorizeInfo{ ok:false }`。
- **TTL**：默认 10 分钟（`COFLUX_AUTHORIZE_TTL_MS`），到期由 `setTimeout` 主动清理，过期后按
  "不存在"处理，不区分"过期"与"从未存在"（避免给攻击者额外信息）。
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
