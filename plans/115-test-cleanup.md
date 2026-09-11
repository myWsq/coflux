# Plan 115：按测试原则清理测试代码——黑盒目录去白盒、桌面与 Rust 单测去「重述实现」、删陈旧 worktree

> 本 plan 是结果契约，不是逐步脚本。理解需求与已定决策，对着活代码自己设计改法。
> 只有当你同时是验证者时才边做边跑里程碑验证——被委派的执行者只实现，验证在其会话之外。
> 遇到任一 STOP 条件即停。完成后更新 `plans/README.md` 里本 plan 的状态。
>
> 漂移检查：`git diff --stat 7deedfb..HEAD -- tests/src apps/desktop/src apps/desktop/test crates docs/auth-design.md`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: tests
- Execution: subagent opus
- Planned at: `7deedfb`, 2026-09-11

## Requirement

仓库有两条测试原则：

1. `AGENTS.md`「测试 harness」与 `tests/src/harness.mjs:1-15`：`tests/src/` 是**黑盒**，只经真实进程 + WebSocket 线协议驱动，**完全不 import `apps/*`**，因此跨重构、跨语言重写依然有效。
2. dev 工作原则：**不为可逆、低影响、只会重述实现的改动写测试**；前端 UI 交人工验证。

现状偏离了这两条，本 plan 把它们清理回原则：

- **A. 黑盒目录里混进了白盒**：`tests/src` 有 9 个文件直接 `import` server 实现（`hub.ts`、`store.ts`、service、纯函数），注释却自称黑盒，合计约 6,100 行。用户决定**直接删除**，不挪层、不保留。
- **B. 桌面单测里有一批只重述实现的用例**：断言 UI 文案字面量、色调、图标名、常量原值、把 if/else 或 switch 逐条重抄。整删 3 个文件、在 8 个文件里删 16 条。
- **C. Rust inline 测试里同类用例**：枚举到字符串的一一映射、常量透传、测试体内自己重写判定式再断言。删 15 条（244 → 229）。
- **D. 一个陈旧 worktree**：`.claude/worktrees/20260908-codex-agent-tab` 落后 main 133 个提交，分支上有 3 个未合并提交（Codex Agent Tab，2026-09-08）。删 worktree、保留分支。

做完后为真：`tests/src/*.test.mjs` 没有任何文件 import `apps/server`；被判定为重述实现的用例不再存在；保留的用例一条不少；四层测试命令全绿、`cargo build` 零警告；**生产代码零改动**（除一处文档改口）。

## Decisions & tradeoffs

- **A 组的处置是删除，不是搬到 apps/server 单测层**：删除 9 个文件本身，不新建 `apps/server/test/`、不加 `pnpm -C apps/server test`、不改 CI。Rejected：挪到 server 单测层——用户在出发检查明确选「直接删」，接受失去这些竞态/迁移回归。Based on：`tests/src/server-connection-concurrency.test.mjs:130`、`server-generation-entity-lifecycle.test.mjs:34`（`import("../../apps/server/src/hub.ts")`）、`prepared-operation-service.test.mjs:7`、`schema-migrations.test.mjs:10-11`、`proxy-tunnel-limits.test.mjs:18`、`proxy-gate.test.mjs:7`、`auth-pages.test.mjs:24`、`auto-update-manifest.test.mjs:6`、`relay-dial-version.test.mjs:16`。
- **A 组的边界是「import `apps/server`」，不是「import 任何应用代码」**：`tests/src/release-sign.test.mjs` 与 `cli-release-trust.test.mjs` 保留。Rejected：一并删——它们 import 的是 `scripts/release-statement.mjs` 与 `packages/cli/release-trust.mjs`，驱动的是发版脚本与 npm 包验签器，不是 server 实现；用户已知悉并同意保留。Based on：`tests/src/release-sign.test.mjs:9-21`、`cli-release-trust.test.mjs:11-14`。`@coflux/protocol` 的 import 同样不算违反（harness 注释明说它是 proto 生成产物，`tests/src/harness.mjs:10-15`）。
- **B 组只删测试，生产模块一律不动**：`terminal-link-activation.ts` 删掉测试后只为可测而存在，仍**不**内联回 `terminal-pane.tsx`；`account-footer-view.ts`、`desktop-update.ts` 同样保留。Rejected：顺手内联——用户选择本次不动生产代码，作为后续单独提。Based on：`apps/desktop/src/renderer/components/workbench/terminal-link-activation.ts` 头注释（拆出来的唯一动机是纯 Node 单测）。
- **`packages/client` 五个测试文件全部保留**：`device-router.test.ts` 的共享 trace fixture 被 Swift 侧消费，是跨端真相源。Based on：`packages/swift-client/Tests/CofluxClientCoreTests/DeviceRouterParityTests.swift:69`。
- **B 组的删除清单是穷举的**（详见 Direction M2），保留清单同样穷举；清单之外的用例一条不删。判定标准：断言 UI 文案字面量/色调/图标名、常量原值、单行布尔或真值表、把 switch/OR 链逐条重抄 → 删；安全边界（Origin 改写、`..` 路径拒绝、CSP、IPC 来源校验、token 不落明文）、与外部文件逐字同构、状态机不变量、已踩过坑的回归、持久化向后兼容 → 留。
- **C 组含 4 条次级用例**，其中两条是「瘦身」而非整删：`ops.rs` 的 `production_script_pipes_into_worker_log_sink` 只保留 `!script.contains("| tee ")` 一句断言（tee → log-sink 的防回退）；`device.rs` 的 `call_ledger_counts_waiter_strings_and_fixed_overhead` 删两条用生产函数算期望值的恒真 `assert_eq!`，只留「同一 waiter 二次入账不重复计费」段。Rejected：这两条整删——它们各含一句有独立价值的断言。Based on：`crates/worker/src/ops.rs:567`、`crates/worker/src/device.rs:4070`。
- **C 组不动 `crates/protocol/src/wire_tests.rs`**（17 条）：未经审计，本次不删。Based on：`crates/protocol/src/lib.rs:79`。
- **D 组删 worktree 用 coflux MCP 的 `remove_workspace`，不用 `git worktree remove`**；分支 `dev/20260908-codex-agent-tab` 保留不删。Based on：会话规则（coflux 注册的 worktree 由 `remove_workspace` 删除）；分支上 3 个未合并提交是用户的资产。
- **（决定于规划时）`docs/auth-design.md:138` 只删「纯函数单测在 `tests/src/auth-pages.test.mjs`」这句**，前面「黑盒：authorize / mcp-oauth / proxy 三份各有 HTTP 流用例」照旧。
- **（决定于规划时）`tests/src/harness.mjs` 的 `hiddenFieldsFrom` / `formActionFrom` 两个无人再用的导出**：删不删交执行者；JS 没有 dead-code 警告，两者皆可。

## Direction

四个里程碑相互独立：各自的结果与验证互不依赖，可并行成工作包（M4 是一次 MCP 调用，与文件改动无关）。

### Milestone 1：`tests/src` 回到纯黑盒

删除以下 9 个文件，且 `tests/src/*.test.mjs` 中不再有任何 `apps/server` 字样的 import：

`server-connection-concurrency`、`server-generation-entity-lifecycle`、`prepared-operation-service`、`schema-migrations`、`proxy-tunnel-limits`、`proxy-gate`、`auth-pages`、`auto-update-manifest`、`relay-dial-version`（均为 `tests/src/<名>.test.mjs`）。

`docs/auth-design.md:138` 按决策改口。

Validation：`grep -n "from .*apps/server\|import(.*apps/server" tests/src/*.test.mjs` → 无输出（字面 grep `apps/server/src` 会命中 `authorize.test.mjs:30`、`mcp-write-tools.test.mjs:43` 两处注释，不算）；`ls tests/src/*.test.mjs | wc -l` → 50（基线 59 − 9）；`node --import tsx --test tests/src/claude-plugin-guard.test.mjs tests/src/claude-plugin-session-context.test.mjs` → exit 0（不起栈的两份，证明 glob 与 harness 加载未坏）。

### Milestone 2：桌面单测去重述

整删 3 个文件（`apps/desktop/src/renderer/components/workbench/` 下）：`account-footer-view.test.ts`、`desktop-update.test.ts`、`terminal-link-activation.test.ts`。

部分删 16 条（行号为 `7deedfb` 时的 `test(` 所在行）：

| 文件 | 删 | 留 |
|---|---|---|
| `src/main/app-protocol.test.ts` | `:7` scheme URL 常量原值、`:39` 扩展名→MIME 查表 | `:15` SPA 回落、`:25` `..` 路径拒绝、`:47` CSP |
| `src/main/daemon-files.test.ts` | `:105` fda-status / supervisor-version 原文解析 | 其余 7 条 |
| `src/main/settings.test.ts` | `:6` 默认值常量原值 | `:13` 优先级、`:20` 非法值跳过 |
| `src/renderer/desktop-bridge.test.ts` | `:8` 没有 window、`:20` window 上没有 cofluxDesktop | `:32` 地址只来自桥接 |
| `workbench/workbench-state.test.ts` | `:18` 认证状态映射、`:26` 重连横幅三值、`:32` 变更视图激活真值表、`:39` 关闭确认单行 `===` | `:44` 及 `:53` 以后全部（持久化兼容、选择回退、Tab 跟随六条） |
| `workbench/desktop-attention.test.ts` | `:40` question 态留言透传、`:77` 通知文案字面量 | `:25` 两态过滤、`:46` 去重与角标、`:62` 恢复后清零 |
| `workbench/daemon-view.test.ts` | `:32` 状态行 label/tone/pulsing、`:57` 可见动作 switch 重抄、`:92` 终端数 filter+length | `:101` 自动弹引导、`:116` 引导页、`:131` 引导三步（含已踩坑回归） |
| `workbench/changes-refresh.test.ts` | `:25` OR 链逐字段重抄 | `:18` 首次/重进必刷、`:33` manualRevision 强制失效 |

执行者的判断项：`daemon-view.test.ts:57` 里「remove 永远二次确认 + `kind=destructive`」（`:72-73`）可另起一条最小用例保留，也可随整条删。

全留的文件：`test/config.test.ts`，`src/main/` 的 `ipc-trust`、`ipc`、`origin`、`token-store`、`update-state`、`window-state`、`daemon-state`、`daemon-version`、`daemon-bundle`，`src/renderer/session-token.test.ts`；`packages/client/src/*.test.ts` 全部。

删用例后清理不再使用的 import。**不改 `apps/desktop/package.json` 的 test 脚本**：四段 glob 删后各段仍有文件（见 Landmines）。

Validation：`pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0，用例总数 101 − 28 = 73（执行者若为 destructive 确认另起最小用例则为 74；实际落地 74）。

### Milestone 3：Rust inline 去重述

删 11 条（行号为 `7deedfb` 时 `fn` 所在行附近）：

- `crates/cli/src/main.rs`：`managed_commands_are_recognized_explicitly`（:119）、`refusal_points_to_the_desktop_app`（:129）、`migrated_hints_follow_node`（:136）。留 `help_keeps_agent_phrases_used_by_skill_docs`（:143，SKILL.md 是外部消费者）。
- `crates/protocol/src/logline.rs`：`live_timestamp_has_expected_shape`（:141）。
- `crates/worker/src/agent_ctl.rs`：`response_shapes_are_agent_readable`（:756）、`status_names_cover_task_states`（:770）、`request_ids_are_unique`（:825）。
- `crates/worker/src/device.rs`：`transport_backpressure_detects_output_sequence_gap`（:6175）。
- `crates/worker/src/gateway.rs`：`text_frame_is_a_protocol_error`（:730）、`binary_frame_is_the_envelope`（:739）。留 `close_before_hello_is_a_normal_end`（:698）。
- `crates/worker/src/hook.rs`：`event_mapping_covers_both_agents`（:449）。

次级 4 条：删 `crates/cli/src/commands.rs` 的 `command_normalization_collapses_blank_to_empty`（:544）、`crates/worker/src/gateway.rs` 的 `control_frames_keep_waiting`（:718）；按决策瘦身 `crates/worker/src/ops.rs:567` 与 `crates/worker/src/device.rs:4070` 两条。

被删用例调用的生产函数全部仍有生产调用点，不会产生 `dead_code`；删完清理测试模块里不再用的 `use`。

Validation：`cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` → exit 0，总用例数比基线少 13（整删 11 + 次级整删 2；瘦身的 2 条仍在）；`cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` → 零警告。

### Milestone 4：删陈旧 worktree

用 coflux MCP `remove_workspace` 删除 `/Users/wsq/Workspace/coflux/.claude/worktrees/20260908-codex-agent-tab` 对应的工作区（它在 coflux 侧栏里是本项目的子工作区；若 MCP 里找不到对应工作区 id，先 `list_workspaces` 按路径找）。分支 `dev/20260908-codex-agent-tab` 保留。

Validation：`git worktree list` 不再含该路径；`git branch --list dev/20260908-codex-agent-tab` 仍有输出。

## Landmines

- `apps/desktop/package.json:13` 的 test 脚本是四段**非递归**字面 glob（`src/main/*.test.ts src/renderer/*.test.ts src/renderer/components/workbench/*.test.ts test/*.test.ts`），npm 走 `sh -c`，未匹配的 glob 原样传给 node，`node --test` 会直接报错。本次删后各段仍有文件（main 12、renderer 只剩 `session-token`、workbench 剩 4、test 剩 `config`），不需要改脚本；但不要多删任何一个 renderer 根目录或 workbench 的测试文件。
- `crates/worker/src/agent_ctl.rs:775` 的 `fn scope()` 是测试 helper，被保留的 3 条用例使用；删 3 条重述用例后它仍有引用，不要顺手删。
- `crates/worker/src/tunnel.rs:545` 的 `#[tokio::test(flavor = "current_thread")]` 靠单线程调度器制造竞态，不在删除清单里，也不要统一改 flavor。
- 仓库 release 构建走 `-D warnings`（`crates/protocol/src/logline.rs:77` 注释记录 v0.31.0 两个 musl job 曾因此失败），删测试后 `use` 未清理会直接炸发版。
- `daemon-files.test.ts:37` 自称「与 cofluxd.mjs 的 plistXml 逐字同构」，实际是硬编码 golden 字符串，不读 `packages/cli/cofluxd.mjs`；本次保留，但别把它当跨源守卫。
- 黑盒全量在本机：`tests/src/agent-activity.test.mjs` 三条**必假红且会卡住整套**（判据是进程树里名为 claude 的进程，开发机上被真实会话污染）；`auto-update`、`local-first-device`、`signed-upgrade` 偶发红，同一代码一红两绿即 flaky。跑全量用 coflux 终端前台 `cofluxd terminal wait`，别挂后台 Bash（高负载会被系统按内存杀掉）。本机测试 Postgres 是 `127.0.0.1:5432`（`pnpm dev:pg`，Docker 是 OrbStack `orb start`）。
- 本会话 Bash 是 zsh：`"$VAR:path"` 里的 `:p` 会被当修饰符吃掉，写 `${VAR}:path`；`set -e` 不生效，多步用 `&&` 串。在 worktree 里的会话，Bash 守卫会拦 `git -C ..`、`$(git …)` 等复合写法，拆成单条跑。

## Scope

In scope:
- `tests/src/`（只删上述 9 个文件；可选删 `harness.mjs` 两个无人用导出）
- `docs/auth-design.md`（一句改口）
- `apps/desktop/src/main/*.test.ts`、`apps/desktop/src/renderer/*.test.ts`、`apps/desktop/src/renderer/components/workbench/*.test.ts`
- `crates/cli/src/{main,commands}.rs`、`crates/protocol/src/logline.rs`、`crates/worker/src/{agent_ctl,device,gateway,hook,ops}.rs`（只动 `#[cfg(test)]` 模块）
- `plans/README.md`、`plans/115-test-cleanup.md`

Out of scope:
- 任何生产代码（含 `terminal-link-activation.ts` 内联）——用户决定本次不动
- `tests/src/release-sign.test.mjs`、`cli-release-trust.test.mjs`、`local-first-benchmark.mjs`、`device-harness.mjs`、`oauth-harness.mjs`——不 import server 或是工具
- `packages/client/src/*.test.ts`、`packages/swift-client/Tests`——跨端真相源
- `crates/protocol/src/wire_tests.rs`、其余 Rust 文件的测试——未审计
- `apps/desktop/package.json`、`.github/workflows/*`——glob 与 CI 不需要改
- `apps/server/`——不新建单测层
- 分支 `dev/20260908-codex-agent-tab`——只删 worktree 不删分支

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 黑盒目录无 server import | `grep -l "apps/server/src" tests/src/*.test.mjs` | 无输出 |
| 黑盒 smoke（不起栈） | `node --import tsx --test tests/src/claude-plugin-guard.test.mjs tests/src/claude-plugin-session-context.test.mjs` | exit 0 |
| 桌面类型检查 + 单测 + 构建 | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0，单测 73 条 |
| client 单测（应无变化） | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| server 类型检查（应无变化） | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0 |
| Rust 零警告 | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0 且无 warning |
| 黑盒全量 (acceptance) | `pnpm -C tests test` | 除已知假红/flaky 外全绿 |

## Done criteria

- [ ] 上表全部命令通过（黑盒全量按 Landmines 的已知假红/flaky 判定）。
- [ ] `tests/src/*.test.mjs` 无任何 `apps/server` import；9 个文件已删。
- [ ] 桌面：3 个文件已删，16 条用例已删，保留清单里的用例一条不少。
- [ ] Rust：13 条整删、2 条按决策瘦身，`cargo build` 零警告。
- [ ] 陈旧 worktree 已从 `git worktree list` 消失，分支仍在。
- [ ] `git diff 7deedfb..HEAD --stat` 里没有生产代码文件（只有测试文件、`docs/auth-design.md`、`plans/`）。
- [ ] 实现遵循 Decisions & tradeoffs 每一条。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- Decisions & tradeoffs 引用的某个事实不再成立（例如某个白盒文件已不再 import server、某条待删用例已不存在）。
- 结果需要改动 out of scope 的文件（尤其是生产代码）。
- 某条验证命令在一次合理修复后仍失败两次。
- 删测试后 `cargo build` 出现 `dead_code` 或 `unused` 警告且修复需要动生产代码。
- `remove_workspace` 找不到该 worktree 对应的工作区——停下报告，不要退回 `git worktree remove`。

## Maintenance notes

- 以后往 `tests/src` 加文件先问一句：它起真实进程走线协议吗？不是就不属于这里。需要进程内单测的 server 逻辑，要么改写成黑盒，要么另立 server 单测层（本 plan 明确没有建）。
- `terminal-link-activation.ts`、`desktop-update.ts` 现在没有测试消费者，下次动 `terminal-pane.tsx` / `workbench.tsx` 时可顺手内联。
- `crates/protocol/src/wire_tests.rs` 未按同一标准审过。
- 分支 `dev/20260908-codex-agent-tab` 上的 3 个提交（Codex Agent Tab）仍在，要么立 plan 续做，要么删分支。
