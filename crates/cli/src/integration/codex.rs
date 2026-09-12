//! A private app-server per interactive invocation, with process-local skill roots.
//! The watchdog owns the backend. Its stdin is a lifetime pipe from the launcher,
//! so even an uncatchable launcher exit tears down the backend and its children.
use serde_json::{json, Value};
use signal_hook::consts::{SIGHUP, SIGINT, SIGQUIT, SIGTERM};
use std::fs::{self, DirBuilder};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

const STARTUP: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);

fn takes_value(arg: &str) -> bool {
    matches!(
        arg,
        "-c" | "--config"
            | "--enable"
            | "--disable"
            | "-m"
            | "--model"
            | "-p"
            | "--profile"
            | "-s"
            | "--sandbox"
            | "-a"
            | "--ask-for-approval"
            | "-C"
            | "--cd"
            | "-i"
            | "--image"
            | "--add-dir"
            | "--local-provider"
            | "--remote"
            | "--remote-auth-token-env"
    )
}

/// Administrative and noninteractive commands retain the native command path.
/// An explicitly selected remote belongs to the user, not to this launcher.
pub(super) fn interactive(args: &[String]) -> bool {
    let mut positional = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if matches!(arg, "--help" | "-h" | "--version" | "-V" | "--remote")
            || arg.starts_with("--remote=")
        {
            return false;
        }
        if arg == "--" {
            break;
        }
        if takes_value(arg) {
            i += 2;
            continue;
        }
        if !arg.starts_with('-') && positional.is_none() {
            positional = Some(arg);
        }
        i += 1;
    }
    !matches!(
        positional,
        Some(
            "agents"
                | "exec"
                | "e"
                | "review"
                | "login"
                | "logout"
                | "mcp"
                | "plugin"
                | "app-server"
                | "remote-control"
                | "app"
                | "completion"
                | "update"
                | "doctor"
                | "sandbox"
                | "debug"
                | "apply"
                | "a"
                | "queue"
                | "archive"
                | "delete"
                | "migrate-rollouts"
                | "unarchive"
                | "cloud"
                | "exec-server"
                | "features"
                | "help"
        )
    )
}

/// Config definitions are needed by the backend as well as the TUI. Session
/// choices (model, permissions, resume/fork, prompt) remain native TUI arguments.
fn server_options(args: &[String]) -> (Vec<String>, Option<PathBuf>) {
    let mut options = Vec::new();
    let mut cwd = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            break;
        }
        if matches!(arg, "-c" | "--config" | "--enable" | "--disable") {
            options.push(args[i].clone());
            if let Some(value) = args.get(i + 1) {
                options.push(value.clone());
            }
        } else if arg.starts_with("--config=")
            || arg.starts_with("--enable=")
            || arg.starts_with("--disable=")
            || (arg.starts_with("-c") && arg.len() > 2)
            || arg == "--strict-config"
            || arg == "--dangerously-bypass-hook-trust"
        {
            options.push(args[i].clone());
        } else if matches!(arg, "-C" | "--cd") {
            cwd = args.get(i + 1).map(PathBuf::from);
        } else if let Some(value) = arg
            .strip_prefix("--cd=")
            .or_else(|| arg.strip_prefix("-C").filter(|v| !v.is_empty()))
        {
            cwd = Some(PathBuf::from(value));
        }
        i += if takes_value(arg) { 2 } else { 1 };
    }
    (options, cwd)
}

fn copy_env(from: &Command, to: &mut Command) {
    for (name, value) in from.get_envs() {
        match value {
            Some(value) => {
                to.env(name, value);
            }
            None => {
                to.env_remove(name);
            }
        }
    }
}

/// Remote resume/fork rejects client-side permission overrides. Apply the user's
/// choices to our private backend instead; its config is the native authority.
fn permission_options(args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut frontend = Vec::new();
    let mut backend = Vec::new();
    let mut yolo = false;
    let mut automatic = false;
    let mut continuation = false;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            frontend.extend_from_slice(&args[i..]);
            break;
        }
        if matches!(arg, "--yolo" | "--dangerously-bypass-approvals-and-sandbox") {
            yolo = true;
        } else if arg == "--approve-for-me" {
            automatic = true;
        } else if matches!(arg, "-a" | "--ask-for-approval" | "-s" | "--sandbox") {
            let value = args.get(i + 1);
            if let Some(value) = value {
                let key = if matches!(arg, "-a" | "--ask-for-approval") {
                    "approval_policy"
                } else {
                    "sandbox_mode"
                };
                backend.extend(["-c".into(), format!("{key}={}", json!(value))]);
                i += 1;
            } else {
                frontend.push(args[i].clone());
            }
        } else if let Some((key, value)) = arg
            .strip_prefix("--sandbox=")
            .map(|v| ("sandbox_mode", v))
            .or_else(|| {
                arg.strip_prefix("-s")
                    .filter(|v| !v.is_empty())
                    .map(|v| ("sandbox_mode", v))
            })
            .or_else(|| {
                arg.strip_prefix("--ask-for-approval=")
                    .map(|v| ("approval_policy", v))
            })
            .or_else(|| {
                arg.strip_prefix("-a")
                    .filter(|v| !v.is_empty())
                    .map(|v| ("approval_policy", v))
            })
        {
            backend.extend(["-c".into(), format!("{key}={}", json!(value))]);
        } else {
            if matches!(arg, "resume" | "fork") {
                continuation = true;
            }
            let config = if matches!(arg, "-c" | "--config") {
                args.get(i + 1).map(String::as_str)
            } else {
                arg.strip_prefix("--config=")
                    .or_else(|| arg.strip_prefix("-c").filter(|v| !v.is_empty()))
            };
            let permission_config =
                config
                    .and_then(|s| s.split_once('='))
                    .is_some_and(|(key, _)| {
                        matches!(
                            key.trim().split('.').next().unwrap_or_default(),
                            "approval_policy"
                                | "approvals_reviewer"
                                | "sandbox_mode"
                                | "sandbox_workspace_write"
                                | "permission_profile"
                                | "default_permissions"
                                | "permissions"
                        )
                    });
            let count = if takes_value(arg) && args.get(i + 1).is_some() {
                2
            } else {
                1
            };
            if permission_config {
                backend.extend_from_slice(&args[i..i + count]);
            } else {
                frontend.extend_from_slice(&args[i..i + count]);
            }
            i += count - 1;
        }
        i += 1;
    }
    if automatic {
        backend.extend([
            "-c".into(),
            "approval_policy=\"on-request\"".into(),
            "-c".into(),
            "approvals_reviewer=\"auto_review\"".into(),
            "-c".into(),
            "sandbox_mode=\"workspace-write\"".into(),
        ]);
    }
    if yolo {
        backend.extend([
            "-c".into(),
            "approval_policy=\"never\"".into(),
            "-c".into(),
            "sandbox_mode=\"danger-full-access\"".into(),
        ]);
    }
    (
        if continuation {
            frontend
        } else {
            args.to_vec()
        },
        backend,
    )
}

fn stop(child: &mut Child, group: bool) {
    let pid = child.id() as i32;
    let target = if group { -pid } else { pid };
    // All targets are children created by this invocation, never daemon PIDs.
    unsafe {
        libc::kill(target, SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            break;
        }
        std::thread::sleep(POLL);
    }
    // Also reap backend descendants which outlived the app-server itself.
    unsafe {
        libc::kill(target, libc::SIGKILL);
    }
    let _ = child.wait();
}

struct Watchdog(Child);
impl Drop for Watchdog {
    fn drop(&mut self) {
        // Closing this pipe triggers cleanup even when the launcher is SIGKILLed.
        self.0.stdin.take();
        let _ = self.0.wait();
    }
}

pub(super) fn launch(base: &Command, root: &Path, args: &[String]) -> Result<i32, String> {
    // Codex app-server cannot load --profile. A remote TUI only forwards some
    // profile fields, silently losing others such as developer_instructions.
    // Preserve the native profile semantics until the server exposes this layer.
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            break;
        }
        if matches!(arg, "-p" | "--profile")
            || arg.starts_with("--profile=")
            || (arg.starts_with("-p") && arg.len() > 2)
        {
            eprintln!("Coflux: Codex profiles keep their native runtime. Hooks remain active; the Coflux skill is available through the session context's file path, not /skills.");
            let mut native = Command::new(base.get_program());
            copy_env(base, &mut native);
            native.args(base.get_args()).args(args);
            return Err(native.exec().to_string());
        }
        i += if takes_value(arg) { 2 } else { 1 };
    }
    let (options, cwd) = server_options(args);
    let (frontend_args, permissions) = permission_options(args);
    let mut watchdog = Command::new(root.join("coflux"));
    watchdog
        .args(["agent", "codex-bridge"])
        .args(base.get_args())
        .args(options)
        .args(permissions)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .process_group(0);
    copy_env(base, &mut watchdog);
    if let Some(cwd) = cwd {
        watchdog.current_dir(cwd);
    }
    let mut watchdog = Watchdog(watchdog.spawn().map_err(|e| e.to_string())?);
    let stdout = watchdog.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = io::BufReader::new(stdout)
            .take(64 * 1024)
            .read_line(&mut line)
            .map(|_| line);
        let _ = tx.send(result);
    });
    let ready = rx
        .recv_timeout(STARTUP + Duration::from_secs(2))
        .map_err(|_| "Codex skill server did not become ready".to_string())?
        .map_err(|e| e.to_string())?;
    let ready: Value = serde_json::from_str(&ready)
        .map_err(|_| "Codex skill server exited before becoming ready".to_string())?;
    let endpoint = ready["endpoint"].as_str().ok_or_else(|| {
        ready["error"]
            .as_str()
            .unwrap_or("Codex skill server failed")
            .to_string()
    })?;

    let stopped = Arc::new(AtomicBool::new(false));
    for signal in [SIGTERM, SIGHUP, SIGQUIT] {
        signal_hook::flag::register(signal, stopped.clone()).map_err(|e| e.to_string())?;
    }
    // Keyboard Ctrl-C is delivered to the frontend too; it owns interruption UI.
    signal_hook::flag::register(SIGINT, Arc::new(AtomicBool::new(false)))
        .map_err(|e| e.to_string())?;
    let mut frontend = Command::new(base.get_program());
    copy_env(base, &mut frontend);
    frontend
        .args(base.get_args())
        .args(["--remote", endpoint])
        .args(frontend_args);
    let mut frontend = frontend.spawn().map_err(|e| e.to_string())?;
    loop {
        if let Some(status) = frontend.try_wait().map_err(|e| e.to_string())? {
            return Ok(status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)));
        }
        if stopped.load(Ordering::Relaxed) {
            stop(&mut frontend, false);
            return Ok(128 + SIGTERM);
        }
        if watchdog.0.try_wait().map_err(|e| e.to_string())?.is_some() {
            stop(&mut frontend, false);
            return Err("Codex skill server stopped unexpectedly".into());
        }
        std::thread::sleep(POLL);
    }
}

struct SocketDir(PathBuf);
impl SocketDir {
    fn new() -> io::Result<Self> {
        // macOS Unix socket paths are limited to 104 bytes. TMPDIR and the bundle
        // path can both exceed that before adding a socket name.
        let path = PathBuf::from(format!(
            "/tmp/coflux-codex-{}-{}",
            std::process::id(),
            super::now()
        ));
        DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for SocketDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn rpc(
    ws: &mut WebSocket<UnixStream>,
    id: u64,
    method: &str,
    params: Value,
    stopped: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    ws.send(Message::Text(
        json!({"id":id,"method":method,"params":params}).to_string(),
    ))
    .map_err(|e| e.to_string())?;
    while !stopped.load(Ordering::Relaxed) && Instant::now() < deadline {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let msg: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if msg["id"] == id {
                    if msg.get("error").is_some() {
                        return Err(format!("Codex {method}: {}", msg["error"]));
                    }
                    return Ok(msg["result"].clone());
                }
            }
            Ok(Message::Ping(_)) => {
                ws.flush().map_err(|e| e.to_string())?;
            }
            Ok(Message::Close(_)) => {
                return Err("Codex closed the skill registration connection".into())
            }
            Ok(_) => (),
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                ()
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!("Codex {method} timed out or was cancelled"))
}

fn register(socket: &Path, stopped: &AtomicBool, server: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP;
    let stream = loop {
        if stopped.load(Ordering::Relaxed) || Instant::now() >= deadline {
            return Err("Codex skill server startup was cancelled or timed out".into());
        }
        if server.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("Codex app-server exited; this integration requires Unix transport and skills/extraRoots/set".into());
        }
        match UnixStream::connect(socket) {
            Ok(stream) => break stream,
            Err(_) => std::thread::sleep(POLL),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| e.to_string())?;
    let (mut ws, _) =
        tungstenite::client("ws://localhost/rpc", stream).map_err(|e| e.to_string())?;
    rpc(
        &mut ws,
        1,
        "initialize",
        json!({"clientInfo":{"name":"coflux","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),
        stopped,
        deadline,
    )?;
    ws.send(Message::Text(json!({"method":"initialized"}).to_string()))
        .map_err(|e| e.to_string())?;
    let root = std::env::current_exe().map_err(|e| e.to_string())?;
    let skills = root.parent().unwrap().join("skills");
    rpc(
        &mut ws,
        2,
        "skills/extraRoots/set",
        json!({"extraRoots":[skills]}),
        stopped,
        deadline,
    )?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let listed = rpc(
        &mut ws,
        3,
        "skills/list",
        json!({"cwds":[cwd],"forceReload":true}),
        stopped,
        deadline,
    )?;
    let expected = skills.join("coflux/SKILL.md");
    let found = listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
        .any(|skill| skill["path"].as_str() == expected.to_str());
    // Discovery must succeed, but the user's native enable/disable choice wins.
    if !found {
        return Err("Codex did not discover the Coflux skill".into());
    }
    let _ = ws.close(None);
    Ok(())
}

pub(super) fn serve(options: &[String]) -> Result<(), String> {
    let stopped = Arc::new(AtomicBool::new(false));
    for signal in [SIGTERM, SIGHUP, SIGQUIT, SIGINT] {
        signal_hook::flag::register(signal, stopped.clone()).map_err(|e| e.to_string())?;
    }
    let lifetime = stopped.clone();
    std::thread::spawn(move || {
        let _ = io::stdin().read(&mut [0]);
        lifetime.store(true, Ordering::Relaxed);
    });
    let directory = SocketDir::new().map_err(|e| e.to_string())?;
    let socket = directory.0.join("rpc.sock");
    let endpoint = format!("unix://{}", socket.display());
    let mut server = Command::new("codex")
        .args(options)
        .args(["app-server", "--listen", &endpoint])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = register(&socket, &stopped, &mut server);
    match &result {
        Ok(()) => println!("{}", json!({"endpoint":endpoint})),
        Err(error) => println!("{}", json!({"error":error})),
    }
    let _ = io::stdout().flush();
    if result.is_ok() {
        while !stopped.load(Ordering::Relaxed) {
            if !matches!(server.try_wait(), Ok(None)) {
                break;
            }
            std::thread::sleep(POLL);
        }
    }
    stop(&mut server, true);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }
    #[test]
    fn distinguishes_native_subcommands_and_option_values() {
        for values in [
            vec![],
            vec!["--yolo"],
            vec!["resume", "--last"],
            vec!["fork", "--last"],
            vec!["-m", "exec", "hello"],
            vec!["--", "exec"],
        ] {
            assert!(interactive(&args(&values)), "{values:?}");
        }
        for values in [
            vec!["exec", "hello"],
            vec!["--yolo", "exec", "hello"],
            vec!["-c", "model='test'", "plugin", "list"],
            vec!["resume", "--help"],
            vec!["--remote=unix:///tmp/user.sock"],
        ] {
            assert!(!interactive(&args(&values)), "{values:?}");
        }
    }
    #[test]
    fn extracts_backend_config_without_consuming_prompt_text() {
        let (options, cwd) = server_options(&args(&[
            "-c",
            "model='probe'",
            "--enable=apps",
            "--cd",
            "a b",
            "--",
            "--disable=apps",
        ]));
        assert_eq!(options, args(&["-c", "model='probe'", "--enable=apps"]));
        assert_eq!(cwd, Some(PathBuf::from("a b")));
    }

    #[test]
    fn resume_permissions_use_backend_config_and_keep_literal_arguments() {
        let (frontend, backend) = permission_options(&args(&[
            "--yolo",
            "-c",
            "model='probe'",
            "resume",
            "--last",
            "--",
            "--yolo",
        ]));
        assert_eq!(
            frontend,
            args(&["-c", "model='probe'", "resume", "--last", "--", "--yolo"])
        );
        assert_eq!(
            backend,
            args(&[
                "-c",
                "approval_policy=\"never\"",
                "-c",
                "sandbox_mode=\"danger-full-access\""
            ])
        );
        let (frontend, backend) = permission_options(&args(&[
            "fork",
            "--last",
            "-sread-only",
            "-a",
            "on-request",
        ]));
        assert_eq!(frontend, args(&["fork", "--last"]));
        assert_eq!(
            backend,
            args(&[
                "-c",
                "sandbox_mode=\"read-only\"",
                "-c",
                "approval_policy=\"on-request\""
            ])
        );
    }

    #[test]
    fn new_sessions_keep_native_permission_flags() {
        let original = args(&["--yolo", "-m", "resume", "hello"]);
        assert_eq!(permission_options(&original).0, original);
    }
}
