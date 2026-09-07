# Plan 096: Claude 插件 SessionStart 注入 coflux 坐标——`<coflux-session>` 块替代 agent 自查环境变量，插件全英文化

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 5d0c157..HEAD -- integrations/claude-plugin packages/cli/skills tests/src plans`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（消费 092 的 `COFLUX_*` 注入与 095 的插件交付目录，均已上线）
- Category: feature
- Execution: self（出发检查 2026-09-07：用户「开搞」，写完 plan 立即执行；市场发版前停下问一次）
- Planned at: `5d0c157`, 2026-09-07

## Requirement

coflux 插件现在把「我在哪、该怎么干」全放在 14 KB 的 SKILL 里，靠 description 触发；agent 装载后还要自己
`env | grep COFLUX_` 才知道坐标，上下文一压缩坐标就丢。本机的 dev 插件（0.18.0）用 SessionStart hook 输出
`additionalContext` 把必要信息主动注入，用户 2026-09-07 拍板 coflux 也这么做：**会话开始就把坐标和一条分工规则
装进一个 `<coflux-session>` 标签块注入，SKILL 退为细则**。同时用户要求**插件目录整体改成英文（含 SKILL）**。

**做完之后为真**（消费者 = 装了 coflux 插件、跑在 coflux 终端里的 Claude Code / Codex）：

1. 会话环境里 `COFLUX_WORKSPACE_ID` 非空时，SessionStart（startup / resume / clear / compact / fork 全部来源）
   hook 往 stdout 打一个 `<coflux-session>…</coflux-session>` 纯文本块：六个 `COFLUX_*` 变量按 `KEY=value` 逐行
   列出、一句「你在 coflux 终端里，用户看得见能接管」、一条分工规则（本工作区内用零凭证本地命令，跨出本工作区才用
   MCP，不要自己开 worktree）、一个指向 coflux skill 的指针。不含整份 SKILL。
2. `COFLUX_WORKSPACE_ID` 为空或不存在时零输出、退出 0；脚本文件缺失时同样静默。绝不打扰不在 coflux 里的用户。
3. SKILL「先判断自己在哪」改为：有 `<coflux-session>` 块直接用；没有（Codex 未信任 hook、手工接 hook、没装插件）
   再看环境变量。环境变量表保留。
4. 插件交付目录（README、hooks.json description、两个脚本的注释与提示文案、SKILL）全部英文；SKILL 唯一源
   `packages/cli/skills/coflux/SKILL.md` 同步改英文（npm 那份随之英文化，语义零变化）。
5. 插件版本 0.4.1 → **0.5.0**；市场按新 SHA 收录发布。不动 daemon、server、CLI 代码。

**相邻的错误解法**：不是把整份 SKILL 通过 hook 注入（每次 session 和每次压缩都付 14 KB）；不是 UserPromptSubmit
（每条 prompt 都注入，太吵）；不是让 hook 打 daemon 查「连没连上中心」（SessionStart 要快，状态一会儿就过时，
也违反 local-first 的「hook 不多一趟」）；不是改 `cofluxd hook` 信使（它「绝不写 stdout」的约定不能破）。

## Decisions & tradeoffs

- **纯 `sh` 脚本 + 纯文本 stdout，不用 node、不用 JSON**：SessionStart 的纯文本 stdout 在 Claude Code（文档
  hooks.md：「plain text printed to stdout by a SessionStart hook is added directly into Claude's context」）和
  Codex 0.153（`codex-rs/hooks/src/events/session_start.rs` 的 `parse_completed`：非 JSON 的 stdout 整段成为
  additional context；空 stdout + exit 0 为无操作）里都直接进模型上下文。`printf '%s\n' …` 把变量当参数传，
  没有格式串注入。Rejected: node 出 `hookSpecificOutput.additionalContext` JSON——多一个依赖，换不来任何宿主兼容性。
  Based on: 2026-09-07 经 context7 核实的两家文档/源码；`hooks/hooks.json` 现有条目风格。

- **hooks.json 新增 `SessionStart` 条目，不设 matcher**：Claude Code 的 matcher 值是 startup / resume / clear /
  compact / fork，不设即全部触发；compact 那次就是压缩后自动补回坐标。Codex 的 session_start matcher 输入也是
  source，语义相同。命令沿用 guard 的静默包装：`sh -c '[ -r "$0" ] && exec sh "$0" || :' "${CLAUDE_PLUGIN_ROOT}/scripts/session-context.sh"`，
  脚本缺失零输出。Rejected: `matcher: "startup|compact"`——resume/clear/fork 同样丢上下文。
  Based on: hooks.md SessionStart 一节；`~/.codex/config.toml` 里 `coflux@plugins:hooks/hooks.json:pre_tool_use:1:0`
  的 trusted_hash 证明 Codex 0.153 已在执行本插件的 hooks.json，且官方 codex 插件用 `${CLAUDE_PLUGIN_ROOT}` 写
  SessionStart 命令，证明 Codex 展开该变量。

- **块内容以 `KEY=value` 列六个变量**：agent 可把 id 直接填进 MCP 参数，与 SKILL 的变量表一一对应，不另造名字。
  `COFLUX_PROJECT_ID` 为空串（目录工作区）时照打空值，由紧随的一行说明解释。
  Based on: `crates/supervisor/src/sessions.rs:824-829` 六个变量恒在、缺失为空串。

- **整个插件目录英文化，SKILL 唯一源一并英文化**：用户明确要求；SKILL 的 npm 拷贝与插件拷贝由
  `scripts/sync-claude-plugin.mjs --check` 锁定一致，只能一起改。guard 的 deny 文案改英文，既有测试只断言 id
  与 tool 名，不受语言影响。仓库内的 plan、CI 注释、sync 脚本提示不在插件目录，保持中文。

- **测试放 `tests/src/claude-plugin-session-context.test.mjs`（纯单元，不起栈）**：子进程 `sh` 跑脚本、喂 env，
  断言块结构与六行变量、三类静默情形、hooks.json 结构（SessionStart 条目无 matcher 且引用脚本、信使条目不动）、
  版本 ≥ 0.5.0、SKILL 提到 `<coflux-session>`。Based on: plan 095 的测试先例。

## Direction

### Milestone 1: 注入脚本 + hooks.json + SKILL + 英文化 + 版本

`scripts/session-context.sh`、hooks.json 条目与 description、guard 注释/文案英文、SKILL 唯一源英文重写并同步、
插件 README 英文重写、`plugin.json` 0.5.0、新测试。
Validation: `node -e 'JSON.parse(…hooks.json)'` -> exit 0；`sh -n scripts/session-context.sh` -> exit 0；
`node scripts/sync-claude-plugin.mjs --check` -> exit 0；
`cd tests && node --import tsx --test src/claude-plugin-session-context.test.mjs src/claude-plugin-guard.test.mjs` -> 全过；
`grep -rP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` -> 无输出。

### Milestone 2: 上市场

提交并 push coflux main；plugins-builder 的 `catalog/plugins/coflux.json` 更新 `origin.sha`/`ref`；`npm run verify`；
`npm version minor`；`git push origin main --follow-tags`；确认 `myWsq/plugins@main` 的 `plugins/coflux` 为 0.5.0。
**发版前停下问用户**（builder 工作树有用户在途的 dev 插件改动，只能单独提交 descriptor）。

## Landmines

- stdout 只能是这个块：脚本里任何调试输出都会混进模型上下文；Codex 侧 stdout 若「看起来像 JSON」却解析失败会把
  hook 记为 Failed，所以块必须以 `<` 开头、绝不以 `{` 开头。
- Codex 对新 hook 条目要用户信任一次（`hooks.state` 的 trusted_hash 按条目 hash 记录）；信任前该条目不执行，
  agent 退回环境变量路径，SKILL 必须继续自足。
- `hooks/hooks.json` 既有 8 个事件的信使条目与 PreToolUse 的 guard 条目一律不动，只新增 `SessionStart` 键。
- 交付目录整目录发布：`scripts/` 里只放两个脚本，不放测试。
- `plugin.json` 版本不提，builder 发布门禁会拒。
- 英文化不得改语义：SKILL 的每条纪律、每个上限（16 KB / 64 KB / 30 分钟 / 600 s / 8 个终端）逐条对照。
- 本仓库里 Bash 写含 `git worktree add` 字样的文件会被 guard 自己拦下（plan 095 接受的误拦）；这类文件用 Write
  工具写，或者措辞绕开。

## Scope

In scope:
- `integrations/claude-plugin/{hooks/hooks.json, scripts/session-context.sh, scripts/guard-git-worktree.mjs, skills/coflux/SKILL.md, .claude-plugin/plugin.json, README.md}`
- `packages/cli/skills/coflux/SKILL.md`（英文化，语义零变化）
- `tests/src/claude-plugin-session-context.test.mjs`（新）
- `plans/README.md`
- plugins-builder：`catalog/plugins/coflux.json`（仅 SHA/ref）

Out of scope:
- `crates/`、`apps/server`、`packages/cli/cofluxd.mjs` — 不动
- `cofluxd hook` 信使接 SessionStart 事件 — 状态判定不需要
- 在 hook 里查 daemon 在线状态 / 终端列表 — 违反「快、不多一趟」
- guard 只看 `COFLUX_PROJECT_ID` 不校验仓库归属的误拦（plugins-builder 会话 2026-09-07 报告）— 需要 daemon 注入
  工作区路径，另立项，见 `plans/README.md` Backlog

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| hooks 配置合法 | `node -e 'JSON.parse(require("fs").readFileSync("integrations/claude-plugin/hooks/hooks.json","utf8"))'` | exit 0 |
| 脚本语法 | `sh -n integrations/claude-plugin/scripts/session-context.sh` | exit 0 |
| SKILL 两份一致 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| 插件目录无中文 | `grep -rP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` | 无输出 |
| 单测 | `cd tests && node --import tsx --test src/claude-plugin-session-context.test.mjs src/claude-plugin-guard.test.mjs` | 全过 |
| 市场构建 (acceptance) | plugins-builder `npm run verify` | exit 0 |

## Done criteria

- [x] All listed commands pass.
- [x] coflux 终端里的会话开始即有 `<coflux-session>` 块，含六个 `COFLUX_*=…` 行、分工规则与 skill 指针。
- [x] 不在 coflux 里零输出、退出 0；脚本缺失静默。
- [x] 插件目录全英文，SKILL 两份一致且语义与中文版逐条对应。
- [x] 插件 0.5.0 已在 `myWsq/plugins@main`。
- [x] No out-of-scope files changed.
- [x] `plans/README.md` status is updated.

## STOP conditions

- 实现时发现 Claude Code 或 Codex 不把 SessionStart 的纯文本 stdout 当上下文（与 2026-09-07 核实相悖）。
- builder `npm run verify` 或发布门禁失败且原因不在本 plan 范围内。

## Maintenance notes

- 以后要往块里加信息（比如工作区名、分支）只改 `session-context.sh` 并提插件版本；信息源仍限环境变量，
  要打 daemon 的都不进这个 hook。
- Claude Code 的 SessionStart 不对 subagent 触发；subagent 若需坐标，由主 agent 在 prompt 里转述。
- Codex 用户第一次会看到本插件新增 hook 的信任提示，是宿主机制，不是插件故障。
- guard 的仓库归属误拦（在 coflux 会话里对临时仓库或任何别的仓库开 worktree 也会被拒，且提示的 projectId 指向
  继承来的项目）：根治要 supervisor 注入 `COFLUX_WORKSPACE_PATH`，guard 再拿 stdin 的 `cwd`（以及命令里的
  `git -C <dir>` / `cd <dir> &&`）解析出实际仓库与之比对，不一致即放行。同一报告还提了 `create_workspace` 的
  `createNew` 缺基点参数（startPoint）、返回里的 `path` 字段没写进 tool 描述。均记入 Backlog。
