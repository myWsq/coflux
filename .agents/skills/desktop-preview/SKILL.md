---
name: desktop-preview
description: Run the Coflux desktop dev client as a preview — including several branch previews side by side, one per worktree. Covers starting it against production or a local stack, what each instance derives from its worktree, how to tell parallel windows apart, how to stop one and what cleanup is automatic, and what must never be touched. Use when starting, identifying, stopping or troubleshooting a desktop dev preview, or when preparing one for human acceptance.
---

# Desktop preview

The desktop dev client, run as a preview a human can look at. One preview per worktree; several can
be open at once for side-by-side UI comparison across branches.

## Start it

```sh
pnpm dev:desktop:prod        # the default: COFLUX_SERVER_URL=wss://api.coflux.dev/client
pnpm dev:desktop             # local stack: ws://localhost:8787/client
```

Run either from anywhere inside the worktree you want to preview. Both take zero arguments and are
parallel-capable: the instance is derived from the worktree, nothing has to be decided per start.

**Point at production unless you need the local stack.** The owner's real account already has the
devices, workspaces and live terminals a reviewer needs; a local stack costs an enrollment round
trip and still lands in an empty workbench. Use the local stack only for server or daemon protocol
work and for states production cannot produce on demand (enrollment, pending authorization, a client
rejected as outdated). See [docs/desktop-acceptance.md](../../../docs/desktop-acceptance.md) for the
acceptance handover itself.

The launcher (`apps/desktop/scripts/dev.mjs`) prints a summary before it starts anything. Every
value is derived from the worktree you ran it in, so the shape is fixed but the values are not —
these are placeholders, not a real instance:

```
Coflux desktop preview
  instance  <label>
  worktree  <worktree root>
  branch    <branch, or (detached)>
  profile   ~/Library/Application Support/Coflux-dev-<slug>
  renderer  http://localhost:<port in 5280-5379>
  server    wss://api.coflux.dev/client
```

`COFLUX_DESKTOP_DEV_DRY_RUN=1 node apps/desktop/scripts/dev.mjs` prints that summary and exits
without starting or touching anything.

## What an instance is

Everything is derived from the **absolute path of the worktree root**, so the same worktree yields
the same instance on every run — which is what lets sign-in state, window position and the profile's
device identity accumulate. A branch name is not the key: branches get renamed and moved between
worktrees, the path is the thing that is one preview.

| Derived | From | Note |
| --- | --- | --- |
| Profile directory | worktree path | `~/Library/Application Support/Coflux-dev-<slug>`, next to the baseline |
| Renderer HMR port | worktree path | a reserved range that avoids 5274, 5432, 8787, 8788 and the test ports |
| Instance label | worktree directory name | window title and Dock badge |

The repository's **main worktree is the baseline**: profile `Coflux-dev`, port 5274, no label, no
environment variables — exactly the behaviour that existed before parallel previews. Only linked
worktrees derive. The main worktree is detected from git, never from directory naming.

A derived profile is seeded **once**, on its first start: `session-token.bin`, `executor.json` and
`executor-key.bin` are copied from the baseline profile, so the window opens already signed in. If
the baseline is not signed in, nothing is copied and the instance starts at the sign-in screen —
sign in once, and that profile keeps it. After the first start the profiles are independent: signing
out of one preview does not touch any other.

**Against a local server the preview signs in by itself.** An unpackaged build whose server is on a
loopback host (`pnpm dev:desktop`) logs in at every start with the local server's own
`COFLUX_USERNAME` / `COFLUX_PASSWORD` (default `admin` / `admin`) and keeps that session in
`session-token.local.bin`, beside — never over — the profile's `session-token.bin`. So a local stack
with a fresh or temporary database needs no typing, and switching the same worktree back to
`dev:desktop:prod` finds its production session untouched. It only works while the local server is
up and in password mode; a failure is logged (`dev sign-in to the local server failed`) and the
window opens at the sign-in screen. `COFLUX_DESKTOP_DEV_LOGIN=0` turns it off, for looking at the
sign-in screen itself. A packaged app and any non-loopback server never do this.

The launcher passes the app three labelled inputs — `COFLUX_DESKTOP_USER_DATA`,
`COFLUX_DESKTOP_RENDERER_PORT`, `COFLUX_DESKTOP_INSTANCE_LABEL` — and the app derives nothing
itself. Setting `COFLUX_DESKTOP_USER_DATA` yourself overrides the profile and skips seeding.

## Tell the windows apart

- **Window title**: `<label> · <what the renderer set>`. The title bar is hidden, so read it in
  Mission Control, in the Dock's window menu, or in the window switcher.
- **Dock badge**: the label, plus the product's attention count when there is one (`branch 3`). The
  count never erases the label and the label never hides the count. The badge shows the first 10
  characters of the label; the title carries the whole one.
- **The unlabelled window is the main worktree's baseline preview.**
- **Logs**: `~/Library/Logs/Coflux/main.log` is shared by the installed app and *every* dev
  instance, so lines interleave and most of them do not say who wrote them. Only the startup line
  identifies an instance, through its `userData` field; the installed app is the one with
  `packaged: true`.

## Stop one

Ctrl-C in that preview's terminal. The launcher tears down the **whole process group** — SIGTERM,
a bounded wait, then SIGKILL — so no Electron helper survives holding the profile lock. Other
previews are untouched. Quitting from the app (⌘Q) may ask for confirmation when local terminals are
running; the launcher's bounded wait covers a teardown that stalls on that dialog.

Cleanup is automatic:

- A `SingletonLock` left behind by a dead process is reclaimed on the next start.
- A lock held by a **live** PID is reported, not reclaimed: `this worktree's preview is already
  running (pid …)`. That is the answer to "can I start this one" — the port is not.
- If the lock is free and the port is taken, the launcher names the actual listener. That is
  something else on the machine (a hand-started instance, another tool), not this preview.

`SingletonLock` is a **symlink** whose target is `<host>-<pid>` and does not exist as a path. Read it
with `readlink`, never as a file: reading it as a file throws ENOENT, which looks exactly like "no
lock" and would take a live instance's lock away.

## Never

- **Never stage a daemon into a dev build** to make a preview "more complete". A populated
  `build/daemon` makes the dev client start its own runtime against production and register this Mac
  as a *second* device on the real account — once per preview. The local-runtime panel reporting
  "此安装包不完整，请重新安装 Coflux" is expected; ignore it. The consequence is that a dev preview
  reaches **only this Mac**: remote device channels fail outright with "缺少原生远程组件". Local
  workspaces and local terminals are unaffected, which is what workbench UI needs.
- **Never rename an instance** through `app.setName`. The safeStorage Keychain entry is named after
  the app, so a renamed instance cannot decrypt any copied `session-token.bin`.
- **Never bind port 8788.** It is the installed app's local gateway. `pnpm dev:daemon` takes it
  (`COFLUX_HOME` isolates the data directory, not the port), and while it holds it the real app has
  no route to itself: direct connections to this machine fail and the sidebar paints this device
  with a red dot — a device online at the center with no route home. It looks like a networking or
  release defect and is neither. Check with `lsof -nP -iTCP:8788 -sTCP:LISTEN`: the listener should
  be a `coflux-runtime` under `~/.coflux/desktop-runtimes/`, not `target/debug/coflux-runtime`. The app's
  runtime reclaims the port within seconds of the squatter exiting and logs
  `local gateway listening port=8788`.
- **Never kill `/Applications/Coflux.app`, its ptyd, its launcher or its runtime.** Those hold the owner's
  real terminals. Stop only the preview you started.

## Housekeeping

**A brand-new worktree needs Electron installed once, before its first preview.** Electron's binary
is a download rather than a package file: it is never hard-linked out of the pnpm store, so every
worktree carries its own copy (hundreds of MB) and `pnpm install` alone does not put it there. That
is a real per-worktree cost of running previews in parallel — disk, and a wait on the first start.
The launcher checks for it before starting anything and prints the exact command
(`node <worktree>/apps/desktop/node_modules/electron/install.js`); without that check electron-vite
would bring the dev server up and only then fail with a bare `Error: Electron uninstall`. The
download itself is cached across worktrees, so a second worktree on the same Electron version
usually extracts rather than downloads. Never point one worktree at another's `dist` directory: the
versions can differ and the mismatch fails silently.

Profiles are never garbage-collected, and each one adds a local browser grant on the production
account for this machine's daemon. The ceilings are generous but finite (1024 in the runtime, 256 per
daemon on the server), so do not accumulate profiles indefinitely: when a worktree is gone for good,
remove its `~/Library/Application Support/Coflux-dev-<slug>` directory.

`electron-vite dev` runs without watch mode. Renderer changes arrive over HMR and are live in the
open window; anything under `src/main` or `src/preload` needs the preview restarted. When handing a
preview to a reviewer, say which of the two applies, so they know whether the window in front of
them already carries the change.
