//! Explicit workspace selection for hosts without a session-wide directory tool.
//! Selection belongs to the native conversation, not a transient shell or PTY.
use super::*;

pub(super) const DIRECTORY_INSTRUCTION: &str = "Use this directory explicitly for subsequent task commands (workdir/cwd), use absolute paths for file tools, and read its applicable AGENTS.md before editing. A shell cd and Coflux terminal migration do not change the host's default directory or sandbox permissions. Temporary commands in other directories do not change this selection. To switch again, run coflux workspace enter <path>.";

fn run_status() -> Value {
    status_file()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(json!({}))
}

fn selection_file(session: &str) -> PathBuf {
    // A resumed conversation may have a new launcher run and a different PTY.
    // Keep device/project boundaries even when the same COFLUX_HOME is shared.
    let key = json!([
        "codex",
        env("COFLUX_DEVICE_ID"),
        env("COFLUX_PROJECT_ID"),
        session
    ]);
    home().join("agent-workspaces").join(format!(
        "{:x}.json",
        Sha256::digest(key.to_string().as_bytes())
    ))
}

fn read_selection(session: &str) -> Result<Option<Value>, String> {
    let bytes = match fs::read(selection_file(session)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let selected: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !Path::new(&string(&selected, "path")).is_absolute()
        || string(&selected, "workspaceId").is_empty()
    {
        return Err("Saved workspace selection is invalid".into());
    }
    Ok(Some(selected))
}

pub fn enter(path: &str) -> Result<Value, String> {
    if path.trim().is_empty() {
        return Err("Usage: coflux workspace enter <path>".into());
    }
    let path = fs::canonicalize(path).map_err(|e| format!("Cannot enter workspace: {e}"))?;
    let status = run_status();
    let session = string(&status, "agentSessionId");
    let destination = if status["agent"] == "codex" {
        if session.is_empty() {
            return Err("Codex session identity is unavailable. Review /hooks and retry after the session hook runs.".into());
        }
        let file = selection_file(&session);
        private_dir(file.parent().unwrap()).map_err(|e| e.to_string())?;
        Some(file)
    } else {
        None
    };
    // The daemon verifies the same Git repository and the server confirms the
    // terminal move. Never remember a failed or merely attempted switch.
    let mut request = serde_json::Map::new();
    request.insert("action".into(), json!("workspace.locate"));
    request.insert("path".into(), json!(path));
    let mut result = crate::gateway::agent_post(request);
    if string(&result, "workspaceId").is_empty()
        || !Path::new(&string(&result, "path")).is_absolute()
    {
        return Err(
            "The local runtime did not confirm a workspace identity and absolute path".into(),
        );
    }
    if let Some(file) = &destination {
        atomic_json(file, &json!({"workspaceId": result["workspaceId"], "path": result["path"]}))
            .map_err(|e| format!("Terminal moved to {}, but saving the Codex selection failed: {e}. Run workspace enter again before continuing.", result["path"]))?;
    }
    result["resumeSupported"] = json!(destination.is_some());
    result["hostCwdChanged"] = json!(false);
    result["instruction"] = json!(DIRECTORY_INSTRUCTION);
    Ok(result)
}

fn unavailable(event: &str, error: &str) {
    record("unavailable", "codex");
    let context = format!("<coflux-session>Cannot verify the explicitly selected workspace: {}. Do not resume task edits in the host's original cwd or use stale workspace coordinates. Inspect the target and run coflux workspace enter <path> to select a valid workspace, or retry when the daemon is available.</coflux-session>", json!(error));
    if event == "SessionStart" {
        println!("{context}");
    } else {
        println!(
            "{}",
            json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":context}})
        );
    }
}

/// Return true when an explicit selection handled this context event. No command
/// text parsing and no migration based on an individual tool's workdir.
pub(super) fn hook(root: &Path, payload: &Value) -> bool {
    let event = string(payload, "hook_event_name");
    if !["SessionStart", "UserPromptSubmit", "PostToolUse"].contains(&event.as_str()) {
        return false;
    }
    let session = string(payload, "session_id");
    if session.is_empty() {
        return false;
    }
    let mut previous = run_status();
    if previous["agentSessionId"] != session {
        previous["agentSessionId"] = json!(session);
        previous["workspaceId"] = Value::Null;
        previous["workspacePath"] = Value::Null;
        previous["state"] = json!("unconfirmed");
    }
    previous["agent"] = json!("codex");
    if let Some(file) = status_file() {
        let _ = private_dir(file.parent().unwrap());
        let _ = atomic_json(&file, &previous);
    }
    let selected = match read_selection(&session) {
        Ok(Some(selected)) => selected,
        Ok(None) => return false,
        Err(error) => {
            unavailable(&event, &error);
            return true;
        }
    };
    let path = string(&selected, "path");
    let checked = (|| {
        if !Path::new(&path).is_dir() {
            return Err(format!("Selected directory is missing: {path}"));
        }
        let mut current = if event == "SessionStart" {
            // Reattach this conversation on resume, including in a different PTY.
            local_at("workspace.locate", Some(&path), &path)?
        } else {
            local_at("workspace.current", None, &path)?
        };
        if current["path"] != selected["path"]
            || (event != "SessionStart" && current["owningWorkspaceId"] != current["workspaceId"])
        {
            return Err("Selected workspace no longer matches terminal ownership".into());
        }
        current["explicitSelection"] = json!(true);
        Ok(current)
    })();
    match checked {
        Ok(current) => {
            record("ready", "codex");
            if event == "SessionStart"
                || previous["state"] != "ready"
                || previous["workspaceId"] != current["workspaceId"]
                || previous["workspacePath"] != current["path"]
            {
                emit_context(root, &current, "codex", &event);
            }
        }
        Err(error) => unavailable(&event, &error),
    }
    true
}
