# Plan 112: Foundations for desktop-bundled daemon: Rust agent CLI, supervisor PATH/version, and client device authorization

> This plan is an outcome contract, not a step-by-step script. Understand requirements/decisions and implement against live code. Validate only if also the verifier; delegated executors implement with checks outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
>
> Drift check: `git diff --stat 34078ff..HEAD -- Cargo.toml crates/cli crates/supervisor/src/sessions.rs crates/supervisor/src/main.rs crates/supervisor/src/fda.rs crates/worker/src/hook.rs packages/cli/cofluxd.mjs packages/client/src proto/coflux/v1/client.proto apps/server/src/hub.ts .github/workflows/ci.yml tests/src/session-env-injection.test.mjs tests/src/agent-control.test.mjs`

## Status

- Priority: P1
- Effort: M
- Risk: MED (new crate, supervisor environment, client methods; no UI/protocol change)
- Depends on: none (main 34078ff includes 110; foundation for dependent 113)
- Category: feature
- Execution: subagent, general-purpose model fable; 2026-09-11 exploration authorized continuous execution, while push/PR/merge/release still need explicit request
- Planned at: `34078ff`, 2026-09-11

## Requirement

The user wants installing Coflux.app to suffice on macOS, without global npm cofluxd or manual supervisor management. Plan 113 makes desktop installer/manager; this plan supplies UI-free prerequisites outside desktop:

1. **Agent commands without Node.** Terminal agents/plugins currently need npm cofluxd for terminal/progress/notify/ports/workspace/hooks; hooks silently do nothing when command absent, and session-context.sh calls workspace. Electron cannot act as Node because runAsNode fuse is false. Build an equivalent Rust binary still named cofluxd for 113 to bundle/install into ~/.coflux/bin.
2. **Supervisor prepends COFLUX_HOME/bin to every terminal PATH**, exposing bundled CLI without user shell-config edits.
3. **Write running supervisor version** to COFLUX_HOME/supervisor-version at startup, allowing 113 to compare bundled versus running versions; current status only knows liveness (CLI:549-585).
4. **Client authorization redemption**: logged-in desktop needs to redeem daemon's one-time token. Existing device_authorize and device_authorize_info/device_authorized messages already do this; hub redemption is shared with server-rendered confirmation (client.proto:46-48,169,216-225,337-338; hub:2756,3539-3546; auth-pages:409). Client package has no caller since 107 removed browser authorization. Add awaitable authorizeDevice(token) for 113 renderer.

Completion: crates/cli emits interchangeable cofluxd; new terminal PATH starts with home/bin; version file matches handshake; client returns authorization success/reason. npm implementation and Claude plugin remain unchanged.

### Confirmed product conclusions

- Rust contains only agent-side terminal new/list/read/wait/send, progress, notify, ports, workspace, hook. Recognize but do not implement up/down/update/restart/status/doctor/logs/fda/uninstall; print a desktop-management message and fail.
- npm CLI remains for Linux/headless and is behavioral reference, untouched here.
- No Intel/Linux distribution work, protocol/server changes, or desktop code. Workspace build suffices; release matrix is future work.

## Decisions & tradeoffs

- **Independent crates/cli with binary cofluxd**, add Cargo workspace and explicit CI test/build lists (:148,153). Rejected: worker subcommand/symlink obscures argv dispatch and repeatedly starts a 30 MB worker; renaming coflux breaks plugin/SKILL hardcoded calls. Evidence: Cargo.toml:6 and hook/SKILL consumers.
- **Match Node command-by-command**, request bodies/endpoints/status/stdout. CLI cmdTerminal:1018, notify:1082, progress:1089, workspace:1106, ports:1145, hook:884, agentPost:986; POST loopback gateway env/default 8788 /agent, hooks /hook at :927. Worker recognizes only those paths (:160-161). Existing black-box output assertions must pass with Rust; preserve SKILL-referenced phrases such as `已开终端 <taskId>` literally. Rejected: redesign output and force three dependent surfaces to change.
- **Management commands explicitly refuse with exit 2**, directing to Coflux.app, rather than unknown-command response. Truly unknown commands retain Node usage/status. No fallback searching for npm CLI behind prepended PATH.
- **No new TLS/async HTTP stack.** Only plaintext loopback POST; prefer existing worker dependencies or minimal std::net::TcpStream HTTP/1.1. Size/build time matter for bundled signing/notarization and frequent invocations. Reject reqwest/hyper/TLS/runtime overhead for this call.
- **Prepend PATH after copying inherited environment**, at sessions.rs:817-827 near coordinate injection. Use supervisor-resolved home (main:95), not literal ~/.coflux. Empty PATH becomes only bin; other segments retain order. Apply all platforms. Appending leaves npm dominant; macOS-only branching adds needless platform test differences.
- **Version file contains raw SUPERVISOR_VERSION plus newline**, tag such as v0.32.0 or dev. Follow silent/nonpanicking fda::write_status startup style (main:37-40,98; fda:22-25). Reject executing binary --version: unsupported and reports on-disk rather than running binary.
- **Client contract**: authorizeDevice(token:string): Promise<{ok:true}|{ok:false;error:string}>. Send deviceAuthorize; deviceAuthorized succeeds, deviceAuthorizeInfo.ok=false returns error. Logged-out/unready fails immediately, never hangs. No info query needed for a local device without a card. Reject main-process duplicate WS/auth or new server messages; existing one-time/account-bound semantics fit.
- **Extend existing black-box acceptance without changing semantics**: PATH/version near session-env assertions; run existing agent command cases with Rust too or parameterize CLI path, following supervisor/worker override precedent in harness:302-304 and pretest build. These are acceptance, not milestone checks.

## Direction

Three independent work packages: M1 CLI/Cargo/CI, M2 supervisor, M3 client. Only M1 modifies Cargo.lock; M2 adds no dependencies. Black-box additions belong to M1/M2 in different files.

### Milestone 1: Rust agent cofluxd

Build target/debug/cofluxd with Node-equivalent requests/output/status in real terminal/gateway context; explicit management refusal, useful help/no-argument usage. Test pure parsing/body/formatting. Add crate to CI.
Validation: cargo test/build -p coflux-cli exits 0 and binary exists.

### Milestone 2: PATH and version

Every new session prepends home/bin, retaining remaining order. Startup version file equals handshake. Pure PATH tests cover empty, already included, multiple segments.
Validation: supervisor tests pass.

### Milestone 3: Client authorizeDevice

Awaitable success/failure/disconnected results; fake transport feeds both response messages.
Validation: all client tests pass.

## Landmines

- PATH override must follow std::env copy or it is overwritten. Six COFLUX_* names are additive-only agent contracts; do not disturb them.
- SUPERVISOR_VERSION also determines builtin worker version, parsed SemVer or literal builtin. File must preserve raw string for 113 comparison, not derived builtin form (main:132-141).
- Preserve specialized Node errors for missing ownership/outside-session. Rust runs as shell child, allowing PID ancestry; do not insert intermediate fork/request process that breaks identity chain.
- Historical hook description here says cmdHook forwards stdin JSON to /hook and response JSON to stdout with COFLUX_HOOK_DEBUG. Preserve actual Node behavior and quiet failures: hooks exec CLI, so failures/noise become visible host hook errors; wrapper's command-v fallback does not swallow executed hook failure.
- Invalid gateway port follows Node's fixed-port-location error; port 0 means dev/test random port. Tests may use nondefault gateway.
- Session-env third path currently invokes node CLI; test Rust in the same stack/terminal, not another stack sharing PORT 8870.
- Release RUSTFLAGS=-D warnings requires warning-free new crate.

## Scope

In scope:
- New crates/cli, Cargo manifests/lock
- Supervisor sessions/main and needed modules/tests
- Client store/method/tests
- CI explicit crate lists
- Session-env/agent-control tests and harness CLI override if needed
- Optional brief CLI/root README explanation

Out of scope:
- Node CLI/source SKILL/plugin, zero-change product rule
- Proto/server, existing messages suffice
- Desktop/release workflows, 113/future work
- Worker endpoints

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust tests | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0 |
| Rust build | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay -p coflux-cli` | exit 0; target/debug/cofluxd exists |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Dependent desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Full acceptance | `pnpm -C tests test` | exit 0 with OrbStack/Docker PG 5432; three installed-Coflux presence false failures unrelated |

## Done criteria

- [ ] All commands pass.
- [ ] In a coflux terminal, `target/debug/cofluxd` terminal new/list/read/wait/send, progress, notify, ports, workspace, and hook match Node request bodies, output phrases, and exit codes. Management commands such as status/up explicitly fail with nonzero exit.
- [ ] New supervisor sessions start PATH with `<COFLUX_HOME>/bin`; `<COFLUX_HOME>/supervisor-version` exists and matches the reported version.
- [ ] All three outcomes of `@coflux/client` `authorizeDevice(token)` are awaitable and unit-tested.
- [ ] Meaningful tests cover the pure PATH function, CLI arguments/output, all three client outcomes, and each black-box path.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] Index updated.

## STOP conditions

- Existing messages/dispatch or /agent /hook paths no longer match cited facts.
- Worker/plugin or other out-of-scope changes needed.
- Validation fails twice after one reasonable fix.
- Assumptions fail, such as Rust shell-child ancestry not identifying session.

## Maintenance notes

- During coexistence both binaries are cofluxd: prepended PATH selects Rust in Coflux terminals, npm in user terminals. Add agent commands to both; Node remains phrase truth distributed with SKILL.
- Daemon release matrix/manifest inclusion is deferred. 113 builds in desktop pipeline; npm update installing Rust for Node-free Linux is future work.
- supervisor-version is 113's raw one-line text contract; inspect desktop reader before changing format.
- Supervisor changes require cofluxd update && cofluxd restart, ending local sessions. Existing terminals before upgrade lack prepended PATH and still resolve npm, as expected.
