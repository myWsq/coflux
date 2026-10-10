# Plan 20261010-screen-lane-frames: A remote screen tab's frames actually leave the controlling Mac

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 0e2fd7c9..HEAD -- apps/desktop/src/main/screen-host.ts apps/desktop/src/renderer/components/workbench/screen-session.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/main/index.ts docs/remote-screen.md`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check in `dev:explore`, 2026-10-10
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check (plain autopilot)
- Workspace: isolated — cut from the main worktree (`<dev-workspace>` kind main, pending 0) into `.claude/worktrees/20261010-screen-lane-frames` on `dev/20261010-screen-lane-frames`
- Planned at: `0e2fd7c9`, 2026-10-10

## Requirement

The remote screen tab (plan `20260929-remote-desktop`, shipped since v2.12.0) has never worked end to end. Opening 「屏幕」 for another Mac shows 「正在那台 Mac 上准备虚拟显示器…」 and after 20 s 「连接失败 · 远程设备没有响应打开请求」; the remote Mac shows nothing.

Root cause, verified on 2026-10-10:

- The renderer sends every lane frame to main as `port.postMessage({ type: "send", lane, data: bytes.buffer }, [bytes.buffer])` (`apps/desktop/src/renderer/components/workbench/screen-session.ts:440`, via `post` at `:354-357`), and the remote clipboard image the same way (`:586`).
- A windowless Electron 44.3.0 probe: a renderer `MessagePort` → `MessagePortMain` message whose `ArrayBuffer` is in the transfer list arrives in main with `data` null; the same message without a transfer list arrives as an `ArrayBuffer` of the right length.
- Main's `handleRequest` (`apps/desktop/src/main/screen-host.ts`, case `"send"`, and `applyRemoteClipboard`) returns silently when the data is not an `ArrayBuffer`, writing nothing to `~/Library/Logs/Coflux/main.log`.
- So the lanes open, but `ScreenSessionOpen`, input, video credit, keyframe requests and clipboard never leave the controlling Mac. Reproduced live Work → Home: neither Mac's runtime nor `coflux-screen` logged a session; Home had no virtual display and no power assertion.

Once this is done: frames the renderer sends on a screen lane reach the transport, the remote helper receives `ScreenSessionOpen` and answers, and a remote clipboard image reaches the local clipboard. Any request main cannot use leaves a line in `main.log`. No product behaviour, copy or UI changes — the experience redesign is a later, separate round after a real two-Mac walkthrough.

## Decisions & tradeoffs

- **Renderer → main screen messages carry no transferable `ArrayBuffer`.** Data crosses that port by structured clone. Rejected: keeping the transfer list — Electron 44.3.0's `MessagePortMain` drops the payload (probe above; `MessagePortMain.postMessage` also only transfers ports, the reverse direction, `screen-host.ts:68-76`). Rejected: routing frames over `ipcRenderer`/`webContents.send` — the port exists to avoid that path. The exact shape (plain clone of an exactly-sized `ArrayBuffer`, `Uint8Array`, etc.) is the executor's call, provided main still receives something it validates by type and size. Based on: probe 2026-10-10; `screen-session.ts:354-357,440,586`; `screen-host.ts` `handleRequest`.

- **Main → renderer stays as it is.** A second probe confirmed `MessagePortMain.postMessage({ type: "frame", data: arrayBuffer })` delivers a 300 KiB `ArrayBuffer` intact to a renderer `MessagePort`. Do not change the video delivery path.

- **The screen host is diagnosable: a request main drops, and a lane that fails to open or closes, leaves a line in `main.log` through the host's existing `log` option** (`apps/desktop/src/main/index.ts` passes `log.warn`). Throttling and wording are the executor's call, but a dropped or malformed request must be logged at least once per session — it may be rate-limited, never reduced to zero. No frame contents and no clipboard contents in the log. Rejected: logging every frame — video runs at tens of frames per second.

- **No new automated test unless it guards something a person would not notice.** Per `AGENTS.md` (Test harness), the screen tab is accepted by hand. A small pure-function test is acceptable only if it pins a contract that would otherwise fail silently again (for example, main's request validation accepting what the renderer sends); a test that restates the implementation is not wanted.

## Direction

### Milestone 1: frames and clipboard images reach main, and failures leave a trace

The renderer's send path and the clipboard-image path deliver their bytes to main in a form main accepts. Main logs dropped/malformed requests, lane-open failures and lane closes as decided above. The stale comments are corrected: `screen-host.ts:8-9` ("frames cross as transferred buffers, never structured clones") and the MessagePort line in `docs/remote-screen.md`, both saying which direction may not use a transfer list and why, so nobody adds it back.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

One milestone; nothing to fan out.

## Landmines

- `screen-session.ts:440` sends `bytes.buffer`, not the view's own range. `encodeDeviceEnvelope` (`packages/protocol/src/index.ts:169`) returns a `Uint8Array` that may be a view on a larger buffer; without the transfer list, cloning `bytes.buffer` would send its whole backing store and the remote would decode a frame with trailing garbage. Send exactly `byteOffset .. byteOffset + byteLength`, as main's `frame` handler already does (`screen-host.ts`, in `openLanes`), and as `:586` already slices.
- Main checks `request.data instanceof ArrayBuffer` and a size cap before sending; if the executor changes the shape (e.g. to a `Uint8Array`), the validation and the shared type `DesktopScreenPortRequest` (`apps/desktop/src/shared/desktop-bridge.ts:168-173`) must change with it, or every frame is dropped again — silently, unless the new logging catches it.
- Video credit returns travel on the video lane from the renderer too; they go through the same `send` path. After the fix they will actually flow, so the credit-window logic runs for the first time in production.

## Merge and deploy

- Desktop only. No server, runtime, helper or protocol change; no migration; no environment variable.
- The fix lives in the controlling Mac's app. The controlled Mac needs only an existing `screen_v1` runtime (both Home and Bytedance Work have one at v2.18.0).
- After this, downstream stages that have never run in production (virtual display, capture, encode, decode, credit) will run for the first time; failures there are new findings for the follow-up round, not regressions of this change.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/screen-session.ts`
- `apps/desktop/src/main/screen-host.ts`
- `apps/desktop/src/shared/desktop-bridge.ts` (only if the request shape changes)
- `apps/desktop/src/main/index.ts` (only if the `log` wiring needs to change)
- a test under `apps/desktop/src/**` only per the test decision above
- `docs/remote-screen.md`
- `wiki/plans/README.md` and this plan

Out of scope:
- `native/screen`, `crates/`, `proto/`, `apps/server`, `packages/` — the remote side and the wire contract are not at fault
- any product, UI or copy change to the 屏幕 tab — the redesign round follows the walkthrough
- other renderer ↔ main paths — none of them use a transfer list (`grep -n "postMessage(.*\[" apps/desktop/src/renderer` finds only the screen session)

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (fresh worktree) | `pnpm install` | exit 0 |
| Desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Side-by-side packed app on Work (acceptance) | see "Acceptance: quick two-Mac check" below | Work's 屏幕 tab for Home shows a picture |

## Acceptance: quick two-Mac check (orchestrator with the user, after review — not the executor)

No release. The user sits at Bytedance Work and controls Home. Hard constraints:

1. **Pack on Home with the installed app's daemon bundle, unsigned.** Copy `/Applications/Coflux.app/Contents/Resources/daemon/` to a `mktemp -d` directory, then `CSC_IDENTITY_AUTO_DISCOVERY=false COFLUX_DESKTOP_DAEMON_DIR=<copy> pnpm -C apps/desktop run pack` (`run pack`: plain `pack` is pnpm's own command). The keychain holds an Apple Development identity that electron-builder could otherwise use to re-sign `mac.binaries`.
2. **Gate before it runs anywhere:** the packed `Contents/Resources/daemon/` must be byte-identical (sha256) to the installed one for all six binaries in `DAEMON_BINARIES`, `VERSION` (`v2.18.0`) and `claude-plugin/.claude-plugin/plugin.json`. Both Macs run desktop runtime `e6eb251ffb72f5156306d55a`; any difference makes Work's daemon manager switch runtimes (and leave + restart a changed launcher). On any mismatch: do not start it.
3. **Transfer** through Coflux's own tunnel: serve the zipped `.app` from a Home workspace (`python3 -m http.server`), get the preview URL with `coflux ports`, and have the user download it in a built-in browser tab on Work; then `xattr -dr com.apple.quarantine` on it.
4. **Start beside the installed app with its own profile:** `open -n --env COFLUX_DESKTOP_USER_DATA=<mktemp dir> <path>/Coflux.app`. The user signs in through the browser once (the profile has no token). The installed app keeps running.
5. **Stop only with `kill -9` on the packed app's exact executable path. Never ⌘Q it**: quit runs `stopForExit("quit")` (`apps/desktop/src/main/index.ts:153-172`), which stops the runtime and every terminal on Work. Tell the user: if a 「退出 Coflux」 confirmation appears, press 取消.
6. Known side effect: the second instance reports to Work's daemon as executor host; after it is killed, Work's executor may be unavailable until the installed app reconnects.
7. What to expect on Home: Accessibility is denied (`daemon.log`: `accessibility false`), so the first picture is read-only — expected, not a failure. Home is unattended and its display may be asleep, so the helper's display-wake path is exercised too.
8. Pass: `main.log` of the packed instance shows no dropped requests, Home's `daemon.log` shows the session (display, capture lines), and the Work tab shows Home's screen. Anything failing after `ScreenSessionOpened` is a finding for the follow-up round.

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] No renderer → main screen message carries an `ArrayBuffer` in a transfer list; what is sent is exactly the encoded bytes (no backing-store tail).
- [ ] A dropped or malformed screen request, a failed lane open and a lane close each produce a `main.log` line, at least once per session.
- [ ] `screen-host.ts` header comment and `docs/remote-screen.md` describe the direction-specific rule.
- [ ] Any test added pins a contract rather than restating code.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Why this survived since v2.12.0: plan `20260929-remote-desktop` was accepted on typecheck, unit tests and a packed-bundle check; its two-Mac walkthrough never ran, and main's silent `return` hid the drop. Keep the "at least once per session" log rule.
- The follow-up round (experience redesign) starts from what the two-Mac check shows; the user has not yet said what product it should feel like.
- Home's Accessibility permission for Coflux is denied (since 2026-09-17); full control of Home needs it granted on that Mac.
