#!/usr/bin/env node
// Claude Code PreToolUse hook（plan 095）：coflux 项目会话里拦下 `git worktree add|remove|move`，把 agent
// 引导到中心 MCP 的 create_workspace / remove_workspace——自己 git worktree add 出来的目录用户在侧栏看不见、
// 也开不了终端。
//
// 契约（Claude Code hooks）：stdin 是一段 JSON（tool_name / tool_input.command / cwd …）；要拦就往 stdout 写
// 一段 **纯 JSON** 决策并退出 0；不拦就 **一个字节都不输出**、退出 0（= 无意见，走正常权限流程）。
// 任何异常（没在 coflux 项目里、stdin 不是 JSON、不是 Bash 工具）都只能是"无意见"，绝不误拦。
// 调试信息只走 stderr（COFLUX_HOOK_DEBUG=1），stdout 多一个字都会让决策解析失败。

const STDIN_TIMEOUT_MS = 2000;
// `git [全局选项…] worktree add|remove|move`：允许 `-C <dir>`、`--git-dir=…`、`--no-pager` 这类全局选项，
// 允许出现在 `cd x && …`、`;`、`|` 之后。list/lock/unlock/prune/repair 不在表里，放行。
const GUARDED = /\bgit\b(?:\s+-{1,2}[\w-]+(?:=\S+|\s+(?!worktree\b)\S+)?)*\s+worktree\s+(add|remove|move)\b/;

const debug = (...args) => {
  if (process.env.COFLUX_HOOK_DEBUG) console.error("[coflux guard]", ...args);
};

async function readStdinJson() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, STDIN_TIMEOUT_MS);
    timer.unref();
  });
  const drained = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk);
  })().catch(() => {});
  await Promise.race([drained, timeout]);
  clearTimeout(timer);
  process.stdin.destroy();
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function reasonFor(verb, projectId) {
  const head = `这是 coflux 项目里的会话（COFLUX_PROJECT_ID=${projectId}），worktree 由 coflux 统一管理：自己 \`git worktree ${verb}\` 的结果用户在侧栏看不见、也开不了终端。`;
  const how =
    verb === "add"
      ? `改用 MCP tool create_workspace（projectId 用 ${projectId}，branch 按需、createNew 决定是否新建分支），它会在这台设备上真建 worktree 并出现在用户侧栏；然后用 create_terminal 在新工作区里跑命令。`
      : verb === "remove"
        ? `改用 MCP tool remove_workspace（workspaceId 用 list_workspaces 查），它会先关掉该工作区的终端再删 worktree。`
        : `coflux 不支持移动 worktree：需要换位置就 remove_workspace 后重新 create_workspace。`;
  return `${head}${how}只想查看现有 worktree 用 git worktree list 或 MCP 的 list_workspaces。`;
}

async function main() {
  const projectId = (process.env.COFLUX_PROJECT_ID || "").trim();
  if (!projectId) return;
  const payload = await readStdinJson();
  if (!payload || payload.tool_name !== "Bash") return;
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
  const match = GUARDED.exec(command);
  if (!match) return;
  debug("deny", { verb: match[1], command });
  const decision = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reasonFor(match[1], projectId),
    },
  };
  await new Promise((resolve) => process.stdout.write(JSON.stringify(decision), resolve));
}

main().catch((error) => debug("error", error?.message || error));
