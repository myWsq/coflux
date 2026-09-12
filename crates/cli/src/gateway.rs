//! 与本机 daemon 的 loopback 通道：POST `http://127.0.0.1:<port>/agent|/hook`（plan 112）。
//!
//! 只打回环明文 HTTP，故不引 TLS/异步栈——`std::net::TcpStream` 手写最小 HTTP/1.1
//! （worker 侧 `crates/worker/src/hook.rs` 也是手写的极小 HTTP 服务端）。请求体、端点、
//! 超时与错误文案以 node 版 `packages/cli/coflux.mjs` 的 `agentPost` / `localGatewayPort` /
//! `agentTimeoutMs` 为参照。
//!
//! 注意：请求必须由本进程直接发出、收到响应才退出——worker 用请求体里的 pid 反查进程树认会话，
//! 中间再 fork 一层就会让 pid 落到树外。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

pub const DEFAULT_LOCAL_GATEWAY_PORT: u16 = coflux_protocol::LOCAL_GATEWAY_PORT;
/// agent 命令单次请求的默认等待上限（`/agent` 服务端自身的上限是 25 秒）。
pub const AGENT_TIMEOUT_MS: u64 = 30_000;
/// 调用方能收窄单次 `/agent` 等待的下限；再低就只够覆盖进程自己的启动，等于必然超时。
pub const MIN_AGENT_TIMEOUT_MS: u64 = 200;

/// `COFLUX_LOCAL_GATEWAY_PORT` → 端口：未设/空串取默认；非 1..=65535 的整数（含 dev/test 的
/// 随机端口 `0`）报「无法定位固定监听端口」。数值解析对齐 JS `Number()`：两侧空白可忽略、
/// 接受 `1e3` 这类写法。
pub fn local_gateway_port_from(raw: Option<&str>) -> Result<u16, String> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_LOCAL_GATEWAY_PORT);
    };
    if raw.is_empty() {
        return Ok(DEFAULT_LOCAL_GATEWAY_PORT);
    }
    let invalid = || format!("COFLUX_LOCAL_GATEWAY_PORT={raw} 无法定位固定监听端口");
    let number: f64 = raw.trim().parse().map_err(|_| invalid())?;
    if !number.is_finite() || number.fract() != 0.0 || !(1.0..=65535.0).contains(&number) {
        return Err(invalid());
    }
    Ok(number as u16)
}

pub fn local_gateway_port() -> Result<u16, String> {
    local_gateway_port_from(std::env::var("COFLUX_LOCAL_GATEWAY_PORT").ok().as_deref())
}

/// `COFLUX_AGENT_TIMEOUT_MS` 只允许收窄不允许放宽：畸形值一律按默认处理，
/// 合法值夹在 [MIN_AGENT_TIMEOUT_MS, AGENT_TIMEOUT_MS] 内并向下取整。
pub fn agent_timeout_ms_from(raw: Option<&str>) -> u64 {
    let Some(raw) = raw else {
        return AGENT_TIMEOUT_MS;
    };
    let number: f64 = match raw.trim().parse() {
        Ok(number) => number,
        Err(_) => return AGENT_TIMEOUT_MS,
    };
    if !number.is_finite() || number <= 0.0 {
        return AGENT_TIMEOUT_MS;
    }
    (number.floor() as u64).clamp(MIN_AGENT_TIMEOUT_MS, AGENT_TIMEOUT_MS)
}

pub fn agent_timeout() -> Duration {
    Duration::from_millis(agent_timeout_ms_from(
        std::env::var("COFLUX_AGENT_TIMEOUT_MS").ok().as_deref(),
    ))
}

/// 调用方的当前工作目录（plan 102）：目录被删掉时取不到，按「报不出来」给空串，daemon 退回归属工作区。
pub fn caller_cwd() -> String {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn pid() -> i64 {
    i64::from(std::process::id())
}

pub fn ppid() -> i64 {
    // SAFETY: getppid 无参数、无副作用、总是成功。
    i64::from(unsafe { libc::getppid() })
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// 对齐 fetch 的 `res.ok`：2xx。
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// 解析一条完整的 HTTP/1.1 响应字节流（服务端 `connection: close`，读到 EOF 即整条）。
/// 只取状态码与 content-length；有 content-length 时 body 截到该长度，没有就取剩余全部。
pub fn parse_response(raw: &[u8]) -> Result<HttpResponse, String> {
    let head_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("响应头不完整")?;
    let head = String::from_utf8_lossy(&raw[..head_end]);
    let mut lines = head.lines();
    let status_line = lines.next().ok_or("响应为空")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("状态行畸形: {status_line}"))?;
    let mut content_length: Option<usize> = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().ok();
            }
        }
    }
    let mut body = raw[head_end + 4..].to_vec();
    if let Some(length) = content_length {
        body.truncate(length);
    }
    Ok(HttpResponse { status, body })
}

/// 向本机 daemon POST 一份 JSON；整个往返（连接 + 写 + 读到 EOF）共用一个超时预算。
pub fn post_json(port: u16, path: &str, body: &str, timeout: Duration) -> Result<HttpResponse, String> {
    let started = Instant::now();
    let remaining = || -> Result<Duration, String> {
        timeout
            .checked_sub(started.elapsed())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| "请求超时".to_string())
    };
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, remaining()?).map_err(|error| error.to_string())?;
    let _ = stream.set_nodelay(true);
    let request = format!(
        "POST {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream
        .set_write_timeout(Some(remaining()?))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut raw = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        stream
            .set_read_timeout(Some(remaining()?))
            .map_err(|error| error.to_string())?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    parse_response(&raw)
}

/// The two kinds of `/agent` failure. They are separated for the executor's submit path: **only**
/// a Transport failure may be re-sent with the same submissionId (the daemon deduplicates on it);
/// re-sending a Refused request accomplishes nothing.
pub enum AgentError {
    /// Could not connect, could not write, or the read timed out — whether the request already ran
    /// is **unknown**.
    Transport(String),
    /// The daemon refused explicitly (configuration errors included); the text is a sentence meant
    /// for the calling agent and is passed through verbatim.
    Refused(String),
}

impl AgentError {
    /// The final sentence written to stderr (wording aligned with the node `agentPost`).
    pub fn message(&self) -> String {
        match self {
            Self::Transport(error) => {
                format!("连不上本机 daemon：{error}（daemon 没在跑？先看 cofluxd status）")
            }
            Self::Refused(error) => error.clone(),
        }
    }
}

/// Send one `/agent` request and return the daemon's JSON reply. The body automatically gains the
/// pid / ppid / cwd fields. Deliberately no automatic retry here: `terminal new` has side effects;
/// callers that want to retry decide for themselves (see the executor submit path).
pub fn agent_post_result(mut body: Map<String, Value>) -> Result<Value, AgentError> {
    let port = local_gateway_port().map_err(AgentError::Refused)?;
    body.insert("pid".into(), Value::from(pid()));
    body.insert("ppid".into(), Value::from(ppid()));
    body.insert("cwd".into(), Value::from(caller_cwd()));
    let payload = Value::Object(body).to_string();
    let response = post_json(port, "/agent", &payload, agent_timeout()).map_err(AgentError::Transport)?;
    let parsed: Option<Value> = serde_json::from_slice(&response.body).ok();
    let is_ok = parsed
        .as_ref()
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !response.ok() || !is_ok {
        let error = parsed
            .as_ref()
            .and_then(|value| value.get("error"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("daemon 返回 {}", response.status));
        return Err(AgentError::Refused(error));
    }
    Ok(parsed.unwrap_or(Value::Null))
}

/// Send one `/agent` request; any failure calls `die` (wording aligned with the node `agentPost`).
pub fn agent_post(body: Map<String, Value>) -> Value {
    match agent_post_result(body) {
        Ok(value) => value,
        Err(error) => crate::die(&error.message()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_defaults_and_rejects_like_node() {
        assert_eq!(local_gateway_port_from(None), Ok(DEFAULT_LOCAL_GATEWAY_PORT));
        assert_eq!(local_gateway_port_from(Some("")), Ok(DEFAULT_LOCAL_GATEWAY_PORT));
        assert_eq!(local_gateway_port_from(Some("8790")), Ok(8790));
        assert_eq!(local_gateway_port_from(Some(" 8790 ")), Ok(8790));
        assert_eq!(local_gateway_port_from(Some("1e3")), Ok(1000));
        assert_eq!(
            local_gateway_port_from(Some("0")),
            Err("COFLUX_LOCAL_GATEWAY_PORT=0 无法定位固定监听端口".to_string())
        );
        assert!(local_gateway_port_from(Some("65536")).is_err());
        assert!(local_gateway_port_from(Some("12.5")).is_err());
        assert!(local_gateway_port_from(Some("abc")).is_err());
    }

    #[test]
    fn agent_timeout_only_narrows() {
        assert_eq!(agent_timeout_ms_from(None), AGENT_TIMEOUT_MS);
        assert_eq!(agent_timeout_ms_from(Some("")), AGENT_TIMEOUT_MS);
        assert_eq!(agent_timeout_ms_from(Some("nope")), AGENT_TIMEOUT_MS);
        assert_eq!(agent_timeout_ms_from(Some("-5")), AGENT_TIMEOUT_MS);
        assert_eq!(agent_timeout_ms_from(Some("1500.9")), 1500);
        assert_eq!(agent_timeout_ms_from(Some("10")), MIN_AGENT_TIMEOUT_MS);
        assert_eq!(agent_timeout_ms_from(Some("999999")), AGENT_TIMEOUT_MS);
    }

    #[test]
    fn parses_http_response_with_content_length() {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.status, 200);
        assert!(response.ok());
        assert_eq!(response.body, b"{\"ok\":true}");
    }

    #[test]
    fn parses_error_status_and_truncates_to_content_length() {
        let raw = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 4\r\n\r\nabcdEXTRA";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.status, 403);
        assert!(!response.ok());
        assert_eq!(response.body, b"abcd");
    }

    #[test]
    fn body_without_content_length_takes_rest() {
        let response = parse_response(b"HTTP/1.1 200 OK\r\n\r\nrest").unwrap();
        assert_eq!(response.body, b"rest");
        assert!(parse_response(b"HTTP/1.1 200 OK\r\n").is_err());
        assert!(parse_response(b"garbage\r\n\r\n").is_err());
    }
}
