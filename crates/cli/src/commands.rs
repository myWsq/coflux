//! agent 侧子命令（plan 112）：`terminal new|list|read|wait|send`、`notify`、`progress`、
//! `ports`、`workspace [locate|forget]`、`hook <claude|codex>`，以及 `executor run`（plan 116，
//! 没有 node 版对应物——它是 Rust 版独有的新命令）。
//!
//! 请求体、stdout 文案与退出码逐命令对齐 node 版 `packages/cli/cofluxd.mjs`（`cmdTerminal` /
//! `cmdNotify` / `cmdProgress` / `cmdWorkspace` / `cmdPorts` / `cmdHook`）——SKILL.md 与黑盒用例引用
//! 的输出短语（如 `已开终端 <taskId>`）逐字保留。渲染逻辑抽成纯函数以便单测，I/O 只在 `run_*` 里。
//!
//! 与 `hook` 子命令的约定**相反**：这些命令必须写 stdout——输出就是给 agent 读的返回值。

use std::io::{IsTerminal, Read};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::args::ParsedArgs;
use crate::gateway;
use crate::text::{strip_ansi, tail_lines};

const DEFAULT_READ_LINES: usize = 200;
/// executor 轮询间隔。与 `terminal wait` 同款范式（单次 `/agent` 有 25 秒应答上限），
/// 但间隔更短：executor 的终态是用户在等的返回值，多等三秒都是白等。
const EXECUTOR_POLL: Duration = Duration::from_secs(2);
/// executor 默认等待上限（秒）。子任务常跑很久，与 `terminal wait` 取同一个数量级。
const DEFAULT_EXECUTOR_TIMEOUT_S: f64 = 1800.0;
/// 提交在**传输层**失败时的重投次数。重投用同一个 submissionId，daemon 侧按它去重——
/// 「提交超时不得盲目重发」说的是不得换 id 重发，不是不许重试。
const EXECUTOR_SUBMIT_RETRIES: usize = 2;
/// wait 的循环在 CLI 侧：单次 `/agent` 有 25 秒的 loopback 应答上限。默认 30 分钟——编码任务常跑很久；
/// 轮询走 terminal.status（daemon 本地账本直接答，不经中心），3 秒一次对本机 loopback 是零负担。
const DEFAULT_WAIT_TIMEOUT_S: f64 = 1800.0;
const WAIT_POLL: Duration = Duration::from_secs(3);

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

/// `--cmd` 缺省与 `--cmd= 空白` 等价（plan 101）：都开会话终端，空白收敛成空串。
pub fn normalize_command(cmd: Option<&str>) -> String {
    match cmd {
        Some(raw) if !raw.trim().is_empty() => raw.to_string(),
        _ => String::new(),
    }
}

pub fn render_terminal_new(result: &Value, command: &str) -> String {
    let task_id = field_str(result, "taskId");
    let mut lines = vec![format!("已开终端 {task_id}（用户可在 coflux 侧栏看到并随时接管）")];
    if !command.is_empty() {
        lines.push(format!("看输出：cofluxd terminal read {task_id}"));
    } else {
        lines.push("会话终端：常驻的登录 shell（全 tty），不会自己退出".to_string());
        lines.push(format!("先等提示符：cofluxd terminal read {task_id}"));
        lines.push(format!(
            "再输命令：cofluxd terminal send {task_id} --text \"<命令>\" --enter（送 exit 才结束）"
        ));
    }
    lines.join("\n")
}

pub fn render_terminal_list(result: &Value) -> String {
    let terminals = result
        .get("terminals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if terminals.is_empty() {
        return "本工作区暂无终端".to_string();
    }
    terminals
        .iter()
        .map(|t| {
            format!(
                "{}  {}{}  {}",
                field_str(t, "taskId"),
                field_str(t, "status"),
                exit_suffix(t),
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
    let text = if text.is_empty() { "（暂无输出）".to_string() } else { text };
    format!("{header}\n{text}")
}

pub fn render_terminal_send(task_id: &str) -> String {
    format!("已写入终端 {task_id}（用 cofluxd terminal read {task_id} 核对效果）")
}

/// `--timeout`：正数（可带小数）才生效，其余取默认 1800 秒。
pub fn wait_timeout_secs(raw: Option<&str>) -> f64 {
    raw.and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_S)
}

pub fn render_wait_exited(status: &Value) -> String {
    format!("# exited{}", exit_suffix(status))
}

pub fn render_wait_timeout(timeout_secs: f64, task_id: &str, status: &str) -> String {
    format!(
        "等待超时（{}s）：终端 {task_id} 仍是 {status}。可加大 --timeout，或 cofluxd terminal read {task_id} 看现场",
        js_number(&Value::from(timeout_secs))
    )
}

pub fn run_terminal(args: &ParsedArgs) {
    match args.positional(1) {
        Some("new") => {
            let command = normalize_command(args.string("cmd"));
            let request = with(
                with(body("terminal.new"), "title", args.string("title").unwrap_or("")),
                "command",
                command.as_str(),
            );
            let result = gateway::agent_post(request);
            println!("{}", render_terminal_new(&result, &command));
        }
        Some("list") => {
            let result = gateway::agent_post(body("terminal.list"));
            println!("{}", render_terminal_list(&result));
        }
        Some("read") => {
            let Some(task_id) = args.positional(2) else {
                crate::die("terminal read 需要 <taskId>（用 cofluxd terminal list 查）");
            };
            let lines = read_lines(args.string("lines"));
            let result = gateway::agent_post(with(body("terminal.read"), "taskId", task_id));
            println!("{}", render_terminal_read(&result, lines));
        }
        Some("send") => {
            let Some(task_id) = args.positional(2) else {
                crate::die("terminal send 需要 <taskId>（用 cofluxd terminal list 查）");
            };
            let text = args.string("text").unwrap_or("");
            let enter = args.flag("enter");
            if text.is_empty() && !enter {
                crate::die("terminal send 需要 --text \"<文本>\"（或至少 --enter 发一个回车）");
            }
            let request = with(
                with(with(body("terminal.send"), "taskId", task_id), "text", text),
                "enter",
                enter,
            );
            gateway::agent_post(request);
            println!("{}", render_terminal_send(task_id));
        }
        Some("wait") => {
            let Some(task_id) = args.positional(2) else {
                crate::die("terminal wait 需要 <taskId>（用 cofluxd terminal list 查）");
            };
            let timeout_secs = wait_timeout_secs(args.string("timeout"));
            // 极大的 --timeout（Duration/Instant 装不下）等价于「不设 deadline」，与 node 版一样不报错。
            let deadline = Duration::try_from_secs_f64(timeout_secs)
                .ok()
                .and_then(|timeout| Instant::now().checked_add(timeout));
            loop {
                // 按 taskId 直接问本地账本；目标不存在/不在本工作区时 daemon 回可读错误，agent_post 直接 die。
                let status = gateway::agent_post(with(body("terminal.status"), "taskId", task_id));
                if field_str(&status, "status") == "exited" {
                    println!("{}", render_wait_exited(&status));
                    return;
                }
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    crate::die(&render_wait_timeout(
                        timeout_secs,
                        task_id,
                        field_str(&status, "status"),
                    ));
                }
                std::thread::sleep(WAIT_POLL);
            }
        }
        _ => crate::die("terminal 需要子命令：new | list | read | wait | send"),
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
        crate::die("notify 需要一句话，例如：cofluxd notify \"两个方案拿不准，需要你定\"");
    }
    gateway::agent_post(with(body("notify"), "message", message));
    println!("已通知用户（工作区在侧栏转为「等待交互」）");
}

pub fn run_progress(args: &ParsedArgs) {
    let message = joined_message(args);
    if message.is_empty() {
        crate::die("progress 需要一句话，例如：cofluxd progress \"复现了，正在定位 relay 重连\"");
    }
    gateway::agent_post(with(body("progress"), "message", message));
    println!("已更新进度（显示在工作区卡片上，被下一条覆盖）");
}

/* -------------------------------- workspace ------------------------------ */
// 「我在哪」与「跟着我搬」（plan 102 / 103）。三条都打一行 JSON，字段稳定——插件脚本按它比对。

pub fn render_workspace_current(result: &Value) -> String {
    json_line(&[
        ("workspaceId", passthrough(result, "workspaceId")),
        ("path", passthrough(result, "path")),
        ("owningWorkspaceId", passthrough(result, "owningWorkspaceId")),
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
        Some("locate") => {
            // 路径缺省取调用方 cwd；插件脚本一律显式传 hook 载荷里的 cwd。
            let path = args
                .positional(2)
                .map(str::to_string)
                .unwrap_or_else(gateway::caller_cwd);
            if path.is_empty() {
                crate::die("workspace locate 需要 <path>（取不到当前目录）");
            }
            let result = gateway::agent_post(with(body("workspace.locate"), "path", path));
            println!("{}", render_workspace_locate(&result));
        }
        Some("forget") => {
            let Some(path) = args.positional(2) else {
                crate::die("workspace forget 需要 <path>（被删掉的 worktree 目录）");
            };
            let result = gateway::agent_post(with(body("workspace.forget"), "path", path));
            println!("{}", render_workspace_forget(&result));
        }
        Some(_) => crate::die("workspace 的子命令只有 locate | forget（不带子命令 = 报出我在哪）"),
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
        return "本工作区暂无监听端口".to_string();
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
// `cofluxd executor run`（plan 116）：把一个边界清楚的子任务甩给内置 executor。
//
// 三段式：**submit** 拿 runId（daemon 立刻答，带 `submissionId` 去重）→ CLI 侧 **轮询** status
// （单次 `/agent` 只有 25 秒应答上限，长任务不可能挂在一次请求上）→ 终态渲染。
// 等待超时时先发一条 cancel 再报错：不留一个没人看的写任务在后台改文件。

/// 本进程的稳定提交 id：pid + 启动时刻纳秒。**只生成一次**，传输层失败重投时原样复用——
/// daemon 按它去重，重投因此绝不会变成第二个 run。
fn submission_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("sub-{}-{nanos}", std::process::id())
}

/// `--timeout`：正数（可带小数）才生效，其余取默认 1800 秒。
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

/// 成功终态的 stdout：第一行是机器可读的状态行，其后是 executor 的最终回复与改动文件清单。
pub fn render_executor_success(status: &Value) -> String {
    let mut out = vec!["# succeeded".to_string()];
    let summary = field_str(status, "summary").trim().to_string();
    out.push(if summary.is_empty() {
        "（executor 没有留下最终回复）".to_string()
    } else {
        summary
    });
    let files = changed_files(status);
    if files.is_empty() {
        out.push("改动文件：无".to_string());
    } else {
        out.push(format!("改动文件（{}）：", files.len()));
        out.extend(files);
    }
    out.push("executor 不会 git commit：改动请自己 review 后提交。".to_string());
    out.join("\n")
}

/// 非成功终态的 stderr 一句话：终态名 + 原因 + 已经改了什么（被中断/失败时最要紧的信息）。
pub fn render_executor_failure(status: &Value) -> String {
    let terminal = field_str(status, "terminal");
    let terminal = if terminal.is_empty() { "unknown" } else { terminal };
    let mut reason = field_str(status, "error").trim().to_string();
    if reason.is_empty() {
        reason = field_str(status, "note").trim().to_string();
    }
    if reason.is_empty() {
        reason = "executor 没有给出原因".to_string();
    }
    let files = changed_files(status);
    let tail = if files.is_empty() {
        String::new()
    } else {
        format!("；已改动 {} 个文件：{}", files.len(), files.join(" "))
    };
    format!("executor 任务未成功（{terminal}）：{reason}{tail}")
}

pub fn render_executor_timeout(timeout_secs: f64, run_id: &str, phase: &str) -> String {
    format!(
        "等待超时（{}s）：executor 任务 {run_id} 仍是 {phase}，已请求取消。可加大 --timeout 后重发",
        js_number(&Value::from(timeout_secs))
    )
}

/// 提交：传输层失败按同一个 submissionId 重投；daemon 明确拒绝则原样报出去，不重投。
fn executor_submit(prompt: &str, write: bool) -> String {
    let submission = submission_id();
    let request = || {
        with(
            with(
                with(body("executor.submit"), "submissionId", submission.as_str()),
                "prompt",
                prompt,
            ),
            "write",
            write,
        )
    };
    let mut attempt = 0;
    loop {
        match gateway::agent_post_result(request()) {
            Ok(result) => {
                let run_id = field_str(&result, "runId").to_string();
                if run_id.is_empty() {
                    crate::die("daemon 没有返回 runId（版本太旧？）");
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
        crate::die("executor 的子命令只有 run：cofluxd executor run --prompt=\"<任务>\" [--write]");
    }
    let prompt = args.string("prompt").unwrap_or("").trim().to_string();
    if prompt.is_empty() {
        crate::die(
            "executor run 需要 --prompt=\"<任务>\"（一句把边界说清的任务描述，例如 --prompt=\"把 crates/worker 的 clippy 警告清掉\"）",
        );
    }
    let write = args.flag("write");
    let timeout_secs = executor_timeout_secs(args.string("timeout"));
    let deadline = Duration::try_from_secs_f64(timeout_secs)
        .ok()
        .and_then(|timeout| Instant::now().checked_add(timeout));
    let run_id = executor_submit(&prompt, write);
    loop {
        // 第一次轮询不等：拒绝（写锁被占 / 未配置模型）要立刻现形，不让 agent 白等一轮。
        let status = gateway::agent_post(with(body("executor.status"), "runId", run_id.as_str()));
        if field_str(&status, "phase") == "done" {
            // `succeeded` 是**任务**的成败；信封顶层那个 `ok` 说的是请求本身被接受了。
            if field_bool(&status, "succeeded") {
                println!("{}", render_executor_success(&status));
                return;
            }
            crate::die(&render_executor_failure(&status));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            // 先取消再报错：留一个没人看的写任务在后台改文件，比超时本身糟得多。
            let _ = gateway::agent_post_result(with(
                body("executor.cancel"),
                "runId",
                run_id.as_str(),
            ));
            crate::die(&render_executor_timeout(
                timeout_secs,
                &run_id,
                field_str(&status, "phase"),
            ));
        }
        std::thread::sleep(EXECUTOR_POLL);
    }
}

/* ---------------------------------- hook --------------------------------- */
// `cofluxd hook <claude|codex>`：信使。读 stdin/argv 的 hook 事件 JSON，只取事件名与进程坐标转发到
// `/hook`——payload 里的 prompt / 回答原文 / 通知正文一律不出机（隐私边界）。
//
// 纪律：绝不能干扰 agent 本体——任何失败都静默退出 0（claude 把 Stop hook 的非零退出码解释为
// "阻止收尾"）；绝不写 stdout（claude 会把 hook 的 stdout 当决策 JSON 解析），调试信息走 stderr
// （COFLUX_HOOK_DEBUG=1 开启）。请求保持到收到响应才退出——worker 处理期间用 pid 反查进程树。

/// stdin 没有数据时不能干等（notify 形态下 stdin 是继承的 TTY/空管道）。
const HOOK_STDIN_TIMEOUT: Duration = Duration::from_millis(300);
const HOOK_POST_TIMEOUT: Duration = Duration::from_millis(2000);

fn hook_debug_enabled() -> bool {
    std::env::var("COFLUX_HOOK_DEBUG").is_ok_and(|value| !value.is_empty())
}

fn hook_debug(enabled: bool, message: &str) {
    if enabled {
        eprintln!("[cofluxd hook] {message}");
    }
}

/// 非 TTY 时最多等 300ms 读 stdin：到点用已读到的部分（对齐 node 版 `Promise.race` 的语义）。
fn read_stdin_json() -> Option<Value> {
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

/// hook 载荷 → `/hook` 请求体。返回 None 表示载荷不可用（缺事件名等），调用方静默放弃。
/// 字段顺序与省略规则同 node 版：`JSON.stringify` 会丢掉 undefined 的键。
pub fn build_hook_body(agent: &str, payload: &Value, pid: i64, ppid: i64) -> Option<Map<String, Value>> {
    let object = payload.as_object()?;
    // claude/codex hooks 引擎用 hook_event_name；codex notify 用 type（JS `||`：空串也落到下一个）
    let event = object
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| object.get("type").and_then(Value::as_str).filter(|text| !text.is_empty()))?;
    let mut map = Map::new();
    map.insert("agent".into(), Value::from(agent));
    map.insert("event".into(), Value::from(event));
    map.insert("pid".into(), Value::from(pid));
    map.insert("ppid".into(), Value::from(ppid));
    // agent 自身的会话标识（claude: session_id / codex notify: thread-id），供 worker 去重与调试
    let session = object
        .get("session_id")
        .filter(|value| !value.is_null())
        .or_else(|| object.get("thread-id").filter(|value| !value.is_null()));
    if let Some(session) = session {
        map.insert("agentSessionId".into(), session.clone());
    }
    // Claude Notification 的类型枚举（permission_prompt / agent_needs_input …），不含正文
    let notification = object
        .get("notification_type")
        .filter(|value| !value.is_null())
        .or_else(|| object.get("notificationType").filter(|value| !value.is_null()))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    if let Some(notification) = notification {
        map.insert("notification".into(), Value::from(notification));
    }
    // Stop/SubagentStop 独有：在飞的后台工作条数。只传条数——条目里的 description 是自由文本，不出机。
    if let Some(tasks) = object.get("background_tasks").and_then(Value::as_array) {
        map.insert("backgroundTasks".into(), Value::from(tasks.len()));
    }
    Some(map)
}

/// 永远以 0 退出、永不写 stdout。
pub fn run_hook(args: &ParsedArgs) {
    let debug = hook_debug_enabled();
    let agent = match args.positional(1) {
        Some(agent @ ("claude" | "codex")) => agent,
        other => {
            hook_debug(debug, &format!("未知 agent: {}（需 claude|codex）", other.unwrap_or("(缺参)")));
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
        hook_debug(debug, "无有效 payload，忽略");
        return;
    };
    let Some(request) = build_hook_body(agent, &payload, gateway::pid(), gateway::ppid()) else {
        hook_debug(debug, "payload 缺事件名，忽略");
        return;
    };
    let port = match gateway::local_gateway_port() {
        Ok(port) => port,
        Err(error) => {
            hook_debug(debug, &error);
            return;
        }
    };
    let encoded = Value::Object(request).to_string();
    hook_debug(debug, &format!("POST /hook {encoded}"));
    match gateway::post_json(port, "/hook", &encoded, HOOK_POST_TIMEOUT) {
        Ok(response) => hook_debug(debug, &format!("响应 {}", response.status)),
        Err(error) => hook_debug(debug, &error),
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
    fn terminal_new_output_matches_node_for_job_and_session_terminals() {
        let result = json!({ "ok": true, "taskId": "t-1" });
        assert_eq!(
            render_terminal_new(&result, "pnpm test"),
            "已开终端 t-1（用户可在 coflux 侧栏看到并随时接管）\n看输出：cofluxd terminal read t-1"
        );
        let session = render_terminal_new(&result, "");
        assert!(session.starts_with("已开终端 t-1（用户可在 coflux 侧栏看到并随时接管）\n会话终端：常驻的登录 shell（全 tty），不会自己退出\n"));
        assert!(session.contains("先等提示符：cofluxd terminal read t-1\n"));
        assert!(session.ends_with("再输命令：cofluxd terminal send t-1 --text \"<命令>\" --enter（送 exit 才结束）"));
    }

    #[test]
    fn command_normalization_collapses_blank_to_empty() {
        assert_eq!(normalize_command(None), "");
        assert_eq!(normalize_command(Some("   ")), "");
        assert_eq!(normalize_command(Some(" ls ")), " ls ");
    }

    #[test]
    fn terminal_list_rows_and_empty() {
        assert_eq!(render_terminal_list(&json!({ "terminals": [] })), "本工作区暂无终端");
        let result = json!({ "terminals": [
            { "taskId": "a", "status": "running", "title": "构建" },
            { "taskId": "b", "status": "exited", "exitCode": 0, "title": "测试" },
            { "taskId": "c", "status": "exited", "exitCode": null, "title": "" },
        ] });
        assert_eq!(render_terminal_list(&result), "a  running  构建\nb  exited exit=0  测试\nc  exited  ");
    }

    #[test]
    fn terminal_read_strips_ansi_and_tails() {
        let result = json!({ "status": "exited", "exitCode": 1, "ansi": "\u{1b}[32mok\u{1b}[0m\nline2\n\n\n" });
        assert_eq!(render_terminal_read(&result, 1), "# exited exit=1\nline2");
        assert_eq!(render_terminal_read(&json!({ "status": "running", "ansi": "" }), 5), "# running\n（暂无输出）");
        assert_eq!(render_terminal_read(&json!({ "status": "running" }), 5), "# running\n（暂无输出）");
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
    fn wait_and_send_phrases() {
        assert_eq!(render_wait_exited(&json!({ "status": "exited", "exitCode": 130 })), "# exited exit=130");
        assert_eq!(render_wait_exited(&json!({ "status": "exited" })), "# exited");
        assert_eq!(
            render_wait_timeout(90.0, "t-1", "running"),
            "等待超时（90s）：终端 t-1 仍是 running。可加大 --timeout，或 cofluxd terminal read t-1 看现场"
        );
        assert_eq!(
            render_wait_timeout(2.5, "t-1", "running"),
            "等待超时（2.5s）：终端 t-1 仍是 running。可加大 --timeout，或 cofluxd terminal read t-1 看现场"
        );
        assert_eq!(render_terminal_send("t-1"), "已写入终端 t-1（用 cofluxd terminal read t-1 核对效果）");
    }

    #[test]
    fn notify_message_joins_positionals() {
        assert_eq!(joined_message(&parsed(&["notify", "两个方案", "拿不准"])), "两个方案 拿不准");
        assert_eq!(joined_message(&parsed(&["notify", "  "])), "");
        assert_eq!(joined_message(&parsed(&["notify"])), "");
    }

    #[test]
    fn workspace_json_lines_keep_node_field_order_and_omit_missing() {
        let current = json!({ "ok": true, "workspaceId": "w1", "path": "/a", "owningWorkspaceId": "w0", "moved": true });
        assert_eq!(
            render_workspace_current(&current),
            r#"{"workspaceId":"w1","path":"/a","owningWorkspaceId":"w0","moved":true}"#
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
    fn ports_rows_and_empty() {
        assert_eq!(render_ports(&json!({ "ports": [] })), "本工作区暂无监听端口");
        let result = json!({ "ports": [
            { "port": 5173, "url": "https://x.coflux.dev" },
            { "port": 8080, "url": "" },
        ] });
        assert_eq!(render_ports(&result), "5173  https://x.coflux.dev\n8080  ");
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
    fn executor_success_prints_the_reply_the_files_and_the_no_commit_boundary() {
        let status = json!({
            "phase": "done", "terminal": "succeeded", "succeeded": true,
            "summary": "清掉了 7 条 clippy 警告", "changedFiles": ["crates/worker/src/a.rs", "crates/worker/src/b.rs"],
        });
        let text = render_executor_success(&status);
        assert!(text.starts_with("# succeeded\n清掉了 7 条 clippy 警告\n"), "{text}");
        assert!(text.contains("改动文件（2）：\ncrates/worker/src/a.rs\ncrates/worker/src/b.rs"), "{text}");
        assert!(text.contains("不会 git commit"), "{text}");
        // 没改动 / 没回复也要说清楚，不能打印空白
        let empty = render_executor_success(&json!({ "phase": "done", "succeeded": true }));
        assert!(empty.contains("（executor 没有留下最终回复）"), "{empty}");
        assert!(empty.contains("改动文件：无"), "{empty}");
    }

    #[test]
    fn executor_failure_names_the_terminal_state_and_the_reason() {
        let rejected = render_executor_failure(&json!({
            "terminal": "rejected", "note": "该工作区已有一个写模式 executor 在跑",
        }));
        assert_eq!(
            rejected,
            "executor 任务未成功（rejected）：该工作区已有一个写模式 executor 在跑"
        );
        // error 优先于 note，并带上已经改了哪些文件
        let failed = render_executor_failure(&json!({
            "terminal": "tool_failed", "note": "工具失败", "error": "写文件被沙箱拒绝",
            "changedFiles": ["a.rs"],
        }));
        assert_eq!(
            failed,
            "executor 任务未成功（tool_failed）：写文件被沙箱拒绝；已改动 1 个文件：a.rs"
        );
        // 字段全缺也要有一句可读的话
        let bare = render_executor_failure(&json!({}));
        assert!(bare.contains("unknown"), "{bare}");
        assert!(bare.contains("没有给出原因"), "{bare}");
    }

    #[test]
    fn executor_timeout_message_says_it_cancelled() {
        let text = render_executor_timeout(90.0, "run-1", "running");
        assert!(text.contains("等待超时（90s）"), "{text}");
        assert!(text.contains("已请求取消"), "{text}");
        assert!(text.contains("--timeout"), "{text}");
    }

    #[test]
    fn hook_body_mirrors_node_field_rules() {
        let payload = json!({
            "hook_event_name": "Notification",
            "session_id": "s1",
            "notification_type": "permission_prompt",
            "prompt": "绝不出机的正文",
        });
        let body = build_hook_body("claude", &payload, 10, 9).unwrap();
        assert_eq!(
            Value::Object(body),
            json!({ "agent": "claude", "event": "Notification", "pid": 10, "ppid": 9, "agentSessionId": "s1", "notification": "permission_prompt" })
        );

        // codex notify：type + thread-id
        let payload = json!({ "type": "agent-turn-complete", "thread-id": "th1" });
        let body = build_hook_body("codex", &payload, 1, 0).unwrap();
        assert_eq!(body.get("event"), Some(&Value::from("agent-turn-complete")));
        assert_eq!(body.get("agentSessionId"), Some(&Value::from("th1")));
        assert!(!body.contains_key("notification"));
        assert!(!body.contains_key("backgroundTasks"));

        // Stop 带 background_tasks：只传条数
        let payload = json!({ "hook_event_name": "Stop", "background_tasks": [{ "description": "x" }, { "description": "y" }] });
        let body = build_hook_body("claude", &payload, 1, 0).unwrap();
        assert_eq!(body.get("backgroundTasks"), Some(&Value::from(2)));

        // 空事件名 / 非对象 → 放弃
        assert!(build_hook_body("claude", &json!({ "hook_event_name": "" }), 1, 0).is_none());
        assert!(build_hook_body("claude", &json!({ "hook_event_name": "", "type": "t" }), 1, 0).is_some());
        assert!(build_hook_body("claude", &json!([1, 2]), 1, 0).is_none());
        assert!(build_hook_body("claude", &json!({ "session_id": "s" }), 1, 0).is_none());
    }
}
