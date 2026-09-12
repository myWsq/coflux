# Coflux CLI

Operate local and remote terminals from one account. This package provides two distinct commands:

| Command | Purpose |
| --- | --- |
| `cofluxd` | Manage a headless device: install, start, stop, diagnose, and update its runtime |
| `coflux` | Sign in and operate devices, workspaces, and terminals |

Desktop, CLI, and runtime releases share the same version. The macOS desktop app includes its own native `coflux` binary and does not require this npm package or Node.js.

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
coflux terminal new --title 'Tests' --cmd 'pnpm test'
coflux terminal list
coflux terminal read <terminal-id>
coflux terminal wait <terminal-id>
coflux progress 'Reviewing the changes.'
coflux notify 'Ready for your review.'
```

The CLI bundled with the desktop app can reuse the app's login through a local channel. Independently installed CLIs can sign in themselves. See `coflux --help`, `cofluxd --help`, and the [agent skill](skills/coflux/SKILL.md).

## Upgrades and terminal lifetime

Updating this npm package does not end running terminals. `cofluxd update` downloads runtime artifacts without restarting the Supervisor that owns the PTYs. Apply that update with `cofluxd restart` after your tasks finish.

`cofluxd restart` and `cofluxd down` end local terminal processes. The desktop app stays online in the background; fully quitting or signing out ends its local terminals after confirmation.

Starting with 1.0, operation commands such as `cofluxd terminal` and `cofluxd login` have been removed. Use `coflux terminal` and `coflux login`. The MCP interface has also been removed in favor of the CLI.

[GitHub](https://github.com/myWsq/coflux) · [Releases](https://github.com/myWsq/coflux/releases) · [Issues](https://github.com/myWsq/coflux/issues)

MIT © 2026 Shuaiqi Wang.
