//! agent 侧子命令（plan 112）：`terminal new|run|list|read|wait|send|close`、`notify`、`progress`、
//! `ports`、`workspace [locate|forget]`、`hook <claude|codex>`、`executor run`。
//!
//! Request bodies, output text and exit codes match the node version, `packages/cli/coflux.mjs`
//! (`cmdTerminal` / `cmdNotify` / `cmdProgress` / `cmdWorkspace` / `cmdPorts` / `cmdHook` /
//! `cmdExecutor`), word for word. No test enforces that any more: a copy change touches both.
//!
//! 与 `hook` 子命令的约定**相反**：这些命令必须写 stdout——输出就是给 agent 读的返回值。

use std::io::{IsTerminal, Read};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::args::ParsedArgs;
use crate::gateway;
use crate::handle;
use crate::text::{strip_ansi, tail_lines};

const DEFAULT_READ_LINES: usize = 200;
/// Executor poll interval. Same shape as `terminal wait` (a single `/agent` reply is capped at
/// 25 seconds), but tighter: the terminal state here is a return value someone is blocked on.
const EXECUTOR_POLL: Duration = Duration::from_secs(2);
/// Default executor wait budget, in seconds. Sub-tasks run long; same order as `terminal wait`.
const DEFAULT_EXECUTOR_TIMEOUT_S: f64 = 1800.0;
/// How many times a submission may be re-sent after a *transport* failure. The retry reuses the
/// same submissionId and the daemon deduplicates on it — "never blindly resubmit" forbids a second
/// id, not a second attempt.
const EXECUTOR_SUBMIT_RETRIES: usize = 2;
/// `wait` loops here because one `/agent` round-trip is capped at 25 s on the loopback endpoint;
/// each round the daemon blocks up to `WAIT_ROUND_MS` on its command-state watch and answers the
/// moment the command finishes, so the loop never hammers it. Default 30 minutes overall.
const DEFAULT_WAIT_TIMEOUT_S: f64 = 1800.0;
const WAIT_ROUND_MS: u64 = 20_000;

fn body(action: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("action".into(), Value::from(action));
    map
}

fn with(mut map: Map<String, Value>, key: &str, value: impl Into<Value>) -> Map<String, Value> {
    map.insert(key.into(), value.into());
    map
}

fn field_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn field_bool(value: &Value, key: &str) -> bool {
    // JS `Boolean(x)`：null/undefined/false/0/"" 为假，其余为真。
    match value.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// JS 模板字符串里数字的写法：整数不带小数点。
fn js_number(value: &Value) -> String {
    match value {
        Value::Number(number) => match number.as_i64() {
            Some(int) => int.to_string(),
            None => number
                .as_f64()
                .map(|float| {
                    if float.fract() == 0.0 {
                        format!("{}", float as i64)
                    } else {
                        float.to_string()
                    }
                })
                .unwrap_or_default(),
        },
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// ` exit=<code>`；exitCode 为 undefined/null 时是空串。
fn exit_suffix(value: &Value) -> String {
    match value.get("exitCode") {
        None | Some(Value::Null) => String::new(),
        Some(code) => format!(" exit={}", js_number(code)),
    }
}

/// 按插入顺序拼一行 JSON（`JSON.stringify` 语义：值为 None 的键省略）。
/// 不开 serde_json 的 preserve_order——那会经 feature 统一波及 workspace 其它 crate。
fn json_line(fields: &[(&str, Option<Value>)]) -> String {
    let mut out = String::from("{");
    let mut first = true;
    for (key, value) in fields {
        let Some(value) = value else { continue };
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(&Value::from(*key).to_string());
        out.push(':');
        out.push_str(&value.to_string());
    }
    out.push('}');
    out
}

fn passthrough(value: &Value, key: &str) -> Option<Value> {
    match value.get(key) {
        None | Some(Value::Null) => None,
        Some(inner) => Some(inner.clone()),
    }
}

/* ------------------------------- terminal ------------------------------- */

/// `--cmd` 缺省与 `--cmd= 空白` 等价：都只开终端，空白收敛成空串（不打入任何东西）。
pub fn normalize_command(cmd: Option<&str>) -> String {
    match cmd {
        Some(raw) if !raw.trim().is_empty() => raw.to_string(),
        _ => String::new(),
    }
}

/// First line of `terminal new` (after the `✓`): the terminal exists whatever happens to the
/// command afterwards.
pub fn render_terminal_opened(result: &Value) -> String {
    let task_id = field_str(result, "taskId");
    format!("Opened terminal {task_id}")
}

/// Hint lines after opening a terminal without `--cmd`.
pub fn render_terminal_new_hints(task_id: &str) -> String {
    [
        "It is a login shell the user can see and take over. It stays open until you close it.".to_string(),
        format!("Run a command:   coflux terminal run {task_id} --cmd=\"<command>\""),
        format!("Read its output: coflux terminal read {task_id}"),
        format!("Close it:        coflux terminal close {task_id}"),
    ]
    .join("\n")
}

/// `terminal run` / `terminal new --cmd` succeeded: the command was typed after the prompt mark.
fn print_terminal_run(result: &Value, task_id: &str) {
    let seq = result.get("commandSeq").map(js_number).unwrap_or_default();
    crate::ui::success(&format!("Sent command #{seq}"));
    println!("Wait for it with coflux terminal wait {task_id}, and read its output with coflux terminal read {task_id}.");
}

/// A subcommand that needs a terminal id got none (the node `missingTaskId`).
fn missing_task_id(sub: &str, usage: &str) -> ! {
    crate::die_with(
        "Missing terminal id.",
        &format!("Run coflux terminal list to find it, then coflux terminal {sub} <taskId>{usage}."),
    )
}

/// ` busy` / ` idle` plus ` last=<code>` for a live, instrumented terminal; nothing otherwise.
fn command_suffix(value: &Value) -> String {
    if !field_bool(value, "integrated") {
        return String::new();
    }
    let mut suffix = if field_bool(value, "busy") { " busy".to_string() } else { " idle".to_string() };
    if let Some(code) = value.get("lastCommandExitCode").filter(|code| !code.is_null()) {
        suffix.push_str(&format!(" last={}", js_number(code)));
    }
    suffix
}

/// 一行终端的第一列：标识。daemon 已经在载荷里给了 `ref`；它没给（CLI 比 daemon 新）就按同一条
/// 规则从 `taskId` 现算一个——生成规则是纯拼接，两边算出来的东西一样。
fn row_handle(terminal: &Value) -> String {
    let given = field_str(terminal, "ref");
    if !given.is_empty() {
        return given.to_string();
    }
    handle::of(handle::HandleKind::Terminal, field_str(terminal, "taskId"))
}

pub fn render_terminal_list(result: &Value) -> String {
    let terminals = result
        .get("terminals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if terminals.is_empty() {
        return "No terminals in this workspace.".to_string();
    }
    terminals
        .iter()
        .map(|t| {
            format!(
                "{}  {}{}{}  {}",
                row_handle(t),
                field_str(t, "status"),
                exit_suffix(t),
                command_suffix(t),
                field_str(t, "title")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `--lines`：正整数才生效，其余（缺省/非数/0/负）取默认 200。
pub fn read_lines(raw: Option<&str>) -> usize {
    raw.and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_READ_LINES)
}

pub fn render_terminal_read(result: &Value, lines: usize) -> String {
    let header = format!("# {}{}", field_str(result, "status"), exit_suffix(result));
    let text = tail_lines(&strip_ansi(field_str(result, "ansi")), lines);
    let text = if text.is_empty() { "(no output yet)".to_string() } else { text };
    format!("{header}\n{text}")
}

/// `--timeout`：正数（可带小数）才生效，其余取默认 1800 秒。
pub fn wait_timeout_secs(raw: Option<&str>) -> f64 {
    raw.and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_S)
}

/// `--seq`: a positive integer targets that command; anything else = the latest one (0).
pub fn wait_command_seq(raw: Option<&str>) -> u64 {
    raw.and_then(|text| text.trim().parse::<u64>().ok()).unwrap_or(0)
}

/// `# finished exit=<code>` for a command, `# exited exit=<code>` when the shell itself ended.
pub fn render_wait_done(result: &Value) -> String {
    let state = if field_str(result, "state") == "exited" { "exited" } else { "finished" };
    format!("# {state}{}", exit_suffix(result))
}

fn wait_timed_out(timeout_secs: f64, task_id: &str, command_seq: &str) -> ! {
    crate::die_with(
        &format!(
            "Timed out after {}s: command #{command_seq} in terminal {task_id} is still running.",
            js_number(&Value::from(timeout_secs))
        ),
        &format!("Wait longer with --timeout, or look at the screen with coflux terminal read {task_id}."),
    )
}

fn print_terminal_close(result: &Value, task_id: &str) {
    if field_bool(result, "exited") {
        crate::ui::success(&format!("Closed terminal {task_id}{}", exit_suffix(result)));
    } else {
        println!("Closing terminal {task_id}. Its shell is still exiting; check it with coflux terminal list.");
    }
}

pub fn run_terminal(args: &ParsedArgs) {
    match args.positional(1) {
        Some("new") => {
            // Open first, then "do script": the terminal exists (and is reported) even when the
            // command cannot be typed — an old daemon refuses `terminal.run` as an unknown action
            // and never runs the command any other way.
            let command = normalize_command(args.string("cmd"));
            let request = with(body("terminal.new"), "title", args.string("title").unwrap_or(""));
            let opened = gateway::agent_post(request);
            crate::ui::success(&render_terminal_opened(&opened));
            let task_id = field_str(&opened, "taskId").to_string();
            if command.is_empty() {
                println!("{}", render_terminal_new_hints(&task_id));
            } else {
                let request = with(
                    with(body("terminal.run"), "taskId", task_id.as_str()),
                    "command",
                    command.as_str(),
                );
                let ran = gateway::agent_post_or(request, gateway::TERMINAL_NEXT);
                print_terminal_run(&ran, &task_id);
            }
        }
        Some("run") => {
            let Some(task_id) = args.positional(2) else {
                missing_task_id("run", " --cmd=\"<command>\"");
            };
            let command = normalize_command(args.string("cmd"));
            if command.is_empty() {
                crate::die_with(
                    "Missing command.",
                    &format!("Pass it with --cmd: coflux terminal run {task_id} --cmd=\"<command>\"."),
                );
            }
            let request = with(
                with(body("terminal.run"), "taskId", task_id),
                "command",
                command.as_str(),
            );
            let result = gateway::agent_post_or(request, gateway::TERMINAL_NEXT);
            print_terminal_run(&result, task_id);
        }
        Some("close") => {
            let Some(task_id) = args.positional(2) else {
                missing_task_id("close", "");
            };
            let result = gateway::agent_post_or(with(body("terminal.close"), "taskId", task_id), gateway::TERMINAL_NEXT);
            print_terminal_close(&result, task_id);
        }
        Some("list") => {
            let result = gateway::agent_post(body("terminal.list"));
            println!("{}", render_terminal_list(&result));
        }
        Some("read") => {
            let Some(task_id) = args.positional(2) else {
                missing_task_id("read", "");
            };
            let lines = read_lines(args.string("lines"));
            let result = gateway::agent_post_or(with(body("terminal.read"), "taskId", task_id), gateway::TERMINAL_NEXT);
            println!("{}", render_terminal_read(&result, lines));
        }
        Some("send") => {
            let Some(task_id) = args.positional(2) else {
                missing_task_id("send", " --text=\"<text>\"");
            };
            let text = args.string("text").unwrap_or("");
            let enter = args.flag("enter");
            if text.is_empty() && !enter {
                crate::die_with("Nothing to send.", "Pass --text=\"<text>\", or --enter to send a single Enter.");
            }
            let request = with(
                with(with(body("terminal.send"), "taskId", task_id), "text", text),
                "enter",
                enter,
            );
            gateway::agent_post_or(request, gateway::TERMINAL_NEXT);
            crate::ui::success(&format!("Sent input to terminal {task_id}"));
            println!("Check the result with coflux terminal read {task_id}.");
        }
        Some("wait") => {
            let Some(task_id) = args.positional(2) else {
                missing_task_id("wait", "");
            };
            let timeout_secs = wait_timeout_secs(args.string("timeout"));
            let command_seq = wait_command_seq(args.string("seq"));
            // 极大的 --timeout（Duration/Instant 装不下）等价于「不设 deadline」，与 node 版一样不报错。
            let deadline = Duration::try_from_secs_f64(timeout_secs)
                .ok()
                .and_then(|timeout| Instant::now().checked_add(timeout));
            loop {
                // Each round blocks inside the daemon (its command-state watch wakes it the moment
                // the command ends); a `running` answer only means the round elapsed.
                let round_ms = deadline
                    .map(|deadline| deadline.saturating_duration_since(Instant::now()).as_millis() as u64)
                    .unwrap_or(WAIT_ROUND_MS)
                    .clamp(1, WAIT_ROUND_MS);
                let request = with(
                    with(with(body("terminal.wait"), "taskId", task_id), "commandSeq", command_seq),
                    "timeoutMs",
                    round_ms,
                );
                let result = gateway::agent_post_or(request, gateway::TERMINAL_NEXT);
                if field_str(&result, "state") != "running" {
                    println!("{}", render_wait_done(&result));
                    return;
                }
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    wait_timed_out(
                        timeout_secs,
                        task_id,
                        &result.get("commandSeq").map(js_number).unwrap_or_default(),
                    );
                }
            }
        }
        other => crate::die_with(
            &match other {
                Some(sub) => format!("Unknown terminal command: {sub}."),
                None => "Missing terminal command.".to_string(),
            },
            "Use one of: new, run, list, read, wait, send, close.",
        ),
    }
}

/* --------------------------- notify / progress -------------------------- */

/// 位置参数 1.. 用空格拼成一句话并去两端空白（node 版 `positionals.slice(1).join(" ").trim()`）。
pub fn joined_message(args: &ParsedArgs) -> String {
    args.positionals
        .iter()
        .skip(1)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

pub fn run_notify(args: &ParsedArgs) {
    let message = joined_message(args);
    if message.is_empty() {
        crate::die_with("Missing message.", "Usage: coflux notify \"<message>\"");
    }
    use std::io::Read;
    let mut bytes = [0u8; 24];
    if std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).is_err() {
        crate::die_with("Cannot create a notification id.", "Try again.");
    }
    let notification_id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let result = gateway::agent_post(with(with(body("notify"), "message", message), "notificationId", notification_id));
    if result.get("notificationId").and_then(serde_json::Value::as_str).filter(|id| !id.is_empty()).is_none() {
        crate::die_with(
            "The notification was not confirmed: this device's Coflux is too old to save it.",
            "Update Coflux on this device, then send it again.",
        );
    }
    crate::ui::success("Notification sent");
}

pub fn run_progress(args: &ParsedArgs) {
    let message = joined_message(args);
    if message.is_empty() {
        crate::die_with("Missing message.", "Usage: coflux progress \"<message>\"");
    }
    gateway::agent_post(with(body("progress"), "message", message));
    crate::ui::success("Progress updated");
}

/* -------------------------------- workspace ------------------------------ */
// 「我在哪」与「跟着我搬」（plan 102 / 103）。三条都打一行 JSON，字段稳定——插件脚本按它比对。

/// `ref` / `owningRef` 原样透传 daemon 的字段：daemon 旧到不给就跟着省略（`json_line` 的既有
/// 规则），读这行的插件脚本（session-moved.mjs）只取 workspaceId，多两个键动不了它。
pub fn render_workspace_current(result: &Value) -> String {
    json_line(&[
        ("workspaceId", passthrough(result, "workspaceId")),
        ("ref", passthrough(result, "ref")),
        ("path", passthrough(result, "path")),
        ("owningWorkspaceId", passthrough(result, "owningWorkspaceId")),
        ("owningRef", passthrough(result, "owningRef")),
        ("moved", Some(Value::from(field_bool(result, "moved")))),
    ])
}

pub fn render_workspace_locate(result: &Value) -> String {
    json_line(&[
        ("workspaceId", passthrough(result, "workspaceId")),
        ("path", passthrough(result, "path")),
        ("branch", passthrough(result, "branch")),
        ("created", Some(Value::from(field_bool(result, "created")))),
        ("moved", Some(Value::from(field_bool(result, "moved")))),
    ])
}

pub fn render_workspace_forget(result: &Value) -> String {
    let moved_terminals = passthrough(result, "movedTerminals").unwrap_or(Value::from(0));
    json_line(&[
        ("workspaceId", passthrough(result, "workspaceId")),
        ("fallbackWorkspaceId", passthrough(result, "fallbackWorkspaceId")),
        ("movedTerminals", Some(moved_terminals)),
        ("removed", Some(Value::from(field_bool(result, "removed")))),
    ])
}

pub fn run_workspace(args: &ParsedArgs) {
    match args.positional(1) {
        None => {
            let result = gateway::agent_post(body("workspace.current"));
            println!("{}", render_workspace_current(&result));
        }
        Some("enter") => {
            let Some(path) = args.positional(2).filter(|_| args.positional(3).is_none()) else {
                crate::die_with("Missing path.", "Usage: coflux workspace enter <path>");
            };
            match crate::integration::enter_workspace(path) {
                Ok(result) => println!("{result}"),
                Err(error) => crate::die(&error),
            }
        }
        Some("locate") => {
            // 路径缺省取调用方 cwd；插件脚本一律显式传 hook 载荷里的 cwd。
            let path = args
                .positional(2)
                .map(str::to_string)
                .unwrap_or_else(gateway::caller_cwd);
            if path.is_empty() {
                crate::die_with("Could not determine the current directory.", "Pass the path: coflux workspace locate <path>.");
            }
            let result = gateway::agent_post(with(body("workspace.locate"), "path", path));
            println!("{}", render_workspace_locate(&result));
        }
        Some("forget") => {
            let Some(path) = args.positional(2) else {
                crate::die_with("Missing path.", "Usage: coflux workspace forget <path>");
            };
            let result = gateway::agent_post(with(body("workspace.forget"), "path", path));
            println!("{}", render_workspace_forget(&result));
        }
        Some(sub) => crate::die_with(
            &format!("Unknown workspace command: {sub}."),
            "Use enter, locate or forget, or no subcommand to print the current workspace.",
        ),
    }
}

/* ---------------------------------- ports -------------------------------- */

pub fn render_ports(result: &Value) -> String {
    let ports = result
        .get("ports")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if ports.is_empty() {
        return "No listening ports in this workspace.".to_string();
    }
    ports
        .iter()
        .map(|p| {
            format!(
                "{}  {}",
                p.get("port").map(js_number).unwrap_or_default(),
                field_str(p, "url")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn run_ports() {
    let result = gateway::agent_post(body("ports"));
    println!("{}", render_ports(&result));
}

/* -------------------------------- executor ------------------------------- */
// `coflux executor run`: hand one well-bounded sub-task to the built-in executor.
//
// Three phases: **submit** returns a runId (answered immediately, deduplicated by `submissionId`)
// -> the CLI **polls** status (a single `/agent` reply is capped at 25 seconds, so a long run can
// never hang off one request) -> the terminal state is rendered. On wait timeout a cancel goes out
// before the error: leaving an unwatched write job editing files is worse than the timeout itself.

/// This process's stable submission id: pid plus the nanosecond it was minted. Generated **once**
/// and reused verbatim when a transport failure forces a retry — the daemon deduplicates on it, so
/// a retry can never become a second run.
fn submission_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("sub-{}-{nanos}", std::process::id())
}

/// `--timeout`: only a positive (possibly fractional) number counts; anything else means 1800s.
pub fn executor_timeout_secs(raw: Option<&str>) -> f64 {
    raw.and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(DEFAULT_EXECUTOR_TIMEOUT_S)
}

fn changed_files(status: &Value) -> Vec<String> {
    status
        .get("changedFiles")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// stdout for a successful terminal state: a machine-readable status line first, then the
/// executor's final reply and the list of files it changed.
pub fn render_executor_success(status: &Value) -> String {
    let mut out = vec!["# succeeded".to_string()];
    let summary = field_str(status, "summary").trim().to_string();
    out.push(if summary.is_empty() {
        "(the executor left no final reply)".to_string()
    } else {
        summary
    });
    let files = changed_files(status);
    if files.is_empty() {
        out.push("Changed files: none".to_string());
    } else {
        out.push(format!("Changed files ({}):", files.len()));
        out.extend(files);
    }
    out.push("The executor never commits. Review the changes and commit them yourself.".to_string());
    out.join("\n")
}

/// The error for a non-success terminal state: state name, reason, and what was already changed —
/// the last part matters most when the run was interrupted or failed midway. Returns the message
/// and its next step.
pub fn render_executor_failure(status: &Value) -> (String, &'static str) {
    let terminal = field_str(status, "terminal");
    let terminal = if terminal.is_empty() { "unknown" } else { terminal };
    let mut reason = field_str(status, "error").trim().to_string();
    if reason.is_empty() {
        reason = field_str(status, "note").trim().to_string();
    }
    if reason.is_empty() {
        reason = "no reason given".to_string();
    }
    let files = changed_files(status);
    let next = executor_next_step(terminal, !files.is_empty());
    let tail = if files.is_empty() {
        String::new()
    } else {
        // A reason that already ends a sentence (the executor's incomplete-list note does) takes no
        // second period.
        let stop = if reason.ends_with(|c: char| matches!(c, '.' | '!' | '?')) {
            ""
        } else {
            "."
        };
        format!("{stop} Files already changed ({}): {}", files.len(), files.join(" "))
    };
    (format!("Executor run ended as {terminal}: {reason}{tail}"), next)
}

/// The next step for a run that ended as `terminal`, depending on whether it left changed files
/// behind. Each state calls for something different: a rejected run never started, a cancelled one
/// was stopped on purpose, and an `unknown` one lost its host, so its file list may be short.
/// `packages/cli/coflux.mjs` prints the same strings.
fn executor_next_step(terminal: &str, left_files: bool) -> &'static str {
    match (terminal, left_files) {
        ("rejected", _) => "Nothing ran. Send this run again once the reason above is resolved.",
        ("model_error", false) => {
            "Send the run again. If the reason points at the provider, key or model, tell the user to fix the executor settings instead."
        }
        ("model_error", true) => {
            "Review the changes it left, then send the run again. If the reason points at the provider, key or model, tell the user to fix the executor settings instead."
        }
        ("tool_failed", false) => "Send the run again. If it fails the same way, tell the user.",
        ("tool_failed", true) => {
            "Review the changes it left, then send the run again. If it fails the same way, tell the user."
        }
        ("cancelled", false) => {
            "It was stopped before it finished, by the user, a timeout or its host going away. Find out why before sending it again."
        }
        ("cancelled", true) => {
            "It was stopped before it finished, by the user, a timeout or its host going away. Review the changes it left and find out why before sending it again."
        }
        _ => {
            "Its host went away mid-run, so the list of changed files may be incomplete. Check the workspace before sending it again."
        }
    }
}

pub fn render_executor_timeout(timeout_secs: f64, run_id: &str, phase: &str) -> String {
    format!(
        "Timed out after {}s: executor run {run_id} was still {phase} and has been cancelled.",
        js_number(&Value::from(timeout_secs))
    )
}

/// Submit. A transport failure is retried with the same submissionId; an explicit daemon refusal
/// is reported verbatim and never retried. `title` names the run on the desktop's card (plan
/// 20260929-executor-pip); empty = the daemon falls back to the prompt's first line.
fn executor_submit(prompt: &str, write: bool, title: &str) -> String {
    let submission = submission_id();
    let request = || {
        with(
            with(
                with(
                    with(body("executor.submit"), "submissionId", submission.as_str()),
                    "prompt",
                    prompt,
                ),
                "write",
                write,
            ),
            "title",
            title,
        )
    };
    let mut attempt = 0;
    loop {
        match gateway::agent_post_result(request()) {
            Ok(result) => {
                let run_id = field_str(&result, "runId").to_string();
                if run_id.is_empty() {
                    crate::die_with("The Coflux service did not return a run id.", "Update Coflux on this device, then try again.");
                }
                return run_id;
            }
            Err(error @ gateway::AgentError::Refused(_)) => crate::die(&error.message()),
            Err(error) => {
                if attempt >= EXECUTOR_SUBMIT_RETRIES {
                    crate::die(&error.message());
                }
                attempt += 1;
                std::thread::sleep(EXECUTOR_POLL);
            }
        }
    }
}

pub fn run_executor(args: &ParsedArgs) {
    if args.positional(1) != Some("run") {
        crate::die_with(
            "Unknown executor command.",
            "Usage: coflux executor run --prompt=\"<task>\" [--title=\"<title>\"] [--write]",
        );
    }
    let prompt = args.string("prompt").unwrap_or("").trim().to_string();
    if prompt.is_empty() {
        crate::die_with(
            "Missing prompt.",
            "Describe the task with --prompt, for example --prompt=\"Fix the clippy warnings in crates/worker\".",
        );
    }
    let write = args.flag("write");
    let title = args.string("title").unwrap_or("").trim().to_string();
    let timeout_secs = executor_timeout_secs(args.string("timeout"));
    let deadline = Duration::try_from_secs_f64(timeout_secs)
        .ok()
        .and_then(|timeout| Instant::now().checked_add(timeout));
    let run_id = executor_submit(&prompt, write, &title);
    loop {
        // The first poll does not sleep: a rejection (write lock taken, model not configured) has to
        // surface immediately instead of costing the caller a whole poll interval.
        let status = gateway::agent_post(with(body("executor.status"), "runId", run_id.as_str()));
        if field_str(&status, "phase") == "done" {
            // `succeeded` is about the *task*; the envelope's top-level `ok` only says the request
            // itself was accepted.
            if field_bool(&status, "succeeded") {
                println!("{}", render_executor_success(&status));
                return;
            }
            let (message, next) = render_executor_failure(&status);
            crate::die_with(&message, next);
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            // Cancel before reporting: an unwatched write job still editing files in the background
            // is far worse than the timeout itself.
            let _ = gateway::agent_post_result(with(
                body("executor.cancel"),
                "runId",
                run_id.as_str(),
            ));
            crate::die_with(
                &render_executor_timeout(timeout_secs, &run_id, field_str(&status, "phase")),
                "Send it again with a larger --timeout.",
            );
        }
        std::thread::sleep(EXECUTOR_POLL);
    }
}

/* ---------------------------------- hook --------------------------------- */
// `coflux hook <claude|codex>`: the messenger. It reads the hook event JSON from stdin/argv and
// forwards only the agent's own session id, the event name and process coordinates to `/hook`;
// the prompt, answer text and notification body in the payload never leave the machine (privacy
// boundary). Hooks carry no turn state: that comes from the agent's OSC 7501 reports. A payload
// without a session id sends nothing.
//
// Discipline: never disturb the agent itself. Every failure exits 0 silently (claude reads a
// non-zero exit of a Stop hook as "block the stop"). stdout stays empty (claude parses a hook's
// stdout as a decision JSON) except for the worktree guard's deny decision on a Claude Code
// PreToolUse; debug output goes to stderr (COFLUX_HOOK_DEBUG=1). The request is held until its
// response arrives: the worker walks the process tree from this pid while it handles it.

/// stdin 没有数据时不能干等（notify 形态下 stdin 是继承的 TTY/空管道）。
const HOOK_STDIN_TIMEOUT: Duration = Duration::from_millis(300);
const HOOK_POST_TIMEOUT: Duration = Duration::from_millis(2000);

fn hook_debug_enabled() -> bool {
    std::env::var("COFLUX_HOOK_DEBUG").is_ok_and(|value| !value.is_empty())
}

fn hook_debug(enabled: bool, message: &str) {
    if enabled {
        eprintln!("[coflux hook] {message}");
    }
}

/// 非 TTY 时最多等 300ms 读 stdin：到点用已读到的部分（对齐 node 版 `Promise.race` 的语义）。
pub(crate) fn read_stdin_json() -> Option<Value> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return None;
    }
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    {
        let buffer = Arc::clone(&buffer);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            let mut handle = std::io::stdin();
            loop {
                match handle.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buffer.lock().unwrap().extend_from_slice(&chunk[..n]),
                }
            }
            let _ = done_tx.send(());
        });
    }
    let _ = done_rx.recv_timeout(HOOK_STDIN_TIMEOUT);
    let raw = buffer.lock().unwrap().clone();
    let text = String::from_utf8_lossy(&raw);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// hook 载荷 → `/hook` 请求体。返回 None 表示没有可发的（缺事件名或缺会话标识），调用方静默放弃。
/// 字段顺序与省略规则同 node 版：`JSON.stringify` 会丢掉 undefined 的键。
pub fn build_hook_body(agent: &str, payload: &Value, pid: i64, ppid: i64) -> Option<Map<String, Value>> {
    let object = payload.as_object()?;
    // claude/codex hooks 引擎用 hook_event_name；codex notify 用 type（JS `||`：空串也落到下一个）
    let event = object
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| object.get("type").and_then(Value::as_str).filter(|text| !text.is_empty()))?;
    // The agent's own session id (claude: session_id / codex notify: thread-id) is the only thing
    // the worker records from a hook; without one there is nothing to send.
    let session = object
        .get("session_id")
        .filter(|value| !value.is_null())
        .or_else(|| object.get("thread-id").filter(|value| !value.is_null()))?;
    let mut map = Map::new();
    map.insert("agent".into(), Value::from(agent));
    map.insert("event".into(), Value::from(event));
    map.insert("pid".into(), Value::from(pid));
    map.insert("ppid".into(), Value::from(ppid));
    map.insert("agentSessionId".into(), session.clone());
    Some(map)
}

/// Always exits 0 and writes nothing to stdout, with one exception: on a Claude Code `PreToolUse`
/// event it prints the worktree guard's deny decision, one JSON object on one line, when the guard
/// has one (`integration::worktree_guard_decision`).
pub fn run_hook(args: &ParsedArgs) {
    let debug = hook_debug_enabled();
    let agent = match args.positional(1) {
        Some(agent @ ("claude" | "codex")) => agent,
        other => {
            hook_debug(debug, &format!("unknown agent: {}; expected claude or codex", other.unwrap_or("(missing)")));
            return;
        }
    };
    let mut payload = args
        .positional(2)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok()); // 非 JSON 的多余参数，忽略
    if payload.is_none() {
        payload = read_stdin_json();
    }
    let Some(payload) = payload.filter(Value::is_object) else {
        hook_debug(debug, "no valid payload; ignored");
        return;
    };
    if agent == "claude" {
        if let Some(decision) = crate::integration::worktree_guard_decision(&payload) {
            hook_debug(debug, "PreToolUse: denied a worktree removal or move of a coflux workspace");
            println!("{decision}");
        }
    }
    let Some(request) = build_hook_body(agent, &payload, gateway::pid(), gateway::ppid()) else {
        hook_debug(debug, "payload has no event name or no session id; nothing to send");
        return;
    };
    hook_debug(debug, &format!("POST /hook {}", Value::Object(request.clone())));
    // The agent socket first; the gateway port is resolved only when the socket is absent.
    match gateway::local_post("/hook", request, HOOK_POST_TIMEOUT) {
        Ok(response) => hook_debug(debug, &format!("answered {}", response.status)),
        Err(error) => hook_debug(debug, &error.message()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parsed(list: &[&str]) -> ParsedArgs {
        crate::args::parse(list.iter().map(|s| s.to_string())).unwrap()
    }

    #[test]
    fn terminal_list_leads_with_the_handle_even_against_a_daemon_that_sends_none() {
        // 行首是标识而不是裸 UUID：这是 agent 读得最多的一行，标识既更短又自带类型，
        // 且因为等价规则可以直接抄进下一条命令。
        let old_daemon = json!({ "terminals": [
            { "taskId": "9E21C4D0-1111-2222-3333-444455556666", "status": "running", "title": "构建" },
        ] });
        assert_eq!(
            render_terminal_list(&old_daemon),
            "coflux:terminal:9e21c4d0  running  构建",
            "daemon 没给 ref 就按同一条规则现算，不会退回打裸 id"
        );
        // 载荷里的 ref 优先（同一条规则，值必然一致）
        assert_eq!(
            row_handle(&json!({ "taskId": "9e21c4d0-1111-2222-3333-444455556666", "ref": "coflux:terminal:9e21c4d0" })),
            "coflux:terminal:9e21c4d0"
        );
    }

    #[test]
    fn terminal_read_strips_ansi_and_tails() {
        let result = json!({ "status": "exited", "exitCode": 1, "ansi": "\u{1b}[32mok\u{1b}[0m\nline2\n\n\n" });
        assert_eq!(render_terminal_read(&result, 1), "# exited exit=1\nline2");
        assert_eq!(render_terminal_read(&json!({ "status": "running", "ansi": "" }), 5), "# running\n(no output yet)");
        assert_eq!(render_terminal_read(&json!({ "status": "running" }), 5), "# running\n(no output yet)");
    }

    #[test]
    fn read_lines_and_wait_timeout_defaults() {
        assert_eq!(read_lines(None), 200);
        assert_eq!(read_lines(Some("0")), 200);
        assert_eq!(read_lines(Some("-3")), 200);
        assert_eq!(read_lines(Some("2.5")), 200);
        assert_eq!(read_lines(Some("x")), 200);
        assert_eq!(read_lines(Some("50")), 50);
        assert_eq!(wait_timeout_secs(None), 1800.0);
        assert_eq!(wait_timeout_secs(Some("0")), 1800.0);
        assert_eq!(wait_timeout_secs(Some("abc")), 1800.0);
        assert_eq!(wait_timeout_secs(Some("2.5")), 2.5);
        assert_eq!(wait_timeout_secs(Some("90")), 90.0);
    }

    #[test]
    fn notify_message_joins_positionals() {
        assert_eq!(joined_message(&parsed(&["notify", "两个方案", "拿不准"])), "两个方案 拿不准");
        assert_eq!(joined_message(&parsed(&["notify", "  "])), "");
        assert_eq!(joined_message(&parsed(&["notify"])), "");
    }

    #[test]
    fn workspace_json_lines_keep_node_field_order_and_omit_missing() {
        let current = json!({ "ok": true, "workspaceId": "w1", "ref": "coflux:workspace:3f2a1b7c", "path": "/a", "owningWorkspaceId": "w0", "owningRef": "coflux:workspace:aaaabbbb", "moved": true });
        assert_eq!(
            render_workspace_current(&current),
            r#"{"workspaceId":"w1","ref":"coflux:workspace:3f2a1b7c","path":"/a","owningWorkspaceId":"w0","owningRef":"coflux:workspace:aaaabbbb","moved":true}"#
        );
        // 旧 daemon 不给标识：两个键一起省略，原有字段一字未动
        assert_eq!(
            render_workspace_current(&json!({ "ok": true, "workspaceId": "w1", "path": "/a", "owningWorkspaceId": "w0", "moved": false })),
            r#"{"workspaceId":"w1","path":"/a","owningWorkspaceId":"w0","moved":false}"#
        );
        // 旧 daemon 少字段：键省略、布尔仍落 false
        assert_eq!(render_workspace_current(&json!({ "ok": true })), r#"{"moved":false}"#);
        let locate = json!({ "workspaceId": "w2", "path": "/b", "branch": "dev", "created": 1 });
        assert_eq!(
            render_workspace_locate(&locate),
            r#"{"workspaceId":"w2","path":"/b","branch":"dev","created":true,"moved":false}"#
        );
        let forget = json!({ "workspaceId": "w2", "fallbackWorkspaceId": "w1", "removed": true });
        assert_eq!(
            render_workspace_forget(&forget),
            r#"{"workspaceId":"w2","fallbackWorkspaceId":"w1","movedTerminals":0,"removed":true}"#
        );
        let forget = json!({ "workspaceId": "w2", "fallbackWorkspaceId": "w1", "movedTerminals": 3, "removed": false });
        assert_eq!(
            render_workspace_forget(&forget),
            r#"{"workspaceId":"w2","fallbackWorkspaceId":"w1","movedTerminals":3,"removed":false}"#
        );
    }

    #[test]
    fn executor_timeout_defaults_like_terminal_wait() {
        assert_eq!(executor_timeout_secs(None), 1800.0);
        assert_eq!(executor_timeout_secs(Some("0")), 1800.0);
        assert_eq!(executor_timeout_secs(Some("abc")), 1800.0);
        assert_eq!(executor_timeout_secs(Some("90")), 90.0);
    }

    #[test]
    fn executor_submission_ids_are_unique_per_call() {
        let first = submission_id();
        assert!(first.starts_with("sub-"));
        assert_ne!(first, submission_id());
    }

    #[test]
    fn hook_body_mirrors_node_field_rules() {
        let payload = json!({
            "hook_event_name": "SessionStart",
            "session_id": "s1",
            "notification_type": "permission_prompt",
            "background_tasks": [{ "description": "x" }],
            "prompt": "绝不出机的正文",
        });
        let body = build_hook_body("claude", &payload, 10, 9).unwrap();
        assert_eq!(
            Value::Object(body),
            json!({ "agent": "claude", "event": "SessionStart", "pid": 10, "ppid": 9, "agentSessionId": "s1" })
        );

        // codex notify：type + thread-id
        let payload = json!({ "type": "agent-turn-complete", "thread-id": "th1" });
        let body = build_hook_body("codex", &payload, 1, 0).unwrap();
        assert_eq!(body.get("event"), Some(&Value::from("agent-turn-complete")));
        assert_eq!(body.get("agentSessionId"), Some(&Value::from("th1")));

        // No session id → nothing to send.
        assert!(build_hook_body("claude", &json!({ "hook_event_name": "Stop" }), 1, 0).is_none());
        assert!(build_hook_body(
            "claude",
            &json!({ "hook_event_name": "Stop", "session_id": null }),
            1,
            0
        )
        .is_none());

        // 空事件名 / 非对象 → 放弃
        assert!(build_hook_body(
            "claude",
            &json!({ "hook_event_name": "", "session_id": "s" }),
            1,
            0
        )
        .is_none());
        assert!(build_hook_body(
            "claude",
            &json!({ "hook_event_name": "", "type": "t", "session_id": "s" }),
            1,
            0
        )
        .is_some());
        assert!(build_hook_body("claude", &json!([1, 2]), 1, 0).is_none());
        assert!(build_hook_body("claude", &json!({ "session_id": "s" }), 1, 0).is_none());
    }
}
