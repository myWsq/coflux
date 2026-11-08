# coflux plugin for Claude Code

Connects Claude Code to the [coflux](https://github.com/myWsq/coflux) agent command center: one daemon per
machine runs the PTYs that host agent sessions, and the desktop app shows every workspace's live state
so a human can supervise many parallel agents and take over at any time.

This directory is the plugin's **delivery directory**: self-contained and loadable as is.

## How it gets loaded

- **Inside a coflux terminal: automatically, nothing to install.** Coflux.app ships this directory verbatim in its
  app bundle (`Contents/Resources/daemon/claude-plugin`) and hands that absolute path to the machine's daemon
  through the child process variable `COFLUX_CLAUDE_PLUGIN_DIR`; the supervisor's shell integration turns it into
  `claude --plugin-dir <dir>` for terminals coflux opens (desktop app, `coflux terminal new`, iOS, the center's
  CLI). Loading is per session, not an installation: the hooks, the `coflux` and `coflux-secret` skills and account
  CLI commands are all in effect and visible under `/hooks`, while `/plugin` does not list the plugin. The copy travels
  with the app, so it updates when Coflux.app updates; `~/.claude` is never written to and active sessions retain a stable plugin copy under the runtime directory. A session-loaded plugin fully shadows a marketplace-installed copy of the same name, so
  users who already installed `coflux@plugins` need to do nothing and hooks never fire twice. If the variable is
  unset or empty, or the directory it names is gone, `claude` starts exactly as it would without coflux — that is
  also the escape hatch.
- **Everywhere else: from the marketplace.** For sessions outside coflux terminals — your own iTerm or VS Code
  terminal, a machine without Coflux.app, Codex — install the plugin the usual way: the `myWsq/plugins`
  marketplace collects the whole directory at a pinned commit SHA (maintained in `myWsq/plugins-builder`);
  installers only need the marketplace. Codex installs the same plugin from the same marketplace and runs the same
  `hooks/hooks.json`.

## Components

- **hooks/** — three kinds of hooks in one file. None of them reports turn state: the coflux sidebar shows the
  state an agent reports itself through OSC 7501 program status, so an agent version without it shows no state.
  - `SessionStart` (after the session block below) and `PreToolUse` run the `coflux hook claude` messenger. It
    relays only the agent's session id to the local daemon, so the desktop can open the session's transcript; a
    payload without one sends nothing. When `coflux` is not installed or the daemon is down, the messenger exits
    silently and never disturbs the agent.
    On `PreToolUse` the messenger (the Rust `coflux` CLI; the Node one from the npm package only relays the id)
    also guards worktree removal: inside a coflux terminal it denies `git worktree remove|move` only when the
    target is a worktree coflux has registered as a workspace on this device, and points the agent to
    `coflux workspace remove <workspaceId>`, which closes that workspace's terminals and then removes the worktree
    and its sidebar record (removing it by hand would leave an orphan record behind). For any other worktree, a
    command it cannot read with certainty, or a daemon that does not answer in time, it stays silent; `add`,
    `list`, `prune` and the other subcommands always pass.
  - `SessionStart` runs `scripts/session-context.sh`: inside a coflux terminal (`COFLUX_WORKSPACE_ID` set) it asks
    the daemon to locate the session's directory (see the worktree hooks below — resuming a session that had entered
    a worktree lands back in it without any tool call, and this is the only moment that can notice), then prints a
    `<coflux-session>` block with the session's five `COFLUX_*` coordinates, the one rule (local commands inside the
    workspace, account CLI across workspaces/devices) and a pointer to the skill. The workspace id in the block is the daemon's
    answer, falling back to the environment variable when `coflux` is missing, the daemon is down, or the locate
    runs out of its own budget — printing the block always wins over locating, because a hook killed by the host
    timeout would leave the session with no coordinates at all. It fires on every session source, so the block
    comes back after context compaction. Outside coflux it prints nothing.
  - `UserPromptSubmit` runs `scripts/session-moved.mjs`, which prints a `<coflux-session-moved>` block when the
    working directory sits in a different coflux workspace than the terminal does.
  - `PostToolUse` with `matcher: "EnterWorktree|ExitWorktree"` and `WorktreeRemove` run
    `scripts/worktree-follow.mjs`: coflux follows the agent into a git worktree. The script hands the payload's
    `cwd` (or, on removal, `worktree_path`) to the local `coflux workspace locate|forget` command, which moves the
    terminal's owning workspace — registering an unknown worktree as a child workspace of the project first, and
    on removal moving that workspace's terminals back to the project's main workspace and dropping the record. The
    path always travels as an argument, never as the child's working directory: on removal the session's directory
    is usually the worktree that just went away. The terminal, its PTY and the conversation are untouched. After a move it returns the new coordinates as
    `additionalContext` so the agent sees them in the same turn. Anything unusual (not inside coflux, another
    repository, no daemon, a daemon too old for the command) is a silent no-op.
- **skills/coflux/** — documents, for an agent running inside a coflux terminal, the terminals the user can see and
  take over, the progress / notify channels and preview URLs, and when each is worth using. One rule for the split: **anything
  that closes locally uses the zero-credential local commands** (`coflux terminal/progress/notify/ports`); only
  use the account CLI across workspaces/devices.
- **skills/coflux-secret/** — tells the agent to get any value the user would not want in the transcript (API keys,
  tokens, passwords, private keys, personal data) through `coflux secret`: the user enters it in a masked card on
  their Coflux desktop or iOS app and the agent never sees it. Its description is written around the situations
  that call for it, including the user offering to paste a secret into the chat. The `<coflux-session>` block
  carries a one-sentence reminder pointing at it.
## Runtime requirements

- The [`cofluxd`](https://www.npmjs.com/package/cofluxd) CLI installed globally (`npm i -g cofluxd`) and
  registered (`cofluxd up`). Without it the messenger hooks are silent no-ops and the local commands are
  unavailable. Inside a coflux terminal this is already true: the machine's daemon put `coflux` on the session's
  `PATH`, whether it was enrolled by Coflux.app or by npm.
- Account CLI access uses the desktop login or `coflux login`.
- `COFLUX_*` variables appear in sessions only after the machine's daemon has been upgraded
  (`cofluxd update && cofluxd restart`).
- Codex asks the user to trust each new hook entry once; until then that entry does not run.

## Privacy boundary

The messenger hooks forward only the event name, the agent session id and the messenger pid; prompts, replies and
notification bodies never leave the machine. The session block and
the worktree hooks call only the local daemon on loopback, with no credentials (the daemon identifies the caller
by its process tree); what they send is a directory path, and the daemon forwards the resolved worktree path and
branch to the center so the workspace can appear in the user's own sidebar. Account CLI access is scoped to the current
account, using the desktop login or the CLI session stored by Coflux.

## Migrating from manual hook configuration

If you previously wired `coflux hook claude` by hand in `~/.claude/settings.json`, remove those `hooks` entries
after installing this plugin; otherwise those events fire twice (harmless, just wasted work).

## Maintenance

- The skills' single source is the `packages/cli/skills/` tree in the repository (shipped in the npm package and
  embedded in the `coflux` binary); `skills/` here mirrors that whole tree. Sync it with
  `node scripts/sync-claude-plugin.mjs`; CI runs it with `--check`, which fails on a missing, extra or differing
  file.
- Any change in this directory bumps `version` in `.claude-plugin/plugin.json` (strict SemVer increase). Commit
  and push, then update `origin.sha` in plugins-builder's `catalog/plugins/coflux.json` and release through its
  flow.
