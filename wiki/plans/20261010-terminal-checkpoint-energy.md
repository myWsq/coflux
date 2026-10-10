# Plan 20261010-terminal-checkpoint-energy: Background terminals stop costing CPU — checkpoints split into metadata and low-cadence content

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 50d3e8c9..HEAD -- proto/coflux/v1 crates/protocol crates/runtime/src packages/protocol packages/client/src apps/server/src apps/desktop/src/renderer packages/swift-client/Sources/CofluxClientCore tests/src`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure-check answer in `dev:explore` (2026-10-10)
- Stop after: implementation — departure-check answer (plan audit, then autopilot)
- Plan review: audit — ran 2026-10-10 (fable); findings applied, marked `(revised on plan audit)`
- Workspace: isolated — the session started in the main worktree (clean); this plan lives on `dev/20261010-terminal-checkpoint-energy` in `.claude/worktrees/20261010-terminal-checkpoint-energy`
- Planned at: `50d3e8c9`, 2026-10-10

## Requirement

macOS ranks the Coflux desktop app among the heaviest energy users (Activity Monitor: energy impact ≈1474, 12-hour power ≈2605). Measured on the maintainer's machine with the app up for 18 hours and about 36 long-lived Claude Code sessions in ~40 PTYs:

- The renderer process averaged ≈10% CPU (113 CPU-minutes over 18 h); the runtime ≈2.6%; main, GPU and transport processes are negligible.
- Hiding the window did **not** lower renderer CPU (9.4% → 9.6%; GPU process at 0 both times): the cost is JS work independent of visibility, not painting.
- The runtime sends ≈11.5 KB/s to the center and the renderer receives the same ≈11.5 KB/s back from the center, while the loopback live-output lane (127.0.0.1:8788) is nearly idle.

Cause: every session that produced any output gets a **full ANSI snapshot** (screen plus up to 5000 lines of history, capped at 512 KB) rendered by the runtime every 2 s, written to Postgres by the center, and broadcast to every client of the account. The client hands each one to the session's consumers with `replace=true` whenever the session is not live-attached (`packages/client/src/store.ts:1011-1012` on registration, `:1464` on arrival); the pane's consumer then does `terminal.reset()` + `terminal.write(snapshot)` (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:928-936`). Panes of every workspace visited since launch stay mounted and registered, so each busy background terminal is re-parsed from scratch every 2 s.

Secondary idle churn: the runtime spawns 3+ git processes per git workspace every 3 s and reads every untracked file each time; the 3 s catalog refresh replaces store arrays even when nothing the UI reads changed, re-rendering the sidebar; static activity-dot states run infinite CSS animations.

Done means: with the same workload, renderer average CPU drops from ≈10% to about 1%, runtime CPU drops, center→client traffic is near zero while terminals merely run, and nothing the user relies on regresses:

- tab and command-palette titles still follow OSC titles promptly;
- a pane that is visible but not live — the session is held by another device ("detached"), or its device is offline — still shows the terminal's content; a visible detached pane on an online device keeps refreshing about as often as today (~2 s);
- `read_terminal` / `coflux terminal read` for an offline device still returns recent content, and for an **exited** terminal still returns its final screen — no staler than today;
- command state (`busy`, command sequence, last exit code) used by the account CLI `terminal list` through the center stays correct and is no less timely than today, including right after a daemon reconnect.

This is non-perceptible performance work: no UI, copy or CLI output changes.

## Decisions & tradeoffs

- **Checkpoints split into two signals.** *Metadata* (title and command state) is sent from the runtime to the center as soon as it changes, and in full for every live session right after the daemon (re)connects. *Content* (the redacted ANSI snapshot with cols/rows) is produced at low cadence: once output has settled for a short quiet window, with a max-staleness ceiling while output never settles. Rejected: one combined checkpoint at a lower interval — titles and command state would lag by the whole interval. Rejected: dropping history from content — offline view and `read_terminal` need it. Based on: `crates/runtime/src/device.rs:68` (`CHECKPOINT_INTERVAL` 2 s), `device.rs:1310-1360` (every dirty session regardless of viewers), `device.rs:3978-4000` (title and command ride inside the checkpoint), `device.rs:3733` (all live sessions re-marked dirty on reconnect), `apps/server/src/hub.ts:1869-1876` (center derives `commandStates` from the checkpoint).
- **Title changes reach the runtime as an event, not by rendering snapshots.** sessiond gets a title-change event toward the device layer (today `SessiondEvent` only has `SessionCommand`, `crates/runtime/src/sessiond_ipc.rs:78-121`, emitted at `sessions.rs:1428`; title is only read while rendering a snapshot, `sessions.rs:2228`). A title-only change must not trigger a snapshot render. Rejected: keep requesting a snapshot every 2 s and send only its title — keeps the runtime's render cost. `(revised on plan audit)`
- **Cadence values are the executor's call within bounds.** The quiet window must be well under 10 s (a black-box test waits 15 s for a redacted checkpoint as a legacy client, `tests/src/secret-input.test.mjs:230-233`); the ceiling must keep offline-view staleness at or under one minute; a continuously printing session must cost at least ~10× less than today's 2 s. `(revised on plan audit)`
- **An exiting session gets one final content checkpoint, and the center accepts it.** Before the runtime reports a session's exit, it renders and publishes that session's final content, and the center must store it even though the exit follows. Today `session_exited` drops dirty/pending state (`device.rs:1240-1264`), the checkpoint and exit outboxes are independent (`device.rs:236`, `:271`), and the center rejects upserts for non-RUNNING tasks (`hub.ts:1884-1891`) while exited terminals are served only from the stored row (`hub.ts:4939-4942`). The executor picks how ordering is guaranteed (exit waits for the final content to be accepted, or the center accepts content for a just-exited task once). Rejected: a flush on graceful runtime shutdown — the launcher stops the runtime with `Child::kill` (SIGKILL; `crates/launcher/src/manager.rs:501`, `:682`, `:704`) and the runtime's SIGTERM handler exits immediately (`crates/runtime/src/main.rs:1068-1081`), so it would never run. `(revised on plan audit)`
- **The center keeps storing content but stops broadcasting it to capable clients.** Capable clients receive metadata only; subscribe sends them current metadata for every live session instead of every stored snapshot. Legacy clients keep today's push. Based on: `hub.ts:1895-1896` (account-wide broadcast), `hub.ts:3109` (all checkpoints pushed on subscribe).
- **Visible non-live panes fetch content through the existing `TaskRead`, not a new content request.** `readTerminalForAccount` already prefers a live daemon snapshot for an online device and falls back to the stored row (`hub.ts:4952`), and the desktop already calls `client.readTask` (`terminal-attach.ts:218-240`). A pane fetches once when it becomes visible and not live; while it stays visible and its device is online it refreshes on a timer of about today's 2 s; it stops when hidden. Rejected: a new request answered only from the stored row — a visible detached pane would degrade from 2 s to the content ceiling (detached sessions get no device-lane output, `packages/client/src/device-router.ts:1491-1507`, `:1973`, `:2452`). `(revised on plan audit)`
- **Capability negotiation is explicit in both directions; no `CONTROL_PROTOCOL_VERSION` bump.** The client declares the capability at authentication (`ClientAuth`, `proto/coflux/v1/client.proto`), and the center announces support in `AuthOk` following the existing per-feature bools (`client.proto:239-243`). The client switches to metadata + fetch only when the center announced support; otherwise it stays entirely on the legacy path. Rejected: inferring support from what arrives — an old center silently drops unknown client messages (`hub.ts:3058` switch has no `default`), so a pane would wait forever. `(revised on plan audit)`
- **Legacy clients keep today's push.** The iOS app (`packages/swift-client`) renders checkpoints as its read-only mirror (`CofluxClient.swift:647-651`, `:925`) and must keep working unchanged; its titles now update at content cadence — accepted. Its `ServerToClient` switch has a `default` (`CofluxClient.swift:675`), so new oneof cases are safe.
- **Old runtime ↔ new center and new runtime ↔ old center stay compatible.** The new center still accepts the legacy combined `SessionCheckpoint` and treats it as metadata + content. The old center ignores unknown daemon payloads (`hub.ts:2359` switch has no `default`) and content keeps travelling as `SessionCheckpoint` (with title and command) so an old center still gets titles and command state at content cadence. Whether content keeps `SessionCheckpoint` as its message is the executor's call only if both directions stay compatible.
- **Client: snapshot content leaves the reactive store; hidden panes never parse checkpoints.** The store keeps per-session metadata whose object identity changes only when a field changes; content lives in a non-reactive cache. Legacy pushes from an old center are treated as metadata + cached content and are still never parsed in a hidden pane. Rejected: keeping content in `sessionCheckpoints` and only skipping the write for hidden panes — every arrival would still churn ~80 selectors. Title readers move to metadata: `workspace-terminal.tsx:585`, `command-palette.tsx:234`, `command-palette-data.ts:208` (fixture in `command-palette-data.test.ts:77,119`).
- **The live attach path is unchanged.** Hidden attached panes keep streaming raw output; measured loopback traffic was negligible. Rejected: a client "leave" frame — no measured benefit.
- **`checkpointSeq` / `seedCheckpoint` in the device router is removed**, together with the test that drives it (`device-router.ts:261`, `:2404-2425`; `device-router.test.ts:880`) — it is written and never read.
- **Git statistics back off when their result stops changing; the branch check stays periodic.** The branch check is a file read and keeps its cadence. Per workspace, the git subprocess work (`merge-base`, `diff --shortstat`, `ls-files --others` plus reading untracked files) backs off exponentially to a ceiling (around a minute) while consecutive results are identical, and returns to the fast cadence as soon as a result changes or the branch changes. No filesystem-watcher dependency. Rejected: gating on recent terminal output — long-lived Claude TUIs redraw constantly so their workspaces never relax, and sessions adopted after a hot upgrade carry no `workspace_id` (`crates/runtime/src/session_ledger.rs:5-7`). Rejected: FS watching — inotify cost on large trees and a new dependency. The `main.rs:964` comment's "≤5s polling" constraint has no recorded source; it is superseded by this decision and the comment must say so. `(revised on plan audit)`
- **Catalog refresh stops re-rendering the sidebar.** A refresh that changes nothing the UI reads preserves store identity. `outputSeq` is written into `localSessions` every 3 s (`packages/client/src/store.ts:805`) and changes for every busy session, so it must leave reactive state (it has no reader outside `store.ts:288/805/821/851`) or be excluded from the change comparison; `upsert` (`store.ts:469-475`) must return the same array when nothing changed. `(revised on plan audit)`
- **Static activity dots do not animate.** States with no visible blink render without `coflux-dot-twinkle` (`pending-dots.tsx`).

## Direction

Data flow after this plan: sessiond emits command and title events and marks sessions dirty on output → the runtime sends metadata immediately (and in full on reconnect) and content after the quiet window or ceiling, plus a final content before exit → the center updates `commandStates` and the stored title from metadata, stores content, broadcasts metadata to capable clients and legacy full checkpoints to legacy clients → a capable client updates its metadata map; a visible non-live pane fetches through `TaskRead`.

Content toward the center keeps passing the secret-redaction choke point (`device.rs:3916-3921`, `self.secrets.redact`).

### Milestone 1: Protocol

The proto defines the metadata message (daemon→server and server→client), the client capability declaration in `ClientAuth`, and the center's support flag in `AuthOk`; TS, Rust and Swift artifacts are regenerated; the change is additive and passes the breaking check. Validation: `cd proto && buf lint && node ../scripts/check-protocol-breaking.mjs "../.git#ref=50d3e8c9,subdir=proto" && buf generate` → exit 0 and `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` lists only the intended regenerated files; `cargo test -p coflux-protocol` → exit 0.

### Milestone 2: Runtime

Title events from sessiond; metadata pushed on change and in full on reconnect; content at the quiet-window / ceiling cadence; final content before exit; git statistics back off on unchanged results. Validation: `cargo build --workspace` with zero warnings; `COFLUX_HOME= cargo test -p coflux-runtime` → exit 0.

### Milestone 3: Center

Accepts metadata and legacy checkpoints, keeps `commandStates` and the stored title current from either, stores content (including a just-exited session's final content), broadcasts metadata to capable clients and legacy checkpoints to legacy clients, announces support in `AuthOk`, and on subscribe sends capable clients metadata rather than content. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 4: Client and desktop

The client declares the capability and switches paths on the center's flag; metadata in the store, content in a non-reactive cache; visible non-live panes fetch via `TaskRead`; legacy pushes handled without parsing in hidden panes; `checkpointSeq` removed; titles read from metadata; catalog refresh preserves identity; static activity dots do not animate. Validation: `node --import tsx --test packages/client/src/*.test.ts` and `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

Dependencies: Milestone 1 gates 2, 3 and 4. After it, 2 (runtime), 3 (center) and 4 (client/desktop) touch disjoint trees and are independent; 3 and 4 meet only at the M1 messages. Within 2, git backoff is independent of the checkpoint work; within 4, catalog identity and activity dots are independent of the checkpoint work.

## Landmines

- The runtime's checkpoint path also feeds command state back into the local ledger (`device.rs:3960-3976`, "the fallback for a lost session.command push"). Lowering content cadence must not remove that catch-up.
- `pending_snapshots` dedupes in-flight snapshot requests per session (`device.rs:1323-1333`) and re-marks dirty; the cadence logic must not starve a continuously printing session (that is what the ceiling is for).
- Center-initiated reads for an online device go through `pending_snapshot_reads` (`device.rs:3922-3931`) and are separate from checkpoints — they must not be routed through the new cadence; `TaskRead` refreshes from visible panes depend on them.
- Stored-row upsert only applies when `snapshot_seq` grows (`apps/server/src/store.ts:1359-1361`), which would drop title-only updates; `hub.ts:4974` and the legacy subscribe replay read the title from that row. Persisting metadata needs its own update, and a content write must not roll back a newer title.
- Metadata acceptance must reuse the checkpoint path's session-ownership check (`hub.ts:1861-1866`) and title truncation (`hub.ts:1857-1860`), and stay under the device effect guard / transaction that re-checks task ownership (`hub.ts:1878-1897`).
- Stored checkpoints are removed in five places (`hub.ts:2319`, `:3658`, `:3736`, `:4383`; `prepared-operation-convergence.service.ts:203`); any new stored column or table must be cleared alongside.
- Removing a session clears its checkpoint in the client (`store.ts:1436-1438`), and logout/account change resets it (`store.ts:1759`); the metadata map and content cache need the same cleanup.
- `terminal-pane.tsx:935` calls `props.onOutput` on every consumer delivery, feeding `terminal-attach.ts:301-303`; once hidden panes stop receiving checkpoints only live output triggers it. That is intended, not a bug.
- `commandStates`' only consumer is the account CLI `terminal list` (`client-command.handler.ts:90`); `terminal wait` goes to the daemon (`hub.ts:5019`).
- Local Rust tests read the real Coflux environment: run them with `COFLUX_HOME=` cleared, and unset inherited `COFLUX_*` / `FORCE_COLOR` for black-box runs.
- Black-box ports are hardcoded: never run `pnpm -C tests test` while another suite runs on this machine.

## Merge and deploy

- Rollout order: deploy the center first, then release runtime and desktop. Old desktops and the iOS app keep working against the new center through the legacy push; a new desktop against an old center stays on the legacy path because `AuthOk` does not announce support.
- No database migration is expected if the stored checkpoint row keeps its shape; any schema change must be additive and listed here before merging.
- Rollback: the center can roll back independently — new runtimes still send content as `SessionCheckpoint`, and new desktops fall back to the legacy path when support is not announced.
- Release notes: no user-visible change; mention lower CPU/energy with many terminals.

## Scope

In scope:
- `proto/coflux/v1/` and regenerated `packages/protocol/src/gen`, `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`
- `crates/protocol`, `packages/protocol/src`
- `crates/runtime/src` (sessiond title event, checkpoint cadence, metadata push, final content before exit, git backoff)
- `apps/server/src` (hub and store: metadata, capability gating, final content acceptance)
- `packages/client/src` including its tests (store, device router)
- `apps/desktop/src/renderer` including its tests (pane content consumption, title readers, activity dots)
- `tests/src` only where a black-box test must follow a wire change it exercises

Out of scope:
- `crates/launcher` — stop semantics stay SIGKILL; no shutdown flush.
- `packages/swift-client` and `apps/ios` source beyond regenerated protobuf files — iOS stays a legacy client; migrating it is a follow-up.
- The live attach/output path and any client "leave" frame.
- Production deployment, releases, tags.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint + breaking + generation | `cd proto && buf lint && node ../scripts/check-protocol-breaking.mjs "../.git#ref=50d3e8c9,subdir=proto" && buf generate` | exit 0; generated dirs consistent with the commit |
| Protocol unit tests | `cargo test -p coflux-protocol` | exit 0 |
| Rust build | `cargo build --workspace` | exit 0, zero warnings |
| Runtime tests | `COFLUX_HOME= cargo test -p coflux-runtime` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client package tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Black-box (acceptance) | `pnpm -C tests test` | exit 0 (wire protocol touched; `secret-input.test.mjs` exercises the legacy checkpoint path) |
| Energy measurement (acceptance) | Desktop with many terminals printing in hidden panes: `top -l 3 -s 10 -stats pid,command,cpu` on renderer and runtime; `nettop -L 2 -s 10 -J bytes_in,bytes_out` on the center connection | renderer ≈1%; center→client bytes near zero |

## Done criteria

- [ ] All listed commands pass.
- [ ] A session printing continuously in a hidden pane causes no `terminal.reset`/`write` in that pane and no store update beyond metadata changes.
- [ ] A title-only change reaches capable clients without the runtime rendering a snapshot.
- [ ] A continuously printing session produces content at most once per ceiling plus once after it settles; metadata is sent in full right after a daemon reconnect.
- [ ] An exited terminal's stored final content includes the output printed right before exit.
- [ ] A visible detached pane on an online device refreshes at about 2 s via `TaskRead`; an offline device's visible pane shows the stored content; hidden panes fetch nothing.
- [ ] A new desktop against a center that does not announce support behaves exactly as today's legacy path minus hidden-pane parsing.
- [ ] A legacy client (old desktop, iOS) still receives full checkpoints and works unchanged.
- [ ] Git subprocess work backs off while results are unchanged and returns to the fast cadence on change.
- [ ] A catalog refresh with only `outputSeq` changes does not change the identity of anything the sidebar subscribes to.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (notably `crates/launcher` or iOS Swift sources).
- Compatibility in any direction (old runtime/new center, new runtime/old center, legacy client/new center, new desktop/old center) cannot be kept without a protocol version bump.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Content cadence is a staleness budget for offline view and the `read_terminal` fallback; anything that starts relying on stored content being fresher must revisit the ceiling.
- iOS migration to metadata + fetch is the natural follow-up; until then the center keeps the legacy push path.
- Plan audit (2026-10-10, fable): all findings accepted; none rejected.
