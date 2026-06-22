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
- 服务器掉电/重启后，靠 daemon 重连时的 `daemon.resync` 把存活会话重新挂回 task —— task 记录在 sqlite 里持久化。
- "工作区管理在服务器"= 服务器持有**元数据**并**下发指令**；真正的目录/文件系统/Agent 进程都在 Daemon 上。

## 4. 控制面 / 数据面

```
控制面 (Control Plane)  —— 低频、结构化 (JSON)
  workspace / task / session 的生命周期与状态

数据面 (Data Plane)     —— 高频、低延迟
  PTY 字节流：pty.input / pty.output / pty.replay，按 sessionId 多路复用
```

两者复用同一条 WebSocket：控制面走 JSON 文本帧，**数据面（`pty.output`/`pty.input`/`pty.replay`）走二进制帧**（长度前缀帧体，见 §6），按 WS 的 `isBinary` 分流。

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

- **Account / Device / Workspace / Task / 密钥** 落 sqlite（`store.ts`，`node:sqlite`，零原生依赖）；token 只存 sha256 hash。
- **Session** 是运行时实体，不落盘；靠重连 resync 恢复。
- Device 的 `daemonId` 由服务器签发并绑定到设备凭证（不可冒充）；认证模型见 [auth-design.md](auth-design.md)。
- Task 状态机：`idle`（建好未启动）→ `running`（有存活 session）→ `exited`（session 退出）。对 `exited` 的 task 再 `task.start` 即重跑。
- 所有 client 可见/可达范围按 `accountId` 过滤。

## 6. 线协议（`packages/protocol`）

控制面消息 JSON 编码、用 `type` 区分；**数据面（`pty.output`/`pty.input`/`pty.replay`）走二进制帧**（`encodeFrame`/`decodeFrame`），按 `sessionId` 多路复用。下方控制面消息清单不含数据面三条。

**Daemon → Server**（控制面）
`daemon.enroll {enrollmentKey,name,host,platform}` · `daemon.auth {deviceToken}` · `daemon.resync {sessions:[{sessionId,taskId}]}` · `workspace.validated` · `session.started` · `session.exit`

**Server → Daemon**（控制面）
`daemon.enrolled {daemonId,deviceToken}` · `daemon.authed {daemonId}` · `daemon.authError {needEnroll}` · `workspace.validate {requestId,path}` · `session.create` · `session.close` · `session.replay {requestId}` · `pty.resize`

**Client → Server**（控制面）
`client.auth {clientToken}` · `client.subscribe` · `client.removeDevice` · `workspace.create` · `workspace.remove` · `task.create` · `task.start` · `task.attach` · `task.stop` · `task.remove` · `pty.resize`

**Server → Client**（控制面）
`auth.ok {accountId}` · `auth.error` · `state.snapshot {daemons,workspaces,tasks}` · `daemon.updated` · `daemon.removed` · `workspace.created` · `workspace.removed` · `task.updated` · `task.removed` · `error`

**数据面（二进制帧，多路复用按 `sessionId`）**：`pty.output`（daemon→server→client）· `pty.input`（client→server→daemon）· `pty.replay`（daemon→server，scrollback；server 转成 `pty.output` 帧发给 client）。帧体 `[kind][sidLen][sessionId][?ridLen][?requestId][payload]`，payload 为原始终端字节（UTF-8），不再经 JSON 转义。server 中继时只校验归属、原样转发字节。

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

## 8. 仓库结构

```
coflux/
├── packages/                  # TS 共享（server/web 用）
│   ├── protocol/              # 共享线协议类型 + 运行时校验（server/web 引用，免构建消费 TS 源）
│   └── core/                  # 共享基建：结构化分级日志
├── apps/                      # TS：server + web（daemon 已全 Rust 化，见 crates/）
│   ├── server/src/
│   │   ├── config.ts          # 集中配置（env + 默认值）
│   │   ├── store.ts           # sqlite 持久化（预编译缓存 + 事务 + WAL + close）
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

**已实现**：workspace/task 建模 + sqlite 持久化 · PTY 双向流 · daemon 侧 scrollback + 定向回放 · 断线续连 + 服务器重启恢复 · 状态快照 + 增量推送 UI。

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

待加固（部署层）：全程 TLS(`wss://`)、生产用强随机登记密钥/登录令牌（env 覆盖）。详见 [auth-design.md](auth-design.md)。

## 11. 演进路线

- **V1（已完成）**：人驱动的远程终端 + 编排（workspace/task）+ 断线续连。
- **V1.x**：真鉴权与多租户、daemon 离线策略、（可选）多终端/工作区。
- **V2**：结构化 Agent 适配（headless 模式）做富 UI；可选工作区隔离（git worktree / 容器）。

> "服务器自动驱动 Agent"目前**明确不在范围内**；若未来要做需引入无头终端模拟器还原屏幕状态，是 PTY 路线里最重的一块，届时单独评估。
