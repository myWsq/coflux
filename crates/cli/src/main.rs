//! coflux（Rust 版）—— 跑在 coflux 终端里的 agent 与 Claude 插件 hook 用的那组命令（plan 112）。
//!
//! 与 npm 版 `packages/cli/coflux.mjs` 同名并存：coflux 终端里靠 supervisor 前置的
//! `$COFLUX_HOME/bin` 命中本二进制（零 node 依赖，供桌面版内置，plan 113），用户自己的终端里命中
//! npm 版。两版共享账号 API；本 crate 提供账号登录、跨设备操作与本地 Agent 命令，逐命令对齐请求体、
//! stdout 短语与退出码；宿主管理由 Coflux.app 或 cofluxd 独立负责。

mod account;
mod annotations;
mod canvas;
mod args;
mod browser_login;
mod commands;
mod gateway;
mod handle;
mod integration;
mod secret;
mod text;
mod ui;

/// `✗ Error: <first line>` and the remaining lines as the next step, on stderr; exit 1. A
/// one-line message gets the generic next step (the node `die`).
pub fn die(message: &str) -> ! {
    match message.split_once('\n') {
        Some((what, next)) => ui::fail(what, next, 1),
        None => ui::fail(message, ui::HELP_NEXT, 1),
    }
}

/// `die` with an explicit next step.
pub fn die_with(message: &str, next: &str) -> ! {
    ui::fail(message, next, 1)
}

const HELP: &str = r##"Work with Coflux terminals, workspaces and your account.

Usage:
  coflux <command> [subcommand] [flags]

Commands for agents running in a Coflux terminal:
  coflux terminal new [--title=<title>] [--cmd=<command>]
      Open a terminal: a login shell on a real tty in the workspace directory. The user sees
      it in the sidebar and can take it over. It stays open until you close it. With --cmd,
      the command is typed in once the prompt is ready, the same as new followed by run.
  coflux terminal run <taskId> --cmd=<command>
      Type a command into the terminal once its prompt is ready. Refused while the previous
      command is still running.
  coflux terminal wait <taskId> [--timeout=<seconds>] [--seq=<N>]
      Wait for the current (or Nth) command to finish and print "# finished exit=<code>",
      or "# exited exit=<code>" when the shell itself ended. Default timeout: 30 minutes.
  coflux terminal read <taskId> [--lines=<N>]
      Print the end of the terminal's scrollback as plain text. Default: the last 200 lines.
  coflux terminal send <taskId> --text=<text> [--enter]
      Type text into the terminal; --enter adds Enter. Refused while the user has taken over.
  coflux terminal list
      List this workspace's terminals with their status and exit code. Live ones also show
      busy or idle and the exit code of their last command.
  coflux terminal close <taskId>
      End the terminal.
  coflux notify "<message>"
      Send the user a notification. Confirmed once the server has saved it.
  coflux progress "<message>"
      Show a progress line on the workspace card. The next one replaces it.
  coflux ports
      List this workspace's listening ports and their preview URLs.
  coflux secret ask NAME --reason "<why>" [--timeout <seconds>]
  coflux secret exec NAME [NAME…] -- <cmd> [args…]
  coflux secret inject NAME --file <path> [--key KEY]
      Get a secret (API key, password) from the user on their Coflux desktop without the
      value entering your context: ask prints only provided | declined | cancelled; exec
      runs a command with the value in a same-name environment variable and shows it as ***
      in the output; inject writes KEY=value into a dotenv file in this workspace.
      Details: coflux secret help
  coflux annotations list [--json]
  coflux annotations watch [--timeout <seconds>] [--json]
  coflux annotations resolve <id> --note "<what you changed>"
      Browser annotations: elements the user marked in Coflux's built-in browser for this
      workspace, with their comment, component names and source location when known,
      selector, and screenshot/reference image paths. list prints the pending ones as
      markdown; watch blocks until there are some (default 30 minutes); after implementing
      one, resolve it with a note the user reads to review the change.
  coflux canvas show <file.html> [--title "<title>"]
  coflux canvas list [--json]
      Show an HTML file (a mockup, a comparison, research results) to the user in a tab of
      their Coflux desktop. Files beside it load too. show returns at once; run it again on
      the same file after editing. Feedback comes as annotations or in the conversation.
  coflux executor run --prompt=<task> [--title=<title>] [--write] [--timeout <seconds>]
      Hand a well-bounded sub-task to the built-in executor and wait for its final reply and
      the files it changed. Each run is one-shot. Read-only unless --write, with one writing
      run per workspace at a time. It has no network and never commits. --title names the
      progress card the user sees on this terminal. Needs Coflux.app on this machine.
  coflux workspace
      Print one JSON line: workspaceId (where your local commands land), path,
      owningWorkspaceId (the workspace this terminal belongs to) and moved.
  coflux workspace enter <path>
      Enter a workspace of the same repository and move this terminal there. Use the
      returned path explicitly in later tool calls.
  coflux workspace locate [path]
      Move this terminal to the workspace that owns path (default: the current directory),
      registering a worktree of the same repository when needed. The plugin calls this.
  coflux workspace forget <path>
      The worktree at path was deleted: move its terminals back to the main workspace and
      drop its record. Does not run git worktree remove.
  coflux hook <claude|codex>
      Forward an agent hook event from stdin or argv to this device. Never fails the agent.

Account commands (JSON output):
  coflux login [--server <url>]
      Sign in through the browser. Over SSH, or with COFLUX_LOGIN_PASTE=1, paste a code.
  coflux login --username <name> --password-stdin [--server <url>]
  coflux whoami | logout
  coflux device list | project list | workspace list
  coflux device exec <deviceId> --cmd=<command> [--cwd=<dir>] [--timeout=<seconds>]
      Run one command on another device, like ssh host "cmd": it runs under sh -c, stdout
      and stderr come back separately, the last line is "# exit=<code>", and the exit code
      is the remote one (255 when this command itself fails). Not a terminal: no PTY,
      nothing in the sidebar, no stdin. --cwd defaults to the device user's home and must be
      absolute or start with ~. --timeout defaults to 60 seconds, at most 600. For
      passwords, TUIs or long work the user should see, use coflux terminal new.
  coflux project import <path> [--device <id>] [--name <name>]
      Turn a git repository on a device into a project with its main workspace and print
      one JSON line: projectId, name, repoPath, defaultBranch, workspaceId, path,
      alreadyImported. <path> is resolved on the device and must be absolute or start with
      ~; to import the current directory, pass "$PWD". --device defaults to
      COFLUX_DEVICE_ID. Importing the same repository again returns the existing project
      with alreadyImported=true.
  coflux workspace new --project <id> --branch <branch> [--existing-branch]
  coflux workspace rename <id> --name <name> | workspace remove <id>
  coflux terminal new --workspace <id> [--cmd <command>] [--title <title>]
  coflux terminal list [--device <id>] [--workspace <id>]
  coflux terminal run|read|wait|send|stop|remove <id> --remote
  coflux ports --remote
      When the Coflux app is signed in, these use its account; otherwise run coflux login.

Ids and handles:
  Wherever an id is accepted you can pass a handle, coflux:<kind>:<first 8 of id>, for
  example coflux:workspace:3f2a1b7c (case-insensitive). Results carry it as ref. A prefix
  that matches several entities asks for the full id; a handle of the wrong kind is an error.

Flags:
  -h, --help    Show this help

Environment:
  COFLUX_AGENT_TIMEOUT_MS    Lower the wait for one local request (default 30000), for hook
                             scripts with a hard time limit
  NO_COLOR                   Turn off colour

To manage this device, use Coflux.app or cofluxd."##;

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().is_some_and(|arg| arg == "agent") {
        if let Err(error) = integration::run(&raw[1..]) { die(&error); }
        return;
    }
    // `secret exec` needs the raw argv: everything after `--` is the child's command line.
    if raw.first().is_some_and(|arg| arg == "secret") {
        secret::run(&raw[1..]);
        return;
    }
    let parsed = match args::parse(std::env::args().skip(1)) {
        Ok(parsed) => parsed,
        Err(error) => die_with(&error, ui::HELP_NEXT),
    };
    let command = parsed.positional(0);
    if parsed.flag("help") || command == Some("help") || command.is_none() {
        println!("{HELP}");
        return;
    }
    let command = command.unwrap_or_default();
    if account::handles(&parsed) {
        if let Err(error) = account::run(&parsed) { die(&error); }
        return;
    }
    match command {
        "hook" => commands::run_hook(&parsed),
        "terminal" => commands::run_terminal(&parsed),
        "notify" => commands::run_notify(&parsed),
        "progress" => commands::run_progress(&parsed),
        "ports" => commands::run_ports(),
        "executor" => commands::run_executor(&parsed),
        "workspace" => commands::run_workspace(&parsed),
        "annotations" => annotations::run(&parsed),
        "canvas" => canvas::run(&parsed),
        other => {
            die_with(
                &format!("Unknown command: {other}"),
                "Run coflux --help to see the commands. To manage this device, use Coflux.app or cofluxd.",
            );
        }
    }
}
