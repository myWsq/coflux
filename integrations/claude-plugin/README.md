# coflux Claude Code 插件

把 Claude Code 接进 [coflux](https://github.com/myWsq/coflux) 指挥中心：一台机器一个 daemon 跑着承载
agent 会话的 PTY，web/手机上能看到每个工作区的实时回合状态并随时接管。

本目录是插件的**交付目录**：自包含、可直接安装，由 `myWsq/plugins` 市场按固定 commit SHA 整目录收集
发布（维护仓库 `myWsq/plugins-builder`），安装者只需访问市场。

## 组件

- **hooks/**：把 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、
  `Stop`、`StopFailure`、`Notification` 接到 `cofluxd hook claude` 信使，转发给本机 daemon；daemon 据此判定
  回合状态（active / approval / question / done），显示在 coflux 侧栏。`cofluxd` 未安装或 daemon 未起时
  静默退出，绝不打扰 agent。
- **scripts/guard-git-worktree.mjs**：PreToolUse hook（只对 Bash）。会话里 `COFLUX_PROJECT_ID` 非空时，拦下
  `git worktree add|remove|move` 并提示改用 MCP 的 `create_workspace` / `remove_workspace`——自己开的 worktree
  用户看不见、也开不了终端。`list`/`prune` 等放行；不在 coflux 项目里一律不干预；缺 `node` 静默放行。
- **skills/coflux/**：教跑在 coflux 终端里的 agent 把长任务、并行工作和求助外化成用户看得见、能接管的
  真实终端。分工只有一条规则：**本地能闭环的一律用零凭证的本地命令**（`cofluxd terminal/progress/notify/ports`），
  只有跨出本工作区（开子工作区、跨工作区/跨设备）才用中心的 `coflux` MCP。
- **.mcp.json**：声明中心的 `coflux` MCP server（Streamable HTTP + OAuth 2.1），地址固定写公共服务
  `https://api.coflux.dev/mcp`。这里不能用 `${COFLUX_MCP_URL:-…}` 这类环境变量写法：Claude Code 会展开，
  但从同一市场装本插件的 Codex 原样当 URL 解析，直接报 `invalid MCP server URL`，整个 MCP 起不来。
  自托管中心或本地开发要连别的地址，在会话里手动加一个（`COFLUX_MCP_URL` 由 daemon 注入，就是中心地址 + `/mcp`）：
  `claude mcp add --transport http coflux "$COFLUX_MCP_URL"` / `codex mcp add coflux --url "$COFLUX_MCP_URL"`。
  Claude Code 里插件条目登记为 `plugin:coflux:coflux`，与手动加的 `coflux` 不重名，公共地址那条不授权放着即可。
  `timeout` 放到 660 秒，够 `wait_terminal` 的 600 秒上限。授权要在 Claude Code 的 `/mcp` 菜单里对
  `coflux` 点一次 Authenticate，之后自动刷新。

## 运行时依赖

- 全局安装 [`cofluxd`](https://www.npmjs.com/package/cofluxd)（`npm i -g cofluxd`）并完成登记（`cofluxd up`）。
  没有它，hooks 是静默空操作，本地命令不可用。
- MCP 需要一次 OAuth 授权：Claude Code 不会自动弹浏览器，要在 `/mcp` 菜单里选中 `coflux` → Authenticate，之后自动刷新。
- 会话里的 `COFLUX_*` 环境变量由 daemon 的 supervisor 注入，旧机器 `cofluxd update && cofluxd restart` 之后才有。

## 隐私边界

hooks 只转发事件名、通知类型、agent 会话 id、在飞后台任务数与信使 pid；提示词、回复、通知正文
从不离开本机。MCP 的读写范围限于当前账号，凭证由 Claude Code 保存。

## 从手工 hook 配置迁移

之前在 `~/.claude/settings.json` 里手工接过 `cofluxd hook claude` 的，装上本插件后删掉那些 `hooks`
条目，否则每个事件触发两次（状态仍正确，只是白跑）。

## 维护

- SKILL 的唯一源在仓库的 `packages/cli/skills/coflux/SKILL.md`（随 npm 包分发给 Codex 用户），用
  `node scripts/sync-claude-plugin.mjs` 同步到本目录，CI 校验两份一致。
- 本目录任何内容变化都要提升 `.claude-plugin/plugin.json` 的 `version`（严格 SemVer 递增），提交并推送后
  在 plugins-builder 的 `catalog/plugins/coflux.json` 里更新 `origin.sha`，按其发版流程发布。
