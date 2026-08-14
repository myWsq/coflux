//! agent hook 事件接收（活动状态的语义信号源）。
//!
//! `cofluxd hook <agent>` 作为信使，把 claude/codex 的 hook 事件 POST 到本地 gateway 的
//! `/hook`。本模块解析这条极小的 HTTP 请求并交给 main 的消费任务：用上报的 pid 反查
//! 进程树归属哪个 session，再把回合状态（active/waiting）合并进 agent presence 上报。
//!
//! 契约：响应在 pid→session 反查完成后才发出——信使收到响应前不退出，保证扫描进程树时
//! 上报 pid 仍然存活。
//!
//! 安全边界：loopback 无认证端点，伪造上报最多翻转 UI 活动状态（纯展示、不触发任何操作）。
//! 仍要求 content-type: application/json——浏览器跨源发不出这种"非简单请求"（预检必失败），
//! 挡掉网页脚本对 localhost 的盲打。

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

/// 请求头 + 体的读取上限；信使的载荷只有几十字节，超限即拒。
const MAX_HEAD_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);
/// 等待 main 消费任务完成 pid 反查的上限（含一次 spawn_blocking 进程树扫描）。
const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);

/// 信使上报的事件（已解析）；respond 回填处理结果驱动 HTTP 响应。
pub struct HookRequest {
    pub agent: String,
    pub event: String,
    pub pid: i32,
    pub ppid: i32,
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

/// hook 事件名 → 回合状态。claude 与 codex hooks 引擎共用 claude 命名；
/// codex 旧式 notify 用 kebab-case 事件。名单外的事件一律忽略（而非拒绝），
/// 用户多配了 hook 事件不会造成干扰。
pub fn event_state(event: &str) -> Option<&'static str> {
    match event {
        // 回合进行中：提交了 prompt / 正在跑工具
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => Some("active"),
        // 等待用户交互：回合结束 / 需要权限确认 / agent 主动通知
        "Stop" | "Notification" | "PermissionRequest" | "agent-turn-complete" | "approval-requested" => Some("waiting"),
        _ => None,
    }
}

#[derive(serde::Deserialize)]
struct HookBody {
    agent: String,
    event: String,
    pid: i32,
    #[serde(default)]
    ppid: i32,
}

/// 处理一条已被 gateway 判定为 `POST ` 开头的连接：解析请求 → 转交消费任务 → 等结果 → 应答。
/// 所有失败路径都尽力回一个 HTTP 错误响应后关闭连接。
pub async fn serve(mut stream: TcpStream, hook_tx: mpsc::Sender<HookRequest>) -> Result<(), String> {
    let (status, body) = match handle(&mut stream, &hook_tx).await {
        Ok(outcome) => match outcome {
            HookOutcome::Accepted | HookOutcome::Ignored => ("200 OK", r#"{"ok":true}"#),
            HookOutcome::SessionNotFound => ("404 Not Found", r#"{"ok":false,"error":"session not found"}"#),
        },
        Err(RequestError::BadRequest(detail)) => {
            eprintln!("[worker] hook bad request: {detail}");
            ("400 Bad Request", r#"{"ok":false,"error":"bad request"}"#)
        }
        Err(RequestError::Unavailable) => ("503 Service Unavailable", r#"{"ok":false,"error":"unavailable"}"#),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = tokio::time::timeout(IO_TIMEOUT, stream.write_all(response.as_bytes())).await;
    let _ = stream.shutdown().await;
    Ok(())
}

enum RequestError {
    BadRequest(String),
    Unavailable,
}

async fn handle(stream: &mut TcpStream, hook_tx: &mpsc::Sender<HookRequest>) -> Result<HookOutcome, RequestError> {
    let (head, mut body) = read_head(stream).await.map_err(RequestError::BadRequest)?;
    let (path, content_length, content_type) = parse_head(&head).map_err(RequestError::BadRequest)?;
    if path != "/hook" {
        return Err(RequestError::BadRequest(format!("path {path}")));
    }
    if !content_type.to_ascii_lowercase().contains("application/json") {
        return Err(RequestError::BadRequest("content-type 非 json".into()));
    }
    if content_length > MAX_BODY_BYTES {
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
    let parsed: HookBody =
        serde_json::from_slice(&body[..content_length]).map_err(|error| RequestError::BadRequest(format!("body JSON: {error}")))?;
    if event_state(&parsed.event).is_none() {
        return Ok(HookOutcome::Ignored);
    }
    let (respond, outcome_rx) = oneshot::channel();
    let request = HookRequest { agent: parsed.agent, event: parsed.event, pid: parsed.pid, ppid: parsed.ppid, respond };
    hook_tx.send(request).await.map_err(|_| RequestError::Unavailable)?;
    match tokio::time::timeout(PROCESS_TIMEOUT, outcome_rx).await {
        Ok(Ok(outcome)) => Ok(outcome),
        _ => Err(RequestError::Unavailable),
    }
}

/// 读到 `\r\n\r\n` 为止，返回（头部文本, 已多读进来的 body 前缀）。
async fn read_head(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
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

/// 极小 HTTP 头解析：只取 path / content-length / content-type，其余头忽略。
fn parse_head(head: &str) -> Result<(String, usize, String), String> {
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("空请求")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("请求行畸形")?;
    let path = parts.next().ok_or("请求行缺 path")?;
    if method != "POST" {
        return Err(format!("method {method}"));
    }
    let mut content_length = 0usize;
    let mut content_type = String::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.trim().parse().map_err(|_| "content-length 畸形".to_string())?,
            "content-type" => content_type = value.trim().to_string(),
            _ => {}
        }
    }
    Ok((path.to_string(), content_length, content_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_mapping_covers_both_agents() {
        assert_eq!(event_state("UserPromptSubmit"), Some("active"));
        assert_eq!(event_state("Stop"), Some("waiting"));
        assert_eq!(event_state("PermissionRequest"), Some("waiting"));
        assert_eq!(event_state("agent-turn-complete"), Some("waiting"));
        assert_eq!(event_state("SessionStart"), None);
        assert_eq!(event_state(""), None);
    }

    #[test]
    fn parse_head_extracts_fields() {
        let head = "POST /hook HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 42";
        let (path, length, content_type) = parse_head(head).unwrap();
        assert_eq!(path, "/hook");
        assert_eq!(length, 42);
        assert_eq!(content_type, "application/json");
        assert!(parse_head("GET /hook HTTP/1.1").is_err());
    }
}
