# Plan 028: macOS Full Disk Access (FDA) detection and setup guidance

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 6eda26d..HEAD -- packages/cli/cofluxd.mjs crates/supervisor/src/main.rs crates/worker/src/main.rs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `6eda26d`, 2026-07-23

## Requirement

On macOS, the daemon runs as a background LaunchAgent. PTY child processes accessing TCC-protected Desktop, Documents, or Downloads can trigger folder-permission dialogs while the user is away, hanging or failing operations. Granting Full Disk Access (FDA) once to the supervisor binary prevents repeated prompts throughout its process tree.

macOS intentionally exposes no API to request FDA programmatically. The product can only detect access, open System Settings, and guide manual approval. Integrate this guidance into the daemon and cofluxd CLI.

Required outcomes:

1. When the supervisor on macOS starts, it detects whether it has FDA, and the result is the status file under `COFLUX_HOME`;
2. `cofluxd status` displays one more line of FDA authorization status (granted/not granted/unknown) on macOS;
3. Added `cofluxd fda` subcommand: print the instructions, open the system settings FDA panel, highlight the supervisor binary in Finder, wait for the user to complete and restart the service to make the authorization effective;
4. If access has not been granted when `onboard`/`up` is completed (macOS), add a line of prompts pointing to `cofluxd fda`;
5. Linux behavior is completely unchanged.

The demarcation between correct/wrong solutions: The detection must occur within the **supervisor process** - What is measured by reading the protected path in the CLI (node) is the TCC permissions of the terminal App, which is a typical wrong solution.

## Decisions & tradeoffs

- **Detect inside the supervisor** at startup under `#[cfg(target_os = "macos")]`. Rejected: probing protected paths in the CLI, which measures Terminal/iTerm permissions as the responsible process rather than the daemon’s. LaunchAgent directly executes `SUP_BIN` (`packages/cli/cofluxd.mjs:107-124`).
- **Probe an FDA-only protected path** such as `$HOME/Library/Safari` with `read_dir`: success means granted, `PermissionDenied` means not granted, and other errors such as missing directory mean unknown. Rejected: probing Desktop/Documents/Downloads, whose per-folder TCC dialogs would recreate the problem. `$HOME` is the real user home, distinct from `COFLUX_HOME` (`crates/supervisor/src/main.rs:46`).
- **Status file**: supervisor writes the result under `COFLUX_HOME`; CLI reads and displays it. Rejected: a new UDS query API for a Boolean state. Existing CLI/daemon status already uses files, such as `worker.pid` (`crates/worker/src/main.rs:201`, `packages/cli/cofluxd.mjs:280`). The executor chooses filename/format consistent with existing conventions.
- **`cofluxd fda`**: print guidance, run `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`, and `open -R <SUP_BIN>` to reveal the binary for dragging into settings (`~/.coflux` is hidden). Ask the user to press Enter after adding it, then reuse `restartService()` (`packages/cli/cofluxd.mjs:154-157`). Restart is required because FDA does not affect an already-running supervisor. Reject attempts to write TCC.db or authorize through tccutil; no supported mechanism exists. On other platforms, explain that FDA is macOS-only and exit.
- **Identify the correct binary**: instruct users to add `~/.coflux/bin/coflux-supervisor`, not cofluxd, Node, or the terminal app. Worker/PTY/agent processes descend from the launchd service’s responsible process, so one approval covers the tree, as with sshd. The plist’s `ProgramArguments` contains only `SUP_BIN` (`packages/cli/cofluxd.mjs:112-114`).
- **Prompt locations**: always show status in `status`, and add one line at the end of `onboard`/`up` when needed. The file appears only after supervisor startup; if unreadable, show Unknown and point to `cofluxd fda` without blocking. Rejected: server/web device warnings, which would require protocol/server/web changes without a current requirement.

## Direction

Two changes, no shared boundaries, can be completed serially in a single plan.

### Milestone 1: supervisor starts detecting FDA and writes status file

Early in macOS supervisor `main`, after `Settings::load` (`crates/supervisor/src/main.rs`), probe FDA and write its status under `COFLUX_HOME`. Probe failure and non-macOS paths may omit the file or write unknown, but detection/writing must neither panic nor block startup. Validation: `cargo build -p coflux-supervisor` and regression `cargo test -p coflux-protocol` exit 0.

### Milestone 2: cofluxd CLI - status display + fda subcommand + onboard/up prompt

In `packages/cli/cofluxd.mjs`, `cmdStatus` reads the file and adds a line only under `IS_MAC`; add `cmdFda` to handlers (`packages/cli/cofluxd.mjs:338`) and HELP (from `packages/cli/cofluxd.mjs:302`). Add final `onboard`/`up` prompts based on status. Preserve the historical zero-dependency single-file Node style, `run()` subprocess helper, and Chinese UI copy. Validation: `node --check packages/cli/cofluxd.mjs` exits 0.

## Landmines

- The parsing of home by CLI and supervisor must be consistent: CLI uses `COFLUX_HOME || ~/.coflux` (`packages/cli/cofluxd.mjs:16`), supervisor uses the same (`crates/supervisor/src/main.rs:46`); the path spellings at both ends of the status file must be aligned, otherwise the status will always be "unknown".
- The detection path must use the real `$HOME` (`std::env::var("HOME")`), not `COFLUX_HOME` — in dev mode, `COFLUX_HOME` points to `$PWD/.coflux-dev` (`package.json:10`), and there is no `Library/Safari` under it.
- `launchctl unload`+`load` is the existing restart method (`packages/cli/cofluxd.mjs:155`); `cofluxd fda` reuses `restartService()`, do not create another launchctl call.
- The detection result is a snapshot at startup: after user authorization but before restarting, the status file still shows that it has not been granted - this is expected behavior (FDA requires a restart to take effect), just make it clear in the copy.

## Scope

In scope:

- `packages/cli/cofluxd.mjs`
- `crates/supervisor/src/main.rs` (If you need to split the small function, you can add a new module in the same crate)
- `plans/README.md` (status update)

Out of scope:

- `crates/worker/`, `apps/server/`, `apps/web/`, `packages/protocol/`, `proto/` — Do not report to the server, do not change the protocol
- Any behavioral changes to the Linux/systemd path
- Documents (README, etc.) - Subcommands can come with HELP

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust Build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| Rust unit test (regression) | `cargo test -p coflux-protocol` | exit 0 |
| CLI syntax check | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| black-box integration (acceptance) | `pnpm -C tests test` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] On macOS, supervisor startup writes FDA status; cofluxd status shows it; cofluxd fda opens settings and highlights the binary, then restarts the service after completion; onboard/up show a one-line notice when unauthorized.
- [ ] Non-macOS platforms: supervisor and CLI behave exactly the same as the current situation (`cofluxd fda` only prompts that it is not supported).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- If Apple changes the TCC classification or path of `~/Library/Safari` in the future, the detection will degrade to "Unknown" - a harmless fallback affecting only prompts, not functionality; then just change to a pure FDA protection path.
- The system settings deep link `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` is a URL that Apple has not documented but has been stable for many years; when it fails, it degrades to only opening the system settings main interface, and the copy still provides guidance.
- The binary is signed by Developer ID (from v0.6.1), TCC records authorization according to the signing identity, and upgrading the binary will not lose authorization; if the signing identity is changed in the future (certificate/Team change), the user needs to re-authorize.
