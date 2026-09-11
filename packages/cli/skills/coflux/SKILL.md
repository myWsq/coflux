---
name: coflux
description: Use coflux to open visible terminals, read, wait, type, report progress, notify the user and obtain preview URLs. Prefer zero-credential local commands in the current workspace; use the account CLI across workspaces and devices. Coordinates arrive through coflux-session or COFLUX_* variables.
---

# Working inside coflux

You may be running inside a coflux terminal. coflux lets the user watch agents working on many
machines from a browser or a phone and take over at any time. This skill gives you terminals the
user can see and take over, a progress line and a call button on the workspace card, preview URLs,
and a way to operate the other workspaces and devices under the account when you need to.

**Use local commands in this workspace and account CLI commands across workspaces and devices.**

| Track | Credentials | Reach | Use for |
|---|---|---|---|
| Local commands `coflux terminal/progress/notify/ports` | none (the daemon identifies you by process tree) | **the workspace your cwd is in** | open, read, wait, send, report progress, call the user, preview URLs: the default, fastest, no network dependency |
| Account CLI | app login or `coflux login` | all devices and workspaces in the account | child workspaces and remote terminals; JSON output |

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
  these ids to account CLI commands directly instead of guessing from `list_*`:

  | Variable | Meaning |
  |---|---|
  | `COFLUX_DEVICE_ID` | id of the device you run on (the id in `list_devices`) |
  | `COFLUX_PROJECT_ID` | owning project id; empty string for a directory workspace without a repository |
  | `COFLUX_WORKSPACE_ID` | the workspace this terminal was **opened** in (the id in `list_workspaces`). The variable is frozen when the terminal starts; the workspace the terminal *belongs to* can still change — see below. `coflux workspace` is the authority |
  | `COFLUX_TASK_ID` | id of this terminal (the taskId / terminalId used by local commands and `read_terminal`) |
  | `COFLUX_SESSION_ID` | id of this PTY session |

- **Variables empty or absent**: there is no local terminal context. Use `coflux whoami` to check
  account access and the account CLI to discover workspaces. Ask the user to log in when needed;
  never fabricate COFLUX_* coordinates.

### Two workspaces to keep apart: owning and effective

- **Owning workspace** = the workspace this terminal **belongs to**: what the user's sidebar shows it
  under, what its turn state, branch and diff stats are attributed to. It starts out as
  `COFLUX_WORKSPACE_ID` and moves with you when you enter or leave a git worktree (below).
- **Effective workspace** = the workspace **your current working directory is inside**. This is what
  every local command acts on.

They are the same until your cwd wanders off. A plain `cd <path>` moves a *live* session — same
conversation, no restart — and a coflux child workspace is a normal registered git worktree, so a
session whose terminal belongs to workspace A can end up working inside workspace B. From that
moment, in B:

- `coflux terminal new` opens the terminal **in B**, under B in the user's sidebar, running in B's
  directory, counting against B's terminal cap;
- `coflux terminal list` lists B's terminals, and A's terminals answer `read` / `wait` / `send`
  with "not in this workspace or does not exist" (`cd` back to A to reach them again);
- Account CLI calls need **B's** id as `workspaceId`;
- the terminal itself stays under A, and `progress`, `notify` and `ports` still belong to it,
  whatever your cwd is; `COFLUX_TASK_ID` and `COFLUX_SESSION_ID` never change.

If your cwd is outside every coflux workspace (say `/tmp`), local commands fall back to the owning
workspace.

A terminal opened before the daemon was upgraded is the one case with no owning workspace at all:
its local commands are refused with "predates the daemon upgrade" whatever your cwd is, because the
daemon never guesses ownership from a directory. Open a new terminal.

### coflux follows you into a git worktree

`EnterWorktree` switches this live session into a git worktree (its own, or an existing one you point
it at), `ExitWorktree` switches back, and resuming a session that had entered one puts you straight
back in it. **coflux comes along**: the terminal's *owning* workspace moves to the workspace that
worktree is, and if coflux has never seen that worktree it registers it as a child workspace of this
project first — a new card appears in the user's sidebar, with its branch and diff stats. Nothing is
interrupted: same terminal, same PTY, same conversation, and the user keeps watching it where it now
lives. When Claude Code cleans up its own worktree on exit, that workspace's terminals move back to
the project's main workspace and the record disappears by itself.

So, after entering or leaving a worktree, owning **and** effective are both the new workspace: pass
its id to account CLI commands and everything local already acts on it. The plugin drops the new id next to the
tool result, and `coflux workspace` always tells you. Two things stay behind on purpose:

- `COFLUX_WORKSPACE_ID` (and the id in the `<coflux-session>` block from earlier in this session)
  still names where the terminal was *opened*; it is frozen when the PTY starts and cannot be
  rewritten. Never reuse it after a move.
- The shell inside this terminal keeps its own directory. That is only about the shell; it does not
  affect where your work is attributed.

Nothing happens when coflux cannot follow, and nothing is blocked either: another repository, a
directory that is not a git repository, a terminal opened in a directory workspace (no project), or
a daemon that is down or too old — the session just carries on with the ownership it had.

### Ask where you are

```sh
coflux workspace
{"workspaceId":"ws-b","path":"/Users/me/.coflux/worktrees/ws-b","owningWorkspaceId":"ws-a","moved":true}
```

One line of JSON: `workspaceId` (+ `path`) is the **effective** workspace, `owningWorkspaceId` is the
workspace this terminal belongs to right now, and `moved` says whether they differ. With the plugin
installed you also get a `<coflux-session-moved>` block at the start of every prompt while the two
differ — but that block only arrives with the **next** user prompt. **About to call an account command right
after a `cd`? Run `coflux workspace` first** and use the `workspaceId` it prints; do not reuse
`COFLUX_WORKSPACE_ID`.

## When to open a terminal

A coflux terminal is a process the user can see: a titled entry in their sidebar that they can
open, take over and type into, whose output you can read back at any time.
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

### Open a terminal

There are two kinds, told apart by one single thing: **whether you pass a command**.

```sh
coflux terminal new --title="Run unit tests" --cmd="pnpm -C tests test"   # job terminal
coflux terminal new --title="Debug shell"                                 # session terminal
```

`--title` is the name the user sees in the sidebar; **name it properly**: "Run unit tests",
"Start dev server", never "terminal 1". Either kind runs in the directory of the workspace your cwd
is in (which is not always the one this terminal was opened in — see "owning and effective").

Always write `--cmd=<value>` and `--title=<value>` with the `=`, never separated by a space: a
value that starts with `-` is otherwise taken for another option and the call fails outright.

**Job terminal — with `--cmd=...`.** It runs that one command under the login shell (command line
capped at 16 KB). The terminal exits when the command finishes and the task becomes `exited` with
the exit code: that is how you tell success from failure. So do not expect to run a second command
in the same terminal: write `a && b`, or open another one. The output is also written to a local
log for you to read back (roughly the last 1 MB is kept). The cost is that the command's stdout is
a pipe rather than a tty: most programs turn off colors and progress bars, full-screen programs
(vim, htop, less) do not work at all, and a few switch to a different "CI" behavior.

**Session terminal — no `--cmd` at all.** You get exactly what the user gets by clicking "new
terminal" in the sidebar: the default login shell in the workspace directory, with stdin **and**
stdout on a real tty. It runs nothing by itself and **never exits on its own** — it lives until
`exit` is typed into it (by you with `send`, or by the user), or the user stops it. Reach for it
when you need several commands in the same shell, a TUI or a program whose colors and progress
bars matter, or simply a terminal the user can step into and keep using. There is no command log
for it: `read` returns the current screen (one screenful, no history), so you judge how it went
from what is on screen, and `wait` is only meaningful after you have sent `exit`.

Driving a session terminal:

1. `coflux terminal new --title="Debug shell"` → prints a taskId.
2. `coflux terminal read <taskId>` until you see the shell prompt. The shell needs a moment to
   start and the first read can come back empty — **never `send` before you have seen a prompt**.
3. `coflux terminal send <taskId> --text="pnpm build" --enter`, then `read` again to see what
   happened. One send per command; nothing signals you when a command finished, so read until the
   prompt is back. To make that unambiguous, end the command with a marker of your own
   (`pnpm build; echo DONE-$?`) and read until the marker shows up.
4. `coflux terminal send <taskId> --text="exit" --enter` when you are done; the terminal then
   becomes `exited` with the shell's exit code.

The new terminal has the same `COFLUX_*` variables (pointing at its own task/session ids, same
workspace as you).

### See how far it got

```sh
coflux terminal list                      # every terminal in the workspace your cwd is in: id, state, exit code, title
coflux terminal read <taskId>             # a terminal's content (plain text, last 200 lines by default)
coflux terminal read <taskId> --lines 50
```

`list` states are `running` / `exited` / `idle`; `exited` carries `exit=<code>`.
**An exited terminal can still be read**: "the command finished, look at the output" is the most
common case. `read` reads the local log of a job terminal; terminals that have no log (session
terminals, and the ones the user opened) return the current screen instead — one screenful, no
history, and empty for the first moments after opening. Both are immediate.

### Wait for a command to finish

```sh
coflux terminal wait <taskId>               # block until that terminal exits and print the exit code (default cap 30 minutes)
coflux terminal wait <taskId> --timeout 300 # custom timeout in seconds; a timeout fails loudly with a non-zero exit
```

To wait for a command use `wait`; **do not write your own polling loop**. One command blocks
until done and hands you the exit code. A timeout does not mean the command failed, only that it
is still running: `read` to see where it is, then decide whether to keep waiting or act.

`wait` **always exits 0** once the terminal is done: it reports that the command finished, not
whether it succeeded. Read the result off its output line `# exited exit=<code>` (`list` shows the
same). A non-zero exit from `wait` itself means the wait timed out or the id was wrong.

**Do not `wait` on a session terminal** unless you have already sent it `exit`: it never finishes
by itself, so the wait can only end in the 30-minute timeout — a timeout there means the shell is
still sitting at its prompt, nothing more. Its exit code, when it finally exits, is the shell's and
not any command's: check what a command did by reading the screen.

**Keep working, and be woken up when it finishes.** `wait` blocks, so run it as a backgrounded Bash
call of your own:

1. `coflux terminal new --title="Run the test suite" --cmd="pnpm -C tests test"` → prints a taskId.
2. Run `coflux terminal wait <taskId>` as a backgrounded Bash call, then go do something else.
3. The host wakes you when that call exits. Check its output for `# exited exit=<code>`, then
   `coflux terminal read <taskId>` to see what actually happened.

That gets you both halves at once: the user watches (and can take over) a real terminal, and you are
still told the moment it is over, instead of blocking or polling for it.

### Type into a terminal

```sh
coflux terminal send <taskId> --text "y" --enter    # type a line and press Enter
coflux terminal send <taskId> --enter               # just press Enter
```

For interactive confirmations (y/N, menus), or to add a command in the same shell after the
previous one finished. Discipline:

- **`read` before `send`**: see what the terminal is waiting for before typing; never type blind.
  On a freshly opened session terminal this also means waiting for the shell prompt to appear.
- **Refused while the user is taking over**: that is not an error, it is by design; humans always
  win. Stop when refused; use `notify` to communicate, do not retry.
- **After a send timeout do not resend right away**: `read` first to check whether the input
  actually landed; duplicated input is worse than lost input.
- A single text is capped at 64 KB; this is an interactive input channel, not a file transfer.

### Report progress

```sh
coflux progress "Reproduced; narrowing down the relay reconnect timing"
```

One sentence telling the user how far you are, shown on the workspace card and replaced by the
next one. Update it at milestones: reproduced, located, fixed and verifying, stuck on X. It
**does not interrupt the user**; it is a different channel from `notify`:

- `progress` = broadcast (the user glances and knows the state, no response needed)
- `notify` = call the user (the workspace turns "waiting for interaction", the user should come and look)

If unsure: when the user does not have to do anything, use `progress`.

### Call the user

```sh
coflux notify "Both approaches work; I need you to pick one"
```

The user's sidebar switches this workspace to "waiting for interaction" and shows this sentence;
they see it on the phone too. Use it when you are **really stuck**: a decision is needed, a
password or a permission, a problem only a human can judge. One sentence saying what you need;
do not write a log.

(Your normal questions and permission prompts already show up in the sidebar state; they need no
extra notify. This is for "what you have to say cannot be guessed from the status icon".)

### Hand the user a clickable preview

```sh
coflux ports
```

Lists every listening port in this workspace with its public preview URL. After starting a dev
server, use it to get the URL and tell the user directly; they click it and nobody has to dig.

### Errors from local commands

Errors are one readable sentence; do what they say: "not inside a coflux terminal" = you are not
in a coflux session; "terminal is not in this workspace or does not exist" = check the id with
`list`, and if you moved into another workspace that is exactly what a terminal of the other one
looks like (`coflux workspace` to confirm, `cd` back to reach it); "predates the daemon upgrade" =
that terminal was opened before the daemon upgrade, open a new one; a `new` without `--cmd` refused for a missing command = this machine's daemon is older
than session terminals, tell the user to run `cofluxd update && cofluxd restart` (or pass a command
and use a job terminal); "daemon is not connected to the center" only appears on
`new`/`list`/`ports`, retry once it reconnects.

## Account CLI: across workspaces and devices

The bundled CLI can use the desktop app's login without receiving its token. For a standalone CLI,
use `coflux login --username <account> --password-stdin`; the user supplies the password safely,
never as a command argument. Account commands return JSON. A workspace ID identifies its device.

```sh
coflux device list
coflux project list --device <deviceId>
coflux workspace list --device <deviceId>
coflux workspace new --project <projectId> --branch <branch>
coflux terminal new --workspace <workspaceId> --title <title> [--cmd <command>]
coflux terminal list --workspace <workspaceId>
coflux terminal read <terminalId> --remote
coflux terminal send <terminalId> --remote --text <text> [--enter]
coflux terminal wait <terminalId> --remote --timeout 30
coflux terminal stop <terminalId> --remote
coflux terminal remove <terminalId> --remote
coflux workspace rename <workspaceId> --name <name>
coflux workspace remove <workspaceId>
coflux ports --remote --device <deviceId>
```

`--remote` selects account access, including other workspaces on this machine. Read before sending;
stop immediately when the user takes over. If a write times out, inspect the result before retrying.
Exiting the CLI does not stop its terminals. Delete workspaces through `coflux workspace remove`
so the filesystem and workspace records stay consistent.

## Boundaries

- You can open, read, wait and type, but **typing is a restricted write with humans first**: you
  cannot write into a terminal the user is taking over (you are refused explicitly), and the user
  taking over at any time displaces you. Do not fight a human for a terminal.
- Local commands only see **the workspace your cwd is in** (`coflux workspace` says which one);
  use the account CLI for other workspaces and machines in the same account.
- A workspace has a cap on concurrently live terminals (default 8, including the user's own).
  On hitting the cap, `list` first: usually some finished terminals were never collected. If the
  user really filled it up, `notify` them instead of forcing it.
- `new`/`list`/`ports` and account commands need the daemon connected to the center; "letting the
  user see" is their whole point. `send`/`read`/`wait`/`notify`/`progress` do not depend on the
  center. When disconnected they fail loudly rather than degrade silently.
- `COFLUX_*` variables exist only in PTYs opened by coflux; exporting or changing them yourself
  has no effect, the center only trusts the ids it issued. `COFLUX_WORKSPACE_ID` always means the
  workspace this terminal was **opened** in and goes stale the moment coflux follows you into a
  worktree; both "where does this terminal belong now" and "where am I acting" come from
  `coflux workspace`.
