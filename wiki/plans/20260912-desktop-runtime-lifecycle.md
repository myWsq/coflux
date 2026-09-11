# Plan 20260912-desktop-runtime-lifecycle：统一 Coflux 桌面生命周期与设备接入

> 本文是结果契约。实现以当前代码为准；不得绕过验收或把保留画面等同于保留活进程。
> Drift check: `git diff --stat 2934c35..HEAD -- apps/desktop packages/client packages/cli crates/supervisor crates/cli apps/server tests docs`

## Status
- State: DONE（本地实施与验收完成；不推送、不发布）
- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: refactor
- Execution: self
- Planned at: `2934c35`, 2026-09-12
- 授权：独立工作区内自动规划、提交、实施、验收；不推送、不创建 PR、不部署生产。

## Requirement
2026-09-12 实施中用户补充：桌面与 CLI 都是同一终端内核的客户端，功能定位一致；桌面面向人，CLI 主要面向 Agent。CLI 应覆盖登录、工作区、终端及跨设备操作；两种客户端升级都不得结束内核持有的终端。Agent 使用不再以 MCP 为必要前提。用户随后明确授权移除 MCP。服务入口、专用 OAuth 流程、插件配置与 Agent 指引一并删除，原业务能力转由账号 CLI 提供。

Coflux 是终端产品。Mac 安装主应用并登录即可使用本机及同账号其他设备，不要求用户另外安装 Coflux CLI 或管理 Worker/Supervisor。第三方命令（Claude Code、Codex 等）仍由用户安装。Linux CLI 支持登录接入设备，关闭 CLI 或 SSH 不停止设备。Agent 的本地 terminal/read/send/wait、工作区、进度、通知、端口与跨设备操作能力完整保留。

关闭 Mac 窗口仅隐藏界面、继续在线；主动完全退出时确认本机运行中终端将结束，取消则继续运行。退出登录还清除全部本机终端与账号授权状态，项目文件及其他设备不受影响。不能把网络断开等同于用户主动退出。

系统磁盘权限只向 Coflux 主应用授权，禁止要求用户单独添加 supervisor。普通应用更新可短暂断开界面，但正在运行的终端程序必须存活且新版能接续；托管组件自身更新可推迟，第一阶段不实现任意进程快照恢复或 PTY 热交接。

## Decisions & tradeoffs
- **应用拥有生命周期，终端托管允许跨更新存活**：区分关窗、主动退出、退出登录、更新重启。拒绝把所有退出统一为杀进程。依据 `apps/desktop/src/main/index.ts:109`、`updater.ts:45`：现有退出仅 dispose，更新用 quitAndInstall。
- **保留现有 session authority**：复用 supervisor 持有的 PTY/VT/history/序号，不新增同职能的第三层；调整启动托管方式。拒绝用输出快照冒充程序恢复。依据 `crates/supervisor/src/sessions.rs:446`、`main.rs:198` 与 `docs/architecture.md:47`。
- **权限归属必须实证**：从已签名 Coflux 主应用启动运行组件，权限引导指向 .app；真实终端的受保护目录访问及更新后访问都要验证。拒绝仅改名称或假设父子进程必然继承权限。依据 `crates/supervisor/src/fda.rs:3`：当前独立 LaunchAgent 是授权主体。
- **更新兼容优先**：更新界面不自动替换/停止活托管进程；旧、新组件必须兼容才能接续，否则明确延期或确认终止。不会以新版本启动了为验收。依据 `docs/hot-upgrade-design.md:29`。
- **接入与 Agent 共享产品，但生命周期有平台差异**：Linux 保留服务管理；桌面携带 Agent 工具。不要求用户安装 Node 来使用桌面。CLI 使用账号登录接口，桌面内置 CLI 可复用应用登录，不能把用户密码落盘。依据 `crates/cli/src/main.rs:1`、`packages/cli/cofluxd.mjs:1235`。
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

### Milestone 3：CLI 客户端能力收敛
CLI 提供与桌面相同的核心工作区/终端操作能力，保留 Agent 现有调用；跨设备调用不要求 MCP。命令执行结束与停止设备是不同动作，升级 CLI 不结束活终端。复用现有协议与运行能力，具体命令分组由实现按当前 CLI 兼容约束确定。
验证：`cargo test -p coflux-cli` 与 CLI 类型/命令检查；真实跨设备调用列入最终黑盒。

### Milestone 4：端到端验证与文档
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
In scope: `AGENTS.md`、`apps/desktop/`、`packages/client/`、`packages/cli/`、`integrations/claude-plugin/`（同步 CLI 能力与插件引导，不发布市场）、`crates/{supervisor,worker,cli,protocol}/`、`packages/protocol/`、`proto/`（若必要）、`apps/server/`、`tests/`、`scripts/`、`docs/`、`README.md`、`wiki/plans/`、相关构建清单与 CI。
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
- [x] 类型检查、单测、构建、全量黑盒通过。
- [x] 关窗、退出、取消退出、退出登录、更新重启各行为符合契约。
- [x] 登录后自动接入；CLI 登录与原有核心 Agent 能力验证通过。
- [x] 活任务跨应用更新保活验证通过；新应用沿用原托管实例。
- [x] Apple Development 签名 App 权限归属及更新后受保护目录访问验证通过。
- [x] 项目文件未删除，其他设备活任务保留；退出的旧客户端会话不能继续访问。
- [x] 文档与实际行为一致，范围检查完成，索引标为 DONE。

## MCP 移除补充
- `/mcp`、专用 `/oauth/*` 和 OAuth 元数据路由移除；设备授权与端口预览页面继续保留。
- 插件删除 `.mcp.json` 与 MCP 引导；新终端不再注入 `COFLUX_MCP_URL`。
- 原工作区/终端写入、跨账号隔离、环境注入黑盒迁移到账号 API；新增旧入口返回 404 的验收。
- 已应用的数据库迁移不改写；旧 OAuth 表暂留存但没有读写入口。协议中已分配的旧字段保留兼容编号，服务端不再处理 OAuth 消息或发布 MCP 地址。
- 移除 MCP 后旧插件需升级；本任务不部署、不发布市场，不修改用户已安装的宿主配置。

## STOP conditions
必要事实被证伪；必须扩大已授权产品范围；同一验证经一次合理修复仍失败；签名/系统授权等外部条件阻断验收时记录已完成结果和缺失证据，不标记完成。

## Maintenance notes
生命周期与进程存在性独立于客户端网络在线状态。正常更新保活不意味着 macOS 重启或托管进程崩溃后可恢复程序。

## 实施补充：CLI 账号通道
- Pattern Plan：接口适配 + runtime assembly。新增 `interface/client-login/` 与 `interface/client-command/` 的 contract/handler，在 `app.ts` 注册；账号验证、任务副作用继续使用 Hub/Store，接口不复制任务事务或 PTY 逻辑，不新增插件或数据库模型。
- CLI 使用与桌面相同的账号会话，设备 token 不能用于账号操作。账号命令采用有版本的 JSON 请求和结构化结果；复用现有 Hub account operations，MCP 及其 OAuth 适配已删除。
- 新增命令覆盖设备/项目/工作区发现和工作区/终端操作；原无凭据的当前工作区 Agent 命令保持兼容。显式目标用于跨工作区调用。

## 验收记录（2026-09-12）

### 已验证
- 最终全量黑盒 316/316 通过（214.9 秒，2 路并行）；MCP 专属 OAuth 测试退役，原业务行为测试已迁移。命令：`CARGO_TARGET_DIR=/Users/wsq/Workspace/coflux/target COFLUX_SUPERVISOR_BIN=/Users/wsq/Workspace/coflux/target/debug/coflux-supervisor COFLUX_WORKER_BIN=/Users/wsq/Workspace/coflux/target/debug/coflux-worker COFLUX_RELAY_BIN=/Users/wsq/Workspace/coflux/target/debug/coflux-relay COFLUX_CLI_BIN=/Users/wsq/Workspace/coflux/target/debug/cofluxd COFLUX_TEST_CONCURRENCY=2 pnpm -C tests test`。
- 最终 Apple Development 包通过 `codesign --verify --deep --strict`；资源中没有 `.mcp.json`，内置 SKILL 不再引导配置 MCP。此结果不代表 Developer ID、公证或完全磁盘访问验收。
- 桌面类型检查、服务类型检查与桌面构建通过；桌面原实现单测 113/113；补修后 116/116，Rust CLI 32/32、supervisor 73/73。
- 新账号 CLI 黑盒用两台真实 daemon 验证两种 CLI 登录、发现设备、远端工作区和终端操作；命令退出不结束终端。
- 原 MCP 的工作区/终端操作与隔离断言迁移到 HTTP 账号接口；旧服务地址明确返回 404。设备授权和端口预览继续使用原有页面与鉴权。
- 托管内核黑盒验证重新连接后同一 shell PID 和内存变量仍存活；错误实例标识不能停止新实例，正确停止会结束真实程序。
- 隔离 Apple Development 签名应用实机：登录后自动接入本机，内置 CLI 无需再次登录即可取得账号；创建终端后取消退出仍是同一 PID 59015，内存标记保留；确认退出后 App、shell 均结束且 runtime socket 消失。重启应用可恢复账号，原终端显示已退出而非伪装为恢复。
- 所有实机操作使用临时 userData、COFLUX_HOME、8876 本地服务器和临时数据库；未修改真实安装与系统服务。补验收实例、临时数据库、应用目录和更新缓存均已清理；系统权限列表已不再显示测试应用。

### 继续验收新增证据（2026-09-12）
- 实际点击内置更新按钮，经 electron-updater/Squirrel 下载、替换和重启：独立签名测试应用 `dev.coflux.acceptance` 从 0.1.7 升至 0.1.8。重启后 userData 仍在临时目录；这次不是用强杀重启替代更新。
- 更新前后 runtime.instanceId 均为 `91ea737a142a92b357fc598253d680c0`，runtimeId 均为 `bbcbf999098b64050e76ee53`，sessionId 均为 `2c408399-e1db-4dc9-b552-1ca7fecc8aeb`，shell PID 均为 34913。更新后实际输入输出 `AFTER_UPDATE=preserved PID=34913`，证明原 shell 内存变量存活。
- 更新后点击红色关闭窗口按钮，App PID 49774、内核 PID 33570、shell PID 34913 均存活；LaunchServices 再打开后继续操作。Cmd+W 是关闭终端 Tab，不用作关窗验收。
- 无活终端登出实机已验证：runtime socket、credentials.json、session-token.bin 消失，云端本机 terminalCount 为 0、设备离线；同账号再登录可接入同一设备。
- 新增 `scripts/verify-desktop-account-lifecycle.mjs`：真实中心和两台 daemon 下，离线退出清除本机凭据/terminal-data，组件重建后恢复联网、清空 outbox；云端本机任务删除，旧客户端 token 返回 401，另一设备任务仍运行，项目文件原样保留。已实际执行通过。脚本是组件集成验收，未冒充 GUI/safeStorage 验收，也未改变黑盒测试的边界。
- 可复用实机流程见 [桌面生命周期隔离验收](../../docs/desktop-lifecycle-acceptance.md)。更新日志 `/tmp/coflux-update-app.log`、内核状态 `/tmp/coflux-update-after.json`、账号集成日志 `/tmp/coflux-account-lifecycle-acceptance.log` 为本机补充证据。

### 最终实机验收与补修
- 主应用权限已实证：用户授权并完成 Touch ID，仅添加 `Coflux Acceptance.app`，未给 Supervisor 授权。原 PID 34913 授权前返回拒绝，授权后 `FDA_GRANTED_EXIT=0`；再次通过 Squirrel 更新 0.1.8 → 0.1.9 后，仍为 `FDA_AFTER_UPDATE=0 STATE=preserved PID=34913`。只检查目录可访问性，不读取文件内容。
- 用户协助操作菜单后，已看到真实的活终端登出确认，取消后原终端继续存活。确认时实机发现退出竞态：终端已结束，但 UDS 的 EOF 使应用未完成凭据清理。已修复并新增 3 个 UDS 回归测试，覆盖停止回执丢失、后续状态响应丢失和新实例保护；修复包 0.1.11 已实机复验：用户确认登出后回到登录页；新 shell PID 81953 结束，runtime.sock、credentials.json、session-token.bin、terminal-data 均不存在，云端本机终端为 0、设备离线。结果保存于 `/tmp/coflux-logout-acceptance-result.json`。
- 同时修复 FDA 状态沿用旧内核启动缓存的误报，以及恢复连接后旧错误阻止更新的问题。修复包菜单已不再误报未授予权限。
- 补修验证：桌面类型、116 个单测和构建通过；服务类型通过；全量黑盒 316/316（222.0 秒），Rust 构建零警告。

### 交付边界
- 本次使用 Apple Development 签名完成实际应用更新、主应用权限归属与生命周期验收；没有执行 Developer ID 正式发版、公证、市场发布或生产部署。它们属于后续发布检查，不影响已完成的本地架构验收。
- CLI 当前覆盖原 Agent 的核心工作区/终端能力及账号发现，不表示项目导入、文件浏览、实时交互等全部 GUI 功能都已有 CLI 命令。

方案的本地完成条件已满足，标记 DONE。保留工作区与本地提交供审阅，不推送或创建 PR。
