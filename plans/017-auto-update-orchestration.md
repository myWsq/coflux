# Plan 017: Orchestrate automatic daemon worker hot upgrades

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 909575e..HEAD -- proto/ crates/ apps/server/src apps/web/src tests/src docs/RELEASING.md docs/hot-upgrade-design.md .github/workflows/release.yml`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `909575e`, 2026-07-20

## Requirement

The hot-upgrade **execution** path is complete and black-box tested: download → SHA-256 → ed25519 verification → probationary switch → rollback on failure, with PTYs surviving. The **trigger** is manual only (`clientUpgradeDaemon`), and the web has no entry point, so only tests/scripts send it. Daemons on users’ machines have no mechanism to follow releases. This is the follow-up recorded at `docs/RELEASING.md:55`.

Required outcomes:

1. Within one polling interval of a stable release (tag without `-`), the server automatically pushes that worker version to all online daemons. Running PTYs survive through the existing hot-upgrade mechanism.
2. Server/web expose each online daemon’s worker and supervisor versions. Supervisor lag is visible, but supervisor upgrades remain manual.
3. Failed upgrades and rollbacks cannot create an unbounded old-version reconnect → repush → failure loop; apply backoff.
4. Do not automatically push prereleases (tags containing `-`). Retain manual `clientUpgradeDaemon` for staged rollout.

The boundary between correct and incorrect solutions: an implementation of "daemon polling GitHub by itself" is wrong (the direction has been set as server push); an implementation that uses semver ordering to determine push is wrong (the decision is push if not equal); an implementation that performs automatic restart and upgrade for supervisor is out of scope.

## Decisions & tradeoffs

- **Use server-pushed upgrades.** Daemons report versions at handshake; the server compares and sends upgrades. Per-daemon GitHub polling would lose centralized rollout control, multiply API traffic, and duplicate the existing manual trigger. Evidence: the delivery path already exists at `apps/server/src/hub.ts:684`, and `docs/RELEASING.md:55` records this direction.
- **Poll GitHub `/releases/latest` for the desired version.** The endpoint excludes drafts and prereleases. When a new tag appears, fetch its manifest.json asset, containing target-specific `url/sha256/signature` from `scripts/release-sign.mjs:22-47`. Forward fields unchanged; signature verification remains at the supervisor security boundary (`crates/supervisor/src/upgrade.rs:46`). Reject a CI-driven admin API, which needs a new endpoint and production credentials in CI, and manually maintained server versions, which are only semi-automatic.
- **Configure the GitHub API base and repository through environment variables; leave automatic updates disabled when absent.** This supplies both the production switch and test injection for a local mock API/manifest/artifact server. Follow `apps/server/src/config.ts`’s environment-only pattern (`config.ts:5-40`). This is the server’s first outbound-fetch feature.
- **Push on strict inequality (`!==`), but skip an empty reported version.** Do not compare semver: `"builtin"` must upgrade, and a future pinned/rollback version must work. Empty means an older daemon with unknown version, handled manually. Semver would block rollback and cannot order builtin. Evidence: the built-in version is hard-coded `"builtin"` (`crates/supervisor/src/main.rs:50`).
- **Compare after every completed daemon handshake (`registerDaemonConn`) and sweep online daemons after each polling result.** Evidence: the hub’s in-memory `daemons` Map (`hub.ts:123`) and the heartbeat setInterval precedent (`apps/server/src/index.ts:89-92`).
- **Track attempts per (daemonId, version) in server memory, with a retry cap and cooldown.** The executor chooses values; recommended scale is at most three attempts and at least one hour cooldown. Restart may reset the bounded allowance. Persisting rare failure state in Postgres is unnecessary. Rollback restarts the old worker, causing another handshake (`crates/supervisor/src/manager.rs:111-131`), so missing backoff inevitably loops.
- **Add backward-compatible proto3 fields to handshake messages.** Add `worker_version`, `supervisor_version`, and `arch` to `DaemonEnroll`/`DaemonAuth`/`DaemonEnrollRequest` (`proto/coflux/v1/daemon.proto:12-28`), plus worker/supervisor versions to `DaemonInfo` (`proto/coflux/v1/common.proto:10-16`) for web display. Old daemons decode to empty strings and are skipped. A separate message is unnecessary: handshake fields naturally cover reconnects.
- **Pass versions from supervisor to worker through spawn environment:** current worker version and supervisor version. Every restart/upgrade respawns and re-handshakes with fresh values. IPC would add timing without benefit. Evidence: spawn already passes `SUPERVISOR_SOCK_ENV` (`crates/supervisor/src/manager.rs:76`); the worker currently has no version/CARGO_PKG usage.
- **Inject the release tag at compile time for the supervisor.** Read a build variable such as `COFLUX_RELEASE_VERSION` using `option_env!`, falling back to `"dev"` locally. Set it to github.ref_name in release.yml. Do not use `CARGO_PKG_VERSION`: `Cargo.toml:11` contains placeholder 0.0.0; tags define releases.
- **Map platform plus reported `std::env::consts::ARCH` to a Rust target on the server.** Match `rustTarget()` in `packages/cli/cofluxd.mjs:32-37`; skip and log unsupported combinations.
- **Display supervisor versions without automatically upgrading them.** The supervisor owns PTYs; restarting it kills sessions. Its infrequent changes do not justify automation risk. Continue manual `cofluxd update` (`docs/RELEASING.md:57-63`).
- **No opt-out switch, no channel configuration, no persistent version storage** (no columns are added to the devices table, and versions only exist in the memory state of online connections; offline daemons cannot see versions, which is acceptable). Single user product, YAGNI.
- **Minimal web display (decided during planning):** add worker and supervisor versions to the existing device host/platform tooltip (`apps/web/src/components/workbench/sidebar.tsx:264`). Add no stale-version highlighting or upgrade button.

## Direction

Data flow: publish release → poll GitHub for `{version, manifest}` → inspect each online daemon’s ` (workerVersion, platform, arch)` → skip empty/equal/unmapped versions → apply backoff → send existing `workerUpgrade` → supervisor downloads, verifies, observes, and rolls back as already implemented. Reporting flows from supervisor spawn environment to worker handshake, hub online metadata, and web `DaemonInfo`.

Protocol changes must comply with the `AGENTS.md` discipline: the Rust side `crates/protocol` and the TS side `packages/protocol` wire formats are consistent, and the proto is changed to `cd proto && buf generate` (the remote plug-in needs to be connected to the Internet).

### Milestone 1: Version integration - reported by daemon, held by server, visible on web

Add a compile-time supervisor version with local `"dev"` fallback and pass versions at worker spawn. Extend the three handshakes with version/arch fields and DaemonInfo with versions. Store online metadata in the hub and publish via `stateSnapshot`/`daemonUpdated`; show both versions in the sidebar tooltip. Inject tags from release.yml. Validation: `cargo build -p coflux-supervisor -p coflux-worker` with zero warnings, `cargo test -p coflux-protocol`, `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`, and `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0.

### Milestone 2: Server automatic orchestration - polling, comparison, delivery, and backoff

Add an orchestration module tied to the index.ts lifecycle. Poll at an environment-configured interval, cache `{version, manifest entries}`, compare on handshake and poll refresh, and apply strict inequality, empty-version skipping, target mapping, and capped cooldown per (daemonId, version). Do not start when configuration is absent. Reuse or extract hub.ts’s existing workerUpgrade sender without copying or bypassing supervisor semantics. Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0; run any unit tests added for comparison/backoff/mapping.

### Milestone 3: Black-box acceptance + document closing

Add an isolated black-box test under `tests/src/` with an unused port and temporary HOME/DB. A local `node:http` server supplies `/releases/latest`, a linked manifest, and artifacts. Point server configuration at it and inject the test key through `COFLUX_WORKER_PUBKEY`, following `tests/src/signed-upgrade.test.mjs`. Assert automatic upgrade to the mock’s version after connection, without a manual trigger, using existing upgrade-completion observations. For bad artifacts, assert bounded pushes proving backoff. Update `docs/RELEASING.md:55` from follow-up work to the implemented mechanism and revise `docs/hot-upgrade-design.md` status. Validation: run the new file independently (Commands acceptance entry) and check documentation references.

## Landmines

- **Worker has no idea about its own version**: The version is purely a supervisor-side concept (`active`/`running_version`, `crates/supervisor/src/manager.rs:23-26`, `worker.active``manager.rs:64-66`). The reported value must be passed in from the supervisor spawn. Do not try to inject the worker version into the worker during compilation - the binary version downloaded by hot upgrade shall be based on the manifest/tag, and the supervisor will know which one is running.
- **`option_env!`'s cache pit**: cargo will not be automatically recompiled due to env changes; `build.rs` needs to declare `cargo:rerun-if-env-changed=<env name>` (CI new builds will not be affected, local incremental builds will).
- **The version string is the attack surface**: There is `validate_version()` anti-path traversal (`crates/supervisor/src/upgrade.rs:29`) on the supervisor side. The version taken by the server from the GitHub tag will flow into the delivery message and then into the daemon file path. Keep this verification chain intact and do not introduce uncleaned version values on the server side to bypass it.
- **AGENTS.md's sqlite description is obsolete**: the server is actually Postgres (`apps/server/src/store.ts:147-159` inline DDL, no migration directory). The code shall prevail.
- **When running the black-box test on the local machine, `COFLUX_TEST_PG_URL` must point to the direct connection port of `54322`** -`5432` is a supavisor and will report a tenant error.
- **`/releases/latest` and `resolveLatestTag()` have different semantics**: The CLI update of `packages/cli/cofluxd.mjs:55-66` uses the latest tag containing prerelease, while this feature deliberately uses `/releases/latest` (excluding prerelease). The coexistence of the two is intentional and should not be "conveniently unified".
- **`clientUpgradeDaemon` has no call point on the web** (only test structure, `tests/src/signed-upgrade.test.mjs:101,126,148`) - The UI entry for manual upgrades is not within the scope of this plan, so don’t add it casually.

## Scope

In scope:

- `proto/coflux/v1/daemon.proto`, `proto/coflux/v1/common.proto` and `buf generate` products (`crates/protocol/src/gen`, `packages/protocol/src/gen`)
- `crates/supervisor/` (version constant, spawn env), `crates/worker/` (handshake carrying version/arch)
- `apps/server/src/` (hub metadata, orchestration module, config env, index life cycle)
- `apps/web/src/` (only the device list version is displayed)
- `.github/workflows/release.yml` (compile-time version env injection)
- `tests/src/` (new black-box test)
- `docs/RELEASING.md`, `docs/hot-upgrade-design.md`, `plans/README.md`

Out of scope:

- `packages/cli/cofluxd.mjs` — — CLI manual update link does not move
- Supervisor automatic upgrade/idle restart mechanism - explicitly excluded
- Web manual upgrade button, outdated-version highlighting - only the tooltip is visible
- Devices table schema change - the version is not stored in the database
- opt-out / channel configuration - YAGNI
- `crates/supervisor/src/upgrade.rs`'s download/signature verification/rollback semantics - only reused, not changed

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build (zero warnings) | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| Rust unit test | `cargo test -p coflux-protocol` | exit 0 |
| server type check | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web type checking | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| proto regeneration | `cd proto && buf generate` | exit 0, generated artifacts are committed |
| Black-box full suite (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] Black-box test proves: there is no manual triggering after daemon goes online, and workers are automatically upgraded to the version declared by mock release.
- [ ] Black-box test proves: There is a limited number of pushes in the upgrade failure scenario (backoff takes effect).
- [ ] env When the releases source is not configured, the server behavior is exactly the same as the current situation (the feature is turned off as a whole).
- [ ] prerelease will not be automatically pushed (`/releases/latest` semantics are guaranteed, stated in tests or code comments).
- [ ] web device tooltip visible worker/supervisor version; old daemon (empty version) is not pushed.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf generate` cannot run (remote plug-in is unreachable) - Stop and report when protocol changes cannot be implemented safely.

## Maintenance notes

- The backoff status is in the server memory and will be cleared upon restart - if a restart storm is observed to amplify the push in the future, persistence will be considered.
- arch→target mapping is consistent with `cofluxd.mjs``rustTarget()`manually; both places must be added when adding a new platform.
- When publishing a version containing supervisor changes, manual `cofluxd update` and `RELEASING.md` reminders are still required; the visibility of the supervisor version on the web is a way to identify outdated supervisors.
