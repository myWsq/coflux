//! 桌面应用的本机生命周期通道。只在应用显式启动时启用，不依赖中心或 worker。
//! home 的独占锁防止更新接续时启动第二个托管进程；0600 的 UDS 只接受同一系统用户。
use std::fs::{File, OpenOptions, Permissions};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::time::Duration;

use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::json;

use crate::{manager::Manager, sessions::Sessions};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    #[serde(default, rename = "instanceId")]
    instance_id: String,
}

pub struct RuntimeControl {
    _lock: File,
    listener: UnixListener,
    path: String,
    instance_id: String,
    runtime_id: String,
}

impl RuntimeControl {
    pub fn bind(home: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(home)?;
        std::fs::set_permissions(home, Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(format!("{home}/runtime.lock"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // 只有拿到独占锁后才能清理崩溃留下的 socket。
        let path = format!("{home}/runtime.sock");
        match std::fs::remove_file(&path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, Permissions::from_mode(0o600))?;
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        Ok(Self {
            _lock: lock,
            listener,
            path,
            instance_id: hex::encode(nonce),
            runtime_id: std::env::var("COFLUX_RUNTIME_ID").unwrap_or_default(),
        })
    }

    pub fn serve(self, manager: Arc<Manager>, sessions: Arc<Sessions>, worker_socket: String) {
        std::thread::spawn(move || {
            for stream in self.listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let Ok(input) = stream.try_clone() else {
                    continue;
                };
                let mut reader = BufReader::new(input);
                let mut line = Vec::new();
                // 请求极小，逐段有界读取，不能因同用户的坏请求无限分配内存。
                let mut valid = false;
                while line.len() <= 4096 {
                    let Ok(buf) = reader.fill_buf() else { break };
                    if buf.is_empty() {
                        break;
                    }
                    let n = buf
                        .iter()
                        .position(|b| *b == b'\n')
                        .map_or(buf.len(), |i| i + 1);
                    if line.len() + n > 4096 {
                        break;
                    }
                    let ended = buf[n - 1] == b'\n';
                    line.extend_from_slice(&buf[..n]);
                    reader.consume(n);
                    if ended {
                        valid = true;
                        break;
                    }
                }
                let request = valid
                    .then(|| serde_json::from_slice::<Request>(&line).ok())
                    .flatten();
                let Some(request) = request else {
                    let _ = writeln!(stream, "{{\"ok\":false,\"error\":\"invalid request\"}}");
                    continue;
                };
                let stopping = request.op == "stop" && request.instance_id == self.instance_id;
                let response = if request.op == "status" {
                    json!({"ok":true,"protocol":1,"instanceId":self.instance_id,
                        "runtimeId":self.runtime_id,"version":crate::SUPERVISOR_VERSION,
                        "sessions":sessions.desktop_sessions()})
                } else if stopping {
                    manager.shutdown();
                    sessions.shutdown();
                    json!({"ok":true})
                } else {
                    json!({"ok":false,"error":"unsupported operation or stale instance"})
                };
                let _ = writeln!(stream, "{response}");
                if stopping {
                    let _ = std::fs::remove_file(&self.path);
                    let _ = std::fs::remove_file(&worker_socket);
                    std::process::exit(0);
                }
            }
        });
    }
}
