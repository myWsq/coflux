#!/usr/bin/env node
// Claude Code UserPromptSubmit hook (plan 102; ownership from the daemon since plan 104): tell the
// agent when its working directory sits in a *different* coflux workspace than the one this terminal
// currently belongs to.
//
// A plain `cd <path>` moves a live session (same conversation, no restart) to another directory, and
// a coflux child workspace is just a registered git worktree, so a session whose terminal belongs to
// workspace A can end up working inside workspace B. From then on the local `coflux` commands act on
// B (the daemon resolves the caller's cwd) while the terminal still hangs under A in the sidebar.
// Without this block the agent would keep passing A's id to the coflux account CLI commands.
//
// Both ids come from `coflux workspace`, never from $COFLUX_WORKSPACE_ID: that variable is frozen
// when the PTY is spawned and only means "where this terminal was opened", so it goes stale as soon
// as coflux follows the agent into a worktree (plan 104) — comparing against it would report a move
// on every prompt forever after. The variable is used for one thing only: telling whether this
// session is inside a coflux terminal at all.
//
// Contract (Claude Code hooks): stdin is one JSON document (cwd / prompt / session_id ...); a
// UserPromptSubmit hook's stdout is added to the model context, so print the block as plain text
// starting with "<" (never JSON) when the workspaces differ, and **not a single byte** in every other
// case: no COFLUX_WORKSPACE_ID (not inside coflux), stdin not JSON, `coflux` missing or failing,
// same workspace. Always exit 0. Debug output goes to stderr only (COFLUX_HOOK_DEBUG=1).
//
// Stateless on purpose: while the session stays moved the block is printed on every prompt, so it
// also comes back after a context compaction. The cost is that the block arrives with the *next*
// prompt, not in the turn that moved: an agent that has to call an account CLI command right after moving runs
// `coflux workspace` itself (see the coflux skill).

import { execFile } from "node:child_process";

const STDIN_TIMEOUT_MS = 2000;
const COFLUXD_TIMEOUT_MS = 5000;

const debug = (...args) => {
  if (process.env.COFLUX_HOOK_DEBUG) console.error("[coflux moved]", ...args);
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

/** `coflux workspace` prints one line of JSON; run it from the payload's cwd, never from ours. */
function askCofluxd(cwd) {
  return new Promise((resolve) => {
    execFile(
      "coflux",
      ["workspace"],
      { cwd, timeout: COFLUXD_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          debug("coflux workspace failed", error.message);
          return resolve(null);
        }
        const line = String(stdout).trim().split("\n").filter(Boolean).pop();
        if (!line) return resolve(null);
        try {
          resolve(JSON.parse(line));
        } catch {
          debug("coflux workspace did not print JSON", line.slice(0, 120));
          resolve(null);
        }
      },
    );
  });
}

function block(effective, path, owning) {
  return [
    "<coflux-session-moved>",
    "Your working directory is in a different coflux workspace than the one this terminal belongs to.",
    `effective workspace id: ${effective} (your cwd is inside it)`,
    `effective workspace path: ${path}`,
    `owning workspace id: ${owning} (where this terminal hangs in the user's sidebar)`,
    `Local coflux commands (terminal new|list|read|wait|send) now act on ${effective}: a terminal you open lands there and runs in its directory, list shows its terminals, and terminals of ${owning} read back as not found.`,
    `Pass ${effective} as workspaceId to coflux account CLI commands.`,
    "COFLUX_TASK_ID and COFLUX_SESSION_ID are unchanged: this terminal itself did not move.",
    "Run `coflux workspace` at any time to check where you are.",
    "</coflux-session-moved>",
  ].join("\n");
}

async function main() {
  // The variable is only the "am I inside coflux" gate; both ids below come from the daemon.
  if (!(process.env.COFLUX_WORKSPACE_ID || "").trim()) return;
  const payload = await readStdinJson();
  const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
  if (!cwd) return;
  const current = await askCofluxd(cwd);
  const effective = typeof current?.workspaceId === "string" ? current.workspaceId.trim() : "";
  const owning = typeof current?.owningWorkspaceId === "string" ? current.owningWorkspaceId.trim() : "";
  if (!effective || !owning || effective === owning) return;
  debug("moved", { owning, effective });
  const text = block(effective, typeof current.path === "string" ? current.path : "", owning);
  await new Promise((resolve) => process.stdout.write(`${text}\n`, resolve));
}

main().catch((error) => debug("error", error?.message || error));
