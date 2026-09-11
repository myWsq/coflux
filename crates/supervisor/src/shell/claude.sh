# coflux shell 集成（plan 115）：把 COFLUX_CLAUDE_PLUGIN_DIR 翻译成 `claude --plugin-dir <dir>`。
# 由 zsh/bash 两条注入链在**用户 rc 全部跑完之后**最后 source（fish 另有一份 vendor conf）。
#
# 契约只有变量名：值由注入方（Coflux.app 的 LaunchAgent）决定，daemon 不解析、不校验、不落盘。
# 变量为空、或指向的目录不存在时，函数执行的命令行与今天逐字相同——这既是退化行为，也是逃生口
# （想关掉就让变量为空）。
#
# 必须是 `command claude` 直接执行真 claude，不能换成常驻包装进程：worker 认 agent 靠进程树里的
# 进程名 / argv basename（crates/worker/src/agents.rs），shell 函数只是转发，进程树不变。
#
# 用户已经有 claude 别名/函数时一律让位，不碰他那份定义。别名还必须在**解析之前**就绕开：
# `claude() {` 处在命令位，别名会在解析期展开成语法错误，运行期的守卫救不了它——所以函数体放进
# eval 的字符串里，守卫先跑，通过了才由 eval 去解析这段文本。
if ! alias claude >/dev/null 2>&1 && [ "$(command -v claude 2>/dev/null)" != claude ]; then
  eval 'claude() {
  if [ -n "$COFLUX_CLAUDE_PLUGIN_DIR" ] && [ -d "$COFLUX_CLAUDE_PLUGIN_DIR" ]; then
    command claude --plugin-dir "$COFLUX_CLAUDE_PLUGIN_DIR" "$@"
  else
    command claude "$@"
  fi
}'
fi
