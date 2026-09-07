# 在终端中打开 Codex

桌面工作区点击 Tab 栏的「新增 → Codex」，或空态中的「打开 Codex」。Coflux 创建普通 PTY Tab，直接启动设备上的 Codex CLI。对话、审批和其他交互由 Codex 原生终端界面提供。

输入、终端渲染、滚动、接管与断线重连全部沿用已有 TerminalPane。切换 Tab、浏览器断线和 worker 热重启不会重启 Codex；关闭 Tab 会结束进程。Codex 自己退出后，点击「重新打开」会再次启动 Codex。Coflux 不保存或自动恢复 Codex thread ID，需要选择历史时使用 Codex 原生命令。

设备需已安装并配置 Codex CLI。启动时经过设备的 login shell 查找 PATH；找不到时终端会提示。可由本机管理员设置 `COFLUX_CODEX_BIN` 为可执行文件路径，网络请求只能选择固定的 `codex` launcher。登录和权限由 Codex 自己处理，Coflux 不安装、不代登录、不修改 Codex 全局配置。

Task 的 `launcher` 保存启动方式，空串兼容历史普通终端。worker 在 prepared 操作授权后生成启动脚本，让 Codex 直接继承 PTY 的 stdin/stdout/stderr，不经过日志管道。设备需要支持 `codex_terminal` 的 worker；**不需要修改或重启 supervisor**。旧 worker 会被能力门禁明确拒绝。

首版不提供独立聊天面板或 App Server 协议。移动端没有新增入口，已有终端仍能显示这些会话。

验收：`tests/src/codex-terminal.test.mjs` 使用隔离的终端程序验证三个标准流都是 TTY、工作目录/归属、幂等创建、输入、重连、worker 重启及退出重开。测试不访问模型或用户配置。
