# Plan 20261107-ios-duo-redesign: The iOS app is rebuilt for iPhone Duo — every form, every pose, two windows

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat afe5a152..HEAD -- apps/ios packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift AGENTS.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED — the whole iOS UI is rewritten and uses iOS 27 APIs that shipped weeks ago; the client and protocol are untouched, so the blast radius is the app's own screens
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check, 2026-11-07
- Stop after: implementation — departure check (plan audit, then execute without stopping)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree, moved to `.claude/worktrees/20261107-ios-duo-redesign` on `dev/20261107-ios-duo-redesign`
- Planned at: `afe5a152`, 2026-11-07

## Record

### Requirement

The iOS app (`apps/ios`) looked and felt rough: system default lists, no
shared visual language, and a terminal page with three stacked header layers
(tab strip, status strip, terminal) and a permanently open control pad. The
maintainer is the only user and owns exactly one iPhone: an iPhone Duo. The
app is therefore redesigned for iPhone Duo alone; other iPhones get basic
"layouts don't break" compatibility and nothing more. Transport, protocol and
`CofluxClient` stay as they are — this is a UI and interaction rewrite.

The approved visual reference is the HTML mockup next to this plan,
[`20261107-ios-duo-redesign-mockup.html`](20261107-ios-duo-redesign-mockup.html)
(every device drawn in true points at one scale). The standing rules are in
`AGENTS.md`, section "iOS app (`apps/ios`): designed for iPhone Duo only".

Product conclusions (confirmed by the user):

- **Layout follows the window, not the display.** One compact layout serves
  the outer display (466×678 pt) and a Split View half on the inner display
  (about 440×626). The inner display open wide (about 890×626) shows a
  sidebar plus the terminal; in the half-open book pose the sidebar aligns to
  the fold. The inner display open tall (about 626×890) shows the terminal
  full screen with bars on top; half-folded on a table (laptop pose) it
  switches by itself to terminal above the fold and composer plus full keypad
  below. A tall Split View gives a wide, short window (about 626×440). On the
  outer display and in the wide inner layout the system draws status bar,
  toolbar and tab bar as a vertical rail on the window's outer edge.
- **Home ("首页") is option A.** On top, "需要你": horizontally paged cards,
  one per thing waiting for the user — an agent asking a question, an agent
  asking for approval, a pending secret request. A card's only action is
  "看终端" (a secret card opens the secret sheet). The section disappears when
  nothing waits. Below, projects grouped like the desktop sidebar, each
  workspace row showing its agent's state, branch, diff counts and progress.
- **Navigation** is a system tab bar with 首页 and 设备; the 首页 badge is the
  number of waiting items. Account and "new terminal" are toolbar items.
  There are no hand-drawn headers, floating buttons or title capsules.
- **Terminal page, input first.** The terminal fills the content area. The
  old tab strip is gone: a toolbar "terminals" item lists the workspace's
  terminals (with a badge when another one waits), and swiping sideways still
  switches terminals. Above a one-line composer sits a key row that follows
  the agent: when it asks for approval or a question, enlarged `1 2 3 ↑ ↓ ⏎`
  plus a notice bar with the agent's message; otherwise `esc ^C tab ↑ ↓ /`.
  The old control pad lives in a "full keypad" sheet. Sending sends the text
  and Enter; long-pressing send only fills the text in. Dictation keeps its
  confirmation gate and gestures, reskinned. Upload and the secret request
  card keep their behaviour, reskinned. The device pages are reskinned.
- **Two Coflux windows** can sit side by side in Split View. A terminal shows
  in at most one window at a time; opening it in the other window moves it
  there, and the first window shows "已在另一个窗口打开".
- **Not in this plan:** replying from a home card, terminal thumbnails,
  GitHub/Google sign-in, a light theme, polishing for iPhones other than Duo.
- **Done when** the user, on the device, can walk the outer display, the inner
  display open wide (including the book pose), open tall (including the
  laptop pose), wide and tall Split View, and two Coflux windows, and each
  matches the mockup's structure.

### Decisions & tradeoffs

- **D1 Duo only**: design, build and accept for iPhone Duo; other iPhones only
  must not break. Rejected: keeping a generic iPhone layout as the base and
  adapting it to Duo — the user owns only a Duo and corrected two mockup
  rounds that drew generic phones. Based on: Discussion log Q-dev, Q-only-duo.
- **D2 Layout from the window**: the layout is chosen from the scene's own
  size (and size classes where they agree), never from which display is
  active, the device pose, the interface idiom, the orientation or `UIScreen`
  bounds. Three layouts: **split** for a large window wider than tall,
  **tall** for a large window taller than wide, **compact** for everything
  else. Pinned cases: outer display 466×678 → compact; outer display in
  landscape 678×466 → compact; Split View half ≈440×626 → compact; inner open
  wide ≈890×626 → split; inner open tall ≈626×890 → tall; tall Split View
  window ≈626×440 → compact (short). `(revised on plan audit)` — a 626×440
  window may report a regular horizontal size class, so size classes alone
  must not decide split. Rejected: per-display or per-pose branches — Split
  View halves are outer-display sized and would get the wrong layout. Based
  on: Apple "Preparing your app for iPhone Duo"; Discussion log Q-split.
- **D3 System bars only**: every bar control is a system toolbar or tab item
  with an icon and a title, inside `NavigationStack`, `NavigationSplitView`
  or `TabView`. Rejected: the hand-drawn header, floating glass buttons and
  title capsule of the first mockups — custom views are never moved into the
  vertical rail. Based on: Apple's Duo guidance ("If your item uses a custom
  view … the system won't present it vertically").
- **D4 Home option A**: "需要你" cards above projects. Rejected: project tiles
  plus an agent feed (option B — four tiles fill the outer display and need
  terminal thumbnails nobody serves) and a flat terminal stream (option C —
  furthest from the desktop's structure). Based on: Discussion log Q1.
- **D5 Waiting items come from existing client state**: an agent waits when
  its `SessionAgentRef.state` is `approval` or `question`; its notice text is
  `SessionAgentRef.message` when non-empty; secret requests come from
  `CofluxClient.secretRequests`. No protocol or client change. Based on:
  `proto/coflux/v1/common.proto` `message SessionAgentRef`;
  `CofluxClient.swift` `sessionAgents`, `pendingSecretRequest`.
- **D6 Cards only navigate**: a "需要你" card offers "看终端" (or opens the
  secret sheet), never an inline reply. Rejected: inline reply — the user
  would answer without seeing the terminal's context. Based on: Q7.
- **D7 Tab bar 首页 / 设备**, badge = waiting count; account and new terminal
  in the toolbar. Home's "new terminal" opens a workspace picker (projects
  with their workspaces); choosing one creates the terminal there and opens
  it `(revised on plan audit)` — home has no current workspace to create in.
  Rejected: devices as a toolbar button only. Based on: Q2;
  `CofluxClient.createTask(workspaceID:title:)` needs a workspace.
- **D8 Inner wide = split view**: sidebar with the home content compacted,
  terminal as detail; tapping a sidebar row switches the detail. Rejected: a
  single full-width terminal behind a home page. Based on: Q3.
- **D9 Laptop pose switches automatically**: inner display open tall and
  half-folded → terminal above the fold, composer and the full keypad below;
  fully open returns to the tall layout (full terminal, floating dock). Built
  on the system arrangement container in its **overlay** style
  `(revised on plan audit)`: with no active dividing region the input area
  sits over the terminal, and half-open it moves to the part after the fold
  while the terminal takes the part before it. Rejected: the split style —
  it stacks the two parts whenever the window is taller than wide, so the
  fully open tall layout would keep the keypad on screen. Based on: Q4;
  Apple's Duo guidance on split vs overlay arrangements.
- **D10 Send = text + Enter**: the composer's send writes the text, newlines
  flattened to spaces, then `\r`; a long press on send writes the text only.
  Dictation's confirmed "发送" uses the same text + Enter path
  `(decided while planning)` — its confirmation gate already exists and the
  resting layout has no Enter key. Never bracketed-paste composer or dictation
  text (plan 054/055: bracketed paste needs the receiver's 2004 mode). This
  supersedes the "send only fills, Enter separately" rule of plans 054/055 and
  067/068. Based on: Q5.
- **D11 Key row follows the agent**: approval/question → `1 2 3 ↑ ↓ ⏎`
  enlarged with a notice bar; otherwise `esc ^C tab ↑ ↓ /` (wider windows may
  add `← →`). Keys send bytes only; the menu text is never parsed. Based on:
  Q6.
- **D12 Two windows, one window per terminal**: the app supports multiple
  scenes sharing the single `CofluxClient`; a terminal is bound in at most one
  scene. The unit is the mounted terminal view, not the active page: a scene
  mounts a real terminal view only for terminals it owns; a mounted page
  claims its terminal when nobody owns it, and activating a page (selecting
  or swiping to it) moves ownership to that scene even if another owns it;
  pages for terminals owned elsewhere show a placeholder with "在这里打开"
  `(revised on plan audit)`. Everything keyed by task id that a terminal view
  registers (session consumer, mode registry) is released only by its owner,
  never by a view that lost ownership. Rejected: mirroring one terminal in
  two windows — `CofluxClient` delivers a session's output to a single
  consumer and the PTY has one size. Based on: Discussion log Q-windows;
  `CofluxClient.swift` "private var sessionConsumers"; every page in
  `WorkspaceDetailView` mounts and binds its terminal at once.
- **D13 Terminal size follows its view**: moving between displays, poses or
  windows simply resizes the terminal view; the existing debounced resize
  (`TerminalHostView.swift` `func sizeChanged`) reaches the PTY. Within one
  layout the terminal's bottom edge sits above the resting dock (key row plus
  one-line composer); transient elements (notice bar, multi-line typing, the
  system keyboard, dictation, sheets) overlay or lift without resizing the
  terminal — the frozen-base idea of plan 053 kept. Rejected: resizing the
  terminal when the notice bar or keyboard appears — every resize is a
  SIGWINCH and a remote TUI redraw.
- **D14 Dictation semantics kept**: release in place → confirmation; slide
  onto cancel/send while holding → act at once; no microphone prewarm without
  permission; 120 ms prewarm debounce; 0.28 s long press via the system
  long-press gesture. Only the look and the geometry change — button positions
  derive from the container instead of fixed points. Based on: plans 066–070
  (memory `ios-app`).
- **D15 Toolchain**: deployment target iOS 27.1, all orientations, multiple
  scenes; dark only with the desktop tokens in `Theme.swift`. Based on:
  `project.pbxproj` (`IPHONEOS_DEPLOYMENT_TARGET = 26.0`,
  `INFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait`);
  iOS 27.2 SDK with `ArrangementView`, `reservedRegions`, `toolbarVerticalEdge`
  (SwiftUICore), `visibilityPriority`, `topBarPinnedTrailing`,
  `ToolbarOverflowMenu` (SwiftUI) present on the planning machine.
- **D16 No overscroll-to-dismiss** `(decided while planning)`: the old "swipe
  past the first terminal pops back to the list" gesture is dropped. Back is a
  toolbar item, and in the split layout there is nothing to pop.

### Discussion log

- Q-scope (explore): rebuild visuals and structure only, or also the terminal
  input interaction? → "全部重做，含终端输入交互". Everything is in scope.
- Q-theme: follow the system, light shell with dark terminal, or keep dark? →
  "保持全局暗色".
- Q-home (first round): the user did not know yet → three options drawn for
  comparison.
- Reference: the user meant AirBuild (App Store id6795428458), not Airbnb;
  Mobbin has no AirBuild, its App Store screenshots were used.
- Q-input: input-first, control-pad-first, or draw both? → "输入框优先".
- Q-dev: "duo 以后才是主力"; then "整个设计稿只画 iPhone duo … 这个 app 就是给我
  自己做的, 而我只有一台 iPhone duo"; the rules went into `AGENTS.md`
  (`89e9c21c`).
- Q-only-duo: "选方案也用 duo 的尺寸选" — the home options were redrawn on the
  outer display.
- Q-split: "内屏横放展开 … 分屏的情况，这个尺寸可能和外屏合上是一样的" → Split View
  halves reuse the outer layout; `AGENTS.md` updated (`afe5a152`).
- Q1 home: A / B / C → "A：需要你 + 项目".
- Q2 navigation: system tab bar 首页/设备, or devices in the toolbar → tab bar.
- Q3 inner wide: split view or single full terminal → split view.
- Q4 laptop pose: automatic now, or later → automatic, in this plan.
- Q5 send: text + Enter (long press fills only), or keep fill-only → text + Enter.
- Q6 key row: follows agent state, or fixed → follows agent state.
- Q7 home cards: inline reply, or only "看终端" → only "看终端".
- Q8 terminal thumbnails: not asked — only option B needed them.
- Product confirmation: all of the above → "确认，继续".
- Q-windows: one window, or two Coflux windows side by side → two windows;
  one-window-per-terminal rule set by the orchestrator from
  `sessionConsumers` being single-consumer.
- Departure check: direction approved; execution subagent(opus); plan audit
  then automatic implementation.
- D10's dictation half and D16 `(decided while planning)`.
- Plan audit (fable, 2026-11-07), all inside the approved direction and
  applied `(revised on plan audit)`: D2 pins the 626×440 window to compact;
  D7 adds the workspace picker for home's new terminal; D9 names the overlay
  arrangement style and its nesting outside the paged scroll view; D12 makes
  the mounted view the unit of ownership and owner-guards the mode registry;
  T1 no longer adds a scene key (the generated manifest already enables
  multiple scenes); T6 fixes the ordering clock; T11 fixes the not-ready tap
  and the single-call payload; `WorkspaceDetailView(client:workspace:)` keeps
  its signature so M2/M3/M5 stay disjoint; Verification gains the simulator
  device creation, the Go toolchain download and the Swift test baseline.

### Maintenance notes

- `Theme.swift` mirrors the desktop renderer tokens by hand; keep doing so.
- Plans 050–058 (tab pill, floating key column, pad collapse persistence) and
  the send rule of 054/055 are superseded by this plan; 064–071 (dictation,
  upload) keep their behaviour.
- The Duo APIs are weeks old; when the device behaves differently from the
  simulator (rail placement, reserved regions, arrangement switching), the
  device wins and this plan's Record should be corrected.
- `CofluxClient.sessionConsumers` stays single-consumer; D12 depends on it. If
  a future change makes it multi-consumer, D12 can be revisited.

## Execution brief

> Written for `subagent(opus)` at `afe5a152`. Implement the milestones in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

Rewrite the SwiftUI layer of `apps/ios/Coflux` so the app is designed for
iPhone Duo: a window-size-driven shell (tab bar 首页/设备; split view on the
wide inner display; full terminal on the tall inner display), a new home
("需要你" cards over projects), an input-first terminal page, an automatic
laptop-pose layout, two-window support, and a reskin of the remaining pages.
`packages/swift-client` (the `CofluxClient`, transport, protocol) and
everything outside `apps/ios` stay unchanged except where a task says
otherwise. The visual reference is
`wiki/plans/20261107-ios-duo-redesign-mockup.html` — open it in a browser; its
"布局规格" table gives type sizes, radii and key sizes. The rules you must
honour everywhere are in `AGENTS.md`, section "iOS app (`apps/ios`): designed
for iPhone Duo only" — read it first.

Conventions: Swift 6, SwiftUI with `@Observable`, colours and fonts only via
`Theme` (`apps/ios/Coflux/Views/Theme.swift`; dark only, desktop tokens; add a
token there rather than a literal colour in a view). The Xcode project uses
buildable folders: new `.swift` files under `apps/ios/Coflux/` are picked up
without editing `project.pbxproj`. Comments in English. Copy shown to the user
is Simplified Chinese, as today. No formatter is configured for Swift.

Swift 6 pitfalls already hit in this app: a class's default argument cannot
refer to covariant `Self` (write the type name); a nonisolated delegate
callback that hands a non-Sendable closure to `Task { @MainActor in }` fails
with a "sending" error — declare the stored callback type as a `@MainActor`
closure and use an explicit capture list.

Milestones: M1 gates everything. After M1, M2, M3 and M5 are independent —
their files are disjoint (M3 owns `WorkspaceDetailView.swift`,
`TerminalInputArea.swift`, `TerminalHostView.swift`, `Speech/DictationOverlay.swift`;
M2 owns `WorkspaceListView.swift` and new home files; M5 owns `DevicesView.swift`,
`DeviceSessionsView.swift`, `SecretRequestCard.swift`, `LoginView.swift`). M4
needs M2 and M3.

### Milestone 1: A window-driven shell that runs in every Duo form and in two windows

Depends on: none

#### T1 · The app targets iOS 27.1, every orientation, and multiple windows

- Where: `apps/ios/Coflux.xcodeproj/project.pbxproj` — every `IPHONEOS_DEPLOYMENT_TARGET = 26.0;`, both `INFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait;`, and the app target's `INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;` blocks
- Change: raise the deployment target to 27.1 for the app and test targets; declare portrait, both landscapes and upside-down for iPhone. Multiple scenes need no new setting: `INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES` already generates `UIApplicationSupportsMultipleScenes = true` for this SwiftUI `WindowGroup` app — leave it as it is.
- After: the built Info.plist carries `UIApplicationSupportsMultipleScenes = true` (unchanged) and all four iPhone orientations; the minimum OS is 27.1. (D15)
- Don't: add a scene manifest key to `Coflux-Info.plist`; change signing, team, bundle id, build number logic or the `UIUserInterfaceStyle = Dark` setting.

#### T2 · Each window picks its layout from its own size

- Where: `apps/ios/Coflux/Views/RootView.swift` — `case .authed:`; new files for the shell
- Change: replace the authed branch (today `WorkspaceListView(client:)`) with a per-scene shell. The shell measures its own container and chooses one of three layouts: **split** (a large window wider than tall) → a `NavigationSplitView` whose sidebar is the compact home (built in M2; a placeholder list is fine until then) plus a 设备 entry, and whose detail is the selected workspace's terminal page; **tall** (a large window taller than wide) → a `TabView` with tabs 首页 and 设备, each holding its own `NavigationStack`, whose terminal page uses the tall arrangement from M3/M4; **compact** (everything else) → the same `TabView` + `NavigationStack`. The size thresholds are your call, but these windows must land as stated: 466×678 compact, 678×466 compact, 440×626 compact, 890×626 split, 626×890 tall, 626×440 compact. Do not let a regular horizontal size class alone select split. The 首页 tab badge shows the waiting count from M2 (zero until then). Keep the loading/outdated/login branches as they are.
- After: rotating, opening/closing the Duo, entering Split View or resizing a window switches layouts without losing the current workspace and terminal selection; the six pinned window sizes get the pinned layouts; nothing reads `UIScreen`, `UIDevice` idiom or interface orientation. (D2, D3)
- Don't: decide the layout from the display or pose (D2); draw any custom header or floating bar control (D3).

#### T3 · Navigation state lives per window and survives layout switches

- Where: new file(s) under `apps/ios/Coflux/Views/`
- Change: an `@Observable` per-scene model holding the selected tab, the selected workspace id and the selected terminal (task) id, owned by the scene's root view and put in the SwiftUI environment, so compact ⇄ split ⇄ tall switches keep the same selection. Offer one entry point "show workspace W with terminal T active" that M2's cards and sidebar call; the terminal page reads the requested terminal from this model.
- After: two windows have independent selections; switching layout keeps the selection; `WorkspaceDetailView(client:workspace:)` keeps exactly this initializer — the scene model and the ownership registry (T4) reach it through the environment, so M2 and M5 call sites (`WorkspaceListView`, `DeviceSessionsView`) need no change.

#### T4 · A terminal is bound in at most one window

- Where: new app-level registry (shared by all scenes, created once next to the `CofluxClient` in `apps/ios/Coflux/CofluxApp.swift` `struct CofluxApp`, passed down or put in the environment); consumed by `TerminalHostView` (`apps/ios/Coflux/Views/TerminalHostView.swift` `func bind(sessionID:)`) and by the terminal page
- Change: record which scene currently owns each task id. The unit is the mounted terminal view: the terminal page constructs `TerminalHostView` only for tasks its scene owns, and renders a placeholder "已在另一个窗口打开" with a button "在这里打开" for tasks another scene owns. A page claims its task on mount when nobody owns it (so a single window keeps every terminal of the workspace alive, as today); activating a page — selecting it, swiping to it, opening it from a card, the sidebar or the terminal list — claims it even when another scene owns it. A scene releases its claims when its pages disappear or the scene closes. Guard `TerminalModeRegistry` (`TerminalHostView.swift` `final class TerminalModeRegistry`, `func register(`, `func unregister(taskID:)`) with an owner token the same way `CofluxClient` guards its session consumers, so a view that lost the terminal cannot unregister the new owner's entry. The detach/attach round trip a move causes (old view releases → `suspendSession`, new view `startTask`) is expected; do not try to avoid it.
- After: with two windows showing the same workspace, only the owning window's terminal view exists, receives output and resizes the PTY; the other shows the placeholder; tapping "在这里打开" or swiping to it moves it. After moving a terminal running `less` (DECCKM on) to the other window, ↑ in the new window still sends `\e[OA` and scroll-to-bottom still works. `CofluxClient` is unchanged. (D12)
- Don't: change `CofluxClient.sessionConsumers` to multi-consumer, mount a `TerminalHostView` for a task the scene does not own, or attach the same session from two terminal views (D12).

#### T5 · The app stays connected while any window is in front

- Where: `apps/ios/Coflux/CofluxApp.swift` — `.onChange(of: scenePhase)`
- Change: none needed beyond keeping what is there: the `App`-level `scenePhase` already reflects all scenes together (background only when every scene is), and `client` is `@State` on the `App`, created once.
- After: one connection for all windows; backgrounding every window suspends, bringing any back resumes.
- Don't: move the client into a scene-level `@State` or read `scenePhase` per scene to suspend the connection.

### Milestone 2: Home shows what waits for the user, then the projects

Depends on: Milestone 1

#### T6 · A single source of "waiting" items

- Where: new file under `apps/ios/Coflux/Views/` (a view-model or extension over `CofluxClient`)
- Change: derive the ordered list of waiting items: for every `client.sessionAgents` entry whose `session.state` is `approval` or `question`, an agent item (agent name `session.agent`, the task, workspace, project, device, `session.message`); for every pending secret request in `client.secretRequests`, a secret item. Order all items on one clock, newest first: an agent item by its task's `updatedAt`, a secret item by `SecretRequestInfo.createdAt` (both are millisecond epochs in the protocol); ties break by task id then request id. Expose the count for the tab badge.
- After: input → expected: one session with state `question` and message "首页按哪个方案做？" (task `updatedAt` 2000) plus one secret request (`createdAt` 3000) → two items, the secret first, count 2; a session with state `active`, `done` or empty → no item; the session disappearing from `sessionAgents` → its item disappears. Put the derivation in a pure function so the test drives it with plain values. (D5)
- Don't: add protocol fields or parse terminal text to detect waiting (D5).

#### T7 · Home in the compact layout

- Where: `apps/ios/Coflux/Views/WorkspaceListView.swift` (rewrite or replace; keep the type name if callers outside M2 use it, or update `RootView`'s use from M1)
- Change: large title "coflux" with a subtitle of online devices; section "需要你" with a count chip and horizontally paged cards (one per item: agent avatar/name, project · branch, state pill 在问你 / 要权限 / 等输入, the agent's message, one primary action "看终端" — or "提供" for a secret item, which presents the secret sheet from M5/the existing `SecretRequestCards`), hidden entirely when there are no items; section "项目": one card per project (folder icon, name, device + online dot) holding workspace rows (agent state dot or branch icon, branch title, custom name in grey, `+N −M`, progress or state subtitle in the state's colour). Keep the long-press "copy handle" context menus (`.copyHandleContextMenu`) on workspace rows, the offline banner and the empty state. Toolbar: account (menu with 登出) and new terminal; new terminal opens a picker of workspaces grouped by project, and choosing one creates a terminal there (`client.createTask(workspaceID:title:)`, title "终端 N" as the terminal page does) and opens it once it appears. Tapping a card or a row uses M1's "show workspace W with terminal T" entry.
- After: matches the mockup's "方案 A" outer-display frame in structure; a card's action lands on that terminal with it active. (D4, D6, D7)
- Don't: add a reply field to cards (D6); show terminal thumbnails.

#### T8 · The same home, compacted, as the split sidebar

- Where: the view(s) from T7, used by M1's split layout sidebar
- Change: a list form of home for the sidebar: "需要你" rows (avatar, title, state + message in one line), then projects with workspace rows; the selected row is highlighted; a search field at the bottom filters workspaces/terminals by name; a sidebar toggle and the account item in the sidebar's (horizontal) toolbar.
- After: in the split layout, tapping a row switches the detail to that terminal without any back navigation. (D8)

### Milestone 3: The terminal page is input-first

Depends on: Milestone 1

#### T9 · The page is the terminal plus a dock, with bar items in the toolbar

- Where: `apps/ios/Coflux/Views/WorkspaceDetailView.swift` — `var body`, `private var tabBar`, `private func pillFrame()`, `private func tabChip(_:)`, the `.overlay(alignment: .bottomTrailing)` floating key column, `inputCollapsed` and its `padCollapsedKey` persistence
- Change: remove the tab strip, the pill, the floating key column (new terminal / keyboard toggle) and the pad-collapsed state and its `UserDefaults` key. Keep the paged horizontal `ScrollView` of terminal pages (all terminals mounted, swipe to switch) but drop the first-page overscroll dismissal (D16). Title: the navigation title shows the terminal (agent name or task title) with project · device as subtitle. Toolbar items, each with icon and title: back (system), "终端" (a list of this workspace's terminals with status dots, waiting badge on the item when another terminal waits, and 新建终端), "附件" (相册 / 文件, existing upload flow), "按键" (opens the full keypad, T12), "更多" (停止并删除任务 with the existing confirmation, 复制终端标识 — the copy-handle that lived on the tab chip). Keep the status banners (`statusStrip`: taken over / not started / input blocked) as a strip at the top of the content area, and the scroll-to-bottom button as a transient content overlay. Keep the self-created-task detection (`knownTaskIDsBeforeCreate`) and auto-start.
- After: the terminal fills the content area down to the resting dock; on the outer display the system shows back/终端/更多 on the rail's top and 附件/按键 at its bottom (placement is the system's); the mockup frames O2/O3 match in structure. (D3, D13, D16)
- Don't: draw your own header, pill or floating glass buttons (D3).

#### T10 · The dock: key row that follows the agent, and a one-line composer

- Where: `apps/ios/Coflux/Views/TerminalInputArea.swift` — `struct TerminalInputArea` (rewrite); `WorkspaceDetailView.swift` overlay that hosts it
- Change: the dock = optional notice bar + key row + composer, pinned to the bottom of the content area. Key row: when the active terminal's agent state (`client.sessionAgents[sessionID]?.session.state`) is `approval` or `question` → enlarged keys `1 2 3 ↑ ↓ ⏎` and, above them, a notice bar (agent avatar, "<agent> 要你确认" for approval / "<agent> 在问你" for question, and `session.message` as the second line when non-empty); otherwise → `esc ^C tab ↑ ↓ /`, adding `← →` when the window is wide enough to keep keys at least the mockup's size. Arrow keys stay DECCKM-aware (`TerminalModeRegistry.shared.applicationCursor`), ⌫ and arrows keep auto-repeat. The composer is a one-line card: placeholder "回复 <agent>…" (or "输入命令…" without an agent), a microphone button, a send button. Tapping it opens the compose layer (T11); long-pressing it starts dictation (T13).
- After: the key row switches the moment the agent state changes; keys send exactly their bytes (`1` → `"1"`, `⏎` → `"\r"`, `esc` → `"\u{1B}"`, `^C` → `"\u{03}"`, `tab` → `"\t"`); the terminal does not resize when the notice bar appears or disappears. (D11, D13)
- Don't: parse the terminal's menu text to label keys (D11); let the notice bar or dock height change resize the terminal (D13).

#### T11 · Composing and sending

- Where: `WorkspaceDetailView.swift` — `private func sendText(_:)`, `private func sendDraft()`, `private func deliver(_:)`, the `.fullScreenCover(isPresented: $composing)`; `TerminalInputArea.swift` — `struct TerminalComposeOverlay`
- Change: keep the compose layer presented with the system keyboard over a frozen terminal (no resize), restyled as the expanded composer card (multi-line display, 相册 shortcut, hint "发送并回车", send button). Send = text with newlines flattened to spaces, then `\r`, as exactly one `client.sendInput` call. A long press on the send button writes the flattened text without `\r`, clears the draft and closes the layer like a tap. When the terminal is not ready (not running or no session — today's `terminalReady`), tapping or long-pressing send sends nothing, keeps the draft and keeps the layer open with the short hint "终端未运行". Dictation's confirmed send (`deliver` / `sendDictation`) uses the same text + Enter path; when the terminal is not ready it still falls back to the draft. Compute the bytes in one pure function (text, withEnter) → payload or nil.
- After: input → expected (test the pure function): ("fix it\nplease", enter) → `"fix it please\r"`; ("fix it\nplease", no enter) → `"fix it please"`; ("", either) → nil; the call site sends that payload in a single `sendInput`. No bracketed paste on these paths. (D10)
- Don't: wrap composer or dictation text in bracketed paste (D10); resize the terminal while the keyboard is up (D13).

#### T12 · The old control pad becomes the full keypad sheet

- Where: `TerminalInputArea.swift` — the pad layout (`keyCap`, `repeatKey`, `arrowBytes`, `attachKey`, paste key) moved into a sheet view
- Change: a sheet with the pad from the mockup (frame O6): `esc 1 2 3 4 ⌫ / tab q ^D ^C ^U ^L / / : ~ ↑ | ⏎(tall) / ^R ^Z ← ↓ →`, plus 粘贴 (existing clipboard behaviour, including raw image bytes upload and bracketed paste of clipboard text) and 相册 / 文件. It can stay open while typing keys; a detent leaves the terminal's upper part visible.
- After: every key sends what the old pad sent; paste and upload behave as before (plan 071 limits: 60 s fsWrite timeout, 30 MB cap, HEIC → JPEG). (D11)

#### T13 · Dictation keeps its semantics with relative geometry

- Where: `apps/ios/Coflux/Speech/DictationOverlay.swift` — `enum DictationZone` (`static let diameter`, `lift`, `edgeInset`, `tolerance`, `baseApex`, `func hit`); `TerminalInputArea.swift` long-press gesture and prewarm
- Change: restyle the overlay to the mockup (frame O5: transcript bubble with "点文字可以改", waveform, cancel / edit / send round buttons, base arc); derive button positions and the hit test from the overlay's container size (scale the existing constants by the container instead of fixed points) so it works from the narrowest content area (a ≈440 pt Split View half minus its ≈72 pt rail, about 368 pt) to the 626 pt-wide tall layout. Keep the long-press source on the composer.
- After: release in place → confirmation; slide onto cancel/send while holding → act at once; no prewarm without microphone permission; 120 ms prewarm debounce; 0.28 s system long press — all unchanged; the hit zone and the drawn buttons coincide at every window size. (D14)
- Don't: replace the system `LongPressGesture`-then-`DragGesture` sequence with a custom timer, or prewarm before permission (D14).

#### T14 · The terminal page in a short window

- Where: the dock from T10
- Change: when the window is too short to keep a useful terminal (tall Split View, outer display in landscape), fold the key row into the "按键" toolbar item so only the composer stays.
- After: in a 626×440 window the terminal keeps at least about ten rows.

### Milestone 4: The inner display uses its poses

Depends on: Milestone 2, Milestone 3

#### T15 · Split layout and the book pose

- Where: M1's split layout; M2's sidebar
- Change: in the split layout the detail is M3's terminal page; when the fold is an active reserved region (`reservedRegions`, half-open book pose), the sidebar width matches the leading half up to the fold and nothing interactive sits in the fold; fully open, the fold is not reserved and the default sidebar width applies. A sidebar toggle collapses the sidebar so the terminal takes the whole display.
- After: matches mockup frames W1 (open) and W2 (book pose). (D8)

#### T16 · Laptop pose

- Where: M3's terminal page in the tall layout
- Change: in the tall layout, wrap the whole terminal page — the paged horizontal `ScrollView` of terminals as the **secondary** view, the input area as the **primary** view — in one `ArrangementView` with the **overlay** arrangement style. Fully open (no active dividing reserved region) the input area overlays the terminal exactly as in the normal tall layout (T1 frame), and the terminal keeps its bottom edge above the resting dock (D13). Half-folded with a horizontal fold, the arrangement puts the terminal before the fold and the input area after it; the input area then shows the composer plus T12's pad inline (not a sheet), and the "按键" toolbar item is hidden. Decide "inline keypad or not" from whether a dividing reserved region is active (`reservedRegions(kind: .division …)` / `isActive`), not from the window size alone.
- After: matches mockup frame T2 half-folded and T1 fully open; the transition resizes the terminal once. (D9, D13)
- Don't: use the split arrangement style (it would keep the keypad on screen fully open); place the `ArrangementView` inside the paged `ScrollView` or per page; detect the pose yourself from sensors or angles (D2, D9).

### Milestone 5: The remaining pages share the new look

Depends on: Milestone 1

#### T17 · Devices and device terminals

- Where: `apps/ios/Coflux/Views/DevicesView.swift` (`struct DevicesView`, `deviceRow`), `apps/ios/Coflux/Views/DeviceSessionsView.swift`
- Change: devices as cards (OS icon, name, terminal count, online dot, RTT, platform; offline ones dimmed below "离线"), as mockup frame O7; this is the 设备 tab's root. The device terminal page reuses M3's terminal page as today.
- After: the 设备 tab shows the device cards; tapping one opens its terminals.

#### T18 · Secret request sheet and login

- Where: `apps/ios/Coflux/Views/SecretRequestCard.swift` (`struct SecretRequestCards`, `struct SecretRequestCard`), `apps/ios/Coflux/Views/LoginView.swift`
- Change: present secret requests as a bottom sheet (mockup frame O8) reachable from a home card and from the terminal page; copy, masking, multi-line paste, expiry, provide/decline and every security rule stay exactly as they are. Restyle the login page to the new card and button style; account + password only.
- After: a secret request can be provided or declined from the sheet with the same outcomes as today. (D6 for the home entry)
- Don't: change what the secret card sends, shows about the value, or who receives it.

### Your call

- File and type names for new views and models; how the layout chooser is
  factored; whether `WorkspaceListView` keeps its name.
- Exact thresholds (when `← →` fit, when the key row folds away), sheet
  detents, animation curves, toolbar `visibilityPriority` values and which
  items overflow first.
- How the window-ownership registry identifies scenes.
- Whether the full keypad is a SwiftUI sheet or an inline panel on the compact
  layout, as long as it can stay open while keys are pressed.
- Adding `Theme` tokens for the mockup's card/raise surfaces, provided each
  new token is documented in `Theme.swift` as matching a desktop token.

### Landmines

- The Tailcat framework `apps/ios/Frameworks/CofluxTailcat.xcframework` is
  gitignored and absent in a fresh worktree; the app does not link without
  it. Build it with `node scripts/build-ios-transport.mjs`; its first run
  downloads the go1.27.1 toolchain (`GOTOOLCHAIN`), which needs network.
- `TerminalModeRegistry` (`TerminalHostView.swift`) is a process-wide
  singleton keyed by task id; SwiftUI does not order one window's
  `dismantleUIView` against another window's `updateUIView`, which is why T4
  owner-guards it (D12).
- `WorkspaceDetailView` is also embedded by `DeviceSessionsView` for directory
  workspaces (`DeviceSessionsView.swift` "WorkspaceDetailView(client: client,
  workspace: workspace)") — the terminal page must keep working there, titled
  by the device name.
- Several iOS 27 APIs are new: confirm signatures against the SDK
  (`xcrun --sdk iphoneos --show-sdk-path`, SwiftUICore/SwiftUI/UIKit
  `.swiftinterface`) rather than from memory.

### Scope

In scope:
- `apps/ios/Coflux/**` (views, speech overlay geometry, app entry)
- `apps/ios/Coflux.xcodeproj/project.pbxproj` (deployment target, orientations, scenes only)
- `apps/ios/Coflux-Info.plist` (only if a scene key must live there)
- `apps/ios/CofluxTests/**` (tests for T6 and T11 byte output)

Out of scope:
- `packages/swift-client/**` — no client, transport or protocol change (D5, D12)
- `proto/`, `apps/server/`, `apps/desktop/`, `crates/`, `transport/`
- `apps/ios/release.sh`, signing and export settings
- `AGENTS.md` (already updated)

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list, in particular any change in `packages/swift-client`.
- An iOS 27 API named here does not exist in the installed SDK or behaves contrary to this brief (e.g. the arrangement container cannot place the dock below the fold).
- The system does not move the toolbar items to the vertical rail even though they are system items with icon and title.
- Two tasks contradict each other, or a task contradicts the code it changes.

## Verification

### Milestone validations

- Every milestone: `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` → `** BUILD SUCCEEDED **`, no new warnings in touched files.
- Milestone 2 and 3: the "Unit tests (acceptance)" row below, once the Duo simulator device exists → exit 0, including the new tests for waiting items (T6) and the send payload (T11).

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Tailcat framework (prerequisite) | `node scripts/build-ios-transport.mjs` | exit 0 (first run downloads go1.27.1) |
| Swift client baseline (before dispatch) | `swift test --package-path packages/swift-client` at `afe5a152` | exit 0; record the test count |
| Swift client unchanged | `swift test --package-path packages/swift-client` | exit 0, same count as the baseline |
| App compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` | `** BUILD SUCCEEDED **` |
| Device compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -allowProvisioningUpdates` | `** BUILD SUCCEEDED **` |
| Duo simulator runtime (acceptance prerequisite) | `xcodebuild -downloadPlatform iOS` then `xcrun simctl list runtimes` | an iOS 27.1+ runtime listed |
| Duo simulator device (acceptance prerequisite) | `xcrun simctl create "iPhone Duo" com.apple.CoreSimulator.SimDeviceType.iPhone-Duo <runtime-id from the previous row>` | a device UDID; neither installed runtime (26.5, 27.0) supports the Duo type |
| Unit tests (acceptance) | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone Duo' -only-testing:CofluxTests` | exit 0 through the shared scheme (it sets `COFLUX_IOS_TEST_HOST=1`); `DictationProbeTests` skip on the simulator |
| Simulator screenshots (acceptance) | boot an iPhone Duo simulator, install, `xcrun simctl io booted screenshot` closed / open wide / open tall | structure matches mockup frames O1–O8, W1, T1 |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] The diff touches no file under `packages/swift-client`, `proto`, `apps/server`, `apps/desktop`, `crates`, `transport`.
- [ ] No view decides layout from `UIScreen`, `UIDevice.userInterfaceIdiom` or interface orientation (grep the diff).
- [ ] No hand-drawn header, title capsule or floating glass button remains for bar actions; every bar action is a toolbar or tab item with icon and title.
- [ ] `sendText`'s replacement sends `\r` on tap and not on long press, flattens newlines, and never emits `\e[200~`.
- [ ] Dictation constraints of D14 are present in the diff unchanged (permission check before prewarm, 120 ms, 0.28 s).
- [ ] `CofluxClient.sessionConsumers` is still single-consumer; a `TerminalHostView` is constructed only for tasks the scene owns; `TerminalModeRegistry` unregistration is owner-guarded.
- [ ] `WorkspaceDetailView(client:workspace:)` keeps its initializer.
- [ ] The layout chooser maps 466×678, 678×466, 440×626, 626×440 to compact, 890×626 to split, 626×890 to tall (read the chooser in the diff).
- [ ] Tests for T6 and T11 exist and would fail on a wrong mapping or a missing `\r`.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.
- [ ] Device walkthrough by the user (acceptance): outer display, inner wide incl. book pose, inner tall incl. laptop pose, wide and tall Split View, two Coflux windows.

### Merge and deploy

- iOS only; ships through TestFlight with `apps/ios/release.sh` after the user's device walkthrough. No server or runtime deployment.
- The minimum iOS becomes 27.1: older iPhones on iOS 26 can no longer install new builds (accepted, D1).
- Plans 050–058 and the send rule of 054/055 are superseded; mention the new send behaviour (send = Enter) in the TestFlight notes.
