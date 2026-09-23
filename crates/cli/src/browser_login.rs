//! `coflux login` through the browser (plan 20260923-oauth-login-redesign): RFC 8252 loopback redirect
//! with PKCE (S256), or a paste code when the browser cannot reach back (SSH).
//!
//! 1. listen on 127.0.0.1:<ephemeral> (skipped in paste mode)
//! 2. `POST /api/client/login/request` with the port or "paste", the S256 challenge and a state
//! 3. print the page URL and try to open the browser
//! 4. wait for `http://127.0.0.1:<port>/callback?code=…&state=…`, or read the pasted code
//! 5. `POST /api/client/login/exchange` with code + verifier → session token
//!
//! The verifier never leaves this process, so a code is useless to anyone else. Ctrl-C simply ends
//! the process; the server-side request expires on its own.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// What the browser flow hands back to `account::run`.
pub struct Granted {
    pub token: String,
    pub account_id: Value,
    pub login: String,
}

const MAX_REQUEST_BYTES: usize = 8 * 1024;

fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; len];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|e| format!("无法生成随机数：{e}"))?;
    Ok(bytes)
}

/// RFC 4648 base64url without padding.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = chunk.len() + 1;
        for index in 0..chars {
            out.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }
    out
}

/// PKCE S256 challenge of a verifier.
pub fn s256(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// Paste mode when forced (`COFLUX_LOGIN_PASTE=1`) or when running over SSH, where the browser that
/// opens the page is on another machine and cannot reach this one's loopback.
fn prefers_paste() -> bool {
    let set = |name: &str| std::env::var_os(name).is_some_and(|value| !value.is_empty());
    set("COFLUX_LOGIN_PASTE") || set("SSH_CONNECTION") || set("SSH_TTY") || set("SSH_CLIENT")
}

fn host_name() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: gethostname writes at most `buffer.len()` bytes into a buffer we own.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if result == 0 {
        let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
        let name = String::from_utf8_lossy(&buffer[..end]).trim().to_string();
        if !name.is_empty() {
            return name.chars().take(253).collect();
        }
    }
    "unknown-host".into()
}

fn open_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(opener)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

fn failure_message(kind: &str) -> &'static str {
    match kind {
        "not_allowed" => "该邮箱未开通 Coflux",
        "not_verified" => "该账号的邮箱未经验证，无法登录",
        "cancelled" => "已取消登录",
        _ => "登录未完成，请重试",
    }
}

fn respond(stream: &mut TcpStream, status: &str, title: &str, body: &str) {
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>{title} · Coflux</title>\
         <style>:root{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
         font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}}main{{text-align:center;padding:24px}}h1{{font-size:18px}}</style></head>\
         <body><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.flush();
}

/// One HTTP request line from the loopback listener: the request target, or None if unreadable.
fn read_target(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(stream.take(MAX_REQUEST_BYTES as u64));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    parts.next().map(str::to_string)
}

enum Callback {
    Code(String),
    Failed(String),
}

/// Wait on the loopback listener until the page redirects back with our state, or the deadline passes.
/// Anything else that reaches the port (wrong path, wrong state) gets a 404 and is ignored.
fn wait_for_callback(listener: &TcpListener, state: &str, deadline: Instant) -> Result<(Callback, TcpStream), String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    loop {
        if Instant::now() >= deadline {
            return Err("登录超时，请重新运行 coflux login".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let Some(target) = read_target(&mut stream) else {
                    continue;
                };
                let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
                    respond(&mut stream, "400 Bad Request", "请求无效", "这个地址只用于 Coflux 登录回调。");
                    continue;
                };
                let param = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
                if url.path() != "/callback" || param("state").as_deref() != Some(state) {
                    respond(&mut stream, "404 Not Found", "页面不存在", "这个地址只用于 Coflux 登录回调。");
                    continue;
                }
                if let Some(error) = param("error") {
                    return Ok((Callback::Failed(error), stream));
                }
                return Ok((Callback::Code(param("code").unwrap_or_default()), stream));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(format!("登录回调监听失败：{error}")),
        }
    }
}

type Post<'a> = &'a dyn Fn(&str, Value) -> Result<Value, String>;

fn exchange(post: Post, code: &str, verifier: &str) -> Result<Granted, String> {
    let value = post(
        "/api/client/login/exchange",
        json!({"protocolVersion": 1, "code": code, "codeVerifier": verifier}),
    )?;
    let token = value["token"].as_str().filter(|token| !token.is_empty()).ok_or("服务器没有返回会话")?;
    Ok(Granted {
        token: token.to_string(),
        account_id: value["accountId"].clone(),
        login: value["login"].as_str().unwrap_or("").to_string(),
    })
}

/// Run the browser flow against `server` (an origin already validated by `account::origin`).
/// `post` is the account HTTP helper bound to that server.
pub fn run(server: &str, post: Post) -> Result<Granted, String> {
    let verifier = base64url(&random_bytes(32)?);
    let challenge = s256(&verifier);
    let state = base64url(&random_bytes(24)?);
    let listener = if prefers_paste() { None } else { TcpListener::bind("127.0.0.1:0").ok() };
    let port = match &listener {
        Some(listener) => Some(listener.local_addr().map_err(|e| e.to_string())?.port()),
        None => None,
    };
    let mut body = json!({
        "protocolVersion": 1,
        "clientKind": "cli",
        "host": host_name(),
        "redirect": if port.is_some() { "loopback" } else { "paste" },
        "codeChallenge": challenge,
        "codeChallengeMethod": "S256",
        "state": state,
    });
    if let Some(port) = port {
        body["port"] = json!(port);
    }
    let registered = post("/api/client/login/request", body)?;
    let page = registered["url"].as_str().ok_or("服务器没有返回登录地址")?;
    let parsed = url::Url::parse(page).map_err(|_| "服务器返回的登录地址无效")?;
    // Only ever open a page on the server we are logging into.
    if parsed.origin().ascii_serialization() != server {
        return Err("服务器返回的登录地址不在该服务器上".into());
    }
    let expires_at = registered["expiresAt"].as_f64().unwrap_or(0.0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    let wait = if expires_at > now_ms { Duration::from_millis((expires_at - now_ms) as u64) } else { Duration::from_secs(600) };

    eprintln!("在浏览器中打开以下地址完成登录（Ctrl-C 取消）：\n  {page}");
    let Some(listener) = listener else {
        eprintln!("登录后页面会显示一次性登录码。");
        eprint!("粘贴登录码：");
        let _ = io::stderr().flush();
        let mut line = String::new();
        io::stdin().lock().take(256).read_line(&mut line).map_err(|e| e.to_string())?;
        let code = line.trim();
        if code.is_empty() {
            return Err("没有输入登录码".into());
        }
        return exchange(post, code, &verifier);
    };
    open_browser(page);
    let (callback, mut stream) = wait_for_callback(&listener, &state, Instant::now() + wait)?;
    match callback {
        Callback::Failed(kind) => {
            let message = failure_message(&kind);
            respond(&mut stream, "200 OK", "登录未完成", &format!("{message}。可以关闭此页面，回到终端。"));
            Err(message.into())
        }
        Callback::Code(code) => match exchange(post, &code, &verifier) {
            Ok(granted) => {
                respond(&mut stream, "200 OK", "已登录", "已登录，可以回到终端。");
                Ok(granted)
            }
            Err(error) => {
                respond(&mut stream, "200 OK", "登录未完成", "登录未完成，请回到终端查看原因。");
                Err(error)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_rfc4648_vectors() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn s256_matches_rfc7636_example() {
        assert_eq!(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFWFlC6EcCwsZtpHTu4X9-UThXrtcM1s");
    }
}
