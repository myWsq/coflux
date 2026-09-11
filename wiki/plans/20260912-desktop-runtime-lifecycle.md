# Plan 20260912-desktop-runtime-lifecycle: Unified Coflux desktop lifecycle and device onboarding

> This is an outcome contract. Implement against current code; do not bypass acceptance or equate retained screen contents with retained live processes.
> Drift check: `git diff --stat 2934c35..HEAD -- apps/desktop packages/client packages/cli crates/supervisor crates/cli apps/server tests docs`

## Status
- State: DONE (local implementation and acceptance complete; no push or release)
- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: refactor
- Execution: self
- Planned at: `2934c35`, 2026-09-12
- Authorization: autonomously plan, commit, implement, and validate in an isolated workspace; no push, PR, or production deployment.

## Requirement
During implementation on 2026-09-12, the user clarified that desktop and CLI are clients of the same terminal kernel with equivalent functional roles: desktop serves humans; CLI primarily serves agents. CLI should cover login, workspaces, terminals, and cross-device operations. Updating either client must not terminate kernel-owned terminals. Agents must no longer require MCP. The user subsequently explicitly authorized removing MCP: remove its service entry point, dedicated OAuth flow, plugin configuration, and agent guidance together, moving its business capabilities to the account CLI.

Coflux is a terminal product. Installing and signing into the main Mac app should provide local and same-account remote devices without separately installing Coflux CLI or managing Worker/Supervisor. Users still install third-party commands such as Claude Code and Codex themselves. Linux CLI supports login and device onboarding; closing CLI or SSH must not stop the device. Preserve all agent capabilities: local terminal/read/send/wait, workspaces, progress, notifications, ports, and cross-device operations.

Closing a Mac window hides the UI while staying online. Explicit full quit asks for confirmation that local running terminals will end; cancel keeps them running. Logout additionally clears all local terminals and account authorization, leaving project files and other devices unaffected. Network disconnection is not explicit user quit.

Grant system disk permissions only to the main Coflux app; never ask users to separately add supervisor. Ordinary application updates may briefly disconnect the UI, but running terminal programs must survive and be reattached by the new version. Hosted-component updates may be deferred. Phase one does not implement arbitrary process snapshot recovery or live PTY handoff.

## Decisions & tradeoffs
- **The app owns lifecycle; terminal hosting may survive updates**: distinguish close-window, explicit quit, logout, and update restart. Reject treating all exits as process termination. Evidence: `apps/desktop/src/main/index.ts:109`, `updater.ts:45`; current quit only disposes, while updating uses quitAndInstall.
- **Retain existing session authority**: reuse supervisor-owned PTYs, VT, history, and sequence numbers; add no equivalent third layer. Change startup/hosting arrangements. Reject presenting output snapshots as program recovery. Evidence: `crates/supervisor/src/sessions.rs:446`, `main.rs:198`, `docs/architecture.md:47`.
- **Prove permission ownership empirically**: launch runtime components from the signed main Coflux app and point permission guidance at the .app. Verify protected-directory access in real terminals, including after updates. Reject cosmetic renaming or assumptions that child processes necessarily inherit permissions. Evidence: `crates/supervisor/src/fda.rs:3`; the independent LaunchAgent is currently the authorization subject.
- **Prioritize update compatibility**: UI updates must not automatically replace/stop live hosting processes. Old/new components must be compatible for reattachment; otherwise explicitly defer or confirm termination. A new version starting is not sufficient acceptance. Evidence: `docs/hot-upgrade-design.md:29`.
- **Onboarding and agents share the product, with platform-specific lifecycle**: Linux retains service management; desktop bundles agent tools and requires no Node installation. CLI uses account login APIs; bundled CLI may reuse app login, but must not persist user passwords. Evidence: `crates/cli/src/main.rs:1`, `packages/cli/cofluxd.mjs:1235`.
- **Protect existing sessions during migration** (decided during planning): opening the app must not silently kill existing CLI/launchd installations. Any migration that ends terminals requires an explicit notice. Dev instances use isolated homes and cannot take over real services.
- **User-data boundary**: logout ends and clears terminals, without deleting project, repository, or workspace files. Old-account credentials cannot onboard a new account. Offline cleanup must complete locally and reconcile records after connectivity returns.

## Direction
Milestones depend sequentially on one another and are implemented by the current executor.

### Milestone 1: Runtime and update boundaries
The main app controls local start, stop, and update reattachment. Quit confirmation and failure cancellation are reliable. Reuse the hosted process's local protocol rather than risking PID-based termination of another process. Tests use temporary homes/ports and independent process groups, never real ~/.coflux or launchd services.
Validation: `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop test`, `cargo test -p coflux-supervisor`.

### Milestone 2: Login, logout, and visible UI
Login automatically prepares the local device, with retryable failures. Permission guidance names only Coflux. Logout clears local terminals and authorization; agent commands remain available. Linux CLI login preserves compatibility with previous installation commands.
Validation: desktop checks/tests, `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`, `cargo test -p coflux-cli`.

### Milestone 3: Consolidate CLI client capabilities
CLI provides the same core workspace/terminal operations as desktop while retaining existing agent calls. Cross-device operations do not require MCP. Completing a CLI command is distinct from stopping the device; upgrading CLI does not end live terminals. Reuse existing protocols and runtime capabilities; choose command groupings under current CLI compatibility constraints.
Validation: `cargo test -p coflux-cli` and CLI type/command checks; include real cross-device calls in final black-box acceptance.

### Milestone 4: End-to-end validation and documentation
Use real processes to verify the same shell/task survives an update with continuous output, while quit/logout terminate and clean up appropriately. Verify permission ownership and update reattachment with a signed app. Update architecture, installation, and release documentation.

## Landmines
- Baseline black-box testing found a race at `tests/src/agent-control.test.mjs:212`: it waits only for the first-line ID before asserting second-line output. A separate rerun passes. Wait for complete observable output rather than adding fixed sleeps.
- RunAtLoad/KeepAlive in `apps/desktop/src/main/daemon-files.ts:35` currently conflicts with going offline on quit.
- `apps/desktop/src/main/daemon-manager.ts` currently copies and ad-hoc re-signs components and uses a global launchd label; this cannot guarantee main-app permission ownership.
- `apps/desktop/src/main/updater.ts` automatically installs on quit; window-closing order must not bypass quit confirmation.
- Logout at `packages/client/src/store.ts:869` only disconnects the client; logging out any remote client must not mean deleting remote terminals.
- Old services and dev share ~/.coflux; tests must isolate it.
- Compatibility covers more than the central protocol: old hosting components, new workers, agent tools, and plugin paths all matter.
- Only an Apple Development identity was found locally. Developer ID release signing/notarization may require external infrastructure; do not claim it passed.

## Scope
In scope: `AGENTS.md`, `apps/desktop/`, `packages/client/`, `packages/cli/`, `integrations/claude-plugin/` (synchronize CLI capabilities and guidance without marketplace publication), `crates/{supervisor,worker,cli,protocol}/`, `packages/protocol/`, `proto/` if needed, `apps/server/`, `tests/`, `scripts/`, `docs/`, `README.md`, `wiki/plans/`, related build manifests and CI.
Out of scope: production deployment, push/PR, third-party agent installation, arbitrary live-process snapshot recovery, live terminal-hosting handoff, and unrelated product UI redesign.

## Commands
| Purpose | Command | Expected result |
| --- | --- | --- |
| Desktop types/tests | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust | `cargo test -p coflux-supervisor -p coflux-cli && cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli` | exit 0, zero warnings |
| Black-box (acceptance) | `pnpm -C tests test` | All pass |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Signed runtime (acceptance) | Signed app with isolated home: grant main-app FDA, update with a live task, test quit/logout | Same tasks survive or end according to user action; only Coflux owns permission |

## Done criteria
- [x] Type checks, unit tests, builds, and full black-box suite pass.
- [x] Close-window, quit, cancel quit, logout, and update restart follow the contract.
- [x] Automatic onboarding after login, CLI login, and existing core agent capabilities verified.
- [x] Live tasks survive application updates; the new application reuses the original hosting instance.
- [x] Apple Development signed-app permission ownership and protected-directory access after updating verified.
- [x] Project files retained, other-device tasks remain live, and old logged-out client sessions cannot continue access.
- [x] Documentation matches actual behavior, scope reviewed, index marked DONE.

## MCP removal addendum
- Remove `/mcp`, dedicated `/oauth/*`, and OAuth metadata routes; retain device-authorization and port-preview pages.
- Delete plugin `.mcp.json` and MCP guidance; new terminals no longer receive `COFLUX_MCP_URL`.
- Move workspace/terminal mutation, cross-account isolation, and environment-injection black-box tests to the account API. Add acceptance that old routes return 404.
- Do not rewrite applied database migrations. Old OAuth tables remain temporarily with no read/write entry points. Preserve assigned protocol field numbers for compatibility; server no longer handles OAuth messages or publishes MCP addresses.
- Old plugins require upgrading after MCP removal. This task does not deploy, publish the marketplace, or modify users' installed host configuration.

## STOP conditions
A required fact is disproven; authorized product scope must expand; validation still fails after one reasonable fix; external signing/system authorization prevents acceptance. Record completed results and missing evidence without marking complete.

## Maintenance notes
Lifecycle and process existence are independent of client network connectivity. Surviving ordinary updates does not imply program recovery after macOS restart or hosting-process crash.

## Implementation addendum: CLI account channel
- Pattern Plan: interface adaptation plus runtime assembly. Add contract/handler pairs in `interface/client-login/` and `interface/client-command/`, registered in `app.ts`. Account validation and task side effects continue through Hub/Store. Interfaces do not duplicate task transactions or PTY logic and add no plugins/database models.
- CLI uses the same account session as desktop; device tokens cannot perform account operations. Account commands use versioned JSON requests and structured results, reusing existing Hub account operations. MCP and its OAuth adapters have been removed.
- New commands cover device/project/workspace discovery and workspace/terminal operations. Existing credential-free current-workspace agent commands remain compatible. Explicit targets enable cross-workspace calls.

## Acceptance record (2026-09-12)

### Verified
- Final full black-box suite: 316/316 (214.9 seconds, concurrency 2). MCP-specific OAuth tests retired; business-behavior tests migrated. Command: `CARGO_TARGET_DIR=/Users/wsq/Workspace/coflux/target COFLUX_SUPERVISOR_BIN=/Users/wsq/Workspace/coflux/target/debug/coflux-supervisor COFLUX_WORKER_BIN=/Users/wsq/Workspace/coflux/target/debug/coflux-worker COFLUX_RELAY_BIN=/Users/wsq/Workspace/coflux/target/debug/coflux-relay COFLUX_CLI_BIN=/Users/wsq/Workspace/coflux/target/debug/cofluxd COFLUX_TEST_CONCURRENCY=2 pnpm -C tests test`.
- Final Apple Development package passes `codesign --verify --deep --strict`; resources contain no `.mcp.json`, and bundled SKILL no longer directs MCP setup. This is not Developer ID, notarization, or Full Disk Access acceptance.
- Desktop/server type checks and desktop build pass. Original desktop implementation tests: 113/113; after follow-up fixes: 116/116. Rust CLI: 32/32; supervisor: 73/73.
- New account CLI black-box tests use two real daemons to verify both CLI login paths, device discovery, and remote workspace/terminal operations. Command exit leaves terminals alive.
- Former MCP workspace/terminal and isolation assertions now use the HTTP account interface. Old service URLs return 404. Device authorization and port previews retain their pages/authentication.
- Hosted-kernel black-box tests verify the same shell PID and memory variable survive reconnection. An incorrect instance identity cannot stop a new instance; a correct stop terminates the real program.
- Isolated Apple Development signed app on a real machine: login automatically onboards locally; bundled CLI gets the account without another login. After creating a terminal and canceling quit, PID 59015 and its memory marker remain. Confirmed quit ends app/shell and removes the runtime socket. Relaunch restores the account but correctly shows the old terminal as exited rather than pretending to recover it.
- All real-machine operations used temporary userData, COFLUX_HOME, local server 8876, and a temporary database. Real installations and system services were untouched. Follow-up acceptance instances, temporary databases/app directories/update caches were cleaned up; the test app no longer appears in system permission lists.

### Additional acceptance evidence (2026-09-12)
- Actually clicked the built-in update button; electron-updater/Squirrel downloaded, replaced, and restarted the independently signed `dev.coflux.acceptance` app from 0.1.7 to 0.1.8. userData remained temporary after restart. A forced restart was not substituted for an update.
- Before/after values were identical: runtime.instanceId `91ea737a142a92b357fc598253d680c0`, runtimeId `bbcbf999098b64050e76ee53`, sessionId `2c408399-e1db-4dc9-b552-1ca7fecc8aeb`, shell PID 34913. Real input after updating printed `AFTER_UPDATE=preserved PID=34913`, proving shell memory survived.
- Clicking the red close-window button after updating left app PID 49774, kernel PID 33570, and shell PID 34913 alive. Reopening through LaunchServices allowed continued operation. Cmd+W closes a terminal tab and was not used for close-window acceptance.
- Real-machine logout with no live terminals verified: runtime socket, credentials.json, and session-token.bin disappear; the cloud reports local terminalCount 0 and device offline. Signing back into the same account reconnects the same device.
- Added and successfully ran `scripts/verify-desktop-account-lifecycle.mjs`: with a real center and two daemons, offline logout clears local credentials/terminal-data; reconstructed components reconnect and drain the outbox. Cloud local tasks are deleted, the old client token returns 401, the other device's task keeps running, and project files remain unchanged. This is component integration acceptance, not GUI/safeStorage acceptance; black-box boundaries remain intact.
- Reusable real-machine procedure: [Isolated desktop lifecycle acceptance](../../docs/desktop-lifecycle-acceptance.md). Local supplementary evidence: update log `/tmp/coflux-update-app.log`, kernel state `/tmp/coflux-update-after.json`, account integration log `/tmp/coflux-account-lifecycle-acceptance.log`.

### Final real-machine acceptance and fixes
- Main-app permission ownership proven: user authorized with Touch ID, adding only `Coflux Acceptance.app`, never Supervisor. Original PID 34913 was denied before authorization and returned `FDA_GRANTED_EXIT=0` afterward. Following another Squirrel update, 0.1.8 → 0.1.9, it still returned `FDA_AFTER_UPDATE=0 STATE=preserved PID=34913`. Only directory accessibility was checked; file contents were not read.
- With user-assisted menu operation, the real live-terminal logout confirmation appeared; cancel left the original terminal alive. Confirmation exposed a quit race: the terminal ended, but UDS EOF prevented credential cleanup. Fixed with three UDS regression tests covering lost stop acknowledgement, lost subsequent status response, and protection of a new instance. Fixed package 0.1.11 was retested on the machine: confirmed logout returns to login; new shell PID 81953 ends; runtime.sock, credentials.json, session-token.bin, and terminal-data are absent; cloud local terminal count is 0 and the device offline. Results: `/tmp/coflux-logout-acceptance-result.json`.
- Also fixed false FDA status from the old kernel's startup cache and stale errors blocking updates after reconnection. The fixed menu no longer falsely reports missing permissions.
- Follow-up validation: desktop types, 116 tests, and build pass; server types pass; full black-box suite 316/316 (222.0 seconds); Rust build has zero warnings.

### Delivery boundaries
- Apple Development signing was used for actual application updates, main-app permission ownership, and lifecycle acceptance. No Developer ID production release, notarization, marketplace publication, or production deployment occurred. Those remain subsequent release checks and do not invalidate completed local architectural acceptance.
- CLI currently covers the original agent's core workspace/terminal capabilities and account discovery. This does not mean every GUI feature, including project import, file browsing, or live interaction, already has a CLI command.

Local completion criteria are satisfied; marked DONE. Retain the workspace and local commits for review; do not push or open a PR.
