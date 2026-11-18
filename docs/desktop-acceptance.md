# Desktop acceptance

Desktop changes are accepted by a human on this machine. An agent does not sign off on UI itself; it brings the client up, prepares whatever the reviewer needs to reach the change, and hands over a click path and a pass criterion.

Running the client — starting it, running several branch previews side by side, identifying them, stopping them, and what must never be touched — is the [desktop-preview skill](../.agents/skills/desktop-preview/SKILL.md). This document is the handover around it.

## Which setup

The default is the dev client against **production**:

```sh
pnpm dev:desktop:prod        # COFLUX_SERVER_URL=wss://api.coflux.dev/client
```

The owner's real account already has devices, workspaces and live terminals, so the reviewer reaches the interesting states — a workspace with an open terminal, forwarded ports, notification history — without creating any of them. Starting a local server and daemon instead costs an enrollment round trip and still lands in an empty workbench.

This is safe to point at production:

- The renderer can do exactly what the installed app can do, under the owner's own account. Nothing is reachable that the owner could not reach by opening Coflux.app.
- The WebSocket handshake Origin is rewritten unconditionally at startup, and the server admits desktop clients on the control-protocol version alone, so a dev build is admitted exactly like a released one.
- Development data lives in its own profile — token, identity, loopback grants and the single-instance lock — separate from the installed app. Signing out of a dev preview revokes only its own session.

Use the **local stack** instead for server or daemon protocol changes, and for states production cannot produce on demand — enrollment, pending authorization, a client rejected as outdated. Then follow the isolation in [desktop-lifecycle-acceptance.md](desktop-lifecycle-acceptance.md) rather than pointing a second runtime at the real account.

```sh
pnpm dev:pg && pnpm dev:server && pnpm dev:daemon   # separate terminals
pnpm dev:desktop                                    # defaults to ws://localhost:8787/client
```

The dev client signs in to a local server by itself (the server's `COFLUX_USERNAME` / `COFLUX_PASSWORD`, default `admin` / `admin`); see the skill. Start the server before the client, or the window opens at the sign-in screen.

An authorization link printed by the daemon expires after ten minutes; the daemon requests a new one on its own, so read the last line of its log rather than reusing an old link.

## What this setup does not cover

- **Only this Mac is reachable.** A dev build has no `build/daemon`, so native transport stays off and any remote device channel fails outright with "缺少原生远程组件". Local workspaces and local terminals are unaffected, which covers workbench UI. Do not work around this by staging a daemon into the dev build — see the skill for what that does to the real account.
- **The local-runtime panel permanently reports "此安装包不完整，请重新安装 Coflux"**, for the same reason. Expected; ignore it.
- **A signed, packaged app** is required for anything touching updates, notarization or the installed lifecycle: [desktop-lifecycle-acceptance.md](desktop-lifecycle-acceptance.md).

## Handing over

State the branch and commit under test and whether the tree is dirty, the click path, the pass criterion, and what this setup does **not** cover — remote devices, most obviously. A reviewer who has to guess the pass criterion is being asked to review, not to accept.

Say whether the change is live in the window already: renderer changes arrive over HMR, while anything under `src/main` or `src/preload` needs the preview restarted. When several previews are open, name the one under test by its window title or Dock badge label.

Leave the preview running at handover. It is not a cleanup item — the reviewer is about to use it.

See also: [apps/desktop/README.md](../apps/desktop/README.md) for the server-address precedence and the `COFLUX_DESKTOP_USER_DATA` / `COFLUX_HOME` isolation variables.
