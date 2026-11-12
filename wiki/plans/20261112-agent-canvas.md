# Plan 20261112-agent-canvas: An agent shows an HTML page in a desktop tab (canvas, slice 1)

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 974dce2e..HEAD -- proto crates/protocol crates/runtime crates/cli packages/protocol packages/client packages/cli apps/server apps/desktop integrations/claude-plugin`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self — departure check
- Stop after: implementation — departure check, plain autopilot
- Plan review: none — departure check; the orchestrator is already top-tier, so the audit was not offered
- Workspace: isolated — planned from the clean main worktree; work lives in `.claude/worktrees/20261112-agent-canvas` on `dev/20261112-agent-canvas`
- Planned at: `974dce2e`, 2026-11-12

## Record

### Requirement

Agents working in Coflux terminals regularly produce something the user should
look at rather than read: a design mockup, a comparison of options, the result
of a piece of research. Today the agent has to start an HTTP server itself and
ask the user to open the address by hand, and nothing in the desktop remembers
the page afterwards. `wiki/plans/` already holds several `*-mockup.html` files
produced this way.

A **canvas** (画布) is an HTML file an agent shows to the user inside the
desktop app. It is an extension of what an agent can display. It is not an
approval flow: the user rejected verdict buttons as too rigid, and says
"approved" or "change this" in the conversation.

Product conclusions, confirmed by the user:

- **Consumer and trigger.** The agent (Claude, Codex) in a Coflux terminal runs
  one command; the user sees the rendered page on the desktop.
- **Form.** Arbitrary HTML with the files beside it (CSS, images, fonts). Not
  a component library and not Cursor's `.canvas.tsx`.
- **Flow.**
  1. The agent runs `coflux canvas show <file.html> --title "<title>"`. The
     command returns at once; nothing blocks on the user.
  2. The desktop opens a canvas tab in that workspace in the background, without
     taking focus, and the tab shows an unread dot. No notification is sent; an
     agent that needs attention uses the existing `coflux notify`.
  3. The user reads the page and may annotate elements or regions with the
     existing browser annotation overlay. The agent reads and resolves them
     with the existing `coflux annotations list|resolve|watch`.
  4. The agent edits the file and runs `show` on it again: the same tab reloads
     and the unread dot returns.
- **List.** Each workspace has a canvas list, reached from the ⌘T new-tab menu
  as a 「画布」 group whose items show the title and when it was last updated.
  The group is absent when the list is empty. Only the latest version is kept;
  a closed tab is reopened from the list. `coflux canvas list` prints the same
  list.
- **Tab.** A toolbar with the title, a refresh control and the annotation
  control; no editable address.
- **Failure and cancel paths.** A missing file makes `show` fail and opens
  nothing. With no desktop connected, `show` still succeeds and the canvas
  appears when a desktop connects. A page that fails to load shows an error
  with a retry in the tab. An entry whose file no longer exists is not listed;
  there is no remove command or button.
- **Reach.** Local and remote devices behave the same.
- **Non-goals.** Verdict buttons, `canvas wait`, review states, automatic
  notifications, share links, a page-to-agent bridge, theme token injection,
  round history, a component library. iOS is a second slice (list and render,
  view only) and is not part of this plan.
- **Observable when done.** An agent shows one of the mockups under
  `wiki/plans/`; a tab with an unread dot appears in the background; two
  annotations written on it are listed and resolved by `coflux annotations`;
  showing the file again reloads the tab; after closing the tab it reopens
  from ⌘T; the same works in a workspace on a remote device.

### Decisions & tradeoffs

- **D1 Delivery**: the runtime on the device serves the canvas over loopback
  HTTP, and a canvas tab is a browser tab that loads that address. Rejected: a
  custom Electron protocol backed by the device file-read RPC — that RPC
  returns lossy UTF-8 capped at 2 MiB, so images and fonts break
  (`crates/runtime/src/ops.rs:13`, `:446`). Rejected: sending the HTML to the
  desktop over the device channel — sibling assets are an unknown set. Based
  on: guests load only http(s) and `about:blank`
  (`apps/desktop/src/main/browser-policy.ts:120`, `:388`,
  `apps/desktop/src/renderer/lib/browser-address.ts:24`, `browser-tabs.ts:46`),
  and the loopback tunnel reaches any port on a remote device
  (`proto/coflux/v1/device.proto:958`). No scheme restriction is relaxed.
- **D2 Listener**: a listener of its own on a fixed default port, bound to
  `127.0.0.1` and `[::1]` only, answering GET and HEAD only. It is not the
  gateway on 8788. Rejected: adding a route to the gateway — a page written by
  an agent would share an origin with `/agent` and `/device`. Rejected: an
  ephemeral port — annotations match a page by origin and path
  (`apps/desktop/src/renderer/lib/browser-annotations.ts:35`), so a port that
  changes across restarts orphans them. The device reports its port with the
  list, so the desktop never hard-codes it; failing to bind does not stop the
  runtime.
- **D3 Live directory, no snapshot**: the address is
  `http://localhost:<port>/<canvasId>/<file name>`, and paths under
  `/<canvasId>/` resolve inside the HTML file's parent directory, after
  canonicalisation, never outside it. `canvasId` is unguessable. Rejected:
  copying the file at `show` time — its relative assets cannot be enumerated.
  The registry stores the absolute path, so showing works while the centre is
  unreachable.
- **D4 Identity**: within a workspace a canvas is identified by the canonical
  path of its file. Showing the same file again updates the title and time and
  keeps the id and address; this is what lets annotations survive a revision.
  Rejected: a new id per `show`.
- **D5 Registry and change signal mirror annotations**: the runtime keeps a
  per-workspace index on disk; it reports a revision-only summary to the
  centre, which relays it to clients; the desktop fetches the list over the
  device channel under the session-control scope. Rejected: a push on the
  device lane — no unsolicited device-lane push exists. Rejected: reusing the
  annotations summary message. Based on: `crates/runtime/src/annotations.rs`,
  `proto/coflux/v1/daemon.proto:117`, `apps/server/src/hub.ts:2270`,
  `proto/coflux/v1/device.proto:1347`. The protocol change is additive: neither
  protocol version changes.
- **D6 Auto-open and unread are local to one desktop**: a desktop opens a
  background tab and marks it unread only for a canvas whose update time is
  later than what that desktop has already recorded for it, and its first
  sight of a workspace's list records everything as seen without opening
  anything. Rejected: opening every listed canvas — a fresh install would open
  the whole history. Rejected: account-wide seen state — not worth a centre
  round trip for a display aid.
- **D7 Disappearance**: the list omits entries whose file is gone; nothing
  else removes an entry in this slice. Raised at the departure check as an
  addition to the product conclusions and approved with the direction.

### Discussion log

- Positioning — HTML review surface / display only / Cursor-style component
  SDK / discussion only → "HTML 评审面". Later revised by the user: the
  capability is "展示能力的延伸", drop the approval buttons, keep annotations.
- Verdict entry — host toolbar / in-page bridge / both → host toolbar; removed
  entirely by the revision above.
- How it appears — background tab plus reminder / open and focus / entry only
  → background tab. After the revision the automatic notification was dropped
  in favour of the unread dot alone, and confirmed.
- Lifecycle — workspace list keeping the latest / list plus round history /
  ephemeral → workspace list, latest only.
- iOS — notification only / view and verdict without annotations / nothing →
  view and verdict; after the revision, view only, as a second slice.
- Product confirmation (revised) → confirmed.
- Departure check — direction approved (D1–D7); execution "Self"; autopilot to
  implementation. Plan audit not offered: orchestrator already top-tier.
- Research: Cursor Canvas is a single restricted React file
  (`.canvas.tsx`, imports only `cursor/canvas`, no network) aimed at reports
  and dashboards; raw HTML was chosen on purpose because mockups need free
  layout and agents already write it well.
- (decided while planning) The device reports the canvas port in the list
  response and the port can be overridden by an environment variable, so
  parallel runtimes on one machine (dev previews, the black-box stacks) do not
  fight over it.

### Maintenance notes

- Annotations on a canvas depend on the address staying the same: the port
  (D2) and the id (D4). Changing either orphans existing annotations.
- The centre holds summaries in memory only; the runtime must publish again
  after it authenticates.
- Slice 2 (iOS) has no web view and no loopback tunnel today; it needs its own
  way to fetch canvas content. Nothing here pre-builds that.
- The canvas listener serves a whole directory to any local process that knows
  the id. That is the accepted exposure; do not add write methods or directory
  listings to it.

## Execution brief

> Written for `self` at `974dce2e`. Implement the tasks in order. Decide only
> what Your call leaves to you; on anything else that is unclear, stop and
> report.

### Goal

Add a "canvas": an agent runs `coflux canvas show <file.html>` and the desktop
shows that page in a tab. The runtime registers the canvas per workspace and
serves the file's directory over a dedicated loopback HTTP listener; the centre
relays a revision-only summary; the desktop fetches the list over the device
channel, opens a background browser-style tab with an unread dot, and lists
canvases in the ⌘T menu. Annotations are the existing browser annotations and
need no change.

Follow the annotations feature as the model at every layer. Protocol source is
`proto/coflux/v1/*.proto`; regenerate with `buf generate` (config
`proto/buf.gen.yaml`) and commit the generated TS, Rust and Swift. Write code
comments and docs in English; desktop UI copy is Chinese like its neighbours.
Read `docs/design-guidelines.md` before touching desktop UI (use the Tooltip
component, never a native `title`).

Milestones are sequential: M1 gates everything; M2 and M3 are independent of
each other; M4 needs M1–M3; M5 needs M2.

### Milestone 1: protocol carries canvases

Depends on: none

#### T1 · The wire can describe a canvas list and its change signal

- Where: `proto/coflux/v1/daemon.proto` — beside `message AnnotationsSummary`;
  `proto/coflux/v1/client.proto` — beside `message AnnotationsSummaryUpdated`;
  `proto/coflux/v1/device.proto` — beside `message DeviceAnnotationsList` and
  the envelope oneof that holds `annotations_list = 110`.
- Change: add a daemon→server canvas summary (full snapshot: per workspace, a
  revision), its server→client relay, and a device request/response pair that
  lists a workspace's canvases. Use fresh, unused field numbers in each oneof.
  Regenerate.
- After: the list response carries the device's canvas port, the revision and
  entries of `{id, title, file name, updated-at ms}`; it does not carry the
  absolute path. A response field or status lets the client tell "listener
  unavailable" from "empty". Generated code in `packages/protocol/src/gen`,
  `crates/protocol/src/gen` and
  `packages/swift-client/Sources/CofluxProtocol/Generated` matches the protos.
- Don't: bump `CONTROL_PROTOCOL_VERSION` or `DEVICE_PROTOCOL_VERSION`, or reuse
  the annotations messages (D5).

### Milestone 2: the runtime registers and serves canvases

Depends on: Milestone 1

#### T2 · A per-workspace canvas registry persists and reports

- Where: new module in `crates/runtime/src/`, modelled on `annotations.rs`
  (index under `$COFLUX_HOME`, atomic writes, `commit()` that bumps the
  revision and publishes the summary, re-publish after authentication).
- Change: store entries `{id, title, absolute canonical path, updated-at}` per
  workspace; `show` upserts by canonical path (D4) and generates an
  unguessable id for a new path; listing drops entries whose file does not
  exist (D7).
- After: showing the same file twice yields one entry with the same id and a
  later time; each commit sends the summary to the centre; the summary is sent
  again after the runtime authenticates.

#### T3 · `canvas show` and `canvas list` reach the registry

- Where: `crates/runtime/src/hook.rs` — `AgentBody` and the action mapping;
  `crates/runtime/src/agent_ctl.rs` — `enum AgentAction` and `handle()`, beside
  the annotations arms.
- Change: add the two actions. Resolve the workspace with the existing
  `resolve_scope(session, cwd)`. `show` takes a path (relative paths resolve
  against the caller's cwd) and an optional title (default: the file name).
- After: `show` fails with a clear error when the path does not exist, is not
  a regular file, or does not end in `.html`/`.htm`; on success it returns the
  canvas id, title and address. Both actions stay local to the device and work
  with the centre unreachable.
- Don't: send file contents in the request — the body is capped at 128 KiB;
  send the path.

#### T4 · A dedicated loopback listener serves canvas directories

- Where: new module in `crates/runtime/src/`, started where the local gateway
  (`gateway.rs`) is started; port constant beside `LOCAL_GATEWAY_PORT` in
  `crates/protocol`.
- Change: listen on `127.0.0.1` and `[::1]` on a fixed default port with an
  environment override following the gateway's existing override pattern.
  Serve `GET`/`HEAD /<canvasId>/<relative path>` from the parent directory of
  that canvas's file, with a content type from the extension and
  `Cache-Control: no-store`.
- After: a request whose canonicalised target leaves the canvas directory, an
  unknown id, and any other method each get an error status and no file bytes;
  symlinks are resolved before the containment check; `/<canvasId>/` with no
  file name redirects to or serves the registered HTML file; a bind failure is
  logged, leaves the runtime running, and makes `show` and the list report the
  listener as unavailable. Unit tests cover: sibling asset served, `..`
  traversal refused, symlink escaping the directory refused, unknown id
  refused, POST refused.
- Don't: add a route to the gateway on 8788 (D2), list directories, or accept
  any writing method.

#### T5 · The device channel answers the canvas list

- Where: `crates/runtime/src/device.rs` — every place the
  `DeviceAnnotationsList` payload has an arm: `required_scope`,
  `response_required_scope`, the request-id clear and set, `request_id`, and
  the dispatch.
- Change: add the canvas list request with the same scope as the annotations
  list (session control).
- After: a connected client receives the port, revision and entries for a
  workspace on the device.

### Milestone 3: the centre relays the summary

Depends on: Milestone 1

#### T6 · Clients learn that a workspace's canvases changed

- Where: `apps/server/src/hub.ts` — the handler of the daemon's
  `AnnotationsSummary` and every place its relay is re-sent (subscribe,
  daemon disconnect).
- Change: do the same for the canvas summary: validate that each workspace
  belongs to the reporting daemon, keep the latest in memory, broadcast, and
  re-send in the same situations.
- After: a client subscribed to the account receives the canvas summary on
  change, on subscribe, and an empty one when the daemon disconnects.

### Milestone 4: the desktop shows canvases

Depends on: Milestones 1, 2, 3

#### T7 · The client store exposes canvas lists

- Where: `packages/client` — the store and device router code that handles
  `annotationSummaries` and `DeviceAnnotationsList`
  (`device-router.ts`, the `annotations_unsupported` attribution near
  "empty_payload" handling).
- Change: hold canvas summaries per workspace; add a list call over the
  session lane; add an attribution slot so an older runtime that answers
  `empty_payload` yields a "daemon outdated" result for canvases instead of
  being attributed to another request.
- After: the list refetches when a workspace's canvas revision changes; an old
  runtime produces an explicit unsupported result, not a hang or a
  misattributed annotations error.

#### T8 · A canvas opens as a background tab with an unread dot

- Where: `apps/desktop/src/renderer` — `lib/browser-tabs.ts`,
  `components/workbench/terminal-layout.ts` (`isViewTabId`, the prune
  functions), `workbench.tsx` (`openBrowserTab`), the tab strip in
  `workspace-terminal.tsx`, and the browser view/toolbar component.
- Change: render a canvas in the existing browser view layer so the annotation
  overlay works unchanged, using the workspace's existing partition (which is
  what routes `localhost` to a remote device). The address is built from the
  listed port, id and file name. The toolbar shows the title, refresh and the
  annotation control, with no address field. Keep per-canvas seen times in
  local storage beside the other tab records.
- After (D6): when a list arrives, a canvas newer than its recorded seen time
  gets a tab opened in its workspace without becoming the active tab and
  without moving focus, or — if its tab is already open — that tab reloads;
  either way the tab shows an unread dot until the user activates it. The
  first list a desktop ever sees for a workspace records all entries as seen
  and opens nothing. A canvas already open is never opened twice. A tab whose
  canvas is no longer listed keeps working until closed. A failed load shows
  an error with a retry inside the tab. When the device reports the listener
  unavailable or the runtime is outdated, the tab says so in words.
- Don't: allow any new URL scheme, add a preload to the guest, or re-point a
  partition to another daemon.

#### T9 · The ⌘T menu lists the workspace's canvases

- Where: `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx`
  — `NewTabMenu`, following the `Agent ▸` submenu fed by a prop, and
  `WorkspaceLayoutActions`.
- Change: add a 「画布」 group fed by the workspace's canvas list; each item
  shows the title and a relative last-updated time and opens (or focuses) that
  canvas's tab.
- After: the group is absent when the list is empty; choosing an item whose
  tab is open activates it rather than opening a second one.

### Milestone 5: the command and its documentation

Depends on: Milestone 2

#### T10 · `coflux canvas show|list` exists on both entry points

- Where: `crates/cli/src/main.rs` (command match and `HELP`),
  `crates/cli/src/args.rs` (`STRING_OPTIONS`/`BOOL_OPTIONS`), a new module
  beside `crates/cli/src/annotations.rs`; `packages/cli/coflux.mjs` — the list
  that hands `annotations` and `secret` to the native binary.
- Change: add `canvas show <file> [--title]` and `canvas list [--json]`,
  sending the caller's cwd like the other local commands.
- After: `show` prints the title and address and exits 0; errors from the
  runtime are printed and exit non-zero; `list` names the workspace it
  resolved, like `annotations list`; the npm entry point forwards `canvas` to
  the native binary.

#### T11 · Agents know when and how to use a canvas

- Where: `packages/cli/skills/coflux/SKILL.md` and a new
  `packages/cli/skills/coflux/references/canvas.md`; `SKILL_REFERENCES` in
  `crates/cli/src/integration.rs`; the reference list in
  `apps/desktop/test/config.test.ts`; then run
  `node scripts/sync-claude-plugin.mjs`.
- Change: document the two commands, when a canvas is the right output (a
  mockup, a comparison, research results the user should look at) and when it
  is not, that feedback arrives as annotations or in conversation, that the
  page must be self-contained apart from files beside it, and that `show` on
  the same file updates the same canvas. Mention canvases in the skill's
  frontmatter description and command table.
- After: the reference is linked from `SKILL.md`, embedded in the binary,
  pinned in the desktop test, and mirrored under
  `integrations/claude-plugin/skills/`; the reference links no other
  reference.

### Your call

- Names of messages, fields, modules, the tab id prefix and the tab record
  shape.
- The default port number (unused by the project; not 8787 or 8788) and the
  name of its override variable.
- The on-disk index format and directory name under `$COFLUX_HOME`.
- CLI output wording and `canvas list` layout; Chinese UI copy within the
  product conclusions; how the unread dot is drawn, reusing an existing dot
  style.
- Whether a canvas tab is a browser-tab record with an extra field or a
  sibling record type, as long as it renders in the browser view layer.

### Landmines

- A guest webview must attach on `about:blank` after its partition is prepared
  and only then navigate (`apps/desktop/src/main/browser-policy.ts:105`).
- The client tears a lane down when asked to send a frame over 30 MiB
  (`packages/client` `device-router.ts`); the list is small, keep it so.
- CI fails if generated protocol code differs from `buf generate` output and
  runs a breaking-change check (`scripts/check-protocol-breaking.mjs`).
- CI's plugin check (`node scripts/sync-claude-plugin.mjs --check`) fails on
  any file that differs between `packages/cli/skills` and the plugin mirror.
- The black-box suite starts several runtimes at once on one machine; the
  canvas listener must not make a second runtime fail to start.

### Scope

In scope:
- `proto/coflux/v1/{daemon,client,device}.proto` and the three generated trees
- `crates/protocol`, `crates/runtime`, `crates/cli`
- `packages/protocol`, `packages/client`, `packages/cli`
- `apps/server/src/hub.ts` and the types it needs
- `apps/desktop/src/renderer`, `apps/desktop/src/shared`, `apps/desktop/test/config.test.ts`
- `integrations/claude-plugin/skills` (mirror only, via the sync script)
- `tests/src/harness.mjs` only if a port override must be passed to keep stacks apart

Out of scope:
- `apps/ios` and hand-written Swift — slice 2
- `apps/desktop/src/main/browser-policy.ts` scheme rules and the annotator — must not change
- The gateway on 8788, `crates/ptyd`, `crates/launcher`
- New black-box test files, release notes, version bumps, the plugin manifest version

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- Rendering a canvas in the browser view layer would require relaxing a guest
  navigation rule or changing main-process browser policy.
- The protocol breaking check rejects an additive change.

## Verification

### Milestone validations

- Milestone 1: `buf generate` in `proto/` then `git diff --exit-code` on the generated trees -> no diff; `node scripts/check-protocol-breaking.mjs` -> exit 0; `cargo test -p coflux-protocol` -> pass
- Milestone 2: `cargo build` -> zero warnings; `COFLUX_HOME= cargo test -p coflux-runtime` -> pass, including the listener tests
- Milestone 3: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0
- Milestone 4: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0
- Milestone 5: `cargo test -p coflux-cli` -> pass (reference list test); `node scripts/sync-claude-plugin.mjs --check` -> exit 0

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `cargo build` | zero warnings |
| Rust tests | `COFLUX_HOME= cargo test` | pass |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Desktop lint | the oxlint command CI runs for desktop | exit 0 |
| Plugin mirror | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Whitespace | `git diff --check 974dce2e..HEAD` | no output |
| Black-box (acceptance) | `pnpm -C tests test` with inherited `COFLUX_*` and `FORCE_COLOR` unset | pass |
| Local round trip (acceptance) | built runtime with a temporary `COFLUX_HOME`: `canvas show` a mockup, then `curl` the printed address and a `..` path | 200 with the HTML; traversal refused |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] `coflux canvas show` on a file under `wiki/plans/` prints an address that serves the page and its sibling assets, and nothing outside its directory.
- [ ] Showing the same file twice keeps one entry, one id and one address.
- [ ] Neither protocol version constant changed; no guest scheme rule changed.
- [ ] The listener tests assert refusal of traversal, symlink escape, unknown id and non-GET methods.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Desktop UI is accepted by hand (`pnpm dev:desktop:prod` cannot show it until
  a runtime with this change runs on the device; use a local stack or the
  packaged build). Walkthrough for the owner: background tab and unread dot,
  annotations on a canvas, re-show reload, reopen from ⌘T, a remote device.
- Release order when it ships: centre first (it must relay the new summary),
  then daemon, then desktop. No migration, no new environment variables are
  required; the canvas port override is optional.
- The Claude plugin picks the new reference up with the next `v*` release;
  bump `.claude-plugin/plugin.json` then.
- Rollback: additive on every layer; an older desktop ignores the new summary
  and an older runtime answers the list as unsupported.
