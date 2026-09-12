# Resolve the device CLI on every invocation, including in shells opened before an update.
# User aliases/functions take precedence. The native launcher execs the host and pins its assets.
# Keep the original Claude directory fallback for installations without the native CLI.
if ! alias claude >/dev/null 2>&1 && [ "$(command -v claude 2>/dev/null)" != claude ]; then
  eval 'claude() {
  if [ -n "$COFLUX_HOME" ] && [ -x "$COFLUX_HOME/bin/coflux" ]; then
    "$COFLUX_HOME/bin/coflux" agent run claude -- "$@"
  elif [ -n "$COFLUX_CLAUDE_PLUGIN_DIR" ] && [ -d "$COFLUX_CLAUDE_PLUGIN_DIR" ]; then
    command claude --plugin-dir "$COFLUX_CLAUDE_PLUGIN_DIR" "$@"
  else
    command claude "$@"
  fi
}'
fi

if ! alias codex >/dev/null 2>&1 && [ "$(command -v codex 2>/dev/null)" != codex ]; then
  eval 'codex() {
  if [ -n "$COFLUX_HOME" ] && [ -x "$COFLUX_HOME/bin/coflux" ]; then
    "$COFLUX_HOME/bin/coflux" agent run codex -- "$@"
  else
    command codex "$@"
  fi
}'
fi
