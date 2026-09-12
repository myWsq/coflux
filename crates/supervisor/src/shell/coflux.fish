# Device integration is resolved at invocation time; user-defined functions keep precedence.
if not functions -q claude
    function claude --description "Start Claude with this device's Coflux integration"
        if test -n "$COFLUX_HOME"; and test -x "$COFLUX_HOME/bin/coflux"
            "$COFLUX_HOME/bin/coflux" agent run claude -- $argv
        else if test -n "$COFLUX_CLAUDE_PLUGIN_DIR"; and test -d "$COFLUX_CLAUDE_PLUGIN_DIR"
            command claude --plugin-dir "$COFLUX_CLAUDE_PLUGIN_DIR" $argv
        else
            command claude $argv
        end
    end
end

if not functions -q codex
    function codex --description "Start Codex with this device's Coflux integration"
        if test -n "$COFLUX_HOME"; and test -x "$COFLUX_HOME/bin/coflux"
            "$COFLUX_HOME/bin/coflux" agent run codex -- $argv
        else
            command codex $argv
        end
    end
end
