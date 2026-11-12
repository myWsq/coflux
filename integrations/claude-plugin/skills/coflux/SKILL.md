---
name: coflux
description: Works inside a Coflux terminal and across the devices of the account. Locates the session (coflux-session block, COFLUX_* variables, coflux workspace), opens terminals the user can see and take over, runs commands in them, waits, reads scrollback, types into them, reports progress, notifies the user, lists preview URLs, shows the user an HTML page (a mockup, a comparison, research results) as a canvas in their desktop, hands a bounded sub-task to the built-in executor, implements the user's browser annotations and diff comments, and reaches other workspaces and devices through the account CLI (worktrees, remote terminals, one-shot device exec, project import). Use when running in a Coflux terminal, or when a task involves coflux, a workspace or worktree the user watches, a step only a human can type (password, confirmation, TUI), a dev server or test run the user should see, progress or notifications, preview URLs, a mockup or visual result the user should look at, annotations, the executor, or another machine in the account. Prefers zero-credential local commands in the current workspace; uses the account CLI across workspaces and devices.
---

# Working inside coflux

coflux lets the user watch agents working on many machines from a browser or a phone and take over
at any time. This skill gives you terminals the user can see and take over, a progress line and a
call button on the workspace card, preview URLs, and a way to operate the other workspaces and
devices under the account. **Use local commands in this workspace and account CLI commands across
workspaces and devices.**

| Track | Credentials | Reach | Use for |
|---|---|---|---|
| Local commands `coflux terminal/progress/notify/ports/canvas/executor/annotations` | none (the daemon identifies you by process tree) | **the workspace your cwd is in** | open, run, wait, read, send, close, report progress, call the user, preview URLs, showing the user an HTML page, the user's browser annotations and code comments, a bounded sub-task for the built-in executor: the default |
| Account CLI | app login or `coflux login` | all devices and workspaces in the account | child workspaces, remote terminals, one-shot commands on another device; JSON output |

You only ever talk to the local daemon. `run`/`wait`/`read`/`send`/`close`/`progress`/`executor`/
`annotations`/`canvas` complete inside it and never touch the center. `new`/`list`/`ports`/`notify` and the
account commands need the daemon connected to the center (terminals and notification history are
persisted centrally, preview URLs are minted by the center; "letting the user see" is their whole
point) and fail loudly rather than degrade silently when it is not.

## Figure out where you are first

With the coflux plugin installed, Claude Code and Codex receive a `<coflux-session>` block at
session start (and again after context compaction). Your coordinates are in it; use them directly.
Without that block (no plugin, hand-wired hooks, hook not trusted yet), read the environment:

```sh
env | grep '^COFLUX_'
```

- **`COFLUX_WORKSPACE_ID` is non-empty** (or the `<coflux-session>` block is present) → you are in a
  coflux terminal with an up-to-date daemon. Pass these ids to account CLI commands directly
  instead of guessing from the list commands:

  | Variable | Meaning |
  |---|---|
  | `COFLUX_DEVICE_ID` | id of the device you run on (the id in `coflux device list`) |
  | `COFLUX_PROJECT_ID` | owning project id; empty string for a directory workspace without a repository |
  | `COFLUX_WORKSPACE_ID` | the workspace this terminal was **opened** in (the id in `coflux workspace list`). Frozen when the terminal starts; the workspace the terminal *belongs to* can still change — `coflux workspace` is the authority |
  | `COFLUX_TASK_ID` | id of this terminal (the taskId / terminalId the terminal commands take) |
  | `COFLUX_SESSION_ID` | id of this PTY session |

  Under those id lines the `<coflux-session>` block prints a `<Kind> handle:` line for the device,
  project, workspace and terminal — the same ids in a short, typed, pasteable form (see "Entity
  handles"). A PTY session has no handle, a coordinate that is empty contributes no line, and the
  `COFLUX_*` variables themselves are always full UUIDs.

- **Variables empty or absent**: there is no local terminal context. Use `coflux whoami` to check
  account access and the account CLI to discover workspaces. Ask the user to log in when needed;
  never fabricate `COFLUX_*` coordinates.

### Ask where you are

Two workspaces matter: the **owning** workspace is the one this terminal belongs to (the user's
sidebar, turn state, branch and diff stats); it starts as `COFLUX_WORKSPACE_ID` and moves with you
into a git worktree. The **effective** workspace is the one your cwd is inside; every local command
acts on it. They differ once your cwd wanders into another worktree.

```sh
coflux workspace
{"workspaceId":"3f2a1b7c-9d44-4e1a-8f02-1b6c2d5e7a90","ref":"coflux:workspace:3f2a1b7c","path":"/Users/me/.coflux/worktrees/ws-b","owningWorkspaceId":"7c1d90ab-5e33-4c88-9a71-0d4f8b2e6c15","owningRef":"coflux:workspace:7c1d90ab","moved":true}
```

One line of JSON: `workspaceId` (+ `path`) is the **effective** workspace, `owningWorkspaceId` is the
workspace this terminal belongs to right now, `ref` and `owningRef` are those two workspaces'
handles (a daemon too old to send them leaves both keys out), and `moved` says whether they differ.
**About to call an account command right after a `cd`? Run `coflux workspace` first** and use the
`workspaceId` it prints; do not reuse `COFLUX_WORKSPACE_ID`.

Read [references/workspaces.md](references/workspaces.md) when your cwd leaves the workspace the
terminal was opened in, before moving the task into another worktree (`coflux workspace enter`,
Claude's `EnterWorktree`), or when a local command answers "not in this workspace or does not
exist" or "predates the daemon upgrade".

## Entity handles: ids you can paste

Every entity also has a **handle**, `coflux:<kind>:<short>`: `<kind>` is `device`, `project`,
`workspace` or `terminal`, `<short>` the first 8 hex characters of its UUID
(`coflux:terminal:9e21c4d0`; lowercase, read case-insensitively). **Anywhere an id is accepted, a
handle is accepted** — account commands, the `--device` / `--workspace` filters, local terminal
commands — and **anywhere an entity is returned its handle comes back** in a `ref` field beside the
unchanged UUID (local results' `taskId` is always the resolved UUID). When the user pastes a
`coflux:` string, use it as-is. The prefix is **mandatory**: a bare `b6767697` is forwarded as a
literal id and fails with a message that says nothing about syntax. Read
[references/handles.md](references/handles.md) when a handle does not resolve (nothing matches,
more than one, wrong kind, never a handle), for the `ref` fields of each command, or on an older
daemon.

## When to open a terminal

A coflux terminal is a real, persistent shell the user can see: a titled entry in their sidebar
that they can open, take over and type into, whose scrollback you can read back at any time,
modelled on Terminal.app's scripting surface (open a shell, *do script* into it, ask whether it is
busy, read its contents, close it). Whether a command runs in your own Bash or in a coflux terminal
is your call; a coflux terminal is worth it when the user's view of the process, or the user's
hands, matter:

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
stdout), started in the directory of the workspace your cwd is in (not always the one this terminal
was opened in), alive until `exit` is typed into it or you `close` it. It runs nothing by itself and
never exits on its own. The new terminal has the same `COFLUX_*` variables (pointing at its own
task/session ids, same workspace as you).

`--title` is the name the user sees in the sidebar; **name it properly**: "Run unit tests",
"Root ssh", never "terminal 1". `--cmd=...` is *do script*: the command is typed into the shell
**after the shell has signalled that its prompt is ready**, then the shell keeps living — exactly
`new` followed by `run`. The command line is capped at 64 KB. Always write `--cmd=<value>` and
`--title=<value>` with the `=`, never separated by a space: a value that starts with `-` is
otherwise taken for another option. `new` prints the terminal id on its first line whatever happens
next; when the command could not be typed it says so in an error on stderr (see "Errors").

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

`list` rows are `<handle>  <state>[ exit=<code>][ busy|idle][ last=<code>]  <title>`: the first
column is the terminal's handle, which every other terminal command accepts as its id;
`running` / `exited` / `idle` is the terminal, `busy` or `idle` says whether a command is running in
it right now, and `last=<code>` is the exit code of the last command that finished. `read` returns
the tail of the terminal's **full scrollback** (well beyond one screen, up to the daemon's history
limit), ANSI stripped, with a `# running` / `# exited exit=<code>` header. A freshly opened terminal
can read back empty for a moment while the shell starts. Once the shell has exited only the last
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
- `notify` = send a persistent account notification asking the user to look or respond

If unsure: when the user does not have to do anything, use `progress`.

### Call the user

```sh
coflux notify "Both approaches work; I need you to pick one"
```

Creates an unread notification in the account inbox with this terminal and its owning workspace as
the source; works from any owned Coflux shell, even without an agent process. The desktop shows an
in-app hint while foregrounded (also when the source workspace is already selected) and requests a
system notification when backgrounded; clicking opens the source terminal and marks it read. History
remains after reading, hooks, agent exit or source deletion, and a fully quit app syncs it on next
launch. Success means the server has saved it: a disconnected daemon, unsupported server or timeout
reports failure rather than silently falling back to workspace state. A transport retry of the same
request is deduplicated; a separate invocation is a new notification. Keep it concise (at most 2000
characters); use it for decisions, blocked work or review requests. Automatic approval/question
indicators are separate and create no inbox entries.

### Hand the user a clickable preview

```sh
coflux ports
```

Lists every listening port in this workspace with its public preview URL. After starting a dev
server, use it to get the URL and tell the user directly; they click it and nobody has to dig.

### Show the user an HTML page

```sh
coflux canvas show wiki/plans/home-redesign-mockup.html --title "Home redesign"
```

Opens the file as a canvas: a tab in the user's Coflux desktop, in the workspace your cwd is in.
Use it when the result is something to look at — a design mockup, options side by side, research
findings — instead of starting a server and asking the user to open an address. The command
returns at once. Read [references/canvas.md](references/canvas.md) before using it: what the page
may load, how to revise it, and how the user's feedback comes back.

### Hand a bounded sub-task to the executor

```sh
coflux executor run --title="Fix clippy in worker" --prompt="Fix every clippy warning in crates/worker" --write
```

A small agent built into coflux (macOS only) that works one self-contained, mechanical job in the
workspace your cwd is in while you keep your own context; the command blocks and prints its report
plus the files that changed. Read [references/executor.md](references/executor.md) before using it:
its sandbox (workspace-only writes, no commits, no network, one writer per workspace), how to write
the prompt, `--title`, `--timeout`, and what comes back.

### Get a secret from the user

When you need a value from the user that must not enter the conversation (API key, token, password,
private key, connection string…), use the `coflux-secret` skill
([`../coflux-secret/SKILL.md`](../coflux-secret/SKILL.md)) — never ask the user to paste it into the chat.

### Implement the user's annotations: browser annotations and code comments

```sh
coflux annotations list
coflux annotations resolve 3 --note "Primary button now uses the brand token; spacing from the 8px scale"
```

The user points at elements of a page in Coflux's built-in browser, or comments on lines of this
workspace's diff in its changes view; both land in one numbered list for the workspace your cwd is
in. The desktop types an instruction into your terminal, or the user simply asks you to handle the
annotations. Read [references/annotations.md](references/annotations.md) then: how to read each
kind, find the code, resolve with a note, and `watch` hands-free.

### Errors from local commands

Errors go to stderr as `✗ Error: <what happened>` followed by an indented line saying what to do
next; the sentences below come from the daemon and appear after `Error:`. Do what they say: "not
inside a coflux terminal" = you are not in a coflux session; "terminal is not in this workspace or
does not exist" = check the id with
`list`, and if you moved into another workspace that is exactly what a terminal of the other one
looks like (`coflux workspace` to confirm, `cd` back to reach it); "predates the daemon upgrade" =
that terminal was opened before the daemon upgrade, open a new one; "never signalled prompt
readiness" = this terminal's shell is not zsh, bash or fish started through coflux's rc chain (or
the integration was bypassed), so the command was **not** typed and `wait` cannot observe commands
there: the terminal is open all the same, use `read` and `send` with it; "busy" = a command is
still running in that terminal, `wait` for it or `read` first; "unknown action terminal.run" = this
machine's daemon is older than the CLI, tell the user to run `cofluxd update && cofluxd restart`
(the terminal was opened as a plain shell, nothing was run); "daemon is not connected to the
center" only appears on `new`/`list`/`ports`/`notify`, retry once it reconnects. A terminal handle
that names the wrong kind, or whose prefix matches more than one terminal in this workspace, has
its own sentence each — see "When a handle does not resolve" in `references/handles.md`; an unknown
handle shares the "not in this workspace or does not exist" sentence above, on purpose.

## Account CLI: across workspaces and devices

Account commands return JSON; they use the desktop app's login (the bundled CLI never receives its
token) or `coflux login --username <account> --password-stdin`. A workspace ID identifies its
device; `--remote` selects account access, including other workspaces on this machine, with the
same semantics as the local commands (`stop` is `close`).

```sh
coflux device list
coflux device exec <deviceId> --cmd="<command>" [--cwd=<dir>] [--timeout=<seconds>]   # ssh-style one-shot, not a terminal
coflux project list --device <deviceId>
coflux project import <path> [--device <deviceId>] [--name <name>]                      # repository → project
coflux workspace list --device <deviceId>
coflux workspace new --project <projectId> --branch <branch>
coflux terminal new --workspace <workspaceId> --title <title> [--cmd <command>]
coflux terminal run|read|send|wait|stop|remove <terminalId> --remote ...
coflux terminal list --workspace <workspaceId>
coflux workspace rename|remove <workspaceId> ...
coflux ports --remote --device <deviceId>
```

Read [references/account-cli.md](references/account-cli.md) before using any of them: the full
argument forms, how `wait` / `list` / `stop` behave remotely, `project import` (path rules, JSON
result, its error sentences), `device exec` (output format, exit codes, `--cwd`, `--timeout`) and
when to prefer it over a terminal.

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
- `COFLUX_*` variables exist only in PTYs opened by coflux; exporting or changing them yourself
  has no effect, the center only trusts the ids it issued. `COFLUX_WORKSPACE_ID` goes stale the
  moment coflux follows you into a worktree; "where does this terminal belong now" and "where am I
  acting" both come from `coflux workspace`.

## Managed terminal integration

Coflux terminals load this capability for Claude Code and Codex automatically. `coflux agent status`
shows this terminal's integration acknowledgements (an unconfirmed run has not successfully executed
its context hook; it does not prove that approval is pending). Codex asks for native hook review
when needed: use `/hooks`. Do not edit trust hashes or the user's global configuration. Each agent
keeps its own immutable CLI and skill files; relaunching the agent selects the installed device
version, including from an already-open supported shell. `COFLUX_AGENT_INTEGRATION=off claude` (or
`codex`) bypasses managed integration for one invocation; `coflux agent run <claude|codex> -- ...`
launches explicitly when a custom shell alias takes precedence over automatic integration.
