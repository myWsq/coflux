# Plan 099：拆除 Claude 插件的后台 Bash 拦截与播报，SKILL 的「用终端替代后台化」劝导弱化为用法说明

> 本 plan 是**结果契约，不是操作脚本**。读懂需求与已定决策，然后对着活代码自己设计实现。
> 里程碑验证由实现者自己跑（self-execution）。命中任一 STOP 条件即停。
> 完成后回写 `plans/README.md`。
>
> 漂移检查：`git diff --stat 3173ce2..HEAD -- integrations/claude-plugin packages/cli/skills tests/src/claude-plugin-background.test.mjs tests/src/claude-plugin-session-context.test.mjs tests/src/claude-plugin-guard.test.mjs scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（逆向收口 098；不动 095 的 worktree guard 与 096 的 SessionStart 块结构）
- Category: dx
- Execution: self
- Planned at: `3173ce2`, 2026-09-10

## Requirement

plan 098（插件 0.6.0，已上市场）给 coflux 工作区里的 agent 加了一套「不可见后台进程外化」机制：PreToolUse 拒绝 `Bash(run_in_background: true)` 并塞一段「改用 `cofluxd terminal new`、再后台跑 `wait`」的教程；PostToolUse 认出 Bash 结果里的 `backgroundTaskId` 就往工作区卡片写一句 "Heads-up: a background task you cannot see…"。用户用了两天的结论：**这套拦截太难用**，agent 失去宿主原生的后台 Bash 流程（流式输出、自动唤醒、无中心依赖），换来的是绕路开终端、再后台跑 wait 的两步舞。用户决定去掉这个机制，并且连 SKILL 里「用终端替代自己后台化」的劝导也一起弱化——coflux 终端是一种能力，什么时候用由 agent 自己判断，插件不再替它做这个选择。

消费者是在 coflux 终端里运行的 agent（Claude Code / Codex），间接消费者是看工作区卡片的用户。完成后为真：

- **对 agent**：coflux 工作区里 `Bash(run_in_background: true)` 走宿主正常权限流程，不再被 deny，不再收到任何「改用 cofluxd terminal new」的引导文本。
- **对用户**：Bash 结果带 `backgroundTaskId`（显式后台或超时自动后台化）时，工作区卡片不再出现 "Heads-up…" 播报；卡片上的 progress 只剩 agent 自己写的那句。
- **对 agent 读到的一切插件文本**（SKILL、`<coflux-session>` 块、hooks.json description、plugin.json description）：不再要求或劝 agent 用 coflux 终端替代自己的后台 Bash。coflux 终端被描述为一种能力——用户能在侧栏看到、能接管、事后能读日志——以及它适合的场景；何时用由 agent 判断。终端各命令（new / list / read / wait / send / progress / notify / ports）的用法说明、`--cmd=<值>` 写法、`wait` 恒 exit 0 看 `# exited exit=N`、「开终端 → 后台跑 wait → 被唤醒后 read」的配方都保留，只是改为用法说明的口吻。
- **不变**：worktree guard（`guard-git-worktree.mjs`）行为一字不改；cofluxd 信使 hook 全部在位；`<coflux-session>` 块的结构、坐标行、两轨规则、worktree 引导、skill 指针不变。

## Decisions & tradeoffs

- **两个脚本全拆，播报器不单独保留**。Rejected：只拆 PreToolUse deny、留 PostToolUse 播报——播报器只是拦截的配套（它存在的理由是补拦不住的「前台超时自动后台化」那条路，见 `integrations/claude-plugin/scripts/report-background-task.mjs` 头注释）；拦截一去，每次显式后台 Bash 都会触发它，用 "Heads-up: a background task you cannot see…" 冲掉 agent 真正写的 progress 一句话，而且文案还在劝用户「让 agent 改成终端」，与新立场自相矛盾。Based on: `integrations/claude-plugin/scripts/report-background-task.mjs:1-12`（「leak reporter, not a guard」）；`integrations/claude-plugin/hooks/hooks.json`（PreToolUse 第三条、PostToolUse 第二条是 098 加的两条 `matcher: "Bash"` 条目，`git diff 8de554e..HEAD -- integrations/claude-plugin/hooks/hooks.json` 可对照）。

- **hooks.json 只删 098 加的两条 Bash 条目与 description 尾段，其余条目一字不动**。Rejected：顺手重排/合并条目——各事件下无 matcher 的 `cofluxd hook claude` 信使条目断了，web 端 agent 活动状态就失效；SessionStart 的 `session-context.sh` 条目与 PreToolUse 的 `guard-git-worktree.mjs` 条目分别属于 096/095，不在本 plan 范围。Based on: `integrations/claude-plugin/hooks/hooks.json`；`integrations/claude-plugin/README.md`「Components → hooks/」。

- **SKILL 弱化的边界：删劝导与拦截指涉，留能力描述与用法**。具体不变量：
  ① 删掉 098 加的整段 "Inside a coflux workspace the plugin enforces this: … (see below)."；
  ② "When to open a terminal" 一节不再以「**instead of backgrounding a process yourself**」开头，不再有「Backgrounded in your own Bash, the user **sees nothing**」这类对立/恐吓措辞；改写为：coflux 终端给你什么（侧栏可见、可接管、可读回日志）、适合什么场景（交互式、用户可能要接管、常驻服务、想给用户一个可点的入口），作为一个选项陈述；「一秒钟的命令别开终端，一堆一秒钟终端对用户是噪音」保留；
  ③ "Wait for a command to finish" 里的配方保留，但删掉 "that is the one backgrounded call the plugin allows, because the work itself is already visible" 这类指涉拦截的话；
  ④ frontmatter `description` 与开头段落里 "externalize long tasks … into real terminals" 的口吻改为能力描述；
  ⑤ 两轨规则表、坐标表、MCP 章节、Boundaries、`--cmd=<值>` 说明、`wait` 恒 exit 0 说明全部不动。
  Rejected：整节删除「When to open a terminal」——用户要的是弱化不是抹掉，agent 仍需要知道终端能给用户什么才能自己判断。Rejected：保留劝导只删拦截段——用户在出发检查里明确选了「连 SKILL 的建议也弱化」。Based on: `packages/cli/skills/coflux/SKILL.md:56-77,134-144`（当前劝导与拦截指涉所在）；`git diff 8de554e..HEAD -- packages/cli/skills/coflux/SKILL.md`（098 加的三段）。

- **SKILL 只改唯一源，再同步**。`packages/cli/skills/coflux/SKILL.md` 是唯一源，改完跑 `node scripts/sync-claude-plugin.mjs` 得到插件目录那份；CI 用 `--check` 比对。Rejected：直接改插件目录那份——`--check` 判红。Based on: `scripts/sync-claude-plugin.mjs:9-14`。

- **`<coflux-session>` 块只改 Rule 行括号里的那半句**。"run anything long or interactive in a terminal the user can see" 改为能力描述（例如 "open a terminal the user can watch and take over"）；坐标行、两轨规则、`create_workspace` 引导、skill 指针不动。Rejected：整行重写——测试断言了 `cofluxd terminal`、`cofluxd progress|notify|ports`、`MCP`、`create_workspace`、`coflux.*skill` 与块 < 2048 字节，并未断言那半句原文，改半句零风险，重写整行没有收益。Based on: `integrations/claude-plugin/scripts/session-context.sh`；`tests/src/claude-plugin-session-context.test.mjs:51-57`。

- **plugin.json 版本 0.6.0 → 0.7.0**，description 里 "teaches agents to externalize work into terminals the user can see and take over" 改成能力描述。Rejected：patch 号——README 只要求 SemVer 严格递增，095（0.4.0）/096（0.5.0）/098（0.6.0）先例是行为变更走 minor，本次是行为变更。Based on: `integrations/claude-plugin/.claude-plugin/plugin.json`；`integrations/claude-plugin/README.md`「Maintenance」。

- **测试：删整个 `tests/src/claude-plugin-background.test.mjs`，只把「插件目录全英文」用例挪走**。该文件 14 条里 13 条只测两个被删脚本、「hooks.json 含 guard-background-bash / 版本 ≥ 0.6.0」、「SKILL 有被拒配方」，随脚本失效；「插件目录全英文：没有汉字」是 096 全英文约定的**唯一守卫**，必须先挪进 `tests/src/claude-plugin-session-context.test.mjs` 或 `tests/src/claude-plugin-guard.test.mjs`（执行者定）并跑绿，再删文件。Rejected：保留文件只删用例——文件名和头注释都在讲 098 的机制，留一个只剩一条用例的壳子误导人。Based on: `tests/src/claude-plugin-background.test.mjs:279-291`（零汉字用例）；`grep -n '4e00\|汉字' tests/src/claude-plugin-*.test.mjs` 只命中该文件。

- **插件目录内一切文案全英文**（096 约定，本 plan 沿用）。Based on: `plans/096-claude-plugin-session-context.md`；零汉字用例。

- **(decided while planning) README（插件目录）不主动改**。它目前没提后台 guard，hooks 条目仍是「三类」；只有执行时发现其中有劝导终端替代后台 Bash 的措辞才同样弱化。Based on: `integrations/claude-plugin/README.md`「Components」。

## Direction

两个里程碑**顺序执行**，不拆并发：M2 的 SKILL 文案与 M1 的 hooks/测试互相引用（测试断言 SKILL、hooks.json description 引用脚本），拆开只会各自红。

插件目录（`integrations/claude-plugin/**`）内的一切文案**必须全英文**。plan 正文和测试用例中文照旧。

### 里程碑 1：hook 机制拆除，测试收口

`guard-background-bash.mjs` 与 `report-background-task.mjs` 删除；hooks.json 去掉对应两条 `matcher: "Bash"` 条目与 description 尾段，其余条目原样；`session-context.sh` Rule 行那半句改为能力描述；plugin.json 版本 0.7.0、description 改口吻。零汉字用例挪进现有插件测试文件后，删掉 `tests/src/claude-plugin-background.test.mjs`。

验证：`node --import tsx --test tests/src/claude-plugin-*.test.mjs` → exit 0；`node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` → exit 0；`sh -n integrations/claude-plugin/scripts/session-context.sh` → exit 0；残留检查（见 Commands）无输出。

### 里程碑 2：SKILL 劝导弱化并同步

按 Decisions 里五条不变量改 `packages/cli/skills/coflux/SKILL.md`，跑 `node scripts/sync-claude-plugin.mjs` 同步。

验证：`node scripts/sync-claude-plugin.mjs --check` → exit 0；插件目录零汉字 grep 无输出；`grep -n -i -E 'instead of backgrounding|sees nothing|plugin allows|enforces this|is \*\*denied\*\*' packages/cli/skills/coflux/SKILL.md` 无输出。

## Landmines

- **本会话是 coflux 项目会话（`COFLUX_PROJECT_ID` 非空）**：插件自己的 `guard-git-worktree.mjs` 对整段 Bash 命令文本做正则，**heredoc 正文与 commit message 里出现「git … worktree add|remove|move」字样也会被 deny**（`plans/README.md` Backlog 有记录）。写文件用 Write/Edit 工具，commit message 避免这几个词连写。本 plan 留在 main，不需要建 worktree。
- **SKILL 两份必须一致**：改唯一源后必须跑同步脚本，否则 `--check` 红（`scripts/sync-claude-plugin.mjs:9-14`）。
- **hooks.json 是手写 JSON**：删条目时留意数组尾逗号；PreToolUse 数组删掉第三个元素后仍应剩两个（信使 + worktree guard），PostToolUse 剩一个（信使）。
- **全量黑盒 `pnpm -C tests test` 不要跑**：本机装了 coflux，agent-activity 的 presence/hook 三条靠进程树认 claude 进程，必红且会卡住整套；本 plan 零 Rust/server/daemon/proto 改动，插件三份单测 + sync --check 足够。
- **零汉字用例先挪后删**：删 `claude-plugin-background.test.mjs` 前那条用例必须已在别处跑绿，否则 096 约定失守而没人发现。
- **`.claude/worktrees/20260908-codex-agent-tab` 里有 098 文件的副本**：那是别的分支的 linked worktree，不属于本 plan，别去动；残留检查的 grep 范围要限定在 `integrations/claude-plugin packages/cli/skills tests/src`，别扫到它。

## Scope

In scope:
- `integrations/claude-plugin/hooks/hooks.json`
- `integrations/claude-plugin/scripts/guard-background-bash.mjs`（删除）
- `integrations/claude-plugin/scripts/report-background-task.mjs`（删除）
- `integrations/claude-plugin/scripts/session-context.sh`
- `integrations/claude-plugin/.claude-plugin/plugin.json`
- `integrations/claude-plugin/skills/coflux/SKILL.md`（同步产物）
- `integrations/claude-plugin/README.md`（仅当发现劝导措辞时）
- `packages/cli/skills/coflux/SKILL.md`（唯一源）
- `tests/src/claude-plugin-background.test.mjs`（删除）
- `tests/src/claude-plugin-session-context.test.mjs` 或 `tests/src/claude-plugin-guard.test.mjs`（接收零汉字用例）
- `plans/099-*.md`、`plans/README.md`

Out of scope:
- `integrations/claude-plugin/scripts/guard-git-worktree.mjs` 的仓库归属校验与 heredoc 误拦——Backlog 独立条目
- 任何 Rust / proto / daemon / server / web 改动——本 plan 纯 JS + 文档
- `.claude/worktrees/20260908-codex-agent-tab/**`——别的分支的副本
- 市场发版——改完提版本、push、把 SHA 交给 plugins-builder 会话，由用户发起
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 之类的全局开关——与本 plan 方向相反

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 插件单测 | `node --import tsx --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| SKILL 同步校验 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| hooks.json 合法 | `node -e "JSON.parse(require('fs').readFileSync('integrations/claude-plugin/hooks/hooks.json','utf8'))"` | exit 0 |
| session 块语法 | `sh -n integrations/claude-plugin/scripts/session-context.sh` | exit 0 |
| 插件目录零汉字 | `! grep -rlP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` | 无输出 |
| 机制残留 | `! grep -rn -E 'guard-background-bash\|report-background-task\|run_in_background\|backgroundTaskId' integrations/claude-plugin packages/cli/skills tests/src` | 无输出 |
| SKILL 劝导残留 | `! grep -n -i -E 'instead of backgrounding\|sees nothing\|plugin allows\|enforces this' packages/cli/skills/coflux/SKILL.md` | 无输出 |
| 真实模拟 | `COFLUX_WORKSPACE_ID=x COFLUX_PROJECT_ID=p` 下把 `{"tool_name":"Bash","tool_input":{"command":"pnpm test","run_in_background":true}}` 喂给 hooks.json 里剩余的每个 Bash matcher 脚本 | 零 stdout、exit 0 |

## Done criteria

- [ ] 上述命令全过。
- [ ] hooks.json 里不再有 `guard-background-bash.mjs` / `report-background-task.mjs` 条目，信使、SessionStart、worktree guard 条目原样在位。
- [ ] 两个脚本与 `claude-plugin-background.test.mjs` 已删除，零汉字用例在别的插件测试文件里跑绿。
- [ ] SKILL（两份一致）、`<coflux-session>` 块、hooks.json description、plugin.json description 都不再劝 agent 用终端替代后台 Bash；终端命令用法与 wait 配方仍在。
- [ ] 插件版本 0.7.0，插件目录全英文。
- [ ] 没有改动 scope 外的文件。
- [ ] `plans/README.md` 已回写（098 行补注被 099 拆除，099 行 DONE，执行顺序追加）。

## STOP conditions

- Decisions 里引用的事实不再成立（尤其 `sync-claude-plugin.mjs` 的唯一源关系、hooks.json 的条目布局、零汉字用例只在 background 测试文件里）。
- 实现需要动 Rust / proto / daemon / server / web。
- 同一个验证命令在一次合理修复后仍然连续失败两次。

## Maintenance notes

- **098 的调研结论仍有效，只是方向被用户否决**：两条不可见后台路径（显式 `run_in_background` 可拦、前台超时自动后台化不经 PreToolUse）、`updatedInput` 透明改写的五条硬伤、coflux 终端与 Claude 后台 Bash 的能力差异，都还在 `plans/098-claude-plugin-background-visibility.md` 的 Decisions 里。将来若再有人提「拦截/劫持后台 Bash」，先读 098，再读本 plan 的 Requirement 看用户为什么否决。
- **发版路径**：本 plan 改完插件版本已提到 0.7.0；push 后把 SHA 交给 plugins-builder 会话发市场版本；用户侧 `/plugin` 更新后生效，Codex 会因 hooks.json 变化重新要求信任一次。市场文档 `docs/coflux.md`（builder 仓库）的 Hooks 条目在 098 发版时被 builder 补过后台 guard 的描述，发版时要一并删掉。
- **`.claude/worktrees/20260908-codex-agent-tab` 分支**仍带着 098 的文件；那条分支合并回 main 时会与本 plan 冲突（hooks.json / SKILL / 测试），解决冲突时以本 plan（删除）为准。
