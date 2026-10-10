# Remote screen (「屏幕」 tab)

Plan `20260929-remote-desktop`. Coflux Desktop views and drives another of the account's Macs from a
native tab in the device page. Nothing else is installed on either Mac.

## Pieces

```
remote Mac                                                      local Coflux Desktop
coflux-screen (Swift, native/screen)                            renderer: screen-view.tsx / screen-session.ts
  virtual display + mirror + power assertions                     VideoDecoder → canvas, local cursor,
  ScreenCaptureKit → VideoToolbox H.264 (Annex B)                 input capture, product states, immersive
  CGEvent input, NSPasteboard, permission/lock state                    ▲ MessagePort
        ▲ $COFLUX_HOME/ipc/screen.sock (ScreenHelperFrame)       main: screen-host.ts — two owned RPC lanes
coflux-runtime: crates/runtime/src/screen.rs                             per session, clipboard polling,
  scope gate, lane ↔ helper bridge, capability `screen_v1`             setIgnoreMenuShortcuts while focused
        ▲ coflux-transport (Tailcat, TCP) ─────────────────────────────┘
```

- **Contract**: `proto/coflux/v1/device.proto`, section "Remote screen" (envelope numbers 125–143) and
  the worker ⟷ helper `ScreenHelperFrame`; `client.proto` `DirectoryWorkspaceEnsure` (a screen tab
  needs the device's directory workspace, created without a shell); `DaemonInfo.capabilities`.
- **Helper** (`native/screen`): built by `node scripts/build-screen-helper.mjs [out] [--test]` (SDK
  pinned away from a rejected 27.x CLT SDK; warnings in `native/screen` fail the build), staged and
  signed with the other runtime binaries (`DAEMON_BINARIES`), shipped **only** inside Coflux.app —
  never in the daemon release tarballs or the worker hot-upgrade set. The desktop runtime passes
  `COFLUX_SCREEN_HELPER` (absolute path) and `COFLUX_SCREEN_VERSION` to the supervisor, which passes
  its environment to every worker, hot-upgraded ones included.
- **Worker** (`crates/runtime/src/screen.rs`): keeps one connection to the helper, starting it
  detached (own process group, not `kill_on_drop`) when nothing answers, so a worker restart or hot
  upgrade reattaches to the live session. Advertises `screen_v1` only after the versioned hello was
  acknowledged. Screen payloads are consumed right after the RPC scope gate; each lane holds the
  bridge through its channel entry, released by `Drop` on every removal path (`ScreenHelperChannelClosed`).
- **Server**: carries the daemon's capabilities on every `DaemonInfo` emission (`DaemonInfoData.capabilities`
  is required, so a hand-written literal cannot omit it); handles `directoryWorkspaceEnsure`.
- **Desktop main** (`apps/desktop/src/main/screen-host.ts`): opens and owns the control and video
  lanes (`openOwned`, RPC scope) under an identity of the app run's own, bridges bytes to the page over
  a `MessageChannelMain` port (structured clone, no per-frame ack loop; the renderer → main direction
  never puts an `ArrayBuffer` in the transfer list, because Electron 44.3.0 delivers a transferred
  buffer to `MessagePortMain` as null, and sends each frame in a buffer of exactly its size;
  main → renderer clones intact; dropped requests, failed lane opens and lane closes are logged to
  `main.log`), polls the local clipboard
  while a visible session asks, writes it on the remote's changes, and calls
  `webContents.setIgnoreMenuShortcuts` while a picture has focus (probed on Electron 44.3.0: covers
  `role: quit`).
- **Renderer**: `screen-tabs.ts` (records: workspace, device, stable remote session id),
  `screen-runtime.ts`, `screen-session.ts` (protocol, credit, WebCodecs `avc1.64001f` Annex B),
  `screen-view.tsx` (status bar 直连/中继 + latency, resolution, 沉浸, 断开; states; input; cursor). The tab kind is
  registered in `terminal-layout.ts` (`SCREEN_TAB_PREFIX`, exempt from reconcile, not a task).
- **Resolution**: the status bar's dropdown (`screen-resolution.ts`) offers 「跟随窗口」 (default: the
  remote display follows the tab 1:1 in points) or a fixed size in points (1280×800 … 1920×1080) at
  the local screen's scale, sent through `ScreenSessionResize` at once; on a fixed size resizing the tab
  or immersive mode only scales the picture. Remembered per (server, device) on this Mac.

## Budgets

- Video credit in bytes of `ScreenVideoFrame.data`, drop-at-source in the helper; the client starts
  with 2 MiB on a relayed path and 8 MiB direct, returns credit for every chunk received.
- Chunks are at most 256 KiB and numbered (`chunk_index` / `chunk_count`): a gap discards the frame
  and asks for a keyframe. The worker clamps a lane's credit to 64 chunks (a quarter of the transport
  helper's 256-record queue), so the credit bounds what a video lane queues; video is never dropped
  in the worker (its credit would leak) — only cursor updates are, once a lane's sink holds the budget.
- Bitrate adapts from the credit window and drops (`BitrateController`), starting lower on relay.

## Keyboard

While the picture has focus every combination goes to the remote (⌘Q, ⇧⌘W, ⌘W, ⌘T, ⌘R, ⌘1–9, ⌘C/V).
Exactly one stays local: ⌃⌥⌘F toggles immersive mode (its keyup is swallowed too). Keys travel as
physical `KeyboardEvent.code` and are mapped to macOS virtual key codes on the remote.

## Known limits and notes

- The capability appears only once the device's runtime was started by Coflux Desktop with a
  build that ships `coflux-screen` **and** restarted after installing it (the running supervisor's
  environment has no helper path before that). Headless `cofluxd` installs never offer it.
- A session left open when the app quits keeps its virtual display and power assertions for the
  helper's 10-minute orphan grace.
- Takeover: a user-initiated open (a new 屏幕 tab, 「打开屏幕」, 「重新接管」) takes the session over;
  automatic reconnects (restore after restart, lane reopen, resume) never do, and a taken-over tab
  stays detached until 「重新接管」.
- A helper of another version answering the socket (left by a previous desktop build) is told to
  retire (`ScreenHelperRetire`): it stops listening at once; if it holds a live session the worker
  keeps serving that session over the existing connection and the helper exits when it ends
  (close or grace), after which the worker's reconnect starts the shipped binary; holding none, it
  exits now. A helper the worker cannot serve through (protocol, refused hello) gets
  `tear_down`: it ends its session immediately (display removed, arrangement restored) and exits.
  Two helpers never hold virtual displays at the same time.
- Cursor shapes come from `NSCursor.currentSystem`; when unreadable the helper falls back to
  cursor-in-video.
- Not measured: a Mac with no physical display at all; decode throughput at 2880×1800@60.
