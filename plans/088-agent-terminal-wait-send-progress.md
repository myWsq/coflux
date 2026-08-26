# Plan 088: Agent 协同控制第二片——终端 wait/send 与进度短评

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat b0deda4..HEAD -- proto crates/worker/src apps/server/src/hub.ts packages/cli packages/client packages/swift-client apps/web apps/ios tests/src`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none（延伸 074，复议其第 1 条决策）
- Category: feature
- Execution: self
- Planned at: `b0deda4`, 2026-08-26

## Requirement

plan 074 给了 PTY 里的 agent「开」和「读」终端的能力，但留了两个日常刺痛点（对标同类产品
Orca 的 orca-cli skill 调研结论，2026-08-26）：

1. **等命令跑完只能轮询**：SKILL.md 现在教 agent「隔几秒 `list` 一次看它转没转 exited，别忙等」
   ——agent 每轮轮询都烧一次推理往返。要一条阻塞命令。
2. **终端开出去就管不了了**：命令要交互确认（y/N）、跑完想在同一 shell 里补一条，agent 都无能
   为力，只能弃掉重开。074 的「AI 无 PTY 写权」在第一片是对的极简边界，现在按其 Maintenance
   notes 的预告正式复议（复议范围见 Decisions 第 2 条，不是无限写权）。
3. **用户在卡片上看不到 agent 干到哪了**：活动状态（hooks 自动判定）只有"在干活/等交互"两个
   粒度；notify 的 message 语义是「卡住叫人」且任一 hook 事件即清空，装不下「复现了，正在定位
   relay 重连」这类进度播报。

**做完之后为真**——在 coflux 终端里跑的 agent 能：

```
cofluxd terminal wait <taskId> [--timeout <秒>]   → 阻塞到该终端退出，打印退出码；超时则明确报超时
cofluxd terminal send <taskId> --text "y" [--enter] → 文本写进该终端 PTY；若用户正接管则被拒且错误可读
cofluxd progress "复现了，正在定位 relay 重连"      → web 侧栏工作区行与 iOS 任务台卡片显示这句话，
                                                     直到被下一句覆盖或 agent 进程退出
```

SKILL.md 同步改写：等待用 `wait` 不再教轮询；`send` 的使用纪律（先 read 再 send、被拒即停）；
`progress` 与 `notify` 的分界（播报进度 vs 卡住叫人）。

判断「相邻的错误解法」：

- **不是**给 agent 无条件写权。用户正在接管时 send 必须被拒——人永远赢，agent 永不把人踢下线。
- **不是**旁路写入。写入必须走 supervisor 既有的 attach/holder/input_seq 正门，agent 是一个普通
  holder，不新增任何「非独占输入」语义。
- **不是**给进度做状态枚举/历史流水/落库。覆盖式单字段，纯展示，跟 073 presence 同生命周期。
- **不是**改 notify 的语义。notify（叫人、置 question、hook 事件即清空）与 progress（播报、
  跨 hook 事件存活）是两条信道。

## Decisions & tradeoffs

- **`wait` 是 CLI 内部轮询的阻塞封装，零协议新增**：CLI 循环调用既有 agent 动作（`terminal.list`/
  `terminal.read` 已回传 status/exitCode）直到 exited 或超时，agent 只看到一条阻塞命令。只等
  exit，不做 TUI 空闲启发式。Rejected: daemon 侧 long-poll 或 server 推送——为省几次 loopback
  轮询付一条新协议面，agent 可见收益为零。
  Based on: `crates/worker/src/agent_ctl.rs:168-185` terminal.read 经中心归属校验后回传
  status/exit_code；`packages/cli/cofluxd.mjs:762` `AGENT_TIMEOUT_MS = 30_000` 说明单次请求
  撑不起长等待，循环必须在 CLI 侧。

- **`send` 走 supervisor 正门，worker 作为本地 holder 写入；有人类 holder 时拒绝**：这是对 074
  第 1 条「AI 无 PTY 写权」的**受控复议**。074 当年否决的两个方案各自的否决理由仍然成立，本
  plan 都不碰：不抢正在看的用户的 holder（拒绝而不是踢人），不新增旁路输入（agent 经 worker
  以普通 attach/holder/input_seq 语义写入，exactly-once 契约原样适用）。归属寻址复用既有
  `terminal.list`/`terminal.read` 的中心校验结果（响应已含 session_id），send 目标限定为**本
  workspace 的终端**。Rejected: ①supervisor 加免 holder 写入口——supervisor 不走热升级，且
  「旁路非独占输入」正是 074 判为最贵的那条；②server 侧代发 input——输入数据面在 local-first
  重构后走 client↔daemon 通道，server 根本不在写入路径上。
  Based on: `crates/supervisor/src/sessions.rs:654` `apply_device_input(..., holder_epoch,
  input_seq, ...)` 是唯一写入口、`sessions.rs:584-585` attach 抢占会向旧 holder 发
  `holder_taken_over`；`crates/worker/src/device.rs:710,1346` worker 终结 client 设备通道、
  中转 SessionAttach/PtyInput——worker 是唯一既知道「现在谁在 attach」又能本地走正门写入的位置。
  **supervisor 目录零改动、holder/input_seq/attach 语义零改动，与 074 同款硬约束。**

- **进度短评是 `SessionAgentRef` 的新字段（下一个可用字段号 6），生命周期独立于 `message`**：
  跨 hook 事件存活，被下一次 `progress` 覆盖，agent 条目消失时一起消失；worker 侧钳制长度
  （对齐 message 的既有钳制）。复用 073/074 的 presence 通道：worker 置字段并触发一次
  SessionAgents 上报 → server `acceptSessionAgents` 既有广播/订阅补发透传 → 三端渲染。
  Rejected: ①复用 message 字段——`proto/coflux/v1/common.proto:114-116` 明写 message 在任一
  hook 事件到达即清空，进度会被 agent 自己的下一个 hook 事件抹掉，语义直接错；②新实体落库
  ——进度描述的是活着的工作，daemon 断开工作区本来就下线，落库只多出迁移与已读状态一堆新问题。
  Based on: `proto/coflux/v1/common.proto:105-118`（字段 1-5 已占用）；
  `apps/server/src/hub.ts:622` `acceptSessionAgents`；`packages/swift-client/Sources/
  CofluxClientCore/CofluxClient.swift:51` sessionAgents 状态已在 swift store 里。

- **`progress` 是独立子命令，daemon 本地闭环，无 server 新 RPC**：形如 `cofluxd progress
  "<一句话>"`，与 notify 同构（loopback → pid 反查 → 置字段 → 触发上报），但不改 state、不置
  question。Rejected: notify 加 flag——两种语义挤一条命令，SKILL.md 没法教清楚什么时候用哪个。
  Based on: `crates/worker/src/agent_ctl.rs` notify 动作现状；074 决策第 5 条的通路论证原样适用。

- **iOS 这次进场**：074 把 iOS 展示后置到「presence message 稳定后另议」，现在 presence 已跑过
  073/074 两片，本 plan 把进度短评带上 iOS 任务台卡片（swift-client 解码新字段 + reducer 透传 +
  卡片一行展示）。web 在侧栏工作区行展示（具体形态 executor 按 docs/design-guidelines.md 定，
  视觉验收交用户）。Rejected: 继续只做 web——iOS 是用户盯 agent 的主力端，进度短评的价值一半
  在手机上。
  Based on: `apps/ios` 目前零处引用 sessionAgents（grep 无命中），swift-client store 已就位。

- **前端展示不做 Claude 验证**：web/iOS 视觉交用户人工验收（仓库惯例）。构建与类型检查照跑。

## Direction

数据流（send 为例，wait/progress 更短）：

```
agent ──loopback──> worker
                     ├─ pid 反查进程树 → 定位发起 session（树外拒，074 既有）
                     ├─ 经中心校验目标 taskId 归属本 workspace，拿到 session_id（复用 terminal.read 通路）
                     ├─ 本地检查目标 session 当前 attach 状态：有人类 holder → 拒绝，错误可读
                     └─ 以普通 holder 语义经 supervisor UDS 正门 attach → input(seq) → 释放
```

### Milestone 1: `terminal wait`

CLI 新增 `cofluxd terminal wait <taskId> [--timeout <秒>]`（默认超时 executor 定，建议 20-30 分钟
量级——编码任务常跑很久）：内部循环查询，exited 时打印退出码并以 0 退出（命令本身成功），超时
时报可读错误并非 0 退出。帮助文本更新。
Validation: `node packages/cli/cofluxd.mjs --help` -> exit 0 且 wait 出现在帮助里。

### Milestone 2: `terminal send`（本 plan 的风险核心）

worker 侧实现「归属校验 → 人类 holder 检查 → 正门写入」；CLI 新增
`cofluxd terminal send <taskId> --text "<文本>" [--enter]`。拒绝场景错误信息可读且可区分：
目标不在本 workspace / 用户正在接管 / 终端已退出。
Validation: `cargo build -p coflux-supervisor -p coflux-worker` -> exit 0 零警告；
`git diff --stat b0deda4..HEAD -- crates/supervisor` -> 空输出。

### Milestone 3: 进度短评通路

`SessionAgentRef` 加字段 6；三侧生成产物同步（TS/Rust/Swift）；worker `progress` 动作 + 钳制 +
立即上报；server 透传；CLI `cofluxd progress "<一句话>"`。
Validation: `cargo test -p coflux-protocol` -> exit 0；
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；生成产物零 diff
（CI 同款 `git diff --exit-code` 于 proto 生成目录）。

### Milestone 4: web + iOS 展示

web 侧栏工作区行显示最新短评；iOS 任务台卡片显示最新短评（swift-client 解码 + reducer +
UI 一行）。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0；
`swift test --package-path packages/swift-client` -> exit 0；
`xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination
'generic/platform=iOS Simulator'` -> exit 0。

### Milestone 5: SKILL.md 改写 + 黑盒验收

SKILL.md：等待段落改教 `wait`；新增 send 纪律（先 read 再 send、被拒即停、人接管时把交互留给
人）；progress 与 notify 分界。黑盒新用例（独占新端口）：`wait` 等到真实命令退出并拿到退出码、
`send` 在无人接管时写入生效（终端输出可见回显/效果）、**有人类 attach 时 send 被拒**、
`progress` 经中心广播到 client 且跨 hook 事件存活、树外 pid 被拒沿用。新用例做负向验证
（抽掉对应 worker/server 逻辑后确实失败）。
Validation: `pnpm -C tests test` -> 除既有 `cofluxd doctor` 基线失败（×2）外全过。

## Landmines

- **074 的第 1 条决策被本 plan 显式复议，但它否决理由里的两条契约仍是硬约束**：不抢人类
  holder（`crates/supervisor/src/sessions.rs:584-585` 抢占即向旧 holder 发 detached）、不旁路
  input_seq exactly-once（plan 042）。send 的实现空间被这两条 + supervisor 零改动三面夹死，
  发现不可兼得就 STOP，别自创第四条路。
- `packages/cli/cofluxd.mjs:762` `AGENT_TIMEOUT_MS = 30_000`：wait 的长超时**不能**靠拉长单次
  agentPost 实现——daemon 控制 WS 往返有自己的 SERVER_TIMEOUT，循环必须在 CLI 侧，单次查询保持短。
- `proto/coflux/v1/common.proto:114-116`：`message` 字段「任一 hook 事件到达即被清空」。进度
  短评若复用它会被 agent 自己的下一个 Stop/Notification hook 抹掉——必须是独立字段、独立清空规则。
  worker 侧合并点在 `crates/worker/src/main.rs` `merge_hook_states` 附近，改动时别把 message 的
  既有清空规则弄丢。
- `packages/cli/skills/coflux/SKILL.md` 现在教「隔几秒 list 一次……别忙等」——M5 必须改掉这段，
  否则 skill 与新能力互相矛盾，agent 继续轮询。
- snapshot 有约 2 秒中心快照延迟（SKILL.md 已写明），但 status/exitCode 走 sessionExit 事件链
  不受此延迟影响——wait 判退出用 status，不要用「输出不再变化」推断。
- `cofluxd hook` 子命令绝不写 stdout（claude 把 hook stdout 当决策 JSON），而 agent 子命令必须写
  stdout——`packages/cli/cofluxd.mjs:759` 已有注释，新命令别放错边。
- 黑盒测试各 `*.test.mjs` 顶部 `const PORT` 独占端口，新用例必须选未占用的；harness 从不跑安装器。
- 「新 CLI + 旧 worker」的组合（CLI 随 npm 发版、worker 随 tag 热升级、节奏不同）：新命令打到旧
  daemon 必须是可读的拒绝（如「daemon 版本不支持，先 cofluxd update」），不是静默失败或超时。
- `swift test` 曾有 hosted 测试污染正式 Keychain 的坑，084 已隔离——新增用例沿用其隔离写法。

## Scope

In scope:
- `packages/cli/cofluxd.mjs`、`packages/cli/skills/coflux/SKILL.md`
- `crates/worker/src/**`（agent_ctl、device、main 及所需新模块）
- `proto/coflux/v1/common.proto` + 三侧生成产物（packages/protocol、crates/protocol、swift）
- `apps/server/src/hub.ts`（透传；send 归属校验如需扩展既有 case）
- `packages/client`（TS store 透传）、`apps/web`（侧栏展示）
- `packages/swift-client`（解码/reducer）、`apps/ios`（任务台卡片展示）
- `tests/src/` 新用例

Out of scope:
- `crates/supervisor/**` —— 硬约束零改动（同 074；supervisor 不走热升级）
- sessiond 的 holder / input_seq / attach **语义** —— 硬约束零改动（agent 是普通 holder，不加新语义）
- worktree/工作区创建、子 agent 编排 —— 缓议（dev-explore 2026-08-26 明确不做）
- 进度的状态枚举 / 历史流水 / 落库 —— 已否决（避免与 hooks 自动活动状态两套真相）
- `apps/mobile` —— 已冻结
- APNs 推送 —— 独立议题

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 黑盒集成 | `pnpm -C tests test` | 除既有 `cofluxd doctor` 基线失败（×2）外全过 |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| swift 包测试 | `swift test --package-path packages/swift-client` | exit 0 |
| iOS 构建 | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator'` | exit 0 |
| supervisor 零改动核实 | `git diff --stat b0deda4..HEAD -- crates/supervisor` | 空输出 |

web/iOS 视觉按本仓库惯例交用户人工验收，不做 Playwright/UI 走查。

## Done criteria

- [ ] All listed commands pass.
- [ ] 真实 session 里 `terminal wait` 阻塞到命令退出并打印退出码；`--timeout` 生效且报错可读。
- [ ] `terminal send` 无人接管时写入生效；用户 attach 期间被拒且错误可读；从未把人类 holder 踢下线。
- [ ] `cofluxd progress` 的短评经中心广播到 client，跨 hook 事件存活，被下一条覆盖。
- [ ] SKILL.md 不再教轮询等待，且写清 send 纪律与 progress/notify 分界。
- [ ] `crates/supervisor/` 零改动；holder / input_seq / attach 语义零改动。
- [ ] 新黑盒用例做过负向验证（抽掉对应逻辑后确实失败，其余照常过）。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- send 无法同时满足「supervisor 零改动」「走 attach/holder/input_seq 正门」「不踢人类 holder」
  三约束——STOP 报告，不要发明新输入语义。
- `crates/worker/src/agent_ctl.rs` 的既有 terminal.read/list 通路失效或语义已变。
- `SessionAgentRef` 字段 6 已被占用（并发改动撞号）。
- 任一验证命令在一次合理修复后仍连续失败两次。
- 需要改动 Out of scope 里的文件。

## Maintenance notes

- 本 plan 正式收窄了 074「AI 无 PTY 写权」的表述：现在的边界是「**人类优先的受限写权**」——
  人在场（attach）时 agent 永远只读。以后再扩 agent 能力（如 TUI 驱动、tui-idle 等待），先回到
  这条边界重新论证，而不是默认 send 的存在等于全量写权。
- 进度短评与活动状态是两个维度：状态永远 hooks 自动判定（单一真相），短评永远 agent 主动播报。
  谁想加「agent 手动置状态」都应该先读 dev-explore 2026-08-26 的否决理由（两套真相互相矛盾）。
- 生产生效节奏同 072/073/074：worker 改动随下一个 tag 热升级，CLI 随 npm 发版，server/web 随
  部署，iOS 随 TestFlight。首次上线注意四端版本组合的降级表现。
- wait 的默认超时若经常被撞上限，该想的是「agent 该不该开这么长的任务不看着」，不是无脑调大。
