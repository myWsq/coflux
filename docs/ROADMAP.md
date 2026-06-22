# coflux 路线图 / TODO

> 记录已完成的里程碑与待办工作。讨论细节见 [architecture.md](architecture.md) / [auth-design.md](auth-design.md) / [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)。

## 已完成

- **V1 远程终端 + 项目制**：Account → Device → Project(git 仓库) → Workspace(主=仓库本身 / 其它=git worktree) → Task → Session(PTY)。
- **Tailscale 式认证**：登记密钥 + 每设备凭证（daemonId 服务器签发不可冒充）+ 账号隔离。
- **独占 + handoff**：一个终端同时一个控制端，attach 即接管。
- **生产化加固**（两轮 + 一轮对抗式审查，共修 30 项确认问题）：WS 心跳、背压/流控、优雅关闭、崩溃兜底、重连指数退避、store 事务/预编译/WAL、级联删除原子化、结构化日志、统一配置。
- **模块化**：server 拆 config/store/secrets/pending/transport/hub/index；daemon 拆 config/creds/git/sessions/exec/fs/index。
- **daemon 通用原语**：`exec`、`fs.list`/`fs.read`（root 锚定 + realpath 防穿越）。很多新功能用现有原语即可，只动 server+web。
- **黑盒集成测试**（`tests/`，跨重构有效）：14 项，覆盖 auth/项目-worktree-任务-PTY/重启恢复/跨 daemon 安全/handoff/health/优雅关闭/exec/fs/路径穿越。

## 待办

### 1. 二进制数据面（性能，原加固计划最后一项）✅ 已完成（2026-06）
- [x] `pty.output` / `pty.input` / `pty.replay` 改**二进制帧**（`encodeFrame`/`decodeFrame` in `packages/protocol`），免 JSON 转义、降 CPU/带宽；控制面（含 `pty.resize`）保持 JSON。
- [x] 三端 + 测试 harness 全部联动：WS 上按 `isBinary`/`binaryType` 分流文本与二进制；server 对数据面只校验归属后**原样转发字节**（不重新编解码）。
- [x] 黑盒测试通过（handoff/lifecycle/reconnect 等覆盖 pty 双向流 + scrollback 回放）。
- 帧体格式 `[kind][sidLen][sessionId][?ridLen][?requestId][payload]`：WS 上一个二进制 message = 一帧；**热升级 UDS 阶段在外层包 4 字节长度前缀即可复用同一帧体**（见 [hot-upgrade-design.md](hot-upgrade-design.md) 排序决策）。
- 后续可选：`fs.read` 大文件也走二进制帧；node-pty `encoding:null` 直接拿 Buffer 省一次 decode/encode。

### 2. 自动热升级（已定 **方案 A：supervisor 持有 PTY + worker 可升级**）
让 daemon 后台自动升级、且**升级时运行中会话存活**。详见 [hot-upgrade-design.md](hot-upgrade-design.md)。
- [x] **supervisor/worker 拆分 + 全 Rust 化（已完成 2026-06）**：daemon = `crates/supervisor`(portable-pty + scrollback + UDS server + 起/管/重启 worker) + `crates/worker`(tokio：连接/认证/git/exec/fs/编排)，**零 node 运行时**。本地 UDS IPC，**两级 resync**（worker 重启 → 连 supervisor 取回会话 + 连 server resync，有序门控防空 resync 杀 PTY）。先 TS 验证机制、再逐进程 Rust 化（UDS/WS 语言中立，黑盒测试一路验证不返工），旧 TS daemon 已删。黑盒测试覆盖"杀 worker、PTY 存活、会话重挂"。
- [x] **升级投递（已完成 2026-06）**：`client.upgradeDaemon{version}` → server → `worker.upgrade{version}` → worker 转 supervisor。**仅传版本标签**，supervisor 在自有注册表里解析，绝不执行外部传入路径（守住验签前的 RCE 口子）。注册表现为内置 + `COFLUX_WORKER_SPECS` 注入；将来由"下载+验签"填充。`url/sha256/signature` 随下载步骤再加。
- [x] **切换 + 回滚（已完成 2026-06）**：supervisor `switchWorker(version)` 重启 worker 到新版；**观察期**（`PROBATION_MS`）内稳定运行才提交为 active，崩溃达阈值则自动回滚到上一好版本。会话全程在 supervisor 不受影响。黑盒测试覆盖"升级提交"与"坏版本回滚"，会话均存活。
- [ ] **验签（后续优化项，但为升级启用的硬前置）**：supervisor 内置公钥 ed25519 验签（防中心服务器被攻破 → 全网 RCE）。⚠️ 验签补齐前 supervisor 只跑本地已装 worker、**不接升级下载**（当前正是如此：只在已知版本间切换）。
- [ ] **打包 + launcher**：worker 打成可替换产物，supervisor 由 systemd/launchd 拉起。

**已定决策（2026-06 讨论确认，详见 hot-upgrade-design.md）**：
- **排序**：先收尾二进制数据面（条目 1），再做 supervisor 拆分——UDS 与 WS 共用长度前缀帧，先做稳不返工。
- **语言/打包**：原定"supervisor=Rust、worker=TS"，**实际推进为 supervisor + worker 都 Rust**（全 Rust daemon，零 node 运行时，打包 = 扔两个静态二进制）。protocol 在 `crates/protocol`，web 端 TS 后续可 codegen 生成消除重复。
- **签名**：方向是 **ed25519 + supervisor 内置公钥**（无现有体系可复用），**首版延后**（列入后续优化项）；前置约束：验签补齐前不启用 worker 自动升级下载。

### 3. daemon 原语按需扩展
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
