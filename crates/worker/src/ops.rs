//! 通用原语：exec（一次性命令）+ fs（root 锚定列目录/读文件/写文件，realpath 防穿越）。与 TS exec.ts/fs.ts 一致。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use coflux_protocol::{FsEntry, FsEntryKind};
use tokio::process::Command;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
// 拖拽文件上传上限须与 web MAX_UPLOAD_BYTES、server maxPayload 同为 30MB；此处是落盘前的最终兜底。
const MAX_WRITE_BYTES: u64 = 30 * 1024 * 1024;
// 落盘目录自我清理的存活期：超过此 mtime 的文件视为陈旧贴图，写入时顺手清掉（不起独立定时任务）。
const WRITE_DIR_CLEANUP_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub struct ExecOutcome {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

/// env：wire 上 `ExecRun.env` 是 proto3 map（恒非 null，缺省即空 map），故此处直接收
/// `&HashMap`，不再需要 `Option` 包一层——空 map 天然等价于旧协议里的「未提供」。
pub async fn run_command(cwd: &str, command: &str, args: &[String], env: &HashMap<String, String>, timeout_ms: Option<u64>) -> ExecOutcome {
    let mut cmd = Command::new(command);
    cmd.args(args);
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    for (k, v) in env {
        cmd.env(k, v);
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

/// "~" / "~/rel" 展开为当前用户 home 下的路径；其它输入原样返回。
pub fn expand_home(path: &str) -> Option<String> {
    if path == "~" {
        std::env::var("HOME").ok()
    } else if let Some(rest) = path.strip_prefix("~/") {
        std::env::var("HOME").ok().map(|home| format!("{home}/{rest}"))
    } else {
        Some(path.to_string())
    }
}

/// 把 root + 路径解析为绝对真实路径，并保证不越出 root（canonicalize 解引用符号链接 + ".."）。
/// root / path 均可含 "~"；path 为绝对路径时以该路径为准（仍须落在 root 下）。
/// 越界/不存在返回 None。
///
/// 注意：此函数 canonicalize 目标本身，故目标必须已存在——写新文件不能直接复用它
/// （见 safe_resolve_write_target，它只 canonicalize 父目录）。
fn safe_resolve(root: &str, rel: &str) -> Option<PathBuf> {
    let root = expand_home(root)?;
    let rel = expand_home(rel)?;
    let real_base = std::fs::canonicalize(&root).ok()?;
    let joined = if rel.is_empty() { real_base.clone() } else { real_base.join(rel) };
    let real_target = std::fs::canonicalize(&joined).ok()?;
    if real_target == real_base || real_target.starts_with(&real_base) {
        Some(real_target)
    } else {
        None
    }
}

/// 为写文件解析目标：root 必须已存在；rel 的每个路径段都不能是空/"."/".."（拒绝越界与穿越），
/// 父目录按需创建后 canonicalize 校验仍落在 root 内（防符号链接逃逸，与 safe_resolve 同一语义）。
/// 返回 (安全的真实父目录, 文件名, 清洗后的相对路径="dir/dir/file"形式)。
fn safe_resolve_write_target(root: &str, rel: &str) -> Option<(PathBuf, String, String)> {
    let root = expand_home(root)?;
    let real_root = std::fs::canonicalize(&root).ok()?;
    let rel = expand_home(rel)?;
    let mut segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let file_name = segments.pop()?.to_string();
    if file_name == "." || file_name == ".." {
        return None;
    }
    // 逐段拼接 + 逐段 canonicalize 校验（而非拼完整路径再一次性 create_dir_all + 校验）：
    // 若中间某段是指向 root 外的既有符号链接，在"跳进去创建下一段"之前就会被发现并拒绝，
    // 不会先在界外建出目录才追悔。
    let mut dir = real_root.clone();
    for seg in &segments {
        if *seg == "." || *seg == ".." {
            return None;
        }
        dir = dir.join(seg);
        if !dir.exists() {
            std::fs::create_dir(&dir).ok()?;
        }
        dir = std::fs::canonicalize(&dir).ok()?;
        if dir != real_root && !dir.starts_with(&real_root) {
            return None;
        }
    }
    let mut clean_rel = segments.join("/");
    if !clean_rel.is_empty() {
        clean_rel.push('/');
    }
    clean_rel.push_str(&file_name);
    Some((dir, file_name, clean_rel))
}

/// 清理目录内 mtime 超过 7 天的陈旧文件（刚落盘的文件与 just_skip 除外）。
/// 低频操作，纯尽力而为——任何一步失败都不影响本次写入结果。
fn cleanup_stale_files(dir: &Path, just_written: &str, just_skip: &str) {
    let Some(cutoff) = SystemTime::now().checked_sub(WRITE_DIR_CLEANUP_AGE) else { return };
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy() == just_written || (!just_skip.is_empty() && name == just_skip) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if matches!(meta.modified(), Ok(modified) if modified < cutoff) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// root 锚定目录自我托管：确保带一个内容为 "*" 的 .gitignore（自我忽略，worktree 场景无
/// commondir 问题，不碰 `.git`），再顺手清理陈旧文件。temp 目录（无 git）不需要 .gitignore，
/// 见 `write_file` 里 temp 分支直接调用 `cleanup_stale_files`。
fn housekeep_write_dir(dir: &Path, just_written: &str) {
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        let _ = std::fs::write(&gitignore, "*\n");
    }
    cleanup_stale_files(dir, just_written, ".gitignore");
}

/// temp 模式的落盘目标解析：忽略 root 锚定语义，落到 daemon 侧系统临时目录
/// `std::env::temp_dir()/coflux-pastes/`（按需创建）；rel 必须是单段文件名——
/// 拒绝包含 '/' 、为空、为 "." 或 ".." 的输入（防目录穿越、防写到临时目录之外）。
fn safe_resolve_temp_target(rel: &str) -> Option<(PathBuf, String)> {
    if rel.is_empty() || rel == "." || rel == ".." || rel.contains('/') {
        return None;
    }
    let base = std::env::temp_dir().join("coflux-pastes");
    std::fs::create_dir_all(&base).ok()?;
    let real_base = std::fs::canonicalize(&base).ok()?;
    Some((real_base, rel.to_string()))
}

/// 写文件（plan 014 终端贴图上传落盘）。temp=false：root 锚定 + 防越界 + 父目录按需创建，
/// 成功回带清洗后的 worktree 相对路径。temp=true：落 daemon 侧系统临时目录，rel 须为单段
/// 文件名，成功回带绝对路径（真相均在 worker 侧，client 不自行拼装）。
pub async fn write_file(root: &str, rel: &str, data: &[u8], temp: bool) -> (bool, Option<String>, Option<String>) {
    if data.len() as u64 > MAX_WRITE_BYTES {
        return (false, None, Some("文件过大".into()));
    }
    if temp {
        let Some((dir, file_name)) = safe_resolve_temp_target(rel) else {
            return (false, None, Some("路径越界或非法".into()));
        };
        let full = dir.join(&file_name);
        if let Err(e) = std::fs::write(&full, data) {
            return (false, None, Some(e.to_string()));
        }
        cleanup_stale_files(&dir, &file_name, "");
        return (true, Some(full.to_string_lossy().into_owned()), None);
    }
    let Some((dir, file_name, clean_rel)) = safe_resolve_write_target(root, rel) else {
        return (false, None, Some("路径越界或非法".into()));
    };
    if let Err(e) = std::fs::write(dir.join(&file_name), data) {
        return (false, None, Some(e.to_string()));
    }
    housekeep_write_dir(&dir, &file_name);
    (true, Some(clean_rel), None)
}

pub async fn list_dir(root: &str, rel: &str) -> (bool, Vec<FsEntry>, Option<String>, Option<String>) {
    let target = match safe_resolve(root, rel) {
        Some(t) => t,
        None => return (false, vec![], Some("路径越界或不存在".into()), None),
    };
    let path = Some(target.to_string_lossy().into_owned());
    match std::fs::read_dir(&target) {
        Err(e) => (false, vec![], Some(e.to_string()), None),
        Ok(rd) => {
            // (name, kind, size)：kind 先留作内部枚举，排序完再转 protobuf FsEntry（i32 + double）
            let mut raw: Vec<(String, FsEntryKind, u64)> = Vec::new();
            for d in rd.flatten() {
                let (kind, size) = match d.path().symlink_metadata() {
                    Ok(m) => {
                        let ft = m.file_type();
                        let k = if ft.is_dir() {
                            FsEntryKind::Dir
                        } else if ft.is_file() {
                            FsEntryKind::File
                        } else if ft.is_symlink() {
                            FsEntryKind::Symlink
                        } else {
                            FsEntryKind::Other
                        };
                        (k, m.len())
                    }
                    Err(_) => (FsEntryKind::Other, 0),
                };
                raw.push((d.file_name().to_string_lossy().into_owned(), kind, size));
            }
            // 目录在前，其余按名排序（确定性全序）
            raw.sort_by(|a, b| {
                let ad = a.1 == FsEntryKind::Dir;
                let bd = b.1 == FsEntryKind::Dir;
                bd.cmp(&ad).then_with(|| a.0.cmp(&b.0))
            });
            let entries = raw.into_iter().map(|(name, kind, size)| FsEntry { name, kind: kind as i32, size: size as f64 }).collect();
            (true, entries, None, path)
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

/* ------------------- agent 协同控制：命令包装脚本（plan 074） ------------------- */

/// 把 shell 命令行包成一个可执行脚本，返回其绝对路径。
///
/// 为什么要包这一层：supervisor 侧起 PTY 用的是 `CommandBuilder::new(&shell)`，**只接受
/// 单个可执行程序名、不接受 args**（见 `crates/supervisor/src/sessions.rs`），所以 agent
/// 想让新终端跑一条命令，唯一不改 supervisor 的办法就是让 `shell` 字段指向这样一个脚本。
/// supervisor 不走热升级，改它意味着全网 daemon 都要用户手动 `cofluxd update`，所以这层
/// 包装是刻意付出的代价（见 plans/074 Decisions）。
///
/// 脚本用 **login shell** 执行命令：daemon 由 launchd/systemd 拉起，PATH 通常只有系统默认，
/// 不走 login shell 会找不到 pnpm/node 这类装在用户 PATH 里的东西。
///
/// 命令执行完脚本即退出 → session 退出 → 中心 task 转 EXITED 并带上退出码，这正是 agent
/// 判断「跑完没有、成没成」的依据。刻意**不**在末尾留交互 shell：那会让 task 永远 RUNNING，
/// 侧栏堆满假的「运行中」，而用户想接管在命令运行期间本来就可以。
pub fn write_command_script(command: &str) -> Result<String, String> {
    let base = std::env::temp_dir().join("coflux-agent-cmd");
    std::fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    let dir = std::fs::canonicalize(&base).map_err(|error| error.to_string())?;
    let name = format!(
        "cmd-{}-{}.sh",
        std::process::id(),
        SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    );
    let full = dir.join(&name);
    let login_shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".to_string());
    let script = format!("#!/bin/sh\nexec {} -lc {}\n", sh_quote(&login_shell), sh_quote(command));
    std::fs::write(&full, script).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&full, std::fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
    }
    cleanup_stale_files(&dir, &name, "");
    Ok(full.to_string_lossy().into_owned())
}

/// POSIX shell 单引号转义：整体套单引号，内部的 `'` 换成 `'\''`（收单引号→转义单引号→再开）。
/// 这是唯一一条规则，任意字节序列都安全——命令来自 agent，不能假设它不含引号。
fn sh_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', r"'\''"))
}

#[cfg(test)]
mod agent_script_tests {
    use super::*;

    #[test]
    fn sh_quote_survives_embedded_quotes() {
        assert_eq!(sh_quote("pnpm test"), "'pnpm test'");
        assert_eq!(sh_quote("echo 'hi'"), r"'echo '\''hi'\'''");
        // 转义后交给真 sh 执行，取回的必须是原字符串
        for raw in ["a'b", "it's; rm -rf /", "$(whoami)", "`id`", "多字节 中文 '引号'"] {
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("printf %s {}", sh_quote(raw)))
                .output()
                .expect("run sh");
            assert_eq!(String::from_utf8_lossy(&out.stdout), raw, "quote 失真: {raw}");
        }
    }

    #[test]
    fn script_runs_command_and_propagates_exit_code() {
        let path = write_command_script("exit 7").expect("write script");
        let status = std::process::Command::new(&path).status().expect("run script");
        assert_eq!(status.code(), Some(7), "退出码必须透传——agent 靠它判断成败");
        let _ = std::fs::remove_file(&path);
    }
}
