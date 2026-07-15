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

### 1. macOS 原生客户端（2026-07-15 立项，最高优先级）

决策：放弃 Web 作为主客户端，只面向 macOS 做原生客户端。**Web 已冻结：不再更新（不加功能、不做迭代，仅限致命安全修复），且未来会直接下线**——kill 条件 = macOS 客户端跑通日常主路径（登录、加设备、导项目、工作区/任务、终端 attach）；届时裁至仅剩两条天生属于浏览器的流（`/authorize` 设备授权、`/proxy-auth` 预览域门禁）的极简页，其余全部删除。

**技术栈（2026-07 调研定稿）**：Swift 6.2+（Swift 6 语言模式）、SwiftUI-first + AppKit 桥接、`@Observable`、SwiftTerm（`NSViewRepresentable` + headless feed）、`URLSessionWebSocketTask`（actor + AsyncStream）、Swift Testing；分发 = Developer ID 签名 + notarytool 公证 + Sparkle 2 自更新。协议直接消费 `proto/gen/swift`（swift-protobuf，与 TS/Rust 同一真相源）；supabase-swift 仅用于登录换票，之后全程 coflux 会话 token（Keychain 存储）。

- [ ] 工程骨架：Xcode 项目 + SPM 依赖 + `proto/gen/swift` 接入 + CI（构建/测试）
- [ ] WS 客户端 actor：连接/认证/指数退避重连/信封编解码（语义对齐 web `use-coflux-client`）
- [ ] 状态层：`stateSnapshot` 首帧 + 增量广播 → `@Observable` store（同通道快照/增量排序保证沿用）
- [ ] 终端：SwiftTerm 桥接、PTY 双向二进制流、scrollback 回放
- [ ] attach/独占接管状态机移植（web 侧最复杂点，对齐 `workspace-terminal.tsx` 语义）
- [ ] 设备/项目/工作区/任务管理界面（含添加设备的登记密钥流）
- [ ] 登录：supabase-swift 换票 + Keychain 会话管理
- [ ] 端口预览：唤起系统浏览器走既有门禁 cookie 流
- [ ] 分发：Developer ID + 公证 + Sparkle appcast
- [ ] 文件树/查看器、命令面板（原"前端 IDE 方向"迁入此处，基于现有 `fs.list`/`fs.read`/`exec` 原语，按需排期）
- [ ] **下线 Web**（kill 条件达成即执行）：`apps/web` 裁至 `/authorize` + `/proxy-auth` 极简页，其余删除；prod 撤主站静态资源

### 2. daemon 原语按需扩展
- [ ] `fs.write`（编辑保存）
- [ ] `fs.watch`（文件变更监听，需 daemon 原生 watcher）

### 3. 产品/部署（详见 OPEN_QUESTIONS）
- [x] 多终端 / 一个工作区多会话（B4）：web 已落地（plan 008）；macOS 客户端对齐
- [ ] Agent 集成（B5）：起任务时可选自动拉起 `claude` / `codex` 带 prompt，人随时接管
- [ ] 中心服务器多实例 + 共享状态（B7 余项；TLS/部署形态已上线）
- [ ] 退出任务的保留/GC 策略（exited task 长期累积）
