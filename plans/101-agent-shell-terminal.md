# Plan 101：agent 终端新增「会话终端」——不带命令即开常驻、全 tty 的登录 shell，作业终端语义不变

> 本 plan 是**结果契约，不是操作脚本**。读懂需求与已定决策，然后对着活代码自己设计实现。
> 执行模式是 subagent 委派：实现者只实现，里程碑验证与验收由编排者在实现者会话之外跑。
> 命中任一 STOP 条件即停。完成后回写 `plans/README.md`。
>
> 漂移检查：`git diff --stat 79b3694..HEAD -- packages/cli/cofluxd.mjs packages/cli/README.md packages/cli/skills/coflux/SKILL.md integrations/claude-plugin crates/worker/src/hook.rs crates/worker/src/agent_ctl.rs crates/worker/src/device.rs crates/worker/src/ops.rs crates/supervisor/src/sessions.rs apps/server/src/hub.ts apps/server/src/mcp/tools.ts apps/server/src/daemon-capabilities.ts proto/coflux/v1/daemon.proto proto/coflux/v1/device.proto tests/src/agent-control.test.mjs tests/src/mcp-write-tools.test.mjs scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none（消费 074 的 agent 本地 `terminal new`、091 的中心 MCP `create_terminal`、094 的本地账本/快照回读，三者都不动）
- Category: feature
- Execution: subagent opus
- Planned at: `79b3694`, 2026-09-10

## Requirement

今天 agent 只能开一种终端：`cofluxd terminal new --cmd=…`（本地路径）或 MCP `create_terminal`（中心路径）都**必须带命令**，worker 把命令包成脚本 `登录 shell -lc <命令> | 日志汇; exit $PIPESTATUS`，跑完终端退出并带退出码。这种「作业终端」的代价是命令的 stdout 是管道而非 tty：颜色和进度条关闭，vim / htop / less 这类全屏程序不能用，而且一条命令跑完终端就没了，agent 想再跑一条只能重开。不带命令目前被三层依次拒绝（CLI die、daemon `terminal.new 缺 command`、MCP schema 必填 + server「命令不能为空」）。

用户拍板：**两种终端并存，用「命令是否为空」区分**。带命令的仍是作业终端，一字不改；不带命令的是新的「会话终端」——等价于用户自己在侧栏点「新建终端」：工作区目录下的默认登录 shell，stdin/stdout 都是真 tty，不自动退出，直到 agent 或用户在里面输入 `exit`。

消费者是两类 agent：在 coflux 终端里经 `cofluxd terminal new` 的（Claude Code / Codex），以及任何宿主里经 MCP `create_terminal` 的。触发场景：需要一个常驻的交互终端跑多条命令、跑 TUI 或带颜色的程序、让用户随时能接管继续。

完成后为真（消费者可观察的行为）：

- **开**：`cofluxd terminal new --title="…"` 不带 `--cmd`（或 `--cmd=` 为空白）即开会话终端，输出与作业终端同形（taskId + 提示）；MCP `create_terminal` 的 `command` 变为可选，缺省或空白同样开会话终端。侧栏立刻出现一个标题正确、状态 running 的终端，用户可接管。
- **tty**：在会话终端里执行 `python3 -c 'import sys; print(sys.stdin.isatty(), sys.stdout.isatty())'` 打印 `True True`（作业终端是 `True False`）。
- **read**：返回该终端的屏幕快照（去 ANSI 的纯文本，只有一屏），MCP `read_terminal` 的 source 为 `snapshot`（daemon 离线时退回 `checkpoint`）。没有命令日志，这是设计而非缺陷。
- **send**：与作业终端相同；首次 send 前必须先 read 等到提示符，SKILL 里写明。
- **wait / 退出码**：会话终端不会自己退出，`wait` 等到 shell 退出（agent 或用户输入 `exit`）才返回，退出码是 shell 的退出码；成败要靠 read 屏幕判断。
- **作业终端不变**：带命令的路径行为、输出、日志、退出码、错误信息全部与今天一致。
- **失败路径可读**：新 CLI 不带 `--cmd` 打到未升级的旧 daemon，得到旧 daemon 现成的「terminal.new 缺 command」拒绝；MCP 路径打到 091 之前的 daemon，由现有 `prepared_execute` 能力门禁给出「该设备的 daemon 需要升级」。两者都不需要新的探测或版本判断。
- **文档**：SKILL（两份副本）、CLI 帮助与 README、MCP 工具描述都把「命令可选、空命令 = 会话终端、何时用哪种」讲清楚；插件版本提到 0.8.0。

非目标（明确不做）：
- 不改作业终端语义，不做「带命令且跑完不退」的混合形态，不加 `--shell` / `--keep-open` 之类新参数。
- 不给会话终端加日志汇或任何形式的命令日志（会话终端的全部价值就是不经管道）。
- 不做提示符就绪探测、不在 CLI 里自动等提示符。
- web / mobile / iOS / macOS 侧栏不区分会话终端与用户手开终端；不动任何前端。
- 不动 proto（连注释也不动）、不动 supervisor、不动 ops.rs 的脚本模板与日志汇。
- 发版（worker tag 热升级、server 部署、npm cofluxd、插件市场）不在本 plan 内，README 状态里记「待发版」由用户决定。

## Decisions & tradeoffs

- **区分两种终端的唯一判据是「命令 trim 后是否为空」，两条路径一致**：本地 `--cmd` 缺省与 `--cmd=` 空白等价，MCP `command` 缺省与空白等价，都开会话终端。Rejected：加显式标志（`--shell` / `mode`）——用户明确要的是「不带命令会怎样」这个自然语义，多一个标志就多一种「带标志又带命令」的组合要解释。Rejected：显式空串与缺省行为不同——两种「空」不同语义只会制造误用。Based on: `packages/cli/cofluxd.mjs:999-1000`（`values.cmd` 为空即 die）；`apps/server/src/mcp/tools.ts:403`（`command: z.string()` 必填）；`apps/server/src/hub.ts:3692`（`!command.trim()` 拒绝）；`crates/worker/src/hook.rs:281-284`（`command.trim().is_empty()` 拒绝）。

- **零协议改动、零新能力名**。会话终端在协议上就是「shell 为空」：daemon→server 的 `AgentTerminalNew.shell` 传空串，server 原样透传进 `SessionCreate.shell`，supervisor 对空 shell 取默认登录 shell；中心路径的 `DeviceSessionCreate.command` 为空时 worker 已经走「不写脚本、普通 shell」分支。旧 daemon 的两条失败路径都已可读（见 Requirement）。Rejected：新增能力名（如 `shell_terminal`）做门禁——本地路径旧 daemon 自己就拒绝；中心路径 091 之前的 daemon 被 `prepared_execute` 挡住，091 及之后的 daemon 天然支持空命令，没有需要挡的组合。Rejected：改 proto 注释（`AgentTerminalNew.shell` 的注释仍写「包装脚本绝对路径」）——改注释要重新生成三份产物，不值；记入 Maintenance notes。Based on: `proto/coflux/v1/daemon.proto:103-108`；`apps/server/src/hub.ts:1294`（`shell: value.shell` 原样透传）；`crates/supervisor/src/sessions.rs:805-809`（空 shell 取 `self.shell`）；`crates/worker/src/device.rs:2088`（`if !create.command.is_empty()` 才写脚本）；`proto/coflux/v1/device.proto:480-482`（「旧 worker 不认识本字段会起成普通 shell，由中心的能力门禁挡住」）；`apps/server/src/daemon-capabilities.ts:11`（`prepared_execute`）；`crates/worker/src/main.rs:126-127`。

- **会话终端不写包装脚本、不登记日志路径**：本地路径空命令时 agent_ctl 跳过 `write_command_script`，`shell` 传空串，不调用 `remember_log`；`read` 因此落到已在位的 sessiond 快照回退。Rejected：给会话终端也套脚本以便回读日志——脚本就是管道，stdout 一进管道就不是 tty，正是本需求要避免的。Based on: `crates/worker/src/agent_ctl.rs:214-236`（无条件写脚本并 `remember_log`）；`crates/worker/src/ops.rs:334-336`（「命令的 stdout 是管道而非 tty」）；`crates/worker/src/agent_ctl.rs:265-279` 与 `549-603`（日志优先、否则快照、都没有为空）。

- **空命令放行，非空命令仍受 16 KB 上限，两处校验都如此**：hook.rs 与 hub.ts 的字节上限只对非空命令生效；错误文案里不再说「命令不能为空」。Based on: `crates/worker/src/hook.rs:39-40,281-289`；`apps/server/src/hub.ts:136,3692-3694`。

- **默认标题**：title 与 command 都为空时，两条路径都落到 server 现成的「agent 终端」兜底；中心路径「默认取命令首行」在空命令下会得到空标题，必须补上同一兜底，侧栏不能出现空标题。Rejected：沿用 web 手开终端的「终端 N」编号——那是 web 客户端算的，server 侧没有这个计数。Based on: `apps/server/src/hub.ts:1272`（`value.title.trim() || "agent 终端"`）；`apps/server/src/hub.ts:3695`（`command.split("\n")[0].slice(0, 64)`）；`apps/web/src/components/workbench/workspace-terminal.tsx:411`。

- **wait 语义不改，靠文档说清**：`wait` 仍是「等到 exited」，会话终端只在 shell 退出后才 exited；SKILL 明写「会话终端不会自己结束，`wait` 只在你 send 了 `exit` 之后才有意义，默认 30 分钟上限到期是超时不是失败」。Rejected：给会话终端的 `wait` 加特殊短路——语义分叉，且 agent 对「等一个不会结束的东西」本就该自己负责。Based on: `packages/cli/cofluxd.mjs:1030-1042`；`crates/worker/src/agent_ctl.rs` 账本状态判定（plan 094）。

- **文档三处同步、SKILL 只改唯一源**：`packages/cli/skills/coflux/SKILL.md` 是唯一源，改完跑 `node scripts/sync-claude-plugin.mjs` 得到插件目录那份，CI 用 `--check` 比对；插件目录（含 SKILL）必须全英文，测试会递归扫汉字；MCP `create_terminal` 的 title/description/inputSchema 描述与 `read_terminal` 描述里「log = create_terminal 开的命令终端」的措辞要与新语义一致；CLI `--help` 与 `packages/cli/README.md` 同步；插件 `plugin.json` 提到 0.8.0（SKILL 内容变了，市场按版本发布）。Rejected：直接改插件目录那份 SKILL——`--check` 判红。Based on: `scripts/sync-claude-plugin.mjs:9-19`；`tests/src/claude-plugin-session-context.test.mjs`（插件目录零汉字用例，plan 099 改为递归扫目录）；`apps/server/src/mcp/tools.ts:265,395-405`；`packages/cli/cofluxd.mjs:1088-1095`；`integrations/claude-plugin/.claude-plugin/plugin.json`。

- **测试落在两个既有黑盒文件里，各加一条会话终端闭环用例**（decided while planning）：`tests/src/agent-control.test.mjs` 加「不带 --cmd 开出终端 → list 为 running → send 一条能证明 tty 的命令 → read 快照含其输出 → send exit → wait 报 exited exit=0」；`tests/src/mcp-write-tools.test.mjs` 加「create_terminal 不带 command → read_terminal source=snapshot → send_terminal_input → wait_terminal 退出」。等提示符的手法由执行者定（例如 send 一条带唯一标记的命令后轮询 read 直到出现标记，不依赖提示符文本）。同时保留一条作业终端负向用例证明「空命令不再被拒、非空超长仍被拒」。Rejected：新建独立测试文件——两个文件已各自搭好 daemon/中心/PTY 的 fixture，复用最省。Based on: `tests/src/agent-control.test.mjs:86-130,229-260`；`tests/src/mcp-write-tools.test.mjs:186-270`。

## Direction

四个里程碑，文件互不相交，但整体规模小、共享同一份语义，**作为一个工作包执行，不拆分**。

### 里程碑 1：daemon 本地路径 + CLI 支持会话终端

`cofluxd terminal new` 不带 `--cmd`（或空白）能开出会话终端：CLI 不再 die，daemon `/agent` 的 `terminal.new` 放行空命令并以空 shell 向中心建会话、不写脚本不记日志；非空命令路径与错误文案不变；`--help` 里 `--cmd` 标为可选并一句话说明两种终端。CLI 在开出会话终端后的提示文案由执行者定（至少提示「先 read 等提示符再 send」）。
验证：`cargo build -p coflux-supervisor -p coflux-worker` -> exit 0 且零警告；`cargo test -p coflux-worker` -> exit 0；`node packages/cli/cofluxd.mjs --help` -> exit 0 且帮助里 terminal new 的 `--cmd` 为可选。

### 里程碑 2：中心 MCP 路径支持会话终端

`create_terminal` 的 `command` 可选；`createTerminalForAccount` 空命令放行、非空仍限 16 KB、空标题落到「agent 终端」兜底；下发的 `DeviceSessionCreate.command` 为空串即可（worker 现有分支自然走普通 shell）；工具 title/description 与 `read_terminal` 描述改口径。
验证：`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### 里程碑 3：文档与插件

SKILL 唯一源新增会话终端的说明（何时用作业终端、何时用会话终端；会话终端的 read 是快照、无日志；先 read 再 send；wait 只在 send exit 后有意义；全 tty 所以 TUI/颜色可用）并同步到插件目录；`packages/cli/README.md` 示例补一条不带 `--cmd` 的写法；插件 README 若描述了终端语义则同步；`plugin.json` 0.8.0。
验证：`node scripts/sync-claude-plugin.mjs --check` -> exit 0；`node --import tsx --test tests/src/claude-plugin-session-context.test.mjs tests/src/claude-plugin-guard.test.mjs` -> 全绿（含插件目录零汉字）。

### 里程碑 4：黑盒用例

按 Decisions 最后一条在两个既有黑盒文件里各加会话终端闭环用例与负向用例。
验证（里程碑级，语法级）：`node --check tests/src/agent-control.test.mjs && node --check tests/src/mcp-write-tools.test.mjs` -> exit 0。真正跑通属验收（见 Commands）。

## Landmines

- `crates/worker/src/device.rs:2088`：中心路径空命令已经走普通 shell 分支，且前面的 `remember_create` 不受影响——**不要**把它改成也写脚本，也不要在这里加门禁。
- `apps/server/src/hub.ts:3695`：默认标题取命令首行，空命令下 `validBoundedText("")` 可能通过而留下空标题，必须显式兜底。
- `packages/cli/cofluxd.mjs` 用 `parseArgs` 解析：`--cmd` 缺省、`--cmd=`、`--cmd ""` 三种写法的解析结果要实测，别只改 die 那一行；SKILL 里「必须写 `--cmd=<值>`」的约定保留。
- `crates/worker/src/hook.rs:281-289` 的空命令拒绝是本地路径唯一的门，放行后 `AgentAction::TerminalNew` 的下游（agent_ctl）必须同时改，否则会写出一个 `-lc ''` 的脚本并立刻退出，表现为「开了就退」的静默失败。
- `crates/worker/src/agent_ctl.rs:265-279`：`read` 的快照回退只认「中心给的 session 与本地 alive 表一致」，会话终端刚开出来的头几百毫秒快照可能为空（`（暂无输出）`），测试要轮询而不是一次 read。
- 黑盒测试需要本机 PG 5432 与 Docker，且 `pnpm -C tests test` 的 pretest 会 cargo build；单跑文件前先 `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay`。全量黑盒里 `agent-activity` 的 presence 三条在装了 coflux 的本机必假红且会卡住整套，验收只跑本 plan 触及的两个文件。
- `tests/src/claude-plugin-session-context.test.mjs` 递归扫插件目录禁止汉字：SKILL 新增段落、plugin.json description 都必须英文。
- 旧 daemon 兼容不做任何探测：新 CLI 打旧 daemon 得到「terminal.new 缺 command」即为预期，SKILL 的「predates the daemon upgrade / 需要升级」一节顺带提一句「不带命令被拒 = daemon 需要升级」即可。
- 生产生效节奏不同：worker 改动随 tag 热升级到达 daemon，server 随部署，CLI 随 npm，插件随市场。本 plan 完成 ≠ 生产可用，README 状态里写明。

## Scope

In scope:
- `packages/cli/cofluxd.mjs`
- `packages/cli/README.md`
- `packages/cli/skills/coflux/SKILL.md`（唯一源）
- `integrations/claude-plugin/skills/coflux/SKILL.md`（仅经 sync 脚本产出）
- `integrations/claude-plugin/.claude-plugin/plugin.json`
- `integrations/claude-plugin/README.md`（仅当其描述了终端语义）
- `crates/worker/src/hook.rs`
- `crates/worker/src/agent_ctl.rs`
- `apps/server/src/hub.ts`
- `apps/server/src/mcp/tools.ts`
- `tests/src/agent-control.test.mjs`
- `tests/src/mcp-write-tools.test.mjs`
- `plans/101-agent-shell-terminal.md`、`plans/README.md`

Out of scope:
- `proto/`、`packages/protocol/`、`packages/swift-client/`——零协议改动，注释也不动
- `crates/supervisor/`——空 shell 取默认已在位
- `crates/worker/src/ops.rs`、`crates/worker/src/log_sink.rs`、`crates/worker/src/device.rs`——脚本模板、日志汇、中心路径的空命令分支都不动
- `apps/web/`、`apps/mobile/`、`apps/ios/`、`apps/macos/`——不区分会话终端
- `integrations/claude-plugin/hooks/`、`integrations/claude-plugin/scripts/`——hooks 不变，Codex 无需重新信任
- 发版与部署（tag、npm、市场、prod-jp）

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| Rust 单测 | `cargo test -p coflux-worker` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| CLI 帮助 | `node packages/cli/cofluxd.mjs --help` | exit 0，`--cmd` 标为可选 |
| SKILL 两份一致 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| 插件单测（含零汉字） | `node --import tsx --test tests/src/claude-plugin-session-context.test.mjs tests/src/claude-plugin-guard.test.mjs` | 全绿 |
| 黑盒用例语法 | `node --check tests/src/agent-control.test.mjs && node --check tests/src/mcp-write-tools.test.mjs` | exit 0 |
| 黑盒：本地路径 (acceptance) | `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay && cd tests && node --import tsx --test src/agent-control.test.mjs` | 全绿 |
| 黑盒：中心路径 (acceptance) | `cd tests && node --import tsx --test src/mcp-write-tools.test.mjs` | 全绿 |
| 真机走查 (acceptance) | 在本仓库的 coflux 终端里 `cofluxd terminal new --title="Shell"`，再 send `python3 -c 'import sys; print(sys.stdin.isatty(), sys.stdout.isatty())'` 并 read | 侧栏出现常驻终端；read 见 `True True`；send `exit` 后 wait 立即返回 exit=0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 本地与 MCP 两条路径不带命令都开出常驻会话终端，tty 检查为 `True True`；带命令路径行为、日志、退出码、错误文案与 79b3694 一致。
- [ ] 空命令 + 空标题的终端在侧栏显示「agent 终端」，不是空标题。
- [ ] 非空命令超过 16 KB 仍被两条路径拒绝，文案不再含「不能为空」。
- [ ] SKILL 唯一源与插件副本一致，插件目录零汉字，plugin.json 为 0.8.0，MCP 工具描述与 CLI 帮助已改口径。
- [ ] Required tests exist and assert meaningful behavior（两个黑盒文件各有会话终端闭环用例与负向用例）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（尤其 `device.rs` 的空命令分支、supervisor 的空 shell 取默认、hub.ts 的 shell 透传）。
- The outcome requires out-of-scope files（例如发现必须改 proto 或 supervisor 才能开出会话终端）。
- A validation command fails twice after one reasonable fix.
- A named assumption is false（例如 `parseArgs` 无法区分 `--cmd` 缺省与非法用法而需要改参数体系）。

## Maintenance notes

- `proto/coflux/v1/daemon.proto` 里 `AgentTerminalNew.shell` 的注释仍写「worker 已写好的临时包装脚本绝对路径」，实际语义已是「空串 = 默认登录 shell」；下次因别的原因动 proto 时顺手改注释并重新生成。
- 会话终端没有日志：web 端 097 的退出回放对它只有 checkpoint 一屏；若将来需要会话终端也能回读全量输出，要另起 plan 走 PTY 侧录制（不能再用管道方案）。
- 每工作区活跃终端上限 8 含会话终端；会话终端不会自己退出，agent 忘记 `exit` 会长期占位，若用户反馈撞上限，先看 074 记的「AI 开的终端的自动回收策略」。
- 发版清单（用户决定）：worker 打 tag 热升级、server 部署 prod-jp、npm `cofluxd` 发版、插件 0.8.0 走 plugins-builder（把 main 的 SHA 交给 builder 会话）。
