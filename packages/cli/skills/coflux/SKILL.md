---
name: coflux
description: When you run inside a coflux terminal, this skill documents the local cofluxd commands that open terminals the user can watch and take over from the coflux web/mobile app, report progress, call the user and hand out preview URLs, plus the center MCP for reaching other workspaces and devices. Your coordinates (device / project / workspace / terminal) arrive in a <coflux-session> block at session start, or via the COFLUX_* environment variables. Inside your own workspace always use the zero-credential local cofluxd commands (open, read, wait, send, report progress, call the user, get preview URLs); use the center's coflux MCP only to leave this workspace (child workspaces, other workspaces or devices). Use when the user should be able to watch, step into or stop a command (interactive steps, dev servers, a job they are waiting on), when the user has to decide something, when you want to hand the user a clickable preview URL, or when you need an isolated child workspace for parallel work.
---

# Working inside coflux

You may be running inside a coflux terminal. coflux lets the user watch agents working on many
machines from a browser or a phone and take over at any time. This skill gives you terminals the
user can see and take over, a progress line and a call button on the workspace card, preview URLs,
and a way to operate the other workspaces and devices under the account when you need to.

Two tracks, one rule: **whatever closes locally uses local commands; only leaving this
workspace goes through MCP.**

| Track | Credentials | Reach | Use for |
|---|---|---|---|
| Local commands `cofluxd terminal/progress/notify/ports` | none (the daemon identifies you by process tree) | **the workspace you are in** | open, read, wait, send, report progress, call the user, preview URLs: the default, fastest, no network dependency |
| Center MCP `coflux` | one OAuth authorization by the user in the host | **the whole account**: every device, project, workspace and terminal | child workspaces (git worktrees), cross-workspace / cross-device access, joining from outside coflux |

Of the local commands, `send`/`read`/`wait`/`notify`/`progress` complete entirely inside the
local daemon and never touch the center; `new`/`list`/`ports` are relayed to the center by the
daemon on your behalf (terminals must appear in the user's sidebar, preview URLs are minted by
the center). You only ever talk to the local daemon.

## Figure out where you are first

With the coflux plugin installed, Claude Code and Codex receive a `<coflux-session>` block at
session start (and again after context compaction). Your coordinates are in it; use them
directly. Without that block (no plugin, hand-wired hooks, hook not trusted yet), read the
environment:

```sh
env | grep '^COFLUX_'
```

- **`COFLUX_WORKSPACE_ID` is non-empty** (or the `<coflux-session>` block is present) → you are in
  a coflux terminal with an up-to-date daemon. The variables below are your coordinates; pass
  these ids to MCP tools directly instead of guessing from `list_*`:

  | Variable | Meaning |
  |---|---|
  | `COFLUX_DEVICE_ID` | id of the device you run on (the id in `list_devices`) |
  | `COFLUX_PROJECT_ID` | owning project id; empty string for a directory workspace without a repository |
  | `COFLUX_WORKSPACE_ID` | owning workspace id (the id in `list_workspaces`) |
  | `COFLUX_TASK_ID` | id of this terminal (the taskId / terminalId used by local commands and `read_terminal`) |
  | `COFLUX_SESSION_ID` | id of this PTY session |
  | `COFLUX_MCP_URL` | the center's MCP URL; the user configures MCP with it |

- **Variables empty or absent** → treat yourself as outside coflux: forget this skill and use your
  own tools as usual (if the user configured the coflux MCP in the host, the MCP tools still work;
  you just have no "where am I" coordinates). If the user insists you are inside a coflux terminal,
  this machine's daemon has not been upgraded: tell the user to run `cofluxd update && cofluxd restart`;
  after reopening the terminal the variables and the local commands are there.

## When to open a terminal

A coflux terminal is a process the user can see: a titled entry in their sidebar that they can
open, take over and type into, with its output kept in a local log you can read back at any time.
Whether a command runs in your own Bash or in a coflux terminal is your call; a coflux terminal is
worth it when the user's view of the process matters:

- the user may want to step in: interactive steps, confirmations, something they may need to stop
  midway or rescue when it fails
- it keeps running and the user will want to find it later (dev server, watch mode, log tailing)
- you want to hand the user something to look at (a test run they asked to watch, a build they are
  waiting on)

**Do not use it** for quick one-shot commands (`ls`, `grep`, `git status`, reading files): your
own tools are faster, and a pile of one-second terminals is just noise to the user.

## Local commands

### Open a terminal and run a command

```sh
cofluxd terminal new --title="Run unit tests" --cmd="pnpm -C tests test"
```

`--title` is the name the user sees in the sidebar; **name it properly**: "Run unit tests",
"Start dev server", never "terminal 1". The command runs in the current workspace directory
under the login shell; the command line is capped at 16 KB.

Always write `--cmd=<value>` and `--title=<value>` with the `=`, never separated by a space: a
value that starts with `-` is otherwise taken for another option and the call fails outright.

The terminal exits when the command finishes and the task becomes `exited` with the exit code:
that is how you tell success from failure. So do not expect to run a second command in the same
terminal: write `a && b`, or open another one.

The output is also written to a local log for you to read back (roughly the last 1 MB is kept).
The cost is that stdout is a pipe rather than a tty, so most programs turn off colors and
progress bars. A few programs behave differently without a tty (no progress output, CI mode);
if you depend on that behavior, run the command in your own Bash instead.

The new terminal has the same `COFLUX_*` variables (pointing at its own task/session ids, same
workspace as you).

### See how far it got

```sh
cofluxd terminal list                      # every terminal in this workspace: id, state, exit code, title
cofluxd terminal read <taskId>             # a terminal's content (plain text, last 200 lines by default)
cofluxd terminal read <taskId> --lines 50
```

`list` states are `running` / `exited` / `idle`; `exited` carries `exit=<code>`.
**An exited terminal can still be read**: "the command finished, look at the output" is the most
common case. `read` reads the local log; terminals without a log (opened by the user) return the
current screen. Both are immediate.

### Wait for a command to finish

```sh
cofluxd terminal wait <taskId>               # block until that terminal exits and print the exit code (default cap 30 minutes)
cofluxd terminal wait <taskId> --timeout 300 # custom timeout in seconds; a timeout fails loudly with a non-zero exit
```

To wait for a command use `wait`; **do not write your own polling loop**. One command blocks
until done and hands you the exit code. A timeout does not mean the command failed, only that it
is still running: `read` to see where it is, then decide whether to keep waiting or act.

`wait` **always exits 0** once the terminal is done: it reports that the command finished, not
whether it succeeded. Read the result off its output line `# exited exit=<code>` (`list` shows the
same). A non-zero exit from `wait` itself means the wait timed out or the id was wrong.

**Keep working, and be woken up when it finishes.** `wait` blocks, so run it as a backgrounded Bash
call of your own:

1. `cofluxd terminal new --title="Run the test suite" --cmd="pnpm -C tests test"` → prints a taskId.
2. Run `cofluxd terminal wait <taskId>` as a backgrounded Bash call, then go do something else.
3. The host wakes you when that call exits. Check its output for `# exited exit=<code>`, then
   `cofluxd terminal read <taskId>` to see what actually happened.

That gets you both halves at once: the user watches (and can take over) a real terminal, and you are
still told the moment it is over, instead of blocking or polling for it.

### Type into a terminal

```sh
cofluxd terminal send <taskId> --text "y" --enter    # type a line and press Enter
cofluxd terminal send <taskId> --enter               # just press Enter
```

For interactive confirmations (y/N, menus), or to add a command in the same shell after the
previous one finished. Discipline:

- **`read` before `send`**: see what the terminal is waiting for before typing; never type blind.
- **Refused while the user is taking over**: that is not an error, it is by design; humans always
  win. Stop when refused; use `notify` to communicate, do not retry.
- **After a send timeout do not resend right away**: `read` first to check whether the input
  actually landed; duplicated input is worse than lost input.
- A single text is capped at 64 KB; this is an interactive input channel, not a file transfer.

### Report progress

```sh
cofluxd progress "Reproduced; narrowing down the relay reconnect timing"
```

One sentence telling the user how far you are, shown on the workspace card and replaced by the
next one. Update it at milestones: reproduced, located, fixed and verifying, stuck on X. It
**does not interrupt the user**; it is a different channel from `notify`:

- `progress` = broadcast (the user glances and knows the state, no response needed)
- `notify` = call the user (the workspace turns "waiting for interaction", the user should come and look)

If unsure: when the user does not have to do anything, use `progress`.

### Call the user

```sh
cofluxd notify "Both approaches work; I need you to pick one"
```

The user's sidebar switches this workspace to "waiting for interaction" and shows this sentence;
they see it on the phone too. Use it when you are **really stuck**: a decision is needed, a
password or a permission, a problem only a human can judge. One sentence saying what you need;
do not write a log.

(Your normal questions and permission prompts already show up in the sidebar state; they need no
extra notify. This is for "what you have to say cannot be guessed from the status icon".)

### Hand the user a clickable preview

```sh
cofluxd ports
```

Lists every listening port in this workspace with its public preview URL. After starting a dev
server, use it to get the URL and tell the user directly; they click it and nobody has to dig.

### Errors from local commands

Errors are one readable sentence; do what they say: "not inside a coflux terminal" = you are not
in a coflux session; "terminal is not in this workspace or does not exist" = check the id with
`list`; "predates the daemon upgrade" = that terminal was opened before the daemon upgrade, open a
new one; "daemon is not connected to the center" only appears on `new`/`list`/`ports`, retry once
it reconnects.

## Center MCP: leaving this workspace

Local commands only see the workspace you are in. Use the MCP server named `coflux` in the host
**only** for these:

- **Open an isolated child workspace to work in parallel**: `create_workspace` (project id from
  `$COFLUX_PROJECT_ID`) really runs `git worktree add` on the device; then `create_terminal` runs
  commands there.
- **Look at or operate terminals in other workspaces or on other devices**: `list_*` →
  `read_terminal` / `send_terminal_input`.
- **Join everything under the account when you are not inside a coflux terminal** (for example
  Claude Code the user started on their own machine).
- **Never run `git worktree add` yourself**: inside a coflux project the plugin blocks
  `git worktree add|remove|move` and points you to `create_workspace` / `remove_workspace`; a
  worktree you create is invisible to the user and cannot host a terminal.

Do not detour through MCP for work inside this workspace: that is an extra round trip to the
center, while a local command does it in one step.

### When MCP is not configured

Run `claude mcp list` (Codex: `codex mcp list`) to see whether `coflux` is there. If not, give
the user the one-line setup, with the URL from `$COFLUX_MCP_URL` (it is the center's public URL
+ `/mcp`):

```sh
claude mcp add --transport http coflux "$COFLUX_MCP_URL"     # Claude Code
codex mcp add coflux --url "$COFLUX_MCP_URL"                 # Codex
```

The host then guides the user through a one-time OAuth authorization in the browser (`/mcp` in
Claude Code). Authorization is the user's job; you only hand over the URL and the command. Until
it is set up, keep doing the work inside this workspace with local commands.

### Using the tools

The tool list and each tool's contract (parameters, limits, what an error means) come from the
MCP server itself: read the tool descriptions in the host, they are the source of truth and this
file does not repeat them. Take ids from the `COFLUX_*` variables first; for anything outside this
workspace, find ids with the `list_*` tools.

The local-command disciplines apply to MCP just the same: `read_terminal` before
`send_terminal_input`, stop when refused because the user is taking over (communicate with
`cofluxd notify` instead of retrying), `wait_terminal` instead of a polling loop around
`read_terminal`, and stop on "needs upgrade" (tell the user to run
`cofluxd update && cofluxd restart` on that device; do not retry or work around it).

## Boundaries

- You can open, read, wait and type, but **typing is a restricted write with humans first**: you
  cannot write into a terminal the user is taking over (you are refused explicitly), and the user
  taking over at any time displaces you. Do not fight a human for a terminal.
- Local commands only see **the workspace you are in**; other workspaces and other machines go
  through MCP and are limited to the same account.
- A workspace has a cap on concurrently live terminals (default 8, including the user's own).
  On hitting the cap, `list` first: usually some finished terminals were never collected. If the
  user really filled it up, `notify` them instead of forcing it.
- `new`/`list`/`ports` and every MCP tool need the daemon connected to the center; "letting the
  user see" is their whole point. `send`/`read`/`wait`/`notify`/`progress` do not depend on the
  center. When disconnected they fail loudly rather than degrade silently.
- `COFLUX_*` variables exist only in PTYs opened by coflux; exporting or changing them yourself
  has no effect, the center only trusts the ids it issued.
