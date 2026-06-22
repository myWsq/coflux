# coflux

可跑在用户任意节点上的 **Daemon**，在本地起伪终端（PTY）、驱动本地 Agent（Claude Code / Codex CLI 等），主动外连**中心服务器**；用 **Client** 连接服务器即可触达任意节点上的 Daemon。一机一 daemon、登录一个账号，模型类似 Tailscale。

> 架构详见 [docs/architecture.md](docs/architecture.md)；认证见 [docs/auth-design.md](docs/auth-design.md)；路线图/TODO 见 [docs/ROADMAP.md](docs/ROADMAP.md)；待讨论项见 [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)。

## Monorepo 结构

| 包 | 说明 |
|----|------|
| `packages/protocol` | TS 共享线协议类型（server/web 引用） |
| `apps/server` | 中心服务器（TS）：账号/设备认证 + 编排路由 + 持久化（node:sqlite） |
| `apps/web` | Web Client（TS）：Vite + React + xterm.js |
| `crates/protocol` | Rust 线协议真相源：serde 类型 + 帧 codec + UDS 消息 |
| `crates/supervisor` | Rust daemon 的 supervisor：portable-pty 起 PTY + scrollback + 起/管 worker（极少升级） |
| `crates/worker` | Rust daemon 的 worker（tokio）：连服务器/认证/重连 + git/exec/fs + 编排（频繁升级） |

server/web 是 TypeScript（pnpm workspace）；**daemon 全 Rust**（Cargo workspace，零 node 运行时）。daemon 拆成 supervisor + worker 两进程：升级只换 worker，PTY 在 supervisor 里存活（热升级方案 A）。

## 快速开始

前置：Node + pnpm（server/web）、Rust 工具链（daemon，`rustup` 装 stable 即可）。

```bash
pnpm install          # 安装 TS 依赖

# 分终端跑（dev = server + web；daemon 单独，因为它是 Rust 二进制）：
pnpm dev:server       # 中心服务器，监听 :8787（开发期默认登记密钥 dev-enroll / 登录令牌 dev-client）
pnpm dev:web          # Web，打开 http://localhost:5173
pnpm dev:daemon       # 全 Rust daemon：cargo build 后起 supervisor（再 spawn worker）；用 dev-enroll 登记，凭证存 ~/.coflux
```

1. 打开网页，用登录令牌 `dev-client` 登录（生产改 `COFLUX_CLIENT_TOKEN`）。
2. 左侧出现已登记的设备；在设备下 **＋ws** 新建工作区（填该机器上已存在的绝对路径）。
3. 工作区下 **＋task** 新建任务，点任务行启动并 attach —— 右侧出现远程终端，直接敲命令（含手动启动 `claude` / `codex`）。

任务支持停止/删除；断线或刷新后重新 attach 会回放历史（scrollback 存在 daemon 侧）。设备可在 UI 移除。

## 认证模型（Tailscale 式）

- **登记密钥（EnrollmentKey，账号级）**：新机器首次用它登记进账号 → 服务器签发 **每设备 deviceToken**，daemon 本地持久化。
- **设备凭证（deviceToken）**：后续连接用它认证；daemonId 由服务器签发绑定，无法冒充他机。
- **登录令牌（ClientToken，账号级）**：web 用它登录账号，可见/可达该账号下所有设备。
- 服务器只存 token 的 sha256 hash。详见 [docs/auth-design.md](docs/auth-design.md)。

## 环境变量

| 变量 | 默认 | 用于 |
|------|------|------|
| `COFLUX_PORT` | `8787` | server 监听端口 |
| `COFLUX_DB` | `./data/coflux.db` | server sqlite 路径 |
| `COFLUX_ENROLL_KEY` | `dev-enroll` | 账号登记密钥（server 配置，daemon 登记时用） |
| `COFLUX_CLIENT_TOKEN` | `dev-client` | 账号登录令牌（server 配置，web 登录用） |
| `COFLUX_SERVER` | `ws://localhost:8787/daemon` | daemon 连接的服务器地址 |
| `COFLUX_DEVICE_NAME` | `<hostname>` | daemon 登记时的设备名 |
| `COFLUX_HOME` | `~/.coflux` | daemon 凭证存放目录 |
| `COFLUX_SHELL` | `$SHELL` | PTY 使用的 shell |
| `VITE_COFLUX_SERVER` | `ws://localhost:8787/client` | web 连接的服务器地址 |

## 当前状态

V1 + Tailscale 式认证已实现并通过端到端测试（登记/认证、生命周期、断线续连、服务器重启恢复、账号隔离、设备移除）。待办见 [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)。
