# coflux

可跑在用户任意节点上的 **Daemon**，在本地起 PTY、驱动 Claude Code / Codex CLI 等 Agent。
远端访问由中心完成 rendezvous，再经独立 opaque relay；同机优先 loopback，网络条件允许时可升到
P2P，terminal 与普通 Device RPC 数据帧不经过中心控制 WS。一机一 daemon，设备模型类似 Tailscale。

> 架构详见 [docs/architecture.md](docs/architecture.md)；认证见 [docs/auth-design.md](docs/auth-design.md)；路线图/TODO 见 [docs/ROADMAP.md](docs/ROADMAP.md)；待讨论项见 [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)；生产部署拓扑见 [docs/deployment.md](docs/deployment.md)。

## Monorepo 结构

| 包 | 说明 |
|----|------|
| `packages/core` | TS 共享基础设施（日志等），供 server/client 复用 |
| `packages/client` | Web/mobile 共享的 control client、store 与 DeviceRouter |
| `packages/protocol` | Buf 生成的 TS 共享线协议（真相源在 `proto/`） |
| `apps/server` | 中心服务器（TS）：认证/编排 + relay rendezvous + checkpoint + Postgres |
| `apps/web` | Web Client（TS）：Vite + React + xterm.js |
| `apps/mobile` | 冻结的移动 Web Client；仅在共享层破坏构建时做最小修复 |
| `apps/ios` | 原生 iOS Client（SwiftUI + SwiftTerm）；使用共享 Swift Client Core |
| `packages/swift-client` | Buf 生成的 Swift 协议、共享 Client Core 与 Apple 平台 transport |
| `crates/protocol` | Buf 生成的 Rust 协议 + UDS frame/IPC |
| `crates/relay` | 独立 opaque 数据面：短时单次 token 验证 + channel 配对，不连账号数据库 |
| `crates/supervisor` | PTY/sessiond authority：VT/history/holder/sequence + worker 管理（极少升级） |
| `crates/worker` | gateway、direct/relay、git/exec/fs、checkpoint 与中心连接（频繁升级） |
| `packages/cli` | `cofluxd`：用户侧管理 CLI（npm，零依赖 node）——装/起/停/升级 daemon + doctor 连通性自检 |

server/web 是 TypeScript（pnpm workspace）；**daemon 全 Rust**（Cargo workspace，零 node 运行时）。daemon
拆成 supervisor + worker：升级只换 worker，PTY 在 supervisor 里存活。supervisor/sessiond 的角色类似
tmux server——client 断开不影响进程，重新 attach 取当前 ANSI snapshot 与连续 output；但不承诺
supervisor/OS 重启后恢复活进程。详见 [架构与 tmux 边界](docs/architecture.md#3-为什么像-tmux又不等于-tmux)。

## 用户侧：安装 daemon

daemon 是预编译的 Rust 二进制，用 `cofluxd`（npm）装成系统服务（崩溃/开机自启）。默认连公共服务 `wss://api.coflux.dev/daemon`（自托管用 `--server` 改）。

```bash
npm i -g cofluxd
cofluxd                 # 首次=up（起服务后打印浏览器授权链接），之后=看状态
cofluxd up               # 幂等：零参数即可装/起；已装则按当前配置重装服务并重启
cofluxd status / doctor / logs -f / update / down / uninstall
```

登记走浏览器授权：`cofluxd up` 打印一次性授权链接，在已登录账号中确认即可。`cofluxd doctor`
分别检查中心 DNS/TCP/TLS/WS、gateway bind、持久 grant、loopback WS 与 daemon→中心状态；本地失败只
表示 direct 降级，不等于 daemon 离线。**所有配置都在 `~/.coflux/settings.json`**
（`serverUrl`/`deviceName`/`shell`），手改后重跑 `cofluxd up` 生效。发版/签名见
[docs/RELEASING.md](docs/RELEASING.md)。

## 快速开始

前置：Node 22+ + pnpm（server/web）、Rust stable（daemon）、Docker（本地 Postgres）。

```bash
pnpm install          # 安装 TS 依赖
pnpm dev:pg           # 独立 Postgres（127.0.0.1:5432，与 CI / 开发默认连接串一致）

# 分终端跑（dev = server + web；daemon 单独，因为它是 Rust 二进制）：
pnpm dev:server
pnpm dev:web          # Web，打开 http://localhost:5273；/client 代理到 :8787
pnpm dev:daemon       # 全 Rust daemon：cargo build 后起 supervisor（再 spawn worker）；走浏览器授权登记，凭证存 ~/.coflux
```

1. 打开网页；dev 默认用用户名/密码 `admin` / `admin` 登录（弱默认只在 `COFLUX_DEV=1` 生效）。
2. 从在线设备导入该机器上已有的 git 仓库，再按需创建 worktree 工作区。
3. 在工作区中新建终端，直接启动 `claude` / `codex`；同机优先显示 direct transport，失败自动 relay。

任务支持停止/删除。重新 attach 从 daemon 的 VT/history 生成 snapshot，不从中心回放 raw PTY。已加载且
已配对的页面在中心停止后仍可 list/attach/input/resize/stop；离线刷新/冷启动不在保证范围。

## 认证模型（Tailscale 式）

- **浏览器授权**：新机器 daemon 发起授权请求，用户在已登录的浏览器里确认 → 服务器签发 **每设备 deviceToken**，daemon 本地持久化。
- **设备凭证（deviceToken）**：后续连接用它认证；daemonId 由服务器签发绑定，无法冒充他机。
- **用户登录**：`local` 模式校验环境变量中的用户名/密码；`password` 模式校验 Postgres 中的邮箱与
  scrypt 密码哈希。两者成功后都由服务器签发有期限、可撤销的会话 token，浏览器自动保存并用于重连。
- 服务器只持久化 device token 与会话 token 的 sha256 hash，不保存明文。详见
  [docs/auth-design.md](docs/auth-design.md)。

## 环境变量

| 变量 | 默认 | 用于 |
|------|------|------|
| `COFLUX_PORT` | `8787` | server 监听端口 |
| `DATABASE_URL` | 生产必填；`COFLUX_DEV=1` 时弱默认 `postgres://postgres:postgres@127.0.0.1:5432/postgres` | server 的 Postgres 连接串（含密码，视为秘密） |
| `COFLUX_AUTH` | `local` | 登录模式：`local`（单账号环境变量口令）或 `password`（Postgres 用户表） |
| `COFLUX_USERNAME` | `admin` | `local` 模式用户名 |
| `COFLUX_PASSWORD` | dev 为 `admin`；生产必填 | `local` 模式密码 |
| `COFLUX_SESSION_TTL_MS` | `2592000000` | 登录后签发的会话 token 有效期（默认 30 天） |
| `COFLUX_PROXY_HOST` | `p.localhost` | 端口转发预览域：`<shortId>-<该值>` 按反代路由；生产需配好泛解析 + 泛证书 |
| `COFLUX_PUBLIC_URL` | `http://127.0.0.1:<COFLUX_PORT>` | 中心自身公网基址：OAuth issuer、PRM/AS 元数据与 `/mcp` 资源标识全由它拼（生产 `https://api.coflux.dev`），不从请求头推导 |
| `COFLUX_OAUTH_ACCESS_TTL_MS` | `3600000` | MCP 宿主 OAuth access token 有效期（默认 1 小时） |
| `COFLUX_OAUTH_REFRESH_TTL_MS` | 同 `COFLUX_SESSION_TTL_MS` | MCP 宿主 OAuth refresh token 有效期（用过即作废、轮换） |
| `COFLUX_OAUTH_REFRESH_REUSE_GRACE_MS` | `60000` | 刚被轮换掉的 refresh token 在此宽限内再次出现按同机并发轮换复用（同 grant 再签一对）；超过宽限才当泄露整链撤销；`0` = 无宽限 |
| `COFLUX_SERVER` | `ws://localhost:8787/daemon` | daemon 连接的服务器地址 |
| `COFLUX_DEVICE_NAME` | `<hostname>` | daemon 登记时的设备名 |
| `COFLUX_HOME` | `~/.coflux` | daemon 凭证存放目录 |
| `COFLUX_SHELL` | `$SHELL` | PTY 使用的 shell |
| `COFLUX_LOCAL_GATEWAY_PORT` | `8788` | loopback Device gateway；`0` 仅供 dev/test 随机端口 |
| `VITE_COFLUX_SERVER` | `ws://localhost:8787/client` | web 连接的服务器地址 |

## 当前状态

本地优先 V1 已实现，并有全量真实进程黑盒覆盖 direct/P2P/relay、中心停机、连续输入与
session create/stop 去重、worker/server restart、VT snapshot oracle、checkpoint、账号隔离与热升级。
`execRun` 等不可回滚副作用在 worker 崩溃后仍可能结果未知，不能笼统宣称 generic exactly-once。
历史 benchmark 已达到性能门；每次发布仍需复跑 benchmark 与当前 Chrome 实机门。按
2026-07-25 的既有决策，Safari/Firefox 暂不作为阻断门且可用性仍属未知；原生 iOS 真机生产
验收待用户完成。待办见 [docs/ROADMAP.md](docs/ROADMAP.md)。
