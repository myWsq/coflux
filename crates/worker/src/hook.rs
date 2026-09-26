//! loopback 本地 HTTP 端点：agent 与 daemon 之间的唯一反向通道。两条路径——
//!
//! - `/hook`（plan 073）：`coflux hook <agent>` 作为信使把 claude/codex 的 hook 事件送进来，
//!   用于判定回合状态。状态对齐 Vibe Island：active / approval / question / done
//!   （空 = 尚无 hook 信号）。
//! - `/agent`（plan 074；plan 094 起 local-first；executor 三条见下）：`coflux terminal|notify|progress|ports` 的控制
//!   请求，见 [crate::agent_ctl]——send/read/wait/notify/progress 在 daemon 本地闭环，new/list/ports
//!   由 daemon 代问中心。拒绝原因原样回给调用方：细节只是参数校验文案，吞成 `bad request` 只会让
//!   agent 盲目重试（plan 094）。`/hook` 的应答形态不变。
//!
//! 本模块只负责这条极小 HTTP 的解析与分派，业务分别交给 main 与 agent_ctl 的消费任务。
//!
//! 契约：响应在 pid→session 反查完成后才发出——调用方收到响应前不退出，保证扫描进程树时
//! 上报 pid 仍然存活。
//!
//! **安全边界（plan 074 起已不再是「纯展示」，勿沿用旧结论）**：本端点无认证，但**能起进程**
//! （`/agent` 的 terminal.new）。真正的门是 **pid 反查**：调用方的 pid 必须落在某个存活
//! session 的进程树内，否则一律拒——只有 coflux 自己起的 PTY 里的进程能用，且能力被钉死在
//! 它自己所属的 session 上。这道门由 [crate::agents::session_of_pid] 统一裁定，
//! 两条路径共用。
//!
//! Two transports reach these handlers (plan 20260926-agent-endpoint-hardening), see [`Caller`]:
//!
//! - the kernel-attested Unix socket `$COFLUX_HOME/ipc/agent.sock` ([crate::agent_socket]), where
//!   the pid is the kernel's and the body's `pid`/`ppid` are ignored — what current CLIs use;
//! - the loopback TCP gateway port, kept for agents still running an older pinned CLI. There the
//!   pid is self-reported, so the transport itself is hardened: the `Host` header must be exactly
//!   `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` for the accepted stream's own port,
//!   and any `Origin` header is refused (a browser always sends one on POST, and under DNS
//!   rebinding puts the attacker's name in `Host`; the content-type preflight is void there). On
//!   Linux the caller's socket must also belong to the worker's uid (`crate::gateway`).

use std::sync::Arc;
use std::time::Duration;

use coflux_protocol::logln;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::agent_ctl::{AgentAction, AgentRequest, AgentResponse};

/// 请求头读取上限。
const MAX_HEAD_BYTES: usize = 8 * 1024;
/// `/hook` 体上限：hook 载荷只有几个字段，几 KB 足够，超限即拒。
const MAX_BODY_BYTES: usize = 4 * 1024;
/// `/agent` 体上限：要装得下 64 KB 的 send 文本或命令行加 JSON 封包（plan 094，与 MCP 对齐）。
const MAX_AGENT_BODY_BYTES: usize = 128 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);
/// How much a client may still send after the reply before the connection is simply closed.
const MAX_DRAIN_BYTES: usize = MAX_HEAD_BYTES + MAX_AGENT_BODY_BYTES;
/// 等待 main 消费任务完成 pid 反查的上限（含一次 spawn_blocking 进程树扫描）。
const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);
/// agent 控制请求的等待上限：pid 反查之外还要等中心回执，故显著长于 hook
/// （须大于 agent_ctl::SERVER_TIMEOUT，否则这里先超时、那边的错误信息就丢了）。
const AGENT_TIMEOUT: Duration = Duration::from_secs(25);

/// Who is on the other end of a connection, decided by the transport before the request is read.
pub enum Caller {
    /// The loopback TCP gateway. `port` is the accepted stream's own local port (what a legitimate
    /// `Host` header names); `refusal` is set when the transport already refused the peer (the
    /// Linux uid check). The body's `pid`/`ppid` are the identity.
    Loopback { port: u16, refusal: Option<String> },
    /// The kernel-attested Unix socket: the peer's pid from `peer_cred()`, or why it was refused.
    /// The body's `pid`/`ppid` are ignored.
    Kernel(Result<i32, String>),
}

/// gateway 分派到本模块的两个消费端。
pub struct LocalEndpoints {
    pub hook_tx: mpsc::Sender<HookRequest>,
    pub agent_tx: mpsc::Sender<AgentRequest>,
}

/// 信使上报的事件（已解析）；respond 回填处理结果驱动 HTTP 响应。
pub struct HookRequest {
    pub agent: String,
    pub event: String,
    pub notification: String,
    pub background_tasks: u32,
    pub pid: i32,
    pub ppid: i32,
    /// The agent's own session identifier, already validated (plan 20260919). `None` means the
    /// messenger sent nothing usable — never a reason to drop the event itself.
    pub agent_session_id: Option<String>,
    pub respond: oneshot::Sender<HookOutcome>,
}

pub enum HookOutcome {
    /// 事件已接受并合并进 presence 状态
    Accepted,
    /// 事件名不在映射表内（如 SessionStart）：合法但无状态语义，不改变任何东西
    Ignored,
    /// 上报 pid 不在任何存活 session 的进程树内（coflux 之外启动的 agent）
    SessionNotFound,
}

/// hook 事件名（+ Notification 的类型 + 在飞后台工作数）→ 回合状态。claude 与 codex hooks
/// 引擎共用 claude 命名；codex 旧式 notify 用 kebab-case。名单外或 Notification 类型未知一律
/// 忽略（而非拒绝），用户多配了 hook 事件不会造成干扰。
pub fn event_state(event: &str, notification: &str, background_tasks: u32) -> Option<&'static str> {
    match event {
        // 干活的起点是 prompt 进入处理循环，不是第一次调工具：模型思考 + 纯文本输出的那一段
        // （xhigh 下几十秒起）若不算 active，状态会一直停在上一轮的 done；不调工具的问答轮次
        // 更是整轮都不亮。plan 073 当初怕「人没打字也被标成正在执行」（插件 Stop 续跑 / 排队
        // 消息也会打 UserPromptSubmit）——但那两种情形里 agent 恰恰确实在干活，标 active 是对的。
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => Some("active"),
        "PermissionRequest" | "approval-requested" => Some("approval"),
        // 回合结束**但仍有在飞的后台工作**（shell / subagent / monitor / workflow）：agent 不是
        // 「做完了等你看」，而是「挂起等后台把自己叫醒」——那些活儿一完成它必然继续干。此时落
        // done 会让用户白跑一趟去看一个还没结束的回合，且假完成窗口 = 后台任务的剩余时长
        // （一次 build/test 就是几分钟）。claude 的 Stop/SubagentStop payload 带 background_tasks
        // 正是为区分这两者而设。旧版 claude 与 codex 无此字段（信使给 0），行为与从前一致。
        "Stop" | "StopFailure" | "agent-turn-complete" => Some(if background_tasks > 0 {
            "active"
        } else {
            "done"
        }),
        "Notification" => match notification {
            "permission_prompt" => Some("approval"),
            "agent_needs_input" | "elicitation_dialog" | "elicitation_url_dialog" => {
                Some("question")
            }
            "agent_completed" | "idle_prompt" => Some("done"),
            _ => None,
        },
        _ => None,
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookBody {
    agent: String,
    event: String,
    #[serde(default)]
    notification: String,
    /// Self-reported identity, used on TCP only. Optional since the agent socket, where the kernel
    /// supplies the pid; on TCP a missing pid (0) simply fails the session lookup.
    #[serde(default)]
    pid: i32,
    #[serde(default)]
    ppid: i32,
    /// 信使从 Stop/SubagentStop payload 数出的在飞后台工作条数（旧信使不发 = 0）
    #[serde(default)]
    background_tasks: u32,
    /// The agent's own session id, forwarded verbatim by the messenger (claude `session_id`,
    /// codex `thread-id`). Deliberately typed as a free-form JSON value: the CLI copies whatever
    /// the agent put there (`commands.rs`, `session.clone()`), and a non-string must **not** make
    /// the whole body fail to deserialize — that would 400 the request and lose the presence
    /// event, which is far worse than a missing transcript id. Validated by
    /// [`sanitize_agent_session_id`] instead.
    #[serde(default)]
    agent_session_id: serde_json::Value,
}

/// The agent session id's upper bound. Claude ships a UUID (36 bytes) and Codex a ULID-ish
/// string; 128 leaves generous room while keeping the value obviously bounded.
const MAX_AGENT_SESSION_ID_BYTES: usize = 128;

/// Second line of defence for the agent session id (the first one is positional: every call site
/// passes the id as its own argv entry, never interpolated into command text). Anything that is
/// not a plain, bounded identifier yields `None` = "no id", and the event carrying it is still
/// processed normally.
pub fn sanitize_agent_session_id(value: &serde_json::Value) -> Option<String> {
    let text = value.as_str()?;
    if text.is_empty() || text.len() > MAX_AGENT_SESSION_ID_BYTES {
        return None;
    }
    if !text
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    // A leading dot would make the id look like a relative path component; refuse outright
    // rather than reasoning about what a consumer might do with it.
    if text.starts_with('.') {
        return None;
    }
    Some(text.to_string())
}

/// 处理一条本地端点连接（TCP 上已被 gateway 判定为 `POST ` 开头；Unix socket 上是整条连接）：
/// 解析请求 → 校验调用方 → 转交消费任务 → 等结果 → 应答。所有失败路径都尽力回一个 HTTP 错误响应后
/// 关闭连接。
pub async fn serve<S>(
    mut stream: S,
    endpoints: Arc<LocalEndpoints>,
    caller: Caller,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (status, body) = match handle(&mut stream, &endpoints, &caller).await {
        Ok(response) => (response.status, response.body),
        Err(RequestError::BadRequest(detail)) => {
            logln!("[worker] local endpoint bad request: {detail}");
            (
                "400 Bad Request",
                r#"{"ok":false,"error":"bad request"}"#.to_string(),
            )
        }
        Err(RequestError::Unavailable) => (
            "503 Service Unavailable",
            r#"{"ok":false,"error":"unavailable"}"#.to_string(),
        ),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = tokio::time::timeout(IO_TIMEOUT, stream.write_all(response.as_bytes())).await;
    close_gracefully(&mut stream).await;
    Ok(())
}

/// End the exchange gracefully: shut our write side down, then drain whatever the client still
/// sends until it closes (bounded in bytes and time). A refusal may be written before the body was
/// read; closing with unread bytes in the receive buffer resets the connection (Unix sockets on
/// macOS, TCP everywhere), and the client would lose the reply already written.
async fn close_gracefully<S>(stream: &mut S)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = tokio::time::timeout(IO_TIMEOUT, stream.shutdown()).await;
    let mut sink = [0u8; 4096];
    let mut drained = 0usize;
    let _ = tokio::time::timeout(IO_TIMEOUT, async {
        while drained < MAX_DRAIN_BYTES {
            match stream.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(n) => drained += n,
            }
        }
    })
    .await;
}

/// A refusal of the caller itself (not of its arguments): readable, and never the generic
/// `bad request`, so whoever hits it learns why.
fn forbidden(reason: impl AsRef<str>) -> AgentResponse {
    AgentResponse::err("403 Forbidden", format!("refused: {}", reason.as_ref()))
}

/// The TCP transport's own gate: `Host` must be exactly one of the loopback names with the
/// accepted stream's port, and no `Origin` may be present, whatever its value (`null` included).
/// Returns the refusal reason, or `None` when the request may proceed.
fn loopback_refusal(head: &Head, port: u16) -> Option<String> {
    if head.origin {
        return Some(
            "a request carrying an Origin header (a browser) cannot use the local agent endpoint"
                .into(),
        );
    }
    if head.host_count != 1 {
        return Some("the local agent endpoint needs exactly one Host header".into());
    }
    let host = head.host.as_deref().unwrap_or_default();
    let allowed = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ];
    if allowed.iter().any(|candidate| candidate == host) {
        None
    } else {
        Some(format!(
            "Host {host:?} is not this loopback endpoint (expected 127.0.0.1:{port})"
        ))
    }
}

enum RequestError {
    BadRequest(String),
    Unavailable,
}

async fn handle<S>(
    stream: &mut S,
    endpoints: &Arc<LocalEndpoints>,
    caller: &Caller,
) -> Result<AgentResponse, RequestError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (head, mut body) = read_head(stream).await.map_err(RequestError::BadRequest)?;
    let head = parse_head(&head).map_err(RequestError::BadRequest)?;
    // The caller is judged before anything in the request is acted on. `Some(pid)` = the kernel's
    // pid, which overrides whatever the body says; `None` = TCP, where the body's pid stands.
    let kernel_pid = match caller {
        Caller::Loopback { port, refusal } => {
            if let Some(reason) = refusal {
                return Ok(forbidden(reason));
            }
            if let Some(reason) = loopback_refusal(&head, *port) {
                logln!("[worker] local endpoint refused a TCP request: {reason}");
                return Ok(forbidden(reason));
            }
            None
        }
        Caller::Kernel(Ok(pid)) => Some(*pid),
        Caller::Kernel(Err(reason)) => return Ok(forbidden(reason)),
    };
    let Head {
        path,
        content_length,
        content_type,
        ..
    } = head;
    let is_agent = path == "/agent";
    if !is_agent && path != "/hook" {
        return Err(RequestError::BadRequest(format!("path {path}")));
    }
    if !content_type
        .to_ascii_lowercase()
        .contains("application/json")
    {
        return Err(RequestError::BadRequest("content-type 非 json".into()));
    }
    let body_limit = if is_agent {
        MAX_AGENT_BODY_BYTES
    } else {
        MAX_BODY_BYTES
    };
    if content_length > body_limit {
        if is_agent {
            return Ok(AgentResponse::err(
                "400 Bad Request",
                format!("请求体超过 {body_limit} 字节上限（命令 ≤ 16 KB、send 文本 ≤ 64 KB）"),
            ));
        }
        return Err(RequestError::BadRequest("body 超限".into()));
    }
    while body.len() < content_length {
        let mut chunk = vec![0u8; content_length - body.len()];
        let n = tokio::time::timeout(IO_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| RequestError::BadRequest("读 body 超时".into()))?
            .map_err(|error| RequestError::BadRequest(format!("读 body: {error}")))?;
        if n == 0 {
            return Err(RequestError::BadRequest("body 不完整".into()));
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let raw = &body[..content_length];
    if is_agent {
        // 拒绝原因回给调用方（plan 094）：都是参数校验文案，不是秘密；吞成 `bad request` 只会让 agent
        // 盲目重试。`/hook` 仍走下面的统一渲染。
        return match handle_agent(raw, &endpoints.agent_tx, kernel_pid).await {
            Err(RequestError::BadRequest(detail)) => {
                Ok(AgentResponse::err("400 Bad Request", detail))
            }
            other => other,
        };
    }

    let parsed: HookBody = serde_json::from_slice(raw)
        .map_err(|error| RequestError::BadRequest(format!("body JSON: {error}")))?;
    let agent_session_id = sanitize_agent_session_id(&parsed.agent_session_id);
    let (pid, ppid) = kernel_pid.map_or((parsed.pid, parsed.ppid), |pid| (pid, pid));
    // Two independent reasons to forward: the event carries turn state, or it carries the agent's
    // session id. `SessionStart` is exactly the second case — the transcript exists from that
    // moment on, so waiting for the first state-bearing event would keep the paper button hidden
    // through a whole first turn.
    if event_state(&parsed.event, &parsed.notification, parsed.background_tasks).is_none()
        && agent_session_id.is_none()
    {
        return Ok(hook_response(HookOutcome::Ignored));
    }
    let (respond, outcome_rx) = oneshot::channel();
    let request = HookRequest {
        agent: parsed.agent,
        event: parsed.event,
        notification: parsed.notification,
        background_tasks: parsed.background_tasks,
        pid,
        ppid,
        agent_session_id,
        respond,
    };
    endpoints
        .hook_tx
        .send(request)
        .await
        .map_err(|_| RequestError::Unavailable)?;
    match tokio::time::timeout(PROCESS_TIMEOUT, outcome_rx).await {
        Ok(Ok(outcome)) => Ok(hook_response(outcome)),
        _ => Err(RequestError::Unavailable),
    }
}

/// hook 路径的应答形态（保持 plan 073 起的原样，黑盒用例按它断言）。
fn hook_response(outcome: HookOutcome) -> AgentResponse {
    match outcome {
        HookOutcome::Accepted | HookOutcome::Ignored => AgentResponse {
            status: "200 OK",
            body: r#"{"ok":true}"#.to_string(),
        },
        HookOutcome::SessionNotFound => AgentResponse {
            status: "404 Not Found",
            body: r#"{"ok":false,"error":"session not found"}"#.to_string(),
        },
    }
}

/// `coflux terminal|notify|ports` 的请求体。动作名是扁平字符串而非嵌套结构——载荷极小，
/// CLI 侧一个函数就能发全部动作。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentBody {
    action: String,
    /// Self-reported identity, used on TCP only (see `HookBody::pid`).
    #[serde(default)]
    pid: i32,
    #[serde(default)]
    ppid: i32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    notification_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    enter: bool,
    /// `terminal.wait`: command sequence to wait for (0 = the latest one started) and the
    /// blocking bound in milliseconds (0 = the daemon's default round).
    #[serde(default)]
    command_seq: u64,
    #[serde(default)]
    timeout_ms: u64,
    /// 调用方的当前工作目录（plan 102）：CLI 每条请求都带 `process.cwd()`，daemon 据此把
    /// 请求的**目标**解析到 cwd 所在的工作区。旧 CLI 不带，缺省空串 = 退回归属工作区。
    #[serde(default)]
    cwd: String,
    /// 跟随 worktree 的动作要定位的绝对路径（plan 104）：locate 是 hook 载荷里的 `cwd`，
    /// forget 是 WorktreeRemove 载荷里的 `worktree_path`。与上面的 `cwd`（调用方进程的工作
    /// 目录）刻意分开——插件脚本在会话当前目录里执行，两者未必相同。
    #[serde(default)]
    path: String,
    /// executor（plan 116）：CLI 生成的稳定提交 id，重投不变——提交超时时靠它去重，
    /// 不向用户增加入参。
    #[serde(default)]
    submission_id: String,
    /// executor 的任务描述（唯一的自由入参）
    #[serde(default)]
    prompt: String,
    /// executor 读写模式：true = 可写
    #[serde(default)]
    write: bool,
    /// executor 的 run id（status / cancel）
    #[serde(default)]
    run_id: String,
}

/// 单次 send 的文本上限（也是 `terminal.run` 命令行的上限）：与 MCP `send_terminal_input` 的 64 KB
/// 同值（plan 094 对齐）；超长基本是误把文件内容当输入灌，直接拒绝比截断安全。
const MAX_SEND_TEXT_BYTES: usize = 64 * 1024;

/// executor 单条 prompt 的字节上限（plan 116）：与账本里的同值，在这里先挡一道，
/// 让超长请求连队列都进不去。
const MAX_EXECUTOR_PROMPT_BYTES: usize = crate::agent_ctl::executor::MAX_PROMPT_BYTES;

/// `kernel_pid`: the peer pid the agent socket read from the kernel; it replaces the body's
/// `pid` and `ppid` (`None` on TCP, where the body's values are the identity).
async fn handle_agent(
    raw: &[u8],
    agent_tx: &mpsc::Sender<AgentRequest>,
    kernel_pid: Option<i32>,
) -> Result<AgentResponse, RequestError> {
    let parsed: AgentBody = serde_json::from_slice(raw)
        .map_err(|error| RequestError::BadRequest(format!("body JSON: {error}")))?;
    let action = match parsed.action.as_str() {
        "terminal.new" => {
            // A terminal is always the default login shell (real tty, alive until exit/close).
            // The old `command` field meant "run this as a job and exit"; an old CLI that still
            // sends it must hear that the meaning is gone instead of silently getting a shell
            // that never runs its command.
            if !parsed.command.trim().is_empty() {
                return Err(RequestError::BadRequest(
                    "terminal.new no longer takes a command: open the terminal, then `coflux terminal run <taskId> --cmd=...` (update the coflux CLI)".into(),
                ));
            }
            AgentAction::TerminalNew {
                title: parsed.title,
            }
        }
        "terminal.list" => AgentAction::TerminalList,
        "terminal.run" => {
            // "do script": typed into an existing terminal once its shell signals prompt readiness.
            if parsed.task_id.trim().is_empty() {
                return Err(RequestError::BadRequest("terminal.run 缺 taskId".into()));
            }
            if parsed.command.trim().is_empty() {
                return Err(RequestError::BadRequest("terminal.run 缺 command".into()));
            }
            if parsed.command.len() > MAX_SEND_TEXT_BYTES {
                return Err(RequestError::BadRequest(format!(
                    "terminal.run command 超过 {MAX_SEND_TEXT_BYTES} 字节上限"
                )));
            }
            AgentAction::TerminalRun {
                task_id: parsed.task_id,
                command: parsed.command,
            }
        }
        "terminal.wait" => {
            if parsed.task_id.trim().is_empty() {
                return Err(RequestError::BadRequest("terminal.wait 缺 taskId".into()));
            }
            AgentAction::TerminalWait {
                task_id: parsed.task_id,
                command_seq: parsed.command_seq,
                timeout_ms: parsed.timeout_ms,
            }
        }
        "terminal.close" => {
            if parsed.task_id.trim().is_empty() {
                return Err(RequestError::BadRequest("terminal.close 缺 taskId".into()));
            }
            AgentAction::TerminalClose {
                task_id: parsed.task_id,
            }
        }
        "terminal.status" => {
            if parsed.task_id.trim().is_empty() {
                return Err(RequestError::BadRequest("terminal.status 缺 taskId".into()));
            }
            AgentAction::TerminalStatus {
                task_id: parsed.task_id,
            }
        }
        "terminal.read" => {
            if parsed.task_id.trim().is_empty() {
                return Err(RequestError::BadRequest("terminal.read 缺 taskId".into()));
            }
            AgentAction::TerminalRead {
                task_id: parsed.task_id,
            }
        }
        "terminal.send" => {
            if parsed.task_id.trim().is_empty() {
                return Err(RequestError::BadRequest("terminal.send 缺 taskId".into()));
            }
            if parsed.text.is_empty() && !parsed.enter {
                return Err(RequestError::BadRequest(
                    "terminal.send 缺 text（或至少 --enter）".into(),
                ));
            }
            if parsed.text.len() > MAX_SEND_TEXT_BYTES {
                return Err(RequestError::BadRequest(format!(
                    "terminal.send text 超过 {MAX_SEND_TEXT_BYTES} 字节上限"
                )));
            }
            AgentAction::TerminalSend {
                task_id: parsed.task_id,
                text: parsed.text,
                enter: parsed.enter,
            }
        }
        "notify" => {
            if parsed.message.trim().is_empty() {
                return Err(RequestError::BadRequest("notify 缺 message".into()));
            }
            AgentAction::Notify {
                notification_id: parsed.notification_id,
                message: parsed.message,
            }
        }
        "progress" => {
            if parsed.message.trim().is_empty() {
                return Err(RequestError::BadRequest("progress 缺 message".into()));
            }
            AgentAction::Progress {
                message: parsed.message,
            }
        }
        "ports" => AgentAction::Ports,
        "workspace.current" => AgentAction::WorkspaceCurrent,
        "workspace.locate" => {
            if parsed.path.trim().is_empty() {
                return Err(RequestError::BadRequest("workspace.locate 缺 path".into()));
            }
            AgentAction::WorkspaceLocate { path: parsed.path }
        }
        "workspace.forget" => {
            if parsed.path.trim().is_empty() {
                return Err(RequestError::BadRequest("workspace.forget 缺 path".into()));
            }
            AgentAction::WorkspaceForget { path: parsed.path }
        }
        "executor.submit" => {
            if parsed.submission_id.trim().is_empty() {
                return Err(RequestError::BadRequest("executor.submit 缺 submissionId".into()));
            }
            if parsed.prompt.trim().is_empty() {
                return Err(RequestError::BadRequest("executor.submit 缺 prompt".into()));
            }
            if parsed.prompt.len() > MAX_EXECUTOR_PROMPT_BYTES {
                return Err(RequestError::BadRequest(format!(
                    "executor.submit prompt 超过 {MAX_EXECUTOR_PROMPT_BYTES} 字节上限"
                )));
            }
            AgentAction::ExecutorSubmit {
                submission_id: parsed.submission_id,
                prompt: parsed.prompt,
                write: parsed.write,
            }
        }
        "executor.status" => {
            if parsed.run_id.trim().is_empty() {
                return Err(RequestError::BadRequest("executor.status 缺 runId".into()));
            }
            AgentAction::ExecutorStatus {
                run_id: parsed.run_id,
            }
        }
        "executor.cancel" => {
            if parsed.run_id.trim().is_empty() {
                return Err(RequestError::BadRequest("executor.cancel 缺 runId".into()));
            }
            AgentAction::ExecutorCancel {
                run_id: parsed.run_id,
            }
        }
        other => return Err(RequestError::BadRequest(format!("未知 action {other}"))),
    };
    let (pid, ppid) = kernel_pid.map_or((parsed.pid, parsed.ppid), |pid| (pid, pid));
    let (respond, outcome_rx) = oneshot::channel();
    let request = AgentRequest {
        pid,
        ppid,
        cwd: parsed.cwd,
        action,
        respond,
    };
    agent_tx
        .send(request)
        .await
        .map_err(|_| RequestError::Unavailable)?;
    match tokio::time::timeout(AGENT_TIMEOUT, outcome_rx).await {
        Ok(Ok(response)) => Ok(response),
        _ => Err(RequestError::Unavailable),
    }
}

/// 读到 `\r\n\r\n` 为止，返回（头部文本, 已多读进来的 body 前缀）。
async fn read_head<S>(stream: &mut S) -> Result<(String, Vec<u8>), String>
where
    S: AsyncRead + Unpin,
{
    let mut buffer = Vec::with_capacity(1024);
    loop {
        if buffer.len() > MAX_HEAD_BYTES {
            return Err("请求头超限".into());
        }
        let mut chunk = [0u8; 1024];
        let n = tokio::time::timeout(IO_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "读请求头超时".to_string())?
            .map_err(|error| format!("读请求头: {error}"))?;
        if n == 0 {
            return Err("连接提前关闭".into());
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
            let body = buffer[end + 4..].to_vec();
            return Ok((head, body));
        }
    }
}

/// The parts of a request head the endpoints look at.
struct Head {
    path: String,
    content_length: usize,
    content_type: String,
    /// The last `Host` value seen, and how many `Host` headers there were (more than one is
    /// ambiguous and refused on TCP).
    host: Option<String>,
    host_count: usize,
    /// Whether any `Origin` header was present, whatever its value.
    origin: bool,
}

/// 极小 HTTP 头解析：取 path / content-length / content-type / Host / Origin，其余头忽略。
fn parse_head(head: &str) -> Result<Head, String> {
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("空请求")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("请求行畸形")?;
    let path = parts.next().ok_or("请求行缺 path")?;
    if method != "POST" {
        return Err(format!("method {method}"));
    }
    let mut parsed = Head {
        path: path.to_string(),
        content_length: 0,
        content_type: String::new(),
        host: None,
        host_count: 0,
        origin: false,
    };
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                parsed.content_length = value
                    .trim()
                    .parse()
                    .map_err(|_| "content-length 畸形".to_string())?
            }
            "content-type" => parsed.content_type = value.trim().to_string(),
            "host" => {
                parsed.host = Some(value.trim().to_string());
                parsed.host_count += 1;
            }
            "origin" => parsed.origin = true,
            _ => {}
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回合结束但后台还有活 = 挂起等唤醒，不是完成；无后台工作时仍是 done。
    #[test]
    fn stop_with_background_work_is_not_done() {
        assert_eq!(event_state("Stop", "", 1), Some("active"));
        assert_eq!(event_state("StopFailure", "", 3), Some("active"));
        assert_eq!(event_state("Stop", "", 0), Some("done"));
        // 后台工作数只对回合结束类事件有意义，不改变其它事件的判定
        assert_eq!(event_state("PermissionRequest", "", 2), Some("approval"));
        assert_eq!(
            event_state("Notification", "agent_needs_input", 2),
            Some("question")
        );
        assert_eq!(event_state("SessionStart", "", 2), None);
    }

    /// A malformed id must degrade to "no id", and — crucially — it must not be able to make the
    /// body itself unparsable: the messenger forwards the agent's raw JSON value, so a number or
    /// an object has to survive deserialization and simply lose the id.
    #[test]
    fn agent_session_id_is_validated_without_dropping_the_event() {
        let ok = serde_json::json!("6fd5b5f9-959b-4845-91b8-e2f6cefc1a51");
        assert_eq!(
            sanitize_agent_session_id(&ok).as_deref(),
            Some("6fd5b5f9-959b-4845-91b8-e2f6cefc1a51")
        );
        for bad in [
            serde_json::json!(null),
            serde_json::json!(42),
            serde_json::json!({ "id": "x" }),
            serde_json::json!(""),
            serde_json::json!("a/b"),
            serde_json::json!("../../etc/passwd"),
            serde_json::json!("id with space"),
            serde_json::json!("$(whoami)"),
            serde_json::json!("x".repeat(MAX_AGENT_SESSION_ID_BYTES + 1)),
        ] {
            assert_eq!(sanitize_agent_session_id(&bad), None, "should reject {bad}");
        }

        // The whole body still deserializes when the field is a non-string, and the surviving
        // fields still drive presence.
        let raw = br#"{"agent":"claude","event":"Stop","pid":1,"agentSessionId":{"unexpected":true}}"#;
        let parsed: HookBody = serde_json::from_slice(raw).expect("body must still parse");
        assert_eq!(parsed.event, "Stop");
        assert_eq!(sanitize_agent_session_id(&parsed.agent_session_id), None);
        let missing = br#"{"agent":"claude","event":"Stop","pid":1}"#;
        let parsed: HookBody = serde_json::from_slice(missing).expect("absent field is fine");
        assert_eq!(sanitize_agent_session_id(&parsed.agent_session_id), None);
    }

    #[test]
    fn parse_head_extracts_fields() {
        let head = "POST /hook HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 42";
        let parsed = parse_head(head).unwrap();
        assert_eq!(parsed.path, "/hook");
        assert_eq!(parsed.content_length, 42);
        assert_eq!(parsed.content_type, "application/json");
        assert_eq!(parsed.host.as_deref(), Some("x"));
        assert_eq!(parsed.host_count, 1);
        assert!(!parsed.origin);
        assert!(parse_head("GET /hook HTTP/1.1").is_err());
    }

    fn head_with(headers: &str) -> Head {
        parse_head(&format!(
            "POST /agent HTTP/1.1\r\n{headers}content-type: application/json"
        ))
        .unwrap()
    }

    /// The TCP gate: only the exact loopback names with the accepted port, never an Origin.
    #[test]
    fn loopback_gate_accepts_only_cli_shaped_requests() {
        for host in ["127.0.0.1:8788", "localhost:8788", "[::1]:8788"] {
            let head = head_with(&format!("Host: {host}\r\n"));
            assert_eq!(loopback_refusal(&head, 8788), None, "{host} must pass");
        }
        for headers in [
            "",
            "Host: evil.example:8788\r\n",
            "Host: 127.0.0.1:8789\r\n",
            "Host: 127.0.0.1\r\n",
            "Host: localhost\r\n",
            "Host: 127.0.0.1:8788\r\nHost: 127.0.0.1:8788\r\n",
            "Host: 127.0.0.1:8788\r\nOrigin: http://x\r\n",
            "Host: 127.0.0.1:8788\r\nOrigin: null\r\n",
            "Host: 127.0.0.1:8788\r\norigin: \r\n",
        ] {
            let head = head_with(headers);
            assert!(loopback_refusal(&head, 8788).is_some(), "must refuse {headers:?}");
        }
    }

    /// On the agent socket a body may omit pid/ppid entirely.
    #[test]
    fn bodies_parse_without_pid() {
        let hook: HookBody =
            serde_json::from_slice(br#"{"agent":"claude","event":"Stop"}"#).unwrap();
        assert_eq!((hook.pid, hook.ppid), (0, 0));
        let agent: AgentBody = serde_json::from_slice(br#"{"action":"terminal.list"}"#).unwrap();
        assert_eq!((agent.pid, agent.ppid), (0, 0));
    }
}
