# coflux shell 集成（plan 115）：经 XDG_DATA_DIRS 被 fish 当作 vendor conf 加载
# （<dir>/fish-data/fish/vendor_conf.d/），跑在用户 config.fish **之前**——用户 rc 的语义因此
# 一个字节不动；他自己要是也定义 claude，那份后定义，自然盖过我们这份。
# 已经存在（含 ~/.config/fish/functions 里可自动加载）的 claude 函数一律让位，不覆盖用户的定义。
#
# 语义与 claude.sh 逐字对应：变量非空且是目录才追加 --plugin-dir，否则就是今天的 claude。
if not functions -q claude
    function claude --description "coflux：带上 COFLUX_CLAUDE_PLUGIN_DIR 指向的 claude 插件（plan 115）"
        if test -n "$COFLUX_CLAUDE_PLUGIN_DIR"; and test -d "$COFLUX_CLAUDE_PLUGIN_DIR"
            command claude --plugin-dir "$COFLUX_CLAUDE_PLUGIN_DIR" $argv
        else
            command claude $argv
        end
    end
end
