# 在终端中打开 Codex / Claude Code

桌面工作区点击 Tab 栏的「新增 → Codex / Claude」，或空态中的对应按钮。Coflux 创建普通 PTY Tab，直接启动设备上的 Codex CLI 或 Claude Code。对话、审批和其他交互由 Agent 原生终端界面提供。

输入、终端渲染、滚动、接管与断线重连全部沿用已有 TerminalPane。切换 Tab、浏览器断线和 worker 热重启不会重启 Agent；关闭 Tab 会结束进程。Agent 自己退出后，点击「重新打开」会再次启动同一 Agent。Coflux 不保存或自动恢复 Agent 对话 ID，需要选择历史时使用相应 Agent 的原生命令。

设备需已安装并配置相应 CLI。启动时经过设备的 login shell 查找 PATH；找不到时终端会提示。可由本机管理员设置 `COFLUX_CODEX_BIN` / `COFLUX_CLAUDE_BIN` 为相应可执行文件路径，网络请求只能选择固定的 `codex` / `claude` launcher。登录和权限由 Agent 自己处理，Coflux 不安装、不代登录、不修改 Agent 全局配置。

Task 的 `launcher` 保存启动方式，空串兼容历史普通终端。worker 在 prepared 操作授权后生成启动脚本，让 Agent 直接继承 PTY 的 stdin/stdout/stderr，不经过日志管道。设备需要支持对应 `codex_terminal` / `claude_terminal` 能力的 worker；**不需要修改或重启 supervisor**。旧 worker 会被能力门禁明确拒绝。

首版不提供独立聊天面板或 App Server 协议。移动端没有新增入口，已有终端仍能显示这些会话。

验收：`tests/src/codex-terminal.test.mjs` 使用隔离的终端程序验证三个标准流都是 TTY、工作目录/归属、幂等创建、输入、重连、worker 重启及退出重开。测试不访问模型或用户配置。

## CLI 与 MCP

遵循已有分工：同工作区使用 `cofluxd terminal new --launcher codex` 或 `cofluxd terminal new --launcher claude`，调用方必须属于 Coflux PTY，工作区由进程身份继承。跨工作区、跨设备或从 Coflux 外部接入时，使用现有 MCP `create_terminal({ workspaceId: "...", launcher: "codex" })`。

`launcher` 与命令参数（CLI 的 `--cmd`、MCP 的 `command`）互斥。读取、输入、等待和停止复用已有终端接口；Agent 的输出从终端快照读取，普通命令仍保留命令日志。MCP 的 `launcher` 同样支持 `claude`。两条入口都会保存启动方式，供桌面端重新打开。
