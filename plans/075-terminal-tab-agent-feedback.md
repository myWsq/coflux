# Plan 075: 终端 Tab 栏的 agent 运行反馈——icon 与标题一眼可辨

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 49142d1..HEAD -- proto crates/supervisor/src crates/worker/src/device.rs apps/server/src/hub.ts apps/server/src/store.ts packages/client/src/store.ts apps/web/src/components/workbench/workspace-terminal.tsx tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `49142d1`, 2026-08-15

## Requirement

用户痛点：plan 073 把 agent 活动状态带进了侧栏，但**终端 tab 栏毫无反馈**——
tab icon 永远是中性终端图标，tab 标题永远是「终端 N」。一个工作区开多个 tab 时，
看不出哪个 tab 在跑 claude、跑的是什么事。

**做完之后为真**：

1. **icon**：tab 对应 session 的进程树里检测到 agent（既有 `sessionAgents`
   presence）时，tab icon 从 `SquareTerminal` 换成 agent 图标（claude/codex 可区分），
   颜色跟随 hook 回合状态、与侧栏 ActivityDots 色语义一致（active 绿 /
   approval·question 琥珀）；attaching 转圈与 detached 插头的既有优先级不变。
2. **标题**：PTY 里的程序经 OSC 0/2 转义序列设置的终端标题（Claude Code 的自动
   会话标题正是此机制）显示为 tab 标题，覆盖 `task.title`。**没打开该 tab（未
   attach）也更新**（≤2s，走中心广播）、**页面刷新后依然成立**（订阅补发存量
   checkpoint）；session 退出后回落 `task.title`。这是通用终端行为：vim/ssh/shell
   设置的 OSC 标题同样生效，不做 agent 专属过滤。

判断「相邻的错误解法」——以下三条路径已探明并排除，不要退回去：

- **不是** web 端 xterm `onTitleChange`：非激活 tab 不 attach、收不到字节
  （`workspace-terminal.tsx` 的 attach 门控）；且 attach 回放的是 vt100 规范化
  snapshot，OSC 已被剥掉（`crates/supervisor/src/sessiond.rs` `render_normal_snapshot`），
  刷新即丢——073 时用户已拒绝过同构的「刷新即丢」方案。
- **不是**经 hook 信使上报：Claude Code hook 的 stdin JSON 没有标题字段（查过
  官方文档 common fields），transcript JSONL 里也没有稳定的标题存储（本机实证：
  活跃会话文件里无 summary 行，grep 到的 "summary" 是 SendMessage 工具参数）。
- **不是** worker 侧扫输出字节：无人 attach 时字节不流经 worker，只有 dirty
  通知（`crates/worker/src/main.rs:640` 注释），盲区与前端方案同构。

## Decisions & tradeoffs

- **捕获点 = sessiond 的 vt100 回调**。sessiond 本来就逐字节解析全部 PTY 输出
  （scrollback/snapshot 都靠它，与 attach 无关），OSC 0/2 现在在 vt100 内被解析后
  丢弃；用 `Parser::new_with_callbacks` + `Callbacks::set_window_title` 接住即可，
  热路径零新增扫描。**这打破了 073/074 守住的「supervisor 不动」纪律，用户已在
  departure check 知情拍板**（代价：supervisor 发版会断所有 daemon 的活 PTY）。
  Rejected: 见 Requirement 的三条相邻错误解法。
  Based on: `crates/supervisor/src/sessiond.rs:103-116`（`TerminalState::new` 用无
  回调构造）；vt100 0.16.2 `src/perform.rs:198-208`（OSC 0 同时触发
  icon_name+title 回调，OSC 2 只 title——所以只实现 `set_window_title` 即覆盖 0/2）。

- **上报通道 = 既有 SessionSnapshot→SessionCheckpoint 链路加 `title` 字段，不新增
  消息**。title 变化必然由输出引起 → 必有 dirty 通知 → ≤2s 内必有 checkpoint 上报；
  server 广播 + 订阅补发存量已就绪，client store `sessionCheckpoints` 已按
  sessionId 键控且随 sessionId 清除而清除——链路每一环都是现成的。
  Rejected: 挂 `SessionAgentRef.title` —— 标题是 VT/session 事实，与 agent presence
  生命周期无关（vim 设的标题也要显示；agent 退出瞬间 presence 消失但标题应随
  checkpoint 存续）。
  Rejected: 独立 title 通知消息 —— 多一条消息不多一分价值。
  Based on: `proto/coflux/v1/device.proto:285`（DeviceSessionSnapshot）、`:522`
  （SessionCheckpoint，client/daemon 两面共用同一消息）；`crates/worker/src/device.rs:1184`
  （worker 组装 checkpoint）；`apps/server/src/hub.ts:560/592`（校验+广播）、
  `hub.ts:1180` 附近（订阅补发）；`packages/client/src/store.ts:552-556/531-533`。

- **向后兼容 = proto 加字段、不 bump 版本**。旧 supervisor 不报 title → 空串 →
  UI 回落现状；`buf breaking` 须过（072/073 同惯例）。
  Based on: proto3 新增 string 字段默认空，序列化向后兼容。

- **server 侧 title 随 checkpoint 落库**，schema 变更走 `migrate()` 的
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 既有模式。长度钳制在 sessiond 侧
  源头截断（UTF-8 安全，上限执行者定、量级 256 bytes），server 校验兜底
  （不可信字节，超限整条拒收或截断均可，但拒收会连 ansi_snapshot 一起丢——
  选截断更稳）。
  Based on: `apps/server/src/store.ts:454-457`（migrate 模式）、`:404`
  （session_checkpoints DDL）、`:1087`（upsert 以 snapshot_seq 前进为条件——title
  随输出前进天然满足，无需独立比较）。

- **web 显示语义**：tab 标题 = `checkpoint.title` 非空 ? 它 : `task.title || "终端"`；
  悬浮 Tooltip 显全文（设计约定：不用原生 title 属性）。EXITED 时 task.sessionId
  被清空、client 侧 checkpoint 条目随之删除 → 自动回落，无需专门代码。**不写回
  `task.title` 落库**。
  Rejected: OSC 标题写回 task.title（新增改名消息）—— 把易变 VT 状态写进持久
  Task 实体，且「手动改名」是另一个需求，不在本次范围。
  Based on: `apps/web/src/components/workbench/workspace-terminal.tsx:487`（现标题
  渲染）、`packages/client/src/store.ts:531-533`（sessionId 移除时清 checkpoint 条目）。

- **icon 数据源 = 既有 `sessionAgents[task.sessionId]`，纯 web 改动**。claude 用
  自绘星芒（sunburst）小 SVG 组件，codex 用可区分的另一图形（lucide 现有或自绘，
  执行者定）；颜色语义对齐侧栏（active=success、approval/question=warning、
  done/无 state=中性）。attaching/detached 图标优先级保持在 agent 图标之上。
  Based on: `workspace-terminal.tsx:480-486`（现 icon 渲染分支）、
  `packages/client/src/store.ts:125`（presence 数据已达 client）、
  `sidebar.tsx:315-330`（侧栏消费方式与色语义参照）。

- **apps/mobile 一行不动**（冻结纪律）；iOS 原生 app 不在本次范围（checkpoint
  链路带 title 后它将来自然可用）。

## Direction

### Milestone 1: 协议字段就位

`DeviceSessionSnapshot` 与 `SessionCheckpoint` 各加 `string title` 字段，
`buf generate` 重新生成（TS/Rust/Swift 三处产物都提交）。
Validation: `cargo build -p coflux-supervisor -p coflux-worker`（零警告）+
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 2: sessiond 捕获 OSC 标题

TerminalState 经 vt100 回调持有最新标题（源头截断），SessionSnapshot 响应带出。
新增单测覆盖：OSC 0 与 OSC 2 都能设、超长截断在字符边界、无 OSC 时为空、
分 chunk 喂入不碎（沿既有 chunk-boundary 测试风格）。
Validation: `cargo test -p coflux-supervisor` -> exit 0。

### Milestone 3: worker 转发 + server 校验落库广播

worker 把 snapshot 里的 title 装进 checkpoint；server 校验（长度/类型）后随
checkpoint 落库（ADD COLUMN IF NOT EXISTS）、广播、订阅补发均含 title。
Validation: `cargo build -p coflux-worker` + server tsc -> exit 0。

### Milestone 4: web tab 栏呈现

icon 按 presence 换 agent 图标+状态色；标题按 checkpoint.title 覆盖显示 + Tooltip。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0。
UI 视觉不做自动化走查（用户人工验收惯例）。

### Milestone 5: 黑盒验收

新用例：黑盒终端里 printf OSC 0 标题序列 → 断言 client store 的
checkpoint.title ≤ 数秒内到达且刷新重连后补发仍在；参考
`tests/src/agent-activity.test.mjs` 的结构，照惯例做负向验证（临时抽掉
server 侧 title 透传确认用例真的会红）。
Validation: `pnpm -C tests test` -> 新用例过，全量无新增失败（既有
cli-doctor 环境基线失败除外）。

## Landmines

- `hub.ts:592-600` `sendCheckpoint` 是**手工逐字段复制**——proto 加了字段这里
  不加，client 永远收到空 title，且类型上不会报错。订阅补发路径（`hub.ts:1180`
  附近）同样检查。
- vt100 0.16.2 `Parser::new_with_callbacks` 把 callbacks **移进** parser；读回
  title 需要确认 crate 是否暴露 callbacks 访问器，没有就用 `Arc<Mutex<...>>`/
  `Rc<RefCell<...>>` 共享内层状态。另确认 sessiond resize 路径是否重建 Parser
  （重建则 title 要迁移）。
- `DeviceEnvelope.protocol_version`（supervisor↔worker UDS 双向）——核实版本
  校验是严格相等还是 ≥：若严格相等且要 bump，旧 worker/新 supervisor 混跑期会
  断联，须按现状语义处理，不要顺手 bump。
- OSC 标题是**不可信用户数据**：server 侧校验，web 只做文本渲染（React 默认
  转义即可），绝不 dangerouslySetInnerHTML。
- checkpoint 是 2s 周期缓存（`CHECKPOINT_INTERVAL`），标题到 UI 有 ≤2s + 广播
  延迟；黑盒断言与人工验收都别把这当 bug。
- `buf breaking` 检查须过；三处生成产物（`packages/protocol/src/gen`、
  `crates/protocol/src/gen`、`proto/gen/swift`）都要一并提交。
- 黑盒全套大面积超时先查 Docker 半死（`docker ps`），别当代码回归；本机测试
  PG 就是 5432。

## Scope

In scope:

- `proto/coflux/v1/device.proto` 及三处生成产物
- `crates/supervisor/src/sessiond.rs`（如实现需要，`sessions.rs` 的 snapshot 装配处）
- `crates/worker/src/device.rs`
- `apps/server/src/hub.ts`、`apps/server/src/store.ts`
- `packages/client/src/store.ts`（如需类型透传；协议类型自动到位则不动）
- `apps/web/src/components/workbench/workspace-terminal.tsx`（及新增的小图标组件文件）
- `tests/src/`（新用例）
- `plans/README.md`

Out of scope:

- `apps/mobile` —— 冻结纪律，一行不动
- `apps/ios` —— 不在本次；链路就位后它自然可跟进
- `apps/web` sidebar —— 073 已完成，本次不动
- Task 改名/`task.title` 写库 —— 另一个需求
- 发版（git tag / push）—— 不在授权内；生产生效需下一个 tag 且 **supervisor
  更新要求 daemon 重启（活 PTY 断一次）**，由用户择机执行

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| supervisor 单测 | `cargo test -p coflux-supervisor` | exit 0 |
| 协议单测 | `cargo test -p coflux-protocol` | exit 0 |
| server 类型 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| 黑盒 (acceptance) | `pnpm -C tests test` | 新用例过，无新增失败 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 黑盒里 OSC 0/2 设置的标题在未 attach、且模拟重连（订阅补发）后仍能从
      client store 读到。
- [ ] tab icon 在 presence 存在时切换为 agent 图标且状态色正确（人工验收）。
- [ ] 新黑盒用例做过负向验证（抽掉透传后确实变红）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- vt100 0.16.2 的回调机制无法在不升级 crate 大版本的前提下拿到 title。
- `DeviceEnvelope.protocol_version` 被证实为严格相等校验且必须 bump 才能加字段。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 这是 073/074 之后 supervisor 的**首次功能性改动**：发版时活 PTY 会断，
  RELEASING 流程与 changelog 里要明示；此后 supervisor 仍回归「极少升级」纪律。
- 标题语义是「通用终端标题」而非「claude 标题」：用户 shell 若配置了 precmd
  OSC（如 oh-my-zsh），tab 标题会跟随 cwd/命令变化——这是有意行为，与真终端
  （iTerm/Ghostty）一致，不要当 bug 修掉。
- iOS 若要跟进，从 `SessionCheckpoint.title` 直接取即可，daemon/server 无需再动。
