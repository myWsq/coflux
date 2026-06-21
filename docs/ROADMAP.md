# coflux 路线图 / TODO

> 记录已完成的里程碑与待办工作。讨论细节见 [architecture.md](architecture.md) / [auth-design.md](auth-design.md) / [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)。

## 已完成

- **V1 远程终端 + 项目制**：Account → Device → Project(git 仓库) → Workspace(主=仓库本身 / 其它=git worktree) → Task → Session(PTY)。
- **Tailscale 式认证**：登记密钥 + 每设备凭证（daemonId 服务器签发不可冒充）+ 账号隔离。
- **独占 + handoff**：一个终端同时一个控制端，attach 即接管。
- **生产化加固**（两轮 + 一轮对抗式审查，共修 30 项确认问题）：WS 心跳、背压/流控、优雅关闭、崩溃兜底、重连指数退避、store 事务/预编译/WAL、级联删除原子化、结构化日志、统一配置。
- **模块化**：server 拆 config/store/secrets/pending/transport/hub/index；daemon 拆 config/creds/git/sessions/exec/fs/index。
- **daemon 稳定契约 v1**：能力协商（protocolVersion + capabilities）、`exec` 通用原语、`fs.list`/`fs.read`（root 锚定 + realpath 防穿越）、`unsupported` NACK。让未来功能 90% 只动 server+web。
- **黑盒集成测试**（`tests/`，跨重构有效）：15 项，覆盖 auth/项目-worktree-任务-PTY/重启恢复/跨 daemon 安全/handoff/health/优雅关闭/exec/fs/路径穿越。

## 待办

### 1. 二进制数据面（性能，原加固计划最后一项）
- `pty.output` / `pty.input` / `pty.replay`（及后续 `fs.read`）改**长度前缀二进制帧**，免 JSON 转义、降 CPU/带宽。
- 控制面保持 JSON；同步改 protocol / daemon / server / web **及测试 harness**（需能解析二进制帧）。

### 2. 自动热升级（已定 **方案 A：supervisor 持有 PTY + worker 可升级**）
让 daemon 后台自动升级、且**升级时运行中会话存活**。详见 [hot-upgrade-design.md](hot-upgrade-design.md)。
- [ ] **supervisor/worker 拆分**：supervisor 持有 node-pty + scrollback；worker 承载连接/认证/git/fs/协议/编排。本地 UDS IPC，**两级 resync**（复用现有 daemon↔server 模式下沉一层）。
- [ ] **升级投递**：server 下发 `worker.upgrade{version, url, sha256, signature}`。
- [ ] **验签 + 切换 + 回滚**：supervisor 内置公钥验签（防中心服务器被攻破 → 全网 RCE）；新版崩溃循环则自动回滚。
- [ ] **打包 + launcher**：worker 打成可替换产物，supervisor 由 systemd/launchd 拉起。

**开工前待定（3 个）**：
- 排序：先收尾二进制数据面、还是先做 supervisor 拆分？
- 打包方式：`node --experimental-sea` 单文件 / `bun build --compile` / 带 node 运行时 tarball？
- 签名密钥：是否已有发布签名体系，还是新设计一套（ed25519，supervisor 内置公钥）？

### 3. daemon 原语按需扩展（走能力协商，不破坏老 daemon）
- [ ] `fs.write`（IDE 编辑保存）
- [ ] `fs.watch`（文件变更监听，需 daemon 原生 watcher）

### 4. 产品/部署（详见 OPEN_QUESTIONS）
- [ ] 多终端 / 一个工作区多会话（B4）
- [ ] Agent 集成（B5）：起任务时可选自动拉起 `claude` / `codex` 带 prompt，人随时接管
- [ ] 中心服务器部署形态（B7）：全程 TLS(`wss://`)、（如需）多实例 + 共享状态
- [ ] 退出任务的保留/GC 策略（exited task 长期累积）

### 5. 前端（IDE 方向）
- [ ] 基于 `fs.list`/`fs.read` 的文件树 / 查看器
- [ ] 基于 `exec` 的命令面板 / git 状态视图
- [ ] 按 `DaemonInfo.capabilities` 做功能点亮（feature-gate）
