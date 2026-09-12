# Plan 20260912-executor-reconcile: Reconcile the executor engine branch with main 1.0.0

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat fffa3ff..HEAD -- crates/cli/src crates/worker/src/agent_ctl.rs crates/worker/src/agent_ctl crates/worker/src/hook.rs apps/desktop/src/main apps/desktop/src/renderer/components/workbench packages/cli/coflux.mjs packages/cli/skills/coflux/SKILL.md integrations/claude-plugin docs/architecture.md plans/README.md tests/src`
> (Run it against the branch tip *before* the merge in Milestone 1; after the merge the diff against `fffa3ff` is expected to be large because it contains main itself.)

## Status

- Priority: P1
- Effort: M
- Risk: MED (a merge across two large refactors plus a lifecycle re-wire; every architectural decision of the original plan was re-verified and still holds)
- Depends on: none (the original executor plan is DONE on this branch; it is relocated by this plan as `wiki/plans/20260912-executor-engine.md`)
- Category: refactor
- Execution: subagent opus (departure check recorded in dev:explore on 2026-09-12: continuous autopilot, no further confirmation; commit to this branch only; push, PR, merging into main and releasing remain the user's explicit call)
- Planned at: `fffa3ff`, 2026-09-12

## Requirement

Branch `dev/20260912-executor-engine` implements the built-in executor (formerly `plans/116-executor-engine.md`, 17 commits, marked DONE, unmerged). Since it branched at `dc506c9`, `main` has taken the 1.0.0 release and three refactors that the branch does not know about:

1. **Command split** (`f691874`): `cofluxd` is now the headless device-host entry point only; every agent and account operation lives under `coflux`, with no legacy forwarding. The branch still exposes `cofluxd executor run`.
2. **MCP removal** (`fc09c26`): the center MCP, its OAuth flow and the plugin's `.mcp.json` are gone. `packages/cli/skills/coflux/SKILL.md` was rewritten around "local commands + account CLI"; the plugin is at 0.12.0. The branch's SKILL still describes the MCP track and bumps the plugin to 0.11.0.
3. **English documentation policy and plan relocation** (`062df3f`, `AGENTS.md` "Language policy"; dev plugin 0.20 writes plans to `wiki/plans/YYYYMMDD-slug.md`): main's `plans/README.md` already uses number 116 for the test-cleanup plan, and all documentation is English. The branch's plan is Chinese and numbered 116.

The desktop quit flow also changed: `before-quit` now runs twice (first pass confirms with the user and `preventDefault`s; the second pass, with `quitting` set, disposes), and logout stops every local terminal. The branch calls `executorHost.shutdown()` on the first pass, so cancelling the quit dialog would still kill running executor jobs.

A trial merge (`git merge-tree`) reports 11 textual conflicts: `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/components/workbench/workbench.tsx`, `crates/cli/src/args.rs`, `crates/cli/src/main.rs`, `crates/worker/src/hook.rs`, `docs/architecture.md`, `integrations/claude-plugin/.claude-plugin/plugin.json`, both `SKILL.md` copies, `plans/README.md`, `pnpm-lock.yaml`.

Once this plan is done, the branch contains main, builds and tests green, and the executor works under the post-1.0.0 conventions:

- Inside a coflux terminal on the desktop machine, `coflux executor run --prompt="…" [--write] [--timeout <s>]` behaves exactly as `cofluxd executor run` did before (one-shot, blocks, prints the final reply and changed files; readable one-line errors). The npm `coflux` CLI accepts the same command with the same request bodies, stdout phrases and exit codes.
- Executor runs are cancelled with a definite terminal state exactly when the user explicitly stops the local runtime (quit confirmed, logout confirmed, panel "stop" or "remove" confirmed). Cancelling the quit dialog, a runtime restart, or a device-channel drop leaves running jobs alone.
- The SKILL (English, both copies identical) documents the executor within main's two-track structure; the plugin manifest is 0.13.0.
- The original plan lives at `wiki/plans/20260912-executor-engine.md` in English with its status; `plans/README.md` no longer lists a second 116; `wiki/plans/README.md` lists both the relocated plan and this one.
- Every newly added executor source file carries English comments.
- One black-box case proves the daemon-side path without a desktop host: submitting from a coflux terminal with no registered executor host fails immediately with a readable error and a non-zero exit.

Nothing about the executor's product behavior changes beyond the command name. The product conclusions and the Decisions of the original plan remain settled and are not reopened here.

## Decisions & tradeoffs

- **Integrate by merging main into the branch, not by rebasing**: `git merge main` once, resolve the 11 conflicts, then land the adaptation as ordinary commits on top. Rejected: rebase — 17 branch commits against ~30 main commits would replay the same conflicts up to 17 times, and the repository's history already uses merge commits for every plan (`530f2cb`, `89bf61a`, `56a1465`). Based on: `git log --oneline dc506c9..main`, `git merge-tree --write-tree --name-only HEAD main`.

- **The original plan's architecture stands; nothing is re-designed**: the three STOP-condition facts still hold on main — `runAsNode: false` (`apps/desktop/electron-builder.yml:22`), worker hot-upgrade via `Child::kill()` (`crates/supervisor/src/manager.rs:809`), reference-counted `retainDevice` with `measureOnly` lanes (`packages/client/src/device-router.ts:2312`). The `/agent` loopback endpoint, `AgentAction`, `resolve_scope` and `TerminalStatus` polling are unchanged (`crates/worker/src/hook.rs:160`, `crates/worker/src/agent_ctl.rs:84,206,583`). Rejected: reopening the daemon-hosted runner or a main-process DeviceRouter — nothing in main invalidates the recorded evidence.

- **The sandbox profile is not changed**: the tool profile's single `(deny network*)` rule blocks unix sockets as well as loopback TCP (measured; `apps/desktop/src/main/executor-sandbox.ts:19,103`), so main's two new sockets — `client.sock`, which proxies account operations with the app's login (`apps/desktop/src/main/client-broker.ts:7`), and `runtime.sock`, whose `stop` op ends every local terminal (`crates/supervisor/src/runtime_control.rs:49,108`) — are already unreachable from tool processes. Rejected: enumerating socket paths — the original plan rejected path lists for the same reason and nothing new needs one.

- **Executor command moves to `coflux executor run`; `cofluxd` gets nothing**: main's `cofluxd` refuses all operation commands and `coflux` has no legacy forwarding (`AGENTS.md` "Neither entry point forwards legacy commands"; `crates/cli/src/main.rs` HELP and `match`). `account::handles` routes only `login|logout|whoami|device|project`, `workspace list|new|rename|remove`, and `terminal|ports` with account flags (`crates/cli/src/account.rs:123-142`), so `executor` reaches the local `/agent` path untouched. The rewritten option tables (`crates/cli/src/args.rs` `STRING_OPTIONS`/`BOOL_OPTIONS`) gain `prompt` and `write`; the HELP phrase test `help_keeps_agent_phrases_used_by_skill_docs` gains `coflux executor run`. Rejected: keeping a `cofluxd executor` alias — it would be the only forwarding path in the product and contradicts the 1.0.0 contract.

- **The npm `coflux` CLI gets the same `executor` command**: `packages/cli/coflux.mjs` mirrors the Rust command — same `/agent` bodies (`executor.submit` with a stable `submissionId`, `executor.status`, `executor.cancel`), same polling shape, same stdout phrases and exit codes. Rejected: Rust-only — `AGENTS.md` and `tests/src/harness.mjs:305-307` define the two CLIs as per-command aligned, and the black-box suite drives the Node CLI by default; an npm user inside a coflux terminal would otherwise hit "unknown command" instead of the daemon's readable "no executor host" answer.

- **Executor cancellation follows the user's explicit runtime stop, and only that**: runs are cancelled (definite terminal state, tool process groups stopped, write lock released) when the local runtime stop is *confirmed* for `quit`, `logout`, `stop` or `remove`. The single choke point is `stopConfirmed(reason)` in `apps/desktop/src/main/daemon-manager.ts:158-166`; how the executor host is notified from there (callback option, event, or a call from `index.ts` after `stopForExit`/`logoutLocal` resolve true) is the executor's call, but every one of those four paths must reach it and the first, unconfirmed `before-quit` pass must not. Rejected: cancelling on `restart` or on device-channel loss — the original plan's reconcile design (no writer re-dispatch, `unknown` for unreported runs) depends on running jobs surviving transient loss, and `restart` is exactly that. Rejected: cancelling in the first `before-quit` pass — the user may cancel the dialog. Based on: `apps/desktop/src/main/index.ts:116-129` (two-pass quit), `:220-236` (`logoutLocal` calls `stopForExit("logout")`), `apps/desktop/src/main/daemon-manager.ts:173-186`.

- **Executor provider configuration survives logout**: `executor.json` and `executor-key.bin` in userData are global app configuration, not account state; `logoutLocal` must not clear them. Rejected: clearing with the account — the settings dialog is reached from the account menu but the original plan defines the configuration as "configured once per machine".

- **SKILL executor section is re-grafted, not re-merged**: take main's SKILL as the base, add `executor` to the local-commands table row and the frontmatter description, and re-insert the executor section rewritten for `coflux` (one-shot, no commit, tool processes offline, desktop-machine only, write the prompt as a brief). Delete every branch-side mention of MCP, `COFLUX_MCP_URL`, `cofluxd update && cofluxd restart` as a fix. Rejected: three-way merging the two SKILL bodies — the branch's base text no longer exists on main. Both copies must be byte-identical after `node scripts/sync-claude-plugin.mjs`; the plugin directory must contain no Chinese characters; `plugin.json` becomes `0.13.0` (main is `0.12.0`).

- **The original plan is relocated and translated, not rewritten**: `plans/116-executor-engine.md` becomes `wiki/plans/20260912-executor-engine.md`, a faithful English translation with the same sections, its command examples changed to `coflux executor run`, its status header noting the relocation, and a short "Reconciled with main 1.0.0" note pointing at this plan. `plans/README.md` keeps main's row 116 (test cleanup) and gains no executor row; `wiki/plans/README.md` gains rows for both plans. Rejected: renumbering to 117 in `plans/` — the dev plugin 0.20 convention and main's own newest plans use `wiki/plans/YYYYMMDD-slug.md`. Based on: `wiki/plans/README.md` on main, dev:write-plan step 4.

- **Comments in the 18 new executor files become English; behavior does not change**: `apps/desktop/src/main/executor-*.ts` (including tests, runner and runner protocol), `apps/desktop/src/renderer/components/workbench/executor-settings.tsx`, `use-executor-bridge.ts`, `crates/worker/src/agent_ctl/executor.rs`. User-facing strings (CLI HELP, error sentences, dialog copy) stay Chinese like the rest of main. Rejected: leaving them — `AGENTS.md` requires English for new or updated code comments, and these files are new to main. Rejected: translating pre-existing Chinese comments in files the branch merely touched — out of scope. Based on: `AGENTS.md` "Language policy".

- **The architecture note moves into main's English document structure**: main's `docs/architecture.md` now has 12 English sections and a "Desktop, CLI, and runtime" subsection under section 1. The executor note (why the process lives in the app, the push + upstream report path, truth in the main process, the sandbox tier "against mistakes, not adversaries") is rewritten in English and placed where the executor decides it reads best; the branch's Chinese "9.1" heading is dropped. Rejected: keeping a numbered 9.1 — main's section 9 is now "Port previews" and 10 is "Authentication and security boundaries".

- **(decided while planning) One black-box case, driven through the harness's coflux terminal**: a new `tests/src/*.test.mjs` with its own exclusive port asserts that `coflux executor run --prompt=…` from inside a coflux session terminal, with no registered executor host, exits non-zero within a few seconds and prints a readable sentence pointing at the desktop app. Whether it uses `CLI_BIN` (Rust) or the Node CLI, or both like `tests/src/cli-account.test.mjs`, is the executor's call. Rejected: a desktop-in-the-loop black-box test — the runner needs Electron and provider credentials; that is the user's manual acceptance.

## Direction

Milestones are sequential: M1 produces the merged tree everything else edits; M2 and M3 both touch `crates/cli` and the SKILL; M4 edits files M2 renamed commands in. Run as one work package.

### Milestone 1: Merged tree that builds

`main` is merged into the branch with all 11 conflicts resolved, `pnpm install` regenerates `pnpm-lock.yaml` (main dropped the MCP dependencies, the branch added `@earendil-works/pi-coding-agent@0.85.1` and two `allowBuilds` entries), and every executor path compiles against main's code. Conflict intent: `hook.rs` keeps main's `coflux` wording *and* the branch's three `executor.*` action arms; `main.rs`/`args.rs` take main's rewritten structure and add the executor command and options; `index.ts` takes main's lifecycle and re-attaches the executor host (final placement of shutdown belongs to M3, but nothing may run on the first `before-quit` pass); `workbench.tsx` keeps main's onboarding rewrite plus the branch's `useExecutorBridge` and settings dialog; `plans/README.md` takes main's version verbatim; SKILL and `plugin.json` conflicts are resolved in M4 but must not block the build. The merge commit message is English.

Validation: `pnpm install --frozen-lockfile` after regenerating -> exit 0; `cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli` -> exit 0 with zero warnings; `pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 2: `coflux executor run` on both CLIs

The Rust `coflux` binary and `packages/cli/coflux.mjs` both expose `executor run --prompt=… [--write] [--timeout <s>]` with identical request bodies, stdout phrases and exit codes; `cofluxd` exposes nothing executor-related; HELP texts and their phrase tests mention `coflux executor run`; no string in the repository still spells `cofluxd executor`.

Validation: `cargo test -p coflux-cli` -> exit 0; `git grep -n "cofluxd executor"` -> no output.

### Milestone 3: Lifecycle wired to confirmed runtime stops

Executor runs are cancelled to a definite terminal state on confirmed `quit`, `logout`, `stop` and `remove`, and are left running on a cancelled quit dialog, on `restart`, and on device-channel loss. Executor configuration files in userData survive logout. A pure-function or manager-level test covers the four-cancel / three-keep matrix without Electron.

Validation: `pnpm -C apps/desktop test` -> exit 0; `pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 4: Documentation, SKILL, plan relocation, English comments

SKILL re-grafted (English, both copies identical, plugin `0.13.0`, no Chinese in `integrations/claude-plugin`); the architecture note rewritten in English inside main's structure; `plans/116-executor-engine.md` moved to `wiki/plans/20260912-executor-engine.md` in English; `wiki/plans/README.md` lists both plans with status; the 18 new executor files carry English comments only.

Validation: `node scripts/sync-claude-plugin.mjs` -> exit 0 and `git diff --quiet -- integrations/claude-plugin/skills` afterwards; `grep -rlP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` -> no output; `grep -cP '[\x{4e00}-\x{9fff}]' <each of the 18 files>` -> only lines that are user-facing strings, none in comments; `test ! -e plans/116-executor-engine.md`; `pnpm -C apps/desktop build` -> exit 0.

### Milestone 5: Black-box coverage and full suite

The new black-box file exists with an exclusive port and passes; the full suite is green except the known false-red and flaky cases listed under Commands.

Validation: `node --import tsx --test tests/src/<new-file>.test.mjs` -> exit 0; `pnpm -C tests test` -> green except the listed exceptions.

## Landmines

1. **`hook.rs` conflict overlaps two unrelated edits**: main rewrote the module doc comment (`cofluxd`→`coflux`, `crates/worker/src/hook.rs:1-11,247`) and deleted a test; the branch added `submission_id`/`prompt`/`write`/`run_id` fields to `AgentBody` and three `executor.*` arms in `handle_agent`. Keep both; the Rust side has no other executor entry point.
2. **`crates/cli/src/main.rs` is rewritten on main**: `account::handles(&parsed)` is consulted before the command `match`; `is_managed_command`/`managed_refusal`/`migrated_hint` from the branch's base no longer exist. Re-add only the `"executor" => commands::run_executor(&parsed)` arm and the HELP block; do not resurrect removed helpers.
3. **`workbench.tsx` conflict is main's onboarding rewrite**: main replaced `shouldOfferOnboarding`/`readOnboardingDismissed` with automatic `client.authorizeDevice` (`apps/desktop/src/renderer/components/workbench/workbench.tsx:299-317` on main). The branch's contribution is two imports, one `useExecutorBridge(client, daemonState?.daemonId)` call, one `useState`, one Sidebar prop and one dialog element. `daemonState.daemonId` still exists (`apps/desktop/src/main/daemon-state.ts:20,53`).
4. **Two-pass `before-quit`**: the first pass calls `event.preventDefault()` and `daemonManager.stopForExit("quit")`; the quit proceeds only when the user confirms and `quitting` is set. Any executor teardown placed before that confirmation kills jobs on a cancelled dialog. The updater's `beforeInstall` also sets `quitting` and calls `quitAndInstall`, so the `quitting`-true pass is the common exit for both paths (`apps/desktop/src/main/index.ts:116-129,166-181`).
5. **`__dirname` is fine in the ESM main bundle**: electron-vite emits `__dirname = import.meta.dirname` in `out/main/index.js`; the branch's `join(__dirname, "executor-runner.js")` works. Do not "fix" it.
6. **`pnpm-lock.yaml` cannot be hand-merged**: take either side and run `pnpm install`; then verify with `--frozen-lockfile`. `pnpm-workspace.yaml` `allowBuilds` needs the branch's `@google/genai: false` and `protobufjs: false` — pnpm 11 treats an unanswered build script as an install failure.
7. **Black-box port discipline**: pick an unused port with `grep -h "PORT = " tests/src/*.test.mjs | sort -t= -k2 -n`; recent files use 88xx. The harness starts the Rust supervisor directly and never the installer; `CLI_BIN` is `target/debug/coflux` built by `pretest`.
8. **SKILL is generated into the plugin**: edit only `packages/cli/skills/coflux/SKILL.md`; `node scripts/sync-claude-plugin.mjs` copies it; CI compares both. The plugin directory must contain no Chinese characters (checked by tests).
9. **Bash guard in this worktree**: the coflux session guard blocks `git worktree add/remove/move`, and compound forms like `git -C ..`, `$(git …)`, heredocs containing worktree-removal wording. Use single commands from the worktree root, `git commit -F <file>` for messages, and the Edit/Write tools for files. `set -e` does not take effect in the Bash tool's zsh; chain with `&&`.
10. **Known false-red tests on this machine**: agent-activity presence/hook cases fail whenever a real `claude` process is running (process-tree detection) and can hang the suite; auto-update / local-first / signed-upgrade are occasionally flaky (one red, two green = flaky); `cofluxd doctor` two cases are environment-baseline failures. Do not change thresholds or tests for them.

## Scope

In scope:
- Merge of `main` into `dev/20260912-executor-engine` and conflict resolutions in the 11 listed files
- `crates/cli/src/{args,main,commands}.rs`, `packages/cli/coflux.mjs`
- `crates/worker/src/hook.rs`, `crates/worker/src/agent_ctl/executor.rs` (comments only)
- `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/daemon-manager.ts` (stop notification only), `apps/desktop/src/main/executor-*.ts`, `apps/desktop/src/main/executor-runner*.ts`
- `apps/desktop/src/renderer/components/workbench/{workbench.tsx,executor-settings.tsx,use-executor-bridge.ts}`
- `packages/cli/skills/coflux/SKILL.md` and its synced copy, `integrations/claude-plugin/.claude-plugin/plugin.json`
- `docs/architecture.md`
- `plans/README.md` (take main's), `plans/116-executor-engine.md` (delete via move), `wiki/plans/20260912-executor-engine.md`, `wiki/plans/README.md`, this plan
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- One new file under `tests/src/`

Out of scope:
- `proto/**` and generated bindings — unchanged by main; no protocol change
- `apps/desktop/src/main/executor-sandbox.ts` profile rules — `(deny network*)` already covers the new sockets
- Translating Chinese comments in files that predate the branch
- The desktop floating executor window (second slice), remote-daemon executors, executor commits, tool networking — excluded by the original plan
- Pushing, merging into `main`, tagging or releasing (`v*`, npm, plugin marketplace) — the user's decision

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Rust tests | `cargo test -p coflux-protocol -p coflux-cli` | exit 0 |
| Daemon + CLI build | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli` | exit 0, zero warnings |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| SKILL sync | `node scripts/sync-claude-plugin.mjs && git diff --quiet -- integrations/claude-plugin/skills` | exit 0 |
| Plugin language | `grep -rlP '[\x{4e00}-\x{9fff}]' integrations/claude-plugin` | no output |
| Legacy command name | `git grep -n "cofluxd executor"` | no output |
| New black-box file | `node --import tsx --test tests/src/<new-file>.test.mjs` | exit 0 |
| Full black-box (acceptance) | `pnpm -C tests test` | green except agent-activity presence/hook false-reds, occasional auto-update/local-first/signed-upgrade flakes, and the two `cofluxd doctor` baseline failures |

## Done criteria

- [ ] All listed commands pass (acceptance row within its stated exceptions).
- [ ] `git merge-base --is-ancestor main HEAD` succeeds: main is contained in the branch.
- [ ] `coflux executor run --prompt=… [--write]` is accepted by both the Rust and Node CLIs with identical phrases and exit codes; `cofluxd` has no executor command.
- [ ] Executor cancellation happens on confirmed quit/logout/stop/remove only; a cancelled quit dialog, `restart` and channel loss keep jobs running; a test asserts this matrix.
- [ ] Executor configuration in userData survives logout.
- [ ] SKILL both copies identical and English; plugin manifest `0.13.0`.
- [ ] `wiki/plans/20260912-executor-engine.md` exists in English; `plans/116-executor-engine.md` does not; `wiki/plans/README.md` lists both plans.
- [ ] The 18 new executor files contain no Chinese comments.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular `runAsNode: false`, `Child::kill()` hot upgrade, `retainDevice` reference counting, `(deny network*)` blocking unix sockets, or `stopConfirmed` being the single stop choke point.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The merge produces conflicts outside the 11 listed files that cannot be resolved by taking main's side for unrelated regions.
- pi 0.85.1 no longer loads inside `utilityProcess` after the merge (Electron or Node version moved) — report, do not switch to a daemon-hosted runner.

## Maintenance notes

- The two CLIs are per-command aligned by convention and by black-box tests; any future executor flag must land in `crates/cli` and `packages/cli/coflux.mjs` together.
- Executor cancellation is bound to `stopConfirmed`; if the daemon manager grows a new stop path, route it through the same choke point or the "explicit stop cancels, transient loss does not" contract silently breaks.
- Plans now live in `wiki/plans/` with date-slug names; `plans/` is a closed, numbered archive. Do not add new numbered plans there.
- The sandbox's socket coverage rests on a single `(deny network*)` rule. If that rule is ever relaxed (for example to allow a download proxy), `client.sock` and `runtime.sock` must be denied by path explicitly — they can end terminals and run account operations.
