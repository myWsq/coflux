# Plan 20260912-notification-inbox: Durable account notifications

## Status
- Result: DONE (implementation complete; signed native delivery remains a release acceptance check).
- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent — host-supported default from dev:execute-plan; one dependent implementation unit.
- Stop after: implementation — user explicitly requested implementation.
- Workspace: isolated — user requested a separate Coflux workspace.
- Planned at: `67b51751c0e33e5742312975d9876dd83cbd0664`, 2026-09-12.
- Branch: `dev/20260912-notification-inbox`.
- Commit policy: repository AGENTS.md requires all checks before commits; defer plan and implementation commits until checks pass.

## Requirement
Replace explicit `coflux notify`'s transient presence annotation with durable account-owned notifications. Users receive notifications from all their devices/workspaces. A notification has unread/read state, not a task-completion workflow. The desktop has an always-accessible notification entry beside the sidebar account area with an unread count, a newest-first history list, and mark-all-read. Each item shows message, source device/workspace/terminal and time. Clicking it marks it read and selects the source terminal. Closing a transient hint does not mark read. Missing/deleted targets retain readable history and explain why navigation is unavailable. Loading, empty, failed and disconnected states remain intelligible.

Every newly received explicit notify shows an in-app hint when Coflux is foreground, even when the source workspace is selected; it must not steal focus. When this desktop is backgrounded, also show a native system notification. Clicking it activates the app and opens the source notification/terminal. Hidden/minimized windows count as background. Fully quit applications sync history on next launch; OS push to terminated apps is out of scope. Initial/reconnect history does not cause a burst of native or in-app alerts.

Read state syncs across clients on the same account. Hook updates, agent exit and target deletion never erase history. CLI success means the server committed the notification, not merely that the local daemon accepted a request. Failures/timeouts are explicit; transport retries of one send are idempotent. Separate deliberate invocations may create separate messages even if their text matches.

## Decisions & tradeoffs
- **Independent persisted account entity**: server stores message and source identity/display snapshots, read state and creation order. Rejected presence-only message: hooks immediately clear it (`crates/worker/src/observed.rs:92`).
- **Source comes from authenticated session ownership**: local caller identity follows existing process-tree/session controls; server derives account and source via owned task/device/workspace. Never trust caller account IDs.
- **Read is not resolved**: user explicitly selected unread/read only. Clicking an item marks that item read; opening the panel does not mark the entire inbox read.
- **Reliable send acknowledgement**: success follows server persistence acknowledgement. Rejected local-only success (`crates/worker/src/agent_ctl.rs:232`). No unbounded offline send queue; explain inability to confirm delivery. Use a stable per-request identifier for transport deduplication.
- **Foreground is application-wide**: selected workspace does not suppress an in-app notification. Rejected existing selection-based suppression (`apps/desktop/src/renderer/components/workbench/workbench.tsx:116`).
- **History and live events differ**: initial/reconnect sync populates history/counts without alert storms; duplicate live delivery must not repeat hints. Read-state changes must not be overwritten by stale snapshots.
- **Explicit notify only**: automatic approval/question hooks keep their existing attention behavior; do not turn every state transition into inbox history. Compose Dock badge ownership in one place so existing waiting state and unread inbox drivers cannot overwrite each other.
- **Compatibility**: preserve existing protobuf field numbers and migrate additively; older capability/unsupported-server paths must fail explicitly rather than silently reverting to transient notifications.
- **English project prose**: docs/comments/plan in English; intentionally Chinese UI copy follows current app language.
- **Plugin delivery**: sync canonical CLI skill to integrations copy. No marketplace publication, production deployment, release, push, PR, or main-branch merge is authorized.

## Direction
One implementation unit; milestones are sequential and share protocol/store surfaces.
1. Durable delivery: additive wire contracts, database migration/store ownership and idempotency, worker forwarding/ack and both CLI variants; server-confirmed send survives hooks/restarts/deletion. Validation: server typecheck, Rust build/protocol tests.
2. Account inbox: shared client sync/read APIs and desktop history/hints/native routing/focus/unread badge behavior. Validation: desktop typecheck and relevant client/desktop unit tests.
3. Acceptance and documentation: black-box coverage for ownership, persistence, retries, read synchronization and notify lifetime; CLI/skill docs reflect actual semantics. Validation: complete black-box suite and desktop build, followed by isolated UI inspection.

## Landmines
- Existing notify tests deliberately assert that a hook clears the message (`tests/src/agent-control.test.mjs:308`); replace those expectations for explicit notifications, retaining automatic state tests.
- Current annotation merge prunes sessions without an agent process (`crates/worker/src/observed.rs:260`). Explicit notify must work inside an owned Coflux terminal even without a detected agent.
- Current native callback only selects a workspace (`workbench.tsx:376`); source terminal selection is required.
- Electron native notification delivery requires signed artifacts/system permission. Verify rendering/IPC behavior locally and report any native delivery verification boundary honestly.
- Schema migration definitions carry checksums; append a migration rather than rewrite prior migration definitions.
- Existing source names and comments can be stale; inspect live Rust/TS wire generation and existing command request/reply paths.

## Scope
In scope:
- `proto/`, `crates/protocol/`, `packages/protocol/`: notification wire contracts and generated artifacts.
- `packages/swift-client/Sources/CofluxProtocol/Generated/`: mechanical generated protocol parity required by CI; no Swift client/UI changes.
- `crates/worker/`, `crates/cli/`, `packages/cli/`: send, ack, help and canonical skill.
- `apps/server/`, `packages/client/`, `apps/desktop/`: account notification persistence, delivery, inbox UX and tests.
- `tests/`: meaningful black-box coverage and existing notify expectation updates.
- `integrations/claude-plugin/`: canonical skill synchronization and delivery version if required, no external publishing.
- `docs/`, `README.md`, `wiki/plans/20260912-notification-inbox.md`, `wiki/plans/README.md`: relevant behavior documentation and plan status.
Out of scope: supervisor behavior, iOS/frozen web UI, automatic-hook inbox generation, task resolution workflow, production/deployment/release/marketplace publication, unrelated refactors.

## Commands
| Purpose | Command | Expected |
| --- | --- | --- |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust build | `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | zero warnings |
| Protocol unit tests | `cargo test -p coflux-protocol` | exit 0 |
| Desktop types/tests/build | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Black-box (acceptance) | `pnpm -C tests test` | exit 0, isolated temporary stacks |
| Desktop UI (acceptance) | isolated dev/test account and desktop harness; foreground/background/history/navigation flows | recorded visual evidence, no production mutations |

## Done criteria
- [x] Commands pass; native signed-package limitations reported honestly if not exercised.
- [x] Explicit notify persists once per request and acknowledges only after durable save.
- [x] Same-account history/read sync; cross-account access rejected.
- [x] Plain owned shell works; hooks/exit/deletion do not erase history.
- [x] Foreground hint, background system request, unread badge, source navigation and missing-target UX work.
- [x] Initial/reconnect sync does not replay alert storms or regress read state.
- [x] CLI and skill documentation agree with new delivery semantics.
- [x] Full diff reviewed; no unrelated changes; plan status updated.

## STOP conditions
Report concrete blockers for broken assumptions, required out-of-scope work, or repeated identical failures after a reasonable fix. Never deploy or publish without explicit authorization.

## Maintenance notes
Keep bounded history fetching, account authorization, stable pagination/read cutoffs, event ordering and deduplication explicit. Prefer existing request/reply and UI patterns. Validation belongs to the orchestrator under delegation. Repository commit gates take precedence over the skill's early-commit workflow.

## Verification results (2026-09-12)

- Server typecheck, desktop typecheck and production build passed. Rust supervisor, worker, relay and CLI built without warnings.
- Rust unit suites: 260 passed. Desktop: 90 passed. Shared client: 78 passed.
- Complete black-box suite: 217 passed, 0 failures/skips, approximately 118 seconds; includes durable ACK/idempotency, bounded pagination, read cutoffs, same-account synchronization, account isolation, restart recovery and source deletion.
- Protobuf lint and additive compatibility checks passed; regenerating TS/Rust/Swift outputs produced identical hashes. Canonical/plugin skill synchronization and whitespace checks passed.
- Isolated Electron and real temporary server/daemon/database: empty inbox, foreground notification in the source terminal without stealing input focus, persistent unread count after hint expiry, history/source labels, single-item read clearing the badge, and notification navigation from the device view back to the source terminal were exercised through the UI.
- Mark-all-read, stale/out-of-order events, reconnect history suppression and precise native IPC payloads passed automated coverage. Native OS presentation/click and Dock appearance were not accepted on this unsigned Electron instance; verify them using a signed desktop artifact before release. The attempted minimize scenario did not establish native delivery evidence.
- No production deployment, external publication, push, PR, or merge. Existing unrelated changes in the main checkout were left untouched.
