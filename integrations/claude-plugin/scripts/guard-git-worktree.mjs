#!/usr/bin/env node
// Claude Code PreToolUse hook (plan 095; `add` released in plan 104): inside a coflux project session, block
// `git worktree remove|move` and steer the agent to the account CLI workspace removal. Removing a worktree by hand
// leaves an orphan workspace record behind — nothing in coflux ever deletes it, because the directory watcher
// only reports 0/0 for a directory that disappeared.
//
// `git worktree add` is allowed since plan 104: coflux now follows the agent into a worktree (EnterWorktree,
// ExitWorktree, resume and Claude Code's own cleanup all move the terminal's owning workspace, registering an
// unknown worktree first), so a worktree created here is no longer invisible to the user.
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
// `git [global options...] worktree remove|move`: allows global options such as `-C <dir>`, `--git-dir=...`
// and `--no-pager`, and a position after `cd x && ...`, `;` or `|`. add/list/lock/unlock/prune/repair are not
// listed and pass through.
const GUARDED = /\bgit\b(?:\s+-{1,2}[\w-]+(?:=\S+|\s+(?!worktree\b)\S+)?)*\s+worktree\s+(remove|move)\b/;

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
  const head = `This session runs inside a coflux project (COFLUX_PROJECT_ID=${projectId}) and coflux keeps a workspace record for every worktree it knows about: a worktree you \`git worktree ${verb}\` yourself leaves that record behind as an orphan in the user's sidebar, pointing at a directory that no longer exists. `;
  const how =
    verb === "remove"
      ? `Use cofluxd workspace remove <workspaceId> instead (find the id with cofluxd workspace list); it closes that workspace's terminals first, then removes the worktree and its record. Claude Code's own worktrees need nothing from you: when it cleans one up on exit, coflux moves that workspace's terminals back to the project's main workspace and drops the record by itself. `
      : `coflux does not support moving worktrees: cofluxd workspace remove <workspaceId>, then create a fresh worktree at the new location. `;
  return `${head}${how}Creating a worktree is not blocked: coflux follows you into it (EnterWorktree included) and registers it as a child workspace of this project. To only inspect existing worktrees use git worktree list or cofluxd workspace list.`;
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
