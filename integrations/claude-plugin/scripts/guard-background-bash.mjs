#!/usr/bin/env node
// Claude Code PreToolUse hook (plan 098): inside a coflux workspace, deny `Bash(run_in_background: true)` and
// hand the agent a ready-to-run `cofluxd terminal new` instead. A process the agent backgrounds in its own Bash
// is invisible to the user: no sidebar entry, no way to take it over, and failures only reach the user through
// the agent's retelling. A coflux terminal is the same process, watched.
//
// Contract (Claude Code hooks): stdin is one JSON document (tool_name / tool_input / cwd ...). To deny, write
// one **pure JSON** decision to stdout and exit 0; otherwise write **not a single byte** and exit 0 (= no
// opinion, the normal permission flow applies). Every anomaly (not in a coflux workspace, stdin not JSON, tool
// is not Bash, the call is not backgrounded) must be "no opinion"; never deny by mistake. Debug output goes to
// stderr only (COFLUX_HOOK_DEBUG=1); one extra byte on stdout breaks decision parsing. Codex runs this same
// hooks.json, so staying silent outside the expected shape is a hard requirement, not politeness.
//
// The decision keys on the `run_in_background` boolean of tool_input, never on the command text: matching
// command strings is what makes guard-git-worktree.mjs trip over heredoc bodies and quoted arguments.
//
// Known gap (plan 098): this only sees the *explicit* background flag. Claude Code also turns a foreground
// command into a background task when it exceeds its timeout, and that path never reaches PreToolUse; neither
// does a `cmd &` / `nohup` the agent writes into a foreground command line.

const STDIN_TIMEOUT_MS = 2000;
// Commands that must stay allowed: the `cofluxd terminal new` the agent runs after being denied, and the
// `cofluxd terminal wait <taskId>` we deliberately teach it to background (that is the whole recipe — the work
// is visible in a terminal, and the harness still wakes the agent when the wait returns).
const EXEMPT_COFLUX_TERMINAL = /\bcofluxd\s+terminal\b/;
// Claude Code's own auto-backgrounding excludes commands starting with `sleep`, and a bare wait has nothing to
// show the user anyway.
const EXEMPT_SLEEP = /^\s*sleep\b/;
// `terminal.new` hard-caps the command line at 16 KB (crates/worker/src/hook.rs). Stay well under it: a command
// inlined into the suggestion must still be runnable, and a multi-KB denial reason is noise either way.
const MAX_INLINE_COMMAND_BYTES = 8 * 1024;
const MAX_TITLE_CHARS = 80;

const debug = (...args) => {
  if (process.env.COFLUX_HOOK_DEBUG) console.error("[coflux background]", ...args);
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

// Single-quote for a POSIX shell so the suggested line can be pasted and run as it is.
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// The sidebar title: the agent already wrote a short human description of the command, reuse it.
function titleFor(description, command) {
  const fromDescription = (typeof description === "string" ? description : "").replace(/\s+/g, " ").trim();
  const fromCommand = command.replace(/\s+/g, " ").trim().slice(0, 60);
  const title = fromDescription || fromCommand || "Background command";
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 3)}...` : title;
}

function reasonFor(command, description, workspaceId) {
  const title = titleFor(description, command);
  // `--cmd=<value>`, never `--cmd <value>`: a value starting with `-` makes Node's parseArgs throw
  // ERR_PARSE_ARGS_INVALID_OPTION_VALUE, so the separated form would hand out a command that cannot run.
  const suggestion =
    Buffer.byteLength(command, "utf8") <= MAX_INLINE_COMMAND_BYTES
      ? `  cofluxd terminal new --title=${shellQuote(title)} --cmd=${shellQuote(command)}`
      : [
          `  cofluxd terminal new --title=${shellQuote(title)} --cmd='<your command>'`,
          "",
          "(your command is too long to repeat here, and the terminal command line is capped at 16 KB: put it in a script file and run that file instead)",
        ].join("\n");
  return [
    `A process you background in your own Bash is invisible to the user: it gets no entry in the coflux sidebar, the user cannot open it or take it over, and if it fails they only learn about it from you. This session runs inside a coflux workspace (COFLUX_WORKSPACE_ID=${workspaceId}), so run it in a terminal the user can watch:`,
    "",
    suggestion,
    "",
    "That prints a taskId. To still be woken up when the command finishes, put the wait in a background Bash — that one is allowed:",
    "",
    "  cofluxd terminal wait <taskId>",
    "",
    "When it returns, read the output with `cofluxd terminal read <taskId>`. `wait` itself always exits 0, so judge success from its output line `# exited exit=<code>`, not from its exit status.",
    "",
    "Do not work around this by running the same command in the foreground instead: a long foreground command blocks you, and Claude Code may auto-background it anyway, which is exactly as invisible to the user.",
  ].join("\n");
}

async function main() {
  // COFLUX_WORKSPACE_ID, not COFLUX_PROJECT_ID: a directory workspace has no repository and an empty project
  // id, but its terminals are just as visible to the user and background visibility matters there too.
  const workspaceId = (process.env.COFLUX_WORKSPACE_ID || "").trim();
  if (!workspaceId) return;
  const payload = await readStdinJson();
  if (!payload || payload.tool_name !== "Bash") return;
  if (payload.tool_input?.run_in_background !== true) return;
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
  if (!command.trim()) return; // nothing to suggest, and `terminal new` rejects an empty command anyway
  if (EXEMPT_COFLUX_TERMINAL.test(command) || EXEMPT_SLEEP.test(command)) {
    debug("allow", { command });
    return;
  }
  debug("deny", { command });
  const decision = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reasonFor(command, payload.tool_input?.description, workspaceId),
    },
  };
  await new Promise((resolve) => process.stdout.write(JSON.stringify(decision), resolve));
}

main().catch((error) => debug("error", error?.message || error));
