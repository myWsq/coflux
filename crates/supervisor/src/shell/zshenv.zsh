# coflux shell 集成（plan 115）：supervisor 起会话 shell 时把 ZDOTDIR 指到本目录，用户原来的
# 四个启动文件由这里按 zsh 原顺序、原作用域转发——**必须在顶层 source**，包进（匿名）函数会让
# 用户 rc 里的普通赋值变成函数局部变量。用户原本设过的 ZDOTDIR 在 COFLUX_USER_ZDOTDIR 里（没设过是空串）。
#
# Shell-integration marks: the supervisor hands this session's mark secret over in
# COFLUX_TERMINAL_SECRET. Copy it into a shell-scoped (unexported) variable and drop it from the
# environment before any user file runs, so nested shells, ssh and child processes never carry it.
if [[ -n "$COFLUX_TERMINAL_SECRET" ]]; then
  typeset -g __coflux_mark_secret="$COFLUX_TERMINAL_SECRET"
  unset COFLUX_TERMINAL_SECRET
fi
__coflux_user_zdotdir="${COFLUX_USER_ZDOTDIR:-$HOME}"
if [[ -f "$__coflux_user_zdotdir/.zshenv" ]]; then
  # 用户 rc 里引用 $ZDOTDIR 时必须看到它自己的目录
  ZDOTDIR="$__coflux_user_zdotdir"
  source "$__coflux_user_zdotdir/.zshenv"
  # 用户自己在 .zshenv 里改了 ZDOTDIR：尊重它，后面几个文件都从新目录取
  if [[ "$ZDOTDIR" != "$__coflux_user_zdotdir" ]]; then
    COFLUX_USER_ZDOTDIR="$ZDOTDIR"
  fi
fi
# 把 ZDOTDIR 指回本目录，否则 zsh 接下来读的 .zprofile/.zshrc 就绕开了这条链
ZDOTDIR=@COFLUX_SHELL_INTEGRATION_DIR@/zsh
unset __coflux_user_zdotdir
