# OPEN QUESTIONS / 决策记录

记录两类东西：**(A) 我已自行拍板的设计选择**（按"最佳方案"先做了，待你确认/推翻），**(B) 真正需要你定夺的产品决策**（多与信任模型/形态有关，我没擅自决定）。

---

## A. 已自行拍板（best-judgment，可回退）

| # | 决策 | 理由 | 备选 |
|---|------|------|------|
| A1 | ~~内置 `node:sqlite` / Supabase Postgres~~ **已由 plans 059-063 收敛为自托管 Postgres**（2026-07） | 业务数据自持；保留事务、备份与未来扩展能力 | ——|
| A2 | PTY/VT/history/holder/sequence 统一在 **supervisor/sessiond** | client、worker、中心断开都不影响会话；attach 直接取当前 snapshot | server live mirror（已删除） |
| A3 | daemon resync + 完整 Device catalog/tombstone 对账 | 服务器重启可重挂已知 task，unknown live session 保留为 orphan，不伪造 exit | 仅 sessionId（无法可靠收敛生命周期） |
| A4 | 任务状态机 `idle / running / exited`；对 `exited` 的 task 再 `task.start` = **重跑**（起新 session） | 简单够用 | 显式 restart 语义 / 保留多次运行历史 |
| A5 | PTY 与普通 RPC 统一走端到端 **DeviceEnvelope** | direct/relay 共用语义，中心不解析 raw terminal | 中心 protobuf PTY（已删除并 reserved） |
| A6 | Web 已迁正式工作台与导入/任务交互 | desktop web 是默认迭代对象 | `window.prompt` 原型（已删除） |
| A7 | daemon 每设备凭证、client 账号会话 token | daemonId 由服务器绑定，账号隔离 | 单一共享 token（已删除） |
| A8 | sessiond 单 holder + 显式 takeover | detach、epoch、sequence 在唯一 authority 裁决 | server viewer/holder（已删除） |

---

## B. 需要你定夺（未擅自决定）

> 本节保留产品与部署决策。早期共享 token、登记密钥、SQLite/Supabase 等候选已经退役；当前安全边界
> 以每设备凭证、server 签发的 client 会话 token、账号归属校验和单实例中心为准。

### B1. 鉴权与多租户 ★最重要 —— ✅ 已定（Tailscale 模型）
**决策（2026-06-21）**：单用户管自有多机，一机一 daemon、登录一个账号。即 Tailscale 式：
- **Account** 为隔离单元（MVP 单账号，模型留多账号扩展位）。
- **浏览器一次性授权**：未登记 daemon 的授权请求与当前 WS 连接绑定，用户登录后确认。
- **每设备独立 deviceToken**：登记后签发，daemon 本地持久化，后续连接用它认证。
  → 从根上修掉 #9 冒充问题：daemonId 由服务器按设备凭证绑定，不再客户端自报。
- **用户口令 + 会话 token**：`local`/`password` 两种登录模式均由 server 签发有期限、可撤销的账号会话 token。
- 账号内全互通（无需更细 ACL）；跨账号隔离。
- 详见 [auth-design.md](auth-design.md)。

### B2. 工作区的信任边界 ★安全相关 —— ✅ 已定（仅本人自有机器）
**决策（2026-06-21）**：仅操作本人自有机器，无需路径白名单/沙箱/容器。维持现状（daemon 仅校验"是目录"）。

### B3. daemon 离线时，运行中任务怎么处理？ —— ✅ 已定
**决策（2026-06-21）**：接受现状。daemon 进程整死 → PTY 没了，恢复上限是"重新拉起 Agent"而非"恢复同一进程"；网络掉线进程仍活 → 重连 resync 恢复（已验证）。无需额外落盘 PTY 状态。

### B4. task 与 terminal 的基数 —— ✅ 已定
一个 workspace 可有多个 task/终端 Tab；一个 task 的一次运行对应一个 live session，退出后重跑会创建
新 session。desktop web 已落地，mobile 保持冻结形态。

### B5. Agent 集成（V2）
通路已通，下一步接 Agent 时：
- 起任务时**自动拉起** `claude`/`codex` 并喂初始 prompt（人再接管），还是保持"只开 shell、人手动起"？
- 要不要解析 Agent 的结构化输出（headless 模式）做富 UI？（这会引入"半 PTY 半结构化"的混合通道。）

### B6. 数据面是否需要二进制优化 —— ✅ 已完成并演进为本地优先（2026-07）
terminal、holder、input ACK 与普通 RPC 使用 direct/relay 共用的 protobuf DeviceEnvelope。中心 relay 只转发
opaque bytes；旧 `pty.output/input/replay` 与 server-routed RPC 已删除并保留字段编号。见
[architecture.md](architecture.md)。

### B7. 中心服务器部署形态 —— ✅ 已定（2026-07）
- 单实例自托管（prod-jp），业务数据使用自托管 Postgres；身份层为 `local` 或自建 `password` 模式，Supabase 已退役。
- TLS：`api.coflux.dev` 反代终结 `wss://`（2026-09-04 起前置一层 owo-jp-gw 入口反代，
  中心自身仍只绑回环，见 [deployment.md](deployment.md)）。单实例是当前既定产品形态；没有明确需求前不引入 Redis、
  leader election 或共享 presence。若未来改为多实例，pending authorization、在线 daemon 与 relay home
  等内存 authority 必须先设计成可线性化的共享状态，不能只把现有 Map 搬进缓存。
