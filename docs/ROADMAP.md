# coflux 路线图 / TODO

> 记录已完成的里程碑与待办工作。讨论细节见 [architecture.md](architecture.md) / [auth-design.md](auth-design.md) / [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)。

## 已完成

- **V1 远程终端 + 项目制**：Account → Device → Project(git 仓库) → Workspace(主=仓库本身 / 其它=git worktree) → Task → Session(PTY)。
- **Tailscale 式认证**：登记密钥 + 每设备凭证（daemonId 服务器签发不可冒充）+ 账号隔离。
- **独占 + handoff**：一个终端同时一个控制端，attach 即接管。
- **生产化加固**（两轮 + 一轮对抗式审查，共修 30 项确认问题）：WS 心跳、背压/流控、优雅关闭、崩溃兜底、重连指数退避、store 事务、级联删除原子化、结构化日志、统一配置。
- **daemon 通用原语**：`exec`、`fs.list`/`fs.read`（root 锚定 + realpath 防穿越）。很多新功能用现有原语即可，只动 server+web。
- **二进制数据面**（2026-06）：pty 数据走二进制帧免 JSON 转义；后随 plan 009 统一为全 protobuf binary wire。
- **自动热升级全链路**（2026-06，方案 A，详见 [hot-upgrade-design.md](hot-upgrade-design.md)）：supervisor/worker 拆分 + 全 Rust 化（零 node 运行时，UDS IPC + 两级 resync，升级时会话存活）；版本注册表 + 观察期切换/自动回滚；远程下载 + sha256 + ed25519 验签（验签不过一律拒绝，防中心服务器被攻破 → 全网 RCE）；用户侧 `cofluxd` CLI（npm）装 systemd/launchd 服务。
- **发布链路**（2026-06→07）：git tag `v*` → release.yml 四平台交叉编译 + worker 产物 ed25519 签名（`WORKER_SIGNING_KEY` secret）+ manifest；supervisor 内置真发布公钥（`release-pubkey.hex` 编译期嵌入，公钥非密可提交）。
- **多账号 + Supabase 认证**（plans/001-002，2026-07）：换票模式（Supabase 只管"你是谁"，JWKS 本地验签换 coflux 会话 token，之后不再触碰 Supabase）；存储迁 Postgres（生产 = Supabase 云，`coflux` schema）。
- **设备授权**（plan 003，2026-07）：daemon 无登记密钥时走浏览器授权流（一次性授权码 + `/authorize` 页）。
- **端口转发预览**（plans/004-007，2026-07）：`*.p.coflux.dev` 泛域名，账号级门禁 cookie + 一次性授权 code，整条 TCP 经 daemon 隧道字节级透传（HTTP/SSE/WS 通吃）；shortId 确定性可收藏。
- **Web 工作区多终端 Tab**（plan 008，2026-07）。
- **协议真相源 Protobuf 化**（plan 009，2026-07-15）：`proto/`（Buf 管理）单一真相源，`buf generate` 出 TS（protobuf-es）/ Rust（prost）/ Swift（swift-protobuf）三端；wire 迁全 protobuf binary 信封，旧 JSON 协议下线；CI 上 `buf lint` + `buf breaking` + 生成产物零 diff 校验。v0.3.0 发布并上线生产（api/app.coflux.dev）。
- **server RavenJS 化 + 全仓库 TypeScript 7**（2026-07-15）：HTTP 应用层迁 `@raven.js/core`（组合根 + 插件 + 契约路由），WS/反代保持传输层；确认架构不变量——**client/daemon 均只连中心服务器（严格星形，含 PTY），server(Postgres) 是全部逻辑状态的真相源**。
- **黑盒集成测试**（`tests/`，跨重构有效）：37 项，覆盖 auth/多账号隔离/项目-worktree-任务-PTY/重启恢复/两级 resync/跨 daemon 安全/handoff/热升级与验签对抗/端口转发门禁与 WS 透传/畸形 wire/优雅关闭。
- **生产部署**：prod-jp（Debian + Caddy 自动 HTTPS + systemd），DNS/泛证书/DB 见运维记录；`scripts/prod-smoke.mjs` 7 步真协议冒烟。

## 待办

### 1. Web 客户端产品化（主客户端，2026-07-16 确认）

> 2026-07-15 曾立项"弃 Web 转 macOS 原生"，次日复议撤回：web 是当前唯一在用的日常客户端，
> 先把它做好；macOS 原生降级为后续增强（见条目 4）。产品定位已定：**Agent 指挥中心**——
> 围绕"在各设备的工作区里跑 claude/codex 任务，人监督、随时接管"组织功能与交互，
> 终端仍是核心界面，但组织逻辑是任务而非连接。功能/交互细化待产品设计讨论产出。

**已知问题/待细化（2026-07-19 记录）：**
- [ ] 终端渲染问题：经常错位
- [ ] 图片复制粘贴问题
- [ ] 终端样式调整
- [ ] 导入设备引导优化
- [ ] 端口转发能力交互
- [ ] 终端恢复的性能问题
- [ ] git diff 的展示
- [ ] 快捷键支持
- [ ] 登录页和设备授权页的 UI 优化
- [ ] 项目/设备的展示

### 2. daemon 原语按需扩展
- [ ] `fs.write`（编辑保存）
- [ ] `fs.watch`（文件变更监听，需 daemon 原生 watcher）

### 3. 产品/部署（详见 OPEN_QUESTIONS）
- [x] 多终端 / 一个工作区多会话（B4）：web 已落地（plan 008）
- [ ] Agent 集成（B5）：起任务时可选自动拉起 `claude` / `codex` 带 prompt，人随时接管
- [ ] 中心服务器多实例 + 共享状态（B7 余项；TLS/部署形态已上线）
- [ ] 退出任务的保留/GC 策略（exited task 长期累积）

### 4. macOS 原生客户端（后续增强，暂缓）

2026-07 调研结论保留备用：Swift 6.2+ / SwiftUI-first + AppKit 桥接 / `@Observable` / SwiftTerm /
`URLSessionWebSocketTask`（actor + AsyncStream）/ Swift Testing；分发 = Developer ID + notarytool +
Sparkle 2。协议侧已就绪：`proto/gen/swift`（swift-protobuf）与 TS/Rust 同一真相源，立项即可消费。
最难移植点预判：attach/独占接管状态机（`workspace-terminal.tsx`）。
