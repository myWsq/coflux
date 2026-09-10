# coflux plugin for Claude Code

Connects Claude Code to the [coflux](https://github.com/myWsq/coflux) agent command center: one daemon per
machine runs the PTYs that host agent sessions, and the web/mobile app shows every workspace's live turn state
so a human can supervise many parallel agents and take over at any time.

This directory is the plugin's **delivery directory**: self-contained and installable as is. The
`myWsq/plugins` marketplace collects the whole directory at a pinned commit SHA (maintained in
`myWsq/plugins-builder`); installers only need the marketplace. Codex installs the same plugin from the same
marketplace and runs the same `hooks/hooks.json` and `.mcp.json`.

## Components

- **hooks/** — four kinds of hooks in one file:
  - `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, `StopFailure`
    and `Notification` are forwarded to the `cofluxd hook claude` messenger, which relays them to the local daemon;
    the daemon maps events to turn states (active / approval / question / done) shown in the coflux sidebar. When
    `cofluxd` is not installed or the daemon is down, the messenger exits silently and never disturbs the agent.
  - `SessionStart` runs `scripts/session-context.sh`: inside a coflux terminal (`COFLUX_WORKSPACE_ID` set) it asks
    the daemon to locate the session's directory (see the worktree hooks below — resuming a session that had entered
    a worktree lands back in it without any tool call, and this is the only moment that can notice), then prints a
    `<coflux-session>` block with the session's six `COFLUX_*` coordinates, the one rule (local commands inside the
    workspace, MCP only to leave it) and a pointer to the skill. The workspace id in the block is the daemon's
    answer, falling back to the environment variable when `cofluxd` is missing or the daemon is down. It fires on
    every session source, so the block comes back after context compaction. Outside coflux it prints nothing.
  - `PostToolUse` with `matcher: "EnterWorktree|ExitWorktree"` and `WorktreeRemove` run
    `scripts/worktree-follow.mjs`: coflux follows the agent into a git worktree. The script hands the payload's
    `cwd` (or, on removal, `worktree_path`) to the local `cofluxd workspace locate|forget` command, which moves the
    terminal's owning workspace — registering an unknown worktree as a child workspace of the project first, and
    on removal moving that workspace's terminals back to the project's main workspace and dropping the record. The
    terminal, its PTY and the conversation are untouched. After a move it returns the new coordinates as
    `additionalContext` so the agent sees them in the same turn. Anything unusual (not inside coflux, another
    repository, no daemon, a daemon too old for the command) is a silent no-op.
  - `PreToolUse` with `matcher: "Bash"` runs `scripts/guard-git-worktree.mjs`: when `COFLUX_PROJECT_ID` is set it
    denies `git worktree remove|move` and points the agent to the MCP tool `remove_workspace` (removing a worktree by
    hand leaves an orphan workspace record in the sidebar). `add`, `list`, `prune` and the other subcommands pass —
    creating a worktree is fine now that coflux follows the agent into it; outside a coflux project it never
    intervenes; without `node` it stays silent.
- **skills/coflux/** — documents, for an agent running inside a coflux terminal, the terminals the user can see and
  take over, the progress / notify channels and preview URLs, and when each is worth using. One rule for the split: **anything
  that closes locally uses the zero-credential local commands** (`cofluxd terminal/progress/notify/ports`); only
  leaving the workspace (child workspaces, other workspaces or devices) goes through the center's `coflux` MCP
  server.
- **.mcp.json** — declares the center's `coflux` MCP server (Streamable HTTP + OAuth 2.1) with the public URL
  `https://api.coflux.dev/mcp` hard-coded. Do not write `${COFLUX_MCP_URL:-…}` here: Claude Code expands it, but
  Codex (installing this plugin from the same marketplace) parses it verbatim as the URL and fails with
  `invalid MCP server URL`, taking the whole MCP server down. For a self-hosted center or local development add a
  server by hand (`COFLUX_MCP_URL` is injected by the daemon and is the center URL + `/mcp`):
  `claude mcp add --transport http coflux "$COFLUX_MCP_URL"` / `codex mcp add coflux --url "$COFLUX_MCP_URL"`.
  In Claude Code the plugin's entry is named `plugin:coflux:coflux`, so it does not collide with a hand-added
  `coflux`; leave the public one unauthorized in that case. `timeout` is 660 s to cover `wait_terminal`'s 600 s
  ceiling. Authorization is one click on Authenticate for `coflux` in Claude Code's `/mcp` menu; tokens refresh
  automatically afterwards.

## Runtime requirements

- The [`cofluxd`](https://www.npmjs.com/package/cofluxd) CLI installed globally (`npm i -g cofluxd`) and
  registered (`cofluxd up`). Without it the messenger hooks are silent no-ops and the local commands are
  unavailable.
- One OAuth authorization for MCP: Claude Code does not open the browser by itself; pick `coflux` in the `/mcp`
  menu and choose Authenticate, after which tokens refresh automatically.
- `COFLUX_*` variables appear in sessions only after the machine's daemon has been upgraded
  (`cofluxd update && cofluxd restart`).
- Codex asks the user to trust each new hook entry once; until then that entry does not run.

## Privacy boundary

The messenger hooks forward only the event name, notification type, agent session id, in-flight background task
count and messenger pid; prompts, replies and notification bodies never leave the machine. The session block and
the worktree hooks call only the local daemon on loopback, with no credentials (the daemon identifies the caller
by its process tree); what they send is a directory path, and the daemon forwards the resolved worktree path and
branch to the center so the workspace can appear in the user's own sidebar. MCP access is scoped to the current
account, with credentials stored by Claude Code.

## Migrating from manual hook configuration

If you previously wired `cofluxd hook claude` by hand in `~/.claude/settings.json`, remove those `hooks` entries
after installing this plugin; otherwise every event fires twice (the merged state stays correct, it is just
wasted work).

## Maintenance

- The skill's single source is `packages/cli/skills/coflux/SKILL.md` in the repository (shipped in the npm package
  for Codex users); sync it here with `node scripts/sync-claude-plugin.mjs`, and CI checks that the two copies
  match.
- Any change in this directory bumps `version` in `.claude-plugin/plugin.json` (strict SemVer increase). Commit
  and push, then update `origin.sha` in plugins-builder's `catalog/plugins/coflux.json` and release through its
  flow.
