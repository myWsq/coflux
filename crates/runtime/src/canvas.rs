//! Canvases (plan 20261112-agent-canvas): HTML files an agent shows to the user.
//!
//! `coflux canvas show <file.html>` registers the file in the **workspace** the caller's cwd is in;
//! a desktop then loads it in a browser tab, where the existing annotation overlay works. This
//! module is both halves of the device side:
//!
//! - [`CanvasStore`]: the per-workspace registry under `$COFLUX_HOME/canvases/<workspaceId>/index.json`
//!   (directories 0700, files 0600, atomic writes). A canvas is identified by the canonical path of
//!   its file, so showing the same file again keeps its id — and therefore its address, which is
//!   what the desktop's annotations are matched by. The center only ever receives the revision-only
//!   [`wire::CanvasSummary`], as a full idempotent snapshot on every change and after
//!   authentication.
//! - [`serve`]: a loopback-only HTTP listener of its own (never the local gateway: a page written
//!   by an agent must not share an origin with `/agent` and `/device`). It answers
//!   `GET|HEAD /<canvasId>/<relative path>` from the **directory of the canvas's file**, read live,
//!   so the page's sibling assets load and an edit shows on reload. Nothing outside that directory
//!   is ever served: the target is canonicalized (symlinks resolved) and must stay under it.
//!
//! The registry stores absolute paths and needs neither the center nor the worker's workspace
//! table to list or serve. Entries whose file is gone are skipped when listing; nothing else
//! removes an entry.
//!
//! Store methods do blocking file I/O under one lock; async callers run them on the blocking pool.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::os::unix::fs::DirBuilderExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use coflux_protocol::logln;
use coflux_protocol::wire::{self, daemon_to_server};
use prost::Message as _;
use rand_core::{OsRng, RngCore as _};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::annotations::valid_segment;
use crate::WsOut;

const INDEX_FILE: &str = "index.json";
const INDEX_VERSION: u32 = 1;
/// Per workspace; the oldest entries make room.
const MAX_CANVASES: usize = 200;
const MAX_TITLE_CHARS: usize = 200;
const MAX_SUMMARY_WORKSPACES: usize = 1024;
const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredCanvas {
    pub id: String,
    pub title: String,
    /// Canonical absolute path of the HTML file.
    pub path: String,
    /// Unix milliseconds of the last `show`.
    pub updated_at: u64,
}

impl StoredCanvas {
    pub fn file_name(&self) -> String {
        Path::new(&self.path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    pub fn to_wire(&self) -> wire::Canvas {
        wire::Canvas {
            id: self.id.clone(),
            title: self.title.clone(),
            file_name: self.file_name(),
            updated_at_ms: self.updated_at,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WorkspaceIndex {
    version: u32,
    revision: u32,
    canvases: Vec<StoredCanvas>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Default)]
struct Inner {
    workspaces: HashMap<String, WorkspaceIndex>,
    /// Whether every workspace directory on disk has been loaded (a summary and the listener's id
    /// lookup both need all of them).
    scanned: bool,
}

pub struct CanvasStore {
    root: PathBuf,
    inner: Mutex<Inner>,
    to_server: mpsc::Sender<WsOut>,
    /// The listener's actual port; 0 while it is not running.
    port: AtomicU32,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// 128 bits from the OS: the id is the only thing between a local process and the directory.
fn fresh_id() -> String {
    let mut random = [0u8; 16];
    OsRng.fill_bytes(&mut random);
    hex::encode(random)
}

fn is_html(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm"))
}

fn clip_title(value: &str) -> String {
    value.trim().chars().filter(|c| !c.is_control()).take(MAX_TITLE_CHARS).collect()
}

impl CanvasStore {
    pub fn new(home: &str, to_server: mpsc::Sender<WsOut>) -> Self {
        let home = Path::new(home);
        let home = if home.is_absolute() {
            home.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(home))
                .unwrap_or_else(|_| home.to_path_buf())
        };
        Self {
            root: home.join("canvases"),
            inner: Mutex::new(Inner::default()),
            to_server,
            port: AtomicU32::new(0),
        }
    }

    /// The listener's port, or 0 when it is not running.
    pub fn port(&self) -> u32 {
        self.port.load(Ordering::Relaxed)
    }

    fn set_port(&self, port: u16) {
        self.port.store(u32::from(port), Ordering::Relaxed);
    }

    /// The address a desktop loads, when the listener runs.
    pub fn url(&self, canvas: &StoredCanvas) -> Option<String> {
        let port = self.port();
        (port != 0).then(|| {
            format!(
                "http://localhost:{port}/{}/{}",
                canvas.id,
                encode_path_segment(&canvas.file_name())
            )
        })
    }

    fn read_index(&self, workspace_id: &str) -> Result<WorkspaceIndex, String> {
        let path = self.root.join(workspace_id).join(INDEX_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(WorkspaceIndex::default()),
            Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
        };
        let index: WorkspaceIndex = serde_json::from_slice(&bytes)
            .map_err(|error| format!("canvas index {} is unreadable: {error}", path.display()))?;
        if index.version != INDEX_VERSION {
            return Err(format!(
                "canvas index {} has version {}, this runtime reads {INDEX_VERSION}",
                path.display(),
                index.version
            ));
        }
        Ok(index)
    }

    fn write_index(&self, workspace_id: &str, index: &WorkspaceIndex) -> Result<(), String> {
        let dir = self.root.join(workspace_id);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
        let bytes = serde_json::to_vec_pretty(index).map_err(|error| error.to_string())?;
        crate::atomic_file::write_atomic(&dir.join(INDEX_FILE), &bytes)
            .map_err(|error| format!("cannot write the canvas index: {error}"))
    }

    fn index<'a>(&self, inner: &'a mut Inner, workspace_id: &str) -> Result<&'a mut WorkspaceIndex, String> {
        if !valid_segment(workspace_id) {
            return Err("invalid workspace id".into());
        }
        if !inner.workspaces.contains_key(workspace_id) {
            let index = self.read_index(workspace_id)?;
            inner.workspaces.insert(workspace_id.to_string(), index);
        }
        Ok(inner.workspaces.get_mut(workspace_id).unwrap())
    }

    fn scan(&self, inner: &mut Inner) {
        if inner.scanned {
            return;
        }
        inner.scanned = true;
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_segment(&name) || inner.workspaces.contains_key(&name) {
                continue;
            }
            if !entry.path().join(INDEX_FILE).is_file() {
                continue;
            }
            match self.read_index(&name) {
                Ok(index) => {
                    inner.workspaces.insert(name, index);
                }
                Err(error) => logln!("[canvas] {error}"),
            }
        }
    }

    fn summary_locked(&self, inner: &mut Inner) -> Vec<wire::WorkspaceCanvasSummary> {
        self.scan(inner);
        let mut workspaces: Vec<wire::WorkspaceCanvasSummary> = inner
            .workspaces
            .iter()
            .filter(|(_, index)| index.revision > 0)
            .map(|(workspace_id, index)| wire::WorkspaceCanvasSummary {
                workspace_id: workspace_id.clone(),
                revision: index.revision,
            })
            .collect();
        workspaces.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
        workspaces.truncate(MAX_SUMMARY_WORKSPACES);
        workspaces
    }

    /// Queued with the lock held so snapshots leave in the order they were taken; a dropped one
    /// (full queue) is healed by the next change or the re-send after authentication.
    fn publish_locked(&self, inner: &mut Inner) {
        let envelope = wire::DaemonToServer {
            payload: Some(daemon_to_server::Payload::CanvasSummary(wire::CanvasSummary {
                workspaces: self.summary_locked(inner),
            })),
        };
        let _ = self.to_server.try_send(envelope.encode_to_vec());
    }

    /// Unconditional re-send (after authentication: the center keeps the summary in memory only).
    pub fn publish(&self) {
        let mut inner = self.inner.lock().unwrap();
        self.publish_locked(&mut inner);
    }

    /// Registers `path` as a canvas of the workspace, or refreshes the entry it already has.
    /// `path` must be absolute; it is canonicalized here.
    pub fn show(&self, workspace_id: &str, path: &Path, title: Option<&str>) -> Result<StoredCanvas, String> {
        let canonical = fs::canonicalize(path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => format!("{} does not exist", path.display()),
            _ => format!("cannot open {}: {error}", path.display()),
        })?;
        if !canonical.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
        if !is_html(&canonical) {
            return Err(format!("{} is not an .html file", path.display()));
        }
        if canonical.parent().is_none() {
            return Err(format!("{} has no directory to serve", path.display()));
        }
        let Some(canonical_text) = canonical.to_str().map(str::to_string) else {
            return Err(format!("{} is not a UTF-8 path", path.display()));
        };
        let title = title.map(clip_title).filter(|title| !title.is_empty());

        let mut inner = self.inner.lock().unwrap();
        let mut index = self.index(&mut inner, workspace_id)?.clone();
        let now = now_ms();
        let canvas = match index.canvases.iter_mut().find(|canvas| canvas.path == canonical_text) {
            Some(existing) => {
                if let Some(title) = title {
                    existing.title = title;
                }
                // Strictly later than before, so a desktop comparing times always sees a re-show.
                existing.updated_at = now.max(existing.updated_at.saturating_add(1));
                existing.clone()
            }
            None => {
                let canvas = StoredCanvas {
                    id: fresh_id(),
                    title: title.unwrap_or_else(|| {
                        canonical
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    }),
                    path: canonical_text,
                    updated_at: now,
                };
                index.canvases.push(canvas.clone());
                if index.canvases.len() > MAX_CANVASES {
                    index.canvases.sort_by_key(|canvas| canvas.updated_at);
                    let excess = index.canvases.len() - MAX_CANVASES;
                    index.canvases.drain(..excess);
                }
                canvas
            }
        };
        index.version = INDEX_VERSION;
        index.revision = index.revision.wrapping_add(1).max(1);
        self.write_index(workspace_id, &index)?;
        inner.workspaces.insert(workspace_id.to_string(), index);
        self.publish_locked(&mut inner);
        Ok(canvas)
    }

    /// The workspace's canvases whose file still exists, most recently shown first.
    pub fn list(&self, workspace_id: &str) -> Result<(u32, Vec<StoredCanvas>), String> {
        let mut inner = self.inner.lock().unwrap();
        let index = self.index(&mut inner, workspace_id)?;
        let mut canvases: Vec<StoredCanvas> = index
            .canvases
            .iter()
            .filter(|canvas| Path::new(&canvas.path).is_file())
            .cloned()
            .collect();
        canvases.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok((index.revision, canvases))
    }

    /// The file of a canvas id, across every workspace.
    fn file_of(&self, canvas_id: &str) -> Option<PathBuf> {
        let mut inner = self.inner.lock().unwrap();
        self.scan(&mut inner);
        inner
            .workspaces
            .values()
            .flat_map(|index| index.canvases.iter())
            .find(|canvas| canvas.id == canvas_id)
            .map(|canvas| PathBuf::from(&canvas.path))
    }
}

// ===== The listener =====

/// What one request resolves to; computed on the blocking pool (it touches the filesystem).
#[derive(Debug, PartialEq)]
enum Resolved {
    File { path: PathBuf, content_type: &'static str },
    Redirect(String),
    NotFound,
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn encode_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn content_type_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Maps a request target (`/<id>/<path>?query`) to a file inside the canvas's directory.
fn resolve(store: &CanvasStore, target: &str) -> Resolved {
    let path = target.split(['?', '#']).next().unwrap_or_default();
    let Some(rest) = path.strip_prefix('/') else {
        return Resolved::NotFound;
    };
    let (canvas_id, relative) = match rest.split_once('/') {
        Some((id, relative)) => (id, Some(relative)),
        None => (rest, None),
    };
    if !valid_segment(canvas_id) {
        return Resolved::NotFound;
    }
    let Some(file) = store.file_of(canvas_id) else {
        return Resolved::NotFound;
    };
    let (Some(root), Some(file_name)) = (file.parent(), file.file_name().and_then(|name| name.to_str())) else {
        return Resolved::NotFound;
    };
    // `/<id>` and `/<id>/` go to the page itself, by redirect so its relative URLs resolve.
    let relative = match relative {
        Some(relative) if !relative.is_empty() => relative,
        _ => return Resolved::Redirect(format!("/{canvas_id}/{}", encode_path_segment(file_name))),
    };
    let Some(decoded) = percent_decode(relative) else {
        return Resolved::NotFound;
    };
    if decoded.contains('\0') {
        return Resolved::NotFound;
    }
    // Canonicalizing resolves `..` and symlinks; whatever it lands on must still be inside the
    // directory. `root` is canonical already (it is the parent of a canonical path).
    let Ok(resolved) = fs::canonicalize(root.join(decoded.trim_start_matches('/'))) else {
        return Resolved::NotFound;
    };
    if !resolved.starts_with(root) || !resolved.is_file() {
        return Resolved::NotFound;
    }
    let content_type = content_type_for(&resolved);
    Resolved::File { path: resolved, content_type }
}

/// A request from a browser names the loopback host; anything else is a rebound DNS name.
fn host_is_loopback(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        host.rsplit_once(':').map_or(host, |(name, port)| {
            if port.bytes().all(|byte| byte.is_ascii_digit()) {
                name
            } else {
                host
            }
        })
    };
    name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1" || name == "::1"
}

async fn respond(stream: &mut TcpStream, status: &str, extra_headers: &str, body: &[u8], head_only: bool) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{extra_headers}\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    if !head_only {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.shutdown().await;
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            return String::from_utf8(buffer[..end].to_vec()).ok();
        }
        if buffer.len() > MAX_REQUEST_HEAD_BYTES {
            return None;
        }
    }
}

async fn handle_connection(mut stream: TcpStream, store: Arc<CanvasStore>) {
    let Ok(Some(head)) = tokio::time::timeout(REQUEST_HEAD_TIMEOUT, read_head(&mut stream)).await else {
        return;
    };
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let (method, target) = (
        request_line.next().unwrap_or_default(),
        request_line.next().unwrap_or_default().to_string(),
    );
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        respond(&mut stream, "405 Method Not Allowed", "Allow: GET, HEAD\r\n", b"", false).await;
        return;
    }
    let host = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();
    if !host_is_loopback(&host) {
        respond(&mut stream, "403 Forbidden", "", b"", head_only).await;
        return;
    }
    let resolved = tokio::task::spawn_blocking(move || resolve(&store, &target))
        .await
        .unwrap_or(Resolved::NotFound);
    match resolved {
        Resolved::NotFound => {
            respond(
                &mut stream,
                "404 Not Found",
                "Content-Type: text/plain; charset=utf-8\r\n",
                b"Not found",
                head_only,
            )
            .await;
        }
        Resolved::Redirect(location) => {
            respond(&mut stream, "302 Found", &format!("Location: {location}\r\n"), b"", head_only).await;
        }
        Resolved::File { path, content_type } => {
            let Ok(mut file) = tokio::fs::File::open(&path).await else {
                respond(&mut stream, "404 Not Found", "", b"", head_only).await;
                return;
            };
            let Ok(metadata) = file.metadata().await else {
                respond(&mut stream, "404 Not Found", "", b"", head_only).await;
                return;
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n",
                metadata.len()
            );
            if stream.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            if !head_only {
                // The declared length is the size at open; never send more than that.
                let mut limited = (&mut file).take(metadata.len());
                let _ = tokio::io::copy(&mut limited, &mut stream).await;
            }
            let _ = stream.shutdown().await;
        }
    }
}

async fn accept_loop(listener: TcpListener, store: Arc<CanvasStore>) {
    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                tokio::spawn(handle_connection(stream, store.clone()));
            }
            Err(error) => {
                logln!("[canvas] accept error: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Binds the canvas listener on both loopback addresses and serves until the process ends.
/// `requested_port` 0 asks the OS for a port (tests, parallel runtimes). A port that cannot be
/// bound is logged and leaves the runtime running with no listener: `show` and the list then
/// report it, and nothing else is affected.
pub async fn serve(requested_port: u16, store: Arc<CanvasStore>) {
    let mut listeners = Vec::new();
    let mut port = requested_port;
    match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, requested_port)).await {
        Ok(listener) => {
            port = listener.local_addr().map_or(port, |address| address.port());
            listeners.push(listener);
        }
        Err(error) => logln!("[canvas] cannot listen on 127.0.0.1:{requested_port}: {error}"),
    }
    // Without IPv4 there is no stable port to share with IPv6; a browser resolving `localhost`
    // tries both families, so IPv4 alone is enough and IPv6 is best effort on the same port.
    if listeners.is_empty() {
        logln!("[canvas] the canvas listener is not running; canvases cannot be shown");
        return;
    }
    if let Ok(listener) = TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)).await {
        listeners.push(listener);
    }
    store.set_port(port);
    logln!("[canvas] serving canvases on loopback port {port}");
    let loops: Vec<_> = listeners
        .into_iter()
        .map(|listener| Box::pin(accept_loop(listener, store.clone())))
        .collect();
    let _ = futures_util::future::select_all(loops).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "11111111-2222-3333-4444-555555555555";

    /// A fresh directory under the system temp dir, removed (that exact path only) on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("coflux-canvas-{}", fresh_id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Fixture {
        _home: Scratch,
        site: Scratch,
        outside: Scratch,
        store: Arc<CanvasStore>,
        from_store: mpsc::Receiver<WsOut>,
    }

    fn fixture() -> Fixture {
        let home = Scratch::new();
        let site = Scratch::new();
        let outside = Scratch::new();
        fs::write(site.path().join("index.html"), "<h1>hi</h1>").unwrap();
        fs::write(site.path().join("style.css"), "body{}").unwrap();
        fs::create_dir(site.path().join("img")).unwrap();
        fs::write(site.path().join("img/a b.png"), [0x89, b'P', b'N', b'G']).unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        let (to_server, from_store) = mpsc::channel(16);
        let store = Arc::new(CanvasStore::new(home.path().to_str().unwrap(), to_server));
        Fixture { _home: home, site, outside, store, from_store }
    }

    #[test]
    fn show_registers_and_reshow_keeps_the_id() {
        let mut f = fixture();
        let page = f.site.path().join("index.html");
        let first = f.store.show(WS, &page, Some("Home")).unwrap();
        assert_eq!(first.title, "Home");
        assert_eq!(first.id.len(), 32);
        // A different spelling of the same file is the same canvas; no title keeps the old one.
        let again = f.store.show(WS, &f.site.path().join("img/../index.html"), None).unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.title, "Home");
        assert!(again.updated_at > first.updated_at);
        let (revision, list) = f.store.list(WS).unwrap();
        assert_eq!(revision, 2);
        assert_eq!(list.len(), 1);
        // Each change publishes the revision-only summary.
        let mut last = None;
        while let Ok(bytes) = f.from_store.try_recv() {
            last = Some(wire::DaemonToServer::decode(bytes.as_slice()).unwrap());
        }
        match last.unwrap().payload.unwrap() {
            daemon_to_server::Payload::CanvasSummary(summary) => {
                assert_eq!(summary.workspaces.len(), 1);
                assert_eq!(summary.workspaces[0].workspace_id, WS);
                assert_eq!(summary.workspaces[0].revision, 2);
            }
            other => panic!("unexpected payload {other:?}"),
        }
    }

    #[test]
    fn show_refuses_what_is_not_an_html_file() {
        let f = fixture();
        assert!(f.store.show(WS, &f.site.path().join("missing.html"), None).unwrap_err().contains("does not exist"));
        assert!(f.store.show(WS, &f.site.path().join("style.css"), None).unwrap_err().contains("not an .html"));
        assert!(f.store.show(WS, f.site.path(), None).unwrap_err().contains("not a file"));
        assert!(f.store.show("../x", &f.site.path().join("index.html"), None).is_err());
        assert_eq!(f.store.list(WS).unwrap().1.len(), 0);
    }

    #[test]
    fn default_title_is_the_file_name_and_a_deleted_file_leaves_the_list() {
        let f = fixture();
        let page = f.site.path().join("index.html");
        let canvas = f.store.show(WS, &page, None).unwrap();
        assert_eq!(canvas.title, "index.html");
        fs::remove_file(&page).unwrap();
        assert!(f.store.list(WS).unwrap().1.is_empty());
    }

    #[test]
    fn the_registry_survives_a_restart() {
        let home = Scratch::new();
        let site = Scratch::new();
        fs::write(site.path().join("a.html"), "a").unwrap();
        let (to_server, _keep) = mpsc::channel(16);
        let store = CanvasStore::new(home.path().to_str().unwrap(), to_server.clone());
        let shown = store.show(WS, &site.path().join("a.html"), Some("A")).unwrap();
        let reopened = CanvasStore::new(home.path().to_str().unwrap(), to_server);
        assert_eq!(reopened.list(WS).unwrap().1, vec![shown.clone()]);
        assert!(reopened.file_of(&shown.id).is_some());
    }

    #[test]
    fn resolve_serves_only_inside_the_canvas_directory() {
        let f = fixture();
        let canvas = f.store.show(WS, &f.site.path().join("index.html"), None).unwrap();
        let id = &canvas.id;
        let root = fs::canonicalize(f.site.path()).unwrap();

        assert_eq!(
            resolve(&f.store, &format!("/{id}/index.html?x=1")),
            Resolved::File { path: root.join("index.html"), content_type: "text/html; charset=utf-8" }
        );
        assert_eq!(
            resolve(&f.store, &format!("/{id}/style.css")),
            Resolved::File { path: root.join("style.css"), content_type: "text/css; charset=utf-8" }
        );
        assert_eq!(
            resolve(&f.store, &format!("/{id}/img/a%20b.png")),
            Resolved::File { path: root.join("img/a b.png"), content_type: "image/png" }
        );
        assert_eq!(resolve(&f.store, &format!("/{id}")), Resolved::Redirect(format!("/{id}/index.html")));
        assert_eq!(resolve(&f.store, &format!("/{id}/")), Resolved::Redirect(format!("/{id}/index.html")));

        // Traversal, plain and encoded, and an absolute-looking path.
        let outside_name = f.outside.path().file_name().unwrap().to_str().unwrap();
        for target in [
            format!("/{id}/../{outside_name}/secret.txt"),
            format!("/{id}/%2e%2e/{outside_name}/secret.txt"),
            format!("/{id}/img/../../{outside_name}/secret.txt"),
            format!("/{id}/{}", f.outside.path().join("secret.txt").display()),
        ] {
            assert_eq!(resolve(&f.store, &target), Resolved::NotFound, "{target}");
        }
        // A symlink that leaves the directory.
        std::os::unix::fs::symlink(f.outside.path().join("secret.txt"), f.site.path().join("link.txt")).unwrap();
        assert_eq!(resolve(&f.store, &format!("/{id}/link.txt")), Resolved::NotFound);
        // A directory, a missing file, an unknown id, a malformed id and bad escapes.
        assert_eq!(resolve(&f.store, &format!("/{id}/img")), Resolved::NotFound);
        assert_eq!(resolve(&f.store, &format!("/{id}/nope.css")), Resolved::NotFound);
        assert_eq!(resolve(&f.store, "/00000000000000000000000000000000/index.html"), Resolved::NotFound);
        assert_eq!(resolve(&f.store, "/../index.html"), Resolved::NotFound);
        assert_eq!(resolve(&f.store, &format!("/{id}/%zz")), Resolved::NotFound);
        assert_eq!(resolve(&f.store, &format!("/{id}/a%00b")), Resolved::NotFound);
        assert_eq!(resolve(&f.store, "/"), Resolved::NotFound);
    }

    #[test]
    fn host_check_accepts_only_loopback_names() {
        for host in ["localhost", "localhost:8795", "LOCALHOST:1", "127.0.0.1:8795", "127.0.0.1", "[::1]:8795", "[::1]"] {
            assert!(host_is_loopback(host), "{host}");
        }
        for host in ["", "evil.example", "evil.example:8795", "localhost.evil.example", "127.0.0.2", "[::2]:1"] {
            assert!(!host_is_loopback(host), "{host}");
        }
    }

    async fn request(port: u32, raw: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port as u16)).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    #[tokio::test]
    async fn the_listener_serves_get_and_head_and_refuses_the_rest() {
        let f = fixture();
        let canvas = f.store.show(WS, &f.site.path().join("index.html"), None).unwrap();
        assert_eq!(f.store.url(&canvas), None);
        tokio::spawn(serve(0, f.store.clone()));
        for _ in 0..200 {
            if f.store.port() != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let port = f.store.port();
        assert_ne!(port, 0);
        assert_eq!(
            f.store.url(&canvas).unwrap(),
            format!("http://localhost:{port}/{}/index.html", canvas.id)
        );
        let id = &canvas.id;

        let ok = request(port, &format!("GET /{id}/index.html HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n")).await;
        assert!(ok.starts_with("HTTP/1.1 200 OK\r\n"), "{ok}");
        assert!(ok.contains("Content-Type: text/html; charset=utf-8\r\n"));
        assert!(ok.contains("Cache-Control: no-store\r\n"));
        assert!(ok.ends_with("\r\n\r\n<h1>hi</h1>"));

        let head = request(port, &format!("HEAD /{id}/style.css HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")).await;
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
        assert!(head.contains("Content-Length: 6\r\n"));
        assert!(head.ends_with("\r\n\r\n"));

        let post = request(port, &format!("POST /{id}/index.html HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")).await;
        assert!(post.starts_with("HTTP/1.1 405 "), "{post}");
        let put = request(port, &format!("PUT /{id}/new.html HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")).await;
        assert!(put.starts_with("HTTP/1.1 405 "), "{put}");

        let rebound = request(port, &format!("GET /{id}/index.html HTTP/1.1\r\nHost: evil.example\r\n\r\n")).await;
        assert!(rebound.starts_with("HTTP/1.1 403 "), "{rebound}");
        assert!(!rebound.contains("<h1>"));

        let traversal = request(port, &format!("GET /{id}/../../etc/hosts HTTP/1.1\r\nHost: localhost\r\n\r\n")).await;
        assert!(traversal.starts_with("HTTP/1.1 404 "), "{traversal}");

        let unknown = request(port, "GET /ffffffffffffffffffffffffffffffff/index.html HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
        assert!(unknown.starts_with("HTTP/1.1 404 "), "{unknown}");

        let redirect = request(port, &format!("GET /{id}/ HTTP/1.1\r\nHost: localhost\r\n\r\n")).await;
        assert!(redirect.starts_with("HTTP/1.1 302 "), "{redirect}");
        assert!(redirect.contains(&format!("Location: /{id}/index.html\r\n")));
    }

    #[tokio::test]
    async fn a_taken_port_leaves_the_store_without_a_listener() {
        let f = fixture();
        let taken = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        // Returns instead of serving, and never panics.
        tokio::time::timeout(Duration::from_secs(5), serve(port, f.store.clone())).await.unwrap();
        assert_eq!(f.store.port(), 0);
    }
}
