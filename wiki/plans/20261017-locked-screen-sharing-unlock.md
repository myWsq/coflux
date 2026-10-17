# Plan 20261017-locked-screen-sharing-unlock: A locked remote Mac is unlocked through macOS Screen Sharing, then the Coflux screen resumes

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat d34581cf..HEAD -- apps/desktop/src/main/index.ts apps/desktop/src/main/screen-host.ts apps/desktop/src/main/loopback-tunnel.ts apps/desktop/src/main/window.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/components/workbench/screen-view.tsx native/screen/Sources/CofluxScreenCore/ScreenHelper.swift native/screen/Sources/CofluxScreenCore/Permissions.swift docs/remote-screen.md`

## Status

- Priority: P2
- Effort: S
- Risk: MED — a new local TCP listener in the desktop main process that forwards into a remote device's loopback; no protocol, runtime, helper or server change
- Depends on: none (builds on the shipped loopback tunnel, `20260924-remote-localhost-tunnel`, and the standalone screen view, `20261011-standalone-device-screen`)
- Category: feature
- Execution: subagent(sonnet) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree (clean tree); work lives in `.claude/worktrees/20261017-locked-screen-sharing-unlock` on `dev/20261017-locked-screen-sharing-unlock`
- Planned at: `d34581cf`, 2026-10-17

## Requirement

Today, when the remote Mac's login session is locked, the Coflux screen view shows 「需要在那台 Mac 上解锁」 and nothing can be done from the controlling Mac: the helper reports `locked` and ScreenCaptureKit/CGEvent cannot reach the lock screen (`native/screen/Sources/CofluxScreenCore/Permissions.swift:5-26`, `ScreenHelper.swift:621-622`). The original plan made unlocking a non-goal (`wiki/plans/20260929-remote-desktop.md:41`). Products such as Codex now keep working with a locked Mac; the user wants to be able to use their own locked Macs from Coflux.

The settled answer is a **handoff of the unlock step to macOS's built-in Screen Sharing**, which can show the lock screen and take the password. Coflux never unlocks the Mac itself and never sees, asks for or stores a password.

Product conclusions (confirmed by the user; do not reinterpret):

- **Consumer and trigger**: the user, at one Mac, opens the Coflux screen of another of their Macs (one that advertises `screen_v1`) and finds it locked — idle lock before connecting, or a manual lock.
- **Form**: a button in the locked state that opens Apple's Screen Sharing window connected to that Mac through Coflux's existing device tunnel. Not an unlock performed by Coflux; not an automatic window.
- **Flow**:
  1. The locked overlay keeps its lock icon and gets: title 「远端已锁定」 (or equivalent wording), one line saying the Mac can be unlocked through macOS Screen Sharing and that this view resumes by itself afterwards, and a primary button 「用 macOS 屏幕共享解锁」.
  2. Clicking it shows a progress state on the button / overlay (「正在打开屏幕共享…」) while the connection to the remote's Screen Sharing is checked.
  3. On success Apple's Screen Sharing app opens on that Mac. The overlay shows a short hint that the Screen Sharing window can be closed once unlocked.
  4. The user unlocks in Apple's window. Within about 2 s the helper sees the session unlocked and the Coflux picture resumes on its own, without a reconnect and without the user doing anything in Coflux.
- **Failure paths** (inline error under the button; the button stays usable for a retry):
  - Screen Sharing is not enabled on that Mac (connection refused): copy says to turn on 「屏幕共享」 on that Mac in 「系统设置 → 通用 → 共享」. Coflux does not try to enable it remotely.
  - Device offline / unreachable: the copy says the device cannot be reached (the screen view's existing offline state still covers a device that is offline outright).
  - The device's coflux is too old for the tunnel: copy says to update coflux on that device.
  - The user closes Apple's window without unlocking: nothing special — the view stays locked, the button stays.
- **UI**: only the `locked` case of the screen view's state overlay changes (copy, button, progress, inline error, post-open hint). No settings, no new surfaces, no status-bar change.
- **Scope cut**: the unlock handoff only. Non-goals: Coflux performing the unlock (authorization plug-in, credential handling), opening Apple's window automatically, the privacy curtain over the remote's physical displays (a later slice), a system-asleep Mac, FileVault pre-boot or the login window after a reboot, non-Mac devices, any change on the remote side.
- **Observable when done**: Home locked → open its Coflux screen on Work → click the button → Apple's Screen Sharing shows Home's lock screen → unlock there → close it → the Coflux picture is live. With Screen Sharing turned off on Home, the button shows the "turn on Screen Sharing" copy instead.

**Named assumption (premise)**: Apple's Screen Sharing accepts a `vnc://127.0.0.1:<non-5900 port>` target that is a forward to another Mac's 5900, shows that Mac's locked session and accepts the unlock there, and the Coflux helper then resumes. The check must exercise the same shape the feature uses — a loopback forward, not a direct network connection: on the controlling Mac `ssh -L 59001:localhost:5900 <remote>`, then `open vnc://127.0.0.1:59001` with the remote locked (Screen Sharing on), unlock, close Apple's window, and watch the Coflux screen resume. The user runs it by hand. If they report it failing, STOP. (revised on plan audit)

## Decisions & tradeoffs

- **Hand the unlock to Apple's Screen Sharing; Coflux never handles credentials.** Rejected: a Codex-style authorization plug-in that unlocks the session on request — an admin-installed remote-unlock capability with a large security surface, explicitly not chosen by the user; typing the password through the Coflux picture — the lock screen is not capturable and synthetic events do not reach its password field, so the helper reports `locked` rather than working around it (`Permissions.swift:5`).
- **Desktop-only change; reuse the existing loopback tunnel.** The controlling Mac's main process reaches the remote's `localhost:5900` through `LoopbackTunnels.connect(daemonId, port)` (`apps/desktop/src/main/loopback-tunnel.ts:546`, instance created in `apps/desktop/src/main/index.ts:444-463`; it needs no workspace, only a `daemonId`). No `proto/`, `crates/`, `native/screen` or `apps/server` change. Rejected: a new device payload or a helper-side VNC bridge — the tunnel already dials any loopback port under the existing `RPC` scope (`wiki/plans/20260924-remote-localhost-tunnel.md`, "The worker dials only its own loopback"), so nothing new is granted; the central port proxy — bytes would detour through the centre.
- **The remote port is fixed in main at 5900; the renderer sends only a `daemonId`.** The IPC from the renderer carries the device id and nothing else — no port, no host, no URL. Main validates the id's shape like the existing screen IPC does (`apps/desktop/src/main/screen-host.ts:341-353`, `allowed(event)` trust check). Rejected: a renderer-supplied port or URL — it would turn the IPC into a general "forward anything / open any scheme" primitive.
- **Probe before opening Apple's window.** Main first opens one tunnel connection to 5900 and classifies the result with the tunnel's existing reasons (`TunnelFailureReason` = `offline` | `refused` | `unsupported`, `loopback-tunnel.ts:51`): `refused` → "Screen Sharing not enabled", `unsupported` → "coflux too old", `offline` → "unreachable". Only on success is Apple's app opened. The IPC resolves with `{ ok: true }` or `{ ok: false, reason }`, and the renderer maps the reason to the confirmed copy; any error that is not a `TunnelError` maps to `offline`. The probe stream is destroyed immediately after classification and is never reused as a forwarded connection: a VNC server sends its banner right after accept, so reuse would need buffering and matching, and an open probe counts against the lane's connection cap and keeps the lane alive. Rejected: opening Apple's window and letting it fail — Screen Sharing's own error says nothing about where to turn the feature on, and the product requires the Coflux copy. (revised on plan audit)
- **A short-lived forward on `127.0.0.1`, an ephemeral port, opened with `vnc://127.0.0.1:<port>`.** Main listens on loopback only (never `0.0.0.0`/`::`), on a port the OS picks, pipes each accepted socket into its own new `LoopbackTunnels.connect(daemonId, 5900)` stream, and opens Apple's app with `shell.openExternal` on a URL built in main. The pipe uses the same splice semantics as `splice()` in `apps/desktop/src/main/browser-proxy.ts:424-438` (closing either side destroys the other; `error` listeners on both sides — an unhandled `error` on a local socket crashes main) — export and reuse it, or copy it. At most one forward per device: a second click while one is alive reuses it (opens the same URL again). Two different close rules (revised on plan audit):
  - **Idle**: when the listener has had no open connection for an idle period (executor's choice, on the order of a minute, stated in code), the listener closes. Idle never touches live sockets — there are none by definition.
  - **Teardown**: when the device's screen session closes (renderer `screenClose`, which `screen-session.ts` sends only from `dispose()`: unmount, 断开, window reload — never on pause), on `reset()` (⌘R, `screen-host.ts:333`), on the screen host's `dispose`, and on app quit, the listener **and every live socket and tunnel stream** are destroyed. Apple's "connection lost" dialog is accepted on these paths. The listener has no authentication of its own: Apple's Screen Sharing cannot present proxy credentials, and the remote's Screen Sharing still requires the macOS account — the bound is loopback-only plus a short lifetime. Rejected: a long-lived per-device listener — needless standing exposure of the remote's VNC port to local processes; `vnc://localhost:5900` or any fixed local port — see Landmines.
- **`openExternal` for `vnc:` is called directly in main, not through `openExternalIfHttp`.** The existing helper only allows http(s) (`apps/desktop/src/main/window.ts`, used at `index.ts:475`) and must stay that way; the `vnc:` URL is constructed in main from `127.0.0.1` and the listener's own port, never from renderer input. (decided while planning)
- **Resume needs no new mechanism.** The helper polls lock state every 2 s while a session exists and restarts capture when the phase changes (`native/screen/Sources/CofluxScreenCore/ScreenHelper.swift:595-609`, `updatePhase` at `:616`). The renderer's `locked` overlay disappears when the phase leaves `locked`, as today. Rejected: Coflux closing Apple's window (or the forward) as soon as the unlock is seen — no reliable control of another app's window, and killing the forward under a live Screen Sharing session during normal use produces Apple's "connection lost" dialog; the hint asks the user to close it. This does not override the teardown rule above, where the dialog is accepted. (revised on plan audit)
- **Copy changes in the locked overlay.** The current body text 「远端登录会话已锁定，这里不支持远程解锁。」 (`apps/desktop/src/renderer/components/workbench/screen-view.tsx:610-617`) is now false and must go. Exact wording is the executor's within the product conclusions above; Chinese, like the rest of the screen view.
- **No new tests beyond pure helpers.** Per AGENTS.md "Test harness", a break here is visible the first time the button is used. If the reason → copy mapping or the IPC payload validation is factored into a pure function, a small unit test is fine; do not test the listener against real sockets.

## Direction

Boundaries: main owns the probe, the listener, the tunnel streams and launching Apple's app. The forward must see screen-session closes, which are closure-private to `createScreenHost` (`close()` at `apps/desktop/src/main/screen-host.ts:294-303`; the returned object is only `registerIpc`, `reset`, `dispose`, `sessionCount`, `:356`). So either `screen-host.ts` owns the forward and takes a `connectLoopback` option (mirroring how `index.ts:477` hands it to the browser host), or `createScreenHost` exposes a session-closed hook keyed by `daemonId` that also fires on `reset()` and `dispose` — executor's choice between these two; a module that cannot observe session close is not acceptable. (revised on plan audit) The new IPC handler applies the same `allowed(event)` trust check and the same `daemonId` validation as `screenOpen` (`screen-host.ts:339-345`). The shared bridge type and IPC channel name live with the other screen entries (`apps/desktop/src/shared/desktop-bridge.ts:490-495`, `apps/desktop/src/shared/ipc.ts:78-87`, `apps/desktop/src/preload/index.ts:266-280`). The renderer only calls the bridge and maps the reason to copy. When `loopbackTunnels` is null (no native transport), the IPC resolves `{ ok: false, reason: "offline" }`.

### Milestone 1: Main can open Apple's Screen Sharing on a remote device through the tunnel

A trusted renderer can invoke a new screen IPC with a `daemonId`; main probes the remote's 5900 through the tunnel, answers with a classified failure or opens `vnc://127.0.0.1:<ephemeral>` backed by a loopback-only forwarding listener with the lifetime described above; listeners are cleaned up on idle, on that device's screen session close, and on quit. Bridge type, IPC name and preload entry exist. Validation: `pnpm -C apps/desktop typecheck` → exit 0; `pnpm -C apps/desktop test` → exit 0.

### Milestone 2: The locked overlay offers the handoff

`StateOverlay` has no `daemonId` today (props at `apps/desktop/src/renderer/components/workbench/screen-view.tsx:575`; `daemonId` lives in `ScreenView`, `:102`) — thread it in, and keep the pending / error / hint state local to the locked overlay; `deviceOnline` (already a prop) disables the button while the device is offline. (revised on plan audit) The `locked` case of the state overlay shows the confirmed copy, the primary button, a progress state while the IPC is pending, the inline error per reason, and the post-open hint; the false "不支持远程解锁" text is gone. `docs/remote-screen.md` describes the handoff (states list, Pieces, Known limits: Screen Sharing must be enabled on the remote Mac; the forward and its lifetime). Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop build` → exit 0.

Milestone 2 needs Milestone 1's bridge entry; they are sequential — one work package, do not fan out.

## Landmines

- **Never forward through local port 5900, and never point Apple's app at `localhost:5900`.** On the controlling Mac, 5900 is its own Screen Sharing (when enabled), and Screen Sharing refuses to connect to the machine it runs on. Use an OS-chosen ephemeral port.
- **Bind `127.0.0.1` explicitly.** Node's `server.listen(0)` without a host binds all interfaces, which would expose the remote's VNC port to the LAN.
- **`openExternalIfHttp` drops non-http URLs silently** (`apps/desktop/src/main/window.ts`); routing the `vnc:` URL through it makes the button do nothing with no error.
- **`LoopbackTunnels.connect` rejects with `TunnelError`** carrying `reason` (`loopback-tunnel.ts:53-61`, `:278-299`); anything else thrown should map to `offline`. A lane marked unsupported stays so until reopened — that is the "too old" path, not a bug.
- **The tunnel lane caps concurrent connections at 64** (`LANE_CONNECTION_LIMIT`, `loopback-tunnel.ts:40`) and is shared with the browser tab's traffic to the same device; Screen Sharing uses few connections, but the forward must close its tunnel streams when the local socket closes, or they leak against that cap.
- **A failed probe starts the lane's reopen backoff** (`loopback-tunnel.ts:305`, 0.5–15 s): a retry click inside it gets `offline` at once — expected, not a bug. A probe to an unreachable device can take the full open timeout (`OPEN_TIMEOUT_MS`, `loopback-tunnel.ts:41`, 20 s), so the progress state must hold that long. `online()` false (account not connected) also yields `offline`. (revised on plan audit)
- **Every central disconnect and ⌘R's transport reset abandon the tunnel lane** (`loopback-tunnel.ts:347-373`, `index.ts:533`), which drops a live Apple Screen Sharing session the same way — note it in `docs/remote-screen.md` Known limits. (revised on plan audit)
- **The screen view is only offered for devices other than this Mac** (`docs/remote-screen.md`, "Form and entry points"); do not add a self-device path.

## Merge and deploy

- Desktop-only: ships in a desktop release; no centre deploy, no runtime/helper release dependency. The remote side needs a runtime that already serves the loopback tunnel (v2.6.0+); older ones get the "too old" copy.
- The remote Mac must have Screen Sharing turned on (System Settings → General → Sharing) — mention it in the release notes.
- Acceptance is by hand on two Macs (see Commands); it requires the packed or dev desktop on the controlling Mac only.

## Scope

In scope:
- `apps/desktop/src/main/` (new forwarding module and/or `screen-host.ts`, wiring in `index.ts`)
- `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/desktop-bridge.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/components/workbench/screen-view.tsx` (the `locked` overlay only)
- `docs/remote-screen.md`
- `wiki/plans/README.md`, this plan

Out of scope:
- `proto/`, `crates/`, `packages/`, `native/screen`, `apps/server` — the handoff needs no remote-side or contract change
- the privacy curtain, any Coflux-performed unlock, automatic opening — product non-goals
- `openExternalIfHttp`'s policy — stays http(s)-only

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (once, fresh worktree) | `pnpm install` at the repo root | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Lint | `pnpm -C apps/desktop lint` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Two-Mac walkthrough (acceptance) | `pnpm dev:desktop:prod` on the controlling Mac; remote Mac locked with Screen Sharing on, then off | button opens Apple's Screen Sharing on the remote's lock screen; after unlocking the Coflux picture resumes; with Screen Sharing off the "turn on Screen Sharing" copy shows |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Clicking the locked-state button probes, then opens `vnc://127.0.0.1:<ephemeral>` through a loopback-only forward to the remote's 5900; refused / unsupported / offline map to the confirmed copy.
- [ ] The renderer sends only a `daemonId`; port 5900 and the `vnc:` URL are fixed in main; `openExternalIfHttp` unchanged.
- [ ] The new IPC handler rejects untrusted senders (`allowed(event)`) and validates `daemonId` exactly like `screenOpen`.
- [ ] The probe stream is destroyed after classification; each accepted socket gets its own tunnel stream, spliced with error listeners on both sides.
- [ ] Idle closes only the listener; screen-session close, `reset()`, host `dispose` and quit destroy the listener and every live socket and stream.
- [ ] The "不支持远程解锁" text is gone; `docs/remote-screen.md` describes the handoff.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- The user reports the premise check failed (Apple's Screen Sharing does not show/unlock the locked session over the forward, or Coflux does not resume afterwards).
- A fact cited under Decisions & tradeoffs no longer holds (in particular `LoopbackTunnels.connect`'s signature and failure reasons, or the helper's lock polling).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- If a Coflux-performed unlock or the privacy curtain is taken up later, each is its own plan; the curtain must not break this handoff (Apple's window must still be usable on the remote's lock screen).
- Plan audit (fable, 2026-10-17): all nine findings accepted and folded in; none rejected. `shell.openExternal` with a `vnc:` URL reaching Screen Sharing.app on macOS 26+ is inferred, not verified — the acceptance walkthrough covers it.
- The forward exposes the remote's Screen Sharing port to local processes on the controlling Mac for its short lifetime; that is the accepted bound (the remote still requires its macOS account). Do not lengthen the lifetime or bind beyond loopback without revisiting this.
