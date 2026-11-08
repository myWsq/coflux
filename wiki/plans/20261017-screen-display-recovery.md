# Plan 20261017-screen-display-recovery: the remote screen survives exit→reopen and resizing, and its failures are recoverable

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat d34581cf..HEAD -- native/screen apps/desktop/src/renderer/components/workbench/screen-session.ts apps/desktop/src/renderer/components/workbench/screen-view.tsx crates/runtime/src/screen.rs`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check (2026-10-17)
- Stop after: implementation — departure check (plan audit chosen)
- Plan review: audit — departure check
- Workspace: isolated — cut from the main worktree into `.claude/worktrees/20261017-screen-display-recovery`, branch `dev/20261017-screen-display-recovery`
- Planned at: `d34581cf`, 2026-10-17

## Requirement

On a controlled Mac, the remote screen works for the first session after the `coflux-screen` helper starts and breaks after that. Typical sequence: resizing the screen view freezes the picture behind an endless 「正在那台 Mac 上准备虚拟显示器…」 spinner. Closing the view and reopening it within seconds fails with `virtual display did not come online (displays asleep?)`. 重试 then fails the same way, every time. The helper process never exits while its runtime is connected (`ScreenHelper.swift:711-723`, the idle exit needs no worker *and* no session), so the device stays broken until its runtime restarts.

Evidence, captured on device `coflux:device:c4723d40` (Bytedance Work, macOS 27.2, v2.19.1, helper pid 3696, 2026-10-17 15:37 +08:00), from `~/.coflux/daemon.log`, `pmset -g log` and `log show` for WindowServer and coflux-screen:

- 15:37:06 session #1 creates display 6. Mode selection and mirroring succeed, and it streams. In the same second WindowServer logs `Timed out 0.250 second wait for reply ... for synchronous notification type 115 (kCGSDisplayDidReconfigure2) (CID ..., PID 3696)`, and keeps doing so on every reconfiguration. The helper never answers display reconfiguration notifications.
- 15:37:28–30 three resizes. WindowServer applies all three (`CGXVirtualDisplayApply ... successfully updated`). The helper never again issues a display configuration (no `kCGSConfigureForAppOnly`), so mode selection never got past its candidate search: the helper's CoreGraphics view of the display's modes was stale.
- 15:37:39 the view is closed and display 6 is destroyed. At 15:37:43 the view reopens and creates display 7, which WindowServer brings online at 15:37:43.588. The helper polls `CGGetOnlineDisplayList` for 15 s without seeing it and fails the open with `no_display`. 重试 at 15:38:10 re-applies settings to the same display and fails identically 15 s later. A fresh probe process on the same Mac lists `[1, 7]` immediately.
- Afterwards display 7 stays online, unmirrored, extended to the right of the built-in display. Windows can land on a screen nobody on that Mac can see, until the controlling tab is closed.

Root cause: `native/screen/Sources/coflux-screen/main.swift:62` parks the main thread in `dispatchMain()`. The main CFRunLoop never runs, so CoreGraphics in the helper never processes WindowServer's display reconfiguration notifications. Its process-local display state (online list, modes) stays at whatever it was when the helper's SkyLight connection was set up. Expect the first session after the helper starts to work and every later display change in that process to fail. The fix is not yet proven on a device; real-device acceptance below proves it.

Done means:
- On a controlled Mac, the screen streams again after any sequence of resizes and close→reopen cycles, in the same helper process and without restarting the runtime.
- When a display operation does fail, the controlling view shows the existing error state 「连接失败」 with 重试 instead of a spinner, and 重试 can succeed.
- The controlled Mac is never left with a Coflux virtual display while nothing is streaming because of a failure.

Product surface (no product grilling, bug fix): the only visible behaviour change is that a failure after the session opened (a failed resize, a failed capture start) shows the existing 「连接失败」 overlay (`screen-view.tsx:636-644`) with the helper's error text and 重试, instead of the 「正在准备」 spinner (`screen-view.tsx:584-590`). No new copy beyond the error texts the helper sends.

## Decisions & tradeoffs

- **The helper runs the main CFRunLoop**: replace `dispatchMain()` with running the main run loop, in a form that never returns: `RunLoop.main.run()`, or `CFRunLoopRun()` inside a loop. A bare `CFRunLoopRun()` returns if the loop is ever stopped. All helper work stays on the main queue, which a running main run loop also drains. The helper also registers `CGDisplayRegisterReconfigurationCallback` and logs one line per reconfiguration (display id and flags, coalesced if noisy). This witness proves that notifications now arrive; acceptance and the STOP condition rely on it. (revised on plan audit) Rejected: working around stale CG state by reading displays through ScreenCaptureKit or by re-querying harder. Mode selection and mirroring (`CGConfigureDisplayWithDisplayMode`, `CGConfigureDisplayMirrorOfDisplay`) go through the same per-process CG state, so only fixing notification delivery fixes all of them. Also rejected: restarting the helper after each session. That hides the bug, kills a live session on resize, and races the runtime's respawn. Based on: `main.swift:62`; the WindowServer `kCGSDisplayDidReconfigure2` timeouts naming the helper's pid; display 7 online in WindowServer and in a fresh process while the helper's 15 s poll (`VirtualDisplay.swift:104-117`) never saw it.
- **Display configuration is serialized, latest wins**: at most one wake→apply→waitOnline→selectMode→mirror chain is in flight per session. An open or resize that arrives while a chain is in flight supersedes it. The newest wanted geometry is what gets applied, either by restarting or by chaining once the current step ends; the executor's call. A superseded chain's later callbacks never change session state (`displayReady`, `lastError`, phase, capture) and never send `ScreenSessionOpened`/`ScreenSessionState`. A superseded chain also stops touching the display. Only the effective chain may call the provider (`apply`/`destroy`) or any `DisplayConfiguration` function, and that includes the failure teardown. `wakeDisplays`, `waitOnline` and `settle` take a cancellation check, evaluated before each poll and each `attempt()`, so a superseded `settle` does not keep issuing `selectMode` at the old geometry. Every `ScreenSessionOpen` gets exactly one `ScreenSessionOpened`, including an open whose chain was superseded or coalesced: the desktop shows an error for any open left unanswered after 20 s (`screen-session.ts:104,514-518`). (revised on plan audit) Rejected: debouncing on the controlling side only. The desktop already debounces 150 ms (`screen-session.ts:103,233-239`), yet three applies still landed within 1.7 s today, and opens and resizes can interleave. Based on: `ScreenHelper.swift:126-136` and `:290-294` start independent `applyGeometry` chains; `:444-480` checks only `self.session === session` at each step.
- **A failure leaves no virtual display behind, and the session survives it**: when the effective chain of an open or a resize fails, the helper destroys its virtual display and restores the arrangement (`provider.destroy()` + `restoreArrangement()`), so the controlled Mac goes back to its own displays while the controlling view shows the error. The teardown covers the display only. The `Session`, its holder and epoch, lanes, permission polling, tick timer and grace logic stay as they are. The helper does not call `tearDown(_:restore:)`, which also stops polling and timers (`ScreenHelper.swift:581-592`); a retry on the existing session would never re-acquire those, because only the new-session branch does (`:251-256`). It also sends no `ScreenSessionEnded`, which the desktop treats as "reopen automatically" (`screen-session.ts:637-647`). Power assertions are released on failure (decided while planning: the error overlay can sit there indefinitely and must not keep the remote awake and unlocked) and re-acquired when the next chain starts. The helper then reports the failure: `ScreenSessionOpened{ok:false, code:"no_display"}` for an open, as today, and a status carrying the error for a resize. The desktop's 重试 must then succeed: same session id, new lanes, `ScreenSessionOpen` again; `handleOpen` re-applies when `displayReady` is false (`ScreenHelper.swift:263`) and `CGVirtualDisplayProvider.apply` recreates a destroyed display (`VirtualDisplay.swift:45-61`). (revised on plan audit) Rejected: keeping the failed display so that a retry is faster. It leaves an invisible extended screen on someone's Mac indefinitely (observed: display 7 still online minutes later). Based on: `ScreenHelper.swift:264-279`; the observed `system_profiler` state.
- **A failure after the session opened is shown as the error state, without a protocol change**: there is no error phase in `ScreenSessionPhase` (`proto/coflux/v1/device.proto:1478-1490`). The desktop maps a `STARTING` status that carries a non-empty `error` to its `error` phase. Any other phase keeps its current mapping, and a later status without an error (for example `STREAMING`) returns the view to normal, since `screenSessionState` is applied whenever `opened` is true (`screen-session.ts:589-593`). For this to work, the helper follows two rules. (revised on plan audit)
  (a) `lastError` is reset at the start of every attempt: open handling, display chain start, capture start. Today it is cleared only on success (`ScreenHelper.swift:473-474`). The reset covers the `handleOpen` path that skips the chain (`:290-294`, `finish(nil)` straight away) and resume (`:142-147`).
  (b) Every change to `lastError` is reported to the control lane. Today `updatePhase` sends only on a phase or permission change (`:630-633`), so a capture start failure (`:499-503`), which happens while the phase is already STARTING, is never seen, and the view stays a spinner. A chain start sends a state (STARTING, no error), so the desktop drops back from 「连接失败」 to the spinner while a retry runs. Rejected: adding `SCREEN_SESSION_PHASE_ERROR`. That needs a protocol change in both `crates/protocol` and `packages/protocol` plus `buf breaking`, and an old desktop would map it to `UNSPECIFIED`→starting anyway. Based on: `screen-session.ts:681-695`; `screen-view.tsx:584-590,636-644`.
- **Failures are diagnosable** (decided while planning): the helper logs a line for every failed display chain (open or resize, with the geometry and the error), not only for opens (`ScreenHelper.swift:268`). The "did not come online" error mentions sleeping displays only when `CGDisplayIsAsleep` says the main display is asleep at the time of failure. Wording is the executor's call.
- **Left to the executor**: the serialization mechanism (generation token, queue, state machine), the run-loop API, the log and error wording, and whether to add unit tests through a seam. If the executor extracts a pure coordinator, test it there. Do not mock CoreGraphics to test `ScreenHelper`.

## Direction

The core fix and the recovery behaviour are in the Swift helper, `native/screen`. The desktop change is a small mapping in the renderer's screen session. The Rust runtime bridge, the wire protocol and the server are untouched.

### Milestone 1: the helper sees display changes and serializes display configuration

After this milestone, the helper runs the main run loop, display configuration is serialized latest-wins per the decision above, and a superseded chain cannot mutate the session. Signal handlers, timers, the socket server and the ScreenCaptureKit `@MainActor` tasks keep working under the run loop. Validation: `node scripts/build-screen-helper.mjs target/screen-ci --test` → exit 0 (warnings in `native/screen` are fatal).

### Milestone 2: helper failures are recoverable and visible

After this milestone:
- A failed open or resize tears down the display only and releases power until the next chain.
- The helper reports the failure: opened-not-ok for an open, a status carrying the error for a resize.
- Errors follow rules (a) and (b): reset at every attempt start, and every change reported, including a capture start failure.
- Every failed chain is logged. Validation: same command → exit 0.

### Milestone 3: the desktop shows a post-open failure as the error state

After this milestone, a `STARTING` status with a non-empty error renders the 「连接失败」 overlay with 重试, and a later clean status restores the normal phases. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0.

Dependencies: Milestone 2 builds on Milestone 1 (same files, same chain), so do them sequentially. Milestone 3 depends only on the contract in Decisions (STARTING + error ⇒ error) and is independent of 1 and 2. It can run as a separate package, but it is small; one package is fine.

## Landmines

- **The helper never exits while its runtime is connected** (`ScreenHelper.swift:711-723`). One helper process serves every session for days: today's helper (pid 3696) had run since 2026-10-14. Any per-process state that goes stale accumulates. Do not count on a respawn to reset it.
- **WindowServer defers configuration while every display sleeps.** A destroy may log `not found` and still leave the display until wake (memory `remote-desktop-tcc`; `VirtualDisplay.swift:12-14`). The provider reuses a fixed serial on purpose (`VirtualDisplay.swift:30,56`), and `displayID` looks the display up by vendor/product/serial because a display created while asleep comes online under another id (`VirtualDisplay.swift:32-43`). Keep both behaviours. The new teardown-on-failure must not assume a destroy is effective immediately.
- **`CGVirtualDisplay` with hiDPI takes the mode in points, not pixels** (`VirtualDisplay.swift:65-71`, plan `20261010-screen-lane-frames`). Do not "fix" mode selection by passing pixels.
- **`DisplayConfiguration.settle` retries for 3 s on purpose**: a display that just came online, or was just re-applied, refuses mode changes and mirroring with kCGErrorFailure until it settles (`VirtualDisplay.swift:119-138`). A latest-wins restart must not shorten a settle into an instant failure.
- **The resize completion restarts capture even on error** (`ScreenHelper.swift:131-136`), and `startCaptureIfPossible` reports `STARTING` when `displayReady` is false (`:482-485`, `:617-634`). This is the path that produced the endless spinner. With the new mapping, a stale `lastError` on such a report would flip the desktop to error during an in-flight retry.
- **`handleOpen`'s completion is guarded by holder epoch** (`ScreenHelper.swift:264-265`) and the resize completion by session identity only (`:131-132`). The new supersede check has to hold for both entry points.
- **The chain's worst case exceeds the desktop's open timeout**: wake 5 s + waitOnline 15 s + two settles of 3 s each (`VirtualDisplay.swift:88,104,123`) is more than `OPEN_TIMEOUT_MS = 20_000` (`screen-session.ts:104`). The desktop can show 「连接失败」 before the helper reports, and a 重试 in that window closes the lanes and opens again mid-chain. That is a supersede case and must behave as the serialization decision says. Whether to also shorten timeouts is the executor's call. (added on plan audit)
- **Keep the desktop's phase and error text consistent**: the Opened path forces `error: null` after the status patch (`screen-session.ts:581`). If the STARTING+error mapping lives in `phaseFrom`, make sure no path yields phase `error` with null text, which would render the generic 「远端没有响应。」. In the error phase the ResizeObserver keeps calling `applySize` (it only needs `opened`), which starts helper chains silently; rule (b) is what keeps the view truthful then. (added on plan audit)
- **Build with the 26.x SDK through the script.** CLT's MacOSX27 SDK breaks Swift/C builds (`scripts/build-screen-helper.mjs:10,40`). Use the script, not a bare `swift build`.

## Merge and deploy

- CI's `screen-helper` job (`.github/workflows/ci.yml:211-223`, macOS runner) is the only automated gate for `native/screen`. Nothing automated exercises display reconfiguration, so the real-device acceptance below must pass before merging.
- The fix ships in the desktop runtime bundle: the helper is bundled and signed with it. A controlled Mac gets it only once its runtime updates to a release containing it. The runtime then retires the stale helper after its live session ends (`crates/runtime/src/screen.rs:436-454`). Release notes: "Remote screen: resizing and reopening no longer breaks the connection; a failure shows Retry instead of a spinner."
- No protocol, server, migration or env change.

## Acceptance (orchestrator with the user, after review — not the executor)

Controlled Mac: Bytedance Work (`coflux:device:c4723d40`). Controller: Home (this Mac).

1. Build the helper on Home: `node scripts/build-screen-helper.mjs <mktemp dir>`.
2. Get the binary onto Work, either through a Coflux preview URL downloaded in a built-in browser tab on Work, or by building on Work if it has a checkout of this branch. Back up the installed helper, then swap it in: `~/.coflux/desktop-runtimes/<active runtime id>/coflux-screen`; the id is in `~/.coflux/runtime.active`, `b82191cad5b9ffa15ec13859` at planning time. Close any open screen view for Work first, then kill the running `coflux-screen`. The runtime respawns it from the same path (memory `remote-desktop-tcc`: this swap method was proven on 2026-10-10; TCC attributes the helper to `dev.coflux.desktop`). Restore the backup afterwards.
3. Run the controller with this branch's renderer: `pnpm dev:desktop:prod` (desktop-preview skill), or the installed app for steps 4–5 only.
4. Pass:
   - Check first: the first session in the freshly spawned helper still streams. If it no longer does, the synchronous CG configuration calls are waiting on something the main thread now services differently. That is the signal to stop, not a reason to tune the chain.
   - `daemon.log` shows the reconfiguration-callback witness line after each resize and each open.
   - Open Work's screen and drag-resize the view repeatedly, including fast drags and switching resolution presets: the picture follows every time.
   - Close the view and reopen it within 5 s, at least three times in the same helper process: it streams every time.
   - Work's `daemon.log` shows no `display failed`.
   - WindowServer logs no `kCGSDisplayDidReconfigure2` timeouts for the helper's pid: `log show --style compact --last 5m --predicate 'process == "WindowServer"' | grep "Timed out"`.
5. Failure path (only if a failure can be provoked, for example with every display asleep and the lid closed): the view shows 「连接失败」 + 重试, `system_profiler SPDisplaysDataType` on Work lists no `Coflux Screen`, and 重试 recovers once the displays wake.

## Scope

In scope:
- `native/screen/Sources/coflux-screen/main.swift`
- `native/screen/Sources/CofluxScreenCore/ScreenHelper.swift`
- `native/screen/Sources/CofluxScreenCore/VirtualDisplay.swift`
- new files and tests under `native/screen/` if a seam is extracted
- `apps/desktop/src/renderer/components/workbench/screen-session.ts` (and its test file)
- `apps/desktop/src/renderer/components/workbench/screen-view.tsx`, only if the error overlay needs the text it already receives
- `wiki/plans/README.md`, this plan

Out of scope:
- `proto/`, `crates/protocol`, `packages/protocol`: no wire change (see Decisions).
- `crates/runtime/src/screen.rs`: the bridge and the helper lifecycle are not the cause.
- Automatic retry on the desktop after an error: 重试 stays manual. The underlying cause is what gets fixed.
- The privacy curtain and lock-screen work (PR #113, plan `20261017-locked-screen-sharing-unlock`).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (fresh worktree) | `pnpm install` | exit 0 |
| Helper build + XCTests (warnings fatal) | `node scripts/build-screen-helper.mjs target/screen-ci --test` | exit 0 |
| Desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Two-Mac walkthrough (acceptance) | see "Acceptance" above | all pass items hold |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] The helper runs the main run loop in a non-returning form and logs a reconfiguration-callback witness.
- [ ] At most one display configuration chain is effective per session. A superseded chain's callbacks cannot change session state, send replies, or call the provider or `DisplayConfiguration`. The wait helpers are cancellable.
- [ ] Every `ScreenSessionOpen` receives exactly one `ScreenSessionOpened`.
- [ ] A failed open or resize destroys the display and restores the arrangement (display-only teardown, no `tearDown(_:restore:)`, no `ScreenSessionEnded`), releases power assertions until the next chain, reports the failure and logs it.
- [ ] `lastError` resets at every attempt start, and every change to it reaches the control lane, including a capture start failure. A chain start reports STARTING with no error.
- [ ] The desktop maps `STARTING` + non-empty error to `error`, and a later clean status recovers.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (for example, the helper already runs a run loop on this branch's base).
- The outcome requires a protocol change or changes to `crates/runtime`.
- A validation command fails twice after one reasonable fix.
- Real-device acceptance shows that display changes still go unseen with the main run loop running (no witness lines, or the first session breaks). The root-cause assumption is then false; report the evidence, do not stack workarounds.

## Maintenance notes

- **Corrected 2026-10-18 (v2.19.2 on Work):** the main run loop alone is not enough. Under `RunLoop.main.run()` the shipped helper still never saw its display come online (`virtual display did not come online`, the witness line naming the display `added removed` only at the failure teardown), and a probe on the same Mac reproduced it: with a plain run loop the reconfiguration callback never fires and the created display has no modes; with `NSApplication.shared` (`.prohibited`) + `run()` the callback fires within 10 ms of `apply` and the modes are there. WindowServer delivers these notifications through the event port only AppKit's loop drains. The helper now runs `NSApplication` (`main.swift`). Any future helper code that queries CoreGraphics display state relies on it: do not move the helper back to a bare run loop or `dispatchMain()`, and do not block the main thread for long.
- The per-process CG state is invisible in the helper's own log. When a remote screen "does not come online", compare WindowServer's log (`log show --predicate 'process == "WindowServer"'`, look for `CGXVirtualDisplay*` and `Timed out ... kCGSDisplayDidReconfigure2`) with a fresh process's `CGGetOnlineDisplayList` before suspecting sleep.
