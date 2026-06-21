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
