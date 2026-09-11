# Plan 018: Device rename (alias) - server/web display + daemon local settings.json synchronization

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat edee8b1..HEAD -- proto/ crates/worker/src crates/protocol/src apps/server/src apps/web/src/components/workbench apps/web/src/client packages/protocol/src`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `edee8b1`, 2026-07-20

## Requirement

Device names default to the local `deviceName` used by `cofluxd` at enrollment, usually the hostname. Accounts with several devices need recognizable aliases that can be edited in the web client.

Required outcomes:

1. In the device list on the web client, you can rename any device belonging to this account. The name change will take effect immediately on the web (no refresh required).
2. The rename will be persisted to the `devices` table of the server and will not be lost upon restart/reconnection.
3. Synchronize the new name to `deviceName` in local `~/.coflux/settings.json`: immediately for an online device, or after its next successful handshake if renamed offline. Local views such as `cofluxd status` then agree with the web.
4. Empty names (empty after trim) are not allowed to be submitted; there is no semantics of "clearing and falling back to default values".

Correctness boundary: a display-only rename lost on refresh is wrong; adding separate alias/name columns contradicts the decision to reuse name; updating only the DB without local settings synchronization is incomplete. Introducing tmp+rename atomic-write abstractions is outside this plan: existing similar writes directly truncate files.

## Decisions & tradeoffs

- **Reuse `devices.name`; add no alias column.** After enrollment, reconnects read device.name into registerDaemonConn without writing it back (`apps/server/src/hub.ts:322`), so server renames survive. A separate alias with alias ?? name would add schema and reset-to-original behavior that users do not need. The requirement is distinguishable names, not retaining original enrollment names. Evidence: devices DDL in `apps/server/src/store.ts:147-159`.
- **Protocol changes introduce new fields (compatible with proto3)**:
  - `proto/coflux/v1/client.proto` adds `message DeviceSetName { string daemon_id = 1; string name = 2; }`, mounts it into `ClientToServer.oneof payload`, tag=26 (the current maximum used tags are `client_fs_write=25`, `proto/coflux/v1/client.proto:177-180`).
  - `proto/coflux/v1/daemon.proto` adds `message DaemonSetName { string name = 1; }`, mounts it into `ServerToDaemon.oneof payload`, tag=22 (the current maximum used tags are `fs_write=21`, `proto/coflux/v1/daemon.proto:242-266`).
  - `cd proto && buf generate` has been verified to be executable online in this environment (remote plug-in `buf.build/bufbuild/es`/`buf.build/community/neoeinstein-prost`/`buf.build/apple/swift`).`packages/protocol/src/gen`, `crates/protocol/src/gen`, and `proto/gen/swift` generated artifacts for all three languages will be refreshed at the same time. Manual modification of these generated files is prohibited.
- **Resend the name at handshake completion; add no offline queue.** `registerDaemonConn` (`apps/server/src/hub.ts:220-237`) is the common completion point for enrollment and daemonAuthed reconnects. Send `daemonSetName` with current `info.name` there so offline changes apply on return. Sending only at rename time loses offline updates; a pending-sync table adds unnecessary state for an idempotent push. WorkerUpgrade is the existing server-push/daemon-side-effect pattern (`hub.ts:233`, `crates/worker/src/main.rs`).
- **Follow `workspaceSetName` for server renaming** (`apps/server/src/hub.ts:807-814`). In `case "deviceSetName"`, verify `device.accountId === client.accountId`, reject a blank trimmed name without writes/broadcasts/delivery, then call `store.updateDeviceName(id, name.trim())` and broadcast daemonUpdated using the existing payload shape (`apps/server/src/hub.ts:233`, `{ ...info, online: true }`). Devices have no branch-name fallback. For an online device found through `this.daemons.get(daemonId)`, update in-memory info.name and immediately send daemonSetName; handshake-only delivery would not synchronize an established connection.
- **Patch settings.json using `serde_json::Value`; do not add `Serialize` to Settings.** `crates/protocol/src/settings.rs` currently has read-only Deserialize semantics; historically only cofluxd writes it (`packages/cli/cofluxd.mjs:96-104`). Serializing the resolved Settings would persist environment overrides (`pick()` at `crates/worker/src/main.rs:83-89`) and discard future unknown CLI fields. Read raw JSON, patch only `"deviceName"`, and preserve other keys at the byte level as specified by this plan.
- **Skip synchronization when settings.json is absent; do not create a replacement.** Environment-only tests/containers often have no file (`tests/src/harness.mjs:255`, `COFLUX_DEVICE_NAME`). On unreadable/missing settings, silently skip the write, optionally logging, without disrupting the connection. Writing resolved configuration would wrongly persist env values and create an incomplete file.
- **Follow existing direct truncate writes; add no tmp+rename abstraction.** `crates/worker/src/creds.rs:49-50,75-76` and `packages/cli/cofluxd.mjs:103` use `OpenOptions{write,create,truncate}`/writeFileSync. **Known risk left unresolved:** cofluxd and worker can write concurrently. The recorded assessment is last-writer-wins without syntactically invalid JSON because each writes a complete valid JSON string. Treat this as existing risk; add no locks or merge logic.
- **DeviceRenameDialog has no clear-to-default behavior.** WorkspaceRenameDialog (`apps/web/src/components/workbench/dialogs.tsx:15-73`) falls back to branch name when empty; devices have no natural equivalent. Disable Save for trimmed-empty input and never submit it.

## Direction

Rename flow: web Rename menu → DeviceRenameDialog → `client.send({ case: "deviceSetName", value: { daemonId, name } })` → hub ownership check and store.updateDeviceName → daemonUpdated to all logged-in clients → for an online device, update this.daemons metadata and send daemonSetName → worker patches settings.json.

Offline flow: rename persists in DB → next connection runs registerDaemonConn → send daemonSetName with current info.name → worker patches local settings.

Protocol changes must comply with the `AGENTS.md` discipline: the `crates/protocol` wire format on the Rust side is consistent with the `packages/protocol` wire format on the TS side, and the proto must be `cd proto && buf generate` after the proto change (the remote plug-in needs to be connected to the Internet, and this environment has been confirmed to be available).

### Milestone 1: Protocol integration -`DeviceSetName`/`DaemonSetName` implemented to generate products

`client.proto` adds `DeviceSetName` (tag=26), `daemon.proto` adds `DaemonSetName` (tag=22), `buf generate` produces TS/Rust/Swift code for all three languages, and generates files without manual modification. Validation: `cd proto && buf lint` exit 0; `cd proto && buf generate` exit 0 and `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen proto/gen/swift` only displays diffs consistent with the planned changes; `cargo check -p coflux-protocol` exit 0.

### Milestone 2: Server - renamed persistence + broadcast + online instant delivery + handshake compensation delivery

`store.ts` adds `updateDeviceName`; `hub.ts` adds `deviceSetName` case (including empty name rejection, ownership verification, memory metadata update and instant delivery of online devices); `registerDaemonConn` adds `daemonSetName` to the connection completed after each handshake. Validation: `pnpm --filter @coflux/server build` (`tsc -p tsconfig.json`)exit 0.

### Milestone 3: daemon side - patch local `settings.json` after receiving `DaemonSetName`

Add a DaemonSetName branch to `route_authed` in `crates/worker/src/main.rs`. Read raw JSON, patch an existing file or skip a missing one, and preserve all other fields. Validation: `cargo check -p coflux-worker` → exit 0; `cargo build -p coflux-worker` with zero warnings.

### Milestone 4: web client - rename portal + dialog box

Add DeviceRenameDialog in dialogs.tsx. Wrap sidebar device rows in ContextMenu with Rename, a separator, and Remove device, retaining the inline delete button. Wire state, saveDeviceName, and dialog mounting through workbench.tsx. Validation: `pnpm --filter @coflux/web build` (`tsc -b && vite build`) → exit 0.

### Milestone 5: Black-box acceptance

Add/extend black-box cases for immediate online rename broadcast and persistence, immediate local settings synchronization, and offline rename applied after reconnect. For the local-file assertion, explicitly create settings.json under `stack.home` with deviceName and other fields: the harness normally uses environment variables only. Assert the actual file, including preserved fields. Validation: run the new test file independently (Commands acceptance entry).

## Landmines

- **The default black-box test daemon does not write `settings.json`**: `startStack` starting from `tests/src/harness.mjs:250-255` only transfers envs such as `COFLUX_DEVICE_NAME`, and `home` is an empty temporary directory. To verify the behavior of "local files are synchronized", the test must first hand-write a copy of `settings.json` in `stack.home` (and cannot rely on a conflicting env with the same name, otherwise the `pick()` priority will make the env value cover up the file reading result - the env only affects the value of `Settings::load` when the daemon starts, and does not affect the worker's direct reading of the file patch when `DaemonSetName` arrives. The two behaviors do not conflict with each other, but when asserting, you need to read the file instead of looking at env).
- **Online device rename cannot just wait for `registerDaemonConn`**: That is the handshake time, renaming happening on an established connection will not retrigger it. The `deviceSetName` branch of `hub.ts` must determine whether the target is online (`this.daemons.get(daemonId)`) and actively deliver it. Otherwise, the online device will have to wait for the next disconnection and reconnection before synchronizing local files. The experience is that "the web changes immediately after the name is changed, but the local machine does not change until it is disconnected and reconnected." This does not meet the expectations of a reasonable combination of requirements 1 (web takes effect immediately) and 3 (local synchronization).
- **Settings has only Deserialize** (`crates/protocol/src/settings.rs:6-13`). Do not add Serialize and round-trip resolved settings: that would lose unknown fields and persist env overrides. Use the decided serde_json::Value patch.
- **The field numbers of `ClientToServer`/`ServerToDaemon` are the only truth**: Before adding fields, be sure to grep again to find the current actual largest tag in the two oneofs (the 26/22 recorded in this plan is the value at the planning time). If there are other parallel changes that occupy these numbers during the period, the actual code shall prevail. Do not blindly reuse the numbers written in this document.

## Scope

In scope:

- `proto/coflux/v1/client.proto`, `proto/coflux/v1/daemon.proto` and `buf generate` products (`packages/protocol/src/gen`, `crates/protocol/src/gen`, `proto/gen/swift`)
- `apps/server/src/store.ts`, `apps/server/src/hub.ts`
- `crates/worker/src/main.rs` (and if necessary, new small settings are written into the helper and placed in the worker crate)
- `apps/web/src/components/workbench/dialogs.tsx`, `sidebar.tsx`, `workbench.tsx`
- `tests/src/` (new/expanded black-box test case)
- `plans/README.md`

Out of scope:

- `packages/cli/cofluxd.mjs` —  CLI side writing logic does not change and is still an independent writer
- New column in `devices` table - Decision has been made to reuse `name`
- Device "cancel alias and fall back to original name" interaction - there is no requirement to retain the original registered name
- `crates/supervisor/` — supervisor does not read and write `deviceName` in `settings.json` (only workers are on this link), not involved
- tmp+rename atomic write/file lock - decided to follow existing direct overwrite write style

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto lint | `cd proto && buf lint` | exit 0 |
| proto regeneration | `cd proto && buf generate` | exit 0, generated artifacts are committed |
| Rust build | `cargo build -p coflux-worker -p coflux-protocol` | exit 0, zero warnings |
| server type check/build | `pnpm --filter @coflux/server build` | exit 0 |
| web type checking/building | `pnpm --filter @coflux/web build` | exit 0 |
| Black-box full suite (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Online device rename: the web broadcast is immediately visible, the name is persisted to the DB, and the device’s local `settings.json` and `deviceName` are updated without reconnection.
- [ ] Offline device rename: local `settings.json` is reissued and synchronized after reconnection.
- [ ] Submissions with empty names (empty after trim) are rejected, will neither be persisted nor sent to the daemon.
- [ ] When `settings.json` is missing, the worker silently skips local writing and does not affect connections/other functions.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (especially the two tag numbers 26/22, see Landmines).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf generate` cannot run (remote plug-in is unreachable) - Stop and report when protocol changes cannot be implemented safely.

## Maintenance notes

- The worker’s serde_json::Value patch naturally preserves future cofluxd settings fields without extending Settings. If full Settings serialization is introduced later, reconsider accidental persistence of environment overrides.
- devices.name now represents both the original enrolled name and the user alias; the latter irreversibly replaces the former. Add a separate column only if future troubleshooting needs both.
