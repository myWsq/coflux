# coflux shell 集成（plan 115）：见同目录 .zshenv 的说明。交互 shell 的最后一个启动文件，
# 所以我们自己的事只在这里做——用户的 rc 链先原样跑完，之后才多出一个 claude 函数。
__coflux_user_zdotdir="${COFLUX_USER_ZDOTDIR:-$HOME}"
if [[ -f "$__coflux_user_zdotdir/.zshrc" ]]; then
  ZDOTDIR="$__coflux_user_zdotdir"
  source "$__coflux_user_zdotdir/.zshrc"
  if [[ "$ZDOTDIR" != "$__coflux_user_zdotdir" ]]; then
    COFLUX_USER_ZDOTDIR="$ZDOTDIR"
  fi
fi
unset __coflux_user_zdotdir
source @COFLUX_SHELL_INTEGRATION_DIR@/claude.sh
# Shell-integration marks (OSC 133 with this session's secret): prompt-start before every prompt,
# command-start from preexec, command-end with the exit status from the next precmd. Added to the
# hook arrays after the user's rc, never replacing the user's own precmd/preexec.
if [[ -n "$__coflux_mark_secret" ]]; then
  typeset -g __coflux_mark_active=
  __coflux_precmd() {
    local __coflux_status=$?
    if [[ -n "$__coflux_mark_active" ]]; then
      __coflux_mark_active=
      printf '\033]133;D;%s;coflux=%s\007' "$__coflux_status" "$__coflux_mark_secret"
    fi
    printf '\033]133;A;coflux=%s\007' "$__coflux_mark_secret"
    return "$__coflux_status"
  }
  __coflux_preexec() {
    __coflux_mark_active=1
    printf '\033]133;C;coflux=%s\007' "$__coflux_mark_secret"
  }
  typeset -ga precmd_functions preexec_functions
  precmd_functions+=(__coflux_precmd)
  preexec_functions+=(__coflux_preexec)
fi
# ZDOTDIR 还给用户：会话里 `echo $ZDOTDIR` 与今天一致（原来没设过就 unset），登录 shell 接着要读的
# .zlogin 也因此直接落到用户那份，不再经过本目录。
if [[ -n "$COFLUX_USER_ZDOTDIR" ]]; then
  ZDOTDIR="$COFLUX_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
