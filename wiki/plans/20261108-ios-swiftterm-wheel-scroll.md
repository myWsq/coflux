# Plan 20261108-ios-swiftterm-wheel-scroll: Swiping scrolls full-screen TUIs on iOS (SwiftTerm 1.99.3)

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat afe5a152..HEAD -- apps/ios/Coflux/Views/TerminalHostView.swift apps/ios/Coflux.xcodeproj/project.pbxproj apps/ios/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(sonnet) — departure check (2026-11-08)
- Stop after: implementation — departure check: full autopilot
- Plan review: none — departure check: full autopilot
- Workspace: isolated — cut from the main worktree at `afe5a152` (`.claude/worktrees/20261108-ios-swiftterm-wheel-scroll`, branch `dev/20261108-ios-swiftterm-wheel-scroll`)
- Planned at: `afe5a152`, 2026-11-08

## Record

### Requirement

On the iOS app, Claude Code's fullscreen mode (and any full-screen TUI that
turns on mouse reporting) cannot be scrolled with a finger. Claude switches
to the alternate screen (`?1049h`, which has no scrollback) and enables mouse
reporting (`?1000h` + `?1006h` SGR; it also sets `?1007h`). SwiftTerm 1.15.0, which
the app pins, then installs its own one-finger pan recognizer that turns a
swipe into a left-button press at the start cell and a release at the end
cell (`iOSTerminalView.swift` `panMouseHandler`, `mouseModeChanged`). It never
sends wheel reports. A swipe therefore does not scroll, lands in Claude as a
stray click, and fights the scroll view's own pan, which is the "it took over
the interaction" feel the user reported.

SwiftTerm fixed this upstream in PR #657 (merged 2026-09-03, released in
1.99.0). One-finger vertical drags become bounded wheel reports while the
program tracks the mouse, with a token bucket of 100 reports/s and a burst of 6.
They become arrow keys on the alternate screen when the program enabled
alternate-scroll mode (DECSET 1007) without mouse tracking. Two-finger drags
keep the local scrollback. 1.99.1–1.99.3 add iPad pointer/trackpad wheel
reporting, scrollback refresh and Metal fixes. 1.99.x is the "preview before
2.0", whose API removes `TerminalView.getTerminal()`.

Done means the app builds against SwiftTerm 1.99.3 with no behaviour of our
own added. On the device the behaviour is upstream's (product confirmation,
2026-11-08):

- Claude fullscreen (mouse tracking on): a one-finger up/down swipe scrolls
  Claude's conversation. A tap still reaches Claude as a click, as today.
- A plain shell with no full-screen program: unchanged. A one-finger swipe
  scrolls local scrollback.
- Alternate screen without mouse tracking (less/vim): a one-finger swipe
  sends arrow keys only when the program enabled 1007, otherwise nothing.
- A two-finger swipe always moves local scrollback.

Everything else the terminal host does must keep working:

- DECCKM-aware arrow keys from the input panel.
- The scroll-to-bottom button and its at-bottom state.
- The bottom-slack lift.
- Replace frames resetting before replay.
- Attach at the real dimensions.
- http(s) link opening.
- OSC 52 copy, with read always refused.

### Decisions & tradeoffs

- **D1 Take upstream's gesture routing, write no gesture code**: upgrade SwiftTerm and keep `allowMouseReporting` at its default (`true`). Rejected: our own swipe-to-wheel recognizer on 1.15.0, as shepherd PR #2687 and terminatr PR #925 did. It duplicates what 1.99 ships with rate limiting, and those patches needed several rounds to fix a competing recognizer and wheel bytes sent after tracking ended. Also rejected: `allowMouseReporting = false`. In 1.15 that turns swipes into cursor keys, which page through Claude's prompt history, and it would drop tap reporting. Based on: SwiftTerm PR #657 description; product confirmation answer 「就按这个来」.
- **D2 Pin exactly 1.99.3**: change the package requirement from `upToNextMajorVersion` from `1.2.0` to `exactVersion` `1.99.3`. Rejected: keeping the up-to-next-major range. 1.99.x is a preview line that changes behaviour between patches, and a later package resolve would silently move the gesture code. Based on: `apps/ios/Coflux.xcodeproj/project.pbxproj` `XCRemoteSwiftPackageReference "SwiftTerm"` (`minimumVersion = 1.2.0`). Tag `v1.99.3` is commit `282c3c3a932b55c129628876b70f37d993af1615`. `(decided while planning)`
- **D3 Use only the 2.0 view API, never a raw `Terminal`**: every `getTerminal()` call becomes a copied read or a view command — `terminalInputStateSnapshot()` for modes and buffer kind, `terminalDimensions` for size, `terminalStateSnapshot()` for the cursor, and `resetToInitialState()` / `setCursorStyle(_:)` on the view. Rejected: reaching the terminal through any other path. 2.0 parses, renders and takes input on different threads, and a stored `Terminal` escapes its lock. Based on: SwiftTerm `Documentation.docc/MigratingFrom1To2.md` ("Replace direct Terminal access from `TerminalView`").
- **D4 Reset then feed keeps its order**: `TerminalView.resetToInitialState()` feeds `ESC c` through the same synchronous feed sender that `feed(byteArray:)` uses, so calling it right before `feed` preserves the replace-frame semantics. Based on: SwiftTerm v1.99.3 `AppleTerminalView.swift` `resetToInitialState()` → `feedSender.feed(text: "\u{1b}c")` and `configureFeedSender()` (parse runs on the caller's thread). `(decided while planning)`
- **D5 Bottom slack reads the cheap snapshot first**: `reportBottomSlack` runs after every output batch, and `terminalStateSnapshot()` copies the text of every visible row. Decide from `canScroll` and the input snapshot's `isAlternateBuffer` first. Take the state snapshot (for the cursor row) only when slack can be non-zero. Rejected: one `terminalStateSnapshot()` per batch. It costs a full-screen row-text copy on the main thread for every streamed chunk. Based on: SwiftTerm v1.99.3 `TerminalRenderOwner.swift` `stateSnapshot()`. `(decided while planning)`
- **D6 Move to the non-deprecated link callback**: implement `requestOpenLink(source:request:)` with the same http/https filter and drop the deprecated `requestOpenLink(source:link:params:)`. Rejected: keeping the deprecated method. It still works through upstream's shim but adds a deprecation warning. Based on: SwiftTerm v1.99.3 `TerminalViewDelegate.swift` (`@available(*, deprecated, message: "Implement requestOpenLink(source:request:)")`). `(decided while planning)`
- **D7 Base on main, not on the unmerged Duo redesign**: the branch is cut from `main`. Rejected: stacking on PR #126 (`dev/20261107-ios-duo-redesign`), which rewrites `TerminalHostView.swift`. The user chose main, accepting the later conflict with #126 in this file. Based on: base-branch answer 「基于 main」.

### Discussion log

- Diagnosis (chat): found that SwiftTerm 1.15.0 maps the swipe to a button drag under mouse tracking. Found that Claude's binary contains `?1049h` / `?1000h` / `?1006h` / `?1007h`. This was not traced at runtime.
- Community research (chat): Termux, ConnectBot, Blink and SwiftTerm-based iOS apps all converge on the same three routes (wheel / 1007 arrows / local scrollback). SwiftTerm upstream ships them in 1.99.0 (PR #657). Alternatives were weighed: libghostty-based views (Termini, libghostty-spm), libghostty-vt plus a custom renderer, and xterm.js or ghostty-web in a WKWebView. All need us to write the touch mapping, so the recommendation was to upgrade SwiftTerm.
- User: 「按你的建议立项 开始修复」, which approved the SwiftTerm upgrade direction.
- Product confirmation: upstream behaviour as listed in the Requirement (taps still reach Claude; revisit taps or momentum only if the Duo walkthrough shows a problem). Options were "as described (recommended)" and "don't forward taps". Answer: 「就按这个来（推荐）」.
- Base branch: options were "stack on PR #126 (recommended)" and "base on main". Answer: 「基于 main」. This settles D7.
- Departure check: execution subagent(sonnet) (recommended); autopilot "全自动直达执行" (recommended over plan audit and review pause).
- `(decided while planning)` D2 exact pin, D4 reset ordering, D5 cheap-first slack, D6 link callback.
- `(revised at verification)` Two gaps came up at verification, and both went back to the executor as REVISE round 1. First, SwiftTerm 1.99.3 brings new transitive packages (`h`, `swift-png`), so the resolver rewrote `Package.resolved` beyond the swiftterm pin; the resolver's output was committed unedited. Second, 1.99.3 runs a build-tool plugin (`SwiftTermBuildInfoPlugin`, which runs `git` and generates build-info and terminfo tables). Command-line builds fail at `Validate plug-in` unless they pass `-skipPackagePluginValidation`, so `apps/ios/release.sh`'s archive call now passes it. This was added to scope.

### Maintenance notes

- 1.99.x is a 2.0 preview. Moving to 2.0 final is a deliberate re-pin, so re-check the migration guide then.
- The gesture behaviour now belongs to SwiftTerm. If the Duo walkthrough wants different tap or momentum handling, open SwiftTerm PR #761 (`allowProgramScrollGesture`, open, unmerged at planning time); it is the intended hook for a host to take one-finger drags itself.
- In 2.0 the view's scroll geometry may update on the next frame rather than inside `feed`. The post-feed `reportScrollState()` could then read one frame stale until the next `scrolled` callback. Watch the scroll-to-bottom button on the device.
- PR #126 (Duo redesign) also edits `TerminalHostView.swift`, so whichever merges second resolves the conflict. #126 drops `onBottomSlackChanged`, which makes D5 moot there.

## Execution brief

> Written for `subagent(sonnet)` at `afe5a152`. Implement the tasks in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

Upgrade the iOS app's SwiftTerm dependency from 1.15.0 to exactly 1.99.3 so
that upstream's touch-gesture routing takes effect. It turns one-finger
swipes into wheel reports when a full-screen program tracks the mouse.
SwiftTerm 1.99.x removes `TerminalView.getTerminal()`. Migrate the one file
that uses it to the copied-read and view-command API, and change nothing
else about the terminal host's behaviour. Write no gesture code and do not
touch `allowMouseReporting` (D1). Keep the file's existing comment language
per site; new comments are English. There is no Swift formatter in this repo.

The 1.99.3 API you will use, all on `TerminalView` (from SwiftTerm v1.99.3
source):

- `public nonisolated func terminalInputStateSnapshot() -> TerminalInputStateSnapshot?`. It carries `dimensions: TerminalDimensions`, `isAlternateBuffer: Bool`, `applicationCursor: Bool` and `mouseMode`. It is nil only when no terminal is attached, which does not happen after `init`.
- `public nonisolated var terminalDimensions: TerminalDimensions`, with `cols: Int` and `rows: Int`.
- `public nonisolated func terminalStateSnapshot() -> TerminalViewStateSnapshot`. It carries `dimensions`, `cursor: Position` (fields `col`, `row`; `row` is the cursor's screen row, the same value 1.x `getCursorLocation().y` returned) and `visibleRows`, which is expensive.
- `public nonisolated func resetToInitialState()`. It feeds RIS through the same ordered feed path as `feed(byteArray:)` (D4).
- `public func setCursorStyle(_ style: CursorStyle)`.
- `canScroll`, `scrollPosition`, `scroll(toPosition:)`, `installColors(_:)`, `font`, `nativeBackgroundColor`, `nativeForegroundColor` and `caretColor` are unchanged.
- `TerminalViewDelegate.requestOpenLink(source: TerminalView, request: TerminalLinkRequest)`. `request.link` is the link `String`; `request.params` holds the OSC 8 params. The old `requestOpenLink(source:link:params:)` is deprecated.
- Every other delegate method the coordinator implements keeps its 1.x signature: `send`, `sizeChanged`, `scrolled`, `setTerminalTitle`, `hostCurrentDirectoryUpdate`, `bell`, `clipboardCopy`, `clipboardRead`, `iTermContent` and `rangeChanged`.

### Milestone 1: The app depends on SwiftTerm 1.99.3 and compiles against it

Depends on: none. A single package; T1 and T2 must land together for the app
to build.

#### T1 · SwiftTerm is pinned to exactly 1.99.3

- Where: `apps/ios/Coflux.xcodeproj/project.pbxproj`, the block `CF0000000000000000000023 /* XCRemoteSwiftPackageReference "SwiftTerm" */`; and `apps/ios/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`, the pin whose `"identity" : "swiftterm"`.
- Change: in the pbxproj, replace the `requirement` dictionary's contents with an exact-version requirement for `1.99.3` (`kind = exactVersion; version = 1.99.3;`). In `Package.resolved`, set the swiftterm pin's `revision` to `282c3c3a932b55c129628876b70f37d993af1615` and its `version` to `1.99.3`.
- After: the project requests SwiftTerm `1.99.3` and nothing else, and the resolved file names that tag's commit. The other pins (swift-opus and its dependencies) are byte-identical.
- Don't: keep `upToNextMajorVersion` (D2). Don't hand-edit `originHash` or any other pin. If the file has an `originHash`, leave it for Xcode to recompute at resolve time.

#### T2 · `TerminalHostView.swift` uses no `getTerminal()`

Where: `apps/ios/Coflux/Views/TerminalHostView.swift`. Five call sites plus
the link callback. Make each change as follows (D3):

1. `makeUIView`: the line `view.getTerminal().setCursorStyle(.blinkBar)`.
   - After: the cursor style is set through the view's own `setCursorStyle(.blinkBar)`.
2. `updateUIView`: the `applicationCursor:` closure `{ [weak uiView] in uiView?.getTerminal().applicationCursor ?? false }`.
   - After: it returns `applicationCursor` from `terminalInputStateSnapshot()`, falling back to `false` when the view or the snapshot is nil.
3. `Coordinator.bind(sessionID:)`, in the session-consumer closure: the line `if replace { terminalView.getTerminal().resetToInitialState() }`.
   - After: a replace frame calls the view's `resetToInitialState()` and then feeds the data, in that order (D4). The `feed(byteArray:)` line and the two `report…()` calls after it stay as they are.
4. `Coordinator.bind(sessionID:)`, after the closure: `let terminal = terminalView.getTerminal()` and the `client.startTask(taskID:cols:rows:)` call that reads `terminal.cols` / `terminal.rows`.
   - After: `startTask` receives `cols` and `rows` from `terminalView.terminalDimensions`.
5. `Coordinator.reportBottomSlack()`: `let terminal = view.getTerminal()` and the condition `!view.canScroll, !terminal.isCurrentBufferAlternate, terminal.rows > 0` with `terminal.rows - terminal.getCursorLocation().y - 1`.
   - After: the slack value is the same function of the same inputs. Slack is non-zero only when the view cannot scroll, the active buffer is not alternate, and rows > 0. In that case it is `frame.height * rowsBelow / rows`, with `rowsBelow = rows - cursorRow - 1`.
   - The order of reads is fixed (D5). First check `view.canScroll`, then take `terminalInputStateSnapshot()` for `isAlternateBuffer` and `dimensions.rows`. Take `terminalStateSnapshot()` for `cursor.row` only when those checks leave slack possibly non-zero.
   - A nil input snapshot means slack 0.
   - The existing `abs(slack - lastBottomSlack) > 0.5` dedupe and the `onBottomSlackChanged` call stay.
   - Don't: call `terminalStateSnapshot()` unconditionally (D5).
6. `Coordinator.requestOpenLink(source:link:params:)`.
   - After: the coordinator implements `requestOpenLink(source: TerminalView, request: TerminalLinkRequest)` instead, opening `request.link` only when it parses as a URL with scheme `https` or `http`, exactly as before. The deprecated method is removed (D6).

The file as a whole after these changes:

- It contains no `getTerminal`, no `Terminal`-typed local, and no `isCurrentBufferAlternate` / `getCursorLocation`.
- `clipboardRead` still returns `nil`, and its comment is kept.
- `makeUIView` still sets `inputView = UIView()`, `inputAccessoryView = nil` and `scrollsToTop = false`, with the font, colours and palette unchanged.
- Don't: set `allowMouseReporting`, add gesture recognizers, or override `mouseModeChanged` (D1).

### Your call

- Local variable names and whether to factor a small helper inside `Coordinator`.
- Exact wording of new comments (English). Remove a 1.x-specific comment that the change makes false, if any.

### Scope

In scope:
- `apps/ios/Coflux/Views/TerminalHostView.swift`
- `apps/ios/Coflux.xcodeproj/project.pbxproj` (the SwiftTerm package reference only)
- `apps/ios/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` (the swiftterm pin only)
- `apps/ios/release.sh` (the archive invocation only; added at verification)

Out of scope:
- `apps/ios/Coflux/Views/TerminalInputArea.swift`, `WorkspaceDetailView.swift` and every other view. They talk to the terminal only through `TerminalModeRegistry` and the host's callbacks, whose shapes do not change.
- `apps/ios/Coflux/Views/Theme.swift`. It only mentions SwiftTerm in a comment.
- `packages/swift-client`. It does not depend on SwiftTerm.
- The deployment target (`IPHONEOS_DEPLOYMENT_TARGET = 26.0`) and Swift version settings.
- Any gesture, tap or scroll behaviour of our own (D1).

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- An API listed in the Goal does not exist with the stated shape in the resolved SwiftTerm 1.99.3 sources.
- Two tasks contradict each other, or a task contradicts the code it changes.

## Verification

### Milestone validations

- Milestone 1: the iOS device build below succeeds, and `grep -n "getTerminal\|isCurrentBufferAlternate\|getCursorLocation" apps/ios/Coflux/Views/TerminalHostView.swift` prints nothing.

### Commands

Run from `apps/ios`. Simulators cannot link the app (the Tailcat transport is
built for iphoneos only), so the build gate is a device build.

| Purpose | Command | Expected result |
| --- | --- | --- |
| Transport artifact present | `node ../../scripts/build-ios-transport.mjs` (the gitignored `Frameworks/CofluxTailcat.xcframework` is absent in a fresh worktree; copying it from the main worktree's `apps/ios/Frameworks/` is equivalent) | exit 0 |
| Resolve packages | `xcodebuild -resolvePackageDependencies -project Coflux.xcodeproj -scheme Coflux -derivedDataPath /tmp/coflux-swiftterm-dd` | SwiftTerm resolves at 1.99.3; `Package.resolved` keeps revision `282c3c3a…` |
| Device build | `xcodebuild build -project Coflux.xcodeproj -scheme Coflux -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/coflux-swiftterm-dd` | `BUILD SUCCEEDED`; no new warning from `TerminalHostView.swift` |
| Duo install (acceptance) | build with `-destination 'id=00008160-001230303A20000A' -allowProvisioningUpdates -allowProvisioningDeviceRegistration`, then `xcrun devicectl device install app …` and `process launch` | app launches on the unlocked Duo |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] The pbxproj requirement is `exactVersion` `1.99.3`, and `Package.resolved` pins swiftterm at `282c3c3a932b55c129628876b70f37d993af1615` while the other pins are unchanged.
- [ ] `TerminalHostView.swift` contains no `getTerminal`, `allowMouseReporting`, `mouseModeChanged` or new gesture recognizer.
- [ ] `reportBottomSlack` calls `terminalStateSnapshot()` only on the branch where slack can be non-zero.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.
- [ ] (acceptance, the user on the Duo) In Claude fullscreen, a one-finger swipe scrolls the conversation and taps still click. A plain shell still scrolls its history with one finger. Arrow keys from the input panel still work in vim/less (DECCKM). The scroll-to-bottom button still appears and disappears correctly, and a replace frame (reconnect) still redraws cleanly.

### Merge and deploy

- No server, daemon or protocol change. It ships to the device through a direct install or TestFlight (`apps/ios/release.sh`).
- PR #126 (Duo redesign) edits `TerminalHostView.swift` too, so whichever merges second resolves the conflict. Re-apply the five call-site migrations and the link callback on #126's version; #126 has no `reportBottomSlack`.
- Device builds need the Metal toolchain (`xcodebuild -downloadComponent MetalToolchain`) if Xcode reports it missing.
- SwiftTerm 1.99 runs a build-tool plugin. Command-line builds need `-skipPackagePluginValidation`, which `release.sh` now passes, and the Xcode GUI asks once to "Trust & Enable" `SwiftTermBuildInfoPlugin`.

## Outcome

- Status: APPROVE — 2026-11-08
- Mode: subagent(sonnet), one package, one REVISE round
- Commits: `5c90f9a6..d0333308`
- Verification run here:
  - `xcodebuild -resolvePackageDependencies` resolved SwiftTerm @ 1.99.3.
  - A device build for `generic/platform=iOS` and a device build for the Duo id both reported BUILD SUCCEEDED with `-skipPackagePluginValidation`.
  - `TerminalHostView.swift` produces no new warnings; the two remaining warnings are pre-existing ones in `Speech/`.
  - A grep for `getTerminal` / `isCurrentBufferAlternate` / `getCursorLocation` / `allowMouseReporting` / `mouseModeChanged` / gesture recognizers finds nothing.
  - `bash -n apps/ios/release.sh` passes.
  - The scope is 4 files.
- Deviations:
  - `Package.resolved` gains the new transitive pins `h` 1.0.1 and `swift-png` 4.5.2 plus a new `originHash`. The plan expected the other pins to stay byte-identical, but SwiftTerm 1.99.3 adds dependencies.
  - `apps/ios/release.sh` was added to scope so the TestFlight archive passes `-skipPackagePluginValidation`.
- Follow-ups:
  - The user still has to walk through the change on the iPhone Duo. The Duo currently runs the PR #126 redesign build, so this main-based build was compiled for the device but not installed.
  - PR #126 conflicts in `TerminalHostView.swift`; re-apply the five call-site migrations and the link callback there.
