# Resolve the device CLI on every invocation, including in shells opened before an update.
# The native launcher execs the host and pins its assets. Keep the original Claude directory
# fallback for installations without the native CLI.
#
# A user function keeps precedence. A same-name alias makes `name() {` a parse error, so the
# alias is lifted while the wrapper is defined and restored verbatim afterwards. A
# self-referencing alias such as `alias codex='codex --yolo'` then expands into the wrapper
# with its arguments; an alias pointing anywhere else still bypasses the wrapper as before.
__coflux_agent_function() {
  __coflux_alias=
  if alias "$1" >/dev/null 2>&1; then
    if [ -n "$ZSH_VERSION" ]; then
      __coflux_alias=$(alias -L -- "$1")
    else
      __coflux_alias=$(alias -- "$1")
    fi
    unalias "$1"
  fi
  if [ "$(command -v "$1" 2>/dev/null)" != "$1" ]; then
    eval "$1() { $2
}"
  fi
  if [ -n "$__coflux_alias" ]; then
    eval "$__coflux_alias"
  fi
  unset __coflux_alias
}

__coflux_agent_function claude '
  if [ -n "$COFLUX_HOME" ] && [ -x "$COFLUX_HOME/bin/coflux" ]; then
    "$COFLUX_HOME/bin/coflux" agent run claude -- "$@"
  elif [ -n "$COFLUX_CLAUDE_PLUGIN_DIR" ] && [ -d "$COFLUX_CLAUDE_PLUGIN_DIR" ]; then
    command claude --plugin-dir "$COFLUX_CLAUDE_PLUGIN_DIR" "$@"
  else
    command claude "$@"
  fi'

__coflux_agent_function codex '
  if [ -n "$COFLUX_HOME" ] && [ -x "$COFLUX_HOME/bin/coflux" ]; then
    "$COFLUX_HOME/bin/coflux" agent run codex -- "$@"
  else
    command codex "$@"
  fi'

unset -f __coflux_agent_function
