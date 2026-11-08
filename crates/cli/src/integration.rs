//! Per-invocation integration. The launcher may update; hooks and skill files may not.
use crate::handle;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::os::unix::{fs::PermissionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod codex;
mod workspace;
mod worktree_guard;

pub use workspace::enter as enter_workspace;
pub(crate) use worktree_guard::deny_decision as worktree_guard_decision;

const SKILL: &str = include_str!("../../../packages/cli/skills/coflux/SKILL.md");
const SECRET_SKILL: &str = include_str!("../../../packages/cli/skills/coflux-secret/SKILL.md");
/// The reference files the `coflux` skill links as `references/<topic>.md`: agents read them on
/// demand, so every one must be installed beside `SKILL.md` or the links point at nothing.
/// Adding a reference file is adding one row here (a test pins the list to the links in SKILL.md).
const SKILL_REFERENCES: &[(&str, &str)] = &[
    (
        "skills/coflux/references/account-cli.md",
        include_str!("../../../packages/cli/skills/coflux/references/account-cli.md"),
    ),
    (
        "skills/coflux/references/annotations.md",
        include_str!("../../../packages/cli/skills/coflux/references/annotations.md"),
    ),
    (
        "skills/coflux/references/executor.md",
        include_str!("../../../packages/cli/skills/coflux/references/executor.md"),
    ),
    (
        "skills/coflux/references/handles.md",
        include_str!("../../../packages/cli/skills/coflux/references/handles.md"),
    ),
    (
        "skills/coflux/references/workspaces.md",
        include_str!("../../../packages/cli/skills/coflux/references/workspaces.md"),
    ),
];
/// Claude events the managed integration hooks, each for a job other than turn state (which comes
/// from OSC 7501): session context and the agent session id (`SessionStart`, `UserPromptSubmit`),
/// the worktree guard (`PreToolUse`), worktree follow (`PostToolUse`), the session's end
/// (`SessionEnd`) and worktree forget (`WorktreeRemove`).
const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SessionEnd",
    "WorktreeRemove",
];
/// Codex events the managed integration hooks: session context, the agent session id and the
/// session's end.
const CODEX_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "SessionEnd"];

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
    let mut assets = vec![
        ("skills/coflux/SKILL.md", SKILL.to_string()),
        ("skills/coflux-secret/SKILL.md", SECRET_SKILL.to_string()),
        (".claude-plugin/plugin.json", json!({"name":"coflux", "version":env!("CARGO_PKG_VERSION"), "description":"Coflux terminal integration"}).to_string()),
        ("hooks/hooks.json", claude_hooks(&root).to_string()),
        ("integration.json", json!({"schemaVersion":1,"id":id,"cliVersion":env!("CARGO_PKG_VERSION")}).to_string()),
    ];
    assets.extend(
        SKILL_REFERENCES
            .iter()
            .map(|(path, content)| (*path, content.to_string())),
    );
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
    for event in CLAUDE_EVENTS.iter().copied() {
        hooks.insert(event.to_string(), json!([{"hooks":[{"type":"command","command":hook_command(root,"claude"),"timeout":8}]}]));
    }
    json!({"hooks":hooks})
}
fn codex_args(root: &Path) -> Vec<String> {
    CODEX_EVENTS
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
    local_within(action, path, cwd, Duration::from_millis(1800))
}
/// [`local_at`] with the caller's own time budget for the whole exchange.
fn local_within(
    action: &str,
    path: Option<&str>,
    cwd: &str,
    timeout: Duration,
) -> Result<Value, String> {
    // Identity is the transport's business (`gateway::local_post`): the kernel's on the agent
    // socket, pid/ppid added only on the TCP fallback.
    let mut body = serde_json::Map::new();
    body.insert("action".into(), Value::from(action));
    body.insert("cwd".into(), Value::from(cwd));
    if let Some(path) = path {
        body.insert("path".into(), Value::from(path));
    }
    let response = crate::gateway::local_post("/agent", body, timeout)
        .map_err(|error| error.message())?;
    let value: Value = serde_json::from_slice(&response.body).map_err(|e| e.to_string())?;
    if !response.ok() || value["ok"] != true {
        return Err(string(&value, "error"));
    }
    if action.starts_with("workspace.")
        && action != "workspace.forget"
        && value["workspaceId"].as_str().is_none_or(str::is_empty)
    {
        return Err("This device's Coflux sent an incompatible workspace response.\nUpdate Coflux on this device, then try again.".into());
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
/// The handle block of `<coflux-session>`: one `coflux:<kind>:<short>` line per coordinate,
/// labelled by kind, printed **after** the id lines and never replacing them.
///
/// The plugin's shell hook (`integrations/claude-plugin/scripts/session-context.sh`) is the other
/// emitter of this block and prints these lines identically, line for line — an agent must see the
/// same coordinates whichever way its terminal was started. A coordinate that is empty (a directory
/// workspace has no project) contributes no line rather than a truncated handle; when every
/// coordinate is empty the whole block, closing sentence included, disappears.
fn handle_lines(device: &str, project: &str, workspace: &str, terminal: &str) -> String {
    let mut lines = Vec::new();
    for (label, kind, id) in [
        ("Device", handle::HandleKind::Device, device),
        ("Project", handle::HandleKind::Project, project),
        ("Workspace", handle::HandleKind::Workspace, workspace),
        ("Terminal", handle::HandleKind::Terminal, terminal),
    ] {
        let text = handle::of(kind, id);
        if !text.is_empty() {
            lines.push(format!("{label} handle: {text}"));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    lines.push("Handles are interchangeable with the ids above in every coflux command.".into());
    format!("\n{}", lines.join("\n"))
}

/// The full `<coflux-session>` block. Besides the coordinates it always carries the secret
/// reminder with the absolute path of the `coflux-secret` skill: a Codex session started with a
/// profile registers no extra skill roots and reaches skills only through these file paths.
#[allow(clippy::too_many_arguments)]
fn session_context(
    root: &Path,
    device: &str,
    project: &str,
    workspace: &str,
    terminal: &str,
    session: &str,
    handles: &str,
    selection: &str,
) -> String {
    format!(
        "<coflux-session>\nYou are in a Coflux terminal. The user can watch and take over.\nDevice: {device}\nProject: {project}\nWorkspace: {workspace}\nTerminal: {terminal}\nSession: {session}{handles}\nUse `coflux` for local terminal/progress/notify/ports operations and account operations across devices. Query `coflux workspace` after changing directories; these coordinates are a snapshot.{selection}\nWhen you need a sensitive value from the user (API key, token, password, private key), use `coflux secret` (read {secret_skill}); never ask them to paste it into the chat.\nIntegration: {integration}\nRead {skill} for the Coflux skill; it links the reference files installed beside it.\n</coflux-session>",
        secret_skill = root.join("skills/coflux-secret/SKILL.md").display(),
        integration = root.file_name().unwrap_or_default().to_string_lossy(),
        skill = root.join("skills/coflux/SKILL.md").display(),
    )
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
    let handles = handle_lines(
        &env("COFLUX_DEVICE_ID"),
        &env("COFLUX_PROJECT_ID"),
        workspace_id,
        &env("COFLUX_TASK_ID"),
    );
    let context = session_context(
        root,
        &env("COFLUX_DEVICE_ID"),
        &env("COFLUX_PROJECT_ID"),
        workspace_id,
        &env("COFLUX_TASK_ID"),
        &env("COFLUX_SESSION_ID"),
        &handles,
        &selection,
    );
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
    // On PreToolUse the guard's deny decision is the only stdout (see `worktree_guard`).
    if host == "claude" {
        if let Some(decision) = worktree_guard::deny_decision(&payload) {
            println!("{decision}");
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
        let _ = crate::gateway::local_post("/hook", body, Duration::from_millis(1500));
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
                if host == "codex" && codex::interactive(args) {
                    let status = codex::launch(&command, &root, args)?;
                    record("ended", host);
                    std::process::exit(status);
                }
            }
            Err(error) => eprintln!("Coflux: integration unavailable ({error}); starting {host}."),
        }
    }
    command.args(args);
    Err(command.exec().to_string())
}
pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("codex-bridge") => codex::serve(&args[1..]),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `references/<topic>.md` the skill links must be embedded and installed beside it, and
    /// nothing is embedded that the skill no longer links: the two lists are one contract.
    #[test]
    fn every_reference_the_skill_links_is_embedded_and_installed() {
        let mut linked: Vec<String> = SKILL
            .match_indices("](references/")
            .map(|(start, marker)| {
                let rest = &SKILL[start + marker.len()..];
                let end = rest.find(')').expect("unterminated link in SKILL.md");
                format!("skills/coflux/references/{}", &rest[..end])
            })
            .collect();
        linked.sort();
        linked.dedup();
        let mut embedded: Vec<String> = SKILL_REFERENCES
            .iter()
            .map(|(path, _)| path.to_string())
            .collect();
        embedded.sort();
        assert!(!linked.is_empty(), "SKILL.md links no reference files");
        assert_eq!(linked, embedded);
        for (path, content) in SKILL_REFERENCES {
            assert!(!content.trim().is_empty(), "{path} is empty");
            assert!(
                !content.contains("](references/"),
                "{path} links another reference; keep references one level deep from SKILL.md"
            );
        }
        // The secret skill is linked from the coflux skill and installed on its own row.
        assert!(SKILL.contains("](../coflux-secret/SKILL.md)"));
    }

    /// The exact lines the plugin's shell hook must print too
    /// (`integrations/claude-plugin/scripts/session-context.sh`). Both emitters, one format.
    #[test]
    fn session_block_handles_are_labelled_by_kind_and_added_after_the_ids() {
        let lines = handle_lines(
            "b6767697-60b2-4700-a304-1404bf03c675",
            "c66dc1d4-5955-4ba5-b41e-9e37f364eb95",
            "3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff",
            "9e21c4d0-1111-2222-3333-444455556666",
        );
        assert_eq!(
            lines,
            "\nDevice handle: coflux:device:b6767697\nProject handle: coflux:project:c66dc1d4\nWorkspace handle: coflux:workspace:3f2a1b7c\nTerminal handle: coflux:terminal:9e21c4d0\nHandles are interchangeable with the ids above in every coflux command."
        );
    }

    #[test]
    fn a_missing_coordinate_contributes_no_line_instead_of_half_a_handle() {
        // A directory workspace has no project: that line goes away, the others stay.
        let lines = handle_lines(
            "b6767697-60b2-4700-a304-1404bf03c675",
            "",
            "3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff",
            "",
        );
        assert!(!lines.contains("coflux:project:"), "{lines}");
        assert!(!lines.contains("Terminal handle"), "{lines}");
        assert!(lines.contains("Device handle: coflux:device:b6767697"), "{lines}");
        assert!(lines.contains("Workspace handle: coflux:workspace:3f2a1b7c"), "{lines}");
        assert_eq!(handle_lines("", "", "", ""), "", "一个坐标都没有就整块不印");
    }

    /// Every block carries the secret reminder and the absolute path of the `coflux-secret`
    /// skill, which is how a Codex profile session (no extra skill roots) can reach it at all.
    #[test]
    fn session_block_reminds_about_coflux_secret_with_its_skill_path() {
        let root = Path::new("/home/u/.coflux/agent-integrations/abc123");
        let block = session_context(root, "d", "p", "w", "t", "s", "", "");
        assert!(block.starts_with("<coflux-session>\n"), "{block}");
        assert!(block.ends_with("\n</coflux-session>"), "{block}");
        assert!(
            block.contains(
                "/home/u/.coflux/agent-integrations/abc123/skills/coflux-secret/SKILL.md"
            ),
            "{block}"
        );
        assert!(
            block.contains("/home/u/.coflux/agent-integrations/abc123/skills/coflux/SKILL.md"),
            "{block}"
        );
        assert!(block.contains("\nIntegration: abc123\n"), "{block}");
        assert!(
            block.contains("Device: d\nProject: p\nWorkspace: w\nTerminal: t\nSession: s\n"),
            "{block}"
        );
    }
}
