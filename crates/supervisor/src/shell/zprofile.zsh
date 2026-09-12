# coflux shell 集成（plan 115）：见同目录 .zshenv 的说明。登录 shell 才会读到这个文件；
# supervisor 今天起的是**非登录**交互 shell（CommandBuilder::new(shell)，argv[0] 不带前导 `-`），
# 所以正常路径不经过这里——留着是为了 ZDOTDIR 一被改写，四个文件就都得原样转发。
__coflux_user_zdotdir="${COFLUX_USER_ZDOTDIR:-$HOME}"
if [[ -f "$__coflux_user_zdotdir/.zprofile" ]]; then
  ZDOTDIR="$__coflux_user_zdotdir"
  source "$__coflux_user_zdotdir/.zprofile"
  if [[ "$ZDOTDIR" != "$__coflux_user_zdotdir" ]]; then
    COFLUX_USER_ZDOTDIR="$ZDOTDIR"
  fi
fi
ZDOTDIR=@COFLUX_SHELL_INTEGRATION_DIR@/zsh
unset __coflux_user_zdotdir
