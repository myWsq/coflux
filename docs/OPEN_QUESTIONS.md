# OPEN QUESTIONS / 决策记录

记录两类东西：**(A) 我已自行拍板的设计选择**（按"最佳方案"先做了，待你确认/推翻），**(B) 真正需要你定夺的产品决策**（多与信任模型/形态有关，我没擅自决定）。

---

## A. 已自行拍板（best-judgment，可回退）

| # | 决策 | 理由 | 备选 |
|---|------|------|------|
| A1 | 持久化用内置 `node:sqlite` | node 26 免 flag 可用、零原生依赖、真 SQL | JSON 文件 / Postgres |
| A2 | scrollback 移到 **daemon 侧**（每会话 200k 字符上限） | 与"daemon 持有会话生命周期"一致，服务器重启不丢 | 服务器侧缓冲（已废弃） |
| A3 | 重连协议 `daemon.resync { sessionId, taskId }[]` | 即使服务器重启也能把存活 PTY 重挂回 task；已 e2e 验证 | 仅 sessionId（需服务器记忆映射） |
| A4 | 任务状态机 `idle / running / exited`；对 `exited` 的 task 再 `task.start` = **重跑**（起新 session） | 简单够用 | 显式 restart 语义 / 保留多次运行历史 |
| A5 | PTY 在线协议传**原始 JSON 字符串**（非二进制/base64） | 实现简单、易调试 | 二进制分帧（见 B6） |
| A6 | Web 用 `window.prompt` 创建工作区/任务 | 先把逻辑跑通 | 正式表单 UI |
| A7 | 鉴权仍是**单一共享 token**（daemon 与 client 同一个） | MVP 单用户够用 | 见 B1 |
| A8 | 切换任务时 client 端按 `sessionId` 过滤输出，不向服务器发 detach | 协议更简单；旧 session 仍在服务器侧推送但被前端丢弃 | 加 detach 消息精确退订 |

---

## B. 需要你定夺（未擅自决定）

> 说明：一轮多维度对抗式代码审查确认了 14 个问题，**进程内的竞态/泄漏/越权已全部修复**
> （同 daemonId 重连竞态、重启后重复起 PTY、stop/start 竞态、pending 泄漏与超时、孤儿 PTY 清理、
> daemon 消息注册与归属校验、client 跨 session 越权写入）。**唯一残留的安全缺口是下面 B1 的信任模型**
> ——单一共享 token 下，任何持 token 者都能冒充任意 daemonId，这不是代码 bug 而是模型选择，需你定方向。

### B1. 鉴权与多租户 ★最重要 —— ✅ 已定（Tailscale 模型）
**决策（2026-06-21）**：单用户管自有多机，一机一 daemon、登录一个账号。即 Tailscale 式：
- **Account** 为隔离单元（MVP 单账号，模型留多账号扩展位）。
- **EnrollmentKey（登记密钥，账号级、可复用）**：一台新机器用它登记进账号。
- **每设备独立 deviceToken**：登记后签发，daemon 本地持久化，后续连接用它认证。
  → 从根上修掉 #9 冒充问题：daemonId 由服务器按设备凭证绑定，不再客户端自报。
- **ClientToken（账号级）**：client 登录账号，可见/可达该账号下所有设备。
- 账号内全互通（无需更细 ACL）；跨账号隔离。
- 详见 [auth-design.md](auth-design.md)。

### B2. 工作区的信任边界 ★安全相关 —— ✅ 已定（仅本人自有机器）
**决策（2026-06-21）**：仅操作本人自有机器，无需路径白名单/沙箱/容器。维持现状（daemon 仅校验"是目录"）。

### B3. daemon 离线时，运行中任务怎么处理？ —— ✅ 已定
**决策（2026-06-21）**：接受现状。daemon 进程整死 → PTY 没了，恢复上限是"重新拉起 Agent"而非"恢复同一进程"；网络掉线进程仍活 → 重连 resync 恢复（已验证）。无需额外落盘 PTY 状态。

### B4. task 与 terminal 的基数
现在：一个 task = 一个 PTY。
- 你想要"一个工作区开多个并列终端"吗？还是 task=单终端就够？
- 这影响数据模型（task 下要不要挂多个 session）。

### B5. Agent 集成（V2）
通路已通，下一步接 Agent 时：
- 起任务时**自动拉起** `claude`/`codex` 并喂初始 prompt（人再接管），还是保持"只开 shell、人手动起"？
- 要不要解析 Agent 的结构化输出（headless 模式）做富 UI？（这会引入"半 PTY 半结构化"的混合通道。）

### B6. 数据面是否需要二进制优化
大输出（如整段构建日志）走 JSON 字符串会有转义/吞吐开销。何时值得换二进制分帧 / 压缩？取决于你预期的输出量级。

### B7. 中心服务器部署形态
- 自己托管单实例，还是要多实例 + 共享状态（则 sqlite 要换 Postgres、运行时状态要外置）？
- 传输层 TLS（`wss://`）与公网暴露方式？
