#!/usr/bin/env node
// Claude Code PostToolUse hook (plan 098): when a Bash call ends up as a background task the user cannot see,
// broadcast one line to the workspace card with `cofluxd progress`. This is the leak reporter, not a guard.
//
// Why it exists: guard-background-bash.mjs can only deny the *explicit* `run_in_background: true`, because that
// is the only background path that reaches PreToolUse. Claude Code also converts a foreground command into a
// background task once it exceeds its timeout, and that decision happens while the tool is already running. The
// tool call then resolves right there, so PostToolUse fires at the moment of backgrounding and the tool result
// carries the evidence: `backgroundTaskId` (declared optional in the Bash tool's own output schema, "ID of the
// background task if command is running in background") and, only on the timeout path, `timedOutAfterMs`.
// Verified against the Claude Code 2.1.263 bundle; both are absent from the published hook docs.
//
// It only broadcasts, never blocks: the user does not have to do anything, so this is `progress` (a broadcast
// the user glances at) and deliberately not `notify` (which flips the workspace to "waiting for interaction").
//
// Contract: **never write a single byte to stdout**, whatever happens. A PostToolUse hook's stdout is injected
// into the agent's context, and Codex runs this same hooks.json. Debug output goes to stderr only
// (COFLUX_HOOK_DEBUG=1). Always exit 0.

import { spawn } from "node:child_process";

const STDIN_TIMEOUT_MS = 2000;
const PROGRESS_TIMEOUT_MS = 5000;
// Same two exemptions as the PreToolUse guard: a backgrounded `cofluxd terminal wait <taskId>` is the recipe we
// teach (the work itself is a terminal the user can already watch), and a bare `sleep` has nothing to show.
const EXEMPT_COFLUX_TERMINAL = /\bcofluxd\s+terminal\b/;
const EXEMPT_SLEEP = /^\s*sleep\b/;
const MAX_LABEL_CHARS = 120;

const debug = (...args) => {
  if (process.env.COFLUX_HOOK_DEBUG) console.error("[coflux background report]", ...args);
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

// tool_response is the tool's own result object; be liberal about a host that wraps it in a one-item array.
function resultOf(toolResponse) {
  if (Array.isArray(toolResponse)) return toolResponse.find((item) => item && typeof item === "object") ?? null;
  return toolResponse && typeof toolResponse === "object" ? toolResponse : null;
}

function labelFor(description, command) {
  const text = (typeof description === "string" && description.trim() ? description : command).replace(/\s+/g, " ").trim();
  if (!text) return "an unnamed command";
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 3)}...` : text;
}

function messageFor(label, timedOutAfterMs) {
  const how =
    typeof timedOutAfterMs === "number" && Number.isFinite(timedOutAfterMs) && timedOutAfterMs > 0
      ? `it went over its ${Math.max(1, Math.round(timedOutAfterMs / 1000))}s timeout and the agent's host moved it to the background`
      : "the agent started it in the background of its own shell";
  return `Heads-up: a background task you cannot see is running - "${label}". It has no terminal in this workspace, so there is nothing to open, watch or stop; ${how}. Ask the agent to rerun it as a coflux terminal if you want it back in view.`;
}

function reportProgress(message) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdout is discarded on purpose: cofluxd prints a confirmation line, and this hook must stay silent.
      // `cofluxd progress` joins its positional arguments, so the whole message goes in one argv entry.
      child = spawn("cofluxd", ["progress", message], {
        stdio: ["ignore", "ignore", process.env.COFLUX_HOOK_DEBUG ? "inherit" : "ignore"],
      });
    } catch (error) {
      debug("spawn failed", error?.message || error);
      return resolve();
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, PROGRESS_TIMEOUT_MS);
    timer.unref();
    const done = (info) => {
      clearTimeout(timer);
      debug("progress", info);
      resolve();
    };
    child.on("error", (error) => done(error?.message || error)); // cofluxd not installed: silent no-op
    child.on("close", (code) => done(`exit=${code}`));
  });
}

async function main() {
  const workspaceId = (process.env.COFLUX_WORKSPACE_ID || "").trim();
  if (!workspaceId) return;
  const payload = await readStdinJson();
  if (!payload || payload.tool_name !== "Bash") return;
  const result = resultOf(payload.tool_response);
  const taskId = result && typeof result.backgroundTaskId === "string" ? result.backgroundTaskId.trim() : "";
  if (!taskId) return; // the overwhelmingly common case: an ordinary foreground command, nothing to say
  // The user pressed Ctrl+B themselves; they already know it is running and do not need to be told.
  if (result.backgroundedByUser === true) return;
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
  if (EXEMPT_COFLUX_TERMINAL.test(command) || EXEMPT_SLEEP.test(command)) {
    debug("exempt", { command });
    return;
  }
  const label = labelFor(payload.tool_input?.description, command);
  debug("report", { taskId, label, timedOutAfterMs: result.timedOutAfterMs });
  await reportProgress(messageFor(label, result.timedOutAfterMs));
}

main().catch((error) => debug("error", error?.message || error));
