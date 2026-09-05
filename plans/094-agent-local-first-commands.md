# Plan 094: agent 本地命令 local-first——本地能闭环的操作零中心交集、修缺陷、日志汇有界、SKILL 两轨分工

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat ac19939..HEAD -- crates/worker/src packages/cli apps/server/src/hub.ts apps/server/src/mcp/tools.ts tests/src README.md`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none（接替已撤回的 093；074/088/090-092 均 DONE）
- Category: refactor + bug
- Execution: self（出发检查 2026-09-05：写完 plan 立即执行、中途不再向用户确认；STOP/BLOCK 仍停；push/PR/merge 不在授权内）
- Planned at: `ac19939`, 2026-09-05

## Requirement

用户 2026-09-05 定下原则：**本地能闭环的 agent 操作，不和中心有任何交集。** 跑在 coflux PTY 里的
claude/codex 只和本机 daemon 说话（`cofluxd terminal|notify|progress|ports`，零凭证、pid 反查身份）；
中心 MCP 只服务跨出本机的场景（别的机器上的 agent、开子工作区、跨设备）。plan 093 想把八条本地
命令收成中心 MCP 单轨，与这条原则直接矛盾，已撤回。

但 dev-explore 审出的缺陷是真的，要在保留两轨的前提下修：

- `wait`/`send` 靠 `terminal.list` 找目标，而 list 只回最近 50 条，终端多的工作区会误报「没有终端」；
- `send` 的归属校验、`wait` 的退出判定、`read` 的 status/checkpoint 都绕中心一趟，明明 daemon 本地都有；
- worker `/agent` 端点把所有 BadRequest 细节吞成 `bad request`，agent 拿不到原因；请求体上限 4 KB
  与 MCP 的 16 KB 命令上限不对齐；
- 两条建终端路径共用的命令日志 `tee` 落盘无上限，跑一周的 dev server 会无限增长；
- SKILL 的两轨分工写得像并列选项，agent 分不清什么时候该用哪个。

**做完之后为真**（消费者 = 跑在 coflux 终端里的 Claude Code / Codex）：

1. 八条本地命令全部保留，`cofluxd --help` 与今天一致。`hook` 子命令与活动状态判定零变化。
2. **`send`、`read`、`wait`、`notify`、`progress` 在 daemon 本地闭环**：这五条命令的处理过程中 worker
   不向中心发任何 `AgentControlRequest`，也不要求 daemon 此刻连着中心。归属校验（目标终端必须与
   调用方同工作区）、退出判定与退出码、终端内容（命令日志尾部，否则 sessiond 当前快照）全部来自
   worker 本地掌握的信息。中心断连时这五条照常工作；notify/progress 的效果在重连后随既有的
   presence 全量补发到达用户。
3. **`new`、`list`、`ports` 仍由 daemon 经自己的控制 WS 问中心**，agent 不感知：Task 要落库并广播给
   web/iOS，预览 URL 由中心生成，这三条本来就不是本地能闭环的。中心断连时它们明确报错，行为不变。
4. `wait`/`send`/`read` 按 taskId 直接寻址，不再受 list 的 50 条上限影响。目标已退出时 `wait` 立即
   返回退出码；目标不存在、不在本工作区、早于 daemon 升级而缺归属信息，都是可读错误。
5. `/agent` 的每一种拒绝（缺参数、超长、未知动作、体超限）agent 都能看到具体原因；命令上限与中心
   的 16 KB 对齐，单次 send 文本上限与 MCP 的 64 KB 对齐。`/hook` 的应答形态零变化。
6. 命令终端的落盘日志**有界、保留尾部、永不让命令收到 SIGPIPE、退出码照旧**；`read` 对跑了很久的
   dev server 仍返回最新尾部。
7. MCP `wait_terminal` 默认仍 30 秒，上限从 50 秒放宽到 600 秒，描述写明受宿主单请求超时约束；
   其余 13 个 tool 一字不动。
8. SKILL 改写：先看 `COFLUX_*` 变量判断在不在 coflux；**本地能闭环的一律本地命令，只有跨出本工作区
   才用 MCP**；本地命令段落不再写「约 2 秒延迟」这类已过时的说明；MCP 段落只讲跨机场景。
9. `crates/supervisor` 零改动，协议零改动。

**相邻的错误解法**（不是这个）：

- **不是**删任何本地命令，也不是给 MCP 补 notify/progress。
- **不是**用 cwd 去 WorkspaceList 里匹配来推断归属——归属只认中心随 SessionCreate 下发的 id。
- **不是**让 `wait` 长持一条 loopback 请求到 daemon 里等——CLI 侧继续轮询本地状态即可。
- **不是**改 `/hook` 的错误形态或安全边界。
- **不是** `head -c` / 定期 truncate 日志。
- **不是**改 supervisor、改 proto。

## Decisions & tradeoffs

- **worker 维护一份本地会话账本，归属校验与退出码全靠它**：session → {task_id, workspace_id, 状态,
  exit_code}，来源只有两处：中心下发的 SessionCreate（直发路径与 prepared 路径都带 `workspace_id`，
  plan 092 起）与 worker 自己经手的 SessionExit。已退出条目有界保留（数量/时长执行者定），供
  `wait`/`read` 在退出后查询。归属规则：调用方 session 与目标 session 的 `workspace_id` 相等且非空；
  任一为空（早于 daemon 升级的会话、热升级后新 worker 从 sessiond 目录学来的会话）一律可读拒绝
  「该终端早于 daemon 升级，重开后可用」。Rejected: ①继续问中心——违反本 plan 的原则；②cwd 匹配
  兜底——多一份可能与中心不一致的推断（074 同一理由）。
  Based on: `crates/worker/src/main.rs:1747-1808`（直发 SessionCreate 带 `workspace_id`）、
  `crates/worker/src/device.rs:2270-2323`（prepared 路径带 `workspace_id`）、`crates/worker/src/main.rs:978-994`
  （SessionExit 经 worker 且带 `exit_code`）、`crates/worker/src/observed.rs:15`（`alive` 只有 task+pid）。

- **账本与 `alive` 表分开，不给 `alive` 加字段**：`alive` 被 presence/端口扫描与 079 对账逻辑按
  `(task_id, pid)` 精确匹配，改它的形状会波及所有扫描；账本是独立的 map，只读 alive 的生命周期事件。
  Based on: `crates/worker/src/main.rs:909-1040`（退出与对账按 task_id+pid 匹配）、
  `crates/worker/src/agents.rs:52`、`observed.rs:241`（扫描直接消费 `alive`）。

- **五条本地命令不检查 `authed`**：notify/progress 只改 observed 并 `report_agents_if_changed`，断连
  期间上报失败无妨，重连后 `force_report_agents` 全量补发；send/read/wait 与中心无关。`new`/`list`/
  `ports` 保持「未连中心即明确报错」。
  Based on: `crates/worker/src/main.rs:1335`（重连后 `force_report_agents`）、`crates/worker/src/agent_ctl.rs`
  `ask_server` 的 `authed` 检查只保留给经中心的动作。

- **`wait` = CLI 轮询一个新的本地 `terminal.status` 动作**（3 秒一次，默认 30 分钟上限不变），
  status 来自账本。Rejected: daemon 侧长持等待——loopback 有 25 秒应答上限，还得分段，收益为零。
  Based on: `crates/worker/src/hook.rs` `AGENT_TIMEOUT = 25s`、`packages/cli/cofluxd.mjs` `WAIT_POLL_MS`。

- **`read` 内容顺序：本地命令日志尾部 → sessiond 当前快照（会话仍活着时）→ 空；status/exit 来自账本**：
  与 091 `handle_server_request` 的 TerminalRead 分支同一顺序，可复用其读法。永不向中心要 checkpoint。
  Based on: `crates/worker/src/agent_ctl.rs:484-538`（091 的读法）、`crates/worker/src/device.rs:1616`
  （`read_session_snapshot`）。

- **`/agent` 的 BadRequest 把细节回给 agent，`/hook` 保持原样**：`serve()` 对两条路径的错误渲染分开；
  `/agent` 的 400 体为 `{"ok":false,"error":"<detail>"}`。`/agent` 体上限提到足以容纳 64 KB send 文本
  加封包（建议 128 KB）；命令上限 16 KB 与 `apps/server/src/hub.ts` 的 `MAX_TERMINAL_COMMAND_BYTES` 同值；
  send 文本上限 64 KB 与 MCP 的 `MAX_TERMINAL_INPUT_BYTES` 同值。
  Based on: `crates/worker/src/hook.rs:121`（统一 `bad request` 体）、`:31`（4 KB 体上限）、
  `apps/server/src/hub.ts:134-135`。

- **命令日志汇的不变量：有界、保尾、永不断管道、退出码照旧**：只改 `write_command_script_named`
  这一处（两条建终端路径共用）；`write_operation_command_script` 的脚本路径派生规则不能动；命令退出码
  仍由脚本原样透传。保留容量不得小于 `read` 的读窗（256 KB）。已撤回的 093 在提交 `9354a71` 里做过一版
  worker 子命令式日志汇（`crates/worker/src/log_sink.rs`），满足不变量即可直接取用。Rejected: `head -c`
  （SIGPIPE）、周期 truncate（稀疏文件夹 NUL）、只留头部。
  Based on: `crates/worker/src/ops.rs:373`、`:337`、`crates/worker/src/device.rs:2044-2047`、
  `crates/worker/src/agent_ctl.rs:44`、`crates/worker/src/ops.rs:16`/`:159`。

- **MCP `wait_terminal` 默认 30 秒不变、上限 600 秒**：长持 HTTP 请求越长越脆，到期重调零成本；
  描述写明受宿主单请求超时约束（Claude Code 单请求计时 = max(60s, 服务器 `timeout`, `MCP_TIMEOUT`)，
  插件 `.mcp.json` 可设 `timeout`，见 Maintenance notes）。
  Based on: `apps/server/src/hub.ts:126-127`、`apps/server/src/mcp/tools.ts:59-60`。

- **协议零改动**：`AgentControlRequest` 的 `terminal_read` 分支从此无发送方，但按仓库先例（`buf breaking`
  FILE 类别）保留，不动 proto 文件、不动生成产物。
  Based on: `buf.yaml:8-9`、`proto/coflux/v1/common.proto:130`/`:139`（无发送方消息保留的先例）。

- **SKILL 两轨分工改成一条规则**：源文件仍是 `packages/cli/skills/coflux/SKILL.md`；结构：先看变量 →
  「本地能闭环的一律本地命令」→ 八条命令 → 「只有跨出本工作区才用 MCP」→ 14 个 tools → 边界。
  Claude Code 插件换成这份 SKILL 并带 `.mcp.json` 是配套任务（见 Maintenance notes）。
  Based on: `packages/cli/README.md:48-51`；plugins-builder 仓库里的插件 SKILL 是不含命令的旧版。

- **supervisor 零改动**：账本、日志汇、错误渲染全在 worker 进程内。
  Based on: plan 074 同名决策。

- **测试落在既有两套 CLI 黑盒里扩**：`tests/src/agent-control.test.mjs`、`agent-terminal-io.test.mjs`
  新增/改写：`wait` 对已退出终端立即返回退出码；`send`/`wait`/`read` 按 taskId 寻址不受 list 上限影响
  （可用多开终端超过 `MAX_AGENT_TERMINAL_LIST` 的方式，或把该常量经测试可控的方式验证，执行者定）；
  超长命令得到可读原因而非 `bad request`；日志超容量后 `read` 仍返回最新尾行且退出码正确；
  `mcp-write-tools.test.mjs` 加一条 `wait_terminal` 真等超过 60 秒不被中心掐断。
  Based on: `tests/src/agent-control.test.mjs:84-194`、`tests/src/agent-terminal-io.test.mjs:88-176`。

## Direction

```
agent ──POST /agent (pid)──> worker ── pid 反查 → 调用方 session
                                  ├─ send / read / wait(status) / notify / progress
                                  │     └─ 本地账本（归属、状态、退出码）+ 本地日志/快照 + observed
                                  └─ new / list / ports ──AgentControlRequest──> 中心（不变）
```

### Milestone 1: worker 本地闭环

会话账本就位（两条 SessionCreate 路径 + SessionExit 喂入，退出条目有界保留）；`send`/`read`/
新 `terminal.status`/`notify`/`progress` 全部本地完成且不看 `authed`；`/agent` 错误细节回传、体与
文本上限对齐；日志汇按不变量接进 `write_command_script_named`。
Validation: `cargo build -p coflux-supervisor -p coflux-worker` -> exit 0 且零警告；
`cargo test -p coflux-worker` -> exit 0；`git diff --stat ac19939..HEAD -- crates/supervisor proto` -> 空。

### Milestone 2: CLI 与 SKILL

`wait` 改轮询 `terminal.status`；`read` 与 `send` 按新应答形态工作；帮助与错误文案同步；SKILL 按
两轨分工改写；`packages/cli/README.md` 与根 `README.md` 的分工说明同步。
Validation: `node packages/cli/cofluxd.mjs --help` -> exit 0 且八条命令仍在。

### Milestone 3: MCP wait 上限

`wait_terminal` 上限 600 秒，常量、schema 上限、描述三处一致；SKILL 的「有界等待」段落同步。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: 黑盒

按 Decisions 最后一条扩用例，新用例做负向验证（抽掉账本归属判定 / 抽掉日志汇 → 对应用例变红）。
Validation: `pnpm -C tests test`（acceptance）-> 除既有 `cli-doctor` 基线失败 ×2 外全过。

## Landmines

- `crates/worker/src/ops.rs:373` `write_command_script_named` 被 `write_command_script`（074）与
  `write_operation_command_script`（091）共用；后者文件名由 `operation_id` 确定性派生（`device.rs:2044-2047`），
  改日志汇只动模板不动命名，`PIPESTATUS` 透传退出码的写法不能丢。
- `crates/worker/src/agents.rs:16` `AGENT_NAMES = ["claude","codex"]`，解释器规则看 `argv[1]` basename；
  日志汇进程在会话进程树里，可执行名与首参数别像这两个词。
- `crates/worker/src/hook.rs:121` `serve()` 对所有 BadRequest 统一渲染，改成按路径分流时 `/hook` 的
  400/404/200 形态不能变——`tests/src/agent-activity.test.mjs` 按它断言。
- `crates/worker/src/agent_ctl.rs:296-333` 现有 `TerminalSend` 先问中心 list 再本地写；`device.agent_send_input`
  （`device.rs:1566`）保留，只换归属来源。人类 holder 检查与 TOCTOU 说明不动。
- `crates/worker/src/main.rs:909-1040` 退出处理按 `(task_id, pid)` 匹配防止旧会话误报；账本的退出
  写入应挂在同一判定之后，不要按裸 sessionId 写。
- worker 热升级后新进程从 sessiond 目录学到的存活会话没有 `workspace_id`：账本对它们是空归属，本地
  命令会可读拒绝——这是既定语义，不要试图从 cwd 猜。
- `packages/cli/cofluxd.mjs` `hook` 子命令「绝不写 stdout」；其它命令必须写 stdout。`wait` 现在的
  循环调 `terminal.list`，改为 `terminal.status` 后错误文案里的「用 cofluxd terminal list 查」仍成立。
- `tests/src/agent-terminal-io.test.mjs` 的 wait/send 用例按现有输出文案断言（`# exited exit=…`、
  「用户正在接管」），改文案要同步。
- `wait_terminal` 超过 60 秒的长持请求要用真实 HTTP 用例证明中心不掐（Node `requestTimeout` 只管收
  请求体）；生产反代是否放行由用户部署后验证。

## Scope

In scope:
- `crates/worker/src/`（`hook.rs`、`agent_ctl.rs`、`main.rs`、`ops.rs`、`device.rs`、`observed.rs`；新增账本/日志汇模块）
- `packages/cli/cofluxd.mjs`、`packages/cli/README.md`、`packages/cli/skills/coflux/SKILL.md`
- `apps/server/src/hub.ts`（仅 `TERMINAL_WAIT_*` 常量）、`apps/server/src/mcp/tools.ts`（仅 wait 相关常量与描述）
- `README.md`（两轨分工说明）
- `tests/src/agent-control.test.mjs`、`tests/src/agent-terminal-io.test.mjs`、`tests/src/mcp-write-tools.test.mjs`
- `plans/README.md`

Out of scope:
- `crates/supervisor/`、`proto/` 及生成产物 — 零改动硬约束
- `apps/web/`、`apps/ios/`、`apps/mobile/` — 不改 UI
- MCP 其余 13 个 tool、`oauth.ts`、`/mcp` 接线 — 不动
- plugins-builder 仓库 — 配套任务
- `crates/worker/src/agents.rs` 探测规则 — presence 与 `/hook` 依赖

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| Rust 单测 | `cargo test -p coflux-worker` | exit 0 |
| supervisor/proto 零改动 | `git diff --stat ac19939..HEAD -- crates/supervisor proto crates/protocol packages/protocol` | 空 |
| Typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| CLI 帮助 | `node packages/cli/cofluxd.mjs --help` | exit 0，八条命令仍在 |
| 黑盒 (acceptance) | `pnpm -C tests test` | 除既有 `cli-doctor` ×2 外全过 |

## Done criteria

- [ ] All listed commands pass.
- [ ] `send`/`read`/`wait`/`notify`/`progress` 处理期间 worker 不发 `AgentControlRequest`（代码审查可见），且不检查 `authed`。
- [ ] `wait` 对已退出终端立即返回退出码；`send`/`wait`/`read` 不受 list 50 条上限影响。
- [ ] `/agent` 拒绝原因可读；命令 16 KB、send 文本 64 KB 与 MCP 对齐；`/hook` 应答形态不变。
- [ ] 日志有界保尾，超容量后 `read` 返回最新尾行、退出码正确。
- [ ] `wait_terminal` 上限 600 秒，黑盒里一次超过 60 秒的等待真实完成。
- [ ] SKILL 明确「本地能闭环一律本地命令，跨出工作区才用 MCP」，无过时说明。
- [ ] Required tests exist and assert meaningful behavior（新用例做过负向验证）.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed（supervisor、proto 零 diff）.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- 账本无法从既有 SessionCreate/SessionExit 路径拿到 `workspace_id` 或 `exit_code`（意味着需要改 supervisor 或 proto）。
- 日志汇的不变量在不改 supervisor 的前提下做不到。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- **配套任务（plugins-builder 仓库，独立跟踪）**：coflux 插件换成本仓库的新 SKILL；加 `.mcp.json`，
  `"url": "${COFLUX_MCP_URL:-https://api.coflux.dev/mcp}"`，每服务器 `timeout` ≥ 600000 ms；版本递增并
  发版。Codex 用户：SKILL symlink 到 `~/.codex/skills`，MCP 手动 `codex mcp add`。
- **生产生效节奏**：worker 随下一 tag 热升级；CLI 与 SKILL 随 npm `cofluxd` 发版；server 随部署。
  「新 CLI + 旧 worker」下 `terminal.status` 是未知动作，旧 worker 回 `bad request`——可接受的短暂
  组合，`cofluxd update` 即消。
- 账本的退出条目保留量是拍脑袋值；若 agent 反馈「跑完很久的终端 wait 说不存在」，先看保留策略。
- 以后再给本地命令加能力，先问「本地能不能闭环」：能就不许碰中心；不能才走 `AgentControlRequest`。
- 093 的撤回记录见 `plans/093-agent-commands-to-mcp.md`，其中日志汇与 wait 上限的决策文本在本 plan 沿用。
