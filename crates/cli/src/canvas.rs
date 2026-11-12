//! `coflux canvas show | list` (plan 20261112-agent-canvas).
//!
//! A canvas is an HTML file the agent shows to the user: the worker of the workspace's device
//! registers it and serves the file's directory on a loopback port, and the user's Coflux desktop
//! opens it in a tab. These are local agent actions on `/agent`, resolved to the caller's
//! **effective** workspace like every other local command. `show` returns at once; feedback comes
//! back as annotations (`coflux annotations`) or in the conversation.
//!
//! Rendering is pure (unit-tested); I/O only happens in [`run`].

use serde_json::{Map, Value};

use crate::args::ParsedArgs;
use crate::gateway;

fn body(action: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("action".into(), Value::from(action));
    map
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn workspace_label(result: &Value) -> String {
    let reference = text(result, "ref");
    let reference = if reference.is_empty() { text(result, "workspaceId") } else { reference };
    let path = text(result, "path");
    if path.is_empty() {
        reference.to_string()
    } else {
        format!("{reference} ({path})")
    }
}

fn render_shown(result: &Value) -> String {
    let canvas = result.get("canvas").cloned().unwrap_or(Value::Null);
    let mut lines = vec![format!(
        "Canvas \"{}\" is shown in workspace {}.",
        text(&canvas, "title"),
        workspace_label(result)
    )];
    lines.push(format!("File: {}", text(&canvas, "path")));
    let url = text(&canvas, "url");
    if !url.is_empty() {
        lines.push(format!("Address on this device: {url}"));
    }
    lines.push(
        "The user's Coflux desktop opens it in a tab. Run this command again on the same file after editing it; \
         their feedback arrives as annotations (coflux annotations list) or in the conversation."
            .into(),
    );
    lines.join("\n")
}

fn render_list(result: &Value) -> String {
    let canvases = result
        .get("canvases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let label = workspace_label(result);
    if canvases.is_empty() {
        return format!("No canvases in workspace {label}.");
    }
    let mut lines = vec![format!("Canvases in workspace {label}:")];
    for canvas in &canvases {
        lines.push(format!("- {} — {}", text(canvas, "title"), text(canvas, "path")));
        let url = text(canvas, "url");
        if !url.is_empty() {
            lines.push(format!("  {url}"));
        }
    }
    lines.join("\n")
}

pub fn run(args: &ParsedArgs) {
    let json = args.flag("json");
    match args.positional(1) {
        Some("show") => {
            let Some(path) = args.positional(2) else {
                crate::die_with(
                    "Missing the HTML file.",
                    "Usage: coflux canvas show <file.html> [--title \"<title>\"]",
                );
            };
            let mut request = body("canvas.show");
            request.insert("path".into(), Value::from(path));
            if let Some(title) = args.string("title") {
                request.insert("title".into(), Value::from(title.trim()));
            }
            let result = gateway::agent_post(request);
            if json {
                println!("{result}");
            } else {
                println!("{}", render_shown(&result));
            }
        }
        Some("list") => {
            let result = gateway::agent_post(body("canvas.list"));
            if json {
                println!("{result}");
            } else {
                println!("{}", render_list(&result));
            }
        }
        _ => crate::die_with(
            "Unknown canvas command.",
            "Use one of: show <file.html> [--title \"<title>\"], list.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shown_names_the_workspace_file_and_address() {
        let rendered = render_shown(&json!({
            "ref": "coflux:workspace:abcd1234",
            "path": "/repo",
            "canvas": { "title": "Home redesign", "path": "/repo/wiki/home.html", "url": "http://localhost:8795/ff/home.html" },
        }));
        assert!(rendered.starts_with("Canvas \"Home redesign\" is shown in workspace coflux:workspace:abcd1234 (/repo)."));
        assert!(rendered.contains("File: /repo/wiki/home.html"));
        assert!(rendered.contains("Address on this device: http://localhost:8795/ff/home.html"));
    }

    #[test]
    fn list_explains_an_empty_workspace_and_lists_entries() {
        assert_eq!(
            render_list(&json!({ "workspaceId": "w1", "canvases": [] })),
            "No canvases in workspace w1."
        );
        let rendered = render_list(&json!({
            "workspaceId": "w1",
            "canvases": [{ "title": "A", "path": "/a.html", "url": "http://localhost:1/x/a.html" }, { "title": "B", "path": "/b.html" }],
        }));
        assert_eq!(
            rendered,
            "Canvases in workspace w1:\n- A — /a.html\n  http://localhost:1/x/a.html\n- B — /b.html"
        );
    }
}
