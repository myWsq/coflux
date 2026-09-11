# Plan 20260912-desktop-runtime-lifecycle：统一 Coflux 桌面生命周期与设备接入

> 本文是结果契约。实现以当前代码为准；不得绕过验收或把保留画面等同于保留活进程。
> Drift check: `git diff --stat 2934c35..HEAD -- apps/desktop packages/client packages/cli crates/supervisor crates/cli apps/server tests docs`

## Status
- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: refactor
- Execution: self
- Planned at: `2934c35`, 2026-09-12
- 授权：独立工作区内自动规划、提交、实施、验收；不推送、不创建 PR、不部署生产。

## Requirement
Coflux 是终端产品。Mac 安装主应用并登录即可使用本机及同账号其他设备，不要求用户另外安装 Coflux CLI 或管理 Worker/Supervisor。第三方命令（Claude Code、Codex 等）仍由用户安装。Linux CLI 支持登录接入设备，关闭 CLI 或 SSH 不停止设备。Agent 的本地 terminal/read/send/wait、工作区、进度、通知、端口与跨设备 MCP 能力完整保留。

关闭 Mac 窗口仅隐藏界面、继续在线；主动完全退出时确认本机运行中终端将结束，取消则继续运行。退出登录还清除全部本机终端与账号授权状态，项目文件及其他设备不受影响。不能把网络断开等同于用户主动退出。

系统磁盘权限只向 Coflux 主应用授权，禁止要求用户单独添加 supervisor。普通应用更新可短暂断开界面，但正在运行的终端程序必须存活且新版能接续；托管组件自身更新可推迟，第一阶段不实现任意进程快照恢复或 PTY 热交接。

## Decisions & tradeoffs
- **应用拥有生命周期，终端托管允许跨更新存活**：区分关窗、主动退出、退出登录、更新重启。拒绝把所有退出统一为杀进程。依据 `apps/desktop/src/main/index.ts:109`、`updater.ts:45`：现有退出仅 dispose，更新用 quitAndInstall。
- **保留现有 session authority**：复用 supervisor 持有的 PTY/VT/history/序号，不新增同职能的第三层；调整启动托管方式。拒绝用输出快照冒充程序恢复。依据 `crates/supervisor/src/sessions.rs:446`、`main.rs:198` 与 `docs/architecture.md:47`。
- **权限归属必须实证**：从已签名 Coflux 主应用启动运行组件，权限引导指向 .app；真实终端的受保护目录访问及更新后访问都要验证。拒绝仅改名称或假设父子进程必然继承权限。依据 `crates/supervisor/src/fda.rs:3`：当前独立 LaunchAgent 是授权主体。
- **更新兼容优先**：更新界面不自动替换/停止活托管进程；旧、新组件必须兼容才能接续，否则明确延期或确认终止。不会以新版本启动了为验收。依据 `docs/hot-upgrade-design.md:29`。
- **接入与 Agent 共享产品，但生命周期有平台差异**：Linux 保留服务管理；桌面携带 Agent 工具。不要求用户安装 Node 来使用桌面。CLI 登录可复用设备浏览器授权，不能把用户密码落盘。依据 `crates/cli/src/main.rs:1`、`packages/cli/cofluxd.mjs:1235`。
- **迁移保护现有会话**（规划时决定）：现有 CLI/launchd 安装不能在 App 打开时被静默杀掉；迁移涉及终端结束必须明确提示。开发实例使用隔离 home，不能接管真实服务。
- **用户数据边界**：退出登录结束并清除终端，不删除项目、仓库、工作区文件；旧账号凭据不能用于新账号接入。离线清理必须本地完成并在恢复联网后收敛记录。

## Direction
各里程碑顺序依赖，由当前执行者完成。

### Milestone 1：运行与更新边界
主应用控制本机启动、停止、更新接续；退出确认和失败取消可靠；沿用托管进程的本地协议，避免凭 PID 误杀。测试使用临时 home、临时端口、独立进程组，不操作真实 ~/.coflux 或 launchd 服务。
验证：`pnpm -C apps/desktop typecheck`、`pnpm -C apps/desktop test`、`cargo test -p coflux-supervisor`。

### Milestone 2：登录、登出与可感知界面
登录自动准备本机，错误可重试；权限只展示 Coflux；退出登录清理本机终端和授权；Agent 命令继续可用；Linux CLI 登录保持旧安装命令兼容。
验证：桌面检查与单测、`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`、`cargo test -p coflux-cli`。

### Milestone 3：端到端验证与文档
真实进程验证更新前后相同 shell/任务存活、输出连续、退出/登出终止并清理；签名 App 验证权限归属与升级接续；更新架构、用户安装与发版说明。

## Landmines
- 基线黑盒发现 `tests/src/agent-control.test.mjs:212` 只等第一行 ID 就断言第二行输出的竞态；单独复跑通过。修复应等待完整的可观察输出，不增加固定 sleep。
- `apps/desktop/src/main/daemon-files.ts:35` 的 RunAtLoad/KeepAlive 目前与退出即离线冲突。
- `apps/desktop/src/main/daemon-manager.ts` 目前复制后 ad-hoc 重签并用全局 launchd label，不能沿用为主应用权限保证。
- `apps/desktop/src/main/updater.ts` 默认退出自动安装；窗口关闭顺序不能绕过退出确认。
- `packages/client/src/store.ts:869` 的 logout 只断客户端；不能把所有远端客户端登出都解释成删除远端终端。
- 旧服务与 dev 共用 ~/.coflux；测试必须隔离。
- 版本兼容不只中心协议，还包括旧托管组件与新 worker、Agent 工具及插件路径。
- 本机仅发现 Apple Development 身份，Developer ID 发布签名/公证验收可能需要外部签名环境；不得宣称已通过。

## Scope
In scope: `apps/desktop/`、`packages/client/`、`packages/cli/`、`crates/{supervisor,worker,cli,protocol}/`、`packages/protocol/`、`proto/`（若必要）、`apps/server/`、`tests/`、`scripts/`、`docs/`、`README.md`、`wiki/plans/`、相关构建清单与 CI。
Out of scope: 生产部署、推送/PR、第三方 Agent 安装、任意活进程快照恢复、终端托管热交接、其他产品 UI 重设计。

## Commands
| 用途 | 命令 | 预期 |
| --- | --- | --- |
| 桌面类型与单测 | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` | exit 0 |
| 服务类型 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust | `cargo test -p coflux-supervisor -p coflux-cli && cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli` | exit 0，零警告 |
| 黑盒（acceptance） | `pnpm -C tests test` | 全过 |
| 桌面构建 | `pnpm -C apps/desktop build` | exit 0 |
| 签名运行（acceptance） | 使用隔离 home 的签名 App，执行主应用 FDA 授权、活任务下更新、退出/登出验收 | 相同任务存活或按用户动作结束，权限只归 Coflux |

## Done criteria
- [ ] 类型检查、单测、构建、全量黑盒通过。
- [ ] 关窗、退出、取消退出、退出登录、更新重启各行为符合契约。
- [ ] 登录后自动接入；CLI 登录与全部 Agent 能力验证通过。
- [ ] 活任务跨应用更新与延迟托管更新验证通过。
- [ ] 签名 App 权限归属及更新后受保护目录访问验证通过。
- [ ] 项目文件未删除，其他设备不受影响；旧账号不能继续访问本机。
- [ ] 文档与实际行为一致，范围检查完成，索引标为 DONE。

## STOP conditions
必要事实被证伪；必须扩大已授权产品范围；同一验证经一次合理修复仍失败；签名/系统授权等外部条件阻断验收时记录已完成结果和缺失证据，不标记完成。

## Maintenance notes
生命周期与进程存在性独立于客户端网络在线状态。正常更新保活不意味着 macOS 重启或托管进程崩溃后可恢复程序。
