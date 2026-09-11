# coflux shell 集成（plan 115）：见同目录 .zshenv 的说明。交互登录 shell 走不到这里——.zshrc 已经把
# ZDOTDIR 还给了用户，zsh 随后读的是用户自己的 .zlogin；只有「登录但非交互」的 zsh（跳过 .zshrc）
# 才落到这个文件，所以转发完也要把 ZDOTDIR 还回去。
__coflux_user_zdotdir="${COFLUX_USER_ZDOTDIR:-$HOME}"
if [[ -f "$__coflux_user_zdotdir/.zlogin" ]]; then
  ZDOTDIR="$__coflux_user_zdotdir"
  source "$__coflux_user_zdotdir/.zlogin"
  if [[ "$ZDOTDIR" != "$__coflux_user_zdotdir" ]]; then
    COFLUX_USER_ZDOTDIR="$ZDOTDIR"
  fi
fi
unset __coflux_user_zdotdir
if [[ -n "$COFLUX_USER_ZDOTDIR" ]]; then
  ZDOTDIR="$COFLUX_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
