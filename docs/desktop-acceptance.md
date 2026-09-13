# Desktop acceptance

Desktop changes are accepted by a human on this machine. An agent does not sign off on UI itself; it brings the client up, prepares whatever the reviewer needs to reach the change, and hands over a click path and a pass criterion.

The default is the dev client against **production**. The full local stack is the exception, not the starting point.

## Default: dev client against production

```sh
pnpm dev:desktop:prod        # COFLUX_SERVER_URL=wss://api.coflux.dev/client
```

The owner's real account already has devices, workspaces and live terminals, so the reviewer reaches the interesting states — a workspace with an open terminal, forwarded ports, notification history — without creating any of them. Starting a local server and daemon instead costs an enrollment round trip and still lands in an empty workbench.

This is safe to point at production:

- The renderer can do exactly what the installed app can do, under the owner's own account. Nothing is reachable that the owner could not reach by opening Coflux.app.
- The WebSocket handshake Origin is rewritten unconditionally at startup, and the server admits desktop clients on the control-protocol version alone, so a dev build is admitted exactly like a released one.
- Development data lives under `Coflux-dev` — token, identity, loopback grants and the single-instance lock — separate from the installed app. Signing out of the dev client revokes only its own session.

Two consequences to plan around:

- **Only this Mac is reachable.** The dev build has no `build/daemon`, so native transport stays off and any remote device channel fails outright with "缺少原生远程组件". Local workspaces and local terminals are unaffected, which covers workbench UI.
- **Do not stage a daemon into the dev build to work around that.** A populated `build/daemon` makes the dev client start its own runtime against production and register this Mac as a *second* device on the real account.
- The dev client's local-runtime panel permanently reports "此安装包不完整，请重新安装 Coflux" for the same reason. Expected; ignore it.

`Coflux-dev` starts with no session token, so the reviewer signs in once per fresh profile. Credentials are email plus password; the token then persists and later runs skip this.

## When the local stack is actually required

Use it for server or daemon protocol changes, and for states production cannot produce on demand — enrollment, pending authorization, a client rejected as outdated. Then follow the isolation in [desktop-lifecycle-acceptance.md](desktop-lifecycle-acceptance.md) rather than pointing a second runtime at the real account.

```sh
pnpm dev:pg && pnpm dev:server && pnpm dev:daemon   # separate terminals
pnpm dev:desktop                                    # defaults to ws://localhost:8787/client
```

An authorization link printed by the daemon expires after ten minutes; the daemon requests a new one on its own, so read the last line of its log rather than reusing an old link.

## Before starting the client

- The installed Coflux.app should be running: the dev client reaches this machine through its runtime.
- Port 5274 must be free, and no other dev Electron may hold the profile. Read the lock rather than counting processes: `readlink ~/Library/Application\ Support/Coflux-dev/SingletonLock` names `<host>-<pid>`; check that pid with `ps -p`.
- Start it in the background with output to a log file. `~/Library/Logs/Coflux/main.log` is shared with the installed app; tell the two apart by the `packaged` field in the startup line.

## Which changes need a restart

`electron-vite dev` runs without watch mode: renderer changes arrive over HMR and are live in the open window, while anything under `src/main` or `src/preload` needs the client restarted. Say which of the two applies when handing over, so the reviewer knows whether the window in front of them already carries the change.

## Cleaning up

Stop only the dev client — the pid from `SingletonLock`, or the `pnpm dev:desktop` process group. **Never touch `/Applications/Coflux.app` or its supervisor and worker**: killing those ends the owner's real terminals. Killing the dev Electron's main process leaves its helpers behind, and they keep the single-instance lock, so the next start exits immediately; clear them too.

Leave the client running at handover. It is not a cleanup item — the reviewer is about to use it.

## Handing over

State the branch and commit under test and whether the tree is dirty, the click path, the pass criterion, and what this setup does **not** cover — remote devices, most obviously. A reviewer who has to guess the pass criterion is being asked to review, not to accept.

See also: [apps/desktop/README.md](../apps/desktop/README.md) for the server-address precedence and the `COFLUX_DESKTOP_USER_DATA` / `COFLUX_HOME` isolation variables, and [desktop-lifecycle-acceptance.md](desktop-lifecycle-acceptance.md) for acceptance that requires a signed, packaged app.
