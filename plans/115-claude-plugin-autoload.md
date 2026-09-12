# Plan 115: Automatically load the Coflux plugin for claude in Coflux terminals through app-provided environment and supervisor shell integration

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7deedfb..HEAD -- crates/supervisor apps/desktop/scripts/stage-daemon.mjs apps/desktop/src/main/daemon-files.ts apps/desktop/src/main/daemon-paths.ts apps/desktop/src/main/daemon-manager.ts apps/desktop/src/main/daemon-bundle.ts apps/desktop/electron-builder.yml apps/desktop/test/config.test.ts tests/src/session-env-injection.test.mjs integrations/claude-plugin/README.md crates/worker/src/agents.rs`

## Status

- Priority: P1
- Effort: M
- Risk: MED (intercepts Coflux terminals' shell startup chain; unusual user rc constructs may conflict. Desktop only adds one plist key and one resource directory.)
- Depends on: none (uses plan 112 session environment injection and plan 113 bundled desktop daemon, both already on main)
- Category: feature
- Execution: subagent (host general-purpose subagent, `model: opus`; 2026-09-11 dev:explore preflight records authorization to execute through completion immediately after planning, without further confirmation. Push/PR/merge/release still require explicit user requests.)
- Planned at: `7deedfb`, 2026-09-11

## Requirement

Today, giving Claude Code Coflux capabilities requires users to run `/plugin marketplace add myWsq/plugins` and install `coflux@plugins`, then manually run `/plugin marketplace update` for upgrades. Those capabilities include turn-state hooks, a SessionStart `<coflux-session>` coordinate block, the coflux skill, and central MCP. The user asked whether every claude launched inside Coflux could automatically register the plugin, removing manual installation.

After completion, typing `claude` in a Coflux terminal loads the plugin bundled with Coflux.app: hooks, the coflux MCP from `.mcp.json`, and the skill all work. It appears in `/hooks`, not `/plugin`, because `--plugin-dir` loads for a session rather than installing. The plugin updates with Coflux.app. Do not change any bytes under `~/.claude` or store plugin files in `~/.coflux`. Existing marketplace `coflux@plugins` users need no action: the same-named `--plugin-dir` plugin completely overrides the marketplace copy without duplicate hooks.

### Product conclusions (confirmed during exploration; do not ask again)

1. **Consumers and scope**: people typing `claude` in terminals opened by Coflux, including desktop, agent `cofluxd terminal new`, iOS, and central MCP. Their own iTerm/VS Code terminals are unaffected.
2. **No action required**: no settings, toggles, or onboarding. After installing Coflux.app and connecting locally via plan 113, terminals started after the next daemon startup carry the plugin.
3. **Fallback**: if the agreed variable is absent, empty, or points to a nonexistent directory, claude behaves exactly as before: no flag, message, or error. Clearing the variable is also the escape hatch.
4. **Non-goals**: Codex has no equivalent `--plugin-dir` and still uses marketplace installation. Agent Bash-tool `claude -p` subprocesses are not guaranteed the plugin because noninteractive shells skip rc. No Linux/npm distribution changes: npm cofluxd does not set the variable, though Linux users may set it in systemd to any plugin directory and use the same supervisor integration. Self-hosted MCP addresses remain unsupported: `.mcp.json` still hardcodes `https://api.coflux.dev/mcp`, as the marketplace copy does.
5. **Manual acceptance by the user, not Claude UI/real-machine walkthroughs**: update app, restart daemon, open a Coflux terminal, and type claude. SessionStart emits `<coflux-session>`, sidebar turn state responds, `/mcp` lists coflux, and `/hooks` contains its entries. `echo $COFLUX_CLAUDE_PLUGIN_DIR` points to `Coflux.app/Contents/Resources/daemon/claude-plugin`. Clearing the variable restores prior claude behavior in subsequent terminals.

## Decisions & tradeoffs

- **Load with `claude --plugin-dir <dir>` without writing Claude configuration.** Rejected: writing `extraKnownMarketplaces`/`enabledPlugins` in `~/.claude/settings.json` — persistent machine-wide changes affect non-Coflux terminals and user files, and documentation does not guarantee prompt-free local-marketplace installation. `CLAUDE_CODE_PLUGIN_SEED_DIR` only seeds cache and still needs enabledPlugins. Based on: official Claude Code plugins.md “Test your plugins locally” and plugins-reference.md. `--plugin-dir` is session-only, adds no trust prompt, loads hooks/.mcp.json/skills, is repeatable, and says “the local copy takes precedence for that session.” The env-vars reference contains no equivalent variable, checked via claude-code-guide on 2026-09-11.
- **The contract names only `COFLUX_CLAUDE_PLUGIN_DIR`, never a fixed path.** The injector chooses its value; daemon does not parse, validate, or persist it. Rejected: supervisor deriving `<COFLUX_HOME>/claude-plugin/current` — the user explicitly requested one variable name without one agreed address. Based on: `crates/supervisor/src/sessions.rs:826-828` copies the supervisor environment into sessions, so no new code is needed to deliver the variable to the shell.
- **Coflux.app injects through the LaunchAgent plist it already writes**: add `COFLUX_CLAUDE_PLUGIN_DIR` alongside `COFLUX_HOME` in `EnvironmentVariables`, pointing to the current app's absolute `Contents/Resources/daemon/claude-plugin` path. Rejected: copying the plugin to ~/.coflux at every startup, explicitly rejected by the user; including the path in desktop terminal-create requests misses agent/iOS/MCP terminals. Based on: `launchAgentPlist` in `apps/desktop/src/main/daemon-files.ts` already writes COFLUX_HOME; `daemon-manager.ts:220` writePlist is called by enroll (`:267`). Plan 113 uses launchd rather than app-forked hosting, leaving plist as the app-to-daemon environment channel.
- **When to write plist** (decided during planning): besides enrollment, compare rendered and on-disk plist at app startup. If different, for npm-enrolled devices, old apps missing the key, or moved apps, rewrite only the file. **Do not call launchctl or restart daemon.** The variable takes effect at the next supervisor start through Restart, boot, or plan 113 Restart and Update. Rejected: immediate reload terminates all local terminals and contradicts plan 113's never-auto-restart rule. Based on: launchd reads plist only on load; plan 113 product conclusion 4. Executor chooses comparison implementation. Change `apps/desktop/src/main/daemon-files.test.ts:37` from byte-identical npm plistXml to npm plus one COFLUX_CLAUDE_PLUGIN_DIR key; leave `packages/cli/cofluxd.mjs` plistXml unchanged. Enrollment detection at `daemon-state.ts:30`, checking plist and two binaries, stays unchanged; installations remain interchangeable.
- **Bundle the plugin byte-for-byte as app resources**: `stage-daemon.mjs` copies all of `integrations/claude-plugin` into `build/daemon/claude-plugin/`, including `.claude-plugin/`, hooks, scripts, skills, `.mcp.json`, README, and LICENSE without rewriting. Existing `extraResources: build/daemon → daemon` places it in app Resources. Do not add it to `mac.binaries`: Node/shell scripts are not Mach-O binaries and cannot be signed as such. Rejected: replacing the MCP URL with `${COFLUX_MCP_URL}` during staging — that creates a second plugin variant and attempts an out-of-scope self-hosting fix. Based on: `apps/desktop/electron-builder.yml:41-55`; `apps/desktop/test/config.test.ts:67-82` enforces agreement between stage script, daemon-paths constants, and builder config. Add the directory name consistently. Plugin contents must be English; `perl -ne 'print if /\p{Han}/'` must find nothing, already enforced by `tests/src/claude-plugin-session-context.test.mjs`.
- **Supervisor shell integration translates the variable into the flag, not a PATH shim or alias.** Follow VS Code shell integration: dispatch by shell basename. For zsh, point `ZDOTDIR` to supplied rc files; each `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin` first sources the user's original file, respecting preexisting ZDOTDIR or otherwise HOME. For bash, use `--init-file`, sourcing `/etc/profile`, `~/.bash_profile`, etc. in today's bash order as appropriate. For fish, use `XDG_DATA_DIRS` and `fish/vendor_conf.d`. Unknown shells, including COFLUX_SHELL wrapper scripts in black-box tests, receive no injection or warning. At the end define `claude()`: if the variable is nonempty and a directory, run `command claude --plugin-dir "$COFLUX_CLAUDE_PLUGIN_DIR" "$@"`; otherwise `command claude "$@"`. Preserve user arguments; repeated flags are supported. Rejected: a claude shim in `<COFLUX_HOME>/bin` — the user's `~/.zshrc:4` and `~/.zprofile:12` prepend ~/.local/bin, containing real claude, and shadow it. Rejected: replacing ~/.local/bin/claude — Claude documentation discourages this because it becomes externally managed and automatic update/cleanup stops. Based on: shell selection at `crates/supervisor/src/main.rs:110-114` (COFLUX_SHELL → settings.shell → SHELL → /bin/bash); `sessions.rs:815-825` starts `CommandBuilder::new(&shell)` without arguments.
- **Invariant: preserve current rc-chain semantics.** Load exactly the same files in the same order, adding only the final function definition. User rc errors remain user rc errors. Confirm whether current shells are login or non-login in live code and preserve that.
- **Invariant: directly execute real claude with `command claude`; no persistent wrapper process.** Based on: `crates/worker/src/agents.rs:16` recognizes agents by process name/argv basename matching claude. A forwarding shell function leaves the process tree unchanged.
- **Rc placement** (decided during planning): embed contents in supervisor, e.g. `include_str!` without dependencies, and idempotently write `<COFLUX_HOME>/shell-integration/` at startup. This is daemon-owned data like supervisor-version and fda-status. Rejected: per-session temporary directories as unnecessary; app-bundle writes because supervisor does not know its location and Linux has no app.
- **App updates replace bundled plugin in place, without versioned directories.** Existing claude sessions read new scripts through CLAUDE_PLUGIN_ROOT on their next hook, matching marketplace updates; acceptable.
- **Existing claude aliases/functions**: executor chooses whether to wrap or defer, but must never silently disable the user's definition. Record the tradeoff in Maintenance notes.

## Direction

M1 and M2 touch disjoint files: supervisor/tests versus desktop/plugin README. M2 does not depend on M1 output, so they may run in parallel. M3 documentation/index depends on both.

### Milestone 1: Supervisor shell integration conditionally adds --plugin-dir

In zsh/bash/fish Coflux sessions, `type claude` reports a function. With an existing directory variable, claude runs with `--plugin-dir <dir>`; empty or nonexistent values omit it. Preserve every user rc file and order; unknown shells remain unchanged. Unit tests cover basename dispatch and no wrapper injection, forwarding to original rc files including custom ZDOTDIR, and all three function branches in real `/bin/zsh -c`/bash using an argv-recording fake claude first in a temporary PATH. Add a black-box case to `session-env-injection.test.mjs`: daemon gets the variable and COFLUX_SHELL points to actual `/bin/zsh`, not the current wrapper; typing claude reaches the fake and records the plugin flag. Another session with an empty variable omits it.
Validation: `cargo test -p coflux-supervisor` → exit 0; `cargo build -p coflux-supervisor` → zero warnings.

### Milestone 2: Bundle plugin and inject the plist variable

Staging produces `build/daemon/claude-plugin/` byte-identical to integrations/claude-plugin (`diff -r` empty). Missing source fails staging, like a missing binary. Add a resource-directory constant to daemon-paths.ts, guarded against stage-script drift by config.test.ts. launchAgentPlist includes the variable with an absolute resource path resolved by daemon-bundle.ts. Startup only rewrites a differing plist without launchctl. Update daemon-files.test.ts to npm-plus-one-key equivalence. Unpackaged `electron .` retains daemon-bundle.ts's build/daemon fallback.
Validation: desktop typecheck, test, and build all exit 0.

### Milestone 3: Documentation and index

The English plugin README explains automatic app-provided `--plugin-dir` loading in Coflux terminals and marketplace installation only for outside sessions. Add stage inputs/plist key to desktop README/RELEASING; document the variable and shell integration near architecture's session environment injection; add the variable to CLI README's COFLUX_* table, noting npm does not set it. Record in plans/README Backlog: plan 112's PATH prepend is also shadowed by user rc, and local `which -a cofluxd` finds npm; prepending again at the end of shell integration could fix it, but remains undone.
Validation: `perl -ne 'print if /\p{Han}/' $(find integrations/claude-plugin -type f)` → no output; `git diff --check` → exit 0.

## Landmines

- `sessions.rs:826-828` copies the full environment before overriding TERM/PATH/COFLUX_*. Inject ZDOTDIR/XDG_DATA_DIRS afterward or inherited values overwrite them. Read the user's ZDOTDIR before overriding and pass it to injected rc so original files remain locatable.
- Existing `session-env-injection.test.mjs:173-190` sets COFLUX_SHELL to a `#!/bin/sh` wrapper that execs the real shell. Basename dispatch correctly treats it as unknown; new tests must not reuse it or weaken dispatch for it.
- `config.test.ts:67-82` asserts mac.binaries count equals DAEMON_BINARIES.length and stage text includes every binary. Plugin directories need a separate constant, never DAEMON_BINARIES.
- Preserve daemon-files.test.ts's byte-equivalence assertion for everything except the new key; do not delete the entire test.
- `daemon-manager.ts:220-227` follows writePlist with launchctl load/unload. Startup's rewrite-only path cannot call that combined function.
- Hook commands locate scripts through `${CLAUDE_PLUGIN_ROOT}`, expanded by Claude Code from --plugin-dir. App paths may contain spaces even though /Applications/Coflux.app does not. Quote plist values and shell arguments correctly.
- The Bash tool uses zsh here: `"$VAR:apps/..."` interprets `:a` as a modifier and corrupts the path; use `${VAR}:path` for git rev:path. `set -e` is ineffective; chain necessary steps with `&&`.
- The user's local supervisor is still the 2026-09-05 version, with no ~/.coflux/supervisor-version and no cofluxd in ~/.coflux/bin. Before real-machine acceptance the user must upgrade daemon; mention this delivery prerequisite without doing it in this plan.
- pnpm's built-in pack intercepts `pnpm -C apps/desktop pack`; use `run pack` with COFLUX_DESKTOP_DAEMON_DIR for local smoke testing.

## Scope

In scope:
- `crates/supervisor/src/**` (executor chooses module, integrating main.rs/sessions.rs)
- `tests/src/session-env-injection.test.mjs`
- `apps/desktop/scripts/stage-daemon.mjs`, `apps/desktop/src/main/{daemon-paths,daemon-files,daemon-bundle,daemon-manager}.ts` and tests, `apps/desktop/test/config.test.ts`, builder config if needed
- Desktop README/RELEASING, plugin README, CLI README, docs/architecture.md, plans/README.md

Out of scope:
- Plugin contents other than README. No plugin-content/version change; executor evaluates whether README alone requires a version bump under repository rules and records the choice.
- `packages/cli/cofluxd.mjs` — npm variable/plist unchanged
- `.github/workflows/desktop-release.yml` — plugin source is in-repo; no new CI inputs. STOP/report if testing proves otherwise.
- worker, CLI crates, server, client package, desktop renderer — no UI
- Codex loading

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Supervisor tests | `cargo test -p coflux-supervisor` | exit 0 |
| Warning-free Rust | `RUSTFLAGS="-D warnings" cargo build -p coflux-supervisor` | exit 0 |
| Desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| No Han characters in plugin | `perl -ne 'print if /\p{Han}/' $(find integrations/claude-plugin -type f)` | No output |
| Session environment black-box (acceptance) | `pnpm -C tests test -- --test-name-pattern="plan 11[25]"` or run session-env-injection per harness conventions | exit 0 |
| Local packaging smoke test (acceptance) | `COFLUX_DESKTOP_DAEMON_DIR=<dir> pnpm -C apps/desktop run pack`, then `diff -r integrations/claude-plugin "<app>/Contents/Resources/daemon/claude-plugin"` | Empty diff |

## Done criteria

- [ ] All listed commands pass.
- [ ] zsh/bash/fish use a claude function; argv includes plugin-dir only for an existing directory; unknown shells are untouched.
- [ ] User rc chains, including custom ZDOTDIR, retain original order.
- [ ] Bundled plugin is byte-identical to integrations/claude-plugin and absent from mac.binaries.
- [ ] Plist contains COFLUX_CLAUDE_PLUGIN_DIR; startup only rewrites differing content, never restarts daemon.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false, especially local Claude Code lacking working --plugin-dir or CommandBuilder being unable to pass zsh ZDOTDIR without affecting other sessions.

## Maintenance notes

- The contract is only the COFLUX_CLAUDE_PLUGIN_DIR name. Future directory/distribution changes, including npm/Linux, change the injector without changing supervisor.
- Coflux now owns shell integration. Future OSC 133 prompt markers, cwd tracking, or fixes for rc shadowing plan 112 PATH should use this rc chain, not a second injection path.
- If Claude Code changes --plugin-dir semantics, especially same-name marketplace override, consult official plugins.md “Test your plugins locally” first.
- User rc errors behave as before: shell starts and function is defined. If rc execs another shell, the injected tail never runs; this is a known boundary.
