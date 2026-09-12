# Device integration is resolved at invocation time; user-defined functions keep precedence.
#
# Shell-integration marks: the supervisor hands this session's mark secret over in
# COFLUX_TERMINAL_SECRET. Copy it into a plain global and erase the environment variable before
# the user's config runs, so nested shells, ssh and child processes never carry it. The marks are
# OSC 133 with the secret: prompt-start before every prompt, command-start before a command line
# runs, command-end with its exit status right after.
if set -q COFLUX_TERMINAL_SECRET; and test -n "$COFLUX_TERMINAL_SECRET"
    set -g __coflux_mark_secret $COFLUX_TERMINAL_SECRET
    set -e COFLUX_TERMINAL_SECRET
    set -g __coflux_mark_active 0
    function __coflux_mark_prompt --on-event fish_prompt
        printf '\033]133;A;coflux=%s\007' $__coflux_mark_secret
    end
    function __coflux_mark_preexec --on-event fish_preexec
        set -g __coflux_mark_active 1
        printf '\033]133;C;coflux=%s\007' $__coflux_mark_secret
    end
    function __coflux_mark_postexec --on-event fish_postexec
        set -l __coflux_status $status
        if test "$__coflux_mark_active" = 1
            set -g __coflux_mark_active 0
            printf '\033]133;D;%s;coflux=%s\007' $__coflux_status $__coflux_mark_secret
        end
    end
end
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
