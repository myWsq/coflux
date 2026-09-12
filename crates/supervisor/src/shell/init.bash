# coflux shell 集成（plan 115）：supervisor 用 `--init-file` 起 bash，这个文件顶替的正是
# **交互式非登录** bash 本来会读的那条链（supervisor 起的就是非登录交互 shell：
# CommandBuilder::new(shell)，argv[0] 不带前导 `-`，见 crates/supervisor/src/sessions.rs）。
# 所以这里先把那条链原样、按原顺序跑一遍，再做我们自己的事——不要顺手加 /etc/profile、
# ~/.bash_profile，那是登录 shell 的链，今天不会被读到，加了就是改语义。
# /etc/bash.bashrc 只在把它编进 SYS_BASHRC 的发行版上存在（Debian/Ubuntu/Arch），存在即代表
# 今天的 bash 本来也会读它；macOS 的 bash 没有这个文件，判断自然落空。
#
# Shell-integration marks: the supervisor hands this session's mark secret over in
# COFLUX_TERMINAL_SECRET. Copy it into a plain (unexported) shell variable and drop it from the
# environment before the user's files run, so nested shells, ssh and child processes never carry it.
if [ -n "$COFLUX_TERMINAL_SECRET" ]; then
  __coflux_mark_secret="$COFLUX_TERMINAL_SECRET"
  unset COFLUX_TERMINAL_SECRET
fi
if [ -r /etc/bash.bashrc ]; then
  . /etc/bash.bashrc
fi
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
. @COFLUX_SHELL_INTEGRATION_DIR@/claude.sh
# Shell-integration marks (OSC 133 with this session's secret). bash has no preexec: the DEBUG
# trap plays that role, skipping the commands PROMPT_COMMAND itself runs. Our entries are added
# around the user's PROMPT_COMMAND (string or array) and the user's DEBUG trap keeps running.
if [ -n "$__coflux_mark_secret" ]; then
  __coflux_mark_active=
  __coflux_in_prompt=
  __coflux_precmd() {
    local __coflux_status=$?
    __coflux_in_prompt=1
    if [ -n "$__coflux_mark_active" ]; then
      __coflux_mark_active=
      printf '\033]133;D;%s;coflux=%s\007' "$__coflux_status" "$__coflux_mark_secret"
    fi
    printf '\033]133;A;coflux=%s\007' "$__coflux_mark_secret"
    return "$__coflux_status"
  }
  __coflux_prompt_done() {
    __coflux_in_prompt=
  }
  __coflux_debug_trap() {
    if [ -z "$__coflux_in_prompt" ] && [ -z "$__coflux_mark_active" ] && [ "$BASH_COMMAND" != "__coflux_precmd" ]; then
      __coflux_mark_active=1
      printf '\033]133;C;coflux=%s\007' "$__coflux_mark_secret"
    fi
  }
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__coflux_precmd "${PROMPT_COMMAND[@]}" __coflux_prompt_done)
  else
    __coflux_user_prompt_command="$PROMPT_COMMAND"
    while [[ "$__coflux_user_prompt_command" == *[\;[:space:]] ]]; do
      __coflux_user_prompt_command="${__coflux_user_prompt_command%?}"
    done
    PROMPT_COMMAND="__coflux_precmd${__coflux_user_prompt_command:+; $__coflux_user_prompt_command}; __coflux_prompt_done"
    unset __coflux_user_prompt_command
  fi
  __coflux_user_debug_trap="$(trap -p DEBUG)"
  if [ -n "$__coflux_user_debug_trap" ]; then
    __coflux_user_debug_trap="${__coflux_user_debug_trap#trap -- }"
    __coflux_user_debug_trap="${__coflux_user_debug_trap% DEBUG}"
    eval "__coflux_user_debug_trap=$__coflux_user_debug_trap"
    trap '__coflux_debug_trap; eval "$__coflux_user_debug_trap"' DEBUG
  else
    trap '__coflux_debug_trap' DEBUG
  fi
fi
