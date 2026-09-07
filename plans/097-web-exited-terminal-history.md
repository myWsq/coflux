# Plan 097: web 端已退出终端回放最后输出——停止态 Tab 不再空白、不再一点就悄悄重开 shell

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5d43adf..HEAD -- proto/coflux/v1/client.proto packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated apps/server/src/hub.ts packages/client/src/store.ts apps/web/src/components/workbench/workspace-terminal.tsx apps/web/src/components/workbench/terminal-pane.tsx tests/src plans`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none（消费 074 的中心 checkpoint 按 task 保留、091/094 的 daemon 命令日志与 `readTerminalForAccount` 三层读取，均已上线）
- Category: feature
- Execution: self（出发检查 2026-09-07：用户「改吧」，写完 plan 立即执行；前端走查按惯例留给用户）
- Planned at: `5d43adf`, 2026-09-07

## Requirement

agent 经 MCP `create_terminal` 或 `cofluxd terminal new` 开的命令终端，一两秒就跑完退出。用户在 web 侧栏点开
这个 Tab，看到的是一片空白的新 shell，命令输出从未在 web 上出现过——2026-09-07 用户亲历后判断「历史记录有必要
保留」。根因有两层：web 对停止态（EXITED）任务的 Tab 激活逻辑是「清空画面 + 起新 shell」
（`apps/web/src/components/workbench/workspace-terminal.tsx:257-262`），这对用户手开的 shell 合理，对「跑一条
命令」的终端等于把结果扔掉；同时 web 从没有任何读取历史输出的通路——中心早已按 task 保留最近一屏 checkpoint
30 天（plan 074），daemon 侧命令终端另有完整日志（plan 091/094），但两者只服务 agent 的 read，web 只拿
checkpoint 做了 Tab 标题（plan 075）。

**做完之后为真**（消费者 = 桌面 web 用户）：

1. **停止态 Tab 激活即回放，不重开 shell**。点开一个 EXITED 任务（或工作区打开时自动选中它），面板显示该任务
   最后的输出：命令终端是完整命令日志的尾部，用户手开的 shell 是退出前最后一屏。画面末尾追加一行系统提示
   「进程已退出（退出码 N）」；没有任何可回放内容（刚建就退、checkpoint 已过期）时只显示这行系统提示。
2. **重开 shell 是显式动作**。停止态且为当前 Tab 时，面板顶部出现一条横幅（与既有「已被其它客户端接管」横幅
   同形）：文案说明「此终端已退出，画面是最后的输出」，右侧按钮「重新打开」；点按钮才走原来的清空 + 起新 shell
   路径。IDLE 任务（刚创建尚未启动）的激活行为不变：仍自动启动。
3. **看着它退出时不丢滚屏**。面板已 attach、亲眼收到过本轮会话输出的，退出瞬间只在画面末尾追加同一行系统
   提示，不清屏、不用历史覆盖（历史内容只是当前画面的子集，覆盖会丢 scrollback）。
4. **回放来源经中心一次请求拿到**。web 只在激活停止态 Tab 时发一次读取请求，不对侧栏里所有停止态任务预取；
   同一轮退出（task.updatedAt 不变）只取一次，再次切回该 Tab 不重复请求。
5. 用户手开终端、检出分支、端口转发、接管等既有行为零变化；apps/mobile 不加功能但构建仍过；daemon 二进制零改动。

**相邻的错误解法**：不是把命令终端跑完就自动删 Tab（用户明确要保留历史）；不是让 web 直接调 MCP（要 OAuth，
且 MCP 是 agent 面）；不是让 daemon 在退出时把日志整段推给中心（违反「中心只转发 opaque bytes，可见数据面只有
派生 checkpoint」的纪律，`apps/server/src/hub.ts:16`）；不是改 checkpoint 周期让秒级命令也进 checkpoint
（plan 074 已否决，日志层就是为此而设）。

## Decisions & tradeoffs

- **新增一对客户端消息 `TaskRead`（client→server）/ `TaskReadResult`（server→client，仅回给发起连接）**：请求带
  `task_id` 与可选 `max_bytes`；结果带 `task_id`、`data`（bytes）、`source`（字符串 `log | snapshot | checkpoint | none`，
  与 `TerminalReadSource` 一致）、`captured_at`、`status`、`exit_code`、`error`。不带 request id：结果按 task 归属，
  同一 task 并发请求共享同一份回应，web 侧以 task 当前状态与 updatedAt 判定是否仍适用。
  Rejected: 走 `ServerError` 报错——会触发 web 的 `lastError` 效果清掉 launching 态（`workspace-terminal.tsx:455-463`），
  串扰无关任务；错误随结果自带。Rejected: 复用 `SessionCheckpoint` 广播——退出后 task.sessionId 已清空
  （`apps/server/src/store.ts:844`），且 checkpoint 没有命令日志。
  Based on: `proto/coflux/v1/client.proto:149-176, 301-329` 的 oneof 编号布局；`apps/server/src/hub.ts:287` 的来源枚举。

- **server 侧直接复用 `readTerminalForAccount`**：账号归属校验、daemon 优先（log → snapshot）、离线/不支持退回中心
  checkpoint、字节上限 256 KB 全部沿用，不另写一条读路径。Rejected: 只读中心 checkpoint——秒级命令的输出根本
  不在 checkpoint 里（plan 074 执行期记录）。
  Based on: `apps/server/src/hub.ts:3766-3800`；`apps/server/src/hub.ts:142`（`MAX_TERMINAL_READ_BYTES`）。

- **web 按来源决定写入方式**：`log` 是非 tty 的命令 stdout（`\n` 换行，plan 091 的 `tee`），写入 xterm 前把孤立
  `\n` 变成 `\r\n`（xterm 配置 `convertEol: false`，`terminal-pane.tsx:187`，不改全局配置）；`snapshot` /
  `checkpoint` 是规范化 ANSI 屏幕，先 `reset` 再原样写入。Rejected: 全局打开 `convertEol`——会改动活会话的
  PTY 输出语义。
  Based on: `apps/server/src/mcp/tools.ts:287` 对 log 数据做 `stripAnsi` 的假设（纯文本）；`terminal-pane.tsx:187`。

- **「看着退出」以「本面板收到过该会话输出」为判据**：`handleOutput`（`workspace-terminal.tsx:300`）是面板收到
  会话字节的唯一回调，据此记住 task→已见输出的 sessionId；退出时 task.sessionId 已为空，需在退出前记住上一
  个 sessionId。Rejected: 以 controlState 曾为 owned 判定——旁观（未 attach）也能收到输出，且 owned 不代表
  收到过字节。
  Based on: `terminal-pane.tsx:424-434`（consumer 收到数据即回调 onOutput）；`store.ts:844`（退出清 sessionId）。

- **停止态横幅复用 detached 横幅的结构与样式，按钮走 `Button` 组件**：与 `workspace-terminal.tsx:756-764` 同形，
  不新造组件；文案与图标遵循 `docs/design-guidelines.md`（lucide 图标、Tooltip 不用原生 title）。
  Based on: `workspace-terminal.tsx:756-764`。

- **`packages/client` 暴露 `readTask(taskId): Promise<…>`，超时 15 秒**：pending 按 taskId 去重共享；结果消息不进
  store state（大 bytes 不该常驻 zustand）。Rejected: 存进 store 让面板订阅——256 KB 级 bytes 会随每次
  setState 被浅比较传播。
  Based on: `packages/client/src/store.ts:584-592`（checkpoint 的 deliverSession 直投模式）。

- **黑盒测试新增 `tests/src/task-read-history.test.mjs`（PORT 8872）**：三条用例——①用户手开 shell 输出后退出，
  客户端 `taskRead` 拿到 `source=checkpoint`、内容含标记、`status=EXITED`、`exitCode=0`；②经 `cofluxd terminal new`
  的命令终端跑完退出，拿到 `source=log`、内容含标记、退出码正确；③不存在的 task 回 `error` 非空且不断连。
  Based on: `tests/src/agent-terminal-io.test.mjs:38-88` 的 `startDirTerminal` / `newAgentTerminal` 先例；
  `grep -h "PORT = " tests/src/*.test.mjs` 最高 8871。

- **协议生成物三处一并提交**：`buf generate`（`proto/` 目录，`clean: true`）会同时重生成 TS、Rust prost、Swift
  三份产物；Rust/Swift 只是多出未被消费的消息结构，daemon 行为零变化。
  Based on: `proto/buf.gen.yaml`；三处产物均已入库（`git ls-files`）。

## Direction

数据流：web 激活 EXITED Tab → `client.readTask(taskId)` → WS `taskRead` → hub `readTerminalForAccount` →
（daemon `terminalRead` 或中心 checkpoint）→ 单播 `taskReadResult` → client resolve → 面板按 source 写入 +
系统提示行；横幅按钮 → 既有 `startTask` 重开路径。

### Milestone 1: 协议 + server + client 包（可独立验证，不依赖 M2）

`client.proto` 新增两条消息并重生成三份产物；hub 处理 `taskRead`；`packages/client` 提供 `readTask` 并分发
`taskReadResult`；黑盒测试三条用例过。
Validation: `cd proto && buf generate && cd .. && git status --short proto packages/protocol crates/protocol packages/swift-client` -> 三处产物有 diff；
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；
`cargo build -p coflux-supervisor -p coflux-worker` -> exit 0 零警告；
`node --import tsx --test tests/src/task-read-history.test.mjs` -> 全过。

### Milestone 2: web 停止态回放 + 横幅 + 退出提示（依赖 M1 的 client API）

`workspace-terminal.tsx` 激活状态机区分 IDLE（自动启动）与 EXITED（回放）；新增显式重开；退出瞬间的系统提示；
`terminal-pane.tsx` 如需为回放增加控制器方法（写入已有 `writeSystem`，缺「写原始字节」则补）。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0；
`node_modules/.bin/tsc -b apps/mobile/tsconfig.json`（若存在该配置）-> exit 0。
UI 走查（acceptance）由用户完成。

## Landmines

- `performActivation`（`workspace-terminal.tsx:236-263`）对「非 RUNNING」一律 `startTask`，IDLE 与 EXITED 混在
  一起；createTerminal 的乐观 Tab 转正后依赖 IDLE 自动启动（`:412-420`），拆分时不能伤到这条。
- `workspaceTasks` 效果（`:392-437`）里「无 currentActive 时选第一个任务」会对 EXITED 任务发起激活：改后它应
  变成回放而不是重开——这正是用户打开工作区时被悄悄起 shell 的来源，属预期修复，不是回归。
- `taskReadResult` 可能晚于用户点「重新打开」到达：此时 task 已 RUNNING 或 updatedAt 已变，必须丢弃，否则会
  覆盖新 shell 的画面。
- 面板已 attach 时 `registerSessionConsumer` 的 `replace=true` 会 `terminal.reset()`（`terminal-pane.tsx:429`）；
  回放写入不能走这条 consumer 路径，要经 controller 直接写。
- `TerminalPane` 用 `display:hidden` 保活（`terminal-pane.tsx:447`），隐藏时 fit 为 no-op；回放写入后若 Tab 不可见
  不必 fit，切回时既有 rAF fit 会补。
- 中心 `acceptSessionCheckpoint` 只在 task RUNNING 时入库（`hub.ts:1410-1418`），退出后不会再有新 checkpoint；
  黑盒用例①要在 `exit` 前留出 ≥3 秒让 2 秒周期的 checkpoint 落库，否则 source 会是 none。
- `apps/mobile` 已冻结（AGENTS.md），共享 `packages/client`：只保证构建，不给它接回放。
- 本仓库 Bash 里写含 `git worktree add` 字样的文件会被插件 guard 拦（plan 095）；本 plan 文本已避开。

## Scope

In scope:
- `proto/coflux/v1/client.proto`
- `packages/protocol/src/gen/**`、`crates/protocol/src/gen/**`、`packages/swift-client/Sources/CofluxProtocol/Generated/**`（生成物）
- `apps/server/src/hub.ts`
- `packages/client/src/store.ts`（及 index 导出如需）
- `apps/web/src/components/workbench/workspace-terminal.tsx`、`terminal-pane.tsx`
- `tests/src/task-read-history.test.mjs`（新）
- `plans/README.md`

Out of scope:
- `crates/supervisor`、`crates/worker` 源码 — daemon 行为零改动，生成物 diff 不算
- `apps/server/src/mcp/**` — MCP read 不变
- `apps/mobile` 功能 — 冻结，只保证构建
- iOS `packages/swift-client` 行为 — 只有生成物
- checkpoint 周期 / 保留时长 / 日志容量 — 不调

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 协议生成 | `cd proto && buf generate` | exit 0 |
| server 类型 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| mobile 构建 | `node_modules/.bin/tsc -b apps/mobile/tsconfig.json` | exit 0 |
| daemon 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| 新黑盒 | `node --import tsx --test tests/src/task-read-history.test.mjs` | 全过 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | exit 0 |
| UI 走查 (acceptance) | 用户在 dev web 上：点 agent 开的已退出终端看到输出与退出码；点「重新打开」得到新 shell；看着 shell 退出不丢滚屏 | 用户确认 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 停止态 Tab 激活显示最后输出 + 退出码提示，不再自动起 shell；「重新打开」按钮才起。
- [ ] 看着退出的面板只追加提示不清屏。
- [ ] 三条黑盒用例存在且各自断言来源、内容标记与退出码。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- `readTerminalForAccount` 的签名或来源语义与 `hub.ts:3766-3800` 不符。
- `buf generate` 需要的远程插件拉不下来且无法离线生成。
- 黑盒用例①稳定拿不到 checkpoint（说明 checkpoint 入库条件已变）。
- 实现需要动 daemon 源码。

## Maintenance notes

- 以后要让停止态回放更完整（例如用户手开 shell 也留全量滚屏），改的是 daemon 侧「退出后保留日志」的策略，
  不是 web；web 只消费 `source`，新来源加进字符串枚举即可。
- `taskReadResult` 没有 request id，若将来需要同 task 多次不同参数的并发读取，再加 id，不要靠 updatedAt 硬判。
