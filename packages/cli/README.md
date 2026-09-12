# Coflux CLI

Operate local and remote terminals from one account. This package provides two distinct commands:

| Command | Purpose |
| --- | --- |
| `cofluxd` | Manage a headless device: install, start, stop, diagnose, and update its runtime |
| `coflux` | Sign in and operate devices, workspaces, and terminals |

Desktop, CLI, and runtime releases share the same version. The macOS desktop app includes its own native `coflux` binary and does not require this npm package or Node.js.

## Codex skill discovery in Coflux terminals

Interactive `codex`, `codex resume`, and `codex fork` invocations use a private
Codex app-server. The native CLI registers the invocation's immutable Coflux skill
directory through `skills/extraRoots/set` before connecting the TUI over a private
Unix socket. Coflux appears in `/skills` and the `$` skill selector, and Codex loads
the skill body on demand. The session hook continues to supply current terminal
and workspace coordinates.

No skill is installed in the user's skill directories and no plugin or marketplace
registration is written to their configuration. The extra root belongs only to
this app-server process; concurrent invocations keep their own skill versions.
The launcher monitors the terminal UI, and a lifetime-pipe watchdog cleans up the
backend and socket when the launcher exits, including when the terminal is killed.

This requires a Codex version supporting `--remote unix://PATH` and
`skills/extraRoots/set` (verified with Codex CLI 0.154.0). If startup or skill
discovery fails, the launcher reports the error instead of claiming integration
is ready. `COFLUX_AGENT_INTEGRATION=off codex` bypasses managed integration.
Profile-selected invocations (`--profile` / `-p`) retain the native runtime and
print an explanatory notice: Codex app-server cannot load profiles, and using the
remote TUI would lose profile fields such as `developer_instructions`. Explicit
`--remote` endpoints, administrative commands, and noninteractive commands
such as `codex exec` retain the existing launch path; they do not receive this
process-local skill registration. Existing hook injection remains unchanged.

For remote resume/fork, `--yolo`, `--sandbox`, `--ask-for-approval`, and permission
config overrides are applied to the private backend; Codex rejects these options
on the remote TUI itself. New sessions retain the native TUI permission flags.

## Install

Requires Node.js 20 or later.

```sh
npm install -g cofluxd
cofluxd up
```

Follow the authorization link to connect the host to your account. Use `cofluxd status`, `cofluxd doctor`, or `cofluxd logs -f` to inspect it.

## Operate your workspaces

```sh
# Supply the password through stdin, not in a command-line argument.
coflux login --username <account> --password-stdin
coflux device list
coflux workspace list
coflux terminal new --workspace <id> --cmd 'git status'
coflux terminal read <terminal-id> --remote
```

Account commands return JSON. Inside a Coflux terminal, local commands automatically use the current workspace:

```sh
coflux terminal new --title 'Tests' --cmd 'pnpm test'   # a persistent shell; the command is typed in once its prompt is ready
coflux terminal wait <terminal-id>                      # blocks until that command finishes and prints its exit code
coflux terminal run <terminal-id> --cmd 'pnpm lint'     # type another command into the same shell
coflux terminal read <terminal-id>                      # the tail of the terminal's scrollback
coflux terminal list
coflux terminal close <terminal-id>
coflux progress 'Reviewing the changes.'
coflux notify 'Ready for your review.'
```

Every terminal is the workspace's default login shell on a real tty, alive until `exit` or `close`; `--cmd` and `run` only type a command in after the shell has signalled that its prompt is ready, and `wait` reports that command's exit code while the terminal stays open.

`coflux notify` sends a persistent notification to your account inbox from the owning terminal. It needs a server connection and reports success only after the server saves it. Desktop shows an in-app hint in the foreground and additionally requests a system notification in the background. Reading a notification clears its unread state, while history survives hooks, terminal exit, and source deletion.

The CLI bundled with the desktop app can reuse the app's login through a local channel. Independently installed CLIs can sign in themselves. See `coflux --help`, `cofluxd --help`, and the [agent skill](skills/coflux/SKILL.md).

## Upgrades and terminal lifetime

Updating this npm package does not end running terminals. `cofluxd update` downloads runtime artifacts without restarting the Supervisor that owns the PTYs. Apply that update with `cofluxd restart` after your tasks finish.

`cofluxd restart` and `cofluxd down` end local terminal processes. The desktop app stays online in the background; fully quitting or signing out ends its local terminals after confirmation.

Starting with 1.0, operation commands such as `cofluxd terminal` and `cofluxd login` have been removed. Use `coflux terminal` and `coflux login`. The MCP interface has also been removed in favor of the CLI.

[GitHub](https://github.com/myWsq/coflux) · [Releases](https://github.com/myWsq/coflux/releases) · [Issues](https://github.com/myWsq/coflux/issues)

MIT © 2026 Shuaiqi Wang.
