# Plan 023: web 终端拖拽小文件上传 —— drop 落 daemon 临时目录并注入路径

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7562f83..HEAD -- apps/web/src/components/workbench/terminal-pane.tsx apps/server/src/config.ts apps/server/src/index.ts crates/worker/src/ops.rs`

## Status

- Priority: P2
- Effort: S
- Risk: MED
- Depends on: none（复用 plans/014-terminal-image-paste.md 已落地的 fsWrite temp 管线）
- Category: feature
- Execution: agent:codex
- Planned at: `7562f83`, 2026-07-21

## Requirement

终端区域支持从系统文件管理器（Finder/资源管理器）拖拽小文件进来：`drop`
后把文件字节上传到 daemon 侧临时目录落盘，把 daemon 回带的绝对路径注入终端
输入行，类比现有的剪贴板贴图。目标体验对标 macOS Terminal 拖文件——只是
coflux 里浏览器与 daemon 不在同一台机器，路径无法本地直插，必须先上传。

完成后为真：
- 从 Finder 拖 1 个或多个文件到终端区域，松开后每个文件的 daemon 侧绝对路径
  按 shell 传参惯例、以空格分隔依次注入终端（`terminal.paste(\` ${path} \`)`）。
- 拖拽过程中终端区域有可见的"松开上传"高亮提示。
- 图片文件原样上传，拿到的路径指向的就是原图（不经压缩）。
- 单文件超 30MB 时拒绝并在终端给出系统提示，不上传。
- 未持有控制权时拖拽被拒绝并提示（与贴图一致）。
- 上传上限从 4MB（server）/ 8MB（daemon）/ 3.5MB（前端）统一放宽到 30MB。

## Decisions & tradeoffs

- **复用 fsWrite temp 管线，不做独立上传通道/分片**：拖拽走
  `sendFsWrite(workspaceId, name, bytes, temp=true)`（apps/web/src/client/store.ts:381）
  → daemon `临时目录/coflux-pastes/`（crates/worker/src/ops.rs:154-181）→ 回带
  绝对路径注入。Rejected: 分片上传 / 独立 HTTP 上传端点 —— 30MB 是安全余量、
  极少触顶（见下条），单消息 fsWrite 已够，独立通道属过度设计。
  Based on: 贴图管线 handlePaste `apps/web/src/components/workbench/terminal-pane.tsx:258-292`。
- **30MB 定位为安全余量而非常态**：故接受单条 30MB 消息与 pty 流共享同一条
  WebSocket 时的偶发短暂阻塞。Rejected: 保守留在 3.5MB / 激进做常态大文件传输
  架构 —— 前者会频繁拦截真实小文件，后者是另一个量级、当前无需求。
- **三处上限常量一致取 30MB**：前端拦截阈 = server WS 帧上限 = daemon 落盘上限，
  三者必须同值，任一偏小都会让前端放行的文件在下游被拒。
  `terminal-pane.tsx:37`(前端) / `apps/server/src/config.ts:81`(server) /
  `crates/worker/src/ops.rs:14`(daemon)。这层耦合须在代码注释里点明（参照 014 现有注释风格）。
- **前端上传上限与图片压缩预算是两个独立常量**：`PASTE_BUDGET_BYTES=3.5MB`
  是贴图的压缩目标，**保持不变**；新增独立常量（如 `MAX_UPLOAD_BYTES=30MB`）
  仅用于拖拽上传的前端拦截。Rejected: 把二者合并成一个 30MB 常量 —— 会让贴图
  压缩目标一并变成 30MB，截图不再被压缩、白白占带宽。
- **拖拽图片原样上传，不压缩**：拖拽语义是"传这个文件本身"，拿到的路径必须指向
  原文件。Rejected: 复用 `compressToBudget` 压缩图片 —— 会让路径指向被有损压过
  的图，违背拖拽预期。压缩仅保留给剪贴板贴图（截图语义）。
  Based on: `compressToBudget` 当前只在 handlePaste 内被调用 `terminal-pane.tsx:277`。
- **多文件：全部上传，路径空格分隔依次注入**：对齐 shell 多参数惯例。Rejected:
  只取第一个 / 换行分隔 —— 前者丢文件，后者会在终端触发多次执行。
- **文件夹忽略**：只处理 `dataTransfer` 里 `kind==='file'` 的真实文件条目。
  Rejected: 递归 `webkitGetAsEntry` 展开目录 —— 复杂度另一个量级，且与"小文件"
  语义无关。忽略即可，无需报错打扰。
- **未持控制权拒绝**：`!(active && controlState==='owned' && sessionId)` 时
  `writeSystem` 提示并中止，与 handlePaste 同一套逻辑 `terminal-pane.tsx:267-270`。
- **上传中提示**：30MB 级上传有耗时，`drop` 落定后先 `writeSystem("上传中…")`，
  以路径注入（成功）或错误提示（失败）收尾。贴图因压缩后极小未做此提示，拖拽需要。

## Direction

改动集中在一个前端文件 + 三处常量。沿用 terminal-pane.tsx 既有的命令式资源
挂载模式：drop/dragover 监听在 mount 时的 `useEffect(() => {...}, [])` 内注册一次，
通过 `liveRef.current` 读取当下的 `active/controlState/sessionId/workspaceId/sendFsWrite`
（组件已有此镜像机制，见 `terminal-pane.tsx:137-156`），卸载时在同一 return 清理。
监听挂在 `host`（xterm textarea 的祖先）上，与 handlePaste 一致。

拖拽视觉反馈用 React state 驱动一个覆盖终端区域的高亮遮罩（"松开上传"），风格
参照 `apps/web/src/components/workbench/workspace-terminal.tsx:535` 的 warning 提示带；
遵循 apps/web/.claude/CLAUDE.md 的 Astryx/token 约定（`bg-warning/10`、`border-warning/20`
一类 token 化 class，禁裸 hex/px）。

### Milestone 1: 三处上限常量放宽到 30MB 且一致

前端新增独立上传上限常量、server `maxPayload`、daemon `MAX_WRITE_BYTES` 三者同为
30MB，耦合关系在各处注释点明；`PASTE_BUDGET_BYTES` 3.5MB 压缩预算不变。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；
`cargo check -p coflux-worker` -> exit 0。

### Milestone 2: 拖拽上传交互

terminal-pane.tsx 新增 dragover/dragleave/drop 处理：dragover+drop 均
`preventDefault`；drop 读 `dataTransfer` 的文件条目、忽略文件夹、逐个原样上传
（图片不压缩）、路径空格分隔注入；超 30MB 拒绝；未持控制权拒绝；拖拽中显示
"松开上传"遮罩，上传耗时显示"上传中…"。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0。

## Landmines

- **daemon 拒绝非法单段文件名**：`safe_resolve_temp_target`
  （crates/worker/src/ops.rs:154-162）拒绝空 / `.` / `..` / 含 `/` 的名字。drop
  的文件名必须清洗成合法单段名（含空格、中文、特殊符号的原文件名会失败）——
  沿用贴图的 `drop-${Date.now()}-${rand}.${ext}` 生成式命名，或对原名做严格清洗。
- **`maxPayload` 是 client 与 daemon 两条 WS 共用**（apps/server/src/index.ts:47-49，
  `wssOpts` 同时喂给 `daemonWss` 和 `clientWss`）：提到 30MB 会放宽**所有**单条
  消息上限，不止 fsWrite。daemon 侧 30MB 写入检查兜底，风险可控但属全局约束放宽，
  注释需说明。
- **浏览器默认把拖入文件当导航**：dragover 与 drop 都必须 `preventDefault`，
  否则松手会用文件替换整个页面。
- **dragenter/dragleave 冒泡致遮罩闪烁**：子元素间移动会连续触发 leave/enter。
  用进入计数器，或用 `dragover` 持续置位 + `dragleave` 校验 `relatedTarget` 脱离
  host 再清除，避免遮罩抖动。
- **liveRef 闭包陷阱**：drop handler 在 mount 时注册一次，直接闭包捕获的 props 会
  是首帧旧值；必须经 `liveRef.current` 读最新状态（组件已有此模式，勿新开 effect
  重注册监听）。

## Scope

In scope:
- `apps/web/src/components/workbench/terminal-pane.tsx`
- `apps/server/src/config.ts`
- `crates/worker/src/ops.rs`

Out of scope:
- `apps/server/src/index.ts` — 只读 `maxPayload`，`wssOpts` 用法不改，仅其值随 config.ts 变动。
- 剪贴板贴图 handlePaste 与 `compressToBudget` — 压缩逻辑与 3.5MB 预算完全不动。
- 分片 / 独立上传通道、上传进度条 — 明确不做。
- 文件夹递归展开 — 明确不做。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| worker 构建检查 | `cargo check -p coflux-worker` | exit 0，零警告 |
| 真机拖拽 (acceptance) | dev 三端起齐后从 Finder 拖单文件/多文件/图片/超 30MB/未持控制权到 web 终端 | 人工确认 |

## Done criteria

- [ ] 所有非 acceptance 命令通过。
- [ ] 从 Finder 拖单文件到终端，松开后 daemon 侧绝对路径注入输入行。
- [ ] 拖多文件，路径空格分隔依次注入。
- [ ] 拖图片，路径指向原图（未压缩）。
- [ ] 拖超 30MB 文件被拒绝并有终端提示。
- [ ] 未持控制权拖拽被拒绝并有提示。
- [ ] 拖拽过程有"松开上传"高亮遮罩且不闪烁。
- [ ] 三处上限常量均为 30MB 且注释点明耦合；`PASTE_BUDGET_BYTES` 仍为 3.5MB。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] 未改动 scope 外文件（尤其 handlePaste/compressToBudget/index.ts 逻辑）。
- [ ] `plans/README.md` status 已更新。

## STOP conditions

- `safe_resolve_temp_target` 的文件名校验规则已变（ops.rs:154），命名策略需重定。
- `maxPayload` 已不再是 client/daemon 共用（index.ts:47-49 结构变化）。
- fsWrite temp 管线（sendFsWrite / ClientFsWrite / write_file temp 分支）已不存在或语义变更。
- 任一 validation 命令一次合理修复后仍连续失败两次。

## Maintenance notes

- 三处 30MB 是硬耦合：日后任一处调整上传上限，另两处必须同步，否则前端放行的
  文件会在下游被拒或触发 WS 帧超限断连。
- 若未来出现常态大文件传输需求，应转向分片/独立上传通道，而非继续抬高 `maxPayload`
  —— 后者会无差别放大所有 WS 消息的内存与阻塞成本。
- `PASTE_BUDGET_BYTES`（贴图压缩预算）与上传上限常量是两个独立旋钮，勿合并。
