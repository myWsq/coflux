#!/bin/sh
# SessionStart hook of the coflux plugin (plan 096; follows worktrees since plan 104).
#
# When this session runs inside a coflux terminal, print one <coflux-session> block so the agent
# knows its coordinates (device / project / workspace / terminal) and the one rule that matters,
# without probing the environment itself. The block is plain text on stdout: both Claude Code and
# Codex add a SessionStart hook's stdout to the model context. The hook fires on every session
# source (startup, resume, clear, compact, fork), so the coordinates come back after compaction.
#
# Before printing, ask the daemon to locate this session's current directory (`cofluxd workspace
# locate`). Resuming a session that had entered a git worktree puts it straight back into that
# worktree without any tool call, so SessionStart is the only moment that can notice it. The command
# is idempotent: when the directory already belongs to this terminal's workspace (every normal
# startup) nothing changes anywhere. Its answer is also the authority for the workspace id printed
# below — the COFLUX_WORKSPACE_ID variable is frozen when the PTY is spawned and only ever means
# "where this terminal was opened", so it goes stale the moment coflux follows the agent elsewhere.
#
# **Printing the block always wins over locating.** The host kills a SessionStart hook after a few
# seconds, while the locate has to reach the center in the worst case (the daemon waits 20 s for it).
# Being killed mid-way is far worse than a stale id: the agent then gets no coordinates at all. So the
# locate runs under two independent budgets — the CLI gives up on its own (COFLUX_AGENT_TIMEOUT_MS),
# and a shell watchdog kills it regardless, which also covers a `cofluxd` too old to know that
# variable. There is no timeout(1) on macOS /bin/sh, hence the background-job-plus-watchdog dance.
#
# Contract: outside coflux (COFLUX_WORKSPACE_ID empty or unset) print nothing and exit 0. Never
# write anything else to stdout, and keep the block starting with "<" so no host mistakes it for
# JSON. Everything about the daemon is best effort: no cofluxd, daemon down, daemon too old for the
# locate command, a locate that runs out of budget, or an answer that is not JSON all fall back to
# the environment variable. The six COFLUX_* variables are injected by the coflux daemon into every
# PTY it opens; they are passed to printf as arguments, never as a format string.

[ -n "${COFLUX_WORKSPACE_ID:-}" ] || exit 0

# Budgets, both well inside the hook timeout declared in hooks.json.
LOCATE_BUDGET_MS=2500
LOCATE_WATCHDOG_S=3

# Runs the locate under the watchdog and echoes whatever it managed to print.
# The output goes to a file rather than a pipe: a pipe would still be held open by any child that
# outlives the kill. For the same reason the watchdog's own stdout is sent to /dev/null — its
# `sleep` can outlive this script, and a leftover holder of the hook's stdout stalls the host.
coflux_locate() {
  out=$(mktemp "${TMPDIR:-/tmp}/coflux-session-XXXXXX") || return 0
  COFLUX_AGENT_TIMEOUT_MS="$LOCATE_BUDGET_MS" cofluxd workspace locate >"$out" 2>/dev/null &
  worker=$!
  (sleep "$LOCATE_WATCHDOG_S"; kill "$worker") >/dev/null 2>&1 &
  watchdog=$!
  wait "$worker"
  kill "$watchdog" 2>/dev/null
  cat "$out"
  rm -f "$out"
}

# The hook runs in the session's current directory, which is exactly the directory to locate.
WORKSPACE_ID="${COFLUX_WORKSPACE_ID}"
if command -v cofluxd >/dev/null 2>&1; then
  LOCATED=$(coflux_locate 2>/dev/null)
  LOCATED_ID=$(printf '%s' "$LOCATED" | sed -n 's/.*"workspaceId":"\([^"]*\)".*/\1/p')
  [ -n "$LOCATED_ID" ] && WORKSPACE_ID="$LOCATED_ID"
fi

printf '%s\n' \
  '<coflux-session>' \
  'You are running inside a coflux terminal. The user watches it from the coflux web/mobile app and can take it over at any time.' \
  'Your coordinates (pass these ids to coflux MCP tools directly; do not look them up):' \
  "COFLUX_DEVICE_ID=${COFLUX_DEVICE_ID:-}" \
  "COFLUX_PROJECT_ID=${COFLUX_PROJECT_ID:-}" \
  "COFLUX_WORKSPACE_ID=${WORKSPACE_ID}" \
  "COFLUX_TASK_ID=${COFLUX_TASK_ID:-}" \
  "COFLUX_SESSION_ID=${COFLUX_SESSION_ID:-}" \
  "COFLUX_MCP_URL=${COFLUX_MCP_URL:-}" \
  '(COFLUX_TASK_ID is this terminal. An empty COFLUX_PROJECT_ID means a directory workspace without a git repository.)' \
  'Rule: for the workspace your cwd is in, use the zero-credential local commands `cofluxd terminal new|list|read|wait|send`, `cofluxd progress`, `cofluxd notify` and `cofluxd ports` (open a terminal the user can watch and take over, read/wait/type, report progress, call the user, get preview URLs). Use the center MCP server `coflux` only to reach beyond it (other workspaces or devices, or create_workspace for an isolated child workspace).' \
  'The workspace id above is where this terminal belongs right now. Enter a git worktree and coflux follows you: the terminal moves under that worktree in the sidebar, registering it as a child workspace if needed. Plain `cd` does not move it, but the local commands still act on the workspace your cwd is in: `cofluxd workspace` prints both.' \
  'To delete a workspace use the MCP tool remove_workspace, or just let Claude Code clean up its own worktree on exit; never `git worktree remove` it yourself.' \
  'Load the `coflux` skill for the full playbook.' \
  '</coflux-session>'
