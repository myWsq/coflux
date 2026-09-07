# Codex 终端入口

## 状态与范围
- Execution: self；实现、验证、本地提交，不 push/merge/deploy。
- 2026-09-08 用户明确要求：使用正常终端渲染，彻底删除结构化 Web 实现。原结构化方案已撤销。
- 基线：3173ce2；工作区 dev/20260908-codex-agent-tab。

## 需求
在现有工作区的新增菜单提供 Codex 入口，创建一个普通 PTY Tab 并直接运行设备上的 Codex CLI。显示、输入、审批、滚动、断线重连和控制权完全复用现有终端。普通终端不受影响。退出后显式重新打开仍启动 Codex。

## 方案
Task 只增加 launcher（空串 / codex），记录启动方式。中心保存并校验该值，要求 worker 声明 codex_terminal 能力；prepared sessionCreate 携带 launcher，worker 授权后转换为固定启动脚本，supervisor 按现有 shell 字段创建 PTY，无需新增运行时。

Codex 使用 login shell 找到设备上的 CLI，直接 exec 并继承 PTY 的三个标准流，不能经过日志管道。启动失败在终端显示；登录与权限完全由 Codex 自己处理。不接 App Server、不做聊天 UI、不新增 Agent RPC、不解析 TUI。

## 范围与验证
- 协议生成（Rust/TS/Swift）、server Task 存储/迁移、worker 启动脚本、web 新增菜单、相关测试与文档。
- mobile 无新增界面，共享 Task 仍然是兼容的普通终端。
- 黑盒：三个标准流都是 TTY、cwd/会话归属、重连与 worker 重启继续同一进程、重复 prepared 请求不重复启动、退出后重新打开、非法 launcher 被拒。
- 质量门：server tsc；web/mobile 构建；Rust build 与单测；client/web 单测；协议 lint/breaking/generate；Swift 测试；全量黑盒。
- 浏览器验收新增菜单、普通终端共存、Codex 在 TerminalPane 中输入。

## 完成条件
- [x] 普通终端中的 Codex 可启动、交互、重连和重开。
- [x] 结构化 Web / App Server 实现已全部撤销。
- [x] 测试与构建通过，文档更新，本地提交。

## 限制
不在 Coflux 层保存 Codex thread ID；关闭进程后的历史选择由 Codex 原生命令负责。设备需已安装并配置 Codex；首版不自动安装或登录。原 advisor 指定模型不可用，采用自身 diff 审阅。

## 验收记录（2026-09-08）
- Rust：protocol 42、supervisor 63、worker 107 项单测通过；daemon/relay 构建零警告。
- server 类型检查、Web/mobile 构建、client 60 项与 Web 13 项单测通过。
- 协议 lint、against 3173ce2 的 breaking 检查通过，TS/Rust/Swift 重新生成；Swift clean build 后 43 项通过。
- 全量黑盒 291/291 通过（146.8 秒）。默认 88xx 端口被其他工作区的遗留服务占用，因此测试副本保持同目录深度，将 88xx 字面端口映射到 188xx；断言与应用源码不变，副本已删除。未停止那些遗留服务。
- 新增 Codex 终端黑盒覆盖真实 TTY、cwd/归属、重投、输入、重连、worker 重启、退出重开及非法 launcher。
- 浏览器通过新增入口启动真实 codex-cli 0.153.4，显示原生欢迎/登录 TUI；临时 CODEX_HOME 不使用用户对话或认证。未进行模型调用。
- 旧结构化界面、Agent RPC、独立运行时及对应测试已撤销；当前 supervisor 源码与基线一致。

## 原有接口补充
- 根据用户要求，沿用本工作区 CLI、跨工作区/设备 MCP 的分工，只给原有创建终端接口增加 `launcher=codex`，其余终端接口复用。
- 范围包含 CLI 参数、本地 gateway、AgentTerminalNew 协议和 server/MCP；不增加独立 Agent 工具组。
- 黑盒覆盖 MCP 创建、读取、输入、停止及参数互斥；CLI 从真实 PTY 调用、继承工作区、保存 launcher 并保持三个标准流为 TTY。

## Claude Code 补齐
- 用户追加要求支持 Claude：桌面新增菜单与空态、CLI 和 MCP 沿用同一终端 launcher 链路，支持 `claude`。
- worker 声明独立 `claude_terminal` 能力，使用设备上的 `claude`（可用本机 `COFLUX_CLAUDE_BIN` 覆盖）；保留真实 PTY。
- 新增 migration 6 扩展 launcher 约束，保留已存在 migration 5 的定义，支持已有数据库升级。
- 同一套终端生命周期、CLI/MCP 黑盒分别在 Codex 和 Claude launcher 下执行。

## 补齐验收（2026-09-08）
- Codex、Claude 两组共 6 项终端生命周期及 CLI/MCP 黑盒专项通过。
- Rust protocol 42、supervisor 63、worker 107 项通过，构建零警告；server 类型检查、web/mobile 构建、client/web 共 73 项单测、Swift 43 项测试通过。
- 协议 lint、against 3173ce2 的 breaking 检查和三端生成通过。
- 真实 Claude Code 2.1.263 在隔离 HOME 的 PTY 中输出欢迎界面，随后 Anthropic platform 请求返回 403，未验收登录后的模型对话；未修改用户配置。
- 最终全量黑盒 296/296 通过（含迁移 ledger 版本 6 的预期）；沿用隔离端口副本验收，测试副本已清理。
