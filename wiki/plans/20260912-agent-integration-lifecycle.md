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
The main worktree was clean before creating this worktree. Plan commit: `6e22eff`.

### Implementation

- Native `coflux agent run/prepare/hook/status` embeds the shared skill and generates
  a full-content-checked immutable bundle. Each agent pins its hooks and CLI.
- zsh/bash/fish resolve the stable device CLI at every invocation; aliases and
  functions remain user-owned. Supervisor supplies the authoritative COFLUX_HOME.
- Claude loads a session plugin; Codex loads session hooks with a skill-file pointer.
  Both preserve native host arguments and need no additional interpreter.
- Hook acknowledgement and local API compatibility determine readiness. Context is
  refreshed on start/resume/compact and workspace changes without repeating unchanged
  prompt context. Delayed approval can recover on the next prompt.
- CLI release artifacts use a separate signature domain. macOS/Linux release jobs
  build the CLI; cofluxd verifies all supplied artifacts before replacing them.
  Older two-artifact releases remain compatible with the installer.
- Desktop already updates the stable CLI atomically when retaining its running
  runtime; the new launcher makes that existing path update integration as well.
- External skill delivery was synchronized and its Claude plugin version incremented.
  No marketplace publication or builder update was performed.

### Validation

- Zero-warning build: CLI, supervisor, worker and relay.
- Rust tests: CLI 28, protocol 41, supervisor 73; all pass.
- Server typecheck and desktop typecheck: pass.
- Desktop tests: 89/89; desktop build: pass.
- Skill synchronization check: pass.
- Full black-box suite, concurrency 2: **215/215 pass**, 231 seconds, no skips.
  This includes new native hook/immutability and three-artifact installer tests.
- `python3 tests/acceptance/agent-launch.py`: pass. Same live shell observes a
  replaced launcher; previous bundle bytes and executable remain usable; arguments,
  bypass and damaged-bundle fallback are preserved. Available zsh/fish entry points
  are checked too.
- `python3 tests/acceptance/agent-hosts.py`: pass against Claude Code 2.1.269 and
  Codex CLI 0.154.0, in disposable homes with a loopback synthetic provider.
  Actual model requests contain current context after native approval, resume and
  compaction. Unrelated Codex user hooks remain active. A changed executable creates
  a new delivery identity, requires native review again and injects context afterward.
- Native compaction detail: Codex runs compact-source SessionStart immediately before
  the next model request, not at the moment its UI displays “Context compacted”.
  The probe verifies that continuation request. Claude's native `/compact` emits
  compact_boundary and runs another SessionStart.
- Initial baseline concurrency-4 signed-upgrade failures were not reproduced in its
  isolated 9/9 rerun or the concurrency-2 213/213 baseline. No unrelated fix was made.
- Diff and scope reviewed; no production, global agent settings or old Codex plugins
  were modified. Real Linux execution and publication are not claimed; release
  workflow changes and signed installer fixtures are validated locally.

### Operational boundaries

The first rollout needs a new-wrapper shell (or explicit `coflux agent run`). A shell
running the pre-integration function cannot acquire a new function retroactively.
Once installed, the wrapper supports later updates from already-open shells.
Existing bundles are retained deliberately; deletion belongs to explicit device
uninstall after agents have stopped. Readiness is exposed through terminal guidance
and `coflux agent status`, independently of work activity. Details and commands are
in `docs/agent-integration.md`.

The user owns old Codex plugin management; removal, migration and coexistence with
those old plugins are excluded. No push, PR, merge or release was performed.
