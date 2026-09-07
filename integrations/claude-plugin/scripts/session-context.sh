#!/bin/sh
# SessionStart hook of the coflux plugin (plan 096).
#
# When this session runs inside a coflux terminal, print one <coflux-session> block so the agent
# knows its coordinates (device / project / workspace / terminal) and the one rule that matters,
# without probing the environment itself. The block is plain text on stdout: both Claude Code and
# Codex add a SessionStart hook's stdout to the model context. The hook fires on every session
# source (startup, resume, clear, compact, fork), so the coordinates come back after compaction.
#
# Contract: outside coflux (COFLUX_WORKSPACE_ID empty or unset) print nothing and exit 0. Never
# write anything else to stdout, and keep the block starting with "<" so no host mistakes it for
# JSON. The six COFLUX_* variables are injected by the coflux daemon into every PTY it opens; they
# are passed to printf as arguments, never as a format string.

[ -n "${COFLUX_WORKSPACE_ID:-}" ] || exit 0

printf '%s\n' \
  '<coflux-session>' \
  'You are running inside a coflux terminal. The user watches it from the coflux web/mobile app and can take it over at any time.' \
  'Your coordinates (pass these ids to coflux MCP tools directly; do not look them up):' \
  "COFLUX_DEVICE_ID=${COFLUX_DEVICE_ID:-}" \
  "COFLUX_PROJECT_ID=${COFLUX_PROJECT_ID:-}" \
  "COFLUX_WORKSPACE_ID=${COFLUX_WORKSPACE_ID:-}" \
  "COFLUX_TASK_ID=${COFLUX_TASK_ID:-}" \
  "COFLUX_SESSION_ID=${COFLUX_SESSION_ID:-}" \
  "COFLUX_MCP_URL=${COFLUX_MCP_URL:-}" \
  '(COFLUX_TASK_ID is this terminal. An empty COFLUX_PROJECT_ID means a directory workspace without a git repository.)' \
  'Rule: inside this workspace use the zero-credential local commands `cofluxd terminal new|list|read|wait|send`, `cofluxd progress`, `cofluxd notify` and `cofluxd ports` (run anything long or interactive in a terminal the user can see, read/wait/type, report progress, call the user, get preview URLs). Use the center MCP server `coflux` only to leave this workspace (child workspaces, other workspaces or devices). Never run `git worktree add` yourself; use the MCP tool create_workspace.' \
  'Load the `coflux` skill for the full playbook.' \
  '</coflux-session>'
