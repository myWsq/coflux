# Plan 075: Agent feedback in terminal tabs—recognizable icons and titles at a glance

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 49142d1..HEAD -- proto crates/supervisor/src crates/worker/src/device.rs apps/server/src/hub.ts apps/server/src/store.ts packages/client/src/store.ts apps/web/src/components/workbench/workspace-terminal.tsx tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `49142d1`, 2026-08-15

## Requirement

Plan 073 brought agent activity into the sidebar, but **terminal tabs provide no feedback**: icons remain neutral terminals and titles remain "Terminal N." With multiple tabs in a workspace, users cannot tell which one runs Claude or what it is doing.

**After implementation**:

1. **Icon**: when existing `sessionAgents` presence detects an agent in a tab's session process tree, replace `SquareTerminal` with a distinguishable Claude/Codex icon. Its color follows hook turn state and sidebar ActivityDots semantics: active green, approval/question amber. Existing attaching spinner and detached plug priorities stay unchanged.
2. **Title**: terminal titles set by PTY programs through OSC 0/2 (the mechanism behind Claude Code's automatic session titles) override `task.title` in tabs. **Unopened, unattached tabs also update** through center broadcasts within ≤2s; **refresh preserves titles** through subscription replay of stored checkpoints. When the session exits, fall back to `task.title`. This is general terminal behavior: OSC titles set by vim, ssh, or shells also apply, without agent-specific filtering.

Three nearby but incorrect approaches have already been investigated and rejected:

- Web xterm `onTitleChange`: inactive tabs do not attach or receive bytes because of the attach gate in `workspace-terminal.tsx`. Attach replay uses vt100-normalized snapshots from `render_normal_snapshot` in `crates/supervisor/src/sessiond.rs`, with OSC removed, so titles disappear on refresh. The user already rejected equivalent refresh-loss behavior in 073.
- Hook messenger reporting: Claude Code hook stdin JSON has no title field (official common-fields documentation checked), nor does transcript JSONL provide stable title storage. Local evidence: active session files have no summary row; matches for "summary" were SendMessage tool arguments.
- Worker output-byte scanning: bytes do not flow through worker without an attached viewer; it only gets dirty notifications (`crates/worker/src/main.rs:640`). This has the same blind spot as the frontend approach.

## Decisions & tradeoffs

- **Capture titles through sessiond's vt100 callback.** Sessiond already parses all PTY output for scrollback/snapshots regardless of attach. vt100 currently parses then discards OSC 0/2; capture it with `Parser::new_with_callbacks` and `Callbacks::set_window_title`, without another hot-path scan. **This breaks the no-supervisor-change discipline maintained in 073/074; the user explicitly approved the departure after being informed that a supervisor release interrupts all live daemon PTYs.**
  Rejected: the three approaches above.
  Based on: `TerminalState::new` at `crates/supervisor/src/sessiond.rs:103-116` constructs a parser without callbacks. vt100 0.16.2 `src/perform.rs:198-208` calls both icon_name and title for OSC 0 and only title for OSC 2; implementing only `set_window_title` covers both.

- **Add `title` to the existing SessionSnapshot→SessionCheckpoint path, without new messages.** A title change comes from output, which creates a dirty notification and thus a checkpoint within ≤2s. Server broadcast and subscription replay already exist. Client `sessionCheckpoints` is keyed by sessionId and cleared when sessionId disappears. Every link already exists.
  Rejected: `SessionAgentRef.title`, because a title is VT/session state independent of agent presence. Vim titles must display too; presence vanishes when an agent exits, while its title should persist with the checkpoint. A standalone title message adds no value.
  Based on: `DeviceSessionSnapshot` at `proto/coflux/v1/device.proto:285`; shared client/daemon `SessionCheckpoint` at `:522`; worker checkpoint assembly at `crates/worker/src/device.rs:1184`; validation/broadcast at `apps/server/src/hub.ts:560/592`; subscription replay around `hub.ts:1180`; `packages/client/src/store.ts:552-556/531-533`.

- **Backward compatibility: add proto fields without a version bump.** Old supervisors omit title, producing an empty string and current UI fallback. `buf breaking` must pass, following 072/073.
  Based on: new proto3 string fields default to empty and preserve serialization compatibility.

- **Persist title with server checkpoints.** Follow `migrate()`'s existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern. Truncate at sessiond's source on UTF-8 boundaries, with an executor-chosen limit around 256 bytes. Server validates untrusted input as a fallback. Rejecting the entire oversized record or truncating are both permitted, but truncation is safer because rejection also loses ansi_snapshot.
  Based on: migration pattern at `apps/server/src/store.ts:454-457`, session_checkpoints DDL at `:404`, and upsert at `:1087`, which requires advancing snapshot_seq. Titles advance with output and need no separate comparison.

- **Web presentation**: tab title is nonempty `checkpoint.title`, otherwise `task.title || "终端"`. The Tooltip component shows full text; do not use native title attributes. EXITED clears task.sessionId and therefore removes the client checkpoint entry, automatically restoring fallback. **Do not persist into `task.title`.**
  Rejected: writing OSC titles into task.title through a rename message mixes transient VT state with durable Task identity. Manual renaming is a separate requirement.
  Based on: current title rendering at `apps/web/src/components/workbench/workspace-terminal.tsx:487`; checkpoint cleanup at `packages/client/src/store.ts:531-533`.

- **Icons use existing `sessionAgents[task.sessionId]`; this is web-only.** Claude gets a small custom sunburst SVG; Codex gets a distinguishable shape, existing Lucide or custom at the executor's discretion. Match sidebar colors: active=success, approval/question=warning, done/no state=neutral. Attaching/detached icons retain priority over agents.
  Based on: icon branches at `workspace-terminal.tsx:480-486`; available presence at `packages/client/src/store.ts:125`; sidebar consumption/colors at `sidebar.tsx:315-330`.

- **Do not change a line in frozen apps/mobile.** Native iOS is out of scope; it can use checkpoint titles later once the path exists.

## Direction

### Milestone 1: Protocol fields

Add `string title` to `DeviceSessionSnapshot` and `SessionCheckpoint`, run `buf generate`, and commit all three TS/Rust/Swift generated outputs.
Validation: `cargo build -p coflux-supervisor -p coflux-worker` with zero warnings and `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`, both exit 0.

### Milestone 2: Capture OSC titles in sessiond

TerminalState stores the latest title through vt100 callbacks, truncates at source, and returns it in SessionSnapshot. Unit tests cover OSC 0 and 2, character-boundary truncation, empty titles without OSC, and fragmented input following existing chunk-boundary tests.
Validation: `cargo test -p coflux-supervisor` exits 0.

### Milestone 3: Worker forwarding and server validation, persistence, broadcast

Worker copies snapshot title into checkpoint. Server validates type/length and includes title in persistence (`ADD COLUMN IF NOT EXISTS`), broadcasts, and subscription replay.
Validation: `cargo build -p coflux-worker` and server tsc exit 0.

### Milestone 4: Web tabs

Presence selects agent icons and colors. checkpoint.title overrides the displayed title with a Tooltip.
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` exits 0. Visual acceptance is manual by the user, without automated UI walkthroughs.

### Milestone 5: Black-box acceptance

Print an OSC 0 title sequence in a black-box terminal and assert checkpoint.title reaches the client store within a few seconds and survives refresh/reconnection through replay. Follow `tests/src/agent-activity.test.mjs`; temporarily remove server title forwarding to verify the test really fails.
Validation: `pnpm -C tests test`: new tests pass with no new full-suite failures, excluding existing cli-doctor environment baseline failures.

## Landmines

- `sendCheckpoint` at `hub.ts:592-600` **manually copies fields**. Adding proto fields without updating it silently sends empty titles; types will not catch this. Check subscription replay around `hub.ts:1180` too.
- vt100 0.16.2 `Parser::new_with_callbacks` **moves** callbacks into parser. Check for an accessor; otherwise share inner title state with `Arc<Mutex<...>>`/`Rc<RefCell<...>>`. Check whether sessiond resize reconstructs Parser; if so, carry title over.
- Check whether bidirectional supervisor↔worker UDS `DeviceEnvelope.protocol_version` validation requires equality or ≥. Equality plus a bump would disconnect mixed old-worker/new-supervisor deployments. Follow current semantics; do not casually bump it.
- OSC titles are **untrusted user data**. Validate server-side and render only as text; React escaping suffices. Never use dangerouslySetInnerHTML.
- Checkpoints run every 2s (`CHECKPOINT_INTERVAL`), so UI latency is ≤2s plus broadcast delay. Tests and manual acceptance must allow this.
- `buf breaking` must pass. Commit generated artifacts in `packages/protocol/src/gen`, `crates/protocol/src/gen`, and `proto/gen/swift` together.
- Widespread black-box timeouts may mean an unhealthy Docker runtime; check `docker ps` before diagnosing regression. Local test PG is on 5432.

## Scope

In scope:

- `proto/coflux/v1/device.proto` and three generated output locations
- `crates/supervisor/src/sessiond.rs`, plus snapshot assembly in `sessions.rs` if required
- `crates/worker/src/device.rs`
- `apps/server/src/hub.ts` and `apps/server/src/store.ts`
- `packages/client/src/store.ts` only if type forwarding is needed; leave unchanged if protocol types suffice
- `apps/web/src/components/workbench/workspace-terminal.tsx` and small new icon component files
- New tests in `tests/src/`
- `plans/README.md`

Out of scope:

- `apps/mobile`: frozen, no changes
- `apps/ios`: future follow-up once the path exists
- `apps/web` sidebar: completed in 073
- Task renaming / persistence of `task.title`: separate requirement
- Release (`git tag` / push): not authorized here. Production needs the next tag, and **supervisor updates require daemon restart, interrupting live PTYs once**. The user chooses when.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0, zero warnings |
| Supervisor unit tests | `cargo test -p coflux-supervisor` | exit 0 |
| Protocol unit tests | `cargo test -p coflux-protocol` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Web types | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Black-box acceptance | `pnpm -C tests test` | New tests pass; no new failures |

## Done criteria

- [ ] All listed commands pass.
- [ ] Black-box OSC 0/2 titles can be read from client store without attach and after simulated reconnection/subscription replay.
- [ ] Tabs show agent icons and correct state colors when presence exists (manual acceptance).
- [ ] New black-box tests were negatively verified by removing forwarding.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- vt100 0.16.2 callbacks cannot expose title without a major crate upgrade.
- `DeviceEnvelope.protocol_version` requires strict equality and adding fields requires a bump.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- This is the **first functional supervisor change** after 073/074. Release instructions and changelog must clearly state that live PTYs will be interrupted. Afterward, retain the rare-supervisor-upgrade discipline.
- These are general terminal titles, not Claude-only titles. Shell precmd OSC hooks, such as oh-my-zsh, will change titles with cwd/commands. This intentionally matches real terminals such as iTerm/Ghostty; do not "fix" it.
- iOS can later read `SessionCheckpoint.title` directly without additional daemon/server changes.
