# Plan 035: cofluxd command surface redesign + doctor connectivity self-test

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 2e2e92a..HEAD -- packages/cli/cofluxd.mjs README.md tests/src/`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: plans/033-worker-connection-resilience.md (DONE), plans/034-remove-enroll-key.md
- Category: dx
- Execution: subagent sonnet
- Planned at: `2e2e92a`, 2026-07-23

## Requirement

cofluxd was the product’s earliest component. Its nine-command surface (onboard/up/reload/update/status/fda/logs/down/uninstall) no longer matches current usage. The user requested a redesign on 2026-07-23:

- After enrollKey removal in plan 034, onboard’s only interactive question is the device name, which does not justify a separate command. Argument-free `up` followed by browser authorization is the preferred setup flow.
- reload overlaps with up, which already reads and writes configuration, installs services, and restarts them.
- Incidents such as the half-open connection on 2026-07-23 leave users with only raw logs and no self-service diagnosis. Provide layered checks similar to tailscale netcheck.

True when completed (eight commands, Tailscale-like mental model):

1. Make `cofluxd up` idempotent: on first use, install, start, and wait for browser authorization; when already installed, reinstall the service from current settings.json and restart it, absorbing reload. Remove `cofluxd onboard` and `cofluxd reload`. Running `cofluxd` without arguments enters up on first use and status once configured.
2. `cofluxd doctor` checks connectivity to the configured server_url layer by layer: DNS resolution → TCP connection → TLS handshake for wss → WS upgrade. Report success/failure and elapsed time for each layer, with actionable failure guidance (for example, DNS succeeds but TCP fails: check firewall/proxy blocking). Also summarize process liveness, conn-state.json, credential presence, and FDA.
3. Clarify in `cofluxd update` help and output that it updates only the supervisor binary; the server automatically hot-upgrades the worker, as established by plan 017.
4. Update the README’s user documentation to match the new command surface.

## Decisions & tradeoffs

- **Keep eight commands: `up/down/status/doctor/logs/update/fda/uninstall`; remove onboard and reload.** The user confirmed this in dev-explore on 2026-07-23, with the departure check passed. Rejected: retaining reload, whose behavior overlaps with idempotent up, or folding update into up, which the user did not select.
- **Idempotent up:** always ensure binaries exist, persist configuration, install/refresh the service definition, and restart the service. Do not redownload an existing version unless `--version`/`--bin-dir` is explicitly supplied. Preserve credentials.json so registered devices are not asked to authorize again. Existing `applyAndStart` (`packages/cli/cofluxd.mjs:172-191`) is close; its main mismatch is downloading latest on every up. Skip that download when binaries exist and no version was explicitly requested, so rerunning up does not silently upgrade.
- **Run doctor probes directly in the CLI without violating its zero-protocol principle.** That principle excludes application wire-protocol logic (`cofluxd.mjs:194` refers to registration/status), not transport checks. Use Node’s built-in `dns/net/tls` and a handwritten HTTP 101 upgrade request; parse no coflux protocol messages and disconnect after success. The unauthenticated probe has no side effects and is naturally reclaimed by the server’s 15s authDeadline. Rejected: implementing doctor in the daemon, which may itself be the failing component.
- **Read doctor’s target from serverUrl in settings.json**, falling back to the public service default when unset. Give each layer an independent timeout (5s recommended; the executor may adjust). If all transport checks pass but conn-state remains disconnected, direct the user to `cofluxd logs`: authentication/authorization, rather than networking, is the likely failing layer.
- **Do not introduce a CLI test framework.** Validate probe functions and command changes with `node --check` and orchestrator acceptance runs of doctor and the status/up/down lifecycle. Existing black-box tests do not cover cofluxd.mjs; keep that boundary. Optional lightweight tests under `tests/src/` are allowed if a probe warrants them. Rejected: a dedicated CLI testing system with disproportionate overhead.
- **Update the README together with the CLI.** Installation and usage must reflect the eight commands and browser authorization as the sole enrollment path. `README.md:26-33` currently mentions obsolete onboard and enroll-key behavior.

## Direction

Keep changes in `packages/cli/cofluxd.mjs`, the single-file zero-dependency Node CLI, and `README.md`. Preserve the recorded historical style: Chinese comments/output, `die`/`run` helpers, and no npm dependencies.

### Milestone 1: Reorganizing the command surface

Remove onboard/reload, give unknown-command migration guidance, make up idempotent, update no-argument dispatch, rewrite HELP, and clarify update output. Validation: `node --check packages/cli/cofluxd.mjs` → exit 0.

### Milestone 2: doctor

Implement layered probes, a summary of local state, and diagnostic conclusions. Validation: `node --check packages/cli/cofluxd.mjs` → exit 0; the orchestrator verifies correctly layered `cofluxd doctor` output in an acceptance run.

### Milestone 3: README Update

Align user documentation with the command surface. Validation: manual comparison by the orchestrator.

## Landmines

- `up` reuses `cmdStatus` (`cofluxd.mjs:185,203`), and plan 033 just added conn-state output. Preserve its synchronous interface and existing output during restructuring.
- `waitForAuthorization` (`cofluxd.mjs:195-217`) polls pending-auth.json written by the daemon. Rerunning up on an enrolled device must skip this wait, based on the presence of credentials.json; plan 034 has already removed the enrollKey condition.
- The differences between macOS `launchctl unload/load` and Linux `systemctl --user` have been encapsulated in `installService/restartService/stopService` (`cofluxd.mjs:150-170`)— doctor/up changes do not bypass this layer.
- `packages/cli` is the npm user entry point. Removing commands breaks existing invocations such as `cofluxd onboard`; HELP and errors must explain migration, for example, "onboard has been merged into up; run cofluxd up directly."

## Scope

In scope:

- `packages/cli/cofluxd.mjs`
- `README.md` (user side installation/usage section)
- `tests/src/` (optional lightweight detection function use case)

Out of scope:

- `crates/`, `apps/`, `packages/{protocol,core,client}` — this plan is purely CLI
- npm package publication - will be processed separately when the user explicitly requests it
- `docs/auth-design.md` —  plan 034 updated

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| CLI syntax check | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| Black-box testing without regression | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |
| doctor practice (acceptance) | `node packages/cli/cofluxd.mjs doctor` | Layered results + conclusions, each layer passes the production server |
| status operation (acceptance) | `node packages/cli/cofluxd.mjs status` | Contains connection status lines, no onboard/reload traces |

## Done criteria

- [ ] All listed commands pass.
- [ ] Exactly eight commands remain; `onboard`/`reload` report unknown commands with migration guidance.
- [ ] Rerunning `up` on a registered device is idempotent: no reauthorization or implicit binary upgrade.
- [ ] `doctor` reports accurate layered results and useful failure guidance.
- [ ] README consistent with new command surface.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- plan 034 is not DONE (this plan assumes that the enrollKey interface no longer exists).

## Maintenance notes

- The npm command surface is a public contract. Future command additions/removals are treated as breaking changes and must be documented in release notes.
- Doctor’s hierarchical order (DNS→TCP→TLS→WS) and failure direction copy are the core of troubleshooting UX. For subsequent new failure modes (such as enterprise proxy MITM certificates), just add pointers to the corresponding layer.
