# Plan 20260912-agent-integration-lifecycle: Device-managed agent integration

> Outcome contract. Design against live code, validate the behavior below, and stop when a named assumption is disproved.
> Drift check: `git diff --stat 062df3f..HEAD -- crates apps/desktop packages integrations proto scripts tests .github`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: none (existing desktop lifecycle is the baseline)
- Category: feature
- Execution: self
- Planned at: `062df3f`, 2026-09-12
- Current state: IN_PROGRESS; user removed legacy Codex plugin migration/coexistence from scope. New integration loading and update behavior remain in scope.
- Authorization: automatically commit this plan and implement after a clean-tree check; no push, PR, merge, release, or production changes. Use this isolated worktree.

## Requirement

Coflux-managed terminals on macOS and Linux automatically provide Claude Code and Codex with Coflux capabilities and current context. Ordinary shell invocation and any dedicated launch entry share this behavior. External terminals retain optional marketplace integration. Preserve native agent commands and user configuration, including an explicit bypass.

Every agent launch selects an integration compatible with the running local runtime, including launches from shells opened before an update. Running agents keep immutable integration files until exit. Resume and compaction refresh current coordinates without changing the pinned integration version mid-process.

Codex native hook review remains intact. Unreviewed hooks do not prevent ordinary agent use; integration is explicitly unready. Do not infer pending review solely from missing hook events. Readiness and work activity are distinct. Show concise failure/unready guidance in the terminal and expose verifiable integration status through Coflux. Do not expose internal version-selection terminology in normal product copy.

## Decisions & tradeoffs

- **Device-owned delivery**: distribute complete integration with Coflux releases on both desktop and headless hosts. External marketplaces are optional distribution, never the internal update dependency. Based on `packages/cli/package.json:11` (currently only skills) and `apps/desktop/src/main/daemon-manager.ts:140` (existing runtime returns before staging).
- **Per-launch selection, per-process pinning**: resolve a compatible immutable bundle at agent launch; retain referenced old files. Reject a mutable plugin root whose hooks change under live agents. Based on `apps/desktop/src/main/desktop-runtime.ts:84` and `crates/supervisor/src/shell/claude.sh:14`.
- **Host adapters, shared behavior**: share CLI capabilities and concise context data, but validate Claude and Codex loading, native review, event semantics, independently. Codex `--config` and inline hooks/local marketplaces are candidates, not proof of a working session adapter. Based on official https://developers.openai.com/codex/config-reference and https://learn.chatgpt.com/docs/hooks, inspected during exploration; installed Codex reported 0.154.0.
- **Native trust and existing configuration**: never bypass hook trust, replace CODEX_HOME in production, overwrite global settings, or suppress unrelated plugins. Legacy Codex plugin removal and coexistence are explicitly user-owned and out of scope (user clarification after initial probes). Do not suppress or migrate old Codex plugins.
- **No extra runtime dependency**: built-in hooks use shipped executable capabilities, not a separately installed Node interpreter. Existing `.mjs` worktree hooks contradict desktop zero-install behavior (`integrations/claude-plugin/hooks/hooks.json`).
- **Separate readiness**: running/approval/done are activity, not integration installation state (`proto/coflux/v1/common.proto:105`). Absence of a handshake means unconfirmed, not necessarily awaiting review.
- **Minimal injection**: current session/working-directory facts, capability entry, pinned integration identity and skill pointer; no entire skill in every prompt. Resolve stale worktree coordinates through existing local APIs.
- **Single source and unified release**: shared instruction source and adapter assets are verified during packaging. Compatibility must account for retained runtime/CLI and agent version, not merely the desktop version. Full content integrity matters; manifest-only hashes miss changed scripts.

## Direction

Milestones are sequential: host feasibility precedes the launch contract; delivery precedes real update acceptance. Self execution, no delegation.

### Milestone 1: Host-loading feasibility

Demonstrate native Claude and Codex session integration without writing real user config or calling real models. Isolated homes and fake local model endpoints are allowed for acceptance. Demonstrate native review behavior and new integration loading. A disproved no-global-configuration assumption is a STOP, not permission to silently change the product boundary.
Validation: existing script suite and `node scripts/sync-claude-plugin.mjs --check` exit 0. Record real-host evidence separately below.

### Milestone 2: Per-launch integration and complete device delivery

Both hosts resolve immutable compatible integration on each invocation. Shipped hooks need no extra interpreter. Desktop and npm installation/update paths publish complete assets without stopping the runtime. Old shells see the next version on next launch, existing agents retain the old one. External optional installation remains coherent.
Validation: meaningful isolated launch/update/compatibility and packaging tests; `cargo test -p coflux-cli -p coflux-supervisor`; relevant TS checks exit 0.

### Milestone 3: Observable readiness and end-to-end acceptance

Readiness is grounded in an actual integration acknowledgement and has a distinct unknown/unavailable state; native review guidance does not guess why hooks are absent. Test start/resume/compact and worktree context on both hosts. Document supported shells, version floors, bypass, migration, retention, and update behavior.
Validation: desktop unit tests and typecheck, protocol tests where changed, whole black-box suite, real-host acceptance.

## Landmines

- Desktop `start()` currently refreshes only CLI if runtime already exists (`daemon-manager.ts:140`), yielding a new CLI with old hooks/runtime.
- Existing plugin identity hashes only the manifest (`desktop-runtime.ts:90`); changed content under an unchanged manifest can reuse stale files.
- Shell aliases/functions currently win over injected wrappers (`shell/claude.sh:14`); unknown shells skip injection (`sessions.rs:854`). Do not silently promise support for bypasses or unsupported hosts.
- Codex hooks merge across sources and require trust of the current definition. Version paths can change hook identity and prompt review again. Preserve review rather than hiding changed executable behavior behind an unchanged trusted command.
- The user will handle old Codex plugins; their behavior must not block or expand this implementation.
- Existing hook tests use fake CLI executables; they prove scripts, not host lifecycle integration.

## Scope

In scope: `crates/{cli,supervisor,worker,protocol}/`, `apps/desktop/`, `packages/{cli,client,protocol}/`, `proto/`, `integrations/`, `scripts/`, `tests/`, `.github/workflows/`, root build/package metadata when required for these assets, `docs/`, `README.md`, `wiki/plans/`.
Out of scope: production deployment, release publication, marketplace publication/builder repository edits, other agents, frozen web/native clients, agent Terminal interception, changes to real user agent settings, automatic agent installation, legacy Codex plugin cleanup/coexistence/migration.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Existing hooks | `node --test tests/src/claude-plugin-*.test.mjs` | exit 0 |
| Skill sync | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Rust units | `cargo test -p coflux-cli -p coflux-supervisor -p coflux-protocol` | exit 0 |
| Build | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli -p coflux-relay` | exit 0, no warnings |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Black-box (acceptance) | `pnpm -C tests test` | exit 0 |
| Real hosts (acceptance) | isolated Claude/Codex launch, trust, update, resume/compact probes | record versions, observations and limits; no real user config mutation |

## Done criteria

- [ ] Both hosts load the right bundle inside Coflux without global configuration changes.
- [ ] Native Codex review and unavailable/unknown status are accurately represented.
- [ ] Mac/Linux packages include everything needed; old shells use updates on next agent launch.
- [ ] Active agents preserve immutable old integration and compatible CLI behavior.
- [ ] New integration does not inject duplicate context/events of its own; old Codex plugins remain user-owned.
- [ ] Meaningful tests and all required checks pass; real host acceptance documented.
- [ ] Full diff reviewed, scope checked, no temporary probe artifacts remain.
- [ ] Index updated to DONE only when all outcomes hold.

## STOP conditions

A cited architectural fact is false; host session loading requires changing global user configuration or bypassing native trust; an essential host lifecycle cannot be verified; a validation fails twice after one reasonable fix; required work falls outside scope. Record evidence and remaining work, do not claim completion or substitute a reduced product.

## Maintenance notes

Exact loader mechanics, filenames, retained-version collection, event schema and UI placement are implementer choices subject to the contracts above. Re-verify host behavior when its version changes. Advisor tier fable was unavailable in this environment; no advisor review is claimed.

## Execution evidence (2026-09-12)

Worktree: `/Users/wsq/Workspace/coflux/.claude/worktrees/20260912-agent-integration-lifecycle`.
Branch: `dev/20260912-agent-integration-lifecycle`. Baseline: `062df3f`.
The main worktree was clean before creating this worktree.

### Successful checks

- `pnpm install --frozen-lockfile`: successful, lockfile unchanged.
- `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli -p coflux-relay`: exit 0, no warnings, 67 seconds.
- Server `tsc --noEmit` and desktop `typecheck`: exit 0.
- Earlier exploration ran all four plugin script files: 33/33 passed; skill synchronization passed.

### Codex host feasibility

Installed host: `codex-cli 0.154.0`. Claude was detected as `2.1.269`; Claude lifecycle acceptance was not performed after the Codex blocker.

All probes used disposable temporary directories and a subprocess-only isolated environment. They did not read real account credentials or change real user configuration. A local HTTP server captured only synthetic requests and deliberately returned HTTP 400 with `Intentional local probe stop`, so no model was invoked. All temporary probe files and processes were removed.

1. `codex app-server --stdio -c 'hooks.SessionStart=[{hooks=[{type="command",command="/bin/echo COFLUX_PROBE",timeout=2}]}]'` followed by `initialize` and `hooks/list` showed `source=sessionFlags`, `isManaged=false`, `trustStatus=untrusted`. Session hook discovery and native review are supported.
2. `-c 'skills.config=[{path="<bundle>/coflux",enabled=true}]'` did not discover a skill outside standard roots. The option is enablement, not a demonstrated additional skill search root.
3. Session `marketplaces.*` and `plugins.*.enabled=true` flags alone did not discover the local bundle's skills/hooks, including after `thread/start`. No config file or cached plugin was produced.
4. A synthetic local marketplace was installed into the disposable Codex home with `codex plugin add coflux@coflux-runtime --json`. It contained a skill with description `LEGACY_COFLUX_CONTEXT_SENTINEL` and a benign SessionStart hook. The normal app-server listed its hook and skill.
5. Restarting app-server with `-c 'plugins."coflux@coflux-runtime".enabled=false'` still listed the hook as enabled and still discovered the skill. The config file remained byte-identical.
6. To exclude a listing-only issue, two actual `codex exec --skip-git-repo-check --ephemeral --json 'Say okay.'` invocations used a synthetic `probe` model provider pointing at `127.0.0.1`, first normally, then with the same disable flag. **Each made one local request, and each request contained `LEGACY_COFLUX_CONTEXT_SENTINEL`.** Both terminated on the expected local HTTP 400. The config file remained byte-identical.

Conclusion: the candidate session-flag plugin loading/suppression path is disproved for this host. This is not proof that every possible Codex adapter is impossible. It is insufficient to ship a duplicate-free adapter under the approved no-global-configuration boundary. Do not fall back to replacing CODEX_HOME, writing user config, suppressing every plugin, or bypassing trust without revisiting that boundary. Native profile files live under CODEX_HOME and profile names cannot be arbitrary paths according to https://developers.openai.com/codex/config-advanced; they are not a demonstrated external immutable config overlay.

### Baseline acceptance failure

The complete unmodified black-box suite finished in 258.7 seconds: **213 tests, 211 pass, 2 fail**. No tests were cancelled or skipped.

- `tests/src/signed-upgrade.test.mjs:212`: concurrent remote upgrades, assertion `新请求先完成并提交`, actual false, expected true.
- `tests/src/signed-upgrade.test.mjs:223`: anti-rollback persistence, assertion `重启后恢复已提交 release`, actual false, expected true. This test follows the failed version-commit test and may be dependent fallout; that causal link was not proven.

The suite exited 1. No source fixes or reruns were attempted because the host-feasibility STOP had already been reached. These are baseline failures, not regressions from this work. No worktree-specific server/daemon processes remained after harness cleanup.

### Handoff state

Plan and index are intentionally uncommitted: repository commit policy requires a green full suite. Product implementation has not begun. Resume by revising/verifying the Codex adapter candidate and resolving or explicitly accounting for the baseline failures; all previous product decisions and Self/autopilot authorization remain in force. No further general permission confirmation is required.

### Scope correction from the user

The user explicitly stated that they will handle old Codex plugins. Legacy suppression, migration and coexistence are removed from acceptance and must not block new integration. The failed suppression probe remains historical evidence only. Resume new-plugin loading and update implementation under existing Self/autopilot authorization.

### Resumed validation

- Signed-upgrade baseline rerun alone with debug logging: 9/9 pass (27.8 s).
- Full baseline rerun with concurrency 2: 213/213 pass (199.4 s). Initial parallel failure is not treated as a reproduced product defect.
- Native Codex TUI, isolated config and benign `/bin/echo` hook: displayed `Hooks need review`; selecting native `Trust all and continue` saved a trusted hash under `hooks.state` and continued normally. Coflux does not write trust records.
- Implementation choice: Codex built-in integration uses session-level hooks and a pointer to the immutable shipped skill file, rather than requiring a globally installed plugin or adding a skill discovery root. The external plugin remains optional.
