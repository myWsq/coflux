# Plan 098：把 agent 的不可见后台进程外化——拒绝 background Bash、后台跑 wait 拿回退出唤醒、泄漏播报

> 本 plan 是**结果契约，不是操作脚本**。读懂需求与已定决策，然后对着活代码自己设计实现。
> 里程碑验证命令由验证方跑（委派执行时执行者只实现，验证在其会话之外）。命中任一 STOP 条件即停。
> 完成后回写 `plans/README.md`。
>
> 漂移检查：`git diff --stat 8de554e..HEAD -- integrations/claude-plugin packages/cli/skills packages/cli/cofluxd.mjs tests/src/claude-plugin-guard.test.mjs scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none（延伸 095 的 hook 交付形态、094 的本地命令、096 的插件英文化约定）
- Category: dx
- Execution: subagent opus
- Planned at: `8de554e`, 2026-09-08

## Requirement

coflux 的立身之本是「agent 干的活用户在 web/手机上看得见、随时能接管」。这条链路上有一个洞：**agent 在自己的 Bash 里后台起的进程，用户完全看不见**——侧栏没有条目，不能接管，失败只能靠 agent 转述。`SKILL.md` 已经写了「用 `cofluxd terminal new` 而不是自己后台化」，但那是建议，模型经常忽略。

调研（本 plan 立项前的 explore + advisor）确认了三件事，它们共同决定了本 plan 的形态：

1. **不可见后台有两条路径，hook 只能拦住一条**。显式 `Bash(run_in_background: true)` 走 PreToolUse，可拦；而 Claude Code 的前台命令**超时会自动转成后台任务**（`sleep` 开头、含 `git`、不可解析复合命令除外），这条路径不经过 PreToolUse——hook 只在工具执行前触发一次，那时 `run_in_background` 还是假。所以「拦住后台 Bash = 长进程全可见」不成立，第二条路径只能做到**让用户知情**，做不到强制外化。
2. **唯一真能力缺口可以零成本补上**。coflux 终端相对 Claude 后台 Bash 唯一缺的是「进程退出时唤醒 agent」（coflux 没有推送通道，只有阻塞 `wait` 或轮询）。而 `Bash(run_in_background: true, command: "cofluxd terminal wait <id>")` 就补上了：活跑在用户看得见的终端里，`wait` 退出时 harness 原生的 task notification 照样唤醒 agent。这是一句文档的事，不需要任何代码。
3. **透明改写（`updatedInput`）是错的**，理由见 Decisions 第 1 条。

完成后为真：

- **对 agent**：显式 `run_in_background: true` 被 deny，理由里给出可直接执行的 `cofluxd terminal new --cmd=…`（标题取自它自己写的 `description`），并明确写「也不要改成前台跑」。它拿到的是一个能照做的下一步，不是一句「不许」。
- **对 agent**：SKILL 里有「开终端 → 后台跑 `wait` → 被唤醒后 `read`」这条完整配方，它不再需要在「用户可见」和「退出唤醒」之间二选一。
- **对用户**：agent 仍然产生了不可见后台任务时（自动后台化，或它绕过 deny），工作区卡片上会出现一条 `progress`，说明有一个看不见的后台任务在跑，而不是毫无察觉。

## Decisions & tradeoffs

- **形态用「PreToolUse 拒绝 + 引导」，不用 `updatedInput` 透明改写**。Rejected：把 command 改写成包一层 coflux 终端的命令——五条独立的硬伤，每条都足以否决：
  ① **权限面失配**：`updatedInput` 后仍走标准权限评估，但匹配的是改写后的命令，用户写的 `Bash(git push:*)` deny / `Bash(pnpm test:*)` allow 全部失配；不加 `permissionDecision: allow` 则每条后台命令都弹窗，加了则 deny 规则被绕过。前缀匹配是结构性的，包装字符串怎么写都躲不掉。
  ② **引入中心依赖**：`terminal.new` 必须已连中心（`packages/cli/cofluxd.mjs:945-948` 注释：`send/read/wait/notify/progress` 本地闭环，`new/list/ports` 由 daemon 代问中心），中心断线时普通后台 Bash 照跑而改写路径直接失败——违反本项目「本地能闭环的 agent 操作绝不经中心」的既定原则。
  ③ **环境不等价**：coflux PTY 继承 supervisor(launchd) 环境再 `zsh -lc`（login 非交互），**`.zshrc` 不加载**；PATH 只写在 `.zshrc` 的工具（nvm、`pnpm setup` 默认写那里）会 command not found——同一条命令前台能跑、被改写后失败。
  ④ **stdin 语义反转**：coflux 里 stdin 是 PTY slave，交互提示（git 凭据、sudo、y/N）会挂起等人而不是快速失败，harness 永远等不到退出。
  ⑤ **退出码有损**：被信号杀的终端退出码统一为 1，用户在侧栏点停止和命令真失败，agent 分不清。
  Based on: `packages/cli/cofluxd.mjs:946-947`（中心依赖注释）；`integrations/claude-plugin/skills/coflux/SKILL.md:88-91`（`--cmd` 的 stdout 是 pipe 不是 tty）。

- **拒绝的判据是 `tool_input.run_in_background === true` 这个布尔字段，不对命令文本做正则**。Rejected：像 `guard-git-worktree.mjs` 那样正则匹配命令串——那个脚本已经因为整段文本匹配而误拦 heredoc 正文和引号字符串（`plans/README.md` Backlog 有独立条目记着），新脚本不要继承这个毛病。布尔字段无歧义。Based on: `plans/README.md` Backlog「guard 误拦 heredoc/引号字符串」。

- **会话判据用 `COFLUX_WORKSPACE_ID`，不用 `COFLUX_PROJECT_ID`**。Rejected：沿用 guard 现有的 `COFLUX_PROJECT_ID`——目录型工作区（无 git 仓库）该变量为空，而后台可见性对目录工作区同样适用；且 Backlog 已记着 `PROJECT_ID` 被子进程继承导致误判的问题，不要再往上加使用者。Based on: `integrations/claude-plugin/skills/coflux/SKILL.md:44`（`COFLUX_PROJECT_ID` 对无仓库的目录工作区为空串）；`integrations/claude-plugin/scripts/session-context.sh`。

- **豁免两类命令**：命令里含 `cofluxd terminal` 的（递归——被 deny 后 agent 照做开出来的终端、以及我们主动教它后台跑的 `wait`，都必须放行），以及 `sleep` 开头的（Claude Code 自动后台化本身就排除它，且纯等待没有外化价值）。Rejected：一律拒绝——会把我们自己教的配方拦死。

- **「后台跑 `wait`」写进 SKILL，不做成任何代码能力**。Rejected：给 cofluxd 加 `terminal run` 子命令做流式跟随——那需要 daemon 回 `logPath`、CLI 新子命令、本地 `stop`（要动 Rust，`AgentAction` 现在没有 Stop）、包装进程信号转发、以及 daemon 各种拒绝时的内联回退，少一件就会在对应场景炸；而 `Bash(run_in_background: true, command: "cofluxd terminal wait <id>")` 用零代码拿到同一个结果。Based on: `packages/cli/cofluxd.mjs:1029-1046`（`wait` 是 CLI 侧 3 秒轮询 `terminal.status`）；`crates/worker/src/agent_ctl.rs:68-92`（无 Stop action）。

- **PostToolUse 探测器只播报、不阻断**，用 `cofluxd progress` 而非 `notify`。Rejected：`notify`——那会把工作区切成「等待交互」，但用户此刻并不需要做任何事，属于误报警；`progress` 是广播语义，正好。Based on: `integrations/claude-plugin/skills/coflux/SKILL.md`「progress = 广播 / notify = 叫人」。

- **新脚本独立成文件，不并进 `guard-git-worktree.mjs`**。Rejected：合并——两者事件不同（PreToolUse vs PostToolUse）、判据不同（布尔字段 vs 命令正则）、环境变量不同（WORKSPACE vs PROJECT）、失败模式也不同；合并只会让两个都更难改。

- **(decided while planning) 插件版本提到 0.6.0**（当前 `0.5.0`）。新增 hook 行为属于功能变更，按 095（0.4.0）/096（0.5.0）的先例走 minor。Based on: `integrations/claude-plugin/.claude-plugin/plugin.json`。

## Direction

三个里程碑**不独立**，必须作为一个工作包顺序执行：M1 与 M3 都要改同一个 `integrations/claude-plugin/hooks/hooks.json`，M4 依赖前三者的产物。不要拆成并发工作包。

插件目录（`integrations/claude-plugin/**`）内的一切文案**必须全英文**，这是 096 定下的约定。plan 正文和测试用例中文照旧。

### 里程碑 1：显式后台 Bash 被拒，并拿到可照做的替代命令

coflux 会话里的 `Bash(run_in_background: true)` 被 PreToolUse deny，理由是一段可操作的英文：说明用户看不见后台进程，给出等价的 `cofluxd terminal new --title=… --cmd=…`（标题取自 `tool_input.description`，命令为原命令），并明确要求不要退而求其次改成前台跑。豁免命令含 `cofluxd terminal` 的与 `sleep` 开头的。

会话判据缺失（`COFLUX_WORKSPACE_ID` 为空）、非 Bash 工具、stdin 不是合法 JSON、`run_in_background` 不为真——一律**零字节 stdout 且退出 0**（无意见），绝不误拦。调试输出只走 stderr。

`hooks.json` 增加对应的 PreToolUse 条目（matcher `Bash`），与既有 guard 条目并存。

验证：`node --import tsx --test tests/src/claude-plugin-background.test.mjs` → exit 0。新测试至少覆盖：deny 路径的 stdout 是纯 JSON 且理由里含 `cofluxd terminal new`；两类豁免不拦；上述四种「无意见」情形零输出。

### 里程碑 2：SKILL 教「开终端 + 后台等待」这条完整配方

`packages/cli/skills/coflux/SKILL.md`（**唯一源**）的终端章节增加：被拒之后该怎么做，以及「开完终端就把 `cofluxd terminal wait <taskId>` 放进自己的后台 Bash，退出时会被唤醒，然后 `read` 看结果」这条配方。写清楚 `wait` 自身退出码恒为 0，成败要看输出里的 `# exited exit=N`。样例里的 `--cmd` 一律写成 `--cmd=<值>` 形式。

验证：`node scripts/sync-claude-plugin.mjs --check` → exit 0（两份 SKILL 一致）；插件目录零汉字。

### 里程碑 3：不可见后台任务被播报给用户

先做前提实测：用一条**非 `sleep` 开头**的长命令配短 `timeout`，确认 PostToolUse 在「前台超时自动后台化」那一刻是否触发、`tool_response` 里是否带得到 `backgroundTaskId` / `timedOutAfterMs`。

- 触发且字段可读 → PostToolUse 脚本检测到这些字段时调 `cofluxd progress`，播报存在一个用户看不见的后台任务（带上 `description`）。
- 不触发或字段读不到 → **不要硬做**。按 STOP 条件停下报告，把该里程碑降级为 Maintenance notes 里的已知缺口。

无论哪条分支，脚本的 stdout 都必须零字节（PostToolUse 的 stdout 会被当作上下文注入，且 Codex 也会执行这个 hook）。

验证：`node --import tsx --test tests/src/claude-plugin-background.test.mjs` → exit 0（补上探测器的用例：认得出泄漏字段则调 progress、认不出则零动作、非 coflux 会话零动作）。

### 里程碑 4：插件可发版

`.claude-plugin/plugin.json` 版本提到 `0.6.0`，`hooks.json` 的 description 补上新行为，两份 SKILL 同步。

验证：`node --import tsx --test tests/src/claude-plugin-*.test.mjs` → exit 0；`node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` → exit 0。

## Landmines

- **SKILL.md 有唯一源**：改 `packages/cli/skills/coflux/SKILL.md`，然后跑 `node scripts/sync-claude-plugin.mjs` 同步到插件目录；直接改插件目录那份会被 `--check` 判红（`scripts/sync-claude-plugin.mjs:9-14`）。
- **Codex 也真的执行这套 `hooks.json`**，且用的是 Claude 的事件名。`updatedInput` 是 Claude Code 独有契约，本 plan 不用它；但两个新脚本在任何非预期环境下都必须零字节 stdout，否则会污染 Codex 的上下文。
- **`hooks.json` 已有多个条目**：PreToolUse 下两条（cofluxd 信使 + guard）、PostToolUse 下一条（cofluxd 信使）。新增是追加，不要替换既有条目——信使条目断了会让 web 端的 agent 活动状态失效。
- **不要顺手统一 guard 的环境变量判据**。`guard-git-worktree.mjs` 用 `COFLUX_PROJECT_ID` 是它自己的问题，Backlog 里有独立条目（仓库归属校验 + heredoc 误拦），不属于本 plan 的 scope。
- **`--cmd` 的值以 `-` 开头会让 Node `parseArgs` 抛 `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`**，所以 deny 理由与 SKILL 样例里给出的命令必须写成 `--cmd=<值>` 而不是 `--cmd <值>`。
- **命令行 16 KB 上限**由 daemon 侧硬拒（`crates/worker/src/hook.rs:40,285`）。deny 理由里嵌原命令时，超长命令会让给出的替代命令不可用——这种情况下理由里不要硬塞全文。
- **每工作区 8 个 RUNNING 终端上限**，且 exited 条目不会自动从侧栏消失。引导语不要鼓励为每条琐碎命令开终端；SKILL 现有的「一秒钟的终端只是噪音」那段要保留。

## Scope

In scope:
- `integrations/claude-plugin/scripts/`（两个新脚本）
- `integrations/claude-plugin/hooks/hooks.json`
- `integrations/claude-plugin/.claude-plugin/plugin.json`
- `packages/cli/skills/coflux/SKILL.md`（唯一源）
- `integrations/claude-plugin/skills/coflux/SKILL.md`（同步产物）
- `tests/src/claude-plugin-background.test.mjs`（新）
- `plans/098-*.md`、`plans/README.md`

Out of scope:
- `cofluxd` 任何新子命令（`terminal run` / `terminal stop`）——透明改写方案已否决，这些只为它服务
- 任何 Rust / proto / daemon / server / web 改动——本 plan 纯 JS + 文档
- `guard-git-worktree.mjs` 的仓库归属校验与 heredoc 误拦修复——Backlog 独立条目
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 这类全局开关——会连带废掉 subagent 后台化与 Ctrl+B，太钝
- 插件发版本身——需要用户把 SHA 交给 plugins-builder 会话

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 新增单测 | `node --import tsx --test tests/src/claude-plugin-background.test.mjs` | exit 0 |
| 插件相关单测 | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL 同步校验 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| hooks.json 合法 | `node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` | exit 0 |
| 插件目录零汉字 | `! grep -rlP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` | 无输出 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | 276+ 全过 |

## Done criteria

- [ ] 上述命令全过。
- [ ] coflux 会话里 `Bash(run_in_background: true)` 被 deny，理由含可直接执行的 `cofluxd terminal new --title=… --cmd=…`。
- [ ] 含 `cofluxd terminal` 的命令与 `sleep` 开头的命令不被拦。
- [ ] 非 coflux 会话 / 非 Bash / 坏 JSON / 非后台调用，两个新脚本都零字节 stdout 且退出 0。
- [ ] SKILL 里有「开终端 → 后台跑 `wait` → 被唤醒后 `read`」的完整配方，且注明 `wait` 退出码恒 0。
- [ ] 里程碑 3 的前提实测有明确结论并记录在案（做成了，或按 STOP 停下并降级为已知缺口）。
- [ ] 插件版本 0.6.0，两份 SKILL 一致，插件目录全英文。
- [ ] 没有改动 scope 外的文件。
- [ ] `plans/README.md` 已回写。

## STOP conditions

- PostToolUse 在自动后台化时不触发，或读不到 `backgroundTaskId` / `timedOutAfterMs`——停下报告，里程碑 3 降级，不要用轮询或别的机制硬凑。
- Decisions 里引用的事实不再成立（尤其 `cofluxd.mjs:945-948` 的中心依赖注释、`sync-claude-plugin.mjs` 的唯一源关系）。
- 实现需要动 Rust / proto / daemon。
- 同一个验证命令在一次合理修复后仍然连续失败两次。

## Maintenance notes

- **发版路径**：改完插件要提 version（本 plan 已提到 0.6.0）、push，再把 SHA 交给 plugins-builder 会话发市场版本。用户侧 `/plugin` 更新后才生效，Codex 需要重新信任新的 hook 条目。
- **已知缺口（本 plan 不解决）**：① agent 在前台 Bash 里手写 `cmd &` / `nohup` 自行后台化，PreToolUse 的布尔判据看不见，PostToolUse 也拿不到泄漏字段；② 前台超时自动后台化只能播报、无法强制外化；③ deny 之后 agent 若坚持前台硬跑长命令，本 plan 不拦（拦不住——PreToolUse 无从判断时长）。三者的唯一完整封口是 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，代价是连带废掉 subagent 后台化与 Ctrl+B，已判定太钝；若将来用户愿意接受，可作为可选开关立项。
- **本机隐患（与本 plan 无关，顺带记录）**：立项调研时发现本机同时跑着四个 daemon 进程（launchd 两个 + `~/.codex/worktrees/3577/coflux/target/debug/` 两个），CLI 连哪个取决于 gateway summary 文件。调试 agent 命令行为时若结果反常，先确认连的是哪个 daemon。
- 本 plan 的调研结论（两条不可见路径、`updatedInput` 的五条硬伤、coflux 终端与 Claude 后台 Bash 的完整能力差异表）保存在 Decisions & tradeoffs 里，将来若有人再提「透明劫持」，先读那一节。
