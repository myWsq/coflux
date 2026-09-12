//! Per-invocation integration. The launcher may update; hooks and skill files may not.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::os::unix::{fs::PermissionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod workspace;

pub use workspace::enter as enter_workspace;

const SKILL: &str = include_str!("../../../packages/cli/skills/coflux/SKILL.md");
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

fn home() -> PathBuf {
    std::env::var_os("COFLUX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".coflux")
        })
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}
fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}
fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
fn private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}
fn atomic_json(path: &Path, value: &Value) -> io::Result<()> {
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), now()));
    fs::write(&temporary, value.to_string())?;
    let result = fs::rename(&temporary, path);
    let _ = fs::remove_file(&temporary);
    result
}

/// Hash the executable itself: it embeds all integration behavior and the skill.
fn prepare() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let bytes = fs::read(&executable).map_err(|e| e.to_string())?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    let parent = home().join("agent-integrations");
    private_dir(&parent).map_err(|e| e.to_string())?;
    let root = parent.join(&id);
    let assets = [
        ("skills/coflux/SKILL.md", SKILL.to_string()),
        (".claude-plugin/plugin.json", json!({"name":"coflux", "version":env!("CARGO_PKG_VERSION"), "description":"Coflux terminal integration"}).to_string()),
        ("hooks/hooks.json", claude_hooks(&root).to_string()),
        ("integration.json", json!({"schemaVersion":1,"id":id,"cliVersion":env!("CARGO_PKG_VERSION")}).to_string()),
    ];
    let validate = || -> Result<(), String> {
        let installed = fs::read(root.join("coflux")).map_err(|e| e.to_string())?;
        if Sha256::digest(&installed) != Sha256::digest(&bytes)
            || assets.iter().any(|(path, expected)| {
                fs::read_to_string(root.join(path)).ok().as_ref() != Some(expected)
            })
        {
            return Err("Coflux integration files are damaged; reinstall this version".into());
        }
        Ok(())
    };
    if root.is_dir() {
        validate()?;
        return Ok(root);
    }
    let temporary = parent.join(format!(".{}-{}", std::process::id(), now()));
    let result = (|| -> io::Result<()> {
        private_dir(&temporary)?;
        fs::write(temporary.join("coflux"), &bytes)?;
        fs::set_permissions(temporary.join("coflux"), fs::Permissions::from_mode(0o755))?;
        for (path, content) in &assets {
            let target = temporary.join(path);
            fs::create_dir_all(target.parent().unwrap())?;
            fs::write(target, content)?;
        }
        match fs::rename(&temporary, &root) {
            Ok(()) => Ok(()),
            Err(_) if root.is_dir() => Ok(()),
            Err(e) => Err(e),
        }
    })();
    let _ = fs::remove_dir_all(&temporary);
    result.map_err(|e| e.to_string())?;
    validate()?;
    Ok(root)
}
fn hook_command(root: &Path, host: &str) -> String {
    format!(
        "{} agent hook {host}",
        quote(&root.join("coflux").to_string_lossy())
    )
}
fn claude_hooks(root: &Path) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in EVENTS.iter().copied().chain([
        "PostToolUseFailure",
        "Notification",
        "StopFailure",
        "WorktreeRemove",
    ]) {
        hooks.insert(event.to_string(), json!([{"hooks":[{"type":"command","command":hook_command(root,"claude"),"timeout":8}]}]));
    }
    json!({"hooks":hooks})
}
fn codex_args(root: &Path) -> Vec<String> {
    EVENTS
        .iter()
        .flat_map(|event| {
            [
                "-c".to_string(),
                format!(
                    "hooks.{event}=[{{hooks=[{{type=\"command\",command={},timeout={}}}]}}]",
                    serde_json::to_string(&hook_command(root, "codex")).unwrap(),
                    if *event == "SessionEnd" { 3 } else { 8 }
                ),
            ]
        })
        .collect()
}
fn local(action: &str, path: Option<&str>) -> Result<Value, String> {
    local_at(action, path, &crate::gateway::caller_cwd())
}
fn local_at(action: &str, path: Option<&str>, cwd: &str) -> Result<Value, String> {
    let mut body = json!({"action":action,"pid":crate::gateway::pid(),"ppid":crate::gateway::ppid(),"cwd":cwd});
    if let Some(path) = path {
        body["path"] = Value::from(path);
    }
    let response = crate::gateway::post_json(
        crate::gateway::local_gateway_port()?,
        "/agent",
        &body.to_string(),
        Duration::from_millis(1800),
    )?;
    let value: Value = serde_json::from_slice(&response.body).map_err(|e| e.to_string())?;
    if !response.ok() || value["ok"] != true {
        return Err(string(&value, "error"));
    }
    if action.starts_with("workspace.")
        && action != "workspace.forget"
        && value["workspaceId"].as_str().is_none_or(str::is_empty)
    {
        return Err("Local runtime returned an incompatible workspace response".into());
    }
    Ok(value)
}
fn status_root() -> PathBuf {
    // Hash environment coordinates instead of accepting them as filesystem paths.
    home().join("agent-runs").join(format!(
        "{:x}",
        Sha256::digest(env("COFLUX_SESSION_ID").as_bytes())
    ))
}
fn status_file() -> Option<PathBuf> {
    let run = env("COFLUX_AGENT_RUN");
    if !run.is_empty() && run.bytes().all(|c| c.is_ascii_digit() || c == b'-') {
        Some(status_root().join(format!("{run}.json")))
    } else {
        None
    }
}
fn record(state: &str, host: &str) {
    let Some(path) = status_file() else {
        return;
    };
    if private_dir(&status_root()).is_err() {
        return;
    }
    let mut previous = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(json!({}));
    previous["pid"] = json!(previous["pid"]
        .as_u64()
        .unwrap_or(std::process::id() as u64));
    previous["agent"] = json!(host);
    previous["state"] = json!(state);
    previous["integration"] = json!(env("COFLUX_AGENT_BUNDLE"));
    previous["updatedAt"] = json!(now().to_string());
    let _ = atomic_json(&path, &previous);
}
fn emit_context(root: &Path, workspace: &Value, host: &str, event: &str) {
    let workspace_id = workspace["workspaceId"].as_str().unwrap_or_default();
    if let Some(path) = status_file() {
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(mut status) = serde_json::from_slice::<Value>(&bytes) {
                status["workspaceId"] = Value::from(workspace_id);
                status["workspacePath"] = workspace["path"].clone();
                let _ = atomic_json(&path, &status);
            }
        }
    }
    let selection = if workspace["explicitSelection"] == true {
        format!(
            "\nSelected working directory: {}\n{}",
            json!(workspace["path"]),
            workspace::DIRECTORY_INSTRUCTION
        )
    } else {
        String::new()
    };
    let context = format!("<coflux-session>\nYou are in a Coflux terminal. The user can watch and take over.\nDevice: {}\nProject: {}\nWorkspace: {}\nTerminal: {}\nSession: {}\nUse `coflux` for local terminal/progress/notify/ports operations and account operations across devices. Query `coflux workspace` after changing directories; these coordinates are a snapshot.{}\nIntegration: {}\nRead {} for the complete Coflux skill.\n</coflux-session>",env("COFLUX_DEVICE_ID"),env("COFLUX_PROJECT_ID"),workspace_id,env("COFLUX_TASK_ID"),env("COFLUX_SESSION_ID"),selection,root.file_name().unwrap_or_default().to_string_lossy(),root.join("skills/coflux/SKILL.md").display());
    if event == "SessionStart" {
        println!("{context}");
    } else if host == "claude" || host == "codex" {
        println!(
            "{}",
            json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":context}})
        );
    }
}
fn hook(host: &str) {
    if env("COFLUX_SESSION_ID").is_empty() {
        return;
    }
    // A bounded input reader is shared with the ordinary messenger.
    let Some(payload) = crate::commands::read_stdin_json() else {
        return;
    };
    let event = string(&payload, "hook_event_name");
    let root = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_owned))
        .unwrap_or_default();
    let event = event.as_str();
    if event == "PreToolUse"
        && host == "claude"
        && !env("COFLUX_PROJECT_ID").is_empty()
        && payload["tool_name"] == "Bash"
    {
        let guarded = regex::Regex::new(
            r"\bgit\b(?:\s+-{1,2}[\w-]+(?:=\S+|\s+\S+)?)*\s+worktree\s+(remove|move)\b",
        )
        .unwrap();
        if guarded.is_match(
            payload["tool_input"]["command"]
                .as_str()
                .unwrap_or_default(),
        ) {
            println!(
                "{}",
                json!({"hookSpecificOutput":{
                    "hookEventName":"PreToolUse", "permissionDecision":"deny",
                    "permissionDecisionReason":"Use coflux workspace list and coflux workspace remove <workspaceId> to remove a managed worktree and its sidebar record. Moving worktrees is unsupported; remove and recreate instead. Claude Code may clean up its own worktrees normally."
                }})
            );
        }
    }
    if host == "codex" && workspace::hook(&root, &payload) {
        // Explicit selections are independent of the host's original cwd.
    } else if event == "SessionStart" {
        let located = local("workspace.locate", Some(&string(&payload, "cwd")))
            .or_else(|_| local("workspace.current", None));
        match located {
            Ok(workspace) => {
                record("ready", host);
                emit_context(&root, &workspace, host, event);
            }
            Err(_) => {
                record("unavailable", host);
                println!("<coflux-session>Coflux integration is unavailable. Run `coflux agent status` to inspect it; do not reuse old session coordinates.</coflux-session>");
            }
        }
    } else if event == "UserPromptSubmit" {
        let previous = status_file()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or(json!({}));
        let ready = previous["state"] == "ready";
        match local("workspace.current", None) {
            Ok(workspace) => {
                if !ready || workspace["workspaceId"] != previous["workspaceId"] {
                    emit_context(&root, &workspace, host, event);
                }
                record("ready", host);
            }
            Err(_) => record("unavailable", host),
        }
    } else if event == "PostToolUse"
        && ["EnterWorktree", "ExitWorktree"].contains(&string(&payload, "tool_name").as_str())
    {
        if let Ok(workspace) = local("workspace.locate", Some(&string(&payload, "cwd"))) {
            emit_context(&root, &workspace, host, event);
        }
    } else if event == "WorktreeRemove" {
        let path = string(&payload, "worktree_path");
        if !path.is_empty() {
            let _ = local("workspace.forget", Some(&path));
        }
    } else if event == "SessionEnd" {
        record("ended", host);
    }
    if let Some(body) = crate::commands::build_hook_body(
        host,
        &payload,
        crate::gateway::pid(),
        crate::gateway::ppid(),
    ) {
        if let Ok(port) = crate::gateway::local_gateway_port() {
            let _ = crate::gateway::post_json(
                port,
                "/hook",
                &Value::Object(body).to_string(),
                Duration::from_millis(1500),
            );
        }
    }
}
fn launch(host: &str, args: &[String]) -> Result<(), String> {
    if !["claude", "codex"].contains(&host) {
        return Err("Expected claude or codex".into());
    }
    let mut command = Command::new(host);
    if !env("COFLUX_SESSION_ID").is_empty() && env("COFLUX_AGENT_INTEGRATION") != "off" {
        match prepare() {
            Ok(root) => {
                let run = format!("{}-{}", std::process::id(), now());
                // These variables belong only to the new agent and its hook descendants.
                std::env::set_var("COFLUX_AGENT_RUN", &run);
                std::env::set_var("COFLUX_AGENT_BUNDLE", &root);
                record("unconfirmed", host);
                command
                    .env("COFLUX_AGENT_RUN", run)
                    .env("COFLUX_AGENT_BUNDLE", &root);
                // Business commands and hooks use the same immutable CLI for this agent.
                let path = std::env::var_os("PATH").unwrap_or_default();
                let mut paths = vec![root.clone()];
                paths.extend(std::env::split_paths(&path));
                command.env(
                    "PATH",
                    std::env::join_paths(paths).map_err(|e| e.to_string())?,
                );
                if host == "claude" {
                    command.arg("--plugin-dir").arg(&root);
                } else {
                    command.args(codex_args(&root));
                }
                eprintln!(
                    "Coflux: integration loaded; waiting for the session hook.{}",
                    if host == "codex" {
                        " Review hooks in Codex when prompted; use /hooks if integration is not ready."
                    } else {
                        ""
                    }
                );
            }
            Err(error) => eprintln!("Coflux: integration unavailable ({error}); starting {host}."),
        }
    }
    command.args(args);
    Err(command.exec().to_string())
}
pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("prepare") => {
            let root = prepare()?;
            println!("{}", json!({"directory":root,"schemaVersion":1}));
            Ok(())
        }
        Some("run") => {
            let host = args.get(1).ok_or("Expected claude or codex")?;
            let mut rest = &args[2..];
            if rest.first().is_some_and(|a| a == "--") {
                rest = &rest[1..];
            }
            launch(host, rest)
        }
        Some("hook") => {
            if let Some(host) = args
                .get(1)
                .filter(|h| ["claude", "codex"].contains(&h.as_str()))
            {
                hook(host);
            }
            Ok(())
        }
        Some("status") => {
            let mut runs = Vec::new();
            if let Ok(entries) = fs::read_dir(status_root()) {
                for entry in entries.flatten() {
                    if entry.path().extension().is_some_and(|e| e == "json") {
                        if let Ok(bytes) = fs::read(entry.path()) {
                            if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
                                let pid = value["pid"].as_i64().unwrap_or(0);
                                let alive = pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0;
                                if !alive {
                                    value["state"] = Value::from("exited");
                                }
                                runs.push(value);
                            }
                        }
                    }
                }
            }
            println!("{}", json!({"runs":runs}));
            Ok(())
        }
        _ => {
            println!("coflux agent run <claude|codex> -- [agent arguments]\ncoflux agent prepare\ncoflux agent status\nSet COFLUX_AGENT_INTEGRATION=off to bypass automatic integration.");
            Ok(())
        }
    }
}
