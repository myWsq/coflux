# Account CLI: across workspaces and devices

Read this before any account command: other workspaces on this machine, other devices, child
workspaces, remote terminals, turning a repository into a project, or running one command on
another machine.

## Contents

- Login, output and the command list
- Semantics of the remote terminal commands
- Turn a repository into a project (`project import`)
- Run one command on another machine (`device exec`)
- `device exec` or a terminal?

## Login, output and the command list

The bundled CLI can use the desktop app's login without receiving its token. For a standalone CLI,
use `coflux login --username <account> --password-stdin`; the user supplies the password safely,
never as a command argument. Account commands return JSON. A workspace ID identifies its device.

```sh
coflux device list
coflux device exec <deviceId> --cmd="<command>" [--cwd=<dir>] [--timeout=<seconds>]
coflux project list --device <deviceId>
coflux project import <path> [--device <deviceId>] [--name <name>]
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

Every id above also accepts a handle (`coflux:<kind>:<short>`, see the skill's "Entity handles").

## Semantics of the remote terminal commands

`--remote` selects account access, including other workspaces on this machine. The semantics are the
same as the local commands: `--cmd` and `run` type a command in after the prompt is ready, `wait`
returns `finished` with the command's exit code (or `exited` with the shell's) and `timedOut` on the
deadline, `list` shows `busy` and `lastCommandExitCode` for live terminals (fed by the device's
checkpoints, so this view lags a couple of seconds behind reality; the local `coflux terminal list`
is immediate), and `stop` is `close`.
Read before sending; stop immediately when the user takes over. If a write times out, inspect the
result before retrying. Exiting the CLI does not stop its terminals. Delete workspaces through
`coflux workspace remove` so the filesystem and workspace records stay consistent.

## Turn a repository into a project

```sh
coflux project import "$PWD"
coflux project import /srv/checkouts/api --device <deviceId> --name api
```

A repository that is not a project yet has no workspaces, so nothing else in this skill can reach
it: `workspace new` needs a `projectId`. This is the command that creates one, without the user
having to click Import in the desktop app.

`<path>` is required and must be **absolute or start with `~/`** — it is resolved on the target
device, so importing the current directory is written explicitly as `"$PWD"`. Any path inside the
repository imports the repository root. `--device` selects the machine and defaults to
`COFLUX_DEVICE_ID`; with neither, the command fails rather than guessing. `--name` overrides the
project name, which otherwise comes from the git remote and falls back to the directory name.

Success is one line of JSON: `projectId`, `name`, `repoPath`, `defaultBranch`, the main workspace's
`workspaceId` and `path`, and `alreadyImported`. A repository root on a device has exactly one
project, so importing the same repository twice returns the existing one with
`alreadyImported: true` and creates nothing — re-running it is safe. Failures are one sentence and a
non-zero exit: "不是 git 仓库" (the path is not inside a repository), "设备离线，无法执行该操作"
(that device exists but is not connected), "设备 <id> 不存在或不属于当前账号" (no device of this
account has that id — fix what you typed rather than go looking at the machine; a bare `b6767697`
with no `coflux:device:` prefix lands here), and a submitted-but-unfinished import tells you to check
`coflux project list`.

A project the user archived in the desktop app keeps its workspaces but is hidden from their
sidebar, and its terminals were closed and deleted when it was archived. In `coflux project list` its
entry carries `archivedAt` (milliseconds since the epoch); an active project has no such field.
`workspace new` and `terminal new` in an archived project fail with a message containing
"项目已归档" — do not retry or work around it: tell the user, who can unarchive it in the desktop app
under Settings → 已归档项目 (archived projects). Importing the repository of an archived project
unarchives it and returns that same project with `alreadyImported: true`, so it reappears in the
user's sidebar.

## Run one command on another machine

```sh
coflux device exec <deviceId> --cmd="cd /opt/app && git rev-parse HEAD"
coflux device exec <deviceId> --cmd="systemctl is-active caddy" --cwd=/etc --timeout=10
```

This is `ssh host "cmd"` for the devices in this account, and it is **not a Terminal**: no PTY on
the device, nothing in the user's sidebar, no draw on any workspace's terminal cap, and no workspace
required — a device whose directories were never registered as coflux workspaces is still reachable.
The command string is handed to the remote `sh -c`, so pipes, `&&`, redirection, globs and `$VAR` all
work, and quoting is yours to get right.

Its output is not JSON: stdout goes to stdout, stderr goes to stderr (always separate, and each one
carries an explicit marker if it had to be truncated), and the last line is `# exit=<code>`. **The
CLI's exit code is the remote command's**, so an ordinary shell test around it works. The CLI's own
failures — device offline (it exists and is not connected), no device of this account with that id
(`设备 <id> 不存在或不属于当前账号`: a mistyped or bare-prefix id, **not** an outage to investigate),
that device's daemon too old (`cofluxd update && cofluxd restart` there), `--cwd` missing or not a
directory, the timeout elapsing — are reported as `✗ Error:` with a next step and exit **255**, so a
remote exit 1 is never confused with "it never ran".

`--cwd` is the only addressing: an absolute path or a `~` prefix, defaulting to the daemon user's
HOME. To run inside a workspace, pass the `path` from `coflux workspace list --device <deviceId>`.
There is no `--workspace`, and there is **no stdin**.

## `device exec` or a terminal?

A division of labour, not a limitation:

- **`device exec`** when the command is short and what you want is its result: a version check, a
  config grep, a service status, a one-line remote fix. `--timeout` defaults to 60 seconds and is
  capped at 600; a timeout kills the remote process and is a definite failure, never a partial
  answer. Output is buffered, so nothing appears until the command ends.
- **`coflux terminal new --workspace <workspaceId>`** when the job is long, when the user should be
  able to watch it and take it over, or when a human has to type something into it (a `sudo`
  password, a confirmation, a TUI). That is what a Terminal is for, and exec deliberately cannot do
  it.
