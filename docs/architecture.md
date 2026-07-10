# coflux 架构设计

> 状态：V1 已实现并通过端到端测试 —— workspace/task 生命周期、PTY 双向流、
> daemon 侧 scrollback 回放、**服务器重启后经 daemon.resync 恢复运行中会话**。
> 决策记录与待定问题见 [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)。

## 1. 这是什么

一个"类 codex"但形态不同的产品：核心不是单个桌面客户端，而是能跑在用户**任意节点**上的 **Daemon**。Daemon 在本地起伪终端（PTY）、驱动本地 Agent（Claude Code / Codex CLI 等），并主动外连一个**中心服务器**；用户用 **Client** 连接中心服务器，即可触达任意节点上的 Daemon。一台机器可同时是 Daemon 和 Client。

## 2. 顶层架构

```
   Client (Web/桌面/CLI)            Client
        │                            │
        └──────────┐      ┌──────────┘
                   ▼      ▼
            ┌──────────────────┐
            │   中心服务器       │   公网可达；鉴权 + 路由/中继 + 编排 + 持久化
            │  (Server / Hub)   │
            └──────────────────┘
              ▲       ▲       ▲
   ┌──────────┘       │       └──────────┐
   │ (daemon 主动外连，长连接)            │
┌──────┐          ┌──────┐           ┌──────┐
│Daemon│          │Daemon│           │Daemon│   跑在用户开发机，可在 NAT 后
└──────┘          └──────┘           └──────┘
   │  起 PTY（Rust supervisor，portable-pty），持有进程 + scrollback
   └─ 工作目录 = 用户机器上已存在的目录
```

**为什么 Daemon 主动外连**：Daemon 多在 NAT/防火墙后，无法被入站连接。由它对服务器保持长连接，服务器即可把它当作可路由节点；Client → Server → Daemon 全程经服务器中继。

## 3. 关键设计决策（已敲定并实现）

| # | 决策 | 取舍 |
|---|------|------|
| 1 | **PTY 驱动**，非结构化字节流 | 通用、能驱动任意 CLI；结构化事件推迟到 V2 |
| 2 | **人驱动**，无服务器自动驱动 | 终端流直通给人；服务器不解析屏幕、不自动决策 |
| 3 | **服务器是"重"的编排者** | 起任务、工作区管理、路由、持久化、鉴权都在服务器 |
| 4 | **Daemon 持有 PTY 生命周期 + scrollback** | 服务器或网络断开都不影响 PTY；断线续连的根基 |
| 5 | **工作区在用户自己的开发机** | 直接指向已存在目录，不 clone、不隔离 |

### 关键不变量
- **Session（PTY 进程 + scrollback）由 Daemon 拥有**；服务器只持有 `sessionId → {daemonId, taskId, 订阅者}` 的路由表（运行时、不落盘）。
- 服务器掉电/重启后，靠 daemon 重连时的 `daemon.resync` 把存活会话重新挂回 task —— task 记录在 Postgres 里持久化。
- "工作区管理在服务器"= 服务器持有**元数据**并**下发指令**；真正的目录/文件系统/Agent 进程都在 Daemon 上。

## 4. 控制面 / 数据面

```
控制面 (Control Plane)  —— 低频、结构化 (JSON)
  workspace / task / session 的生命周期与状态

数据面 (Data Plane)     —— 高频、低延迟
  PTY 字节流：pty.input / pty.output / pty.replay，按 sessionId 多路复用
```

两者复用同一条 WebSocket：控制面走 JSON 文本帧，**数据面（`pty.output`/`pty.input`/`pty.replay`/`proxy.data`）走二进制帧**（长度前缀帧体，见 §6），按 WS 的 `isBinary` 分流。`proxy.data`（kind=4）是端口转发反代的隧道字节流，见 §7.3。

## 5. 数据模型

```
Account      隔离单元（单用户单账号，留多账号位）
  ├─ Device(=Daemon, 一机一个)   外连节点（持久化身份 + 凭证；运行时有 online 状态）
  │    └─ Workspace   工作目录（服务器持久化：id, accountId, daemonId, name, path）
  │         └─ Task    编排单位（持久化：accountId, status, sessionId, exitCode …）
  │              └─ Session   PTY 运行时实例（活在 daemon；scrollback 也在 daemon）
  ├─ EnrollmentKey  账号级登记密钥（存 hash）
  └─ ClientToken    账号级登录令牌（存 hash）
```

- **Account / Device / Workspace / Task / 密钥** 落 Postgres（`store.ts`，`postgres`/porsager 客户端，独立 `coflux` schema，列名 snake_case 与应用层 camelCase 自动互转）；token 只存 sha256 hash。
- **Session** 是运行时实体，不落盘；靠重连 resync 恢复。
- Device 的 `daemonId` 由服务器签发并绑定到设备凭证（不可冒充）；认证模型见 [auth-design.md](auth-design.md)。
- Task 状态机：`idle`（建好未启动）→ `running`（有存活 session）→ `exited`（session 退出）。对 `exited` 的 task 再 `task.start` 即重跑。
- 所有 client 可见/可达范围按 `accountId` 过滤。

## 6. 线协议（`packages/protocol`）

控制面消息 JSON 编码、用 `type` 区分；**数据面（`pty.output`/`pty.input`/`pty.replay`）走二进制帧**（`encodeFrame`/`decodeFrame`），按 `sessionId` 多路复用。下方控制面消息清单不含数据面三条。

**Daemon → Server**（控制面）
`daemon.enroll {enrollmentKey,name,host,platform}` · `daemon.auth {deviceToken}` · `daemon.enrollRequest` · `daemon.resync {sessions:[{sessionId,taskId}]}` · `project.validated` · `worktree.added` · `session.started` · `session.exit` · `ports.update {sessions:[{sessionId,ports}]}` · `proxy.opened {connId,ok,error?}` · `proxy.closed {connId}`

**Server → Daemon**（控制面）
`daemon.enrolled {daemonId,deviceToken}` · `daemon.authed {daemonId}` · `daemon.authError {needEnroll}` · `daemon.authorizePending {url,expiresAt}` · `project.validate {requestId,path}` · `worktree.add` · `worktree.remove` · `worker.upgrade` · `session.create` · `session.close` · `session.replay {requestId}` · `pty.resize` · `proxy.open {connId,port}` · `proxy.close {connId}`

**Client → Server**（控制面）
`client.auth {username,password}` / `{clientToken}` / `{supabaseToken}` · `client.subscribe` · `client.removeDevice` · `device.authorizeInfo` · `device.authorize` · `proxy.issueAuth {redirect}` · `project.import` · `project.remove` · `workspace.create` · `workspace.remove` · `task.create` · `task.start` · `task.attach` · `task.stop` · `task.remove` · `pty.resize`

**Server → Client**（控制面）
`auth.ok {accountId}` · `auth.error` · `state.snapshot {daemons,projects,workspaces,tasks,ports}` · `daemon.updated` · `daemon.removed` · `project.created` · `project.removed` · `workspace.created` · `workspace.removed` · `task.updated` · `task.removed` · `task.detached` · `proxy.auth {ok,url?,error?}` · `ports.updated {taskId,ports:[{port,url}]}` · `error`

**数据面（二进制帧，多路复用按 `id` 字段）**：`pty.output`（daemon→server→client）· `pty.input`（client→server→daemon）· `pty.replay`（daemon→server，scrollback；server 转成 `pty.output` 帧发给 client）· `proxy.data`（server↔daemon，端口转发隧道的原始字节，见 §7.3）。帧体 `[kind:1][idLen:1][id][?ridLen][?requestId][payload]`：`id` 对 `pty.*` 是 sessionId、对 `proxy.data` 是 connId（服务器签发的隧道连接 id）。`pty.*` 的 payload 是终端文本（UTF-8）；`proxy.data` 的 payload 是任意 TCP 字节（可能非合法 UTF-8），按 `Uint8Array` 原样透传，不经 TextEncoder/TextDecoder 往返。kind 编号：1=Output 2=Input 3=Replay 4=ProxyData。server 中继时只校验归属、原样转发字节。

## 7. 两个核心流程

### 7.1 attach 回放（历史在前，实时在后）
```
client ──task.attach(taskId)──▶ server
server ──session.replay(requestId)──▶ daemon         （此时不订阅该 client）
daemon ──pty.replay(requestId, scrollback)──▶ server
server ──pty.output(scrollback)──▶ client            （先投历史）
server: 把 client 加入 session.subscribers            （再订阅实时）
```
正确性依赖**单条 daemon→server WS 的有序投递**：daemon 先发 `pty.replay`、其后才发新的 `pty.output`，服务器按序处理，故该 client 拿到的是"完整历史 + 之后全部实时"，无丢失、无重复。

### 7.2 断线续连 / 重启恢复
```
（网络掉线，daemon 进程与 PTY 仍存活）
daemon 重连 ──register + resync([{sessionId,taskId}])──▶ server
server.reconcileDaemonSessions:
  - 报告存活的 session：重建路由（服务器重启过则按 daemon 信息重建），task 标 running
  - DB 里标 running 但 daemon 已不持有的：标 exited(-1)，清运行时 session
```
已通过 e2e：杀掉并重启服务器（同一 DB），daemon 重连后 task 仍 `running`，新 client attach 仍能回放历史。

### 7.3 端口转发反代（预览链接门禁 + 隧道透传）

```
daemon 每 2s 探测 PTY 会话进程树内所有 LISTEN 端口（仅该会话子进程树，见 §10 安全边界）
  ──ports.update{sessions:[{sessionId,ports}]}──▶ server
server 按 (session,port) 收敛路由表：新端口签发可读的确定性 shortId（`<设备名>-<端口>`），消失的端口摘除路由
  ──ports.updated{taskId,ports:[{port,url}]}──▶ client   （url 形如 http(s)://<shortId>.<proxyHost>）

浏览器访问 <shortId>.<proxyHost>（按 Host 头路由，与 client/daemon 的 WS 共用同一端口/监听器）：
  无门禁 cookie ──302──▶ web /proxy-auth?to=<原始完整 URL>
  web（已登录）──WS proxy.issueAuth{redirect}──▶ server：校验 redirect 的 host 命中某个属于
       本账号的 shortId，签发一次性 code（默认 60s TTL）──proxy.auth{ok,url}──▶ web
       （url = http(s)://<shortId>.<proxyHost>/__cf_proxy_auth?code=…&to=…）
  浏览器跳转 url ──▶ server 一次性消费 code、签发长效 cookie（cf_proxy_session，Domain=.<proxyHost>，
       默认 7 天，覆盖账号下所有预览子域名）──302──▶ 回原路径
  带有效 cookie 的请求/Upgrade ──▶ 接管整条 TCP 连接（hijack 底层 socket），经
       proxy.open/proxy.data(kind=4)/proxy.close 与 daemon 之间的隧道原始字节双向透传到
       daemon 本地端口，不逐请求重新解析报文
```

- **隧道 = socket 对拼**：server 把浏览器侧 TCP socket 与 daemon 侧到本地端口的 TCP 连接首尾相连，`connId`（server 签发）标识一条隧道；数据面靠 `proxy.data` 帧双向搬运原始字节，控制面靠 `proxy.open`/`proxy.opened`/`proxy.close`/`proxy.closed` 管生命周期。
- **HTTP 首请求强制 `Connection: close`**：接管 socket 后 keep-alive 的后续请求是原始字节透传、Host 已无法再重写，多数开发服务器的 Host 白名单会拒掉第二个请求；代价是每个 HTTP 请求单独一条隧道、响应完 dev server 主动关连接，浏览器下一个请求重新建连（重新走门禁 + Host 重写）。单请求内的流式响应（SSE/大文件）不受影响。WS Upgrade 不在此列——升级后的连接原样透传所有后续帧，含 Connection 头本身。
- **门禁边界**：一次性 code 命中即失效（无论是否已过期），不可重放；长效 cookie 按账号级隔离（`route.accountId !== session.accountId` 一律当无 cookie 处理，重新走 302，不放行）；`proxy.issueAuth` 的 `redirect` 只接受 `<shortId>.<proxyHost>` 形态的 host，拒绝任意外部地址（防开放重定向，两道防线：issueAuth 入参校验 + 回调 `to` 的同源相对路径校验）。
- **shortId 可读且确定**：`<设备名（DNS 安全化）>-<端口>`（如 `wsq-mbp-5173`），同一 (设备,端口) 的预览 URL 跨 server 重启 / daemon 重连稳定，可收藏；极端冲突（不同设备安全化后同名同端口、SO_REUSEPORT 共享端口）追加 daemonId/sessionId 前缀消歧。可读性没有安全代价——真正的权限边界是账号级门禁 cookie，URL 可猜也进不来。客户端仍应以最新一次 `ports.updated` 为准。

## 8. 仓库结构

```
coflux/
├── packages/                  # TS 共享（server/web 用）
│   ├── protocol/              # 共享线协议类型 + 运行时校验（server/web 引用，免构建消费 TS 源）
│   └── core/                  # 共享基建：结构化分级日志
├── apps/                      # TS：server + web（daemon 已全 Rust 化，见 crates/）
│   ├── server/src/
│   │   ├── config.ts          # 集中配置（env + 默认值）
│   │   ├── store.ts           # Postgres 持久化（porsager/postgres，独立 schema，事务）
│   │   ├── secrets.ts         # token 生成/哈希
│   │   ├── pending.ts         # 通用请求-响应关联登记表（超时/掉线清理）
│   │   ├── transport.ts       # WS 接入样板：解码/校验/派发 + 心跳 + 认证截止
│   │   ├── hub.ts             # 领域编排/路由：账号/设备/项目/工作区/任务/会话
│   │   └── index.ts           # 装配：config→store→hub→transport→心跳→信号
│   └── web/src/App.tsx        # 状态驱动 UI：project→workspace→task→终端
├── crates/                    # Rust：daemon（supervisor + worker 两进程，零 node 运行时）
│   ├── protocol/              # 线协议 Rust 真相源：serde 类型 + 帧 codec + UDS 消息（含单测）
│   ├── supervisor/            # 持 PTY(portable-pty) + scrollback + 背压；UDS server；起/管/重启 worker + 版本切换/回滚
│   └── worker/                # async(tokio)：连服务器(WS)/认证/重连 + git + exec + fs + 两级 resync（PTY 操作经 UDS 转 supervisor）
├── tests/src/                 # 黑盒集成测试（跨语言重构有效）：harness + *.test.mjs（默认拉起 Rust daemon）
└── docs/{architecture,auth-design,OPEN_QUESTIONS,hot-upgrade-design}.md
```

## 9. 已实现 vs 待办

**已实现**：workspace/task 建模 + Postgres 持久化 · PTY 双向流 · daemon 侧 scrollback + 定向回放 · 断线续连 + 服务器重启恢复 · 状态快照 + 增量推送 UI · 端口转发反代（探测 + 登录门禁 + 隧道透传，见 §7.3）。

**已加固**（两轮对抗式审查，共 25 项确认问题全修）：
- 第一轮（14 项，编排健壮性）：同 daemonId 重连按 ws 身份去重 · 重启后绝不重复起 PTY · stop/start 竞态用 `closing` 标志隔离 · session.exit 仅在 task 仍指向该 session 时改状态 · pending 请求带超时 + daemon 掉线清理 · resync 时清理孤儿 PTY · daemon 上行消息须先注册且按 session 归属校验 · client 只能操作自己订阅的 session。
- 第二轮（11 项，认证/账号隔离/重写回归）：daemon 上行消息（resync / session.exit / session.started）按 **task.daemonId === conn.daemonId** 归属校验，杜绝跨账号劫持/伪造退出 · 协议层运行时校验 wire 数据 + ingress try/catch + 尺寸钳制（防畸形输入崩溃）· 连接认证截止时间 + maxPayload + 每账号设备上限（防登记 DoS）· Web 重连无限重试 + 重连后自动重 attach。

**待办（详见 OPEN_QUESTIONS）**：真鉴权与多租户(B1) · 工作区信任边界/隔离(B2) · daemon 离线策略(B3) · task↔terminal 基数(B4) · Agent 集成(B5) · 二进制数据面(B6) · 服务器部署形态(B7)。

## 10. 安全与信任边界

信任模型：**单用户 + 自有机器**（OPEN_QUESTIONS B1/B2 已定）。已实现 Tailscale 式认证：
- 账号为隔离单元；daemon 用登记密钥换取**每设备凭证**，daemonId 服务器签发绑定，**无法冒充他机**。
- client 用登录令牌认证；快照/广播/路由/各项操作全部按 `accountId` 过滤，跨账号隔离。
- token 只存 sha256 hash；daemon 凭证落本地 `chmod 600`。
- 工作区路径仅校验"是目录"（自有机器无需沙箱）。
- 端口探测严格限定在 PTY 会话的进程树内：daemon 只上报该会话子进程（含子孙）持有的 LISTEN 端口
  （遍历进程树用 macOS libproc / Linux `/proc`，见 `crates/worker/src/ports.rs`），机器上其它进程
  监听的端口不会被发现、更不会被上报或代理——已有 Rust 单测覆盖 + 黑盒 e2e 覆盖（`tests/src/proxy.test.mjs`）。

待加固（部署层）：全程 TLS(`wss://`)、生产用强随机登记密钥/登录令牌（env 覆盖）。详见 [auth-design.md](auth-design.md)。

## 11. 演进路线

- **V1（已完成）**：人驱动的远程终端 + 编排（workspace/task）+ 断线续连。
- **V1.x**：真鉴权与多租户、daemon 离线策略、（可选）多终端/工作区。
- **V2**：结构化 Agent 适配（headless 模式）做富 UI；可选工作区隔离（git worktree / 容器）。

> "服务器自动驱动 Agent"目前**明确不在范围内**；若未来要做需引入无头终端模拟器还原屏幕状态，是 PTY 路线里最重的一块，届时单独评估。
