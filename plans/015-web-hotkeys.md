# Plan 015: Global web keyboard shortcuts with a Cmd+Ctrl prefix and help panel

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat a0657e7..HEAD -- apps/web/src/components/workbench apps/web/src/config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `a0657e7`, 2026-07-20

## Requirement

roadmap (docs/ROADMAP.md "Shortcut Key Support"): High-frequency operations on the web workbench currently rely on the mouse.

The focus is almost always on the xterm terminal, and moving your hands back and forth is the main friction. After completion:

- `Cmd+Ctrl+T`: Create a new terminal in the current workspace

- `Cmd+Ctrl+W`: Close the current terminal tab (the RUNNING task still uses the existing confirmation dialog box and does not kill silently)

- `Cmd+Ctrl+1..9`: Switch to the Nth terminal tab in the current workspace (order = tab order, that is, createdAt ascending order)

- `Cmd+Ctrl+[`/`Cmd+Ctrl+]`: previous / next terminal tab (the executor may choose clamped or wraparound navigation, but must apply it consistently)

- `Cmd+Ctrl+N`: Pop up the "New Workspace" BranchMenu of the project to which the currently selected workspace belongs.

- `Cmd+/`: Shortcut key help floating layer (list all keys; Esc or press again to close)

- Shortcut keys will still take effect when the focus is in the terminal, and intercepted key combinations will not be sent to the remote shell

- Silently ignore when there is no corresponding target (such as pressing Cmd+Ctrl+T when there is no selected workspace, the number is out of bounds, or Cmd+Ctrl+W when there is no task)

Definitely not done: Workspace switching shortcut keys (vetoed by users); PWA/Keyboard Lock enhancements; shortcut key customization.

Correctness boundary: do not install a global shortcut handler on every xterm through `attachCustomKeyEventHandler`, and do not let inactive keep-alive WorkspaceTerminal instances respond (see Landmines).

## Decisions & tradeoffs

- **Use the unified `Cmd+Ctrl` prefix.** The user chose this during exploration. Cmd alone, Cmd+Shift, and Ctrl+Shift were rejected: `Cmd+W/T/N/1-9` and `Cmd+Shift+W/T/N/[/]/3/4/5` are reserved by the browser or OS before DOM dispatch, so preventDefault cannot intercept them. Failed Ctrl+Shift interception can leak Ctrl+letter into the shell, such as Ctrl+W deleting a word. Cmd+Ctrl is the only macOS combination free of both browser and system reservations. The user confirmed this over three rounds, including rejecting the PWA alternative; do not change these bindings.
- **Install one window capture-phase keydown listener in Workbench.** Calling `preventDefault() + stopPropagation()` before xterm’s textarea target phase prevents shell input. Per-xterm `attachCustomKeyEventHandler` registrations would duplicate handlers and miss focus outside terminals. Existing precedent: the window keydown handler in `apps/web/src/components/workbench/import-project-wizard.tsx:259`; xterm is created at `terminal-pane.tsx:117`.
- **Match `event.metaKey && event.ctrlKey` without platform branches (decided during planning).** This self-use product targets a macOS user. Win/Super+Ctrl is the equivalent on Windows/Linux, but deliberate adaptation is unnecessary. Two platform-specific maps would add speculative complexity without users.
- **Match brackets using `event.code` (BracketLeft/BracketRight), decided during planning.** `event.key` varies by layout. Digits may use Digit1..9 codes or key values at the executor’s discretion, provided non-QWERTY layouts do not suffer serious misfires.
- **Cmd+Ctrl+W reuses `requestCloseTask`** (`workbench.tsx:150`): RUNNING tasks use ConfirmActionDialog; others close directly. Calling `closeTaskNow` would violate confirmation before killing a running shell.
- **Cmd+Ctrl+N reuses the sidebar’s controlled BranchMenu.** Set the existing `createMenuProjectId` (`sidebar.tsx:106,151-152`) to the selected workspace’s project. Do not duplicate the new-workspace dialog or branch-list logic. Lift state to Workbench or expose a ref/callback as appropriate for the existing props flow.
- **Expose commands upward from WorkspaceTerminal.** `requestActivation` and `createTerminal` belong to each workspace instance (`workspace-terminal.tsx:158,236`). Register them through an onReady callback, imperative handle, or lifted callback so Workbench can address the **active instance**. The executor chooses the mechanism; inactive keep-alive instances must never respond.
- **Use a simple help overlay with a hard-coded key table.** Follow dialogs.tsx and Astryx conventions in apps/web/.claude/CLAUDE.md. Six shortcuts do not justify a registry or configuration framework: one handler and one display table suffice.

## Direction

A single milestone can be delivered; the implementation is naturally divided into two parts: global keydown distribution + help floating layer.

### Milestone 1: Shortcut keys fully enabled + Help panel

The above Requirement list is all true; the intercepted combinations do not leak into the terminal; the type check is green. Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0.

## Landmines

- **WorkspaceTerminal has multiple keep-alive instances.** Visited workspaces are hidden rather than unmounted (`workbench.tsx:32,224-234`, `display:hidden` wrappers). Broadcasting shortcuts to all instances can fit/attach hidden terminals at zero dimensions, producing a 2×1 reflow (see defensive comments at `terminal-pane.tsx:166-178`). Only the `active` instance may respond.
- **xterm receives keydown on its hidden textarea.** Intercept at window capture and call `stopPropagation`, or xterm encodes the combination into PTY input (`terminal-pane.tsx:196-199`, onData).
- **Avoid dialog collisions.** Cmd+Ctrl+W while ConfirmActionDialog is open can overwrite `confirmAction` (`workbench.tsx:36,155`). Disable the action or make it idempotent while the dialog is active.
- **`requestActivation` supports forced reclaim.** Its `forceClaim` argument reclaims detached tasks (`workspace-terminal.tsx:158`); tab clicks pass `state === "detached"` (`workspace-terminal.tsx:390`). Keyboard tab selection must preserve this click behavior.
- **Creation already guards against duplicates.** `createTerminal` checks `pendingCreateRef` (`workspace-terminal.tsx:237`), so repeated shortcut presses are safe. Add no redundant guard state.

## Scope

In scope:
- `apps/web/src/components/workbench/`: workbench.tsx, workspace-terminal.tsx, sidebar.tsx, dialogs.tsx, and new shortcut-handler/help-overlay files.

Out of scope:
- `apps/server`, `crates/*`, `packages/protocol`: this is purely frontend interaction.
- xterm key handling in `apps/web/src/components/workbench/terminal-pane.tsx`: interception occurs at window capture without xterm configuration changes. If a particular key cannot be blocked there, adapting this layer is within ordinary design discretion rather than automatically a STOP condition, but explain it in the completion report.
- Shortcut customization or persistent configuration: future work.
- `tests/`: the black-box harness does not cover frontend-only interaction; add no new tests there.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Black-box regression | `pnpm -C tests test` | exit 0 (no new test cases, pure regression) |

## Done criteria

- [ ] All listed commands pass.
- [ ] All 7 groups of behaviors in the Requirement list are available; silently ignored if there is no target.

- [ ] The intercepted key combination does not appear in the terminal input stream (the shell cannot receive it).

- [ ] Non-active keepalive WorkspaceTerminal instances do not respond to shortcut keys.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Window capture demonstrably cannot block a required Cmd+Ctrl combination. This invalidates the key-binding assumption; return to the user.

## Maintenance notes

- Keep the hard-coded handler bindings and help table synchronized when adding shortcuts.
- Future PWA standalone aliases (Cmd+1-9/Cmd+T) or fullscreen Keyboard Lock can add branches to the same handler without new architecture.
- Cmd+Ctrl is a confirmed user contract; consult the user before changing it.
