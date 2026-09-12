#!/usr/bin/env node
// Claude Code hook of the coflux plugin (plan 104): make coflux follow the agent into a git worktree.
//
// `EnterWorktree` switches a *live* session into a worktree (its own, created under
// `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`, or an existing one passed by path),
// `ExitWorktree` switches back, and `WorktreeRemove` fires when Claude Code cleans a worktree up on
// exit. Without this hook the terminal keeps hanging under the workspace it was opened in: the
// sidebar, the turn state, the diff stats and "which branch" all point at the wrong place, and the
// worktree itself does not exist for coflux at all.
//
// This script hands the path to the local, zero-credential `coflux` command; the daemon resolves
// the worktree's identity, the center verifies it and moves the terminal's *owning* workspace,
// registering the worktree as a child workspace first when it is not known yet. The PTY, the
// session and the turn state are untouched — only the ownership moves.
//
// Which path:
//   PostToolUse EnterWorktree / ExitWorktree → the payload's `cwd` (already the worktree root after
//     entering, already the original directory after exiting, per the hooks contract);
//   WorktreeRemove → the payload's `worktree_path` (the directory is, or is about to be, gone).
//
// The path to act on always travels as an argument, never as the child's working directory: on
// WorktreeRemove the session's cwd is typically the worktree being deleted, and spawning inside a
// directory that no longer exists fails before `coflux` even starts.
//
// Contract (Claude Code hooks): stdin is one JSON document. On PostToolUse, print one **pure JSON**
// object whose `hookSpecificOutput.additionalContext` carries the new coordinates, so the agent sees
// them beside the tool result in the very turn that moved. In every other case write **not a single
// byte** and exit 0: not inside coflux, stdin not JSON, an unexpected event, the ownership did not
// actually change (`ExitWorktree` back to where the terminal already is, a normal startup), `coflux`
// missing, the daemon down or too old to know the command, the center refusing (another repository,
// a directory workspace, not a git directory). Never disturb the agent. Debug output goes to stderr
// only (COFLUX_HOOK_DEBUG=1).
//
// SessionStart is deliberately *not* handled here: `session-context.sh` performs that locate itself
// and prints the resulting workspace id in the `<coflux-session>` block, so a `--resume` into a
// worktree lands on the right coordinates without two hooks racing over the same move.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";

const STDIN_TIMEOUT_MS = 2000;
const COFLUXD_TIMEOUT_MS = 10000;

const debug = (...args) => {
  if (process.env.COFLUX_HOOK_DEBUG) console.error("[coflux worktree]", ...args);
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

function isDirectory(path) {
  if (typeof path !== "string" || !path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A directory that surely exists, to spawn `coflux` from.
 *
 * The payload's cwd is preferred, but on WorktreeRemove it is typically the worktree being deleted
 * and may already be gone — and `execFile` with a nonexistent `cwd` fails with ENOENT before the
 * command ever runs, which would silently skip exactly the cleanup this hook exists for. The cwd
 * carries no meaning for these calls anyway: `coflux` is identified by its process tree, the path
 * to act on is passed as an argument, and the CLI tolerates a vanished `process.cwd()`.
 */
function spawnCwd(preferred) {
  if (isDirectory(preferred)) return preferred;
  let home;
  try {
    home = homedir();
  } catch {
    home = undefined;
  }
  if (isDirectory(home)) return home;
  return isDirectory("/") ? "/" : undefined;
}

/** Run `coflux workspace <sub> <path>`; it prints one line of JSON. Always resolves, never throws. */
function askCofluxd(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      "coflux",
      ["workspace", ...args],
      { cwd, timeout: COFLUXD_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // coflux missing, daemon down, daemon too old for this command, or the center said no:
          // all of them mean "coflux does not follow this time", never "block the agent".
          debug("coflux failed", error.message);
          return resolve(null);
        }
        const line = String(stdout).trim().split("\n").filter(Boolean).pop();
        if (!line) return resolve(null);
        try {
          resolve(JSON.parse(line));
        } catch {
          debug("coflux did not print JSON", line.slice(0, 120));
          resolve(null);
        }
      },
    );
  });
}

function block(located) {
  const lines = [
    "<coflux-workspace-changed>",
    "coflux followed you into the git worktree: this terminal now belongs to another coflux workspace.",
    `owning workspace id: ${located.workspaceId}`,
    `owning workspace path: ${located.path}`,
  ];
  if (located.branch) lines.push(`branch: ${located.branch}`);
  if (located.created) lines.push("This worktree was not known to coflux and has just been registered as a child workspace; it now shows in the user's sidebar.");
  lines.push(
    `Pass ${located.workspaceId} as workspaceId to coflux account CLI commands; COFLUX_WORKSPACE_ID still names the workspace this terminal was opened in and is now stale.`,
    "COFLUX_TASK_ID, COFLUX_SESSION_ID and COFLUX_PROJECT_ID are unchanged: the terminal itself did not move, only its workspace.",
    "The shell inside this terminal still sits in its original directory; that is expected and affects nothing you do.",
    "Run `coflux workspace` at any time to check where you are.",
    "</coflux-workspace-changed>",
  );
  return lines.join("\n");
}

async function main() {
  // Being inside a coflux terminal is the gate; the ownership itself always comes from the daemon.
  if (!(process.env.COFLUX_WORKSPACE_ID || "").trim()) return;
  const payload = await readStdinJson();
  if (!payload || typeof payload !== "object") return;
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : undefined;

  if (event === "WorktreeRemove") {
    const removed = typeof payload.worktree_path === "string" ? payload.worktree_path.trim() : "";
    if (!removed) return;
    // Silent either way: the workspace record disappears from the sidebar and its terminals move
    // back to the project's main workspace, but there is no tool result to annotate here. Never
    // spawn from the payload cwd unless it still exists — by now it is usually the deleted worktree.
    const forgotten = await askCofluxd(["forget", removed], spawnCwd(cwd));
    debug("forget", removed, forgotten);
    return;
  }

  if (event !== "PostToolUse") return;
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (tool !== "EnterWorktree" && tool !== "ExitWorktree") return;
  if (!cwd) return;
  // A directory that no longer exists cannot be located, and spawning from it would only fail with
  // ENOENT: say so explicitly rather than leaning on the spawn error.
  if (!isDirectory(cwd)) {
    debug("payload cwd does not exist, nothing to locate", cwd);
    return;
  }
  // The hook command runs in the session's current directory, which is not necessarily the payload's
  // cwd: always pass the payload's cwd explicitly and run coflux from it.
  const located = await askCofluxd(["locate", cwd], cwd);
  if (!located || typeof located.workspaceId !== "string" || !located.workspaceId) return;
  if (!located.moved) {
    debug("already owned by", located.workspaceId);
    return;
  }
  debug("moved", { tool, workspaceId: located.workspaceId, created: located.created });
  const decision = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: block(located),
    },
  };
  await new Promise((resolve) => process.stdout.write(JSON.stringify(decision), resolve));
}

main().catch((error) => debug("error", error?.message || error));
