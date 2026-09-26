//! The kernel-attested agent socket (plan 20260926-agent-endpoint-hardening):
//! `$COFLUX_HOME/ipc/agent.sock` serves the same `POST /agent` and `POST /hook` as the loopback
//! gateway port, with the same HTTP/1.1 framing and the same handlers ([`crate::hook::serve`]).
//!
//! What differs is identity. On TCP the caller *reports* its pid in the body; here the worker reads
//! the peer's pid and uid from the kernel (`UnixStream::peer_cred()`: `LOCAL_PEEREPID` on macOS,
//! `SO_PEERCRED` on Linux). The uid must be ours, and the pid replaces both the body's `pid` and
//! `ppid`, so a body may omit them and a forged one changes nothing. The session lookup itself
//! stays with the consumers (`session_of_pid`), exactly as on TCP; a caller outside every
//! session tree is refused there.
//!
//! No Host, Origin or `/proc/net/tcp` check here: a browser cannot reach a Unix socket, another
//! user cannot open it (0600 inside a 0700 directory, plus the uid comparison), and Node's
//! `http.request({ socketPath })` sends `Host: localhost` without a port anyway.
//!
//! Current CLIs (`crates/cli/src/gateway.rs`, `packages/cli/coflux.mjs`) try this socket first and
//! fall back to the TCP port only when it is absent (older worker). The directory is prepared once
//! and shared with the secret socket ([`crate::secret::socket::prepare_directory`]).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use coflux_protocol::logln;
use tokio::net::UnixStream;

use crate::hook::{self, Caller, LocalEndpoints};

/// File name inside `ipc/`. Mirrored by the Rust CLI (`AGENT_SOCKET_FILE` in
/// `crates/cli/src/gateway.rs`) and the npm CLI (`AGENT_SOCKET` in `packages/cli/coflux.mjs`);
/// change all three together.
pub const SOCKET_FILE: &str = "agent.sock";

/// Serve the agent socket for the lifetime of this worker.
pub async fn run(directory: PathBuf, owner_uid: u32, endpoints: Arc<LocalEndpoints>) {
    let Some(listener) =
        crate::secret::socket::listen(&directory.join(SOCKET_FILE), "agent-socket").await
    else {
        return;
    };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                logln!("[agent-socket] accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let endpoints = endpoints.clone();
        tokio::spawn(async move {
            // Identity is read before anything else, straight from the kernel; the request is
            // still read in full by `serve` before a refusal is written (see its graceful close).
            let caller = Caller::Kernel(identify(&stream, owner_uid));
            if let Err(error) = hook::serve(stream, endpoints, caller).await {
                logln!("[agent-socket] connection closed: {error}");
            }
        });
    }
}

/// The caller's pid as the kernel reports it, or the refusal text.
fn identify(stream: &UnixStream, owner_uid: u32) -> Result<i32, String> {
    let credentials = stream
        .peer_cred()
        .map_err(|error| format!("cannot identify the caller: {error}"))?;
    if credentials.uid() != owner_uid {
        logln!(
            "[agent-socket] refused a caller running as uid {}",
            credentials.uid()
        );
        return Err("the caller runs as another user".into());
    }
    credentials
        .pid()
        .ok_or_else(|| "the kernel did not report the caller's pid".to_string())
}
