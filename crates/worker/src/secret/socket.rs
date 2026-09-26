//! The kernel-attested local socket every `coflux secret` action travels over.
//!
//! Unlike the loopback `/agent` endpoint (where the caller *reports* its pid), identity here comes
//! from the kernel: for each connection the worker reads the peer's pid with
//! `UnixStream::peer_cred()` (`LOCAL_PEEREPID` on macOS, `SO_PEERCRED` on Linux) and requires it
//! to sit inside a live session's process tree. That session is the caller's identity and the only
//! session whose values it can touch. The request body never carries a pid.
//!
//! Location: `$COFLUX_HOME/ipc/secret.sock`, the socket 0600 inside a 0700 directory. The CLI
//! derives the same path from `COFLUX_HOME` (default `~/.coflux`), so terminals opened before a
//! worker hot upgrade still find it without any new PTY environment variable.
//!
//! Wire format: line-delimited JSON, one request line per connection, one reply line.
//!
//! ```text
//! → {"op":"ask","name":"NAME","reason":"why","timeoutMs":600000}
//! ← {"ok":true,"outcome":"provided"|"declined"|"cancelled","detail":""|"closed"|"timeout"|"session_ended"}
//! → {"op":"release","names":["NAME",…]}
//! ← {"ok":true,"values":{"NAME":"value",…}}
//! → {"op":"inject","name":"NAME","file":".env","key":"KEY","cwd":"/abs/cwd"}
//! ← {"ok":true,"path":"/abs/.env","key":"KEY","created":true,"replaced":false}
//! ← {"ok":false,"code":"not_in_session"|"bad_request"|"no_center"|"busy"|"not_provided"|"refused","error":"…"}
//! ```
//!
//! An `ask` keeps its connection open until the outcome; the client closing it (Ctrl-C, killed
//! agent) withdraws the request so every card closes. A worker that goes away (hot upgrade,
//! runtime restart) closes the connection, which the CLI reports as `cancelled`.

use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::logln;
use coflux_protocol::wire::{self, agent_control_request};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Semaphore};

use super::{valid_name, AskOutcome, CancelReason, MAX_REASON_CHARS};
use crate::device::DeviceRuntime;
use crate::{agent_ctl, agents, WorkerState, WsOut};

/// Directory (under `COFLUX_HOME`) and file name of the socket. Mirrored by the CLI
/// (`crates/cli/src/secret.rs`); change both together.
pub const SOCKET_DIR: &str = "ipc";
pub const SOCKET_FILE: &str = "secret.sock";
/// The inbox entry every request produces starts with this, followed by the NAME. The desktop
/// recognises secret-request entries by it (`secret-request.ts`); change both together.
pub const NOTIFY_PREFIX: &str = "Secret requested: ";

/// `sun_path` is 104 bytes on macOS and 108 on Linux; stay clear of both.
const MAX_SOCKET_PATH_BYTES: usize = 100;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
const REPLY_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 64;
const MAX_RELEASE_NAMES: usize = 32;
const DEFAULT_ASK_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const MIN_ASK_TIMEOUT_MS: u64 = 1_000;
const MAX_ASK_TIMEOUT_MS: u64 = 60 * 60 * 1000;

struct Context {
    state: Arc<Mutex<WorkerState>>,
    device: Arc<DeviceRuntime>,
    to_server: mpsc::Sender<WsOut>,
    owner_uid: u32,
}

/// Serve the secret socket for the lifetime of this worker.
pub async fn run(
    home: String,
    state: Arc<Mutex<WorkerState>>,
    device: Arc<DeviceRuntime>,
    to_server: mpsc::Sender<WsOut>,
) {
    let (directory, owner_uid) = match prepare_directory(&home) {
        Ok(prepared) => prepared,
        Err(error) => {
            logln!("[secret] socket disabled: {error}");
            return;
        }
    };
    let path = directory.join(SOCKET_FILE);
    if path.as_os_str().len() > MAX_SOCKET_PATH_BYTES {
        logln!(
            "[secret] socket disabled: {} is longer than {MAX_SOCKET_PATH_BYTES} bytes",
            path.display()
        );
        return;
    }
    let mut warned_busy = false;
    let listener = loop {
        match bind(&path).await {
            Ok(listener) => break listener,
            Err(BindError::Busy) => {
                if !warned_busy {
                    logln!("[secret] another live worker holds {}; retrying", path.display());
                    warned_busy = true;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(BindError::Failed(error)) => {
                logln!("[secret] cannot bind {}: {error}; retrying", path.display());
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    };
    logln!("[secret] listening on {}", path.display());
    let context = Arc::new(Context {
        state,
        device,
        to_server,
        owner_uid,
    });
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                logln!("[secret] accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            tokio::spawn(async move {
                let mut stream = stream;
                reply(&mut stream, &refusal("busy", "too many concurrent secret requests; retry")).await;
            });
            continue;
        };
        let context = context.clone();
        tokio::spawn(async move {
            handle_connection(stream, &context).await;
            drop(permit);
        });
    }
}

/// `$COFLUX_HOME/ipc`, created 0700 and forced back to 0700 if it already exists. Refuses a
/// symlink or a non-directory in its place. Returns the directory and its owner uid (ours).
fn prepare_directory(home: &str) -> Result<(PathBuf, u32), String> {
    let directory = Path::new(home).join(SOCKET_DIR);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!("{} exists and is not a directory", directory.display()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&directory)
                .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
        }
        Err(error) => return Err(format!("cannot inspect {}: {error}", directory.display())),
    }
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("cannot restrict {}: {error}", directory.display()))?;
    let owner_uid = std::fs::metadata(&directory)
        .map_err(|error| error.to_string())?
        .uid();
    Ok((directory, owner_uid))
}

enum BindError {
    /// A live worker answers on the existing socket: never steal it.
    Busy,
    Failed(String),
}

/// Probe, then unlink and bind. Upgrades never run two workers at once (the supervisor stops the
/// old child before starting the next), so a socket nobody answers on is a stale leftover.
async fn bind(path: &Path) -> Result<UnixListener, BindError> {
    if std::fs::symlink_metadata(path).is_ok() {
        let probe = tokio::time::timeout(Duration::from_millis(500), UnixStream::connect(path)).await;
        if matches!(probe, Ok(Ok(_))) {
            return Err(BindError::Busy);
        }
        std::fs::remove_file(path).map_err(|error| BindError::Failed(error.to_string()))?;
    }
    let listener = UnixListener::bind(path).map_err(|error| BindError::Failed(error.to_string()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| BindError::Failed(error.to_string()))?;
    Ok(listener)
}

fn refusal(code: &str, error: impl AsRef<str>) -> Value {
    json!({ "ok": false, "code": code, "error": error.as_ref() })
}

async fn reply(stream: &mut UnixStream, value: &Value) {
    let mut line = value.to_string().into_bytes();
    line.push(b'\n');
    let _ = tokio::time::timeout(REPLY_WRITE_TIMEOUT, stream.write_all(&line)).await;
}

async fn handle_connection(mut stream: UnixStream, context: &Context) {
    // Identity first, from the kernel; the body is not even read for a stranger.
    let credentials = match stream.peer_cred() {
        Ok(credentials) => credentials,
        Err(error) => {
            reply(&mut stream, &refusal("not_in_session", format!("cannot identify the caller: {error}"))).await;
            return;
        }
    };
    if credentials.uid() != context.owner_uid {
        reply(&mut stream, &refusal("not_in_session", "the caller runs as another user")).await;
        return;
    }
    let Some(pid) = credentials.pid() else {
        reply(&mut stream, &refusal("not_in_session", "the kernel did not report the caller's pid")).await;
        return;
    };
    let alive = context.state.lock().unwrap().alive.clone();
    let session = {
        let alive = alive.clone();
        tokio::task::spawn_blocking(move || agents::session_of_pid(&alive, pid, pid))
            .await
            .ok()
            .flatten()
    };
    let Some(session_id) = session else {
        logln!("[secret] refused a caller outside every coflux terminal (pid {pid})");
        reply(
            &mut stream,
            &refusal(
                "not_in_session",
                "not inside a coflux terminal: coflux secret only works for processes started in a terminal coflux opened",
            ),
        )
        .await;
        return;
    };
    let task_id = alive
        .get(&session_id)
        .map(|(task_id, _)| task_id.clone())
        .unwrap_or_default();

    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = Vec::new();
    let read = tokio::time::timeout(
        REQUEST_READ_TIMEOUT,
        (&mut reader).take(MAX_REQUEST_BYTES).read_until(b'\n', &mut line),
    )
    .await;
    let request: Value = match read {
        Ok(Ok(n)) if n > 0 && line.ends_with(b"\n") => match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(_) => {
                write_reply(&mut write_half, &refusal("bad_request", "the request is not valid JSON")).await;
                return;
            }
        },
        _ => {
            write_reply(&mut write_half, &refusal("bad_request", "no complete request line")).await;
            return;
        }
    };
    let op = request.get("op").and_then(Value::as_str).unwrap_or_default();
    match op {
        "ask" => {
            let answer = ask(context, &session_id, &task_id, &request, &mut reader).await;
            if let Some(answer) = answer {
                write_reply(&mut write_half, &answer).await;
            }
        }
        "release" => release(context, &session_id, &request, &mut write_half).await,
        "inject" => {
            let answer = inject(context, &session_id, &request).await;
            write_reply(&mut write_half, &answer).await;
        }
        _ => write_reply(&mut write_half, &refusal("bad_request", format!("unknown op {op:?}"))).await,
    }
}

async fn write_reply(writer: &mut tokio::net::unix::OwnedWriteHalf, value: &Value) {
    let mut line = value.to_string().into_bytes();
    line.push(b'\n');
    let _ = tokio::time::timeout(REPLY_WRITE_TIMEOUT, writer.write_all(&line)).await;
}

/// `ask`: register the request, raise one inbox entry, then wait for an answer, the deadline, or
/// the client going away. `None` = the client is gone, nothing to reply.
async fn ask(
    context: &Context,
    session_id: &str,
    task_id: &str,
    request: &Value,
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
) -> Option<Value> {
    let name = request.get("name").and_then(Value::as_str).unwrap_or_default();
    if !valid_name(name) {
        return Some(refusal("bad_request", "NAME must look like an environment variable name ([A-Za-z_][A-Za-z0-9_]*)"));
    }
    let reason = request
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if reason.is_empty() {
        return Some(refusal("bad_request", "--reason is required: tell the user why you need it"));
    }
    if reason.chars().count() > MAX_REASON_CHARS {
        return Some(refusal("bad_request", format!("--reason is longer than {MAX_REASON_CHARS} characters")));
    }
    let timeout_ms = request
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_ASK_TIMEOUT_MS)
        .clamp(MIN_ASK_TIMEOUT_MS, MAX_ASK_TIMEOUT_MS);
    if !context.state.lock().unwrap().authed {
        return Some(refusal(
            "no_center",
            "this device is not connected to the coflux server, so no desktop can show the request; try again once it is online",
        ));
    }
    let vault = context.device.secrets();
    let mut ticket = match vault.begin_ask(session_id, task_id, name, &reason, Duration::from_millis(timeout_ms)) {
        Ok(ticket) => ticket,
        Err(error) => return Some(refusal("busy", error)),
    };
    logln!("[secret] ask name={name} session={session_id} request={}", ticket.request_id);

    // One persisted inbox entry per request: it brings the system notification, the badge and
    // click-to-open-terminal with it. Best effort: the card is driven by the snapshot either way.
    {
        let state = context.state.clone();
        let to_server = context.to_server.clone();
        let session_id = session_id.to_string();
        let message = format!("{NOTIFY_PREFIX}{name} — {reason}");
        tokio::spawn(async move {
            let notification_id = {
                use rand_core::RngCore;
                let mut bytes = [0u8; 24];
                rand_core::OsRng.fill_bytes(&mut bytes);
                hex::encode(bytes)
            };
            let payload = agent_control_request::Payload::Notify(wire::AgentNotify {
                notification_id,
                message,
            });
            if let Err(response) =
                agent_ctl::ask_server(&state, &to_server, session_id, String::new(), payload).await
            {
                logln!("[secret] inbox entry for the request failed: {}", response.status);
            }
        });
    }

    let mut probe = [0u8; 1];
    let outcome = tokio::select! {
        outcome = &mut ticket.outcome => outcome.unwrap_or(AskOutcome::Cancelled(CancelReason::Timeout)),
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            if vault.withdraw(&ticket.request_id) {
                AskOutcome::Cancelled(CancelReason::Timeout)
            } else {
                // An answer won the race with the deadline; report it.
                (&mut ticket.outcome).await.unwrap_or(AskOutcome::Cancelled(CancelReason::Timeout))
            }
        }
        _ = reader.read(&mut probe) => {
            // EOF (Ctrl-C, killed agent) or a protocol violation: the client stopped waiting.
            if vault.withdraw(&ticket.request_id) {
                logln!("[secret] ask withdrawn by the client request={}", ticket.request_id);
            }
            return None;
        }
    };
    logln!(
        "[secret] ask settled request={} outcome={}",
        ticket.request_id,
        outcome.word()
    );
    Some(json!({ "ok": true, "outcome": outcome.word(), "detail": outcome.detail() }))
}

/// `release`: hand the values to the owning session's CLI (for `coflux secret exec`). The reply
/// is serialized straight into a zeroing buffer.
async fn release(
    context: &Context,
    session_id: &str,
    request: &Value,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) {
    let names: Vec<String> = request
        .get("names")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() || names.len() > MAX_RELEASE_NAMES || !names.iter().all(|name| valid_name(name)) {
        write_reply(writer, &refusal("bad_request", format!("pass 1 to {MAX_RELEASE_NAMES} valid NAMEs"))).await;
        return;
    }
    match context.device.secrets().release_reply(session_id, &names) {
        Ok(bytes) => {
            let _ = tokio::time::timeout(REPLY_WRITE_TIMEOUT, writer.write_all(bytes.as_bytes())).await;
        }
        Err(missing) => {
            write_reply(writer, &not_provided(&missing)).await;
        }
    }
}

fn not_provided(missing: &[String]) -> Value {
    let list = missing.join(", ");
    let first = missing.first().map(String::as_str).unwrap_or("NAME");
    refusal(
        "not_provided",
        format!(
            "not provided in this terminal: {list}. Run `coflux secret ask {first} --reason \"…\"` first (values belong to the terminal that asked and end with it)"
        ),
    )
}

/// `inject`: the worker writes the dotenv entry itself; the value never leaves this process.
async fn inject(context: &Context, session_id: &str, request: &Value) -> Value {
    let name = request.get("name").and_then(Value::as_str).unwrap_or_default();
    if !valid_name(name) {
        return refusal("bad_request", "NAME must look like an environment variable name");
    }
    let key = match request.get("key").and_then(Value::as_str) {
        Some(key) if !key.is_empty() => key,
        _ => name,
    };
    if !valid_name(key) {
        return refusal("bad_request", "--key must look like an environment variable name");
    }
    let file = request.get("file").and_then(Value::as_str).unwrap_or_default().to_string();
    let cwd = request.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
    let root = match agent_ctl::effective_workspace_root(&context.state, session_id, &cwd) {
        Ok(root) => root,
        Err(error) => return refusal("refused", error),
    };
    let Some(value) = context.device.secrets().clone_value(session_id, name) else {
        return not_provided(&[name.to_string()]);
    };
    let key_owned = key.to_string();
    let outcome = tokio::task::spawn_blocking(move || {
        let (target, existed) = super::dotenv::resolve_target(&root, &cwd, &file)?;
        super::dotenv::write_entry(&target, existed, &key_owned, &value)
    })
    .await;
    match outcome {
        Ok(Ok(written)) => {
            logln!("[secret] injected {name} as {key} into {}", written.path);
            json!({
                "ok": true,
                "path": written.path,
                "key": key,
                "created": written.created,
                "replaced": written.replaced,
            })
        }
        Ok(Err(error)) => refusal("refused", error),
        Err(_) => refusal("refused", "the write task failed"),
    }
}
