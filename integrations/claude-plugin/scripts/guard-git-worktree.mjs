#!/usr/bin/env node
// Claude Code PreToolUse hook (plan 095): inside a coflux project session, block `git worktree add|remove|move`
// and steer the agent to the center MCP's create_workspace / remove_workspace. A worktree the agent creates by
// itself is invisible in the user's sidebar and cannot host a terminal.
//
// Contract (Claude Code hooks): stdin is one JSON document (tool_name / tool_input.command / cwd ...). To block,
// write one **pure JSON** decision to stdout and exit 0; otherwise write **not a single byte** and exit 0
// (= no opinion, the normal permission flow applies). Every anomaly (not in a coflux project, stdin not JSON,
// tool is not Bash) must be "no opinion"; never block by mistake. Debug output goes to stderr only
// (COFLUX_HOOK_DEBUG=1); one extra byte on stdout breaks decision parsing.
//
// Known gap: the check keys on COFLUX_PROJECT_ID alone and does not verify that the repository the command
// targets belongs to that project, so the same commands against another repository from inside a coflux
// session are blocked too (see plan 096 maintenance notes).

const STDIN_TIMEOUT_MS = 2000;
// `git [global options...] worktree add|remove|move`: allows global options such as `-C <dir>`, `--git-dir=...`
// and `--no-pager`, and a position after `cd x && ...`, `;` or `|`. list/lock/unlock/prune/repair are not listed
// and pass through.
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
  const head = `This session runs inside a coflux project (COFLUX_PROJECT_ID=${projectId}) and coflux manages its worktrees: a worktree you \`git worktree ${verb}\` yourself is invisible in the user's sidebar and cannot host a terminal. `;
  const how =
    verb === "add"
      ? `Use the MCP tool create_workspace instead (projectId ${projectId}; set branch as needed and createNew to decide whether the branch is created). It creates the worktree on this device and shows it in the user's sidebar; then run commands there with create_terminal. `
      : verb === "remove"
        ? `Use the MCP tool remove_workspace instead (find the workspaceId with list_workspaces); it closes that workspace's terminals first, then removes the worktree. `
        : `coflux does not support moving worktrees: remove_workspace, then create_workspace at the new location. `;
  return `${head}${how}To only inspect existing worktrees use git worktree list or the MCP tool list_workspaces.`;
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
