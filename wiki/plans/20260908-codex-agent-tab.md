# Plan 20260908-codex-agent-tab：工作区中的 Codex 对话 Tab

## Status
- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: feature
- Execution: self；用户确认一路实现、验证和本地提交，不推送/合并/部署。
- Planned at: `3173ce2`，2026-09-08
- Drift check: `git diff --stat 3173ce2..HEAD -- apps/web apps/server packages/client packages/protocol proto crates tests docs`

## Requirement
在桌面工作区新增 Agent 类型 Tab，第一版仅 Codex。普通终端保持现有行为。用户从新增入口选择 Codex，看到空态与输入框；发送消息后在同一 Tab 持续对话，查看流式回复、工具调用及结果、回答问题、批准/拒绝执行并中断当前轮。Tab 和工作区显示运行/待处理状态；切换 Tab 或浏览器断线不结束运行。返回时可重建对话和待处理审批。未安装、未登录、不兼容或进程失败有明确错误，不能伪装成成功。

## Decisions & tradeoffs
- **结构化协议**：使用 Codex 官方 `app-server` JSONL 双向协议，而非解析终端画面或通过 shell 注入提示词。官方文档 https://developers.openai.com/codex/app-server；本机 `codex-cli 0.153.4` 的帮助已核对，实际握手与协议用例仍需验证。
- **持久会话身份**：Coflux Task 的类型与 Codex thread 身份明确区分；进程/连接/turn 不是对话身份。当前 Task 没有类型（`proto/coflux/v1/common.proto:57`），不可让 Agent Task 走 PTY attach。旧记录/旧客户端默认保持 terminal 语义，旧设备不支持时明确拒绝。
- **设备端运行与恢复**：持有 Codex 进程、连接、当前状态与审批的本地运行时不能依附可热替换的 worker；浏览器/worker 断线期间继续读流。中心只组织账号设备工作区任务，实时对话经既有 Device 通道。依据 `docs/architecture.md:32`、`:77`。运行时可以由 supervisor 管理；具体模块设计留给实现。
- **权限与重试**：保留设备 Codex 权限/登录配置，交互审批通过明确的 request ID 返回。拒绝未知请求、过期审批与跨工作区访问；重连不会自动重发不确定的用户消息或审批。实现须明确单控制端归属与重复操作行为。
- **历史与异常**：设备端保留 thread 关联与可恢复历史；活进程继续使用同一 thread，进程退出后通过原生 resume 恢复，不能把最后一轮重放作为恢复。未知结果保留为未知，不能声称任意故障下 exactly-once。
- **范围**：桌面 Web、文本对话、工具展示、审批/提问、中断、历史/重连是首版闭环；复用已有 Codex 安装与配置。Claude、图片附件、模型管理、自动安装/登录、跨 Agent 编排不在首版。UI 细节遵循 `docs/design-guidelines.md`，沿用 astryx。

## Direction
按依赖顺序串行完成：协议与任务类型 → 设备运行时/网关 → client 与 Web → 黑盒与实机验收。不拆并行工作包。
- 设备运行时可持有真实 Codex App Server，受工作区身份约束；工具状态与审批在重连后可恢复。验证：Rust 单元测试、构建。
- Task 创建和持久化区分 Agent/terminal；旧数据与客户端兼容。验证：server/client/web 类型检查、协议生成一致性。
- Agent Tab 完成创建、持续输入、流式展示、工具与审批、中断、重连。验证：Web/client 单元测试及构建。
- 黑盒在临时 HOME/数据库内用协议替身验证故障与隔离，再验证本机真实 Codex 协议。验证：相关及全量黑盒、浏览器验收。

## Landmines
- `apps/web/src/components/workbench/workspace-terminal.tsx:798` 当前给每个 Task 挂载 TerminalPane；Agent 必须排除 PTY 连接与终端快捷键。
- `crates/worker/src/agent_ctl.rs:5` 本地协同身份依赖 PTY 进程树；新运行时子进程如使用本地协同命令，必须正确纳入归属或明确拒绝，不能放宽成任意本机进程。
- `proto/` 为协议真相源，生成 TS/Rust/Swift；不能仅手改生成物。
- worker 热重启不能丢失正在等待的 Codex 审批；仅保存 thread ID 不足以恢复活会话。
- 不把未知 provider JSON 渲染为 HTML，不把凭据或全局配置通过前端/中心返回。

## Scope
In scope: `proto/`、`crates/{protocol,supervisor,worker}/`、`apps/server/`、`apps/web/`、`packages/{client,protocol,swift-client}/`、`tests/`、`docs/`、`wiki/plans/`；必要的 Cargo/pnpm manifests 和锁文件、构建/发版脚本及 CI 以交付运行时。
Out of scope: mobile 新功能、iOS 新界面、生产部署、Claude 插件交付、与本功能无关的清理。共享层影响 mobile/Swift 时仅兼容修复。

## Commands
- `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker`
- `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay`（零警告）
- `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`
- `pnpm -C apps/web build`、`pnpm test:web`
- `node --import tsx --test packages/client/src/*.test.ts`
- `cd proto && buf lint && buf generate`（生成产物一致）
- `pnpm -C apps/mobile build`
- `pnpm -C tests test`（acceptance，隔离数据库/进程）
- 浏览器交互与真实 Codex 握手（acceptance；不触碰生产服务或已有对话）

## Done criteria
- [ ] 新增与普通终端并存的 Codex Tab，完整文字对话/工具/审批/提问/中断可用。
- [ ] 重连恢复、worker 重启、重复操作、异常与账号/工作区隔离有测试证据。
- [ ] 验证命令通过，完整 diff 审阅，工作树干净，本地提交。
- [ ] 更新本计划和索引为 DONE，记录限制与验收证据。

## STOP conditions
需求前提不成立或无法保持运行/权限边界时明确报告，不以弱化验收替代；出现范围外必要修改先记录原因。不得启动生产升级。

## Maintenance notes
Codex 协议随安装版本变化：能力探测/版本错误需清晰；新增事件采用明确适配，未知审批不得隐式放行。App Server 官方页面的实验性字段不应无条件依赖。Advisor 指定 fable 不在当前宿主模型列表，无法派发，采用官方文档/源码核对与自身独立 diff 审阅。
