---
name: coflux
description: Use coflux to open terminals the user can see and take over, run commands in them, wait for those commands, read their scrollback, type into them, report progress, notify the user and obtain preview URLs. Prefer zero-credential local commands in the current workspace; use the account CLI across workspaces and devices. Coordinates arrive through coflux-session or COFLUX_* variables.
---

# Working inside coflux

You may be running inside a coflux terminal. coflux lets the user watch agents working on many
machines from a browser or a phone and take over at any time. This skill gives you terminals the
user can see and take over, a progress line and a call button on the workspace card, preview URLs,
and a way to operate the other workspaces and devices under the account when you need to.

**Use local commands in this workspace and account CLI commands across workspaces and devices.**

| Track | Credentials | Reach | Use for |
|---|---|---|---|
| Local commands `coflux terminal/progress/notify/ports` | none (the daemon identifies you by process tree) | **the workspace your cwd is in** | open, run, wait, read, send, close, report progress, call the user, preview URLs: the default, fastest, no network dependency |
| Account CLI | app login or `coflux login` | all devices and workspaces in the account | child workspaces and remote terminals; JSON output |

Of the local commands, `run`/`wait`/`read`/`send`/`close`/`notify`/`progress` complete entirely
inside the local daemon and never touch the center; `new`/`list`/`ports` are relayed to the center
by the daemon on your behalf (terminals must appear in the user's sidebar, preview URLs are minted
by the center). You only ever talk to the local daemon.

## Managed terminal integration

Coflux terminals automatically load this capability for Claude Code and Codex. Use
`coflux agent status` to inspect this terminal's integration acknowledgements; an
unconfirmed run has not successfully executed its context hook. It does not prove
that approval is pending. Codex asks for native hook review when needed; use `/hooks`
to review it. Do not edit trust hashes or the user's global configuration.

Each agent keeps its own immutable CLI and skill files. Relaunching the agent selects
the installed device version, including from an already-open supported shell. Use
`COFLUX_AGENT_INTEGRATION=off claude` or `COFLUX_AGENT_INTEGRATION=off codex` to bypass
managed integration for one invocation. Use `coflux agent run <claude|codex> -- ...`
when a custom shell alias takes precedence over automatic integration.

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

A coflux terminal is a real, persistent shell the user can see: a titled entry in their sidebar
that they can open, take over and type into, whose scrollback you can read back at any time. It is
modelled on Terminal.app's scripting surface: you open a shell, you *do script* into it, you ask
whether it is busy, you read its contents, you close it.

Whether a command runs in your own Bash or in a coflux terminal is your call; a coflux terminal is
worth it when the user's view of the process, or the user's hands, matter:

- **a step only the human can do**: typing a password (`ssh -t user@host "su - root -c '...'"`,
  `sudo`), confirming a prompt, driving a TUI, picking an option in an installer
- it keeps running and the user will want to find it later (dev server, watch mode, log tailing)
- you want to hand the user something to look at (a test run they asked to watch, a build they are
  waiting on)

**Do not use it** for quick one-shot commands (`ls`, `grep`, `git status`, reading files): your
own tools are faster, and a pile of throwaway terminals is just noise to the user.

## Local commands

### Open a terminal

```sh
coflux terminal new --title="Root ssh" --cmd="ssh -t user@host"   # open a shell and type the command in
coflux terminal new --title="Debug shell"                          # open a shell, type nothing yet
```

Every terminal is the same thing: the workspace's default login shell on a real tty (stdin **and**
stdout), started in the directory of the workspace your cwd is in (which is not always the one this
terminal was opened in; see "owning and effective"), alive until `exit` is typed into it or you
`close` it. It runs nothing by itself and never exits on its own.

`--title` is the name the user sees in the sidebar; **name it properly**: "Run unit tests",
"Root ssh", never "terminal 1".

`--cmd=...` is *do script*: the command is typed into the shell **after the shell has signalled that
its prompt is ready**, then the shell keeps living. It is exactly `new` followed by `run`. The
command line is capped at 64 KB. Always write `--cmd=<value>` and `--title=<value>` with the `=`,
never separated by a space: a value that starts with `-` is otherwise taken for another option.

`new` prints the terminal id on its first line whatever happens next; when the command could not
be typed it says so on the following line (see "Errors").

The new terminal has the same `COFLUX_*` variables (pointing at its own task/session ids, same
workspace as you).

### Run a command in it

```sh
coflux terminal run <taskId> --cmd="pnpm build"
```

Types the command (plus Enter) into the shell and prints the command's number, `#N`. It never types
blind: the daemon waits for the shell's prompt-ready mark first (up to ten seconds), so you do not
have to read the screen before running. It is refused readably while a previous command is still
running ("busy": `wait` for it or `read` the screen first), while the user is taking the terminal
over (humans first), and on a shell coflux cannot instrument (see "Errors"; `send` is the fallback).
One `run` = one command line; chain with `a && b` when you need several.

### Wait for the command to finish

```sh
coflux terminal wait <taskId>               # block until the current command finishes; prints its exit code
coflux terminal wait <taskId> --timeout=300 # custom timeout in seconds (default 30 minutes)
coflux terminal wait <taskId> --seq=2       # wait for command #2 specifically
```

`wait` is command-scoped, like Terminal.app's `busy`. It targets the most recently started command
(the one the last `run` printed) unless `--seq` names another, and it cannot lose a completion: a
command that finished before you called `wait` answers immediately with its stored exit code. The
answer is one line:

- `# finished exit=<code>`: the command ended; the terminal is still open at its prompt.
- `# exited exit=<code>`: the shell itself ended (someone typed `exit`, or `close`); the code is the
  shell's.

Completion comes from the shell's own integration marks, so it survives the user typing into the
running command (a password into `ssh`, `y` into a prompt), and a nested shell, `ssh` session or
TUI counts as one long command from the outside; marks from a remote host never end it early.

A timeout is a non-zero exit with a readable message, not a failure of the command: `read` to see
where it is, then decide. `wait` on a terminal that has not run any command yet returns readably
instead of blocking. `wait`, `read`, `list` and `close` are never refused because the user has
taken the terminal over.

**The flow for a step only the human can do:**

1. `coflux terminal new --title="Root ssh" --cmd="ssh -t user@host \"su - root -c '/opt/deploy.sh'\""`
2. `coflux notify "Please type the root password in the Root ssh terminal"`
3. Run `coflux terminal wait <taskId>` as a backgrounded Bash call and go do something else.
4. The host wakes you when that call exits with `# finished exit=<code>`; `coflux terminal read
   <taskId>` shows what the remote script printed, and the terminal is still there for the user.

**Do not write your own polling loop**: `wait` blocks and wakes the moment the command ends.

### See how far it got

```sh
coflux terminal list                      # every terminal in the workspace your cwd is in
coflux terminal read <taskId>             # the last 200 lines of the scrollback, plain text
coflux terminal read <taskId> --lines=50
```

`list` rows are `<taskId>  <state>[ exit=<code>][ busy|idle][ last=<code>]  <title>`: `running` /
`exited` / `idle` is the terminal, `busy` or `idle` says whether a command is running in it right
now, and `last=<code>` is the exit code of the last command that finished. `read` returns the tail
of the terminal's **full scrollback** (well beyond one screen, up to the daemon's history limit),
ANSI stripped, with a `# running` / `# exited exit=<code>` header. A freshly opened terminal can
read back empty for a moment while the shell starts. Once the shell has exited only the last
screen the center cached remains.

### Type into a terminal

```sh
coflux terminal send <taskId> --text="y" --enter    # type a line and press Enter
coflux terminal send <taskId> --enter               # just press Enter
```

For interactive answers (y/N, menus, a line a program is waiting for), and the fallback way to type a
command when `run` cannot (see "Errors"). Discipline:

- **`read` before `send`**: see what the terminal is waiting for before typing; never type blind.
  On a freshly opened terminal this means waiting for the shell prompt to appear.
- **Refused while the user is taking over**: that is not an error, it is by design; humans always
  win. Stop when refused; use `notify` to communicate, do not retry.
- **After a send timeout do not resend right away**: `read` first to check whether the input
  actually landed; duplicated input is worse than lost input.
- A single text is capped at 64 KB; this is an interactive input channel, not a file transfer.

### Close a terminal

```sh
coflux terminal close <taskId>
```

Ends the terminal (the shell and whatever runs in it) and reports `exited exit=<code>`; the same
effect as the account CLI's `stop`. Close the terminals you opened for a one-off step once you have
read what you needed; leave the ones the user is meant to keep (a dev server, a shell they are using).

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
that terminal was opened before the daemon upgrade, open a new one; "never signalled prompt
readiness" = this terminal's shell is not zsh, bash or fish started through coflux's rc chain (or
the integration was bypassed), so the command was **not** typed and `wait` cannot observe commands
there: the terminal is open all the same, use `read` and `send` with it; "busy" = a command is
still running in that terminal, `wait` for it or `read` first; "unknown action terminal.run" = this
machine's daemon is older than the CLI, tell the user to run `cofluxd update && cofluxd restart`
(the terminal was opened as a plain shell, nothing was run); "daemon is not connected to the
center" only appears on `new`/`list`/`ports`, retry once it reconnects.

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
coflux terminal run <terminalId> --remote --cmd <command>
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

`--remote` selects account access, including other workspaces on this machine. The semantics are the
same as the local commands: `--cmd` and `run` type a command in after the prompt is ready, `wait`
returns `finished` with the command's exit code (or `exited` with the shell's) and `timedOut` on the
deadline, `list` shows `busy` and `lastCommandExitCode` for live terminals, and `stop` is `close`.
Read before sending; stop immediately when the user takes over. If a write times out, inspect the
result before retrying. Exiting the CLI does not stop its terminals. Delete workspaces through
`coflux workspace remove` so the filesystem and workspace records stay consistent.

## Boundaries

- You can open, run, wait, read, type and close, but **typing is a restricted write with humans
  first**: neither `run` nor `send` can write into a terminal the user is taking over (you are
  refused explicitly), and the user taking over at any time displaces you. Do not fight a human for
  a terminal; `wait` and `read` keep working while they have it.
- Local commands only see **the workspace your cwd is in** (`coflux workspace` says which one);
  use the account CLI for other workspaces and machines in the same account.
- A workspace has a cap on concurrently live terminals (default 8, including the user's own).
  On hitting the cap, `list` first: usually some finished terminals were never collected. If the
  user really filled it up, `notify` them instead of forcing it.
- `new`/`list`/`ports` and account commands need the daemon connected to the center; "letting the
  user see" is their whole point. `run`/`wait`/`read`/`send`/`close`/`notify`/`progress` do not
  depend on the center. When disconnected they fail loudly rather than degrade silently.
- `COFLUX_*` variables exist only in PTYs opened by coflux; exporting or changing them yourself
  has no effect, the center only trusts the ids it issued. `COFLUX_WORKSPACE_ID` always means the
  workspace this terminal was **opened** in and goes stale the moment coflux follows you into a
  worktree; both "where does this terminal belong now" and "where am I acting" come from
  `coflux workspace`.
