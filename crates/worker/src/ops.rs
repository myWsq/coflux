//! 通用原语：exec（一次性命令）+ fs（root 锚定列目录/读文件，realpath 防穿越）。与 TS exec.ts/fs.ts 一致。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use coflux_protocol::FsEntry;
use tokio::process::Command;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

pub struct ExecOutcome {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

pub async fn run_command(cwd: &str, command: &str, args: &[String], env: Option<&HashMap<String, String>>, timeout_ms: Option<u64>) -> ExecOutcome {
    let mut cmd = Command::new(command);
    cmd.args(args);
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    let timeout = Duration::from_millis(timeout_ms.filter(|&t| t > 0).unwrap_or(DEFAULT_TIMEOUT_MS));
    match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => ExecOutcome { ok: false, exit_code: -1, stdout: String::new(), stderr: String::new(), error: Some("进程被终止（可能超时）".into()) },
        Ok(Err(e)) => ExecOutcome { ok: false, exit_code: -1, stdout: String::new(), stderr: String::new(), error: Some(e.to_string()) },
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            match out.status.code() {
                Some(code) => ExecOutcome { ok: true, exit_code: code, stdout, stderr, error: None },
                None => ExecOutcome { ok: false, exit_code: -1, stdout, stderr, error: Some("进程被信号终止".into()) },
            }
        }
    }
}

/// 把 root + 相对路径解析为绝对真实路径，并保证不越出 root（canonicalize 解引用符号链接 + ".."）。
/// 越界/不存在返回 None。
fn safe_resolve(root: &str, rel: &str) -> Option<PathBuf> {
    let real_base = std::fs::canonicalize(root).ok()?;
    let joined = if rel.is_empty() { real_base.clone() } else { real_base.join(rel) };
    let real_target = std::fs::canonicalize(&joined).ok()?;
    if real_target == real_base || real_target.starts_with(&real_base) {
        Some(real_target)
    } else {
        None
    }
}

pub async fn list_dir(root: &str, rel: &str) -> (bool, Vec<FsEntry>, Option<String>) {
    let target = match safe_resolve(root, rel) {
        Some(t) => t,
        None => return (false, vec![], Some("路径越界或不存在".into())),
    };
    match std::fs::read_dir(&target) {
        Err(e) => (false, vec![], Some(e.to_string())),
        Ok(rd) => {
            let mut entries: Vec<FsEntry> = Vec::new();
            for d in rd.flatten() {
                let (kind, size) = match d.path().symlink_metadata() {
                    Ok(m) => {
                        let ft = m.file_type();
                        let k = if ft.is_dir() { "dir" } else if ft.is_file() { "file" } else if ft.is_symlink() { "symlink" } else { "other" };
                        (k, m.len())
                    }
                    Err(_) => ("other", 0),
                };
                entries.push(FsEntry { name: d.file_name().to_string_lossy().into_owned(), kind: kind.to_string(), size });
            }
            // 目录在前，其余按名排序（确定性全序）
            entries.sort_by(|a, b| {
                let ad = a.kind == "dir";
                let bd = b.kind == "dir";
                bd.cmp(&ad).then_with(|| a.name.cmp(&b.name))
            });
            (true, entries, None)
        }
    }
}

pub async fn read_file_text(root: &str, rel: &str) -> (bool, String, Option<String>) {
    let target = match safe_resolve(root, rel) {
        Some(t) => t,
        None => return (false, String::new(), Some("路径越界或不存在".into())),
    };
    match std::fs::metadata(&target) {
        Err(e) => (false, String::new(), Some(e.to_string())),
        Ok(m) => {
            if !m.is_file() {
                return (false, String::new(), Some("不是文件".into()));
            }
            if m.len() > MAX_READ_BYTES {
                return (false, String::new(), Some("文件过大（>2MB）".into()));
            }
            match std::fs::read(&target) {
                Ok(b) => (true, String::from_utf8_lossy(&b).into_owned(), None),
                Err(e) => (false, String::new(), Some(e.to_string())),
            }
        }
    }
}
