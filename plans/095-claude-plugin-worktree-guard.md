# Plan 095: Claude 插件拦截 git worktree——coflux 项目会话里把 agent 引导到 create_workspace / remove_workspace

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat eecf8d6..HEAD -- integrations/claude-plugin packages/cli/skills tests/src scripts/sync-claude-plugin.mjs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（插件交付目录已随 `eecf8d6` 上市场，0.3.0）
- Category: feature
- Execution: self（出发检查 2026-09-06：写完 plan 立即执行，直到市场发版；STOP/BLOCK 仍停）
- Planned at: `eecf8d6`, 2026-09-06

## Requirement

coflux 的工作区就是 git worktree 加一条中心记录（id、名称、终端归属、分支与 diff 统计、`COFLUX_*`
注入）。跑在 coflux 项目会话里的 Claude Code 若自己 `git worktree add`，出来的目录用户在侧栏看不见、
也开不了终端；SKILL 虽写了「开子工作区用 `create_workspace`」，但只靠文字约束不牢。用户 2026-09-06
拍板：**用 Claude Code 的 PreToolUse hook 拦下这类命令并把 agent 引导到 MCP 的工作区操作**（方案一）；
「daemon 认领外来 worktree」的方案三另立项。

**做完之后为真**（消费者 = 跑在 coflux 项目会话里的 Claude Code）：

1. 会话环境里 `COFLUX_PROJECT_ID` 非空，且 Bash 工具调用的命令里含 `git … worktree add|remove|move`
   时，调用被 deny；理由一句话讲清为什么（coflux 看不见）和改怎么做（`create_workspace`，projectId 用
   `$COFLUX_PROJECT_ID`；删除用 `remove_workspace`；查看用 `git worktree list` 或 `list_workspaces`）。
2. 以下情形 hook **不输出任何决定**（正常权限流程照走）：`COFLUX_PROJECT_ID` 为空或不存在（不在 coflux
   项目里，含目录工作区）；命令是 `git worktree list|lock|unlock|prune|repair`；工具不是 Bash；stdin 不是
   合法 JSON；`node` 不存在。任何异常都不得误拦。
3. 只改插件交付目录（`hooks/hooks.json` 加一条、`scripts/` 加脚本、SKILL 加一句）与 SKILL 唯一源；
   插件版本 0.3.0 → **0.4.0**；市场按新 SHA 收录发布。不动 daemon、server、CLI。
4. 只对 Claude Code 生效；Codex 与用户手敲的命令不受影响。

**相邻的错误解法**：不是 PATH 里塞 git 垫片（会连用户命令一起拦，且要改 supervisor）；不是改
`cofluxd hook` 信使（它「绝不写 stdout」的约定是 hook 契约的一部分，拦截脚本必须是独立的一条 hook）；
不是用 `"ask"`（要的是引导，不是让用户点确认）；不是拦 `list`/`prune`。

## Decisions & tradeoffs

- **独立的一条 hook，`matcher: "Bash"`，脚本随插件走**：`hooks.json` 的 `PreToolUse` 数组里新增一项
  `{"matcher":"Bash","hooks":[{"type":"command","command":"…${CLAUDE_PLUGIN_ROOT}/scripts/…"}]}`，与既有
  无 matcher 的信使条目并存（Claude 对同一事件的多条 hook 并行跑，各自独立决定）。Rejected: 把拦截
  塞进 `cofluxd hook`——信使绝不写 stdout，且它随 npm 版本漂移，插件里的脚本随插件版本锁定。
  Based on: Claude Code 文档 hooks.md / plugins-reference.md（2026-09-06 经 claude-code-guide 核实：
  matcher 为工具名精确匹配；`${CLAUDE_PLUGIN_ROOT}` 在插件 hooks 命令里展开；hook 进程继承 Claude 的
  环境变量；多 hook 并行）；`integrations/claude-plugin/hooks/hooks.json` 现有条目风格。

- **deny 用 stdout JSON 而不是退出码 2**：`{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"deny","permissionDecisionReason":"…"}}`，退出 0；理由会喂给模型。不拦时**不输出
  任何字节**并退出 0（= 无意见，走正常权限流程）。Rejected: 退出码 2 + stderr——适合无条件硬拦，这里要
  按命令内容条件判断，文档推荐 JSON。
  Based on: hooks.md「PreToolUse 决策」；stdout 必须是纯 JSON，多余文本会让决策解析失败。

- **脚本用 node，缺 node 时静默放行**：命令写成 `sh -c 'command -v node >/dev/null 2>&1 && exec node
  "$0" || :' "${CLAUDE_PLUGIN_ROOT}/scripts/<脚本>"`，与既有信使条目同一风格；stdin 读法照
  `cofluxd hook` 的 `readStdinJson`（isTTY 短路、超时放手、解析失败当 null）。Rejected: 纯 sh 解析 JSON——
  没有 jq 可依赖；cofluxd 本身就要求 node。
  Based on: `packages/cli/cofluxd.mjs:873-882`；`hooks/hooks.json` 现有 `sh -c 'command -v cofluxd … || :'`。

- **匹配规则：命令串里任一处 `git [全局选项…] worktree (add|remove|move)`**：允许 `git -C <dir>` 一类
  全局选项，允许出现在 `cd x && …`、`;`、`|` 之后；`list|lock|unlock|prune|repair` 放行。宁可误拦
  `echo "git worktree add"` 这种极端字符串，也不漏拦。Rejected: 完整 shell 解析——为一条引导 hook 不值。
  Based on: 需求第 1、2 条。

- **理由文案带上 `COFLUX_PROJECT_ID` 的实际值**，agent 可直接填进 `create_workspace`；文案同时给
  删除与查看的替代做法，避免 agent 换个 git 子命令再试。

- **测试放 `tests/src/claude-plugin-guard.test.mjs`（纯单元，不起栈）**：子进程跑脚本，喂 env + stdin，
  断言 deny/无输出两类情形各覆盖；另断言 `hooks.json` 可解析且含 `matcher: "Bash"` 的条目引用该脚本、
  `plugin.json` 版本严格大于 0.3.0。Rejected: 把测试放进交付目录——契约是整目录发布，测试会一起上市场。
  Based on: `tests/src/build-version.test.mjs` 等不起栈的先例；`docs/external-plugins.md` 整目录发布。

- **SKILL 唯一源加一句，同步到插件**：在「中心 MCP：跨出本工作区」段加「不要自己 `git worktree add`，
  coflux 项目里会被拦下并提示改用 `create_workspace`」；`node scripts/sync-claude-plugin.mjs` 同步。
  Based on: plan 094 的 SKILL 唯一源决策；CI 一致性检查。

## Direction

### Milestone 1: 拦截脚本 + hooks.json + SKILL + 版本

脚本、hook 条目、SKILL 一句、`plugin.json` 0.4.0、插件 README 组件说明一句。
Validation: `node -e 'JSON.parse(…hooks.json)'` -> exit 0；`node scripts/sync-claude-plugin.mjs --check` -> exit 0；
`node --import tsx --test tests/src/claude-plugin-guard.test.mjs` -> 全过。

### Milestone 2: 上市场

提交并 push coflux main；plugins-builder 的 `catalog/plugins/coflux.json` 更新 `origin.sha`/`ref`；
`npm run verify`；`npm version minor`；`git push origin main --follow-tags`；确认发布流程成功且
`myWsq/plugins@main` 的 `plugins/coflux` 为 0.4.0 且含 `scripts/`。
Validation（acceptance）：builder `npm run verify` -> exit 0；`gh run watch` 发布 run -> success；
`gh api repos/myWsq/plugins/contents/plugins/coflux/.claude-plugin/plugin.json` 版本 0.4.0。

## Landmines

- `hooks/hooks.json` 现有 `PreToolUse` 条目没有 `matcher`（对所有工具触发信使），新条目是同一数组里的
  第二项，不要改动第一项。
- stdout 必须是纯 JSON：脚本里任何 `console.log` 调试输出都会破坏决策解析；调试信息只能走 stderr
  且默认关闭（沿用 `COFLUX_HOOK_DEBUG`）。
- 交付目录整目录发布：`scripts/` 里只放这一个脚本，不放测试、不放 node_modules；可执行位无所谓（经 node 调用）。
- `plugin.json` 版本不提，builder 的发布门禁会拒（payload 变了）。
- builder 工作树是用户在途工作区，改 descriptor 前先 `git status`，只提交 `catalog/plugins/coflux.json`。

## Scope

In scope:
- `integrations/claude-plugin/{hooks/hooks.json, scripts/, skills/coflux/SKILL.md, .claude-plugin/plugin.json, README.md}`
- `packages/cli/skills/coflux/SKILL.md`
- `tests/src/claude-plugin-guard.test.mjs`（新）
- `plans/README.md`
- plugins-builder：`catalog/plugins/coflux.json`（仅 SHA/ref）

Out of scope:
- `crates/`、`apps/server`、`packages/cli/cofluxd.mjs` — 不动
- Codex 侧拦截 — 无对应机制
- daemon 认领外来 worktree（方案三）— 另立项

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| hooks 配置合法 | `node -e 'JSON.parse(require("fs").readFileSync("integrations/claude-plugin/hooks/hooks.json","utf8"))'` | exit 0 |
| SKILL 两份一致 | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| 拦截脚本单测 | `cd tests && node --import tsx --test src/claude-plugin-guard.test.mjs` | 全过 |
| 市场构建 (acceptance) | plugins-builder `npm run verify` | exit 0 |
| 发布 (acceptance) | `gh run watch <release run> --exit-status` | success |

## Done criteria

- [ ] All listed commands pass.
- [ ] coflux 项目会话里 `git worktree add/remove/move` 被 deny，理由含 `create_workspace` 与 `$COFLUX_PROJECT_ID` 的值。
- [ ] 无 `COFLUX_PROJECT_ID`、只读子命令、非 Bash、坏 JSON 四种情形零输出、退出 0。
- [ ] 插件 0.4.0 已在 `myWsq/plugins@main`，含 `scripts/`。
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Claude Code 文档核实的 hook 契约在实现时被发现不成立（例如插件 hooks 不展开 `${CLAUDE_PLUGIN_ROOT}`）。
- builder `npm run verify` 或发布门禁失败且原因不在本 plan 范围内。

## Maintenance notes

- 方案三（daemon 周期 `git worktree list --porcelain` 认领外来 worktree、同步删除）是更彻底的兜底，待立项。
- 拦截是引导不是安全边界：agent 把命令藏进脚本里跑拦不住，也不打算拦。
- 以后要拦更多命令（比如 `git worktree prune`）只改脚本的匹配表并提插件版本。
