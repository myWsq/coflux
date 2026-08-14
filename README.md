# coflux

可跑在用户任意节点上的 **Daemon**，在本地起 PTY、驱动 Claude Code / Codex CLI 等 Agent。
远端访问经中心 opaque relay；web 与 daemon 同机时优先直连 loopback gateway，terminal 与普通
Device RPC 热路径不经过中心。一机一 daemon、登录一个账号，设备模型类似 Tailscale。

> 架构详见 [docs/architecture.md](docs/architecture.md)；认证见 [docs/auth-design.md](docs/auth-design.md)；路线图/TODO 见 [docs/ROADMAP.md](docs/ROADMAP.md)；待讨论项见 [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)。

## Monorepo 结构

| 包 | 说明 |
|----|------|
| `packages/protocol` | Buf 生成的 TS 共享线协议（真相源在 `proto/`） |
| `apps/server` | 中心服务器（TS）：认证/编排 + opaque relay + checkpoint + Postgres |
| `apps/web` | Web Client（TS）：Vite + React + xterm.js |
| `crates/protocol` | Buf 生成的 Rust 协议 + UDS frame/IPC |
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

1. 打开网页，用登录令牌 `dev-client` 登录（生产改 `COFLUX_CLIENT_TOKEN`）。
2. 从在线设备导入该机器上已有的 git 仓库，再按需创建 worktree 工作区。
3. 在工作区中新建终端，直接启动 `claude` / `codex`；同机优先显示 direct transport，失败自动 relay。

任务支持停止/删除。重新 attach 从 daemon 的 VT/history 生成 snapshot，不从中心回放 raw PTY。已加载且
已配对的页面在中心停止后仍可 list/attach/input/resize/stop；离线刷新/冷启动不在保证范围。

## 认证模型（Tailscale 式）

- **浏览器授权**：新机器 daemon 发起授权请求，用户在已登录的浏览器里确认 → 服务器签发 **每设备 deviceToken**，daemon 本地持久化。
- **设备凭证（deviceToken）**：后续连接用它认证；daemonId 由服务器签发绑定，无法冒充他机。
- **登录令牌（ClientToken，账号级）**：web 用它登录账号，可见/可达该账号下所有设备。
- 服务器只存 token 的 sha256 hash。详见 [docs/auth-design.md](docs/auth-design.md)。

## 环境变量

| 变量 | 默认 | 用于 |
|------|------|------|
| `COFLUX_PORT` | `8787` | server 监听端口 |
| `DATABASE_URL` | 生产必填；`COFLUX_DEV=1` 时弱默认 `postgres://postgres:postgres@127.0.0.1:5432/postgres` | server 的 Postgres 连接串（含密码，视为秘密） |
| `COFLUX_CLIENT_TOKEN` | `dev-client` | 账号登录令牌（server 配置，web 登录用） |
| `COFLUX_PROXY_HOST` | `p.localhost` | 端口转发预览域：`<shortId>.<该值>` 按反代路由（Host 头分流，与 client/daemon WS 共用同一端口）；生产需配好泛解析 + 泛证书 |
| `COFLUX_SERVER` | `ws://localhost:8787/daemon` | daemon 连接的服务器地址 |
| `COFLUX_DEVICE_NAME` | `<hostname>` | daemon 登记时的设备名 |
| `COFLUX_HOME` | `~/.coflux` | daemon 凭证存放目录 |
| `COFLUX_SHELL` | `$SHELL` | PTY 使用的 shell |
| `COFLUX_LOCAL_GATEWAY_PORT` | `8788` | loopback Device gateway；`0` 仅供 dev/test 随机端口 |
| `VITE_COFLUX_SERVER` | `ws://localhost:8787/client` | web 连接的服务器地址 |

## 当前状态

本地优先 V1 已实现并通过 74 项真实进程黑盒：direct/relay、中心停机、input/mutation exactly-once、
worker/server restart、VT snapshot oracle、checkpoint、账号隔离与热升级。性能门已满足；macOS 当前稳定版
Chrome/Safari/Firefox 实机矩阵仍需发布前签字。待办见 [docs/ROADMAP.md](docs/ROADMAP.md)。
