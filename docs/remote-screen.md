# Remote screen (「屏幕」)

Plans `20260929-remote-desktop` and `20261011-standalone-device-screen`. Coflux Desktop views and
drives another of the account's Macs from a standalone view of that device's screen. Nothing else is
installed on either Mac.

## Form and entry points

- A screen belongs to a device, not to a workspace: **at most one per device**. It is not a tab and
  involves no workspace (opening one never creates or needs the device's directory workspace).
- Opened from the **屏幕 button in the top-right action dock** (the current selection's device: the
  selected workspace's, the device page's, or the selected screen's), the device row's context menu
  (「打开屏幕」), the ⌘P palette (「打开屏幕」) and the device page's empty state. They are offered only
  for a device that advertises `screen_v1` and is not this Mac. On a device whose screen is already
  open they only select it — same remote session, no takeover — so every workspace of that device
  lands on the same screen. Pressing the dock button while the screen is selected returns to the
  selection the user came from.
- An open screen is a **sub-row under its device** in the sidebar's 设备 section (`屏幕 · 1440×900`:
  the connected remote size, else the fixed preset chosen). Clicking it selects the screen; its ×
  (or the status bar's 「断开」) disconnects: the remote session ends, the virtual display goes away,
  the row disappears, and a selected screen hands the main area back to the previous selection.
- A selected screen fills the whole main area right of the sidebar, under a status bar (device,
  直连/中继 and latency, the resolution dropdown, 「沉浸」, 「断开」) that is a window drag band like the
  files overlay's header. It is a workbench selection of its own (`screen:<daemonId>`), so no
  workspace is active and workspace shortcuts (⌘T, ⌘W, ⌘1–9, ⌘\\) do nothing. Selecting anything
  else pauses the screen (session and virtual display kept, the view stays mounted); selecting it
  again resumes without reconnecting.
- **Restart**: open screens come back as sidebar sub-rows (records per device, scoped by server
  address) and reconnect when selected, without taking over; a stored screen selection is restored
  too. The per-device resolution choice is kept. Screens of devices removed from the account are
  dropped. Records from the tab era (`coflux_screen_tabs:*`) are discarded without migration.

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
  the worker ⟷ helper `ScreenHelperFrame`; `DaemonInfo.capabilities`. (`client.proto`
  `DirectoryWorkspaceEnsure` was added for screen tabs; screens no longer use it.)
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
- **Unlock handoff** (`screen-sharing-forward.ts`, owned by the screen host): a locked remote Mac cannot
  be captured or typed into, so the locked overlay's button asks main to open macOS Screen Sharing on it.
  Main probes the remote's loopback port 5900 through the device's loopback tunnel (the failure reasons
  `offline` / `refused` / `unsupported` become the overlay's copy), then opens `vnc://127.0.0.1:<port>` on a
  forwarding listener bound to loopback only, on an OS-chosen port (never 5900, which is this Mac's own
  Screen Sharing), each accepted socket spliced into its own tunnel stream. The page sends only the
  device id; the port and the URL are fixed in main. The helper's 2 s lock polling resumes the picture
  once the user unlocks. Coflux never sees a password.
- **Renderer**: `screen-records.ts` (records per device: the stable remote session id),
  `screen-runtime.ts` (records and live sessions, keyed by device), `screen-session.ts` (protocol,
  credit, WebCodecs `avc1.64001f` Annex B), `screen-view.tsx` (status bar 直连/中继 + latency,
  resolution, 沉浸, 断开; states; input; cursor). The selection kind is in `workbench-state.ts`; the
  screen layer, the dock button and the sidebar sub-row are wired in `workbench.tsx` / `sidebar.tsx`.
- **Resolution**: the status bar's dropdown (`screen-resolution.ts`) offers 「跟随窗口」 (default: the
  remote display follows the view 1:1 in points) or a fixed size in points (1280×800 … 1920×1080) at
  the local screen's scale, sent through `ScreenSessionResize` at once; on a fixed size resizing the
  window or immersive mode only scales the picture. Remembered per (server, device) on this Mac.

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
- Takeover: a user-initiated open of a screen that was not open (the dock button, 「打开屏幕」) and
  「重新接管」 take the session over; selecting an already open screen, automatic reconnects (restore
  after restart, lane reopen, resume) never do, and a taken-over screen stays detached until
  「重新接管」 — including after a restart, where 「打开屏幕」 only selects the restored screen.
- A helper of another version answering the socket (left by a previous desktop build) is told to
  retire (`ScreenHelperRetire`): it stops listening at once; if it holds a live session the worker
  keeps serving that session over the existing connection and the helper exits when it ends
  (close or grace), after which the worker's reconnect starts the shipped binary; holding none, it
  exits now. A helper the worker cannot serve through (protocol, refused hello) gets
  `tear_down`: it ends its session immediately (display removed, arrangement restored) and exits.
  Two helpers never hold virtual displays at the same time.
- Unlock handoff: Screen Sharing must be turned on in the remote Mac's System Settings → General →
  Sharing (Coflux does not enable it). The forward closes after a minute with no open connection, and
  with the device's screen session (disconnect, unmount, window reload), ⌘R and app quit, which cuts a
  live Apple Screen Sharing window ("connection lost"); every central disconnect and ⌘R's transport
  reset also abandon the tunnel lane and drop it. Not covered: a sleeping Mac, FileVault pre-boot or the
  login window after a reboot.
- Cursor shapes come from `NSCursor.currentSystem`; when unreadable the helper falls back to
  cursor-in-video.
- Not measured: a Mac with no physical display at all; decode throughput at 2880×1800@60.
